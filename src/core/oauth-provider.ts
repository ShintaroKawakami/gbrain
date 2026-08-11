/**
 * GBrain OAuth 2.1 Provider — implements MCP SDK's OAuthServerProvider.
 *
 * Backed by raw SQL (PGLite or Postgres), not the BrainEngine interface.
 * OAuth is infrastructure, not brain operations.
 *
 * Supports:
 * - Client registration (manual via CLI or Dynamic Client Registration)
 * - Authorization code flow with PKCE (for ChatGPT, browser-based clients)
 * - Client credentials flow (for machine-to-machine: Perplexity, Claude)
 * - Token refresh with rotation
 * - Token revocation
 * - Legacy access_tokens fallback for backward compat
 */

import type { Response } from 'express';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo as SdkAuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidTokenError, InvalidClientMetadataError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { hashToken, generateToken, isUndefinedColumnError } from './utils.ts';
import { assertValidSourceId } from './source-id.ts';
import { hasScope, assertAllowedScopes, parseScopeString, InvalidScopeError } from './scope.ts';
import type { AuthInfo as CoreAuthInfo } from './operations.ts';
import { parseLegacyTokenScope, parseTakesHoldersAllowList, coerceLegacyPermissions } from './legacy-token-scope.ts';

/**
 * A slug-prefix write binding is only meaningful if every entry actually
 * constrains something. `''` (or whitespace) matches every slug under
 * `startsWith`, so one unset variable in a provisioning template would turn
 * a binding into a silent wildcard while still displaying as "fenced".
 * Reject at every write surface: registration, rescope, admin API.
 */
export function assertValidSlugPrefixes(prefixes: readonly string[]): void {
  for (const p of prefixes) {
    if (typeof p !== 'string' || p.trim() === '') {
      throw new Error('bound_slug_prefixes entries must be non-empty, non-whitespace slug prefixes (e.g. "emp-alice/")');
    }
    if (p !== p.trim()) {
      throw new Error(`bound_slug_prefixes entry "${p}" has leading/trailing whitespace; slugs never do, so it would fence nothing`);
    }
    // Slugs are lowercased by validateSlug before storage, so a prefix with
    // uppercase in it cannot correspond to anything actually written.
    if (p !== p.toLowerCase()) {
      throw new Error(`bound_slug_prefixes entry "${p}" must be lowercase; stored slugs are lowercased, so a mixed-case prefix fences unpredictably`);
    }
    // Require an explicit segment boundary. Slug namespaces collide on their
    // own naming scheme — `emp-alice` and `emp-alice-2` are different people —
    // and a boundary-less entry reads as "everything starting with these
    // characters". The matcher is boundary-aware regardless, but saying it at
    // registration is what stops an operator writing a binding whose meaning
    // isn't what it looks like.
    if (!p.endsWith('/') && !p.endsWith('/*')) {
      throw new Error(`bound_slug_prefixes entry "${p}" must end with "/" (or "/*"); a boundary-less prefix reads as a character prefix, so "${p}" would look like it covers only "${p}/..." while naming sibling namespaces like "${p}-2/..."`);
    }
  }
}
import type { SqlQuery, SqlValue } from './sql-query.ts';
export type { SqlQuery, SqlValue };

export interface AgentClientBindings {
  boundTools?: string[];
  boundSourceId?: string;
  boundBrainId?: string;
  boundSlugPrefixes?: string[];
  boundMaxConcurrent?: number;
  budgetUsdPerDay?: string;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Convert a JS array to a PostgreSQL array literal for PGLite compat.
 *
 * PGLite's `db.query(sql, params)` rejects JS arrays bound directly to TEXT[]
 * columns ("insufficient data left in message"), so we hand-build the array
 * literal `{...}` and let Postgres parse it on insert.
 *
 * SECURITY: every element is wrapped in double quotes with `"` and `\`
 * escaped. Without this, an element containing a comma (e.g., a malicious
 * `redirect_uri` containing `,`) would be parsed by Postgres as MULTIPLE
 * array elements, smuggling values past validation. See CSO finding #5.
 */
function pgArray(arr: string[]): string {
  if (!arr || arr.length === 0) return '{}';
  const escaped = arr.map(s => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
  return `{${escaped.join(',')}}`;
}

/** Canonical RFC metadata representation used for DCR storage and approval CAS. */
function canonicalMetadataArray(values: readonly string[]): string[] {
  return [...values].map(value => String(value).trim()).sort();
}

/**
 * Allow-list of RFC 7591 §2 `token_endpoint_auth_method` values gbrain
 * accepts at registration. Three values, chosen because the SDK's
 * `mcpAuthRouter` advertises exactly these three in
 * `token_endpoint_auth_methods_supported`:
 *
 * - `client_secret_post` — confidential client; secret in body (default)
 * - `client_secret_basic` — confidential client; secret in Authorization header
 * - `none` — public PKCE-only client (Claude Code, Cursor, ChatGPT custom connector)
 *
 * Three call sites enforce this set:
 *   1. CLI `gbrain auth register-client` (src/commands/auth.ts)
 *   2. Admin `POST /admin/api/register-client` (src/commands/serve-http.ts)
 *   3. DCR `POST /register` (this file, GBrainClientsStore.registerClient)
 *
 * **Read-tolerant by design.** `getClient` returns whatever is stored
 * verbatim — legacy rows with non-allowlist values (e.g. pre-v0.41.3
 * direct UPDATEs) continue to function. The validator gates new writes
 * ONLY; we don't break operators with hand-edited rows on upgrade.
 */
export type TokenEndpointAuthMethod = 'client_secret_post' | 'client_secret_basic' | 'none';

export const ALLOWED_TOKEN_ENDPOINT_AUTH_METHODS = new Set<TokenEndpointAuthMethod>([
  'client_secret_post',
  'client_secret_basic',
  'none',
]);

export class InvalidTokenEndpointAuthMethodError extends Error {
  readonly code = 'invalid_token_endpoint_auth_method';
  constructor(value: unknown) {
    super(
      `Invalid token_endpoint_auth_method: ${JSON.stringify(value)}. ` +
      `Expected one of: ${Array.from(ALLOWED_TOKEN_ENDPOINT_AUTH_METHODS).join(', ')}. ` +
      `RFC 7591 §2 — see https://datatracker.ietf.org/doc/html/rfc7591#section-2.`,
    );
    this.name = 'InvalidTokenEndpointAuthMethodError';
  }
}

