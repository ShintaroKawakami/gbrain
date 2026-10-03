/** Deterministic, review-only proposals for source-scoped facts with no entity. */

import { createHash } from 'node:crypto';
import type { BrainEngine, FactRow } from '../engine.ts';
import { cosineSimilarity } from '../facts/classify.ts';
import { sha256, stableJson } from '../persistence/digest.ts';

export const ENTITYLESS_PROPOSAL_PROMPT_VERSION = 'entityless-fact-review-v1';
export const ENTITYLESS_PROPOSAL_MODEL_ID = 'deterministic:cosine-review-v1';
export const ENTITYLESS_PROPOSAL_MAX_FACTS = 100;

const MIN_FACTS = 3;
const MIN_OLDEST_AGE_MS = 24 * 60 * 60 * 1000;
const CLUSTER_THRESHOLD = 0.85;

interface RawEntitylessFact extends Omit<FactRow, 'embedding' | 'valid_from' | 'valid_until' | 'expired_at' | 'consolidated_at' | 'embedded_at' | 'created_at'> {
  embedding: string | number[] | Float32Array | null;
  valid_from: Date | string;
  valid_until: Date | string | null;
  expired_at: Date | string | null;
  consolidated_at: Date | string | null;
  embedded_at: Date | string | null;
  created_at: Date | string;
  row_num: number | string | null;
  source_markdown_slug: string | null;
  claim_metric: string | null;
  claim_value: number | string | null;
  claim_unit: string | null;
  claim_period: string | null;
  event_type: string | null;
  dimension: string | null;
  value: string | null;
  dim_status: string | null;
}

interface RawEntitylessSnapshot extends Omit<FactEvidenceSnapshot,
  'id' | 'row_num' | 'superseded_by' | 'consolidated_into' | 'claim_value' | 'confidence'
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
}

export interface FactEvidenceSnapshot {
  id: number;
  source_id: string;
  entity_slug: null;
  source_markdown_slug: string | null;
  row_num: number | null;
  fact: string;
  kind: string;
  visibility: 'world' | 'private';
  notability: string;
  context: string | null;
  valid_from: string;
  valid_until: string | null;
  expired_at: string | null;
  superseded_by: number | null;
  consolidated_at: string | null;
  consolidated_into: number | null;
  source: string;
  source_session: string | null;
  confidence: number;
  claim_metric: string | null;
  claim_value: number | null;
  claim_unit: string | null;
  claim_period: string | null;
  event_type: string | null;
  dimension: string | null;
  value: string | null;
  dim_status: string | null;
  embedding_model: string | null;
  embedded_text_hash: string | null;
}

export interface EntitylessProposalEvidenceV1 {
  version: 1;
  reason: 'subject_unknown';
  contradictions: 'unverified';
  source_id: string;
  source_incarnation: string;
  target: { slug: string; page_id: number | null; revision: string | null };
  visibility: 'world' | 'private';
  candidate: { claim_text: string; kind: 'fact'; holder: 'self'; weight: number; since: string };
  facts: FactEvidenceSnapshot[];
}

export interface EntitylessProposalResult {
  scanned: number;
  inserted: number;
  clusters: number;
}

/**
 * Create local review rows only. Similarity forms candidate groups; it never
 * grants these facts a shared subject or authority to rewrite the fact rows.
 */
