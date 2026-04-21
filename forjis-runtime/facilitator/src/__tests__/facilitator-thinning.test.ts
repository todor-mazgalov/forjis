/**
 * Reviewer tests for the facilitator-thinning stream.
 *
 * Stream: facilitator-thinning / Change: redesign-v5
 * Reviewer: Fullstack Reviewer Agent
 * Date: 2026-03-31
 *
 * Requirements validated:
 *   FR-014  run.ts calls resolver.resolve() as first step
 *   FR-015  No prompt composition in facilitator
 *   FR-016  Engine invoke receives configDir (not runtimeConfig/registry)
 *   FR-031  persona.ts delegates to orchestrator with mode:'persona'
 *   FR-032  strategist.ts delegates to orchestrator with mode:'strategist'
 *   FR-033  assess.ts delegates to orchestrator with mode:'assess'; retains state validation
 *   NFR-002 Backward-compatible re-exports from @forjis/resolver
 *   FR-004  Deleted source files (build-file, plugin-compositor, etc.) not present in facilitator
 *
 * All tests are pure source-file inspection tests. No infrastructure required.
 */

import { readFile, access } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const thisFile = fileURLToPath(import.meta.url);
// facilitator/src/__tests__/facilitator-thinning.test.ts
// -> facilitator/src/__tests__
// -> facilitator/src
// -> facilitator
const facilitatorRoot = dirname(dirname(dirname(thisFile)));

// ---------------------------------------------------------------------------
// Section 1: Engine interface changes (FR-014, NFR-002)
// ---------------------------------------------------------------------------

describe('Engine interface: no prepare(), configDir required (FR-014)', () => {
  let engineSrc: string;

  beforeAll(async () => {
    engineSrc = await readFile(join(facilitatorRoot, 'src', 'engine.ts'), 'utf-8');
  });

  it('ForjisEngine interface does not contain prepare()', () => {
    /** Verifies FR-014: prepare() removed from interface */
    // Check the interface block - should not have prepare
    const interfaceBlock = engineSrc.slice(
      engineSrc.indexOf('export interface ForjisEngine'),
      engineSrc.indexOf('export interface ForjisEngine') + 800,
    );
    expect(interfaceBlock).not.toContain('prepare(');
  });

  it('EngineInvokeOptions has configDir field', () => {
    /** Verifies FR-014: configDir replaces runtimeConfig+registry */
    expect(engineSrc).toContain('configDir: string');
  });

  it('EngineInvokeOptions does NOT have runtimeConfig field', () => {
    /** Verifies FR-014: runtimeConfig removed from EngineInvokeOptions */
    expect(engineSrc).not.toContain('runtimeConfig');
  });

  it('EngineInvokeOptions does NOT have registry field', () => {
    /** Verifies FR-014: registry removed from EngineInvokeOptions */
    // Look only at the EngineInvokeOptions interface, not the full file
    const optionsBlock = engineSrc.slice(
      engineSrc.indexOf('export interface EngineInvokeOptions'),
      engineSrc.indexOf('export interface EngineInvokeOptions') + 600,
    );
    expect(optionsBlock).not.toContain('registry');
  });

  it('EngineInvokeOptions has optional mode field', () => {
    /** Verifies FR-031/FR-032/FR-033: mode field for orchestrator dispatch */
    expect(engineSrc).toContain('mode?: string');
  });

  it('EngineInvokeOptions has optional modeArgs field', () => {
    /** Verifies FR-031/FR-032/FR-033: modeArgs field for mode-specific data */
    expect(engineSrc).toContain('modeArgs?: Record<string, unknown>');
  });

  it('ForjisEngine interface does NOT export PrepareResult', () => {
    /** Verifies FR-014: PrepareResult removed from engine.ts */
    expect(engineSrc).not.toContain('PrepareResult');
  });

  it('ForjisEngine interface does NOT export ResolvedResource', () => {
    /** Verifies FR-014: ResolvedResource removed from engine.ts */
    expect(engineSrc).not.toContain('ResolvedResource');
  });
});

// ---------------------------------------------------------------------------
// Section 2: run.ts uses resolver (FR-014, FR-016)
// ---------------------------------------------------------------------------