/**
 * Validate a token_endpoint_auth_method value at the registration boundary.
 * Throws `InvalidTokenEndpointAuthMethodError` on rejection; returns the
 * typed value on success. Returns `'client_secret_post'` for undefined input
 * (RFC 7591 default).
 *
 * Apply at every registration entry point (CLI, admin endpoint, DCR). Do
 * NOT apply on read — legacy oauth_clients rows with non-allowlist values
 * must continue to function unchanged.
 */
export function validateTokenEndpointAuthMethod(value: unknown): TokenEndpointAuthMethod {
  if (value === undefined || value === null || value === '') return 'client_secret_post';
  if (typeof value !== 'string') throw new InvalidTokenEndpointAuthMethodError(value);
  if (!ALLOWED_TOKEN_ENDPOINT_AUTH_METHODS.has(value as TokenEndpointAuthMethod)) {
    throw new InvalidTokenEndpointAuthMethodError(value);
  }
  return value as TokenEndpointAuthMethod;
}

/**
 * Validate a redirect_uri per RFC 6749 §3.1.2.1.
 *
 * Production redirect_uris MUST be HTTPS. The only allowed plaintext
 * exceptions are loopback (127.0.0.1, ::1, localhost) which are unreachable
 * from the network. Throws a descriptive error on rejection.
 *
 * Used by the DCR (Dynamic Client Registration) path; the CLI registration
 * path trusts the operator and bypasses this gate.
 */
function validateRedirectUri(uri: string): void {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error(`Invalid redirect_uri: not a parseable URL: ${uri}`);
  }
  const isLoopback = parsed.hostname === 'localhost'
    || parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]'
    || parsed.hostname === '::1';
  if (parsed.protocol === 'https:') return;
  if (parsed.protocol === 'http:' && isLoopback) return;
  throw new Error(
    `redirect_uri must use https:// (or http://localhost for loopback): ${uri}`,
  );
}

/**
 * Coerce an OAuth timestamp column (Unix epoch seconds, BIGINT) into a JS
 * number, or undefined for SQL NULL.
 *
 * Why this exists: postgres.js with `prepare: false` (the auto-detected setting
 * on Supabase PgBouncer / port 6543; see src/core/db.ts:resolvePrepare) returns
 * BIGINT columns as strings. Two surfaces break on that: (1) the MCP SDK's
 * bearerAuth middleware checks `typeof authInfo.expiresAt === 'number'` and
 * rejects strings; (2) RFC 7591 §3.2.1 requires `client_id_issued_at` and
 * `client_secret_expires_at` to be JSON numbers in DCR responses, not strings.
 *
 * Throws on non-finite (NaN/Infinity) so corrupt rows fail loud at the boundary
 * instead of letting `expiresAt: NaN` flow through to the SDK as a fake-valid
 * token. Returns undefined for SQL NULL so callers decide NULL semantics
 * explicitly. For OAuth, the comparison sites treat NULL as "expired"
 * (fail-closed); the DCR response sites preserve undefined per RFC 7591
 * (the `client_secret_expires_at` field is optional, undefined means
 * "did not expire").
 */
export function coerceTimestamp(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(`coerceTimestamp: non-finite timestamp value ${JSON.stringify(value)}`);
  }
  return n;
}

export interface AgentBindings {
  boundTools?: string[];
  boundSourceId?: string;
  boundBrainId?: string;
  boundSlugPrefixes?: string[];
  boundMaxConcurrent?: number;
  budgetUsdPerDay?: number | string;
}

interface GBrainOAuthProviderOptions {
  sql: SqlQuery;
  /** Default token TTL in seconds (default: 3600 = 1 hour) */
  tokenTtl?: number;
  /** Default refresh token TTL in seconds (default: 30 days) */
  refreshTtl?: number;
  /**
   * Disable Dynamic Client Registration (RFC 7591) while keeping the rest of
   * the OAuth surface intact. When true, `clientsStore.registerClient` is not
   * surfaced to the SDK router, so POST `/register` returns 404 even though
   * the underlying provider can still register clients programmatically via
   * `registerClientManual`. Replaces the previous monkey-patching pattern in
   * serve-http.ts (cleanup, not a security fix — DCR was never reachable
   * before mcpAuthRouter ran).
   */
  dcrDisabled?: boolean;
  /**
   * Allow the consent-bypassing `client_credentials` grant on the unauthenticated
   * Dynamic Client Registration path. Default false (#1353): a self-registered
   * DCR client defaults to `authorization_code` (which goes through /authorize
   * consent), and an explicit `client_credentials` request is rejected. Operators
   * who genuinely need machine-to-machine DCR clients opt in via
   * `--enable-dcr-insecure`. Manual CLI / admin registration is unaffected
   * (operator-trusted, registers grants directly).
   */
  allowClientCredentialsDcr?: boolean;
}

// ---------------------------------------------------------------------------
// Canonical DB Client Record
// ---------------------------------------------------------------------------

/**
 * Canonical DB client record representation.
 * Single source of truth for client approval state, deletion, and scopes.
 *
 * CaD Security Decision:
 * OAuth clients must be reloaded from the database on every sensitive
 * operation (authorize, code exchange, token refresh, client credentials,
 * verification, approval). Reading cached or stale client records can allow
 * a revoked/pending client to receive grants.
 */
