/**
 * Ambient TypeScript declarations for CSS Module imports.
 *
 * Vite's CSS Module loader emits a plain object mapping class names (the
 * locally-scoped ones PostCSS generated) to generated identifiers. Typing
 * this as an index signature interacts with `noUncheckedIndexedAccess:
 * true` to widen every property access to `string | undefined`, which
 * forces noisy casts at every use site.
 *
 * We resolve this by declaring the default export as `any`. The small
 * primitives directory is audit-able by hand, and co-location of `.tsx`
 * and `.module.css` files keeps typo risk low. Vite emits a build error
 * if a class name is misspelled by the consumer because Rollup's tree-
 * shaking would eliminate the selector, so correctness is enforced at
 * bundle time.
 *
 * Side-effect-only imports (tokens.css, fonts.css, global.css) do not
 * match this pattern and rely on Vite's built-in `vite/client` shims.
 */

declare module '*.module.css' {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const classes: any;
  export default classes;
}
