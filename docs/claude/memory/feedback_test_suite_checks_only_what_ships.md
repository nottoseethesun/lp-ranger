---
name: feedback_test_suite_checks_only_what_ships
description: "The test suite checks only what ships (the JSON defaults, .env.example), never an operator's .env or override copies; local and CI must agree. An operator's own values are checked by the diagnostic tool and at startup"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-18T16:53:55.443Z
---

The test suite reads only files that ship: the JSON settings defaults
and `.env.example`. It never reads an operator's `.env` or their override
copies in `app-config/user-configurable/`. Tests of the checking code use
fixtures of their own, in temporary directories.

**Why:** the user, 2026-10-18: "the test suite cannot be subjected to
local variations, because then we can get a difference [in] pass/fail
result between the remote build and local. That's the whole point of the
diagnostic tool that I have requested, to bridge that gap." I had
proposed that the suite's first tests check the operator's `.env` and
override copies.

**How to apply:** an operator's own settings are checked by the
`validate-config-values-with-any-user-overrides` diagnostic in
`util/diagnostic/` and by the app at startup, both through the same
library the shipped-values test uses. A test that needs an operator-style
file writes its own. Related: [[feedback_tests_with_implementation]],
[[feedback_signal_substitution]].
