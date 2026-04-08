/**
 * @file dashboard-router.js
 * @description Client-side URL routing for the 9mm v3 Position Manager dashboard.
 * Uses Navigo v8 for pushState-based routing so that positions are bookmarkable
 * and shareable via URL paths like /pulsechain/:wallet/:contract/:tokenId.
 *
 * ## Navigo architecture
 *
 * Navigo (root: '/') owns all URL state.  Three routes are registered:
 *   - /pulsechain/:wallet/:contract/:tokenId  — deep-link to a specific NFT position
 *   - /pulsechain/:wallet                     — wallet loaded, no position selected
 *   - /                                       — root, no URL-driven state
 *
 * Route handlers fire on initial resolve() and on popstate (back/forward).
 * Navigo's `navigate()` API is used for all URL updates with two modes:
 *   - pushState (default) — explicit user actions (position browser selection)
 *   - replaceState (via `historyAPIMethod: 'replaceState'`) — automatic flows
 *     and wallet-level changes that should not pollute browser history
 *
 * `getCurrentLocation().url` is used instead of `window.location.pathname`
 * to read the current route through Navigo's API.  Paths are built without
 * leading slashes (Navigo normalises them internally).
 *
 * `navigate({ callHandler: false })` updates the URL bar without re-firing
 * route handlers, used when the app already applied the state change and
 * only needs the URL to reflect it.
 *
 * ## bfcache support
 *
 * Full-page navigations (user typing a URL) create browser history entries
 * that restore via bfcache on back/forward.  Navigo's popstate listener does
 * not fire for bfcache restores, and its "already" hook blocks re-resolution
 * of the same URL.  A `pageshow` listener clears Navigo's `lastResolved`
 * state via `_setCurrent(null)` and calls `resolve()` to re-fire the route
 * handler, which re-syncs the server's active position via activateByTokenId.
 *
 * ## URL update contract
 *
 * The router is the single authority on URL state.  Other modules call
 * updateRouteForPosition/updateRouteForWallet only for explicit user actions
 * (position selection, wallet import/clear).  Automatic flows (scan, wallet
 * status restore) use syncRouteToState, which refuses to overwrite an
 * existing deep-link URL (4+ path segments).  The router handles deep-link
 * resolution via pending route targets and retry logic (3 attempts, 2s apart).
 *
 * Depends on: navigo (npm), dashboard-helpers.js (act).
 */

import Navigo from "navigo";
import { act, ACT_ICONS } from "./dashboard-helpers.js";
import { _posLabel } from "./dashboard-data.js";

/** Blockchain name used as the first URL segment. */
const CHAIN = "pulsechain";

/** @type {Navigo|null} Router instance. */
let _router = null;

// Late-bound deps injected from dashboard-init.js
let _posStore = null;
let _scanPositions = null;
let _wallet = null;
let _activateByTokenId = null;

/** Pending route target when wallet is not yet loaded. */
let _pendingRouteTarget = null;

/**
 * Inject references from other dashboard modules.
 * Called once from dashboard-init.js after all modules load.
 * @param {object} deps  { posStore, scanPositions, wallet, activateByTokenId }
 */
export function injectRouterDeps(deps) {
  _posStore = deps.posStore;
  _scanPositions = deps.scanPositions;
  _wallet = deps.wallet;
  _activateByTokenId = deps.activateByTokenId;
}

/**
 * Initialise the Navigo router, register routes, and resolve the initial URL.
 * Must be called after injectRouterDeps() and after checkServerWalletStatus().
 */
export function initRouter() {
  _router = new Navigo("/");

  _router
    .on("/" + CHAIN + "/:wallet/:contract/:tokenId", ({ data }) => {
      _handlePositionRoute(data.wallet, data.contract, data.tokenId);
    })
    .on("/" + CHAIN + "/:wallet", ({ data }) => {
      _handleWalletRoute(data.wallet);
    })
    .on("/", () => {
      // Root — no URL-driven state
    });

  _router.resolve();

  // Handle bfcache restoration (back/forward from full page navigations).
  // When the browser restores a page from bfcache, scripts don't re-run,
  // but the URL may have changed and the server's active position may differ.
  // Clear Navigo's lastResolved so the "already" hook doesn't block, then
  // re-resolve to fire the route handler and re-sync server state.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) {
      _router._setCurrent(null);
      _router.resolve();
    }
  });
}

/**
 * Handle a deep-link to a specific position.
 * @param {string} walletAddr  Wallet address from URL.
 * @param {string} contract    NFT contract address from URL.
 * @param {string} tokenId     Token ID from URL.
 */
function _handlePositionRoute(walletAddr, contract, tokenId) {
  if (!_posStore || !_wallet) return;
  // Stale deep-link URL after clean start — clear it so syncRouteToState
  // can later set the correct position (its guard refuses to overwrite 4-segment paths).
  if (!_wallet.address && _posStore.count() === 0) {
    _router.navigate("", {
      callHandler: false,
      historyAPIMethod: "replaceState",
    });
    return;
  }

  if (
    _wallet.address &&
    _wallet.address.toLowerCase() === walletAddr.toLowerCase()
  ) {
    _tryActivatePosition(tokenId, 0);
    return;
  }

  _pendingRouteTarget = { wallet: walletAddr, contract, tokenId };
}

/**
 * Handle a wallet-only route (no specific position).
 * @param {string} walletAddr  Wallet address from URL.
 */
function _handleWalletRoute(walletAddr) {
  if (!_wallet) return;

  if (
    !_wallet.address ||
    _wallet.address.toLowerCase() !== walletAddr.toLowerCase()
  ) {
    _pendingRouteTarget = {
      wallet: walletAddr,
      contract: null,
      tokenId: null,
    };
  }
}

