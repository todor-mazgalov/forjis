/**
 * ChevronDown icon — downward-pointing caret. Ported verbatim from
 * tasks/_redesign-assets/components.jsx (line 18, `chevron`) which is already
 * down-facing.
 */

import type { Component } from 'solid-js';
import { type IconProps, DEFAULT_ICON_SIZE } from './types';

/** 16x16 down-pointing chevron. Use for dropdowns and accordion triggers. */
export const ChevronDown: Component<IconProps> = (props) => {
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
      <path
        d="M4 6l4 4 4-4"
        stroke="currentColor"
        stroke-width="1.3"
        fill="none"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
};
