// gsd-scan-ignore: #3409 — this test file's fixture strings are constructed
// via concatenation (never written as literal detector-matching source
// lines) so scripts/lint-unreachable-guard-drift.cjs, whose SCAN_DIRS do not
// include tests/, never has occasion to see this comment as an attempted
// declaration either.

'use strict';

/**
 * Tests for the unreachable-shell-guard prompt-layer drift guard (#3409) —
 * scripts/lint-unreachable-guard-drift.cjs.
 *
 * Design:      .gsd/phase/feat-3409-unreachable-shell-guard-lint/40-design.md
 * Test matrix: .gsd/phase/feat-3409-unreachable-shell-guard-lint/50-test-matrix.md
 *
 * Covers every row of the matrix EXCEPT the "Regression — the three defects
 * this PR fixes" section (G1-G4), which lives in
 * tests/unreachable-shell-guard.test.cjs and is not touched here.
 *
 * FIXTURE STRINGS ARE BUILT, NOT WRITTEN LITERALLY, where a literal would
 * itself be a detector-matching source line living under this repo's tree —
 * this file is not under any of the guard's SCAN_DIRS
 * (gsd-core/workflows, commands, agents, skills), so nothing here is ever
 * scanned by the guard under test, but the concatenation habit is kept
 * anyway as the sanctioned way to avoid an incidental self-match noted in
 * the dispatch brief, rather than a file allowlist (40-design.md's
 * Rejected #5 forbids allowlists for exactly this shape of problem).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');
const fs = require('node:fs');
const path = require('node:path');

const drift = require('../scripts/lint-unreachable-guard-drift.cjs');
const {
  findUnreachableGuardDrift,
  detectGlobOperand,
  scanRepo,
  loadBaseline,
  diffAgainstBaseline,
  dedupeViolationsForBaseline,
  writeBaseline,
  toPosixRel,
  CAT_LS_COMMAND_RE,
  HEREDOC_AFTER_COMMAND_RE,
  isNoopFallback,
  scanClauseAfterCommand,
  MARKER_RE,
  ISSUE_REF_RE,
  BASELINE_REL_PATH,
  REASON,
} = drift;
const { createTempDir, cleanup } = require('./helpers.cjs');
const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { sanitizeForReport } = require('../scripts/lib/drift-scan.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const DRIFT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'lint-unreachable-guard-drift.cjs');
const FAKE_FILE = 'gsd-core/workflows/fake.md';

// Build a fenced-shell "gsd_run … --pick … || echo …" style line without
// ever writing the literal pipe-pipe/echo shape as adjacent source tokens in
// THIS file. `parts.join('')` concatenates at runtime.
function pickEchoLine({ pick = 'summaries_total', stderr = true, fallback = '"0"' } = {}) {
  const parts = [
    'X=$(gsd_run query phases.list --pick ', pick,
    stderr ? ' 2>/dev/null' : '',
    ' ', '|', '|', ' echo ', fallback, ')',
  ];
  return parts.join('');
}

function catLine(operand, { cmd = 'cat', prefix = '', suffix = '' } = {}) {
  return `${prefix}${cmd} ${operand}${suffix}`;
}

function markerComment(reason) {
  return `# gsd-scan-ignore: ${reason}`;
}

// ─── Detector A — RETIRED, #3884 ───────────────────────────────────────────
//
// ADR-3473 §8.4 made `--pick` exit non-zero on an absent field (issue
// #3884), which made Detector A's own premise false — the `|| echo D` arm it
// forbade is now the CORRECT idiom, not an unreachable one. Detector A (its
// regexes, its branch in the scan, and its `kind: 'A'` finding shape) was
// removed from scripts/lint-unreachable-guard-drift.cjs; this describe block
// now pins the negative claim instead of the old positive one — the exact
// shapes that used to be flagged (canonical, no-stderr-redirect,
// empty-string-fallback, fenced, duplicated, CRLF) must produce ZERO
// violations, proving the retirement did not leave a partial/half-removed
// detector behind.

describe('Detector A (--pick + || echo) — retired, #3884', () => {
  test('detectorAShapeIsNoLongerAFinding: the canonical shape, with/without a stderr redirect, and an empty-string fallback are all unreported', () => {
    for (const opts of [{ stderr: true, fallback: '"d"' }, { stderr: false, fallback: '"d"' }, { fallback: '""' }]) {
      const line = pickEchoLine(opts);
      const { violations } = findUnreachableGuardDrift(line, FAKE_FILE);
      assert.deepStrictEqual(violations, [], `expected no violations for ${JSON.stringify(opts)}`);
    }
  });

  test('detectorAShapeIsNoLongerAFinding: fenced, duplicated, and CRLF variants of the shape are also unreported', () => {
    const line = pickEchoLine();
    const fenced = ['```bash', line, '```'].join('\n');
    const duplicated = [line, line].join('\n');
    const crlf = `${line}\r\n`;
    assert.deepStrictEqual(findUnreachableGuardDrift(fenced, FAKE_FILE).violations, []);
    assert.deepStrictEqual(findUnreachableGuardDrift(duplicated, FAKE_FILE).violations, []);
    assert.deepStrictEqual(findUnreachableGuardDrift(crlf, FAKE_FILE).violations, []);
  });

  test('detectorAShapeIsNoLongerAFinding: no other --pick + || echo variant (git/grep/config-get/ternary/cross-line/printf fallback) is reported either', () => {
    const variants = [
      ['X=$(gsd_run query config-get k 2>/dev/null ', '|', '|', ' echo "false")'].join(''),
      'X=$(gsd_run query phases.list --pick summaries_total)',
      ['X=$(git rev-list --count HEAD ', '|', '|', ' echo 0)'].join(''),
      ["Y=$(grep -cE '^' file.md ", '|', '|', ' echo "0")'].join(''),
      ['$([ -n "$X" ] && echo "a" ', '|', '|', ' echo "")'].join(''),
      ["X=$(gsd_run query phases.list --pick f ", '|', '|', " printf 'd')"].join(''),
    ];
    for (const line of variants) {
      const { violations } = findUnreachableGuardDrift(line, FAKE_FILE);
      assert.deepStrictEqual(violations, [], `expected no violations for ${JSON.stringify(line)}`);
    }
    const crossLine = [
      'X=$(gsd_run query phases.list --pick summaries_total 2>/dev/null)',
      ['Y=$(echo "$X" ', '|', '|', ' echo "0")'].join(''),
    ].join('\n');
    assert.deepStrictEqual(findUnreachableGuardDrift(crossLine, FAKE_FILE).violations, []);
  });
});

// ─── Detector B — B-i cat <glob> / B-ii ls <glob> … || <real fallback> /
// B-iii ls <glob> at the head of if/elif/while ─────────────────────────────
//
// Scope, per the coordinator's measured correction: `ls <glob>` fires ONLY
// when its exit code feeds either a genuine `||` fallback (not the no-op
// `true`/`:`) or gates an `if`/`elif`/`while` test — never when its STDOUT
// is what's consumed (piped, captured via `$(...)`), and never on the
// `|| true`/`|| :` defensive-suppression idiom, which carries no fallback
// value for nullglob's success-on-empty to defeat.

describe('Detector B — cat <glob> (B-i), ls <glob> || <real fallback> (B-ii), ls <glob> at if/elif/while (B-iii)', () => {
  test('B1: detects a bare cat over an unmatched-capable glob (B-i, unconditional)', () => {
    const line = catLine('.planning/phases/*-*/*-SUMMARY.md');
    const { violations } = findUnreachableGuardDrift(line, FAKE_FILE);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].kind, 'B');
    assert.strictEqual(violations[0].found, 'cat');
  });

  test('B2: detects ls at the head of an if test (B-iii — still FIRES, exit code gates control flow)', () => {
    const line = 'if ls "${DIR}/"*-CONTEXT.md; then true; fi';
    const { violations } = findUnreachableGuardDrift(line, FAKE_FILE);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].found, 'ls');
  });

  test('B3: a stderr redirect does not cure the cat stdin hazard (B-i)', () => {
    const line = catLine('dir/*.md', { suffix: ' 2>/dev/null' });
    const { violations } = findUnreachableGuardDrift(line, FAKE_FILE);
    assert.strictEqual(violations.length, 1);
  });

  test('B4: an array expansion is NOT detected (it is the remedy)', () => {
    const line = catLine('"${_CTX[@]}"');
    const { violations } = findUnreachableGuardDrift(line, FAKE_FILE);
    assert.deepStrictEqual(violations, []);
  });

  test('B5: a for-list glob is NOT detected', () => {
    const line = 'for f in dir/*.md; do echo "$f"; done';
    const { violations } = findUnreachableGuardDrift(line, FAKE_FILE);
    assert.deepStrictEqual(violations, []);
  });

  test('B6: a literal operand is NOT detected', () => {
    const a = findUnreachableGuardDrift(catLine('"$FILE"'), FAKE_FILE);
    const b = findUnreachableGuardDrift(catLine('f1 f2'), FAKE_FILE);
    assert.deepStrictEqual(a.violations, []);
    assert.deepStrictEqual(b.violations, []);
  });

  test('B7: ls with no operand is NOT detected', () => {
    const { violations } = findUnreachableGuardDrift('ls', FAKE_FILE);
    assert.deepStrictEqual(violations, []);
  });

  test('B8: a heredoc is NOT detected', () => {
    const line = "cat <<'EOF'";
    const { violations } = findUnreachableGuardDrift(line, FAKE_FILE);
    assert.deepStrictEqual(violations, []);
  });

  test('B9: a counting ls whose STDOUT is piped onward is NOT detected (informational, out of scope)', () => {
    // Corrected semantics: `ls`'s exit code is not what's being consumed
    // here — its STDOUT is piped to `wc -l`. This is the class of ~97
    // measured "informational ls" sites the issue explicitly leaves alone
    // (it is neither the stdin-hang hazard nor a defeated fallback nor an
    // always-true guard); overlap with lint-planning-prompt-drift on the
    // COUNTING shape is that guard's concern, not this one's.
    const line = 'ls -1 dir/*-PLAN.md | wc -l';
    const { violations } = findUnreachableGuardDrift(line, FAKE_FILE);
    assert.deepStrictEqual(violations, []);
  });

  test('B10: the word cat in prose (not command position) is NOT detected', () => {
    const line = 'The output looks like a cat chasing dir/*.md files around.';
    const { violations } = findUnreachableGuardDrift(line, FAKE_FILE);
    assert.deepStrictEqual(violations, []);
  });

  test('B-ii positive: ls <glob> || echo "<default>" fires — a real fallback nullglob silently defeats', () => {
    // Real site shape (commands/gsd/review-backlog.md, pre-fix): under
    // nullglob an unmatched glob makes `ls` list the CWD and succeed, so
    // the intended "no backlog items" message never prints — exactly
    // Detector A's shape one level down, with `ls`'s own exit code standing
    // in for `--pick`'s coerced-to-'' absence.
    const line = 'ls -d .planning/phases/999* 2>/dev/null || echo "No backlog items found"';
    const { violations } = findUnreachableGuardDrift(line, FAKE_FILE);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].kind, 'B');
    assert.strictEqual(violations[0].found, 'ls');
  });

  test('ls <glob> ... || true does NOT fire — suppressing a failure is not a guard', () => {
    // No fallback VALUE exists here for nullglob's success-on-empty to
    // defeat — `true` runs unconditionally either way. Measured: ~15 sites
    // in this tree, all this exact defensive idiom (`set -e` failure
    // suppression), none of them the #3300/#3409 hazard shape.
    const line = 'ls -d .planning/milestones/v*-phases 2>/dev/null || true';
    const { violations } = findUnreachableGuardDrift(line, FAKE_FILE);
    assert.deepStrictEqual(violations, []);
  });

  test('ls <glob> ... || : does NOT fire — the : no-op is the same idiom as || true', () => {
    const line = 'ls -d .planning/phases/*/ 2>/dev/null || :';
    const { violations } = findUnreachableGuardDrift(line, FAKE_FILE);
    assert.deepStrictEqual(violations, []);
  });

  test('an informational ls whose stdout is captured via $(...) does NOT fire (out of scope)', () => {
    // Real site shape (commands/gsd/quick.md, and many like it): the exit
    // code is never consulted at all — only the captured stdout is used —
    // so this is neither the stdin-hang hazard nor a defeated fallback nor
    // an always-true guard. Measured: 97 such sites, explicitly out of
    // this issue's scope.
    const line = 'dir=$(ls -d .planning/quick/*-{SLUG}/ 2>/dev/null | head -1)';
    const { violations } = findUnreachableGuardDrift(line, FAKE_FILE);
    assert.deepStrictEqual(violations, []);
  });

  test('the Bash(cat << \'EOF\') prose line does NOT fire — a heredoc operator is never a glob operand', () => {
    // Real site shape (agents/gsd-executor.md and six siblings): the
    // surrounding markdown **bold** carries literal `*` characters
    // elsewhere on the line, and `(` (from `Bash(`) is a valid command-
    // position anchor for `$(cat ...)` — but the heredoc guard
    // (HEREDOC_AFTER_COMMAND_RE) refuses to treat anything immediately
    // after `cat` as an operand at all once it sees `<<`, so this never
    // reaches the glob check regardless of what markdown emphasis follows.
    const line = "3. **Do NOT use `Bash(cat << 'EOF')` or heredoc** for file creation. Use the `Write` tool.";
    const { violations } = findUnreachableGuardDrift(line, FAKE_FILE);
    assert.deepStrictEqual(violations, []);
  });

  test('detectGlobOperand: pure predicate returns null on no command match', () => {
    assert.strictEqual(detectGlobOperand('echo dir/*.md'), null);
  });

  test('detectGlobOperand: pure predicate returns the command name on a cat match (B-i)', () => {
    assert.deepStrictEqual(detectGlobOperand(catLine('dir/*.md')), { command: 'cat' });
  });

  test('detectGlobOperand: returns null for an ls glob with no exit-code-consuming shape', () => {
    assert.strictEqual(detectGlobOperand('ls dir/*.md 2>/dev/null'), null);
  });

  test('detectGlobOperand: returns the command name for an ls glob with a real || fallback (B-ii)', () => {
    assert.deepStrictEqual(detectGlobOperand('ls dir/*.md || echo missing'), { command: 'ls' });
  });

  test('isNoopFallback recognizes true and : as no-ops and anything else as real', () => {
    assert.strictEqual(isNoopFallback(' true'), true);
    assert.strictEqual(isNoopFallback(' true) | sort'), true);
    assert.strictEqual(isNoopFallback(' :'), true);
    assert.strictEqual(isNoopFallback(' echo "message"'), false);
    assert.strictEqual(isNoopFallback(''), true);
  });

  test('scanClauseAfterCommand finds the glob and the correct terminator across chain shapes', () => {
    assert.deepStrictEqual(scanClauseAfterCommand(' dir/*.md | wc -l'), { hasGlob: true, terminator: '|', fallback: null });
    assert.deepStrictEqual(scanClauseAfterCommand(' dir/*.md && next'), { hasGlob: true, terminator: '&&', fallback: null });
    const orResult = scanClauseAfterCommand(' dir/*.md || echo x');
    assert.strictEqual(orResult.hasGlob, true);
    assert.strictEqual(orResult.terminator, '||');
    assert.strictEqual(orResult.fallback, ' echo x');
  });
});

