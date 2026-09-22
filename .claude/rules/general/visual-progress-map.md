<!-- agents-md-card:start -->
### CARD: visual-progress-map — 現在地を図で
- **いつ**: 3つ以上の要素説明・進捗・Issue/PR方針・原因→対処など §1-bis 該当時
- **何を**: L1 ASCII既定。**説明HTMLは薄いストーリー＋左ナビ。細部詰め込み禁止。MermaidはPC横/スマホ縦。共有は0.0.0.0+Tailscale URL。Stitch不要**（本番UIだけStitch）。手順: `skills/visual-companion/references/explain-html-codex.md`
- **できた状態**: 今どこ・次どこが図で分かる（情報過多で迷わせない）
- **詳細**: `.claude/rules/general/visual-progress-map.md`
<!-- agents-md-card:end -->

<!-- CaD 全文移設（2026-08-08 ctx-slim）: ~/business/AGENT-HUB/skills/visual-companion/references/progress-map-templates.md 「visual-progress-map.md からの移設」節参照 -->

# 図解・現在地マップ・非エンジニア用語ルール

全 AI・全作業共通の SSOT。ユーザー（非エンジニア）が現在地・ゴール・次の一手を必ず把握できる状態を保つための図解描画ルール。**通常の実装・Issue/PR/PRD 確認・調査でも、§1-bis のトリガーに該当したら skill 抜きで図解を出す**。

**テンプレ・実例・置換表の全文は references へ。本ルールは義務とトリガーだけ（再肥大化防止）。**

## 0. モード判定（開発 / 業務）

この図解は **2 モード**を持つ。テンプレは共通で、語彙は references の置換表で読み替える（DRY）。

| モード | 対象 PJ（デフォルト） | 性質 | ペア guardrails |
|--------|---------------------|------|----------------|
| **開発** | jtt-apps / jtt-cms / jtt-shift-mobile-app / *-mcp 等 | GitHub PR フロー中心 | dev-guardrails |
| **業務** | jtt-cafe-pj / non-pj | 戦略・施策・KPI 中心 | business-guardrails |

- `jtt-cafe-pj` は business PJ。曖昧なら §5 に従い平易語で確認してから描く（推測しない）。
- 最小読み替え: PR/Issue/merge/本番投入 → 戦略スコープ/KPI/意思決定/本番運用。詳細は references。

## 1. 地図描画タイミング

| タイミング | 出すもの |
|-----------|---------|
| セッション開始直後 | `.claude/parallel-run-state/*.json` があれば冒頭で全体地図を ASCII 表示（複数あれば選択を仰ぐ） |
| /brainstorm 各フェーズ遷移時 | Phase 1→2→3 移行直前にミニ地図（§3） |
| /parallel-run 各ステップ完了時 | Step 完了報告＋次 Step 前に全体地図を再描画 |
| 通常作業中 | §1-bis 該当時は skill 抜きでも L1 ASCII 図解を出す |
| オンデマンド | 「地図」「現在地」「進捗」の発話で即時再描画 |

`gh pr list --state all` は開始時1回＋オンデマンド時のみ呼ぶ（API節約）。再描画は状態ファイルのキャッシュを優先。

## 1-bis. skill 非依存の常時発火トリガー（バランス型）

skill 非起動時でも、以下のいずれかに該当したら L1 ASCII 図解を出す（指示なしで出るのが本ルール最大の目的）。

| トリガー | 出す図の例 |
|---------|-----------|
| ① 3 つ以上の要素・手順・選択肢の説明 | 箇条マップ / 比較表 / フロー |
| ② 「今どこ・次どこ」の現在地・進捗 | 5 段階地図 / ミニ地図 |
| ③ Issue/PR/PRD/仕様書を読んで方針を伝える | 関係図 / 要約マップ / フェーズ図 |
| ④ バグ修正の「原因 → 対処」説明 | 原因 → 対処フロー |
| ⑤⑥ 複数ファイル横断の整理・依存関係説明 | 依存ツリー / フロー図 |
| ⑦ 進捗・週次レビュー・残り作業 | **ゴール地図（§2-bis）**。羅列で終わらせない |
| ⑧ AI Worker MCP へ複数 provider 委譲/状態確認 | **AI Worker 進捗図**（references）。provider名でなく作業内容・現在地を主役にする |

