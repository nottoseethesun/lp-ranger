/**
 * @file dashboard-positions-browser.js
 * @description Position browser modal: open/close, render paginated list,
 *   row selection, page navigation. Split from dashboard-positions.js
 *   for line-count compliance.
 */

import {
  g,
  cloneTpl,
  act,
  ACT_ICONS,
  fetchWithCsrf,
} from "./dashboard-helpers.js";
import {
  posStore,
  PAGE_SIZE,
  isPositionManaged,
  isPositionClosed,
  checkInRange,
  formatPosLabel,
  updatePosStripUI,
  _getManagedTokenIds,
  _tokenName,
} from "./dashboard-positions-store.js";
import { matchesPosFilter } from "./positions-filter.js";
import { paintManageUI } from "./dashboard-manage-ui.js";
import { resetLastFetchedId } from "./dashboard-unmanaged.js";

let posBrowserPage = 0;
let posBrowserSelected = -1;

/*- Update the Stats pill's custom popover with current totals. The
 *  trigger pill lives in the toggle row (#posStatsTip); the popover
 *  sibling (#posStatsPopover) holds the hover text: Total, Open and
 *  In-Range, and a store-full warning when applicable. Each line is
 *  rendered as its own <div> so the stylized popover shows multi-line
 *  content (no reliance on native title-attribute newlines). */
function _setStatsTip(total, inRange, storeFull) {
  const tip = g("posStatsTip");
  const pop = g("posStatsPopover");
  if (!tip || !pop) return;
  const lines = [`Total: ${total}`, `Open and In-Range: ${inRange}`];
  if (storeFull) lines.push("\u26A0 Store full (300/300)");
  pop.replaceChildren();
  for (const text of lines) {
    const row = document.createElement("div");
    row.textContent = text;
    pop.appendChild(row);
  }
  const pill = tip.querySelector(".help-tip");
  if (pill) pill.classList.toggle("help-tip-warn", storeFull);
}

/** Open the position browser modal. */
export function openPosBrowser() {
  posBrowserPage = 0;
  posBrowserSelected = -1;
  g("posBrowserModal").className = "modal-overlay";
  renderPosBrowser();
}

/** Close the position browser modal. */
export function closePosBrowser() {
  g("posBrowserModal").className = "modal-overlay hidden";
}

/** Render the paginated, filterable position list. */
export function renderPosBrowser() {
  const filter = (g("posSearchInput").value || "").toLowerCase();
  let all = posStore.entries;
  if (g("posManagedOnlyToggle")?.checked)
    all = all.filter((e) => isPositionManaged(e.tokenId));
  if (!g("posClosedToggle")?.checked)
    all = all.filter((e) => !isPositionClosed(e));
  const unsorted = filter
    ? all.filter((e) => matchesPosFilter(e, filter))
    : all;
  const filtered = [...unsorted].sort((a, b) => {
    const idA = Number(a.tokenId || 0),
      idB = Number(b.tokenId || 0);
    return idB - idA;
  });

  // Stats tooltip (on the pill in the toggle row). "Open and In-Range"
  // must exclude closed (zero-liquidity) positions even when the
  // "Show Closed" toggle includes them in the filtered list.
  const inRangeCount = filtered.filter(
    (e) => !isPositionClosed(e) && checkInRange(e) === true,
  ).length;
  _setStatsTip(filtered.length, inRangeCount, posStore.isFull());

  // Paginate
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(posBrowserPage, totalPages - 1);
  posBrowserPage = page;
  const pageItems = filtered.slice(
    page * PAGE_SIZE,
    page * PAGE_SIZE + PAGE_SIZE,
  );

  // Render list
  const list = g("posList");
  if (!filtered.length) {
    _renderEmpty(list, all.length);
  } else {
    _renderRows(list, pageItems);
    if (localStorage.getItem("9mm_privacy_mode") === "1")
      list
        .querySelectorAll(".pos-row-title, .pos-row-meta")
        .forEach((el) => el.classList.add("9mm-pos-mgr-privacy-blur"));
  }

  // Pagination controls
  g("posPageLabel").textContent = "Page " + (page + 1) + " of " + totalPages;
  g("posPrevBtn").disabled = page <= 0;
  g("posNextBtn").disabled = page >= totalPages - 1;

  // Action buttons
  g("posSelectBtn").disabled = posBrowserSelected < 0;
  g("posRemoveBtn").disabled = posBrowserSelected < 0;
}

