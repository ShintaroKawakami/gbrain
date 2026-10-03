# 名前を割り当てず、記憶を確認待ちへ整理する

2026-10-04 / 実装・本番適用前の確定要件

## 推奨

entity が未指定の記憶は、既存の `take_proposals` に確認待ちの候補としてまとめる。
似た文章だけで同じ人物・案件の事実とは決めない。元の facts は書き換えない。
world の候補だけ、利用者が明示的に採用した後、指定した同じ source のページへ追加する。
private の候補は local CLI の確認用にとどめ、採用して take にする操作は拒否する。

この案で実現するのは「夜間の候補整理と、根拠を見た採否」であり、無人で事実を確定することではない。
private facts を ChatGPT から読めるようにする変更は含まない。

## なぜ自動確定しないか

- 現行 `consolidate.ts` は entity ごとの類似群を take 化し、元 facts の `consolidated_at` と古い行の `valid_until` を変える。
  entity=NULL を source 単位の群へ単純拡張すると、別人についての似た文をまとめ、元の有効な記憶を閉じる危険がある。
- 厳密一致だけならその危険は減るが、managed 保存時の `facts/single-prepare.ts#decideSingleFact` が同 source・同 visibility・NULL entity の一致を既に除くため、日常の新しい記憶には効果が小さい。
- `take-proposals.ts` は既に確認待ち、採用、拒否、再実行を持つ。新しい候補は通常の takes・ページ・検索結果へ自動登録しない。

## 変更する内容

1. `take_proposals` に nullable `evidence JSONB` を1列追加する。既存行は NULL のまま。
   根拠には version、source incarnation、全 fact ID と意味上の snapshot、visibility、期限、出典、source_session、主体未確認の理由、整理先とページ revision を保存する。
   既存の `dedup_against_fence_rows` は意味が違うため流用しない。
2. 新候補専用の `evidence_pending` / `evidence_accepting` / `evidence_accepted` / `evidence_rejected` を status CHECK に追加する。
   旧版が知る `pending` / `accepted` へ途中でも変えない。旧版の一覧・採用処理から新候補を確定できなくする。
3. 採用は `submitMaintenanceIntent` の新しい kind `managed_maintenance_entityless_proposal_accept` を使う。
   新版だけが根拠を再検証して既存の take 書込へ渡す。旧 consumer は未知 kind として拒否する。
   普通の `takes_add` に無視される追加 field を付けるだけの実装にはしない。

schema の正本と登録・両 engine 用生成物は既存 generator で揃える。本番 migration は別承認。

## 起動と候補の扱い

- 既存 CLI/config に最小の入口を用意する。既定は無効。source と明示した整理先 slug を必須にし、全 source への暗黙実行を禁止する。
- 既存の件数・経過時間・embedding の鮮度条件を利用する。類似度は確認候補を並べるためだけに使い、主体の同一性や矛盾解消を断定しない。
- private/world を分け、根拠を一件も落とさない。0ページの source でも候補作成は可能とするが、整理先が未作成なら採用できない。
  人物ページや source を自動作成しない。明示的な整理先準備後、現在の revision を持つ候補を改めて確認する。
- 新 producer 専用の version と evidence hash で再実行を識別する。旧 producer と claim/content_hash が同じでも根拠を消したり上書きしたりしない。
- 確認待ちの本文は通常 recall/search/page/chunk に出さない。外部通知・MCP API は追加しない。通常の進捗ログへ本文を出さない。

## 採用時に必ず守る境界

採用受付時と coordinator の同一 publication transaction 内で、source incarnation、同 source の整理先、ページ revision、全 facts の現在値、期限、取り下げ、visibility を確認する。
private 候補、主体・根拠の変更、期限切れ、owner 不在、権限不足、整理先の非公開化・削除は拒否する。
失敗時は take・ページ・元 facts を変更しない。再実行しても同じ採用を二重登録しない。

期限が未来でも、有限の `valid_until` を持つ根拠を含む候補は採用しない。
既存 takes の通常読取は `active` を確認するが、`until_date` による facts 同等の読取時失効を保証しないため。
期限付き候補は local の確認までとし、新しい失効機構は追加しない。

採用成功時にも、元 facts の本文、entity=NULL、visibility、`valid_until`、`consolidated_at` は変えない。
take の provenance は永続した proposal/evidence へ結びつける。短い source 文字列への切り詰めで根拠を失わない。
採用した take は明示的に追加する別の記憶となる。後日、元 fact を取り下げただけで take も自動的に消えるとは約束しない。
その連動は既存の forget 経路で保証されておらず、必要なら別の仕様承認と検証が必要になる。

## 非公開の意味

`docs/protocol/MEMORY_VERBS_v1.md` の fact.private は local CLI reads only。
`ops/facts.ts` の recall は `ctx.remote === false` 以外を world に固定する。本人 source の ChatGPT/MCP も remote であり、owner という理由だけの例外はない。
page.private は `search/private-visibility.ts#resolveExcludePrivatePages` で operator の明示 opt-out を許す別契約。
private fact を private page の take にするだけでは元の読取条件を保てないため、この案では行わない。
take.visibility の新設や既存 page の opt-out 変更は、今回の推奨案には含めない。

## 確認するテスト

