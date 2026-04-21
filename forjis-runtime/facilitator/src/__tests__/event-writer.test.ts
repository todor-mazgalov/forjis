/**
 * Unit tests for event-writer.ts — buildEventPath identity routing.
 *
 * Focused coverage for the filename contract introduced by the
 * fix-roles-display change: the role-scoped file name must be
 * `events-<canonicalSlug(identity)>.jsonl` when a `{org, team, role}`
 * triple is supplied, and `events.jsonl` otherwise.
 */

import { join } from 'node:path';

import { buildEventPath } from '../web-services/event-writer.js';

describe('buildEventPath', () => {
  const projectDir = '/tmp/proj';
  const taskId = 'task-x';
  const taskDir = join(projectDir, '.forjis', 'tasks', taskId);

  it('returns the fallback path when no identity is supplied', () => {
    expect(buildEventPath(projectDir, taskId)).toBe(join(taskDir, 'events.jsonl'));
  });

  it('returns the identity-slugged path when a triple is supplied', () => {
    expect(
      buildEventPath(projectDir, taskId, { org: 'Acme', team: 'Dev', role: 'Architect' }),
    ).toBe(join(taskDir, 'events-acme-dev-architect.jsonl'));
  });

  it('normalises whitespace and reserved-feeling characters in names', () => {
    expect(
      buildEventPath(projectDir, taskId, {
        org: 'Acme Co',
        team: 'Frontend',
        role: 'Architect (Frontend)',
      }),
    ).toBe(join(taskDir, 'events-acme-co-frontend-architect-frontend.jsonl'));
  });

  it('produces stable filenames across repeated calls', () => {
    const a = buildEventPath(projectDir, taskId, { org: 'o', team: 't', role: 'r' });
    const b = buildEventPath(projectDir, taskId, { org: 'o', team: 't', role: 'r' });
    expect(a).toBe(b);
  });
});
