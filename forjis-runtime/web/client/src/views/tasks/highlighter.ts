/**
 * highlighter.ts — Zero-dependency syntax tokeniser for the Events tab.
 *
 * Hand-rolled regex tokeniser used by `ToolCallBlock` and any other component
 * that needs to render a code-ish string with semantic colour spans. The
 * supported languages and token kinds are pinned by design D-8 of
 * redesign-008. Output is HTML safe to assign to `innerHTML`: every input is
 * HTML-escaped before any tokenisation regex runs, so the only `<` characters
 * in the result are the ones we emit ourselves around `<span>` wrappers.
 *
 * The module is intentionally self-contained — no third-party imports, no
 * relative imports. Consumers pass a `classMap` to swap the default global
 * `tok-*` class names for CSS-module-scoped class names (see decision D-7).
 *
 * Markdown (redesign-020): the markdown tokeniser is a line-oriented single
 * pass. Each source line is classified as a structural line (fence, heading,
 * hr, blockquote, list) or a prose line; prose lines then run through a
 * single inline pass that recognises inline code, strong, em, links, and
 * autolinks. Design decisions documented inline:
 *   - Emphasis delimiters are KEPT visible inside the wrapping span. That
 *     preserves a readable, source-faithful rendering and avoids asymmetry
 *     when delimiters are mismatched (see `markdown inline emphasis`).
 *   - Fenced code blocks with a recognised sublang recurse via `highlight`
 *     so a ```ts block inside markdown still gets keyword colouring.
 *   - Pathological line length (> MAX_LINE) short-circuits to plain escaped
 *     text for that single line to keep the regex engine out of catastrophic
 *     backtracking territory.
 */

/** Supported syntaxes. 'js' is an alias for 'ts' (same token set). */
export type HighlightLang = 'json' | 'ts' | 'js' | 'bash' | 'markdown' | 'diff';

/** Token kinds the tokenizer can emit. Not every kind appears in every language. */
export type TokKind =
  | 'str'           // string literals
  | 'key'           // JSON keys, markdown link text
  | 'num'           // numeric literals
  | 'bool'          // true/false
  | 'null'          // null
  | 'cmt'           // comments
  | 'punc'          // braces, brackets, semicolons
  | 'kw'            // ts/bash keywords
  | 'fn'            // function names (best-effort)
  | 'add'           // diff +
  | 'del'           // diff -
  | 'ctx'           // diff context
  | 'mdHeading'     // legacy: any markdown heading (kept for backwards compat)
  | 'mdHeading1'    // markdown level-1 heading
  | 'mdHeading2'    // markdown level-2 heading
  | 'mdHeading3'    // markdown level-3 heading
  | 'mdHeading4'    // markdown level-4 heading
  | 'mdHeading5'    // markdown level-5 heading
  | 'mdHeading6'    // markdown level-6 heading
  | 'mdLink'        // markdown [text](url) label
  | 'mdFence'       // markdown ``` fences
  | 'mdCodeBlock'   // markdown fenced body without a recognised sublang
  | 'mdInlineCode'  // markdown `inline`
  | 'mdStrong'      // markdown **bold**
  | 'mdEm'          // markdown *italic* / _italic_
  | 'mdListMarker'  // markdown list bullet or "1."
  | 'mdQuote'       // markdown blockquote "> ..."
  | 'mdHr';         // markdown horizontal rule

/**
 * Default class names emitted when no `classMap` override is supplied. Each
 * key maps to the literal `tok-<kind>` class used by the prototype's global
 * stylesheet so the highlighter remains usable outside of CSS-module scope
 * (e.g. tests, ad-hoc embeddings).
 */
const DEFAULT_CLASS_MAP: Record<TokKind, string> = {
  str: 'tok-str',
  key: 'tok-key',
  num: 'tok-num',
  bool: 'tok-bool',
  null: 'tok-null',
  cmt: 'tok-cmt',
  punc: 'tok-punc',
  kw: 'tok-kw',
  fn: 'tok-fn',
  add: 'tok-add',
  del: 'tok-del',
  ctx: 'tok-ctx',
  mdHeading: 'tok-mdHeading',
  mdHeading1: 'tok-mdHeading1',
  mdHeading2: 'tok-mdHeading2',
  mdHeading3: 'tok-mdHeading3',
  mdHeading4: 'tok-mdHeading4',
  mdHeading5: 'tok-mdHeading5',
  mdHeading6: 'tok-mdHeading6',
  mdLink: 'tok-mdLink',
  mdFence: 'tok-mdFence',
  mdCodeBlock: 'tok-mdCodeBlock',
  mdInlineCode: 'tok-mdInlineCode',
  mdStrong: 'tok-mdStrong',
  mdEm: 'tok-mdEm',
  mdListMarker: 'tok-mdListMarker',
  mdQuote: 'tok-mdQuote',
  mdHr: 'tok-mdHr',
};

