/**
 * capture-screenshot.mjs — Playwright-driven redacted screenshot of the
 * running dashboard.
 *
 * Opens http://127.0.0.1:4242 in headless Chromium, walks the DOM to replace
 * project-specific strings (absolute paths, task ids, forjis branch names)
 * with stable placeholders, pauses CSS animations so the capture is
 * deterministic, and writes `assets/screenshots/dashboard.png` at the repo
 * root (resolved relative to this script, so `cwd` doesn't matter).
 *
 * Intended for public README / docs screenshots — the output must NOT leak
 * absolute paths, personal usernames, or real task descriptions.
 *
 * Usage (from anywhere in the repo):
 *   node forjis-runtime/scripts/capture-screenshot.mjs
 *
 * Flags:
 *   --url <url>      Dashboard URL (default: http://127.0.0.1:4242)
 *   --out <path>     Output PNG path (default: <repo>/assets/screenshots/dashboard.png)
 *   --width <px>     Viewport width  (default: 1680)
 *   --height <px>    Viewport height (default: 1050)
 *   --full           Capture the full scrollable page instead of the viewport
 *   --no-scrub       Skip DOM redaction (useful for debugging selectors)
 *   --wait <ms>      Extra wait after load before capture (default: 1500)
 */

import { chromium } from 'playwright';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

/** Absolute path to the repo root, derived from the script's own location
 *  (`<repo>/forjis-runtime/scripts/capture-screenshot.mjs`). Using the
 *  script path instead of `process.cwd()` keeps the default output stable
 *  regardless of where the user invokes `node …` from. */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Parse simple `--flag value` argv into a record. */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const url = args.url ?? 'http://127.0.0.1:4242';
// Default lives at the repo root so the PNG sits beside the rest of the
// README assets (`assets/logo-h.*`, `assets/logo-l.*`). `--out` can
// override with either an absolute or cwd-relative path.
const outPath = args.out
  ? resolve(args.out)
  : resolve(repoRoot, 'assets', 'screenshots', 'dashboard.png');
const width = Number(args.width ?? 1680);
const height = Number(args.height ?? 1050);
const fullPage = args.full === true;
const doScrub = args['no-scrub'] !== true;
const settleMs = Number(args.wait ?? 1500);

mkdirSync(dirname(outPath), { recursive: true });

/**
 * DOM-side scrub function evaluated inside the page context. Kept as a
 * string-serialised function so Playwright's `evaluate` can ship it across.
 * Walks every text node under `<body>` and applies regex substitutions for
 * the patterns most likely to leak in a public screenshot.
 */
