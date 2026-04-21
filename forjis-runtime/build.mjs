/**
 * Build orchestrator for the @forjis monorepo.
 *
 * Compiles packages in dependency order with no bootstrap pass:
 * 1. shared      (types-only, no internal deps)
 * 2. resolver    (depends on shared)
 * 3. web         (depends on shared)
 * 3b. web/client (Vite build — produces the dashboard JS/CSS bundle served
 *                 from `web/client/dist/`. Run explicitly here because we
 *                 invoke `tsc` directly per workspace, which bypasses the
 *                 `postbuild` lifecycle hook in `web/package.json`.)
 * 4. facilitator (depends on shared, resolver; web built first for runtime dynamic import)
 * 5. cli         (depends on facilitator)
 */

import { execSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(fileURLToPath(import.meta.url));

/**
 * Runs tsc in the given workspace directory.
 *
 * @param workspace - Workspace directory name relative to root.
 */
function buildWorkspace(workspace) {
  const cwd = resolve(rootDir, workspace);
  const tscPath = resolve(rootDir, 'node_modules', '.bin', 'tsc');
  try {
    execSync(`"${tscPath}"`, { cwd, stdio: 'inherit' });
  } catch (err) {
    process.exit(err.status ?? 1);
  }
}

/**
 * Removes the dist directory for a workspace.
 *
 * @param workspace - Workspace directory name relative to root.
 */
function cleanWorkspace(workspace) {
  rmSync(resolve(rootDir, workspace, 'dist'), { recursive: true, force: true });
}

/**
 * Builds the SolidJS dashboard client via Vite. The client is not a workspace
 * member (it has its own node_modules driven by a file: dep on shared), so
 * we invoke `npm run build` inside `web/client/` through the shell. If
 * `web/client/node_modules/` is absent, bootstrap with `npm ci` first.
 */
function buildWebClient() {
  const cwd = resolve(rootDir, 'web', 'client');
  try {
    if (!existsSync(join(cwd, 'node_modules'))) {
      console.log('[build] web/client: installing dependencies (npm ci)...');
      execSync('npm ci', { cwd, stdio: 'inherit', shell: true });
    }
    rmSync(resolve(cwd, 'dist'), { recursive: true, force: true });
    execSync('npm run build', { cwd, stdio: 'inherit', shell: true });
  } catch (err) {
    process.exit(err.status ?? 1);
  }
}

console.log('[build] Step 1: Build shared...');
cleanWorkspace('shared');
buildWorkspace('shared');

console.log('[build] Step 2: Build resolver...');
cleanWorkspace('resolver');
buildWorkspace('resolver');

console.log('[build] Step 3: Build web...');
cleanWorkspace('web');
buildWorkspace('web');

console.log('[build] Step 3b: Build web client (Vite)...');
buildWebClient();

console.log('[build] Step 4: Build facilitator...');
cleanWorkspace('facilitator');
buildWorkspace('facilitator');

console.log('[build] Step 5: Build cli...');
cleanWorkspace('cli');
buildWorkspace('cli');

console.log('[build] All packages built successfully.');
