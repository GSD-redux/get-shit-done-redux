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
 * 11. Multiple *-VERIFICATION.md files, none matching the phase's own token →
 *     alphabetically-first FALLBACK wins (the phase-pinned rule's #2 tier —
 *     see #3492 below for the primary, phase-pinned tier)
 * 12. ship.md PHASE_VERIFICATION_INCOMPLETE sentinel (contract anchor for #651 consolidation)
 * 13. #3357/#3492: `<phase-token>-VERIFICATION.md` resolution — resolveVerificationFile
 *     unit coverage plus behavioral tests through readVerificationStatus and
 *     findStaleVerificationSummary. THE CONTRACT (#3492): a candidate whose
 *     name exactly matches THIS phase's own token always wins, even over a
 *     different phase's canonically-shaped file; alphabetical-first among all
 *     dashed candidates is only the fallback when no exact match exists. The
 *     resolveVerificationFile unit tests are the reliable anchors for this —
 *     the readVerificationStatus/findStaleVerificationSummary behavioral tests
 *     are illustrative (their outcome also depends on directory-basename
 *     token derivation, not exercised in isolation there).
 *
 * PORTABILITY: pure JS — no shell-outs, no bash fences.
 * Cross-platform (passes on Windows). Ref: DEFECT.TEST-SHELL-PIPELINE-NONPORTABLE.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { cleanup, createTempGitProject } = require('./helpers.cjs');
const { runGit: seamRunGit, OUTCOME } = require('./helpers/process-seam.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');
const { scanFencedBlocks } = require('../gsd-core/bin/lib/markdown-sectionizer.cjs');

const {
  VERIFIER_STATUSES,
  VERIFICATION_ROUTING_TABLE,
  defaultPhaseCleanCommitTimesMs,
  resolveVerificationFile,
  resolveUatFile,
  readVerificationStatus,
  findStaleVerificationSummary,
  computeCoveredDigest,
} = require('../gsd-core/bin/lib/verification.cjs');

// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { GIT_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Create a temporary phase directory named like a real one (`NN-slug`),
 * inside a throwaway parent. #3511: a phase directory's own name determines
 * which files count as ITS artifacts, so a fixture whose basename does not
 * name the same phase as the files written into it is not a valid phase dir.
 * @param {string} suffix       - test-distinguishing suffix for the parent
 * @param {string} phaseDirName - basename of the phase dir (default '01-foo')
 */
function mkPhaseDir(suffix, phaseDirName = '01-foo') {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-651-${suffix}-`));
  const phaseDir = path.join(parent, phaseDirName);
  fs.mkdirSync(phaseDir);
  return phaseDir;
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
      cleanup(path.dirname(dir));
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
    // Deliberately non-numeric dir basename ("human-needed" has no digits at
    // all) — extractPhaseToken has no derivable token, so (a) isPhaseArtifact's
    // fail-safe still includes 01-hn-VERIFICATION.md as this "phase"'s own
    // report, and (b) the next_command number-append check (which requires a
    // PURELY numeric token) never fires. This is what this test is actually
    // pinning — see the comment below — so the dir name must stay non-numeric,
    // not the realistic 'NN-slug' default.
    const dir = mkPhaseDir('human-needed', 'human-needed');
    try {
      writeVerificationMd(dir, '01-hn-VERIFICATION.md', 'human_needed');
      const result = readVerificationStatus(dir);
      assert.equal(result.status, 'human_needed');
      // #2617: human_needed now names the command the next_action describes.
      // This fixture's dir is not phase-shaped, so no number is appended.
      assert.equal(result.next_command, '/gsd-verify-work');
      assert.ok(result.next_action.length > 0);
    } finally {
      cleanup(path.dirname(dir));
    }
  });

  // ── Case 4: no *-VERIFICATION.md → missing ────────────────────────────────
  test('no *-VERIFICATION.md file → status missing, next_command execute-phase', () => {
    // Non-numeric dir basename: next_command asserts no phase-number argument
    // is appended, which requires extractPhaseToken(dirName) to not be purely
    // numeric — see the human_needed test above for the same rationale.
    const dir = mkPhaseDir('missing', 'missing');
    try {
      // write a non-matching file to confirm it is ignored
      fs.writeFileSync(path.join(dir, 'README.md'), '# phase');
      const result = readVerificationStatus(dir);
      assert.equal(result.status, 'missing');
      assert.equal(result.next_command, '/gsd-execute-phase');
      assert.ok(result.next_action.includes('verify step never completed'));
      assert.ok(
        result.next_action.includes('does not re-run plans that already have a SUMMARY.md'),
        `next_action must reassure the user execute-phase will not redo work (#1762); got: ${result.next_action}`,
      );
    } finally {
      cleanup(path.dirname(dir));
    }
  });

  // ── Case 5: unknown frontmatter status value ──────────────────────────────
  test("frontmatter status 'bogus' → status unknown, next_command execute-phase", () => {
    // Non-numeric dir basename: next_command asserts no phase-number argument
    // is appended — see the human_needed test above for the same rationale.
    const dir = mkPhaseDir('unknown', 'unknown');
    try {
      writeVerificationMd(dir, '01-u-VERIFICATION.md', 'bogus');
      const result = readVerificationStatus(dir);
      assert.equal(result.status, 'unknown');
      assert.equal(result.next_command, '/gsd-execute-phase');
      assert.ok(
        result.next_action.includes('bogus'),
        `next_action should mention the raw value; got: ${result.next_action}`,
      );
      assert.ok(
        result.next_action.includes('intentional non-standard marker'),
        `next_action must acknowledge an unrecognized status may be an intentional marker (#1762); got: ${result.next_action}`,
      );
    } finally {
      cleanup(path.dirname(dir));
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
      cleanup(path.dirname(dir));
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
      cleanup(path.dirname(dir));
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
      cleanup(path.dirname(dir));
    }
  });

  // Missing / nonexistent phase directory → missing
  test('nonexistent phase directory → missing', () => {
    const nonexistent = path.join(os.tmpdir(), 'gsd-651-nonexistent-' + Date.now());
    const result = readVerificationStatus(nonexistent);
    assert.equal(result.status, 'missing', 'unreadable/nonexistent dir must return missing');
    assert.equal(result.next_command, '/gsd-execute-phase');
  });

  // Multiple *-VERIFICATION.md files, NEITHER matching the phase dir's own
  // token → deterministic FALLBACK pick (first by sort). This is the #2 tier
  // of the #3492 phase-pinned rule, not the contract itself — see the
  // `#3357/#3492` describe block below for the primary, phase-pinned tier
  // (resolveVerificationFile unit tests are the reliable anchors there).
  // The dir basename ('multi', no digits) has no derivable phase token, so
  // scopeToPhase's isPhaseArtifact fail-safe passes BOTH candidates through
  // unfiltered (#3511: scopeToPhase is a plain filter with no other
  // fallback — a derivable token that matched neither file would empty the
  // set and this test would read 'missing', not exercise the alphabetical
  // tiebreak at all).
  test('multiple *-VERIFICATION.md files, none matching the phase token → alphabetically-first FALLBACK wins', () => {
    const dir = mkPhaseDir('multi', 'multi');
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
        'With no exact phase-token match, the first by lexicographic sort must be used',
      );
    } finally {
      cleanup(path.dirname(dir));
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
    // Soft probe — a missing/broken git binary must resolve to `false`, not
    // throw, so seamRunGit is used directly rather than gitOrThrow.
    const r = seamRunGit(['--version'], { timeoutMs: GIT_TIMEOUT_MS });
    return r.outcome === OUTCOME.EXITED && r.exitCode === 0;
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
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2348-realgit-'));
      const runGit = (args, extraEnv) =>
        gitOrThrow(args, {
          cwd: repo,
          timeoutMs: GIT_TIMEOUT_MS,
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
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2348-realgit-dirty-'));
      const runGit = (args, extraEnv) =>
        gitOrThrow(args, {
          cwd: repo,
          timeoutMs: GIT_TIMEOUT_MS,
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

// ─── #3357/#3492: phase-pinned *-VERIFICATION.md resolution ──────────────────
//
// A phase dir can legitimately hold more than one `*-VERIFICATION.md` — the
// real per-phase report (`03-VERIFICATION.md`) alongside an ad-hoc plan
// worksheet (`03-CORRECTION-VERIFICATION.md`). The original "alphabetically
// first" pick chose the worksheet ('C' < 'V'), and a worksheet with no
// frontmatter `status:` made the whole phase read `missing` even though a
// passing report sat right next to it (#3357).
//
// #3492 REGRESSION this block anchors: the #3357 fix's first cut preferred
// ANY canonically-shaped `<token>-VERIFICATION.md`, regardless of WHOSE token
// it carried — so a stray cross-phase or sentinel-numbered canonical file
// (`999-VERIFICATION.md`) could outrank the querying phase's own (possibly
// non-canonical) report. THE CONTRACT (verified against the built lib):
//   ['12-review-VERIFICATION.md', '999-VERIFICATION.md'] resolves to
//     '12-review-VERIFICATION.md' for phase token '12' (was '999-…').
//   ['03-CORRECTION-VERIFICATION.md', '04-VERIFICATION.md'] resolves to
//     '04-VERIFICATION.md' for phase token '04' (was '03-CORRECTION-…').
// resolveVerificationFile is the single resolver findStaleVerificationSummary,
// readVerificationStatus, commands.cts's determinePhaseStatus, and both
// init.cts verification_path projectors all call, every one pinned to its own
// phaseDir's token (#3473 F2 / #3492).
//
// These resolveVerificationFile unit tests are the RELIABLE ANCHORS for the
// phase-pinned rule (a real `phaseToken` string, no filesystem/readdir order
// involved). The readVerificationStatus/findStaleVerificationSummary
// behavioral tests further down are illustrative only — their outcome
// additionally depends on the temp directory's basename tokenizing the way
// the test expects.
describe('#3357/#3492: phase-pinned *-VERIFICATION.md resolution when multiple candidates exist', () => {

  test('#3492 regression counterexample 1: a sentinel-numbered stray file does not outrank this phase\'s own non-canonical report', () => {
    assert.equal(
      resolveVerificationFile(
        ['12-review-VERIFICATION.md', '999-VERIFICATION.md'],
        { phaseToken: '12-review' },
      ),
      '12-review-VERIFICATION.md',
      'this phase (token "12-review") owns 12-review-VERIFICATION.md; 999-VERIFICATION.md is a different phase and must not win',
    );
  });

  test('#3492 regression counterexample 2: a cross-phase CORRECTION worksheet does not outrank this phase\'s own canonical report', () => {
    assert.equal(
      resolveVerificationFile(
        ['03-CORRECTION-VERIFICATION.md', '04-VERIFICATION.md'],
        { phaseToken: '04' },
      ),
      '04-VERIFICATION.md',
      'this phase (token "04") owns 04-VERIFICATION.md; the 03-CORRECTION worksheet belongs to a different phase',
    );
  });

  test('exact phase-token match wins over an ad-hoc -CORRECTION- worksheet for the SAME phase', () => {
    assert.equal(
      resolveVerificationFile(
        ['03-CORRECTION-VERIFICATION.md', '03-VERIFICATION.md'],
        { phaseToken: '03' },
      ),
      '03-VERIFICATION.md',
      'the phase\'s own 03-VERIFICATION.md must win over its CORRECTION worksheet, not lose alphabetically',
    );
  });

  test('order-independence: same candidates reversed → same answer', () => {
    assert.equal(
      resolveVerificationFile(
        ['03-VERIFICATION.md', '03-CORRECTION-VERIFICATION.md'],
        { phaseToken: '03' },
      ),
      '03-VERIFICATION.md',
      'input order must not change which file is selected',
    );
  });

  test('decimal phase token: 35.1-VERIFICATION.md wins over a -CORRECTION- sibling', () => {
    assert.equal(
      resolveVerificationFile(
        ['35.1-CORRECTION-VERIFICATION.md', '35.1-VERIFICATION.md'],
        { phaseToken: '35.1' },
      ),
      '35.1-VERIFICATION.md',
    );
  });

  test('letter-suffixed phase token: 03A-VERIFICATION.md wins over a -CORRECTION- sibling', () => {
    assert.equal(
      resolveVerificationFile(
        ['03A-CORRECTION-VERIFICATION.md', '03A-VERIFICATION.md'],
        { phaseToken: '03A' },
      ),
      '03A-VERIFICATION.md',
    );
  });

  test('multi-canonical tiebreak: no exact phase-token match among several canonically-shaped candidates → alphabetically first', () => {
    // Neither candidate's token is "50" — this is the (b) fallback tier, and
    // it must stay a plain alphabetical pick (not a second, separate
    // "canonical-shaped" preference — that concept no longer exists; #3492
    // removed it because it was exactly the regression mechanism above).
    assert.equal(
      resolveVerificationFile(
        ['12-VERIFICATION.md', '999-VERIFICATION.md'],
        { phaseToken: '50' },
      ),
      '12-VERIFICATION.md',
      '"12-VERIFICATION.md" sorts before "999-VERIFICATION.md" and neither matches phase token "50"',
    );
  });

  test('fallback: only a non-canonical file present → that file is still returned', () => {
    // Load-bearing: a phase whose only report is non-canonically named must
    // keep resolving to it, not to null — even when the phase token is known
    // and does not exactly match.
    assert.equal(
      resolveVerificationFile(['01-review-VERIFICATION.md'], { phaseToken: '01' }),
      '01-review-VERIFICATION.md',
    );
  });

  test('fallback determinism: several non-canonical files, no phase token given → alphabetically first (unchanged)', () => {
    assert.equal(
      resolveVerificationFile(['02-b-VERIFICATION.md', '01-a-VERIFICATION.md']),
      '01-a-VERIFICATION.md',
    );
  });

  test('no phaseToken and no exact match → falls back to alphabetically-first, never null, when candidates exist', () => {
    // #3492: an undeliverable/absent phase token must degrade to the original
    // pre-#3357 behavior (alphabetically-first), not to null.
    assert.equal(
      resolveVerificationFile(['999-VERIFICATION.md', '03-CORRECTION-VERIFICATION.md']),
      '03-CORRECTION-VERIFICATION.md',
      'with no phaseToken, plain alphabetical order decides — "03-…" sorts before "999-…"',
    );
  });

  test('no matches → null', () => {
    assert.equal(resolveVerificationFile(['03-PLAN.md', '03-SUMMARY.md'], { phaseToken: '03' }), null);
  });

  test('unrelated files are not miscounted as candidates', () => {
    // 03-PLAN.md / 03-SUMMARY.md never end in "-VERIFICATION.md". A bare
    // "VERIFICATION.md" (no leading phase-token dash) is also never a
    // candidate — it fails the very `.endsWith('-VERIFICATION.md')` filter
    // that builds the candidate list in the first place (the string is one
    // character too short to end with a leading-dash suffix).
    assert.equal(
      resolveVerificationFile(['03-PLAN.md', '03-SUMMARY.md', 'VERIFICATION.md'], { phaseToken: '03' }),
      null,
      'a bare VERIFICATION.md is never a dashed candidate',
    );
  });

  // #3511 reconciliation: resolveVerificationFile's fallback now scopes to
  // isPhaseArtifact(fileName, phaseDirName), so a stray cross-phase file can
  // no longer win the alphabetical-first fallback tier either — closing the
  // gap isPhaseArtifact's own docblock (src/phase-id.cts) used to flag as
  // open. The two pure cases below are the reliable anchors; the behavioral
  // test after them pins the same contract through the real CLI-facing
  // readVerificationStatus call path.
  test('#3511: a cross-phase stray is excluded from the fallback → null, not the stray', () => {
    assert.equal(
      resolveVerificationFile(['04-VERIFICATION.md'], { phaseDirName: '03-foo' }),
      null,
      '04-VERIFICATION.md belongs to phase 04, not the "03-foo" directory\'s phase 03 — must not be returned',
    );
  });

  test('#3511: a non-canonically-named report OF THIS phase still wins the fallback (the #3357 guarantee survives)', () => {
    // The more important of the two #3511 cases: isPhaseArtifact scopes by
    // phase-number membership, not by canonical shape, so this file still
    // passes and the #3357 "non-canonical report still resolves" guarantee
    // is not disturbed by the #3511 scoping.
    assert.equal(
      resolveVerificationFile(['03-CORRECTION-VERIFICATION.md'], { phaseDirName: '03-foo' }),
      '03-CORRECTION-VERIFICATION.md',
      '03-CORRECTION-VERIFICATION.md names phase 03, same as directory "03-foo" — must still resolve',
    );
  });

  test('#3511: cross-phase stray alongside this phase\'s own non-canonical report → own report wins, stray excluded (not merely outsorted)', () => {
    // Distinguishes "excluded from the fallback" from "just happens to sort
    // after" — candidates are sorted at verification.cts's own call site
    // before reaching resolveVerificationFile, and '01-VERIFICATION.md'
    // sorts BEFORE '03-CORRECTION-VERIFICATION.md' alphabetically, so an
    // UNSCOPED (alphabetical-first) fallback would wrongly pick the stray
    // here. Scoping must actively exclude it for '03-CORRECTION-…' to win.
    assert.equal(
      resolveVerificationFile(
        ['01-VERIFICATION.md', '03-CORRECTION-VERIFICATION.md'],
        { phaseDirName: '03-foo' },
      ),
      '03-CORRECTION-VERIFICATION.md',
    );
  });

  // WARNING-2/5/INFO-2 note (#3511 review): the only fallback test above uses
  // a token-LESS dir ("03-foo" isn't token-less — this refers to the earlier
  // `multiple *-VERIFICATION.md files, none matching the phase token` test,
  // which passes no derivable-token distinguishing fixture and so passes
  // identically pre-#3511-fix). This test uses a dir WITH a derivable token
  // (`03-foo` → token "03") and TWO candidates that BOTH belong to that same
  // phase (`03-a-…`/`03-b-…`, no exact `03-VERIFICATION.md`), so scoping
  // excludes nothing and the alphabetical-first tie-break still decides —
  // pinning that scoping does not disturb the ordinary same-phase-multi-file
  // case.
  test('#3511: alphabetical fallback when BOTH candidates are this phase\'s own (derivable token, no exact match)', () => {
    assert.equal(
      resolveVerificationFile(['03-a-VERIFICATION.md', '03-b-VERIFICATION.md'], { phaseDirName: '03-foo' }),
      '03-a-VERIFICATION.md',
      'both candidates belong to phase 03 (same as dir "03-foo"); alphabetically-first must still win',
    );
  });

  test('behavioral (readVerificationStatus): a phase dir holding only a cross-phase stray reports missing, not the stray\'s status (#3511)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3511-stray-only-'));
    const dir = path.join(baseDir, '03-foo');
    fs.mkdirSync(dir);
    try {
      // Only a stray belonging to phase 04 sits in phase 03's directory. Give
      // it a status that would NOT read as missing if it were (wrongly) picked,
      // so a regression here is loud rather than accidentally matching.
      writeVerificationMd(dir, '04-VERIFICATION.md', 'passed');

      const result = readVerificationStatus(dir);
      assert.equal(
        result.status,
        'missing',
        'a phase dir holding only another phase\'s report must report missing, not passed',
      );
    } finally {
      cleanup(baseDir);
    }
  });

  test('behavioral (readVerificationStatus): a phase dir holding only its own non-canonically-named report still resolves it (#3357 guarantee survives #3511 scoping)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3511-own-noncanon-'));
    const dir = path.join(baseDir, '03-foo');
    fs.mkdirSync(dir);
    try {
      writeVerificationMd(dir, '03-CORRECTION-VERIFICATION.md', 'passed');

      const result = readVerificationStatus(dir);
      assert.equal(
        result.status,
        'passed',
        'the phase\'s own non-canonically-named report must still resolve, not read as missing',
      );
    } finally {
      cleanup(baseDir);
    }
  });

  test('behavioral (readVerificationStatus): a phase with both its own report and a cross-phase stray reports the OWN report\'s status, not the stray\'s', () => {
    // The directory basename is "03-canonical-test" so extractPhaseToken
    // derives token "03" — the exact same derivation readVerificationStatus
    // performs internally, so this exercises the real production call path
    // (not just the pure resolver), pinned to counterexample 2's shape.
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3492-parent-'));
    const dir = path.join(baseDir, '03-canonical-test');
    fs.mkdirSync(dir);
    try {
      // A stray cross-phase canonical file with a DIFFERENT status — must not
      // be picked for THIS (token "03") phase.
      writeVerificationMd(dir, '99-VERIFICATION.md', 'gaps_found');
      // This phase's own (non-canonical, ad-hoc) report — must win.
      writeVerificationMd(dir, '03-CORRECTION-VERIFICATION.md', 'passed');

      const result = readVerificationStatus(dir);
      assert.equal(
        result.status,
        'passed',
        'the phase must report its OWN report\'s status, not a cross-phase stray\'s',
      );
    } finally {
      cleanup(baseDir);
    }
  });

  test('behavioral (readVerificationStatus): a phase with both its own canonical report and an ad-hoc worksheet reports the canonical report\'s status, not missing (#3357 original regression)', () => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3357-parent-'));
    const dir = path.join(baseDir, '03-canonical-test');
    fs.mkdirSync(dir);
    try {
      // The ad-hoc worksheet has no frontmatter `status:` at all — this is
      // the exact original #3357 failure mode: 'C' < 'V' picked this file
      // first and the phase read 'missing' despite the passing report sitting
      // right next to it.
      fs.writeFileSync(
        path.join(dir, '03-CORRECTION-VERIFICATION.md'),
        '# Ad-hoc correction worksheet\n\nNo frontmatter status here.\n',
      );
      writeVerificationMd(dir, '03-VERIFICATION.md', 'passed');

      const result = readVerificationStatus(dir);
      assert.equal(
        result.status,
        'passed',
        'the phase must report the canonical report\'s status, not missing',
      );
    } finally {
      cleanup(baseDir);
    }
  });

  test('behavioral (findStaleVerificationSummary): staleness is checked against THIS phase\'s own report, not a cross-phase stray', () => {
    // A stray cross-phase file ("99-VERIFICATION.md") is alphabetically AFTER
    // this phase's own "03-VERIFICATION.md", so this also demonstrates the
    // pin is not merely riding on alphabetical luck.
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3492-stale-parent-'));
    const dir = path.join(baseDir, '03-stale-pin-test');
    fs.mkdirSync(dir);
    try {
      writeVerificationMd(dir, '03-VERIFICATION.md', 'passed');
      writeVerificationMd(dir, '99-VERIFICATION.md', 'passed');
      setMtime(path.join(dir, '03-VERIFICATION.md'), '2020-01-01T00:00:00Z');
      setMtime(path.join(dir, '99-VERIFICATION.md'), '2020-01-01T00:00:00Z');

      // Root-style summary placement (mirrors the #2348 fixtures above) —
      // scanPhasePlans's nested-layout matcher requires `SUMMARY-<NN>...md`
      // inside a `plans/` subdir; a root-named `03-01-SUMMARY.md` dropped into
      // `plans/` matches neither isRootSummaryFile (wrong directory) nor
      // isNestedSummaryFile (wrong filename shape), so summaryFiles reads
      // empty and the phase is never stale — not what this test means to
      // exercise.
      const summaryPath = path.join(dir, '03-01-SUMMARY.md');
      fs.writeFileSync(summaryPath, '# summary\n');
      setMtime(summaryPath, '2021-01-01T00:00:00Z');

      // Force the mtime path (no git clock) by injecting an empty resolver —
      // mirrors the existing #2348 test pattern elsewhere in this file.
      const result = findStaleVerificationSummary(dir, fs, () => new Map());
      assert.equal(result.determined, true);
      assert.equal(result.stale, true, 'the phase\'s own 03-VERIFICATION.md is older than its summary');
      assert.equal(
        result.verificationFile,
        '03-VERIFICATION.md',
        'staleness must be computed against the phase\'s own report, not the cross-phase 99-VERIFICATION.md stray',
      );
    } finally {
      cleanup(baseDir);
    }
  });

});

