/**
 * ManifestLoader — parses and validates manifest.yaml files from cached repositories.
 *
 * Reads the manifest.yaml at the root of a cached repository directory,
 * validates required fields (name, version), normalizes optional fields,
 * and returns a typed Manifest object.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';

import { ManifestNotFoundError, ManifestValidationError } from './errors.js';
import type { Manifest, ManifestContents } from './types.js';

/** The expected manifest filename at the repository root. */
const MANIFEST_FILENAME = 'manifest.yaml';

/**
 * Loads and validates manifest.yaml files from cached repository directories.
 */
export class ManifestLoader {
  /**
   * Loads and validates manifest.yaml from a repository cache path.
   *
   * @param repoPath - The absolute path to the cached repository directory.
   * @returns A validated Manifest object.
   * @throws {ManifestNotFoundError} If manifest.yaml does not exist in the directory.
   * @throws {ManifestValidationError} If the manifest has invalid or missing required fields.
   */
  async load(repoPath: string): Promise<Manifest> {
    const manifestPath = join(repoPath, MANIFEST_FILENAME);
    const rawContent = await this.readManifestFile(manifestPath, repoPath);
    const parsed = this.parseYamlContent(rawContent, repoPath);

    this.validateRequiredFields(parsed, repoPath);

    return this.buildManifest(parsed, repoPath);
  }

  /**
   * Reads the raw manifest file content.
   *
   * @param manifestPath - The full path to manifest.yaml.
   * @param repoPath - The repository path for error context.
   * @returns The file content as a string.
   * @throws {ManifestNotFoundError} If the file does not exist.
   */
  private async readManifestFile(
    manifestPath: string,
    repoPath: string
  ): Promise<string> {
    try {
      return await readFile(manifestPath, 'utf-8');
    } catch (error) {
      if (isNodeError(error) && error.code === 'ENOENT') {
        throw new ManifestNotFoundError(repoPath);
      }
      throw new ManifestValidationError(
        repoPath,
        `failed to read manifest.yaml: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Parses YAML content into a raw object.
   *
   * @param content - The YAML string to parse.
   * @param repoPath - The repository path for error context.
   * @returns The parsed object.
   * @throws {ManifestValidationError} If the YAML is malformed.
   */
  private parseYamlContent(content: string, repoPath: string): unknown {
    try {
      const parsed = parseYaml(content);
      if (parsed === null || typeof parsed !== 'object') {
        throw new ManifestValidationError(repoPath, 'manifest must be a YAML object');
      }
      return parsed;
    } catch (error) {
      if (error instanceof ManifestValidationError) {
        throw error;
      }
      throw new ManifestValidationError(
        repoPath,
        `YAML parse error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Validates that required fields (name, version) are present and non-empty strings.
   *
   * @param parsed - The parsed YAML object.
   * @param repoPath - The repository path for error context.
   * @throws {ManifestValidationError} If required fields are missing or invalid.
   */
  private validateRequiredFields(
    parsed: unknown,
    repoPath: string
  ): void {
    const obj = parsed as Record<string, unknown>;

    if (!obj['name'] || typeof obj['name'] !== 'string') {
      throw new ManifestValidationError(repoPath, 'missing required field: name');
    }

    if (!obj['version'] || typeof obj['version'] !== 'string') {
      throw new ManifestValidationError(repoPath, 'missing required field: version');
    }
  }

  /**
   * Constructs a validated Manifest object from parsed YAML data.
   *
   * Normalizes optional fields to their default values.
   *
   * @param parsed - The validated parsed YAML object.
   * @param repoPath - The repository path for error context.
   * @returns A typed Manifest object.
   */
  private buildManifest(parsed: unknown, repoPath: string): Manifest {
    const obj = parsed as Record<string, unknown>;
    const contents = this.normalizeContents(obj['contents'], repoPath);

    return {
      name: obj['name'] as string,
      version: obj['version'] as string,
      description:
        typeof obj['description'] === 'string' ? obj['description'] : undefined,
      contents,
    };
  }

  /**
   * Normalizes the contents block, defaulting missing arrays to empty.
   *
   * @param raw - The raw contents value from parsed YAML.
   * @param repoPath - The repository path for error context.
   * @returns A normalized ManifestContents object.
   * @throws {ManifestValidationError} If content entries are not string arrays.
   */
  private normalizeContents(
    raw: unknown,
    repoPath: string
  ): ManifestContents {
    if (raw === undefined || raw === null) {
      return { agents: [], skills: [], hooks: [], plugins: [] };
    }

    if (typeof raw !== 'object') {
      throw new ManifestValidationError(repoPath, 'contents must be an object');
    }

    const obj = raw as Record<string, unknown>;

    return {
      agents: this.validateStringArray(obj['agents'], 'contents.agents', repoPath),
      skills: this.validateStringArray(obj['skills'], 'contents.skills', repoPath),
      hooks: this.validateStringArray(obj['hooks'], 'contents.hooks', repoPath),
      plugins: this.validateStringArray(obj['plugins'], 'contents.plugins', repoPath),
    };
  }

  /**
   * Validates that a value is a string array, or returns an empty array if absent.
   *
   * @param value - The value to validate.
   * @param fieldName - The field name for error context.
   * @param repoPath - The repository path for error context.
   * @returns A string array.
   * @throws {ManifestValidationError} If the value is present but not a string array.
   */
  private validateStringArray(
    value: unknown,
    fieldName: string,
    repoPath: string
  ): string[] {
    if (value === undefined || value === null) {
      return [];
    }

    if (!Array.isArray(value)) {
      throw new ManifestValidationError(
        repoPath,
        `${fieldName} must be an array of strings`
      );
    }

    for (const item of value) {
      if (typeof item !== 'string') {
        throw new ManifestValidationError(
          repoPath,
          `${fieldName} must be an array of strings, found: ${typeof item}`
        );
      }
    }

    return value as string[];
  }
}

/**
 * Type guard for Node.js errors with an error code.
 *
 * @param error - The error to check.
 * @returns True if the error has a string `code` property.
 */
function isNodeError(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as Record<string, unknown>)['code'] === 'string'
  );
}