1. world/private の候補分離、0ページ、同じ claim の別 source、主体不明・矛盾未確認の表示、通常 recall/search への候補不掲載。
2. 元 facts 全項目の不変、期限切れ・取り下げ・private の採用拒否、source incarnation・target revision の変更、queued publication 中の変化、owner/権限不足。
3. 旧 producer との衝突防止、候補再生成と採用の再実行、採用途中の失敗、旧 binary の候補採用拒否・旧 consumer の未知 intent 拒否、既存 NULL-evidence 候補の互換。

新テストは合成 PGLite/隔離 Postgres fixture を使う。本番の記憶を受入試験にしない。
本番同版 baseline `a4c5ea3c99d41fa601f48c0cc5d73b4adea3b873` / v0.60.25.0 / Bun 1.4.2 では、
`cycle-consolidate`、`consolidate-valid-until`、`cycle-repeated-consolidation`、`managed-maintenance` の4ファイル38テストが成功した。
これは変更後の試験結果ではない。新実装は回収後に独立検証・レビュー・実装監査を行う。

## 本人に承認いただく最後の変更

コード・合成試験・レビューを完了した後に、(1) evidence 列と新 status の本番 migration、(2) 対象 source と明示整理先、(3) default-off 機能の有効化を提示する。
既存 facts の一括分類、公開範囲の変更、owner claim は含めない。

## 止め方と戻し方

入口を無効にして新候補作成を止める。進行中の publication を確認し、既存の処理手順で安全に収束させる。
旧版へ戻しても新 status と新 intent kind を拒否することを fixture で証明してから戻す。
evidence 列・status CHECK を勝手に削除せず、未確認候補を旧 pending に変換しない。
元 facts は不変なので復元移行は不要。採用済み take を戻す必要がある場合は、その個別の採否として扱い、元の記憶を削除しない。

## 現在の成果の扱い

- 自動 take 化の旧試作は未採用。専用 branch の WIP `8b9e087cc` に隔離し、この案へ混ぜない。
- pending 案のコード・migration は専用 worker worktree で準備中。本番には未適用。
- この文書は要件と承認境界の正本となるレビュー用資料。実装完了や本番改善を意味しない。

## 保管先と稼働版の照合（2026-10-04）

本人所有 fork `ShintaroKawakami/gbrain` の既存 `deploy/v0.60.25.0-jtt` を PR の base とする。
base は `7cb8d4e6de3bc61a0f08722bc1c8073f1be87a26`。upstream v0.60.25.0 に既存の5修正を重ねた版であり、
古い v0.47.9.0 の default `master` へアップグレードを混ぜない。今回の feature は既存5修正を維持する。

Mac mini checkout の branch/head はこの base と一致した。稼働インストールの `src/cli.ts`、
`src/mcp/dispatch.ts`、`src/core/engine-sql/links.ts`、`src/core/link-extraction.ts`、
`src/core/pglite-engine.ts`、`src/core/postgres-engine.ts` の SHA-256 も base と6件とも一致した。

stable Hub と Mac mini の `mac-mini-mcp-autodeploy.sh` は現時点で `GBRAIN_REPO_BRANCH="master"` を固定し、
配備時に `apply-migrations --yes --non-interactive` を実行する。webhook の対象 branch も master。
この経路で deploy branch の merge が直接配備を起こす証拠はないが、他の自動更新経路まで否定できていないため、
本番移行の承認前は fork 内の draft PR までとし、deploy branch への merge は保留する。

実 Postgres の既存隔離 fixture は `test/helpers/persistence-postgres.ts`。
Studio の PostgreSQL 15 は vector extension がなく、default Docker daemon も停止していたが、
既存の `colima-mixpost` daemon は利用可能だった。global context や他 PJ の container/volume を変えず、
既存 CI と同じ `pgvector/pgvector:pg16` の専用一時 container を CPU 1・メモリ 1 GiB・localhost のみで作成した。
本番 DSN は未使用。既存 base の `managed-maintenance.test.ts` はこの実 Postgres で21件成功、0件失敗。
変更後の row-lock/publication race の結果とは区別し、検証終了時にはこの一時 container を削除する。

## 途中版の独立検証（完成判定ではない）

統合 commit `43e55c816` で、新規2ファイルと既存4ファイルを同一 Bun process で実行した。
隔離した HOME / GBRAIN_HOME と TMPDIR=/tmp では49件中48件成功、1件失敗（345 assertions、40.17秒）。
失敗は合成 fixture が `fact_withdrawals` に存在しない `id` をSELECTしたもの。追補で修正する。
MCP実行時にあった19件のEPERMはこの条件では再現しなかったが、ambient HOMEとの違いの原因は未確定。
最終 commit で新旧まとめ試験をやり直すまで完成とはしない。

旧版互換は手書きの条件式fixtureと分けて確認した。実際の v0.60.25.0
(`a4c5ea3c99d41fa601f48c0cc5d73b4adea3b873`) の `acceptProposal`、`listPendingProposals`、
`prepareMaintenanceMutation` を新schema184の合成PGLiteへ直接接続した。
world/private × 新status4種 × receipt有無の16ケースで旧acceptは全件拒否し、旧一覧には0件、
新intentは `Unsupported maintenance request` で拒否した。takes と persistence_requests の新規行は0件。
これは旧版の実関数を使った証明であり、旧consumer daemon全体の再起動試験とは区別する。
