/**
 * T15/FOV-1 — the CLI surfaces retrieval degradation on empty results, and
 * the thin-client parser tolerates the D8 second content block.
 *
 * Before this, `cli.ts` returned a bare "No results." BEFORE the --explain
 * branch, and `unpackToolResult` discarded `_meta` — so both CLI surfaces
 * printed nothing diagnosable while the server knew exactly why the result
 * was empty.
 *
 * #2632 additions: a recall-affecting degraded+empty retrieval arrives from
 * the server as an ERROR envelope (isError=true, error-shaped content[0],
 * `_meta.retrieval.incomplete`). The real thin-client path (callRemoteTool)
 * turns isError into a visible RemoteMcpError before unpackToolResult ever
 * runs — these pins hold the line one level deeper: even a skew-aged
 * consumer that only parses content[0] gets an error object, never a
 * normal [] success.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { formatResult, captureRetrievalMeta, resetRetrievalMetaForTests } from '../src/cli.ts';
import { unpackToolResult, extractResponseMeta } from '../src/core/mcp-client.ts';

afterEach(() => resetRetrievalMetaForTests());

describe('formatResult empty-result rendering (T15)', () => {
  test('no meta captured → bare No results (old servers / non-retrieval paths)', () => {
    expect(formatResult('search', [], {})).toBe('No results.\n');
  });

  test('degraded meta → cause named inline', () => {
    captureRetrievalMeta('retrieval', {
      returned_count: 0,
      retrieved_count: 3,
      degraded: [{ stage: 'embed_unavailable' }, { stage: 'embed_unavailable' }],
    });
    const out = formatResult('query', [], {});
    expect(out).toContain('No results.');
    expect(out).toContain('retrieved 3 before trimming');
    expect(out).toContain('degraded: embed_unavailable');
    expect((out.match(/embed_unavailable/g) ?? []).length).toBe(1);
  });

  test('clean-miss meta → clean miss named', () => {
    captureRetrievalMeta('retrieval', { returned_count: 0, retrieved_count: 0, degraded: [] });
    expect(formatResult('search', [], {})).toContain('clean miss — no retrieval degradation');
  });

  test('non-retrieval keys are ignored by the capture', () => {
    captureRetrievalMeta('warnings', [{ code: 'unknown_param', param: 'lmit' }]);
    expect(formatResult('search', [], {})).toBe('No results.\n');
  });

  test('--json path is untouched (machine output stays a bare array)', () => {
    captureRetrievalMeta('retrieval', { degraded: [{ stage: 'embed_timeout' }] });
    expect(formatResult('search', [], { json: true })).toBe('[]\n');
  });
});

describe('thin-client envelope handling (ENG-17 skew guard)', () => {
  const twoBlockEnvelope: unknown = {
    content: [
      { type: 'text', text: '[]' },
      { type: 'text', text: '0 results. degraded: embed_unavailable.' },
    ],
    _meta: { retrieval: { returned_count: 0, degraded: [{ stage: 'embed_unavailable' }] } },
  };

  test('unpackToolResult parses content[0] only — the D8 second block never trips it', () => {
    expect(unpackToolResult<unknown[]>(twoBlockEnvelope)).toEqual([]);
  });

  test('extractResponseMeta lifts _meta; absent on old servers → undefined', () => {
    const meta = extractResponseMeta(twoBlockEnvelope);
    expect((meta as any).retrieval.degraded[0].stage).toBe('embed_unavailable');
    expect(extractResponseMeta({ content: [{ type: 'text', text: '[]' }] })).toBeUndefined();
    expect(extractResponseMeta({ content: [{ type: 'text', text: '[]' }], _meta: ['not-an-object'] })).toBeUndefined();
  });
});

describe('degraded-empty error envelope on the thin-client boundary (#2632)', () => {
  // The envelope dispatch emits for a recall-affecting degraded+empty
  // retrieval (shape pinned end-to-end in dispatch-response-meta.serial.test.ts):
  // isError=true, error-shaped content[0], D8 diagnosis as content[1], and
  // the structured facts on _meta.retrieval.
  const degradedEmptyEnvelope: unknown = {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: 'retrieval_degraded',
          message: 'Search returned 0 results while retrieval was degraded (embed_unavailable, keyword_zero) — this is not a clean miss; matching pages may exist.',
          degraded: ['embed_unavailable', 'keyword_zero'],
        }, null, 2),
      },
      { type: 'text', text: '0 results. degraded: embed_unavailable, keyword_zero.' },
    ],
    _meta: {
      retrieval: {
        returned_count: 0,
        retrieved_count: 0,
        degraded: [{ stage: 'embed_unavailable' }, { stage: 'keyword_zero' }],
        incomplete: true,
      },
    },
  };

  test('a legacy first-array-only consumer cannot read the degraded empty as a result list', () => {
    // Even a consumer that skips the isError check entirely and parses
    // content[0] (unpackToolResult's exact posture) gets an error object —
    // never a normal empty array it could treat as "no matches exist".
    const parsed = unpackToolResult<unknown>(degradedEmptyEnvelope);
    expect(Array.isArray(parsed)).toBe(false);
    expect((parsed as { error?: string }).error).toBe('retrieval_degraded');
    expect((parsed as { degraded?: string[] }).degraded).toEqual(['embed_unavailable', 'keyword_zero']);
  });

  test('extractResponseMeta still lifts _meta.retrieval (with the incomplete stamp) off the error envelope', () => {
    const meta = extractResponseMeta(degradedEmptyEnvelope) as { retrieval: Record<string, unknown> };
    expect(meta.retrieval.incomplete).toBe(true);
    expect((meta.retrieval.degraded as Array<{ stage: string }>)[0].stage).toBe('embed_unavailable');
  });

  test('the healthy twin still unpacks as a normal empty array (boundary unchanged)', () => {
    const healthy: unknown = {
      content: [
        { type: 'text', text: '[]' },
        { type: 'text', text: '0 results. no retrieval degradation — this is a clean miss.' },
      ],
      _meta: { retrieval: { returned_count: 0, degraded: [] } },
    };
    expect(unpackToolResult<unknown[]>(healthy)).toEqual([]);
  });

  test('formatResult render tolerates the incomplete flag (additive _meta field)', () => {
    captureRetrievalMeta('retrieval', {
      returned_count: 0,
      retrieved_count: 2,
      degraded: [{ stage: 'keyword_zero' }],
      incomplete: true,
    });
    const out = formatResult('search', [], {});
    expect(out).toContain('No results.');
    expect(out).toContain('degraded: keyword_zero');
    // --json stays a bare array — machine output never carries the prose.
    expect(formatResult('search', [], { json: true })).toBe('[]\n');
  });
});
