import { test } from 'bun:test';
import { hasDatabase } from './helpers.ts';

// Foundations 1 write attribution on Postgres: the transaction-local actor
// settings and BEFORE ROW triggers, run direct and through transaction-mode
// PgBouncer (scripts/e2e-backend-matrix.txt). The legacy file covers the
// unmanaged transactional writers (F1c).
if (hasDatabase()) {
  await import('../write-attribution.test.ts');
  await import('../write-attribution-legacy.test.ts');
} else {
  test.skip('write attribution on Postgres requires DATABASE_URL', () => {});
}