// ─── #3473 F2: resolveVerificationFile allowBare option ──────────────────────
//
// commands.cts (determinePhaseStatus) and two verification_path projectors in
// init.cts each hand-rolled a fourth variant of this same selection: they
// additionally accept a BARE `VERIFICATION.md`, which this module's own two
// callers (findStaleVerificationSummary, readVerificationStatus) originally
// did not. `allowBare` threads that one behavioral difference through the
// single resolver instead of leaving a fourth hand-rolled implementation
// behind (#3473 F2). A bare match is ranked BELOW any dashed candidate —
// canonical or not — because a dashed file names its phase and a bare one
// does not. Since #4187 the two module-internal call sites pass `allowBare:
// true` as well (see the #4187 describe below), so every reader of the report
// set now agrees; the option's default remains `false` for callers that have
// not opted in.
describe('#3473 F2: resolveVerificationFile allowBare option', () => {

  test('allowBare defaults to false — a bare-only list returns null without the option', () => {
    assert.equal(resolveVerificationFile(['VERIFICATION.md']), null);
  });

  test('allowBare:true, bare-only candidate → bare file returned', () => {
    assert.equal(
      resolveVerificationFile(['VERIFICATION.md'], { allowBare: true }),
      'VERIFICATION.md',
    );
  });

  test('allowBare:true, bare + non-canonical dashed → the dashed fallback wins', () => {
    assert.equal(
      resolveVerificationFile(
        ['VERIFICATION.md', '01-review-VERIFICATION.md'],
        { allowBare: true },
      ),
      '01-review-VERIFICATION.md',
      'a dashed non-canonical file names its phase and must win over a bare match',
    );
  });

  test('allowBare:true, bare + canonical → the canonical file wins', () => {
    assert.equal(
      resolveVerificationFile(
        ['VERIFICATION.md', '03-VERIFICATION.md'],
        { allowBare: true },
      ),
      '03-VERIFICATION.md',
    );
  });

  // #3511: allowBare must still fall through to the bare match when the ONLY
  // dashed candidate is excluded by phaseDirName scoping (a cross-phase
  // stray) — the fallback tier finding nothing phase-owned is the same
  // "no dashed candidate at all" case allowBare was always reached from.
  test('#3511: allowBare:true, bare + a cross-phase dashed stray scoped out by phaseDirName → the bare file wins', () => {
    assert.equal(
      resolveVerificationFile(
        ['VERIFICATION.md', '04-VERIFICATION.md'],
        { allowBare: true, phaseDirName: '03-foo' },
      ),
      'VERIFICATION.md',
      '04-VERIFICATION.md belongs to a different phase and is excluded, so bare VERIFICATION.md is the only remaining candidate',
    );
  });

});

