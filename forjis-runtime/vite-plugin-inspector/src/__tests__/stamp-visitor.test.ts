/**
 * Unit tests for {@link createStampPlugin}.
 *
 * Exercises FR-007 (every JSX opening element is stamped), FR-008
 * (component name detection for identifiers and member expressions),
 * FR-009 (fragment/non-DOM exclusions), and FR-010 (pre-stamped
 * elements are not double-stamped).
 */

import babel from '@babel/core';
import { createStampPlugin } from '../stamp-visitor.js';

/**
 * Run Babel with the stamp plugin over a JSX fixture.
 *
 * @param source - JSX source text.
 * @param filename - Absolute path Babel should treat as the module id.
 * @param projectRoot - Vite project root the plugin relativizes against.
 * @returns Transformed code.
 */
function runStamp(
  source: string,
  filename: string,
  projectRoot: string,
): string {
  const result = babel.transformSync(source, {
    filename,
    ast: false,
    babelrc: false,
    configFile: false,
    parserOpts: {
      sourceType: 'module',
      plugins: ['jsx', 'typescript'],
    },
    plugins: [createStampPlugin({ projectRoot })],
  });
  if (!result || result.code == null) {
    throw new Error('babel.transformSync produced no output');
  }
  return result.code;
}

/**
 * Count occurrences of a substring inside the given text.
 *
 * @param text - Haystack.
 * @param needle - Literal substring to count.
 * @returns Number of non-overlapping occurrences.
 */
function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  let count = 0;
  let index = 0;
  while (true) {
    const found = text.indexOf(needle, index);
    if (found === -1) {
      return count;
    }
    count += 1;
    index = found + needle.length;
  }
}

describe('createStampPlugin', () => {
  const projectRoot = '/tmp/project';
  const filename = '/tmp/project/fixture.tsx';

  it('stamps every JSXOpeningElement with data-forjis-src="fixture.tsx:line:col"', () => {
    const source =
      'const Header = () => null;\n' +
      'const tree = <div><Header><span/></Header></div>;\n';
    const out = runStamp(source, filename, projectRoot);
    const matches = out.match(/data-forjis-src="fixture\.tsx:\d+:\d+"/g);
    expect(matches).not.toBeNull();
    expect(matches).toHaveLength(3);
  });

  it('stamps data-forjis-component="Header" on the Header element', () => {
    const source =
      'const Header = () => null;\n' +
      'const tree = <div><Header><span/></Header></div>;\n';
    const out = runStamp(source, filename, projectRoot);
    expect(out).toContain('data-forjis-component="Header"');
  });

  it('does NOT stamp data-forjis-component on intrinsic <div> or <span>', () => {
    const source =
      'const Header = () => null;\n' +
      'const tree = <div><Header><span/></Header></div>;\n';
    const out = runStamp(source, filename, projectRoot);
    const componentAttrs = out.match(/data-forjis-component="[^"]+"/g) ?? [];
    expect(componentAttrs).toEqual(['data-forjis-component="Header"']);
  });

  it('leaves JSX fragments untouched but stamps inner elements', () => {
    const source = 'const tree = <><span/></>;\n';
    const out = runStamp(source, filename, projectRoot);
    // The inner <span/> is the only JSXOpeningElement; exactly one stamp.
    const srcMatches = out.match(/data-forjis-src="fixture\.tsx:\d+:\d+"/g);
    expect(srcMatches).toHaveLength(1);
    // Fragment tokens remain bare — no attribute list was added to them.
    expect(out).toMatch(/<>\s*<span/);
  });

  it('skips elements named Fragment or Suspense (no DOM target)', () => {
    const source = 'const tree = <Fragment><span/></Fragment>;\n';
    const out = runStamp(source, filename, projectRoot);
    // Only one stamp — on <span/>, not on <Fragment>.
    const srcMatches = out.match(/data-forjis-src="fixture\.tsx:\d+:\d+"/g);
    expect(srcMatches).toHaveLength(1);
    expect(out).not.toContain('data-forjis-component="Fragment"');
  });

  it('stamps data-forjis-component="Foo.Bar" for member-expression names', () => {
    const source = 'const tree = <Foo.Bar/>;\n';
    const out = runStamp(source, filename, projectRoot);
    expect(out).toContain('data-forjis-component="Foo.Bar"');
  });

  it('preserves hand-written data-forjis-src without double-stamping', () => {
    const source = 'const tree = <div data-forjis-src="keep.tsx:1:1"/>;\n';
    const out = runStamp(source, filename, projectRoot);
    expect(countOccurrences(out, 'data-forjis-src=')).toBe(1);
    expect(out).toContain('data-forjis-src="keep.tsx:1:1"');
  });

  it('does NOT stamp data-forjis-component when a member expression has a lowercase leaf (FR-008)', () => {
    // `<foo.Bar/>` starts lowercase → not a real component reference per
    // D-005 flattening rules; the chain must be aborted and the element
    // must NOT carry a data-forjis-component attribute.
    const source = 'const tree = <foo.Bar/>;\n';
    const out = runStamp(source, filename, projectRoot);
    // Still stamped with a src location.
    expect(out).toMatch(/data-forjis-src="fixture\.tsx:\d+:\d+"/);
    // But no component name.
    expect(out).not.toContain('data-forjis-component');
  });

  it('does NOT stamp data-forjis-component on XML-namespaced identifiers (FR-008)', () => {
    // `<svg:foo/>` is a JSXNamespacedName — D-005 says skip.
    const source = 'const tree = <svg:foo/>;\n';
    const out = runStamp(source, filename, projectRoot);
    // The element still gets a src stamp (FR-007 applies to all opening
    // elements) — only the component attr is skipped.
    expect(out).toMatch(/data-forjis-src="fixture\.tsx:\d+:\d+"/);
    expect(out).not.toContain('data-forjis-component');
  });

  it('derives source location from node.loc without requiring prior _source decoration (D-005)', () => {
    // The fixture is raw JSX with no react-jsx-source transform ahead of
    // us. If the visitor depended on `_source`, no stamp would appear.
    const source = 'const tree = <Header/>;\n';
    const out = runStamp(source, filename, projectRoot);
    // Babel's parser populated `loc` unconditionally, so we MUST still
    // emit an attribute with a line/col value.
    expect(out).toMatch(/data-forjis-src="fixture\.tsx:1:\d+"/);
  });

  it('emits 1-based column numbers (D-005)', () => {
    // Two-space indent → Babel's 0-based column is 2; our attribute must
    // read column 3.
    const source = '  const tree = <div/>;\n';
    const out = runStamp(source, filename, projectRoot);
    // The `<div` opens at character index 15 (line 1), 0-based col 15 →
    // 1-based col 16.
    expect(out).toContain('data-forjis-src="fixture.tsx:1:16"');
  });
});
