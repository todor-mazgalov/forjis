/**
 * ProjectIcon — shell primitive that renders a deterministic per-project
 * rounded-square icon.
 *
 * Same visual affordance as the pre-redesign dashboard's brand indicator:
 * a rounded square filled with a color hashed from the absolute project
 * directory path and overlaid with the uppercase first letter of the
 * last path segment. The color-hash and letter extraction are delegated
 * to `@forjis/shared` so the server-side `/favicon.svg` handler produces
 * a byte-identical color + letter pairing for the browser tab strip.
 *
 * Rendered as an inline SVG (not canvas) so the wrapper scales cleanly
 * in CSS and the output stays accessible. When `projectDir` is empty
 * the component renders nothing so callers do not need to short-circuit.
 */

import type { Component } from 'solid-js';
import { firstLetter, stringToColor } from '@forjis/shared';
import styles from './ProjectIcon.module.css';

/** Default square size in px; matches the adjacent `logoMark` in TopBar. */
const DEFAULT_SIZE = 18;

/** Corner radius in px on the 32-unit design grid; scaled down per render. */
const CORNER_RADIUS_UNITS = 4;

/** Design-grid edge length the letter is positioned against. */
const VIEWBOX_EDGE = 32;

/** Props for {@link ProjectIcon}. */
export interface ProjectIconProps {
  /** Absolute project directory path. Drives both color and letter. */
  projectDir: string;
  /** Optional square size in px. Defaults to {@link DEFAULT_SIZE}. */
  size?: number;
}

/**
 * Rounded-square project icon. Renders nothing when `projectDir` is empty
 * — the TopBar uses that signal to hide the icon entirely while the
 * `/api/config` fetch is in-flight.
 */
export const ProjectIcon: Component<ProjectIconProps> = (props) => {
  const size = () => props.size ?? DEFAULT_SIZE;
  const projectName = () => {
    const segments = props.projectDir.split(/[/\\]/).filter((s) => s.length > 0);
    return segments.length > 0 ? (segments[segments.length - 1] ?? '') : '';
  };
  const letter = () => firstLetter(projectName());
  const background = () => stringToColor(props.projectDir);
  const hasContent = () => props.projectDir.length > 0 && letter().length > 0;

  return (
    <>
      {hasContent() && (
        <svg
          class={styles.root}
          width={size()}
          height={size()}
          viewBox={`0 0 ${VIEWBOX_EDGE} ${VIEWBOX_EDGE}`}
          role="img"
          aria-label={`Project ${projectName()}`}
        >
          <rect
            x="0"
            y="0"
            width={VIEWBOX_EDGE}
            height={VIEWBOX_EDGE}
            rx={CORNER_RADIUS_UNITS}
            ry={CORNER_RADIUS_UNITS}
            fill={background()}
          />
          <text
            class={styles.letter}
            x={VIEWBOX_EDGE / 2}
            y={VIEWBOX_EDGE / 2 + 1}
            font-size="20"
            text-anchor="middle"
            dominant-baseline="central"
          >
            {letter()}
          </text>
        </svg>
      )}
    </>
  );
};
