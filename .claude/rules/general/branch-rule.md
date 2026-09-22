<!-- agents-md-card:start -->
### CARD: branch-rule — main 直コミット禁止
- **いつ**: commit / push / PR 作成するとき
- **何を**: 専用 worktree + feature branch → PR。main へ直接書かない。第三者 upstream へ書かない（origin=自分のforkのみ）
- **できた状態**: 作業は feature branch 上。upstream は fetch のみ
- **詳細**: `.claude/rules/general/branch-rule.md`
<!-- agents-md-card:end -->

# ブランチ運用ルール

制定経緯（CaD）: `~/business/AGENT-HUB/docs/worktree-operations.md`「決定履歴（CaD 移設）— branch-rule.md 由来」節を参照。

## main ブランチへの直接コミット・プッシュ

AI エージェントの通常作業では、**main ブランチへの直接コミット・プッシュは禁止**。

Markdown、`sync-state.json`、AI ツール設定、AGENT-HUB 運用設定、MCP 台帳などの軽量変更でも、
AI は main へ直接 commit / push しない。必ず専用 worktree + feature branch を作成し、PR 経由でマージする。

人間が明示的に「今回は main に直接反映してよい」と承認した場合、または初回 repo 作成直後で
PR 導線がまだ存在しない場合だけ例外になりうる。AI はこの例外を自己判断で使わず、理由を作業ログに残す。

（過去に運用設定・hook配布物等を段階的に allowlist で main 直接許可した経緯があるが、2026-06-23〜2026-07-01
で全撤回済み。allowlist 変遷史の全文は `~/business/AGENT-HUB/docs/worktree-operations.md` を参照）。

## third-party upstream への書込み禁止

全PJで、第三者所有の upstream への push・PR作成・branch削除など、あらゆる書込みを禁止する。
変更が必要な場合は必ず自分のGitHubアカウントへforkし、fork内のbranchからforkのmainへPRする。

- `origin`: 自分が所有するfork。唯一のwrite先
- `upstream`: 元リポジトリ。fetch専用
- forkが存在しない状態で書込みを続行しない
- upstreamへ成果を還元したい場合も、この運用ではupstream PRを作らない

実行時は `hook-library/scripts/block-main-commit.sh` が `git config --global github.user` と書込先ownerを照合し、
foreign ownerへの `git push`、`gh pr create`、REST PR作成をfail-closeする。

## 理由

- main checkout は複数 AI / 複数セッションで共有されやすく、軽量変更でも HEAD を掴むと競合や cleanup 失敗の原因になる
- Markdown や設定だけでも、PR にするとレビュー履歴・CI・merge 後確認・worktree cleanup が同じ型で残る
- ツールごとに例外を残すと、Claude / Codex / Cursor / Kimi / Antigravity 間で運用がずれる
- main の最新化は `git pull` ではなく、fetch-only と detached HEAD / 専用 verify worktree で確認すれば足りる

## AGENT-HUB の CI とマージ根拠（2026-07-30 STEP 4）

AGENT-HUB の CI は `workflow_dispatch` + `ci/light` ラベル方式（pull_request 自動トリガーは 2026-07-24 に削除済み）。
PR に checks が無い場合のマージ根拠は `merge-pr.py` のローカル軽量ゲート（`registries/merge-gate-suite.yaml`）。
台帳未整備のリポでは従来どおり checks 0 件で通す（詳細: `skills/post-merge/SKILL.md`）。

## 配布クローズアウト責任

AGENT-HUB から各 PJ へ配布した差分は、配布を実行した AI / 担当者が最後まで閉じる。

対象: `scripts/deploy-agent-bundle.py` / `scripts/deploy-hooks.py` / `scripts/sync-agents.py` /
`scripts/bootstrap-skills.py` / `scripts/deploy-skills.py` / `scripts/deploy-rules.py` /
`/publish-deploy` など、上記を呼ぶ配布コマンド。

配布先 PJ に tracked 差分が出た場合は、feature branch 作成 → 配布差分だけ commit → PR 作成 → CI/review 確認 →
`merge-pr` でマージ → fetch-only + detached HEAD / verify worktree で取り込み確認 → worktree/branch cleanup →
`git status --short` clean 確認 → **配布先 checkout への catch-up pull（`git -C <絶対パス> pull --ff-only`）と届いたことの grep 実測**、
まで一連で完了する（詳細な完了条件・禁止・例外の全文は `~/business/AGENT-HUB/docs/worktree-operations.md` 参照）。

禁止: 「これは自分が修正したファイルではない」として配布差分を放置する／未コミットのまま終了する／
main 直接 push で済ませる／`--push` の成功だけで完了扱いにする／**マージしただけで「届いた」と報告する
（catch-up pull と grep 実測まで済ませていない）**。

例外（dry-run のみ・差分なし・既存WIPで安全に branch できない・権限やCI failureで merge できない）の場合も、
対象 PJ・残っている差分・止めた理由・次の安全な一手を報告する。

## 事前計画ステップ

タスク開始時、変更を伴う作業か確認する（コード変更・JSON/YAML変更・`*.sh`変更・Markdown/sync-state/AIツール設定などの軽量変更）。
AI 作業で変更がある場合、**最初に専用 worktree + feature branch を作成**してから編集を始める。AI 作業では `main` を checkout しない。
コマンド列は `~/business/AGENT-HUB/docs/worktree-operations.md` を参照。

読み取りだけの場合、またはすでに専用 worktree / feature branch 内にいる場合は新規 worktree を作らなくてよい。
AGENT-HUB から各 PJ へ配布した tracked 差分も「配布クローズアウト責任」に従う。

## pre-commit hook 違反後のピボット

万一 hook（`hook-library/scripts/block-main-commit.sh`）にブロックされた場合は、変更を退避（stash/patch）→
専用 worktree で feature branch 作成 → 変更復元 → commit/push → PR 作成、の順で復旧する。main の HEAD は
無変更のまま維持されることを確認する。詳細手順は `~/business/AGENT-HUB/docs/worktree-operations.md` を参照。

## 関連フック

`hook-library/scripts/block-main-commit.sh` が上記ルールを自動判定・ブロックする。

## 関連ルール

- `.claude/rules/general/worktree-rule.md` — 並列セッション時の worktree 利用
- `.claude/rules/general/sub-agent-scope-contract.md` — サブエージェント delegate 時の制約
- `~/business/AGENT-HUB/docs/worktree-operations.md` — allowlist変遷史・配布クローズアウト責任詳細・事前計画コマンド列・pre-commit hookピボット手順の正本

---

**追記ルール: 実測事例・変遷史・長文手順は `~/business/AGENT-HUB/docs/worktree-operations.md` へ書き、本ルールには義務・トリガー・禁止事項だけ足す（再肥大化防止）。**