export interface ClientDbState {
  clientId: string;
  clientSecretHash: string | null;
  clientName: string;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  scope: string | null;
  tokenEndpointAuthMethod: string | undefined;
  clientIdIssuedAt: number | undefined;
  clientSecretExpiresAt: number | undefined;
  approvalState: 'pending' | 'approved';
  deletedAt: string | null;
  sourceId: string | null;
  federatedRead: string[];
  boundSlugPrefixes?: string[] | null;
}

export async function loadClientDbState(
  sql: SqlQuery,
  clientId: string,
): Promise<ClientDbState | undefined> {
  let rows: Record<string, unknown>[];
  try {
    rows = await sql`
      SELECT client_id, client_secret_hash, client_name, redirect_uris,
             grant_types, response_types, scope, token_endpoint_auth_method,
             client_id_issued_at, client_secret_expires_at,
             approval_state, deleted_at, source_id, federated_read,
             bound_slug_prefixes
      FROM oauth_clients WHERE client_id = ${clientId}
    `;
  } catch (err) {
    if (isUndefinedColumnError(err, 'approval_state')) {
      throw new Error(
        'migration_required: OAuth schema requires migration v126 (approval_state missing). Run `gbrain apply-migrations --yes`.',
      );
    }
    throw err;
  }

  if (rows.length === 0) return undefined;
  const r = rows[0];
  return {
    clientId: r.client_id as string,
    clientSecretHash: (r.client_secret_hash as string | null) ?? null,
    clientName: (r.client_name as string) || '',
    redirectUris: (r.redirect_uris as string[]) || [],
    grantTypes: (r.grant_types as string[]) || ['client_credentials'],
    responseTypes: (r.response_types as string[]) || [],
    scope: (r.scope as string | null) ?? null,
    tokenEndpointAuthMethod: r.token_endpoint_auth_method as string | undefined,
    clientIdIssuedAt: coerceTimestamp(r.client_id_issued_at),
    clientSecretExpiresAt: coerceTimestamp(r.client_secret_expires_at),
    approvalState: (r.approval_state as 'pending' | 'approved') || 'pending',
    deletedAt: (r.deleted_at as string | null) ?? null,
    sourceId: (r.source_id as string | null) ?? null,
    federatedRead: (r.federated_read as string[]) || [],
    boundSlugPrefixes: Array.isArray(r.bound_slug_prefixes) ? (r.bound_slug_prefixes as string[]) : (r.bound_slug_prefixes as null | undefined),
  };
}

export interface ApprovePendingClientOpts {
  clientId: string;
  expectedRedirectUris: string[];
  expectedTokenEndpointAuthMethod: string;
  expectedGrantTypes: string[];
  expectedResponseTypes: string[];
  scopes: string;
  sourceId: string;
  federatedRead: string[];
}

// ---------------------------------------------------------------------------
// Clients Store
// ---------------------------------------------------------------------------

class GBrainClientsStore implements OAuthRegisteredClientsStore {
  constructor(private sql: SqlQuery, private allowClientCredentialsDcr = false) {}

  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const state = await loadClientDbState(this.sql, clientId);
    if (!state) return undefined;
    if (state.deletedAt !== null) return undefined;

    const rawSecret = state.clientSecretHash;
    return {
      client_id: state.clientId,
      client_secret: rawSecret == null ? undefined : rawSecret,
      client_name: state.clientName,
      redirect_uris: state.redirectUris,
      grant_types: state.grantTypes,
      response_types: state.responseTypes,
      scope: state.scope ?? undefined,
      token_endpoint_auth_method: state.tokenEndpointAuthMethod,
      client_id_issued_at: state.clientIdIssuedAt,
      client_secret_expires_at: state.clientSecretExpiresAt,
      approval_state: state.approvalState,
    } as OAuthClientInformationFull;
  }

  async registerClient(
    client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>,
  ): Promise<OAuthClientInformationFull> {
    for (const uri of client.redirect_uris || []) {
      validateRedirectUri(String(uri));
    }
    assertAllowedScopes(parseScopeString(client.scope));
    const authMethod = validateTokenEndpointAuthMethod(client.token_endpoint_auth_method);

    const grantTypes = canonicalMetadataArray((client.grant_types && client.grant_types.length > 0)
      ? client.grant_types
      : ['authorization_code']);
    const responseTypes = canonicalMetadataArray(Array.isArray((client as { response_types?: unknown }).response_types)
      ? ((client as { response_types: unknown[] }).response_types.map(String))
      : (grantTypes.includes('authorization_code') ? ['code'] : []));
    const redirectUris = canonicalMetadataArray((client.redirect_uris || []).map(String));
    if (responseTypes.some(type => type !== 'code') ||
        (grantTypes.includes('authorization_code') && !responseTypes.includes('code')) ||
        (!grantTypes.includes('authorization_code') && responseTypes.length > 0)) {
      throw new InvalidClientMetadataError('DCR response_types must exactly match the authorization_code grant');
    }
    if (!this.allowClientCredentialsDcr && grantTypes.includes('client_credentials')) {
      throw new InvalidClientMetadataError(
        'client_credentials grant is not permitted via dynamic client registration; ' +
        'restart the server with --enable-dcr-insecure to allow it, or register the ' +
        'client via the gbrain CLI / admin API.',
      );
    }

    const clientId = generateToken('gbrain_cl_');
    const isPublicClient = authMethod === 'none';
    const clientSecret = isPublicClient ? undefined : generateToken('gbrain_cs_');
    const secretHash = clientSecret ? hashToken(clientSecret) : null;
    const now = Math.floor(Date.now() / 1000);

    // CaD Security Decision:
    // DCR is an unauthenticated registration surface. DCR registrations MUST create
    // a pending client with empty active scope, NULL source_id, and empty federated_read.
    // Untrusted callers cannot assign their own scopes, write sources, or read permissions.
    await this.sql`
      INSERT INTO oauth_clients (
        client_id, client_secret_hash, client_name, redirect_uris,
        grant_types, response_types, scope, token_endpoint_auth_method,
        client_id_issued_at, approval_state, source_id, federated_read
      )
      VALUES (
        ${clientId}, ${secretHash}, ${client.client_name || 'unnamed'},
        ${pgArray(redirectUris)},
        ${pgArray(grantTypes)}, ${pgArray(responseTypes)},
        NULL, ${authMethod},
        ${now}, 'pending', NULL, ${pgArray([])}
      )
    `;

    const response: OAuthClientInformationFull = {
      ...client,
      client_id: clientId,
      client_id_issued_at: now,
      response_types: responseTypes,
    };
    if (clientSecret) response.client_secret = clientSecret;
    return response;
  }
}

