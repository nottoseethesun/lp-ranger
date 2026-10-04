# Claude memory

Durable, project-scoped knowledge that Claude Code loads each session:
preferences the user has stated, decisions and their rationale, and open
items — the things not derivable from the code or git history.

## Layout

| Path | Tracked? | Contents |
| ---- | -------- | -------- |
| `MEMORY.md` | yes | Index of the `feedback_*` rules — how to work. One line per memory. Loaded every session. |
| `PROJECT-STATE.md` | yes | Index of `project_*` / `reference_*` — state, incidents, deferred items. NOT auto-loaded; open it before a status report, audit or release. |
| `*.md` | yes | Public memories — generic rules, architecture, project state. |
| `private/` | dir only | Machine-local memories. Contents gitignored; see its README. |
| `archive/` | yes | Resolved items, kept for history, deliberately not indexed. |

## Why it lives here rather than under `~/.claude/`

By default Claude Code stores memory in
`~/.claude/projects/<sanitized-absolute-path>/memory/`. That path is derived
from this checkout's absolute location, so it neither travels with the repo
nor survives moving the checkout. Keeping memory in the repo means a fresh
clone arrives with the project's accumulated context already attached.

## Wiring it up on a new machine

Set `autoMemoryDirectory` in `.claude/settings.local.json` (gitignored, so it
is per-machine) to the absolute path of this directory:

```json
{ "autoMemoryDirectory": "/absolute/path/to/lp-ranger/docs/claude/memory" }
```

It cannot go in the tracked `.claude/settings.json` — Claude Code ignores
`autoMemoryDirectory` from checked-in project settings by design.

Without this setting Claude still works; it just starts a fresh, empty memory
in the default location and none of the below is loaded.

## Writing a new memory

One fact per file, frontmatter with `name` / `description` / `metadata.type`,
then the fact. Add a one-line pointer to the matching index: `MEMORY.md` for a
`feedback_*` rule, `PROJECT-STATE.md` for `project_*` state or a
`reference_*` pointer.

**Both indexes are read whole, so each is capped by the 200-line read limit.**
When one approaches it, the fix is to merge related memories — not to shorten
hooks, which are already one line, and not to split again. A third index would
be one more file a session has to know to open.

**Before saving, decide public or private.** This repo is public and the
production instance holds an unlocked wallet. Infrastructure, remote-access
details, hostnames, wallet or contract addresses, and live position or P&L
figures go in `private/`. Everything else goes here so it travels. If a rule
is generally useful but its example identifies the operator, keep the rule
public and replace the example with a placeholder — see `feedback_logging.md`.
