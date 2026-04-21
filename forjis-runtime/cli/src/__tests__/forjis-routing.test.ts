/**
 * Integration tests for the forjis CLI entry point.
 *
 * Tests the bug fix for unknown subcommands silently starting the pipeline
 * (task: unknown-subcommand-starts-pipeline).
 *
 * Because parseArgs() and routeCommand() are not exported, tests invoke the
 * compiled binary via spawnSync and verify process exit codes and output.
 *
 * Key behaviors under test:
 *   1. Unknown subcommand → error message + exit 1
 *   2. --version flag → versionCommand output + exit 0
 *   3. --help / -h flag → usage output + exit 0
 *   4. Bare invocation (no args) → attempts pipeline (exits 1 due to missing
 *      build file, but NOT the unknown-command error)
 *   5. Known flags (--dry-run) → attempts pipeline (no unknown-command error)
 *   6. Unknown flag-style arg (--bogus) → error message + exit 1
 *   7. Known commands (init, status, validate, version) → attempt normal routing
 */

import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/** Absolute path to the compiled CLI binary. */
const CLI_BIN = resolve(__dirname, '../../dist/bin/forjis.js');

/** Unknown-command error message template. */
const UNKNOWN_CMD_PATTERN = /Unknown command "([^"]+)"\. Run "forjis --help" for available commands\./;

/**
 * Spawns the CLI with the given arguments and returns stdout, stderr, and
 * exit status. Uses a non-existent working directory to ensure the pipeline
 * fails fast (no real build.forjis), keeping test execution quick.
 */
function runCli(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [CLI_BIN, ...args], {
    encoding: 'utf8',
    timeout: 10_000,
    // Use the tmp dir so no accidental build.forjis is found
    cwd: tmpdir(),
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
  };
}

// ---------------------------------------------------------------------------
// Bug fix: unknown subcommand must error, not start pipeline
// ---------------------------------------------------------------------------

describe('unknown subcommand guard (bug fix)', () => {
  it('prints the unknown-command error for a random word', () => {
    const { stderr, status } = runCli(['foobar']);
    expect(status).toBe(1);
    expect(stderr).toMatch(UNKNOWN_CMD_PATTERN);
    expect(stderr).toContain('"foobar"');
  });

  it('exits with code 1 for unknown subcommand', () => {
    const { status } = runCli(['notacommand']);
    expect(status).toBe(1);
  });

  it('does NOT print "resolving configuration" for unknown subcommand', () => {
    // Ensures the pipeline did not start before erroring
    const { stdout, stderr } = runCli(['foobar']);
    const combined = stdout + stderr;
    expect(combined).not.toContain('resolving configuration');
    expect(combined).not.toContain('[forjis]');
  });

  it('error message references --help for unknown subcommand', () => {
    const { stderr } = runCli(['foobar']);
    expect(stderr).toContain('--help');
  });
});

// ---------------------------------------------------------------------------
// Bug fix: --version flag must call versionCommand, not start pipeline
// ---------------------------------------------------------------------------

describe('--version flag (bug fix)', () => {
  it('exits with code 0 for --version', () => {
    const { status } = runCli(['--version']);
    expect(status).toBe(0);
  });

  it('prints "forjis versions:" for --version', () => {
    const { stdout } = runCli(['--version']);
    expect(stdout).toContain('forjis versions:');
  });

  it('does NOT print the unknown-command error for --version', () => {
    const { stderr } = runCli(['--version']);
    expect(stderr).not.toMatch(UNKNOWN_CMD_PATTERN);
  });

  it('does NOT start the pipeline for --version', () => {
    const { stdout, stderr } = runCli(['--version']);
    const combined = stdout + stderr;
    expect(combined).not.toContain('resolving configuration');
  });
});

// ---------------------------------------------------------------------------
// Unknown flag-style argument (e.g. --bogus) must also error
// ---------------------------------------------------------------------------

describe('unknown flag-style argument guard (bug fix)', () => {
  it('prints the unknown-command error for --bogus', () => {
    const { stderr, status } = runCli(['--bogus']);
    expect(status).toBe(1);
    expect(stderr).toMatch(UNKNOWN_CMD_PATTERN);
    expect(stderr).toContain('"--bogus"');
  });

  it('does NOT start the pipeline for --bogus', () => {
    const { stdout, stderr } = runCli(['--bogus']);
    const combined = stdout + stderr;
    expect(combined).not.toContain('resolving configuration');
  });
});

// ---------------------------------------------------------------------------
// Regression: bare invocation (no args) must still start the pipeline
// ---------------------------------------------------------------------------

describe('bare invocation regression', () => {
  it('does NOT print the unknown-command error for bare forjis', () => {
    const { stderr } = runCli([]);
    expect(stderr).not.toMatch(UNKNOWN_CMD_PATTERN);
  });

  it('attempts the pipeline for bare forjis (fails due to missing build file)', () => {
    // The pipeline should start — it will fail because there's no build.forjis
    // in the temp dir, but the error is NOT the unknown-command message.
    const { stdout, stderr } = runCli([]);
    const combined = stdout + stderr;
    // Pipeline started: it prints "resolving configuration" before erroring
    expect(combined).toMatch(/resolving configuration|build\.forjis|Build file not found/i);
  });
});

// ---------------------------------------------------------------------------
// Regression: known flags (--dry-run) must still start the pipeline
// ---------------------------------------------------------------------------

