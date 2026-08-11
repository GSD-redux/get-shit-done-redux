'use strict';

/**
 * Representative-corpus gate tests (#2371).
 *
 * Every fixture under tests/fixtures/representative/ is verbatim (or a
 * minimal faithful subset) of a real reported artifact — never invented to
 * match a gate's own grammar. See tests/fixtures/representative/README.md
 * for the full rationale and CONTRIBUTING.md's "Fixture provenance" rule.
 *
 * Each gate is driven through its real CLI entrypoint (gate-verdict
 * altitude), matching the established pattern in
 * tests/api-coverage-gate-e2e.test.cjs and tests/decisions.test.cjs — never
 * the parser function called in isolation.
 *
 * Three fixtures (across api-coverage-detector, api-coverage-matrix,
 * decision-coverage-guard) encode gates that are still open bugs (#2365,
 * #2366, #2347). For those, MANIFEST.json carries BOTH the correct target
 * verdict (`expected*` — what the fix must produce) and the exact CURRENT
 * observed verdict (`currentBuggyOutput` — what today's code actually
 * returns). The test asserts against `currentBuggyOutput`: an honest,
 * non-vacuous characterization of today's known-broken reality, not a fake
 * pass. This assertion WILL fail, loudly, the moment the underlying bug is
 * fixed and the gate starts returning something other than the pinned
 * buggy value — at which point whoever's fix landed must update the
 * assertion to check `expected*` instead (and can delete `currentBuggyOutput`).
 *
 * Why not node:test's `todo` option: this repo's own test-runner
 * (gsd-test / gsd-test-runner v1.6.2) has no concept of it. Its JSONL
 * result parser (internal/pipeline/parse.go's parseJSONL, gsd-test-runner
 * repo) only recognizes `kind: "pass" | "fail"` — verified directly against
 * that source — so a `{ todo: true }` test whose body throws is still
 * counted as a real failure in the tool's own verdict. Characterization
 * (assert the known-current value) sidesteps this because the test
 * genuinely passes today; it needs no runner-level "expected failure"
 * feature at all.
 *
 * The audit-uat corpus (#2286, fixed by #2317) has no currentBuggyOutput:
 * it already asserts the correct behavior directly, because the bug is
 * already fixed — proof the methodology works end to end, not just a
 * record of gaps.
 */

const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { cleanup, TEST_ENV_BASE } = require('./helpers.cjs');

const TOOLS_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');
const FIXTURES_ROOT = path.join(__dirname, 'fixtures', 'representative');

function runTools(args, cwd) {
  try {
    const stdout = execFileSync(process.execPath, [TOOLS_PATH, ...args], {
      cwd,
      encoding: 'utf-8',
      env: { ...process.env, ...TEST_ENV_BASE },
      timeout: 60000,
    });
    return { success: true, output: stdout.trim(), error: '' };
  } catch (err) {
    return {
      success: false,
      output: err.stdout?.toString().trim() || '',
      error: err.stderr?.toString().trim() || err.message,
    };
  }
}

function readManifest(gateDir) {
  const raw = fs.readFileSync(path.join(FIXTURES_ROOT, gateDir, 'MANIFEST.json'), 'utf8');
  return JSON.parse(raw);
}

function readFixture(gateDir, file) {
  return fs.readFileSync(path.join(FIXTURES_ROOT, gateDir, file), 'utf8');
}

function makeProject() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-repcorpus-'));
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), '{}', 'utf8');
  return tmpDir;
}

function makePhaseDir(projectDir, slug) {
  const dir = path.join(projectDir, '.planning', 'phases', slug);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ─── api-coverage-detector (#2365) ────────────────────────────────────────────

describe('representative corpus — api-coverage detector (#2365)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  const manifest = readManifest('api-coverage-detector');

  for (const fx of manifest.fixtures) {
    const label = fx.currentBuggyOutput ? `${fx.file} → currently detected:true (#2365)` : `${fx.file} → detected:false`;
    test(label, () => {
      tmpDir = makeProject();
      const phaseDir = makePhaseDir(tmpDir, '01-repcorpus');
      const body = readFixture('api-coverage-detector', fx.file);
      fs.writeFileSync(path.join(phaseDir, '01-PLAN.md'), `# Plan\n${body}\n`, 'utf8');

      const r = runTools(['check', 'api-coverage.verify-pre', phaseDir, '--raw'], tmpDir);
      assert.ok(r.success, `gate should succeed (JSON). stderr: ${r.error}`);
      const j = JSON.parse(r.output);

      if (fx.currentBuggyOutput) {
        assert.strictEqual(j.detected, fx.currentBuggyOutput.detected,
          `${fx.file}: expected today's known-buggy detected:${fx.currentBuggyOutput.detected}, got ${JSON.stringify(j)}. ` +
          `If this now differs, #2365 may be fixed — check against expectedDetected:${fx.expectedDetected} instead.`);
        assert.strictEqual(j.signals?.[0]?.verb, fx.currentBuggyOutput.signal.verb, `${fx.file}: signal.verb`);
        assert.strictEqual(j.signals?.[0]?.noun, fx.currentBuggyOutput.signal.noun, `${fx.file}: signal.noun`);
      } else {
        assert.strictEqual(j.detected, fx.expectedDetected,
          `${fx.file}: expected detected:${fx.expectedDetected}, got ${JSON.stringify(j)}`);
      }
    });
  }
});

// ─── api-coverage-matrix (#2366) ──────────────────────────────────────────────

describe('representative corpus — api-coverage matrix (#2366)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  const manifest = readManifest('api-coverage-matrix');

  for (const fx of manifest.fixtures) {
    const label = `${fx.file} → exactly the canonical rows, 0 errors`;
    test(label, () => {
      tmpDir = makeProject();
      const phaseDir = makePhaseDir(tmpDir, '01-repcorpus');
      fs.writeFileSync(path.join(phaseDir, '01-PLAN.md'), `# Plan\n${fx.pairedPlan}\n`, 'utf8');
      fs.writeFileSync(path.join(phaseDir, 'COVERAGE.md'), readFixture('api-coverage-matrix', fx.file), 'utf8');

      const r = runTools(['check', 'api-coverage.verify-pre', phaseDir, '--raw'], tmpDir);
      assert.ok(r.success, `gate should succeed (JSON). stderr: ${r.error}`);
      const j = JSON.parse(r.output);

      assert.strictEqual(j.block, fx.expectedBlock, `${fx.file}: block. Got ${JSON.stringify(j)}`);
      assert.deepStrictEqual(j.counts, fx.expectedCounts, `${fx.file}: counts. Got ${JSON.stringify(j)}`);
      assert.strictEqual((j.errors || []).length, fx.expectedErrorCount,
        `${fx.file}: errors. Got ${JSON.stringify(j.errors)}`);
    });
  }
});

