/**
 * WP2/D3/D8 + #2632 — the `_meta.retrieval` response channel, the
 * model-visible second content block on empty retrievals, and the
 * degraded-empty error signaling, driven through the REAL dispatch path
 * (dispatchToolCall → search op handler) with hybridSearchCached mocked.
 *
 * Pins the load-bearing behaviors:
 *   1. healthy empty results → bare-array body + SECOND text block (D8),
 *      successful [] shape unchanged (#2632);
 *   2. recall-affecting degraded+empty → error-shaped FIRST content block
 *      + isError=true + structured `_meta.retrieval` (#2632);
 *   3. ordering-only degradation (rerank/rescore omission) stays a
 *      successful [] — only recall-affecting stages flip;
 *   4. partial hits stay visible (array body) and are marked incomplete;
 *   5. a metaHook failure never drops the retrieval key (per-key isolation);
 *   6. metaHook keys merge ALONGSIDE retrieval, not over it.
 *
 * Serial: mock.module (isolation guard R2).
 */

import { describe, expect, mock, test } from 'bun:test';
import * as realHybrid from '../src/core/search/hybrid.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let nextResults: unknown[] = [];
let nextMeta: Record<string, unknown> | null = null;

// Mock BEFORE importing dispatch (operations.ts binds hybridSearchCached at
// import time; the spread keeps every other export live).
mock.module('../src/core/search/hybrid.ts', () => ({
  ...realHybrid,
  hybridSearchCached: async (
    _engine: unknown,
    _query: string,
    opts: { onMeta?: (m: unknown) => void },
  ) => {
    if (nextMeta) opts.onMeta?.(nextMeta);
    return nextResults;
  },
}));

const { dispatchToolCall } = await import('../src/mcp/dispatch.ts');

const engineStub = {
  getConfig: async () => null,
  executeRaw: async () => [],
} as unknown as BrainEngine;

const DEGRADED_META = {
  vector_enabled: false,
  expansion_applied: false,
  detail_resolved: null,
  retrieved_count: 3,
  degraded: [{ stage: 'embed_unavailable' }],
};

const CLEAN_META = {
  vector_enabled: true,
  expansion_applied: false,
  detail_resolved: null,
  retrieved_count: 0,
  degraded: [],
};

function callSearch(metaHook?: () => Promise<Record<string, unknown> | undefined>) {
  return dispatchToolCall(engineStub, 'search', { query: 'anything at all' }, {
    remote: true,
    transport: 'http',
    sourceId: 'default',
    ...(metaHook ? { metaHook } : {}),
  });
}

