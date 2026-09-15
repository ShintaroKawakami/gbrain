/**
 * Tests for the top-level CLI dispatch guard introduced in multi-topology v1.
 *
 * When `~/.gbrain/config.json` has `remote_mcp` set, 9 commands are refused
 * with a canonical error pointing at the remote host:
 *   sync, embed, extract, migrate, apply-migrations, repair-jsonb, orphans,
 *   integrity, serve.
 *
 * Doctor is NOT in the refused set — it routes to runRemoteDoctor instead.
 *
 * Strategy: seed `~/.gbrain/config.json` with remote_mcp set in a tempdir
 * home, then spawn `gbrain <cmd>` via test/helpers/cli-spawn.ts (async
 * Bun.spawn — NOT execFileSync — so the test event loop stays responsive;
 * DATABASE_URL / GBRAIN_DATABASE_URL always stripped, HOME + GBRAIN_HOME
 * pinned to the temp home) and assert (a) exit code 1, (b) stderr contains
 * the canonical error message, (c) the local engine was never reached.
 * GBRAIN_REMOTE_CLIENT_SECRET is stripped per-call — the helper doesn't do
 * it and an ambient secret would alter thin-client auth routing.
 *
 * The 9 refusedCommands spawns run ONCE through runCliBatch (width 2 — the
 * machine-wide cap, see cli-spawn.ts) in the describe's beforeAll against a
 * single seeded thin-client home; the loop's tests assert on the cached
 * results. Sharing the home is safe because refusal happens at the dispatch
 * guard before any engine/filesystem work (that IS the invariant under
 * test), the seeded engine is `postgres` with no database_url (no scratch
 * store possible even under regression), and the loop asserts only on exit
 * code + stderr. Everything else still spawns its own child against a fresh
 * per-test home (dispatch wiring coverage).
 *
 * Includes a regression test that local-config installs still pass through
 * to connectEngine normally.
 */

import { describe, test as testRaw, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { join } from 'path';
import { tmpdir } from 'os';
import { runCli, runCliBatch, type CliResult } from './helpers/cli-spawn.ts';

function test(name: string, fn: () => void | Promise<unknown>): void {
  testRaw(name, fn, 30000);
}

// The original hand-rolled spawner stripped this alongside the database
// URLs; cli-spawn.ts strips only the URLs, so keep stripping it here.
const HERMETIC_ENV = { GBRAIN_REMOTE_CLIENT_SECRET: undefined } as const;

let tmp: string;

function configPath(home: string): string { return join(home, '.gbrain', 'config.json'); }

function seedThinClientConfig(home: string, extra: Record<string, unknown> = {}) {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(configPath(home), JSON.stringify({
    engine: 'postgres',
    remote_mcp: {
      issuer_url: 'https://brain-host.example',
      mcp_url: 'https://brain-host.example/mcp',
      oauth_client_id: 'cid',
      oauth_client_secret: 'csecret',
    },
    ...extra,
  }, null, 2));
}

function seedLocalPGLiteConfig(home: string) {
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(configPath(home), JSON.stringify({
    engine: 'pglite',
    database_path: join(home, 'brain.pglite'),
  }, null, 2));
}

async function run(args: string[]): Promise<CliResult> {
  return runCli(args, { home: tmp, env: HERMETIC_ENV });
}

// Fresh-home hooks for describes whose tests still spawn their own child.
// Registered per-describe (not module-level) so the batched refusal tests
// don't mint homes they never use.
function useFreshHome(): void {
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'gbrain-cli-dispatch-'));
  });
  afterEach(() => {
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ }
  });
}

