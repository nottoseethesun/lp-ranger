---
name: feedback_edit_tool_not_python
description: "Use the Edit/Write tools to change files — never a python3 heredoc, sed, or awk to patch source"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 69776dd5-edb5-451f-b253-a207133d6169
  modified: 2026-09-12T23:39:24.494Z
---

Change files with the **Edit** tool (or **Write** for a new file). Do not
patch source with `python3 - <<'EOF'`, `sed -i`, or `awk`.

**Why:** the reason I reached for Python was assertion-guarded edits —
`assert s.count(old) == 1` fails loudly instead of silently replacing
nothing. Edit already has exactly that property: it errors when the
target string is absent or not unique. So Python bought nothing the
dedicated tool does not, while adding three costs:

- **An undeclared dependency.** Python is not in this project's
  toolchain. Routine edits should not need it.
- **Hand-escaping.** Every `\u`, `\\`, backtick and quote has to survive
  both the shell heredoc and the Python string. On 2026-09-12 that cost
  two redone patches — one on a `❌` escape, one where the comment
  indentation in my pattern was two spaces off and the assert fired.
- **Unreadable diffs in the transcript.** A twenty-line Python block to
  change four lines buries what actually changed.

The user, 2026-09-12, watching it: "What are you doing running python?"

**How to apply:** reach for Edit first, every time. Read the file (or the
relevant lines) first so `old_string` matches byte-for-byte — the same
discipline the asserts were standing in for. `replace_all: true` covers
the repeated-token case.

**Where a script is still right:** generating or transforming *data*
(building a JSON fixture, reshaping `docs/openapi.json` through
`json.load`/`json.dump`, bulk analysis across many files). The rule is
about editing source, not about never running an interpreter. Prefer
`node` over `python3` there anyway — it is already this project's
runtime. Related: [[feedback_no_npx]] on using the project's own
tooling rather than reaching outside it.