describe('dispatch response meta (WP2/D3/D8 + #2632)', () => {
  test('healthy empty → successful [] + second content block + _meta.retrieval (no flip)', async () => {
    nextResults = [];
    nextMeta = CLEAN_META;
    const out = await callSearch();
    expect(out.isError).toBeUndefined();
    // Body block 0 stays the bare array (deployed thin-clients parse only this).
    expect(JSON.parse(out.content[0].text)).toEqual([]);
    // D8: the model-visible diagnosis block.
    expect(out.content.length).toBe(2);
    expect(out.content[1].text).toContain('0 results');
    expect(out.content[1].text).toContain('clean miss');
    const retrieval = (out._meta as Record<string, any>).retrieval;
    expect(retrieval.returned_count).toBe(0);
    expect(retrieval.degraded).toEqual([]);
    expect(retrieval.incomplete).toBeUndefined();
  });

  test('recall-affecting degraded empty (embed_unavailable) → error first block + isError + retrieval meta', async () => {
    nextResults = [];
    nextMeta = DEGRADED_META;
    const out = await callSearch();
    expect(out.isError).toBe(true);
    // content[0] is the error envelope — NOT the [] body.
    const body = JSON.parse(out.content[0].text);
    expect(Array.isArray(body)).toBe(false);
    expect(body.error).toBe('retrieval_degraded');
    expect(body.degraded).toEqual(['embed_unavailable']);
    expect(String(body.message)).toContain('not a clean miss');
    // The D8 model-visible diagnosis still rides the second block.
    expect(out.content.length).toBe(2);
    expect(out.content[1].text).toContain('retrieved 3');
    expect(out.content[1].text).toContain('degraded: embed_unavailable');
    // Structured facts stay on the _meta channel.
    const retrieval = (out._meta as Record<string, any>).retrieval;
    expect(retrieval.returned_count).toBe(0);
    expect(retrieval.retrieved_count).toBe(3);
    expect(retrieval.degraded).toEqual([{ stage: 'embed_unavailable' }]);
    expect(retrieval.incomplete).toBe(true);
  });

  test('keyword_zero-only degraded empty → error flip (the #2632 scenario shape)', async () => {
    nextResults = [];
    nextMeta = {
      vector_enabled: false,
      expansion_applied: false,
      detail_resolved: null,
      retrieved_count: 0,
      degraded: [{ stage: 'keyword_zero' }],
    };
    const out = await callSearch();
    expect(out.isError).toBe(true);
    const body = JSON.parse(out.content[0].text);
    expect(body.error).toBe('retrieval_degraded');
    expect(body.degraded).toEqual(['keyword_zero']);
    expect((out._meta as Record<string, any>).retrieval.incomplete).toBe(true);
  });

  test('rerank/rescore omission (ordering-only) stays a successful [] — not recall-affecting', async () => {
    // rescore_skipped is the in-vocabulary ordering-only stage; a future /
    // skewed rerank-shaped code must ALSO not flip (only the closed
    // recall-affecting set may change the shape).
    nextResults = [];
    nextMeta = {
      vector_enabled: true,
      expansion_applied: false,
      detail_resolved: null,
      retrieved_count: 0,
      degraded: [{ stage: 'rescore_skipped' }, { stage: 'rerank_skipped' }],
    };
    const out = await callSearch();
    expect(out.isError).toBeUndefined();
    expect(JSON.parse(out.content[0].text)).toEqual([]);
    expect(out.content.length).toBe(2);
    expect(out.content[1].text).toContain('degraded: rescore_skipped, rerank_skipped');
    const retrieval = (out._meta as Record<string, any>).retrieval;
    expect(retrieval.incomplete).toBeUndefined();
  });

  test('partial hits stay visible as the array body and are marked incomplete', async () => {
    nextResults = [{ page_id: 1, slug: 'a', chunk_text: 'x' }];
    nextMeta = DEGRADED_META;
    const out = await callSearch();
    expect(out.isError).toBeUndefined();
    const body = JSON.parse(out.content[0].text);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    // Non-empty results never get the D8 second block.
    expect(out.content.length).toBe(1);
    const retrieval = (out._meta as Record<string, any>).retrieval;
    expect(retrieval.returned_count).toBe(1);
    expect(retrieval.incomplete).toBe(true);
    expect(retrieval.degraded).toEqual([{ stage: 'embed_unavailable' }]);
  });

  test('false-healthy guard — a legacy first-array-only consumer cannot call degraded empty a normal success', async () => {
    // Deployed thin-client shape: JSON.parse(content[0].text) and treat it
    // as the result list, isError never consulted. On degraded empty that
    // consumer must NOT observe "successful empty array" — while the
    // healthy twin still does.
    nextResults = [];
    nextMeta = DEGRADED_META;
    const degraded = await callSearch();
    const degradedParsed = JSON.parse(degraded.content[0].text);
    const degradedReadsAsNormalEmpty =
      degraded.isError !== true && Array.isArray(degradedParsed) && degradedParsed.length === 0;
    expect(degradedReadsAsNormalEmpty).toBe(false);

    nextMeta = CLEAN_META;
    const healthy = await callSearch();
    const healthyParsed = JSON.parse(healthy.content[0].text);
    expect(healthy.isError).toBeUndefined();
    expect(Array.isArray(healthyParsed) && healthyParsed.length === 0).toBe(true);
  });

  test('degraded key absent (pre-stamp meta) → no flip, healthy empty shape', async () => {
    // Old-server / pre-D6 meta carries no degraded stamp at all — the base
    // retrieval meta still emits, the D8 block still names a clean miss,
    // and the response stays a successful [].
    nextResults = [];
    nextMeta = { vector_enabled: true, expansion_applied: false, detail_resolved: null };
    const out = await callSearch();
    expect(out.isError).toBeUndefined();
    expect(JSON.parse(out.content[0].text)).toEqual([]);
    expect(out.content.length).toBe(2);
    expect(out.content[1].text).toContain('clean miss');
    expect((out._meta as Record<string, any>).retrieval.degraded).toBeUndefined();
  });

  test('metaHook failure never drops the retrieval key (per-key isolation)', async () => {
    nextResults = [];
    nextMeta = DEGRADED_META;
    const out = await callSearch(async () => { throw new Error('hot memory down'); });
    expect((out._meta as Record<string, any>).retrieval).toBeDefined();
    expect((out._meta as Record<string, any>).retrieval.incomplete).toBe(true);
  });

  test('metaHook keys merge alongside retrieval, not over it', async () => {
    nextResults = [];
    nextMeta = DEGRADED_META;
    const out = await callSearch(async () => ({ brain_hot_memory: { facts: [] } }));
    const meta = out._meta as Record<string, any>;
    expect(meta.retrieval).toBeDefined();
    expect(meta.brain_hot_memory).toEqual({ facts: [] });
  });
});

