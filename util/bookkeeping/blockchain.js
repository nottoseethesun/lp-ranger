"use strict";

/**
 * @file util/bookkeeping/blockchain.js
 * @module bookkeeping/blockchain
 * @description
 * The blockchain a bookkeeping run reads, chosen before LP Ranger's
 * configuration loads.
 *
 * The bookkeeping tools take every configuration value from LP Ranger's
 * own resolver (src/config.js), the one the app and its tests use: the
 * chain's details, the position manager, the endpoints and the pacing of
 * requests. That resolver serves one chain, and reads which one as it
 * loads: CHAIN_NAME in `.env`, else the shipped default, pulsechain. So a
 * run's chain has to be settled before the resolver loads, and this module
 * settles it as it loads itself. It reads `--blockchain <name>` from the
 * command line with a parser of its own that passes over every other
 * argument, checks the name against the chains the configuration names
 * (chains.json, with any operator copy over it), and sets CHAIN_NAME to
 * it. Without the option, the resolver's own choice stands. Each module of
 * the tools that loads the resolver requires this one first.
 *
 * A run reads one blockchain. When the configuration names more than one,
 * `oneChainNotice` gives the line that says so, naming the chain read and
 * how to choose another.
 */

const { Command, InvalidArgumentError } = require("commander");
const { loadMergedDefaults } = require("../../src/load-merged-defaults");

/** The chains the configuration names, by their keys in chains.json. */
const CHAIN_NAMES = Object.keys(loadMergedDefaults("chains.json"));

/**
 * Commander parser for `--blockchain`: a chain the configuration names.
 * @param {string} value  The raw argument.
 * @returns {string}  The chain's name.
 * @throws {InvalidArgumentError}  For a name the configuration lacks.
 */
function parseBlockchain(value) {
  if (CHAIN_NAMES.includes(value)) return value;
  throw new InvalidArgumentError(
    `not a blockchain the configuration names: ${value}. ` +
      `It names ${CHAIN_NAMES.join(", ")}.`,
  );
}

/**
 * The `--blockchain` a command line gives, read past every other argument,
 * which the tool's own parser reads later. Commander refuses a name the
 * configuration lacks, printing why, and exits 1.
 *
 * @param {string[]} argv  Arguments after the node/script pair.
 * @returns {string|undefined}  The chain's name, or undefined without one.
 */
function blockchainArgument(argv) {
  const program = new Command()
    .helpOption(false)
    .allowUnknownOption()
    .allowExcessArguments()
    .option("--blockchain <name>", "the blockchain to read", parseBlockchain);
  program.parse(argv, { from: "user" });
  return program.opts().blockchain;
}

/**
 * The line a run prints when the configuration names more than one chain.
 * @param {string} chainName  The chain the run reads.
 * @param {string[]} [names]  The chains the configuration names.
 * @returns {string|null}  The line, or null for a single chain.
 */
function oneChainNotice(chainName, names = CHAIN_NAMES) {
  if (names.length < 2) return null;
  return (
    `Only one blockchain at a time is supported: this run reads ` +
    `${chainName}. Choose another with --blockchain <name> ` +
    `(${names.join(", ")}).`
  );
}

/*-
 *  Settled as this module loads, before any module of the tools loads the
 *  resolver. dotenv, which the resolver runs, leaves a variable already
 *  set alone, so `.env` cannot undo the choice.
 */
const chosen = blockchainArgument(process.argv.slice(2));
if (chosen !== undefined) process.env.CHAIN_NAME = chosen;

module.exports = {
  CHAIN_NAMES,
  parseBlockchain,
  blockchainArgument,
  oneChainNotice,
};
