<!-- agents-md-card:start -->
### CARD: worktree-rule — 編集は専用worktree
- **いつ**: ファイル変更・commit・push がある AI 作業
- **何を**: 専用 worktree で着手→cleanupまで閉じる。共有 main を掴まない。stash で他セッションを壊さない
- **できた状態**: 自分の worktree/branch だけで完了し、不要な共有 checkout 占有が無い
- **詳細**: `.claude/rules/general/worktree-rule.md`
<!-- agents-md-card:end -->

<!-- 制定経緯（2026-05-15 新規作成 / 2026-07-01 main直接コミット例外全撤回 / 2026-07-16 PR2ダイエット）の
CaD 全文は `~/business/AGENT-HUB/docs/worktree-operations.md`「決定履歴（CaD 移設）— worktree-rule.md 由来」参照 -->

# Worktree 利用ルール

## いつ worktree を使うか

AI が変更を加える通常作業では、git worktree を作成して別ディレクトリで作業する。
特に以下のいずれかに該当するときは必須:

- **並列セッション**: Claude Code / Codex CLI / Cursor 等を同時に複数立ち上げて別タスクを進める
- **複数 PR 同時進行**: 同一リポジトリで 2 本以上の feature branch を行き来する
- **長期 feature branch**: main から離れて 1 日以上滞在する作業（途中で main を hotfix する可能性がある）
- **軽量変更を含む AI 作業**: 例外なし。詳細は branch-rule.md 参照

worktree 作成コマンドの例は `~/business/AGENT-HUB/docs/worktree-operations.md` を参照。

## Worktree path

Owner 2026-09-22: do not create a git worktree as a direct child of $HOME.

- `git worktree add` is required for AI edits.
- The new worktree path must not be a direct child of $HOME (forbidden example: /Users/shintaro/jtt-system-interview-document).
- Use only the parent directory the doc already specifies. Do not invent a new parent.
- Do not block the existing primary checkouts (~/jtt-system, ~/business/AGENT-HUB, and the other registered project roots). Block only `git worktree add` when the destination's parent is $HOME.

## いつ新規 worktree を作らなくてよいか

以下は新規 worktree なしでよい:

- 読み取りだけでファイル変更・commit・push がない場合
- 既に feature branch にチェックアウト済みで、別タスクを差し挟まない場合
- 既にこのタスク専用の worktree / branch にいる場合
- 人間が明示承認した main 直接反映や初回 repo 作成など、branch-rule.md の注記に該当する例外の場合

## 機密ファイル（MCP / .env）の自動 symlink

worktree 作成時、git 追跡外の機密ファイル（`.mcp.json` / `.env` 系）は main worktree の実体へ**自動 symlink**される（git post-checkout hook 由来）。追加操作は不要。仕組み・手動再設置手順・非破壊の詳細は
`~/business/AGENT-HUB/docs/worktree-operations.md` を参照。

## Mac mini ContextEngine mirror の自動追従

Mac Studio 側の worktree は Mac mini の ContextEngine mirror が自動追従する（対象: jtt-cms / jtt-apps / jtt-system / AGENT-HUB / hermes）。索引はミラーであり当日の新規変更は未反映のことがある。詳細・stale削除・semantic強化ジョブは
`~/business/AGENT-HUB/docs/worktree-operations.md` を参照。

## branch contamination が発生した場合の復旧

別セッションのブランチに誤ってコミットした場合は、誤コミット特定 → 正しいブランチへ `cherry-pick` → 復旧用退避作成、の順で対応する。
**`git reset --hard` と force-push はデフォルト禁止。必ずユーザー承認を得てから実行する。**
詳細手順は `~/business/AGENT-HUB/docs/worktree-operations.md` を参照。

## AI セッションから worktree へ commit / push する方法（block-main-commit 対策）

block-main-commit hook は cwd 変更を伴う複合コマンドでの main 直 commit を fail-closed で deny する。AI セッション（cwd=main）から worktree の feature branch へ commit / push する時は:

1. **`isolation: "worktree"` 付きサブエージェントに委譲する**（正攻法）。
2. isolation 指定ができない場合のみ、GitHub API / connector で remote feature branch commit → PR → CI → merge の fallback を使う（main 直更新は禁止のまま）。
3. commit/push を含まない操作（`git add` / `git status` / `gh pr create` 等）はメインセッションから直接 `cd <worktree> && ...` してよい。
4. hook 検査を `bash -c` 等で素通りさせる回避は**禁止**。
5. **`skills/post-merge/scripts/merge-pr.py` は実行元 HEAD が対象 PR の `headRefOid` と一致することを要求する**（不一致は fail-closed でマージ拒否）。**対象 PR の worktree を cwd にして実行する**こと。main checkout や別 PR の worktree からは実行できない（2026-08-18 実測）。

<!-- [2026-08-31][fix]
背景:
  - ユーザー依頼意図: Claude Code 固有の session lifecycle を保ちつつ、同じ共通 rule を読む Codex / Cursor / Antigravity 等へ誤配布しない。
  - 守るべき業務ルール: 全 client 共通の git worktree 安全境界は本 rule に残し、client 固有操作は resolver の client selector で分離する。
  - 他案不採用理由: 本文 marker の後処理や adapter ごとの文字列削除は、生成経路が増えるたび漏れを再発させるため不採用。
対応: Claude 固有 lifecycle を独立 rule asset へ移し、本 rule は全 client 共通契約だけを保持する。
-->

## 共有 checkout / main 非占有ルール（全 PJ・全 AI ツール共通）

