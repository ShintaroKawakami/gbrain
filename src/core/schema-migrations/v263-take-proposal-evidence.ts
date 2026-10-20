import type { Migration } from './types.ts';

// JTT entityless review: evidence column + evidence_* statuses on take_proposals.
// Renumbered v184 -> v200 (v0.60.45.0 fork) -> v239 (v0.60.175.0 fork) -> v250 (v0.60.268.0)
// -> v263 (v0.60.324.0): upstream owns v250-v262. Brains stamped version=250 by the JTT v250
// must be re-stamped to 249 before migrating so upstream v250..v262 run; all of them and this
// v263 are idempotent (ADD COLUMN IF NOT EXISTS / DROP+ADD constraint).
// Receipt DDL is NOT rebundled here — upstream v184 already applies it.
export const v263: Migration = {
  version: 263,
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
