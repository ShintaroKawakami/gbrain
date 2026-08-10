import { describe, test, expect, beforeEach } from 'bun:test';
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { PGLITE_SCHEMA_SQL } from '../src/core/pglite-schema.ts';
import { MIGRATIONS } from '../src/core/migrate.ts';

describe('Migration v126: OAuth Clients Pending Approval State', () => {
  let db: PGlite;

  const sqlAdapter = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `$${i + 1}` : ''), '');
    const result = await db.query(query, values as any[]);
    return result.rows as Record<string, unknown>[];
  };

  beforeEach(async () => {
    db = new PGlite({ extensions: { vector, pg_trgm } });
    await db.exec(PGLITE_SCHEMA_SQL);
  });

  test('v126 resets all clients to pending, clears active axes, and deletes tokens/codes', async () => {
    // Seed sources (default already inserted by PGLITE_SCHEMA_SQL)
    await sqlAdapter`INSERT INTO sources (id, name) VALUES ('src2', 'Source 2') ON CONFLICT (id) DO NOTHING`;

    // Seed clients in pre-v126 state
    await sqlAdapter`
      INSERT INTO oauth_clients (client_id, client_name, redirect_uris, grant_types, scope, source_id, federated_read, approval_state)
      VALUES 
        ('client1', 'Client One', ${['https://app1.example/cb']}, ${['authorization_code']}, 'read write', 'default', ${['default']}, 'approved'),
        ('client2', 'Client Two', ${['https://app2.example/cb']}, ${['client_credentials']}, 'read', 'src2', ${['src2', 'default']}, 'approved')
    `;

    // Seed tokens and codes
    const now = Math.floor(Date.now() / 1000) + 3600;
    await sqlAdapter`
      INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at)
      VALUES ('hash1', 'access', 'client1', ${['read']}, ${now}), ('hash2', 'refresh', 'client2', ${['read']}, ${now})
    `;
    await sqlAdapter`
      INSERT INTO oauth_codes (code_hash, client_id, scopes, code_challenge, code_challenge_method, redirect_uri, expires_at)
      VALUES ('code1', 'client1', ${['read']}, 'challenge1', 'S256', 'https://app1.example/cb', ${now})
    `;

    // Run migration v126
    const m126 = MIGRATIONS.find(m => m.version === 126)!;
    await db.exec(m126.sql);

    // Verify oauth_clients rows preserved and reset to pending
    const clients = await sqlAdapter`SELECT client_id, approval_state, scope, source_id, federated_read FROM oauth_clients ORDER BY client_id`;
    expect(clients).toHaveLength(2);

    expect(clients[0].client_id).toBe('client1');
    expect(clients[0].approval_state).toBe('pending');
    expect(clients[0].scope).toBeNull();
    expect(clients[0].source_id).toBeNull();

    expect(clients[1].client_id).toBe('client2');
    expect(clients[1].approval_state).toBe('pending');
    expect(clients[1].scope).toBeNull();
    expect(clients[1].source_id).toBeNull();

    // Verify tokens and codes were deleted
    const tokens = await sqlAdapter`SELECT * FROM oauth_tokens`;
    expect(tokens).toHaveLength(0);

    const codes = await sqlAdapter`SELECT * FROM oauth_codes`;
    expect(codes).toHaveLength(0);
  });

  test('chk_oauth_clients_approval CHECK constraint prevents invalid states', async () => {
    const m126 = MIGRATIONS.find(m => m.version === 126)!;
    await db.exec(m126.sql);

    // Valid pending row insertion
    await sqlAdapter`
      INSERT INTO oauth_clients (client_id, client_name, approval_state, scope, source_id, federated_read)
      VALUES ('pending_ok', 'Pending OK', 'pending', NULL, NULL, ${[]})
    `;
    const pendingRow = await sqlAdapter`SELECT approval_state FROM oauth_clients WHERE client_id = 'pending_ok'`;
    expect(pendingRow[0].approval_state).toBe('pending');

    // Invalid: pending with active scope
    expect(
      sqlAdapter`
        INSERT INTO oauth_clients (client_id, client_name, approval_state, scope, source_id, federated_read)
        VALUES ('bad_pending1', 'Bad Pending', 'pending', 'read', NULL, ${[]})
      `
    ).rejects.toThrow();

    // Invalid: pending with source_id
    expect(
      sqlAdapter`
        INSERT INTO oauth_clients (client_id, client_name, approval_state, scope, source_id, federated_read)
        VALUES ('bad_pending2', 'Bad Pending', 'pending', NULL, 'default', ${[]})
      `
    ).rejects.toThrow();

    // Invalid: approved with NULL scope
    expect(
      sqlAdapter`
        INSERT INTO oauth_clients (client_id, client_name, approval_state, scope, source_id, federated_read)
        VALUES ('bad_app1', 'Bad Approved', 'approved', NULL, 'default', ${['default']})
      `
    ).rejects.toThrow();

    // Invalid: approved with source_id not in federated_read
    expect(
      sqlAdapter`
        INSERT INTO oauth_clients (client_id, client_name, approval_state, scope, source_id, federated_read)
        VALUES ('bad_app2', 'Bad Approved', 'approved', 'read', 'default', ${['other']})
      `
    ).rejects.toThrow();

    // Valid approved row
    await sqlAdapter`
      INSERT INTO oauth_clients (client_id, client_name, approval_state, scope, source_id, federated_read)
      VALUES ('approved_ok', 'Approved OK', 'approved', 'read write', 'default', ${['default']})
    `;
    const appRow = await sqlAdapter`SELECT approval_state FROM oauth_clients WHERE client_id = 'approved_ok'`;
    expect(appRow[0].approval_state).toBe('approved');
  });
});