describe('known flags regression', () => {
  it('does NOT print the unknown-command error for --dry-run', () => {
    const { stderr } = runCli(['--dry-run']);
    expect(stderr).not.toMatch(UNKNOWN_CMD_PATTERN);
  });

  it('attempts the pipeline for --dry-run (fails due to missing build file)', () => {
    const { stdout, stderr } = runCli(['--dry-run']);
    const combined = stdout + stderr;
    expect(combined).toMatch(/resolving configuration|build\.forjis|Build file not found/i);
  });
});

// ---------------------------------------------------------------------------
// --help / -h flag behavior (pre-existing, non-regression)
// ---------------------------------------------------------------------------

describe('--help flag', () => {
  it('exits with code 0 for --help', () => {
    const { status } = runCli(['--help']);
    expect(status).toBe(0);
  });

  it('prints usage information for --help', () => {
    const { stdout } = runCli(['--help']);
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('forjis');
  });

  it('does NOT print the unknown-command error for --help', () => {
    const { stderr } = runCli(['--help']);
    expect(stderr).not.toMatch(UNKNOWN_CMD_PATTERN);
  });

  it('exits with code 0 for -h alias', () => {
    const { status } = runCli(['-h']);
    expect(status).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Subcommand --help shows subcommand-specific help (bug fix)
// ---------------------------------------------------------------------------

describe('subcommand --help (bug fix)', () => {
  it('"task --help" shows task-specific help, not generic help', () => {
    const { stdout, status } = runCli(['task', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('forjis task');
    expect(stdout).toContain('create');
    expect(stdout).toContain('activate');
    expect(stdout).toContain('clean');
    expect(stdout).toContain('remove');
    expect(stdout).toContain('nuke');
    // Must NOT show the generic top-level framework commands
    expect(stdout).not.toContain('Framework commands');
  });

  it('"persona --help" shows persona-specific help, not generic help', () => {
    const { stdout, status } = runCli(['persona', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('forjis persona');
    expect(stdout).toContain('create');
    expect(stdout).toContain('run');
    expect(stdout).not.toContain('Framework commands');
  });

  it('"registry --help" shows registry-specific help, not generic help', () => {
    const { stdout, status } = runCli(['registry', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('forjis registry');
    expect(stdout).toContain('list');
    expect(stdout).toContain('add');
    expect(stdout).not.toContain('Framework commands');
  });

  it('"strategist --help" shows strategist-specific help, not generic help', () => {
    const { stdout, status } = runCli(['strategist', '--help']);
    expect(status).toBe(0);
    expect(stdout).toContain('forjis strategist');
    expect(stdout).toContain('run');
    expect(stdout).toContain('--loop');
    expect(stdout).not.toContain('Framework commands');
  });

  it('"task -h" also shows task-specific help', () => {
    const { stdout, status } = runCli(['task', '-h']);
    expect(status).toBe(0);
    expect(stdout).toContain('forjis task');
    expect(stdout).not.toContain('Framework commands');
  });
});

// ---------------------------------------------------------------------------
// Known commands — route correctly without unknown-command error
// ---------------------------------------------------------------------------

describe('known command routing (non-regression)', () => {
  const knownCommands = ['init', 'status', 'validate', 'version', 'run'];

  for (const cmd of knownCommands) {
    it(`does not print unknown-command error for "${cmd}"`, () => {
      const { stderr } = runCli([cmd]);
      expect(stderr).not.toMatch(UNKNOWN_CMD_PATTERN);
    });
  }

  // -------------------------------------------------------------------------
  // forjis dev help — documents every new flag (FR-007)
  // -------------------------------------------------------------------------

  describe('forjis dev help output', () => {
    it('forjis --help mentions the dev command', () => {
      const { stdout, status } = runCli(['--help']);
      expect(status).toBe(0);
      expect(stdout).toContain('dev');
    });

    it('forjis dev --help lists every supported flag', () => {
      const { stdout, status } = runCli(['dev', '--help']);
      expect(status).toBe(0);
      expect(stdout).toContain('--port');
      expect(stdout).toContain('--host');
      expect(stdout).toContain('--dev-cmd');
      expect(stdout).toContain('--dev-cwd');
      expect(stdout).toContain('--tunnel');
      expect(stdout).toContain('--help');
    });

    it('forjis dev --help shows the dev-specific banner', () => {
      const { stdout } = runCli(['dev', '--help']);
      expect(stdout).toContain('forjis dev');
      expect(stdout).not.toContain('Framework commands');
    });
  });

  it('"version" command prints version info', () => {
    const { stdout, status } = runCli(['version']);
    expect(stdout).toContain('forjis versions:');
    expect(status).toBe(0);
  });

  it('"run" command attempts the pipeline (fails due to missing build file)', () => {
    const { stdout, stderr } = runCli(['run']);
    const combined = stdout + stderr;
    expect(combined).toMatch(/resolving configuration|build\.forjis|Build file not found/i);
  });

  it('"run --dry-run" attempts the pipeline (fails due to missing build file)', () => {
    const { stdout, stderr } = runCli(['run', '--dry-run']);
    const combined = stdout + stderr;
    expect(combined).toMatch(/resolving configuration|build\.forjis|Build file not found/i);
    expect(stderr).not.toMatch(UNKNOWN_CMD_PATTERN);
  });
});