// ─── Escape marker ─────────────────────────────────────────────────────────

describe('Escape marker — # gsd-scan-ignore:', () => {
  test('M1: a marker naming an issue exempts the line', () => {
    const line = `${catLine('dir/*.md')}   ${markerComment('#3409')}`;
    const { violations, malformed } = findUnreachableGuardDrift(line, FAKE_FILE);
    assert.deepStrictEqual(violations, []);
    assert.deepStrictEqual(malformed, []);
  });

  test('M2: a marker naming a URL exempts the line', () => {
    const line = `${catLine('dir/*.md')}   ${markerComment('https://example.com/issue/1')}`;
    const { violations, malformed } = findUnreachableGuardDrift(line, FAKE_FILE);
    assert.deepStrictEqual(violations, []);
    assert.deepStrictEqual(malformed, []);
  });

  test('M3: a free-text reason reports a malformed declaration, not a plain violation', () => {
    const line = `${catLine('dir/*.md')}   ${markerComment('because I said so')}`;
    const { violations, malformed } = findUnreachableGuardDrift(line, FAKE_FILE);
    assert.deepStrictEqual(violations, []);
    assert.strictEqual(malformed.length, 1);
    assert.strictEqual(malformed[0].reason, 'because I said so');
  });

  test('M4: an empty reason is not an audit trail — malformed', () => {
    const line = `${catLine('dir/*.md')}   # gsd-scan-ignore:`;
    const { violations, malformed } = findUnreachableGuardDrift(line, FAKE_FILE);
    assert.deepStrictEqual(violations, []);
    assert.strictEqual(malformed.length, 1);
    assert.strictEqual(malformed[0].reason, '');
  });

  test('M5: a whitespace-only reason is rejected — malformed', () => {
    const line = `${catLine('dir/*.md')}   # gsd-scan-ignore:    `;
    const { violations, malformed } = findUnreachableGuardDrift(line, FAKE_FILE);
    assert.deepStrictEqual(violations, []);
    assert.strictEqual(malformed.length, 1);
  });

  test('M6: the marker binds only to its own line — a marker above a violation does not exempt it', () => {
    const text = [markerComment('#3409'), catLine('dir/*.md')].join('\n');
    const { violations, malformed } = findUnreachableGuardDrift(text, FAKE_FILE);
    assert.strictEqual(violations.length, 1, 'the violation on line 2 must still fire');
    assert.deepStrictEqual(malformed, []);
  });

  test('a well-formed marker on a non-violating line produces neither a violation nor a malformed entry', () => {
    const { violations, malformed } = findUnreachableGuardDrift(markerComment('#100'), FAKE_FILE);
    assert.deepStrictEqual(violations, []);
    assert.deepStrictEqual(malformed, []);
  });

  test('ISSUE_REF_RE accepts a bare #NNN and an http(s) URL, rejects free text', () => {
    assert.ok(ISSUE_REF_RE.test('#3409'));
    assert.ok(ISSUE_REF_RE.test('https://example.com/x'));
    assert.ok(ISSUE_REF_RE.test('http://example.com/x'));
    assert.ok(!ISSUE_REF_RE.test('no issue here'));
  });

  // Tightened predicate (deliberate divergence from
  // tests/commit-files-pathspec.test.cjs's own looser ISSUE_REF_RE — see this
  // module's ISSUE_REF_RE comment): `#0` and a bare scheme-only URL both
  // satisfied the copied form's FORMAT-only check without naming anything
  // real. Regex-level checks first (mirrors the existing convention just
  // above), then the same two shapes driven through the CLI so the outcome
  // is pinned on the structured REASON.* code, never on rendered text.
  test('ISSUE_REF_RE rejects #0 (not a positive integer) and a bare http:// with no host', () => {
    assert.ok(!ISSUE_REF_RE.test('#0'));
    assert.ok(ISSUE_REF_RE.test('#123'));
    assert.ok(!ISSUE_REF_RE.test('http://'));
    assert.ok(!ISSUE_REF_RE.test('https://'));
    assert.ok(ISSUE_REF_RE.test('https://example.com/x'));
  });

  function runIsolatedMarkerCase(t, reason) {
    const root = createTempDir('gsd-3409-issueref-');
    t.after(() => cleanup(root));
    const isolatedScript = buildIsolatedGuard(root);
    const wfDir = path.join(root, 'gsd-core', 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, 'fake.md'), `${catLine('dir/*.md')}   ${markerComment(reason)}\n`);
    const baselinePath = path.join(root, BASELINE_REL_PATH);
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify({ entries: [] }), 'utf8');
    const jsonResult = runNode([isolatedScript, '--json'], { timeoutMs: PROBE_TIMEOUT_MS });
    return JSON.parse(jsonResult.stdout);
  }

  test('#0 as a marker reason is rejected — reported as malformed, not exempted', (t) => {
    const report = runIsolatedMarkerCase(t, '#0');
    assert.strictEqual(report.reason, REASON.FAIL_MALFORMED_MARKER);
    assert.strictEqual(report.malformed.length, 1);
  });

  test('#123 as a marker reason is accepted — the line is exempted', (t) => {
    const report = runIsolatedMarkerCase(t, '#123');
    assert.strictEqual(report.reason, REASON.OK_NO_VIOLATIONS);
  });

  test('a bare http:// as a marker reason is rejected — reported as malformed, not exempted', (t) => {
    const report = runIsolatedMarkerCase(t, 'http://');
    assert.strictEqual(report.reason, REASON.FAIL_MALFORMED_MARKER);
    assert.strictEqual(report.malformed.length, 1);
  });

  test('https://example.com/x as a marker reason is accepted — the line is exempted', (t) => {
    const report = runIsolatedMarkerCase(t, 'https://example.com/x');
    assert.strictEqual(report.reason, REASON.OK_NO_VIOLATIONS);
  });
});

