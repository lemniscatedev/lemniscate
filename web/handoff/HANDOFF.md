# Developer handoff

## Architecture

This is a static, browser-rendered website. Each of the 18 public routes has its own `dist/.../index.html`. The native Framer/React layout and motion modules are retained in `dist/runtime/`; esbuild emits their split browser bundles into `dist/assets/app/`. Shared custom JavaScript reconciles the native layout with Lemniscate content, navigation, photography, modals, and the dashboard.

There is no server application in this repository. `serve.mjs` is a development static server. Production can use any static host that serves the nested HTML files and ES modules correctly.

## Editing map

| Area | Files |
| --- | --- |
| Shared branding, navigation, footer, section content, modal behavior, page/dashboard navigation | `dist/lemniscate.js` |
| Theme, text spacing, responsive sections, image sizing, loading animation | `dist/lemniscate.css` |
| Dashboard views and flows (API-backed) | `dist/dashboard.js` |
| API client, wallet, region gate, ABI helpers, demo data | `dist/chain/*.js` |
| Deployment settings (API, WalletConnect id, site URL, regions) | `dist/config.js` |
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

The dashboard is wired to the Lemniscate API and the visitor's wallet. Nothing financial is stored in the browser.

- **One config file:** `dist/config.js` (`window.LM_CONFIG`): `apiBase`, `siteUrl`, `walletConnectProjectId`, `appKitUrl` (pinned Reown AppKit CDN build), chain id/RPC/explorer, `oneTap`, `blockedRegions` (GB, CA, CH; the US is allowed) and an optional same-origin `geoEndpoint`. It ships with everything empty: the app then shows a "Live data is not available" state and makes no API calls.
- **Data:** `dist/chain/api.js` calls `/v1/config`, `/v1/chains`, `/v1/chains/{name}`, `/v1/vol/{name}`, `/v1/corporate-actions`, `/v1/pool`, `/v1/accounts/{address}/positions`, `/v1/accounts/{address}/activity` (cursor paging, Activity tab), `/v1/accounts/{address}/agents` (Agent desk policies and trades), `/v1/accounts/{address}/smart-account` (fills the one-tap address in Settings; a pasted address overrides it), `POST /v1/quote` and `POST /v1/intent/{buy,sell,shield}` (plus `?format=userop` and `/v1/userop/*` when `oneTap` is on and a smart account is set in Settings). Spreads, sessions, block reasons, Shield strikes (listed Weekly puts only), pool NAV and caps all come from these responses.
- **Wallet:** `dist/chain/wallet.js`: EIP-6963 browser wallets are always listed; WalletConnect loads the pinned AppKit build only when chosen and only with a project id. Trades: the API returns unsigned calldata and the exact USDG approval; the site approves exactly that amount, sends, waits for the receipt and records the transaction hash (Activity tab, `lemniscate.receipts.v2`). Pool deposit/redeem and agent policies are encoded locally (`dist/chain/abi.js`).
- **Region gate:** `dist/chain/region.js`. With `geoEndpoint` empty the visitor declares residence once (stored locally); on Cloudflare set `geoEndpoint:'/cdn-cgi/trace'` for an edge lookup that never leaves the site's origin.
- **Demo:** `/dashboard?demo=1` uses `dist/chain/demo.js` (illustrative prices, same response shapes) and is labelled "Demo, not real funds".
- **Browser storage keys:** `lemniscate.prefs.v2` (slippage, deadline, optional smart account override), `lemniscate.receipts.v2` (this browser's own sends, shown as pending until the service lists them), `lemniscate.policy-draft.v1` (the unsent policy form only), `lemniscate.region.v1`, `lemniscate.wallet.v1`. The old `lemniscate.workspace.v1` is no longer read.

**Token address box:** `dist/token-bar.js` + `dist/token-bar.css` (script tag stamped on every route). Hidden until `dist/launch.json` has `tokenAddress` (0x + 40 hex); then shows Copy and Explorer (and Buy if `buyUrl` is https). At launch only `launch.json` changes. Note: this repo has no `vercel.json`/CSP; if one is added, allow the same-origin `/launch.json` fetch (connect-src 'self').

Tests: `npm run check` (routes, syntax, copy lint), `npm run lint:copy`, `npm run test:browser` (Playwright: all 18 routes and every dashboard tab at 390 px, console errors, offline/unreachable states, and buy/sell/Shield/pool flows against `scripts/mock-api.mjs` with a fake EIP-6963 wallet). `npm run mock-api` starts the mock alone (`MOCK_SESSION`, `MOCK_EARNINGS`, `MOCK_SPLIT` set states).

Copy fixes inside generated native modules and CMS content live in `scripts/apply-copy-fixes.mjs` (idempotent; it uses `scripts/cms-codec.mjs` to keep the CMS length prefixes valid). Run it, then `npm run build`. `npm run stamp` rewrites every page head from `siteUrl` (canonical, og:url, og:image) and must be re-run after changing it.

## Adding pages or changing assets

Add the route's nested `index.html`, update shared navigation/content, `scripts/routes.json`, and the asset plan. For new native modules, update the native router and `scripts/route-runtime-map.json`, then run `npm run build`. Shared record pages may also require CMS identifiers/content changes. Update versioned asset query strings or purge the hosting cache after changes to fixed-name assets.

Run `npm run check`, then test desktop/mobile layouts, direct nested URLs, browser back/forward, dashboard entry/return, and affected controls. The local checks verify route files, head assets, bundle imports and preloading references; they do not replace visual or backend tests.