describe('thin-client dispatch guard refuses DB-bound commands', () => {
  // Each command in the refused set MUST exit 1 with a canonical error and
  // MUST NOT attempt to connect to a local engine.
  const refusedCommands = [
    ['sync'],
    ['embed', '--stale'],
    ['extract', 'links'],
    // 'migrate' the engine-migration command (different from the migrations
    // orchestrator). Both are in CLI_ONLY but only `migrate-engine` here.
    ['migrate', '--to', 'pglite'],
    ['apply-migrations', '--yes'],
    ['repair-jsonb', '--dry-run'],
    ['orphans'],
    ['integrity', 'check'],
    ['serve'],
  ];

  // One shared seeded home for the batch (see file header for why sharing
  // is safe). Do NOT add anything here that writes to the home or depends
  // on another row's side effects — batch order is not execution order.
  let batchHome: string;
  const refused = new Map<string, CliResult>();

  beforeAll(async () => {
    batchHome = mkdtempSync(join(tmpdir(), 'gbrain-cli-dispatch-refuse-'));
    seedThinClientConfig(batchHome);
    const results = await runCliBatch(refusedCommands, { home: batchHome, env: HERMETIC_ENV });
    refusedCommands.forEach((argv, i) => refused.set(argv.join(' '), results[i]));
  }, 120_000);

  afterAll(() => {
    try { rmSync(batchHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function cached(argv: string[]): CliResult {
    const r = refused.get(argv.join(' '));
    if (!r) throw new Error(`not in refusedCommands batch: gbrain ${argv.join(' ')}`);
    return r;
  }

  for (const args of refusedCommands) {
    test(`refuses \`gbrain ${args.join(' ')}\` with pinpoint hint`, () => {
      const r = cached(args);
      expect(r.exitCode).toBe(1);
      // v0.31.1 (Issue #734): refusal carries an actionable hint via
      // THIN_CLIENT_REFUSE_HINTS instead of a generic "run on the remote
      // host" message. Hint format: "`gbrain <cmd>` is not routable. <hint>"
      expect(r.stderr).toContain(`gbrain ${args[0]}`);
      expect(r.stderr).toContain('thin-client of https://brain-host.example/mcp');
      expect(r.stderr).toContain('not routable');
    });
  }
});

describe('thin-client dispatch guard does NOT refuse safe commands', () => {
  useFreshHome();

  // Commands that are still useful in thin-client mode (init, auth, version,
  // help) MUST NOT be refused. We assert the canonical thin-client error
  // does NOT appear.
  test('`gbrain --version` works on thin-client install', async () => {
    seedThinClientConfig(tmp);
    const r = await run(['--version']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('gbrain');
    expect(r.stderr).not.toContain('thin client');
  });

  test('`gbrain --help` works on thin-client install', async () => {
    seedThinClientConfig(tmp);
    const r = await run(['--help']);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).not.toContain('requires a local engine');
  });
});

describe('thin-client doctor routes to runRemoteDoctor', () => {
  useFreshHome();

  test('`gbrain doctor` runs remote checks (not DB-bound checks) when remote_mcp is set', async () => {
    seedThinClientConfig(tmp);
    const r = await run(['doctor', '--json']);
    // Doctor will likely fail because brain-host.example isn't reachable —
    // but that's irrelevant. What matters is it ran the THIN-CLIENT doctor,
    // not the local-DB doctor. Fingerprint: the remote doctor's JSON output
    // has `mode: "thin-client"`. The local doctor doesn't.
    expect(r.stdout).toContain('"mode":"thin-client"');
    // Output must include the remote_mcp fields, NOT a schema_version check.
    expect(r.stdout).toContain('"mcp_url":"https://brain-host.example/mcp"');
  });
});

describe('regression — local config still passes through normally', () => {
  useFreshHome();

  testRaw('local `search --json` exposes an embed-unavailable empty as retrieval_degraded', async () => {
    // Real local-engine coverage for #2632: a fresh, keyless PGLite brain
    // reaches the keyword-only fallback with both embed_unavailable and
    // keyword_zero. It must not serialize that incomplete miss as `[]`.
    seedLocalPGLiteConfig(tmp);
    const r = await run(['search', 'unique-local-degraded-empty-2632', '--json']);
    expect(r.exitCode).toBe(1);
    const body = JSON.parse(r.stdout);
    expect(body.error).toBe('retrieval_degraded');
    expect(body.degraded).toEqual(['embed_unavailable', 'keyword_zero']);
    expect(r.stderr).toContain('retrieval_degraded');
  }, 120_000);

  test('local PGLite config does NOT trigger thin-client guard for `sync`', async () => {
    // Seed a local PGLite config (no remote_mcp). `gbrain sync` shouldn't
    // refuse with the thin-client error. It may error for other reasons
    // (no brain repo configured, etc.) — what matters is the canonical
    // thin-client message MUST NOT appear.
    seedLocalPGLiteConfig(tmp);
    const r = await run(['sync', '--dry-run']);
    expect(r.stderr).not.toContain('thin client');
    expect(r.stderr).not.toContain('requires a local engine');
  });

  test('local PGLite config does NOT trigger guard for `doctor`', async () => {
    seedLocalPGLiteConfig(tmp);
    const r = await run(['doctor', '--fast', '--json']);
    // Local doctor's output has different fingerprint — no `mode: thin-client`.
    expect(r.stdout).not.toContain('"mode":"thin-client"');
  });
});

describe('thin-client scratch-DB guard — jobs partial dispatch + config refusal', () => {
  useFreshHome();

  test('`gbrain config set x y` is refused with pinpoint hint', async () => {
    seedThinClientConfig(tmp);
    const r = await run(['config', 'set', 'search.reranker.enabled', 'false']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('gbrain config');
    expect(r.stderr).toContain('not routable');
    expect(r.stderr).toContain('thin-client of https://brain-host.example/mcp');
  });

  test('`gbrain jobs work` is refused with pinpoint hint (host-queue-bound)', async () => {
    seedThinClientConfig(tmp);
    const r = await run(['jobs', 'work']);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('gbrain jobs');
    expect(r.stderr).toContain('not routable');
    expect(r.stderr).toContain('thin-client of https://brain-host.example/mcp');
  });

  test('`gbrain jobs get` never fabricates a scratch local engine', async () => {
    // The regression this pins: on a thin-client install with a PGLite
    // engine key, `jobs get` connected a LOCAL engine before its remote
    // routing branch ran — creating an empty scratch PGLite store in the
    // thin-client GBRAIN_HOME and replaying the entire migration chain
    // ("Schema version 1 → N") on every invocation. The remote call to
    // brain-host.example will fail (unreachable) — irrelevant here. What
    // matters: no local store is created and no migration replay runs.
    seedThinClientConfig(tmp, { engine: 'pglite' });
    const r = await run(['jobs', 'get', '999']);
    expect(existsSync(join(tmp, '.gbrain', 'brain.pglite'))).toBe(false);
    expect(r.stdout + r.stderr).not.toContain('Schema version');
    expect(r.stdout + r.stderr).not.toContain('migration(s) pending');
    // A scratch store is a FRESH install, so a re-regression would print the
    // quiet-replay summary line, not the verbose header — pin both shapes.
    expect(r.stdout + r.stderr).not.toContain('Setting up brain schema');
  });

  test('`gbrain jobs list` never fabricates a scratch local engine', async () => {
    seedThinClientConfig(tmp, { engine: 'pglite' });
    const r = await run(['jobs', 'list']);
    expect(existsSync(join(tmp, '.gbrain', 'brain.pglite'))).toBe(false);
    expect(r.stdout + r.stderr).not.toContain('Schema version');
    expect(r.stdout + r.stderr).not.toContain('Setting up brain schema');
  });

  test('`gbrain think` never fabricates a scratch local engine', async () => {
    // Same class as jobs get: pglite-keyed thin client must not open a
    // scratch store / replay migrations before the remote think call.
    seedThinClientConfig(tmp, { engine: 'pglite' });
    const r = await run(['think', 'What do we know?']);
    expect(existsSync(join(tmp, '.gbrain', 'brain.pglite'))).toBe(false);
    expect(r.stdout + r.stderr).not.toContain('Schema version');
    expect(r.stdout + r.stderr).not.toContain('Setting up brain schema');
    expect(r.stdout + r.stderr).not.toContain('database_url is missing');
  });

  test('`gbrain think` on postgres-keyed thin client never demands database_url', async () => {
    // Topology 2 as shipped: engine postgres, remote_mcp set, no database_url.
    // Today's connectEngine() throws `database_url is missing` before
    // runThinkCli's isThinClient branch. Remote call to brain-host.example
    // will fail (unreachable) — irrelevant. Pin that connectEngine did not run.
    seedThinClientConfig(tmp, { engine: 'postgres' });
    const r = await run(['think', 'What do we know?']);
    expect(r.stdout + r.stderr).not.toContain('database_url is missing');
    expect(r.stdout + r.stderr).not.toContain('No brain configured');
  });
});

describe('thin-client search boundary — #2632 degraded-empty retrieval signaling', () => {
  // A real `gbrain search` spawn against an in-process fake MCP host (same
  // fixture pattern as test/remote-cli.test.ts: OAuth discovery + /token +
  // minimal /mcp JSON-RPC — no mock.module, so the file stays non-serial).
  //
  // The server decides what `search` returns; the pins hold the CLI side of
  // the #2632 contract:
  //   - a recall-affecting degraded+empty envelope (isError=true +
  //     error-shaped content[0] + _meta.retrieval) surfaces as a VISIBLE
  //     tool error (exit 1) — never as "No results." success;
  //   - the healthy zero-hit envelope keeps rendering "No results." with
  //     exit 0 — the boundary change is scoped to degraded empties only.
  let server: Server;
  let port: number;
  let fxHome: string;
  let searchResult: () => unknown;

  beforeAll(async () => {
    server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/.well-known/oauth-authorization-server') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ token_endpoint: `http://127.0.0.1:${port}/token`, issuer: `http://127.0.0.1:${port}` }));
        return;
      }
      if (req.url === '/token') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
          access_token: `fx-${Math.random().toString(36).slice(2)}`,
          token_type: 'bearer',
          expires_in: 3600,
          scope: 'read write admin',
        }));
        return;
      }
      if (req.url === '/mcp' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        if (body.id === undefined) { // notification (initialized)
          res.statusCode = 202;
          res.end();
          return;
        }
        let result: unknown;
        if (body.method === 'initialize') {
          result = {
            protocolVersion: body.params?.protocolVersion ?? '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'cli-dispatch-fx', version: '1' },
          };
        } else if (body.method === 'tools/call' && body.params?.name === 'search') {
          result = searchResult();
        } else {
          result = { content: [{ type: 'text', text: JSON.stringify({ ok: true }) }] };
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('failed to bind fixture');
    port = addr.port;

    fxHome = mkdtempSync(join(tmpdir(), 'gbrain-cli-dispatch-fx-'));
    mkdirSync(join(fxHome, '.gbrain'), { recursive: true });
    writeFileSync(join(fxHome, '.gbrain', 'config.json'), JSON.stringify({
      engine: 'postgres',
      remote_mcp: {
        issuer_url: `http://127.0.0.1:${port}`,
        mcp_url: `http://127.0.0.1:${port}/mcp`,
        oauth_client_id: 'cid',
        oauth_client_secret: 'csecret',
      },
    }, null, 2));
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    try { rmSync(fxHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  beforeEach(() => {
    searchResult = () => ({ content: [{ type: 'text', text: '[]' }] });
  });

  test('degraded-empty error envelope → visible tool error, exit 1, never "No results."', async () => {
    searchResult = () => ({
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
          degraded: [{ stage: 'embed_unavailable' }, { stage: 'keyword_zero' }],
          incomplete: true,
        },
      },
    });
    const r = await runCli(['search', 'anything'], { home: fxHome, env: HERMETIC_ENV });
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Remote tool search failed');
    expect(r.stderr).toContain('retrieval_degraded');
    // The load-bearing boundary: a degraded empty must never render as a
    // normal empty success on any CLI surface.
    expect(r.stdout).not.toContain('No results.');
  });

  test('healthy zero-hit envelope → "No results." clean-miss render, exit 0', async () => {
    searchResult = () => ({
      content: [
        { type: 'text', text: '[]' },
        { type: 'text', text: '0 results. no retrieval degradation — this is a clean miss.' },
      ],
      _meta: { retrieval: { returned_count: 0, degraded: [] } },
    });
    const r = await runCli(['search', 'anything'], { home: fxHome, env: HERMETIC_ENV });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No results.');
    expect(r.stdout).toContain('clean miss');
    expect(r.stderr).not.toContain('retrieval_degraded');
  });
});
