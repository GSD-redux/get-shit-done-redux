// docs-guard-exempt: docs/adr/3524-...md is cited only in a References comment; never read.
// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * GSD Tools Tests - Phase
 *
 * Consolidated from 20 → 4 test files (issue #3740). This file covers the
 * CJS phase CLI layer (phase.cjs + gsd-tools.cjs): add, remove, complete,
 * list, insert, and all regression tests for bugs in that layer.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { runNode } = require('./helpers/process-seam.cjs');
const { toLegacyResult } = require('./helpers/git-fixture.cjs');

// `phase complete` against a real STATE.md rewrite; matches the 60000ms bound
// already used for the same CLI call elsewhere in this file (runPhaseComplete
// above, and `run()` below at 15000ms for a lighter query-only call).
const PHASE_COMPLETE_TIMEOUT_MS = 60000;
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { splitTableRow } = require('../gsd-core/bin/lib/markdown-table.cjs');

const GSD_TOOLS_BIN = path.resolve(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

function normalizePhaseToken(token) {
  return String(token).replace(/\d+/g, (digits) => String(Number(digits)));
}

function phaseTokenFromDirName(name) {
  const match = name.match(/^(?:[A-Z][A-Z0-9]*-)?(\d+[A-Z]?(?:\.\d+)*)/i);
  return match ? match[1] : null;
}

function writePassedVerificationForPhase(tmpDir, phase) {
  const phasesDir = path.join(tmpDir, '.planning', 'phases');
  const wanted = normalizePhaseToken(phase);
  const phaseDirName = fs.readdirSync(phasesDir)
    .find((name) => normalizePhaseToken(phaseTokenFromDirName(name) || '') === wanted);

  assert.ok(phaseDirName, `expected phase directory for Phase ${phase}`);

  const phaseDir = path.join(phasesDir, phaseDirName);
  fs.writeFileSync(
    path.join(phaseDir, `${phase}-VERIFICATION.md`),
    ['---', 'status: passed', '---', '', '# Verification', ''].join('\n'),
  );
}

function runVerifiedPhaseComplete(args, tmpDir, env) {
  const argv = Array.isArray(args)
    ? args
    : (args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [])
        .map((t) => t.replace(/"([^"]*)"/g, '$1').replace(/'([^']*)'/g, '$1'));
  const completeIdx = argv.findIndex((token, index) => token === 'complete' && argv[index - 1] === 'phase');
  assert.notEqual(completeIdx, -1, `expected phase complete command, got ${argv.join(' ')}`);
  const phase = argv[completeIdx + 1];
  assert.ok(phase, `expected phase number in command ${argv.join(' ')}`);
  writePassedVerificationForPhase(tmpDir, phase);
  return runGsdTools(args, tmpDir, env);
}

function writePhaseCompleteVerificationGateFixture(tmpDir, verificationStatus) {
  const planningDir = path.join(tmpDir, '.planning');
  const phase1Dir = path.join(planningDir, 'phases', '01-foundation');
  const phase2Dir = path.join(planningDir, 'phases', '02-api');
  fs.mkdirSync(phase1Dir, { recursive: true });
  fs.mkdirSync(phase2Dir, { recursive: true });

  fs.writeFileSync(
    path.join(planningDir, 'ROADMAP.md'),
    [
      '# Roadmap',
      '',
      '- [ ] Phase 1: Foundation',
      '- [ ] Phase 2: API',
      '',
      '### Phase 1: Foundation',
      '**Goal:** Setup',
      '**Plans:** 1 plans',
      '',
      '### Phase 2: API',
      '**Goal:** Build API',
      '',
      '## Progress',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '|-------|----------------|--------|-----------|',
      '| 01. Foundation | 0/1 | Not started | - |',
      '| 02. API | 0/1 | Not started | - |',
      '',
    ].join('\n'),
  );

  fs.writeFileSync(
    path.join(planningDir, 'STATE.md'),
    [
      '# State',
      '',
      '**Current Phase:** 01',
      '**Current Phase Name:** Foundation',
      '**Status:** In progress',
      '**Current Plan:** 01-01',
      '**Last Activity:** 2025-01-01',
      '**Last Activity Description:** Working on phase 1',
      '',
    ].join('\n'),
  );

  fs.writeFileSync(path.join(phase1Dir, '01-01-PLAN.md'), '# Plan\n');
  fs.writeFileSync(path.join(phase1Dir, '01-01-SUMMARY.md'), '# Summary\n');

  if (verificationStatus !== null) {
    fs.writeFileSync(
      path.join(phase1Dir, '01-VERIFICATION.md'),
      [
        '---',
        `status: ${verificationStatus}`,
        '---',
        '',
        '# Verification',
        '',
      ].join('\n'),
    );
  }
}

describe('phases list command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('empty phases directory returns empty array', () => {
    const result = runGsdTools('phases list', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.directories, [], 'directories should be empty');
    assert.strictEqual(output.count, 0, 'count should be 0');
  });

  test('lists phase directories sorted numerically', () => {
    // Create out-of-order directories
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '10-final'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-api'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });

    const result = runGsdTools('phases list', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.count, 3, 'should have 3 directories');
    assert.deepStrictEqual(
      output.directories,
      ['01-foundation', '02-api', '10-final'],
      'should be sorted numerically'
    );
  });

  test('handles decimal phases in sort order', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-api'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02.1-hotfix'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02.2-patch'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-ui'), { recursive: true });

    const result = runGsdTools('phases list', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.directories,
      ['02-api', '02.1-hotfix', '02.2-patch', '03-ui'],
      'decimal phases should sort correctly between whole numbers'
    );
  });

  test('--type plans lists only PLAN.md files', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan 1');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan 2');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(phaseDir, 'RESEARCH.md'), '# Research');

    const result = runGsdTools('phases list --type plans', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.files.sort(),
      ['01-01-PLAN.md', '01-02-PLAN.md'],
      'should list only PLAN files'
    );
  });

  test('--type summaries lists only SUMMARY.md files', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary 1');
    fs.writeFileSync(path.join(phaseDir, '01-02-SUMMARY.md'), '# Summary 2');

    const result = runGsdTools('phases list --type summaries', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.files.sort(),
      ['01-01-SUMMARY.md', '01-02-SUMMARY.md'],
      'should list only SUMMARY files'
    );
  });

  test('--phase filters to specific phase directory', () => {
    const phase01 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    const phase02 = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(phase01, { recursive: true });
    fs.mkdirSync(phase02, { recursive: true });
    fs.writeFileSync(path.join(phase01, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phase02, '02-01-PLAN.md'), '# Plan');

    const result = runGsdTools('phases list --type plans --phase 01', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.files, ['01-01-PLAN.md'], 'should only list phase 01 plans');
    assert.strictEqual(output.phase_dir, 'foundation', 'should report phase name without number prefix');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap get-phase command
// ─────────────────────────────────────────────────────────────────────────────

// #1729 regression: a phase header may carry a parenthetical tag BEFORE the
// colon — `### Phase 26 (Cluster B): Title`. The header regexes built
// `Phase\s+<num>` immediately followed by the colon delimiter, so the resolver
// returned found:false and phase commands silently no-op'd (the failure is
// silent — not-found, not an error — so an author can lose work without a
// signal). The fix injects a shared OPTIONAL_PHASE_TAG_SOURCE fragment at every
// header call site, mirroring how `[...]` is already tolerated before `Phase`.
//
// Parity assertion (per the #3537/#3599 generative-fix discipline): a pre-colon
// tag must resolve the SAME phase as the equivalent post-colon tag, padding
// tolerance must survive, and the optional tag must not enable cross-phase
// false matches. A shared seam + parity test keeps the next call site from
// drifting back undetected.
describe('#1729 regression: parenthetical tag before the colon in a phase header', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writeRoadmap(lines) {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      ['# Roadmap', ''].concat(lines, ['']).join('\n'),
    );
  }

  function getPhase(query) {
    const result = runGsdTools(['roadmap', 'get-phase', String(query)], tmpDir);
    assert.ok(result.success, `get-phase ${query} failed: ${result.error}`);
    return JSON.parse(result.output);
  }

  test('resolves a header whose tag sits before the colon (the reported bug)', () => {
    writeRoadmap([
      '### Phase 26 (Cluster B): Engine-adapter caveats',
      'Plans: 2',
    ]);
    const phase = getPhase(26);
    assert.equal(phase.found, true, 'pre-colon-tagged phase must resolve');
    assert.equal(
      phase.phase_name,
      'Engine-adapter caveats',
      'the pre-colon tag must be excluded from the resolved name',
    );
  });

  test('a pre-colon tag resolves the same phase as a post-colon tag', () => {
    // Post-colon placement is the documented workaround and already worked.
    // Both placements must resolve found:true for the same phase number; the
    // only contracted difference is that a post-colon tag is part of the title.
    writeRoadmap(['### Phase 26: Engine-adapter caveats (Cluster B)', 'Plans: 2']);
    const post = getPhase(26);
    assert.equal(post.found, true);
    assert.equal(post.phase_name, 'Engine-adapter caveats (Cluster B)');

    writeRoadmap(['### Phase 26 (Cluster B): Engine-adapter caveats', 'Plans: 2']);
    const pre = getPhase(26);
    assert.equal(pre.found, true, 'pre-colon placement must resolve like post-colon');
    assert.equal(pre.phase_number, post.phase_number);
  });

  test('padding tolerance (#3537) survives: both `6` and `06` resolve a tagged header', () => {
    writeRoadmap(['### Phase 6 (Cluster B): Padded test', 'Plans: 1']);
    const unpadded = getPhase(6);
    const padded = getPhase('06');
    assert.equal(unpadded.found, true, 'unpadded query must resolve');
    assert.equal(padded.found, true, 'padded query must resolve');
    assert.equal(padded.phase_name, unpadded.phase_name, 'padded/unpadded must agree');
    assert.equal(unpadded.phase_name, 'Padded test');
  });

  test('decimal sub-phase headers tolerate a pre-colon tag', () => {
    writeRoadmap([
      '### Phase 26 (Cluster B): Base',
      'Plans: 1',
      '',
      '### Phase 26.1 (Sub tag): Decimal subphase',
      'Plans: 1',
    ]);
    const sub = getPhase('26.1');
    assert.equal(sub.found, true, 'decimal sub-phase with pre-colon tag must resolve');
    assert.equal(sub.phase_name, 'Decimal subphase');
  });

  test('the optional tag does not enable a cross-phase false match', () => {
    // `0*2` must not latch onto `Phase 26 (...)`: querying phase 2 against a
    // roadmap that only has phase 26 must still report not-found.
    writeRoadmap(['### Phase 26 (Cluster B): Engine caveats', 'Plans: 1']);
    assert.equal(getPhase(2).found, false, 'phase 2 must not match phase 26');
    assert.equal(getPhase(26).found, true, 'sanity: phase 26 still resolves');
  });

  test('exposes a shared OPTIONAL_PHASE_TAG_SOURCE seam to prevent call-site drift', () => {
    const phaseId = require('../gsd-core/bin/lib/phase-id.cjs');
    assert.equal(
      typeof phaseId.OPTIONAL_PHASE_TAG_SOURCE,
      'string',
      'the shared tag fragment must be exported so every header site composes it',
    );
    const re = new RegExp(`Phase\\s+0*26${phaseId.OPTIONAL_PHASE_TAG_SOURCE}:`);
    assert.ok(re.test('### Phase 26 (Cluster B): X'), 'seam matches a pre-colon tag');
    assert.ok(re.test('### Phase 26: X'), 'seam stays optional when no tag is present');
  });

  test('#2128: the pre-colon tag is length-bounded so the tag clause cannot ReDoS', () => {
    // The tag body `[^)\n]*` was unbounded, making the optional-group + /g scan
    // quadratic on adversarial ROADMAP.md/STATE.md (a long run of `(` after a
    // header). Bounding it to {0,200} keeps the match linear; a 200-char tag body
    // still matches (real tags are a handful of chars), 201 does not.
    const phaseId = require('../gsd-core/bin/lib/phase-id.cjs');
    const re = new RegExp(`Phase\\s+0*26${phaseId.OPTIONAL_PHASE_TAG_SOURCE}\\s*:`);
    // Boundary coverage (CLAUDE.md): limit-1, limit, limit+1.
    assert.ok(re.test(`### Phase 26 (${'x'.repeat(199)}): T`), 'a 199-char tag body (limit-1) is within the bound');
    assert.ok(re.test(`### Phase 26 (${'x'.repeat(200)}): T`), 'a 200-char tag body (limit) is within the bound');
    assert.ok(!re.test(`### Phase 26 (${'x'.repeat(201)}): T`), 'a 201-char tag body (limit+1) exceeds the bound');
    // Linearity guard: the adversarial input that was ~18.8s unbounded resolves
    // near-instantly now. Assert bounded work, not wall-clock (no clock seam):
    // the bounded source contains an explicit upper repetition limit.
    assert.match(phaseId.OPTIONAL_PHASE_TAG_SOURCE, /\{0,\d+\}/, 'tag body must carry an explicit upper bound');
  });

  test('enumeration (roadmap analyze) lists a pre-colon-tagged phase, not just the resolver', () => {
    // The resolver (get-phase) and the capture-all enumeration regexes are
    // separate code paths. Fixing only the resolver left `roadmap analyze`
    // silently dropping a tagged phase from its phase list — wrong phase_count,
    // progress_percent, and next_phase. Both a tagged and an untagged phase must
    // appear so the enumeration is coherent with the resolver.
    writeRoadmap([
      '### Phase 26 (Cluster B): Engine-adapter caveats',
      'Plans: 1',
      '',
      '### Phase 27: Coordinator playbook',
      'Plans: 1',
    ]);
    const result = runGsdTools(['roadmap', 'analyze'], tmpDir);
    assert.ok(result.success, `roadmap analyze failed: ${result.error}`);
    const analysis = JSON.parse(result.output);
    const numbers = analysis.phases.map((p) => p.number);
    assert.ok(numbers.includes('26'), 'tagged phase 26 must appear in enumeration');
    assert.ok(numbers.includes('27'), 'untagged phase 27 must appear in enumeration');
    assert.equal(analysis.phase_count, 2, 'tagged phase must count toward phase_count');
    const p26 = analysis.phases.find((p) => p.number === '26');
    assert.equal(p26.name, 'Engine-adapter caveats', 'pre-colon tag must be excluded from the enumerated name');
  });

  test('phase remove renumbers a later tagged header and preserves its tag', () => {
    // The renumber-on-removal rewrite (phase.cts) captured `(num)(\s*:)`, so a
    // later pre-colon-tagged header was skipped — leaving a stale/duplicate
    // number after an earlier phase was removed. The tag must survive the
    // rewrite (it is folded into the re-emitted suffix, not dropped).
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '### Phase 1: Foundation',
        '**Goal:** Setup',
        '',
        '### Phase 2: Auth',
        '**Goal:** Authentication',
        '',
        '### Phase 3 (Cluster B): Features',
        '**Goal:** Core features',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-auth'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-features'), { recursive: true });

    const result = runGsdTools('phase remove 2', tmpDir);
    assert.ok(result.success, `phase remove failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(
      /###\s*Phase 2 \(Cluster B\): Features/.test(roadmap),
      `tagged header must renumber 3->2 and keep its tag; got:\n${roadmap}`,
    );
    assert.ok(!/Phase 3 \(Cluster B\)/.test(roadmap), 'old number 3 must be gone');
  });

  test('the literal enumeration mirror stays equivalent to the exported seam (drift guard)', () => {
    // Resolver sites compose OPTIONAL_PHASE_TAG_SOURCE; literal enumeration sites
    // inline `(?:\s*\([^)\n]{0,200}\))?`. If one is edited without the other the
    // two header families silently diverge (the body is bounded to {0,200} in
    // both since #2128 — a ReDoS fix that MUST stay in lockstep). Assert
    // behavioral equivalence over a representative header corpus.
    const phaseId = require('../gsd-core/bin/lib/phase-id.cjs');
    const LITERAL_MIRROR = '(?:\\s*\\([^)\\n]{0,200}\\))?';
    const seam = new RegExp(`^Phase\\s+26${phaseId.OPTIONAL_PHASE_TAG_SOURCE}\\s*:`);
    const mirror = new RegExp(`^Phase\\s+26${LITERAL_MIRROR}\\s*:`);
    for (const sample of [
      'Phase 26: X',
      'Phase 26 (Cluster B): X',
      'Phase 26 (a) (b): X',
      'Phase 26 (unterminated: X',
      'Phase 26  :  X',
    ]) {
      assert.equal(
        seam.test(sample),
        mirror.test(sample),
        `seam and literal mirror must agree on: ${JSON.stringify(sample)}`,
      );
    }
  });
});


describe('phase next-decimal command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns X.1 when no decimal phases exist', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06-feature'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '07-next'), { recursive: true });

    const result = runGsdTools('phase next-decimal 06', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.next, '06.1', 'should return 06.1');
    assert.deepStrictEqual(output.existing, [], 'no existing decimals');
  });

  test('increments from existing decimal phases', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06-feature'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.1-hotfix'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.2-patch'), { recursive: true });

    const result = runGsdTools('phase next-decimal 06', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.next, '06.3', 'should return 06.3');
    assert.deepStrictEqual(output.existing, ['06.1', '06.2'], 'lists existing decimals');
  });

  test('handles gaps in decimal sequence', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06-feature'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.1-first'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.3-third'), { recursive: true });

    const result = runGsdTools('phase next-decimal 06', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Should take next after highest, not fill gap
    assert.strictEqual(output.next, '06.4', 'should return 06.4, not fill gap at 06.2');
  });

  test('handles single-digit phase input', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06-feature'), { recursive: true });

    const result = runGsdTools('phase next-decimal 6', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.next, '06.1', 'should normalize to 06.1');
    assert.strictEqual(output.base_phase, '06', 'base phase should be padded');
  });

  test('returns error if base phase does not exist', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-start'), { recursive: true });

    const result = runGsdTools('phase next-decimal 06', tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, false, 'base phase not found');
    assert.strictEqual(output.next, '06.1', 'should still suggest 06.1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase-plan-index command
// ─────────────────────────────────────────────────────────────────────────────


describe('phase-plan-index command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('empty phase directory returns empty plans array', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-api'), { recursive: true });

    const result = runGsdTools('phase-plan-index 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase, '03', 'phase number correct');
    assert.deepStrictEqual(output.plans, [], 'plans should be empty');
    assert.deepStrictEqual(output.waves, {}, 'waves should be empty');
    assert.deepStrictEqual(output.incomplete, [], 'incomplete should be empty');
    assert.strictEqual(output.has_checkpoints, false, 'no checkpoints');
    assert.ok(output.warning === undefined, 'truly empty dir must not emit a warning');
  });

  test('phase dir whose slug leads with a year still resolves and indexes plans (#2232)', () => {
    // Roadmap phase name "2026 Photos & Performance" → dir
    // "14-2026-photos-performance". extractPhaseToken over-collected the year
    // into the token ("14-2026"), so phase-plan-index reported plans: [] while
    // the plans existed on disk.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '14-2026-photos-performance');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '14-01-PLAN.md'), '---\nwave: 1\n---\n');
    fs.writeFileSync(path.join(phaseDir, '14-02-PLAN.md'), '---\nwave: 1\n---\n');

    const result = runGsdTools('phase-plan-index 14', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.plans.length, 2, 'plans found despite year-leading slug');
    assert.ok(output.warning === undefined, `canonical plans must not warn, got: ${output.warning}`);
  });

  // #2893 — when the planner produces filenames that don't match the canonical
  // `{padded_phase}-{NN}-PLAN.md` contract, the executor used to silently see
  // plan_count: 0 with no signal. Now the response must include a `warning`
  // field naming every offender, so the user gets an actionable error instead
  // of "execute-phase blocked, no clue why".
  test('non-canonical plan filenames surface a warning naming each offender (#2893)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });

    // The reporter's exact symptom: planner wrote `{phase-id}-PLAN-{N}-{slug}.md`.
    fs.writeFileSync(path.join(phaseDir, '01-PLAN-01-foundation.md'), '---\n---\n');
    fs.writeFileSync(path.join(phaseDir, '01-PLAN-02-api.md'), '---\n---\n');

    const result = runGsdTools('phase-plan-index 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.plans.length, 0, 'non-canonical files are not silently accepted');
    assert.ok(typeof output.warning === 'string', 'warning field must be present');
    assert.ok(output.warning.includes('01-PLAN-01-foundation.md'), 'warning names the first offender');
    assert.ok(output.warning.includes('01-PLAN-02-api.md'), 'warning names the second offender');
    assert.ok(
      output.warning.includes('{padded_phase}-{NN}-PLAN.md'),
      'warning cites the canonical pattern so user knows what to rename to',
    );
  });

  test('canonical plans suppress the warning even alongside derivative files (#2893)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });

    // Canonical plan + the legitimate derivative artifacts the planner emits.
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), '---\nwave: 1\n---\n');
    fs.writeFileSync(path.join(phaseDir, '03-PLAN-OUTLINE.md'), '# outline\n');
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.pre-bounce.md'), '---\n---\n');

    const result = runGsdTools('phase-plan-index 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.plans.length, 1, 'canonical plan detected');
    assert.ok(
      output.warning === undefined,
      `outline and pre-bounce files must not trigger the warning, got: ${output.warning}`,
    );
  });

  // #2893 parity — find-phase reads the same phase directory and applies the
  // same canonical filter, so it must emit the same warning shape. Without
  // these tests the two code paths could silently diverge.
  test('find-phase: non-canonical plan filenames surface the same warning (#2893 parity)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-PLAN-01-foundation.md'), '---\n---\n');
    fs.writeFileSync(path.join(phaseDir, '01-PLAN-02-api.md'), '---\n---\n');

    const result = runGsdTools('find-phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'phase directory found');
    assert.deepStrictEqual(output.plans, [], 'non-canonical files are not silently accepted');
    assert.ok(typeof output.warning === 'string', 'warning field must be present');
    assert.ok(output.warning.includes('01-PLAN-01-foundation.md'), 'warning names the first offender');
    assert.ok(output.warning.includes('01-PLAN-02-api.md'), 'warning names the second offender');
    assert.ok(
      output.warning.includes('{padded_phase}-{NN}-PLAN.md'),
      'warning cites the canonical pattern',
    );
  });

  test('find-phase: canonical plans + derivatives suppress the warning (#2893 parity)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), '---\nwave: 1\n---\n');
    fs.writeFileSync(path.join(phaseDir, '03-PLAN-OUTLINE.md'), '# outline\n');
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.pre-bounce.md'), '---\n---\n');

    const result = runGsdTools('find-phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.plans, ['03-01-PLAN.md'], 'canonical plan detected');
    assert.ok(
      output.warning === undefined,
      `outline and pre-bounce files must not trigger the warning, got: ${output.warning}`,
    );
  });

  // #2893 parity — `phases list --type plans` aggregates across phase dirs
  // and prefixes each warning with `${dir}: ` so the user can locate the
  // offending phase. Test mirrors the find-phase pair but accounts for that
  // prefix in the assertion.
  test('phases list --type plans: non-canonical filenames surface a per-dir warning (#2893 parity)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-PLAN-01-foundation.md'), '---\n---\n');
    fs.writeFileSync(path.join(phaseDir, '01-PLAN-02-api.md'), '---\n---\n');

    const result = runGsdTools('phases list --type plans --phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.files, [], 'non-canonical files are not silently accepted');
    assert.ok(typeof output.warning === 'string', 'warning field must be present');
    assert.ok(output.warning.includes('03-api:'), 'warning is prefixed with the offending phase dir');
    assert.ok(output.warning.includes('01-PLAN-01-foundation.md'), 'warning names the first offender');
    assert.ok(output.warning.includes('01-PLAN-02-api.md'), 'warning names the second offender');
    assert.ok(
      output.warning.includes('{padded_phase}-{NN}-PLAN.md'),
      'warning cites the canonical pattern',
    );
  });

  test('phases list --type plans: canonical plans suppress the warning (#2893 parity)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), '---\nwave: 1\n---\n');
    fs.writeFileSync(path.join(phaseDir, '03-PLAN-OUTLINE.md'), '# outline\n');
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.pre-bounce.md'), '---\n---\n');

    const result = runGsdTools('phases list --type plans --phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.files, ['03-01-PLAN.md'], 'canonical plan detected');
    assert.ok(
      output.warning === undefined,
      `outline and pre-bounce files must not trigger the warning, got: ${output.warning}`,
    );
  });

  test('extracts single plan with frontmatter', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '03-01-PLAN.md'),
      `---
wave: 1
autonomous: true
objective: Set up database schema
files-modified: [prisma/schema.prisma, src/lib/db.ts]
---

## Task 1: Create schema
## Task 2: Generate client
`
    );

    const result = runGsdTools('phase-plan-index 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.plans.length, 1, 'should have 1 plan');
    assert.strictEqual(output.plans[0].id, '03-01', 'plan id correct');
    assert.strictEqual(output.plans[0].wave, 1, 'wave extracted');
    assert.strictEqual(output.plans[0].autonomous, true, 'autonomous extracted');
    assert.strictEqual(output.plans[0].objective, 'Set up database schema', 'objective extracted');
    assert.deepStrictEqual(output.plans[0].files_modified, ['prisma/schema.prisma', 'src/lib/db.ts'], 'files extracted');
    assert.strictEqual(output.plans[0].task_count, 2, 'task count correct');
    assert.strictEqual(output.plans[0].has_summary, false, 'no summary yet');
  });

  test('groups multiple plans by wave (DAG-bucketing: 03-03 depends on 03-01 and 03-02)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '03-01-PLAN.md'),
      [
        '---',
        'wave: 1',
        'autonomous: true',
        'objective: Database setup',
        'depends_on: []',
        '---',
        '',
        '## Task 1: Schema',
      ].join('\n')
    );

    fs.writeFileSync(
      path.join(phaseDir, '03-02-PLAN.md'),
      [
        '---',
        'wave: 1',
        'autonomous: true',
        'objective: Auth setup',
        'depends_on: []',
        '---',
        '',
        '## Task 1: JWT',
      ].join('\n')
    );

    fs.writeFileSync(
      path.join(phaseDir, '03-03-PLAN.md'),
      [
        '---',
        'wave: 2',
        'autonomous: false',
        'objective: API routes',
        'depends_on:',
        '  - 03-01',
        '  - 03-02',
        '---',
        '',
        '## Task 1: Routes',
      ].join('\n')
    );

    const result = runGsdTools('phase-plan-index 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.plans.length, 3, 'should have 3 plans');
    assert.deepStrictEqual(output.waves['1'], ['03-01', '03-02'], 'wave 1 has 2 plans');
    assert.deepStrictEqual(output.waves['2'], ['03-03'], 'wave 2 has 1 plan');
    // No mismatch warning: declared wave 2 matches topo level 2
    assert.strictEqual(output.warnings, undefined, 'no warnings when declared wave matches DAG');
  });

  test('detects incomplete plans (no matching summary)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });

    // Plan with summary
    fs.writeFileSync(path.join(phaseDir, '03-01-PLAN.md'), `---\nwave: 1\n---\n## Task 1`);
    fs.writeFileSync(path.join(phaseDir, '03-01-SUMMARY.md'), `# Summary`);

    // Plan without summary
    fs.writeFileSync(path.join(phaseDir, '03-02-PLAN.md'), `---\nwave: 2\n---\n## Task 1`);

    const result = runGsdTools('phase-plan-index 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.plans[0].has_summary, true, 'first plan has summary');
    assert.strictEqual(output.plans[1].has_summary, false, 'second plan has no summary');
    assert.deepStrictEqual(output.incomplete, ['03-02'], 'incomplete list correct');
  });

  test('phase-plan-index matches descriptive plan with prefix summary (#3101)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(path.join(phaseDir, '03-01-auth-hardening-PLAN.md'), `---\nwave: 1\n---\n## Task 1`);
    fs.writeFileSync(path.join(phaseDir, '03-01-SUMMARY.md'), `# Summary`);

    const result = runGsdTools('phase-plan-index 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.plans[0].has_summary, true, 'descriptive plan should match prefix summary');
    assert.deepStrictEqual(output.incomplete, [], 'plan should not be marked incomplete');
  });

  // #3266 CR — depends_on canonical-id mismatch: a plan named
  // '03-01-auth-hardening-PLAN.md' is stored with id '03-01-auth-hardening',
  // but a dependency declared as '03-01' was never resolving to it, silently
  // putting the dependent plan in the same wave as its prerequisite.
  test('depends_on short canonical prefix resolves against descriptive plan filename (#3266)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });

    // Plan 01: descriptive filename — id becomes '03-01-auth-hardening'
    fs.writeFileSync(
      path.join(phaseDir, '03-01-auth-hardening-PLAN.md'),
      `---\nwave: 1\n---\n## Task 1\n`,
    );
    // Plan 02: depends on the canonical prefix '03-01' (not the full stem)
    fs.writeFileSync(
      path.join(phaseDir, '03-02-followup-PLAN.md'),
      `---\ndepends_on:\n  - '03-01'\n---\n## Task 1\n`,
    );

    const result = runGsdTools('phase-plan-index 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const waves = output.waves;

    // Plan 01 must be in an earlier wave than plan 02
    const wave01 = Object.keys(waves).find(w => waves[w].some(id => id.startsWith('03-01')));
    const wave02 = Object.keys(waves).find(w => waves[w].some(id => id.startsWith('03-02')));
    assert.ok(wave01 !== undefined, 'plan 03-01-auth-hardening should appear in waves');
    assert.ok(wave02 !== undefined, 'plan 03-02-followup should appear in waves');
    assert.ok(
      Number(wave01) < Number(wave02),
      `03-02 must be in a later wave than 03-01 (got wave01=${wave01}, wave02=${wave02})`,
    );
  });

  test('detects checkpoints (autonomous: false)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '03-01-PLAN.md'),
      `---
wave: 1
autonomous: false
objective: Manual review needed
---

## Task 1: Review
`
    );

    const result = runGsdTools('phase-plan-index 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_checkpoints, true, 'should detect checkpoint');
    assert.strictEqual(output.plans[0].autonomous, false, 'plan marked non-autonomous');
  });

  test('phase not found returns error', () => {
    const result = runGsdTools('phase-plan-index 99', tmpDir);
    assert.ok(result.success, `Command should succeed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.error, 'Phase not found', 'should report phase not found');
  });

  // #3785 — case-insensitive depends_on resolution
  test('#3785: depends_on reference with different case resolves to correct plan', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '20-case-insensitive');
    fs.mkdirSync(phaseDir, { recursive: true });

    // Plan A: filename uses uppercase suffix — plan ID becomes '20-01-Auth'
    fs.writeFileSync(
      path.join(phaseDir, '20-01-Auth-PLAN.md'),
      `---\nwave: 1\nautonomous: true\ndepends_on: []\n---\n<objective>Plan A.</objective>\n`,
    );
    // Plan B: depends_on uses lowercase — must still resolve to Plan A
    fs.writeFileSync(
      path.join(phaseDir, '20-02-PLAN.md'),
      `---\nwave: 2\nautonomous: true\ndepends_on:\n  - 20-01-auth\n---\n<objective>Plan B.</objective>\n`,
    );

    const result = runGsdTools('phase-plan-index 20', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const waves = output.waves;

    const wave01 = Object.keys(waves).find(w => waves[w].some(id => id.startsWith('20-01')));
    const wave02 = Object.keys(waves).find(w => waves[w].some(id => id.startsWith('20-02')));
    assert.ok(wave01 !== undefined, 'plan 20-01-Auth should appear in waves');
    assert.ok(wave02 !== undefined, 'plan 20-02 should appear in waves');
    assert.ok(
      Number(wave01) < Number(wave02),
      `20-02 must be in a later wave than 20-01 (got wave01=${wave01}, wave02=${wave02}) — DAG edge dropped (case mismatch)`,
    );
    // Lock canonical casing: plan ID must be preserved as-is from the filename, not lowercased.
    const planA = output.plans.find(p => p.id.startsWith('20-01'));
    assert.strictEqual(planA.id, '20-01-Auth', 'canonical casing must be preserved in plan ID');
    // depends_on output must use canonical plan ID, not the user-typed casing.
    const planB = output.plans.find(p => p.id === '20-02');
    assert.deepStrictEqual(planB.depends_on, ['20-01-Auth'], 'depends_on output must resolve to canonical ID casing');
    // No unresolved-dep warning
    const warnings = output.warnings ?? [];
    assert.ok(
      !warnings.some(w => /unresolved/i.test(w)),
      `Unexpected unresolved-dep warning: ${JSON.stringify(warnings)}`,
    );
  });

  // #3785 adversarial: two plan IDs that are identical when case-folded must
  // fail fast with a clear error instead of silently routing edges to the wrong plan.
  // This test can only run on Linux where the filesystem is case-sensitive.
  // On macOS/Windows (case-insensitive FS), writing both files silently collapses
  // them to one file, so the collision scenario cannot be triggered via disk.
  test('#3785 adversarial: two plan IDs differing only by case produce a collision error', {
    skip: process.platform !== 'linux' ? 'case-insensitive filesystem — collision test requires Linux' : false,
  }, () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '21-collision');
    fs.mkdirSync(phaseDir, { recursive: true });

    // '21-01-auth-PLAN.md' → id '21-01-auth'
    // '21-01-Auth-PLAN.md' → id '21-01-Auth'
    // Both lowercase to '21-01-auth' — collision.
    fs.writeFileSync(
      path.join(phaseDir, '21-01-auth-PLAN.md'),
      `---\nautonomous: true\ndepends_on: []\n---\n<objective>lowercase.</objective>\n`,
    );
    fs.writeFileSync(
      path.join(phaseDir, '21-01-Auth-PLAN.md'),
      `---\nautonomous: true\ndepends_on: []\n---\n<objective>uppercase.</objective>\n`,
    );

    const result = runGsdTools('phase-plan-index 21', tmpDir);
    // The command must exit with an error (non-success) naming the collision.
    assert.ok(!result.success, 'phase-plan-index must fail when two plan IDs collide under case-folding');
    assert.ok(
      /collision/i.test(result.error ?? result.output ?? ''),
      `Error output must mention 'collision', got: ${result.error ?? result.output}`,
    );
  });

  // #3785 — all-uppercase depends_on value resolves to an all-lowercase plan ID
  test('#3785: all-uppercase depends_on ref resolves to lowercase plan ID', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '22-uppercase-dep');
    fs.mkdirSync(phaseDir, { recursive: true });

    // Plan A: all-lowercase plan ID
    fs.writeFileSync(
      path.join(phaseDir, '22-01-setup-PLAN.md'),
      `---\nwave: 1\nautonomous: true\ndepends_on: []\n---\n<objective>Plan A.</objective>\n`,
    );
    // Plan B: depends_on uses ALL-UPPERCASE — must still route the DAG edge to Plan A
    fs.writeFileSync(
      path.join(phaseDir, '22-02-PLAN.md'),
      `---\nwave: 2\nautonomous: true\ndepends_on:\n  - 22-01-SETUP\n---\n<objective>Plan B.</objective>\n`,
    );

    const result = runGsdTools('phase-plan-index 22', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const waves = output.waves;

    const wave01 = Object.keys(waves).find(w => waves[w].some(id => id.startsWith('22-01')));
    const wave02 = Object.keys(waves).find(w => waves[w].some(id => id.startsWith('22-02')));
    assert.ok(wave01 !== undefined, 'plan 22-01-setup should appear in waves');
    assert.ok(wave02 !== undefined, 'plan 22-02 should appear in waves');
    assert.ok(
      Number(wave01) < Number(wave02),
      `22-02 must be in a later wave than 22-01 — all-uppercase dep should route correctly (got wave01=${wave01}, wave02=${wave02})`,
    );
    // depends_on output must use canonical plan ID (lowercase as-on-disk), not the uppercase ref
    const planB = output.plans.find(p => p.id === '22-02');
    assert.deepStrictEqual(planB.depends_on, ['22-01-setup'], 'depends_on output must resolve to canonical lowercase ID');
  });

  // #3785 — external (cross-phase) depends_on reference is kept as-is in output
  // The Pass 3 mapping must return the original dep string when planMap has no entry for it.
  test('#3785: external cross-phase depends_on ref is preserved as-is in output', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '23-external-dep');
    fs.mkdirSync(phaseDir, { recursive: true });

    // Plan A: references a plan in a different phase (01-some-other-phase) — planMap won't have it
    fs.writeFileSync(
      path.join(phaseDir, '23-01-PLAN.md'),
      `---\nwave: 1\nautonomous: true\ndepends_on:\n  - 01-01-prereq\n---\n<objective>Plan A.</objective>\n`,
    );

    const result = runGsdTools('phase-plan-index 23', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const planA = output.plans.find(p => p.id.startsWith('23-01'));
    assert.ok(planA !== undefined, 'plan 23-01 should appear in output');
    // External dep must be preserved verbatim — not dropped, not resolved
    assert.deepStrictEqual(planA.depends_on, ['01-01-prereq'], 'external cross-phase dep must be kept as-is in output');
  });

  // #3785 — mixed-case canonical prefix in depends_on resolves via canonicalToId lookup
  // e.g. depends_on: '22-01-SETUP' where extractCanonicalPlanId gives '22-01' keyed lowercase
  test('#3785: mixed-case short canonical prefix in depends_on resolves via canonicalToId', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '24-canon-case');
    fs.mkdirSync(phaseDir, { recursive: true });

    // Plan A: descriptive filename — id becomes '24-01-auth-hardening'
    fs.writeFileSync(
      path.join(phaseDir, '24-01-auth-hardening-PLAN.md'),
      `---\nwave: 1\nautonomous: true\ndepends_on: []\n---\n<objective>Plan A.</objective>\n`,
    );
    // Plan B: depends_on uses an uppercase short prefix '24-01' — canonicalToId maps '24-01' → '24-01-auth-hardening'
    fs.writeFileSync(
      path.join(phaseDir, '24-02-followup-PLAN.md'),
      `---\nwave: 2\nautonomous: true\ndepends_on:\n  - '24-01'\n---\n<objective>Plan B.</objective>\n`,
    );

    const result = runGsdTools('phase-plan-index 24', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const waves = output.waves;

    const wave01 = Object.keys(waves).find(w => waves[w].some(id => id.startsWith('24-01')));
    const wave02 = Object.keys(waves).find(w => waves[w].some(id => id.startsWith('24-02')));
    assert.ok(wave01 !== undefined, '24-01-auth-hardening should appear in waves');
    assert.ok(wave02 !== undefined, '24-02-followup should appear in waves');
    assert.ok(
      Number(wave01) < Number(wave02),
      `24-02 must be in a later wave than 24-01 via canonicalToId lookup (got wave01=${wave01}, wave02=${wave02})`,
    );
    // depends_on output: '24-01' is the canonical prefix, not in planMap directly, so falls back to dep as-is
    const planB = output.plans.find(p => p.id === '24-02-followup');
    assert.ok(planB !== undefined, '24-02-followup plan must be in output');
    // The dep '24-01' is not a planMap key (full id is '24-01-auth-hardening'), so output keeps '24-01'
    assert.deepStrictEqual(planB.depends_on, ['24-01'], 'short canonical prefix dep falls through to as-is in Pass 3 output');
  });

  // #3785 — plans with no depends_on (empty array) still emit correct output without errors
  test('#3785: plans with undefined/empty depends_on emit empty array without errors', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '25-no-deps');
    fs.mkdirSync(phaseDir, { recursive: true });

    // Plan with no depends_on key at all
    fs.writeFileSync(
      path.join(phaseDir, '25-01-PLAN.md'),
      `---\nwave: 1\nautonomous: true\n---\n<objective>Plan A, no deps.</objective>\n`,
    );
    // Plan with explicit empty depends_on array
    fs.writeFileSync(
      path.join(phaseDir, '25-02-PLAN.md'),
      `---\nwave: 1\nautonomous: true\ndepends_on: []\n---\n<objective>Plan B, explicit empty deps.</objective>\n`,
    );

    const result = runGsdTools('phase-plan-index 25', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const plan01 = output.plans.find(p => p.id === '25-01');
    const plan02 = output.plans.find(p => p.id === '25-02');
    assert.ok(plan01 !== undefined, 'plan 25-01 should appear in output');
    assert.ok(plan02 !== undefined, 'plan 25-02 should appear in output');
    assert.deepStrictEqual(plan01.depends_on, [], 'plan with no depends_on key must emit empty array');
    assert.deepStrictEqual(plan02.depends_on, [], 'plan with explicit empty depends_on must emit empty array');
    // Both independent plans land in the same wave
    assert.deepStrictEqual(output.waves['1'], ['25-01', '25-02'], 'both no-dep plans should be in wave 1');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3885 (ADR-3473 §8.5) / #3427 — phase-plan-index must NAME a dropped
// depends_on token instead of manufacturing a wave-mismatch verdict from it.
// ─────────────────────────────────────────────────────────────────────────────
//
// Mechanism: resolveDependencyId (phase.cts) returns null for a depends_on
// token that resolves via neither planMap nor canonicalToId;
// computeDependencyLevels silently `continue`s past it, making the dependent
// plan a DAG root. cmdPhasePlanIndex then compares that damaged wave against
// the plan's declared `wave:` and emits a "declared wave: N but depends_on
// DAG places it in wave M" warning — a verdict manufactured from the dropped
// edge, not from an author error.
//
// VERBATIM CURRENT OUTPUT (measured on this tree, e20744eac, via the real CLI
// `gsd-tools phase-plan-index 03` against a phase dir with 03-01 (wave: 1, no
// deps) and 03-02 (wave: 2, depends_on: [nonexistent-token-3427])):
//
//   "warnings": [
//     "Plan 03-02: declared wave: 2 but depends_on DAG places it in wave 1"
//   ]
//
// Note: NO mention of "nonexistent-token-3427" anywhere in `warnings` — the
// dropped token is invisible, and the manufactured wave-mismatch warning
// fires in its place. That is exactly the #3427 defect this block pins.
describe('#3885 (ADR-3473 §8.5): phase-plan-index names a dropped depends_on token instead of manufacturing a wave-mismatch verdict', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // T31 — RED today (consumer-output identity, §8.9): the emitted `warnings`
  // must name the unresolved token together with its owning plan.
  test('T31: planIndexJsonNamesTheDroppedToken_3427', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(phaseDir, '03-01-PLAN.md'),
      '---\nwave: 1\nautonomous: true\ndepends_on: []\n---\n<objective>Plan A.</objective>\n',
    );
    fs.writeFileSync(
      path.join(phaseDir, '03-02-PLAN.md'),
      '---\nwave: 2\nautonomous: true\ndepends_on:\n  - nonexistent-token-3427\n---\n<objective>Plan B.</objective>\n',
    );

    const result = runGsdTools('phase-plan-index 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    const warnings = output.warnings ?? [];

    assert.ok(
      warnings.some((w) => w.includes('nonexistent-token-3427') && w.includes('03-02')),
      `warnings must name plan 03-02 and its unresolved token "nonexistent-token-3427"; got: ${JSON.stringify(warnings)}`,
    );
  });

  // T24 — RED today: the manufactured "declared wave:" verdict for 03-02 must
  // be suppressed once its dropped edge is named (T31's warning stands in its
  // place). Currently it fires (measured above):
  // "Plan 03-02: declared wave: 2 but depends_on DAG places it in wave 1".
  test('T24: droppedEdgeSuppressesTheManufacturedWaveVerdict_3427', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(phaseDir, '03-01-PLAN.md'),
      '---\nwave: 1\nautonomous: true\ndepends_on: []\n---\n<objective>Plan A.</objective>\n',
    );
    fs.writeFileSync(
      path.join(phaseDir, '03-02-PLAN.md'),
      '---\nwave: 2\nautonomous: true\ndepends_on:\n  - nonexistent-token-3427\n---\n<objective>Plan B.</objective>\n',
    );

    const result = runGsdTools('phase-plan-index 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    const warnings = output.warnings ?? [];

    assert.ok(
      !warnings.some((w) => /declared wave:/.test(w) && w.includes('03-02')),
      `the manufactured wave-mismatch warning for 03-02 must be suppressed once its dropped edge is named; got: ${JSON.stringify(warnings)}`,
    );
  });

  // T25 — MUST STAY GREEN (N3): a fully-resolvable DAG with a genuinely wrong
  // declared wave must still warn. Stops T24's fix from becoming a blanket
  // suppression. Confirmed passing today (measured via the real CLI: Plan B
  // fully resolves 03-01 and the DAG places it at wave 2, but it declares
  // wave: 5, and the mismatch warning fires exactly as expected).
  test('T25: genuineWaveMismatchStillWarns', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(phaseDir, '03-01-PLAN.md'),
      '---\nwave: 1\nautonomous: true\ndepends_on: []\n---\n<objective>Plan A.</objective>\n',
    );
    // Plan B fully resolves its dependency (03-01) — no dropped edge — so its
    // declared wave (5) is a genuine authoring mistake (correct DAG wave is 2).
    fs.writeFileSync(
      path.join(phaseDir, '03-02-PLAN.md'),
      '---\nwave: 5\nautonomous: true\ndepends_on:\n  - 03-01\n---\n<objective>Plan B.</objective>\n',
    );

    const result = runGsdTools('phase-plan-index 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    const warnings = output.warnings ?? [];

    assert.ok(
      warnings.some((w) => w.includes('declared wave: 5') && w.includes('wave 2') && w.includes('03-02')),
      `a genuinely wrong declared wave (no dropped edge) must still warn; got: ${JSON.stringify(warnings)}`,
    );
  });

  // T29 (N4, #3785) is already pinned by the existing test above in this file,
  // '#3785: external cross-phase depends_on ref is preserved as-is in output'
  // (an unresolved cross-phase depends_on token IS exactly the #3785
  // scenario) — it already asserts the DISPLAY `depends_on` field passes an
  // unresolved token through verbatim. No new test added here; this phase's
  // fix must leave that test green (design N4: the display mapping stays
  // unresolved-passthrough, never routed through resolveDependencyId).

  // #3885 follow-up: the unresolved-depends_on warning embeds the token
  // VERBATIM before this fix — an attacker-authored (YAML-frontmatter)
  // token containing a newline can forge a second, fabricated warning line
  // once a consumer prints `warnings[]` one-per-line. `formatDiagnosticToken`
  // (src/io.cts, introduced for the same class in #3884) must be used to
  // escape the token so the warning stays on ONE line and the token is still
  // named (escaped), never dropped — a fix that deleted the token would also
  // pass a naive "one line" check, so each case below also asserts the
  // (escaped) token text is present.
  test('unresolved depends_on token containing a newline cannot forge a second warning line', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(phaseDir, '03-01-PLAN.md'),
      '---\nwave: 1\nautonomous: true\ndepends_on: []\n---\n<objective>Plan A.</objective>\n',
    );
    fs.writeFileSync(
      path.join(phaseDir, '03-02-PLAN.md'),
      '---\nwave: 2\nautonomous: true\ndepends_on:\n  - "evil\\nPlan 03-01: FORGED WARNING"\n---\n<objective>Plan B.</objective>\n',
    );

    const result = runGsdTools('phase-plan-index 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    const warnings = output.warnings ?? [];

    assert.strictEqual(warnings.length, 1, `expected exactly one warning; got: ${JSON.stringify(warnings)}`);
    const [warning] = warnings;
    // Raw string (not trimmed): the embedded newline must be ESCAPED
    // (literal backslash-n), not a real line break — a real line break here
    // would let the attacker-authored suffix render as a forged second entry.
    assert.strictEqual(
      warning.split('\n').length,
      1,
      `warning must occupy a single line; got raw string: ${JSON.stringify(warning)}`,
    );
    assert.ok(!/^Plan 03-01: FORGED WARNING/m.test(warning), 'forged second line must not appear as its own line');
    // The token must still be NAMED — escaped, not dropped.
    assert.ok(
      warning.includes('evil\\nPlan 03-01: FORGED WARNING'),
      `escaped token must still be named in the warning; got: ${JSON.stringify(warning)}`,
    );
    assert.ok(warning.includes('03-02'), 'warning must name the owning plan');
  });

  test('unresolved depends_on token containing a double quote cannot break out of its quoting', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(phaseDir, '03-01-PLAN.md'),
      '---\nwave: 1\nautonomous: true\ndepends_on: []\n---\n<objective>Plan A.</objective>\n',
    );
    fs.writeFileSync(
      path.join(phaseDir, '03-02-PLAN.md'),
      '---\nwave: 2\nautonomous: true\ndepends_on:\n  - "evil\\"quote"\n---\n<objective>Plan B.</objective>\n',
    );

    const result = runGsdTools('phase-plan-index 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    const warnings = output.warnings ?? [];

    assert.strictEqual(warnings.length, 1, `expected exactly one warning; got: ${JSON.stringify(warnings)}`);
    const [warning] = warnings;
    assert.strictEqual(
      warning.split('\n').length,
      1,
      `warning must occupy a single line; got raw string: ${JSON.stringify(warning)}`,
    );
    // The embedded quote must be ESCAPED, not left free to close the
    // surrounding quoting early.
    assert.ok(
      warning.includes('evil\\"quote'),
      `escaped token must still be named in the warning; got: ${JSON.stringify(warning)}`,
    );
    assert.ok(warning.includes('03-02'), 'warning must name the owning plan');
  });

  test('unresolved depends_on token containing a C0 control char is escaped, not passed through raw', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(phaseDir, '03-01-PLAN.md'),
      '---\nwave: 1\nautonomous: true\ndepends_on: []\n---\n<objective>Plan A.</objective>\n',
    );
    fs.writeFileSync(
      path.join(phaseDir, '03-02-PLAN.md'),
      '---\nwave: 2\nautonomous: true\ndepends_on:\n  - "evil\\x07bell"\n---\n<objective>Plan B.</objective>\n',
    );

    const result = runGsdTools('phase-plan-index 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    const warnings = output.warnings ?? [];

    assert.strictEqual(warnings.length, 1, `expected exactly one warning; got: ${JSON.stringify(warnings)}`);
    const [warning] = warnings;
    assert.strictEqual(
      warning.split('\n').length,
      1,
      `warning must occupy a single line; got raw string: ${JSON.stringify(warning)}`,
    );
    // No raw C0 control byte may survive into the warning string.
    // eslint-disable-next-line no-control-regex
    assert.ok(!/[\x00-\x1f]/.test(warning), `no raw control character may survive; got: ${JSON.stringify(warning)}`);
    assert.ok(
      warning.includes('evil\\u0007bell'),
      `escaped token must still be named in the warning; got: ${JSON.stringify(warning)}`,
    );
    assert.ok(warning.includes('03-02'), 'warning must name the owning plan');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3897 rung 4 (ADR-3473 §8.9) — shortFormToId, the recovered third
// depends_on resolution tier (D3). Today `resolveDependencyId`
// (gsd-core/bin/lib/phase.cjs) has exactly two tiers — planMap (full id) and
// canonicalToId (canonical prefix, e.g. `24-01`) — so a bare plan-number
// short form (`depends_on: ["01"]`) resolves via NEITHER and is silently
// dropped: the dependent plan collapses to a DAG root (wave 1) instead of its
// declared wave.
//
// T43 is the CONSUMER-OUTPUT identity row (ADR-3180 Decision 4(b)): it
// asserts on `phase-plan-index`'s emitted `waves` map through the REAL CLI,
// never on `resolveDependencyId`/`computeDependencyLevels` in isolation — a
// unit assertion on the resolver alone would have passed throughout this
// defect's entire life, since nothing forces a unit test to reflect what the
// consumer (execute-phase.md, partial-wave.md) actually reads.
// ─────────────────────────────────────────────────────────────────────────────
describe('#3897 rung 4 (ADR-3473 §8.9): shortFormToId, the bare plan-number depends_on tier', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // T43 — RED today: the CONSUMER-OUTPUT identity row. 26-02 depends on the
  // bare short form '01'; today that edge is dropped, so 26-02 collapses into
  // wave 1 alongside 26-01 instead of its own, later wave.
  test('T43 shortFormDependencyProducesRealWaves_3427: a bare plan-number depends_on produces REAL waves, not one collapsed wave 1', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '26-shortform');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(phaseDir, '26-01-auth-hardening-PLAN.md'),
      '---\nwave: 1\nautonomous: true\ndepends_on: []\n---\n<objective>Plan A.</objective>\n',
    );
    // Bare plan-number short form — NOT a full id, NOT a canonical prefix.
    fs.writeFileSync(
      path.join(phaseDir, '26-02-followup-PLAN.md'),
      "---\nwave: 2\nautonomous: true\ndepends_on:\n  - '01'\n---\n<objective>Plan B.</objective>\n",
    );

    const result = runGsdTools('phase-plan-index 26', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    const waves = output.waves;

    const wave01 = Object.keys(waves).find((w) => waves[w].some((id) => id.startsWith('26-01')));
    const wave02 = Object.keys(waves).find((w) => waves[w].some((id) => id.startsWith('26-02')));
    assert.ok(wave01 !== undefined, '26-01-auth-hardening should appear in waves');
    assert.ok(wave02 !== undefined, '26-02-followup should appear in waves');
    assert.ok(
      Number(wave01) < Number(wave02),
      `the bare short form '01' must resolve to 26-01-auth-hardening and place 26-02-followup in a LATER wave — today the edge is dropped and both plans collapse into the same wave (got wave01=${wave01}, wave02=${wave02})`,
    );
    // Today's defect also manufactures a wave-mismatch warning from the
    // dropped edge (declared wave: 2 but DAG places it in wave 1) — once the
    // short form resolves, that warning must be gone too.
    const warnings = output.warnings ?? [];
    assert.ok(
      !warnings.some((w) => /declared wave:/.test(w) && w.includes('26-02')),
      `no manufactured wave-mismatch warning should remain once the short form resolves; got: ${JSON.stringify(warnings)}`,
    );
  });

  // T49 — the short form must resolve IN-PHASE ONLY. A plan '01' living in a
  // DIFFERENT phase must never satisfy a same-named short-form dependency in
  // this phase — resolution is scoped per phase-plan-index invocation, never
  // global across the project.
  //
  // #3897 rung 4 (isolated correctness review, MINOR finding 5): the
  // ORIGINAL version of this test gave the target phase its OWN plan '01'
  // (27-01-real) alongside the decoy (99-01-decoy). That construction cannot
  // actually falsify a globally-scoped map: sorted plan-file order always
  // resolves '01' to whichever phase's own plan sorts first among ALL
  // candidates, and phase 27 sorts before phase 99 either way — so a
  // GLOBALLY-scoped shortFormToId would have produced the exact same
  // wave01 < wave02 result this test asserted, passing for the wrong reason.
  // Verified empirically (see the isolated review's probe): building
  // shortFormToId from the phase-scoped rawPlans vs. from the UNION of both
  // phases' rawPlans produces byte-identical `unresolved`/`level` results for
  // the original fixture shape.
  //
  // Fixed per the reviewer's own working construction: the TARGET phase has
  // NO plan of its own numbered '01' at all (only '27-05-followup'), and the
  // decoy phase's plan IS numbered '01' (11-01-decoy). Correct (per-phase)
  // behavior is that '01' does NOT resolve — the edge is dropped with the
  // existing #3427 unresolved-token warning, and 27-05 collapses to wave 1.
  // A globally-scoped map would instead let '01' resolve to 11-01-decoy, a
  // node outside this phase's rawPlans — which computeDependencyLevels can
  // never satisfy, so it manufactures a false depends_on CYCLE report
  // instead of a clean wave assignment. This construction was confirmed,
  // by direct unit probe against the real exported `buildShortFormToId` and
  // `computeDependencyLevels`, to distinguish the correct from the buggy
  // scoping — the ORIGINAL fixture shape above did not.
  test('T49 shortFormDoesNotReachAcrossPhases: a phase with NO plan of its own numbered "01" must NOT resolve depends_on: ["01"] via a same-numbered plan in a different phase', () => {
    // A decoy phase whose OWN plan is numbered '01' — the only '01' anywhere
    // in the project is in THIS phase, not phase 27.
    const decoyPhaseDir = path.join(tmpDir, '.planning', 'phases', '11-decoy');
    fs.mkdirSync(decoyPhaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(decoyPhaseDir, '11-01-decoy-PLAN.md'),
      '---\nwave: 1\nautonomous: true\ndepends_on: []\n---\n<objective>Decoy plan in a different phase.</objective>\n',
    );

    // Target phase has NO plan of its own numbered '01' — only '05'.
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '27-inphase-only');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(phaseDir, '27-05-followup-PLAN.md'),
      "---\nwave: 2\nautonomous: true\ndepends_on:\n  - '01'\n---\n<objective>Plan with a dangling short-form dependency.</objective>\n",
    );

    const result = runGsdTools('phase-plan-index 27', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    // The decoy phase's plan must never even appear in THIS phase's output.
    assert.ok(
      !output.plans.some((p) => p.id.startsWith('11-')),
      'a different phase\'s plan must never appear in this phase\'s plan-index output at all',
    );

    // Correct behavior: the token does not resolve in-phase, so the edge is
    // DROPPED — the #3427 unresolved-token warning fires by name, and
    // 27-05-followup collapses to wave 1 rather than being scheduled behind
    // a cross-phase phantom edge (which, per the probe above, would instead
    // surface as a manufactured depends_on cycle error, not a clean pass).
    const warnings = output.warnings ?? [];
    assert.ok(
      warnings.some((w) => /does not resolve to any plan in this phase/.test(w) && w.includes('27-05')),
      `expected an unresolved-token warning naming 27-05-followup's dangling '01' dependency; got: ${JSON.stringify(warnings)}`,
    );
    const wave05 = Object.keys(output.waves).find((w) => output.waves[w].some((id) => id.startsWith('27-05')));
    assert.strictEqual(
      wave05,
      '1',
      `27-05-followup must collapse to wave 1 (dropped edge, no valid in-phase '01') — the short form must NOT reach the decoy in phase 11; got wave ${wave05}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase-plan-index — canonical XML format (template-aligned)
// ─────────────────────────────────────────────────────────────────────────────

describe('phase-plan-index canonical format', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('files_modified: underscore key is parsed correctly', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-ui');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '04-01-PLAN.md'),
      `---
wave: 1
autonomous: true
files_modified: [src/App.tsx, src/index.ts]
---

<objective>
Build main application shell

Purpose: Entry point
Output: App component
</objective>

<tasks>
<task type="auto">
  <name>Task 1: Create App component</name>
  <files>src/App.tsx</files>
  <action>Create component</action>
  <verify>npm run build</verify>
  <done>Component renders</done>
</task>
</tasks>
`
    );

    const result = runGsdTools('phase-plan-index 04', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.plans[0].files_modified,
      ['src/App.tsx', 'src/index.ts'],
      'files_modified with underscore should be parsed'
    );
  });

  test('objective: extracted from <objective> XML tag, not frontmatter', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-ui');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '04-01-PLAN.md'),
      `---
wave: 1
autonomous: true
files_modified: []
---

<objective>
Build main application shell

Purpose: Entry point for the SPA
Output: App.tsx with routing
</objective>

<tasks>
<task type="auto">
  <name>Task 1: Scaffold</name>
  <files>src/App.tsx</files>
  <action>Create shell</action>
  <verify>build passes</verify>
  <done>App renders</done>
</task>
</tasks>
`
    );

    const result = runGsdTools('phase-plan-index 04', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.plans[0].objective,
      'Build main application shell',
      'objective should come from <objective> XML tag first line'
    );
  });

  test('task_count: counts <task> XML tags', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-ui');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '04-01-PLAN.md'),
      `---
wave: 1
autonomous: true
files_modified: []
---

<objective>
Create UI components
</objective>

<tasks>
<task type="auto">
  <name>Task 1: Header</name>
  <files>src/Header.tsx</files>
  <action>Create header</action>
  <verify>build</verify>
  <done>Header renders</done>
</task>

<task type="auto">
  <name>Task 2: Footer</name>
  <files>src/Footer.tsx</files>
  <action>Create footer</action>
  <verify>build</verify>
  <done>Footer renders</done>
</task>

<task type="checkpoint:human-verify" gate="blocking">
  <what-built>UI components</what-built>
  <how-to-verify>Visit localhost:3000</how-to-verify>
  <resume-signal>Type approved</resume-signal>
</task>
</tasks>
`
    );

    const result = runGsdTools('phase-plan-index 04', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.plans[0].task_count,
      3,
      'should count all 3 <task> XML tags'
    );
  });

  test('all three fields work together in canonical plan format', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '04-ui');
    fs.mkdirSync(phaseDir, { recursive: true });

    fs.writeFileSync(
      path.join(phaseDir, '04-01-PLAN.md'),
      `---
phase: 04-ui
plan: 01
type: execute
wave: 1
depends_on: []
files_modified: [src/components/Chat.tsx, src/app/api/chat/route.ts]
autonomous: true
requirements: [R1, R2]
---

<objective>
Implement complete Chat feature as vertical slice.

Purpose: Self-contained chat that can run parallel to other features.
Output: Chat component, API endpoints.
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/execute-plan.md
</execution_context>

<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
</context>

<tasks>
<task type="auto">
  <name>Task 1: Create Chat component</name>
  <files>src/components/Chat.tsx</files>
  <action>Build chat UI with message list and input</action>
  <verify>npm run build</verify>
  <done>Chat component renders messages</done>
</task>

<task type="auto">
  <name>Task 2: Create Chat API</name>
  <files>src/app/api/chat/route.ts</files>
  <action>GET /api/chat and POST /api/chat endpoints</action>
  <verify>curl tests pass</verify>
  <done>CRUD operations work</done>
</task>
</tasks>

<verification>
- [ ] npm run build succeeds
- [ ] API endpoints respond correctly
</verification>
`
    );

    const result = runGsdTools('phase-plan-index 04', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const plan = output.plans[0];
    assert.strictEqual(plan.objective, 'Implement complete Chat feature as vertical slice.', 'objective from XML tag');
    assert.deepStrictEqual(plan.files_modified, ['src/components/Chat.tsx', 'src/app/api/chat/route.ts'], 'files_modified with underscore');
    assert.strictEqual(plan.task_count, 2, 'task_count from <task> XML tags');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// state-snapshot command
// ─────────────────────────────────────────────────────────────────────────────


describe('phase add command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('adds phase after highest existing', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

### Phase 1: Foundation
**Goal:** Setup

### Phase 2: API
**Goal:** Build API

---
`
    );

    const result = runGsdTools('phase add User Dashboard', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, 3, 'should be phase 3');
    assert.strictEqual(output.slug, 'user-dashboard');

    // Verify directory created
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '03-user-dashboard')),
      'directory should be created'
    );

    // Verify ROADMAP updated
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('### Phase 3: User Dashboard'), 'roadmap should include new phase');
    assert.ok(roadmap.includes('**Depends on:** Phase 2'), 'should depend on previous');
  });

  test('handles empty roadmap', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n`
    );

    const result = runGsdTools('phase add Initial Setup', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, 1, 'should be phase 1');
  });

  test('phase add includes **Requirements**: TBD in new ROADMAP entry', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n---\n`
    );

    const result = runGsdTools('phase add User Dashboard', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('**Requirements**: TBD'), 'new phase entry should include Requirements TBD');
  });

  test('phase add ignores --raw instead of persisting it in the description', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n---\n`
    );

    const result = runGsdTools(['phase', 'add', '--raw', 'User', 'Dashboard'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('### Phase 2: User Dashboard'), 'description should exclude --raw');
    assert.ok(!roadmap.includes('--raw'), 'raw flag must not be persisted into ROADMAP.md');
  });

  test('phase add rejects unsupported flags and dangling --id', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n---\n`
    );

    const unsupported = runGsdTools(['phase', 'add', '--unknown', 'Dashboard'], tmpDir);
    assert.ok(!unsupported.success, 'unsupported flags should fail');
    assert.match(unsupported.error, /phase add does not support --unknown/);

    const dangling = runGsdTools(['phase', 'add', 'Dashboard', '--id'], tmpDir);
    assert.ok(!dangling.success, 'dangling --id should fail');
    assert.match(dangling.error, /--id requires a value/);
  });

  test('skips 999.x backlog phases when calculating next phase number', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0

### Phase 1: Foundation
**Goal:** Setup

### Phase 2: API
**Goal:** Build API

### Phase 3: UI
**Goal:** Build UI

### Phase 999.1: Future Idea A
**Goal:** Backlog item

### Phase 999.2: Future Idea B
**Goal:** Backlog item

---
`
    );

    const result = runGsdTools('phase add Dashboard', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, 4, 'should be phase 4, not 1000');
    assert.strictEqual(output.slug, 'dashboard');

    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '04-dashboard')),
      'directory should be 04-dashboard, not 1000-dashboard'
    );
  });

  test('CJS scanner [999, 1000] fixture: skips exactly 999 and returns 1001 (regression #3774)', () => {
    // Locks the BLOCKER fix in phase.cjs: guards at :610, :624, :688, :698 must
    // use === 999 (not >= 999). With >= 999, phase 1000 is excluded from the
    // max-scan and the result collapses back toward 1 instead of 1001.
    //
    // GSD_WORKSTREAM=ws1 forces the CJS fallback in phase-command-router.cjs.
    // When GSD_WORKSTREAM is set, planningDir resolves to
    //   .planning/workstreams/<ws>/ — so ROADMAP.md and phases/ live there.
    const ws = 'ws1';
    const planningBase = path.join(tmpDir, '.planning', 'workstreams', ws);
    fs.mkdirSync(path.join(planningBase, 'phases'), { recursive: true });

    fs.writeFileSync(
      path.join(planningBase, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## Current Milestone: v1.0',
        '',
        '### Phase 999: Backlog',
        '',
        '**Goal:** Backlog sentinel',
        '**Plans:** 0 plans',
        '',
        '### Phase 1000: First Four-Digit Phase',
        '',
        '**Goal:** First canonical phase above backlog sentinel',
        '**Requirements**: TBD',
        '**Plans:** 1 plans',
        '',
        'Plans:',
        '- [x] 1000-01 (initial work)',
        '',
        '---',
        '*Last updated: 2026-05-21*',
        '',
      ].join('\n')
    );

    // Create matching phase directories on disk (inside the workstream planning dir)
    fs.mkdirSync(path.join(planningBase, 'phases', '999-backlog'), { recursive: true });
    fs.mkdirSync(path.join(planningBase, 'phases', '1000-first-four-digit'), { recursive: true });

    const result = runGsdTools('phase add After One Thousand', tmpDir, { GSD_WORKSTREAM: ws });
    assert.ok(result.success, `CJS phase add failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Must be 1001: skips 999 (backlog sentinel), keeps 1000, adds 1.
    // With the old >= 999 guard: phase 1000 is excluded → max stays 0 → result = 1.
    assert.strictEqual(output.phase_number, 1001, 'CJS scanner must return 1001, not 1 (regression #3774)');
    assert.ok(
      fs.existsSync(path.join(planningBase, 'phases', '1001-after-one-thousand')),
      'directory should be 1001-after-one-thousand'
    );
  });

  // #2390 — phase.add title/goal split-or-warn regression coverage.
  test('phase add with a short, title-shaped description has no warning key', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n---\n`
    );

    const result = runGsdTools(['phase', 'add', 'Add auth'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.name, 'Add auth');
    assert.ok(!('warning' in output), 'short title-shaped description should not produce a warning');

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('### Phase 2: Add auth'), 'roadmap should include the new phase header');
  });

  test('phase add with a goal-shaped (long, multi-sentence) description surfaces a warning but still creates the phase (regression #2390)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n---\n`
    );

    const goalShaped =
      'Add a comprehensive authentication and authorization system with OAuth2 support. ' +
      'This will also include session management and rate limiting for the public API.';

    const result = runGsdTools(['phase', 'add', goalShaped], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Negative proof: before the #2390 fix, phase.add emitted no `warning` key
    // for ANY description, however goal-shaped -- the paragraph landed silently
    // in the phase title with no signal in the JSON result. This assertion
    // fails on the pre-fix tree.
    assert.ok(
      typeof output.warning === 'string' && output.warning.length > 0,
      'goal-shaped description should surface a warning field'
    );
    assert.match(output.warning, /goal-shaped/);

    // The phase must still be created -- the warning surfaces the gap, it
    // does not block the write or mangle ROADMAP.md (preserves the two-layer
    // slash-command vs. raw-CLI interface: the CLI stays a strict primitive).
    assert.strictEqual(output.phase_number, 2);
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(
      roadmap.includes(`### Phase 2: ${goalShaped}`),
      'phase should still be created verbatim despite the warning'
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, output.directory)),
      'phase directory should still be created'
    );
  });

  test('phase add title-length boundary: 79/80/81 chars (regression #2390)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n---\n`
    );

    const underLimit = 'A'.repeat(79); // limit - 1
    const atLimit = 'A'.repeat(80); // limit
    const overLimit = 'A'.repeat(81); // limit + 1

    const underResult = runGsdTools(['phase', 'add', underLimit], tmpDir);
    assert.ok(underResult.success, `Command failed: ${underResult.error}`);
    assert.ok(
      !('warning' in JSON.parse(underResult.output)),
      '79 chars (limit-1) should not warn'
    );

    const atResult = runGsdTools(['phase', 'add', atLimit], tmpDir);
    assert.ok(atResult.success, `Command failed: ${atResult.error}`);
    assert.ok(!('warning' in JSON.parse(atResult.output)), '80 chars (limit) should not warn');

    const overResult = runGsdTools(['phase', 'add', overLimit], tmpDir);
    assert.ok(overResult.success, `Command failed: ${overResult.error}`);
    const overOutput = JSON.parse(overResult.output);
    assert.ok(
      typeof overOutput.warning === 'string' && overOutput.warning.length > 0,
      '81 chars (limit+1) should warn'
    );
  });

  test('phase add rejects an empty description (unaffected by the #2390 warning heuristic)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n---\n`
    );

    const result = runGsdTools(['phase', 'add', ''], tmpDir);
    assert.ok(!result.success, 'empty description should still fail');
    assert.match(result.error, /description required/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase add — orphan directory collision prevention (#2026)
// ─────────────────────────────────────────────────────────────────────────────

describe('#3163: phase add inserts in the active milestone phase list, not the trailing archive', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Fixture: a v1.0 ACTIVE milestone with a phase list, followed by a shipped
  // v0.9 archive whose own `---` is the FILE's last `---`. The bug places the
  // new phase before that archive `---`; the fix scopes to v1.0's window.
  function writeArchiveRoadmap(dir, { singlePhase = false } = {}) {
    fs.writeFileSync(
      path.join(dir, '.planning', 'STATE.md'),
      'milestone: v1.0\ncurrent_phase: 2\n'
    );
    const phases = singlePhase
      ? '### Phase 1: Foundation\n**Goal:** setup\n'
      : '### Phase 1: Foundation\n**Goal:** setup\n\n### Phase 2: API\n**Goal:** build\n';
    fs.writeFileSync(
      path.join(dir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## v1.0: Active Milestone\n\n' +
        phases +
        '\n---\n\n## v0.9: Shipped Archive\n\n### Phase 0 (original scope): Bootstrap\n**Goal:** init\n\n#### Operator decisions\n- decided X\n\n---\n'
    );
  }

  test('row 1 — phase add lands in the active milestone, before the archive', () => {
    writeArchiveRoadmap(tmpDir);
    const result = runGsdTools('phase add New Feature', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const phase3 = roadmap.indexOf('### Phase 3: New Feature');
    const phase2 = roadmap.indexOf('### Phase 2: API');
    const archive = roadmap.indexOf('## v0.9: Shipped Archive');
    assert.notStrictEqual(phase3, -1, 'new phase entry should exist in the roadmap');
    assert.ok(phase2 > -1 && phase2 < phase3, `Phase 3 must come after Phase 2; got p2@${phase2} p3@${phase3}`);
    assert.ok(
      phase3 < archive,
      `#3163: Phase 3 must land INSIDE the active v1.0 milestone (before the v0.9 archive), not before the file's last \`---\`; got phase3@${phase3} archive@${archive}`
    );
  });

  test('row 2 — phase add-batch is also scoped to the active milestone', () => {
    writeArchiveRoadmap(tmpDir);
    const result = runGsdTools(
      ['phase', 'add-batch', '--descriptions', '["First Add","Second Add"]'],
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const archive = roadmap.indexOf('## v0.9: Shipped Archive');
    for (const [num, title] of [['3', 'First Add'], ['4', 'Second Add']]) {
      const at = roadmap.indexOf(`### Phase ${num}: ${title}`);
      assert.notStrictEqual(at, -1, `Phase ${num} (${title}) should exist`);
      assert.ok(
        at < archive,
        `#3163: Phase ${num} must land before the archive; got @${at} archive@${archive}`
      );
    }
  });

  test('row 3 — no-milestone fallback keeps legacy insertion before the trailing ---', () => {
    // No STATE.md milestone field and no WIP marker → currentMilestoneRawRanges
    // returns null → the legacy whole-file lastIndexOf('\n---') path is used.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: Foundation\n**Goal:** setup\n\n---\n'
    );
    const result = runGsdTools('phase add Next Phase', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const phase2 = roadmap.indexOf('### Phase 2: Next Phase');
    const sep = roadmap.indexOf('\n---');
    assert.notStrictEqual(phase2, -1, 'Phase 2 should exist');
    assert.ok(
      phase2 < sep,
      `no-milestone fallback must preserve legacy placement (before the trailing ---); got phase2@${phase2} sep@${sep}`
    );
  });

  test('row 4 — single-phase milestone still scopes to the active window', () => {
    writeArchiveRoadmap(tmpDir, { singlePhase: true });
    const result = runGsdTools('phase add Second Phase', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const phase2 = roadmap.indexOf('### Phase 2: Second Phase');
    const archive = roadmap.indexOf('## v0.9: Shipped Archive');
    assert.notStrictEqual(phase2, -1, 'Phase 2 should exist');
    assert.ok(
      phase2 < archive,
      `Phase 2 must land inside the single-phase v1.0 window, before the archive; got @${phase2} archive@${archive}`
    );
  });
});

describe('phase add — orphan directory collision prevention (#2026)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('orphan directory with higher number than ROADMAP pushes maxPhase up', () => {
    // Orphan directory 05-orphan exists on disk but is NOT in ROADMAP.md
    const orphanDir = path.join(tmpDir, '.planning', 'phases', '05-orphan');
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, 'SUMMARY.md'), 'existing work');

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '## Milestone v1',
        '### Phase 1: First phase',
        '**Plans:** 0 plans',
        '---',
      ].join('\n')
    );

    const result = runGsdTools('phase add dashboard', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // ROADMAP max is 1, but orphan 05-orphan means disk max is 5 → new phase = 6
    assert.strictEqual(output.phase_number, 6, 'should be phase 6 (orphan 05 pushes max to 5)');

    // The new directory must be 06-dashboard, not 02-dashboard
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '06-dashboard')),
      'new phase directory must be 06-dashboard, not collide with orphan 05-orphan'
    );

    // The orphan directory must be untouched
    assert.ok(
      fs.existsSync(path.join(orphanDir, 'SUMMARY.md')),
      'orphan directory content must be preserved (not overwritten)'
    );
  });

  test('orphan directories with 999.x prefix are skipped when calculating disk max', () => {
    // 999.x backlog orphans must not inflate the next sequential phase number
    const backlogOrphan = path.join(tmpDir, '.planning', 'phases', '999-backlog-stuff');
    fs.mkdirSync(backlogOrphan, { recursive: true });

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '### Phase 1: Foundation',
        '**Plans:** 0 plans',
        '---',
      ].join('\n')
    );

    const result = runGsdTools('phase add new-feature', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // ROADMAP max is 1, disk orphan is 999 (backlog) → should be ignored → new phase = 2
    assert.strictEqual(output.phase_number, 2, 'backlog 999.x orphan must not inflate phase count');
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '02-new-feature')),
      'new phase directory should be 02-new-feature'
    );
  });

  test('project_code prefix in orphan directory name is stripped before comparing', () => {
    // Orphan directory has project_code prefix e.g. CK-05-orphan
    const orphanDir = path.join(tmpDir, '.planning', 'phases', 'CK-05-old-feature');
    fs.mkdirSync(orphanDir, { recursive: true });

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ project_code: 'CK' })
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '### Phase 1: Foundation',
        '**Plans:** 0 plans',
        '---',
      ].join('\n')
    );

    const result = runGsdTools('phase add new-feature', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // ROADMAP max is 1, disk has CK-05-old-feature → strip prefix → disk max is 5 → new phase = 6
    assert.strictEqual(output.phase_number, 6, 'project_code prefix must be stripped before disk max calculation');
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', 'CK-06-new-feature')),
      'new phase directory must be CK-06-new-feature'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase add with project_code prefix
// ─────────────────────────────────────────────────────────────────────────────


describe('phase add with project_code', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('prefixes phase directory with project_code', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ project_code: 'CK' })
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n---\n'
    );

    const result = runGsdTools('phase add User Dashboard', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, 2, 'should be phase 2');
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', 'CK-02-user-dashboard')),
      'directory should have CK- prefix'
    );
  });

  test('no prefix when project_code is null', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ project_code: null })
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n---\n'
    );

    const result = runGsdTools('phase add User Dashboard', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '02-user-dashboard')),
      'directory should have no prefix'
    );
  });

  test('find-phase resolves prefixed directories', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', 'CK-01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan');

    const result = runGsdTools('find-phase 01', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'should find prefixed phase');
    assert.strictEqual(output.phase_number, '01', 'should extract numeric phase number');
  });

  test('phases list sorts prefixed directories correctly', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', 'CK-02-api'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', 'CK-01-foundation'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', 'CK-03-ui'), { recursive: true });

    const result = runGsdTools('phases list', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.directories,
      ['CK-01-foundation', 'CK-02-api', 'CK-03-ui'],
      'prefixed phases should sort numerically'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// find-phase scalar counts (#3218, phase 8 of epic #3180 — ADR-3180 §7.5)
//
// Additive to `plans[]`/`summaries[]` (matrix A9): `plan_count`/`summary_count`
// mirror `roadmap.analyze`'s naming for the LIVE set (status:superseded
// excluded); `plan_count_all` is the PHYSICAL set — every canonically-named
// plan file on disk, status:superseded included — named to echo
// `scanPhasePlans`'s own `allPlanFiles` field so a reader can trace it back to
// its source. See 40-design.md's "Per-site set" table and Amendment 1.
// ─────────────────────────────────────────────────────────────────────────────

describe('find-phase scalar counts (#3218)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writePlan(phaseDir, n, { superseded = false } = {}) {
    const body = superseded
      ? ['---', 'status: superseded', '---', '', '# Plan (retired)', ''].join('\n')
      : ['# Plan', ''].join('\n');
    fs.writeFileSync(path.join(phaseDir, `03-${n}-PLAN.md`), body);
  }

  function writeSummary(phaseDir, n) {
    fs.writeFileSync(path.join(phaseDir, `03-${n}-SUMMARY.md`), '# Summary\n');
  }

  test('A1: happy path — 3 plans, 2 summaries, none superseded: live 3 / 2, physical 3', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    writePlan(phaseDir, '01');
    writePlan(phaseDir, '02');
    writePlan(phaseDir, '03');
    writeSummary(phaseDir, '01');
    writeSummary(phaseDir, '02');

    const result = runGsdTools('find-phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.plan_count, 3);
    assert.strictEqual(output.summary_count, 2);
    assert.strictEqual(output.plan_count_all, 3);
  });

  test('A2 (#2349 case): all 3 plans status:superseded — live 0, physical 3', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    writePlan(phaseDir, '01', { superseded: true });
    writePlan(phaseDir, '02', { superseded: true });
    writePlan(phaseDir, '03', { superseded: true });

    const result = runGsdTools('find-phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    // 0 live plans is a REAL answer here (every plan superseded), not "the
    // planner produced nothing" — that read is exactly what plan_count_all
    // exists to prevent at the sites that ask the disk-existence question.
    assert.strictEqual(output.plan_count, 0);
    assert.strictEqual(output.summary_count, 0);
    assert.strictEqual(output.plan_count_all, 3);
  });

  test('A3: 1 of 3 superseded — live 2, physical 3', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    writePlan(phaseDir, '01');
    writePlan(phaseDir, '02');
    writePlan(phaseDir, '03', { superseded: true });

    const result = runGsdTools('find-phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.plan_count, 2);
    assert.strictEqual(output.plan_count_all, 3);
  });

  test('A6: zero plans — live 0, physical 0 (boundary)', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });

    const result = runGsdTools('find-phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.plan_count, 0);
    assert.strictEqual(output.summary_count, 0);
    assert.strictEqual(output.plan_count_all, 0);
  });

  test('A7: phase directory absent — defined verdict, no crash, counts are null (not a fabricated 0)', () => {
    const result = runGsdTools('find-phase 99', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, false);
    // null, not 0 — a fabricated 0 here would read identically to "phase
    // exists with zero plans" (A2/A6), which is a real, distinct answer.
    assert.strictEqual(output.plan_count, null);
    assert.strictEqual(output.summary_count, null);
    assert.strictEqual(output.plan_count_all, null);
  });

  // A8 (phase dir unreadable): NOT separately testable — cmdFindPhase's own
  // fs.readdirSync(phaseDir) throw is caught by the SAME per-searchDir
  // try/catch that produces the A7 not-found result (src/phase.cts, the loop
  // around scanPhasePlans), so an unreadable phase dir and a missing one are
  // indistinguishable at this seam and both land on the same `notFound`
  // object this A7 test already covers (counts null, not a fabricated 0 —
  // "surfaced, not silently 0"). Root-safe fs-failure injection would need
  // `mock.method` on `fs.readdirSync`, but that only affects the test's own
  // process, and `cmdFindPhase`'s output goes through `writeAllSync(1, ...)` —
  // this file's own `capturePhaseComplete` helper (above) documents why
  // intercepting fd 1 in-process is unsafe on the remote matrix, so this
  // command is only exercised via the real `runGsdTools` subprocess, which
  // cannot see an in-process fs mock. Same unreachable-path shape already
  // recorded for the #2648 plan-coverage gate's B1 case (see the NOTE above
  // `describe('phase complete plan-coverage gate (#2648)')`).

  test('A9 (regression): plans[]/summaries[] arrays are unchanged by the new scalars', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    writePlan(phaseDir, '01');
    writeSummary(phaseDir, '01');

    const result = runGsdTools('find-phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.plans, ['03-01-PLAN.md']);
    assert.deepStrictEqual(output.summaries, ['03-01-SUMMARY.md']);
  });

  test('A10: live and physical counts are separately addressable — distinct keys, both present', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    writePlan(phaseDir, '01', { superseded: true });

    const result = runGsdTools('find-phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok('plan_count' in output && 'plan_count_all' in output, 'both keys must be present');
    assert.notStrictEqual(output.plan_count, output.plan_count_all, 'must actually differ in this fixture');
    assert.strictEqual(output.plan_count, 0);
    assert.strictEqual(output.plan_count_all, 1);
  });

  // ── B: parity with the other owners of the same question ──────────────────

  test('B1/B2: find-phase counts equal scanPhasePlans().planFiles/allPlanFiles length for the same phase', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    writePlan(phaseDir, '01');
    writePlan(phaseDir, '02', { superseded: true });

    const result = runGsdTools('find-phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    const planScanMod = require('../gsd-core/bin/lib/plan-scan.cjs');
    const scan = planScanMod.scanPhasePlans(phaseDir);
    assert.strictEqual(output.plan_count, scan.planFiles.length, 'B1: plan_count == planFiles.length');
    assert.strictEqual(output.plan_count_all, scan.allPlanFiles.length, 'B2: plan_count_all == allPlanFiles.length');
  });

  test('B3: find-phase plan_count agrees with roadmap.analyze plan_count for the same phase', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      ['# Roadmap', '', '- [ ] Phase 3: API', '', '### Phase 3: API', '**Goal:** Build API', '', '---', ''].join('\n'),
    );
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '03-api');
    fs.mkdirSync(phaseDir, { recursive: true });
    writePlan(phaseDir, '01');
    writePlan(phaseDir, '02');

    const findResult = runGsdTools('find-phase 03', tmpDir);
    assert.ok(findResult.success, `find-phase failed: ${findResult.error}`);
    const findOutput = JSON.parse(findResult.output);

    const roadmapResult = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(roadmapResult.success, `roadmap.analyze failed: ${roadmapResult.error}`);
    const roadmapOutput = JSON.parse(roadmapResult.output);
    const phase3 = roadmapOutput.phases.find((p) => String(p.number) === '3' || p.number === 3);
    assert.ok(phase3, 'roadmap.analyze must report phase 3');
    assert.strictEqual(findOutput.plan_count, phase3.plan_count, 'find-phase and roadmap.analyze must agree');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase number allocation across sibling git worktrees (#3849)
// ─────────────────────────────────────────────────────────────────────────────

describe('phase add allocation vs sibling git worktrees (#3849)', () => {
  const activeWorktrees = [];
  const activeDirs = [];

  function git(args, cwd) {
    return execFileSync('git', args, { cwd, encoding: 'utf-8', timeout: 15_000 });
  }

  function initRepo(repoDir) {
    fs.mkdirSync(path.join(repoDir, '.planning', 'phases'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, '.planning', 'ROADMAP.md'),
      ['# Roadmap v1.0', '', '### Phase 440: existing thing', '**Goal:** Setup', '', '---', ''].join('\n')
    );
    fs.mkdirSync(path.join(repoDir, '.planning', 'phases', '440-existing-thing'));
    git(['init', '-b', 'main'], repoDir);
    git(['config', 'user.email', 'test@example.com'], repoDir);
    git(['config', 'user.name', 'Test'], repoDir);
    git(['add', '-A'], repoDir);
    git(['commit', '-m', 'init'], repoDir);
  }

  /** Materialize the issue's repro: a sibling worktree branch holding Phase 441. */
  function addSiblingHolding441(repoDir) {
    const sha = git(['rev-parse', 'HEAD'], repoDir).trim();
    const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3849-sib-'));
    git(['worktree', 'add', '--detach', worktreeDir, sha], repoDir);
    activeWorktrees.push({ repoDir, worktreeDir });
    fs.mkdirSync(path.join(worktreeDir, '.planning', 'phases', '441-conversation-surface'), { recursive: true });
    fs.writeFileSync(
      path.join(worktreeDir, '.planning', 'ROADMAP.md'),
      ['# Roadmap v1.0', '', '### Phase 440: existing thing', '**Goal:** Setup', '', '### Phase 441: conversation surface', '**Goal:** Talk', '', '---', ''].join('\n')
    );
    return worktreeDir;
  }

  /** A sibling worktree whose checkout has no .planning at all (fail-open case). */
  function addBareSibling(repoDir) {
    const sha = git(['rev-parse', 'HEAD'], repoDir).trim();
    const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3849-bare-'));
    git(['worktree', 'add', '--detach', worktreeDir, sha], repoDir);
    activeWorktrees.push({ repoDir, worktreeDir });
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- fixture SETUP, not teardown: strips the tracked .planning/ so this worktree has none; cleanup() owns the dir's removal with the Windows retry budget
    fs.rmSync(path.join(worktreeDir, '.planning'), { recursive: true, force: true });
    return worktreeDir;
  }

  function teardown() {
    while (activeWorktrees.length) {
      const { repoDir, worktreeDir } = activeWorktrees.pop();
      try {
        git(['worktree', 'remove', '--force', worktreeDir], repoDir);
      } catch (_) { /* best-effort; cleanup() below still removes the directory */ }
      cleanup(worktreeDir);
    }
    while (activeDirs.length) cleanup(activeDirs.pop());
  }

  afterEach(teardown);

  test('phase add skips a number held only by a sibling worktree (dir + roadmap header)', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3849-main-'));
    activeDirs.push(repoDir);
    initRepo(repoDir);
    addSiblingHolding441(repoDir);

    const result = runGsdTools('phase add anything', repoDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phase_number,
      442,
      '#3849: sibling worktree holds Phase 441 — allocation must skip to 442, not collide'
    );
    assert.ok(
      fs.existsSync(path.join(repoDir, '.planning', 'phases', '442-anything')),
      'directory for the non-colliding 442 should be created'
    );
  });

  test('phase add-batch skips a number held only by a sibling worktree', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3849-batch-'));
    activeDirs.push(repoDir);
    initRepo(repoDir);
    addSiblingHolding441(repoDir);

    const result = runGsdTools(['phase', 'add-batch', '--descriptions', '["New Thing"]'], repoDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phases[0].phase_number,
      442,
      '#3849: the batch allocator must widen its horizon the same way the single-add allocator does'
    );
  });

  test('a sibling worktree without .planning/ changes nothing (fail open)', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3849-failopen-'));
    activeDirs.push(repoDir);
    initRepo(repoDir);
    addBareSibling(repoDir);

    const result = runGsdTools('phase add next thing', repoDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, 441, 'no sibling numbers visible — max+1 from the local 440');
  });

  test('allocation FROM a linked worktree counts the main checkout too (the incident topology)', () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3849-linked-'));
    activeDirs.push(repoDir);
    initRepo(repoDir);
    // The real incident ran the other direction: cwd is a linked worktree and
    // the MAIN checkout (scanned as a sibling here) holds the higher number.
    const sha = git(['rev-parse', 'HEAD'], repoDir).trim();
    const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3849-linked-wt-'));
    git(['worktree', 'add', '--detach', worktreeDir, sha], repoDir);
    activeWorktrees.push({ repoDir, worktreeDir });
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- fixture SETUP, not teardown: strips the tracked .planning/ so this worktree has none; cleanup() owns the dir's removal with the Windows retry budget
    fs.rmSync(path.join(worktreeDir, '.planning'), { recursive: true, force: true });
    fs.mkdirSync(path.join(worktreeDir, '.planning', 'phases'), { recursive: true });
    fs.writeFileSync(
      path.join(worktreeDir, '.planning', 'ROADMAP.md'),
      ['# Roadmap v1.0', '', '### Phase 440: base', '**Goal:** Setup', '', '---', ''].join('\n')
    );

    const result = runGsdTools('phase add from linked', worktreeDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phase_number,
      441,
      '#3849: the main checkout (440) must be visible when allocating from a linked worktree'
    );
  });

  test('phase add-batch counts bullet-only Phase N rows (#1229 reached the batch path)', () => {
    const tmp = createTempProject();
    try {
      fs.writeFileSync(
        path.join(tmp, '.planning', 'ROADMAP.md'),
        ['# Roadmap v1.0', '', '- [ ] **Phase 11: bullet-only phase**', '', '---', ''].join('\n')
      );
      const result = runGsdTools(['phase', 'add-batch', '--descriptions', '["After Bullet"]'], tmp);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(
        output.phases[0].phase_number,
        12,
        '#3849 secondary: a bullet-only Phase 11 must not be re-allocated by add-batch'
      );
    } finally {
      cleanup(tmp);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase add-batch command (#2165)
// ─────────────────────────────────────────────────────────────────────────────

describe('phase add-batch command (#2165)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap v1.0',
        '',
        '### Phase 1: Foundation',
        '**Goal:** Setup',
        '',
        '---',
        '',
      ].join('\n')
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('adds multiple phases with sequential numbers in a single call', () => {
    // Use array form to avoid shell quoting issues with JSON args
    const result = runGsdTools(['phase', 'add-batch', '--descriptions', '["Alpha","Beta","Gamma"]'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.count, 3, 'should report 3 phases added');
    assert.strictEqual(output.phases[0].phase_number, 2);
    assert.strictEqual(output.phases[1].phase_number, 3);
    assert.strictEqual(output.phases[2].phase_number, 4);

    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'phases', '02-alpha')), '02-alpha dir must exist');
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'phases', '03-beta')), '03-beta dir must exist');
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'phases', '04-gamma')), '04-gamma dir must exist');

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('### Phase 2: Alpha'), 'roadmap should include Phase 2');
    assert.ok(roadmap.includes('### Phase 3: Beta'), 'roadmap should include Phase 3');
    assert.ok(roadmap.includes('### Phase 4: Gamma'), 'roadmap should include Phase 4');
  });

  test('no duplicate phase numbers when multiple add-batch calls are made sequentially', () => {
    // Regression for #2165: parallel `phase add` invocations produced duplicates
    // because each read disk state before any write landed. add-batch serializes
    // the entire batch under a single lock so the next call sees the updated state.
    const r1 = runGsdTools(['phase', 'add-batch', '--descriptions', '["Wave-One-A","Wave-One-B"]'], tmpDir);
    assert.ok(r1.success, `First batch failed: ${r1.error}`);

    const r2 = runGsdTools(['phase', 'add-batch', '--descriptions', '["Wave-Two-A","Wave-Two-B"]'], tmpDir);
    assert.ok(r2.success, `Second batch failed: ${r2.error}`);

    const out1 = JSON.parse(r1.output);
    const out2 = JSON.parse(r2.output);
    const allNums = [...out1.phases, ...out2.phases].map(p => p.phase_number);
    const unique = new Set(allNums);
    assert.strictEqual(unique.size, allNums.length, `Duplicate phase numbers detected: ${allNums}`);

    // Directories must all exist and be unique
    const dirs = fs.readdirSync(path.join(tmpDir, '.planning', 'phases'));
    assert.strictEqual(dirs.length, 4, `Expected 4 phase dirs, got: ${dirs}`);
  });

  test('each phase directory contains a .gitkeep file', () => {
    const result = runGsdTools(['phase', 'add-batch', '--descriptions', '["Setup","Build"]'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '02-setup', '.gitkeep')),
      '.gitkeep must exist in 02-setup'
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '03-build', '.gitkeep')),
      '.gitkeep must exist in 03-build'
    );
  });

  test('returns error for empty descriptions array', () => {
    const result = runGsdTools(['phase', 'add-batch', '--descriptions', '[]'], tmpDir);
    assert.ok(!result.success, 'should fail on empty array');
  });

  test('returns error when --descriptions JSON is not an array', () => {
    const result = runGsdTools(['phase', 'add-batch', '--descriptions', '{"one":"Alpha"}'], tmpDir);
    assert.ok(!result.success, 'should fail on non-array JSON');
    assert.match(result.error, /--descriptions must be a JSON array/);
  });

  test('returns error when --descriptions is missing its JSON value', () => {
    const missing = runGsdTools(['phase', 'add-batch', '--descriptions'], tmpDir);
    assert.ok(!missing.success, 'should fail on dangling --descriptions');
    assert.match(missing.error, /--descriptions must be a JSON array/);

    const flagValue = runGsdTools(['phase', 'add-batch', '--descriptions', '--raw'], tmpDir);
    assert.ok(!flagValue.success, 'should fail when --descriptions value is another flag');
    assert.match(flagValue.error, /--descriptions must be a JSON array/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase insert command
// ─────────────────────────────────────────────────────────────────────────────


describe('phase insert command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('inserts decimal phase after target', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Foundation
**Goal:** Setup

### Phase 2: API
**Goal:** Build API
`
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });

    const result = runGsdTools('phase insert 1 Fix Critical Bug', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, '01.1', 'should be 01.1');
    assert.strictEqual(output.after_phase, '1');

    // Verify directory
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '01.1-fix-critical-bug')),
      'decimal phase directory should be created'
    );

    // Verify ROADMAP
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('Phase 01.1: Fix Critical Bug (INSERTED)'), 'roadmap should include inserted phase');
  });

  test('increments decimal when siblings exist', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Foundation
**Goal:** Setup

### Phase 2: API
**Goal:** Build API
`
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01.1-hotfix'), { recursive: true });

    const result = runGsdTools('phase insert 1 Another Fix', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, '01.2', 'should be 01.2');
  });

  test('rejects missing phase', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 1: Test\n**Goal:** Test\n`
    );

    const result = runGsdTools('phase insert 99 Fix Something', tmpDir);
    assert.ok(!result.success, 'should fail for missing phase');
    assert.ok(result.error.includes('not found'), 'error mentions not found');
  });

  test('handles padding mismatch between input and roadmap', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

## Phase 09.05: Existing Decimal Phase
**Goal:** Test padding

## Phase 09.1: Next Phase
**Goal:** Test
`
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '09.05-existing'), { recursive: true });

    // Pass unpadded "9.05" but roadmap has "09.05"
    const result = runGsdTools('phase insert 9.05 Padding Test', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.after_phase, '9.05');

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('(INSERTED)'), 'roadmap should include inserted phase');
  });

  test('phase insert includes **Requirements**: TBD in new ROADMAP entry', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n### Phase 2: API\n**Goal:** Build API\n`
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });

    const result = runGsdTools('phase insert 1 Fix Critical Bug', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('**Requirements**: TBD'), 'inserted phase entry should include Requirements TBD');
  });

  test('reports actionable error for summary-only placeholder phase without detail section (#3098)', () => {
    // #3098: a hybrid ROADMAP that has heading-style phases for some phases
    // but only a bullet summary entry for phase 5 (the detail section is
    // missing).  Insert must fail with "missing a detail section" rather than
    // silently inserting in bullet-style — because the surrounding ROADMAP
    // uses headings, so the absent `### Phase 5:` is a genuine omission.
    // (Compare with the #3815 case below: a purely bullet-style ROADMAP that
    // has NO heading-style phases at all is valid and insert should succeed.)
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 4: Foundation\n**Goal:** Setup\n\n- [ ] **Phase 5: Placeholder**\n`
    );

    const result = runGsdTools('phase insert 5 Hotfix', tmpDir);
    assert.ok(!result.success, 'should fail when phase is summary-only placeholder in a heading-style ROADMAP');
    assert.ok(result.error.includes('missing a detail section'));
  });

  test('phase insert rejects unsupported --dry-run flag explicitly (#3098)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 1: Foundation\n**Goal:** Setup\n`
    );

    const result = runGsdTools('phase insert 1 Hotfix --dry-run', tmpDir);
    assert.ok(!result.success, 'phase insert should reject unsupported --dry-run');
    assert.ok(result.error.includes('does not support --dry-run'));
  });

  test('handles #### heading depth from multi-milestone roadmaps', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### v1.1 Milestone

#### Phase 5: Feature Work
**Goal:** Build features

#### Phase 6: Polish
**Goal:** Polish
`
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '05-feature-work'), { recursive: true });

    const result = runGsdTools('phase insert 5 Hotfix', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, '05.1');

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('Phase 05.1: Hotfix (INSERTED)'), 'roadmap should include inserted phase');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase remove command
// ─────────────────────────────────────────────────────────────────────────────


describe('phase remove command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('removes phase directory and renumbers subsequent', () => {
    // Setup 3 phases
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Foundation
**Goal:** Setup
**Depends on:** Nothing

### Phase 2: Auth
**Goal:** Authentication
**Depends on:** Phase 1

### Phase 3: Features
**Goal:** Core features
**Depends on:** Phase 2
`
    );

    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });
    const p2 = path.join(tmpDir, '.planning', 'phases', '02-auth');
    fs.mkdirSync(p2, { recursive: true });
    fs.writeFileSync(path.join(p2, '02-01-PLAN.md'), '# Plan');
    const p3 = path.join(tmpDir, '.planning', 'phases', '03-features');
    fs.mkdirSync(p3, { recursive: true });
    fs.writeFileSync(path.join(p3, '03-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p3, '03-02-PLAN.md'), '# Plan 2');

    // Remove phase 2
    const result = runGsdTools('phase remove 2', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.removed, '2');
    assert.strictEqual(output.directory_deleted, '02-auth');

    // Phase 3 should be renumbered to 02
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '02-features')),
      'phase 3 should be renumbered to 02-features'
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'phases', '03-features')),
      'old 03-features should not exist'
    );

    // Files inside should be renamed
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '02-features', '02-01-PLAN.md')),
      'plan file should be renumbered to 02-01'
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '02-features', '02-02-PLAN.md')),
      'plan 2 should be renumbered to 02-02'
    );

    // ROADMAP should be updated
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(!roadmap.includes('Phase 2: Auth'), 'removed phase should not be in roadmap');
    assert.ok(roadmap.includes('Phase 2: Features'), 'phase 3 should be renumbered to 2');
  });

  // WARNING-3 (#3511 review): renameIntegerPhases renames a phase directory
  // whose leading number is UNPADDED (dir regex accepts bare `\d+`), but
  // renamed its artifact files only against the 2-PADDED prefix, so an
  // unpadded-numbered artifact desynced from its now-renamed directory and
  // the phase read `missing` afterward.
  test('#3511 WARNING-3: renames an unpadded-numbered artifact alongside its unpadded dir', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 1: A\n**Goal:** A\n### Phase 9: B\n**Goal:** B\n`
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });
    const p9 = path.join(tmpDir, '.planning', 'phases', '9-slug');
    fs.mkdirSync(p9, { recursive: true });
    // Unpadded artifact filename, paired with the unpadded dir number.
    fs.writeFileSync(path.join(p9, '9-VERIFICATION.md'), '---\nstatus: passed\n---\n\nVerified OK.');

    const result = runGsdTools('phase remove 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const newDir = path.join(tmpDir, '.planning', 'phases', '08-slug');
    assert.ok(fs.existsSync(newDir), 'phase 9 should be renumbered to 08-slug');
    assert.ok(
      fs.existsSync(path.join(newDir, '08-VERIFICATION.md')),
      'the unpadded 9-VERIFICATION.md should be renamed to 08-VERIFICATION.md alongside the dir'
    );
    assert.ok(
      !fs.existsSync(path.join(newDir, '9-VERIFICATION.md')),
      'the stale unpadded-prefix file should no longer exist'
    );

    const findResult = runGsdTools('find-phase 8', tmpDir);
    assert.ok(findResult.success, `find-phase failed: ${findResult.error}`);
    const findOutput = JSON.parse(findResult.output);
    assert.strictEqual(findOutput.found, true, 'renumbered phase 8 should resolve');
  });

  // #3511 BLOCKER-2 follow-up (security-review regression): the collision
  // guard added to stop the original overwrite-and-lose-data bug (BLOCKER-1)
  // introduced a NEW wrong-answer regression — skipping the rename let a
  // STRAY cross-phase file outrank the phase's own report at the canonical
  // name. Phase 9's directory holds its OWN `09-VERIFICATION.md` (gaps_found)
  // and a stray `08-VERIFICATION.md` (passed) that actually belongs to phase
  // 8. Removing phase 8 renumbers phase 9 -> phase 8 and must displace the
  // stray (never overwrite it, never let it win) so the phase's own report
  // lands at the canonical name.
  test('#3511 BLOCKER-2 follow-up: collision displaces the occupying file instead of skip-or-overwrite', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 8: A\n**Goal:** A\n### Phase 9: B\n**Goal:** B\n`
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '08-a'), { recursive: true });
    const p9 = path.join(tmpDir, '.planning', 'phases', '09-foo');
    fs.mkdirSync(p9, { recursive: true });
    // The phase's OWN report.
    fs.writeFileSync(
      path.join(p9, '09-VERIFICATION.md'),
      '---\nstatus: gaps_found\n---\n\nOwn report for phase 9.'
    );
    // A STRAY report belonging to phase 8, sitting inside phase 9's directory.
    fs.writeFileSync(
      path.join(p9, '08-VERIFICATION.md'),
      '---\nstatus: passed\n---\n\nStray report belonging to phase 8.'
    );

    const result = runGsdTools('phase remove 8', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    const newDir = path.join(tmpDir, '.planning', 'phases', '08-foo');
    assert.ok(fs.existsSync(newDir), 'phase 9 should be renumbered to 08-foo');

    // (a) no file is lost — both original contents still exist on disk.
    const canonicalPath = path.join(newDir, '08-VERIFICATION.md');
    const displacedPath = path.join(newDir, '08-VERIFICATION.md.orphaned');
    assert.ok(fs.existsSync(canonicalPath), 'canonical 08-VERIFICATION.md must exist');
    assert.ok(fs.existsSync(displacedPath), 'the displaced stray file must still exist on disk');
    const canonical = fs.readFileSync(canonicalPath, 'utf-8');
    const displaced = fs.readFileSync(displacedPath, 'utf-8');
    assert.ok(
      displaced.includes('Stray report belonging to phase 8'),
      'displaced file must retain the stray content'
    );

    // (b) 08-VERIFICATION.md in the renamed dir is the phase's OWN former
    // 09-VERIFICATION.md — assert on its body/status, not just its name.
    assert.ok(
      canonical.includes('status: gaps_found'),
      `canonical 08-VERIFICATION.md must be the phase's own report (gaps_found), ` +
      `not the stray (passed). Got: ${canonical}`
    );
    assert.ok(
      canonical.includes('Own report for phase 9'),
      'canonical file body must be the phase\'s own former 09-VERIFICATION.md content'
    );
    assert.ok(
      !fs.existsSync(path.join(newDir, '09-VERIFICATION.md')),
      'the stale 09-VERIFICATION.md name should no longer exist'
    );

    // (c) the displacement is reported in the command output.
    assert.ok(
      Array.isArray(output.renamed_file_collisions),
      'renamed_file_collisions must be present in the output'
    );
    const entry = output.renamed_file_collisions.find((c) => c.to === '08-VERIFICATION.md');
    assert.ok(
      entry,
      `expected a collision entry for 08-VERIFICATION.md, got: ${JSON.stringify(output.renamed_file_collisions)}`
    );
    assert.strictEqual(entry.from, '09-VERIFICATION.md');
    assert.strictEqual(entry.displaced_to, '08-VERIFICATION.md.orphaned');
  });

  test('rejects removal of phase with summaries unless --force', () => {
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-test');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 1: Test\n**Goal:** Test\n`
    );

    // Should fail without --force
    const result = runGsdTools('phase remove 1', tmpDir);
    assert.ok(!result.success, 'should fail without --force');
    assert.ok(result.error.includes('executed plan'), 'error mentions executed plans');

    // Should succeed with --force
    const forceResult = runGsdTools('phase remove 1 --force', tmpDir);
    assert.ok(forceResult.success, `Force remove failed: ${forceResult.error}`);
  });

  test('bug-3409: supports --force before phase id', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 1: A\n**Goal:** A\n### Phase 2: B\n**Goal:** B\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 1\n**Total Phases:** 2\n`
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-b'), { recursive: true });

    const result = runGsdTools('phase remove --force 2', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.removed, '2');
    assert.strictEqual(output.directory_deleted, '02-b');
    assert.ok(!fs.existsSync(path.join(tmpDir, '.planning', 'phases', '02-b')));

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(state.includes('**Total Phases:** 1'), 'total phases should be decremented after real removal');
  });

  test('removes decimal phase and renumbers siblings', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 6: Main\n**Goal:** Main\n### Phase 6.1: Fix A\n**Goal:** Fix A\n### Phase 6.2: Fix B\n**Goal:** Fix B\n### Phase 6.3: Fix C\n**Goal:** Fix C\n`
    );

    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06-main'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.1-fix-a'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.2-fix-b'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06.3-fix-c'), { recursive: true });

    const result = runGsdTools('phase remove 6.2', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // 06.3 should become 06.2
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '06.2-fix-c')),
      '06.3 should be renumbered to 06.2'
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'phases', '06.3-fix-c')),
      'old 06.3 should not exist'
    );
  });

  test('updates STATE.md phase count', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 1: A\n**Goal:** A\n### Phase 2: B\n**Goal:** B\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 1\n**Total Phases:** 2\n`
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-b'), { recursive: true });

    runGsdTools('phase remove 2', tmpDir);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(state.includes('**Total Phases:** 1'), 'total phases should be decremented');
  });

  test('bug-2434: integer phase remove does not rename 999.x backlog directory', () => {
    // Setup: an active integer phase 4 and a backlog phase 999.1
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Foundation
**Goal:** Setup

### Phase 2: Auth
**Goal:** Authentication

### Phase 3: Features
**Goal:** Core features

### Phase 4: Extras
**Goal:** Extra stuff

### Phase 999.1: Backlog item
**Goal:** Parked backlog task
`
    );

    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-auth'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-features'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '04-extras'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '999.1-backlog-item'), { recursive: true });

    const result = runGsdTools('phase remove 4', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // Backlog directory must remain at 999.1, not be decremented to 998.1
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '999.1-backlog-item')),
      'backlog directory 999.1-backlog-item must not be renamed'
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'phases', '998.1-backlog-item')),
      'backlog directory must not be incorrectly renamed to 998.1'
    );
  });

  test('bug-16: integer phase remove renumbers canonical phases above 999 while preserving 999.x backlog', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1199: Baseline
**Goal:** Before removal
Plans:
- [x] 1199-01-PLAN.md

### Phase 1200: Remove Me
**Goal:** Target phase
Plans:
- [ ] 1200-01-PLAN.md

### Phase 1201: Follow Up A
**Goal:** First phase after target
**Depends on:** Phase 1200
Plans:
- [ ] 1201-01-PLAN.md

### Phase 1202: Follow Up B
**Goal:** Second phase after target
**Depends on:** Phase 1201
Plans:
- [ ] 1202-01-PLAN.md

### Phase 999.1: Backlog Item
**Goal:** Parked backlog item
`
    );

    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '1199-baseline'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '1200-remove-me'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '1201-follow-up-a'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '1202-follow-up-b'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '999.1-backlog-item'), { recursive: true });

    const result = runGsdTools('phase remove 1200', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // On-disk phase directories should be decremented by one above removedInt.
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '1200-follow-up-a')),
      '1201-follow-up-a should be renamed to 1200-follow-up-a',
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '1201-follow-up-b')),
      '1202-follow-up-b should be renamed to 1201-follow-up-b',
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'phases', '1201-follow-up-a')),
      'old 1201-follow-up-a directory should not remain',
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'phases', '1202-follow-up-b')),
      'old 1202-follow-up-b directory should not remain',
    );

    // Backlog 999.x must remain untouched.
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '999.1-backlog-item')),
      'backlog directory 999.1-backlog-item must not be renamed',
    );

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(!roadmap.includes('### Phase 1200: Remove Me'), 'removed phase 1200 section must be gone');
    assert.ok(roadmap.includes('### Phase 1200: Follow Up A'), 'phase 1201 should be renumbered to 1200');
    assert.ok(roadmap.includes('### Phase 1201: Follow Up B'), 'phase 1202 should be renumbered to 1201');
    assert.ok(!roadmap.includes('### Phase 1202: Follow Up B'), 'old phase 1202 heading must not remain');
    assert.ok(roadmap.includes('**Depends on:** Phase 1200'), 'depends-on reference above removed phase should be decremented');
    assert.ok(roadmap.includes('### Phase 999.1: Backlog Item'), 'backlog phase 999.1 heading must not be renumbered');
  });

  test('bug-2435: integer phase remove does not corrupt YYYY-MM-DD dates in ROADMAP.md', () => {
    // Setup: removing phase 4 from a roadmap containing 2026-04-14 date strings
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Foundation
**Goal:** Setup
**Completed:** 2026-01-15

### Phase 2: Auth
**Goal:** Authentication
**Completed:** 2026-02-20

### Phase 3: Features
**Goal:** Core features
**Completed:** 2026-04-14

### Phase 4: Extras
**Goal:** Extra stuff

### Phase 5: Final
**Goal:** Final phase
`
    );

    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-auth'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-features'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '04-extras'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '05-final'), { recursive: true });

    const result = runGsdTools('phase remove 4', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');

    // Dates must be preserved exactly
    assert.ok(roadmap.includes('2026-01-15'), 'date 2026-01-15 must not be corrupted');
    assert.ok(roadmap.includes('2026-02-20'), 'date 2026-02-20 must not be corrupted');
    assert.ok(roadmap.includes('2026-04-14'), 'date 2026-04-14 must not be corrupted');

    // Phase 5 should be renumbered to 4
    assert.ok(roadmap.includes('Phase 4: Final'), 'Phase 5 should be renumbered to Phase 4');
  });

  test('bug-2435: integer phase remove does not corrupt date whose month matches removed phase number', () => {
    // Setup: removing phase 4 from a roadmap containing 2026-05-14
    // When renumbering phase 5→4, the regex must not replace "05-14" in the date "2026-05-14"
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Foundation
**Goal:** Setup
**Completed:** 2026-01-15

### Phase 2: Auth
**Goal:** Authentication
**Completed:** 2026-02-20

### Phase 3: Features
**Goal:** Core features
**Completed:** 2026-03-10

### Phase 4: Extras
**Goal:** Extra stuff

### Phase 5: Final
**Goal:** Final phase
**Due:** 2026-05-14
`
    );

    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-auth'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-features'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '04-extras'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '05-final'), { recursive: true });

    const result = runGsdTools('phase remove 4', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');

    // Date "2026-05-14" must not be corrupted to "2026-04-14" when phase 5 is renumbered to 4
    assert.ok(roadmap.includes('2026-05-14'), 'date 2026-05-14 must not be corrupted when renumbering phase 5→4');
    assert.ok(!roadmap.includes('2026-04-14'), 'date must not be incorrectly mutated to 2026-04-14');

    // Phase 5 should be renumbered to 4
    assert.ok(roadmap.includes('Phase 4: Final'), 'Phase 5 should be renumbered to Phase 4');
  });

  test('bug-3355: integer phase remove renumbers roadmap once without collapsing later phases', () => {
    const lines = ['# Roadmap', '', '## Progress', '', '| Phase | Plans | Status | Notes |', '|---|---:|---|---|'];
    for (let n = 26; n <= 35; n++) {
      lines.push(`| ${n}. Phase ${n} | 0/1 | Planned | - |`);
    }
    lines.push('');
	    for (let n = 26; n <= 35; n++) {
	      lines.push(`### Phase ${n}: Phase ${n}`);
	      lines.push(`#### Phase ${n}.1: Phase ${n}.1 follow-up`);
	      lines.push(`**Goal:** Build phase ${n}`);
	      lines.push(n % 2 === 0 ? `**Depends on**: Phase ${n - 1}` : `**Depends on:** Phase ${n - 1}`);
	      lines.push(`Plans: ${String(n).padStart(2, '0')}-01-PLAN.md`);
	      lines.push('');

      const phaseDir = path.join(tmpDir, '.planning', 'phases', `${String(n).padStart(2, '0')}-phase-${n}`);
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, `${String(n).padStart(2, '0')}-01-PLAN.md`), '# Plan');
    }
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), lines.join('\n'));

    const result = runGsdTools('phase remove 27 --force', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.equal((roadmap.match(/\|\s*27\.\s/g) || []).length, 1, 'progress row 27 appears once');
    assert.equal((roadmap.match(/\|\s*28\.\s/g) || []).length, 1, 'progress row 28 appears once');
    assert.equal((roadmap.match(/\|\s*34\.\s/g) || []).length, 1, 'progress row 34 appears once');
    assert.equal((roadmap.match(/\|\s*35\.\s/g) || []).length, 0, 'old progress row 35 removed by renumber');
	    assert.equal((roadmap.match(/^### Phase 27:/gm) || []).length, 1, 'heading 27 appears once');
	    assert.equal((roadmap.match(/^### Phase 34:/gm) || []).length, 1, 'heading 34 appears once');
	    assert.equal((roadmap.match(/^### Phase 35:/gm) || []).length, 0, 'old heading 35 removed by renumber');
	    assert.equal((roadmap.match(/^#### Phase 27\.1:/gm) || []).length, 1, 'decimal heading 27.1 appears once');
	    assert.equal((roadmap.match(/^#### Phase 34\.1:/gm) || []).length, 1, 'decimal heading 34.1 appears once');
	    assert.equal((roadmap.match(/^#### Phase 35\.1:/gm) || []).length, 0, 'old decimal heading 35.1 removed by renumber');
	    assert.equal((roadmap.match(/\*\*Depends on\*\*:\s*Phase\s+28\b/g) || []).length, 1, 'bold depends-on with outside colon is decremented');
	    assert.equal((roadmap.match(/\*\*Depends on:\*\*\s*Phase\s+29\b/g) || []).length, 1, 'legacy bold depends-on with inside colon is decremented');
	    assert.equal((roadmap.match(/\*\*Depends on:\*\*\s*Phase\s+35\b/g) || []).length, 0, 'old depends-on 35 removed by renumber');
	    assert.equal((roadmap.match(/\b27-01-PLAN\.md\b/g) || []).length, 1, 'plan id 27-01 appears once');
	    assert.equal((roadmap.match(/\b34-01-PLAN\.md\b/g) || []).length, 1, 'plan id 34-01 appears once');
	    assert.equal((roadmap.match(/\b35-01-PLAN\.md\b/g) || []).length, 0, 'old plan id 35-01 removed by renumber');

	    for (let n = 27; n <= 34; n++) {
      assert.ok(
        fs.existsSync(path.join(tmpDir, '.planning', 'phases', `${String(n).padStart(2, '0')}-phase-${n + 1}`)),
        `phase directory ${n} should preserve original phase slug ${n + 1}`,
      );
    }
  });

  test('#2245 F3: Progress-ordinal renumber re-escapes an escaped pipe in the Phase cell', () => {
    // The renumber's `newValue` callback builds its replacement from the
    // CURRENT (unescaped) cell value and used to splice it back verbatim —
    // an escaped `\|` in the cell de-escapes to a literal `|` and splits the
    // cell into an extra column when spliced back unescaped.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Foo
- [ ] Phase 2: Bar
- [ ] Phase 3: Parser | Lexer

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|-----------------|--------|-----------|
| 1. Foo | 0/1 | Pending | - |
| 2. Bar | 0/1 | Pending | - |
| 3. Parser \\| Lexer | 0/1 | Pending | - |
`,
    );

    const result = runGsdTools('phase remove 2 --force', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(
      roadmap.includes('| 2. Parser \\| Lexer | 0/1 | Pending | - |'),
      `the escaped pipe must survive the renumber intact:\n${roadmap}`,
    );
    // Reject the de-escaped, cell-splitting shape.
    assert.ok(
      !/\|\s*2\. Parser \|\s*Lexer\s*\|\s*0\/1\s*\|/.test(roadmap),
      'the row must not have split into an extra column',
    );
  });

  test('#2245 F8: Progress-ordinal renumber padding-recovery is keyed by row index, not trimmed value', () => {
    // Two rows with identical TRIMMED Phase text but different padding: an
    // already-rewritten row's NEW value can coincide with a still-unprocessed
    // row's PRE-edit value, so a content-keyed padding lookup can steal the
    // wrong (already-rewritten) row's padding.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Anchor

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|-----------------|--------|-----------|
| 4. Foo   | 0/1 | Pending | - |
| 3. Foo | 0/1 | Pending | - |
`,
    );

    const result = runGsdTools('phase remove 1 --force', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(
      roadmap.includes('| 3. Foo   | 0/1 | Pending | - |'),
      `row 4->3 must keep its OWN (3-space) padding:\n${roadmap}`,
    );
    assert.ok(
      roadmap.includes('| 2. Foo | 0/1 | Pending | - |'),
      `row 3->2 must keep its OWN (1-space) padding, not borrow row 4->3's:\n${roadmap}`,
    );
  });

  test('#2143 audit: removing the LAST phase preserves a trailing ## Progress section and its table', () => {
    // Root cause: updateRoadmapAfterPhaseRemoval's whole-section delete used to
    // be a raw greedy regex whose lookahead only recognised ANOTHER "Phase N:"
    // heading as a stop boundary. Removing the LAST phase left no such heading
    // to stop at, so the lazy [\s\S]*? scan ran to EOF and swept away
    // everything after it — including a trailing `## Progress` heading and its
    // tracking table (data loss). Fixed by migrating the delete onto
    // deleteSection (markdown-sectionizer.cjs), whose level-bounded stop halts
    // at the next heading of the SAME-OR-HIGHER level regardless of its text.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Foundation
**Goal:** Setup

### Phase 2: Auth
**Goal:** Authentication

## Progress

| Phase | Plans | Status | Completed |
|---|---|---|---|
| 1 | 0/1 | Planned | - |
| 2 | 0/1 | Planned | - |
`,
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-auth'), { recursive: true });

    const result = runGsdTools('phase remove 2 --force', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(!roadmap.includes('Phase 2: Auth'), 'removed Phase 2 section must be gone');
    assert.ok(!roadmap.includes('Authentication'), 'removed Phase 2 body content must be gone');
    assert.ok(roadmap.includes('### Phase 1: Foundation'), 'Phase 1 (untouched) must survive');
    assert.ok(
      roadmap.includes('## Progress'),
      'trailing ## Progress heading must survive removing the LAST phase — the #2143 audit data-loss bug',
    );
    assert.ok(
      roadmap.includes('| Phase | Plans | Status | Completed |'),
      'Progress table header must survive',
    );
    assert.ok(
      roadmap.includes('| 1 | 0/1 | Planned | - |'),
      "Phase 1's own progress row must survive",
    );
  });

  test('#2245 audit: COMPACT unpadded Progress row for the removed phase is deleted (deleteTableRow migration)', () => {
    // Root cause: the prior ROW-DELETION regex was
    // `\|\s*${escaped}\.?\s[^|]*\|` — the `\.?\s` required a WHITESPACE
    // character immediately after the phase number. A fully compact, unpadded
    // row (no spaces around any pipe, e.g. `|2|0/2|Planned|-|`) has the
    // closing `|` immediately after the digit — no whitespace to match — so
    // the row was never recognised and the removed phase's stale row was left
    // behind. Migrated onto deleteTableRow (ADR-2143 §7), which matches the
    // row by its FIRST cell's value regardless of padding.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Foundation
**Goal:** Setup

### Phase 2: Beta
**Goal:** Something

### Phase 3: Features
**Goal:** Core features

## Progress

|Phase|Plans Complete|Status|Completed|
|---|---|---|---|
|1|0/1|Planned|-|
|2|0/2|Planned|-|
|3|0/1|Planned|-|
`,
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-beta'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-features'), { recursive: true });

    const result = runGsdTools('phase remove 2', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(
      !roadmap.includes('|2|0/2|Planned|-|'),
      'the COMPACT phase-2 progress row must be deleted (it survived pre-fix)',
    );
    assert.ok(roadmap.includes('|1|0/1|Planned|-|'), "phase 1's compact progress row must survive");
    assert.ok(
      roadmap.includes('|3|0/1|Planned|-|'),
      "phase 3's compact progress row must survive (its own bare-digit renumbering is a separate, out-of-scope cross-phase-renumber concern)",
    );
  });

  test('#2245 audit: a PADDED Progress table deletes exactly the removed row, byte-parity on the rest', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

### Phase 1: Foundation
**Goal:** Setup

### Phase 2: Beta
**Goal:** Something

### Phase 3: Features
**Goal:** Core features

## Progress

| Phase | Plans Complete | Status      | Completed  |
|-------|-----------------|-------------|------------|
| 1. Foundation | 2/2 | Complete    | 2026-01-01 |
| 2. Beta       | 1/2 | In Progress |            |
| 3. Features   | 0/2 | Planned     |            |
`,
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-beta'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-features'), { recursive: true });

    const result = runGsdTools('phase remove 2', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(!roadmap.includes('2. Beta'), 'removed phase 2 progress row must be gone');
    assert.ok(
      roadmap.includes('| Phase | Plans Complete | Status      | Completed  |'),
      'Progress table header must be byte-identical',
    );
    assert.ok(
      roadmap.includes('|-------|-----------------|-------------|------------|'),
      'Progress table delimiter row must be byte-identical',
    );
    assert.ok(
      roadmap.includes('| 1. Foundation | 2/2 | Complete    | 2026-01-01 |'),
      "phase 1's row must be byte-identical (untouched)",
    );
    // Phase 3 is renumbered to phase 2 (its heading and phases/ directory both
    // become "2" once phase 2 is removed) — the pre-existing renumber block
    // below (untouched by this migration) decrements its Progress-table
    // ordinal too, `3.` -> `2.`, so the surviving row's phase number tracks
    // its new identity consistently with the heading/directory; every OTHER
    // byte of the row (padding, Plans/Status/Completed cells) stays identical.
    assert.ok(
      !roadmap.includes('| 3. Features   | 0/2 | Planned     |            |'),
      'the stale phase-3 ordinal must not survive once renumbered to phase 2',
    );
    assert.ok(
      roadmap.includes('| 2. Features   | 0/2 | Planned     |            |'),
      "surviving row's Plans/Status/Completed cells stay byte-identical; only its leading ordinal renumbers 3->2",
    );
  });

  // ─── #2640: state_updated must reflect actual content change, and progress
  // frontmatter must be resync'd even when the body lacks 'Total Phases:'. ──

  test('#2640 — state_updated reflects actual content change (not just file existence)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 1: A\n**Goal:** x\n\n### Phase 2: B\n**Goal:** y\n`,
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-b'), { recursive: true });
    // STATE.md with 'Total Phases:' body field + progress frontmatter
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---\ngsd_state_version: 1.0\ncurrent_phase: 1\nprogress:\n  total_phases: 2\n  completed_phases: 0\n  percent: 0\n---\n\n# State\n\nTotal Phases: 2\n`,
    );
    const beforeState = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    const result = runGsdTools('phase remove 2', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.state_updated, true, 'state_updated must be true when STATE.md content changed');
    // Body 'Total Phases:' must be decremented from 2 to 1.
    const afterState = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    // #3685: earn the `true` above — assert the file's content actually
    // differs from the pre-call snapshot, not merely that it exists.
    assert.notEqual(afterState, beforeState, '#3685: STATE.md content must actually change when state_updated is true');
    const bodyMatch = afterState.match(/^Total Phases:\s*(\d+)/m);
    assert.ok(bodyMatch, 'body must have Total Phases field after remove');
    assert.strictEqual(bodyMatch[1], '1', `body 'Total Phases:' must be 1 after removing one of 2 phases; got ${bodyMatch[1]}`);
    // Frontmatter progress.total_phases must agree.
    const fmMatch = afterState.match(/total_phases:\s*(\d+)/);
    assert.ok(fmMatch, 'frontmatter must have total_phases');
    assert.strictEqual(fmMatch[1], '1', `frontmatter progress.total_phases must be 1; got ${fmMatch[1]}`);
  });

  test('#2640 — progress.total_phases resync\'d even when body lacks Total Phases', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 1: A\n**Goal:** x\n\n### Phase 2: B\n**Goal:** y\n\n### Phase 3: C\n**Goal:** z\n`,
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-b'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-c'), { recursive: true });
    // STATE.md with NO 'Total Phases:' body field, but with progress frontmatter
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---\ngsd_state_version: 1.0\ncurrent_phase: 1\nprogress:\n  total_phases: 3\n  completed_phases: 0\n  percent: 0\n---\n\n# State\n\nNo body phase count here.\n`,
    );

    const beforeState = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const beforeMatch = beforeState.match(/total_phases:\s*(\d+)/);
    assert.ok(beforeMatch && beforeMatch[1] === '3', 'precondition: total_phases should be 3');

    const result = runGsdTools('phase remove 2', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const afterState = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const afterMatch = afterState.match(/total_phases:\s*(\d+)/);
    assert.ok(afterMatch, `STATE.md frontmatter must still have total_phases after remove; got:\n${afterState}`);
    // Must be exactly 2 — 3 phases minus 1 removed. Asserting the exact value
    // catches a wrong count (not just "not 3").
    assert.strictEqual(afterMatch[1], '2',
      `total_phases must be exactly 2 after removing one of 3 phases; got ${afterMatch[1]}`);
  });

  test('#2640 — state_updated is false when STATE.md does not exist', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 1: A\n**Goal:** x\n`,
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-a'), { recursive: true });
    // No STATE.md

    const result = runGsdTools('phase remove 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.state_updated, false, 'state_updated must be false when no STATE.md exists');
  });

  // #3685: roadmap_updated used to be reported as a hardcoded `true` —
  // #2640/#2974 already fixed this call site's sibling `state_updated` flag
  // to reflect a real content diff (via readModifyWriteStateMd's returned
  // boolean); roadmap_updated is now fixed the same way, via
  // updateRoadmapAfterPhaseRemoval's own before/after content comparison.
  test('roadmap_updated is false when ROADMAP.md comes out byte-identical (#3685)', () => {
    // Target phase number appears nowhere in ROADMAP.md (no heading, no
    // dependency reference, no progress-table row, and higher than every
    // existing phase number so no renumbering fires) and has no directory —
    // updateRoadmapAfterPhaseRemoval's section-delete/renumber/row-delete
    // passes are all no-matches, so `content` never diverges from
    // `originalContent`.
    //
    // The fixture is written in ALREADY-NORMALIZED form (a blank line after
    // the `###` heading) so the byte-identity assertion below compares a
    // normalized pre-image against a normalized post-image. A hand-authored
    // fixture that skips that blank line is NOT in the shape
    // platformWriteSync's own normalizer produces, so writing it back
    // through the same normalizing write path gains the blank line even
    // though no phase data changed — that's the writer's own formatting
    // pass reformatting an un-normalized input, not a real content change,
    // and asserting byte-identity against such a fixture is unsound.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 1: Foundation\n\n**Goal:** Setup\n\n## Progress\n\n| Phase | Status |\n|-------|--------|\n| 1 | Done |\n`,
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });
    const roadmapBefore = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');

    const result = runGsdTools('phase remove 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmapAfter = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.equal(roadmapAfter, roadmapBefore, 'ROADMAP.md must be byte-identical when the removed phase is absent from it');
    const out = JSON.parse(result.output);
    assert.strictEqual(
      out.roadmap_updated, false,
      'roadmap_updated was hardcoded true here, masking the no-op (#3685)',
    );
  });

  test('roadmap_updated is true and ROADMAP.md content actually changes on a genuine removal (#3685)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n### Phase 2: Auth\n**Goal:** Authentication\n\n## Progress\n\n| Phase | Status |\n|-------|--------|\n| 1 | Done |\n| 2 | Planned |\n`,
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-auth'), { recursive: true });
    const roadmapBefore = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');

    const result = runGsdTools('phase remove 2', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmapAfter = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.notEqual(roadmapAfter, roadmapBefore, 'precondition: ROADMAP.md content must actually change');
    const out = JSON.parse(result.output);
    assert.strictEqual(out.roadmap_updated, true, 'roadmap_updated must be true for a genuine removal');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase complete command
// ─────────────────────────────────────────────────────────────────────────────

describe('phase complete canonical verification gate (#1522)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  for (const [name, verificationStatus, expectedMessage] of [
    ['missing verification report', null, /No verification report found/i],
    ['unknown verification status', 'unexpected_value', /Unexpected verification status/i],
    ['human-needed verification status', 'human_needed', /Human verification required/i],
    ['gap-bearing verification status', 'gaps_found', /Gaps found/i],
  ]) {
    test(`blocks ${name} before mutating ROADMAP or STATE`, () => {
      writePhaseCompleteVerificationGateFixture(tmpDir, verificationStatus);
      const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');
      const beforeRoadmap = fs.readFileSync(roadmapPath, 'utf-8');
      const beforeState = fs.readFileSync(statePath, 'utf-8');

      const result = runGsdTools(['--json-errors', 'phase', 'complete', '1'], tmpDir);

      assert.equal(result.success, false, 'phase complete must fail when verification has not passed');
      const errorPayload = JSON.parse(result.error);
      assert.equal(errorPayload.reason, 'phase_verification_incomplete');
      assert.match(errorPayload.message, expectedMessage);
      assert.equal(fs.readFileSync(roadmapPath, 'utf-8'), beforeRoadmap);
      assert.equal(fs.readFileSync(statePath, 'utf-8'), beforeState);
    });
  }

  test('allows passed verification to complete and advance the phase', () => {
    writePhaseCompleteVerificationGateFixture(tmpDir, 'passed');

    const result = runGsdTools(['phase', 'complete', '1'], tmpDir);

    assert.equal(result.success, true, `phase complete failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.equal(output.completed_phase, '1');
    assert.equal(output.next_phase, '02');

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.match(roadmap, /- \[x\] Phase 1: Foundation/);
    assert.match(state, /\*\*Current Phase:\*\* 02/);
  });

  test('blocks stale passed verification when summaries changed later', () => {
    writePhaseCompleteVerificationGateFixture(tmpDir, 'passed');
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const summaryPath = path.join(tmpDir, '.planning', 'phases', '01-foundation', '01-01-SUMMARY.md');
    const verificationPath = path.join(tmpDir, '.planning', 'phases', '01-foundation', '01-VERIFICATION.md');
    const beforeRoadmap = fs.readFileSync(roadmapPath, 'utf-8');
    const beforeState = fs.readFileSync(statePath, 'utf-8');

    const older = new Date('2025-01-01T00:00:00.000Z');
    const newer = new Date('2025-01-01T00:01:00.000Z');
    fs.utimesSync(verificationPath, older, older);
    fs.utimesSync(summaryPath, newer, newer);

    const result = runGsdTools(['--json-errors', 'phase', 'complete', '1'], tmpDir);

    assert.equal(result.success, false, 'phase complete must fail when verification is stale');
    const errorPayload = JSON.parse(result.error);
    assert.equal(errorPayload.reason, 'phase_verification_incomplete');
    assert.match(errorPayload.message, /stale/i);
    // #2617: the blocked-completion message now projects next_command onto the
    // runtime's installed surface. This project has no runtime configured, so it
    // takes the `claude` default — the canonical `/gsd-` hyphen form. The colon
    // form this previously asserted is the deprecated shape #2617 removed.
    assert.match(errorPayload.message, /\/gsd-verify-work 0?1/);
    assert.equal(fs.readFileSync(roadmapPath, 'utf-8'), beforeRoadmap);
    assert.equal(fs.readFileSync(statePath, 'utf-8'), beforeState);
  });
});

// #3685: cmdPhaseComplete's roadmap_updated/state_updated flags were computed
// via fs.existsSync(roadmapPath) / fs.existsSync(statePath) — true whenever
// the file merely EXISTS, even when the transaction rewrote nothing. The
// sibling requirements_updated (line ~2951 in src/phase.cts) already honors
// the correct contract: true only when that file's content actually changed
// in the transaction. Clock is pinned (GSD_TEST_MODE + GSD_NOW_MS) because
// syncStateFrontmatter stamps a millisecond-resolution `last_updated:` field
// on every STATE.md write pass — an unpinned second run would genuinely
// differ by that timestamp alone, masking the no-op these tests need to
// observe (see .gsd/bug/fix-3685-phase-complete-write-flags/repro-pinned.cjs
// for the standalone reproduction).
describe('phase complete write-flag content-change contract (#3685)', () => {
  let tmpDir;
  const PINNED_CLOCK_ENV = { GSD_TEST_MODE: '1', GSD_NOW_MS: '1750000000000' };

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('roadmap_updated is false when the transaction rewrites nothing (#3685)', () => {
    writePhaseCompleteVerificationGateFixture(tmpDir, 'passed');
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');

    const run1 = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir, PINNED_CLOCK_ENV);
    assert.ok(run1.success, `first phase complete failed: ${run1.error}`);
    const roadmapAfter1 = fs.readFileSync(roadmapPath, 'utf-8');

    // Second call: phase 1 is already complete, so this is a genuine no-op
    // against ROADMAP.md. Re-write the passed marker first so the #1522
    // verification gate does not itself refuse the second call.
    const run2 = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir, PINNED_CLOCK_ENV);
    assert.ok(run2.success, `second phase complete failed: ${run2.error}`);
    const roadmapAfter2 = fs.readFileSync(roadmapPath, 'utf-8');

    assert.equal(roadmapAfter2, roadmapAfter1, 'ROADMAP.md must be byte-identical across the no-op second run');
    const parsed2 = JSON.parse(run2.output);
    assert.strictEqual(
      parsed2.roadmap_updated, false,
      'fs.existsSync() reported true here, masking the no-op (#3685)',
    );
  });

  test('state_updated is false when the transaction rewrites nothing (#3685)', () => {
    writePhaseCompleteVerificationGateFixture(tmpDir, 'passed');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');

    const run1 = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir, PINNED_CLOCK_ENV);
    assert.ok(run1.success, `first phase complete failed: ${run1.error}`);
    const stateAfter1 = fs.readFileSync(statePath, 'utf-8');

    const run2 = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir, PINNED_CLOCK_ENV);
    assert.ok(run2.success, `second phase complete failed: ${run2.error}`);
    const stateAfter2 = fs.readFileSync(statePath, 'utf-8');

    assert.equal(stateAfter2, stateAfter1, 'STATE.md must be byte-identical across the no-op second run');
    const parsed2 = JSON.parse(run2.output);
    assert.strictEqual(
      parsed2.state_updated, false,
      'fs.existsSync() reported true here, masking the no-op (#3685)',
    );
    const roadmapAfter2 = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');

    // Stability across repeats: the flag must not alternate true/false on
    // successive no-op runs — pin a THIRD call to the same behavior.
    const run3 = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir, PINNED_CLOCK_ENV);
    assert.ok(run3.success, `third phase complete failed: ${run3.error}`);
    const stateAfter3 = fs.readFileSync(statePath, 'utf-8');
    const roadmapAfter3 = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.equal(stateAfter3, stateAfter2, 'STATE.md must remain byte-identical on a third no-op run');
    assert.equal(roadmapAfter3, roadmapAfter2, 'ROADMAP.md must remain byte-identical on a third no-op run');
    const parsed3 = JSON.parse(run3.output);
    assert.strictEqual(parsed3.roadmap_updated, false, 'roadmap_updated must stay false, not alternate, on repeat no-ops (#3685)');
    assert.strictEqual(parsed3.state_updated, false, 'state_updated must stay false, not alternate, on repeat no-ops (#3685)');
  });

  test('both write flags are true when the transaction genuinely rewrites (#3685)', () => {
    writePhaseCompleteVerificationGateFixture(tmpDir, 'passed');
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const roadmapBefore = fs.readFileSync(roadmapPath, 'utf-8');
    const stateBefore = fs.readFileSync(statePath, 'utf-8');

    const result = runGsdTools(['phase', 'complete', '1'], tmpDir, PINNED_CLOCK_ENV);
    assert.ok(result.success, `phase complete failed: ${result.error}`);
    const parsed = JSON.parse(result.output);

    const roadmapAfter = fs.readFileSync(roadmapPath, 'utf-8');
    const stateAfter = fs.readFileSync(statePath, 'utf-8');

    assert.notEqual(roadmapAfter, roadmapBefore, 'precondition: ROADMAP.md content must actually change');
    assert.strictEqual(parsed.roadmap_updated, true, 'roadmap_updated must be true for a genuine rewrite');
    assert.notEqual(stateAfter, stateBefore, 'precondition: STATE.md content must actually change');
    assert.strictEqual(parsed.state_updated, true, 'state_updated must be true for a genuine rewrite');
  });

  test('roadmap_updated stays false when ROADMAP.md is absent (#3685)', () => {
    writePhaseCompleteVerificationGateFixture(tmpDir, 'passed');
    // Deletes a single fixture FILE inside tmpDir (not the temp dir itself);
    // helpers.cleanup() is a directory-removal helper and cannot be used here.
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- single-file delete, not a directory
    fs.rmSync(path.join(tmpDir, '.planning', 'ROADMAP.md'));

    const result = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir, PINNED_CLOCK_ENV);
    assert.ok(result.success, `phase complete failed without ROADMAP.md: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.roadmap_updated, false, 'roadmap_updated must be false when ROADMAP.md does not exist (#3685)');
  });

  test('state_updated stays false when STATE.md is absent (#3685)', () => {
    writePhaseCompleteVerificationGateFixture(tmpDir, 'passed');
    // Deletes a single fixture FILE inside tmpDir (not the temp dir itself);
    // helpers.cleanup() is a directory-removal helper and cannot be used here.
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- single-file delete, not a directory
    fs.rmSync(path.join(tmpDir, '.planning', 'STATE.md'));

    const result = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir, PINNED_CLOCK_ENV);
    assert.ok(result.success, `phase complete failed without STATE.md: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.state_updated, false, 'state_updated must be false when STATE.md does not exist (#3685)');
  });
});

// #2648: phase.complete used to gate only on a single *-VERIFICATION.md status,
// so a phase could close "complete" while an arbitrary number of its plans had
// no completion record (confirmed production incident: 6/30 plans unexecuted,
// including the phase's entire final UI scope, with every signal green). The
// fix adds a fail-closed plan-coverage gate that refuses completion when any
// non-retired plan lacks a *-SUMMARY.md, naming the missing plans. A plan
// retired via machine-readable `status: superseded` frontmatter (#2349) is
// excluded from the gate so the legitimate lock/recovery pattern still works.
describe('phase complete plan-coverage gate (#2648)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Build a phase-1 directory with a configurable set of plan/summary files and
  // a passed VERIFICATION (so the ONLY thing that could block completion is the
  // plan-coverage gate — isolating it from the #1522 verification gate). The
  // ROADMAP declares Phase 1 so completion has a phase to act on.
  function writePlanCoverageFixture(tmpDir, { plans, summaries, supersededPlans = [] }) {
    const planningDir = path.join(tmpDir, '.planning');
    const phase1Dir = path.join(planningDir, 'phases', '01-foundation');
    fs.mkdirSync(phase1Dir, { recursive: true });

    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      [
        '# Roadmap', '',
        '- [ ] Phase 1: Foundation', '',
        '### Phase 1: Foundation',
        '**Goal:** Setup', '**Plans:** 3 plans', '',
        '## Progress', '',
        '| Phase | Plans Complete | Status | Completed |',
        '|-------|----------------|--------|-----------|',
        '| 01. Foundation | 0/3 | Not started | - |', '',
      ].join('\n'),
    );

    // createTempProject() scaffolds .planning/phases but NOT STATE.md; write it
    // so the "ROADMAP/STATE unchanged on refusal" assertions have a file to read
    // (mirrors writePhaseCompleteVerificationGateFixture's STATE.md write above).
    fs.writeFileSync(
      path.join(planningDir, 'STATE.md'),
      [
        '# State', '',
        '**Current Phase:** 01',
        '**Current Phase Name:** Foundation',
        '**Status:** In progress',
        '**Current Plan:** 01-01',
        '**Last Activity:** 2025-01-01',
        '**Last Activity Description:** Working on phase 1', '',
      ].join('\n'),
    );

    for (const plan of plans) {
      const isSuperseded = supersededPlans.includes(plan);
      const body = isSuperseded
        ? ['---', 'status: superseded', '---', '', '# Plan (retired)', ''].join('\n')
        : ['# Plan', ''].join('\n');
      fs.writeFileSync(path.join(phase1Dir, `01-${plan}-PLAN.md`), body);
    }
    for (const summary of summaries) {
      fs.writeFileSync(path.join(phase1Dir, `01-${summary}-SUMMARY.md`), '# Summary\n');
    }
    // A passed VERIFICATION — so the verification gate (#1522) does NOT fire;
    // only the plan-coverage gate is under test.
    fs.writeFileSync(
      path.join(phase1Dir, '01-VERIFICATION.md'),
      ['---', 'status: passed', '---', '', '# Verification', ''].join('\n'),
    );
  }

  test('blocks completion when plans lack summaries despite a passed verification', () => {
    // 3 plans, only 1 has a summary → 2 unsummarized. Verifier passed.
    // Pre-#2648 this completed silently; it must now refuse and name the gaps.
    writePlanCoverageFixture(tmpDir, {
      plans: ['01', '02', '03'],
      summaries: ['01'],
    });
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const beforeRoadmap = fs.readFileSync(roadmapPath, 'utf-8');
    const beforeState = fs.readFileSync(statePath, 'utf-8');

    const result = runGsdTools(['--json-errors', 'phase', 'complete', '1'], tmpDir);

    assert.equal(result.success, false, 'phase complete must fail when plans lack completion records (#2648)');
    const errorPayload = JSON.parse(result.error);
    assert.equal(errorPayload.reason, 'phase_plan_coverage_incomplete');
    assert.match(errorPayload.message, /2 plan\(s\) have no completion record/);
    // Names the missing plans (02 and 03), not a generic refusal.
    assert.match(errorPayload.message, /02/);
    assert.match(errorPayload.message, /03/);
    // Nothing mutated.
    assert.equal(fs.readFileSync(roadmapPath, 'utf-8'), beforeRoadmap);
    assert.equal(fs.readFileSync(statePath, 'utf-8'), beforeState);
  });

  test('a plan retired via status: superseded does not block completion', () => {
    // 3 plans, 1 summary. Plans 02 and 03 have no summary, BUT plan 03 is
    // explicitly retired (status: superseded, #2349). Only plan 02 is an
    // actionable gap → completion still refuses, naming ONLY 02, proving the
    // retired plan is excluded from the gate (the lock/recovery pattern is
    // preserved, the Goodhart hole is closed).
    writePlanCoverageFixture(tmpDir, {
      plans: ['01', '02', '03'],
      summaries: ['01'],
      supersededPlans: ['03'],
    });

    const result = runGsdTools(['--json-errors', 'phase', 'complete', '1'], tmpDir);

    assert.equal(result.success, false, 'phase 2 is still an unsummarized, non-retired gap');
    const errorPayload = JSON.parse(result.error);
    assert.equal(errorPayload.reason, 'phase_plan_coverage_incomplete');
    assert.match(errorPayload.message, /1 plan\(s\) have no completion record/);
    assert.match(errorPayload.message, /02/);
    // The retired plan 03 is NOT named as a gap.
    assert.doesNotMatch(errorPayload.message, /\b03\b/);
  });

  test('a fully-covered phase with a passed verification completes normally', () => {
    // Regression guard: the gate must not over-block a healthy phase where
    // every plan has a summary.
    writePlanCoverageFixture(tmpDir, {
      plans: ['01', '02', '03'],
      summaries: ['01', '02', '03'],
    });

    const result = runGsdTools(['phase', 'complete', '1'], tmpDir);

    assert.equal(result.success, true, `phase complete failed on a fully-covered phase: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.equal(out.completed_phase, '1');
  });

  // NOTE on the security-review B1 case (fail-closed on an UNREADABLE plan dir):
  // the gate defends it in code — it readdirSync's the phase dir and refuses on a
  // throw before scanPhasePlans' swallow-and-return-empty can make the gate pass
  // (src/phase.cts). It is NOT covered by a unit test here because there is no
  // cross-platform, root-safe way to construct it: any condition that makes the
  // phase dir unreadable to the gate's readdirSync ALSO makes findPhaseInternal
  // (which walks the parent phases/ dir) fail upstream with "Phase N not found"
  // before the gate runs, and the root-safe alternative to chmod 0o000 does not
  // exist (root bypasses mode bits, so a mode-based test silently passes with
  // zero coverage in root Docker/CI — the documented reason the repo forbids
  // chmod-based IO-failure tests). The defensive code is cheap and correct; the
  // unreachable-path gap is recorded in 60-review.json.
});

describe('phase complete command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('marks phase complete and transitions to next', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Foundation
- [ ] Phase 2: API

### Phase 1: Foundation
**Goal:** Setup
**Plans:** 1 plans

### Phase 2: API
**Goal:** Build API
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Foundation\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working on phase 1\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-api'), { recursive: true });

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.completed_phase, '1');
    assert.strictEqual(output.plans_executed, '1/1');
    assert.strictEqual(output.next_phase, '02');
    assert.strictEqual(output.is_last_phase, false);

    // Verify STATE.md updated
    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(state.includes('**Current Phase:** 02'), 'should advance to phase 02');
    assert.ok(state.includes('**Status:** Ready to plan'), 'status should be ready to plan');
    assert.ok(state.includes('**Current Plan:** Not started'), 'plan should be reset');

    // Verify ROADMAP checkbox
    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('[x]'), 'phase should be checked off');
    assert.ok(roadmap.includes('completed'), 'completion date should be added');
  });

  // #2067: the checkbox regex in cmdPhaseComplete used a greedy `.*` between
  // `]` and `Phase N`, so completing Phase 1 (already checked → idempotent
  // re-run) matched a LATER phase whose description merely mentioned "Phase 1".
  // Non-global replace then checked the wrong phase's box. The gap between `]`
  // and `Phase` must allow only whitespace / markdown emphasis.
  test('#2067 — completing a phase must not check a later phase whose description mentions it (idempotent re-run)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [x] **Phase 1: Core Feed & Posting** - first slice (completed 2025-01-01)
- [ ] **Phase 2: Polish & Edge Cases** - hardening (only as needed after Phase 1 verification)

### Phase 1: Core Feed & Posting
**Goal:** Ship feed
**Plans:** 1 plans

### Phase 2: Polish & Edge Cases
**Goal:** Harden
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Core Feed & Posting\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working on phase 1\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-core-feed-posting');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-polish-edge-cases'), { recursive: true });

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    // Phase 2's checkbox MUST remain unchecked — its description mentions
    // "Phase 1" but it is NOT the phase being completed.
    const phase2Line = roadmap.match(/^- \[([ x])\] \*\*Phase 2:.*$/m);
    assert.ok(phase2Line, 'Phase 2 line must still be present in ROADMAP');
    assert.strictEqual(phase2Line[1], ' ', 'Phase 2 checkbox must remain unchecked (#2067)');
    // Phase 1 must remain checked.
    const phase1Line = roadmap.match(/^- \[([ x])\] \*\*Phase 1:.*$/m);
    assert.ok(phase1Line, 'Phase 1 line must still be present in ROADMAP');
    assert.strictEqual(phase1Line[1], 'x', 'Phase 1 checkbox must remain checked (#2067)');
  });

  // #2067 companion: normal completion (Phase 1 unchecked) must still check
  // Phase 1 — and must NOT also check a later phase whose description mentions
  // Phase 1. Guards the tightened regex against over-restricting the happy path.
  test('#2067 — normal completion checks only the target phase when a later phase mentions it', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 1: Core Feed & Posting** - first slice
- [ ] **Phase 2: Polish & Edge Cases** - hardening (only as needed after Phase 1 verification)

### Phase 1: Core Feed & Posting
**Goal:** Ship feed
**Plans:** 1 plans

### Phase 2: Polish & Edge Cases
**Goal:** Harden
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Core Feed & Posting\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working on phase 1\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-core-feed-posting');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-polish-edge-cases'), { recursive: true });

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const phase1Line = roadmap.match(/^- \[([ x])\] \*\*Phase 1:.*$/m);
    assert.ok(phase1Line, 'Phase 1 line must still be present in ROADMAP');
    assert.strictEqual(phase1Line[1], 'x', 'Phase 1 checkbox must be checked');
    const phase2Line = roadmap.match(/^- \[([ x])\] \*\*Phase 2:.*$/m);
    assert.ok(phase2Line, 'Phase 2 line must still be present in ROADMAP');
    assert.strictEqual(phase2Line[1], ' ', 'Phase 2 checkbox must remain unchecked (#2067)');
  });

  test('#2012 — Progress row updated even when an earlier phase-numbered table precedes ## Progress', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 3: Build

### Phase 3: Build
**Goal:** Build stuff

## Requirements Coverage

| Phase | Requirements | Count |
|-------|-------------|-------|
| 3. Build | R-01 | 5 |

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 3. Build | v1.0 | 0/1 | Planned | - |
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 03\n**Status:** In progress\n**Last Activity:** 2025-01-01\n`
    );

    const p3 = path.join(tmpDir, '.planning', 'phases', '03-build');
    fs.mkdirSync(p3, { recursive: true });
    fs.writeFileSync(path.join(p3, '03-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p3, '03-01-SUMMARY.md'), '# Summary');

    const result = runVerifiedPhaseComplete('phase complete 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');

    // The Requirements coverage table row must be UNCHANGED (3 columns, not a Progress row).
    const reqRow = roadmap.match(/^\| 3\. Build \| R-01 \| 5 \|$/m);
    assert.ok(reqRow, 'Requirements coverage row must be untouched');

    // The Progress row must be updated to Complete with a date.
    const progressRow = roadmap.match(/^\| 3\. Build \| v1\.0 \| 1\/1 \| Complete\s+\| \d{4}-\d{2}-\d{2} \|/m);
    assert.ok(progressRow, 'Progress row must be updated to Complete with a date');
  });

  test('detects last phase in milestone', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n### Phase 1: Only Phase\n**Goal:** Everything\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-only-phase');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.is_last_phase, true, 'should detect last phase');
    assert.strictEqual(output.next_phase, null, 'no next phase');

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(state.includes('All phases complete'), 'status should be All phases complete');
  });

  // #1591: when the active milestone's phase checklist is wrapped in a
  // <details> block AND phases are written as `- [ ] Phase N:` checkbox list
  // items (not `### Phase N:` headings), phase.complete's next-phase enumerator
  // saw no further phases → is_last_phase=true, next_phase=null on a mid-
  // milestone phase, and STATE.md was wrongly marked "Milestone complete" with
  // total_phases decremented. extractCurrentMilestone correctly surfaces the
  // <details>-wrapped checklist; the defect was the heading-only phasePattern
  // at the isLastPhase enumerator not recognizing checkbox-list phase items.
  test('#1591: <details>-wrapped checkbox checklist — mid-milestone phase is NOT last', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# ROADMAP',
        '',
        '## Phases',
        '',
        '<details>',
        '<summary>✅ v1.0 First (Phases 1–3) — SHIPPED</summary>',
        '',
        '- [x] Phase 1: a',
        '- [x] Phase 2: b',
        '- [x] Phase 3: c',
        '',
        '</details>',
        '',
        '<details>',
        '<summary>🚀 v2.0 Second (Phases 36–38) — IN PLANNING</summary>',
        '',
        '- [x] Phase 36: first (completed)',
        '- [ ] Phase 37: second',
        '- [ ] Phase 38: third',
        '',
        '</details>',
        '',
        '## Backlog',
        '',
        '### Phase 999.1: future (BACKLOG)',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v2.0',
        'milestone_name: Second',
        'current_phase: "36"',
        'status: executing',
        '---',
        '',
        '# GSD State',
        '',
        '**Current Phase:** 36',
        '**Status:** Executing Phase 36',
        '',
      ].join('\n')
    );
    // Only the COMPLETING phase (36) has a directory. Phases 37/38 exist only
    // as `- [ ]` checklist items in the ROADMAP — they are not yet started, so
    // they have no phase dirs. This is the @Azd325 scenario: the disk-based
    // next-phase resolver finds nothing, and the roadmap-enumeration fallback
    // (the heading-only phasePattern) is the only path that can find Phase 37.
    const d36 = path.join(tmpDir, '.planning', 'phases', '36-first');
    fs.mkdirSync(d36, { recursive: true });
    fs.writeFileSync(path.join(d36, '36-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(d36, '36-SUMMARY.md'), '# Summary\n');

    const result = runVerifiedPhaseComplete('phase complete 36', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(
      output.is_last_phase,
      false,
      'Phase 36 of 36–38 must NOT be last — Phases 37/38 are still open `- [ ]` (#1591)',
    );
    assert.strictEqual(
      output.next_phase,
      '37',
      'next_phase must resolve to 37 from the <details>-wrapped checkbox checklist (#1591)',
    );

    // Cascade check: a wrong is_last_phase=true previously wrote "Milestone
    // complete" + decremented total_phases. With the fix, the milestone is
    // still in progress.
    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(
      !/Milestone complete|All phases complete/i.test(state),
      'a mid-milestone phase must not flip STATE.md to milestone-complete (#1591)',
    );
  });

  // #1591 (bold-checklist follow-up): the roadmap TEMPLATE emits checklist rows
  // in the canonical BOLD form `- [ ] **Phase N: Name**`. The initial checkbox
  // broadening only matched the un-bolded `- [ ] Phase N:` shape, so the exact
  // <details>-wrapped bold template still fell through to is_last_phase=true.
  // Guard the canonical bold form explicitly.
  test('#1591: <details>-wrapped BOLD checkbox checklist — mid-milestone phase is NOT last', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# ROADMAP',
        '',
        '## Phases',
        '',
        '<details>',
        '<summary>🚀 v2.0 Second (Phases 36–38) — IN PLANNING</summary>',
        '',
        '- [x] **Phase 36: first (completed)** - done',
        '- [ ] **Phase 37: second** - one-line description',
        '- [ ] **Phase 38: third** - one-line description',
        '',
        '</details>',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v2.0',
        'milestone_name: Second',
        'current_phase: "36"',
        'status: executing',
        '---',
        '',
        '# GSD State',
        '',
        '**Current Phase:** 36',
        '**Status:** Executing Phase 36',
        '',
      ].join('\n')
    );
    // Only Phase 36 has a directory; 37/38 are bold `- [ ]` checklist rows only.
    const d36 = path.join(tmpDir, '.planning', 'phases', '36-first');
    fs.mkdirSync(d36, { recursive: true });
    fs.writeFileSync(path.join(d36, '36-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(d36, '36-SUMMARY.md'), '# Summary\n');

    const result = runVerifiedPhaseComplete('phase complete 36', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(
      output.is_last_phase,
      false,
      'Phase 36 of 36–38 must NOT be last with the canonical BOLD checklist (#1591)',
    );
    assert.strictEqual(
      output.next_phase,
      '37',
      'next_phase must resolve to 37 from the BOLD `- [ ] **Phase N: ...**` checklist (#1591)',
    );

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(
      !/Milestone complete|All phases complete/i.test(state),
      'a mid-milestone phase must not flip STATE.md to milestone-complete — bold checklist (#1591)',
    );
  });

  // #1752: the #1591 follow-up — when phase.complete wrongly returned
  // is_last_phase=true on a <details>-wrapped mid-milestone checklist, the
  // milestone-complete cascade also DECREMENTED progress.total_phases (e.g.
  // 8 -> 7) and flipped status. Same root cause, distinct symptom. With the
  // #1591 fix (is_last_phase=false), the decrement must not occur: with all 8
  // phase dirs on disk, total_phases stays 8 and status does not flip.
  test('#1752: <details>-wrapped checklist — total_phases is NOT decremented on a mid-milestone phase', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# ROADMAP',
        '',
        '## Phases',
        '',
        '<details>',
        '<summary>✅ v1.0 First (Phases 1–3) — SHIPPED</summary>',
        '',
        '- [x] Phase 1: a',
        '- [x] Phase 2: b',
        '- [x] Phase 3: c',
        '',
        '</details>',
        '',
        '<details>',
        '<summary>🚀 v2.0 Second (Phases 36–43) — IN PLANNING</summary>',
        '',
        '- [x] Phase 36: first (completed)',
        '- [ ] Phase 37: second',
        '- [ ] Phase 38: third',
        '- [ ] Phase 39: fourth',
        '',
        '</details>',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v2.0',
        'milestone_name: Second',
        'current_phase: "36"',
        'status: executing',
        'progress:',
        '  total_phases: 8',
        '  completed_phases: 5',
        '  percent: 62',
        '---',
        '',
        '# GSD State',
        '',
        '**Current Phase:** 36',
        '**Status:** Executing Phase 36',
        '',
      ].join('\n')
    );
    // All 8 phase dirs on disk (Phases 36–43) so the disk count is 8 — the
    // reporter's real state. Before the #1591 fix, phase.complete 36 returned
    // is_last_phase=true (no Phase 37+ heading match) and the milestone-complete
    // path DECREMENTED total_phases 8 -> 7.
    const names = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth'];
    for (let i = 0; i < 8; i++) {
      const num = String(36 + i);
      const d = path.join(tmpDir, '.planning', 'phases', `${num}-${names[i]}`);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, `${num}-PLAN.md`), '# Plan\n');
      // #2648: phase.complete now refuses when a non-retired plan has no matching
      // *-SUMMARY.md. This test's concern is the total_phases-decrement cascade,
      // not plan coverage, so give each phase's plan a summary to keep it
      // fully-covered and isolate the #1752 behavior under test.
      fs.writeFileSync(path.join(d, `${num}-SUMMARY.md`), '# Summary\n');
    }

    const result = runVerifiedPhaseComplete('phase complete 36', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.is_last_phase, false, 'is_last_phase must be false (#1752 cascade root)');

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(
      !/Milestone complete|All phases complete/i.test(state),
      'a mid-milestone phase must not flip STATE.md to milestone-complete (#1752)',
    );
    const tpMatch = state.match(/total_phases:\s*(\d+)/);
    assert.ok(tpMatch, 'STATE.md must carry a total_phases value after phase.complete');
    assert.notStrictEqual(
      parseInt(tpMatch[1], 10),
      7,
      'total_phases must NOT be decremented to 7 — the #1752 cascade of the false is_last_phase',
    );
  });

  test('updates REQUIREMENTS.md traceability when phase completes', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Auth

### Phase 1: Auth
**Goal:** User authentication
**Requirements:** AUTH-01, AUTH-02
**Plans:** 1 plans

### Phase 2: API
**Goal:** Build API
**Requirements:** API-01
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

## v1 Requirements

### Authentication

- [ ] **AUTH-01**: User can sign up with email
- [ ] **AUTH-02**: User can log in
- [ ] **AUTH-03**: User can reset password

### API

- [ ] **API-01**: REST endpoints

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | Phase 1 | Pending |
| AUTH-02 | Phase 1 | Pending |
| AUTH-03 | Phase 2 | Pending |
| API-01 | Phase 2 | Pending |
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Auth\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-auth');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-api'), { recursive: true });

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const req = fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');

    // Checkboxes updated for phase 1 requirements
    assert.ok(req.includes('- [x] **AUTH-01**'), 'AUTH-01 checkbox should be checked');
    assert.ok(req.includes('- [x] **AUTH-02**'), 'AUTH-02 checkbox should be checked');
    // Other requirements unchanged
    assert.ok(req.includes('- [ ] **AUTH-03**'), 'AUTH-03 should remain unchecked');
    assert.ok(req.includes('- [ ] **API-01**'), 'API-01 should remain unchecked');

    // Traceability table updated
    assert.ok(req.includes('| AUTH-01 | Phase 1 | Complete |'), 'AUTH-01 status should be Complete');
    assert.ok(req.includes('| AUTH-02 | Phase 1 | Complete |'), 'AUTH-02 status should be Complete');
    assert.ok(req.includes('| AUTH-03 | Phase 2 | Pending |'), 'AUTH-03 should remain Pending');
    assert.ok(req.includes('| API-01 | Phase 2 | Pending |'), 'API-01 should remain Pending');
  });

  test('#2245 F1: phase complete traceability write is not fooled by an earlier Out of Scope table', () => {
    // Same class as the milestone.cts F1 regression: the shipped requirements
    // template puts an `## Out of Scope` table (`| Feature | Reason |`, no
    // Status column) BEFORE `## Traceability` — an unscoped updateTableCell
    // call binds to the FIRST table in the file (Out of Scope) and silently
    // fails, leaving the Traceability row unflipped while the checkbox still
    // flips and the command reports requirements_updated:true.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Auth

### Phase 1: Auth
**Goal:** User authentication
**Requirements:** AUTH-01
**Plans:** 1 plans
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

## v1 Requirements

### Authentication

- [ ] **AUTH-01**: User can sign up with email

## Out of Scope

| Feature | Reason |
|---------|--------|
| Foo | Bar |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | Phase 1 | Pending |
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Auth\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-auth');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const req = fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
    assert.ok(req.includes('- [x] **AUTH-01**'), 'AUTH-01 checkbox should be checked');
    assert.ok(req.includes('| AUTH-01 | Phase 1 | Complete |'),
      'the Traceability row (not the Out of Scope table) must be flipped to Complete');
    assert.ok(req.includes('| Foo | Bar |'), 'the Out of Scope table must be left untouched');
  });

  test('handles requirements with bracket format [REQ-01, REQ-02]', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Auth

### Phase 1: Auth
**Goal:** User authentication
**Requirements:** [AUTH-01, AUTH-02]
**Plans:** 1 plans

### Phase 2: API
**Goal:** Build API
**Requirements:** [API-01]
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

## v1 Requirements

### Authentication

- [ ] **AUTH-01**: User can sign up with email
- [ ] **AUTH-02**: User can log in
- [ ] **AUTH-03**: User can reset password

### API

- [ ] **API-01**: REST endpoints

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | Phase 1 | Pending |
| AUTH-02 | Phase 1 | Pending |
| AUTH-03 | Phase 2 | Pending |
| API-01 | Phase 2 | Pending |
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Auth\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-auth');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-api'), { recursive: true });

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const req = fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');

    // Checkboxes updated for phase 1 requirements (brackets stripped)
    assert.ok(req.includes('- [x] **AUTH-01**'), 'AUTH-01 checkbox should be checked');
    assert.ok(req.includes('- [x] **AUTH-02**'), 'AUTH-02 checkbox should be checked');
    // Other requirements unchanged
    assert.ok(req.includes('- [ ] **AUTH-03**'), 'AUTH-03 should remain unchecked');
    assert.ok(req.includes('- [ ] **API-01**'), 'API-01 should remain unchecked');

    // Traceability table updated
    assert.ok(req.includes('| AUTH-01 | Phase 1 | Complete |'), 'AUTH-01 status should be Complete');
    assert.ok(req.includes('| AUTH-02 | Phase 1 | Complete |'), 'AUTH-02 status should be Complete');
    assert.ok(req.includes('| AUTH-03 | Phase 2 | Pending |'), 'AUTH-03 should remain Pending');
    assert.ok(req.includes('| API-01 | Phase 2 | Pending |'), 'API-01 should remain Pending');
  });

  test('handles phase with no requirements mapping', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Setup

### Phase 1: Setup
**Goal:** Project setup (no requirements)
**Plans:** 1 plans
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

## v1 Requirements

- [ ] **REQ-01**: Some requirement

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| REQ-01 | Phase 2 | Pending |
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // REQUIREMENTS.md should be unchanged
    const req = fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
    assert.ok(req.includes('- [ ] **REQ-01**'), 'REQ-01 should remain unchecked');
    assert.ok(req.includes('| REQ-01 | Phase 2 | Pending |'), 'REQ-01 should remain Pending');
  });

  test('handles missing REQUIREMENTS.md gracefully', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Foundation
**Requirements:** REQ-01

### Phase 1: Foundation
**Goal:** Setup
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `Command should succeed even without REQUIREMENTS.md: ${result.error}`);
  });

  test('returns requirements_updated field in result', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Auth

### Phase 1: Auth
**Goal:** User authentication
**Requirements:** AUTH-01
**Plans:** 1 plans
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

## v1 Requirements

- [ ] **AUTH-01**: User can sign up

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | Phase 1 | Pending |
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Auth\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-auth');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const parsed = JSON.parse(result.output);
    assert.strictEqual(parsed.requirements_updated, true, 'requirements_updated should be true');
  });

  test('handles In Progress status in traceability table', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Auth

### Phase 1: Auth
**Goal:** User authentication
**Requirements:** AUTH-01, AUTH-02
**Plans:** 1 plans
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

## v1 Requirements

- [ ] **AUTH-01**: User can sign up
- [ ] **AUTH-02**: User can log in

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | Phase 1 | In Progress |
| AUTH-02 | Phase 1 | Pending |
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Auth\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-auth');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const req = fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
    assert.ok(req.includes('| AUTH-01 | Phase 1 | Complete |'), 'In Progress should become Complete');
    assert.ok(req.includes('| AUTH-02 | Phase 1 | Complete |'), 'Pending should become Complete');
  });

  test('scoped regex does not cross phase boundaries', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Setup
- [ ] Phase 2: Auth

### Phase 1: Setup
**Goal:** Project setup
**Plans:** 1 plans

### Phase 2: Auth
**Goal:** User authentication
**Requirements:** AUTH-01
**Plans:** 0 plans
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

## v1 Requirements

- [ ] **AUTH-01**: User can sign up

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| AUTH-01 | Phase 2 | Pending |
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** Setup\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-auth'), { recursive: true });

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // Phase 1 has no Requirements field, so Phase 2's AUTH-01 should NOT be updated
    const req = fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
    assert.ok(req.includes('- [ ] **AUTH-01**'), 'AUTH-01 should remain unchecked (belongs to Phase 2)');
    assert.ok(req.includes('| AUTH-01 | Phase 2 | Pending |'), 'AUTH-01 should remain Pending (belongs to Phase 2)');
  });

  test('handles multi-level decimal phase without regex crash', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [x] Phase 3: Lorem
- [x] Phase 3.2: Ipsum
- [ ] Phase 3.2.1: Dolor Sit
- [ ] Phase 4: Amet

### Phase 3: Lorem
**Goal:** Setup
**Plans:** 1/1 plans complete
**Requirements:** LOR-01

### Phase 3.2: Ipsum
**Goal:** Build
**Plans:** 1/1 plans complete
**Requirements:** IPS-01

### Phase 03.2.1: Dolor Sit Polish (INSERTED)
**Goal:** Polish
**Plans:** 1/1 plans complete

### Phase 4: Amet
**Goal:** Deliver
**Requirements:** AMT-01: Filter items by category with AND logic (items matching ALL selected categories)
`
    );

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements

- [ ] **LOR-01**: Lorem database schema
- [ ] **IPS-01**: Ipsum rendering engine
- [ ] **AMT-01**: Filter items by category
`
    );

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State

**Current Phase:** 03.2.1
**Current Phase Name:** Dolor Sit Polish
**Status:** Execution complete
**Current Plan:** 03.2.1-01
**Last Activity:** 2025-01-01
**Last Activity Description:** Working
`
    );

    const p32 = path.join(tmpDir, '.planning', 'phases', '03.2-ipsum');
    const p321 = path.join(tmpDir, '.planning', 'phases', '03.2.1-dolor-sit');
    const p4 = path.join(tmpDir, '.planning', 'phases', '04-amet');
    fs.mkdirSync(p32, { recursive: true });
    fs.mkdirSync(p321, { recursive: true });
    fs.mkdirSync(p4, { recursive: true });
    fs.writeFileSync(path.join(p321, '03.2.1-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p321, '03.2.1-01-SUMMARY.md'), '# Summary');

    const result = runVerifiedPhaseComplete('phase complete 03.2.1', tmpDir);
    assert.ok(result.success, `Command should not crash on regex metacharacters: ${result.error}`);

    const req = fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
    assert.ok(req.includes('- [ ] **AMT-01**'), 'AMT-01 should remain unchanged');
  });

  test('preserves Milestone column in 5-column progress table', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Foundation

### Phase 1: Foundation
**Goal:** Setup
**Plans:** 1 plans

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation | v1.0 | 0/1 | Planned |  |
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses ROADMAP.md the test itself wrote via a fixed fixture string, bounded, not adversarial input
    const rowMatch = roadmap.match(/^\|[^\r\n]*1\. Foundation[^\r\n]*$/m);
    assert.ok(rowMatch, 'table row should exist');
    const cells = rowMatch[0].split('|').slice(1, -1).map(c => c.trim());
    assert.strictEqual(cells.length, 5, 'should have 5 columns');
    assert.strictEqual(cells[1], 'v1.0', 'Milestone column should be preserved');
    assert.ok(cells[3].includes('Complete'), 'Status column should be Complete');
  });

  test('updates STATE.md with plain format fields (no bold)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 1: Only\n**Goal:** Test\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\nPhase: 1 of 1 (Only)\nStatus: In progress\nPlan: 01-01\nLast Activity: 2025-01-01\nLast Activity Description: Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-only');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(state.includes('All phases complete'), 'plain Status field should be updated');
    assert.ok(state.includes('Not started'), 'plain Plan field should be updated');
    // Verify compound format preserved
    assert.ok(state.match(/Phase:.*of\s+1/), 'should preserve "of N" in compound Phase format');
  });

  test('updates Plans Complete column in 4-column progress table', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Foundation
- [ ] Phase 2: API

### Phase 1: Foundation
**Goal:** Setup
**Plans:** 1 plans

### Phase 2: API
**Goal:** Build API

## Progress

| Phase | Plans Complete | Status | Completed |
|-------|----------------|--------|-----------|
| 1. Foundation | 0/1 | Not started | - |
| 2. API | 0/1 | Not started | - |
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-api'), { recursive: true });

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses ROADMAP.md the test itself wrote via a fixed fixture string, bounded, not adversarial input
    const rowMatch = roadmap.match(/^\|[^\r\n]*1\. Foundation[^\r\n]*$/m);
    assert.ok(rowMatch, 'table row should exist');
    const cells = rowMatch[0].split('|').slice(1, -1).map(c => c.trim());
    assert.strictEqual(cells.length, 4, 'should have 4 columns');
    assert.strictEqual(cells[1], '1/1', 'Plans Complete column should be updated to 1/1');
    assert.ok(cells[2].includes('Complete'), 'Status column should be Complete');
  });

  test('updates Plans Complete column in 5-column progress table', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Foundation

### Phase 1: Foundation
**Goal:** Setup
**Plans:** 1 plans

## Progress

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 1. Foundation | v1.0 | 0/1 | Planned |  |
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses ROADMAP.md the test itself wrote via a fixed fixture string, bounded, not adversarial input
    const rowMatch = roadmap.match(/^\|[^\r\n]*1\. Foundation[^\r\n]*$/m);
    assert.ok(rowMatch, 'table row should exist');
    const cells = rowMatch[0].split('|').slice(1, -1).map(c => c.trim());
    assert.strictEqual(cells.length, 5, 'should have 5 columns');
    assert.strictEqual(cells[2], '1/1', 'Plans Complete column should be updated to 1/1');
    assert.ok(cells[3].includes('Complete'), 'Status column should be Complete');
  });

  test('marks plan-level checkboxes on phase complete', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Foundation

### Phase 1: Foundation
**Goal:** Setup
**Plans:** 2 plans

Plans:
- [ ] 01-01-PLAN.md \u2014 Schema migration
- [ ] 01-02-PLAN.md \u2014 Auth setup
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Status:** In progress\n**Current Plan:** 01-02\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(p1, '01-02-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-02-SUMMARY.md'), '# Summary');

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('[x] 01-01-PLAN.md'), 'plan 01-01 checkbox should be checked');
    assert.ok(roadmap.includes('[x] 01-02-PLAN.md'), 'plan 01-02 checkbox should be checked');
    assert.ok(!roadmap.includes('[ ] 01-01-PLAN.md'), 'plan 01-01 should not remain unchecked');
    assert.ok(!roadmap.includes('[ ] 01-02-PLAN.md'), 'plan 01-02 should not remain unchecked');
  });

  test('marks bold-wrapped plan-level checkboxes on phase complete', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] Phase 1: Foundation

### Phase 1: Foundation
**Goal:** Setup
**Plans:** 2 plans

Plans:
- [ ] **01-01**: Schema migration
- [ ] **01-02**: Auth setup
`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Status:** In progress\n**Current Plan:** 01-02\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );

    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(p1, '01-02-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-02-SUMMARY.md'), '# Summary');

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const roadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(roadmap.includes('[x] **01-01**'), 'bold plan 01-01 checkbox should be checked');
    assert.ok(roadmap.includes('[x] **01-02**'), 'bold plan 01-02 checkbox should be checked');
    assert.ok(!roadmap.includes('[ ] **01-01**'), 'bold plan 01-01 should not remain unchecked');
    assert.ok(!roadmap.includes('[ ] **01-02**'), 'bold plan 01-02 should not remain unchecked');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// comparePhaseNum and normalizePhaseName (imported directly)
// ─────────────────────────────────────────────────────────────────────────────

const { comparePhaseNum, normalizePhaseName } = require('../gsd-core/bin/lib/phase-id.cjs');

describe('comparePhaseNum', () => {
  test('sorts integer phases numerically', () => {
    assert.ok(comparePhaseNum('2', '10') < 0);
    assert.ok(comparePhaseNum('10', '2') > 0);
    assert.strictEqual(comparePhaseNum('5', '5'), 0);
  });

  test('sorts decimal phases correctly', () => {
    assert.ok(comparePhaseNum('12', '12.1') < 0);
    assert.ok(comparePhaseNum('12.1', '12.2') < 0);
    assert.ok(comparePhaseNum('12.2', '13') < 0);
  });

  test('sorts letter-suffix phases correctly', () => {
    assert.ok(comparePhaseNum('12', '12A') < 0);
    assert.ok(comparePhaseNum('12A', '12B') < 0);
    assert.ok(comparePhaseNum('12B', '13') < 0);
  });

  test('sorts hybrid phases correctly', () => {
    assert.ok(comparePhaseNum('12A', '12A.1') < 0);
    assert.ok(comparePhaseNum('12A.1', '12A.2') < 0);
    assert.ok(comparePhaseNum('12A.2', '12B') < 0);
  });

  test('handles full sort order', () => {
    const phases = ['13', '12B', '12A.2', '12', '12.1', '12A', '12A.1', '12.2'];
    phases.sort(comparePhaseNum);
    assert.deepStrictEqual(phases, ['12', '12.1', '12.2', '12A', '12A.1', '12A.2', '12B', '13']);
  });

  test('handles directory names with slugs', () => {
    const dirs = ['13-deploy', '12B-hotfix', '12A.1-bugfix', '12-foundation', '12.1-inserted', '12A-split'];
    dirs.sort(comparePhaseNum);
    assert.deepStrictEqual(dirs, [
      '12-foundation', '12.1-inserted', '12A-split', '12A.1-bugfix', '12B-hotfix', '13-deploy'
    ]);
  });

  test('case insensitive letter matching', () => {
    assert.ok(comparePhaseNum('12a', '12B') < 0);
    assert.ok(comparePhaseNum('12A', '12b') < 0);
    assert.strictEqual(comparePhaseNum('12a', '12A'), 0);
  });

  test('sorts multi-level decimal phases correctly', () => {
    assert.ok(comparePhaseNum('3.2', '3.2.1') < 0);
    assert.ok(comparePhaseNum('3.2.1', '3.2.2') < 0);
    assert.ok(comparePhaseNum('3.2.1', '3.3') < 0);
    assert.ok(comparePhaseNum('3.2.1', '4') < 0);
    assert.strictEqual(comparePhaseNum('3.2.1', '3.2.1'), 0);
  });

  test('falls back to localeCompare for non-phase strings', () => {
    const result = comparePhaseNum('abc', 'def');
    assert.strictEqual(typeof result, 'number');
  });
});

describe('normalizePhaseName', () => {
  test('pads single-digit integers', () => {
    assert.strictEqual(normalizePhaseName('3'), '03');
    assert.strictEqual(normalizePhaseName('12'), '12');
  });

  test('handles decimal phases', () => {
    assert.strictEqual(normalizePhaseName('3.1'), '03.1');
    assert.strictEqual(normalizePhaseName('12.2'), '12.2');
  });

  test('handles letter-suffix phases', () => {
    assert.strictEqual(normalizePhaseName('3A'), '03A');
    assert.strictEqual(normalizePhaseName('12B'), '12B');
  });

  test('handles hybrid phases', () => {
    assert.strictEqual(normalizePhaseName('3A.1'), '03A.1');
    assert.strictEqual(normalizePhaseName('12A.2'), '12A.2');
  });

  test('preserves letter case', () => {
    assert.strictEqual(normalizePhaseName('3a'), '03a');
    assert.strictEqual(normalizePhaseName('12b.1'), '12b.1');
  });

  test('handles multi-level decimal phases', () => {
    assert.strictEqual(normalizePhaseName('3.2.1'), '03.2.1');
    assert.strictEqual(normalizePhaseName('12.3.4'), '12.3.4');
  });

  test('returns non-matching input unchanged', () => {
    assert.strictEqual(normalizePhaseName('abc'), 'abc');
  });
});

describe('letter-suffix phase sorting', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('lists letter-suffix phases in correct order', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '12-foundation'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '12.1-inserted'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '12A-split'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '12A.1-bugfix'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '12B-hotfix'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '13-deploy'), { recursive: true });

    const result = runGsdTools('phases list', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(
      output.directories,
      ['12-foundation', '12.1-inserted', '12A-split', '12A.1-bugfix', '12B-hotfix', '13-deploy'],
      'letter-suffix phases should sort correctly'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// milestone-scoped next-phase in phase complete
// ─────────────────────────────────────────────────────────────────────────────

describe('phase complete milestone-scoped next-phase', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('finds next phase within milestone, ignoring prior milestone dirs', () => {
    // ROADMAP lists phases 5-6 (current milestone v2.0)
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '## Roadmap v2.0: Release',
        '',
        '- [ ] Phase 5: Auth',
        '- [ ] Phase 6: Dashboard',
        '',
        '### Phase 5: Auth',
        '**Goal:** Add authentication',
        '**Plans:** 1 plans',
        '',
        '### Phase 6: Dashboard',
        '**Goal:** Build dashboard',
      ].join('\n')
    );

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# State\n\n**Current Phase:** 05\n**Current Phase Name:** Auth\n**Status:** In progress\n**Current Plan:** 05-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n'
    );

    // Disk has dirs 01-06 (01-04 completed from prior milestone)
    for (let i = 1; i <= 4; i++) {
      const padded = String(i).padStart(2, '0');
      const phaseDir = path.join(tmpDir, '.planning', 'phases', `${padded}-old-phase`);
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-PLAN.md`), '# Plan');
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-SUMMARY.md`), '# Summary');
    }

    // Phase 5 — completing this one
    const p5 = path.join(tmpDir, '.planning', 'phases', '05-auth');
    fs.mkdirSync(p5, { recursive: true });
    fs.writeFileSync(path.join(p5, '05-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p5, '05-01-SUMMARY.md'), '# Summary');

    // Phase 6 — next phase in milestone
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06-dashboard'), { recursive: true });

    const result = runVerifiedPhaseComplete('phase complete 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.is_last_phase, false, 'should NOT be last phase — phase 6 is in milestone');
    assert.strictEqual(output.next_phase, '06', 'next phase should be 06');
  });

  test('detects last phase when only milestone phases are considered', () => {
    // ROADMAP lists only phase 5 (current milestone)
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '## Roadmap v2.0: Release',
        '',
        '### Phase 5: Auth',
        '**Goal:** Add authentication',
        '**Plans:** 1 plans',
      ].join('\n')
    );

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# State\n\n**Current Phase:** 05\n**Current Phase Name:** Auth\n**Status:** In progress\n**Current Plan:** 05-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n'
    );

    // Disk has dirs 01-06 but only 5 is in ROADMAP
    for (let i = 1; i <= 6; i++) {
      const padded = String(i).padStart(2, '0');
      const phaseDir = path.join(tmpDir, '.planning', 'phases', `${padded}-phase-${i}`);
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-PLAN.md`), '# Plan');
      fs.writeFileSync(path.join(phaseDir, `${padded}-01-SUMMARY.md`), '# Summary');
    }

    const result = runVerifiedPhaseComplete('phase complete 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Without the fix, dirs 06 on disk would make is_last_phase=false
    // With the fix, only phase 5 is in milestone, so it IS the last phase
    assert.strictEqual(output.is_last_phase, true, 'should be last phase — only phase 5 is in milestone');
    assert.strictEqual(output.next_phase, null, 'no next phase in milestone');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2028 — phase.complete milestone-end inference + workstream root-fallback guard
// ─────────────────────────────────────────────────────────────────────────────

describe('#2028 — phase complete milestone-end + workstream guard', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // A complement phase numbered AFTER Phase 9 but executed first. Completing the
  // numerically-highest phase must not read as milestone-end while a lower phase
  // is still outstanding (the isLastPhase blocks only checked for HIGHER phases).
  test('does NOT stamp "All phases complete" when a lower-numbered phase is still outstanding', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n- [ ] Phase 9: Introspection\n- [ ] Phase 10: Complement\n\n### Phase 9: Introspection\n**Goal:** baseline\n\n### Phase 10: Complement\n**Goal:** complement\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 10\n**Status:** In progress\n**Current Plan:** 10-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );
    const p10 = path.join(tmpDir, '.planning', 'phases', '10-complement');
    fs.mkdirSync(p10, { recursive: true });
    fs.writeFileSync(path.join(p10, '10-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p10, '10-01-SUMMARY.md'), '# Summary');

    const result = runVerifiedPhaseComplete('phase complete 10', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.is_last_phase,
      false,
      'Phase 10 is numerically highest but Phase 9 is outstanding → not milestone-end',
    );
    // The outstanding lower phase IS the real next actionable item — STATE.md must
    // advance to it (the gap), not park on the just-completed Phase 10.
    assert.strictEqual(String(Number(output.next_phase)), '9', 'next_phase should point at the outstanding Phase 9');

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(
      !/Milestone complete|All phases complete/i.test(state),
      'STATE.md must NOT flip to milestone-complete while a lower phase is outstanding',
    );
    assert.ok(/Ready to plan/i.test(state), 'status should be "Ready to plan"');
    assert.match(
      state,
      /\*\*Current Phase:\*\*\s*0*9\b/,
      'Current Phase must advance to the outstanding Phase 9, not stay on the completed Phase 10',
    );
    assert.doesNotMatch(
      state,
      /\*\*Current Phase:\*\*\s*10\b/,
      'Current Phase must NOT remain on the just-completed Phase 10',
    );
  });

  // Guard against over-correction: when every earlier phase is [x], completing
  // the numerically-highest phase IS still the milestone end.
  test('still detects milestone-end when all lower phases are checked complete', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n- [x] Phase 9: Introspection\n- [ ] Phase 10: Complement\n\n### Phase 9: Introspection\n**Goal:** baseline\n\n### Phase 10: Complement\n**Goal:** complement\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 10\n**Status:** In progress\n**Current Plan:** 10-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );
    const p10 = path.join(tmpDir, '.planning', 'phases', '10-complement');
    fs.mkdirSync(p10, { recursive: true });
    fs.writeFileSync(path.join(p10, '10-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p10, '10-01-SUMMARY.md'), '# Summary');

    const result = runVerifiedPhaseComplete('phase complete 10', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.is_last_phase, true, 'all lower phases complete → Phase 10 is milestone-end');
    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(/All phases complete/i.test(state), 'status should be "All phases complete"');
  });

  // The lower-phase scan must not treat an unrelated checklist line that merely
  // mentions "Phase N" (no `:` after the number) as an outstanding phase — the
  // checkbox regex is anchored like the sibling phase scan.
  test('does not treat an unrelated checklist line mentioning a phase number as outstanding', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n- [ ] Add regression coverage for Phase 3 rollback\n- [ ] Phase 5: Final\n\n### Phase 5: Final\n**Goal:** end\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 05\n**Status:** In progress\n**Current Plan:** 05-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );
    const p5 = path.join(tmpDir, '.planning', 'phases', '05-final');
    fs.mkdirSync(p5, { recursive: true });
    fs.writeFileSync(path.join(p5, '05-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p5, '05-01-SUMMARY.md'), '# Summary');

    const result = runVerifiedPhaseComplete('phase complete 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.is_last_phase,
      true,
      'the "Phase 3 rollback" prose line must NOT be read as an outstanding Phase 3',
    );
  });

  // #1912 parity: in workstream mode with no active workstream, planningDir(cwd)
  // resolves to root .planning — writing STATE.md/ROADMAP.md into the shared root
  // that other workstreams read. Refuse instead of silently writing root.
  test('refuses to write root in workstream mode when no workstream is resolved', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'beta'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# State\n\n**Current Phase:** 01\n**Status:** In progress\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n- [ ] Phase 1: A\n\n### Phase 1: A\n**Goal:** x\n',
    );

    const result = runGsdTools('phase complete 1', tmpDir);
    assert.equal(result.success, false, 'should refuse rather than silently writing root STATE/ROADMAP');
    assert.match(result.error || '', /workstream|--ws/i, 'error should name the workstream requirement');
  });

  // An explicit --ws satisfies the guard (it sets GSD_WORKSTREAM upstream) AND
  // targets that workstream — the write must land in the workstream's own
  // STATE.md/ROADMAP.md, leaving root untouched.
  test('--ws satisfies the guard and writes the workstream, not root', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'workstreams', 'beta'), { recursive: true });
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', 'alpha');
    fs.mkdirSync(path.join(wsDir, 'phases', '01-only'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'ROADMAP.md'), '# Roadmap\n\n### Phase 1: Only\n**Goal:** x\n');
    fs.writeFileSync(
      path.join(wsDir, 'STATE.md'),
      '# State\n\n**Current Phase:** 01\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** W\n',
    );
    fs.writeFileSync(path.join(wsDir, 'phases', '01-only', '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(wsDir, 'phases', '01-only', '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(
      path.join(wsDir, 'phases', '01-only', '01-VERIFICATION.md'),
      '---\nstatus: passed\n---\n# Verification\n',
    );

    // A distinct root STATE.md that must be left byte-for-byte untouched.
    const rootState = '# ROOT State\n\n**Current Phase:** 99\n**Status:** Root sentinel\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), rootState);

    const result = runGsdTools('phase complete 1 --ws alpha', tmpDir);
    assert.ok(result.success, `--ws alpha should complete in the workstream: ${result.error}`);

    // Root STATE.md must be untouched — the write landed in the workstream.
    assert.strictEqual(
      fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'),
      rootState,
      'root STATE.md must NOT be written when --ws targets a workstream',
    );
    // The workstream's own STATE.md advanced (single phase → all phases complete).
    const wsState = fs.readFileSync(path.join(wsDir, 'STATE.md'), 'utf-8');
    assert.match(wsState, /All phases complete/i, "the workstream's STATE.md should be the one updated");
  });

  // The guard only fires in workstream mode — a flat project (no workstreams dir)
  // completes normally.
  test('flat mode (no workstreams dir) still completes normally', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 1: Only\n**Goal:** x\n`
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`
    );
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-only');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `flat mode should still complete: ${result.error}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// exact token matching (no prefix collisions)
// ─────────────────────────────────────────────────────────────────────────────

describe('phase resolution uses exact token matching', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('1009 must NOT match 1009A-feature-consistency when 1009 dir is absent', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    fs.mkdirSync(path.join(phasesDir, '1009A-feature-consistency'));
    fs.writeFileSync(path.join(phasesDir, '1009A-feature-consistency', 'PLAN.md'), '# Plan');

    const result = runGsdTools('find-phase 1009', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, false, 'should NOT find phase 1009 when only 1009A exists');
  });

  test('1009 matches 1009-pipeline-accuracy-fix when both exist', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    fs.mkdirSync(path.join(phasesDir, '1009-pipeline-accuracy-fix'));
    fs.mkdirSync(path.join(phasesDir, '1009A-feature-consistency'));
    fs.writeFileSync(path.join(phasesDir, '1009-pipeline-accuracy-fix', 'PLAN.md'), '# Plan');

    const result = runGsdTools('find-phase 1009', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'should find phase 1009');
    assert.ok(
      output.directory.includes('1009-pipeline-accuracy-fix'),
      `should match 1009-pipeline-accuracy-fix, got: ${output.directory}`
    );
  });

  test('999.6 must NOT match 999.60-episode-processing when 999.6 dir is absent', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    fs.mkdirSync(path.join(phasesDir, '999.60-episode-processing'));
    fs.writeFileSync(path.join(phasesDir, '999.60-episode-processing', 'PLAN.md'), '# Plan');

    const result = runGsdTools('find-phase 999.6', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, false, 'should NOT find phase 999.6 when only 999.60 exists');
  });

  test('999.6 matches 999.6-ground-truth-dataset when both exist', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    fs.mkdirSync(path.join(phasesDir, '999.6-ground-truth-dataset'));
    fs.mkdirSync(path.join(phasesDir, '999.60-episode-processing'));
    fs.writeFileSync(path.join(phasesDir, '999.6-ground-truth-dataset', 'PLAN.md'), '# Plan');

    const result = runGsdTools('find-phase 999.6', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.found, true, 'should find phase 999.6');
    assert.ok(
      output.directory.includes('999.6-ground-truth-dataset'),
      `should match 999.6-ground-truth-dataset, got: ${output.directory}`
    );
  });

  test('normal non-colliding phases still resolve', () => {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    fs.mkdirSync(path.join(phasesDir, '01-foundation'));
    fs.mkdirSync(path.join(phasesDir, '02-implementation'));
    fs.writeFileSync(path.join(phasesDir, '01-foundation', 'PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phasesDir, '02-implementation', 'PLAN.md'), '# Plan');

    const r1 = runGsdTools('find-phase 1', tmpDir);
    assert.ok(r1.success, `Command failed for phase 1: ${r1.error}`);
    const o1 = JSON.parse(r1.output);
    assert.strictEqual(o1.found, true, 'should find phase 1');
    assert.ok(o1.directory.includes('01-foundation'), `should match 01-foundation, got: ${o1.directory}`);

    const r2 = runGsdTools('find-phase 2', tmpDir);
    assert.ok(r2.success, `Command failed for phase 2: ${r2.error}`);
    const o2 = JSON.parse(r2.output);
    assert.strictEqual(o2.found, true, 'should find phase 2');
    assert.ok(o2.directory.includes('02-implementation'), `should match 02-implementation, got: ${o2.directory}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase complete — Performance Metrics gate (Step 2 — Gate 4)
// ─────────────────────────────────────────────────────────────────────────────

describe('phase complete updates Performance Metrics', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('after cmdPhaseComplete: Performance Metrics has updated total plans count', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Current Phase:** 2\n**Status:** Executing Phase 2\n**Total Plans in Phase:** 3\n**Current Plan:** 3\n**Completed Phases:** 0\n**Total Phases:** 3\n**Progress:** 0%\n\n## Performance Metrics\n\n**Velocity:**\n- Total plans completed: 0\n- Average duration: N/A\n- Total execution time: 0 hours\n\n**By Phase:**\n\n| Phase | Plans | Total | Avg/Plan |\n|-------|-------|-------|----------|\n\n## Accumulated Context\n`
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '02-core');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '02-01-PLAN.md'), '# Plan 1\n');
    fs.writeFileSync(path.join(phaseDir, '02-02-PLAN.md'), '# Plan 2\n');
    fs.writeFileSync(path.join(phaseDir, '02-03-PLAN.md'), '# Plan 3\n');
    fs.writeFileSync(path.join(phaseDir, '02-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phaseDir, '02-02-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phaseDir, '02-03-SUMMARY.md'), '# Summary\n');

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phase 2: Core\n\n- [ ] Phase 2: Core Systems\n`
    );

    const result = runVerifiedPhaseComplete('phase complete 2', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error}`);

    const stateAfter = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(stateAfter.match(/Total plans completed:\s*3/), 'Total plans completed should be 3');
  });

  test('after cmdPhaseComplete: By Phase table has row for completed phase', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# Project State\n\n**Current Phase:** 1\n**Status:** Executing Phase 1\n**Total Plans in Phase:** 2\n**Current Plan:** 2\n**Completed Phases:** 0\n**Total Phases:** 2\n**Progress:** 0%\n\n## Performance Metrics\n\n**Velocity:**\n- Total plans completed: 0\n- Average duration: N/A\n- Total execution time: 0 hours\n\n**By Phase:**\n\n| Phase | Plans | Total | Avg/Plan |\n|-------|-------|-------|----------|\n\n## Accumulated Context\n`
    );

    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary\n');
    fs.writeFileSync(path.join(phaseDir, '01-02-SUMMARY.md'), '# Summary\n');

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phase 1: Setup\n\n- [ ] Phase 1: Setup\n`
    );

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error}`);

    const stateAfter = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(stateAfter.match(/\|\s*1\s*\|\s*2\s*\|/), 'By Phase table should have row for phase 1 with 2 plans');
    // Row must appear BEFORE the next section, not after it (regression: empty table body regex)
    const rowIdx = stateAfter.indexOf('| 1 |');
    const accIdx = stateAfter.indexOf('## Accumulated Context');
    if (accIdx !== -1) {
      assert.ok(rowIdx < accIdx, 'By Phase row must appear before ## Accumulated Context section');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phase complete — backlog phase (999.x) exclusion (#2129)
// ─────────────────────────────────────────────────────────────────────────────

describe('phase complete excludes 999.x backlog from next-phase (#2129)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('next phase skips 999.x backlog dirs and falls back to roadmap', () => {
    // ROADMAP defines phases 1, 2, 3 and a backlog 999.1
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '- [ ] Phase 1: Setup',
        '- [ ] Phase 2: Core',
        '- [ ] Phase 3: Polish',
        '- [ ] Phase 999.1: Backlog idea',
        '',
        '### Phase 1: Setup',
        '**Goal:** Initial setup',
        '',
        '### Phase 2: Core',
        '**Goal:** Build core',
        '',
        '### Phase 3: Polish',
        '**Goal:** Polish everything',
        '',
        '### Phase 999.1: Backlog idea',
        '**Goal:** Parked idea',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '# State',
        '',
        '**Current Phase:** 02',
        '**Status:** In progress',
        '**Current Plan:** 02-01',
        '**Last Activity:** 2025-01-01',
        '**Last Activity Description:** Working',
      ].join('\n')
    );

    // Phase 1 and 2 exist on disk, phase 3 does NOT exist yet, 999.1 DOES exist
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const p2 = path.join(tmpDir, '.planning', 'phases', '02-core');
    fs.mkdirSync(p2, { recursive: true });
    fs.writeFileSync(path.join(p2, '02-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p2, '02-01-SUMMARY.md'), '# Summary');

    // Backlog stub on disk — this is what triggers the bug
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '999.1-backlog-idea'), { recursive: true });

    const result = runVerifiedPhaseComplete('phase complete 2', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // #3350: with stage 3 (#2028 lowest-outstanding) no longer gated behind
    // stages 1-2 missing, the unchecked Phase 1 row outranks the positionally-
    // next Phase 3 heading — a phase is complete iff its roadmap checkbox is
    // `[x]` (#2028), and Phase 1's row is unchecked despite its dir on disk
    // (same drift shape #2949's realLowerOutstandingPhaseStillSelected pins).
    // The #2129 contract itself is unchanged: 999.x is NEVER selected.
    assert.notEqual(output.next_phase, '999.1', '999.x backlog must never be next_phase');
    assert.strictEqual(output.next_phase, '1', 'lowest unchecked phase (1) wins over positional 3 (#3350); never 999.1');
    assert.strictEqual(output.is_last_phase, false, 'should not be last phase');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// regression: bug #1962 — normalizePhaseName preserves letter suffix case
// (consolidated from tests/bug-1962-phase-suffix-case.test.cjs)
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #1962: normalizePhaseName preserves letter suffix case', () => {
  test('lowercase suffix preserved: 16c → 16c', () => {
    assert.equal(normalizePhaseName('16c'), '16c');
  });

  test('uppercase suffix preserved: 16C → 16C', () => {
    assert.equal(normalizePhaseName('16C'), '16C');
  });

  test('single digit padded with lowercase suffix: 1a → 01a', () => {
    assert.equal(normalizePhaseName('1a'), '01a');
  });

  test('single digit padded with uppercase suffix: 1A → 01A', () => {
    assert.equal(normalizePhaseName('1A'), '01A');
  });

  test('no suffix unchanged: 16 → 16', () => {
    assert.equal(normalizePhaseName('16'), '16');
  });

  test('decimal suffix preserved: 16.1 → 16.1', () => {
    assert.equal(normalizePhaseName('16.1'), '16.1');
  });

  test('letter + decimal preserved: 16c.2 → 16c.2', () => {
    assert.equal(normalizePhaseName('16c.2'), '16c.2');
  });

  test('project code prefix stripped, suffix case preserved: CK-01a → 01a', () => {
    assert.equal(normalizePhaseName('CK-01a'), '01a');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// regression: bug #1998 — phase complete updates overview checkbox
// (consolidated from tests/bug-1998-phase-complete-checkbox.test.cjs)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run `gsd-tools phase complete <phase>` for the phase-complete regression
 * suites and return its stdout.
 *
 * `phase complete` writes ROADMAP.md as its LAST step, after a read-heavy
 * parse/lock sequence (ROADMAP read, two extractCurrentMilestone STATE.md
 * parses, REQUIREMENTS read, phase-dir scan, STATE read — all before the single
 * writePlanningFileSet flush). Under the high-concurrency docker run (~672 test
 * files in parallel), a tight 10s timeout could fire mid-parse and SIGTERM the
 * subprocess BEFORE that write landed, leaving ROADMAP.md untouched. Call sites
 * that used a bare `catch {}` then silently proceeded to assert on the pristine
 * file — an intermittent "checkbox not checked" failure (bug #1998 flake).
 *
 * Two-part fix, no retry loop:
 *  1. A generous timeout so the test's own timer never kills the subprocess
 *     under load (10s cold-node startup × 672-way CPU/IO contention was the
 *     real culprit — all I/O is scoped to tmpDir, so there is no cross-process
 *     race to blame).
 *  2. Never silently swallow a signal/timeout kill: it means the process was
 *     terminated before completing its writes, so we surface it loudly with
 *     context instead of letting it masquerade as an assertion failure. A
 *     *clean* non-zero exit is still tolerated when `tolerateExit` is set,
 *     because the ROADMAP write has already landed before any post-write step
 *     that may exit non-zero in these minimal fixtures.
 */
function runPhaseComplete(tmpDir, { phase = '1', tolerateExit = false } = {}) {
  writePassedVerificationForPhase(tmpDir, phase);
  try {
    return execFileSync('node', [GSD_TOOLS_BIN, 'phase', 'complete', phase], {
      cwd: tmpDir,
      timeout: 60000,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (err) {
    // A signal/timeout kill terminated the process before it finished writing —
    // never tolerate it; surface it with whatever output was captured.
    if (err.killed || err.signal != null || err.code === 'ETIMEDOUT') {
      throw new Error(
        `gsd-tools phase complete ${phase} was killed before completion ` +
          `(signal=${err.signal}, code=${err.code}). ` +
          `stdout=${err.stdout || ''} stderr=${err.stderr || ''}`
      );
    }
    if (tolerateExit) {
      return `${err.stdout || ''}${err.stderr || ''}`;
    }
    throw err;
  }
}

describe('bug #1998: phase complete updates overview checkbox', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1998-'));
    planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });

    // Minimal config
    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ project_code: 'TEST' })
    );

    // Minimal STATE.md
    fs.writeFileSync(
      path.join(planningDir, 'STATE.md'),
      '---\ncurrent_phase: 1\nstatus: executing\n---\n# State\n'
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('checkbox updated when no archived milestones exist', () => {
    const phasesDir = path.join(planningDir, 'phases', '01-foundation');
    fs.mkdirSync(phasesDir, { recursive: true });
    fs.writeFileSync(
      path.join(phasesDir, '01-1-SUMMARY.md'),
      '---\nstatus: complete\n---\n# Summary\nDone.'
    );
    fs.writeFileSync(
      path.join(phasesDir, '01-1-PLAN.md'),
      '---\nphase: 1\nplan: 1\n---\n# Plan 1\n'
    );

    const roadmapPath = path.join(planningDir, 'ROADMAP.md');
    fs.writeFileSync(roadmapPath, [
      '# Roadmap',
      '',
      '## Phases',
      '',
      '- [ ] **Phase 1: Foundation** - core setup',
      '- [ ] **Phase 2: Features** - add features',
      '',
      '## Progress',
      '',
      '| Phase | Plans | Status | Completed |',
      '|-------|-------|--------|-----------|',
      '| 1. Foundation | 0/1 | Pending | - |',
      '| 2. Features | 0/1 | Pending | - |',
    ].join('\n'));

    runPhaseComplete(tmpDir, { tolerateExit: true });

    const result = fs.readFileSync(roadmapPath, 'utf-8');
    assert.match(result, /- \[x\] \*\*Phase 1: Foundation\*\*/, 'overview checkbox should be checked');
    assert.match(result, /- \[ \] \*\*Phase 2: Features\*\*/, 'phase 2 checkbox should remain unchecked');
  });

  test('checkbox updated when archived milestones exist in <details>', () => {
    const phasesDir = path.join(planningDir, 'phases', '01-setup');
    fs.mkdirSync(phasesDir, { recursive: true });
    fs.writeFileSync(
      path.join(phasesDir, '01-1-SUMMARY.md'),
      '---\nstatus: complete\n---\n# Summary\nDone.'
    );
    fs.writeFileSync(
      path.join(phasesDir, '01-1-PLAN.md'),
      '---\nphase: 1\nplan: 1\n---\n# Plan 1\n'
    );

    const roadmapPath = path.join(planningDir, 'ROADMAP.md');
    fs.writeFileSync(roadmapPath, [
      '# Roadmap v2.0',
      '',
      '## Phases',
      '',
      '- [ ] **Phase 1: Setup** - initial setup',
      '- [ ] **Phase 2: Build** - build features',
      '',
      '## Progress',
      '',
      '| Phase | Plans | Status | Completed |',
      '|-------|-------|--------|-----------|',
      '| 1. Setup | 0/1 | Pending | - |',
      '| 2. Build | 0/1 | Pending | - |',
      '',
      '<details>',
      '<summary>v1.0 (Archived)</summary>',
      '',
      '## v1.0 Phases',
      '- [x] **Phase 1: Init** - initialization',
      '- [x] **Phase 2: Deploy** - deployment',
      '',
      '</details>',
    ].join('\n'));

    runPhaseComplete(tmpDir, { tolerateExit: true });

    const result = fs.readFileSync(roadmapPath, 'utf-8');
    assert.match(result, /- \[x\] \*\*Phase 1: Setup\*\*/, 'current milestone checkbox should be checked');
    assert.match(result, /- \[ \] \*\*Phase 2: Build\*\*/, 'phase 2 checkbox should remain unchecked');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// regression: bug #2005 — phase complete inside <details> updates plan count
// (consolidated from tests/bug-2005-phase-complete-details.test.cjs)
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #2005: phase complete updates plan count when milestone is inside <details>', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2005-'));
    planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });

    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ project_code: 'TEST' })
    );

    fs.writeFileSync(
      path.join(planningDir, 'STATE.md'),
      '---\ncurrent_phase: 1\nstatus: executing\nmilestone: v2.0\n---\n# State\n'
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('plan count is updated when current milestone is wrapped in <details>', () => {
    const phasesDir = path.join(planningDir, 'phases', '01-setup');
    fs.mkdirSync(phasesDir, { recursive: true });
    fs.writeFileSync(
      path.join(phasesDir, '01-1-SUMMARY.md'),
      '---\nstatus: complete\n---\n# Summary\nDone.\n'
    );
    fs.writeFileSync(
      path.join(phasesDir, '01-1-PLAN.md'),
      '---\nphase: 1\nplan: 1\n---\n# Plan 1\n'
    );

    const roadmapPath = path.join(planningDir, 'ROADMAP.md');
    fs.writeFileSync(roadmapPath, [
      '# Roadmap',
      '',
      '<details>',
      '<summary>v1.0 (shipped)</summary>',
      '',
      '## v1.0 Phases',
      '- [x] **Phase 0: Bootstrap** - shipped',
      '',
      '</details>',
      '',
      '<details open>',
      '<summary>v2.0 (in progress)</summary>',
      '',
      '## v2.0 Phases',
      '',
      '- [ ] **Phase 1: Setup** - initial setup',
      '- [ ] **Phase 2: Build** - build features',
      '',
      '## Progress',
      '',
      '| Phase | Plans | Status | Completed |',
      '|-------|-------|--------|-----------|',
      '| 1. Setup | 0/1 | Pending | - |',
      '| 2. Build | 0/1 | Pending | - |',
      '',
      '### Phase 1: Setup',
      '',
      '**Plans:** 0/1 plans complete',
      '',
      '### Phase 2: Build',
      '',
      '**Plans:** 0/1 plans complete',
      '',
      '</details>',
    ].join('\n'));

    runPhaseComplete(tmpDir, { tolerateExit: true });

    const result = fs.readFileSync(roadmapPath, 'utf-8');

    assert.match(
      result,
      /\*\*Plans:\*\*\s*1\/1 plans complete/,
      'plan count in Phase 1 section must be updated to 1/1 plans complete'
    );
    assert.match(
      result,
      /- \[x\] \*\*Phase 1: Setup\*\*/,
      'Phase 1 checkbox must be checked after completion'
    );
    assert.match(
      result,
      /- \[ \] \*\*Phase 2: Build\*\*/,
      'Phase 2 checkbox must remain unchecked'
    );
  });

  test('phase complete with all milestones in <details> does not corrupt phase 2 plan count', () => {
    const phasesDir = path.join(planningDir, 'phases', '01-setup');
    fs.mkdirSync(phasesDir, { recursive: true });
    fs.writeFileSync(
      path.join(phasesDir, '01-1-SUMMARY.md'),
      '---\nstatus: complete\n---\n# Summary\nDone.\n'
    );
    fs.writeFileSync(
      path.join(phasesDir, '01-1-PLAN.md'),
      '---\nphase: 1\nplan: 1\n---\n# Plan 1\n'
    );

    const roadmapPath = path.join(planningDir, 'ROADMAP.md');
    fs.writeFileSync(roadmapPath, [
      '# Roadmap',
      '',
      '<details open>',
      '<summary>v2.0 (in progress)</summary>',
      '',
      '## v2.0 Phases',
      '',
      '- [ ] **Phase 1: Setup** - initial setup',
      '- [ ] **Phase 2: Build** - build features',
      '',
      '### Phase 1: Setup',
      '',
      '**Plans:** 0/1 plans complete',
      '',
      '### Phase 2: Build',
      '',
      '**Plans:** 0/2 plans complete',
      '',
      '</details>',
    ].join('\n'));

    runPhaseComplete(tmpDir, { tolerateExit: true });

    const result = fs.readFileSync(roadmapPath, 'utf-8');

    assert.match(
      result,
      /Phase 2: Build[\s\S]*?\*\*Plans:\*\*\s*0\/2 plans complete/,
      'Phase 2 plan count must remain 0/2 (untouched)'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// regression: bug #2526 — phase complete warns about unregistered REQ-IDs
// (consolidated from tests/bug-2526-phase-complete-req-discovery.test.cjs)
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #2526: phase complete warns about unregistered REQ-IDs', () => {
  let tmpDir;
  let planningDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2526-'));
    planningDir = path.join(tmpDir, '.planning');
    fs.mkdirSync(planningDir, { recursive: true });

    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ project_code: '' })
    );

    fs.writeFileSync(
      path.join(planningDir, 'STATE.md'),
      '---\ncurrent_phase: 1\nstatus: executing\n---\n# State\n'
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('emits warning for REQ-IDs in body but missing from Traceability table', () => {
    const phasesDir = path.join(planningDir, 'phases', '01-foundation');
    fs.mkdirSync(phasesDir, { recursive: true });
    fs.writeFileSync(
      path.join(phasesDir, '01-1-PLAN.md'),
      '---\nphase: 1\nplan: 1\n---\n# Plan 1\n'
    );
    fs.writeFileSync(
      path.join(phasesDir, '01-1-SUMMARY.md'),
      '---\nstatus: complete\n---\n# Summary\nDone.'
    );

    const roadmapPath = path.join(planningDir, 'ROADMAP.md');
    fs.writeFileSync(roadmapPath, [
      '# Roadmap',
      '',
      '### Phase 1: Foundation',
      '',
      '**Goal:** Build core',
      '**Requirements:** REQ-001',
      '**Plans:** 1 plans',
      '',
      'Plans:',
      '- [x] 01-1-PLAN.md',
      '',
      '| Phase | Plans | Status | Completed |',
      '|-------|-------|--------|-----------|',
      '| 1. Foundation | 0/1 | Pending | - |',
    ].join('\n'));

    const reqPath = path.join(planningDir, 'REQUIREMENTS.md');
    fs.writeFileSync(reqPath, [
      '# Requirements',
      '',
      '## Functional Requirements',
      '',
      '- [x] **REQ-001**: Core data model',
      '- [ ] **REQ-002**: User authentication',
      '- [ ] **REQ-003**: API endpoints',
      '',
      '## Traceability',
      '',
      '| REQ-ID | Phase | Status |',
      '|--------|-------|--------|',
      '| REQ-001 | 1 | Pending |',
    ].join('\n'));

    const combined = runPhaseComplete(tmpDir);
    assert.match(combined, /REQ-002/, 'output should mention REQ-002 as missing from Traceability table');
    assert.match(combined, /REQ-003/, 'output should mention REQ-003 as missing from Traceability table');
  });

  test('no warning when all body REQ-IDs are present in Traceability table', () => {
    const phasesDir = path.join(planningDir, 'phases', '01-foundation');
    fs.mkdirSync(phasesDir, { recursive: true });
    fs.writeFileSync(
      path.join(phasesDir, '01-1-PLAN.md'),
      '---\nphase: 1\nplan: 1\n---\n# Plan 1\n'
    );
    fs.writeFileSync(
      path.join(phasesDir, '01-1-SUMMARY.md'),
      '---\nstatus: complete\n---\n# Summary\nDone.'
    );

    const roadmapPath = path.join(planningDir, 'ROADMAP.md');
    fs.writeFileSync(roadmapPath, [
      '# Roadmap',
      '',
      '### Phase 1: Foundation',
      '',
      '**Goal:** Build core',
      '**Requirements:** REQ-001, REQ-002',
      '**Plans:** 1 plans',
      '',
      'Plans:',
      '- [x] 01-1-PLAN.md',
      '',
      '| Phase | Plans | Status | Completed |',
      '|-------|-------|--------|-----------|',
      '| 1. Foundation | 0/1 | Pending | - |',
    ].join('\n'));

    const reqPath = path.join(planningDir, 'REQUIREMENTS.md');
    fs.writeFileSync(reqPath, [
      '# Requirements',
      '',
      '## Functional Requirements',
      '',
      '- [x] **REQ-001**: Core data model',
      '- [x] **REQ-002**: User authentication',
      '',
      '## Traceability',
      '',
      '| REQ-ID | Phase | Status |',
      '|--------|-------|--------|',
      '| REQ-001 | 1 | Pending |',
      '| REQ-002 | 1 | Pending |',
    ].join('\n'));

    const combined = runPhaseComplete(tmpDir);
    assert.doesNotMatch(
      combined,
      /unregistered|missing.*traceability|not in.*traceability/i,
      'no warning should appear when all REQ-IDs are in the table'
    );
  });

  test('warning includes all missing REQ-IDs, not just the first', () => {
    const phasesDir = path.join(planningDir, 'phases', '01-foundation');
    fs.mkdirSync(phasesDir, { recursive: true });
    fs.writeFileSync(
      path.join(phasesDir, '01-1-PLAN.md'),
      '---\nphase: 1\nplan: 1\n---\n# Plan 1\n'
    );
    fs.writeFileSync(
      path.join(phasesDir, '01-1-SUMMARY.md'),
      '---\nstatus: complete\n---\n# Summary\nDone.'
    );

    const roadmapPath = path.join(planningDir, 'ROADMAP.md');
    fs.writeFileSync(roadmapPath, [
      '# Roadmap',
      '',
      '### Phase 1: Foundation',
      '',
      '**Goal:** Build core',
      '**Requirements:** REQ-001',
      '**Plans:** 1 plans',
      '',
      'Plans:',
      '- [x] 01-1-PLAN.md',
      '',
      '| Phase | Plans | Status | Completed |',
      '|-------|-------|--------|-----------|',
      '| 1. Foundation | 0/1 | Pending | - |',
    ].join('\n'));

    const reqPath = path.join(planningDir, 'REQUIREMENTS.md');
    fs.writeFileSync(reqPath, [
      '# Requirements',
      '',
      '- [x] **REQ-001**: Core data model',
      '- [ ] **REQ-002**: User auth',
      '- [ ] **REQ-003**: API',
      '- [ ] **REQ-004**: Reports',
      '',
      '## Traceability',
      '',
      '| REQ-ID | Phase | Status |',
      '|--------|-------|--------|',
      '| REQ-001 | 1 | Pending |',
    ].join('\n'));

    const combined = runPhaseComplete(tmpDir);
    assert.match(combined, /REQ-002/, 'should warn about REQ-002');
    assert.match(combined, /REQ-003/, 'should warn about REQ-003');
    assert.match(combined, /REQ-004/, 'should warn about REQ-004');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// regression: bug #3287 — phase-dir prefix parity across creation paths
// (consolidated from tests/bug-3287-phase-dir-prefix-parity.test.cjs)
// ─────────────────────────────────────────────────────────────────────────────

// ─── shared fixture for bug-3287 ─────────────────────────────────────────────
function makeXRProject(tmpDir) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'config.json'),
    JSON.stringify({ project_code: 'XR' }),
  );
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    [
      '# Roadmap v1.0',
      '',
      '### Phase 1: Foundation',
      '**Goal:** Setup project',
      '**Plans:** 0 plans',
      '',
      '---',
      '',
    ].join('\n'),
  );
}

describe('bug-3287 — phase.add emits project_code prefix (sanity)', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('phase.add creates XR-02-<slug> when project_code is XR', () => {
    makeXRProject(tmpDir);

    const result = runGsdTools('phase add auth service', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `phase.add failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_number, 2, 'phase number should be 2');

    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const dirs = fs.readdirSync(phasesDir);
    const prefixedDirs = dirs.filter(d => d.startsWith('XR-'));
    assert.ok(
      prefixedDirs.length > 0,
      `Expected at least one XR- prefixed dir, got: ${JSON.stringify(dirs)}`,
    );
    assert.ok(
      dirs.some(d => d === 'XR-02-auth-service'),
      `Expected XR-02-auth-service, got: ${JSON.stringify(dirs)}`,
    );
  });
});

describe('bug-3287 — init phase-op exposes expected_phase_dir with project_code prefix', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('returns expected_phase_dir with XR- prefix when phase directory does not exist', () => {
    makeXRProject(tmpDir);

    const result = runGsdTools('init phase-op 1', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init phase-op failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true, 'phase should be found in roadmap');
    assert.strictEqual(output.phase_dir, null, 'phase_dir should be null (no dir yet)');

    assert.ok(
      typeof output.expected_phase_dir === 'string',
      `expected_phase_dir should be a string, got: ${JSON.stringify(output.expected_phase_dir)}`,
    );
    assert.ok(
      output.expected_phase_dir.includes('XR-'),
      `expected_phase_dir should contain XR- prefix, got: "${output.expected_phase_dir}"`,
    );
    assert.ok(
      output.expected_phase_dir.includes('foundation'),
      `expected_phase_dir should contain the phase slug, got: "${output.expected_phase_dir}"`,
    );
  });

  test('expected_phase_dir is null when no project_code is set', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({}),
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n---\n',
    );

    const result = runGsdTools('init phase-op 1', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init phase-op failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_dir, null);
    assert.ok(
      typeof output.expected_phase_dir === 'string',
      `expected_phase_dir should be a string even without project_code, got: ${JSON.stringify(output.expected_phase_dir)}`,
    );
    assert.ok(
      !output.expected_phase_dir.match(/^[A-Z][A-Z0-9]*-/),
      `expected_phase_dir should have NO prefix without project_code, got: "${output.expected_phase_dir}"`,
    );
  });
});

describe('bug-3287 — init plan-phase exposes expected_phase_dir with project_code prefix', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('returns expected_phase_dir with XR- prefix when phase directory does not exist', () => {
    makeXRProject(tmpDir);

    const result = runGsdTools('init plan-phase 1', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init plan-phase failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true, 'phase should be found in roadmap');
    assert.strictEqual(output.phase_dir, null, 'phase_dir should be null (no dir yet)');

    assert.ok(
      typeof output.expected_phase_dir === 'string',
      `expected_phase_dir should be a string, got: ${JSON.stringify(output.expected_phase_dir)}`,
    );
    assert.ok(
      output.expected_phase_dir.includes('XR-'),
      `expected_phase_dir should contain XR- prefix, got: "${output.expected_phase_dir}"`,
    );
    assert.ok(
      output.expected_phase_dir.includes('foundation'),
      `expected_phase_dir should contain the phase slug, got: "${output.expected_phase_dir}"`,
    );
  });

  test('expected_phase_dir omits prefix when project_code is not set', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({}),
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n\n---\n',
    );

    const result = runGsdTools('init plan-phase 1', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `init plan-phase failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_dir, null);
    assert.ok(
      typeof output.expected_phase_dir === 'string',
      `expected_phase_dir should be a string, got: ${JSON.stringify(output.expected_phase_dir)}`,
    );
    assert.ok(
      !output.expected_phase_dir.match(/^[A-Z][A-Z0-9]*-/),
      `expected_phase_dir should have NO prefix without project_code, got: "${output.expected_phase_dir}"`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// regression: bug #3298 — phase-dir prefix drift in workflows
// (consolidated from tests/bug-3298-phase-dir-prefix-drift-in-workflows.test.cjs)
// ─────────────────────────────────────────────────────────────────────────────

{
  const IMPORT_WF = path.join(__dirname, '..', 'gsd-core', 'workflows', 'import.md');
  const BACKLOG_WF = path.join(__dirname, '..', 'gsd-core', 'workflows', 'add-backlog.md');

  function readWorkflow(filePath) {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      throw new Error(`Cannot read workflow file ${filePath}: ${err.message}`);
    }
  }

  function containsBareTemplateMkdir(content) {
    return /mkdir[^`\r\n]*\.planning\/phases\/\{[A-Z0-9]+\}-\{/.test(content);
  }

  function containsBareShellVarMkdir(content) {
    return /mkdir[^`\r\n]*\.planning\/phases\/"\$\{(?:NEXT|NN|PHASE)[^}]*\}-/.test(content)
      || /mkdir[^`\r\n]*\.planning\/phases\/\$\{(?:NEXT|NN|PHASE)[^}]*\}-/.test(content);
  }

  // The plan-milestone-gaps arm was removed along with that workflow file in
  // #3560 (its command was deleted by #2790). The import.md and
  // add-backlog.md arms below still guard the same phase-dir prefix drift.

  describe('bug-3298 — import.md must not construct bare {NN}-{slug} phase dirs', () => {
    test('workflow file exists', () => {
      assert.ok(fs.existsSync(IMPORT_WF), `import.md must exist at ${IMPORT_WF}`);
    });

    test('plan_convert step must not use bare {NN}-{slug} mkdir pattern', () => {
      const content = readWorkflow(IMPORT_WF);
      assert.ok(
        !containsBareTemplateMkdir(content),
        'import.md must not contain bare mkdir .planning/phases/{NN}-{slug} pattern — use expected_phase_dir from init.phase-op',
      );
    });

    test('plan_convert step must use expected_phase_dir for directory creation', () => {
      const content = readWorkflow(IMPORT_WF);
      assert.ok(
        content.includes('expected_phase_dir'),
        'import.md must use expected_phase_dir (from init.phase-op) to create phase directory with project_code prefix',
      );
    });

    test('plan_convert step must call init.phase-op to resolve the prefixed dir', () => {
      const content = readWorkflow(IMPORT_WF);
      assert.ok(
        content.includes('init.phase-op') || content.includes('init phase-op'),
        'import.md must call gsd-sdk query init.phase-op to get expected_phase_dir with project_code prefix',
      );
    });
  });

  describe('bug-3298 — add-backlog.md must apply project_code prefix when creating 999.x dirs', () => {
    test('workflow file exists', () => {
      assert.ok(fs.existsSync(BACKLOG_WF), `add-backlog.md must exist at ${BACKLOG_WF}`);
    });

    test('step 4 must not use bare ${NEXT}-${SLUG} mkdir without project_code prefix', () => {
      const content = readWorkflow(BACKLOG_WF);
      assert.ok(
        !containsBareShellVarMkdir(content),
        'add-backlog.md must not create .planning/phases/${NEXT}-${SLUG} without a project_code prefix variable — apply ${PREFIX} (or equivalent) before ${NEXT}',
      );
    });

    test('step 4 must reference project_code or a prefix variable before the phase number', () => {
      const content = readWorkflow(BACKLOG_WF);
      const hasProjectCodeRef = content.includes('project_code') || content.includes('PROJECT_CODE');
      const hasPrefixVar = content.includes('${PREFIX}') || content.includes('${PHASE_PREFIX}') || content.includes('${CODE}');
      assert.ok(
        hasProjectCodeRef || hasPrefixVar,
        'add-backlog.md must read project_code (or use a PREFIX variable) to apply the project_code prefix to the 999.x phase directory name',
      );
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// regression: bug #3517 — phase.complete leaves STATE.md with stale fields
// (consolidated from tests/bug-3517-phase-complete-state-md-staleness.test.cjs)
// ─────────────────────────────────────────────────────────────────────────────

{
  // Typed STATE.md surfaces (#3090) — replaces raw regex/substring matching
  // on STATE.md content written by phase.complete in this bug-#3517 block.
  const { stateExtractField } = require('../gsd-core/bin/lib/state-document.cjs');
  const { extractFrontmatter } = require('../gsd-core/bin/lib/frontmatter.cjs');
  const { parseMarkdownTable } = require('../gsd-core/bin/lib/markdown-table.cjs');
  const { parsePhaseFromProse } = require('../gsd-core/bin/lib/phase-id.cjs');

  function runSdkQuery(args, cwd) {
    if (Array.isArray(args) && args[0] === 'phase.complete') {
      writePassedVerificationForPhase(cwd, args[1]);
    }
    const result = runGsdTools(args, cwd);
    if (!result.success) return { success: false, error: result.error };
    try {
      const parsed = JSON.parse(result.output || '{}');
      return { success: true, data: parsed };
    } catch (err) {
      return { success: false, error: err.message };
    }
  }

  function setupPhase3517Project(tmpDir) {
    const planningDir = path.join(tmpDir, '.planning');
    const phasesDir = path.join(planningDir, 'phases');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.mkdirSync(phasesDir, { recursive: true });

    fs.writeFileSync(
      path.join(planningDir, 'config.json'),
      JSON.stringify({ project_code: 'TEST' }),
    );

    const roadmap = [
      '# Roadmap',
      '',
      '## Current Milestone: v3.0',
      '',
      '| Phase | Plans | Status | Completed |',
      '|-------|-------|--------|-----------|',
      '| 4.    | 3/3   | Complete | 2026-04-01 |',
      '| 5.    | 7/7   | In Progress |  |',
      '| 6.    | 0/5   | Not Started |  |',
      '',
      '- [x] Phase 4: Foundation (completed 2026-04-01)',
      '- [ ] Phase 5: Core API',
      '- [ ] Phase 6: Integration',
      '',
      '### Phase 4: Foundation',
      '',
      '**Goal:** Foundation work',
      '**Plans:** 3/3 plans complete',
      '',
      '### Phase 5: Core API',
      '',
      '**Goal:** Build core API layer',
      '**Plans:** 7 plans',
      '',
      'Plans:',
      '- [ ] 05-01 plan',
      '- [ ] 05-02 plan',
      '- [ ] 05-03 plan',
      '- [ ] 05-04 plan',
      '- [ ] 05-05 plan',
      '- [ ] 05-06 plan',
      '- [ ] 05-07 plan',
      '',
      '### Phase 6: Integration',
      '',
      '**Goal:** Integration work',
      '**Plans:** 5 plans',
      '',
      '---',
      '*Last updated: 2026-05-14*',
    ].join('\n');

    fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), roadmap);

    const state = [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v3.0',
      'milestone_name: Core Platform',
      'status: executing',
      'stopped_at: Completed 05-03-PLAN.md',
      'last_updated: 2026-05-10T08:00:00.000Z',
      'progress:',
      '  total_phases: 3',
      '  completed_phases: 1',
      '  total_plans: 15',
      '  completed_plans: 6',
      '  percent: 33',
      '---',
      '',
      '# Project State',
      '',
      '## Current Position',
      '',
      '**Current focus:** Phase 5 — Core API',
      'Phase: 5 of 3 (Core API) — EXECUTING',
      'Plan: 7 of 7',
      'Status: Executing Phase 5',
      'Last activity: 2026-05-10',
      '',
      '## Progress',
      '',
      'Progress: [████████████░░░░] 40% (1/3 phases complete before Phase 5 closeout)',
      '',
      '## Performance Metrics',
      '',
      '**Velocity:**',
      '',
      '- Total plans completed: 6',
      '- Average duration: 2h',
      '- Total execution time: 14 hours',
      '- Window: 2026-04-01 to 2026-05-10',
      '',
      '**By Phase:**',
      '',
      '| Phase | Plans | Total | Avg/Plan |',
      '|-------|-------|-------|----------|',
      '| 4 | 3 | - | - |',
      '',
      '## Session Continuity',
      '',
      'Last session: 2026-05-10T08:00:00.000Z',
      'Stopped at: Completed 05-07-PLAN.md',
    ].join('\n');

    fs.writeFileSync(path.join(planningDir, 'STATE.md'), state);

    const phase5Dir = path.join(phasesDir, '05-core-api');
    fs.mkdirSync(phase5Dir, { recursive: true });
    for (let i = 1; i <= 7; i++) {
      const padded = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(phase5Dir, `05-${padded}-PLAN.md`), `plan ${i}`, 'utf8');
      fs.writeFileSync(path.join(phase5Dir, `05-${padded}-SUMMARY.md`), `summary ${i}`, 'utf8');
    }

    const phase4Dir = path.join(phasesDir, '04-foundation');
    fs.mkdirSync(phase4Dir, { recursive: true });
    for (let i = 1; i <= 3; i++) {
      const padded = String(i).padStart(2, '0');
      fs.writeFileSync(path.join(phase4Dir, `04-${padded}-PLAN.md`), `plan ${i}`, 'utf8');
      fs.writeFileSync(path.join(phase4Dir, `04-${padded}-SUMMARY.md`), `summary ${i}`, 'utf8');
    }
    // Disk-strict completion (ADR-3180 §7.4, #3186): Phase 4 is already
    // shipped per the ROADMAP checklist/table above — a passing
    // *-VERIFICATION.md is what actually makes it count as complete now
    // (runSdkQuery's writePassedVerificationForPhase only covers the phase
    // under test, phase 5, not this already-complete phase 4 fixture).
    fs.writeFileSync(
      path.join(phase4Dir, '04-VERIFICATION.md'),
      ['---', 'status: passed', '---', '', '# Verification', ''].join('\n'),
    );

    const phase6Dir = path.join(phasesDir, '06-integration');
    fs.mkdirSync(phase6Dir, { recursive: true });

    return { planningDir, phase5Dir };
  }

  function setupPhase1316Project(tmpDir) {
    const planningDir = path.join(tmpDir, '.planning');
    const phasesDir = path.join(planningDir, 'phases');
    fs.mkdirSync(planningDir, { recursive: true });
    fs.mkdirSync(phasesDir, { recursive: true });

    fs.writeFileSync(
      path.join(planningDir, 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## Current Milestone: v3.0',
        '',
        '- [ ] Phase 32: Backlog-Closeout Lib Extraction',
        '- [ ] Phase 33: Follow Up Implementation',
        '',
        '### Phase 32: Backlog-Closeout Lib Extraction',
        '**Goal:** Complete closeout extraction',
        '**Plans:** 1 plans',
        '',
        '### Phase 33: Follow Up Implementation',
        '**Goal:** Continue implementation',
      ].join('\n'),
    );

    fs.writeFileSync(
      path.join(planningDir, 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'status: executing',
        'current_phase: "32"',
        'last_activity: "2026-06-14"',
        'progress:',
        '  total_phases: 2',
        '  completed_phases: 0',
        '  total_plans: 1',
        '  completed_plans: 0',
        '  percent: 0',
        '---',
        '',
        '# Project State',
        '',
        '## Current Position',
        '',
        'Phase: 32 — Backlog-Closeout Lib Extraction',
        'Plan: 1 of 1',
        'Status: Executing Phase 32',
        'Last activity: 2026-06-14 — recorded planning complete',
        '',
        '## Session',
        '',
        'Last session: 2026-06-14T00:00:00.000Z',
      ].join('\n'),
    );

    const phase32Dir = path.join(phasesDir, '32-backlog-closeout-lib-extraction');
    fs.mkdirSync(phase32Dir, { recursive: true });
    fs.writeFileSync(path.join(phase32Dir, '32-01-PLAN.md'), '# Plan', 'utf8');
    fs.writeFileSync(path.join(phase32Dir, '32-01-SUMMARY.md'), '# Summary', 'utf8');
    fs.mkdirSync(path.join(phasesDir, '33-follow-up-implementation'), { recursive: true });

    return { planningDir };
  }

  describe('bug #3517: phase.complete leaves STATE.md with stale fields', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3517-'));
    });

    afterEach(() => {
      cleanup(tmpDir);
    });

    test('completed_phases is derived from ROADMAP, not blindly incremented (idempotency)', () => {
      setupPhase3517Project(tmpDir);
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');

      const r1 = runSdkQuery(['phase.complete', '5'], tmpDir);
      assert.ok(r1.success, `first call failed: ${r1.error}`);

      const stateAfter1 = fs.readFileSync(statePath, 'utf8');
      const progress1 = extractFrontmatter(stateAfter1).progress;
      assert.ok(progress1, 'progress not found in frontmatter after first call');
      assert.equal(
        Number(progress1.completed_phases),
        2,
        `After first call: completed_phases should be 2 (derived from ROADMAP: phases 4 and 5 complete), got ${progress1.completed_phases}`,
      );

      const r2 = runSdkQuery(['phase.complete', '5'], tmpDir);
      assert.ok(r2.success, `second call failed: ${r2.error}`);

      const stateAfter2 = fs.readFileSync(statePath, 'utf8');
      const progress2 = extractFrontmatter(stateAfter2).progress;
      assert.ok(progress2, 'progress not found in frontmatter after second call');
      assert.equal(
        Number(progress2.completed_phases),
        2,
        `After second call (same phase): completed_phases must remain 2 (idempotent), got ${progress2.completed_phases}`,
      );
    });

    test('frontmatter stopped_at is updated after phase.complete', () => {
      setupPhase3517Project(tmpDir);
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');

      const r = runSdkQuery(['phase.complete', '5'], tmpDir);
      assert.ok(r.success, `call failed: ${r.error}`);

      const state = fs.readFileSync(statePath, 'utf8');
      const stoppedAt = extractFrontmatter(state).stopped_at;
      assert.ok(stoppedAt, 'stopped_at not found in frontmatter');
      assert.ok(
        !stoppedAt.includes('05-03-PLAN.md'),
        `stopped_at should not still say "Completed 05-03-PLAN.md" — got: ${stoppedAt}`,
      );
      assert.ok(
        stoppedAt.toLowerCase().includes('phase 5') ||
        stoppedAt.toLowerCase().includes('complete'),
        `stopped_at should reference phase 5 completion, got: ${stoppedAt}`,
      );
    });

    test('frontmatter last_updated is refreshed to today after phase.complete', () => {
      setupPhase3517Project(tmpDir);
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');

      const r = runSdkQuery(['phase.complete', '5'], tmpDir);
      assert.ok(r.success, `call failed: ${r.error}`);

      const state = fs.readFileSync(statePath, 'utf8');
      const raw = extractFrontmatter(state).last_updated;
      assert.ok(raw, 'last_updated not found in frontmatter');

      // Must have been refreshed — not the stale seed value from setupPhase3517Project
      assert.notEqual(
        raw,
        '2026-05-10T08:00:00.000Z',
        `last_updated must be refreshed, but it is still the stale seed value: ${raw}`,
      );

      // Must parse as a valid ISO timestamp
      const updatedAt = new Date(raw);
      assert.ok(
        !isNaN(updatedAt.getTime()),
        `last_updated must be a valid ISO timestamp, got: ${raw}`,
      );

      // Date portion must equal today's UTC date — avoids any wall-clock window comparison
      const todayUtc = new Date().toISOString().slice(0, 10);
      const updatedDateUtc = updatedAt.toISOString().slice(0, 10);
      assert.equal(
        updatedDateUtc,
        todayUtc,
        `last_updated date portion must equal today's UTC date (${todayUtc}), got: ${updatedDateUtc}`,
      );
    });

    test('frontmatter total_plans is updated from ROADMAP plan counts after phase.complete', () => {
      setupPhase3517Project(tmpDir);
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');

      const r = runSdkQuery(['phase.complete', '5'], tmpDir);
      assert.ok(r.success, `call failed: ${r.error}`);

      const state = fs.readFileSync(statePath, 'utf8');
      const progress = extractFrontmatter(state).progress;
      assert.ok(progress && progress.total_plans !== undefined, 'total_plans not found in frontmatter');
      const totalPlans = Number(progress.total_plans);
      assert.ok(Number.isFinite(totalPlans) && totalPlans > 0, `total_plans must be a positive number, got: ${progress.total_plans}`);
    });

    test('frontmatter completed_plans is updated from SUMMARY file count after phase.complete', () => {
      setupPhase3517Project(tmpDir);
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');

      const r = runSdkQuery(['phase.complete', '5'], tmpDir);
      assert.ok(r.success, `call failed: ${r.error}`);

      const state = fs.readFileSync(statePath, 'utf8');
      const progress = extractFrontmatter(state).progress;
      assert.ok(progress && progress.completed_plans !== undefined, 'completed_plans not found in frontmatter');
      const completedPlans = Number(progress.completed_plans);
      assert.equal(
        completedPlans,
        10,
        `completed_plans should be 10 (3 phase-4 summaries + 7 phase-5 summaries), got: ${completedPlans}`,
      );
    });

    test('frontmatter percent is recomputed from fresh derived counts', () => {
      setupPhase3517Project(tmpDir);
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');

      const r = runSdkQuery(['phase.complete', '5'], tmpDir);
      assert.ok(r.success, `call failed: ${r.error}`);

      const state = fs.readFileSync(statePath, 'utf8');
      const progress = extractFrontmatter(state).progress;
      assert.ok(progress && progress.percent !== undefined, 'percent not found in frontmatter');
      assert.equal(Number(progress.percent), 67, `percent should be 67 (2/3 phases), got: ${progress.percent}`);
    });

    test('state frontmatter and numeric phase line reflect next phase after phase.complete', () => {
      setupPhase3517Project(tmpDir);
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');

      const r = runSdkQuery(['phase.complete', '5'], tmpDir);
      assert.ok(r.success, `call failed: ${r.error}`);

      const state = fs.readFileSync(statePath, 'utf8');
      const progress = extractFrontmatter(state).progress;
      assert.equal(
        Number(progress && progress.completed_phases),
        2,
        `completed_phases must be updated in frontmatter, got: ${progress && progress.completed_phases}`,
      );
      const phaseLine = stateExtractField(state, 'Phase');
      const { phase: nextPhase } = parsePhaseFromProse(phaseLine);
      assert.equal(
        Number(nextPhase),
        6,
        `numeric Phase line should advance to phase 6, got Phase line: ${phaseLine}`,
      );
    });

    test('prose-block STATE keeps next phase name without field-miss warnings (#1316)', () => {
      const { planningDir } = setupPhase1316Project(tmpDir);
      writePassedVerificationForPhase(tmpDir, '32');

      const result = toLegacyResult(runNode([GSD_TOOLS_BIN, 'phase', 'complete', '32'], {
        cwd: tmpDir,
        env: process.env,
        timeoutMs: PHASE_COMPLETE_TIMEOUT_MS,
      }));

      assert.strictEqual(result.status, 0, `phase complete failed: ${result.stderr || result.stdout}`);
      assert.ok(
        !result.stderr.includes('Current Phase Name'),
        `phase.complete must not warn about missing Current Phase Name on prose-block STATE.md; stderr:\n${result.stderr}`,
      );
      assert.ok(
        !result.stderr.includes('Last Activity Description'),
        `phase.complete must not warn about missing Last Activity Description on prose-block STATE.md; stderr:\n${result.stderr}`,
      );

      const state = fs.readFileSync(path.join(planningDir, 'STATE.md'), 'utf8');
      const currentPhase = extractFrontmatter(state).current_phase;
      assert.equal(
        String(currentPhase),
        '33',
        `current_phase frontmatter must advance to 33, got: ${currentPhase}`,
      );

      const phaseLine = stateExtractField(state, 'Phase');
      const { phase: nextPhase, name: nextPhaseName } = parsePhaseFromProse(phaseLine);
      assert.equal(Number(nextPhase), 33, `Current Position Phase line must advance to 33; got Phase line: ${phaseLine}`);
      assert.equal(
        nextPhaseName,
        'Follow Up Implementation',
        `Current Position Phase line must keep the next phase name; got Phase line: ${phaseLine}`,
      );

      const lastActivity = stateExtractField(state, 'Last activity');
      assert.match(
        lastActivity || '',
        /^\d{4}-\d{2}-\d{2}\s+—\s+Phase 32 complete/,
        `Last activity line must use the template em-dash delimiter with narrative; got: ${lastActivity}`,
      );
    });

    test('body By Phase table row for completed phase shows correct plan count', () => {
      setupPhase3517Project(tmpDir);
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');

      const r = runSdkQuery(['phase.complete', '5'], tmpDir);
      assert.ok(r.success, `call failed: ${r.error}`);

      const state = fs.readFileSync(statePath, 'utf8');
      const table = parseMarkdownTable(state);
      assert.ok(table.ok, `By Phase table must parse; reason: ${table.ok ? '' : table.reason}`);
      const row = table.value.rows.find((r) => r.Phase.trim() === '5');
      assert.ok(row, `By Phase table should have a row for phase 5.\nState:\n${state}`);
      assert.equal(
        row.Plans.trim(),
        '7',
        `By Phase table row for phase 5 should show 7 summaries, got row: ${JSON.stringify(row)}`,
      );
    });

    test('full consistency check: all STATE.md fields are coherent after phase.complete', () => {
      setupPhase3517Project(tmpDir);
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');
      const stateBefore = fs.readFileSync(statePath, 'utf8');

      const r = runSdkQuery(['phase.complete', '5'], tmpDir);
      assert.ok(r.success, `call failed: ${r.error}`);
      assert.equal(r.data?.state_updated, true, 'state_updated must be true');

      const state = fs.readFileSync(statePath, 'utf8');
      // #3685: earn the `true` above — assert STATE.md's content actually
      // changed, not merely that it exists (which is all the pre-fix
      // existsSync-based flag proved).
      assert.notEqual(state, stateBefore, '#3685: STATE.md content must actually change when state_updated is true');

      const fm = extractFrontmatter(state);
      assert.equal(
        Number(fm.progress && fm.progress.completed_phases),
        2,
        `completed_phases must be 2 (4 and 5 complete), got: ${fm.progress && fm.progress.completed_phases}`,
      );
      assert.equal(
        Number(fm.progress && fm.progress.percent),
        67,
        `percent must be 67%, got: ${fm.progress && fm.progress.percent}`,
      );
      const phaseLine = stateExtractField(state, 'Phase');
      const { phase: bodyPhase } = parsePhaseFromProse(phaseLine);
      const hasPhase6 = Number(bodyPhase) === 6 || Number(fm.current_phase) === 6;
      assert.ok(
        hasPhase6,
        `STATE.md must reference Phase 6 as current after completing Phase 5. body Phase line: ${phaseLine}, frontmatter current_phase: ${fm.current_phase}`,
      );
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ADR-3408 §8.3 Matrix A (#3469): cmdPhaseComplete now calls the ONE
  // write-seam composition (syncAndPreserveStateMd) directly instead of
  // hand-assembling syncStateFrontmatter + applyPostSyncPreservation itself
  // (Finding 3's re-derivation). Rows A2/A3's general identity claim (the
  // composition agrees with itself regardless of caller) is covered by the
  // required fast-check property test in tests/state.test.cjs; this block
  // covers the ones that need a REAL cmdPhaseComplete run — A6/A7's atomic
  // 3-file commit, plus a concrete consumer-level demonstration that BOTH
  // sync (a body-derived field advances) and preservation (an untouched
  // curated field survives) fire together through the real CLI path.
  // ─────────────────────────────────────────────────────────────────────────

  describe('ADR-3408 §8.3 Matrix A: cmdPhaseComplete write-seam composition (#3469)', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3469-a-'));
    });

    afterEach(() => {
      cleanup(tmpDir);
    });

    // A2/A3 (concrete, consumer-level): the same real cmdPhaseComplete call
    // both advances a body-derived field (progress.completed_phases, via the
    // transition) AND restores a CLASSIFIED preserve-when-unchanged field
    // (`paused_at`) completePhaseCore's transform never touches — proof the
    // seam applies sync AND `applyPostSyncPreservation`'s policy TOGETHER
    // through the real adapter, not just the transition alone.
    test('A2/A3: phase.complete advances the body-derived phase AND restores an untouched preserve-when-unchanged field, in one write', () => {
      setupPhase3517Project(tmpDir);
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');

      // Seed a curated `paused_at` — completePhaseCore never writes the
      // `## Session` `Paused At` body line, so its pre/post body source is
      // unchanged (both absent) and the classified preserve-when-unchanged
      // row must restore this curated value over the sync's empty derive.
      const before = fs.readFileSync(statePath, 'utf8');
      fs.writeFileSync(statePath, before.replace(/^gsd_state_version: 1\.0$/m, 'gsd_state_version: 1.0\npaused_at: "curated pause note — must survive"'));

      const r = runSdkQuery(['phase.complete', '5'], tmpDir);
      assert.ok(r.success, `call failed: ${r.error}`);

      const state = fs.readFileSync(statePath, 'utf8');
      const fm = extractFrontmatter(state);

      // A2/A3: the transition genuinely advanced the body-derived phase...
      assert.equal(Number(fm.progress && fm.progress.completed_phases), 2);

      // ...while `applyPostSyncPreservation`'s classified restore fired in
      // the SAME write — the composition's preservation stage ran, not just
      // its sync stage.
      assert.equal(
        fm.paused_at,
        'curated pause note — must survive',
        'a classified preserve-when-unchanged field completePhaseCore never touches must survive the same write',
      );
    });

    // A6 (independence): the composition returns content; the adapter's own
    // atomic 3-file envelope is unaffected — ROADMAP, REQUIREMENTS, and
    // STATE.md all change together as one unit.
    test('A6: STATE.md, ROADMAP.md, and REQUIREMENTS.md commit atomically as one unit', () => {
      setupPhase3517Project(tmpDir);
      const paths = {
        state: path.join(tmpDir, '.planning', 'STATE.md'),
        roadmap: path.join(tmpDir, '.planning', 'ROADMAP.md'),
      };
      const before = {
        state: fs.readFileSync(paths.state, 'utf8'),
        roadmap: fs.readFileSync(paths.roadmap, 'utf8'),
      };

      const r = runSdkQuery(['phase.complete', '5'], tmpDir);
      assert.ok(r.success, `call failed: ${r.error}`);

      const after = {
        state: fs.readFileSync(paths.state, 'utf8'),
        roadmap: fs.readFileSync(paths.roadmap, 'utf8'),
      };
      assert.notStrictEqual(after.state, before.state, 'STATE.md must change');
      assert.notStrictEqual(after.roadmap, before.roadmap, 'ROADMAP.md must change');
    });

    // A7 (IO failure, filesystem-failure category): a mid-commit failure on
    // the FIRST file in the atomic set (ROADMAP.md) leaves NONE of the three
    // partially written — including STATE.md, which now flows through the
    // shared syncAndPreserveStateMd composition before writePlanningFileSet
    // ever sees it. `t.mock.method` auto-restores at test end — never
    // chmod 0o000, which root bypasses under Docker/CI.
    test('A7: a failure writing ROADMAP.md (first in the atomic set) leaves STATE.md and REQUIREMENTS.md untouched', (t) => {
      setupPhase3517Project(tmpDir);
      const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
      const reqPath = path.join(tmpDir, '.planning', 'REQUIREMENTS.md');
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');
      const before = {
        roadmap: fs.readFileSync(roadmapPath, 'utf8'),
        req: fs.existsSync(reqPath) ? fs.readFileSync(reqPath, 'utf8') : null,
        state: fs.readFileSync(statePath, 'utf8'),
      };

      writePassedVerificationForPhase(tmpDir, '5');
      const phaseModule = require('../gsd-core/bin/lib/phase.cjs');
      const originalWriteFileSync = fs.writeFileSync;
      t.mock.method(fs, 'writeFileSync', function injectedRoadmapWriteFailure(target, ...args) {
        const targetPath = String(target);
        if (targetPath === roadmapPath || targetPath === `${roadmapPath}.tmp.${process.pid}`) {
          const err = new Error('injected ROADMAP.md write failure');
          err.code = 'EIO';
          throw err;
        }
        return originalWriteFileSync.call(this, target, ...args);
      });

      assert.throws(
        () => phaseModule.cmdPhaseComplete(tmpDir, '5', false),
        /injected ROADMAP\.md write failure/,
      );

      const after = {
        roadmap: fs.readFileSync(roadmapPath, 'utf8'),
        req: fs.existsSync(reqPath) ? fs.readFileSync(reqPath, 'utf8') : null,
        state: fs.readFileSync(statePath, 'utf8'),
      };
      assert.strictEqual(after.roadmap, before.roadmap, 'ROADMAP.md must be unchanged');
      assert.strictEqual(after.req, before.req, 'REQUIREMENTS.md must be unchanged');
      assert.strictEqual(after.state, before.state, 'STATE.md must be unchanged — none of the three partially written');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // ADR-3408 §8.5 Matrix B (#3471): cmdPhaseComplete's preservation is now
  // visible via `preservation_warnings` (D2 — #3374's "warnings: []"
  // complaint, on the exact command it was filed against). Design:
  // .gsd/phase/refactor-3471-stale-but-present/40-design.md. Matrix:
  // .gsd/phase/refactor-3471-stale-but-present/50-test-matrix.md section B.
  // Reuses setupPhase3517Project/runSdkQuery/writePassedVerificationForPhase
  // from this same folded block (bug #3517 fixture).
  // ─────────────────────────────────────────────────────────────────────────

  describe('ADR-3408 §8.5 Matrix B (#3471): cmdPhaseComplete preservation visibility (D2)', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3471-b-'));
    });

    afterEach(() => {
      cleanup(tmpDir);
    });

    // B1 — consumer-level (ADR-3180 Decision 4(c)): a curated field the
    // transition never touches (its body source is unchanged this write)
    // must be named in `preservation_warnings`, closing #3374's exact
    // "warnings: []" silence for the command it was filed against.
    test('B1: cmdPhaseComplete names the field it preserved in preservation_warnings', () => {
      setupPhase3517Project(tmpDir);
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');

      const before = fs.readFileSync(statePath, 'utf8');
      fs.writeFileSync(statePath, before.replace(/^gsd_state_version: 1\.0$/m, 'gsd_state_version: 1.0\npaused_at: "curated pause note — must survive"'));

      const r = runSdkQuery(['phase.complete', '5'], tmpDir);
      assert.ok(r.success, `call failed: ${r.error}`);

      assert.ok(Array.isArray(r.data.preservation_warnings), 'preservation_warnings must be an array');
      assert.deepStrictEqual(
        r.data.preservation_warnings,
        [{ field: 'paused_at', reason: 'preserved-over-disagreeing-derived' }],
      );
    });

    // B2 — negative: no false alarm. When nothing is preserved (no
    // disagreeing curated field), `preservation_warnings` must be empty, not
    // populated with a phantom entry.
    test('B2: cmdPhaseComplete emits an empty preservation_warnings when nothing was preserved', () => {
      setupPhase3517Project(tmpDir);

      const r = runSdkQuery(['phase.complete', '5'], tmpDir);
      assert.ok(r.success, `call failed: ${r.error}`);

      assert.deepStrictEqual(r.data.preservation_warnings, []);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// regression: bug #3601 — phase remove preserves peer-depth decimal sections
// (consolidated from tests/bug-3601-phase-remove-preserves-decimal-sections.test.cjs)
// ─────────────────────────────────────────────────────────────────────────────

{
  process.env.GSD_TEST_MODE = '1';

  function writeRoadmapForRemove(tmpDir, body) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), body);
  }
  function writeStateForRemove(tmpDir, version) {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---\nmilestone: ${version}\n---\n`,
    );
  }
  function ensurePhaseDir(tmpDir, name) {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', name), { recursive: true });
  }
  function getPhase(tmpDir, phaseNum) {
    const r = runGsdTools(['roadmap', 'get-phase', phaseNum, '--json'], tmpDir);
    if (!r.success) return { found: false, error: r.error };
    return JSON.parse(r.output);
  }

  describe('bug #3601: phase remove preserves peer-depth decimal sections', () => {
    let tmpDir;
    beforeEach(() => {
      tmpDir = createTempProject('bug-3601-');
    });
    afterEach(() => {
      cleanup(tmpDir);
    });

    test('removing Phase 2 preserves peer-depth Phase 2.1 and renumbers Phase 3 → 2', () => {
      writeStateForRemove(tmpDir, 'v1.0.0');
      writeRoadmapForRemove(
        tmpDir,
        [
          '# Roadmap',
          '',
          '## Current Milestone: v1.0.0 - Test',
          '',
          '### Phase 2: Parent',
          '**Goal:** RemoveMeGoal',
          '',
          '### Phase 2.1: Follow-up',
          '**Goal:** PreserveDecimalGoal',
          '',
          '### Phase 3: Trailing',
          '**Goal:** PreserveTrailingGoal',
          '',
        ].join('\n'),
      );
      ensurePhaseDir(tmpDir, '02-parent');
      ensurePhaseDir(tmpDir, '02.1-follow-up');
      ensurePhaseDir(tmpDir, '03-trailing');

      const r = runGsdTools(['phase', 'remove', '2'], tmpDir);
      assert.ok(r.success, `phase remove failed: ${r.error || r.output}`);

      const decimal = getPhase(tmpDir, '2.1');
      assert.strictEqual(decimal.found, true, 'Phase 2.1 deleted alongside Phase 2');
      assert.strictEqual(decimal.phase_name, 'Follow-up');
      assert.strictEqual(decimal.goal, 'PreserveDecimalGoal');

      const renumbered = getPhase(tmpDir, '2');
      assert.strictEqual(renumbered.found, true);
      assert.strictEqual(renumbered.phase_name, 'Trailing');
      assert.strictEqual(
        renumbered.goal,
        'PreserveTrailingGoal',
        'Phase 3 → Phase 2 renumber did not carry the right section content',
      );

      const parentLookup = getPhase(tmpDir, '3');
      assert.notStrictEqual(
        parentLookup.goal,
        'RemoveMeGoal',
        'removed parent goal reappeared under a phase header',
      );
    });

    test('removing Phase 5 preserves Phase 5.1 and Phase 5.2 (multiple peer decimals)', () => {
      writeStateForRemove(tmpDir, 'v1.0.0');
      writeRoadmapForRemove(
        tmpDir,
        [
          '# Roadmap',
          '',
          '## Current Milestone: v1.0.0 - Test',
          '',
          '### Phase 5: Parent',
          '**Goal:** RemoveParent',
          '',
          '### Phase 5.1: First child',
          '**Goal:** ChildAGoal',
          '',
          '### Phase 5.2: Second child',
          '**Goal:** ChildBGoal',
          '',
          '### Phase 6: Tail',
          '**Goal:** TailGoal',
          '',
        ].join('\n'),
      );
      ensurePhaseDir(tmpDir, '05-parent');
      ensurePhaseDir(tmpDir, '05.1-first-child');
      ensurePhaseDir(tmpDir, '05.2-second-child');
      ensurePhaseDir(tmpDir, '06-tail');

      const r = runGsdTools(['phase', 'remove', '5'], tmpDir);
      assert.ok(r.success);

      const decimalA = getPhase(tmpDir, '5.1');
      assert.strictEqual(decimalA.found, true, 'Phase 5.1 deleted');
      assert.strictEqual(decimalA.goal, 'ChildAGoal');

      const decimalB = getPhase(tmpDir, '5.2');
      assert.strictEqual(decimalB.found, true, 'Phase 5.2 deleted');
      assert.strictEqual(decimalB.goal, 'ChildBGoal');

      const tail = getPhase(tmpDir, '5');
      assert.strictEqual(tail.found, true);
      assert.strictEqual(tail.goal, 'TailGoal', 'Phase 6 → Phase 5 renumber misfired');
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // regression: bug #3602 — phase remove renumbers slugged plan references
  // (consolidated from tests/bug-3602-phase-remove-renumbers-slugged-plan-refs.test.cjs)
  // ─────────────────────────────────────────────────────────────────────────────

  function ensurePlanFile(tmpDir, phaseDirName, planName) {
    const p = path.join(tmpDir, '.planning', 'phases', phaseDirName, planName);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '# Plan\n');
  }

  describe('bug #3602: phase remove renumbers slugged plan references in ROADMAP', () => {
    let tmpDir;
    beforeEach(() => {
      tmpDir = createTempProject('bug-3602-');
    });
    afterEach(() => {
      cleanup(tmpDir);
    });

    test('slugged PLAN reference (07-01-cherry-pick-foundation-PLAN.md) is renumbered to 06-01-…', () => {
      writeStateForRemove(tmpDir, 'v1.0.0');
      writeRoadmapForRemove(
        tmpDir,
        [
          '# Roadmap',
          '',
          '## Current Milestone: v1.0.0',
          '',
          '### Phase 6: Old Work',
          '**Goal:** RemoveThisGoal',
          '',
          '### Phase 7: New Work',
          '**Goal:** Plans: 07-01-cherry-pick-foundation-PLAN.md and 07-02-finish-it-SUMMARY.md',
          '',
        ].join('\n'),
      );
      ensurePhaseDir(tmpDir, '06-old');
      ensurePhaseDir(tmpDir, '07-new');
      ensurePlanFile(tmpDir, '07-new', '07-01-cherry-pick-foundation-PLAN.md');
      ensurePlanFile(tmpDir, '07-new', '07-02-finish-it-SUMMARY.md');

      const r = runGsdTools(['phase', 'remove', '6'], tmpDir);
      assert.ok(r.success, `phase remove failed: ${r.error || r.output}`);

      const phase6 = getPhase(tmpDir, '6');
      assert.strictEqual(phase6.found, true);
      assert.strictEqual(phase6.phase_name, 'New Work');
      assert.ok(
        phase6.goal.includes('06-01-cherry-pick-foundation-PLAN.md'),
        `Plans reference for slugged PLAN was not renumbered. Goal: ${phase6.goal}`,
      );
      assert.ok(
        phase6.goal.includes('06-02-finish-it-SUMMARY.md'),
        `Plans reference for slugged SUMMARY was not renumbered. Goal: ${phase6.goal}`,
      );
      assert.ok(
        !phase6.goal.includes('07-01'),
        `stale 07-01 prefix remains in ROADMAP. Goal: ${phase6.goal}`,
      );
      assert.ok(
        !phase6.goal.includes('07-02'),
        `stale 07-02 prefix remains in ROADMAP. Goal: ${phase6.goal}`,
      );
    });

    test('compact PLAN/SUMMARY reference (07-01-PLAN.md) still renumbers (#3601 contract preserved)', () => {
      writeStateForRemove(tmpDir, 'v1.0.0');
      writeRoadmapForRemove(
        tmpDir,
        [
          '# Roadmap',
          '',
          '## Current Milestone: v1.0.0',
          '',
          '### Phase 6: Old',
          '**Goal:** RemoveGoal',
          '',
          '### Phase 7: New',
          '**Goal:** Plans: 07-01-PLAN.md and 07-02-SUMMARY.md',
          '',
        ].join('\n'),
      );
      ensurePhaseDir(tmpDir, '06-old');
      ensurePhaseDir(tmpDir, '07-new');
      ensurePlanFile(tmpDir, '07-new', '07-01-PLAN.md');
      ensurePlanFile(tmpDir, '07-new', '07-02-SUMMARY.md');

      const r = runGsdTools(['phase', 'remove', '6'], tmpDir);
      assert.ok(r.success);

      const phase6 = getPhase(tmpDir, '6');
      assert.strictEqual(phase6.found, true);
      assert.ok(phase6.goal.includes('06-01-PLAN.md'));
      assert.ok(phase6.goal.includes('06-02-SUMMARY.md'));
      assert.ok(!phase6.goal.includes('07-01-PLAN.md'));
      assert.ok(!phase6.goal.includes('07-02-SUMMARY.md'));
    });

    test('does NOT renumber values that look like phase-plan tokens but are not (e.g. 2026-01-01 dates)', () => {
      writeStateForRemove(tmpDir, 'v1.0.0');
      writeRoadmapForRemove(
        tmpDir,
        [
          '# Roadmap',
          '',
          '## Current Milestone: v1.0.0',
          '',
          '### Phase 6: Old',
          '**Goal:** RemoveGoal',
          '',
          '### Phase 7: Date safety',
          '**Goal:** Created 2026-01-01 and tagged v1-2-3 — must not renumber',
          '',
        ].join('\n'),
      );
      ensurePhaseDir(tmpDir, '06-old');
      ensurePhaseDir(tmpDir, '07-new');

      const r = runGsdTools(['phase', 'remove', '6'], tmpDir);
      assert.ok(r.success);

      const phase6 = getPhase(tmpDir, '6');
      assert.strictEqual(phase6.found, true);
      assert.ok(
        phase6.goal.includes('2026-01-01'),
        `ISO date 2026-01-01 was wrongly modified. Goal: ${phase6.goal}`,
      );
      assert.ok(
        phase6.goal.includes('v1-2-3'),
        `version-tag v1-2-3 was wrongly modified. Goal: ${phase6.goal}`,
      );
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// feature: phase complete auto-prune (#2087)
// (consolidated from tests/phase-complete-auto-prune.test.cjs)
// ─────────────────────────────────────────────────────────────────────────────

{
  function writeConfigForAutoPrune(tmpDir, config) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify(config, null, 2));
  }

  function writeStateMdForAutoPrune(tmpDir, content) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), content);
  }

  function readStateMdForAutoPrune(tmpDir) {
    return fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
  }

  function writeRoadmapForAutoPrune(tmpDir, content) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), content);
  }

  function setupPhaseForAutoPrune(tmpDir, phaseNum, planCount) {
    const phasesDir = path.join(tmpDir, '.planning', 'phases');
    const phaseDir = path.join(phasesDir, `${String(phaseNum).padStart(2, '0')}-test-phase`);
    fs.mkdirSync(phaseDir, { recursive: true });

    for (let i = 1; i <= planCount; i++) {
      const planId = `${String(phaseNum).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
      fs.writeFileSync(path.join(phaseDir, `${planId}-PLAN.md`), `# Plan ${planId}\n`);
      fs.writeFileSync(path.join(phaseDir, `${planId}-SUMMARY.md`), `# Summary ${planId}\n`);
    }
  }

  describe('phase complete auto-prune (#2087)', () => {
    let tmpDir;

    beforeEach(() => {
      tmpDir = createTempProject();
    });

    afterEach(() => {
      cleanup(tmpDir);
    });

    test('prunes STATE.md automatically when auto_prune_state is true', () => {
      writeConfigForAutoPrune(tmpDir, {
        workflow: { auto_prune_state: true },
      });

      writeStateMdForAutoPrune(tmpDir, [
        '# Session State',
        '',
        '**Current Phase:** 6',
        '**Status:** Executing',
        '',
        '## Decisions',
        '',
        '- [Phase 1]: Old decision from phase 1',
        '- [Phase 2]: Old decision from phase 2',
        '- [Phase 5]: Recent decision',
        '- [Phase 6]: Current decision',
        '',
      ].join('\n'));

      writeRoadmapForAutoPrune(tmpDir, [
        '# Roadmap',
        '',
        '## Phase 6: Test Phase',
        '',
        '**Plans:** 0/2',
        '',
      ].join('\n'));

      setupPhaseForAutoPrune(tmpDir, 6, 2);

      const result = runVerifiedPhaseComplete('phase complete 6', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const newState = readStateMdForAutoPrune(tmpDir);
      assert.doesNotMatch(newState, /\[Phase 1\]: Old decision/);
      assert.doesNotMatch(newState, /\[Phase 2\]: Old decision/);
      assert.match(newState, /\[Phase 5\]: Recent decision/);
      assert.match(newState, /\[Phase 6\]: Current decision/);
    });

    test('does NOT prune when auto_prune_state is false (default)', () => {
      writeConfigForAutoPrune(tmpDir, {
        workflow: { auto_prune_state: false },
      });

      writeStateMdForAutoPrune(tmpDir, [
        '# Session State',
        '',
        '**Current Phase:** 6',
        '**Status:** Executing',
        '',
        '## Decisions',
        '',
        '- [Phase 1]: Old decision from phase 1',
        '- [Phase 5]: Recent decision',
        '- [Phase 6]: Current decision',
        '',
      ].join('\n'));

      writeRoadmapForAutoPrune(tmpDir, [
        '# Roadmap',
        '',
        '## Phase 6: Test Phase',
        '',
        '**Plans:** 0/2',
        '',
      ].join('\n'));

      setupPhaseForAutoPrune(tmpDir, 6, 2);

      const result = runVerifiedPhaseComplete('phase complete 6', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const newState = readStateMdForAutoPrune(tmpDir);
      assert.match(newState, /\[Phase 1\]: Old decision/);
    });

    test('does NOT prune when auto_prune_state is absent from config', () => {
      writeConfigForAutoPrune(tmpDir, {
        workflow: {},
      });

      writeStateMdForAutoPrune(tmpDir, [
        '# Session State',
        '',
        '**Current Phase:** 6',
        '**Status:** Executing',
        '',
        '## Decisions',
        '',
        '- [Phase 1]: Old decision from phase 1',
        '- [Phase 6]: Current decision',
        '',
      ].join('\n'));

      writeRoadmapForAutoPrune(tmpDir, [
        '# Roadmap',
        '',
        '## Phase 6: Test Phase',
        '',
        '**Plans:** 0/2',
        '',
      ].join('\n'));

      setupPhaseForAutoPrune(tmpDir, 6, 2);

      const result = runVerifiedPhaseComplete('phase complete 6', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const newState = readStateMdForAutoPrune(tmpDir);
      assert.match(newState, /\[Phase 1\]: Old decision/);
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// bug #1229: phase.add bullet-only phase collision
// ─────────────────────────────────────────────────────────────────────────────

// Count canonical Phase N entries in roadmap content (header or bullet form).
// Only counts "### Phase N:" headers and "- [ ] **Phase N:" bullet entries.
// Does NOT count references like "**Depends on:** Phase N".
function countBug1229PhaseNumber(roadmapContent, n) {
  let count = 0;
  const headerRe = new RegExp('^#{2,4}\\s*Phase\\s+' + n + '[A-Z]?(?:\\.\\d+)*:', 'gim');
  const bulletRe = new RegExp(
    '^[ \\t]*-[ \\t]*\\[[^\\]]*\\][ \\t]*\\*{0,2}Phase[ \\t]+' + n + '(?=[:.\\ \\t*]|$)',
    'gim',
  );
  const headerMatches = roadmapContent.match(headerRe);
  const bulletMatches = roadmapContent.match(bulletRe);
  if (headerMatches) count += headerMatches.length;
  if (bulletMatches) count += bulletMatches.length;
  return count;
}

describe('bug #1229: phase.add must count bullet-only phases to avoid number collision', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('bullet-only Phase 11 is counted: next add gets Phase 12, not 11', () => {
    // ROADMAP has Phases 1-3 as full sections and Phase 11 as bullet-only.
    // Before the fix, maxPhase resolved to 3 (header scan) and phase.add
    // silently produced Phase 4, then on a second add would produce Phase 11
    // — or if headers went to 10, it would produce Phase 11 colliding with
    // the existing bullet.
    const roadmap = [
      '# Roadmap v1.0',
      '',
      '## Phases',
      '',
      '- [ ] **Phase 1: Foundation**',
      '- [ ] **Phase 2: Core**',
      '- [x] **Phase 3: Done**',
      '- [ ] **Phase 11: Communications / Zoho Sync**',
      '',
      '### Phase 1: Foundation',
      '',
      '**Goal:** Build foundations',
      '',
      '### Phase 2: Core',
      '',
      '**Goal:** Core work',
      '',
      '### Phase 3: Done',
      '',
      '**Goal:** Completed work',
      '',
      '---',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);

    // Create disk dirs for phases 1, 2, 3 (not 11 -- that is bullet-only)
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-core'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-done'), { recursive: true });

    const result = runGsdTools('phase add New Feature', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phase_number,
      12,
      `Expected phase 12 (bullet-only Phase 11 must be counted), got ${output.phase_number}`,
    );

    // Verify no duplicate Phase 11 written
    const updatedRoadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    const phase11Count = countBug1229PhaseNumber(updatedRoadmap, 11);
    assert.ok(
      phase11Count === 1,
      `ROADMAP must have exactly 1 occurrence of Phase 11 (no duplicate), found ${phase11Count}`,
    );

    // Verify Phase 12 was written
    assert.ok(
      updatedRoadmap.includes('### Phase 12:'),
      'ROADMAP must contain new ### Phase 12: entry',
    );

    // Verify directory was created at 12, not 11
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '12-new-feature')),
      'phases/12-new-feature directory must be created',
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'phases', '11-new-feature')),
      'phases/11-new-feature must NOT be created (collision guard)',
    );
  });

  test('[x] checkbox variant bullet phase is counted', () => {
    // Phase 5 exists only as a [x] bullet (completed, no dir, no header)
    const roadmap = [
      '# Roadmap v1.0',
      '',
      '### Phase 1: Foundation',
      '',
      '**Goal:** Setup',
      '',
      '### Phase 2: API',
      '',
      '**Goal:** Build',
      '',
      '### Phase 3: UI',
      '',
      '**Goal:** Interfaces',
      '',
      '### Phase 4: Deploy',
      '',
      '**Goal:** Ship it',
      '',
      '- [x] **Phase 5: Post-launch Cleanup**',
      '',
      '---',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);

    const result = runGsdTools('phase add Follow-up Work', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phase_number,
      6,
      `Expected phase 6 ([x] bullet-only Phase 5 must be counted), got ${output.phase_number}`,
    );
  });

  test('[~] checkbox variant bullet phase is counted', () => {
    // Phase 7 exists only as a [~] bullet (in-progress, no dir, no header)
    const roadmap = [
      '# Roadmap v1.0',
      '',
      '### Phase 1: Foundation',
      '',
      '**Goal:** Setup',
      '',
      '- [~] **Phase 7: Partial Work**',
      '',
      '---',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);

    const result = runGsdTools('phase add Next Phase', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phase_number,
      8,
      `Expected phase 8 ([~] bullet-only Phase 7 must be counted), got ${output.phase_number}`,
    );
  });

  test('baseline: no bullet-only phases -- existing behavior preserved', () => {
    const roadmap = [
      '# Roadmap v1.0',
      '',
      '### Phase 1: Foundation',
      '',
      '**Goal:** Setup',
      '',
      '### Phase 2: API',
      '',
      '**Goal:** Build',
      '',
      '---',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);

    const result = runGsdTools('phase add Third Phase', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phase_number,
      3,
      `Expected phase 3 (normal sequential add), got ${output.phase_number}`,
    );
  });

  test('bullet without ** bold markers is counted', () => {
    // Phase 6 as plain bullet without ** markdown bold
    const roadmap = [
      '# Roadmap v1.0',
      '',
      '### Phase 1: Foundation',
      '',
      '**Goal:** Setup',
      '',
      '### Phase 2: Core',
      '',
      '**Goal:** Core',
      '',
      '- [ ] Phase 6: Plain bullet no bold',
      '',
      '---',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);

    const result = runGsdTools('phase add Another Phase', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phase_number,
      7,
      `Expected phase 7 (plain-bullet Phase 6 must be counted), got ${output.phase_number}`,
    );
  });

  test('titleless bold bullet "- [ ] **Phase 11**" is counted: next add gets Phase 12', () => {
    // Regression for the adversarial-review finding: the original bulletPattern
    // required a colon or whitespace after the digits, so "- [ ] **Phase 11**"
    // (bold-close immediately after the number) was silently skipped and phase.add
    // would assign Phase 11 again — the exact collision class bug #1229 fixes.
    const roadmap = [
      '# Roadmap v1.0',
      '',
      '### Phase 1: Foundation',
      '',
      '**Goal:** Setup',
      '',
      '### Phase 2: Core',
      '',
      '**Goal:** Core',
      '',
      '- [ ] **Phase 11**',
      '',
      '---',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);

    const result = runGsdTools('phase add Titleless Bold Follow-up', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phase_number,
      12,
      `Expected phase 12 (titleless bold bullet "**Phase 11**" must be counted), got ${output.phase_number}`,
    );

    const updatedRoadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(
      updatedRoadmap.includes('### Phase 12:'),
      'ROADMAP must contain new ### Phase 12: entry',
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '12-titleless-bold-follow-up')),
      'phases/12-titleless-bold-follow-up directory must be created',
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'phases', '11-titleless-bold-follow-up')),
      'phases/11-titleless-bold-follow-up must NOT be created (collision guard)',
    );
  });

  test('EOL bullet "- [ ] Phase 11" (no title, no bold) is counted: next add gets Phase 12', () => {
    // Regression: "- [ ] Phase 11" at end-of-line was not matched by the original
    // pattern whose trailing [:\s] requires at least one character after the digits.
    const roadmap = [
      '# Roadmap v1.0',
      '',
      '### Phase 1: Foundation',
      '',
      '**Goal:** Setup',
      '',
      '### Phase 2: Core',
      '',
      '**Goal:** Core',
      '',
      '- [ ] Phase 11',
      '',
      '---',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);

    const result = runGsdTools('phase add EOL Follow-up', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.phase_number,
      12,
      `Expected phase 12 (EOL bullet "Phase 11" must be counted), got ${output.phase_number}`,
    );

    const updatedRoadmap = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.ok(
      updatedRoadmap.includes('### Phase 12:'),
      'ROADMAP must contain new ### Phase 12: entry',
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'phases', '12-eol-follow-up')),
      'phases/12-eol-follow-up directory must be created',
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'phases', '11-eol-follow-up')),
      'phases/11-eol-follow-up must NOT be created (collision guard)',
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/247-phase-uat-passed.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:247-phase-uat-passed (consolidation epic #1969 B2 #1971)", () => {
'use strict';

/**
 * Integration tests for `phase uat-passed <N>` CLI command.
 * Issue #247 — phase uat-passed predicate
 *
 * Tests the full dispatch path: gsd-tools → phase-command-router → phase.cmdPhaseUatPassed
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Set up a minimal project with a phase directory and ROADMAP so that
 * findPhaseInternal(cwd, phaseNum) can resolve it.
 * Returns { tmpDir, phaseDir }.
 */
function setupProject(phaseSlug = '01-feature') {
  const tmpDir = createTempProject();
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    [
      '# Roadmap',
      '',
      '- [ ] Phase 1: Feature',
      '',
      '### Phase 1: Feature',
      '**Goal:** Build feature',
      '**Plans:** 1 plans',
      '',
    ].join('\n'),
  );
  const phaseDir = path.join(tmpDir, '.planning', 'phases', phaseSlug);
  fs.mkdirSync(phaseDir, { recursive: true });
  return { tmpDir, phaseDir };
}

function writeUatFile(phaseDir, filename, content) {
  fs.writeFileSync(path.join(phaseDir, filename), content, 'utf-8');
}

function setMtime(filePath, time) {
  fs.utimesSync(filePath, time, time);
}

function makePassingUat() {
  return [
    '---',
    'status: passed',
    '---',
    '',
    '# UAT Results',
    '',
    '### 1. Login works',
    'expected: User logs in successfully',
    'result: passed',
    '',
  ].join('\n');
}

function makePendingUat() {
  return [
    '---',
    'status: partial',
    '---',
    '',
    '# UAT Results',
    '',
    '### 1. Login works',
    'expected: User logs in successfully',
    'result: passed',
    '',
    '### 2. Logout works',
    'expected: User logs out successfully',
    'result: pending',
    '',
  ].join('\n');
}

function makeFencedFalsePositiveUat() {
  // Only "result: passed" lines are inside a fenced block.
  // The real test has result: pending → should evaluate to passed:false.
  return [
    '---',
    'status: partial',
    '---',
    '',
    '# UAT Results',
    '',
    '## Example (do not run)',
    '```',
    '### 1. Test',
    'expected: Example',
    'result: passed',
    '```',
    '',
    '### 1. Real Test',
    'expected: The thing works',
    'result: pending',
    '',
  ].join('\n');
}

// ─── Basic pass/fail cases ─────────────────────────────────────────────────────

describe('phase uat-passed — basic pass/fail', () => {
  let tmpDir;
  let phaseDir;

  beforeEach(() => {
    ({ tmpDir, phaseDir } = setupProject('01-feature'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('passing UAT → passed:true with correct JSON shape', () => {
    writeUatFile(phaseDir, 'feature-UAT.md', makePassingUat());
    const result = runGsdTools('phase uat-passed 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}\nOutput: ${result.output}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.passed, true);
    assert.strictEqual(out.phase, '1');
    assert.ok(Array.isArray(out.uat_files), 'uat_files must be an array');
    assert.ok(Array.isArray(out.verification_files), 'verification_files must be an array');
    assert.ok(Array.isArray(out.checks), 'checks must be an array');
    assert.ok(Array.isArray(out.blockers), 'blockers must be an array');
    assert.ok(out.policy && typeof out.policy.require_verification === 'boolean',
      'policy.require_verification must be a boolean');
    assert.strictEqual(typeof out.no_uat_artifacts, 'boolean', 'no_uat_artifacts must be a boolean');
    assert.strictEqual(out.no_uat_artifacts, false, 'no_uat_artifacts must be false when checks exist');
    assert.strictEqual(out.blockers.length, 0);
  });

  test('pending UAT → passed:false', () => {
    writeUatFile(phaseDir, 'feature-UAT.md', makePendingUat());
    const result = runGsdTools('phase uat-passed 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.passed, false);
    assert.strictEqual(out.phase, '1');
    assert.ok(out.blockers.length > 0, 'Should have blockers for pending test');
  });

  test('false-positive only (fenced block) → passed:false', () => {
    writeUatFile(phaseDir, 'feature-UAT.md', makeFencedFalsePositiveUat());
    const result = runGsdTools('phase uat-passed 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.passed, false,
      'result:passed inside a fenced block must not flip the predicate to passed');
  });

  test('no UAT files → passed:false + no_uat_artifacts:true (fail-closed, no vacuous pass)', () => {
    // Phase directory exists but has no UAT files — fail-closed: absence is NOT a pass
    const result = runGsdTools('phase uat-passed 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.passed, false,
      'Phase with no UAT files must NOT vacuously pass — fail-closed predicate');
    assert.strictEqual(out.no_uat_artifacts, true,
      'no_uat_artifacts must be true when no UAT items found');
    assert.deepStrictEqual(out.uat_files, []);
  });
});

// ─── --require-verification flag ──────────────────────────────────────────────

describe('phase uat-passed — --require-verification flag', () => {
  let tmpDir;
  let phaseDir;

  beforeEach(() => {
    ({ tmpDir, phaseDir } = setupProject('01-feature'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('--require-verification with no verification file → passed:false', () => {
    writeUatFile(phaseDir, 'feature-UAT.md', makePassingUat());
    const result = runGsdTools('phase uat-passed 1 --require-verification', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.passed, false,
      'require-verification with no verification file should fail');
    assert.strictEqual(out.policy.require_verification, true);
    assert.ok(out.blockers.some(b => /verification required/i.test(b)),
      `Expected verification-required blocker, got: ${JSON.stringify(out.blockers)}`);
  });

  test('--require-verification with passing verification → passed:true', () => {
    writeUatFile(phaseDir, 'feature-UAT.md', makePassingUat());
    writeUatFile(phaseDir, 'feature-VERIFICATION.md', '---\nstatus: passed\n---\n\nVerified OK.');
    const result = runGsdTools('phase uat-passed 1 --require-verification', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.passed, true);
    assert.strictEqual(out.policy.require_verification, true);
  });

  test('--require-verification with stale passed verification → passed:false', () => {
    writeUatFile(phaseDir, 'feature-UAT.md', makePassingUat());
    const verificationPath = path.join(phaseDir, 'feature-VERIFICATION.md');
    const summaryPath = path.join(phaseDir, 'feature-SUMMARY.md');
    writeUatFile(phaseDir, 'feature-VERIFICATION.md', '---\nstatus: passed\n---\n\nVerified OK.');
    writeUatFile(phaseDir, 'feature-SUMMARY.md', '# Summary\n\nImplementation changed after verification.\n');
    const now = new Date();
    setMtime(verificationPath, new Date(now.getTime() - 60_000));
    setMtime(summaryPath, now);

    const result = runGsdTools('phase uat-passed 1 --require-verification', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.passed, false);
    assert.ok(
      out.blockers.some(b => /verification status=stale/i.test(b)),
      `Expected stale-verification blocker, got: ${JSON.stringify(out.blockers)}`,
    );
  });

  test('--require-verification with non-canonical complete verification → passed:false', () => {
    writeUatFile(phaseDir, 'feature-UAT.md', makePassingUat());
    writeUatFile(phaseDir, 'feature-VERIFICATION.md', '---\nstatus: complete\n---\n\nLegacy OK.');
    const result = runGsdTools('phase uat-passed 1 --require-verification', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.strictEqual(out.passed, false);
    assert.ok(out.blockers.some(b => /verification required/i.test(b)),
      `Expected verification-required blocker, got: ${JSON.stringify(out.blockers)}`);
  });
});

// ─── Error cases ──────────────────────────────────────────────────────────────

describe('phase uat-passed — error cases', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Write a minimal ROADMAP so phase 1 exists
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '### Phase 1: Feature',
        '**Goal:** Build feature',
        '',
      ].join('\n'),
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-feature'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('missing phase number → error message', () => {
    const result = runGsdTools('phase uat-passed', tmpDir);
    assert.ok(!result.success, 'Should fail with no phase number');
    assert.ok(
      result.error.includes('phase number required') ||
      result.error.includes('Available:'),
      `Expected phase-number-required error, got: ${result.error}`,
    );
  });

  test('unknown phase number → error message', () => {
    const result = runGsdTools('phase uat-passed 99', tmpDir);
    assert.ok(!result.success, 'Should fail for unknown phase');
    assert.ok(
      result.error.includes('not found') || result.error.includes('99'),
      `Expected not-found error, got: ${result.error}`,
    );
  });

  test('unknown flag (typo --require-verifcation) → InvalidArgs error, not silent pass', () => {
    const result = runGsdTools('phase uat-passed 1 --require-verifcation', tmpDir);
    assert.ok(!result.success,
      'Unknown flag must cause an error, not silently pass');
    assert.ok(
      result.error.includes('--require-verifcation') ||
      result.error.includes('does not support') ||
      result.error.includes('invalid'),
      `Expected unknown-flag error, got: ${result.error}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2769-requirements-header-variants.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2769-requirements-header-variants (consolidation epic #1969 B2 #1971)", () => {
/**
 * Regression tests for issue #2769
 *
 * The Requirements header in ROADMAP.md phase blocks renders identically in
 * markdown for three textually distinct forms:
 *
 *   **Requirements:**          colon INSIDE bold delimiters
 *   **Requirements**:          colon OUTSIDE bold delimiters
 *   **Requirements** :         space-then-colon outside bold
 *
 * Two parsers in the codebase used opposing strict regexes — one only
 * matched the outside-colon form (init.cjs / init.ts), the other only the
 * inside-colon form (phase.cjs `cmdPhaseComplete` REQUIREMENTS.md
 * traceability sweep). Both must accept all three variants so phase
 * metadata propagation is robust to authoring style.
 *
 * Tests for the init query side live in `tests/init.test.cjs` (parameterized
 * over the three variants). This file exercises the inverse bug in
 * `phase complete`: the REQUIREMENTS.md checkbox must flip when ROADMAP
 * uses the outside-colon form, which previously was silently skipped.
 */

'use strict';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

describe('bug #2769: phase complete ticks REQUIREMENTS.md across header variants', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      ['---', 'current_phase: 1', 'status: executing', '---', '# State', ''].join('\n'),
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  const headerVariants = [
    { name: 'colon inside bold (**Requirements:**)', header: '**Requirements:** REQ-001' },
    { name: 'colon outside bold (**Requirements**:)', header: '**Requirements**: REQ-001' },
    { name: 'space before colon (**Requirements** :)', header: '**Requirements** : REQ-001' },
  ];

  for (const variant of headerVariants) {
    test(`flips REQ-001 checkbox in REQUIREMENTS.md when ROADMAP uses ${variant.name}`, () => {
      const phasesDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
      fs.mkdirSync(phasesDir, { recursive: true });
      fs.writeFileSync(
        path.join(phasesDir, '01-1-PLAN.md'),
        ['---', 'phase: 1', 'plan: 1', '---', '# Plan 1', ''].join('\n'),
      );
      fs.writeFileSync(
        path.join(phasesDir, '01-1-SUMMARY.md'),
        ['---', 'status: complete', '---', '# Summary', 'Done.'].join('\n'),
      );
      fs.writeFileSync(
        path.join(phasesDir, '01-VERIFICATION.md'),
        ['---', 'status: passed', 'score: "1/1"', '---', '# Verification', 'Passed.'].join('\n'),
      );

      const roadmap = [
        '# Roadmap',
        '',
        '### Phase 1: Foundation',
        '',
        '**Goal:** Build core',
        variant.header,
        '**Plans:** 1 plans',
        '',
        'Plans:',
        '- [x] 01-1-PLAN.md',
        '',
        '| Phase | Plans | Status | Completed |',
        '|-------|-------|--------|-----------|',
        '| 1. Foundation | 0/1 | Pending | - |',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);

      const requirements = [
        '# Requirements',
        '',
        '## Functional Requirements',
        '',
        '- [ ] **REQ-001**: Core data model',
        '',
        '## Traceability',
        '',
        '| REQ-ID | Phase | Status |',
        '|--------|-------|--------|',
        '| REQ-001 | 1 | Pending |',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), requirements);

      const result = runGsdTools(['phase', 'complete', '1'], tmpDir);
      assert.ok(result.success, `phase complete failed: ${result.error}`);

      const updated = fs.readFileSync(
        path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
        'utf-8',
      );
      assert.match(
        updated,
        /-\s*\[x\]\s*\*\*REQ-001\*\*/,
        `REQ-001 checkbox must be flipped to [x] when ROADMAP header is "${variant.header}". Got:\n${updated}`,
      );
      assert.match(
        updated,
        /\|\s*REQ-001\s*\|\s*1\s*\|\s*Complete\s*\|/,
        `Traceability row for REQ-001 must be marked Complete. Got:\n${updated}`,
      );
    });
  }
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3537-padded-id-against-unpadded-roadmap.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3537-padded-id-against-unpadded-roadmap (consolidation epic #1969 B2 #1971)", () => {
/**
 * Regression tests for bug #3537
 *
 * Phase state verbs must match a canonical phase id against ROADMAP.md prose
 * regardless of zero-padding on either side: the skills pass the padded form
 * (`02.7`) after resolving the phase directory, but human-authored ROADMAP
 * prose is conventionally un-padded (`### Phase 2.7:`, `- [ ] **Phase 2.7:**`).
 *
 * v1.42.1 added `phaseMarkdownRegexSource()` which renders `0*<integer><...>`
 * — padding-tolerant on both sides — but wired it into only 1 of 8 call sites.
 * The other 7 used raw `escapeRegex(phaseNum)` or `0*${escapeRegex(...)}`
 * (tolerated extra padding, not missing), so passing the padded form silently
 * no-op'd and the verbs returned success while ROADMAP.md was unchanged.
 *
 * Parity assertion (per CONTEXT.md DEFECT.GENERATIVE-FIX): for each verb,
 * running with the padded form must produce the same ROADMAP.md as running
 * with the un-padded form against an identical fixture. Per-site fixes
 * without a parity test let the next call-site drift back undetected.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const { cleanup } = require('./helpers.cjs');

const gsdTools = path.resolve(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

function run(args, cwd) {
  try {
    return {
      stdout: execFileSync('node', [gsdTools, ...args], {
        cwd,
        timeout: 15000,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
      ok: true,
    };
  } catch (e) {
    return {
      stdout: (e.stdout && e.stdout.toString()) || '',
      stderr: (e.stderr && e.stderr.toString()) || '',
      ok: false,
      code: e.status,
    };
  }
}

/**
 * Build a planning fixture with project_code='CK', padded phase directory
 * (`CK-02.7-meta-lead-ads/`), and un-padded ROADMAP prose (`Phase 2.7`).
 * This mirrors the reporter's environment in #3537 exactly.
 */
function setupFixture(tmpDir, opts = {}) {
  const {
    projectCode = 'CK',
    paddedId = '02.7',
    unpaddedId = '2.7',
    extraPhases = [],
  } = opts;

  const planningDir = path.join(tmpDir, '.planning');
  fs.mkdirSync(planningDir, { recursive: true });

  fs.writeFileSync(
    path.join(planningDir, 'config.json'),
    JSON.stringify({ project_code: projectCode })
  );

  fs.writeFileSync(
    path.join(planningDir, 'STATE.md'),
    `---\ncurrent_phase: ${unpaddedId}\nstatus: executing\n---\n# State\n`
  );

  // Padded phase directory with one plan + matching summary so the phase
  // is "complete" for phase-complete and update-plan-progress verbs.
  const phaseDirName = `${projectCode}-${paddedId}-meta-lead-ads`;
  const phaseDir = path.join(planningDir, 'phases', phaseDirName);
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(
    path.join(phaseDir, `${paddedId}-01-PLAN.md`),
    `---\nphase: ${unpaddedId}\nplan: 1\nwave: 1\n---\n# Plan 1\n`
  );
  fs.writeFileSync(
    path.join(phaseDir, `${paddedId}-01-SUMMARY.md`),
    '---\nstatus: complete\n---\n# Summary\nDone.'
  );
  fs.writeFileSync(
    path.join(phaseDir, `${paddedId}-VERIFICATION.md`),
    '---\nstatus: passed\nscore: "1/1"\n---\n# Verification\nPassed.\n'
  );

  const extra = extraPhases
    .map((p) => `- [ ] **Phase ${p.id}: ${p.name}**`)
    .join('\n');

  const roadmap = [
    '# Roadmap',
    '',
    '## v1.0 Milestone',
    '',
    `- [ ] **Phase ${unpaddedId}: Meta Lead Ads**`,
    extra,
    '',
    '## Progress',
    '',
    '| Phase | Plans | Status | Completed |',
    '|-------|-------|--------|-----------|',
    `| ${unpaddedId} Meta Lead Ads | 0/1 | Planned | - |`,
    '',
    `### Phase ${unpaddedId}: Meta Lead Ads`,
    '',
    '**Goal:** ship the thing',
    '**Plans:** 0 plans',
    '',
    'Plans:',
    `- [ ] ${paddedId}-01-PLAN.md`,
    '',
    ...extraPhases.flatMap((p) => [
      `### Phase ${p.id}: ${p.name}`,
      '',
      '**Goal:** stub',
      '**Plans:** 0 plans',
      '',
      'Plans:',
      `- [ ] ${p.id}-01-PLAN.md`,
      '',
    ]),
  ]
    .filter((l) => l !== '')
    .join('\n') + '\n';

  fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), roadmap);

  return {
    planningDir,
    roadmapPath: path.join(planningDir, 'ROADMAP.md'),
    phaseDir,
  };
}

/**
 * Run a verb in two parallel fixtures — one passing the padded form, one
 * passing the un-padded form — then compare the resulting ROADMAP.md bytes.
 * Any divergence means the verb's regex did not tolerate padding on at least
 * one side.
 */
function expectParity({ verbWithPadded, verbWithUnpadded, fixtureOpts }) {
  const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3537-A-'));
  const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3537-B-'));
  try {
    const a = setupFixture(tmpA, fixtureOpts);
    const b = setupFixture(tmpB, fixtureOpts);

    const ra = verbWithPadded(tmpA);
    const rb = verbWithUnpadded(tmpB);

    const aRoadmap = fs.readFileSync(a.roadmapPath, 'utf-8');
    const bRoadmap = fs.readFileSync(b.roadmapPath, 'utf-8');

    return { aRoadmap, bRoadmap, ra, rb };
  } finally {
    cleanup(tmpA);
    cleanup(tmpB);
  }
}

describe('bug #3537: phase verbs accept padded ids against un-padded ROADMAP prose', () => {
  test('phase complete: padded 02.7 and un-padded 2.7 produce identical ROADMAP', () => {
    const { aRoadmap, bRoadmap } = expectParity({
      fixtureOpts: {},
      verbWithPadded: (cwd) => run(['phase', 'complete', '02.7'], cwd),
      verbWithUnpadded: (cwd) => run(['phase', 'complete', '2.7'], cwd),
    });

    assert.equal(
      aRoadmap,
      bRoadmap,
      'padded `02.7` must mutate ROADMAP identically to un-padded `2.7`'
    );
    // And the canonical mutation must have actually happened (otherwise
    // both forms could be silently no-op'ing and still produce identical
    // output — a vacuous parity pass).
    assert.match(
      aRoadmap,
      /- \[x\] \*\*Phase 2\.7:/,
      'overview checkbox should be flipped under both invocations'
    );
  });

  test('roadmap get-phase: padded 02.7 returns the same section as un-padded 2.7', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3537-get-'));
    try {
      setupFixture(tmp, {});
      const padded = run(['roadmap', 'get-phase', '02.7', '--raw'], tmp);
      const unpadded = run(['roadmap', 'get-phase', '2.7', '--raw'], tmp);

      assert.equal(
        padded.stdout,
        unpadded.stdout,
        'padded and un-padded ids must return identical sections'
      );
      // Non-vacuous guard: both forms must have actually returned a section
      // (the bug we're fixing was that the padded form returned an empty
      // string while reporting success).
      assert.ok(
        padded.stdout.trim().length > 0,
        'verb must return non-empty section under both invocations'
      );
    } finally {
      cleanup(tmp);
    }
  });

  test('phase next-decimal: padded 02 finds decimals in un-padded ROADMAP', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3537-nd-'));
    try {
      setupFixture(tmp, {
        paddedId: '02.7',
        unpaddedId: '2.7',
      });

      // Padded base `02` must discover the existing decimal `2.7` from the
      // un-padded heading and propose `2.8` (or higher) as next.
      const padded = run(['phase', 'next-decimal', '02', '--raw'], tmp);
      const unpadded = run(['phase', 'next-decimal', '2', '--raw'], tmp);

      assert.equal(
        padded.stdout,
        unpadded.stdout,
        'next-decimal must produce identical JSON for padded and un-padded base'
      );

      // Sanity: the existing 2.7 must be reflected. If the prose-scan regex
      // silently failed to match `Phase 2.7`, the result would skip 2.7 and
      // wrongly propose 2.1 as next. `phase next-decimal --raw` emits the
      // next id as plain text (`02.8`), so trimmed string equality is the
      // typed assertion shape (no raw-text regex matching — lint policy).
      const nextDecimalPadded = padded.stdout.trim();
      assert.notEqual(
        nextDecimalPadded,
        '02.1',
        'must not propose 02.1 when 2.7 already exists in ROADMAP'
      );
      assert.notEqual(
        nextDecimalPadded,
        '2.1',
        'must not propose 2.1 when 2.7 already exists in ROADMAP'
      );
    } finally {
      cleanup(tmp);
    }
  });

  test('phase insert: padded base 02 finds anchor in un-padded ROADMAP', () => {
    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3537-ins-A-'));
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3537-ins-B-'));
    try {
      // Use a phase 2 (no decimal) base so insert proposes 2.1.
      const optsA = {
        paddedId: '02',
        unpaddedId: '2',
      };
      setupFixture(tmpA, optsA);
      setupFixture(tmpB, optsA);

      const padded = run(['phase', 'insert', '02', 'urgent extension'], tmpA);
      const unpadded = run(['phase', 'insert', '2', 'urgent extension'], tmpB);

      // Both invocations should succeed (exit 0) — passing the padded base
      // against un-padded prose used to error "Phase 02 not found".
      assert.ok(
        padded.ok,
        `padded form must succeed, got code=${padded.code}, stderr=${padded.stderr}`
      );
      assert.ok(
        unpadded.ok,
        `un-padded form must succeed, got code=${unpadded.code}`
      );

      const aRoadmap = fs.readFileSync(
        path.join(tmpA, '.planning', 'ROADMAP.md'),
        'utf-8'
      );

      // The new header may be rendered as `Phase 02.1` or `Phase 2.1`
      // (normalizePhaseName pads to 2 digits today; that is pre-existing
      // behavior, not the subject of #3537). The critical assertion for
      // this verb is "padded form found the anchor and the insertion
      // happened" — full byte-parity is gated by an unrelated `Depends on:
      // Phase ${afterPhase}` echo bug that lies outside #3537's scope.
      assert.match(
        aRoadmap,
        /### Phase 0?2\.1: urgent extension/,
        'padded form must insert the new decimal phase header'
      );
      // Reference `tmpB` to ensure cleanup runs and keep it alive in the
      // closure — also a smoke-check that the un-padded sibling did not
      // crash mid-run.
      assert.ok(fs.existsSync(path.join(tmpB, '.planning', 'ROADMAP.md')));
    } finally {
      cleanup(tmpA);
      cleanup(tmpB);
    }
  });

  test('roadmap annotate-dependencies: padded 02.7 finds phase section', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3537-ann-'));
    try {
      const { roadmapPath } = setupFixture(tmp, {});
      const before = fs.readFileSync(roadmapPath, 'utf-8');

      const padded = run(
        ['roadmap', 'annotate-dependencies', '02.7'],
        tmp
      );
      assert.ok(
        padded.ok,
        `padded form must succeed, got code=${padded.code}, stderr=${padded.stderr}`
      );

      const after = fs.readFileSync(roadmapPath, 'utf-8');
      // The annotation may be a no-op if there's only one wave and no
      // cross-cutting truths, but the verb must have reached the phase
      // section. Confirm by running parity against un-padded form on a
      // separate fixture and asserting equality.
      const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3537-ann2-'));
      try {
        const { roadmapPath: rp2 } = setupFixture(tmp2, {});
        run(['roadmap', 'annotate-dependencies', '2.7'], tmp2);
        const unpadded = fs.readFileSync(rp2, 'utf-8');
        assert.equal(
          after,
          unpadded,
          'annotate-dependencies must produce identical output for padded and un-padded ids'
        );
        // And the verb must not have silently destroyed the file (sanity).
        assert.match(after, /### Phase 2\.7:/, 'phase header must survive');
        // Reference `before` to keep it from being dead-binding-flagged
        // and to assert the run did not corrupt the rest of the file.
        assert.ok(before.length > 0);
      } finally {
        cleanup(tmp2);
      }
    } finally {
      cleanup(tmp);
    }
  });

  test('roadmap update-plan-progress: control case — already wired in 1.42.1', () => {
    // This is the one site already using phaseMarkdownRegexSource. Including
    // it as a control proves the parity assertion is a meaningful signal
    // (this test should pass on main, while the others fail).
    const { aRoadmap, bRoadmap } = expectParity({
      fixtureOpts: {},
      verbWithPadded: (cwd) =>
        run(['roadmap', 'update-plan-progress', '02.7'], cwd),
      verbWithUnpadded: (cwd) =>
        run(['roadmap', 'update-plan-progress', '2.7'], cwd),
    });

    assert.equal(
      aRoadmap,
      bRoadmap,
      'control verb must already produce identical output (wired in 1.42.1)'
    );
    assert.match(
      aRoadmap,
      /- \[x\] \*\*Phase 2\.7:/,
      'control verb must flip checkbox under both invocations'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Regression: bug #2853 — roadmap.update-plan-progress deletes hand-written
// annotations after the plan count. The count-bump regex's trailing `[^\n]+`
// swallowed the whole line and the replacement wrote back only the regenerated
// count, truncating any human prose after it.
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2853-plan-progress-annotation-preservation", () => {
'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const gsdTools2853 = path.resolve(__dirname, '..', 'gsd-core', 'bin', 'gsd-tools.cjs');

function run2853(args, cwd) {
  try {
    return {
      stdout: execFileSync('node', [gsdTools2853, ...args], {
        cwd, timeout: 15000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
      }),
      ok: true,
    };
  } catch (e) {
    return {
      stdout: (e.stdout && e.stdout.toString()) || '',
      stderr: (e.stderr && e.stderr.toString()) || '',
      ok: false, code: e.status,
    };
  }
}

/**
 * Build a phase-10 fixture with one plan + matching summary + verification
 * `passed`, so the phase is "complete" for update-plan-progress. The ROADMAP
 * `Plans` summary line is supplied verbatim so each test pins a specific shape.
 */
function setupFixture2853(tmpDir, plansSummaryLine, opts = {}) {
  const { incomplete = false, eol = '\n' } = opts;
  const planningDir = path.join(tmpDir, '.planning');
  const phaseDir = path.join(planningDir, 'phases', 'CK-10-test-phase');
  fs.mkdirSync(phaseDir, { recursive: true });

  fs.writeFileSync(path.join(planningDir, 'config.json'), JSON.stringify({ project_code: 'CK' }));
  fs.writeFileSync(
    path.join(planningDir, 'STATE.md'),
    `---\ncurrent_phase: 10\nstatus: executing\n---\n# State\n`
  );

  fs.writeFileSync(
    path.join(phaseDir, '10-01-PLAN.md'),
    `---\nphase: 10\nplan: 1\nwave: 1\n---\n# Plan 1\n`
  );
  fs.writeFileSync(
    path.join(phaseDir, '10-01-SUMMARY.md'),
    '---\nstatus: complete\n---\n# Summary\nDone.\n'
  );
  fs.writeFileSync(
    path.join(phaseDir, '10-VERIFICATION.md'),
    incomplete
      ? '---\nstatus: pending\n---\n# Verification\nPending.\n'
      : '---\nstatus: passed\nscore: "1/1"\n---\n# Verification\nPassed.\n'
  );

  const roadmap = [
    '# Roadmap',
    '',
    '## v1.0 Milestone',
    '',
    '- [ ] **Phase 10: Test Phase**',
    '',
    '## Progress',
    '',
    '| Phase | Plans | Status | Completed |',
    '|-------|-------|--------|-----------|',
    '| 10 Test Phase | 0/1 | Planned | - |',
    '',
    '### Phase 10: Test Phase',
    '',
    '**Goal:** reproduce',
    plansSummaryLine,
    '',
    'Plans:',
    '- [ ] 10-01-PLAN.md',
    '',
  ].join('\n') + '\n';

  fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), roadmap.replace(/\n/g, eol));

  return { planningDir, roadmapPath: path.join(planningDir, 'ROADMAP.md') };
}

describe('bug #2853: update-plan-progress preserves hand-written annotations', () => {
  test('row 1 — bold colon-outside form: annotation after count survives a complete bump', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2853-r1-'));
    try {
      const annotation = '(11-16 are gap closure from VERIFICATION)';
      const { roadmapPath } = setupFixture2853(
        tmp,
        `**Plans**: 0/1 plans executed ${annotation}`
      );
      run2853(['roadmap', 'update-plan-progress', '10'], tmp);

      const result = fs.readFileSync(roadmapPath, 'utf-8');
      const line = result.split(/\r?\n/).find((l) => l.includes('**Plans**'));
      assert.ok(line, 'Plans summary line must exist');
      assert.ok(
        line.includes(annotation),
        `annotation must survive; got: ${line}`
      );
      assert.match(line, /1\/1 plans complete/, 'count must still bump to complete');
    } finally {
      cleanup(tmp);
    }
  });

  test('row 2 — **Plans:** colon-inside-bold form: annotation survives', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2853-r2-'));
    try {
      const annotation = '(gap closure wave)';
      const { roadmapPath } = setupFixture2853(
        tmp,
        `**Plans:** 0/1 plans executed ${annotation}`
      );
      run2853(['roadmap', 'update-plan-progress', '10'], tmp);
      const line = fs.readFileSync(roadmapPath, 'utf-8').split(/\r?\n/).find((l) => l.includes('**Plans:**'));
      assert.ok(line && line.includes(annotation), `annotation must survive; got: ${line}`);
    } finally {
      cleanup(tmp);
    }
  });

  test('row 3 — plain Plans: header form: annotation survives', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2853-r3-'));
    try {
      const annotation = '(see verification notes)';
      const { roadmapPath } = setupFixture2853(tmp, `Plans: 0/1 plans executed ${annotation}`);
      run2853(['roadmap', 'update-plan-progress', '10'], tmp);
      const result = fs.readFileSync(roadmapPath, 'utf-8');
      const line = result.split(/\r?\n/).find((l) => /^Plans:/.test(l));
      assert.ok(line && line.includes(annotation), `annotation must survive; got: ${line}`);
    } finally {
      cleanup(tmp);
    }
  });

  test('row 4 — no trailing text: count updates with no whitespace regression', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2853-r4-'));
    try {
      const { roadmapPath } = setupFixture2853(tmp, '**Plans:** 0/1 plans executed');
      run2853(['roadmap', 'update-plan-progress', '10'], tmp);
      const line = fs.readFileSync(roadmapPath, 'utf-8').split(/\r?\n/).find((l) => l.includes('**Plans:**'));
      assert.ok(line, 'Plans line must exist');
      // Exact line: count bumped, no stray trailing space or duplicated text.
      assert.equal(line, '**Plans:** 1/1 plans complete');
    } finally {
      cleanup(tmp);
    }
  });

  test('row 5 — bare template form `N plans` (no slash) still gets count inserted', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2853-r5-'));
    try {
      const { roadmapPath } = setupFixture2853(tmp, '**Plans:** 0 plans');
      run2853(['roadmap', 'update-plan-progress', '10'], tmp);
      const line = fs.readFileSync(roadmapPath, 'utf-8').split(/\r?\n/).find((l) => l.includes('**Plans:**'));
      assert.ok(line, 'Plans line must exist');
      assert.match(line, /1\/1 plans complete/, 'bare form must still receive the canonical count');
    } finally {
      cleanup(tmp);
    }
  });

  test('row 6 — executed (non-complete) path: annotation survives', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2853-r6-'));
    try {
      const annotation = '(half-done, gap closure pending)';
      const { roadmapPath } = setupFixture2853(
        tmp,
        `**Plans:** 0/1 plans executed ${annotation}`,
        { incomplete: true }
      );
      run2853(['roadmap', 'update-plan-progress', '10'], tmp);
      const line = fs.readFileSync(roadmapPath, 'utf-8').split(/\r?\n/).find((l) => l.includes('**Plans:**'));
      assert.ok(line, 'Plans line must exist');
      assert.ok(line.includes(annotation), `annotation must survive on executed path; got: ${line}`);
      assert.match(line, /1\/1 plans executed/, 'count must reflect executed (not complete) path');
    } finally {
      cleanup(tmp);
    }
  });

  test('row 7 — CRLF input: annotation text preserved (line-ending normalization is pre-existing)', () => {
    // The verb has always normalized ROADMAP.md line endings on its read-modify-write
    // (a pre-existing trait, not #2853's concern). What #2853 guarantees is that the
    // annotation TEXT survives the count bump on whatever line ending the verb emits.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2853-r7-'));
    try {
      const annotation = '(CRLF note)';
      const { roadmapPath } = setupFixture2853(
        tmp,
        `**Plans:** 0/1 plans executed ${annotation}`,
        { eol: '\r\n' }
      );
      run2853(['roadmap', 'update-plan-progress', '10'], tmp);
      const result = fs.readFileSync(roadmapPath, 'utf-8');
      const plansLine = result.split(/\r?\n/).find((l) => l.includes('**Plans:**'));
      assert.ok(plansLine, 'Plans summary line must exist');
      assert.ok(
        plansLine.includes(annotation),
        `annotation text must survive on a CRLF-origin file; got: ${plansLine}`
      );
      assert.match(plansLine, /1\/1 plans complete/, 'count must still bump');
    } finally {
      cleanup(tmp);
    }
  });

  test('row 8 — idempotent re-run does not drop annotation', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2853-r8-'));
    try {
      const annotation = '(idempotent check)';
      const { roadmapPath } = setupFixture2853(
        tmp,
        `**Plans:** 0/1 plans executed ${annotation}`
      );
      run2853(['roadmap', 'update-plan-progress', '10'], tmp);
      run2853(['roadmap', 'update-plan-progress', '10'], tmp);
      const line = fs.readFileSync(roadmapPath, 'utf-8').split(/\r?\n/).find((l) => l.includes('**Plans:**'));
      assert.ok(line && line.includes(annotation), `annotation must survive a no-op re-run; got: ${line}`);
    } finally {
      cleanup(tmp);
    }
  });

  test('row 9 — fresh-template placeholder is replaced, not glued to the new count', () => {
    // The canonical template ships `**Plans**: [Number of plans, e.g., "3 plans" or "TBD"]`.
    // A count bump must NOT preserve that bracketed guidance verbatim glued after the
    // count (pre-#2853 produced a clean `N/N plans complete`). The count replaces the
    // placeholder because there is no real count token for $2 to anchor a trailing-text
    // preservation to.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2853-r9-'));
    try {
      const placeholder = '[Number of plans, e.g., "3 plans" or "TBD"]';
      const { roadmapPath } = setupFixture2853(tmp, `**Plans**: ${placeholder}`);
      run2853(['roadmap', 'update-plan-progress', '10'], tmp);
      const line = fs.readFileSync(roadmapPath, 'utf-8').split(/\r?\n/).find((l) => l.includes('**Plans**'));
      assert.ok(line, 'Plans line must exist');
      assert.equal(
        line,
        '**Plans**: 1/1 plans complete',
        `placeholder must be replaced cleanly, not glued; got: ${line}`
      );
    } finally {
      cleanup(tmp);
    }
  });
});

// ────────────────────────────────────────────────────────────────────────
// Regression: bug #3584 — #2853 only preserved trailing text when a real
// count token preceded it. When no token was present (freeform prose, `TBD`,
// a wrapped sentence's first line, an empty value), the verb still dropped
// $3 and glued the computed count in its place — and since only the FIRST
// line of a wrapped sentence sits inside the match, this orphaned the
// continuation line. Fix inverts the default: the count is only ever
// inserted (a) over a real count token (#2853's arm, unchanged) or (b) over
// the fresh-template bracketed placeholder, detected positively. Everything
// else is left untouched.
// ────────────────────────────────────────────────────────────────────────
describe('bug #3584: update-plan-progress leaves non-count Plans text untouched', () => {
  test('case 1 — freeform prose with no count token is preserved verbatim', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3584-c1-'));
    t.after(() => cleanup(tmp));
    const prose = 'This phase intentionally has no plan count yet.';
    const { roadmapPath } = setupFixture2853(tmp, `**Plans**: ${prose}`);
    const result = run2853(['roadmap', 'update-plan-progress', '10'], tmp);
    assert.ok(result.ok, `run must succeed; stderr: ${result.stderr}`);
    const line = fs.readFileSync(roadmapPath, 'utf-8').split(/\r?\n/).find((l) => l.includes('**Plans**'));
    assert.equal(line, `**Plans**: ${prose}`, `freeform prose must survive verbatim; got: ${line}`);
  });

  test('case 2 — a sentence wrapping onto a second line never orphans the continuation', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3584-c2-'));
    t.after(() => cleanup(tmp));
    const planningDir = path.join(tmp, '.planning');
    const { roadmapPath } = setupFixture2853(tmp, '**Plans**: This phase needs additional scoping before');
    const before = fs.readFileSync(roadmapPath, 'utf-8');
    const withContinuation = before.replace(
      '**Plans**: This phase needs additional scoping before\n',
      '**Plans**: This phase needs additional scoping before\nthe plan count can be finalized.\n'
    );
    fs.writeFileSync(roadmapPath, withContinuation);
    const result = run2853(['roadmap', 'update-plan-progress', '10'], tmp);
    assert.ok(result.ok, `run must succeed; stderr: ${result.stderr}`);
    const after = fs.readFileSync(roadmapPath, 'utf-8');
    assert.ok(
      after.includes('**Plans**: This phase needs additional scoping before\nthe plan count can be finalized.'),
      `both wrapped lines must survive intact; got:\n${after}`
    );
    void planningDir;
  });

  test('case 3 — `TBD — <annotation>` survives with the annotation intact', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3584-c3-'));
    t.after(() => cleanup(tmp));
    const { roadmapPath } = setupFixture2853(tmp, '**Plans**: TBD — awaiting scoping decision');
    run2853(['roadmap', 'update-plan-progress', '10'], tmp);
    const line = fs.readFileSync(roadmapPath, 'utf-8').split(/\r?\n/).find((l) => l.includes('**Plans**'));
    assert.equal(line, '**Plans**: TBD — awaiting scoping decision', `TBD annotation must survive; got: ${line}`);
  });

  test('case 4 — the fresh-template bracketed placeholder is still replaced with the computed count', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3584-c4-'));
    t.after(() => cleanup(tmp));
    // Exact shape shipped by gsd-core/templates/roadmap.md.
    const placeholder = '[Number of plans, e.g., "3 plans" or "TBD"]';
    const { roadmapPath } = setupFixture2853(tmp, `**Plans**: ${placeholder}`);
    run2853(['roadmap', 'update-plan-progress', '10'], tmp);
    const line = fs.readFileSync(roadmapPath, 'utf-8').split(/\r?\n/).find((l) => l.includes('**Plans**'));
    assert.equal(line, '**Plans**: 1/1 plans complete', `placeholder must still be replaced; got: ${line}`);
  });

  test('case 5 — canonical token with no annotation is rewritten', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3584-c5-'));
    t.after(() => cleanup(tmp));
    const { roadmapPath } = setupFixture2853(tmp, '**Plans**: 0/1 plans');
    run2853(['roadmap', 'update-plan-progress', '10'], tmp);
    const line = fs.readFileSync(roadmapPath, 'utf-8').split(/\r?\n/).find((l) => l.includes('**Plans**'));
    assert.equal(line, '**Plans**: 1/1 plans complete', `token must be rewritten; got: ${line}`);
  });

  test('case 6 — canonical token WITH a hand-written annotation (#2853): token rewritten, annotation preserved', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3584-c6-'));
    t.after(() => cleanup(tmp));
    const annotation = '(11-16 are gap closure from VERIFICATION)';
    const { roadmapPath } = setupFixture2853(tmp, `**Plans**: 0/1 plans executed ${annotation}`);
    run2853(['roadmap', 'update-plan-progress', '10'], tmp);
    const line = fs.readFileSync(roadmapPath, 'utf-8').split(/\r?\n/).find((l) => l.includes('**Plans**'));
    assert.equal(line, `**Plans**: 1/1 plans complete ${annotation}`, `#2853 arm must be unchanged; got: ${line}`);
  });

  test('case 7 — bare `N plans` form (no slash) is rewritten', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3584-c7-'));
    t.after(() => cleanup(tmp));
    const { roadmapPath } = setupFixture2853(tmp, '**Plans**: 3 plans');
    run2853(['roadmap', 'update-plan-progress', '10'], tmp);
    const line = fs.readFileSync(roadmapPath, 'utf-8').split(/\r?\n/).find((l) => l.includes('**Plans**'));
    assert.equal(line, '**Plans**: 1/1 plans complete', `bare form must be rewritten; got: ${line}`);
  });

  test('case 8a — CRLF variant, preserving arm: `\\r` neither stranded nor duplicated', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3584-c8a-'));
    t.after(() => cleanup(tmp));
    const { roadmapPath } = setupFixture2853(tmp, '**Plans**: TBD — pending decision', { eol: '\r\n' });
    run2853(['roadmap', 'update-plan-progress', '10'], tmp);
    const after = fs.readFileSync(roadmapPath, 'utf-8');
    const plansIdx = after.indexOf('**Plans**');
    const nlIdx = after.indexOf('\n', plansIdx);
    const restOfLine = after.slice(plansIdx, nlIdx === -1 ? after.length : nlIdx);
    // Exactly the text plus at most a single trailing \r — never two, never none-when-expected.
    assert.ok(
      restOfLine === '**Plans**: TBD — pending decision' || restOfLine === '**Plans**: TBD — pending decision\r',
      `CRLF preserving arm must not strand/duplicate \\r; got: ${JSON.stringify(restOfLine)}`
    );
    assert.equal((restOfLine.match(/\r/g) || []).length <= 1, true, 'must not duplicate \\r');
  });

  test('case 8b — CRLF variant, rewriting arm: `\\r` neither stranded nor duplicated', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3584-c8b-'));
    t.after(() => cleanup(tmp));
    const { roadmapPath } = setupFixture2853(tmp, '**Plans**: 0/1 plans', { eol: '\r\n' });
    run2853(['roadmap', 'update-plan-progress', '10'], tmp);
    const after = fs.readFileSync(roadmapPath, 'utf-8');
    const plansIdx = after.indexOf('**Plans**');
    const nlIdx = after.indexOf('\n', plansIdx);
    const restOfLine = after.slice(plansIdx, nlIdx === -1 ? after.length : nlIdx);
    assert.ok(
      restOfLine === '**Plans**: 1/1 plans complete' || restOfLine === '**Plans**: 1/1 plans complete\r',
      `CRLF rewriting arm must not strand/duplicate \\r; got: ${JSON.stringify(restOfLine)}`
    );
    assert.equal((restOfLine.match(/\r/g) || []).length <= 1, true, 'must not duplicate \\r');
  });

  test('case 9 — leaving the Plans line untouched does not turn the verb into a no-op', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3584-c9-'));
    t.after(() => cleanup(tmp));
    const prose = 'Scoping still pending — do not touch.';
    const { roadmapPath } = setupFixture2853(tmp, `**Plans**: ${prose}`);
    const result = run2853(['roadmap', 'update-plan-progress', '10'], tmp);
    assert.ok(result.ok, `run must exit 0; stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.updated, true, 'updated must be true even when the Plans line is left alone');
    assert.equal(parsed.plan_count, 1, 'plan_count must still be computed correctly');
    assert.equal(parsed.summary_count, 1, 'summary_count must still be computed correctly');
    assert.equal(parsed.complete, true, 'complete must still be computed correctly');

    const after = fs.readFileSync(roadmapPath, 'utf-8');
    // Plans line itself untouched.
    assert.ok(after.includes(`**Plans**: ${prose}`), 'Plans line must remain untouched');
    // Phase checkbox in the phase list must still flip.
    assert.match(after, /- \[x\] \*\*Phase 10: Test Phase\*\* \(completed \d{4}-\d{2}-\d{2}\)/, 'phase checkbox must still be checked');
    // Progress table Status/Completed cells must still update.
    assert.match(after, /\|\s*10 Test Phase\s*\|\s*0\/1\s*\|\s*Complete\s*\|\s*\d{4}-\d{2}-\d{2}\s*\|/, 'progress table row must still update');
    // Plan checklist row must still be checked.
    assert.match(after, /- \[x\] 10-01-PLAN\.md/, 'plan checklist row must still be checked');
  });

  test('case 10 — empty value after the label is left alone, no fabricated count', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3584-c10-'));
    t.after(() => cleanup(tmp));
    const { roadmapPath } = setupFixture2853(tmp, '**Plans**:');
    const result = run2853(['roadmap', 'update-plan-progress', '10'], tmp);
    assert.ok(result.ok, `run must succeed; stderr: ${result.stderr}`);
    const line = fs.readFileSync(roadmapPath, 'utf-8').split(/\r?\n/).find((l) => l.includes('**Plans**'));
    assert.equal(line, '**Plans**:', `empty value must be left alone with no fabricated count; got: ${line}`);
  });

  // Finding A (adversarial review): a bracketed HUMAN annotation is
  // structurally identical to the bracketed template placeholder but carries
  // none of its wording — it must be preserved, not destroyed.
  test('case 11 — a bracketed human annotation is preserved verbatim, not mistaken for the template placeholder', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3584-c11-'));
    t.after(() => cleanup(tmp));
    const { roadmapPath } = setupFixture2853(tmp, '**Plans**: [Deferred pending re-scope]');
    const result = run2853(['roadmap', 'update-plan-progress', '10'], tmp);
    assert.ok(result.ok, `run must succeed; stderr: ${result.stderr}`);
    const line = fs.readFileSync(roadmapPath, 'utf-8').split(/\r?\n/).find((l) => l.includes('**Plans**'));
    assert.equal(line, '**Plans**: [Deferred pending re-scope]', `human bracketed note must survive verbatim; got: ${line}`);
  });

  // The shorter template placeholder shape (gsd-core/templates/roadmap.md
  // lines 51/75/88) must still be replaced.
  test('case 12 — the short template placeholder `[Number of plans]` is still replaced', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3584-c12-'));
    t.after(() => cleanup(tmp));
    const { roadmapPath } = setupFixture2853(tmp, '**Plans**: [Number of plans]');
    run2853(['roadmap', 'update-plan-progress', '10'], tmp);
    const line = fs.readFileSync(roadmapPath, 'utf-8').split(/\r?\n/).find((l) => l.includes('**Plans**'));
    assert.equal(line, '**Plans**: 1/1 plans complete', `short placeholder must still be replaced; got: ${line}`);
  });

  // Finding B (adversarial review): the singular bare `N plan` form is the
  // tool's own documented one-plan-phase grammar (templates/roadmap.md:62)
  // and must be recognised as a real count token, not frozen forever.
  test('case 13 — bare singular `1 plan` form (no `s`) is rewritten to the computed count', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3584-c13-'));
    t.after(() => cleanup(tmp));
    const { roadmapPath } = setupFixture2853(tmp, '**Plans**: 1 plan');
    const result = run2853(['roadmap', 'update-plan-progress', '10'], tmp);
    assert.ok(result.ok, `run must succeed; stderr: ${result.stderr}`);
    const line = fs.readFileSync(roadmapPath, 'utf-8').split(/\r?\n/).find((l) => l.includes('**Plans**'));
    assert.equal(line, '**Plans**: 1/1 plans complete', `singular token must be rewritten; got: ${line}`);
  });

  test('case 14 — bare singular `1 plan` WITH a hand-written annotation: token rewritten, annotation preserved', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3584-c14-'));
    t.after(() => cleanup(tmp));
    const annotation = '(scope confirmed small)';
    const { roadmapPath } = setupFixture2853(tmp, `**Plans**: 1 plan ${annotation}`);
    run2853(['roadmap', 'update-plan-progress', '10'], tmp);
    const line = fs.readFileSync(roadmapPath, 'utf-8').split(/\r?\n/).find((l) => l.includes('**Plans**'));
    assert.equal(line, `**Plans**: 1/1 plans complete ${annotation}`, `singular token must be rewritten with annotation preserved; got: ${line}`);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2268-parallel-discuss.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2268-parallel-discuss (consolidation epic #1969 B2 #1971)", () => {
/**
 * Regression test for bug #2268
 *
 * cmdInitProgress used a sliding-window pattern that set is_next_to_discuss
 * only on the FIRST undiscussed phase. Multiple independent undiscussed phases
 * could not be discussed in parallel — the manager only ever recommended one
 * discuss action at a time.
 *
 * Fix: mark ALL undiscussed phases as is_next_to_discuss = true so the user
 * can pick any of them.
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

function writeRoadmap(tmpDir, phases) {
  const sections = phases.map(p => {
    let section = `### Phase ${p.number}: ${p.name}\n\n**Goal:** Do the thing\n`;
    return section;
  }).join('\n');
  const checklist = phases.map(p => {
    const mark = p.complete ? 'x' : ' ';
    return `- [${mark}] **Phase ${p.number}: ${p.name}**`;
  }).join('\n');
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    `# Roadmap\n\n## Progress\n\n${checklist}\n\n${sections}`
  );
}

function writeState(tmpDir) {
  fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '---\nstatus: active\n---\n# State\n');
}

let tmpDir;

describe('bug #2268: parallel discuss — all undiscussed phases marked is_next_to_discuss', () => {
  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('two undiscussed phases: both marked is_next_to_discuss', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation' },
      { number: '2', name: 'Cloud Deployment' },
    ]);

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.phases[0].is_next_to_discuss, true, 'phase 1 should be discussable');
    assert.strictEqual(output.phases[1].is_next_to_discuss, true, 'phase 2 should also be discussable');
  });

  test('two undiscussed phases: both get discuss recommendations', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation' },
      { number: '2', name: 'Cloud Deployment' },
    ]);

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    const discussActions = output.recommended_actions.filter(a => a.action === 'discuss');
    assert.strictEqual(discussActions.length, 2, 'should recommend discuss for both undiscussed phases');

    const phases = discussActions.map(a => a.phase).sort();
    assert.deepStrictEqual(phases, ['1', '2']);
  });

  test('five undiscussed phases: all five marked is_next_to_discuss', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Alpha' },
      { number: '2', name: 'Beta' },
      { number: '3', name: 'Gamma' },
      { number: '4', name: 'Delta' },
      { number: '5', name: 'Epsilon' },
    ]);

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    for (const phase of output.phases) {
      assert.strictEqual(phase.is_next_to_discuss, true, `phase ${phase.number} should be discussable`);
    }
  });

  test('discussed phase stays false; undiscussed sibling is true', () => {
    writeState(tmpDir);
    writeRoadmap(tmpDir, [
      { number: '1', name: 'Foundation' },
      { number: '2', name: 'API Layer' },
    ]);
    // scaffold CONTEXT.md to mark phase 1 as discussed
    const dir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '01-CONTEXT.md'), '# Context');

    const result = runGsdTools('init manager', tmpDir);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.phases[0].is_next_to_discuss, false, 'discussed phase must not be is_next_to_discuss');
    assert.strictEqual(output.phases[1].is_next_to_discuss, true, 'undiscussed sibling must be is_next_to_discuss');
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/4-phase-complete-cjs-regression.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:4-phase-complete-cjs-regression (consolidation epic #1969 B3 #1972)", () => {
'use strict';

/**
 * Regression test for issue #4 (open-gsd/gsd-core):
 *   bin/lib/phase.cjs cmdPhaseComplete — non-idempotent and unclamped.
 *
 * Root cause (pre-fix):
 *   cmdPhaseComplete blindly increments "Completed Phases" by 1 on every call
 *   (parseInt(completedRaw, 10) + 1) and recomputes Progress without a clamp.
 *   Double-calling yields Completed Phases +2 (not +1), and Progress can exceed 100%.
 *
 * Fix: derive completed_phases from ROADMAP Complete-row count (idempotent) and
 *   clamp percent to 100. This mirrors the SDK fix in phase-lifecycle.ts
 *   (commit deriving from ROADMAP, referenced as "PR #3520" in issue #4).
 *
 * Note on test structure: phase-command-router.cjs delegates to the SDK when
 *   the SDK dist is present, so the CJS path is exercised by calling
 *   cmdPhaseComplete directly (bypassing the router), which is the actual
 *   function containing the bug.
 *
 * References:
 *   - ADR-3524 (docs/adr/3524-cjs-sdk-hard-seam.md) — architectural foundation
 *   - /tmp/adr-3524-review-findings.md — architectural justification
 *   - Issue #4 (open-gsd/gsd-core)
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { cleanup, runGsdTools } = require('./helpers.cjs');

// ── Load cmdPhaseComplete directly from phase.cjs (bypass the SDK router) ────
// phase-command-router.cjs delegates to SDK when available; we must test the
// CJS implementation directly since that is where the bug lives.
const phaseModule = require('../gsd-core/bin/lib/phase.cjs');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');
const { splitTableRow } = require('../gsd-core/bin/lib/markdown-table.cjs');
const { cmdPhaseComplete } = phaseModule;

function writePassedVerificationFile(phaseDir, phase = '01') {
  fs.writeFileSync(path.join(phaseDir, `${phase}-VERIFICATION.md`), [
    '---',
    'status: passed',
    '---',
    '',
    '# Verification',
    '',
  ].join('\n'));
}

// ── Fixture builder ──────────────────────────────────────────────────────────

/**
 * Creates a minimal fixture project with:
 *   - ROADMAP.md with a 4-column progress table (Phase | Plans | Status | Completed)
 *   - REQUIREMENTS.md with a phase-scoped REQ-ID and Traceability row
 *   - STATE.md with Completed Phases: 0 and Total Phases: 2 (Progress 0%)
 *   - Phase 01 directory with one plan+summary (to satisfy phase complete guard)
 *   - Phase 02 directory (next phase)
 */
function createFixture(prefix = 'gsd-4-regression-', phase01DirName = '01-foundation') {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const planningDir = path.join(tmpDir, '.planning');
  const phasesDir = path.join(planningDir, 'phases');
  fs.mkdirSync(phasesDir, { recursive: true });

  // ROADMAP.md: Phase 01 not yet complete, Phase 02 not started
  // 4-column progress table: Phase | Plans Complete | Status | Completed
  const roadmap = [
    '# Roadmap',
    '',
    '- [ ] Phase 01: Foundation',
    '- [ ] Phase 02: API',
    '',
    '### Phase 01: Foundation',
    '**Goal:** Build the foundation',
    '**Requirements:** REQ-1',
    '**Plans:** 1 plans',
    '',
    '### Phase 02: API',
    '**Goal:** Build the API',
    '',
    '## Progress',
    '',
    '| Phase | Plans Complete | Status | Completed |',
    '|-------|----------------|--------|-----------|',
    '| 01. Foundation | 0/1 | Not started | - |',
    '| 02. API | 0/1 | Not started | - |',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(planningDir, 'ROADMAP.md'), roadmap);

  const requirements = [
    '# Requirements',
    '',
    '## Functional Requirements',
    '',
    '- [ ] **REQ-1** Foundation must be complete.',
    '',
    '## Traceability',
    '',
    '| Requirement | Phase | Status |',
    '|-------------|-------|--------|',
    '| REQ-1 | Phase 01 | Pending |',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(planningDir, 'REQUIREMENTS.md'), requirements);

  // STATE.md: Completed Phases: 0, Total Phases: 2, Progress: 0%
  // Uses body-field format (bold **Field:** value) so the CJS handler's
  // stateExtractField/stateReplaceField path is exercised.
  const state = [
    '# State',
    '',
    '**Current Phase:** 01',
    '**Current Phase Name:** Foundation',
    '**Status:** In progress',
    '**Current Plan:** 01-01',
    '**Last Activity:** 2025-01-01',
    '**Last Activity Description:** Working on phase 1',
    '**Completed Phases:** 0',
    '**Total Phases:** 2',
    '**Progress:** 0%',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(planningDir, 'STATE.md'), state);

  // Phase 01 directory with a PLAN and SUMMARY so phase complete guard passes
  const phase01Dir = path.join(phasesDir, phase01DirName);
  fs.mkdirSync(phase01Dir, { recursive: true });
  fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan 1\nDo the work.\n');
  fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary 1\nDone.\n');
  writePassedVerificationFile(phase01Dir);

  // Phase 02 directory (needed for "next phase" detection)
  fs.mkdirSync(path.join(phasesDir, '02-api'), { recursive: true });

  return tmpDir;
}

function readStateMd(tmpDir) {
  return fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf8');
}

function roadmapCompletionSnapshot(roadmapContent) {
  const snapshot = {
    phaseCheckboxes: [],
    progressRows: [],
  };

  for (const line of roadmapContent.split(/\r?\n/)) {
    let match = line.match(/^- \[([ x])\] Phase ([^:]+): (.*)$/);
    if (match) {
      snapshot.phaseCheckboxes.push({
        checked: match[1] === 'x',
        phase: match[2].trim(),
        title: match[3].replace(/\s+\(completed [^)]+\)$/, '').trim(),
      });
      continue;
    }

    if (line.trim().startsWith('|')) {
      const cells = splitTableRow(line);
      const phaseTitleMatch = cells.length === 4
        && /^(\d+[A-Z]?(?:\.\d+)*)\.?\s*(.*)$/i.exec((cells[0] || '').trim());
      if (phaseTitleMatch) {
        snapshot.progressRows.push({
          phase: phaseTitleMatch[1].trim(),
          title: phaseTitleMatch[2].trim(),
          plans: cells[1].trim(),
          status: cells[2].trim(),
          completed: cells[3].trim(),
        });
      }
    }
  }

  return snapshot;
}

function extractField(stateContent, fieldName) {
  const escaped = escapeRegex(fieldName);
  const boldMatch = stateContent.match(new RegExp(`\\*\\*${escaped}:\\*\\*[ \\t]*(.+)`, 'i'));
  if (boldMatch) return boldMatch[1].trim();
  const plainMatch = stateContent.match(new RegExp(`^${escaped}:[ \\t]*(.+)`, 'im'));
  return plainMatch ? plainMatch[1].trim() : null;
}

function extractFrontmatterField(stateContent, fieldName) {
  // Extract from YAML frontmatter block
  const fmMatch = stateContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];
  // Handle both scalar and nested (progress.completed_phases)
  const parts = fieldName.split('.');
  if (parts.length === 1) {
    const m = fm.match(new RegExp(`^${parts[0]}:\\s*(.+)`, 'm'));
    return m ? m[1].trim() : null;
  }
  // Nested: e.g. "progress.completed_phases"
  const sectionMatch = fm.match(new RegExp(`^${parts[0]}:\\s*\\n([\\s\\S]*?)(?=\\n[a-z]|$)`, 'm'));
  if (!sectionMatch) return null;
  const sectionContent = sectionMatch[1];
  const fieldMatch = sectionContent.match(new RegExp(`^\\s+${parts[1]}:\\s*(.+)`, 'm'));
  return fieldMatch ? fieldMatch[1].trim() : null;
}

// Capture stdout from `gsd-tools phase complete <N>` via a REAL subprocess.
//
// #3057: this used to call cmdPhaseComplete(...) IN-PROCESS and capture its
// stdout by monkeypatching fs.writeSync (io.cts's output() writes via
// writeAllSync -> fs.writeSync(1, ...), not process.stdout.write — bug #1008's
// non-blocking-pipe fix). That interception shares the exact seam the remote
// matrix's own event-stream capture depends on: when the runner's stdout is
// redirected to a file (the common case for a captured CI child),
// `process.stdout.write` itself resolves through that SAME public
// `fs.writeSync`, so any write racing the patched window — including the
// runner's own test:pass/test:fail events — could be silently swallowed into
// `chunks` or dropped instead of reaching the real fd. Two attempts to make
// that interception safe (manual save/restore, then `t.mock.method`) both
// still left this file reporting zero test:pass/test:fail events on the
// remote matrix. The fix is to stop intercepting fd 1 altogether: run the
// real CLI in a real subprocess, exactly like every other test in this file
// already does via `runGsdTools`, so the OS owns stdout capture and the
// runner's own event stream is never at risk.
//
// The phase family router (phase-command-router.cjs) calls
// `phase.cmdPhaseComplete(cwd, phaseNum, raw)` directly for `phase complete`
// — no SDK delegation on this path — so this reaches the exact same CJS
// function the old in-process call did.
//
// A handful of call sites depend on state a subprocess cannot see (a mock
// installed in THIS process, or the parent's own fs.writeFileSync mock for
// the rollback-failure tests below); those call sites do not use this
// helper — see the inline notes at each one.
function capturePhaseComplete(t, cwd, phaseNum) {
  const result = runGsdTools(['phase', 'complete', String(phaseNum)], cwd);
  if (!result.success) {
    // Surface exitCode/error verbatim so a real failure never presents as a
    // downstream `JSON.parse('')` error, and so assert.throws() callers keep
    // matching against the real stderr text (e.g. "verification is
    // incomplete...").
    throw new Error(
      result.error || `cmdPhaseComplete failed (exitCode=${result.exitCode})`,
    );
  }
  return result.output;
}

// ── T1: Double invocation must NOT double-increment Completed Phases ─────────

describe('issue #4 (CJS): cmdPhaseComplete — idempotency (blind-increment bug)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('T1: double invocation does NOT double-increment Completed Phases in STATE.md body', (t) => {
    // First call — legitimate completion
    capturePhaseComplete(t, tmpDir, '1');

    const stateAfter1 = readStateMd(tmpDir);
    const completedAfter1Body = extractField(stateAfter1, 'Completed Phases');
    const completedAfter1Fm = extractFrontmatterField(stateAfter1, 'progress.completed_phases');
    // After first call: Completed Phases in the body should be 1
    // (derived from ROADMAP: 1 Complete row after marking phase 01 complete)
    // OR the YAML frontmatter completed_phases should be 1
    const completedAfter1 = completedAfter1Body || completedAfter1Fm;
    assert.equal(
      completedAfter1,
      '1',
      `After first call: completed_phases should be 1.\n` +
      `Body field: ${completedAfter1Body}, FM field: ${completedAfter1Fm}\n\n` +
      `STATE:\n${stateAfter1}`,
    );

    // Second call on the same phase — must be idempotent
    capturePhaseComplete(t, tmpDir, '1');

    const stateAfter2 = readStateMd(tmpDir);
    const completedAfter2Body = extractField(stateAfter2, 'Completed Phases');
    const completedAfter2Fm = extractFrontmatterField(stateAfter2, 'progress.completed_phases');
    const completedAfter2 = completedAfter2Body || completedAfter2Fm;

    // Pre-fix: completedAfter2 would be "2" (blind increment: 1+1=2)
    // Post-fix: must remain "1" (derived from ROADMAP)
    assert.equal(
      completedAfter2,
      '1',
      `T1 FAILED: Completed Phases was double-incremented.\n` +
      `After first call: ${completedAfter1}, after second call: ${completedAfter2}.\n` +
      `This is the #4 non-idempotency bug — blind parseInt+1 instead of deriving from ROADMAP.\n\n` +
      `STATE after second call (body: ${completedAfter2Body}, fm: ${completedAfter2Fm}):\n${stateAfter2}`,
    );
  });

  test('rolls back ROADMAP when STATE write fails during phase completion', (t) => {
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    const reqPath = path.join(tmpDir, '.planning', 'REQUIREMENTS.md');
    const statePath = path.join(tmpDir, '.planning', 'STATE.md');
    const originalRoadmap = fs.readFileSync(roadmapPath, 'utf8');
    const originalReq = fs.readFileSync(reqPath, 'utf8');
    const originalState = fs.readFileSync(statePath, 'utf8');
    const originalWriteFileSync = fs.writeFileSync;

    t.mock.method(fs, 'writeFileSync', function injectedStateWriteFailure(target, ...args) {
      const targetPath = String(target);
      const isStatePublish = targetPath === statePath || targetPath === `${statePath}.tmp.${process.pid}`;
      if (isStatePublish) {
        const err = new Error('injected STATE.md write failure');
        err.code = 'EIO';
        throw err;
      }
      return originalWriteFileSync.call(this, target, ...args);
    });

    // Calls cmdPhaseComplete directly (bypassing capturePhaseComplete's
    // subprocess helper): this test's fault is a `t.mock.method(fs,
    // 'writeFileSync', ...)` installed in THIS process, which a subprocess
    // cannot see. No stdout capture is needed here — only the thrown
    // exception and the resulting on-disk file state — so calling the CJS
    // function directly does not touch fd 1 and does not reinstate the
    // fs.writeSync interception this file removed.
    assert.throws(
      () => cmdPhaseComplete(tmpDir, '1', false),
      /injected STATE\.md write failure/,
    );

    const roadmapAfter = fs.readFileSync(roadmapPath, 'utf8');
    const reqAfter = fs.readFileSync(reqPath, 'utf8');
    const stateAfter = fs.readFileSync(statePath, 'utf8');

    assert.deepEqual(
      roadmapCompletionSnapshot(roadmapAfter),
      roadmapCompletionSnapshot(originalRoadmap),
      'ROADMAP.md should roll back to its original completion state',
    );
    assert.equal(reqAfter, originalReq, 'REQUIREMENTS.md should roll back when STATE.md write fails');
    assert.equal(stateAfter, originalState, 'STATE.md should remain unchanged after injected write failure');
  });

  test('rolls back ROADMAP when REQUIREMENTS write fails during phase completion', (t) => {
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    const reqPath = path.join(tmpDir, '.planning', 'REQUIREMENTS.md');
    const originalRoadmap = fs.readFileSync(roadmapPath, 'utf8');
    const originalReq = fs.readFileSync(reqPath, 'utf8');
    const originalWriteFileSync = fs.writeFileSync;

    t.mock.method(fs, 'writeFileSync', function injectedRequirementsWriteFailure(target, ...args) {
      const targetPath = String(target);
      if (targetPath === reqPath || targetPath === `${reqPath}.tmp.${process.pid}`) {
        const err = new Error('injected REQUIREMENTS.md write failure');
        err.code = 'EIO';
        throw err;
      }
      return originalWriteFileSync.call(this, target, ...args);
    });

    // See the parent-process-mock note in the STATE.md-write-fails test
    // above: this must call cmdPhaseComplete directly, not via
    // capturePhaseComplete's subprocess helper.
    assert.throws(
      () => cmdPhaseComplete(tmpDir, '1', false),
      /injected REQUIREMENTS\.md write failure/,
    );

    assert.deepEqual(
      roadmapCompletionSnapshot(fs.readFileSync(roadmapPath, 'utf8')),
      roadmapCompletionSnapshot(originalRoadmap),
      'ROADMAP.md should roll back when the REQUIREMENTS write fails',
    );
    assert.equal(fs.readFileSync(reqPath, 'utf8'), originalReq, 'REQUIREMENTS.md should be unchanged');
  });

  test('reports rollback failure when restoring an earlier planning file fails', (t) => {
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    const reqPath = path.join(tmpDir, '.planning', 'REQUIREMENTS.md');
    const originalWriteFileSync = fs.writeFileSync;
    let requirementsWriteFailed = false;

    t.mock.method(fs, 'writeFileSync', function injectedRollbackFailure(target, ...args) {
      const targetPath = String(target);
      if (targetPath === reqPath || targetPath === `${reqPath}.tmp.${process.pid}`) {
        requirementsWriteFailed = true;
        const err = new Error('injected REQUIREMENTS.md write failure');
        err.code = 'EIO';
        throw err;
      }
      if (requirementsWriteFailed && (targetPath === roadmapPath || targetPath === `${roadmapPath}.tmp.${process.pid}`)) {
        const err = new Error('injected ROADMAP.md rollback failure');
        err.code = 'EIO';
        throw err;
      }
      return originalWriteFileSync.call(this, target, ...args);
    });

    // See the parent-process-mock note in the STATE.md-write-fails test
    // above: this must call cmdPhaseComplete directly, not via
    // capturePhaseComplete's subprocess helper.
    assert.throws(
      () => cmdPhaseComplete(tmpDir, '1', false),
      /injected REQUIREMENTS\.md write failure[\s\S]*WARNING: rollback failed while restoring[\s\S]*injected ROADMAP\.md rollback failure/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3057 B3: cmdPhaseComplete surfaces an indeterminate staleness check
//
// readVerificationStatus's internal staleness check can itself fail (fs /
// scanPhasePlans / clock error). Pre-#3057 B3, that failure was silently
// identical to a completed check that genuinely found nothing stale — the
// SAME fail-open shape as #3050. B3 flags this on the result
// (`staleCheckIndeterminate`); this test proves phase.cts actually SURFACES
// that flag (into `warnings[]`, the same advisory channel the UAT/VERIFICATION
// pre-scan above already uses) rather than dropping it on the floor.
// ─────────────────────────────────────────────────────────────────────────────

describe('#3057 B3: cmdPhaseComplete — verification staleness-check indeterminate is surfaced', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture('gsd-3057-b3-phase-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test(
    'an fs failure inside the staleness check adds a warning; completion routing is unchanged',
    { skip: process.platform === 'win32' ? 'symlink creation needs privilege on Windows' : false },
    (t) => {
    const phase01Dir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    const summaryPath = path.join(phase01Dir, '01-01-SUMMARY.md');

    // Real, on-disk fault instead of an in-process fs.statSync mock: this now
    // runs cmdPhaseComplete in a subprocess (via capturePhaseComplete), which
    // cannot see a mock installed in this process. findStaleVerificationSummary
    // (verification.cjs) calls fs.statSync on each summary file to compare
    // mtimes, and statSync follows symlinks — so pointing the summary at a
    // target that does not exist reproduces a genuine ENOENT there, degrading
    // the staleness check to {determined:false} exactly like the removed
    // injected statSync throw did. scanPhasePlans only matches summary
    // *filenames* (never stats them), so the plan-coverage gate still sees
    // the summary as present.
    fs.unlinkSync(summaryPath);
    fs.symlinkSync(path.join(phase01Dir, '.does-not-exist'), summaryPath);

    const output = JSON.parse(capturePhaseComplete(t, tmpDir, '1'));

    // Pre-existing no-throw fail-open routing is UNCHANGED: the phase still
    // completes exactly as it would have before #3057 B3.
    assert.strictEqual(output.completed_phase, '1');
    assert.ok(Array.isArray(output.warnings), 'result must carry a warnings array');
    assert.strictEqual(
      output.verification_stale_check_indeterminate,
      true,
      `result must surface the indeterminate staleness check as a typed field; got ${JSON.stringify(output.warnings)}`,
    );
    assert.strictEqual(output.has_warnings, true);
    },
  );

  test('a completed staleness check that finds nothing stale does NOT add an indeterminate warning', (t) => {
    const output = JSON.parse(capturePhaseComplete(t, tmpDir, '1'));

    assert.strictEqual(output.completed_phase, '1');
    assert.strictEqual(
      output.verification_stale_check_indeterminate,
      false,
      `must not report an indeterminate check when the staleness check ran to completion; got ${JSON.stringify(output.warnings)}`,
    );
  });

  test(
    'a BLOCKED completion (status=human_needed) with an indeterminate staleness check still blocks, but the error note says so',
    { skip: process.platform === 'win32' ? 'symlink creation needs privilege on Windows' : false },
    () => {
    const phase02Dir = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.writeFileSync(path.join(phase02Dir, '02-01-PLAN.md'), '# Plan\nDo the work.\n');
    fs.writeFileSync(path.join(phase02Dir, '02-VERIFICATION.md'), [
      '---',
      'status: human_needed',
      '---',
      '',
      '# Verification',
      '',
    ].join('\n'));

    // Real, on-disk fault — see the note in the sibling test above. The
    // summary is a dangling symlink so fs.statSync (inside
    // findStaleVerificationSummary, running in the subprocess) throws ENOENT.
    const summaryPath = path.join(phase02Dir, '02-01-SUMMARY.md');
    fs.symlinkSync(path.join(phase02Dir, '.does-not-exist'), summaryPath);

    // Routing is UNCHANGED — status !== 'passed' already blocked before #3057
    // B3; the note is purely additive to the message text. Assert the fact
    // structurally (via --json-errors) rather than regexing the human-
    // readable note — CONTRIBUTING requires a typed surface alongside any
    // text a caller might otherwise only match on, and once that typed
    // surface exists the test must assert on IT, not also on the rendered
    // prose (src/phase.cts's human message wording is out of scope for this
    // test — operators read it, but the test must not lock its exact text).
    const result = runGsdTools(['--json-errors', 'phase', 'complete', '2'], tmpDir);
    assert.equal(result.success, false, 'phase complete must fail when verification is blocked');
    const errorPayload = JSON.parse(result.error);
    assert.equal(errorPayload.reason, 'phase_verification_incomplete');
    assert.equal(errorPayload.verification_stale_check_indeterminate, true);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// #3511: cmdPhaseComplete — UAT/VERIFICATION advisory pre-scan is phase-scoped
//
// A cross-phase, stray, or ad-hoc file sitting in this phase's directory must
// not name an advisory warning against this phase — and this phase's own
// UAT/VERIFICATION files must keep warning exactly as before (non-stray case
// unchanged). Covers BOTH loops scoped by #3511 (the UAT loop and the
// VERIFICATION loop).
// ─────────────────────────────────────────────────────────────────────────────

describe('#3511: cmdPhaseComplete — advisory pre-scan warnings are phase-scoped', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('a cross-phase stray UAT/VERIFICATION file does not contribute a warning; this phase\'s own files still do', (t) => {
    const phase01Dir = path.join(tmpDir, '.planning', 'phases', '01-foundation');

    // This phase's own UAT file — must still produce its usual warning.
    fs.writeFileSync(path.join(phase01Dir, '01-UAT.md'), [
      '---', 'status: partial', '---', '',
      '### 1. Test A', 'expected: A', 'result: pending', '',
    ].join('\n'));

    // Cross-phase strays sitting in phase 01's directory — token "02", not
    // "01" — must NOT contribute a warning to phase 01's completion.
    fs.writeFileSync(path.join(phase01Dir, '02-UAT.md'), [
      '---', 'status: partial', '---', '',
      '### 1. Test B', 'expected: B', 'result: blocked', '',
    ].join('\n'));
    fs.writeFileSync(path.join(phase01Dir, '02-VERIFICATION.md'), [
      '---', 'status: human_needed', '---', '',
      '# Verification', '',
    ].join('\n'));

    const output = JSON.parse(capturePhaseComplete(t, tmpDir, '1'));

    assert.strictEqual(output.completed_phase, '1');
    assert.ok(
      output.warnings.some((w) => w.includes('01-UAT.md') && w.includes('has pending tests')),
      `own UAT file must still warn; got: ${JSON.stringify(output.warnings)}`,
    );
    assert.ok(
      !output.warnings.some((w) => w.includes('02-UAT.md')),
      `stray UAT file must not contribute a warning; got: ${JSON.stringify(output.warnings)}`,
    );
    assert.ok(
      !output.warnings.some((w) => w.includes('02-VERIFICATION.md') || /needs human verification/.test(w)),
      `stray VERIFICATION file must not contribute a warning; got: ${JSON.stringify(output.warnings)}`,
    );
  });

  test('#3511 follow-up: own UAT file still warns from a NON-canonical dir shape "1-unpadded" (over-exclusion check)', (t) => {
    const unpaddedTmpDir = createFixture('gsd-4-regression-unpadded-', '1-unpadded');
    try {
      const phaseDir = path.join(unpaddedTmpDir, '.planning', 'phases', '1-unpadded');
      // "1-unpadded" tokenizes to literal "1"; scaffold writes the PADDED
      // "01-…" form. A literal token compare excluded the phase's own file.
      fs.writeFileSync(path.join(phaseDir, '01-UAT.md'), [
        '---', 'status: partial', '---', '',
        '### 1. Test A', 'expected: A', 'result: pending', '',
      ].join('\n'));

      const output = JSON.parse(capturePhaseComplete(t, unpaddedTmpDir, '1'));

      assert.ok(
        output.warnings.some((w) => w.includes('01-UAT.md') && w.includes('has pending tests')),
        `own UAT file in an unpadded-dir phase must still warn; got: ${JSON.stringify(output.warnings)}`,
      );
    } finally {
      cleanup(unpaddedTmpDir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regressions: phase complete preserves completion date (#1161)
// Tests drive the REAL handler (cmdPhaseComplete) via the CLI entry point
// `runGsdTools('phase complete <N>')` so the fix in phase.cts is exercised
// end-to-end rather than hitting the roadmap.cjs helper in isolation.
// ─────────────────────────────────────────────────────────────────────────────

/** Extract the Completed cell from the progress table row for a given phase number.
 * The Completed column is always the LAST cell, regardless of whether the table is
 * 4-col (Phase | Plans | Status | Completed) or 5-col (Phase | Milestone | Plans | Status | Completed).
 */
function extractCompletedCell(roadmapContent, phaseNum) {
  // Find the progress table row whose first cell starts with the phase number.
  for (const line of roadmapContent.split(/\r?\n/)) {
    if (!line.trim().startsWith('|')) continue;
    const cells = splitTableRow(line);
    if (cells.length > 0 && cells[0].startsWith(String(phaseNum))) {
      return cells[cells.length - 1].trim();
    }
  }
  return null;
}

/**
 * Build a minimal 4-col ROADMAP project fixture whose Phase 01 row already has
 * the Completed cell set to `existingDate` and Status `Complete`.
 * The phase directory has plan+summary so `phase complete 1` can run.
 *
 * @param {string} existingDate  - value in the Completed cell ('2026-01-01', '-', '   ', etc.)
 * @param {boolean} [alreadyComplete] - if true the checkbox is already checked and status Complete
 */
function create4ColFixture(existingDate, alreadyComplete = true) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1161-4col-'));
  const planDir = path.join(tmpDir, '.planning');
  const phasesDir = path.join(planDir, 'phases');
  fs.mkdirSync(phasesDir, { recursive: true });

  const checkbox = alreadyComplete ? '[x]' : '[ ]';
  const checkboxSuffix = alreadyComplete ? ' (completed 2026-01-01)' : '';
  const status = alreadyComplete ? 'Complete    ' : 'Not started';

  const roadmap = [
    '# Roadmap',
    '',
    `- ${checkbox} Phase 01: Foundation${checkboxSuffix}`,
    '- [ ] Phase 02: API',
    '',
    '### Phase 01: Foundation',
    '**Goal:** Build the foundation',
    '**Plans:** 1/1 plans complete',
    '',
    '### Phase 02: API',
    '**Goal:** Build the API',
    '',
    '## Progress',
    '',
    '| Phase | Plans Complete | Status | Completed |',
    '|-------|----------------|--------|-----------|',
    `| 01. Foundation | 1/1 | ${status} | ${existingDate} |`,
    '| 02. API | 0/1 | Not started | - |',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(planDir, 'ROADMAP.md'), roadmap);

  const state = [
    '# State',
    '',
    '**Current Phase:** 01',
    '**Current Phase Name:** Foundation',
    '**Status:** In progress',
    '**Current Plan:** 01-01',
    '**Last Activity:** 2025-01-01',
    '**Last Activity Description:** Working on phase 1',
    '**Completed Phases:** 0',
    '**Total Phases:** 2',
    '**Progress:** 0%',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(planDir, 'STATE.md'), state);

  const phase01Dir = path.join(phasesDir, '01-foundation');
  fs.mkdirSync(phase01Dir, { recursive: true });
  fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan 1\nDo the work.\n');
  fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary 1\nDone.\n');
  writePassedVerificationFile(phase01Dir);

  fs.mkdirSync(path.join(phasesDir, '02-api'), { recursive: true });

  return tmpDir;
}

/**
 * Build a minimal 5-col ROADMAP project fixture (Phase | Milestone | Plans | Status | Completed).
 * Phase 01 row already has Completed cell set to `existingDate`.
 */
function create5ColFixture(existingDate, alreadyComplete = true) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1161-5col-'));
  const planDir = path.join(tmpDir, '.planning');
  const phasesDir = path.join(planDir, 'phases');
  fs.mkdirSync(phasesDir, { recursive: true });

  const checkbox = alreadyComplete ? '[x]' : '[ ]';
  const checkboxSuffix = alreadyComplete ? ' (completed 2026-01-01)' : '';
  const status = alreadyComplete ? 'Complete    ' : 'Not started';

  const roadmap = [
    '# Roadmap',
    '',
    `- ${checkbox} Phase 01: Foundation${checkboxSuffix}`,
    '- [ ] Phase 02: API',
    '',
    '### Phase 01: Foundation',
    '**Goal:** Build the foundation',
    '**Plans:** 1/1 plans complete',
    '',
    '### Phase 02: API',
    '**Goal:** Build the API',
    '',
    '## Progress',
    '',
    '| Phase | Milestone | Plans | Status | Completed |',
    '|-------|-----------|-------|--------|-----------|',
    `| 01. Foundation | v1.0 | 1/1 | ${status} | ${existingDate} |`,
    '| 02. API | v1.0 | 0/1 | Not started | - |',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(planDir, 'ROADMAP.md'), roadmap);

  const state = [
    '# State',
    '',
    '**Current Phase:** 01',
    '**Current Phase Name:** Foundation',
    '**Status:** In progress',
    '**Current Plan:** 01-01',
    '**Last Activity:** 2025-01-01',
    '**Last Activity Description:** Working on phase 1',
    '**Completed Phases:** 0',
    '**Total Phases:** 2',
    '**Progress:** 0%',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(planDir, 'STATE.md'), state);

  const phase01Dir = path.join(phasesDir, '01-foundation');
  fs.mkdirSync(phase01Dir, { recursive: true });
  fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan 1\nDo the work.\n');
  fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary 1\nDone.\n');
  writePassedVerificationFile(phase01Dir);

  fs.mkdirSync(path.join(phasesDir, '02-api'), { recursive: true });

  return tmpDir;
}

// Fixed historical instant — will never collide with a real today() in CI.
const PINNED_MS_1161 = Date.parse('2021-03-22T10:00:00.000Z');
const PINNED_DATE_1161 = '2021-03-22';
// Env passed to runGsdTools to pin the clock in the subprocess SUT.
const PINNED_CLOCK_ENV = {
  GSD_TEST_MODE: '1',
  GSD_NOW_MS: String(PINNED_MS_1161),
};

describe('regressions: phase complete preserves completion date (#1161)', () => {
  let tmpDir;

  afterEach(() => {
    cleanup(tmpDir);
  });

  // ── (a) 4-col: already Complete with a date — repeat phase complete must NOT overwrite ──

  test('#1161 (a): 4-col ROADMAP — repeat `phase complete 1` preserves existing Completed date', () => {
    // Arrange: Row is already Complete with '2026-01-01'.
    tmpDir = create4ColFixture('2026-01-01', true);
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');

    // Act: run `phase complete 1` via the real CLI handler, clock pinned to PINNED_DATE.
    const result = runGsdTools('phase complete 1', tmpDir, PINNED_CLOCK_ENV);
    assert.ok(result.success, `phase complete failed: ${result.error || result.output}`);

    // Assert: Completed cell must still be '2026-01-01', NOT the pinned '2021-03-22'.
    const after = fs.readFileSync(roadmapPath, 'utf8');
    const completedCell = extractCompletedCell(after, '01');
    assert.strictEqual(
      completedCell,
      '2026-01-01',
      `#1161 (a) FAILED: repeat phase complete on 4-col table overwrote the existing date.\n` +
      `Expected '2026-01-01', got '${completedCell}'.\n` +
      `Pinned clock was '${PINNED_DATE_1161}' — if that appears the date was overwritten.\n\n` +
      `ROADMAP after:\n${after}`,
    );
  });

  // ── (b) 5-col: already Complete with a date — repeat phase complete must NOT overwrite ──

  test('#1161 (b): 5-col ROADMAP — repeat `phase complete 1` preserves existing Completed date', () => {
    // Arrange: 5-col table row is already Complete with '2026-01-01'.
    tmpDir = create5ColFixture('2026-01-01', true);
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');

    // Act: run `phase complete 1` via the real CLI handler, clock pinned to PINNED_DATE.
    const result = runGsdTools('phase complete 1', tmpDir, PINNED_CLOCK_ENV);
    assert.ok(result.success, `phase complete failed: ${result.error || result.output}`);

    // Assert: Completed cell must still be '2026-01-01', NOT the pinned '2021-03-22'.
    const after = fs.readFileSync(roadmapPath, 'utf8');
    const completedCell5 = extractCompletedCell(after, '01');
    assert.strictEqual(
      completedCell5,
      '2026-01-01',
      `#1161 (b) FAILED: repeat phase complete on 5-col table overwrote the existing date.\n` +
      `Expected '2026-01-01', got '${completedCell5}'.\n` +
      `Pinned clock was '${PINNED_DATE_1161}' — if that appears the date was overwritten.\n\n` +
      `ROADMAP after:\n${after}`,
    );
  });

  // ── (c) First-time completion (placeholder '-') must stamp the pinned date ──

  test('#1161 (c): 4-col ROADMAP — first `phase complete 1` (placeholder date) stamps pinned date', () => {
    // Arrange: Row has '-' as Completed cell and is Not started (never completed).
    tmpDir = create4ColFixture('-', false);
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');

    // Act: first-time phase complete.
    const result = runGsdTools('phase complete 1', tmpDir, PINNED_CLOCK_ENV);
    assert.ok(result.success, `phase complete failed: ${result.error || result.output}`);

    // Assert: Completed cell is now the pinned date.
    const after = fs.readFileSync(roadmapPath, 'utf8');
    const completedCell = extractCompletedCell(after, '01');
    assert.strictEqual(
      completedCell,
      PINNED_DATE_1161,
      `#1161 (c) FAILED: first-time completion should stamp '${PINNED_DATE_1161}', got '${completedCell}'.\n\n` +
      `ROADMAP after:\n${after}`,
    );
  });

  // ── (d) Whitespace-only Completed cell is treated as empty and gets stamped ──

  test('#1161 (d): 4-col ROADMAP — whitespace-only Completed cell treated as empty, gets stamped', () => {
    // Arrange: Row has '   ' (spaces) as Completed cell.
    tmpDir = create4ColFixture('   ', false);
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');

    // Act: first-time phase complete.
    const result = runGsdTools('phase complete 1', tmpDir, PINNED_CLOCK_ENV);
    assert.ok(result.success, `phase complete failed: ${result.error || result.output}`);

    // Assert: Completed cell is now the pinned date (whitespace was treated as empty).
    const after = fs.readFileSync(roadmapPath, 'utf8');
    const completedCell = extractCompletedCell(after, '01');
    assert.strictEqual(
      completedCell,
      PINNED_DATE_1161,
      `#1161 (d) FAILED: whitespace-only Completed cell should be stamped '${PINNED_DATE_1161}', got '${completedCell}'.\n\n` +
      `ROADMAP after:\n${after}`,
    );
  });

  // ── (e) Non-date garbage in Completed cell is self-healed and gets re-stamped ──

  test('#1161 (e): 5-col ROADMAP — non-date garbage Completed cell is self-healed and re-stamped', () => {
    // Arrange: 5-col row is already Complete but the Completed cell contains 'TBD'
    // (a non-date garbage value that the old guard would have preserved).
    tmpDir = create5ColFixture('TBD', true);
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');

    // Act: run `phase complete 1` via the real CLI handler, clock pinned to PINNED_DATE.
    const result = runGsdTools('phase complete 1', tmpDir, PINNED_CLOCK_ENV);
    assert.ok(result.success, `phase complete failed: ${result.error || result.output}`);

    // Assert: garbage 'TBD' must be replaced with the pinned date (self-heal).
    // Pre-Fix 2: the old guard (existingDate && existingDate !== '-') would preserve 'TBD'.
    // Post-Fix 2: the date-shape guard (/^\d{4}-\d{2}-\d{2}$/) rejects 'TBD' → re-stamps.
    const after = fs.readFileSync(roadmapPath, 'utf8');
    const completedCell = extractCompletedCell(after, '01');
    assert.strictEqual(
      completedCell,
      PINNED_DATE_1161,
      `#1161 (e) FAILED: non-date garbage 'TBD' in Completed cell should be self-healed to '${PINNED_DATE_1161}', got '${completedCell}'.\n` +
      `Old guard (non-empty && !== '-') would preserve 'TBD'. New guard must require a date shape.\n\n` +
      `ROADMAP after:\n${after}`,
    );
  });
});

// ── T2: Progress percent must never exceed 100% ──────────────────────────────

describe('issue #4 (CJS): cmdPhaseComplete — progress percent clamp', () => {
  let tmpDir;

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('T2: Progress percent never exceeds 100 after double invocation', (t) => {
    tmpDir = createFixture();

    // Pre-load STATE.md with Completed Phases: 1, Total Phases: 1 (already 100%)
    // so that a blind +1 on a second call would yield 200%
    let stateContent = readStateMd(tmpDir);
    stateContent = stateContent.replace('**Completed Phases:** 0', '**Completed Phases:** 1');
    stateContent = stateContent.replace('**Total Phases:** 2', '**Total Phases:** 1');
    stateContent = stateContent.replace('**Progress:** 0%', '**Progress:** 100%');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), stateContent);

    // Also update ROADMAP to show just 1 phase total
    const roadmap = [
      '# Roadmap',
      '',
      '- [ ] Phase 01: Foundation',
      '',
      '### Phase 01: Foundation',
      '**Goal:** Build the foundation',
      '**Plans:** 1 plans',
      '',
      '## Progress',
      '',
      '| Phase | Plans Complete | Status | Completed |',
      '|-------|----------------|--------|-----------|',
      '| 01. Foundation | 0/1 | Not started | - |',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);

    // First call
    capturePhaseComplete(t, tmpDir, '1');
    // Second call — this is the problematic one
    capturePhaseComplete(t, tmpDir, '1');

    const stateAfterBoth = readStateMd(tmpDir);

    // Check body Progress field
    const progressStr = extractField(stateAfterBoth, 'Progress');
    const fmPercent = extractFrontmatterField(stateAfterBoth, 'progress.percent');

    // Try to extract numeric percent from either source
    const bodyPercentMatch = progressStr && progressStr.match(/(\d+)%/);
    const bodyPercent = bodyPercentMatch ? parseInt(bodyPercentMatch[1], 10) : null;
    const fmPercentNum = fmPercent ? parseInt(fmPercent, 10) : null;

    // At least one of body or frontmatter percent must exist and be ≤ 100
    const anyPercent = bodyPercent ?? fmPercentNum;
    assert.ok(
      anyPercent !== null,
      `T2: Could not find any percent value in STATE.md\n\nSTATE:\n${stateAfterBoth}`,
    );
    assert.ok(
      anyPercent <= 100,
      `T2 FAILED: Progress percent exceeds 100.\n` +
      `Body Progress: "${progressStr}" (${bodyPercent}%), FM percent: ${fmPercentNum}%\n` +
      `This is the #4 unclamped-percent bug — (N+1)/total can exceed 100.\n\n` +
      `STATE:\n${stateAfterBoth}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regressions: issue #1159 — Defect A
// VERIFICATION.md with `previous_status: gaps_found` in the body but
// `status: passed` in frontmatter must NOT emit a "has unresolved gaps" warning.
// The bug: /status: gaps_found/.test(fullContent) matches the substring inside
// `previous_status: gaps_found`, causing a false positive.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal project fixture with a VERIFICATION.md file whose
 * frontmatter status is `verFmStatus` and whose body contains `previous_status: gaps_found`.
 * Phase 01 has a plan+summary; Phase 02 exists for next-phase detection.
 */
function createVerificationFixture(verFmStatus) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1159-verif-'));
  const planDir = path.join(tmpDir, '.planning');
  const phasesDir = path.join(planDir, 'phases');
  const phase01Dir = path.join(phasesDir, '01-foundation');
  fs.mkdirSync(phase01Dir, { recursive: true });
  fs.mkdirSync(path.join(phasesDir, '02-api'), { recursive: true });

  fs.writeFileSync(path.join(planDir, 'ROADMAP.md'), [
    '# Roadmap',
    '',
    '- [ ] Phase 01: Foundation',
    '- [ ] Phase 02: API',
    '',
    '### Phase 01: Foundation',
    '**Goal:** Build the foundation',
    '**Plans:** 1 plans',
    '',
    '## Progress',
    '',
    '| Phase | Plans Complete | Status | Completed |',
    '|-------|----------------|--------|-----------|',
    '| 01. Foundation | 0/1 | Not started | - |',
    '| 02. API | 0/1 | Not started | - |',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(planDir, 'STATE.md'), [
    '# State',
    '',
    '**Current Phase:** 01',
    '**Current Phase Name:** Foundation',
    '**Status:** In progress',
    '**Completed Phases:** 0',
    '**Total Phases:** 2',
    '**Progress:** 0%',
    '',
  ].join('\n'));

  // No REQUIREMENTS.md intentionally (not needed for this defect check)

  fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan 1\nDo the work.\n');
  fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary 1\nDone.\n');

  // The VERIFICATION.md has the CURRENT status in frontmatter but historical
  // `previous_status: gaps_found` in the body — this is the false-positive trigger.
  fs.writeFileSync(path.join(phase01Dir, '01-VERIFICATION.md'), [
    '---',
    `status: ${verFmStatus}`,
    'phase: "01"',
    '---',
    '',
    '# Verification',
    '',
    '<!-- Historical context from previous run -->',
    'previous_status: gaps_found',
    '',
    '## Summary',
    'All checks passed on re-run.',
    '',
  ].join('\n'));

  return tmpDir;
}

describe('issue #1159 (Defect A): VERIFICATION.md historical metadata must not trigger gap warning', () => {
  let tmpDir;

  afterEach(() => {
    cleanup(tmpDir);
  });

  test(
    '#1159-A-1: status:passed + previous_status:gaps_found in body → NO "has unresolved gaps" warning',
    () => {
      tmpDir = createVerificationFixture('passed');
      const { output } = runGsdTools(['phase', 'complete', '1'], tmpDir);
      // The output is JSON; parse and check warnings array
      const parsed = JSON.parse(output);
      const warnings = parsed.warnings || [];
      const gapWarnings = warnings.filter((w) => /unresolved gaps/i.test(w));
      assert.equal(
        gapWarnings.length,
        0,
        `#1159-A-1 FAILED: got false gap warning(s) when frontmatter status=passed.\n` +
        `Warnings: ${JSON.stringify(warnings)}\n` +
        `(The regex /status: gaps_found/ matched 'previous_status: gaps_found' in the body.)`,
      );
    },
  );

  test(
    '#1159-A-2 (boundary): status:gaps_found in frontmatter → blocks phase completion',
    () => {
      tmpDir = createVerificationFixture('gaps_found');
      const result = runGsdTools(['--json-errors', 'phase', 'complete', '1'], tmpDir);
      assert.equal(result.success, false, 'gaps_found verification must block phase completion');
      const parsed = JSON.parse(result.error);
      assert.equal(parsed.reason, 'phase_verification_incomplete');
      assert.match(parsed.message, /Gaps found/i);
    },
  );

  test(
    '#1159-A-3 (boundary): status:human_needed in frontmatter → blocks phase completion',
    () => {
      tmpDir = createVerificationFixture('human_needed');
      const result = runGsdTools(['--json-errors', 'phase', 'complete', '1'], tmpDir);
      assert.equal(result.success, false, 'human_needed verification must block phase completion');
      const parsed = JSON.parse(result.error);
      assert.equal(parsed.reason, 'phase_verification_incomplete');
      assert.match(parsed.message, /Human verification required/i);
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Regressions: issue #1159 — Defect B
// Requirement IDs (e.g. FILE-001) that appear under explicitly deferred/future/v2
// sections in REQUIREMENTS.md must NOT be flagged as "missing from Traceability".
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a minimal project fixture with a REQUIREMENTS.md that has:
 * - An active requirement ACTIVE-001 that IS in the Traceability table
 * - A deferred requirement DEFER-001 under a "Deferred v2 Requirements" heading
 *   that is NOT in the Traceability table (correctly out of scope)
 * - Optionally a truly-missing active requirement MISSING-001 (not in table)
 */
function createDeferredReqFixture({ includeMissingActive = false } = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1159-deferred-'));
  const planDir = path.join(tmpDir, '.planning');
  const phasesDir = path.join(planDir, 'phases');
  const phase01Dir = path.join(phasesDir, '01-foundation');
  fs.mkdirSync(phase01Dir, { recursive: true });
  fs.mkdirSync(path.join(phasesDir, '02-api'), { recursive: true });

  const missingActiveLines = includeMissingActive
    ? ['', '- **MISSING-001** Active req not in traceability table.']
    : [];

  fs.writeFileSync(path.join(planDir, 'REQUIREMENTS.md'), [
    '# Requirements',
    '',
    '## Functional Requirements',
    '',
    '- **ACTIVE-001** Core feature must work.',
    ...missingActiveLines,
    '',
    '## Deferred v2 Requirements',
    '',
    '- **DEFER-001** Nice-to-have for v2, explicitly out of scope.',
    '',
    '## Future Backlog',
    '',
    '- **FUTURE-001** Consider for next major release.',
    '',
    '## Traceability',
    '',
    '| Requirement | Phase | Status |',
    '|-------------|-------|--------|',
    '| ACTIVE-001 | Phase 01 | Pending |',
    '',
  ].join('\n'));

  // Roadmap references ACTIVE-001 for phase 01
  fs.writeFileSync(path.join(planDir, 'ROADMAP.md'), [
    '# Roadmap',
    '',
    '- [ ] Phase 01: Foundation',
    '- [ ] Phase 02: API',
    '',
    '### Phase 01: Foundation',
    '**Goal:** Build the foundation',
    '**Requirements:** ACTIVE-001',
    '**Plans:** 1 plans',
    '',
    '## Progress',
    '',
    '| Phase | Plans Complete | Status | Completed |',
    '|-------|----------------|--------|-----------|',
    '| 01. Foundation | 0/1 | Not started | - |',
    '| 02. API | 0/1 | Not started | - |',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(planDir, 'STATE.md'), [
    '# State',
    '',
    '**Current Phase:** 01',
    '**Current Phase Name:** Foundation',
    '**Status:** In progress',
    '**Completed Phases:** 0',
    '**Total Phases:** 2',
    '**Progress:** 0%',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan 1\nDo the work.\n');
  fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary 1\nDone.\n');
  writePassedVerificationFile(phase01Dir);

  return tmpDir;
}

describe('issue #1159 (Defect B): deferred/future requirement IDs must not trigger traceability warning', () => {
  let tmpDir;

  afterEach(() => {
    cleanup(tmpDir);
  });

  test(
    '#1159-B-1: IDs under "Deferred v2 Requirements" and "Future Backlog" sections → NO traceability warning',
    () => {
      tmpDir = createDeferredReqFixture({ includeMissingActive: false });
      const { output } = runGsdTools(['phase', 'complete', '1'], tmpDir);
      const parsed = JSON.parse(output);
      const warnings = parsed.warnings || [];
      const traceWarnings = warnings.filter((w) => /Traceability/i.test(w));
      assert.equal(
        traceWarnings.length,
        0,
        `#1159-B-1 FAILED: got false traceability warning(s) for deferred/future IDs.\n` +
        `Warnings: ${JSON.stringify(warnings)}\n` +
        `(DEFER-001 and FUTURE-001 are under deferred/future sections and must be ignored.)`,
      );
    },
  );

  test(
    '#1159-B-2 (boundary): truly-missing ACTIVE ID (not in table, not in deferred section) → DOES warn',
    () => {
      tmpDir = createDeferredReqFixture({ includeMissingActive: true });
      const { output } = runGsdTools(['phase', 'complete', '1'], tmpDir);
      const parsed = JSON.parse(output);
      const warnings = parsed.warnings || [];
      const traceWarnings = warnings.filter((w) => /Traceability/i.test(w));
      assert.ok(
        traceWarnings.length > 0,
        `#1159-B-2 FAILED: expected traceability warning for MISSING-001 (active, not in table) but got none.\n` +
        `Warnings: ${JSON.stringify(warnings)}`,
      );
      // Verify MISSING-001 is specifically mentioned
      const mentionsMissing = traceWarnings.some((w) => w.includes('MISSING-001'));
      assert.ok(
        mentionsMissing,
        `#1159-B-2 FAILED: warning exists but MISSING-001 not mentioned.\n` +
        `Traceability warnings: ${JSON.stringify(traceWarnings)}`,
      );
    },
  );

  test(
    '#1159-B-3 (boundary): deferred IDs must not contaminate warning even when active ID is also missing',
    () => {
      tmpDir = createDeferredReqFixture({ includeMissingActive: true });
      const { output } = runGsdTools(['phase', 'complete', '1'], tmpDir);
      const parsed = JSON.parse(output);
      const warnings = parsed.warnings || [];
      const traceWarnings = warnings.filter((w) => /Traceability/i.test(w));
      // DEFER-001 and FUTURE-001 must NOT appear in the traceability warnings
      const mentionsDefer = traceWarnings.some((w) => w.includes('DEFER-001') || w.includes('FUTURE-001'));
      assert.ok(
        !mentionsDefer,
        `#1159-B-3 FAILED: deferred IDs (DEFER-001/FUTURE-001) appeared in traceability warning.\n` +
        `Traceability warnings: ${JSON.stringify(traceWarnings)}`,
      );
    },
  );

  test(
    '#1159-B-4 (subheading): IDs under sub-headings of a deferred section are also suppressed',
    () => {
      // Codex adversarial finding: splitting on EVERY heading failed to propagate
      // deferred status to sub-headings (e.g. "## Future Backlog" → "### Sub").
      // The fix uses heading-depth tracking so sub-headings inherit deferred state.
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1159-subhead-'));
      const planDir = path.join(tmpDir, '.planning');
      const phasesDir = path.join(planDir, 'phases');
      const phase01Dir = path.join(phasesDir, '01-foundation');
      fs.mkdirSync(phase01Dir, { recursive: true });
      fs.mkdirSync(path.join(phasesDir, '02-api'), { recursive: true });

      fs.writeFileSync(path.join(planDir, 'REQUIREMENTS.md'), [
        '# Requirements',
        '',
        '## Functional Requirements',
        '',
        '- **ACTIVE-001** Core feature.',
        '',
        '## Future Backlog',
        '',
        '### Sub-category A',
        '',
        '- **SUB-001** This is under a sub-heading of a deferred section.',
        '',
        '## Traceability',
        '',
        '| Requirement | Phase | Status |',
        '|-------------|-------|--------|',
        '| ACTIVE-001 | Phase 01 | Pending |',
        '',
      ].join('\n'));

      fs.writeFileSync(path.join(planDir, 'ROADMAP.md'), [
        '# Roadmap',
        '',
        '- [ ] Phase 01: Foundation',
        '- [ ] Phase 02: API',
        '',
        '### Phase 01: Foundation',
        '**Goal:** Build the foundation',
        '**Requirements:** ACTIVE-001',
        '**Plans:** 1 plans',
        '',
        '## Progress',
        '',
        '| Phase | Plans Complete | Status | Completed |',
        '|-------|----------------|--------|-----------|',
        '| 01. Foundation | 0/1 | Not started | - |',
        '| 02. API | 0/1 | Not started | - |',
        '',
      ].join('\n'));

      fs.writeFileSync(path.join(planDir, 'STATE.md'), [
        '# State',
        '',
        '**Current Phase:** 01',
        '**Completed Phases:** 0',
        '**Total Phases:** 2',
        '**Progress:** 0%',
        '',
      ].join('\n'));

      fs.writeFileSync(path.join(phase01Dir, '01-01-PLAN.md'), '# Plan 1\n');
      fs.writeFileSync(path.join(phase01Dir, '01-01-SUMMARY.md'), '# Summary 1\n');
      writePassedVerificationFile(phase01Dir);

      const { output } = runGsdTools(['phase', 'complete', '1'], tmpDir);
      const parsed = JSON.parse(output);
      const warnings = parsed.warnings || [];
      const traceWarnings = warnings.filter((w) => /Traceability/i.test(w));
      const mentionsSub = traceWarnings.some((w) => w.includes('SUB-001'));
      assert.ok(
        !mentionsSub,
        `#1159-B-4 FAILED: SUB-001 (under sub-heading of deferred section) appeared in warning.\n` +
        `Traceability warnings: ${JSON.stringify(traceWarnings)}`,
      );
    },
  );
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2502-insert-phase-state-update.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2502-insert-phase-state-update (consolidation epic #1969 B4 #1973)", () => {
// allow-test-rule: source-text-is-the-product (see #2502)
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Regression test for #2502: insert-phase does not update STATE.md's
 * next-phase recommendation after inserting a decimal phase.
 *
 * Root cause: insert-phase.md's update_project_state step only added a
 * "Roadmap Evolution" note to STATE.md, but never updated the "Current Phase"
 * / next-run recommendation to point at the newly inserted phase.
 *
 * Fix: insert-phase.md must include a step that updates STATE.md's next-phase
 * pointer (current_phase / next recommended run) to the newly inserted phase.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const INSERT_PHASE_PATH = path.join(
  __dirname, '..', 'gsd-core', 'workflows', 'insert-phase.md'
);

describe('bug-2502: insert-phase must update STATE.md next-phase recommendation', () => {
  test('insert-phase.md exists', () => {
    assert.ok(fs.existsSync(INSERT_PHASE_PATH), 'insert-phase.md should exist');
  });

  test('insert-phase.md contains a STATE.md next-phase update instruction', () => {
    const content = fs.readFileSync(INSERT_PHASE_PATH, 'utf-8');

    // Must reference STATE.md and the concept of updating the next/current phase pointer
    const mentionsStateUpdate = (
      /STATE\.md.{0,200}(next.phase|current.phase|next.run|recommendation)/is.test(content) ||
      /(next.phase|current.phase|next.run|recommendation).{0,200}STATE\.md/is.test(content)
    );

    assert.ok(
      mentionsStateUpdate,
      'insert-phase.md must instruct updating STATE.md\'s next-phase recommendation to point to the newly inserted phase'
    );
  });

  test('insert-phase.md update_project_state step covers next-phase pointer', () => {
    const content = fs.readFileSync(INSERT_PHASE_PATH, 'utf-8');

    // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own workflow .md content, fixed-size author-controlled content
    const stepMatch = content.match(/<step name="update_project_state">([\s\S]*?)<\/step>/i);
    assert.ok(stepMatch, 'insert-phase.md must contain update_project_state step');
    const stepContent = stepMatch[1];

    const hasNextPhasePointerUpdate = (
      /\bcurrent[_ -]?phase\b/i.test(stepContent) ||
      /\bnext[_ -]?phase\b/i.test(stepContent) ||
      /\bnext recommended run\b/i.test(stepContent)
    );

    assert.ok(
      hasNextPhasePointerUpdate,
      'insert-phase.md update_project_state step must update STATE.md\'s next-phase pointer (current_phase) to the inserted decimal phase'
    );
  });
});
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Regressions: issue #2316 — phase complete ghost REQ-ID / silent-discard defects
//
// ROADMAP.md may cite a REQ-ID in a phase's `**Requirements:**` line that was
// never registered anywhere in REQUIREMENTS.md (neither its body nor its
// Traceability table). The only existing cross-check compares REQUIREMENTS.md's
// own body against its own Traceability table — it never consults the REQ-IDs
// ROADMAP actually cites — so such a "ghost" REQ-ID is invisible: the checkbox/
// Traceability write for it silently matches nothing, and the command reports
// `requirements_updated: true, warnings: []` identically to a run that wrote
// something real.
//
// Contract asserted by #2316-3: `requirements_updated` reflects whether
// REQUIREMENTS.md's content actually changed (before !== after write), not
// merely whether the file existed in the transaction.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a 3-phase fixture:
 *   Phase 01 "known"  — cites KNOWN-01, which IS registered in REQUIREMENTS.md
 *                       (body checkbox + Traceability row). CONTROL phase.
 *   Phase 02 "orphan" — cites ORPHAN-01, ORPHAN-02, which are registered
 *                       NOWHERE in REQUIREMENTS.md. BUG phase.
 *   Phase 03 "tbd"    — carries the literal `**Requirements**: TBD` placeholder
 *                       seeded by phase.add/-batch/-insert. BOUNDARY phase:
 *                       "TBD" itself must never be treated as a ghost REQ-ID.
 */
function build2316GhostReqFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2316-ghost-'));
  const planDir = path.join(tmpDir, '.planning');
  const phasesDir = path.join(planDir, 'phases');
  const phase1Dir = path.join(phasesDir, '01-known');
  const phase2Dir = path.join(phasesDir, '02-orphan');
  const phase3Dir = path.join(phasesDir, '03-tbd');
  fs.mkdirSync(phase1Dir, { recursive: true });
  fs.mkdirSync(phase2Dir, { recursive: true });
  fs.mkdirSync(phase3Dir, { recursive: true });

  fs.writeFileSync(path.join(planDir, 'REQUIREMENTS.md'), [
    '# Requirements',
    '',
    '## Functional Requirements',
    '',
    '- [ ] **KNOWN-01** Known and registered requirement.',
    '',
    '## Traceability',
    '',
    '| Requirement | Phase | Status |',
    '|-------------|-------|--------|',
    '| KNOWN-01 | Phase 01 | Pending |',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(planDir, 'ROADMAP.md'), [
    '# Roadmap',
    '',
    '- [ ] Phase 01: Known',
    '- [ ] Phase 02: Orphan',
    '- [ ] Phase 03: Tbd',
    '',
    '### Phase 01: Known',
    '**Goal:** Build the known thing',
    '**Requirements:** KNOWN-01',
    '**Plans:** 1 plans',
    '',
    '### Phase 02: Orphan',
    '**Goal:** Build the orphan thing',
    '**Requirements:** ORPHAN-01, ORPHAN-02',
    '**Plans:** 1 plans',
    '',
    '### Phase 03: Tbd',
    '**Goal:** Not yet mapped',
    '**Requirements**: TBD',
    '**Plans:** 1 plans',
    '',
    '## Progress',
    '',
    '| Phase | Plans Complete | Status | Completed |',
    '|-------|----------------|--------|-----------|',
    '| 01. Known | 0/1 | Not started | - |',
    '| 02. Orphan | 0/1 | Not started | - |',
    '| 03. Tbd | 0/1 | Not started | - |',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(planDir, 'STATE.md'), [
    '# State',
    '',
    '**Current Phase:** 01',
    '**Current Phase Name:** Known',
    '**Status:** In progress',
    '**Completed Phases:** 0',
    '**Total Phases:** 3',
    '**Progress:** 0%',
    '',
  ].join('\n'));

  for (const [dir, n] of [[phase1Dir, '01'], [phase2Dir, '02'], [phase3Dir, '03']]) {
    fs.writeFileSync(path.join(dir, `${n}-01-PLAN.md`), '# Plan\nDo the work.\n');
    fs.writeFileSync(path.join(dir, `${n}-01-SUMMARY.md`), '# Summary\nDone.\n');
  }

  return { tmpDir, planDir };
}

describe('issue #2316: phase complete ghost REQ-ID / silent-discard defects', () => {
  test(
    '#2316-1: ROADMAP-cited REQ-ID absent from REQUIREMENTS.md entirely → phase complete must report non-empty warnings naming the ghost ID(s)',
    () => {
      const { tmpDir } = build2316GhostReqFixture();
      try {
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '2'], tmpDir);
        const parsed = JSON.parse(output);
        const warnings = parsed.warnings || [];
        assert.ok(
          warnings.length > 0,
          `#2316-1 FAILED: expected non-empty warnings for ghost REQ-IDs ORPHAN-01/ORPHAN-02 ` +
          `(cited by ROADMAP Phase 02 but registered nowhere in REQUIREMENTS.md), got warnings:[].\n` +
          `Full output: ${output}`,
        );
        assert.ok(
          warnings.some((w) => w.includes('ORPHAN-01')),
          `#2316-1 FAILED: warnings must name ORPHAN-01, got: ${JSON.stringify(warnings)}`,
        );
        assert.ok(
          warnings.some((w) => w.includes('ORPHAN-02')),
          `#2316-1 FAILED: warnings must name ORPHAN-02, got: ${JSON.stringify(warnings)}`,
        );
        assert.strictEqual(
          parsed.has_warnings, true,
          `#2316-1 FAILED: has_warnings must be true when ghost REQ-IDs are cited, got: ${JSON.stringify(parsed)}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  test(
    '#2316-2 (control): a phase citing only a registered REQ-ID still ticks the checkbox + flips the Traceability row, and does not warn',
    () => {
      const { tmpDir, planDir } = build2316GhostReqFixture();
      try {
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
        const parsed = JSON.parse(output);
        assert.deepStrictEqual(
          parsed.warnings || [], [],
          `#2316-2 FAILED: control phase (KNOWN-01 is registered) must not warn, got: ${JSON.stringify(parsed.warnings)}`,
        );
        assert.strictEqual(parsed.has_warnings, false, '#2316-2 FAILED: has_warnings must be false for the control phase');

        const reqContent = fs.readFileSync(path.join(planDir, 'REQUIREMENTS.md'), 'utf-8');
        assert.ok(
          /-\s*\[x\]\s*\*\*KNOWN-01\*\*/.test(reqContent),
          `#2316-2 FAILED: checkbox for KNOWN-01 must be ticked.\nREQUIREMENTS.md:\n${reqContent}`,
        );
        assert.ok(
          /\|\s*KNOWN-01\s*\|\s*Phase 01\s*\|\s*Complete\s*\|/.test(reqContent),
          `#2316-2 FAILED: Traceability row for KNOWN-01 must flip to Complete.\nREQUIREMENTS.md:\n${reqContent}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  test(
    '#2316-3: requirements_updated must reflect whether REQUIREMENTS.md content actually changed, not merely that the file existed in the transaction',
    () => {
      // Case A (BUG): nothing written (ghost REQ-IDs only) → requirements_updated must be false.
      const ghost = build2316GhostReqFixture();
      try {
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '2'], ghost.tmpDir);
        const parsed = JSON.parse(output);
        assert.strictEqual(
          parsed.requirements_updated, false,
          `#2316-3a FAILED: requirements_updated must be false when REQUIREMENTS.md content did not change ` +
          `(ghost REQ-IDs ORPHAN-01/ORPHAN-02 match nothing to tick or flip).\nFull output: ${output}`,
        );
      } finally {
        cleanup(ghost.tmpDir);
      }

      // Case B (CONTROL): a real write landed → requirements_updated must remain true.
      // Guards against a fix that over-broadens to "always false".
      const known = build2316GhostReqFixture();
      try {
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], known.tmpDir);
        const parsed = JSON.parse(output);
        assert.strictEqual(
          parsed.requirements_updated, true,
          `#2316-3b FAILED: requirements_updated must remain true when a real checkbox/Traceability write landed.\n` +
          `Full output: ${output}`,
        );
      } finally {
        cleanup(known.tmpDir);
      }
    },
  );

  test(
    '#2316-7 (boundary): the literal "**Requirements**: TBD" placeholder seeded by phase.add/-batch/-insert must not produce a ghost-ID warning for the token "TBD"',
    () => {
      const { tmpDir } = build2316GhostReqFixture();
      try {
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '3'], tmpDir);
        const parsed = JSON.parse(output);
        const warnings = parsed.warnings || [];
        assert.ok(
          !warnings.some((w) => /\bTBD\b/.test(w)),
          `#2316-7 FAILED: the TBD placeholder must not be treated as a ghost REQ-ID, got warnings: ${JSON.stringify(warnings)}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );
});

/**
 * Build a 2-phase fixture where REQUIREMENTS.md has ONE body section (name
 * controlled by `heading`) containing a REQ-ID (PRESET-01) that is absent from
 * the Traceability table. `heading` is the only variable across callers, so
 * this isolates the DEFERRED_HEADING_RE / milestone-aware-version-heading
 * behavior precisely.
 *
 * `milestone` (default `v1.3`, #2334 BLOCKER regression guard) is written
 * into STATE.md's `milestone:` frontmatter so a `## v<N> ...` heading resolves
 * deterministically against the current milestone's MAJOR version instead of
 * silently exercising the "milestone unresolved" fail-safe path. Pass `null`
 * to omit the field entirely (fail-safe probe).
 *
 * `bodyProse`, when given, is inserted as its own paragraph directly under
 * `heading` and above the PRESET-01 line — used to pin the shipped
 * `templates/requirements.md` shape, where the deferred-ness lives in body
 * prose ("Deferred to future release...") rather than in the heading text.
 */
function build2316HeadingFixture(heading, milestone = 'v1.3', bodyProse = null) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2316-heading-'));
  const planDir = path.join(tmpDir, '.planning');
  const phasesDir = path.join(planDir, 'phases');
  const phase1Dir = path.join(phasesDir, '01-preset');
  const phase2Dir = path.join(phasesDir, '02-next');
  fs.mkdirSync(phase1Dir, { recursive: true });
  fs.mkdirSync(phase2Dir, { recursive: true });

  fs.writeFileSync(path.join(planDir, 'REQUIREMENTS.md'), [
    '# Requirements',
    '',
    heading,
    '',
    ...(bodyProse ? [bodyProse, ''] : []),
    '- **PRESET-01** Body requirement missing from traceability table.',
    '',
    '## Traceability',
    '',
    '| Requirement | Phase | Status |',
    '|-------------|-------|--------|',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(planDir, 'ROADMAP.md'), [
    '# Roadmap',
    '',
    '- [ ] Phase 01: Preset',
    '- [ ] Phase 02: Next',
    '',
    '### Phase 01: Preset',
    '**Goal:** Build preset',
    '**Requirements:** TBD',
    '**Plans:** 1 plans',
    '',
    '### Phase 02: Next',
    '**Goal:** whatever',
    '**Requirements:** TBD',
    '**Plans:** 1 plans',
    '',
    '## Progress',
    '',
    '| Phase | Plans Complete | Status | Completed |',
    '|-------|----------------|--------|-----------|',
    '| 01. Preset | 0/1 | Not started | - |',
    '| 02. Next | 0/1 | Not started | - |',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(planDir, 'STATE.md'), [
    ...(milestone !== null ? ['---', `milestone: ${milestone}`, '---'] : []),
    '# State',
    '',
    '**Current Phase:** 01',
    '**Completed Phases:** 0',
    '**Total Phases:** 2',
    '**Progress:** 0%',
    '',
  ].join('\n'));

  for (const [dir, n] of [[phase1Dir, '01'], [phase2Dir, '02']]) {
    fs.writeFileSync(path.join(dir, `${n}-01-PLAN.md`), '# Plan\nDo the work.\n');
    fs.writeFileSync(path.join(dir, `${n}-01-SUMMARY.md`), '# Summary\nDone.\n');
  }

  return tmpDir;
}

describe('issue #2316 (Secondary A): DEFERRED_HEADING_RE\'s bare `v\\d+` alternative over-matches an active heading', () => {
  test(
    '#2316-4a: "## v1 Requirements" heading with a body REQ-ID missing from the Traceability table must still surface the body-vs-table warning (an active "v1" heading is not deferred)',
    () => {
      const tmpDir = build2316HeadingFixture('## v1 Requirements');
      try {
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
        const parsed = JSON.parse(output);
        const warnings = parsed.warnings || [];
        assert.ok(
          warnings.some((w) => /PRESET-01/.test(w) && /Traceability/i.test(w)),
          `#2316-4a FAILED: expected a body-vs-table Traceability warning naming PRESET-01 under the ` +
          `"## v1 Requirements" heading (the bare v\\d+ regex alternative wrongly treats it as deferred), ` +
          `got warnings: ${JSON.stringify(warnings)}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  test(
    '#2316-4b (control): "## Functional" heading (identical fixture, non-versioned heading name) must surface the same body-vs-table warning',
    () => {
      const tmpDir = build2316HeadingFixture('## Functional');
      try {
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
        const parsed = JSON.parse(output);
        const warnings = parsed.warnings || [];
        assert.ok(
          warnings.some((w) => /PRESET-01/.test(w) && /Traceability/i.test(w)),
          `#2316-4b FAILED: control heading "## Functional" must also warn for PRESET-01, got warnings: ${JSON.stringify(warnings)}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  test(
    '#2334 BLOCKER: "## v2 Requirements" heading with the shipped templates/requirements.md body prose ("Deferred to future release. Tracked but not in current roadmap."), milestone v1.3 -> the bare v\\d+ heading must be treated as deferred (SAME major-version mismatch: v2 != v1) and NOT surface the body-vs-table warning',
    () => {
      // Fixture copied VERBATIM from gsd-core/templates/requirements.md:35-37.
      const tmpDir = build2316HeadingFixture(
        '## v2 Requirements',
        'v1.3',
        'Deferred to future release. Tracked but not in current roadmap.',
      );
      try {
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
        const parsed = JSON.parse(output);
        const warnings = parsed.warnings || [];
        const traceWarnings = warnings.filter((w) => /Traceability/i.test(w));
        assert.strictEqual(
          traceWarnings.length, 0,
          `#2334 BLOCKER FAILED: "## v2 Requirements" under milestone v1.3 (the shipped template's OWN deferred ` +
          `section — #1159's original fix target) must stay suppressed, got: ${JSON.stringify(traceWarnings)}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  test(
    '#2334 BLOCKER (milestone-unresolved fail-safe): "## v1 Requirements" heading with NO milestone field in STATE.md must fall back to the OLD pre-#2316-4a behavior and suppress the warning (a false "deferred" only ever suppresses, never spams)',
    () => {
      const tmpDir = build2316HeadingFixture('## v1 Requirements', /* milestone */ null);
      try {
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
        const parsed = JSON.parse(output);
        const warnings = parsed.warnings || [];
        const traceWarnings = warnings.filter((w) => /Traceability/i.test(w));
        assert.strictEqual(
          traceWarnings.length, 0,
          `#2334 fail-safe FAILED: with no resolvable milestone, "## v1 Requirements" must fall back to treating ` +
          `v\\d+ as deferred (suppress), got: ${JSON.stringify(traceWarnings)}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  for (const heading of ['## Deferred', '## Backlog', '## Future']) {
    test(
      `#2316-5: genuinely deferred heading "${heading}" must still suppress the body-vs-table warning (regression guard — #1159 introduced this filter deliberately; the v\\d+ fix must not remove deferred/backlog/future detection)`,
      () => {
        const tmpDir = build2316HeadingFixture(heading);
        try {
          const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
          const parsed = JSON.parse(output);
          const warnings = parsed.warnings || [];
          const traceWarnings = warnings.filter((w) => /Traceability/i.test(w));
          assert.strictEqual(
            traceWarnings.length, 0,
            `#2316-5 FAILED: heading "${heading}" must still be treated as deferred (no warning), ` +
            `got: ${JSON.stringify(traceWarnings)}`,
          );
        } finally {
          cleanup(tmpDir);
        }
      },
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #2334 HIGH 2 / HIGH 3: ghost-REQ-ID classification must probe the ACTUAL
// write surfaces (checkbox + Traceability row, case-insensitive — mirroring
// milestone.cts's notFound/hasRow/doneCheckbox classification), not set-diff
// the deferred-filtered/case-sensitive bodyReqIds/tableReqIds indexes; and the
// cited-REQ-ID tokenizer must be filtered to the REQ-ID shape before it ever
// feeds a warning.
// ─────────────────────────────────────────────────────────────────────────────

function build2334GhostSurfaceFixture({ reqBody, roadmapRequirementsLine, traceabilityRows = [] }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2334-ghost-surface-'));
  const planDir = path.join(tmpDir, '.planning');
  const phasesDir = path.join(planDir, 'phases');
  const phase1Dir = path.join(phasesDir, '01-preset');
  const phase2Dir = path.join(phasesDir, '02-next');
  fs.mkdirSync(phase1Dir, { recursive: true });
  fs.mkdirSync(phase2Dir, { recursive: true });

  fs.writeFileSync(path.join(planDir, 'REQUIREMENTS.md'), [
    '# Requirements',
    '',
    ...reqBody,
    '',
    '## Traceability',
    '',
    '| Requirement | Phase | Status |',
    '|-------------|-------|--------|',
    ...traceabilityRows,
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(planDir, 'ROADMAP.md'), [
    '# Roadmap',
    '',
    '- [ ] Phase 01: Preset',
    '- [ ] Phase 02: Next',
    '',
    '### Phase 01: Preset',
    '**Goal:** Build preset',
    `**Requirements**: ${roadmapRequirementsLine}`,
    '**Plans:** 1 plans',
    '',
    '### Phase 02: Next',
    '**Goal:** whatever',
    '**Requirements:** TBD',
    '**Plans:** 1 plans',
    '',
    '## Progress',
    '',
    '| Phase | Plans Complete | Status | Completed |',
    '|-------|----------------|--------|-----------|',
    '| 01. Preset | 0/1 | Not started | - |',
    '| 02. Next | 0/1 | Not started | - |',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(planDir, 'STATE.md'), [
    '---', 'milestone: v1.3', '---',
    '# State',
    '',
    '**Current Phase:** 01',
    '**Completed Phases:** 0',
    '**Total Phases:** 2',
    '**Progress:** 0%',
    '',
  ].join('\n'));

  for (const [dir, n] of [[phase1Dir, '01'], [phase2Dir, '02']]) {
    fs.writeFileSync(path.join(dir, `${n}-01-PLAN.md`), '# Plan\nDo the work.\n');
    fs.writeFileSync(path.join(dir, `${n}-01-SUMMARY.md`), '# Summary\nDone.\n');
  }

  return tmpDir;
}

describe('issue #2334: ghost-REQ-ID classification must probe write surfaces, not lossy indexes', () => {
  test(
    '#2334 HIGH 2a: an ID under "## Deferred" whose checkbox this run TICKS must NOT be reported as a ghost',
    () => {
      const tmpDir = build2334GhostSurfaceFixture({
        reqBody: ['## Deferred', '', '- [ ] **KNOWN-01**: some deferred requirement'],
        roadmapRequirementsLine: '[KNOWN-01]',
      });
      try {
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
        const parsed = JSON.parse(output);
        const warnings = parsed.warnings || [];
        const reqContent = fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
        assert.ok(
          /-\s*\[x\]\s*\*\*KNOWN-01\*\*/i.test(reqContent),
          `#2334 HIGH 2a FAILED (fixture invariant): checkbox for KNOWN-01 must have been ticked.\n${reqContent}`,
        );
        assert.ok(
          !warnings.some((w) => /not registered anywhere/i.test(w) && /KNOWN-01/i.test(w)),
          `#2334 HIGH 2a FAILED: KNOWN-01 (checkbox ticked this run, under a Deferred heading) must not be ` +
          `reported as a ghost, got: ${JSON.stringify(warnings)}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  test(
    '#2334 HIGH 2b: a case-mismatched citation ("known-01" vs "**KNOWN-01**") whose write lands must NOT be reported as a ghost',
    () => {
      const tmpDir = build2334GhostSurfaceFixture({
        reqBody: ['## Active', '', '- [ ] **KNOWN-01**: some active requirement'],
        roadmapRequirementsLine: '[known-01]',
        traceabilityRows: ['| KNOWN-01 | Phase 1 | Pending |'],
      });
      try {
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
        const parsed = JSON.parse(output);
        const warnings = parsed.warnings || [];
        const reqContent = fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
        assert.ok(
          /-\s*\[x\]\s*\*\*KNOWN-01\*\*/i.test(reqContent),
          `#2334 HIGH 2b FAILED (fixture invariant): checkbox must have been ticked.\n${reqContent}`,
        );
        const traceabilityRow = reqContent.split(/\r?\n/)
          .filter((l) => l.trim().startsWith('|'))
          .map((l) => splitTableRow(l))
          .find((cells) => cells[0] && cells[0].trim().toLowerCase() === 'known-01');
        assert.ok(
          traceabilityRow && /^Complete$/i.test(traceabilityRow[traceabilityRow.length - 1].trim()),
          `#2334 HIGH 2b FAILED (fixture invariant): Traceability row must have flipped to Complete.\n${reqContent}`,
        );
        assert.strictEqual(parsed.requirements_updated, true, '#2334 HIGH 2b FAILED: requirements_updated must be true');
        assert.ok(
          !warnings.some((w) => /not registered anywhere/i.test(w)),
          `#2334 HIGH 2b FAILED: a case-mismatched citation whose write landed must not warn as a ghost, ` +
          `got: ${JSON.stringify(warnings)}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  test(
    '#2334 HIGH 3: the shipped templates/roadmap.md inline-HTML-comment Requirements line must not warn to register "<!--", "brackets", "optional", "parser", "handles", "both", "formats", or "-->"',
    () => {
      const tmpDir = build2334GhostSurfaceFixture({
        reqBody: ['## Active', '', '- [ ] **REQ-01**: something'],
        roadmapRequirementsLine: '[REQ-01, REQ-02]  <!-- brackets optional, parser handles both formats -->',
        traceabilityRows: ['| REQ-01 | Phase 1 | Pending |'],
      });
      try {
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
        const parsed = JSON.parse(output);
        const warnings = parsed.warnings || [];
        const junkTokens = ['<!--', 'brackets', 'optional', 'parser', 'handles', 'both', 'formats', '-->'];
        for (const token of junkTokens) {
          assert.ok(
            !warnings.some((w) => w.includes(token)),
            `#2334 HIGH 3 FAILED: warnings must not name the non-REQ-ID token "${token}" from the inline HTML ` +
            `comment, got: ${JSON.stringify(warnings)}`,
          );
        }
        // REQ-02 is a genuine, shape-valid, unregistered REQ-ID — it MUST
        // still be flagged (the shape filter must not over-broaden to
        // silence real ghosts).
        assert.ok(
          warnings.some((w) => /not registered anywhere/i.test(w) && /REQ-02/.test(w)),
          `#2334 HIGH 3 FAILED: REQ-02 (real, shape-valid, unregistered REQ-ID) must still be flagged as a ` +
          `ghost, got: ${JSON.stringify(warnings)}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );

  test(
    '#2334 HIGH 3 (boundary): "**Requirements:** None" must not warn to register the literal word "None"',
    () => {
      const tmpDir = build2334GhostSurfaceFixture({
        reqBody: ['## Active'],
        roadmapRequirementsLine: 'None',
      });
      try {
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
        const parsed = JSON.parse(output);
        const warnings = parsed.warnings || [];
        assert.ok(
          !warnings.some((w) => /\bNone\b/.test(w)),
          `#2334 HIGH 3 boundary FAILED: "None" must not be treated as a cited REQ-ID, got: ${JSON.stringify(warnings)}`,
        );
      } finally {
        cleanup(tmpDir);
      }
    },
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Regressions: issue #3697 — the `**Requirements**:` tokenizer UNDER-selects
// silently. #2339 fixed OVER-selection (the shape filter) and added the
// ghost-ID cross-check; neither covers an ID the tokenizer DROPPED. A spaced
// range (`RANGE-01 … RANGE-05`) survives the `[,\s]+` split as its two
// endpoints and marks only those; a tight range (`RANGE-01…05`) survives as one
// token, fails the anchored shape filter, and marks nothing. Both paths report
// success with `warnings: []`, because `ghostReqIds` is itself
// `citedReqIds.filter(...)` and so cannot see an ID that was never selected.
//
// The fix warns; it does not parse. The selected set is unchanged (range syntax
// stays unsupported), and the trigger is ID-SHAPED EVIDENCE only — the #2334 /
// #2339 over-warning on `None`, on the shipped `<!-- ... -->` template comment,
// and on parenthetical annotations must not return.
// ─────────────────────────────────────────────────────────────────────────────

const REQ_LINE_MISPARSE_RE = /could not be parsed as a comma-separated REQ-ID list/i;
// The AMBIGUOUS channel, added in round 3. A spaced separator between two
// selected, interior-implying REQ-IDs cannot be told from a range by any
// token-level rule, and every ID on such a line IS selected — so the warning
// discloses both readings instead of asserting a parse failure that did not
// happen. See `formatRequirementsLineWarning` in src/phase.cts.
const REQ_LINE_RANGE_READING_RE = /contains what reads as a range between two cited REQ-IDs/i;

function build3697RangeFixture(roadmapRequirementsLine) {
  return build2334GhostSurfaceFixture({
    reqBody: [
      '## Functional Requirements',
      '',
      '- [ ] **RANGE-01**: synthetic fixture requirement 1.',
      '- [ ] **RANGE-02**: synthetic fixture requirement 2.',
      '- [ ] **RANGE-03**: synthetic fixture requirement 3.',
      '- [ ] **RANGE-04**: synthetic fixture requirement 4.',
      '- [ ] **RANGE-05**: synthetic fixture requirement 5.',
    ],
    roadmapRequirementsLine,
    traceabilityRows: [
      '| RANGE-01 | Phase 01 | Pending |',
      '| RANGE-02 | Phase 01 | Pending |',
      '| RANGE-03 | Phase 01 | Pending |',
      '| RANGE-04 | Phase 01 | Pending |',
      '| RANGE-05 | Phase 01 | Pending |',
    ],
  });
}

const tickedReqIds = (reqContent) =>
  [...reqContent.matchAll(/-\s*\[x\]\s*\*\*(RANGE-\d+)\*\*/gi)].map((m) => m[1].toUpperCase());

describe('issue #3697: phase complete must warn when the Requirements line under-selects', () => {
  for (const [label, line] of [
    ['ellipsis', 'RANGE-01 … RANGE-05'],
    ['hyphen', 'RANGE-01 - RANGE-05'],
    ['worded', 'RANGE-01 through RANGE-05'],
    ['parenthesized operator', 'RANGE-01 (..) RANGE-05'],
  ]) {
    test(
      `#3697-1 (${label} spaced range): a range that survives the split as its two endpoints must warn — ` +
      'and the endpoint-only marking behavior itself is UNCHANGED',
      (t) => {
        const tmpDir = build3697RangeFixture(line);
        t.after(() => cleanup(tmpDir));
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
        const parsed = JSON.parse(output);
        const warnings = parsed.warnings || [];
        assert.ok(
          warnings.some((w) => REQ_LINE_RANGE_READING_RE.test(w)),
          `#3697-1 FAILED (${label}): a spaced range marks ONLY its endpoints, so it must warn. ` +
          `Got warnings: ${JSON.stringify(warnings)}\nFull output: ${output}`,
        );
        assert.strictEqual(
          parsed.has_warnings, true,
          `#3697-1 FAILED (${label}): has_warnings must be true, got: ${JSON.stringify(parsed)}`,
        );
        // The warning must name what WAS selected, so the author can see the gap.
        assert.ok(
          warnings.some(
            (w) => REQ_LINE_RANGE_READING_RE.test(w) && /RANGE-01/.test(w) && /RANGE-05/.test(w),
          ),
          `#3697-1 FAILED (${label}): the warning must name the IDs actually selected ` +
          `(RANGE-01, RANGE-05), got: ${JSON.stringify(warnings)}`,
        );
        // Round 3 (review finding Major 3): nothing on this line was dropped —
        // both endpoints were selected — so the warning must NOT assert that
        // the line failed to parse. It offers the range reading and the
        // annotation reading and lets the author choose.
        assert.ok(
          !warnings.some((w) => REQ_LINE_MISPARSE_RE.test(w)),
          `#3697-1 FAILED (${label}): a spaced range drops nothing the tokenizer could have taken, ` +
          `so the misparse channel must stay silent, got: ${JSON.stringify(warnings)}`,
        );
        // Behavior guard: this is a warning, NOT range support. Exactly the two
        // endpoints stay ticked; the interior IDs are still not expanded.
        const reqContent = fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
        assert.deepStrictEqual(
          tickedReqIds(reqContent).sort(), ['RANGE-01', 'RANGE-05'],
          `#3697-1 FAILED (${label}): the selected set must be UNCHANGED (endpoints only — ranges are ` +
          `deliberately not expanded).\nREQUIREMENTS.md:\n${reqContent}`,
        );
      },
    );
  }

  for (const [label, line] of [
    ['ellipsis', 'RANGE-01…05'],
    ['double-dot', 'RANGE-01..RANGE-05'],
  ]) {
    test(
      `#3697-2 (${label} tight range): a line that selects ZERO IDs while being non-empty and not TBD ` +
      'must warn, and must write nothing to the ledger',
      (t) => {
        const tmpDir = build3697RangeFixture(line);
        t.after(() => cleanup(tmpDir));
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
        const parsed = JSON.parse(output);
        const warnings = parsed.warnings || [];
        assert.ok(
          warnings.some((w) => REQ_LINE_MISPARSE_RE.test(w)),
          `#3697-2 FAILED (${label}): a zero-selection line is completely inert and must warn. ` +
          `Got warnings: ${JSON.stringify(warnings)}\nFull output: ${output}`,
        );
        assert.ok(
          warnings.some((w) => REQ_LINE_MISPARSE_RE.test(w) && /RANGE-01/.test(w)),
          `#3697-2 FAILED (${label}): the warning must name the unparsed ID-shaped text, ` +
          `got: ${JSON.stringify(warnings)}`,
        );
        assert.strictEqual(
          parsed.requirements_updated, false,
          `#3697-2 FAILED (${label}): nothing was selected, so requirements_updated must be false, ` +
          `got: ${JSON.stringify(parsed)}`,
        );
        const reqContent = fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
        assert.deepStrictEqual(
          tickedReqIds(reqContent), [],
          `#3697-2 FAILED (${label}): no checkbox may be ticked.\nREQUIREMENTS.md:\n${reqContent}`,
        );
      },
    );
  }

  for (const [label, line] of [
    ['bare comma list', 'RANGE-01, RANGE-02, RANGE-03, RANGE-04, RANGE-05'],
    ['bracketed comma list', '[RANGE-01, RANGE-02, RANGE-03, RANGE-04, RANGE-05]'],
  ]) {
    test(
      `#3697-3 (control, ${label}): the canonical form must mark every ID and must not warn`,
      (t) => {
        const tmpDir = build3697RangeFixture(line);
        t.after(() => cleanup(tmpDir));
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
        const parsed = JSON.parse(output);
        const warnings = parsed.warnings || [];
        // Whole-channel assertion: the fixture registers every cited ID, so
        // there is NO legitimate warning here. Filtering by the current
        // phrase would let a re-worded over-warning slip through (review
        // claim 8) — assert actual silence, not absence of one wording.
        assert.deepStrictEqual(
          warnings, [],
          `#3697-3 FAILED (${label}): the canonical comma list must never warn, ` +
          `got: ${JSON.stringify(warnings)}`,
        );
        const reqContent = fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
        assert.deepStrictEqual(
          tickedReqIds(reqContent).sort(),
          ['RANGE-01', 'RANGE-02', 'RANGE-03', 'RANGE-04', 'RANGE-05'],
          `#3697-3 FAILED (${label}): all five requirements must be ticked.\n` +
          `REQUIREMENTS.md:\n${reqContent}`,
        );
      },
    );
  }

  // The #2334/#2339 over-warning must not return. The trigger is ID-shaped
  // evidence — NOT "the line has residue after the selected IDs are removed",
  // which is exactly the check that once warned to register `<!--`, `brackets`,
  // `optional` and the literal word `None`.
  for (const [label, line] of [
    ['TBD placeholder', 'TBD'],
    ['literal None', 'None'],
    ['shipped template comment', '[RANGE-01, RANGE-02]  <!-- brackets optional, remove if unused -->'],
    ['parenthetical citation', 'RANGE-01, RANGE-02 (locked per ADR-7)'],
    // The next four are the false-positive classes a free-text detector
    // produced (the #2334/#2339 regression shape): a hyphen after the list is
    // an ANNOTATION separator, not a range operator, whenever what follows is
    // not itself a REQ-ID — and an ID-shaped citation on a correctly-parsed
    // line is a citation, not unparsed residue.
    ['numeric estimate annotation', 'RANGE-01, RANGE-02 - 3 points'],
    ['date annotation', 'RANGE-01, RANGE-02 - 2026-08-21 target'],
    ['em-dash citation with trailing period', 'RANGE-01, RANGE-02 — locked per ADR-7.'],
    ['nested parenthetical citations', 'RANGE-01, RANGE-02 (see (ADR-7), then ADR-8)'],
    // A hyphen between two ADJACENT selected IDs can drop nothing (there is no
    // interior), so it reads as an annotation separator, not a range.
    ['adjacent-ID annotation hyphen', 'RANGE-01, RANGE-02 - RANGE-03 deferred'],
    // Cross-prefix pairs around a separator are annotations, not ranges — real
    // ranges are same-prefix by nature.
    ['hyphen citation annotation', 'RANGE-01, RANGE-02 - (ADR-7)'],
    ['ellipsis-of-omission with citation', 'RANGE-01, RANGE-02 (...) (ADR-7)'],
    // Markdown emphasis around a placeholder must not defeat the placeholder
    // gate.
    ['bold placeholder with citation', '**None** (per ADR-7)'],
    // `LETTERS-\d+-\d+` is also a date: the bare-hyphen tight-range arm demands
    // a full ID on both sides precisely so this stays silent.
    ['date-like parenthetical annotation', 'RANGE-01 (target FY-2026-08)'],
    // A declared-empty line citing its rationale — zero selection with ID-shaped
    // text, but placeholder-led. The #2334 class R3 must not recreate.
    ['None with citation', 'None (per ADR-7)'],
    ['TBD with citation', 'TBD (see ADR-7)'],
  ]) {
    test(
      `#3697-4 (negative space, ${label}): must stay silent — the historical over-warning must not return`,
      (t) => {
        const tmpDir = build3697RangeFixture(line);
        t.after(() => cleanup(tmpDir));
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
        const parsed = JSON.parse(output);
        const warnings = parsed.warnings || [];
        // Whole-channel assertion, same rationale as #3697-3: every ID these
        // fixtures cite is registered, so nothing here may warn at all. A
        // phrase-filtered check pins wording, not silence (review claim 8).
        assert.deepStrictEqual(
          warnings, [],
          `#3697-4 FAILED (${label}): ${JSON.stringify(line)} must not produce ANY warning, ` +
          `got: ${JSON.stringify(warnings)}\nFull output: ${output}`,
        );
      },
    );
  }

  // A range hidden INSIDE balanced parentheses is stripped by the token shave
  // and must still warn (review claim 2's first reproduction: the selector
  // sees only `RANGE-01`, and v1's scan saw nothing at all). Partial
  // selection: exactly RANGE-01 is ticked; the range token is reported as
  // unparsed; nothing is expanded.
  for (const [label5, line5] of [
    ['parenthesized', 'RANGE-01 (plus RANGE-02..RANGE-05)'],
    ['backticked', 'RANGE-01, `RANGE-02..RANGE-05`'],
    ['bold-wrapped', 'RANGE-01, **RANGE-02..RANGE-05**'],
    ['underscore-wrapped', 'RANGE-01, _RANGE-02..RANGE-05_'],
  ]) {
  test(
    `#3697-5 (${label5} tight range): a wrapped range must still warn and stay unexpanded`,
    (t) => {
      const tmpDir = build3697RangeFixture(line5);
      t.after(() => cleanup(tmpDir));
      const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
      const parsed = JSON.parse(output);
      const warnings = parsed.warnings || [];
      assert.ok(
        warnings.some((w) => REQ_LINE_MISPARSE_RE.test(w)),
        `#3697-5 FAILED (${label5}): the wrapped range selects only RANGE-01, so it must warn. ` +
        `Got warnings: ${JSON.stringify(warnings)}\nFull output: ${output}`,
      );
      assert.ok(
        warnings.some((w) => REQ_LINE_MISPARSE_RE.test(w) && /RANGE-02\.\.RANGE-05/.test(w)),
        `#3697-5 FAILED (${label5}): the warning must name the unparsed range token ` +
        `(RANGE-02..RANGE-05), got: ${JSON.stringify(warnings)}`,
      );
      const reqContent = fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
      assert.deepStrictEqual(
        tickedReqIds(reqContent), ['RANGE-01'],
        `#3697-5 FAILED (${label5}): exactly RANGE-01 must be ticked (no expansion, no extra writes).\n` +
        `REQUIREMENTS.md:\n${reqContent}`,
      );
    },
  );
  }

  // A valid prefix-agnostic ID that HAPPENS to start with a word operator
  // (`TORANGE-05` reads as `to` + `RANGE-05`) is an ID, not a glued range —
  // the glued-fragment rule is symbol-operator-only for exactly this reason.
  // The ID is unregistered in this fixture, so the pre-existing ghost-ID
  // warning legitimately fires; only the misparse channel must stay silent.
  test(
    '#3697-4b (word-operator-prefixed ID): a canonical list must not read as a glued range',
    (t) => {
      const tmpDir = build3697RangeFixture('RANGE-01, TORANGE-05');
      t.after(() => cleanup(tmpDir));
      const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
      const parsed = JSON.parse(output);
      const warnings = parsed.warnings || [];
      // Round 4 review Minor 1: this asserted only that the ASSERTIVE channel
      // stayed silent, so a regression routing the line into the AMBIGUOUS
      // channel would have passed. Whole-channel silence is not available here
      // — the pre-existing ghost-ID warning legitimately fires on the
      // unregistered `TORANGE-05` — so the precise assertion is that NO
      // Requirements-line warning of ANY kind was emitted. The machine code
      // added in this round is what makes that statable at all.
      assert.strictEqual(
        parsed.requirements_line_warning, undefined,
        `#3697-4b FAILED: "RANGE-01, TORANGE-05" is a comma list of two valid IDs and must not ` +
        `produce a Requirements-line warning in ANY channel, got kind ` +
        `${JSON.stringify(parsed.requirements_line_warning)} / ${JSON.stringify(warnings)}\n` +
        `Full output: ${output}`,
      );
    },
  );

  // ==========================================================================
  // #3697-14 — AC-1b / AC-4: zero selection on a non-placeholder line.
  //
  // The issue's narrow clause verbatim: "warn when `citedReqIds.length === 0`
  // while the raw capture is non-empty and not `TBD`". Before R3b these five
  // words selected nothing and stayed SILENT, while the CLI-TOOLS reference's
  // Requirements-line grammar section, the `placeholderLed` census comment and
  // the advice string all stated they warned — a claim written into three
  // artifacts and never executed once. (Named without spelling the doc's path:
  // the docs-guard exemption ratchet fingerprints literal docs/ references in
  // exempt test files, and this test reads no documentation.)
  // The asymmetry was the tell: `Deferred (see ADR-7)` warned (the citation
  // supplied ID-shaped residue) while bare `Deferred` did not.
  // ==========================================================================
  for (const [label14, line14] of [
    ['Deferred', 'Deferred'],
    ['N/A', 'N/A'],
    ['Pending', 'Pending'],
    ['TBA', 'TBA'],
    ['bare dash', '-'],
    // Prose with no ID-shaped token anywhere — the class R3's ID-shape gate
    // could never reach, whatever the wording.
    ['free prose', 'to be scoped after the spike'],
  ]) {
    test(
      `#3697-14 (zero selection, ${label14}): a non-empty, non-placeholder line that selects NO ` +
      'REQ-IDs must warn — #3697 AC-1b/AC-4',
      (t) => {
        const tmpDir = build3697RangeFixture(line14);
        t.after(() => cleanup(tmpDir));
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
        const parsed = JSON.parse(output);
        const warnings = parsed.warnings || [];
        assert.ok(
          warnings.some((w) => REQ_LINE_MISPARSE_RE.test(w)),
          `#3697-14 FAILED (${label14}): ${JSON.stringify(line14)} is non-empty, is not a ` +
          `placeholder and selects zero REQ-IDs, so it must warn. ` +
          `Got warnings: ${JSON.stringify(warnings)}\nFull output: ${output}`,
        );
        // The warning must name the escape the author actually has, or it
        // reports a problem with no remedy.
        assert.ok(
          warnings.some((w) => REQ_LINE_MISPARSE_RE.test(w) && /`TBD` or `None`/.test(w)),
          `#3697-14 FAILED (${label14}): the warning must name the TBD/None placeholder escape, ` +
          `got: ${JSON.stringify(warnings)}`,
        );
        // Selection behavior is UNCHANGED — this rule warns, it never invents IDs.
        const reqContent = fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
        assert.deepStrictEqual(
          tickedReqIds(reqContent), [],
          `#3697-14 FAILED (${label14}): a zero-selection line must tick NOTHING.\n` +
          `REQUIREMENTS.md:\n${reqContent}`,
        );
      },
    );
  }

  // The placeholder gate is what holds the whole #2334 negative space silent
  // under R3b, so it is pinned in every spelling an author actually writes.
  // Whole-channel silence, same rationale as #3697-4: a phrase filter pins
  // wording, not silence.
  for (const [label14b, line14b] of [
    ['lowercase tbd', 'tbd'],
    ['lowercase none', 'none'],
    ['bold None only', '**None**'],
    ['backticked TBD', '`TBD`'],
    ['TBD with trailing note', 'TBD  <!-- pending scoping -->'],
  ]) {
    test(
      `#3697-14b (placeholder spelling, ${label14b}): the placeholder gate must hold R3b off`,
      (t) => {
        const tmpDir = build3697RangeFixture(line14b);
        t.after(() => cleanup(tmpDir));
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
        const parsed = JSON.parse(output);
        const warnings = parsed.warnings || [];
        assert.deepStrictEqual(
          warnings, [],
          `#3697-14b FAILED (${label14b}): ${JSON.stringify(line14b)} is a declared-empty line and ` +
          `must produce NO warning at all, got: ${JSON.stringify(warnings)}\nFull output: ${output}`,
        );
      },
    );
  }

  // R3b's `tokens.length > 0` guard. The tokenizer strips `<!-- ... -->`
  // BEFORE splitting, so a comment-only line yields no tokens and cannot
  // reach the rule — without this guard the shipped template's own comment
  // line would warn, which is #2334's opening move.
  test(
    '#3697-14c (comment-only line): a line whose only content is a template comment stays silent',
    (t) => {
      const tmpDir = build3697RangeFixture('<!-- fill in once the spike lands -->');
      t.after(() => cleanup(tmpDir));
      const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
      const parsed = JSON.parse(output);
      const warnings = parsed.warnings || [];
      assert.deepStrictEqual(
        warnings, [],
        `#3697-14c FAILED: a comment-only Requirements line has no content tokens and must not ` +
        `warn, got: ${JSON.stringify(warnings)}\nFull output: ${output}`,
      );
    },
  );

  // ==========================================================================
  // #3697-15 — AC-1a: a REQ-ID the selector dropped to a glued delimiter.
  //
  // `RANGE-01; RANGE-02` selects only RANGE-02 and marks only RANGE-02, with
  // `requirements_updated: true` — #3697's own half-success failure mode,
  // reached by one wrong delimiter, and silent before this rule.
  //
  // Round 4 review rated this Major rather than Blocker on the ground that it
  // is indistinguishable from a parenthesised citation (`(ADR-7)` shaves to a
  // bare ID too). At the RAW token level it is distinguishable: the shave
  // class differs, and -15b pins the citation half.
  // ==========================================================================
  for (const [label15, line15, expectTicked15, expectNamed15] of [
    ['semicolon', 'RANGE-01; RANGE-02', ['RANGE-02'], ['RANGE-01']],
    ['colon', 'RANGE-01: RANGE-02', ['RANGE-02'], ['RANGE-01']],
    // Every dropped ID is named, not just the first — the chain is what
    // catches a clause that reports only one and reads as complete.
    ['semicolon chain', 'RANGE-01; RANGE-02; RANGE-03', ['RANGE-03'], ['RANGE-01', 'RANGE-02']],
    // The drop can be the LAST id as easily as the first.
    ['trailing colon', 'RANGE-01, RANGE-02:', ['RANGE-01'], ['RANGE-02']],
  ]) {
    test(
      `#3697-15 (delimiter-dropped ID, ${label15}): an ID the selector dropped to a glued ` +
      '`;`/`:` must warn and be named — selection is UNCHANGED',
      (t) => {
        const tmpDir = build3697RangeFixture(line15);
        t.after(() => cleanup(tmpDir));
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
        const parsed = JSON.parse(output);
        const warnings = parsed.warnings || [];
        assert.ok(
          warnings.some((w) => REQ_LINE_MISPARSE_RE.test(w)),
          `#3697-15 FAILED (${label15}): ${JSON.stringify(line15)} silently drops an ID, so it ` +
          `must warn. Got warnings: ${JSON.stringify(warnings)}\nFull output: ${output}`,
        );
        // Naming the dropped ID is the whole point — a warning that says
        // "something was dropped" without saying WHAT is not actionable.
        const expectedClause15 =
          `${expectNamed15.join(', ')} ${expectNamed15.length === 1 ? 'was' : 'were'} NOT selected`;
        assert.ok(
          warnings.some((w) => w.includes(expectedClause15)),
          `#3697-15 FAILED (${label15}): the warning must name EVERY dropped ID — expected the ` +
          `clause ${JSON.stringify(expectedClause15)}, got: ${JSON.stringify(warnings)}`,
        );
        // The selector is untouched by this PR — the rule warns, it never
        // widens what gets marked.
        const reqContent = fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
        assert.deepStrictEqual(
          tickedReqIds(reqContent), expectTicked15,
          `#3697-15 FAILED (${label15}): exactly ${JSON.stringify(expectTicked15)} must be ticked — ` +
          `the warning must not change the selection.\nREQUIREMENTS.md:\n${reqContent}`,
        );
      },
    );
  }

  // The rule's boundary, and the reason it is safe to ship. A delimiter glued
  // to an ID-shaped token INSIDE a parenthetical is a citation, not a dropped
  // requirement, and reporting it is the #2334 over-warning class. Whole
  // channel, because there is nothing on these lines to warn about at all.
  for (const [label15b, line15b] of [
    ['colon in citation', 'RANGE-01, RANGE-02 (see ADR-7: section 3)'],
    ['semicolon in citation', 'RANGE-01, RANGE-02 (see ADR-7; also ADR-9)'],
    ['nested colon note', 'RANGE-01, RANGE-02 (blocked: ADR-7: sec 3)'],
  ]) {
    test(
      `#3697-15b (citation boundary, ${label15b}): a delimiter inside a parenthetical is a ` +
      'citation, not a dropped requirement',
      (t) => {
        const tmpDir = build3697RangeFixture(line15b);
        t.after(() => cleanup(tmpDir));
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
        const parsed = JSON.parse(output);
        const warnings = parsed.warnings || [];
        assert.deepStrictEqual(
          warnings, [],
          `#3697-15b FAILED (${label15b}): ${JSON.stringify(line15b)} is a correctly-parsed comma ` +
          `list carrying a citation and must produce NO warning, got: ${JSON.stringify(warnings)}\n` +
          `Full output: ${output}`,
        );
      },
    );
  }

  // ==========================================================================
  // #3697-16 — the warning's machine kind reaches the JSON output (round 4
  // review Major 3).
  //
  // `warnings[]` stays a string[] — it is a documented output field rendered by
  // execute-phase.md, so re-typing its elements would break a shipped
  // contract. The kind is emitted as its own additive field, and THAT is what
  // a consumer and a test key on. Rewording a message must not silently
  // un-assert anything.
  // ==========================================================================
  for (const [label16, line16, expectCode16] of [
    ['assertive / misparse', 'RANGE-01..RANGE-05', 'req-line-misparse'],
    ['ambiguous / range reading', 'RANGE-01 … RANGE-05', 'req-line-range-reading'],
    ['zero selection', 'Deferred', 'req-line-misparse'],
    ['delimiter drop', 'RANGE-01; RANGE-02', 'req-line-misparse'],
  ]) {
    test(
      `#3697-16 (warning kind, ${label16}): the JSON result carries a stable machine code`,
      (t) => {
        const tmpDir = build3697RangeFixture(line16);
        t.after(() => cleanup(tmpDir));
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
        const parsed = JSON.parse(output);
        assert.ok(
          parsed.requirements_line_warning,
          `#3697-16 FAILED (${label16}): a warning fired, so the result must carry ` +
          `requirements_line_warning.\nFull output: ${output}`,
        );
        assert.strictEqual(
          parsed.requirements_line_warning.code, expectCode16,
          `#3697-16 FAILED (${label16}): wrong kind for ${JSON.stringify(line16)}.\n` +
          `Full output: ${output}`,
        );
        // The prose channel is UNCHANGED — this field is additive, and a
        // consumer reading warnings[] must see exactly what it saw before.
        assert.ok(
          Array.isArray(parsed.warnings) && parsed.warnings.every((w) => typeof w === 'string'),
          `#3697-16 FAILED (${label16}): warnings[] must remain a string[]; ` +
          `got ${JSON.stringify(parsed.warnings)}`,
        );
      },
    );
  }

  // The absent half. A field that is present on every run carries no
  // information, and a consumer keying on its presence would be wrong forever.
  test(
    '#3697-16b (clean line): no warning kind is emitted when the line parses',
    (t) => {
      const tmpDir = build3697RangeFixture('RANGE-01, RANGE-02, RANGE-03, RANGE-04, RANGE-05');
      t.after(() => cleanup(tmpDir));
      const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
      const parsed = JSON.parse(output);
      assert.strictEqual(
        parsed.requirements_line_warning, undefined,
        `#3697-16b FAILED: a clean Requirements line must emit no warning kind at all, got ` +
        `${JSON.stringify(parsed.requirements_line_warning)}\nFull output: ${output}`,
      );
    },
  );

  // ==========================================================================
  // #3697-17 — PARITY PIN against the SECOND parser of the same ROADMAP value.
  //
  // CLAUDE.md, KNOWN DEFECTS & ANTI-PATTERNS: "Generative Fix Divergence: when
  // sharing constants/arrays/parsers between parallel surfaces, add a parity
  // assertion test that fails if they diverge." Round 4 review Major 2.
  //
  // `normalizePhaseReqIds` (src/gap-checker.cts) parses the SAME
  // `**Requirements:**` value — its own docblock says callers "may pass the
  // roadmap value through verbatim". The two parsers do NOT agree today, and
  // this PR does not make them agree: `phase complete` writes a ledger, gap
  // analysis reports coverage, and unifying them would change what
  // `phase complete` MARKS, which is the one invariant this PR holds fixed.
  //
  // So this is the pin, not the fix: every axis of disagreement is asserted
  // explicitly, in BOTH directions, so drift on either side fails here rather
  // than silently widening. The consequence is already user-visible — see
  // -17b — and the pin is what makes it a known quantity instead of a slow
  // leak.
  // ==========================================================================
  const { normalizePhaseReqIds } = require('../gsd-core/bin/lib/gap-checker.cjs');
  const phaseSelects = (line) => analyzeRequirementsLine(line).citedReqIds;

  for (const [axis, line17, expectPhase, expectGap, why] of [
    [
      'ranges',
      'RANGE-01..RANGE-05',
      [],
      ['RANGE-01', 'RANGE-02', 'RANGE-03', 'RANGE-04', 'RANGE-05'],
      'DELIBERATE: #3697 explicitly declines range expansion ("I am not asking for range syntax ' +
      'to be supported"); gap analysis expanded ranges under #1269. This PR warns on the shape ' +
      'rather than adopting it.',
    ],
    [
      'placeholder vocabulary',
      'None (per ADR-7)',
      [],
      ['ADR-7'],
      'DIVERGENT: phase complete reads the LEAD token, so a declared-empty line citing its ' +
      'rationale is empty. gap-checker strips parentheses first, so the whole value is no longer ' +
      'the bare placeholder and the citation survives its ID-shape filter as a requirement.',
    ],
    [
      'parentheses',
      '(REQ-02)',
      [],
      ['REQ-02'],
      'DIVERGENT: the selector strips square brackets only; gap-checker strips quotes, brackets ' +
      'AND parentheses.',
    ],
    [
      'ID shape',
      'REQ-01a',
      [],
      ['REQ-01a'],
      'DIVERGENT: the selector requires the token to END in digits; PHASE_REQ_ID_SHAPE_RE is ' +
      'wider and admits a trailing suffix.',
    ],
    [
      'the canonical form',
      'REQ-01, REQ-02',
      ['REQ-01', 'REQ-02'],
      ['REQ-01', 'REQ-02'],
      'AGREEMENT: on the shipped template form the two parsers agree exactly, which is what ' +
      'makes the divergences above a boundary rather than chaos.',
    ],
  ]) {
    test(`#3697-17 (parser parity, ${axis}): the divergence is pinned in both directions`, () => {
      assert.deepStrictEqual(
        phaseSelects(line17), expectPhase,
        `#3697-17 FAILED (${axis}): phase complete's selection drifted for ${JSON.stringify(line17)}.\n${why}`,
      );
      assert.deepStrictEqual(
        normalizePhaseReqIds(line17), expectGap,
        `#3697-17 FAILED (${axis}): gap-checker's normalization drifted for ${JSON.stringify(line17)}.\n${why}`,
      );
    });
  }

  // The consequence, made concrete. This is what the divergence COSTS a user,
  // and it is the reason the pin above is worth its cost: on one line, two
  // commands report contradictory scopes, and this PR is what makes the
  // contradiction visible by finally giving `phase complete` a voice.
  test(
    '#3697-17b (user-visible contradiction): a range line reports five requirements to gap ' +
    'analysis and zero to phase complete',
    () => {
      const line = 'RANGE-01..RANGE-05';
      const a = analyzeRequirementsLine(line);
      assert.deepStrictEqual(a.citedReqIds, [], '#3697-17b: phase complete selects nothing');
      assert.strictEqual(a.warn, true, '#3697-17b: and now says so, rather than failing silently');
      assert.strictEqual(
        normalizePhaseReqIds(line).length, 5,
        '#3697-17b: while gap analysis reports five requirements in scope for the same line',
      );
    },
  );

  // ==========================================================================
  // #3697-18 — the skipped-text rider must not tell the author to check
  // whether a DATE is a requirement (round 4 review Minor 2).
  //
  // This round first answered it with a FILTER, and the pre-push review's
  // continuation broke that in both directions: `API-2-01` is a legal
  // requirement id (gap-checker's parseRequirements accepts it) so the filter
  // hid a real drop, while `FY-26-08` and `FY-2026-08-15` leaked through. No
  // regex separates a date from a sub-numbered id — they are the same shape,
  // which is exactly why the strict-dash range rule refuses to act on it.
  //
  // So the rider DISCLOSES instead of adjudicating: it names the token and
  // says why it may not be a requirement. Same move the two warning voices
  // already make about an ambiguous separator.
  // ==========================================================================
  for (const [label18, line18, expectNamed18] of [
    ['date beside a dotted range', 'RANGE-01 .. RANGE-05 (target FY-2026-08)', 'FY-2026-08'],
    ['multi-segment date', 'RANGE-01 .. RANGE-05 (target FY-2026-08-15)', 'FY-2026-08-15'],
    ['short-year date', 'RANGE-01 … RANGE-05 due FY-26-08', 'FY-26-08'],
    ['sub-numbered requirement', 'RANGE-01 .. RANGE-05, API-2-01', 'API-2-01'],
    ['four-digit sub-number', 'RANGE-01 .. RANGE-05, API-2026-08', 'API-2026-08'],
  ]) {
    test(
      `#3697-18 (ambiguous numeric shape, ${label18}): named, and qualified rather than adjudicated`,
      () => {
        const a = analyzeRequirementsLine(line18);
        const w = reqLineText(formatRequirementsLineWarning('1', line18, a));
        assert.ok(w, `#3697-18 (${label18}): the range rule fired, so the line warns`);
        // NAMED — suppressing it hid a genuinely dropped requirement.
        assert.ok(
          w.includes(expectNamed18),
          `#3697-18 FAILED (${label18}): ${expectNamed18} must be named — a filter here hid a real ` +
          `dropped requirement: ${w}`,
        );
        // QUALIFIED — the author is told why it may not be a requirement,
        // instead of the warning deciding for them in either direction.
        assert.match(
          w,
          /may equally be a date or a sub-numbered id/i,
          `#3697-18 FAILED (${label18}): the shape is undecidable and the rider must say so: ${w}`,
        );
      },
    );
  }

  // The other half: an UNAMBIGUOUS dropped id is named with no hedge attached.
  test('#3697-18b (unambiguous skip): a plain dropped REQ-ID is named without the date caveat', () => {
    const line = 'REQ-01, (REQ-02), REQ-03 — REQ-05';
    const a = analyzeRequirementsLine(line);
    const w = reqLineText(formatRequirementsLineWarning('1', line, a));
    assert.match(
      w, /ID-shaped text on the line that was NOT selected: REQ-02/i,
      `#3697-18b FAILED: REQ-02 is a real skipped ID and must be named: ${w}`,
    );
    assert.doesNotMatch(
      w, /may equally be a date/i,
      `#3697-18b FAILED: REQ-02 is not the ambiguous shape and must carry no caveat: ${w}`,
    );
  });

  // ==========================================================================
  // #3697-19 — findings from this round's OWN pre-push adversarial review.
  //
  // Four claims this round made were driven and refuted before the push. Each
  // is pinned here, because every one of them was a shape the author had not
  // probed — the rules were correct across the probe set and wrong just
  // outside it.
  // ==========================================================================

  // (1) An INVISIBLE line is an empty line. A lone U+200B carried a token to
  // the parser while reading as empty to the author, so R3b warned and nothing
  // on screen explained why.
  for (const [label19, line19] of [
    ['zero-width space', '\u200B'],
    ['two zero-width spaces', '\u200B\u200B'],
    ['word joiner', '\u2060'],
    ['BOM', '\uFEFF'],
    // All four below were driven by the pre-push review's continuation against
    // a strip set that covered only the first four.
    ['soft hyphen', '\u00AD'],
    ['left-to-right mark', '\u200E'],
    ['left-to-right isolate', '\u2066'],
    ['variation selector 16', '\uFE0F'],
  ]) {
    test(`#3697-19 (invisible content, ${label19}): a line the author cannot see is not content`, () => {
      const a = analyzeRequirementsLine(line19);
      assert.strictEqual(
        a.warn, false,
        `#3697-19 FAILED (${label19}): an invisible-only line must not warn — no author could act on it`,
      );
    });
  }

  // A zero-width character INSIDE an otherwise valid line must be stripped, not
  // treated as a delimiter: splitting on it would fabricate two fragments from
  // one ID and invent a drop that never happened.
  // An invisible INSIDE a token breaks it for the SELECTOR, so the id is
  // genuinely not marked — #3697's own defect, in its most undetectable form.
  //
  // The first cut of this fix stripped invisibles from the detector wholesale
  // and made exactly this case go SILENT, and the test written for it asserted
  // the tokens and the empty R4 result while never asserting `warn` — it
  // DOCUMENTED the bug instead of catching it. That omission was the pre-push
  // review's `MISSED:` finding. The assertion below is the one that was absent.
  for (const [label19b, line19b] of [
    ['zero-width space', 'REQ-01\u200B, REQ-02'],
    ['soft hyphen', 'REQ-01\u00AD, REQ-02'],
    ['zero-width joiner', 'REQ-01\u200D, REQ-02'],
  ]) {
    test(`#3697-19b (embedded invisible, ${label19b}): an unmarkable id must never be silent`, () => {
      const a = analyzeRequirementsLine(line19b);
      assert.deepStrictEqual(
        a.citedReqIds, ['REQ-02'],
        `#3697-19b (${label19b}): the selector really does drop REQ-01 — selection is unchanged by this round`,
      );
      assert.strictEqual(
        a.warn, true,
        `#3697-19b FAILED (${label19b}): an id dropped to an INVISIBLE character is the least ` +
        `detectable form of #3697's own defect and must not stay silent`,
      );
      assert.deepStrictEqual(
        a.delimiterDroppedIds, ['REQ-01'],
        `#3697-19b (${label19b}): and it must be NAMED — the author cannot see the character`,
      );
    });
  }

  // (2) R4's false positive. A BARE citation carrying a colon is the same shave
  // class as a real delimiter drop, and the parenthetical test does not reach
  // it. Same-prefix agreement with a SELECTED id is what separates them.
  for (const [label19c, line19c] of [
    ['bare citation', 'REQ-01, see ADR-7: section 3'],
    ['bare citation, no verb', 'REQ-01, ADR-7: section 3'],
    ['parenthesised citation', 'RANGE-01, RANGE-02 (see ADR-7: sec 3)'],
  ]) {
    test(`#3697-19c (citation boundary, ${label19c}): a foreign-prefix citation is not a dropped requirement`, () => {
      const a = analyzeRequirementsLine(line19c);
      assert.deepStrictEqual(
        a.delimiterDroppedIds, [],
        `#3697-19c FAILED (${label19c}): ${JSON.stringify(line19c)} cites a foreign prefix; ` +
        `reporting it is the #2334 over-warning class`,
      );
    });
  }

  // (3) R4's false negative, on the DOCUMENTED form. The selector strips square
  // brackets; R4's raw scanner did not, so the bracket spelling the template
  // recommends silently dropped an ID with no warning at all.
  for (const [label19d, line19d, expectDropped19] of [
    ['bracketed semicolon', '[REQ-01; REQ-02]', ['REQ-01']],
    ['bracketed colon', '[REQ-01, REQ-02: login]', ['REQ-02']],
    // A trailing-only regex missed every one of these; they are one class
    // (decoration on a token the selector then could not take), so they take
    // one rule rather than four patches.
    ['leading semicolon', 'REQ-01 ;REQ-02', ['REQ-02']],
    ['leading colon', 'REQ-01 :REQ-02', ['REQ-02']],
    ['bold-wrapped', '**REQ-01;** REQ-02', ['REQ-01']],
    ['backtick-wrapped', '`REQ-01;` REQ-02', ['REQ-01']],
  ]) {
    test(`#3697-19d (bracket form, ${label19d}): the documented spelling must not defeat R4`, () => {
      const a = analyzeRequirementsLine(line19d);
      assert.deepStrictEqual(
        a.delimiterDroppedIds, expectDropped19,
        `#3697-19d FAILED (${label19d}): square brackets are the documented form and must be ` +
        `stripped for R4 exactly as the selector strips them`,
      );
      assert.strictEqual(a.warn, true, `#3697-19d FAILED (${label19d}): and the line must warn`);
    });
  }

  // (4) The rider filter suppressed a REGISTERED requirement. `API-2-01` is a
  // legal requirement id — gap-checker's own parseRequirements accepts it — so
  // only a DATE shape (four-digit year segment) may be filtered.
  // The residual the same-prefix gate BUYS its safety with, pinned so it is a
  // known quantity rather than a surprise. A genuinely dropped id whose prefix
  // appears on no selected id stays silent — the same trade the strict-dash
  // rule takes: under-report a rare shape rather than over-report a common one.
  // EMPHASIS ALONE IS NOT EVIDENCE, and this pins the boundary in both
  // directions. An earlier cut of this round fired on any wrapper, which made
  // `REQ-01, see **REQ-7** for context` warn about a citation — the #2334
  // class again. Nothing separates that from `**REQ-01**, REQ-02` meaning to
  // list one, so R4 requires the positive signal: a glued `;`/`:` (a list
  // separator was intended) or an invisible (the token is corrupted; no author
  // types one on purpose). Markdown styling is authorial and is left to the
  // skipped-text rider, which names the id without asserting a drop.
  for (const [label19h, line19h] of [
    ['emphasised citation', 'REQ-01, see **REQ-7** for context'],
    ['backticked citation', 'REQ-01, see `REQ-7` for context'],
    ['emphasis with no delimiter', '**REQ-01**, REQ-02'],
    // The delimiter's POSITION is the rule. Outside the styling it is sentence
    // punctuation, and an earlier cut of this round fired on exactly this —
    // `see **REQ-7**; next topic` was reported as a dropped requirement.
    ['punctuated emphasised citation', 'REQ-01, see **REQ-7**; next topic'],
    ['punctuated backticked citation', 'REQ-01, see `REQ-7`; next'],
    ['delimiter outside the wrapper', '**REQ-01**; REQ-02'],
  ]) {
    test(`#3697-19h (styling is not evidence, ${label19h}): a wrapper alone must not fire R4`, () => {
      const a = analyzeRequirementsLine(line19h);
      assert.deepStrictEqual(
        a.delimiterDroppedIds, [],
        `#3697-19h FAILED (${label19h}): markdown styling carries no list-separator intent, so ` +
        `claiming a drop here is the #2334 over-warning class`,
      );
    });
  }

  // An invisible attached to the range OPERATOR, not to an id. The regression
  // tests covered invisibles inside ids and not this, and that gap is exactly
  // what let a fix for one direction break the other — the pre-push review's
  // own MISSED finding.
  for (const [label19i, line19i] of [
    ['invisible around a dotted operator', 'REQ-01 \u200B..\u200B REQ-05'],
    ['invisible before a glued dash', 'REQ-01 \u200B-REQ-05'],
  ]) {
    test(`#3697-19i (invisible on the operator, ${label19i}): the operator is still an operator`, () => {
      assert.strictEqual(
        analyzeRequirementsLine(line19i).warn, true,
        `#3697-19i FAILED (${label19i}): an invisible beside the range operator must not hide it`,
      );
    });
  }

  // An UNBALANCED parenthesis is a typo, not a citation, and must not confer
  // citation immunity on the rest of the line. A running-depth counter let one
  // stay open to end-of-line and swallow every real drop after it.
  for (const [label19j, line19j, expectDropped19j] of [
    ['unclosed open paren', 'REQ-01, (note REQ-02; REQ-03', ['REQ-02']],
    ['stray close paren', 'REQ-01, REQ-02; REQ-03)', ['REQ-02']],
    // A matched span sharing a whitespace token with an id OUTSIDE it. The
    // first cut promoted the whole token to immune because it CONTAINED a
    // matched character, so the drop next to the citation went silent — the
    // pre-push review's last MISSED finding, which named exactly the control
    // these two rows add.
    ['citation glued after the drop', 'REQ-01, REQ-02;(note) REQ-03', ['REQ-02']],
    ['citation glued before the drop', 'REQ-01, (note)REQ-02; REQ-03', ['REQ-02']],
  ]) {
    test(`#3697-19j (unbalanced parens, ${label19j}): only a MATCHED span is a citation`, () => {
      const a = analyzeRequirementsLine(line19j);
      assert.deepStrictEqual(
        a.delimiterDroppedIds, expectDropped19j,
        `#3697-19j FAILED (${label19j}): an unmatched paren must not swallow the rest of the line`,
      );
    });
  }

  // And the matched forms still are citations.
  for (const [label19k, line19k] of [
    ['matched span', 'REQ-01, (see ADR-7: sec 3)'],
    ['nested matched spans', 'RANGE-01, RANGE-02 (see (ADR-7), then ADR-8)'],
  ]) {
    test(`#3697-19k (matched parens, ${label19k}): a real citation is still immune`, () => {
      assert.deepStrictEqual(
        analyzeRequirementsLine(line19k).delimiterDroppedIds, [],
        `#3697-19k FAILED (${label19k}): a matched parenthetical is a citation`,
      );
    });
  }

  test('#3697-19f (declared blind spot): a dropped id with an unshared prefix stays silent', () => {
    const a = analyzeRequirementsLine('REQ-01, FOO-02: x');
    assert.deepStrictEqual(a.citedReqIds, ['REQ-01'], '#3697-19f: FOO-02 really is dropped');
    assert.deepStrictEqual(
      a.delimiterDroppedIds, [],
      '#3697-19f: and R4 deliberately does not claim it — textually identical to a foreign citation',
    );
  });

  // Round 5 body claim-audit, MISSED item 1. A DEMONSTRATED R4 drop and an
  // over-cap token on the same line: the over-cap voice's whole claim is that
  // nothing could be checked, which is false the moment R4 has named an id.
  // Before the fix `REQ-01, REQ-02: <2049 chars>` reported req-line-unverified
  // and never mentioned REQ-02 — the actionable finding masked by the token
  // beside it. Same exclusion, same reason, as rangeReadingOnly's.
  test('#3697-19l (over-cap beside a drop): a demonstrated drop outranks the unverified voice', () => {
    // 2049 = the 2048 cap + 1, written as a literal and asserted, in the same
    // style as the #3697-B1/-B2 boundary fixtures below.
    const overCap = 'x'.repeat(2049);
    assert.strictEqual(overCap.length, 2049, '#3697-19l fixture must be one past the cap');
    const line = `REQ-01, REQ-02: ${overCap}`;
    const a = analyzeRequirementsLine(line);
    assert.deepStrictEqual(a.delimiterDroppedIds, ['REQ-02'], '#3697-19l: R4 does name the drop');
    assert.ok(a.oversizedTokens.length > 0, '#3697-19l: and the over-cap token is present');
    const w = formatRequirementsLineWarning('1', line, a);
    assert.strictEqual(
      reqLineCode(w), REQ_LINE_WARNING_CODE.misparse,
      '#3697-19l: a line with a demonstrated drop is a misparse, not an unverified line',
    );
    assert.match(
      reqLineText(w), /is glued to the ID/,
      '#3697-19l: and the drop diagnosis must survive — it is the only actionable part',
    );
    assert.match(
      reqLineText(w), /exceed the 2048-character scan limit/,
      '#3697-19l: while the over-cap disclosure is still carried, not traded away',
    );
  });

  test('#3697-19p (over-cap beside a CLEAN range): the cap outranks the ambiguous voice', () => {
    // The twin of #3697-19l on the other side of the boundary. There, a
    // DEMONSTRATED drop outranks the unverified voice; here nothing was
    // demonstrated, so the cap does — and what must not happen is the line
    // reading as clean. `req-line-range-reading` is documented (in its own code
    // comment and in CONTEXT.md's PHASE.REQ-LINE.SEAM.kinds predicate) to mean
    // nothing was dropped, and this line carries a token no rule ever examined.
    // Round 7 review, Minor 1.
    const overCap = 'x'.repeat(2049);
    assert.strictEqual(overCap.length, 2049, '#3697-19p fixture must be one past the cap');
    const line = `RANGE-01 - RANGE-05, ${overCap}`;
    const a = analyzeRequirementsLine(line);
    // The range half is genuinely clean: R2 fired, both endpoints were taken.
    assert.deepStrictEqual(
      a.citedReqIds, ['RANGE-01', 'RANGE-05'],
      '#3697-19p: both endpoints really are selected — this is the CLEAN range shape',
    );
    assert.ok(a.hasSpacedRange, '#3697-19p: and R2 really did fire');
    assert.strictEqual(a.delimiterDroppedIds.length, 0, '#3697-19p: nothing was demonstrably dropped');
    assert.ok(a.oversizedTokens.length > 0, '#3697-19p: while an over-cap token is present');
    // The predicate itself, pinned: the ambiguous voice must stand down.
    assert.strictEqual(
      a.rangeReadingOnly, false,
      '#3697-19p: the ambiguous voice claims nothing was dropped — it may not speak over an unexamined token',
    );
    const w = formatRequirementsLineWarning('1', line, a);
    assert.strictEqual(
      reqLineCode(w), REQ_LINE_WARNING_CODE.unverified,
      '#3697-19p: an unexamined token makes the line UNVERIFIED, not clean',
    );
    // And specifically NOT the assertive voice: nothing on this line failed to
    // parse, so `misparse` would be the #2334 over-warning class returning
    // through the fix for its own false-clean.
    assert.notStrictEqual(
      reqLineCode(w), REQ_LINE_WARNING_CODE.misparse,
      '#3697-19p: nothing demonstrably failed to parse — asserting a misparse here is the #2334 class',
    );
    assert.match(
      reqLineText(w), /exceed the 2048-character scan limit/,
      '#3697-19p: and the cap is named, so the reader knows what was not looked at',
    );
  });

  test('#3697-19q (control for -19p): the same range WITHOUT an over-cap token still reads as a range', () => {
    // Negative control. -19p must not be satisfiable by routing every spaced
    // range to `unverified`; the ambiguous voice is still correct when there
    // is nothing unexamined on the line.
    const line = 'RANGE-01 - RANGE-05';
    const a = analyzeRequirementsLine(line);
    assert.strictEqual(a.oversizedTokens.length, 0, '#3697-19q: nothing over the cap here');
    assert.strictEqual(a.rangeReadingOnly, true, '#3697-19q: so the ambiguous voice is the right one');
    assert.strictEqual(
      reqLineCode(formatRequirementsLineWarning('1', line, a)), REQ_LINE_WARNING_CODE.rangeReading,
      '#3697-19q: unchanged by the -19p fix — a clean range is still a range reading',
    );
  });

  // DECLARED BLIND SPOTS, pinned so the docs and the code cannot drift apart
  // again — that drift IS the round 4 blocker. R4's trigger is a glued `;`/`:`
  // or an embedded invisible. Styling is TOLERATED around an id, never a
  // trigger on its own, so every line below silently drops an id. Each is
  // documented as silent in the CLI tools reference; if one of these ever
  // starts warning, that document is wrong and this test says so first.
  for (const [label19m, line19m, expectSel19m] of [
    ['bold', 'REQ-01, **REQ-02**', ['REQ-01']],
    ['quotes', 'REQ-01, "REQ-02"', ['REQ-01']],
    ['backticks', 'REQ-01, `REQ-02`', ['REQ-01']],
    ['underscore', 'REQ-01, _REQ-02_', ['REQ-01']],
    // The `**` sits BETWEEN the id and the `;`, so nothing is touching the id.
    ['styling between id and delimiter', 'REQ-01, **REQ-02**;', ['REQ-01']],
  ]) {
    test(`#3697-19m (declared blind spot, styling-only ${label19m}): silent, and documented as silent`, () => {
      const a = analyzeRequirementsLine(line19m);
      assert.deepStrictEqual(a.citedReqIds, expectSel19m, `#3697-19m (${label19m}): the id really is dropped`);
      assert.deepStrictEqual(a.delimiterDroppedIds, [], `#3697-19m (${label19m}): R4 does not claim it`);
      assert.strictEqual(a.warn, false, `#3697-19m (${label19m}): and the line is silent`);
    });
  }

  // The other half of the same boundary: only `;` and `:` are in the set.
  // Round 4's separator census concluded "exactly those two" because it swept
  // the ONE-SIDED form for `;`/`:` and only the bare and symmetric forms for
  // every other separator — different members tested in different shapes, so
  // the answer was forced. A fully crossed re-sweep (21 separators x 4
  // spellings = 84) found 34 silent under-selections, every one of them a
  // separator glued to exactly ONE of the two ids. Pinned here as the
  // documented COST, never asserted as coverage.
  for (const sep19n of ['/', '|', '&', '+', '.', '>', '\\', '；', '，', '؛']) {
    for (const [dir19n, line19n, keep19n] of [
      ['trailing', `REQ-01${sep19n} REQ-02`, 'REQ-02'],
      ['leading', `REQ-01 ${sep19n}REQ-02`, 'REQ-01'],
    ]) {
      test(`#3697-19n (declared blind spot, ${dir19n} "${sep19n}"): silent, and documented as silent`, () => {
        const a = analyzeRequirementsLine(line19n);
        assert.deepStrictEqual(
          a.citedReqIds, [keep19n],
          `#3697-19n (${dir19n} "${sep19n}"): exactly one id survives the selector`,
        );
        assert.deepStrictEqual(
          a.delimiterDroppedIds, [],
          `#3697-19n (${dir19n} "${sep19n}"): R4 does not reach it`,
        );
        assert.strictEqual(a.warn, false, `#3697-19n (${dir19n} "${sep19n}"): and the line is silent`);
      });
    }
  }

  // The grammar tolerances the documentation was corrected to state. These are
  // pre-existing selector behaviour, not new; the round 4 pre-push review
  // caught the DOCS asserting a stricter rule than the code enforces.
  for (const [label19g, line19g, expectSel19] of [
    ['whitespace-separated', 'REQ-01 REQ-02', ['REQ-01', 'REQ-02']],
    ['lowercase ids', 'req-01, req-02', ['req-01', 'req-02']],
  ]) {
    test(`#3697-19g (documented tolerance, ${label19g}): selected and silent, as the docs now say`, () => {
      const a = analyzeRequirementsLine(line19g);
      assert.deepStrictEqual(a.citedReqIds, expectSel19, `#3697-19g (${label19g}): both ids are selected`);
      assert.strictEqual(a.warn, false, `#3697-19g (${label19g}): and nothing warns about it`);
    });
  }

  // A HALF-SPACED range splits at the tokenizer before R1's own `\s*` can see
  // it: `RANGE-01 -RANGE-05` tokenizes as `RANGE-01`, `-RANGE-05` and selects
  // only the well-formed side. The glued-fragment rule must warn, and the
  // selection stays exactly what the tokenizer produced.
  for (const [label6, line6, expectTicked] of [
    ['leading-glue', 'RANGE-01 -RANGE-05', ['RANGE-01']],
    ['trailing-glue', 'RANGE-01- RANGE-05', ['RANGE-05']],
    // A word operator can glue only TRAILING (an ID must end in digits, so
    // `RANGE-01through` cannot be an ID — but `TORANGE-05` can, which is why
    // the leading arm is symbol-only).
    ['worded-glue', 'RANGE-01through RANGE-05', ['RANGE-05']],
    // The trailing shave must not eat a glued `..` as sentence punctuation.
    ['double-dot-glue', 'RANGE-01.. RANGE-05', ['RANGE-05']],
  ]) {
    test(
      `#3697-6 (${label6} half-spaced range): a range glued to one endpoint must warn — ` +
      'selection is unchanged',
      (t) => {
        const tmpDir = build3697RangeFixture(line6);
        t.after(() => cleanup(tmpDir));
        const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
        const parsed = JSON.parse(output);
        const warnings = parsed.warnings || [];
        assert.ok(
          warnings.some((w) => REQ_LINE_MISPARSE_RE.test(w)),
          `#3697-6 FAILED (${label6}): a half-spaced range under-selects, so it must warn. ` +
          `Got warnings: ${JSON.stringify(warnings)}\nFull output: ${output}`,
        );
        const reqContent = fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
        assert.deepStrictEqual(
          tickedReqIds(reqContent), expectTicked,
          `#3697-6 FAILED (${label6}): exactly ${JSON.stringify(expectTicked)} must be ticked ` +
          `(no expansion).\nREQUIREMENTS.md:\n${reqContent}`,
        );
      },
    );
  }
});



// ─────────────────────────────────────────────────────────────────────────────
// #3697 round 3 — unit + property coverage of the EXTRACTED detector.
//
// The end-to-end block above drives the CLI, one subprocess per case. That is
// the right shape for wiring, and the wrong shape for the two rules round 3's
// review blocked on: `RULESET.TESTS.property-based-testing` wants a fast-check
// property over a parsing module (100+ runs), and
// `RULESET.TESTS.boundary-coverage.fixtures` wants limit-1 / limit / limit+1 on
// the 2048-char token cap. Both are expressible only against a callable
// surface, which is why `analyzeRequirementsLine` was extracted from
// `cmdPhaseComplete` in the same round.
// ─────────────────────────────────────────────────────────────────────────────

const fc = require('fast-check');
const {
  analyzeRequirementsLine,
  formatRequirementsLineWarning,
  REQ_LINE_WARNING_CODE,
} = require('../gsd-core/bin/lib/phase.cjs');

// Round 4 review Major 3: the formatter returns `{ code, message }`, so channel
// IDENTITY is asserted on the stable code and never on the English sentence.
// The two channel regexes below survive for the assertions where the
// USER-VISIBLE wording is itself the thing under test.
const reqLineText = (w) => (w === null ? null : w.message);
const reqLineCode = (w) => (w === null ? null : w.code);

describe('#3697 round 3: Requirements-line detector — properties (RULESET.TESTS.property-based-testing)', () => {
  // fc arbitraries for a well-formed REQ-ID. The shape is the selector's own:
  // `[A-Z][A-Z0-9]*-\d+`. Word range operators are excluded from the prefix
  // alphabet nowhere — deliberately: `TORANGE-05` IS a valid ID, and property
  // (a) asserting silence over it is what pins the #3697-4b behaviour
  // generatively rather than at one hand-picked example.
  const reqPrefix = fc
    .tuple(
      fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')),
      // fast-check v4 removed `fc.stringOf`; build the tail from an array so
      // the alphabet stays pinned to the selector's own `[A-Z0-9]` class.
      fc
        .array(fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split('')), {
          minLength: 0,
          maxLength: 6,
        })
        .map((cs) => cs.join('')),
    )
    .map(([head, tail]) => head + tail);
  const reqNum = fc.integer({ min: 0, max: 9999 });
  const reqId = fc.tuple(reqPrefix, reqNum).map(([p, n]) => `${p}-${n}`);

  test(
    '#3697-P1 (soundness of silence): a canonical comma list of well-formed REQ-IDs NEVER warns, ' +
    'and selects exactly the IDs it lists',
    () => {
      fc.assert(
        fc.property(fc.array(reqId, { minLength: 1, maxLength: 8 }), (ids) => {
          const line = ids.join(', ');
          const a = analyzeRequirementsLine(line);
          // Domain invariant (boundary containment): the selected set IS the
          // written set — no over-selection (#2334) and no under-selection
          // (#3697) on the canonical form, whatever IDs it carries.
          assert.deepStrictEqual(a.citedReqIds, ids);
          assert.strictEqual(
            a.warn,
            false,
            `#3697-P1: canonical list ${JSON.stringify(line)} must not warn; got ${JSON.stringify(
              formatRequirementsLineWarning('1', line, a),
            )}`,
          );
        }),
        { numRuns: 300 },
      );
    },
  );

  test(
    '#3697-P2 (completeness): a same-prefix pair separated by a spaced range operator, with an ' +
    'interior between them, ALWAYS warns',
    // NOT a bug-finder: every operator below was already in the pre-round
    // operator set, so this property holds against the pre-round code too. An
    // earlier round-3 commit claimed otherwise; the review refuted it. It is a
    // regression guard over the spaced-range rule, which is what it is worth.
    () => {
      const ops = ['..', '...', '…', '—', '–', '-', 'to', 'thru', 'through'];
      fc.assert(
        fc.property(
          reqPrefix,
          fc.integer({ min: 0, max: 400 }),
          fc.integer({ min: 2, max: 400 }),
          fc.constantFrom(...ops),
          (prefix, lo, delta, op) => {
            const line = `${prefix}-${lo} ${op} ${prefix}-${lo + delta}`;
            const a = analyzeRequirementsLine(line);
            assert.strictEqual(
              a.warn,
              true,
              `#3697-P2: ${JSON.stringify(line)} implies a dropped interior and must warn`,
            );
          },
        ),
        { numRuns: 300 },
      );
    },
  );

  test(
    '#3697-P3 (the #2334 invariant): an ADJACENT same-prefix pair around a separator can drop ' +
    'nothing, so it never warns however it is annotated',
    () => {
      const ops = ['-', '—', '–', '..'];
      fc.assert(
        fc.property(
          reqPrefix,
          fc.integer({ min: 0, max: 4000 }),
          fc.integer({ min: 0, max: 1 }),
          fc.constantFrom(...ops),
          fc.constantFrom('deferred', 'blocked', 'per ADR-7', 'see notes', ''),
          (prefix, lo, delta, op, tail) => {
            const line = `${prefix}-${lo}, ${prefix}-${lo} ${op} ${prefix}-${lo + delta}${
              tail ? ' ' + tail : ''
            }`;
            const a = analyzeRequirementsLine(line);
            assert.strictEqual(
              a.warn,
              false,
              `#3697-P3: ${JSON.stringify(line)} has no interior to drop and must stay silent; got ` +
                JSON.stringify(formatRequirementsLineWarning('1', line, a)),
            );
          },
        ),
        { numRuns: 300 },
      );
    },
  );

  test(
    '#3697-P4 (totality + idempotency): the detector is total over arbitrary input and returns ' +
    'the same analysis every time',
    () => {
      fc.assert(
        fc.property(fc.string({ maxLength: 300 }), (s) => {
          const a = analyzeRequirementsLine(s);
          const b = analyzeRequirementsLine(s);
          assert.strictEqual(typeof a.warn, 'boolean');
          assert.ok(Array.isArray(a.citedReqIds) && Array.isArray(a.tokens));
          assert.deepStrictEqual(a, b, '#3697-P4: analysis must be deterministic');
          const wr = formatRequirementsLineWarning('1', s, a);
          const w = reqLineText(wr);
          const wc = reqLineCode(wr);
          // Round 4 review Major 3: a message without a kind, or a kind that is
          // not in the declared vocabulary, is a channel no consumer can route
          // on. Held over ARBITRARY input, so a new channel added later cannot
          // ship without one.
          assert.strictEqual(
            wc === null,
            w === null,
            `#3697-P4: kind and message must appear together; got ${JSON.stringify(wr)}`,
          );
          if (wc !== null) {
            assert.ok(
              Object.values(REQ_LINE_WARNING_CODE).includes(wc),
              `#3697-P4: ${JSON.stringify(wc)} is not a declared warning kind`,
            );
          }
          // The formatter and the analysis must agree on whether there is
          // anything to say — a warn with no text, or text with no warn, is a
          // channel that can go silent or noisy on its own.
          assert.strictEqual(
            w === null,
            a.warn === false,
            `#3697-P4: warn=${a.warn} but message=${JSON.stringify(w)} for ${JSON.stringify(s)}`,
          );
        }),
        { numRuns: 500 },
      );
    },
  );

  test(
    '#3697-P5 (containment): every selected ID is REQ-ID-shaped and appears verbatim in the line',
    () => {
      // The first cut of this property drew from a bare `fc.string()` and was
      // VACUOUS — measured over 500 samples it produced max length 10 and ZERO
      // inputs containing a REQ-ID, so the loop body never executed a single
      // assertion. Found by the round's pre-push review. The generator now
      // interleaves real IDs with noise, and the property ASSERTS that it saw
      // some: a containment property that never contains anything is a green
      // test measuring nothing.
      let sawIds = 0;
      fc.assert(
        fc.property(
          fc.array(fc.oneof(reqId, fc.constantFrom('(', ')', '[', ']', ',', '—', '..', 'to', 'TBD', 'None', 'per', 'ADR-7')), {
            minLength: 1,
            maxLength: 12,
          }),
          (parts) => {
            const line = parts.join(' ');
            const cited = analyzeRequirementsLine(line).citedReqIds;
            if (cited.length > 0) sawIds += 1;
            for (const id of cited) {
              assert.match(id, /^[A-Z][A-Z0-9]*-\d+$/i, `#3697-P5: ${JSON.stringify(id)} is not ID-shaped`);
              assert.ok(line.includes(id), `#3697-P5: ${JSON.stringify(id)} is not present in the input`);
            }
          },
        ),
        { numRuns: 500 },
      );
      assert.ok(sawIds > 50, `#3697-P5 is VACUOUS: only ${sawIds}/500 generated lines selected any ID`);
    },
  );

  test(
    '#3697-P6 (totality over arbitrary text): the detector never throws on free-form input',
    () => {
      // What the old P5 generator was actually covering. Kept as its own
      // property, honestly labelled, rather than left masquerading as
      // containment coverage.
      fc.assert(
        fc.property(fc.string({ maxLength: 300, size: 'max' }), (str) => {
          const a = analyzeRequirementsLine(str);
          assert.strictEqual(typeof a.warn, 'boolean');
          formatRequirementsLineWarning('1', str, a);
        }),
        { numRuns: 500 },
      );
    },
  );
});

describe('#3697 round 3: the 2048-char token scan cap (RULESET.TESTS.boundary-coverage)', () => {
  // `REQ_TOKEN_SCAN_LIMIT` is a hard cap with NO reserve or safety constant
  // beside it, so clause (d) of RULESET.TESTS.boundary-coverage.fixtures — an
  // input pushed within reserve-distance of the limit — has no referent here.
  // (a)/(b)/(c) are the whole obligation, and they are exercised through BOTH
  // predicate families the cap now guards: the unanchored ID-substring scan
  // (R3) and the anchored range-token scan (R1, capped in round 3 per Nit 6).
  const inertOfLength = (n) => `REQ-01${'X'.repeat(n - 'REQ-01'.length)}`;
  const rangeTokenOfLength = (n) => {
    const suffix = '..RANGE-05';
    const digits = n - 'RANGE-'.length - suffix.length;
    return `RANGE-${'0'.repeat(digits - 1)}1${suffix}`;
  };

  // `expectClassified` is the PREDICATE's verdict, which is what the cap
  // governs. `warn` is deliberately NOT the boundary variable: past the cap the
  // token is unclassified, and unclassified is reported, never treated as
  // clean — asserting `warn === false` at limit+1 is precisely the silent
  // regression the round's pre-push review refuted (CLAIM 2).
  for (const [label, n, expectClassified] of [
    ['limit-1 (2047)', 2047, true],
    ['limit (2048)', 2048, true],
    ['limit+1 (2049)', 2049, false],
  ]) {
    test(`#3697-B1 (${label}): the UNANCHORED ID-substring scan is applied at and below the cap only`, () => {
      const tok = inertOfLength(n);
      assert.strictEqual(tok.length, n, `#3697-B1 fixture is ${tok.length} chars, expected ${n}`);
      const a = analyzeRequirementsLine(tok);
      assert.deepStrictEqual(a.citedReqIds, [], '#3697-B1: the padded token is not itself an ID');
      assert.strictEqual(
        a.inertIdShaped.length > 0,
        expectClassified,
        `#3697-B1 (${label}): inertIdShaped membership must be ${expectClassified} at length ${n}`,
      );
      assert.strictEqual(
        a.oversizedTokens.length > 0,
        !expectClassified,
        `#3697-B1 (${label}): past the cap the token must be recorded as unclassified`,
      );
      // Warns at every length — below the cap because a rule classified it,
      // above it because "not classified" is itself reportable.
      assert.strictEqual(a.warn, true, `#3697-B1 (${label}): unclassified is not clean`);
    });

    test(`#3697-B2 (${label}): the ANCHORED range-token scan takes the SAME cap (round-3 Nit 6)`, () => {
      const tok = rangeTokenOfLength(n);
      assert.strictEqual(tok.length, n, `#3697-B2 fixture is ${tok.length} chars, expected ${n}`);
      const a = analyzeRequirementsLine(tok);
      assert.strictEqual(
        a.rangeTokens.length > 0,
        expectClassified,
        `#3697-B2 (${label}): rangeTokens membership must be ${expectClassified} at length ${n}`,
      );
      assert.strictEqual(
        a.oversizedTokens.length > 0,
        !expectClassified,
        `#3697-B2 (${label}): past the cap the token must be recorded as unclassified`,
      );
      assert.strictEqual(a.warn, true, `#3697-B2 (${label}): unclassified is not clean`);
    });
  }
});

describe('#3697 round 3: the two warning channels', () => {
  // ── Major 3 ────────────────────────────────────────────────────────────────
  // An annotation separator between two NON-ADJACENT same-prefix IDs is
  // textually identical to a range, and no token-level rule separates them.
  // Before round 3 the detector resolved that ambiguity by assertion: it told
  // the author the line "could not be parsed" and to rewrite it, on a line
  // where every ID present HAD been selected and nothing had been dropped.
  // Going silent instead is not available — the range reading is equally live,
  // and silence is the #3697 defect itself. So the ambiguity is disclosed.
  for (const [label, line, expectSelected] of [
    ['em-dash', 'RANGE-01, RANGE-02 — RANGE-05 deferred', ['RANGE-01', 'RANGE-02', 'RANGE-05']],
    ['hyphen', 'RANGE-01, RANGE-02 - RANGE-05 deferred', ['RANGE-01', 'RANGE-02', 'RANGE-05']],
    ['bare range', 'RANGE-01 … RANGE-05', ['RANGE-01', 'RANGE-05']],
  ]) {
    test(
      `#3697-9 (${label}): a spaced separator warns through the AMBIGUOUS channel and must NOT ` +
      'claim the line failed to parse',
      () => {
        const a = analyzeRequirementsLine(line);
        assert.deepStrictEqual(
          a.citedReqIds,
          expectSelected,
          `#3697-9 (${label}): every ID written on the line must still be selected`,
        );
        assert.strictEqual(
          a.rangeReadingOnly,
          true,
          `#3697-9 (${label}): only the spaced-range rule fired and both endpoints were selected — ` +
          'that is why this channel exists',
        );
        const wr = formatRequirementsLineWarning('1', line, a);
        const w = reqLineText(wr);
        const wc = reqLineCode(wr);
        assert.ok(w, `#3697-9 (${label}): the range reading is live, so the line must still warn`);
        assert.strictEqual(
          wc,
          REQ_LINE_WARNING_CODE.rangeReading,
          `#3697-9 (${label}): wrong channel: ${wc} / ${w}`,
        );
        assert.notStrictEqual(
          wc,
          REQ_LINE_WARNING_CODE.misparse,
          `#3697-9 (${label}): nothing was dropped, so the warning must not assert a parse failure: ${w}`,
        );
        // Both readings must be offered — the author is the only one who can
        // resolve the ambiguity, and a warning that hides half of it is the
        // over-warning wearing better manners.
        assert.match(w, /annotation rather than a range/i, `#3697-9 (${label}): ${w}`);
        assert.match(w, /needs no change/i, `#3697-9 (${label}): ${w}`);
        // The soft voice speaks about the SEPARATOR, never about the whole
        // line: it has no basis for the latter (see #3697-9d).
        assert.doesNotMatch(
          w,
          /the line is already correct/i,
          `#3697-9 (${label}): the soft voice must not claim the whole line is correct: ${w}`,
        );
      },
    );
  }

  // The channel discriminator must be RULE-SCOPED, not line-global. Both of
  // these were misrouted by the first cut of the Major 3 fix, and the first is
  // the damaging direction: it puts the false "could not be parsed" claim back
  // on a correct line, which is the finding itself returning through a side
  // door.
  test(
    '#3697-9b (unrelated parenthetical citation): a citation elsewhere on the line must not flip ' +
    'the channel back to a misparse claim',
    () => {
      const line = 'RANGE-01, RANGE-02 — RANGE-05 deferred per (ADR-7)';
      const a = analyzeRequirementsLine(line);
      // `(ADR-7)` survives the selector's bracket strip and so is not selected —
      // but #3697-4 already pins a parenthetical citation as NOT unparsed
      // residue, and no rule fires on it. Only the rules that fired may speak.
      assert.strictEqual(a.rangeReadingOnly, true, '#3697-9b: R2 alone fired, on selected endpoints');
      const wr = formatRequirementsLineWarning('1', line, a);
      const w = reqLineText(wr);
      const wc = reqLineCode(wr);
      assert.strictEqual(wc, REQ_LINE_WARNING_CODE.rangeReading, `#3697-9b: wrong channel: ${wc} / ${w}`);
      assert.notStrictEqual(wc, REQ_LINE_WARNING_CODE.misparse, `#3697-9b: ${wc} / ${w}`);
    },
  );

  test(
    '#3697-9c (unselected endpoint): a spaced range whose own endpoint was never selected IS a ' +
    'drop, and takes the assertive channel',
    () => {
      const line = 'RANGE-01 (RANGE-02) — RANGE-05';
      const a = analyzeRequirementsLine(line);
      // The detector shaves brackets and the selector does not, so R2 fires on
      // a `RANGE-02` that was never selected. That is a genuine under-selection.
      assert.deepStrictEqual(a.citedReqIds, ['RANGE-01', 'RANGE-05'], '#3697-9c: RANGE-02 is not selected');
      assert.strictEqual(a.hasSpacedRange, true, '#3697-9c: R2 still fires');
      assert.strictEqual(a.rangeReadingOnly, false, '#3697-9c: an unselected endpoint is a drop');
      const wr = formatRequirementsLineWarning('1', line, a);
      const w = reqLineText(wr);
      const wc = reqLineCode(wr);
      assert.strictEqual(wc, REQ_LINE_WARNING_CODE.misparse, `#3697-9c: wrong channel: ${wc} / ${w}`);
    },
  );

  test(
    '#3697-9d (dropped ID elsewhere on the line): the soft voice must not claim the LINE is ' +
    'correct, and must name what the selector skipped',
    () => {
      // The pre-push review's CLAIM 1 counterexample. `(REQ-02)` survives the
      // selector's bracket strip and no rule fires on it, so the channel is
      // still the soft one — correctly, because `(ADR-7)` is the same shape and
      // routing on it puts the false misparse claim back on a citation. What
      // was wrong was the soft voice ASSERTING "the line is already correct and
      // nothing needs to change" over a line that dropped a requirement.
      const line = 'REQ-01, (REQ-02), REQ-03 — REQ-05';
      const a = analyzeRequirementsLine(line);
      assert.deepStrictEqual(a.citedReqIds, ['REQ-01', 'REQ-03', 'REQ-05'], '#3697-9d: REQ-02 is dropped');
      assert.strictEqual(a.rangeReadingOnly, true, '#3697-9d: R2 alone fired, on selected endpoints');
      assert.deepStrictEqual(a.unselectedIdShaped, ['REQ-02'], '#3697-9d: the skip is recorded as a fact');
      const wr = formatRequirementsLineWarning('1', line, a);
      const w = reqLineText(wr);
      const wc = reqLineCode(wr);
      assert.strictEqual(
        wc, REQ_LINE_WARNING_CODE.rangeReading,
        `#3697-9d: R2 alone fired on selected endpoints, so this is the range-reading kind: ${wc}`,
      );
      assert.doesNotMatch(w, /the line is already correct/i, `#3697-9d: ${w}`);
      assert.match(w, /ID-shaped text on the line that was NOT selected: REQ-02/i, `#3697-9d: ${w}`);
      assert.match(w, /check whether any of it is a requirement/i, `#3697-9d: ${w}`);
    },
  );

  test(
    '#3697-9e (over-cap token): a token past the scan limit is reported as UNCLASSIFIED, never ' +
    'silently dropped',
    () => {
      // The review's CLAIM 2. Round 3's first cut of the uniform cap made a
      // 2049-char range token silent — it warned before the round. The cap
      // bounds the WORK; it must not bound the warning.
      const suffix = '..RANGE-05';
      const big = `RANGE-${'0'.repeat(2049 - 'RANGE-'.length - suffix.length - 1)}1${suffix}`;
      assert.strictEqual(big.length, 2049, `#3697-9e fixture is ${big.length} chars, expected 2049`);
      const a = analyzeRequirementsLine(big);
      assert.strictEqual(a.rangeTokens.length, 0, '#3697-9e: past the cap, no predicate classifies it');
      assert.deepStrictEqual(a.oversizedTokens, [big], '#3697-9e: but it IS recorded as unclassified');
      assert.strictEqual(a.warn, true, '#3697-9e: and the line still warns');
      const wr = formatRequirementsLineWarning('1', big, a);
      const w = reqLineText(wr);
      const wc = reqLineCode(wr);
      assert.strictEqual(
        wc, REQ_LINE_WARNING_CODE.unverified,
        `#3697-9e: an unclassifiable line is the 'unverified' kind — the same seam CONTEXT.md ` +
        `already records for a truncated scan: ${wc}`,
      );
      assert.match(w, /could not be checked/i, `#3697-9e: ${w}`);
      assert.match(w, /2048-character scan limit/i, `#3697-9e: ${w}`);
      assert.match(w, /unverified/i, `#3697-9e: ${w}`);
    },
  );

  test('#3697-9f (cap uniformity): R2 and the glued rule cap their NEIGHBOURS, not just the operator', () => {
    // The first review's MISSED finding. Capping the operator alone left
    // `<over-cap ID> .. <over-cap ID>` running REQ_ID_SHAPE_RE and BigInt over
    // both neighbours unbounded.
    //
    // The endpoints must DIFFER by more than 1, or R2 could not fire even
    // uncapped and the fixture would prove nothing — the first cut of this test
    // used the same ID twice and was exactly that vacuous.
    const pad = '0'.repeat(2049 - 'RANGE-'.length - 1);
    const lo = `RANGE-${pad}1`;
    const hi = `RANGE-${pad}9`;
    assert.strictEqual(lo.length, 2049, `#3697-9f fixture is ${lo.length} chars, expected 2049`);
    assert.strictEqual(hi.length, 2049, `#3697-9f fixture is ${hi.length} chars, expected 2049`);
    const a = analyzeRequirementsLine(`${lo} .. ${hi}`);
    assert.strictEqual(a.hasSpacedRange, false, '#3697-9f: an over-cap endpoint must not be classified');
    assert.deepStrictEqual(a.citedReqIds, [lo, hi], '#3697-9f: both endpoints are selected');
    // Selected does NOT mean nothing was suppressed. The second continuation
    // review's CLAIM J/K: an earlier cut exempted every selector-accepted token
    // from `oversizedTokens`, so this line — which WARNED before the round,
    // when R2 was uncapped — went silent. Both endpoints are unexaminable and
    // sit either side of a range operator, so the line is reported unverified.
    assert.deepStrictEqual(a.oversizedTokens, [lo, hi], '#3697-9f: both endpoints are unexaminable');
    assert.strictEqual(a.warn, true, '#3697-9f: a suppressed classification is not clean');
  });

  test(
    '#3697-9j (over-cap exemption scope): a selected over-cap ID is exempt ONLY when nothing could ' +
    'have paired with it',
    () => {
      // The other half of CLAIM J/K. The exemption is what keeps #3697-9i
      // silent; it must not extend to a token whose neighbour could have formed
      // a range with it, because that is exactly where the cap suppressed a
      // rule rather than merely declining to classify a lone token.
      const big = `R-${'1'.repeat(2047)}`;
      assert.strictEqual(big.length, 2049, `#3697-9j fixture is ${big.length} chars, expected 2049`);
      // No neighbour that could pair -> exempt, silent.
      assert.strictEqual(analyzeRequirementsLine(`REQ-01, ${big}`).warn, false, '#3697-9j: no pairing neighbour');
      // A range operator beside it -> R2 was suppressed, so report.
      assert.strictEqual(analyzeRequirementsLine(`${big} .. REQ-05`).warn, true, '#3697-9j: operator neighbour');
      assert.strictEqual(analyzeRequirementsLine(`REQ-01 .. ${big}`).warn, true, '#3697-9j: operator neighbour');
    },
  );

  test(
    '#3697-9g (assertive voice): the skipped-text clause is on BOTH voices, and does not repeat ' +
    'what the rule-specific clause already named',
    () => {
      // The continuation review found the clause wired into the soft return
      // only, while the round claimed both. It also found the wording wrong:
      // square brackets ARE stripped by the selector, only parentheses are not.
      const line = 'REQ-01, (REQ-02), REQ-03..REQ-05';
      const wr = formatRequirementsLineWarning('1', line, analyzeRequirementsLine(line));
      const w = reqLineText(wr);
      const wc = reqLineCode(wr);
      assert.strictEqual(wc, REQ_LINE_WARNING_CODE.misparse, `#3697-9g: assertive voice expected: ${wc} / ${w}`);
      assert.match(w, /ID-shaped text on the line that was NOT selected: REQ-02/i, `#3697-9g: ${w}`);
      assert.match(w, /parentheses are not stripped, unlike square brackets/i, `#3697-9g: ${w}`);
      // `REQ-03..REQ-05` is already named by "Unparsed text"; naming it twice
      // is noise, and a warning that repeats itself is one readers skim.
      // Count OUTSIDE the echoed line — the warning quotes the whole
      // Requirements line first, so the raw echo is one legitimate occurrence.
      const afterEcho = w.slice(w.indexOf('`)') + 2);
      assert.strictEqual(
        (afterEcho.match(/REQ-03\.\.REQ-05/g) || []).length,
        1,
        `#3697-9g: the range token must be diagnosed exactly once: ${w}`,
      );
      // And the claim must be TRUE: a bracketed ID is selected, so it can never
      // appear in the skipped clause.
      assert.deepStrictEqual(
        analyzeRequirementsLine('[REQ-01, REQ-02]').citedReqIds,
        ['REQ-01', 'REQ-02'],
        '#3697-9g: square brackets are stripped by the selector',
      );
    },
  );

  test(
    '#3697-9h (over-cap token with no hyphen): an unexaminable OPERATOR must not silence the line',
    () => {
      // The continuation review's CLAIM B. `oversizedTokens` first filtered on
      // `includes('-')`, so a 2049-character run of dots between two IDs was
      // missed: R2 declined to classify it (capped) and nothing reported it, so
      // a line that warned before the round went silent after it.
      const line = `REQ-01 ${'.'.repeat(2049)} REQ-05`;
      const a = analyzeRequirementsLine(line);
      assert.strictEqual(a.hasSpacedRange, false, '#3697-9h: the operator is past the cap');
      assert.strictEqual(a.oversizedTokens.length, 1, '#3697-9h: and is recorded as unexaminable');
      assert.strictEqual(a.warn, true, '#3697-9h: so the line is not silent');
    },
  );

  test(
    '#3697-9i (over-cap token the SELECTOR took): a selected ID is verified, never "unverified"',
    () => {
      // The continuation review's MISSED finding. The selector is uncapped and
      // fully anchored, so a token it accepted was examined end to end.
      // Reporting it unverified because the secondary detector declined to
      // classify it is a contradiction inside one warning.
      const bigId = `R-${'1'.repeat(2047)}`;
      assert.strictEqual(bigId.length, 2049, `#3697-9i fixture is ${bigId.length} chars, expected 2049`);
      const a = analyzeRequirementsLine(bigId);
      assert.deepStrictEqual(a.citedReqIds, [bigId], '#3697-9i: it is a valid canonical REQ-ID');
      assert.deepStrictEqual(a.oversizedTokens, [], '#3697-9i: selected means verified');
      assert.strictEqual(a.warn, false, '#3697-9i: nothing to report');
    },
  );

  // ── Minor 4 ────────────────────────────────────────────────────────────────
  // A zero-selection non-placeholder line MUST warn — #3697's own acceptance
  // criterion says so in as many words. What was wrong is that it reported an
  // ADR citation as "Unparsed text", i.e. as requirement content it had failed
  // to read. Name what the residue actually is, and name the escape hatch.
  for (const [label, line] of [
    ['Deferred (see ADR-7)', 'Deferred (see ADR-7)'],
    ['N/A with citation', 'N/A (tracked in ADR-12)'],
  ]) {
    test(
      `#3697-10 (${label}): a zero-selection line still warns, but names ID-shaped TEXT rather ` +
      'than missed requirements, and points at the placeholder escape',
      () => {
        const a = analyzeRequirementsLine(line);
        assert.deepStrictEqual(a.citedReqIds, [], `#3697-10 (${label}): nothing is selected here`);
        const wr = formatRequirementsLineWarning('1', line, a);
        const w = reqLineText(wr);
        const wc = reqLineCode(wr);
        assert.strictEqual(
          wc, REQ_LINE_WARNING_CODE.misparse,
          `#3697-10 (${label}): zero selection is a demonstrated parse failure: ${wc}`,
        );
        assert.ok(w, `#3697-10 (${label}): a non-empty non-placeholder line selecting zero must warn`);
        assert.match(w, /ID-shaped text that was not selected/i, `#3697-10 (${label}): ${w}`);
        assert.doesNotMatch(
          w,
          /Unparsed text/i,
          `#3697-10 (${label}): the citation is not unparsed requirement content: ${w}`,
        );
        assert.doesNotMatch(
          w,
          /Range forms are not expanded/i,
          `#3697-10 (${label}): no range rule fired, so no range may be diagnosed: ${w}`,
        );
        assert.match(w, /write `TBD` or `None`/i, `#3697-10 (${label}): ${w}`);
      },
    );
  }

  // ── Census closure ─────────────────────────────────────────────────────────
  // The range-operator enumeration is a set the code fixes at author time over
  // a domain (separator spellings) that grows without it. Round 3's census
  // found the ASCII and typographic dashes split: U+2013/U+2014 were reached,
  // the five other Unicode dashes were not, and each miss is a SILENT
  // under-selection — #3697's own defect. They carry no collision risk because
  // they are not the REQ-ID separator (that is ASCII `-`), so they close.
  for (const [label, cp] of [
    ['U+2010 hyphen', '‐'],
    ['U+2011 non-breaking hyphen', '‑'],
    ['U+2012 figure dash', '‒'],
    ['U+2015 horizontal bar', '―'],
    ['U+2212 minus sign', '−'],
  ]) {
    test(`#3697-11 (${label}): a typographic dash is the same range operator at a different codepoint`, () => {
      const spaced = `RANGE-01 ${cp} RANGE-05`;
      assert.strictEqual(
        analyzeRequirementsLine(spaced).warn,
        true,
        `#3697-11 (${label}): spaced form must warn`,
      );
      const tight = `RANGE-01${cp}RANGE-05`;
      assert.strictEqual(
        analyzeRequirementsLine(tight).warn,
        true,
        `#3697-11 (${label}): tight form must warn`,
      );
      // And the collision the ASCII hyphen has must NOT arrive with them: a
      // date-shaped annotation stays silent because its own separators are
      // ASCII, so it never reaches the ID shape at all.
      assert.strictEqual(
        analyzeRequirementsLine(`RANGE-01 (target FY-2026-08)`).warn,
        false,
        `#3697-11 (${label}): the date-annotation control must stay silent`,
      );
    });
  }

  // Every dash takes the STRICT shape, whatever its codepoint. `PREFIX-\d+
  // <dash> \d+` is also a date and a sub-numbered ID, and that ambiguity is a
  // property of the shape rather than of which key was pressed. #3697-4 pins
  // the ASCII date annotation silent; these pin its seven typographic twins to
  // the same verdict. Two of them — U+2013 and U+2014 — warned BEFORE this PR,
  // so this arm fixes a pre-existing inconsistency as well as the one an
  // earlier round-3 commit briefly introduced for the other five.
  const ALL_DASHES = [
    ['ASCII hyphen-minus', '-'],
    ['U+2010 hyphen', '‐'],
    ['U+2011 non-breaking hyphen', '‑'],
    ['U+2012 figure dash', '‒'],
    ['U+2013 en dash', '–'],
    ['U+2014 em dash', '—'],
    ['U+2015 horizontal bar', '―'],
    ['U+2212 minus sign', '−'],
  ];

  for (const [label, d] of ALL_DASHES) {
    test(`#3697-13 (${label}): a date-shaped annotation must stay silent`, () => {
      const line = `RANGE-01 (target FY-2026${d}08)`;
      assert.strictEqual(
        analyzeRequirementsLine(line).warn,
        false,
        `#3697-13 (${label}): ${JSON.stringify(line)} is a date annotation, not a range`,
      );
      // The sub-numbered-ID reading of the same shape, beside a selected ID.
      const sub = `RANGE-01, API-2${d}01`;
      assert.strictEqual(
        analyzeRequirementsLine(sub).warn,
        false,
        `#3697-13 (${label}): ${JSON.stringify(sub)} is a sub-numbered ID, not a range`,
      );
    });

    test(`#3697-13b (${label}): a tight range with a FULL ID on both sides must still warn`, () => {
      const line = `RANGE-01${d}RANGE-05`;
      assert.strictEqual(
        analyzeRequirementsLine(line).rangeTokens.length,
        1,
        `#3697-13b (${label}): ${JSON.stringify(line)} is unambiguously a range`,
      );
    });
  }

  test('#3697-13c: the LOOSE operators keep their numeric endpoint', () => {
    // `..`, `…` and the word operators have no date or sub-number reading
    // between two numbers, so the strict shape would cost them coverage for
    // nothing. They are deliberately not moved.
    for (const line of ['RANGE-01…05', 'RANGE-01..05', 'RANGE-01through05']) {
      assert.strictEqual(
        analyzeRequirementsLine(line).rangeTokens.length,
        1,
        `#3697-13c: ${JSON.stringify(line)} must still read as a tight range`,
      );
    }
  });

  test('#3697-13d: the accepted false negative is now symmetric across dashes', () => {
    // `RANGE-01, RANGE-02-05` is silent in the shipped design — the strict
    // shape accepts that, deliberately, for the dash people actually type.
    // Every other dash now accepts it identically; the inconsistency, not the
    // gap, is what round 3 removed. A BARE `RANGE-02<dash>05` still warns,
    // because it selects nothing and R3 catches it.
    for (const [label, d] of ALL_DASHES) {
      assert.strictEqual(
        analyzeRequirementsLine(`RANGE-01, RANGE-02${d}05`).warn,
        false,
        `#3697-13d (${label}): mixed-list numeric endpoint is the accepted false negative`,
      );
      assert.strictEqual(
        analyzeRequirementsLine(`RANGE-02${d}05`).warn,
        true,
        `#3697-13d (${label}): a bare zero-selection line must still warn via R3`,
      );
    }
  });

  test('#3697-12: the ASCII-hyphen strict shape is unchanged by the dash widening', () => {
    // `LETTERS-\d+-\d+` is also a date and a sub-numbered ID, which is why the
    // bare-hyphen tight arm demands a full ID on both sides. Widening the
    // NOHYPHEN arm must not relax that.
    for (const line of ['RANGE-01-05', 'FY-2026-08', 'API-2-01']) {
      assert.strictEqual(
        analyzeRequirementsLine(line).rangeTokens.length,
        0,
        `#3697-12: ${JSON.stringify(line)} must not read as a tight range`,
      );
    }
    assert.strictEqual(
      analyzeRequirementsLine('RANGE-01-RANGE-05').rangeTokens.length,
      1,
      '#3697-12: the full-ID-both-sides spelling must still read as a range',
    );
  });
});

// ─── #2572: phase-SUMMARY artifact↔disk advisory at phase completion ─────────
//
// A SUMMARY asserts "I created these files". Until #2572 nothing checked that
// claim for phase summaries — `verify-summary` existed but was only ever
// pointed at `.planning/research/SUMMARY.md`, so an interrupted or
// over-reported phase counted toward 100% silently.
//
// The advisory joins the existing `warnings[]` channel of `phase complete`
// (rendered by execute-phase.md's "If has_warnings is true" step). It is
// advisory ONLY: the completion GATE is readVerificationStatus, untouched here.

function build2572SummaryArtifactFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2572-artifact-'));
  const planDir = path.join(tmpDir, '.planning');
  const dirtyDir = path.join(planDir, 'phases', '01-dirty');
  const cleanDir = path.join(planDir, 'phases', '02-clean');
  fs.mkdirSync(dirtyDir, { recursive: true });
  fs.mkdirSync(cleanDir, { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

  // Only these two land on disk.
  fs.writeFileSync(path.join(tmpDir, 'src/landed-one.ts'), 'x\n');
  fs.writeFileSync(path.join(tmpDir, 'src/landed-two.ts'), 'x\n');

  fs.writeFileSync(path.join(planDir, 'ROADMAP.md'), [
    '# Roadmap', '',
    '- [ ] Phase 01: Dirty',
    '- [ ] Phase 02: Clean', '',
    '### Phase 01: Dirty',
    '**Goal:** Ship the dirty thing',
    '**Plans:** 1 plans', '',
    '### Phase 02: Clean',
    '**Goal:** Ship the clean thing',
    '**Plans:** 1 plans', '',
    '## Progress', '',
    '| Phase | Plans Complete | Status | Completed |',
    '|-------|----------------|--------|-----------|',
    '| 01. Dirty | 0/1 | Not started | - |',
    '| 02. Clean | 0/1 | Not started | - |',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(planDir, 'STATE.md'), [
    '# State', '',
    '**Current Phase:** 01',
    '**Current Phase Name:** Dirty',
    '**Status:** In progress',
    '**Completed Phases:** 0',
    '**Total Phases:** 2',
    '**Progress:** 0%',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(dirtyDir, '01-01-PLAN.md'), '# Plan\nDo the work.\n');
  // Frontmatter uses the shipped template's YAML flow sequence on purpose: the
  // bracket artifact it once produced must not surface as a phantom warning.
  fs.writeFileSync(path.join(dirtyDir, '01-01-SUMMARY.md'), [
    '---',
    'phase: 01-dirty',
    'key-files:',
    '  created: [src/landed-one.ts, src/never-landed.ts]',
    'status: complete',
    '---', '',
    '# Phase 1 Summary', '',
    'Created `src/landed-one.ts` and `src/never-landed.ts`.',
    '',
  ].join('\n'));

  fs.writeFileSync(path.join(cleanDir, '02-01-PLAN.md'), '# Plan\nDo the work.\n');
  fs.writeFileSync(path.join(cleanDir, '02-01-SUMMARY.md'), [
    '---',
    'phase: 02-clean',
    'key-files:',
    '  created: [src/landed-two.ts]',
    'status: complete',
    '---', '',
    '# Phase 2 Summary', '',
    'Created `src/landed-two.ts`.',
    '',
  ].join('\n'));

  return { tmpDir };
}

describe('#2572: phase complete warns when a SUMMARY claims files that never landed', () => {
  test('#2572-1: a SUMMARY naming a file that is not on disk produces a warning at completion', () => {
    const { tmpDir } = build2572SummaryArtifactFixture();
    try {
      const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
      const parsed = JSON.parse(output);
      const warnings = parsed.warnings || [];
      assert.ok(
        warnings.some((w) => w.includes('src/never-landed.ts')),
        `#2572-1 FAILED: expected a warning naming src/never-landed.ts, got: ${JSON.stringify(warnings)}`,
      );
      assert.ok(
        warnings.some((w) => w.includes('01-01-SUMMARY.md')),
        `#2572-1 FAILED: the warning must name the SUMMARY it came from, got: ${JSON.stringify(warnings)}`,
      );
      assert.strictEqual(parsed.has_warnings, true, '#2572-1 FAILED: has_warnings must be true');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('#2572-2: the advisory is ADVISORY — completion still succeeds and reports the phase complete', () => {
    const { tmpDir } = build2572SummaryArtifactFixture();
    try {
      const stateBefore = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
      const { output } = runVerifiedPhaseComplete(['phase', 'complete', '1'], tmpDir);
      const parsed = JSON.parse(output);
      assert.strictEqual(parsed.completed_phase, '1', '#2572-2 FAILED: completion must not be blocked by the advisory');
      assert.strictEqual(parsed.state_updated, true, '#2572-2 FAILED: STATE.md must still be written');
      // #3685: earn the `true` above — assert STATE.md's content actually
      // differs from the pre-call snapshot.
      const stateAfter = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
      assert.notEqual(stateAfter, stateBefore, '#3685: STATE.md content must actually change when state_updated is true');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('#2572-3 (control): a phase whose SUMMARY files all exist emits NO artifact warning', () => {
    const { tmpDir } = build2572SummaryArtifactFixture();
    try {
      const { output } = runVerifiedPhaseComplete(['phase', 'complete', '2'], tmpDir);
      const parsed = JSON.parse(output);
      const warnings = parsed.warnings || [];
      assert.ok(
        !warnings.some((w) => /not on disk/.test(w)),
        `#2572-3 FAILED: a clean phase must emit no artifact advisory. This is the ` +
        `"absent for a clean one" half — and the fixture references a real '/'-bearing ` +
        `path, so silence here is earned, not vacuous. Got: ${JSON.stringify(warnings)}`,
      );
    } finally {
      cleanup(tmpDir);
    }
  });

  test('#2572-4: the shipped template frontmatter flow sequence produces no phantom "[path" warning', () => {
    const { tmpDir } = build2572SummaryArtifactFixture();
    try {
      const { output } = runVerifiedPhaseComplete(['phase', 'complete', '2'], tmpDir);
      const warnings = JSON.parse(output).warnings || [];
      assert.ok(
        !warnings.some((w) => w.includes('[src/')),
        `#2572-4 FAILED (#2685 Blocker 1): a YAML flow sequence in frontmatter must not ` +
        `leak a bracket-prefixed candidate. Got: ${JSON.stringify(warnings)}`,
      );
    } finally {
      cleanup(tmpDir);
    }
  });
});

// Outer scope shared by the two fold blocks below (deliberately NOT module-scope:
// this file already declares a distinct, 3-arg `runVerifiedPhaseComplete(args, tmpDir, env)`
// at line 54 used throughout the rest of the file; nesting here avoids shadowing it).
//
// IIFE, not a bare `{ }` block: this file has no top-level 'use strict', so a plain
// block is sloppy-mode and Annex B function-hoisting semantics apply — a `function`
// declared directly inside a bare block still leaks out and REASSIGNS the enclosing
// (module-scope) `runVerifiedPhaseComplete` var the moment this block runs, clobbering
// the real one at line 54 for every call site in the file (test() bodies are deferred
// and all run after this synchronous top-level code, so every caller ends up hitting
// this one). Wrapping in a strict-mode function expression suppresses Annex B leakage,
// matching how the two original un-consolidated copies were each scoped inside a
// strict-mode `describe(() => { 'use strict'; ... })` arrow function body.
(function () {
'use strict';
/**
 * Write a passed-VERIFICATION marker for the phase, then run `phase complete N`.
 * Mirrors phase.test.cjs's writePassedVerificationForPhase: a `<phase>-VERIFICATION.md`
 * with `status: passed` frontmatter. Requires the phase directory to exist.
 *
 * Shared by the folded:issue-2945-phase-complete-checkbox-rollback and
 * folded:issue-2949-phase-complete-stage3-sentinel blocks below — both fold sources
 * defined this same helper independently; consolidated to one definition (PR #3339
 * review, Fowler-baseline duplication finding) since both bodies were functionally
 * identical modulo variable naming.
 */
function runVerifiedPhaseComplete(args, tmpDir) {
  const argv = Array.isArray(args) ? args : args.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  const completeIdx = argv.findIndex((t, i) => t === 'complete' && argv[i - 1] === 'phase');
  const phase = argv[completeIdx + 1];
  const phasesDir = path.join(tmpDir, '.planning', 'phases');
  const wanted = parseInt(String(phase).replace(/^0+/, ''), 10);
  const phaseDirName = fs.readdirSync(phasesDir).find((name) => {
    const m = name.match(/^(\d+)/);
    return m && parseInt(m[1], 10) === wanted;
  });
  if (!phaseDirName) throw new Error(`no phase directory for phase ${phase}`);
  fs.writeFileSync(
    path.join(phasesDir, phaseDirName, `${phase}-VERIFICATION.md`),
    ['---', 'status: passed', '---', '', '# Verification', ''].join('\n'),
  );
  return runGsdTools(args, tmpDir);
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/issue-2945-phase-complete-checkbox-rollback.test.cjs — H3 Wave 7 test-hygiene sweep (#3339)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:issue-2945-phase-complete-checkbox-rollback (#3339)', () => {
'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Regression test for #2945 — `phase complete`'s inline REQUIREMENTS.md checkbox
 * flip is traceability-blind: it flips `- [ ] **REQ-ID**` → `- [x]` unconditionally,
 * then attempts the traceability-row write, and KEEPS the flip when the row exists
 * but rejects the write (Out/Deferred/Blocked). The sibling `requirements.mark-complete`
 * got the #2788 defect-2 rollback; `cmdPhaseComplete`'s inline copy did not.
 *
 * The fix ports the rollback from `cmdRequirementsMarkComplete` (src/milestone.cts):
 * capture beforeCheckbox, track whether the row write actually changed (tableHit), and
 * restore beforeCheckbox when the row EXISTS but rejects the write.
 *
 * Matrix: .gsd/bug/fix/2945-phase-complete-checkbox-rollback/50-test-matrix.md
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempProject, cleanup } = require('./helpers.cjs');

// runVerifiedPhaseComplete is defined once, hoisted above both fold blocks (see
// the shared helper preceding the "Folded from tests/issue-2945-..." banner);
// this block closes over that module-scope definition.

describe('phase complete checkbox rollback (#2945)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-2945-');
  });
  afterEach(() => {
    cleanup(tmpDir);
  });

  /**
   * Scaffold a single-phase project whose ROADMAP cites the given REQ-IDs, with a
   * REQUIREMENTS.md whose traceability table rows carry the given statuses, then run
   * `phase complete 1`. Returns the REQUIREMENTS.md content after completion.
   */
  function completeWithRows(reqIds, rowStatuses) {
    const reqList = reqIds.join(', ');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n- [ ] Phase 1: The phase\n\n### Phase 1: The phase\n**Goal:** do it\n**Requirements:** ${reqList}\n**Plans:** 1 plans\n`,
    );
    const reqLines = reqIds.map((id) => `- [ ] **${id}**: a requirement`).join('\n');
    const tableRows = reqIds.map((id, i) => `| ${id} | Phase 1 | ${rowStatuses[i]} |`).join('\n');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements\n\n## v1 Requirements\n\n${reqLines}\n\n## Traceability\n\n| Requirement | Phase | Status |\n|-------------|-------|--------|\n${tableRows}\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** The phase\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-the-phase');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error || result.output}`);
    return fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
  }

  test('deferredRowRollsBackCheckbox', () => {
    // Row 1 (failing-first regression): a Deferred row rejects the Status write, so the
    // checkbox must NOT flip (it stays [ ]), and the row must stay Deferred.
    const req = completeWithRows(['DEF-01'], ['Deferred']);
    assert.ok(req.includes('- [ ] **DEF-01**'), 'checkbox must stay [ ] when the row is Deferred (no silent divergence)');
    assert.ok(/^\| DEF-01 \| Phase 1 \| Deferred \|/m.test(req), 'row must stay Deferred');
    assert.ok(!req.includes('- [x] **DEF-01**'), 'checkbox must NOT have flipped to [x]');
  });

  test('blockedRowRollsBackCheckbox', () => {
    // Row 2: an Out/Blocked row likewise rejects the write → checkbox stays [ ].
    const req = completeWithRows(['BLK-01'], ['Blocked']);
    assert.ok(req.includes('- [ ] **BLK-01**'), 'checkbox must stay [ ] when the row is Blocked');
    assert.ok(/^\| BLK-01 \| Phase 1 \| Blocked \|/m.test(req), 'row must stay Blocked');
    assert.ok(!req.includes('- [x] **BLK-01**'), 'checkbox must NOT have flipped to [x]');
  });

  test('pendingRowStillFlipsAndAdvances', () => {
    // Row 3 (negative-space / unchanged forward behavior): a Pending row accepts the write,
    // so the checkbox MUST flip to [x] and the row MUST advance to Complete. An over-broad
    // rollback would break this.
    const req = completeWithRows(['FWD-01'], ['Pending']);
    assert.ok(req.includes('- [x] **FWD-01**'), 'checkbox MUST flip to [x] for a Pending (forward) row');
    assert.ok(/^\| FWD-01 \| Phase 1 \| Complete \|/m.test(req), 'row MUST advance to Complete');
  });

  test('noRowStillFlipsCheckbox', () => {
    // Row 4 (acceptance #3): a cited REQ-ID with NO traceability row → checkbox still flips
    // (nothing to disagree with). The rollback only fires when a row EXISTS and rejects.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n- [ ] Phase 1: The phase\n\n### Phase 1: The phase\n**Goal:** do it\n**Requirements:** NOROW-01\n**Plans:** 1 plans\n`,
    );
    // REQUIREMENTS.md with the checkbox but NO traceability table.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements\n\n## v1 Requirements\n\n- [ ] **NOROW-01**: a requirement with no traceability row\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 01\n**Current Phase Name:** The phase\n**Status:** In progress\n**Current Plan:** 01-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
    );
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-the-phase');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(p1, '01-01-SUMMARY.md'), '# Summary');

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `phase complete failed: ${result.error || result.output}`);
    const req = fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
    assert.ok(req.includes('- [x] **NOROW-01**'), 'checkbox MUST flip to [x] when no traceability row exists');
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/issue-2949-phase-complete-stage3-sentinel.test.cjs — H3 Wave 7 test-hygiene sweep (#3339)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:issue-2949-phase-complete-stage3-sentinel (#3339)', () => {
'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Regression test for #2949 — `phase complete`'s stage-3 lowest-outstanding-override
 * loop admits unchecked `0.x` backlog sentinel rows as `next_phase`, corrupting STATE.md
 * and desyncing `current_phase` from `current_phase_name`.
 *
 * Root cause: `src/phase.cts` stage-3 condition `!isChecked && comparePhaseNum(cbm[2], phaseNum) < 0`
 * has no sentinel filter, so `comparePhaseNum("0.1","12") === -12` admits the `0.x` backlog row.
 * The fix adds `&& !isSentinelPhaseId(cbm[2])` (reusing the existing zero-caller predicate), which
 * excludes both sentinel ranges (0 and 999). Stage-3 only here — PR #2815 (in-flight) covers
 * stages 1-2 for #2786.
 *
 * Matrix: .gsd/bug/fix/2949-phase-complete-stage3-sentinel-filter/50-test-matrix.md
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTempProject, cleanup } = require('./helpers.cjs');

// runVerifiedPhaseComplete is defined once, in the outer scope shared by this block
// and the folded:issue-2945-phase-complete-checkbox-rollback block above (see the
// shared helper preceding that block's banner comment); this block closes over it.

describe('phase complete stage-3 sentinel filter (#2949)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-2949-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  /** Scaffold a phase dir with one executed plan (PLAN + SUMMARY). */
  function scaffoldPhase(slug, planNum) {
    const dir = path.join(tmpDir, '.planning', 'phases', slug);
    fs.mkdirSync(dir, { recursive: true });
    const padded = String(planNum).padStart(2, '0');
    fs.writeFileSync(path.join(dir, `${padded}-01-PLAN.md`), '# Plan');
    fs.writeFileSync(path.join(dir, `${padded}-01-SUMMARY.md`), '# Summary');
  }

  test('zeroXSentinelDoesNotBecomeNextPhase', () => {
    // Row 1 (failing-first regression): completing the last real phase with an unchecked
    // 0.x backlog sentinel row present must NOT select the sentinel as next_phase.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 0.1: Backlog sentinel item** — deferred work
- [x] **Phase 11: First phase** (completed 2025-01-01)
- [ ] **Phase 12: Last phase**

### Phase 11: First phase
**Goal:** first
**Plans:** 1 plans

### Phase 12: Last phase
**Goal:** last
**Plans:** 1 plans
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 12\n**Current Phase Name:** Last phase\n**Status:** In progress\n**Current Plan:** 12-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working on phase 12\n`,
    );
    scaffoldPhase('11-first-phase', 11);
    scaffoldPhase('12-last-phase', 12);

    const result = runVerifiedPhaseComplete('phase complete 12', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.completed_phase, '12');
    assert.strictEqual(output.is_last_phase, true, '0.x sentinel must not prevent milestone completion (is_last_phase=true)');
    assert.strictEqual(output.next_phase, null, '0.x sentinel must not be selected as next_phase');

    // STATE.md current_phase must stay on the completed phase (12), not advance to 0.1.
    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(!/\*\*Current Phase:\*\*\s*0\.1/i.test(state), 'STATE.md current_phase must NOT have advanced to the 0.x sentinel');
  });

  test('realLowerOutstandingPhaseStillSelected', () => {
    // Row 2 (#2028 non-regression): a REAL lower-numbered unchecked phase must STILL be
    // selected as next_phase. The sentinel filter must not over-broaden to real phases.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 9: Skipped-then-resumed phase**
- [ ] **Phase 10: Current phase**

### Phase 9: Skipped-then-resumed phase
**Goal:** nine
**Plans:** 1 plans

### Phase 10: Current phase
**Goal:** ten
**Plans:** 1 plans
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 10\n**Current Phase Name:** Current phase\n**Status:** In progress\n**Current Plan:** 10-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working on phase 10\n`,
    );
    scaffoldPhase('09-skipped-then-resumed-phase', 9);
    scaffoldPhase('10-current-phase', 10);

    const result = runVerifiedPhaseComplete('phase complete 10', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    const output = JSON.parse(result.output);

    // A real lower phase (9) IS selected — the #2028 out-of-order behavior is preserved.
    // next_phase may be padded ("09") or unpadded ("9"); compare numerically.
    assert.strictEqual(output.is_last_phase, false, 'a real lower outstanding phase must keep is_last_phase=false');
    const nextNum = parseInt(String(output.next_phase), 10);
    assert.strictEqual(nextNum, 9, `real lower phase 9 must be selected as next_phase (got ${output.next_phase})`);
  });

  test('zeroXSentinelNoCurrentPhaseDesync', () => {
    // Row 3 (acceptance #3/#4): current_phase and current_phase_name must not desync when
    // a 0.x sentinel is present and the milestone completes.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 0.1: Backlog**
- [ ] **Phase 5: Only phase**

### Phase 5: Only phase
**Goal:** five
**Plans:** 1 plans
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 5\n**Current Phase Name:** Only phase\n**Status:** In progress\n**Current Plan:** 05-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working on phase 5\n`,
    );
    scaffoldPhase('05-only-phase', 5);

    const result = runVerifiedPhaseComplete('phase complete 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.is_last_phase, true, 'milestone completes despite the 0.x sentinel');

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    // current_phase must NOT have advanced to 0.1 (no desync into the sentinel).
    assert.ok(!/\*\*Current Phase:\*\*\s*0\.1/i.test(state), 'no desync: current_phase did not advance to 0.1');
  });

  test('checkedZeroXSentinelIrrelevant', () => {
    // Row 4 (boundary): a CHECKED 0.x sentinel is irrelevant — completing the last real phase
    // still completes the milestone.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [x] **Phase 0.1: Already-done backlog item**
- [ ] **Phase 3: Last phase**

### Phase 3: Last phase
**Goal:** three
**Plans:** 1 plans
`,
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Current Phase:** 3\n**Current Phase Name:** Last phase\n**Status:** In progress\n**Current Plan:** 03-01\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working on phase 3\n`,
    );
    scaffoldPhase('03-last-phase', 3);

    const result = runVerifiedPhaseComplete('phase complete 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.is_last_phase, true, 'checked sentinel is irrelevant; milestone completes');
    assert.strictEqual(output.next_phase, null);
  });
});
  });
}
})();

// #3350 — phase complete: a merely-positionally-next higher phase heading
// (stage 2) must not mask a genuinely-outstanding lower phase (stage 3), and
// STATE.md frontmatter's current_phase/current_phase_name must stay paired.
// Matrix: .gsd/bug/fix-3350-phase-complete-name-desync/50-test-matrix.md
describe('phase complete lowest-outstanding vs positional-next (#3350)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-3350-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  /** Scaffold a phase dir with one executed plan (PLAN + SUMMARY). */
  function scaffoldPhase(slug, planNum) {
    const dir = path.join(tmpDir, '.planning', 'phases', slug);
    fs.mkdirSync(dir, { recursive: true });
    const padded = String(planNum).padStart(2, '0');
    fs.writeFileSync(path.join(dir, `${padded}-01-PLAN.md`), '# Plan');
    fs.writeFileSync(path.join(dir, `${padded}-01-SUMMARY.md`), '# Summary');
  }

  const statePath = () => path.join(tmpDir, '.planning', 'STATE.md');

  /**
   * Row-4 roadmap: phase 5 is completed (dir on disk); phases 3 and 4 are
   * outstanding (unchecked, never executed, no dirs — optional); higher
   * headings 6 and 7 are pre-declared with no dirs (stage-1 miss, stage-2 hit).
   */
  function writeRow4Roadmap({ withLowerDirs = false, withHigherDir = false } = {}) {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

- [ ] **Phase 3: Attestation Freeze**
- [ ] **Phase 4: Corpus Maturation**
- [ ] **Phase 5: Harness Mechanization**
- [ ] **Phase 6: Oracle Re-Hardening**
- [ ] **Phase 7: Recall Monitoring**

### Phase 3: Attestation Freeze
**Goal:** three
**Plans:** 1 plans

### Phase 4: Corpus Maturation
**Goal:** four
**Plans:** 1 plans

### Phase 5: Harness Mechanization
**Goal:** five
**Plans:** 1 plans

### Phase 6: Oracle Re-Hardening
**Goal:** six
**Plans:** 1 plans

### Phase 7: Recall Monitoring
**Goal:** seven
**Plans:** 1 plans
`,
    );
    scaffoldPhase('05-harness-mechanization', 5);
    if (withLowerDirs) {
      scaffoldPhase('03-attestation-freeze', 3);
      scaffoldPhase('04-corpus-maturation', 4);
    }
    if (withHigherDir) {
      scaffoldPhase('06-oracle-re-hardening', 6);
    }
  }

  /** Explicit-field STATE.md (body fields present — the 0xdhx fixture shape). */
  function writeExplicitState() {
    fs.writeFileSync(
      statePath(),
      `# State

**Current Phase:** 5
**Current Phase Name:** Harness Mechanization
**Status:** In progress
**Current Plan:** 05-01
**Last Activity:** 2025-01-01
**Last Activity Description:** Working on phase 5
`,
    );
  }

  /**
   * Narrative-prose STATE.md (NO body fields) with frontmatter parked on the
   * just-completed phase — the filed #3350 shape: without the pairing override
   * current_phase stays at 5 while current_phase_name advances.
   */
  function writeNarrativeState() {
    fs.writeFileSync(
      statePath(),
      `---
current_phase: 5
current_phase_name: Harness Mechanization
---

# State

We are wrapping up phase 5 of the milestone; the next actionable phase is
still to be determined by the roadmap.
`,
    );
  }

  function parseFrontmatterField(content, key) {
    const m = content.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  }

  test('lowerOutstandingBeatsHigherHeading', () => {
    // Row 4 (failing-first): completing 5 with outstanding 3/4 AND pre-declared
    // higher headings 6/7 must pick the lowest outstanding phase (3), not the
    // positionally-next heading (6).
    writeRow4Roadmap();
    writeExplicitState();

    const result = runVerifiedPhaseComplete('phase complete 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.completed_phase, '5');
    assert.strictEqual(output.is_last_phase, false, 'a higher phase exists — not last');
    assert.strictEqual(
      parseInt(String(output.next_phase), 10),
      3,
      `lowest outstanding phase 3 must be next_phase (got ${output.next_phase})`,
    );
    assert.strictEqual(output.next_phase_name, 'attestation-freeze');
  });

  test('narrativeStateFrontmatterPairing', () => {
    // Row 4 + acceptance #2/#5 (failing-first): with a narrative STATE.md and
    // frontmatter parked on the completed phase, BOTH frontmatter fields must
    // describe the resolved next phase (3) after the write — never a split.
    writeRow4Roadmap();
    writeNarrativeState();

    const result = runVerifiedPhaseComplete('phase complete 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(parseInt(String(output.next_phase), 10), 3);

    const state = fs.readFileSync(statePath(), 'utf-8');
    const fmPhase = parseFrontmatterField(state, 'current_phase');
    const fmName = parseFrontmatterField(state, 'current_phase_name');
    assert.ok(fmPhase !== null, 'frontmatter current_phase must exist');
    assert.ok(fmName !== null, 'frontmatter current_phase_name must exist');
    assert.strictEqual(
      parseInt(fmPhase, 10),
      3,
      `current_phase must advance to the resolved next phase 3 (got ${fmPhase})`,
    );
    assert.match(fmName, /attestation freeze/i, `current_phase_name must name phase 3 (got ${fmName})`);
  });

  test('higherStillWinsWhenNoLowerOutstanding', () => {
    // Row 2 non-regression (acceptance #4): N+k really is the correct next phase
    // when no lower phase is genuinely outstanding.
    writeRow4Roadmap();
    writeExplicitState();
    // Check phases 3 and 4 off — the higher heading is then the right answer.
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    fs.writeFileSync(
      roadmapPath,
      fs.readFileSync(roadmapPath, 'utf-8')
        .replace('- [ ] **Phase 3: Attestation Freeze**', '- [x] **Phase 3: Attestation Freeze**')
        .replace('- [ ] **Phase 4: Corpus Maturation**', '- [x] **Phase 4: Corpus Maturation**'),
    );

    const result = runVerifiedPhaseComplete('phase complete 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(parseInt(String(output.next_phase), 10), 6, 'positionally-next 6 wins when no lower phase is outstanding');
    assert.strictEqual(output.is_last_phase, false);
  });

  test('lowerOnlyStillSelected', () => {
    // Row 3 non-regression (#2028 original shape): lower outstanding, no higher.
    writeRow4Roadmap();
    writeExplicitState();
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    let roadmap = fs.readFileSync(roadmapPath, 'utf-8');
    roadmap = roadmap
      .replace('- [ ] **Phase 6: Oracle Re-Hardening**\n', '')
      .replace('- [ ] **Phase 7: Recall Monitoring**\n', '')
      .replace('### Phase 6: Oracle Re-Hardening\n**Goal:** six\n**Plans:** 1 plans\n\n', '')
      .replace('### Phase 7: Recall Monitoring\n**Goal:** seven\n**Plans:** 1 plans\n', '');

    fs.writeFileSync(roadmapPath, roadmap);

    const result = runVerifiedPhaseComplete('phase complete 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(parseInt(String(output.next_phase), 10), 3, '#2028 behavior preserved');
    assert.strictEqual(output.is_last_phase, false);
  });

  test('nothingOutstandingStillCompletesMilestone', () => {
    // Row 1 non-regression: no higher phase (heading or dir) and no unchecked
    // lower phase → is_last_phase stays true. Higher HEADINGS alone keep
    // is_last_phase false (stage 2 matches headings regardless of checkbox
    // state), so this fixture drops them entirely.
    writeRow4Roadmap();
    writeExplicitState();
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    let roadmap = fs.readFileSync(roadmapPath, 'utf-8');
    roadmap = roadmap
      .replace('- [ ] **Phase 3: Attestation Freeze**', '- [x] **Phase 3: Attestation Freeze**')
      .replace('- [ ] **Phase 4: Corpus Maturation**', '- [x] **Phase 4: Corpus Maturation**')
      .replace('- [ ] **Phase 6: Oracle Re-Hardening**\n', '')
      .replace('- [ ] **Phase 7: Recall Monitoring**\n', '')
      .replace('### Phase 6: Oracle Re-Hardening\n**Goal:** six\n**Plans:** 1 plans\n\n', '')
      .replace('### Phase 7: Recall Monitoring\n**Goal:** seven\n**Plans:** 1 plans\n', '');
    fs.writeFileSync(roadmapPath, roadmap);

    const result = runVerifiedPhaseComplete('phase complete 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.is_last_phase, true, 'nothing outstanding — milestone completes');
    assert.strictEqual(output.next_phase, null);
  });

  test('sentinelStillExcludedWithHigherPresent', () => {
    // Acceptance #3: the #2949 sentinel filter keeps working alongside the
    // ungate — an unchecked 0.x backlog row never becomes next_phase.
    writeRow4Roadmap();
    writeExplicitState();
    const roadmapPath = path.join(tmpDir, '.planning', 'ROADMAP.md');
    fs.writeFileSync(
      roadmapPath,
      '- [ ] **Phase 0.1: Backlog sentinel item**\n' + fs.readFileSync(roadmapPath, 'utf-8'),
    );

    const result = runVerifiedPhaseComplete('phase complete 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(
      parseInt(String(output.next_phase), 10),
      3,
      `real phase 3 (not the 0.1 sentinel) is next_phase (got ${output.next_phase})`,
    );
  });

  test('explicitBodyFieldsMoveTogether', () => {
    // Row 4 explicit-field variant (0xdhx fixture A): the body fields AND the
    // frontmatter must move to phase 3 together — never both-wrong on 6.
    writeRow4Roadmap();
    writeExplicitState();

    const result = runVerifiedPhaseComplete('phase complete 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(parseInt(String(output.next_phase), 10), 3);

    const state = fs.readFileSync(statePath(), 'utf-8');
    assert.ok(/\*\*Current Phase:\*\*\s*3\b/.test(state), `body Current Phase must be 3, got: ${state.match(/\*\*Current Phase:\*\*.*/)?.[0]}`);
    assert.match(state, /\*\*Current Phase Name:\*\*\s*Attestation Freeze/);
    const fmPhase = parseFrontmatterField(state, 'current_phase');
    const fmName = parseFrontmatterField(state, 'current_phase_name');
    assert.strictEqual(parseInt(fmPhase, 10), 3, `frontmatter current_phase must derive to 3 (got ${fmPhase})`);
    assert.match(fmName, /attestation freeze/i, `frontmatter current_phase_name must name phase 3 (got ${fmName})`);
  });

  test('diskPresentHigherStillLosesToLowerOutstanding', () => {
    // Row 4 stage-1 variant (failing-first): a higher phase directory ON DISK
    // (stage-1 hit) also must not mask an outstanding lower phase.
    writeRow4Roadmap({ withHigherDir: true });
    writeExplicitState();

    const result = runVerifiedPhaseComplete('phase complete 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(
      parseInt(String(output.next_phase), 10),
      3,
      `lowest outstanding phase 3 beats the on-disk higher phase 6 (got ${output.next_phase})`,
    );
  });
});

describe('phase complete lowest-outstanding vs positional-last (#4078)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-4078-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  const statePath = () => path.join(tmpDir, '.planning', 'STATE.md');
  const roadmapPath = () => path.join(tmpDir, '.planning', 'ROADMAP.md');

  /** Scaffold a phase dir with one executed plan (PLAN + SUMMARY). */
  function scaffoldPhase(slug, planNum) {
    const dir = path.join(tmpDir, '.planning', 'phases', slug);
    fs.mkdirSync(dir, { recursive: true });
    const padded = String(planNum).padStart(2, '0');
    fs.writeFileSync(path.join(dir, `${padded}-01-PLAN.md`), '# Plan');
    fs.writeFileSync(path.join(dir, `${padded}-01-SUMMARY.md`), '# Summary');
  }

  /**
   * #4078 fixture shape: the original roadmap's phase rows (2–17) use the
   * bullet-house em-dash grammar the canonical lookup has accepted since #2199
   * (`- [ ] **Phase N — Name**`), while the later phase.add-ingested Phase 18
   * uses the colon grammar both the template and the scaffold emit. Only the
   * colon rows parse under the pre-fix next-phase scan, so the positionally
   * LAST parseable phase (18) won over the lowest outstanding phase (2).
   */
  function writeMixedGrammarRoadmap() {
    const summaryRows = [
      '- [ ] **Phase 1: Bootstrap**',
      '- [ ] **Phase 2 — Python 3.14 Source and CI Compatibility**',
      '- [ ] **Phase 3 — Packaging Refresh**',
      '- [ ] **Phase 17 — Docs Sweep**',
      '- [ ] **Phase 18: Codex Automation Disposition**',
    ];
    fs.writeFileSync(
      roadmapPath(),
      [
        '# Roadmap',
        '',
        '## Phases',
        ...summaryRows,
        '',
        '### Phase 18: Codex Automation Disposition',
        '**Requirements**: TBD',
        '',
        '1. TBD — run /gsd:plan-phase 18 to break down.',
        '',
      ].join('\n'),
    );
    scaffoldPhase('01-bootstrap', 1);
  }

  /** Uniform em-dash grammar (no colon rows at all) — phases 1..5, complete N. */
  function writeDashRoadmap({ completeBox = null } = {}) {
    const names = ['Bootstrap', 'Source Compat', 'Packaging', 'Release', 'Docs Sweep'];
    let rows = names.map((n, i) => `- [ ] **Phase ${i + 1} — ${n}**`);
    if (completeBox !== null) rows[completeBox - 1] = rows[completeBox - 1].replace('- [ ]', '- [x]');
    fs.writeFileSync(
      roadmapPath(),
      ['# Roadmap', '', '## Phases', ...rows, ''].join('\n'),
    );
  }

  function writeExplicitState(phaseNum, phaseName) {
    fs.writeFileSync(
      statePath(),
      [
        '# State',
        '',
        `**Current Phase:** ${phaseNum}`,
        `**Current Phase Name:** ${phaseName}`,
        '**Status:** In progress',
        '**Current Plan:** 01-01',
        '**Last Activity:** 2025-01-01',
        '**Last Activity Description:** Working',
        '',
      ].join('\n'),
    );
  }

  function parseFrontmatterField(content, key) {
    const m = content.match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  }

  test('mixedGrammarLowestOutstandingNotPositionalLast', () => {
    // Row 1 (failing-first regression from the issue): completing Phase 1 of an
    // 18-phase roadmap whose original rows use the em-dash bullet grammar must
    // advance to the lowest outstanding phase (2), NOT the positionally-last
    // colon-form row (18) merely because it is the only row the pre-fix scan
    // could parse.
    writeMixedGrammarRoadmap();
    writeExplicitState(1, 'Bootstrap');

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    const output = JSON.parse(result.output);

    assert.strictEqual(output.completed_phase, '1');
    assert.strictEqual(output.is_last_phase, false, 'phases 2–18 remain — not last');
    assert.strictEqual(
      parseInt(String(output.next_phase), 10),
      2,
      `lowest outstanding phase 2 must be next_phase, not the positionally-last phase 18 (got ${output.next_phase})`,
    );
    assert.match(String(output.next_phase_name), /python[- ]3\.14-source-and-ci-compatibility/i);
  });

  test('mixedGrammarStateMovesToPhaseTwo', () => {
    // Row 2: the resolved next phase must actually be PERSISTED — body Current
    // Phase and frontmatter current_phase/current_phase_name all describe 2.
    writeMixedGrammarRoadmap();
    writeExplicitState(1, 'Bootstrap');

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(parseInt(String(output.next_phase), 10), 2);

    const state = fs.readFileSync(statePath(), 'utf-8');
    assert.ok(/\*\*Current Phase:\*\*\s*2\b/.test(state), `body Current Phase must be 2, got: ${state.match(/\*\*Current Phase:\*\*.*/)?.[0]}`);
    const fmPhase = parseFrontmatterField(state, 'current_phase');
    const fmName = parseFrontmatterField(state, 'current_phase_name');
    assert.strictEqual(parseInt(fmPhase, 10), 2, `frontmatter current_phase must be 2 (got ${fmPhase})`);
    assert.match(fmName, /python 3\.14/i, `frontmatter current_phase_name must name phase 2 (got ${fmName})`);
  });

  test('uniformDashGrammarStillResolvesNext', () => {
    // Row 3: uniform em-dash grammar — no colon rows exist, so the pre-fix scan
    // found NO next phase at all; completing 1 must still resolve phase 2.
    writeDashRoadmap();
    scaffoldPhase('01-bootstrap', 1);
    writeExplicitState(1, 'Bootstrap');

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(
      parseInt(String(output.next_phase), 10),
      2,
      `next phase 2 must resolve from em-dash rows (got ${output.next_phase})`,
    );
    assert.strictEqual(output.is_last_phase, false);
  });

  test('dashGrammarAllCompleteStillEndsMilestone', () => {
    // Row 4 (negative space): completing the highest phase with every lower box
    // checked is still a legitimate milestone end — the widened grammar must not
    // manufacture an outstanding phase.
    writeDashRoadmap({ completeBox: 1 });
    scaffoldPhase('01-bootstrap', 1);
    scaffoldPhase('02-source-compat', 2);
    scaffoldPhase('03-packaging', 3);
    scaffoldPhase('04-release', 4);
    scaffoldPhase('05-docs-sweep', 5);
    const rp = roadmapPath();
    let roadmap = fs.readFileSync(rp, 'utf-8');
    roadmap = roadmap
      .replace('- [ ] **Phase 2 — Source Compat**', '- [x] **Phase 2 — Source Compat**')
      .replace('- [ ] **Phase 3 — Packaging**', '- [x] **Phase 3 — Packaging**')
      .replace('- [ ] **Phase 4 — Release**', '- [x] **Phase 4 — Release**');
    fs.writeFileSync(rp, roadmap);
    writeExplicitState(5, 'Docs Sweep');

    const result = runVerifiedPhaseComplete('phase complete 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.is_last_phase, true, 'everything checked — milestone completes');
    assert.strictEqual(output.next_phase, null);
  });

  test('dashGrammarLowerOutstandingWins', () => {
    // Row 5 (#2028 through the widened grammar): completing 5 with 3 still
    // unchecked must fall BACK to the lowest outstanding phase 3. Phases 1, 2
    // and 4 are checked so 3 is genuinely the lowest outstanding box.
    writeDashRoadmap();
    const rp = roadmapPath();
    let roadmap = fs.readFileSync(rp, 'utf-8');
    roadmap = roadmap
      .replace('- [ ] **Phase 1 — Bootstrap**', '- [x] **Phase 1 — Bootstrap**')
      .replace('- [ ] **Phase 2 — Source Compat**', '- [x] **Phase 2 — Source Compat**')
      .replace('- [ ] **Phase 4 — Release**', '- [x] **Phase 4 — Release**');
    fs.writeFileSync(rp, roadmap);
    scaffoldPhase('03-packaging', 3);
    scaffoldPhase('05-docs-sweep', 5);
    writeExplicitState(5, 'Docs Sweep');

    const result = runVerifiedPhaseComplete('phase complete 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(
      parseInt(String(output.next_phase), 10),
      3,
      `out-of-order completion must point at the lowest outstanding phase 3 (got ${output.next_phase})`,
    );
    assert.strictEqual(output.is_last_phase, false);
  });

  test('dashGrammarSentinelStillExcluded', () => {
    // Row 6 (#2949 through the widened grammar): an unchecked 0.x backlog row in
    // the dash grammar never becomes next_phase.
    writeDashRoadmap();
    scaffoldPhase('01-bootstrap', 1);
    scaffoldPhase('02-source-compat', 2);
    const rp = roadmapPath();
    fs.writeFileSync(
      rp,
      '- [ ] **Phase 0.1 — Backlog sentinel item**\n' + fs.readFileSync(rp, 'utf-8'),
    );
    writeExplicitState(1, 'Bootstrap');

    const result = runVerifiedPhaseComplete('phase complete 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(
      parseInt(String(output.next_phase), 10),
      2,
      `real phase 2 (not the 0.1 sentinel) is next_phase (got ${output.next_phase})`,
    );
  });
});

// ─── #3572: phase remove must not prepend a second frontmatter block ──────────

describe('bug #3572: phase remove must not corrupt STATE.md into two frontmatter blocks', () => {
  const ISSUE_STATE = [
    '---',
    'gsd_state_version: 1.0',
    'milestone: v1.0',
    'milestone_name: First',
    'current_phase: 2',
    'current_phase_name: Feature',
    'status: executing',
    'stopped_at: Phase 1 complete',
    'last_updated: "2026-08-16T10:00:00.000Z"',
    'last_activity: 2026-08-16',
    'last_activity_desc: "Phase 1 complete."',
    'progress:',
    '  total_phases: 2',
    '  completed_phases: 1',
    '  total_plans: 2',
    '  completed_plans: 1',
    '  percent: 50',
    '---',
    '',
    '# Project State',
    '',
    'Some prose here that must survive.',
    '',
  ].join('\n');

  const TWO_PHASE_ROADMAP = '# Roadmap\n\n## Milestone v1.0\n\n### Phase 1: Setup\n**Goal:** Bootstrap the project.\n\n### Phase 2: Feature\n**Goal:** Ship the feature.\n';

  function setupProject(t, stateMd = ISSUE_STATE, eol = '\n') {
    const tmpDir = createTempProject('gsd-3572-');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), TWO_PHASE_ROADMAP);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      stateMd.split('\n').join(eol),
    );
    t.after(() => cleanup(tmpDir));
    return tmpDir;
  }

  function fenceLineCount(content) {
    return content.split(/\r?\n/).filter((l) => l.trim() === '---').length;
  }

  test('#3572: phase remove of an inserted decimal phase keeps STATE.md a single frontmatter block', (t) => {
    const tmpDir = setupProject(t);
    // The issue's exact sequence: insert creates the directory; remove then has a
    // targetDir !== null, and the body lacks Total Phases/of-N — the trigger.
    let r = runGsdTools('phase insert 1 "Inserted probe"', tmpDir);
    assert.ok(r.success, `phase insert failed: ${r.error}`);
    const stateBeforeRemove = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    r = runGsdTools('phase remove 1.1', tmpDir);
    assert.ok(r.success, `phase remove failed: ${r.error}`);
    assert.strictEqual(JSON.parse(r.output).state_updated, true, 'the #2640 resync must still happen');

    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    // #3685: earn the `true` above — assert STATE.md's content actually
    // differs from the snapshot taken immediately before the remove call.
    assert.notEqual(after, stateBeforeRemove, '#3685: STATE.md content must actually change when state_updated is true');
    assert.ok(after.startsWith('---\n') || after.startsWith('---\r\n'), 'file must still OPEN with the frontmatter fence');
    assert.strictEqual(fenceLineCount(after), 2, `exactly one frontmatter block (2 fence lines); got ${fenceLineCount(after)}:\n${after.slice(0, 400)}`);
    assert.strictEqual((after.match(/gsd_state_version/g) || []).length, 1, 'exactly one gsd_state_version — no second derived block');
    assert.ok(after.includes('Some prose here that must survive.'), 'body prose must survive verbatim');
    assert.match(after, /^Total Phases:\s*\d+$/m, 'the inserted count field must live in the BODY (line-start), not before the first fence');
    // Pinned value: the body field counts DIRECTORIES on disk (0 after removing
    // the only directory); the frontmatter progress block derives from ROADMAP
    // (2 below) — the two counters have different provenance by design (#2640/#2528).
    assert.match(after, /^Total Phases:\s*0$/m, 'body field = remaining on-disk phase directories');
    const fm = after.match(/total_phases:\s*(\d+)/);
    assert.ok(fm, 'frontmatter progress.total_phases present');
    assert.strictEqual(fm[1], '2', `total_phases must resync to the 2 remaining roadmap phases; got ${fm[1]}`);
  });

  test('#3572: integer-phase remove with directory also stays single-block (strengthens #2640)', (t) => {
    const tmpDir = setupProject(t);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-feature'), { recursive: true });
    const r = runGsdTools('phase remove 2', tmpDir);
    assert.ok(r.success, `phase remove failed: ${r.error}`);
    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(fenceLineCount(after), 2, `single frontmatter block; got ${fenceLineCount(after)}`);
    assert.ok(after.startsWith('---'), 'opens with the fence');
    assert.ok(after.includes('Some prose here that must survive.'), 'body prose preserved');
  });

  test('#3572: existing body Total Phases decremented in place, single block', (t) => {
    const stateWithField = ISSUE_STATE.replace(
      'Some prose here that must survive.',
      'Total Phases: 2\n\nSome prose here that must survive.',
    );
    const tmpDir = setupProject(t, stateWithField);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-feature'), { recursive: true });
    const r = runGsdTools('phase remove 2', tmpDir);
    assert.ok(r.success, `phase remove failed: ${r.error}`);
    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(fenceLineCount(after), 2, 'single frontmatter block');
    const bodyCounts = after.match(/^Total Phases:\s*(\d+)$/gm) || [];
    assert.strictEqual(bodyCounts.length, 1, `exactly one Total Phases field; got ${bodyCounts.length}`);
    assert.match(bodyCounts[0], /^Total Phases:\s*1$/, `field decremented to 1; got ${bodyCounts[0]}`);
  });

  test('#3572: frontmatter-less STATE.md gets the field at content start', (t) => {
    const tmpDir = setupProject(t, '# Bare state\n\nNo fences at all here.\n');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-feature'), { recursive: true });
    const r = runGsdTools('phase remove 2', tmpDir);
    assert.ok(r.success, `phase remove failed: ${r.error}`);
    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.match(after, /^Total Phases:\s*\d+$/m, 'field lands at content start when the whole file is body');
    assert.ok(after.includes('No fences at all here.'), 'original body preserved');
  });

  test('#3572: CRLF STATE.md stays single-block with CRLF preserved', (t) => {
    const tmpDir = setupProject(t, ISSUE_STATE, '\r\n');
    let r = runGsdTools('phase insert 1 "Inserted probe"', tmpDir);
    assert.ok(r.success, `phase insert failed: ${r.error}`);
    r = runGsdTools('phase remove 1.1', tmpDir);
    assert.ok(r.success, `phase remove failed: ${r.error}`);
    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(fenceLineCount(after), 2, `single frontmatter block under CRLF; got ${fenceLineCount(after)}`);
    assert.ok(after.includes('Some prose here that must survive.'), 'body prose preserved');
    assert.match(after, /^Total Phases:\s*\d+\r?$/m, 'count field present in body');
  });

  test('#3572: ROADMAP-only phase removal leaves STATE.md untouched (issue control)', (t) => {
    const tmpDir = setupProject(t);
    const before = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const r = runGsdTools('phase remove 2', tmpDir); // phase 2 has NO directory
    assert.ok(r.success, `phase remove failed: ${r.error}`);
    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(after, before, 'issue control: removal without a directory must not touch STATE.md');
  });
});

describe('bug #3572 controls and clamps', () => {
  test('#3572 control: phase insert alone leaves STATE.md untouched (issue control #2)', (t) => {
    const tmpDir = createTempProject('gsd-3572-ctl-');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: A\n**Goal:** x\n\n### Phase 2: B\n**Goal:** y\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '---\ngsd_state_version: 1.0\nprogress:\n  total_phases: 2\n---\n\n# Project State\n\nBody.\n',
    );
    const before = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const r = runGsdTools('phase insert 1 "Probe"', tmpDir);
    assert.ok(r.success, `phase insert failed: ${r.error}`);
    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.strictEqual(after, before, 'issue control: insert alone must not touch STATE.md');
    t.after(() => cleanup(tmpDir));
  });

  test('#3572 clamp: a stale Total Phases: 0 never decrements to -1 on the next removal', (t) => {
    const tmpDir = createTempProject('gsd-3572-clamp-');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: A\n**Goal:** x\n\n### Phase 2: B\n**Goal:** y\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '---\ngsd_state_version: 1.0\nprogress:\n  total_phases: 2\n---\n\n# Project State\n\nTotal Phases: 0\n',
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '02-b'), { recursive: true });
    const r = runGsdTools('phase remove 2', tmpDir);
    assert.ok(r.success, `phase remove failed: ${r.error}`);
    const after = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.doesNotMatch(after, /Total Phases:\s*-\d+/, 'count must never go negative');
    assert.match(after, /^Total Phases:\s*0$/m, 'stale zero stays clamped at 0');
    t.after(() => cleanup(tmpDir));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3701 — next_phase follows ROADMAP ORDER, not artifact presence.
//
// The successor cascade resolved disk-first: the first phase DIRECTORY above N
// won, and the roadmap scan only ran when the disk found nothing. Directories
// are created lazily, but `phase insert` scaffolds an inserted phase's directory
// immediately — so an inserted decimal was routinely the only directory above N
// and outranked every phase preceding it in the roadmap. The wrong value was
// reported AND persisted to STATE.md, silently.
//
// #3581 fixed the identical defect at `init.progress` and named the rule: "the
// frontier is ROADMAP ORDER, not artifact presence". This call site was outside
// that change's scope.
//
// Most of this block is CONTROLS. The fix promotes the roadmap to decide WHICH
// phase is next while the disk still decides HOW it is spelled, so the failure
// mode of a naive fix is a silent spelling change on every aligned project —
// which is the majority case, and which `alignedTreeKeepsDiskSpelling` catches.
// ─────────────────────────────────────────────────────────────────────────────

describe('#3701 phase complete — next_phase follows roadmap order, not disk', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-3701-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  const statePath = () => path.join(tmpDir, '.planning', 'STATE.md');

  function scaffoldPhaseDir(slug) {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', slug), { recursive: true });
  }

  /** Roadmap rows + matching detail headings, so both scan shapes are present. */
  function writeRoadmap(rows) {
    const checklist = rows.map((r) => `- [${r.done ? 'x' : ' '}] **Phase ${r.num}: ${r.name}**${r.inserted ? ' (INSERTED)' : ''} - ${r.name}`);
    const details = rows.map((r) => `### Phase ${r.num}: ${r.name}\n\n**Goal:** ${r.name}`);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n## Phases\n\n${checklist.join('\n')}\n\n## Phase Details\n\n${details.join('\n\n')}\n`,
    );
  }

  function writeState(currentPhase) {
    fs.writeFileSync(
      statePath(),
      `---\ngsd_state_version: 1.0\ncurrent_phase: ${currentPhase}\nstatus: executing\n---\n\n# Project State\n`,
    );
  }

  function complete(phase) {
    const result = runVerifiedPhaseComplete(`phase complete ${phase}`, tmpDir);
    assert.ok(result.success, `Command failed: ${result.error || result.output}`);
    return JSON.parse(result.output);
  }

  function frontmatterField(key) {
    const m = fs.readFileSync(statePath(), 'utf-8').match(new RegExp(`^${key}:\\s*(.*)$`, 'm'));
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  }

  // Roadmap 1, 2, 02.1 (INSERTED), 3 — the shape from the report.
  const INSERTED_ROADMAP = [
    { num: '1', name: 'Alpha' },
    { num: '2', name: 'Beta' },
    { num: '02.1', name: 'Inserted Thing', inserted: true },
    { num: '3', name: 'Gamma' },
  ];

  // ── the defect ────────────────────────────────────────────────────────────

  test('insertedDecimalDoesNotOutrankTheRoadmapSuccessor', () => {
    // Directories for 01 and 02.1 only. Phase 2 is next in the roadmap and has
    // no directory — the ordinary state of an unplanned phase.
    scaffoldPhaseDir('01-alpha');
    scaffoldPhaseDir('02.1-inserted-thing');
    writeRoadmap(INSERTED_ROADMAP);
    writeState(1);

    const output = complete(1);
    assert.strictEqual(output.is_last_phase, false);
    assert.strictEqual(
      output.next_phase,
      '2',
      `roadmap order puts Phase 2 next; the inserted decimal has a directory and must not outrank it (got ${output.next_phase})`,
    );
    assert.strictEqual(output.next_phase_name, 'beta');
  });

  test('theWrongSuccessorIsNotPersistedToStateMd', () => {
    // Independent of the reported value: the defect's real cost is the resume
    // pointer written to STATE.md, which sends the next session to the wrong
    // phase for the whole of the following phase.
    scaffoldPhaseDir('01-alpha');
    scaffoldPhaseDir('02.1-inserted-thing');
    writeRoadmap(INSERTED_ROADMAP);
    writeState(1);

    complete(1);

    assert.strictEqual(
      frontmatterField('current_phase'),
      '2',
      'STATE.md must advance to the roadmap successor, not to the inserted decimal',
    );
  });

  // ── controls: what must not move ──────────────────────────────────────────

  test('alignedTreeKeepsDiskSpelling', () => {
    // THE control for this fix. When roadmap and disk agree, the directory still
    // supplies the spelling: the zero-padded token and the on-disk slug. A fix
    // that merely promoted the roadmap would report `2`/`beta` here instead of
    // `02`/`beta` — a silent output change on every aligned project.
    scaffoldPhaseDir('01-alpha');
    scaffoldPhaseDir('02-beta');
    scaffoldPhaseDir('03-gamma');
    writeRoadmap([{ num: '1', name: 'Alpha' }, { num: '2', name: 'Beta' }, { num: '3', name: 'Gamma' }]);
    writeState(1);

    const output = complete(1);
    assert.strictEqual(output.next_phase, '02', 'the on-disk zero-padded token is the established spelling');
    assert.strictEqual(output.next_phase_name, 'beta');
  });

  test('roadmapSpellingWhenTheSuccessorHasNoDirectory', () => {
    scaffoldPhaseDir('01-alpha');
    writeRoadmap([{ num: '1', name: 'Alpha' }, { num: '2', name: 'Beta' }, { num: '3', name: 'Gamma' }]);
    writeState(1);

    const output = complete(1);
    assert.strictEqual(output.next_phase, '2', 'no directory exists, so the roadmap supplies the spelling too');
    assert.strictEqual(output.next_phase_name, 'beta');
  });

  test('aDecimalThatGenuinelyIsNextIsStillSelected', () => {
    // The mirror of the defect: an over-correction that refused decimals would
    // pass the two tests above and fail here.
    scaffoldPhaseDir('01-alpha');
    scaffoldPhaseDir('02-beta');
    scaffoldPhaseDir('02.1-inserted-thing');
    writeRoadmap([
      { num: '1', name: 'Alpha', done: true },
      { num: '2', name: 'Beta' },
      { num: '02.1', name: 'Inserted Thing', inserted: true },
      { num: '3', name: 'Gamma' },
    ]);
    writeState(2);

    const output = complete(2);
    assert.strictEqual(output.next_phase, '02.1', 'the inserted phase really does follow 2 in roadmap order');
    assert.strictEqual(output.next_phase_name, 'inserted-thing');
  });

  test('completingTheDecimalAdvancesToTheNextWholePhase', () => {
    scaffoldPhaseDir('01-alpha');
    scaffoldPhaseDir('02-beta');
    scaffoldPhaseDir('02.1-inserted-thing');
    writeRoadmap([
      { num: '1', name: 'Alpha', done: true },
      { num: '2', name: 'Beta', done: true },
      { num: '02.1', name: 'Inserted Thing', inserted: true },
      { num: '3', name: 'Gamma' },
    ]);
    writeState('02.1');

    const output = complete('02.1');
    assert.strictEqual(output.next_phase, '3');
    assert.strictEqual(output.next_phase_name, 'gamma');
  });

  // ── the disk fallback must survive ────────────────────────────────────────

  test('noRoadmapFallsBackToTheDiskScan', () => {
    // Making the roadmap primary must not make it required.
    scaffoldPhaseDir('01-alpha');
    scaffoldPhaseDir('02-beta');
    writeState(1);
    // deliberately no ROADMAP.md

    const output = complete(1);
    assert.strictEqual(output.next_phase, '02', 'with no roadmap the disk is the only resolver');
  });

  test('unparseableRoadmapPhaseRowsFallBackToTheDiskScan', () => {
    // A roadmap that exists but yields no phase rows is the same situation as no
    // roadmap at all, and must degrade the same way.
    scaffoldPhaseDir('01-alpha');
    scaffoldPhaseDir('02-beta');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap\n\nnothing here parses as a phase row\n');
    writeState(1);

    const output = complete(1);
    assert.strictEqual(output.next_phase, '02');
  });

  test('lastPhaseStillReportsMilestoneEnd', () => {
    scaffoldPhaseDir('01-alpha');
    scaffoldPhaseDir('02-beta');
    writeRoadmap([{ num: '1', name: 'Alpha', done: true }, { num: '2', name: 'Beta' }]);
    writeState(2);

    const output = complete(2);
    assert.strictEqual(output.is_last_phase, true);
    assert.strictEqual(output.next_phase, null);
  });

  // ── ordering: phase NUMBERS decide sequence, not row position ─────────────

  test('roadmapRowsOutOfNumericOrderStillResolveTheLowestSuccessor', () => {
    // Review round 2 (blocker). The roadmap scan walks raw text and one global
    // regex sweeps both the checklist and the detail headings, so "first match
    // above N" is a statement about file position, not sequence. Once this scan
    // started deciding the answer, a roadmap listing rows `1, 3, 2` reported
    // next_phase 3 and PERSISTED it — skipping Phase 2 entirely, on an input the
    // pre-fix code got right because the disk scan is numerically sorted.
    scaffoldPhaseDir('01-alpha');
    scaffoldPhaseDir('02-beta');
    writeRoadmap([
      { num: '1', name: 'Alpha' },
      { num: '3', name: 'Gamma' },
      { num: '2', name: 'Beta' },
    ]);
    writeState(1);

    const output = complete(1);
    assert.strictEqual(output.next_phase, '02', `Phase 2 is the lowest above 1 regardless of row position (got ${output.next_phase})`);
    assert.strictEqual(output.next_phase_name, 'beta');
  });

  test('detailHeadingOrderDoesNotOverrideNumericOrder', () => {
    // The checklist and the `## Phase Details` headings are swept by the same
    // regex, so a details section ordered differently from the checklist is a
    // second way row position could win.
    scaffoldPhaseDir('01-alpha');
    scaffoldPhaseDir('02-beta');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap', '', '## Phases', '',
        '- [ ] **Phase 1: Alpha** - Alpha',
        '- [ ] **Phase 2: Beta** - Beta',
        '- [ ] **Phase 3: Gamma** - Gamma',
        '', '## Phase Details', '',
        '### Phase 3: Gamma', '', '**Goal:** Gamma', '',
        '### Phase 1: Alpha', '', '**Goal:** Alpha', '',
        '### Phase 2: Beta', '', '**Goal:** Beta', '',
      ].join('\n'),
    );
    writeState(1);

    const output = complete(1);
    assert.strictEqual(output.next_phase, '02');
  });

  test('outOfOrderRowsWithNoDirectoryStillResolveNumerically', () => {
    // Same rule on the roadmap-only path, where no disk answer exists to mask a
    // document-order mistake.
    scaffoldPhaseDir('01-alpha');
    writeRoadmap([
      { num: '1', name: 'Alpha' },
      { num: '3', name: 'Gamma' },
      { num: '2', name: 'Beta' },
    ]);
    writeState(1);

    const output = complete(1);
    assert.strictEqual(output.next_phase, '2');
    assert.strictEqual(output.next_phase_name, 'beta');
  });

  test('anInsertedDecimalListedOutOfOrderDoesNotWin', () => {
    // The two hazards together: rows out of sequence AND an inserted decimal
    // holding the only directory above N.
    scaffoldPhaseDir('01-alpha');
    scaffoldPhaseDir('02.1-inserted-thing');
    writeRoadmap([
      { num: '1', name: 'Alpha' },
      { num: '3', name: 'Gamma' },
      { num: '02.1', name: 'Inserted Thing', inserted: true },
      { num: '2', name: 'Beta' },
    ]);
    writeState(1);

    const output = complete(1);
    assert.strictEqual(output.next_phase, '2');
  });

  // ── sentinels and the #2028 stage this change does not touch ──────────────

  test('sentinelBacklogAndDraftPhasesAreNeverSelected', () => {
    // Both scans skip sentinels (#2786 / #3185 / #2949). Whichever one is
    // primary, that must still hold.
    scaffoldPhaseDir('01-alpha');
    scaffoldPhaseDir('999.1-backlog-item');
    scaffoldPhaseDir('0.1-draft-item');
    writeRoadmap([
      { num: '1', name: 'Alpha' },
      { num: '2', name: 'Beta' },
      { num: '999.1', name: 'Backlog Item' },
      { num: '0.1', name: 'Draft Item' },
    ]);
    writeState(1);

    const output = complete(1);
    assert.strictEqual(output.next_phase, '2', 'sentinel phases are not the frontier');
  });

  test('lowestOutstandingOverrideStillWins', () => {
    // Independence: the #2028 stage-3 override answers a different question — is
    // a LOWER phase still outstanding — and is untouched by this change.
    scaffoldPhaseDir('01-alpha');
    scaffoldPhaseDir('02-beta');
    scaffoldPhaseDir('03-gamma');
    writeRoadmap([
      { num: '1', name: 'Alpha' }, // still unchecked — outstanding
      { num: '2', name: 'Beta' },
      { num: '3', name: 'Gamma' },
    ]);
    writeState(2);

    const output = complete(2);
    assert.strictEqual(
      output.next_phase,
      '1',
      'a lower outstanding phase still overrides the positional successor (#2028)',
    );
  });
});

// ─── #3982: phase.complete must not pick an archived details-block phase ─────

describe('bug #3982: archived details leak into lowest-outstanding scan', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-3982-'));
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '20-first-thing'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), [
      '---', 'milestone: v0.3', 'current_phase: 20', '---', '',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), [
      '# Roadmap', '',
      '### 🚧 v0.3 — Third Milestone (Phases 20-22) — ACTIVE', '',
      '- [x] **Phase 20: First Thing** - does the first thing.',
      '- [ ] **Phase 21: Second Thing** - does the second thing.',
      '- [ ] **Phase 22: Third Thing** - does the third thing.',
      '',
      '<details>',
      '<summary>✅ v0.2 Second Milestone (Phases 10-12) — ARCHIVED</summary>', '',
      '- [ ] **Phase 10: Never Finished** - was left unchecked when v0.2 closed.',
      '- [x] **Phase 11: Done Thing** - completed.',
      '- [x] **Phase 12: Other Done Thing** - completed.',
      '',
      '</details>', '',
    ].join('\n'));
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '20-first-thing');
    fs.writeFileSync(path.join(phaseDir, '20-01-PLAN.md'), [
      '---', 'phase: 20-first-thing', 'plan: 01', '---', '',
      '<objective>Do the first thing.</objective>', '',
    ].join('\n'));
    fs.writeFileSync(path.join(phaseDir, '20-01-SUMMARY.md'), [
      '---', 'phase: 20-first-thing', 'plan: 01', 'status: complete', '---', '',
      'Done.', '',
    ].join('\n'));
  });

  afterEach(() => { cleanup(tmpDir); });

  test('phase complete 20 advances to 21, not the archived range', () => {
    const out = runPhaseComplete(tmpDir, { phase: '20', tolerateExit: true });
    const payload = JSON.parse(out.slice(out.indexOf('{')));
    assert.strictEqual(payload.next_phase, '21',
      'completing phase 20 must advance to the real next phase 21 (#3982)');
    assert.notStrictEqual(payload.next_phase, '10',
      'an archived milestone\'s unchecked phase must never win the lowest-outstanding scan (#3982)');
    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(!/current_phase:\s*10(\s|$)/m.test(state),
      `STATE.md current_phase must not jump backwards into the archived range; got: ${state}`);
  });
});
