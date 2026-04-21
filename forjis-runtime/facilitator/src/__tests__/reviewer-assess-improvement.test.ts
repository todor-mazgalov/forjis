/**
 * Tests for evidence-collector.ts after the split refactoring.
 *
 * The original assessTask and buildScoringPrompt functions have been
 * removed as part of the separation-of-concerns refactoring (task: split).
 * Assessment logic now lives in the orchestrator pipeline as a standard
 * role. This file retains tests for the evidence-collector utilities that
 * remain unchanged.
 */

import { jest } from '@jest/globals';
import {
  truncateDiff,
  MAX_DIFF_CHARS,
  GitEvidenceCollector,
} from '../evidence-collector.js';
import type { EvidenceCollector } from '../evidence-collector.js';

// ---------------------------------------------------------------------------
// FR-001: Evidence collection from git diff
// ---------------------------------------------------------------------------

describe('FR-001: EvidenceCollector interface contract', () => {
  /** GitEvidenceCollector implements EvidenceCollector interface. */
  it('GitEvidenceCollector implements EvidenceCollector', () => {
    const collector = new GitEvidenceCollector();
    expect(typeof collector.collectProducedWork).toBe('function');
  });

  /** collectProducedWork returns a string for any input. */
  it('collectProducedWork returns a string for any input', () => {
    const collector = new GitEvidenceCollector();
    const result = collector.collectProducedWork('/non-existent-path-xyz', 'no-such-task');
    expect(typeof result).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// FR-002: Graceful fallback when git is unavailable
// ---------------------------------------------------------------------------

describe('FR-002: Graceful fallback when git unavailable', () => {
  /** Returns empty string when directory is not a git repo. */
  it('returns empty string when directory is not a git repo', () => {
    const collector = new GitEvidenceCollector();
    expect(() => {
      const result = collector.collectProducedWork('/tmp/__not_a_repo_xyz__', 'any-task');
      expect(result).toBe('');
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// FR-003: truncateDiff
// ---------------------------------------------------------------------------

describe('FR-003: truncateDiff — diff length enforcement', () => {
  it('returns unchanged string when under limit', () => {
    const short = 'diff --git a/file.ts b/file.ts\n+console.log("hello");';
    expect(truncateDiff(short, 1000)).toBe(short);
  });

  it('truncates and appends notice when over limit', () => {
    const long = 'x'.repeat(200);
    const result = truncateDiff(long, 100);
    expect(result).toContain('x'.repeat(100));
    expect(result).toContain('[Diff truncated');
  });

  it('returns unchanged string at exact limit', () => {
    const exact = 'y'.repeat(500);
    expect(truncateDiff(exact, 500)).toBe(exact);
  });

  it('uses MAX_DIFF_CHARS as default', () => {
    const short = 'short diff';
    expect(truncateDiff(short)).toBe(short);
    expect(MAX_DIFF_CHARS).toBeGreaterThan(0);
  });
});
