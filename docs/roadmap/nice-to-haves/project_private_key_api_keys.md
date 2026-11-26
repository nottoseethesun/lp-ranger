# Telegram and Moralis Keys in a PRIVATE_KEY Session

> **Status:** Nice-to-have, not a bug. Nothing is built yet. Positions
> are managed correctly without it; only Telegram alerts and the
> Moralis price service are off for the session.

## What happens now

The Telegram bot token and chat id, and the Moralis api key, are
stored encrypted with the wallet's password, in
`app-config/user-configurable/api-keys.json`. The server decrypts them
when it is given that password: from `WALLET_PASSWORD` in `.env`, at
the terminal prompt of `--headless`, in the dashboard's Unlock Wallet
dialog, or with a wallet import.

A server started with `PRIVATE_KEY` in `.env` signs with that key and
is given no password, so it decrypts none of them. The dashboard shows
the wallet unlocked, since the server holds a key, and offers no
Unlock Wallet dialog. So for the whole session no Telegram alert is
sent, the alert for a closed position taken off the managed list at
start-up included, and prices are asked of the other price services
instead of Moralis. The server's log says so as it starts.

## Shape of the fix

A way to give such a session the wallet's password from the dashboard,
so the server decrypts the stored keys, with the key it signs with left
as it is.

## To settle first

- Whether the password must also open the wallet file, proving it the
  wallet `PRIVATE_KEY` signs for, or need only decrypt the api keys.