// ---------------------------------------------------------------------------
// OAuth Provider
// ---------------------------------------------------------------------------

export class GBrainOAuthProvider implements OAuthServerProvider {
  private sql: SqlQuery;
  private _clientsStore: GBrainClientsStore;
  private readonly dcrDisabled: boolean;
  private tokenTtl: number;
  private refreshTtl: number;

  constructor(options: GBrainOAuthProviderOptions) {
    this.sql = options.sql;
    this._clientsStore = new GBrainClientsStore(this.sql, options.allowClientCredentialsDcr === true);
    this.dcrDisabled = options.dcrDisabled === true;
    this.tokenTtl = options.tokenTtl || 3600;
    this.refreshTtl = options.refreshTtl || 30 * 24 * 3600;
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    if (this.dcrDisabled) {
      return {
        getClient: this._clientsStore.getClient.bind(this._clientsStore),
      } as OAuthRegisteredClientsStore;
    }
    return this._clientsStore;
  }

  // -------------------------------------------------------------------------
  // Authorization Code Flow
  // -------------------------------------------------------------------------

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const dbState = await loadClientDbState(this.sql, client.client_id);
    if (!dbState || dbState.deletedAt !== null) {
      throw new Error('Client not found or deleted');
    }
    if (dbState.approvalState !== 'approved') {
      throw new Error('approval_pending: Client is pending operator approval');
    }

    const code = generateToken('gbrain_code_');
    const codeHash = hashToken(code);
    const expiresAt = Math.floor(Date.now() / 1000) + 600;

    const allowedScopes = parseScopeString(dbState.scope ?? '');
    const requestedScopes = (params.scopes && params.scopes.length) ? params.scopes : allowedScopes;
    const grantedScopes = requestedScopes.filter(s => hasScope(allowedScopes, s));

    await this.sql`
      INSERT INTO oauth_codes (code_hash, client_id, scopes, code_challenge,
                                code_challenge_method, redirect_uri, state, resource, expires_at)
      VALUES (${codeHash}, ${client.client_id},
              ${pgArray(grantedScopes)},
              ${params.codeChallenge}, ${'S256'},
              ${params.redirectUri}, ${params.state || null},
              ${params.resource?.toString() || null}, ${expiresAt})
    `;

    const redirectUrl = new URL(params.redirectUri);
    redirectUrl.searchParams.set('code', code);
    if (params.state) redirectUrl.searchParams.set('state', params.state);
    res.redirect(redirectUrl.toString());
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const dbState = await loadClientDbState(this.sql, client.client_id);
    if (!dbState || dbState.deletedAt !== null) {
      throw new Error('Authorization code not found or expired');
    }
    if (dbState.approvalState !== 'approved') {
      throw new Error('approval_pending: Client is pending operator approval');
    }

    const codeHash = hashToken(authorizationCode);
    const rows = await this.sql`
      SELECT code_challenge FROM oauth_codes
      WHERE code_hash = ${codeHash}
        AND client_id = ${client.client_id}
        AND expires_at > ${Math.floor(Date.now() / 1000)}
    `;
    if (rows.length === 0) throw new Error('Authorization code not found or expired');
    return rows[0].code_challenge as string;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const dbState = await loadClientDbState(this.sql, client.client_id);
    if (!dbState || dbState.deletedAt !== null) {
      throw new Error('Authorization code not found or expired');
    }
    if (dbState.approvalState !== 'approved') {
      throw new Error('approval_pending: Client is pending operator approval');
    }

    const codeHash = hashToken(authorizationCode);
    const now = Math.floor(Date.now() / 1000);

    const rows = redirectUri !== undefined
      ? await this.sql`
          DELETE FROM oauth_codes
          WHERE code_hash = ${codeHash}
            AND client_id = ${client.client_id}
            AND redirect_uri = ${redirectUri}
            AND expires_at > ${now}
          RETURNING client_id, scopes, resource
        `
      : await this.sql`
          DELETE FROM oauth_codes
          WHERE code_hash = ${codeHash}
            AND client_id = ${client.client_id}
            AND expires_at > ${now}
          RETURNING client_id, scopes, resource
        `;
    if (rows.length === 0) throw new Error('Authorization code not found or expired');

