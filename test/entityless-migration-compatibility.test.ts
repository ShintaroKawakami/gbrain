import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { LATEST_VERSION, MIGRATIONS, runMigrations } from '../src/core/migrate.ts';
import { DECIDE_RECEIPTS_SCHEMA_SQL, v184 } from '../src/core/schema-migrations/v184-take-proposal-evidence.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

// The following helper and two DDL values are extracted verbatim from the
// upstream ai/decide/schema.ts source at 109b992172e1f49107f9de9841758c1d043a2668.
// SHA-256 of that full upstream source file: 377b8c17a2baebb5bef5ce289826ead5045af776c634994a1539157eeb75e09b.
const upstreamDecideRls = (table: string) => `DO $rls$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles r WHERE pg_has_role(current_user, r.oid, 'USAGE') AND (r.rolbypassrls OR r.rolsuper)) THEN
    ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
  END IF;
END $rls$;`;

const UPSTREAM_185_DECIDE_CALIBRATIONS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS decide_calibrations (
  id                  BIGSERIAL PRIMARY KEY,
  slot                TEXT NOT NULL,
  call_site           TEXT NOT NULL,
  provider            TEXT NOT NULL,
  model_resolved      TEXT NOT NULL,
  threshold           REAL NOT NULL,
  min_keep            INTEGER,
  metric              TEXT NOT NULL,
  metric_value        REAL,
  ece                 REAL,
  retest_sd           REAL,
  repack_sd           REAL,
  action_precision_lb REAL,
  qualification       TEXT,
  qualified_at        TIMESTAMPTZ,
  policy_fingerprint  TEXT,
  n                   INTEGER NOT NULL,
  dataset_hash        TEXT,
  split_hash          TEXT,
  calibrate_ids_hash  TEXT,
  calibrate_only      BOOLEAN NOT NULL DEFAULT true,
  pack_shape          TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  retired_at          TIMESTAMPTZ,
  notes               TEXT
);
CREATE INDEX IF NOT EXISTS decide_calibrations_lookup_idx ON decide_calibrations (slot, provider, model_resolved, created_at DESC);
${upstreamDecideRls('decide_calibrations')}
`;

const UPSTREAM_186_DECIDE_PROPOSALS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS decide_proposals (
  id             BIGSERIAL PRIMARY KEY,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_id      TEXT NOT NULL,
  sweep_id       TEXT NOT NULL,
  pair_index     INTEGER NOT NULL,
  new_fact_id    BIGINT NOT NULL,
  old_fact_id    BIGINT NOT NULL,
  direction      TEXT NOT NULL DEFAULT 'new_supersedes_old',
  p_supersede    REAL NOT NULL,
  threshold      REAL,
  proposal_floor REAL NOT NULL,
  model_resolved TEXT,
  status         TEXT NOT NULL DEFAULT 'pending',
  decided_at     TIMESTAMPTZ,
  before_state   TEXT,
  after_state    TEXT,
  UNIQUE (sweep_id, pair_index)
);
CREATE INDEX IF NOT EXISTS decide_proposals_status_created_idx ON decide_proposals (status, created_at);
CREATE TABLE IF NOT EXISTS decide_sweep_deferred (
  source_id       TEXT NOT NULL,
  fact_id         BIGINT NOT NULL,
  slot            TEXT NOT NULL,
  reason          TEXT NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (slot, source_id, fact_id)
);
${upstreamDecideRls('decide_proposals')}
${upstreamDecideRls('decide_sweep_deferred')}
`;

