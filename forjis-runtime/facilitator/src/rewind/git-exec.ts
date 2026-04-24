/**
 * Thin async `spawn` wrapper around the `git` binary used by the
 * rewind submodule. Returns a uniform `{stdout, stderr, exitCode}`
 * shape so callers can branch on the exit code without try/catch.
 */

import { spawn } from 'node:child_process';

/** Structured result of a single `git` invocation. */
export interface GitExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Signature shared by the real wrapper and test-time stubs. */
export type GitExec = (args: string[], cwd: string) => Promise<GitExecResult>;

/**
 * Spawns `git <args>` in `cwd` and resolves with the captured stdout,
 * stderr, and exit code.
 *
 * Never throws on non-zero exit — callers inspect `exitCode`.
 * Never throws on spawn failure — resolves with exit code 127.
 *
 * @param args - Positional arguments passed to `git`.
 * @param cwd - Working directory for the child process.
 * @returns The captured output and exit code.
 */
export const gitExec: GitExec = (args, cwd) =>
  new Promise<GitExecResult>((resolvePromise) => {
    const child = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', () => {
      resolvePromise({ stdout, stderr, exitCode: 127 });
    });
    child.on('close', (code) => {
      resolvePromise({ stdout, stderr, exitCode: code ?? 0 });
    });
  });
