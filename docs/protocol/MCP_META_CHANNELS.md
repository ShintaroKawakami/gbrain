# MCP `_meta` channels

Normative conventions for `ToolResult._meta` on gbrain's MCP surfaces
(WP2 amendment 9 / decision D3). `_meta` is the structured, out-of-band
channel for tool-call responses; the response BODY contract never changes
shape for it.

## Rules

1. **One producer per top-level key.** A producer owns exactly one
   namespaced key and never writes another producer's key. The dispatch
   layer (`src/mcp/dispatch.ts`) merges per top-level key — never wholesale
   `_meta` assignment.
2. **Additive-forever within a key.** Fields inside a key may be added,
   never renamed or removed — the RESPONSE_SCHEMAS discipline applied to
   `_meta`. Consumers must tolerate unknown fields.
3. **Producer isolation.** Every producer attaches inside its own
   try/catch. A failing producer degrades to its key being absent; it never
   drops another producer's key and never errors the tool call.
4. **Merge precedence.** Handler-emitted keys (via
   `OperationContext.emitResponseMeta`) attach first; transport hooks
   (`metaHook`) attach after and may add keys but shadow nothing that
   matters — key ownership (rule 1) makes ordering a non-event.
5. **Model visibility caveat.** Mainstream harnesses do NOT feed `_meta` to
   the model. Anything the model must SEE rides a content block (see the D8
   second text block on empty retrievals); `_meta` serves structured
   programmatic consumers (thin clients, harness plumbing, tests).

## Registered keys

| Key | Producer | Contents |
|-----|----------|----------|
| `brain_hot_memory` | serve-http `metaHook` (`getBrainHotMemoryMeta`) | Hot-memory facts relevant to the call (v0.31 eD3) |
| `retrieval` | `search`/`query` op handlers | `returned_count`, `retrieved_count`, `vector_enabled`, `expansion_applied`, `cache`, `token_budget`, `degraded[]` (closed stage vocabulary, D6), `incomplete` (#2632 — true when a recall-affecting stage is stamped), `hint` (non-contractual prose, E1) |
| `warnings` | dispatch strict-params warn mode (WP3) | `[{code: 'unknown_param', param, suggestion?}]` |

Inbound `_meta` (e.g. `_meta.session_id` inside tool ARGUMENTS, CX2-11) is a
separate, client-to-server plane. The eval-report `_meta.metric_glossary`
lives in JSON BODIES of eval commands — a third, unrelated plane. Ambient
recall (#4028) rides content/hooks, not `_meta`.

Adding a key: register it in the table above, one producer, additive-forever.

## Degraded-empty retrieval signaling (#2632)

`_meta` never changes the response BODY shape — but #2632 defines when the
dispatch layer (`src/mcp/dispatch.ts`) changes the body itself. When a
retrieval op returns `[]` AND the `retrieval` meta's `degraded[]` carries a
recall-affecting stage (closed set: `embed_unavailable`, `embed_timeout`,
`expansion_failed`, `expansion_partial`, `vector_arm_failed`,
`budget_dropped_all` — see `RECALL_AFFECTING_STAGES`), the
empty result is not evidence that no matches exist, so the dispatcher flips
the response:

- content[0] becomes the `{"error":"retrieval_degraded", ...}` envelope
  (not `[]`) and `isError: true` — legacy first-array-only consumers cannot
  read a degraded miss as a normal empty success, and the thin-client
  `callRemoteTool` path surfaces it as a visible tool error;
- the D8 diagnosis block still follows as the second content block;
- `_meta.retrieval` still carries the structured facts, plus `incomplete:
  true`.

Partial hits (degraded but non-empty) keep the successful array body and are
marked `incomplete: true` on `_meta.retrieval`. Healthy zero hits — clean
miss, `keyword_zero` alone, pre-stamp meta, or ordering-only stages
(`rescore_skipped`, `budget_truncated`, `cache_prestamp`) — keep the existing
successful `[]` shape byte-for-byte. If a recall-affecting stage coexists
with `keyword_zero`, the envelope includes both codes: the keyword miss is
supporting evidence, not the reason for the flip.

[2026-09-15][fix] CaD: `keyword_zero` alone is a normal lexical clean miss;
an unavailable embed/vector arm, failed expansion, or dropped-all budget can
hide a match; and the local CLI must apply the same classification before it
renders `--json`. We rejected erroring every `keyword_zero`, because that
would turn healthy empty searches into failures. A future degradation stage
that can empty a result set MUST be added to `RECALL_AFFECTING_STAGES` in the
same change that adds it to the D6 vocabulary.
