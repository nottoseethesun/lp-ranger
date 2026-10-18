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
import { fillEntryFigures } from "../src/help-figures.js";
import { CENTERED_OFFSET_PCT } from "../src/centered-offset.js";
/*-
 *  Ranges are read from the shipped file alone, on the server too, so
 *  this bundled copy's are the ones in force.
 */
import SETTING_BOUNDS from "../app-config/app-defaults-for-user-configurable/setting-bounds.json" with { type: "json" };

const _DAILY_RANGE = SETTING_BOUNDS.maxRebalancesPerDay;
const _INTERVAL_RANGE = SETTING_BOUNDS.minRebalanceIntervalMin;
const _OOR_RANGE = SETTING_BOUNDS.rebalanceOutOfRangeThresholdPercent;
const _TIMEOUT_RANGE = SETTING_BOUNDS.rebalanceTimeoutMin;
const _SLIP_RANGE = SETTING_BOUNDS.slippagePctToken0;
const _GAS_FEE_RANGE = SETTING_BOUNDS.gasFeePct;

/** "1 minute", "10 minutes". */
function _minutes(n) {
  return n === 1 ? "1 minute" : n + " minutes";
}

/**
 * Every dialog's help, filled in from `f`, the figures the server sends
 * for this install (`GET /api/help-figures`). Built when a dialog opens,
 * since those arrive after load.
 *
 * @param {Readonly<Record<string, string>>} f  The help figures.
 * @returns {Record<string, {title: string, sections: {heading: string, body: string}[]}>}
 */
