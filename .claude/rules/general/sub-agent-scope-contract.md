<!-- agents-md-card:start -->
### CARD: sub-agent-scope-contract — 委譲は3点必須
- **いつ**: Task/Agent に作業を委譲するとき
- **何を**: allowed_files / forbidden_actions / verify before return を必ず書く。探索ならcontext-engine先、UIならdesign-philosophy先
- **できた状態**: 委譲先が範囲外編集・stash破壊・捏造検証をしていない
- **詳細**: `.claude/rules/general/sub-agent-scope-contract.md`
<!-- agents-md-card:end -->

# サブエージェント Scope Contract

サブエージェント（Task / Agent tool）に作業を委譲するとき、delegate 元のプロンプトに**必ず以下 3 項目（コード探索を伴う場合は §4、UI/デザインを伴う場合は §5 を足す）を含める**。制定経緯・テンプレート全文は `~/business/AGENT-HUB/docs/architecture/sub-agent-scope-contract-details.md` を参照。

## 1. allowed_files（編集を許可するファイル）

委譲先が編集してよいファイルパスを明示的に列挙する。

例: `「allowed_files: src/api/auth.ts のみ。他は read-only」`

## 2. forbidden_actions（禁止する操作）

委譲先が**してはいけない**操作を明示する。よくある禁止例:

- `auto-format で quote replacement や import 並び替えを実行しない`
- `スコープ外のファイルを編集しない（読み取りは可）`
- `テストの skip / xit を追加しない`
- `existing CaD コメントを削除しない`
- **`.claude/hooks/` / `hook-library/` のガード hook（block-main-commit 等）をデバッグ目的で一時編集しない**（deny 原因調査はログ・分割コマンド・worktree 委譲で行う。2026-08-12 jtt-system 配布インシデント再発防止）
- **検査・テスト・受け入れ条件を通すために timestamp・実行者ID・実行していないコマンドの出力・確認内容などの値を捏造しない**。指示と検査要求が矛盾したら通す側に倒さず、報告だけで済ませず**停止**して呼び出し元へ確認する（詳細: `~/business/AGENT-HUB/skills/plan-approval/SKILL.md`。2026-08-14 実測）
- **`git stash` 系（pop / apply / drop / clear）を実行しない**。stash はリポジトリ共有であり、隔離 worktree にいても他セッションの未コミット作業を壊しうる（2026-08-15 実測: 隔離 worktree での検証中に他ブランチの stash を pop し conflict 発生。衝突しなければ気付かず消えていた）
- 自分が作っていない**他ブランチの reflog / git config を変更しない**
- 自分が作っていない **worktree・リモートブランチを削除しない**

理由: `allowed_files` はワークツリー内のファイルしか縛れず、リポジトリ共有の状態（stash / reflog / config / remote branch）は素通りするため。

## 3. verify before return（返却前の検証手順）

委譲先が作業完了を報告する前に実行する検証を指定する。

AI Worker 委譲では worker に `git diff` 等の scope 照合を要求しない。worker の sandbox は git deny で、
scope 照合は harness が host で実施する（`evidence.scopeVerification`・#2160）。
worker へ渡す検証要求も同じ前提で書き、sandbox/環境要因で走らなかった場合は「未実行」と理由付き報告を求める
（成功と偽らせない）。worker 側には既定プロンプトで同旨が注入される（providers.ts の sharedQualityRules）。
変更範囲は host completion の `evidence.scopeVerification` で確認する。
`status=passed`、`headCommit=local_commit`、`allowedFiles` が依頼範囲と一致する場合、そのコミットのファイル一覧照合を手で繰り返さない。
証拠が無い旧jobや対象コミットが変わった場合は親が確認する。コード内容のレビューとテスト結果の確認は別に行う。

例:
- `git diff --name-only で編集ファイル一覧が allowed_files と一致することを確認`
- `lint / typecheck を実行してエラーが出ないことを確認`
- `想定外の編集があった場合は revert してから報告`

## 4. context-engine first（コード探索を伴う委譲・Explore 含む）

委譲タスクが**コードの場所・関数・route・呼び出し関係・影響範囲の探索**を含むなら、prompt に必ず入れる:

- 「まず `codebase-context-engine` を使う（`grep`/`Read` を先に走らせない）。遅延ツールは
  `select:mcp__codebase-context-engine__list_projects,hybrid_search,search_graph,get_code_snippet` でロード」
- **解決済みの `project` 名を親が渡す**（親が `list_projects` を見て明示）。
  `preferred_project` がある場合はそれを使う。
  `project_scope: ambiguous_worktrees` の場合は、現在の cwd と一致する `root_path` / `preferred_project_candidates` を親が選んでから渡す。
  subagent に `private-tmp-cbm-...` の長いミラー名を推測させない。
- 「索引はミラー＝当日新規/変更したファイルは未反映なので、その分だけ `Read` 併用」

理由: 候補圧縮で速く・低コスト（多数 grep/Read を回避）。subagent は本ルールを自動継承しないため親が prompt 注入必須（追加経緯は詳細ドキュメント参照）。

## 5. design-philosophy first（UI/デザインを伴う委譲時）

委譲タスクが**UI・画面・デザイン・レイアウト・コンポーネントの作成/変更**を含むなら、親が prompt に必ず入れる:

- 「まず `~/business/AGENT-HUB/docs/design/design-philosophy.md`（伸太郎殿の設計思想 SSOT）を Read してから着手する」を**必読指定**する。
- 必ず該当ファイルの**絶対パス**（`~/business/AGENT-HUB/docs/design/design-philosophy.md`）を渡す（委譲先の実行 cwd は消費先PJであり、相対パスでは解決不能なため）。
- Stitch を使う画面作成は、`stitch-screen-creator` グローバルエージェント（設計思想を step0 で必読にしている）へ委譲するのが既定。

理由: AI Worker（Kimi/Codex/Cursor/GLM 等）自身にデザインセンスが無くても、親が設計思想 doc を必読で渡せば思想に沿った画面を作れる。渡さないと委譲先が自己流判断でずれる。

## delegate プロンプトのテンプレート・親側の verify ステップ

テンプレート全文と、親セッションが `git diff --stat` / `git diff -- <files>` で確認する verify コマンド列は
`~/business/AGENT-HUB/docs/architecture/sub-agent-scope-contract-details.md` を参照。allowed_files 外に変更が混入していた場合は
revert し、delegate にやり直しを指示する。

---

**追記ルール: 制定経緯・テンプレート全文の詳細は `~/business/AGENT-HUB/docs/architecture/sub-agent-scope-contract-details.md` へ書き、本ルールには義務・トリガーだけ足す（再肥大化防止）。**