// ─── Ratchet baseline — diffAgainstBaseline ───────────────────────────────

describe('diffAgainstBaseline — ratchet invariants', () => {
  test('R1: an acknowledged pair at its exact count passes (neither fresh nor stale)', () => {
    const baseline = [{ file: 'a.md', text: 'X', count: 1 }];
    const violations = [{ file: 'a.md', line: 1, kind: 'A', found: '--pick', text: 'X' }];
    const { fresh, stale } = diffAgainstBaseline(violations, baseline);
    assert.deepStrictEqual(fresh, []);
    assert.deepStrictEqual(stale, []);
  });

  test('R2: a partial migration (count:2, actual 1) reports stale', () => {
    const baseline = [{ file: 'a.md', text: 'X', count: 2 }];
    const violations = [{ file: 'a.md', line: 1, kind: 'A', found: '--pick', text: 'X' }];
    const { fresh, stale } = diffAgainstBaseline(violations, baseline);
    assert.deepStrictEqual(fresh, []);
    assert.strictEqual(stale.length, 1);
    assert.strictEqual(stale[0].count, 2);
    assert.strictEqual(stale[0].actualCount, 1);
  });

  test('R3: the exact acknowledged count (count:2, actual 2) passes', () => {
    const baseline = [{ file: 'a.md', text: 'X', count: 2 }];
    const violations = [
      { file: 'a.md', line: 1, kind: 'A', found: '--pick', text: 'X' },
      { file: 'a.md', line: 9, kind: 'A', found: '--pick', text: 'X' },
    ];
    const { fresh, stale } = diffAgainstBaseline(violations, baseline);
    assert.deepStrictEqual(fresh, []);
    assert.deepStrictEqual(stale, []);
  });

  test('R4: an unacknowledged extra copy (count:2, actual 3) reports one fresh', () => {
    const baseline = [{ file: 'a.md', text: 'X', count: 2 }];
    const violations = [
      { file: 'a.md', line: 1, kind: 'A', found: '--pick', text: 'X' },
      { file: 'a.md', line: 9, kind: 'A', found: '--pick', text: 'X' },
      { file: 'a.md', line: 20, kind: 'A', found: '--pick', text: 'X' },
    ];
    const { fresh, stale } = diffAgainstBaseline(violations, baseline);
    assert.deepStrictEqual(stale, []);
    assert.strictEqual(fresh.length, 1);
    assert.strictEqual(fresh[0].line, 20);
  });

  test('R5: a fully migrated pair (actual 0) reports stale', () => {
    const baseline = [{ file: 'a.md', text: 'X', count: 2 }];
    const { fresh, stale } = diffAgainstBaseline([], baseline);
    assert.deepStrictEqual(fresh, []);
    assert.strictEqual(stale.length, 1);
    assert.strictEqual(stale[0].actualCount, 0);
  });

  test('R6: an unrecorded pair reports fresh', () => {
    const violations = [{ file: 'a.md', line: 1, kind: 'B', found: 'cat', text: 'Y' }];
    const { fresh, stale } = diffAgainstBaseline(violations, []);
    assert.strictEqual(fresh.length, 1);
    assert.deepStrictEqual(stale, []);
  });

  test('R7: an entry with no count defaults to acknowledging one occurrence', () => {
    const baseline = [{ file: 'a.md', text: 'X' }];
    const violations = [
      { file: 'a.md', line: 1, kind: 'A', found: '--pick', text: 'X' },
      { file: 'a.md', line: 9, kind: 'A', found: '--pick', text: 'X' },
    ];
    const { fresh, stale } = diffAgainstBaseline(violations, baseline);
    assert.deepStrictEqual(stale, []);
    assert.strictEqual(fresh.length, 1);
    assert.strictEqual(fresh[0].line, 9);
  });

  test('R8: the key includes the file path — same text, different file is fresh', () => {
    const baseline = [{ file: 'a.md', text: 'X', count: 1 }];
    const violations = [{ file: 'b.md', line: 1, kind: 'A', found: '--pick', text: 'X' }];
    const { fresh, stale } = diffAgainstBaseline(violations, baseline);
    assert.strictEqual(fresh.length, 1);
    assert.strictEqual(stale.length, 1, 'the a.md entry now has zero actual occurrences and is stale');
  });

  test('R9: line-number churn does not disturb the baseline (keyed on text, not line)', () => {
    const baseline = [{ file: 'a.md', text: 'X', count: 1 }];
    const violations = [{ file: 'a.md', line: 999, kind: 'A', found: '--pick', text: 'X' }];
    const { fresh, stale } = diffAgainstBaseline(violations, baseline);
    assert.deepStrictEqual(fresh, []);
    assert.deepStrictEqual(stale, []);
  });
});

