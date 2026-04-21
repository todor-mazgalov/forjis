/**
 * Clock icon — circle with a clock-hand stub. Ported verbatim from
 * tasks/_redesign-assets/components.jsx (line 24, `clock`).
 */

import type { Component } from 'solid-js';
import { type IconProps, DEFAULT_ICON_SIZE } from './types';

/** 16x16 hairline clock icon. Use for timestamps and duration chips. */
export const Clock: Component<IconProps> = (props) => {
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
      <g stroke="currentColor" stroke-width="1.2" fill="none">
        <circle cx="8" cy="8" r="5.5" />
        <path d="M8 5v3l2 1.5" stroke-linecap="round" />
      </g>
    </svg>
  );
};