    const codeRow = rows[0];
    const scopes = (codeRow.scopes as string[]) || [];
    return this.issueTokens(client.client_id, scopes, resource, true);
  }

  // -------------------------------------------------------------------------
  // Refresh Token
  // -------------------------------------------------------------------------

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const dbState = await loadClientDbState(this.sql, client.client_id);
    if (!dbState || dbState.deletedAt !== null) {
      throw new Error('Refresh token not found');
    }
    if (dbState.approvalState !== 'approved') {
      throw new Error('approval_pending: Client is pending operator approval');
    }

    const tokenHash = hashToken(refreshToken);
    const now = Math.floor(Date.now() / 1000);

    const rows = await this.sql`
      DELETE FROM oauth_tokens
      WHERE token_hash = ${tokenHash}
        AND token_type = 'refresh'
        AND client_id = ${client.client_id}
      RETURNING client_id, scopes, expires_at
    `;
    if (rows.length === 0) throw new Error('Refresh token not found');

    const row = rows[0];
    const expiresAt = coerceTimestamp(row.expires_at);
    if (expiresAt === undefined || expiresAt < now) throw new Error('Refresh token expired');

    const grantedScopes = (row.scopes as string[]) || [];
    if (scopes && scopes.some(s => !hasScope(grantedScopes, s))) {
      throw new Error('Requested scope exceeds refresh token grant');
    }
    const tokenScopes = scopes ?? grantedScopes;
    return this.issueTokens(client.client_id, tokenScopes, resource, true);
  }

  // -------------------------------------------------------------------------
  // Token Verification
  // -------------------------------------------------------------------------

  async verifyAccessToken(token: string): Promise<SdkAuthInfo> {
    const tokenHash = hashToken(token);
    const now = Math.floor(Date.now() / 1000);

    let oauthRows: Record<string, unknown>[];
    try {
      oauthRows = await this.sql`
        SELECT t.client_id, t.scopes, t.expires_at, t.resource, c.client_name,
               c.source_id, c.federated_read, c.bound_slug_prefixes, c.approval_state, c.deleted_at, c.scope as client_scope
        FROM oauth_tokens t
        JOIN oauth_clients c ON c.client_id = t.client_id
        WHERE t.token_hash = ${tokenHash} AND t.token_type = 'access'
      `;
    } catch (err) {
      if (isUndefinedColumnError(err, 'approval_state')) {
        throw new InvalidTokenError(
          'migration_required: OAuth schema requires migration v126 (approval_state missing). Run `gbrain apply-migrations --yes`.',
        );
      }
      throw err;
    }

    if (oauthRows.length > 0) {
      const row = oauthRows[0];
      const deletedAt = row.deleted_at as string | null;
      const approvalState = row.approval_state as string;
      if (deletedAt !== null && deletedAt !== undefined) {
        throw new InvalidTokenError('Client deleted');
      }
      if (approvalState !== 'approved') {
        throw new InvalidTokenError('approval_pending: Client is pending operator approval');
      }

      const expiresAt = coerceTimestamp(row.expires_at);
      if (expiresAt === undefined || expiresAt < now) {
        throw new InvalidTokenError('Token expired');
      }

      const rowSourceId = row.source_id as string | null;
      if (!rowSourceId) {
        throw new InvalidTokenError('OAuth client has no write source_id assigned');
      }

      const federatedRaw = row.federated_read;
      const allowedSources = Array.isArray(federatedRaw) ? (federatedRaw as string[]) : [rowSourceId];
      if (allowedSources.length === 0 || !allowedSources.includes(rowSourceId)) {
        throw new InvalidTokenError('OAuth client federated_read must be non-empty and include source_id');
      }

      const boundRaw = row.bound_slug_prefixes;
      const boundSlugPrefixes = Array.isArray(boundRaw)
        ? (boundRaw as string[])
        : undefined;

      // Requirement 7: scope shrink & expansion
      const tokenStoredScopes = (row.scopes as string[]) || [];
      const clientApprovedScopeStr = (row.client_scope as string) || '';
      const clientApprovedScopes = parseScopeString(clientApprovedScopeStr);
      const effectiveScopes = tokenStoredScopes.filter(s => hasScope(clientApprovedScopes, s));

      return {
        token,
        clientId: row.client_id as string,
        clientName: (row.client_name as string | null) ?? undefined,
        scopes: effectiveScopes,
        expiresAt,
        resource: row.resource ? new URL(row.resource as string) : undefined,
        sourceId: rowSourceId,
        allowedSources,
        boundSlugPrefixes,
        authKind: 'oauth',
        approvalState: 'approved',
      } as CoreAuthInfo as SdkAuthInfo;
    }

    // Fallback: legacy access_tokens table
    let legacyRows: Record<string, unknown>[];
    try {
      legacyRows = await this.sql`
        SELECT name, permissions FROM access_tokens
        WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
      `;
    } catch (err) {
      if (isUndefinedColumnError(err, 'permissions')) {
        legacyRows = await this.sql`
          SELECT name FROM access_tokens
          WHERE token_hash = ${tokenHash} AND revoked_at IS NULL
        `;
      } else {
        throw err;
      }
    }

    if (legacyRows.length > 0) {
      await this.sql`
        UPDATE access_tokens SET last_used_at = now() WHERE token_hash = ${tokenHash}
      `;
      const name = legacyRows[0].name as string;
      const permissions = coerceLegacyPermissions(legacyRows[0].permissions);
      const { sourceId, allowedSources } = parseLegacyTokenScope(permissions?.source_id);
      const takesHoldersAllowList = parseTakesHoldersAllowList(permissions?.takes_holders);

      return {
        token,
        clientId: name,
        clientName: name,
        scopes: ['read', 'write', 'admin'],
        expiresAt: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
        sourceId,
        allowedSources,
        takesHoldersAllowList,
        authKind: 'legacy_bearer',
      } as CoreAuthInfo as SdkAuthInfo;
    }

    throw new InvalidTokenError('Invalid token');
  }

  // -------------------------------------------------------------------------
  // Token Revocation
  // -------------------------------------------------------------------------

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const tokenHash = hashToken(request.token);
    await this.sql`
      DELETE FROM oauth_tokens
      WHERE token_hash = ${tokenHash}
        AND client_id = ${client.client_id}
    `;
  }

  // -------------------------------------------------------------------------
  // Client Credentials
  // -------------------------------------------------------------------------

  async verifyConfidentialClientSecret(
    clientId: string,
    presentedSecret: string,
  ): Promise<OAuthClientInformationFull> {
    const dbState = await loadClientDbState(this.sql, clientId);
    if (!dbState || dbState.deletedAt !== null) {
      throw new Error('Invalid client');
    }
    if (dbState.approvalState !== 'approved') {
      throw new Error('approval_pending: Client is pending operator approval');
    }
    if (dbState.clientSecretHash === null) {
      throw new Error('Invalid client');
    }

    const presentedHash = hashToken(presentedSecret);
    if (dbState.clientSecretHash !== presentedHash) {
      throw new Error('Invalid client');
    }

    return {
      client_id: dbState.clientId,
      client_secret: dbState.clientSecretHash,
      client_name: dbState.clientName,
      redirect_uris: dbState.redirectUris,
      grant_types: dbState.grantTypes,
      scope: dbState.scope ?? undefined,
      token_endpoint_auth_method: dbState.tokenEndpointAuthMethod,
      client_id_issued_at: dbState.clientIdIssuedAt,
      client_secret_expires_at: dbState.clientSecretExpiresAt,
      approval_state: dbState.approvalState,
    } as OAuthClientInformationFull;
  }

  async exchangeClientCredentials(
    clientId: string,
    clientSecret: string,
    requestedScope?: string,
  ): Promise<OAuthTokens> {
    const dbState = await loadClientDbState(this.sql, clientId);
    if (!dbState || dbState.deletedAt !== null) {
      throw new Error('Client not found or deleted');
    }
    if (dbState.approvalState !== 'approved') {
      throw new Error('approval_pending: Client is pending operator approval');
    }

    const grants = dbState.grantTypes;
    if (!grants.includes('client_credentials')) {
      throw new Error('Client credentials grant not authorized for this client');
    }

    const secretHash = hashToken(clientSecret);
    if (dbState.clientSecretHash !== secretHash) throw new Error('Invalid client secret');

    const allowedScopes = parseScopeString(dbState.scope ?? '');
    const requestedScopes = requestedScope ? parseScopeString(requestedScope) : allowedScopes;
    const grantedScopes = requestedScopes.filter(s => hasScope(allowedScopes, s));

    let clientTtl: number | undefined;
    try {
      const ttlRows = await this.sql`SELECT token_ttl FROM oauth_clients WHERE client_id = ${clientId}`;
      if (ttlRows.length > 0 && ttlRows[0].token_ttl) clientTtl = Number(ttlRows[0].token_ttl);
    } catch { /* optional */ }

    return this.issueTokens(clientId, grantedScopes, undefined, false, clientTtl);
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  async sweepExpiredTokens(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const result = await this.sql`
      DELETE FROM oauth_tokens WHERE expires_at < ${now} RETURNING 1
    `;
    const deletedCodes = await this.sql`
      DELETE FROM oauth_codes WHERE expires_at < ${now} RETURNING 1
    `;
    return result.length + deletedCodes.length;
  }

  // -------------------------------------------------------------------------
  // Operator Approval & CLI Helpers
  // -------------------------------------------------------------------------

  /**
   * CaD Security Decision:
   * Operator approval of a pending DCR OAuth client requires atomic CAS verification:
   * 1. Exact client ID match
   * 2. Exact metadata verification (redirect_uris, token_endpoint_auth_method, grant_types)
   * 3. Operator assignment of all 3 policy axes: canonical scope, write source_id, read federated_read
   * 4. Verification that source_id and all federated_read sources exist in the database.
   * On any mismatch or error, row remains pending and unapproved.
   */
  async approvePendingClient(opts: ApprovePendingClientOpts): Promise<void> {
    const {
      clientId,
      expectedRedirectUris,
      expectedTokenEndpointAuthMethod,
      expectedGrantTypes,
      expectedResponseTypes,
      scopes,
      sourceId,
      federatedRead,
    } = opts;

    if (!clientId) throw new Error('approvePendingClient requires clientId');
    if (!expectedGrantTypes.length) {
      throw new Error('Approval failed: expected grant types are required');
    }
    if (expectedResponseTypes.some(type => type !== 'code') ||
        (expectedGrantTypes.includes('authorization_code') && !expectedResponseTypes.includes('code')) ||
        (!expectedGrantTypes.includes('authorization_code') && expectedResponseTypes.length > 0)) {
      throw new Error('Approval failed: expected response types do not match expected grants');
    }

    assertAllowedScopes(parseScopeString(scopes));
    assertValidSourceId(sourceId);
    if (!federatedRead || federatedRead.length === 0) {
      throw new Error('Approval failed: federatedRead must be a non-empty list of sources');
    }
    for (const s of federatedRead) assertValidSourceId(s);
    if (!federatedRead.includes(sourceId)) {
      throw new Error('Approval failed: federatedRead must include sourceId');
    }

    const allSourcesToVerify = Array.from(new Set([sourceId, ...federatedRead]));
    const existingSources = await this.sql`
      SELECT id FROM sources WHERE id = ANY(${pgArray(allSourcesToVerify)}) AND archived = false
    `;
    const existingSourceIds = new Set(existingSources.map(r => String(r.id)));
    for (const s of allSourcesToVerify) {
      if (!existingSourceIds.has(s)) {
        throw new Error('Approval failed: source verification failed');
      }
    }

    const dbState = await loadClientDbState(this.sql, clientId);
    if (!dbState) {
      throw new Error('Approval failed: client not found');
    }
    if (dbState.deletedAt !== null) {
      throw new Error('Approval failed: client is deleted');
    }
    if (dbState.approvalState !== 'pending') {
      throw new Error('Approval failed: client is not pending');
    }

    const storedRedirects = [...dbState.redirectUris].map(s => String(s).trim()).sort();
    const expRedirects = expectedRedirectUris.map(s => String(s).trim()).sort();
    const redirectsMatch = storedRedirects.length === expRedirects.length &&
      storedRedirects.every((val, idx) => val === expRedirects[idx]);

    const storedAuthMethod = dbState.tokenEndpointAuthMethod || 'client_secret_post';
    const authMethodMatch = storedAuthMethod === expectedTokenEndpointAuthMethod;

    const storedGrants = [...dbState.grantTypes].map(s => String(s).trim()).sort();
    const expGrants = expectedGrantTypes.map(s => String(s).trim()).sort();
    const grantsMatch = storedGrants.length === expGrants.length &&
      storedGrants.every((val, idx) => val === expGrants[idx]);
    const storedResponseTypes = [...dbState.responseTypes].map(s => String(s).trim()).sort();
    const expResponseTypes = expectedResponseTypes.map(s => String(s).trim()).sort();
    const responseTypesMatch = storedResponseTypes.length === expResponseTypes.length &&
      storedResponseTypes.every((val, idx) => val === expResponseTypes[idx]);

    if (!redirectsMatch || !authMethodMatch || !grantsMatch || !responseTypesMatch) {
      throw new Error('Approval failed: metadata mismatch');
    }

    // Keep the source-state check and approval CAS in one statement. FOR UPDATE
    // prevents a concurrent archive from changing a verified source until this
    // approval commits (or rolls back); checking first and updating later is a
    // TOCTOU that can approve an already-archived write/read source.
    const updated = await this.sql`
      WITH locked_sources AS (
        SELECT id
          FROM sources
         WHERE id = ANY(${pgArray(allSourcesToVerify)})
           AND archived = false
         FOR UPDATE
      )
      UPDATE oauth_clients
         SET approval_state = 'approved',
             scope = ${scopes},
             source_id = ${sourceId},
             federated_read = ${pgArray(federatedRead)}
       WHERE client_id = ${clientId}
         AND approval_state = 'pending'
         AND deleted_at IS NULL
         AND redirect_uris = ${pgArray(expRedirects)}
         AND grant_types = ${pgArray(expGrants)}
         AND response_types = ${pgArray(expResponseTypes)}
         AND COALESCE(token_endpoint_auth_method, 'client_secret_post') = ${expectedTokenEndpointAuthMethod}
         AND (
           (${expectedTokenEndpointAuthMethod} = 'none' AND client_secret_hash IS NULL)
           OR (${expectedTokenEndpointAuthMethod} <> 'none' AND client_secret_hash IS NOT NULL)
         )
         AND ${sourceId} IN (SELECT id FROM locked_sources)
         AND (SELECT count(*) FROM locked_sources) = ${allSourcesToVerify.length}
       RETURNING client_id
    `;

    if (updated.length === 0) {
      throw new Error('Approval failed: atomic update failed');
    }
  }

  async registerClientManual(
    name: string,
    grantTypes: string[],
    scopes: string = 'read',
    redirectUris: string[] = [],
    sourceId: string = 'default',
    federatedRead?: string[],
    tokenEndpointAuthMethod?: string,
    agentBindings?: AgentBindings,
    explicitApproved: boolean = true,
  ): Promise<{ clientId: string; clientSecret?: string }> {
    if (agentBindings?.boundSlugPrefixes) {
      if (agentBindings.boundSlugPrefixes.length === 0) {
        throw new Error('--bound-slug-prefixes cannot be an empty list (pass prefixes, or omit the flag for full-source write authority)');
      }
      assertValidSlugPrefixes(agentBindings.boundSlugPrefixes);
    }

    const authMethod = validateTokenEndpointAuthMethod(tokenEndpointAuthMethod);
    const clientId = generateToken('gbrain_cl_');
    const isPublicClient = authMethod === 'none';
    const clientSecret = isPublicClient ? undefined : generateToken('gbrain_cs_');
    const secretHash = clientSecret ? hashToken(clientSecret) : null;
    const now = Math.floor(Date.now() / 1000);

    const effectiveSourceId = sourceId || 'default';
    const effectiveFederated = federatedRead && federatedRead.length > 0 ? federatedRead : [effectiveSourceId];

    const isApproved = explicitApproved;

    let finalApprovalState: 'approved' | 'pending' = 'pending';
    let finalScope: string | null = null;
    let finalSourceId: string | null = null;
    let finalFederated: string[] = [];

    if (isApproved) {
      const validScope = scopes;
      const validSourceId = effectiveSourceId;
      const validFederated = effectiveFederated;

      assertAllowedScopes(parseScopeString(validScope));
      assertValidSourceId(validSourceId);
      for (const s of validFederated) assertValidSourceId(s);
      if (!validFederated.includes(validSourceId)) {
        throw new Error('federatedRead must include sourceId');
      }

      finalApprovalState = 'approved';
      finalScope = validScope;
      finalSourceId = validSourceId;
      finalFederated = validFederated;
    }

    if (agentBindings) {
      await this.sql`
        INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                    grant_types, scope, token_endpoint_auth_method,
                                    client_id_issued_at, approval_state,
                                    source_id, federated_read,
                                    bound_tools, bound_source_id, bound_brain_id,
                                    bound_slug_prefixes, bound_max_concurrent, budget_usd_per_day)
        VALUES (${clientId}, ${secretHash}, ${name},
                ${pgArray(redirectUris)}, ${pgArray(grantTypes)}, ${finalScope}, ${authMethod}, ${now}, ${finalApprovalState},
                ${finalSourceId}, ${pgArray(finalFederated)},
                ${agentBindings.boundTools ? pgArray(agentBindings.boundTools) : null},
                ${agentBindings.boundSourceId ?? null}, ${agentBindings.boundBrainId ?? null},
                ${agentBindings.boundSlugPrefixes ? pgArray(agentBindings.boundSlugPrefixes) : null},
                ${agentBindings.boundMaxConcurrent ?? 1}, ${agentBindings.budgetUsdPerDay ?? null})
      `;
    } else {
      await this.sql`
        INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris,
                                    grant_types, scope, token_endpoint_auth_method,
                                    client_id_issued_at, approval_state,
                                    source_id, federated_read)
        VALUES (${clientId}, ${secretHash}, ${name},
                ${pgArray(redirectUris)}, ${pgArray(grantTypes)}, ${finalScope}, ${authMethod}, ${now}, ${finalApprovalState},
                ${finalSourceId}, ${pgArray(finalFederated)})
      `;
    }

    return { clientId, clientSecret };
  }

  async rescopeClient(
    clientId: string,
    opts: { sourceId?: string; federatedRead?: string[]; boundSlugPrefixes?: string[] | null },
  ): Promise<{ clientId: string; clientName: string; sourceId: string; federatedRead: string[]; boundSlugPrefixes?: string[] | null }> {
    const dbState = await loadClientDbState(this.sql, clientId);
    if (!dbState || dbState.deletedAt !== null) {
      throw new Error(`No OAuth client found with id "${clientId}"`);
    }
    if (dbState.approvalState !== 'approved') {
      throw new Error('rescope-client can only rescope approved OAuth clients');
    }

    const { sourceId, federatedRead, boundSlugPrefixes } = opts;
    if (sourceId === undefined && federatedRead === undefined && boundSlugPrefixes === undefined) {
      throw new Error('rescope-client requires --source, --federated-read, and/or --bound-slug-prefixes');
    }
    if (sourceId !== undefined) assertValidSourceId(sourceId);
    if (federatedRead !== undefined) {
      if (federatedRead.length === 0) {
        throw new Error('--federated-read cannot be empty (pass at least one source id)');
      }
      for (const s of federatedRead) assertValidSourceId(s);
    }
    if (Array.isArray(boundSlugPrefixes)) {
      if (boundSlugPrefixes.length === 0) {
        throw new Error('--bound-slug-prefixes cannot be an empty list (pass prefixes, or "none" to clear the binding)');
      }
      assertValidSlugPrefixes(boundSlugPrefixes);
    }

    const targetSourceId = sourceId ?? dbState.sourceId;
    const targetFederatedRead = federatedRead ?? dbState.federatedRead;
    if (targetSourceId && targetFederatedRead && !targetFederatedRead.includes(targetSourceId)) {
      throw new Error(`Write source "${targetSourceId}" must be included in federated_read list`);
    }

    let rows: Record<string, unknown>[];
    try {
      rows = boundSlugPrefixes === undefined
        ? await this.sql`
            UPDATE oauth_clients
               SET source_id = COALESCE(${sourceId ?? null}::text, source_id),
                   federated_read = COALESCE(${federatedRead ? pgArray(federatedRead) : null}::text[], federated_read)
             WHERE client_id = ${clientId} AND approval_state = 'approved'
             RETURNING client_id, client_name, source_id, federated_read
          `
        : await this.sql`
            UPDATE oauth_clients
               SET source_id = COALESCE(${sourceId ?? null}::text, source_id),
                   federated_read = COALESCE(${federatedRead ? pgArray(federatedRead) : null}::text[], federated_read),
                   bound_slug_prefixes = ${boundSlugPrefixes ? pgArray(boundSlugPrefixes) : null}::text[]
             WHERE client_id = ${clientId} AND approval_state = 'approved'
             RETURNING client_id, client_name, source_id, federated_read, bound_slug_prefixes
          `;
    } catch (err) {
      if ((err as { code?: string })?.code === '23503') {
        throw new Error(`Source "${sourceId}" does not exist. Create it first: gbrain sources add ${sourceId} ...`);
      }
      throw err;
    }
    if (rows.length === 0) {
      throw new Error(`No OAuth client found with id "${clientId}"`);
    }
    const row = rows[0];
    return {
      clientId: row.client_id as string,
      clientName: (row.client_name as string | null) ?? '',
      sourceId: (row.source_id as string | null) ?? 'default',
      federatedRead: Array.isArray(row.federated_read) ? (row.federated_read as string[]) : [],
      boundSlugPrefixes: 'bound_slug_prefixes' in row
        ? (Array.isArray(row.bound_slug_prefixes) ? (row.bound_slug_prefixes as string[]) : null)
        : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Internal: Issue access + optional refresh tokens
  // -------------------------------------------------------------------------

  private async issueTokens(
    clientId: string,
    scopes: string[],
    resource: URL | undefined,
    includeRefresh: boolean,
    ttlOverride?: number,
  ): Promise<OAuthTokens> {
    const dbState = await loadClientDbState(this.sql, clientId);
    if (!dbState || dbState.deletedAt !== null) {
      throw new Error('Client not found or deleted');
    }
    if (dbState.approvalState !== 'approved') {
      throw new Error('approval_pending: Cannot issue tokens for a pending client');
    }

    const accessToken = generateToken('gbrain_at_');
    const accessHash = hashToken(accessToken);
    const now = Math.floor(Date.now() / 1000);
    const effectiveTtl = ttlOverride || this.tokenTtl;
    const accessExpiry = now + effectiveTtl;

    await this.sql`
      INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource)
      VALUES (${accessHash}, ${'access'}, ${clientId},
              ${pgArray(scopes)}, ${accessExpiry}, ${resource?.toString() || null})
    `;

    const result: OAuthTokens = {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: effectiveTtl,
      scope: scopes.join(' '),
    };

    if (includeRefresh) {
      const refreshToken = generateToken('gbrain_rt_');
      const refreshHash = hashToken(refreshToken);
      const refreshExpiry = now + this.refreshTtl;

      await this.sql`
        INSERT INTO oauth_tokens (token_hash, token_type, client_id, scopes, expires_at, resource)
        VALUES (${refreshHash}, ${'refresh'}, ${clientId},
                ${pgArray(scopes)}, ${refreshExpiry}, ${resource?.toString() || null})
      `;

      result.refresh_token = refreshToken;
    }

    return result;
  }
}
