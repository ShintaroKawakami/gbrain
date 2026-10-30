import type { Migration } from './types.ts';

// JTT entityless review: evidence column + evidence_* statuses on take_proposals.
// Renumbered v184 -> v200 (v0.60.45.0 fork) -> v239 (v0.60.175.0 fork) -> v250 (v0.60.268.0)
// -> v263 (v0.60.324.0) -> v270 (v0.60.426.0) -> v279 (v0.60.474.0) -> v280 (v0.60.498.0): upstream owns v250-v279. Brains stamped
// version=279 by the JTT v279 must be re-stamped to 278 before migrating so upstream
// v279 runs; it and this v280 are idempotent (ADD COLUMN IF NOT EXISTS / DROP+ADD constraint).
// Receipt DDL is NOT rebundled here — upstream v184 already applies it.
export const v280: Migration = {
  version: 280,
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
