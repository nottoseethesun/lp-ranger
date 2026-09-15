# Fan Reads Out Across RPC Endpoints

> **Status:** Nice-to-have / throughput — not a bug. Every figure the app
> produces is correct today. Funds are never at risk. **Deliberately
> deferred until the app is solid — revisit no earlier than March 2027.**
> It changes the path every blockchain read in the process travels, which
> is not a thing to touch while stability outranks speed.

## Plain language

Every request the app makes to the blockchain waits in one queue and
leaves one at a time, four per second. That pace exists to stay inside
what a public endpoint will tolerate from one machine.

But the app is configured with three endpoints, run by three different
operators. Each of them polices only the traffic that arrives at its own
door. Queueing all three behind a single four-per-second budget spends
one endpoint's allowance and leaves the other two idle. Spreading reads
across all three would finish a history rebuild in roughly a third of
the time without asking any one of them for more than it allows today.

## Detail

The single queue is justified in `src/rpc-request-manager.js` like this:

> Rate limits are published per IP, not per endpoint object. This
> process may hold three providers … and every one of those shares the
> same source address. A per-provider or per-scan limiter would each
> think itself well-behaved while the machine as a whole sailed past the
> limit. One queue, one budget.

That reasoning is correct for two provider objects pointing at the **same
URL**, and it is the reason a naive per-provider limiter is wrong. It
does not hold for three **different operators**: `rpc-pulsechain.g4mm4.io`
rate-limits what reaches g4mm4, `rpc.pulsechain.com` limits what reaches
it, and neither counts the other's traffic. Three independent budgets
are currently serialized into one.

**Keep that paragraph accurate whatever happens to this entry.** Its
first half is load-bearing and must stay; only the leap from "same URL"
to "any endpoint" is wrong.

## Fix when prioritized

The request manager decides, because it is the only thing that sees
every lane's depth. It cannot do so in its present shape: `acquire()` is
called from `_patchRequestPacing` (`src/bot-provider.js`), which wraps a
single provider's `send()` — below the point where a provider is chosen.
So pacing and routing split:

| Piece | Role |
| --- | --- |
| `acquire(lane)` | One queue per endpoint, each on its own interval. `buildProvider` passes the lane index in at construction, so a provider paces against its own budget. |
| `nextLane()` | A pure query, no waiting. The managed-read Proxy asks which provider to dispatch to. |
| `getCurrentRPC()` | Unchanged, and the sole authority for writes. |

**Writes never fan out.** A transaction that wanders between endpoints
mid-nonce is a bad day; only reads may spread.

**Spill on a queue depth of one.** Idle, nothing is queued and everything
goes to the primary — preferred endpoint, no traffic sprayed for no
reason. Under a scan something is always queued, so it fans out across
all three. It scales on contention with no tuning knob.

## Unknowns, and how to settle them cheaply

Two things are assumed above and neither is verified:

- **Per-endpoint ceilings differ.** `rpc.pulsechain.box` is documented at
  50 requests per 10 seconds — 5/s. Running a lane at 4/s puts it at 80%
  of that, so lanes want per-endpoint intervals rather than one shared
  number.
- **The three operators are independent.** The domains suggest it. If any
  two sit behind shared infrastructure, the fan-out buys less than three
  lanes' worth.

Both are answered by a throwaway script that hits the other two endpoints
at 4/s for a minute and watches for a 429. Run that first; if one
complains, there is no design question left to have.

## Why this is not the first lever to reach for

It triples throughput while leaving the waste in place. The request
*count* is the actual cost driver, and
[Merge Per-Topic Log Queries Into One Call Per Chunk](project_merge_per_topic_log_queries.md)
halves it for a change contained to two functions. Same wall-clock win,
and it does not touch the path every read travels.
