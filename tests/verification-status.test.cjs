'use strict';

/**
 * Tests for verification-status module (issue #651).
 *
 * Covers:
 *  1. status: passed → routing
 *  2. status: gaps_found with phase token extraction
 *  3. status: human_needed → routing
 *  4. No *-VERIFICATION.md → 'missing'
 *  5. Frontmatter status present but unknown value → 'unknown'
 *  6. BROAD-GREP REGRESSION: body `status:` lines ignored, frontmatter wins
 *  7. PARITY: VERIFIER_STATUSES covered by routing table; gsd-verifier.md emitted statuses covered
 *  8. CRLF line endings in frontmatter
 *  9. Body-only file (no frontmatter block) → missing
 * 10. Nonexistent phase directory → missing
 * 11. Multiple *-VERIFICATION.md files → first by sort
 * 12. ship.md PHASE_VERIFICATION_INCOMPLETE sentinel (contract anchor for #651 consolidation)
 *
 * PORTABILITY: pure JS — no shell-outs, no bash fences.
 * Cross-platform (passes on Windows). Ref: DEFECT.TEST-SHELL-PIPELINE-NONPORTABLE.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { cleanup } = require('./helpers.cjs');

const {
  VERIFIER_STATUSES,
  VERIFICATION_ROUTING_TABLE,
  defaultPhaseCleanCommitTimesMs,
  readVerificationStatus,
} = require('../gsd-core/bin/lib/verification.cjs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a temporary phase directory under os.tmpdir().
 * Returns the absolute path; caller must clean up.
 */
function mkPhaseDir(suffix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `gsd-651-${suffix}-`));
}

/**
 * Write a *-VERIFICATION.md file with the given frontmatter status and
 * optional body content.
 *
 * @param {string} dir          - Phase directory path
 * @param {string} filename     - e.g. '01-review-VERIFICATION.md'
 * @param {string} status       - Frontmatter status value
 * @param {string} [body]       - Content after the closing `---`
 */
function writeVerificationMd(dir, filename, status, body = '') {
  const frontmatter = `---\nstatus: ${status}\n---\n`;
  fs.writeFileSync(path.join(dir, filename), frontmatter + body);
}

