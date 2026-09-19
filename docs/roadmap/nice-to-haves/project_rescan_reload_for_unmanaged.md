# Re-scan Prices and Reload for unmanaged positions

**Not a bug.** Both actions are correct to refuse today, and the dialogs
say why. This is about removing the refusal.

## What happens now

Both dialogs open on an unmanaged position and disable their action with
a notice naming **Manage** as the route. Behind that, the server would
refuse anyway: `_resolveStateAndPosition`
(`src/server-reload-position.js`) resolves the position out of the
per-position **bot state** map, which only holds entries for positions
with a running bot loop. Without one there is no `activePosition`, and
the route answers `404 position not resolvable`.

So the block is a consequence of how the work is driven — both routes
ask a live bot loop to do something on its next pass — rather than a
decision about what an operator should be allowed to repair.

## Why it matters less than it looks

Most of what Re-scan Prices repairs is not on screen for an unmanaged
position. It re-values Fees Compounded, Total Lifetime Deposit, and the
HODL baseline's entry value; an unmanaged position shows **no Lifetime
panel** at all (see `docs/claude/memory/project_unmanaged_na_principle.md`).
Its Current panel is recomputed from chain on each request by
`src/position-details.js`, so the failure these buttons exist to
correct — a bad price recorded once and treated as settled — mostly does
not arise.

## The gap that remains

The unmanaged Current panel still reads shared, pool-keyed caches:
`tmp/historical-price-cache.json` and the epoch cache. A bad price in
either is visible there, and there is no way to correct it for that
position without managing it first.

The workaround is real but clumsy: **Manage → Re-scan Prices → stop
managing.**

## Shape of the fix

Give both routes a path that does not depend on bot state:

- Resolve the position from the position store rather than from the
  per-position state map, the way `computeLifetimeDetails` already does
  for the unmanaged details view.
- Run the re-value inline on the request rather than handing it to the
  next poll of a loop that is not running.

The second point is the cost. A managed re-scan is asynchronous — the
route returns immediately and a bot pass does the work. Unmanaged, there
is nothing to hand it to, so either the request holds open for minutes
on a long rebalance chain, or the server grows a job runner for
positions it is not otherwise tracking.

Worth doing only if a bad price actually shows up on an unmanaged
position. Until then the Manage-and-stop workaround covers it.

## Related

- `docs/claude/memory/project_unmanaged_na_principle.md` — what an
  unmanaged position deliberately does not show.
- `src/server-rescan-prices.js` — the route's own contract, including
  what it deliberately does not touch.