// ─── Baseline loading — malformed input ───────────────────────────────────

describe('loadBaseline — malformed input', () => {
  function writeBaselineFile(root, content) {
    const p = path.join(root, BASELINE_REL_PATH);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }

  test('L1: a missing baseline errors with its own remedy', (t) => {
    const root = createTempDir('gsd-3409-baseline-');
    t.after(() => cleanup(root));
    const { entries, errors } = loadBaseline(root);
    assert.deepStrictEqual(entries, []);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].reason, REASON.FAIL_BASELINE_MISSING);
  });

  test('L2: an empty baseline errors', (t) => {
    const root = createTempDir('gsd-3409-baseline-');
    t.after(() => cleanup(root));
    writeBaselineFile(root, '   \n');
    const { errors } = loadBaseline(root);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].reason, REASON.FAIL_BASELINE_EMPTY);
  });

  test('L3: invalid JSON errors, naming the parse failure', (t) => {
    const root = createTempDir('gsd-3409-baseline-');
    t.after(() => cleanup(root));
    writeBaselineFile(root, '{ not json');
    const { errors } = loadBaseline(root);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].reason, REASON.FAIL_BASELINE_INVALID_JSON);
    assert.strictEqual(typeof errors[0].parseError, 'string');
  });

  test('L4: non-object JSON scalars each error, naming the actual type', (t) => {
    const root = createTempDir('gsd-3409-baseline-');
    t.after(() => cleanup(root));
    for (const [literal, expectedType] of [['0', 'number'], ['"str"', 'string'], ['[]', 'array'], ['null', 'object'], ['true', 'boolean']]) {
      writeBaselineFile(root, literal);
      const { errors } = loadBaseline(root);
      assert.strictEqual(errors.length, 1, `literal=${literal}`);
      assert.strictEqual(errors[0].reason, REASON.FAIL_BASELINE_NOT_OBJECT, `literal=${literal}`);
      assert.strictEqual(errors[0].gotType, expectedType, `literal=${literal}`);
    }
  });

  test('L5: a non-array entries field errors', (t) => {
    const root = createTempDir('gsd-3409-baseline-');
    t.after(() => cleanup(root));
    writeBaselineFile(root, JSON.stringify({ entries: 'nope' }));
    const { errors } = loadBaseline(root);
    assert.strictEqual(errors.length, 1);
    assert.strictEqual(errors[0].reason, REASON.FAIL_BASELINE_ENTRIES_NOT_ARRAY);
  });

  test('L6: count must be a positive integer — 0, -1, 1.5, "2" each error', (t) => {
    const root = createTempDir('gsd-3409-baseline-');
    t.after(() => cleanup(root));
    for (const badCount of [0, -1, 1.5, '2']) {
      writeBaselineFile(root, JSON.stringify({ entries: [{ file: 'a.md', text: 'X', count: badCount }] }));
      const { entries, errors } = loadBaseline(root);
      assert.strictEqual(entries.length, 0, `count=${JSON.stringify(badCount)}`);
      assert.strictEqual(errors.length, 1, `count=${JSON.stringify(badCount)}`);
      assert.strictEqual(errors[0].reason, REASON.FAIL_BASELINE_ENTRY_COUNT_INVALID, `count=${JSON.stringify(badCount)}`);
    }
  });

  test('L7: empty key fields (file or text) error', (t) => {
    const root = createTempDir('gsd-3409-baseline-');
    t.after(() => cleanup(root));
    writeBaselineFile(root, JSON.stringify({ entries: [{ file: '', text: 'X' }] }));
    let result = loadBaseline(root);
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0].reason, REASON.FAIL_BASELINE_ENTRY_FIELD_INVALID);
    assert.strictEqual(result.errors[0].field, 'file');

    writeBaselineFile(root, JSON.stringify({ entries: [{ file: 'a.md', text: '' }] }));
    result = loadBaseline(root);
    assert.strictEqual(result.errors.length, 1);
    assert.strictEqual(result.errors[0].reason, REASON.FAIL_BASELINE_ENTRY_FIELD_INVALID);
    assert.strictEqual(result.errors[0].field, 'text');
  });

  test('a valid baseline with a count field loads cleanly', (t) => {
    const root = createTempDir('gsd-3409-baseline-');
    t.after(() => cleanup(root));
    writeBaselineFile(root, JSON.stringify({ entries: [{ file: 'a.md', text: 'X', count: 3 }] }));
    const { entries, errors } = loadBaseline(root);
    assert.deepStrictEqual(errors, []);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].count, 3);
  });
});

