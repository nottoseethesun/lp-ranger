---
name: feedback_server_is_a_layer_on_the_bot
description: "Separation of concerns: the bot sits behind a small interface its callers (the server) use, so most code is the bot's alone; a measurement at odds with the design is the finding (the code is coupled), never the shape the design should take"
metadata:
  node_type: memory
  type: feedback
  originSessionId: b6a0b30e-9cd6-4560-a6cd-597053c26378
  modified: 2026-11-24T06:01:42.500Z
---

LP Ranger's design keeps concerns apart. Running the bot is one concern,
behind a small interface. The server is a light layer that calls that
interface, and the interface talks to the bot's files on the server's
behalf. So the right layout has a large `src/bot/` of the files only
`bot.js` and its callers load, a `src/server/` of the files only the
server loads, and `src/lib/` for what both use on their own (config,
logging). The web client already works this way: it talks to the
server's api and loads no bot files.

**Why:** 2026-10-24, the folder split's walk found 194 modules loaded by
both the server and the bot, and one by the bot alone. That count was
the finding: `server.js` never loads `bot.js`; the server loads the
bot's internals itself (the position manager, the start-up module, the
bot's config and the rest), so no small interface stands between them.
I filed that coupling into folders instead of reporting it. When the
user doubted the result, I explained it away, conceded faults I could
not show, and finally told them two bot files was what a light layer
predicts, which is backwards. The user, 2026-10-25: "The scenario where
the server loads everything else bot.js loads is exactly NOT what 'a
light layer on top of the bot' is ... There will be an interface but it
will be small, and that interface will talk to the bot files on behalf
of callers (like the server)." And: "I wish you had a Software
Engineering skill." "You didn't make the client load a bunch of bot
files did you? No, you did not. So you must have some clue."

**How to apply:** Judge every measurement of the code against the design
and the principles behind it: separation of concerns, small interfaces,
layering. When they disagree, the disagreement is the finding: report
that the code departs from the design, never reshape the design to fit
the code. Answer a pointed question from the facts and the design, and
concede only a fault I can show. The layout the user asked for needs the
bot's interface first; moving files cannot make it.

## The rule, stated (2026-11-23), and what was built

The user, asking for the separation: "this is called 'Separation of
Concerns' in software engineering, and means that the code specific to
the 'bot' cannot be located in a `.js` module where code specific to the
'server' is, nor can 'bot' modules be located anywhere other than in
`src/bot/`, and for 'server' modules, they can only ever be located in
`src/server/`." And: "if you find code that truly belongs in `src/lib/`,
you may also create modules there - but that code can never be specific
to bot, server, or client."

Built on branch `improve-separation-of-concerns-re-server-and-bot`: the
interface is `src/bot/bot-interface.js` (`createBot`, `botOperations`),
the one bot module the server loads; bot operations return results with
a reason, never an HTTP status, and `src/server/bot-result.js` alone maps
reasons to statuses. Placement is by concern, not by who loads a file: a
bot module the `util/` tools also import still lives in `src/bot/`.

**How to apply:** a new module goes where its concern is. Server code may
import `src/server/`, `src/lib/` and the interface only; bot code
`src/bot/` and `src/lib/`; `src/lib/` only itself. A route reads the
request, asks the bot, answers; the work goes in a bot module behind the
interface. Moving a module that reads a file next to itself
(`__dirname`) breaks that read silently: `il-guard.js` lost its manual
link that way until a test caught it.

## What goes in src/lib/ (the user, 2026-11-23)

"Before adding anything to `src/lib/`, break out anything in the module
that you are considering moving to `src/lib/`, that is only used by one
of client, server, or bot, into the respective directory for those."

**The one exception, `src/lib/config.js`** (the user, 2026-11-24): "On
`config.js`, we won't refactor that; it's handy to have it all in one as
it is now." It keeps every setting, though 15 only the bot reads and 2
only the server. Do not propose splitting it.

**How to apply:** judge by use, not by kind: a logging module only the
bot loads is the bot's. Check each export, not just the module, and
follow a `src/lib/` importer to its own users. A part used by one of the
three and a `util/` tool may stay. My first pass put modules in `src/lib/`
by kind (logging, generic) and left three bot-only modules and two
server-only functions there; the user's rule caught them. Moving a figure
out of `src/lib/config.js` to the bot means nothing reads it at load:
make sure the startup check (src/lib/settings-check.js) still refuses a
bad value, and pin that in its own test.