/** Toggle row selection. */
export function posRowClick(idx) {
  posBrowserSelected = posBrowserSelected === idx ? -1 : idx;
  renderPosBrowser();
}

/*- Set row selection without toggling. Used by double-click handler so
 *  the second click of a dblclick can't deselect the row before the
 *  activate fires. */
export function posRowSelect(idx) {
  posBrowserSelected = idx;
  renderPosBrowser();
}

/** Navigate to next/previous page. */
export function posChangePage(dir) {
  posBrowserPage += dir;
  renderPosBrowser();
}

/** Get the currently selected browser index. */
export function getPosBrowserSelected() {
  return posBrowserSelected;
}

/**
 * Remove the highlighted position from the browser store.  If the
 * position is currently managed on the server, fire DELETE
 * /api/position/manage first so the bot loop is actually stopped
 * before we drop the entry from the local store.  Without that, the
 * LP Browser Remove only mutated localStorage — the server kept
 * rebalancing, the disk config still said status=running, and the
 * position auto-restarted on server reboot.  The DELETE handler
 * stops the bot loop, flips status to 'stopped', and deletes the
 * per-position bot state (see server-positions.js handleRemove).
 */
export async function removeSelectedPos() {
  const sel = posBrowserSelected;
  if (sel < 0) return;
  const entry = posStore.entries[sel];
  if (!entry) return;
  if (isPositionManaged(entry.tokenId)) {
    const key =
      "pulsechain-" +
      entry.walletAddress +
      "-" +
      entry.contractAddress +
      "-" +
      entry.tokenId;
    try {
      const res = await fetchWithCsrf("/api/position/manage", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      if (!res.ok) {
        const b = await res.json().catch(() => ({}));
        act(
          ACT_ICONS.cross,
          "alert",
          "Unmanage Failed",
          (b.error || "HTTP " + res.status) + " — position not removed",
        );
        return;
      }
    } catch (err) {
      act(
        ACT_ICONS.cross,
        "alert",
        "Unmanage Failed",
        err.message + " — position not removed",
      );
      return;
    }
  }
  /*- Reset the unmanaged-details dedup guard so a re-scan + re-select
   *  of the same tokenId will actually fetch fresh data.  Without this,
   *  fetchUnmanagedDetails short-circuits on the lastFetchedId-match
   *  guard, /api/position/lifetime is never called, the server never
   *  sets rebalanceScanComplete=true for the unmanaged view, and the
   *  Sync badge stays stuck on "Syncing…" forever — which keeps the
   *  Manage button disabled via _updateSyncBadge. */
  resetLastFetchedId();
  posStore.remove(sel);
  updatePosStripUI();
  /*- Refresh the Manage button + badge so they don't keep displaying
   *  the removed position's last state (most visibly: "Rebalancing…").
   *  The 3-second status poll skips updateManageBadge when posStore has
   *  no active, so without this nudge the stale text stays put until
   *  the user picks another position or reloads the page.  Other
   *  per-position UI (KPI panel, Mission Control) is left alone — the
   *  poll handles it on next tick, and a full clear would require URL
   *  routing changes that are out of scope for this fix. */
  paintManageUI();
  act(
    ACT_ICONS.cross,
    "alert",
    "Position Removed",
    formatPosLabel(entry) + " removed from store",
  );
  renderPosBrowser();
}

// ── Row rendering (moved from dashboard-positions-store.js) ──────────────────

/*- Determine status CSS class, label, and the display-aware `managed`
 *  flag for a row.  The "raw" server-side managed-set membership is
 *  computed here from `_getManagedTokenIds()` rather than passed in,
 *  so callers can't accidentally use the raw flag (which leaks for
 *  CLOSED positions whose bot loop is still running from a re-open
 *  attempt \u2014 see `_stampReopenFlagsOnLive` in `src/server-positions.js`).
 *  Closed positions always render as `managed: false` regardless of
 *  raw state, matching the user's mental model: "if liquidity is 0,
 *  nothing is being managed in any meaningful sense." */
function _posRowStatus(e, inRange) {
  if (isPositionClosed(e))
    return { cls: "closed", label: "CLOSED", managed: false };
  const isManaged =
    e.positionType === "nft" && _getManagedTokenIds().has(String(e.tokenId));
  if (inRange === null)
    return { cls: "closed", label: "\u2014", managed: isManaged };
  return inRange
    ? { cls: "in", label: "\u2713 IN", managed: isManaged }
    : { cls: "out", label: "\u2717 OUT", managed: isManaged };
}

/** Render the "no rows" empty state using the template. */
function _renderEmpty(list, hasAny) {
  const frag = cloneTpl("tplPosEmptyState");
  if (!frag) {
    list.replaceChildren();
    return;
  }
  const msg = frag.querySelector('[data-tpl="msg"]');
  if (msg)
    msg.textContent = hasAny
      ? "No positions match your filter."
      : "No positions loaded. Import a wallet or click Scan.";
  list.replaceChildren(frag);
}

/** Append rendered row elements into the list container. */
function _renderRows(list, pageItems) {
  list.replaceChildren();
  for (const e of pageItems) {
    const el = renderPosRow(e, posBrowserSelected);
    if (el) list.appendChild(el);
  }
}

/** Compute display-only derived values for a row. */
function _rowDisplay(e) {
  const pair =
    _tokenName(e.token0Symbol, e.token0) +
    "/" +
    _tokenName(e.token1Symbol, e.token1);
  const feePct = e.fee ? (e.fee / 10000).toFixed(2) + "%" : "\u2014";
  const idStr =
    e.positionType === "nft"
      ? "NFT #" + e.tokenId
      : e.contractAddress
        ? e.contractAddress.slice(0, 10) + "\u2026"
        : "ERC-20";
  const ws = e.walletAddress.slice(0, 8) + "\u2026" + e.walletAddress.slice(-4);
  return { pair, feePct, idStr, ws };
}

/** Populate the idx cell (index number + optional managed dot). */
function _fillIdxCell(cell, idxNum, managed) {
  cell.classList.toggle("active-idx", managed);
  cell.replaceChildren();
  cell.appendChild(document.createTextNode(String(idxNum)));
  if (managed) {
    const dot = document.createElement("span");
    dot.className = "9mm-pos-mgr-managed-dot";
    dot.title = "Being actively managed";
    cell.appendChild(dot);
  }
}

/** Render a single position row for the browser. */
export function renderPosRow(e, selectedIdx) {
  const frag = cloneTpl("tplPosRow");
  if (!frag) return null;
  const root = frag.querySelector('[data-tpl="root"]');
  const inR = checkInRange(e);
  const hl = e.index === selectedIdx;
  const { cls, label, managed } = _posRowStatus(e, inR);
  const { pair, feePct, idStr, ws } = _rowDisplay(e);
  const star = managed ? " \u2605" : "";
  const tL = e.tickLower || 0,
    tU = e.tickUpper || 0;

  root.classList.toggle("active-pos", !!e.active);
  root.classList.toggle("selected", hl);
  root.setAttribute("data-pos-idx", String(e.index));

  _fillIdxCell(root.querySelector('[data-tpl="idx"]'), e.index + 1, managed);

  const chip = root.querySelector('[data-tpl="chip"]');
  chip.classList.add(e.positionType);
  chip.textContent = e.positionType.toUpperCase();

  root.querySelector('[data-tpl="title"]').textContent =
    idStr + " \u00B7 " + pair + " \u00B7 " + feePct + star;
  root.querySelector('[data-tpl="meta"]').textContent =
    ws + " \u00B7 ticks [" + tL + ", " + tU + "]";

  const statusEl = root.querySelector('[data-tpl="status"]');
  statusEl.classList.add(cls);
  statusEl.textContent = label;

  return root;
}
