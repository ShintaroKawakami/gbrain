/**
 * #2411 / #4102 — drain surface for the `take_proposals` queue.
 *
 * The propose_takes phase writes legacy pending rows; the internal
 * entityless-review phase writes evidence_pending rows. The D17 auto-resolve
 * posture says the ONLY path from either queue status to a canonical take is
 * explicit operator action. This module owns that path:
 *
 *   - listPendingProposals — source-scoped pending queue (newest first).
 *   - acceptProposal       — legacy rows use coordinated `takes_add`; evidence
 *                            rows use a distinct durable maintenance intent
 *                            and evidence status. Both require explicit accept.
 *   - rejectProposal       — legacy rows become rejected; evidence rows become
 *                            evidence_rejected.
 *
 * All reads/writes are parameterized and scoped to the caller's source when
 * one is provided (the CLI always resolves one via resolveSourceId).
 *
 * Legacy promote writes go through submitPageMutation (the SAME coordinated
 * pipeline `takes add`/`takes update`/`takes supersede`/`takes resolve` use),
 * not the uncoordinated addTakeToPage — a managed brain (persistence_brain
 * enabled: Postgres/Supabase with a coordinator-owned worktree) refuses any
 * direct file write outside that pipeline with 'writer_coordinator_required'
 * ("This file belongs to a managed canonical worktree."). Calling
 * addTakeToPage directly here made every `takes propose --accept` fail on a
 * managed brain — including the Slack report-lane's accept-before-correct
 * step, so a corrective reply on a pending proposal could never land.
 */

import { createHash } from 'node:crypto';
import type { BrainEngine, TakeKind } from './engine.ts';
import type { GBrainConfig } from './config.ts';
import type { OperationContext } from './ops/contract.ts';
import { submitPageMutation } from './persistence/page-mutations.ts';
import { waitForWrite } from './persistence/service.ts';
import type { WriteRequest } from './persistence/model.ts';
import { OperationError } from './ops/contract.ts';
import { digest } from './persistence/digest.ts';
import { maintenancePreflight, submitMaintenanceIntent } from './persistence/prepared-maintenance.ts';
import type { MaintenanceAuthority } from './persistence/prepared-maintenance.ts';
import {
  assertEntitylessProposalCurrent,
  parseEntitylessProposalEvidence,
  type EntitylessProposalRecord,
} from './persistence/entityless-proposal-evidence.ts';

export interface TakeProposalRow {
  id: number;
  source_id: string;
  page_slug: string;
  claim_text: string;
  kind: string;
  holder: string;
  weight: number;
  domain: string | null;
  status: string;
  proposed_at: string | Date;
  model_id: string;
  promoted_row_num: number | null;
  evidence: unknown | null;
}

/** Normalize Postgres driver values to the public numeric row contract. */
function normalizeTakeProposalRow(row: TakeProposalRow): TakeProposalRow {
  return {
    ...row,
    id: Number(row.id),
    weight: Number(row.weight),
    promoted_row_num: row.promoted_row_num == null ? null : Number(row.promoted_row_num),
  };
}

export type TakeProposalErrorCode = 'not_found' | 'not_pending' | 'review_refused';

export class TakeProposalError extends Error {
  constructor(
    public readonly code: TakeProposalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TakeProposalError';
  }
}

/**
 * The producer (parseExtractorOutput) only ever writes the four canonical
 * kinds, but the column is free TEXT — coerce defensively so a legacy or
 * hand-inserted row can't crash the promote path. 'prediction' (the raw
 * extractor-prompt enum) maps to 'bet'; anything else unknown maps to 'take'.
 */
export function coerceProposalKind(raw: string): TakeKind {
  if (raw === 'fact' || raw === 'take' || raw === 'bet' || raw === 'hunch') return raw;
  if (raw === 'prediction') return 'bet';
  return 'take';
}

const PROPOSAL_COLUMNS =
  'id, source_id, page_slug, claim_text, kind, holder, weight, domain, status, proposed_at, model_id, promoted_row_num, evidence';

export interface ListPendingOpts {
  /** Scope to one source (the CLI always provides one). Omit = all sources (trusted local only). */
  sourceId?: string;
  limit?: number;
}

