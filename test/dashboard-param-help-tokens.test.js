"use strict";

/**
 * @file test/dashboard-param-help-tokens.test.js
 * @description Tests for the dynamic token-name substitution in
 *   `public/dashboard-param-help.js` — the `{{token0}}` / `{{token1}}`
 *   placeholders that let the per-token slippage dialogs show the
 *   ACTIVE position's real trade direction ("For example, when
 *   Wrapped Pulse is traded for PulseX.").  jsdom + real module.
 *
 *   Pins: placeholder substitution, the 16-character truncation cap,
 *   HTML-escaping of on-chain (untrusted) token symbols, the
 *   "Token 0" / "Token 1" fallback when no position is active, and
 *   the full showParamHelp render for both slippage dialogs.
 */

require("global-jsdom/register");

const { describe, it, before, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let mod;
let store;

before(async () => {
  store = await import("../public/dashboard-positions-store.js");
  mod = await import("../public/dashboard-param-help.js");
});

beforeEach(() => {
  store.posStore.entries.length = 0;
  store.posStore.activeIdx = -1;
  document.body.innerHTML = `
    <template id="tplParamHelpModal">
      <div class="9mm-pos-mgr-modal 9mm-pos-mgr-modal-help">
        <h3 data-tpl="title">&nbsp;</h3>
        <p class="9mm-pos-mgr-help-subtitle" data-tpl="subtitle" hidden></p>
        <div class="9mm-pos-mgr-modal-body" data-tpl="body"></div>
        <button type="button" data-dismiss-modal>Close</button>
      </div>
    </template>
    <template id="tplParamHelpSection">
      <h4 data-tpl="heading">&nbsp;</h4>
      <p data-tpl="body"></p>
    </template>
  `;
});

function _seedActive(token0Symbol, token1Symbol) {
  store.posStore.entries.push({
    positionType: "nft",
    tokenId: "161973",
    walletAddress: "0xW",
    token0Symbol,
    token1Symbol,
  });
  store.posStore.activeIdx = 0;
}

// ── _substituteTokenNames (pure) ───────────────────────────────────────

describe("_substituteTokenNames()", () => {
  it("replaces both placeholders with the given symbols", () => {
    const out = mod._substituteTokenNames(
      "when {{token1}} is traded for {{token0}}.",
      "PulseX",
      "Wrapped Pulse",
    );
    assert.strictEqual(out, "when Wrapped Pulse is traded for PulseX.");
  });

  it("truncates names longer than 16 characters (with ellipsis)", () => {
    const out = mod._substituteTokenNames(
      "{{token0}}",
      "AVeryLongTokenNameIndeed", // 24 chars
      null,
    );
    assert.strictEqual(out, "AVeryLongTokenNa…");
  });

  it("leaves a 16-character name untouched", () => {
    const sixteen = "SixteenCharToken";
    assert.strictEqual(sixteen.length, 16);
    assert.strictEqual(
      mod._substituteTokenNames("{{token0}}", sixteen, null),
      sixteen,
    );
  });

  it("HTML-escapes symbols (on-chain metadata is untrusted)", () => {
    const out = mod._substituteTokenNames(
      "{{token0}} / {{token1}}",
      '<b>"X"</b>',
      "A&B",
    );
    assert.strictEqual(out, "&lt;b&gt;&quot;X&quot;&lt;/b&gt; / A&amp;B");
  });

  it("falls back to 'Token 0' / 'Token 1' when symbols are missing", () => {
    const out = mod._substituteTokenNames(
      "when {{token1}} is traded for {{token0}}.",
      undefined,
      "",
    );
    assert.strictEqual(out, "when Token 1 is traded for Token 0.");
  });

  it("passes through bodies without placeholders unchanged", () => {
    const body = "No placeholders here — <strong>rich</strong> text.";
    assert.strictEqual(mod._substituteTokenNames(body, "A", "B"), body);
  });
});

// ── showParamHelp integration — the two slippage dialogs ───────────────

describe("showParamHelp() — dynamic trade example in slippage dialogs", () => {
  it(
    "Token 0 dialog shows the destination example with the active " +
      "position's names: 'when Wrapped Pulse is traded for PulseX.'",
    () => {
      _seedActive("PulseX", "Wrapped Pulse");
      mod.showParamHelp("inSlipToken0");
      const modal = document.getElementById("9mm-param-help-modal");
      assert.ok(modal, "modal must render");
      assert.match(
        modal.textContent,
        /For example, when Wrapped Pulse is traded for PulseX\./,
      );
    },
  );

  it("Token 1 dialog shows the opposite direction: 'when PulseX is traded for Wrapped Pulse.'", () => {
    _seedActive("PulseX", "Wrapped Pulse");
    mod.showParamHelp("inSlipToken1");
    const modal = document.getElementById("9mm-param-help-modal");
    assert.ok(modal, "modal must render");
    assert.match(
      modal.textContent,
      /For example, when PulseX is traded for Wrapped Pulse\./,
    );
  });

  it("with no active position, the example reads with generic names", () => {
    mod.showParamHelp("inSlipToken0");
    const modal = document.getElementById("9mm-param-help-modal");
    assert.ok(modal, "modal must render");
    assert.match(
      modal.textContent,
      /For example, when Token 1 is traded for Token 0\./,
    );
  });

  it("a malicious symbol renders as text, not markup", () => {
    _seedActive('<img src=x onerror="x">', "OK");
    mod.showParamHelp("inSlipToken0");
    const modal = document.getElementById("9mm-param-help-modal");
    assert.ok(modal, "modal must render");
    assert.strictEqual(
      modal.querySelector("img"),
      null,
      "escaped symbol must not become a live element",
    );
  });
});
