# @forjis/web-client

SolidJS + Vite single-page application served by [`@forjis/web`](../) when
the Forjis CLI is started with `--web`.

## Getting started

```bash
npm install        # installed from the workspace root via `npm ci`
npm run dev        # local Vite dev server (http://localhost:5173)
npm run build      # production bundle -> dist/
npm run preview    # serve dist/ locally for a final check
```

## Design reference

The client follows the redesign specs and visual language captured in
[`tasks/_redesign-assets/`](../../../tasks/_redesign-assets/):

- [`redesign-overview.md`](../../../tasks/_redesign-assets/redesign-overview.md) — shared vision, token system, and view inventory.
- `styles.css`, `components.jsx`, `app.jsx`, `tasks-view.jsx`, `config-view.jsx` — reference markup for the Tasks and Config views.
- `screenshots/` — annotated mockups for each redesign milestone.

Per-task briefs (`redesign-001` through `redesign-012`) live in
[`tasks/`](../../../tasks/) and document the scope of each increment.

## Structure

```
client/
├── index.html            # Vite entry document (<script type="module">)
├── public/               # Static assets copied verbatim
├── src/
│   ├── App.tsx           # Top-level router / shell
│   ├── main.tsx          # createRoot entry
│   ├── components/       # Shared primitives (Chip, StatusDot, ...)
│   ├── views/            # Route-level screens (Tasks, Config, ...)
│   ├── shell/            # Nav bar and layout scaffolding
│   ├── styles/           # Design tokens and global styles
│   └── icons/            # Inline SVG icon components
├── tsconfig.json
└── vite.config.ts
```
