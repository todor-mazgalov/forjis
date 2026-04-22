/**
 * Focused unit tests for {@link InspectorServiceImpl}'s `batch.failed`
 * event contract.
 *
 * The broader service behaviour (batch lifecycle, pin persistence,
 * reply flow) is exercised by the integration-style tests attached to
 * the message pump and the clarifier runner; this file only asserts
 * the new typed emitter helper added by task
 * `inspector-013-failure-surface`.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  InspectorServiceImpl,
  type BatchFailedEventPayload,
} from '../web-services/inspector-service.js';

describe('InspectorServiceImpl — emitBatchFailed', () => {
  it('delivers the payload to every batch.failed subscriber exactly once', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'forjis-inspector-service-'));
    const stagingRoot = join(projectDir, '.forjis', 'inspector');
    const service = new InspectorServiceImpl({ projectDir, stagingRoot });

    try {
      const received: BatchFailedEventPayload[] = [];
      service.on('batch.failed', (payload: BatchFailedEventPayload) => {
        received.push(payload);
      });

      const payload: BatchFailedEventPayload = {
        batchId: 'inspector-demo',
        taskId: 'inspector-demo',
        taskPath: join(projectDir, '.forjis', 'tasks', 'inspector-demo'),
        category: 'engine-error',
      };

      service.emitBatchFailed(payload);

      expect(received).toHaveLength(1);
      expect(received[0]).toEqual(payload);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it('delivers independently to multiple subscribers', async () => {
    const projectDir = await mkdtemp(join(tmpdir(), 'forjis-inspector-service-'));
    const stagingRoot = join(projectDir, '.forjis', 'inspector');
    const service = new InspectorServiceImpl({ projectDir, stagingRoot });

    try {
      let aCount = 0;
      let bCount = 0;
      service.on('batch.failed', () => {
        aCount += 1;
      });
      service.on('batch.failed', () => {
        bCount += 1;
      });

      service.emitBatchFailed({
        batchId: 'inspector-1',
        taskId: 'inspector-1',
        taskPath: join(projectDir, '.forjis', 'tasks', 'inspector-1'),
        category: 'shutdown',
      });

      expect(aCount).toBe(1);
      expect(bCount).toBe(1);
    } finally {
      await rm(projectDir, { recursive: true, force: true });
    }
  });
});
