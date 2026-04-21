/**
 * Public API barrel for @forjis/facilitator.
 *
 * Re-exports the primary functions, classes, types, and errors that
 * external packages (CLI, web) and tests may need to import.
 * Configuration-related symbols are re-exported from @forjis/resolver
 * for backward compatibility.
 */

// -- Re-exports from @forjis/resolver for backward compatibility (NFR-002) --
export {
  parseBuildFile,
  loadBuildFile,
  composeRuntime,
  loadPlugins,
  parsePlugin,
  resolveRepositories,
  ResourceRegistry,
  CacheManager,
  resolveAllResources,
  resolve,
  parseDuration,
  formatDuration,
} from '@forjis/resolver';

export type {
  ConfigResult,
  ResolveOptions,
  BuildConfig,
  PluginDef,
  RuntimeConfig,
  RuntimeOrg,
  RuntimeTeam,
  RuntimeRole,
  ResolvedConstraints,
  MetricDef,
  OutcomeConfigFile,
  PluginRef,
  TeamDef,
  OrgDef,
  RoleDef,
  RoleHooks,
  TasksConfig,
  OutcomeConfig,
  OutcomeRule,
  ConstraintGroup,
  ConstraintIncludeRef,
  BuildConstraintsConfig,
  PersonasConfig,
  HealthCheckConfig,
  TokenBudgetConfig,
  ResolvedResource,
  LockFile,
  LockRepoEntry,
  LockPluginEntry,
} from '@forjis/resolver';

// -- Command handlers --
export { runCommand } from './commands/run.js';
export type { RunOptions } from './commands/run.js';
export { devCommand } from './commands/dev.js';
export type { DevCommandOptions } from './commands/dev.js';
export { initCommand } from './commands/init.js';
export { validateCommand } from './commands/validate.js';
export { statusCommand } from './commands/status.js';
export { stopCommand } from './commands/stop.js';
export { assessCommand } from './commands/assess.js';
export { registryListCommand, registryAddCommand } from './commands/registry.js';
export { personaCreateCommand, personaRunCommand, personaGenerateCommand } from './commands/persona.js';
export { strategistRunCommand } from './commands/strategist.js';
export { versionCommand, getComponentVersions } from './commands/version.js';
export type { ComponentVersions } from './commands/version.js';
export {
  tasksActivateCommand,
  tasksCleanCommand,
  tasksRemoveCommand,
  tasksNukeCommand,
} from './commands/tasks.js';
export { taskCreateCommand } from './commands/task-create.js';

// -- Engine abstraction (no prepare()) --
export { loadEngine, registerEngine, getRegisteredEngines } from './engine.js';
export type { ForjisEngine, EngineResult, EngineInvokeOptions } from './engine.js';

// -- Token tracking --
export { TokenTracker } from './token-tracker.js';

// -- Expression and outcome utilities --
export { evaluateExpression, validateExpression } from './expression-eval.js';
export { evaluateRules, resolveFailureAction } from './outcome-assessor.js';

// -- Task queue and state --
export { TaskQueue } from './task-queue.js';
export { getCurrentStage } from './task-state.js';
export { renderStatus } from './display.js';

// -- State utilities --
export { readYamlFile, writeYamlFile, atomicWriteFile, atomicWriteFileBinary, ensureDir } from './state.js';

// -- Validation --
export { isValidTaskId, assertValidTaskId } from './task-id.js';

// -- Inspector session tokens --
export {
  generateSessionToken,
  SessionTokenRegistry,
  SessionTokenAlreadyRegisteredError,
} from './session-token.js';
export type { SessionMetadata } from './session-token.js';

// -- Web service implementations --
export { TaskServiceImpl } from './web-services/task-service.js';
export { PlanServiceImpl } from './web-services/plan-service.js';
export { EventServiceImpl } from './web-services/event-service.js';
export { ResourceServiceImpl } from './web-services/resource-service.js';
export { FileServiceImpl } from './web-services/file-service.js';
export { ManifestServiceImpl } from './web-services/manifest-service.js';
export { InspectorServiceImpl, ConcurrentBatchError } from './web-services/inspector-service.js';
export type { InspectorServiceOptions } from './web-services/inspector-service.js';
export { wireInspectorMessagePump } from './web-services/inspector-message-pump.js';
export { getDefaultClarifierPath, loadClarifierAgent } from './inspector-agent-loader.js';
export type { ClarifierAgent, ClarifierAgentConfig } from './inspector-agent-loader.js';
export { InspectorClarifierRunner } from './inspector-clarifier-runner.js';
export type {
  InspectorClarifierRunnerOptions,
  ClarifierPersonaLoader,
} from './inspector-clarifier-runner.js';
export { RuntimeServiceImpl } from './web-services/runtime-service.js';
export type { WorkerStateRef } from './web-services/runtime-service.js';
export { writePipelinePlan, syncPlanFromState, syncBranchesFromState, forcePlanReady, getRunningRole, parsePipelinePlan, PlanRoleNotFoundError } from './web-services/plan-writer.js';
export { appendEvent, readEvents, readEventsSince, readEventsForRole, readEventsForRoleSince, buildEventPath, MAX_EVENT_LINES } from './web-services/event-writer.js';
export { appendManifestEntry, __resetSeen } from './web-services/manifest-recorder.js';
export { describeRole } from './web-services/plan-writer.js';

// -- Types that remain in facilitator --
export type {
  TaskStatus,
  TaskPriority,
  TaskState,
  ClarificationQuestion,
  ClarificationFile,
  AssessmentResult,
  Verdict,
  TokenUsageState,
  PromptOptions,
} from './types.js';

// -- Errors --
export * from './errors.js';
