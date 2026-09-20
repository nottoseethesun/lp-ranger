# LP Ranger - Ride the Wild West of Your LP Ranges

![LP Ranger Banner, showing the name in Western style against the Texas night sky.](./assets/lp-ranger-app_social-preview-for-github-project-config-half.png "LP Ranger Banner")

[![Lint (JS+CSS+MD)](https://img.shields.io/github/actions/workflow/status/nottoseethesun/9mm-lp-position-manager/ci.yml?branch=main&label=lint)](https://github.com/nottoseethesun/9mm-lp-position-manager/actions/workflows/ci.yml)
[![Tests (Node 20/22/24)](https://img.shields.io/github/actions/workflow/status/nottoseethesun/9mm-lp-position-manager/ci.yml?branch=main&label=tests)](https://github.com/nottoseethesun/9mm-lp-position-manager/actions/workflows/ci.yml)
[![Security Audit](https://img.shields.io/github/actions/workflow/status/nottoseethesun/9mm-lp-position-manager/security-audit.yml?branch=main&label=security)](https://github.com/nottoseethesun/9mm-lp-position-manager/actions/workflows/security-audit.yml)

## Overview

LP Ranger keeps your coins concentrated around the current price point in on-blockchain liquidity pools, maximizing your earnings from fees, and shows you your key performance indicators such as Impermanent Loss/Gain and Profit.

LP Ranger is an on-chain, self-hosted, auto-rebalancing concentrated liquidity manager for crypto, dedicated to simplicity, for [9mm Pro](https://9mm.pro)
(Uniswap v3 fork) on [PulseChain](https://pulsechain.com) (Ethereum w/o the Bug-eating). Manages multiple LP positions simultaneously across different pools from a single wallet, with complete P&L stats extending back up to five years per pool. Provides a unified global view of all your positions' performance in a sortable table.

With LP Ranger, you hold your own coins on your own wallet, at a wallet address on the blockchain: It is a completely self-custodial solution. You also run the software code (that makes up the LP Ranger application) yourself on your own machine: It is a completely self-hosted solution. Only basic computer skills, including just the very basic Terminal skills, are needed. The code is completely open-source and as such is free for you to completely inspect, use and modify ([License](#license)).

Looks back up to five years on your wallet to show you how you're doing with each liquidity pool.

_**With LP Ranger, you know where you're at.**_

_**Ride Your LP Ranges with the Trusty LP Ranger!**_

**V3 positions only** — V2 and V4 positions are not supported.

## Table of Contents

- [Overview](#overview)
- [Disclaimer](#disclaimer)
- [Screenshot](#screenshot)
- [Prerequisites](#prerequisites)
- [Install](#install)
- [Optional: Verify Download](#optional-verify-download)
- [Update](#update)
- [Uninstall](#uninstall)
- [Usage](#usage)
  - [Help and User Manual](#help-and-user-manual)
- [Configure](#configure)
- [Lint & Test](#lint--test)
- [Private Key Security](#private-key-security)
- [Development](#development)
  - [Claude Code Memory Setup](#claude-code-memory-setup)
  - [Architecture and Engineering References](#architecture-and-engineering-references)
- [License](#license)
- [Road Map](#road-map)
- [Donations](#donations)
- [Contributing](#contributing)

---

## Disclaimer

This software is provided "as is", without warranty of any kind. It has not
been formally audited and may contain bugs or vulnerabilities. Transactions
executed by LP Ranger are irreversible. Do not use this software with funds
you cannot afford to lose.

A full Disclosure &mdash; covering risk, venue relationships, conflicts of
interest, fees, MEV exposure, cybersecurity, and regulatory context &mdash;
is presented to the user on every app launch and is available at any time
via Settings &rarr; Disclosure. The rendered Disclosure is published at
[nottoseethesun.github.io/lp-ranger/disclosure.html](https://nottoseethesun.github.io/lp-ranger/disclosure.html);
its HTML source is maintained at `public/disclosure.html` in this repository.

---

## Screenshot

Here you can see LP Ranger really doing its job! The user has rebalanced too many times. That's because the user is the dev, and there isn't a complete toolchain on testnet, so he's doing the Only Way to Fly, "Testing in Production". But you can see the impact of that on Impermanent Loss/Gain.

![Dashboard Overview](docs/images/dashboard-screenshot-general-1.png)

For a full tour &mdash; configuration, P&L history, throttling, manual rebalance,
position browser, settings, lifetime net stats, Telegram options, in-app help,
and the responsive layout &mdash; see the
[**Screenshot Gallery**](https://nottoseethesun.github.io/lp-ranger/screenshot-gallery.html).

---

## Prerequisites

- Skills: Only very basic Terminal (a.k.a. "shell") skills, learnable in a few minutes.
- Machine: Any common computer; specifically, a 64-bit Intel, Apple, or ARM machine.
  - Known working light-weight computer: Raspberry Pi 5 (recommended configuration: with Heat Sink and Fan, 5GB RAM, and Ethernet cable Internet connection instead of Wi-Fi).
    - If using a lightweight machine such as a Raspberry Pi 5, avoid all unnecessary software, including any unnecessary browser extensions. You can install browser extensions if you need them, but simply disable them in the Web browser so that they don't soak up memory and CPU when you don't need to use them.
  - Machine must be kept secure: Up-to-date with updates, free of malware, and physically secure.
- Node.js 22+
  - For Linux (including for arm64 versions of Raspberry Pi), Mac, install:
    1. <https://brew.sh/>
    2. <https://formulae.brew.sh/formula/node#default>
  - If you can't find a Linux or Mac machine to use, then for Windows, install:
    1. <https://chocolatey.org/install>
    2. <https://community.chocolatey.org/packages/nodejs-lts>
- Web browser
- Not more than one liquidity position per liquidity pool. Starting with no liquidity positions is fine too.

---

## Install

> **Already running an older version of LP Ranger?** Skip this section and follow the [Update](#update) section instead &mdash; the update workflow preserves your wallet, managed positions, and any custom overrides while replacing only the shipped code and shipped defaults.

First meet the [Prerequisites](#prerequisites), above.

### Production

This is the install step for anyone who isn't doing dev work on LP Ranger. That's probably you. :)

First, download **both** assets of the latest official release from
[GitHub Releases](../../releases): the `.tar.gz` file, and its
`.tar.gz.sha256` companion.

_Strongly recommended:_ [verify the download](#optional-verify-download) against
that checksum before extracting. It takes seconds, and it is what tells you the
tarball arrived intact and unaltered before you run software that holds the keys
to your funds.

Second, on the commandline in your Terminal, do:

```bash
tar xvzf lp-ranger-*.tar.gz     # Recommended: Instead of the star, use the full version number
cd lp-ranger-[current-version-number]
npm ci                           # install exact pinned dependencies
# Security warnings are detailed here: https://github.com/nottoseethesun/lp-ranger/blob/main/docs/security.md#npm-audit
# The next step is optional, and not for standard set-ups.
#    Only use it if you have a specific custom set-up in mind.
#    Uncomment the line below for a custom set-up.
# cp .env.example .env             # edit with your values
npm start                        # dashboard + bot at http://localhost:5555
```

> Note: Production releases pin every dependency to an exact version and include
> `package-lock.json`. Always use `npm ci` (not `npm install`) to ensure
> you get the exact tested versions with no version drift.

Third, prepare your crypto wallet information per the instructions in the [Usage](#usage) section here.

Fourth, visit <http://localhost:5555> in your web browser, accept the disclosure, and
import or create your wallet. LP Ranger then lists the liquidity positions your wallet
holds, which takes a few minutes.

The first position you select will commence a synchronization process with the
blockchain. Allow about an hour for a position to sync, depending on how long ago the
liquidity pool was created and how many times the position has rebalanced.

Once the position you are currently on is sync'd, choose a position you want to be
automatically rebalanced (and optionally, auto-compounded), and click the "Manage" button
on it (top left). Clicking the "Manage" button brings a position under management for
active automatic rebalancing and compounding.

For this first session, plan for a one-and-done wait that is much shorter on every run
afterwards. Allow roughly an hour per position: a single position is usually ready inside
that, and 10 positions across 10 different liquidity pools, some of them years old, take
the better part of a day. You may just let it run and
come back later to check whether the "Syncing" badge at top right of the app has turned
green and says "Synced". That's when the app is ready to use.

### Development

```bash
git clone <repo-url>
cd lp-ranger
npm install                      # allows version ranges for dev flexibility
cp .env.example .env             # edit with your values
npm run dev                      # build + watch mode
```

---

## Optional: Verify Download

Catches a corrupt download or a tampered tarball before you trust the code on your machine.

After downloading both the `.tar.gz` and its `.sha256` sidecar into the same directory, run **one** of the following from that directory. Replace `[version]` with the actual release tag.

**Linux / macOS:**

```bash
sha256sum -c lp-ranger-[version].tar.gz.sha256
```

You should see `lp-ranger-[version].tar.gz: OK`. Any other output (especially `FAILED`) means do not proceed &mdash; delete both files and re-download.

**Windows (PowerShell):**

```powershell
$expected = (Get-Content lp-ranger-[version].tar.gz.sha256).Split(' ')[0]
$actual = (Get-FileHash lp-ranger-[version].tar.gz -Algorithm SHA256).Hash.ToLower()
if ($expected -eq $actual) { "OK" } else { "FAILED" }
```

You should see `OK`. If it prints `FAILED`, do not proceed &mdash; delete both files and re-download.

---

## Update

If you're installing LP Ranger for the very first time, follow the [Install](#install) section instead &mdash; this section is for upgrading an existing install to a newer release.

**Step One** &mdash; Check for an update. If you have the LP Ranger app currently running, from the Settings gear icon at top right, click the last item in the dropdown menu, "Check for Updates & About". Give it a couple seconds and check the updated text in the middle of the dialog that pops up on the app. If there's no update, you're done for now.

If the app is not running, open [GitHub Releases](../../releases) and compare the tag on the latest release against the version in your install directory's name &mdash; `lp-ranger-[current-version-number]`. If they match, you're done for now.

**Step Two** &mdash; Download the new release tarball into the directory that _holds_ your current install &mdash; the one containing the `lp-ranger-[current-version-number]/` directory, not inside it. Steps Three and Four run from there too.

If the app is running and the dialog showed an update, click its **Get the update** link to open the release page and download **both** of these into that directory: the file ending in `.tar.gz` (the large one &mdash; **not** "Source code"), and its `.tar.gz.sha256` companion. You need the second one for Step Three.

Otherwise fetch both from that same directory. Replace `[new-version]` with the release tag from [GitHub Releases](../../releases):

```bash
# run from the directory that holds lp-ranger-[current-version-number]/
curl -LO https://github.com/nottoseethesun/lp-ranger/releases/download/[new-version]/lp-ranger-[new-version].tar.gz
curl -LO https://github.com/nottoseethesun/lp-ranger/releases/download/[new-version]/lp-ranger-[new-version].tar.gz.sha256
```

**Step Three** &mdash; Verify the download against the checksum. Strongly recommended: it takes seconds, and it is what tells you the tarball arrived intact and unaltered before you run software that holds the keys to your funds. See [Verify Download](#optional-verify-download) for the commands (Linux/macOS and Windows PowerShell).

**Step Four** &mdash; Extract the new tarball with the same plain `tar xvzf` you used at install time, from that same directory. It creates a fresh `lp-ranger-[new-version]/` directory next to your existing install; nothing in the existing install is touched yet:

```bash
tar xvzf lp-ranger-[new-version].tar.gz
rm lp-ranger-[new-version].tar.gz lp-ranger-[new-version].tar.gz.sha256
```

**Step Five** &mdash; Stop the running bot:

```bash
cd lp-ranger-[current-version-number]
# Press Ctrl+C in the terminal where the server is running, or from another
# terminal run:
npm stop
```

**Step Six** &mdash; Carry your personal state forward from the old install into the new one. The script never overwrites anything the release ships, and never modifies the old install:

```bash
cd ../lp-ranger-[new-version]
node ./util/update/migrate-app-state.js
```

It copies `.env`, `app-config`, `app-data` and `tmp`, and prints what it copied.

**Step Seven** &mdash; Install dependencies for the new release, from that same new install directory:

```bash
npm ci
```

**Step Eight** &mdash; Start the bot:

```bash
npm start
```

The dashboard remains at <http://localhost:5555>. Note that re-syncing takes roughly **an hour per position**, a little more for one with a long rebalance history behind it. Setting up a Moralis API key (free tier is enough) keeps that time down — without one, historical price lookups fall back to a slower, more heavily rate-limited source. You can just go away and come back later to check if the "Syncing" badge at top right of the app has turned green and says, "Synced". That's when the app is ready to use.

**Step Nine** &mdash; Once you've verified the new install is working correctly, remove the old version's directory to reclaim disk space.

**First, write down the version number in that directory's name** &mdash; the `[current-version-number]` part. Step Ten needs to know which version you updated _from_, and once the directory is deleted there is nowhere left to look it up.

```bash
cd ..
rm -rf lp-ranger-[current-version-number]
```

**Step Ten** &mdash; Post-update tasks. A few releases need a one-time action once you are running the new version. Compare the version you noted in Step Nine against the list below. If your old version is newer than everything listed here, you are done.

- **Updating from LP Ranger version 0.9.2.1 or earlier** &mdash; clear the blockchain scan caches. Step Six copies `tmp/` forward so an update normally starts warm, but this release changes how scan results and profit-and-loss periods are stored, and a figure cached by an older version can hold a value the new code no longer produces. Nothing detects that on its own: the old number simply persists and is displayed.

  Stop the bot first &mdash; the command refuses to run while a server is up &mdash; then, from your new install directory:

  ```bash
  npm stop
  npm run clear-blockchain-scan-cache
  npm start
  ```

  Your wallet, settings, managed positions and rebalance log are untouched; only the re-derivable scan caches go. Everything is then re-read from the blockchain, so expect the same re-sync wait as a fresh install &mdash; about an hour per position, less with a Moralis API key set up. A clean install instead of an update achieves the same thing and needs none of this.

- **Updating from LP Ranger version 0.9.1 or earlier** &mdash; run **Reload Current Position** once for every position you manage. This may take some time &mdash; allow about an hour per position, a little more for one with a long rebalance chain, and rather less with a Moralis API key set up.

  Use the Open Positions button in the header to switch to a position, then open the Settings gear at top right and click "Reload Current Position". Repeat for each managed position in turn.

### Details

This sub-section is optional background on the update process above &mdash; you do not need any of it to complete an update.

The release tarball includes only the shipped code and the shipped defaults (under `app-config/app-defaults-for-user-configurable/`). It explicitly excludes every file that holds your personal state &mdash; `.env` plus everything under `app-config/user-configurable/` and `app-data/` &mdash; so those files are never in the tarball. The upgrade workflow uses a plain `tar xvzf` to extract the new release into its own versioned directory next to the old one, then carries your personal state forward with a no-clobber copy.

> For background on the layered shipped-defaults / per-install user-overrides design &mdash; what goes in `app-config/user-configurable/`, how the merge works, and the rules for where new config files belong &mdash; see [The app-config Directory](docs/engineering.md#the-app-config-directory) in the engineering reference.

What Step Six carries forward, and all it carries forward:

- `.env`
- `app-config/user-configurable/*` (your wallet, bot config, encrypted API keys, and any operator overrides; the new install ships only a tracked `README.md` there)
- `app-data/*` (your rebalance log; the new install ships only a tracked `README.md` there)
- `tmp/*` (your performance caches; safe to skip if you want a fresh sync)

What it does NOT touch in the new install: the shipped code (`src/`, `public/`, `scripts/`, `docs/`, etc.) and the shipped defaults under `app-config/app-defaults-for-user-configurable/`. It also skips `node_modules`, which Step Seven installs fresh from the new release's `package-lock.json`.

Because Step Six carried those files across, the new install starts where the old one left off: the wallet unlocks from the encrypted `wallet.json`, managed positions resume polling, and operator overrides still apply.

Step Six's `migrate-app-state` supports `--dry-run`, which reports what it would copy without writing anything. Run it with `--help` for the rest, including `--from` for when more than one old install sits alongside the new one.

---

## Uninstall

**Step One** — Open the LP Ranger dashboard in your web browser as usual
(e.g. `http://localhost:5555`).

**Step Two** — Stop the server:

```bash
cd lp-ranger-[current-version-number]
# Press Ctrl+C in the terminal where the server is running,
# or, from another terminal in the app directory, run:  npm stop
# Wait for the server to stop gracefully.
# If it does not stop, press Ctrl+C again.
```

**Step Three** — Clear browser data:

&emsp;Click the **Settings** gear icon at top right in the LP Ranger app and click **"Clear Local Storage & Cookies"**.

**Step Four** — Remove the directory:

```bash
cd ..
rm -rf lp-ranger*
```

---

## Usage

1. Make sure that you've installed the app by following the instructions under [Install](#install).
2. Pick a wallet address that you own (it can be a new address that LP Ranger will generate for you later, if you want it to) and that you will use exclusively for LP Ranger activity (manual interactions with the dApps of supported DEX Pools, such as the 9mm Liquidity Manager, are okay as well).
   - This kind of wallet segregation is a security best-practice. Separately but as well, this will ensure that LP Ranger's Lifetime Net Profit and Lifetime Impermanent Loss/Gain (IL/G) numbers are correct.
3. Ensure that you either plan to use a brand new wallet address that LP Ranger will create for you if you so choose, or that you have either the Seed Phrase or Private Key of an existing wallet address if you plan to use an existing one.
4. On the wallet address that you will be using for LP Ranger, if you don't have any 9mm V3 Liquidity Positions on that wallet address, then create one or more at <https://dex.9mm.pro/liquidity>, making sure to use V3.
   - Next: If you used LP Manager to create your wallet, click on "Scan Wallet" on the LP Ranger App, in the LP Browser dialog. To reach the "Scan Wallet" button, first click the "Positions" button on the app (in the three-column view, it's near top middle, and otherwise, it's on the left). Next, click the "Scan Wallet" button at top right of the dialog that pops up (that's the LP Liquidity Position Browser, aka "LP Browser"). The scan process make take some time.
5. Visit <http://localhost:5555> in your web browser.
6. Now, continue on by proceeding with Step #2 under the "Getting Started & How to Use" section of the "LP Ranger Help and User Manual" (pull it up by clicking on the "? Help" button at top right on the app).

> **Note:** Selecting a position starts LP Ranger synchronizing it with the
> blockchain, which takes about an hour depending on how long ago the liquidity pool
> was created. The "Manage" button stays disabled until that position has synced.
>
> **Stopping LP Ranger:** press Ctrl+C in the terminal where it is running, or run `npm stop` from another terminal in the app directory. Either way it performs the same clean shutdown &mdash; it stops all managed positions, closes the server, and removes its PID file. (`npm stop` reads the server's PID from `tmp/lp-ranger.pid` and sends it SIGTERM.)

### Help and User Manual

**[View the full Help and User Manual](https://nottoseethesun.github.io/lp-ranger/help-and-user-manual.html)**

---

## Configure

No special configuration is needed beyond what the app's user interface already guides you through. Read on only if you want to override one of the shipped operator-tunable defaults for your install.

Shipped defaults live under [`app-config/app-defaults-for-user-configurable/`](app-config/app-defaults-for-user-configurable/) (do not edit; tarball upgrades overwrite). To override, copy the file into [`app-config/user-configurable/`](app-config/user-configurable/) and edit your copy there. The app deep-merges your overrides on top of the shipped defaults, with your values winning. Files under `user-configurable/` are gitignored and survive upgrades.

For the full layout and rules for where new config files belong, see [The app-config Directory](docs/engineering.md#the-app-config-directory) in the engineering reference.

---

## Lint & Test

Important: Avoid halting the `npm run check` process. Otherwise, you may need to run `npm run clean` and start from scratch with all the local blockchain data cache(s).

```bash
npm run lint                 # ESLint — 0 errors, 0 warnings
npm test                     # Node.js built-in test runner
npm run check                # lint + test (matches CI)
```

---

## Private Key Security

The bot supports **encrypted at-rest key storage** as an alternative to placing
a raw private key in `.env`. Keys are encrypted with AES-256-GCM using a
password-derived key (PBKDF2-SHA-512, 600 000 iterations) and stored as a JSON
file on disk. The raw key is never written to disk unencrypted.

To use this, set `KEY_FILE` in your `.env` instead of `PRIVATE_KEY`. For best
security, leave `KEY_PASSWORD` blank — the bot will prompt you interactively at
startup so the password is never saved to disk.

**WARNING:** If you lose your password, the encrypted key file **cannot** be
recovered. There is no password reset. You will need to re-enter your private
key or seed phrase to create a new encrypted file. Always keep a secure backup
of your private key or seed phrase independently.

See `src/key-store.js` for details and `.env.example` for the template.

---

## Development

### Claude Code Memory Setup

**Do this first on any new machine.** This repository carries its own Claude
Code memory — accumulated decisions, coding preferences, and open items — in
[`docs/claude/memory/`](docs/claude/memory/). It is **not** picked up
automatically, because Claude Code stores memory per-machine by default. Each
checkout has to be pointed at it once.

Add `autoMemoryDirectory` to `.claude/settings.local.json`, using the absolute
path to your checkout:

```json
{
  "autoMemoryDirectory": "/absolute/path/to/lp-ranger/docs/claude/memory"
}
```

That file is gitignored, so the setting stays machine-local. It **cannot** go
in the tracked `.claude/settings.json` — Claude Code ignores
`autoMemoryDirectory` from checked-in project settings by design.

Without this setting, Claude Code still works. It simply starts with an empty
memory in its default location
(`~/.claude/projects/<sanitized-path>/memory/`), and none of this project's
accumulated context is loaded.

Machine-local memories — infrastructure and remote-access details, wallet and
contract addresses, live position and P&L figures — live in
`docs/claude/memory/private/`. That directory is tracked but its contents are
gitignored, so they do not travel with a clone; a fresh machine starts without
them by design. Full layout and the rules for what may be published are in
[`docs/claude/memory/README.md`](docs/claude/memory/README.md).

### Architecture and Engineering References

For an overview of LP Ranger's architecture — how the bot and dashboard
interact, the rebalance pipeline, P&L tracking, and security model — see
**[`docs/architecture.md`](docs/architecture.md)**.

**For configuration** — every environment variable, where each setting lives
on disk, how the layered defaults resolve, and which settings are deliberately
not editable — see **[`docs/configuration.md`](docs/configuration.md)**.

**For security** — what is at stake, every control in effect, and the lint
and test gates enforcing each one — see
**[`docs/security.md`](docs/security.md)**.

**For engineering details** — development tools, the check-report pipeline,
and the rest of the internals — see
**[`docs/engineering.md`](docs/engineering.md)**. That is the authoritative
engineering reference for this project.

**For every `npm` command** — what it does, which flags it takes, and a
line you can copy — see
**[`docs/npm-project-commands.md`](docs/npm-project-commands.md)**. Every
entry point also answers `--help`, for example
`npm run build-and-start -- --help`.

---

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE) for the
full text.

---

## Road Map

Have no expectation that these items will be done. They are presented for the purpose of future focus.

### Nice to Have's

These are **polish and refinement ideas**, not bugs. The app works correctly today; each item below describes a small UX or developer-experience improvement that has been considered but deliberately deferred. None of them block normal use, and funds are never at risk from any item on this list.

| Item                                                                                                                                | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Avoid Edge-Case, Temporary Lag in Rebalance Data](docs/roadmap/nice-to-haves/project_rebalance_data_lag.md)                        | Incremental scanner sometimes, depending on blockchain reads coming through normally, misses pairing a new rebalance to its cached predecessor; self-heals next cycle but causes brief lag of about 30 minutes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| [Show Swap Route Even If Only Blockchain Data Available](docs/roadmap/nice-to-haves/project_route_via_chain_scan_gap.md)            | Chain-scanned rebalance events have no swap-source field, so "Routed Via" shows em-dash on fresh installs; recover from on-chain receipts.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| [Suppress False Out-of-Range on Unmanaged View Until Synced](docs/roadmap/nice-to-haves/project_suppress_oor_until_synced.md)       | Unmanaged view briefly shows a position as out-of-range before range bar and price finish loading; gate the indicator on full sync.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| [Corrective-Swap Oscillation Guard](docs/roadmap/nice-to-haves/project_corrective_swap_oscillation.md)                              | Corrective-swap loop can overshoot then exhaust 3 iterations on volatile paths, leaving small residuals above the dust threshold.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| [Mint Speed-Up Recompute](docs/roadmap/nice-to-haves/project_mint_speedup_recompute.md)                                             | On a stuck mint speedup, recompute amounts/min from a fresh pool snapshot so a delayed mint doesn't revert on stale slippage.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| [ESM Migration](docs/roadmap/nice-to-haves/project_esm_migration.md)                                                                | Migrate the codebase from CommonJS `require` / `module.exports` to ESM `import` / `export`. Dedicated branch, big-bang change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| [Log-to-File](docs/roadmap/nice-to-haves/project_log_to_file.md)                                                                    | Optional CLI flag and Settings toggle to tee server output to `logs/lp-ranger.log` with size rotation, for hardware with limited scrollback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| [Dashboard Cycle Cleanup](docs/roadmap/nice-to-haves/project_dashboard_cycle_cleanup.md)                                            | Untangle the 31 circular imports in `public/dashboard-*.js` (surfaced by `npm run show-dependency-cycles`), then wire `madge --circular` into `npm run check` to block future cycles. Not a major issue — the esbuild bundle dedupes any duplication at build time and nothing breaks at runtime; this is a structural cleanup that would allow a cycle gate to be installed in CI.                                                                                                                                                                                                                                                                                                       |
| [Batch And Cache The Per-NFT History Walk](docs/roadmap/nice-to-haves/project_cache_per_nft_walk.md)                                | The batching half has shipped: one pass now covers a whole chain in around 510 queries rather than 53,268. What remains is the cache. Each NFT is re-read on every cold start even though its history is settled, so a long chain pays the same minutes again on each one. Caching against a high-water block would take a restart to roughly seven seconds. Non-trivial because an NFT can be re-funded on 9mm outside LP Ranger, so entries need per-NFT resumption rather than a write-once.                                                                                                                                                                                           |
| [Derive Per-NFT Fees From One Scan Instead of Two](docs/roadmap/nice-to-haves/project_consolidate_fee_scans.md)                     | Per-NFT trading-fee totals are derived twice, by two passes over the same `Collect`/`DecreaseLiquidity` logs, into two stores (`pnl-epochs-cache.json` for the Per-Day table, `bot-config.json` for the Lifetime panel). Both now share one formula and agree; merging the passes would halve the log queries on a rebuild and make future drift impossible by construction.                                                                                                                                                                                                                                                                                                              |
| [Merge Per-Topic Log Queries Into One Call Per Chunk](docs/roadmap/nice-to-haves/project_merge_per_topic_log_queries.md)            | Reading one NFT's history asks the blockchain the same question twice over the same block range — once per event type — and the compound scan asks three times. A log filter accepts a list of event types, so one request could carry all of them. Measured before batching landed, on a cold rebuild of the dev wallet's 132-rebalance chain: 44,352 paced requests where 22,176 would do. That chain is a narrow-range test artifact, not a typical position. Deferred on risk, not size: the partition step sits directly upstream of exit values and fee totals, where a subtly wrong match shows up as wrong money figures rather than an error.                                    |
| [Walk Mint Lookups Newest-First](docs/roadmap/nice-to-haves/project_mint_lookup_scan_direction.md)                                  | Finding when an NFT was minted walks blockchain windows from the pool's creation block forward, stopping at the one that finds the mint. Token ids are global, so a high id means a recent mint — at the far end of that walk. Observed on a cold start: 945 windows for NFT #163164, roughly eighteen minutes, to reach an event a newest-first walk finds in seconds. Both call sites share the shape (`hodl-baseline.js`, `event-scanner-mint-lookup.js`), and direction cannot change the answer since an NFT is minted exactly once. Deferred because the bound feeds HODL baselines and chain mint blocks, where a wrong block shifts money figures silently rather than erroring.  |
| [Rebuild Only the Missing Epoch, Not the Whole Chain](docs/roadmap/nice-to-haves/project_rebuild_only_missing_epoch.md)             | Every rebalance closes one position and so needs one new P&L entry — but a stored epoch does not record which NFT it came from, so the app can only compare counts and rebuild all of them. On a 132-rebalance chain that is 133 positions read to learn about one, and the disk cache is skipped entirely for being short by that one. Two routes: record the tokenId on each epoch (permanent, and also removes the partial-rebuild overwrite), or stop clearing the in-memory resume buffer on success (much smaller, but lost on restart and needs a check on baked-in fallback prices first). Deferred until a cold start is dependable.                                             |
| [Fan Reads Out Across RPC Endpoints](docs/roadmap/nice-to-haves/project_rpc_read_fan_out.md)                                        | All blockchain requests share one four-per-second queue, but the three configured endpoints are run by three operators who each police only their own door — so one endpoint's allowance is spent while two sit idle. Fanning reads across all three would finish a history rebuild in roughly a third of the time without asking any one of them for more than it allows today. Writes would stay pinned to one endpoint, since a transaction that wanders mid-nonce is a bad day. Deferred until the app is solid — revisit no earlier than March 2027, as it changes the path every read in the process travels.                                                                       |
| [`startBotLoop` Lifecycle Test Scaffolding](docs/roadmap/nice-to-haves/project_bot_loop_test_scaffolding.md)                        | Build a test fixture for `startBotLoop`'s poll/stop lifecycle so behaviours that need a poll held mid-flight — the `stop()` race, for one — can be covered. Today only the extracted helpers (`pollCycle`, `resolvePrivateKey`, etc.) are covered.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| [Gas-Defer Retry Limit](docs/roadmap/nice-to-haves/project_gas_defer_retry_limit.md)                                                | Optional cap on the gas-defer retry loop so very small positions don't churn the log indefinitely. Not strictly required: the loop consumes no gas, and the user can always halt it via the LP Browser → Remove flow.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| [Label Retry Rebalances in Notifications](docs/roadmap/nice-to-haves/project_retry_rebalance_notifications.md)                      | Telegram / Activity Log say "Rebalance Succeeded" for every rebalance regardless of whether it was the first or a follow-up retry (corrective swap, post-backoff retry, residual cleanup). Relabel non-initial rebalances as "Retry Rebalance Succeeded (reason)" so the user can tell course-correction from fresh work at a glance.                                                                                                                                                                                                                                                                                                                                                     |
| [Throttle Rehydrate Restores Full State](docs/roadmap/nice-to-haves/project_throttle_rehydrate_full_state.md)                       | On bot restart, `throttle.rehydrate(count)` restores the daily count but not `rebTimestamps`, so volatility-doubling debounce doesn't recognise history until 3 new rebalances land within the window. Store + rehydrate the timestamps so doubling activates immediately across restarts.                                                                                                                                                                                                                                                                                                                                                                                                |
| [Range Width as a Fraction of Pool's Populated Liquidity Range](docs/roadmap/nice-to-haves/project_range_width_pool_populated.md)   | Add a per-position width option expressed as a percentage of the pool's currently-populated liquidity range, alongside the existing Price Range Extension (percentage of current price). More native to LP decision-making; requires querying the pool's tick bitmap to compute the denominator.                                                                                                                                                                                                                                                                                                                                                                                          |
| [Letter-First CSS Class Prefix](docs/roadmap/nice-to-haves/project_css_prefix_rename.md)                                            | Every CSS class starts with a digit (`9mm-pos-mgr-`), so every selector carries a character escape. A formatter once wrapped a line right after one, silently changing what the rule matched while every gate stayed green. Two guards now catch that; a letter-first prefix would remove the class of problem instead. Wide, mechanical sweep.                                                                                                                                                                                                                                                                                                                                           |
| [Consolidate the RPC Retry Pattern](docs/roadmap/nice-to-haves/project_consolidate_rpc_retry.md)                                    | `getPoolState` and `_readBothBalancesWithRetry` each carry their own copy of the same primary-then-fallback retry loop, differing only in what they call and which error they raise. A shared helper would collapse both. Deliberately excludes the write path and the price-source cascade, which are different concerns.                                                                                                                                                                                                                                                                                                                                                                |
| [Remove Orphaned HTML Element IDs](docs/roadmap/nice-to-haves/project_orphan_html_ids.md)                                           | About 42 element IDs in the dashboard markup are referenced by no JavaScript or CSS &mdash; leftovers from removed features. Inert, but they mislead anyone reading the HTML. Best cleaned opportunistically, one cluster at a time, when a task already lands nearby; an automated lint was rejected as too false-positive-prone.                                                                                                                                                                                                                                                                                                                                                        |
| [Debug Scripts Print the Inspector URL](docs/roadmap/nice-to-haves/project_debug_scripts_print_url.md)                              | The four `npm run debug*` scripts start Node's debugger without plainly saying where to go next &mdash; the useful line is either mixed into startup output or buried in a block of alternatives. Print one clean `chrome://inspect` line instead, and move the alternatives to the engineering docs.                                                                                                                                                                                                                                                                                                                                                                                     |
| [Stop Hanging Properties on Arrays](docs/roadmap/nice-to-haves/project_no_properties_on_arrays.md)                                  | The event scanner attaches `firstMintBlockNumber` and `firstMintTimestamp` directly to the events array. Copying an array copies its entries, not properties stuck beside them, so `push(...)`, `slice` and `map` all drop them silently &mdash; which made a scan-speed fix a no-op on the bot's code path while working on the dashboard's. Patched at the one copy site and pinned by a test; the pattern remains. Return an object instead, and add a custom ESLint rule rejecting property assignment onto an array.                                                                                                                                                                 |
| [Split the Overloaded Rebalance-Paused Flag](docs/roadmap/nice-to-haves/project_split_rebalance_paused_flag.md)                     | One flag, `rebalancePaused`, covers both a rebalance abandoned over excessive swap cost (needs an operator decision) and one paused after exhausting retries on a volatile pool (may clear itself). Behaviour is correct; the shared name makes accurate wording hard. Splitting it touches ~15 files and one `/api/status` field, so it wants its own PR.                                                                                                                                                                                                                                                                                                                                |
| [Re-scan Prices and Reload for Unmanaged Positions](docs/roadmap/nice-to-haves/project_rescan_reload_for_unmanaged.md)              | Both actions refuse on an unmanaged position, and the dialogs now say why. The refusal is mechanical: each drives its work through a running bot loop, and the server resolves the position from that loop’s state, so without one the route answers 404. Little is actually at stake — an unmanaged position shows no Lifetime panel, and its Current panel is recomputed from chain each request — but a bad price in the shared caches is visible there with no way to correct it short of Manage → re-scan → stop.                                                                                                                                                                    |
| [Merge the Two Historical-Price Lookups](docs/roadmap/nice-to-haves/project_merge_historical_price_fetches.md)                      | Reconstruction prices a pool's two tokens under a block-scoped cache key, while the gas lookup prices the native token under a day-scoped one. Same token, same moment, two entries that cannot see each other — so a pool holding the native token pays for it twice. Every figure is correct; the cost is duplicated calls against a rate-limited tier. Making the single-token lookup the primitive is surgery on `price-fetcher.js`, so it wants its own branch.                                                                                                                                                                                                                      |

### Possible Major New Features

| Item                                                                                                   | Description                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Multi-Chain Support](docs/roadmap/major-features/project_major_features.md#multi-chain-support)       | Add 9mm on Ethereum first, then the other blockchains that 9mm supports.                                                                               |
| [LP Optimization Engine](docs/roadmap/major-features/project_major_features.md#lp-optimization-engine) | Integrate with an external service recommending optimal range width, rebalance timing, and fee tier from historical pool data and volatility analysis. |
| [X1 (Solana-Fork) Port](docs/roadmap/major-features/project_x1_transfer_plan.md)                       | Port LP Ranger to X1, a highly-modified Solana fork that keeps the unmodified SVM. Layered transfer plan and 5 blocker questions captured.             |

---

## Donations

If LP Ranger makes liquidity providing easier or more efficient for you and you'd like to support its continued development, donations are welcome at:

`0x52Cf7B0c566B3Bae5d42038dc357dbC9Ab4207D5`

Same address on any EVM-compatible chain. I actively monitor **PulseChain** and **Ethereum**; donations on other EVM chains (BSC, Polygon, Arbitrum, Base, etc.) are accepted and appreciated, but please be aware I check them infrequently.

Thank you for the support — it directly funds development time on LP Ranger.

---

## Contributing

Bug reports and ideas for new features and improvements are welcome. Use the [Discussions](https://github.com/nottoseethesun/lp-ranger/discussions) tab to discuss and ask questions, or if you have something very specific and are ready to supply logs, use the [Issues](https://github.com/nottoseethesun/9mm-lp-position-manager/issues) tab.

Due to security being the highest priority, only contributions that have been formally audited for security can be considered for acceptance.
