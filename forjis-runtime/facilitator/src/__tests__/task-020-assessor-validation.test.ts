/**
 * Tests for task 020: Assessor Validation with Project Tools
 *
 * Validates:
 *   - forjis-plugins/plugins/software-dev.forjis.yaml: test_validation metric structure
 *   - forjis-plugins/agents/forjis-assessor.md: safety guardrails, Step 2b, scoring
 *
 * Requirements covered:
 *   FR-001 Tool Discovery
 *   FR-002 Conditional Validation
 *   FR-003 Safety Guardrails
 *   FR-004 Scoring Integration
 *   NFR-001 Cross-Platform Timeout
 *   NFR-002 Metric Declaration
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';

// Paths relative to repo root
const REPO_ROOT = resolve(import.meta.url.replace(/^file:\/\/\//, '').replace(/\/forjis-runtime\/.*$/, ''));
const YAML_FILE = resolve(REPO_ROOT, 'forjis-plugins/plugins/software-dev.forjis.yaml');
const ASSESSOR_MD = resolve(REPO_ROOT, 'forjis-plugins/agents/forjis-assessor.md');

// Load files once
const yamlContent = readFileSync(YAML_FILE, 'utf-8');
const assessorContent = readFileSync(ASSESSOR_MD, 'utf-8');
const yamlDoc = parseYaml(yamlContent) as Record<string, unknown>;

// --------------------------------------------------------------------------
// NFR-002: YAML metric declaration
// --------------------------------------------------------------------------

describe('NFR-002: software-dev.forjis.yaml — test_validation metric', () => {
  it('metrics block exists in YAML', () => {
    expect(yamlDoc).toHaveProperty('metrics');
    expect(typeof yamlDoc.metrics).toBe('object');
  });

  it('test_validation entry exists under metrics', () => {
    const metrics = yamlDoc.metrics as Record<string, unknown>;
    expect(metrics).toHaveProperty('test_validation');
  });

  it('test_validation has description field', () => {
    const metrics = yamlDoc.metrics as Record<string, unknown>;
    const tv = metrics['test_validation'] as Record<string, unknown>;
    expect(tv).toHaveProperty('description');
    expect(typeof tv.description).toBe('string');
    expect((tv.description as string).length).toBeGreaterThan(0);
  });

  it('test_validation has criteria field as array', () => {
    const metrics = yamlDoc.metrics as Record<string, unknown>;
    const tv = metrics['test_validation'] as Record<string, unknown>;
    expect(tv).toHaveProperty('criteria');
    expect(Array.isArray(tv.criteria)).toBe(true);
    expect((tv.criteria as unknown[]).length).toBeGreaterThan(0);
  });

  it('test_validation has scale field', () => {
    const metrics = yamlDoc.metrics as Record<string, unknown>;
    const tv = metrics['test_validation'] as Record<string, unknown>;
    expect(tv).toHaveProperty('scale');
    expect(typeof tv.scale).toBe('string');
    expect((tv.scale as string).length).toBeGreaterThan(0);
  });

  it('test_validation has roles field as array', () => {
    const metrics = yamlDoc.metrics as Record<string, unknown>;
    const tv = metrics['test_validation'] as Record<string, unknown>;
    expect(tv).toHaveProperty('roles');
    expect(Array.isArray(tv.roles)).toBe(true);
  });

  it('test_validation roles includes Assessor', () => {
    const metrics = yamlDoc.metrics as Record<string, unknown>;
    const tv = metrics['test_validation'] as Record<string, unknown>;
    const roles = tv.roles as string[];
    expect(roles).toContain('Assessor');
  });

  it('test_validation follows same structure as security_score (description, criteria, scale, roles)', () => {
    const metrics = yamlDoc.metrics as Record<string, unknown>;
    const ss = metrics['security_score'] as Record<string, unknown>;
    const tv = metrics['test_validation'] as Record<string, unknown>;
    // Both should have the same set of fields
    const ssKeys = Object.keys(ss).sort();
    const tvKeys = Object.keys(tv).sort();
    expect(tvKeys).toEqual(ssKeys);
  });

  it('test_validation scale mentions 0, 50, and 100 scoring values', () => {
    const metrics = yamlDoc.metrics as Record<string, unknown>;
    const tv = metrics['test_validation'] as Record<string, unknown>;
    const scale = tv.scale as string;
    expect(scale).toContain('0');
    expect(scale).toContain('50');
    expect(scale).toContain('100');
  });
});

// --------------------------------------------------------------------------
// FR-003: Safety Guardrails
// --------------------------------------------------------------------------

describe('FR-003: Safety Guardrails section in forjis-assessor.md', () => {
  it('safety guardrails section exists with a recognizable heading', () => {
    expect(assessorContent).toMatch(/safety guardrails/i);
  });

  it('environment variable blocklist includes DATABASE_URL', () => {
    expect(assessorContent).toContain('DATABASE_URL');
  });

  it('environment variable blocklist includes PROD_* pattern', () => {
    expect(assessorContent).toMatch(/PROD_\*/);
  });

  it('environment variable blocklist includes PRODUCTION_* pattern', () => {
    expect(assessorContent).toMatch(/PRODUCTION_\*/);
  });

  it('environment variable blocklist includes AWS_SECRET_ACCESS_KEY', () => {
    expect(assessorContent).toContain('AWS_SECRET_ACCESS_KEY');
  });

  it('environment variable blocklist includes AWS_ACCESS_KEY_ID', () => {
    expect(assessorContent).toContain('AWS_ACCESS_KEY_ID');
  });

  it('environment variable blocklist includes API_KEY', () => {
    expect(assessorContent).toContain('API_KEY');
  });

  it('environment variable blocklist includes STRIPE_SECRET', () => {
    expect(assessorContent).toContain('STRIPE_SECRET');
  });

  it('environment variable blocklist includes SENDGRID_API_KEY', () => {
    expect(assessorContent).toContain('SENDGRID_API_KEY');
  });

  it('URL allowlist restricts to localhost', () => {
    expect(assessorContent).toContain('localhost');
  });

  it('URL allowlist restricts to 127.0.0.1', () => {
    expect(assessorContent).toContain('127.0.0.1');
  });

  it('URL allowlist restricts to ::1 (IPv6 loopback)', () => {
    expect(assessorContent).toContain('::1');
  });

  it('uses categorical language SHALL NOT', () => {
    expect(assessorContent).toContain('SHALL NOT');
  });

  it('uses categorical language MUST NOT', () => {
    expect(assessorContent).toContain('MUST NOT');
  });

  it('uses categorical language NEVER', () => {
    expect(assessorContent).toContain('NEVER');
  });

  it('file system scope constraints to TARGET_PROJECT', () => {
    expect(assessorContent).toMatch(/TARGET_PROJECT.*file system|file system.*TARGET_PROJECT|outside TARGET_PROJECT/i);
  });
});

