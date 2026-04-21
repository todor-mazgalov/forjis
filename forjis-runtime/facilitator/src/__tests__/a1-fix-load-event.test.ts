/**
 * Unit tests for task a1-fix-load-event.
 *
 * Verifies:
 *   - FR-001: Facilitator does not write load events (buildLoadEventContent removed)
 *   - FR-005: Facilitator has no load event knowledge
 *   - FR-002: Orchestrator injects load event prompt in all four mode files
 *   - FR-003: Agent writes load event as first action (mandatory first action template)
 *   - FR-004: Load event in role-scoped file (slug routing)
 *
 * All tests are pure source-file inspection tests. No infrastructure required.
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
// facilitator/src/__tests__/a1-fix-load-event.test.ts
// -> facilitator/src/__tests__
// -> facilitator/src
// -> facilitator
// -> forjis-runtime
const facilitatorRoot = dirname(dirname(dirname(thisFile)));
const runtimeRoot = dirname(facilitatorRoot);
const commandsDir = join(runtimeRoot, 'orchestrator', '.claude', 'commands');

// ---------------------------------------------------------------------------
// FR-001, FR-005: Facilitator load event removal — run.ts
// ---------------------------------------------------------------------------

describe('FR-001/FR-005: run.ts — load event logic removed', () => {
  let runTs: string;

  beforeAll(async () => {
    runTs = await readFile(
      join(facilitatorRoot, 'src', 'commands', 'run.ts'),
      'utf-8',
    );
  });

  it('buildLoadEventContent function does not exist in run.ts', () => {
    /** Verifies FR-001: facilitator no longer defines buildLoadEventContent */
    expect(runTs).not.toContain('buildLoadEventContent');
  });

  it('no appendEvent call with type: load exists before engine.invoke()', () => {
    /** Verifies FR-001: no static load event append before invocation */
    expect(runTs).not.toContain("type: 'load'");
    expect(runTs).not.toContain('type: "load"');
  });

  it('appendEvent import is still present (used by onEvent callback)', () => {
    /** Verifies regression guard: appendEvent still needed for stream events */
    expect(runTs).toContain("from '../web-services/event-writer.js'");
    expect(runTs).toContain('appendEvent');
  });

  it('engine.invoke() is called without a preceding load event block', () => {
    /** Verifies FR-001: engine.invoke path has no load event logic */
    // The only appendEvent call should be inside onEvent callback
    // Count occurrences of 'appendEvent(' to ensure there's only one (in onEvent)
    const appendEventMatches = runTs.match(/appendEvent\s*\(/g) ?? [];
    expect(appendEventMatches.length).toBe(1);
  });

  it('onEvent callback still uses appendEvent for stream events', () => {
    /** Verifies regression: existing stream event routing is unchanged */
    // The onEvent callback should contain appendEvent call
    // onEvent callback is defined as a named variable containing appendEvent
    expect(runTs).toContain('onEvent');
    // appendEvent is called within the onEvent callback body
    const appendEventIdx = runTs.indexOf('appendEvent(');
    expect(appendEventIdx).toBeGreaterThan(-1);
    // The onEvent shorthand property is passed to engine.invoke
    const onEventShorthand = runTs.indexOf('onEvent,');
    expect(onEventShorthand).toBeGreaterThan(-1);
  });
});

// ---------------------------------------------------------------------------
// FR-002, FR-003, FR-004: ORG Mode — load event injection in Step 8
// ---------------------------------------------------------------------------