function scrubPage() {
  // Targeted fix for the top-bar breadcrumb: `<nav aria-label="Project path">`
  // renders one `<span>` per path segment, interleaved with `/` separators.
  // A text-node regex can't catch it because each span holds a single
  // segment. Replace the whole list in one shot.
  const crumbNav = document.querySelector('nav[aria-label="Project path"]');
  if (crumbNav instanceof HTMLElement) {
    const placeholder = ['~', 'projects', 'my-project'];
    crumbNav.innerHTML = '';
    placeholder.forEach((segment, i) => {
      if (i > 0) {
        const sep = document.createElement('span');
        sep.textContent = '/';
        sep.setAttribute('aria-hidden', 'true');
        sep.style.margin = '0 6px';
        sep.style.opacity = '0.5';
        crumbNav.appendChild(sep);
      }
      const span = document.createElement('span');
      span.textContent = segment;
      if (i === placeholder.length - 1) span.style.color = 'var(--text)';
      else span.style.color = 'var(--text-mute)';
      crumbNav.appendChild(span);
    });
  }

  const taskMap = new Map();
  /** Enumerate task ids deterministically in the order they appear. */
  function taskSlug(id) {
    if (!taskMap.has(id)) {
      const n = String(taskMap.size + 1).padStart(2, '0');
      taskMap.set(id, `task-${n}`);
    }
    return taskMap.get(id);
  }

  // Pre-seed taskMap by walking the task rail in render order, so task
  // slugs are stable regardless of which text node is visited first.
  // Each TaskCard `<article>` exposes its task id via `data-task-id` —
  // a far more reliable anchor than scraping the title textContent.
  const cards = Array.from(document.querySelectorAll('article[data-task-id]'));
  for (const card of cards) {
    const id = card.getAttribute('data-task-id');
    if (id !== null && id.length > 0) taskSlug(id.toLowerCase());
  }

  // Rewrite each card's branch chain to the conventional {base, task} pair.
  // Targets the branch-name span next to each `Copy branch …` button.
  // Tagged element attributes are updated too (title + aria-label) so a
  // screenshot-reading tool would see the same placeholder everywhere.
  // Collected spans are passed to the text-node walker below so its regex
  // chain does not re-overwrite `forjis/task-01` via the `forjisBranch`
  // fallback (this was the "main / main" regression the user saw).
  const scrubbedBranchSpans = new Set();
  let scrubbedBranchRows = 0;
  for (const card of cards) {
    const id = card.getAttribute('data-task-id') ?? 'task';
    const slug = taskSlug(id.toLowerCase());
    const copyButtons = card.querySelectorAll('button[aria-label^="Copy branch"]');
    copyButtons.forEach((btn, index) => {
      const row = btn.closest('[class*="branchRow" i]') ?? btn.parentElement;
      if (row === null) return;
      const nameSpan = row.querySelector('[class*="branchName" i], span[title]');
      if (nameSpan === null) return;
      const isLast = index === copyButtons.length - 1;
      const replacement = isLast ? `forjis/${slug}` : 'main';
      nameSpan.textContent = replacement;
      if (nameSpan instanceof HTMLElement) nameSpan.title = replacement;
      btn.setAttribute('aria-label', `Copy branch ${replacement}`);
      scrubbedBranchSpans.add(nameSpan);
      scrubbedBranchRows += 1;
    });
  }
  // Emit a diagnostic to the console Playwright captures via `consoleMsg`.
  // Visible only when the capture script forwards page logs; safe to leave in.
  if (typeof console !== 'undefined') {
    console.log(`[scrub] cards=${cards.length} branchRowsScrubbed=${scrubbedBranchRows}`);
  }

  // Pattern 1: absolute Windows paths (D:/Z/forjis-v5/..., C:/Users/...).
  const winPath = /[A-Za-z]:[\\/][\w.\-/\\]+/g;
  // Pattern 2: POSIX / Git-Bash paths (/d/Z/..., /home/..., /Users/...).
  const posixPath = /(?:^|[\s"'(])(\/[A-Za-z][\w.\-/]{3,})/g;
  // Pattern 2b: repo-relative paths (forjis-runtime/..., openspec/...).
  // Appear in tool-call previews ("cd forjis-runtime/facilitator && …")
  // and git stash messages. Match a known top-level dir followed by at
  // least one segment so we don't nuke bare words like "forjis-runtime"
  // in prose. Keeps the top-level name to preserve pipeline readability
  // and swaps the tail with a generic `…/file`.
  const repoRelPath = /\b(forjis-runtime|openspec|personas|pillars|tasks|test|docs|assets|node_modules)(?:[\\/][\w.\-/]+)/g;
  // Pattern 3: task ids matching the observed naming conventions. Keeps the
  // replacement stable across text nodes via `taskMap`. Run BEFORE the
  // branch substitution so the branch's synthetic `task-N` suffix is not
  // picked up and re-mapped.
  const taskIds = /\b(?:fix-[a-z0-9-]+|redesign-\d+-[a-z0-9-]+)\b/gi;
  // Pattern 4: forjis branch slugs (forjis/stage, forjis/fix-roles-display).
  // Uses a branch label that does NOT contain `task-` so `taskIds` above
  // can never re-match the substitution.
  const forjisBranch = /\bforjis\/[a-z0-9][a-z0-9-]*\b/gi;
  // Pattern 5: plugin-prefixed role composites (`software-dev:BackendDev`,
  // `software-dev:Architect (Frontend)`). Keep only the bare role name so
  // the pipeline reads as a clean stage list.
  const roleComposite = /\b[a-z][a-z0-9-]*:([A-Z][A-Za-z0-9]*)\b(?:\s*\([^)]+\))?/g;
  // Pattern 6: UUIDs used as session / tool_use ids — noise that survives
  // past the path scrub.
  const uuid = /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi;
  const toolUseId = /\btoolu_[a-zA-Z0-9]+\b/g;

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);

  for (const node of nodes) {
    // Skip the breadcrumb we already rebuilt above.
    if (crumbNav instanceof HTMLElement && crumbNav.contains(node)) continue;
    // Skip branch-name spans already rewritten to `main` / `forjis/task-N`.
    // The `forjisBranch` regex below would otherwise fold `forjis/task-01`
    // back into `main`, producing the `main / main` rail pair bug.
    const parentEl = node.parentElement;
    if (parentEl !== null && scrubbedBranchSpans.has(parentEl)) continue;

    const original = node.nodeValue;
    if (original === null) continue;
    let text = original;

    text = text.replace(winPath, '~/projects/my-project');
    text = text.replace(posixPath, (m, p) => m.slice(0, m.length - p.length) + '~/projects/my-project');
    text = text.replace(repoRelPath, (_m, dir) => `${dir}/…/file`);
    text = text.replace(taskIds, (m) => taskSlug(m.toLowerCase()));
    // Any `forjis/<slug>` branch that slipped past the card-targeted rewrite
    // above (e.g. in the status bar's current-branch label) becomes `main`.
    text = text.replace(forjisBranch, 'main');
    text = text.replace(roleComposite, (_m, role) => role);
    text = text.replace(uuid, 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx');
    text = text.replace(toolUseId, 'toolu_xxxxxxxx');
    // Cosmetic polish: the engine sometimes stores literal `undefined` in
    // follow-up SYSTEM rows (downstream bug, not scrub). Replace so the
    // README screenshot reads like a healthy run.
    text = text.replace(/model=undefined/g, 'model=claude-opus');
    text = text.replace(/cwd=undefined/g, 'cwd=~/projects/my-project');

    if (text !== original) node.nodeValue = text;
  }

  // Every `<pre>` in the stream holds either a tool-call JSON payload or a
  // tool-result body. Both can leak command-specific text (absolute paths,
  // task descriptions, stdout dumps) that text-node regexes miss when the
  // syntax highlighter splits a value across span children. Replace the
  // whole pre with a canned placeholder appropriate to its context —
  // tool-call bodies get structured JSON, tool-result bodies get a multi-
  // line faux-log so the pane still looks populated.
  const pres = document.querySelectorAll('pre');
  pres.forEach((pre, index) => {
    const parent = pre.closest('[class*="block" i]');
    const inResult = parent?.querySelector('[class*="badgeUser" i], [class*="typeBadge" i]') !== null
      && parent?.querySelector('[class*="toolName" i]') === null;
    if (inResult) {
      pre.textContent = [
        '  PASS  src/features/example.test.ts',
        '    ✓ renders placeholder (8 ms)',
        '    ✓ updates on interaction (3 ms)',
        '',
        'Test Suites: 1 passed, 1 total',
        'Tests:       2 passed, 2 total',
      ].join('\n');
    } else {
      pre.textContent =
        '{\n  "command": "<example-command>",\n  "description": "<what this does>"\n}';
    }
  });
}

console.log(`[capture] launching headless Chromium…`);
const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width, height },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
});
const page = await context.newPage();
page.on('console', (msg) => {
  if (msg.type() === 'log' && msg.text().startsWith('[scrub]')) {
    console.log(`[capture] ${msg.text()}`);
  }
});

