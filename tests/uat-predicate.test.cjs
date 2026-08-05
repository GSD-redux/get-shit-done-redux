'use strict';

/**
 * Unit tests for uat-predicate.cjs
 * Tests the pure-computation module: stripFalsePositiveContexts,
 * parseUatResultItems, evaluateUatPassed.
 *
 * Issue #247 — phase uat-passed predicate
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const fc = require('fast-check');

const {
  stripFalsePositiveContexts,
  parseUatResultItems,
  analyzeMarkdown,
  evaluateUatPassed,
} = require('../gsd-core/bin/lib/uat-predicate.cjs');
const { cleanup } = require('./helpers.cjs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-uat-pred-test-'));
}

function rmDir(dir) {
  cleanup(dir);
}

function writeFile(dir, name, content) {
  fs.writeFileSync(path.join(dir, name), content, 'utf-8');
}

function makePassingUat(n = 1) {
  const tests = Array.from({ length: n }, (_, i) => [
    `### ${i + 1}. Test ${i + 1}`,
    `expected: It works`,
    `result: passed`,
    '',
  ].join('\n')).join('\n');
  return `---\nstatus: passed\n---\n\n# UAT\n\n${tests}`;
}

// ─── stripFalsePositiveContexts ────────────────────────────────────────────────

describe('stripFalsePositiveContexts — frontmatter', () => {
  test('removes leading frontmatter block', () => {
    const input = '---\nstatus: pending\nresult: pending\n---\n\nReal content here.';
    const out = stripFalsePositiveContexts(input);
    assert.ok(!out.includes('result: pending'), 'frontmatter result: pending should be stripped');
    assert.ok(out.includes('Real content here.'), 'body content must be preserved');
  });

  test('does not strip non-frontmatter --- dividers later in document', () => {
    const input = '---\nstatus: ok\n---\n\n# Section\n\n---\n\nMore content.';
    const out = stripFalsePositiveContexts(input);
    assert.ok(out.includes('More content.'), 'content after a non-frontmatter divider must survive');
  });

  test('handles CRLF frontmatter', () => {
    const input = '---\r\nstatus: partial\r\nresult: pending\r\n---\r\n\r\nBody text.';
    const out = stripFalsePositiveContexts(input);
    assert.ok(!out.includes('result: pending'), 'CRLF frontmatter must be stripped');
    assert.ok(out.includes('Body text.'), 'body after CRLF frontmatter must survive');
  });
});

describe('stripFalsePositiveContexts — HTML comments', () => {
  test('removes single-line HTML comment', () => {
    const input = 'Before\n<!-- result: pending -->\nAfter';
    const out = stripFalsePositiveContexts(input);
    assert.ok(!out.includes('result: pending'), 'HTML comment content must be stripped');
    assert.ok(out.includes('Before'), 'content before comment must survive');
    assert.ok(out.includes('After'), 'content after comment must survive');
  });

  test('removes multi-line HTML comment', () => {
    const input = 'A\n<!--\n### 1. Test\nexpected: Foo\nresult: pending\n-->\nB';
    const out = stripFalsePositiveContexts(input);
    assert.ok(!out.includes('result: pending'), 'multi-line HTML comment content must be stripped');
    assert.ok(out.includes('A'), 'content before comment must survive');
    assert.ok(out.includes('B'), 'content after comment must survive');
  });

  test('unterminated HTML comment swallows to EOF (fail-closed)', () => {
    const input = 'Before\n<!--\nresult: passed\nstill in comment';
    const out = stripFalsePositiveContexts(input);
    assert.ok(!out.includes('result: passed'), 'unterminated comment must swallow to EOF');
    assert.ok(out.includes('Before'), 'content before comment must survive');
  });
});

describe('stripFalsePositiveContexts — fenced code blocks', () => {
  test('removes backtick fence with result inside', () => {
    const input = 'Before\n```\n### 1. Test\nexpected: X\nresult: pending\n```\nAfter';
    const out = stripFalsePositiveContexts(input);
    assert.ok(!out.includes('result: pending'), 'content inside ``` fence must be stripped');
    assert.ok(out.includes('Before'), 'content before fence must survive');
    assert.ok(out.includes('After'), 'content after fence must survive');
  });

  test('removes tilde fence', () => {
    const input = 'Before\n~~~\n### 1. Test\nexpected: X\nresult: blocked\n~~~\nAfter';
    const out = stripFalsePositiveContexts(input);
    assert.ok(!out.includes('result: blocked'), 'content inside ~~~ fence must be stripped');
    assert.ok(out.includes('After'), 'content after tilde fence must survive');
  });

  test('handles indented fence', () => {
    const input = 'Before\n   ```\n### 1. Test\nresult: pending\n   ```\nAfter';
    const out = stripFalsePositiveContexts(input);
    assert.ok(!out.includes('result: pending'), 'content inside indented fence must be stripped');
  });

  test('handles CRLF in fenced block', () => {
    const input = 'Before\r\n```\r\nresult: pending\r\n```\r\nAfter';
    const out = stripFalsePositiveContexts(input);
    assert.ok(!out.includes('result: pending'), 'CRLF fenced content must be stripped');
  });

  test('preserves content after multiple fenced blocks', () => {
    const input = [
      'Real intro',
      '```',
      'result: pending',
      '```',
      '',
      '### 1. Real Test',
      'expected: Works',
      'result: passed',
      '',
      '```',
      'result: pending',
      '```',
      'Trailing',
    ].join('\n');
    const out = stripFalsePositiveContexts(input);
    assert.ok(out.includes('result: passed'), 'real result outside fence must survive');
    assert.ok(!out.includes('result: pending'), 'fenced result: pending must be stripped');
  });
});

describe('stripFalsePositiveContexts — blockquotes', () => {
  test('removes blockquote lines', () => {
    const input = 'Before\n> ### 1. Test\n> result: pending\nAfter';
    const out = stripFalsePositiveContexts(input);
    assert.ok(!out.includes('result: pending'), 'blockquote content must be stripped');
    assert.ok(out.includes('Before'), 'content before blockquote must survive');
    assert.ok(out.includes('After'), 'content after blockquote must survive');
  });

  test('removes indented blockquote lines', () => {
    const input = 'Before\n  > result: pending\nAfter';
    const out = stripFalsePositiveContexts(input);
    assert.ok(!out.includes('result: pending'), 'indented blockquote content must be stripped');
  });
});

// ─── parseUatResultItems ───────────────────────────────────────────────────────

describe('parseUatResultItems', () => {
  test('parses a single passing test', () => {
    const content = '### 1. Login flow\nexpected: User logs in\nresult: passed\n';
    const items = parseUatResultItems(content);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].test, 1);
    assert.strictEqual(items[0].name, 'Login flow');
    assert.strictEqual(items[0].result, 'passed');
  });

  test('parses bracketed result [passed] (#2273)', () => {
    const content = '### 1. Login flow\nexpected: User logs in\nresult: [passed]\n';
    const items = parseUatResultItems(content);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].result, 'passed');
  });

  test('parses bracketed result [pass]', () => {
    const content = '### 1. Login flow\nexpected: User logs in\nresult: [pass]\n';
    const items = parseUatResultItems(content);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].result, 'pass');
  });

  test('parses multiple tests with mixed results', () => {
    const content = [
      '### 1. Test A',
      'expected: A',
      'result: passed',
      '',
      '### 2. Test B',
      'expected: B',
      'result: pending',
      '',
      '### 3. Test C',
      'expected: C',
      'result: failed',
      '',
    ].join('\n');
    const items = parseUatResultItems(content);
    assert.strictEqual(items.length, 3);
    assert.strictEqual(items[0].result, 'passed');
    assert.strictEqual(items[1].result, 'pending');
    assert.strictEqual(items[2].result, 'failed');
  });

  test('returns empty array for content with no test blocks', () => {
    const items = parseUatResultItems('Just some markdown with no test blocks.');
    assert.strictEqual(items.length, 0);
  });

  test('lowercases result value', () => {
    const content = '### 1. Test\nexpected: Foo\nresult: PASSED\n';
    const items = parseUatResultItems(content);
    assert.strictEqual(items[0].result, 'passed');
  });

  test('heading with NO result line → result:missing (blocker state, not dropped)', () => {
    const content = [
      '### 1. Test without result',
      'expected: Something',
      'some notes here',
      '',
    ].join('\n');
    const items = parseUatResultItems(content);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].result, 'missing');
  });

  test('result: line with leading whitespace (indented scalar) is NOT parsed as column-0', () => {
    // A real failing test uses block-scalar expected: with blank line before result
    // The result: with leading whitespace should not be treated as a column-0 result
    const content = [
      '### 1. Test A',
      'expected: |',
      '  multi',
      '  line',
      '',
      '  result: pending',
      '',
    ].join('\n');
    // The indented result: should not match; heading has no column-0 result → 'missing'
    const items = parseUatResultItems(content);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].result, 'missing',
      'Indented result: line must not be parsed as column-0 result');
  });

  test('block-scalar expected: with blank line then column-0 result: is parsed correctly', () => {
    // Real failing test: block-scalar expected: | followed by blank + real result: pending
    const content = [
      '### 1. Test A',
      'expected: |',
      '  multi',
      '  line',
      '',
      'result: pending',
      '',
    ].join('\n');
    const items = parseUatResultItems(content);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(items[0].result, 'pending',
      'Column-0 result: after blank line must be parsed correctly');
  });
});

// ─── evaluateUatPassed — boundary coverage ────────────────────────────────────

describe('evaluateUatPassed — boundary coverage', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  test('0 UAT files → passed:false, no_uat_artifacts:true (fail-closed, no vacuous pass)', () => {
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false,
      'No UAT files must NOT vacuously pass — fail-closed');
    assert.strictEqual(report.no_uat_artifacts, true);
    assert.deepStrictEqual(report.uat_files, []);
    assert.deepStrictEqual(report.blockers, []);
  });

  test('1 passing test → passed:true, no_uat_artifacts:false', () => {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(1));
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, true);
    assert.strictEqual(report.no_uat_artifacts, false);
    assert.strictEqual(report.blockers.length, 0);
    assert.strictEqual(report.checks.length, 1);
    assert.strictEqual(report.checks[0].passing, true);
  });

  test('N all-passing tests → passed:true', () => {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(5));
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, true);
    assert.strictEqual(report.checks.every(c => c.passing), true);
  });

  test('N-1 passing + 1 pending → passed:false', () => {
    // 3 tests total: tests 1,2 passed; test 3 pending
    const content = [
      '---', 'status: partial', '---', '',
      '### 1. Test A', 'expected: A', 'result: passed', '',
      '### 2. Test B', 'expected: B', 'result: passed', '',
      '### 3. Test C', 'expected: C', 'result: pending', '',
    ].join('\n');
    writeFile(tmpDir, 'phase-UAT.md', content);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false);
    assert.ok(report.blockers.some(b => /test 3/i.test(b) || /pending/i.test(b)),
      `Expected blocker for pending test, got: ${JSON.stringify(report.blockers)}`);
  });

  test('1 blocked test → passed:false', () => {
    const content = [
      '---', 'status: partial', '---', '',
      '### 1. Test A', 'expected: A', 'result: blocked', '',
    ].join('\n');
    writeFile(tmpDir, 'phase-UAT.md', content);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false);
  });

  test('1 skipped test → passed:false', () => {
    const content = [
      '---', 'status: partial', '---', '',
      '### 1. Test A', 'expected: A', 'result: skipped', '',
    ].join('\n');
    writeFile(tmpDir, 'phase-UAT.md', content);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false);
  });

  test('1 failed test → passed:false', () => {
    const content = [
      '---', 'status: partial', '---', '',
      '### 1. Test A', 'expected: A', 'result: failed', '',
    ].join('\n');
    writeFile(tmpDir, 'phase-UAT.md', content);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false);
  });

  test('1 human_needed test → passed:false', () => {
    const content = [
      '---', 'status: partial', '---', '',
      '### 1. Test A', 'expected: A', 'result: human_needed', '',
    ].join('\n');
    writeFile(tmpDir, 'phase-UAT.md', content);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false);
  });

  test('heading with no result line → result:missing → blocker → passed:false', () => {
    const content = [
      '### 1. Test without result',
      'expected: It should work',
      'some notes but no result',
      '',
    ].join('\n');
    writeFile(tmpDir, 'phase-UAT.md', content);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false);
    assert.ok(report.checks.some(c => c.result === 'missing' && !c.passing),
      `Expected missing check item, got checks: ${JSON.stringify(report.checks)}`);
    assert.ok(report.blockers.some(b => /missing/i.test(b)),
      `Expected missing blocker, got: ${JSON.stringify(report.blockers)}`);
  });
});

// ─── evaluateUatPassed — frontmatter status checks ────────────────────────────

describe('evaluateUatPassed — frontmatter status', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  const failingUatStatuses = ['partial', 'diagnosed', 'pending', 'blocked', 'in_progress', 'failed'];
  const failingUatResults = ['pending', 'blocked', 'failed'];

  for (const status of failingUatStatuses) {
    test(`UAT frontmatter status=${status} → passed:false`, () => {
      const content = [
        '---', `status: ${status}`, '---', '',
        '### 1. Test A', 'expected: A', 'result: passed', '',
      ].join('\n');
      writeFile(tmpDir, 'phase-UAT.md', content);
      const report = evaluateUatPassed(tmpDir);
      assert.strictEqual(report.passed, false,
        `status=${status} should cause failure`);
      assert.ok(report.blockers.some(b => b.includes(status)),
        `Blocker should mention status=${status}, got: ${JSON.stringify(report.blockers)}`);
    });
  }

  for (const result of failingUatResults) {
    test(`UAT frontmatter result=${result} → passed:false`, () => {
      const content = [
        '---', `result: ${result}`, '---', '',
        '### 1. Test A', 'expected: A', 'result: passed', '',
      ].join('\n');
      writeFile(tmpDir, 'phase-UAT.md', content);
      const report = evaluateUatPassed(tmpDir);
      assert.strictEqual(report.passed, false,
        `fm result=${result} should cause failure`);
    });
  }
});

// ─── evaluateUatPassed — VERIFICATION file checks ─────────────────────────────

describe('evaluateUatPassed — VERIFICATION files', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  test('VERIFICATION with status human_needed → passed:false', () => {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(1));
    writeFile(tmpDir, 'phase-VERIFICATION.md', '---\nstatus: human_needed\n---\n\nNeeds human check.');
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false);
    assert.ok(report.blockers.some(b => /human_needed/i.test(b)),
      `Expected human_needed blocker, got: ${JSON.stringify(report.blockers)}`);
  });

  test('VERIFICATION with status gaps_found → passed:false', () => {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(1));
    writeFile(tmpDir, 'phase-VERIFICATION.md', '---\nstatus: gaps_found\n---\n\nHas gaps.');
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false);
    assert.ok(report.blockers.some(b => /gaps_found/i.test(b)),
      `Expected gaps_found blocker, got: ${JSON.stringify(report.blockers)}`);
  });

  test('VERIFICATION with status pending → passed:false', () => {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(1));
    writeFile(tmpDir, 'phase-VERIFICATION.md', '---\nstatus: pending\n---\n');
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false);
  });

  test('VERIFICATION with status failed → passed:false (blocking)', () => {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(1));
    writeFile(tmpDir, 'phase-VERIFICATION.md', '---\nstatus: failed\n---\n');
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false);
    assert.ok(report.blockers.some(b => /failed/i.test(b)),
      `Expected failed blocker, got: ${JSON.stringify(report.blockers)}`);
  });

  test('VERIFICATION with status in_progress → passed:false (blocking)', () => {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(1));
    writeFile(tmpDir, 'phase-VERIFICATION.md', '---\nstatus: in_progress\n---\n');
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false);
    assert.ok(report.blockers.some(b => /in_progress/i.test(b)),
      `Expected in_progress blocker, got: ${JSON.stringify(report.blockers)}`);
  });

  test('VERIFICATION with missing status does NOT satisfy --require-verification', () => {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(1));
    writeFile(tmpDir, 'phase-VERIFICATION.md', '# Verification\nNo frontmatter status.\n');
    const report = evaluateUatPassed(tmpDir, { policy: { requireVerification: true } });
    assert.strictEqual(report.passed, false,
      'Missing verification status must not satisfy requireVerification');
    assert.ok(report.blockers.some(b => /verification required/i.test(b)),
      `Expected verification-required blocker, got: ${JSON.stringify(report.blockers)}`);
  });

  test('VERIFICATION with unknown status does NOT satisfy --require-verification', () => {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(1));
    writeFile(tmpDir, 'phase-VERIFICATION.md', '---\nstatus: some_unknown_status\n---\n');
    const report = evaluateUatPassed(tmpDir, { policy: { requireVerification: true } });
    assert.strictEqual(report.passed, false,
      'Unknown verification status must not satisfy requireVerification');
    assert.ok(report.blockers.some(b => /verification required/i.test(b)),
      `Expected verification-required blocker, got: ${JSON.stringify(report.blockers)}`);
  });

  test('VERIFICATION with status passed → does not block', () => {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(1));
    writeFile(tmpDir, 'phase-VERIFICATION.md', '---\nstatus: passed\n---\n\nAll good.');
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, true);
    assert.strictEqual(report.verification_files.length, 1);
  });

  test('VERIFICATION with status complete → does not block', () => {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(1));
    writeFile(tmpDir, 'phase-VERIFICATION.md', '---\nstatus: complete\n---\n\nAll good.');
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, true);
  });

  test('VERIFICATION with status verified → does not block', () => {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(1));
    writeFile(tmpDir, 'phase-VERIFICATION.md', '---\nstatus: verified\n---\n\nAll good.');
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, true);
  });

  test('VERIFICATION with status human_passed → does not block', () => {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(1));
    writeFile(tmpDir, 'phase-VERIFICATION.md', '---\nstatus: human_passed\n---\n\nAll good.');
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, true);
  });

  test('VERIFICATION status complete does NOT satisfy --require-verification', () => {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(1));
    writeFile(tmpDir, 'phase-VERIFICATION.md', '---\nstatus: complete\n---\n\nAll good.');
    const report = evaluateUatPassed(tmpDir, { policy: { requireVerification: true } });
    assert.strictEqual(report.passed, false);
    assert.strictEqual(report.policy.require_verification, true);
    assert.ok(report.blockers.some(b => /verification required/i.test(b)),
      `Expected verification-required blocker, got: ${JSON.stringify(report.blockers)}`);
  });

  test('VERIFICATION status verified does NOT satisfy --require-verification', () => {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(1));
    writeFile(tmpDir, 'phase-VERIFICATION.md', '---\nstatus: verified\n---\n\nAll good.');
    const report = evaluateUatPassed(tmpDir, { policy: { requireVerification: true } });
    assert.strictEqual(report.passed, false);
    assert.ok(report.blockers.some(b => /verification required/i.test(b)),
      `Expected verification-required blocker, got: ${JSON.stringify(report.blockers)}`);
  });

  test('VERIFICATION status human_passed does NOT satisfy --require-verification', () => {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(1));
    writeFile(tmpDir, 'phase-VERIFICATION.md', '---\nstatus: human_passed\n---\n\nAll good.');
    const report = evaluateUatPassed(tmpDir, { policy: { requireVerification: true } });
    assert.strictEqual(report.passed, false);
    assert.ok(report.blockers.some(b => /verification required/i.test(b)),
      `Expected verification-required blocker, got: ${JSON.stringify(report.blockers)}`);
  });
});

// ─── evaluateUatPassed — policy.requireVerification ───────────────────────────

describe('evaluateUatPassed — policy.requireVerification', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  test('requireVerification=true with no verification file → passed:false', () => {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(1));
    const report = evaluateUatPassed(tmpDir, { policy: { requireVerification: true } });
    assert.strictEqual(report.passed, false);
    assert.ok(report.blockers.some(b => /verification required/i.test(b)),
      `Expected verification-required blocker, got: ${JSON.stringify(report.blockers)}`);
    assert.strictEqual(report.policy.require_verification, true);
  });

  test('requireVerification=true with passing verification → passed:true', () => {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(1));
    writeFile(tmpDir, 'phase-VERIFICATION.md', '---\nstatus: passed\n---\n\nOK.');
    const report = evaluateUatPassed(tmpDir, { policy: { requireVerification: true } });
    assert.strictEqual(report.passed, true);
    assert.strictEqual(report.policy.require_verification, true);
  });

  test('requireVerification=false (default) with no verification file → passed:true', () => {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(1));
    const report = evaluateUatPassed(tmpDir, { policy: { requireVerification: false } });
    assert.strictEqual(report.passed, true);
    assert.strictEqual(report.policy.require_verification, false);
  });
});

// ─── evaluateUatPassed — #3057 B3: staleness-check indeterminate is surfaced ──
//
// readVerificationStatus's internal staleness check can fail (fs /
// scanPhasePlans / clock error). Pre-#3057 B3 wiring, the requireVerification
// policy check used only `.status`, dropping `.staleCheckIndeterminate` on
// the floor — so cmdPhaseUatPassed's JSON output (which spreads this whole
// report) could never distinguish "checked; nothing is stale" from "could
// not check". `verification_stale_check_indeterminate` must never itself gate
// `passed`/`blockers` — only readVerificationStatus's `.status` may.

describe('#3057 B3: evaluateUatPassed — verification staleness-check indeterminate is surfaced', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  function seedVerifiedPhase() {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(1));
    writeFile(tmpDir, 'phase-VERIFICATION.md', '---\nstatus: passed\n---\n\nOK.');
    writeFile(tmpDir, 'phase-SUMMARY.md', '# Summary');
    const verificationPath = path.join(tmpDir, 'phase-VERIFICATION.md');
    const summaryPath = path.join(tmpDir, 'phase-SUMMARY.md');
    // Deterministic mtime ordering — never rely on write-order clock ties.
    const older = new Date('2026-01-01T00:00:00.000Z');
    const newer = new Date('2026-01-01T00:01:00.000Z');
    fs.utimesSync(summaryPath, older, older);
    fs.utimesSync(verificationPath, newer, newer);
    return { summaryPath, verificationPath };
  }

  test('an fs failure inside the staleness check sets verification_stale_check_indeterminate:true; passed/blockers unchanged', (t) => {
    const { summaryPath, verificationPath } = seedVerifiedPhase();
    const origStatSync = fs.statSync;

    t.mock.method(fs, 'statSync', function injectedStaleCheckFault(target, ...args) {
      const targetPath = String(target);
      if (targetPath === verificationPath || targetPath === summaryPath) {
        throw new Error('injected stat failure (#3057 B3)');
      }
      return origStatSync.call(fs, target, ...args);
    });

    const report = evaluateUatPassed(tmpDir, { policy: { requireVerification: true } });

    // Pre-existing no-throw fail-open routing is UNCHANGED — `passed`/
    // `blockers` are exactly what they would be without the injected fault.
    assert.strictEqual(report.passed, true);
    assert.deepStrictEqual(report.blockers, []);
    assert.strictEqual(report.verification_stale_check_indeterminate, true);
  });

  test('a completed staleness check that finds nothing stale reports verification_stale_check_indeterminate:false', () => {
    seedVerifiedPhase();

    const report = evaluateUatPassed(tmpDir, { policy: { requireVerification: true } });

    assert.strictEqual(report.passed, true);
    assert.strictEqual(report.verification_stale_check_indeterminate, false);
  });

  test('requireVerification not set → verification_stale_check_indeterminate is always false (readVerificationStatus never reached)', () => {
    seedVerifiedPhase();

    const report = evaluateUatPassed(tmpDir, { policy: { requireVerification: false } });

    assert.strictEqual(report.verification_stale_check_indeterminate, false);
  });
});

// ─── evaluateUatPassed — malformed markdown guard ─────────────────────────────

describe('evaluateUatPassed — malformed markdown blocker', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  test('unterminated code fence → malformed blocker → passed:false (even with real result:passed)', () => {
    const content = [
      '### 1. Real Test',
      'expected: Something',
      'result: passed',
      '',
      '```',
      'unterminated fence — no closing delimiter',
    ].join('\n');
    writeFile(tmpDir, 'phase-UAT.md', content);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false,
      'Unterminated fence must always block, even if a result:passed exists');
    assert.ok(report.blockers.some(b => /malformed/i.test(b)),
      `Expected malformed blocker, got: ${JSON.stringify(report.blockers)}`);
  });

  test('unterminated HTML comment → malformed blocker → passed:false', () => {
    const content = [
      '### 1. Real Test',
      'expected: Something',
      'result: passed',
      '',
      '<!-- unterminated comment',
      'no closing arrow',
    ].join('\n');
    writeFile(tmpDir, 'phase-UAT.md', content);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false,
      'Unterminated comment must always block');
    assert.ok(report.blockers.some(b => /malformed/i.test(b)),
      `Expected malformed blocker, got: ${JSON.stringify(report.blockers)}`);
  });

  test('well-formed fences → no malformed blocker', () => {
    const content = [
      '### 1. Real Test',
      'expected: Something',
      'result: passed',
      '',
      '```',
      'code here',
      '```',
    ].join('\n');
    writeFile(tmpDir, 'phase-UAT.md', content);
    const report = evaluateUatPassed(tmpDir);
    assert.ok(!report.blockers.some(b => /malformed/i.test(b)),
      'Well-formed fences must not produce malformed blocker');
  });
});

// ─── evaluateUatPassed — hardening regressions (the heart of #247) ────────────

describe('evaluateUatPassed — false-positive hardening regressions', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  test('#247: result:passed inside fenced block: parseUatResultItems returns [] for fake, evaluateUatPassed → passed:false + no_uat_artifacts:true', () => {
    // ONLY result: passed is inside a fenced block — no real test blocks
    const rawContent = [
      '```',
      '### 1. Fake Test',
      'expected: Example output',
      'result: passed',
      '```',
    ].join('\n');
    // After stripping, the clean content has no headings at all
    const clean = stripFalsePositiveContexts(rawContent);
    const items = parseUatResultItems(clean);
    assert.strictEqual(items.length, 0, 'Fake result inside fence must produce no items');

    writeFile(tmpDir, 'phase-UAT.md', rawContent);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false,
      'result:passed inside a fenced block must not flip passed to true');
    assert.strictEqual(report.no_uat_artifacts, true,
      'no real UAT items → no_uat_artifacts:true');
  });

  test('#247: result:passed inside blockquote: parseUatResultItems returns [] + evaluateUatPassed → passed:false + no_uat_artifacts:true', () => {
    const rawContent = [
      '> ### 1. Test',
      '> expected: Example',
      '> result: passed',
    ].join('\n');
    const clean = stripFalsePositiveContexts(rawContent);
    const items = parseUatResultItems(clean);
    assert.strictEqual(items.length, 0, 'Fake result inside blockquote must produce no items');

    writeFile(tmpDir, 'phase-UAT.md', rawContent);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false);
    assert.strictEqual(report.no_uat_artifacts, true);
  });

  test('#247: result:passed inside HTML comment: parseUatResultItems returns [] + evaluateUatPassed → passed:false + no_uat_artifacts:true', () => {
    const rawContent = [
      '<!-- ### 1. Test',
      'expected: Example',
      'result: passed -->',
    ].join('\n');
    const clean = stripFalsePositiveContexts(rawContent);
    const items = parseUatResultItems(clean);
    assert.strictEqual(items.length, 0, 'Fake result inside HTML comment must produce no items');

    writeFile(tmpDir, 'phase-UAT.md', rawContent);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false);
    assert.strictEqual(report.no_uat_artifacts, true);
  });

  test('#247: result:passed inside frontmatter: parseUatResultItems returns [] + evaluateUatPassed → passed:false + no_uat_artifacts:true', () => {
    const rawContent = [
      '---',
      'example_result: passed',
      '---',
      '',
      'No real test blocks here.',
    ].join('\n');
    const clean = stripFalsePositiveContexts(rawContent);
    const items = parseUatResultItems(clean);
    assert.strictEqual(items.length, 0, 'Fake result inside frontmatter must produce no items');

    writeFile(tmpDir, 'phase-UAT.md', rawContent);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false);
    assert.strictEqual(report.no_uat_artifacts, true);
  });

  test('#247: result:passed inside fenced block is NOT treated as passing test (with real failing test)', () => {
    const content = [
      '---',
      'status: partial',
      '---',
      '',
      '# Example',
      '',
      '```',
      '### 1. Test',
      'expected: Example output',
      'result: passed',
      '```',
      '',
      '### 1. Real Test',
      'expected: Something',
      'result: pending',
      '',
    ].join('\n');
    writeFile(tmpDir, 'phase-UAT.md', content);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false,
      'result:passed inside a fenced block must not flip passed to true');
    assert.ok(report.checks.some(c => c.result === 'pending' && !c.passing),
      'Real pending test must be captured');
  });

  test('#247: result:passed inside blockquote is NOT treated as passing test', () => {
    const content = [
      '---',
      'status: partial',
      '---',
      '',
      '> ### 1. Test',
      '> expected: Example',
      '> result: passed',
      '',
      '### 1. Real Test',
      'expected: Something',
      'result: pending',
      '',
    ].join('\n');
    writeFile(tmpDir, 'phase-UAT.md', content);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false,
      'result:passed inside a blockquote must not flip passed to true');
  });

  test('#247: result:passed inside HTML comment is NOT treated as passing test', () => {
    const content = [
      '---',
      'status: partial',
      '---',
      '',
      '<!-- ### 1. Test',
      'expected: Example',
      'result: passed -->',
      '',
      '### 1. Real Test',
      'expected: Something',
      'result: pending',
      '',
    ].join('\n');
    writeFile(tmpDir, 'phase-UAT.md', content);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false,
      'result:passed inside an HTML comment must not flip passed to true');
  });

  test('#247: result:passed inside frontmatter example is NOT treated as passing test', () => {
    const content = [
      '---',
      'status: partial',
      'example_result: passed',
      '---',
      '',
      '### 1. Real Test',
      'expected: Something',
      'result: pending',
      '',
    ].join('\n');
    writeFile(tmpDir, 'phase-UAT.md', content);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false,
      'result:passed in frontmatter must not flip passed to true');
  });

  test('#247: real passing test block outside all contexts → passed:true', () => {
    const content = [
      '---',
      'status: passed',
      '---',
      '',
      '# UAT Results',
      '',
      '### 1. Login works',
      'expected: User logs in',
      'result: passed',
      '',
    ].join('\n');
    writeFile(tmpDir, 'phase-UAT.md', content);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, true,
      'A real passing test outside false-positive contexts must pass');
  });

  test('block-scalar expected: followed by blank line + result: pending → parsed as blocker (not dropped)', () => {
    const content = [
      '### 1. Test A',
      'expected: |',
      '  multi',
      '  line expected output',
      '',
      'result: pending',
      '',
    ].join('\n');
    writeFile(tmpDir, 'phase-UAT.md', content);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false,
      'Block-scalar expected: with result: pending must be captured as a blocker');
    assert.ok(report.checks.some(c => c.result === 'pending' && !c.passing),
      `Expected pending check, got: ${JSON.stringify(report.checks)}`);
  });
});

// ─── evaluateUatPassed — output shape contract ───────────────────────────────

describe('evaluateUatPassed — output shape (Hyrum\'s Law contract)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  test('returns all required fields in the locked shape including no_uat_artifacts', () => {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(1));
    const report = evaluateUatPassed(tmpDir);

    // Locked field names
    assert.ok('passed' in report, 'report.passed must exist');
    assert.ok('uat_files' in report, 'report.uat_files must exist');
    assert.ok('verification_files' in report, 'report.verification_files must exist');
    assert.ok('checks' in report, 'report.checks must exist');
    assert.ok('blockers' in report, 'report.blockers must exist');
    assert.ok('no_uat_artifacts' in report, 'report.no_uat_artifacts must exist');
    assert.ok('policy' in report, 'report.policy must exist');
    assert.ok('require_verification' in report.policy, 'report.policy.require_verification must exist');

    // checks item shape
    if (report.checks.length > 0) {
      const c = report.checks[0];
      assert.ok('file' in c, 'check.file must exist');
      assert.ok('test' in c, 'check.test must exist');
      assert.ok('name' in c, 'check.name must exist');
      assert.ok('result' in c, 'check.result must exist');
      assert.ok('passing' in c, 'check.passing must exist');
    }
  });

  test('no_uat_artifacts is false when real checks exist', () => {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(1));
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.no_uat_artifacts, false);
  });

  test('no_uat_artifacts is true when no checks exist', () => {
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.no_uat_artifacts, true);
  });

  test('uat_files contains the filename', () => {
    writeFile(tmpDir, 'my-UAT.md', makePassingUat(1));
    const report = evaluateUatPassed(tmpDir);
    assert.ok(report.uat_files.includes('my-UAT.md'),
      `uat_files should include 'my-UAT.md', got: ${JSON.stringify(report.uat_files)}`);
  });

  test('verification_files contains the filename', () => {
    writeFile(tmpDir, 'phase-UAT.md', makePassingUat(1));
    writeFile(tmpDir, 'phase-VERIFICATION.md', '---\nstatus: passed\n---\n');
    const report = evaluateUatPassed(tmpDir);
    assert.ok(report.verification_files.includes('phase-VERIFICATION.md'),
      `verification_files should include 'phase-VERIFICATION.md', got: ${JSON.stringify(report.verification_files)}`);
  });
});

// ─── FIX A regression: nested-fence (~~~ inside ```) ─────────────────────────

describe('FIX A — nested fence: ~~~ inside ``` does not prematurely close outer fence', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmDir(tmpDir); });

  test('parseUatResultItems sees [] for fake inside ``` that encloses ~~~', () => {
    // A backtick fence that contains an inner ~~~ fence with a fake test block.
    // The ~~~ must NOT close the ``` fence — the whole interior is content and is dropped.
    const raw = [
      '```',
      '~~~',
      '### 1. Fake',
      'expected: X',
      'result: passed',
      '~~~',
      '```',
    ].join('\n');
    const clean = stripFalsePositiveContexts(raw);
    const items = parseUatResultItems(clean);
    assert.strictEqual(items.length, 0, 'fake inside nested fence must not leak through');
  });

  test('evaluateUatPassed → passed:false + no_uat_artifacts:true for nested-fence-only file', () => {
    const raw = [
      '```',
      '~~~',
      '### 1. Fake',
      'expected: X',
      'result: passed',
      '~~~',
      '```',
    ].join('\n');
    writeFile(tmpDir, 'phase-UAT.md', raw);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false, 'nested-fence fake must not flip passed');
    assert.strictEqual(report.no_uat_artifacts, true, 'no real items → no_uat_artifacts:true');
    assert.ok(!report.checks.some(c => c.name === 'Fake'), 'fake must not appear in checks');
  });

  test('balanced nested fence (``` inside ~~~) is NOT flagged as malformed', () => {
    // ~~~ outer, ``` inner — properly closed — should not trigger unterminatedFence
    const raw = [
      '~~~',
      '```',
      'code',
      '```',
      '~~~',
      '',
      '### 1. Real Test',
      'expected: Works',
      'result: passed',
    ].join('\n');
    const { unterminatedFence } = analyzeMarkdown(raw);
    assert.strictEqual(unterminatedFence, false, 'balanced nested fence must not be flagged');
    const clean = stripFalsePositiveContexts(raw);
    const items = parseUatResultItems(clean);
    assert.strictEqual(items.length, 1, 'real test outside fence must still be found');
    assert.strictEqual(items[0].result, 'passed');
  });

  test('real result:passed outside ``` that encloses ~~~ → passed:true (no false-block)', () => {
    const raw = [
      '---',
      'status: passed',
      '---',
      '',
      '```',
      '~~~',
      '### 1. Fake',
      'result: passed',
      '~~~',
      '```',
      '',
      '### 1. Real Test',
      'expected: Works',
      'result: passed',
    ].join('\n');
    writeFile(tmpDir, 'phase-UAT.md', raw);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, true, 'real result outside nested fence must still pass');
    assert.ok(!report.checks.some(c => c.name === 'Fake'), 'fake must not appear in checks');
  });
});

// ─── FIX B regression: cross-line result value ────────────────────────────────

describe('FIX B — cross-line result: value must be on the same line', () => {
  test('result: with value on next line → result:missing (not passed)', () => {
    const content = [
      '### 1. Cross-line Test',
      'expected: Y',
      'result:',
      '',
      'passed',
    ].join('\n');
    const items = parseUatResultItems(content);
    assert.strictEqual(items.length, 1);
    assert.notStrictEqual(items[0].result, 'passed',
      'result value on a subsequent line must not be captured as passed');
    assert.strictEqual(items[0].result, 'missing',
      'cross-line result must yield missing (blocker)');
  });

  test('evaluateUatPassed → passed:false for cross-line result:passed', () => {
    const tmpDir = makeTmpDir();
    try {
      const content = [
        '### 1. Cross-line Test',
        'expected: Y',
        'result:',
        '',
        'passed',
      ].join('\n');
      writeFile(tmpDir, 'phase-UAT.md', content);
      const report = evaluateUatPassed(tmpDir);
      assert.strictEqual(report.passed, false);
      assert.ok(!report.checks.some(c => c.result === 'passed'),
        'cross-line result must not produce a passing check');
    } finally {
      rmDir(tmpDir);
    }
  });
});

// ─── FIX C regression: masked-comment (earlier closed comment + later unterminated) ──

describe('FIX C — dangling comment survives earlier balanced comment', () => {
  test('analyzeMarkdown detects unterminated comment after a properly closed one', () => {
    const raw = [
      '<!-- ok -->',
      'Some text',
      '<!--',
      '### 1. Fake',
      'result: passed',
    ].join('\n');
    const { unterminatedComment } = analyzeMarkdown(raw);
    assert.strictEqual(unterminatedComment, true,
      'later unterminated comment must be detected even after a balanced one');
  });

  test('evaluateUatPassed → passed:false (malformed) when later comment is unterminated', () => {
    const tmpDir = makeTmpDir();
    try {
      const raw = [
        '### 1. Real Test',
        'expected: Something',
        'result: passed',
        '',
        '<!-- properly closed -->',
        '',
        '<!--',
        '### 2. Fake',
        'result: passed',
      ].join('\n');
      writeFile(tmpDir, 'phase-UAT.md', raw);
      const report = evaluateUatPassed(tmpDir);
      assert.strictEqual(report.passed, false,
        'unterminated later comment must trigger malformed blocker');
      assert.ok(report.blockers.some(b => /malformed/i.test(b)),
        `Expected malformed blocker, got: ${JSON.stringify(report.blockers)}`);
    } finally {
      rmDir(tmpDir);
    }
  });

  test('analyzeMarkdown does NOT flag a file with only properly balanced comments', () => {
    const raw = [
      '<!-- first comment -->',
      'Some text',
      '<!-- second comment -->',
      '',
      '### 1. Real Test',
      'result: passed',
    ].join('\n');
    const { unterminatedComment } = analyzeMarkdown(raw);
    assert.strictEqual(unterminatedComment, false,
      'only balanced comments must not be flagged as unterminated');
  });
});

// ─── FIX D regression: balanced mixed fences are NOT flagged ─────────────────

describe('FIX D — odd-fence-count heuristic replaced: balanced mixed fences not flagged', () => {
  test('analyzeMarkdown: ``` followed by ~~~ (both balanced) → unterminatedFence:false', () => {
    const raw = [
      '```',
      'code',
      '```',
      '',
      '~~~',
      'more code',
      '~~~',
    ].join('\n');
    const { unterminatedFence } = analyzeMarkdown(raw);
    assert.strictEqual(unterminatedFence, false,
      'two separate balanced fences must not trigger unterminatedFence');
  });

  test('evaluateUatPassed: multiple balanced fences + real passing test → passed:true, no malformed blocker', () => {
    const tmpDir = makeTmpDir();
    try {
      const raw = [
        '---',
        'status: passed',
        '---',
        '',
        '```',
        'result: fake',
        '```',
        '',
        '~~~',
        'result: also fake',
        '~~~',
        '',
        '### 1. Real Test',
        'expected: Works',
        'result: passed',
      ].join('\n');
      writeFile(tmpDir, 'phase-UAT.md', raw);
      const report = evaluateUatPassed(tmpDir);
      assert.ok(!report.blockers.some(b => /malformed/i.test(b)),
        `Balanced mixed fences must not produce malformed blocker, got: ${JSON.stringify(report.blockers)}`);
      assert.strictEqual(report.passed, true,
        'real test outside balanced fences must still pass');
    } finally {
      rmDir(tmpDir);
    }
  });
});

// ─── FIX E extra: fake-not-in-checks assertions for existing mixed tests ──────

describe('FIX E — fake items must NOT appear in checks (absence assertions)', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmDir(tmpDir); });

  test('fake inside fence + real pending: fake NOT in checks', () => {
    const content = [
      '---', 'status: partial', '---', '',
      '```',
      '### 10. Fake',
      'expected: Fake',
      'result: passed',
      '```',
      '',
      '### 1. Real Test',
      'expected: Something',
      'result: pending',
      '',
    ].join('\n');
    writeFile(tmpDir, 'phase-UAT.md', content);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false);
    assert.ok(!report.checks.some(c => c.name === 'Fake'),
      'fake test inside fence must not appear in checks');
  });

  test('fake inside blockquote + real pending: fake NOT in checks', () => {
    const content = [
      '---', 'status: partial', '---', '',
      '> ### 10. Fake',
      '> expected: Fake',
      '> result: passed',
      '',
      '### 1. Real Test',
      'expected: Something',
      'result: pending',
      '',
    ].join('\n');
    writeFile(tmpDir, 'phase-UAT.md', content);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false);
    assert.ok(!report.checks.some(c => c.name === 'Fake'),
      'fake test inside blockquote must not appear in checks');
  });

  test('fake inside HTML comment + real pending: fake NOT in checks', () => {
    const content = [
      '---', 'status: partial', '---', '',
      '<!-- ### 10. Fake',
      'expected: Fake',
      'result: passed -->',
      '',
      '### 1. Real Test',
      'expected: Something',
      'result: pending',
      '',
    ].join('\n');
    writeFile(tmpDir, 'phase-UAT.md', content);
    const report = evaluateUatPassed(tmpDir);
    assert.strictEqual(report.passed, false);
    assert.ok(!report.checks.some(c => c.name === 'Fake'),
      'fake test inside HTML comment must not appear in checks');
  });
});

// ─── Property-based test (fast-check) ─────────────────────────────────────────

describe('evaluateUatPassed — property: wrapping in false-positive context never flips to passed', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmDir(tmpDir);
  });

  test('fc: inserting result:passed inside wrapper context never flips a failing UAT to passed', () => {
    // A baseline UAT file that has a pending item — it must always evaluate to passed:false
    // regardless of how many "result: passed" lines we inject inside fenced/blockquote/comment wrappers.
    const baseFailingBody = [
      '### 1. Real Test',
      'expected: It works',
      'result: pending',
      '',
    ].join('\n');

    const wrappers = fc.constantFrom(
      // backtick fence
      (inner) => '```\n' + inner + '\n```',
      // tilde fence
      (inner) => '~~~\n' + inner + '\n~~~',
      // HTML comment
      (inner) => '<!--\n' + inner + '\n-->',
      // blockquote — prefix each line
      (inner) => inner.split('\n').map(l => '> ' + l).join('\n'),
    );

    fc.assert(
      fc.property(wrappers, fc.nat(3), (wrap, extraCount) => {
        // Build a "fake passing block" that would fool a naive regex
        const fakePassingLines = Array.from({ length: extraCount + 1 }, (_, i) =>
          `### ${i + 10}. Fake Test ${i + 10}\nexpected: Fake\nresult: passed`
        ).join('\n');

        const fullContent = [
          '---',
          'status: partial',
          '---',
          '',
          wrap(fakePassingLines),
          '',
          baseFailingBody,
        ].join('\n');

        // Write to a unique tmp file to avoid cross-test state
        const fcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-fc-uat-'));
        try {
          fs.writeFileSync(path.join(fcDir, 'feature-UAT.md'), fullContent, 'utf-8');
          const report = evaluateUatPassed(fcDir);
          // The pending item must always keep passed:false
          // AND fake items injected via wrappers must never appear in checks
          const hasFakeInChecks = report.checks.some(c => c.name.startsWith('Fake Test'));
          return report.passed === false && !hasFakeInChecks;
        } finally {
          cleanup(fcDir);
        }
      }),
      { numRuns: 50 }
    );
  });
});
