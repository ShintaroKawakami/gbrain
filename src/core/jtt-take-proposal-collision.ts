import type { BrainEngine } from './engine.ts';

/**
 * JTT fork: take_proposal_evidence previously occupied schema stamp 296
 * (v0.60.609.0-jtt). Upstream v0.60.641.0 owns 296 (ingest_applied_captures)
 * and 297 (chronicle_judge_window); JTT's migration is now v298.
 *
 * A production brain at config.version=296 with JTT's evidence column but
 * without ingest_applied_captures has NOT applied upstream v296. Rewind the
 * stamp to 295 so runMigrations applies 296 → 297 → 298. v298 is idempotent,
 * so the evidence column is not applied twice.
 *
 * Returns the stamp after rewind, or null when no rewrite was needed.
 */
export async function rewindJttTakeProposalCollision(engine: BrainEngine): Promise<number | null> {
  const current = await engine.getConfig('version');
  if (current !== '296') return null;

  const [evidence] = await engine.executeRaw<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'take_proposals' AND column_name = 'evidence'
     ) AS ok`,
  );
  const [ingest] = await engine.executeRaw<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'ingest_applied_captures'
     ) AS ok`,
  );
  if (!evidence?.ok || ingest?.ok) return null;

  await engine.setConfig('version', '295');
  process.stderr.write(
    '  [jtt] schema stamp 296 was JTT take_proposal_evidence; rewound to 295 so upstream v296–v297 can apply\n',
  );
  return 295;
}
