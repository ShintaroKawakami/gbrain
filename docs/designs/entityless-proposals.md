# Entityless fact review queue — bounded prototype

基準は **production v0.60.25.0** に既存の5つの JTT patch と entityless pending prototype を重ねた状態。類似度はレビュー候補を作るためだけに使い、同じ人物・主体だとは判定しない。矛盾は未検証として明示する。元の fact 行は変更しない。

## nightly opt-in と境界

- 既定は off。nightly runner が `gbrain dream --source <id>` または `--source-id <id>` を渡した場合だけ、`dream.consolidate.entityless.<source-id>` を読む。env、path、default source、`__all__` からは有効化しない。key がない場合は通常の dream cycle のまま。
- 既存の一般 config CLI で明示的に有効化する。現在の source incarnation と target slug を入れる:

  ```sh
  gbrain config set 'dream.consolidate.entityless.<source-id>' '{"source_incarnation":"<current-source-incarnation>","target_slug":"<target-slug>"}'
  ```

  停止は `gbrain config unset 'dream.consolidate.entityless.<source-id>'`。値は JSON object で、許可する key は `source_incarnation` と `target_slug` の2つだけ。両方 nonblank とし、incarnation が現行 source と一致しない場合は cycle の開始前に失敗する。
- `--entityless-proposal-target <slug>` は source config より優先する。この flag は単独の `--phase consolidate --source <id>` に限る。config opt-in は既存の全体 nightly cycle にも適用される。
- schedule、config writer、service、通知、proposal の自動 accept は追加しない。private evidence はローカル CLI のみで扱い、公開 accept を拒否する。提案は `evidence_*` status のまま保持し、legacy `pending` / `accepted` に変換しない。
- producer は指定 source の active incarnation と visibility ごとに候補を分ける。keyset scan は古い singleton / embedding 欠落の100件を越えて reviewable cluster を探す。各 scan window は最大100 fact で、各 proposal evidence も最大100 fact。target と fact の source-scoped revision / snapshot を固定する。

## 進捗、retry、再レビュー

- proposal evidence を進捗記録として使う。変更のない `evidence_accepted` / `evidence_rejected` は target revision が変わっても covered。`evidence_pending` は target revision が変わると新しい proposal を作る。
- group 内の1 fact が変わると、その全 snapshot が一致しなくなるため元 group 全体を再候補化する。target が新規作成・更新された場合、pending group は新しい revision-bound proposal になる。
- durable acceptance の pending/running と committed receipt は再利用する。terminal failed/conflict は次の acceptance 呼び出しで新しい attempt ID を使うため、同じ proposal を再試行できる。receipt lookup が失敗したときは状態不明として `evidence_accepting` を維持する。
- finite `valid_until` を持つ fact はローカル候補になり得るが accept 時に拒否する。accept は元 fact の validity、supersession、withdrawal、source incarnation、target revision を確認する。durable admission 後と publication transaction 内でも再確認し、競合時は publication 全体を rollback する。
- scan は cursor table を追加せず keyset で進む。proposal が作られない singleton は covered にならないため、後続 run でも走査対象になる。過去 evidence row の比較コストは蓄積に応じて増える。

## Migration と production approval

- v184 は upstream commit `109b992172e1f49107f9de9841758c1d043a2668` の `ai/decide/schema.ts` にある RLS helper と `DECIDE_RECEIPTS_SCHEMA_SQL` をそのまま含む。calibration / proposal DDL と AI behavior は含めない。constant の SHA-256 は **`52fbd2953179f3124604362c4c2cd200349d5e45a14bc5866a41fafe537fd9bb`**（upstream full file ではなく、この migration 内の評価済み `DECIDE_RECEIPTS_SCHEMA_SQL` template value の hash）。
- 同じ v184 transaction で entityless 用 `take_proposals.evidence` 列と `evidence_*` status を追加する。receipt schema は `decision_receipts` / `decide_spend` / `decide_state` の3 table と4 index。元 fact や既存 proposal status は書き換えない。
- production rollout には v184 の combined DDL（receipt tables / indexes と entityless evidence column / statuses）への明示承認が必要。per-source config opt-in は別の判断で、migration だけでは producer は動かない。production migration、activation、accept、private evidence の publication はこの準備では行わない。
- rollback は旧 code に戻し、対象 source の config key を unset して新規 producer を停止する。down migration や proposal status の書き換えはしない。旧 binary が新 status / maintenance intent を認識しない可能性があり、既存 evidence は保持する。
- PostgreSQL test は v184 ledger からの replay と代表的な後続185/186 DDL を確認する。実 upstream 185/186 source はこの worktree に含まれないため、その exact SQL の互換性は別途確認が必要。upstream 187–196 の import DDL 確認も別 review scope。

## 検証と limitation

- 合成 tests は PGLite、acceptance / migration tests は `testBackends()` によって isolated PGLite と明示された test-named PostgreSQL DB を対象にする。fixtures は synthetic fact と source/page のみ。
- `oldBinaryAcceptFixture` / `oldBinaryMaintenanceFixture` は v0.60.25.0 の分岐から手動抽出した predicate fixture であり、旧 binary の実 module を呼び出す証拠ではない。
- top-level CLI validator の生成済み flag registry はこの変更範囲外。nightly path は汎用 `config set` を使い、`runDream` parser では explicit flag precedence を確認するが、flag が top-level validator に登録済みかはこの worktree の変更で保証しない。