/** TS/JS keyword set per design D-8. */
const TS_KEYWORDS = [
  'if', 'else', 'for', 'while', 'return', 'const', 'let', 'var',
  'function', 'class', 'extends', 'new', 'throw', 'try', 'catch',
  'finally', 'import', 'export', 'from', 'as', 'async', 'await',
  'typeof', 'instanceof', 'in', 'of', 'true', 'false', 'null',
  'undefined',
];

/** Bash keyword set per design D-8. */
const BASH_KEYWORDS = [
  'if', 'then', 'else', 'fi', 'for', 'do', 'done', 'while', 'case',
  'esac', 'return', 'function', 'export', 'local',
];

/**
 * Per-line cap for the markdown tokeniser. Lines longer than this bypass the
 * inline regex pass and emit as plain escaped text so catastrophic backtracking
 * cannot stall the render.
 */
const MAX_LINE = 10_000;

/**
 * HTML-escape `&`, `<`, `>`, `"`, and `'` so the resulting string is safe to
 * assign to `innerHTML`. Replaces in `&` first to avoid double-encoding the
 * ampersand inside subsequent named entities.
 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Wrap `text` in a `<span class="...">` using the resolved class map. The
 * `text` MUST already be HTML-escaped — we never escape twice because the
 * caller passes us substrings extracted from the escape-then-tokenise output.
 */
function wrap(kind: TokKind, text: string, classMap: Record<TokKind, string>): string {
  return `<span class="${classMap[kind]}">${text}</span>`;
}

/**
 * Wrap `text` as an anchor element with an escaped `href` and optional
 * `title`. Used only for markdown links so the rendered span stays clickable
 * and surfaces the target URL on hover. All attribute values are HTML-escaped
 * before being interpolated into the markup.
 */
function wrapLink(
  escapedLabel: string,
  rawHref: string,
  classMap: Record<TokKind, string>,
): string {
  const href = escapeHtml(rawHref);
  return `<a class="${classMap.mdLink}" href="${href}" title="${href}">${escapedLabel}</a>`;
}

/**
 * Build the effective class map by shallow-merging the caller's overrides
 * over the defaults. A separate function so the merge rule is testable.
 */
function resolveClassMap(
  override: Partial<Record<TokKind, string>> | undefined,
): Record<TokKind, string> {
  if (!override) return DEFAULT_CLASS_MAP;
  return { ...DEFAULT_CLASS_MAP, ...override };
}

/**
 * Tokenise an HTML-escaped JSON snippet. Emits `key` for property keys
 * (string immediately followed by `:`), `str` for value strings, `num` for
 * numeric literals, `bool` for `true`/`false`, `null` for `null`, and `punc`
 * for `{`, `}`, `[`, `]`, `,`, `:`. Operates on the escaped form so the
 * `&quot;` entities — not raw `"` characters — are what the regex sees.
 */
function tokenizeJson(escaped: string, classMap: Record<TokKind, string>): string {
  // String literal in escaped form: &quot; ... &quot; with escapes inside.
  const stringPattern = '&quot;(?:\\\\.|(?!&quot;).)*&quot;';
  const re = new RegExp(
    `(${stringPattern})(\\s*:)?` +     // 1: string, 2: trailing colon (key marker)
    '|(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)' +  // 3: number
    '|\\b(true|false)\\b' +            // 4: bool
    '|\\b(null)\\b' +                  // 5: null
    '|([{}\\[\\],:])',                 // 6: punctuation
    'g',
  );
  return escaped.replace(re, (
    match,
    str: string | undefined,
    keyColon: string | undefined,
    num: string | undefined,
    boolLit: string | undefined,
    nullLit: string | undefined,
    punc: string | undefined,
  ): string => {
    if (str !== undefined) {
      const kind: TokKind = keyColon ? 'key' : 'str';
      const colonOut = keyColon ? wrap('punc', ':', classMap) : '';
      return wrap(kind, str, classMap) + colonOut;
    }
    if (num !== undefined) return wrap('num', num, classMap);
    if (boolLit !== undefined) return wrap('bool', boolLit, classMap);
    if (nullLit !== undefined) return wrap('null', nullLit, classMap);
    if (punc !== undefined) return wrap('punc', punc, classMap);
    return match;
  });
}

