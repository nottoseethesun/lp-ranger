# Security Audit Guide

Companion to [CLAUDE.md](../../CLAUDE.md). Covers the automated security
checks, why they matter for EVM fund safety, how to run them, and how
to triage findings.

---

## What the Audit Checks

The security audit has three independent layers:

| Check | Command | What it catches |
| ----- | ------- | --------------- |
| **Dependency CVEs** | `npm run audit:deps` | Known vulnerabilities in npm packages (high severity) |
| **Security lint** | `npm run audit:security` | Unsafe code patterns via eslint-plugin-security |
| **Secret scan** | `npm run audit:secrets` | Hardcoded private keys, mnemonics, API keys via secretlint |

All three run in CI (`.github/workflows/security-audit.yml`) as
separate jobs that can be individually required in branch protection.
All three also run locally via `npm run check`.

---

## Why Each Check Matters for EVM / Crypto Fund Safety

### Private key exposure

This tool manages a wallet that signs on-chain transactions. A leaked
private key means total loss of funds. Keys flow through:

- `PRIVATE_KEY` env var (plaintext — simplest, least secure)
- `app-config/user-configurable/wallet.json` (AES-256-GCM encrypted on disk, gitignored — imported via dashboard or `node scripts/import-wallet.js`)
- In-memory only during signing (never written to disk in plaintext)

**secretlint** catches hardcoded keys before they reach the repo.
The recommended preset includes patterns for generic private keys,
API keys, and credentials. **eslint-plugin-no-secrets** adds
entropy-based detection within JS source files.

### Unsafe entropy

`Math.random()` is not cryptographically secure. If used for nonce
generation, key derivation, or any security-sensitive randomness,
an attacker could predict outputs. The security lint rule
`detect-pseudoRandomBytes` catches this.

### Injection (eval, child\_process, dynamic require)

`eval()` and `child_process.exec()` with user-controlled input allow
arbitrary code execution. `require()` with a variable path allows
loading arbitrary modules. The security lint catches all three:

- `detect-eval-with-expression`
- `detect-child-process`
- `detect-non-literal-require` (disabled — see Triage section)

### Prototype pollution

Bracket notation (`obj[userInput]`) can overwrite `__proto__`,
`constructor`, or `prototype` if the key comes from untrusted input.
The `detect-object-injection` rule catches this but is disabled
because bracket access on config objects is intentional and pervasive
in this codebase. Config keys come from the server's own
`POSITION_KEYS` / `GLOBAL_KEYS` arrays, not user input.

### Path traversal

`fs.readFileSync(userInput)` allows reading arbitrary files. The
`detect-non-literal-fs-filename` rule catches this but is disabled
because all fs paths in this codebase come from
`path.join(process.cwd(), CONSTANT)` — no user-controlled paths.

### Dependency CVEs (supply chain)

A compromised npm package in the dependency tree could steal private
keys at runtime. `npm audit --audit-level=high` catches known
vulnerabilities. The `elliptic` vulnerability in `@uniswap/v3-sdk`
is a known ecosystem-wide issue with no available fix.

---

## How to Run Locally

```bash
# Individual checks
npm run audit:deps       # Dependency CVEs (high severity)
npm run audit:security   # Security lint (eslint-plugin-security)
npm run audit:secrets    # Secret scan (secretlint)

# All checks at once (lint + test + coverage + security)
npm run check
```

---

## How to Triage Findings

### Severity levels

- **High / Critical (npm audit):** Fix immediately. Update the
  package or find an alternative. If no fix exists (e.g. `elliptic`
  in `@uniswap/v3-sdk`), document the risk and monitor.
- **Moderate / Low (npm audit):** Assess whether the vulnerable code
  path is reachable. Fix if practical, otherwise accept.
- **Security lint warnings:** Each rule flags a pattern, not a
  confirmed vulnerability. Evaluate whether untrusted input reaches
  the flagged code.

### Advisories with no fix available

What gates is the tree that **ships**. `npm run audit:deps` and the
dependency check inside `npm run check` both pass `--omit=dev`, because
that is the tree running beside an unlocked wallet. The full tree,
development tooling included, is audited by `npm run audit:deps:all` and
is written to `test/report-artifacts/raw-data/npm-audit.json` on every
`npm run check`, so what is not gated is still read.

The distinction is not convenience. A dev-tool advisory is reached
through glob patterns this repository writes, never through anything an
attacker supplies, and it can be unfixable through no fault of ours.
`braces` is that case: the newest published version **is** the
vulnerable one, and the newest `micromatch` declares `^3.0.3`, which
only that version satisfies. Every tool that globs — stylelint, knip,
secretlint, markdownlint-cli2 — therefore carries it, and those tools
are the gate. Gating on it would mean a permanently red gate with no
action available, which teaches people to ignore the gate.

