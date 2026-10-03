import type { GBrainConfig } from '../config.ts';
import type { BrainEngine } from '../engine.ts';
import type { EntitylessProposalEvidenceV1, FactEvidenceSnapshot } from '../cycle/entityless-proposals.ts';
import { OperationError } from '../ops/contract.ts';
import { prepareTakesMutation } from './takes-prepare.ts';
import { digest, stableJson } from './digest.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';

export interface EntitylessProposalRecord {
  id: number;
  source_id: string;
  page_slug: string;
  claim_text: string;
  kind: string;
  holder: string;
  weight: number | string;
  status: string;
  evidence: unknown;
}

interface RawFactSnapshot extends Omit<FactEvidenceSnapshot, 'id' | 'row_num' | 'superseded_by' | 'consolidated_into' | 'claim_value' | 'confidence'
  | 'valid_from' | 'valid_until' | 'expired_at' | 'consolidated_at'> {
  id: number | string;
  row_num: number | string | null;
  superseded_by: number | string | null;
  consolidated_into: number | string | null;
  claim_value: number | string | null;
  confidence: number | string;
  valid_from: Date | string;
  valid_until: Date | string | null;
  expired_at: Date | string | null;
  consolidated_at: Date | string | null;
  withdrawn: boolean;
}

interface CurrentFactEvidence extends FactEvidenceSnapshot { withdrawn?: boolean; }

export function parseEntitylessProposalEvidence(value: unknown): EntitylessProposalEvidenceV1 {
  let raw = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { throw invalidEvidence(); }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw invalidEvidence();
  const evidence = raw as Partial<EntitylessProposalEvidenceV1>;
  if (evidence.version !== 1 || evidence.reason !== 'subject_unknown' || evidence.contradictions !== 'unverified'
    || typeof evidence.source_id !== 'string' || !evidence.source_id
    || typeof evidence.source_incarnation !== 'string' || !evidence.source_incarnation
    || !evidence.target || typeof evidence.target.slug !== 'string' || !evidence.target.slug.trim()
    || evidence.target.page_id !== null && (!Number.isSafeInteger(evidence.target.page_id) || Number(evidence.target.page_id) < 1)
    || evidence.target.revision !== null && typeof evidence.target.revision !== 'string'
    || !['world', 'private'].includes(String(evidence.visibility))
    || !evidence.candidate || typeof evidence.candidate.claim_text !== 'string' || !evidence.candidate.claim_text.trim()
    || evidence.candidate.kind !== 'fact' || evidence.candidate.holder !== 'self'
    || !Number.isFinite(evidence.candidate.weight) || Number(evidence.candidate.weight) < 0 || Number(evidence.candidate.weight) > 1
    || typeof evidence.candidate.since !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(evidence.candidate.since)
    || !Array.isArray(evidence.facts) || evidence.facts.length < 2 || evidence.facts.length > 100) throw invalidEvidence();
  const ids = new Set<number>();
  for (const fact of evidence.facts) {
    if (!fact || !Number.isSafeInteger(fact.id) || Number(fact.id) < 1 || ids.has(Number(fact.id))
      || fact.source_id !== evidence.source_id || fact.entity_slug !== null || fact.visibility !== evidence.visibility
      || typeof fact.fact !== 'string' || typeof fact.kind !== 'string' || typeof fact.source !== 'string'
      || !Number.isFinite(fact.confidence) || typeof fact.valid_from !== 'string') throw invalidEvidence();
    ids.add(Number(fact.id));
  }
  if (!evidence.facts.some(fact => fact.fact === evidence.candidate!.claim_text)) throw invalidEvidence();
  return evidence as EntitylessProposalEvidenceV1;
}

