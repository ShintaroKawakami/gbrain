import type { Migration } from './types.ts';

// JTT entityless review: evidence column + evidence_* statuses on take_proposals.
// Renumbered v184 -> v200 (deploy/v0.60.45.0-jtt) -> v239 (v0.60.175.0 sync): upstream
// owns v184-v238 (v200 = sync_hold_page_index). Brains stamped version=200 by the JTT
// v200 must be re-stamped to 199 before migrating so upstream v200..v238 and this v239 run;
// every step from v200 on is idempotent (see docs/designs/entityless-review-plan.md).
// Receipt DDL is NOT rebundled here — upstream v184 already applies it.
export const v239: Migration = {
  version: 239,
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
