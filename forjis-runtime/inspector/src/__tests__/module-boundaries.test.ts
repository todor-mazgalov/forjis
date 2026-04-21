/**
 * Static-scan tests enforcing NFR-011-002 module boundaries.
 *
 * The UI modules (`ui/clarify-panel`, `ui/sidebar`, `reply/reply-detect`,
 * `reply/reply-sheet`, `reply/reply-banner`) and the history-store pair
 * (`history/history-store`, `history/storage`) MUST NOT statically import
 * `transport.ts`, `mount.ts`, or any module that constructs a `WebSocket`.
 * All outbound traffic flows through caller-supplied callbacks in
 * `mount.ts`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Files subject to the boundary scan. */
const ISOLATED_MODULES: readonly string[] = [
  'src/ui/clarify-panel.ts',
  'src/ui/sidebar.ts',
  'src/reply/reply-detect.ts',
  'src/reply/reply-sheet.ts',
  'src/reply/reply-banner.ts',
  'src/history/history-store.ts',
  'src/history/storage.ts',
];

describe('module boundaries (NFR-011-002)', () => {
  for (const relPath of ISOLATED_MODULES) {
    it(relPath + ' contains no transport / mount / WebSocket imports', () => {
      const source = fs.readFileSync(
        path.resolve(process.cwd(), relPath),
        'utf-8',
      );
      // No import from transport.
      expect(/from\s+['"][^'"]*transport/.test(source)).toBe(false);
      // No import from mount.
      expect(/from\s+['"][^'"]*mount/.test(source)).toBe(false);
      // No `new WebSocket(`.
      expect(/new\s+WebSocket\s*\(/.test(source)).toBe(false);
    });
  }
});
