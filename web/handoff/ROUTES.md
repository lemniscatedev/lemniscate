# Routes

All routes have an HTML entry in `dist/`. Trailing-slash equivalents are supported by the local server.

| Route | Page | HTML file |
| --- | --- | --- |
| `/` | Landing page | `dist/index.html` |
| `/agents` | Agent policies | `dist/agents/index.html` |
| `/costs` | Holding costs and economics | `dist/costs/index.html` |
| `/dashboard` | Dashboard | `dist/dashboard/index.html` |
| `/learn` | Guides index | `dist/learn/index.html` |
| `/learn/daily-holding-cost` | Daily holding cost guide | `dist/learn/daily-holding-cost/index.html` |
| `/learn/everlasting-options` | Everlasting options guide | `dist/learn/everlasting-options/index.html` |
| `/learn/shield-protection` | Shield protection guide | `dist/learn/shield-protection/index.html` |
| `/learn/stock-token-pricing` | Stock token pricing guide | `dist/learn/stock-token-pricing/index.html` |
| `/markets` | Market catalogue | `dist/markets/index.html` |
| `/markets/daily-and-weekly` | Daily and weekly detail | `dist/markets/daily-and-weekly/index.html` |
| `/markets/shield` | Shield market detail | `dist/markets/shield/index.html` |
| `/markets/upside` | Upside market detail | `dist/markets/upside/index.html` |
| `/markets/writer-pool` | Writer Pool detail | `dist/markets/writer-pool/index.html` |
| `/privacy` | Privacy information | `dist/privacy/index.html` |
| `/product-terms` | Product terms | `dist/product-terms/index.html` |
| `/products` | Product mechanics | `dist/products/index.html` |
| `/protocol` | Protocol and guardrails | `dist/protocol/index.html` |

## Dashboard views

Use `/dashboard?tab=` with `overview`, `trade`, `positions`, `shield`, `pool`, `agents`, `activity`, or `settings`. Dashboard views share the single dashboard page and browser-local account state.

## Native source route map

The build uses `scripts/route-runtime-map.json` to connect each native route to its generated source module. Market details use `/markets/:Fe8F_Kjz3`; guides use `/learn/:nClQrfiKc`. The map also retains native internal 404/coming-soon modules, which are not additional standalone HTML pages.

| Native route | Source module |
| --- | --- |
| `/` | `dist/runtime/9lNd1HA0Y5z3FxLNdXbzq5OxlXydzUm9wL1LO12F7X8.DKq24c5U.mjs` |
| `/products` | `dist/runtime/Y_XSl8qvkOh20BX1o9vBaYL4EB9Db9_7_8Ch3lUaNVE.Cx83S3aw.mjs` |
| `/markets` | `dist/runtime/BgGljt9Vd1TB1bqKpakyUq6KLdOfD9kMsEzUea_HJzU.1KBFpOU9.mjs` |
| `/agents` | `dist/runtime/sZuEvutU3gBDVdwYzqTooBo4Qab-I-RYAAYuo2cy1SU.VvDmK4cx.mjs` |
| `/costs` | `dist/runtime/waPaHohnDS7WqXHkaJhTX2MOBAzeY5SEt8L-cDfim1k.BxYUl9EA.mjs` |
| `/learn` | `dist/runtime/HZbe4LxC8yFJilEU8Yfm2FsCuIqynq7as2kVnlYra5Y.AfQ7TMy0.mjs` |
| `/dashboard` | `dist/runtime/Mon9sVmTY5x4ZHjbQYyfIGxqcOTduMiELHBENfQnSIY.CF8tuc6_.mjs` |
| `/protocol` | `dist/runtime/-NwWFTKrcX-m1OANbGQQYNhvPNTS9TKxNm7fO6pMXXw.47SIi5BU.mjs` |
| `/404` | `dist/runtime/sun_ZoXmbV1p6qNWk7le4HDvwdXKIWsB5pdHy0Wrv84.DgHYTi7t.mjs` |
| `/coming-soon` | `dist/runtime/E-_2v9H5QHKi_sYBqTSom22hT6YuaGiWsyhOiLYXP3A.Dm9_vBot.mjs` |
| `/privacy` | `dist/runtime/fLhVvJVaa7s6t8dJtltXB_3zsFJoApoRqcu1yccpz44.Ck3VruTV.mjs` |
| `/product-terms` | `dist/runtime/COpgknjlYrATVJHgupJTsrOP4cyJ34coVlN_iV_R3yw.IBRv1ndW.mjs` |
| `/markets/:Fe8F_Kjz3` | `dist/runtime/7MMn720gBxnj4SJzo90Vonpm0cSJ0pSBwGa8vfCCaeE.ba1mmSI7.mjs` |
| `/learn/:nClQrfiKc` | `dist/runtime/eGRCQgytZDb47sUsCu5HD9D-celdo_OJaQq7cK5T2f0.IeJwTNbb.mjs` |
