/**
 * Babel plugin factory that stamps `data-forjis-src` (and, when
 * applicable, `data-forjis-component`) attributes onto every
 * `JSXOpeningElement` in a parsed module.
 *
 * The visitor reads source locations from each node's own `loc` property
 * (populated unconditionally by Babel's parser) so the plugin is
 * framework-agnostic: React, SolidJS, and Preact all parse JSX through
 * Babel and end up with the same `loc` shape.
 *
 * Columns are translated from Babel's 0-based convention to 1-based so
 * downstream consumers (editors, the `PinSource` shared type) receive
 * values that match what humans see in their editor gutter.
 */

import type { PluginObj, PluginPass } from '@babel/core';
import * as t from '@babel/types';
import path from 'node:path';

/** Attribute name written to each stamped opening element. */
const DATA_SRC_ATTR = 'data-forjis-src';

/** Attribute name written to capitalized components. */
const DATA_COMPONENT_ATTR = 'data-forjis-component';

/** Identifiers the visitor skips outright (no DOM target to match on). */
const SKIPPED_COMPONENT_IDENTIFIERS = new Set<string>(['Fragment', 'Suspense']);

/**
 * Options supplied to {@link createStampPlugin}.
 */
export interface CreateStampPluginOptions {
  /**
   * Vite project root used to compute module-relative paths. Paths are
   * emitted with posix `/` separators regardless of the host OS.
   */
  readonly projectRoot: string;
}

/**
 * Return `true` when the opening element already carries a
 * `data-forjis-src` attribute.
 *
 * @param node - Opening element to inspect.
 * @returns Whether the element was already stamped.
 */
function hasExistingSrcAttribute(node: t.JSXOpeningElement): boolean {
  return node.attributes.some(
    (attr) =>
      attr.type === 'JSXAttribute' &&
      attr.name.type === 'JSXIdentifier' &&
      attr.name.name === DATA_SRC_ATTR,
  );
}

/**
 * Return `true` when the opening element names a plain identifier we
 * explicitly skip (Fragment/Suspense render no DOM node).
 *
 * @param node - Opening element to inspect.
 * @returns Whether the element should be skipped entirely.
 */
function isSkippedIdentifier(node: t.JSXOpeningElement): boolean {
  if (node.name.type !== 'JSXIdentifier') {
    return false;
  }
  return SKIPPED_COMPONENT_IDENTIFIERS.has(node.name.name);
}

/**
 * Build the project-relative module path that is embedded in
 * `data-forjis-src`. Always uses posix separators.
 *
 * @param projectRoot - Vite project root.
 * @param filename - Absolute filename from Babel's `state.filename`.
 * @returns Posix-normalized relative path.
 */
function buildRelativePath(projectRoot: string, filename: string): string {
  const relative = path.posix.relative(
    projectRoot.replace(/\\/g, '/'),
    filename.replace(/\\/g, '/'),
  );
  return relative;
}

/**
 * Walk a `JSXMemberExpression` chain and produce a dotted component name
 * (e.g. `Foo.Bar.Baz`). Returns `null` when any segment is a namespaced
 * identifier or starts with a lowercase letter.
 *
 * @param expression - Member expression to flatten.
 * @returns Dotted component name or `null` when the chain is invalid.
 */
function flattenMemberExpression(
  expression: t.JSXMemberExpression,
): string | null {
  const parts: string[] = [];
  let current: t.JSXMemberExpression['object'] | t.JSXMemberExpression =
    expression;
  while (current.type === 'JSXMemberExpression') {
    const prop = current.property;
    if (prop.type !== 'JSXIdentifier') {
      return null;
    }
    parts.unshift(prop.name);
    current = current.object;
  }
  if (current.type !== 'JSXIdentifier') {
    return null;
  }
  parts.unshift(current.name);
  for (const part of parts) {
    if (!/^[A-Z]/.test(part)) {
      return null;
    }
  }
  return parts.join('.');
}

/**
 * Derive the component name to stamp on the element, or `null` when the
 * element is a lowercase intrinsic or a namespaced identifier.
 *
 * @param node - Opening element being visited.
 * @returns Component name for `data-forjis-component` or `null`.
 */
function resolveComponentName(node: t.JSXOpeningElement): string | null {
  if (node.name.type === 'JSXIdentifier') {
    const name = node.name.name;
    if (SKIPPED_COMPONENT_IDENTIFIERS.has(name)) {
      return null;
    }
    if (!/^[A-Z]/.test(name)) {
      return null;
    }
    return name;
  }
  if (node.name.type === 'JSXMemberExpression') {
    return flattenMemberExpression(node.name);
  }
  return null;
}

/**
 * Build a `JSXAttribute` with the given name and string value.
 *
 * @param name - Attribute name.
 * @param value - Attribute value (a plain string literal).
 * @returns New `JSXAttribute` node.
 */
function makeStringAttribute(name: string, value: string): t.JSXAttribute {
  return t.jsxAttribute(t.jsxIdentifier(name), t.stringLiteral(value));
}

/**
 * Create a Babel plugin object whose single visitor stamps
 * `data-forjis-src` (and, for capitalized components, also
 * `data-forjis-component`) onto every `JSXOpeningElement`.
 *
 * @param options - Project-root configuration.
 * @returns Babel `PluginObj` ready to pass via `plugins: []`.
 */
export function createStampPlugin(
  options: CreateStampPluginOptions,
): PluginObj {
  const projectRoot = options.projectRoot;
  return {
    name: 'forjis-inspector-stamp',
    visitor: {
      JSXOpeningElement(nodePath, state: PluginPass) {
        const node = nodePath.node;
        if (hasExistingSrcAttribute(node)) {
          return;
        }
        if (isSkippedIdentifier(node)) {
          return;
        }
        if (!node.loc) {
          return;
        }
        const filename = state.filename ?? '';
        const relative = buildRelativePath(projectRoot, filename);
        const line = node.loc.start.line;
        const column = node.loc.start.column + 1;
        const value = relative + ':' + line + ':' + column;
        node.attributes.push(makeStringAttribute(DATA_SRC_ATTR, value));
        const componentName = resolveComponentName(node);
        if (componentName !== null) {
          node.attributes.push(
            makeStringAttribute(DATA_COMPONENT_ATTR, componentName),
          );
        }
      },
    },
  };
}
