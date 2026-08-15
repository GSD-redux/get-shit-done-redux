'use strict';

// Tests for scripts/lint-allow-test-rule-refs.cjs — the guard that (a)
// ratchets exemption-marker comments on IDENTITY (uncited comments must
// carry a tracking-issue ref or be grandfathered), (b) ratchets EFFECTIVE
// exemption SITES (a marker actually suppressing a violation the
// `no-source-grep` rule detects there) against a tight ceiling, and (c)
// tracks UNVERIFIED marker-bearing files (a marker with no detectable
// violation nearby) against a loose ceiling that never fails on a drop
// (#3520 / epic #3464 phase 5). Uses the script's env overrides to point at
// sandbox fixture dirs/files; never touches the real tests/ dir or the real
// allowlist/ceiling JSON.
//
// Identifier note: the script computes `relpath = path.relative(ROOT, full)`
// where ROOT is the repo root (path.join(__dirname, '..') inside the script),
// NOT relative to the fixture tests dir. Since fixtures live in a temp dir
// outside the repo, the identifiers the script produces are relative paths
// like `../../../../tmp/xyz/tests-0/foo.test.cjs`, not `tests/foo.test.cjs`.
// This file mirrors that exact computation (relToRoot below) rather than
// hardcoding a `tests/...`-shaped string, so assertions match reality
// regardless of where the OS places the temp dir.

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Linter } = require('eslint');
const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { toLegacyResult } = require('./helpers/git-fixture.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const ROOT = path.join(__dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts', 'lint-allow-test-rule-refs.cjs');

// The "repo baseline" row below (unlike every other row in this file) points
// the script at the REAL repo tests/scripts/eslint-rules/etc trees with no
// sandbox override, so it drives ESLint's `Linter` over every real
// marker-bearing file the script finds (~294 files after the #3464 perf
// follow-up narrowed the Linter pass off the full ~1200-file glob walk).
// That is a heavier class than `PROBE_TIMEOUT_MS` describes ("a single short
// CLI query or `node -e` probe against a temp fixture") — measured ~2.3-3.3s
// locally post-narrowing, down from ~7-12s pre-narrowing, which is what
// previously died at exactly the `PROBE_TIMEOUT_MS=15000` bound under CI
// load (empty stdout/stderr, exitCode null — SIGKILLed by the harness
// timeout, not a real assertion failure). 30000ms is ~10x the measured local
// runtime, leaving real headroom for slower CI runners without hand-waving
// the bound back up to "whatever makes it pass this once."
const REPO_BASELINE_LINT_TIMEOUT_MS = 30000;

// Deliberately split so this file's OWN source never contains the contiguous
// exemption-marker substring the script under test scans for — the script
// does a raw-text scan (not AST/comment parsing) for the marker-inventory
// check, so an unsplit literal here would make THIS test file register as
// its own offender when the real lint:ci run scans tests/.
const MARKER = 'allow' + '-test-rule:';

// Row 13/14/15 (structural guard) import the rule and the script under test
// directly by reference, never re-declaring their logic.
const noSourceGrepRule = require('../eslint-rules/no-source-grep.cjs');
const scriptUnderTest = require('../scripts/lint-allow-test-rule-refs.cjs');

let sandbox;
let fixtureCount = 0;

// Mirrors the script's own `path.relative(ROOT, full).split(path.sep).join('/')`
// computation (scripts/lint-allow-test-rule-refs.cjs's walkTestFiles) so
// expected identifiers are derived, never hardcoded as `tests/...`.
function relToRoot(fullPath) {
  return path.relative(ROOT, fullPath).split(path.sep).join('/');
}

