# Skip a Left Position's Lifetime Scan

**Not a bug: an optimization.** Nothing is being built; this files the
idea.

## What Happens Now

On an unmanaged position, the dashboard asks the server for its figures
in two steps: the current figures first, then the lifetime figures. If
the operator switches to another position while the first step is still
loading, the dashboard drops its answer, since it belongs to a position
no longer on screen. It still asks for the second step, so the server
works out the lifetime figures of a position nobody is looking at, and
the dashboard drops that answer too.

Nothing wrong shows on screen. The cost is the server's time: on a
position whose history is not cached yet, that work can take long, and
its requests to the blockchain wait in the same queue as the bot's.

## The Improvement

Skip the second step when the first step's answer was dropped for being
about a position no longer on screen.

## Where

`src/client/web/js/dashboard-unmanaged.js`: the first step returns the
same value when the position is open and when its answer was dropped as
stale, so the second step cannot tell the two apart.
