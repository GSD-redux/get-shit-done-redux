'use strict';

/**
 * GSD Tools Tests - Milestone Archive Layout and Phase Filter
 *
 * Covers:
 *   - bug #2684: milestone.complete forwards version to phases.archive
 *   - bug #2787: extractCurrentMilestone fenced code block boundary
 *   - bug #3164: validate consistency/health/find-phase with milestone-archive layout
 *   - bug #3600: getMilestonePhaseFilter with project-code-prefixed directories
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, runGsdTools, toPosixPath } = require('./helpers.cjs');
const { findTableBySchema } = require('../gsd-core/bin/lib/markdown-table.cjs');

function runSdkQuery(args, cwd) {
  const result = runGsdTools(args, cwd);
  if (!result.success) return { success: false, error: result.error };
  try {
    return { success: true, data: JSON.parse(result.output || '{}') };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// bug #2684: milestone.complete forwards version to phases.archive
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #2684: milestone.complete forwards version to phases.archive', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('milestone.complete v1.0 does not throw version required error', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 1: Foundation\n**Goal:** Setup\n`,
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });

    const result = runSdkQuery(['milestone.complete', 'v1.0'], tmpDir);
    assert.ok(result.success, `milestone.complete should succeed, got error: ${result.error}`);
    assert.ok(
      !result.error || !result.error.includes('version required'),
      `should not throw "version required" — got: ${result.error}`,
    );
  });

  test('milestone.complete returns version in response data', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 1: Foundation\n**Goal:** Setup\n`,
    );
    // #2946: the unstarted-phase guard now runs whenever --force is absent
    // (independent of STATE.md). This test exercises version-forwarding, not
    // the guard, so give Phase 1 a real directory so the scan is satisfied.
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });

    const result = runSdkQuery(['milestone.complete', 'v2.5'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(result.data.version, 'v2.5');
  });

  test('milestone.complete with --archive-phases forwards version correctly', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 1: Foundation\n**Goal:** Setup\n`,
    );
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phaseDir, '01-01-SUMMARY.md'), '# Summary');

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-phases'], tmpDir);
    assert.ok(result.success, `milestone.complete --archive-phases failed: ${result.error}`);
    assert.strictEqual(result.data.version, 'v1.0');
    assert.ok(result.data.archived.phases === true, 'phases should be archived');
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases')));
  });

  test('phases.archive is no longer a direct public subcommand', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 1: Foundation\n**Goal:** Setup\n`,
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });

    const result = runSdkQuery(['phases.archive', 'v1.0'], tmpDir);
    assert.equal(result.success, false, 'phases.archive should not be callable directly');
    assert.match(result.error || '', /Unknown phases subcommand/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bug #2787: extractCurrentMilestone — fenced code block boundary
// ─────────────────────────────────────────────────────────────────────────────

describe('extractCurrentMilestone — fenced code block boundary (#2787)', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('roadmap analyze returns all phases when a fenced block contains a heading-like line matching the milestone-end pattern', () => {
    const roadmap = [
      '# Project Roadmap',
      '',
      '## ✅ v1.0: Foundation',
      '',
      '<details>',
      '<summary>✅ v1.0 Foundation — SHIPPED</summary>',
      '',
      '### Phase 1: Bootstrap',
      '**Goal:** Bootstrap the project',
      '',
      '</details>',
      '',
      '## Roadmap v1.1: New Work',
      '',
      '### Phase 1: Setup',
      '**Goal:** Set up the environment',
      '',
      '### Phase 2: Core Logic',
      '**Goal:** Implement core logic',
      '',
      'Deployment notes:',
      '',
      '```bash',
      '# Ops runbook — v1.0 compat',
      'echo "deploy complete"',
      '```',
      '',
      '### Phase 3: Testing',
      '**Goal:** Write regression tests',
      '',
      '### Phase 4: Deploy',
      '**Goal:** Ship to production',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '---\nmilestone: v1.1\n---\n\n# GSD State\n');

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `roadmap analyze should succeed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).phase_count, 4, 'All 4 phases in v1.1 should be found');
  });

  test('roadmap analyze returns all phases when a fenced block contains a backtick-tilde fence with milestone-like heading', () => {
    const roadmap = [
      '## Roadmap v2.0: Feature Work',
      '',
      '### Phase 1: Alpha',
      '**Goal:** Alpha release',
      '',
      '~~~markdown',
      '## Prior art (v1.9 snapshot)',
      '~~~',
      '',
      '### Phase 2: Beta',
      '**Goal:** Beta release',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '---\nmilestone: v2.0\n---\n\n# GSD State\n');

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success, `roadmap analyze should succeed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).phase_count, 2, 'Both phases in v2.0 should be found');
  });

  test('fenced block with info string (e.g. ```js) is not closed by a nested info-string line', () => {
    const roadmap = [
      '## Roadmap v3.0: Info-String Edge Case',
      '',
      '### Phase 1: Setup',
      '**Goal:** First phase',
      '',
      '```text',
      '```js',
      '# This heading-like line (v3.0 compat) must NOT end the milestone',
      '```',
      '',
      '### Phase 2: Core',
      '**Goal:** Second phase',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '---\nmilestone: v3.0\n---\n\n# GSD State\n');

    const result = runGsdTools('roadmap analyze', tmpDir);
    assert.ok(result.success);
    assert.strictEqual(JSON.parse(result.output).phase_count, 2, 'Both phases should be found; ```js line must not close fence');
  });

  test('roadmap get-phase finds a phase defined after a fenced code block', () => {
    const roadmap = [
      '## Roadmap v1.1: New Work',
      '',
      '### Phase 1: Setup',
      '**Goal:** Bootstrap',
      '',
      '```bash',
      '# Runbook for v1.0 deploy',
      '```',
      '',
      '### Phase 2: Core',
      '**Goal:** Core implementation',
    ].join('\n');

    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '---\nmilestone: v1.1\n---\n\n# GSD State\n');

    const result = runGsdTools('roadmap get-phase 2', tmpDir);
    assert.ok(result.success);
    const output = JSON.parse(result.output);
    assert.ok(output.found, 'Phase 2 should be found even after a fenced code block');
    assert.strictEqual(output.phase_number, '2');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bug #3164: milestone-archive layout support in validate/find-phase
// ─────────────────────────────────────────────────────────────────────────────

function setupMilestoneArchiveProject(tmpDir, options = {}) {
  const {
    milestone = 'v1.7',
    phases = ['64-secondary-grader-fix'],
    roadmapPhases = ['64'],
  } = options;

  // eslint-disable-next-line local/no-raw-rmsync-in-tests -- mid-fixture setup: removing subdirectory (not temp root teardown)
  fs.rmSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true, force: true });

  const archiveDir = path.join(tmpDir, '.planning', 'milestones', `${milestone}-phases`);
  for (const phase of phases) {
    const phaseDir = path.join(archiveDir, phase);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, 'PLAN.md'), `# Plan\nPhase ${phase}\n`);
  }

  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    `milestone: ${milestone}\n# Session State\n\nPhase: ${roadmapPhases[0]}\n`,
  );
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'PROJECT.md'),
    '# Project\n\n## What This Is\nTest.\n## Core Value\nTest.\n## Requirements\nTest.\n',
  );
  const phaseLines = roadmapPhases.map(n => `### Phase ${n}: Description\n\nGoal: implement it.\n`).join('\n');
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    `# Roadmap\n\n## Roadmap ${milestone}: Current\n\n${phaseLines}\n`,
  );
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'config.json'),
    JSON.stringify({ model_profile: 'balanced', commit_docs: true }, null, 2),
  );
}

describe('#3164 — validate consistency: milestone-archive layout', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('no W006 warnings for phases that exist in .planning/milestones/v*-phases/', () => {
    setupMilestoneArchiveProject(tmpDir, { milestone: 'v1.7', phases: ['64-secondary-grader-fix'], roadmapPhases: ['64'] });

    const result = runGsdTools('validate consistency', tmpDir);
    assert.ok(result.success);

    const w006 = (JSON.parse(result.output).warnings || []).filter(w => w.message.includes('Phase 64') && w.message.includes('no directory'));
    assert.deepStrictEqual(w006, [], `Got spurious W006: ${JSON.stringify(w006)}`);
  });

  test('no W006 when multiple phases exist in milestone-archive layout', () => {
    setupMilestoneArchiveProject(tmpDir, { milestone: 'v1.7', phases: ['48-feature-a', '51-feature-b', '64-feature-c'], roadmapPhases: ['48', '51', '64'] });

    const result = runGsdTools('validate consistency', tmpDir);
    assert.ok(result.success);

    const w006 = (JSON.parse(result.output).warnings || []).filter(w => w.message.includes('no directory'));
    assert.deepStrictEqual(w006, [], `Got spurious W006: ${JSON.stringify(w006)}`);
  });

  test('prefixed archive dir names (CK-64-...) are recognized as phase 64', () => {
    setupMilestoneArchiveProject(tmpDir, { milestone: 'v1.7', phases: ['CK-64-secondary-grader-fix'], roadmapPhases: ['64'] });

    const result = runGsdTools('validate consistency', tmpDir);
    assert.ok(result.success);

    const w006 = (JSON.parse(result.output).warnings || []).filter(w => w.message.includes('Phase 64') && w.message.includes('no directory'));
    assert.deepStrictEqual(w006, [], `Prefixed phase dir should count as phase 64`);
  });

  test('consistency scans only active milestone archive and still validates plans/frontmatter', () => {
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- mid-test setup: removing subdirectory to establish milestone-archive layout
    fs.rmSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true, force: true });

    const oldDir = path.join(tmpDir, '.planning', 'milestones', 'v1.6-phases', '64-legacy');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.writeFileSync(path.join(oldDir, '64-01-PLAN.md'), '# legacy plan\n');

    const activeDir = path.join(tmpDir, '.planning', 'milestones', 'v1.7-phases', '65-current');
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(path.join(activeDir, '65-01-PLAN.md'), '# plan 1\n');
    fs.writeFileSync(path.join(activeDir, '65-03-PLAN.md'), '# plan 3\n');

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Session State\n\n**Milestone:** v1.7 Current Milestone\nPhase: 65\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Roadmap v1.7: Current\n\n### Phase 65: Current work\n\nGoal: test.\n',
    );

    const result = runGsdTools('validate consistency', tmpDir);
    assert.ok(result.success);

    const out = JSON.parse(result.output);
    const warnings = out.warnings || [];
    const warningsPosix = warnings.map(w => toPosixPath(w.message));

    const phase64Warnings = warningsPosix.filter(w => w.includes('Phase 64 exists on disk but not in ROADMAP.md'));
    assert.deepStrictEqual(phase64Warnings, [], 'Old archived milestone phase 64 should not be treated as active');
    // Phase 12 (#3310) migration note: `validate consistency`'s C002
    // (plan-numbering-gap)/C004 (missing-wave) rules now read
    // `PlanningSnapshot`'s `perPhasePlanNumbering`/`perPhaseWaveMissingPlans`
    // fields, which enumerate ONLY the flat `.planning/phases/` root — a
    // disclosed, accepted scope reduction from the pre-migration inline scan
    // (which also walked the active milestone-archive phase root via
    // `collectPhaseRoots`). See `src/health-diagnostic-rules/consistency.cts`'s
    // fidelity-note comment on `checkC002` and
    // `src/planning-snapshot.cts`'s `buildPerPhasePlanScanFields` (called with
    // `paths.phases` only). With `.planning/phases/` removed by this fixture
    // (milestone-archive-only layout), NEITHER C002 nor C004 can fire for the
    // active-archive phase `65-current` anymore — this locks that known,
    // disclosed gap rather than asserting behavior the migration no longer
    // provides.
    assert.ok(
      !warningsPosix.some(w => /Gap in plan numbering in .*milestones\/v1\.7-phases\/65-current/.test(w)),
      `plan-numbering gap is out of scope for milestone-archive phases post-migration; got: ${JSON.stringify(warningsPosix)}`,
    );
    assert.ok(
      !warningsPosix.some(w => /milestones\/v1\.7-phases\/65-current\/65-0[13]-PLAN\.md: missing 'wave'/.test(w)),
      `missing-wave is out of scope for milestone-archive phases post-migration; got: ${JSON.stringify(warningsPosix)}`,
    );
  });
});

describe('#3164 — validate health: milestone-archive layout', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('no W006 warnings for phases that exist in .planning/milestones/v*-phases/', () => {
    setupMilestoneArchiveProject(tmpDir, { milestone: 'v1.7', phases: ['64-secondary-grader-fix'], roadmapPhases: ['64'] });

    const result = runGsdTools('validate health', tmpDir);
    assert.ok(result.success);

    const w006 = (JSON.parse(result.output).warnings || []).filter(w => {
      const msg = typeof w === 'string' ? w : w.message;
      return msg && msg.includes('Phase 64') && msg.includes('no directory');
    });
    assert.deepStrictEqual(w006, []);
  });
});

describe('#3164 — find-phase: milestone-archive layout', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('find-phase 64 returns found:true for phase in .planning/milestones/v*-phases/', () => {
    setupMilestoneArchiveProject(tmpDir, { milestone: 'v1.7', phases: ['64-secondary-grader-fix'], roadmapPhases: ['64'] });

    const result = runGsdTools('find-phase 64', tmpDir);
    assert.ok(result.success);
    assert.strictEqual(JSON.parse(result.output).found, true);
  });

  test('find-phase searches milestone archives in deterministic sorted order', () => {
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- mid-test setup: removing phases subdirectory to establish milestone-archive layout
    fs.rmSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true, force: true });

    const milestonesDir = path.join(tmpDir, '.planning', 'milestones');
    const v110 = path.join(milestonesDir, 'v1.10-phases', '64-from-110');
    const v12 = path.join(milestonesDir, 'v1.2-phases', '64-from-12');
    fs.mkdirSync(v110, { recursive: true });
    fs.mkdirSync(v12, { recursive: true });
    fs.writeFileSync(path.join(v110, 'PLAN.md'), '# v1.10 plan\n');
    fs.writeFileSync(path.join(v12, 'PLAN.md'), '# v1.2 plan\n');

    const result = runGsdTools('find-phase 64', tmpDir);
    assert.ok(result.success);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.found, true);
    assert.strictEqual(out.directory, '.planning/milestones/v1.2-phases/64-from-12');
  });

  test('find-phase not-found payload includes searched_directories', () => {
    setupMilestoneArchiveProject(tmpDir, { milestone: 'v1.7', phases: ['64-secondary-grader-fix'], roadmapPhases: ['64'] });

    const result = runGsdTools('find-phase 999', tmpDir);
    assert.ok(result.success);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.found, false);
    assert.ok(Array.isArray(out.searched_directories));
    assert.ok(
      out.searched_directories.includes('.planning/milestones/v1.7-phases'),
      `searched_directories should include active archive dir, got: ${JSON.stringify(out.searched_directories)}`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// bug #3600: milestone phase filter understands project-code-prefixed directories
// ─────────────────────────────────────────────────────────────────────────────

describe('bug #3600: milestone phase filter understands project-code-prefixed directories', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject('bug-3600-'); });
  afterEach(() => { cleanup(tmpDir); });

  function writeState(tmpDir, version) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), `---\nmilestone: ${version}\n---\n`);
  }
  function writeRoadmap(tmpDir, body) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), body);
  }
  function writeConfig(tmpDir, configObj) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify(configObj, null, 2));
  }
  function ensurePhaseDir(tmpDir, name) {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', name), { recursive: true });
  }

  test('init.new-milestone counts CK-NN-name dirs against numeric `Phase N:` headings', () => {
    writeConfig(tmpDir, { project_code: 'CK' });
    writeState(tmpDir, 'v1.0.0');
    writeRoadmap(tmpDir, [
      '# Roadmap', '',
      '## Current Milestone: v1.0.0 - Test', '',
      '### Phase 1: Discovery', '**Goal:** GoalOne', '',
      '### Phase 2: Build', '**Goal:** GoalTwo', '',
    ].join('\n'));
    ensurePhaseDir(tmpDir, 'CK-01-discovery');
    ensurePhaseDir(tmpDir, 'CK-02-build');

    const r = runGsdTools(['init', 'new-milestone', '--json'], tmpDir);
    assert.ok(r.success, `init new-milestone failed: ${r.error || r.output}`);
    const payload = JSON.parse(r.output);
    assert.strictEqual(payload.phase_dir_count, 2,
      `expected phase_dir_count=2, got ${payload.phase_dir_count}`);
  });

  test('unprefixed directories continue to count (#3537 / existing contract)', () => {
    writeState(tmpDir, 'v1.0.0');
    writeRoadmap(tmpDir, [
      '# Roadmap', '',
      '## Current Milestone: v1.0.0 - Test', '',
      '### Phase 1: First', '**Goal:** g', '',
    ].join('\n'));
    ensurePhaseDir(tmpDir, '01-first');

    const r = runGsdTools(['init', 'new-milestone', '--json'], tmpDir);
    assert.ok(r.success);
    assert.strictEqual(JSON.parse(r.output).phase_dir_count, 1);
  });

  test('custom-ID match for PROJ-42 directory + Phase PROJ-42: heading still works', () => {
    writeConfig(tmpDir, { project_code: 'PROJ' });
    writeState(tmpDir, 'v1.0.0');
    writeRoadmap(tmpDir, [
      '# Roadmap', '',
      '## Current Milestone: v1.0.0 - Test', '',
      '### Phase PROJ-42: Custom', '**Goal:** g', '',
    ].join('\n'));
    ensurePhaseDir(tmpDir, 'PROJ-42');

    const r = runGsdTools(['init', 'new-milestone', '--json'], tmpDir);
    assert.ok(r.success);
    assert.strictEqual(JSON.parse(r.output).phase_dir_count, 1,
      'PROJ-42 directory must still match Phase PROJ-42: via the custom-ID path');
  });

  test('directories that do not match the milestone do NOT count (counter-test)', () => {
    writeConfig(tmpDir, { project_code: 'CK' });
    writeState(tmpDir, 'v1.0.0');
    writeRoadmap(tmpDir, [
      '# Roadmap', '',
      '## Current Milestone: v1.0.0 - Test', '',
      '### Phase 1: First', '**Goal:** g', '',
    ].join('\n'));
    ensurePhaseDir(tmpDir, 'CK-01-first');
    ensurePhaseDir(tmpDir, 'CK-99-backlog');
    ensurePhaseDir(tmpDir, 'CK-100-future');

    const r = runGsdTools(['init', 'new-milestone', '--json'], tmpDir);
    assert.ok(r.success);
    assert.strictEqual(JSON.parse(r.output).phase_dir_count, 1,
      'only CK-01-first should match Phase 1; CK-99 and CK-100 must be excluded');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2142: quick task archival at milestone close-out
// ─────────────────────────────────────────────────────────────────────────────

function setupQuickArchiveRoadmap(tmpDir) {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    `# Roadmap\n\n### Phase 1: Foundation\n**Goal:** Setup\n`,
  );
  fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });
}

function writeQuickTaskDir(tmpDir, name, files = {}) {
  const dir = path.join(tmpDir, '.planning', 'quick', name);
  fs.mkdirSync(dir, { recursive: true });
  for (const [filename, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, filename), content);
  }
  return dir;
}

function quickTasksStateWithRows(count) {
  const rows = [];
  for (let i = 1; i <= count; i++) {
    rows.push(`| ${i} | quick task ${i} | 2026-01-0${i} | abc000${i} | — |`);
  }
  return [
    '# STATE',
    '',
    '### Quick Tasks Completed',
    '',
    '| # | Description | Date | Commit | Directory |',
    '|---|-------------|------|--------|-----------|',
    ...rows,
    '',
    '### Blockers/Concerns',
    'None',
  ].join('\n');
}

describe('#2142: quick task archival at milestone close-out', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('leavesQuickTasksInPlaceWhenFlagAbsent', () => {
    setupQuickArchiveRoadmap(tmpDir);
    const quickDir = writeQuickTaskDir(tmpDir, '2026-01-01-fix-typo', {
      '2026-01-01-fix-typo-SUMMARY.md': '# Summary\n',
    });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), quickTasksStateWithRows(1));

    const result = runSdkQuery(['milestone.complete', 'v1.0'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);
    assert.strictEqual(result.data.archived.quick, false, 'archived.quick must be false when --archive-quick is absent');
    assert.ok(fs.existsSync(quickDir), 'quick task directory must remain in place');
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick')),
      'no quick archive dir should be created',
    );

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const table = findTableBySchema(stateContent, 'QuickTasks');
    assert.ok(table, 'Quick Tasks table must still be present');
    assert.strictEqual(table.rows.length, 1, 'quick task row must remain untouched');
  });

  test('archivesQuickTasksAndResetsTableWhenFlagPassed', () => {
    setupQuickArchiveRoadmap(tmpDir);
    const names = ['2026-01-01-a', '2026-01-02-b', '2026-01-03-c'];
    for (const name of names) writeQuickTaskDir(tmpDir, name);
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), quickTasksStateWithRows(3));

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick'], tmpDir);
    assert.ok(result.success, `milestone.complete --archive-quick failed: ${result.error}`);
    assert.strictEqual(result.data.archived.quick, true);

    const archiveDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick');
    for (const name of names) {
      assert.ok(
        !fs.existsSync(path.join(tmpDir, '.planning', 'quick', name)),
        `${name} must be moved out of .planning/quick`,
      );
      assert.ok(fs.existsSync(path.join(archiveDir, name)), `${name} must exist in the archive dir`);
    }
    assert.ok(fs.statSync(path.join(archiveDir, 'README.md')).isFile(), 'README.md index must be generated');
    // allow-test-rule: source-text-is-the-product (#2142)
    const readme = fs.readFileSync(path.join(archiveDir, 'README.md'), 'utf-8');
    for (const name of names) {
      assert.ok(readme.includes(name), `README.md must name ${name}`);
    }

    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const table = findTableBySchema(stateContent, 'QuickTasks');
    assert.ok(table, 'Quick Tasks table header must survive the reset');
    assert.strictEqual(table.rows.length, 0, 'all quick task rows must be cleared');
  });

  test('noOpsWhenQuickDirectoryAbsent', () => {
    setupQuickArchiveRoadmap(tmpDir);

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);
    assert.strictEqual(result.data.archived.quick, false);
    assert.ok(!fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick')));
  });

  test('doesNotCreateArchiveDirForEmptyQuickDir', () => {
    setupQuickArchiveRoadmap(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'quick'), { recursive: true });

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);
    assert.strictEqual(result.data.archived.quick, false, 'boundary 0: an empty quick dir must not count as archived');
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick')),
      'no archive dir for zero entries',
    );
  });

  test('archivesSingleQuickTaskDirectory', () => {
    setupQuickArchiveRoadmap(tmpDir);
    writeQuickTaskDir(tmpDir, '2026-02-01-only-one');

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);
    assert.strictEqual(result.data.archived.quick, true, 'boundary 1: a single quick task dir must archive');
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick', '2026-02-01-only-one')));
  });

  test('archivesMultipleQuickTaskDirectories', () => {
    setupQuickArchiveRoadmap(tmpDir);
    writeQuickTaskDir(tmpDir, '2026-02-01-first');
    writeQuickTaskDir(tmpDir, '2026-02-02-second');

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);
    assert.strictEqual(result.data.archived.quick, true, 'boundary 2: multiple quick task dirs must archive');
    const archiveDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick');
    assert.ok(fs.existsSync(path.join(archiveDir, '2026-02-01-first')));
    assert.ok(fs.existsSync(path.join(archiveDir, '2026-02-02-second')));
  });

  test('archivesWhenStateHasNoQuickTasksSection', () => {
    setupQuickArchiveRoadmap(tmpDir);
    writeQuickTaskDir(tmpDir, '2026-03-01-no-section');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# STATE\n\n### Blockers/Concerns\nNone\n');

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick'], tmpDir);
    assert.ok(result.success, `milestone.complete must succeed even without a Quick Tasks Completed section: ${result.error}`);
    assert.strictEqual(result.data.archived.quick, true);
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick', '2026-03-01-no-section')));
    // #2142 design doc §40 behavior table row 5: an absent "Quick Tasks
    // Completed" section is the common, silent no-op path (the section is
    // created lazily by quick.md, not by templates/state.md) — it must
    // never be surfaced as a preservation_warnings entry.
    assert.ok(
      !(result.data.preservation_warnings || []).some((w) => w.field === 'quick_tasks_table'),
      `an absent Quick Tasks Completed section must not produce a quick_tasks_table warning, got: ${JSON.stringify(result.data.preservation_warnings)}`,
    );
  });

  test('refusesResetAndWarnsWhenQuickTasksTableHasNonCanonicalHeader', () => {
    setupQuickArchiveRoadmap(tmpDir);
    writeQuickTaskDir(tmpDir, '2026-03-02-noncanonical');
    const nonCanonicalState = [
      '# STATE',
      '',
      '### Quick Tasks Completed',
      '',
      '| # | Thing | When |',
      '|---|-------|------|',
      '| 1 | custom thing | 2026-03-02 |',
      '',
      '### Blockers/Concerns',
      'None',
    ].join('\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), nonCanonicalState);

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick'], tmpDir);
    assert.ok(result.success, `milestone.complete must succeed even when the reset is refused: ${result.error}`);
    // The quick directories still move — only the STATE.md table reset is refused.
    assert.strictEqual(result.data.archived.quick, true);
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick', '2026-03-02-noncanonical')));

    assert.ok(
      (result.data.preservation_warnings || []).some((w) => w.field === 'quick_tasks_table'),
      `a non-canonical Quick Tasks table header must produce a quick_tasks_table warning, got: ${JSON.stringify(result.data.preservation_warnings)}`,
    );

    // allow-test-rule: source-text-is-the-product (#2142)
    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(
      stateContent.includes('| # | Thing | When |'),
      'the non-canonical header must survive byte-exact since the reset was refused',
    );
    assert.ok(
      stateContent.includes('| 1 | custom thing | 2026-03-02 |'),
      'the original data row must remain on disk — a refused reset must not drop rows',
    );
  });

  test('suffixesCollidingQuickTaskDirectoryOnRerun', () => {
    setupQuickArchiveRoadmap(tmpDir);
    const name = '2026-04-01-rerun';
    writeQuickTaskDir(tmpDir, name, { 'new-marker.txt': 'new run\n' });

    const archiveDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick');
    fs.mkdirSync(path.join(archiveDir, name), { recursive: true });
    fs.writeFileSync(path.join(archiveDir, name, 'existing-marker.txt'), 'prior run\n');

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);
    assert.ok(fs.existsSync(path.join(archiveDir, name, 'existing-marker.txt')), 'prior archive entry must survive');
    assert.strictEqual(
      fs.readFileSync(path.join(archiveDir, name, 'existing-marker.txt'), 'utf-8'),
      'prior run\n',
      'prior archive entry contents must be untouched',
    );
    assert.ok(fs.existsSync(path.join(archiveDir, `${name}.1`)), 'the newly-archived dir must be suffixed .1');
    assert.ok(
      fs.existsSync(path.join(archiveDir, `${name}.1`, 'new-marker.txt')),
      "the suffixed dir must carry this run's content",
    );
  });

  test('indexLinksPerTaskSummaryFile', () => {
    setupQuickArchiveRoadmap(tmpDir);
    const name = '2026-05-01-per-task-summary';
    writeQuickTaskDir(tmpDir, name, { [`${name}-SUMMARY.md`]: '# Summary\nDid the thing.\n' });

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);
    const readmePath = path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick', 'README.md');
    // allow-test-rule: source-text-is-the-product (#2142)
    const readme = fs.readFileSync(readmePath, 'utf-8');
    assert.ok(readme.includes(name), 'README.md must list the task directory');
    assert.ok(readme.includes(`${name}-SUMMARY.md`), 'README.md must link the per-task summary file');
  });

  test('indexLinksLegacyBareSummaryFile', () => {
    setupQuickArchiveRoadmap(tmpDir);
    const name = '2026-05-02-bare-summary';
    writeQuickTaskDir(tmpDir, name, { 'SUMMARY.md': '# Summary\nDid the other thing.\n' });

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);
    const readmePath = path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick', 'README.md');
    // allow-test-rule: source-text-is-the-product (#2142)
    const readme = fs.readFileSync(readmePath, 'utf-8');
    assert.ok(readme.includes(name), 'README.md must list the task directory');
    assert.ok(readme.includes('SUMMARY.md'), 'README.md must link the legacy bare summary file');
  });

  test('indexListsTaskWithoutSummaryWithoutLink', () => {
    setupQuickArchiveRoadmap(tmpDir);
    const name = '2026-05-03-no-summary';
    writeQuickTaskDir(tmpDir, name); // no files at all

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);
    const readmePath = path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick', 'README.md');
    // allow-test-rule: source-text-is-the-product (#2142)
    const readme = fs.readFileSync(readmePath, 'utf-8');
    assert.ok(readme.includes(name), 'README.md must still list a task directory with no summary');
    assert.ok(
      !readme.includes(`(${name}/`),
      'README.md must not link into a directory that has no summary file to point at',
    );
  });

  test('skipsNonDirectoryEntriesInQuickDir', () => {
    setupQuickArchiveRoadmap(tmpDir);
    fs.mkdirSync(path.join(tmpDir, '.planning', 'quick'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'quick', 'stray-notes.txt'), 'not a task dir\n');
    writeQuickTaskDir(tmpDir, '2026-06-01-real-task');

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'quick', 'stray-notes.txt')),
      'a loose file must not be archived',
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick', 'stray-notes.txt')),
      'loose file must not appear under the archive dir',
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick', '2026-06-01-real-task')),
      'the real task directory must still archive',
    );
  });

  test('dryRunPreviewsQuickArchivalWithoutMutating', () => {
    setupQuickArchiveRoadmap(tmpDir);
    const names = ['2026-07-01-preview-a', '2026-07-02-preview-b'];
    for (const name of names) writeQuickTaskDir(tmpDir, name);

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--dry-run', '--archive-quick'], tmpDir);
    assert.ok(result.success, `milestone.complete --dry-run failed: ${result.error}`);
    assert.ok(Array.isArray(result.data.would_archive.quick), 'would_archive.quick must be an array');
    for (const name of names) {
      assert.ok(result.data.would_archive.quick.includes(name), `would_archive.quick must name ${name}`);
      assert.ok(
        fs.existsSync(path.join(tmpDir, '.planning', 'quick', name)),
        `${name} must remain on disk after a dry run`,
      );
    }
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick')),
      'dry run must not create the archive dir',
    );
  });

  test('rejectsVersionWithPathSeparator', () => {
    setupQuickArchiveRoadmap(tmpDir);
    writeQuickTaskDir(tmpDir, '2026-08-01-evil-version');

    const result = runSdkQuery(['milestone.complete', '../evil', '--archive-quick'], tmpDir);
    assert.strictEqual(result.success, false, 'a version containing a path separator must be rejected');
    assert.ok(!fs.existsSync(path.join(tmpDir, '..', 'evil')), 'nothing must be created outside the temp fixture root');
    const milestonesDir = path.join(tmpDir, '.planning', 'milestones');
    if (fs.existsSync(milestonesDir)) {
      for (const entry of fs.readdirSync(milestonesDir)) {
        assert.ok(!entry.includes('..'), `no traversal-shaped entry may exist under milestones/: ${entry}`);
      }
    }
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'quick', '2026-08-01-evil-version')),
      'quick task dir must remain untouched on refusal',
    );
  });

  test('archivesQuickTaskWithUnicodeAndSpaces', () => {
    setupQuickArchiveRoadmap(tmpDir);
    const name = '2026-01-01-café report';
    writeQuickTaskDir(tmpDir, name);

    const result = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick'], tmpDir);
    assert.ok(result.success, `milestone.complete failed: ${result.error}`);
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick', name)),
      'a unicode/space-containing quick task directory name must archive correctly',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2142 escalation: `quick.archive` — narrow archival entry point
//
// `milestone.complete --archive-quick` cannot be reused by cleanup.md: it
// hard-errors via `missingExplicitVersion` for an already-completed milestone
// (no `### Phase N:` headings left in its ROADMAP window), re-archives
// ROADMAP.md over the very snapshot cleanup depends on, and would append a
// duplicate MILESTONES.md entry on every re-run. `quick.archive` is the
// narrow replacement — see `cmdQuickArchive` in src/milestone.cts.
// ─────────────────────────────────────────────────────────────────────────────

describe('#2142 escalation: quick.archive — narrow archival entry point', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('quickArchiveMovesDirectoriesWithoutTouchingRoadmap', () => {
    // Already-completed-milestone shape: v1.0 was archived by a PRIOR
    // milestone.complete run (its ROADMAP snapshot lives at
    // milestones/v1.0-ROADMAP.md), and the LIVE ROADMAP.md has moved on to
    // v1.1 — it carries no `### Phase N:` heading for v1.0 at all. This is
    // exactly the shape that makes `milestone.complete v1.0 --archive-quick`
    // fail with `missingExplicitVersion`.
    const liveRoadmap = '# Roadmap\n\n## v1.1: Next\n\n### Phase 1: New Work\n**Goal:** Ship more.\n';
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), liveRoadmap);
    const archivedRoadmap = '# Roadmap\n\n## v1.0: First\n\n### Phase 1: Foundation\n**Goal:** Setup.\n';
    fs.mkdirSync(path.join(tmpDir, '.planning', 'milestones'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-ROADMAP.md'), archivedRoadmap);

    // Confirm the premise this command exists to fix.
    const milestoneCompleteResult = runSdkQuery(['milestone.complete', 'v1.0', '--archive-quick'], tmpDir);
    assert.strictEqual(
      milestoneCompleteResult.success,
      false,
      'milestone.complete v1.0 --archive-quick must still fail against an already-archived milestone',
    );

    writeQuickTaskDir(tmpDir, '2026-09-01-fix-typo');

    const result = runSdkQuery(['quick.archive', 'v1.0'], tmpDir);
    assert.ok(result.success, `quick.archive should succeed where milestone.complete fails: ${result.error}`);
    assert.strictEqual(result.data.archived, 1);
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick', '2026-09-01-fix-typo')),
      'quick task dir must be moved into the v1.0-quick archive',
    );

    const liveRoadmapAfter = fs.readFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), 'utf-8');
    assert.strictEqual(liveRoadmapAfter, liveRoadmap, '.planning/ROADMAP.md must be byte-identical after quick.archive');
    const archivedRoadmapAfter = fs.readFileSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-ROADMAP.md'), 'utf-8');
    assert.strictEqual(
      archivedRoadmapAfter,
      archivedRoadmap,
      'the archived v1.0-ROADMAP.md snapshot must be byte-identical after quick.archive',
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'MILESTONES.md')),
      'quick.archive must never write a MILESTONES.md entry',
    );
  });

  test('quickArchiveRejectsVersionWithPathSeparator', () => {
    writeQuickTaskDir(tmpDir, '2026-09-02-evil-version');

    const result = runSdkQuery(['quick.archive', '../evil'], tmpDir);
    assert.strictEqual(result.success, false, 'a version containing a path separator must be rejected');
    assert.ok(!fs.existsSync(path.join(tmpDir, '..', 'evil')), 'nothing must be created outside the temp fixture root');
    const milestonesDir = path.join(tmpDir, '.planning', 'milestones');
    if (fs.existsSync(milestonesDir)) {
      for (const entry of fs.readdirSync(milestonesDir)) {
        assert.ok(!entry.includes('..'), `no traversal-shaped entry may exist under milestones/: ${entry}`);
      }
    }
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'quick', '2026-09-02-evil-version')),
      'quick task dir must remain untouched on refusal',
    );
  });

  test('quickArchiveDryRunMutatesNothing', () => {
    const names = ['2026-09-03-preview-a', '2026-09-03-preview-b'];
    for (const name of names) writeQuickTaskDir(tmpDir, name);

    const result = runSdkQuery(['quick.archive', 'v1.0', '--dry-run'], tmpDir);
    assert.ok(result.success, `quick.archive --dry-run failed: ${result.error}`);
    assert.ok(Array.isArray(result.data.would_archive), 'would_archive must be an array');
    for (const name of names) {
      assert.ok(result.data.would_archive.includes(name), `would_archive must name ${name}`);
      assert.ok(
        fs.existsSync(path.join(tmpDir, '.planning', 'quick', name)),
        `${name} must remain on disk after a dry run`,
      );
    }
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick')),
      'dry run must not create the archive dir',
    );
  });

  test('quickArchiveIsNoOpWhenQuickDirAbsent', () => {
    const result = runSdkQuery(['quick.archive', 'v1.0'], tmpDir);
    assert.ok(result.success, `quick.archive should succeed with no .planning/quick: ${result.error}`);
    assert.strictEqual(result.data.archived, 0);
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-quick')),
      'no archive dir should be created when .planning/quick is absent',
    );
  });
});
