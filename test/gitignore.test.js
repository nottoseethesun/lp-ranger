'use strict';

/**
 * @file test/gitignore.test.js
 * @description Ensures .gitignore contains rules for sensitive files
 * (env files, keyfiles, rebalance logs) so they are never committed.
 */

const { describe, it } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const GITIGNORE_PATH = path.join(__dirname, '..', '.gitignore');

describe('.gitignore safety', () => {
  const content = fs.readFileSync(GITIGNORE_PATH, 'utf8');
  const lines = content.split('\n').map(l => l.trim());

  it('ignores .env files', () => {
    assert.ok(lines.includes('.env'), '.env should be in .gitignore');
    assert.ok(lines.includes('.env.*'), '.env.* should be in .gitignore');
  });

  it('allows .env.example', () => {
    assert.ok(lines.includes('!.env.example'), '.env.example should be whitelisted');
  });

  it('ignores encrypted keyfiles', () => {
    assert.ok(
      lines.some(l => l.includes('keyfile') && !l.startsWith('#')),
      'keyfile patterns should be in .gitignore',
    );
  });

  it('ignores .wallet.json (encrypted wallet state)', () => {
    assert.ok(lines.includes('.wallet.json'), '.wallet.json should be in .gitignore');
  });

  it('ignores rebalance_log.json', () => {
    assert.ok(lines.includes('rebalance_log.json'), 'rebalance_log.json should be in .gitignore');
  });

  it('ignores node_modules', () => {
    assert.ok(
      lines.some(l => l === 'node_modules' || l === 'node_modules/'),
      'node_modules should be in .gitignore',
    );
  });
});
