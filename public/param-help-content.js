/**
 * @file param-help-content.js
 * @description Educational content for every configurable dashboard parameter.
 * Each entry maps an input element key to a structured help object rendered
 * by dashboard-param-help.js.  Content is separated from rendering for
 * editorial review and SEC compliance.
 *
 * Dynamic token names: section bodies may contain the placeholders
 * `{{token0}}` / `{{token1}}`.  At render time dashboard-param-help.js
 * substitutes them with the active position's token symbols
 * (HTML-escaped, truncated to 16 characters), falling back to the
 * literal "Token 0" / "Token 1" when no position is active.
 */

/*- Entries whose copy is shared with the User Manual live in
 *  `shared-help-content.json` so the text is written once.  This module
 *  spreads them in; `scripts/build-manual-content.js` renders the same
 *  JSON into public/help-and-user-manual.html at build time.  Edit that
 *  file, not a copy here. */
/*- The `with { type: "json" }` attribute is required, not optional
 *  decoration: esbuild bundles a bare JSON import happily, but Node's
 *  native ESM loader — which the test suite uses to import this module
 *  directly — rejects it with ERR_IMPORT_ATTRIBUTE_MISSING.  Without
 *  the attribute the app works and 301 tests fail. */
import SHARED_HELP from "./shared-help-content.json" with { type: "json" };

