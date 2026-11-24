import { describe, expect, test } from 'bun:test';
import { addJstToJsonText, addJstToValue, jstKeyFor, toJstLabel, withJstTimeFields } from '../src/mcp/jtt-jst-times.ts';

const ON = { GBRAIN_JST_FIELDS: '1' };

describe('JTT Japan-time fields on MCP results', () => {
  test('converts a UTC instant to a JST label', () => {
    expect(toJstLabel('2026-11-24T11:03:48.494Z')).toBe('2026-11-24 20:03 JST');
    expect(toJstLabel('2026-11-24T11:03:48.494027Z')).toBe('2026-11-24 20:03 JST');
    expect(toJstLabel('2026-12-31T15:30:00Z')).toBe('2027-01-01 00:30 JST');
    expect(toJstLabel('2026-11-24T20:03:00+09:00')).toBe('2026-11-24 20:03 JST');
    expect(toJstLabel('2026-11-24')).toBeNull();
    expect(toJstLabel('not a date')).toBeNull();
  });

  test('names the sibling key', () => {
    expect(jstKeyFor('updated_at')).toBe('updated_at_jst');
    expect(jstKeyFor('updated_at_iso')).toBe('updated_at_jst');
  });

  test('list_pages row: one updated_at_jst, UTC fields untouched', () => {
    const text = '[{"slug":"inbox/x","updated_at":"2026-11-24T11:03:48.494Z","updated_at_iso":"2026-11-24T11:03:48.494027Z"}]';
    const out = addJstToJsonText(text);
    const rows = JSON.parse(out);
    expect(rows[0].updated_at).toBe('2026-11-24T11:03:48.494Z');
    expect(rows[0].updated_at_iso).toBe('2026-11-24T11:03:48.494027Z');
    expect(rows[0].updated_at_jst).toBe('2026-11-24 20:03 JST');
    expect(out.match(/updated_at_jst/g)?.length).toBe(1);
  });

  test('keeps every other byte: pretty JSON, big integers, nested rows', () => {
    const text = '{\n  "id": 12345678901234567890,\n  "page": {\n    "created_at": "2026-01-01T00:00:00Z"\n  }\n}';
    const out = addJstToJsonText(text);
    expect(out).toContain('12345678901234567890');
    expect(out).toContain('"created_at": "2026-01-01T00:00:00Z","created_at_jst": "2026-01-01 09:00 JST"');
    expect(JSON.parse(out).page.created_at_jst).toBe('2026-01-01 09:00 JST');
  });

  test('leaves date-only midnights, escaped JSON inside strings, prose and existing _jst fields alone', () => {
    const dateOnly = '{"date":"2026-11-24T00:00:00.000Z","effective_date":"2026-11-24T00:00:00Z","effective_at":"2026-11-24T00:00:00Z"}';
    const o = JSON.parse(addJstToJsonText(dateOnly));
    expect(o.date_jst).toBeUndefined();
    expect(o.effective_date_jst).toBeUndefined();
    expect(o.effective_at_jst).toBe('2026-11-24 09:00 JST');
    const escaped = JSON.stringify({ body: '{"updated_at":"2026-11-24T11:03:48Z"}' });
    expect(addJstToJsonText(escaped)).toBe(escaped);
    expect(addJstToJsonText('updated_at: 2026-11-24T11:03:48Z')).toBe('updated_at: 2026-11-24T11:03:48Z');
    const already = '{"updated_at":"2026-11-24T11:03:48Z","updated_at_jst":"x"}';
    expect(addJstToJsonText(already)).toBe(already);
  });

  test('structuredContent objects get the same siblings', () => {
    expect(addJstToValue({ facts: [{ created_at: '2026-11-24T11:03:48Z', text: 'a' }] }))
      .toEqual({ facts: [{ created_at: '2026-11-24T11:03:48Z', created_at_jst: '2026-11-24 20:03 JST', text: 'a' }] });
  });

  test('off unless GBRAIN_JST_FIELDS=1, and never throws', () => {
    const r = { content: [{ type: 'text', text: '{"updated_at":"2026-11-24T11:03:48Z"}' }] };
    expect(withJstTimeFields(r, {})).toBe(r);
    const on = withJstTimeFields(r, ON);
    expect(JSON.parse(on.content[0].text).updated_at_jst).toBe('2026-11-24 20:03 JST');
    expect(r.content[0].text).toBe('{"updated_at":"2026-11-24T11:03:48Z"}');
    const err = { content: [{ type: 'text', text: '{"error":"x"}' }], isError: true };
    expect(withJstTimeFields(err, ON)).toEqual(err);
    expect(withJstTimeFields(null, ON)).toBeNull();
  });
});
