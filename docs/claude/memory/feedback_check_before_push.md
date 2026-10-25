---
name: always-run-npm-run-check-before-push
description: "Run full local checks (lint+test+coverage) before every git push, but not a second time for code that just passed; Prettier in commit hook can break lint"
metadata:
  node_type: memory
  type: feedback
  originSessionId: b6a0b30e-9cd6-4560-a6cd-597053c26378
  modified: 2026-10-24T22:00:23.118Z
---

ALWAYS run `npm run check` before pushing. The Prettier pre-commit hook
reformats code on commit, which can expand lines and break the max-lines
lint rule. Running lint before commit is NOT sufficient — the committed
code differs from what was linted.

**Why:** CI failed multiple times because Prettier expanded compacted code
after the commit hook ran, pushing files over 500 lines.
**How to apply:** After every `git commit`, run `npm run lint` (or full
`npm run check`) to verify the committed code still passes. If it fails,
fix and amend before pushing.

**Not twice for the same code.** When the full check has just passed on
both Node versions on exactly the code being pushed, and only docs have
changed since (the pre-commit hook lints those), push without running it
again. The user, 2026-10-24, after I started it again before pushing
three commits whose code had just passed: "You already ran all the
checks, why again?"
