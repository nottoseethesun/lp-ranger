# LP Ranger — Security

This is the canonical reference for **how LP Ranger protects your funds**:
what is at stake, the controls in effect, and the lint and test gates that
keep each one from silently regressing.

LP Ranger holds the private key to a wallet and signs transactions with it.
Blockchain transactions cannot be reversed, so the controls below are
arranged as defense in depth — each layer assumes the one before it might
fail.

Three companion references sit alongside this one:
[`docs/architecture.md`](architecture.md) for how the bot and dashboard fit
together, [`docs/configuration.md`](configuration.md) for how the app is
configured, and [`docs/engineering.md`](engineering.md) for runtime state,
development tools and the check-report pipeline.

For the review guide that governs how security changes are made, see
[`docs/claude/CLAUDE-SECURITY.md`](claude/CLAUDE-SECURITY.md).

---

## Table of Contents

- [What's at Stake](#whats-at-stake)
- [Summary of Primary Controls](#summary-of-primary-controls)
- [Network](#network)
  - [Host Binding (Domain)](#host-binding-domain)
  - [Reverse Proxy Configuration Warning](#reverse-proxy-configuration-warning)
  - [Protocol Choice](#protocol-choice)
  - [Rate Limiting](#rate-limiting)
- [Message Security](#message-security)
  - [CORS Origin Guard](#cors-origin-guard)
  - [CSRF Tokens](#csrf-tokens)
  - [HTTP Method Allowlist](#http-method-allowlist)
  - [Path Traversal in Static Serving](#path-traversal-in-static-serving)
- [Authentication & Key Management](#authentication--key-management)
  - [Encryption at Rest](#encryption-at-rest)
  - [In-Memory Handling](#in-memory-handling)
  - [Secret Scanning](#secret-scanning)
  - [Gitignore Enforcement](#gitignore-enforcement)
- [Cryptographic Primitives](#cryptographic-primitives)
  - [No Custom Crypto](#no-custom-crypto)
  - [Authenticated Encryption](#authenticated-encryption)
  - [Secure Randomness](#secure-randomness)
- [Input Validation & Data Modeling](#input-validation--data-modeling)
  - [Composite Key Parsing](#composite-key-parsing)
  - [Config Key Allowlist](#config-key-allowlist)
  - [Checksummed Addresses](#checksummed-addresses)
  - [BIP-39 Seed Validation](#bip-39-seed-validation)
- [Injection Prevention](#injection-prevention)
  - [`eval` / `child_process` / Dynamic `require`](#eval--child_process--dynamic-require)
  - [Prototype Pollution](#prototype-pollution)
  - [XSS (Cross-Site Scripting) / DOM Safety](#xss-cross-site-scripting--dom-safety)
- [Filesystem Safety](#filesystem-safety)
- [On-Chain / Transaction Security](#on-chain--transaction-security)
  - [Nonce Serialization](#nonce-serialization)
  - [TX Recovery Pipeline](#tx-recovery-pipeline)
  - [RPC Failover](#rpc-failover)
  - [Slippage Guards](#slippage-guards)
  - [Swap Gates (Dust + Gas)](#swap-gates-dust--gas)
  - [Atomic Multicall](#atomic-multicall)
  - [BigInt Precision](#bigint-precision)
- [Supply Chain & Dependencies](#supply-chain--dependencies)
  - [Reputable-Package Philosophy](#reputable-package-philosophy)
  - [Pinned Production Releases](#pinned-production-releases)
  - [`npm audit`](#npm-audit)
  - [CI Enforcement](#ci-enforcement)
- [Runtime Hardening](#runtime-hardening)
  - [Strict Mode Everywhere](#strict-mode-everywhere)
  - [Error Guard](#error-guard)
  - [Graceful Shutdown](#graceful-shutdown)
- [Code Review Controls](#code-review-controls)
  - [Build and Infrastructure Scripts](#build-and-infrastructure-scripts)
  - [GitHub Actions Workflows](#github-actions-workflows)
- [Test-Time State Protection](#test-time-state-protection)

---

## What's at Stake

LP Ranger manages your cryptocurrency. It holds the private key to
your wallet and uses it to sign transactions on the blockchain —
removing liquidity, swapping tokens, minting new positions. If an
attacker gains access to that key, or tricks LP Ranger into signing
a bad transaction, your funds can be stolen permanently. Blockchain
transactions cannot be reversed: there is no bank to call, no
chargeback to file, no undo button.

The entire purpose of this security architecture is to make that
outcome as difficult as possible, from **multiple independent
angles**, so that no single failure — a leaked password, a forged
web request, a compromised npm package — can reach your funds.

**Example — how defense in depth works in practice:** Suppose a
malicious website tries to send a command to your LP Ranger server to
rebalance your position with extreme slippage settings. To succeed,
the attacker would have to bypass **all** of these layers:

1. **Network binding** — the server only accepts connections from
   your own machine (`127.0.0.1`). The attacker can't reach it from
   the internet.
2. **CORS (Cross-Origin Resource Sharing) guard** — even from the
   local machine, the server rejects requests that didn't originate
   from the LP Ranger dashboard itself.
3. **CSRF (Cross-Site Request Forgery) token** — even if the origin
   check passed, the request must carry a one-time cryptographic
   token that only the dashboard knows. Without it, the server
   returns 403 Forbidden.
4. **Config key `allowlist`** — even if the attacker had a valid
   token, the server only accepts recognized setting names
   (like `slippagePct` or `oorThreshold`). Unknown fields are
   silently dropped.

Each layer assumes the previous one might fail. That's what
**defense in depth** means — and it's the organizing principle for
everything in this section.

All cryptography uses Node's built-in `crypto` module and vetted
open-source packages (`csrf`, `ethers`, `async-mutex`,
`@uniswap/v3-sdk`, `jsbi`). Nothing is rolled in-house.

## Summary of Primary Controls

The following is a summary of the primary controls currently in
effect:

- **Your private key is encrypted on disk** — it's never saved in
  readable form. Only your password can unlock it, and the unlocked
  key exists only briefly in the computer's memory during
  transaction signing, then it's gone. (Encryption: AES-256-GCM
  (Advanced Encryption Standard, 256-bit key, Galois/Counter Mode)
  with PBKDF2 (Password-Based Key Derivation Function 2) SHA-512
  key derivation.)
- **The server only talks to localhost** — LP Ranger binds to
  `127.0.0.1` by default. No one on the internet or your local
  network can connect unless you explicitly override this.
- **Every command requires a one-time token** — CSRF tokens prevent
  a malicious website from tricking your browser into sending
  commands to LP Ranger on the attacker's behalf.
- **Swap transactions travel over encrypted connections** — to the
  9mm DEX Aggregator API (primary path) or directly to the RPC
  endpoint (fallback). Your swap intent is never exposed to the
  public network before the transaction is submitted to the
  blockchain.
- **Only one transaction at a time** — an async-mutex rebalance
  lock serializes all transaction signing across all managed
  positions. This prevents nonce collisions (which could cause
  stuck or lost transactions when multiple positions try to send
  at the same moment).
- **Sensitive files are excluded from version control** — wallet
  state, configuration, and API keys are all gitignored so they
  can't accidentally be committed to a public repository.
- **Every code change is scanned before it can ship** — static
  analysis, secret detection, and dependency vulnerability auditing
  run on every commit (`npm run check` locally, mirrored in CI).

Code cannot be included in the `main` branch unless it passes the
rigorous security checks detailed below. And in turn, Releases cannot
be made except from code in the `main` branch.

The subsections that follow document the implementation details and
lint/test enforcement behind each of these controls.

## Network

The first line of defense is the simplest: LP Ranger's server only
listens on your own machine's internal network address. An attacker on
the internet — or even on your local Wi-Fi — simply cannot connect.
The operating system refuses the connection before LP Ranger's code is
even involved.

### Host Binding (Domain)

`HOST` defaults to `127.0.0.1` so the kernel itself refuses connections
from outside the loopback interface. Overriding to `0.0.0.0` is
documented as a conscious LAN-exposure choice rather than the default.
The headless `bot.js` opens no inbound port at all. The Scalar API-docs
server in `scripts/api-doc.js` is likewise locked to `127.0.0.1`. Because
no application traffic crosses the public Internet in the default
deployment, eavesdropping, MITM (man-in-the-middle), and on-path
replay attacks on the dashboard's HTTP surface are structurally
impossible — TLS (Transport Layer Security) termination
becomes a concern only if a reverse proxy is introduced by the operator.

The CORS origin guard in [`src/server-cors.js`](../src/server-cors.js)
dynamically tracks whatever `PORT` is configured so the `allowlisted`
origin string always matches the actual listener. The `_isLocalhostOrigin`
helper accepts `localhost`, `127.0.0.1`, and `[::1]` (IPv4 + IPv6
loopback) but rejects every other hostname or port.

### Reverse Proxy Configuration Warning

LP Ranger is designed to run on localhost (`127.0.0.1`) and serves
traffic exclusively over the loopback interface by default. In this
configuration, TLS is not required because all traffic is internal to
the local machine and cannot be intercepted by external parties.

If you configure a reverse proxy to make LP Ranger accessible over a
network — for example to access the dashboard remotely — you assume
full responsibility for ensuring that TLS is properly configured for
the entire request path, including the leg between the reverse proxy
and the LP Ranger server. Failure to do so will expose sensitive
application traffic including wallet commands and session tokens to
interception. The Creator provides no support for reverse proxy
configurations and strongly recommends against exposing LP Ranger to
any network outside the local machine.

### Protocol Choice

All outbound calls to third-party services — RPC endpoints, 9mm
aggregator, DexScreener, GeckoTerminal, Moralis — use `https://` URLs by
policy; the default `RPC_URL` (`rpc-pulsechain.g4mm4.io`) and fallback
(`rpc.pulsechain.com`) both enforce TLS at the network layer. Inbound
dashboard traffic uses plain HTTP because it never leaves the loopback
interface; adding TLS to a localhost-only listener buys nothing and
complicates setup.

### Rate Limiting

The GeckoTerminal API caps free-tier callers at 30 calls/min.
[`src/gecko-rate-limit.js`](../src/gecko-rate-limit.js) enforces a
shared sliding-window limiter across every caller (price fetches, HODL
baseline, epoch reconstruction, pool-orientation bootstraps) so a single
misbehaving code path cannot burn the budget and trigger a 429 cascade.
There is no inbound rate limit on the dashboard's own HTTP endpoints —
the localhost-only binding makes one unnecessary.

## Message Security

Even if an attacker could somehow reach the server — for example,
through a browser on the same machine running a malicious page — every
command sent to LP Ranger must pass through multiple checks before
it's acted on. These checks protect against the most common class of
web-application attacks: tricks that abuse the browser's trust
relationship with the server.

### CORS Origin Guard

[`src/server-cors.js`](../src/server-cors.js) sets
`Access-Control-Allow-Origin: http://localhost:<PORT>` on every
response and rejects any mutating (`POST`, `DELETE`) request whose
`Origin` header resolves to a non-localhost host with a 403. Programmatic
callers (e.g. `curl`) send no `Origin` header and pass
through. Preflight `OPTIONS` requests are answered with `204` and the
same allowed-methods/headers list. `test/server-cors.test.js` covers the
accept-localhost and reject-foreign-origin paths.

### CSRF Tokens

[`src/server-csrf.js`](../src/server-csrf.js) uses the `csrf` package
(pillarjs) to issue cryptographically random tokens bound to a
server-generated secret. Every mutating request must carry a valid,
non-expired token in an `x-csrf-token` header. Tokens are pruned from
an in-memory issued-set when the set exceeds 500 entries.

**Lifetime and refresh cadence are tunables.**
[`app-config/app-defaults-for-user-configurable/csrf.json`](../app-config/app-defaults-for-user-configurable/csrf.json)
defines two values:

| Field | Default | Meaning |
| ----- | ------- | ------- |
| `tokenTtlMs` | `3600000` (60 min) | Server-side token lifetime. After this, `verifyToken()` returns `Expired CSRF token` and the server responds `403`. |
| `refreshIntervalMs` | `3000000` (50 min) | Delivered to the dashboard in every `GET /api/csrf-token` response. Must be strictly less than `tokenTtlMs`; keep ≥ 10 min margin to survive clock skew and a slow fetch. |

**Dashboard refresh mechanism.** On init the dashboard calls
`refreshCsrfToken()` once (in `public/dashboard-init.js`), then
schedules `setInterval(refreshCsrfToken, csrfRefreshIntervalMs())` using
the server-delivered interval. This timer is independent of the
`/api/status` poll loop and fires regardless of poll health — which is
the whole point. On a long-running host (e.g. Raspberry Pi 5 with Heat Sink and Fan (5GB RAM, and Ethernet cable Internet connection instead of Wi-Fi) during a
multi-hour phase-2 event scan) the status poll's in-flight guard can
skip ticks for extended windows; if the CSRF refresh were tied to that
path, tokens would silently expire and auto-fired background POSTs
(silent pool-history rescans triggered by rebalance-event detection,
unmanaged-position lifetime fetches, etc.) would 403 with no user
action involved. The dedicated timer makes expiry impossible in
practice without a several-minute network outage.

To change either value, edit `csrf.json` and restart the server.
`readCsrfTunable()` is called on every `createToken()` and `verifyToken()`
so the values are always current on the server side; the client picks
up the new `refreshIntervalMs` on its next scheduled refresh.

**Silent retry on aged-out tokens.** Even with the dedicated refresh
timer, Chrome can throttle a hidden tab's `setInterval` hard enough that
the held token ages past TTL before the next scheduled refresh fires.
`fetchWithCsrf` in `public/dashboard-helpers.js` covers that case: when
a `403` body identifies the token as either `"Expired CSRF token"` or
`"Unknown CSRF token"`, the wrapper refreshes the token and retries the
original request once.

The two reasons share a root cause:

| Server reason | Meaning |
| --- | --- |
| `Expired CSRF token` | Token still in `_issued`, but past `tokenTtlMs`. |
| `Unknown CSRF token` | Token cryptographically valid (issued by this server) but no longer in `_issued` — i.e. expired *and* already pruned by `_pruneExpired` (which runs only when `_issued.size >= 500` and only deletes tokens already past TTL). |

Both must therefore be treated as retryable. Which of the two a stale
token produces depends only on whether `_pruneExpired` happened to have
run, which is a function of total issued-token count and says nothing
about the client. Retrying one and not the other would make recovery
depend on server-side bookkeeping the client cannot observe.

**Retry observability.** Server-side, `handleCsrf` keeps a small ring
buffer of the most recent 403 per `(method, url)` (windowed at 30 s).
When the next successful verify lands on a `(method, url)` in that
buffer, it logs `[csrf] retry succeeded for <METHOD> <url>` —
mirroring the existing
`[csrf] 403 <METHOD> <url> — <reason>` warning so the operator can
confirm from the log that the silent recovery worked. The buffer entry
is cleared on match; a second valid verify is silent.

**Lint enforcement:** The custom ESLint rule
[`9mm/no-fetch-without-csrf`](../eslint-rules/no-fetch-without-csrf.js)
flags any `fetch()` call with a mutating HTTP method (POST, DELETE,
PUT, PATCH) whose `headers` object doesn't contain a
`...csrfHeaders()` spread or an equivalent direct `csrfHeaders()`
assignment. This prevents a developer from adding a new mutating
endpoint that forgets to attach the token — the lint fails the PR before
the code can ship. `eslint-plugin-security`'s
`detect-no-csrf-before-method-override` additionally warns if Express-style
method overriding is ever introduced.

### HTTP Method Allowlist

`server.js` dispatches only `GET`, `POST`, `DELETE`, and `OPTIONS`.
Any other verb (`PUT`, `PATCH`, `TRACE`, etc.) returns a `405 Method
Not Allowed`. The CORS and CSRF checks are written against the four
dispatched verbs, so a verb that reaches a handler without passing
through them would bypass both.

### Path Traversal in Static Serving

`serveStatic()` in `server.js` resolves every request path against
`path.resolve(__dirname, 'public', relative)` and returns `403 Forbidden`
when the result does not start with the `public/` directory, blocking
the classic `../../etc/passwd` escape. All three loopback origins
(`localhost`, `127.0.0.1`, `[::1]`) go through the same guard.

## Authentication & Key Management

### Encryption at Rest

**What the user sees:** After a server restart, the operator
provides their wallet password through one of three methods
(in order of security recommendation):

1. **Dashboard unlock dialog** (default) — open LP Ranger in a
   browser, type the password, click "Unlock."
2. **`--headless` terminal prompt** — run
   `node server.js --headless` and type the password at the
   terminal. Same security as the dashboard (password in memory
   only), no browser needed.
3. **`WALLET_PASSWORD` in `.env`** — fully unattended, for systemd /
   Docker / CI. The password lives on disk as plaintext — least
   recommended (see *Unattended-startup trade-off* below).

Whichever method is used, the same thing happens: the server
decrypts the operator's **private signing key** (stored encrypted
in `app-config/user-configurable/wallet.json` on the server — not in the browser)
and decrypts every **third-party API key** previously saved
(Moralis, Telegram, etc., in `app-config/user-configurable/api-keys.json`). One
password, entered once, brings every secret online for the session.
The password is held only in server memory and discarded when the
process exits.

**How it works:** The encryption is handled by
[`src/wallet-manager.js`](../src/wallet-manager.js) (wallet) and
[`src/api-key-store.js`](../src/api-key-store.js) (third-party API
keys), both backed by the cryptographic primitives in
[`src/key-store.js`](../src/key-store.js). All use the same scheme:

1. **Your password is not stored inside the encrypted files.** The
   encrypted `wallet.json` and `api-keys.json` files contain
   ciphertext, salts, and IVs — but not the password itself.
   Instead, your password is run through a slow, deliberate process
   called **key derivation** — specifically, PBKDF2 (Password-Based
   Key Derivation Function 2) with SHA-512, repeated **600 000
   times** — to produce the encryption key. The slowness is
   intentional: it makes brute-force password guessing impractical
   (this follows OWASP (Open Web Application Security Project) 2023
   guidance). In the default interactive flow, the password exists
   only in the server's memory for the duration of the session and
   is discarded when the process exits. (Operators who need
   unattended startup can optionally store the password in `.env` —
   see *Unattended-startup trade-off* below for the security
   implications of that choice.)
2. **The derived key encrypts your data** using **AES-256-GCM**
   (Advanced Encryption Standard, 256-bit key, Galois/Counter Mode).
   AES-256 is the same encryption standard used by governments and
   banks. The "GCM" part adds tamper detection automatically — if
   anyone modifies the encrypted file (even a single byte), the
   decrypt fails with a hard error rather than producing corrupted
   output.
3. **Each encryption is unique.** A fresh random salt (16 bytes) and
   IV (initialization vector — a one-time starting point for the
   encryption, 12 bytes per NIST (National Institute of Standards
   and Technology) recommendation) are generated every time something
   is encrypted. This means encrypting the same password or key
   twice produces completely different ciphertext — an attacker who
   sees the encrypted file learns nothing about the plaintext by
   comparing it to other encrypted files.

**One password, every secret:** Third-party API keys (Moralis,
Telegram, etc.) are encrypted with the **same wallet password** —
there is no separate "API-keys password" to manage or lose. After
the unlock, the server caches the password in the
`_sessionPassword` module-level variable in
[`src/server-routes.js`](../src/server-routes.js) (line 84) so
subsequent API-key save/reveal operations during the same session
don't re-prompt. The cache is discarded when the process exits.

**Two ways to import the wallet — same password either way:** The
encrypted `wallet.json` file can be created through either of two
workflows, depending on how you run LP Ranger:

- **Through the dashboard** (browser UI) — paste a seed phrase or
  private key into the import dialog. The server encrypts and
  saves it.
- **From the command line** (headless, no browser) — run
  `node scripts/import-wallet.js`, which prompts for a private key
  and a password, then creates the same encrypted `wallet.json`.

Both workflows produce the same file and use the same password.
There is no separate "CLI password" or "dashboard password."

[`src/bot-cycle.js`](../src/bot-cycle.js)'s `resolvePrivateKey()`
picks the signing-key source in fixed priority:
`PRIVATE_KEY` (plaintext hex in `.env` — *not recommended*) →
encrypted wallet unlocked by `WALLET_PASSWORD` env var, `--headless`
terminal prompt, or dashboard dialog.

**Three startup modes:** The modes differ only in how the password
reaches the server — the encrypted files, the decryption process,
and the in-memory handling are identical in all three cases:

| Mode | Command | Password source | On disk? |
| ---- | ------- | --------------- | -------- |
| Dashboard (default) | `node server.js` | Browser unlock dialog | No — memory only |
| `--headless` prompt | `node server.js --headless` | Terminal stdin prompt | No — memory only |
| Unattended | `WALLET_PASSWORD=pw node server.js` | `.env` file | **Yes** — plaintext |

In `--headless` mode, if the wallet can't be unlocked (no password
provided, no `WALLET_PASSWORD` in env, no wallet imported), the
server **exits with an error** rather than falling through to
dashboard-only mode — there is no browser to fall back to.

**Operator responsibilities when using `WALLET_PASSWORD`:**

- Treat `.env` as sensitive. It is already covered by `.gitignore`
  (see `test/gitignore.test.js`), but backup hygiene, file
  permissions, and disk encryption remain operator-side concerns.
- Avoid uncontrolled `.env` copies. Backup utilities, IDE workspace
  archives, and syncthing-style directory replicators can propagate
  stale plaintext passwords long after the live file has been
  rotated.
- When rotating a password, run `npm run reset-wallet` rather than
  editing `.env` by hand — the script scrubs the `WALLET_PASSWORD=`
  line and deletes `app-config/user-configurable/wallet.json` in one step, so the
  next restart forces a fresh import.

**How `reset-wallet` works:** `scripts/reset-wallet.js` (invoked via
`npm run reset-wallet`) performs two idempotent actions:

1. Delete `app-config/user-configurable/wallet.json`.
2. Remove every line matching `^WALLET_PASSWORD=` from `.env` by
   reading the file, filtering out the matching lines, writing to a
   `.tmp` sibling, and atomically renaming. File permissions are
   preserved via `fs.chmodSync` before the rename.

Both steps tolerate missing targets (no error if `.env` is absent or
the line never existed), so the script is safe to run on any system
state. `npm run clean` and `npm run dev-clean` both invoke
`reset-wallet` as their first step, so they also scrub the password
line.

Each service gets its own entry (`{service}Encrypted`) in
`app-config/user-configurable/api-keys.json` with an independently generated salt and
IV, so identical passwords still derive distinct per-entry keys and a
leaked ciphertext for one service reveals nothing about another.

`app-config/user-configurable/wallet.json` and `app-config/user-configurable/api-keys.json` are the only
on-disk homes for these secrets; both are gitignored and protected by
the `app-config/*` glob in `.gitignore`. `test/key-store.test.js`,
`test/key-migration.test.js`, and `test/wallet-manager.test.js` cover
round-trip encrypt/decrypt, wrong-password rejection, and on-disk
format stability.

### In-Memory Handling

Plaintext keys exist only during the narrow decrypt-then-sign window
inside the bot loop. They are never written to disk unencrypted, never
returned by `GET /api/status`, and never included in any log line.

**Lint enforcement:** The custom ESLint rule
[`9mm/no-secret-logging`](../eslint-rules/no-secret-logging.js) flags
any `console.log/warn/error/info` call that references an identifier,
member expression, or template-literal expression whose name matches
`/private.?key|mnemonic|seed.?phrase|password|secret|signing.?key/i`.
String literals ("Loading private key...") are allowed because they
cannot leak a real value. The rule ships via `eslint-security.config.js`
and runs under `npm run audit:security`.

### Secret Scanning

- **`secretlint`** (`npm run audit:secrets`) scans `src/**/*.js`,
  `server.js`, `bot.js`, `.env*`, and `*.json` with the
  `@secretlint/secretlint-rule-preset-recommend` preset, which covers
  AWS, GCP, GitHub, Slack, and generic private-key patterns.
- **`eslint-plugin-no-secrets`** (wired into
  `eslint-security.config.js`) adds entropy-based detection
  (`tolerance: 4.5`, `additionalDelimiters: ['0x']`) so novel-format
  API keys that the preset misses still surface as warnings.

### Gitignore Enforcement

`test/gitignore.test.js` asserts that `.gitignore` covers `.env`,
`.env.*`, `*.keyfile.json`, the `app-config/*` glob, and the
`app-data/*` glob, while explicitly un-ignoring `.env.example`,
`app-defaults-for-user-configurable/`, `user-configurable/` (plus its
tracked `README.md`), and `app-data/README.md`. If a contributor
deletes one of those ignore lines, the test fails before the unsafe
change can merge.

## Cryptographic Primitives

Getting encryption wrong is one of the easiest ways to create a
vulnerability that looks secure but isn't. A home-grown cipher, a
reused random value, or a non-authenticated encryption mode can each
silently undermine everything the rest of the security architecture
provides. LP Ranger avoids these pitfalls by using only established
primitives and never inventing its own.

### No Custom Crypto

All cryptographic operations call Node's built-in `crypto` module —
`pbkdf2`, `createCipheriv('aes-256-gcm')`, `randomBytes`. The app
never implements its own hash, cipher, or MAC (message authentication
code). The external `csrf`
package (pillarjs, widely deployed behind Express) is the single
dependency chosen to compose cryptographic tokens.

### Authenticated Encryption

AES-**GCM** (not CBC (Cipher Block Chaining)) is used everywhere so
ciphertext integrity is verified as part of decryption. Swapping to
an unauthenticated mode (CBC, CTR (Counter mode) without HMAC
(Hash-based MAC)) would make padding-oracle or bit-flip attacks
feasible, even against a local adversary with read access to
`app-config/`.

### Secure Randomness

All random material (PBKDF2 salt, AES-GCM IV, CSRF secret) comes from
`crypto.randomBytes()`. `Math.random()` is statistically biased and
predictable; using it for a salt or IV would reduce encryption strength
to the PRNG's (pseudorandom number generator) state-recovery
complexity.

**Lint enforcement:** `eslint.config.js` registers a
`no-restricted-syntax` pattern that bans
`Math.random()` calls project-wide with the message *"Use
crypto.randomBytes() instead of Math.random() — not cryptographically
secure."* The security lint's `security/detect-pseudoRandomBytes` rule
is also enabled as a second line of defense, catching calls to the
deprecated `pseudoRandomBytes` API.

## Input Validation & Data Modeling

Every piece of data that arrives from the outside — a config change
from the dashboard, a wallet address from a URL, a position identifier
from a deep link — must be validated before it touches internal state.
Accepting malformed or unexpected input is how bugs become
vulnerabilities: a garbled position key could route a rebalance to the
wrong pool, and an unvalidated config field could overwrite internal
bookkeeping.

### Composite Key Parsing

LP Ranger manages multiple positions simultaneously, so every
position-specific API call must identify **which position** it's
acting on. The identifier is a composite key — a dash-separated
string like
`pulsechain-0x1111111111111111111111111111111111111111-0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2-157149`
that encodes
the blockchain name, wallet address, the contract address of the
liquidity pool provider's NFT factory, and NFT token ID. A malformed or missing key could route a config change,
a rebalance, or a stop command to the wrong position — or to no
position at all.

`parseCompositeKey()` in
[`src/bot-config-v2.js`](../src/bot-config-v2.js) validates the
format: exactly four dash-separated parts, with `0x`-prefixed wallet
and contract fields. If the key is missing or doesn't match, the
route handler returns `400` immediately. This applies to every
position-specific route (`POST /api/config`,
`DELETE /api/position/manage`, `POST /api/rebalance`,
`POST /api/compound`).

### Config Key Allowlist

When the dashboard saves a setting — say the user changes their
slippage tolerance from 0.5% to 0.75% — the browser sends a JSON
body like:

```json
{
  "slippagePct": 0.75,
  "positionKey": "pulsechain-0x1111111111111111111111111111111111111111-0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2-157149"
}
```

to `POST /api/config`. A naive handler that merged every field from
that body into the config object would let an attacker inject
unexpected keys (for example, overwriting `status` to mark a
position as stopped, or polluting internal bookkeeping fields).

LP Ranger prevents this with a strict `allowlist`. The route handler
in `src/server-routes.js` walks two hardcoded arrays —
`GLOBAL_KEYS` (gas strategy, RPC URLs, etc.) and `POSITION_KEYS`
(slippage, threshold, timeout, auto-compound settings, etc.) defined
in `src/bot-config-v2.js` — and copies only those recognized names
from the request body. Every other field is silently dropped. Because
the `allowlist` is a constant inside server code (never derived from
user input), the bracket access `diskConfig[k]` that merges each
field is safe — which is why `eslint-plugin-security`'s
`detect-object-injection` rule is disabled with a documented reason
in `eslint-security.config.js`.

### Checksummed Addresses

Every wallet and contract address is normalized through ethers'
`getAddress()` (EIP-55 (Ethereum Improvement Proposal 55)
checksumming) before it becomes part of a
composite key or cache filename. Case-variant addresses therefore
cannot produce duplicate state entries or cache poisoning.

### BIP-39 Seed Validation

Wallet import via seed phrase validates against the BIP-39 (Bitcoin
Improvement Proposal 39) word list
before key derivation runs, rejecting typos and near-matches with a
clear error rather than silently deriving a wrong key.

## Injection Prevention

Injection attacks trick a program into treating data as code. For
example, if a server builds a database query by pasting user input
directly into the query string, an attacker can type SQL commands
instead of a name and take over the database. LP Ranger doesn't use
a database, but the same class of attack applies to JavaScript's
`eval()` (which executes arbitrary code), `child_process` (which
runs shell commands), and `require()` (which loads modules). The
security lint flags any use of these that could accept untrusted
input.

### `eval` / `child_process` / Dynamic `require`

`eslint-plugin-security` runs in `npm run audit:security` and warns on
`detect-eval-with-expression`, `detect-child-process`, and
`detect-new-buffer`. `detect-child-process` exists because spawning
subprocesses with attacker-controlled arguments is a classic
command-injection vector. The stop path's `child_process` use is the
`lsof` / `ps` port-lookup in `scripts/_find-process.js` (reached from
`scripts/stop.js`'s no-PID-file fallback); its command and arguments are
hardcoded constants with no user input reaching them. The rule stays on
so that any future `spawn` / `exec` call is flagged for review.

Two `eslint-plugin-security` rules are disabled in
`eslint-security.config.js`:

| Rule | Why disabled |
| ---- | ------------ |
| `detect-object-injection` | Bracket access on config objects is intentional; keys come from server-owned `GLOBAL_KEYS` / `POSITION_KEYS` arrays, never from the request body. Any key not in these allowlists is silently dropped before the bracket write. |
| `detect-non-literal-fs-filename` | See detailed explanation below. |

All other `eslint-plugin-security` rules — including
`detect-non-literal-require`, `detect-eval-with-expression`,
`detect-child-process`, `detect-possible-timing-attacks`,
`detect-pseudoRandomBytes`, and `detect-new-buffer` — are enabled
at `warn` severity.

**Why `detect-non-literal-fs-filename` is off:** This rule flags
every `fs` call where the path argument is a variable rather than a
string literal. In a web application that passes user input to
`fs.readFileSync()`, that's a real vulnerability — an attacker
could read `/etc/passwd` or overwrite system files. But LP Ranger
is a local-only Node server where **no user input ever reaches any
filesystem path**. Every `fs` call uses computed paths built from
`__dirname`, `path.join(cwd, CONSTANT)`, `os.tmpdir()`, or
server-owned config-scoped filenames.

The rule cannot distinguish `path.join(__dirname, "app-config",
"chains.json")` from `path.join(cwd, userInput)` — it flags both
identically. With the rule enabled, the codebase produces **~90
warnings** across `src/`, `scripts/`, and `server.js`. Suppressing
each one with a per-line `eslint-disable-next-line` directive would
add 90 noise lines without improving security, because the
underlying condition — user-controlled paths reaching `fs` — does
not exist in this architecture. The actual defense against
filesystem-escape attacks is the `serveStatic()` path-traversal
guard (see [Path Traversal in Static Serving](#path-traversal-in-static-serving)
above), which operates at the HTTP route level, not at individual
`fs` call sites.

### Prototype Pollution

Modifying a built-in's prototype — e.g. `String.prototype.fooBar =
function myAttack() {...}` — lets an attacker change the behavior of
every string (or array, or object) in the running process from a
single assignment. ESLint's built-in `no-extend-native` rule blocks
this pattern at lint time, so any such assignment fails CI before it
can be merged. The rule is enabled in `eslint.config.js`'s shared
rules and applies to every file the linter sees.

### XSS (Cross-Site Scripting) / DOM Safety

The dashboard's rendered HTML is built from trusted sources only: the
Uniswap v3 SDK's numeric output, server JSON, on-chain event data, and
user-entered amounts that are either numeric or already-validated
addresses. There is no external script tag in
`public/index.html` — fonts are self-hosted via `@fontsource`, and the
only bundled JavaScript is `public/dist/bundle.js` produced by esbuild
from the audited `public/dashboard-*.js` sources. Copy-to-clipboard
operations use `textContent`, never `innerHTML`, so pasted wallet
addresses cannot be reflected as executable markup. The custom rule
[`9mm/no-interpolated-innerhtml`](../eslint-rules/no-interpolated-innerhtml.js)
blocks any new `innerHTML` / `outerHTML` / `insertAdjacentHTML`
assignment whose right-hand side is an interpolated template literal
or a `+`-concatenated string — the specific sink patterns that turn
untrusted data into executable markup. Static string literals and
trusted-constant references (e.g. the disclosure HTML) remain
allowed, since those carry no attacker-controlled input.
`html-validate` (run as part of `npm run lint`) enforces structural
HTML correctness on every commit.

## Filesystem Safety

LP Ranger reads and writes files — config, caches, encrypted keys —
so it's important that an attacker can't trick it into reading or
writing files outside its own directory (for example, reading
`/etc/passwd` or overwriting a system file).

Every `fs.readFileSync` / `fs.writeFileSync` call in `src/` resolves
its path via `path.join(process.cwd(), CONSTANT)` — no user-controlled
path component ever reaches the filesystem layer. Atomic writes
(`.tmp` + `rename`) prevent partial-file corruption from an interrupted
shutdown. The static-file serving guard (described in **Path Traversal
in Static Serving** above) provides the equivalent protection on the
inbound side.

## On-Chain / Transaction Security

LP Ranger's core job is sending blockchain transactions — removing
liquidity, swapping tokens, minting positions. Each of these
transactions costs real money (gas fees), moves real funds, and is
irreversible once confirmed. A stuck transaction, a duplicated
transaction, or a swap executed at a bad price can all cause financial
loss. The controls in this section protect the transaction pipeline
itself.

### Nonce Serialization

A single async-mutex rebalance lock in
[`src/rebalance-lock.js`](../src/rebalance-lock.js) serializes every
transaction across every managed position. Only one position signs at a
time (same wallet = same nonce). The lock has no timeout because
blockchains can hold a TX pending for days — a timeout would free the
lock while the nonce is still occupied and cause every subsequent TX to
fail with "could not replace existing tx." The holder runs the TX
recovery pipeline to completion before releasing.

### TX Recovery Pipeline

`_waitOrSpeedUp()` in `src/rebalancer.js` wraps every `tx.wait()` in a
four-phase pipeline: **wait → speed-up (1.5× gas) → wait → auto-cancel
(0-PLS self-transfer)**. Stuck nonces therefore always free themselves
within `TX_CANCEL_SEC` (default 60 min) instead of blocking the wallet
indefinitely. Every phase logs its state so post-mortem analysis of a
stuck TX is deterministic.

### RPC Failover

All TX-sending paths route through
[`src/send-transaction.js`](../src/send-transaction.js), which holds
both the primary and fallback providers built at boot. On `estimateGas`
failure against the primary, the module retries against the fallback;
on success it engages a sticky one-hour failover window so subsequent
broadcasts, receipts, and nonce lookups also flow through the fallback.
The window self-heals — `getCurrentRPC()` reverts to primary once the
timer expires. Broadcast failover requires the signer to be a
`FailoverNonceManager` that lazily rebinds on RPC change. No-op when
the configured primary and fallback URLs are identical.

Reads use the same window. `getManagedReadProvider()` returns a Proxy
that delegates each call to `getCurrentRPC()` and retries failover-
eligible errors (`SERVER_ERROR`, `TIMEOUT`, `NETWORK_ERROR`, 5xx) via
`failoverToNextRPC()`. Boot reachability is `ensureReachable()`. One
sticky failover state covers both sides.

### Slippage Guards

Swap `amountOutMinimum` is derived from a `staticCall` quote
(`_checkSwapImpact()` in `src/rebalancer-pools.js`), not spot price. If
the quoted price impact exceeds the user's slippage setting, the swap
aborts and the bot pauses until the user resolves the condition. This
prevents low-liquidity pools or aggressive aggregator routes from
silently draining the position on a single TX.

### Swap Gates (Dust + Gas)

Every swap call site (initial rebalance swap, post-swap corrective loop,
and the new ratio-correcting compound swap) routes through a single
helper, `shouldSkipSwap()` in [`src/swap-gates.js`](../src/swap-gates.js).
Two gates run in a fixed order:

1. **Dust gate (first).** Skip when the swap value (in USD) is below the
   gold-pegged dust threshold. The dust gate runs first because a failure
   there is cheaper and more reliable to detect than the gas-gate, and a
   dust-skip short-circuits the more expensive gas estimate. Running dust
   first also minimises the latency between the gas-price read and the
   actual swap broadcast: when dust skips the swap entirely, no gas read
   happens at all, and when dust passes, the gas read is the very next
   step — so any drift in the gas-price between the read and the swap
   submission is kept as small as possible.
2. **Gas gate.** Skip when estimated gas cost exceeds **1%** of the swap
   value. The threshold is exposed as a module-level
   `MAX_SWAP_GAS_RATIO = 0.01` so every consumer references the same
   constant. Comparison is strict `>`, so a ratio of exactly 1% still
   passes.

When either gate trips, the caller proceeds without swapping. For
rebalance, that means minting with the unswapped balances and letting
the corrective loop or the post-rebalance residual sweep handle any
leftover. For compound, that means depositing only the side that fits
the current tick ratio and tracking the rest as a wallet residual to be
folded back in on the next rebalance.

The gas estimate uses `provider.getFeeData()` × a configurable swap-gas
units estimate (`config.CHAIN.aggregator.estimatedSwapGasUnits`,
default 500_000). When `getFeeData()` throws or returns nothing usable,
`estimateSwapGasUsd()` returns 0 — the gas gate degrades to a no-op
rather than blocking swaps on a flaky RPC.

### Atomic Multicall

The 9mm Pro `NonfungiblePositionManager` requires
`decreaseLiquidity` and `collect` to execute atomically — between them,
any other transaction could reprice or front-run the liquidity that was
just accounted for.

**Lint enforcement:** The custom ESLint rule
[`9mm/no-separate-contract-calls`](../eslint-rules/no-separate-contract-calls.js)
(configured with the pair `[["decreaseLiquidity", "collect"]]`) walks
each function scope and errors if both calls appear as separate
`await`ed transactions. Wrapping them inside `encodeFunctionData(...)`
for `multicall` is recognized as the safe pattern and exempted. Any new
atomic pair can be added to the rule's `pairs` option in one line.

### BigInt Precision

EVM (Ethereum Virtual Machine) token amounts in 18-decimal tokens
routinely exceed JavaScript's
2⁵³ integer precision. Silent truncation there would under-report
balances and, worse, under-request minimum-out in swap calldata.

**Lint enforcement:** The custom ESLint rule
[`9mm/no-number-from-bigint`](../eslint-rules/no-number-from-bigint.js)
blocks unsafe casts *from* a BigInt *to* a JavaScript `Number`. The
BigInt is the value being cast — it holds the full-precision integer
returned from an on-chain read (wei amounts, pool liquidity, reserve
balances). The rule flags the four JavaScript constructs that perform
this cast: `Number(x)`, `parseFloat(x)`, `parseInt(x)`, and unary `+x`.

To tell which variables hold such a BigInt without requiring a
full type inference, the rule matches variable *names* against the
regex `/^(liquidity|rawBalance|reserve[s]?|weiAmount)$/i`. These are
the four names this codebase uses by convention for wei-scale BigInts
straight from the chain. Casting any of them silently rounds the
value to the nearest IEEE-754 double — under-reporting balances and,
worse, under-requesting minimum-out in swap calldata — so the rule
errors at lint time.

The correct pattern is to keep the BigInt through all arithmetic and
only convert at the very end, after scaling down with
`ethers.formatUnits(bigint, decimals)` (which returns a decimal
string) and then calling `parseFloat` on that string. Per-line
`eslint-disable-next-line` directives are allowed only with a
`-- Safe: <reason>` comment documenting why float math is acceptable
at that call site (currently: three sites doing approximate
sqrtPrice display math).

## Supply Chain & Dependencies

LP Ranger depends on third-party npm packages for cryptography, EVM
(Ethereum Virtual Machine) math, and other core functions. A
compromised package — one where an attacker publishes a malicious
update — could steal your private key at runtime without changing a
single line of LP Ranger's own code. This section describes how the
dependency surface is kept small, audited, and pinned so that known-
good versions can't be silently replaced.

### Reputable-Package Philosophy

LP Ranger deliberately prefers well-vetted npm packages over in-house
implementations for every security-sensitive concern: `csrf` for
tokens, `ethers` for EVM math and checksumming, `async-mutex` for the
rebalance lock, `@uniswap/v3-sdk` + `jsbi` for exact sqrtPrice
arithmetic, and `navigo` for client-side routing. The reasoning is
that rolled-in-house crypto or lock implementations are almost always
worse than the widely-deployed alternative, and a CVE (Common
Vulnerabilities and Exposures advisory) in a popular package is
discovered and patched far faster than one in a one-off module. The
`"dependencies"` block in `package.json` is intentionally
small (9 packages) so the review surface stays tractable.

When a transitive dependency has a known issue, the first response is
to **delete `package-lock.json` and regenerate it** (`npm install`).
Stale lockfiles pin old transitive versions even when the parent's
caret range already accepts the fix — most advisories resolve this
way without any code change. `"overrides"` in `package.json` are a
last resort, used only when the parent's declared range genuinely
excludes the patched version (e.g. an exact pin like `"1.0.0"`).

### Pinned Production Releases

End-user installs are a **supply-chain security boundary**. The
release workflow in `.github/workflows/release.yml` rewrites every
entry in `package.json` from a caret range (e.g. `"csrf": "^3.1.0"`)
to an exact version (`"csrf": "3.1.0"`), reading the version to pin
from the resolved entries in `package-lock.json` — so the pinned
`package.json` captures the exact tree that `main` was tested
against, not whatever the caret range might newly resolve to at
release time. The workflow then regenerates
`package-lock.json` against the pinned `package.json` with
`--ignore-scripts`, writes an `.npmrc` with `save-exact=true`, and
ships a prebuilt `public/dist/bundle.js` so the end user's machine
never runs esbuild on potentially-compromised source. The tarball
users download from GitHub Releases is therefore byte-identical
across installs on the same tag.

The install instructions in [`README.md`](../README.md) mandate
`npm ci` (not `npm install`) — `npm ci` verifies the lockfile's
integrity hashes, refuses to mutate the lockfile, and deletes any
stray `node_modules` before installing. Combined, these steps close
off three concrete supply-chain attack classes: compromised newer
versions (like the `event-stream` / `ua-parser-js` / `colors.js`
pattern), transitive typosquatting/version confusion, and
reproducibility drift between the graph the maintainer tested and
the graph the user receives. See
[Dependency Management](engineering.md#dependency-management) for the full release
workflow, lockfile controls, lifecycle-script handling
(`--ignore-scripts` usage), and inventory of runtime vs devDependency
packages.

### `npm audit`

`npm run audit:deps` runs `npm audit --audit-level=high --json` and
writes the full report to
`test/report-artifacts/raw-data/npm-audit.json`. The threshold is
`high` so pre-existing moderate advisories don't fail CI, but the
severity breakdown (critical / high / moderate / low / info) is
displayed in the check-report summary and PDF on every run so nothing
moderate sits unnoticed for long.

One known ecosystem-wide advisory is accepted rather than patched: the
`elliptic` package (reachable transitively through `@uniswap/v3-sdk`)
carries a long-standing timing-side-channel finding in its ECDSA
(Elliptic Curve Digital Signature Algorithm) signing path. The advisory has no fix available from the upstream
maintainer, and the vulnerable function is not on any code path we
exercise — LP Ranger uses `ethers` for wallet signing, not
`@uniswap/v3-sdk`'s internal ECDSA helpers. The residual risk is
accepted here rather than patched in-house because override-forking
`elliptic` would fork every Uniswap SDK consumer that depends on it.
The advisory is re-checked on every release; if a fix lands upstream,
a lockfile regeneration or (if needed) an override is the path to
pin the update.

### CI Enforcement

The security audits run as three independent jobs in
`.github/workflows/security-audit.yml` (`audit:deps`, `audit:security`,
`audit:secrets`) so each one can be individually required in branch
protection. All three also run locally under `npm run check`.

## Runtime Hardening

Even with good architecture, a running process can fail in ways that
either crash silently (hiding bugs) or stay alive in a broken state
(hiding worse bugs). These measures ensure the process fails loudly
on real errors, shuts down cleanly when asked, and doesn't leave
transactions hanging.

### Strict Mode Everywhere

`"use strict"` is required at the top of every source and test file,
enforced by ESLint's `strict: ["error", "global"]` rule. This eliminates
silent global-variable creation, accidental octal literals, and other
non-strict footguns.

### Error Guard

[`src/server-error-guard.js`](../src/server-error-guard.js) installs
`uncaughtException` and `unhandledRejection` handlers that downgrade
transient RPC errors (`TIMEOUT`, `NETWORK_ERROR`, `SERVER_ERROR`) to a
non-fatal warning but still crash the process on any other uncaught
error, so real bugs are never silently swallowed.

### Graceful Shutdown

`POST /api/shutdown` (CSRF-protected like every other mutating route)
calls `positionMgr.stopAll()` and then exits cleanly so nonces are not
left hanging — a programmatic shutdown option. The usual operator path is
`npm stop`, which sends SIGTERM to the PID in `tmp/lp-ranger.pid` (the same
`shutdown` handler as Ctrl+C); see the "Build and Run" section.

## Code Review Controls

Security bugs hide most easily in large, complex files that no single
reviewer can hold in their head. The rules in this section keep files
small and functions simple, so every change is reviewable — and
enforce that security-sensitive deviations are documented rather than
silently introduced.

The `max-lines: 500` (skipBlankLines, skipComments) and
`complexity: 17` ESLint rules keep every file and function small
enough that a human reviewer can hold the whole control flow in their
head. Files that exceed the limits must be split — they cannot be
silenced with `eslint-disable`, because `reportUnusedDisableDirectives`
is configured to flag any stray directive that doesn't suppress a
real warning. Custom security rules (`9mm/no-secret-logging`,
`9mm/no-number-from-bigint`) may use per-line
`eslint-disable-next-line` **only** with a `-- Safe: <reason>`
comment documenting why the deviation is intentional. Current
exceptions:

| File | Line | Rule | Reason |
| ---- | ---- | ---- | ------ |
| `src/hodl-baseline.js` | 37 | `9mm/no-number-from-bigint` | Approximate float math for sqrtPrice display |
| `src/range-math.js` | 294 | `9mm/no-number-from-bigint` | Approximate float math for sqrtPrice display |
| `src/position-detector.js` | 169 | `9mm/no-number-from-bigint` | Zero-check only |

Whole files are never excluded from linting. Every exception is a
single `eslint-disable-next-line` comment. It sits on the exact line
that needs it. It must carry a `-- Safe: <reason>` note explaining
why.

A few paths do bypass ESLint. Generated and third-party output is
skipped: `node_modules/`, `coverage/`, `public/dist/`, and
`*.min.js`. The two hand-authored HTML files — `public/index.html`
(the dashboard) and `public/help-and-user-manual.html` (the user manual) — are also
outside ESLint's scope, but that's because they're markup, not
JavaScript. They aren't left unchecked. Both are linted by
`html-validate` as part of `npm run lint`.

ESLint runs in two passes against the same source files. Each pass
uses a different config. Other lint tools run alongside, including
stylelint, html-validate, markdownlint-cli2, and secretlint. Those
are separate programs. "Two passes" here refers only to ESLint.

The main pass is invoked as part of `npm run lint`. It uses
`eslint.config.js`. It enforces code-quality and non-security rules.
The full set: `complexity <= 17`, `max-lines <= 500`,
`max-len <= 80`, `no-unused-vars`, `no-var`, `prefer-const`,
`eqeqeq`, `strict`, `no-extend-native`, a `no-restricted-syntax`
ban on `window.*` assignment and `Math.random`, plus the custom
rules `9mm/no-separate-contract-calls` and
`9mm/no-fetch-without-csrf`.

The security pass runs via `npm run audit:security`. It is driven
by `eslint-security.config.js`. This pass is what actually enforces
the security rules. Those rules come from three sources:
`eslint-plugin-security`, `eslint-plugin-no-secrets`, and the custom
`9mm/no-secret-logging` / `9mm/no-number-from-bigint`. This pass
is also what decides whether a per-line exception stands.

The main config does one slightly odd thing to make this two-pass
setup work. It loads `eslint-plugin-security` without enabling any
of the plugin's rules.

First, some terminology. "Loading" a plugin means telling ESLint the
plugin exists. That in turn registers the names of every rule the
plugin provides. After that, ESLint knows what
`security/detect-unsafe-regex` refers to. "Severity" is a separate
concept. Severity lives on individual rules. It decides whether a
rule actually produces errors or warnings. A rule can be known to
ESLint but have no severity set. In that case it simply doesn't
fire.

Two security rules are pinned to severity `off` in the main config:
`security/detect-unsafe-regex` and
`security/detect-possible-timing-attacks`. Those are the two rules
referenced by per-line directives in this repo. The rest of the
plugin's rules are unconfigured there — which is also effectively
off.

Why load the plugin at all if none of its rules will fire? Because
of the disable directives. Developers write
`eslint-disable-next-line security/detect-unsafe-regex -- Safe: ...`
comments in the source code. Those comments are meant for the
security pass. But the main pass reads the same files and sees them
too. If the main pass didn't recognize the rule name, it would
error out with "Definition for rule not found."

The fix is to load the plugin and not enable the rules. The main
pass now recognizes every rule name. It sees the disable comment,
does nothing with it, and moves on.

The security pass is different. There, the rules are turned on.
Every rule listed in `eslint-security.config.js` is set to severity
`warn`. The `npm run audit:security` command passes
`--max-warnings 0`, which turns each warning into a build failure.
So a security finding is effectively an error in CI.

This is where the per-line disable directive earns its keep. Every
so often a rule flags code that looks dangerous but is actually
safe in context. Two examples from this repo: `detect-unsafe-regex`
firing on a regex that only ever runs against a known local file,
and `detect-possible-timing-attacks` firing on a string comparison
that confirms two copies of a user-entered password rather than
verifying a secret against a stored value. In those cases a false
positive would block the build. The directive tells the security
pass to skip that one line, and the `-- Safe: <reason>` comment
explains why it's safe. The rule stays on for the rest of the file
and the rest of the codebase.

### Build and Infrastructure Scripts

The `scripts/` directory contains 15 Node modules that drive the
build pipeline (`build-info.js`, `cache-bust.js`), the check/report
pipeline (`check.js`, `check-report.js`, `check-report-parse.js`,
`check-report-pdf.js`, `check-report-md.js`), font management
(`copy-fonts.js`), state management (`wipe-settings.js`,
`restore-settings.js`, `reset-wallet.js`), server lifecycle
(`stop.js`), and auxiliary tools (`api-doc.js`,
`clear-pool-cache.js`, `telegram-send.js`). All 15 are subject to
the **same checks** as application source code:

- **ESLint (main)** — `scripts/**/*.js` is in the section 1 file
  list and section 3 Node-source config, so every script is held
  to the same `complexity <= 17`, `max-lines <= 500`, `strict`,
  `no-var`, `eqeqeq`, `prefer-const`, and `no-restricted-syntax`
  (Math.random ban) rules as `src/` and `server.js`.
- **Security lint** (`eslint-plugin-security` +
  `eslint-plugin-no-secrets` + custom `9mm/*` rules) — the
  `eslint-security.config.js` `files[]` array includes
  `scripts/**/*.js`, and `npm run audit:security` runs
  `scripts/audit.js --security` over `SECURITY_TARGETS` from
  `scripts/lint-targets.js`.
- **Secret scanner** (`secretlint`) — `npm run audit:secrets` runs
  `scripts/audit.js --secrets` over `SECRET_TARGETS` from the same
  file.
- **Prettier** — `format` and `format:check` both run
  `scripts/format.js`, which reads the one target list in
  `scripts/lint-targets.js`; `npm run lint` calls `format:check`, and
  the pre-commit hook runs `npm run lint`.

The `eslint-plugin-security` plugin is loaded in the main ESLint
config — the same loaded-but-silent pattern described in detail
above. Loading the plugin is what registers every one of its rule
*names* so that a per-line `// eslint-disable-next-line
security/detect-unsafe-regex` directive doesn't trip the main lint
pass with "Definition for rule not found." Two of the plugin's rules
are additionally pinned to severity `off` in the main config
(`security/detect-unsafe-regex` and
`security/detect-possible-timing-attacks`) because those are the two
rules actually referenced by per-line directives in the repo; the
rest of the plugin's rules aren't listed in the main config at all
and remain unconfigured (effectively `off`) there. (Strictly speaking,
a plugin is loaded, and severity lives on individual rules. Phrases
like "the plugin is registered at `off`" are shorthand.) The
security pass (`eslint-security.config.js`) loads the same plugin
with each rule set to `warn` — that's the pass in which the
directives actually suppress findings.

Four such directives currently exist in `scripts/`:

| File | Line | Rule | `-- Safe:` reason |
| ---- | ---- | ---- | ----------------- |
| `scripts/cache-bust.js` | 14 | `security/detect-unsafe-regex` | Input is local `index.html`, not user-supplied |
| `scripts/cache-bust.js` | 16 | `security/detect-unsafe-regex` | Input is local `index.html`, not user-supplied |
| `scripts/check-report-parse.js` | 183 | `security/detect-unsafe-regex` | Input is deterministic TAP v14 from `node --test` |
| `scripts/import-wallet.js` | 98 | `security/detect-possible-timing-attacks` | Comparing two user-entered password strings for confirmation, not verifying a secret |

This means a compromised or careless infrastructure script cannot
silently bypass the same quality and security gates that protect
the application code — there is no "scripts are just tooling"
carve-out.

### GitHub Actions Workflows

The `.github/workflows/*.yml` files that drive CI are themselves
held to two `npm run check` gates: Prettier `--check` for shape and
formatting, and `actionlint` for workflow correctness. The
`actionlint` binary is installed as a devDependency
(`github-actionlint`, an npm wrapper that downloads the official
`rhysd/actionlint` Go binary at install time) so that every check
run on every developer machine and in CI uses the same pinned
version. There are no rule-selection knobs — actionlint runs its
full default rule set on every workflow file, and any new finding
fails `npm run check`.

The security-relevant checks actionlint performs are:

- **Script-injection detection** — flags `${{ ... }}` expressions
  containing untrusted inputs (e.g. `github.event.issue.title`,
  `github.head_ref`, PR body, branch names) interpolated directly
  into a `run:` block. This is the standard GitHub Actions
  command-injection vector: an attacker who controls a PR title
  could inject shell metacharacters that execute on the runner with
  whatever permissions the workflow has. actionlint forces the
  workflow to route untrusted input through an environment variable
  instead, where shell quoting is the runner's job, not the YAML
  templater's.
- **Hardcoded credentials** — flags plaintext secrets in
  `services:` and `container:` configurations (database passwords,
  registry credentials), pushing them through `${{ secrets.* }}`
  instead.
- **Permissions and `GITHUB_TOKEN` scope sanity** — surfaces
  workflows that grant broader token permissions than the steps
  appear to need.

Beyond security, actionlint also catches the everyday workflow
bugs that would otherwise only surface as a red CI run: unknown
context fields, invalid `runs-on:` labels, broken `needs:`
references, malformed cron expressions, deprecated action versions,
and YAML syntax that GitHub will silently accept but never execute
correctly. Catching these in `npm run check` instead of in CI keeps
the feedback loop local and prevents a broken-workflow commit from
reaching `main`.

## Test-Time State Protection

`scripts/check.js` backs up every top-level file in `app-config/`
(plus `tmp/*.json`) to a `mktemp -d` directory, wipes the live files,
runs the test suite against vanilla state, and restores the originals
via an `EXIT` trap. This prevents a test that creates a stub config or
keyfile from ever clobbering live user state, and it means a test that
believed it had written to `app-config/user-configurable/wallet.json` was actually
writing to a scratch copy. Tests that need explicit paths instead use
the `WALLET_FILE_PATH` / `API_KEYS_FILE_PATH` environment variables or
pass a `dir` argument to `loadConfig` / `saveConfig` directly.
