/**
 * Unit tests for `capture/styles.ts`. Each test resets `document.body` so
 * element queries are deterministic. The tests verify the curated key-count
 * bounds, that every property in {@link CURATED_CSS_PROPERTIES} is present in
 * the output, that inline-assigned values survive through `getComputedStyle`,
 * and that successive calls are key-stable.
 */

import {
  CURATED_CSS_PROPERTIES,
  captureComputedStyles,
} from '../capture/styles.js';

describe('captureComputedStyles', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('returns between 20 and 40 keys (spec FR-009-003 / FR-009-010)', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const out = captureComputedStyles(el);
    const keyCount = Object.keys(out).length;
    expect(keyCount).toBeGreaterThanOrEqual(20);
    expect(keyCount).toBeLessThanOrEqual(40);
  });

  it('contains every curated property name', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const out = captureComputedStyles(el);
    for (const name of CURATED_CSS_PROPERTIES) {
      expect(Object.prototype.hasOwnProperty.call(out, name)).toBe(true);
    }
  });

  it('covers every category required by the spec', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const out = captureComputedStyles(el);
    const required = [
      // color
      'color',
      'background-color',
      // typography
      'font-size',
      'font-family',
      'font-weight',
      'line-height',
      // box model
      'padding',
      'margin',
      // layout
      'display',
      'position',
      // sizing
      'width',
      'height',
    ];
    for (const name of required) {
      expect(Object.prototype.hasOwnProperty.call(out, name)).toBe(true);
    }
  });

  it('returns the same value that getComputedStyle.getPropertyValue returns', () => {
    const el = document.createElement('div');
    el.style.color = 'rgb(255, 0, 0)';
    document.body.appendChild(el);
    const out = captureComputedStyles(el);
    const viaComputed = window.getComputedStyle(el).getPropertyValue('color');
    expect(out.color).toBe(viaComputed);
  });

  it('returns a stable key set across successive calls on different elements', () => {
    const elA = document.createElement('div');
    const elB = document.createElement('section');
    document.body.appendChild(elA);
    document.body.appendChild(elB);
    const keysA = Object.keys(captureComputedStyles(elA));
    const keysB = Object.keys(captureComputedStyles(elB));
    expect(keysA).toEqual(keysB);
  });
});
