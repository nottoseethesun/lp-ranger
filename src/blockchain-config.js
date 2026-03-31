/**
 * @file blockchain-config.js
 * @description Single source of truth for blockchain-specific constants.
 *   Never hardcode chain IDs — import from here.
 */

'use strict';

const CHAINS = {
  pulsechain: { chainId: 369, name: 'PulseChain' },
};

module.exports = { CHAINS };
