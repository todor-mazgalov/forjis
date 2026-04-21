/**
 * ChevronRight icon — right-pointing caret. Ported verbatim from
 * tasks/_redesign-assets/components.jsx (line 9, `caret`) which is already
 * right-facing.
 */

import type { Component } from 'solid-js';
import { type IconProps, DEFAULT_ICON_SIZE } from './types';

/** 16x16 right-pointing chevron. Use for expand toggles and breadcrumbs. */
export const ChevronRight: Component<IconProps> = (props) => {
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
        d="M6 4l4 4-4 4"
        stroke="currentColor"
        stroke-width="1.3"
        fill="none"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
};
