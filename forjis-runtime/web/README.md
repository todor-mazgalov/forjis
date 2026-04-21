# @forjis/web

HTTP server and SolidJS dashboard for the Forjis task pipeline.

## Package layout

```
forjis-runtime/web/
├── src/                  # Node.js HTTP server (controllers, router, helpers)
│   └── __tests__/        # Jest suites for the server layer
└── client/               # SolidJS + Vite single-page application
    ├── index.html        # Vite entry document
    ├── src/              # Solid components, views, stores
    ├── public/           # Static assets copied verbatim (logo, fonts)
    └── dist/             # Vite build output, served at runtime
```

The server is a thin Node `http` adapter. Every `/api/*` route is dispatched
to a controller that delegates to a service interface (implemented in the
facilitator). Anything else is served from `client/dist/` as a SolidJS SPA,
falling back to `index.html` so client-side routing works for deep links.

## Scripts

```bash
npm run build        # tsc for the server; postbuild runs `vite build` inside client/
npm test             # Jest against src/__tests__/
npm run clean        # remove dist/ and client/dist/
```

`npm run build` is invoked from the monorepo root (`forjis-runtime/`) and
produces both the server bundle (`dist/`) and the client bundle
(`client/dist/`). The `--web` CLI entry point resolves
`@forjis/web/package.json`, joins `client/dist`, and passes it to
`createWebServer` as `clientDir`.

## Request routing

1. `GET /api/*` — JSON/SSE endpoints (tasks, plans, events, resources,
   config, token usage, task files, manifest, plugin files).
2. `GET /` and any other non-`/api` GET — served from `clientDir`
   (`client/dist/index.html` plus hashed assets under `/assets/`).
3. Every other method — `404 NOT_FOUND`.

Authentication uses a single pre-shared bearer token (`--web-token`). The
token may be passed in the `Authorization: Bearer` header for every route,
or as `?token=` on the SSE streaming endpoint only (because `EventSource`
cannot set custom headers).

## Development

Run the server under the facilitator in watch mode:

```bash
cd forjis-runtime && npm run build
forjis --web --port 4242        # serves client/dist at http://127.0.0.1:4242
```

For active client development, run Vite in `forjis-runtime/web/client/` via
`npm run dev`; the dev server proxies to the backend port.

## Redesign reference

The current Solid client is the second-generation dashboard. Design assets,
screenshots, and the per-task redesign briefs live in
[`tasks/_redesign-assets/`](../../tasks/_redesign-assets/) and
[`tasks/_redesign-assets/redesign-overview.md`](../../tasks/_redesign-assets/redesign-overview.md).
