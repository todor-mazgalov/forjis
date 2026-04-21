/**
 * StatusDot icon — filled circle at 2 px radius. Ported verbatim from
 * tasks/_redesign-assets/components.jsx (line 20, `dot`).
 *
 * NOTE: this is the *icon* component. The animated pulse/ring primitive with
 * the same name lives at ../components/primitives/StatusDot.tsx and is
 * distinct — this file is static-only.
 */

import type { Component } from 'solid-js';
import { type IconProps, DEFAULT_ICON_SIZE } from './types';

/** 16x16 static filled dot. Use for inline-text status markers. */
export const StatusDot: Component<IconProps> = (props) => {
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
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    </svg>
  );
};