/** @type {Record<string, {title: string, sections: {heading: string, body: string}[]}>} */
export const PARAM_HELP = {
  inIlGuard: SHARED_HELP.inIlGuard,
  // ── Range ───────────────────────────────────────────────────────────────

  rangeOverrideToggle: {
    title: "No Override",
    subtitle: "Whether the Range settings below apply on the next rebalance",
    sections: [
      {
        heading: "What the toggle does",
        body:
          "This one switch decides where the next rebalance gets its " +
          "price range from. It governs both settings in this section " +
          "&mdash; <strong>Price Range Extension</strong> and " +
          "<strong>Position Offset</strong> &mdash; together; there is " +
          "no way for one to apply while the other does not.",
      },
      {
        heading: "Re-Use Existing Position Range",
        body:
          "The toggle is <strong>on</strong>. Neither the Price Range " +
          "Extension nor the Position Offset is applied. Instead the " +
          "bot carries this position's current on-chain price range " +
          "across the rebalance and re-centres it on the price at that " +
          "moment, so the new position is as wide as the one it " +
          "replaces. Both fields below are disabled while this is the " +
          "case. Only standard liquidity-pool tick rounding can shift " +
          "the width, and only by up to one tick-spacing per rebalance. " +
          "This is where every position starts out.",
      },
      {
        heading: "Use Settings Below",
        body:
          "The toggle is <strong>off</strong>. The fields below are " +
          "enabled and the values you save in them shape every " +
          "subsequent rebalance: the Price Range Extension sets how far " +
          "the range reaches from the current price, and the Position " +
          "Offset sets how that reach is split above versus below it. " +
          "The <strong>Full-Range</strong> checkbox, when ticked, " +
          "overrides the Price Range Extension value.",
      },
      {
        heading: "Switching back and forth is safe",
        body:
          "Turning the toggle on does <strong>not</strong> erase " +
          "anything. Your saved Price Range Extension, Full-Range and " +
          "Position Offset values stay exactly as you left them &mdash; " +
          "they are simply greyed out and ignored. Turn it off again " +
          "and they are back in force unchanged. That is the difference " +
          "from the old No Override button, which cleared the values " +
          "outright.",
      },
      {
        heading: "When to use each",
        body:
          "<strong>Re-Use Existing Position Range</strong> is the safe " +
          "default and the right choice when you are happy with the " +
          "width of the position you already have, or when you set it " +
          "up in another app and want the bot to keep that shape.<br>" +
          "<strong>Use Settings Below</strong> is for when you want to " +
          "dictate the width yourself &mdash; widening a range that " +
          "goes out of range too often, tightening one to concentrate " +
          "liquidity, or skewing it with an offset because you have a " +
          "directional view on the pair.",
      },
      {
        heading: "Scope",
        body:
          "The setting is saved per position, so each pool can be in a " +
          "different mode. It applies to every rebalance that mints a " +
          "new position &mdash; automatic out-of-range, OOR-timeout, " +
          "residual-cleanup follow-ons, manual " +
          "<strong>Rebalance Now</strong> clicks, and closed-position " +
          "re-opens.",
      },
    ],
  },

  inRangeWidth: {
    title: "Price Range Extension (%)",
    subtitle: "Per-position rebalance price extension override",
    sections: [
      {
        heading: "What it does",
        body:
          "Sets how far the LP position's price range extends from the " +
          "current price at every rebalance (manual OR automatic). " +
          "Together with <strong>Position Offset</strong> this determines " +
          "the lower and upper price bounds. At the default 50/50 offset, " +
          "a value of <strong>50</strong> means the position spans 25% " +
          "below current price and 25% above current price at each " +
          "rebalance (so 0.75x to 1.25x current price). A value of " +
          "<strong>10</strong> spans +/-5% around current price " +
          "(0.95x to 1.05x).",
      },
      {
        heading: "Which rebalances it applies to",
        body:
          "<strong>Every rebalance that mints a new position, " +
          "regardless of trigger</strong>: automatic out-of-range, " +
          "OOR-timeout, automatic residual-cleanup follow-ons, manual " +
          "<strong>Rebalance Now</strong> clicks, and closed-position " +
          "re-opens. It is not a gate &mdash; it never blocks or delays " +
          "a rebalance; it only shapes the price range of the minted " +
          "position. The <strong>Full-Range</strong> checkbox, when on, " +
          "overrides this value.",
      },
      {
        heading: "Range Width vs Price Range Extension",
        body:
          "These are two different concepts. <strong>Price Range " +
          "Extension</strong> (this field) measures how far the position " +
          "reaches from current price. <strong>Range Width</strong> is a " +
          "related-but-different LP concept -- the percentage of the " +
          "pool's populated liquidity range that a position covers. " +
          "Range Width is on the road map as a future alternative to " +
          "Price Range Extension; today only Price Range Extension is " +
          "implemented. Other LP creators (e.g. 9mm's own UI) may label " +
          'their width slider in yet a third way, so a "50% position" ' +
          'you set up on 9mm may not read as "50" here.',
      },
      {
        heading: "When empty (unset)",
        body:
          "Leaving this field empty tells the bot to <strong>preserve the " +
          "existing Range Width</strong> at every rebalance -- the " +
          "position's on-chain tick spread is carried across the " +
          "rebalance and re-centered on the current price, subject only " +
          "to standard liquidity-pool tick rounding (which may drift the " +
          "spread by up to one tick-spacing per rebalance). The input " +
          "stays empty until you type an explicit value.",
      },
      {
        heading: "Full-Range checkbox",
        body:
          "Check the <strong>Full-Range</strong> box to the right of this " +
          "field to force every rebalance to mint a full-range position " +
          "(from the pool's MIN_TICK to MAX_TICK -- effectively \"price " +
          'zero to infinity"). When Full-Range is checked, the Price ' +
          "Range Extension value is ignored and this field is disabled. " +
          "If the currently-active position is already full-range " +
          "on-chain, this box shows as checked automatically (reflecting " +
          "on-chain reality) even without an explicit save.",
      },
      {
        heading: "Buttons on the edit row",
        body:
          "<strong>Default</strong>: fills the input with the shipped " +
          "default value from bot-config-defaults.json and unticks " +
          "<strong>Full-Range</strong> -- asking for a default " +
          "extension is asking not to mint full-range, and the two " +
          "cannot both apply. You still have to click " +
          "<strong>Save</strong> to persist either change.<br>" +
          "<strong>Save</strong>: writes the extension and the " +
          "Full-Range setting to the per-position config together; " +
          "they apply on the next rebalance.<br>" +
          "This field is either disabled or in force: the " +
          "<strong>No Override</strong> toggle at the top of the Range " +
          "section is what takes it out of force, and it does so " +
          "without erasing what you saved.",
      },
      {
        heading: "Choosing a value",
        body:
          "<strong>Stable pairs</strong>: 2 to 10 (that is, +/-1% to " +
          "+/-5% around current). Tighter ranges concentrate liquidity " +
          "and earn more fees when price is stable.<br>" +
          "<strong>Volatile pairs</strong>: 20 to 60 (+/-10% to +/-30% " +
          "around current) or more. Wider ranges reduce how often " +
          "rebalancing is triggered by normal price swings.",
      },
      {
        heading: "IL trade-off",
        body:
          "Every rebalance incurs gas and slippage that can crystallize " +
          "impermanent loss over time. A wider range rebalances less " +
          "often and captures fewer fees per dollar of liquidity; a " +
          "narrower range concentrates liquidity to earn fees at a " +
          "higher rate (while price is still within range) but incurs " +
          "more rebalance costs. This setting persists per-position " +
          "(per pool) so you can tune each pair independently.",
      },
    ],
  },

  rangePctLeeway: {
    title: "Price Range Extension (visual)",
    subtitle: 'The "% below / above price" numbers on the range bar',
    sections: [
      {
        heading: "What these show",
        body:
          "The two numbers just under the range bar report how far the " +
          "current pool price sits inside your position, expressed as a " +
          "percentage of current price:<br>" +
          "<strong>-X% below price</strong>: the lower price bound is " +
          "X% below the current price. If price drops that far, the " +
          "position goes out of range on the bottom.<br>" +
          "<strong>+Y% above price</strong>: the upper price bound is Y% " +
          "above the current price. If price rises that far, the position " +
          "goes out of range on the top.",
      },
      {
        heading: "Why they are usually asymmetric",
        body:
          "Uniswap v3 stores position bounds in <em>ticks</em>, where each " +
          "tick is a fixed 0.01% multiplicative step in price. A position " +
          "that is tick-symmetric (equal tick distance above and below " +
          "current) is <em>not</em> price-symmetric, because a fixed number " +
          "of upward tick steps produces a bigger percentage move than the " +
          'same number of downward steps. So even a "centered" position ' +
          "typically shows -X% below and +Y% above with Y > X.",
      },
      {
        heading: "Relation to the Bot Settings Price Range Extension input",
        body:
          "This is the same concept as the <strong>Price Range Extension" +
          "</strong> input in Bot Settings, just presented as two numbers " +
          "(below-and-above) instead of a single total. Roughly, the sum " +
          "of the two numbers here approximates the Price Range Extension " +
          "% for a centered position -- but they are computed from the " +
          "actual on-chain ticks against the current price, so they " +
          "reflect reality (including tick-rounding drift) rather than " +
          "whatever you last saved.",
      },
    ],
  },

  inOorThreshold: {
    title: "OOR Threshold (%)",
    subtitle: "Out of Range Threshold",
    sections: [
      {
        heading: "What it does",
        body:
          "Sets how far the current price must move <strong>beyond</strong> " +
          "your position&rsquo;s upper or lower <strong>price " +
          "boundary</strong> before the price-distance condition alone " +
          "triggers a rebalance. The distance is measured as a " +
          "percentage of the <strong>position&rsquo;s price-range " +
          "width</strong> (upper bound &minus; lower bound), not of the " +
          "current price. Example: with a value of 10 and a range " +
          "spanning $1.00&ndash;$1.20 (width $0.20), the trigger points " +
          "are $0.98 and $1.22 &mdash; 10% of the width past each " +
          "bound. This is one of <strong>two</strong> triggers: even " +
          "while the price sits inside the threshold zone, the " +
          "<strong>OOR Rebalance Time Threshold</strong> (if set) " +
          "triggers on its own after enough continuous out-of-range " +
          "time. A rebalance fires when <em>either</em> condition is " +
          "met.",
      },
      {
        heading: "Which rebalances it applies to",
        body:
          "Only the <strong>automatic out-of-range trigger</strong> " +
          "consults this threshold. Residual-cleanup and manual " +
          "<strong>Rebalance Now</strong> rebalances ignore it entirely " +
          "&mdash; they can run even while the price is inside the " +
          "range. The <strong>OOR Rebalance Time Threshold</strong>, if " +
          "set, fires after continuous out-of-range time even when this " +
          "threshold has not been crossed.",
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
          "<strong>100%</strong> &mdash; price must travel a full " +
          "range-width past the boundary (e.g. for a $1.00&ndash;$1.20 " +
          "range, down to $0.80 or up to $1.40). Note that for a narrow " +
          "position, one full range-width is still a small, routine " +
          "price move &mdash; the trigger stays live. Only for very " +
          "wide ranges does 100% become practically unreachable, " +
          "leaving the OOR Rebalance Time Threshold (if set) as the " +
          "sole trigger.",
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
        heading: "Which rebalances it applies to",
        body:
          "This is a second trigger for <strong>automatic</strong> " +
          "rebalances only. Residual-cleanup and manual " +
          "<strong>Rebalance Now</strong> rebalances do not consult it. " +
          "The countdown starts at the first out-of-range poll and " +
          "resets when the price returns to range or when any rebalance " +
          "succeeds. A timeout-triggered rebalance still has to pass " +
          "the <strong>Min Time Between Rebalances</strong> cooldown, " +
          "<strong>Doubling Mode</strong>, and the <strong>Max " +
          "Rebalances / Day</strong> cap &mdash; the timeout is a " +
          "trigger, not a bypass.",
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
          "a dual-trigger: &ldquo;rebalance if price moves X% of the " +
          "range width past the boundary, OR if it stays out of range " +
          "for Y minutes, whichever comes first.&rdquo; Either condition " +
          "alone is sufficient &mdash; neither needs the other.",
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

  inSlipToken0: {
    title: "Slippage Tolerance, Token 0 (%)",
    subtitle: "Per-position slippage for the Token 0 side of swaps",
    sections: [
      {
        heading: "What it does",
        body:
          "Sets the slippage tolerance used for swaps whose " +
          "DESTINATION is Token 0 (i.e., swaps that CONVERT Token 1 " +
          "into Token 0). For example, when {{token1}} is traded for " +
          "{{token0}}. This is one of the two slippage settings for " +
          "the position; the other is Slippage Tolerance, Token 1. " +
          "Each side of the pair carries its own value so that " +
          "asymmetric-liquidity pairs work correctly. Example: on a " +
          "$texan/$wPls pair, $texan is thin and needs a high slippage " +
          "to complete swaps, but that same high slippage on the $wPls " +
          "side would open the $wPls swap up to MEV front-running for " +
          "no gain. Set each side independently.",
      },
      {
        heading: "The destination-token rule",
        body:
          "Slippage is applied by the destination token of the swap, " +
          "not the source. A swap that CONVERTS Token 1 INTO Token 0 " +
          "uses this field. A swap that CONVERTS Token 0 INTO Token 1 " +
          "uses the Slippage (Token 1) field instead. The destination " +
          "side is where MEV can extract value from the swap, so that " +
          "is where the slippage budget lives.",
      },
      {
        heading: "Default value",
        body:
          "The input starts populated with the shipped default (0.75%). " +
          "That is the value the bot uses if you never change it. " +
          "Change the input and click Save to persist a different value " +
          "for this position.",
      },
      {
        heading: "Allowed range and warnings",
        body:
          "The full allowed range is <strong>0.1% to 20%</strong>. " +
          "Above 5% the app shows a confirm dialog on Save. Above 10% " +
          "the app shows a stricter dialog that requires you to type " +
          '"Confirm" to proceed. Values outside 0.1% to 20% are ' +
          "rejected outright. On asymmetric pairs, the deep side " +
          "typically wants 0.1% to 1% and the thin side may need " +
          "5% or more.",
      },
    ],
  },

  inSlipToken1: {
    title: "Slippage Tolerance, Token 1 (%)",
    subtitle: "Per-position slippage for the Token 1 side of swaps",
    sections: [
      {
        heading: "What it does",
        body:
          "Sets the slippage tolerance used for swaps whose " +
          "DESTINATION is Token 1 (i.e., swaps that CONVERT Token 0 " +
          "into Token 1). For example, when {{token0}} is traded for " +
          "{{token1}}. This is one of the two slippage settings for " +
          "the position; the other is Slippage Tolerance, Token 0. See " +
          "that tooltip for the full explanation and the $texan/$wPls " +
          "example -- the two fields are peers.",
      },
      {
        heading: "The destination-token rule",
        body:
          "Slippage is applied by the destination token of the swap, " +
          "not the source. A swap that CONVERTS Token 0 INTO Token 1 " +
          "uses this field. A swap that CONVERTS Token 1 INTO Token 0 " +
          "uses the Slippage (Token 0) field instead.",
      },
      {
        heading: "Default value",
        body:
          "The input starts populated with the shipped default (0.75%). " +
          "That is the value the bot uses if you never change it. " +
          "Change the input and click Save to persist a different value " +
          "for this position.",
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
          "<strong>300 seconds</strong> (the default). For most use-cases, " +
          "where capturing trading volume must be balanced against the " +
          "crystallization of impermanent loss that rebalancing can cause, " +
          "300 seconds keeps API calls down. For pools where trading volume " +
          "is extreme, much shorter intervals such as <strong>60 seconds" +
          "</strong> may be needed to capture most every bit of the action." +
          "<br><br>" +
          "Each poll cycle makes several RPC calls per managed position " +
          "(pool state, balances, fee data), and these add up when managing " +
          "multiple positions over weeks of continuous operation.",
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
          "appreciate, you might set 60&ndash;70% to hold more of it at " +
          "the start, because as it appreciates, your liquidity position " +
          "will have less of the appreciating token and more of the " +
          "depreciating token. This way, your position stays in-range " +
          "longer, which is the desired approach (unless you are doing " +
          "single-sided liquidity: See below).",
      },
      {
        heading: "Single-Sided Liquidity Position",
        body:
          "<strong>0%</strong> &mdash; all Token1, position is entirely " +
          "below current price (single-sided).<br>" +
          "<strong>100%</strong> &mdash; all Token0, position is entirely " +
          "above current price (single-sided)." +
          "<p>Single-sided positions earn no fees while price is on the " +
          "other side. Single-sided liquidity positions can be a way to " +
          "sell your coins without incurring sell fees. However, the " +
          "price must move all the way through your single-sided " +
          "position for you to sell all your coins.</p>",
      },
      {
        heading: "Buttons on the edit row",
        body:
          "<strong>No Offset</strong>: fills both fields with the " +
          "shipped centered 50/50 split -- you still have to click " +
          "<strong>Save</strong> to persist it, the same as the " +
          "<strong>Default</strong> button on the Price Range Extension " +
          "row.<br>" +
          "<strong>Save</strong>: writes the value in the input to the " +
          "per-position config; applies on the next rebalance.",
      },
      {
        heading: "When it applies",
        body:
          "Only while the Range section's <strong>No Override</strong> " +
          "toggle is off, i.e. while the badge reads " +
          "<strong>Use Settings Below</strong>. With the toggle on, the " +
          "badge reads <strong>Re-Use Existing Position Range</strong>, " +
          "this field is disabled, and rebalances re-centre the existing " +
          "range symmetrically no matter what is saved here.",
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

  // ── Approval Multiple ───────────────────────────────────────────────────

  inApprovalMultiple: {
    title: "Approval Multiple",
    sections: [
      {
        heading: "What it does",
        body:
          "When the bot needs to approve a token for a swap, mint, or " +
          "compound, it approves <strong>this multiple &times; the " +
          "required amount</strong> instead of just the exact amount. " +
          "Because on-chain allowances persist across transactions, " +
          "subsequent rebalances and compounds can skip the " +
          "<code>approve()</code> transaction entirely until the cached " +
          "allowance is exhausted.",
      },
      {
        heading: "Why it matters",
        body:
          "Each skipped <code>approve()</code> saves the gas cost of that " +
          "transaction and &mdash; more importantly &mdash; cuts one full " +
          "on-chain round trip out of the rebalance or compound flow, " +
          "which makes each cycle noticeably <strong>faster</strong>. " +
          "For frequent rebalancers and auto-compounders, this compounds " +
          "(pun intended) into meaningful savings over time.",
      },
      {
        heading: "Recommended values",
        body:
          "<strong>20</strong> (default) is a reasonable balance: " +
          "large enough to cover many future operations, small enough to " +
          "cap exposure in the unlikely event the router or position " +
          "manager contract is ever compromised. Set to <strong>1</strong> " +
          "to disable pre-sizing (approve exactly what&rsquo;s needed " +
          "each time). Higher values further reduce <code>approve()</code> " +
          "frequency at the cost of a larger outstanding allowance.",
      },
      {
        heading: "Safety note",
        body:
          "The allowance applies only to the specific spender contract " +
          "(the V3 Router, the 9mm Aggregator, or the Position Manager) " +
          "and only to the exact token being approved. You can revoke any " +
          "approval at any time from a wallet tool such as Revoke.cash.",
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
        heading: "Which rebalances it applies to",
        body:
          "The cooldown blocks every <strong>automatic</strong> " +
          "rebalance: out-of-range, OOR-timeout, and residual-cleanup " +
          "follow-ons. Manual <strong>Rebalance Now</strong> clicks are " +
          "never blocked by it. However, <strong>every successful " +
          "rebalance of any kind &mdash; manual and residual cleanup " +
          "included &mdash; restarts the cooldown clock</strong>, so a " +
          "manual rebalance delays the next automatic one by this " +
          "interval. Every successful rebalance also counts toward the " +
          "Doubling Mode trigger (three rebalances within 4&times; this " +
          "interval).",
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
          "A daily safety cap on rebalances for this pool. Once the cap " +
          "is reached, the bot stops automatic rebalancing of this pool " +
          "&mdash; even if the position goes out of range &mdash; until " +
          "the counter resets at midnight UTC.",
      },
      {
        heading: "What counts toward the cap",
        body:
          "<strong>Every successful rebalance counts, no matter what " +
          "triggered it</strong>: automatic out-of-range rebalances, " +
          "out-of-range <em>timeout</em> rebalances, automatic " +
          "<strong>residual cleanup</strong> follow-on rebalances, and " +
          "manual <strong>Rebalance Now</strong> clicks. Compounding is " +
          "a separate operation and never counts.",
      },
      {
        heading: "Manual clicks are never blocked — but still count",
        body:
          "The cap never blocks a manual <strong>Rebalance Now</strong> " +
          "click &mdash; you stay in control even on a capped day. Each " +
          "click still adds one to the day&rsquo;s count, so automatic " +
          "rebalances (including residual cleanups) remain blocked until " +
          "the midnight UTC reset.",
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
        heading: "Scope and reset",
        body:
          "The cap applies <strong>per pool</strong> &mdash; each " +
          "pool&rsquo;s daily count is independent, so one busy pool " +
          "hitting its cap does not stop rebalances on your other pools. " +
          "Counts survive an app restart (they are rebuilt from on-chain " +
          "history) and reset at midnight UTC.",
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
          "&rarr; 40m &rarr; 80m, and so on. The value shown reflects " +
          "the <strong>saved</strong> Min Time Between Rebalances &mdash; " +
          "it updates when you click that setting&rsquo;s " +
          "<strong>Save</strong> button, not while you type.",
      },
      {
        heading: "Which rebalances count, and which are gated",
        body:
          "<strong>All successful rebalances count toward the " +
          "three in-window triggers</strong> &mdash; automatic out-of-range, " +
          "OOR-timeout, residual cleanups, and manual <strong>Rebalance " +
          "Now</strong> clicks alike. Once Doubling Mode is active, the " +
          "doubled wait blocks only the <strong>automatic</strong> " +
          "rebalances (including residual cleanups); manual clicks are " +
          "never blocked. But every successful rebalance while Doubling " +
          "Mode is active &mdash; manual included &mdash; " +
          "<strong>doubles the wait again</strong>.",
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
          "NFT position. No new NFT is minted and the range does not " +
          "change. Before the deposit, LP Ranger runs a small " +
          "ratio-correcting swap so the collected fees match the ratio the " +
          "position currently expects &mdash; this means almost all of the " +
          "fees end up compounded into the position, with little to no " +
          "wallet residual left over. The swap is gated: it is skipped " +
          "when the swap value is too small to be worth doing (dust gate) " +
          "or when gas would exceed 1% of the swap value (gas gate). When " +
          "the swap is skipped, only the side that fits the current ratio " +
          "is compounded and the rest is left as a residual that will be " +
          "folded back in on the next rebalance.",
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
          "</strong>, it executes collect &rarr; ratio-correcting swap " +
          "(when the gates pass) &rarr; increaseLiquidity. Compounded " +
          "amounts are tracked and subtracted from Net P&amp;L to avoid " +
          "double-counting.",
      },
      {
        heading: "Compound vs. Rebalance — wallet residuals",
        body:
          "When a compound's ratio-correcting swap fires, the deposit " +
          "uses the post-swap wallet balance directly. In practice this " +
          "only sweeps in the tiny amounts that arise from rounding " +
          "precision and from the small difference between the swap " +
          "amount the bot projected and the slightly different amount " +
          "the swap actually returned &mdash; not your accumulated " +
          "wallet residuals from prior rebalances. Those larger residuals " +
          "are still cleared by the next <strong>rebalance</strong>, " +
          "which always sweeps in every wallet residual for the pool " +
          "when it mints the new position.",
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

  // ── Gas Fee % (global, Settings popover) ───────────────────────────────

  gasFeePct: {
    title: "Gas Fee % (Swap Gate Ceiling)",
    subtitle:
      "How much gas LP Ranger will spend, as a fraction of swap value, " +
      "before it skips the swap",
    sections: [
      {
        heading: "What it does",
        body:
          "Before LP Ranger sends any swap &mdash; whether for a rebalance, " +
          "a corrective swap mid-rebalance, or a compound &mdash; it " +
          "estimates how much that swap will cost in gas. If gas would " +
          "exceed this percentage of the swap&rsquo;s USD value, the swap " +
          "is skipped (&ldquo;gas-unfavorable&rdquo;). " +
          "<strong>Default: 1%.</strong> Bounds: 0.1% to 15%. This is " +
          "<strong>one global setting</strong> shared by every position.",
      },
      {
        heading: "Gas % versus minimum swap value",
        body:
          "A lower percentage forces a <strong>larger</strong> minimum " +
          "swap value before LP Ranger will execute. Concretely:<br><br>" +
          "&bull; If the swap costs <strong>$1 in gas</strong> and the " +
          "ceiling is <strong>1%</strong>, the swap value must be at " +
          "least <strong>$100</strong> for the swap to proceed.<br>" +
          "&bull; At <strong>0.1%</strong> (the floor), the same $1 gas " +
          "swap needs <strong>$1,000</strong> of value.<br>" +
          "&bull; At <strong>10%</strong>, only <strong>$10</strong> of " +
          "value is needed &mdash; but you accept that gas will eat 10% " +
          "of the swap.<br><br>" +
          "Raise this value when fees are unusually lucrative and you " +
          "would rather take an immediate hit on gas to keep compounding " +
          "and rebalancing aggressively. Lower it when you want LP Ranger " +
          "to be stricter about preserving value on small operations.",
      },
      {
        heading: "Why Compound usually has to swap",
        body:
          "When LP Ranger compounds, it collects unclaimed fees and " +
          "re-deposits them as liquidity into the same NFT. The Position " +
          "Manager will only accept the two tokens in the exact ratio that " +
          "the position&rsquo;s tick range currently demands &mdash; and " +
          "the collected fees almost never arrive in that ratio. So a " +
          "small <strong>ratio-correcting swap</strong> normally fires " +
          "between the collect and the deposit, converting some of the " +
          "surplus side into the deficient side. This is the swap that " +
          "the Gas Fee % gate evaluates for compounds.",
      },
      {
        heading: "Compound still proceeds when the swap is gated out",
        body:
          "If the gas gate (or the dust gate) skips the ratio-correcting " +
          "swap, the compound is <strong>not</strong> abandoned. LP " +
          "Ranger falls back to depositing only the side of the collected " +
          "fees that already fits the current tick ratio. The other side " +
          "is left in the wallet as a residual and gets folded back in " +
          "on the next rebalance. So you still get partial compounding " +
          "even when the swap is gated out.",
      },
      {
        heading: "Effect on wallet residual sweeps",
        body:
          "Rebalances also trigger a corrective swap when the residual + " +
          "drained tokens don&rsquo;t match the new range&rsquo;s ratio. " +
          "The same Gas Fee % ceiling applies. A very tight ceiling can " +
          "leave wallet residuals uncorrected for longer, since the " +
          "corrective swap may be skipped on smaller residual values.",
      },
      {
        heading: "Safety bounds",
        body:
          "Values below 0.1% would block almost every swap on chains with " +
          "non-trivial gas; values above 15% are well past the point where " +
          "gas eats the trade. The server clamps the value to " +
          "<strong>[0.1, 15]</strong> on every read, so a stale page or a " +
          "corrupt config file can&rsquo;t disable the gate or block all " +
          "swaps.",
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
        heading: "Avoiding overage charges",
        body:
          "<strong>&#9888; Strongly recommended:</strong> after creating " +
          "your Moralis account, open your Moralis account settings and " +
          "<strong>disable overage / pay-as-you-go billing</strong>. " +
          "Most paid API providers &mdash; Moralis included &mdash; " +
          "enable overage charges by default, which means a usage spike " +
          "that exceeds the quota on your current tier (free, or one of " +
          "the various paid levels) can result in unexpected bills. " +
          "Disabling overage caps your account at your current tier: " +
          "requests beyond the quota are refused rather than billed. " +
          "LP Ranger " +
          "tolerates a quota-exhausted Moralis key (it falls back to " +
          "GeckoTerminal automatically), so capping the account costs you " +
          "nothing in functionality. <strong>This same recommendation " +
          "applies to any other optional third-party API key you add to " +
          "LP Ranger</strong> &mdash; check each provider&rsquo;s billing " +
          "settings and turn overage off wherever it is offered.",
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
          "The blockchain RPC endpoint LP Ranger uses to read on-chain " +
          "data and submit transactions. This is your connection to the " +
          "PulseChain network. What you enter here is tried first, and " +
          "the endpoints LP Ranger ships with stay behind it as " +
          "automatic backups \u2014 so using your own node does not cost " +
          "you failover.",
      },
      {
        heading: "Recommended values",
        body:
          "Leave it blank to use the endpoints LP Ranger ships with. The " +
          "dropdown lists them in the order the bot tries them. If you " +
          "run your own PulseChain node, enter its URL here for maximum " +
          "privacy and reliability.",
      },
      {
        heading: "When to change",
        body:
          "Change if you experience RPC timeouts, slow responses, or " +
          "want to use a private node. LP Ranger ships with several " +
          "endpoints and moves down the list automatically when one " +
          "stops responding, sticking with the replacement for an hour " +
          "before trying the preferred one again. " +
          "<strong>The change takes effect immediately</strong> — the " +
          "next on-chain read or transaction uses it. No restart needed.",
      },
    ],
  },

  /*- The `inPM` and `inFactory` entries are gone along with their
   *  fields.  Both promised "Restart the app for the change to take
   *  effect", which was never true: the addresses come from .env /
   *  chains.json, and nothing ever read the saved values back.  They
   *  are not editable from the dashboard by design — both scope the
   *  on-disk caches, so changing one mid-life orphans every cache keyed
   *  to the old address.  docs/configuration.md documents where they live
   *  and why changing them means a fresh install. */

  // ── Rebalance timing ───────────────────────────────────────────────────

  /*- Was a hand-rolled modal (#throttleInfoModal) with its own markup,
   *  its own close buttons and its own show/hide handlers.  Same copy,
   *  now carried by the shared help dialog so it inherits the standard
   *  chrome, dismissal and height bound like every other circle-i. */
  decimalsForce: {
    title: "Force (Token Decimals)",
    subtitle: "Override the decimals read from the token contract",
    sections: [
      {
        heading: "What it does",
        body:
          "If checked, any programmatically-read token value for this " +
          "field is ignored in favor of the manual entry beside it. If " +
          "you are unsure, leave it unchecked &mdash; the value read " +
          "from the token contract is almost always correct.",
      },
      {
        heading: "When you would need it",
        body:
          "Only when the app reports a problem reading this token&rsquo;s " +
          "decimals. A token whose contract does not expose " +
          "<code>decimals()</code>, or an RPC that keeps failing on that " +
          "call, leaves the app without the figure it needs to convert " +
          "raw on-chain amounts into human-readable balances. Entering " +
          "the correct value and forcing it lets the position be " +
          "managed.",
      },
      {
        heading: "Get it right",
        body:
          "Decimals are a property of the token, not a preference. A " +
          "wrong value does not fail loudly &mdash; it silently scales " +
          "every amount and every dollar figure for this token by a " +
          "power of ten. Check the token&rsquo;s contract on a block " +
          "explorer before forcing a value.",
      },
    ],
  },

  rebalancesThisPeriod: {
    title: "Number of Rebalances Done This Period",
    subtitle: "Today's rebalance count for this pool, against the daily cap",
    sections: [
      {
        heading: "What it counts",
        body:
          "How many rebalances this pool has run so far today, against " +
          "the <strong>Max Rebalances / Day</strong> cap set in Bot " +
          "Settings. Every successful rebalance counts, no matter what " +
          "triggered it &mdash; automatic out-of-range, OOR-timeout, " +
          "automatic residual-cleanup follow-ons, and manual " +
          "<strong>Rebalance Now</strong> clicks alike.",
      },
      {
        heading: "When it resets",
        body:
          "At <strong>midnight UTC</strong>, not at your local midnight. " +
          "Once the count reaches the cap the throttle badge reads " +
          "CAPPED and no automatic rebalance runs for this pool until " +
          "the reset (or until you raise the setting). A manual " +
          "Rebalance Now still works while capped &mdash; but it adds to " +
          "the count like any other rebalance.",
      },
      {
        heading: "Per pool, not per wallet",
        body:
          "Each pool carries its own daily count against the same cap " +
          "value, so a volatile pair burning through its allowance does " +
          "not stop a quiet one from rebalancing.",
      },
      {
        heading: "Why it can read N/A",
        body:
          "Shown only for <strong>managed</strong> positions. An " +
          "unmanaged position has no bot loop running for it, so there " +
          "is nothing counting and nothing to report &mdash; it reads " +
          "N/A rather than <strong>0</strong>, so an idle position is " +
          "never mistaken for one the bot is watching.",
      },
    ],
  },

  rebalanceInterval: {
    title: "Rebalance Interval",
    subtitle: "The cooldown between rebalances, and the time left on it",
    sections: [
      {
        heading: "What it shows",
        body:
          "The minimum time that must pass between two rebalances of " +
          "this pool, or the countdown until the next one is allowed. " +
          "It comes from <strong>Min Time Between Rebalances</strong> in " +
          "Bot Settings &mdash; the saved value, not whatever is " +
          "currently typed in the field.",
      },
      {
        heading: "When the cooldown is longer than it looks",
        body:
          "If <strong>doubling mode</strong> is active, the wait is " +
          "longer than the Min Time setting: three or more rebalances " +
          "inside 4&times; the minimum interval doubles the cooldown " +
          "after each one (10m &rarr; 20m &rarr; 40m &rarr; 80m, and so " +
          "on) until the pool goes quiet for 4&times; the current wait " +
          "or the day resets at midnight UTC. The throttle badge in Bot " +
          "Settings reads DOUBLING while that is in effect.",
      },
      {
        heading: "It shapes timing, not triggering",
        body:
          "This is a gate, not a trigger: it never causes a rebalance, " +
          "it only delays one that something else has already asked " +
          "for. What asks for it is the position going out of range " +
          "past your OOR threshold, or the OOR time threshold expiring.",
      },
      {
        heading: "Why it can read N/A",
        body:
          "Shown only for <strong>managed</strong> positions. An " +
          "unmanaged position has no bot loop, so nothing is scheduled " +
          "and there is no cooldown to be waiting on.",
      },
    ],
  },

  throttleBadge: {
    title: "Rebalance Timing & Throttle",
    subtitle: "What the badge next to this section is telling you",
    sections: [
      {
        heading: "OK",
        body:
          "<strong>OK</strong> means the bot is free to rebalance " +
          "whenever the position goes out of range. No cooldown or rate " +
          "limit is active.",
      },
      {
        heading: "THROTTLED",
        body:
          "<strong>THROTTLED</strong> appears during the minimum-interval " +
          "cooldown. After each rebalance, the bot waits at least the " +
          "configured &ldquo;Min Time Between Rebalances&rdquo; before " +
          "allowing the next one. This prevents unnecessary rapid-fire " +
          "rebalancing.",
      },
      {
        heading: "DOUBLING",
        body:
          "<strong>DOUBLING</strong> activates when 3 or more rebalances " +
          "occur within 4&times; the minimum interval. DOUBLING means " +
          "that the rebalance must cool down just like under regular " +
          "THROTTLED. It also means that the cool-down period is longer " +
          "than under THROTTLED. The cooldown doubles after each " +
          "rebalance: 10m &rarr; 20m &rarr; 40m &rarr; 80m, and so on. " +
          "This protects against excessive gas spending and excessive " +
          "loss to slippage and swap fees during high volatility. " +
          "Doubling mode clears automatically after 4&times; the Min " +
          "Time Between Rebalances with no rebalance, or at the daily " +
          "midnight UTC reset. For example, if the cooldown window is " +
          "now 20 minutes, the Min Time Between Rebalances is 10 minutes " +
          "as set here in this UI, and there has been no rebalance for " +
          "40 minutes, then Doubling mode clears.",
      },
      {
        heading: "NEAR LIMIT",
        body:
          "<strong>NEAR LIMIT</strong> is a heads-up, not a brake: the " +
          "pool has used <strong>80% or more</strong> of its " +
          "&ldquo;Max Rebalances / Day&rdquo; allowance and nothing is " +
          "being blocked yet. At the default of 5 per day it appears " +
          "once the 4th rebalance lands, leaving one before the pool " +
          "goes CAPPED. If you expect more volatility before the " +
          "midnight UTC reset, this is your cue to raise Max " +
          "Rebalances / Day &mdash; after the cap is hit, automatic " +
          "rebalances stop until the reset.",
      },
      {
        heading: "CAPPED",
        body:
          "<strong>CAPPED</strong> means this pool&rsquo;s daily " +
          "rebalance limit (&ldquo;Max Rebalances / Day&rdquo;) has been " +
          "reached. Every successful rebalance counts toward the limit, " +
          "no matter what triggered it &mdash; automatic out-of-range " +
          "rebalances, automatic residual-cleanup follow-ons, and manual " +
          "&ldquo;Rebalance Now&rdquo; clicks alike. While CAPPED, no " +
          "automatic rebalance runs until the counter resets at midnight " +
          "UTC or the setting is raised. A manual &ldquo;Rebalance " +
          "Now&rdquo; still works while CAPPED &mdash; but it also adds " +
          "to the count like any other rebalance.",
      },
      {
        heading: "N/A",
        body:
          "<strong>N/A</strong> means the position you are looking at is " +
          "not under management &mdash; you have not clicked " +
          "<strong>Manage</strong> on it, or you stopped managing it. " +
          "Rebalance timing only describes a running bot loop: an " +
          "unmanaged position has no cooldown to be waiting on, no " +
          "daily counter, and nothing scheduled, so there is no state " +
          "for the badge to report. The badge reads N/A rather than " +
          "<strong>OK</strong> so that an idle position is never " +
          "mistaken for one the bot is watching. Every setting in this " +
          "section can still be edited and saved while the position is " +
          "unmanaged; the values are stored against the position and " +
          "take effect as soon as you click Manage.",
      },
      {
        heading: "Only one shows at a time",
        body:
          "More than one of these can be true at once, and the badge " +
          "shows the most binding one. The order is <strong>N/A, " +
          "CAPPED, DOUBLING, THROTTLED, NEAR LIMIT, OK</strong> " +
          "&mdash; the first that applies wins. So a pool sitting at 4 " +
          "of 5 rebalances but still inside its cooldown reads " +
          "THROTTLED rather than NEAR LIMIT: the cooldown is what is " +
          "actually stopping it right now.",
      },
    ],
  },

  // ── Fees (Current panel) ───────────────────────────────────────────────

  curFees: {
    title: "Fees Earned (Current Position)",
    subtitle: "Trading fees this NFT has accrued and not yet collected",
    sections: [
      {
        heading: "What it includes",
        body:
          "<strong>Fees Earned</strong> in the <strong>Current</strong> " +
          "panel does <strong>not</strong> include fees compounded. Find " +
          "those in the line directly below.<br><br>" +
          "This figure is what the position has accrued and still holds " +
          "unclaimed. The moment a compound runs, those fees are " +
          "collected and re-deposited as liquidity, so they leave this " +
          "line and appear on <strong>Fees Compounded</strong> instead. " +
          "The two never overlap, which is why they are added together " +
          "rather than one being subtracted from the other.",
      },
      {
        heading: "If the number looks off",
        body:
          "Every dollar figure here is an on-chain token amount " +
          "multiplied by a token price. The amounts come from the " +
          "blockchain and are reliable; the prices come from third-party " +
          "feeds, which can occasionally serve a bad value &mdash; most " +
          "often during heavy volatility, or on a pair whose two tokens " +
          "share a symbol.<br><br>" +
          "To correct it, you can try <strong>Settings</strong> (gear " +
          "icon at top right) &rarr; <strong>Re-scan Prices</strong>. " +
          "That re-values this position at freshly fetched prices in " +
          "seconds, and does not touch the position, your funds, or its " +
          "on-chain history.",
      },
    ],
  },

  curCompounded: {
    title: "Fees Compounded (Current Position)",
    subtitle: "Fees already re-deposited as liquidity in THIS NFT",
    sections: [
      {
        heading: "What it includes",
        body:
          "Trading fees that were collected and re-deposited as " +
          "liquidity into the NFT you are looking at now. They are no " +
          "longer unclaimed, so they are not counted on the " +
          "<strong>Fees Earned</strong> line above &mdash; the two lines " +
          "are separate halves of the same total.<br><br>" +
          "Scope is this NFT only. Every rebalance mints a new NFT, so " +
          "compounds that happened on earlier NFTs in this pool are not " +
          "here; the <strong>Lifetime</strong> panel&rsquo;s Fees " +
          "Compounded figure covers the whole chain.",
      },
      {
        heading: "If the number looks off",
        body:
          "Each compound is recorded at the token prices that were live " +
          "when it ran, and a stored figure is treated as authoritative " +
          "afterwards &mdash; it is not rebuilt from the chain on its " +
          "own. One bad price reading therefore sticks rather than " +
          "correcting itself on the next poll.<br><br>" +
          "To correct it, you can try <strong>Settings</strong> (gear " +
          "icon at top right) &rarr; <strong>Re-scan Prices</strong>. " +
          "That re-values this position at freshly fetched prices in " +
          "seconds, and does not touch the position, your funds, or its " +
          "on-chain history.",
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
          "Profit = Fees Earned + Fees Compounded &minus; Gas " +
          "+/&minus; Impermanent Loss/Gain (IL/G).<br><br>" +
          "Both fee figures are added because both are real earnings: " +
          "<strong>Fees Earned</strong> are still unclaimed, and " +
          "<strong>Fees Compounded</strong> have already been swept back " +
          "into liquidity. IL/G does not carry either of them &mdash; it " +
          "measures only the difference between holding the tokens in the " +
          "LP versus simply holding them in your wallet, so counting the " +
          "fees here counts them exactly once.",
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
          "Profit = Current Fees + Fees Compounded &minus; Gas " +
          "+/&minus; Impermanent Loss/Gain (IL/G).<br><br>" +
          "<strong>Current Fees</strong> are the trading fees that have " +
          "accrued in the active position but have not yet been " +
          "compounded. <strong>Fees Compounded</strong> are fees that " +
          "have already been swept back into liquidity (via standalone " +
          "compound actions or rebalance-time re-deposits). Adding the " +
          "two gives total fee earnings across this pool&rsquo;s rebalance " +
          "chain. <strong>Gas</strong> covers all rebalance and compound " +
          "transaction costs. IL/G carries neither fee figure, so adding " +
          "them here counts them exactly once.",
      },
      {
        heading: "How it differs from Net P&L",
        body:
          "<strong>Lifetime Net P&amp;L</strong> adds Price Change " +
          "(Current Value &minus; Total Lifetime Deposit), Wallet " +
          "Residual, and Realized Gains. Profit excludes those, showing " +
          "how the pool performed purely as a fee-generating instrument. " +
          "Click the (i) next to the Net P&amp;L figure above for the " +
          "full breakdown.",
      },
    ],
  },

  // ── Fees Compounded (Lifetime) ─────────────────────────────────────────

  ltCompounded: {
    title: "Fees Compounded",
    subtitle: "Trading fees that were re-deposited as liquidity",
    sections: [
      {
        heading: "What it includes",
        body:
          "<strong>Both</strong> kinds of fee re-deposits across this " +
          "pool&rsquo;s lifetime:<br>" +
          "&bull; <strong>Standalone compounds</strong> &mdash; auto- and " +
          "manual-compound actions that collect fees and re-deposit them " +
          "into the same NFT (no new NFT, no swap, no range change).<br>" +
          "&bull; <strong>Rebalance-time compounds</strong> &mdash; when " +
          "a position is drained for a rebalance, the collect call " +
          "extracts both the drained principal and the accumulated " +
          "fees. The fees portion is then re-deposited into the new NFT " +
          "as part of the mint.",
      },
      {
        heading: "How it\u2019s calculated",
        body:
          "<strong>Rebalance-time compounds:</strong> across every NFT " +
          "in the rebalance chain, we sum what was drawn out by collect " +
          "calls and subtract what was originally drained as principal. " +
          "What remains is the fees portion, which was re-deposited " +
          "into the new NFT during the rebalance mint.<br><br>" +
          "<strong>Standalone compounds:</strong> for each manual or " +
          "auto compound action, the value re-deposited as liquidity is " +
          "added to the lifetime total. Both kinds are included in the " +
          "single number shown.",
      },
      {
        heading: "How it\u2019s used in Net P&L",
        body:
          "Fees Compounded is added (along with Current Fees) to give " +
          "total lifetime fee earnings.  No subtraction is needed: " +
          "compounded fees represent real earnings already swept back " +
          "into liquidity, while Current Fees are still unclaimed and " +
          "will be compounded next.  Price Change is computed against " +
          "Total Lifetime Deposit, so the rise in Current Value from " +
          "compounded fees doesn&rsquo;t double-count.",
      },
      {
        heading: "Why this figure may slightly overstate",
        body:
          "Some coins counted here may not currently be back in the " +
          "position&rsquo;s liquidity. When the bot adds liquidity, it " +
          "can only deposit tokens in the exact ratio the current tick " +
          "range demands &mdash; any leftover stays in the wallet as " +
          "residual. A sudden price move mid-rebalance can also leave " +
          "coins behind. These residuals typically get re-deposited on " +
          "a subsequent rebalance.",
      },
      {
        heading: "If the number looks off",
        body:
          "Every dollar figure here is an on-chain token amount " +
          "multiplied by a token price. The amounts come from the " +
          "blockchain and are reliable; the prices come from third-party " +
          "feeds, which can occasionally serve a bad value &mdash; most " +
          "often during heavy volatility, or on a pair whose two tokens " +
          "share a symbol. Each compound is recorded at the prices that " +
          "were live when it ran, and a stored figure is treated as " +
          "authoritative afterwards, so one bad reading sticks rather " +
          "than correcting itself.<br><br>" +
          "To correct it, you can try <strong>Settings</strong> (gear " +
          "icon at top right) &rarr; <strong>Re-scan Prices</strong>. " +
          "That re-values this position at freshly fetched prices in " +
          "seconds, and does not touch the position, your funds, or its " +
          "on-chain history.",
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
          "token prices.  Edit manually only if the auto-detected value " +
          "is clearly wrong (e.g. for meme tokens with unreliable price " +
          "feeds).",
      },
      {
        heading: "Buttons on the edit dialog",
        body:
          "<strong>Save</strong> stores the amount you typed as the " +
          "manual override.  <strong>Return to Automatic Detection</strong> " +
          "clears the override and lets the bot's historical-price " +
          "auto-detection take over again.  <strong>Cancel</strong> just " +
          "closes the dialog without changing anything.",
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
      {
        heading: "Buttons on the edit dialog",
        body:
          "<strong>Save</strong> stores the amount you typed.  " +
          "<strong>Return to Automatic Detection</strong> clears the " +
          "value back to $0 (there is no on-chain auto-detection for " +
          "realized gains, so the default state is zero).  " +
          "<strong>Cancel</strong> just closes the dialog without " +
          "changing anything.",
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
          "events and valuing them at historical prices.  Edit manually " +
          "only if auto-detection is inaccurate.",
      },
      {
        heading: "Buttons on the edit dialog",
        body:
          "<strong>Save</strong> stores the amount you typed as the " +
          "manual override.  <strong>Return to Automatic Detection</strong> " +
          "clears the override and lets the bot's auto-detected deposit " +
          "take over again.  <strong>Cancel</strong> just closes the " +
          "dialog without changing anything.",
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
          "Current Fees, Fees Compounded, Gas, and Realized Gains to " +
          "produce the Net P&amp;L figure, click the (i) button next to " +
          "the <strong>Net Profit and Loss Return</strong> value at the " +
          "top of this Lifetime panel.",
      },
    ],
  },

  lifetimeDaysInput: {
    title: "Total Lifetime Days",
    sections: [
      {
        heading: "What it is",
        body:
          "The number of days this liquidity pool has been active for " +
          "you.  Drives the &ldquo;Days&rdquo; readout next to the Net " +
          "Profit &amp; Loss Return figure and the APR denominators " +
          "throughout the Lifetime panel.",
      },
      {
        heading: "How it's determined",
        body:
          "<strong>If you enter a value here, it wins outright.</strong> " +
          "Otherwise the bot auto-detects the start date by picking the " +
          "mint date of the oldest NFT (for the current liquidity pool) " +
          "on the current wallet.  If that NFT was originally minted on " +
          "a different wallet and later transferred here, the bot uses " +
          "its <em>true</em> mint block rather than the arrival date, " +
          "so time spent on the previous wallet still counts.",
      },
      {
        heading: "When to edit",
        body:
          "Edit manually whenever auto-detection is off &mdash; for " +
          "example, if the NFT was minted more than 5 years ago (outside " +
          "the scan window) or spent time on multiple prior wallets. " +
          "Type the number of days you want to see right now; tomorrow " +
          "the display will read one higher, the day after that one " +
          "higher again, and so on &mdash; you never need to re-edit as " +
          "time passes.",
      },
      {
        heading: "Buttons on the edit dialog",
        body:
          "<strong>Save</strong> stores the days you typed as the manual " +
          "override.  <strong>Return to Automatic Detection</strong> " +
          "clears the override and lets the auto-detected start date take " +
          "over again.  <strong>Cancel</strong> just closes the dialog " +
          "without changing anything.",
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
      {
        heading: "Buttons on the edit dialog",
        body:
          "<strong>Save</strong> stores the amount you typed.  " +
          "<strong>Return to Automatic Detection</strong> clears the " +
          "value back to $0 (there is no on-chain auto-detection for " +
          "realized gains, so the default state is zero).  " +
          "<strong>Cancel</strong> just closes the dialog without " +
          "changing anything.",
      },
    ],
  },

  // ── Rebalance Events ───────────────────────────────────────────────────

  perDayPnl: {
    title: "Per-Day P&L ($USD)",
    sections: [
      {
        heading: "What this table shows",
        body:
          "One row per day on which something actually happened to this " +
          "position &mdash; a rebalance closed, fees were collected, gas " +
          "was spent. Days where nothing happened are omitted rather than " +
          "shown as a row of dashes, so every row you see carries figures " +
          "and the table stays short enough to read.",
      },
      {
        heading: "Where the data comes from",
        body:
          "Each rebalance closes an accounting period and opens the next " +
          "one. A closed period&rsquo;s totals are attributed to the day it " +
          "closed, so a single row can cover several days of activity " +
          "&mdash; it is not a per-day split of that period. The most " +
          "recent row is the period still open, updating as the position " +
          "earns.",
      },
      {
        heading: "Price P&L",
        body:
          "How far the position&rsquo;s dollar value moved over the period, " +
          "with fees taken out. This follows the two tokens&rsquo; prices " +
          "and nothing else. On a volatile pair it can dominate every " +
          "other column in both directions, and it says nothing about " +
          "whether the position was a good place to put the coins &mdash; " +
          "the same move would have happened had you simply held them.",
      },
      {
        heading: "Profit",
        body:
          "Fees earned, minus gas, plus or minus impermanent loss/gain. " +
          "This is the position judged as a fee-earning instrument: did " +
          "the fees it collected outrun what the pool cost you compared " +
          "with simply holding the coins? Token price movement is " +
          "deliberately excluded, so a period can show a healthy Profit " +
          "while prices fell, or a poor one while they rose.",
      },
      {
        heading: "Net P&L",
        body:
          "The same sum as Lifetime Net P&L, scoped to one day: fees, " +
          "minus gas, plus the change in value. This is what your holdings " +
          "actually did over the period, price movement included.",
      },
      {
        heading: "Profit and Net P&L are not the same question",
        body:
          "<strong>Net P&L</strong> answers &ldquo;did I end up with more " +
          "money?&rdquo; &mdash; it includes price movement, which you " +
          "would have been exposed to anyway. <strong>Profit</strong> " +
          "answers &ldquo;was providing liquidity worth it?&rdquo; &mdash; " +
          "it replaces price movement with impermanent loss, which is the " +
          "part the pool is responsible for. A position can be up on Net " +
          "P&L purely because its tokens rallied, while Profit shows the " +
          "fees never covered the impermanent loss.",
      },
      {
        heading: "When Profit shows a dash",
        body:
          "Profit needs the token amounts deposited at that period&rsquo;s " +
          "mint in order to work out impermanent loss. A few older periods " +
          "were recorded without them. <strong>Settings &rarr; Reload " +
          "Current Position</strong> re-reads them from the blockchain and " +
          "fills the gaps.",
      },
    ],
  },

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

  // ── Wallet Residual ────────────────────────────────────────────────────

  /*- The Residual column in the Per-Day P&L table.  Was a hover-only
   *  tooltip, which no touch device could reach. */
  perDayInOut: {
    title: "In/Out",
    subtitle: "Value moving between your wallet and the position",
    sections: [
      {
        heading: "What the column shows",
        body:
          "At every rebalance the old position is drained and a new one " +
          "minted. The two rarely match to the dollar, and this column is " +
          "the difference: value that left the position for your wallet, " +
          "or went the other way.",
      },
      {
        heading: "Reading the sign",
        body:
          "<strong>Positive</strong> means value came back OUT to your " +
          "wallet &mdash; the new position opened smaller than the old one " +
          "closed. <strong>Negative</strong> means value went IN, either " +
          "leftovers being swept up or a deposit you made. Same direction " +
          "as Wallet Residual (Pool) in the Lifetime panel.",
      },
      {
        heading: "It is more than leftover dust",
        body:
          "Tick spacing and swap rounding leave small amounts behind at " +
          "each rebalance, and those show here. So does anything larger: " +
          "add funds between rebalances and the day shows a big negative " +
          "figure. That breadth is why the column is not called " +
          "&ldquo;Residual&rdquo; &mdash; it is not only dust.",
      },
      {
        heading: "It is not a loss",
        body:
          "Coins on the wallet are still yours. They are counted in " +
          "Lifetime figures and credited against Impermanent Loss/Gain, so " +
          "a large figure here moves the column without changing what you " +
          "own.",
      },
    ],
  },

  ltResidual: {
    title: "Wallet Residual (Pool)",
    subtitle: "Pool tokens sitting in the wallet between rebalances",
    sections: [
      {
        heading: "What it is",
        body:
          "When the bot rebalances, it removes liquidity and mints a new " +
          "position. Small amounts of the pool&rsquo;s two tokens are " +
          "typically left in the wallet afterward. Two unavoidable " +
          "sources:<br>" +
          "&bull; <strong>Tick spacing.</strong> V3 positions can only " +
          "use tick boundaries that are multiples of the fee tier&rsquo;s " +
          "tick spacing, so the new range almost never lines up with the " +
          "exact ratio the wallet holds. The Position Manager mints with " +
          "the largest aligned amount of each token it can, and any " +
          "remainder stays in the wallet.<br>" +
          "&bull; <strong>Price movement while the mint is being " +
          "requested.</strong> The required token ratio is computed " +
          "against the pool&rsquo;s tick at quote time. Between then and " +
          "when the mint TX confirms, the tick can shift &mdash; so the " +
          "ratio the Position Manager actually accepts differs from what " +
          "we offered, leaving the surplus token in the wallet.<br>" +
          "LP Ranger tracks these per-pool as your <strong>wallet " +
          "residual</strong>.",
      },
      {
        heading: "Why it appears in Lifetime P&L",
        body:
          "Current Value in P&amp;L is LP-only (it doesn&rsquo;t know about " +
          "wallet balances). Between rebalances, residual is real value you " +
          "hold but isn&rsquo;t reflected in the position&rsquo;s Price " +
          "Change. Surfacing it here keeps Lifetime P&amp;L honest without " +
          "double-counting: on the next rebalance the residual is folded " +
          "back into the mint, Price Change rises by the same amount, and " +
          "this row drops to zero.",
      },
      {
        heading: "Capping",
        body:
          "The value shown is <strong>capped to the wallet&rsquo;s current " +
          "balance</strong> of each token. If you sold or transferred one " +
          "of the pool&rsquo;s tokens out, that portion won&rsquo;t be " +
          "double-counted here &mdash; use <strong>Edit Realized Gains</strong> " +
          "to record sales.",
      },
      {
        heading: "Related",
        body:
          "See also <strong>Initial Wallet Residual (Pool)</strong> &mdash; the " +
          "subtraction that removes the post-first-mint baseline from " +
          "Lifetime Net P&amp;L so the unavoidable leftover from the " +
          "initial LP creation doesn&rsquo;t inflate profit.",
      },
    ],
  },

  // ── Initial Wallet Residual ────────────────────────────────────────────

  ltInitialResidual: {
    title: "Initial Wallet Residual (Pool)",
    subtitle:
      "What the wallet was left holding right after the very first LP " +
      "mint for this pool — the baseline that subsequent residuals are " +
      "measured against",
    sections: [
      {
        heading: "What it is",
        body:
          "The wallet&rsquo;s balances of <strong>token0</strong> and " +
          "<strong>token1</strong> at the <em>end</em> of the block " +
          "containing the very first <code>IncreaseLiquidity</code> event " +
          "for this (blockchain, NFT factory, wallet, token pair, fee " +
          "tier) scope &mdash; i.e. what was sitting in the wallet " +
          "immediately after the initial LP mint consumed its inputs, but " +
          "before any other LP action (rebalance, compound, second " +
          "deposit) for this pool.<br><br>" +
          "Valued in USD using historical prices at that same first-mint " +
          "block (frozen &mdash; see &ldquo;Frozen valuation&rdquo; below).",
      },
      {
        heading: "Why it’s subtracted from Lifetime P&L",
        body:
          "The live <strong>Wallet Residual (Pool)</strong> figure reads " +
          "the wallet&rsquo;s current balances and counts every coin sitting " +
          "there as LP-adjacent value. The leftover from the initial mint " +
          "(tick-spacing remainder, plus anything the wallet happened to " +
          "be holding that the mint didn&rsquo;t touch) is part of that " +
          "starting line, not LP-derived earnings. Subtracting the " +
          "post-first-mint snapshot isolates the residual contributed by " +
          "subsequent rebalances and compounds, which is what should " +
          "actually count toward Lifetime Net P&amp;L.",
      },
      {
        heading: "Frozen valuation",
        body:
          "Both the token amounts <em>and</em> the USD prices are captured " +
          "once at the first-mint block and never change. If we revalued " +
          "the post-first-mint balances at current prices, the subtracted " +
          "dollar amount would shift with the market and erase any " +
          "price-appreciation credit on those very tokens. Freezing the " +
          "valuation means: the baseline coins still earn you the benefit " +
          "of any subsequent price moves, but the bot doesn&rsquo;t claim " +
          "credit for them as LP-derived gains.",
      },
      {
        heading: "When it’s zero",
        body:
          "If the wallet held no token0 or token1 immediately after the " +
          "first mint (i.e. the mint consumed essentially everything and " +
          "the wallet had no unrelated leftover of these tokens), this " +
          "subtraction is $0 and the line just shows as such. The same " +
          "applies before the first historical scan has completed for a " +
          "managed position, or for unmanaged positions where the cache " +
          "hasn&rsquo;t been populated yet.",
      },
      {
        heading: "Related",
        body:
          "See also <strong>Wallet Residual (Pool)</strong> &mdash; the " +
          "live, current-price figure that this subtraction adjusts.",
      },
    ],
  },

  // ── Activity Log ───────────────────────────────────────────────────────

  activityLog: {
    title: "Activity Log",
    sections: [
      {
        heading: "Detail availability",
        body:
          "Detailed Activity Log info is only available for " +
          "<strong>Managed</strong> positions.",
      },
    ],
  },

  // ── Routed Via (Rebalance Events table) ────────────────────────────────

  routedVia: {
    title: "Routed Via",
    sections: [
      {
        heading: "Detail availability",
        body:
          "Only available for rebalances done by this installation of " +
          "the app.",
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
