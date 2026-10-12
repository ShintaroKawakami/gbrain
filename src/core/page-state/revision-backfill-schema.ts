/**
 * #5216: resumable `pages.knowledge_revision` backfill. The page-state schema
 * adds the column nullable (a NOT NULL volatile default rewrites the table and
 * reads every TOAST value), so rows written before it carry NULL until this
 * pass assigns them a revision. Runs at the end of every migration pass while
 * the column is still nullable; a NOT NULL column costs one catalog probe.
 *
 * Rows are updated in committed id-ordered batches; the cursor is kept in the
 * config row `page_state.revision_backfill`, so an interrupted pass resumes and
 * never reassigns a revision it already gave. A batch that fails is retried row
 * by row; a row that still fails (for example a torn TOAST value) is isolated,
 * reported and retried on at most MAX_ATTEMPTS later passes, never forever;
 * once its attempts are spent, later passes stay quiet.
 * When no NULL row remains the column becomes NOT NULL through a CHECK added
 * NOT VALID, validated without blocking writes, then SET NOT NULL and dropped,
 * so the final constraints equal a fresh install.
 */
import type { BrainEngine } from '../engine.ts';

export const REVISION_BACKFILL_STATE_KEY = 'page_state.revision_backfill';
export const REVISION_BACKFILL_RESUME_COMMAND = 'gbrain apply-migrations --yes';
const MAX_ATTEMPTS = 3;
const CHECK_NAME = 'pages_knowledge_revision_backfilled';

interface FailedRow { id: number; attempts: number; error: string }
interface BackfillState { cursor: number; backfilled: number; failed: FailedRow[] }

export interface RevisionBackfillResult {
  status: 'not_needed' | 'complete' | 'pending';
  backfilled: number;
  failed: FailedRow[];
}

async function readState(engine: BrainEngine): Promise<BackfillState> {
  try {
    const parsed = JSON.parse((await engine.getConfig(REVISION_BACKFILL_STATE_KEY)) ?? 'null') as BackfillState | null;
    if (parsed && Number.isSafeInteger(parsed.cursor) && Array.isArray(parsed.failed)) return parsed;
  } catch { /* a corrupt cursor restarts from the first id; assigned revisions are never reassigned */ }
  return { cursor: 0, backfilled: 0, failed: [] };
}

async function assignRow(engine: BrainEngine, id: number): Promise<void> {
  await engine.executeRaw('UPDATE pages SET knowledge_revision = gen_random_uuid() WHERE id = $1 AND knowledge_revision IS NULL', [id]);
}

export async function resumePageRevisionBackfill(
  engine: BrainEngine,
  opts: { batchSize?: number; log?: (line: string) => void } = {},
): Promise<RevisionBackfillResult> {
  const log = opts.log ?? ((line: string) => process.stderr.write(line + '\n'));
  const column = await engine.executeRaw<{ notnull: boolean }>(
    `SELECT attnotnull AS notnull FROM pg_attribute
      WHERE attrelid = to_regclass('pages') AND attname = 'knowledge_revision' AND NOT attisdropped`);
  if (column.length === 0 || column[0]!.notnull) return { status: 'not_needed', backfilled: 0, failed: [] };

  const batchSize = opts.batchSize ?? 1000;
  const state = await readState(engine);
  const save = () => engine.setConfig(REVISION_BACKFILL_STATE_KEY, JSON.stringify(state));
  let announced = false;
  for (;;) {
    const ids = (await engine.executeRaw<{ id: number }>(
      'SELECT id FROM pages WHERE id > $1 AND knowledge_revision IS NULL ORDER BY id LIMIT $2', [state.cursor, batchSize])).map(r => Number(r.id));
    if (ids.length === 0) break;
    if (!announced) {
      log(`[migrate] backfilling page revisions in batches of ${batchSize} (resumable; resume with: ${REVISION_BACKFILL_RESUME_COMMAND})`);
      announced = true;
    }
    try {
      await engine.executeRaw('UPDATE pages SET knowledge_revision = gen_random_uuid() WHERE id = ANY($1::bigint[]) AND knowledge_revision IS NULL', [ids]);
      state.backfilled += ids.length;
    } catch {
      for (const id of ids) {
        try { await assignRow(engine, id); state.backfilled++; }
        catch (error) {
          state.failed.push({ id, attempts: 1, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) });
        }
      }
    }
    state.cursor = ids[ids.length - 1]!;
    await save();
    log(`[migrate] page revision backfill: ${state.backfilled} row(s) done, through page id ${state.cursor}`);
  }

  const failed: FailedRow[] = [];
  let retried = false;
  for (const row of state.failed) {
    const [still] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE id = $1 AND knowledge_revision IS NULL', [row.id]);
    if (!still) continue;
    if (row.attempts >= MAX_ATTEMPTS) { failed.push(row); continue; }
    retried = true;
    try { await assignRow(engine, row.id); state.backfilled++; }
    catch (error) { failed.push({ id: row.id, attempts: row.attempts + 1, error: (error instanceof Error ? error.message : String(error)).slice(0, 200) }); }
  }
  state.failed = failed;
  if (failed.length > 0) {
    await save();
    if (announced || retried) log(`[migrate] page revision backfill: ${failed.length} row(s) could not be updated (page ids ${failed.slice(0, 10).map(f => f.id).join(', ')}${failed.length > 10 ? ', …' : ''}). `
      + `Writes that name a revision for them are refused with revision_backfill_pending. Diagnose with: gbrain repair orphan-children (preview, includes the torn-TOAST probe). See docs/guides/repair.md#orphan-children`);
    return { status: 'pending', backfilled: state.backfilled, failed };
  }

  await engine.executeRaw(`ALTER TABLE pages DROP CONSTRAINT IF EXISTS ${CHECK_NAME}`);
  await engine.executeRaw(`ALTER TABLE pages ADD CONSTRAINT ${CHECK_NAME} CHECK (knowledge_revision IS NOT NULL) NOT VALID`);
  await engine.executeRaw(`ALTER TABLE pages VALIDATE CONSTRAINT ${CHECK_NAME}`);
  await engine.executeRaw('ALTER TABLE pages ALTER COLUMN knowledge_revision SET NOT NULL');
  await engine.executeRaw(`ALTER TABLE pages DROP CONSTRAINT ${CHECK_NAME}`);
  await engine.unsetConfig(REVISION_BACKFILL_STATE_KEY);
  if (announced) log(`[migrate] page revision backfill complete: ${state.backfilled} row(s)`);
  return { status: 'complete', backfilled: state.backfilled, failed: [] };
}
