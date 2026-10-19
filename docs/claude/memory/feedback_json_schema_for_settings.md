---
name: feedback_json_schema_for_settings
description: "Settings JSON files, bot-config.json included, are validated with JSON Schema (Ajv, draft 2020-12, strict), every object refusing keys it does not name; one schema per setting serves the Save check and the startup check; adding a key to a config file's schema is a decision to ask the user about; .env is checked against an allowlist of variable names"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-19T21:45:11.707Z
---

The JSON settings files, shipped and the operator's copies merged over
them, are validated with JSON Schema: Ajv, draft 2020-12, strict mode.
Every object's schema names each key it takes and refuses any other
(`additionalProperties: false`), so a misplaced or misspelled setting
stops startup instead of being ignored, and a value of the wrong type (a
list where one number belongs) is refused before the app reads it.
Ranges stay in `setting-bounds.json`: the schema for a ranged value takes
its minimum and maximum from there, by name, so there is one literal
per range. `.env` is not JSON: it is checked against the list of
variables the app reads (`ENV_SETTINGS`, src/env-settings.js), and any
other name is refused.

bot-config.json is under JSON Schema too (2026-10-19). Each setting's
schema is written once (`settingSchemas`, src/config-bounds.js): the
Save check (`POST /api/config`) holds a value to it and words a refusal
in the dashboard's terms, and the startup check builds the file's schema
from the same schemas (src/bot-config-checks.js). The Telegram alerts
chosen likewise have one schema (`ALERT_CHOICES`) for their route and
the file. The records file, app-data/position-records.json, is not a
settings file and keeps its record checks (src/config-record-checks.js);
bringing the app-data files under JSON Schema is filed as a
nice-to-have, at the user's request
(docs/roadmap/nice-to-haves/project_app_data_json_schema.md).

LP Ranger's schemas are its own. The user's supe-ons project also uses
JSON Schema, and that is the only thing the two share: never model LP
Ranger's schemas, messages or module layout on supe-ons'.

**Why:** the user, 2026-10-19, on finding that a range was matched to a
setting by its path alone, so `maxRebalancesPerDay` placed in the wrong
file passed and did nothing: "JSON Schema should reject any json keys
(value names, property names, identifiers) that aren't already defined.
I told you to use JSON Schema for the validation. Didn't you do that? If
not, do." That instruction had been given in supe-ons, not in LP
Ranger's history. Later the same day: "I'm not saying that `lp-ranger`
should follow any `supe-ons` schema - of course not! The only
commonality is the fact that `supe-ons` uses JSON Schema and
`lp-ranger` is migrating to using JSON Schema now."

And on how the bot's records ended up in bot-config.json: "if JSON
Schema had been used, you may have thought to ask me if it would be
appropriate to add new keys to enable you to stuff app-data in
app-config, and we could have possibly avoided the problem." A schema
makes every new key in a config file a deliberate edit, and that edit
is the moment to ask.

And at 3:15pm the same day: "On `bot-config.json`, this should be a
simple task to put it into JSON Schema". On the design, one schema per
setting for both the Save check and the startup check: "yes, correct,
that's the right way to fix it. That way, `bot-config.json` is brought
under the JSON Schema umbrella."

**How to apply:** a new settings file gets a schema; a new key is added
to its file's schema; never a hand-written walk that matches keys by
name. Before adding a key to any file under `app-config/`, ask whether
it is something the operator chooses; if it is anything else (a record,
a cache, a derived figure), it does not belong there, and the user
decides. Related: [[feedback_never_cache_in_config]],
[[feedback_where_data_lives]], [[feedback_validate_in_the_core_not_the_ui]],
[[feedback_one_literal_per_shipped_default]].
