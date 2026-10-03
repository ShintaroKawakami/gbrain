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

for (const backend of testBackends()) describe(`entityless migration compatibility (${backend})`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const testHome = mkdtempSync(join(tmpdir(), `gbrain-entityless-migration-${backend}-`));

  beforeAll(async () => {
    await withEnv({ HOME: testHome, GBRAIN_HOME: testHome, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      if (backend === 'postgres') {
        const isolated = await isolatedPersistencePostgres(requirePostgresTestDatabase());
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

  test('v184 upgrades a simulated v183 schema, replays idempotently, and leaves room for later DDL', async () => {
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

    await engine.runMigration(185, `CREATE TABLE IF NOT EXISTS decide_receipt_followup_fixture (
      receipt_id BIGINT REFERENCES decision_receipts(id), proposal_id BIGINT REFERENCES take_proposals(id)
    )`);
    await engine.runMigration(186, `CREATE INDEX IF NOT EXISTS decide_receipt_followup_fixture_idx
      ON decide_receipt_followup_fixture (receipt_id,proposal_id)`);
    const [afterFollowups] = await engine.executeRaw<{ status: string; evidence: unknown }>(`SELECT status,evidence FROM take_proposals
      WHERE prompt_version='entityless-fact-review-v1'`);
    expect(afterFollowups?.status).toBe('evidence_pending');
    expect(afterFollowups?.evidence).toEqual({ version: 1 });
    expect(await engine.getConfig('version')).toBe('184');
  });
});