/**
 * Writes `files` (name -> content) into a fresh sandbox tests dir, plus an
 * allowlist JSON and the two ceiling JSONs, then invokes the script via its
 * env-var overrides.
 *
 * @param {object} opts
 * @param {Object<string,string>} opts.files - filename (may include `/` for
 *   a nested subdirectory, e.g. `helpers/foo.cjs`) -> file content.
 * @param {string[]} [opts.allowlist] - allowlist array (default []).
 * @param {{maxSites:number,grace:number}} [opts.effectiveCeiling] - default
 *   is deliberately generous so a case not targeting the effective-sites
 *   ratchet does not accidentally also trip it.
 * @param {{maxFiles:number}} [opts.unverifiedCeiling] - default is
 *   deliberately generous, same reasoning.
 * @param {string[]} [opts.args] - extra CLI argv.
 * @param {Object<string,string>} [opts.extraFiles] - filename (relative to a
 *   FRESH per-call `extraRoot`, e.g. `scripts/fixture.cjs`) -> file content,
 *   for exercising the non-`tests/` glob blocks (scripts/** , eslint-rules/** ,
 *   etc. — #3464 phase 5 BLOCKER fix widened scan scope) in isolation. Left
 *   empty by default, which keeps every existing row's runtime unaffected: a
 *   per-call `extraRoot` is always created (never shared/reused across
 *   calls, so nothing leaks between rows) and set as
 *   `GSD_LINT_ALLOW_TEST_RULE_EXTRA_ROOT`; with no `extraFiles` it stays an
 *   empty directory, so every non-`tests/` glob costs one cheap empty
 *   `readdirSync`, never a real-repo scan.
 */
