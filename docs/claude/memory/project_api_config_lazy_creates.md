---
name: project-api-config-lazy-creates
description: POST /api/config lazy-creates the per-position slot when absent (Save-before-Manage workflow). Do NOT re-add the prior non-lazy 404.
metadata: 
  node_type: memory
  type: project
  originSessionId: ee80f1a7-2778-41af-8f18-a3f5993e9278
  modified: 2026-10-24T04:54:43.168Z
---

`_handleApiConfig` in `src/server/server-routes.js` uses
`getOrCreatePositionConfig` (not the non-lazy `getPositionConfig`)
when applying per-position keys, so a Save for a not-yet-managed
position creates the slot with the user's values. A later
`POST /api/position/manage` then only flips `status: "running"` and
preserves every other field — the user's pre-Manage edits carry
through into the running bot's config.

**Why:** Prior behavior returned 404 `position-not-found` when the
slot was absent. The dashboard's save calls use `.catch(() => {})`,
so the failure was invisible: the user typed a value, clicked Save,
clicked Manage, and watched their settings "reset to defaults" —
when in fact Save had never persisted. Released as the
`fix(api/config)` half of the 0.8.2 reorg commit (`976336a`).

**How to apply:**

- Do NOT swap `getOrCreatePositionConfig` back to `getPositionConfig`
  in this code path; doing so reintroduces the silent-save bug.
- The phantom-slot safety the prior 404 was guarding (post-rebalance
  key migration writing into a dead old key) is still covered:
  `resolveLiveKey` runs first and returns the post-migration key
  when a migration chain exists.
- A lazy-created slot with operator settings but no `status` is
  NOT a phantom — per [[project-config-stomp-investigation]] and the
  `_purgePhantomEntries` doc, a phantom is `{ status: "running" }`-
  only with no other fields. A `{ slippagePct: 0.5 }`-only slot is a
  legitimate pre-Manage user setting.
- Tests: `test/server-routes.test.js` "lazy-creates the position
  slot when absent" + `test/server.test.js` "POST /api/config
  lazy-creates the disk slot when positionKey has none" guard this
  behavior. Don't delete those without thinking hard.
