---
name: project-debug-scripts-print-url
description: "Nice-to-have — every `debug*` npm script should print a visit-this URL on a clean line with a one-line description of what to do there."
metadata: 
  node_type: memory
  type: project
  originSessionId: e17d18d9-be7e-475d-b752-a1fab7b154c0
  modified: 2026-10-24T05:05:31.327Z
---

**Status: deferred / nice-to-have, surfaced 2026-06-17.**

Every npm script that involves the Node V8 inspector should print, on its own clean line, a URL the user can copy-paste / click straight into a browser, followed by a one-line description of what the URL does.

The four scripts in scope (all in `package.json`):

- `npm run debug` — `node --inspect src/server.js`
- `npm run debug-bot` — `node --inspect src/bot.js`
- `npm run debug-attach` — `node scripts/debug-attach.js` (calls `scripts/_debug-attach.js`)
- `npm run debug-attach-bot` — `node scripts/debug-attach-bot.js` (same shared helper)

**Why:** Right now `debug-attach*` prints connect *instructions* (Chrome / Edge: chrome://inspect…, Node REPL: node inspect ws://…, VS Code: …) but the URL is buried inside prose. `debug` / `debug-bot` rely on Node's own stderr line "Debugger listening on ws://127.0.0.1:9229/…" which mixes with other startup output. In both cases the user has to read carefully to find what to paste into the browser bar.

**Canonical one-liner (verbatim, per user 2026-06-17):**

```
Visit chrome://inspect in your Chrome or Chrome-compatible web browser, and then click on "inspect" there to get started debugging.
```

That's all the user needs — `chrome://inspect` already auto-discovers `127.0.0.1:9229` once configured (one-time browser setup, persistent across sessions), so the line doesn't need to repeat the host:port. The "Chrome or Chrome-compatible" qualifier matters because Firefox/Safari don't expose a Node-inspector UI; the user has to know to switch browsers if they're not already on a Chromium-family browser. Drop the WebSocket URL, drop the Node REPL / VS Code alternatives from the primary printout (keep them in `docs/engineering.md` for power users). One line, one action.

**How to apply (when picked up):**

- `debug-attach.js` and `debug-attach-bot.js` (via `_debug-attach.js`): replace the multi-line "Connect with ONE of:" block in `_printConnectInstructions` with the canonical one-liner above. Move the Node REPL / VS Code alternatives to `docs/engineering.md` for power users.
- `debug` and `debug-bot`: currently `node --inspect <entry>`. To add the same one-liner without wrapping the whole start, use an npm pre-hook: add `"predebug": "node scripts/print-inspector-url.js"` (and `"predebug-bot": ...`). The pre-hook is a one-shot stdout print that fires before Node spawns the inspector. No process wrapping = no signal-forwarding gotchas.
- New helper `scripts/print-inspector-url.js` would be 3–4 lines: just `console.log` the canonical one-liner.
- Per [[feedback-npm-script-100-char-threshold]]: any one-shot inline pre-hook >100 chars promotes to a script file in scripts/.
- Document the convention in the `## Debugging` section of `docs/engineering.md` so future debug-related scripts inherit it.

Not blocking anything; pick up when next touching the debug scripts.

---

**On the public list (2026-09-02).** Published on the README's
Nice-to-Have list as "Debug Scripts Print the Inspector URL", detailed in
`docs/roadmap/nice-to-haves/project_debug_scripts_print_url.md`.
Keep the two in step, and do not add a second entry for it.
