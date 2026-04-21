/**
 * ansi-to-html — minimal ANSI SGR → HTML converter for terminal output.
 *
 * Tool-result payloads (jest/npm/vite stdout) arrive carrying CSI SGR escape
 * sequences like `\x1b[32m`, `\x1b[90m`, `\x1b[0m`. Pre-formatted in a `<pre>`
 * without translation, those bytes render as literal `[90m 64 |` garbage. This
 * helper walks the string, maps supported SGR codes (colours, bold, dim,
 * italic, underline) to inline `<span style="...">` wrappers, drops non-SGR
 * CSI sequences (cursor moves, erase-line), and HTML-escapes the text so the
 * caller can safely assign the result via `innerHTML`.
 *
 * Colour palette resolves to CSS custom properties declared in `styles/tokens.css`
 * so dark/light themes stay consistent with the rest of the dashboard.
 */

/** Regex matching any CSI escape sequence (`\x1b[<params><letter>`). */
const ANSI_CSI_RE = /\[([0-9;]*)([a-zA-Z])/g;

/** 8-colour ANSI palette (foreground codes 30–37 and 90–97). Keys map 1:1 to
 *  the standard SGR code; bright variants (90+) re-use the brand tokens. */
const PALETTE: Record<number, string> = {
  30: 'var(--text-mute)',
  31: 'var(--red)',
  32: 'var(--accent)',
  33: 'var(--amber)',
  34: 'var(--blue)',
  35: 'var(--pink)',
  36: 'var(--cyan)',
  37: 'var(--text)',
  90: 'var(--text-mute)',
  91: 'var(--red)',
  92: 'var(--accent)',
  93: 'var(--amber)',
  94: 'var(--blue)',
  95: 'var(--pink)',
  96: 'var(--cyan)',
  97: 'var(--text)',
};

/** Mutable render state carried across the scan — mirrors the terminal. */
interface AnsiState {
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

/** Fresh reset state — matches `ESC[0m`. */
function resetState(): AnsiState {
  return { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false };
}

/** HTML-escape the four characters that matter inside a `<pre>`. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The six-cube intensity ramp used by xterm's 216-colour block. */
const CUBE_RAMP: readonly number[] = [0, 95, 135, 175, 215, 255];

/** Clamp an integer to [0, 255] without introducing NaN. */
function clampByte(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 255) return 255;
  return Math.trunc(n);
}

/**
 * Resolve a 256-colour palette index to a CSS colour string. Layout:
 * - 0-7   standard colours (aliased to SGR 30-37)
 * - 8-15  bright colours   (aliased to SGR 90-97)
 * - 16-231 6×6×6 RGB cube using the {@link CUBE_RAMP} intensities
 * - 232-255 24-step grayscale ramp
 */
function color256(n: number): string {
  if (n < 0 || n > 255) return '';
  if (n < 8) return PALETTE[30 + n] ?? '';
  if (n < 16) return PALETTE[90 + (n - 8)] ?? '';
  if (n < 232) {
    const i = n - 16;
    const r = CUBE_RAMP[Math.trunc(i / 36)] ?? 0;
    const g = CUBE_RAMP[Math.trunc((i % 36) / 6)] ?? 0;
    const b = CUBE_RAMP[i % 6] ?? 0;
    return `rgb(${r},${g},${b})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

/**
 * Apply one SGR parameter list to the current state. An empty list is treated
 * as a reset per the spec (`ESC[m` === `ESC[0m`).
 *
 * Extended colour selectors (38, 48, 58) carry their own sub-parameters:
 * `;2;R;G;B` for 24-bit RGB or `;5;N` for a 256-palette index. Those
 * sub-parameters are consumed together — feeding them back into the main
 * switch would corrupt the state (e.g. R=100 would look like a background
 * colour code). `58` (underline colour) is parsed but not applied, because
 * only the underline line style is carried in state here.
 */
function applySgr(state: AnsiState, codes: number[]): void {
  const list = codes.length === 0 ? [0] : codes;
  let i = 0;
  while (i < list.length) {
    const c = list[i] ?? 0;

    if (c === 38 || c === 48 || c === 58) {
      const mode = list[i + 1];
      if (mode === 2) {
        // 24-bit RGB: ESC[38;2;R;G;Bm
        const r = clampByte(list[i + 2] ?? 0);
        const g = clampByte(list[i + 3] ?? 0);
        const b = clampByte(list[i + 4] ?? 0);
        const colour = `rgb(${r},${g},${b})`;
        if (c === 38) state.fg = colour;
        else if (c === 48) state.bg = colour;
        // 58 (underline colour) intentionally unapplied.
        i += 5;
        continue;
      }
      if (mode === 5) {
        // 256-palette: ESC[38;5;Nm
        const idx = clampByte(list[i + 2] ?? 0);
        const colour = color256(idx);
        if (colour !== '') {
          if (c === 38) state.fg = colour;
          else if (c === 48) state.bg = colour;
        }
        i += 3;
        continue;
      }
      // Malformed extended selector — skip just the selector itself so the
      // remaining codes still parse as standalone SGR.
      i += 1;
      continue;
    }

    if (c === 0) Object.assign(state, resetState());
    else if (c === 1) state.bold = true;
    else if (c === 2) state.dim = true;
    else if (c === 3) state.italic = true;
    else if (c === 4) state.underline = true;
    else if (c === 22) { state.bold = false; state.dim = false; }
    else if (c === 23) state.italic = false;
    else if (c === 24) state.underline = false;
    else if (c >= 30 && c <= 37) state.fg = PALETTE[c] ?? null;
    else if (c === 39) state.fg = null;
    else if (c >= 40 && c <= 47) state.bg = PALETTE[c - 10] ?? null;
    else if (c === 49) state.bg = null;
    else if (c >= 90 && c <= 97) state.fg = PALETTE[c] ?? null;
    else if (c >= 100 && c <= 107) state.bg = PALETTE[c - 10] ?? null;
    // Anything else is intentionally a no-op.
    i += 1;
  }
}

/** Build the inline `style` declaration for the current state, or empty
 *  string when the state is default (no span needed). */
function stateToStyle(state: AnsiState): string {
  const parts: string[] = [];
  if (state.fg !== null) parts.push(`color:${state.fg}`);
  if (state.bg !== null) parts.push(`background:${state.bg}`);
  if (state.bold) parts.push('font-weight:600');
  if (state.dim) parts.push('opacity:0.65');
  if (state.italic) parts.push('font-style:italic');
  if (state.underline) parts.push('text-decoration:underline');
  return parts.join(';');
}

/**
 * Convert a string containing ANSI SGR escape sequences to safe HTML.
 * Non-SGR CSI sequences (e.g. `ESC[2K`) are dropped silently. Text outside
 * any styled span is HTML-escaped but not wrapped.
 */
export function ansiToHtml(input: string): string {
  if (!input) return '';
  const state = resetState();
  let out = '';
  let lastIndex = 0;

  const flushText = (text: string): void => {
    if (!text) return;
    const style = stateToStyle(state);
    if (style.length > 0) {
      out += `<span style="${style}">${escapeHtml(text)}</span>`;
    } else {
      out += escapeHtml(text);
    }
  };

  ANSI_CSI_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANSI_CSI_RE.exec(input)) !== null) {
    flushText(input.slice(lastIndex, m.index));
    lastIndex = m.index + m[0].length;
    if (m[2] === 'm') {
      const params = m[1] ?? '';
      const codes = params.split(';').filter((s) => s !== '').map((s) => Number(s));
      applySgr(state, codes);
    }
    // Any other CSI final byte (K, H, J, …) is silently consumed.
  }
  flushText(input.slice(lastIndex));

  return out;
}