/** Pending proposals, newest first. Tombstones never surface (status='rejected'). */
export async function listPendingProposals(
  engine: BrainEngine,
  opts: ListPendingOpts = {},
): Promise<TakeProposalRow[]> {
  const limit = Math.max(1, Math.min(500, opts.limit ?? 20));
  const where = [`status IN ('pending','evidence_pending','evidence_accepting')`];
  const params: unknown[] = [];
  if (opts.sourceId) {
    params.push(opts.sourceId);
    where.push(`source_id = $${params.length}`);
  }
  params.push(limit);
  const rows = await engine.executeRaw<TakeProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS}
       FROM take_proposals
      WHERE ${where.join(' AND ')}
      ORDER BY proposed_at DESC, id DESC
      LIMIT $${params.length}`,
    params,
  );
  return rows.map(normalizeTakeProposalRow);
}

async function loadProposal(
  engine: BrainEngine,
  id: number,
  sourceId?: string,
  opts: { allowStranded?: boolean; allowEvidence?: boolean } = {},
): Promise<TakeProposalRow> {
  const params: unknown[] = [id];
  let scope = '';
  if (sourceId) {
    params.push(sourceId);
    scope = ` AND source_id = $${params.length}`;
  }
  const rows = await engine.executeRaw<TakeProposalRow>(
    `SELECT ${PROPOSAL_COLUMNS} FROM take_proposals WHERE id = $1${scope}`,
    params,
  );
  if (rows.length === 0) {
    throw new TakeProposalError('not_found', `No take proposal #${id}${sourceId ? ` in source '${sourceId}'` : ''}.`);
  }
  const row = normalizeTakeProposalRow(rows[0]);
  if (opts.allowEvidence && ['evidence_pending', 'evidence_accepting', 'evidence_accepted'].includes(row.status)) return row;
  if (row.status !== 'pending') {
    // wave-g (#4480 follow-up): a crash between the accept CAS and the fence
    // write (or a failed rollback) strands the row as status='accepted' with
    // no promoted take — invisible in the pending list, so surface the
    // repairable shape exactly where a human retry lands.
    if (row.status === 'accepted' && row.promoted_row_num == null) {
      if (opts.allowStranded) return row;
      throw new TakeProposalError(
        'not_pending',
        `Proposal #${id} is claimed 'accepted' but its take is not recorded yet (its write is pending, or a crash stopped it). ` +
        `Re-run \`gbrain takes propose --accept ${id}\` to finish it; it resumes the same write and never adds a second take.`,
      );
    }
    throw new TakeProposalError(
      'not_pending',
      `Proposal #${id} is already '${row.status}' (acted on) — only pending proposals can be accepted or rejected.`,
    );
  }
  return row;
}

export interface ProposalActionTarget {
  engine: BrainEngine;
  /** Brain repo root — accept writes the markdown fence (markdown-canonical). */
  brainDir?: string;
  /** Source scope: a proposal outside this source reads as not_found. */
  sourceId?: string;
  /** Recorded in acted_by. Defaults to 'cli'. */
  actedBy?: string;
  /** Threaded into the coordinated takes_add mutation accept performs. */
  config: GBrainConfig;
  /** An explicit `--dir`: validated against the source's canonical root, as `takes add --dir` is. */
  localDir?: string;
}

/**
 * One write request per claim: derived from the proposal id and the claim's
 * acted_at, so resuming a claimed-but-unrecorded accept replays the same
 * durable request (a pending or committed takes_add is never admitted twice),
 * while a fresh claim after a released failure gets a new request.
 */
const SETTLED_WITHOUT_COMMIT = new Set(['failed', 'cancelled', 'conflict']);

async function claimRequestStates(engine: BrainEngine, requestId: string): Promise<WriteRequest[]> {
  return engine.executeRaw<WriteRequest>('SELECT * FROM persistence_requests WHERE request_id = $1::uuid', [requestId]);
}

/** A claim younger than this may belong to an accept that is still submitting its write. */
const RESUME_GRACE_MS = 2 * 60_000;

