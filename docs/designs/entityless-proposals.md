# Entityless fact review queue — recommendation

**Recommendation: approve the additive schema and local review behavior for a later release.** Code and synthetic isolated PGLite test cases are prepared; local execution is blocked because the installed runtime lacks `@ai-sdk/provider-utils`. No production migration or activation has occurred.

基準バージョンは **v0.60.25.0**。候補の同一性は evidence v1 の canonical JSON に対する SHA-256 で固定する。類似度はレビュー候補を作るためだけに使い、同じ人物・主体だとは判定しない。矛盾も未検証として明示する。

## 承認対象

- migration v184 は `take_proposals.evidence JSONB` を1列追加し、status CHECK に `evidence_pending` / `evidence_accepting` / `evidence_accepted` / `evidence_rejected` を追加する。既存行の `evidence` は NULL のままなので、従来の pending / accepted 動作を保つ。`dedup_against_fence_rows` は既存の take fence snapshot 用として維持する。
- review producer は内部の `runPhaseConsolidate` に明示的な source と非空 target slug が渡された場合だけ動作する。CLI flag、cron、通常の cycle からは有効化しない。source 内の最大100件を読み、world/private を別々に候補化する。候補には source incarnation、全 fact ID と完全な意味・由来 snapshot、visibility、target の proposal 時 revision を保存する。missing target も pending にできるが、accept は `target_not_ready` で拒否し、target を作成後に新しい revision を記録した proposal が必要。
- proposal 作成も accept も source facts を更新しない。accept は明示的なローカル操作で world evidence のみを対象にし、target revision・source incarnation・全 evidence fact・withdrawal・TTL を確認する。公開トランザクション内でも再確認し、候補 fact が変化した場合は take publication 全体を rollback する。accept は take claim を承認する操作であり、entity/person の割当てではない。
- private evidence はローカル CLI の明示的な review queue でのみ表示できる。private proposal の accept は status CAS より前に拒否する。MCP、通知、remote publication は追加しない。
- evidence proposal は旧 `pending` / `accepted` を使わず、専用 status のまま遷移する。publication は `managed_maintenance_entityless_proposal_accept` intent を使う。旧 consumer は未知 intent を拒否し、旧 accept は evidence status を受け付けないため、旧 binary への暗黙の downgrade を作らない。

## 検証と復帰

追加したテストは合成 fact を使う実 PGLite と実 migration を対象にし、cross-source、private/world 分離、target 未作成、source fact 不変、stale revision / TTL / withdrawal、publication 中の再検証、accept replay、legacy proposal、旧 accept / consumer の拒否を確認する。外部 DB URL、production DB、LLM、追加依存は使わない。

復帰する場合は最初に新 producer を停止する。その後、新 status の evidence proposal を review 状態のまま quarantine または reject し、`pending` / `accepted` に変換しない。新 status と未知 intent は旧 binary に拒否される。事実を削除・declassify せず、schema column は別途明示承認されるまで保持する。schema migration、release、production での有効化は operator の最終承認事項。