/** Recheck the current source, public target revision and semantic fact rows. */
export async function assertEntitylessProposalCurrent(
  engine: BrainEngine,
  proposal: EntitylessProposalRecord,
  options: { lock?: boolean } = {},
): Promise<EntitylessProposalEvidenceV1> {
  const evidence = parseEntitylessProposalEvidence(proposal.evidence);
  if (evidence.visibility !== 'world') {
    throw new OperationError('permission_denied', 'Private entityless fact proposals are local-only and cannot be published.');
  }
  if (proposal.source_id !== evidence.source_id || proposal.page_slug !== evidence.target.slug
    || proposal.claim_text !== evidence.candidate.claim_text || proposal.kind !== 'fact' || proposal.holder !== 'self'
    || Math.abs(Number(proposal.weight) - evidence.candidate.weight) > 1e-8) throw invalidEvidence();
  if (!evidence.target.revision || !evidence.target.page_id) {
    throw new OperationError('page_not_found', 'target_not_ready: create the explicit target page, then run a fresh review proposal.');
  }

  const lock = options.lock === true;
  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean }>(
    `SELECT incarnation,archived FROM sources WHERE id=$1${lock ? ' FOR SHARE' : ''}`, [evidence.source_id]);
  if (!source || source.archived || source.incarnation !== evidence.source_incarnation) {
    throw new OperationError('source_changed', 'The proposal source incarnation changed; create a fresh review proposal.');
  }

  const target = await engine.readPageSnapshot(evidence.target.slug, {
    sourceId: evidence.source_id,
    excludePrivate: true,
    requireLiveSource: true,
  });
  if (!target) throw new OperationError('page_not_found', 'target_not_ready: the explicit target is missing, deleted or private.');
  if (Number(target.page.id) !== evidence.target.page_id || target.revision !== evidence.target.revision
    || target.sourceIncarnation !== evidence.source_incarnation) {
    throw new OperationError('revision_conflict', 'The explicit target page changed after review; create a fresh proposal.');
  }

  const current = await readEvidenceFacts(engine, evidence.source_id, evidence.facts.map(fact => fact.id), lock);
  const expected = [...evidence.facts].sort((a, b) => a.id - b.id);
  if (current.length !== expected.length || stableJson(current) !== stableJson(expected)) {
    throw new OperationError('revision_conflict', 'The source facts changed after review; the proposal remains available for review.');
  }
  const nowRows = await engine.executeRaw<{ now: Date | string }>('SELECT now() AS now');
  const now = new Date(nowRows[0]!.now).getTime();
  if (current.some(fact => fact.visibility !== 'world' || fact.entity_slug !== null || fact.expired_at !== null
    || fact.consolidated_at !== null || fact.consolidated_into !== null || fact.withdrawn
    || fact.superseded_by !== null || Date.parse(fact.valid_from) > now || fact.valid_until !== null)) {
    throw new OperationError('revision_conflict', 'The source facts are inactive, withdrawn or have a finite validity end.');
  }
  return evidence;
}

/** Build the non-legacy prepared path from the durable proposal row, never caller-supplied fact evidence. */
export async function prepareEntitylessProposalAccept(
  engine: BrainEngine,
  row: WriteRequest,
  config: GBrainConfig,
): Promise<PreparedMutation> {
  if (row.authority.remote !== false) {
    throw new OperationError('permission_denied', 'Entityless proposal publication is local-CLI-only.');
  }
  const proposalId = Number(row.intent?.proposal_id);
  if (!Number.isSafeInteger(proposalId) || proposalId < 1 || typeof row.intent?.evidence_hash !== 'string') {
    throw invalidEvidence();
  }
  const [stored] = await engine.executeRaw<EntitylessProposalRecord>(`SELECT id,source_id,page_slug,claim_text,kind,holder,weight,status,evidence
    FROM take_proposals WHERE id=$1 AND source_id=$2`, [proposalId, row.source_id]);
  if (!stored || stored.status !== 'evidence_accepting') {
    throw new OperationError('revision_conflict', 'The entityless proposal is no longer in its guarded acceptance state.');
  }
  const evidence = parseEntitylessProposalEvidence(stored.evidence);
  if (digest(evidence) !== row.intent.evidence_hash || evidence.source_id !== row.source_id
    || evidence.target.slug !== row.slug || evidence.target.revision !== row.intent.expected_revision) throw invalidEvidence();
  await assertEntitylessProposalCurrent(engine, stored);

  const prepared = await prepareTakesMutation(engine, {
    ...row,
    operation: 'takes_add',
    intent: {
      claim: evidence.candidate.claim_text,
      kind: 'fact',
      holder: 'self',
      weight: evidence.candidate.weight,
      since: evidence.candidate.since,
      source: `entityless-proposal:${proposalId}`,
      expected_revision: evidence.target.revision,
    },
  }, config);
  return {
    ...prepared,
    validate: async tx => {
      await prepared.validate?.(tx);
      const [currentProposal] = await tx.executeRaw<EntitylessProposalRecord>(`SELECT id,source_id,page_slug,claim_text,kind,holder,weight,status,evidence
        FROM take_proposals WHERE id=$1 AND source_id=$2 FOR UPDATE`, [proposalId, row.source_id]);
      if (!currentProposal || currentProposal.status !== 'evidence_accepting'
        || digest(parseEntitylessProposalEvidence(currentProposal.evidence)) !== row.intent!.evidence_hash) {
        throw new OperationError('revision_conflict', 'The review proposal changed before publication.');
      }
      await assertEntitylessProposalCurrent(tx, currentProposal, { lock: true });
    },
    apply: async tx => {
      const outcome = await prepared.apply(tx);
      // Page projection can reconcile facts on the target page. The review
      // source rows are immutable even if the explicit target overlaps their
      // provenance, so any such change aborts the whole publication.
      const after = await readEvidenceFacts(tx, evidence.source_id, evidence.facts.map(fact => fact.id), true);
      if (stableJson(after) !== stableJson([...evidence.facts].sort((a, b) => a.id - b.id))) {
        throw new OperationError('revision_conflict', 'Source facts changed during publication; the take was not committed.');
      }
      const rowNum = Number(outcome.row_num);
      if (!Number.isSafeInteger(rowNum) || rowNum < 1) throw new OperationError('storage_error', 'The accepted take row was not recorded.');
      const updated = await tx.executeRaw(`UPDATE take_proposals SET status='evidence_accepted',promoted_row_num=$2
        WHERE id=$1 AND source_id=$3 AND status='evidence_accepting' RETURNING id`, [proposalId, rowNum, row.source_id]);
      if (updated.length !== 1) throw new OperationError('revision_conflict', 'The review proposal acceptance state changed during publication.');
      return { ...outcome, proposal_id: proposalId, row_num: rowNum, evidence_accepted: true };
    },
  };
}