function claimRequestId(id: number, actedAt: string): string {
  const h = createHash('sha256').update(`take-proposal-accept:${id}:${actedAt}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/**
 * Promotes an accepted proposal into the page's fence via the SAME
 * coordinated `takes_add` mutation `gbrain takes add` uses — never the
 * uncoordinated addTakeToPage — so a managed brain's writer-coordinator
 * guard (assertManagedFilesystemWrite) sees this write the same way it sees
 * every other takes mutation, instead of refusing it as an uncoordinated
 * legacy writer.
 *
 * The mutation resolves its own write root from the proposal's source
 * (source.local_path / sync.repo_path), as `gbrain takes add <slug>` does; an
 * explicit `--dir` rides along as `local_dir`, which the coordinator refuses
 * unless it is that canonical root.
 */
async function promoteProposalViaTakesAdd(
  target: ProposalActionTarget,
  proposal: TakeProposalRow,
  requestId: string,
): Promise<number> {
  const ctx: OperationContext = {
    engine: target.engine,
    config: target.config,
    remote: false,
    sourceId: proposal.source_id,
    dryRun: false,
    logger: { info: message => console.error(message), warn: message => console.error(message), error: message => console.error(message) },
  };
  const params: Record<string, unknown> = {
    slug: proposal.page_slug,
    claim: proposal.claim_text,
    kind: coerceProposalKind(proposal.kind),
    holder: proposal.holder,
    weight: typeof proposal.weight === 'number' ? proposal.weight : Number(proposal.weight),
    source_id: proposal.source_id,
    request_id: requestId,
    ...(target.localDir !== undefined ? { local_dir: target.localDir } : {}),
  };
  const result = await submitPageMutation(ctx, { operation: 'takes_add', params });
  return Number(result.row_num);
}

async function acceptEntitylessProposal(target: ProposalActionTarget, proposal: TakeProposalRow): Promise<number> {
  const { engine } = target;
  let evidence;
  try {
    evidence = parseEntitylessProposalEvidence(proposal.evidence);
  } catch (error) {
    throw new TakeProposalError('review_refused', error instanceof Error ? error.message : 'The review evidence is malformed.');
  }
  // This guard precedes preflight, CAS and durable request admission. Private
  // evidence can be inspected or rejected on this CLI, but can never publish.
  if (evidence.visibility === 'private') {
    throw new TakeProposalError('review_refused', 'Private entityless fact proposals are local-only and cannot be published.');
  }
  if (proposal.status === 'evidence_accepted') {
    if (proposal.promoted_row_num == null || !Number.isSafeInteger(proposal.promoted_row_num)) {
      throw new TakeProposalError('review_refused', `Proposal #${proposal.id} has an invalid accepted receipt.`);
    }
    return proposal.promoted_row_num;
  }
  if (proposal.status !== 'evidence_pending' && proposal.status !== 'evidence_accepting') {
    throw new TakeProposalError('not_pending', `Proposal #${proposal.id} is already '${proposal.status}'.`);
  }

  let authority: MaintenanceAuthority | null = null;
  try {
    if (proposal.status === 'evidence_pending') await assertEntitylessProposalCurrent(engine, asEntitylessRecord(proposal));
    authority = await maintenancePreflight(engine, proposal.source_id, target.localDir ?? target.brainDir,
      { allowUnmanagedDatabaseOnly: true });
    if (!authority) throw new OperationError('owner_unavailable', 'The source is not ready for proposal publication.');
  } catch (error) {
    if (proposal.status === 'evidence_accepting') await restoreEntitylessProposalIfSettled(engine, proposal.id, proposal.source_id);
    throw proposalActionError(error);
  }

  if (proposal.status === 'evidence_pending') {
    const claimed = await engine.executeRaw<{ id: number }>(`UPDATE take_proposals
      SET status='evidence_accepting',acted_at=now(),acted_by=$2
      WHERE id=$1 AND source_id=$3 AND status='evidence_pending' RETURNING id`,
    [proposal.id, target.actedBy ?? 'cli', proposal.source_id]);
    if (claimed.length === 0) {
      throw new TakeProposalError('not_pending', `Proposal #${proposal.id} was acted on concurrently.`);
    }
  }

  const intent = {
    kind: 'managed_maintenance_entityless_proposal_accept',
    proposal_id: proposal.id,
    evidence_hash: digest(evidence),
    expected_revision: evidence.target.revision,
  };
  try {
    const result = await submitMaintenanceIntent(engine, authority, proposal.page_slug, intent);
    const rowNum = Number(result.row_num);
    if (!Number.isSafeInteger(rowNum) || rowNum < 1) {
      throw new TakeProposalError('review_refused', `Proposal #${proposal.id} is still awaiting its durable publication receipt.`);
    }
    return rowNum;
  } catch (error) {
    await restoreEntitylessProposalIfSettled(engine, proposal.id, proposal.source_id, authority.writer.principal.kind,
      authority.writer.principal.id);
    throw proposalActionError(error);
  }
}

function asEntitylessRecord(proposal: TakeProposalRow): EntitylessProposalRecord {
  return {
    id: proposal.id, source_id: proposal.source_id, page_slug: proposal.page_slug, claim_text: proposal.claim_text,
    kind: proposal.kind, holder: proposal.holder, weight: proposal.weight, status: proposal.status, evidence: proposal.evidence,
  };
}

