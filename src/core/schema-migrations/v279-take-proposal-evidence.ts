import type { Migration } from './types.ts';

// JTT entityless review: evidence column + evidence_* statuses on take_proposals.
// Renumbered v184 -> v200 (v0.60.45.0 fork) -> v239 (v0.60.175.0 fork) -> v250 (v0.60.268.0)
// -> v263 (v0.60.324.0) -> v270 (v0.60.426.0) -> v279 (v0.60.474.0): upstream owns v250-v278. Brains stamped
// version=270 by the JTT v270 must be re-stamped to 269 before migrating so upstream
// v270..v278 run; all of them and this v279 are idempotent (ADD COLUMN IF NOT EXISTS / DROP+ADD constraint).
// Receipt DDL is NOT rebundled here — upstream v184 already applies it.
export const v279: Migration = {
  version: 279,
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