function runLint({
  files,
  allowlist = [],
  effectiveCeiling = { maxSites: 1000, grace: 1000 },
  unverifiedCeiling = { maxFiles: 1000 },
  args = [],
  extraFiles = {},
}) {
  const testsDir = path.join(sandbox, `tests-${fixtureCount}`);
  fs.mkdirSync(testsDir, { recursive: true });
  const relpaths = {};
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(testsDir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    relpaths[name] = relToRoot(full);
  }

  const extraRoot = path.join(sandbox, `extra-${fixtureCount}`);
  fs.mkdirSync(extraRoot, { recursive: true });
  for (const [name, content] of Object.entries(extraFiles)) {
    const full = path.join(extraRoot, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    relpaths[`extra:${name}`] = relToRoot(full);
  }

  const allowlistPath = path.join(sandbox, `allowlist-${fixtureCount}.json`);
  fs.writeFileSync(allowlistPath, JSON.stringify(allowlist));
  const effectiveCeilingPath = path.join(sandbox, `effective-ceiling-${fixtureCount}.json`);
  fs.writeFileSync(effectiveCeilingPath, JSON.stringify(effectiveCeiling));
  const unverifiedCeilingPath = path.join(sandbox, `unverified-ceiling-${fixtureCount}.json`);
  fs.writeFileSync(unverifiedCeilingPath, JSON.stringify(unverifiedCeiling));
  fixtureCount += 1;

  const result = runNode([SCRIPT, ...args], {
    cwd: ROOT,
    timeoutMs: PROBE_TIMEOUT_MS,
    env: {
      ...process.env,
      GSD_LINT_ALLOW_TEST_RULE_TESTS_DIR: testsDir,
      GSD_LINT_ALLOW_TEST_RULE_EXTRA_ROOT: extraRoot,
      GSD_LINT_ALLOW_TEST_RULE_ALLOWLIST: allowlistPath,
      GSD_LINT_ALLOW_TEST_RULE_EFFECTIVE_CEILING: effectiveCeilingPath,
      GSD_LINT_ALLOW_TEST_RULE_UNVERIFIED_CEILING: unverifiedCeilingPath,
    },
  });
  return { ...toLegacyResult(result), relpaths, testsDir, extraRoot };
}

describe('lint-allow-test-rule-refs', () => {
  before(() => {
    sandbox = createTempDir('gsd-lint-allow-test-rule-');
  });

  after(() => {
    cleanup(sandbox);
  });

  // ─── citation check (unchanged contract) ───────────────────────────────

  test('passes when a known uncited exemption is grandfathered', () => {
    // runLint's testsDir naming (`tests-${fixtureCount}`) is deterministic
    // and only increments once files are written, so the relpath the script
    // will compute can be predicted before the run.
    const testsDir = path.join(sandbox, `tests-${fixtureCount}`);
    const relpath = relToRoot(path.join(testsDir, 'foo.test.cjs'));
    const r = runLint({
      files: { 'foo.test.cjs': `// ${MARKER} some-reason\n` },
      allowlist: [`${relpath} :: some-reason`],
    });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  });

  test('fails on a novel uncited exemption not in the allowlist (test-matrix row 10)', () => {
    const r = runLint({
      files: { 'foo.test.cjs': `// ${MARKER} mystery-reason\n` },
      allowlist: [],
    });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /mystery-reason/);
  });

  test('fails on a stale allowlist entry (ratchet-down enforcement)', () => {
    const r = runLint({
      // Must be VALID JS (parsed by the real Linter, not just grepped) — a
      // bare "no marker here" is not valid syntax and would now correctly
      // throw a loud parse failure (the SECOND FIX below) rather than
      // silently exercising the ratchet-down path this test targets.
      files: { 'foo.test.cjs': '// no marker here\n' },
      allowlist: ['tests/definitely-stale-file.test.cjs :: stale-reason'],
    });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /stale-reason/);
    assert.match(r.stderr, /definitely-stale-file\.test\.cjs/);
  });

  test('a cited exemption passes the citation check with an empty allowlist', () => {
    const r = runLint({
      files: { 'cited.test.cjs': `// ${MARKER} see #456\n` },
      allowlist: [],
    });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  });

  test('the SAME cited exemption (no adjacent violation) still counts toward the unverified-files ceiling', () => {
    // This marker has NOTHING to suppress (no fs.readFileSync at all in the
    // file), so under the effective/unverified split it lands in the
    // UNVERIFIED pool, not the effective one — distinct from the old
    // single-ceiling behavior this replaces.
    const r = runLint({
      files: { 'cited.test.cjs': `// ${MARKER} see #456\n` },
      allowlist: [],
      unverifiedCeiling: { maxFiles: 0 },
    });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /allow-test-rule-unverified-markers/);
  });

  test('a duplicate uncited reason in one file dedupes to one identifier', () => {
    const testsDir = path.join(sandbox, `tests-${fixtureCount}`);
    const relpath = relToRoot(path.join(testsDir, 'dup.test.cjs'));
    // A SINGLE allowlist entry suffices — if the dedupe regressed (two
    // identifiers produced), this single-entry allowlist would leave one
    // novel offender and fail.
    const r = runLint({
      files: { 'dup.test.cjs': `// ${MARKER} dup-reason\n// ${MARKER} dup-reason\n` },
      allowlist: [`${relpath} :: dup-reason`],
    });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  });

  test('unknown CLI arguments are rejected with exit code 2', () => {
    const r = runLint({ files: {}, allowlist: [], args: ['--bogus'] });
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /unknown argument/);
    assert.match(r.stderr, /--bogus/);
  });

  test('repo baseline passes (real tests/ dir against real allowlist + ceilings)', () => {
    const r = runNode([SCRIPT], { cwd: ROOT, timeoutMs: REPO_BASELINE_LINT_TIMEOUT_MS });
    assert.strictEqual(r.exitCode, 0, `stderr: ${r.stderr}\nstdout: ${r.stdout}`);
    assert.match(r.stdout, /effective exemptions:/);
    assert.match(r.stdout, /unverified markers:/);
    assert.match(r.stdout, /Known limit:/);
  });

  // ─── #3520 test-matrix rows 1-12 ────────────────────────────────────────

  test('row 1: marker adjacent to a detected violation counts as effective, not unverified', () => {
    const code = [
      "const fs = require('fs');",
      "const path = require('path');",
      `// ${MARKER} reason (#1)`,
      "const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'); src.includes('x');",
    ].join('\n');
    // Pin the exact effective-site count via a boundary ceiling: passes at
    // exactly 1, fails at 0 — that is how this file proves "counted as
    // effective" without needing to parse the ok-message text.
    const pass = runLint({
      files: { 'row1.test.cjs': code },
      effectiveCeiling: { maxSites: 1, grace: 0 },
      unverifiedCeiling: { maxFiles: 0 }, // must NOT also count as unverified
    });
    assert.strictEqual(pass.status, 0, `stderr: ${pass.stderr}`);

    const failsAtZero = runLint({
      files: { 'row1.test.cjs': code },
      effectiveCeiling: { maxSites: 0, grace: 0 },
    });
    assert.notStrictEqual(failsAtZero.status, 0);
    assert.match(failsAtZero.stderr, /allow-test-rule-effective-sites/);
  });

  test('row 2: marker with no detectable violation counts as unverified, not effective', () => {
    const code = [
      `// ${MARKER} reason (#2)`,
      "const fs = require('fs');",
      "const path = require('path');",
      "const content = fs.readFileSync(path.join(__dirname, '..', 'docs', 'readme.md'), 'utf-8');",
      "content.includes('hello');",
    ].join('\n');
    const pass = runLint({
      files: { 'row2.test.cjs': code },
      effectiveCeiling: { maxSites: 0, grace: 0 }, // must NOT count as effective
      unverifiedCeiling: { maxFiles: 1 },
    });
    assert.strictEqual(pass.status, 0, `stderr: ${pass.stderr}`);

    const failsAtZeroUnverified = runLint({
      files: { 'row2.test.cjs': code },
      unverifiedCeiling: { maxFiles: 0 },
    });
    assert.notStrictEqual(failsAtZeroUnverified.status, 0);
    assert.match(failsAtZeroUnverified.stderr, /allow-test-rule-unverified-markers/);
  });

  test('row 3: no marker, no violation — counted in neither pool', () => {
    const code = [
      "const assert = require('node:assert/strict');",
      "assert.strictEqual(1 + 1, 2);",
    ].join('\n');
    const r = runLint({
      files: { 'row3.test.cjs': code },
      effectiveCeiling: { maxSites: 0, grace: 0 },
      unverifiedCeiling: { maxFiles: 0 },
    });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  });

  test('row 4: a violation with NO marker anywhere in the file is not flagged by this gate (#3464 perf follow-up narrowed live-violation detection to marker-bearing files; npm run lint / npm run lint:ci enforce unmarked files separately)', () => {
    const code = [
      "const fs = require('fs');",
      "const path = require('path');",
      "const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'); src.includes('x');",
    ].join('\n');
    const r = runLint({ files: { 'row4.test.cjs': code } });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  });

  test('row 4b: a live violation in a file that DOES carry a marker (elsewhere, unrelated) still fails the gate', () => {
    // Same shape as the parity corpus's "marker far above an unrelated later
    // violation" fixture: M1 suppresses V1, but V2 is far enough away (and
    // has no marker of its own) to stay live. Proves the marker-bearing
    // narrowing (row 4 above) does not also let a genuine live violation
    // slip through in a file this gate DOES still lint.
    const code = [
      "const fs = require('fs');",
      "const path = require('path');",
      `// ${MARKER} reason for V1 (#1)`,
      "const s1 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'); s1.includes('x');",
      ...Array.from({ length: 20 }, (_, i) => `// unrelated filler line ${i + 1}`),
      "const s2 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'b.cjs'), 'utf-8'); s2.includes('y');",
    ].join('\n');
    const r = runLint({ files: { 'row4b.test.cjs': code } });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /allow-test-rule-live-violations/);
    assert.match(r.stderr, /row4b\.test\.cjs/);
  });

  test('row 5: a file with one effective site and one inert marker (nothing nearby to suppress) counts as effective only', () => {
    // "One suppressing, one not" per test-matrix row 5, realized without an
    // actual unsuppressed violation (which would make row 5 indistinguishable
    // from row 4's assertion): M1 suppresses a real V1; M2 sits above a .md
    // read the rule never flags, so it suppresses nothing because there is
    // nothing there to suppress. The file must still classify as effective
    // (>=1 effective site), never also unverified — no double counting.
    const code = [
      "const fs = require('fs');",
      "const path = require('path');",
      `// ${MARKER} effective site (#1)`,
      "const s1 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'); s1.includes('x');",
      '',
      `// ${MARKER} inert marker, nothing nearby (#2)`,
      "const content = fs.readFileSync(path.join(__dirname, '..', 'docs', 'readme.md'), 'utf-8');",
      "content.includes('hello');",
    ].join('\n');
    const r = runLint({
      files: { 'row5.test.cjs': code },
      effectiveCeiling: { maxSites: 1, grace: 0 },
      unverifiedCeiling: { maxFiles: 0 }, // the file must NOT also appear here
    });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  });

  test('row 6: effective count exceeds its ceiling fails, message names effective sites', () => {
    const code = [
      "const fs = require('fs');",
      "const path = require('path');",
      `// ${MARKER} reason (#1)`,
      "const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'); src.includes('x');",
    ].join('\n');
    const r = runLint({
      files: { 'row6.test.cjs': code },
      effectiveCeiling: { maxSites: 0, grace: 0 },
    });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /allow-test-rule-effective-sites/);
    assert.match(r.stderr, /exceeds budget ceiling/);
  });

  test('row 7: effective count far below ceiling (slack beyond grace) fails — ratchet-down enforced', () => {
    const code = [
      "const fs = require('fs');",
      "const path = require('path');",
      `// ${MARKER} reason (#1)`,
      "const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'); src.includes('x');",
    ].join('\n');
    // actualMax=1, ceiling=10, grace=2 -> slack=9 > grace -> fails.
    const r = runLint({
      files: { 'row7.test.cjs': code },
      effectiveCeiling: { maxSites: 10, grace: 2 },
    });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /allow-test-rule-effective-sites/);
    assert.match(r.stderr, /Tighten the ceiling/);
  });

  test('row 8: unverified count exceeds its ceiling fails with a message distinct from row 6', () => {
    const code = [
      `// ${MARKER} reason (#2)`,
      "const fs = require('fs');",
      "const path = require('path');",
      "const content = fs.readFileSync(path.join(__dirname, '..', 'docs', 'readme.md'), 'utf-8');",
      "content.includes('hello');",
    ].join('\n');
    const r = runLint({
      files: { 'row8.test.cjs': code },
      unverifiedCeiling: { maxFiles: 0 },
    });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /allow-test-rule-unverified-markers/);
    assert.doesNotMatch(r.stderr, /allow-test-rule-effective-sites/);
  });

  test('row 9: unverified count dropping below its ceiling still passes (not tightly ratcheted)', () => {
    const code = [
      "const assert = require('node:assert/strict');",
      "assert.ok(true);",
    ].join('\n');
    // Zero unverified files, ceiling deliberately loose (100) -- a real
    // "tight" ratchet (like effective-sites) would force this down; the
    // unverified ceiling must not.
    const r = runLint({
      files: { 'row9.test.cjs': code },
      unverifiedCeiling: { maxFiles: 100 },
    });
    assert.strictEqual(r.status, 0, `stderr: ${r.stderr}`);
  });

  test('row 10: uncited marker is still an allowlist offender (citation contract unchanged)', () => {
    const r = runLint({
      files: { 'row10.test.cjs': `// ${MARKER} no citation here\n` },
      allowlist: [],
    });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /no citation here/);
  });

  test('row 11: marker text inside a string literal is not a directive — the violation it sits above stays live', () => {
    const code = [
      "const fs = require('fs');",
      "const path = require('path');",
      `const note = 'not a directive: ${MARKER} fake reason';`,
      "const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'); src.includes(note);",
    ].join('\n');
    const r = runLint({ files: { 'row11.test.cjs': code } });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /allow-test-rule-live-violations/);
    assert.match(r.stderr, /row11\.test\.cjs/);
  });

  test('row 12: a NUL-byte file is discovered and classified without a shell grep or a crash', () => {
    const testsDir = path.join(sandbox, `tests-${fixtureCount}`);
    fs.mkdirSync(testsDir, { recursive: true });
    const full = path.join(testsDir, 'row12.test.cjs');
    // A literal NUL byte embedded in otherwise-valid-looking source, plus a
    // marker comment, written via a real byte buffer (never a shell
    // redirect/grep, which would choke on the NUL differently than Node's
    // own fs + parser do).
    const buf = Buffer.concat([
      Buffer.from(`// ${MARKER} reason (#1)\nconst x = '`),
      Buffer.from([0]),
      Buffer.from("';\n"),
    ]);
    fs.writeFileSync(full, buf);
    const extraRoot = path.join(sandbox, `extra-${fixtureCount}`);
    fs.mkdirSync(extraRoot, { recursive: true });
    const effectiveCeilingPath = path.join(sandbox, `effective-ceiling-${fixtureCount}.json`);
    fs.writeFileSync(effectiveCeilingPath, JSON.stringify({ maxSites: 1000, grace: 1000 }));
    const unverifiedCeilingPath = path.join(sandbox, `unverified-ceiling-${fixtureCount}.json`);
    fs.writeFileSync(unverifiedCeilingPath, JSON.stringify({ maxFiles: 1000 }));
    const allowlistPath = path.join(sandbox, `allowlist-${fixtureCount}.json`);
    fs.writeFileSync(allowlistPath, JSON.stringify([]));
    fixtureCount += 1;

    const result = runNode([SCRIPT], {
      cwd: ROOT,
      timeoutMs: PROBE_TIMEOUT_MS,
      env: {
        ...process.env,
        GSD_LINT_ALLOW_TEST_RULE_TESTS_DIR: testsDir,
        GSD_LINT_ALLOW_TEST_RULE_EXTRA_ROOT: extraRoot,
        GSD_LINT_ALLOW_TEST_RULE_ALLOWLIST: allowlistPath,
        GSD_LINT_ALLOW_TEST_RULE_EFFECTIVE_CEILING: effectiveCeilingPath,
        GSD_LINT_ALLOW_TEST_RULE_UNVERIFIED_CEILING: unverifiedCeilingPath,
      },
    });
    const r = toLegacyResult(result);
    // Never crashes with an uncaught exception (no raw Node stack trace) —
    // it either passes or fails cleanly through the script's own messaging.
    assert.ok(
      r.status === 0 || r.status === 1,
      `unexpected exit status ${r.status}; stderr: ${r.stderr}`
    );
    assert.doesNotMatch(r.stderr, /at Object\.<anonymous>/);
    assert.doesNotMatch(r.stderr, /SyntaxError/);
  });

  // ─── #3464 phase 5 BLOCKER fix rows: widened scan scope + loud parse failure ───

  test('row 16: a non-.test.cjs file nested under tests/ carrying a marker is counted (unverified) — the live-command-registry.cjs case', () => {
    // A prior version of the scan only walked `tests/**/*.test.cjs`, so a
    // marker in a `tests/helpers/*.cjs`-shaped file (this repo's real
    // tests/helpers/live-command-registry.cjs instance) was invisible to
    // BOTH reported numbers. This file has no adjacent readFileSync+search
    // call, so it lands in the unverified pool, not effective.
    const code = [
      `// ${MARKER} reason (#2)`,
      "const fs = require('fs');",
      "const path = require('path');",
      "const content = fs.readFileSync(path.join(__dirname, '..', 'docs', 'readme.md'), 'utf-8');",
      "content.includes('hello');",
    ].join('\n');
    const pass = runLint({
      files: { 'helpers/row16.cjs': code },
      effectiveCeiling: { maxSites: 0, grace: 0 }, // must NOT count as effective
      unverifiedCeiling: { maxFiles: 1 },
    });
    assert.strictEqual(pass.status, 0, `stderr: ${pass.stderr}`);

    const failsAtZero = runLint({
      files: { 'helpers/row16.cjs': code },
      unverifiedCeiling: { maxFiles: 0 },
    });
    assert.notStrictEqual(failsAtZero.status, 0);
    assert.match(failsAtZero.stderr, /allow-test-rule-unverified-markers/);
  });

  test('row 17: a marker in a NON-tests registered glob (scripts/**/*.cjs-shaped sandbox path) is counted as effective', () => {
    // Exercises the widened scan scope itself (not just the tests/ side):
    // `eslint.config.mjs` also registers local/no-source-grep on
    // scripts/**/*.cjs (among others), and this must now actually be
    // scanned, not merely assumed reachable in theory.
    const code = [
      "const fs = require('fs');",
      "const path = require('path');",
      `// ${MARKER} reason (#1)`,
      "const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'); src.includes('x');",
    ].join('\n');
    const pass = runLint({
      files: {},
      extraFiles: { 'scripts/row17-fixture.cjs': code },
      effectiveCeiling: { maxSites: 1, grace: 0 },
      unverifiedCeiling: { maxFiles: 0 },
    });
    assert.strictEqual(pass.status, 0, `stderr: ${pass.stderr}`);

    const failsAtZero = runLint({
      files: {},
      extraFiles: { 'scripts/row17-fixture.cjs': code },
      effectiveCeiling: { maxSites: 0, grace: 0 },
    });
    assert.notStrictEqual(failsAtZero.status, 0);
    assert.match(failsAtZero.stderr, /allow-test-rule-effective-sites/);
  });

  test('row 18: an unparseable file makes the gate throw loudly instead of counting it as clean', () => {
    // Sibling to the "No matching configuration found" case, which already
    // throws — before this fix, a parse/verify failure inside
    // classifySiteLines was silently swallowed into `{effectiveLines: [],
    // liveLines: []}`, indistinguishable from a genuinely clean file. Genuine
    // invalid JS syntax (unbalanced braces / stray token), not just an
    // embedded NUL byte (row 12 proves NUL bytes alone parse fine).
    //
    // Must carry a marker (#3464 perf follow-up): the script now only drives
    // the Linter over marker-bearing files (a cheap substring pre-filter
    // over raw content — see the script's "Linter scope" doc comment), so an
    // unparseable file with NO marker at all is out of scope for THIS gate
    // entirely (an unparseable file fails `npm run lint` on its own, via
    // ESLint's own parse error, independent of this script). The marker
    // comment itself is valid syntax; only what follows it is broken.
    const code = `// ${MARKER} reason (#1)\nconst x = {{{ this is not valid javascript syntax ]`;
    const r = runLint({ files: { 'row18.test.cjs': code } });
    assert.notStrictEqual(r.status, 0);
    assert.match(r.stderr, /failed to parse\/verify/);
    assert.match(r.stderr, /row18\.test\.cjs/);
    // Never the "ok" success message — a parse failure must never present as
    // a clean run.
    assert.doesNotMatch(r.stdout, /^ok lint-allow-test-rule-refs/);
  });

  // ─── #3520 test-matrix rows 13-15: structural guard (parity + teeth) ───

  test('row 13: the script imports the predicate/detection from the rule module — no second copy of the adjacency arithmetic', () => {
    const scriptSource = fs.readFileSync(SCRIPT, 'utf8');
    // Imports the rule module directly.
    assert.match(scriptSource, /require\(['"]\.\.\/eslint-rules\/no-source-grep\.cjs['"]\)/);
    // Calls the rule's own exported predicate/collector, not a re-derivation.
    assert.match(scriptSource, /\.isSuppressedAt\(/);
    assert.match(scriptSource, /\.collectMarkerAndCommentLines\(/);
    // No duplicated lookahead constant or adjacency loop in the script's own
    // source — the tell for a hand-rolled second copy of isSuppressedAt's
    // arithmetic would be a re-declared "MAX_MARKER_LOOKAHEAD_LINES ="
    // assignment or a hand-written `markerLine + 1; l < violationLine`
    // purity loop.
    assert.doesNotMatch(scriptSource, /MAX_MARKER_LOOKAHEAD_LINES\s*=\s*\d/);
    assert.doesNotMatch(scriptSource, /markerLine \+ 1;\s*l\s*<\s*violationLine/);
    // Reference identity: what the script requires IS the same object the
    // rule module exports (not a structurally-similar copy).
    assert.strictEqual(
      require('../eslint-rules/no-source-grep.cjs').isSuppressedAt,
      noSourceGrepRule.isSuppressedAt
    );
  });

  test('row 14: parity — the script\'s suppressed verdict equals the real rule\'s independent report/no-report outcome, for every site in a fixture corpus', () => {
    // Ground truth, computed WITHOUT using isSuppressedAt or
    // collectMarkerAndCommentLines at all: run the REAL (non-neutralized)
    // `no-source-grep` rule through ESLint's Linter and record which lines
    // it reports. This is an independent code path from
    // scriptUnderTest.classifySiteLines (which calls the rule's exported
    // predicate directly) — the two must still agree everywhere, because
    // both are ultimately driven by the same rule.
    function realRuleReportedLines(code, filename) {
      const linter = new Linter({ configType: 'flat' });
      const config = {
        languageOptions: { ecmaVersion: 2022, sourceType: 'commonjs' },
        plugins: { local: { rules: { 'no-source-grep': noSourceGrepRule } } },
        rules: { 'local/no-source-grep': 'error' },
      };
      return linter
        .verify(code, config, filename)
        .filter((m) => m.messageId === 'noSourceGrep')
        .map((m) => m.line)
        .sort((a, b) => a - b);
    }

    const AT = MARKER; // already split above; reuse for fixture text

    const corpus = [
      // adjacent marker suppresses its violation
      [
        "const fs = require('fs');",
        "const path = require('path');",
        `// ${AT} reason (#1)`,
        "const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'); src.includes('x');",
      ].join('\n'),
      // no marker: violation stays live
      [
        "const fs = require('fs');",
        "const path = require('path');",
        "const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'b.cjs'), 'utf-8'); src.includes('x');",
      ].join('\n'),
      // marker far above an unrelated later violation: does not reach it
      [
        "const fs = require('fs');",
        "const path = require('path');",
        `// ${AT} reason for V1 (#1)`,
        "const s1 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'); s1.includes('x');",
        ...Array.from({ length: 20 }, (_, i) => `// unrelated filler line ${i + 1}`),
        "const s2 = fs.readFileSync(path.join(__dirname, '..', 'lib', 'b.cjs'), 'utf-8'); s2.includes('y');",
      ].join('\n'),
      // marker in a string literal does not suppress
      [
        "const fs = require('fs');",
        "const path = require('path');",
        `const note = 'not a directive: ${AT} fake reason';`,
        "const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf-8'); src.includes(note);",
      ].join('\n'),
      // marker directly above the read, search several comment-pure lines later
      [
        "const fs = require('fs');",
        "const path = require('path');",
        `// ${AT} reason (#1)`,
        "const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf8');",
        '// comment-pure line one',
        '// comment-pure line two',
        "src.includes('x');",
      ].join('\n'),
      // boundary: marker exactly MAX_MARKER_LOOKAHEAD_LINES (8) above is suppressed
      [
        "const fs = require('fs');",
        "const path = require('path');",
        `// ${AT} reason (#1)`,
        ...Array.from({ length: 7 }, (_, i) => `// filler comment line ${i + 1}`),
        "const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf8'); s.includes('x');",
      ].join('\n'),
      // boundary: marker one line beyond the lookahead is not suppressed
      [
        "const fs = require('fs');",
        "const path = require('path');",
        `// ${AT} reason (#1)`,
        ...Array.from({ length: 8 }, (_, i) => `// filler comment line ${i + 1}`),
        "const s = fs.readFileSync(path.join(__dirname, '..', 'lib', 'a.cjs'), 'utf8'); s.includes('x');",
      ].join('\n'),
      // no violation at all
      [
        "const assert = require('node:assert/strict');",
        "assert.ok(true);",
      ].join('\n'),
    ];

    for (const [i, code] of corpus.entries()) {
      const filename = `tests/parity-fixture-${i}.test.cjs`;
      const { liveLines } = scriptUnderTest.classifyCode(code, filename);
      const realLines = realRuleReportedLines(code, filename);
      assert.deepStrictEqual(
        [...liveLines].sort((a, b) => a - b),
        realLines,
        `fixture ${i}: script's live-line verdict disagreed with the real rule's report/no-report outcome`
      );
    }
  });

  test('row 15 (teeth for row 14, by construction): the exported isSuppressedAt is the SAME function the rule calls internally, so its default lookahead cannot diverge from the rule\'s', () => {
    // Runtime mutation of MAX_MARKER_LOOKAHEAD_LINES is not possible: it is
    // declared `const` at module scope inside eslint-rules/no-source-grep.cjs
    // and isSuppressedAt's default parameter closes over that lexical
    // binding directly, not over a mutable exported property — reassigning
    // `noSourceGrepRule.MAX_MARKER_LOOKAHEAD_LINES` would silently do
    // nothing to the real default. That immutability is deliberate (the
    // constant is not meant to be a runtime knob), so per the brief this
    // teeth check is asserted BY CONSTRUCTION rather than by faking a
    // mutation:
    //
    //  1. isSuppressedAt is a single exported function (verified by
    //     reference identity in row 13) — the script never has its own copy.
    //  2. Its `maxLookahead` parameter is genuinely load-bearing (not a
    //     decorative unused default): explicitly overriding it changes the
    //     verdict at the exact boundary where the DEFAULT (backed by
    //     MAX_MARKER_LOOKAHEAD_LINES) says "suppressed".
    //  3. Because the rule's own internal isSuppressed() call site and the
    //     script's classification call site both invoke this identical
    //     function with NO override (so both fall back to the same
    //     MAX_MARKER_LOOKAHEAD_LINES default), any future edit to that
    //     constant necessarily moves both call sites together — there is no
    //     second constant anywhere to drift out of step with it.
    // Default (no override) -> uses MAX_MARKER_LOOKAHEAD_LINES: land exactly
    // at the real boundary using the exported constant itself, so this test
    // tracks the constant's actual value rather than hardcoding "8".
    const gapAtBoundary = noSourceGrepRule.MAX_MARKER_LOOKAHEAD_LINES;
    const atBoundary = noSourceGrepRule.isSuppressedAt({
      markerLines: [1],
      violationLine: 1 + gapAtBoundary,
      commentLineSet: new Set(Array.from({ length: gapAtBoundary }, (_, i) => i + 2)),
      lines: Array.from({ length: gapAtBoundary + 1 }, () => '// filler'),
    });
    assert.strictEqual(atBoundary, true, 'default lookahead should suppress exactly at the boundary');

    // Same fixture, EXPLICIT override tighter than the real default: proves
    // the parameter actually drives the verdict (not ignored), which is the
    // load-bearing fact that makes "both call sites use the same default"
    // meaningful rather than vacuous.
    const overridden = noSourceGrepRule.isSuppressedAt({
      markerLines: [1],
      violationLine: 1 + gapAtBoundary,
      commentLineSet: new Set(Array.from({ length: gapAtBoundary }, (_, i) => i + 2)),
      lines: Array.from({ length: gapAtBoundary + 1 }, () => '// filler'),
      maxLookahead: gapAtBoundary - 1,
    });
    assert.strictEqual(overridden, false, 'an explicit tighter lookahead must change the verdict');
  });
});
