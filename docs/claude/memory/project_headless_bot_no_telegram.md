---
name: project_headless_bot_no_telegram
description: "The headless bot (npm run bot) sends no Telegram alerts, by the user's decision 2026-11-27: the server run unattended already sends every alert with no browser open; not a finding, not a nice-to-have"
metadata:
  node_type: memory
  type: project
  originSessionId: 01dbcc05-c2af-4091-ac37-493cbfdfa591
  modified: 2026-11-28T02:16:11.169Z
---

The headless bot, `npm run bot` (`src/bot.js`), never loads the
Telegram settings, so it sends no Telegram alert of any kind. That is
the user's decision, 2026-11-27, not a gap to fill.

**Why:** the server sends every alert itself, with no browser open,
once it has decrypted the Telegram keys with the wallet's password: at
its start, with `WALLET_PASSWORD` in `.env` or the password typed at
`--unlock-at-terminal`, or at an unlock or a wallet import from the
dashboard, after which the browser can be closed. So the server, run
unattended, is the headless way to run with alerts. Told that, the user
withdrew the nice-to-have they had just asked for: "Great, so then we
actually don't need the bot to send Telegram messages: You can remove
that item from the nice-to-haves list."

**How to apply:** don't report the headless bot's missing alerts as a
finding, and don't file them as a nice-to-have. A server started with
`PRIVATE_KEY` brings no password, so it sends no alerts either; that is
the separate nice-to-have [Telegram and Moralis Keys in a PRIVATE_KEY
Session](../../roadmap/nice-to-haves/project_private_key_api_keys.md).
Related: [[feedback_filing_a_nice_to_have]].
