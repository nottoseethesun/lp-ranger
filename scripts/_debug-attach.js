/**
 * @file scripts/_debug-attach.js
 * @description Shared core for the debug-attach scripts.  Takes a
 *   target descriptor (`server` vs `bot`), locates the running PID,
 *   sends `SIGUSR1` to start the V8 inspector, and prints connect
 *   instructions.  The leading underscore marks this as an internal
 *   helper consumed by `debug-attach.js` and `debug-attach-bot.js`.
 *
 *   See `docs/engineering.md` § Node Debugger (Inspector) for usage.
 */

"use strict";

const { log } = require("../src/log");
const { execSync } = require("child_process");
const { findListenerPids, psCmd } = require("./_find-process");

const INSPECTOR_PORT = Number(process.env.INSPECTOR_PORT || 9229);

/*- `pgrep -af` walks /proc and prints `<pid> <full-cmd>` for each
 *  matching process.  The `-f` flag means the regex matches the full
 *  command line, so an npm-script wrapper like `sh -c 'node bot.js'`
 *  ALSO matches.  Filter to processes whose command starts with
 *  `node ` so we get the real Node process, not its shell wrapper —
 *  signalling the wrapper does not reach the inner Node interpreter. */
function _pgrepByEntry(entry) {
  try {
    const out = execSync(`pgrep -af 'node ${entry}\\.js'`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return [];
    return out
      .split("\n")
      .map((line) => {
        const m = line.match(/^(\d+)\s+(.*)$/);
        return m ? { pid: Number(m[1]), cmd: m[2] } : null;
      })
      .filter(Boolean)
      .filter((entry) => /^node\b/.test(entry.cmd));
  } catch {
    return [];
  }
}

/*- Resolve via the listening port FIRST (most reliable for server.js
 *  which always binds PORT) and fall back to `pgrep` (required for
 *  headless bot.js which has no listener).  When several pgrep matches
 *  come back, refuse to pick — operator must disambiguate via the
 *  LP_RANGER_PID env var. */
function _resolvePid(target) {
  if (target.port) {
    const portPids = findListenerPids(target.port);
    for (const pid of portPids) {
      const cmd = psCmd(pid);
      if (/node/.test(cmd)) return { pid, cmd, via: `port ${target.port}` };
    }
  }
  const named = _pgrepByEntry(target.entry);
  if (named.length === 1)
    return { pid: named[0].pid, cmd: named[0].cmd, via: "pgrep" };
  if (named.length > 1) {
    log.error(
      `Multiple ${target.entry} processes found via pgrep:\n  ` +
        named.map((n) => `${n.pid}  ${n.cmd}`).join("\n  ") +
        "\n\nSet LP_RANGER_PID=<pid> to pick one and re-run.",
    );
    process.exit(2);
  }
  return null;
}

function _printConnectInstructions(pid) {
  /*- Node's signal-started inspector emits its WS endpoint to the
   *  target's own stderr ("Debugger listening on ws://…").  A sibling
   *  process can't read that stream, so print the canonical defaults —
   *  they match unless the operator overrode INSPECTOR_PORT. */
  const ws = `ws://127.0.0.1:${INSPECTOR_PORT}`;
  log.info("");
  log.info("✔ Inspector requested via SIGUSR1 on PID %d", pid);
  log.info("");
  log.info("Connect with ONE of:");
  log.info("  • Chrome / Edge:   chrome://inspect  (then Configure… → add");
  log.info(
    "                     127.0.0.1:%d, click 'inspect')",
    INSPECTOR_PORT,
  );
  log.info("  • Node REPL:       node inspect %s", ws);
  log.info("  • VS Code:         Run > Start Debugging > Node: Attach");
  log.info(
    "                     (default config attaches to %d)",
    INSPECTOR_PORT,
  );
  log.info("");
  log.info("Look in the app's terminal for the full WS endpoint (Node prints");
  log.info("'Debugger listening on ws://…' to stderr on signal).");
}

/**
 * Attach the V8 inspector to the running target process.
 *
 * @param {object} target
 * @param {string} target.entry  Entry filename to match for `pgrep`,
 *   e.g. `"server"` or `"bot"` (no `.js` suffix — `_pgrepByEntry`
 *   appends it).
 * @param {number|null} target.port  Optional listening port to try
 *   first (server.js has one, bot.js doesn't).
 * @param {string} target.label  Human-friendly label for log output.
 */
function attach(target) {
  const override = Number(process.env.LP_RANGER_PID);
  const resolved =
    override > 0
      ? { pid: override, cmd: psCmd(override), via: "LP_RANGER_PID env" }
      : _resolvePid(target);

  if (!resolved) {
    const hint = target.port
      ? `no listener on port ${target.port}, no node ${target.entry}.js via pgrep`
      : `no node ${target.entry}.js process via pgrep`;
    log.error(
      `No running LP Ranger ${target.label} found (${hint}).\n\n` +
        `Start it first, then re-run \`npm run debug-attach${target.entry === "bot" ? "-bot" : ""}\`.`,
    );
    process.exit(1);
  }

  log.info(
    "Found LP Ranger %s PID %d via %s:\n  %s",
    target.label,
    resolved.pid,
    resolved.via,
    resolved.cmd || "(cmd unavailable)",
  );

  try {
    process.kill(resolved.pid, "SIGUSR1");
  } catch (err) {
    log.error(
      "Failed to send SIGUSR1 to PID %d: %s",
      resolved.pid,
      err.message,
    );
    process.exit(1);
  }

  _printConnectInstructions(resolved.pid);
}

module.exports = { attach };