describe('run.ts: uses resolver.resolve() and passes configDir (FR-014, FR-016)', () => {
  let runSrc: string;

  beforeAll(async () => {
    runSrc = await readFile(join(facilitatorRoot, 'src', 'commands', 'run.ts'), 'utf-8');
  });

  it('run.ts imports resolve from @forjis/resolver', () => {
    /** Verifies FR-014: resolver is imported at top of run.ts */
    expect(runSrc).toContain("from '@forjis/resolver'");
    expect(runSrc).toContain('resolve');
  });

  it('run.ts does NOT import from local build-file module', () => {
    /** Verifies FR-014: no direct build-file.js import */
    expect(runSrc).not.toContain("from '../build-file.js'");
    expect(runSrc).not.toContain("from './build-file.js'");
  });

  it('run.ts does NOT import from local plugin-compositor module', () => {
    /** Verifies FR-014: no direct plugin-compositor.js import */
    expect(runSrc).not.toContain("from '../plugin-compositor.js'");
    expect(runSrc).not.toContain("from './plugin-compositor.js'");
  });

  it('run.ts does NOT import from local resource-resolver module', () => {
    /** Verifies FR-014: no direct resource-resolver.js import */
    expect(runSrc).not.toContain("from '../resource-resolver.js'");
  });

  it('run.ts does NOT import from local repo module', () => {
    /** Verifies FR-014: no direct repo/index.js import */
    expect(runSrc).not.toContain("from '../repo/");
  });

  it('run.ts does NOT import from local lock-file module', () => {
    /** Verifies FR-014: no direct lock-file.js import */
    expect(runSrc).not.toContain("from '../lock-file.js'");
  });

  it('run.ts does NOT call engine.prepare()', () => {
    /** Verifies FR-014: prepare() call removed */
    expect(runSrc).not.toContain('engine.prepare(');
    expect(runSrc).not.toContain('.prepare(');
  });

  it('run.ts calls resolveConfig or resolve', () => {
    /** Verifies FR-014: resolver is actually invoked */
    const hasResolveCall = runSrc.includes('resolveConfig(') || runSrc.includes('await resolve(');
    expect(hasResolveCall).toBe(true);
  });

  it('run.ts passes configDir to engine.invoke', () => {
    /** Verifies FR-016: engine receives configDir, not runtimeConfig */
    expect(runSrc).toContain('configDir:');
    expect(runSrc).not.toContain('runtimeConfig:');
    expect(runSrc).not.toContain('registry:');
  });

  it('run.ts reads tasks.yaml from configDir', () => {
    /** Verifies FR-016: task config read from resolved config directory */
    expect(runSrc).toContain('tasks.yaml');
    expect(runSrc).toContain('readYamlFile');
  });

  it('run.ts reads token-budget.yaml from configDir', () => {
    /** Verifies FR-016: token budget read from resolved config directory */
    expect(runSrc).toContain('token-budget.yaml');
  });

  it('run.ts reads health-check.yaml from configDir', () => {
    /** Verifies FR-016: health check config read from resolved config directory */
    expect(runSrc).toContain('health-check.yaml');
  });
});

// ---------------------------------------------------------------------------
// Section 3: persona.ts delegates (FR-031, FR-015)
// ---------------------------------------------------------------------------