// ─── Cross-platform & encoding ─────────────────────────────────────────────

describe('Cross-platform & encoding', () => {
  test('P1: a backslash relpath normalizes to POSIX in the key', () => {
    const winRel = 'gsd-core\\workflows\\fake.md';
    const posixRel = 'gsd-core/workflows/fake.md';
    assert.strictEqual(toPosixRel(winRel), posixRel);
    assert.strictEqual(toPosixRel(posixRel), posixRel);
    const { violations } = findUnreachableGuardDrift(catLine('dir/*.md'), winRel);
    assert.strictEqual(violations[0].file, posixRel);
    assert.ok(!violations[0].file.includes('\\'));
  });

  // P2 (formerly "CRLF input yields the same violations as LF (Detector A)")
  // was retired alongside Detector A itself, #3884 — its claim is now fully
  // subsumed by P3 below, the only detector left whose CRLF parity matters.

  test('P3: CRLF does not defeat the glob detector (Detector B)', () => {
    const line = catLine('dir/*.md');
    const lf = findUnreachableGuardDrift(line, FAKE_FILE).violations;
    const crlf = findUnreachableGuardDrift(`${line}\r\n`, FAKE_FILE).violations;
    assert.strictEqual(lf.length, 1);
    assert.strictEqual(crlf.length, 1);
    assert.strictEqual(lf[0].text, crlf[0].text);
  });

  test('P4: the baseline key is CR-free under CRLF — matches an LF-recorded baseline entry', () => {
    const line = catLine('dir/*.md');
    const baseline = [{ file: FAKE_FILE, text: line.trim(), count: 1 }];
    const crlfViolations = findUnreachableGuardDrift(`${line}\r\n`, FAKE_FILE).violations;
    assert.ok(!crlfViolations[0].text.includes('\r'), 'the baseline-key text must carry no trailing \\r');
    const { fresh, stale } = diffAgainstBaseline(crlfViolations, baseline);
    assert.deepStrictEqual(fresh, []);
    assert.deepStrictEqual(stale, []);
  });
});

// ─── Hostile input ─────────────────────────────────────────────────────────