対象ルート: `~/LLM-Dev/` `~/business/` `~/Herd/` `~/mac-mini-server/` `~/mcp-servers/` `~/jtt-system/`。Claude / Codex / Cursor / Kimi / OpenCode / Antigravity 全て同じ意味で読む。

**AI セッションは、他者や他エージェントが使う可能性のある `main` checkout を掴まない。** 共有 checkout で merge / pull / cleanup を実行すると、並行セッションとブランチ・HEAD を奪い合って競合する。背景・実測実害は `~/business/AGENT-HUB/docs/worktree-operations.md` を参照。

### 必須：1 タスク = 1 連の完了フロー（PR を出して放置しない）

**専用 worktree 作成 → 編集/commit/push → PR 作成 → マージ → fetch-only / detached 確認 → clean（worktree/branch 削除）まで、必ず一連で最後まで閉じる。** 「PR を出した」「マージした」で止めない。詳細コマンド列は `~/business/AGENT-HUB/docs/worktree-operations.md` を参照。

### Cursor チャットが紐づく worktree を先に消さない（必須）

クライアント差: Claude Code / Codex は worktree 削除後の主害が **cwd 消滅**（次コマンド失敗・`cd` で復帰しやすい）。
Cursor は birth path の **project cache**（`~/.cursor/projects/<slug>/`）が残り、Connected でも **0 tools**、
追加 migrate が消えた path で `git ENOENT` になるのが差。Cursor 専用の削除ガードが必要で、全クライアント一律禁止にはしない。

`move_agent_to_root` が成功しても slug / キャッシュが残ったまま path を消すと上の Cursor 症状が出る。

**禁止:** 今のチャットの cwd（または祖先）になっている worktree、または直近 24h に `agent-transcripts` が更新されている
worktree を、別フォルダへ移った確証前に削除すること（`mcps/` 残存だけでは拒否しない）。  
**手順:** ① 生き残るフォルダへ Open / `move_agent_to_root` ② MCP tools>0 を確認 ③  
`python3 scripts/check-cursor-workspace-before-remove.py <path>` が OK ④ それから削除。  
`merge-pr` は Cursor 紐づけ検知時に **その worktree の remove だけ遅延**し、remote / local branch と他 worktree
の掃除は続行する。明示フラグ `--allow-active-cursor-workspace-cleanup` だけが当該 WT 削除の上書き（人間確認後）。

### AI が `main` で「やらないこと / 代わりにやること」

- **やらない**: `git checkout main` / `git switch main` / `git branch -f main` / **共有 checkout へ入って**の `git pull`（`cd <repo> && git pull` のように cwd を main へ移す形）。
- **やる**: 配布物を実際に届ける早送りは `git -C <対象PJの絶対パス> pull --ff-only` の単発コマンドで **AI が自分で実行する**（下記「catch-up pull」節）。
- **やる**: `git fetch origin +refs/heads/main:refs/remotes/origin/main` で remote tracking ref を更新する。確認が必要な時は `git worktree add --detach <verify-dir> origin/main` で detached 確認。
- merge は worktree 内から `gh` / `skills/post-merge/scripts/merge-pr.py --confirm-read` で行う。
- **cleanup は自分が作った worktree / branch だけ**削除する。`git worktree list --porcelain` で他セッションのものを確認し**温存する**。
- allowlist 対象の生成 config を main 直コミットする時の stale-main 注意は `~/business/AGENT-HUB/docs/worktree-operations.md` を参照。

要するに「編集だけ worktree、merge/pull は共有 checkout」をやめる。**着手から cleanup まで一貫して専用 worktree**で閉じる。例外的に人間が明示して main checkout を使う場合は、AI が占有している状態でないことと例外理由を作業ログへ残す。

### catch-up pull は AI が自分で閉じる（全 PJ・全 AI ツール共通・2026-08-16）

配布・修正をマージしても、実際に読まれるのは各 PJ の checkout 上のファイルである。そこへ早送りする
catch-up pull は人間ゲートにせず、**AI が自分で実行して最後まで閉じる**。人間ゲートは戻せない外向きの操作に絞る。

**形を固定する**: `git -C <対象PJの絶対パス> pull --ff-only` の**単発コマンド**だけを使う。`cd` を伴う複合コマンド・
`--rebase`・refspec 指定・`--ff-only` を外した pull は使わない（cwd を移さないため共有 checkout の HEAD を掴まない）。

**必須ガード**:

1. 事前に `git -C <path> status --porcelain --untracked-files=no` を確認し、**tracked な未コミット変更があれば pull せず報告する**（他セッションが作業中の可能性）。**untracked ファイルだけなら pull してよい**（`--ff-only` は untracked を壊す取り込みを git 自身が中止するため安全）。`git status --short` で判定すると untracked のゴミ1個で配布が永久に止まる（実測 2026-08-16）。
2. `git -C <path> branch --show-current` が `main` でない、または detached の場合は **pull しない**。
3. **届いたことを実測する**。変更した文字列を配布先で `grep` して確認し、pull の成功出力だけを根拠にしない。
4. 配布したら pull まで閉じる（`branch-rule.md`「配布クローズアウト責任」の完了条件）。「マージした＝届いた」で終えない。

制定経緯・実測は `~/business/AGENT-HUB/docs/worktree-operations.md`「catch-up pull は AI が自分で閉じる — 制定経緯と実測」を参照。

## 既存 worktree の確認

```bash
git worktree list
```

新規作成前に既存 worktree の再利用可否を確認すること。既存 worktree の実例（jtt-apps 等）は
`~/business/AGENT-HUB/docs/worktree-operations.md` を参照。

---

**追記ルール: 実測事例・復旧手順・長文詳細は移設先（references / docs）へ書き、本ルールには義務とトリガーだけ足す（再肥大化防止）。**
