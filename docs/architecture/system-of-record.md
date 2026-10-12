# System of record

**Canonical Markdown and frontmatter are the system of record for file-backed
knowledge. Their database indexes can be rebuilt from those files. DB-only
knowledge and operational state still need a separate backup.**

This document is the canonical reference for that contract. Every code
path that writes user-knowledge state should match the pattern
described here. The CI gate at `scripts/check-system-of-record.sh`
enforces it programmatically.

## Why this matters

Much of the DB is a derived index over the markdown content. It exists to make
search fast, to dedup embedding-similar claims, to materialize the
cross-page graph. `gbrain sync && gbrain extract all` rebuilds the indexes
represented by intact Markdown; it does not recover DB-only knowledge,
credentials, page revision history, durable receipts, or the authoritative
withdrawal ledger. Preserve those records in a database backup.

This means:

- **Disaster recovery is a short, boring sequence.** If your DB volume
  corrupts, if Postgres eats itself, if PGLite's WASM lock wedges — you
  first verify your backups and which state exists only in the database.
  After preserving that state, you can wipe derived tables (on PGLite,
  `gbrain reinit-pglite` wipes the whole embedded DB), re-import from
  your brain repo with `gbrain sync`, and `gbrain extract all`
  regenerates the derived state. See "Disaster recovery" below for the
  exact commands.
- **Multi-machine sync is git.** Your brain is a repo. Push from one
  machine, pull from another, and the second machine's DB rebuilds on
  its next sync. This does not transfer DB-only state or gitignored files.
- **Privacy is in your hands.** Sensitive entity pages can be
  gitignored (via `gbrain.yml` `db_only` paths or per-page) and they
  stay on disk but not in git. The fence respects whatever git
  tracking choice you make at the page level.
- **Cross-agent collaboration is coordinated.** Multiple authenticated servers
  can accept writes against shared Postgres. Each canonical worktree has one
  designated publishing host; revision checks prevent stale replacements and
  durable receipts let callers inspect or replay accepted requests. Git still
  carries files between independent brains.

## The three categories

Use these categories to distinguish reconstructible file-backed records
from state that needs a database backup. A table can contain both: the
facts table, for example, also holds unresolved facts without a fence.

### FS-canonical (markdown is the source of truth)

For knowledge preserved in canonical files, the DB row is a derived index
over the Markdown. Reconciliation rebuilds the represented fields; it does
not promise identical database rows or recover records absent from the files.
The CI gate constrains direct DB writes to the documented paths.

| Category | How it's stored in markdown | Derived DB table | Reconciler |
|---|---|---|---|
| **Takes** (incl. hunches, bets) | `## Takes` fenced table between `<!--- gbrain:takes:begin -->` / `:end -->` markers | `takes` | `extract takes` |
| **Facts** | `## Facts` fenced table between `<!--- gbrain:facts:begin -->` / `:end -->` markers | `facts` | `extract_facts` cycle phase |
| **Links** | Inline `[text](slug)` / `[[slug]]` in markdown body + frontmatter `direction: incoming` | `links` | `extract links` |
| **Timeline** | Dated markers anywhere in the page body — compiled truth AND the `## Timeline` section: `- **YYYY-MM-DD** \| Source — Summary` bullets, `### YYYY-MM-DD — Title` headers (FS extract), and inline `[Source: <text>, YYYY-MM-DD]` citations (one row per citation, dated by the citation, summary = the bullet/paragraph it sits in). The `<!-- timeline -->` sentinel only splits compiled_truth from timeline for storage; it does not scope extraction | `timeline_entries` | `extract timeline` + canonical page publication (independent of `auto_timeline`) |
| **Tags** | Frontmatter `tags:` YAML array | `tags` | `importFromFile` (reconciles per-page on import) |
| **emotional_weight** | Recomputed from takes + tags | `pages.emotional_weight` (signal column) | `recompute_emotional_weight` cycle phase |
| **synthesis_evidence** | FK into `takes` rows (`slug#N`) inside synthesis pages | `synthesis_evidence` | `extract takes` (transitively) |

