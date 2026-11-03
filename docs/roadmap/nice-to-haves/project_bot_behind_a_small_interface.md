# Keep the Bot Behind a Small Interface

> **Status:** Nice-to-have — not a bug. The app works correctly without
> it, and funds are never at risk: it would change how the code is
> organized, not what the app does. It is a large, deep refactor, to
> clean up the folder split of 2026-10-25 (PR #234), which filed the
> server's use of the bot's internals into folders instead of putting an
> interface between them. Filed at the user's word (2026-10-25): "Just
> save the memory and write it in as a nice-to-have", and "It's a large,
> deep refactor to clean up what you did, so note that in the
> nice-to-have."

## What is there now

The server loads the bot's internals itself. `src/server.js` never loads
`src/bot.js`. It and the server's own modules import the position
manager, the start-up module (`src/lib/server-auto-start.js`), the bot's
settings (`src/lib/bot-config-v2.js`) and many other modules of the bot
directly. A dependency walk from each entry point finds 194 modules that
both the server and the bot load, 24 that only the server loads, and one
that only the bot loads (`src/bot/bot-private-key.js`).

The folder split followed that walk: `src/server/` holds the 24,
`src/bot/` the one, and the bot's own code sits in `src/lib/` as shared.
It took the walk's count for the shape the folders should take, when the
count was the finding: no small interface stands between the server and
the bot.

The web client already keeps its concern apart: it talks to the server's
api and loads no bot files.

## The idea

Separation of concerns. Running the bot is one concern, kept behind a
small interface. The server is a light layer on top: it calls that
interface, and the interface talks to the bot's files on the server's
behalf. The user, 2026-10-25: "There will be an interface but it will be
small, and that interface will talk to the bot files on behalf of
callers (like the server)."

Then the folders follow from the code: "The proper file set would look
like a whole bunch of files that only `bot.js` and its callers load, and
those would be under `src/bot/`, and likewise for `src/server/`." What
both use on their own, such as the settings and logging, stays in
`src/lib/`.

## Shape of the work

A large, deep refactor: the server's use of the bot's internals runs
through much of the server, so moving files cannot fix it.

- List every call the server and its own modules make into the bot's
  code: starting and stopping positions, the status answer's view of
  each position, Rebalance Now and Compound Now, scans, Reload Current
  Position and Re-scan Prices, and settings saves among them.
- Give the bot one small interface for those calls: a module the
  headless entry point and the server both use. `src/bot.js` stays an
  entry point, since only an entry point runs anything when it loads.
- Route the server's use of the bot through that interface, one area at
  a time, each with its tests.
- Then move the files: those only the interface reaches into
  `src/bot/`, those only the server loads into `src/server/`, and what
  both use on their own stays in `src/lib/`.
- A gate can then hold the line, as the unused-module walk does: the
  server loads the bot's files only through the interface.
