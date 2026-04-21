/**
 * Unit tests for the hand-rolled markdown highlighter extensions introduced
 * by redesign-020. Covers each new token kind with a happy path and at least
 * one edge case, plus escape-safety checks and regression checks that
 * non-markdown sublangs still behave identically.
 *
 * Tests import `highlight` directly from the client source using the `.js`
 * extension convention required by ts-jest's ESM mode (see
 * `forjis-runtime/web/jest.config.mjs`).
 */

import { highlight } from '../../client/src/views/tasks/highlighter.js';

describe('markdown heading levels', () => {
  test('level-1 heading emits mdHeading1 span', () => {
    const html = highlight('# hello', 'markdown');
    expect(html).toContain('class="tok-mdHeading1"');
    expect(html).toContain('# hello');
  });

  test('level-6 heading emits mdHeading6 span', () => {
    const html = highlight('###### deep', 'markdown');
    expect(html).toContain('class="tok-mdHeading6"');
  });

  test('seven hashes is NOT treated as a heading', () => {
    const html = highlight('####### too many', 'markdown');
    expect(html).not.toContain('tok-mdHeading');
  });
});

describe('markdown fenced code blocks', () => {
  test('fence lines wrap in mdFence and body in mdCodeBlock when no sublang', () => {
    const src = '```\nplain text\n```';
    const html = highlight(src, 'markdown');
    expect(html).toContain('class="tok-mdFence"');
    expect(html).toContain('class="tok-mdCodeBlock"');
    expect(html).toContain('plain text');
  });

  test('fence with ts sublang recursively highlights body', () => {
    const src = '```ts\nconst x = 1\n```';
    const html = highlight(src, 'markdown');
    expect(html).toContain('class="tok-mdFence"');
    // Recursive ts tokeniser tags `const` as keyword and `1` as number.
    expect(html).toContain('class="tok-kw"');
    expect(html).toContain('>const<');
    expect(html).toContain('class="tok-num"');
  });

  test('fence with json sublang recursively highlights body', () => {
    const src = '```json\n{"a": 1}\n```';
    const html = highlight(src, 'markdown');
    expect(html).toContain('class="tok-key"');
    expect(html).toContain('class="tok-num"');
  });

  test('unclosed fence treats remaining content as code block (edge case)', () => {
    const src = '```\nno closing fence\nmore body';
    const html = highlight(src, 'markdown');
    // Opening fence still wrapped; no mdHeading / inline leaks from body.
    expect(html).toContain('class="tok-mdFence"');
    expect(html).toContain('no closing fence');
    expect(html).not.toContain('tok-mdHeading');
  });
});

describe('markdown inline code', () => {
  test('single-backtick run becomes mdInlineCode', () => {
    const html = highlight('use `foo` here', 'markdown');
    expect(html).toContain('class="tok-mdInlineCode"');
    expect(html).toContain('`foo`');
  });

  test('unclosed inline backtick renders as plain text (edge case)', () => {
    const html = highlight('use `foo here', 'markdown');
    expect(html).not.toContain('tok-mdInlineCode');
  });
});

describe('markdown emphasis', () => {
  test('**bold** emits mdStrong with delimiters preserved', () => {
    const html = highlight('this is **loud**', 'markdown');
    expect(html).toContain('class="tok-mdStrong"');
    expect(html).toContain('**loud**');
  });

  test('*italic* emits mdEm', () => {
    const html = highlight('this is *soft*', 'markdown');
    expect(html).toContain('class="tok-mdEm"');
    expect(html).toContain('*soft*');
  });

  test('_italic_ underscore variant also emits mdEm', () => {
    const html = highlight('this is _soft_', 'markdown');
    expect(html).toContain('class="tok-mdEm"');
  });

  test('mismatched bold delimiters do not wrap (edge case)', () => {
    const html = highlight('this is **loud without end', 'markdown');
    expect(html).not.toContain('tok-mdStrong');
  });

  test('nested emphasis handled deterministically without XSS', () => {
    // Ambiguous markdown where bold and italic nest. The tokeniser is
    // single-pass with an explicit order (strong before em, with inline code
    // winning overall); the exact carve-up is not guaranteed to match any
    // reference parser but the output MUST be escape-safe and produce at
    // least one emphasis span.
    const html = highlight('x **bold and *inner*** y', 'markdown');
    expect(html).not.toContain('<script>');
    expect(html).toMatch(/class="tok-md(Strong|Em)"/);
  });
});