/**
 * Tokenise an HTML-escaped TS/JS snippet. Detects line + block comments,
 * single/double/backtick-quoted strings, numeric literals, the documented
 * keyword set with `\b` word boundaries, and function-call identifiers
 * (an identifier immediately followed by `(`).
 */
function tokenizeTs(escaped: string, classMap: Record<TokKind, string>): string {
  const kwPattern = TS_KEYWORDS.join('|');
  const re = new RegExp(
    '(/\\*[\\s\\S]*?\\*/|//[^\\n]*)' +                    // 1: comment
    '|(&#39;(?:\\\\.|(?!&#39;).)*&#39;' +                 // 2a: single-quoted
    '|&quot;(?:\\\\.|(?!&quot;).)*&quot;' +               // 2b: double-quoted
    '|`(?:\\\\.|(?!`).)*`)' +                             // 2c: backtick
    '|\\b(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b' +     // 3: number
    `|\\b(${kwPattern})\\b` +                             // 4: keyword
    '|\\b([A-Za-z_$][\\w$]*)(?=\\s*\\()' +                // 5: function call
    '|([{}\\[\\];])',                                     // 6: punctuation
    'g',
  );
  return escaped.replace(re, (
    match,
    cmt: string | undefined,
    str: string | undefined,
    num: string | undefined,
    kw: string | undefined,
    fn: string | undefined,
    punc: string | undefined,
  ): string => {
    if (cmt !== undefined) return wrap('cmt', cmt, classMap);
    if (str !== undefined) return wrap('str', str, classMap);
    if (num !== undefined) return wrap('num', num, classMap);
    if (kw !== undefined) return wrap('kw', kw, classMap);
    if (fn !== undefined) return wrap('fn', fn, classMap);
    if (punc !== undefined) return wrap('punc', punc, classMap);
    return match;
  });
}

/**
 * Tokenise an HTML-escaped bash snippet. Emits `cmt` for `#`-to-EOL comments,
 * `str` for quoted strings, `kw` for the documented bash keyword set, and
 * `kw` again for `$VAR` / `${VAR}` references (their colour matches keywords
 * in the prototype).
 */
function tokenizeBash(escaped: string, classMap: Record<TokKind, string>): string {
  const kwPattern = BASH_KEYWORDS.join('|');
  const re = new RegExp(
    '(#[^\\n]*)' +                                     // 1: comment
    '|(&#39;(?:\\\\.|(?!&#39;).)*&#39;' +              // 2a: single-quoted
    '|&quot;(?:\\\\.|(?!&quot;).)*&quot;)' +           // 2b: double-quoted
    `|\\b(${kwPattern})\\b` +                          // 3: keyword
    '|(\\$\\{[^}]+\\}|\\$[A-Za-z_][\\w]*)',            // 4: $VAR / ${VAR}
    'g',
  );
  return escaped.replace(re, (
    match,
    cmt: string | undefined,
    str: string | undefined,
    kw: string | undefined,
    varRef: string | undefined,
  ): string => {
    if (cmt !== undefined) return wrap('cmt', cmt, classMap);
    if (str !== undefined) return wrap('str', str, classMap);
    if (kw !== undefined) return wrap('kw', kw, classMap);
    if (varRef !== undefined) return wrap('kw', varRef, classMap);
    return match;
  });
}

/**
 * Regex for a fence opening line. Captures the language hint (possibly empty)
 * so the caller can recurse into a supported sublang. Anchored against the
 * RAW (non-escaped) source line.
 */
const FENCE_RE = /^```([A-Za-z0-9_-]*)\s*$/;

/**
 * Regex for a horizontal rule line. Matches three or more `-`, `*`, or `_`
 * characters (all the same) with optional surrounding whitespace.
 */
const HR_RE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

/**
 * Regex for a bullet list marker at the start of a line. Captures leading
 * indentation so callers can pass the whitespace through untouched and only
 * wrap the marker itself.
 */
const BULLET_RE = /^(\s*)([-*+]) (.*)$/;

/**
 * Regex for a numbered list marker. Captures leading indentation, the full
 * marker (digits + dot) and the rest of the line.
 */
const NUMBERED_RE = /^(\s*)(\d+\.) (.*)$/;

/** Sublangs the markdown fence recurses into. Everything else is plain. */
const FENCE_SUBLANGS = new Set<HighlightLang>(['json', 'ts', 'js', 'bash', 'diff']);

/**
 * Run the markdown inline pass on an already HTML-escaped line. Recognises
 * inline code, strong, em, `[label](url)` links, and `<http://…>` autolinks.
 * Emphasis delimiters are kept inside the emitted span (see file header).
 *
 * The regex is a single alternation evaluated left-to-right; earlier
 * alternates win on overlap. Order matters: inline code must come before
 * emphasis so a backticked span containing `**` is not mis-parsed as bold.
 *
 * @param escapedLine - A single line, HTML-escaped, without `\n`.
 * @param classMap - Resolved token class map.
 * @returns Inline-highlighted HTML.
 */