describe('recallAffectingStages + envelope (unit)', () => {
  test('closed-set membership, dedupe, and garbage tolerance', async () => {
    const { recallAffectingStages, RECALL_AFFECTING_STAGES } = await import('../src/mcp/dispatch.ts');
    expect(recallAffectingStages(null)).toEqual([]);
    expect(recallAffectingStages('nope')).toEqual([]);
    expect(recallAffectingStages({ degraded: 'nope' })).toEqual([]);
    expect(recallAffectingStages({})).toEqual([]);
    expect(
      recallAffectingStages({
        degraded: [
          { stage: 'keyword_zero' },
          { stage: 'keyword_zero' },
          { stage: 'cache_prestamp' },
          { stage: 'budget_truncated' },
        ],
      }),
    ).toEqual(['keyword_zero']);
    // Every recall-affecting code is a real D6 vocabulary member.
    for (const stage of RECALL_AFFECTING_STAGES) {
      expect(stage).toMatch(/^[a-z_]+$/);
    }
  });

  test('envelope names the stages and stays JSON-roundtrippable', async () => {
    const { buildDegradedEmptyRetrievalEnvelope } = await import('../src/mcp/dispatch.ts');
    const envelope = buildDegradedEmptyRetrievalEnvelope(['embed_unavailable', 'keyword_zero']);
    expect(envelope.error).toBe('retrieval_degraded');
    expect(envelope.degraded).toEqual(['embed_unavailable', 'keyword_zero']);
    expect(String(envelope.message)).toContain('embed_unavailable, keyword_zero');
    expect(JSON.parse(JSON.stringify(envelope))).toEqual(envelope);
  });
});

describe('buildEmptyRetrievalBlock (unit)', () => {
  test('hint passthrough + stage dedupe + garbage tolerance', async () => {
    const { buildEmptyRetrievalBlock } = await import('../src/mcp/dispatch.ts');
    const text = buildEmptyRetrievalBlock({
      retrieved_count: 5,
      degraded: [{ stage: 'embed_timeout' }, { stage: 'embed_timeout' }, { stage: 'budget_dropped_all' }],
      hint: 'try the query tool.',
    });
    expect(text).toContain('retrieved 5');
    expect(text).toContain('degraded: embed_timeout, budget_dropped_all');
    expect(text).toContain('hint: try the query tool.');
    expect((text!.match(/embed_timeout/g) ?? []).length).toBe(1);
    expect(buildEmptyRetrievalBlock(null)).toBeNull();
    expect(buildEmptyRetrievalBlock('nope')).toBeNull();
  });
});
