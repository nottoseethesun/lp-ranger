/**
 * @file test/eslint-rules/no-separate-contract-calls.test.js
 * @description Tests for the no-separate-contract-calls custom ESLint rule.
 */

'use strict';

const { describe, it } = require('node:test');
const assert = require('assert');
const { RuleTester } = require('eslint');
const rule = require('../../eslint-rules/no-separate-contract-calls');

const ruleTester = new RuleTester({
  languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs' },
});

describe('no-separate-contract-calls', () => {
  it('passes RuleTester valid/invalid cases', () => {
    ruleTester.run('no-separate-contract-calls', rule, {
      valid: [
        // Good: encodeFunctionData + multicall
        {
          code: `
            async function remove(pm) {
              const d1 = pm.interface.encodeFunctionData('decreaseLiquidity', [{}]);
              const d2 = pm.interface.encodeFunctionData('collect', [{}]);
              await pm.multicall([d1, d2]);
            }
          `,
          options: [{ pairs: [['decreaseLiquidity', 'collect']] }],
        },
        // Good: only one of the pair called
        {
          code: `
            async function collectOnly(pm) {
              await pm.collect({ tokenId: 1 });
            }
          `,
          options: [{ pairs: [['decreaseLiquidity', 'collect']] }],
        },
        // Good: methods on different objects (still valid — rule tracks method names)
        // Note: the rule is name-based; this IS allowed because it's a pragmatic tradeoff.
        // If both names match it still flags. This test documents that behaviour.
        {
          code: `
            async function unrelated(a) {
              await a.approve({ spender: '0x1' });
            }
          `,
          options: [{ pairs: [['decreaseLiquidity', 'collect']] }],
        },
        // Good: default pairs (no options) with unrelated methods
        {
          code: `
            async function swap(router) {
              await router.exactInputSingle({});
              await router.exactOutputSingle({});
            }
          `,
        },
        // Good: pair methods in nested function scopes (different scopes)
        {
          code: `
            async function outer(pm) {
              await pm.decreaseLiquidity({});
              async function inner() {
                await pm.collect({});
              }
            }
          `,
          options: [{ pairs: [['decreaseLiquidity', 'collect']] }],
        },
      ],

      invalid: [
        // Bad: both pair methods as separate awaits
        {
          code: `
            async function remove(pm) {
              const tx1 = await pm.decreaseLiquidity({ tokenId: 1 });
              await tx1.wait();
              const tx2 = await pm.collect({ tokenId: 1 });
              await tx2.wait();
            }
          `,
          options: [{ pairs: [['decreaseLiquidity', 'collect']] }],
          errors: [{ messageId: 'separateCalls' }],
        },
        // Bad: reversed order
        {
          code: `
            async function remove(pm) {
              await pm.collect({ tokenId: 1 });
              await pm.decreaseLiquidity({ tokenId: 1 });
            }
          `,
          options: [{ pairs: [['decreaseLiquidity', 'collect']] }],
          errors: [{ messageId: 'separateCalls' }],
        },
        // Bad: with intermediate statements
        {
          code: `
            async function remove(pm) {
              await pm.decreaseLiquidity({ tokenId: 1 });
              console.log('decreased');
              const balance = getBalance();
              await pm.collect({ tokenId: 1 });
            }
          `,
          options: [{ pairs: [['decreaseLiquidity', 'collect']] }],
          errors: [{ messageId: 'separateCalls' }],
        },
        // Bad: using default pairs (no options needed)
        {
          code: `
            async function remove(pm) {
              await pm.decreaseLiquidity({});
              await pm.collect({});
            }
          `,
          errors: [{ messageId: 'separateCalls' }],
        },
      ],
    });
  });

  it('error message includes method names', () => {
    // Verify the message template renders correctly
    const msg = rule.meta.messages.separateCalls
      .replace('{{methodA}}', 'decreaseLiquidity')
      .replace('{{methodB}}', 'collect');
    assert.ok(msg.includes('decreaseLiquidity'));
    assert.ok(msg.includes('collect'));
    assert.ok(msg.includes('multicall'));
  });
});