function applyInlineMarkdown(
  escapedLine: string,
  classMap: Record<TokKind, string>,
): string {
  const re = new RegExp(
    '(`[^`\\n]+`)' +                                        // 1: inline code
    '|(\\*\\*[^*\\n]+?\\*\\*|__[^_\\n]+?__)' +              // 2: strong
    '|(\\*[^*\\n]+?\\*|_[^_\\n]+?_)' +                      // 3: em
    '|\\[([^\\]\\n]+)\\]\\(([^)\\n]+)\\)' +                 // 4: link label, 5: link href
    '|&lt;(https?://[^\\s&]+)&gt;',                         // 6: autolink (already-escaped < >)
    'g',
  );
  return escapedLine.replace(re, (
    match,
    code: string | undefined,
    strong: string | undefined,
    em: string | undefined,
    linkLabel: string | undefined,
    linkHref: string | undefined,
    autolink: string | undefined,
  ): string => {
    if (code !== undefined) return wrap('mdInlineCode', code, classMap);
    if (strong !== undefined) return wrap('mdStrong', strong, classMap);
    if (em !== undefined) return wrap('mdEm', em, classMap);
    if (linkLabel !== undefined && linkHref !== undefined) {
      return wrapLink(linkLabel, linkHref, classMap);
    }
    if (autolink !== undefined) return wrapLink(autolink, autolink, classMap);
    return match;
  });
}

/**
 * Classify a heading line. Returns the heading token kind for 1-6 `#`
 * characters followed by a space; any other shape returns `null` so the
 * caller can fall through to prose handling.
 *
 * @param rawLine - Source line (unescaped).
 * @returns Matching heading kind or `null`.
 */
function headingKind(rawLine: string): TokKind | null {
  const match = /^(#{1,6}) /.exec(rawLine);
  if (!match || match[1] === undefined) return null;
  const level = match[1].length;
  return (`mdHeading${level}` as TokKind);
}

/**
 * Render a single non-fence markdown line. Dispatches across the structural
 * line detectors (heading, hr, blockquote, bullet, numbered list) and falls
 * through to the inline pass for ordinary prose. Keeps per-line logic out of
 * the top-level tokeniser so the main loop stays readable.
 *
 * @param rawLine - Source line (unescaped, without `\n`).
 * @param classMap - Resolved token class map.
 * @returns HTML for this line, without a trailing newline.
 */
function renderMarkdownLine(
  rawLine: string,
  classMap: Record<TokKind, string>,
): string {
  if (rawLine.length > MAX_LINE) return escapeHtml(rawLine);

  if (HR_RE.test(rawLine)) {
    return wrap('mdHr', escapeHtml(rawLine), classMap);
  }

  const heading = headingKind(rawLine);
  if (heading) {
    return wrap(heading, escapeHtml(rawLine), classMap);
  }

  if (rawLine.startsWith('> ') || rawLine === '>') {
    return wrap('mdQuote', escapeHtml(rawLine), classMap);
  }

  const bullet = BULLET_RE.exec(rawLine);
  if (bullet) return renderListLine(bullet, classMap);

  const numbered = NUMBERED_RE.exec(rawLine);
  if (numbered) return renderListLine(numbered, classMap);

  return applyInlineMarkdown(escapeHtml(rawLine), classMap);
}

/**
 * Render a bullet- or numbered-list line from a regex match. Expects capture
 * groups `(indent, marker, rest)` in that order. Extracted so both list
 * branches in {@link renderMarkdownLine} stay tiny and type-safe.
 *
 * @param match - Regex match; all three capture groups must be defined.
 * @param classMap - Resolved token class map.
 * @returns HTML for this list line.
 */
function renderListLine(
  match: RegExpExecArray,
  classMap: Record<TokKind, string>,
): string {
  const indent = match[1] ?? '';
  const marker = match[2] ?? '';
  const rest = match[3] ?? '';
  const indentHtml = escapeHtml(indent);
  const markerHtml = wrap('mdListMarker', escapeHtml(marker), classMap);
  const restHtml = applyInlineMarkdown(escapeHtml(rest), classMap);
  return `${indentHtml}${markerHtml} ${restHtml}`;
}

/**
 * Render the body of a fenced code block. If `lang` is a recognised sublang
 * the body is recursively highlighted; otherwise it is escaped and wrapped
 * as a single `mdCodeBlock` span. Keeps the recursion guard (only named
 * sublangs recurse) in one place.
 *
 * @param body - The raw body text between opening and closing fence.
 * @param lang - The fence's declared language hint (possibly empty).
 * @param classMap - Resolved token class map.
 * @returns HTML for the body (without the trailing newline separator).
 */
function renderFenceBody(
  body: string,
  lang: string,
  classMap: Record<TokKind, string>,
): string {
  const normalised = lang.toLowerCase() as HighlightLang;
  if (FENCE_SUBLANGS.has(normalised)) {
    return highlight(body, normalised, classMap);
  }
  return wrap('mdCodeBlock', escapeHtml(body), classMap);
}

/**
 * Tokenise a markdown source string line by line. Maintains a small state
 * machine for fenced code blocks: once an opening ``` is seen we buffer
 * subsequent lines until the matching closing fence (or EOF), then render
 * the fence lines as `mdFence` and the body via {@link renderFenceBody}.
 *
 * Input is the ORIGINAL (unescaped) markdown. Escaping happens per-line
 * inside the line renderers so that structural regexes can match `#`, `-`,
 * etc. without having to reason about `&amp;` versus `&`.
 *
 * @param source - Raw markdown source.
 * @param classMap - Resolved token class map.
 * @returns HTML safe to assign to `innerHTML`.
 */
function tokenizeMarkdown(source: string, classMap: Record<TokKind, string>): string {
  const lines = source.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const fence = FENCE_RE.exec(line);
    if (fence) {
      const lang = fence[1] ?? '';
      out.push(wrap('mdFence', escapeHtml(line), classMap));
      i += 1;
      const bodyStart = i;
      while (i < lines.length && !FENCE_RE.test(lines[i] ?? '')) i += 1;
      const body = lines.slice(bodyStart, i).join('\n');
      if (body.length > 0) out.push(renderFenceBody(body, lang, classMap));
      if (i < lines.length) {
        out.push(wrap('mdFence', escapeHtml(lines[i] ?? ''), classMap));
        i += 1;
      }
      continue;
    }
    out.push(renderMarkdownLine(line, classMap));
    i += 1;
  }
  return out.join('\n');
}

