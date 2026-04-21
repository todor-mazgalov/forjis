/**
 * Link icon — chain-link glyph. Ported verbatim from
 * tasks/_redesign-assets/components.jsx (line 25, `link`).
 */

import type { Component } from 'solid-js';
import { type IconProps, DEFAULT_ICON_SIZE } from './types';

/** 16x16 hairline chain-link icon. Use for attached-resource chips and URLs. */
export const Link: Component<IconProps> = (props) => {
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
      <g stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round">
        <path d="M6.5 9.5l3-3" />
        <path d="M6 5h-.5a3 3 0 000 6H7" />
        <path d="M10 5h.5a3 3 0 010 6H9" />
      </g>
    </svg>
  );
};
