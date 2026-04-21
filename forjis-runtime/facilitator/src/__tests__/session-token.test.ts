/**
 * Unit tests for the Inspector session-token registry.
 *
 * Covers the contract declared in
 * `openspec/changes/inspector-002-facilitator-websocket/specs/session-token-registry/spec.md`:
 *   FR-001 — `generateSessionToken` produces 256-bit base64url values.
 *   FR-002 — `register` persists metadata and rejects duplicates.
 *   FR-003 — `validate` returns metadata for known tokens and `null` otherwise.
 *   FR-004 — `revoke` removes a token and reports success / absence.
 *   FR-005 — Size getter reflects registration and revocation.
 *   NFR-001 — `SessionTokenAlreadyRegisteredError.message` never contains
 *             the token value.
 */

import { describe, expect, it } from '@jest/globals';
import {
  generateSessionToken,
  SessionTokenAlreadyRegisteredError,
  SessionTokenRegistry,
  type SessionMetadata,
} from '../session-token.js';

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

describe('generateSessionToken', () => {
  it('returns a 43-character base64url string', () => {
    const token = generateSessionToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(BASE64URL_RE);
  });

  it('returns a different token on each call', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      tokens.add(generateSessionToken());
    }
    expect(tokens.size).toBe(1000);
  });

  it('contains only base64url characters across many calls', () => {
    for (let i = 0; i < 100; i += 1) {
      const token = generateSessionToken();
      expect(token).toMatch(BASE64URL_RE);
    }
  });
});

describe('SessionTokenRegistry', () => {
  it('validate returns null for an unknown token', () => {
    const registry = new SessionTokenRegistry();
    expect(registry.validate('unknown')).toBeNull();
  });

  it('validate returns null for the empty string', () => {
    const registry = new SessionTokenRegistry();
    expect(registry.validate('')).toBeNull();
  });

  it('register + validate round-trips metadata', () => {
    const registry = new SessionTokenRegistry();
    const meta: SessionMetadata = {
      label: 'x',
      createdAt: '2026-04-21T00:00:00Z',
    };
    registry.register('t-1', meta);
    expect(registry.validate('t-1')).toEqual(meta);
  });

  it('register throws SessionTokenAlreadyRegisteredError on duplicate', () => {
    const registry = new SessionTokenRegistry();
    const token = 'secret-token-value-XYZ';
    registry.register(token, { label: 'x', createdAt: '2026-04-21T00:00:00Z' });
    let caught: unknown;
    try {
      registry.register(token, { label: 'y', createdAt: '2026-04-21T00:00:01Z' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SessionTokenAlreadyRegisteredError);
    const typedErr = caught as SessionTokenAlreadyRegisteredError;
    expect(typedErr.message).not.toContain(token);
    expect(typedErr.token).toBe(token);
    expect(typedErr.name).toBe('SessionTokenAlreadyRegisteredError');
  });

  it('revoke returns true for a registered token and removes it', () => {
    const registry = new SessionTokenRegistry();
    registry.register('t-1', { label: 'x', createdAt: '2026-04-21T00:00:00Z' });
    expect(registry.revoke('t-1')).toBe(true);
    expect(registry.validate('t-1')).toBeNull();
  });

  it('revoke returns false for a token that was never registered', () => {
    const registry = new SessionTokenRegistry();
    expect(registry.revoke('nope')).toBe(false);
  });

  it('size reflects registered tokens after add and revoke', () => {
    const registry = new SessionTokenRegistry();
    registry.register('a', { label: 'a', createdAt: '2026-04-21T00:00:00Z' });
    registry.register('b', { label: 'b', createdAt: '2026-04-21T00:00:00Z' });
    registry.register('c', { label: 'c', createdAt: '2026-04-21T00:00:00Z' });
    expect(registry.size).toBe(3);
    expect(registry.revoke('b')).toBe(true);
    expect(registry.size).toBe(2);
  });
});