function setMtime(filePath, iso) {
  const time = new Date(iso);
  fs.utimesSync(filePath, time, time);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('verification-status', () => {

  // ── Case 1: passed ────────────────────────────────────────────────────────
  test('status: passed → next_command is empty, status is passed', () => {
    const dir = mkPhaseDir('passed');
    try {
      writeVerificationMd(dir, '01-foo-VERIFICATION.md', 'passed');
      const result = readVerificationStatus(dir);
      assert.equal(result.status, 'passed', 'status must be passed');
      assert.equal(result.next_command, '', 'next_command must be empty for passed');
      assert.ok(result.next_action.length > 0, 'next_action must be non-empty');
    } finally {
      cleanup(dir);
    }
  });

  // ── Case 2: gaps_found with phase token extraction ────────────────────────
  test('status: gaps_found in "03-foo" dir → next_command includes phase token 03', () => {
    // Phase dir basename starts with "03" — extractPhaseToken('03-foo') → '03'
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-651-parent-'));
    const phaseDir = path.join(baseDir, '03-foo');
    fs.mkdirSync(phaseDir);
    try {
      writeVerificationMd(phaseDir, '03-foo-VERIFICATION.md', 'gaps_found');
      const result = readVerificationStatus(phaseDir);
      assert.equal(result.status, 'gaps_found', 'status must be gaps_found');
      assert.ok(
        result.next_command.includes('03'),
        `next_command should include phase token '03'; got: ${result.next_command}`,
      );
      assert.ok(
        result.next_command.includes('--gaps'),
        `next_command should include --gaps; got: ${result.next_command}`,
      );
      assert.equal(result.next_command, '/gsd-plan-phase 03 --gaps');
    } finally {
      cleanup(baseDir);
    }
  });

  // ── Case 3: human_needed ──────────────────────────────────────────────────
  test('status: human_needed → status human_needed, next_command is empty', () => {
    const dir = mkPhaseDir('human-needed');
    try {
      writeVerificationMd(dir, '01-hn-VERIFICATION.md', 'human_needed');
      const result = readVerificationStatus(dir);
      assert.equal(result.status, 'human_needed');
      // #2617: human_needed now names the command the next_action describes.
      // This fixture's dir is not phase-shaped, so no number is appended.
      assert.equal(result.next_command, '/gsd-verify-work');
      assert.ok(result.next_action.length > 0);
    } finally {
      cleanup(dir);
    }
  });

  // ── Case 4: no *-VERIFICATION.md → missing ────────────────────────────────
  test('no *-VERIFICATION.md file → status missing, next_command execute-phase', () => {
    const dir = mkPhaseDir('missing');
    try {
      // write a non-matching file to confirm it is ignored
      fs.writeFileSync(path.join(dir, 'README.md'), '# phase');
      const result = readVerificationStatus(dir);
      assert.equal(result.status, 'missing');
      assert.equal(result.next_command, '/gsd-execute-phase');
      assert.ok(result.next_action.includes('verify step never completed'));
    } finally {
      cleanup(dir);
    }
  });

  // ── Case 5: unknown frontmatter status value ──────────────────────────────
  test("frontmatter status 'bogus' → status unknown, next_command execute-phase", () => {
    const dir = mkPhaseDir('unknown');
    try {
      writeVerificationMd(dir, '01-u-VERIFICATION.md', 'bogus');
      const result = readVerificationStatus(dir);
      assert.equal(result.status, 'unknown');
      assert.equal(result.next_command, '/gsd-execute-phase');
      assert.ok(
        result.next_action.includes('bogus'),
        `next_action should mention the raw value; got: ${result.next_action}`,
      );
    } finally {
      cleanup(dir);
    }
  });

  // ── Case 6: BROAD-GREP REGRESSION (critical) ──────────────────────────────
  //
  // Frontmatter: `status: passed`
  // Body: a fenced code block containing `status: gaps_found` AND `status: human_needed`
  // Result MUST be 'passed' — proving body lines are NOT matched.
  // This is the exact failure mode that issue #586 / PR #650 hit.
  //
  test('BROAD-GREP REGRESSION: body status lines ignored, frontmatter status wins', () => {
    const dir = mkPhaseDir('broad-grep');
    try {
      const bodyWithEmbeddedStatuses = [
        '',
        '## Section',
        '',
        'Some prose about the results.',
        '',
        '```yaml',
        'status: gaps_found',
        'gaps:',
        '  - fix the thing',
        '```',
        '',
        'Another block:',
        '',
        '```',
        'status: human_needed',
        '```',
        '',
        'End of document.',
      ].join('\n');

      writeVerificationMd(dir, '01-bg-VERIFICATION.md', 'passed', bodyWithEmbeddedStatuses);

      const result = readVerificationStatus(dir);
      assert.equal(
        result.status,
        'passed',
        `Expected status 'passed' (frontmatter wins); got '${result.status}'. ` +
          'Body status: lines must NOT be matched.',
      );
      assert.equal(result.next_command, '', 'next_command must be empty for passed');
    } finally {
      cleanup(dir);
    }
  });

  // ── Case 7: PARITY ASSERTION ──────────────────────────────────────────────
  //
  // (a) Every value in VERIFIER_STATUSES has a corresponding key in VERIFICATION_ROUTING_TABLE.
  // (b) Parse agents/gsd-verifier.md for emitted statuses via /→ \*\*status:\s*([a-z_]+)\*\*/g,
  //     collect the set, and assert every emitted status is a routing key.
  //
  test('PARITY: VERIFIER_STATUSES covered by routing table', () => {
    for (const s of VERIFIER_STATUSES) {
      assert.ok(
        s in VERIFICATION_ROUTING_TABLE,
        `VERIFIER_STATUS '${s}' has no entry in VERIFICATION_ROUTING_TABLE`,
      );
    }
  });

  test('PARITY: gsd-verifier.md emitted statuses all have routing table entries', () => {
    const verifierPath = path.join(__dirname, '..', 'agents', 'gsd-verifier.md');
    const content = fs.readFileSync(verifierPath, 'utf-8');

    const emittedStatuses = new Set();

    // Source (a): decision-tree arrow lines — `→ **status: <value>**`
    // These are the per-branch emission points in Step 9 (the decision tree).
    const reArrow = /→ \*\*status:\s*([a-z_]+)\*\*/g;
    let m;
    while ((m = reArrow.exec(content)) !== null) {
      emittedStatuses.add(m[1]);
    }

    // Source (b): output-template line — `status: A | B | C` (pipe-delimited list
    // of permitted values inside the frontmatter template block in the <output> section).
    // Anchored to lines that start with `status:` and contain `|` to avoid false
    // matches on prose sentences that happen to mention "status:".
    const reTemplate = /^status:\s+([a-z_]+(?:\s*\|\s*[a-z_]+)+)\s*$/gm;
    while ((m = reTemplate.exec(content)) !== null) {
      for (const token of m[1].split('|')) {
        const t = token.trim();
        if (t) emittedStatuses.add(t);
      }
    }

    assert.ok(
      emittedStatuses.size > 0,
      'No emitted statuses found in gsd-verifier.md — regex or file path may be wrong. ' +
        'Checked: (a) → **status: X** arrow lines, (b) status: A | B | C template lines.',
    );

    for (const s of emittedStatuses) {
      assert.ok(
        s in VERIFICATION_ROUTING_TABLE,
        `gsd-verifier.md emits status '${s}' but VERIFICATION_ROUTING_TABLE has no entry for it. ` +
          'Add a route or remove/rename the status in gsd-verifier.md.',
      );
    }
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  // CRLF line endings in frontmatter
  test('CRLF line endings in frontmatter → correct status parsed', () => {
    const dir = mkPhaseDir('crlf');
    try {
      // Construct a file with CRLF line endings throughout
      const content = '---\r\nstatus: passed\r\nphase: 01-demo\r\n---\r\n\r\n# Body\r\n';
      fs.writeFileSync(path.join(dir, '01-crlf-VERIFICATION.md'), content);
      const result = readVerificationStatus(dir);
      assert.equal(result.status, 'passed', 'CRLF frontmatter must parse to passed');
      assert.equal(result.next_command, '');
    } finally {
      cleanup(dir);
    }
  });

  // File with NO frontmatter block — body-only `status:` line must NOT be matched
  test('body-only file with no frontmatter block (status: in body) → missing', () => {
    const dir = mkPhaseDir('no-fm');
    try {
      // No opening `---` — this is a plain markdown file with a status: line in the body
      const content = '# Phase Verification\n\nstatus: passed\n\nSome notes.\n';
      fs.writeFileSync(path.join(dir, '01-nofm-VERIFICATION.md'), content);
      const result = readVerificationStatus(dir);
      assert.equal(
        result.status,
        'missing',
        "A body-only status: line must NOT be read — result should be 'missing'",
      );
    } finally {
      cleanup(dir);
    }
  });

  // Missing / nonexistent phase directory → missing
  test('nonexistent phase directory → missing', () => {
    const nonexistent = path.join(os.tmpdir(), 'gsd-651-nonexistent-' + Date.now());
    const result = readVerificationStatus(nonexistent);
    assert.equal(result.status, 'missing', 'unreadable/nonexistent dir must return missing');
    assert.equal(result.next_command, '/gsd-execute-phase');
  });

  // Multiple *-VERIFICATION.md files → deterministic pick (first by sort)
  test('multiple *-VERIFICATION.md files in dir → first by sort order wins', () => {
    const dir = mkPhaseDir('multi');
    try {
      // Write two files: alphabetically "01-a" comes before "02-b"
      // "01-a" has passed; "02-b" has gaps_found — first by sort must win
      const fm = (status) => `---\nstatus: ${status}\n---\n`;
      fs.writeFileSync(path.join(dir, '01-a-VERIFICATION.md'), fm('passed'));
      fs.writeFileSync(path.join(dir, '02-b-VERIFICATION.md'), fm('gaps_found'));
      const result = readVerificationStatus(dir);
      assert.equal(
        result.status,
        'passed',
        'When multiple *-VERIFICATION.md files exist, the first by lexicographic sort must be used',
      );
    } finally {
      cleanup(dir);
    }
  });

  test('passed verification older than a summary returns stale', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-651-parent-'));
    const dir = path.join(baseDir, '01-stale-passed');
    fs.mkdirSync(dir);
    try {
      const verificationPath = path.join(dir, '01-VERIFICATION.md');
      const summaryPath = path.join(dir, '01-01-SUMMARY.md');
      writeVerificationMd(dir, '01-VERIFICATION.md', 'passed');
      fs.writeFileSync(summaryPath, '# Summary');
      setMtime(verificationPath, '2026-01-01T00:00:00.000Z');
      setMtime(summaryPath, '2026-01-01T00:01:00.000Z');

      // git times unavailable → mtime-fallback path (#2348). Injected so the
      // test stays hermetic (no git spawn) regardless of tmpdir repo state.
      const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
      assert.equal(result.status, 'stale');
      assert.match(result.next_action, /stale/i);
      assert.equal(result.next_command, '/gsd-verify-work 01');
    } finally {
      cleanup(baseDir);
    }
  });

  test('gaps_found verification older than a summary still returns gaps_found (not stale)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-651-parent-'));
    const dir = path.join(baseDir, '01-stale-gaps');
    fs.mkdirSync(dir);
    try {
      const verificationPath = path.join(dir, '01-VERIFICATION.md');
      const summaryPath = path.join(dir, '01-01-SUMMARY.md');
      writeVerificationMd(dir, '01-VERIFICATION.md', 'gaps_found');
      fs.writeFileSync(summaryPath, '# Summary');
      setMtime(verificationPath, '2026-01-01T00:00:00.000Z');
      setMtime(summaryPath, '2026-01-01T00:01:00.000Z');

      const result = readVerificationStatus(dir);
      assert.equal(result.status, 'gaps_found');
      assert.equal(result.next_command, '/gsd-plan-phase 01 --gaps');
    } finally {
      cleanup(baseDir);
    }
  });

  test('human_needed verification older than nested plans/SUMMARY-NN.md returns stale', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-651-parent-'));
    const dir = path.join(baseDir, '01-stale-human-nested');
    fs.mkdirSync(dir);
    try {
      const plansDir = path.join(dir, 'plans');
      fs.mkdirSync(plansDir);
      const verificationPath = path.join(dir, '01-VERIFICATION.md');
      const summaryPath = path.join(plansDir, 'SUMMARY-01-manual.md');
      writeVerificationMd(dir, '01-VERIFICATION.md', 'human_needed');
      fs.writeFileSync(summaryPath, '# Summary');
      setMtime(verificationPath, '2026-01-01T00:00:00.000Z');
      setMtime(summaryPath, '2026-01-01T00:01:00.000Z');

      // git times unavailable → mtime-fallback path (#2348).
      const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
      assert.equal(result.status, 'stale');
      assert.equal(result.next_command, '/gsd-verify-work 01');
    } finally {
      cleanup(baseDir);
    }
  });

  // ── #2348: staleness derived from git commit time, not filesystem mtime ────
  //
  // The verification staleness gate must survive a fresh `git clone` / `cp -R`
  // and an unrelated `touch`. It compares git commit times (content-tied) and
  // only falls back to mtime when a file has no commit time (uncommitted / no
  // repo), always reading both sides of a comparison from the same clock.

  // Injectable per-phase git-commit-time resolver: given the phase-relative file
  // names, returns Map<file, epoch-ms>. A file whose basename is absent from
  // `byBase` resolves to "no git time" (uncommitted / not in git) → mtime clock.
  const phaseCleanTimes = (byBase) => (_phaseDir, files) => {
    const m = new Map();
    for (const file of files) {
      const base = file.split(/[\\/]/).pop();
      if (Object.prototype.hasOwnProperty.call(byBase, base)) m.set(file, byBase[base]);
    }
    return m;
  };

  // git availability for the real-subprocess integration test below.
  const GIT_AVAILABLE = (() => {
    try {
      require('node:child_process').execFileSync('git', ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  test('committed passed verification is NOT stale from mtime skew alone when the summary was not committed later (#2348)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2348-parent-'));
    const dir = path.join(baseDir, '02-clone-skew');
    fs.mkdirSync(dir);
    try {
      const verificationPath = path.join(dir, '02-VERIFICATION.md');
      const summaryPath = path.join(dir, '02-02-SUMMARY.md');
      writeVerificationMd(dir, '02-VERIFICATION.md', 'passed');
      fs.writeFileSync(summaryPath, '# Summary');
      // Filesystem mtimes reproduce the reported 49s checkout skew (summary newer).
      setMtime(verificationPath, '2026-07-16T22:53:49.000Z');
      setMtime(summaryPath, '2026-07-16T22:54:38.000Z');
      // But in git both were committed together — the summary is not newer.
      const phaseCleanCommitTimesMs = phaseCleanTimes({
        '02-VERIFICATION.md': Date.parse('2026-07-16T22:50:00.000Z'),
        '02-02-SUMMARY.md': Date.parse('2026-07-16T22:50:00.000Z'),
      });

      const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs });
      assert.equal(
        result.status,
        'passed',
        'mtime skew alone must not override a committed passing verification',
      );
      assert.equal(result.next_command, '');
    } finally {
      cleanup(baseDir);
    }
  });

  test('committed verification IS stale when the summary was committed later, even if its mtime is older — git clock wins (#2348)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2348-parent-'));
    const dir = path.join(baseDir, '02-git-stale');
    fs.mkdirSync(dir);
    try {
      const verificationPath = path.join(dir, '02-VERIFICATION.md');
      const summaryPath = path.join(dir, '02-02-SUMMARY.md');
      writeVerificationMd(dir, '02-VERIFICATION.md', 'passed');
      fs.writeFileSync(summaryPath, '# Summary');
      // mtimes point the OTHER way (verification newer) to prove git is authoritative.
      setMtime(verificationPath, '2026-07-16T23:00:00.000Z');
      setMtime(summaryPath, '2026-07-16T22:00:00.000Z');
      const phaseCleanCommitTimesMs = phaseCleanTimes({
        '02-VERIFICATION.md': Date.parse('2026-07-16T22:50:00.000Z'),
        '02-02-SUMMARY.md': Date.parse('2026-07-16T22:55:00.000Z'), // committed later
      });

      const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs });
      assert.equal(result.status, 'stale');
      assert.equal(result.next_command, '/gsd-verify-work 02');
    } finally {
      cleanup(baseDir);
    }
  });

  test('git-clock staleness boundary: summary committed at V-1 / V / V+1 relative to verification (#2348)', () => {
    const V = Date.parse('2026-07-16T22:50:00.000Z');
    for (const { deltaMs, expected } of [
      { deltaMs: -1, expected: 'passed' },
      { deltaMs: 0, expected: 'passed' },
      { deltaMs: 1, expected: 'stale' },
    ]) {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2348-boundary-'));
      const dir = path.join(baseDir, '03-boundary');
      fs.mkdirSync(dir);
      try {
        const verificationPath = path.join(dir, '03-VERIFICATION.md');
        const summaryPath = path.join(dir, '03-03-SUMMARY.md');
        writeVerificationMd(dir, '03-VERIFICATION.md', 'passed');
        fs.writeFileSync(summaryPath, '# Summary');
        setMtime(verificationPath, '2026-07-16T22:50:00.000Z');
        setMtime(summaryPath, '2026-07-16T22:50:00.000Z');
        const phaseCleanCommitTimesMs = phaseCleanTimes({
          '03-VERIFICATION.md': V,
          '03-03-SUMMARY.md': V + deltaMs,
        });

        const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs });
        assert.equal(
          result.status,
          expected,
          `summary committed at V${deltaMs >= 0 ? '+' : ''}${deltaMs}ms should be ${expected}`,
        );
      } finally {
        cleanup(baseDir);
      }
    }
  });

  test('a committed-clean verification is stale when a summary is edited afterward (dirty) — the edit is not shadowed by the summary commit time (#2348 dirty regression)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2348-dirty-'));
    const dir = path.join(baseDir, '02-dirty-summary');
    fs.mkdirSync(dir);
    try {
      const verificationPath = path.join(dir, '02-VERIFICATION.md');
      const summaryPath = path.join(dir, '02-02-SUMMARY.md');
      writeVerificationMd(dir, '02-VERIFICATION.md', 'passed');
      fs.writeFileSync(summaryPath, '# Summary');
      // Verification is committed & clean at 22:50. The summary is DIRTY (edited
      // on disk after its commit) so it is absent from the clean-commit map and
      // must be timed by its mtime — a later edit at 22:54.
      setMtime(verificationPath, '2026-07-16T22:50:00.000Z'); // unused (clean → commit time)
      setMtime(summaryPath, '2026-07-16T22:54:00.000Z');
      const phaseCleanCommitTimesMs = phaseCleanTimes({
        '02-VERIFICATION.md': Date.parse('2026-07-16T22:50:00.000Z'),
        // '02-02-SUMMARY.md' intentionally omitted → treated as dirty → mtime.
      });

      const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs });
      assert.equal(
        result.status,
        'stale',
        'a dirty summary edited after the verification must stale it via mtime, not be shadowed by an equal/earlier commit time',
      );
      assert.equal(result.next_command, '/gsd-verify-work 02');
    } finally {
      cleanup(baseDir);
    }
  });

  test('both files uncommitted (no clean-commit time) fall back to mtime ordering (#2348)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2348-uncommitted-'));
    const dir = path.join(baseDir, '02-uncommitted');
    fs.mkdirSync(dir);
    try {
      const verificationPath = path.join(dir, '02-VERIFICATION.md');
      const summaryPath = path.join(dir, '02-02-SUMMARY.md');
      writeVerificationMd(dir, '02-VERIFICATION.md', 'passed');
      fs.writeFileSync(summaryPath, '# Summary');
      // Neither file is committed → empty clean map → pure mtime comparison.
      setMtime(verificationPath, '2026-07-16T23:00:00.000Z');
      setMtime(summaryPath, '2026-07-16T22:00:00.000Z'); // summary older → not stale
      const phaseCleanCommitTimesMs = phaseCleanTimes({});

      const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs });
      assert.equal(result.status, 'passed', 'summary older on the mtime clock → not stale');
    } finally {
      cleanup(baseDir);
    }
  });

  test('the git-commit-time resolver is invoked at most once per phase, regardless of summary count (#2348 no per-file fan-out)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2348-fanout-'));
    const dir = path.join(baseDir, '01-fanout');
    fs.mkdirSync(dir);
    try {
      writeVerificationMd(dir, '01-VERIFICATION.md', 'passed');
      for (const n of ['01', '02', '03']) {
        fs.writeFileSync(path.join(dir, `01-${n}-SUMMARY.md`), '# Summary');
      }
      let calls = 0;
      let filesSeen = 0;
      const phaseCleanCommitTimesMs = (_phaseDir, files) => {
        calls += 1;
        filesSeen = files.length;
        return new Map();
      };

      readVerificationStatus(dir, { phaseCleanCommitTimesMs });
      assert.equal(calls, 1, 'exactly one git walk for the whole phase, not one per summary file');
      assert.equal(filesSeen, 4, 'the single walk receives the verification file + all 3 summaries');
    } finally {
      cleanup(baseDir);
    }
  });

  test('a phase with no summary files performs zero git walks and is never stale (#2348)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2348-nosummary-'));
    const dir = path.join(baseDir, '01-no-summary');
    fs.mkdirSync(dir);
    try {
      writeVerificationMd(dir, '01-VERIFICATION.md', 'passed');
      let calls = 0;
      const phaseCleanCommitTimesMs = () => {
        calls += 1;
        return new Map();
      };

      const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs });
      assert.equal(result.status, 'passed');
      assert.equal(calls, 0, 'no summaries → nothing can be newer → skip the git subprocess entirely');
    } finally {
      cleanup(baseDir);
    }
  });

  test(
    'real git: a summary committed after the verification reads stale via the real git clock, even for a dash-named file (#2348 end-to-end + `--` argv guard)',
    { skip: GIT_AVAILABLE ? false : 'git binary not available' },
    () => {
      const { execFileSync } = require('node:child_process');
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2348-realgit-'));
      const runGit = (args, extraEnv) =>
        execFileSync('git', args, {
          cwd: repo,
          stdio: 'pipe',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(extraEnv || {}) },
        });
      const commitEnvAt = (iso) => ({ GIT_AUTHOR_DATE: iso + '+00:00', GIT_COMMITTER_DATE: iso + '+00:00' });
      try {
        runGit(['init', '-q']);
        runGit(['config', 'user.email', 'test@example.com']);
        runGit(['config', 'user.name', 'Test']);
        runGit(['config', 'commit.gpgsign', 'false']);

        const dir = path.join(repo, '.planning', 'phases', '01-real');
        fs.mkdirSync(dir, { recursive: true });
        const verificationPath = path.join(dir, '01-VERIFICATION.md');
        // A leading-dash filename exercises the `--` pathspec guard in the real
        // `git log` argv: if `--` were dropped git would read it as a flag.
        const summaryName = '-danger-SUMMARY.md';
        const summaryPath = path.join(dir, summaryName);

        fs.writeFileSync(verificationPath, '---\nstatus: passed\n---\n');
        runGit(['add', '--', verificationPath]);
        runGit(['commit', '-q', '-m', 'add verification'], commitEnvAt('2026-07-16T22:50:00'));

        fs.writeFileSync(summaryPath, '# Summary');
        runGit(['add', '--', summaryPath]);
        runGit(['commit', '-q', '-m', 'add summary later'], commitEnvAt('2026-07-16T22:55:00'));

        // Make mtimes claim the OPPOSITE order so only the git clock can stale it.
        setMtime(summaryPath, '2000-01-01T00:00:00.000Z');
        setMtime(verificationPath, '2030-01-01T00:00:00.000Z');

        // No seam injected → the real defaultPhaseCleanCommitTimesMs / execGit path.
        const result = readVerificationStatus(dir);
        assert.equal(
          result.status,
          'stale',
          'summary committed after the verification must read stale on the real git clock, and the dash-named file must resolve through the `--` pathspec guard',
        );
        assert.equal(result.next_command, '/gsd-verify-work 01');
      } finally {
        cleanup(repo);
      }
    },
  );

  test(
    'real git: a committed summary edited on disk (dirty) reads stale via mtime, not shadowed by its commit time (#2348 dirty regression, end-to-end)',
    { skip: GIT_AVAILABLE ? false : 'git binary not available' },
    () => {
      const { execFileSync } = require('node:child_process');
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2348-realgit-dirty-'));
      const runGit = (args, extraEnv) =>
        execFileSync('git', args, {
          cwd: repo,
          stdio: 'pipe',
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(extraEnv || {}) },
        });
      const commitEnvAt = (iso) => ({ GIT_AUTHOR_DATE: iso + '+00:00', GIT_COMMITTER_DATE: iso + '+00:00' });
      try {
        runGit(['init', '-q']);
        runGit(['config', 'user.email', 'test@example.com']);
        runGit(['config', 'user.name', 'Test']);
        runGit(['config', 'commit.gpgsign', 'false']);

        const dir = path.join(repo, '.planning', 'phases', '01-real');
        fs.mkdirSync(dir, { recursive: true });
        const verificationPath = path.join(dir, '01-VERIFICATION.md');
        const summaryPath = path.join(dir, '01-01-SUMMARY.md');

        fs.writeFileSync(verificationPath, '---\nstatus: passed\n---\n');
        fs.writeFileSync(summaryPath, '# Summary');
        // Commit BOTH together — identical commit time, so commit time alone
        // would read "not stale".
        runGit(['add', '--', verificationPath, summaryPath]);
        runGit(['commit', '-q', '-m', 'add phase'], commitEnvAt('2026-07-16T22:50:00'));

        // Edit the summary again WITHOUT committing → working tree diverges from HEAD.
        fs.writeFileSync(summaryPath, '# Summary edited');
        setMtime(verificationPath, '2026-07-16T22:50:00.000Z'); // clean → commit time used
        setMtime(summaryPath, '2026-07-16T22:54:00.000Z'); // dirty → this later mtime is used

        const result = readVerificationStatus(dir);
        assert.equal(
          result.status,
          'stale',
          'a committed-then-edited (dirty) summary must read stale via mtime, not be shadowed by its now-stale commit time',
        );
        assert.equal(result.next_command, '/gsd-verify-work 01');
      } finally {
        cleanup(repo);
      }
    },
  );

  // ── #2348: default resolver two-call error handling (hermetic, injected execGit) ──

  const okResult = (stdout) => ({ exitCode: 0, stdout, stderr: '', signal: null, error: null });
  const errResult = () => ({
    exitCode: 127,
    stdout: '',
    stderr: 'git: not found',
    signal: null,
    error: new Error('ENOENT'),
  });
  const nonzeroResult = () => ({ exitCode: 128, stdout: '', stderr: 'fatal', signal: null, error: null });
  // Fake execGit dispatching on the git subcommand (args[0]).
  const fakeExecGit = ({ log, diff }) => (args) => {
    if (args[0] === 'log') return log;
    if (args[0] === 'diff') return diff;
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  // Reverse-chronological `git log --name-only` fixture: summary newer than verification.
  const LOG_OUT = [
    '2000',
    '',
    '.planning/phases/01-x/01-01-SUMMARY.md',
    '',
    '1000',
    '',
    '.planning/phases/01-x/01-VERIFICATION.md',
  ].join('\n');
  const FILES = ['01-VERIFICATION.md', '01-01-SUMMARY.md'];

  test('resolver: parses commit times and drops a file the dirty-check reports (#2348)', () => {
    const map = defaultPhaseCleanCommitTimesMs(
      '/repo/.planning/phases/01-x',
      FILES,
      fakeExecGit({ log: okResult(LOG_OUT), diff: okResult('.planning/phases/01-x/01-01-SUMMARY.md') }),
    );
    assert.equal(map.get('01-VERIFICATION.md'), 1000 * 1000, 'verification commit time (seconds→ms)');
    assert.equal(map.has('01-01-SUMMARY.md'), false, 'dirty summary dropped → will use mtime');
  });

  test('resolver: clean tree (dirty-check reports nothing) keeps all commit times (#2348)', () => {
    const map = defaultPhaseCleanCommitTimesMs(
      '/repo/.planning/phases/01-x',
      FILES,
      fakeExecGit({ log: okResult(LOG_OUT), diff: okResult('') }),
    );
    assert.equal(map.get('01-VERIFICATION.md'), 1000 * 1000);
    assert.equal(map.get('01-01-SUMMARY.md'), 2000 * 1000);
  });

  test('resolver: FAILS SAFE (empty map) when the dirty-check errors after git log succeeds (#2348)', () => {
    const map = defaultPhaseCleanCommitTimesMs(
      '/repo/.planning/phases/01-x',
      FILES,
      fakeExecGit({ log: okResult(LOG_OUT), diff: errResult() }),
    );
    assert.equal(
      map.size,
      0,
      'an inconclusive dirty-check must discard commit times so every file falls back to mtime',
    );
  });

  test('resolver: FAILS SAFE (empty map) when the dirty-check exits non-zero (#2348)', () => {
    const map = defaultPhaseCleanCommitTimesMs(
      '/repo/.planning/phases/01-x',
      FILES,
      fakeExecGit({ log: okResult(LOG_OUT), diff: nonzeroResult() }),
    );
    assert.equal(map.size, 0);
  });

  test('resolver: empty map (mtime fallback) when git log itself fails (#2348)', () => {
    const map = defaultPhaseCleanCommitTimesMs(
      '/repo/.planning/phases/01-x',
      FILES,
      // diff would throw if consulted — proves log-failure short-circuits before it.
      fakeExecGit({ log: errResult(), diff: undefined }),
    );
    assert.equal(map.size, 0);
  });

  // ── Task 2 (B1): ship.md gate sentinel contract anchor ────────────────────
  //
  // The deleted tests/ship-586-verification-routing.test.cjs was the only
  // thing asserting that ship.md emits the PHASE_VERIFICATION_INCOMPLETE block
  // sentinel (its user-visible gate error key). This test re-anchors that contract.
  //
  test('ship.md still emits the PHASE_VERIFICATION_INCOMPLETE gate sentinel (contract anchor for #651 consolidation)', () => {
    const shipMdPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'ship.md');
    const content = fs.readFileSync(shipMdPath, 'utf-8');
    assert.ok(
      content.includes('PHASE_VERIFICATION_INCOMPLETE'),
      'ship.md must contain the literal PHASE_VERIFICATION_INCOMPLETE gate sentinel. ' +
        'If you renamed or removed it, update the verification routing and this contract test.',
    );
  });

});

