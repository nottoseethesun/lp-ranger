---
name: feedback_address_bar_names_the_wallet
description: "The address in the browser's location bar always names the current wallet, however the browser came to it; only a tab the browser reloads on its own follows the server"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 54faebf5-9812-48c8-8743-e2dde6ca5007
  modified: 2026-11-26T02:08:25.577Z
---

The address in the location bar always takes priority over everything:
when it names a wallet, the app honors that wallet as the current one,
whether the address was typed or pasted, opened from a bookmark or a
link, loaded at start, or reached by Back or Forward. The wallet dialog
asks for it; once it is imported, the server holds it and the other
tabs reload to it. The one exception is a tab the browser unloaded to
save memory and reloads on its own as the operator returns: it goes on
as if it had stayed open, so it follows the server's wallet.

**Why:** the user, 2026-11-25: "The url entered in the location bar of
the web browser always takes priority over everything, so the wallet
switches and tabs/windows reload accordingly", then, ruling that Back and
Forward are no exception: "it doesn't matter how the web browser got
that address (back/forward, initial start, user paste-and-go): Any which
way, the app honors what's in the url location bar as the now-current
wallet". The unloaded tab follows the user's earlier word: "so it works
for the end-user the same as if the tab/window had never been unloaded
by the browser".

**How to apply:** `pageReloadedByBrowser` (src/client/web/js/dashboard-idle.js)
answers only for `document.wasDiscarded`; any new path that loads a page
naming a wallet keeps the address's priority. Related: the wallet-change
reload, [[project_dashboard_data_flow]].
