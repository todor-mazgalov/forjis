/**
 * Unit tests for strategist command handler (post-thinning).
 *
 * Requirements validated:
 *   - strategistRunCommand delegates to orchestrator via engine.invoke()
 *   - No prompt composition in the facilitator
 *   - snapshotTaskFiles and countNewTaskFiles are retained for loop mode
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// -- Delegation behavior --

describe('strategistRunCommand -- delegation', () => {
  let source: string;

  beforeAll(async () => {
    const thisFile = fileURLToPath(import.meta.url);
    const stratPath = join(dirname(dirname(thisFile)), 'strategist.ts');
    source = await readFile(stratPath, 'utf-8');
  });

  it('strategist.ts imports resolve from @forjis/resolver', () => {
    expect(source).toContain("from '@forjis/resolver'");
  });

  it('strategist.ts does not contain composeStrategistPrompt', () => {
    expect(source).not.toContain('composeStrategistPrompt');
  });

  it('strategist.ts does not contain engine.prompt(', () => {
    expect(source).not.toContain('engine.prompt(');
  });

  it('strategist.ts does not import from local build-file module', () => {
    expect(source).not.toContain("from '../build-file.js'");
  });

  it('strategist.ts calls engine.invoke with mode strategist', () => {
    expect(source).toContain("mode: 'strategist'");
  });

  it('strategist.ts retains snapshotTaskFiles for loop mode', () => {
    expect(source).toContain('snapshotTaskFiles');
  });

  it('strategist.ts retains countNewTaskFiles for loop mode', () => {
    expect(source).toContain('countNewTaskFiles');
  });
});
