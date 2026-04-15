/**
 * @file disclosure-content.js
 * @description Single source of truth for the LP Ranger disclosure text.
 * Both the startup modal and the Settings → Disclosure item render from
 * this module.  Update the version date whenever the text changes.
 */

/** Disclosure version — update whenever the text below changes. */
export const DISCLOSURE_VERSION = "2026-04-14";

/** Full disclosure HTML, rendered into the modal body. */
export const DISCLOSURE_HTML = `
<h3>Creator, Offeror, and/or Operator</h3>
<p>LP Ranger is free, open-source software published on GitHub. Depending on
your relationship to this software, one or more of the following
characterizations applies to you or to others in connection with its use.</p>
<p>The <strong>Creator</strong> is the individual developer who authored LP Ranger
and published it on GitHub. The Creator is not registered with or regulated by
the U.S. Securities and Exchange Commission in connection with the creation of
this software. The Creator does not operate any deployed instance of LP Ranger,
does not custody any user funds, does not receive any compensation in connection
with the software&rsquo;s operation, has no visibility into any transaction
executed by any deployed instance, and exercises no control over any running
instance of this software.</p>
<p>The <strong>Offeror</strong> is any person &mdash; including the Creator, to
the extent the Creator mentions, describes, distributes, or promotes LP Ranger
in any context &mdash; who makes this software available to others. The Offeror
is not registered with or regulated by the U.S. Securities and Exchange
Commission in connection with the offering of this software. Nothing
communicated by the Offeror in connection with LP Ranger constitutes a
solicitation to engage in any specific transaction, investment advice, or a
recommendation regarding any crypto asset, trading venue, execution route, or
liquidity position.</p>
<p>The <strong>Operator</strong> is the person running this software &mdash;
that is, you. You downloaded this software, you deployed it on your own
infrastructure, you connected it to your own self-custodial wallet, and you
configured it according to your own parameters. You are the operator of this
instance of LP Ranger. The Operator is not registered with or regulated by the
U.S. Securities and Exchange Commission in connection with the operation of
this software for the Operator&rsquo;s own self-custodial wallet. All
transactions executed by LP Ranger are initiated by the Operator&rsquo;s own
configuration, signed by the Operator&rsquo;s own wallet, and submitted to the
public blockchain on the Operator&rsquo;s own behalf.</p>
<p>If you are running LP Ranger as a hosted service for third parties &mdash;
that is, if other users are accessing your deployed instance of LP Ranger to
manage their own wallets and positions &mdash; you are acting as a Covered User
Interface Provider within the meaning of the SEC Staff Statement Regarding
Broker-Dealer Registration of Certain User Interfaces Utilized to Prepare
Transactions in Crypto Asset Securities (File No. 4-894, April 13, 2026). In
that capacity, additional obligations may apply to you under federal securities
law. You should review that statement and consider seeking legal counsel before
operating LP Ranger as a hosted service for others.</p>

<p><strong>THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NONINFRINGEMENT.</strong></p>

<p><strong>BY USING THIS SOFTWARE, YOU ACKNOWLEDGE AND AGREE THAT:</strong></p>
<ol>
  <li>You are solely responsible for any and all financial losses, including
      loss of cryptocurrency, tokens, or other digital assets, that may
      result from the use or misuse of this software.</li>
  <li>This software interacts with decentralized protocols and smart
      contracts on public blockchains. Transactions are irreversible.
      The authors have no ability to recover lost funds.</li>
  <li>This software has not been formally audited. It may contain bugs,
      errors, or vulnerabilities that could result in partial or total
      loss of funds.</li>
  <li>You assume full responsibility for evaluating the risks associated
      with using this software, including smart contract risk, impermanent
      loss, slippage, MEV attacks, oracle failures, and network congestion.</li>
  <li>You are responsible for complying with all applicable laws and
      regulations in your jurisdiction.</li>
  <li>The authors and contributors expressly disclaim any fiduciary duty
      or advisory relationship with users of this software.</li>
</ol>
<p><strong>DO NOT USE THIS SOFTWARE WITH FUNDS YOU CANNOT AFFORD TO LOSE.</strong></p>

<h3>Venue Relationships &mdash; No Affiliation</h3>
<p>The Creator, Offeror, and Operator of LP Ranger have no affiliation of any
kind &mdash; including no ownership interest, no revenue-sharing arrangement,
no control relationship, no contractual relationship, no compensation
arrangement, no referral or incentive agreement, and no other formal or
informal relationship &mdash; with 9mm, the 9mm DEX Aggregator, 9mm Pro V3,
PulseChain, or any person or entity associated with their creation, offering,
or operation.</p>
<p>LP Ranger connects to and interacts with the following trading venues and
distributed ledger trading systems on PulseChain solely because they are the
protocol for which this software was designed:</p>
<ul>
  <li><strong>9mm DEX Aggregator</strong> (api.9mm.pro) &mdash; a liquidity
      aggregator that routes swap transactions across multiple PulseChain
      decentralized exchanges to minimize slippage. LP Ranger uses this
      aggregator as its primary swap execution path.</li>
  <li><strong>9mm Pro V3 SwapRouter</strong> &mdash; a single-pool direct swap
      router, used as a fallback if the aggregator is unavailable.</li>
  <li><strong>9mm Pro V3 NonfungiblePositionManager</strong> &mdash; the smart
      contract through which all liquidity positions are created, modified,
      and closed.</li>
</ul>

<h3>Transaction History and Post-Trade Data</h3>
<p>LP Ranger displays post-trade information including transaction hashes,
token amounts received, USD values at time of execution, gas costs, tick
ranges, and historical rebalance event logs. This information is derived
exclusively from publicly available on-chain data &mdash; specifically,
transaction receipts and event logs recorded on the PulseChain public
ledger, which are readable by anyone with access to a PulseChain RPC
endpoint.</p>
<p>All such data is retrieved directly from the blockchain by the software
running on your own machine and stored locally in a rebalance_log.json file
on your own infrastructure. No trade data, transaction history, wallet
addresses, token amounts, or any other post-trade information is transmitted
to, processed by, stored by, or accessible to the developer, offeror, or
any third party in connection with the operation of this interface. The
developer has no visibility into any transaction you execute or any position
you manage using this software.</p>
<p>This local transaction history is maintained solely for your own
operational reference. It is the equivalent of reading your own transaction
history from a public block explorer &mdash; the operator of this software is
you, reading data that is already public, on hardware you control.</p>

<p class="9mm-pos-mgr-disclaimer-license">This software is licensed under the
<a href="https://www.apache.org/licenses/LICENSE-2.0" target="_blank"
rel="noopener noreferrer">Apache 2.0 License</a>.</p>

<p class="9mm-pos-mgr-text-muted-sm">Disclosure version: ${DISCLOSURE_VERSION}</p>
`;
