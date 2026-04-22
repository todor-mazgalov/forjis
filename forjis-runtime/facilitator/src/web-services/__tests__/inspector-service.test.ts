/**
 * Unit tests for InspectorServiceImpl (inspector-003).
 *
 * Validates FR-001 through FR-010 of the `inspector-003-inspector-service`
 * spec: batch creation, pin persistence + capture rewrite, screen dedup,
 * submit transitions, the concurrent-batch guard, reply-pin child batches,
 * and immutable snapshots via getBatch / listBatches. Each test runs
 * against a fresh service instance and a dedicated `mkdtemp` staging root,
 * and the root is removed in `afterEach` so no state leaks into the
 * repository's `.forjis/` tree.
 */

import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { Batch, Pin } from '@forjis/shared';

import {
  ConcurrentBatchError,
  InspectorServiceImpl,
  InvalidBatchIdError,
} from '../inspector-service.js';

/**
 * The 8-byte PNG magic signature used to construct a minimal synthetic
 * screenshot payload. The tests decode base64 → `Buffer` and assert the
 * first eight bytes match this signature.
 */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A minimal valid-looking PNG payload (signature + 4 arbitrary bytes). */
const PNG_PAYLOAD = Buffer.concat([PNG_SIGNATURE, Buffer.from([0x00, 0x00, 0x00, 0x0d])]);

/** Base64 of {@link PNG_PAYLOAD}. */
const PNG_BASE64 = PNG_PAYLOAD.toString('base64');

/** Base64-encoded JSON text used for the `computedStyles` field. */
const STYLES_BASE64 = Buffer.from(JSON.stringify({ color: 'red' }), 'utf-8').toString('base64');

/**
 * Build a minimal inbound pin with the supplied id, screen, and base64
 * capture payload.
 *
 * @param id - Pin identifier.
 * @param screen - Logical screen name or `null`.
 * @param captureBase64 - Base64 used for all three `capture.*` fields
 *   except `computedStyles`, which defaults to {@link STYLES_BASE64}.
 * @returns A fully populated {@link Pin}.
 */
function makePin(id: string, screen: string | null, captureBase64 = PNG_BASE64): Pin {
  return {
    id,
    platform: 'web',
    screen,
    target: {
      kind: 'element',
      source: null,
      selector: `#${id}`,
      componentName: null,
      bbox: { x: 0, y: 0, w: 10, h: 10 },
    },
    capture: {
      elementScreenshot: captureBase64,
      viewportScreenshot: captureBase64,
      computedStyles: STYLES_BASE64,
      annotations: [],
    },
    comment: `comment for ${id}`,
    createdAt: '2026-04-21T00:00:00.000Z',
    parentPinId: null,
  };
}

