# Deployment

## Snapshot and package scope

This package's `dist/` was copied byte-for-byte from the clean source checkout for published version 9, source commit `a6934148a84c6f9a9bda369634a7f97cc1180671`. The published reference is https://lemniscate-options.sleroy1312.chatgpt.site/ (owner-private), confirmed on 14 October 2026.

The handoff adds portable documentation, validation scripts, a route source map, and a rebuild step that refreshes hashed preloading references. Those additions do not alter the included published UI snapshot. Hosting-specific `.openai` configuration and credentials are omitted so this folder can be used in a different repository/account.

## Static host settings

- Public/output directory: `dist`.
- Optional build command after dependency installation: `npm run build`.
- Runtime: none for production; Node is only required for local serving/building.
- Host at the origin root, such as `https://example.com/`. The website uses `/assets/...` and other root-relative URLs. A repository subpath requires a deliberate base-path migration.
- Serve each nested route from its own `index.html`, supporting both `/learn/stock-token-pricing` and `/learn/stock-token-pricing/`. Do not redirect every route to the homepage.
- Preserve query strings, especially `/dashboard?tab=trade` and other dashboard tabs.
- Serve `.js` and `.mjs` with a JavaScript MIME type, `.woff2` as `font/woff2`, and `.framercms` as binary data. Serve HTTPS in production.
- Missing routes/assets should return 404, not homepage HTML with a 200 status.

Use short/revalidated caching for HTML and fixed-name files such as `lemniscate.js`, `dashboard.js`, CSS and asset maps. Hashed files in `assets/app/` may use long immutable caching. Upload the HTML, plan and referenced chunks together; stale plans pointing to deleted hashes can break page preparation and return navigation.

## Verification after deployment

Check Home, Products, Markets, Protocol, Costs and Learn; open one article and one market detail directly; open `/dashboard?tab=overview`; test dashboard-to-marketing navigation, browser back/forward, the modal, and mobile layout. Confirm images/fonts/chunks return successfully and deep links load their intended page.

Most assets are local. Generated runtime code retains optional external Framer editor/platform hooks and source/brand links. If deploying with a strict Content Security Policy or without outside network access, audit these hooks and inline scripts/styles rather than assuming the export is a fully offline application. No external service keys are required to run the supplied website.