// ─── #4187: a bare VERIFICATION.md is a first-class report on the status surface ──
//
// `query verification.resolve-file` (cmdVerificationResolveFile), the phase-status
// surface (commands.cts determinePhaseStatus) and both init verification_path
// projectors all resolve a BARE `VERIFICATION.md` — but readVerificationStatus
// (the reader behind `query verification.status`, isPhaseComplete, and the state/
// roadmap completion projections) called the same shared resolver WITHOUT
// `allowBare`, so a phase whose only report was bare read as `missing` and was
// told to re-run execute-phase even when the report said `status: passed`.
// Two read-only verbs disagreed about the same directory at the same instant
// (#4187). The fix opts the status reader — and findStaleVerificationSummary,
// its internal legacy staleness check, whose only production caller is
// readVerificationStatus — into the same `allowBare: true` the other four call
// sites already pass. Tier order is unchanged: a dashed candidate (canonical or
// not) still outranks the bare name, so only bare-ONLY directories change
// behavior, from `missing` to the report's actual frontmatter status.
describe('#4187: status surface recognizes a bare VERIFICATION.md', () => {

  test('#4187 regression: bare VERIFICATION.md with status: passed reads as passed, not missing', (t) => {
    const dir = mkPhaseDir('bare-passed', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, 'VERIFICATION.md', 'passed');
    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'passed', 'a bare report is a report — the phase is verified');
    assert.equal(result.next_command, '', 'passed must route to no next command');
    assert.equal(result.staleCheckIndeterminate, undefined, 'the staleness check must run to completion');
  });

  test('#4187: bare report with status: human_needed routes to verify-work', (t) => {
    const dir = mkPhaseDir('bare-human', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, 'VERIFICATION.md', 'human_needed');
    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'human_needed');
    assert.equal(result.next_command, '/gsd-verify-work 99');
  });

  test('#4187: bare report with status: gaps_found routes to plan-phase --gaps', (t) => {
    const dir = mkPhaseDir('bare-gaps', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, 'VERIFICATION.md', 'gaps_found');
    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'gaps_found');
    assert.equal(result.next_command, '/gsd-plan-phase 99 --gaps');
  });

  test('#4187 negative space: no verification file at all still reads missing with the execute-phase recommendation', (t) => {
    const dir = mkPhaseDir('bare-none', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    const result = readVerificationStatus(dir);
    assert.equal(result.status, 'missing', 'a genuinely absent report must stay missing');
    assert.equal(result.next_command, '/gsd-execute-phase 99', 'the missing recommendation is correct here and must not change');
  });

  test('#4187 parity: bare + canonical dashed report — the dashed file wins on the status surface too', (t) => {
    const dir = mkPhaseDir('bare-vs-dashed', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, 'VERIFICATION.md', 'gaps_found');
    writeVerificationMd(dir, '99-VERIFICATION.md', 'passed');
    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'passed', 'a dashed file names its phase and must outrank the bare match');
  });

  test('#4187 parity: bare + cross-phase dashed stray — #3511 scoping falls through to the bare report', (t) => {
    const dir = mkPhaseDir('bare-vs-stray', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, 'VERIFICATION.md', 'passed');
    writeVerificationMd(dir, '04-VERIFICATION.md', 'gaps_found');
    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'passed', 'the stray belongs to phase 04; the bare file is this phase\'s only own report');
  });

  test('#4187 parity: same-dir non-canonical dashed report only — unchanged behavior', (t) => {
    const dir = mkPhaseDir('dashed-noncanon', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, '99-CORRECTION-VERIFICATION.md', 'passed');
    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'passed');
  });

  test('#4187: directory scoping — a bare report in a DIFFERENT directory does not leak into the queried one', (t) => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4187-otherdir-'));
    t.after(() => cleanup(baseDir));
    const queried = path.join(baseDir, '99-probe');
    const neighbor = path.join(baseDir, '98-other');
    fs.mkdirSync(queried);
    fs.mkdirSync(neighbor);
    writeVerificationMd(neighbor, 'VERIFICATION.md', 'passed');

    const result = readVerificationStatus(queried);
    assert.equal(result.status, 'missing', 'the neighbor directory\'s report must not answer for the queried one');
  });

  test('#4187: bare report with no frontmatter block resolves but reads missing', (t) => {
    const dir = mkPhaseDir('bare-no-fm', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    fs.writeFileSync(path.join(dir, 'VERIFICATION.md'), '# Verification\n');
    const result = readVerificationStatus(dir);
    assert.equal(result.status, 'missing', 'a resolved file with no frontmatter status is the pre-existing missing path');
  });

  test('#4187 staleness: a bare report older than its summary reads stale (legacy mtime path)', (t) => {
    const dir = mkPhaseDir('bare-stale', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, 'VERIFICATION.md', 'passed');
    setMtime(path.join(dir, 'VERIFICATION.md'), '2020-01-01T00:00:00Z');
    // Root-style summary placement — mirrors the #3492 fixture above.
    const summaryPath = path.join(dir, '99-01-SUMMARY.md');
    fs.writeFileSync(summaryPath, '# summary\n');
    setMtime(summaryPath, '2021-01-01T00:00:00Z');

    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'stale', 'a bare report must be staleness-checked like a dashed one');
    assert.equal(result.next_command, '/gsd-verify-work 99');
  });

  test('#4187 unit (findStaleVerificationSummary): staleness is computed against the bare report', (t) => {
    const dir = mkPhaseDir('bare-stale-unit', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, 'VERIFICATION.md', 'passed');
    setMtime(path.join(dir, 'VERIFICATION.md'), '2020-01-01T00:00:00Z');
    const summaryPath = path.join(dir, '99-01-SUMMARY.md');
    fs.writeFileSync(summaryPath, '# summary\n');
    setMtime(summaryPath, '2021-01-01T00:00:00Z');

    const result = findStaleVerificationSummary(dir, fs, () => new Map());
    assert.equal(result.determined, true);
    assert.equal(result.stale, true);
    assert.equal(result.verificationFile, 'VERIFICATION.md', 'the staleness seam must see the bare report');
  });
});

