/**
 * @file eslint-rules/no-interpolated-innerhtml.js
 * @description ESLint rule that flags interpolated markup assigned to
 *   `innerHTML` / `outerHTML` or passed to `insertAdjacentHTML`.
 *
 * Phase 1 of the HTML cleanup migrated all structural markup sites to
 * `<template>` elements. What remains is prose/editorial content and
 * trusted-constant writes. This rule blocks *new* interpolation sinks
 * (template literals with expressions, or `+`-concat) while leaving
 * static strings and trusted variable writes alone.
 *
 * Rejects:
 *   el.innerHTML = `<span>${x}</span>`;
 *   el.innerHTML = "<tag>" + x + "</tag>";
 *   el.insertAdjacentHTML("beforeend", `<li>${name}</li>`);
 *
 * Allows:
 *   el.innerHTML = "";
 *   el.innerHTML = "<static>markup</static>";
 *   el.innerHTML = DISCLOSURE_HTML;  // trusted constant reference
 *   el.innerHTML = s.body;           // trusted property reference
 */

"use strict";

/** Return true if `node` is an interpolated markup expression. */
function isInterpolated(node) {
  if (!node) return false;
  if (node.type === "TemplateLiteral") {
    return node.expressions && node.expressions.length > 0;
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    return true;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow interpolated markup on innerHTML/outerHTML/insertAdjacentHTML",
    },
    schema: [],
    messages: {
      interpolated:
        "Do not build {{sink}} from interpolated values. Use createElement + textContent, or clone a <template>. Trusted constants and static strings are OK.",
    },
  },

  create(context) {
    function reportIf(node, rhs, sink) {
      if (isInterpolated(rhs)) {
        context.report({ node, messageId: "interpolated", data: { sink } });
      }
    }

    return {
      AssignmentExpression(node) {
        if (node.left.type !== "MemberExpression") return;
        const propName = node.left.property.name || node.left.property.value;
        if (propName !== "innerHTML" && propName !== "outerHTML") return;
        reportIf(node, node.right, propName);
      },

      CallExpression(node) {
        if (node.callee.type !== "MemberExpression") return;
        const method = node.callee.property.name || node.callee.property.value;
        if (method !== "insertAdjacentHTML") return;
        // insertAdjacentHTML(position, markup) — check arg[1]
        reportIf(node, node.arguments[1], "insertAdjacentHTML");
      },
    };
  },
};
