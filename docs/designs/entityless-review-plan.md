# 名前を割り当てず、記憶を確認待ちへ整理する

2026-10-04 / 本番適用前のレビュー用資料

## 推奨

entity が未指定の記憶は、既存の `take_proposals` に確認待ちの候補としてまとめる。
似た文章だけで同じ人物・案件の事実とは決めない。元の facts は書き換えない。
world の候補だけ、利用者が明示的に採用した後、指定した同じ source のページへ追加する。
private の候補は local CLI の確認用にとどめ、採用して take にする操作は拒否する。

この案で実現するのは「夜間の候補整理と、根拠を見た採否」であり、無人で事実を確定することではない。
private facts を ChatGPT から読めるようにする変更は含まない。

本番反映では、evidence 列・4状態の追加に加え、将来の上流更新を壊さないため
上流184の3空テーブル・4 index・条件付きRLSも同時に適用する。
対象は `shintaro-gbrain`、新しい整理先案は `notes/memory-review`。本番移行・ページ作成・有効化は未実行。

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

schema の正本と登録・両 engine 用生成物は既存 generator で揃える。
同じ184 migrationに上流の `decision_receipts` / `decide_spend` / `decide_state` を含める。
3空テーブル・4 index・条件付きRLSの追加も本番承認の範囲とする。詳しい理由と出典は後述。

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

コード・合成試験・レビューを完了した後に、次の3点をまとめて提示する。

1. evidence 列・4状態と、上流184互換の3空テーブル・4 index・条件付きRLSを含む本番 migration。
2. `shintaro-gbrain` の専用整理先 `notes/memory-review` の作成。同名ページがlocalに存在すれば上書きしない。
3. source incarnationを指定した既存configの設定による夜間候補生成の有効化。自動採用はしない。

既存 facts の一括分類、公開範囲の変更、owner claim は含めない。

## 止め方と戻し方

最初に対象sourceのconfig keyをunsetし、新候補作成を止める。進行中の publication を確認し、既存の処理手順で安全に収束させる。
旧版の実関数は新 status と新 intent kind を拒否することを確認する。
これは旧consumer daemon全体の再起動や全面rollbackの保証とは区別する。
evidence 列・status CHECK を勝手に削除せず、未確認候補を旧 pending に変換しない。
元 facts は不変なので復元移行は不要。採用済み take を戻す必要がある場合は、その個別の採否として扱い、元の記憶を削除しない。

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

## 検証結果と残っている確認

`0c54e699d` では、隔離HOMEで新旧9ファイル99件が成功し、実PostgreSQL16では採用・migration・既存maintenanceの32件が成功した。
型検査とschema/registry生成物の鮮度確認も成功。実際の上流185/186 DDLを適用して根拠を保持する試験を含む。
同じheadの旧版実関数16ケースはPGLite/実PostgreSQL双方で採用拒否・旧一覧0件・新規take/request0件を確認した。
旧版consumer daemon全体の再起動試験とは区別する。

全体レビューでREALの丸めと既存2件候補の再生成に問題を見つけ、補修中。
最終headで関係試験・全体レビュー・実装監査を揃えるまで完成とはしない。
worker内の環境では既存19件がEPERMで失敗した。成功したhost隔離試験と区別し、未実施を成功扱いしない。

## 本番反映案の具体化（まだ未実行）

対象は `shintaro-gbrain`、専用の整理先案は `notes/memory-review`。
既存の人物ページへ割り当てず、承認後に専用ページを作成する。
remote の完全一致読取では `page_not_found` だったが、private同名の不存在は未証明。
承認後の作成直前にlocal経路でも確認し、同名ページがあれば上書きしない。
既存 DB config の `dream.consolidate.entityless.shintaro-gbrain` に
`{"source_incarnation":"<現在のsource incarnation>","target_slug":"notes/memory-review"}` を設定する案。
未設定なら無効。設定を unset すれば翌回以降の候補生成を止められる。
既存の夜間処理から候補だけを作り、採用は別の明示的な local 操作とする。自動採用はしない。

上流の migration は `config.version` の整数で管理され、名前・checksum の適用台帳はない。
今回の184だけを適用すると、上流184 `decision_receipts` の処理が将来skipされるため、そのまま配備しない。
最小案は上流184の原文DDLを同じ184に含め、その後で evidence列とstatus制約を追加すること。
本番承認の範囲には、空の `decision_receipts` / `decide_spend` / `decide_state` の3テーブル、
4 index、上流と同じ条件付きRLS有効化も含める。番号を大きく進める独自台帳は追加しない。

出典は upstream commit `109b992172e1f49107f9de9841758c1d043a2668`。
`v184-decision-receipts.ts` のSHA-256は `b1c8efd66c0b8e7a2032d39a27f3bd4d9912d0df6f011a9230c3f6569f22210e`、
`src/core/ai/decide/schema.ts` 全文のSHA-256は `377b8c17a2baebb5bef5ce289826ead5045af776c634994a1539157eeb75e09b`。
上流185〜196と相対import先のDDLを静的に確認し、take_proposalsのevidence列・status制約を書き換える経路は見つからなかった。
これは連続migration実行の成功証拠とは区別する。183→今回184→後続migrationの合成試験は最終実装で記録する。
