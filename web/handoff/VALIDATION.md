# Handoff validation

Checked on 14 October 2026.

- Confirmed the current published version is 9 and the source checkout is clean at the recorded commit.
- Confirmed all 523 files in the supplied `dist/` match the source snapshot byte-for-byte.
- Extracted the archive into a separate directory and verified every recorded file checksum.
- Ran the rebuild and syntax/reference checks from that extracted directory using the matching installed esbuild dependency.
- Validated 18 HTML routes, 162 local references, and 48 bundled outputs/imports.
- Started the extracted website with its supplied server and confirmed 46 page/entry/module/font/content HTTP responses were successful with the correct JavaScript MIME type.
- Opened the Home page, entered the dashboard, and returned to a guide through visible website controls in the browser.
- Excluded Git metadata, installed dependencies, active hosting identity, credential files, and visitor browser-storage data.

These checks cover the delivered frontend and its portable rebuild. Backend service integration is described in `HANDOFF.md`. The archive retains the current published tree; the test rebuild occurred only in the extracted verification copy.