// --------------------------------------------------------------------------
// FR-001: Tool Discovery (Step 2b)
// --------------------------------------------------------------------------

describe('FR-001: Step 2b Discovery section in forjis-assessor.md', () => {
  it('Step 2b section exists between Step 2 and Step 3', () => {
    expect(assessorContent).toMatch(/##\s+Step 2b/i);
    // Verify ordering: Step 2 comes before Step 2b, which comes before Step 3
    const step2Idx = assessorContent.indexOf('## Step 2:');
    const step2bIdx = assessorContent.search(/##\s+Step 2b/i);
    const step3Idx = assessorContent.indexOf('## Step 3:');
    expect(step2Idx).toBeGreaterThan(-1);
    expect(step2bIdx).toBeGreaterThan(step2Idx);
    expect(step3Idx).toBeGreaterThan(step2bIdx);
  });

  it('Discovery sub-section instructs reading package.json', () => {
    expect(assessorContent).toContain('package.json');
  });

  it('Discovery sub-section globs for jest.config.*', () => {
    expect(assessorContent).toContain('jest.config.*');
  });

  it('Discovery sub-section globs for playwright.config.*', () => {
    expect(assessorContent).toContain('playwright.config.*');
  });

  it('Discovery sub-section globs for vitest.config.*', () => {
    expect(assessorContent).toContain('vitest.config.*');
  });

  it('Discovery sub-section globs for cypress.config.*', () => {
    expect(assessorContent).toContain('cypress.config.*');
  });

  it('Discovery sub-section globs for .mocharc.*', () => {
    expect(assessorContent).toContain('.mocharc.*');
  });

  it('Discovery sub-section checks for __tests__/ directory', () => {
    expect(assessorContent).toContain('__tests__/');
  });

  it('Discovery sub-section checks for tests/ directory', () => {
    expect(assessorContent).toContain('tests/');
  });

  it('Discovery sub-section checks for test/ directory', () => {
    expect(assessorContent).toContain('test/');
  });

  it('Discovery sub-section checks for e2e/ directory', () => {
    expect(assessorContent).toContain('e2e/');
  });

  it('Discovery sub-section checks for spec/ directory', () => {
    expect(assessorContent).toContain('spec/');
  });

  it('Discovery instructs recording discovered tools and commands', () => {
    expect(assessorContent).toMatch(/record.*discovered|discovered.*tools/i);
  });
});

// --------------------------------------------------------------------------
// FR-002 + NFR-001: Conditional Validation / Execution
// --------------------------------------------------------------------------

describe('FR-002 + NFR-001: Step 2b Execution section in forjis-assessor.md', () => {
  it('Execution sub-section exists in Step 2b', () => {
    expect(assessorContent).toMatch(/###\s+Execution/i);
  });

  it('Execution instructs verifying safety guardrails before each command', () => {
    // Should mention re-checking or verifying guardrails before execution
    expect(assessorContent).toMatch(/verify safety guardrails|re-check|blocklist.*URL|guardrail.*before/i);
  });

  it('Node.js cross-platform timeout wrapper is present', () => {
    expect(assessorContent).toContain("require('child_process')");
  });

  it('Timeout wrapper uses 60 second limit', () => {
    expect(assessorContent).toContain('60000');
  });

  it('Timeout wrapper uses spawn', () => {
    expect(assessorContent).toContain('spawn');
  });

  it('Timeout wrapper uses setTimeout for cross-platform kill', () => {
    expect(assessorContent).toContain('setTimeout');
  });

  it('Handles timeout exit code 124 gracefully', () => {
    expect(assessorContent).toContain('124');
  });

  it('Handles startup failures with score 50', () => {
    expect(assessorContent).toMatch(/startup.*fail|fail.*start|score.*50|50.*score/i);
  });

  it('Skips execution when no test tools found', () => {
    expect(assessorContent).toMatch(/skip.*no test|no.*test.*tools.*found|no test tools.*found/i);
  });

  it('Parses test output for pass/fail counts', () => {
    expect(assessorContent).toMatch(/pass.*fail|parse.*output|pass\/fail/i);
  });
});

// --------------------------------------------------------------------------
// FR-004: Scoring Integration
// --------------------------------------------------------------------------

describe('FR-004: test_validation scoring in forjis-assessor.md Step 3', () => {
  it('test_validation scoring sub-section exists in Step 3', () => {
    // Get content after Step 3 heading
    const step3Idx = assessorContent.indexOf('## Step 3:');
    const step4Idx = assessorContent.indexOf('## Step 4:');
    const step3Content = assessorContent.substring(step3Idx, step4Idx);
    expect(step3Content).toMatch(/test_validation/i);
  });

  it('scoring instructs weighted average pass rate (0-100)', () => {
    expect(assessorContent).toMatch(/weighted average/i);
  });

  it('scoring instructs score 100 when no test tools found', () => {
    // "no test tools found" -> 100
    expect(assessorContent).toMatch(/no test.*found.*100|100.*no test.*found|Score 100.*no test|no test tools found.*Score 100/i);
  });

  it('scoring instructs score 100 when tests skipped due to safety guardrails', () => {
    expect(assessorContent).toMatch(/safety.*100|100.*safety|skipped.*safety.*100|safety.*guardrails.*Score 100/i);
  });

  it('scoring instructs score 50 when test commands fail to start', () => {
    expect(assessorContent).toMatch(/fail.*start.*50|50.*fail.*start|startup.*fail.*50|Score 50/i);
  });

  it('scoring instructs including failing test names in notes', () => {
    expect(assessorContent).toMatch(/failing test names|failing.*test.*names/i);
  });
});
