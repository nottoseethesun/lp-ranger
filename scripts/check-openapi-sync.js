/**
 * @file scripts/check-openapi-sync.js
 * @description Verifies that `docs/openapi.json` still describes the
 * server that exists — run as a gate by `npm run lint` and
 * `npm run check`, and driven by `test/openapi-coverage.test.js`.
 *
 * The spec is hand-maintained — route handlers do not publish their own
 * schemas — so this is what enforces the project rule that an API change
 * updates the spec (docs/claude/CLAUDE-BEST-PRACTICES.md).
 *
 * Five invariants, each derived from the real code rather than a
 * hand-kept list, so the checker cannot drift out of step with it:
 *
 *   1. Every registered route is documented.
 *   2. Every documented route still exists.
 *   3. Every key `POST /api/config` accepts appears in its schema.
 *   4. No key is documented that the endpoint would reject.
 *   5. Every operation has a summary and a response; every tag used is
 *      declared, and every tag declared is used.
 *
 * Exit status is 0 when the spec is in sync, 1 otherwise. `--json`
 * prints the machine-readable result the check report consumes.
 */

"use strict";

const fs = require("fs");
const path = require("path");
const { POSITION_KEYS, GLOBAL_KEYS } = require("../src/bot-config-keys");

const ROOT = path.join(__dirname, "..");
const SPEC_PATH = path.join(ROOT, "docs", "openapi.json");

/*- Routes registered by matching on the URL rather than by a
 *  `"METHOD /path"` handler-map key, so the scan below cannot see them.
 *  An explicit list, one line per route, so a second dynamic route has
 *  to be added deliberately instead of by widening a regex. */
const DYNAMIC_ROUTES = ["GET /api/position/{tokenId}/history"];

/*- Path params are spelled `{tokenId}` in the spec and `:tokenId` in a
 *  route, so compare with both collapsed to a single placeholder. */
const normalize = (s) =>
  s.replace(/\{[^}]+\}/g, ":p").replace(/:[A-Za-z]+/g, ":p");

/**
 * Every `"METHOD /path"` handler-map key across the server sources.
 * @returns {Set<string>}
 */
function registeredRoutes() {
  const files = fs
    .readdirSync(path.join(ROOT, "src"))
    .filter((f) => f.endsWith(".js"))
    .map((f) => path.join(ROOT, "src", f))
    .concat([path.join(ROOT, "server.js")]);
  const routes = new Set();
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/"(GET|POST|DELETE|PUT|PATCH) (\/[^"]*)"/g))
      routes.add(`${m[1]} ${m[2]}`);
  }
  return routes;
}

/**
 * `METHOD /path` for every operation in the spec.
 * @param {object} spec
 * @returns {Set<string>}
 */
function specOperations(spec) {
  const ops = new Set();
  for (const [p, methods] of Object.entries(spec.paths || {}))
    for (const method of Object.keys(methods))
      ops.add(`${method.toUpperCase()} ${p}`);
  return ops;
}

/** Routes and spec entries that do not line up, in both directions. */
function _routeProblems(spec, problems) {
  const routes = registeredRoutes();
  const ops = specOperations(spec);
  const documented = new Set([...ops, ...DYNAMIC_ROUTES].map(normalize));
  const live = new Set([...routes, ...DYNAMIC_ROUTES].map(normalize));
  for (const r of [...routes].sort())
    if (!documented.has(normalize(r)))
      problems.push(`route not documented in openapi.json: ${r}`);
  for (const s of [...ops].sort())
    if (!live.has(normalize(s)))
      problems.push(
        `openapi.json documents a route the server does not serve: ${s}`,
      );
  return { routeCount: routes.size + DYNAMIC_ROUTES.length };
}

/** `POST /api/config` keys, in both directions against the allowlists. */
function _configKeyProblems(spec, problems) {
  const props =
    spec.paths?.["/api/config"]?.post?.requestBody?.content?.[
      "application/json"
    ]?.schema?.properties || {};
  const accepted = [...POSITION_KEYS, ...GLOBAL_KEYS];
  for (const k of accepted.filter((k) => !(k in props)).sort())
    problems.push(
      `POST /api/config accepts \`${k}\` but openapi.json omits it`,
    );
  /*- `positionKey` is the routing field, not a config value. */
  const allowed = new Set([...accepted, "positionKey"]);
  for (const k of Object.keys(props)
    .filter((k) => !allowed.has(k))
    .sort())
    problems.push(
      `openapi.json documents \`${k}\`, which POST /api/config rejects`,
    );
  return { configKeyCount: accepted.length };
}

/** Summaries, responses, and tag declarations. */
function _structureProblems(spec, problems) {
  for (const [p, methods] of Object.entries(spec.paths || {}))
    for (const [method, op] of Object.entries(methods)) {
      const where = `${method.toUpperCase()} ${p}`;
      if (!op.summary) problems.push(`${where}: no summary`);
      if (!op.responses || !Object.keys(op.responses).length)
        problems.push(`${where}: no responses documented`);
    }
  const declared = new Set((spec.tags || []).map((t) => t.name));
  const used = new Set();
  for (const methods of Object.values(spec.paths || {}))
    for (const op of Object.values(methods))
      for (const tag of op.tags || []) used.add(tag);
  /*- An undeclared tag still groups routes in the rendered page, but
   *  with no description — so the omission is invisible to a reader. */
  for (const t of [...used].filter((t) => !declared.has(t)).sort())
    problems.push(`tag "${t}" is used but not declared in tags[]`);
  for (const t of [...declared].filter((t) => !used.has(t)).sort())
    problems.push(`tag "${t}" is declared but never used`);
}

/**
 * Check the spec against the running code.
 *
 * @param {object} [injectedSpec]  Parsed spec to check instead of the
 *   one on disk.  Tests pass a mutated copy this way: writing a broken
 *   spec to `docs/openapi.json` to see the checker react would leave a
 *   tracked file corrupted if the process were killed mid-test, and the
 *   check-report backup pass does not cover `docs/`.
 * @returns {{ok: boolean, problems: string[], routeCount: number,
 *            configKeyCount: number}}
 */
function checkOpenApiSync(injectedSpec) {
  const spec =
    injectedSpec !== undefined && injectedSpec !== null
      ? injectedSpec
      : JSON.parse(fs.readFileSync(SPEC_PATH, "utf8"));
  const problems = [];
  const { routeCount } = _routeProblems(spec, problems);
  const { configKeyCount } = _configKeyProblems(spec, problems);
  _structureProblems(spec, problems);
  return { ok: problems.length === 0, problems, routeCount, configKeyCount };
}

if (require.main === module) {
  const result = checkOpenApiSync();
  if (process.argv.includes("--json")) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else if (result.ok) {
    process.stdout.write(
      `[openapi-sync] in sync — ${result.routeCount} routes, ` +
        `${result.configKeyCount} config keys\n`,
    );
  } else {
    process.stdout.write(
      `[openapi-sync] docs/openapi.json is out of sync with the code:\n`,
    );
    for (const p of result.problems) process.stdout.write(`  - ${p}\n`);
    process.stdout.write(
      `\nSee docs/engineering.md § "API Documentation" for how to update it.\n`,
    );
  }
  process.exit(result.ok ? 0 : 1);
}

module.exports = { checkOpenApiSync, registeredRoutes, specOperations };
