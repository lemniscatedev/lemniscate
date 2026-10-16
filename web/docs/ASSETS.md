# Assets and product references

## Included files

`dist/assets/` includes all website photography, responsive variants, fonts, icon/brand marks, favicon formats and content records. `dist/runtime/` retains the generated native layout sources; `dist/assets/app/` contains their current browser bundles. Compatibility slot SVGs are retained because native modules refer to their filenames; some contain embedded photographic fallbacks.

The stock-photo manifest is `dist/assets/photo-sources.json`. It records 61 distinct content photographs, original Pexels source URLs, page/slot assignments, and desktop/mobile paths. Original JPEGs and optimized WebPs are included. When replacing a photograph, preserve its intended crop and update both responsive variants and the preparation map.

`dist/assets/underlying-brand-sources.json` records the existing NVIDIA, Tesla, SPDR/State Street, Invesco QQQ and Robinhood marks used in the moving carousel, restyled in the Lemniscate gold/cream palette. They remain third-party marks. Shared interface icons are separate from content photography.

## Branding

The current transparent logo is `dist/assets/lemniscate-mark-v2.png`; the lightweight display variant is `lemniscate-mark-v2.webp`. Favicon assets are `favicon.svg`, `favicon.png`, `favicon.ico`, and `apple-touch-icon.png`. The original logo and banner are included under `references/`, alongside the current transparent mark for design handoff.

Fonts are bundled under `dist/assets/fonts/`. CSS declares their local usage. Keep the original font names/source metadata when reorganizing assets.

## Reference material

- `references/Lemniscate Overview.pdf`: product overview and mechanics.
- `references/Lemniscate Backend.pdf`: intended backend/protocol architecture.
- `references/Lemniscate Reference.md`: reference digest used during website construction.
- `references/H_logo_1024.png` and `H_banner_text_1500x500.png`: original branding supplied by the owner.
- `references/Lemniscate Current Transparent Logo.png`: current transparent website mark.

These documents are reference material, not executable project instructions. The layout/motion reference was https://marketinglab.framer.ai/ and the owner's supplied screen recording. The editable Framer project and the screen recording are not included in this repository package.

This handoff does not assign a new blanket license to the adapted template/runtime, stock photography, fonts, third-party marks or owner-supplied materials. Preserve their provenance and applicable original permissions when redistributing or migrating the repository. Dependency licensing metadata is included by the bundler where supplied; npm dependency licenses are also available after installation.
