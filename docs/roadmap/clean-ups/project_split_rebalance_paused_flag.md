# Split the Overloaded Rebalance-Paused Flag

> **Status:** Nice-to-have / internal clarity &mdash; not a bug. Every
> case behaves correctly today. Funds are never at risk.

## Plain language

One internal flag, `rebalancePaused`, marks a rebalance the bot has
**aborted** and will not try again by itself. Its name says "paused",
which is wrong for every case that sets it, and four different cases
set it. The dashboard shows them all the same way, so an operator cannot
tell from the screen which one happened.

## Detail

The four writers:

1. A swap refused because its price impact exceeds the slippage setting
   (`_handleError`, `src/bot-loop.js`).
2. Mid-rebalance recovery that has failed four times (same function).
3. A failed attempt to re-open a closed position, just before the
   position is retired again (same file).
4. A rebalance the price outran: the price left the new range before the
   mint, with the old position already emptied (`holdAfterPriceMove`,
   `src/price-moved-stop.js`).

All four stop automatic rebalances at the same gate, turn the status
pill to a red ABORTED, and raise the same alert dialog with the error's
own message, in a yellow warning shell for case 4. None clears by itself: a Slippage save clears it, and
otherwise a position left drained is retired, within seconds in case 3
and after thirty minutes in the others.

The shared flag already shows through in one place. While it is set,
the Manage button is disabled with a tooltip written for case 3 alone,
"Re-open just failed — the bot will auto-retire shortly", whichever case
set it (`_MANAGE_PAUSED_HELP`, `public/dashboard-manage-ui.js`). Beyond
that the behaviour is right; it is the naming that makes correct prose
about any one case hard to write.

## Fix when prioritized

Rename the flag to `rebalanceAborted`, and record which of the four
cases set it, so the alert and the Manage button's tooltip can word each
case. Clear
it wherever the flag is cleared today, including the slippage-change
handler and the key-migration path. Roughly fifteen source files, several
tests, and one field in the `/api/status` payload: a server and browser
change that ships together. Worth its own pull request, so the rename is
reviewed on its own rather than buried in a feature.
