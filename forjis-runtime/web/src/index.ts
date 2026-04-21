/**
 * Barrel export for the Forjis web dashboard module.
 *
 * Re-exports all public types, service interfaces, and factory functions
 * that external modules (such as the facilitator's run command and backend
 * service implementations) need to import. Internal modules like controllers
 * and helpers are not re-exported.
 */

export type {
  TaskListItem,
  PipelinePlanResponse,
  PipelineStep,
  TaskEvent,
  ResourcesResponse,
  OrgResource,
  TeamResource,
  RoleResource,
  AgentResource,
  SkillResource,
  HookResource,
  PluginResource,
  ErrorResponse,
  TokenUsageResponse,
  ManifestFileEntry,
  ManifestResponse,
  WebServerOptions,
} from './types.js';

export type {
  TaskService,
  PlanService,
  EventService,
  ResourceService,
  TokenUsageService,
  FileService,
  PluginFileService,
  PluginFileResult,
  TaskFileService,
  ManifestService,
} from './services.js';

export { createWebServer } from './server.js';
export { createRouter } from './router.js';