for (const backend of testBackends()) describe(`entityless migration compatibility (${backend})`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const testHome = mkdtempSync(join(tmpdir(), `gbrain-entityless-migration-${backend}-`));

  beforeAll(async () => {
    const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
    await withEnv({ HOME: testHome, GBRAIN_HOME: testHome, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      if (backend === 'postgres') {
        const isolated = await isolatedPersistencePostgres(databaseUrl!);
        engine = isolated.engine;
        closePostgres = isolated.close;
      } else {
        const pglite = new PGLiteEngine();
        await pglite.connect({});
        await pglite.initSchema();
        engine = pglite;
      }
    });
  });

  afterAll(async () => {
    await withEnv({ HOME: testHome, GBRAIN_HOME: testHome }, async () => {
      await disposePersistenceConsumer(engine);
      if (closePostgres) await closePostgres();
      else await engine.disconnect();
    });
    rmSync(testHome, { recursive: true, force: true });
  });

  test('v184 upgrades simulated v183, then pinned upstream v185/v186 DDL preserves evidence', async () => {
    expect(LATEST_VERSION).toBe(184);
    expect(createHash('sha256').update(DECIDE_RECEIPTS_SCHEMA_SQL).digest('hex'))
      .toBe('52fbd2953179f3124604362c4c2cd200349d5e45a14bc5866a41fafe537fd9bb');
    expect(MIGRATIONS.find(migration => migration.version === 184)?.name)
      .toBe('take_proposal_evidence');

    await engine.executeRaw('DROP TABLE IF EXISTS decide_state,decide_spend,decision_receipts CASCADE');
    await engine.executeRaw('ALTER TABLE take_proposals DROP COLUMN IF EXISTS evidence');
    await engine.executeRaw('ALTER TABLE take_proposals DROP CONSTRAINT IF EXISTS take_proposals_status_check');
    await engine.executeRaw(`ALTER TABLE take_proposals ADD CONSTRAINT take_proposals_status_check
      CHECK (status IN ('pending','accepted','rejected','superseded'))`);
    await engine.executeRaw(`INSERT INTO take_proposals
      (source_id,page_slug,content_hash,prompt_version,proposal_run_id,status,claim_text,kind,holder,weight,model_id)
      VALUES ('default','notes/legacy-migration-fixture',md5('legacy'),'legacy-fixture','legacy-run','pending',
        'legacy claim','fact','self',0.7,'synthetic-test')`);
    await engine.setConfig('version', '183');

    expect(await runMigrations(engine)).toEqual({ applied: 1, current: 184 });
    expect(await engine.getConfig('version')).toBe('184');
    const tables = await engine.executeRaw<{ table_name: string }>(`SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name`,
    [['decision_receipts', 'decide_spend', 'decide_state']]);
    expect(tables.map(row => row.table_name)).toEqual(['decide_spend', 'decide_state', 'decision_receipts']);
    const indexes = await engine.executeRaw<{ indexname: string }>(`SELECT indexname FROM pg_indexes
      WHERE schemaname='public' AND indexname=ANY($1::text[]) ORDER BY indexname`,
    [['decision_receipts_slot_created_idx', 'decision_receipts_model_slot_idx', 'decision_receipts_decision_idx',
      'decide_spend_created_idx']]);
    expect(indexes.map(row => row.indexname)).toEqual([
      'decide_spend_created_idx', 'decision_receipts_decision_idx',
      'decision_receipts_model_slot_idx', 'decision_receipts_slot_created_idx',
    ]);

    const [legacy] = await engine.executeRaw<{ status: string; evidence: unknown }>(`SELECT status,evidence FROM take_proposals
      WHERE prompt_version='legacy-fixture'`);
    expect(legacy).toEqual({ status: 'pending', evidence: null });
    await engine.executeRaw(`INSERT INTO take_proposals
      (source_id,page_slug,content_hash,prompt_version,proposal_run_id,status,claim_text,kind,holder,weight,model_id,evidence)
      VALUES ('default','notes/evidence-migration-fixture',md5('evidence'),'entityless-fact-review-v1','evidence-run',
        'evidence_pending','synthetic proposal','fact','self',0.7,'deterministic:test','{"version":1}'::jsonb)`);
    for (const status of ['evidence_pending', 'evidence_accepting', 'evidence_accepted', 'evidence_rejected']) {
      await engine.executeRaw('UPDATE take_proposals SET status=$1 WHERE prompt_version=$2', [status, 'entityless-fact-review-v1']);
    }
    await engine.executeRaw("UPDATE take_proposals SET status='evidence_pending' WHERE prompt_version='entityless-fact-review-v1'");

    expect(await runMigrations(engine)).toEqual({ applied: 0, current: 184 });
    await engine.runMigration(184, v184.sql);
    const [evidence] = await engine.executeRaw<{ status: string; evidence: unknown }>(`SELECT status,evidence FROM take_proposals
      WHERE prompt_version='entityless-fact-review-v1'`);
    expect(evidence?.status).toBe('evidence_pending');
    expect(evidence?.evidence).toEqual({ version: 1 });

    await engine.runMigration(185, UPSTREAM_185_DECIDE_CALIBRATIONS_SCHEMA_SQL);
    await engine.setConfig('version', '185');
    expect(await engine.getConfig('version')).toBe('185');
    const v185Tables = await engine.executeRaw<{ table_name: string }>(`SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name`,
    [['decide_calibrations']]);
    expect(v185Tables.map(row => row.table_name)).toEqual(['decide_calibrations']);
    const [afterV185] = await engine.executeRaw<{ status: string; evidence: unknown }>(`SELECT status,evidence FROM take_proposals
      WHERE prompt_version='entityless-fact-review-v1'`);
    expect(afterV185).toEqual({ status: 'evidence_pending', evidence: { version: 1 } });

    await engine.runMigration(186, UPSTREAM_186_DECIDE_PROPOSALS_SCHEMA_SQL);
    await engine.setConfig('version', '186');
    expect(await engine.getConfig('version')).toBe('186');
    const v186Tables = await engine.executeRaw<{ table_name: string }>(`SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name`,
    [['decide_proposals', 'decide_sweep_deferred']]);
    expect(v186Tables.map(row => row.table_name)).toEqual(['decide_proposals', 'decide_sweep_deferred']);
    const v186Indexes = await engine.executeRaw<{ indexname: string }>(`SELECT indexname FROM pg_indexes
      WHERE schemaname='public' AND indexname=ANY($1::text[]) ORDER BY indexname`,
    [['decide_calibrations_lookup_idx', 'decide_proposals_status_created_idx']]);
    expect(v186Indexes.map(row => row.indexname)).toEqual([
      'decide_calibrations_lookup_idx', 'decide_proposals_status_created_idx',
    ]);
    const [afterFollowups] = await engine.executeRaw<{ status: string; evidence: unknown }>(`SELECT status,evidence FROM take_proposals
      WHERE prompt_version='entityless-fact-review-v1'`);
    expect(afterFollowups?.status).toBe('evidence_pending');
    expect(afterFollowups?.evidence).toEqual({ version: 1 });
    expect(await engine.getConfig('version')).toBe('186');
  });
});
