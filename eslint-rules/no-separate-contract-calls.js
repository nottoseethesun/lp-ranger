/**
 * @file eslint-rules/no-separate-contract-calls.js
 * @description ESLint rule that flags non-atomic EVM contract method calls.
 *
 * Detects when two contract methods that should be bundled via `multicall`
 * (e.g. `decreaseLiquidity` + `collect`) appear as separate `await` calls
 * in the same function scope.
 */

'use strict';

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description: 'Require atomic contract method pairs to use multicall, not separate awaits',
    },
    schema: [{
      type: 'object',
      properties: {
        pairs: {
          type: 'array',
          items: {
            type: 'array',
            items: { type: 'string' },
            minItems: 2,
            maxItems: 2,
          },
        },
      },
      additionalProperties: false,
    }],
    messages: {
      separateCalls:
        "'{{methodB}}' must be bundled with '{{methodA}}' via multicall, not called as a separate awaited transaction.",
    },
  },

  create(context) {
    const opts = context.options[0] || {};
    const pairs = opts.pairs || [['decreaseLiquidity', 'collect']];
    const allMethods = new Set(pairs.flat());

    // Stack of sets — one per function scope — tracking which pair-methods
    // have been seen as direct `await obj.method(...)` calls.
    const scopeStack = [];

    function enterScope() { scopeStack.push(new Set()); }
    function exitScope()  { scopeStack.pop(); }
    function currentScope() {
      return scopeStack.length ? scopeStack[scopeStack.length - 1] : null;
    }

    /** True if `node` is inside an `encodeFunctionData(...)` call (the good pattern). */
    function isInsideEncodeFunctionData(node) {
      let cur = node.parent;
      while (cur) {
        if (
          cur.type === 'CallExpression' &&
          cur.callee.type === 'MemberExpression' &&
          cur.callee.property.name === 'encodeFunctionData'
        ) {
          return true;
        }
        cur = cur.parent;
      }
      return false;
    }

    return {
      FunctionDeclaration:        enterScope,
      FunctionExpression:          enterScope,
      ArrowFunctionExpression:     enterScope,
      'FunctionDeclaration:exit':  exitScope,
      'FunctionExpression:exit':   exitScope,
      'ArrowFunctionExpression:exit': exitScope,

      AwaitExpression(node) {
        const scope = currentScope();
        if (!scope) return;

        const arg = node.argument;
        if (arg.type !== 'CallExpression') return;
        if (arg.callee.type !== 'MemberExpression') return;

        const method = arg.callee.property.name || arg.callee.property.value;
        if (!method || !allMethods.has(method)) return;
        if (isInsideEncodeFunctionData(node)) return;

        // Check if the other half of any pair is already in scope.
        for (const [a, b] of pairs) {
          if (method === b && scope.has(a)) {
            context.report({ node, messageId: 'separateCalls', data: { methodA: a, methodB: b } });
          }
          if (method === a && scope.has(b)) {
            context.report({ node, messageId: 'separateCalls', data: { methodA: a, methodB: b } });
          }
        }

        scope.add(method);
      },
    };
  },
};
