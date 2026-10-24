/**
 * @file position-store.js
 * @module positionStore
 * @description
 * Manages a collection of up to 300 LP positions for the 9mm v3 position
 * manager.  Each position entry pairs a wallet with one detected LP position
 * (NFT or ERC-20) and tracks which position is currently selected for active
 * management.
 *
 * Responsibilities
 * ────────────────
 * - Maintain an ordered list of up to MAX_POSITIONS position entries.
 * - Support adding positions discovered from NFT enumeration or ERC-20 scan.
 * - Allow the user to select any one position as the "active" position.
 * - Provide paginated views of the collection (PAGE_SIZE rows at a time)
 *   so the browser UI can render a virtualized list without touching all 300.
 * - Expose pure derivation helpers (summaries, page slices) that have no
 *   side effects and are fully unit-testable without a DOM.
 *
 * Constraints
 * ───────────
 * - MAX_POSITIONS = 300 (hard cap; add() returns an error beyond this).
 * - PAGE_SIZE     = 20  (configurable per call; default shown in UI).
 * - Only one position may be active at a time.
 * - Position entries are immutable after creation; updates replace the entry.
 *
 * @example
 * const store  = createPositionStore();
 * store.add({ positionType: 'nft', tokenId: '12847', walletAddress: '0xABC…',
 *             token0: 'WPLS', token1: 'USDC', fee: 3000,
 *             tickLower: -207240, tickUpper: -204720, liquidity: 124839201n });
 * store.select(0);
 * const active = store.getActive();
 */

"use strict";

/** Hard cap on stored positions. */
const MAX_POSITIONS = 300;

/** Default page size for the position browser. */
const DEFAULT_PAGE_SIZE = 20;

/**
 * @typedef {'nft'|'erc20'|'unknown'} PositionType
 */

/**
 * @typedef {Object} PositionEntry
 * @property {number}       index          0-based position in the store.
 * @property {PositionType} positionType   NFT or ERC-20.
 * @property {string}       [tokenId]      NFT token ID (when positionType === 'nft').
 * @property {string}       [contractAddress] ERC-20 contract (when positionType === 'erc20').
 * @property {string}       walletAddress  Owner wallet address.
 * @property {string}       [walletSource] 'generated' | 'seed' | 'key'
 * @property {string}       token0         Token0 symbol or address.
 * @property {string}       token1         Token1 symbol or address.
 * @property {number}       fee            Pool fee tier (e.g. 3000 = 0.3%).
 * @property {number}       tickLower      Range lower tick.
 * @property {number}       tickUpper      Range upper tick.
 * @property {bigint}       liquidity      Raw liquidity value.
 * @property {boolean}      active         True if this is the currently selected position.
 * @property {number}       addedAt        Unix ms timestamp when this entry was added.
 * @property {string}       [label]        Optional user-provided display label.
 */

/**
 * @typedef {Object} PositionPage
 * @property {PositionEntry[]} items       Entries on this page.
 * @property {number}          page        0-based current page number.
 * @property {number}          totalPages  Total number of pages.
 * @property {number}          totalCount  Total entries in the store.
 * @property {boolean}         hasPrev     True if there is a previous page.
 * @property {boolean}         hasNext     True if there is a next page.
 */

/**
 * @typedef {Object} AddResult
 * @property {boolean}        ok      True on success.
 * @property {string}         [error] Error message on failure.
 * @property {PositionEntry}  [entry] The newly created entry on success.
 */

/**
 * Build a display label string for a position entry.
 * Used in the browser UI row and in the wallet strip summary.
 * @param {PositionEntry} entry
 * @returns {string}
 */
function formatPositionLabel(entry) {
  const pair = `${entry.token0}/${entry.token1}`;
  const fee = `${(entry.fee / 10000).toFixed(2)}%`;
  if (entry.positionType === "nft") {
    return `NFT #${entry.tokenId} · ${pair} · ${fee}`;
  }
  if (entry.positionType === "erc20") {
    const addr = entry.contractAddress
      ? `${entry.contractAddress.slice(0, 6)}…`
      : "?";
    return `ERC-20 ${addr} · ${pair} · ${fee}`;
  }
  return `Unknown · ${pair}`;
}

