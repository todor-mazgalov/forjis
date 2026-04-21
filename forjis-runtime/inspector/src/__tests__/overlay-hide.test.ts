/**
 * Unit tests for `capture/overlay-hide.ts`. The helper `withOverlayHidden`
 * and the predicate `buildOverlayFilter` are the belt-and-braces mechanism
 * that enforces spec FR-009-009 ("overlay artifacts excluded from captures").
 *
 * Each test isolates the effect on the `#forjis-inspector-root` shadow-host's
 * inline `visibility` style and verifies the predicate rejects exactly the
 * overlay root and nothing else.
 */

import {
  OVERLAY_ROOT_ID,
  buildOverlayFilter,
  getOverlayRoot,
  withOverlayHidden,
} from '../capture/overlay-hide.js';

describe('withOverlayHidden (FR-009-009)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /**
   * Attach an overlay-root-shaped div to `document.body` so `getOverlayRoot`
   * resolves it.
   *
   * @returns The created overlay-root element.
   */
  function mountOverlayRoot(): HTMLElement {
    const el = document.createElement('div');
    el.id = OVERLAY_ROOT_ID;
    document.body.appendChild(el);
    return el;
  }

  it('runs the task when no overlay root is present', async () => {
    // Arrange
    expect(getOverlayRoot()).toBeNull();
    // Act
    const result = await withOverlayHidden(async () => 42);
    // Assert
    expect(result).toBe(42);
  });

  it('toggles visibility to hidden during the task and restores it afterwards', async () => {
    // Arrange
    const root = mountOverlayRoot();
    root.style.visibility = 'visible';
    let observed: string | null = null;
    // Act
    const result = await withOverlayHidden(async () => {
      observed = root.style.visibility;
      return 'done';
    });
    // Assert
    expect(observed).toBe('hidden');
    expect(result).toBe('done');
    expect(root.style.visibility).toBe('visible');
  });

  it('restores the prior visibility even when the task throws (FR-009-009)', async () => {
    // Arrange
    const root = mountOverlayRoot();
    root.style.visibility = 'visible';
    const err = new Error('boom');
    // Act + Assert
    await expect(
      withOverlayHidden(async () => {
        throw err;
      }),
    ).rejects.toBe(err);
    expect(root.style.visibility).toBe('visible');
  });

  it('restores an originally empty visibility string rather than forcing "visible"', async () => {
    // Arrange
    const root = mountOverlayRoot();
    // No inline visibility; default is "".
    expect(root.style.visibility).toBe('');
    // Act
    await withOverlayHidden(async () => undefined);
    // Assert — the helper must NOT leave the overlay permanently "visible";
    // it should restore whatever it found (the empty string).
    expect(root.style.visibility).toBe('');
  });
});

describe('buildOverlayFilter (FR-009-009)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns true for arbitrary non-overlay nodes', () => {
    // Arrange
    const predicate = buildOverlayFilter();
    const div = document.createElement('div');
    const span = document.createElement('span');
    // Act + Assert
    expect(predicate(div)).toBe(true);
    expect(predicate(span)).toBe(true);
    expect(predicate(document.body)).toBe(true);
  });

  it('returns false for the overlay root element when mounted', () => {
    // Arrange
    const root = document.createElement('div');
    root.id = OVERLAY_ROOT_ID;
    document.body.appendChild(root);
    const predicate = buildOverlayFilter();
    // Act + Assert
    expect(predicate(root)).toBe(false);
    // Siblings are still kept.
    const sibling = document.createElement('p');
    expect(predicate(sibling)).toBe(true);
  });
});