The same advisory **did** reach the shipped tree, and that was worth
fixing rather than accepting: `@uniswap/v3-sdk` depends on
`@uniswap/swap-router-contracts`, which declares the `hardhat-watcher`
dev tool as a runtime dependency, which pulled an old `chokidar` and so
`braces`. Nothing in this app loads any of it. The scoped override in
`package.json` replaces that `chokidar` with `empty-npm-package`,
beside the entry that already does the same for `hardhat`, and the
shipped tree now reports no high advisory at all.

So when a high advisory appears: run the regeneration
([[feedback_regenerate_lockfile]]), and if it survives, establish
whether it reaches the shipped tree. If it does, fix it — a scoped
override that prunes an unused subtree is a legitimate fix. If it is
dev-only and unfixable, it belongs here, named, with the reason it
cannot be fixed and the condition that would let it be.

**A dev-only advisory that CAN be fixed is still fixed.** The gate no
longer forces the issue, which is exactly why this has to be said:
`--omit=dev` means "not a release blocker", never "not our problem".
`npm run audit:deps:all` is the command that shows them, the full
report is written on every `npm run check`, and a patched version that
a regeneration would pick up should be picked up. What the narrower
gate buys is that an advisory nobody can act on cannot hold the branch
hostage — not permission to stop looking.

### When the release audit is red and main is green

Two workflows run the dependency audit, and they look at different
code. `security-audit.yml` audits the commit it runs on, so on main the
auditor and the audited tree are the same thing.
`security-audit-production.yml` runs daily, resolves the newest
published release, checks that tag out and audits **it** — the code
operators are actually running, which can be weeks behind main.

The two therefore disagree whenever a fix has landed on main and has
not yet been released. That is the normal reading of a red release
audit: main is ahead. It is not a false alarm, and it does not clear
itself. Publishing the release clears it.

Two things make such a run hard to read.

**A scheduled run's branch badge always shows the default branch.**
That is where the workflow file was read from, not what was checked
out. A run auditing 0.9.8 displays `main`, directly above a
main-auditing run that also displays `main` — two rows, one badge, two
different trees. Read the tag off the job's first step instead:
`Latest published release: X`.

**The result is not a function of the code.** It is the code against
the advisory database on the day it runs, and that database moves on
its own. The same immutable 0.9.8 tag audited green on 2026-10-02 and
red on 10-03, because `braces` began matching its tree in between. A
tree that has not changed can start failing, and yesterday's pass
proves nothing about today.

The release audit spells out its own command rather than calling the
release's `npm run audit:deps`, because a release must not define the
test it is judged by. 0.9.8's script predates `--omit=dev`, so those
runs listed fifteen high advisories — five reaching the shipped tree,
ten dev-only — and the ten camouflaged the five. The flags there and in
`package.json` are two rules that currently agree, not one rule stated
twice. `--package-lock-only` keeps the gate from going red because an
old tag's `npm ci` no longer resolves, and stops an install script
belonging to the dependencies under suspicion from running.

### Disabled rules and why

Two `eslint-plugin-security` rules are disabled in
`eslint-security.config.js`. All other rules are enabled.

| Rule | Why disabled |
| ---- | ------------ |
| `detect-non-literal-fs-filename` | ~90 false positives — every `fs` call uses computed paths from `__dirname` / constants, never user input. The rule can't distinguish safe constant paths from user-controlled ones. |
| `detect-object-injection` | Bracket access on config objects is intentional; keys come from server-owned `GLOBAL_KEYS` / `POSITION_KEYS` arrays. |

### Per-line exceptions for custom EVM rules

Never exclude entire files from any lint pass. When a custom
security rule flags an intentional pattern, use a per-line
`eslint-disable-next-line` with a `-- Safe: <reason>` comment:

```js
// eslint-disable-next-line 9mm/no-number-from-bigint -- Safe: float math for display
const liq = Number(liquidity);
```

The main ESLint config registers security rules at `off` with
`reportUnusedDisableDirectives: 'off'` so these directives exist
silently in the main lint pass. The security lint enforces the
rules and respects the directives.

Current per-line exceptions:

| File | Line | Rule | Reason |
| ---- | ---- | ---- | ------ |
| `src/hodl-baseline.js` | 37 | `no-number-from-bigint` | Approximate float math for sqrtPrice |
| `src/range-math.js` | 294 | `no-number-from-bigint` | Approximate float math for sqrtPrice |
| `src/position-detector.js` | 169 | `no-number-from-bigint` | Zero-check only |

