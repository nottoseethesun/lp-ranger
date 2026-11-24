---
name: feedback_dont_force_a_placement
description: A suggested file location that needs new machinery to work is likely wrong; verify its premise and say so before building
metadata:
  node_type: memory
  type: feedback
  originSessionId: 54faebf5-9812-48c8-8743-e2dde6ca5007
  modified: 2026-11-24T06:25:13.602Z
---

When honoring a suggested place for a file needs new machinery to make it
work (a server route, a copy step, a build rule), stop: check the premise
behind the suggestion, and say what the place would cost before building
anything.

**Why:** 2026-11-24, the user asked me to point the dashboard at the copy of
the 9mm Pro logo in `assets/` and delete the one in `src/client/web/`. The
server serves only `src/client/web/`, so I added an `/assets/` route. The
user: "The only reason I suggested `assets/` for it is in case that log is
used e.g. by the Github Pages build or a document such as a README or other
markdown document. Please don't do anything weird to force an image that
doesn't belong in `assets/` to be there; I could have been in error on that
choice." Nothing but the dashboard used the logo; the route was undone.

**How to apply:** when a request carries a reason ("in case it is used
by …"), check that reason first. If it does not hold, or the move needs
machinery the codebase does not already have, answer with the finding and
the simpler place rather than building the machinery. `assets/` holds what
the README, the Pages build or a Markdown document uses; the web client's
images live in `src/client/web/images/`. Related: [[feedback_dont_invent_a_requirement]],
[[feedback_basic_fix_first]].
