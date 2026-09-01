'use strict';

/**
 * Tests for scripts/lint-portable-grep.cjs — the ratchet that bans GNU-only
 * `grep -P`/`--perl-regexp` in gsd workflow / agent / reference / command
 * markdown (#4112 macOS regression: a `grep -oP` left behind after the
 * `pause-work.md` `$((` shell-syntax fix silently resolved phase/spike/sketch
 * detection to "" on stock macOS's BSD grep).
 *
 * Tests the PURE check logic (findPerlGrepInvocations) directly, on in-memory
 * string fixtures, so the suite is fast, hermetic, and never reads real repo
 * files (that integration concern is already covered by `npm run lint:ci`).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { findPerlGrepInvocations } = require('../scripts/lint-portable-grep.cjs');

describe('lint-portable-grep: findPerlGrepInvocations pure logic', () => {
  test('flags `grep -oP` with a lookahead pattern', () => {
    const findings = findPerlGrepInvocations(String.raw`grep -oP 'x\K[^/]+'`);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].line, 1);
  });

  test('flags bare `grep -P`', () => {
    const findings = findPerlGrepInvocations(`grep -P 'x'`);
    assert.strictEqual(findings.length, 1);
  });

  test('flags `grep --perl-regexp` long form', () => {
    const findings = findPerlGrepInvocations(`grep --perl-regexp 'x'`);
    assert.strictEqual(findings.length, 1);
  });

  test('flags `egrep -P`', () => {
    const findings = findPerlGrepInvocations(`egrep -P 'x'`);
    assert.strictEqual(findings.length, 1);
  });

  test('flags `fgrep -P`', () => {
    const findings = findPerlGrepInvocations(`fgrep -P 'x'`);
    assert.strictEqual(findings.length, 1);
  });

  test('passes `grep -o` (no P flag)', () => {
    const findings = findPerlGrepInvocations(`grep -o 'x'`);
    assert.strictEqual(findings.length, 0);
  });

  test('passes `grep -E` (POSIX ERE, no perl flag)', () => {
    const findings = findPerlGrepInvocations(`grep -E 'x'`);
    assert.strictEqual(findings.length, 0);
  });

  test('passes a line containing `--path` (lowercase p, not a -P cluster)', () => {
    const findings = findPerlGrepInvocations(`some-cmd --path /foo | grep -o 'x'`);
    assert.strictEqual(findings.length, 0);
  });

  test('segment-scoping: an unrelated earlier -P-bearing command does not taint a later plain grep', () => {
    const findings = findPerlGrepInvocations(`foo -P | grep -o 'x'`);
    assert.strictEqual(findings.length, 0, 'the -P belongs to `foo`, not to the grep invocation after the pipe');
  });

  test('multi-line input: finding reports the correct 1-indexed line number', () => {
    const text = ['line one is clean', 'line two is also clean', `grep -oP 'x\\K.*'`, 'line four is clean'].join(
      '\n',
    );
    const findings = findPerlGrepInvocations(text);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].line, 3);
  });

  test('empty string input produces no findings', () => {
    const findings = findPerlGrepInvocations('');
    assert.strictEqual(findings.length, 0);
  });
});
