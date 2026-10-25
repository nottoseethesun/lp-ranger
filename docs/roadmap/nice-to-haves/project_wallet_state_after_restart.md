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
dialog appears. The page reads the wallet's state only when it loads.

A Manage clicked then reaches the server, which refuses it for want of
a key. Reloading the page brings up the unlock dialog.

## Shape of the fix

The page needs to learn the wallet's state again when the server comes
back, not only when it loads. The status answer the page asks for
every few seconds could carry whether the wallet is locked, and the
page could open the unlock dialog when that turns to locked.

Likely touch points: the status answer (`src/lib/handle-api-status.js`),
the poll's handler (`src/client/web/dashboard-data.js`) and the unlock dialog
(`src/client/web/dashboard-wallet.js`).
