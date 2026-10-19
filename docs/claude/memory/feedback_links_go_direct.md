---
name: feedback_links_go_direct
description: "Every link points at its final address. When a link redirects, replace it with where the redirect lands — or with the right page, when the redirect drops the path"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-16T17:25:26.751Z
---

A link in the app, its docs or its config points straight at its final
address, never through a redirect. When a link is added or touched,
check it with `curl -s -o /dev/null -w '%{http_code} %{redirect_url}'`,
which reports a redirect without following it.

**Why:** user, 2026-10-16, during the 9mm data api migration: *"if
anything is redirecting, such as e.g. the 'Dex Detail Page', also
correct that to just go direct to the right address in the first
place."* That session showed what a redirect costs. 9mm moved its site
to app.9mm.pro and redirected every old dex.9mm.pro address to the new
home page, dropping the path, so the Pool Details dialog's link to a
pool's page landed on the home page instead. A redirect hands the link's
meaning to somebody else's server configuration.

**How to apply:**

- The direct address is the right page, not merely the redirect's
  target. When a redirect drops the path, find the new page; for
  app.9mm.pro the pool page is `/pools/{address}`, read from the app's
  route table.
- Follow a chain to its end: `moralis.io` went through
  `developers.moralis.com` to `moralis.com`.
- A renamed GitHub repo redirects too. This repo was once
  `9mm-lp-position-manager`.
- Strings that look like links but are not followed are outside the
  rule: an xml namespace name such as `http://www.w3.org/2000/svg`
  (changing it breaks every svg), and quoted legal text such as the
  Apache license. A `$schema` address with a version range, such as
  `knip@5`, redirects by design; the user had not ruled on it as of
  2026-10-16.

Related: [[project_9mm_api_sunset]], [[feedback_full_repo_grep]].