function proposalActionError(error: unknown): TakeProposalError {
  if (error instanceof TakeProposalError) return error;
  if (error instanceof OperationError) return new TakeProposalError('review_refused', error.message);
  return new TakeProposalError('review_refused', error instanceof Error ? error.message : String(error));
}

async function restoreEntitylessProposalIfSettled(engine: BrainEngine, id: number, sourceId: string,
  principalKind?: string, principalId?: string): Promise<void> {
  let requestRows: Array<{ state: string }>;
  try {
    requestRows = await engine.executeRaw<{ state: string }>(`SELECT state FROM persistence_requests
      WHERE source_id=$1 AND operation='submit_job' AND intent->>'kind'='managed_maintenance_entityless_proposal_accept'
        AND intent->>'proposal_id'=$2
        AND ($3::text IS NULL OR principal_kind=$3) AND ($4::text IS NULL OR principal_id=$4)`,
    [sourceId, String(id), principalKind ?? null, principalId ?? null]);
  } catch {
    // A failed lookup is unknown state, not proof that the durable request has
    // settled. Retain the claim until a later call can inspect its receipt.
    return;
  }
  const stillRunning = requestRows.some(row => !['failed', 'cancelled', 'conflict'].includes(row.state));
  if (!stillRunning) {
    await engine.executeRaw(`UPDATE take_proposals SET status='evidence_pending',acted_at=NULL,acted_by=NULL,promoted_row_num=NULL
      WHERE id=$1 AND source_id=$2 AND status='evidence_accepting'`, [id, sourceId]).catch(() => undefined);
  }
}

function entitylessStatus(row: TakeProposalRow): boolean {
  return row.status.startsWith('evidence_');
}

/**
 * Promote a pending proposal into the page's takes fence.
 *
 * #4480 (TOCTOU): the row is CLAIMED FIRST via a CAS
 * (`status='pending' → 'accepted'` with the rowcount CHECKED), and only the
 * claim winner performs the fence write. The old order (fence write first,
 * status flip after, rowcount ignored) let two concurrent accepts both pass
 * the pending check and both append the take to the .md — the loser's no-op
 * UPDATE reported success anyway. If the fence write fails after a
 * successful claim, the claim is rolled back (best-effort compensation) so
 * a retry can act on the row.
 */