describe('Hostile input', () => {
  test('X1: sanitizeForReport (the human console formatter\'s own typed IR) strips a raw ESC byte to a visible \\xNN escape', () => {
    // sanitizeForReport (scripts/lib/drift-scan.cjs) is the structured surface
    // the human formatter consumes before writing to stderr — asserted on its
    // own return value directly, never on the CLI's rendered stderr text.
    const esc = String.fromCharCode(0x1b);
    const sanitized = sanitizeForReport(`${esc}[31mred${esc}[0m`);
    assert.ok(!sanitized.includes(esc), 'sanitizeForReport must strip the raw ESC byte');
    assert.match(sanitized, /\\x1b/);
  });

  test('X1b: a fresh violation carrying a hostile ANSI/control byte does not crash the CLI and classifies correctly', (t) => {
    const root = createTempDir('gsd-3409-hostile-');
    t.after(() => cleanup(root));
    const isolatedScript = buildIsolatedGuard(root);
    const wfDir = path.join(root, 'gsd-core', 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    const esc = String.fromCharCode(0x1b);
    const line = catLine('dir/*.md') + `  # ${esc}[31mred${esc}[0m`;
    fs.writeFileSync(path.join(wfDir, 'fake.md'), `${line}\n`);
    writeBaselineFakeEmpty(root);

    // Human-mode run: only the structural facts (process outcome, exit code)
    // are asserted — the rendered stderr content is never inspected.
    const humanResult = runNode([isolatedScript], { timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(humanResult.outcome, 'exited');
    assert.strictEqual(humanResult.exitCode, 1);

    // --json run: the structured report is the typed IR under test. Strict
    // JSON forbids a literal unescaped C0 control byte inside a string, so
    // `JSON.parse` succeeding is itself proof no raw ESC byte reached the
    // stdout stream unescaped.
    const jsonResult = runNode([isolatedScript, '--json'], { timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(jsonResult.exitCode, 1);
    const report = JSON.parse(jsonResult.stdout);
    assert.strictEqual(report.reason, REASON.FAIL_FRESH_VIOLATION);
    assert.strictEqual(report.violations.length, 1);
  });

  test('X2: a very long line does not hang the scanner', () => {
    const start = Date.now();
    const longOperand = 'a'.repeat(100 * 1024) + '*.md';
    const line = catLine(longOperand);
    const { violations } = findUnreachableGuardDrift(line, FAKE_FILE);
    assert.strictEqual(violations.length, 1);
    assert.ok(Date.now() - start < 2000, 'a 100KB line must scan in well under 2s');
  });

  test('X3: null bytes do not crash the scanner', () => {
    const line = catLine('dir/*.md\0trailing');
    assert.doesNotThrow(() => findUnreachableGuardDrift(line, FAKE_FILE));
    const { violations } = findUnreachableGuardDrift(line, FAKE_FILE);
    assert.strictEqual(violations.length, 1);
  });

  test('X4a: sanitizeForReport strips a raw RTL-override codepoint to a visible \\uNNNN escape', () => {
    const rlo = '‮';
    const sanitized = sanitizeForReport(`dir/*.md${rlo}gnp.evil`);
    assert.ok(!sanitized.includes(rlo), 'sanitizeForReport must strip the raw RLO codepoint');
    assert.match(sanitized, /\\u202e/);
  });

  test('X4b: unicode / RTL-override in the violating text is handled without crashing and classifies correctly', (t) => {
    const root = createTempDir('gsd-3409-hostile-');
    t.after(() => cleanup(root));
    const isolatedScript = buildIsolatedGuard(root);
    const wfDir = path.join(root, 'gsd-core', 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    const rlo = '‮';
    const line = catLine(`dir/*.md${rlo}gnp.evil`);
    fs.writeFileSync(path.join(wfDir, 'fake.md'), `${line}\n`);
    writeBaselineFakeEmpty(root);

    const humanResult = runNode([isolatedScript], { timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(humanResult.outcome, 'exited');
    assert.strictEqual(humanResult.exitCode, 1);

    const jsonResult = runNode([isolatedScript, '--json'], { timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(jsonResult.exitCode, 1);
    const report = JSON.parse(jsonResult.stdout);
    assert.strictEqual(report.reason, REASON.FAIL_FRESH_VIOLATION);
    assert.strictEqual(report.violations.length, 1);
  });

  test('X5: the walk stays inside the root — a symlink escaping the scan tree is not followed', (t) => {
    if (process.platform === 'win32') { t.skip('symlink creation requires elevated privileges on Windows CI'); return; }
    const root = createTempDir('gsd-3409-symlink-');
    t.after(() => cleanup(root));
    const outside = createTempDir('gsd-3409-outside-');
    t.after(() => cleanup(outside));
    fs.mkdirSync(path.join(outside, 'secret'), { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret', 'leak.md'), catLine('dir/*.md') + '\n');

    const wfDir = path.join(root, 'gsd-core', 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    try {
      fs.symlinkSync(path.join(outside, 'secret'), path.join(wfDir, 'escape'), 'dir');
    } catch {
      t.skip('symlink creation not permitted in this environment');
      return;
    }

    const { violations } = scanRepo(root);
    assert.deepStrictEqual(violations, [], 'a directory symlink pointing outside the scan-dir root must not be followed');
  });

  function writeBaselineFakeEmpty(root) {
    const p = path.join(root, BASELINE_REL_PATH);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ entries: [] }), 'utf8');
  }
});

// ─── Property tests (fast-check, pinned seed, bounded runs) ──────────────

describe('Property tests', () => {
  // DOCUMENT-SHAPED, not writer-seeded (CONTRIBUTING.md's Fixture provenance
  // #2371): tokens are drawn from a shell-ish alphabet independent of
  // CAT_LS_COMMAND_RE's own literals, not generated from the detector's
  // regex source.
  const wordArb = fc.constantFrom(
    'gsd_run', 'query', 'phases.list', 'config-get', 'k', 'v', 'f', '2>/dev/null',
    'echo', 'printf', '"0"', '"d"', '$(', ')', 'X=', '&&', ';', 'if', 'then', 'fi',
    'cat', 'ls', 'dir/*.md', '"$FILE"', '--type', 'summaries', '--pick', 'count',
  );
  const lineArb = fc.array(wordArb, { minLength: 1, maxLength: 12 }).map((ws) => ws.join(' '));

  // Retired-detector regression net (#3884): unlike the pre-retirement F1,
  // this deliberately does NOT filter out the `--pick` + `|| echo` combined
  // shape — it fuzzes lines that DO carry both tokens (via injectPipe) and
  // asserts a `kind: 'A'` violation is unconditionally impossible now that
  // Detector A no longer exists, closing off the possibility of a partial
  // removal (e.g. a stray branch reachable only through some input shape
  // this suite's hand-written fixtures do not happen to hit).
  test('F1: no document-shaped line — including one deliberately carrying both --pick and || echo — ever produces a kind:\'A\' violation', () => {
    fc.assert(
      fc.property(lineArb, fc.boolean(), (line, injectPipe) => {
        const rawFallback = injectPipe ? `${line} ${'|'}${'|'} echo done` : line;
        const { violations } = findUnreachableGuardDrift(rawFallback, FAKE_FILE);
        const aViolations = violations.filter((v) => v.kind === 'A');
        assert.deepStrictEqual(aViolations, []);
      }),
      { numRuns: 200, seed: 3409 },
    );
  });

  // Baseline/violation record generators, independent of any production
  // dedupe/diff code path.
  const fileArb = fc.constantFrom('a.md', 'b.md', 'c.md');
  const textArb = fc.constantFrom('LINE_ONE', 'LINE_TWO', 'LINE_THREE');
  const countArb = fc.integer({ min: 1, max: 4 });
  const baselineEntryArb = fc.record({ file: fileArb, text: textArb, count: countArb });
  const baselineArb = fc.uniqueArray(baselineEntryArb, {
    maxLength: 5,
    selector: (e) => `${e.file} ${e.text}`,
  });
  const violationArb = fc.record({
    file: fileArb,
    text: textArb,
    line: fc.integer({ min: 1, max: 500 }),
    kind: fc.constantFrom('A', 'B'),
    found: fc.constantFrom('--pick', 'cat', 'ls'),
  });
  const violationsArb = fc.array(violationArb, { maxLength: 10 });

  test('F2: diffAgainstBaseline is a partition — no violation is both fresh and stale, and an exact-count pair is neither', () => {
    fc.assert(
      fc.property(violationsArb, baselineArb, (violations, baseline) => {
        const { fresh, stale } = diffAgainstBaseline(violations, baseline);

        // `fresh` items are always drawn from `violations` (they carry
        // `line`/`kind`/`found`) and `stale` items are always drawn from
        // `baseline` entries (they carry `actualCount`) — the two shapes
        // are structurally disjoint, so no single object can satisfy both;
        // asserted directly rather than by reference-equality (which two
        // differently-shaped objects could never satisfy anyway).
        for (const f of fresh) assert.ok('line' in f && 'actualCount' in f === false);
        for (const s of stale) assert.ok('actualCount' in s && 'line' in s === false);

        // Every fresh violation's (file,text) pair is either unknown to the
        // baseline, or known but this is one of the excess occurrences.
        for (const f of fresh) {
          const entry = baseline.find((e) => e.file === f.file && e.text === f.text);
          if (entry) {
            const actualCountForPair = violations.filter((v) => v.file === f.file && v.text === f.text).length;
            assert.ok(actualCountForPair > entry.count, 'a fresh violation from a known pair must exceed its acknowledged count');
          }
        }

        // A baseline entry whose actual count exactly matches its
        // acknowledged count must not appear in stale.
        for (const entry of baseline) {
          const actualCountForPair = violations.filter((v) => v.file === entry.file && v.text === entry.text).length;
          const inStale = stale.some((s) => s.file === entry.file && s.text === entry.text);
          if (actualCountForPair === entry.count) {
            assert.ok(!inStale, 'an exactly-matched baseline entry must not be reported stale');
          } else if (actualCountForPair < entry.count) {
            assert.ok(inStale, 'an under-matched baseline entry must be reported stale');
          }
        }
      }),
      { numRuns: 200, seed: 3410 },
    );
  });
});

// ─── Integration — the real CLI and the real tree ─────────────────────────
//
// `main()` hardcodes its scan root to `path.join(__dirname, '..')` (see the
// sibling `lint-planning-prompt-drift.cjs`'s own E5 test, which writes its
// fixture straight into the real `gsd-core/workflows/` tree for exactly
// this reason) — an invoked CLI's root can never be redirected via `cwd`.
// A `--update` spawn of the REAL script would therefore overwrite the
// repo's own committed baseline, which "No test may mutate the repo's
// committed baseline file" forbids outright. `buildIsolatedGuard` copies
// the script AND its `./lib/drift-scan.cjs` dependency into a throwaway
// root, so the copy's own `__dirname` resolves inside the temp tree and
// every one of its filesystem effects (reads AND `--update`'s write) stay
// fully isolated — this is still the real CLI end-to-end, not a pure-
// function call, just running from a location that makes isolation
// possible.

function buildIsolatedGuard(root) {
  const scriptsDir = path.join(root, 'scripts');
  fs.mkdirSync(path.join(scriptsDir, 'lib'), { recursive: true });
  fs.copyFileSync(DRIFT_SCRIPT, path.join(scriptsDir, 'lint-unreachable-guard-drift.cjs'));
  fs.copyFileSync(
    path.join(REPO_ROOT, 'scripts', 'lib', 'drift-scan.cjs'),
    path.join(scriptsDir, 'lib', 'drift-scan.cjs'),
  );
  return path.join(scriptsDir, 'lint-unreachable-guard-drift.cjs');
}

describe('Integration — CLI end-to-end', () => {
  test('C1a: the guard is green on the real committed tree (real CLI, real baseline, no isolation needed for a read-only run)', () => {
    // A bare (no --update) run only READS the repo — no committed-baseline
    // mutation risk — so this is the one CLI-level test that can safely
    // target the real script directly, and is the matrix's literal claim:
    // "run against the committed repo with the committed baseline -> exit 0".
    const result = runNode([DRIFT_SCRIPT, '--json'], { timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(result.outcome, 'exited');
    assert.strictEqual(result.exitCode, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.strictEqual(report.reason, REASON.OK_NO_VIOLATIONS);
  });

  test('C1b: scanRepo(REPO_ROOT) carries no malformed gsd-scan-ignore declarations', () => {
    const { malformed } = scanRepo(REPO_ROOT);
    assert.deepStrictEqual(malformed, []);
  });

  test('detectorBStillReportsGlobShapes (formerly C2): a reintroduced Detector-B shape still exits non-zero and names the remedy — proves the guard can FAIL, not just pass, after Detector A\'s retirement', (t) => {
    const root = createTempDir('gsd-3409-c2-');
    t.after(() => cleanup(root));
    const isolatedScript = buildIsolatedGuard(root);
    const wfDir = path.join(root, 'gsd-core', 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, 'fake.md'), `${catLine('dir/*.md')}\n`);
    const baselinePath = path.join(root, BASELINE_REL_PATH);
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify({ entries: [] }), 'utf8');

    const result = runNode([isolatedScript, '--json'], { timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(result.outcome, 'exited');
    assert.strictEqual(result.exitCode, 1);
    const report = JSON.parse(result.stdout);
    assert.strictEqual(report.reason, REASON.FAIL_FRESH_VIOLATION);
    assert.strictEqual(report.violations.length, 1);
    assert.strictEqual(report.violations[0].file, FAKE_FILE);
    assert.strictEqual(report.violations[0].kind, 'B');
    assert.strictEqual(report.violations[0].found, 'cat');
  });

  test('C3: --update regenerates a baseline that then passes', (t) => {
    const root = createTempDir('gsd-3409-c3-');
    t.after(() => cleanup(root));
    const isolatedScript = buildIsolatedGuard(root);
    const wfDir = path.join(root, 'gsd-core', 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, 'fake.md'), `${catLine('dir/*.md')}\n`);

    const first = runNode([isolatedScript, '--update'], { timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(first.exitCode, 0, first.stderr);

    const second = runNode([isolatedScript, '--json'], { timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(second.exitCode, 0, second.stderr);
    const report = JSON.parse(second.stdout);
    assert.strictEqual(report.reason, REASON.OK_NO_VIOLATIONS);
  });

  test('C4: --update output is deterministic across two runs', (t) => {
    const root = createTempDir('gsd-3409-c4-');
    t.after(() => cleanup(root));
    const isolatedScript = buildIsolatedGuard(root);
    const wfDir = path.join(root, 'gsd-core', 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(path.join(wfDir, 'a.md'), `${catLine('dir/*.md')}\n`);
    fs.writeFileSync(path.join(wfDir, 'b.md'), 'ls -d other/*.md 2>/dev/null || echo "none"\n');

    runNode([isolatedScript, '--update'], { timeoutMs: PROBE_TIMEOUT_MS });
    const firstBaseline = fs.readFileSync(path.join(root, BASELINE_REL_PATH), 'utf8');
    runNode([isolatedScript, '--update'], { timeoutMs: PROBE_TIMEOUT_MS });
    const secondBaseline = fs.readFileSync(path.join(root, BASELINE_REL_PATH), 'utf8');
    assert.strictEqual(firstBaseline, secondBaseline);
  });

  test('C5: baseline entries are sorted by (file, text)', (t) => {
    const root = createTempDir('gsd-3409-c5-');
    t.after(() => cleanup(root));
    const violations = [
      { file: 'z.md', line: 1, kind: 'B', found: 'cat', text: 'zzz' },
      { file: 'a.md', line: 1, kind: 'B', found: 'cat', text: 'zzz' },
      { file: 'a.md', line: 2, kind: 'B', found: 'cat', text: 'aaa' },
    ];
    const entries = writeBaseline(root, violations);
    const keys = entries.map((e) => `${e.file} ${e.text}`);
    const sortedKeys = [...keys].sort();
    assert.deepStrictEqual(keys, sortedKeys);
  });
});

// ─── dedupeViolationsForBaseline — count aggregation ──────────────────────

describe('dedupeViolationsForBaseline', () => {
  test('collapses byte-identical (file, text) pairs into one entry with a count', () => {
    const violations = [
      { file: 'a.md', line: 1, kind: 'A', found: '--pick', text: 'X' },
      { file: 'a.md', line: 5, kind: 'A', found: '--pick', text: 'X' },
      { file: 'a.md', line: 9, kind: 'B', found: 'cat', text: 'Y' },
    ];
    const entries = dedupeViolationsForBaseline(violations);
    assert.strictEqual(entries.length, 2);
    const xEntry = entries.find((e) => e.text === 'X');
    assert.strictEqual(xEntry.count, 2);
    const yEntry = entries.find((e) => e.text === 'Y');
    assert.strictEqual(yEntry.count, 1);
  });
});

// ─── Regex-level sanity (documents Detector B's surviving regexes' shapes) ─
//
// PICK_RE / ECHO_FALLBACK_RE were retired with Detector A (#3884) and are no
// longer exported — there is nothing left to assert on directly.

describe('Regex shape sanity', () => {
  test('CAT_LS_COMMAND_RE requires cat/ls immediately at a command-position anchor', () => {
    assert.ok(CAT_LS_COMMAND_RE.test('cat x'));
    assert.ok(CAT_LS_COMMAND_RE.test('$(cat x)'));
    assert.ok(!CAT_LS_COMMAND_RE.test('concatenate x'));
    assert.ok(!CAT_LS_COMMAND_RE.test('a cat b'));
  });

  test('HEREDOC_AFTER_COMMAND_RE matches a heredoc operator immediately after the command, with or without a leading space', () => {
    assert.ok(HEREDOC_AFTER_COMMAND_RE.test(" <<'EOF'"));
    assert.ok(HEREDOC_AFTER_COMMAND_RE.test('<<EOF'));
    assert.ok(!HEREDOC_AFTER_COMMAND_RE.test(' dir/*.md'));
  });

  test('MARKER_RE captures the reason after the colon, trimming leading whitespace', () => {
    // Subject hoisted to a named const rather than passed as a string
    // literal directly to the .exec call below — scripts/prompt-injection-scan.sh's
    // receiver-blind scan pattern (deliberately kept wide to catch the
    // child_process module's exec function invoked with a string) flags a
    // quote immediately following an open paren after the token `exec`, with
    // no way to distinguish RegExp#exec from that shell-spawning call by
    // pattern alone. Do not simplify this back.
    const subject = '# gsd-scan-ignore: #3409 rationale';
    const m = MARKER_RE.exec(subject);
    assert.ok(m);
    assert.strictEqual(m[1], '#3409 rationale');
  });
});

// ─── REASON enum — locks the typed outcome surface ────────────────────────
//
// CONTRIBUTING.md's "Prohibited: Raw Text Matching on Test Outputs": adding a
// new reason requires updating the REASON enum, the --json emission /
// loadBaseline call site that produces it, AND this test — three coordinated
// changes that keep the code surface from drifting from the test surface.

describe('REASON enum', () => {
  test('the frozen enum exposes exactly the documented set of outcome codes', () => {
    assert.deepStrictEqual(Object.keys(REASON).sort(), [
      'FAIL_BASELINE_EMPTY',
      'FAIL_BASELINE_ENTRIES_NOT_ARRAY',
      'FAIL_BASELINE_ENTRY_COUNT_INVALID',
      'FAIL_BASELINE_ENTRY_FIELD_INVALID',
      'FAIL_BASELINE_ENTRY_NOT_OBJECT',
      'FAIL_BASELINE_INVALID_JSON',
      'FAIL_BASELINE_LOAD',
      'FAIL_BASELINE_MISSING',
      'FAIL_BASELINE_NOT_OBJECT',
      'FAIL_FRESH_VIOLATION',
      'FAIL_MALFORMED_MARKER',
      'FAIL_STALE_ENTRY',
      'OK_BASELINE_UPDATED',
      'OK_NO_VIOLATIONS',
    ]);
  });

  test('the enum is frozen — an attempted mutation is a no-op (non-strict) / throws (strict)', () => {
    assert.throws(() => {
      'use strict';
      REASON.FAIL_FRESH_VIOLATION = 'tampered';
    }, TypeError);
    assert.strictEqual(REASON.FAIL_FRESH_VIOLATION, 'fail_fresh_violation');
  });
});
