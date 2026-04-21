/**
 * External icon — arrow pointing north-east out of a small box. Authored fresh
 * per design.md D-5 (redesign-003) in the same hairline-monochrome style as
 * the ported icons.
 */

import type { Component } from 'solid-js';
import { type IconProps, DEFAULT_ICON_SIZE } from './types';

/** 16x16 hairline "open in new" icon. Use for external-link affordances. */
export const External: Component<IconProps> = (props) => {
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
        <path d="M9 3h4v4" />
        <path d="M13 3l-6 6" />
        <path d="M11 9v3.5a.5.5 0 0 1-.5.5h-7a.5.5 0 0 1-.5-.5v-7a.5.5 0 0 1 .5-.5H7" />
      </g>
    </svg>
  );
};