export async function acceptProposal(
  target: ProposalActionTarget,
  id: number,
): Promise<{ proposal: TakeProposalRow; rowNum: number }> {
  const { engine } = target;
  const proposal = await loadProposal(engine, id, target.sourceId, { allowStranded: true, allowEvidence: true });
  if (entitylessStatus(proposal)) {
    const rowNum = await acceptEntitylessProposal(target, proposal);
    return { proposal: { ...proposal, status: 'evidence_accepted', promoted_row_num: rowNum }, rowNum };
  }
  if (!target.brainDir) {
    throw new TakeProposalError(
      'not_found',
      'Accept requires a brain directory (takes are markdown-canonical). Pass --dir or configure sync.repo_path.',
    );
  }
  // Claim-first CAS: exactly one caller wins the pending row. A claim that is
  // already held without a recorded take resumes under its own request id.
  const claimed = proposal.status === 'accepted'
    ? await engine.executeRaw<{ id: number; acted_at: unknown }>(
      `SELECT id, acted_at FROM take_proposals WHERE id = $1 AND status = 'accepted' AND promoted_row_num IS NULL`, [id])
    : await engine.executeRaw<{ id: number; acted_at: unknown }>(
      `UPDATE take_proposals
          SET status = 'accepted', acted_at = now(), acted_by = $2
        WHERE id = $1 AND status = 'pending'
        RETURNING id, acted_at`,
      [id, target.actedBy ?? 'cli'],
    );
  if (claimed.length === 0) {
    throw new TakeProposalError(
      'not_pending',
      `Proposal #${id} was acted on concurrently — only one accept/reject can win a pending row.`,
    );
  }
  const claimedAt = claimed[0]!.acted_at == null ? null : new Date(claimed[0]!.acted_at as string | Date).toISOString();
  const actedAt = claimedAt ?? 'unclaimed';
  const requestId = claimRequestId(id, actedAt);
  // The claim's durable request may already exist, under this or another
  // local writer (the journal keys requests per principal). Settle from it
  // instead of submitting a second takes_add.
  let prior = await claimRequestStates(engine, requestId);
  const inFlight = prior.find(r => r.state !== 'committed' && !SETTLED_WITHOUT_COMMIT.has(r.state));
  if (inFlight) {
    // Drive the existing request through this host's persistence owner (a
    // standalone CLI has none running) instead of submitting another.
    await waitForWrite(engine, inFlight, target.config).catch(() => undefined);
    prior = await claimRequestStates(engine, requestId);
  } else if (prior.length === 0 && proposal.status === 'accepted' && claimedAt && Date.now() - Date.parse(claimedAt) < RESUME_GRACE_MS) {
    throw new TakeProposalError('not_pending', `Proposal #${id} was just claimed by another accept that may still be submitting its take. Re-run \`gbrain takes propose --accept ${id}\` in a few minutes.`);
  }
  const committed = prior.find(r => r.state === 'committed');
  let rowNum: number;
  if (committed) {
    rowNum = Number((committed.outcome as { row_num?: unknown } | null)?.row_num);
    if (!Number.isSafeInteger(rowNum) || rowNum < 1) {
      throw new TakeProposalError('not_pending', `Proposal #${id}'s take was written (request ${requestId}) but its receipt no longer names the row; check the page's takes and record it by hand.`);
    }
  } else if (prior.some(r => !SETTLED_WITHOUT_COMMIT.has(r.state))) {
    throw new TakeProposalError('not_pending', `Proposal #${id}'s take is still being written (request ${requestId}). Re-run \`gbrain takes propose --accept ${id}\` once it settles.`);
  } else {
    try {
      // The row's OWN source, never the caller's, is what promoteProposalViaTakesAdd
      // scopes the mutation to — the scoped load above already proved they agree
      // when a caller scope was provided.
      rowNum = await promoteProposalViaTakesAdd(target, proposal, requestId);
    } catch (e) {
      // Release the claim only when its write provably cannot commit: no
      // durable request was admitted, or every one settled without committing.
      // A pending, replay-conflicting or committed request keeps the claim, so
      // neither a reject nor a second accept can race it; re-running accept
      // settles from it. Compensation is bound to this exact, unpromoted claim.
      const after = await claimRequestStates(engine, requestId);
      if (after.every(r => SETTLED_WITHOUT_COMMIT.has(r.state))) {
        try {
          await engine.executeRaw(
            `UPDATE take_proposals
                SET status = 'pending', acted_at = NULL, acted_by = NULL, promoted_row_num = NULL
              WHERE id = $1 AND status = 'accepted' AND promoted_row_num IS NULL
                AND date_trunc('milliseconds', acted_at) IS NOT DISTINCT FROM $2::timestamptz`,
            [id, claimedAt],
          );
        } catch { /* compensation is best-effort */ }
      }
      throw e;
    }
  }
  await engine.executeRaw(
    `UPDATE take_proposals SET promoted_row_num = $2 WHERE id = $1`,
    [id, rowNum],
  );
  return { proposal, rowNum };
}

/** Mark a pending proposal rejected. No markdown write. #4480: rowcount is
 * CHECKED — a reject that loses a race (row already accepted/rejected) now
 * reports the truth instead of claiming a rejection it never performed. */
export async function rejectProposal(
  target: Pick<ProposalActionTarget, 'engine' | 'sourceId' | 'actedBy'>,
  id: number,
): Promise<TakeProposalRow> {
  const { engine } = target;
  const proposal = await loadProposal(engine, id, target.sourceId, { allowEvidence: true });
  const evidencePending = proposal.status === 'evidence_pending';
  if (!evidencePending && proposal.status !== 'pending') {
    throw new TakeProposalError('not_pending', `Proposal #${id} is already '${proposal.status}' (acted on) — only pending proposals can be rejected.`);
  }
  const pendingStatus = evidencePending ? 'evidence_pending' : 'pending';
  const rejectedStatus = evidencePending ? 'evidence_rejected' : 'rejected';
  const rejected = await engine.executeRaw<{ id: number }>(
    `UPDATE take_proposals
        SET status = $3, acted_at = now(), acted_by = $2
      WHERE id = $1 AND status = $4
      RETURNING id`,
    [id, target.actedBy ?? 'cli', rejectedStatus, pendingStatus],
  );
  if (rejected.length === 0) {
    throw new TakeProposalError(
      'not_pending',
      `Proposal #${id} was acted on concurrently — only one accept/reject can win a pending row.`,
    );
  }
  return proposal;
}