// ─── #2617: next_command runtime projection ──────────────────────────────────
//
// Regression tests for #2617 — verification-status `next_command` bypassed the
// runtime command-surface projection.
//
// `src/verification.cts` stored and synthesized hard-coded `/gsd:…` strings with
// no runtime context, and `phase complete` relayed that raw field straight into
// its verification-blocked error. On a Codex project the suggested next step was
// `/gsd:execute-phase`, which Codex does not install — the surface there is
// `$gsd-execute-phase`. The colon form is doubly wrong: `runtime-slash.cts`
// documents that "the colon form is never emitted", so every runtime was getting
// a deprecated shape. (The 11 `/gsd-…` assertions above were `/gsd:…` before this
// fix — they are the failing-first record.)
//
// The fix keeps ONE routing seam and makes its emitted command runtime-aware:
// the table stores bare command names and every return path projects through
// `formatGsdSlash`, with callers passing `resolveRuntime(cwd)`.
//
// Coverage is the matrix the issue asked for — missing, unknown, gaps_found and
// stale, against Codex (`$gsd-…`) and a slash-hyphen runtime (`/gsd-…`) — plus
// the `phase complete` error path, not merely the router's return object.

/** Codex installs `$gsd-<cmd>`; every other shipped runtime installs `/gsd-<cmd>`. */
const RUNTIMES = [
  { id: 'codex', prefix: '$gsd-' },
  { id: 'cursor', prefix: '/gsd-' },
];

