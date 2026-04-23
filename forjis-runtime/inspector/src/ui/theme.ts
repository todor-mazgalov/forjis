/**
 * Shared Forjis design-token block injected into every shadow-root stylesheet
 * emitted by the inspector UI modules.
 *
 * The inspector ships its own Shadow DOM style sheets (see each
 * `ui/*.ts` factory's `<style>` child). Copying the canonical
 * `forjis-runtime/web/client/src/styles/tokens.css` declarations under the
 * shadow root's implicit `:host` scope lets every panel consume the same
 * `--bg-*`, `--border`, `--text`, and `--accent` variables without coupling
 * back to the dashboard bundle. The shadow root isolates these vars from
 * the host page, so the inspector stays self-contained.
 *
 * Values MUST stay in sync with the dashboard tokens.css; when the design
 * system shifts, update both sites.
 */

/**
 * CSS text fragment that declares the Forjis design tokens on `:host`.
 *
 * Prepend this constant to every inspector shadow-root stylesheet so
 * `var(--accent)`, `var(--bg-panel)`, etc. resolve inside the shadow tree.
 */
export const FORJIS_TOKENS = `
:host {
  --bg-base: #0b0d10;
  --bg-panel: #0f1216;
  --bg-raised: #13171c;
  --bg-sunken: #181d23;
  --border: #1a1f26;
  --border-strong: #273039;
  --text: #d4dadf;
  --text-dim: #8a95a2;
  --text-muted: #6b7785;
  --accent: oklch(0.78 0.18 145);
  --accent-dim: oklch(0.45 0.11 145);
  --accent-glow: oklch(0.78 0.18 145 / 0.12);
  --amber: #f5c06a;
  --red: #ef6d6d;
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;
  --text-2xs: 10px;
  --text-xs: 11px;
  --text-sm: 12px;
  --text-base: 13px;
  --text-md: 15px;
  --space-1: 4px;
  --space-2: 6px;
  --space-3: 8px;
  --space-4: 12px;
  --space-5: 16px;
  --row: 28px;
  --radius: 4px;
  --radius-sm: 3px;
  --radius-xs: 2px;
}
`;
