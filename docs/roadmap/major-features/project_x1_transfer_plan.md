# X1 (Solana-Fork) Port

A sibling project targeting the **X1 Blockchain** — a
highly-modified fork of Solana that keeps the unmodified SVM. This
document captures the layered transfer strategy for porting LP
Ranger's standards and practices.

## Layer 1 — Verbatim transfer (copy, don't rethink)

Chain-neutral; lift directly:

- `CLAUDE.md` + `docs/claude/*` framework (CI, code-style,
  best-practices, testing, security, disclosures). Only
  chain-specific examples inside get swapped.
- Tooling: ESLint flat config (complexity ≤17, max-lines ≤500, no
  disables, `--max-warnings 0`), stylelint, Prettier, husky +
  lint-staged, knip, secretlint, `scripts/check.js`, security-lint
  runner.
- CI: GitHub Actions lint → test matrix; merge protocol;
  `npm run check` gate; `--merge` (no squash).
- Dashboard scaffold: esbuild IIFE bundle, modular
  `dashboard-*.js`, self-hosted fonts, namespaced utility CSS, no
  inline styles / no `!important` / no `zoom`, html-validate,
  markdownlint with `<p>/<em>/<strong>` allowance, template-based
  row rendering.
- Cross-cutting patterns: atomic config writes (tmp+rename),
  AES-256-GCM + PBKDF2 wallet wrap, disk cache with TTL + scoped
  filenames, epoch cache keyed by pool identity (survives
  re-mints), composite keys for per-position scoping, throttle +
  daily cap + doubling, P&L tracker, HODL baseline for IL/G,
  residual tracker, rebalance lock (async-mutex), Telegram
  notifications, dry-run mode, headless vs. dashboard mode,
  password unlock, Navigo-style deep-links.

## Layer 2 — Adapt with swap-outs (same intent, different library)

- Chain SDK: ethers v6 → `@solana/web3.js` (or `@solana/kit`).
- On-chain math: `@uniswap/v3-sdk` → Orca
  `@orca-so/whirlpools-sdk` (if Whirlpool-style), Raydium SDK, or
  bespoke module if X1 ships its own CLMM.
- Aggregator: 9mm aggregator → Jupiter (if it runs on X1) or
  X1-native aggregator.
- Price sources: DexScreener + GeckoTerminal → DexScreener (covers
  Solana), Birdeye, Helius, Jupiter Price API.
- Moralis → **Helius** is the Solana-native analog.
- ABI management (`pm-abi.js`) → IDL files (Anchor) or Borsh
  schemas.
- Custom ESLint rule `no-separate-contract-calls` → analog
  enforcing **single-TX instruction bundling** (SVM bundles ~64 ix
  natively; CPIs not multicall).
- Address rules: EIP-55 checksum → base58 validation +
  `PublicKey.isOnCurve`. Replace "no gwei in prose" with "no
  lamports in prose" (native SOL + USD).

## Layer 3 — Same intent, substantial rewrite

- **TX lifecycle & speed-up**: EVM nonce-and-gas-bump → Solana has
  no user nonce (for regular TXs); blockhash expires ~150 slots
  (~60–90s). "Speed up" = resend with fresh blockhash + higher
  priority fee. "Cancel stuck" = let blockhash expire (no
  self-transfer).
- **Rebalance lock**: still serialize per-wallet, but to avoid
  priority-fee wars against self and stay under compute-budget
  limits.
- **Event scanner**: `eth_getLogs` block-chunking →
  `getSignaturesForAddress` + paginated `getTransaction`, or
  **WebSocket `logsSubscribe`/`programSubscribe`** for live. WS may
  replace polling entirely — big simplification.
- **Quote-based slippage**: `staticCall` → `simulateTransaction`
  (returns logs + CU). Same "apply slippage to quoted output, not
  spot price" discipline.
- **Multicall atomicity**: EVM `multicall` → native SVM single-TX
  bundling. Watch 1232-byte limit (use ALTs + v0 TXs for complex
  rebalances).
- **RPC fallback**: EVM `createProviderWithFallback` +
  `getFeeData` patch → Solana RPC fallback with
  `getRecentPrioritizationFees` + compute-budget injection. Public
  RPCs are far more rate-limited than EVM public RPCs —
  **Helius/Triton/QuickNode effectively required**.

## Layer 4 — Net-new (no EVM analog)

- **Compute Budget management**:
  `ComputeBudgetProgram.setComputeUnitLimit` +
  `setComputeUnitPrice` on every non-trivial TX; dynamic limit
  tuning from simulation.
- **Address Lookup Tables (ALTs)**: create/maintain tables for
  frequent accounts (pool, position, mints, aggregator).
- **Versioned (v0) transactions**: default to v0 when using ALTs.
- **Token-2022 vs. SPL Token**: detect program per mint; handle
  transfer-fee, interest-bearing extensions.
- **Rent / rent-exemption**: account creation = one-time rent
  cost; factor into P&L like EVM mint gas.
- **PDA derivation**: many positions/state accounts are PDAs, not
  user keypairs; key-migration logic needs PDA-aware rules.
- **MEV / Jito**: optional. If X1 has Jito-equivalent bundles,
  priority fees are an auction — different throttle heuristics.
- **Keypair storage**: Ed25519 32-byte secret (not secp256k1).
  AES-256-GCM wrapper still applies.

## Layer 5 — Drop

- "No gwei in prose" rule → replace with lamports/SOL analog.
- EIP-55 checksumming rule.
- PulseChain `getFeeData()` null-patch (EVM-only bug).
- EVM-specific aggregator cancel-and-requote semantics (rewrite
  around Jupiter/X1 quote expiry).
- Nonce-based TX serialization reasoning (replaced with
  blockhash-lifetime reasoning).

## Process

1. Bootstrap meta first: copy `CLAUDE.md` + `docs/claude/*` +
   memory system + repo-level config. Adapt chain-specific
   examples inline.
2. Scaffold dashboard shell (HTML + esbuild + modular JS + fonts +
   CSS). Chain-neutral.
3. Define chain-abstracted interfaces first: `Provider`,
   `TxSender`, `EventScanner`, `QuoteEngine`, `PriceFetcher`,
   `WalletStore`. Stub with LP-Ranger-shaped method signatures.
4. Implement one AMM end-to-end before generalizing.
5. Keep the app stateless — caches are pure perf.
6. Port tests with implementation. Use `solana-test-validator` as
   the ganache analog.
7. Mirror the memory/feedback rule system; reuse rules verbatim.

## Blocker questions before starting

1. Which **CLMM protocol** on X1? (Orca-fork? Raydium-fork?
   Native?) Decides math module + SDK.
2. Is there an **aggregator** on X1, or first cut uses direct-AMM
   swaps?
3. **Helius-equivalent** enhanced-RPC provider on X1, or raw
   JSON-RPC only?
4. **Jito-style priority-fee auctions** on X1, or plain
   priority-fee model?
5. **NFT-position model** on the target CLMM? (SPL mint per
   position à la Orca? PDA-only state à la Raydium?) Shapes
   position identity, rebalance chains, closed-position semantics.