async function readEvidenceFacts(engine: BrainEngine, sourceId: string, ids: number[], lock: boolean): Promise<CurrentFactEvidence[]> {
  if (ids.length === 0 || ids.length > 100) throw invalidEvidence();
  const rows = await engine.executeRaw<RawFactSnapshot>(`SELECT f.id,f.source_id,f.entity_slug,f.source_markdown_slug,f.row_num,
      f.fact,f.kind,f.visibility,f.notability,f.context,f.valid_from,f.valid_until,f.expired_at,f.superseded_by,
      f.consolidated_at,f.consolidated_into,f.source,f.source_session,f.confidence,f.claim_metric,f.claim_value,
      f.claim_unit,f.claim_period,f.event_type,f.dimension,f.value,f.dim_status,f.embedding_model,f.embedded_text_hash,
      EXISTS (SELECT 1 FROM fact_withdrawals w WHERE w.source_id=f.source_id AND w.visibility=f.visibility
        AND w.fact_hash IN (gbrain_fact_fingerprint(f.fact),gbrain_fact_fingerprint_v1(f.fact)) AND w.subject='*') AS withdrawn
    FROM facts f WHERE f.source_id=$1 AND f.id=ANY($2::integer[]) ORDER BY f.id${lock ? ' FOR UPDATE' : ''}`,
  [sourceId, ids]);
  return rows.map(row => ({
    id: Number(row.id),
    source_id: row.source_id,
    entity_slug: row.entity_slug,
    source_markdown_slug: row.source_markdown_slug,
    row_num: row.row_num == null ? null : Number(row.row_num),
    fact: row.fact,
    kind: row.kind,
    visibility: row.visibility,
    notability: row.notability,
    context: row.context,
    valid_from: iso(row.valid_from)!,
    valid_until: iso(row.valid_until),
    expired_at: iso(row.expired_at),
    superseded_by: row.superseded_by == null ? null : Number(row.superseded_by),
    consolidated_at: iso(row.consolidated_at),
    consolidated_into: row.consolidated_into == null ? null : Number(row.consolidated_into),
    source: row.source,
    source_session: row.source_session,
    confidence: Number(row.confidence),
    claim_metric: row.claim_metric,
    claim_value: row.claim_value == null ? null : Number(row.claim_value),
    claim_unit: row.claim_unit,
    claim_period: row.claim_period,
    event_type: row.event_type,
    dimension: row.dimension,
    value: row.value,
    dim_status: row.dim_status,
    embedding_model: row.embedding_model,
    embedded_text_hash: row.embedded_text_hash,
    ...(row.withdrawn ? { withdrawn: true } : {}),
  })) as unknown as CurrentFactEvidence[];
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function invalidEvidence(): OperationError {
  return new OperationError('invalid_params', 'The entityless review evidence is malformed; it cannot be published.');
}
