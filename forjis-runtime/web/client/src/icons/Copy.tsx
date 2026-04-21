/**
 * Copy icon — overlapping rectangles. Ported verbatim from
 * tasks/_redesign-assets/components.jsx (line 21, `copy`).
 */

import type { Component } from 'solid-js';
import { type IconProps, DEFAULT_ICON_SIZE } from './types';

/** 16x16 overlapping-rectangles copy icon. Use for "copy to clipboard" controls. */
export const Copy: Component<IconProps> = (props) => {
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
      <g stroke="currentColor" stroke-width="1.1" fill="none">
        <rect x="3" y="3" width="8" height="8" rx="1" />
        <path d="M5 11v1.5a.5.5 0 00.5.5H13a.5.5 0 00.5-.5V6a.5.5 0 00-.5-.5H11.5" />
      </g>
    </svg>
  );
};
