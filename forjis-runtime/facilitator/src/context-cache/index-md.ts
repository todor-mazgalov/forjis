/**
 * Builder for `.forjis/context/index.md`.
 *
 * Generates two sections:
 *   1. `## Workspace layout` — top-level directories under `repoRoot`
 *      with a one-line `(no description)` placeholder.
 *   2. `## High-traffic files` — top-10 paths by occurrence count in
 *      `git log -n <commitWindow> --name-only --pretty=format:`.
 *
 * The `gitImpl` injection seam lets tests stub git completely. On any
 * git failure (non-zero exit, missing binary), the high-traffic section
 * is emitted with a "(no data)" placeholder — never throws.
 */

import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

import type { TreeYaml } from './tree-yaml.js';

/** Default high-traffic commit window. */
const DEFAULT_COMMIT_WINDOW = 200;

/** Max entries rendered in the "High-traffic files" section. */
const HIGH_TRAFFIC_LIMIT = 10;

/** Shape returned by the git injection seam. */
export interface GitResult {
  stdout: string;
  exitCode: number;
}

/** Options accepted by {@link buildIndexMd}. */
export interface BuildIndexOptions {
  /** Absolute project root. */
  repoRoot: string;
  /** Parsed tree.yaml — currently unused in v1; reserved for future richer layout. */
  tree: TreeYaml;
  /** Top-N commits for high-traffic section. Default: 200. */
  commitWindow?: number;
  /** Injection seam for git. */
  gitImpl?: (args: string[], cwd: string) => Promise<GitResult>;
}

/**
 * Assembles the `index.md` body.
 *
 * Never throws. On `git log` failure the high-traffic section shows
 * "(no data)". When the repo contains fewer than 10 distinct paths in
 * the window, fewer entries are emitted.
 *
 * @param opts - Build options.
 * @returns The fully rendered markdown string.
 */
export async function buildIndexMd(opts: BuildIndexOptions): Promise<string> {
  const commitWindow = opts.commitWindow ?? DEFAULT_COMMIT_WINDOW;
  const git = opts.gitImpl ?? runGit;

  const layoutSection = await buildWorkspaceLayout(opts.repoRoot);
  const trafficSection = await buildHighTrafficSection(
    git,
    opts.repoRoot,
    commitWindow,
  );

  return `${layoutSection}\n\n${trafficSection}\n`;
}

/**
 * Lists top-level directories of `repoRoot` (non-dotfiles only) as a
 * Markdown list. Each entry gets the `(no description)` placeholder;
 * operators may override in a future iteration (O-3 in design.md).
 */
async function buildWorkspaceLayout(repoRoot: string): Promise<string> {
  const lines: string[] = ['## Workspace layout', ''];
  let entries: string[] = [];
  try {
    const dirents = await readdir(repoRoot, { withFileTypes: true });
    entries = dirents
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name)
      .sort();
  } catch {
    /* empty workspace layout on readdir failure */
  }

  if (entries.length === 0) {
    lines.push('- (no top-level directories)');
  } else {
    for (const name of entries) {
      lines.push(`- ${name}/ — (no description)`);
    }
  }
  return lines.join('\n');
}

/**
 * Runs `git log -n <window> --name-only --pretty=format:` and tallies
 * path occurrences. Emits the top 10 as `- <path> (<count>x)`.
 */
async function buildHighTrafficSection(
  git: (args: string[], cwd: string) => Promise<GitResult>,
  repoRoot: string,
  commitWindow: number,
): Promise<string> {
  const lines: string[] = ['## High-traffic files', ''];

  let result: GitResult;
  try {
    result = await git(
      ['log', `-n`, String(commitWindow), '--name-only', '--pretty=format:'],
      repoRoot,
    );
  } catch {
    lines.push('- (no data)');
    return lines.join('\n');
  }

  if (result.exitCode !== 0) {
    lines.push('- (no data)');
    return lines.join('\n');
  }

  const counts = new Map<string, number>();
  for (const raw of result.stdout.split('\n')) {
    const p = raw.trim();
    if (p.length === 0) continue;
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }

  if (counts.size === 0) {
    lines.push('- (no data)');
    return lines.join('\n');
  }

  const ranked = Array.from(counts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, HIGH_TRAFFIC_LIMIT);

  for (const [path, count] of ranked) {
    lines.push(`- ${path} (${count}x)`);
  }
  return lines.join('\n');
}

/**
 * Default git runner via `child_process.spawn`.
 *
 * Collects stdout into a single string. Does not reject on non-zero
 * exit; returns the accumulated output + exit code so callers decide
 * how to degrade.
 */
function runGit(args: string[], cwd: string): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.on('error', () => {
      resolve({ stdout: '', exitCode: -1 });
    });
    child.on('close', (code) => {
      resolve({ stdout, exitCode: code ?? -1 });
    });
  });
}