### secretlint false positives

secretlint uses the `@secretlint/secretlint-rule-preset-recommend`
preset which includes 15 built-in rules for AWS, GCP, GitHub,
Slack, and generic private key patterns. If a false positive is
flagged, check whether the string is a contract address or ABI
encoding (safe) vs a private key or API secret (fix immediately).

Configure allowlists in `.secretlintrc.json` using the
`allowMessageIds` option per rule.

---

## Fund Safety Architecture

These are not checked by automated tooling but are critical design
decisions documented here for security reviewers.

### Nonce management

A single async-mutex rebalance lock (`src/rebalance-lock.js`)
serializes all transactions across all managed positions. Only one
position sends TXs at a time. The lock has no timeout — it releases
only after TX confirmation. This prevents nonce collisions that could
cause stuck or lost transactions.

### TX recovery pipeline

`_waitOrSpeedUp()` in `src/tx-speedup.js` wraps the `tx.wait()` of
every send that goes through `sendTx.sendTransaction`, with a 4-phase
pipeline: wait, speed-up (1.5x gas), wait again, auto-cancel (0-PLS
self-transfer). The aggregator swap sends outside that entry point and
carries its own cancel-and-re-quote loop. Either way a cancel goes out
at the stuck nonce instead of the wallet being left blocked, and a
cancel that cannot be confirmed is logged as possibly still stuck rather
than assumed clear.

**At most one swap per swap intent.** A swap and the cancel sent to
displace it occupy one nonce, so at most one of them can mine, and the
aggregator's retry will not send anything until the chain names which.
It reads a receipt for each hash and checks the swap's `status`, because a
reverted transaction has a receipt too. When neither is named the
rebalance fails rather than re-quoting, and the error is flagged so
`swapIfNeeded` declines its V3-router fallback — a fallback that would
otherwise read the failure as "no swap happened" and swap the same balance
again. The cost of the refusal is a drained position for a few cycles; see
[security.md § TX Recovery Pipeline](../security.md) for what the operator
is left holding.

### Slippage guards

Swap slippage is applied to a `staticCall` quote, not spot price.
When price impact exceeds the user's slippage setting, the swap
aborts and the bot pauses — preventing large losses from low
liquidity pools.

### Key storage

`src/wallet-manager.js` encrypts the dashboard-imported (or CLI-
imported) wallet with AES-256-GCM and PBKDF2-SHA512 key derivation
at **600,000 iterations** (OWASP 2023 guidance for SHA-512).
`src/api-key-store.js` (third-party API keys) reuses
`src/key-store.js`'s encryption helpers at the same 600,000
iterations. Plaintext keys exist only in memory during signing. The
encrypted `app-config/user-configurable/wallet.json` and
`app-config/user-configurable/api-keys.json` files are both gitignored.

### Wallet password persistence

The wallet password — the passphrase the operator chose during
import (via the dashboard UI or `node scripts/import-wallet.js`) —
decrypts both `wallet.json` and every service entry in
`api-keys.json`. One password, every secret.

Three modes, in order of security recommendation:

1. **Dashboard unlock dialog** (default) — operator types password
   in the browser after each restart.
2. **`--headless` terminal prompt** — `node server.js --headless`
   prompts on stdin. Same security as the dashboard (memory only),
   no browser needed. If no password is provided, the server exits
   with an error rather than falling through to dashboard mode.
3. **`WALLET_PASSWORD` in `.env`** — fully unattended. Password
   lives on disk as plaintext. Least recommended.

In all three modes the password is cached in `_sessionPassword`
in `src/server-routes.js` so subsequent API-key operations during
the same session don't re-prompt. The cache is discarded when the
process exits.

**How `reset-wallet` works.** `scripts/reset-wallet.js`
(invoked via `npm run reset-wallet`) performs two idempotent
actions:

1. Delete `app-config/user-configurable/wallet.json`.
2. Remove every line matching `^WALLET_PASSWORD=` from `.env`
   by reading the file, filtering out the matching lines, writing
   to a `.tmp` sibling, and atomically renaming. File permissions
   are preserved via `fs.chmodSync` before the rename.

Both steps tolerate missing targets. `npm run clean` and
`npm run dev-clean` invoke `reset-wallet` as their first step.

### Config validation

`POST /api/config` requires a fully-qualified `positionKey`
(validated by `parseCompositeKey`) for all position-specific config
changes. Requests without a valid key are rejected with 400. This
prevents accidental broadcast of settings across positions.
