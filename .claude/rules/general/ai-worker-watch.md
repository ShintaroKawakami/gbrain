<!-- agents-md-card:start -->
### CARD: ai-worker-watch — 委譲後は見張りを立てる
- **いつ**: `delegate_impl` で AI worker へ委譲したとき／PR を作って CI を待つとき
- **何を**: 委譲・PR 作成の直後に見張りを background で1本立てる。ポーリングだけで待たない＋5分ごとに get_job_status を自分で呼び1行報告
- **できた状態**: 終了・期限切れのどちらでも AI が自分で起きている（無言で待ち続けていない）
- **詳細**: `.claude/rules/general/ai-worker-watch.md`
<!-- agents-md-card:end -->

<!-- [2026-08-28][feat] AI worker / PR CI の見張り義務化
背景:
  - ユーザー依頼意図: 2026-08-27、AI worker が2本とも正常終了したのに、翌朝 09:50 に利用者が話しかけるまで
    12時間（実測 idle_seconds: 42944）レビュー待ちで止まっていた。AI が動き出すきっかけが「利用者の発言」
    しか無いため。MCP は job 終端時に ~/.cache/agent-hub/ai-worker-mcp/jobs/<job_id>.terminal を書いている
    （2026-08-08 実装済み）が、旗を置く側はあっても見張る側が無かった。同じ第1段で見張りスクリプト2本
    （scripts/watch-worker-job.sh / scripts/watch-pr-checks.sh）を別ブランチで実装済み。本ルールはそれを
    「使うことを義務にする」文書として新規作成する。
  - 守るべき業務ルール: 見張りは親セッションの background プロセスとして立てる（サブエージェントに完了待ち
    をさせると停止ループする＝ Tech G-Brain `subagent-background-wait-stall`）。見張りから自動 cancel・
    自動 retry はしない（未コミット成果を壊す）。セッションが死ねば見張りも道連れになる（外から見る第3層
    の孤児スキャンは 2026-08-28 時点で未実装・第2段で実装予定）。
  - 他案不採用理由:
    (1) ルールを書かず PM の記憶に任せる案は、書いた本人が忘れるため不採用（2026-08-27 の12時間放置が
        まさにそれ）。
    (2) MCP 本体を改造して能動通知させる案は、旗（`.terminal` ファイル）は既に置かれており見張る側だけで
        足りるため不採用（常駐 infra の改造はコストが高い）。
対応: watch-worker-job.sh / watch-pr-checks.sh を background 起動する義務・禁止事項・終了コードの読み方・
  未実装の第3層の明記を .claude/rules/general/ai-worker-watch.md へ新規作成する。
-->

# AI Worker / PR CI の見張りルール（無言待ち禁止）

## なぜ必要か

2026-08-27、AI worker が2本とも正常終了していたのに、翌朝 09:50 に利用者が話しかけるまで **12時間**
レビュー待ちで止まっていた（実測 `idle_seconds: 42944`）。AI が動き出すきっかけが「利用者の発言」しか
無かったため。

MCP は job 終端時に `~/.cache/agent-hub/ai-worker-mcp/jobs/<job_id>.terminal` を書いている
（2026-08-08 実装済み）。旗を置く側はあったが、**見張る側が無かった**。見張りスクリプト2本
（`scripts/watch-worker-job.sh` / `scripts/watch-pr-checks.sh`）を実装済みのため、本ルールは
それを**使うことを義務**にする。

## 使い方

`delegate_impl` で委譲した直後、または `gh pr create` で PR を作った直後に、対応する見張りを
**background で1本立てる**（絶対パスで呼ぶ。配布先 PJ の cwd からは相対パスで解決できない）。

```
~/business/AGENT-HUB/scripts/watch-worker-job.sh <job_id> [deadline] [worktree_path]
~/business/AGENT-HUB/scripts/watch-pr-checks.sh <pr_number> <owner/repo> [deadline] [interval]
```

