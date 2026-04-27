/**
 * Unit tests for build-file.ts — parser and validator.
 *
 * Migrated from facilitator with updated imports. Extended with
 * FR-026 (outcome groups) and FR-027 (role outcomes) tests.
 */

import { parseBuildFile, parseDuration } from '../build-file.js';
import { BuildFileValidationError } from '../errors.js';

// --------------------------------------------------------------------------
// parseDuration
// --------------------------------------------------------------------------

describe('parseDuration', () => {
  it('parses seconds correctly', () => {
    expect(parseDuration('30s')).toBe(30_000);
  });

  it('parses minutes correctly', () => {
    expect(parseDuration('5m')).toBe(300_000);
  });

  it('parses hours correctly', () => {
    expect(parseDuration('1h')).toBe(3_600_000);
  });

  it('throws for invalid format', () => {
    expect(() => parseDuration('10x')).toThrow(BuildFileValidationError);
  });
});

// --------------------------------------------------------------------------
// parseBuildFile — version validation
// --------------------------------------------------------------------------

describe('parseBuildFile — version validation', () => {
  it('throws when version is missing', () => {
    const yaml = `repositories:\n  - type: git\n    url: "https://github.com/a/b.git"\n    ref: v1`;
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect((err as BuildFileValidationError).errors.some(e => e.includes('"version" is required'))).toBe(true);
    }
  });

  it('throws for unsupported version', () => {
    const yaml = `version: 2\nrepositories:\n  - type: git\n    url: "https://github.com/a/b.git"\n    ref: v1`;
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect((err as BuildFileValidationError).errors.some(e => e.includes('Unsupported version'))).toBe(true);
    }
  });

  it('accepts version 1', () => {
    const yaml = `version: 1\nrepositories:\n  - type: git\n    url: "https://github.com/a/b.git"\n    ref: v1`;
    const config = parseBuildFile(yaml);
    expect(config.version).toBe(1);
  });
});

// --------------------------------------------------------------------------
// parseBuildFile — repositories block
// --------------------------------------------------------------------------

describe('parseBuildFile — repositories block', () => {
  it('returns empty repositories when array is empty', () => {
    const yaml = `version: 1\nrepositories: []`;
    const config = parseBuildFile(yaml);
    expect(config.repositories).toEqual([]);
  });

  it('returns empty repositories when key is missing', () => {
    const yaml = `version: 1`;
    const config = parseBuildFile(yaml);
    expect(config.repositories).toEqual([]);
  });

  it('returns empty repositories when key is null (commented entries)', () => {
    const yaml = `version: 1\nrepositories:\n  # - type: git\n  #   url: "https://a.git"\n  #   ref: v1`;
    const config = parseBuildFile(yaml);
    expect(config.repositories).toEqual([]);
  });

  it('throws for unknown repository type', () => {
    const yaml = `version: 1\nrepositories:\n  - type: ftp\n    url: "ftp://example.com"`;
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
  });

  it('parses a valid git repository entry', () => {
    const yaml = `version: 1\nrepositories:\n  - type: git\n    url: "https://github.com/org/repo.git"\n    ref: v1.0`;
    const config = parseBuildFile(yaml);
    expect(config.repositories).toHaveLength(1);
    expect(config.repositories[0].type).toBe('git');
  });

  it('parses a valid dir repository entry', () => {
    const yaml = `version: 1\nrepositories:\n  - type: dir\n    path: "/local/resources"`;
    const config = parseBuildFile(yaml);
    expect(config.repositories).toHaveLength(1);
    expect(config.repositories[0].type).toBe('dir');
  });
});

// --------------------------------------------------------------------------
// parseBuildFile — plugins block
// --------------------------------------------------------------------------

describe('parseBuildFile — plugins block', () => {
  it('returns empty plugins array when plugins block is omitted', () => {
    const yaml = `version: 1\nrepositories:\n  - type: git\n    url: "https://a.git"\n    ref: v1`;
    const config = parseBuildFile(yaml);
    expect(config.plugins).toEqual([]);
  });

  it('parses plugins array with name entries', () => {
    const yaml = [
      'version: 1',
      'repositories:',
      '  - type: git',
      '    url: "https://a.git"',
      '    ref: v1',
      'plugins:',
      '  - name: software-dev',
    ].join('\n');
    const config = parseBuildFile(yaml);
    expect(config.plugins).toHaveLength(1);
    expect(config.plugins[0].name).toBe('software-dev');
  });
});