export async function produceEntitylessFactProposals(
  engine: BrainEngine,
  options: { sourceId: string; targetSlug: string; now?: Date },
): Promise<EntitylessProposalResult> {
  const sourceId = options.sourceId.trim();
  const targetSlug = options.targetSlug.trim();
  if (!sourceId) throw new Error('Entityless fact review requires an explicit sourceId.');
  if (!targetSlug) throw new Error('Entityless fact review requires a nonblank explicit target slug.');

  const [source] = await engine.executeRaw<{ incarnation: string; archived: boolean }>(
    'SELECT incarnation,archived FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived) throw new Error('Entityless fact review requires an active explicit source.');

  const targetSnapshot = await engine.readPageSnapshot(targetSlug, { sourceId, excludePrivate: true });
  const target = targetSnapshot && targetSnapshot.sourceIncarnation === source.incarnation ? {
    slug: targetSlug,
    page_id: Number(targetSnapshot.page.id),
    revision: targetSnapshot.revision,
  } : { slug: targetSlug, page_id: null, revision: null };
  const coveredFactIds = await unchangedProposalFactIds(engine, sourceId, source.incarnation, target);

  const rows = await engine.executeRaw<RawEntitylessFact>(`SELECT id,source_id,entity_slug,fact,kind,visibility,notability,context,
      valid_from,valid_until,expired_at,superseded_by,consolidated_at,consolidated_into,source,source_session,confidence,
      embedding::text AS embedding,embedding_model,embedded_text_hash,embedded_at,created_at,source_markdown_slug,row_num,
      claim_metric,claim_value,claim_unit,claim_period,event_type,dimension,value,dim_status
    FROM facts
    WHERE source_id=$1 AND entity_slug IS NULL AND expired_at IS NULL AND consolidated_at IS NULL
      AND superseded_by IS NULL AND valid_from<=now()
      AND (valid_until IS NULL OR valid_until>now()) AND visibility IN ('world','private')
      AND id <> ALL($2::integer[])
    ORDER BY valid_from ASC,id ASC LIMIT $3`, [sourceId, coveredFactIds, ENTITYLESS_PROPOSAL_MAX_FACTS]);
  const facts = rows.map(normalizeRawFact);
  const byVisibility: Record<'world' | 'private', FactRow[]> = { world: [], private: [] };
  for (const fact of facts) byVisibility[fact.visibility].push(fact);

  const now = (options.now ?? new Date()).getTime();
  let inserted = 0;
  let clusters = 0;

  for (const visibility of ['world', 'private'] as const) {
    const group = byVisibility[visibility];
    if (group.length < MIN_FACTS) continue;
    const oldest = group.reduce((min, fact) => Math.min(min, fact.valid_from.getTime()), Number.POSITIVE_INFINITY);
    if (now - oldest < MIN_OLDEST_AGE_MS) continue;

    for (const cluster of clusterEntitylessFacts(group)) {
      if (cluster.length < 2) continue;
      clusters += 1;
      const best = [...cluster].sort((a, b) => b.confidence - a.confidence || a.id - b.id)[0]!;
      const weight = clamp01(cluster.reduce((sum, fact) => sum + fact.confidence, 0) / cluster.length);
      const since = new Date(Math.min(...cluster.map(fact => fact.valid_from.getTime()))).toISOString().slice(0, 10);
      const evidence: EntitylessProposalEvidenceV1 = {
        version: 1,
        reason: 'subject_unknown',
        contradictions: 'unverified',
        source_id: sourceId,
        source_incarnation: source.incarnation,
        target,
        visibility,
        candidate: { claim_text: best.fact, kind: 'fact', holder: 'self', weight, since },
        facts: cluster.map(snapshotFact).sort((a, b) => a.id - b.id),
      };
      const contentHash = sha256(stableJson(evidence));
      const runId = `entityless-${contentHash.slice(0, 40)}`;
      const result = await engine.executeRaw<{ id: number }>(`INSERT INTO take_proposals
          (source_id,page_slug,content_hash,prompt_version,proposal_run_id,status,claim_text,kind,holder,weight,domain,
           model_id,evidence)
        VALUES ($1,$2,$3,$4,$5,'evidence_pending',$6,'fact','self',$7,'entityless-review',$8,$9::text::jsonb)
        ON CONFLICT (source_id,page_slug,content_hash,prompt_version,md5(claim_text)) DO NOTHING
        RETURNING id`, [sourceId, targetSlug, contentHash, ENTITYLESS_PROPOSAL_PROMPT_VERSION, runId,
        evidence.candidate.claim_text, evidence.candidate.weight, ENTITYLESS_PROPOSAL_MODEL_ID, JSON.stringify(evidence)]);
      if (result.length) inserted += 1;
    }
  }
  return { scanned: facts.length, inserted, clusters };
}

/**
 * Proposal evidence is the progress record for this bounded producer. Skip a
 * prior group's fact IDs only while the entire evidence snapshot and target
 * revision still match. A changed member therefore brings its original group
 * back into the next 100-fact review window; a new target revision does too.
 */
async function unchangedProposalFactIds(
  engine: BrainEngine,
  sourceId: string,
  sourceIncarnation: string,
  target: EntitylessProposalEvidenceV1['target'],
): Promise<number[]> {
  const priorRows = await engine.executeRaw<{ evidence: unknown }>(`SELECT evidence FROM take_proposals
    WHERE source_id=$1 AND page_slug=$2 AND prompt_version=$3 AND domain='entityless-review'
      AND evidence IS NOT NULL
      AND status IN ('evidence_pending','evidence_accepting','evidence_accepted','evidence_rejected')
    ORDER BY id`, [sourceId, target.slug, ENTITYLESS_PROPOSAL_PROMPT_VERSION]);
  const evidenceRows = priorRows.map(row => storedEvidence(row.evidence)).filter((evidence): evidence is EntitylessProposalEvidenceV1 =>
    evidence !== null && evidence.source_id === sourceId && evidence.source_incarnation === sourceIncarnation
      && evidence.target.slug === target.slug && evidence.target.page_id === target.page_id
      && evidence.target.revision === target.revision);
  if (evidenceRows.length === 0) return [];

  const ids = Array.from(new Set(evidenceRows.flatMap(evidence => evidence.facts.map(fact => fact.id)))).sort((a, b) => a - b);
  const current = new Map<number, FactEvidenceSnapshot>();
  for (let start = 0; start < ids.length; start += ENTITYLESS_PROPOSAL_MAX_FACTS) {
    const batch = ids.slice(start, start + ENTITYLESS_PROPOSAL_MAX_FACTS);
    const rows = await engine.executeRaw<RawEntitylessSnapshot>(`SELECT id,source_id,entity_slug,source_markdown_slug,row_num,
        fact,kind,visibility,notability,context,valid_from,valid_until,expired_at,superseded_by,consolidated_at,
        consolidated_into,source,source_session,confidence,claim_metric,claim_value,claim_unit,claim_period,event_type,
        dimension,value,dim_status,embedding_model,embedded_text_hash
      FROM facts WHERE source_id=$1 AND id=ANY($2::integer[]) ORDER BY id`, [sourceId, batch]);
    for (const row of rows) current.set(Number(row.id), normalizeEvidenceSnapshot(row));
  }

  const covered = new Set<number>();
  for (const evidence of evidenceRows) {
    const expected = [...evidence.facts].sort((a, b) => a.id - b.id);
    const actual = expected.map(fact => current.get(fact.id));
    if (actual.some(fact => fact === undefined)) continue;
    if (stableJson(actual) === stableJson(expected)) for (const fact of expected) covered.add(fact.id);
  }
  return [...covered].sort((a, b) => a - b);
}

function storedEvidence(value: unknown): EntitylessProposalEvidenceV1 | null {
  let raw = value;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const evidence = raw as Partial<EntitylessProposalEvidenceV1>;
  if (evidence.version !== 1 || evidence.reason !== 'subject_unknown' || evidence.contradictions !== 'unverified'
    || typeof evidence.source_id !== 'string' || typeof evidence.source_incarnation !== 'string'
    || !evidence.target || typeof evidence.target.slug !== 'string'
    || !Array.isArray(evidence.facts) || evidence.facts.length < 2 || evidence.facts.length > ENTITYLESS_PROPOSAL_MAX_FACTS
    || evidence.facts.some(fact => !fact || !Number.isSafeInteger(fact.id) || fact.id < 1)) return null;
  return evidence as EntitylessProposalEvidenceV1;
}

function normalizeEvidenceSnapshot(row: RawEntitylessSnapshot): FactEvidenceSnapshot {
  return {
    id: Number(row.id),
    source_id: row.source_id,
    entity_slug: row.entity_slug as null,
    source_markdown_slug: row.source_markdown_slug,
    row_num: row.row_num == null ? null : Number(row.row_num),
    fact: row.fact,
    kind: row.kind,
    visibility: row.visibility,
    notability: row.notability,
    context: row.context,
    valid_from: date(row.valid_from)!.toISOString(),
    valid_until: date(row.valid_until)?.toISOString() ?? null,
    expired_at: date(row.expired_at)?.toISOString() ?? null,
    superseded_by: row.superseded_by == null ? null : Number(row.superseded_by),
    consolidated_at: date(row.consolidated_at)?.toISOString() ?? null,
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
  };
}

function normalizeRawFact(row: RawEntitylessFact): FactRow & { source_markdown_slug: string | null; row_num: number | null;
  claim_metric: string | null; claim_value: number | null; claim_unit: string | null; claim_period: string | null;
  event_type: string | null; dimension: string | null; value: string | null; dim_status: string | null } {
  return {
    ...row,
    id: Number(row.id),
    row_num: row.row_num == null ? null : Number(row.row_num),
    claim_value: row.claim_value == null ? null : Number(row.claim_value),
    valid_from: date(row.valid_from)!,
    valid_until: date(row.valid_until),
    expired_at: date(row.expired_at),
    consolidated_at: date(row.consolidated_at),
    embedded_at: date(row.embedded_at),
    created_at: date(row.created_at)!,
    superseded_by: row.superseded_by == null ? null : Number(row.superseded_by),
    consolidated_into: row.consolidated_into == null ? null : Number(row.consolidated_into),
    confidence: Number(row.confidence),
    embedding: parseEmbedding(row.embedding),
    embedding_model: row.embedding_model ?? null,
    embedded_text_hash: row.embedded_text_hash ?? null,
  };
}

function snapshotFact(fact: FactRow & { source_markdown_slug?: string | null; row_num?: number | null;
  claim_metric?: string | null; claim_value?: number | null; claim_unit?: string | null; claim_period?: string | null;
  event_type?: string | null; dimension?: string | null; value?: string | null; dim_status?: string | null }): FactEvidenceSnapshot {
  return {
    id: fact.id,
    source_id: fact.source_id,
    entity_slug: null,
    source_markdown_slug: fact.source_markdown_slug ?? null,
    row_num: fact.row_num ?? null,
    fact: fact.fact,
    kind: fact.kind,
    visibility: fact.visibility,
    notability: fact.notability,
    context: fact.context,
    valid_from: fact.valid_from.toISOString(),
    valid_until: fact.valid_until?.toISOString() ?? null,
    expired_at: fact.expired_at?.toISOString() ?? null,
    superseded_by: fact.superseded_by,
    consolidated_at: fact.consolidated_at?.toISOString() ?? null,
    consolidated_into: fact.consolidated_into,
    source: fact.source,
    source_session: fact.source_session,
    confidence: fact.confidence,
    claim_metric: fact.claim_metric ?? null,
    claim_value: fact.claim_value ?? null,
    claim_unit: fact.claim_unit ?? null,
    claim_period: fact.claim_period ?? null,
    event_type: fact.event_type ?? null,
    dimension: fact.dimension ?? null,
    value: fact.value ?? null,
    dim_status: fact.dim_status ?? null,
    embedding_model: fact.embedding_model ?? null,
    embedded_text_hash: fact.embedded_text_hash ?? null,
  };
}

function clusterEntitylessFacts(facts: FactRow[], threshold = CLUSTER_THRESHOLD): FactRow[][] {
  const sorted = [...facts].sort((a, b) => b.valid_from.getTime() - a.valid_from.getTime() || b.id - a.id);
  const clusters: FactRow[][] = [];
  for (const fact of sorted) {
    if (!fact.embedding || !fact.embedding_model || fact.embedded_text_hash !== createHash('md5').update(fact.fact).digest('hex')) {
      clusters.push([fact]);
      continue;
    }
    let placed = false;
    for (const cluster of clusters) {
      const head = cluster[0]!;
      if (!head.embedding || fact.embedding_model !== head.embedding_model
        || head.embedded_text_hash !== createHash('md5').update(head.fact).digest('hex')
        || fact.embedding.length !== head.embedding.length) continue;
      if (cosineSimilarity(fact.embedding, head.embedding) >= threshold) {
        cluster.push(fact);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([fact]);
  }
  return clusters;
}

function parseEmbedding(value: RawEntitylessFact['embedding']): Float32Array | null {
  if (value instanceof Float32Array) return value;
  if (Array.isArray(value)) return new Float32Array(value.map(Number));
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const parts = (trimmed.startsWith('[') ? trimmed.slice(1, -1) : trimmed).split(',').map(part => Number(part.trim()));
  return parts.length && parts.every(Number.isFinite) ? new Float32Array(parts) : null;
}

function date(value: Date | string | null): Date | null {
  if (value == null) return null;
  return value instanceof Date ? value : new Date(value);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}
