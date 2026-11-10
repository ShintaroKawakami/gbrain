import type { Migration } from './types.ts';

// JTT entityless review: evidence column + evidence_* statuses on take_proposals.
// Renumbered v184 -> v200 (v0.60.45.0 fork) -> v239 (v0.60.175.0 fork) -> v250 (v0.60.268.0)
// -> v263 (v0.60.324.0) -> v270 (v0.60.426.0) -> v279 (v0.60.474.0) -> v280 (v0.60.498.0) -> v281 (v0.60.528.0) -> v282 (v0.60.531.0) -> v287 (v0.60.574.0) -> v290 (v0.60.584.0) -> v296 (v0.60.609.0) -> v298 (v0.60.641.0): upstream owns v250-v297.
// Brains stamped version=296 by the JTT v296 must be re-stamped to 295 before migrating
// so upstream v296 (ingest_applied_captures) and v297 (chronicle_judge_window) run.
// runMigrations does that rewind automatically when take_proposals.evidence exists
// and ingest_applied_captures does not. This v298 is idempotent (ADD COLUMN IF NOT
// EXISTS / DROP+ADD constraint) so an already-applied JTT evidence column is a no-op.
// Receipt DDL is NOT rebundled here — upstream v184 already applies it.
export const v298: Migration = {
  version: 298,
  name: 'take_proposal_evidence',
  idempotent: true,
  sql: `
      ALTER TABLE take_proposals ADD COLUMN IF NOT EXISTS evidence JSONB;
      ALTER TABLE take_proposals DROP CONSTRAINT IF EXISTS take_proposals_status_check;
      ALTER TABLE take_proposals ADD CONSTRAINT take_proposals_status_check
        CHECK (status IN ('pending','accepted','rejected','superseded',
          'evidence_pending','evidence_accepting','evidence_accepted','evidence_rejected'));
    `,
};
