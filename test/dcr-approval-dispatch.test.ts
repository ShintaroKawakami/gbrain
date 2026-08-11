import { describe, test, expect, beforeEach } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';

describe('OAuth DCR Pending Approval Hardening & Shared Dispatch', () => {
  let db: PGlite;

  const sqlAdapter = async (strings: TemplateStringsArray, ...values: any[]) => {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
    const result = await db.query(query, values as any[]);
    return result.rows as Record<string, unknown>[];
  };

  beforeEach(async () => {
    db = new PGlite({ extensions: { vector, pg_trgm } });
    await db.exec(PGLITE_SCHEMA_SQL);
    await sqlAdapter`INSERT INTO sources (id, name) VALUES ('source-a', 'Source A'), ('source-b', 'Source B') ON CONFLICT (id) DO NOTHING`;
  });

  test('DCR creates fail-closed pending client with empty scope and NULL source_id', async () => {
    const provider = new GBrainOAuthProvider({ sql: sqlAdapter });
    const client = await provider.clientsStore.registerClient!({
      client_name: 'Attacker App',
      redirect_uris: ['https://attacker.example/cb'],
      grant_types: ['authorization_code'],
      scope: 'read write admin',
    });

    expect(client.client_id).toBeDefined();

    // Check DB state directly
    const rows = await sqlAdapter`SELECT approval_state, scope, source_id, federated_read FROM oauth_clients WHERE client_id = ${client.client_id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].approval_state).toBe('pending');
    expect(rows[0].scope).toBeNull();
    expect(rows[0].source_id).toBeNull();
  });

  test('Pending client cannot invoke grants (authorize, exchange, client credentials)', async () => {
    const provider = new GBrainOAuthProvider({ sql: sqlAdapter, allowClientCredentialsDcr: true });
    const client = await provider.clientsStore.registerClient!({
      client_name: 'Pending App',
      redirect_uris: ['https://pending.example/cb'],
      grant_types: ['authorization_code', 'client_credentials'],
    });

    const dummyRes: any = { redirect: () => {} };
    // Authorize fails
    expect(
      provider.authorize(client, { redirectUri: 'https://pending.example/cb', codeChallenge: 'xyz' }, dummyRes)
    ).rejects.toThrow('approval_pending');

    // Exchange client credentials fails
    if (client.client_secret) {
      expect(
        provider.exchangeClientCredentials(client.client_id, client.client_secret, 'read')
      ).rejects.toThrow('approval_pending');
    }
  });

  test('approvePendingClient requires exact ID, exact metadata, and valid sources', async () => {
    const provider = new GBrainOAuthProvider({ sql: sqlAdapter });
    const client = await provider.clientsStore.registerClient!({
      client_name: 'Legit App',
      redirect_uris: ['https://legit.example/cb'],
      grant_types: ['authorization_code'],
      token_endpoint_auth_method: 'client_secret_post',
    });

    // Mismatched redirect URI rejects
    expect(
      provider.approvePendingClient({
        clientId: client.client_id,
        expectedRedirectUris: ['https://wrong.example/cb'],
        expectedTokenEndpointAuthMethod: 'client_secret_post',
        expectedGrantTypes: ['authorization_code'],
        expectedResponseTypes: ['code'],
        scopes: 'read write',
        sourceId: 'source-a',
        federatedRead: ['source-a'],
      })
    ).rejects.toThrow('metadata mismatch');

    // Non-existent source rejects
    expect(
      provider.approvePendingClient({
        clientId: client.client_id,
        expectedRedirectUris: ['https://legit.example/cb'],
        expectedTokenEndpointAuthMethod: 'client_secret_post',
        expectedGrantTypes: ['authorization_code'],
        expectedResponseTypes: ['code'],
        scopes: 'read write',
        sourceId: 'nonexistent-source',
        federatedRead: ['nonexistent-source'],
      })
    ).rejects.toThrow('source verification failed');

    // Exact match succeeds
    await provider.approvePendingClient({
      clientId: client.client_id,
      expectedRedirectUris: ['https://legit.example/cb'],
      expectedTokenEndpointAuthMethod: 'client_secret_post',
      expectedGrantTypes: ['authorization_code'],
      expectedResponseTypes: ['code'],
      scopes: 'read write',
      sourceId: 'source-a',
      federatedRead: ['source-a', 'default'],
    });

    // DB state is now approved
    const rows = await sqlAdapter`SELECT approval_state, scope, source_id, federated_read FROM oauth_clients WHERE client_id = ${client.client_id}`;
    expect(rows[0].approval_state).toBe('approved');
    expect(rows[0].scope).toBe('read write');
    expect(rows[0].source_id).toBe('source-a');

    // Attempting to re-approve fails
    expect(
      provider.approvePendingClient({
        clientId: client.client_id,
        expectedRedirectUris: ['https://legit.example/cb'],
        expectedTokenEndpointAuthMethod: 'client_secret_post',
        expectedGrantTypes: ['authorization_code'],
        expectedResponseTypes: ['code'],
        scopes: 'read write',
        sourceId: 'source-a',
        federatedRead: ['source-a', 'default'],
      })
    ).rejects.toThrow('client is not pending');
  });

  test('Immediate scope shrink on verifyAccessToken against approved client scope', async () => {
    const provider = new GBrainOAuthProvider({ sql: sqlAdapter, allowClientCredentialsDcr: true });
    // Register & approve client with 'read write'
    const reg = await provider.registerClientManual(
      'Manual Client',
      ['client_credentials'],
      'read write',
      [],
      'default',
      ['default'],
    );

    // Exchange tokens (receives token with scope 'read write')
    const tokens = await provider.exchangeClientCredentials(reg.clientId, reg.clientSecret!);

    // Initial verification has 'read write'
    const auth1 = await provider.verifyAccessToken(tokens.access_token);
    expect(auth1.scopes).toEqual(['read', 'write']);

    // Shrink client scope in DB to 'read'
    await sqlAdapter`UPDATE oauth_clients SET scope = 'read' WHERE client_id = ${reg.clientId}`;

    // Token verification now immediately shrinks effective scope to ['read']
    const auth2 = await provider.verifyAccessToken(tokens.access_token);
    expect(auth2.scopes).toEqual(['read']);
  });

  test('Shared dispatch rejects unapproved/pending OAuth authKind for remote requests', async () => {
    const engine = await createEngine({ engine: 'pglite' });

    // Pending AuthInfo attempt
    const pendingAuth: any = {
      token: 'fake',
      clientId: 'cl1',
      authKind: 'oauth',
      approvalState: 'pending',
    };

    const res = await dispatchToolCall(
      engine,
      'get_page',
      { page_slug: 'wiki/test' },
      { remote: true, sourceId: 'default', auth: pendingAuth },
    );

    expect(res.isError).toBe(true);
    const parsed = JSON.parse(res.content[0].text);
    expect(parsed.error).toBe('permission_denied');
    expect(parsed.message).toContain('approval_pending');

    await engine.disconnect();
  });

  test('Shared dispatch rejects unauthenticated remote but preserves explicit stdio', async () => {
    const engine = await createEngine({ engine: 'pglite' });

    const unauthenticated = await dispatchToolCall(
      engine,
      'get_stats',
      {},
      { remote: true, sourceId: 'default' },
    );
    expect(unauthenticated.isError).toBe(true);
    expect(JSON.parse(unauthenticated.content[0].text).error).toBe('permission_denied');

    const stdio = await dispatchToolCall(
      engine,
      'whoami',
      {},
      { remote: true, transport: 'stdio', sourceId: 'default' },
    );
    expect(stdio.isError).not.toBe(true);
    expect(JSON.parse(stdio.content[0].text).transport).toBe('stdio');

    await engine.disconnect();
  });
});