/**
 * Build a short one-line summary suitable for a compact list row.
 * @param {PositionEntry} entry
 * @param {number}        [currentPrice]  If provided, shows in/out-of-range status.
 * @returns {string}
 */
function formatPositionSummary(entry, currentPrice) {
  const base = formatPositionLabel(entry);
  const wallet = `${entry.walletAddress.slice(0, 8)}…`;
  let status = "";

  if (currentPrice !== undefined && currentPrice !== null) {
    const lp = tickToApproxPrice(entry.tickLower);
    const up = tickToApproxPrice(entry.tickUpper);
    status = currentPrice >= lp && currentPrice <= up ? " ✓" : " ✗";
  }

  return `${base}${status} | ${wallet}`;
}

/**
 * Approximate a tick → price conversion (no decimal adjustment).
 * Used only for in/out-of-range display; real math is in range-math.js.
 * @param {number} tick
 * @returns {number}
 */
function tickToApproxPrice(tick) {
  return Math.pow(1.0001, tick);
}

/**
 * Validate a PositionEntry input object before inserting.
 * @param {object} input
 * @returns {{ valid: boolean, error?: string }}
 */
function validateEntry(input) {
  if (!input || typeof input !== "object") {
    return { valid: false, error: "Entry must be a plain object." };
  }
  if (!input.walletAddress || typeof input.walletAddress !== "string") {
    return { valid: false, error: "walletAddress is required." };
  }
  if (
    input.positionType !== "nft" &&
    input.positionType !== "erc20" &&
    input.positionType !== "unknown"
  ) {
    return {
      valid: false,
      error: `positionType must be 'nft', 'erc20', or 'unknown'. Got: ${input.positionType}`,
    };
  }
  if (input.positionType === "nft" && !input.tokenId) {
    return {
      valid: false,
      error: "tokenId is required when positionType === 'nft'.",
    };
  }
  if (input.positionType === "erc20" && !input.contractAddress) {
    return {
      valid: false,
      error: "contractAddress is required when positionType === 'erc20'.",
    };
  }
  return { valid: true };
}

/**
 * Factory that creates a position store instance.
 * @param {{ nowFn?: Function }} [opts]
 * @returns {Object} store handle
 */
