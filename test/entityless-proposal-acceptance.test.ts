import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { loadConfig } from '../src/core/config.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { acceptProposal, rejectProposal, type TakeProposalRow } from '../src/core/take-proposals.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';
import { digest, stableJson } from '../src/core/persistence/digest.ts';
import { maintenancePreflight } from '../src/core/persistence/prepared-maintenance.ts';
import { admitWrite } from '../src/core/persistence/journal.ts';
import { recordFactWithdrawal } from '../src/core/facts/withdrawal.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

for (const backend of testBackends()) describe(`entityless proposal acceptance (${backend})`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const testHome = mkdtempSync(join(tmpdir(), `gbrain-entityless-acceptance-${backend}-`));

  beforeAll(async () => {
    const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
    await withEnv({ HOME: testHome, GBRAIN_HOME: testHome, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      if (backend === 'postgres') {
        const isolatedPostgres = await isolatedPersistencePostgres(databaseUrl!);
        engine = isolatedPostgres.engine;
        closePostgres = isolatedPostgres.close;
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

  async function isolated<T>(run: () => Promise<T>): Promise<T> {
    return withEnv({ HOME: testHome, GBRAIN_HOME: testHome, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await resetPgliteState(engine as PGLiteEngine);
      try { return await run(); }
      finally { await disposePersistenceConsumer(engine); }
    });
  }

const config = (): GBrainConfig => loadConfig() ?? { engine: 'pglite' } as GBrainConfig;
const oldTimestamp = () => new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();

function unitVector(): string {
  const vector = new Float32Array(1536);
  vector[0] = 1;
  return `[${Array.from(vector).join(',')}]`;
}

async function seedTarget(slug = 'notes/acceptance-target', visibility: 'world' | 'private' = 'world'): Promise<{ id: number; revision: string }> {
  await engine.putPage(slug, {
    type: 'note', title: 'Acceptance target', compiled_truth: 'Stable target body.',
    frontmatter: visibility === 'private' ? { visibility: 'private' } : {},
  }, { sourceId: 'default' });
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  if (!snapshot) throw new Error('test target was not created');
  return { id: Number(snapshot.page.id), revision: snapshot.revision };
}

async function seedFact(text: string, visibility: 'world' | 'private' = 'world', validUntil?: string): Promise<number> {
  const rows = await engine.executeRaw<{ id: number }>(`INSERT INTO facts
      (source_id,entity_slug,fact,kind,visibility,notability,valid_from,valid_until,source,source_session,confidence,
       embedding,embedded_at,embedding_model,embedded_text_hash)
    VALUES ('default',NULL,$1,'fact',$2,'medium',$3::timestamptz,$4::timestamptz,'entityless-acceptance',
      $5,0.75,$6::vector,$3::timestamptz,'openai:text-embedding-3-large',md5($1)) RETURNING id`,
  [text, visibility, oldTimestamp(), validUntil ?? null, `accept-session-${text}`, unitVector()]);
  return Number(rows[0]!.id);
}

async function seedProposal(targetSlug = 'notes/acceptance-target', visibility: 'world' | 'private' = 'world', validUntil?: string) {
  for (let index = 0; index < 3; index++) await seedFact(`${visibility} accepted claim ${index}`, visibility, validUntil);
  await runPhaseConsolidate(engine, { sourceId: 'default', entitylessProposalTargetSlug: targetSlug });
  const [row] = await engine.executeRaw<TakeProposalRow>(`SELECT id,source_id,page_slug,claim_text,kind,holder,weight,domain,status,
    proposed_at,model_id,promoted_row_num,evidence FROM take_proposals WHERE prompt_version='entityless-fact-review-v1' ORDER BY id LIMIT 1`);
  if (!row) throw new Error('test proposal was not created');
  return row;
}

async function factBytes() {
  const rows = await engine.executeRaw(`SELECT id,source_id,entity_slug,fact,kind,visibility,notability,context,valid_from,valid_until,
      expired_at,superseded_by,consolidated_at,consolidated_into,source,source_session,confidence,embedding::text AS embedding,
      embedded_at,embedding_model,embedded_text_hash,source_markdown_slug,row_num,claim_metric,claim_value,claim_unit,
      claim_period,event_type,dimension,value,dim_status FROM facts WHERE source_id='default' ORDER BY id`);
  return stableJson(rows);
}

async function proposalState(id: number) {
  const [row] = await engine.executeRaw<{ status: string; promoted_row_num: number | null }>(
    'SELECT status,promoted_row_num FROM take_proposals WHERE id=$1', [id]);
  return { status: row!.status, promoted_row_num: row!.promoted_row_num == null ? null : Number(row!.promoted_row_num) };
}

function evidenceOf(row: TakeProposalRow): Record<string, unknown> {
  return (typeof row.evidence === 'string' ? JSON.parse(row.evidence) : row.evidence) as Record<string, unknown>;
}

function proposalTarget(row: TakeProposalRow) {
  return { engine, sourceId: row.source_id, config: config() };
}

test('world acceptance publishes through the guarded durable intent and leaves source facts unchanged', async () => isolated(async () => {
  await engine.setConfig('sync.write_through', 'false');
  const target = await seedTarget();
  const proposal = await seedProposal();
  const beforeFacts = await factBytes();
  const evidence = evidenceOf(proposal);
  expect((evidence.target as Record<string, unknown>).page_id).toBe(target.id);
  expect((evidence.target as Record<string, unknown>).revision).toBe(target.revision);
  expect(await engine.listTakes({ page_slug: proposal.page_slug })).toHaveLength(0);

  const first = await acceptProposal(proposalTarget(proposal), proposal.id);
  expect(first.rowNum).toBeGreaterThan(0);
  expect(await proposalState(proposal.id)).toEqual({ status: 'evidence_accepted', promoted_row_num: first.rowNum });
  expect(await factBytes()).toBe(beforeFacts);
  const takes = await engine.listTakes({ page_slug: proposal.page_slug });
  expect(takes).toHaveLength(1);
  expect(takes[0]!.claim).toBe(proposal.claim_text);
  expect(takes[0]!.source).toBe(`entityless-proposal:${proposal.id}`);
  const page = await engine.getPage(proposal.page_slug, { sourceId: proposal.source_id });
  expect(parseTakesFence(page?.compiled_truth ?? '').takes.map(take => take.claim)).toContain(proposal.claim_text);

  const replay = await acceptProposal(proposalTarget(proposal), proposal.id);
  expect(replay.rowNum).toBe(first.rowNum);
  expect(await engine.listTakes({ page_slug: proposal.page_slug })).toHaveLength(1);
  expect(await factBytes()).toBe(beforeFacts);
}));

test('a missing target stays pending and can only be accepted after a fresh revision-bound proposal', async () => isolated(async () => {
  await engine.setConfig('sync.write_through', 'false');
  const proposal = await seedProposal('notes/not-created-yet');
  const evidence = evidenceOf(proposal);
  expect((evidence.target as Record<string, unknown>).revision).toBeNull();
  await expect(acceptProposal(proposalTarget(proposal), proposal.id)).rejects.toThrow('target_not_ready');
  expect(await proposalState(proposal.id)).toEqual({ status: 'evidence_pending', promoted_row_num: null });
  expect(await engine.executeRaw("SELECT id FROM pages WHERE source_id='default' AND slug='notes/not-created-yet'")).toHaveLength(0);

  const target = await seedTarget('notes/not-created-yet');
  await runPhaseConsolidate(engine, { sourceId: 'default', entitylessProposalTargetSlug: 'notes/not-created-yet' });
  const proposals = await engine.executeRaw<TakeProposalRow>(`SELECT id,source_id,page_slug,claim_text,kind,holder,weight,domain,status,
    proposed_at,model_id,promoted_row_num,evidence FROM take_proposals WHERE prompt_version='entityless-fact-review-v1' ORDER BY id`);
  expect(proposals).toHaveLength(2);
  const fresh = proposals[1]!;
  expect((evidenceOf(fresh).target as Record<string, unknown>).revision).toBe(target.revision);
  expect((await acceptProposal(proposalTarget(fresh), fresh.id)).rowNum).toBeGreaterThan(0);
  expect(await proposalState(proposal.id)).toEqual({ status: 'evidence_pending', promoted_row_num: null });
}));

test('private evidence cannot be published even when remote private-page filtering is opted out', async () => isolated(async () => {
  await engine.setConfig('sync.write_through', 'false');
  await engine.setConfig('search.remote_private_pages', 'true');
  await seedTarget('notes/private-target', 'private');
  const proposal = await seedProposal('notes/private-target', 'private');
  const beforeFacts = await factBytes();
  await expect(acceptProposal(proposalTarget(proposal), proposal.id)).rejects.toThrow('Private entityless fact proposals are local-only');
  expect(await proposalState(proposal.id)).toEqual({ status: 'evidence_pending', promoted_row_num: null });
  expect(await engine.listTakes({ page_slug: proposal.page_slug })).toHaveLength(0);
  expect(await engine.executeRaw('SELECT id FROM persistence_requests')).toHaveLength(0);
  expect(await engine.executeRaw('SELECT id FROM persistence_local_writers')).toHaveLength(0);
  expect(await factBytes()).toBe(beforeFacts);
  await rejectProposal({ engine, sourceId: proposal.source_id, actedBy: 'local-reviewer' }, proposal.id);
  expect(await proposalState(proposal.id)).toEqual({ status: 'evidence_rejected', promoted_row_num: null });
}));

test('expired, withdrawn, changed or malformed evidence refuses before a take can publish', async () => isolated(async () => {
  await engine.setConfig('sync.write_through', 'false');
  await seedTarget();
  const ttl = await seedProposal();
  await engine.executeRaw("UPDATE facts SET valid_until=now()-interval '1 second' WHERE source_id='default'");
  await expect(acceptProposal(proposalTarget(ttl), ttl.id)).rejects.toMatchObject({ code: 'review_refused' });
  expect(await proposalState(ttl.id)).toEqual({ status: 'evidence_pending', promoted_row_num: null });
  expect(await engine.listTakes({ page_slug: ttl.page_slug })).toHaveLength(0);

  await resetPgliteState(engine as PGLiteEngine);
  await engine.setConfig('sync.write_through', 'false');
  await seedTarget();
  const futureTtl = await seedProposal('notes/acceptance-target', 'world', new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString());
  const futureFactBytes = await factBytes();
  expect((evidenceOf(futureTtl).facts as Array<Record<string, unknown>>).every(fact => fact.valid_until !== null)).toBe(true);
  await expect(acceptProposal(proposalTarget(futureTtl), futureTtl.id)).rejects.toMatchObject({ code: 'review_refused' });
  expect(await proposalState(futureTtl.id)).toEqual({ status: 'evidence_pending', promoted_row_num: null });
  expect(await engine.listTakes({ page_slug: futureTtl.page_slug })).toHaveLength(0);
  expect(await factBytes()).toBe(futureFactBytes);

  await resetPgliteState(engine as PGLiteEngine);
  await engine.setConfig('sync.write_through', 'false');
  await seedTarget();
  const withdrawn = await seedProposal();
  const factRows = await engine.executeRaw<{ id: number }>("SELECT id FROM facts WHERE source_id='default' ORDER BY id LIMIT 1");
  await recordFactWithdrawal(engine, Number(factRows[0]!.id), 'default');
  await expect(acceptProposal(proposalTarget(withdrawn), withdrawn.id)).rejects.toMatchObject({ code: 'review_refused' });
  expect(await proposalState(withdrawn.id)).toEqual({ status: 'evidence_pending', promoted_row_num: null });
  const [withdrawalCount] = await engine.executeRaw<{ count: number | string }>('SELECT count(*)::int AS count FROM fact_withdrawals');
  expect(Number(withdrawalCount!.count)).toBe(1);
  expect(await engine.listTakes({ page_slug: withdrawn.page_slug })).toHaveLength(0);

  await resetPgliteState(engine as PGLiteEngine);
  await engine.setConfig('sync.write_through', 'false');
  await seedTarget();
  const changed = await seedProposal();
  await engine.executeRaw(`UPDATE take_proposals
    SET evidence=jsonb_set(evidence,'{source_incarnation}',to_jsonb(gen_random_uuid()::text)) WHERE id=$1`, [changed.id]);
  await expect(acceptProposal(proposalTarget(changed), changed.id)).rejects.toThrow('source incarnation changed');
  expect(await proposalState(changed.id)).toEqual({ status: 'evidence_pending', promoted_row_num: null });

  await resetPgliteState(engine as PGLiteEngine);
  await engine.setConfig('sync.write_through', 'false');
  await seedTarget();
  const badEvidence = await seedProposal();
  await engine.executeRaw("UPDATE take_proposals SET evidence='{}'::jsonb WHERE id=$1", [badEvidence.id]);
  await expect(acceptProposal(proposalTarget(badEvidence), badEvidence.id)).rejects.toThrow('evidence is malformed');
  expect(await proposalState(badEvidence.id)).toEqual({ status: 'evidence_pending', promoted_row_num: null });
  expect(await engine.listTakes({ page_slug: badEvidence.page_slug })).toHaveLength(0);
}));

test('TTL drift after durable admission is rejected by the publication preparer and stays reviewable', async () => isolated(async () => {
  await engine.setConfig('sync.write_through', 'false');
  await seedTarget();
  const proposal = await seedProposal();
  await engine.executeRaw(`CREATE OR REPLACE FUNCTION test_entityless_expire_after_admission() RETURNS trigger LANGUAGE plpgsql AS $fn$
    BEGIN
      IF NEW.operation='submit_job' AND NEW.intent->>'kind'='managed_maintenance_entityless_proposal_accept' THEN
        UPDATE facts SET valid_until=now()+interval '1 day'
          WHERE source_id='default' AND source='entityless-acceptance' AND visibility='world';
      END IF;
      RETURN NEW;
    END;
  $fn$`);
  await engine.executeRaw(`CREATE TRIGGER test_entityless_expire_after_admission
    AFTER INSERT ON persistence_requests FOR EACH ROW EXECUTE FUNCTION test_entityless_expire_after_admission()`);
  try {
    await expect(acceptProposal(proposalTarget(proposal), proposal.id)).rejects.toMatchObject({ code: 'review_refused' });
  } finally {
    await engine.executeRaw('DROP TRIGGER IF EXISTS test_entityless_expire_after_admission ON persistence_requests');
    await engine.executeRaw('DROP FUNCTION IF EXISTS test_entityless_expire_after_admission()');
  }
  expect(await proposalState(proposal.id)).toEqual({ status: 'evidence_pending', promoted_row_num: null });
  expect(await engine.listTakes({ page_slug: proposal.page_slug })).toHaveLength(0);
  const [receipt] = await engine.executeRaw<{ state: string; intent: Record<string, unknown> }>(
    "SELECT state,intent FROM persistence_requests WHERE intent->>'kind'='managed_maintenance_entityless_proposal_accept'");
  expect(['conflict', 'failed']).toContain(receipt?.state);

  await engine.executeRaw("UPDATE facts SET valid_until=NULL WHERE source='entityless-acceptance' AND source_id='default'");
  const retriedRowNum = await acceptProposal(proposalTarget(proposal), proposal.id);
  expect(retriedRowNum.rowNum).toBeGreaterThan(0);
  expect(await proposalState(proposal.id)).toEqual({ status: 'evidence_accepted', promoted_row_num: retriedRowNum.rowNum });
  expect(await engine.listTakes({ page_slug: proposal.page_slug })).toHaveLength(1);
  const requests = await engine.executeRaw<{ state: string }>(`SELECT state FROM persistence_requests
    WHERE intent->>'kind'='managed_maintenance_entityless_proposal_accept' ORDER BY created_at,id`);
  expect(requests).toHaveLength(2);
  expect(['conflict', 'failed']).toContain(requests[0]!.state);
  expect(requests[1]!.state).toBe('committed');
}));

test('an unreadable maintenance receipt keeps an accepting proposal claimed until its state is known', async () => isolated(async () => {
  await engine.setConfig('sync.write_through', 'false');
  await seedTarget();
  const proposal = await seedProposal();
  const evidence = evidenceOf(proposal);
  await engine.executeRaw("UPDATE take_proposals SET status='evidence_accepting',evidence=jsonb_set(evidence,'{source_incarnation}',to_jsonb(gen_random_uuid()::text)) WHERE id=$1",
    [proposal.id]);

  const unreadableEngine = new Proxy(engine, {
    get(target, property) {
      if (property === 'executeRaw') {
        return async (sql: string, params?: unknown[]) => {
          if (sql.replace(/\s+/g, ' ').trim().startsWith('SELECT state FROM persistence_requests')) {
            throw new Error('synthetic receipt read failure');
          }
          return target.executeRaw(sql, params);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as BrainEngine;

  await expect(acceptProposal({ ...proposalTarget(proposal), engine: unreadableEngine }, proposal.id))
    .rejects.toMatchObject({ code: 'review_refused' });
  expect(await proposalState(proposal.id)).toEqual({ status: 'evidence_accepting', promoted_row_num: null });

  await engine.executeRaw('UPDATE take_proposals SET evidence=$2::text::jsonb WHERE id=$1', [proposal.id, JSON.stringify(evidence)]);
  const retried = await acceptProposal(proposalTarget(proposal), proposal.id);
  expect(retried.rowNum).toBeGreaterThan(0);
  expect(await proposalState(proposal.id)).toEqual({ status: 'evidence_accepted', promoted_row_num: retried.rowNum });
  expect(await engine.listTakes({ page_slug: proposal.page_slug })).toHaveLength(1);
}));

test('future-valid and superseded facts cannot be published even when proposal evidence matches their current rows', async () => isolated(async () => {
  await engine.setConfig('sync.write_through', 'false');
  await seedTarget();
  const proposal = await seedProposal();
  const evidence = evidenceOf(proposal);
  const facts = evidence.facts as Array<Record<string, unknown>>;
  const now = Date.now();
  const futureFrom = new Date(now + 24 * 60 * 60 * 1000).toISOString();
  const supersededId = Number(facts[1]!.id);
  const futureId = Number(facts[0]!.id);

  await engine.executeRaw('UPDATE facts SET valid_from=$1::timestamptz WHERE id=$2', [futureFrom, futureId]);
  facts[0]!.valid_from = futureFrom;
  await engine.executeRaw('UPDATE take_proposals SET evidence=$2::text::jsonb WHERE id=$1', [proposal.id, JSON.stringify(evidence)]);
  await expect(acceptProposal(proposalTarget(proposal), proposal.id)).rejects.toMatchObject({ code: 'review_refused' });
  expect(await proposalState(proposal.id)).toEqual({ status: 'evidence_pending', promoted_row_num: null });
  expect(await engine.listTakes({ page_slug: proposal.page_slug })).toHaveLength(0);

  await resetPgliteState(engine as PGLiteEngine);
  await engine.setConfig('sync.write_through', 'false');
  await seedTarget();
  const superseded = await seedProposal();
  const supersededEvidence = evidenceOf(superseded);
  const supersededFacts = supersededEvidence.facts as Array<Record<string, unknown>>;
  const oldFactId = Number(supersededFacts[0]!.id);
  const supersedingFactId = Number(supersededFacts[1]!.id);
  await engine.executeRaw('UPDATE facts SET superseded_by=$1 WHERE id=$2', [supersedingFactId, oldFactId]);
  supersededFacts[0]!.superseded_by = supersedingFactId;
  await engine.executeRaw('UPDATE take_proposals SET evidence=$2::text::jsonb WHERE id=$1', [superseded.id, JSON.stringify(supersededEvidence)]);
  await expect(acceptProposal(proposalTarget(superseded), superseded.id)).rejects.toMatchObject({ code: 'review_refused' });
  expect(await proposalState(superseded.id)).toEqual({ status: 'evidence_pending', promoted_row_num: null });
  expect(await engine.listTakes({ page_slug: superseded.page_slug })).toHaveLength(0);
}));

test('target revision changes and unavailable owners refuse without claiming a review row', async () => isolated(async () => {
  await engine.setConfig('sync.write_through', 'false');
  await seedTarget();
  const revisionChanged = await seedProposal();
  await engine.executeRaw("UPDATE pages SET knowledge_revision=gen_random_uuid() WHERE source_id='default' AND slug=$1", [revisionChanged.page_slug]);
  await expect(acceptProposal(proposalTarget(revisionChanged), revisionChanged.id)).rejects.toThrow('target page changed');
  expect(await proposalState(revisionChanged.id)).toEqual({ status: 'evidence_pending', promoted_row_num: null });

  await resetPgliteState(engine as PGLiteEngine);
  await seedTarget();
  const ownerUnavailable = await seedProposal();
  await engine.setConfig('sync.write_through', 'true');
  await expect(acceptProposal({ ...proposalTarget(ownerUnavailable), brainDir: process.cwd() }, ownerUnavailable.id))
    .rejects.toMatchObject({ code: 'review_refused', message: expect.stringContaining('owner') });
  expect(await proposalState(ownerUnavailable.id)).toEqual({ status: 'evidence_pending', promoted_row_num: null });
  expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE slug=$1", [ownerUnavailable.page_slug])).toHaveLength(0);
}));

test('legacy take proposals retain the original local acceptance path', async () => isolated(async () => {
  await engine.setConfig('sync.write_through', 'false');
  await seedTarget();
  const rows = await engine.executeRaw<{ id: number }>(`INSERT INTO take_proposals
      (source_id,page_slug,content_hash,prompt_version,proposal_run_id,status,claim_text,kind,holder,weight,model_id)
    VALUES ('default','notes/acceptance-target',md5('legacy synthetic take'),'legacy-test','legacy-run','pending',
      'legacy synthetic take','fact','self',0.6,'synthetic-test') RETURNING id`);
  const id = Number(rows[0]!.id);
  const result = await acceptProposal({ engine, sourceId: 'default', brainDir: process.cwd(), config: config() }, id);
  expect(result.rowNum).toBeGreaterThan(0);
  expect(await proposalState(id)).toEqual({ status: 'accepted', promoted_row_num: result.rowNum });
  expect(await engine.listTakes({ page_slug: 'notes/acceptance-target' })).toHaveLength(1);
}));

// Extracted from the v0.60.25.0 take-proposals load guard: only 'pending'
// enters acceptance; the one legacy exception is 'accepted' with no row receipt.
function oldBinaryAcceptFixture(status: string, promotedRowNum: number | null): 'accept' | 'resume' | 'refuse' {
  if (status !== 'pending') {
    if (status === 'accepted' && promotedRowNum == null) return 'resume';
    return 'refuse';
  }
  return 'accept';
}

// Extracted from the old prepared-maintenance dispatch: page, adopt, phantom
// merge/delete, otherwise managed consolidation; any other kind is refused.
function oldBinaryMaintenanceFixture(kind: string): never | 'known' {
  if (['managed_maintenance_page', 'managed_maintenance_adopt_fact_fence', 'managed_maintenance_phantom_merge',
    'managed_maintenance_phantom_delete', 'managed_maintenance_consolidate'].includes(kind)) return 'known';
  throw new Error('Unsupported maintenance request.');
}

test('old-binary extracted predicates refuse evidence states while the new intent is admitted transactionally', async () => isolated(async () => {
  await engine.setConfig('sync.write_through', 'false');
  const target = await seedTarget();
  const proposal = await seedProposal();
  for (const status of ['evidence_pending', 'evidence_accepting', 'evidence_accepted', 'evidence_rejected']) {
    expect(oldBinaryAcceptFixture(status, null)).toBe('refuse');
  }

  const authority = await maintenancePreflight(engine, 'default', undefined, { allowUnmanagedDatabaseOnly: true });
  expect(authority).toBeTruthy();
  const evidence = evidenceOf(proposal);
  const intent = {
    kind: 'managed_maintenance_entityless_proposal_accept', proposal_id: Number(proposal.id),
    evidence_hash: digest(evidence), expected_revision: (evidence.target as Record<string, unknown>).revision,
  };
  const acceptedReceipt = await admitWrite(engine, {
    principal: authority!.writer.principal,
    operation: 'submit_job',
    sourceId: 'default',
    sourceIncarnation: String(evidence.source_incarnation),
    slug: proposal.page_slug,
    pageId: target.id,
    requestId: randomUUID(),
    callerIntent: intent,
    intent,
    authority: authority!.writer,
    worktreeId: null,
    topologyGeneration: null,
  });
  await engine.executeRaw("UPDATE take_proposals SET status='evidence_accepting',acted_at=now(),acted_by='test' WHERE id=$1", [proposal.id]);
  expect(acceptedReceipt.state).toBe('queued');
  expect(oldBinaryAcceptFixture('evidence_accepting', null)).toBe('refuse');
  expect(() => oldBinaryMaintenanceFixture(String(intent.kind))).toThrow('Unsupported maintenance request');
  const [receipt] = await engine.executeRaw<{ state: string; intent: Record<string, unknown> }>(
    'SELECT state,intent FROM persistence_requests WHERE id=$1::uuid', [acceptedReceipt.id]);
  expect(receipt!.state).toBe('queued');
  expect(receipt!.intent.kind).toBe(intent.kind);
  expect(await proposalState(proposal.id)).toEqual({ status: 'evidence_accepting', promoted_row_num: null });
  await disposePersistenceConsumer(engine);
}));
});
