/**
 * Annotation canvas factory.
 *
 * Layers a `<canvas>` over the viewport-screenshot thumbnail inside the
 * comment sheet (design.md §D-006, spec FR-009-004). The user can draw box,
 * arrow, and text annotations; undo pops the last; clear drops the stack.
 *
 * Coordinate normalization: the canvas's intrinsic pixel size equals the
 * original viewport PNG (`viewportWidth × viewportHeight`), so the `Bbox`
 * values in the returned `Annotation[]` are already in viewport-pixel space,
 * not thumbnail-display space (FR-009-004 scenario "Coordinates normalize to
 * viewport pixel dimensions"). Pointer events report their offset in
 * display space; we scale by the canvas's intrinsic/CSS width ratio.
 *
 * Theming: colors come from the Forjis design-token set copied under
 * `:host` by {@link FORJIS_TOKENS}. Inline strokes still use explicit hex
 * values because the 2D canvas context has no CSS-variable resolution.
 */

import type { Annotation, Bbox } from '@forjis/shared';
import { FORJIS_TOKENS } from './theme.js';

/** Options accepted by {@link createAnnotationCanvas}. */
export interface InitAnnotationCanvasOptions {
  /** Original viewport PNG pixel width (canvas intrinsic width). */
  readonly viewportWidth: number;
  /** Original viewport PNG pixel height (canvas intrinsic height). */
  readonly viewportHeight: number;
  /** Viewport screenshot Blob rendered behind the drawing surface. */
  readonly backgroundBlob: Blob;
}

/** Handle returned by {@link createAnnotationCanvas}. */
export interface AnnotationCanvasHandle {
  /** Container holding the background image, canvas, and toolbar. */
  readonly element: HTMLElement;
  /** Snapshot copy of the current annotation list. */
  getAnnotations(): Annotation[];
  /** Drop all annotations and repaint. */
  clear(): void;
  /** Remove the last annotation and repaint. */
  undo(): void;
  /** Remove DOM, revoke the background object URL, release listeners. */
  destroy(): void;
}

/** Closed set of drawing tools the toolbar exposes. */
type Tool = 'box' | 'arrow' | 'text';

/**
 * Stroke / fill constants — the canvas context cannot resolve CSS
 * variables, so the mint-accent and body-text colors are duplicated as
 * literal hex values. These mirror `--accent` and `--text` at current
 * token values.
 */
const STROKE_COLOR = '#7fe0a3';
const STROKE_WIDTH = 2;
const TEXT_COLOR = '#d4dadf';
const TEXT_FONT = '14px system-ui, -apple-system, sans-serif';

/**
 * In-progress draw record for the currently-active tool (box / arrow drag).
 *
 * `box`: `end` tracks the pointer during drag.
 * `arrow`: `start` is the first click; `end` tracks the pointer until the
 *   second click; on commit the `end` is frozen.
 */
interface InProgress {
  readonly tool: 'box' | 'arrow';
  readonly start: { x: number; y: number };
  end: { x: number; y: number };
}

/** Inline CSS block applied to the annotation container's `<style>` node. */
const ANNOTATION_STYLE = `
.annotation-container {
  position: relative;
  width: 100%;
  background: var(--bg-base);
  color: var(--text);
  overflow: hidden;
  font-family: var(--font-sans);
}
.annotation-bg {
  display: block;
  width: 100%;
  height: auto;
  object-fit: contain;
  pointer-events: none;
}
.annotation-canvas {
  position: absolute;
  left: 0;
  top: 0;
  width: 100%;
  height: 100%;
  cursor: crosshair;
}
.annotation-toolbar {
  display: flex;
  gap: var(--space-2);
  padding: var(--space-2);
  background: var(--bg-panel);
  border-top: 1px solid var(--border);
}
.annotation-toolbar button {
  background: var(--bg-raised);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 4px var(--space-3);
  font: 500 var(--text-sm)/1 var(--font-sans);
  cursor: pointer;
}
.annotation-toolbar button:hover {
  border-color: var(--border-strong);
  color: var(--text);
}
.annotation-toolbar button[aria-pressed="true"] {
  background: var(--accent);
  color: var(--bg-base);
  border-color: var(--accent);
}
.annotation-text-input {
  position: absolute;
  font: ${TEXT_FONT};
  padding: 2px 4px;
  border: 1px solid var(--accent);
  background: var(--bg-panel);
  color: var(--text);
  border-radius: var(--radius-xs);
  min-width: 80px;
}
`;

