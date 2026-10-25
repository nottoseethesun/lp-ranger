# Give the Server and the Bot Their Own Folders

> **Status:** Nice-to-have — not a bug. The app works correctly without
> this, and funds are never at risk: it would move files and change
> nothing the app does. Deferred until the current bug fixes are
> finished.

## What is there now

All of the application's own code lives under `src/`:

- **The entry points** sit directly in `src/`: `src/server.js`, the
  dashboard's server, which runs the bot as well; `src/bot.js`, the bot
  without the dashboard; and `src/telegram-send.js`, the one-shot sender
  of the Telegram shutdown alert.
- **The web client** has a folder of its own, `src/client/web/`.
- **Every other module** is in `src/lib/`, whichever program uses it:
  the server's own (its routes, the dashboard's api), the bot's own (the
  poll cycle, rebalancing, compounding), and the ones they share.

## The idea

Give the server and the bot folders of their own beside `src/client/`:
`src/server/` for the server's own modules and `src/bot/` for the bot's.
`src/lib/` would keep what they share with each other, the web client
and the tools in `util/`.

## To settle first

- **What counts as the bot's own.** `src/server.js` runs the bot too, so
  most of the bot's modules are loaded by both entry points.
- **Whether the entry points move into their folders.** If they do, the
  command that starts the server without npm changes again (today it is
  `node src/server.js`), and the release notes must say so. The npm
  commands would not change.

## Shape of the work

The same as the moves into `src/lib/` and `src/client/web/`: each moved
file's `require` and `import` paths, the folders the app finds from its
own location, the lint targets (`scripts/lint-targets.js`,
`eslint.config.js`, `knip.json`), and the docs that name the folders.
