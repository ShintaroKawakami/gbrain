# Entityless fact review queue — bounded prototype

基準バージョンは **v0.60.25.0**。この実装は既存の entityless pending prototype を狭く仕上げる準備であり、migration v184 は変更しない。類似度はレビュー候補を作るためだけに使い、同じ人物・主体だとは判定しない。矛盾は未検証として明示する。

## 実行方法と境界

- ローカル CLI の明示操作 `gbrain dream --phase consolidate --source <id> --entityless-proposal-target <slug>` だけが producer を有効にする。`--source-id` は同じ explicit-source 契約の alias。暗黙 source、`__all__`、空 target、異なる target の反復、consolidate 以外の phase は拒否し、phase 実行前に止める。同一 target の反復は許可する。`--dry-run` は候補を保存しない。flag 省略時の cycle は変わらない。
- schedule、config registry、service、通知は追加しない。private evidence はローカル review 専用で、公開 accept を拒否する。proposal は専用 `evidence_*` status のまま扱い、旧 `pending` / `accepted` に変換しない。
- producer は明示 source の active incarnation と visibility ごとに候補を分ける。fact 読み取りは最大100件、proposal evidence は最大100 fact。source incarnation、target の source-scoped revision、fact の完全な意味・由来 snapshot を保持する。missing target は pending のままにでき、target が作成された後は新しい revision-bound proposal が作られる。
- 有限 `valid_until` を持つ fact は将来の日付でもローカル review 候補になり得るが、accept 時に拒否する。accept は元 fact の `valid_until`、`valid_from`、supersession、withdrawal、source incarnation、target revision を確認する。durable admission 後と publication transaction 内で再確認し、競合時は publication 全体を rollback する。元 fact は変更しない。

## 進捗と再レビュー

- producer は既存 proposal evidence を進捗記録として使う。同じ explicit source / target revision / source incarnation で、proposal の **全 fact snapshot** が現行 fact と一致する場合に限り、その evidence の fact IDs を次の100件 window から除く。これで101件目以降を次回に処理する。
- group の1 fact が変わると、その proposal の全 evidence が一致しなくなるため元 group をもう一度候補化する。target が作成・更新された場合も古い target revision の evidence は進捗として扱わず、新しい review を作る。変更のない rejected / accepted proposal は再作成しない。
- limitation: cluster が2 fact 未満のまま proposal にならない fact は covered state を作らず、古い方から100件の選択に残り得る。また、進捗確認は該当 source / target の過去 evidence rows を読むため、長期間に大量の改訂がある場合はその読み取りコストが増える。cursor schema や追加 index は導入しない。

この worktree の top-level CLI validator は生成済み `src/core/cli-flag-registry.generated.ts` で flag を事前検証する。このファイルは許可された変更範囲外のため、この準備では `runDream` の argv parser と cycle threading までを実装した。生成済み registry に flag を追加できるまで、top-level `gbrain dream` は新 flag を unknown として拒否する。

## 検証と復帰

合成 fixture は既定の PGLite で動作し、acceptance fixture は `testBackends()` と `isolatedPersistencePostgres()` により test-named DB が明示された場合だけ使い捨て PostgreSQL DB でも実行できる。検証は100件上限と103件の二回処理、変更・不変 proposal、target revision、旧 producer との prompt-version collision、将来 TTL と publication race、source fact 不変、legacy proposal、CLI argv 境界を対象にする。

`oldBinaryAcceptFixture` / `oldBinaryMaintenanceFixture` は v0.60.25.0 の分岐から手動抽出した predicate fixture にすぎず、旧 binary の実 module を呼び出す証拠ではない。元 v0.60.25.0 の実 module を使う独立確認は別途必要。

production migration / activation / release は行わない。復帰する場合は producer を停止し、新 status の proposal を review 状態のまま quarantine または reject する。事実を削除・declassify せず、schema column は別途明示承認されるまで保持する。
