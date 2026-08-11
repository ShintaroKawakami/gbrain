/**
 * Manual/destructive migration gate (#1553) — v126 oauth_clients reset.
 *
 * v126 is destructive (resets every client to pending, deletes tokens/codes)
 * and one-shot (`idempotent: false`). It must never auto-apply from the
 * ordinary connectEngine / serve startup path (engine initSchema()); only a
 * runMigrations call holding a ONE-SHOT ManualMigrationCapability — issued
 * by the `gbrain apply-migrations --yes` CLI dispatch and passed via
 * RunMigrationsOptions.manualCapability — may run it. The capability is
 * consumed the moment the runner crosses the gate, so one approval can
 * never implicitly authorize a later manual migration in the same process.
 * There is no module-global grant: issuing a capability does not arm the
 * runner, and ordinary paths have nothing to pick up. These tests pin all
 * four halves:
 *
 *   1. The ordinary path fails closed BEFORE v126: SQL never runs,
 *      config.version is not advanced to it or past it, and the runner
 *      reports the stop via the typed `blocked` result.
 *   2. The authorized path applies v126 exactly once; a retry is a no-op
 *      and does not reset clients that were approved after the first run.
 *   3. Holding an issued capability does NOT arm the runner — only passing
 *      it to runMigrations crosses the gate, and the crossing consumes it.
 *   4. The capability is one-shot: after an authorized run, a later run in
 *      the SAME process with a manual migration pending again blocks —
 *      both with no capability and when REUSING the consumed one — until a
 *      fresh capability is issued.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  MIGRATIONS,
  LATEST_VERSION,
  runMigrations,
  hasPendingMigrations,
  pendingManualMigration,
  ManualMigrationCapability,
} from '../src/core/migrate.ts';

const V126_BLOCK = { version: 126, name: 'oauth_clients_pending_approval_state' } as const;

describe('manual/destructive migration gate (v126)', () => {
  let engine: PGLiteEngine;

  beforeEach(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    // The ordinary path: initSchema() is what connectEngine / serve startup
    // reach via tryRunPendingMigrations. It must apply everything up to the
    // gate and stop there.
    await engine.initSchema();
  });

  afterEach(async () => {
    await engine.disconnect();
  });

  test('v126 is registered as manual + non-idempotent, and is the latest version', () => {
    const m126 = MIGRATIONS.find(m => m.version === 126)!;
    expect(m126.name).toBe('oauth_clients_pending_approval_state');
    expect(m126.manual).toBe(true);
    expect(m126.idempotent).toBe(false);
    expect(LATEST_VERSION).toBe(126);
  });

  test('no module-global approval surface remains for ordinary paths to reach', async () => {
    // The design flaw this pins: the grant used to live in module-global
    // mutable state behind exported setters, so ANY in-process caller could
    // arm or reuse it. The capability must be the only way across, and it
    // only exists as a value passed to runMigrations.
    const migrate = await import('../src/core/migrate.ts');
    expect('authorizeManualMigrations' in migrate).toBe(false);
    expect('resetManualMigrationAuthorization' in migrate).toBe(false);
    expect('pendingManualGrant' in migrate).toBe(false);
  });

  test('ordinary initSchema stops before v126 without advancing the version', async () => {
    const v = parseInt((await engine.getConfig('version')) ?? '0', 10);
    expect(v).toBe(125);
    expect(await hasPendingMigrations(engine)).toBe(true);
    // The typed blocker connectEngine() uses to fail closed before serving.
    expect(await pendingManualMigration(engine)).toEqual(V126_BLOCK);

    // A direct capability-less runMigrations call (the same entry point the
    // engine paths use) must stay blocked: nothing applied, version unmoved,
    // and the stop is reported as a typed result.
    const res = await runMigrations(engine);
    expect(res.applied).toBe(0);
    expect(res.current).toBe(125);
    expect(res.blocked).toEqual(V126_BLOCK);
    expect(parseInt((await engine.getConfig('version'))!, 10)).toBe(125);
  }, 60000);

  test('an issued capability does not arm the runner; only passing it crosses the gate', async () => {
    // Issuing a capability (what the apply-migrations --yes dispatch does)
    // must not change the behavior of capability-less runMigrations calls —
    // there is no ambient grant for the runner to pick up.
    const capability = ManualMigrationCapability.issue();
    const blocked = await runMigrations(engine);
    expect(blocked.applied).toBe(0);
    expect(blocked.current).toBe(125);
    expect(blocked.blocked).toEqual(V126_BLOCK);
    expect(capability.isConsumed).toBe(false);
    expect(parseInt((await engine.getConfig('version'))!, 10)).toBe(125);

    // Passing it explicitly crosses the gate — and consumes it.
    const res = await runMigrations(engine, { manualCapability: capability });
    expect(res.applied).toBe(1);
    expect(res.current).toBe(126);
    expect(res.blocked).toBeNull();
    expect(capability.isConsumed).toBe(true);
  }, 60000);

  test('authorized run applies v126 exactly once; retry keeps approved clients', async () => {
    // Fresh embedded schema already carries the post-v126 column/constraint
    // (fresh installs land in the post-migration shape), so seed a client in
    // the only shape the constraint allows pre-approval: pending with cleared
    // axes — plus a live token that v126 must delete.
    const now = Math.floor(Date.now() / 1000) + 3600;
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name, approval_state, scope, source_id, federated_read)
       VALUES ('gate_client', 'Gate Client', 'pending', NULL, NULL, '{}')`,
    );
    await engine.executeRaw(
      `INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at)
       VALUES ('gate_hash', 'access', 'gate_client', '{read}', $1)`,
      [now],
    );

    // The apply-migrations --yes path: issue the one-shot capability, then
    // the same runMigrations entry point crosses the gate with it.
    const capability = ManualMigrationCapability.issue();
    const res = await runMigrations(engine, { manualCapability: capability });
    expect(res.applied).toBe(1);
    expect(res.current).toBe(126);
    expect(res.blocked).toBeNull();
    expect(capability.isConsumed).toBe(true);
    expect(parseInt((await engine.getConfig('version'))!, 10)).toBe(126);
    expect(await hasPendingMigrations(engine)).toBe(false);
    expect(await pendingManualMigration(engine)).toBeNull();

    // v126 effects landed: the pending client's token is gone.
    const tokens = await engine.executeRaw<{ token_hash: string }>(
      `SELECT token_hash FROM oauth_tokens WHERE client_id = 'gate_client'`,
    );
    expect(tokens).toHaveLength(0);

    // Operator approves the client afterwards (valid approved axes per the
    // chk_oauth_clients_approval constraint), with a fresh token.
    await engine.executeRaw(
      `UPDATE oauth_clients
         SET approval_state = 'approved', scope = 'read', source_id = 'default', federated_read = '{default}'
       WHERE client_id = 'gate_client'`,
    );
    await engine.executeRaw(
      `INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at)
       VALUES ('gate_hash_2', 'access', 'gate_client', '{read}', $1)`,
      [now],
    );

    // Retry: v126 is no longer pending, so nothing re-runs — the approved
    // client and its credentials are untouched.
    const retry = await runMigrations(engine);
    expect(retry.applied).toBe(0);
    expect(retry.current).toBe(126);
    expect(retry.blocked).toBeNull();

    const clients = await engine.executeRaw<{
      approval_state: string; scope: string | null; source_id: string | null;
    }>(
      `SELECT approval_state, scope, source_id FROM oauth_clients WHERE client_id = 'gate_client'`,
    );
    expect(clients[0]).toMatchObject({
      approval_state: 'approved',
      scope: 'read',
      source_id: 'default',
    });
    const surviving = await engine.executeRaw<{ token_hash: string }>(
      `SELECT token_hash FROM oauth_tokens WHERE client_id = 'gate_client'`,
    );
    expect(surviving).toHaveLength(1);
  }, 60000);

  test('the --yes capability is one-shot: a later gated run in the same process blocks', async () => {
    // Seed the pre-approval client shape + a token v126 must delete.
    const now = Math.floor(Date.now() / 1000) + 3600;
    await engine.executeRaw(
      `INSERT INTO oauth_clients (client_id, client_name, approval_state, scope, source_id, federated_read)
       VALUES ('gate_client', 'Gate Client', 'pending', NULL, NULL, '{}')`,
    );
    await engine.executeRaw(
      `INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at)
       VALUES ('gate_hash', 'access', 'gate_client', '{read}', $1)`,
      [now],
    );

    // First authorized crossing: applies v126 and CONSUMES the capability.
    const capability = ManualMigrationCapability.issue();
    const first = await runMigrations(engine, { manualCapability: capability });
    expect(first.applied).toBe(1);
    expect(first.current).toBe(126);
    expect(first.blocked).toBeNull();
    expect(capability.isConsumed).toBe(true);

    // Simulate a manual migration becoming pending again in the SAME process
    // (the shape a future gated version would take): rewind the recorded
    // version so v126 is pending, then run WITHOUT a fresh capability. The
    // consumed approval must not authorize this crossing — nothing applied,
    // version unmoved, typed blocker reported.
    await engine.setConfig('version', '125');
    const second = await runMigrations(engine);
    expect(second.applied).toBe(0);
    expect(second.current).toBe(125);
    expect(second.blocked).toEqual(V126_BLOCK);
    expect(parseInt((await engine.getConfig('version'))!, 10)).toBe(125);
    expect(await pendingManualMigration(engine)).toEqual(V126_BLOCK);

    // Reusing the CONSUMED capability must not cross either — one capability
    // authorizes at most one manual migration, ever.
    const reused = await runMigrations(engine, { manualCapability: capability });
    expect(reused.applied).toBe(0);
    expect(reused.current).toBe(125);
    expect(reused.blocked).toEqual(V126_BLOCK);
    expect(parseInt((await engine.getConfig('version'))!, 10)).toBe(125);

    // A freshly-issued capability (a new apply-migrations --yes invocation)
    // is the only thing that crosses.
    const fresh = ManualMigrationCapability.issue();
    const third = await runMigrations(engine, { manualCapability: fresh });
    expect(third.applied).toBe(1);
    expect(third.current).toBe(126);
    expect(third.blocked).toBeNull();
    expect(parseInt((await engine.getConfig('version'))!, 10)).toBe(126);
  }, 60000);
});