describe('InspectorServiceImpl', () => {
  let tmpProjectDir: string;
  let stagingRoot: string;
  let service: InspectorServiceImpl;

  beforeEach(async () => {
    tmpProjectDir = await mkdtemp(join(tmpdir(), 'forjis-inspector-'));
    stagingRoot = join(tmpProjectDir, '.forjis', 'inspector');
    service = new InspectorServiceImpl({ projectDir: tmpProjectDir, stagingRoot });
  });

  afterEach(async () => {
    await rm(tmpProjectDir, { recursive: true, force: true });
  });

  // ------------------------------------------------------------------
  // FR-001
  // ------------------------------------------------------------------

  it('createBatch allocates a staging directory and a well-formed batch', async () => {
    const batch = await service.createBatch('web');

    expect(batch.id).toMatch(/^batch-\d+-[0-9a-f]{8}$/);
    expect(batch.platform).toBe('web');
    expect(batch.pins).toEqual([]);
    expect(batch.screens).toEqual([]);
    expect(batch.parentBatchId).toBeNull();
    expect(batch.status).toBe('queued');
    expect(typeof batch.createdAt).toBe('string');

    await expect(stat(join(stagingRoot, batch.id))).resolves.toBeDefined();
  });

  it('createBatch produces distinct ids and distinct staging directories', async () => {
    const first = await service.createBatch('web');
    const second = await service.createBatch('web');

    expect(first.id).not.toBe(second.id);
    await expect(stat(join(stagingRoot, first.id))).resolves.toBeDefined();
    await expect(stat(join(stagingRoot, second.id))).resolves.toBeDefined();
  });

  // ------------------------------------------------------------------
  // FR-002
  // ------------------------------------------------------------------

  it('addPin writes PNG bytes to pin-01-element.png and rewrites capture fields', async () => {
    const batch = await service.createBatch('web');
    const pin = makePin('pin-a', '/login');

    await service.addPin(batch.id, pin);

    const elementPath = join(stagingRoot, batch.id, 'pin-01-element.png');
    const viewportPath = join(stagingRoot, batch.id, 'pin-01-viewport.png');
    const stylesPath = join(stagingRoot, batch.id, 'pin-01-styles.json');

    const elementBytes = await readFile(elementPath);
    expect(elementBytes.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
    expect(elementBytes.equals(PNG_PAYLOAD)).toBe(true);

    const viewportBytes = await readFile(viewportPath);
    expect(viewportBytes.equals(PNG_PAYLOAD)).toBe(true);

    const stylesBytes = await readFile(stylesPath);
    expect(JSON.parse(stylesBytes.toString('utf-8'))).toEqual({ color: 'red' });

    const stored = await service.getBatch(batch.id);
    expect(stored?.pins).toHaveLength(1);
    const storedPin = stored!.pins[0];
    expect(storedPin.capture.elementScreenshot).toBe(
      `.forjis/inspector/${batch.id}/pin-01-element.png`,
    );
    expect(storedPin.capture.viewportScreenshot).toBe(
      `.forjis/inspector/${batch.id}/pin-01-viewport.png`,
    );
    expect(storedPin.capture.computedStyles).toBe(
      `.forjis/inspector/${batch.id}/pin-01-styles.json`,
    );
    // Cross-platform: no backslashes must leak into the stored path.
    expect(storedPin.capture.elementScreenshot).not.toMatch(/\\/);
  });

  it('addPin does not mutate the caller-supplied pin object', async () => {
    const batch = await service.createBatch('web');
    const pin = makePin('pin-a', '/home');

    const originalElement = pin.capture.elementScreenshot;
    const originalViewport = pin.capture.viewportScreenshot;
    const originalStyles = pin.capture.computedStyles;

    await service.addPin(batch.id, pin);

    expect(pin.capture.elementScreenshot).toBe(originalElement);
    expect(pin.capture.viewportScreenshot).toBe(originalViewport);
    expect(pin.capture.computedStyles).toBe(originalStyles);
  });

  // ------------------------------------------------------------------
  // FR-003
  // ------------------------------------------------------------------

  it('addPin deduplicates batch.screens in order of first appearance', async () => {
    const batch = await service.createBatch('web');

    await service.addPin(batch.id, makePin('p1', '/login'));
    await service.addPin(batch.id, makePin('p2', '/home'));
    await service.addPin(batch.id, makePin('p3', '/login'));

    const fetched = await service.getBatch(batch.id);
    expect(fetched?.screens).toEqual(['/login', '/home']);
  });

  it('addPin with null screen does not append to batch.screens', async () => {
    const batch = await service.createBatch('web');

    await service.addPin(batch.id, makePin('p1', null));

    const fetched = await service.getBatch(batch.id);
    expect(fetched?.screens).toEqual([]);
  });

  // ------------------------------------------------------------------
  // FR-004
  // ------------------------------------------------------------------

  it('submitBatch transitions status to "clarifying" and emits batch.submitted', async () => {
    const batch = await service.createBatch('web');
    await service.addPin(batch.id, makePin('p1', '/home'));

    const observed: Batch[] = [];
    service.on('batch.submitted', (payload: { batch: Batch }) => {
      observed.push(payload.batch);
    });

    await service.submitBatch(batch.id);

    const fetched = await service.getBatch(batch.id);
    expect(fetched?.status).toBe('clarifying');

    expect(observed).toHaveLength(1);
    expect(observed[0].id).toBe(batch.id);
    expect(observed[0].status).toBe('clarifying');
  });

  // ------------------------------------------------------------------
  // FR-005
  // ------------------------------------------------------------------

  it('submitBatch throws ConcurrentBatchError when another batch is clarifying', async () => {
    const first = await service.createBatch('web');
    const second = await service.createBatch('web');

    await service.submitBatch(first.id);

    await expect(service.submitBatch(second.id)).rejects.toBeInstanceOf(ConcurrentBatchError);

    try {
      await service.submitBatch(second.id);
      throw new Error('expected ConcurrentBatchError');
    } catch (err) {
      expect(err).toBeInstanceOf(ConcurrentBatchError);
      const typed = err as ConcurrentBatchError;
      expect(typed.conflictingBatchId).toBe(first.id);
      expect(typed.message).toContain(second.id);
      // conflictingBatchId MUST be non-enumerable so it never appears in
      // default console.error / util.inspect output.
      expect(Object.keys(typed)).not.toContain('conflictingBatchId');
    }
  });

  it('submitBatch does NOT trigger ConcurrentBatchError when the prior batch was never submitted', async () => {
    // Reviewer spot-check: the guard must key off the other batch's status,
    // not merely its existence. A batch that was created but never submitted
    // is still in "queued" status and must NOT block a subsequent submit.
    const queuedNeighbour = await service.createBatch('web');
    const target = await service.createBatch('web');

    await expect(service.submitBatch(target.id)).resolves.toBeUndefined();

    const neighbourFetched = await service.getBatch(queuedNeighbour.id);
    const targetFetched = await service.getBatch(target.id);
    expect(neighbourFetched?.status).toBe('queued');
    expect(targetFetched?.status).toBe('clarifying');
  });

  // ------------------------------------------------------------------
  // FR-006
  // ------------------------------------------------------------------

  it('replyToPin creates a child batch with parent.json and the reply pin', async () => {
    const parentBatch = await service.createBatch('web');
    const parentPin = makePin('parent-1', '/home');
    await service.addPin(parentBatch.id, parentPin);

    const replyPin = makePin('reply-1', '/home');
    await service.replyToPin(parentPin.id, replyPin, 'fix typo');

    const batches = await service.listBatches();
    const child = batches.find(b => b.parentBatchId === parentBatch.id);
    expect(child).toBeDefined();
    expect(child!.status).toBe('queued');
    expect(child!.pins).toHaveLength(1);
    const storedReply = child!.pins[0];
    expect(storedReply.id).toBe(replyPin.id);
    expect(storedReply.parentPinId).toBe(parentPin.id);
    expect(storedReply.comment).toBe('fix typo');

    const parentJsonPath = join(stagingRoot, child!.id, 'parent.json');
    const raw = await readFile(parentJsonPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.parentBatchId).toBe(parentBatch.id);
    expect(parsed.childBatchId).toBe(child!.id);
    expect(parsed.parentTaskPath).toBeNull();
    expect(parsed.parentPin.id).toBe(parentPin.id);
    // parent.json captures the post-rewrite parent pin (paths, not base64).
    expect(parsed.parentPin.capture.elementScreenshot).toBe(
      `.forjis/inspector/${parentBatch.id}/pin-01-element.png`,
    );
    // Ordinary (non-failure) reply: both failure-context fields are
    // persisted as `null` so the on-disk schema is stable (inspector-013).
    expect(parsed.failureSummary).toBeNull();
    expect(parsed.failedTaskPath).toBeNull();
  });

  it('FR-013 — replyToPin forwards failureSummary and failedTaskPath into parent.json', async () => {
    const parentBatch = await service.createBatch('web');
    const parentPin = makePin('parent-f1', '/home');
    await service.addPin(parentBatch.id, parentPin);

    const replyPin = makePin('reply-f1', '/home');
    const failureSummary = 'Build failed in components/Card.tsx';
    const failedTaskPath = '.forjis/tasks/inspector-xyz';
    await service.replyToPin(
      parentPin.id,
      replyPin,
      'please add the missing import',
      failureSummary,
      failedTaskPath,
    );

    const batches = await service.listBatches();
    const child = batches.find(b => b.parentBatchId === parentBatch.id);
    expect(child).toBeDefined();

    const parentJsonPath = join(stagingRoot, child!.id, 'parent.json');
    const raw = await readFile(parentJsonPath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.failureSummary).toBe(failureSummary);
    expect(parsed.failedTaskPath).toBe(failedTaskPath);
    // Core parent linkage is still recorded alongside the new fields.
    expect(parsed.parentBatchId).toBe(parentBatch.id);
    expect(parsed.childBatchId).toBe(child!.id);
    expect(parsed.parentPin.id).toBe(parentPin.id);
  });

  // ------------------------------------------------------------------
  // FR-009
  // ------------------------------------------------------------------

  it('getBatch returns an immutable deep copy', async () => {
    const batch = await service.createBatch('web');
    await service.addPin(batch.id, makePin('p1', '/home'));

    const first = await service.getBatch(batch.id);
    expect(first).not.toBeNull();
    first!.pins.push({ ...first!.pins[0], id: 'injected' });

    const second = await service.getBatch(batch.id);
    expect(second!.pins).toHaveLength(1);
    expect(second!.pins[0].id).not.toBe('injected');
  });

  it('listBatches returns deep copies that do not mutate registry state', async () => {
    const a = await service.createBatch('web');
    const b = await service.createBatch('web');

    const listed = await service.listBatches();
    expect(listed.map(entry => entry.id).sort()).toEqual([a.id, b.id].sort());

    listed[0].pins.push({} as Pin);
    const reListed = await service.listBatches();
    for (const entry of reListed) {
      expect(entry.pins).toEqual([]);
    }
  });

  it('getBatch returns null for unknown ids', async () => {
    await expect(service.getBatch('does-not-exist')).resolves.toBeNull();
  });

  // ------------------------------------------------------------------
  // answerClarify
  // ------------------------------------------------------------------

  it('answerClarify emits clarify.answer and does not mutate state', async () => {
    const batch = await service.createBatch('web');
    const observed: Array<{ batchId: string; answer: unknown; clientId: string | null }> = [];
    service.on('clarify.answer', payload => observed.push(payload));

    await service.answerClarify(batch.id, {
      questionId: 'q1',
      optionId: 'a',
      freeText: null,
    });

    expect(observed).toEqual([
      {
        batchId: batch.id,
        answer: { questionId: 'q1', optionId: 'a', freeText: null },
        clientId: null,
      },
    ]);

    const fetched = await service.getBatch(batch.id);
    expect(fetched?.status).toBe('queued');
  });

  // ------------------------------------------------------------------
  // Defensive: addPin rejects for unknown / finalised batches.
  // ------------------------------------------------------------------

  it('addPin throws for unknown batch', async () => {
    await expect(service.addPin('missing', makePin('x', null))).rejects.toThrow(/missing/);
  });

  it('addPin throws once batch has left "queued"', async () => {
    const batch = await service.createBatch('web');
    await service.submitBatch(batch.id);
    await expect(service.addPin(batch.id, makePin('late', null))).rejects.toThrow(
      /no longer accepts pins/,
    );
  });

  // ------------------------------------------------------------------
  // inspector-016: adoptExternalBatch
  // ------------------------------------------------------------------

  it('adoptExternalBatch creates a queued batch with the supplied id and staging dir', async () => {
    const adopted = await service.adoptExternalBatch('client-batch-A', 'web');

    expect(adopted.id).toBe('client-batch-A');
    expect(adopted.platform).toBe('web');
    expect(adopted.status).toBe('queued');
    expect(adopted.pins).toEqual([]);
    expect(adopted.screens).toEqual([]);
    expect(adopted.parentBatchId).toBeNull();

    await expect(stat(join(stagingRoot, 'client-batch-A'))).resolves.toBeDefined();

    const fetched = await service.getBatch('client-batch-A');
    expect(fetched?.id).toBe('client-batch-A');
  });

  it('adoptExternalBatch is idempotent when called twice with the same id', async () => {
    const first = await service.adoptExternalBatch('A', 'web');
    const second = await service.adoptExternalBatch('A', 'web');

    expect(first.id).toBe('A');
    expect(second.id).toBe('A');
    expect(second.createdAt).toBe(first.createdAt);

    // Only one batch was registered — no duplicate entries.
    const listed = await service.listBatches();
    expect(listed.filter(entry => entry.id === 'A')).toHaveLength(1);
  });

  it('adoptExternalBatch rejects an empty identifier before touching disk', async () => {
    await expect(service.adoptExternalBatch('', 'web')).rejects.toBeInstanceOf(
      InvalidBatchIdError,
    );
    const listed = await service.listBatches();
    expect(listed).toHaveLength(0);
  });

  it.each([
    ['bad:id', ':'],
    ['bad@id', '@'],
    ['bad\nid', 'newline'],
    ['bad\tid', 'tab'],
  ])('adoptExternalBatch rejects reserved character in "%s" (%s)', async (id, _label) => {
    await expect(service.adoptExternalBatch(id, 'web')).rejects.toBeInstanceOf(
      InvalidBatchIdError,
    );
    // No staging dir must have been created for the rejected id.
    await expect(stat(join(stagingRoot, id))).rejects.toThrow();
    const listed = await service.listBatches();
    expect(listed.find(entry => entry.id === id)).toBeUndefined();
  });

  it('adoptExternalBatch throws ConcurrentBatchError while another batch is clarifying', async () => {
    const running = await service.createBatch('web');
    await service.submitBatch(running.id);

    await expect(service.adoptExternalBatch('later-batch', 'web')).rejects.toBeInstanceOf(
      ConcurrentBatchError,
    );

    // Guard fires before any filesystem / registry mutation — the rejected
    // id must not appear in listBatches and must not have a staging dir.
    const listed = await service.listBatches();
    expect(listed.find(entry => entry.id === 'later-batch')).toBeUndefined();
    await expect(stat(join(stagingRoot, 'later-batch'))).rejects.toThrow();
  });

  it('adoptExternalBatch is still idempotent while another batch is clarifying', async () => {
    // Adopt first, THEN submit a different batch — the concurrent guard
    // must not re-fire for an already-registered id because idempotency
    // short-circuits before the guard.
    const adopted = await service.adoptExternalBatch('stable-id', 'web');
    const other = await service.createBatch('web');
    await service.submitBatch(other.id);

    const again = await service.adoptExternalBatch('stable-id', 'web');
    expect(again.id).toBe(adopted.id);
    expect(again.createdAt).toBe(adopted.createdAt);
  });
});
