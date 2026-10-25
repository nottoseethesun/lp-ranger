"use strict";

/**
 * @file test/openapi-coverage.test.js
 * @description Drives `scripts/check-openapi-sync.js` — the same code
 *   `npm run lint` and `npm run check` run as a gate, not a second
 *   implementation of it (docs/claude/CLAUDE-TESTING.md § No Mirroring).
 *
 *   The gate is what fails a build; these tests pin the invariants it
 *   enforces, so a future edit that quietly narrows one of them shows up
 *   here rather than in a spec that has silently stopped being checked.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  checkOpenApiSync,
  registeredRoutes,
  specOperations,
} = require("../scripts/check-openapi-sync");

const spec = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "docs", "openapi.json"), "utf8"),
);

describe("openapi.json is in sync with the server", () => {
  it("reports no problems", () => {
    const { ok, problems } = checkOpenApiSync();
    assert.deepEqual(
      problems,
      [],
      `docs/openapi.json is out of sync:\n  ${problems.join("\n  ")}`,
    );
    assert.equal(ok, true);
  });

  it("is actually looking at something", () => {
    /*- A scan that silently found nothing would report "in sync" for an
     *  empty spec.  Pin non-trivial counts so the gate cannot pass by
     *  looking at the wrong files. */
    const { routeCount, configKeyCount, uiSettingCount } = checkOpenApiSync();
    assert.ok(routeCount > 25, `only ${routeCount} routes found`);
    /*- Settings only: the route takes no record (src/lib/bot-config-keys.js). */
    assert.ok(configKeyCount > 25, `only ${configKeyCount} config keys found`);
    assert.ok(uiSettingCount > 10, `only ${uiSettingCount} settings found`);
    assert.ok(registeredRoutes().size > 25);
    assert.ok(specOperations(spec).size > 25);
  });
});

describe("openapi.json sync gate — the invariants it enforces", () => {
  /*- Each case checks a mutated COPY of the spec, in memory.  Without
   *  these, a refactor that dropped a rule would leave every test green
   *  and the spec unguarded.
   *
   *  In memory, never on disk: `docs/openapi.json` is a tracked file and
   *  the check-report backup pass does not cover `docs/`, so a test
   *  killed between writing a broken spec and restoring it would leave
   *  the repo corrupted. */
  const withSpec = (mutate) => {
    const copy = JSON.parse(JSON.stringify(spec));
    mutate(copy);
    return checkOpenApiSync(copy);
  };

  it("catches a route that is served but not documented", () => {
    const r = withSpec((s) => delete s.paths["/api/telegram/test"]);
    assert.equal(r.ok, false);
    assert.ok(
      r.problems.some((p) => p.includes("POST /api/telegram/test")),
      r.problems.join("\n"),
    );
  });

  it("catches a documented route the server no longer serves", () => {
    const r = withSpec((s) => {
      s.paths["/api/does-not-exist"] = {
        get: { summary: "x", tags: ["System"], responses: { 200: {} } },
      };
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes("/api/does-not-exist")));
  });

  it("catches a config key the endpoint accepts but the spec omits", () => {
    const r = withSpec((s) => {
      delete s.paths["/api/config"].post.requestBody.content["application/json"]
        .schema.properties.rangeOverrideEnabled;
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes("rangeOverrideEnabled")));
  });

  it("catches a documented key the endpoint would reject", () => {
    const r = withSpec((s) => {
      s.paths["/api/config"].post.requestBody.content[
        "application/json"
      ].schema.properties.notARealKey = { type: "string" };
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes("notARealKey")));
  });

  /** The response schema of `GET /api/ui-defaults`. */
  const uiSettings = (s) =>
    s.paths["/api/ui-defaults"].get.responses["200"].content["application/json"]
      .schema.properties;

  it("catches a dashboard setting the route sends but the spec omits", () => {
    const r = withSpec((s) => delete uiSettings(s).soundsEnabled);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes("soundsEnabled")));
  });

  it("catches a documented dashboard setting the route does not send", () => {
    const r = withSpec((s) => {
      uiSettings(s).notASetting = { type: "integer" };
    });
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.includes("notASetting")));
  });

  it("catches an operation with no summary or no responses", () => {
    const noSummary = withSpec(
      (s) => delete s.paths["/api/status"].get.summary,
    );
    assert.ok(noSummary.problems.some((p) => p.includes("no summary")));
    const noResp = withSpec((s) => {
      s.paths["/api/status"].get.responses = {};
    });
    assert.ok(noResp.problems.some((p) => p.includes("no responses")));
  });

  it("catches a tag used without a declaration, or declared unused", () => {
    const undeclared = withSpec((s) => {
      s.tags = s.tags.filter((t) => t.name !== "Telegram");
    });
    assert.ok(undeclared.problems.some((p) => p.includes("not declared")));
    const unused = withSpec((s) => {
      s.tags.push({ name: "Ghost", description: "unused" });
    });
    assert.ok(unused.problems.some((p) => p.includes("never used")));
  });
});
