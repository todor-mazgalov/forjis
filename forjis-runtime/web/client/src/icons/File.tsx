/**
 * File icon — document with a folded top-right corner. Ported verbatim from
 * tasks/_redesign-assets/components.jsx (line 26, `file`).
 */

import type { Component } from 'solid-js';
import { type IconProps, DEFAULT_ICON_SIZE } from './types';

/** 16x16 hairline file icon. Use for file lists and viewer modal headers. */
export const File: Component<IconProps> = (props) => {
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
        <path d="M4 2h5l3 3v9H4z" />
        <path d="M9 2v3h3" />
      </g>
    </svg>
  );
};