/**
 * Build the structural DOM for the annotation canvas (container, background
 * image, drawing canvas, toolbar).
 *
 * @param opts - The caller's init options.
 * @returns Container plus references to the inner elements.
 */
function buildDom(opts: InitAnnotationCanvasOptions): {
  container: HTMLElement;
  bg: HTMLImageElement;
  canvas: HTMLCanvasElement;
  toolbar: HTMLElement;
  backgroundUrl: string;
} {
  const container = document.createElement('div');
  container.className = 'annotation-container';
  const style = document.createElement('style');
  style.textContent = FORJIS_TOKENS + ANNOTATION_STYLE;
  container.appendChild(style);
  const backgroundUrl = URL.createObjectURL(opts.backgroundBlob);
  const bg = document.createElement('img');
  bg.className = 'annotation-bg';
  bg.alt = '';
  bg.src = backgroundUrl;
  container.appendChild(bg);
  const canvas = document.createElement('canvas');
  canvas.className = 'annotation-canvas';
  canvas.width = opts.viewportWidth;
  canvas.height = opts.viewportHeight;
  container.appendChild(canvas);
  const toolbar = buildToolbar();
  container.appendChild(toolbar);
  return { container, bg, canvas, toolbar, backgroundUrl };
}

/**
 * Build the toolbar element with tool + undo + clear buttons.
 *
 * Each button declares `aria-pressed` from construction so screen readers
 * and tests can observe the active-tool state without waiting for the
 * first `updateToolbar` call.
 *
 * @returns Toolbar element with `<button>` children for each action.
 */
function buildToolbar(): HTMLElement {
  const toolbar = document.createElement('div');
  toolbar.className = 'annotation-toolbar';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', 'Annotation tools');
  const tools: Array<{ tool: Tool; label: string }> = [
    { tool: 'box', label: 'Box' },
    { tool: 'arrow', label: 'Arrow' },
    { tool: 'text', label: 'Text' },
  ];
  for (const { tool, label } of tools) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.dataset.tool = tool;
    btn.setAttribute('aria-pressed', 'false');
    btn.setAttribute('aria-label', label + ' tool');
    btn.textContent = label;
    toolbar.appendChild(btn);
  }
  toolbar.appendChild(buildActionButton('undo', 'Undo'));
  toolbar.appendChild(buildActionButton('clear', 'Clear'));
  return toolbar;
}

/**
 * Build an action button (Undo / Clear) for the annotation toolbar.
 *
 * @param action - Action name stored on `data-action`.
 * @param label - Visible label text.
 * @returns The button element.
 */
function buildActionButton(action: 'undo' | 'clear', label: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.action = action;
  btn.setAttribute('aria-label', label);
  btn.textContent = label;
  return btn;
}

/**
 * Scale a pointer's display-space offset to canvas pixel-space.
 *
 * @param canvas - Target canvas.
 * @param offsetX - Pointer event `offsetX`.
 * @param offsetY - Pointer event `offsetY`.
 * @returns Point in canvas pixel coordinates.
 */
function scalePointer(
  canvas: HTMLCanvasElement,
  offsetX: number,
  offsetY: number,
): { x: number; y: number } {
  const displayWidth = canvas.clientWidth || canvas.width;
  const displayHeight = canvas.clientHeight || canvas.height;
  const sx = canvas.width / displayWidth;
  const sy = canvas.height / displayHeight;
  return { x: offsetX * sx, y: offsetY * sy };
}

/**
 * Compute the normalized positive bbox from two endpoints.
 *
 * @param a - First point.
 * @param b - Second point.
 * @returns Axis-aligned bbox with positive width/height.
 */
function bboxFromPoints(
  a: { x: number; y: number },
  b: { x: number; y: number },
): Bbox {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const w = Math.abs(b.x - a.x);
  const h = Math.abs(b.y - a.y);
  return { x, y, w, h };
}

