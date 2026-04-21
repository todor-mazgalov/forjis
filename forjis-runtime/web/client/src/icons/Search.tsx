/**
 * Search icon — magnifying glass. Ported verbatim from
 * tasks/_redesign-assets/components.jsx (line 8, `search`).
 */

import type { Component } from 'solid-js';
import { type IconProps, DEFAULT_ICON_SIZE } from './types';

/** 16x16 hairline magnifying-glass icon. Use for search inputs. */
export const Search: Component<IconProps> = (props) => {
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
        d="M11 11l4 4M6.5 12a5.5 5.5 0 110-11 5.5 5.5 0 010 11z"
        stroke="currentColor"
        stroke-width="1.2"
        fill="none"
        stroke-linecap="round"
      />
    </svg>
  );
};