function createPositionStore(opts = {}) {
  const nowFn = opts.nowFn || Date.now;

  /** @type {PositionEntry[]} */
  const entries = [];

  /** 0-based index of the active position, or -1 if none. */
  let activeIndex = -1;

  // ─── private ──────────────────────────────────────────────────────────────

  /**
   * Find the position of a duplicate entry (same positionType + id/contract + wallet).
   * @param {object} input
   * @returns {number} index or -1
   */
  function _findDuplicate(input) {
    return entries.findIndex((e) => {
      if (e.walletAddress.toLowerCase() !== input.walletAddress.toLowerCase())
        return false;
      if (e.positionType !== input.positionType) return false;
      if (input.positionType === "nft")
        return e.tokenId === String(input.tokenId);
      if (input.positionType === "erc20")
        return e.contractAddress === input.contractAddress;
      return false;
    });
  }

  // ─── public API ───────────────────────────────────────────────────────────

  /**
   * Add a new position entry to the store.
   * Rejects duplicates (same wallet + type + id) and enforces MAX_POSITIONS.
   * @param {object} input  Raw position data.
   * @returns {AddResult}
   */
  function add(input) {
    if (entries.length >= MAX_POSITIONS) {
      return {
        ok: false,
        error: `Store is full (max ${MAX_POSITIONS} positions).`,
      };
    }

    const validation = validateEntry(input);
    if (!validation.valid) return { ok: false, error: validation.error };

    const dupIdx = _findDuplicate(input);
    if (dupIdx !== -1) {
      return {
        ok: false,
        error: `Position already exists at index ${dupIdx}.`,
      };
    }

    /** @type {PositionEntry} */
    const entry = {
      index: entries.length,
      positionType: input.positionType,
      tokenId: input.tokenId !== undefined ? String(input.tokenId) : undefined,
      contractAddress: input.contractAddress,
      walletAddress: input.walletAddress,
      walletSource: input.walletSource || "unknown",
      token0: input.token0 || "?",
      token1: input.token1 || "?",
      fee: Number(input.fee) || 0,
      tickLower: Number(input.tickLower) || 0,
      tickUpper: Number(input.tickUpper) || 0,
      liquidity: input.liquidity !== undefined ? BigInt(input.liquidity) : 0n,
      active: false,
      addedAt: nowFn(),
      label: input.label || null,
    };

    entries.push(entry);

    // Auto-select first position added
    if (entries.length === 1) {
      activeIndex = 0;
      entries[0].active = true;
    }

    return { ok: true, entry };
  }

  /**
   * Select a position as active by its store index.
   * Deactivates the previously active position.
   * @param {number} index
   * @returns {{ ok: boolean, error?: string }}
   */
  function select(index) {
    if (index < 0 || index >= entries.length) {
      return {
        ok: false,
        error: `Index ${index} out of range (0–${entries.length - 1}).`,
      };
    }
    if (activeIndex !== -1 && activeIndex < entries.length) {
      entries[activeIndex].active = false;
    }
    activeIndex = index;
    entries[index].active = true;
    return { ok: true };
  }

  /**
   * Remove a position entry by index.
   * If the removed entry was active, the previous entry (or first) is selected.
   * @param {number} index
   * @returns {{ ok: boolean, error?: string }}
   */
  function remove(index) {
    if (index < 0 || index >= entries.length) {
      return { ok: false, error: `Index ${index} out of range.` };
    }

    entries.splice(index, 1);

    // Re-index all entries after the removed one
    for (let i = index; i < entries.length; i++) {
      entries[i].index = i;
    }

    // Fix active index
    if (entries.length === 0) {
      activeIndex = -1;
    } else if (activeIndex >= entries.length) {
      activeIndex = entries.length - 1;
      entries[activeIndex].active = true;
    } else if (activeIndex === index) {
      activeIndex = Math.max(0, index - 1);
      entries[activeIndex].active = true;
    }

    return { ok: true };
  }

  /**
   * Return the currently active position entry, or null if none.
   * @returns {PositionEntry|null}
   */
  function getActive() {
    if (activeIndex === -1 || activeIndex >= entries.length) return null;
    return { ...entries[activeIndex] };
  }

  /**
   * Return a paginated view of the store.
   * @param {number} [page=0]      0-based page number.
   * @param {number} [pageSize]    Rows per page (default DEFAULT_PAGE_SIZE).
   * @returns {PositionPage}
   */
  function getPage(page = 0, pageSize = DEFAULT_PAGE_SIZE) {
    const size = Math.max(1, Math.min(pageSize, MAX_POSITIONS));
    const totalPages = Math.max(1, Math.ceil(entries.length / size));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const start = safePage * size;
    const items = entries.slice(start, start + size).map((e) => ({ ...e }));

    return {
      items,
      page: safePage,
      totalPages,
      totalCount: entries.length,
      hasPrev: safePage > 0,
      hasNext: safePage < totalPages - 1,
    };
  }

  /**
   * Return all entries matching a wallet address (case-insensitive).
   * @param {string} walletAddress
   * @returns {PositionEntry[]}
   */
  function getByWallet(walletAddress) {
    const lower = walletAddress.toLowerCase();
    return entries
      .filter((e) => e.walletAddress.toLowerCase() === lower)
      .map((e) => ({ ...e }));
  }

  /**
   * Return the total number of positions in the store.
   * @returns {number}
   */
  function count() {
    return entries.length;
  }

  /**
   * Return true if the store has reached its capacity.
   * @returns {boolean}
   */
  function isFull() {
    return entries.length >= MAX_POSITIONS;
  }

  /**
   * Clear all entries and reset active index.
   */
  function clear() {
    entries.length = 0;
    activeIndex = -1;
  }

  /**
   * Export all entries as a plain array (copies, not references).
   * @returns {PositionEntry[]}
   */
  function toArray() {
    return entries.map((e) => ({ ...e }));
  }

  return {
    add,
    select,
    remove,
    getActive,
    getPage,
    getByWallet,
    count,
    isFull,
    clear,
    toArray,
  };
}

// ── exports ──────────────────────────────────────────────────────────────────
module.exports = {
  createPositionStore,
  formatPositionLabel,
  formatPositionSummary,
  validateEntry,
  MAX_POSITIONS,
  DEFAULT_PAGE_SIZE,
};
