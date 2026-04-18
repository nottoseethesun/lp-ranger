/**
 * @file param-help-content.js
 * @description Educational content for every configurable dashboard parameter.
 * Each entry maps an input element key to a structured help object rendered
 * by dashboard-param-help.js.  Content is separated from rendering for
 * editorial review and SEC compliance.
 */

/** @type {Record<string, {title: string, sections: {heading: string, body: string}[]}>} */
export const PARAM_HELP = {
  // ── Range & Execution ───────────────────────────────────────────────────

  inOorThreshold: {
    title: "OOR Threshold (%)",
    subtitle: "Out of Range Threshold",
    sections: [
      {
        heading: "What it does",
        body:
          "Controls how far the current price must move <strong>beyond</strong> " +
          "your position&rsquo;s upper or lower tick boundary before a " +
          "rebalance is triggered. A value of 10 means the price must be " +
          "at least 10% past the boundary &mdash; not just outside the range.",
      },
      {
        heading: "Recommended values",
        body:
          "<strong>Stable pairs</strong> (e.g. stablecoin/stablecoin): 1&ndash;5%. " +
          "Price rarely moves far, so a tight threshold is appropriate.<br>" +
          "<strong>Volatile pairs</strong> (e.g. WPLS/HEX): 10&ndash;20%. " +
          "A wider threshold avoids rebalancing on normal volatility swings.",
      },
      {
        heading: "Extreme values",
        body:
          "<strong>0%</strong> &mdash; rebalances the instant price exits the range. " +
          "This can cause excessive gas spending and slippage during " +
          "volatility.<br>" +
          "<strong>100%</strong> &mdash; price must double past the boundary. " +
          "Effectively disables threshold-based rebalancing; only the OOR " +
          "Timeout (if set) would trigger.",
      },
      {
        heading: "Related parameters",
        body:
          "Works with <strong>OOR Timeout</strong> &mdash; the timeout can " +
          "trigger a rebalance even if the threshold hasn&rsquo;t been " +
          "crossed, and vice versa. Also affected by <strong>Min Interval" +
          "</strong> and <strong>Max Rebalances/Day</strong>, which throttle " +
          "how often rebalances can occur.",
      },
    ],
  },

  inOorTimeout: {
    title: "OOR Timeout (minutes)",
    subtitle: "Out of Range Timeout",
    sections: [
      {
        heading: "What it does",
        body:
          "Triggers a rebalance after your position has been continuously " +
          "out of range for this many minutes, even if the OOR Threshold " +
          "hasn&rsquo;t been crossed. The countdown resets whenever the " +
          "price returns to range.",
      },
      {
        heading: "Recommended values",
        body:
          "<strong>60&ndash;180 minutes</strong> for most pools. Shorter " +
          "timeouts (30&ndash;60 min) suit pools where being out of range " +
          "means missing significant trading fees. Longer timeouts " +
          "(180&ndash;360 min) suit volatile pools where temporary OOR is " +
          "normal and self-corrects.",
      },
      {
        heading: "Extreme values",
        body:
          "<strong>0</strong> &mdash; disables the timeout entirely. Only " +
          "the OOR Threshold triggers rebalances.<br>" +
          "<strong>1440 (24 hours)</strong> &mdash; maximum. Very unlikely " +
          "to trigger in practice.",
      },
      {
        heading: "Related parameters",
        body:
          "Complements <strong>OOR Threshold</strong>. Together they form " +
          "a dual-trigger: &ldquo;rebalance if price moves X% past the " +
          "boundary, OR if it stays out for Y minutes, whichever comes " +
          "first.&rdquo;",
      },
    ],
  },

  inSlip: {
    title: "Slippage Tolerance (%)",
    sections: [
      {
        heading: "What it does",
        body:
          "The maximum price impact allowed when the bot swaps tokens " +
          "during a rebalance. Before executing a swap, the bot simulates " +
          "it to get the real expected output, then applies this slippage " +
          "percentage as a safety floor. If the actual price impact exceeds " +
          "this value, the swap is aborted.",
      },
      {
        heading: "Recommended values",
        body:
          "<strong>0.5&ndash;1.0%</strong> for liquid pools (high TVL, " +
          "major token pairs).<br>" +
          "<strong>1.0&ndash;3.0%</strong> for thin liquidity pools or " +
          "meme token pairs where wider spreads are normal.<br>" +
          "Start conservative (lower) and increase only if swaps fail " +
          "with &ldquo;price impact exceeds slippage&rdquo; errors.",
      },
      {
        heading: "Extreme values",
        body:
          "<strong>0.1%</strong> (minimum) &mdash; very tight. Most swaps " +
          "will fail in anything but the deepest liquidity pools.<br>" +
          "<strong>5.0%</strong> (maximum) &mdash; very loose. You may " +
          "lose significant value to price impact on each swap. Only use " +
          "this for extremely illiquid pairs as a last resort.",
      },
      {
        heading: "Related parameters",
        body:
          "If the bot repeatedly fails swaps due to slippage, it enters " +
          "a <strong>swap backoff</strong> mode (exponential cooldown). " +
          "During this process, if you (the user) manually increase the " +
          "slippage by using this setting, then the backoff will be " +
          "cleared and the new slippage setting will take effect. The " +
          "<strong>Routing</strong> badge shows which venue handled the " +
          "swap &mdash; the aggregator finds the lowest-impact route " +
          "across multiple liquidity pools and multiple liquidity pool providers." +
          "<br><br>" +
          "All parameters that affect the frequency of rebalances are " +
          "related to slippage: the more rebalances that occur, the " +
          "greater the cumulative loss due to slippage, because the " +
          "slippage loss of any single transaction would likely be " +
          "repeated for each rebalance. So an appropriate slippage " +
          "setting is important.",
      },
    ],
  },

  inInterval: {
    title: "Check Interval (seconds)",
    sections: [
      {
        heading: "What it does",
        body:
          "How often the bot polls the blockchain to check your " +
          "position&rsquo;s status &mdash; whether it&rsquo;s in range, " +
          "what the current price is, and whether a rebalance or compound " +
          "is needed.",
      },
      {
        heading: "Recommended values",
        body:
          "<strong>60 seconds</strong> (the default) balances responsiveness " +
          "with RPC sustainability. Each poll cycle makes several RPC calls " +
          "per managed position (pool state, balances, fee data), and these " +
          "add up when managing multiple positions over weeks of continuous " +
          "operation.<br><br>" +
          "<strong>120&ndash;300 seconds</strong> for stable pools or when " +
          "minimizing RPC usage matters.",
      },
      {
        heading: "Extreme values",
        body:
          "<strong>Values under 30 seconds</strong> may trigger rate " +
          "limiting on public RPC endpoints. Public endpoints handle " +
          "short bursts well, but sustained high-frequency polling over " +
          "weeks can provoke throttling or silent request dropping. A " +
          "rate-limited RPC during a rebalance is dangerous &mdash; the " +
          "bot could complete the liquidity removal but fail the swap or " +
          "mint, leaving funds undeployed in the wallet.<br><br>" +
          "<strong>3600 seconds</strong> (1 hour, maximum) &mdash; the " +
          "bot checks once per hour. You may miss significant time out of " +
          "range.<br><br>" +
          "If you run your own PulseChain node (see the <strong>RPC URL" +
          "</strong> setting), rate limiting is not a concern and shorter " +
          "intervals are safe.",
      },
      {
        heading: "Related parameters",
        body:
          "The <strong>OOR Timeout</strong> countdown is evaluated on each " +
          "poll. A longer check interval means the timeout measurement is " +
          "coarser. Auto-compound checks also run on this cycle.",
      },
    ],
  },

  inGas: {
    title: "Gas Strategy",
    sections: [
      {
        heading: "What it does",
        body:
          "Controls how the bot prices gas for transactions. " +
          "<strong>Auto</strong> uses the network&rsquo;s current gas " +
          "price. <strong>Fast</strong> pays a premium for quicker " +
          "confirmation. <strong>Economy</strong> uses a lower gas price " +
          "to save costs, at the risk of slower confirmation.",
      },
      {
        heading: "Recommended values",
        body:
          "<strong>Auto</strong> is the best default for PulseChain &mdash; " +
          "gas is typically very cheap and the network is rarely congested. " +
          "Use <strong>Fast</strong> only if you observe stuck transactions.",
      },
      {
        heading: "Related parameters",
        body:
          "Stuck transactions are handled by the TX speed-up pipeline: " +
          "after 2 minutes, the bot resends at 1.5&times; gas. After 20 " +
          "minutes, it auto-cancels with a 0-PLS self-transfer to free " +
          "the nonce.",
      },
    ],
  },

  // ── Position Offset ─────────────────────────────────────────────────────

  inOffsetToken0: {
    title: "Position Offset",
    sections: [
      {
        heading: "What it does",
        body:
          "Controls the ratio of the tokens in the liquidity pool pair " +
          "(we&rsquo;ll call them here, &ldquo;Token0&rdquo; and " +
          "&ldquo;Token1&rdquo;) to each other, when minting a new " +
          "position during rebalance. At <strong>50%</strong> (the " +
          "default), the range is centered symmetrically around the " +
          "current price. Lower values shift the range below the current " +
          "price (more Token1); higher values shift it above (more Token0).",
      },
      {
        heading: "Recommended values",
        body:
          "<strong>50%</strong> (default, symmetric) is correct for most " +
          "users. Adjust only if you have a directional view on the " +
          "token pair &mdash; for example, if you believe Token0 will " +
          "appreciate, you might set 60&ndash;70% to hold more of it.",
      },
      {
        heading: "Extreme values",
        body:
          "<strong>0%</strong> &mdash; all Token1, position is entirely " +
          "below current price (single-sided).<br>" +
          "<strong>100%</strong> &mdash; all Token0, position is entirely " +
          "above current price (single-sided).<br>" +
          "Single-sided positions earn no fees while price is on the other " +
          "side.",
      },
      {
        heading: "Related parameters",
        body:
          "The <strong>OOR Threshold</strong> determines how far price " +
          "must move past the (potentially asymmetric) boundaries before " +
          "rebalancing.",
      },
    ],
  },

  // ── Timing & Throttle ──────────────────────────────────────────────────

  inMinInterval: {
    title: "Min Time Between Rebalances",
    sections: [
      {
        heading: "What it does",
        body:
          "The minimum cooldown period after a rebalance before the next " +
          "one is allowed. Prevents rapid-fire rebalances during volatile " +
          "periods, which would waste gas and incur unnecessary slippage.",
      },
      {
        heading: "Recommended values",
        body:
          "<strong>10&ndash;30 minutes</strong> for most pools. Volatile " +
          "pairs benefit from a longer cooldown (20&ndash;60 min) to avoid " +
          "chasing whipsaws.",
      },
      {
        heading: "Extreme values",
        body:
          "<strong>1 minute</strong> (minimum) &mdash; almost no " +
          "throttling. Risky in volatile markets.<br>" +
          "<strong>1440 minutes</strong> (24 hours, maximum) &mdash; at " +
          "most one rebalance per day.",
      },
      {
        heading: "Related parameters",
        body:
          "If 3 rebalances occur within 4&times; this interval, " +
          "<strong>Doubling Mode</strong> activates &mdash; the cooldown " +
          "doubles after each rebalance (10m &rarr; 20m &rarr; 40m " +
          "&rarr; 80m&hellip;). See the Throttle info modal for details.",
      },
    ],
  },

  inMaxReb: {
    title: "Max Rebalances Per Day",
    sections: [
      {
        heading: "What it does",
        body:
          "A daily safety cap on how many rebalances the bot will execute " +
          "for this position. Once the cap is reached, no more rebalances " +
          "occur until midnight UTC, even if the position goes out of range.",
      },
      {
        heading: "Recommended values",
        body:
          "<strong>5&ndash;20</strong> for most pools. Lower values " +
          "(3&ndash;5) protect against runaway gas spending on very " +
          "volatile days. Higher values (20+) allow the bot more freedom " +
          "in active markets.",
      },
      {
        heading: "Extreme values",
        body:
          "<strong>1</strong> &mdash; at most one rebalance per day. " +
          "Very conservative.<br>" +
          "<strong>200</strong> (maximum) &mdash; effectively no daily " +
          "cap. Only the min interval and doubling mode would throttle.",
      },
      {
        heading: "Related parameters",
        body:
          "This is a <strong>wallet-level</strong> daily cap, shared " +
          "across all positions. A busy pool hitting the cap stops " +
          "rebalances for all positions until midnight UTC reset.",
      },
    ],
  },

  dblWindowLabel: {
    title: "Doubling Trigger Window",
    sections: [
      {
        heading: "What it does",
        body:
          "This is a calculated value (4&times; the Min Interval). When " +
          "3 or more rebalances occur within this window, " +
          "<strong>Doubling Mode</strong> activates &mdash; the cooldown " +
          "between rebalances doubles after each one: 10m &rarr; 20m " +
          "&rarr; 40m &rarr; 80m, and so on.",
      },
      {
        heading: "Why it exists",
        body:
          "Doubling mode is a circuit breaker for volatile markets. If " +
          "the price is whipsawing rapidly, each rebalance costs gas and " +
          "incurs slippage. Doubling the wait time gives the market a " +
          "chance to settle before the bot tries again.",
      },
      {
        heading: "How it resets",
        body:
          "Doubling mode clears after a quiet period of 4&times; the " +
          "current doubled wait, or at midnight UTC (whichever comes " +
          "first). Once cleared, the min interval returns to its normal " +
          "configured value.",
      },
      {
        heading: "Related parameters",
        body:
          "Derived from <strong>Min Time Between Rebalances</strong>. " +
          "Also capped by <strong>Max Rebalances Per Day</strong>. " +
          "See the Throttle info modal (click the (i) on the section " +
          "title) for a full explanation of all throttle states.",
      },
    ],
  },

  // ── Compound ───────────────────────────────────────────────────────────

  autoCompoundToggle: {
    title: "Auto-Compound",
    sections: [
      {
        heading: "What it does",
        body:
          "When enabled, the bot automatically collects unclaimed trading " +
          "fees and re-deposits them as additional liquidity on the same " +
          "NFT position. No new NFT is minted, no swap is performed, and " +
          "the range does not change.",
      },
      {
        heading: "When to enable",
        body:
          "Enable for positions you plan to hold long-term. Compounding " +
          "reinvests fees so they earn additional fees (compound growth). " +
          "Disable if you prefer to collect fees manually or if gas costs " +
          "would exceed the fee amount.",
      },
      {
        heading: "How it works",
        body:
          "The bot checks for unclaimed fees on every poll cycle (when in " +
          "range). If fees exceed the <strong>Auto-Compound Threshold" +
          "</strong>, it executes a collect + increaseLiquidity transaction. " +
          "Compounded amounts are tracked and subtracted from Net P&amp;L " +
          "to avoid double-counting.",
      },
    ],
  },

  autoCompoundThreshold: {
    title: "Auto-Compound Threshold ($USD)",
    sections: [
      {
        heading: "What it does",
        body:
          "The minimum unclaimed fee value (in USD) that must accumulate " +
          "before the bot will auto-compound. Prevents compounding tiny " +
          "amounts where gas would exceed the benefit.",
      },
      {
        heading: "Recommended values",
        body:
          "<strong>$5&ndash;$20</strong> for PulseChain (gas is cheap). " +
          "On higher-gas chains, set this higher to ensure gas doesn&rsquo;t " +
          "eat the compounded amount.",
      },
      {
        heading: "Extreme values",
        body:
          "<strong>$1</strong> (minimum) &mdash; compounds very small " +
          "amounts. May not be gas-efficient on busy days.<br>" +
          "Very high values (&gt;$100) effectively disable auto-compound " +
          "for low-fee positions.",
      },
      {
        heading: "Related parameters",
        body:
          "The <strong>Compound Now</strong> button bypasses the threshold " +
          "for a one-time manual compound. The minimum fee to compound is " +
          "set server-side (default $1).",
      },
    ],
  },

  // ── Contracts & Network ────────────────────────────────────────────────

  moralisKey: {
    title: "Moralis API Key",
    sections: [
      {
        heading: "What it does",
        body:
          "Moralis is a third-party blockchain data provider that LP Ranger " +
          "uses as its <strong>primary source for historical token prices" +
          "</strong>. When a HODL baseline or deposit auto-detection needs " +
          "to know what a token was worth at a past date, Moralis provides " +
          "that price. This makes P&amp;L calculations, Impermanent Loss, " +
          "and deposit valuations more accurate.",
      },
      {
        heading: "Is it required?",
        body:
          "<strong>No.</strong> The Moralis key is optional. Without it, " +
          "LP Ranger falls back to <strong>GeckoTerminal</strong> (free, " +
          "no key needed, but rate-limited to 30 calls/min) and then to " +
          "<strong>DexScreener</strong> (current prices only, no historical " +
          "data). These fallbacks work but may produce less accurate " +
          "historical valuations, especially for older positions.",
      },
      {
        heading: "How to get a key",
        body:
          'Sign up at <a href="https://moralis.com/" target="_blank" ' +
          'rel="noopener noreferrer">moralis.com</a> (free tier ' +
          "available). Copy your API key from the Moralis dashboard and " +
          "paste it in the text input form box in the Settings menu. " +
          "The key is encrypted with your wallet password " +
          "and stored locally &mdash; it is never sent anywhere except " +
          "to the Moralis API itself.",
      },
      {
        heading: "Alternatives",
        body:
          "If you prefer not to use Moralis, the app works without it. " +
          "GeckoTerminal provides free historical OHLCV data (day, hour, " +
          "and minute granularity) and is used automatically as a fallback. " +
          "DexScreener provides current spot prices. Both are free and " +
          "require no API key. The trade-off is slower scans (due to rate " +
          "limiting) and less precise historical valuations for deposit " +
          "auto-detection.",
      },
    ],
  },

  inRpc: {
    title: "RPC URL",
    sections: [
      {
        heading: "What it does",
        body:
          "The blockchain RPC endpoint the bot uses to read on-chain data " +
          "and submit transactions. This is your connection to the " +
          "PulseChain network.",
      },
      {
        heading: "Recommended values",
        body:
          "The default (<strong>rpc-pulsechain.g4mm4.io</strong>) is a " +
          "reliable public endpoint. The dropdown offers alternatives. " +
          "If you run your own PulseChain node, enter its URL here for " +
          "maximum privacy and reliability.",
      },
      {
        heading: "When to change",
        body:
          "Change if you experience RPC timeouts, slow responses, or " +
          "want to use a private node. The bot automatically falls back " +
          "to the official PulseChain RPC if the primary fails. " +
          "<strong>Restart the app for the change to take effect</strong> " +
          "(the running bot holds the provider it was started with).",
      },
    ],
  },

  inPM: {
    title: "Position Manager (NonfungiblePositionManager)",
    sections: [
      {
        heading: "What it does",
        body:
          "The on-chain smart contract address that manages all V3 NFT " +
          "liquidity positions. All mint, remove-liquidity, collect, and " +
          "compound transactions are sent to this contract.",
      },
      {
        heading: "Default value",
        body:
          "Pre-filled with the official 9mm Pro V3 NonfungiblePositionManager " +
          "on PulseChain. Note that other v3 Position Managers are " +
          "available, such as 9inch. This app currently can only support " +
          "the 9mm Pro Position Manager contract. " +
          "<strong>Do not change this unless you know " +
          "exactly what you are doing.</strong> An incorrect address will " +
          "cause all transactions to fail or be sent to the wrong contract. " +
          "<strong>Restart the app for the change to take effect</strong> " +
          "(the running bot holds the address it was started with).",
      },
    ],
  },

  inFactory: {
    title: "Factory Address",
    sections: [
      {
        heading: "What it does",
        body:
          "The V3 Factory contract address used to look up pool addresses " +
          "and verify pool state. The bot queries this contract to find " +
          "the correct pool for your token pair and fee tier.",
      },
      {
        heading: "Default value",
        body:
          "Pre-filled with the official 9mm Pro V3 Factory on PulseChain. " +
          "Note that other v3 Position Managers are available, such as " +
          "9inch. This app currently can only support the 9mm Pro Position " +
          "Manager contract. " +
          "<strong>Do not change this unless you are connecting to a " +
          "different V3 deployment.</strong> " +
          "<strong>Restart the app for the change to take effect</strong> " +
          "(the running bot holds the address it was started with).",
      },
    ],
  },

  // ── Profit ─────────────────────────────────────────────────────────────

  curProfit: {
    title: "Profit (Current Position)",
    sections: [
      {
        heading: "What it is",
        body:
          "<strong>Profit</strong> measures how this position has performed " +
          "as a fee-earning instrument, independent of token price movements. " +
          "It answers: &ldquo;Did the fees earned outweigh the costs of " +
          "running the position?&rdquo;",
      },
      {
        heading: "Formula",
        body:
          "Profit = Fees Earned &minus; Fees Compounded &minus; Gas " +
          "+/&minus; Impermanent Loss/Gain (IL/G).<br><br>" +
          "Fees Compounded are subtracted because they were reinvested as " +
          "liquidity and are already reflected in the Current Position " +
          "Value. IL/G captures the difference between holding the tokens " +
          "in the LP versus simply holding them in your wallet.",
      },
      {
        heading: "How it differs from Net P&L",
        body:
          "<strong>Net P&amp;L</strong> includes Price Change (how much " +
          "the position&rsquo;s value moved due to token prices) and " +
          "Realized Gains (tokens you sold). Profit excludes both &mdash; " +
          "it isolates the fee-earning performance from market movements.",
      },
    ],
  },

  ltProfit: {
    title: "Profit (Lifetime)",
    sections: [
      {
        heading: "What it is",
        body:
          "<strong>Lifetime Profit</strong> measures the cumulative " +
          "fee-earning performance across all positions in this pool&rsquo;s " +
          "rebalance chain, independent of token price movements.",
      },
      {
        heading: "Formula",
        body:
          "Profit = Lifetime Fees &minus; Fees Compounded &minus; Gas " +
          "+/&minus; Impermanent Loss/Gain (IL/G).<br><br>" +
          "Lifetime Fees includes fees earned across all NFT positions in " +
          "the rebalance chain. Fees Compounded are subtracted to avoid " +
          "double-counting (they are already in the Current Value). Gas " +
          "covers all rebalance and compound transaction costs.",
      },
      {
        heading: "How it differs from Net P&L",
        body:
          "<strong>Lifetime Net P&amp;L</strong> adds Price Change " +
          "(Current Value &minus; Total Lifetime Deposit) and Realized " +
          "Gains. Profit excludes both, showing how the pool performed " +
          "purely as a fee-generating instrument. Click the (i) next to " +
          "the Net P&amp;L figure above for the full breakdown.",
      },
    ],
  },

  // ── P&L Inputs ─────────────────────────────────────────────────────────

  curDepositInput: {
    title: "Initial Deposit (This Position)",
    sections: [
      {
        heading: "What it does",
        body:
          "The USD value of the tokens you deposited when creating this " +
          "specific LP position. Used to calculate the current " +
          "position&rsquo;s Net P&amp;L (current value + fees &minus; " +
          "initial deposit).",
      },
      {
        heading: "When to edit",
        body:
          "The bot auto-detects this from on-chain data using historical " +
          "token prices. Edit manually only if the auto-detected value " +
          "is clearly wrong (e.g. for meme tokens with unreliable price " +
          "feeds). To revert to auto-detection, save the field as 0.",
      },
      {
        heading: "How it affects P&L",
        body:
          "Net P&amp;L = Current Position Value + Fees Earned &minus; " +
          "Fees Compounded &minus; Initial Deposit for This LP. " +
          "Fees Compounded are subtracted because they are already " +
          "included in the Current Position Value (they were reinvested " +
          "as additional liquidity). Without this subtraction, compounded " +
          "fees would be double-counted. A higher deposit value lowers " +
          "your reported profit; a lower value inflates it.",
      },
    ],
  },

  curRealizedInput: {
    title: "Realized Gains (This Position)",
    sections: [
      {
        heading: "What it does",
        body:
          "The USD value of tokens you have sold or withdrawn from this " +
          "specific LP position. These are gains that have left the " +
          "position and are no longer reflected in its on-chain value.",
      },
      {
        heading: "When to edit",
        body:
          "Update this whenever you sell tokens that came from this " +
          "position&rsquo;s residuals (tokens left in the wallet after " +
          "rebalance). This is always a manual entry.",
      },
      {
        heading: "How it affects P&L",
        body:
          "Realized gains are added to Lifetime Net P&amp;L: " +
          "Lifetime P&amp;L = Current Value + Fees + Realized Gains " +
          "&minus; Total Deposit. You must also update the " +
          "<strong>Lifetime Realized Gains</strong> separately.",
      },
    ],
  },

  initialDepositInput: {
    title: "Total Lifetime Deposit",
    sections: [
      {
        heading: "What it does",
        body:
          "The total USD value of <strong>all</strong> deposits, for each " +
          "of the two tokens in this liquidity pool pair, into this " +
          "liquidity pool on this wallet, across all NFT positions in the " +
          "rebalance chain (up to 5 years of history).",
      },
      {
        heading: "When to edit",
        body:
          "The bot auto-detects this by scanning all IncreaseLiquidity " +
          "events and valuing them at historical prices. Edit manually " +
          "only if auto-detection is inaccurate. Save as 0 to revert " +
          "to auto-detection.",
      },
      {
        heading: "How it affects P&L",
        body:
          "The Total Lifetime Deposit is the baseline for the " +
          "<strong>Price Change</strong> component of Net P&amp;L: " +
          "Price Change = Current Value &minus; Total Lifetime Deposit. " +
          "This captures both token price appreciation and impermanent " +
          "loss together. A higher deposit value lowers the Price Change " +
          "figure; a lower value inflates it." +
          "<br><br>" +
          "For the full breakdown of how Price Change combines with " +
          "Lifetime Fees, Gas, Fees Compounded, and Realized Gains to produce " +
          "the Net P&amp;L figure, click the (i) button next to the " +
          "<strong>Net Profit and Loss Return</strong> value at the top " +
          "of this Lifetime panel.",
      },
    ],
  },

  realizedGainsInput: {
    title: "Lifetime Realized Gains",
    sections: [
      {
        heading: "What it does",
        body:
          "The total USD value of all tokens sold or withdrawn from this " +
          "pool across the entire position history. This is a " +
          "pool-level (not per-NFT) figure.",
      },
      {
        heading: "When to edit",
        body:
          "Update whenever you sell residual tokens from any position in " +
          "this pool. This is always a manual entry &mdash; the bot " +
          "cannot detect off-chain sales.",
      },
      {
        heading: "How it affects P&L",
        body:
          "Added to Lifetime Net P&amp;L. Without this entry, sold " +
          "tokens appear as &ldquo;missing&rdquo; value, understating " +
          "your true returns.",
      },
    ],
  },

  // ── Rebalance Events ───────────────────────────────────────────────────

  rebalanceEvents: {
    title: "Rebalance Events",
    sections: [
      {
        heading: "What this table shows",
        body:
          "Every rebalance LP Ranger has performed on this position, " +
          "oldest to newest. Each row corresponds to one new NFT being " +
          "minted to replace a drained one.",
      },
      {
        heading: "Where the data comes from",
        body:
          "Events are paired from Transfer logs emitted by the " +
          "NonfungiblePositionManager contract. The log data is " +
          "fetched directly from the blockchain &mdash; nothing is " +
          "stored on a server.",
      },
      {
        heading: "Lookback limit",
        body:
          "On-chain lookback is limited to the last 5 years. " +
          "Rebalances older than that will not appear here.",
      },
    ],
  },

  // ── Swap Routing ───────────────────────────────────────────────────────

  swapRouting: {
    title: "Swap Routing",
    sections: [
      {
        heading: "About the aggregator LP Ranger uses",
        body:
          "While currently, LP Ranger uses a single aggregator, the " +
          "9mm DEX Aggregator, there are other good ones as well. " +
          'See <a href="https://switch.win/" target="_blank" ' +
          'rel="noopener noreferrer">Switch</a> and ' +
          '<a href="https://piteas.io/" target="_blank" ' +
          'rel="noopener noreferrer">Piteas</a>, for just two examples.',
      },
    ],
  },
};
