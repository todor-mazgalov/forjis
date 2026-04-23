/**
 * Unit tests for {@link extractJsonEnvelopes}.
 *
 * Covers the documented contract: pure JSON input, prose + JSON
 * mixes, multiple envelopes in one turn, nested braces, braces and
 * escaped quotes inside string literals, prose-only input, unbalanced
 * input, and balanced-but-unparseable candidates.
 */

import { extractJsonEnvelopes } from '../inspector-json-extract.js';

describe('extractJsonEnvelopes', () => {
  it('returns a single envelope for pure JSON input', () => {
    const result = extractJsonEnvelopes('{"type":"question","id":"q-1"}');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'question', id: 'q-1' });
  });

  it('extracts a JSON envelope preceded by prose', () => {
    const text =
      'The intent is clear. {"type":"finalize","taskDir":"tasks/x","taskMd":"# x","metadata":{}}';
    const result = extractJsonEnvelopes(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      type: 'finalize',
      taskDir: 'tasks/x',
      taskMd: '# x',
      metadata: {},
    });
  });

  it('extracts two envelopes in order when a turn carries both', () => {
    const text =
      '{"type":"question","id":"q-1"}\nand {"type":"noise","value":1}';
    const result = extractJsonEnvelopes(text);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ type: 'question', id: 'q-1' });
    expect(result[1]).toEqual({ type: 'noise', value: 1 });
  });

  it('treats nested braces as part of a single envelope', () => {
    const result = extractJsonEnvelopes('{"a":{"b":1}}');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ a: { b: 1 } });
  });

  it('ignores braces inside string literals', () => {
    const result = extractJsonEnvelopes('{"text":"{not a brace}"}');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ text: '{not a brace}' });
  });

  it('handles escaped quotes inside string literals', () => {
    const result = extractJsonEnvelopes('{"text":"he said \\"hi\\""}');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ text: 'he said "hi"' });
  });

  it('returns an empty array for prose-only input', () => {
    const result = extractJsonEnvelopes(
      'The intent is clear. No clarifying question is needed.',
    );
    expect(result).toEqual([]);
  });

  it('skips unclosed braces without throwing', () => {
    const result = extractJsonEnvelopes('{"a":');
    expect(result).toEqual([]);
  });

  it('skips balanced candidates that fail JSON.parse', () => {
    const result = extractJsonEnvelopes('{not json}');
    expect(result).toEqual([]);
  });

  it('preserves valid envelopes even when flanked by broken ones', () => {
    const text = '{broken} {"type":"question","id":"ok"} {also broken}';
    const result = extractJsonEnvelopes(text);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'question', id: 'ok' });
  });
});
