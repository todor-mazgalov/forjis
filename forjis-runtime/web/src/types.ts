/**
 * DTO type definitions for the Forjis web dashboard API.
 *
 * Re-exports all shared types from @forjis/shared for backward compatibility.
 * External consumers can continue importing from '@forjis/web' without changes.
 */

export type {
  TaskStatus,
  TaskEvent,
  TaskListItem,
  PipelinePlanResponse,
  PipelineStep,
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
  ConfigResponse,
  ConfigOrg,
  ConfigTeam,
  ConfigRole,
  ConfigPersona,
  ConfigOutcomes,
  ConfigOutcomeGroup,
  ConfigOutcomeRule,
} from '@forjis/shared';
