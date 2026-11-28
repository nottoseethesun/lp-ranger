/**
 * @file dashboard-app-notices.js
 * @description The ids of the dashboard's notices about the app rather
 *   than a position, kept in this one place. The module that shows each
 *   notice gives its overlay this id, and the stale-figures guard leaves
 *   every one usable while a position's figures are stale
 *   (dashboard-stale-data.js): a notice can come while no position's
 *   figures can arrive, as with the wallet locked, and made inert there,
 *   its OK would do nothing. With one copy of each id, a notice cannot be
 *   renamed out of the guard's list. Dependency-free.
 */

/** LP Ranger cannot start (dashboard-start-refusal.js). */
export const START_REFUSAL_NOTICE_ID = "9mm-start-refusal-modal";

/** Wallet not cleared (dashboard-wallet-import.js). */
export const WALLET_NOT_CLEARED_NOTICE_ID = "9mm-wallet-not-cleared-modal";

/** Wallet cleared: finish by hand (dashboard-wallet-import.js). */
export const WALLET_CLEARED_LEFT_NOTICE_ID = "9mm-wallet-cleared-left-modal";

/** Wallet file not found (dashboard-wallet-import.js). */
export const WALLET_GONE_NOTICE_ID = "9mm-wallet-gone-modal";

/** Rebalance log error (dashboard-rebalance-log-notice.js). */
export const REBALANCE_LOG_NOTICE_ID = "9mm-rebalance-log-modal";

/** Every one of them, for the stale-figures guard. */
export const APP_NOTICE_IDS = Object.freeze([
  START_REFUSAL_NOTICE_ID,
  WALLET_NOT_CLEARED_NOTICE_ID,
  WALLET_CLEARED_LEFT_NOTICE_ID,
  WALLET_GONE_NOTICE_ID,
  REBALANCE_LOG_NOTICE_ID,
]);