// --------------------------------------------------------------------------
// parseBuildFile — orgs block
// --------------------------------------------------------------------------

describe('parseBuildFile — orgs block', () => {
  const baseYaml = [
    'version: 1',
    'repositories:',
    '  - type: git',
    '    url: "https://a.git"',
    '    ref: v1',
  ].join('\n');

  it('returns empty orgs when block is omitted', () => {
    const config = parseBuildFile(baseYaml);
    expect(config.orgs).toEqual([]);
  });

  it('parses org with extends and role hooks', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'orgs:',
      '  - name: my-team',
      '    extends: "plugin:orgName"',
      '    roles:',
      '      - name: MyRole',
      '        agent: my-agent',
      '        hooks:',
      '          pre:',
      '            - security-check',
      '          validation: []',
      '          post: []',
    ].join('\n');
    const config = parseBuildFile(yaml);
    expect(config.orgs).toHaveLength(1);
    const org = config.orgs[0];
    expect(org.extends).toBe('plugin:orgName');
    expect(org.roles[0].hooks?.pre).toContain('security-check');
  });
});

// --------------------------------------------------------------------------
// parseBuildFile — orgs with teams
// --------------------------------------------------------------------------

describe('parseBuildFile — orgs with teams', () => {
  const baseYaml = [
    'version: 1',
    'repositories:',
    '  - type: git',
    '    url: "https://a.git"',
    '    ref: v1',
  ].join('\n');

  it('parses org with teams and nested roles', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'orgs:',
      '  - name: my-org',
      '    teams:',
      '      - name: backend',
      '        roles:',
      '          - name: Developer',
      '            agent: dev-agent',
    ].join('\n');
    const config = parseBuildFile(yaml);
    expect(config.orgs[0].teams).toHaveLength(1);
    expect(config.orgs[0].teams![0].roles[0].name).toBe('Developer');
  });

  it('throws when org has both teams and roles', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'orgs:',
      '  - name: my-org',
      '    roles:',
      '      - name: Developer',
      '        agent: dev-agent',
      '    teams:',
      '      - name: backend',
      '        roles:',
      '          - name: Designer',
      '            agent: design-agent',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
  });
});

// --------------------------------------------------------------------------
// parseBuildFile — tasks block
// --------------------------------------------------------------------------

describe('parseBuildFile — tasks block', () => {
  const baseYaml = [
    'version: 1',
    'repositories:',
    '  - type: git',
    '    url: "https://a.git"',
    '    ref: v1',
  ].join('\n');

  it('returns null tasks when block is omitted', () => {
    const config = parseBuildFile(baseYaml);
    expect(config.tasks).toBeNull();
  });

  it('converts poll_interval string to milliseconds', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'tasks:',
      '  source: dir',
      '  path: "./tasks"',
      '  poll_interval: "5m"',
    ].join('\n');
    const config = parseBuildFile(yaml);
    expect(config.tasks?.pollIntervalMs).toBe(300_000);
  });
});

// --------------------------------------------------------------------------
// parseBuildFile — outcome block
// --------------------------------------------------------------------------

describe('parseBuildFile — outcome block', () => {
  const baseYaml = [
    'version: 1',
    'repositories:',
    '  - type: git',
    '    url: "https://a.git"',
    '    ref: v1',
  ].join('\n');

  it('returns null outcome when block is omitted', () => {
    const config = parseBuildFile(baseYaml);
    expect(config.outcome).toBeNull();
  });

  it('parses outcome block with fail and warning rules', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'outcome:',
      '  enabled: true',
      '  default_action: halt',
      '  default_max_retries: 1',
      '  rules:',
      '    - fail: "completeness < 80"',
      '      action: retry',
      '      max_retries: 2',
      '    - warning: "speculation > 25"',
    ].join('\n');
    const config = parseBuildFile(yaml);
    expect(config.outcome?.rules).toHaveLength(2);
    const failRule = config.outcome?.rules.find(r => r.type === 'fail');
    expect(failRule?.expression).toBe('completeness < 80');
    expect(failRule?.action).toBe('retry');
  });

  it('throws when a rule has both fail and warning', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'outcome:',
      '  rules:',
      '    - fail: "completeness < 80"',
      '      warning: "speculation > 25"',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
  });
});

