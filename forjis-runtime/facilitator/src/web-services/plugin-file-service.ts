/**
 * Plugin file content service implementation for the web dashboard backend.
 *
 * Serves `.md` files from a whitelist of plugin root directories with three
 * layers of path traversal protection:
 *   1. Reject raw queries containing `..` or an absolute path (400).
 *   2. Verify the resolved candidate path stays within a whitelisted root.
 *   3. After realpath resolution, re-verify prefix match to block symlink escape (400).
 */

import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import type { PluginFileService, PluginFileResult } from '@forjis/shared';

/**
 * Implements PluginFileService against a fixed list of plugin root paths.
 *
 * The plugin root whitelist comes from the resolver's ResourceRegistry. Each
 * entry is an absolute path to a resolved repository's cache directory.
 */
export class PluginFileServiceImpl implements PluginFileService {
  /**
   * Creates a PluginFileServiceImpl.
   *
   * @param pluginRoots - Absolute paths of allowed plugin root directories.
   */
  constructor(private readonly pluginRoots: readonly string[]) {}

  /**
   * Resolves `relativePath` against each plugin root, returning file content
   * when a whitelisted root owns the file, a traversal marker when the path
   * is rejected, or a notFound marker when no root contains the file.
   *
   * @param relativePath - The requested plugin-root relative path.
   * @returns A discriminated PluginFileResult.
   */
  async getPluginFile(relativePath: string): Promise<PluginFileResult> {
    if (!relativePath || relativePath.includes('..')) {
      return { kind: 'traversal' };
    }
    if (isAbsolute(relativePath)) {
      return { kind: 'traversal' };
    }

    let sawEscape = false;

    for (const root of this.pluginRoots) {
      const absRoot = resolve(root);
      const candidate = resolve(absRoot, relativePath);

      if (candidate !== absRoot && !candidate.startsWith(absRoot + sep)) {
        continue;
      }

      let realFull: string;
      let realRoot: string;
      try {
        realFull = await realpath(candidate);
        realRoot = await realpath(absRoot);
      } catch {
        continue;
      }

      if (realFull !== realRoot && !realFull.startsWith(realRoot + sep)) {
        sawEscape = true;
        continue;
      }

      try {
        const content = await readFile(realFull, 'utf-8');
        return { kind: 'ok', content };
      } catch {
        continue;
      }
    }

    return sawEscape ? { kind: 'traversal' } : { kind: 'notFound' };
  }
}
