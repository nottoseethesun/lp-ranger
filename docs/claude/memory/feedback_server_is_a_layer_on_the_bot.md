---
name: feedback_server_is_a_layer_on_the_bot
description: "Separation of concerns: the bot sits behind a small interface its callers (the server) use, so most code is the bot's alone; a measurement at odds with the design is the finding (the code is coupled), never the shape the design should take"
metadata:
  node_type: memory
  type: feedback
  originSessionId: b6a0b30e-9cd6-4560-a6cd-597053c26378
  modified: 2026-10-25T07:58:23.379Z
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