describe('markdown lists', () => {
  test('bullet list marker wrapped, body keeps inline passes', () => {
    const html = highlight('- hello `there`', 'markdown');
    expect(html).toContain('class="tok-mdListMarker"');
    expect(html).toContain('>-<');
    expect(html).toContain('class="tok-mdInlineCode"');
  });

  test('indented bullet preserves indentation', () => {
    const html = highlight('  - nested', 'markdown');
    expect(html).toMatch(/^  <span class="tok-mdListMarker">/);
  });

  test('numbered list marker wrapped', () => {
    const html = highlight('1. first item', 'markdown');
    expect(html).toContain('class="tok-mdListMarker"');
    expect(html).toContain('>1.<');
  });

  test('dash without trailing space is NOT a list (edge case)', () => {
    const html = highlight('-no-space', 'markdown');
    expect(html).not.toContain('tok-mdListMarker');
  });
});

describe('markdown blockquotes', () => {
  test('blockquote line wrapped as mdQuote', () => {
    const html = highlight('> quoted', 'markdown');
    expect(html).toContain('class="tok-mdQuote"');
    expect(html).toContain('&gt; quoted');
  });

  test('bare ">" counts as empty quote line', () => {
    const html = highlight('>', 'markdown');
    expect(html).toContain('class="tok-mdQuote"');
  });
});

describe('markdown links', () => {
  test('[label](url) renders an anchor with escaped href', () => {
    const html = highlight('see [docs](https://example.com)', 'markdown');
    expect(html).toContain('<a class="tok-mdLink"');
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('title="https://example.com"');
    expect(html).toContain('>docs</a>');
  });

  test('autolink <http://…> renders as anchor', () => {
    const html = highlight('see <https://example.com>', 'markdown');
    expect(html).toContain('<a class="tok-mdLink"');
    expect(html).toContain('href="https://example.com"');
  });

  test('link with quote in url is escaped in href (xss edge case)', () => {
    const html = highlight('[x](javascript:"alert(1)")', 'markdown');
    // The " must be escaped in the href attribute.
    expect(html).not.toMatch(/href="javascript:"alert/);
    expect(html).toContain('&quot;');
  });
});

describe('markdown horizontal rule', () => {
  test('--- line wrapped as mdHr', () => {
    const html = highlight('---', 'markdown');
    expect(html).toContain('class="tok-mdHr"');
  });

  test('*** also matches', () => {
    const html = highlight('***', 'markdown');
    expect(html).toContain('class="tok-mdHr"');
  });

  test('only two dashes is NOT an hr (edge case)', () => {
    const html = highlight('--', 'markdown');
    expect(html).not.toContain('tok-mdHr');
  });
});

describe('escape safety', () => {
  test('<script> tag in markdown renders as escaped text, never as a tag', () => {
    const html = highlight('<script>alert(1)</script>', 'markdown');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('<script> inside inline code is escaped', () => {
    const html = highlight('`<script>`', 'markdown');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('<script> inside fenced code body is escaped', () => {
    const html = highlight('```\n<script>alert(1)</script>\n```', 'markdown');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  test('ampersand in prose is escaped once', () => {
    const html = highlight('a & b', 'markdown');
    expect(html).toContain('a &amp; b');
    expect(html).not.toContain('&amp;amp;');
  });
});

describe('non-markdown langs unchanged', () => {
  test('json tokenisation still produces tok-key / tok-num', () => {
    const html = highlight('{"a": 1}', 'json');
    expect(html).toContain('class="tok-key"');
    expect(html).toContain('class="tok-num"');
  });

  test('ts tokenisation still produces tok-kw for const', () => {
    const html = highlight('const x = 1', 'ts');
    expect(html).toContain('class="tok-kw"');
  });

  test('bash tokenisation still produces tok-cmt for # comment', () => {
    const html = highlight('# comment\nls', 'bash');
    expect(html).toContain('class="tok-cmt"');
  });

  test('diff tokenisation still produces tok-add / tok-del', () => {
    const html = highlight('+added\n-removed', 'diff');
    expect(html).toContain('class="tok-add"');
    expect(html).toContain('class="tok-del"');
  });
});
