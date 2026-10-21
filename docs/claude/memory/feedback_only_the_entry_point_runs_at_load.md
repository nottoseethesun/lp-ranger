---
name: only-the-entry-point-runs-at-load
description: "Nothing runs when a file is loaded except in the program's one entry point; every other module's top level only declares"
metadata:
  node_type: memory
  type: feedback
  originSessionId: f8b08a58-72ba-4f26-a891-71b9e99630e4
  modified: 2026-10-21T16:33:44.419Z
---

The only code that runs when a file is loaded is in the program's one
entry point, the file the program starts from: `server.js`, `bot.js`, a
script under `scripts/`, a tool's `index.js` under `util/`,
`public/dashboard-init.js`. Every other module's top level only
declares: imports, constants, functions, classes and exports. Reading a
file, `.env`, `process.env` or the command line, writing anything,
logging, starting a timer or a handler, and calling another module's
functions all wait until the entry point's code calls them.

**Why:** the user, 2026-10-21: "It should be a Rule for this and all my
projects, that the only spontaneous execution at load in an app should
occur at one single entry point for the app. That is basic software
engineering. If that rule had been followed, we wouldn't be facing
this." The case: `src/price-fetcher-gate.js` read bot-config.json in a
statement outside any function (since f7b49dd, 2026-05-01). Every
program that loaded the price library ran that read, and the read copies
the settings files over their backups, so a tool under `util/` replaced
LP Ranger's backups while it ran. No call of the tool's reached the
read, so the tool could not pass the parameter that prevents it.

**How to apply:**
- A value a library needs from the settings is read by a function the
  entry point calls, taking whatever only the caller can decide, as
  `readPriceCacheSettings(skipBackups)` does. It is asked for when it is
  used, never copied into a constant at load.
- A constant may be worked out at load only from literals, other
  constants and the language's built-ins (a `Map`, a regular expression,
  `Object.freeze`), never from a file, the environment, the clock or
  another module's function.
- Imports stay at the top ([[feedback_no_lazy_loading]]); under this rule
  they bring in only declarations. A `require` made only for what a file
  does as it loads has nothing left to bring.
- A module's start-up message goes in its own start function, which the
  entry point's calls already reach. This replaces the require-side-effect
  advice once in [[feedback_module_self_announcement]].
- Code that breaks the rule is changed one case at a time, when the user
  asks; never swept, and not counted across the app. The user,
  2026-10-21: "Don't fix more than this instance. Don't measure the
  existence of this anti-pattern in the app." New code follows the rule.
- Related: [[feedback_one_literal_per_shipped_default]],
  [[feedback_util_tools_keep_to_their_own_folders]].
