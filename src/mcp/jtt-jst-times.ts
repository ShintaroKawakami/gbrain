/**
 * JTT fork: Japan-time siblings for the timestamps an MCP tool result carries.
 *
 * Why: every reader of this brain (Grok bots, ChatGPT, Hermes) talks to people in Japan. A result's
 * `updated_at: "2026-11-24T11:03:48Z"` was relayed as "11:03" when it was 20:03 in Tokyo. Telling each
 * reader to convert was not enough, so the result itself carries the Japan time next to the UTC value:
 * `"updated_at": "2026-11-24T11:03:48.494Z", "updated_at_jst": "2026-11-24 20:03 JST"`.
 *
 * Shape of the change (kept small so the Mon/Wed/Fri upstream merges do not collide with it):
 * - this module is fork-only; the HTTP transport calls it on one line just before the result is recorded;
 * - it is off unless GBRAIN_JST_FIELDS=1 (set by AGENT-HUB gbrain-serve-launch.sh), so upstream tests and
 *   every other caller keep byte-identical output;
 * - the UTC fields are never changed or removed: a `<key>_jst` field is inserted right after each one, by
 *   text insertion, so every other byte of the JSON (number precision, key order, spacing) stays as it was;
 * - only a text block that is a JSON object or array is touched; prose blocks pass through unchanged;
 * - a date-only field (`date`, `*_date`, `as_of`, `since`, `until`) stored as UTC midnight is left alone,
 *   since turning a calendar date into "09:00 JST" would mislead;
 * - any failure returns the result unchanged.
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

const KEY_SRC = '[A-Za-z0-9_]*_at|[A-Za-z0-9_]*_at_iso|[A-Za-z0-9_]*_time|[A-Za-z0-9_]*[Tt]imestamp|[a-z][A-Za-z0-9]*At'
  + '|date|[A-Za-z0-9_]*_date|as_of|[A-Za-z0-9_]*_as_of|created|updated|since|until';
const ISO_SRC = '\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,9})?)?(?:Z|[+-]\\d{2}:?\\d{2})';
const KEY_RE = new RegExp(`^(?:${KEY_SRC})$`);
const ISO_RE = new RegExp(`^${ISO_SRC}$`);
const DATE_ONLY_KEY_RE = /^(?:date|[A-Za-z0-9_]*_date|as_of|[A-Za-z0-9_]*_as_of|since|until)$/;
const UTC_MIDNIGHT_RE = /T00:00(?::00(?:\.0+)?)?(?:Z|[+-]00:?00)$/;

export const JST_FIELDS_ENV = 'GBRAIN_JST_FIELDS';

/** "2026-11-24T11:03:48.494Z" -> "2026-11-24 20:03 JST"; null when the value is not an ISO instant. */
export function toJstLabel(iso: string): string | null {
  if (!ISO_RE.test(iso)) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms + JST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} JST`;
}

/** The sibling key for a time key: `updated_at` -> `updated_at_jst`, `updated_at_iso` -> `updated_at_jst`. */
export function jstKeyFor(key: string): string {
  return `${key.endsWith('_iso') ? key.slice(0, -4) : key}_jst`;
}

function skipValue(key: string, iso: string): boolean {
  return DATE_ONLY_KEY_RE.test(key) && UTC_MIDNIGHT_RE.test(iso);
}

function hasKey(text: string, key: string): boolean {
  return new RegExp(`(?<![\\\\\\w])"${key}"\\s*:`).test(text);
}

/** Insert `<key>_jst` after every top-level-or-nested `"<time key>": "<ISO instant>"` pair of one JSON text. */
export function addJstToJsonText(text: string): string {
  const head = text.trimStart()[0];
  if (head !== '{' && head !== '[') return text;
  const pair = new RegExp(`(?<![\\\\\\w])"(${KEY_SRC})"(\\s*):(\\s*)"(${ISO_SRC})"`, 'g');
  const verdict = new Map<string, boolean>();
  const allowed = (key: string): boolean => {
    let ok = verdict.get(key);
    if (ok === undefined) {
      const jstKey = jstKeyFor(key);
      // Already present (the server or an earlier pass added it), or an `_iso` twin whose plain key gets the field.
      ok = !hasKey(text, jstKey) && !(key.endsWith('_iso') && hasKey(text, key.slice(0, -4)));
      verdict.set(key, ok);
    }
    return ok;
  };
  const out = text.replace(pair, (whole, key: string, ws1: string, ws2: string, iso: string) => {
    if (!allowed(key) || skipValue(key, iso)) return whole;
    const label = toJstLabel(iso);
    return label ? `${whole},"${jstKeyFor(key)}"${ws1}:${ws2}"${label}"` : whole;
  });
  if (out === text) return text;
  try { JSON.parse(out); } catch { return text; }
  return out;
}

/** The same rule over a parsed object (structuredContent): returns a copy with `<key>_jst` siblings. */
export function addJstToValue(value: unknown, depth = 0): unknown {
  if (depth > 64 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(v => addJstToValue(v, depth + 1));
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    out[k] = addJstToValue(v, depth + 1);
    if (typeof v !== 'string' || !KEY_RE.test(k) || skipValue(k, v)) continue;
    const jstKey = jstKeyFor(k);
    if (jstKey in src || (k.endsWith('_iso') && k.slice(0, -4) in src)) continue;
    const label = toJstLabel(v);
    if (label) out[jstKey] = label;
  }
  return out;
}

interface ResultLike {
  content?: Array<{ type?: string; text?: unknown } & Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
}

/** Add Japan-time siblings to one tool result when GBRAIN_JST_FIELDS=1; otherwise (or on any error) return it as is. */
export function withJstTimeFields<T>(result: T, env: Record<string, string | undefined> = process.env): T {
  if (env[JST_FIELDS_ENV] !== '1' || !result || typeof result !== 'object') return result;
  try {
    const r = result as T & ResultLike;
    const content = Array.isArray(r.content)
      ? r.content.map(b => (b && b.type === 'text' && typeof b.text === 'string' ? { ...b, text: addJstToJsonText(b.text) } : b))
      : r.content;
    const structured = r.structuredContent && typeof r.structuredContent === 'object'
      ? addJstToValue(r.structuredContent) as Record<string, unknown>
      : r.structuredContent;
    return { ...r, ...(content !== undefined ? { content } : {}), ...(structured !== undefined ? { structuredContent: structured } : {}) };
  } catch {
    return result;
  }
}
