/**
 * F3 legacy token grants (O-CEO-8, O-DX-9).
 *
 * `legacy_token_grant_shape` (informational, status ok): active tokens still
 * on the JSONB-only grant shape. They keep working; the next grant edit
 * migrates each one, or `gbrain auth rescope --migrate-legacy` writes the
 * columns for all of them without changing any grant.
 *
 * `legacy_token_grant_drift` (warn): migrated tokens whose `permissions`
 * mirror disagrees with the grant columns (an older gbrain edited the JSONB).
 * Each drifted axis denies every request until the operator picks a side.
 */
import { grantFromTokenRow, type LegacyGrantAxis } from '../../../core/grants/model.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';

const DOCS = 'docs/mcp/ADMIN.md#legacy-token-grants';

async function runLegacyTokenGrants(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  const rows = await connectedEngine(ctx).executeRaw<Record<string, unknown>>(
    'SELECT * FROM access_tokens WHERE revoked_at IS NULL ORDER BY created_at, id');
  const legacy: Array<{ name: string; id: string; malformed: boolean }> = [];
  const drift: Array<{ name: string; id: string; axes: LegacyGrantAxis[] }> = [];
  for (const row of rows) {
    const grant = grantFromTokenRow(row);
    const entry = { name: String(row.name), id: String(row.id) };
    if (grant.shape === 'legacy_permissions') legacy.push({ ...entry, malformed: grant.permissionsMalformed });
    if (grant.drift.length) drift.push({ ...entry, axes: grant.drift });
  }
  const malformed = legacy.filter(t => t.malformed);
  checks.push({
    name: 'legacy_token_grant_shape',
    status: 'ok',
    message: legacy.length === 0
      ? 'Every active legacy token uses the unified grant columns.'
      : `${legacy.length} active legacy token(s) still use the permissions-JSON grant shape; they keep working. `
        + 'Write the unified columns without changing any grant: gbrain auth rescope --migrate-legacy (preview with --dry-run; no user decision needed).'
        + (malformed.length ? ` ${malformed.length} have malformed permissions and will be skipped; ask the user which grant each should hold, then run gbrain auth rescope --id <id> with explicit --sources/--takes-holders/--operations (ids in details.malformed).` : '')
        + ` See ${DOCS}.`,
    details: { legacy_shape_count: legacy.length, malformed: malformed.map(({ name, id }) => ({ name, id })), docs: DOCS },
  });
  checks.push({
    name: 'legacy_token_grant_drift',
    status: drift.length ? 'warn' : 'ok',
    message: drift.length === 0
      ? 'No legacy token grant has drifted from its permissions mirror.'
      : `${drift.length} legacy token(s) have grant drift: an older gbrain edited the permissions JSON after migration, so the drifted axes deny every request (fail-closed). `
        + 'Ask the user which grant is intended, then for each token run gbrain auth rescope --token <name> --adopt-permissions (keep the JSON edit) or --adopt-columns (restore the columns): '
        + drift.slice(0, 5).map(t => `${t.name} (${t.axes.join(', ')}): gbrain auth rescope --token ${t.name} --adopt-permissions|--adopt-columns`).join('; ')
        + `${drift.length > 5 ? `; and ${drift.length - 5} more in details.drift` : ''}. See ${DOCS}.`,
    details: { drift, docs: DOCS },
  });
  return checks;
}

export const legacyTokenGrantsEntry: DoctorEntry = {
  name: 'legacy_token_grant_shape',
  emits: ['legacy_token_grant_shape', 'legacy_token_grant_drift'],
  run: runLegacyTokenGrants,
};
