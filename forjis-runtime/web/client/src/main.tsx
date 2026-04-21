/**
 * Entry point for the Forjis SolidJS client.
 *
 * Stylesheet imports come first and in a fixed order:
 *   1. tokens.css — declares CSS custom properties on :root
 *   2. fonts.css — @font-face declarations for Inter + JetBrains Mono
 *   3. global.css — reset + body baseline that consumes tokens and fonts
 *
 * Placing these before any component import ensures Vite injects the full
 * stylesheet cascade before the first component evaluates, preventing a
 * flash of unstyled content on first render.
 */

import './styles/tokens.css';
import './styles/fonts.css';
import './styles/global.css';

import { render } from 'solid-js/web';
import { App } from './App';

const root = document.getElementById('root');
if (!root) {
  throw new Error('Root element #root not found in document');
}

render(() => <App />, root);
