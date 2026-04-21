/**
 * Unit tests for the Inspector v1.0 wire protocol contract.
 *
 * Two concerns are covered:
 *
 * 1. `InspectorMessage` exhaustiveness — a local `assertExhaustive` switch
 *    combined with a `never`-assignment guarantees compile-time failure if
 *    any case is ever removed or a new `type` is added without handling it.
 *    The runtime test exercises every branch to ensure the compile-time
 *    check and the on-wire contract stay in sync.
 * 2. `Pin` serialization round-trip — asserts that a fully-populated and a
 *    minimally-populated `Pin` both survive `JSON.parse(JSON.stringify(...))`
 *    with deep equality. This guards against any future field type that
 *    would break the wire-native contract (Date, Map, Set, function fields,
 *    or `undefined`-valued keys).
 */

import {
  PROTOCOL_VERSION,
  type Annotation,
  type ClarifyAnswer,
  type ClarifyQuestion,
  type InspectorMessage,
  type Pin,
} from '../inspector-types.js';

/**
 * Exhaustive switch over {@link InspectorMessage}.
 *
 * Returns a short descriptive string for each case. The trailing
 * `never`-assignment ensures the TypeScript compiler rejects any future edit
 * that removes a case or adds a new `type` without handling it here.
 *
 * @param msg - Any Inspector wire message.
 * @returns A short, human-readable description of the message type.
 */
function assertExhaustive(msg: InspectorMessage): string {
  switch (msg.type) {
    case 'session.join':
      return `session.join:${msg.platform}`;
    case 'session.ack':
      return `session.ack:${msg.protocolVersion}`;
    case 'session.error':
      return `session.error:${msg.code}`;
    case 'pin.create':
      return `pin.create:${msg.pin.id}`;
    case 'pin.ack':
      return `pin.ack:${msg.pinId}`;
    case 'batch.submit':
      return `batch.submit:${msg.batchId}`;
    case 'clarify.question':
      return `clarify.question:${msg.question.id}`;
    case 'clarify.answer':
      return `clarify.answer:${msg.answer.questionId}`;
    case 'batch.finalize':
      return `batch.finalize:${msg.taskPath}`;
    case 'task.status':
      return `task.status:${msg.status}`;
    case 'reply.create':
      return `reply.create:${msg.pin.id}`;
    case 'batch.abort':
      return `batch.abort:${msg.batchId}`;
    default: {
      // Compile-time exhaustiveness guard: if a new case is added to
      // InspectorMessage without a matching `case` above, `msg` will not be
      // assignable to `never` and `tsc` will fail the build here.
      const _exhaustive: never = msg;
      return _exhaustive;
    }
  }
}

/**
 * Build a fully-populated {@link Pin} with every nullable field set and one
 * {@link Annotation} of each kind.
 */
function buildFullyPopulatedPin(): Pin {
  const annotations: Annotation[] = [
    { kind: 'box', bbox: { x: 0, y: 0, w: 10, h: 10 } },
    { kind: 'arrow', bbox: { x: 5, y: 5, w: 20, h: 20 } },
    { kind: 'text', bbox: { x: 1, y: 2, w: 3, h: 4 }, text: 'label' },
  ];
  return {
    id: 'pin-1',
    platform: 'web',
    screen: 'home',
    target: {
      kind: 'element',
      source: { file: 'src/App.tsx', line: 42, col: 7 },
      selector: '#cta',
      componentName: 'CallToAction',
      bbox: { x: 10, y: 20, w: 100, h: 30 },
    },
    capture: {
      elementScreenshot: 'data:image/png;base64,AAA',
      viewportScreenshot: 'data:image/png;base64,BBB',
      computedStyles: '{"color":"red"}',
      annotations,
    },
    comment: 'Looks wrong on small screens.',
    createdAt: '2026-04-21T12:00:00.000Z',
    parentPinId: 'pin-0',
  };
}

/**
 * Build a {@link Pin} with every nullable field set to `null` and no
 * annotations, to guard the `null` branches of the wire type.
 */
function buildMinimallyPopulatedPin(): Pin {
  return {
    id: 'pin-2',
    platform: 'compose',
    screen: null,
    target: {
      kind: 'region',
      source: null,
      selector: 'region:0,0,100,100',
      componentName: null,
      bbox: { x: 0, y: 0, w: 100, h: 100 },
    },
    capture: {
      elementScreenshot: '',
      viewportScreenshot: '',
      computedStyles: '',
      annotations: [],
    },
    comment: '',
    createdAt: '2026-04-21T12:00:00.000Z',
    parentPinId: null,
  };
}

describe('InspectorMessage exhaustiveness', () => {
  it('discriminates every InspectorMessage case', () => {
    const pin = buildFullyPopulatedPin();
    const question: ClarifyQuestion = {
      id: 'q-1',
      text: 'Which variant do you mean?',
      options: [
        { id: 'opt-1', label: 'Primary', description: 'The primary CTA.' },
      ],
      allowFreeText: true,
    };
    const answer: ClarifyAnswer = {
      questionId: 'q-1',
      optionId: 'opt-1',
      freeText: null,
    };
    const cases: InspectorMessage[] = [
      { type: 'session.join', token: 't', platform: 'web', clientId: 'c' },
      {
        type: 'session.ack',
        sessionId: 's',
        protocolVersion: PROTOCOL_VERSION,
      },
      { type: 'session.error', code: 'E_BAD_TOKEN', message: 'bad token' },
      { type: 'pin.create', batchId: 'b', pin },
      { type: 'pin.ack', pinId: pin.id },
      { type: 'batch.submit', batchId: 'b' },
      { type: 'clarify.question', batchId: 'b', question },
      { type: 'clarify.answer', batchId: 'b', answer },
      { type: 'batch.finalize', batchId: 'b', taskPath: 'tasks/001/task.md' },
      { type: 'task.status', batchId: 'b', status: 'running' },
      { type: 'reply.create', parentPinId: pin.id, pin, comment: 'reply' },
      { type: 'batch.abort', batchId: 'b' },
    ];
    expect(cases).toHaveLength(12);
    for (const msg of cases) {
      expect(typeof assertExhaustive(msg)).toBe('string');
    }
  });

  it('freezes the v1.0 protocol version', () => {
    expect(PROTOCOL_VERSION).toBe('forjis-inspector/1.0');
  });
});

describe('Pin serialization round-trip', () => {
  it('preserves a fully-populated Pin across JSON round-trip', () => {
    const pin = buildFullyPopulatedPin();
    const roundTripped: Pin = JSON.parse(JSON.stringify(pin));
    expect(roundTripped).toEqual(pin);
  });

  it('preserves a minimally-populated Pin with null branches', () => {
    const pin = buildMinimallyPopulatedPin();
    const roundTripped: Pin = JSON.parse(JSON.stringify(pin));
    expect(roundTripped).toEqual(pin);
    expect(roundTripped.screen).toBeNull();
    expect(roundTripped.parentPinId).toBeNull();
    expect(roundTripped.target.source).toBeNull();
    expect(roundTripped.target.componentName).toBeNull();
    expect(roundTripped.capture.annotations).toEqual([]);
  });
});
