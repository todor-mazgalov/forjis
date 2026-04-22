/**
 * Unit tests for the `dispatchFailureIfInspector` helper exported by
 * `commands/run.ts`.
 *
 * The helper is exercised as a pure function here because the main
 * run-loop is private and not reachable through the public `runCommand`
 * entry without heavy module mocking. These tests assert the three
 * cases called out by FR-013-B-001:
 *
 * - inspector-sourced taskId fires exactly one `batch.failed` event.
 * - non-inspector taskId fires zero events.
 * - absent `inspectorService` is a silent no-op (no throw, no side
 *   effects).
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatchFailureIfInspector } from '../commands/run.js';
import {
  InspectorServiceImpl,
  type BatchFailedEventPayload,
} from '../web-services/inspector-service.js';

describe('dispatchFailureIfInspector', () => {
  it('emits batch.failed for inspector-prefixed task ids', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'forjis-dispatch-'));
    const stagingRoot = join(projectDir, '.forjis', 'inspector');
    const service = new InspectorServiceImpl({ projectDir, stagingRoot });

    try {
      const received: BatchFailedEventPayload[] = [];
      service.on('batch.failed', (payload: BatchFailedEventPayload) => {
        received.push(payload);
      });

      dispatchFailureIfInspector(service, 'inspector-task-1', projectDir, 'engine-error');

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual({
        batchId: 'inspector-task-1',
        taskId: 'inspector-task-1',
        taskPath: join(projectDir, '.forjis', 'tasks', 'inspector-task-1'),
        category: 'engine-error',
      });
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('does not emit for non-inspector task ids', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'forjis-dispatch-'));
    const stagingRoot = join(projectDir, '.forjis', 'inspector');
    const service = new InspectorServiceImpl({ projectDir, stagingRoot });

    try {
      const received: BatchFailedEventPayload[] = [];
      service.on('batch.failed', (payload: BatchFailedEventPayload) => {
        received.push(payload);
      });

      dispatchFailureIfInspector(service, 'task-cli-1', projectDir, 'engine-error');
      dispatchFailureIfInspector(service, 'inspector', projectDir, 'engine-error');
      dispatchFailureIfInspector(service, 'some-task', projectDir, 'shutdown');

      expect(received).toHaveLength(0);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('is a no-op when the service is undefined', () => {
    expect(() =>
      dispatchFailureIfInspector(undefined, 'inspector-foo', '/tmp/fake', 'engine-error'),
    ).not.toThrow();
  });

  it('forwards the correct category discriminator per call site', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'forjis-dispatch-'));
    const stagingRoot = join(projectDir, '.forjis', 'inspector');
    const service = new InspectorServiceImpl({ projectDir, stagingRoot });

    try {
      const received: BatchFailedEventPayload[] = [];
      service.on('batch.failed', (payload: BatchFailedEventPayload) => {
        received.push(payload);
      });

      dispatchFailureIfInspector(service, 'inspector-a', projectDir, 'shutdown');
      dispatchFailureIfInspector(service, 'inspector-b', projectDir, 'no-pipeline-state');
      dispatchFailureIfInspector(service, 'inspector-c', projectDir, 'engine-error');

      expect(received.map((r) => r.category)).toEqual([
        'shutdown',
        'no-pipeline-state',
        'engine-error',
      ]);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
