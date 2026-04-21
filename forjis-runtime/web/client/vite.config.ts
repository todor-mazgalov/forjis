/**
 * Vite configuration for the Forjis SolidJS dashboard client.
 *
 * Builds to `dist/` and in dev proxies `/api` requests to the Node
 * dashboard server so API calls and SSE work transparently.
 */

import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

export default defineConfig({
  plugins: [solid()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4242',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
