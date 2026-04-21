/**
 * Evidence collector for @forjis/cli.
 *
 * Collects actual produced work evidence from git diffs rather than
 * relying on artifact filenames. This gives the outcome assessor
 * substantive code changes to evaluate for completeness, speculation,
 * and hallucination.
 */

import { execSync } from 'node:child_process';

/** Maximum characters for diff text in the scoring prompt. */
export const MAX_DIFF_CHARS = 80_000;

/**
 * Contract for collecting produced work evidence.
 *
 * Implementations gather evidence of work done during a task,
 * returning it as a string suitable for inclusion in a scoring prompt.
 */
export interface EvidenceCollector {
  /**
   * Collects evidence of produced work for the given task.
   *
   * @param projectDir - The root directory of the target project.
   * @param taskId - The task identifier (used to derive the branch name).
   * @returns The produced work evidence as a string, or empty string on failure.
   */
  collectProducedWork(projectDir: string, taskId: string): string;
}

/**
 * Default implementation that uses git diff to collect produced work.
 *
 * Computes the merge-base between `main` and `forjis/<taskId>`, then
 * captures the full diff between that base and HEAD. All git failures
 * are caught and result in an empty string with a warning logged to stderr.
 */
export class GitEvidenceCollector implements EvidenceCollector {
  /**
   * Collects the git diff between the task branch merge-base and HEAD.
   *
   * Runs `git merge-base main forjis/<taskId>` to find the common ancestor,
   * then `git diff <baseSha> HEAD` to capture all changes. Returns the diff
   * output as a string. On any failure (git not found, not a repo, branch
   * missing), logs a warning and returns an empty string.
   *
   * @param projectDir - The root directory of the git repository.
   * @param taskId - The task identifier used to derive branch name `forjis/<taskId>`.
   * @returns The git diff text, or empty string if git commands fail.
   */
  collectProducedWork(projectDir: string, taskId: string): string {
    try {
      const branchName = `forjis/${taskId}`;
      const baseSha = execSync(`git merge-base main ${branchName}`, {
        cwd: projectDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();

      const diff = execSync(`git diff ${baseSha} HEAD`, {
        cwd: projectDir,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        maxBuffer: 50 * 1024 * 1024,
      });

      return diff;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[evidence-collector]: git evidence collection failed: ${message}`);
      return '';
    }
  }
}

/**
 * Truncates diff text to a maximum character limit.
 *
 * When the diff exceeds the limit, the text is sliced and a truncation
 * notice is appended indicating how many characters were omitted.
 * This prevents LLM prompt overflow on large changesets.
 *
 * @param diff - The full diff text to potentially truncate.
 * @param maxChars - The maximum character limit. Defaults to MAX_DIFF_CHARS.
 * @returns The diff text, truncated with a notice if it exceeded the limit.
 */
export function truncateDiff(diff: string, maxChars: number = MAX_DIFF_CHARS): string {
  if (diff.length <= maxChars) {
    return diff;
  }

  const omitted = diff.length - maxChars;
  return `${diff.slice(0, maxChars)}\n\n[Diff truncated: ${omitted} characters omitted]`;
}
