import type { Migration } from './types.ts';

// Receipt DDL copied unchanged from upstream ai/decide/schema.ts at
// 109b992172e1f49107f9de9841758c1d043a2668. The retained source surface is
// only this RLS helper and DECIDE_RECEIPTS_SCHEMA_SQL; calibration and proposal
// behavior is intentionally outside this migration.
// SHA-256 of the evaluated DECIDE_RECEIPTS_SCHEMA_SQL template value:
// 52fbd2953179f3124604362c4c2cd200349d5e45a14bc5866a41fafe537fd9bb.
const rls = (table: string) => `DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;`;

export const DECIDE_RECEIPTS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS decision_receipts (
  id                 BIGSERIAL PRIMARY KEY,
  decision_id        TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_id          TEXT,
  slot               TEXT NOT NULL,
  mode               TEXT NOT NULL,
  provider           TEXT NOT NULL,
  model_alias        TEXT,
  model_resolved     TEXT,
  question_kind      TEXT,
  state_hash         TEXT,
  question_hash      TEXT,
  answer_value       REAL,
  answer_choice      TEXT,
  confidence         REAL,
  threshold          REAL,
  outcome            TEXT NOT NULL,
  subject_ref        TEXT,
  call_site          TEXT NOT NULL,
  lane               TEXT NOT NULL,
  policy_fingerprint TEXT,
  calibration_ref    TEXT,
  latency_ms         INTEGER,
  input_tokens       INTEGER,
  error_reason       TEXT,
  protected          BOOLEAN NOT NULL DEFAULT false,
  min_keep           INTEGER,
  rank               INTEGER,
  k_used             INTEGER,
  remote             BOOLEAN NOT NULL DEFAULT false,
  run_meta           TEXT
);
CREATE INDEX IF NOT EXISTS decision_receipts_slot_created_idx ON decision_receipts (slot, created_at);
CREATE INDEX IF NOT EXISTS decision_receipts_model_slot_idx ON decision_receipts (model_resolved, slot);
CREATE INDEX IF NOT EXISTS decision_receipts_decision_idx ON decision_receipts (decision_id);
CREATE TABLE IF NOT EXISTS decide_spend (
  request_id     TEXT PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_id      TEXT,
  slot           TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model_resolved TEXT,
  lane           TEXT NOT NULL,
  remote         BOOLEAN NOT NULL DEFAULT false,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  cost_usd       DOUBLE PRECISION NOT NULL DEFAULT 0,
  outcome        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS decide_spend_created_idx ON decide_spend (created_at);
CREATE TABLE IF NOT EXISTS decide_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
${rls('decision_receipts')}
${rls('decide_spend')}
${rls('decide_state')}
`;

// [2026-10-04][feat] CaD: The migration ledger stores integer versions only,
// so a custom-only v184 would skip upstream's v184 receipt DDL. Include that
// original DDL here so the later upstream migrations still find its schema.
export const v184: Migration = {
  version: 184,
  name: 'take_proposal_evidence',
  idempotent: true,
  sql: `${DECIDE_RECEIPTS_SCHEMA_SQL}
      ALTER TABLE take_proposals ADD COLUMN IF NOT EXISTS evidence JSONB;
      ALTER TABLE take_proposals DROP CONSTRAINT IF EXISTS take_proposals_status_check;
      ALTER TABLE take_proposals ADD CONSTRAINT take_proposals_status_check
        CHECK (status IN ('pending','accepted','rejected','superseded',
          'evidence_pending','evidence_accepting','evidence_accepted','evidence_rejected'));
    `,
};
