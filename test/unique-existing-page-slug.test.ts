/**
 * Bare entity_slug → existing page via resolveSlugs.
 * Unique match links; ambiguous / no match leave the slug unchanged; never
 * creates pages.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { uniqueExistingPageSlug } from '../src/core/entities/resolve.ts';
import { writeSingleFact } from '../src/core/facts/write-single.ts';
import { resolveExtractedEntitiesForSave } from '../src/core/entities/resolve-on-save.ts';
import type { ExtractedFact } from '../src/core/facts/extract.ts';

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

async function seedPage(slug: string, title: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'note',
    title,
    compiled_truth: `# ${title}`,
    frontmatter: { type: 'note', title, slug },
  }, { sourceId: 'default' });
}

async function pageCount(): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>(`SELECT COUNT(*)::int AS n FROM pages WHERE deleted_at IS NULL`);
  return Number(row.n);
}

function extracted(entity_slug: string): ExtractedFact {
  return {
    fact: 'A fact about the tool',
    kind: 'fact',
    entity_slug,
    source: 'test',
    source_session: null,
    confidence: 1,
    notability: 'medium',
  };
}

describe('uniqueExistingPageSlug', () => {
  test('unique match links a bare slug to the existing page', async () => {
    await seedPage('tools/mattermost', 'Mattermost');
    expect(await uniqueExistingPageSlug(engine, 'default', 'mattermost')).toBe('tools/mattermost');
    expect(await pageCount()).toBe(1);
  });

  test('ambiguous match leaves the slug unchanged (returns null so the caller keeps the original)', async () => {
    await seedPage('tools/mattermost', 'Mattermost');
    await seedPage('wiki/mattermost-notes', 'Mattermost notes');
    expect(await uniqueExistingPageSlug(engine, 'default', 'mattermost')).toBeNull();
    expect(await pageCount()).toBe(2);
  });

  test('no match leaves the slug unchanged and creates no pages', async () => {
    expect(await uniqueExistingPageSlug(engine, 'default', 'mattermost')).toBeNull();
    expect(await pageCount()).toBe(0);
  });
});

describe('remember / extract_facts write-time linking', () => {
  test('writeSingleFact links a unique bare slug and does not create a page', async () => {
    await seedPage('tools/mattermost', 'Mattermost');
    const before = await pageCount();
    const written = await writeSingleFact(engine, 'default', {
      fact: 'Mattermost is the team chat',
      provenance: 'unit',
      entity: 'mattermost',
      remote: false,
    });
    expect(written.entity_slug).toBe('tools/mattermost');
    const [row] = await engine.executeRaw<{ entity_slug: string | null }>(
      `SELECT entity_slug FROM facts WHERE id = $1`, [written.id],
    );
    expect(row.entity_slug).toBe('tools/mattermost');
    expect(await pageCount()).toBe(before);
  });

  test('writeSingleFact leaves an unmatched bare slug unlinked and creates no page', async () => {
    const written = await writeSingleFact(engine, 'default', {
      fact: 'An unmatched tool preference',
      provenance: 'unit',
      entity: 'mattermost',
      remote: false,
    });
    expect(written.entity_slug).toBeNull();
    expect(await pageCount()).toBe(0);
  });

  test('resolveExtractedEntitiesForSave unique match; ambiguous and missing stay unlinked without new pages', async () => {
    await seedPage('tools/mattermost', 'Mattermost');
    const unique = [extracted('mattermost')];
    await resolveExtractedEntitiesForSave(engine, 'default', unique);
    expect(unique[0].entity_slug).toBe('tools/mattermost');

    await seedPage('wiki/mattermost-notes', 'Mattermost notes');
    const ambiguous = [extracted('mattermost')];
    await resolveExtractedEntitiesForSave(engine, 'default', ambiguous);
    expect(ambiguous[0].entity_slug).toBeNull();

    const missing = [extracted('no-such-page-xyz')];
    await resolveExtractedEntitiesForSave(engine, 'default', missing);
    expect(missing[0].entity_slug).toBeNull();
    expect(await pageCount()).toBe(2);
  });
});
