---
name: reference_modern_web_guidance_local
description: "The modern-web-guidance skill's tool is a devDependency here; run it from node_modules, never through npx"
metadata:
  node_type: memory
  type: reference
  originSessionId: 01dbcc05-c2af-4091-ac37-493cbfdfa591
  modified: 2026-11-27T22:46:27.726Z
---

The modern-web-guidance skill tells you to run
`npx -y modern-web-guidance@latest …`. This project bans npx, so the
user had it installed as a devDependency (2026-11-27: "can you install
it as a `dev` dependency so that it can be run without `npx`?"), pinned
exact at 1.0.0, the newest version then more than two weeks old.

Run it as:

```sh
./node_modules/.bin/modern-web-guidance search "<query>" --skill-version <the SKILL.md's>
./node_modules/.bin/modern-web-guidance retrieve "<id>,<id>" > <scratchpad file>
```

It warns when the plugin's SKILL.md is newer than the one it expects;
that warning is harmless. Raising the pinned version is a dependency
change: check the release's age and publisher first. See
[[feedback_no_npx]].
