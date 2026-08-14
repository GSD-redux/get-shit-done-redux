'use strict';

/**
 * Characterization tests for the UI safety gate module.
 * Locks checkUiPresence behaviour and UI_TOKENS export shape.
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  checkUiPresence,
  UI_TOKENS,
} = require('../gsd-core/bin/lib/ui-safety-gate.cjs');

describe('UI_TOKENS', () => {
  test('is an array containing expected token strings', () => {
    assert.ok(Array.isArray(UI_TOKENS));
    assert.ok(UI_TOKENS.includes('UI'));
    assert.ok(UI_TOKENS.includes('frontend'));
    assert.ok(UI_TOKENS.includes('component'));
    assert.ok(UI_TOKENS.length > 0);
  });
});

describe('checkUiPresence', () => {
  test('returns { hasUI: false, tokens: [], matchedToken: null, matchedLine: null } for non-string input', () => {
    assert.deepStrictEqual(checkUiPresence(42), { hasUI: false, tokens: [], matchedToken: null, matchedLine: null });
    assert.deepStrictEqual(checkUiPresence(null), { hasUI: false, tokens: [], matchedToken: null, matchedLine: null });
  });

  test('returns false for empty string', () => {
    assert.deepStrictEqual(checkUiPresence(''), { hasUI: false, tokens: [], matchedToken: null, matchedLine: null });
  });

  test('detects standalone UI token (case-insensitive)', () => {
    const result = checkUiPresence('This task involves UI work');
    assert.ok(result.hasUI);
    assert.ok(result.tokens.includes('ui'));
  });

  test('detects frontend token', () => {
    const result = checkUiPresence('Build a frontend component');
    assert.ok(result.hasUI);
    assert.ok(result.tokens.includes('frontend'));
  });

  test('does NOT match interior of alphanumeric word (bug #3706)', () => {
    // "Requirements" contains "ui" interior — must NOT match
    const result = checkUiPresence('Requirements analysis');
    assert.ok(!result.hasUI, 'Requirements should not trigger UI gate');

    // "microfrontend" is all-alphanumeric — must NOT match
    const result2 = checkUiPresence('microfrontend architecture');
    assert.ok(!result2.hasUI, 'microfrontend should not trigger UI gate');
  });

  test('matches token separated by hyphen (word boundary)', () => {
    // "micro-frontend" — "frontend" is at a word boundary after "-"
    const result = checkUiPresence('micro-frontend design');
    assert.ok(result.hasUI);
    assert.ok(result.tokens.includes('frontend'));
  });

  // ── #3312: hyphenated proper nouns DO match the sniffer (by design — the same
  // boundary rule that catches `micro-frontend`). The false-positive fix lives in
  // the GATE (computeUiPlanGate structural corroboration), NOT in the sniffer:
  // weakening this rule would regress `micro-frontend`. These tests pin the
  // sniffer behavior AND the matchedToken/matchedLine introspection fields the
  // gate forwards so an operator can see what tripped it.

  test('#3312 hyphenated proper noun (dashboard-financeiro) matches the sniffer — surfaced via matchedToken/matchedLine', () => {
    const result = checkUiPresence('Fix broken references in dashboard-financeiro and .env.tpl.');
    assert.strictEqual(result.hasUI, true,
      'the sniffer matches `dashboard` at the hyphen boundary — this is the #3312 trigger, intentionally preserved');
    assert.deepStrictEqual(result.tokens, ['dashboard']);
    assert.strictEqual(result.matchedToken, 'dashboard');
    assert.ok(
      typeof result.matchedLine === 'string' && result.matchedLine.includes('dashboard-financeiro'),
      'matchedLine carries the first matching line so the operator sees the proper-noun context',
    );
  });

  test('matchedLine is the FIRST line containing a match', () => {
    const result = checkUiPresence('Intro line with no tokens.\nBuild the login form.\nAlso a dashboard.');
    assert.strictEqual(result.matchedToken, 'form');
    assert.strictEqual(result.matchedLine, 'Build the login form.');
  });

  test('`**UI hint**: yes` with no token matches reports null matchedToken/matchedLine', () => {
    const result = checkUiPresence('**UI hint**: yes\n\nBackend API refactor.\n');
    assert.strictEqual(result.hasUI, true, 'hint:yes is authoritative');
    assert.strictEqual(result.matchedToken, null);
    assert.strictEqual(result.matchedLine, null);
  });

  test('normalises CRLF line endings', () => {
    const result = checkUiPresence('Phase 1\r\nBuild a form\r\nDone');
    assert.ok(result.hasUI);
    assert.ok(result.tokens.includes('form'));
  });

  test('deduplicates repeated tokens', () => {
    const result = checkUiPresence('UI component and another UI widget');
    // "ui" should only appear once in tokens
    const uiCount = result.tokens.filter((t) => t === 'ui').length;
    assert.strictEqual(uiCount, 1);
  });

  test('detects multiple distinct tokens', () => {
    const result = checkUiPresence('Build a dashboard with a form');
    assert.ok(result.hasUI);
    assert.ok(result.tokens.includes('dashboard'));
    assert.ok(result.tokens.includes('form'));
  });

  // ── #2150: the `**UI hint**: yes|no` metadata line must not false-positive ──

  test('#2150 `**UI hint**: no` is authoritative non-frontend (no false positive)', () => {
    const result = checkUiPresence('**UI hint**: no\n\nBackend-only spike for RBAC/Entra.\n');
    assert.strictEqual(result.hasUI, false,
      'a phase that explicitly declares UI hint: no must not be flagged as UI');
    assert.deepStrictEqual(result.tokens, []);
  });

  test('#2150 `**UI hint**: yes` is authoritative frontend', () => {
    const result = checkUiPresence('**UI hint**: yes\n\nRefactor the login screen layout.\n');
    assert.strictEqual(result.hasUI, true,
      'a phase that explicitly declares UI hint: yes must be flagged as UI');
  });

  test('#2150 `**UI hint**: yes` over a pure-backend body still flags UI', () => {
    const result = checkUiPresence('**UI hint**: yes\n\nBackend API refactor.\n');
    assert.strictEqual(result.hasUI, true, 'hint:yes is authoritative even with no UI tokens');
    assert.deepStrictEqual(result.tokens, []);
  });

  test('#2150 hint value is whole-word matched (nope/not do not mean no)', () => {
    const result = checkUiPresence('**UI hint**: nope\n\nBuild a dashboard component.\n');
    assert.strictEqual(result.hasUI, true,
      'a malformed hint value like "nope" must not be read as "no"; fall through to token-sniffing');
  });

  test('#2150 a hint line without yes/no is stripped (bare UI token does not fire)', () => {
    // A malformed hint (`UI hint: maybe`) must not false-positive on the bare
    // `UI` token in the line itself; other UI tokens elsewhere still detect.
    const result = checkUiPresence('**UI hint**: maybe\n\nBackend REST API only.\n');
    assert.strictEqual(result.hasUI, false,
      'the bare UI token in a UI hint line must not count as a UI indicator');
  });

  test('#2150 hint: no overrides even genuine UI language elsewhere', () => {
    // The explicit declaration is authoritative — the author owns it.
    const result = checkUiPresence('**UI hint**: no\n\nBuild a dashboard component.\n');
    assert.strictEqual(result.hasUI, false,
      'an explicit UI hint: no overrides token-sniffing');
  });
});
