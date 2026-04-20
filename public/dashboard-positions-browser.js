/**
 * @file dashboard-positions-browser.js
 * @description Position browser modal: open/close, render paginated list,
 *   row selection, page navigation. Split from dashboard-positions.js
 *   for line-count compliance.
 */

import { g, cloneTpl } from "./dashboard-helpers.js";
import {
  posStore,
  PAGE_SIZE,
  isPositionManaged,
  isPositionClosed,
  checkInRange,
  _getManagedTokenIds,
  _tokenName,
} from "./dashboard-positions-store.js";
import { matchesPosFilter } from "./positions-filter.js";

let posBrowserPage = 0;
let posBrowserSelected = -1;

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

  // Stats bar
  const inRangeCount = filtered.filter((e) => checkInRange(e) === true).length;
  g("posTotalCount").textContent = filtered.length;
  g("posInRangeCount").textContent = inRangeCount;
  const capWarn = g("posCapWarn");
  if (capWarn)
    capWarn.textContent = posStore.isFull()
      ? "\u26A0 Store full (300/300)"
      : "";

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

/** Navigate to next/previous page. */
export function posChangePage(dir) {
  posBrowserPage += dir;
  renderPosBrowser();
}

/** Get the currently selected browser index. */
export function getPosBrowserSelected() {
  return posBrowserSelected;
}

// ── Row rendering (moved from dashboard-positions-store.js) ──────────────────

/** Determine status CSS class and label. */
function _posRowStatus(e, isManaged, inRange) {
  if (isPositionClosed(e))
    return { cls: "closed", label: "CLOSED", managed: false };
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
function _fillIdxCell(cell, idxNum, mgd, managed) {
  cell.classList.toggle("active-idx", mgd);
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
  const mgd =
    e.positionType === "nft" && _getManagedTokenIds().has(String(e.tokenId));
  const { cls, label, managed } = _posRowStatus(e, mgd, inR);
  const { pair, feePct, idStr, ws } = _rowDisplay(e);
  const star = mgd ? " \u2605" : "";
  const tL = e.tickLower || 0,
    tU = e.tickUpper || 0;

  root.classList.toggle("active-pos", !!e.active);
  root.classList.toggle("selected", hl);
  root.setAttribute("data-pos-idx", String(e.index));

  _fillIdxCell(
    root.querySelector('[data-tpl="idx"]'),
    e.index + 1,
    mgd,
    managed,
  );

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
