/**
 * Blank / whitespace-only entity_slug is stored as NULL and is not a
 * consolidate bucket or pending-consolidation backlog item.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { normalizeStoredEntitySlug } from '../src/core/engine-sql/facts.ts';
import { runPhaseConsolidate } from '../src/core/cycle/phases/consolidate.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

describe('normalizeStoredEntitySlug', () => {
  test('empty and whitespace become NULL; real slugs are trimmed', () => {
    expect(normalizeStoredEntitySlug(null)).toBeNull();
    expect(normalizeStoredEntitySlug(undefined)).toBeNull();
    expect(normalizeStoredEntitySlug('')).toBeNull();
    expect(normalizeStoredEntitySlug('   ')).toBeNull();
    expect(normalizeStoredEntitySlug('\t\n')).toBeNull();
    expect(normalizeStoredEntitySlug('people/alice-example')).toBe('people/alice-example');
    expect(normalizeStoredEntitySlug('  people/alice-example  ')).toBe('people/alice-example');
  });
});

describe('insertFact / insertFacts store blank slugs as NULL', () => {
  test('insertFact maps empty and whitespace-only entity_slug to NULL', async () => {
    const empty = await engine.insertFact(
      { fact: 'blank slug fact', kind: 'fact', entity_slug: '', source: 'unit' },
      { source_id: 'default' },
    );
    const spaces = await engine.insertFact(
      { fact: 'whitespace slug fact', kind: 'fact', entity_slug: '   ', source: 'unit' },
      { source_id: 'default' },
    );
    const emptyRow = await engine.executeRaw<{ entity_slug: string | null }>(
      `SELECT entity_slug FROM facts WHERE id = $1`, [empty.id],
    );
    const spacesRow = await engine.executeRaw<{ entity_slug: string | null }>(
      `SELECT entity_slug FROM facts WHERE id = $1`, [spaces.id],
    );
    expect(emptyRow[0].entity_slug).toBeNull();
    expect(spacesRow[0].entity_slug).toBeNull();
  });

  test('insertFacts maps empty and whitespace-only entity_slug to NULL', async () => {
    const { ids } = await engine.insertFacts(
      [
        { fact: 'bulk empty', kind: 'fact', entity_slug: '', source: 'unit', row_num: 1, source_markdown_slug: 'notes/blank-slug' },
        { fact: 'bulk spaces', kind: 'fact', entity_slug: '\t  ', source: 'unit', row_num: 2, source_markdown_slug: 'notes/blank-slug' },
        { fact: 'bulk real', kind: 'fact', entity_slug: 'people/alice-example', source: 'unit', row_num: 3, source_markdown_slug: 'notes/blank-slug' },
      ],
      { source_id: 'default' },
    );
    expect(ids.length).toBe(3);
    const rows = await engine.executeRaw<{ entity_slug: string | null }>(
      `SELECT entity_slug FROM facts WHERE id = ANY($1::bigint[]) ORDER BY row_num`,
      [ids],
    );
    expect(rows.map(r => r.entity_slug)).toEqual([null, null, 'people/alice-example']);
  });

  test('writeSingleFact stores a whitespace-only entity as NULL', async () => {
    const written = await writeSingleFact(engine, 'default', {
      fact: 'remember blank entity',
      provenance: 'unit',
      entity: '   ',
      remote: false,
    });
    expect(written.entity_slug).toBeNull();
    const [row] = await engine.executeRaw<{ entity_slug: string | null }>(
      `SELECT entity_slug FROM facts WHERE id = $1`,
      [written.id],
    );
    expect(row.entity_slug).toBeNull();
  });
});

describe('blank entity_slug excluded from consolidate and pending count', () => {
  test('countUnconsolidatedFacts ignores NULL and empty-string entity_slug', async () => {
    await engine.insertFact(
      { fact: 'no entity', kind: 'fact', entity_slug: '', source: 'unit' },
      { source_id: 'default' },
    );
    await engine.executeRaw(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, source)
       VALUES ('default', '', 'legacy empty slug', 'fact', 'unit')`,
    );
    await engine.insertFact(
      { fact: 'linked', kind: 'fact', entity_slug: 'people/alice-example', source: 'unit' },
      { source_id: 'default' },
    );
    expect(await engine.countUnconsolidatedFacts('default')).toBe(1);
  });

  test('consolidate does not bucket empty-string entity_slug rows', async () => {
    const old = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 4; i++) {
      await engine.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, source, valid_from)
         VALUES ('default', '', $1, 'fact', 'test', $2::timestamptz)`,
        [`empty bucket fact ${i}`, old],
      );
    }
    const r = await runPhaseConsolidate(engine, { dryRun: true, minFactsPerBucket: 3, minOldestAgeMs: 24 * 60 * 60 * 1000 });
    expect(r.details.facts_consolidated).toBe(0);
    expect(r.details.takes_written).toBe(0);
    expect(r.details.buckets_processed).toBe(0);
    expect(await engine.countUnconsolidatedFacts('default')).toBe(0);
  });
});
