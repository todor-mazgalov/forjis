/**
 * Barrel re-exporting every icon component in this directory. Downstream
 * consumers import by name from `../icons` rather than individual files.
 *
 * All eleven icons conform to the `IconProps` interface exported from
 * `./types` — see design.md decision D-5 (redesign-003).
 */

export type { IconProps } from './types';

export { Clock } from './Clock';
export { Link } from './Link';
export { File } from './File';
export { ChevronRight } from './ChevronRight';
export { ChevronDown } from './ChevronDown';
export { Terminal } from './Terminal';
export { Search } from './Search';
export { Close } from './Close';
export { Copy } from './Copy';
export { External } from './External';
export { StatusDot } from './StatusDot';
