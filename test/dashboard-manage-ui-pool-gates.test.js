/**
 * @file test/dashboard-manage-ui-pool-gates.test.js
 * @description Manage-button rules that turn on POOL identity rather
 *   than on the active position alone:
 *
 *     - one active position per pool (the server's 409 mirrored into
 *       the button so the click is never offered)
 *     - a closed position may not be re-opened while the pool holds an
 *       open one
 *     - and then only the newest closed position may be re-opened
 *
 *   Extracted from test/dashboard-manage-ui.test.js so that file stays
 *   under the 500-line cap. Fixtures are duplicated rather than shared,
 *   matching test/handle-manage-pool-state-err.test.js — each test file
 *   stays self-contained and independently runnable.
 */

"use strict";

require("global-jsdom/register");

const { test, before } = require("node:test");
const assert = require("node:assert");
const { GUARANTEED_DASHBOARD_HAS_POLLED_MS } = require("../src/config");

let computeManageUI;
let MANAGE_SYNCING_HELP;
let _newerClosedInPool;
let _openInPool;
let _poolKeyOf;

before(async () => {
  const mod = await import("../public/dashboard-manage-ui.js");
  computeManageUI = mod.computeManageUI;
  MANAGE_SYNCING_HELP = mod.MANAGE_SYNCING_HELP;
  _newerClosedInPool = mod._newerClosedInPool;
  _openInPool = mod._openInPool;
  _poolKeyOf = mod._poolKeyOf;
});

const RETIRE_DEBOUNCE_MS = GUARANTEED_DASHBOARD_HAS_POLLED_MS;
const NOW = 1_700_000_000_000;

/** Build a happy-path input object — override fields per-test. */
function ins(overrides) {
  return {
    hasActive: true,
    isClosed: false,
    isNft: true,
    posState: { status: "stopped" },
    syncComplete: true,
    walletUnlocked: true,
    manageInFlight: false,
    nowMs: NOW,
    retireDebounceMs: RETIRE_DEBOUNCE_MS,
    ...overrides,
  };
}

// ── One-position-per-pool branch ─────────────────────────────────────

/*- The authoritative gate is server-side (`rejectIfPoolManaged` in
 *  src/pool-already-managed.js).  These cases pin the dashboard's half:
 *  do not offer a button whose click the server will refuse, and say
 *  which position holds the pool so the operator knows what to stop. */