describe('persona.ts: delegates to orchestrator (FR-031, FR-015)', () => {
  let personaSrc: string;

  beforeAll(async () => {
    personaSrc = await readFile(join(facilitatorRoot, 'src', 'commands', 'persona.ts'), 'utf-8');
  });

  it('persona.ts imports resolve from @forjis/resolver', () => {
    /** Verifies FR-031: resolver is used before engine.invoke */
    expect(personaSrc).toContain("from '@forjis/resolver'");
  });

  it('persona.ts does NOT contain composePersonaPrompt', () => {
    /** Verifies FR-015: prompt composition removed from facilitator */
    expect(personaSrc).not.toContain('composePersonaPrompt');
  });

  it('persona.ts does NOT call engine.prompt(', () => {
    /** Verifies FR-031: only engine.invoke() is used, not engine.prompt() */
    expect(personaSrc).not.toContain('engine.prompt(');
  });

  it('persona.ts does NOT import from local build-file module', () => {
    /** Verifies FR-031: no direct parseBuildFile import from local module */
    expect(personaSrc).not.toContain("from '../build-file.js'");
  });

  it('persona.ts calls engine.invoke with mode persona', () => {
    /** Verifies FR-031: orchestrator receives mode parameter */
    expect(personaSrc).toContain("mode: 'persona'");
  });

  it('persona.ts passes configDir to engine.invoke', () => {
    /** Verifies FR-031: engine receives configDir from resolver output */
    expect(personaSrc).toContain('configDir:');
    expect(personaSrc).not.toContain('runtimeConfig:');
  });

  it('persona.ts does NOT contain dispatchPersonas', () => {
    /** Verifies FR-031: direct persona dispatch removed */
    expect(personaSrc).not.toContain('dispatchPersonas');
  });

  it('persona.ts does NOT contain loadBaseAgentFile', () => {
    /** Verifies FR-031: agent file loading removed from facilitator */
    expect(personaSrc).not.toContain('loadBaseAgentFile');
  });

  it('persona.ts does NOT contain loadConstraints', () => {
    /** Verifies FR-031: constraint loading removed from facilitator */
    expect(personaSrc).not.toContain('loadConstraints');
  });

  it('personaCreateCommand reads persona dir from .forjis/config/personas.yaml', () => {
    /** Verifies FR-031: create command reads from resolved config */
    expect(personaSrc).toContain('personas.yaml');
  });

  it('persona.ts does NOT import parseBuildFile from a local module', () => {
    /** Verifies FR-031: parseBuildFile only allowed from @forjis/resolver, not local */
    expect(personaSrc).not.toContain("from '../build-file.js'");
    // If parseBuildFile appears, it must be from @forjis/resolver only
    if (personaSrc.includes('parseBuildFile')) {
      expect(personaSrc).toContain('@forjis/resolver');
    }
  });
});

// ---------------------------------------------------------------------------
// Section 4: strategist.ts delegates (FR-032, FR-015)
// ---------------------------------------------------------------------------

describe('strategist.ts: delegates to orchestrator (FR-032, FR-015)', () => {
  let strategistSrc: string;

  beforeAll(async () => {
    strategistSrc = await readFile(join(facilitatorRoot, 'src', 'commands', 'strategist.ts'), 'utf-8');
  });

  it('strategist.ts imports resolve from @forjis/resolver', () => {
    /** Verifies FR-032: resolver is used before engine.invoke */
    expect(strategistSrc).toContain("from '@forjis/resolver'");
  });

  it('strategist.ts does NOT contain composeStrategistPrompt', () => {
    /** Verifies FR-015: prompt composition removed from facilitator */
    expect(strategistSrc).not.toContain('composeStrategistPrompt');
  });

  it('strategist.ts does NOT call engine.prompt(', () => {
    /** Verifies FR-032: only engine.invoke() is used, not engine.prompt() */
    expect(strategistSrc).not.toContain('engine.prompt(');
  });

  it('strategist.ts calls engine.invoke with mode strategist', () => {
    /** Verifies FR-032: orchestrator receives mode parameter */
    expect(strategistSrc).toContain("mode: 'strategist'");
  });

  it('strategist.ts passes configDir to engine.invoke', () => {
    /** Verifies FR-032: engine receives configDir from resolver output */
    expect(strategistSrc).toContain('configDir:');
    expect(strategistSrc).not.toContain('runtimeConfig:');
  });

  it('strategist.ts retains snapshotTaskFiles for loop mode', () => {
    /** Verifies FR-032: loop mode file counting utilities retained */
    expect(strategistSrc).toContain('snapshotTaskFiles');
  });

  it('strategist.ts retains countNewTaskFiles for loop mode', () => {
    /** Verifies FR-032: loop mode file counting utilities retained */
    expect(strategistSrc).toContain('countNewTaskFiles');
  });

  it('strategist.ts standalone mode invokes with mode standalone', () => {
    /** Verifies FR-032: standalone scan delegated to orchestrator */
    expect(strategistSrc).toContain("mode: 'standalone'");
  });

  it('strategist.ts loop mode invokes with mode loop', () => {
    /** Verifies FR-032: loop scan delegated to orchestrator per cycle */
    expect(strategistSrc).toContain("mode: 'loop'");
  });
});

// ---------------------------------------------------------------------------
// Section 5: assess.ts delegates (FR-033)
// ---------------------------------------------------------------------------

