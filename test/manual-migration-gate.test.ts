/**
 * Manual/destructive migration gate (#1553) — v126 oauth_clients reset.
 *
 * v126 is destructive (resets every client to pending, deletes tokens/codes)
 * and one-shot (`idempotent: false`). It must never auto-apply from the
 * ordinary connectEngine / serve startup path (engine initSchema()); only
 * `gbrain apply-migrations --yes` — which calls authorizeManualMigrations()
 * from the CLI dispatch — may run it. These tests pin both halves:
 *
 *   1. The ordinary path stops BEFORE v126: SQL never runs and
 *      config.version is not advanced to it or past it.
 *   2. The authorized path applies v126 exactly once; a retry is a no-op
 *      and does not reset clients that were approved after the first run.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  MIGRATIONS,
  LATEST_VERSION,
  runMigrations,
  hasPendingMigrations,
  authorizeManualMigrations,
  resetManualMigrationAuthorization,
} from '../src/core/migrate.ts';

describe('manual/destructive migration gate (v126)', () => {
  let engine: PGLiteEngine;

  beforeEach(async () => {
    resetManualMigrationAuthorization();
    engine = new PGLiteEngine();
    await engine.connect({});
    // The ordinary path: initSchema() is what connectEngine / serve startup
    // reach via tryRunPendingMigrations. It must apply everything up to the
    // gate and stop there.
    await engine.initSchema();
  });

  afterEach(async () => {
    resetManualMigrationAuthorization();
    await engine.disconnect();
  });

  test('v126 is registered as manual + non-idempotent, and is the latest version', () => {
    const m126 = MIGRATIONS.find(m => m.version === 126)!;
    expect(m126.name).toBe('oauth_clients_pending_approval_state');
    expect(m126.manual).toBe(true);
    expect(m126.idempotent).toBe(false);
    expect(LATEST_VERSION).toBe(126);
  });

  test('ordinary initSchema stops before v126 without advancing the version', async () => {
    const v = parseInt((await engine.getConfig('version')) ?? '0', 10);
    expect(v).toBe(125);
    expect(await hasPendingMigrations(engine)).toBe(true);

    // A direct un-authorized runMigrations call (the same entry point the
    // engine paths use) must stay blocked: nothing applied, version unmoved.
    const res = await runMigrations(engine);
    expect(res.applied).toBe(0);
    expect(res.current).toBe(125);
    expect(parseInt((await engine.getConfig('version'))!, 10)).toBe(125);
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

    // The apply-migrations --yes path: explicit authorization, then the same
    // runMigrations entry point crosses the gate.
    authorizeManualMigrations();
    const res = await runMigrations(engine);
    expect(res.applied).toBe(1);
    expect(res.current).toBe(126);
    expect(parseInt((await engine.getConfig('version'))!, 10)).toBe(126);
    expect(await hasPendingMigrations(engine)).toBe(false);

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
});
