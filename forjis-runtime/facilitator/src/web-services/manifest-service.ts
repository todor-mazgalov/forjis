/**
 * Manifest service implementation for the web dashboard backend.
 *
 * Reads and parses the output-files.yaml manifest that records which files
 * each pipeline role produces. The manifest is written by the orchestrator
 * LLM during role execution and read by the facilitator for dashboard display.
 */

import { join } from 'node:path';
import { readYamlFile } from '../state.js';
import type { ManifestService } from '@forjis/shared';

/** A single entry in the output files manifest. */
export interface ManifestEntry {
  /** The pipeline role that produced this file. */
  role: string;
  /** Project-relative path to the output file. */
  path: string;
  /** Short display label for the file (typically the filename). */
  label: string;
  /** ISO 8601 timestamp when the file was created. */
  createdAt?: string;
}

/** Raw shape of the output-files.yaml manifest file. */
interface ManifestFile {
  files?: ManifestEntry[];
}

/**
 * Implements ManifestService by reading output-files.yaml from the task directory.
 *
 * Reads from `.forjis/tasks/<taskId>/output-files.yaml` and returns parsed entries.
 * Returns an empty files array when the manifest does not exist.
 */
export class ManifestServiceImpl implements ManifestService {
  /**
   * Creates a ManifestServiceImpl.
   *
   * @param projectDir - The root project directory.
   */
  constructor(private readonly projectDir: string) {}

  /**
   * Returns the output file manifest for a task.
   *
   * Reads and parses `.forjis/tasks/<taskId>/output-files.yaml`.
   * Returns an empty files array if the manifest does not exist or is malformed.
   *
   * @param taskId - The task identifier.
   * @returns The manifest with a files array.
   */
  async getManifest(taskId: string): Promise<{ files: ManifestEntry[] }> {
    const manifestPath = join(this.projectDir, '.forjis', 'tasks', taskId, 'output-files.yaml');
    const data = await readYamlFile<ManifestFile>(manifestPath);

    if (!data || !Array.isArray(data.files)) {
      return { files: [] };
    }

    return { files: data.files };
  }
}
