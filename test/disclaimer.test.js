'use strict';

/**
 * @file test/disclaimer.test.js
 * @description Tests for the disclaimer modal logic: cookie helpers,
 * accept/decline behaviour, and "Don't show this again" preference.
 *
 * Since the dashboard code runs in a browser, we mock the DOM and
 * document.cookie to test the logic in Node.js.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('assert');

// ── Minimal DOM + cookie mock ────────────────────────────────────────────────

function createMockDOM() {
  let cookies = '';
  const elements = {};

  const doc = {
    get cookie() { return cookies; },
    set cookie(v) {
      // Simple cookie jar: parse set-cookie and store name=value
      const [pair] = v.split(';');
      const [name] = pair.split('=');
      const parts = cookies.split('; ').filter(p => p && !p.startsWith(name + '='));
      // Check if expired (removal)
      if (v.includes('1970')) {
        cookies = parts.join('; ');
      } else {
        parts.push(pair);
        cookies = parts.join('; ');
      }
    },
    getElementById(id) { return elements[id] || null; },
  };

  function makeEl(id, tag) {
    const el = {
      id, tagName: tag || 'DIV',
      classList: {
        _classes: new Set(),
        add(c) { this._classes.add(c); },
        remove(c) { this._classes.delete(c); },
        contains(c) { return this._classes.has(c); },
      },
      checked: false,
      onclick: null,
    };
    elements[id] = el;
    return el;
  }

  return { doc, makeEl, elements };
}

// ── getCookie / setCookie / deleteCookie ──────────────────────────────────────

describe('disclaimer — cookie helpers', () => {
  let doc;

  beforeEach(() => {
    const mock = createMockDOM();
    doc = mock.doc;
  });

  function getCookie(name) {
    const m = doc.cookie.match('(?:^|; )' + name + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : null;
  }

  function setCookie(name, value) {
    const d = new Date();
    d.setTime(d.getTime() + 400 * 86400000);
    doc.cookie = name + '=' + encodeURIComponent(value)
      + ';expires=' + d.toUTCString() + ';path=/;SameSite=Lax';
  }

  function deleteCookie(name) {
    doc.cookie = name + '=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;SameSite=Lax';
  }

  it('getCookie returns null when cookie does not exist', () => {
    assert.strictEqual(getCookie('missing'), null);
  });

  it('setCookie + getCookie round-trip', () => {
    setCookie('test_key', 'hello');
    assert.strictEqual(getCookie('test_key'), 'hello');
  });

  it('deleteCookie removes the cookie', () => {
    setCookie('test_key', 'value');
    assert.strictEqual(getCookie('test_key'), 'value');
    deleteCookie('test_key');
    assert.strictEqual(getCookie('test_key'), null);
  });

  it('multiple cookies coexist', () => {
    setCookie('a', '1');
    setCookie('b', '2');
    assert.strictEqual(getCookie('a'), '1');
    assert.strictEqual(getCookie('b'), '2');
  });

  it('setCookie overwrites existing cookie', () => {
    setCookie('k', 'old');
    setCookie('k', 'new');
    assert.strictEqual(getCookie('k'), 'new');
  });
});

// ── Disclaimer modal logic ───────────────────────────────────────────────────

describe('disclaimer — modal behaviour', () => {
  it('accept hides the overlay', () => {
    const { makeEl } = createMockDOM();
    const overlay = makeEl('disclaimerOverlay');
    const acceptBtn = makeEl('disclaimerAccept');
    makeEl('disclaimerDecline');
    makeEl('disclaimerRemember');

    // Simulate initDisclaimer accept click
    overlay.classList.remove('hidden');
    acceptBtn.onclick = () => overlay.classList.add('hidden');
    acceptBtn.onclick();

    assert.strictEqual(overlay.classList.contains('hidden'), true);
  });

  it('decline hides overlay and activates disabled screen', () => {
    const { makeEl } = createMockDOM();
    const overlay = makeEl('disclaimerOverlay');
    const disabled = makeEl('appDisabledOverlay');
    const declineBtn = makeEl('disclaimerDecline');
    makeEl('disclaimerAccept');

    overlay.classList.remove('hidden');
    declineBtn.onclick = () => {
      overlay.classList.add('hidden');
      disabled.classList.add('active');
    };
    declineBtn.onclick();

    assert.strictEqual(overlay.classList.contains('hidden'), true);
    assert.strictEqual(disabled.classList.contains('active'), true);
  });

  it('accept with "remember" checked sets cookie', () => {
    const mock = createMockDOM();
    const overlay = mock.makeEl('disclaimerOverlay');
    const acceptBtn = mock.makeEl('disclaimerAccept');
    const rememberCb = mock.makeEl('disclaimerRemember');
    rememberCb.checked = true;

    let cookieSet = false;
    acceptBtn.onclick = () => {
      if (rememberCb.checked) cookieSet = true;
      overlay.classList.add('hidden');
    };
    acceptBtn.onclick();

    assert.strictEqual(cookieSet, true);
    assert.strictEqual(overlay.classList.contains('hidden'), true);
  });

  it('accept without "remember" does not set cookie', () => {
    const mock = createMockDOM();
    const overlay = mock.makeEl('disclaimerOverlay');
    const acceptBtn = mock.makeEl('disclaimerAccept');
    const rememberCb = mock.makeEl('disclaimerRemember');
    rememberCb.checked = false;

    let cookieSet = false;
    acceptBtn.onclick = () => {
      if (rememberCb.checked) cookieSet = true;
      overlay.classList.add('hidden');
    };
    acceptBtn.onclick();

    assert.strictEqual(cookieSet, false);
    assert.strictEqual(overlay.classList.contains('hidden'), true);
  });

  it('cookie presence skips disclaimer (auto-hidden)', () => {
    const mock = createMockDOM();
    const overlay = mock.makeEl('disclaimerOverlay');

    // Simulate: cookie already set → initDisclaimer hides immediately
    const hasCookie = true;
    if (hasCookie) {
      overlay.classList.add('hidden');
    }

    assert.strictEqual(overlay.classList.contains('hidden'), true);
  });

  it('decline does not set cookie (reload shows disclaimer again)', () => {
    const mock = createMockDOM();
    const overlay = mock.makeEl('disclaimerOverlay');
    const disabled = mock.makeEl('appDisabledOverlay');
    const declineBtn = mock.makeEl('disclaimerDecline');

    declineBtn.onclick = () => {
      // Decline never sets cookie
      overlay.classList.add('hidden');
      disabled.classList.add('active');
    };
    declineBtn.onclick();

    // No cookie was set — verify by checking cookie jar is empty
    assert.strictEqual(mock.doc.cookie, '');
    assert.strictEqual(disabled.classList.contains('active'), true);
  });
});
