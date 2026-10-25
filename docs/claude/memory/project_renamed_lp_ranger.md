---
name: project-renamed-lp-ranger
description: "Project's canonical name is now LP Ranger (package `lp-ranger`, copyright `lp-ranger Contributors`, year 2026). The old name `9mm v3 Position Manager` / `9mm-v3-position-manager` was fully retired 2026-07-27 — do NOT reintroduce it, and do NOT confuse it with the retained `9mm Pro`/`9mm v3` DEX references or the `9mm-pos-mgr` CSS namespace."
metadata: 
  node_type: memory
  type: project
  originSessionId: bfeda952-67a5-48dd-8d26-636cedf739e4
  modified: 2026-10-24T05:23:58.470Z
---

As of 2026-07-27 the project is branded **LP Ranger** everywhere the old
working name appeared: display name `LP Ranger` (README title, file-header
JSDoc, CLI `--help`, CLAUDE.md title, PDF report author), package identifier
`lp-ranger` (package.json + package-lock.json name fields), and LICENSE
`Copyright 2026 lp-ranger Contributors`.

**Why:** rebrand from the original working name "9mm v3 Position Manager".

**How to apply:**
- Never reintroduce "9mm v3 Position Manager" or "9mm-v3-position-manager".
- These are NOT the old project name — KEEP them untouched:
  - `9mm Pro` / `9mm v3` — the DEX (Uniswap v3 fork) the tool integrates with,
    including the package.json `description` ("...for 9mm v3 (Uniswap v3 fork)").
  - `9mm-pos-mgr` — the CSS class namespace (`9mm-pos-mgr-*`) and the filename
    `src/client/web/9mm-pos-mgr.css`, intentionally left as-is.
- Display contexts → `LP Ranger`; identifiers/package → `lp-ranger`.
- No code reads `package.json.name` (only `.version`), so the package rename is
  runtime-safe; keep package.json and package-lock.json name fields in sync
  (CI uses `npm ci`).