/**
 * Render a single annotation onto the canvas context.
 *
 * @param ctx - Canvas 2D context.
 * @param ann - Annotation to paint.
 */
function paintAnnotation(
  ctx: CanvasRenderingContext2D,
  ann: Annotation,
): void {
  ctx.strokeStyle = STROKE_COLOR;
  ctx.lineWidth = STROKE_WIDTH;
  if (ann.kind === 'box') {
    ctx.strokeRect(ann.bbox.x, ann.bbox.y, ann.bbox.w, ann.bbox.h);
    return;
  }
  if (ann.kind === 'arrow') {
    paintArrow(ctx, ann.bbox);
    return;
  }
  ctx.fillStyle = TEXT_COLOR;
  ctx.font = TEXT_FONT;
  ctx.textBaseline = 'top';
  const label = ann.text ?? '';
  ctx.fillText(label, ann.bbox.x, ann.bbox.y);
}

/**
 * Paint an arrow across the diagonal of `bbox`. Direction is not preserved
 * on the `Annotation` level (accepted limitation R-004), so we pick the
 * top-left → bottom-right diagonal as a canonical rendering.
 *
 * @param ctx - Canvas 2D context.
 * @param bbox - Arrow bounding box.
 */
function paintArrow(ctx: CanvasRenderingContext2D, bbox: Bbox): void {
  const x1 = bbox.x;
  const y1 = bbox.y;
  const x2 = bbox.x + bbox.w;
  const y2 = bbox.y + bbox.h;
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  const headLen = 10;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLen * Math.cos(angle - Math.PI / 6),
    y2 - headLen * Math.sin(angle - Math.PI / 6),
  );
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLen * Math.cos(angle + Math.PI / 6),
    y2 - headLen * Math.sin(angle + Math.PI / 6),
  );
  ctx.stroke();
}

/**
 * Reflect the currently-selected tool onto the toolbar buttons — writes
 * `aria-pressed="true"` on the active button and `"false"` on the others.
 *
 * @param toolbar - Toolbar element.
 * @param activeTool - The tool to mark as pressed.
 */
function syncToolbar(toolbar: HTMLElement, activeTool: Tool): void {
  const toolButtons = toolbar.querySelectorAll<HTMLButtonElement>(
    'button[data-tool]',
  );
  toolButtons.forEach((btn) => {
    const pressed = btn.dataset.tool === activeTool;
    btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    btn.dataset.active = pressed ? 'true' : 'false';
  });
}

/**
 * Mount an annotation canvas + toolbar into a fresh container element.
 *
 * The returned `element` is an unattached `<div>`; the caller is responsible
 * for mounting it into the DOM. `destroy()` revokes the background
 * objectURL and drops references.
 *
 * @param opts - Init options.
 * @returns An {@link AnnotationCanvasHandle}.
 */