describe('assess.ts: delegates to orchestrator (FR-033)', () => {
  let assessSrc: string;

  beforeAll(async () => {
    assessSrc = await readFile(join(facilitatorRoot, 'src', 'commands', 'assess.ts'), 'utf-8');
  });

  it('assess.ts imports resolve from @forjis/resolver', () => {
    /** Verifies FR-033: resolver is used before engine.invoke */
    expect(assessSrc).toContain("from '@forjis/resolver'");
  });

  it('assess.ts does NOT import from local build-file module', () => {
    /** Verifies FR-033: no local build-file.js import */
    expect(assessSrc).not.toContain("from '../build-file.js'");
  });

  it('assess.ts does NOT call resolveRepositories()', () => {
    /** Verifies FR-033: full resolution pipeline removed */
    expect(assessSrc).not.toContain('resolveRepositories(');
  });

  it('assess.ts does NOT call loadPlugins()', () => {
    /** Verifies FR-033: plugin loading removed */
    expect(assessSrc).not.toContain('loadPlugins(');
  });

  it('assess.ts does NOT call loadBuildFile()', () => {
    /** Verifies FR-033: no direct build file reading (except via resolver) */
    // Direct static import should not exist; dynamic import via resolver is ok
    expect(assessSrc).not.toContain("import { loadBuildFile }");
    expect(assessSrc).not.toContain("from '../build-file.js'");
  });

  it('assess.ts calls engine.invoke with mode assess', () => {
    /** Verifies FR-033: orchestrator receives mode parameter */
    expect(assessSrc).toContain("mode: 'assess'");
  });

  it('assess.ts passes configDir to engine.invoke', () => {
    /** Verifies FR-033: engine receives configDir from resolver output */
    expect(assessSrc).toContain('configDir:');
    expect(assessSrc).not.toContain('runtimeConfig:');
  });

  it('assess.ts retains TaskNotFoundError usage', () => {
    /** Verifies FR-033: task state validation is retained */
    expect(assessSrc).toContain('TaskNotFoundError');
  });

  it('assess.ts retains TaskInvalidStateError usage', () => {
    /** Verifies FR-033: task state validation is retained */
    expect(assessSrc).toContain('TaskInvalidStateError');
  });

  it('assess.ts retains TaskQueue usage for state validation', () => {
    /** Verifies FR-033: task queue used to validate state before assessment */
    expect(assessSrc).toContain('TaskQueue');
    expect(assessSrc).toContain('getState');
  });
});

// ---------------------------------------------------------------------------
// Section 6: claude-engine.ts simplified (FR-014)
// ---------------------------------------------------------------------------

describe('claude-engine.ts: prepare() and config writing removed (FR-014)', () => {
  let claudeEngineSrc: string;

  beforeAll(async () => {
    claudeEngineSrc = await readFile(
      join(facilitatorRoot, 'src', 'engines', 'claude', 'claude-engine.ts'),
      'utf-8',
    );
  });

  it('claude-engine.ts does NOT contain a prepare() method', () => {
    /** Verifies FR-014: prepare() removed from ClaudeEngine */
    // Check for method definition, not any mention of the word
    expect(claudeEngineSrc).not.toContain('async prepare(');
    expect(claudeEngineSrc).not.toContain('prepare(resources');
  });

  it('claude-engine.ts does NOT contain writeOutcomeConfig', () => {
    /** Verifies FR-014: outcome config writing removed (delegated to resolver) */
    expect(claudeEngineSrc).not.toContain('writeOutcomeConfig');
  });

  it('claude-engine.ts does NOT contain writeConstraintsConfig', () => {
    /** Verifies FR-014: constraints config writing removed (delegated to resolver) */
    expect(claudeEngineSrc).not.toContain('writeConstraintsConfig');
  });

  it('claude-engine.ts does NOT contain buildOrgsYaml', () => {
    /** Verifies FR-014: YAML builder functions removed */
    expect(claudeEngineSrc).not.toContain('buildOrgsYaml');
  });

  it('claude-engine.ts does NOT contain buildOrgEntry', () => {
    /** Verifies FR-014: YAML builder functions removed */
    expect(claudeEngineSrc).not.toContain('buildOrgEntry');
  });

  it('claude-engine.ts does NOT contain buildTeamEntry', () => {
    /** Verifies FR-014: YAML builder functions removed */
    expect(claudeEngineSrc).not.toContain('buildTeamEntry');
  });

  it('claude-engine.ts does NOT contain buildRoleEntry', () => {
    /** Verifies FR-014: YAML builder functions removed */
    expect(claudeEngineSrc).not.toContain('buildRoleEntry');
  });

  it('claude-engine.ts does NOT contain buildResourceLookup', () => {
    /** Verifies FR-014: resource lookup function removed */
    expect(claudeEngineSrc).not.toContain('buildResourceLookup');
  });

  it('claude-engine.ts does NOT import from engine-cache.js', () => {
    /** Verifies FR-014: engine cache import removed (moved to resolver) */
    expect(claudeEngineSrc).not.toContain("from '../../engine-cache.js'");
    expect(claudeEngineSrc).not.toContain("computeHash");
  });

  it('claude-engine.ts does NOT reference orgs.forjis.yaml', () => {
    /** Verifies FR-014: org YAML file path removed from engine */
    expect(claudeEngineSrc).not.toContain('orgs.forjis.yaml');
  });

  it('claude-engine.ts does NOT reference outcome-config.yaml', () => {
    /** Verifies FR-014: outcome config file path removed from engine */
    expect(claudeEngineSrc).not.toContain('outcome-config.yaml');
  });

  it('claude-engine.ts does NOT reference constraints.forjis.yaml', () => {
    /** Verifies FR-014: constraints file path removed from engine */
    expect(claudeEngineSrc).not.toContain('constraints.forjis.yaml');
  });

  it('claude-engine.ts invoke() uses options.configDir', () => {
    /** Verifies FR-014: invoke reads configDir from options, not runtimeConfig */
    expect(claudeEngineSrc).toContain('options.configDir');
    expect(claudeEngineSrc).not.toContain('options.runtimeConfig');
    expect(claudeEngineSrc).not.toContain('options.registry');
  });
});

