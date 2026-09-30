---
name: project_telegram_markdown_drops_alerts
description: "OPEN BUG, Production 0.9.7, 2026-09-30: Telegram alerts are sent with parse_mode Markdown and no escaping, so any notification carrying arbitrary error text is rejected 400 and silently dropped. The compoundFail alert was lost this way — the channel fails exactly when there is something to report."
metadata:
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-09-30T16:57:22.503Z
---

**Open.** Confirmed on Production 0.9.7, 2026-09-30 13:23:14Z.

## What happened

A compound failed, `_executeCompoundInner` called
`notify("compoundFail", …)` as designed, and Telegram refused it:

```
[telegram] [2026-09-30 13:23:14Z] Send failed: 400
{"ok":false,"error_code":400,"description":"Bad Request: can't parse
entities: Can't find end of the entity starting at byte offset 597"}
```

The operator saw nothing. They then confirmed the connection with the
Test feature, which succeeded at 16:37:19Z — because the test message
is a fixed, clean string — and confirmed that **"Compound Failed" is
ticked** in Production's notification list.

So every alternative is ruled out: the event was enabled, the code
called `notify`, the token and chat id were valid, and Telegram itself
refused the message. The parse failure is the whole cause.

## Root cause

`_send` (`src/telegram-notifications/telegram.js:149`) posts every
message with `parse_mode: "Markdown"` and **never escapes the text**.

The `compoundFail` body interpolates `err.message`, which here was a raw
ethers dump: `transaction="0xf8f0…"`, `info={ "error": { "code":
-32000, … } }`, `code=NONCE_EXPIRED`. Telegram's legacy Markdown treats
`_`, `*`, `` ` `` and `[` as entity delimiters, so an odd number of any
of them makes the whole message unparseable and the send returns 400.

This is not specific to compounds. **Any** notification that embeds
arbitrary text — an error message, a token symbol, a pool name — can
carry a delimiter and be dropped. The failure is silent to the
operator: `_send` logs a warning and returns `false`, and no caller
treats `false` as worth surfacing.

The shape of the defect is the worst one an alerting channel can have:
it works for routine and test traffic, and fails on exactly the
messages that report a problem.

## The fix, when taken up

Escape the interpolated text, or drop `parse_mode` for messages that
carry arbitrary content. Escaping is the better answer, since the
headers deliberately use `*bold*` — so escape the *values* at the point
they are interpolated, not the assembled string. Telegram's legacy
Markdown has no official escape for every case, which is a further
argument for `MarkdownV2` (well-defined escaping) or plain text for the
body with the header kept formatted.

Whatever is chosen, a 400 from Telegram should be visible beyond a
`log.warn` — a dropped alert currently looks identical to no alert
being due. Consider one retry as plain text on a parse failure, so the
operator always gets the words even when the formatting is lost.

Related: [[project_tx_wait_not_failover_covered]], the compound failure
that produced the message this bug then swallowed.