議論を伴う説明・プランはチャットの L1 要点図解を基本とする。L2 HTMLカードは見た目の比較が必要な時、またはユーザー希望時だけ使う（実装承認プランは plan-approval-gate.md 優先）。③④⑦も専用skill化せず本ルールで発火。

### 出さない場面（うるささ回避）

- 単純な一問一答、1 ステップで完結する短い事実回答、「図はいらない」明示時

図形式は自由。**重い L2/L3 は使わず L1 ASCII をデフォルト**にし、図を要約として使う。

## 2-bis. ゴール地図（骨子）

§1-bis⑦で出す。やったこと羅列で終わらせず、計画全体・残り・次の一手・ゴール妥当性を同時に出す。

必須 7 要素: ①🎯最終ゴール＋達成条件 ②全体スコープ ③✅済 ④⬜未（漏れ） ⑤◀次の一手 ⑥残数 ⑦⚠️ゴール妥当性レビュー。

短絡禁止: 「実装が終わった＝ゴール達成」「施策を打った＝成果(KPI)達成」と書かない（本番運用・撤退基準判定まで未達）。骨子: 📍ゴール／つくる→テスト→🚧本番投入→🏁本番=ゴール／✅済・⬜未・◀次の一手。

全体スコープ・未着手は PRD / Issue / git log を実読して埋める（推測禁止）。フルテンプレは references 参照。

## 3. ミニ地図テンプレート（/brainstorm 用）

/brainstorm の Phase 遷移時に出す最小テンプレート。全文（移設済）: `~/business/AGENT-HUB/skills/visual-companion/references/progress-map-templates.md` 「ミニ地図テンプレート」節参照。

## 4-bis. 視覚化の 3 層（L1/L2/L3）の使い分け

図解は内容に応じ 3 層を使い分ける。実行手段の SSOT は `skills/visual-companion/SKILL.md`。本ルールは L1 ASCII と判定基準のみ持つ。

| 層 | 何を出すか | 手段 | いつ |
|----|-----------|------|------|
| **L1 ASCII** | 進捗・現在地マップ | ASCII 地図（ゼロ依存） | **デフォルト・常時** |
| **L2 ブラウザ HTML** | mockup・レイアウト比較 | `start-server.sh` | 見た目の比較（オプトイン） |
| **L3 ターミナル画像** | HTML を CLI で目視 | `html-to-terminal.sh` | ブラウザを開かず見たい時 |

判定: 「読むより見た方が理解できるか？」。テキストで足りる選択は L1、見た目の比較は L2/L3。

### 境界（Stitch との切り分け・常時）

- **L2 の説明用 HTML**（Before/After・計画承認・改善フロー図・「HTMLで見せて」）は **Stitch 不要**。MCP が無くても拒否しない。
- **本番アプリの画面デザイン確定**だけ `ui-stitch-mandatory`（Stitch）へ。無いときは **実装だけ STOP**し、説明 HTML は作ってよい。

### 説明 HTML の密度（Codex Terra 対策・禁止）

<!-- [2026-08-23][fix]
背景:
  - ユーザー依頼意図: Codex が Before/After HTML に画面細部・全フィールド・3端末分を詰めすぎて分かりにくくなる。薄いストーリー型の方が伝わる。縦長は左ナビ。MermaidはPC横/スマホ縦。Tailscale共有も必要。
  - 守るべき業務ルール: 説明HTMLの既定は「一言の変化→Before/After対比→役割は最大3段」。細密詰め込みは禁止。画面モックは明示依頼時のみ。手順は visual-companion references。
  - 他案不採用理由: 毎回ユーザーが「薄くして」と言う運用は再発するため不採用。憲法に禁止を書く。