export function createAnnotationCanvas(
  opts: InitAnnotationCanvasOptions,
): AnnotationCanvasHandle {
  const { container, canvas, toolbar, backgroundUrl } = buildDom(opts);
  const ctx = canvas.getContext('2d');
  const annotations: Annotation[] = [];
  let activeTool: Tool = 'box';
  let inProgress: InProgress | null = null;
  let activeTextInput: HTMLInputElement | null = null;

  const redraw = (): void => {
    if (!ctx) {
      return;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const ann of annotations) {
      paintAnnotation(ctx, ann);
    }
    if (inProgress !== null) {
      const liveBbox = bboxFromPoints(inProgress.start, inProgress.end);
      paintAnnotation(ctx, { kind: inProgress.tool, bbox: liveBbox });
    }
  };

  const commitText = (point: { x: number; y: number }, value: string): void => {
    if (value === '') {
      return;
    }
    const bbox: Bbox = { x: point.x, y: point.y, w: value.length * 8, h: 18 };
    annotations.push({ kind: 'text', bbox, text: value });
    redraw();
  };

  const openTextInput = (point: { x: number; y: number }): void => {
    if (activeTextInput) {
      activeTextInput.remove();
    }
    const input = document.createElement('input');
    input.className = 'annotation-text-input';
    input.type = 'text';
    const displayW = canvas.clientWidth || canvas.width;
    const displayH = canvas.clientHeight || canvas.height;
    const sx = displayW / canvas.width;
    const sy = displayH / canvas.height;
    input.style.left = String(point.x * sx) + 'px';
    input.style.top = String(point.y * sy) + 'px';
    container.appendChild(input);
    activeTextInput = input;
    input.focus();
    const finalize = (): void => {
      if (activeTextInput !== input) {
        return;
      }
      const value = input.value;
      input.remove();
      activeTextInput = null;
      commitText(point, value);
    };
    input.addEventListener('blur', finalize);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        finalize();
      } else if (e.key === 'Escape') {
        input.value = '';
        finalize();
      }
    });
  };

  const onPointerDown = (e: PointerEvent): void => {
    const point = scalePointer(canvas, e.offsetX, e.offsetY);
    if (activeTool === 'text') {
      openTextInput(point);
      return;
    }
    if (activeTool === 'arrow' && inProgress && inProgress.tool === 'arrow') {
      const committedBbox = bboxFromPoints(inProgress.start, point);
      annotations.push({ kind: 'arrow', bbox: committedBbox });
      inProgress = null;
      redraw();
      return;
    }
    inProgress = {
      tool: activeTool === 'arrow' ? 'arrow' : 'box',
      start: point,
      end: point,
    };
    redraw();
  };

  const onPointerMove = (e: PointerEvent): void => {
    if (!inProgress) {
      return;
    }
    const point = scalePointer(canvas, e.offsetX, e.offsetY);
    inProgress.end = point;
    redraw();
  };

  const onPointerUp = (e: PointerEvent): void => {
    if (!inProgress || inProgress.tool !== 'box') {
      return;
    }
    const point = scalePointer(canvas, e.offsetX, e.offsetY);
    const bbox = bboxFromPoints(inProgress.start, point);
    inProgress = null;
    if (bbox.w < 2 || bbox.h < 2) {
      redraw();
      return;
    }
    annotations.push({ kind: 'box', bbox });
    redraw();
  };

  /**
   * Resolve the `<button>` ancestor of the click target. Using `closest()`
   * lets nested spans (e.g. an icon or label) forward their clicks to the
   * correct button — this is what was causing Arrow / Text to appear inert
   * when the click landed on inner text nodes.
   *
   * @param e - Click event from the toolbar.
   * @returns The enclosing button, or `null` when the click was elsewhere.
   */
  const resolveButton = (e: MouseEvent): HTMLButtonElement | null => {
    const target = e.target;
    if (!(target instanceof Element)) {
      return null;
    }
    const btn = target.closest('button');
    return btn instanceof HTMLButtonElement ? btn : null;
  };

  const onToolbarClick = (e: MouseEvent): void => {
    const btn = resolveButton(e);
    if (!btn) {
      return;
    }
    if (btn.dataset.tool) {
      activeTool = btn.dataset.tool as Tool;
      inProgress = null;
      if (activeTextInput) {
        activeTextInput.remove();
        activeTextInput = null;
      }
      syncToolbar(toolbar, activeTool);
      redraw();
      return;
    }
    if (btn.dataset.action === 'undo') {
      annotations.pop();
      inProgress = null;
      redraw();
      return;
    }
    if (btn.dataset.action === 'clear') {
      annotations.length = 0;
      inProgress = null;
      redraw();
    }
  };

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  toolbar.addEventListener('click', onToolbarClick);
  syncToolbar(toolbar, activeTool);

  let destroyed = false;
  return {
    element: container,
    getAnnotations() {
      return annotations.slice();
    },
    clear() {
      annotations.length = 0;
      inProgress = null;
      redraw();
    },
    undo() {
      annotations.pop();
      redraw();
    },
    destroy() {
      if (destroyed) {
        return;
      }
      destroyed = true;
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      toolbar.removeEventListener('click', onToolbarClick);
      if (activeTextInput) {
        activeTextInput.remove();
        activeTextInput = null;
      }
      URL.revokeObjectURL(backgroundUrl);
      if (container.parentNode) {
        container.parentNode.removeChild(container);
      }
    },
  };
}
