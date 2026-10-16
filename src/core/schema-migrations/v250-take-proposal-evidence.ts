import type { Migration } from './types.ts';

// JTT entityless review: evidence column + evidence_* statuses on take_proposals.
// Renumbered v184 -> v200 (v0.60.45.0 fork) -> v239 (v0.60.175.0 fork) -> v250 (v0.60.268.0):
// upstream owns v239-v249. Brains stamped version=239 by the old JTT v239 must be
// re-stamped to 238 before migrating so upstream v239..v249 run; all of them and this
// v250 are idempotent (ADD COLUMN IF NOT EXISTS / DROP+ADD constraint).
// Receipt DDL is NOT rebundled here — upstream v184 already applies it.
export const v250: Migration = {
  version: 250,
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