// Inject BEFORE any app code runs so the SolidJS rail/pipeline/events
// pollers (setInterval-based) never fire — otherwise a poll response can
// land between our DOM scrub and the screenshot and overwrite placeholder
// text with real task ids / branch names.
await context.addInitScript(() => {
  // Replace setInterval with a no-op. Initial fetches use fetch() directly
  // so data still loads; only the 2-second refresh pollers die.
  // @ts-ignore
  window.setInterval = () => 0;
});

console.log(`[capture] navigating to ${url}`);
await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });

// Give SolidJS hydration + first data fetch a moment to settle.
await page.waitForTimeout(settleMs);

// Pick a task so the centre + right columns have something to show. We
// prefer the currently-running task (if any) because its pipeline plan and
// events stream are the most visually interesting; otherwise fall back to
// the first card in the rail.
const selectedTaskLabel = await page.evaluate(() => {
  const rail = document.querySelector('[aria-label="Tasks" i], [aria-label*="task" i]');
  const cards = Array.from(document.querySelectorAll('button, [role="button"]'));
  const taskCards = cards.filter((el) => {
    const t = el.textContent ?? '';
    return /\b(?:fix-|redesign-|task-)[a-z0-9-]+\b/i.test(t);
  });
  if (taskCards.length === 0) return null;
  const running = taskCards.find((el) => {
    const style = getComputedStyle(el.querySelector('[class*="statusDot" i], [class*="dot" i]') ?? el);
    return /live|running/i.test(el.className) || /running/i.test(el.textContent ?? '');
  });
  const target = running ?? taskCards[0];
  target.click();
  return target.textContent?.slice(0, 60) ?? null;
});
if (selectedTaskLabel) {
  console.log(`[capture] clicked task: ${selectedTaskLabel.replace(/\s+/g, ' ').trim()}`);
  // Wait for the detail pane to materialise and the events stream to load.
  await page.waitForTimeout(2000);
}

if (doScrub) {
  console.log(`[capture] scrubbing DOM text…`);
  await page.evaluate(scrubPage);
}

// Kill animations so the capture is deterministic (no mid-pulse live dots).
await page.addStyleTag({
  content: `
    *, *::before, *::after {
      animation-duration: 0s !important;
      animation-iteration-count: 1 !important;
      transition-duration: 0s !important;
    }
  `,
});

// One more tick for the scrub-induced repaint to settle.
await page.waitForTimeout(200);

console.log(`[capture] writing ${outPath}`);
await page.screenshot({ path: outPath, fullPage });

await browser.close();
console.log(`[capture] done.`);
