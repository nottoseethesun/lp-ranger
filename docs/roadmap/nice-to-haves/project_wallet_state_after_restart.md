# Show a Locked Wallet After the Server Restarts

> **Status:** Nice-to-have / polish — not a bug. The app works
> correctly without this, and funds are never at risk: the server
> refuses a Manage it cannot carry out. Reloading the page after
> restarting the server shows the wallet as it is.

## What happens now

Restart the server without `WALLET_PASSWORD` in `.env` while a
dashboard tab stays open. The server comes back with its wallet
locked, but the open page still treats it as unlocked: the Unlock
Wallet button stays disabled, Manage stays enabled, and no unlock
dialog appears. The page learns that the wallet is locked only as it
loads; a status answer can show it unlocked later, never locked.

A Manage clicked then reaches the server, which refuses it for want of
a key. Reloading the page brings up the unlock dialog.

## Shape of the fix

The page needs to learn the wallet's state again when the server comes
back, not only when it loads. Half of this is built: the status answer
the page asks for every few seconds carries `walletUnlocked`, whether
the server holds a wallet and its key (`src/server/handle-api-status.js`),
and a page still showing the wallet locked shows it unlocked once that
is true and `walletAddress` names the page's own wallet
(`showUnlockedIfServerIs`, `src/client/web/js/dashboard-wallet.js`,
called from the poll's handler in `src/client/web/js/dashboard-data.js`).
That covers a page loaded in the moment before a launch with
`WALLET_PASSWORD` takes the key.

What remains is the other direction: when `walletUnlocked` turns false
while a wallet is saved, the page would show the wallet locked again,
opening the unlock dialog and disabling Manage.
