/**
 * Close icon — X glyph. Ported verbatim from
 * tasks/_redesign-assets/components.jsx (line 13, `close`).
 */

import type { Component } from 'solid-js';
import { type IconProps, DEFAULT_ICON_SIZE } from './types';

/** 16x16 X close icon. Use for modal close buttons and dismiss controls. */
export const Close: Component<IconProps> = (props) => {
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
        d="M4 4l8 8M12 4l-8 8"
        stroke="currentColor"
        stroke-width="1.3"
        stroke-linecap="round"
      />
    </svg>
  );
};
