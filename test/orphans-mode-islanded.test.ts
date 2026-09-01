/**
 * #4524 — `find_orphans` / `gbrain orphans` counted pages with NO INBOUND
 * link, while `get_health.orphan_pages` counted ISLANDED pages (no inbound
 * AND no outbound, endpoint-liveness both ways). Mid-curation the two
 * numbers diverged wildly (145 vs 20 on a real brain), so doctor-driven
 * enrichment loops chased a count the orphans tool disagreed with.
 *
 * One canonical policy now: `findOrphanPages` takes `mode:
 * 'inbound' | 'islanded'` and DEFAULTS to 'islanded' — health's definition —
 * so every consumer (orphans CLI, find_orphans op, doctor orphan_ratio,
 * get_health.orphan_pages) agrees by construction. The old no-inbound view
 * stays reachable via mode: 'inbound'.
 *
 * #2336 — source-membership edges are registry plumbing, not semantic graph
 * connectivity. Membership-only pages must remain visible as islanded while
 * manual, markdown, and legacy NULL-provenance links still count. Filtering
 * every non-manual provenance was rejected because it would erase legitimate
 * extractor links; only `gbrain-source-membership-v1` is non-semantic here.
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { findOrphans } from '../src/commands/orphans.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();

  // island: no inbound, no outbound → orphan under BOTH definitions.
  await engine.putPage('people/island', {
    type: 'person', title: 'Island', compiled_truth: 'body', timeline: '', frontmatter: {},
  });
  // hub: no inbound, but LINKS OUT to spoke → orphan only under 'inbound'.
  await engine.putPage('people/hub', {
    type: 'person', title: 'Hub', compiled_truth: 'body', timeline: '', frontmatter: {},
  });
  // spoke: inbound from hub → not an orphan under either definition.
  await engine.putPage('people/spoke', {
    type: 'person', title: 'Spoke', compiled_truth: 'body', timeline: '', frontmatter: {},
  });
  await engine.addLink('people/hub', 'people/spoke', 'knows', 'knows');

  const extraPages = [
    'membership-out', 'membership-target',
    'manual-out', 'manual-target',
    'markdown-out', 'markdown-target',
    'legacy-null-out', 'legacy-null-target',
    'deleted-source', 'live-target-from-deleted',
    'live-source-to-deleted', 'deleted-target',
  ];
  for (const slug of extraPages) {
    await engine.putPage(`people/${slug}`, {
      type: 'person', title: slug, compiled_truth: 'body', timeline: '', frontmatter: {},
    });
  }
  await engine.addLinksBatch([
    {
      from_slug: 'people/membership-out',
      to_slug: 'people/membership-target',
      link_type: 'belongs_to_source',
      link_source: 'gbrain-source-membership-v1',
      context: '',
    },
    {
      from_slug: 'people/manual-out',
      to_slug: 'people/manual-target',
      link_type: 'related',
      link_source: 'manual',
      context: '',
    },
    {
      from_slug: 'people/markdown-out',
      to_slug: 'people/markdown-target',
      link_type: 'related',
      link_source: 'markdown',
      context: '',
    },
    {
      from_slug: 'people/legacy-null-out',
      to_slug: 'people/legacy-null-target',
      link_type: 'related',
      link_source: 'manual',
      context: '',
    },
    {
      from_slug: 'people/deleted-source',
      to_slug: 'people/live-target-from-deleted',
      link_type: 'related',
      link_source: 'manual',
      context: '',
    },
    {
      from_slug: 'people/live-source-to-deleted',
      to_slug: 'people/deleted-target',
      link_type: 'related',
      link_source: 'manual',
      context: '',
    },
  ]);
  await engine.executeRaw(`
    UPDATE links
    SET link_source = NULL
    WHERE from_page_id = (SELECT id FROM pages WHERE slug = 'people/legacy-null-out')
      AND to_page_id = (SELECT id FROM pages WHERE slug = 'people/legacy-null-target')
  `);
  await engine.executeRaw(`
    UPDATE pages
    SET deleted_at = NOW()
    WHERE slug IN ('people/deleted-source', 'people/deleted-target')
  `);
});

afterAll(async () => {
  await engine.disconnect();
});

describe('findOrphanPages mode (#4524)', () => {
  test("default = 'islanded' (health's definition): outbound-only pages are NOT orphans", async () => {
    const rows = await engine.findOrphanPages();
    const slugs = rows.map(r => r.slug);
    expect(slugs).toContain('people/island');
    expect(slugs).not.toContain('people/hub');
    expect(slugs).not.toContain('people/spoke');
    expect(slugs).toContain('people/membership-out');
    expect(slugs).toContain('people/membership-target');
    expect(slugs).not.toContain('people/manual-out');
    expect(slugs).not.toContain('people/manual-target');
    expect(slugs).not.toContain('people/markdown-out');
    expect(slugs).not.toContain('people/markdown-target');
    expect(slugs).not.toContain('people/legacy-null-out');
    expect(slugs).not.toContain('people/legacy-null-target');
    expect(slugs).toContain('people/live-target-from-deleted');
    expect(slugs).toContain('people/live-source-to-deleted');
    expect(slugs).not.toContain('people/deleted-source');
    expect(slugs).not.toContain('people/deleted-target');
  });

  test("mode: 'inbound' preserves the old no-inbound view", async () => {
    const rows = await engine.findOrphanPages({ mode: 'inbound' });
    const slugs = rows.map(r => r.slug);
    expect(slugs).toContain('people/island');
    expect(slugs).toContain('people/hub');
    expect(slugs).not.toContain('people/spoke');
    expect(slugs).toContain('people/membership-out');
    expect(slugs).toContain('people/membership-target');
    expect(slugs).toContain('people/manual-out');
    expect(slugs).not.toContain('people/manual-target');
    expect(slugs).toContain('people/markdown-out');
    expect(slugs).not.toContain('people/markdown-target');
    expect(slugs).toContain('people/legacy-null-out');
    expect(slugs).not.toContain('people/legacy-null-target');
    expect(slugs).toContain('people/live-target-from-deleted');
    expect(slugs).toContain('people/live-source-to-deleted');
  });

  test("mode: 'islanded' explicit matches the default", async () => {
    const def = (await engine.findOrphanPages()).map(r => r.slug).sort();
    const exp = (await engine.findOrphanPages({ mode: 'islanded' })).map(r => r.slug).sort();
    expect(exp).toEqual(def);
  });

  test('findOrphans (policy fn) agrees with get_health.orphan_pages by construction', async () => {
    const health = await engine.getHealth();
    const result = await findOrphans(engine, {});
    // Direct health regression: island + two membership-only endpoints + two
    // live pages whose only far endpoint is soft-deleted. Manual, markdown,
    // and legacy NULL-provenance pairs must not enter this count.
    expect(health.orphan_pages).toBe(5);
    expect(result.total_orphans).toBe(health.orphan_pages);
  });
});