// ---------------------------------------------------------------------------
// Section 7: index.ts backward compatibility (NFR-002)
// ---------------------------------------------------------------------------

describe('index.ts: backward-compatible re-exports (NFR-002)', () => {
  let indexSrc: string;

  beforeAll(async () => {
    indexSrc = await readFile(join(facilitatorRoot, 'src', 'index.ts'), 'utf-8');
  });

  it('index.ts re-exports parseBuildFile from @forjis/resolver', () => {
    /** Verifies NFR-002: parseBuildFile backward compat re-export */
    expect(indexSrc).toContain('parseBuildFile');
    expect(indexSrc).toContain("from '@forjis/resolver'");
  });

  it('index.ts re-exports loadBuildFile from @forjis/resolver', () => {
    /** Verifies NFR-002: loadBuildFile backward compat re-export */
    expect(indexSrc).toContain('loadBuildFile');
  });

  it('index.ts re-exports composeRuntime from @forjis/resolver', () => {
    /** Verifies NFR-002: composeRuntime backward compat re-export */
    expect(indexSrc).toContain('composeRuntime');
  });

  it('index.ts re-exports loadPlugins from @forjis/resolver', () => {
    /** Verifies NFR-002: loadPlugins backward compat re-export */
    expect(indexSrc).toContain('loadPlugins');
  });

  it('index.ts re-exports resolveRepositories from @forjis/resolver', () => {
    /** Verifies NFR-002: resolveRepositories backward compat re-export */
    expect(indexSrc).toContain('resolveRepositories');
  });

  it('index.ts re-exports resolve (ConfigResult) from @forjis/resolver', () => {
    /** Verifies NFR-002: resolve function re-exported */
    expect(indexSrc).toContain('resolve,');
  });

  it('index.ts re-exports ConfigResult type from @forjis/resolver', () => {
    /** Verifies NFR-002: config types re-exported */
    expect(indexSrc).toContain('ConfigResult');
  });

  it('index.ts re-exports RuntimeConfig type from @forjis/resolver', () => {
    /** Verifies NFR-002: RuntimeConfig type re-exported */
    expect(indexSrc).toContain('RuntimeConfig');
  });

  it('index.ts does NOT directly export from build-file.js', () => {
    /** Verifies NFR-002: no direct local exports of migrated modules */
    expect(indexSrc).not.toContain("from './build-file.js'");
    expect(indexSrc).not.toContain("from './plugin-compositor.js'");
  });

  it('index.ts does NOT export from repo/index.js', () => {
    /** Verifies NFR-002: repo module removed from facilitator */
    expect(indexSrc).not.toContain("from './repo/index.js'");
    expect(indexSrc).not.toContain("from './repo/");
  });

  it('index.ts does NOT export PrepareResult from engine.ts', () => {
    /** Verifies FR-014: PrepareResult removed from public API */
    // PrepareResult should not be in the local engine exports
    const engineExportBlock = indexSrc.slice(
      indexSrc.indexOf("from './engine.js'"),
      indexSrc.indexOf("from './engine.js'") + 200,
    );
    if (engineExportBlock.length > 0) {
      expect(engineExportBlock).not.toContain('PrepareResult');
    }
  });

  it('index.ts exports ForjisEngine, EngineResult, EngineInvokeOptions from engine.js', () => {
    /** Verifies NFR-002: engine types still exported */
    expect(indexSrc).toContain('ForjisEngine');
    expect(indexSrc).toContain('EngineInvokeOptions');
  });

  it('index.ts still exports facilitator-specific types (TaskState, AssessmentResult, etc.)', () => {
    /** Verifies NFR-002: facilitator-only types remain available */
    expect(indexSrc).toContain('TaskState');
    expect(indexSrc).toContain('AssessmentResult');
    expect(indexSrc).toContain('PromptOptions');
  });
});

