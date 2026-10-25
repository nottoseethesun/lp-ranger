/**
 * @file dashboard-activity-figures.js
 * @description
 * The figures under the date of each Rebalance and Compound entry in the
 * Activity Log, and the one record of which of those entries the log
 * already shows.
 *
 * An entry's figures come from the record the server keeps for it. A
 * Rebalance entry's event record holds the pool's coins before the
 * rebalance's swaps and after them, and the impermanent loss or gain they
 * left at the moment it happened; a Compound entry's record holds the fee
 * coins it collected, and their share of the position at that moment.
 * The stored percent shows as Historical. Current is the same figure at
 * today's prices, worked out here from the stored coins with the bot's
 * own formulas (src/lib/coin-value.js, bundled in), using the prices the
 * server sends for the position (`pnlSnapshot.ilInputs`, the operator's
 * price overrides already applied). A Rebalance's percents show as whole
 * numbers, a Compound's to three decimal places (`PCT_DECIMALS`).
 *
 * An entry written before these figures existed holds none of them, and
 * shows "Old Log: Unavailable" until a scan gives its record figures: a
 * rebuild of the compound list, such as Re-scan Prices makes, works out
 * from the chain the figures of each compound that had none. When a scan
 * of the position on screen has finished, the log takes that position's
 * entries off (`removePositionActivityEntries`) and the history pass
 * draws them again from the records the scan left, so they show the
 * figures, and a Compound entry the amount and mark, the scan gave them.
 * The log finds them by the position's pool key, which the server sends
 * only with a managed position's second data load. The first brings the
 * position's saved records, as the server starts it; the second brings
 * its pair, fee tier and pool key, once the server has read it from the
 * blockchain. So the log draws none of a managed position's entries
 * before the second (`canDrawPositionEntries`), and each is drawn with
 * its position line and filed under its pool.
 * A Rebalance the server is still finishing (`figuresDue`) shows a dash
 * for each figure not yet known, and fills in when a later status answer
 * carries its record finished.
 *
 * That is why the entries are kept track of here: `refreshActivityCurrent`
 * runs on every status answer, finds each entry's latest record by its
 * transaction, and rewrites the entry's figures when they change. Keeping
 * track also lets the log refuse to draw an entry it already shows
 * (`isActivityEntryDrawn`): the live event check and the history pass can
 * both reach the same rebalance or compound, and switching positions runs
 * the history pass again. The record is JavaScript state, never read back
 * from the page; the log forgets an entry when it trims it, and every
 * entry when it is cleared.
 */

import { rebalanceIlPct, shareOfValuePct } from "../../lib/coin-value.js";
import { isPlainObject } from "../../lib/plain-object.js";

/** The label line over each kind of entry's figures. */
const LABELS = Object.freeze({
  rebalance: "Impermanent Loss/Gain:",
  compound: "Percent Gain for Position:",
});

/** What a figure that is not known shows. */
const DASH = "—";

/**
 * The Rebalance and Compound entries the log shows, by kind and
 * transaction; an entry with no transaction under a key of its own. Each
 * holds its page element, whether it reads "Old Log: Unavailable", its
 * position's pool key, the two figure elements, and the texts last
 * written to them.
 */
const _entries = new Map();

/**
 * The decimal places each kind of entry's percents show. The fees one
 * compound collects are often well under 1% of the position, which a
 * whole number would show as 0%.
 */
const PCT_DECIMALS = Object.freeze({ rebalance: 0, compound: 3 });

/**
 * A percent as the log shows it: to the given decimal places, a minus
 * sign for a loss, no sign for a gain, and no minus sign on a figure that
 * rounds to zero; a dash when it is not known.
 * @param {*} pct  The percent.
 * @param {number} decimals  Decimal places: 0 for a Rebalance, 3 for a
 *   Compound.
 * @returns {string}
 */
export function fmtPct(pct, decimals) {
  if (typeof pct !== "number" || !Number.isFinite(pct)) return DASH;
  const text = pct.toFixed(decimals);
  return (Number(text) === 0 ? (0).toFixed(decimals) : text) + "%";
}