test("pool already managed: Manage disabled, tooltip names the holder", () => {
  const s = computeManageUI(ins({ poolManagedBy: "157149" }));
  assert.equal(s.buttonText, "Manage");
  assert.equal(s.buttonDisabled, true);
  assert.match(s.buttonTitle, /already managed by position #157149/);
  assert.match(s.buttonTitle, /one position per pool/);
});

test("pool already managed: the badge still reports this position", () => {
  /*- The pool being taken says nothing about THIS position's own state,
   *  so the badge and the Lifetime panel must read exactly as they do
   *  when the button is simply not clicked. */
  const s = computeManageUI(ins({ poolManagedBy: "157149" }));
  const plain = computeManageUI(ins({}));
  assert.equal(s.badgeText, plain.badgeText);
  assert.equal(s.badgeManaged, plain.badgeManaged);
  assert.equal(s.pdBtnDisabled, plain.pdBtnDisabled);
});

test("pool free: Manage offered as normal", () => {
  /*- Pins that the gate is inert in the ordinary case — both when the
   *  input is absent entirely and when it is explicitly empty. */
  const absent = computeManageUI(ins({}));
  const empty = computeManageUI(ins({ poolManagedBy: null }));
  assert.equal(absent.buttonDisabled, false);
  assert.equal(empty.buttonDisabled, false);
  assert.equal(empty.buttonTitle, absent.buttonTitle);
});

test("pool held by THIS running position: Stop Managing stays offered", () => {
  /*- A managed position holds its own pool.  Were the gate to fire on
   *  the running position it would replace its Stop Managing button
   *  with a disabled Manage, stranding the operator with no way to
   *  stop it from the dashboard. */
  const s = computeManageUI(
    ins({ posState: { status: "running" }, poolManagedBy: "157149" }),
  );
  assert.equal(s.buttonText, "Stop Managing");
  assert.equal(s.buttonDisabled, false);
});

test("pool already managed on a CLOSED position: still refused", () => {
  /*- A closed NFT in a managed pool is the re-funding case.  It has to
   *  be refused for the same reason an open one is: re-funding it would
   *  leave two funded positions in the pool. */
  const s = computeManageUI(ins({ isClosed: true, poolManagedBy: "157149" }));
  assert.equal(s.buttonDisabled, true);
  assert.match(s.buttonTitle, /already managed by position #157149/);
});

// ── Newest-closed-only re-open branch ────────────────────────────────

/*- Re-opening recovers a position a rebalance drained and failed to
 *  replace, which is always the newest one.  An older drained NFT is
 *  settled history.  Viewing it must stay possible; only the re-open
 *  is refused. */

test("closed but superseded: Manage disabled, tooltip names the newer one", () => {
  const s = computeManageUI(
    ins({ isClosed: true, reopenSupersededBy: "164418" }),
  );
  assert.equal(s.buttonText, "Manage");
  assert.equal(s.buttonDisabled, true);
  assert.match(s.buttonTitle, /Only the newest closed position/);
  assert.match(s.buttonTitle, /#164418/);
});

test("closed but superseded: says viewing history still works", () => {
  /*- The row stays clickable and the closed-position history view is
   *  unaffected, so the tooltip must not read as "this position is off
   *  limits" — that would send the user hunting for a fault. */
  const s = computeManageUI(
    ins({ isClosed: true, reopenSupersededBy: "164418" }),
  );
  assert.match(s.buttonTitle, /view its history/);
});

test("closed but superseded: badge and pool-details are untouched", () => {
  const s = computeManageUI(
    ins({ isClosed: true, reopenSupersededBy: "164418" }),
  );
  assert.equal(s.badgeText, "Position Closed");
  assert.equal(s.pdBtnDisabled, false);
});

test("newest closed position: re-open still offered", () => {
  /*- The whole point of the feature.  Absent and explicitly-null must
   *  both leave the closed branch exactly as it was. */
  const absent = computeManageUI(ins({ isClosed: true }));
  const nulled = computeManageUI(
    ins({ isClosed: true, reopenSupersededBy: null }),
  );
  assert.equal(absent.buttonDisabled, false);
  assert.equal(nulled.buttonDisabled, false);
  assert.equal(nulled.buttonTitle, absent.buttonTitle);
});

test("open position is never blocked by a newer closed one", () => {
  /*- Guards against the gate being keyed on the pool rather than on
   *  this position being closed.  An open position is not a re-open. */
  const s = computeManageUI(
    ins({ isClosed: false, reopenSupersededBy: "164418" }),
  );
  assert.equal(s.buttonDisabled, false);
});

test("syncing still wins over the superseded branch", () => {
  /*- Ordering check: while syncing, the store may not hold the pool's
   *  other NFTs yet, so a "you are not the newest" verdict would be
   *  drawn from an incomplete list. */
  const s = computeManageUI(
    ins({ isClosed: true, syncComplete: false, reopenSupersededBy: "164418" }),
  );
  assert.equal(s.buttonTitle, MANAGE_SYNCING_HELP);
});

// ── _newerClosedInPool ───────────────────────────────────────────────

const _A = "0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39";
const _B = "0x57fde0a71132198BBeC939B98976993d8D89D225";
const _C = "0x95B303987A60C71504D99Aa1b13B4DA07b0790ab";

const _WALLET = "0x4E448BeF0DBD0e2F7bd2e6209E6f44dc8af0E5cE";
const _PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";

/*- posStore entry. `liq` of "0" is closed.  Carries the full identity
 *  the real store carries — wallet and position-manager contract as
 *  well as the pair — because the pool key is qualified by all of it. */
function ent(tokenId, liq, t0 = _A, t1 = _B, fee = 2500) {
  return {
    tokenId,
    liquidity: liq,
    token0: t0,
    token1: t1,
    fee,
    walletAddress: _WALLET,
    contractAddress: _PM,
  };
}

/** Bare pool identity, fully qualified, for _poolKeyOf cases. */
function pool(t0, t1, fee) {
  return {
    token0: t0,
    token1: t1,
    fee,
    walletAddress: _WALLET,
    contractAddress: _PM,
  };
}

test("_newerClosedInPool: finds a newer closed NFT in the same pool", () => {
  const me = ent("100", "0");
  assert.equal(_newerClosedInPool(me, [me, ent("164418", "0")]), "164418");
});

test("_newerClosedInPool: null when this is the newest closed one", () => {
  const me = ent("164418", "0");
  assert.equal(_newerClosedInPool(me, [me, ent("100", "0")]), null);
});

test("_newerClosedInPool: compares ids numerically, not as text", () => {
  /*- "#99" sorts AFTER "#100" as a string.  A text comparison would
   *  call #100 superseded by #99 and refuse to re-open the newest
   *  position in the pool — the exact case the feature exists for. */
  const me = ent("100", "0");
  assert.equal(_newerClosedInPool(me, [me, ent("99", "0")]), null);
  const older = ent("99", "0");
  assert.equal(_newerClosedInPool(older, [older, ent("100", "0")]), "100");
});

test("_newerClosedInPool: an OPEN newer NFT does not supersede", () => {
  /*- Only closed positions are re-open candidates, so only a closed
   *  one can be "the newest closed". */
  const me = ent("100", "0");
  assert.equal(_newerClosedInPool(me, [me, ent("164418", "12345")]), null);
});

test("_newerClosedInPool: a different pool does not supersede", () => {
  const me = ent("100", "0");
  assert.equal(_newerClosedInPool(me, [me, ent("164418", "0", _A, _C)]), null);
  assert.equal(
    _newerClosedInPool(me, [me, ent("164418", "0", _A, _B, 10000)]),
    null,
  );
});

test("_newerClosedInPool: matches a pool with the pair reversed", () => {
  const me = ent("100", "0");
  assert.equal(
    _newerClosedInPool(me, [me, ent("164418", "0", _B, _A)]),
    "164418",
  );
});

test("_newerClosedInPool: returns the NEWEST when several are newer", () => {
  const me = ent("100", "0");
  const all = [me, ent("150", "0"), ent("164418", "0"), ent("120", "0")];
  assert.equal(_newerClosedInPool(me, all), "164418");
});

test("_newerClosedInPool: tolerates junk entries and bad ids", () => {
  const me = ent("100", "0");
  const all = [null, {}, ent(undefined, "0"), ent("not-a-number", "0"), me];
  assert.equal(_newerClosedInPool(me, all), null);
});

test("_newerClosedInPool: null for a missing active or entry list", () => {
  assert.equal(_newerClosedInPool(null, []), null);
  assert.equal(_newerClosedInPool(ent("100", "0"), null), null);
  assert.equal(_newerClosedInPool(ent(undefined, "0"), []), null);
});

// ── Open-position-in-pool blocks re-open ─────────────────────────────

test("closed with an OPEN position in the pool: re-open refused", () => {
  const s = computeManageUI(ins({ isClosed: true, poolHasOpen: "164418" }));
  assert.equal(s.buttonDisabled, true);
  assert.match(s.buttonTitle, /already has an open position, #164418/);
  assert.match(s.buttonTitle, /two positions in the same pool/);
});

test("open-in-pool outranks the newest-closed rule", () => {
  /*- Even when this IS the newest closed NFT, an open sibling means
   *  nothing was lost and so nothing needs recovering.  The message
   *  must be the open-position one, not the superseded one. */
  const s = computeManageUI(
    ins({ isClosed: true, poolHasOpen: "164418", reopenSupersededBy: null }),
  );
  assert.match(s.buttonTitle, /already has an open position/);
});

test("open-in-pool wins over superseded when both apply", () => {
  const s = computeManageUI(
    ins({ isClosed: true, poolHasOpen: "164418", reopenSupersededBy: "150" }),
  );
  assert.match(s.buttonTitle, /already has an open position/);
  assert.equal(/newest closed position/.test(s.buttonTitle), false);
});

test("an OPEN active position is not blocked by poolHasOpen", () => {
  /*- The rule is about re-opening.  An open position being managed is
   *  the ordinary case and must stay clickable; only `poolManagedBy`
   *  may stop it. */
  const s = computeManageUI(ins({ isClosed: false, poolHasOpen: "164418" }));
  assert.equal(s.buttonDisabled, false);
});

test("managed-pool refusal still outranks both re-open rules", () => {
  const s = computeManageUI(
    ins({
      isClosed: true,
      poolManagedBy: "1",
      poolHasOpen: "2",
      reopenSupersededBy: "3",
    }),
  );
  assert.match(s.buttonTitle, /already managed by position #1/);
});

// ── _openInPool ──────────────────────────────────────────────────────

test("_openInPool: finds an open position in the same pool", () => {
  const me = ent("100", "0");
  assert.equal(_openInPool(me, [me, ent("164418", "9999")]), "164418");
});

test("_openInPool: null when every sibling is closed", () => {
  const me = ent("100", "0");
  assert.equal(_openInPool(me, [me, ent("164418", "0"), ent("99", "0")]), null);
});

test("_openInPool: ignores an open position in a DIFFERENT pool", () => {
  const me = ent("100", "0");
  assert.equal(_openInPool(me, [me, ent("164418", "9999", _A, _C)]), null);
  assert.equal(
    _openInPool(me, [me, ent("164418", "9999", _A, _B, 10000)]),
    null,
  );
});

test("_openInPool: matches a pool with the pair reversed", () => {
  const me = ent("100", "0");
  assert.equal(_openInPool(me, [me, ent("164418", "9999", _B, _A)]), "164418");
});

test("_openInPool: never reports the active position itself", () => {
  /*- An open active position is its own pool's open position.  Were it
   *  counted, every open position would block on itself. */
  const me = ent("100", "9999");
  assert.equal(_openInPool(me, [me]), null);
});

test("_openInPool: unknown liquidity does not count as open", () => {
  /*- `isPositionClosed` reports a missing liquidity field as
   *  not-closed.  Treating that as "open" here would refuse a
   *  legitimate re-open on incomplete data, so unknown counts as
   *  neither open nor closed. */
  const me = ent("100", "0");
  const noLiq = { tokenId: "164418", token0: _A, token1: _B, fee: 2500 };
  assert.equal(_openInPool(me, [me, noLiq]), null);
  assert.equal(_openInPool(me, [me, { ...noLiq, liquidity: null }]), null);
});

test("_openInPool: null for a missing active or entry list", () => {
  assert.equal(_openInPool(null, []), null);
  assert.equal(_openInPool(ent("100", "0"), null), null);
});

// ── _poolKeyOf (the one client-side pool identity) ───────────────────

test("_poolKeyOf: case and token order cannot split one pool in two", () => {
  const base = _poolKeyOf(pool(_A, _B, 2500));
  assert.equal(_poolKeyOf(pool(_B, _A, 2500)), base);
  assert.equal(
    _poolKeyOf(pool(_A.toLowerCase(), _B.toUpperCase(), 2500)),
    base,
  );
});

test("_poolKeyOf: fee is part of the identity, and 0 is a real fee", () => {
  assert.notEqual(
    _poolKeyOf(pool(_A, _B, 2500)),
    _poolKeyOf(pool(_A, _B, 10000)),
  );
  /*- 0 is falsy but is a value, so it must produce a key, not null. */
  assert.notEqual(_poolKeyOf(pool(_A, _B, 0)), null);
});

test("_poolKeyOf: number and string fee agree", () => {
  assert.equal(
    _poolKeyOf(pool(_A, _B, 2500)),
    _poolKeyOf(pool(_A, _B, "2500")),
  );
});

test("_poolKeyOf: null for an incomplete or non-string identity", () => {
  /*- Null rather than a partial key, so two incomplete entries never
   *  compare equal to each other. */
  for (const bad of [
    null,
    undefined,
    {},
    pool(_A, _B, ""),
    pool(_A, _B, null),
    pool(_A, "", 2500),
    pool(123, _B, 2500),
    { ...pool(_A, _B, 2500), walletAddress: undefined },
    { ...pool(_A, _B, 2500), contractAddress: "" },
  ]) {
    assert.equal(_poolKeyOf(bad), null, JSON.stringify(bad));
  }
});

test("two unresolvable identities are not the same pool", () => {
  /*- Exercised through _openInPool: an entry with no pool fields must
   *  not match an active position that also has none. */
  const blank = { tokenId: "1", liquidity: "5" };
  assert.equal(_openInPool({ tokenId: "2", liquidity: "0" }, [blank]), null);
});

test("_newerClosedInPool: an empty-string token id is not treated as 0", () => {
  /*- BigInt("") is 0n rather than a throw. Read as token 0 it sits
   *  below every real id, so an empty id on the active position would
   *  make every sibling look newer. */
  const me = { tokenId: "", liquidity: "0", token0: _A, token1: _B, fee: 2500 };
  assert.equal(_newerClosedInPool(me, [me, ent("164418", "0")]), null);
});

// ── Full qualification ───────────────────────────────────────────────

test("_poolKeyOf: the wallet is part of the identity", () => {
  /*- Two positions in the same pool on DIFFERENT wallets are not the
   *  same managed pool. The app is single-wallet today, so this cannot
   *  arise yet; the key is qualified anyway so that assumption can be
   *  lifted without the gate quietly cross-blocking. */
  const a = _poolKeyOf(pool(_A, _B, 2500));
  const b = _poolKeyOf({
    ...pool(_A, _B, 2500),
    walletAddress: "0x1111111111111111111111111111111111111111",
  });
  assert.notEqual(a, b);
});

test("_poolKeyOf: the position-manager contract is part of the identity", () => {
  const a = _poolKeyOf(pool(_A, _B, 2500));
  const b = _poolKeyOf({
    ...pool(_A, _B, 2500),
    contractAddress: "0x2222222222222222222222222222222222222222",
  });
  assert.notEqual(a, b);
});

test("_poolKeyOf: wallet and contract casing does not split one pool", () => {
  const a = _poolKeyOf(pool(_A, _B, 2500));
  const b = _poolKeyOf({
    ...pool(_A, _B, 2500),
    walletAddress: _WALLET.toLowerCase(),
    contractAddress: _PM.toUpperCase(),
  });
  assert.equal(a, b);
});

test("_openInPool: a same-pool entry on another wallet does not block", () => {
  const me = ent("100", "0");
  const otherWallet = {
    ...ent("164418", "9999"),
    walletAddress: "0x1111111111111111111111111111111111111111",
  };
  assert.equal(_openInPool(me, [me, otherWallet]), null);
});

test("_newerClosedInPool: a same-pool entry on another wallet does not supersede", () => {
  const me = ent("100", "0");
  const otherWallet = {
    ...ent("164418", "0"),
    walletAddress: "0x1111111111111111111111111111111111111111",
  };
  assert.equal(_newerClosedInPool(me, [me, otherWallet]), null);
});
