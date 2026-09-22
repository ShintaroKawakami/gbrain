---
description: 承認済みプラン条項を実装で拾う
paths:
  - "scripts/**/*.py"
  - "src/**"
  - "apps/**"
  - "skills/**"
  - ".claude/rules/general/plan-commitment-tracking.md"
---

<!-- CaD 履歴（2026-06-26 新規作成の経緯／2026-07-16 常駐ダイエットPR2／2026-08-03 worker検証コマンド未実行対策、
それぞれの背景・守るべき業務ルール・他案不採用理由）は verbatim で
~/business/AGENT-HUB/skills/plan-approval/references/commitment-examples.md 「plan-commitment-tracking.md からの移設」節参照。 -->

# プラン・コミットメント追跡ルール（承認済みプランの条項を必ず実行で拾う）

## 原則

承認済みプラン本文に書かれた**全ての commitment / 条項**を、実装着手前に **1 項目 = 1 タスク**へ起票する。
プランの箱（HTML / テキスト）を静的ドキュメントで終わらせない。承認は一度きりの儀式ではなく、
実行ループ全体で参照し続ける**生きたチェックリスト（plan-as-live-checklist）**として扱う。

## なぜ

プランに「〜不具合時は正本を直す」等の条項があっても、主要タスクだけ起票すると、長い実行ループ（`/compact` でプラン本文が能動コンテキストから外れる）で**一度も発火せず**未実施のまま「完了」と誤宣言する。これは**全 PJ で再発し得る構造欠陥**。実例は `~/business/AGENT-HUB/skills/plan-approval/references/commitment-examples.md`。

## 必須手順

0. **「台帳化／全部タスク化」指示は plan-commitment 系だけ（2026-08-24）**: 利用者が「台帳化」「全部タスク化」「台帳をタスクに」等と言ったら、**TodoWrite / TaskCreate / CreateGoal だけを台帳代わりにしない**。必ず (1) `skills/plan-approval/plan-commitment-registry.yaml`（`common`＋`per_project`）→ (2) `python3 skills/plan-approval/scripts/render-commitment-ledger.py --project <pj>` で**要約せず全件**展開 → (3) HTML 台帳へ載せ **1行=1タスク** → (4) **進捗正本は HTML の ☐/☑**。全行が ☑ または明示保留／「該当なし（理由）」になるまで完了宣言禁止。**代替禁止（別用途）**: `loop-registry` / `mandate-registry` / `parallel-run-state` / Cursor Goal。手順詳細は `skills/plan-approval/SKILL.md` の発火トリガー表。
1. **承認直後に台帳化**: プラン本文の commitment / 条項（「〜不具合時」「〜したら」「最後に〜」「後で」「別プラン」「TODO」「フォローアップ」「要〜判断」の類）を全て抽出し、着手前に **TaskCreate で 1 項目 = 1 タスク**化する。**📋 コミットメント台帳セクションが空でないのに、未タスク化のまま実装へ進まない**。
   - **AI worker を 1 度でも使う計画なら、「AI worker 摩擦時は該当正本を worktree→PR→merge→fetch-only / detached 確認→cleanup で修正」の条項を台帳に必ず入れる**（テンプレ既定行・消さない）。無ければ台帳は未完成。
2. **節目ごとに突き合わせ**: 各 PR / フェーズ完了時に standing 条項を読み返し、観測した live な失敗・回避策を突き合わせる。
3. **workaround 自問**: 回避策を打った瞬間に「これは共通基盤・委譲ツール・SSOT の不具合か?」を自問し、Yes なら **end-of-run の正本修正タスクをその場で起票**する。
   - **AI worker 摩擦は「観測＝即発火」**: トークン超過・誤検知・空diff・停滞・誤完了申告等を **1 回でも観測したら** `env 起因`で片付けず、**その時点で end-of-run 修正タスクを起票する**。「回避できたから OK」では閉じない。実例は `commitment-examples.md`。
   - **worker の報告に貼られた検証コマンドの実行結果は、それ自体を証拠として採用しない**（実行していないコマンドの出力をそのまま貼ることがある。一部項目を正直に「未実行」と書いていても、他項目の実行結果が真である保証にはならない）。受け入れ条件に検証コマンドを含めた場合は、統括役が同じコマンドを自分の環境で実走して照合するまで完了扱いにしない。既存資産の「移植・コピー」型タスクは、上流と `diff` を取って一致を機械確認する。詳細・実例は `skills/agent-dispatch/SKILL.md`「失敗の能動検知」および `skills/agent-dispatch/references/model-selection-evidence.md`（2026-08-03）参照。
4. **条件トリガーはカウンタ監視**: 「X回起きたら直す」型は発生回数を監視し閾値到達で自動タスク化する。ただし **AI worker 摩擦はカウンタ閾値を待たない（1 回で発火）**。
5. **台帳全消化まで完了宣言しない**: 全項目が「実施済み」または「明示的に保留（ユーザー判断・別プラン）」になるまで「完了」と宣言しない。
6. **人間ゲート / オーナー操作の行は「明示保留」で解決＝全消化に数える（虚偽の✓化はしない）**: 本番投入・オーナー実機検証・承認待ちなど**AI が構造的に実行できない行**は `owner` と台帳に明記し「明示保留」として全消化に数える。**未実施を completed(✓) と偽らない／無承認で本番反映しない**。「全部✓」型 Goal と衝突しても明示保留を優先。利用者の明示 GO が揃って初めて実行可能。
   - **`/goal` 等の反復発火チェッカーへの対応**: 人間ゲート行に反復発火する場合、AI は §6 の優先（明示保留=全消化・虚偽✓禁止）を **1 度だけ根拠付きで提示して停止**し、以後は最小限の再表明に留める（無限反復・迎合的な虚偽✓化をしない）。実測は `commitment-examples.md`。

## 恒久原則（proactive）

繰り返す同種の摩擦・失敗は、**利用者の指摘を待たず**観測した時点で「最後に正本を直す」を既定の最終ステップとして計画へ自分から組み込む。委譲ジョブの失敗・失速もコミット監視だけに頼らず能動的にポーリングして検知する（`skills/agent-dispatch` の「失敗の能動検知」と対）。

## 接続

義務: `plan-approval-gate.md`。手順: `skills/plan-approval/SKILL.md`。実例: `~/business/AGENT-HUB/skills/plan-approval/references/commitment-examples.md`。進捗可視化: `visual-progress-map.md`。能動検知: `skills/agent-dispatch/SKILL.md`。

---

**追記ルール: 実測事例・復旧手順・長文詳細は移設先（references / docs）へ書き、本ルールには義務とトリガーだけ足す（再肥大化防止）。**