### Derived from FS but not user-authored

These hold derived state that's automatically reconstructible from the
markdown but not directly authored as markdown by the user. The
chunker + embedder rebuild these on import.

| Table | Source | Notes |
|---|---|---|
| `pages` | The markdown file as a whole | One row per file; `compiled_truth` + `frontmatter` come from parse |
| `content_chunks` | `pages.compiled_truth` after chunker strip | Re-chunked on content_hash change; embedded via configured model |
| `page_versions` | Each `pages` UPDATE | Audit history; rebuildable in principle but not in practice |

### DB-only by design (named exceptions)

These hold runtime or infrastructure state intentionally kept outside the
repo. This list does not cover every DB-only record: pages and facts can
also contain knowledge absent from canonical files and must be backed up.

| Category | Why it's OK to be DB-only |
|---|---|
| `raw_data` | Webhook/transcript sidecars; not user-authored knowledge. |
| `subagent_messages` / `subagent_tool_executions` / `subagent_rate_leases` | Runtime job state. Replay-only, not persistent knowledge. |
| `oauth_clients` / `oauth_tokens` / `access_tokens` | Credentials. Not in source control by definition. |
| `mcp_request_log` | Audit trail. Volatile by design. |
| `minion_jobs` / `minion_inbox` / `minion_attachments` | Job queue. Restarts re-enqueue or drop. |
| `eval_candidates` / `eval_capture_failures` | Contributor-mode dev loop; opt-in capture. |
| `dream_verdicts` | Scored triage cache (salience score, quotes, entities, judging model + prompt version). Rows carry a 30-day `expires_at` TTL: reads treat expired rows as misses and the synthesize phase sweeps them, so nothing lives forever. Rebuildable via `gbrain dream retriage --force`. |
| `gbrain_cycle_locks` / migration ledger | Infrastructure. |
| `op_checkpoint_paths` | Sync-resume checkpoint. Append-only progress banking; a completed sync makes it irrelevant. |
| `config` (some keys) | Site-local routing config (e.g. `sync.repo_path`). |
| Withdrawal ledger and page overlays | Authoritative withdrawal decisions must survive stale imports and owner downtime. Markdown mirrors can lag. |
| Mutation journal, receipts, outbox, ownership and local registrations | Durable replay identity, publication recovery and authorization cannot be rebuilt from Markdown. |

A new derived table that holds user-knowledge MUST land FS-first.
If you're tempted to add one as "DB-only for now," the structural
question is: does it belong in this DB-only-by-design list? If not,
it's FS-canonical and needs a fence (or frontmatter field) plus a
reconciler.

## Page-write persistence boundary

Page mutations first admit a durable request scoped to the authenticated
principal. Existing-page replacements require the caller's observed revision
or explicit `force`; omitting both permits creation only when absent. Repeating
the same UUID and intent returns the stored outcome without executing terminal
work again. Preconditions are checked before no-op detection.

The designated owner prepares outside publication locks, reserves recovery
space, then takes the native worktree lock and rechecks authority, identity,
revision and file bytes. It records recovery data before flushing and atomically
replacing the file. Canonical projections, tags, aliases, complete version
history, the terminal receipt and postpublication effects commit together in
the database. An ordinary rejected file write rolls that transaction back.

