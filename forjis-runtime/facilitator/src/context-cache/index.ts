/**
 * Public API barrel for the context-cache module.
 *
 * Re-exports every function + type the facilitator runtime and CLI
 * callers consume. See `openspec/changes/cache-harden/design.md` §D-6.
 */

export { computeBlobOid, computeBlobOidForFile } from './oid.js';

export {
  summarizeFile,
  type SummarizeInput,
  type SummarizeOptions,
  type SummarizeResult,
} from './summarize.js';

export {
  readTreeYaml,
  writeTreeYaml,
  type ReadTreeYamlOptions,
  type TreeEntry,
  type TreeYaml,
} from './tree-yaml.js';

export {
  refreshTreeYaml,
  type RefreshOptions,
  type RefreshResult,
} from './refresh.js';

export {
  buildIndexMd,
  type BuildIndexOptions,
  type GitResult,
} from './index-md.js';

export {
  invalidateExplorations,
  type InvalidateOptions,
  type InvalidateResult,
} from './invalidator.js';

export {
  augmentExplorationFilesTouched,
  type AugmentOptions,
} from './exploration-writer.js';

export {
  findOverlappingExplorations,
  type OverlapEntry,
  type OverlapOptions,
} from './exploration-overlap.js';

export { rankByTask, type RankedRow } from './ranking.js';

export {
  writeContextArtefact,
  writeContextArtefactsForTask,
  type ArtefactRole,
  type ContextArtefact,
  type PriorExplorationEntry,
  type WriteArtefactOptions,
  type WriteArtefactResult,
  type WriteArtefactsForTaskOptions,
  type WriteArtefactsForTaskResult,
} from './artefact-writer.js';

export {
  extractFilesTouched,
  hasFilesTouched,
  parseExplorationFile,
  serializeExplorationFile,
  type ExplorationParsed,
  type FilesTouchedEntry,
} from './frontmatter.js';
