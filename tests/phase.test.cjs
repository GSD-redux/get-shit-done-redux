// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.
// allow-test-rule: state-md-is-the-runtime-contract — regression tests for
// bug #3517 assert the exact STATE.md fields written by phase.complete;
// STATE.md IS the product surface being verified, not source code.
// Migration to typed-IR parser tracked in #2974.

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
const { execFileSync, spawnSync } = require('node:child_process');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

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
    // Should find phase 3 from roadmap, NOT 999.1 from filesystem
    assert.strictEqual(output.next_phase, '3', 'next_phase should be 3, not 999.1');
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
  const PMG_WF = path.join(__dirname, '..', 'gsd-core', 'workflows', 'plan-milestone-gaps.md');
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

  describe('bug-3298 — plan-milestone-gaps.md must not construct bare {NN}-{name} phase dirs', () => {
    test('workflow file exists', () => {
      assert.ok(fs.existsSync(PMG_WF), `plan-milestone-gaps.md must exist at ${PMG_WF}`);
    });

    test('step 8 must not use bare {NN}-{name} mkdir pattern', () => {
      const content = readWorkflow(PMG_WF);
      assert.ok(
        !containsBareTemplateMkdir(content),
        'plan-milestone-gaps.md must not contain bare mkdir .planning/phases/{NN}-{name} pattern — use phase.add or expected_phase_dir',
      );
    });

    test('step 8 must use expected_phase_dir or phase.add for directory creation', () => {
      const content = readWorkflow(PMG_WF);
      const usesExpectedPhaseDir = content.includes('expected_phase_dir');
      const usesPhaseAdd = content.includes('phase.add');
      assert.ok(
        usesExpectedPhaseDir || usesPhaseAdd,
        'plan-milestone-gaps.md must use expected_phase_dir (from init.phase-op) or phase.add to create phase directories with project_code prefix',
      );
    });
  });

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
      const match1 = stateAfter1.match(/completed_phases:\s*(\d+)/);
      assert.ok(match1, 'completed_phases not found in frontmatter after first call');
      assert.equal(
        Number(match1[1]),
        2,
        `After first call: completed_phases should be 2 (derived from ROADMAP: phases 4 and 5 complete), got ${match1[1]}`,
      );

      const r2 = runSdkQuery(['phase.complete', '5'], tmpDir);
      assert.ok(r2.success, `second call failed: ${r2.error}`);

      const stateAfter2 = fs.readFileSync(statePath, 'utf8');
      const match2 = stateAfter2.match(/completed_phases:\s*(\d+)/);
      assert.ok(match2, 'completed_phases not found in frontmatter after second call');
      assert.equal(
        Number(match2[1]),
        2,
        `After second call (same phase): completed_phases must remain 2 (idempotent), got ${match2[1]}`,
      );
    });

    test('frontmatter stopped_at is updated after phase.complete', () => {
      setupPhase3517Project(tmpDir);
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');

      const r = runSdkQuery(['phase.complete', '5'], tmpDir);
      assert.ok(r.success, `call failed: ${r.error}`);

      const state = fs.readFileSync(statePath, 'utf8');
      const stoppedMatch = state.match(/stopped_at:\s*(.+)/);
      assert.ok(stoppedMatch, 'stopped_at not found in frontmatter');
      assert.ok(
        !stoppedMatch[1].includes('05-03-PLAN.md'),
        `stopped_at should not still say "Completed 05-03-PLAN.md" — got: ${stoppedMatch[1]}`,
      );
      assert.ok(
        stoppedMatch[1].toLowerCase().includes('phase 5') ||
        stoppedMatch[1].toLowerCase().includes('complete'),
        `stopped_at should reference phase 5 completion, got: ${stoppedMatch[1]}`,
      );
    });

    test('frontmatter last_updated is refreshed to today after phase.complete', () => {
      setupPhase3517Project(tmpDir);
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');

      const r = runSdkQuery(['phase.complete', '5'], tmpDir);
      assert.ok(r.success, `call failed: ${r.error}`);

      const state = fs.readFileSync(statePath, 'utf8');
      const lastUpdatedMatch = state.match(/last_updated:\s*(.+)/);
      assert.ok(lastUpdatedMatch, 'last_updated not found in frontmatter');

      const raw = lastUpdatedMatch[1].trim().replace(/^"(.*)"$/, '$1');

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
      const match = state.match(/total_plans:\s*(\d+)/);
      assert.ok(match, 'total_plans not found in frontmatter');
      const totalPlans = Number(match[1]);
      assert.ok(Number.isFinite(totalPlans) && totalPlans > 0, `total_plans must be a positive number, got: ${match[1]}`);
    });

    test('frontmatter completed_plans is updated from SUMMARY file count after phase.complete', () => {
      setupPhase3517Project(tmpDir);
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');

      const r = runSdkQuery(['phase.complete', '5'], tmpDir);
      assert.ok(r.success, `call failed: ${r.error}`);

      const state = fs.readFileSync(statePath, 'utf8');
      const match = state.match(/completed_plans:\s*(\d+)/);
      assert.ok(match, 'completed_plans not found in frontmatter');
      const completedPlans = Number(match[1]);
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
      const match = state.match(/percent:\s*(\d+)/);
      assert.ok(match, 'percent not found in frontmatter');
      assert.equal(Number(match[1]), 67, `percent should be 67 (2/3 phases), got: ${match[1]}`);
    });

    test('state frontmatter and numeric phase line reflect next phase after phase.complete', () => {
      setupPhase3517Project(tmpDir);
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');

      const r = runSdkQuery(['phase.complete', '5'], tmpDir);
      assert.ok(r.success, `call failed: ${r.error}`);

      const state = fs.readFileSync(statePath, 'utf8');
      assert.match(state, /completed_phases:\s*2/, 'completed_phases must be updated in frontmatter');
      assert.match(state, /Phase:\s*0?6\b/, 'numeric Phase line should advance to phase 6');
    });

    test('prose-block STATE keeps next phase name without field-miss warnings (#1316)', () => {
      const { planningDir } = setupPhase1316Project(tmpDir);
      writePassedVerificationForPhase(tmpDir, '32');

      const result = spawnSync(process.execPath, [GSD_TOOLS_BIN, 'phase', 'complete', '32'], {
        cwd: tmpDir,
        encoding: 'utf8',
        env: process.env,
      });

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
      assert.match(state, /current_phase:\s*"?33"?/, 'current_phase frontmatter must advance to 33');
      assert.match(
        state,
        /^Phase:\s*33\s+—\s+Follow Up Implementation\b/m,
        `Current Position Phase line must keep the next phase name; state:\n${state}`,
      );
      assert.match(
        state,
        /^Last activity:\s*\d{4}-\d{2}-\d{2}\s+—\s+Phase 32 complete/m,
        `Last activity line must use the template em-dash delimiter with narrative; state:\n${state}`,
      );
    });

    test('body By Phase table row for completed phase shows correct plan count', () => {
      setupPhase3517Project(tmpDir);
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');

      const r = runSdkQuery(['phase.complete', '5'], tmpDir);
      assert.ok(r.success, `call failed: ${r.error}`);

      const state = fs.readFileSync(statePath, 'utf8');
      assert.match(
        state,
        /\|\s*5\s*\|\s*7\s*\|/,
        `By Phase table should have a row for phase 5 with 7 summaries.\nState:\n${state}`,
      );
    });

    test('full consistency check: all STATE.md fields are coherent after phase.complete', () => {
      setupPhase3517Project(tmpDir);
      const statePath = path.join(tmpDir, '.planning', 'STATE.md');

      const r = runSdkQuery(['phase.complete', '5'], tmpDir);
      assert.ok(r.success, `call failed: ${r.error}`);
      assert.equal(r.data?.state_updated, true, 'state_updated must be true');

      const state = fs.readFileSync(statePath, 'utf8');

      assert.match(state, /completed_phases:\s*2/, 'completed_phases must be 2 (4 and 5 complete)');
      assert.match(state, /percent:\s*67/, 'percent must be 67%');
      const hasPhase6 = /Phase:\s*0?6/.test(state) || /current_phase:\s*0?6/.test(state);
      assert.ok(hasPhase6, `STATE.md must reference Phase 6 as current after completing Phase 5.\nState:\n${state}`);
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
function createFixture(prefix = 'gsd-4-regression-') {
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
  const phase01Dir = path.join(phasesDir, '01-foundation');
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

    match = line.match(/^\|\s*(\d+[A-Z]?(?:\.\d+)*)\.?\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|$/i);
    if (match) {
      snapshot.progressRows.push({
        phase: match[1].trim(),
        title: match[2].trim(),
        plans: match[3].trim(),
        status: match[4].trim(),
        completed: match[5].trim(),
      });
    }
  }

  return snapshot;
}

function extractField(stateContent, fieldName) {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

// Capture stdout from cmdPhaseComplete (it calls output() which writes to stdout)
function capturePhaseComplete(cwd, phaseNum) {
  // We invoke gsd-tools directly for the full CJS path, but with GSD_DISABLE_SDK_BRIDGE=1
  // to force the CJS implementation. Since no env var disables bridge, we call cmdPhaseComplete
  // directly and redirect output capture.
  const chunks = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  const origErrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = (chunk) => { chunks.push(chunk); return true; };
  process.stderr.write = () => true;
  try {
    cmdPhaseComplete(cwd, phaseNum, false);
  } finally {
    process.stdout.write = origWrite;
    process.stderr.write = origErrWrite;
  }
  return chunks.join('');
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

  test('T1: double invocation does NOT double-increment Completed Phases in STATE.md body', () => {
    // First call — legitimate completion
    capturePhaseComplete(tmpDir, '1');

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
    capturePhaseComplete(tmpDir, '1');

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

    assert.throws(
      () => capturePhaseComplete(tmpDir, '1'),
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

    assert.throws(
      () => capturePhaseComplete(tmpDir, '1'),
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

    assert.throws(
      () => capturePhaseComplete(tmpDir, '1'),
      /injected REQUIREMENTS\.md write failure[\s\S]*WARNING: rollback failed while restoring[\s\S]*injected ROADMAP\.md rollback failure/,
    );
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
  // Match the full progress table row whose first cell starts with the phase number.
  // Use [^|\n] to avoid crossing line boundaries. Capture everything up to the final '|'.
  const re = new RegExp(`^(\\|\\s*${phaseNum}[^|\\n]*(?:\\|[^|\\n]*)*)\\|\\s*$`, 'm');
  const m = roadmapContent.match(re);
  if (!m) return null;
  // m[1] = '| 01. Foundation | 1/1 | Complete    | 2026-01-01 '
  // Split on '|' → ['', ' 01. Foundation ', ' 1/1 ', ' Complete    ', ' 2026-01-01 ']
  // Drop the leading empty string and take the last element.
  const cells = m[1].split('|').slice(1); // drop leading ''
  return cells[cells.length - 1].trim();
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

  test('T2: Progress percent never exceeds 100 after double invocation', () => {
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
    capturePhaseComplete(tmpDir, '1');
    // Second call — this is the problematic one
    capturePhaseComplete(tmpDir, '1');

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
        assert.ok(
          /\|\s*KNOWN-01\s*\|[^|]*\|\s*Complete\s*\|/i.test(reqContent),
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