// --------------------------------------------------------------------------
// parseBuildFile — outcome groups (FR-026)
// --------------------------------------------------------------------------

describe('parseBuildFile — outcome groups (FR-026)', () => {
  const baseYaml = [
    'version: 1',
    'repositories:',
    '  - type: git',
    '    url: "https://a.git"',
    '    ref: v1',
  ].join('\n');

  it('parses named outcome groups with per-group metrics and rules', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'outcome:',
      '  default_action: halt',
      '  default_max_retries: 1',
      '  groups:',
      '    - name: default',
      '      metrics:',
      '        completeness:',
      '          description: "Task completeness"',
      '          criteria:',
      '            - "All tasks done"',
      '          scale: "0-100"',
      '      rules:',
      '        - fail: "completeness < 70"',
      '          action: halt',
      '    - name: security',
      '      metrics:',
      '        security_score:',
      '          description: "Security assessment"',
      '          criteria:',
      '            - "No known CVEs"',
      '          scale: "0-100"',
      '      rules:',
      '        - fail: "security_score < 80"',
    ].join('\n');

    const config = parseBuildFile(yaml);
    expect(config.outcome?.groups).toHaveLength(2);
    expect(config.outcome?.groups![0].name).toBe('default');
    expect(config.outcome?.groups![0].metrics['completeness']).toBeDefined();
    expect(config.outcome?.groups![0].rules).toHaveLength(1);
    expect(config.outcome?.groups![1].name).toBe('security');
  });

  it('still accepts flat outcome format (backward compat)', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'outcome:',
      '  rules:',
      '    - fail: "completeness < 70"',
    ].join('\n');

    const config = parseBuildFile(yaml);
    expect(config.outcome?.rules).toHaveLength(1);
    expect(config.outcome?.groups).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// parseBuildFile — role outcomes (FR-027)
// --------------------------------------------------------------------------

describe('parseBuildFile — role outcomes (FR-027)', () => {
  const baseYaml = [
    'version: 1',
    'repositories:',
    '  - type: git',
    '    url: "https://a.git"',
    '    ref: v1',
  ].join('\n');

  it('parses outcomes array on role definitions', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'orgs:',
      '  - name: my-org',
      '    roles:',
      '      - name: Developer',
      '        agent: dev-agent',
      '        outcomes:',
      '          - default',
      '          - security',
    ].join('\n');

    const config = parseBuildFile(yaml);
    expect(config.orgs[0].roles[0].outcomes).toEqual(['default', 'security']);
  });

  it('role without outcomes property has no outcomes field', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'orgs:',
      '  - name: my-org',
      '    roles:',
      '      - name: Developer',
      '        agent: dev-agent',
    ].join('\n');

    const config = parseBuildFile(yaml);
    expect(config.orgs[0].roles[0].outcomes).toBeUndefined();
  });
});

// --------------------------------------------------------------------------
// parseBuildFile — constraints block
// --------------------------------------------------------------------------

describe('parseBuildFile — constraints block', () => {
  const baseYaml = [
    'version: 1',
    'repositories:',
    '  - type: git',
    '    url: "https://a.git"',
    '    ref: v1',
  ].join('\n');

  it('parses specific constraint include entry', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'constraints:',
      '  include:',
      '    - "my-plugin:git"',
    ].join('\n');
    const config = parseBuildFile(yaml);
    expect(config.constraints!.include[0].pluginName).toBe('my-plugin');
    expect(config.constraints!.include[0].groupName).toBe('git');
  });

  it('returns null constraints when key is absent', () => {
    const config = parseBuildFile(baseYaml);
    expect(config.constraints).toBeNull();
  });
});