export function buildParamHelp(f) {
  const _ILG = fillEntryFigures(SHARED_HELP.inIlGuard, f);
  // The Guard's low-volume advice, shown in the Max Rebalances dialog too.
  const _LOW_VOLUME = _ILG.sections.find((s) => s.id === "lowVolume");
  // The trigger, worded "<count> rebalances within <n>×".
  const _TRIGGER =
    f.doublingTriggerCount +
    " rebalances within " +
    f.doublingTriggerWindowMultiple +
    "&times;";
  return {
    inIlGuard: _ILG,
    // ── Range ───────────────────────────────────────────────────────────────

    rangeOverrideToggle: {
      title: "No Override",
      subtitle: "Whether the Range settings below apply on the next rebalance",
      sections: [
        {
          heading: "What the toggle does",
          body:
            "This one switch decides where the next rebalance gets its " +
            "price range from. It governs every setting in this section " +
            "at once: the <strong>Price Range Extension</strong>, its " +
            "<strong>Full-Range</strong> checkbox, and the " +
            "<strong>Position Offset</strong>.",
        },
        {
          heading: "Re-Use Existing Position Range",
          body:
            "The toggle is <strong>on</strong>, which is where every " +
            "position starts. The bot carries this position's current " +
            "on-chain price range across the rebalance and re-centres it " +
            "on the price at that moment, so the new position is as wide " +
            "as the one it replaces. None of the settings below is " +
            "applied, and they are disabled. Only standard liquidity-pool " +
            "tick rounding can shift the width, by up to one tick-spacing " +
            "per rebalance.",
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
            "and they are back in force unchanged.",
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
            "the lower and upper price bounds. At a centered 50/50 offset, " +
            "a value of <strong>50</strong> means the position spans 25% " +
            "below current price and 25% above current price at each " +
            "rebalance (so 0.75x to 1.25x current price). A value of " +
            "<strong>10</strong> spans +/-5% around current price " +
            "(0.95x to 1.05x).<br>" +
            "It applies only while the <strong>No Override</strong> " +
            "toggle at the top of the Range section is off. Turning that " +
            "toggle on disables this field without erasing what you saved.",
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
            "position.",
        },
        {
          heading: "Range Width vs Price Range Extension",
          body:
            "<strong>Price Range Extension</strong> (this field) measures " +
            "how far the position reaches from current price. " +
            "<strong>Range Width</strong> is a different measure: the " +
            "share of the pool's populated liquidity range that a " +
            "position covers. LP Ranger uses only Price Range Extension. " +
            "Other LP apps (e.g. 9mm's own UI) may label their width " +
            'slider in yet a third way, so a "50% position" you set up ' +
            'there may not read as "50" here.',
        },
        {
          heading: "When empty (unset)",
          body:
            "Leaving this field empty tells the bot to <strong>preserve the " +
            "position&rsquo;s existing width</strong> at every rebalance -- the " +
            "position's on-chain tick spread is carried across the " +
            "rebalance and placed around the current price by the " +
            "<strong>Position Offset</strong>, centred when it is " +
            CENTERED_OFFSET_PCT +
            "%, subject only to standard liquidity-pool tick rounding " +
            "(which may drift the spread by up to one tick-spacing per " +
            "rebalance). The input stays empty until you type an explicit " +
            "value.",
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
            "<strong>Default</strong>: fills the input with the default " +
            "from bot-config-defaults.json, your own copy's if you made " +
            "one, and unticks " +
            "<strong>Full-Range</strong> -- asking for a default " +
            "extension is asking not to mint full-range, and the two " +
            "cannot both apply. You still have to click " +
            "<strong>Save</strong> to persist either change.<br>" +
            "<strong>Save</strong>: writes the extension and the " +
            "Full-Range setting to the per-position config together; " +
            "they apply on the next rebalance.",
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
            "more rebalance costs. The setting is saved per position, so " +
            "you can tune each pair independently.",
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
          heading:
            "Relation to the Bot Configuration Price Range Extension input",
          body:
            "This is the same concept as the <strong>Price Range Extension" +
            "</strong> input in Bot Configuration, just presented as two numbers " +
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
            "range.",
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
            "<strong>" +
            _OOR_RANGE.min +
            "%</strong> (minimum) &mdash; rebalances almost as soon as " +
            "price exits the range. This can cause excessive gas spending " +
            "and slippage during volatility.<br>" +
            "<strong>" +
            _OOR_RANGE.max +
            "%</strong> (maximum) &mdash; price must travel " +
            _OOR_RANGE.max +
            "% of the range-width past the boundary (e.g. for a " +
            "$1.00&ndash;$1.20 range, down to $" +
            (1 - (0.2 * _OOR_RANGE.max) / 100).toFixed(2) +
            " or up to $" +
            (1.2 + (0.2 * _OOR_RANGE.max) / 100).toFixed(2) +
            "). Note that for a narrow position this is still a small, " +
            "routine price move &mdash; the trigger stays live. Only for " +
            "very wide ranges does it become practically unreachable, " +
            "leaving the OOR Rebalance Time Threshold (if set) as the " +
            "sole trigger.",
        },
        {
          heading: "Related parameters",
          body:
            "A rebalance this threshold triggers still has to pass the " +
            "<strong>Min Time Between Rebalances</strong> cooldown, " +
            "<strong>Doubling Mode</strong> and the <strong>Max " +
            "Rebalances / Day</strong> cap, which throttle how often " +
            "rebalances can occur.",
        },
      ],
    },

    inOorTimeout: {
      title: "OOR Rebalance Time Threshold (minutes)",
      subtitle:
        "How long the position may stay out of range before a rebalance",
      sections: [
        {
          heading: "What it does",
          body:
            "Triggers a rebalance once your position has been out of " +
            "range for this many minutes without a break, even if the " +
            "price never crosses the OOR Threshold. The countdown starts " +
            "at the first out-of-range poll and resets when the price " +
            "returns to range or a rebalance succeeds.",
        },
        {
          heading: "Which rebalances it applies to",
          body:
            "This is a second trigger for <strong>automatic</strong> " +
            "rebalances only. Residual-cleanup and manual " +
            "<strong>Rebalance Now</strong> rebalances do not consult it. " +
            "A timeout-triggered rebalance still has to pass " +
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
            "<strong>" +
            _TIMEOUT_RANGE.max +
            " (" +
            _TIMEOUT_RANGE.max / 60 +
            " hours)</strong> &mdash; maximum. Very unlikely to trigger " +
            "in practice.",
        },
        {
          heading: "Related parameters",
          body:
            "Complements <strong>OOR Threshold</strong>. Together they form " +
            "a dual-trigger: &ldquo;rebalance if price moves X% of the " +
            "range width past the boundary, OR if it stays out of range " +
            "for Y minutes, whichever comes first.&rdquo;",
        },
      ],
    },

    inSlipToken0: {
      title: "Slippage When Swapping to Token 0 (%)",
      subtitle: "Per-position slippage for the Token 0 side of swaps",
      sections: [
        {
          heading: "What it does",
          body:
            "Sets the slippage tolerance for swaps whose DESTINATION is " +
            "Token 0, i.e. swaps that CONVERT Token 1 into Token 0. For " +
            "example, when {{token1}} is traded for {{token0}}. Each " +
            "token of the pair has its own setting because liquidity is " +
            "often lopsided: on a $texan/$wPls pair, $texan is thin and " +
            "needs a high slippage to complete swaps, but that same high " +
            "slippage on the $wPls side would open the $wPls swap up to " +
            "MEV front-running for no gain.",
        },
        {
          heading: "The destination-token rule",
          body:
            "Slippage is applied by the destination token of the swap, " +
            "not the source. A swap that CONVERTS Token 1 INTO Token 0 " +
            "uses this field. A swap that CONVERTS Token 0 INTO Token 1 " +
            "uses <strong>Slippage When Swapping to Token 1</strong> " +
            "instead. The destination side is where MEV can extract value " +
            "from the swap, so that is where the slippage budget lives.",
        },
        {
          heading: "Default value",
          body:
            "The input starts populated with the default (" +
            f.slippageDefaultPct +
            "%). That is the value the bot uses if you never change it. " +
            "Change the input and click Save to persist a different value " +
            "for this position.",
        },
        {
          heading: "Allowed range and warnings",
          body:
            "The full allowed range is <strong>" +
            _SLIP_RANGE.min +
            "% to " +
            _SLIP_RANGE.max +
            "%</strong>; values outside it are rejected outright. Above " +
            f.slippageConfirmAbovePct +
            "% the app shows a confirm dialog on Save. At " +
            f.slippageTypedConfirmFromPct +
            "% or more the app shows a stricter dialog that requires you " +
            'to type "Confirm" to proceed. On asymmetric pairs, the deep side ' +
            "typically wants 0.1% to 1% and the thin side may need " +
            "5% or more.",
        },
      ],
    },

    inSlipToken1: {
      title: "Slippage When Swapping to Token 1 (%)",
      subtitle: "Per-position slippage for the Token 1 side of swaps",
      sections: [
        {
          heading: "What it does",
          body:
            "Sets the slippage tolerance for swaps whose DESTINATION is " +
            "Token 1, i.e. swaps that CONVERT Token 0 into Token 1. For " +
            "example, when {{token0}} is traded for {{token1}}. Its peer, " +
            "<strong>Slippage When Swapping to Token 0</strong>, covers " +
            "the other direction; that dialog explains why each token has " +
            "its own setting.",
        },
        {
          heading: "The destination-token rule",
          body:
            "Slippage is applied by the destination token of the swap, " +
            "not the source. A swap that CONVERTS Token 0 INTO Token 1 " +
            "uses this field. A swap that CONVERTS Token 1 INTO Token 0 " +
            "uses <strong>Slippage When Swapping to Token 0</strong> " +
            "instead.",
        },
        {
          heading: "Default value",
          body:
            "The input starts populated with the default (" +
            f.slippageDefaultPct +
            "%). " +
            "That is the value the bot uses if you never change it. " +
            "Change the input and click Save to persist a different value " +
            "for this position.",
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
            "Sets the ratio of the pair&rsquo;s two tokens (here " +
            "&ldquo;Token0&rdquo; and &ldquo;Token1&rdquo;) in the new " +
            "position a rebalance mints. At <strong>50%</strong> the " +
            "range is centered symmetrically around the current price; " +
            "the default is <strong>" +
            f.offsetDefaultPct +
            "%</strong>. Lower values shift the range below the current " +
            "price (more Token1); higher values shift it above (more Token0).",
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
          heading: "Recommended values",
          body:
            "<strong>50%</strong> (symmetric) is correct for most " +
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
            "centered split, " +
            CENTERED_OFFSET_PCT +
            "% for Token 0, regardless of the default. Click " +
            "<strong>Save</strong> to keep it, as with the Price Range " +
            "Extension's <strong>Default</strong> button.<br>" +
            "<strong>Save</strong>: writes the value in the input to the " +
            "per-position config; applies on the next rebalance.",
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
            "For frequent rebalancers and auto-compounders, this adds up " +
            "to meaningful savings over time.",
        },
        {
          heading: "Recommended values",
          body:
            "<strong>" +
            f.approvalMultipleDefault +
            "</strong> (default) is a reasonable balance: " +
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
            (f.aggregatorName === ""
              ? "(the V3 Router or the Position Manager) "
              : "(the V3 Router, the " +
                f.aggregatorName +
                ", or the Position Manager) ") +
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
            "Doubling Mode trigger (" +
            _TRIGGER +
            " this interval).",
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
            "<strong>" +
            _minutes(_INTERVAL_RANGE.min) +
            "</strong> (minimum) &mdash; almost no throttling. Risky in " +
            "volatile markets.<br>" +
            "<strong>" +
            _minutes(_INTERVAL_RANGE.max) +
            "</strong> (maximum) &mdash; at most one rebalance in that " +
            "time.",
        },
        {
          heading: "Related parameters",
          body:
            "If " +
            _TRIGGER +
            " this interval occur, <strong>Doubling Mode</strong> activates " +
            "&mdash; the cooldown doubles after each rebalance (" +
            f.doublingLadder +
            "&hellip;). The (i) beside the throttle badge, at the top of " +
            "Rebalance Timing &amp; Throttle, explains every throttle state.",
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
            "<strong>" +
            f.dailyCapDefault +
            "</strong>, the default, suits most pools. Lower values " +
            "protect against runaway gas spending on very volatile days. " +
            "Higher values allow the bot more freedom in active markets.",
        },
        _LOW_VOLUME,
        {
          heading: "Extreme values",
          body:
            "<strong>" +
            _DAILY_RANGE.min +
            "</strong> (minimum) &mdash; very conservative.<br>" +
            "<strong>" +
            _DAILY_RANGE.max +
            "</strong> (maximum) &mdash; the highest cap accepted; Min " +
            "Time Between Rebalances and Doubling Mode still throttle.",
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
            "This is a calculated value (" +
            f.doublingTriggerWindowMultiple +
            "&times; Min Time Between Rebalances). When " +
            f.doublingTriggerCount +
            " or more rebalances occur within this window, " +
            "<strong>Doubling Mode</strong> activates &mdash; the cooldown " +
            "between rebalances doubles after each one: " +
            f.doublingLadder +
            ", and so on. The value shown reflects " +
            "the <strong>saved</strong> Min Time Between Rebalances &mdash; " +
            "it updates when you click that setting&rsquo;s " +
            "<strong>Save</strong> button, not while you type.",
        },
        {
          heading: "Which rebalances count, and which are gated",
          body:
            "<strong>All successful rebalances count toward the " +
            f.doublingTriggerCount +
            " in-window triggers</strong> &mdash; automatic out-of-range, " +
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
            "Doubling mode clears after a quiet period of " +
            f.doublingQuietWindowMultiple +
            "&times; the current doubled wait, or at midnight UTC " +
            "(whichever comes " +
            "first). Once cleared, the min interval returns to its normal " +
            "configured value.",
        },
        {
          heading: "Related parameters",
          body:
            "Derived from <strong>Min Time Between Rebalances</strong>. " +
            "Also capped by <strong>Max Rebalances / Day</strong>. " +
            "The (i) beside the throttle badge, at the top of Rebalance " +
            "Timing &amp; Throttle, explains every throttle state.",
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
            "or when gas would cost more than the <strong>Gas Fee %</strong> " +
            "setting (" +
            f.gasFeeDefaultPct +
            "% by default) of the swap value (gas gate). When " +
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
            "The bot checks for unclaimed fees on every poll cycle while " +
            "the position is in range, and while it is out of range but " +
            "still inside the OOR Threshold zone. If fees exceed the " +
            "<strong>Auto-Compound Threshold</strong>, it executes collect " +
            "&rarr; ratio-correcting swap (when the gates pass) &rarr; " +
            "increaseLiquidity. Automatic compounds are spaced apart: " +
            "after any compound, the next waits at least " +
            f.compoundSpacing +
            " (<code>compound.autoSpacingPolls</code> polls, never less " +
            "than <code>compound.autoSpacingFloorSec</code>, both in " +
            "app-runtime.json). Compounded amounts are kept as coins and " +
            "valued at current prices. The IL/G figure takes them off the " +
            "position's side, so reinvested fees are not reported as " +
            "beating a hold.",
        },
        {
          heading: "Compound vs. Rebalance — wallet residuals",
          body:
            "When a compound's ratio-correcting swap fires, the deposit is " +
            "offered the wallet's whole balance of both tokens, not just " +
            "the collected fees. So it also takes in whatever else of the " +
            "two tokens the wallet holds that pairs at the position's " +
            "ratio: a residual from an earlier rebalance, or the same " +
            "tokens held for another position. What does not pair stays " +
            "in the wallet until the next <strong>rebalance</strong>, " +
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
            "<strong>$5&ndash;$20</strong> for " +
            f.chainName +
            " (gas is cheap). " +
            "On higher-gas chains, set this higher to ensure gas doesn&rsquo;t " +
            "eat the compounded amount.",
        },
        {
          heading: "Extreme values",
          body:
            "<strong>$" +
            f.compoundMinFeeUsd +
            "</strong> (minimum) &mdash; compounds very small " +
            "amounts. May not be gas-efficient on busy days.<br>" +
            "Very high values (&gt;$100) effectively disable auto-compound " +
            "for low-fee positions.",
        },
        {
          heading: "Related parameters",
          body:
            "<strong>Compound Now</strong> ignores this threshold, but its " +
            "button stays disabled until the fees are worth at least the " +
            "compound minimum, <code>compound.minFeeUsd</code> in " +
            "app-runtime.json (default $" +
            f.compoundMinFeeUsd +
            ").",
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
            "<strong>Default: " +
            f.gasFeeDefaultPct +
            "%.</strong> Bounds: " +
            _GAS_FEE_RANGE.min +
            "% to " +
            _GAS_FEE_RANGE.max +
            "%. This is <strong>one global setting</strong> shared by " +
            "every position.",
        },
        {
          heading: "Gas % versus minimum swap value",
          body:
            "A lower percentage forces a <strong>larger</strong> minimum " +
            "swap value before LP Ranger will execute. Concretely:<br><br>" +
            "&bull; If the swap costs <strong>$1 in gas</strong> and the " +
            "ceiling is <strong>1%</strong>, the swap value must be at " +
            "least <strong>$100</strong> for the swap to proceed.<br>" +
            "&bull; At <strong>" +
            _GAS_FEE_RANGE.min +
            "%</strong> (the floor), the same $1 gas swap needs <strong>$" +
            (100 / _GAS_FEE_RANGE.min).toLocaleString("en-US") +
            "</strong> of value.<br>" +
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
            "Values below " +
            _GAS_FEE_RANGE.min +
            "% would block almost every swap on chains with non-trivial " +
            "gas; values above " +
            _GAS_FEE_RANGE.max +
            "% are well past the point where gas eats the trade. A save " +
            "outside that range is refused, and the field goes back to " +
            "the value last accepted. The server also clamps the value to " +
            "the range on every read, so a corrupt config file can&rsquo;t " +
            "disable the gate or block all swaps.",
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
            "Moralis is a third-party blockchain data provider. With a key " +
            "stored and switched on, LP Ranger asks it first for token " +
            "prices, current and historical. Historical prices matter " +
            "most: when a HODL baseline or deposit auto-detection needs to " +
            "know what a token was worth at a past date, Moralis provides " +
            "that price, which makes P&amp;L calculations, Impermanent " +
            "Loss, and deposit valuations more accurate.",
        },
        {
          heading: "Is it required?",
          body:
            "<strong>No.</strong> The Moralis key is optional. Without it, " +
            "LP Ranger asks <strong>GeckoTerminal</strong> (free, no key " +
            "needed, rate-limited to 30 calls/min, with historical prices " +
            "by the day, hour and minute) and then " +
            "<strong>DexScreener</strong> (current prices only). The " +
            "trade-off is slower scans, because of that rate limit, and " +
            "less precise historical valuations, especially for older " +
            "positions.",
        },
        {
          heading: "How to get a key",
          body:
            'Sign up at <a href="https://moralis.com/" target="_blank" ' +
            'rel="noopener noreferrer">moralis.com</a> (free tier ' +
            "available). Copy your API key from the Moralis dashboard and " +
            "paste it into <strong>Settings &rarr; Moralis API Key</strong>. " +
            "The key is encrypted with your wallet password " +
            "and stored locally &mdash; it is never sent anywhere except " +
            "to the Moralis API itself.",
        },
        {
          heading: "Avoiding overage charges",
          body:
            "<strong>&#9888; Strongly recommended:</strong> after creating " +
            "your Moralis account, <strong>disable overage / " +
            "pay-as-you-go billing</strong> in its settings. Most paid api " +
            "providers, Moralis included, turn overage on by default, so a " +
            "usage spike past your tier&rsquo;s quota (free or paid) is " +
            "billed. With overage off, requests beyond the quota are " +
            "refused instead, and LP Ranger falls back to GeckoTerminal, " +
            "so capping the account costs you nothing in functionality. " +
            "<strong>Do the same for any other optional third-party api " +
            "key you add to LP Ranger.</strong>",
        },
      ],
    },

    rpcUrls: {
      title: "RPC URLs",
      sections: [
        {
          heading: "What it does",
          body:
            "The blockchain RPC endpoint LP Ranger uses to read on-chain " +
            "data and submit transactions — your connection to the " +
            f.chainName +
            " network. The dropdown lists every endpoint in the " +
            "order the bot tries them, marked <strong>PRIMARY</strong> or " +
            "<strong>FAILOVER</strong>. The one showing is the primary: " +
            "the bot uses it unless it has failed over to the next one in " +
            "the list, as described below. Pick a different one and it " +
            "becomes the primary immediately.",
        },
        {
          heading: "Recommended values",
          body:
            "The endpoints LP Ranger ships with work as-is, and most " +
            "people never change them. If you run your own " +
            f.chainName +
            " node, use <strong>Add RPC</strong> to enter its URL for " +
            "maximum privacy and reliability. What you add becomes the " +
            "primary, and the shipped endpoints stay behind it — so " +
            "using your own node does not cost you failover.",
        },
        {
          heading: "When to change",
          body:
            "Add one if you experience RPC timeouts, slow responses, or " +
            "want to use a private node. LP Ranger moves down the list " +
            "automatically when an endpoint stops responding, sticking " +
            "with the replacement for " +
            f.rpcFailoverSticky +
            " before trying the preferred one again. " +
            "<strong>The change takes effect immediately</strong> — " +
            "the next on-chain read or transaction uses it. No restart " +
            "needed.",
        },
      ],
    },

    /*-
     *  The `inPM` and `inFactory` entries are gone along with their
     *  fields.  Both promised "Restart the app for the change to take
     *  effect", which was never true: the addresses come from .env /
     *  chains.json, and nothing ever read the saved values back.  They
     *  are not editable from the dashboard by design — both scope the
     *  on-disk caches, so changing one mid-life orphans every cache keyed
     *  to the old address.  docs/configuration.md documents where they live
     *  and why changing them means a fresh install.
     */

    // ── Rebalance timing ───────────────────────────────────────────────────

    /*-
     *  Was a hand-rolled modal (#throttleInfoModal) with its own markup,
     *  its own close buttons and its own show/hide handlers.  Same copy,
     *  now carried by the shared help dialog so it inherits the standard
     *  chrome, dismissal and height bound like every other circle-i.
     */
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
            "Configuration. Every successful rebalance counts, no matter what " +
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
            "Bot Configuration &mdash; the saved value, not whatever is " +
            "currently typed in the field.",
        },
        {
          heading: "When the cooldown is longer than it looks",
          body:
            "If <strong>doubling mode</strong> is active, the wait is " +
            "longer than the Min Time setting: " +
            f.doublingTriggerCount +
            " or more rebalances inside " +
            f.doublingTriggerWindowMultiple +
            "&times; the minimum interval doubles the cooldown after each " +
            "one (" +
            f.doublingLadder +
            ", and so on) until the pool goes quiet for " +
            f.doublingQuietWindowMultiple +
            "&times; the current wait or the day resets at midnight UTC. " +
            "The throttle badge in Bot " +
            "Configuration reads DOUBLING while that is in effect.",
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
            "<strong>DOUBLING</strong> activates when " +
            f.doublingTriggerCount +
            " or more rebalances occur within " +
            f.doublingTriggerWindowMultiple +
            "&times; the minimum interval. Like THROTTLED, it means a " +
            "cooldown is running, but a longer one: the cooldown doubles " +
            "after each rebalance, " +
            f.doublingLadder +
            ", and so on. " +
            "This protects against excessive gas spending and loss to " +
            "slippage and swap fees during high volatility. " +
            "Doubling mode clears automatically after " +
            f.doublingQuietWindowMultiple +
            "&times; the current, doubled cooldown with no rebalance, or " +
            "at the daily midnight UTC reset. For example, with Min Time " +
            "Between Rebalances at " +
            f.minRebalanceInterval +
            " and the cooldown doubled to " +
            f.doublingExampleDoubledWait +
            ", Doubling mode clears after " +
            f.doublingExampleQuiet +
            " with no rebalance.",
        },
        {
          heading: "NEAR LIMIT",
          body:
            "<strong>NEAR LIMIT</strong> is a heads-up, not a brake: the " +
            "pool has used <strong>" +
            f.nearLimitPct +
            "% or more</strong> of its " +
            "&ldquo;Max Rebalances / Day&rdquo; allowance and nothing is " +
            "being blocked yet. At the default of " +
            f.nearLimitExampleCap +
            " per day it appears once " +
            f.nearLimitExampleAt +
            " rebalances have landed, leaving " +
            f.nearLimitExampleLeft +
            " before the pool goes CAPPED. If you expect more volatility before the " +
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
            "An unmanaged position has no cooldown, no daily counter and " +
            "nothing scheduled, so the badge reads N/A rather than " +
            "<strong>OK</strong>: an idle position is never mistaken for " +
            "one the bot is watching. Every setting in this " +
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
            "&mdash; the first that applies wins. So a pool sitting at " +
            f.nearLimitExampleAt +
            " of " +
            f.nearLimitExampleCap +
            " rebalances but still inside its cooldown reads THROTTLED " +
            "rather than NEAR LIMIT: the cooldown is what is actually " +
            "stopping it right now.",
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
            "The two never overlap. Profit adds both; Net P&amp;L counts " +
            "only this line, because compounded fees are already inside " +
            "Current Value.",
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
            "This figure is valued at this poll's prices, so one bad " +
            "reading corrects itself at the next good one. If a feed keeps " +
            "serving a wrong price, enter the price yourself with " +
            "<strong>Edit</strong> beside Current Value, and tick its box " +
            "to make it override the feed.",
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
            "This figure is the coins compounded into this NFT, valued at " +
            "this poll's token prices, so a bad price reading corrects " +
            "itself at the next good one. If a price feed keeps serving a " +
            "wrong price, enter the price yourself with <strong>Edit" +
            "</strong> beside Current Value, and tick its box to make it " +
            "override the feed.<br><br>" +
            "If the coin amounts look wrong, try <strong>Settings</strong> " +
            "(gear icon at top right) &rarr; <strong>Re-scan Prices</strong>. " +
            "That counts the compounds again from the chain and re-values " +
            "this position at freshly fetched prices. It takes minutes on a " +
            "long rebalance chain, and does not touch the position, your " +
            "funds, or its on-chain history.",
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
            "into the same NFT (no new NFT, no range change).<br>" +
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
            "Net P&amp;L does not add Fees Compounded: those fees were " +
            "re-deposited, so they are already inside Current Value, and " +
            "Total Lifetime Deposit counts only fresh deposits, so Price " +
            "Change carries them. Adding them again would count them " +
            "twice. Current Fees, still unclaimed, are not in Current " +
            "Value, so Net P&amp;L adds them. <strong>Profit</strong> " +
            "counts Fees Compounded and Current Fees together as the " +
            "lifetime fee earnings.",
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
            "multiplied by a token price. The amounts are read from the " +
            "blockchain; the prices come from third-party feeds, which can " +
            "occasionally serve a bad value &mdash; most often during heavy " +
            "volatility, or on a pair whose two tokens share a symbol. This " +
            "figure is valued at this poll's prices, so one bad reading " +
            "corrects itself at the next good one. If a feed keeps serving " +
            "a wrong price, enter the price yourself with <strong>Edit" +
            "</strong> beside Current Value, and tick its box to make it " +
            "override the feed.<br><br>" +
            "If the coin amounts look wrong, try <strong>Settings</strong> " +
            "(gear icon at top right) &rarr; <strong>Re-scan Prices</strong>. " +
            "That counts the compounds again from the chain and re-values " +
            "this position at freshly fetched prices. It takes minutes on a " +
            "long rebalance chain, and does not touch the position, your " +
            "funds, or its on-chain history.",
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
            "specific LP position: the baseline for this position&rsquo;s " +
            "Net P&amp;L in the Current panel.",
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
            "Net P&amp;L = Current Position Value + Fees Earned + Realized " +
            "Gains &minus; Initial Deposit for This LP. " +
            "Fees Compounded are not added in: they were reinvested as " +
            "additional liquidity, so they are already inside the Current " +
            "Position Value, and <strong>Fees Earned</strong> counts only " +
            "what is still unclaimed. Counting them again would " +
            "double-count them. A higher deposit value lowers your " +
            "reported profit; a lower value inflates it.",
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
            "Realized gains entered here are added to this position&rsquo;s " +
            "Net P&amp;L in the Current panel: Net P&amp;L = Current Value " +
            "+ Fees Earned + Realized Gains &minus; Initial Deposit for " +
            "This LP. The Lifetime panel does not read this figure, so " +
            "update <strong>Lifetime Realized Gains</strong> there " +
            "separately.",
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
            "The total USD value of <strong>all</strong> your deposits " +
            "into this pool from this wallet, across every NFT in its " +
            "rebalance chain (up to " +
            f.historyLookback +
            " of history).",
        },
        {
          heading: "When to edit",
          body:
            "The bot detects this from the chain: the first NFT&rsquo;s " +
            "minting deposit, coins that reached the wallet from outside " +
            "between one mint and the next, and any top-up larger than " +
            "the fees collected, each valued at the historical price of its " +
            "own block. Rebalance re-mints and compounds are not counted. " +
            "Edit manually only if auto-detection is inaccurate.",
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
            "example, if the NFT was minted more than " +
            f.historyLookback +
            " ago (outside the scan window) or spent time on multiple prior " +
            "wallets. " +
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
          heading: "Which prices these figures use",
          body:
            "A closed period keeps the dollars it closed at: its fees, Price " +
            "P&L and In/Out were worked out from the two tokens&rsquo; prices " +
            "at the time, and do not move afterwards. Only the most recent " +
            "row, the period still open, is valued at current prices.",
        },
        {
          heading: "Gas",
          body:
            "Gas is recorded as the coins actually spent, and each row keeps " +
            "what its gas cost at the time rather than being converted " +
            "again at today&rsquo;s price. Profit and Net P&L both subtract " +
            "gas, so they stay put with it. Where the gas token&rsquo;s " +
            "price on a row&rsquo;s day cannot be found, all three show a " +
            "dash. The Lifetime panel prices the " +
            "same coins at today&rsquo;s price, as it prices everything " +
            "else, so its gas figure and this column part company once the " +
            "native token has moved.",
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
            "The same sum as Lifetime Net P&L, scoped to the row&rsquo;s " +
            "period: fees, minus gas, plus the change in value. This is " +
            "what your holdings " +
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
            "Every rebalance found on-chain for this wallet and pool, " +
            "including any made outside LP Ranger, newest first and " +
            "numbered from the oldest, #1. Each row corresponds to one new " +
            "NFT being minted to replace a drained one.",
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
            "On-chain lookback is limited to the last " +
            f.historyLookback +
            ". Rebalances older than that will not appear here.",
        },
      ],
    },

    // ── Wallet Residual ────────────────────────────────────────────────────

    /*-
     *  The In/Out column in the Per-Day P&L table.  Was a hover-only
     *  tooltip, which no touch device could reach.
     */
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
            "Change. Counting it here keeps Lifetime P&amp;L complete without " +
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
            "What the wallet held of <strong>token0</strong> and " +
            "<strong>token1</strong> right after the very first mint for " +
            "this pool on this wallet, at the <em>end</em> of that " +
            "mint&rsquo;s block: what the initial LP mint left behind, " +
            "before any other LP action (rebalance, compound, second " +
            "deposit).<br><br>" +
            "Valued in USD at historical prices for that same block " +
            "(frozen &mdash; see &ldquo;Frozen valuation&rdquo; below).",
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
            f.aggregatorName === ""
              ? "On " +
                f.chainName +
                ", LP Ranger uses no aggregator: every swap goes through " +
                "the V3 Router."
              : "LP Ranger uses one aggregator, the " +
                f.aggregatorName +
                " (formerly the 9mm DEX Aggregator). There are other good " +
                'ones as well, such as <a href="https://switch.win/" ' +
                'target="_blank" rel="noopener noreferrer">Switch</a> and ' +
                '<a href="https://piteas.io/" target="_blank" ' +
                'rel="noopener noreferrer">Piteas</a>.',
        },
      ],
    },
  };
}