// NOTE: deliberately NOT file-scope beforeEach/afterEach. node:test applies
// module-scope hooks to EVERY test in the file, so hooks added here for the
// #2617 suites would also wrap the ~40 pre-existing tests above — making this
// block a single point of failure for suites it has nothing to do with. Each
// test allocates and releases its own phase dir instead.
let projBaseDir;
let projPhaseDir;

/**
 * Install the #2617 temp-phase-dir lifecycle INSIDE the calling describe.
 * node:test scopes hooks to their enclosing describe, so this keeps them off the
 * ~40 pre-existing tests in this file.
 */
function useProjectionPhaseDir() {
  beforeEach(() => {
    projBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2617-'));
    projPhaseDir = path.join(projBaseDir, '01-example');
    fs.mkdirSync(projPhaseDir, { recursive: true });
  });
  afterEach(() => cleanup(projBaseDir));
}

const verificationPath = () => path.join(projPhaseDir, '01-VERIFICATION.md');

function writeStatus(status) {
  fs.writeFileSync(verificationPath(), `---\nstatus: ${status}\n---\n\n# Verification\n`);
}

function removeVerification() {
  try { fs.unlinkSync(verificationPath()); } catch { /* already absent */ }
}

/** Make the verification file older than a summary → the stale branch. */
function makeStale() {
  const summaryPath = path.join(projPhaseDir, '01-01-SUMMARY.md');
  fs.writeFileSync(summaryPath, '# Summary\n');
  fs.utimesSync(verificationPath(), new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:00:00Z'));
  fs.utimesSync(summaryPath, new Date('2026-01-01T00:01:00Z'), new Date('2026-01-01T00:01:00Z'));
}

// git times unavailable → mtime-fallback path (#2348). Injected so the staleness
// clock stays hermetic regardless of the tmpdir's repo state.
const NO_GIT = { phaseCleanCommitTimesMs: () => new Map() };

function read(runtime, extra = {}) {
  return readVerificationStatus(projPhaseDir, { runtime, ...extra });
}

for (const { id, prefix } of RUNTIMES) {
  describe(`#2617: next_command uses the ${id} command surface`, () => {
    useProjectionPhaseDir();

    test('missing verification', () => {
      removeVerification();
      assert.equal(read(id).next_command, `${prefix}execute-phase 01`);
    });

    test('unparseable/absent frontmatter status is also "missing"', () => {
      fs.writeFileSync(verificationPath(), '# Verification\n\nNo frontmatter here.\n');
      assert.equal(read(id).next_command, `${prefix}execute-phase 01`);
    });

    test('unknown status value', () => {
      writeStatus('not-a-real-status');
      const result = read(id);
      assert.equal(result.status, 'unknown');
      assert.equal(result.next_command, `${prefix}execute-phase 01`);
    });

    test('gaps_found carries the phase number and --gaps flag through the projection', () => {
      writeStatus('gaps_found');
      const result = read(id);
      assert.equal(result.status, 'gaps_found');
      assert.equal(result.next_command, `${prefix}plan-phase 01 --gaps`);
    });

    test('stale carries the phase number through the projection', () => {
      writeStatus('passed');
      makeStale();
      const result = read(id, NO_GIT);
      assert.equal(result.status, 'stale');
      assert.equal(result.next_command, `${prefix}verify-work 01`);
    });

    test('passed has no next step and stays empty, not a bare prefix', () => {
      // Boundary: projecting an empty command must not emit `$gsd-` / `/gsd-`.
      writeStatus('passed');
      assert.equal(read(id).next_command, '',
        'passed has no next command and must project to the empty string');
    });

    test('human_needed names the verify-work command its next_action describes', () => {
      // #2617 unification: the table used to return '' here while init.cts's
      // parallel projector returned `verify-work <N>` for the same state — the
      // two surfaces disagreed on whether a next command existed at all.
      writeStatus('human_needed');
      assert.equal(read(id).next_command, `${prefix}verify-work 01`);
    });
  });
}

describe('#2617: no verification output suggests the deprecated colon form', () => {
  useProjectionPhaseDir();

  test('across every state and runtime, and for the default runtime', () => {
    const runtimeIds = [...RUNTIMES.map((r) => r.id), undefined];
    let checked = 0;

    for (const runtime of runtimeIds) {
      const opts = runtime === undefined ? { ...NO_GIT } : { runtime, ...NO_GIT };

      removeVerification();
      const cases = [readVerificationStatus(projPhaseDir, opts)];

      for (const status of ['not-a-real-status', 'gaps_found', 'passed', 'human_needed']) {
        writeStatus(status);
        cases.push(readVerificationStatus(projPhaseDir, opts));
      }
      writeStatus('passed');
      makeStale();
      cases.push(readVerificationStatus(projPhaseDir, opts));

      for (const result of cases) {
        assert.ok(
          !result.next_command.includes('/gsd:'),
          `deprecated colon form leaked for runtime=${String(runtime)}: ${result.next_command}`,
        );
        checked++;
      }
    }

    // Non-vacuity: 3 runtimes x 6 states.
    assert.equal(checked, 18, 'expected every runtime x state combination to be checked');
  });

  test('the default runtime yields the canonical hyphen form, not the colon form', () => {
    removeVerification();
    // No `runtime` option at all — the pre-fix default emitted `/gsd:execute-phase`.
    assert.equal(readVerificationStatus(projPhaseDir).next_command, '/gsd-execute-phase 01');
  });
});

describe('#2617: the phase-complete error path projects too', () => {
  // The issue is explicit that fixing only the router is insufficient: the
  // user-visible surface is `phase complete`, which relays next_command into its
  // blocked-completion error. Driven through the real CLI so the assertion is on
  // what a user actually sees.
  const { runGsdTools, createTempGitProject } = require('./helpers.cjs');

  for (const { id, prefix } of RUNTIMES) {
    test(`phase complete on ${id} suggests ${prefix}execute-phase`, () => {
      const projectDir = createTempGitProject();
      try {
        fs.writeFileSync(
          path.join(projectDir, '.planning', 'config.json'),
          JSON.stringify({ runtime: id }, null, 2),
        );
        const phase = path.join(projectDir, '.planning', 'phases', '01-example');
        fs.mkdirSync(phase, { recursive: true });
        // No *-VERIFICATION.md → the completion gate blocks with reason "missing".

        const res = runGsdTools(['phase', 'complete', '01'], projectDir);
        // The blocked-completion message goes to stderr, which runGsdTools
        // surfaces as `error` (NOT `stderr`) on a clean non-zero exit. Reading
        // the wrong field yields '' and makes every assertion below vacuous.
        const text = `${res.output || ''}${res.error || ''}`;

        assert.equal(res.success, false, 'completion must be blocked with no verification report');
        assert.match(
          text,
          /verification is incomplete/i,
          `expected the blocked-completion error, got: ${text}`,
        );
        // Unconditional — a conditional check here passes when the command is
        // absent entirely, which is exactly how this path stayed untested.
        assert.ok(
          text.includes(`${prefix}execute-phase`),
          `phase complete must suggest ${prefix}execute-phase on ${id}, got: ${text}`,
        );
        assert.ok(
          !text.includes('/gsd:'),
          `phase complete must not surface the deprecated colon form: ${text}`,
        );
      } finally {
        cleanup(projectDir);
      }
    });

    test(`phase complete on ${id} projects the gaps_found command too`, () => {
      // Finding from review: the live-CLI check previously exercised only the
      // `missing` state, so a regression in any other routed branch would show
      // up in the router's return object but not in what a user actually reads.
      const projectDir = createTempGitProject();
      try {
        fs.writeFileSync(
          path.join(projectDir, '.planning', 'config.json'),
          JSON.stringify({ runtime: id }, null, 2),
        );
        const phase = path.join(projectDir, '.planning', 'phases', '01-example');
        fs.mkdirSync(phase, { recursive: true });
        fs.writeFileSync(
          path.join(phase, '01-VERIFICATION.md'),
          '---\nstatus: gaps_found\n---\n\n# Verification\n',
        );

        const res = runGsdTools(['phase', 'complete', '01'], projectDir);
        const text = `${res.output || ''}${res.error || ''}`;

        assert.equal(res.success, false, 'gaps_found must block completion');
        assert.ok(
          text.includes(`${prefix}plan-phase 01 --gaps`),
          `phase complete must suggest ${prefix}plan-phase 01 --gaps on ${id}, got: ${text}`,
        );
        assert.ok(!text.includes('/gsd:'), `deprecated colon form leaked: ${text}`);
      } finally {
        cleanup(projectDir);
      }
    });
  }
});
