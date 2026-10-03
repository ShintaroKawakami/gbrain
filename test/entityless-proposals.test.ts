import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { produceEntitylessFactProposals } from '../src/core/cycle/entityless-proposals.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { stableJson } from '../src/core/persistence/digest.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const testHome = mkdtempSync(join(tmpdir(), 'gbrain-entityless-proposals-home-'));

beforeAll(async () => {
  await withEnv({ HOME: testHome, GBRAIN_HOME: testHome, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
});

afterAll(async () => {
  await withEnv({ HOME: testHome, GBRAIN_HOME: testHome }, async () => {
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
  });
  rmSync(testHome, { recursive: true, force: true });
});

async function isolated<T>(run: () => Promise<T>): Promise<T> {
  return withEnv({ HOME: testHome, GBRAIN_HOME: testHome, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    await resetPgliteState(engine);
    try { return await run(); }
    finally { await disposePersistenceConsumer(engine); }
  });
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

async function seedFact(options: { sourceId?: string; text: string; visibility?: 'world' | 'private'; validFrom?: string;
  session?: string; embedding?: string | null }): Promise<number> {
  const sourceId = options.sourceId ?? 'default';
  const rows = await engine.executeRaw<{ id: number }>(`INSERT INTO facts
      (source_id,entity_slug,fact,kind,visibility,notability,valid_from,source,source_session,confidence,
       embedding,embedded_at,embedding_model,embedded_text_hash)
    VALUES ($1,NULL,$2,'fact',$3,'medium',$4::timestamptz,'entityless-test',$5,0.8,$6::vector,$4::timestamptz,
      'openai:text-embedding-3-large',md5($2)) RETURNING id`,
  [sourceId, options.text, options.visibility ?? 'world', options.validFrom ?? oldTimestamp(),
    options.session ?? `session-${options.text}`, options.embedding === undefined ? unitVector() : options.embedding]);
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
  for (let index = 0; index < 103; index++) {
    await seedFact({ text: `bounded synthetic fact ${index}` });
  }
  const bounded = await runPhaseConsolidate(engine, { sourceId: 'default', entitylessProposalTargetSlug: 'notes/missing-target' });
  expect(bounded.details.entityless_proposals_created).toBe(1);
  const proposals = await engine.executeRaw<{ id: number; evidence: unknown }>(
    "SELECT id,evidence FROM take_proposals WHERE prompt_version='entityless-fact-review-v1' ORDER BY id");
  expect(proposals).toHaveLength(1);
  const evidence = readEvidence(proposals[0]!.evidence);
  expect((evidence.facts as unknown[]).length).toBe(100);
  expect((evidence.target as Record<string, unknown>).revision).toBeNull();
  expect(await engine.executeRaw("SELECT id FROM pages WHERE source_id='default' AND slug='notes/missing-target'")).toHaveLength(0);

  const remaining = await runPhaseConsolidate(engine, { sourceId: 'default', entitylessProposalTargetSlug: 'notes/missing-target' });
  expect(remaining.details.entityless_proposals_created).toBe(1);
  const secondPass = await engine.executeRaw<{ evidence: unknown }>(
    "SELECT evidence FROM take_proposals WHERE prompt_version='entityless-fact-review-v1' ORDER BY id");
  expect(secondPass).toHaveLength(2);
  expect((readEvidence(secondPass[1]!.evidence).facts as unknown[]).length).toBe(3);
  const complete = await runPhaseConsolidate(engine, { sourceId: 'default', entitylessProposalTargetSlug: 'notes/missing-target' });
  expect(complete.details.entityless_proposals_created).toBe(0);
  expect(await engine.executeRaw("SELECT id FROM take_proposals WHERE prompt_version='entityless-fact-review-v1'")).toHaveLength(2);
}));

test('keyset scan advances past the first 100 unclusterable facts to a later embedded group', async () => isolated(async () => {
  for (let index = 0; index < 100; index++) {
    await seedFact({ text: `unembedded singleton ${index}`, embedding: null });
  }
  for (let index = 0; index < 3; index++) {
    await seedFact({ text: `later embedded cluster ${index}` });
  }

  const result = await produceEntitylessFactProposals(engine, { sourceId: 'default', targetSlug: 'notes/later-group' });
  expect(result.scanned).toBe(103);
  expect(result.inserted).toBe(1);
  const [proposal] = await engine.executeRaw<{ evidence: unknown }>(
    "SELECT evidence FROM take_proposals WHERE prompt_version='entityless-fact-review-v1'");
  const evidence = readEvidence(proposal!.evidence);
  expect((evidence.facts as Array<Record<string, unknown>>).map(fact => fact.fact))
    .toEqual(['later embedded cluster 0', 'later embedded cluster 1', 'later embedded cluster 2']);
  expect(await engine.executeRaw("SELECT id FROM take_proposals WHERE prompt_version='entityless-fact-review-v1'")).toHaveLength(1);
}));

test('unchanged rejected and accepted evidence stays covered while a changed fact regenerates its original group', async () => isolated(async () => {
  for (let index = 0; index < 3; index++) await seedFact({ text: `reviewed synthetic fact ${index}` });
  const first = await runPhaseConsolidate(engine, { sourceId: 'default', entitylessProposalTargetSlug: 'notes/review-target' });
  expect(first.details.entityless_proposals_created).toBe(1);
  const [original] = await engine.executeRaw<{ id: number; evidence: unknown }>(
    "SELECT id,evidence FROM take_proposals WHERE prompt_version='entityless-fact-review-v1'");
  await engine.executeRaw("UPDATE take_proposals SET status='evidence_rejected' WHERE id=$1", [original!.id]);
  expect((await runPhaseConsolidate(engine, { sourceId: 'default', entitylessProposalTargetSlug: 'notes/review-target' }))
    .details.entityless_proposals_created).toBe(0);
  await seedTarget('notes/review-target');
  expect((await runPhaseConsolidate(engine, { sourceId: 'default', entitylessProposalTargetSlug: 'notes/review-target' }))
    .details.entityless_proposals_created).toBe(0);

  const originalEvidence = readEvidence(original!.evidence);
  const originalFacts = originalEvidence.facts as Array<Record<string, unknown>>;
  await engine.executeRaw('UPDATE facts SET confidence=confidence-0.01 WHERE id=$1', [Number(originalFacts[1]!.id)]);
  expect((await runPhaseConsolidate(engine, { sourceId: 'default', entitylessProposalTargetSlug: 'notes/review-target' }))
    .details.entityless_proposals_created).toBe(1);
  const afterChange = await engine.executeRaw<{ id: number; evidence: unknown; status: string }>(
    "SELECT id,evidence,status FROM take_proposals WHERE prompt_version='entityless-fact-review-v1' ORDER BY id");
  expect(afterChange).toHaveLength(2);
  expect(afterChange[0]!.status).toBe('evidence_rejected');
  expect((readEvidence(afterChange[1]!.evidence).facts as Array<Record<string, unknown>>).map(fact => Number(fact.id)))
    .toEqual(originalFacts.map(fact => Number(fact.id)));
  await engine.executeRaw("UPDATE take_proposals SET status='evidence_accepted' WHERE id=$1", [afterChange[1]!.id]);
  await engine.putPage('notes/review-target', {
    type: 'note', title: 'Review target', compiled_truth: 'Target page body revised.', frontmatter: {},
  }, { sourceId: 'default' });
  expect((await runPhaseConsolidate(engine, { sourceId: 'default', entitylessProposalTargetSlug: 'notes/review-target' }))
    .details.entityless_proposals_created).toBe(0);
  expect(await engine.executeRaw("SELECT id FROM take_proposals WHERE prompt_version='entityless-fact-review-v1'")).toHaveLength(2);
}));

test('target readiness and later target revisions regenerate the full changed fact group', async () => isolated(async () => {
  for (let index = 0; index < 3; index++) await seedFact({ text: `target revision synthetic fact ${index}` });
  await runPhaseConsolidate(engine, { sourceId: 'default', entitylessProposalTargetSlug: 'notes/late-target' });
  const [original] = await engine.executeRaw<{ evidence: unknown }>(
    "SELECT evidence FROM take_proposals WHERE prompt_version='entityless-fact-review-v1'");
  const originalEvidence = readEvidence(original!.evidence);
  const originalFacts = originalEvidence.facts as Array<Record<string, unknown>>;
  await engine.executeRaw('UPDATE facts SET confidence=confidence-0.01 WHERE id=$1', [Number(originalFacts[1]!.id)]);
  await seedTarget('notes/late-target');
  const factsAfterEdit = await factBytes();

  expect((await runPhaseConsolidate(engine, { sourceId: 'default', entitylessProposalTargetSlug: 'notes/late-target' }))
    .details.entityless_proposals_created).toBe(1);
  let proposals = await engine.executeRaw<{ evidence: unknown }>(
    "SELECT evidence FROM take_proposals WHERE prompt_version='entityless-fact-review-v1' ORDER BY id");
  expect(proposals).toHaveLength(2);
  const readyEvidence = readEvidence(proposals[1]!.evidence);
  expect((readyEvidence.target as Record<string, unknown>).revision).toBeTruthy();
  expect((readyEvidence.facts as Array<Record<string, unknown>>).map(fact => Number(fact.id)))
    .toEqual(originalFacts.map(fact => Number(fact.id)));
  expect((readyEvidence.facts as Array<Record<string, unknown>>).find(fact => Number(fact.id) === Number(originalFacts[1]!.id))?.confidence)
    .toBe(Number(originalFacts[1]!.confidence) - 0.01);
  expect(await factBytes()).toBe(factsAfterEdit);

  await engine.putPage('notes/late-target', {
    type: 'note', title: 'Review target', compiled_truth: 'Target page body revised.', frontmatter: {},
  }, { sourceId: 'default' });
  const revisedTarget = await engine.readPageSnapshot('notes/late-target', { sourceId: 'default' });
  expect(revisedTarget).toBeTruthy();
  expect((await runPhaseConsolidate(engine, { sourceId: 'default', entitylessProposalTargetSlug: 'notes/late-target' }))
    .details.entityless_proposals_created).toBe(1);
  proposals = await engine.executeRaw<{ evidence: unknown }>(
    "SELECT evidence FROM take_proposals WHERE prompt_version='entityless-fact-review-v1' ORDER BY id");
  expect(proposals).toHaveLength(3);
  const revisedEvidence = readEvidence(proposals[2]!.evidence);
  expect((revisedEvidence.target as Record<string, unknown>).revision).toBe(revisedTarget!.revision);
  expect((revisedEvidence.facts as Array<Record<string, unknown>>).map(fact => Number(fact.id)))
    .toEqual(originalFacts.map(fact => Number(fact.id)));
  expect(await factBytes()).toBe(factsAfterEdit);
}));

test('legacy producer identity keeps NULL evidence beside the versioned review evidence row', async () => isolated(async () => {
  for (let index = 0; index < 3; index++) await seedFact({ text: `collision synthetic fact ${index}` });
  await runPhaseConsolidate(engine, { sourceId: 'default', entitylessProposalTargetSlug: 'notes/collision-target' });
  const [review] = await engine.executeRaw<{ source_id: string; page_slug: string; content_hash: string; claim_text: string; evidence: unknown }>(
    "SELECT source_id,page_slug,content_hash,claim_text,evidence FROM take_proposals WHERE prompt_version='entityless-fact-review-v1'");
  await engine.executeRaw(`INSERT INTO take_proposals
      (source_id,page_slug,content_hash,prompt_version,proposal_run_id,status,claim_text,kind,holder,weight,domain,model_id)
    VALUES ($1,$2,$3,'legacy-entityless-producer-v0','legacy-entityless-run','pending',$4,'fact','self',0.8,
      'entityless-review','deterministic:legacy-fixture')`,
  [review!.source_id, review!.page_slug, review!.content_hash, review!.claim_text]);
  await runPhaseConsolidate(engine, { sourceId: 'default', entitylessProposalTargetSlug: 'notes/collision-target' });
  const rows = await engine.executeRaw<{ prompt_version: string; status: string; evidence: unknown }>(`SELECT prompt_version,status,evidence
    FROM take_proposals WHERE source_id=$1 AND page_slug=$2 AND content_hash=$3 AND claim_text=$4 ORDER BY prompt_version`,
  [review!.source_id, review!.page_slug, review!.content_hash, review!.claim_text]);
  expect(rows).toHaveLength(2);
  const legacy = rows.find(row => row.prompt_version === 'legacy-entityless-producer-v0');
  const versioned = rows.find(row => row.prompt_version === 'entityless-fact-review-v1');
  expect(legacy?.status).toBe('pending');
  expect(legacy?.evidence).toBeNull();
  expect(versioned?.status).toBe('evidence_pending');
  expect(readEvidence(versioned!.evidence).version).toBe(1);
}));

test('the internal opt-in requires a concrete source and a nonblank explicit target', async () => isolated(async () => {
  const missingSource = await runPhaseConsolidate(engine, { entitylessProposalTargetSlug: 'notes/target' });
  const missingTarget = await runPhaseConsolidate(engine, { sourceId: 'default', entitylessProposalTargetSlug: '   ' });
  expect(missingSource.error?.code).toBe('entityless_proposal_scope_required');
  expect(missingTarget.error?.code).toBe('entityless_proposal_scope_required');
  expect(await engine.executeRaw("SELECT id FROM take_proposals WHERE prompt_version='entityless-fact-review-v1'")).toHaveLength(0);
}));
