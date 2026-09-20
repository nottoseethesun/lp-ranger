---
name: feedback-user-launches-app
description: "User always launches the app themselves during manual testing so they know exactly what they are testing. Don't offer to run `npm start` for them."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: d932d59e-01b4-45db-82b1-6d987abcda8f
---

Never offer to run `npm start` (or any app launcher) for the user during manual testing. The user always launches the app themselves.

**Why:** The user's stated reason: "I always launch so I know what I am testing." Launching personally means they control the exact commit / build / env they exercise; offering to do it for them is noise.

**How to apply:** After a change is ready for manual verification, describe what to look for (specific UI rows, log lines, refresh behavior). Do not add "Want me to launch it?" or similar. The user will run the app themselves; wait for observations.

## They may launch at any moment — never leave the tree broken (2026-09-19)

Because the user launches the app themselves, and does so whenever they
are ready, **the working tree must be runnable between edits, not just
after the last one.**

**What happened:** I added a call to a helper, then wrote the helper in a
second edit. The user started the server in the gap. Node caches a module
at first `require`, so the server held that broken intermediate and every
poll logged:

```text
[bot] P&L update error: _openNftMintGasNative is not defined
```

Nothing was wrong with the finished code. The running process simply had
a version that never should have existed on disk. The user, reasonably:
*"I didn't realize you'd written anything at that point."* They cannot be
expected to know when a multi-edit sequence is mid-flight.

**How to apply:** write the definition before the call site, or make both
in a single edit. Any sequence that leaves the tree un-runnable should be
one edit, not several. And when a "not defined" error names something
just added, check the module-load time against the file's mtime before
diagnosing the code — a restart is usually the whole fix.