// ─── audit-uat (#2286, fixed by #2317 — asserts correct behavior directly) ────

describe('representative corpus — audit-uat (#2286, fixed by #2317)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  const manifest = readManifest('audit-uat');

  test('Gaps-section + human-verification-frontmatter fixtures both surface as real items', () => {
    tmpDir = makeProject();
    const phaseDir = makePhaseDir(tmpDir, '01-repcorpus');
    for (const fx of manifest.fixtures) {
      fs.writeFileSync(
        path.join(phaseDir, `01${fx.filenameSuffix}`),
        readFixture('audit-uat', fx.file),
        'utf8',
      );
    }

    const r = runTools(['audit-uat', '--raw'], tmpDir);
    assert.ok(r.success, `audit-uat should succeed. stderr: ${r.error}`);
    const j = JSON.parse(r.output);
    assert.ok(
      j.summary.total_items >= manifest.expectedTotalItems,
      `expected total_items >= ${manifest.expectedTotalItems}, got ${JSON.stringify(j.summary)}`,
    );
    // Per-fixture check (not just the aggregate): a regression that moves
    // items between files while preserving the total would slip past the
    // total_items check above but not this one.
    for (const fx of manifest.fixtures) {
      const fileName = `01${fx.filenameSuffix}`;
      const fileResult = j.results.find((r2) => r2.file === fileName);
      assert.ok(fileResult, `expected a result entry for ${fileName}, got ${JSON.stringify(j.results)}`);
      assert.ok(
        fileResult.items.length >= fx.expectedMinItems,
        `${fileName}: expected items.length >= ${fx.expectedMinItems}, got ${fileResult.items.length}`,
      );
    }
  });
});

// ─── decision-coverage-guard (#2347) ──────────────────────────────────────────

describe('representative corpus — decision-coverage guard (#2347)', () => {
  let tmpDir;
  afterEach(() => { if (tmpDir) { cleanup(tmpDir); tmpDir = null; } });

  const manifest = readManifest('decision-coverage-guard');

  for (const fx of manifest.fixtures) {
    const label = fx.currentBuggyOutput
      ? `${fx.file} → currently passed:true, skipped:true (#2347)`
      : `${fx.file} → outcome could-not-parse, passed:false`;
    test(label, () => {
      tmpDir = makeProject();
      const phaseDir = makePhaseDir(tmpDir, '01-repcorpus');
      const contextPath = path.join(phaseDir, 'CONTEXT.md');
      fs.writeFileSync(contextPath, readFixture('decision-coverage-guard', fx.file), 'utf8');

      const r = runTools(['query', 'check.decision-coverage-plan', phaseDir, contextPath], tmpDir);
      assert.ok(r.success, `gate should succeed (JSON). stderr: ${r.error}`);
      const j = JSON.parse(r.output);

      if (fx.currentBuggyOutput) {
        assert.strictEqual(j.passed, fx.currentBuggyOutput.passed,
          `${fx.file}: expected today's known-buggy passed:${fx.currentBuggyOutput.passed}, got ${JSON.stringify(j)}. ` +
          `If this now differs, #2347 may be fixed — check against expectedPassed:${fx.expectedPassed} instead.`);
        assert.strictEqual(j.skipped, fx.currentBuggyOutput.skipped, `${fx.file}: skipped`);
        assert.strictEqual(j.reason, fx.currentBuggyOutput.reason, `${fx.file}: reason`);
        assert.strictEqual(j.total, fx.currentBuggyOutput.total, `${fx.file}: total`);
      } else {
        assert.strictEqual(j.passed, fx.expectedPassed, `${fx.file}: passed. Got ${JSON.stringify(j)}`);
        assert.strictEqual(j.reason, fx.expectedReason, `${fx.file}: reason. Got ${JSON.stringify(j)}`);
      }
    });
  }
});
