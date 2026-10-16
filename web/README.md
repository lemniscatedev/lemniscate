# Lemniscate website — repository handoff

Complete portable snapshot of the current Lemniscate marketing website and dashboard, including editable application files, native layout modules, the ready-to-serve website, local assets, and product/brand reference documents.

Snapshot: published version 9, confirmed 14 October 2026. Source commit: `a6934148a84c6f9a9bda369634a7f97cc1180671`.

## Run locally

Use Node.js 20 or later (minimum supported: 18). Extract this folder, open a terminal in it, and run:

```sh
npm start
```

Open **http://127.0.0.1:4189/**. The included built website runs immediately; dependencies are only needed for rebuilding the native layout modules. To use another port: `PORT=4190 npm start` (macOS/Linux), or set the `PORT` environment variable in your shell.

## Install, check, and rebuild

```sh
npm ci
npm run check
npm run build
npm run dev
```

`npm run build` bundles `dist/runtime/`, updates the HTML entry references and asset preloading map, and validates the result. Editing the shared CSS, custom JavaScript, or images does not require a native runtime rebuild. Deploy the **contents of `dist/`** as the public root.

## Add to your repository

Copy this folder's contents into your repository, including the hidden `.gitignore`. No Git history, hosting account configuration, credentials, dependencies, or visitor workspace data is included. `dist/` is intentionally tracked: it contains both the deployed snapshot and the native module inputs. Do not add `dist/` to `.gitignore` without reorganizing the source layout first.

## Where to begin

- [Developer handoff](handoff/HANDOFF.md): architecture, editing locations, and dashboard integration boundaries.
- [Deployment](handoff/DEPLOYMENT.md): static hosting, route handling, and cache requirements.
- [Routes](handoff/ROUTES.md): all 18 pages and the native module map.
- [Assets and branding](handoff/ASSETS.md): images, fonts, logo, provenance, and source PDFs.
- `HANDOFF-MANIFEST.json`: file sizes and SHA-256 checksums for the delivered snapshot.

The native layout layer is adapted generated Framer/React JavaScript. Its modules are included, but this is not an original Framer editor project or a conventional component-based React/Vite project. The custom application layer is editable plain JavaScript and CSS. See the handoff guide before reorganizing the generated modules.
