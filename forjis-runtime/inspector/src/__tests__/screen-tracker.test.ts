/**
 * Unit tests for `queue/screen-tracker.ts`.
 *
 * Covers FR-010-030 scenarios 1..4 (initial pathname, pushState updates,
 * replaceState updates, popstate updates, destroy restores original
 * `history.pushState`).
 */

import {
  __resetScreenTrackerForTests,
  destroyScreenTracker,
  getCurrentScreen,
  initScreenTracker,
} from '../queue/screen-tracker.js';

describe('screen-tracker', () => {
  beforeEach(() => {
    __resetScreenTrackerForTests();
    // jsdom allows writing to window.location via history API only;
    // ensure a known starting path.
    window.history.pushState({}, '', '/initial');
  });

  afterEach(() => {
    __resetScreenTrackerForTests();
  });

  it('getCurrentScreen() returns null before init', () => {
    expect(getCurrentScreen()).toBeNull();
  });

  it('initScreenTracker seeds from window.location.pathname (FR-010-030 scenario 1)', () => {
    window.history.pushState({}, '', '/home');
    initScreenTracker();
    expect(getCurrentScreen()).toBe('/home');
  });

  it('pushState updates the cached screen (FR-010-030 scenario 2)', () => {
    initScreenTracker();
    window.history.pushState({}, '', '/other');
    expect(getCurrentScreen()).toBe('/other');
  });

  it('replaceState updates the cached screen (FR-010-030 scenario 3)', () => {
    initScreenTracker();
    window.history.replaceState({}, '', '/replaced');
    expect(getCurrentScreen()).toBe('/replaced');
  });

  it('popstate updates the cached screen (FR-010-030 scenario 4)', () => {
    initScreenTracker();
    // Directly drive the location by using the (original) history API,
    // then fire popstate — the listener re-reads pathname.
    window.history.pushState({}, '', '/back');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(getCurrentScreen()).toBe('/back');
  });

  it('destroyScreenTracker restores the original history.pushState (FR-010-030 scenario 5)', () => {
    const original = history.pushState;
    initScreenTracker();
    // After init, the function reference should NOT equal the original.
    expect(history.pushState).not.toBe(original);
    destroyScreenTracker();
    expect(history.pushState).toBe(original);
  });

  it('destroy removes popstate listener', () => {
    initScreenTracker();
    destroyScreenTracker();
    // After destroy, dispatching popstate does not update screen because the
    // tracker has been reset (currentScreen is null).
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(getCurrentScreen()).toBeNull();
  });

  it('initScreenTracker is idempotent', () => {
    initScreenTracker();
    const first = history.pushState;
    initScreenTracker();
    expect(history.pushState).toBe(first);
  });
});