/** An entry's key: its kind and lower-cased transaction, or null. */
function _keyOf(kind, txHash) {
  if (typeof txHash !== "string" || txHash === "") return null;
  return kind + ":" + txHash.toLowerCase();
}

/** Today's prices for a position, as the server sends them, or null. */
function _prices(state) {
  const inputs = state?.pnlSnapshot?.ilInputs;
  return isPlainObject(inputs)
    ? { price0: inputs.price0, price1: inputs.price1 }
    : null;
}

/** What a Rebalance entry shows. */
function _rebalanceView(record, state) {
  const stored = isPlainObject(record?.historical);
  if (!stored && record?.figuresDue !== true) return { old: true };
  const p = _prices(state);
  return {
    old: false,
    historical: stored ? record.historical.impermanentLossGainPct : null,
    current:
      p === null
        ? null
        : rebalanceIlPct(
            record.beforeRebalance,
            record.afterRebalance,
            p.price0,
            p.price1,
          ),
  };
}

/** What a Compound entry shows. */
function _compoundView(record, state) {
  if (!isPlainObject(record?.historical)) return { old: true };
  const p = _prices(state);
  return {
    old: false,
    historical: record.historical.percentGainForPosition,
    current:
      p === null
        ? null
        : shareOfValuePct(
            record.feesCollected,
            p.price0,
            p.price1,
            state?.pnlSnapshot?.currentValue,
          ),
  };
}

/**
 * What an entry shows, from its stored record and its position's state:
 * `old` when the record holds no figures, otherwise the Current and
 * Historical percents, each null when not known.
 * @param {string} kind  `"rebalance"` or `"compound"`.
 * @param {object} record  The entry's record from the server.
 * @param {object} state  Its position's state from the status answer.
 * @returns {{old: boolean, current?: number|null, historical?: number|null}}
 */
export function figuresView(kind, record, state) {
  return kind === "rebalance"
    ? _rebalanceView(record, state)
    : _compoundView(record, state);
}

/**
 * The figures a Rebalance entry draws with.
 * @param {object} ev  The rebalance's event record.
 * @param {object} st  Its position's state from the status answer.
 * @returns {{kind: string, key: string|null, record: object, state: object}}
 */
export function rebalanceFigures(ev, st) {
  return {
    kind: "rebalance",
    key: _keyOf("rebalance", ev?.txHash),
    record: ev,
    state: st,
  };
}

/**
 * The figures a Compound entry draws with.
 * @param {object} ev  The compound's record.
 * @param {object} st  Its position's state from the status answer.
 * @returns {{kind: string, key: string|null, record: object, state: object}}
 */
export function compoundFigures(ev, st) {
  return {
    kind: "compound",
    key: _keyOf("compound", ev?.txHash),
    record: ev,
    state: st,
  };
}

/**
 * Whether the log already shows the entry these figures are for.
 * @param {{key: string|null}} figures
 * @returns {boolean}
 */
export function isActivityEntryDrawn(figures) {
  return figures.key !== null && _entries.has(figures.key);
}

/**
 * Whether the log may draw a position's Rebalance and Compound entries
 * yet. A managed position reaches the page in two data loads: its saved
 * records come first, as the server starts it, and its pair, fee tier
 * and pool key once the server has read it from the blockchain. The log
 * waits for the second, so each entry is drawn with its position line
 * and filed under its pool, which is how the end of a scan finds the
 * position's entries to draw again. A position the bot does not manage
 * has no second data load to wait for.
 * @param {object} state  The position's state from the status answer.
 * @returns {boolean}
 */
export function canDrawPositionEntries(state) {
  if (!isPlainObject(state)) return false;
  if (state.status !== "running") return true;
  return typeof state.poolKey === "string" && state.poolKey !== "";
}

/**
 * Write each figure that changed. A Current figure that turns unknown
 * keeps the last one shown, since the position's prices are missing only
 * for a moment, right after a rebalance.
 */
function _paint(item, view) {
  const decimals = PCT_DECIMALS[item.kind];
  const cur = fmtPct(view.current, decimals);
  const keep = view.current === null && item.shown.current !== null;
  if (!keep && cur !== item.shown.current) {
    item.currentEl.textContent = cur;
    item.shown.current = cur;
  }
  const hist = fmtPct(view.historical, decimals);
  if (hist !== item.shown.historical) {
    item.historicalEl.textContent = hist;
    item.shown.historical = hist;
  }
}

