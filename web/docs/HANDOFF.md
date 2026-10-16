# Developer handoff

## Architecture

This is a static, browser-rendered website. Each of the 18 public routes has its own `dist/.../index.html`. The native Framer/React layout and motion modules are retained in `dist/runtime/`; esbuild emits their split browser bundles into `dist/assets/app/`. Shared custom JavaScript reconciles the native layout with Lemniscate content, navigation, photography, modals, and the dashboard.

There is no server application in this repository. `serve.mjs` is a development static server. Production can use any static host that serves the nested HTML files and ES modules correctly.

## Editing map

| Area | Files |
| --- | --- |
| Shared branding, navigation, footer, section content, modal behavior, page/dashboard navigation | `dist/lemniscate.js` |
| Theme, text spacing, responsive sections, image sizing, loading animation | `dist/lemniscate.css` |
| Dashboard views, controls, calculations, browser storage, receipts and exports | `dist/dashboard.js` |
| Dashboard layout, mobile app presentation, cards and chart styling | `dist/dashboard.css` |
| Native page layout, original animation structure, article content modules | `dist/runtime/*.mjs` (see route map) |
| Page title, description, initial markup and head references | Each route's `index.html` |
| Image slot assignments and responsive variants | `dist/assets/photo-map.js`, `dist/assets/photo-sources.json` |
| Image/module/font preparation and navigation warming | `dist/assets/asset-loader.js`, `dist/assets/asset-plan.js` |
| Shared icon SVGs and branded underlying marks | `dist/assets/brand-icons.js`, `dist/assets/icons/`, `dist/assets/underlying-brand-sources.json` |
| Native bundle and preloading map refresh | `build-runtime.mjs`, `scripts/route-runtime-map.json` |

Do not edit `dist/assets/app/` directly; rebuild after editing a native source module. Native `.mjs` files contain generated/minified React code. Preserve exports, route identifiers, class names and data attributes that the custom layer uses. Article and market pages share parameterized native modules. Some record data is stored in the supplied `.framercms` assets; inspect the matching collection modules when changing content.

## Brand and responsive behavior

Theme variables are at the beginning of `dist/lemniscate.css`: navy `#28324c`, gold `#b8873d`, cream `#fdf5e5`, pale blue `#c3d6ec`; page background `#f7f3ed`. The current transparent infinity-and-star mark is `dist/assets/lemniscate-mark-v2.png` / `.webp`. Favicons and the Apple touch icon are included.

Desktop and mobile share the content and interactions. Photo sources include 1400-pixel desktop and 768-pixel mobile WebP variants. Content photography is assigned per page/slot to avoid repeating a stock photo between sections. Keep aspect ratios and dark/light contrast overlays when replacing photos. Update both the photo map and asset preparation plan for new images.

## Page preparation and dashboard transitions

The asset plan lists the native entry, route chunks, page photos, mobile variants, fonts, brand mark and CMS files. The loader prepares assets for the current route, waits for decoding/fonts, and warms likely destination pages on pointer/focus intent and idle time. First visits use a brief animated brand loader; prepared navigation bypasses the full loader. New assets still depend on network/cache conditions.

Marketing pages retain native client navigation. The dashboard mounts into a sibling root through `window.LM.mountDashboard(root, tab)` and leaves the native page mounted while hidden. It returns a `dispose()` handler; always dispose event listeners before remounting. Shared navigation uses browser history and restores the marketing view without a full reload when possible. Keep the module preloading map aligned with build outputs; the supplied build command refreshes it automatically.

## Dashboard data and backend integration

The dashboard's working controls currently update browser-local state. No brokerage, exchange, wallet, chain, custody, identity, payment, market-data or trading backend is connected. Product copy and interactions are preserved from the current site; developers should treat all account balances, quotes and receipts as local application records until APIs are integrated.

Storage key: `lemniscate.workspace.v1`. The versioned record contains `balance`, `positions`, `poolShares`, `poolQueues`, `watch`, `policies`, `activity`, `settings` and `history`. A new browser receives the default account state from `defaults()`; no existing visitor's saved data is shipped. JSON export is available in the interface. For a clean QA state, remove that key from local storage on the test origin.

The hardcoded underlying set is NVDA, TSLA, SPY, QQQ and HOOD. `markets`, `optionValue()`, `quote()`, `effective()` and `session()` provide local pricing, decay and session behavior. Session gating is calculated from the browser clock in New York time, without exchange calendars or live halt detection. Writer Pool values, exit queue timing and account events are maintained locally.

Backend integration should replace these data/calculation/action boundaries with authenticated APIs; validate orders, funds, quotes, settlement and policies on the server; persist records remotely; and return authoritative receipts to the existing views. The backend PDF in `references/` describes intended protocol behavior rather than implemented services. The published site's private access wrapper belongs to its host and is not part of this portable website.

## Adding pages or changing assets

Add the route's nested `index.html`, update shared navigation/content, `scripts/routes.json`, and the asset plan. For new native modules, update the native router and `scripts/route-runtime-map.json`, then run `npm run build`. Shared record pages may also require CMS identifiers/content changes. Update versioned asset query strings or purge the hosting cache after changes to fixed-name assets.

Run `npm run check`, then test desktop/mobile layouts, direct nested URLs, browser back/forward, dashboard entry/return, and affected controls. The local checks verify route files, head assets, bundle imports and preloading references; they do not replace visual or backend tests.