// --------------------------------------------------------------------------
// parseBuildFile — constraints pillars validation
// --------------------------------------------------------------------------

describe('parseBuildFile — constraints pillars', () => {
  const baseYaml = [
    'version: 1',
    'repositories:',
    '  - type: git',
    '    url: "https://a.git"',
    '    ref: v1',
  ].join('\n');

  it('parses valid pillars array successfully', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'constraints:',
      '  pillars:',
      '    - "specs/architecture.md"',
      '    - "specs/data-model.md"',
    ].join('\n');
    const config = parseBuildFile(yaml);
    expect(config.constraints!.pillars).toEqual(['specs/architecture.md', 'specs/data-model.md']);
  });

  it('defaults pillars to empty array when omitted', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'constraints:',
      '  mandatory: "Do not use eval"',
    ].join('\n');
    const config = parseBuildFile(yaml);
    expect(config.constraints!.pillars).toEqual([]);
  });

  it('produces validation error when pillars is not an array', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'constraints:',
      '  pillars: "single-string.md"',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect((err as BuildFileValidationError).errors.some(
        e => e.includes('constraints.pillars: must be an array')
      )).toBe(true);
    }
  });

  it('produces validation error for non-string pillar element', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'constraints:',
      '  pillars:',
      '    - 123',
      '    - "valid.md"',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect((err as BuildFileValidationError).errors.some(
        e => e.includes('constraints.pillars[0]: must be a string')
      )).toBe(true);
    }
  });

  it('produces validation error for empty string pillar', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'constraints:',
      '  pillars:',
      '    - ""',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect((err as BuildFileValidationError).errors.some(
        e => e.includes('constraints.pillars[0]: must be a non-empty string')
      )).toBe(true);
    }
  });
});

// --------------------------------------------------------------------------
// parseBuildFile — minimal valid file
// --------------------------------------------------------------------------

describe('parseBuildFile — minimal valid file', () => {
  it('accepts a file with only version and one git repository', () => {
    const yaml = [
      'version: 1',
      'repositories:',
      '  - type: git',
      '    url: "https://github.com/org/repo.git"',
      '    ref: v1.0',
    ].join('\n');
    const config = parseBuildFile(yaml);
    expect(config.version).toBe(1);
    expect(config.repositories).toHaveLength(1);
    expect(config.plugins).toEqual([]);
    expect(config.orgs).toEqual([]);
    expect(config.tasks).toBeNull();
    expect(config.outcome).toBeNull();
  });

  it('accepts a file with only version (no repositories)', () => {
    const yaml = 'version: 1';
    const config = parseBuildFile(yaml);
    expect(config.version).toBe(1);
    expect(config.repositories).toEqual([]);
    expect(config.plugins).toEqual([]);
  });
});

// --------------------------------------------------------------------------
// parseBuildFile — inspector block
// --------------------------------------------------------------------------

describe('parseBuildFile — inspector block', () => {
  const baseYaml = [
    'version: 1',
    'repositories:',
    '  - type: git',
    '    url: "https://a.git"',
    '    ref: v1',
  ].join('\n');

  it('returns null inspector when key is absent', () => {
    const config = parseBuildFile(baseYaml);
    expect(config.inspector).toBeNull();
  });

  it('parses inspector.clarifier as a string', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'inspector:',
      '  clarifier: "my-custom.md"',
    ].join('\n');
    const config = parseBuildFile(yaml);
    expect(config.inspector).toEqual({ clarifier: 'my-custom.md' });
  });

  it('returns empty inspector object when clarifier is omitted but block present', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'inspector: {}',
    ].join('\n');
    const config = parseBuildFile(yaml);
    expect(config.inspector).toEqual({});
  });

  it('rejects non-string clarifier', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'inspector:',
      '  clarifier: 42',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect((err as BuildFileValidationError).errors.some(
        e => e.includes('inspector.clarifier: must be a string')
      )).toBe(true);
    }
  });

  it('rejects unknown key inside inspector', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'inspector:',
      '  unknown_key: "x"',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect((err as BuildFileValidationError).errors.some(
        e => e.includes('inspector: unrecognized key "unknown_key"')
      )).toBe(true);
    }
  });

  it('rejects non-object inspector', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'inspector: "not-an-object"',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect((err as BuildFileValidationError).errors.some(
        e => e.includes('"inspector" must be an object')
      )).toBe(true);
    }
  });
});