// ─── #4187 CLI parity: the two query verbs must agree on the same directory ───
//
// The issue's repro shape: run `query verification.resolve-file` and
// `query verification.status` back to back against ONE fixture directory and
// assert they never disagree about whether a report exists (and, when one does,
// about WHICH file is the report — enforced by giving the candidates distinct
// frontmatter statuses and asserting the routed status matches the expected
// winner).
describe('#4187 CLI parity: verification.resolve-file and verification.status agree', () => {
  const { runGsdTools } = require('./helpers.cjs');

  function runBothVerbs(dir) {
    const resolveRes = runGsdTools(['query', 'verification.resolve-file', dir, '--raw'], dir);
    const statusRes = runGsdTools(['query', 'verification.status', dir, '--raw'], dir);
    assert.equal(resolveRes.success, true, `resolve-file failed: ${resolveRes.error}`);
    assert.equal(statusRes.success, true, `status failed: ${statusRes.error}`);
    return { resolvedPath: resolveRes.output.trimEnd(), status: JSON.parse(statusRes.output).status, nextCommand: JSON.parse(statusRes.output).next_command };
  }

  test('bare report: resolve-file finds it and status reads passed (the #4187 repro)', (t) => {
    const dir = mkPhaseDir('cli-bare', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, 'VERIFICATION.md', 'passed');
    const { resolvedPath, status, nextCommand } = runBothVerbs(dir);
    assert.equal(resolvedPath, path.join(dir, 'VERIFICATION.md'));
    assert.equal(status, 'passed', 'status must not report missing for a file resolve-file resolves');
    assert.equal(nextCommand, '');
  });

  test('no report: resolve-file is empty and status is missing (agreement in the other direction)', (t) => {
    const dir = mkPhaseDir('cli-none', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    const { resolvedPath, status } = runBothVerbs(dir);
    assert.equal(resolvedPath, '', 'resolve-file must report no file');
    assert.equal(status, 'missing');
  });

  test('bare + canonical dashed: both verbs pick the dashed file', (t) => {
    const dir = mkPhaseDir('cli-both', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, 'VERIFICATION.md', 'gaps_found');
    writeVerificationMd(dir, '99-VERIFICATION.md', 'passed');
    const { resolvedPath, status } = runBothVerbs(dir);
    assert.equal(resolvedPath, path.join(dir, '99-VERIFICATION.md'));
    assert.equal(status, 'passed', 'status must read the same winner resolve-file picked');
  });

  test('bare + cross-phase stray: both verbs pick the bare file', (t) => {
    const dir = mkPhaseDir('cli-stray', '99-probe');
    t.after(() => cleanup(path.dirname(dir)));

    writeVerificationMd(dir, 'VERIFICATION.md', 'passed');
    writeVerificationMd(dir, '04-VERIFICATION.md', 'gaps_found');
    const { resolvedPath, status } = runBothVerbs(dir);
    assert.equal(resolvedPath, path.join(dir, 'VERIFICATION.md'));
    assert.equal(status, 'passed', 'status must read the same winner resolve-file picked');
  });
});

// ─── #3518: resolveUatFile — phase-pinned, deterministic *-UAT.md pick ───────
//
// Both uat_path projectors in src/init.cts picked the phase's UAT artifact
// with a bare `.find((f) => f.endsWith('-UAT.md') || f === 'UAT.md')` over an
// unsorted readdir listing: no phase-membership check, no ordering. A stray
// cross-phase 04-UAT.md in phase 03's directory could become phase 03's
// uat_path, and WHICH file won was filesystem-dependent (creation order on
// APFS, hash order on ext4/XFS) — two machines on the same commit could emit
// different uat_path values for the same phase (#3518).
//
// resolveUatFile is the UAT counterpart of resolveVerificationFile, sharing
// the identical selection rule via the resolvePhaseArtifactFile core: the
// phase's own <token>-UAT.md always wins; otherwise alphabetically-first
// dashed candidate (deterministic on every filesystem); a bare UAT.md only
// when allowBare is set and no dashed candidate exists at all.
//
// These unit tests are the RELIABLE ANCHORS for the rule (a real phaseToken
// string, no readdir order involved). The end-to-end red/green repro for the
// two init.cts projector call sites lives in tests/init.test.cjs (#3518).
describe('#3518: resolveUatFile — phase-pinned *-UAT.md resolution', () => {

  test('#3518 regression: a stray cross-phase -UAT.md does not outrank this phase\'s own UAT file', () => {
    assert.equal(
      resolveUatFile(
        ['04-UAT.md', '03-UAT.md'],
        { phaseToken: '03' },
      ),
      '03-UAT.md',
      'this phase (token "03") owns 03-UAT.md; the stray 04-UAT.md belongs to a different phase',
    );
  });

  test('order-independence: same candidates reversed → same answer', () => {
    assert.equal(
      resolveUatFile(
        ['03-UAT.md', '04-UAT.md'],
        { phaseToken: '03' },
      ),
      '03-UAT.md',
      'input order must not change which file is selected',
    );
  });

  test('fallback: only a stray cross-phase file present → still returned, never null', () => {
    // Load-bearing: a phase whose only UAT artifact is not its own
    // canonically-named file must keep resolving to SOMETHING, not to null —
    // deterministically (alphabetically-first) rather than by readdir order.
    assert.equal(
      resolveUatFile(['04-UAT.md', '02-UAT.md'], { phaseToken: '03' }),
      '02-UAT.md',
      '"02-UAT.md" sorts before "04-UAT.md" — deterministic even when the phase\'s own file is absent',
    );
  });

  test('fallback determinism: several candidates, no phase token given → alphabetically first', () => {
    assert.equal(resolveUatFile(['02-UAT.md', '01-a-UAT.md']), '01-a-UAT.md');
  });

  test('allowBare defaults to false — a bare-only list returns null without the option', () => {
    assert.equal(resolveUatFile(['UAT.md']), null);
  });

  test('allowBare:true, bare + dashed → the dashed candidate wins', () => {
    assert.equal(
      resolveUatFile(['UAT.md', '03-UAT.md'], { allowBare: true, phaseToken: '03' }),
      '03-UAT.md',
      'a dashed file names its phase and must win over a bare match',
    );
  });

  test('allowBare:true, bare-only candidate → bare file returned', () => {
    assert.equal(resolveUatFile(['UAT.md'], { allowBare: true }), 'UAT.md');
  });

  test('no matches → null', () => {
    assert.equal(resolveUatFile(['03-PLAN.md', '03-SUMMARY.md'], { phaseToken: '03' }), null);
  });
});

// ─── #3518: call-site guard — no hand-rolled *-UAT.md single-pick survives ────
//
// The "Partial Fix Across Call Sites" regression class: a future contributor
// adding a NEW uat_path-style projection (or reverting one of the two fixed
// init.cts sites) would hand-roll `.find((f) => f.endsWith('-UAT.md') ||
// f === 'UAT.md')` again — reintroducing the readdir-order,
// no-phase-check pick #3518 closed. This scans src/ for that literal shape
// and fails on any site outside src/verification.cts, whose
// resolvePhaseArtifactFile core is the single owner of the pattern.
// (src/commands.cts's scaffold WRITER builds `${padded}-UAT.md` directly —
// a canonical-name construction, not a discovery pick — and does not match.)
describe('#3518: call-site guard — every *-UAT.md single-pick routes through resolveUatFile', () => {

  test('no hand-rolled -UAT.md discovery pick exists outside src/verification.cts', () => {
    const srcDir = path.join(__dirname, '..', 'src');
    const owner = path.join(srcDir, 'verification.cts');
    // The two shapes the pre-#3518 bug appeared as: an endsWith('-UAT.md')
    // predicate, or a bare `=== 'UAT.md'` equality, anywhere in src/.
    const HAND_ROLLED_RE = /endsWith\(['"`]-UAT\.md['"`]\)|===\s*['"`]UAT\.md['"`]/;
    const offenders = [];
    for (const file of fs.readdirSync(srcDir)) {
      if (!file.endsWith('.cts')) continue;
      const fullPath = path.join(srcDir, file);
      if (fullPath === owner) continue;
      // CRLF-tolerant split (local/no-crlf-fragile-split): Windows
      // git-autocrlf checkouts yield \r\n line endings.
      const lines = fs.readFileSync(fullPath, 'utf-8').split(/\r?\n/);
      lines.forEach((line, i) => {
        if (HAND_ROLLED_RE.test(line)) offenders.push(`src/${file}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepStrictEqual(
      offenders,
      [],
      'hand-rolled *-UAT.md single-pick(s) — route through resolveUatFile '
        + '(src/verification.cts, issue #3518):\n'
        + offenders.join('\n'),
    );
  });
});

// ─── #3057 B3: findStaleVerificationSummary — indeterminate vs not-stale ─────
//
// The pre-fix catch-all returned `null` on ANY fs / scanPhasePlans / clock
// failure — identical to a completed check that genuinely found nothing
// stale. `opts.fs` had never been exercised by any test. These two tests
// confirm (a) the `opts.fs` injection seam actually works, and (b) the two
// outcomes are now distinguishable via `staleCheckIndeterminate` on the
// `readVerificationStatus` result.

describe('#3057 B3: staleness check — indeterminate is distinguishable from not-stale', () => {
  test('an fs failure inside the staleness check yields staleCheckIndeterminate:true, not a silent "not stale"', (t) => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3057-b3-fault-'));
    t.after(() => cleanup(baseDir));
    const dir = path.join(baseDir, '01-stale-check-fault');
    fs.mkdirSync(dir);

    const verificationPath = path.join(dir, '01-VERIFICATION.md');
    const summaryPath = path.join(dir, '01-01-SUMMARY.md');
    writeVerificationMd(dir, '01-VERIFICATION.md', 'passed');
    fs.writeFileSync(summaryPath, '# Summary');
    // The summary IS newer — if the check ran to completion it would find
    // 'stale'. The point of this test is that it never gets to find out.
    setMtime(verificationPath, '2026-01-01T00:00:00.000Z');
    setMtime(summaryPath, '2026-01-01T00:01:00.000Z');

    // Confirms opts.fs is actually threaded through: readdirSync/readFileSync
    // delegate to the real fs (so "find the VERIFICATION.md" / "read its
    // frontmatter" upstream of the staleness check still succeed normally),
    // and ONLY statSync is faulted — driving findStaleVerificationSummary's
    // catch branch specifically, via the injected seam, not a global monkeypatch.
    const fsLike = {
      readdirSync: (d) => fs.readdirSync(d),
      readFileSync: (p, enc) => fs.readFileSync(p, enc),
      statSync: () => { throw new Error('injected stat failure (#3057 B3)'); },
    };

    const result = readVerificationStatus(dir, {
      fs: fsLike,
      phaseCleanCommitTimesMs: () => new Map(),
    });

    // Pre-existing no-throw fail-open contract is UNCHANGED: routing still
    // proceeds as if nothing were stale (status stays 'passed', not 'stale' —
    // a genuinely-stale summary sits right there and would have tripped the
    // 'stale' route had the check run to completion).
    assert.equal(result.status, 'passed');
    // But the cause is no longer silently identical to a completed "nothing
    // is stale" check — this MUST be flagged as indeterminate.
    assert.strictEqual(result.staleCheckIndeterminate, true);
  });

  test('a completed staleness check that finds nothing stale never reports indeterminate', (t) => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3057-b3-ok-'));
    t.after(() => cleanup(baseDir));
    const dir = path.join(baseDir, '01-stale-check-ok');
    fs.mkdirSync(dir);

    const verificationPath = path.join(dir, '01-VERIFICATION.md');
    const summaryPath = path.join(dir, '01-01-SUMMARY.md');
    writeVerificationMd(dir, '01-VERIFICATION.md', 'passed');
    fs.writeFileSync(summaryPath, '# Summary');
    // Verification NEWER than the summary → the check runs to completion
    // (no fault injected) and genuinely finds nothing stale.
    setMtime(summaryPath, '2026-01-01T00:00:00.000Z');
    setMtime(verificationPath, '2026-01-01T00:01:00.000Z');

    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });

    assert.equal(result.status, 'passed');
    assert.strictEqual(
      result.staleCheckIndeterminate,
      undefined,
      'a completed check that found nothing stale must not be flagged indeterminate',
    );
  });
});

// ─── #4155: covered-input fingerprint ─────────────────────────────────────────
//
// A VERIFICATION.md that declares `covered_files` + `covered_digest` in its
// frontmatter is checked by RECOMPUTING that digest over current file content
// — this REPLACES the legacy SUMMARY-mtime check for that report (not merely
// supplements it). A report with no fingerprint metadata keeps the exact
// legacy mtime behavior (already covered above).

describe('#4155: computeCoveredDigest — direct unit coverage', () => {
  test('same covered set, different array order → identical digest (order-independent)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-order-'));
    t.after(() => cleanup(root));
    fs.writeFileSync(path.join(root, 'a.txt'), 'A');
    fs.writeFileSync(path.join(root, 'b.txt'), 'B');

    const d1 = computeCoveredDigest(root, ['a.txt', 'b.txt']);
    const d2 = computeCoveredDigest(root, ['b.txt', 'a.txt']);
    assert.equal(d1, d2);
    assert.match(d1, /^v1:sha256:[0-9a-f]{64}$/);
  });

  test('a "./"-prefixed path and its bare equivalent → identical digest (canonicalized, not double-counted)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-dotslash-'));
    t.after(() => cleanup(root));
    fs.writeFileSync(path.join(root, 'impl.txt'), 'content');

    const bare = computeCoveredDigest(root, ['impl.txt']);
    const dotSlash = computeCoveredDigest(root, ['./impl.txt']);
    assert.equal(dotSlash, bare, '"./impl.txt" must canonicalize to the same key as "impl.txt"');

    // Both spellings together must not double-hash the same file into the digest.
    const combined = computeCoveredDigest(root, ['impl.txt', './impl.txt']);
    assert.equal(combined, bare);
  });

  test('an internal ".." segment disguising an escape (not just a leading one) → null (fail closed)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-internal-dotdot-'));
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, 'a'));
    fs.writeFileSync(path.join(path.dirname(root), 'outside.txt'), 'secret');
    // 'a/../../outside.txt' does not start with '../' as written, but
    // normalizes to '../outside.txt' — an escape a purely-prefix check misses.
    assert.equal(computeCoveredDigest(root, ['a/../../outside.txt']), null);
  });

  test('a covered file whose content changes → digest changes', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-changed-'));
    t.after(() => cleanup(root));
    const target = path.join(root, 'impl.txt');
    fs.writeFileSync(target, 'before');
    const before = computeCoveredDigest(root, ['impl.txt']);
    fs.writeFileSync(target, 'after');
    const after = computeCoveredDigest(root, ['impl.txt']);
    assert.notEqual(before, after);
  });

  test('a covered file that is missing → null (fail closed)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-missing-'));
    t.after(() => cleanup(root));
    assert.equal(computeCoveredDigest(root, ['does-not-exist.txt']), null);
  });

  test('a covered file that is unreadable (directory, not a regular file) → null (fail closed)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-unreadable-'));
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, 'a-directory'));
    assert.equal(computeCoveredDigest(root, ['a-directory']), null);
  });

  test('a covered path that escapes the project root via ".." → null (fail closed)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-escape-'));
    t.after(() => cleanup(root));
    fs.writeFileSync(path.join(path.dirname(root), 'outside.txt'), 'secret');
    assert.equal(computeCoveredDigest(root, ['../outside.txt']), null);
  });

  test('an absolute covered path → null (fail closed)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-absolute-'));
    t.after(() => cleanup(root));
    const absolute = path.join(root, 'impl.txt');
    fs.writeFileSync(absolute, 'x');
    assert.equal(computeCoveredDigest(root, [absolute]), null);
  });

  test('an empty covered-files array → null', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-empty-'));
    t.after(() => cleanup(root));
    assert.equal(computeCoveredDigest(root, []), null);
  });

  test('an in-root symlink whose TARGET escapes the project root → null (fail closed, not the target\'s content)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-symlink-'));
    t.after(() => cleanup(root));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-symlink-outside-'));
    t.after(() => cleanup(outside));
    const outsideFile = path.join(outside, 'secret.txt');
    fs.writeFileSync(outsideFile, 'not covered by this project');
    const linkPath = path.join(root, 'impl.txt');
    fs.symlinkSync(outsideFile, linkPath);

    assert.equal(computeCoveredDigest(root, ['impl.txt']), null);
  });

});

describe('#4155: readVerificationStatus — fingerprint supersedes legacy mtime staleness', () => {
  test('a covered implementation file OUTSIDE .planning/, read through a .planning/-confined opts.fs (src/planning-inspect.cts\'s exact seam) → status stays passed, not stale', () => {
    // #4155 review finding (blocking): src/planning-inspect.cts:1253 injects
    // containmentEnforcingVerificationFs(paths.planning) — confined to
    // `.planning/` — as `opts.fs`. Before the fix, computeCoveredDigest routed
    // every per-file read through that SAME injected fsImpl, so any covered
    // implementation file (which the issue mandates live under `src/`, outside
    // `.planning/`) made the confinement wrapper throw, which computeCoveredDigest
    // caught and turned into `null`, which readVerificationStatus routed to
    // `stale` — permanently, regardless of whether anything actually changed.
    // This reproduces that exact call shape with a real nested .planning/
    // project (findProjectRoot must resolve past the phase dir to the real
    // root) and a confinement fs scoped ONLY to .planning/, mirroring
    // planning-inspect.cts's containmentEnforcingVerificationFs byte-for-byte.
    const projectDir = createTempGitProject();
    try {
      const planningRoot = path.join(projectDir, '.planning');
      const phaseDir = path.join(planningRoot, 'phases', '01-example');
      fs.mkdirSync(phaseDir, { recursive: true });
      const implPath = path.join(projectDir, 'src', 'impl.ts');
      fs.mkdirSync(path.dirname(implPath), { recursive: true });
      fs.writeFileSync(implPath, 'export const x = 1;\n');

      const digest = computeCoveredDigest(projectDir, ['src/impl.ts']);
      fs.writeFileSync(
        path.join(phaseDir, '01-VERIFICATION.md'),
        `---\nstatus: passed\ncovered_files:\n  - src/impl.ts\ncovered_digest: "${digest}"\n---\n`,
      );

      // A naive lexical-prefix check (no realpath resolution) is a stricter
      // stand-in for src/planning-inspect.cts's real containmentEnforcingVerificationFs
      // here: it throws on strictly MORE paths than the real one (it can't
      // tell a legitimate in-root path from a symlink, so it rejects both),
      // which makes this test fail harder, not weaker, if the fix regresses.
      function assertContained(target) {
        if (!path.resolve(target).startsWith(planningRoot + path.sep)) {
          throw new Error(`planning-inspect: path escapes planning root: ${target}`);
        }
      }
      const containmentEnforcingVerificationFs = {
        readdirSync: (dir) => {
          assertContained(dir);
          return fs.readdirSync(dir);
        },
        readFileSync: (filePath, encoding) => {
          assertContained(filePath);
          return fs.readFileSync(filePath, encoding);
        },
        statSync: (filePath) => {
          assertContained(filePath);
          return fs.statSync(filePath);
        },
      };

      const result = readVerificationStatus(phaseDir, {
        fs: containmentEnforcingVerificationFs,
        phaseCleanCommitTimesMs: () => new Map(),
      });
      assert.equal(result.status, 'passed');
    } finally {
      cleanup(projectDir);
    }
  });

  test('unchanged covered inputs → status stays passed even though a SUMMARY is newer (legacy mtime check bypassed)', (t) => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-unchanged-'));
    t.after(() => cleanup(baseDir));
    const dir = path.join(baseDir, '01-foo');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'impl.txt'), 'implementation content');
    const summaryPath = path.join(dir, '01-01-SUMMARY.md');
    fs.writeFileSync(summaryPath, '# Summary');
    // The SUMMARY is a covered artifact too — isolates this test to the mtime
    // vs. content-digest distinction, not the #4155 completeness check below.
    const digest = computeCoveredDigest(dir, ['impl.txt', '01-01-SUMMARY.md']);

    fs.writeFileSync(
      path.join(dir, '01-VERIFICATION.md'),
      `---\nstatus: passed\ncovered_files:\n  - impl.txt\n  - 01-01-SUMMARY.md\ncovered_digest: "${digest}"\n---\n`,
    );
    // SUMMARY newer than VERIFICATION — the LEGACY check would call this
    // stale. The fingerprint check must be the one that actually runs.
    setMtime(path.join(dir, '01-VERIFICATION.md'), '2026-01-01T00:00:00.000Z');
    setMtime(summaryPath, '2026-01-01T00:01:00.000Z');

    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'passed');
  });

  test('a plan or summary added to the phase dir after verification, never declared in covered_files → stale (#4155 completeness check)', (t) => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-uncovered-artifact-'));
    t.after(() => cleanup(baseDir));
    const dir = path.join(baseDir, '01-foo');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'impl.txt'), 'content');
    const digest = computeCoveredDigest(dir, ['impl.txt']);
    fs.writeFileSync(
      path.join(dir, '01-VERIFICATION.md'),
      `---\nstatus: passed\ncovered_files:\n  - impl.txt\ncovered_digest: "${digest}"\n---\n`,
    );
    // A SUMMARY appears after verification — never declared, so the recomputed
    // digest over the ORIGINAL covered set still matches. Only the live
    // directory re-scan can catch this.
    fs.writeFileSync(path.join(dir, '01-01-SUMMARY.md'), '# Summary\n');

    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'stale');
  });

  test('an unreadable nested plans/ dir fails CLOSED to stale, not open to passed (#4155 review finding: allCurrentArtifactsCovered must branch on scanPhasePlans scope, not a try/catch it never throws into)', (t) => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-scan-unreadable-'));
    t.after(() => cleanup(baseDir));
    const dir = path.join(baseDir, '01-foo');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'impl.txt'), 'content');
    const digest = computeCoveredDigest(dir, ['impl.txt']);
    fs.writeFileSync(
      path.join(dir, '01-VERIFICATION.md'),
      `---\nstatus: passed\ncovered_files:\n  - impl.txt\ncovered_digest: "${digest}"\n---\n`,
    );
    const nestedDir = path.join(dir, 'plans');
    fs.mkdirSync(nestedDir);
    fs.writeFileSync(path.join(nestedDir, '01-02-PLAN.md'), '# Nested plan, never declared\n');

    // fs.chmodSync(nestedDir, 0o000) is NOT used: this suite may run as root
    // (CI/Docker), where mode bits are bypassed entirely, making the test
    // pass with zero real coverage. A monkeypatch is CONTRIBUTING.md's
    // documented fault-injection convention for exactly this reason (mirrors
    // tests/broken-windows.test.cjs's writeLedgerAtomic pre-image test). The
    // compiled src/plan-scan.cjs calls `node_fs_1.readdirSync(nestedDir)` — a
    // property read on the SAME node:fs module object `fs` here resolves to
    // (module caching), so patching that property is visible to it.
    const originalReaddirSync = fs.readdirSync;
    fs.readdirSync = (target, ...rest) => {
      if (path.resolve(target) === path.resolve(nestedDir)) {
        throw Object.assign(new Error('EACCES: permission denied (simulated)'), { code: 'EACCES' });
      }
      return originalReaddirSync(target, ...rest);
    };
    try {
      // Guard: the digest alone must NOT already be stale — isolates this
      // test to the scan-failure branch, not a digest mismatch.
      const unpatchedScan = originalReaddirSync(dir);
      assert.ok(unpatchedScan.includes('plans'), 'guard: nested plans/ dir must exist on disk');

      const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
      assert.equal(
        result.status,
        'stale',
        'an unreadable plans/ dir must fail CLOSED — its invisible contents (an undeclared plan) can never be proven covered',
      );
    } finally {
      fs.readdirSync = originalReaddirSync;
    }
  });

  test('a covered file that changed after verification → status is stale', (t) => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-stale-changed-'));
    t.after(() => cleanup(baseDir));
    const dir = path.join(baseDir, '01-foo');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'impl.txt'), 'original content');
    const digest = computeCoveredDigest(dir, ['impl.txt']);
    fs.writeFileSync(
      path.join(dir, '01-VERIFICATION.md'),
      `---\nstatus: passed\ncovered_files:\n  - impl.txt\ncovered_digest: "${digest}"\n---\n`,
    );
    // Evidence drifts after verification — no SUMMARY touched at all, so the
    // legacy mtime check would see nothing stale.
    fs.writeFileSync(path.join(dir, 'impl.txt'), 'drifted content');

    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'stale');
    assert.equal(result.next_command, '/gsd-verify-work 01');
  });

  // Ponytail #4155 review finding: "disappeared" and "escapes confinement"
  // integration tests previously here re-proved computeCoveredDigest → null
  // through the identical `recomputed !== coveredDigestVal` stale branch the
  // "changed" test above already wires — the null-producing mechanisms
  // themselves are unit-tested directly in the computeCoveredDigest describe
  // block ("a covered file that is missing", "a covered path that escapes
  // the project root via ..").

  // Ponytail #4155 review finding: these three were near-identical
  // fixture-copies of the same `hasWellFormedFingerprint === false` branch —
  // an incomplete/malformed `covered_files`+`covered_digest` pair fails
  // closed to `stale` rather than silently downgrading to the legacy check.
  for (const [name, frontmatter] of [
    [
      'covered_files present but covered_digest missing (incomplete pair)',
      '---\nstatus: passed\ncovered_files:\n  - impl.txt\n---\n',
    ],
    [
      'covered_digest present but covered_files missing (incomplete pair)',
      '---\nstatus: passed\ncovered_digest: "v1:sha256:deadbeef"\n---\n',
    ],
    [
      'an empty covered_files array with covered_digest present',
      '---\nstatus: passed\ncovered_files: []\ncovered_digest: "v1:sha256:deadbeef"\n---\n',
    ],
  ]) {
    test(`${name} → stale (fail closed, not a silent legacy downgrade)`, (t) => {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-malformed-fingerprint-'));
      t.after(() => cleanup(baseDir));
      const dir = path.join(baseDir, '01-foo');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, '01-VERIFICATION.md'), frontmatter);

      const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
      assert.equal(result.status, 'stale');
    });
  }

  test('a legacy report with no fingerprint metadata still uses the mtime check', (t) => {
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-4155-legacy-'));
    t.after(() => cleanup(baseDir));
    const dir = path.join(baseDir, '01-foo');
    fs.mkdirSync(dir);
    const verificationPath = path.join(dir, '01-VERIFICATION.md');
    const summaryPath = path.join(dir, '01-01-SUMMARY.md');
    writeVerificationMd(dir, '01-VERIFICATION.md', 'passed');
    fs.writeFileSync(summaryPath, '# Summary');
    setMtime(verificationPath, '2026-01-01T00:00:00.000Z');
    setMtime(summaryPath, '2026-01-01T00:01:00.000Z');

    const result = readVerificationStatus(dir, { phaseCleanCommitTimesMs: () => new Map() });
    assert.equal(result.status, 'stale', 'unchanged: legacy mtime staleness must still fire with no covered_digest');
  });
});

describe('#4155: verification.fingerprint CLI', () => {
  const { runGsdTools, createTempGitProject } = require('./helpers.cjs');

  test('emits a covered_digest matching the direct computeCoveredDigest call, sorted covered_files', () => {
    const projectDir = createTempGitProject();
    try {
      const phaseDir = path.join(projectDir, '.planning', 'phases', '01-example');
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
      fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');

      const res = runGsdTools(
        [
          'verification',
          'fingerprint',
          phaseDir,
          '.planning/phases/01-example/01-01-SUMMARY.md',
          '.planning/phases/01-example/01-01-PLAN.md',
        ],
        projectDir,
      );
      assert.equal(res.success, true, `expected success, got: ${res.output}${res.error}`);
      const parsed = JSON.parse(res.output);
      assert.deepEqual(parsed.covered_files, [
        '.planning/phases/01-example/01-01-PLAN.md',
        '.planning/phases/01-example/01-01-SUMMARY.md',
      ]);
      const expected = computeCoveredDigest(projectDir, [
        '.planning/phases/01-example/01-01-PLAN.md',
        '.planning/phases/01-example/01-01-SUMMARY.md',
      ]);
      assert.equal(parsed.covered_digest, expected);
    } finally {
      cleanup(projectDir);
    }
  });

  test('a missing covered file fails the whole command (fail closed, no partial fingerprint)', () => {
    const projectDir = createTempGitProject();
    try {
      const phaseDir = path.join(projectDir, '.planning', 'phases', '01-example');
      fs.mkdirSync(phaseDir, { recursive: true });

      const res = runGsdTools(
        ['verification', 'fingerprint', phaseDir, 'does-not-exist.md'],
        projectDir,
      );
      assert.equal(res.success, false);
    } finally {
      cleanup(projectDir);
    }
  });

  test('end-to-end through a real nested .planning/ project: a project-root-relative src/ file is covered, resolved, and hashed correctly', () => {
    // #4155 review finding: unit fixtures elsewhere in this file put phaseDir
    // directly under an ownerless tmpdir, so findProjectRoot(phaseDir) falls
    // back to phaseDir itself and never exercises real multi-level
    // resolution. This test uses a genuine `.planning/phases/NN-x/` tree
    // under a real project root, and covers an implementation file OUTSIDE
    // `.planning/` entirely — the exact shape a live verifier agent produces.
    const projectDir = createTempGitProject();
    try {
      const phaseDir = path.join(projectDir, '.planning', 'phases', '01-example');
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
      fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
      fs.mkdirSync(path.join(projectDir, 'src'));
      fs.writeFileSync(path.join(projectDir, 'src', 'thing.cts'), 'export const x = 1;\n');

      const coveredFiles = [
        '.planning/phases/01-example/01-01-PLAN.md',
        '.planning/phases/01-example/01-01-SUMMARY.md',
        'src/thing.cts',
      ];
      const fpRes = runGsdTools(['verification', 'fingerprint', phaseDir, ...coveredFiles], projectDir);
      assert.equal(fpRes.success, true, `expected success, got: ${fpRes.output}${fpRes.error}`);
      const { covered_files: sortedCovered, covered_digest: digest } = JSON.parse(fpRes.output);

      fs.writeFileSync(
        path.join(phaseDir, '01-VERIFICATION.md'),
        `---\nstatus: passed\ncovered_files:\n${sortedCovered.map((f) => `  - ${f}`).join('\n')}\ncovered_digest: "${digest}"\n---\n`,
      );

      const passing = readVerificationStatus(phaseDir, { phaseCleanCommitTimesMs: () => new Map() });
      assert.equal(passing.status, 'passed');

      // Now edit the implementation file OUTSIDE .planning/ — must go stale.
      fs.writeFileSync(path.join(projectDir, 'src', 'thing.cts'), 'export const x = 2;\n');
      const afterEdit = readVerificationStatus(phaseDir, { phaseCleanCommitTimesMs: () => new Map() });
      assert.equal(afterEdit.status, 'stale');
    } finally {
      cleanup(projectDir);
    }
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

// ─── #2868: stranded-phase detection via `verification status` ────────────────
//
// execute-phase's `discover_and_group_plans` step resumes at the phase gates
// when every plan is summarized but no *-VERIFICATION.md exists yet. That
// resume decision is driven by `gsd_run query verification status <phaseDir>
// --pick status` reading `missing`. These tests pin the CLI query's behavior
// on the exact fixture shapes the workflow branches on, via the real CLI
// (runGsdTools), not the in-process readVerificationStatus() helper used above.
describe('#2868: verification status CLI drives the execute-phase stranded-phase resume', () => {
  const { runGsdTools, createTempGitProject } = require('./helpers.cjs');

  test('D1: all plans summarized, no *-VERIFICATION.md → status is missing', () => {
    const projectDir = createTempGitProject();
    try {
      const phaseDir = path.join(projectDir, '.planning', 'phases', '01-example');
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
      fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');

      const res = runGsdTools(['verification', 'status', phaseDir, '--pick', 'status'], projectDir);
      assert.equal(res.success, true, `verification status should succeed: ${res.error}`);
      assert.equal(res.output, 'missing', 'no VERIFICATION.md at all → status must be missing');
    } finally {
      cleanup(projectDir);
    }
  });

  test('D2: same fixture plus a passed *-VERIFICATION.md → status is not missing', () => {
    const projectDir = createTempGitProject();
    try {
      const phaseDir = path.join(projectDir, '.planning', 'phases', '01-example');
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
      fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
      fs.writeFileSync(
        path.join(phaseDir, '01-VERIFICATION.md'),
        '---\nstatus: passed\n---\n\n# Verification\n',
      );

      const res = runGsdTools(['verification', 'status', phaseDir, '--pick', 'status'], projectDir);
      assert.equal(res.success, true, `verification status should succeed: ${res.error}`);
      assert.notEqual(res.output, 'missing', 'a passed VERIFICATION.md must not read as missing');
      assert.equal(res.output, 'passed');
    } finally {
      cleanup(projectDir);
    }
  });

  test('D3: one plan lacking a SUMMARY and no verification → still missing (not conflated with "stranded")', () => {
    const projectDir = createTempGitProject();
    try {
      const phaseDir = path.join(projectDir, '.planning', 'phases', '01-example');
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan 1\n');
      fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary 1\n');
      // 01-02 has a PLAN but no SUMMARY — plan work is still outstanding, which is
      // a different condition from the phase being "stranded" (all plans done,
      // verification never ran). The query must not conflate the two.
      fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan 2\n');

      const res = runGsdTools(['verification', 'status', phaseDir, '--pick', 'status'], projectDir);
      assert.equal(res.success, true, `verification status should succeed: ${res.error}`);
      assert.equal(
        res.output,
        'missing',
        'outstanding plan work must not change verification status away from missing',
      );
    } finally {
      cleanup(projectDir);
    }
  });
});

{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:fix-3174-quick-verification-status-read', () => {
  // allow-test-rule: source-text-is-the-product see #3174
  // Workflow .md / agent .md / command .md / reference .md files — their text
  // IS what the runtime loads. Testing text content tests the deployed contract.
  // Per CONTRIBUTING.md exception matrix.
  //
  // #3174: quick's verification step used to read the verifier's result with a
  // raw `grep "^status:" F | cut -d: -f2 | tr -d ' '` and route it through arms
  // passed / human_needed / gaps_found only. That read failed two ways, both
  // measured against the old pipeline: it matched NO arm on a missing report,
  // most off-schema values, a `status:` line in both frontmatter and prose, or
  // (on a CRLF checkout) a valid `passed` arriving as `passed\r`; and it
  // matched the SUCCESS arm when it should not have on a stale `passed`
  // report (staleness was never evaluated), a report whose only `status:` line
  // sits in its prose, or an off-schema value carrying a colon
  // (`passed:bogus`), which `cut -d: -f2` splits at that colon. The unanchored
  // match is the DEFECT.FRONTMATTER-SCALAR-BROAD-GREP class the code side
  // already fixed by name. These tests pin the five properties that keep the
  // replacement honest.
  describe('quick verification status read (#3174)', () => {
  const QUICK_VERIFICATION = path.join(
    __dirname, '..', 'gsd-core', 'workflows', 'quick', 'steps', 'quick-verification.md',
  );
  // The canonical launcher preamble. scripts/sync-runtime-launcher.cjs rewrites
  // every workflow's bootstrap from this file, so THIS is the authority — not
  // whichever sibling step file happens to carry a copy today.
  const LAUNCHER_SNIPPET = path.join(
    __dirname, '..', 'gsd-core', 'workflows', '_runtime-launcher.snippet.sh',
  );

  const SHIM_ANCHOR = '_GSD_SHIM_NAME="gsd-tools.cjs"';

  test('status is read through the canonical query, not a raw frontmatter grep', () => {
    const content = fs.readFileSync(QUICK_VERIFICATION, 'utf-8');
    const queryIdx = content.indexOf('gsd_run query verification.status "${QUICK_DIR}"');

    assert.ok(queryIdx !== -1, 'quick-verification.md must read status via the verification.status query');
    assert.ok(
      !content.includes('grep "^status:"'),
      'the raw frontmatter-scalar grep must not return — it matches body lines too (DEFECT.FRONTMATTER-SCALAR-BROAD-GREP)',
    );
  });

  test('the query call is preceded by the runtime shim bootstrap in this step file', () => {
    // Step files are read and executed as their own units, so quick.md's
    // bootstrap does not reach here. Without this the call resolves to
    // nothing, 2>/dev/null swallows it, and the default arm is taken forever.
    const content = fs.readFileSync(QUICK_VERIFICATION, 'utf-8');
    const shimIdx = content.indexOf(SHIM_ANCHOR);
    const queryIdx = content.indexOf('gsd_run query verification.status');

    assert.ok(shimIdx !== -1, 'the step file must carry its own runtime shim bootstrap');
    assert.ok(queryIdx > shimIdx, 'the shim bootstrap must precede the gsd_run call');
  });

  test('the shim bootstrap is the canonical launcher preamble, not a fork of it', () => {
    // Anchored on _runtime-launcher.snippet.sh rather than on a sibling step
    // file: sync-runtime-launcher.cjs regenerates every workflow from the
    // snippet, so a synchronized launcher update keeps this green (correct),
    // and a sibling that legitimately stops calling gsd_run cannot fail us.
    const lineWithShim = (file) => fs.readFileSync(file, 'utf-8')
      .split(/\r?\n/)
      .find((line) => line.startsWith(SHIM_ANCHOR));

    const mine = lineWithShim(QUICK_VERIFICATION);
    const canonical = lineWithShim(LAUNCHER_SNIPPET);

    assert.ok(canonical, '_runtime-launcher.snippet.sh must carry the canonical preamble');
    assert.equal(mine, canonical, 'the bootstrap must match the canonical launcher snippet verbatim');
  });

  test('status extraction does not depend on jq', () => {
    // #2589: a `| jq -r '.field'` pipe yields an empty variable with no
    // diagnostic wherever jq is absent (the Windows/Git-Bash default), which
    // would route a passing verification into the recovery arm.
    //
    // Scoped to the executable fence on purpose: the surrounding prose cites
    // the jq form in order to explain why it is not used, and an assertion
    // over the whole file would fire on its own rationale.
    const content = fs.readFileSync(QUICK_VERIFICATION, 'utf-8');
    const contentLines = content.split(/\r?\n/);
    const fences = scanFencedBlocks(contentLines)
      .filter((b) => b.closeLineIdx !== -1 && (b.infoString || '').trim() === 'bash')
      .map((b) => contentLines.slice(b.openLineIdx, b.closeLineIdx + 1).join('\n'));
    const statusFence = fences.find((f) => f.includes('gsd_run query verification.status'));

    assert.ok(statusFence, 'the status read must live in a bash fence');
    assert.ok(
      statusFence.includes('--pick status'),
      'the bare status must be picked by the query itself',
    );
    assert.ok(!/\|\s*jq\b/.test(statusFence), 'the status-read fence must not pipe through jq');
  });

  test('the routing table carries a terminal arm for missing / unknown / stale', () => {
    const content = fs.readFileSync(QUICK_VERIFICATION, 'utf-8');
    const gapsIdx = content.indexOf('| `gaps_found` |');
    const fallbackIdx = content.indexOf('| anything else');

    assert.ok(gapsIdx !== -1, 'the three verifier-status arms must remain');
    assert.ok(fallbackIdx > gapsIdx, 'a terminal arm must follow the verifier-status arms');

    const fallbackRow = content.slice(fallbackIdx, content.indexOf('\n', fallbackIdx));
    for (const sentinel of ['missing', 'unknown', 'stale']) {
      assert.ok(
        fallbackRow.includes(sentinel),
        `the terminal arm must name the ${sentinel} sentinel the query can return`,
      );
    }
    assert.ok(
      fallbackRow.includes('VERIFICATION_STATUS'),
      'the terminal arm must set the display string consumed by the quick index row and banner',
    );
  });
  });
  });
}
