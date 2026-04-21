/**
 * Service interfaces for the Forjis web dashboard API.
 *
 * Re-exports all service interfaces from @forjis/shared for backward compatibility.
 * External consumers can continue importing from '@forjis/web' without changes.
 */

export type {
  TaskService,
  PlanService,
  EventService,
  ResourceService,
  ConfigService,
  TokenUsageService,
  FileService,
  PluginFileService,
  PluginFileResult,
  TaskFileService,
  ManifestService,
  RuntimeService,
} from '@forjis/shared';