A committed receipt identifies durable canonical state. Lock contention or
owner downtime leaves accepted work queued; after the synchronous wait (5 s for
agents, 30 s for the CLI, `--wait <seconds>` to change it), `write_pending`
includes the UUID and one-second retry guidance, and the CLI exits 10
([exit status](../protocol/MEMORY_VERBS_v1.md#cli-exit-status-for-writes)). An
uncertain publication stays `recovering` and blocks its worktree until resolved.
Recovery restores prior bytes only when the file still matches the recorded
attempt. Unexpected bytes require explicit repair. Direct filesystem readers
can observe the file/database publication interval.

Page reads return content, tags, withdrawal overlays and revision from one
database snapshot. A read begun after commitment observes that revision or a
later one. Embeddings and Git completion have separate, retryable effect states;
embedding installation checks the captured page/chunk/text/indexing context and
cannot invalidate a committed page. Search excludes unsealed text projections
until a worker rebuilds them. See [concurrent writes](../guides/concurrent-writes.md)
for receipts, capacity, activation and transfer commands.

The rebuild contract above applies only to knowledge actually preserved in
canonical files. DB-only pages, unresolved facts not written to a fence, audit
history, and site-local credentials are not recoverable from Markdown alone.
Keep an appropriate database backup before any destructive recovery, and do
not delete historical unmatched facts or generate empty pages to make them
appear file-backed.

## Write attribution

Foundations 1 records creation attribution: who wrote each page revision,
page version, fact, take and timeline row. It does not yet attribute every
write. BEFORE ROW triggers copy three transaction-local settings into the row
(`persistence/attribution-schema.ts`). `withCoordinatedWrite` sets them for
journaled requests and coordinated maintenance, and `withWriteAttribution`
(through `maintenanceTransaction`) sets them for unmanaged legacy transactions. A row written outside both
scopes keeps `NULL` attribution, which reads as "unrecorded".

The stamps live in the database only (Markdown never carries them):

| Table | Columns | Meaning |
| --- | --- | --- |
| `pages` | `revision_write_request_id`, `revision_principal_kind`, `revision_principal_id` | Who wrote the live revision. |
| `page_versions` | `write_*` and `archived_*` | Who wrote the snapshotted revision, and whose write archived it. |
| `facts`, `takes`, `timeline_entries` | `write_*` and `last_write_*`, `last_written_at` | Who created the row, and who last changed its content. |

Only the request id (`persistence_requests.id`) and the principal (kind, id)
are stored. Names, operations and times are joined at read time by
`get_write_attribution` (`gbrain attribution`), an `admin` operation; see
[write attribution](../mcp/ADMIN.md#write-attribution). `get_versions` returns
attribution only to trusted local and `admin` callers. A NULL request with a
principal is a maintenance write; all NULL is `unrecorded`: written before
attribution existed or by a writer listed under "unattributed" below, so this
is creation attribution, not an audit of every write.

Nothing is inferred for older rows. `gbrain repair attribution-backfill` fills
only rows the write journal proves exactly (the page write whose recorded
result is that revision, the `remember` that inserted that fact) and leaves the
rest `unrecorded`. Attribution is not file-backed: rebuilding from Markdown
loses it, and `gbrain migrate --to` copies it verbatim only for facts (pages, takes
and timeline rows are re-created on the target and start `unrecorded`; version
history is not copied).

- **Managed brains:** creation attribution is complete. The writer guard
  refuses a canonical write outside `withCoordinatedWrite`, so a direct writer
  below either enters a coordinated path or fails before it writes.
- **Unmanaged brains:** journaled page, memory, take and timeline operations
  carry their request. These legacy transactions carry the local maintenance
  principal with `write_request_id` NULL: direct markdown, code and image
  imports (every `importFromContent` caller without `prepare`), the
  `extract_facts` page reconcile, `extract-takes` and the
  `gbrain repair stale-atoms --apply` retirement. The maintenance principal is
  the local CLI registration (`local_cli`), else this host's identity
  (`application`, `host:<id>`), else `host:unregistered`: attribution never
  creates an identity file. The direct writers listed under "unattributed"
  below still write without an actor.

Agents: treat `NULL` attribution on an unmanaged brain as "written by a legacy
maintenance path", not as evidence of tampering. To get attribution for a
writer on this list now, run the work on a managed brain or through a
journaled operation. When you add a direct writer, run it in
`maintenanceTransaction(engine, fn)` (`persistence/attribution.ts`) or route it
through the coordinator, then update these lists with the count
`test/write-attribution-legacy.test.ts` reports. The test compares both lists
with a grep of `src` for direct page, version, fact, take and timeline writers
outside the engine and schema layers. The number in parentheses is that grep's
count for the file.

Attributed (inside a request, a coordinated scope or `maintenanceTransaction`,
or a physical projection that leaves attribution untouched):

<!-- write-attribution-covered:start -->
- `src/commands/migrate-engine.ts` (5): engine copy keeps the source rows' attribution values verbatim.
- `src/core/chronicle/publish.ts` (3): Life Chronicle event generations: maintenance requests on managed brains; the unmanaged event write, retirement soft delete and retired stamp run in `maintenanceTransaction`.
- `src/core/cycle/extract-takes.ts` (2): coordinated per page on managed brains; the unmanaged batch upsert runs in `maintenanceTransaction`.
- `src/core/embed-facts.ts` (1): embedding columns only (physical projection).
- `src/core/embedding-dim-check.ts` (1): embedding columns only (physical projection).
- `src/core/facts/relink-publish.ts` (2): `relink_facts` request preparer.
- `src/core/facts/withdrawal.ts` (1): runs inside the `forget` request's coordinated write.
- `src/core/page-state/materialize.ts` (1): coordinated maintenance.
- `src/core/page-state/versions.ts` (1): `createVersion` itself; the caller's scope supplies the actor.
- `src/core/persistence/atom-maintenance.ts` (1): request preparer.
- `src/core/persistence/canonical-projections.ts` (7): fence projection inside the request's publication.
- `src/core/persistence/connector-google-receipts.ts` (2): request preparer.
- `src/core/persistence/connector-sync.ts` (2): connector publication inside `withCoordinatedWrite`.
- `src/core/persistence/derived-facts.ts` (1): `withDerivedFactsWrite` (managed derived facts).
- `src/core/persistence/facts-prepare.ts` (3): managed `extract_facts` request preparer.
- `src/core/persistence/grandfather.ts` (2): request preparer.
- `src/core/persistence/links-maintenance.ts` (1): coordinated maintenance.
- `src/core/persistence/loop-fact-retirement.ts` (1): request preparer.
- `src/core/persistence/memory-mutations.ts` (1): `forget` inside its request's coordinated write.
- `src/core/persistence/memory-prepare.ts` (3): `remember` request preparer.
- `src/core/persistence/page-prepare.ts` (6): page request preparer.
- `src/core/persistence/prepared-maintenance.ts` (4): managed maintenance request preparer.
- `src/core/persistence/semantic-pages.ts` (1): `add_timeline_entry` request preparer.
- `src/core/persistence/sync-prepare.ts` (4): managed sync request preparer.
- `src/core/persistence/takes-prepare.ts` (3): takes request preparer.
- `src/core/repair/stale-atoms.ts` (3): a request on managed brains; the unmanaged retirement runs in `maintenanceTransaction`.
<!-- write-attribution-covered:end -->

Unattributed until Foundations 2 mutation attribution (on unmanaged brains
these write with `NULL` attribution):

<!-- write-attribution-unattributed:start -->
- `src/commands/extract-conversation-facts.ts` (3): the conversation fact index calls the engine directly through `writeDerivedFacts`.
- `src/commands/extract-timeline-db.ts` (2): `gbrain extract timeline --source db` batch insert.
- `src/commands/extract.ts` (4): `gbrain extract` timeline walks (file, incremental, stale) and the per-entry fallback.
- `src/commands/sync/renames.ts` (1): legacy sync rename (`updateSlug`).
- `src/core/calibration/undo-wave.ts` (1): calibration wave undo of take resolutions.
- `src/core/company-brain/profile.ts` (1): company-brain sync soft deletes.
- `src/core/cycle/dream-provenance.ts` (1): dream provenance frontmatter stamp.
- `src/core/cycle/drift.ts` (1): drift report page.
- `src/core/cycle/extract-atoms-page-state.ts` (1): atom extraction frontmatter stamp.
- `src/core/cycle/extract-atoms.ts` (1): soft delete of stale atoms.
- `src/core/cycle/extract-facts.ts` (7): remaining site: expiry of fence facts whose page was soft-deleted. The page reconcile is attributed.
- `src/core/cycle/grade-takes.ts` (1): take resolution.
- `src/core/cycle/phantom-redirect.ts` (3): fact move, phantom page body refresh and soft delete.
- `src/core/cycle/phases/consolidate.ts` (4): consolidation takes and fact updates.
- `src/core/cycle/synthesize.ts` (1): synthesis summary page.
- `src/core/enrichment-service.ts` (2): enrichment page and auto-timeline entry.
- `src/core/extract-timeline-from-meetings.ts` (1): meeting timeline batch.
- `src/core/extract/receipt-writer.ts` (1): extraction receipt page.
- `src/core/facts/backstop.ts` (3): legacy DB-only fact fallbacks.
- `src/core/facts/fence-write.ts` (2): markdown-first fence reconcile insert and page body refresh.
- `src/core/facts/forget.ts` (4): legacy forget expiry and fence strike-through.
- `src/core/facts/proposal-supersede.ts` (4): unmanaged `decide` proposal accept and undo (facts and page body).
- `src/core/facts/write-single.ts` (2): legacy single-fact insert and supersession.
- `src/core/import-file.ts` (11): remaining sites: the moved-file rename (`updateSlug`) and the #3694 legacy-hash re-stamp of an unchanged body. Direct import writes are attributed.
- `src/core/minions/handlers/ingest-capture.ts` (1): capture ingest soft delete.
- `src/core/ops/extraction.ts` (2): extraction review promote (frontmatter) and reject (soft delete).
- `src/core/output/writer.ts` (4): synthesize-phase BrainWriter pages and timeline.
- `src/core/page-state/rename-alias.ts` (2): fact slug rewrite on rename.
- `src/core/repair/captured-facts.ts` (1): unmanaged captured-facts expiry.
- `src/core/repair/extractor-facts.ts` (1): extractor-facts repair update.
- `src/core/schema-pack/page-to-alias.ts` (1): page-to-alias conversion soft delete.
- `src/core/schema-pack/page-to-link.ts` (1): page-to-link conversion soft delete.
- `src/core/schema-pack/retype.ts` (1): schema-pack retype.
- `src/core/schema-pack/sync.ts` (1): schema-pack type sync.
- `src/core/sweep.ts` (1): sweep timeline batch.
- `src/core/takes-write.ts` (7): legacy takes file helper mirror rows and resolutions.
- `src/core/think/index.ts` (1): saved `think` result page.
- `src/core/timeline-dedup-repair.ts` (1): timeline dedup repair.
- `src/core/timeline-write-through.ts` (2): timeline write-through entry and page timeline.
<!-- write-attribution-unattributed:end -->

## The privacy boundary

Private knowledge in a fence still lives in the markdown file. If the
user commits the page to git, the private data lands in git too. This
is the existing operational model — we don't infer git policy.

For untrusted readers (remote MCP, subagent), gbrain applies a 3-layer
strip:

1. **Layer A (chunker):** `src/core/chunkers/recursive.ts` calls
   `stripFactsFence({keepVisibility: ['world']})` + `stripTakesFence`
   before chunking. Private fact text never reaches
   `content_chunks.chunk_text`, embeddings, or search results.
2. **Layer B (get_page):** when `ctx.remote === true`, the response
   body has both fences stripped (private rows from facts; entire
   takes fence). Local CLI (`ctx.remote === false`) sees the full
   fence.
3. **Layer C (git tracking):** the user decides whether to commit the
   entity page. `gbrain.yml` `db_only` paths are gitignored
   automatically; per-page choices via the user's normal git workflow.

For universally-private entities (a friend's name, an investor's
internal notes), mark the entity page's directory as `db_only` in
`gbrain.yml`. The file stays on disk but never lands in git.

## The forget contract

`gbrain forget <id>` and the MCP `forget_fact` operation commit withdrawal to
the authoritative database ledger first. The transaction expires matching facts,
adds claim-fingerprint overlays, advances affected page revisions and invalidates
their retrieval projections. No filesystem owner is required. Stale imports and
delayed embedding work cannot undo the withdrawal.

The owner later mirrors the current logical snapshot into Markdown, retaining
strikethrough, withdrawal dates and context for historical rows. Mirroring does
not advance the logical revision again. A failed or uncertain mirror never
reverses withdrawal; direct page snapshots apply the ledger while it is pending.

Strikethrough has two semantics distinguished by context:

- `~~claim~~` + `context: "superseded by #N"` → row was replaced by
  a newer row in the same fence
- `~~claim~~` + `context: "forgotten: <reason>"` → row was retracted
  via the forget op

Both encodings retain history in Markdown. Withdrawal removes a fact from active
memory; history, source material and private backups may remain. Editing a fence
does not erase the withdrawal ledger or promise physical erasure.

## Disaster recovery

This example is only for a database whose affected facts, takes, links and
timeline entries have been verified to exist in canonical files. Before running
the destructive commands, stop writers and verify a restorable database backup
plus source-file backups. Do not use this recipe on unresolved DB-only facts or
assume a repository backup covers gitignored files. Preserve the authoritative
withdrawal ledger and all accepted request identities. On an activated managed
brain, use the documented drained recovery procedure; direct SQL or an older
writer cannot safely replace the coordinator.

```bash
# File-backed state only: verify restorable DB + source backups before proceeding.
# Record counts for comparison; this is not a backup.
gbrain stats > /tmp/before.txt

# Wipe and rebuild — delete the derived tables (pages + content_chunks
# survive the CASCADE-safe design), then re-derive from the repo.
# On PGLite, `gbrain reinit-pglite` wipes the whole embedded DB instead.
psql -c 'DELETE FROM facts; DELETE FROM takes; DELETE FROM links; DELETE FROM timeline_entries;'
gbrain sync
gbrain extract all

# Compare file-backed counts and investigate differences; full DB parity is not promised.
gbrain stats > /tmp/after.txt
diff /tmp/before.txt /tmp/after.txt
```

The invariant E2E test at `test/e2e/system-of-record-invariant.test.ts`
proves reconstruction of its file-backed facts/takes fixture. It does not prove
recovery of DB-only knowledge, operational state, or every production database.

## Rule for new code

When you add a new user-knowledge category:

1. **Define the markdown shape.** Fence (`<!--- gbrain:NAME:begin
   --> ... :end -->` table) or frontmatter field.
2. **Build a parser** that produces structured data from markdown.
   See `src/core/fence-shared.ts` for the shared primitives.
3. **Build a writer** that round-trips: parse + edit + render produces
   byte-identical markdown for identical input.
4. **Add the engine method** that takes parsed data and stamps a
   derived table. The method gets an entry in the CI gate's
   banned-direct-call list.
5. **Add a reconciler:** a cycle phase that walks pages, parses the
   fence, and rebuilds the derived table from scratch. The reconciler
   is the only legitimate call site for the engine method;
   `// gbrain-allow-direct-insert: <reason>` annotates it explicitly.
6. **Add a round-trip test** in `test/e2e/system-of-record-invariant.test.ts`
   that proves DELETE + reconcile rebuilds the table byte-identically.

The CI gate at `scripts/check-system-of-record.sh` fails any PR that
adds a new direct call to a derived-table writer outside the
reconciler / migration layer without the explicit allow-list comment.

## Related

- `skills/migrations/v0.32.2.md` — the agent-facing migration guide
- `CHANGELOG.md` — release history
- `scripts/check-system-of-record.sh` — the CI gate that enforces
  the rule