describe('FR-002/FR-003/FR-004: forjis-org-mode.md — load event injection', () => {
  let orgMode: string;

  beforeAll(async () => {
    orgMode = await readFile(join(commandsDir, 'forjis-org-mode.md'), 'utf-8');
  });

  it('old facilitator load event note is removed', () => {
    /** Verifies FR-002: no reference to facilitator handling load events */
    expect(orgMode).not.toContain('Load events are now written automatically by the facilitator');
    expect(orgMode).not.toContain('Do NOT write load events via Bash echo');
    expect(orgMode).not.toContain('the facilitator handles this');
  });

  it('Step 8 contains sub-step 7 with load event injection instructions', () => {
    /** Verifies FR-002: new sub-step 7 added in Step 8 */
    expect(orgMode).toContain('7. Inject the load event prompt section');
  });

  it('injected prompt section is titled "Load Event (mandatory first action)"', () => {
    /** Verifies FR-003: mandatory first action instruction present */
    expect(orgMode).toContain('## Load Event (mandatory first action)');
  });

  it('injected prompt template uses mkdir -p before echo', () => {
    /** Verifies FR-003: queue directory is created before writing */
    expect(orgMode).toContain('mkdir -p');
  });

  it('injected prompt template uses append operator (>>), not overwrite (>)', () => {
    /** Verifies FR-003: JSONL file is appended to, not overwritten */
    // The template line should have >> and not a bare > (excluding >>)
    expect(orgMode).toContain('>>');
    const templateLine = orgMode.split('\n').find(l => l.includes('mkdir -p') && l.includes('echo'));
    expect(templateLine).toBeDefined();
    expect(templateLine).toContain('>>');
  });

  it('injected prompt template includes type: load in JSON shape', () => {
    /** Verifies FR-003, dashboard compat: event type field is "load" */
    expect(orgMode).toContain('"type":"load"');
  });

  it('injected prompt template routes to events-<SLUG>.jsonl', () => {
    /** Verifies FR-004: role-scoped event file routing */
    expect(orgMode).toContain('events-<SLUG>.jsonl');
  });

  it('instructions describe LOADED_RESOURCES pipe-separated format', () => {
    /** Verifies FR-003: agent knows what to write in content field */
    expect(orgMode).toContain('pipe-separated');
    expect(orgMode).toContain('agent:');
    expect(orgMode).toContain('skills:');
    expect(orgMode).toContain('hooks:');
    expect(orgMode).toContain('expertise:');
    expect(orgMode).toContain('constraints:');
  });

  it('instructions say orchestrator pre-computes SLUG', () => {
    /** Verifies FR-004: SLUG is pre-computed as lowercase team-role slug */
    expect(orgMode).toContain('pre-computed');
    expect(orgMode).toContain('<SLUG>');
  });

  it('load event section is after constraints (final section)', () => {
    /** Verifies design decision D2: load event appended last */
    const taskConstraintsIdx = orgMode.lastIndexOf('## Task Constraints');
    const loadEventIdx = orgMode.lastIndexOf('## Load Event (mandatory first action)');
    expect(loadEventIdx).toBeGreaterThan(taskConstraintsIdx);
  });

  it('instructions mark load event as mandatory with Do not skip', () => {
    /** Verifies FR-003: agent cannot skip load event */
    expect(orgMode).toContain('mandatory');
    expect(orgMode).toContain('Do not skip this step');
  });
});

// ---------------------------------------------------------------------------
// FR-002, FR-003, FR-004: Independent Mode — load event injection
// ---------------------------------------------------------------------------

describe('FR-002/FR-003/FR-004: forjis-independent-mode.md — load event injection', () => {
  let independentMode: string;

  beforeAll(async () => {
    independentMode = await readFile(
      join(commandsDir, 'forjis-independent-mode.md'),
      'utf-8',
    );
  });

  it('contains a "Load Event Injection" subsection', () => {
    /** Verifies FR-002: independent mode has load event injection instructions */
    expect(independentMode).toContain('### Load Event Injection');
  });

  it('Load Event Injection section is under Agent Invocation', () => {
    /** Verifies FR-002: section is part of the Agent Invocation execution flow */
    const agentInvocationIdx = independentMode.indexOf('### Agent Invocation');
    const loadEventIdx = independentMode.indexOf('### Load Event Injection');
    expect(agentInvocationIdx).toBeGreaterThan(-1);
    expect(loadEventIdx).toBeGreaterThan(agentInvocationIdx);
  });

  it('specifies "default" as team slug for --raw mode agents', () => {
    /** Verifies FR-004: raw mode agents use default team slug */
    expect(independentMode).toContain('"default"');
    expect(independentMode).toContain('--raw');
  });

  it('injected prompt section matches ORG mode format', () => {
    /** Verifies FR-002: consistent load event template across modes */
    expect(independentMode).toContain('## Load Event (mandatory first action)');
    expect(independentMode).toContain('"type":"load"');
    expect(independentMode).toContain('mkdir -p');
    expect(independentMode).toContain('>>');
    expect(independentMode).toContain('Do not skip this step');
  });

  it('load event section appended as final section of composed prompt', () => {
    /** Verifies design decision D2: final section after all constraints */
    // The text may wrap across lines — check for the key phrase
    expect(independentMode).toContain('the final');
    expect(independentMode).toContain('section of the composed prompt (after all constraints)');
  });
});

// ---------------------------------------------------------------------------
// FR-002, FR-003, FR-004: Fallback Mode — load event injection
// ---------------------------------------------------------------------------