/**
 * Fill a new entry's figures section, and keep track of the entry.
 * @param {Element} entryEl  The entry, cloned from `tplActItem`.
 * @param {{kind: string, key: string|null, record: object, state: object}}
 *   figures  From `rebalanceFigures` or `compoundFigures`.
 */
export function fillActivityFigures(entryEl, figures) {
  const fin = entryEl.querySelector('[data-tpl="fin"]');
  if (fin === null) return;
  fin.querySelector('[data-tpl="finLabel"]').textContent = LABELS[figures.kind];
  const view = figuresView(figures.kind, figures.record, figures.state);
  const item = {
    el: entryEl,
    kind: figures.kind,
    old: view.old,
    poolKey: isPlainObject(figures.state) ? figures.state.poolKey : undefined,
    currentEl: fin.querySelector('[data-tpl="finCurrent"]'),
    historicalEl: fin.querySelector('[data-tpl="finHistorical"]'),
    shown: { current: null, historical: null },
  };
  if (view.old) {
    fin.querySelector('[data-tpl="finFigures"]').remove();
  } else {
    fin.querySelector('[data-tpl="finOld"]').remove();
    _paint(item, view);
  }
  fin.hidden = false;
  /*-
   *  An entry with no transaction cannot be told from another, so none
   *  is refused as drawn already; it is kept all the same, under a key
   *  of its own, so it is forgotten when trimmed and taken off with its
   *  position's entries.
   */
  _entries.set(figures.key !== null ? figures.key : Symbol("entry"), item);
}

/**
 * Take every Rebalance and Compound entry of one position off the log,
 * so the history pass can draw them again from the records a scan left.
 * Entries of other positions, and every other kind of entry, stay.
 * @param {string} poolKey  The position's pool key (`poolKey` in its
 *   status answer), which a rebalance does not change.
 */
export function removePositionActivityEntries(poolKey) {
  if (typeof poolKey !== "string" || poolKey === "") return;
  for (const [key, item] of _entries) {
    if (item.poolKey !== poolKey) continue;
    item.el.remove();
    _entries.delete(key);
  }
}

/** Every position's records in a status answer, by entry key. */
function _recordsByKey(states) {
  const out = new Map();
  const add = (kind, list, state) => {
    for (const record of Array.isArray(list) ? list : []) {
      const key = _keyOf(kind, record?.txHash);
      if (key !== null) out.set(key, { record, state });
    }
  };
  for (const state of Object.values(states)) {
    if (!isPlainObject(state)) continue;
    add("rebalance", state.rebalanceEvents, state);
    add("compound", state.compoundHistory, state);
  }
  return out;
}

/**
 * Visit each entry the log shows whose record a status answer carries,
 * with what that record has the entry show.
 * @param {object} states  The answer's positions, by key.
 * @param {(item: object, view: object) => void} visit
 */
function _eachWithRecord(states, visit) {
  if (_entries.size === 0 || !isPlainObject(states)) return;
  const records = _recordsByKey(states);
  for (const [key, item] of _entries) {
    const found = records.get(key);
    if (found === undefined) continue;
    const view = figuresView(item.kind, found.record, found.state);
    visit(item, view);
  }
}

/**
 * Bring every entry's figures up to date from a status answer: today's
 * prices for Current, and any record the server has finished since the
 * entry was drawn. An entry drawn as "Old Log: Unavailable" stays so
 * until its position's entries are drawn again at the end of a scan.
 * @param {object} states  The answer's positions, by key
 *   (`data._allPositionStates`).
 */
export function refreshActivityCurrent(states) {
  _eachWithRecord(states, (item, view) => {
    if (!item.old) _paint(item, view);
  });
}

/**
 * Forget an entry the log has trimmed.
 * @param {Element} entryEl  The entry removed from the page.
 */
export function forgetActivityEntry(entryEl) {
  for (const [key, item] of _entries)
    if (item.el === entryEl) _entries.delete(key);
}

/** Forget every entry, when the log is cleared. */
export function clearActivityEntries() {
  _entries.clear();
}