// ---------------------------------------------------------------------------
// Section 8: Deleted source files (FR-004)
// ---------------------------------------------------------------------------

describe('Deleted source files: not present in facilitator (FR-004)', () => {
  async function fileExists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  it('build-file.ts does NOT exist in facilitator/src/', async () => {
    /** Verifies FR-004: build-file.ts migrated to resolver */
    const exists = await fileExists(join(facilitatorRoot, 'src', 'build-file.ts'));
    expect(exists).toBe(false);
  });

  it('plugin-compositor.ts does NOT exist in facilitator/src/', async () => {
    /** Verifies FR-004: plugin-compositor.ts migrated to resolver */
    const exists = await fileExists(join(facilitatorRoot, 'src', 'plugin-compositor.ts'));
    expect(exists).toBe(false);
  });

  it('resource-resolver.ts does NOT exist in facilitator/src/', async () => {
    /** Verifies FR-004: resource-resolver.ts migrated to resolver */
    const exists = await fileExists(join(facilitatorRoot, 'src', 'resource-resolver.ts'));
    expect(exists).toBe(false);
  });

  it('engine-cache.ts does NOT exist in facilitator/src/', async () => {
    /** Verifies FR-004: engine-cache.ts migrated to resolver */
    const exists = await fileExists(join(facilitatorRoot, 'src', 'engine-cache.ts'));
    expect(exists).toBe(false);
  });

  it('lock-file.ts does NOT exist in facilitator/src/', async () => {
    /** Verifies FR-004: lock-file.ts migrated to resolver */
    const exists = await fileExists(join(facilitatorRoot, 'src', 'lock-file.ts'));
    expect(exists).toBe(false);
  });

  it('repo/ directory does NOT exist in facilitator/src/', async () => {
    /** Verifies FR-004: repo directory migrated to resolver */
    const exists = await fileExists(join(facilitatorRoot, 'src', 'repo'));
    expect(exists).toBe(false);
  });

  it('build-file.test.ts does NOT exist in facilitator/src/__tests__/', async () => {
    /** Verifies FR-004: test file for migrated module also deleted */
    const exists = await fileExists(join(facilitatorRoot, 'src', '__tests__', 'build-file.test.ts'));
    expect(exists).toBe(false);
  });

  it('plugin-compositor.test.ts does NOT exist in facilitator/src/__tests__/', async () => {
    /** Verifies FR-004: test file for migrated module also deleted */
    const exists = await fileExists(join(facilitatorRoot, 'src', '__tests__', 'plugin-compositor.test.ts'));
    expect(exists).toBe(false);
  });

  it('engine-cache.test.ts does NOT exist in facilitator/src/__tests__/', async () => {
    /** Verifies FR-004: test file for migrated module also deleted */
    const exists = await fileExists(join(facilitatorRoot, 'src', '__tests__', 'engine-cache.test.ts'));
    expect(exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Section 9: No prompt composition in facilitator source (FR-015)
// ---------------------------------------------------------------------------

describe('No prompt composition in facilitator source files (FR-015)', () => {
  const sourceFiles = [
    'commands/run.ts',
    'commands/persona.ts',
    'commands/strategist.ts',
    'commands/assess.ts',
    'engines/claude/claude-engine.ts',
  ];

  for (const sourceFile of sourceFiles) {
    it(`${sourceFile} does not contain composePersonaPrompt or composeStrategistPrompt`, async () => {
      /** Verifies FR-015: prompt composition functions removed from facilitator */
      const src = await readFile(join(facilitatorRoot, 'src', sourceFile), 'utf-8');
      expect(src).not.toContain('composePersonaPrompt');
      expect(src).not.toContain('composeStrategistPrompt');
      expect(src).not.toContain('composeRuntime');
    });
  }
});

// ---------------------------------------------------------------------------
// Section 10: No config file writing in facilitator source (FR-012 from resolver-foundation)
// ---------------------------------------------------------------------------

describe('No config directory writes in facilitator source files (FR-012)', () => {
  const sourceFiles = [
    'commands/run.ts',
    'commands/persona.ts',
    'commands/strategist.ts',
    'commands/assess.ts',
    'engines/claude/claude-engine.ts',
  ];

  for (const sourceFile of sourceFiles) {
    it(`${sourceFile} does not write to .forjis/config/`, async () => {
      /** Verifies FR-012: only resolver writes config files */
      const src = await readFile(join(facilitatorRoot, 'src', sourceFile), 'utf-8');
      // Should not contain writeFile, writeYamlFile, or atomicWriteFile calls targeting config/
      // We check for write operations targeting the config directory
      expect(src).not.toContain("writeFile(join");
      expect(src).not.toContain("'orgs.forjis.yaml'");
      expect(src).not.toContain("'outcome-config.yaml'");
      expect(src).not.toContain("'constraints.forjis.yaml'");
    });
  }
});

// ---------------------------------------------------------------------------
// Section 11: @forjis/resolver dependency in package.json
// ---------------------------------------------------------------------------

describe('@forjis/resolver dependency added to facilitator (NFR-002)', () => {
  it('facilitator package.json includes @forjis/resolver dependency', async () => {
    /** Verifies NFR-002: resolver is a declared dependency */
    const pkgJson = JSON.parse(
      await readFile(join(facilitatorRoot, 'package.json'), 'utf-8')
    ) as Record<string, unknown>;
    const deps = (pkgJson['dependencies'] ?? {}) as Record<string, string>;
    expect(deps['@forjis/resolver']).toBeDefined();
  });

  it('facilitator dist exports parseBuildFile (re-exported from resolver)', async () => {
    /** Verifies NFR-002: backward compat re-export works at runtime */
    const runtimeRoot = dirname(facilitatorRoot);
    const facilitatorDist = join(runtimeRoot, 'facilitator', 'dist', 'index.js');
    const mod = await import(facilitatorDist);
    expect(typeof mod.parseBuildFile).toBe('function');
  });

  it('facilitator dist exports loadBuildFile (re-exported from resolver)', async () => {
    /** Verifies NFR-002: backward compat re-export works at runtime */
    const runtimeRoot = dirname(facilitatorRoot);
    const facilitatorDist = join(runtimeRoot, 'facilitator', 'dist', 'index.js');
    const mod = await import(facilitatorDist);
    expect(typeof mod.loadBuildFile).toBe('function');
  });

  it('facilitator dist exports resolve (re-exported from resolver)', async () => {
    /** Verifies NFR-002: resolve function accessible via facilitator */
    const runtimeRoot = dirname(facilitatorRoot);
    const facilitatorDist = join(runtimeRoot, 'facilitator', 'dist', 'index.js');
    const mod = await import(facilitatorDist);
    expect(typeof mod.resolve).toBe('function');
  });

  it('facilitator dist does NOT export prepare (removed from interface)', async () => {
    /** Verifies FR-014: prepare not exported from facilitator */
    const runtimeRoot = dirname(facilitatorRoot);
    const facilitatorDist = join(runtimeRoot, 'facilitator', 'dist', 'index.js');
    const mod = await import(facilitatorDist);
    expect((mod as Record<string, unknown>)['prepare']).toBeUndefined();
    expect((mod as Record<string, unknown>)['PrepareResult']).toBeUndefined();
  });
});
