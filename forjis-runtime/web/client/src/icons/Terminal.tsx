/**
 * Terminal icon — rounded rectangle frame with a `>` prompt and cursor
 * underline. Authored fresh per design.md D-5 (redesign-003) in the same
 * hairline-monochrome style as the ported icons.
 */

import type { Component } from 'solid-js';
import { type IconProps, DEFAULT_ICON_SIZE } from './types';

/** 16x16 hairline terminal icon. Use for CLI / shell / logs affordances. */
export const Terminal: Component<IconProps> = (props) => {
  const size = () => props.size ?? DEFAULT_ICON_SIZE;
  return (
    <svg
      viewBox="0 0 16 16"
      width={size()}
      height={size()}
      class={props.class}
      style={{ display: 'inline-block', 'vertical-align': 'middle', 'flex-shrink': 0 }}
    >
      {props.title ? <title>{props.title}</title> : null}
      <g stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <rect x="1.5" y="3.5" width="13" height="10" rx="1" />
        <path d="M4 6.5l2 1.5-2 1.5" />
        <path d="M8.5 10h4" />
      </g>
    </svg>
  );
};
