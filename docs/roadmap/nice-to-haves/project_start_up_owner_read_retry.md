# Retry the Start-Up's Owner Read on Another Endpoint

> **Status:** Nice-to-have / polish — not a bug. Funds are never at
> risk, and the position starts at the next launch.

When the server starts and the wallet unlocks, the start-up asks the
blockchain who owns each managed position's NFT before starting it. An
NFT that has left the wallet, or no longer exists, takes its position
off the managed list.

The question goes through an rpc endpoint. If the endpoint answers it
with an error of its own, a rate limit say, the answer says nothing
about the NFT. The position then stays on the managed list, but it is
not started at this launch; it starts at the next one.

## Why this is not required

- **Rare.** It needs an endpoint to answer with an error at the moment
  the start-up asks about that one position.
- **Always resolved.** The position stays on the managed list, so the
  next launch starts it.
- **Nothing is lost meanwhile.** The position's settings and history
  are kept; only its rebalancing and compounding wait for the restart.

## Possible design when prioritized

Ask again within the same launch, the way the app asks for pool data: a
few tries at each endpoint, moving to the next endpoint after a failure
(the bounded read in `src/rpc-read-retry.js`, sized by
`boundedReadAttemptsPerEndpoint`). Only when every try fails does the
position wait for the next launch.