// --------------------------------------------------------------------------
// parseBuildFile — context block (cache-harden R7)
// --------------------------------------------------------------------------

describe('parseBuildFile — context block', () => {
  const baseYaml = [
    'version: 1',
    'repositories:',
    '  - type: git',
    '    url: "https://a.git"',
    '    ref: v1',
  ].join('\n');

  it('applies defaults when the context block is omitted', () => {
    const config = parseBuildFile(baseYaml);
    expect(config.context.refresh_on_task).toBe(true);
    expect(config.context.inline_top_n).toBe(20);
  });

  it('applies defaults when context is explicitly null', () => {
    const yaml = [...baseYaml.split('\n'), 'context: ~'].join('\n');
    const config = parseBuildFile(yaml);
    expect(config.context.refresh_on_task).toBe(true);
    expect(config.context.inline_top_n).toBe(20);
  });

  it('accepts refresh_on_task: false', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'context:',
      '  refresh_on_task: false',
    ].join('\n');
    const config = parseBuildFile(yaml);
    expect(config.context.refresh_on_task).toBe(false);
    expect(config.context.inline_top_n).toBe(20);
  });

  it('accepts an explicit inline_top_n value', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'context:',
      '  inline_top_n: 5',
    ].join('\n');
    const config = parseBuildFile(yaml);
    expect(config.context.inline_top_n).toBe(5);
  });

  it('rejects an unknown key inside context', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'context:',
      '  refresh_on_foo: true',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect(
        (err as BuildFileValidationError).errors.some((e) =>
          e.includes('context: unrecognized key "refresh_on_foo"'),
        ),
      ).toBe(true);
    }
  });

  it('rejects inline_top_n: 0 (below range)', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'context:',
      '  inline_top_n: 0',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect(
        (err as BuildFileValidationError).errors.some((e) =>
          e.includes('context.inline_top_n'),
        ),
      ).toBe(true);
    }
  });

  it('rejects non-object / array context value', () => {
    const yaml = [...baseYaml.split('\n'), 'context: []'].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect(
        (err as BuildFileValidationError).errors.some((e) =>
          e.includes('context: must be a mapping'),
        ),
      ).toBe(true);
    }
  });

  it('rejects non-boolean refresh_on_task', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'context:',
      '  refresh_on_task: "yes"',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect(
        (err as BuildFileValidationError).errors.some((e) =>
          e.includes('context.refresh_on_task'),
        ),
      ).toBe(true);
    }
  });

  it('parses context.engine when present and leaves it undefined when absent', () => {
    const omitted = parseBuildFile(baseYaml);
    expect(omitted.context.engine).toBeUndefined();

    const withEngine = parseBuildFile(
      [
        ...baseYaml.split('\n'),
        'context:',
        '  engine: claude',
      ].join('\n'),
    );
    expect(withEngine.context.engine).toBe('claude');
  });

  it('rejects context.engine when empty or non-string', () => {
    const empty = [
      ...baseYaml.split('\n'),
      'context:',
      '  engine: ""',
    ].join('\n');
    expect(() => parseBuildFile(empty)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(empty);
    } catch (err) {
      expect(
        (err as BuildFileValidationError).errors.some((e) =>
          e.includes('context.engine'),
        ),
      ).toBe(true);
    }

    const wrongType = [
      ...baseYaml.split('\n'),
      'context:',
      '  engine: 42',
    ].join('\n');
    expect(() => parseBuildFile(wrongType)).toThrow(BuildFileValidationError);
  });

  it('defaults context.concurrency to 16 when the field is omitted', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'context:',
      '  refresh_on_task: true',
    ].join('\n');
    const config = parseBuildFile(yaml);
    expect(config.context.concurrency).toBe(16);
  });

  it('defaults context.concurrency to 16 when the entire context block is omitted', () => {
    const config = parseBuildFile(baseYaml);
    expect(config.context.concurrency).toBe(16);
  });

  it('accepts context.concurrency boundary values 1 and 32', () => {
    const lower = parseBuildFile(
      [
        ...baseYaml.split('\n'),
        'context:',
        '  concurrency: 1',
      ].join('\n'),
    );
    expect(lower.context.concurrency).toBe(1);

    const upper = parseBuildFile(
      [
        ...baseYaml.split('\n'),
        'context:',
        '  concurrency: 32',
      ].join('\n'),
    );
    expect(upper.context.concurrency).toBe(32);
  });

  it('rejects context.concurrency: 0 with the documented message', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'context:',
      '  concurrency: 0',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect(
        (err as BuildFileValidationError).errors.some((e) =>
          e.includes(
            'context.concurrency: must be an integer between 1 and 32',
          ),
        ),
      ).toBe(true);
    }
  });

  it('rejects context.concurrency: 33 (above range)', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'context:',
      '  concurrency: 33',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect(
        (err as BuildFileValidationError).errors.some((e) =>
          e.includes(
            'context.concurrency: must be an integer between 1 and 32',
          ),
        ),
      ).toBe(true);
    }
  });

  it('rejects context.concurrency: 100 (well above range)', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'context:',
      '  concurrency: 100',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect(
        (err as BuildFileValidationError).errors.some((e) =>
          e.includes(
            'context.concurrency: must be an integer between 1 and 32',
          ),
        ),
      ).toBe(true);
    }
  });

  it('rejects non-integer context.concurrency: 4.5', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'context:',
      '  concurrency: 4.5',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect(
        (err as BuildFileValidationError).errors.some((e) =>
          e.includes(
            'context.concurrency: must be an integer between 1 and 32',
          ),
        ),
      ).toBe(true);
    }
  });

  it('rejects string-typed context.concurrency: "8"', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'context:',
      '  concurrency: "8"',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect(
        (err as BuildFileValidationError).errors.some((e) =>
          e.includes(
            'context.concurrency: must be an integer between 1 and 32',
          ),
        ),
      ).toBe(true);
    }
  });

  it('lists concurrency in the unknown-key error message', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'context:',
      '  refresh_on_xyz: true',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect(
        (err as BuildFileValidationError).errors.some((e) =>
          e.includes('concurrency'),
        ),
      ).toBe(true);
    }
  });

  it('parses context.model when present and returns the value verbatim', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'context:',
      '  model: haiku',
    ].join('\n');
    const config = parseBuildFile(yaml);
    expect(config.context.model).toBe('haiku');
  });

  it('defaults context.model to "sonnet" when the field is omitted', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'context:',
      '  refresh_on_task: true',
    ].join('\n');
    const config = parseBuildFile(yaml);
    expect(config.context.model).toBe('sonnet');
  });

  it('defaults context.model to "sonnet" when the entire context block is omitted', () => {
    const config = parseBuildFile(baseYaml);
    expect(config.context.model).toBe('sonnet');
  });

  it('parses a versioned model identifier verbatim without restriction', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'context:',
      '  model: claude-sonnet-4-6',
    ].join('\n');
    const config = parseBuildFile(yaml);
    expect(config.context.model).toBe('claude-sonnet-4-6');
  });

  it('rejects context.model: "" with a message naming the field', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'context:',
      '  model: ""',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect(
        (err as BuildFileValidationError).errors.some((e) =>
          e.includes('context.model'),
        ),
      ).toBe(true);
    }
  });

  it('lists model in the unknown-key error message', () => {
    const yaml = [
      ...baseYaml.split('\n'),
      'context:',
      '  totally_unknown: true',
    ].join('\n');
    expect(() => parseBuildFile(yaml)).toThrow(BuildFileValidationError);
    try {
      parseBuildFile(yaml);
    } catch (err) {
      expect(
        (err as BuildFileValidationError).errors.some((e) =>
          e.includes('model'),
        ),
      ).toBe(true);
    }
  });
});
