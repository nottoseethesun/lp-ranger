# Security Audit Guide

Companion to [CLAUDE.md](../CLAUDE.md). Covers the automated security
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

- `PRIVATE_KEY` env var or `KEY_FILE` (AES-256-GCM encrypted, PBKDF2-SHA512)
- `app-config/.wallet.json` (encrypted on disk, gitignored)
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

### Disabled rules and why

Three `eslint-plugin-security` rules are disabled in
`eslint-security.config.js` with documented reasons:

| Rule | Why disabled |
| ---- | ------------ |
| `detect-object-injection` | Bracket access on config objects is intentional; keys come from server-owned arrays |
| `detect-non-literal-fs-filename` | All fs paths use `path.join(cwd, CONSTANT)` — no user-controlled paths |
| `detect-non-literal-require` | Dynamic require used only for `chains.json` config loading |

If a disabled rule is re-enabled in the future, expect false positives
in these files: `src/bot-config-v2.js`, `src/server-routes.js`,
`src/config.js`, `src/key-store.js`, `src/wallet-manager.js`,
`server.js`.

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
| `src/range-math.js` | 253 | `no-number-from-bigint` | Approximate float math for sqrtPrice |
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

`_waitOrSpeedUp()` in `src/rebalancer.js` wraps every `tx.wait()`
with a 4-phase pipeline: wait, speed-up (1.5x gas), wait again,
auto-cancel (0-PLS self-transfer). This ensures nonces are never
permanently stuck.

### Slippage guards

Swap slippage is applied to a `staticCall` quote, not spot price.
When price impact exceeds the user's slippage setting, the swap
aborts and the bot pauses — preventing large losses from low
liquidity pools.

### Key storage

`src/key-store.js` uses AES-256-GCM with PBKDF2-SHA512 key
derivation (100,000 iterations). Plaintext keys exist only in memory
during signing. The encrypted `app-config/.wallet.json` file is gitignored.

### Config validation

`POST /api/config` requires a fully-qualified `positionKey`
(validated by `parseCompositeKey`) for all position-specific config
changes. Requests without a valid key are rejected with 400. This
prevents accidental broadcast of settings across positions.
