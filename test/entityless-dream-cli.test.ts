import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runDream } from '../src/commands/dream.ts';
import { validateCommandFlags } from '../src/cli.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
const testHome = mkdtempSync(join(tmpdir(), 'gbrain-entityless-dream-cli-'));
const brainDir = join(testHome, 'brain');

beforeAll(async () => {
  await withEnv({ HOME: testHome, GBRAIN_HOME: testHome, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    mkdirSync(brainDir, { recursive: true });
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

async function seedFacts(): Promise<string> {
  const vector = new Float32Array(1536);
  vector[0] = 1;
  for (let index = 0; index < 3; index++) {
    const fact = `CLI synthetic fact ${index}`;
    await engine.executeRaw(`INSERT INTO facts
      (source_id,entity_slug,fact,kind,visibility,notability,valid_from,source,source_session,confidence,
       embedding,embedded_at,embedding_model,embedded_text_hash)
      VALUES ('default',NULL,$1,'fact','world','medium',now()-interval '30 hours','entityless-cli-test',
        $2,0.8,$3::vector,now(),'openai:text-embedding-3-large',md5($1))`,
    [fact, `cli-session-${index}`, `[${Array.from(vector).join(',')}]`]);
  }
  const rows = await engine.executeRaw(`SELECT id,source_id,entity_slug,fact,valid_from,valid_until,expired_at,
      superseded_by,consolidated_at,consolidated_into,source_session,confidence,embedding_model,embedded_text_hash
    FROM facts WHERE source_id='default' ORDER BY id`);
  return JSON.stringify(rows);
}

async function proposalCount(): Promise<number> {
  const rows = await engine.executeRaw<{ count: number | string }>(
    "SELECT count(*)::int AS count FROM take_proposals WHERE prompt_version='entityless-fact-review-v1'");
  return Number(rows[0]!.count);
}

async function expectUsageError(args: string[]): Promise<void> {
  const exit = spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    throw new Error(`process.exit(${String(code)})`);
  });
  const error = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await expect(runDream(engine, ['--dir', brainDir, ...args])).rejects.toThrow('process.exit(2)');
    expect(exit).toHaveBeenCalledWith(2);
  } finally {
    exit.mockRestore();
    error.mockRestore();
  }
}

test('top-level dream flag validation accepts an explicit entityless target and rejects a typo', () => {
  expect(validateCommandFlags('dream', [
    '--phase', 'consolidate', '--source', 'default', '--entityless-proposal-target', 'notes/cli-target',
  ])).toBeNull();
  expect(validateCommandFlags('dream', [
    '--phase', 'consolidate', '--source', 'default', '--entityless-proposal-targett', 'notes/cli-target',
  ])).toBe('--entityless-proposal-targett');
});

test('entityless proposal scope errors abort before phase writes, even with an implicit source environment', async () => isolated(async () => {
  const beforeFacts = await seedFacts();
  const invalidInvocations = [
    ['--phase', 'consolidate', '--entityless-proposal-target', 'notes/cli-target'],
    ['--phase', 'consolidate', '--source', 'default', '--entityless-proposal-target', '   '],
    ['--phase', 'consolidate', '--source', 'default', '--entityless-proposal-target'],
    ['--phase', 'consolidate', '--source', 'default', '--entityless-proposal-target', '--phase', 'consolidate'],
    ['--phase', 'consolidate', '--source', 'default', '--entityless-proposal-target', '__all__'],
    ['--phase', 'consolidate', '--source', '__all__', '--entityless-proposal-target', 'notes/cli-target'],
    ['--source', 'default', '--entityless-proposal-target', 'notes/cli-target'],
    ['--phase', 'consolidate', '--source', 'default', '--entityless-proposal-target', 'notes/one', '--entityless-proposal-target', 'notes/two'],
  ];
  for (const args of invalidInvocations) {
    await expectUsageError(args);
    expect(await proposalCount()).toBe(0);
    const currentFacts = await engine.executeRaw(`SELECT id,source_id,entity_slug,fact,valid_from,valid_until,expired_at,
        superseded_by,consolidated_at,consolidated_into,source_session,confidence,embedding_model,embedded_text_hash
      FROM facts WHERE source_id='default' ORDER BY id`);
    expect(JSON.stringify(currentFacts)).toBe(beforeFacts);
  }
  await withEnv({ GBRAIN_SOURCE: 'default' }, () => expectUsageError([
    '--phase', 'consolidate', '--entityless-proposal-target', 'notes/cli-target',
  ]));
  expect(await proposalCount()).toBe(0);
}));

test('the explicit source-id alias threads the target, identical target repeats are accepted, and dry-run writes no proposal', async () => isolated(async () => {
  const beforeFacts = await seedFacts();
  const dryRun = await runDream(engine, ['--dir', brainDir, '--phase', 'consolidate', '--source-id', 'default',
    '--entityless-proposal-target', 'notes/cli-target', '--dry-run', '--json']);
  expect(dryRun?.phases[0]?.details.dryRun).toBe(true);
  expect(await proposalCount()).toBe(0);
  expect(JSON.stringify(await engine.executeRaw(`SELECT id,source_id,entity_slug,fact,valid_from,valid_until,expired_at,
      superseded_by,consolidated_at,consolidated_into,source_session,confidence,embedding_model,embedded_text_hash
    FROM facts WHERE source_id='default' ORDER BY id`))).toBe(beforeFacts);

  const run = await runDream(engine, ['--dir', brainDir, '--phase', 'consolidate', '--source-id', 'default',
    '--entityless-proposal-target', 'notes/cli-target', '--entityless-proposal-target', ' notes/cli-target ', '--json']);
  expect(run?.phases.map(phase => phase.phase)).toEqual(['consolidate']);
  expect(run?.phases[0]?.details.entityless_proposals_created).toBe(1);
  expect(await proposalCount()).toBe(1);
  expect(JSON.stringify(await engine.executeRaw(`SELECT id,source_id,entity_slug,fact,valid_from,valid_until,expired_at,
      superseded_by,consolidated_at,consolidated_into,source_session,confidence,embedding_model,embedded_text_hash
    FROM facts WHERE source_id='default' ORDER BY id`))).toBe(beforeFacts);
}));

test('omitting the proposal flag keeps consolidate behavior unchanged', async () => isolated(async () => {
  await seedFacts();
  await runDream(engine, ['--dir', brainDir, '--phase', 'consolidate', '--source', 'default', '--json']);
  expect(await proposalCount()).toBe(0);
}));

test('nightly source config opts in only for an explicit source and the CLI target takes precedence', async () => isolated(async () => {
  await seedFacts();
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
  const key = 'dream.consolidate.entityless.default';
  await engine.setConfig(key, JSON.stringify({ source_incarnation: source!.incarnation, target_slug: 'notes/nightly-target' }));

  await withEnv({ GBRAIN_SOURCE: undefined }, async () => {
    await runDream(engine, ['--dir', brainDir, '--phase', 'consolidate', '--json']);
    expect(await proposalCount()).toBe(0);
  });

  const configured = await runDream(engine, ['--dir', brainDir, '--phase', 'consolidate', '--source', 'default', '--json']);
  expect(configured?.phases[0]?.details.entityless_proposals_created).toBe(1);
  const [nightlyProposal] = await engine.executeRaw<{ page_slug: string }>(
    "SELECT page_slug FROM take_proposals WHERE prompt_version='entityless-fact-review-v1'");
  expect(nightlyProposal?.page_slug).toBe('notes/nightly-target');

  await resetPgliteState(engine);
  await seedFacts();
  await engine.setConfig(key, '{"source_incarnation":"stale","target_slug":"notes/ignored-config"}');
  const overridden = await runDream(engine, ['--dir', brainDir, '--phase', 'consolidate', '--source', 'default',
    '--entityless-proposal-target', 'notes/cli-override', '--json']);
  expect(overridden?.phases[0]?.details.entityless_proposals_created).toBe(1);
  const [overrideProposal] = await engine.executeRaw<{ page_slug: string }>(
    "SELECT page_slug FROM take_proposals WHERE prompt_version='entityless-fact-review-v1'");
  expect(overrideProposal?.page_slug).toBe('notes/cli-override');
}));

test('malformed or stale nightly config fails before proposal or fact writes', async () => isolated(async () => {
  const beforeFacts = await seedFacts();
  const [source] = await engine.executeRaw<{ incarnation: string }>("SELECT incarnation FROM sources WHERE id='default'");
  const key = 'dream.consolidate.entityless.default';
  const invalidConfigs = [
    JSON.stringify({ source_incarnation: source!.incarnation, target_slug: 'notes/invalid-target', extra: true }),
    JSON.stringify({ source_incarnation: 'stale-incarnation', target_slug: 'notes/invalid-target' }),
  ];
  for (const value of invalidConfigs) {
    await engine.setConfig(key, value);
    const exit = spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(runDream(engine, ['--dir', brainDir, '--phase', 'consolidate', '--source', 'default', '--json']))
        .rejects.toThrow('process.exit(1)');
      expect(exit).toHaveBeenCalledWith(1);
    } finally {
      exit.mockRestore();
      error.mockRestore();
    }
    expect(await proposalCount()).toBe(0);
    expect(JSON.stringify(await engine.executeRaw(`SELECT id,source_id,entity_slug,fact,valid_from,valid_until,expired_at,
        superseded_by,consolidated_at,consolidated_into,source_session,confidence,embedding_model,embedded_text_hash
      FROM facts WHERE source_id='default' ORDER BY id`))).toBe(beforeFacts);
  }
}));
