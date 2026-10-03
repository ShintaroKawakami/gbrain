import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { stableJson } from '../src/core/persistence/digest.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
});

async function isolated<T>(run: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-entityless-proposals-'));
  try {
    return await withEnv({ HOME: home, GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      await resetPgliteState(engine);
      try { return await run(); }
      finally { await disposePersistenceConsumer(engine); }
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

const oldTimestamp = () => new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
const recentTimestamp = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();

function unitVector(): string {
  const vector = new Float32Array(1536);
  vector[0] = 1;
  return `[${Array.from(vector).join(',')}]`;
}

async function seedTarget(slug: string, visibility: 'world' | 'private' = 'world'): Promise<{ id: number; revision: string }> {
  await engine.putPage(slug, {
    type: 'note', title: 'Review target', compiled_truth: 'Target page body.',
    frontmatter: visibility === 'private' ? { visibility: 'private' } : {},
  }, { sourceId: 'default' });
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: 'default' });
  if (!snapshot) throw new Error('test target was not created');
  return { id: Number(snapshot.page.id), revision: snapshot.revision };
}

async function seedFact(options: { sourceId?: string; text: string; visibility?: 'world' | 'private'; validFrom?: string; session?: string }): Promise<number> {
  const sourceId = options.sourceId ?? 'default';
  const rows = await engine.executeRaw<{ id: number }>(`INSERT INTO facts
      (source_id,entity_slug,fact,kind,visibility,notability,valid_from,source,source_session,confidence,
       embedding,embedded_at,embedding_model,embedded_text_hash)
    VALUES ($1,NULL,$2,'fact',$3,'medium',$4::timestamptz,'entityless-test',$5,0.8,$6::vector,$4::timestamptz,
      'openai:text-embedding-3-large',md5($2)) RETURNING id`,
  [sourceId, options.text, options.visibility ?? 'world', options.validFrom ?? oldTimestamp(), options.session ?? `session-${options.text}`, unitVector()]);
  return Number(rows[0]!.id);
}

async function factBytes(sourceId = 'default') {
  const rows = await engine.executeRaw(`SELECT id,source_id,entity_slug,fact,kind,visibility,notability,context,valid_from,valid_until,
      expired_at,superseded_by,consolidated_at,consolidated_into,source,source_session,confidence,embedding::text AS embedding,
      embedded_at,embedding_model,embedded_text_hash,source_markdown_slug,row_num,claim_metric,claim_value,claim_unit,
      claim_period,event_type,dimension,value,dim_status
    FROM facts WHERE source_id=$1 ORDER BY id`, [sourceId]);
  return stableJson(rows);
}

async function recallFacts() {
  const response = await dispatchToolCall(engine, 'recall', { source_id: 'default' }, { remote: false, sourceId: 'default' });
  expect(response.isError).toBeFalsy();
  return (JSON.parse(response.content[0]!.text) as { facts: Array<{ fact: string }> }).facts.map(row => row.fact).sort();
}

function readEvidence(value: unknown): Record<string, unknown> {
  return (typeof value === 'string' ? JSON.parse(value) : value) as Record<string, unknown>;
}

test('entityless review stays source-scoped, visibility-separated and outside normal takes or recall', async () => isolated(async () => {
  await engine.executeRaw("INSERT INTO sources (id,name) VALUES ('other-source-example','Other Source Example')");
  await seedTarget('notes/entityless-target');
  const sourceFacts: number[] = [];
  for (const visibility of ['world', 'private'] as const) {
    for (let index = 0; index < 3; index++) {
      sourceFacts.push(await seedFact({ text: `${visibility} synthetic claim ${index}`, visibility, session: `${visibility}-session-${index}` }));
    }
  }
  const otherIds: number[] = [];
  for (let index = 0; index < 3; index++) {
    otherIds.push(await seedFact({ sourceId: 'other-source-example', text: `world synthetic claim ${index}`, session: `other-session-${index}` }));
  }

  const beforeFacts = await factBytes();
  const beforeRecall = await recallFacts();
  const beforeTarget = await engine.readPageSnapshot('notes/entityless-target', { sourceId: 'default' });
  const first = await runPhaseConsolidate(engine, { sourceId: 'default', entitylessProposalTargetSlug: 'notes/entityless-target' });
  expect(first.details.entityless_proposals_created).toBe(2);
  expect(await factBytes()).toBe(beforeFacts);

  const proposals = await engine.executeRaw<{ id: number; source_id: string; status: string; claim_text: string; evidence: unknown }>(
    "SELECT id,source_id,status,claim_text,evidence FROM take_proposals WHERE prompt_version='entityless-fact-review-v1' ORDER BY id");
  expect(proposals).toHaveLength(2);
  const evidence = proposals.map(row => readEvidence(row.evidence));
  expect(new Set(evidence.map(row => row.visibility))).toEqual(new Set(['world', 'private']));
  for (const proposal of proposals) {
    expect(proposal.source_id).toBe('default');
    expect(proposal.status).toBe('evidence_pending');
    const record = readEvidence(proposal.evidence);
    expect(record.reason).toBe('subject_unknown');
    expect(record.contradictions).toBe('unverified');
    expect(record.source_incarnation).toBeTruthy();
    expect((record.target as Record<string, unknown>).revision).toBe(beforeTarget?.revision);
    const facts = record.facts as Array<Record<string, unknown>>;
    expect(facts.length).toBe(3);
    expect(facts.every(fact => fact.source_id === 'default' && fact.entity_slug === null && fact.visibility === record.visibility)).toBe(true);
    expect(facts.map(fact => Number(fact.id)).some(id => otherIds.includes(id))).toBe(false);
    expect(facts.every(fact => sourceFacts.includes(Number(fact.id)))).toBe(true);
    expect(facts.every(fact => typeof fact.source_session === 'string' && typeof fact.source === 'string')).toBe(true);
  }

  expect(await engine.listTakes({ page_slug: 'notes/entityless-target' })).toHaveLength(0);
  const page = await engine.getPage('notes/entityless-target', { sourceId: 'default' });
  expect(page?.compiled_truth).toBe('Target page body.');
  expect(await engine.executeRaw('SELECT id FROM content_chunks WHERE page_id=$1', [beforeTarget!.page.id])).toHaveLength(0);
  expect(await recallFacts()).toEqual(beforeRecall);

  const rerun = await runPhaseConsolidate(engine, { sourceId: 'default', entitylessProposalTargetSlug: 'notes/entityless-target' });
  expect(rerun.details.entityless_proposals_created).toBe(0);
  expect(await engine.executeRaw("SELECT id FROM take_proposals WHERE prompt_version='entityless-fact-review-v1'")).toHaveLength(2);
  expect(await factBytes()).toBe(beforeFacts);
}));

test('entityless candidates enforce age and the 100-fact evidence bound without paid inference', async () => isolated(async () => {
  for (let index = 0; index < 3; index++) {
    await seedFact({ text: `recent synthetic fact ${index}`, validFrom: recentTimestamp() });
  }
  const young = await runPhaseConsolidate(engine, { sourceId: 'default', entitylessProposalTargetSlug: 'notes/missing-target' });
  expect(young.details.entityless_proposals_created).toBe(0);

  await resetPgliteState(engine);
  for (let index = 0; index < 101; index++) {
    await seedFact({ text: `bounded synthetic fact ${index}` });
  }
  const bounded = await runPhaseConsolidate(engine, { sourceId: 'default', entitylessProposalTargetSlug: 'notes/missing-target' });
  expect(bounded.details.entityless_proposals_created).toBe(1);
  const [proposal] = await engine.executeRaw<{ evidence: unknown }>(
    "SELECT evidence FROM take_proposals WHERE prompt_version='entityless-fact-review-v1'");
  const evidence = readEvidence(proposal!.evidence);
  expect((evidence.facts as unknown[]).length).toBe(100);
  expect((evidence.target as Record<string, unknown>).revision).toBeNull();
  expect(await engine.executeRaw("SELECT id FROM pages WHERE source_id='default' AND slug='notes/missing-target'")).toHaveLength(0);
}));

test('the internal opt-in requires a concrete source and a nonblank explicit target', async () => isolated(async () => {
  const missingSource = await runPhaseConsolidate(engine, { entitylessProposalTargetSlug: 'notes/target' });
  const missingTarget = await runPhaseConsolidate(engine, { sourceId: 'default', entitylessProposalTargetSlug: '   ' });
  expect(missingSource.error?.code).toBe('entityless_proposal_scope_required');
  expect(missingTarget.error?.code).toBe('entityless_proposal_scope_required');
  expect(await engine.executeRaw("SELECT id FROM take_proposals WHERE prompt_version='entityless-fact-review-v1'")).toHaveLength(0);
}));
