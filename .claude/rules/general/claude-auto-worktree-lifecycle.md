<!-- [2026-08-30][fix]
背景:
  - ユーザー依頼意図: Claude auto mode が EnterWorktree / ExitWorktree を任意の経路として案内するだけでなく、自分の feature worktree で自律実行してほしい。
  - 守るべき業務ルール: worktree-bound な書込みから検証までを main や他セッションの worktree に触れず、安全に閉じる。
  - 他案不採用理由: 全AIクライアントの既存経路を一律変更する案は、Claude auto mode 固有の session 操作を他クライアントへ誤適用するため不採用。
対応: Claude auto mode 専用の必須 lifecycle と、残留 session の一回限り復旧を明文化。

[2026-08-31][refactor]
背景:
  - ユーザー依頼意図: lifecycle の義務は維持したまま、Claude 以外の client surface から除外したい。
  - 守るべき業務ルール: client 差分は rule-registry の applies_to selector で表し、生成後の本文加工に依存しない。
  - 他案不採用理由: 全 client 共通の worktree-rule.md に Claude 固有節を残す案は、resolver が file 単位で選別しても内容が漏れるため不採用。
対応: 本文を独立 rule asset に移し、clients: [claude] の selector で選択する。

[2026-09-08][fix]
背景:
  - ユーザー依頼意図: auto mode なのに EnterWorktree で Yes/No 確認が出る。allow ルールは既に入っているのに改善されていない。
  - 守るべき業務ルール: 定型確認をゼロにし、AI が止まらず worktree 作業を閉じる。
  - 他案不採用理由: permissions.allow の追加は既に済んでおり効かない（外側パスへの permission root 移動は tool 許可と別の確認のため）。
対応: 新規 worktree は EnterWorktree name（.claude/worktrees/ 配下）で作る。外側パス＋path 入場は残置・隔離 worktree への復帰に限る。
-->

# Claude Code auto mode：EnterWorktree / ExitWorktree は必須

Claude Code の **auto mode** は、現在のタスク自身が作成または選択した non-main の feature worktree に対して、次を**自律的に必ず**行う。利用者への都度確認や「使ってよい経路」としての任意扱いにしない。

1. worktree-bound なファイル書込み、commit、push、PR merge、または対象 worktree を cwd にする検証の前に、対象の安全なパスを確認して `EnterWorktree` を実行する。
2. 同じ worktree-bound phase 内の操作はその session cwd で実行する。共有 main checkout、他セッションの worktree、削除済みまたは所有を確認できないパスには入らない。
3. phase が終わったら `ExitWorktree` を `action: "keep"` で実行する。`remove` / 削除系 action、main への書込み、他セッションの worktree 操作は自動化しない。
4. `EnterWorktree` が `Already in a worktree session` で拒否された場合だけ、`ExitWorktree` を `action: "keep"` で**一回**実行してから同じ対象へ再試行する。再試行も失敗した場合は main から続行せず、既存の安全な fallback を使える条件かを確認して安全に停止・報告する。

この rule は Claude Code auto mode 専用である。Codex、Cursor、その他クライアントの既存の安全ルールや実行経路は変更しない。

**AI が自分で新しい worktree を作るときは `EnterWorktree` の `name` で作る**（置き場所は `.claude/worktrees/` 配下）。
`git worktree add` で `~/business/<pj>-wt/…` など外側のパスに作ってから `EnterWorktree` の `path` で入ると、
`permissions.allow` に `EnterWorktree` があっても **「permission-root relocation to <path> — a model-supplied worktree
outside .claude/worktrees/」の Yes/No 確認が auto mode で毎回出る**（2026-09-08 実測・Claude Code 2.1.263）。
これは tool 許可とは別の permission root 移動の確認で、allow ルールでは消えない。`path` を使うのは、他の経路で
既に存在する worktree（サブエージェントの隔離 worktree・前セッションの残置）へ戻る場合に限る。

AI セッション（cwd=main）から既存の feature worktree へ移る場合は、`EnterWorktree` の `path` に対象 worktree を指定する。block-main-commit は cwd 自身の branch で判定するため、main checkout を cwd にしたまま `git -C <worktree> push` すると main 扱いで拒否される（2026-08-18 実測）。作業後は必ず上記の `ExitWorktree` を行う。

サブエージェントの worktree が古いベース（origin/main 以前）から切られる問題への対処、外側隔離 worktree の残存・cleanup 手順、fallback・session lifecycle・merge-pr.py headRefOid 要件の実測経緯は
`~/business/AGENT-HUB/docs/worktree-operations.md` を参照。