/**
 * Tokenise an HTML-escaped diff snippet. Lines beginning with `+`, `-`, or
 * `@@` are wrapped; every other line is left as-is.
 */
function tokenizeDiff(escaped: string, classMap: Record<TokKind, string>): string {
  const re = /^(\+[^\n]*)|^(-[^\n]*)|^(@@[^\n]*)/gm;
  return escaped.replace(re, (
    match,
    add: string | undefined,
    del: string | undefined,
    ctx: string | undefined,
  ): string => {
    if (add !== undefined) return wrap('add', add, classMap);
    if (del !== undefined) return wrap('del', del, classMap);
    if (ctx !== undefined) return wrap('ctx', ctx, classMap);
    return match;
  });
}

/**
 * Tokenize `text` for `lang` and return HTML with each token wrapped in a
 * <span class="..."> using the resolved class map. The input is HTML-escaped
 * before tokenization, so the returned string is safe to assign to innerHTML.
 *
 * - `classMap` overrides the default literal classes ({ str: 'tok-str', ... }).
 *   Pass a CSS-module's class map to scope the colours.
 * - Unknown languages fall through to the escaped-but-unhighlighted text.
 * - Empty / null input returns an empty string.
 *
 * @param text - Source text to tokenise.
 * @param lang - One of {@link HighlightLang}; unknown values pass through.
 * @param classMap - Optional shallow override of the default `tok-*` classes.
 * @returns HTML string safe for assignment to `innerHTML`.
 */
export function highlight(
  text: string,
  lang: HighlightLang,
  classMap?: Partial<Record<TokKind, string>>,
): string {
  if (!text) return '';
  const resolved = resolveClassMap(classMap);
  if (lang === 'markdown') {
    return tokenizeMarkdown(text, resolved);
  }
  const escaped = escapeHtml(text);
  switch (lang) {
    case 'json':
      return tokenizeJson(escaped, resolved);
    case 'ts':
    case 'js':
      return tokenizeTs(escaped, resolved);
    case 'bash':
      return tokenizeBash(escaped, resolved);
    case 'diff':
      return tokenizeDiff(escaped, resolved);
    default:
      return escaped;
  }
}