describe('FR-002/FR-003/FR-004: forjis-fallback-mode.md — load event injection', () => {
  let fallbackMode: string;

  beforeAll(async () => {
    fallbackMode = await readFile(
      join(commandsDir, 'forjis-fallback-mode.md'),
      'utf-8',
    );
  });

  it('contains a "Load Event Injection" subsection', () => {
    /** Verifies FR-002: fallback mode has load event injection instructions */
    expect(fallbackMode).toContain('### Load Event Injection');
  });

  it('Load Event Injection section is within Constraint Injection section', () => {
    /** Verifies FR-002: section placed in constraint injection area */
    const constraintInjectionIdx = fallbackMode.indexOf('## Constraint Injection');
    const loadEventIdx = fallbackMode.indexOf('### Load Event Injection');
    expect(constraintInjectionIdx).toBeGreaterThan(-1);
    expect(loadEventIdx).toBeGreaterThan(constraintInjectionIdx);
  });

  it('specifies "default" as team slug', () => {
    /** Verifies FR-004, design D5: fallback mode uses default team slug */
    expect(fallbackMode).toContain('"default"');
  });

  it('uses agent stage name as role slug', () => {
    /** Verifies FR-004, design D5: stage names used as role slugs */
    // Should mention stage names for slug computation
    expect(fallbackMode).toContain('"explorer"');
    expect(fallbackMode).toContain('"analyst"');
  });

  it('event file uses events-default-<STAGE>.jsonl naming', () => {
    /** Verifies FR-004: fallback mode event files follow naming convention */
    expect(fallbackMode).toContain('events-default-<STAGE>.jsonl');
  });

  it('injected prompt section matches ORG mode format', () => {
    /** Verifies FR-002: consistent load event template across modes */
    expect(fallbackMode).toContain('## Load Event (mandatory first action)');
    expect(fallbackMode).toContain('"type":"load"');
    expect(fallbackMode).toContain('mkdir -p');
    expect(fallbackMode).toContain('>>');
    expect(fallbackMode).toContain('Do not skip this step');
  });

  it('injection applies to every agent in Phases 1-5', () => {
    /** Verifies FR-002: all pipeline agents receive load event injection */
    expect(fallbackMode).toContain('Phases 1-5');
  });
});

// ---------------------------------------------------------------------------
// FR-002: Swarm Mode — no facilitator load event references
// ---------------------------------------------------------------------------

describe('FR-002: forjis-swarm-mode.md — no facilitator load event references', () => {
  let swarmMode: string;

  beforeAll(async () => {
    swarmMode = await readFile(
      join(commandsDir, 'forjis-swarm-mode.md'),
      'utf-8',
    );
  });

  it('no reference to facilitator writing load events', () => {
    /** Verifies FR-002: swarm mode does not document facilitator load event handling */
    expect(swarmMode).not.toContain('Load events are now written automatically by the facilitator');
    expect(swarmMode).not.toContain('facilitator handles');
    expect(swarmMode).not.toContain('Do NOT write load events via Bash echo');
  });

  it('swarm mode still inherits ORG mode via base behavior reference', () => {
    /** Verifies FR-002: swarm mode inherits Step 8 load event injection from ORG mode */
    expect(swarmMode).toContain('forjis-org-mode.md');
    // It should reference Steps 6-9 which includes Step 8 (load context)
    expect(swarmMode).toContain('Steps 6-9');
  });
});

// ---------------------------------------------------------------------------
// Prompt template correctness
// ---------------------------------------------------------------------------

describe('Prompt template correctness — all mode files', () => {
  const modeFiles = [
    'forjis-org-mode.md',
    'forjis-independent-mode.md',
    'forjis-fallback-mode.md',
  ];

  for (const modeFile of modeFiles) {
    describe(`${modeFile}`, () => {
      let content: string;

      beforeAll(async () => {
        content = await readFile(join(commandsDir, modeFile), 'utf-8');
      });

      it('load event JSON template has required fields: timestamp, type, role, content', () => {
        /** Verifies dashboard compat: TaskEvent shape preserved */
        expect(content).toContain('"timestamp"');
        expect(content).toContain('"type":"load"');
        expect(content).toContain('"role"');
        expect(content).toContain('"content"');
      });

      it('template uses CURRENT_ISO_TIMESTAMP placeholder with replacement instruction', () => {
        /** Verifies FR-003: agent fills in real timestamp at execution time */
        expect(content).toContain('<CURRENT_ISO_TIMESTAMP>');
        expect(content).toContain('Replace <CURRENT_ISO_TIMESTAMP>');
      });

      it('template includes mandatory first action instruction', () => {
        /** Verifies FR-003: agent cannot defer or skip load event */
        expect(content).toContain('mandatory first action');
      });
    });
  }
});
