---
name: project_telegram_markdown_drops_alerts
description: "FIXED, shipped in 0.9.8; hit Production on 0.9.7 2026-09-30: Telegram alerts were sent with parse_mode Markdown and no escaping, so any notification carrying arbitrary error text was rejected 400 and silently dropped. A parse refusal now resends the same words unformatted."
metadata:
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-01T16:39:47.473Z
---

**Fixed**, shipped in 0.9.8 (Production 2026-10-01). Confirmed on
Production 0.9.7 at 2026-09-30 13:23:14Z.

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

## The fix taken

A refusal naming a parse error resends the same words with no
`parse_mode` at all (`_send` / `_isParseFailure`,
`src/telegram-notifications/telegram.js`). The formatting is what gets
sacrificed, never the alert.

Escaping the values was considered and rejected. It would be tidier if
legacy Markdown had a dependable escape, which it does not — that is
why MarkdownV2 exists — and an escaping pass that missed one future
interpolation site would restore exactly this silence. There are at
least three arbitrary-text sites already (`_hostname`, token symbols via
`_truncSym`, and `details.error`), and token symbols on this chain
include names like `NoExpectationsButPumpMyBagsRichardPlease`.

A 400 that is not about parsing — a bad chat id — is not retried, since
resending fixes nothing about it. Losing both attempts is logged at
error level, because nothing downstream reports it and the operator's
only other sign would be the silence itself.

Pinned by four cases in `test/telegram.test.js`.

Related: [[project_tx_wait_not_failover_covered]], the compound failure
that produced the message this bug then swallowed.
