---
name: project_help_page
description: "The User Manual is the standalone page public/help-and-user-manual.html with its own CSS, opened by the header's \"User Manual\" link"
metadata:
  node_type: memory
  type: project
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-18T04:04:18.698Z
---

The User Manual is a standalone page, `public/help-and-user-manual.html`,
titled "LP Ranger User Manual". The header's **User Manual** link (an
`<a>`, not a popover) opens it in a new tab. GitHub Pages publishes the
same file. Renamed from "Help and User Manual" on 2026-10-17 by the
user's request: "Rename the User Manual to just 'User Manual'". The
file path did not change, so published links still work.

- Styles in `public/help.css` (external, no inline styles)
- Uses plain `<ul>` and `<p>` elements (no `9mm-pos-mgr-help-*` classes — those stay for compact app contexts in `index.html`)
- Has a clickable table of contents with anchor links
- Regions marked `HELP:` are generated from `public/shared-help-content.json` by `scripts/build-manual-content.js`; edit the JSON, never the region
- Includes "Supported Liquidity Pool Managers" and "Supported Blockchains" sections at bottom

**Why:** Better readability, proper documentation page rather than a cramped popover.
**How to apply:** Manual text goes in `public/help-and-user-manual.html`, except the generated regions. Call it the "User Manual", never "Help". The `9mm-pos-mgr-help-*` classes in `9mm-pos-mgr.css` still serve `index.html` (throttle explanations, wallet modal text).
