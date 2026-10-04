import type { Migration } from './types.ts';

// JTT entityless review: evidence column + evidence_* statuses on take_proposals.
// Renumbered from deploy/v0.60.25.0-jtt v184-take-proposal-evidence because upstream
// v0.60.45.0 already occupies v184–v199 (decision_receipts through chronicle-page-state).
// Receipt DDL is NOT rebundled here — upstream v184 already applies it.
export const v200: Migration = {
  version: 200,
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