対応: 既定＝薄いストーリー型、禁止＝細部詰め込み、オプトイン＝画面/Mermaid、ナビ・向き・配信は手順正本へ。
-->

**手順・テンプレ正本（ライブ読み）**: `skills/visual-companion/references/explain-html-codex.md`  
**骨格テンプレ**: `skills/visual-companion/references/explain-html-shell.html`

**既定（これで出す）**: 薄いストーリー型（PART A）。

- 1行の変化 → Before/After 要点（各 3〜5 行）→ 役割最大 3 段
- お手本粒度: `kaizen-unified` の PART A / `kaizen-cold-storage-story` 級
- セクション 3 つ以上 → **左 sticky 目次**（スマホは横スクロール目次）
- Mermaid を出すとき → **PC=LR・スマホ=TD** の2本＋CSS切替（手順正本参照）
- 他端末・Tailscale 共有時 → `0.0.0.0` 配信し localhost と Tailscale URL の両方を出す

**禁止（頼まれなくてもやらない）**:

- 全フィールド・全ボタン・全チップ・全タイムスタンプを画面に埋め込む
- スマホモックを横に 3 枚並べて細部まで再現する（情報過多）
- iframe サンドボックス包みや英語タイトルだけの「見た目リッチ・中身読めない」HTML
- 「詳しいほど親切」として説明 HTML を仕様書化する
- Stitch 未接続を理由に説明 HTML を拒否する

**オプトイン（利用者が明示したときだけ）**:

- 「画面で見せて」「Asana の画面」「PWA の画面」「Mermaid」など → PART B（画面モック / フロー図）
- それでも **1画面あたりの意味合いを主役**にし、UI 細部の再現は最小にする

## 5. 非エンジニア用語ルール

### 原則

- 技術用語は**初回登場時のみ**括弧で平易語を併記、以降はそのまま使う（完全置換はしない）
- 同意の扱いは下の共通正本を参照する

代表例（全 12 語は references 参照）: PR=変更提案 / merge=本番に取り込む / migration=DB 構造変更 / staging=テスト環境 / worktree=別フォルダ作業領域。

### 短い同意への応答

共通ルール CARD 01「承認の有効範囲」（正本: `dotfiles/global/shared/SHARED_AGENTS.md` の `global-agent-behavior` ブロック）に従う。

### 技術判断を仰ぐ時（平易語 + 選択肢で聞く）

**技術判断は技術用語で聞かない**。①平易語（速さ・安全性・見た目への影響）で説明②2〜3択で提示（可能なら AskUserQuestion）③推奨理由を1文添える。実例は references 参照。

## 6. 状態ファイル schema

`.claude/parallel-run-state/<feature-slug>.json` に保管（kebab-case slug、各PJの `.gitignore` へ追加）。フィールド定義・モード別 schema・`gh pr list` 合成手順の全文は `<AGENT-HUB>/skills/visual-companion/references/state-file-schema.md` を参照。

## 7. 関連ルール

- `.claude/rules/general/response-style.md` / `sub-agent-scope-contract.md` / `branch-rule.md`
- `skills/brainstorm/SKILL.md` / `skills/parallel-run/SKILL.md` — 各フェーズ・Step 遷移時に参照
- `commands/brainstorm.md` / `commands/parallel-run.md` — 手動発火ラッパー
- 全文: `<AGENT-HUB>/skills/visual-companion/references/progress-map-templates.md`, `state-file-schema.md`

`<AGENT-HUB>` は中央ハブrepoのルートを表す（標準配置は `~/business/AGENT-HUB`、別環境では実際の配置先）。

**追記ルール: テンプレ・実例・置換表は references へ書き、本ルールには足さない（再肥大化防止）。**