/**
 * Attempt to activate a position by tokenId, with retry logic.
 * @param {string} tokenId  Token ID to find and activate.
 * @param {number} attempt  Current attempt number (max 3).
 * @returns {boolean}  True if the position was found and activated synchronously.
 */
function _tryActivatePosition(tokenId, attempt) {
  if (!_posStore) return false;

  const idx = _posStore.entries.findIndex(
    (e) => e.positionType === "nft" && String(e.tokenId) === String(tokenId),
  );

  if (idx >= 0) {
    if (_activateByTokenId) _activateByTokenId(tokenId);
    act(
      ACT_ICONS.link,
      "start",
      "Position Loaded from URL",
      "NFT #" + tokenId + (_posLabel() ? "\n" + _posLabel() : ""),
    );
    return true;
  }

  if (attempt < 3) {
    if (attempt === 0 && _scanPositions) {
      _scanPositions();
    }
    setTimeout(() => _tryActivatePosition(tokenId, attempt + 1), 2000);
  }
  return false;
}

/**
 * Whether the router has a pending deep-link target awaiting resolution.
 * @returns {boolean}
 */
export function hasPendingRoute() {
  return _pendingRouteTarget !== null;
}

/**
 * Return the wallet address from the pending route target, if any.
 * Used by checkServerWalletStatus to detect URL/server wallet mismatches
 * before accepting the server's wallet state.
 * @returns {string|null}  Lowercase wallet address, or null.
 */
export function getPendingRouteWallet() {
  return _pendingRouteTarget ? _pendingRouteTarget.wallet.toLowerCase() : null;
}

/**
 * Check and resolve any pending route target after wallet loads.
 * @returns {boolean}  True if a pending route was resolved synchronously.
 */
export function resolvePendingRoute() {
  if (!_pendingRouteTarget || !_wallet || !_wallet.address) return false;
  const target = _pendingRouteTarget;

  if (_wallet.address.toLowerCase() !== target.wallet.toLowerCase()) {
    // Keep pending — the right wallet hasn't loaded yet
    return false;
  }

  _pendingRouteTarget = null;

  if (target.tokenId) {
    return _tryActivatePosition(target.tokenId, 0);
  }
  return false;
}

/**
 * Get the current URL path from Navigo (no leading slash, root-stripped).
 * @returns {string}  Current path, e.g. "pulsechain/0xabc/0xdef/123".
 */
function _currentPath() {
  return _router.getCurrentLocation().url;
}

/**
 * Build the URL path for a given position (no leading slash, for Navigo).
 * @param {object} active  Position entry from posStore.
 * @returns {string|null}  URL path, or null if insufficient data.
 */
function _buildPositionPath(active) {
  if (!active || !_wallet || !_wallet.address) return null;
  const w = _wallet.address.toLowerCase();
  const contract = (active.contractAddress || "").toLowerCase();
  const tokenId = active.tokenId;
  if (active.positionType === "nft" && tokenId && contract) {
    return CHAIN + "/" + w + "/" + contract + "/" + tokenId;
  }
  return CHAIN + "/" + w;
}

/**
 * Update the URL bar to reflect the active position.
 * Uses pushState (creates a history entry).
 * Called only from explicit user actions (position browser selection,
 * router deep-link activation).
 * @param {object|null} active  Active position entry from posStore.
 */
export function updateRouteForPosition(active) {
  if (!_router) return;
  const target = _buildPositionPath(active);
  if (!target) {
    updateRouteForWallet(null);
    return;
  }

  if (_currentPath().toLowerCase() === target.toLowerCase()) return;

  _router.navigate(target, { callHandler: false });
}

/**
 * Update the URL bar for wallet-level state (no specific position).
 * Uses replaceState to avoid polluting browser history.
 * @param {string|null} address  Wallet address, or null to reset to root.
 */
export function updateRouteForWallet(address) {
  if (!_router) return;
  const target = address ? CHAIN + "/" + address.toLowerCase() : "";
  if (_currentPath().toLowerCase() === target.toLowerCase()) return;

  _router.navigate(target, {
    callHandler: false,
    historyAPIMethod: "replaceState",
  });
}

/**
 * Set the URL to reflect the current app state without creating a history entry.
 * Used by automatic flows (scan completion, wallet status restore) that should
 * reflect state in the URL but must NOT overwrite an existing deep-link URL.
 * @param {object|null} active  Active position entry from posStore.
 */
export function syncRouteToState(active) {
  const curPath = _currentPath();
  console.log(
    "%c[lp-ranger] [dash] syncRouteToState: active=#%s contract=%s router=%s wallet=%s cur=%s",
    "color:#c8f",
    active?.tokenId,
    active?.contractAddress || "none",
    !!_router,
    _wallet?.address?.slice(0, 10) || "none",
    curPath,
  );
  if (!_router || !_wallet || !_wallet.address) return;

  // Only overwrite a full position URL if the tokenId has changed (e.g. after rebalance).
  const segments = curPath.split("/").filter(Boolean);
  if (
    segments.length >= 4 &&
    active.tokenId &&
    segments[3] === String(active.tokenId)
  )
    return;

  const target = _buildPositionPath(active);
  if (!target) return;
  if (curPath.toLowerCase() === target.toLowerCase()) return;

  console.log(
    "%c[lp-ranger] [dash] syncRouteToState: navigating to %s",
    "color:#c8f",
    target,
  );
  _router.navigate(target, {
    callHandler: false,
    historyAPIMethod: "replaceState",
  });
}
