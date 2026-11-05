import type { Migration } from './types.ts';

// JTT entityless review: evidence column + evidence_* statuses on take_proposals.
// Renumbered v184 -> v200 (v0.60.45.0 fork) -> v239 (v0.60.175.0 fork) -> v250 (v0.60.268.0)
// -> v263 (v0.60.324.0) -> v270 (v0.60.426.0) -> v279 (v0.60.474.0) -> v280 (v0.60.498.0) -> v281 (v0.60.528.0) -> v282 (v0.60.531.0) -> v287 (v0.60.574.0): upstream owns v250-v286. Brains stamped
// version=282 by the JTT v282 must be re-stamped to 281 before migrating so upstream
// v282-v286 run; they and this v287 are idempotent (ADD COLUMN IF NOT EXISTS / DROP+ADD constraint).
// Receipt DDL is NOT rebundled here — upstream v184 already applies it.
export const v287: Migration = {
  version: 287,
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
