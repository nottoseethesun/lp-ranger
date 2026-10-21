---
name: util-tools-use-core-settings-only
description: "A util/ tool reads LP Ranger's core settings (chains, endpoints, contracts, keys), never the app's preferences, such as the Moralis on/off switch"
metadata:
  node_type: memory
  type: feedback
  originSessionId: f8b08a58-72ba-4f26-a891-71b9e99630e4
  modified: 2026-10-21T20:04:19.522Z
---

A tool under `util/` reads only LP Ranger's core settings: the chains,
their endpoints and contracts, and the keys it needs. It never reads or
honors the app's preferences, the switches that shape how the app itself
behaves, such as the dashboard's Moralis on/off switch.

**Why:** the user, 2026-10-21, when I suggested the bookkeeping report
honor the Moralis on/off setting: "no, the utility doesn't use app
preferences, only core settings."

**How to apply:** when a tool reads configuration through the app's
resolvers, take what is needed to reach the chain and the services
(`chains.json`, `.env`, the endpoint list, the api-key store) and leave
the preferences. The endpoint list is core even though it puts the
endpoints saved in the dashboard (`rpcUrls` in bot-config.json) first:
the user, 2026-10-21, on the report's default endpoint coming from it,
"yes, that's a core setting". Unsure which a setting is? Ask the user.
Related: [[util-tools-keep-to-their-own-folders]].