PR の監視開始時の head SHA を固定し、取得前後に一致を確認する。別途開始した
`workflow_dispatch` なども完了条件に含む場合は、最初の4引数に続けて
`--run <run_id>@<head_sha>` を必要な run ごとに指定する。指定した run の ID と head も照合する。
対象外の run を一括で待たない。head が更新された場合は新しい変更内容と監視対象を確認してから起動し直す。

`NO_CHECKS` は未検証、`NOT_STARTED` は指定 run の開始待ち、`RUNNING` は実行中、
`PASS` は固定 head のチェックと指定 run がすべて成功した状態。`FAILED` と
`UNKNOWN_STATE` は成功として扱わない。チェック無しで追加 run だけ成功しても未検証のままとする。
明示指定 run の `skipped` は、要求した検証が実行されていないため成功に含めない。

Claude Code なら `run_in_background: true` で起動する。ポーリングだけで無言で待たない。

`merge_pull_request`（または `create_pull_request(merge_after_pr=true)`）は内部で merge-pr.py を最大 15 分走らせる。呼び出しが background に回った場合も同じく 5 分ごとに状態を確認し、無言で待たない。

## 5 分ごとの能動確認（2026-09-03〜・義務）

見張りスクリプトは「終了・期限切れで起こす」だけで、途中の停滞・暴走・テスト待ちは PM に見えない。
委譲直後に見張りを立てるのに**加えて**、PM は **5 分ごとに `get_job_status` を自分で呼ぶ**。
Claude Code では background の `sleep 300` を 1 本立て、終了通知で起きて確認する（ポーリングをサブエージェントに任せない）。

各確認で「経過分・最終更新（何が）・変更ファイル数・テスト状況」を 1 行で報告する。利用者に
「止まってない？」と聞かれる前に AI が把握している状態を保つ。MCP の `next_status_check`（120 秒）も
同じ趣旨であり、無視しない。

実測 2026-09-03: Kimi へ委譲後 21 分間 PM が一度も確認せず、利用者から指摘（`health_status: active` だったが
PM は把握していなかった）。

## 禁止

- **成功の合図だけを見る見張りを書かない。** 無言で終わる経路を作らない。「黙っている」は「順調」と
  見分けがつかない。
- **期限切れを「固まった」と断定しない。** テスト実行中・大きいファイル読み込み中はファイルが動かない
  （2026-08-28 実測: `health_status: active` なのに worktree 無更新）。判定は MCP の `get_job_status`
  に聞く。
- **見張りから自動 cancel・自動リトライをしない。** 未コミット成果を壊す。
- **サブエージェントに完了待ちをさせない。** 停止ループする（Tech G-Brain
  `subagent-background-wait-stall`）。見張りは親セッションの background プロセスにする。
- **`gh pr checks --watch` を見張りに使わない。** 端末が無い裏実行だと待たずに exit 0 で終了する
  （2026-08-28 実測）。

## 終了コードの読み方

| スクリプト | 終了コード |
|-----------|-----------|
| `watch-worker-job.sh` | 0=終端検知 / 2=期限切れ（未終端・状態確認へ） |
| `watch-pr-checks.sh` | 0=固定 head の全チェックと指定 run が成功 / 1=失敗あり / 2=期限切れ / 3=状態を読めなかった / 4=チェック無し・未検証 / 5=head または run ID 不一致 / 64=引数不正 |

## セッションが死んだ場合

この見張りは親セッションの子プロセスなので、セッションが死ねば道連れになる。外から見る第3層
（Hermes からの孤児スキャン）が別途構想されているが、**2026-08-28 時点では未実装（第2段で実装予定）**。
現時点で「ある」ものとして扱わない。

---

**追記ルール**: 実測事例・長文詳細は移設先へ書き、本ルールには義務・トリガー・禁止事項だけ足す（再肥大化防止）。
