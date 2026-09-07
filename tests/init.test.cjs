/**
 * GSD Tools Tests - Init
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');
const { runGsdTools, cleanup, absPlanningPath, TOOLS_PATH, parseFrontmatter, captureFdSync } = require('./helpers.cjs');
const { createFixture, seedPhase } = require('./fixtures/index.cjs');
const { createTempProject, createTempDir } = require('./helpers.cjs');
const { executionContextRefs } = require('../scripts/command-contract-helpers.cjs');
const { escapeRegex } = require('../gsd-core/bin/lib/pattern.cjs');

/**
 * #3188: write the canonical flat planning docs so an init-query "present" test
 * actually has the file it asserts. The emitter now returns null for
 * state_path / roadmap_path / requirements_path when the file is absent; tests
 * that exercise the present-case must therefore create the file. Phase
 * resolution is directory-based (findPhaseInternal) and unaffected by these.
 */
function writePlanningDocs(tmpDir, { state = true, roadmap = true, requirements = true } = {}) {
  const planning = path.join(tmpDir, '.planning');
  fs.mkdirSync(planning, { recursive: true });
  if (state) fs.writeFileSync(path.join(planning, 'STATE.md'), '# State\n');
  if (roadmap) fs.writeFileSync(path.join(planning, 'ROADMAP.md'), '# Roadmap\n');
  if (requirements) fs.writeFileSync(path.join(planning, 'REQUIREMENTS.md'), '# Requirements\n');
}

describe('init commands', () => {
  let tmpDir;

  beforeEach(() => {
    // #2376 macOS fix: realpath the fixture root so absolute path-field
    // assertions (absPlanningPath comparisons below) match the code's
    // process.cwd()-anchored output — macOS's tmpdir is a symlink
    // (/var/... -> /private/var/...) that a spawned child resolves via
    // realpath but `createFixture()` does not. No-op on Linux (no symlink).
    tmpDir = fs.realpathSync(createFixture());
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('init execute-phase returns file paths', () => {
    seedPhase(tmpDir, '03-api', {
      '03-01-PLAN.md': '# Plan',
    });
    // #3188: these are present-case assertions — the docs must exist on disk
    // or the emitter now (correctly) returns null for the *_path fields.
    writePlanningDocs(tmpDir);

    const result = runGsdTools('init execute-phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.state_path, absPlanningPath(tmpDir, 'STATE.md'));
    assert.strictEqual(output.roadmap_path, absPlanningPath(tmpDir, 'ROADMAP.md'));
    assert.strictEqual(output.config_path, absPlanningPath(tmpDir, 'config.json'));
    // #2376: execute-phase.md's verify_phase_goal step reads this instead of
    // hardcoding '.planning/REQUIREMENTS.md' into the gsd-verifier spawn prompt.
    assert.strictEqual(output.requirements_path, absPlanningPath(tmpDir, 'REQUIREMENTS.md'));
  });

  test('init execute-phase respects model_overrides for executor_model', () => {
    seedPhase(tmpDir, '01-foundation', {
      '01-01-PLAN.md': '# Plan',
    });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({
      model_profile: 'balanced',
      model_overrides: { 'gsd-executor': 'openai/o4-mini' },
    }));

    const result = runGsdTools('init execute-phase 1 --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.executor_model, 'openai/o4-mini',
      'model_overrides["gsd-executor"] must take precedence over profile');
  });

  test('init execute-phase respects model_overrides when resolve_model_ids is omit', () => {
    seedPhase(tmpDir, '01-foundation', {
      '01-01-PLAN.md': '# Plan',
    });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({
      resolve_model_ids: 'omit',
      model_overrides: { 'gsd-executor': 'openai/o4-mini' },
    }));

    const result = runGsdTools('init execute-phase 1 --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.executor_model, 'openai/o4-mini',
      'model_overrides must take precedence even when resolve_model_ids is omit');
  });

  test('init plan-phase returns file paths', () => {
    seedPhase(tmpDir, '03-api', {
      '03-CONTEXT.md': '# Phase Context',
      '03-RESEARCH.md': '# Research Findings',
      '03-VERIFICATION.md': '# Verification',
      '03-UAT.md': '# UAT',
    });
    // #3188: present-case assertions — create the planning docs the emitter keys on.
    writePlanningDocs(tmpDir);

    const result = runGsdTools('init plan-phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.state_path, absPlanningPath(tmpDir, 'STATE.md'));
    assert.strictEqual(output.roadmap_path, absPlanningPath(tmpDir, 'ROADMAP.md'));
    assert.strictEqual(output.requirements_path, absPlanningPath(tmpDir, 'REQUIREMENTS.md'));
    assert.strictEqual(output.context_path, absPlanningPath(tmpDir, 'phases', '03-api', '03-CONTEXT.md'));
    assert.strictEqual(output.research_path, absPlanningPath(tmpDir, 'phases', '03-api', '03-RESEARCH.md'));
    assert.strictEqual(output.verification_path, absPlanningPath(tmpDir, 'phases', '03-api', '03-VERIFICATION.md'));
    assert.strictEqual(output.uat_path, absPlanningPath(tmpDir, 'phases', '03-api', '03-UAT.md'));
  });

  test('#3511-class: init manager has_context/has_research ignore another phase\'s misplaced artifact', () => {
    writePlanningDocs(tmpDir);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## Progress',
        '',
        '- [ ] **Phase 1: Setup**',
        '- [ ] **Phase 2: API**',
        '',
        '### Phase 1: Setup',
        '',
        '**Goal:** Build the foundation.',
        '',
        '### Phase 2: API',
        '',
        '**Goal:** Build the API.',
        '',
      ].join('\n'),
    );

    seedPhase(tmpDir, '01-setup', {});
    // Phase 02's directory holds ONLY a stray artifact whose filename token
    // ("01-") belongs to phase 01, not to this directory's own phase (02).
    seedPhase(tmpDir, '02-api', {
      '01-RESEARCH.md': '# Research for phase 01',
      '01-CONTEXT.md': '# Context for phase 01',
    });

    const result = runGsdTools('init manager', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const p2 = output.phases.find((p) => p.number === '2');
    assert.strictEqual(p2.has_research, false,
      'phase 2 must not report has_research from a file that belongs to phase 1');
    assert.strictEqual(p2.has_context, false,
      'phase 2 must not report has_context from a file that belongs to phase 1');
  });

  test('#3511-class: init verify-work ui_phase_active ignores another phase\'s misplaced UI-SPEC file', () => {
    writePlanningDocs(tmpDir);
    // ui_phase_active is `hasActiveUiStep || hasUiSpecFile` (detectUiPhaseActive,
    // src/init.cts) — the `ui` capability's `workflow.ui_phase` config key
    // defaults to `true` (capabilities/ui/capability.json), which alone would
    // make `hasActiveUiStep` (and therefore the whole OR) true regardless of
    // which file the phase directory holds. Disabling it here isolates the
    // signal this test actually exercises: the misplaced-file half of the OR.
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ workflow: { ui_phase: false } }),
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '### Phase 1: Setup',
        '',
        '**Goal:** Build the foundation.',
        '',
        '### Phase 2: API',
        '',
        '**Goal:** Build the API.',
        '',
      ].join('\n'),
    );

    seedPhase(tmpDir, '01-setup', {});
    // Phase 02's directory holds ONLY a stray artifact whose filename token
    // ("01-") belongs to phase 01, not to this directory's own phase (02).
    seedPhase(tmpDir, '02-api', {
      '01-UI-SPEC.md': '# UI Spec for phase 01',
    });

    const result = runGsdTools('init verify-work 2', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.ui_phase_active, false,
      'phase 2 must not report ui_phase_active from a UI-SPEC file that belongs to phase 1');
  });

  // #3473 F2 (companion to #3357): init plan-phase's verification_path
  // projector now resolves via the shared resolveVerificationFile resolver
  // instead of a hand-rolled `.find()` over unsorted readdir() order. The
  // canonical report must win over an ad-hoc -CORRECTION- worksheet
  // deterministically, regardless of directory-listing order.
  test('#3473 F2: init plan-phase resolves the canonical report over a -CORRECTION- worksheet', () => {
    seedPhase(tmpDir, '03-api', {
      '03-CORRECTION-VERIFICATION.md': '# Ad-hoc correction worksheet',
      '03-VERIFICATION.md': '# Verification',
    });
    writePlanningDocs(tmpDir);

    const result = runGsdTools('init plan-phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.verification_path,
      absPlanningPath(tmpDir, 'phases', '03-api', '03-VERIFICATION.md'),
      'the canonical 03-VERIFICATION.md must win over the CORRECTION worksheet',
    );
  });

  // #3518: init plan-phase's uat_path projector must resolve via the shared
  // resolveUatFile resolver (phase-pinned, deterministic) instead of a
  // hand-rolled `.find()` over unsorted readdir() order. A stray cross-phase
  // UAT artifact must never become THIS phase's uat_path, on any filesystem.
  // The stray is listed first in the fixture (creation-order filesystems) AND
  // sorts before the phase's own file (lexicographic-order filesystems), so
  // the pre-fix readdir pick loses on both ordering families.
  test('#3518: init plan-phase uat_path is phase-pinned — a stray cross-phase -UAT.md must not win', () => {
    seedPhase(tmpDir, '03-api', {
      '02-UAT.md': '# Stray cross-phase UAT artifact (belongs to phase 02)',
      '03-UAT.md': '# UAT',
    });
    writePlanningDocs(tmpDir);

    const result = runGsdTools('init plan-phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.uat_path,
      absPlanningPath(tmpDir, 'phases', '03-api', '03-UAT.md'),
      'the phase\'s own 03-UAT.md must win over the stray cross-phase 02-UAT.md',
    );
  });

  // #2056: normalizePhaseName() strips ANY [A-Z][A-Z0-9_]*- prefix as a project
  // code, so a foreign-prefixed workstream/task id like "MEM-01" collapsed to
  // "01" and resolved to the unrelated numeric Phase 01. init plan-phase must
  // require exact prefixed evidence (a phase dir/roadmap entry literally
  // carrying the foreign prefix) before accepting a numeric-fallback match.
  test('#2056 — init plan-phase does not collapse foreign-prefixed task IDs into numeric phases', () => {
    seedPhase(tmpDir, '01-stable-baseline-on-main', {
      '01-CONTEXT.md': '# Phase Context',
    });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: Stable Baseline On Main\n**Goal:** Establish baseline\n**Plans:** 1 plan\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ project_code: 'LKML' }, null, 2),
    );

    const result = runGsdTools('init plan-phase MEM-01', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, false, 'MEM-01 must NOT resolve to numeric Phase 01');
    assert.strictEqual(output.phase_dir, null);
    assert.strictEqual(output.phase_number, null);
  });

  // #2056 companion: the guard must not reject the configured project_code's
  // OWN prefixed phases — LKML-01 (project_code = LKML) must still resolve.
  test('#2056 — init plan-phase still resolves configured project-code-prefixed phases', () => {
    seedPhase(tmpDir, 'LKML-01-stable-baseline-on-main', {
      'LKML-01-CONTEXT.md': '# Phase Context',
    });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ project_code: 'LKML' }, null, 2),
    );

    const result = runGsdTools('init plan-phase LKML-01', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true, 'LKML-01 (own project code) must resolve');
    assert.strictEqual(output.phase_dir, absPlanningPath(tmpDir, 'phases', 'LKML-01-stable-baseline-on-main'));
    assert.strictEqual(output.phase_number, 'LKML-01');
  });

  // #2056 accept-branch: a foreign-prefixed query MUST still resolve when a phase
  // directory literally carries that prefix (e.g. a real MEM-01-* workstream
  // phase). Proves the guard accepts exact-prefixed evidence, not just rejects.
  test('#2056 — init plan-phase resolves a real foreign-prefixed phase dir', () => {
    seedPhase(tmpDir, 'MEM-01-integration', {
      'MEM-01-CONTEXT.md': '# Phase Context',
    });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ project_code: 'LKML' }, null, 2),
    );

    const result = runGsdTools('init plan-phase MEM-01', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true, 'a real MEM-01-* dir must resolve under its own prefix');
    assert.strictEqual(output.phase_dir, absPlanningPath(tmpDir, 'phases', 'MEM-01-integration'));
    assert.strictEqual(output.phase_number, 'MEM-01');
  });

  // #2056 edge: with NO project_code configured, any prefixed query is foreign
  // and must NOT collapse to a numeric phase. Pins the strict default.
  test('#2056 — init plan-phase treats prefixed queries as foreign when no project_code is configured', () => {
    seedPhase(tmpDir, '01-stable-baseline-on-main', {
      '01-CONTEXT.md': '# Phase Context',
    });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({}, null, 2),
    );

    const result = runGsdTools('init plan-phase MEM-01', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, false, 'with no project_code, MEM-01 must not resolve to numeric Phase 01');
    assert.strictEqual(output.phase_number, null);
  });

  // #2104: the #2056 guard must also cover init execute-phase, verify-work,
  // and phase-op — all three had unguarded findPhaseInternal/getRoadmapPhaseInternal
  // calls that collapsed foreign prefixes (MEM-01 → 01) to numeric phases.
  test('#2104 — init execute-phase does not collapse foreign-prefixed task IDs', () => {
    seedPhase(tmpDir, '01-stable-baseline-on-main', {
      '01-CONTEXT.md': '# Phase Context',
    });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: Stable Baseline On Main\n**Goal:** Establish baseline\n**Plans:** 1 plan\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ project_code: 'LKML' }, null, 2),
    );

    const result = runGsdTools('init execute-phase MEM-01', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, false, 'MEM-01 must NOT resolve to numeric Phase 01');
    assert.strictEqual(output.phase_number, null);
  });

  test('#2104 — init verify-work does not collapse foreign-prefixed task IDs', () => {
    seedPhase(tmpDir, '01-stable-baseline-on-main', {
      '01-CONTEXT.md': '# Phase Context',
    });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: Stable Baseline On Main\n**Goal:** Establish baseline\n**Plans:** 1 plan\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ project_code: 'LKML' }, null, 2),
    );

    const result = runGsdTools('init verify-work MEM-01', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, false, 'MEM-01 must NOT resolve to numeric Phase 01');
  });

  // #2104 accept-branch: a real foreign-prefixed phase dir MUST still resolve
  // through the now-guarded commands, proving the guard narrows but does not block.
  test('#2104 — init execute-phase resolves a real foreign-prefixed phase dir', () => {
    seedPhase(tmpDir, 'MEM-01-integration', {
      'MEM-01-CONTEXT.md': '# Phase Context',
    });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ project_code: 'LKML' }, null, 2),
    );

    const result = runGsdTools('init execute-phase MEM-01', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true, 'a real MEM-01-* dir must resolve under its own prefix');
    assert.strictEqual(output.phase_dir, absPlanningPath(tmpDir, 'phases', 'MEM-01-integration'));
  });

  test('#2104 — init verify-work resolves a real foreign-prefixed phase dir', () => {
    seedPhase(tmpDir, 'MEM-01-integration', {
      'MEM-01-CONTEXT.md': '# Phase Context',
    });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ project_code: 'LKML' }, null, 2),
    );

    const result = runGsdTools('init verify-work MEM-01', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true, 'a real MEM-01-* dir must resolve under its own prefix');
  });

  test('#2104 — init phase-op does not collapse foreign-prefixed task IDs', () => {
    seedPhase(tmpDir, '01-stable-baseline-on-main', {
      '01-CONTEXT.md': '# Phase Context',
    });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: Stable Baseline On Main\n**Goal:** Establish baseline\n**Plans:** 1 plan\n',
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ project_code: 'LKML' }, null, 2),
    );

    const result = runGsdTools('init phase-op MEM-01', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, false, 'MEM-01 must NOT resolve to numeric Phase 01');
    assert.strictEqual(output.phase_number, null);
  });

  test('init plan-phase exposes text_mode from config (defaults false)', () => {
    const result = runGsdTools('init plan-phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.text_mode, false, 'text_mode should default to false');
  });

  test('init plan-phase exposes text_mode true when set in config', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const existing = fs.existsSync(configPath)
      ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
      : {};
    const config = { ...existing, workflow: { ...(existing.workflow || {}), text_mode: true } };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    const result = runGsdTools('init plan-phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.text_mode, true, 'text_mode should reflect config value');
  });

  test('init progress returns file paths', () => {
    const result = runGsdTools('init progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.state_path, absPlanningPath(tmpDir, 'STATE.md'));
    assert.strictEqual(output.roadmap_path, absPlanningPath(tmpDir, 'ROADMAP.md'));
    assert.strictEqual(output.project_path, absPlanningPath(tmpDir, 'PROJECT.md'));
    assert.strictEqual(output.config_path, absPlanningPath(tmpDir, 'config.json'));
  });

  test('init phase-op returns core and optional phase file paths', () => {
    seedPhase(tmpDir, '03-api', {
      '03-CONTEXT.md': '# Phase Context',
      '03-RESEARCH.md': '# Research',
      '03-VERIFICATION.md': '# Verification',
      '03-UAT.md': '# UAT',
    });
    // #3188: present-case assertions — create the planning docs the emitter keys on.
    writePlanningDocs(tmpDir);

    const result = runGsdTools('init phase-op 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.state_path, absPlanningPath(tmpDir, 'STATE.md'));
    assert.strictEqual(output.roadmap_path, absPlanningPath(tmpDir, 'ROADMAP.md'));
    assert.strictEqual(output.requirements_path, absPlanningPath(tmpDir, 'REQUIREMENTS.md'));
    assert.strictEqual(output.context_path, absPlanningPath(tmpDir, 'phases', '03-api', '03-CONTEXT.md'));
    assert.strictEqual(output.research_path, absPlanningPath(tmpDir, 'phases', '03-api', '03-RESEARCH.md'));
    assert.strictEqual(output.verification_path, absPlanningPath(tmpDir, 'phases', '03-api', '03-VERIFICATION.md'));
    assert.strictEqual(output.uat_path, absPlanningPath(tmpDir, 'phases', '03-api', '03-UAT.md'));
  });

  // #3473 F2 (companion to #3357): init phase-op's verification_path projector
  // — the second of the two now-fixed init.cts sites — same regression as
  // the plan-phase test above.
  test('#3473 F2: init phase-op resolves the canonical report over a -CORRECTION- worksheet', () => {
    seedPhase(tmpDir, '03-api', {
      '03-CORRECTION-VERIFICATION.md': '# Ad-hoc correction worksheet',
      '03-VERIFICATION.md': '# Verification',
    });
    writePlanningDocs(tmpDir);

    const result = runGsdTools('init phase-op 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.verification_path,
      absPlanningPath(tmpDir, 'phases', '03-api', '03-VERIFICATION.md'),
      'the canonical 03-VERIFICATION.md must win over the CORRECTION worksheet',
    );
  });

  // #3518: init phase-op's uat_path projector — the second of the two
  // single-pick UAT sites in src/init.cts — same phase-pinned contract as
  // the plan-phase test above. Stray created first AND sorting first, so the
  // pre-fix readdir-order pick deterministically chose it on both ordering
  // families.
  test('#3518: init phase-op uat_path is phase-pinned — a stray cross-phase -UAT.md must not win', () => {
    seedPhase(tmpDir, '03-api', {
      '02-UAT.md': '# Stray cross-phase UAT artifact (belongs to phase 02)',
      '03-UAT.md': '# UAT',
    });
    writePlanningDocs(tmpDir);

    const result = runGsdTools('init phase-op 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(
      output.uat_path,
      absPlanningPath(tmpDir, 'phases', '03-api', '03-UAT.md'),
      'the phase\'s own 03-UAT.md must win over the stray cross-phase 02-UAT.md',
    );
  });

  test('init plan-phase detects has_reviews and reviews_path when REVIEWS.md exists', () => {
    seedPhase(tmpDir, '03-api', {
      '03-REVIEWS.md': '# Cross-AI Reviews',
    });

    const result = runGsdTools('init plan-phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_reviews, true);
    assert.strictEqual(output.reviews_path, absPlanningPath(tmpDir, 'phases', '03-api', '03-REVIEWS.md'));
  });

  test('init plan-phase omits optional paths if files missing', () => {
    seedPhase(tmpDir, '03-api');

    const result = runGsdTools('init plan-phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.context_path, undefined);
    assert.strictEqual(output.research_path, undefined);
    assert.strictEqual(output.reviews_path, undefined);
    assert.strictEqual(output.has_reviews, false);
  });

  // ── phase_req_ids extraction (fix for #684) ──────────────────────────────

  test('init plan-phase extracts phase_req_ids from ROADMAP', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-api'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 3: API\n**Goal:** Build API\n**Requirements**: CP-01, CP-02, CP-03\n**Plans:** 0 plans\n`
    );

    const result = runGsdTools('init plan-phase 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_req_ids, 'CP-01, CP-02, CP-03');
  });

  test('init plan-phase strips brackets from phase_req_ids', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-api'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 3: API\n**Goal:** Build API\n**Requirements**: [CP-01, CP-02]\n**Plans:** 0 plans\n`
    );

    const result = runGsdTools('init plan-phase 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_req_ids, 'CP-01, CP-02');
  });

  test('init plan-phase returns null phase_req_ids when Requirements line is absent', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-api'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 3: API\n**Goal:** Build API\n**Plans:** 0 plans\n`
    );

    const result = runGsdTools('init plan-phase 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_req_ids, null);
  });

  test('init plan-phase returns null phase_req_ids when ROADMAP is absent', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-api'), { recursive: true });

    const result = runGsdTools('init plan-phase 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_req_ids, null);
  });

  test('init execute-phase extracts phase_req_ids from ROADMAP', () => {
    seedPhase(tmpDir, '03-api', {
      '03-01-PLAN.md': '# Plan',
    });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 3: API\n**Goal:** Build API\n**Requirements**: EX-01, EX-02\n**Plans:** 1 plans\n`
    );

    const result = runGsdTools('init execute-phase 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_req_ids, 'EX-01, EX-02');
  });

  test('init plan-phase returns null phase_req_ids when value is TBD', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-api'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 3: API\n**Goal:** Build API\n**Requirements**: TBD\n**Plans:** 0 plans\n`
    );

    const result = runGsdTools('init plan-phase 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_req_ids, null, 'TBD placeholder should return null');
  });

  // ── #2769: Requirements header bold/colon variants ───────────────────────
  // The visible label "**Requirements:**" (colon INSIDE bold) and
  // "**Requirements**:" (colon OUTSIDE bold) render identically. The parser
  // must accept both, plus the spaced "**Requirements** :" variant and the
  // plain "## Requirements" header form (used in REQUIREMENTS.md), so phase
  // metadata is robust to authoring style.
  const headerVariants = [
    { name: 'colon inside bold (**Requirements:**)', header: '**Requirements:** RV-01, RV-02' },
    { name: 'colon outside bold (**Requirements**:)', header: '**Requirements**: RV-01, RV-02' },
    { name: 'space before colon (**Requirements** :)', header: '**Requirements** : RV-01, RV-02' },
  ];

  for (const variant of headerVariants) {
    test(`init plan-phase parses Requirements with ${variant.name}`, () => {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '03-api'), { recursive: true });
      const roadmap = [
        '# Roadmap',
        '',
        '### Phase 3: API',
        '**Goal:** Build API',
        variant.header,
        '**Plans:** 0 plans',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);

      const result = runGsdTools('init plan-phase 3', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.phase_req_ids, 'RV-01, RV-02',
        `phase_req_ids must be parsed when header uses "${variant.header}"`);
    });

    test(`init execute-phase parses Requirements with ${variant.name}`, () => {
      seedPhase(tmpDir, '03-api', {
        '03-01-PLAN.md': '# Plan',
      });
      const roadmap = [
        '# Roadmap',
        '',
        '### Phase 3: API',
        '**Goal:** Build API',
        variant.header,
        '**Plans:** 1 plans',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), roadmap);

      const result = runGsdTools('init execute-phase 3', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.phase_req_ids, 'RV-01, RV-02',
        `phase_req_ids must be parsed when header uses "${variant.header}"`);
    });
  }

  test('init execute-phase returns null phase_req_ids when Requirements line is absent', () => {
    seedPhase(tmpDir, '03-api', {
      '03-01-PLAN.md': '# Plan',
    });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap\n\n### Phase 3: API\n**Goal:** Build API\n**Plans:** 1 plans\n`
    );

    const result = runGsdTools('init execute-phase 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_req_ids, null);
  });

  test('init plan-phase resolves phase_req_ids from flat Phase Details after active milestone heading', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '11-second-active-phase'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), [
      '---',
      'milestone: v0.4.0',
      'current_phase: 11',
      '---',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), [
      '# Roadmap: Example',
      '',
      '## Milestones',
      '',
      '- ✅ **v0.3.0 Foundations** - Phases 1-9 (shipped 2026-01-01)',
      '- 🚧 **v0.4.0 Feature Work** - Phases 10-11 (in progress)',
      '',
      '## Phases',
      '',
      '<details>',
      '<summary>✅ v0.3.0 Foundations (Phases 1-9) - SHIPPED 2026-01-01</summary>',
      '',
      '- [x] **Phase 1: Bootstrap**',
      '',
      '</details>',
      '',
      '### 🚧 v0.4.0 Feature Work (Active)',
      '',
      '**Milestone Goal:** Deliver the feature set.',
      '',
      '- [ ] **Phase 10: First Active Phase**',
      '- [ ] **Phase 11: Second Active Phase**',
      '',
      '### 📋 v0.5+ (Planned)',
      '',
      '## Phase Details',
      '',
      '### Phase 10: First Active Phase',
      '**Goal**: Build the first piece.',
      '**Requirements**: REQ-01',
      '',
      '### Phase 11: Second Active Phase',
      '**Goal**: Build the second piece.',
      '**Requirements**: REQ-02, REQ-03',
      '',
      '## Progress',
      '',
    ].join('\n'));

    const result = runGsdTools('init plan-phase 11', tmpDir);
    assert.ok(result.success, `init plan-phase failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true);
    assert.strictEqual(output.phase_req_ids, 'REQ-02, REQ-03');
  });

  test('init execute-phase resolves phase_req_ids from flat Phase Details after active milestone heading', () => {
    seedPhase(tmpDir, '11-second-active-phase', {
      '11-01-PLAN.md': '# Plan',
    });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), [
      '---',
      'milestone: v0.4.0',
      'current_phase: 11',
      '---',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), [
      '# Roadmap: Example',
      '',
      '## Phases',
      '',
      '### 🚧 v0.4.0 Feature Work (Active)',
      '',
      '- [ ] **Phase 10: First Active Phase**',
      '- [ ] **Phase 11: Second Active Phase**',
      '',
      '### 📋 v0.5+ (Planned)',
      '',
      '## Phase Details',
      '',
      '### Phase 10: First Active Phase',
      '**Goal**: Build the first piece.',
      '**Requirements**: REQ-01',
      '',
      '### Phase 11: Second Active Phase',
      '**Goal**: Build the second piece.',
      '**Requirements**: REQ-02, REQ-03',
      '',
    ].join('\n'));

    const result = runGsdTools('init execute-phase 11', tmpDir);
    assert.ok(result.success, `init execute-phase failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true);
    assert.strictEqual(output.phase_req_ids, 'REQ-02, REQ-03');
  });

  test('init plan-phase prefers real phase details outside fenced examples and ignores backlog sentinels (#1588)', () => {
    const projectDir = createTempProject('init-1588-');
    try {
      fs.writeFileSync(
        path.join(projectDir, '.planning', 'STATE.md'),
        [
          '---',
          'gsd_state_version: 1.0',
          'milestone: v1.1',
          'status: planning',
          '---',
          '',
        ].join('\n')
      );
      fs.writeFileSync(
        path.join(projectDir, '.planning', 'ROADMAP.md'),
        [
          '# Roadmap',
          '',
          '<details open>',
          '<summary>v1.1 Current (Phases 8-9) - PLANNED</summary>',
          '',
          '- [ ] **Phase 9: Real Phase**',
          '',
          '</details>',
          '',
          '## Phase Details',
          '',
          '```markdown',
          '### Phase 9: Fenced Example Phase',
          '**Goal:** This example must not be treated as roadmap structure.',
          '```',
          '',
          '### Phase 9: Real Phase',
          '**Goal:** Use the real phase details outside the fenced block.',
          '**Requirements:** REAL-01',
          '',
          '## Backlog',
          '',
          '### Phase 999.1: Backlog Thing',
          '**Goal:** Future backlog item.',
          '',
        ].join('\n')
      );

      const phase9 = runGsdTools('init plan-phase 9', projectDir);
      assert.ok(phase9.success, `init plan-phase 9 failed: ${phase9.error}`);
      const phase9Output = JSON.parse(phase9.output);
      assert.equal(phase9Output.phase_name, 'Real Phase');
      assert.equal(phase9Output.phase_req_ids, 'REAL-01');

      const backlog = runGsdTools('init plan-phase 999.1', projectDir);
      assert.ok(backlog.success, `init plan-phase 999.1 failed: ${backlog.error}`);
      const backlogOutput = JSON.parse(backlog.output);
      assert.equal(backlogOutput.phase_found, false);
    } finally {
      cleanup(projectDir);
    }
  });

  test('init phase-op resolves a details-summary milestone phase from later flat Phase Details', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), [
      'milestone: v1.11',
      'current_phase: 86',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), [
      '# Roadmap',
      '',
      '## Phases',
      '<details open>',
      '<summary>🔄 v1.11 A06 (Phases 86-91) — IN PROGRESS</summary>',
      '',
      '- [ ] **Phase 86: Details Block Regression** — Parser should resolve this (DATA-01)',
      '- [ ] **Phase 87: Other Work** — Later phase',
      '</details>',
      '',
      '## Phase Details',
      '',
      '### Phase 86: Details Block Regression',
      '**Goal**: Resolve phase details after collapsed milestone block',
      '**Requirements**: DATA-01',
      '',
      '### Phase 87: Other Work',
      '**Goal**: Not relevant',
      '',
    ].join('\n'));

    const result = runGsdTools('init phase-op 86', tmpDir);
    assert.ok(result.success, `init phase-op failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true);
    assert.strictEqual(output.phase_name, 'Details Block Regression');

  });
  // ─── #3865: --phase alias for the positional phase token ──────────────────

  test('#3865: init execute-phase accepts --phase <N> as the positional alias', () => {
    seedPhase(tmpDir, '03-api', { '03-01-PLAN.md': '# Plan' });
    writePlanningDocs(tmpDir);
    const result = runGsdTools(['init', 'execute-phase', '--phase', '03'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true, '--phase 03 must resolve the phase, not answer phase_found:false');
    assert.strictEqual(output.plan_count, 1, 'the on-disk plan must be counted — the reported incident had 7 plans read as 0');
  });

  test('#3865: init execute-phase accepts the --phase=N form', () => {
    seedPhase(tmpDir, '03-api', { '03-01-PLAN.md': '# Plan' });
    writePlanningDocs(tmpDir);
    const result = runGsdTools(['init', 'execute-phase', '--phase=03'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).phase_found, true);
  });

  test('#3865: the positional form still works (control)', () => {
    seedPhase(tmpDir, '03-api', { '03-01-PLAN.md': '# Plan' });
    writePlanningDocs(tmpDir);
    const result = runGsdTools(['init', 'execute-phase', '03'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).phase_found, true);
  });

  test('#3865: init plan-phase accepts --phase <N>', () => {
    seedPhase(tmpDir, '03-api', { '03-01-PLAN.md': '# Plan' });
    writePlanningDocs(tmpDir);
    const result = runGsdTools(['init', 'plan-phase', '--phase', '03'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).phase_found, true);
  });

  test('#3865: init verify-work accepts --phase <N>', () => {
    seedPhase(tmpDir, '03-api', { '03-01-PLAN.md': '# Plan' });
    writePlanningDocs(tmpDir);
    const result = runGsdTools(['init', 'verify-work', '--phase', '03'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).phase_found, true);
  });

  test('#3865: init code-review accepts --phase <N>', () => {
    seedPhase(tmpDir, '03-api', { '03-01-PLAN.md': '# Plan' });
    writePlanningDocs(tmpDir);
    const result = runGsdTools(['init', 'code-review', '--phase', '03'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    assert.strictEqual(JSON.parse(result.output).phase_found, true);
  });

  test('#3865: --phase with no value is a usage error, never a silent phase_found:false', () => {
    seedPhase(tmpDir, '03-api', { '03-01-PLAN.md': '# Plan' });
    writePlanningDocs(tmpDir);
    const result = runGsdTools(['init', 'execute-phase', '--phase'], tmpDir);
    assert.strictEqual(result.success, false, 'a valueless --phase must exit non-zero with a diagnostic');
    assert.ok(
      (result.error || '').includes('--phase'),
      `the diagnostic must name the flag; got: ${result.error}`
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3188: init execute-phase / plan-phase / phase-op must return null for
// state_path / roadmap_path / requirements_path when the planning doc is
// absent — matching the contract the conditional sibling fields (patterns_path,
// context_path, …) already honour, and that ultraplan-phase.md:104 gates on.
// The WRITING emitters (new-project / new-milestone / ingest-docs) are
// intentionally NOT changed and keep returning a non-null write-target path.
// ─────────────────────────────────────────────────────────────────────────────

describe('#3188 — init query path fields are null when the planning file is absent', () => {
  let tmpDir;

  beforeEach(() => {
    // #2376 macOS fix: realpath so absPlanningPath matches process.cwd()-anchored output.
    tmpDir = fs.realpathSync(createFixture());
    seedPhase(tmpDir, '03-api', { '03-01-PLAN.md': '# Plan' });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // All three READING (projection) sites share the identical field group; the
  // absent/present boundary must hold uniformly across them.
  const COMMANDS = [
    ['init execute-phase', 'init execute-phase 03'],
    ['init plan-phase', 'init plan-phase 03'],
    ['init phase-op', 'init phase-op 03'],
  ];

  for (const [label, argv] of COMMANDS) {
    test(`${label}: state_path / roadmap_path / requirements_path are null when the docs are absent`, () => {
      // No STATE.md / ROADMAP.md / REQUIREMENTS.md written.
      const result = runGsdTools(argv, tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.state_path, null,
        'state_path must be null when STATE.md is absent');
      assert.strictEqual(output.roadmap_path, null,
        'roadmap_path must be null when ROADMAP.md is absent');
      assert.strictEqual(output.requirements_path, null,
        'requirements_path must be null when REQUIREMENTS.md is absent');
    });

    test(`${label}: state_path / roadmap_path / requirements_path are absolute when the docs exist`, () => {
      writePlanningDocs(tmpDir);

      const result = runGsdTools(argv, tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.state_path, absPlanningPath(tmpDir, 'STATE.md'));
      assert.strictEqual(output.roadmap_path, absPlanningPath(tmpDir, 'ROADMAP.md'));
      assert.strictEqual(output.requirements_path, absPlanningPath(tmpDir, 'REQUIREMENTS.md'));
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ROADMAP fallback for init plan-phase / execute-phase / verify-work (#1238)
// ─────────────────────────────────────────────────────────────────────────────

describe('init commands ROADMAP fallback when phase directory does not exist (#1238)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: Foundation Setup\n**Goal:** Bootstrap project\n**Requirements**: R-01, R-02\n**Plans:** TBD\n'
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('init plan-phase falls back to ROADMAP when no phase directory exists', () => {
    const result = runGsdTools('init plan-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true, 'phase_found should be true from ROADMAP fallback');
    assert.strictEqual(output.phase_dir, null, 'phase_dir should be null (no directory yet)');
    assert.strictEqual(output.phase_number, '1');
    assert.strictEqual(output.phase_name, 'Foundation Setup');
    assert.strictEqual(output.phase_slug, 'foundation-setup');
    assert.strictEqual(output.padded_phase, '01');
  });

  test('init execute-phase falls back to ROADMAP when no phase directory exists', () => {
    const result = runGsdTools('init execute-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true, 'phase_found should be true from ROADMAP fallback');
    assert.strictEqual(output.phase_dir, null, 'phase_dir should be null (no directory yet)');
    assert.strictEqual(output.phase_number, '1');
    assert.strictEqual(output.phase_name, 'Foundation Setup');
    assert.strictEqual(output.phase_slug, 'foundation-setup');
    assert.strictEqual(output.phase_req_ids, 'R-01, R-02');
  });

  test('init verify-work falls back to ROADMAP when no phase directory exists', () => {
    const result = runGsdTools('init verify-work 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true, 'phase_found should be true from ROADMAP fallback');
    assert.strictEqual(output.phase_dir, null, 'phase_dir should be null (no directory yet)');
    assert.strictEqual(output.phase_number, '1');
    assert.strictEqual(output.phase_name, 'Foundation Setup');
  });

  test('init plan-phase returns phase_found false when neither directory nor ROADMAP entry exists', () => {
    const result = runGsdTools('init plan-phase 99', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, false);
    assert.strictEqual(output.phase_dir, null);
    assert.strictEqual(output.phase_number, null);
    assert.strictEqual(output.phase_name, null);
  });

  test('init plan-phase prefers disk directory over ROADMAP fallback', () => {
    seedPhase(tmpDir, '01-foundation-setup', {
      '01-01-PLAN.md': '# Plan',
    });

    const result = runGsdTools('init plan-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true);
    assert.ok(output.phase_dir !== null, 'phase_dir should point to disk directory');
    assert.ok(output.phase_dir.includes('01-foundation-setup'));
    assert.strictEqual(output.plan_count, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// init ignores archived phases from prior milestones that share a phase number
// ─────────────────────────────────────────────────────────────────────────────

describe('init commands ignore archived phases from prior milestones sharing a number', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
    // Current milestone ROADMAP has Phase 2 but no disk directory yet
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# v2.0 Roadmap\n\n### Phase 2: New Feature\n**Goal:** New v2.0 feature\n**Requirements**: NEW-01, NEW-02\n**Plans:** TBD\n'
    );
    // Prior milestone archive has a shipped Phase 2 with different slug and artifacts
    const archivedDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '02-old-feature');
    fs.mkdirSync(archivedDir, { recursive: true });
    fs.writeFileSync(path.join(archivedDir, '2-CONTEXT.md'), '# OLD v1.0 Phase 2 context');
    fs.writeFileSync(path.join(archivedDir, '2-RESEARCH.md'), '# OLD v1.0 Phase 2 research');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('init plan-phase prefers current ROADMAP entry over archived v1.0 phase of same number', () => {
    const result = runGsdTools('init plan-phase 2', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true);
    assert.strictEqual(output.phase_name, 'New Feature',
      'phase_name must come from current ROADMAP.md, not archived v1.0');
    assert.strictEqual(output.phase_slug, 'new-feature');
    assert.strictEqual(output.phase_dir, null,
      'phase_dir must be null — current milestone has no directory yet');
    assert.strictEqual(output.has_context, false,
      'has_context must not inherit archived v1.0 artifacts');
    assert.strictEqual(output.has_research, false,
      'has_research must not inherit archived v1.0 artifacts');
    assert.ok(!output.context_path,
      'context_path must not point at archived v1.0 file');
    assert.ok(!output.research_path,
      'research_path must not point at archived v1.0 file');
    assert.strictEqual(output.phase_req_ids, 'NEW-01, NEW-02');
  });

  test('init execute-phase prefers current ROADMAP entry over archived v1.0 phase of same number', () => {
    const result = runGsdTools('init execute-phase 2', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true);
    assert.strictEqual(output.phase_name, 'New Feature');
    assert.strictEqual(output.phase_slug, 'new-feature');
    assert.strictEqual(output.phase_dir, null);
    assert.strictEqual(output.phase_req_ids, 'NEW-01, NEW-02');
  });

  test('init verify-work prefers current ROADMAP entry over archived v1.0 phase of same number', () => {
    const result = runGsdTools('init verify-work 2', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true);
    assert.strictEqual(output.phase_name, 'New Feature');
    assert.strictEqual(output.phase_dir, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug #2391: zero-padded phase numbers must not bypass archived-phase guard
// ─────────────────────────────────────────────────────────────────────────────

describe('init plan-phase zero-padded phase number (bug #2391)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
    // Current milestone ROADMAP has Phase 3 (unpadded heading)
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# v2.0 Roadmap\n\n### Phase 3: Rotation Engine + Availability\n**Goal**: Rotation\n**Requirements**: ROTA-01, ROTA-02\n**Plans:** TBD\n'
    );
    // Prior milestone archive has a shipped Phase 3 with different content
    const archivedDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '03-plant-collection-and-rooms');
    fs.mkdirSync(archivedDir, { recursive: true });
    fs.writeFileSync(path.join(archivedDir, '03-CONTEXT.md'), '# OLD v1.0 Phase 3 context');
    fs.writeFileSync(path.join(archivedDir, '03-RESEARCH.md'), '# OLD v1.0 Phase 3 research');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('zero-padded "03" returns current ROADMAP phase, not archived v1.0 phase', () => {
    const result = runGsdTools('init plan-phase 03', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true);
    assert.strictEqual(output.phase_name, 'Rotation Engine + Availability',
      'phase_name must come from current ROADMAP.md, not the archived v1.0 phase');
    assert.strictEqual(output.phase_dir, null,
      'phase_dir must be null — current milestone has no directory yet');
    assert.strictEqual(output.has_context, false,
      'has_context must not inherit archived v1.0 artifacts');
    assert.strictEqual(output.has_research, false,
      'has_research must not inherit archived v1.0 artifacts');
    assert.ok(!output.context_path || !output.context_path.includes('v1.0'),
      'context_path must not point at archived v1.0 file');
    assert.strictEqual(output.phase_req_ids, 'ROTA-01, ROTA-02');
  });

  test('unpadded "3" and zero-padded "03" return identical phase identity', () => {
    const result3 = runGsdTools('init plan-phase 3', tmpDir);
    const result03 = runGsdTools('init plan-phase 03', tmpDir);
    assert.ok(result3.success && result03.success, 'both commands must succeed');

    const out3 = JSON.parse(result3.output);
    const out03 = JSON.parse(result03.output);
    assert.strictEqual(out03.phase_name, out3.phase_name,
      'phase_name must be identical regardless of padding');
    assert.strictEqual(out03.phase_slug, out3.phase_slug,
      'phase_slug must be identical regardless of padding');
    assert.strictEqual(out03.phase_req_ids, out3.phase_req_ids,
      'phase_req_ids must be identical regardless of padding');
  });

  // ── #904: branch_name must use normalized (stripped + zero-padded) phase number ──
  // When project_code is set (e.g. "CK") the phase directory is prefixed:
  // "CK-01-foundation". extractPhaseToken returns "CK-01" as phase_number.
  // branch_name must call normalizePhaseName so it strips the prefix and zero-pads,
  // producing "gsd/phase-01-foundation" rather than "gsd/phase-CK-01-foundation".
  test('branch_name uses normalized phase number when project_code prefixes phase dir (#904)', () => {
    seedPhase(tmpDir, 'CK-01-foundation', {
      'CK-01-01-PLAN.md': '# Plan',
    });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        project_code: 'CK',
        git: {
          branching_strategy: 'phase',
          phase_branch_template: 'gsd/phase-{phase}-{slug}',
        },
      }, null, 2)
    );

    const result = runGsdTools('init execute-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // branch_name must use the normalized phase number, not the raw "CK-01" token
    assert.strictEqual(output.branch_name, 'gsd/phase-01-foundation',
      'branch_name must use normalized phase number (strip project_code prefix, zero-pad), not raw phase_number');
  });

  // ── #4126: an empty phase_slug must not degrade branch_name to the literal "phase" ──
  // Two independent routes reach an empty slug. Route 2: the name resolves but
  // lies outside transliterateForSlug's Cyrillic scope (CJK → ''). Route 1: the
  // directory has no name segment at all (`07` → phase_name null, phase_slug
  // null). Both used to render `gsd/phase-NN-phase` beside `phase_slug: null`
  // in the same payload; both now drop the {slug} segment instead.
  test('#4126: branch_name drops the {slug} segment for a CJK-named phase whose slug is empty', () => {
    seedPhase(tmpDir, '08-日本語のテスト', { '08-01-PLAN.md': '# Plan' });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        git: {
          branching_strategy: 'phase',
          phase_branch_template: 'gsd/phase-{phase}-{slug}',
        },
      }, null, 2)
    );

    const result = runGsdTools('init execute-phase 8', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_name, '日本語のテスト');
    assert.strictEqual(output.phase_slug, null);
    assert.strictEqual(output.branch_name, 'gsd/phase-08',
      'branch_name must carry no slug when phase_slug is null — never the placeholder "phase"');
  });

  test('#4126: branch_name drops the {slug} segment for a phase directory with no name segment', () => {
    seedPhase(tmpDir, '07', { '07-01-PLAN.md': '# Plan' });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        git: {
          branching_strategy: 'phase',
          phase_branch_template: 'gsd/phase-{phase}-{slug}',
        },
      }, null, 2)
    );

    const result = runGsdTools('init execute-phase 7', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true);
    assert.strictEqual(output.phase_slug, null);
    assert.strictEqual(output.branch_name, 'gsd/phase-07');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdInitTodos (INIT-01)
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdInitTodos', () => {
  let tmpDir;

  beforeEach(() => {
    // #2376 macOS fix: see 'init commands' beforeEach above.
    tmpDir = fs.realpathSync(createFixture());
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('empty pending dir returns zero count', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'todos', 'pending'), { recursive: true });

    const result = runGsdTools('init todos', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.todo_count, 0);
    assert.deepStrictEqual(output.todos, []);
    assert.strictEqual(output.pending_dir_exists, true);
  });

  test('missing pending dir returns zero count', () => {
    const result = runGsdTools('init todos', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.todo_count, 0);
    assert.deepStrictEqual(output.todos, []);
    assert.strictEqual(output.pending_dir_exists, false);
  });

  test('multiple todos with fields are read correctly', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });

    fs.writeFileSync(path.join(pendingDir, 'task-1.md'), 'title: Fix bug\narea: backend\ncreated: 2026-02-25');
    fs.writeFileSync(path.join(pendingDir, 'task-2.md'), 'title: Add feature\narea: frontend\ncreated: 2026-02-24');
    fs.writeFileSync(path.join(pendingDir, 'task-3.md'), 'title: Write docs\narea: backend\ncreated: 2026-02-23');

    const result = runGsdTools('init todos', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.todo_count, 3);
    assert.strictEqual(output.todos.length, 3);

    const task1 = output.todos.find(t => t.file === 'task-1.md');
    assert.ok(task1, 'task-1.md should be in todos');
    assert.strictEqual(task1.title, 'Fix bug');
    assert.strictEqual(task1.area, 'backend');
    assert.strictEqual(task1.created, '2026-02-25');
    assert.strictEqual(task1.path, absPlanningPath(tmpDir, 'todos', 'pending', 'task-1.md'));
  });

  // ── #2337: init todos must surface severity too, in parity with list-todos ──
  test('surfaces severity when present, omits the key when absent (#2337)', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });

    fs.writeFileSync(path.join(pendingDir, 'tagged.md'),
      'title: Crash on save\narea: core\ncreated: 2026-02-25\nseverity: blocker');
    fs.writeFileSync(path.join(pendingDir, 'untagged.md'),
      'title: Old todo\narea: docs\ncreated: 2026-02-24');

    const result = runGsdTools('init todos', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const tagged = output.todos.find(t => t.file === 'tagged.md');
    const untagged = output.todos.find(t => t.file === 'untagged.md');
    assert.ok(tagged && untagged, 'both todos should be present');
    assert.strictEqual(tagged.severity, 'blocker', 'severity surfaced verbatim when present');
    assert.ok(!('severity' in untagged),
      'severity key ABSENT (backward compatible) for a todo with no severity line');
  });

  test('area filter returns only matching todos', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });

    fs.writeFileSync(path.join(pendingDir, 'task-1.md'), 'title: Fix bug\narea: backend\ncreated: 2026-02-25');
    fs.writeFileSync(path.join(pendingDir, 'task-2.md'), 'title: Add feature\narea: frontend\ncreated: 2026-02-24');
    fs.writeFileSync(path.join(pendingDir, 'task-3.md'), 'title: Write docs\narea: backend\ncreated: 2026-02-23');

    const result = runGsdTools('init todos backend', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.todo_count, 2);
    assert.strictEqual(output.area_filter, 'backend');
    for (const todo of output.todos) {
      assert.strictEqual(todo.area, 'backend');
    }
  });

  test('area filter miss returns zero count', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });

    fs.writeFileSync(path.join(pendingDir, 'task-1.md'), 'title: Fix bug\narea: backend\ncreated: 2026-02-25');

    const result = runGsdTools('init todos nonexistent', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.todo_count, 0);
    assert.strictEqual(output.area_filter, 'nonexistent');
  });

  test('malformed file uses defaults', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });

    fs.writeFileSync(path.join(pendingDir, 'broken.md'), 'some random content without fields');

    const result = runGsdTools('init todos', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.todo_count, 1);
    const todo = output.todos[0];
    assert.strictEqual(todo.title, 'Untitled');
    assert.strictEqual(todo.area, 'general');
    assert.strictEqual(todo.created, 'unknown');
  });

  test('non-md files are ignored', () => {
    const pendingDir = path.join(tmpDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });

    fs.writeFileSync(path.join(pendingDir, 'task.md'), 'title: Real task\narea: dev\ncreated: 2026-01-01');
    fs.writeFileSync(path.join(pendingDir, 'notes.txt'), 'title: Not a task\narea: dev\ncreated: 2026-01-01');

    const result = runGsdTools('init todos', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.todo_count, 1);
    assert.strictEqual(output.todos[0].file, 'task.md');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdInitMilestoneOp (INIT-02)
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdInitMilestoneOp', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('no phase directories returns zero counts', () => {
    const result = runGsdTools('init milestone-op', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_count, 0);
    assert.strictEqual(output.completed_phases, 0);
    assert.strictEqual(output.all_phases_complete, false);
  });

  test('multiple phases with no summaries', () => {
    const phase1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    const phase2 = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(phase1, { recursive: true });
    fs.mkdirSync(phase2, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phase2, '02-01-PLAN.md'), '# Plan');

    const result = runGsdTools('init milestone-op', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_count, 2);
    assert.strictEqual(output.completed_phases, 0);
    assert.strictEqual(output.all_phases_complete, false);
  });

  test('mix of complete and incomplete phases', () => {
    const phase1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    const phase2 = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(phase1, { recursive: true });
    fs.mkdirSync(phase2, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phase1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(path.join(phase2, '02-01-PLAN.md'), '# Plan');

    const result = runGsdTools('init milestone-op', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_count, 2);
    assert.strictEqual(output.completed_phases, 1);
    assert.strictEqual(output.all_phases_complete, false);
  });

  test('all phases complete', () => {
    const phase1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phase1, '01-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('init milestone-op', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_count, 1);
    assert.strictEqual(output.completed_phases, 1);
    assert.strictEqual(output.all_phases_complete, true);
  });

  test('project_code-prefixed phase directories count as completed milestone phases (#1836)', () => {
    seedPhase(tmpDir, 'PROJ-01-setup', {
      'PROJ-01-01-PLAN.md': '# Plan',
      'PROJ-01-01-SUMMARY.md': '# Summary',
    });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ project_code: 'PROJ' }, null, 2)
    );

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v1.0.0',
        'milestone_name: Test Milestone',
        'status: executing',
        '---',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## 🚧 v1.0.0 Test Milestone',
        '### Phase 1: Setup',
        '',
      ].join('\n')
    );

    const result = runGsdTools('init milestone-op', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_count, 1);
    assert.strictEqual(output.completed_phases, 1);
    assert.strictEqual(output.all_phases_complete, true);
  });

  test('backlog 999.x headings do not inflate milestone phase counts (#1838)', () => {
    const phase1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phase1, '01-01-SUMMARY.md'), '# Summary');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'milestone: v1.0.0',
        'milestone_name: Test Milestone',
        'status: completed',
        '---',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      [
        '# Roadmap',
        '',
        '## 🚧 v1.0.0 Test Milestone',
        '### Phase 1: Setup',
        '',
        '## Backlog',
        '### Phase 999.1: Deferred Idea',
        '### Phase 999.2: Another Deferred Idea',
        '',
      ].join('\n')
    );

    const result = runGsdTools('init milestone-op', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_count, 1);
    assert.strictEqual(output.completed_phases, 1);
    assert.strictEqual(output.all_phases_complete, true);
  });

  test('archive directory scanning', () => {
    fs.mkdirSync(path.join(tmpDir, '.planning', 'archive', 'v1.0'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'archive', 'v0.9'), { recursive: true });

    const result = runGsdTools('init milestone-op', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.archive_count, 2);
    assert.strictEqual(output.archived_milestones.length, 2);
  });

  test('no archive directory returns empty', () => {
    const result = runGsdTools('init milestone-op', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.archive_count, 0);
    assert.deepStrictEqual(output.archived_milestones, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdInitPhaseOp fallback (INIT-04)
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdInitPhaseOp fallback', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('normal path with existing directory', () => {
    seedPhase(tmpDir, '03-api', {
      '03-CONTEXT.md': '# Context',
      '03-01-PLAN.md': '# Plan',
    });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 3: API\n**Goal:** Build API\n**Plans:** 1 plans\n'
    );

    const result = runGsdTools('init phase-op 3', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true);
    assert.ok(output.phase_dir.includes('03-api'), 'phase_dir should contain 03-api');
    assert.strictEqual(output.has_context, true);
    assert.strictEqual(output.has_plans, true);
  });

  test('fallback to ROADMAP when no directory exists', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 5: Widget Builder\n**Goal:** Build widgets\n**Plans:** TBD\n'
    );

    const result = runGsdTools('init phase-op 5', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true);
    assert.strictEqual(output.phase_dir, null);
    assert.strictEqual(output.phase_slug, 'widget-builder');
    assert.strictEqual(output.has_research, false);
    assert.strictEqual(output.has_context, false);
    assert.strictEqual(output.has_plans, false);
  });

  test('fallback resolves drifted project-code-prefixed roadmap heading by bare number (#1455)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase MANIFOLD-117: Prefixed Heading\n**Goal:** Build prefixed phase\n**Plans:** TBD\n'
    );

    const result = runGsdTools('init phase-op 117', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true);
    assert.strictEqual(output.phase_dir, null);
    assert.strictEqual(output.phase_number, '117');
    assert.strictEqual(output.phase_name, 'Prefixed Heading');
    assert.strictEqual(output.phase_slug, 'prefixed-heading');
  });

  test('fallback resolves drifted project-code-prefixed roadmap heading by prefixed ID (#1455)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase MANIFOLD-117: Prefixed Heading\n**Goal:** Build prefixed phase\n**Plans:** TBD\n'
    );

    const result = runGsdTools('init phase-op MANIFOLD-117', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true);
    assert.strictEqual(output.phase_dir, null);
    assert.strictEqual(output.phase_number, 'MANIFOLD-117');
    assert.strictEqual(output.phase_name, 'Prefixed Heading');
    assert.strictEqual(output.phase_slug, 'prefixed-heading');
  });

  test('prefers current milestone roadmap entry over archived phase with same number', () => {
    const archiveDir = path.join(
      tmpDir,
      '.planning',
      'milestones',
      'v1.2-phases',
      '02-event-parser-and-queue-schema'
    );
    fs.mkdirSync(archiveDir, { recursive: true });
    fs.writeFileSync(path.join(archiveDir, '02-CONTEXT.md'), '# Archived context');
    fs.writeFileSync(path.join(archiveDir, '02-01-PLAN.md'), '# Archived plan');
    fs.writeFileSync(path.join(archiveDir, '02-VERIFICATION.md'), '# Archived verification');

    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      `# Roadmap

<details>
<summary>Shipped milestone v1.2</summary>

### Phase 2: Event Parser and Queue Schema
**Goal:** Archived milestone work
</details>

## Milestone v1.3 Current

### Phase 2: Retry Orchestration
**Goal:** Current milestone work
**Plans:** TBD
`
    );

    const result = runGsdTools('init phase-op 2', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true);
    assert.strictEqual(output.phase_dir, null);
    assert.strictEqual(output.phase_name, 'Retry Orchestration');
    assert.strictEqual(output.phase_slug, 'retry-orchestration');
    assert.strictEqual(output.has_context, false);
    assert.strictEqual(output.has_plans, false);
    assert.strictEqual(output.has_verification, false);
  });

  test('neither directory nor roadmap entry returns not found', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: Setup\n**Goal:** Setup project\n**Plans:** TBD\n'
    );

    const result = runGsdTools('init phase-op 99', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, false);
    assert.strictEqual(output.phase_dir, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdInitProgress (INIT-03)
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdInitProgress', () => {
  let tmpDir;

  function writePassedVerification(phaseDir, phaseToken) {
    fs.writeFileSync(
      path.join(phaseDir, `${phaseToken}-VERIFICATION.md`),
      ['---', 'status: passed', '---', '', '# Verification', ''].join('\n')
    );
  }

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('no phases returns empty state', () => {
    const result = runGsdTools('init progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_count, 0);
    assert.deepStrictEqual(output.phases, []);
    assert.strictEqual(output.current_phase, null);
    assert.strictEqual(output.next_phase, null);
    assert.strictEqual(output.has_work_in_progress, false);
  });

  test('multiple phases with mixed statuses', () => {
    // Phase 01: complete (has plan + summary)
    const phase1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phase1, '01-01-SUMMARY.md'), '# Summary');
    writePassedVerification(phase1, '01');

    // Phase 02: in_progress (has plan, no summary)
    const phase2 = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(phase2, { recursive: true });
    fs.writeFileSync(path.join(phase2, '02-01-PLAN.md'), '# Plan');

    // Phase 03: pending (no plan, no research)
    const phase3 = path.join(tmpDir, '.planning', 'phases', '03-ui');
    fs.mkdirSync(phase3, { recursive: true });
    fs.writeFileSync(path.join(phase3, '03-CONTEXT.md'), '# Context');

    const result = runGsdTools('init progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_count, 3);
    assert.strictEqual(output.completed_count, 1);
    assert.strictEqual(output.in_progress_count, 1);
    assert.strictEqual(output.has_work_in_progress, true);

    assert.strictEqual(output.current_phase.number, '02');
    assert.strictEqual(output.current_phase.status, 'in_progress');

    assert.strictEqual(output.next_phase.number, '03');
    assert.strictEqual(output.next_phase.status, 'pending');

    // Verify phase entries have expected structure
    const p1 = output.phases.find(p => p.number === '01');
    assert.strictEqual(p1.status, 'complete');
    assert.strictEqual(p1.plan_count, 1);
    assert.strictEqual(p1.summary_count, 1);
  });

  test('researched status detected correctly', () => {
    const phase1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-RESEARCH.md'), '# Research');

    const result = runGsdTools('init progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const p1 = output.phases.find(p => p.number === '01');
    assert.strictEqual(p1.status, 'researched');
    assert.strictEqual(p1.has_research, true);
    assert.strictEqual(output.current_phase.number, '01');
  });

  test('all phases complete returns no current or next', () => {
    const phase1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phase1, '01-01-SUMMARY.md'), '# Summary');
    writePassedVerification(phase1, '01');

    const result = runGsdTools('init progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.completed_count, 1);
    assert.strictEqual(output.current_phase, null);
    assert.strictEqual(output.next_phase, null);
  });

  test('#3511-class: has_research ignores a misplaced RESEARCH.md that belongs to another phase', () => {
    // Phase 01 has no artifacts of its own.
    const phase1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phase1, { recursive: true });

    // Phase 02's directory holds ONLY a stray artifact whose filename token
    // ("01-") belongs to phase 01, not to this directory's own phase (02).
    const phase2 = path.join(tmpDir, '.planning', 'phases', '02-api');
    fs.mkdirSync(phase2, { recursive: true });
    fs.writeFileSync(path.join(phase2, '01-RESEARCH.md'), '# Research for phase 01');

    const result = runGsdTools('init progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const p2 = output.phases.find(p => p.number === '02');
    assert.strictEqual(p2.has_research, false,
      'phase 02 must not report has_research from a file that belongs to phase 01');
    assert.strictEqual(p2.status, 'pending');
  });

  test('implementation-complete phase without passed verification remains current work', () => {
    const phase1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phase1, { recursive: true });
    fs.writeFileSync(path.join(phase1, '01-01-PLAN.md'), '# Plan');
    fs.writeFileSync(path.join(phase1, '01-01-SUMMARY.md'), '# Summary');

    const result = runGsdTools('init progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.completed_count, 0);
    assert.strictEqual(output.in_progress_count, 1);
    assert.strictEqual(output.has_work_in_progress, true);
    assert.strictEqual(output.current_phase.number, '01');
    assert.strictEqual(output.current_phase.status, 'executed');
    assert.strictEqual(output.current_phase.implementation_complete, true);
    assert.strictEqual(output.current_phase.verification_status, 'missing');
    assert.strictEqual(output.current_phase.verification_passed, false);
  });

  test('paused_at detected from STATE.md', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\n**Paused At:** Phase 2, Task 3 — implementing auth\n'
    );

    const result = runGsdTools('init progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.paused_at, 'paused_at should be set');
    assert.ok(output.paused_at.includes('Phase 2, Task 3'), 'paused_at should contain pause location');
  });

  test('no paused_at when STATE.md has no pause line', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Project State\n\nSome content without pause.\n'
    );

    const result = runGsdTools('init progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.paused_at, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdInitQuick (INIT-05)
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdInitQuick', () => {
  let tmpDir;

  beforeEach(() => {
    // #2376 macOS fix: see 'init commands' beforeEach above.
    tmpDir = fs.realpathSync(createFixture());
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('init quick resolves the default researcher_model without overrides', () => {
    // #3936: the quick research step dispatches gsd-phase-researcher, so init
    // quick must resolve that agent's balanced-profile model without an override.
    const result = runGsdTools('init quick "Fix login bug" --raw', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.researcher_model, 'sonnet',
      'default balanced profile should resolve the research agent model');
  });

  test('init quick resolves researcher_model from model_overrides', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify({
      model_profile: 'balanced',
      model_overrides: { 'gsd-phase-researcher': 'openai/o4-mini' },
    }));

    const result = runGsdTools('init quick "Fix login bug" --raw', tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.researcher_model, 'openai/o4-mini',
      'model_overrides["gsd-phase-researcher"] must reach init quick\'s researcher_model');
  });

  test('with description generates slug and task_dir with YYMMDD-xxx format', () => {
    const result = runGsdTools('init quick "Fix login bug"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.branch_name, null);
    assert.strictEqual(output.slug, 'fix-login-bug');
    assert.strictEqual(output.description, 'Fix login bug');

    // quick_id must match YYMMDD-xxx (6 digits, dash, 3 base36 chars)
    assert.ok(/^\d{6}-[0-9a-z]{3}$/.test(output.quick_id),
      `quick_id should match YYMMDD-xxx, got: "${output.quick_id}"`);

    // task_dir must use the new ID format, absolute (anchored on tmpDir) — #2376.
    const quickDirAbs = absPlanningPath(tmpDir, 'quick');
    assert.ok(output.task_dir.startsWith(`${quickDirAbs}/`),
      `task_dir should start with ${quickDirAbs}/, got: "${output.task_dir}"`);
    assert.ok(output.task_dir.endsWith('-fix-login-bug'),
      `task_dir should end with -fix-login-bug, got: "${output.task_dir}"`);
    const taskDirRel = output.task_dir.slice(quickDirAbs.length + 1);
    assert.ok(/^\d{6}-[0-9a-z]{3}-fix-login-bug$/.test(taskDirRel),
      `task_dir format wrong: "${output.task_dir}"`);

    // next_num must NOT be present
    assert.ok(!('next_num' in output), 'next_num should not be in output');
  });

  test('without description returns null slug and task_dir', () => {
    const result = runGsdTools('init quick', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.slug, null);
    assert.strictEqual(output.task_dir, null);
    assert.strictEqual(output.description, null);

    // quick_id is still generated even without description
    assert.ok(/^\d{6}-[0-9a-z]{3}$/.test(output.quick_id),
      `quick_id should match YYMMDD-xxx, got: "${output.quick_id}"`);
  });

  test('two rapid calls produce different quick_ids (no collision within 2s window)', () => {
    // Both calls happen within the same test, which is sub-second.
    // They may or may not land in the same 2-second block. We just verify format.
    const r1 = runGsdTools('init quick "Task one"', tmpDir);
    const r2 = runGsdTools('init quick "Task two"', tmpDir);
    assert.ok(r1.success && r2.success);

    const o1 = JSON.parse(r1.output);
    const o2 = JSON.parse(r2.output);

    assert.ok(/^\d{6}-[0-9a-z]{3}$/.test(o1.quick_id));
    assert.ok(/^\d{6}-[0-9a-z]{3}$/.test(o2.quick_id));

    // Directories are distinct because slugs differ
    assert.notStrictEqual(o1.task_dir, o2.task_dir);
  });

  test('long description truncates slug to 40 chars', () => {
    const result = runGsdTools('init quick "This is a very long description that should get truncated to forty characters maximum"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.slug.length <= 40, `Slug should be <= 40 chars, got ${output.slug.length}: "${output.slug}"`);
  });

  test('returns quick branch name when quick_branch_template is configured', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        git: {
          quick_branch_template: 'gsd/quick-{num}-{slug}',
        },
      }, null, 2)
    );

    const result = runGsdTools('init quick "Fix login bug"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.branch_name, 'branch_name should be set');
    assert.ok(output.branch_name.startsWith('gsd/quick-'));
    assert.ok(output.branch_name.endsWith('-fix-login-bug'));
    assert.ok(output.branch_name.includes(output.quick_id), 'branch_name should include quick_id');
  });

  test('uses fallback slug in quick branch name when description is omitted', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        git: {
          quick_branch_template: 'gsd/quick-{quick}-{slug}',
        },
      }, null, 2)
    );

    const result = runGsdTools('init quick', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.branch_name, 'branch_name should be set');
    assert.ok(output.branch_name.endsWith('-quick'), `Expected fallback slug in branch name, got "${output.branch_name}"`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdInitQuick quick_id exact-value tests (#3314 — ADR-456 subprocess clock pin)
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdInitQuick quick_id — exact value under GSD_NOW_MS+TZ pin', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.realpathSync(createFixture());
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Computes the expected quick_id independently from the SAME algorithm
  // documented in src/init.cts's cmdInitQuick — NOT copy-pasted from its
  // runtime output — so this test can actually catch a broken implementation.
  function expectedQuickId(ms) {
    const d = new Date(ms);
    const yy = String(d.getUTCFullYear()).slice(-2);
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const dateStr = yy + mm + dd;
    const secondsSinceMidnight = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
    const timeBlocks = Math.floor(secondsSinceMidnight / 2);
    const timeEncoded = timeBlocks.toString(36).padStart(3, '0');
    return dateStr + '-' + timeEncoded;
  }

  test('quick_id: exact value for pinned instant', () => {
    const PINNED_MS = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
    const result = runGsdTools('init quick "pinned task"', tmpDir, {
      GSD_TEST_MODE: '1', GSD_NOW_MS: String(PINNED_MS), TZ: 'UTC',
    });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.quick_id, expectedQuickId(PINNED_MS));
  });

  test('boundary: two calls in the same 2s block share quick_id (documented collision, not a bug)', () => {
    const BLOCK_START_MS = 1_700_000_000_000; // aligned so +0 and +1000 fall in the same 2s block
    const r1 = runGsdTools('init quick "task a"', tmpDir, {
      GSD_TEST_MODE: '1', GSD_NOW_MS: String(BLOCK_START_MS), TZ: 'UTC',
    });
    const r2 = runGsdTools('init quick "task b"', tmpDir, {
      GSD_TEST_MODE: '1', GSD_NOW_MS: String(BLOCK_START_MS + 1000), TZ: 'UTC',
    });
    assert.ok(r1.success && r2.success);
    const o1 = JSON.parse(r1.output);
    const o2 = JSON.parse(r2.output);
    assert.strictEqual(o1.quick_id, expectedQuickId(BLOCK_START_MS));
    assert.strictEqual(o2.quick_id, expectedQuickId(BLOCK_START_MS + 1000));
    assert.strictEqual(o1.quick_id, o2.quick_id, 'both instants are in the same 2-second block and must share a quick_id');
  });

  test('boundary: two calls straddling a 2s block edge get different quick_id', () => {
    const BEFORE_EDGE_MS = 1_700_000_000_000; // even second → block boundary at +2000ms
    const AFTER_EDGE_MS = BEFORE_EDGE_MS + 2000;
    const r1 = runGsdTools('init quick "task a"', tmpDir, {
      GSD_TEST_MODE: '1', GSD_NOW_MS: String(BEFORE_EDGE_MS), TZ: 'UTC',
    });
    const r2 = runGsdTools('init quick "task b"', tmpDir, {
      GSD_TEST_MODE: '1', GSD_NOW_MS: String(AFTER_EDGE_MS), TZ: 'UTC',
    });
    assert.ok(r1.success && r2.success);
    const o1 = JSON.parse(r1.output);
    const o2 = JSON.parse(r2.output);
    assert.strictEqual(o1.quick_id, expectedQuickId(BEFORE_EDGE_MS));
    assert.strictEqual(o2.quick_id, expectedQuickId(AFTER_EDGE_MS));
    assert.notStrictEqual(o1.quick_id, o2.quick_id, 'instants 2000ms apart cross a 2-second block edge and must differ');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdInitMapCodebase (INIT-05)
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdInitMapCodebase', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('no codebase dir returns empty', () => {
    const result = runGsdTools('init map-codebase', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_maps, false);
    assert.deepStrictEqual(output.existing_maps, []);
    assert.strictEqual(output.codebase_dir_exists, false);
  });

  test('with existing maps lists md files only', () => {
    const codebaseDir = path.join(tmpDir, '.planning', 'codebase');
    fs.mkdirSync(codebaseDir, { recursive: true });
    fs.writeFileSync(path.join(codebaseDir, 'STACK.md'), '# Stack');
    fs.writeFileSync(path.join(codebaseDir, 'ARCHITECTURE.md'), '# Architecture');
    fs.writeFileSync(path.join(codebaseDir, 'notes.txt'), 'not a markdown file');

    const result = runGsdTools('init map-codebase', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_maps, true);
    assert.strictEqual(output.existing_maps.length, 2);
    assert.ok(output.existing_maps.includes('STACK.md'), 'Should include STACK.md');
    assert.ok(output.existing_maps.includes('ARCHITECTURE.md'), 'Should include ARCHITECTURE.md');
  });

  test('empty codebase dir returns no maps', () => {
    const codebaseDir = path.join(tmpDir, '.planning', 'codebase');
    fs.mkdirSync(codebaseDir, { recursive: true });

    const result = runGsdTools('init map-codebase', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_maps, false);
    assert.deepStrictEqual(output.existing_maps, []);
    assert.strictEqual(output.codebase_dir_exists, true);
  });

  test('map-codebase workflow does not list OpenCode under runtimes without Task tool (#1316)', () => {
    const workflow = fs.readFileSync(
      path.join(__dirname, '..', 'gsd-core', 'workflows', 'map-codebase.md'), 'utf8'
    );
    // OpenCode must NOT appear in the "WITHOUT Task tool" / "NOT available" condition
    const withoutLine = workflow.split(/\r?\n/).find(l =>
      l.includes('NOT available') || l.includes('WITHOUT Task tool')
    );
    assert.ok(withoutLine, 'workflow should have a line about Task tool NOT being available');
    assert.ok(!withoutLine.includes('OpenCode'), 'OpenCode must NOT be listed under runtimes WITHOUT Task tool');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdInitNewProject (INIT-06)
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdInitNewProject', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('greenfield project with no code', () => {
    const result = runGsdTools('init new-project', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_existing_code, false);
    assert.strictEqual(output.has_package_file, false);
    assert.strictEqual(output.is_brownfield, false);
    assert.strictEqual(output.needs_codebase_map, false);
  });

  test('brownfield with package.json detected', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');

    const result = runGsdTools('init new-project', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_package_file, true);
    assert.strictEqual(output.is_brownfield, true);
    assert.strictEqual(output.needs_codebase_map, true);
  });

  test('brownfield with codebase map does not need map', () => {
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'codebase'), { recursive: true });
    for (const name of ['STACK', 'ARCHITECTURE', 'STRUCTURE', 'CONVENTIONS', 'TESTING', 'INTEGRATIONS', 'CONCERNS']) {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'codebase', `${name}.md`), `# ${name}\n`);
    }

    const result = runGsdTools('init new-project', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.is_brownfield, true);
    assert.strictEqual(output.needs_codebase_map, false);
  });

  test('planning_exists flag is correct', () => {
    const result = runGsdTools('init new-project', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.planning_exists, true);
  });

  test('brownfield with Kotlin files detected (Android project)', () => {
    const srcDir = path.join(tmpDir, 'app', 'src', 'main');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'MainActivity.kt'), 'class MainActivity');

    const result = runGsdTools('init new-project', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_existing_code, true);
    assert.strictEqual(output.is_brownfield, true);
  });

  test('brownfield with build.gradle detected (Android/Gradle project)', () => {
    fs.writeFileSync(path.join(tmpDir, 'build.gradle'), 'apply plugin: "com.android.application"');

    const result = runGsdTools('init new-project', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_package_file, true);
    assert.strictEqual(output.is_brownfield, true);
    assert.strictEqual(output.needs_codebase_map, true);
  });

  test('brownfield with build.gradle.kts detected (Kotlin DSL)', () => {
    fs.writeFileSync(path.join(tmpDir, 'build.gradle.kts'), 'plugins { id("com.android.application") }');

    const result = runGsdTools('init new-project', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_package_file, true);
    assert.strictEqual(output.is_brownfield, true);
  });

  test('brownfield with pom.xml detected (Maven project)', () => {
    fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');

    const result = runGsdTools('init new-project', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_package_file, true);
    assert.strictEqual(output.is_brownfield, true);
  });

  test('brownfield with pubspec.yaml detected (Flutter/Dart project)', () => {
    fs.writeFileSync(path.join(tmpDir, 'pubspec.yaml'), 'name: my_app');

    const result = runGsdTools('init new-project', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_package_file, true);
    assert.strictEqual(output.is_brownfield, true);
  });

  test('brownfield with Dart files detected', () => {
    const libDir = path.join(tmpDir, 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(libDir, 'main.dart'), 'void main() {}');

    const result = runGsdTools('init new-project', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_existing_code, true);
    assert.strictEqual(output.is_brownfield, true);
  });

  test('brownfield with C++ files detected', () => {
    fs.writeFileSync(path.join(tmpDir, 'main.cpp'), 'int main() { return 0; }');

    const result = runGsdTools('init new-project', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.has_existing_code, true);
    assert.strictEqual(output.is_brownfield, true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// cmdInitNewMilestone (INIT-06)
// ─────────────────────────────────────────────────────────────────────────────

describe('cmdInitNewMilestone', () => {
  let tmpDir;

  beforeEach(() => {
    // #2376 macOS fix: see 'init commands' beforeEach above.
    tmpDir = fs.realpathSync(createFixture());
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns expected fields', () => {
    const result = runGsdTools('init new-milestone', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok('current_milestone' in output, 'Should have current_milestone');
    assert.ok('current_milestone_name' in output, 'Should have current_milestone_name');
    assert.ok('researcher_model' in output, 'Should have researcher_model');
    assert.ok('synthesizer_model' in output, 'Should have synthesizer_model');
    assert.ok('roadmapper_model' in output, 'Should have roadmapper_model');
    assert.ok('commit_docs' in output, 'Should have commit_docs');
    assert.strictEqual(output.project_path, absPlanningPath(tmpDir, 'PROJECT.md'));
    assert.strictEqual(output.roadmap_path, absPlanningPath(tmpDir, 'ROADMAP.md'));
    assert.strictEqual(output.state_path, absPlanningPath(tmpDir, 'STATE.md'));
  });

  test('file existence flags reflect actual state', () => {
    // Default: no STATE.md, ROADMAP.md, or PROJECT.md
    const result1 = runGsdTools('init new-milestone', tmpDir);
    assert.ok(result1.success, `Command failed: ${result1.error}`);

    const output1 = JSON.parse(result1.output);
    assert.strictEqual(output1.state_exists, false);
    assert.strictEqual(output1.roadmap_exists, false);
    assert.strictEqual(output1.project_exists, false);

    // Create files and verify flags change
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '# State');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), '# Roadmap');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# Project');

    const result2 = runGsdTools('init new-milestone', tmpDir);
    assert.ok(result2.success, `Command failed: ${result2.error}`);

    const output2 = JSON.parse(result2.output);
    assert.strictEqual(output2.state_exists, true);
    assert.strictEqual(output2.roadmap_exists, true);
    assert.strictEqual(output2.project_exists, true);
  });

  test('reports latest completed milestone and archive target for reset flow', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'MILESTONES.md'),
      '# Milestones\n\n## v1.2 Search Refresh (Shipped: 2026-02-18)\n\n---\n'
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '06-refine-search'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '07-polish'), { recursive: true });

    const result = runGsdTools('init new-milestone', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.latest_completed_milestone, 'v1.2');
    assert.strictEqual(output.latest_completed_milestone_name, 'Search Refresh');
    assert.strictEqual(output.phase_dir_count, 2);
    assert.strictEqual(output.phase_archive_path, absPlanningPath(tmpDir, 'milestones', 'v1.2-phases'));
  });

  test('reset flow metadata is null-safe when no milestones file exists', () => {
    const result = runGsdTools('init new-milestone', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.latest_completed_milestone, null);
    assert.strictEqual(output.latest_completed_milestone_name, null);
    assert.strictEqual(output.phase_dir_count, 0);
    assert.strictEqual(output.phase_archive_path, null);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// findProjectRoot integration — gsd-tools resolves project root from sub-repo
// ─────────────────────────────────────────────────────────────────────────────

describe('findProjectRoot integration via --cwd', () => {
  let projectRoot;

  beforeEach(() => {
    projectRoot = createFixture();
    // Add ROADMAP.md so init quick doesn't error
    fs.writeFileSync(
      path.join(projectRoot, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n## Phase 1: Foundation\n**Goal:** Setup\n'
    );
    // Write sub_repos config
    fs.writeFileSync(
      path.join(projectRoot, '.planning', 'config.json'),
      JSON.stringify({ sub_repos: ['backend', 'frontend'] })
    );
    // Create sub-repo directory
    fs.mkdirSync(path.join(projectRoot, 'backend'));
  });

  afterEach(() => {
    cleanup(projectRoot);
  });

  test('init quick from sub-repo CWD returns project_root pointing to parent', () => {
    const backendDir = path.join(projectRoot, 'backend');
    const result = runGsdTools(['init', 'quick', 'test task', '--cwd', backendDir]);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok('project_root' in output, 'Should have project_root');
    assert.strictEqual(output.project_root, projectRoot, 'project_root should be the parent, not the sub-repo');
    assert.ok(output.roadmap_exists, 'Should find ROADMAP.md at project root');
  });

  test('init quick from project root returns project_root as-is', () => {
    const result = runGsdTools(['init', 'quick', 'test task', '--cwd', projectRoot]);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.project_root, projectRoot);
  });

  test('state load from sub-repo CWD reads project root config', () => {
    // Write STATE.md at project root
    fs.writeFileSync(
      path.join(projectRoot, '.planning', 'STATE.md'),
      '---\ncurrent_phase: 1\nphase_name: Foundation\n---\n# State\n'
    );

    const backendDir = path.join(projectRoot, 'backend');
    const result = runGsdTools(['state', '--cwd', backendDir]);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Should find config from project root, not from backend/
    assert.deepStrictEqual(output.config.sub_repos, ['backend', 'frontend'],
      'Should read sub_repos from project root config');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2192: init plan-phase must include auto_advance, auto_chain_active, and mode
// so workflows don't need separate config-get calls that loop on Kimi K2.5
// ─────────────────────────────────────────────────────────────────────────────

describe('#2192: init plan-phase includes auto-advance config to prevent separate config-get loops', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-auth'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      ['# Roadmap', '', '## Milestone v1', '', '### Phase 1: Auth', '**Goal:** Auth'].join('\n')
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('init plan-phase includes auto_advance field (defaults false)', () => {
    const result = runGsdTools('init plan-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok('auto_advance' in output, 'init plan-phase must include auto_advance field');
    assert.strictEqual(output.auto_advance, false, 'auto_advance should default to false');
  });

  test('init plan-phase includes auto_chain_active field (defaults false)', () => {
    const result = runGsdTools('init plan-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok('auto_chain_active' in output, 'init plan-phase must include auto_chain_active field');
    assert.strictEqual(output.auto_chain_active, false, 'auto_chain_active should default to false');
  });

  test('init plan-phase includes mode field (defaults to interactive)', () => {
    const result = runGsdTools('init plan-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok('mode' in output, 'init plan-phase must include mode field');
    assert.strictEqual(output.mode, 'interactive', 'mode should default to interactive');
  });

  test('init plan-phase reflects auto_advance true when set in config', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const cfg = { workflow: { auto_advance: true } };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    const result = runGsdTools('init plan-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.auto_advance, true, 'auto_advance should reflect config value');
  });

  test('init plan-phase reflects auto_chain_active true when set in config', () => {
    const configPath = path.join(tmpDir, '.planning', 'config.json');
    const cfg = { workflow: { _auto_chain_active: true } };
    fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    const result = runGsdTools('init plan-phase 1', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.auto_chain_active, true, 'auto_chain_active should reflect config value');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// withProjectRoot: project identity injection (#1948)
// ─────────────────────────────────────────────────────────────────────────────

describe('withProjectRoot project identity', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFixture();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('injects project_code when config.project_code is set', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ project_code: 'CK' })
    );

    const result = runGsdTools(['init', 'quick', 'test task'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.project_code, 'CK');
  });

  test('injects project_title extracted from PROJECT.md H1', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ project_code: 'CK' })
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      '# CareKit\n\nA care management platform.\n'
    );

    const result = runGsdTools(['init', 'quick', 'test task'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.project_title, 'CareKit');
  });

  test('omits project_code and project_title when project_code is not set', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({})
    );

    const result = runGsdTools(['init', 'quick', 'test task'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.project_code, undefined,
      'project_code should not be present when not configured');
    // project_title may or may not be present depending on PROJECT.md existence,
    // but without project_code the workflow omits the identity suffix entirely
  });

  test('omits project_title when PROJECT.md does not exist', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ project_code: 'CK' })
    );
    // Ensure no PROJECT.md exists (createFixture doesn't create one)
    const projectMdPath = path.join(tmpDir, '.planning', 'PROJECT.md');
    if (fs.existsSync(projectMdPath)) fs.unlinkSync(projectMdPath);

    const result = runGsdTools(['init', 'quick', 'test task'], tmpDir, { HOME: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.project_code, 'CK',
      'project_code should still be present');
    assert.strictEqual(output.project_title, undefined,
      'project_title should not be present when PROJECT.md is missing');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADR-0006: init handlers honor GSD_WORKSTREAM (planningPaths/planningDir consumption)
// Issue #1189 — regression guard: workstream-scoped paths must be resolved
// through planningDir(cwd) which picks up GSD_WORKSTREAM from env.
// ─────────────────────────────────────────────────────────────────────────────

describe('init handlers honor GSD_WORKSTREAM (ADR-0006 planningPaths consumption)', () => {
  const { seedWorkstream } = require('./fixtures/index.cjs');

  /**
   * Build a workstream-scoped fixture under tmpDir.
   * Only workstream-scoped files exist; flat .planning/ has only the phases dir.
   */
  function buildWsFixture(tmpDir, ws = 'wsx') {
    const wsDir = seedWorkstream(tmpDir, { name: ws });
    // Write the planning files ONLY under the workstream path
    fs.writeFileSync(
      path.join(wsDir, 'STATE.md'),
      '# State\n'
    );
    fs.writeFileSync(
      path.join(wsDir, 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: Setup\n**Goal:** Bootstrap\n**Requirements**: R-01\n**Plans:** 1 plans\n'
    );
    // #3188: REQUIREMENTS.md present so the workstream-scoped requirements_path
    // present-case assertion holds (STATE/ROADMAP already written above).
    fs.writeFileSync(path.join(wsDir, 'REQUIREMENTS.md'), '# Requirements\n');
    fs.writeFileSync(
      path.join(wsDir, 'config.json'),
      JSON.stringify({})
    );
    // Create a phase plan under the workstream
    fs.mkdirSync(path.join(wsDir, 'phases', '01-setup'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, 'phases', '01-setup', '01-01-PLAN.md'), '# Plan\n');
    return wsDir;
  }

  // ── Test 1: execute-phase — workstream-scoped path fields (happy) ─────────

  describe('execute-phase — workstream-scoped path fields', () => {
    let tmpDir;

    beforeEach(() => {
      // #2376 macOS fix: see 'init commands' beforeEach above.
      tmpDir = fs.realpathSync(createFixture());
      buildWsFixture(tmpDir, 'wsx');
    });

    afterEach(() => {
      cleanup(tmpDir);
    });

    test('execute-phase emits workstream-scoped state/roadmap/config paths (ADR-0006)', () => {
      const result = runGsdTools('init execute-phase 1', tmpDir, { GSD_WORKSTREAM: 'wsx', GSD_PROJECT: '' });
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      // Positive: paths must be workstream-scoped
      assert.strictEqual(output.state_path, absPlanningPath(tmpDir, 'workstreams', 'wsx', 'STATE.md'));
      assert.strictEqual(output.roadmap_path, absPlanningPath(tmpDir, 'workstreams', 'wsx', 'ROADMAP.md'));
      assert.strictEqual(output.config_path, absPlanningPath(tmpDir, 'workstreams', 'wsx', 'config.json'));
      // Goodhart both-directions: must NOT be the flat form
      assert.notStrictEqual(output.state_path, absPlanningPath(tmpDir, 'STATE.md'));
      assert.notStrictEqual(output.roadmap_path, absPlanningPath(tmpDir, 'ROADMAP.md'));
      assert.notStrictEqual(output.config_path, absPlanningPath(tmpDir, 'config.json'));
      // phase_dir is emitted and must be workstream-scoped
      assert.ok(
        output.phase_dir && output.phase_dir.includes('workstreams/wsx'),
        `phase_dir should include workstreams/wsx, got: ${output.phase_dir}`
      );
    });

    test('execute-phase WITHOUT GSD_WORKSTREAM resolves flat paths (boundary control)', () => {
      // Flat fixture: the workstream fixture exists but we do NOT pass GSD_WORKSTREAM.
      // Handler should resolve flat .planning/ → state/roadmap/config are flat,
      // and the workstream phase is NOT found (flat phases/ is empty).
      // #3188: create the flat docs so the flat *_path present-case assertions hold.
      writePlanningDocs(tmpDir);
      const result = runGsdTools('init execute-phase 1', tmpDir, { GSD_WORKSTREAM: '', GSD_PROJECT: '' });
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      // Flat paths must be returned when no workstream is active
      assert.strictEqual(output.state_path, absPlanningPath(tmpDir, 'STATE.md'));
      assert.strictEqual(output.roadmap_path, absPlanningPath(tmpDir, 'ROADMAP.md'));
      assert.strictEqual(output.config_path, absPlanningPath(tmpDir, 'config.json'));
      // Phase is NOT found in flat .planning/phases/ (only exists under workstream)
      assert.strictEqual(output.phase_found, false,
        'phase should not be found in flat path when only workstream fixture exists');
    });
  });

  // ── Test 2: milestone-op — reads workstream-scoped roadmap/state/phases ───

  describe('milestone-op — reads workstream-scoped planning files', () => {
    let tmpDir;

    beforeEach(() => {
      // Do NOT call createFixture (which would add flat .planning/phases/).
      // Create a bare temp dir so files only exist under the workstream path.
      const os = require('os');
      tmpDir = fs.mkdtempSync(require('path').join(os.tmpdir(), 'gsd-test-'));
      buildWsFixture(tmpDir, 'wsx');
    });

    afterEach(() => {
      cleanup(tmpDir);
    });

    test('milestone-op with GSD_WORKSTREAM finds roadmap/state/phases in workstream scope (ADR-0006)', () => {
      const result = runGsdTools('init milestone-op', tmpDir, { GSD_WORKSTREAM: 'wsx', GSD_PROJECT: '' });
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.roadmap_exists, true,
        'roadmap_exists must be true: ROADMAP.md exists only under workstream path');
      assert.strictEqual(output.state_exists, true,
        'state_exists must be true: STATE.md exists only under workstream path');
      assert.strictEqual(output.phases_dir_exists, true,
        'phases_dir_exists must be true: phases/ exists under workstream path');
    });

    test('milestone-op WITHOUT GSD_WORKSTREAM misses workstream-only files (negative discrimination)', () => {
      const result = runGsdTools('init milestone-op', tmpDir, { GSD_WORKSTREAM: '', GSD_PROJECT: '' });
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      // Handler looked at flat .planning/ — no files there → all false
      assert.strictEqual(output.roadmap_exists, false,
        'roadmap_exists must be false: ROADMAP.md is only under workstream, not flat .planning/');
      assert.strictEqual(output.state_exists, false,
        'state_exists must be false: STATE.md is only under workstream, not flat .planning/');
    });
  });

  // ── Test 3: plan-phase — workstream-scoped resolution ────────────────────

  describe('plan-phase — workstream-scoped path resolution', () => {
    let tmpDir;

    beforeEach(() => {
      // #2376 macOS fix: see 'init commands' beforeEach above.
      tmpDir = fs.realpathSync(createFixture());
      buildWsFixture(tmpDir, 'wsx');
    });

    afterEach(() => {
      cleanup(tmpDir);
    });

    test('plan-phase emits workstream-scoped state/roadmap/requirements paths (ADR-0006)', () => {
      const result = runGsdTools('init plan-phase 1', tmpDir, { GSD_WORKSTREAM: 'wsx', GSD_PROJECT: '' });
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      // Path fields must be scoped to the workstream
      assert.strictEqual(output.state_path, absPlanningPath(tmpDir, 'workstreams', 'wsx', 'STATE.md'));
      assert.strictEqual(output.roadmap_path, absPlanningPath(tmpDir, 'workstreams', 'wsx', 'ROADMAP.md'));
      assert.strictEqual(output.requirements_path, absPlanningPath(tmpDir, 'workstreams', 'wsx', 'REQUIREMENTS.md'));
      // Must NOT be flat
      assert.notStrictEqual(output.state_path, absPlanningPath(tmpDir, 'STATE.md'));
      assert.notStrictEqual(output.roadmap_path, absPlanningPath(tmpDir, 'ROADMAP.md'));
      // phase_dir is workstream-scoped and phase is found
      assert.strictEqual(output.phase_found, true);
      assert.ok(
        output.phase_dir && output.phase_dir.includes('workstreams/wsx'),
        `phase_dir should include workstreams/wsx, got: ${output.phase_dir}`
      );
    });

    test('plan-phase WITHOUT GSD_WORKSTREAM resolves flat paths (boundary control)', () => {
      // #3188: create the flat docs so the flat *_path present-case assertions hold.
      writePlanningDocs(tmpDir);
      const result = runGsdTools('init plan-phase 1', tmpDir, { GSD_WORKSTREAM: '', GSD_PROJECT: '' });
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      assert.strictEqual(output.state_path, absPlanningPath(tmpDir, 'STATE.md'));
      assert.strictEqual(output.roadmap_path, absPlanningPath(tmpDir, 'ROADMAP.md'));
      assert.strictEqual(output.requirements_path, absPlanningPath(tmpDir, 'REQUIREMENTS.md'));
      // Phase only exists under workstream, so not found via flat path
      assert.strictEqual(output.phase_found, false);
    });
  });

  // ── Test 4: phase-op — workstream-scoped phase resolution ────────────────

  describe('phase-op — workstream-scoped phase resolution', () => {
    let tmpDir;

    beforeEach(() => {
      // #2376 macOS fix: see 'init commands' beforeEach above.
      tmpDir = fs.realpathSync(createFixture());
      buildWsFixture(tmpDir, 'wsx');
    });

    afterEach(() => {
      cleanup(tmpDir);
    });

    test('phase-op with GSD_WORKSTREAM finds phase in workstream scope and emits scoped paths (ADR-0006)', () => {
      const result = runGsdTools('init phase-op 1', tmpDir, { GSD_WORKSTREAM: 'wsx', GSD_PROJECT: '' });
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      // Phase is found via workstream-scoped phases dir
      assert.strictEqual(output.phase_found, true,
        'phase_found must be true: phase exists under workstream path');
      assert.ok(
        output.phase_dir && output.phase_dir.includes('workstreams/wsx'),
        `phase_dir should include workstreams/wsx, got: ${output.phase_dir}`
      );
      // Path fields are workstream-scoped
      assert.strictEqual(output.state_path, absPlanningPath(tmpDir, 'workstreams', 'wsx', 'STATE.md'));
      assert.strictEqual(output.roadmap_path, absPlanningPath(tmpDir, 'workstreams', 'wsx', 'ROADMAP.md'));
      assert.notStrictEqual(output.state_path, absPlanningPath(tmpDir, 'STATE.md'));
    });

    test('phase-op WITHOUT GSD_WORKSTREAM does not find workstream-only phase (negative discrimination)', () => {
      // #3188: create the flat docs so the flat *_path present-case assertions hold.
      writePlanningDocs(tmpDir);
      const result = runGsdTools('init phase-op 1', tmpDir, { GSD_WORKSTREAM: '', GSD_PROJECT: '' });
      assert.ok(result.success, `Command failed: ${result.error}`);

      const output = JSON.parse(result.output);
      // Phase only exists under workstream path — flat path has no matching phase dir
      assert.strictEqual(output.phase_found, false,
        'phase_found must be false: phase only exists under workstream path');
      // Flat paths are emitted
      assert.strictEqual(output.state_path, absPlanningPath(tmpDir, 'STATE.md'));
      assert.strictEqual(output.roadmap_path, absPlanningPath(tmpDir, 'ROADMAP.md'));
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1912: init.progress fails safe in workstream mode with no active workstream
// ─────────────────────────────────────────────────────────────────────────────

describe('#1912 — init.progress fails safe in workstream mode with no active workstream', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  function seedWs(name, milestoneVersion) {
    const wsDir = path.join(tmpDir, '.planning', 'workstreams', name);
    fs.mkdirSync(path.join(wsDir, 'phases'), { recursive: true });
    fs.writeFileSync(
      path.join(wsDir, 'STATE.md'),
      `# State\n\n**Status:** executing\n**Milestone:** ${milestoneVersion}\n`,
    );
    fs.writeFileSync(
      path.join(wsDir, 'ROADMAP.md'),
      `# Roadmap\n\n## Milestones\n- ${milestoneVersion} Test (Phase 1)\n\n## Phases\n### Phase 1: X\n**Goal:** do x\n`,
    );
    return wsDir;
  }

  test('errors (does NOT report stale root) when workstreams exist but none active', () => {
    seedWs('alpha', 'v9.0');
    seedWs('beta', 'v9.0');
    // Stale root STATE — the misleading value that must never be silently reported.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'milestone: v7.1\nstatus: executing\n');
    // No active-workstream pointer, no --ws.
    const result = runGsdTools('init progress', tmpDir);
    assert.equal(result.success, false, 'should fail safe rather than report the stale root milestone');
    assert.match(result.error || '', /workstream|--ws/i, 'error should name the workstream requirement');
  });

  test('succeeds with --ws (reads the named workstream, not root)', () => {
    seedWs('alpha', 'v9.0');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'milestone: v7.1\nstatus: executing\n');
    const result = runGsdTools('init progress --ws alpha', tmpDir);
    assert.ok(result.success, `should succeed with --ws: ${result.error}`);
  });

  test('flat mode (no workstreams dir) is unchanged', () => {
    const result = runGsdTools('init progress', tmpDir);
    assert.ok(result.success, `flat mode should still work: ${result.error}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #2376: init.* path-shaped output fields must resolve regardless of the
// calling process's own cwd — not just the orchestrator's cwd. A spawned
// subagent's actual filesystem cwd can legitimately differ from the
// orchestrator's (e.g. a worktree), and every `*_path`/`*_dir` field handed
// to it must still resolve to the real file. These tests spawn gsd-tools with
// its OS-level process cwd pointed at an unrelated decoy directory while
// passing the real project root via `--cwd` — reproducing exactly the
// cwd-mismatch the bug hides behind, without relying on incidental absence
// of `.planning/` at the test runner's own cwd.
// ─────────────────────────────────────────────────────────────────────────────

describe('#2376 — init.* path fields resolve when process cwd differs from --cwd project root', () => {
  let projectDir;
  let decoyDir;

  beforeEach(() => {
    projectDir = createFixture();
    decoyDir = createTempDir('gsd-2376-decoy-');
  });

  afterEach(() => {
    cleanup(projectDir);
    cleanup(decoyDir);
  });

  test('init plan-phase emits absolute path fields that resolve from a different process cwd', () => {
    seedPhase(projectDir, '03-api', {
      '03-CONTEXT.md': '# Phase Context',
    });
    fs.writeFileSync(path.join(projectDir, '.planning', 'STATE.md'), '# State\n');
    fs.writeFileSync(path.join(projectDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    fs.writeFileSync(path.join(projectDir, '.planning', 'REQUIREMENTS.md'), '# Requirements\n');

    const result = runGsdTools(['init', 'plan-phase', '03', '--cwd', projectDir], decoyDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    for (const field of ['state_path', 'roadmap_path', 'requirements_path', 'context_path', 'phase_dir']) {
      const value = output[field];
      assert.ok(value, `${field} should be present, got: ${JSON.stringify(value)}`);
      assert.ok(path.isAbsolute(value), `${field} must be absolute, got: "${value}"`);
      // Resolve AS-IS — no joining against decoyDir or process.cwd() — the
      // string itself must locate the real, already-committed file/dir.
      assert.ok(fs.existsSync(value), `${field} must resolve to the real file/dir: "${value}"`);
    }
  });

  test('init verify-work now emits absolute state_path/roadmap_path (previously absent)', () => {
    seedPhase(projectDir, '03-api', {
      '03-01-PLAN.md': '# Plan',
      '03-01-SUMMARY.md': '# Summary',
    });
    fs.writeFileSync(path.join(projectDir, '.planning', 'STATE.md'), '# State\n');
    fs.writeFileSync(path.join(projectDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');

    const result = runGsdTools(['init', 'verify-work', '03', '--cwd', projectDir], decoyDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok('state_path' in output, 'cmdInitVerifyWork must now emit state_path (#2376)');
    assert.ok('roadmap_path' in output, 'cmdInitVerifyWork must now emit roadmap_path (#2376)');
    for (const field of ['state_path', 'roadmap_path']) {
      assert.ok(path.isAbsolute(output[field]), `${field} must be absolute, got: "${output[field]}"`);
      assert.ok(fs.existsSync(output[field]), `${field} must resolve to the real file: "${output[field]}"`);
    }
  });

  test('init phase-op emits absolute path fields that resolve from a different process cwd', () => {
    seedPhase(projectDir, '03-api', {
      '03-CONTEXT.md': '# Phase Context',
      '03-RESEARCH.md': '# Research',
    });
    fs.writeFileSync(path.join(projectDir, '.planning', 'STATE.md'), '# State\n');
    fs.writeFileSync(path.join(projectDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    fs.writeFileSync(path.join(projectDir, '.planning', 'REQUIREMENTS.md'), '# Requirements\n');

    const result = runGsdTools(['init', 'phase-op', '03', '--cwd', projectDir], decoyDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    for (const field of ['phase_dir', 'state_path', 'roadmap_path', 'requirements_path', 'context_path', 'research_path']) {
      const value = output[field];
      assert.ok(value, `${field} should be present, got: ${JSON.stringify(value)}`);
      assert.ok(path.isAbsolute(value), `${field} must be absolute, got: "${value}"`);
      assert.ok(fs.existsSync(value), `${field} must resolve to the real file/dir: "${value}"`);
    }
  });

  test('init todos emits absolute pending_dir/completed_dir and per-todo path fields', () => {
    const pendingDir = path.join(projectDir, '.planning', 'todos', 'pending');
    fs.mkdirSync(pendingDir, { recursive: true });
    fs.writeFileSync(path.join(pendingDir, 'task-1.md'), 'title: Fix bug\narea: backend\ncreated: 2026-02-25');

    const result = runGsdTools(['init', 'todos', '--cwd', projectDir], decoyDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(path.isAbsolute(output.pending_dir), `pending_dir must be absolute, got: "${output.pending_dir}"`);
    assert.ok(fs.existsSync(output.pending_dir), `pending_dir must resolve to the real directory: "${output.pending_dir}"`);
    assert.ok(path.isAbsolute(output.completed_dir), `completed_dir must be absolute, got: "${output.completed_dir}"`);

    const todo = output.todos.find((t) => t.file === 'task-1.md');
    assert.ok(todo, 'task-1.md should be present in todos');
    assert.ok(path.isAbsolute(todo.path), `todo.path must be absolute, got: "${todo.path}"`);
    assert.ok(fs.existsSync(todo.path), `todo.path must resolve to the real file: "${todo.path}"`);
  });

  test('init new-project emits absolute requirements_path/roadmap_path/config_path/research_dir (previously absent)', () => {
    fs.writeFileSync(path.join(projectDir, '.planning', 'REQUIREMENTS.md'), '# Requirements\n');
    fs.writeFileSync(path.join(projectDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    fs.writeFileSync(path.join(projectDir, '.planning', 'config.json'), '{}\n');
    fs.mkdirSync(path.join(projectDir, '.planning', 'research'), { recursive: true });

    const result = runGsdTools(['init', 'new-project', '--cwd', projectDir], decoyDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    for (const field of ['requirements_path', 'roadmap_path', 'config_path', 'research_dir']) {
      assert.ok(field in output, `cmdInitNewProject must now emit ${field} (#2376)`);
      const value = output[field];
      assert.ok(path.isAbsolute(value), `${field} must be absolute, got: "${value}"`);
      assert.ok(fs.existsSync(value), `${field} must resolve to the real file/dir: "${value}"`);
    }
  });

  test('init new-milestone emits absolute requirements_path/config_path/research_dir/milestones_path (previously absent)', () => {
    fs.writeFileSync(path.join(projectDir, '.planning', 'REQUIREMENTS.md'), '# Requirements\n');
    fs.writeFileSync(path.join(projectDir, '.planning', 'config.json'), '{}\n');
    fs.writeFileSync(path.join(projectDir, '.planning', 'MILESTONES.md'), '# Milestones\n');
    fs.mkdirSync(path.join(projectDir, '.planning', 'research'), { recursive: true });

    const result = runGsdTools(['init', 'new-milestone', '--cwd', projectDir], decoyDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    for (const field of ['requirements_path', 'config_path', 'research_dir', 'milestones_path']) {
      assert.ok(field in output, `cmdInitNewMilestone must now emit ${field} (#2376)`);
      const value = output[field];
      assert.ok(path.isAbsolute(value), `${field} must be absolute, got: "${value}"`);
      assert.ok(fs.existsSync(value), `${field} must resolve to the real file/dir: "${value}"`);
    }
  });

  test('init ingest-docs emits absolute requirements_path/roadmap_path/state_path/intel_dir/conflicts_path (previously absent)', () => {
    fs.writeFileSync(path.join(projectDir, '.planning', 'REQUIREMENTS.md'), '# Requirements\n');
    fs.writeFileSync(path.join(projectDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    fs.writeFileSync(path.join(projectDir, '.planning', 'STATE.md'), '# State\n');
    fs.mkdirSync(path.join(projectDir, '.planning', 'intel'), { recursive: true });

    const result = runGsdTools(['init', 'ingest-docs', '--cwd', projectDir], decoyDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    for (const field of ['requirements_path', 'roadmap_path', 'state_path', 'intel_dir']) {
      assert.ok(field in output, `cmdInitIngestDocs must now emit ${field} (#2376)`);
      const value = output[field];
      assert.ok(path.isAbsolute(value), `${field} must be absolute, got: "${value}"`);
      assert.ok(fs.existsSync(value), `${field} must resolve to the real file/dir: "${value}"`);
    }
    // conflicts_path is written by the synthesizer, not present at init time —
    // assert absolute-shape only, not existence.
    assert.ok('conflicts_path' in output, 'cmdInitIngestDocs must now emit conflicts_path (#2376)');
    assert.ok(path.isAbsolute(output.conflicts_path), `conflicts_path must be absolute, got: "${output.conflicts_path}"`);
  });

  test('init map-codebase emits absolute codebase_dir that resolves from a different process cwd', () => {
    const codebaseDir = path.join(projectDir, '.planning', 'codebase');
    fs.mkdirSync(codebaseDir, { recursive: true });
    fs.writeFileSync(path.join(codebaseDir, 'STACK.md'), '# Stack');

    const result = runGsdTools(['init', 'map-codebase', '--cwd', projectDir], decoyDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok('codebase_dir' in output, 'cmdInitMapCodebase must emit codebase_dir (#2376)');
    assert.ok(path.isAbsolute(output.codebase_dir), `codebase_dir must be absolute, got: "${output.codebase_dir}"`);
    assert.ok(fs.existsSync(output.codebase_dir), `codebase_dir must resolve to the real directory: "${output.codebase_dir}"`);
  });

  // allow-test-rule: source-text-is-the-product (see #2376)
  test('gsd-core/workflows/verify-work.md plan_gap_closure step references {state_path}/{roadmap_path}, not bare .planning literals', () => {
    const wfPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'verify-work.md');
    const content = fs.readFileSync(wfPath, 'utf8');
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own workflow .md content, fixed-size author-controlled content
    const stepMatch = content.match(/<step name="plan_gap_closure">[\s\S]*?<\/step>/);
    assert.ok(stepMatch, 'plan_gap_closure step should exist in verify-work.md');
    const step = stepMatch[0];
    assert.ok(step.includes('{state_path}'), 'plan_gap_closure must reference {state_path} from init JSON, not a bare literal');
    assert.ok(step.includes('{roadmap_path}'), 'plan_gap_closure must reference {roadmap_path} from init JSON, not a bare literal');
    assert.ok(!step.includes('.planning/STATE.md'), 'plan_gap_closure must not hardcode .planning/STATE.md (#2376)');
    assert.ok(!step.includes('.planning/ROADMAP.md'), 'plan_gap_closure must not hardcode .planning/ROADMAP.md (#2376)');
  });

  // allow-test-rule: source-text-is-the-product (see #2376)
  test('gsd-core/workflows/diagnose-issues.md debug agent spawn references {state_path}, not a bare .planning literal', () => {
    const wfPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'diagnose-issues.md');
    const content = fs.readFileSync(wfPath, 'utf8');
    assert.ok(content.includes('{state_path}'), 'debug agent spawn must reference {state_path} from init JSON, not a bare literal');
    assert.ok(!content.includes('.planning/STATE.md'), 'debug agent spawn must not hardcode .planning/STATE.md (#2376)');
  });

  // allow-test-rule: source-text-is-the-product (see #2376)
  test('gsd-core/workflows/execute-phase.md verify_phase_goal step references {requirements_path}, not a bare .planning literal', () => {
    const wfPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'execute-phase.md');
    const content = fs.readFileSync(wfPath, 'utf8');
    // eslint-disable-next-line local/no-unbounded-quantifier -- parses this repo's own workflow .md content, fixed-size author-controlled content
    const stepMatch = content.match(/<step name="verify_phase_goal">[\s\S]*?<\/step>/);
    assert.ok(stepMatch, 'verify_phase_goal step should exist in execute-phase.md');
    const step = stepMatch[0];
    assert.ok(step.includes('{requirements_path}'), 'verify_phase_goal must reference {requirements_path} from init JSON, not a bare literal');
    assert.ok(!step.includes('.planning/REQUIREMENTS.md'), 'verify_phase_goal must not hardcode .planning/REQUIREMENTS.md (#2376)');
  });

  // allow-test-rule: source-text-is-the-product (see #2376)
  //
  // Checks verbatim presence of the exact edited <required_reading>/output blocks
  // rather than scanning the whole file for absence of the old literals: several
  // of those literals (e.g. .planning/PROJECT.md, .planning/config.json) remain
  // legitimately elsewhere in this file in orchestrator-local bash/doc-table
  // text that never reaches a spawned subagent — only the three specific
  // Agent(prompt=...) blocks touched by #2376 needed to change.
  test('gsd-core/workflows/new-project.md synthesizer/roadmapper spawns reference {research_dir}/{project_path}/{requirements_path}/{roadmap_path}/{config_path}, not bare .planning literals', () => {
    const wfPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'new-project.md');
    const content = fs.readFileSync(wfPath, 'utf8');

    assert.ok(content.includes(
      '<required_reading>\n- {research_dir}/STACK.md\n- {research_dir}/FEATURES.md\n- {research_dir}/ARCHITECTURE.md\n- {research_dir}/PITFALLS.md\n</required_reading>'
    ), 'research-synthesizer spawn must read from {research_dir}, not bare .planning/research/*.md literals');
    assert.ok(content.includes('Write to: {research_dir}/SUMMARY.md'),
      'research-synthesizer spawn must write to {research_dir}/SUMMARY.md, not a bare literal');

    assert.ok(content.includes(
      '<required_reading>\n- {project_path} (Project context)\n- {requirements_path} (v1 Requirements)\n- {research_dir}/SUMMARY.md (Research findings - if exists)\n- {config_path} (Granularity and mode settings)\n</required_reading>'
    ), 'roadmapper spawn must read from {project_path}/{requirements_path}/{research_dir}/{config_path}, not bare .planning literals');

    assert.ok(content.includes(
      '<required_reading>\n  - {roadmap_path} (Current roadmap to revise)\n  </required_reading>'
    ), 'roadmapper revision spawn must read {roadmap_path}, not a bare .planning/ROADMAP.md literal');
  });

  // allow-test-rule: source-text-is-the-product (see #2376)
  test('gsd-core/workflows/new-milestone.md synthesizer/roadmapper spawns reference {research_dir}/{project_path}/{requirements_path}/{config_path}/{milestones_path}, not bare .planning literals', () => {
    const wfPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'new-milestone.md');
    const content = fs.readFileSync(wfPath, 'utf8');

    assert.ok(content.includes(
      '<required_reading>\n- {research_dir}/STACK.md\n- {research_dir}/FEATURES.md\n- {research_dir}/ARCHITECTURE.md\n- {research_dir}/PITFALLS.md\n</required_reading>'
    ), 'research-synthesizer spawn must read from {research_dir}, not bare .planning/research/*.md literals');
    assert.ok(content.includes('Write to: {research_dir}/SUMMARY.md'),
      'research-synthesizer spawn must write to {research_dir}/SUMMARY.md, not a bare literal');

    assert.ok(content.includes(
      '<required_reading>\n- {project_path}\n- {requirements_path}\n- {research_dir}/SUMMARY.md (if exists)\n- {config_path}\n- {milestones_path}\n</required_reading>'
    ), 'roadmapper spawn must read from {project_path}/{requirements_path}/{research_dir}/{config_path}/{milestones_path}, not bare .planning literals');
  });

  // allow-test-rule: source-text-is-the-product (see #2376)
  test('gsd-core/workflows/ingest-docs.md classifier/synthesizer/roadmapper spawns reference {intel_dir}/{conflicts_path}/{project_path}/{requirements_path}/{roadmap_path}/{state_path}, not bare .planning literals', () => {
    const wfPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'ingest-docs.md');
    const content = fs.readFileSync(wfPath, 'utf8');

    assert.ok(content.includes('`OUTPUT_DIR` — `{intel_dir}/classifications`'),
      'gsd-doc-classifier spawn OUTPUT_DIR must reference {intel_dir}, not a bare .planning/intel/classifications/ literal');

    assert.ok(content.includes(
      'CLASSIFICATIONS_DIR: {intel_dir}/classifications\n    INTEL_DIR: {intel_dir}\n    CONFLICTS_PATH: {conflicts_path}'
    ), 'gsd-doc-synthesizer spawn must reference {intel_dir}/{conflicts_path}, not bare .planning literals');

    assert.ok(content.includes(
      'Intel: {intel_dir}/SYNTHESIS.md (entry point)\n    Per-type intel: {intel_dir}/decisions.md, {intel_dir}/requirements.md, {intel_dir}/constraints.md, {intel_dir}/context.md'
    ), 'gsd-roadmapper spawn must reference {intel_dir}, not bare .planning/intel/*.md literals');

    assert.ok(content.includes(
      'Produce:\n    - {project_path}\n    - {requirements_path}\n    - {roadmap_path}\n    - {state_path}'
    ), 'gsd-roadmapper spawn Produce block must reference absolute path fields, not bare .planning literals');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3057 B3: cmdInitVerifyWork surfaces an indeterminate staleness check
//
// buildPhaseCompletionProjection (init.cts) projects readVerificationStatus's
// result into phase_completion — a workflow step reads phase_completion.*
// fields directly. Pre-#3057 B3 wiring, `staleCheckIndeterminate` was
// computed by readVerificationStatus but dropped here, so a workflow could
// never distinguish "checked; nothing is stale" from "could not check".
// ─────────────────────────────────────────────────────────────────────────────

describe('#3057 B3: cmdInitVerifyWork — verification staleness-check indeterminate is surfaced', () => {
  const initMod = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'init.cjs'));
  let projectDir;

  beforeEach(() => {
    projectDir = createFixture();
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  /**
   * In-process capture of cmdInitVerifyWork's stdout JSON, stderr discarded.
   *
   * io.cts's `output()` writes via `writeAllSync` → `fs.writeSync(1, ...)`
   * directly (bug #1008's non-blocking-pipe fix), NOT `process.stdout.write`
   * — so mocking `process.stdout.write` here silently captures nothing and
   * every assertion below saw `JSON.parse('')` ("Unexpected end of JSON
   * input") regardless of what cmdInitVerifyWork actually produced. The fix
   * is the fd-level seam tests/io.test.cjs already established for exactly
   * this function (bug #1008's `t.mock.method(fs, 'writeSync', ...)`
   * pattern): intercept fd 1, discard fd 2, and pass every OTHER fd through
   * to the real writeSync — any code path that opens its own fd (e.g. a
   * lock file) must still actually write, not be silently swallowed as if
   * it were stdout.
   */
  function captureInitVerifyWork(t, cwd, phase) {
    const captured = captureFdSync(1, () => initMod.cmdInitVerifyWork(cwd, phase, false));
    assert.ok(captured.length > 0, 'cmdInitVerifyWork produced no stdout output');
    return captured;
  }

  function seedVerifiedPhase() {
    seedPhase(projectDir, '03-api', {
      '03-01-PLAN.md': '# Plan',
      '03-01-SUMMARY.md': '# Summary',
      '03-VERIFICATION.md': '---\nstatus: passed\n---\n\n# Verification\n',
    });
    fs.writeFileSync(path.join(projectDir, '.planning', 'STATE.md'), '# State\n');
    fs.writeFileSync(path.join(projectDir, '.planning', 'ROADMAP.md'), '# Roadmap\n');
    const phaseDir = path.join(projectDir, '.planning', 'phases', '03-api');
    const summaryPath = path.join(phaseDir, '03-01-SUMMARY.md');
    const verificationPath = path.join(phaseDir, '03-VERIFICATION.md');
    // Deterministic mtime ordering (never rely on write-order clock ties):
    // verification strictly newer than the summary → a completed check finds
    // nothing stale.
    const older = new Date('2026-01-01T00:00:00.000Z');
    const newer = new Date('2026-01-01T00:01:00.000Z');
    fs.utimesSync(summaryPath, older, older);
    fs.utimesSync(verificationPath, newer, newer);
    return { summaryPath, verificationPath };
  }

  test('an fs failure inside the staleness check sets phase_completion.verification_stale_check_indeterminate:true', (t) => {
    const { summaryPath, verificationPath } = seedVerifiedPhase();
    const origStatSync = fs.statSync;

    t.mock.method(fs, 'statSync', function injectedStaleCheckFault(target, ...args) {
      const targetPath = String(target);
      if (targetPath === verificationPath || targetPath === summaryPath) {
        throw new Error('injected stat failure (#3057 B3)');
      }
      return origStatSync.call(fs, target, ...args);
    });

    const output = JSON.parse(captureInitVerifyWork(t, projectDir, '03'));

    // Pre-existing no-throw fail-open routing is UNCHANGED: status still
    // resolves to 'passed' exactly as it would without the injected fault.
    assert.strictEqual(output.phase_completion.verification_status, 'passed');
    assert.strictEqual(output.phase_completion.verification_stale_check_indeterminate, true);
  });

  test('a completed staleness check that finds nothing stale reports verification_stale_check_indeterminate:false', (t) => {
    seedVerifiedPhase();

    const output = JSON.parse(captureInitVerifyWork(t, projectDir, '03'));

    assert.strictEqual(output.phase_completion.verification_status, 'passed');
    assert.strictEqual(output.phase_completion.verification_stale_check_indeterminate, false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3885 (ADR-3473 §8.5) / item 5 — cmdInitPlanPhase / cmdInitPhaseOp swallow an
// unreadable phase directory into "none of the conditional fields resolved",
// indistinguishable from a phase directory that genuinely has no
// CONTEXT.md/RESEARCH.md/VERIFICATION.md/UAT.md/REVIEWS.md/PATTERNS.md.
//
// Mechanism (src/init.cts, both cmdInitPlanPhase and cmdInitPhaseOp):
//   try { const files = fs.readdirSync(phaseDirFull); ... }
//   catch { /* intentionally empty */ }
// guarded by `if (phaseInfo?.['directory'])` — the directory was already
// resolved to exist on disk, so a caught error here is never a genuine
// "phase has no directory yet" absence.
//
// Both commands gain `context_read_error` on their result: absent (key
// omitted, matching prior shape) when readdirSync succeeds or fails with
// ENOENT (a genuine race — the directory vanished after resolution, and
// stays a silent degrade like the prior behavior); a message naming the
// phase directory on any other errno (EACCES/EIO/...).
//
// Neither command returns its result object (`output(result, raw)` writes
// via `fs.writeSync(1, ...)` — see the cmdInitVerifyWork capture helper
// above for why `process.stdout.write` cannot see it), and both are
// exercised through the real CLI dispatcher elsewhere in this file via
// `runGsdTools`, a real subprocess a parent-process fs monkeypatch cannot
// reach — so these drive the exported functions directly, in-process,
// mirroring the cmdInitVerifyWork capture pattern immediately above.
// Injected via `t.mock.method(fs, 'readdirSync', ...)` (auto-restored) —
// NEVER chmod 0o000, which root bypasses with zero coverage.
describe('#3885 (ADR-3473 §8.5): init callers distinguish unreadable from absent phase directories', () => {
  const initMod = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'init.cjs'));
  let projectDir;

  beforeEach(() => {
    projectDir = createFixture();
    seedPhase(projectDir, '03-api', {
      '03-01-PLAN.md': '# Plan',
    });
    writePlanningDocs(projectDir);
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  function captureFd1(t, run) {
    const captured = captureFdSync(1, run);
    assert.ok(captured.length > 0, 'command produced no stdout output');
    return JSON.parse(captured);
  }

  function injectReaddirFailure(t, targetPath, code) {
    const resolved = path.resolve(targetPath);
    const origReaddirSync = fs.readdirSync.bind(fs);
    t.mock.method(fs, 'readdirSync', (p, ...rest) => {
      if (path.resolve(String(p)) === resolved) {
        const err = new Error(`${code}: simulated failure, scandir '${p}'`);
        err.code = code;
        throw err;
      }
      return origReaddirSync(p, ...rest);
    });
  }

  const phaseDirAbs = () => path.join(projectDir, '.planning', 'phases', '03-api');

  describe('cmdInitPlanPhase', () => {
    // #4014 (epic #3473 B4-unreadable) matrix row 14: a readable, genuinely
    // context-less phase dir reports context_scope 'complete' — the
    // additive scope signal adjacent to has_context.
    test('readablePhaseDirReportsNoReadError (MUST STAY GREEN)', (t) => {
      const output = captureFd1(t, () => initMod.cmdInitPlanPhase(projectDir, '03', false));
      assert.strictEqual(output.context_read_error ?? null, null);
      assert.strictEqual(output.context_scope, 'complete');
    });

    // #4014 matrix row 13: has_context stays false AND context_scope
    // distinguishes this from genuine absence.
    test('unreadablePhaseDirIsNotReportedAsAbsent', (t) => {
      injectReaddirFailure(t, phaseDirAbs(), 'EACCES');
      const output = captureFd1(t, () => initMod.cmdInitPlanPhase(projectDir, '03', false));
      assert.strictEqual(typeof output.context_read_error, 'string',
        `an unreadable phase directory must be reported, not silently absent; got: ${JSON.stringify(output.context_read_error)}`);
      assert.ok(output.context_read_error.includes('03-api'),
        `the reported error must name the discarded input (the phase directory); got: ${output.context_read_error}`);
      assert.strictEqual(output.has_context, false);
      assert.strictEqual(output.context_scope, 'unreadable',
        `an unreadable phase directory must report context_scope 'unreadable', distinct from a genuinely empty one; got: ${output.context_scope}`);
    });

    test('raceConditionEnoentStaysAGenuineSilentDegrade (MUST STAY GREEN)', (t) => {
      injectReaddirFailure(t, phaseDirAbs(), 'ENOENT');
      const output = captureFd1(t, () => initMod.cmdInitPlanPhase(projectDir, '03', false));
      assert.strictEqual(output.context_read_error ?? null, null,
        `ENOENT must stay a silent degrade (genuine race), not reported as an error; got: ${output.context_read_error}`);
    });
  });

  describe('cmdInitPhaseOp', () => {
    // #4014 matrix row 14 (second surface).
    test('readablePhaseDirReportsNoReadError (MUST STAY GREEN)', (t) => {
      const output = captureFd1(t, () => initMod.cmdInitPhaseOp(projectDir, '03', false));
      assert.strictEqual(output.context_read_error ?? null, null);
      assert.strictEqual(output.context_scope, 'complete');
    });

    // #4014 matrix row 13 (second surface).
    test('unreadablePhaseDirIsNotReportedAsAbsent', (t) => {
      injectReaddirFailure(t, phaseDirAbs(), 'EACCES');
      const output = captureFd1(t, () => initMod.cmdInitPhaseOp(projectDir, '03', false));
      assert.strictEqual(typeof output.context_read_error, 'string',
        `an unreadable phase directory must be reported, not silently absent; got: ${JSON.stringify(output.context_read_error)}`);
      assert.ok(output.context_read_error.includes('03-api'),
        `the reported error must name the discarded input (the phase directory); got: ${output.context_read_error}`);
      assert.strictEqual(output.has_context, false);
      assert.strictEqual(output.context_scope, 'unreadable',
        `an unreadable phase directory must report context_scope 'unreadable', distinct from a genuinely empty one; got: ${output.context_scope}`);
    });

    test('raceConditionEnoentStaysAGenuineSilentDegrade (MUST STAY GREEN)', (t) => {
      injectReaddirFailure(t, phaseDirAbs(), 'ENOENT');
      const output = captureFd1(t, () => initMod.cmdInitPhaseOp(projectDir, '03', false));
      assert.strictEqual(output.context_read_error ?? null, null,
        `ENOENT must stay a silent degrade (genuine race), not reported as an error; got: ${output.context_read_error}`);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// roadmap analyze command
// ─────────────────────────────────────────────────────────────────────────────


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3491-nested-git-worktree.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3491-nested-git-worktree (consolidation epic #1969 B6 #1975)", () => {
// allow-test-rule: source-text-is-the-product (see #3491)
// Bug #3491 — new-project workflow creates nested .git in subdirectory when
// parent already has git repo.
//
// The workflow's `has_git` boolean was derived from `pathExists(cwd, '.git')`
// — a shallow check that only sees a `.git` entry directly in the current
// directory. Subdirectories of an existing git worktree therefore reported
// `has_git: false`, causing the workflow's `git init` step to create a nested
// `.git` inside the outer repo's worktree. Subsequent gsd-sdk commits then
// targeted the nested repo instead of the outer one, silently dropping all
// planning artefacts from the outer repo's history.
//
// This test asserts the corrected semantics, mirroring `git rev-parse
// --is-inside-work-tree`:
//
//   - `has_git: true` is reported whenever the cwd is inside a git worktree,
//     even when no `.git` entry is in cwd itself.
//   - The init payload surfaces `git_worktree_root` and `in_nested_subdir` so
//     the workflow can warn the user and skip `git init`.
//   - The workflow markdown's `git init` step is gated on
//     `in_nested_subdir: false`, never unconditional under `has_git: false`.

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runGsdTools, cleanup } = require('./helpers.cjs');
const { gitOrThrow } = require('./helpers/git-fixture.cjs');

const WORKFLOW_PATH = path.join(
  __dirname,
  '..',
  'gsd-core',
  'workflows',
  'new-project.md',
);

// ─── Helper: create outer git repo with a nested workstream subdir ─────────

// On Windows the runtime emits forward slashes (git's convention) while
// path.join produces backslashes — normalize both sides via the shared
// toPosixPath helper before any equality comparison.
const { toPosixPath: normalizePath } = require('./helpers.cjs');

function createOuterRepoWithSubdir(prefix = 'bug-3491-') {
  const outer = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  // macOS /tmp -> /private/tmp; on Windows the runner's %TEMP% is the 8.3
  // short-name (RUNNER~1) and the runtime resolves to the long form.
  // realpathSync.native handles both; then normalize separators for compare.
  const outerReal = fs.realpathSync.native(outer);
  gitOrThrow(['init'], { cwd: outerReal });
  gitOrThrow(['config', 'user.email', 'test@test.com'], { cwd: outerReal });
  gitOrThrow(['config', 'user.name', 'Test'], { cwd: outerReal });
  gitOrThrow(['config', 'commit.gpgsign', 'false'], { cwd: outerReal });
  fs.writeFileSync(path.join(outerReal, 'README.md'), '# outer\n');
  gitOrThrow(['add', '-A'], { cwd: outerReal });
  gitOrThrow(['commit', '-m', 'initial'], { cwd: outerReal });

  const subdir = path.join(outerReal, 'workstreams', 'my-project');
  fs.mkdirSync(subdir, { recursive: true });
  return { outer: outerReal, subdir };
}

// ─── Behavioural tests against the live `init new-project` handler ─────────

test('bug-3491: init new-project reports has_git: true inside parent git worktree', () => {
  const { outer, subdir } = createOuterRepoWithSubdir();
  try {
    const result = runGsdTools('init new-project', subdir);
    assert.ok(result.success, `init new-project failed: ${result.error}`);

    const payload = JSON.parse(result.output);

    // Core fix: shallow `.git in cwd` check was wrong — we are inside the
    // outer worktree, so the workflow MUST see has_git: true.
    assert.strictEqual(
      payload.has_git,
      true,
      'expected has_git=true when cwd is inside an existing git worktree (parent .git)',
    );

    // The workflow needs the worktree root and a nesting flag to decide
    // whether to skip `git init` and emit a friendly warning.
    assert.strictEqual(
      normalizePath(payload.git_worktree_root),
      normalizePath(outer),
      `expected git_worktree_root to be the outer repo (${outer}), got: ${payload.git_worktree_root}`,
    );
    assert.strictEqual(
      payload.in_nested_subdir,
      true,
      'expected in_nested_subdir=true when cwd is a subdirectory of the worktree root',
    );
  } finally {
    cleanup(outer);
  }
});

test('bug-3491: init new-project reports has_git: true at worktree root with in_nested_subdir: false', () => {
  const { outer } = createOuterRepoWithSubdir();
  try {
    const result = runGsdTools('init new-project', outer);
    assert.ok(result.success, `init new-project failed: ${result.error}`);

    const payload = JSON.parse(result.output);
    assert.strictEqual(payload.has_git, true, 'has_git must be true at the worktree root');
    assert.strictEqual(normalizePath(payload.git_worktree_root), normalizePath(outer));
    assert.strictEqual(
      payload.in_nested_subdir,
      false,
      'at the worktree root, in_nested_subdir must be false',
    );
  } finally {
    cleanup(outer);
  }
});

test('bug-3491: init new-project reports has_git: false outside any git worktree', () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'bug-3491-bare-')));
  try {
    const result = runGsdTools('init new-project', tmp);
    assert.ok(result.success, `init new-project failed: ${result.error}`);
    const payload = JSON.parse(result.output);
    assert.strictEqual(payload.has_git, false);
    assert.strictEqual(payload.in_nested_subdir, false);
    assert.strictEqual(payload.git_worktree_root, null);
  } finally {
    cleanup(tmp);
  }
});

test('bug-3491: init ingest-docs mirrors the same has_git semantics', () => {
  // ingest-docs.md has the same shallow check and the same nested-init risk.
  const { outer, subdir } = createOuterRepoWithSubdir('bug-3491-ingest-');
  try {
    const result = runGsdTools('init ingest-docs', subdir);
    assert.ok(result.success, `init ingest-docs failed: ${result.error}`);
    const payload = JSON.parse(result.output);
    assert.strictEqual(
      payload.has_git,
      true,
      'init ingest-docs must also detect parent worktree (#3491 related path)',
    );
    assert.strictEqual(normalizePath(payload.git_worktree_root), normalizePath(outer));
    assert.strictEqual(payload.in_nested_subdir, true);
  } finally {
    cleanup(outer);
  }
});

// ─── Workflow-text test: the deployed `new-project.md` must gate `git init` ─

test('bug-3491: new-project.md gates `git init` on in_nested_subdir, not just has_git', () => {
  const content = fs.readFileSync(WORKFLOW_PATH, 'utf-8');

  // The pre-fix workflow had the literal sequence:
  //
  //   **If `has_git` is false:** Initialize git:
  //   ```bash
  //   git init
  //   ```
  //
  // …which fires for any subdirectory of an existing repo. The fix must
  // either gate the init on `in_nested_subdir`/worktree-root semantics or
  // drop the unconditional `git init` block entirely.
  const unconditionalInitPattern =
    /\*\*If `has_git` is false:\*\* Initialize git:\s*\r?\n+```bash\s*\r?\ngit init\s*\r?\n```/;
  assert.ok(
    !unconditionalInitPattern.test(content),
    'new-project.md must not run `git init` unconditionally on has_git=false (#3491). ' +
      'Gate it on `in_nested_subdir === false` so the workflow refuses to create ' +
      'a nested .git inside an existing worktree.',
  );

  // The fixed workflow MUST mention the new field so reviewers can see the
  // gating exists. (Workflow markdown IS the deployed product — testing it
  // as text is the only end-to-end signal we have.)
  assert.ok(
    /in_nested_subdir/.test(content),
    'new-project.md must reference `in_nested_subdir` after the #3491 fix',
  );
});
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Folded from tests/init-section-manifest.test.cjs — #2932 (epic #1671 Phase 5)
// ─────────────────────────────────────────────────────────────────────────────
//
// init CLI negative matrix for `section_manifest`. Covers
// `.gsd/phase/chore-2932-init-section-manifest/50-test-matrix.md` section E
// (rows 42-59) plus row 62. Drives the REAL CLI through the dispatch seam
// (`spawnSync(process.execPath, [...])` with argv ARRAYS — never shell strings) so
// hostile inputs (rows 55/56) prove no shell interpolation and no path escape.
//
// Each test asserts: exit status, structured JSON result, absence of project-tree
// fs mutation, and no stack trace in non-debug stderr — never substring-matching
// rendered prose (local/no-source-grep).

describe('init section manifest', () => {
  const GSD_ROOT = path.join(__dirname, '..', 'gsd-core');
  const COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');

  // ── Drivers ─────────────────────────────────────────────────────────────

  /**
   * Invokes the real CLI dispatch seam with an argv ARRAY (never a shell string),
   * so shell metacharacters in an argument (rows 55/56) can never be interpreted
   * by a shell — spawnSync with an array bypasses the shell entirely. Always runs
   * with GSD_JSON_ERRORS=1 so an error path yields a typed `{ ok, reason, message }`
   * envelope instead of prose, per CONTRIBUTING.md "Prohibited: Raw Text Matching".
   */
  function runSectionManifestCli(args, cwd, env = {}) {
    const result = spawnSync(process.execPath, [TOOLS_PATH, 'query', ...args], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, GSD_JSON_ERRORS: '1', ...env },
      timeout: 30000,
    });
    let stdout = result.stdout || '';
    // output() spills payloads over 50KB to a tmpfile and prints "@file:<path>"
    // (src/io.cts) — dereference it exactly as the workflow itself does.
    if (stdout.startsWith('@file:')) {
      stdout = fs.readFileSync(stdout.slice('@file:'.length).trim(), 'utf8');
    }
    return { status: result.status, stdout, stderr: result.stderr || '' };
  }

  function runExecutePhase(phaseArgs, cwd, env = {}) {
    return runSectionManifestCli(['init.execute-phase', ...phaseArgs], cwd, env);
  }

  function parseOkJson(result, label) {
    assert.equal(result.status, 0, `${label}: expected exit 0, got ${result.status} (stderr: ${result.stderr})`);
    assertNoStackTrace(result.stderr, label);
    return JSON.parse(result.stdout);
  }

  function parseErrorJson(result, label) {
    assert.notEqual(result.status, 0, `${label}: expected non-zero exit`);
    assertNoStackTrace(result.stderr, label);
    return JSON.parse(result.stderr);
  }

  /** Node stack-trace frames look like "\n    at fn (file:line:col)" — a structural
   * signal, not a content match on any file's prose. */
  function assertNoStackTrace(text, label) {
    assert.ok(!/\n\s+at\s+\S+/.test(text || ''), `${label}: unexpected stack trace: ${text}`);
  }

  /** Recursive, sorted snapshot of a directory's structure — name/size/mtime triples,
   * used to assert a read-only `query` command mutates nothing under the project tree. */
  function snapshotSectionManifestTree(dir) {
    const out = [];
    function walk(d, rel) {
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) {
          out.push(`D:${relPath}`);
          walk(full, relPath);
        } else {
          const st = fs.statSync(full);
          out.push(`F:${relPath}:${st.size}`);
        }
      }
    }
    walk(dir, '');
    return out;
  }

  function seedSinglePhaseProject(t, prefix) {
    const dir = createTempProject(prefix);
    t.after(() => cleanup(dir));
    seedPhase(dir, '01-widgets', {});
    return dir;
  }

  // ── E42-43: baseline manifest emission, with/without --wave ─────────────

  describe('init execute-phase: section_manifest emission (#2932)', () => {
    test('emitsSectionManifestWithoutWaveFlag', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-e42-');
      const before = snapshotSectionManifestTree(dir);
      const body = parseOkJson(runExecutePhase(['1'], dir), 'no-flag');
      assert.deepStrictEqual(snapshotSectionManifestTree(dir), before, 'query command must not mutate the project tree');

      assert.ok(body.section_manifest, 'section_manifest must be present');
      assert.equal(body.section_manifest.workflow, 'execute-phase');
      assert.ok(!body.section_manifest.included.includes('partial-wave'), 'partial-wave must be excluded without --wave');
      assert.ok(body.section_manifest.excluded.includes('partial-wave'));
      assert.deepStrictEqual(body.section_manifest.read, []);
    });

    test('emitsSectionManifestIncludingPartialWaveWithWaveFlag (#2932 headline acceptance criterion)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-e43-');
      const body = parseOkJson(runExecutePhase(['1', '--wave', '1'], dir), 'with-wave');

      assert.ok(body.section_manifest);
      assert.deepStrictEqual(body.section_manifest.included, ['partial-wave']);
      assert.ok(!body.section_manifest.excluded.includes('partial-wave'));
      assert.deepStrictEqual(body.section_manifest.read, [
        'gsd-core/workflows/execute-phase/steps/partial-wave.md',
      ]);
    });

    test('#3511-class: regression-gate (state:has-prior-phases) ignores a misplaced VERIFICATION.md that belongs to another phase', (t) => {
      const dir = createTempProject('gsd-3511-hasprior-');
      t.after(() => cleanup(dir));
      // Phase 01 is the one being executed.
      seedPhase(dir, '01-widgets', {});
      // Phase 02's directory holds ONLY a stray artifact whose filename
      // token ("05-") belongs to phase 05, not to this directory's own
      // phase (02) — it must not make phase 02 look like it has its own
      // verification report.
      seedPhase(dir, '02-other', { '05-VERIFICATION.md': '# Verification for phase 05' });

      const body = parseOkJson(runExecutePhase(['1'], dir), 'stray-verification');

      assert.ok(body.section_manifest, 'section_manifest must be present');
      assert.ok(!body.section_manifest.included.includes('regression-gate'),
        'regression-gate must not be included when no OTHER phase has its own verification');
      assert.ok(body.section_manifest.excluded.includes('regression-gate'));
    });
  });

  // ── E44-46: phase argument boundary ────────────────────────────────────

  describe('init execute-phase: phase argument boundary (#2932)', () => {
    test('failsWhenPhaseArgumentMissing', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-e44-');
      const err = parseErrorJson(runExecutePhase([], dir), 'missing-phase');
      assert.equal(err.ok, false);
      assert.equal(typeof err.reason, 'string');
      assert.equal(typeof err.message, 'string');
    });

    test('failsOnEmptyPhaseArgument', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-e45-');
      const err = parseErrorJson(runExecutePhase([''], dir), 'empty-phase');
      assert.equal(err.ok, false);
    });

    test('failsOnWhitespaceOnlyPhaseArgument', (t) => {
      // Test-matrix row 46 names "non-zero" as expected. Empirically, cmdInitExecutePhase's
      // guard is `if (!phase)`, which is false for a non-empty whitespace string — this
      // pre-existing idiom is SHARED by every phase-taking init subcommand (plan-phase,
      // todos, phase-op, ...), not introduced by #2932, and changing it here would be a
      // blast-radius violation of the CRITICAL routeInitCommand rating (37 affected files).
      // "   " instead falls through to guardedFindPhase, which returns no match — the same
      // graceful "not found" degrade the path-traversal/shell-metachar rows (55/56) require,
      // not a crash. This test locks the REAL, current, exit-0 "not found" behavior rather
      // than the matrix's a-priori assumption; see the dispatch report for this reconciliation.
      const dir = seedSinglePhaseProject(t, 'gsd-e46-');
      const body = parseOkJson(runExecutePhase(['   '], dir), 'whitespace-phase');
      assert.equal(body.phase_found, false);
      assert.ok(body.section_manifest, 'manifest is still emitted — it does not depend on phase_found');
    });
  });

  // ── E47-52: --wave token-presence semantics ──────────────────────────────

  describe('init execute-phase: --wave token-presence semantics (#2932)', () => {
    test('treatsValuelessWaveFlagAsPresent', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-e47-');
      const body = parseOkJson(runExecutePhase(['1', '--wave'], dir), 'valueless-wave');
      assert.deepStrictEqual(body.section_manifest.included, ['partial-wave']);
    });

    test('treatsWaveZeroAsPresent', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-e48-');
      const body = parseOkJson(runExecutePhase(['1', '--wave', '0'], dir), 'wave-zero');
      assert.deepStrictEqual(body.section_manifest.included, ['partial-wave']);
    });

    test('treatsDuplicateWaveFlagsIdempotently', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-e49-');
      const body = parseOkJson(runExecutePhase(['1', '--wave', '1', '--wave', '2'], dir), 'dup-wave');
      assert.deepStrictEqual(body.section_manifest.included, ['partial-wave']);
    });

    test('handlesMalformedWaveAssignments', (t) => {
      // Corrected after the first full verification run: neither --wave= nor
      // --wave==1 is a documented or shipped token (commands/gsd/execute-phase.md,
      // gsd-core/workflows/execute-phase.md, and the docs tree all only ever
      // emit the space-separated --wave N form) — each is an exact, distinct,
      // undeclared flag token, so ADR-3473 §8.4 mandates rejecting it outright
      // rather than silently letting it fall through unrecognized. Exit 1, and
      // — same exact-match discipline that keeps "--waves"/"--wave-filter"
      // from false-activating (row 52) — the rejection must name the
      // malformed token itself, proving it was never coerced into activating
      // --wave.
      const dir = seedSinglePhaseProject(t, 'gsd-e50-');
      for (const token of ['--wave=', '--wave==1']) {
        const result = runExecutePhase(['1', token], dir);
        assert.equal(result.status, 1, `malformed-wave:${token}: expected exit 1, got ${result.status}`);
        const err = JSON.parse(result.stderr);
        assert.match(err.message, new RegExp(escapeRegex(token)), `"${token}" must be named as the unknown flag, proving it did not activate --wave`);
      }
    });

    test('doesNotConsumeFollowingFlagAsWaveValue', (t) => {
      // Unit-level: --wave is an optionalValueFlags entry (#2932's `--wave N`
      // shape) — its cursor never swallows a following flag-shaped token as
      // its value; it advances by 1, not 2, leaving --weird for its own
      // validation. Assert the extraction directly rather than through the
      // full CLI, since --weird's own (correct) rejection below makes the
      // manifest body unreachable.
      const { parseNamedArgs } = require('../gsd-core/bin/lib/command-arg-projection.cjs');
      const extracted = parseNamedArgs(['--wave', '--weird'], { optionalValueFlags: ['wave'], positionals: 'rest' });
      assert.strictEqual(extracted.ok, true);
      assert.strictEqual(extracted.data.wave, true, '--wave must resolve to present (true), not be starved by the following token');

      // Integration: --weird is a genuinely undeclared flag on execute-phase,
      // so ADR-3473 §8.4 mandates rejecting it — exit 1, not the old exit-0
      // "ignored" shape. The rejection naming "--weird" (not "--wave") is
      // itself proof --wave did not consume it as a value.
      const dir = seedSinglePhaseProject(t, 'gsd-e51-');
      const result = runExecutePhase(['1', '--wave', '--weird'], dir);
      assert.equal(result.status, 1, `wave-then-weird: expected exit 1, got ${result.status}`);
      const err = JSON.parse(result.stderr);
      assert.match(err.message, /--weird/, 'the unknown-flag rejection must name --weird, proving --wave did not consume it as its value');
    });

    test('nearMissFlagNamesDoNotActivateWave', (t) => {
      // Corrected after the first full verification run: neither "--waves"
      // nor "--wave-filter" is documented or shipped for execute-phase, so
      // each is a genuinely undeclared flag — ADR-3473 §8.4 mandates
      // rejecting it (exit 1), not silently ignoring it. The rejection
      // naming the near-miss token itself is what proves it never
      // false-activated --wave.
      const dir = seedSinglePhaseProject(t, 'gsd-e52-');
      for (const flag of ['--waves', '--wave-filter']) {
        const result = runExecutePhase(['1', flag], dir);
        assert.equal(result.status, 1, `near-miss:${flag}: expected exit 1, got ${result.status}`);
        const err = JSON.parse(result.stderr);
        assert.match(err.message, new RegExp(escapeRegex(flag)), `"${flag}" must be named as the unknown flag, proving it did not activate --wave`);
      }
    });
  });

  // ── E53: unknown subcommand ───────────────────────────────────────────────

  describe('init dispatch: unknown subcommand (#2932 row 53)', () => {
    test('reportsUnknownInitSubcommand', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-e53-');
      const err = parseErrorJson(runSectionManifestCli(['init.frobnicate'], dir), 'unknown-subcommand');
      assert.equal(err.ok, false);
      assert.equal(err.reason, 'sdk_unknown_command');
    });
  });

  // ── E54-56: hostile inputs ────────────────────────────────────────────────

  describe('init execute-phase: hostile inputs (#2932)', () => {
    test('handlesVeryLongAndUnicodeValues', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-e54-');
      const longUnicodeValue = 'x'.repeat(20000) + '你好\u{1f600}';
      const result = runExecutePhase(['1', '--wave', longUnicodeValue], dir);
      assert.equal(result.status, 0, `expected exit 0, got ${result.status} (stderr: ${result.stderr})`);
      assertNoStackTrace(result.stderr, 'long-unicode-value');
      const body = JSON.parse(result.stdout);
      assert.deepStrictEqual(body.section_manifest.included, ['partial-wave']);

      const longPhaseResult = runExecutePhase(['1' + 'z'.repeat(20000)], dir);
      assert.equal(longPhaseResult.status, 0);
      assertNoStackTrace(longPhaseResult.stderr, 'long-phase-value');
    });

    test('doesNotInterpolateShellMetacharactersInPhase', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-e55-');
      const sentinel = path.join(dir, 'pwned-sentinel');
      const hostilePhase = `1; touch ${sentinel}; $(touch ${sentinel}) \`touch ${sentinel}\` && touch ${sentinel} || touch ${sentinel}`;
      const result = runExecutePhase([hostilePhase], dir);
      assert.equal(result.status, 0, `expected exit 0 (no shell execution), got ${result.status}`);
      assertNoStackTrace(result.stderr, 'shell-metachars');
      assert.ok(!fs.existsSync(sentinel), 'shell metacharacters in the phase argument must never be interpreted — argv array bypasses the shell entirely');
    });

    test('rejectsPathTraversalStylePhaseValue', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-e56-');
      const before = snapshotSectionManifestTree(dir);
      const body = parseOkJson(runExecutePhase(['../../../../etc/passwd'], dir), 'path-traversal');
      assert.deepStrictEqual(snapshotSectionManifestTree(dir), before, 'no fs mutation from a traversal-shaped phase value');
      assert.equal(body.phase_found, false, 'a traversal-shaped value must never resolve to a real phase');
      assert.ok(
        !String(body.phase_dir || '').includes('etc/passwd'),
        'phase_dir must never resolve outside the project tree',
      );
    });
  });

  // ── E57-58: degraded path — manifest artifact missing/malformed ─────────

  describe('init execute-phase: section_manifest degrades to null (#2932)', () => {
    test('degradesToNullManifestWhenArtifactMissing', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-e57-');
      const missingPath = path.join(dir, 'does-not-exist-section-manifest.json');
      const result = runExecutePhase(['1'], dir, { GSD_SECTION_MANIFEST: missingPath });
      assert.equal(result.status, 0, `expected exit 0 despite missing manifest artifact, got ${result.status} (stderr: ${result.stderr})`);
      assertNoStackTrace(result.stderr, 'manifest-missing');
      const body = JSON.parse(result.stdout);
      assert.equal(body.section_manifest, null);
    });

    test('degradesToNullManifestWhenArtifactMalformed', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-e58-');
      const badPath = path.join(dir, 'bad-section-manifest.json');
      fs.writeFileSync(badPath, '{ this is not valid json');
      const result = runExecutePhase(['1'], dir, { GSD_SECTION_MANIFEST: badPath });
      assert.equal(result.status, 0, `expected exit 0 despite malformed manifest artifact, got ${result.status} (stderr: ${result.stderr})`);
      assertNoStackTrace(result.stderr, 'manifest-malformed');
      const body = JSON.parse(result.stdout);
      assert.equal(body.section_manifest, null);
    });

    test('degradesToNullManifestWhenArtifactWrongShape', (t) => {
      // Extends row 58: valid JSON, wrong shape (design doc + init.cts loadSectionManifestSections
      // both name this as a degraded case distinct from "not JSON at all").
      const dir = seedSinglePhaseProject(t, 'gsd-e58b-');
      const wrongShapePath = path.join(dir, 'wrong-shape-section-manifest.json');
      fs.writeFileSync(wrongShapePath, JSON.stringify([1, 2, 3]));
      const result = runExecutePhase(['1'], dir, { GSD_SECTION_MANIFEST: wrongShapePath });
      assert.equal(result.status, 0);
      const body = JSON.parse(result.stdout);
      assert.equal(body.section_manifest, null);
    });

    // ── C4 (#2992): stale FLAT pre-6.1 artifact must degrade to null and
    // never be mis-attributed to any workflow — the upgrade-path row.

    test('staleFlatPreWideningArtifactDegradesToNull (row C4)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-c4-');
      const flatPath = path.join(dir, 'flat-section-manifest.json');
      // The pre-#2932-Phase-6.1 shape: a single top-level `sections` array,
      // no `workflows` key at all. It even NAMES an execute-phase-shaped
      // section, so a mis-attribution bug would silently "work".
      fs.writeFileSync(
        flatPath,
        JSON.stringify({
          sections: [{ id: 'partial-wave', when: 'flag:--wave', read: 'gsd-core/workflows/execute-phase/steps/partial-wave.md' }],
        }),
      );
      const result = runExecutePhase(['1', '--wave', '1'], dir, { GSD_SECTION_MANIFEST: flatPath });
      assert.equal(result.status, 0, `expected exit 0 despite stale flat artifact, got ${result.status} (stderr: ${result.stderr})`);
      assertNoStackTrace(result.stderr, 'stale-flat-artifact');
      const body = JSON.parse(result.stdout);
      assert.equal(body.section_manifest, null, 'a pre-6.1 flat artifact must never be mis-parsed as some workflow\'s sections');
    });

    // ── C8 (#2992): valid JSON that is not an object — one row each.

    test('nonObjectJsonArtifactDegradesToNull (row C8)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-c8-');
      for (const hostileJson of ['0', '"str"', '[]', 'null', 'true']) {
        const hostilePath = path.join(dir, `hostile-${Buffer.from(hostileJson).toString('hex')}-section-manifest.json`);
        fs.writeFileSync(hostilePath, hostileJson);
        const result = runExecutePhase(['1'], dir, { GSD_SECTION_MANIFEST: hostilePath });
        assert.equal(result.status, 0, `hostile JSON ${hostileJson}: expected exit 0 (stderr: ${result.stderr})`);
        assertNoStackTrace(result.stderr, `hostile-json:${hostileJson}`);
        const body = JSON.parse(result.stdout);
        assert.equal(body.section_manifest, null, `hostile JSON ${hostileJson} must degrade to null`);
      }
    });

    // ── C9 (#2992): file present but 0 bytes.

    test('emptyZeroByteArtifactFileDegradesToNull (row C9)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-c9-');
      const emptyPath = path.join(dir, 'empty-section-manifest.json');
      fs.writeFileSync(emptyPath, '');
      assert.equal(fs.statSync(emptyPath).size, 0, 'sanity: fixture file must be 0 bytes');
      const result = runExecutePhase(['1'], dir, { GSD_SECTION_MANIFEST: emptyPath });
      assert.equal(result.status, 0, `expected exit 0 despite empty artifact file, got ${result.status} (stderr: ${result.stderr})`);
      assertNoStackTrace(result.stderr, 'empty-artifact-file');
      const body = JSON.parse(result.stdout);
      assert.equal(body.section_manifest, null);
    });

    // ── #2992 review finding: an unsafe `read` path degrades the WHOLE
    // load to null, exactly like every other shape violation above — the
    // field is documented as a POSIX-normalized, repo-root-RELATIVE path,
    // so an absolute path, a Windows drive/UNC prefix, or a `..` traversal
    // segment must never be trusted through to a later `fs.readFileSync`.

    test('degradesToNullWhenReadPathIsAbsolute', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-unsafe-abs-');
      const manifestPath = path.join(dir, 'unsafe-abs-section-manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify({
        workflows: { 'execute-phase': [{ id: 'x', when: 'always', read: '/etc/passwd' }] },
      }));
      const result = runExecutePhase(['1'], dir, { GSD_SECTION_MANIFEST: manifestPath });
      assert.equal(result.status, 0, `expected exit 0 despite an absolute read path, got ${result.status} (stderr: ${result.stderr})`);
      assertNoStackTrace(result.stderr, 'unsafe-read-absolute');
      const body = JSON.parse(result.stdout);
      assert.equal(body.section_manifest, null, 'an absolute `read` path must degrade the whole load to null');
    });

    test('degradesToNullWhenReadPathContainsDotDotTraversal', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-unsafe-dotdot-');
      const manifestPath = path.join(dir, 'unsafe-dotdot-section-manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify({
        workflows: { 'execute-phase': [{ id: 'x', when: 'always', read: '../../etc/passwd' }] },
      }));
      const result = runExecutePhase(['1'], dir, { GSD_SECTION_MANIFEST: manifestPath });
      assert.equal(result.status, 0, `expected exit 0 despite a ../ traversal read path, got ${result.status} (stderr: ${result.stderr})`);
      assertNoStackTrace(result.stderr, 'unsafe-read-dotdot');
      const body = JSON.parse(result.stdout);
      assert.equal(body.section_manifest, null, 'a `..` traversal segment in `read` must degrade the whole load to null');
    });

    test('degradesToNullWhenReadPathIsWindowsDriveAbsolute', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-unsafe-windrive-');
      const manifestPath = path.join(dir, 'unsafe-windrive-section-manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify({
        workflows: { 'execute-phase': [{ id: 'x', when: 'always', read: 'C:\\Windows\\System32\\config' }] },
      }));
      const result = runExecutePhase(['1'], dir, { GSD_SECTION_MANIFEST: manifestPath });
      assert.equal(result.status, 0, `expected exit 0 despite a Windows drive-absolute read path, got ${result.status} (stderr: ${result.stderr})`);
      assertNoStackTrace(result.stderr, 'unsafe-read-windrive');
      const body = JSON.parse(result.stdout);
      assert.equal(body.section_manifest, null, 'a Windows drive-absolute `read` path must degrade the whole load to null');
    });
  });

  // ── C1/C12/C16/C17 (#2992): shape guarantees on the field itself ────────

  describe('init execute-phase: section_manifest field-shape guarantees (#2992)', () => {
    test('emptySectionsArrayIsComputedNotDegraded (row C12 — present + empty is not null)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-c12-');
      const emptyWorkflowPath = path.join(dir, 'empty-workflow-section-manifest.json');
      fs.writeFileSync(emptyWorkflowPath, JSON.stringify({ workflows: { 'execute-phase': [] } }));
      const result = runExecutePhase(['1'], dir, { GSD_SECTION_MANIFEST: emptyWorkflowPath });
      assert.equal(result.status, 0, `expected exit 0, got ${result.status} (stderr: ${result.stderr})`);
      const body = JSON.parse(result.stdout);
      assert.deepStrictEqual(
        body.section_manifest,
        { workflow: 'execute-phase', included: [], excluded: [], read: [] },
        'a workflow key present with sections:[] must compute to an empty-but-present selection, never null',
      );
    });

    test('workflowAbsentFromArtifactDegradesToNullNotEmptySections (row C16 — absence is not empty)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-c16-');
      const otherWorkflowPath = path.join(dir, 'other-workflow-section-manifest.json');
      fs.writeFileSync(otherWorkflowPath, JSON.stringify({ workflows: { 'plan-phase': [{ id: 'x', when: 'always', read: 'x.md' }] } }));
      const result = runExecutePhase(['1'], dir, { GSD_SECTION_MANIFEST: otherWorkflowPath });
      assert.equal(result.status, 0);
      const body = JSON.parse(result.stdout);
      assert.equal(body.section_manifest, null, 'execute-phase has no key in this artifact — must degrade to null, never {included:[]}');
    });

    test('executePhaseSectionManifestFieldIsByteIdenticalToThePreChangeShape (row C1 — Hyrum gate)', (t) => {
      // Locks the EXACT shape execute-phase's real, shipped manifest produces
      // for a plain (no --wave, no gap-closure, no prior phases) invocation —
      // #2992 widened the vocabulary and generalized the artifact to
      // per-workflow keying, but execute-phase's own 3 real sections (all
      // pre-existing atoms) must select IDENTICALLY to before this change.
      const dir = seedSinglePhaseProject(t, 'gsd-c1-');
      const body = parseOkJson(runExecutePhase(['1'], dir), 'c1-baseline');
      assert.deepStrictEqual(body.section_manifest, {
        workflow: 'execute-phase',
        included: [],
        excluded: ['partial-wave', 'gap-closure-artifacts', 'regression-gate'],
        read: [],
      });
    });

    test('restOfTheInitBundleIsUnaffectedByEverySectionManifestDegradedCondition (row C17 — Hyrum gate)', (t) => {
      // The `section_manifest` field is additive; every OTHER field of the
      // init-bundle (22 direct dependents per the design doc's blast-radius
      // table) must be byte-identical regardless of whether the manifest
      // artifact resolves, is missing, or is malformed.
      const dir = seedSinglePhaseProject(t, 'gsd-c17-');

      const real = parseOkJson(runExecutePhase(['1'], dir), 'c17-real');
      const missingPath = path.join(dir, 'does-not-exist-c17.json');
      const missing = parseOkJson(runExecutePhase(['1'], dir, { GSD_SECTION_MANIFEST: missingPath }), 'c17-missing');
      const badPath = path.join(dir, 'bad-c17.json');
      fs.writeFileSync(badPath, '{ not valid json');
      const malformed = parseOkJson(runExecutePhase(['1'], dir, { GSD_SECTION_MANIFEST: badPath }), 'c17-malformed');

      delete real.section_manifest;
      delete missing.section_manifest;
      delete malformed.section_manifest;
      assert.deepStrictEqual(missing, real, 'every other init-bundle field must be unaffected by a missing manifest artifact');
      assert.deepStrictEqual(malformed, real, 'every other init-bundle field must be unaffected by a malformed manifest artifact');
    });
  });

  // ── D4 (#2992, prod-shape): an absent CLI flag is absent from `flags` ────
  //
  // #2992 review finding (fixed in this change, src/init-command-router.cts):
  // `parseNamedArgs`'s booleanFlags ALWAYS populate the option key (`true`
  // when the token was seen, `false` otherwise — never `undefined`).
  // `buildSectionManifestField`'s flags-Set builder (src/init.cts) treats
  // ANY non-`undefined` option value as present (matrix D2/D3, for VALUE
  // flags whose absence is `null`). Passed through unmodified, a
  // booleanFlag's own `false` ("--wave" never typed) would still have been
  // added to `flags`, making `flag:--wave` permanently true regardless of
  // the actual invocation — verified live pre-fix: `partial-wave` was
  // INCLUDED with no `--wave` on the command line at all, silently
  // defeating the gating feature this whole seam exists for. The router now
  // folds a booleanFlag's own `false` into `undefined` before it reaches
  // `buildSectionManifestField`, so this test is the regression lock for
  // that fix — it duplicates the assertion `emitsSectionManifestWithoutWaveFlag`
  // already makes, under an explicit D4 name for matrix traceability.
  //
  // D2 ("option present, value false" as a generically-present option) and
  // D3 ("option present, string value") and D6 (a hostile literal option
  // key) are NOT independently prod-shape-testable through the real CLI as
  // currently wired: `execute-phase`/`plan-phase` are the only two handlers
  // that feed router-derived options into `buildSectionManifestField`, their
  // option-key lists are FIXED literals (`validate`/`tdd`/`wave`/
  // `granularity`) never derived from user input (so a hostile key name can
  // never reach it for real), none of the 14 shipped vocabulary atoms is
  // backed by a value-taking CLI flag (so a real string-valued option can
  // never reach a `flag:` atom yet), and this fix means a booleanFlag's own
  // `false` never reaches the builder at all anymore. Synthesizing an
  // options object to force these paths would violate the matrix's own
  // "(prod-shape) rows must drive the options path" constraint, so they are
  // left unaddressed here rather than faked — surfaced for the orchestrator.
  describe('init execute-phase: undefined CLI flag is absent from flags (#2992 row D4)', () => {
    test('waveOptionAbsentWithoutTheFlagNeverActivatesPartialWave', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-d4-');
      const body = parseOkJson(runExecutePhase(['1'], dir), 'd4-no-wave');
      assert.ok(!body.section_manifest.included.includes('partial-wave'), 'an unset --wave must never leak into flags as "present"');
      assert.deepStrictEqual(body.section_manifest.excluded, ['partial-wave', 'gap-closure-artifacts', 'regression-gate']);
    });
  });

  // ── D9/D10/D11 (#2992, prod-shape): state:* detector degradation ─────────
  // Drives the REAL cmdInitExecutePhase -> buildSectionManifestField ->
  // readConfigJsonBoolean/detectPhaseMvpMode seam through the real CLI with a
  // fixture manifest naming the two config-backed atoms, never a hand-built
  // InvocationFacts (matrix note: "(prod-shape)" rows must drive the options
  // path). `seedSinglePhaseProject` writes no `.planning/config.json` and no
  // `.planning/ROADMAP.md` at all, so D9 (absent config) and D11 (absent
  // ROADMAP) are the fixture's natural, un-monkeypatched state.

  describe('init execute-phase: state:* detector degradation (#2992 rows D9-D11)', () => {
    function writeDetectorManifest(dir) {
      const manifestPath = path.join(dir, 'detector-section-manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify({
        workflows: {
          'execute-phase': [
            { id: 'worktrees-section', when: 'state:worktrees-enabled', read: 'x.md' },
            { id: 'mvp-section', when: 'state:phase-mvp-mode', read: 'y.md' },
          ],
        },
      }));
      return manifestPath;
    }

    test('absentConfigAndAbsentRoadmapDegradeBothStateAtomsToFalse (rows D9/D11)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-d9-');
      assert.equal(fs.existsSync(path.join(dir, '.planning', 'config.json')), false, 'sanity: no config.json');
      assert.equal(fs.existsSync(path.join(dir, '.planning', 'ROADMAP.md')), false, 'sanity: no ROADMAP.md');
      const manifestPath = writeDetectorManifest(dir);
      const body = parseOkJson(runExecutePhase(['1'], dir, { GSD_SECTION_MANIFEST: manifestPath }), 'd9-d11');
      assert.deepStrictEqual(body.section_manifest.excluded, ['worktrees-section', 'mvp-section']);
      assert.deepStrictEqual(body.section_manifest.included, []);
    });

    test('nonBooleanConfigValueDegradesToFalse (row D10 — strict boolean, string "true" is not true)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-d10-');
      fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ workflow: { use_worktrees: 'true' } }));
      const manifestPath = writeDetectorManifest(dir);
      const body = parseOkJson(runExecutePhase(['1'], dir, { GSD_SECTION_MANIFEST: manifestPath }), 'd10');
      assert.ok(
        body.section_manifest.excluded.includes('worktrees-section'),
        'a string "true" config value must never coerce to boolean true',
      );
    });

    test('realBooleanTrueConfigValueIncludesTheSection (independence: the strict check still accepts a real boolean)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-d10b-');
      fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ workflow: { use_worktrees: true } }));
      const manifestPath = writeDetectorManifest(dir);
      const body = parseOkJson(runExecutePhase(['1'], dir, { GSD_SECTION_MANIFEST: manifestPath }), 'd10b');
      assert.ok(body.section_manifest.included.includes('worktrees-section'));
    });
  });

  // ── #2992 review finding: state:needs-codebase-map wiring (real CLI) ─────
  //
  // No test anywhere drove `state:needs-codebase-map` (src/section-manifest.cts)
  // or its `cmdInitNewProject` override wiring (src/init.cts, `overrides.needsCodebaseMap`)
  // through the real CLI. Drives `init new-project` with a `mkdtempSync`
  // fixture manifest (via `GSD_SECTION_MANIFEST`) naming a single section
  // gated on the atom, proving inclusion/exclusion tracks the SAME
  // isBrownfield/hasCodebaseMap computation `needs_codebase_map` itself uses
  // — never mutating the shipped gsd-core/workflows/section-manifest.json.

  describe('init new-project: state:needs-codebase-map wiring (#2992 review finding)', () => {
    function writeNeedsCodebaseMapManifest(dir) {
      const manifestPath = path.join(dir, 'needs-map-section-manifest.json');
      fs.writeFileSync(manifestPath, JSON.stringify({
        workflows: {
          'new-project': [
            { id: 'needs-map-section', when: 'state:needs-codebase-map', read: 'z.md' },
          ],
        },
      }));
      return manifestPath;
    }

    test('brownfieldWithoutCodebaseMapIncludesTheGatedSection', () => {
      const dir = createTempProject('gsd-needsmap-true-');
      try {
        fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"test"}');
        const manifestPath = writeNeedsCodebaseMapManifest(dir);
        const result = runGsdTools('init new-project', dir, { GSD_SECTION_MANIFEST: manifestPath });
        assert.ok(result.success, `init new-project failed: ${result.error}`);
        const output = JSON.parse(result.output);
        assert.strictEqual(output.needs_codebase_map, true, 'sanity: fixture must be brownfield without a codebase map');
        assert.deepStrictEqual(output.section_manifest.included, ['needs-map-section']);
        assert.deepStrictEqual(output.section_manifest.excluded, []);
      } finally {
        cleanup(dir);
      }
    });

    test('greenfieldExcludesTheGatedSection', () => {
      const dir = createTempProject('gsd-needsmap-false-');
      try {
        const manifestPath = writeNeedsCodebaseMapManifest(dir);
        const result = runGsdTools('init new-project', dir, { GSD_SECTION_MANIFEST: manifestPath });
        assert.ok(result.success, `init new-project failed: ${result.error}`);
        const output = JSON.parse(result.output);
        assert.strictEqual(output.needs_codebase_map, false, 'sanity: fixture must be greenfield');
        assert.deepStrictEqual(output.section_manifest.included, []);
        assert.deepStrictEqual(output.section_manifest.excluded, ['needs-map-section']);
      } finally {
        cleanup(dir);
      }
    });

    test('brownfieldWithExistingCodebaseMapExcludesTheGatedSection', () => {
      const dir = createTempProject('gsd-needsmap-hascomap-');
      try {
        fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"test"}');
        fs.mkdirSync(path.join(dir, '.planning', 'codebase'), { recursive: true });
        for (const name of ['STACK', 'ARCHITECTURE', 'STRUCTURE', 'CONVENTIONS', 'TESTING', 'INTEGRATIONS', 'CONCERNS']) {
          fs.writeFileSync(path.join(dir, '.planning', 'codebase', `${name}.md`), `# ${name}\n`);
        }
        const manifestPath = writeNeedsCodebaseMapManifest(dir);
        const result = runGsdTools('init new-project', dir, { GSD_SECTION_MANIFEST: manifestPath });
        assert.ok(result.success, `init new-project failed: ${result.error}`);
        const output = JSON.parse(result.output);
        assert.strictEqual(output.needs_codebase_map, false, 'sanity: fixture must already have a complete codebase map');
        assert.deepStrictEqual(output.section_manifest.included, []);
        assert.deepStrictEqual(output.section_manifest.excluded, ['needs-map-section']);
      } finally {
        cleanup(dir);
      }
    });
  });

  // ── E59: independence — other init subcommands unaffected ───────────────
  //
  // #2992 (epic #1671 Phase 6.1) generalized the manifest seam from
  // execute-phase-only to per-workflow (`buildSectionManifestField` now wires
  // into `cmdInitPlanPhase`/`cmdInitNewProject`/`cmdInitNewMilestone`/
  // `cmdInitQuick`/`cmdInitProgress` too — src/init.cts:740/787/839/885/1810).
  // #2993 (epic #1671 Phase 6.2) makes the OLD assertion here doubly stale:
  // plan-phase's field is no longer `null` at all — the shipped
  // gsd-core/workflows/section-manifest.json now keys `plan-phase` too, with
  // 6 real sections (row C1). A no-flag invocation excludes every one of
  // them (none of the 5 governing flags/state were supplied). `resume` has
  // no dedicated `cmdInit*` manifest wiring at all (design's withheld-atom
  // survey), so its field truly remains absent — that half of the guard is
  // unchanged.

  describe('init dispatch: other subcommands unaffected (#2932/#2992/#2993 row 59, CRITICAL radius guard)', () => {
    test('planPhaseEmitsARealComputedManifestNotNull (#2993 — the shipped artifact now has a plan-phase key)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-e59-');

      const planPhase = parseOkJson(runSectionManifestCli(['init.plan-phase', '1'], dir), 'plan-phase');
      assert.equal(planPhase.phase_found, true);
      assert.ok('section_manifest' in planPhase, 'section_manifest field must be present for plan-phase');
      assert.deepStrictEqual(planPhase.section_manifest, {
        workflow: 'plan-phase',
        included: [],
        excluded: [
          'reviews-prerequisite',
          'prd-express-gate',
          'adr-ingest-express-path',
          'research-only-modifiers',
          'research-only-early-exit',
          'chunked-planning-mode',
        ],
        read: [],
      });
    });

    test('resumeNeverEmitsASectionManifestField', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-e59-resume-');
      const resume = parseOkJson(runSectionManifestCli(['init.resume'], dir), 'resume');
      assert.ok(!('section_manifest' in resume), 'section_manifest must never leak into resume — resume has no cmdInit* manifest wiring at all');
    });
  });

  // ── C6 (#2993): plan-phase's section_manifest degrades to null under a
  // missing/malformed manifest artifact, exactly like execute-phase's own
  // E57/E58 rows — the "safe superset" contract (all 6 sections read) is
  // documented per-section in plan-phase.md's own stub prose ("If
  // `section_manifest` is `null` or `"<id>"` is in its `included` list:
  // read ... Otherwise skip"), verified for each of the 6 ids below; this
  // test proves the JS-side half — that plan-phase really does receive
  // `null`, never a stale/partial selection, under a degraded artifact.

  describe('init plan-phase: section_manifest degrades to null (#2993 row C6)', () => {
    test('degradesToNullManifestWhenArtifactMissing', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-c6-missing-');
      const missingPath = path.join(dir, 'does-not-exist-section-manifest.json');
      const result = runSectionManifestCli(['init.plan-phase', '1'], dir, { GSD_SECTION_MANIFEST: missingPath });
      assert.equal(result.status, 0, `expected exit 0 despite missing manifest artifact, got ${result.status} (stderr: ${result.stderr})`);
      assertNoStackTrace(result.stderr, 'plan-phase-manifest-missing');
      const body = JSON.parse(result.stdout);
      assert.equal(body.section_manifest, null);
    });

    test('degradesToNullManifestWhenArtifactMalformed', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-c6-malformed-');
      const badPath = path.join(dir, 'bad-section-manifest.json');
      fs.writeFileSync(badPath, '{ this is not valid json');
      const result = runSectionManifestCli(['init.plan-phase', '1'], dir, { GSD_SECTION_MANIFEST: badPath });
      assert.equal(result.status, 0, `expected exit 0 despite malformed manifest artifact, got ${result.status} (stderr: ${result.stderr})`);
      assertNoStackTrace(result.stderr, 'plan-phase-manifest-malformed');
      const body = JSON.parse(result.stdout);
      assert.equal(body.section_manifest, null);
    });

    test('everyPlanPhaseSectionsHostStubDocumentsTheNullSafeSuperset (doc-level half of row C6)', () => {
      const planPhasePath = path.join(GSD_ROOT, 'workflows', 'plan-phase.md');
      const content = fs.readFileSync(planPhasePath, 'utf-8');
      const ids = [
        'reviews-prerequisite',
        'prd-express-gate',
        'adr-ingest-express-path',
        'research-only-modifiers',
        'research-only-early-exit',
        'chunked-planning-mode',
      ];
      for (const id of ids) {
        const expectedGate = `If \`section_manifest\` is \`null\` or \`"${id}"\` is in its \`included\` list:`;
        assert.ok(
          content.includes(expectedGate),
          `plan-phase.md must document the null-safe-superset gate for "${id}": expected to find "${expectedGate}"`,
        );
      }
    });
  });

  // ── #2993 (epic #1671 Phase 6.2) rows B1-B11: plan-phase facts assembly,
  // driven through the REAL CLI (prod-shape — matrix section B header) ─────

  describe('init plan-phase: new flag facts assembly (#2993 rows B1-B6)', () => {
    function runPlanPhase(phaseArgs, cwd, env = {}) {
      return runSectionManifestCli(['init.plan-phase', ...phaseArgs], cwd, env);
    }

    test('reviewsFlagPresentIncludesOnlyReviewsPrerequisite (row B1)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-b1-present-');
      const body = parseOkJson(runPlanPhase(['1', '--reviews'], dir), 'b1-present');
      assert.deepStrictEqual(body.section_manifest.included, ['reviews-prerequisite']);
    });

    test('reviewsFlagAbsentExcludesReviewsPrerequisite (row B1)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-b1-absent-');
      const body = parseOkJson(runPlanPhase(['1'], dir), 'b1-absent');
      assert.ok(!body.section_manifest.included.includes('reviews-prerequisite'));
      assert.ok(body.section_manifest.excluded.includes('reviews-prerequisite'));
    });

    test('prdFlagWithValuePresentIncludesOnlyPrdExpressGate (row B2)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-b2-present-');
      const body = parseOkJson(runPlanPhase(['1', '--prd', 'some-prd.md'], dir), 'b2-present');
      assert.deepStrictEqual(body.section_manifest.included, ['prd-express-gate']);
    });

    test('prdFlagAbsentExcludesPrdExpressGate (row B2 — value flag absence is null)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-b2-absent-');
      const body = parseOkJson(runPlanPhase(['1'], dir), 'b2-absent');
      assert.ok(!body.section_manifest.included.includes('prd-express-gate'));
      assert.ok(body.section_manifest.excluded.includes('prd-express-gate'));
    });

    test('ingestFlagWithValuePresentIncludesOnlyAdrIngestExpressPath (row B3)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-b3-present-');
      const body = parseOkJson(runPlanPhase(['1', '--ingest', 'some-adr.md'], dir), 'b3-present');
      assert.deepStrictEqual(body.section_manifest.included, ['adr-ingest-express-path']);
    });

    test('ingestFlagAbsentExcludesAdrIngestExpressPath (row B3)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-b3-absent-');
      const body = parseOkJson(runPlanPhase(['1'], dir), 'b3-absent');
      assert.ok(!body.section_manifest.included.includes('adr-ingest-express-path'));
      assert.ok(body.section_manifest.excluded.includes('adr-ingest-express-path'));
    });

    test('researchPhaseFlagWithValuePresentIncludesBothResearchOnlySections (row B4)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-b4-present-');
      const body = parseOkJson(runPlanPhase(['1', '--research-phase', '3'], dir), 'b4-present');
      assert.deepStrictEqual(body.section_manifest.included, ['research-only-modifiers', 'research-only-early-exit']);
    });

    test('researchPhaseFlagAbsentExcludesBothResearchOnlySections (row B4)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-b4-absent-');
      const body = parseOkJson(runPlanPhase(['1'], dir), 'b4-absent');
      assert.ok(!body.section_manifest.included.includes('research-only-modifiers'));
      assert.ok(!body.section_manifest.included.includes('research-only-early-exit'));
    });

    test('emptyPrdValueIsFalsyAndTreatedAsAbsent (row B5 — no spurious inclusion)', (t) => {
      // `--prd` immediately followed by another flag token (no value token
      // present at all) resolves to `null` in parseNamedArgs — the "empty
      // value" shape for a value flag. Combined with a second, independently
      // gated flag to prove ONLY the second flag's section activates.
      const dir = seedSinglePhaseProject(t, 'gsd-b5-');
      const body = parseOkJson(runPlanPhase(['1', '--prd', '--reviews'], dir), 'b5');
      assert.ok(!body.section_manifest.included.includes('prd-express-gate'), '--prd with no value must never spuriously include prd-express-gate');
      assert.deepStrictEqual(body.section_manifest.included, ['reviews-prerequisite']);
    });

    test('chunkedFlagPresentIncludesChunkedPlanningMode (row B6)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-b6-');
      const body = parseOkJson(runPlanPhase(['1', '--chunked'], dir), 'b6');
      assert.deepStrictEqual(body.section_manifest.included, ['chunked-planning-mode']);
    });
  });

  describe('init plan-phase: state:chunked-mode disjunction — flag OR config (#2993 rows B7-B11)', () => {
    function runPlanPhase(phaseArgs, cwd, env = {}) {
      return runSectionManifestCli(['init.plan-phase', ...phaseArgs], cwd, env);
    }

    function writeConfig(dir, workflowConfig) {
      fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ workflow: workflowConfig }));
    }

    test('chunkedFlagAbsentConfigTrueIncludesChunkedPlanningMode (row B7 — config arm of the disjunction)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-b7-');
      writeConfig(dir, { plan_chunked: true });
      const body = parseOkJson(runPlanPhase(['1'], dir), 'b7');
      assert.deepStrictEqual(body.section_manifest.included, ['chunked-planning-mode']);
    });

    test('chunkedFlagAbsentConfigFalseExcludesChunkedPlanningMode (row B8)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-b8-false-');
      writeConfig(dir, { plan_chunked: false });
      const body = parseOkJson(runPlanPhase(['1'], dir), 'b8-false');
      assert.ok(!body.section_manifest.included.includes('chunked-planning-mode'));
    });

    test('chunkedFlagAbsentConfigAbsentExcludesChunkedPlanningMode (row B8)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-b8-absent-');
      writeConfig(dir, {});
      const body = parseOkJson(runPlanPhase(['1'], dir), 'b8-absent');
      assert.ok(!body.section_manifest.included.includes('chunked-planning-mode'));
    });

    test('chunkedFlagAbsentConfigFileMissingExcludesChunkedPlanningMode (row B8)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-b8-nofile-');
      assert.equal(fs.existsSync(path.join(dir, '.planning', 'config.json')), false, 'sanity: no config.json');
      const body = parseOkJson(runPlanPhase(['1'], dir), 'b8-nofile');
      assert.ok(!body.section_manifest.included.includes('chunked-planning-mode'));
    });

    test('configStringTrueDegradesToFalse (row B9 — strict === true, never coerced)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-b9-');
      writeConfig(dir, { plan_chunked: 'true' });
      const body = parseOkJson(runPlanPhase(['1'], dir), 'b9');
      assert.ok(
        !body.section_manifest.included.includes('chunked-planning-mode'),
        'a string "true" config value must never coerce to boolean true',
      );
    });

    test('configReadThrowsDegradesToFalseBoundedNeverPropagates (row B10)', (t) => {
      // `readConfigJsonBoolean` (src/init.cts) is private and reads
      // `.planning/config.json` via `fs.readFileSync`, so its `catch` clause
      // cannot be exercised via an in-process fs monkeypatch across the
      // spawned-CLI process boundary this suite otherwise drives (the whole
      // matrix section is prod-shape: "drive the real CLI"). A directory at
      // the config path forces a REAL, deterministic, cross-platform fs
      // fault (EISDIR-class on every OS `fs.readFileSync` targets) through
      // the real CLI — never a chmod/permission trick — landing on the same
      // bounded, non-throwing degrade path a monkeypatched throw would.
      const dir = seedSinglePhaseProject(t, 'gsd-b10-');
      // sanity: seedSinglePhaseProject never writes a config.json, so this is
      // the fixture's own natural state, not a removal.
      assert.equal(fs.existsSync(path.join(dir, '.planning', 'config.json')), false);
      fs.mkdirSync(path.join(dir, '.planning', 'config.json'));
      const result = runPlanPhase(['1'], dir);
      assert.equal(result.status, 0, `expected exit 0 despite an unreadable config.json, got ${result.status} (stderr: ${result.stderr})`);
      assertNoStackTrace(result.stderr, 'config-read-throws');
      const body = JSON.parse(result.stdout);
      assert.ok(!body.section_manifest.included.includes('chunked-planning-mode'), 'a config read fault must degrade chunkedMode to false, never throw or propagate');
    });

    test('nonObjectConfigJsonDegradesToFalse (row B11)', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-b11-');
      for (const hostileJson of ['0', '"s"', '[]', 'null', 'true']) {
        fs.writeFileSync(path.join(dir, '.planning', 'config.json'), hostileJson);
        const result = runPlanPhase(['1'], dir);
        assert.equal(result.status, 0, `hostile config JSON ${hostileJson}: expected exit 0 (stderr: ${result.stderr})`);
        assertNoStackTrace(result.stderr, `hostile-config-json:${hostileJson}`);
        const body = JSON.parse(result.stdout);
        assert.ok(
          !body.section_manifest.included.includes('chunked-planning-mode'),
          `hostile config JSON ${hostileJson} must degrade chunkedMode to false`,
        );
      }
    });
  });

  describe('init tdd_mode: workflow.tdd_mode config flows through loadConfig (#4273 defect fix)', () => {
    // Regression test for a pre-existing defect fixed alongside #4273's
    // `phase.tdd-applicable` work: `loadConfig()` (src/config-loader.cts)
    // had no flattened `tdd_mode` field, so every `(config.workflow ?? {})`
    // call site in this file always read `{}` — `workflow.tdd_mode` set in
    // `.planning/config.json` silently never reached `cmdInitExecutePhase`,
    // `cmdInitPlanPhase`, or `cmdInitDebug`'s `tdd_mode` output field, despite
    // `workflow.tdd_mode` being a documented config contract
    // (gsd-core/references/tdd.md). `loadConfig()` now flattens
    // `workflow.tdd_mode` onto `config.tdd_mode` — mirroring the existing
    // `workflow.mvp_mode` -> `config.mvp_mode` pattern — and all three call
    // sites read `config.tdd_mode` directly instead of the dead `wf['tdd_mode']`
    // lookup. Before the fix, every assertion below would have failed
    // (`body.tdd_mode` would read `false` regardless of the config value).
    function writeWorkflowConfig(dir, workflowConfig) {
      fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ workflow: workflowConfig }));
    }

    test('executePhaseTddModeReflectsWorkflowConfig', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-tdd-exec-');
      writeWorkflowConfig(dir, { tdd_mode: true });
      const body = parseOkJson(runExecutePhase(['1'], dir), 'tdd-exec');
      assert.equal(body.tdd_mode, true, 'workflow.tdd_mode: true must flow through to the tdd_mode output field');
    });

    test('executePhaseTddModeFalseWhenConfigAbsent', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-tdd-exec-absent-');
      const body = parseOkJson(runExecutePhase(['1'], dir), 'tdd-exec-absent');
      assert.equal(body.tdd_mode, false);
    });

    test('planPhaseTddModeReflectsWorkflowConfig', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-tdd-plan-');
      writeWorkflowConfig(dir, { tdd_mode: true });
      const body = parseOkJson(runSectionManifestCli(['init.plan-phase', '1'], dir), 'tdd-plan');
      assert.equal(body.tdd_mode, true, 'workflow.tdd_mode: true must flow through to the tdd_mode output field');
    });

    test('planPhaseTddModeFalseWhenConfigAbsent', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-tdd-plan-absent-');
      const body = parseOkJson(runSectionManifestCli(['init.plan-phase', '1'], dir), 'tdd-plan-absent');
      assert.equal(body.tdd_mode, false);
    });

    test('debugTddModeReflectsWorkflowConfig', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-tdd-debug-');
      writeWorkflowConfig(dir, { tdd_mode: true });
      const body = parseOkJson(runSectionManifestCli(['init.debug'], dir), 'tdd-debug');
      assert.equal(body.tdd_mode, true, 'workflow.tdd_mode: true must flow through to the tdd_mode output field');
    });

    test('debugTddModeFalseWhenConfigFalse', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-tdd-debug-false-');
      writeWorkflowConfig(dir, { tdd_mode: false });
      const body = parseOkJson(runSectionManifestCli(['init.debug'], dir), 'tdd-debug-false');
      assert.equal(body.tdd_mode, false);
    });
  });

  describe('init research_enabled/nyquist_validation_enabled: workflow.research + workflow.nyquist_validation config flow through loadConfig (#4273 defect fix)', () => {
    // Regression test for the same dead-accessor class as the tdd_mode block
    // above, found while fixing it: `cmdInitNewMilestone`'s `research_enabled`
    // and `cmdInitPlanPhase`'s `research_enabled` / `nyquist_validation_enabled`
    // all read through `(config.workflow ?? {})` (`wf`), which `loadConfig()`
    // never populates — so all three fields were ALWAYS `undefined`,
    // regardless of `.planning/config.json`. `loadConfig()` already flattens
    // `workflow.research` -> `config.research` and `workflow.nyquist_validation`
    // -> `config.nyquist_validation` (both default `true` when unset — see
    // gsd-core/bin/shared/config-defaults.manifest.json); these call sites now
    // read the flattened fields directly instead of the dead `wf[...]` lookup.
    // Before the fix, every assertion below would have failed (`undefined`
    // regardless of config, dropped entirely from the JSON output).
    function writeWorkflowConfig(dir, workflowConfig) {
      fs.writeFileSync(path.join(dir, '.planning', 'config.json'), JSON.stringify({ workflow: workflowConfig }));
    }

    test('newMilestoneResearchEnabledDefaultsTrue', (t) => {
      const dir = fs.realpathSync(createFixture());
      t.after(() => cleanup(dir));
      const result = runGsdTools('init new-milestone', dir);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const body = JSON.parse(result.output);
      assert.strictEqual(body.research_enabled, true, 'workflow.research defaults to true and must flow through to research_enabled');
    });

    test('newMilestoneResearchEnabledReflectsWorkflowConfigFalse', (t) => {
      const dir = fs.realpathSync(createFixture());
      t.after(() => cleanup(dir));
      writeWorkflowConfig(dir, { research: false });
      const result = runGsdTools('init new-milestone', dir);
      assert.ok(result.success, `Command failed: ${result.error}`);
      const body = JSON.parse(result.output);
      assert.strictEqual(body.research_enabled, false, 'workflow.research: false must flow through to research_enabled');
    });

    test('planPhaseResearchAndNyquistEnabledReflectWorkflowConfig', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-research-plan-');
      writeWorkflowConfig(dir, { research: false, nyquist_validation: false });
      const body = parseOkJson(runSectionManifestCli(['init.plan-phase', '1'], dir), 'research-plan');
      assert.strictEqual(body.research_enabled, false, 'workflow.research: false must flow through to research_enabled');
      assert.strictEqual(body.nyquist_validation_enabled, false, 'workflow.nyquist_validation: false must flow through to nyquist_validation_enabled');
    });

    test('planPhaseResearchAndNyquistEnabledDefaultTrueWhenConfigAbsent', (t) => {
      const dir = seedSinglePhaseProject(t, 'gsd-research-plan-absent-');
      const body = parseOkJson(runSectionManifestCli(['init.plan-phase', '1'], dir), 'research-plan-absent');
      assert.strictEqual(body.research_enabled, true);
      assert.strictEqual(body.nyquist_validation_enabled, true);
    });
  });

  // ── Row 62: stub <execution_context> @-refs still resolve (ADR-0002) ────

  describe('commands/gsd/execute-phase.md: <execution_context> @-refs resolve (#2932 row 62)', () => {
    test('stubExecutionContextRefStillResolves', () => {
      const stubPath = path.join(COMMANDS_DIR, 'execute-phase.md');
      const content = fs.readFileSync(stubPath, 'utf-8');
      const refs = executionContextRefs(content);
      assert.ok(refs.length > 0, 'execute-phase.md stub must declare at least one execution_context @-ref');

      const workflowRef = refs.find((r) => r.normalized === 'workflows/execute-phase.md');
      assert.ok(workflowRef, 'execute-phase.md stub must @-reference workflows/execute-phase.md');

      for (const ref of refs) {
        assert.ok(
          fs.existsSync(path.join(GSD_ROOT, ref.normalized)),
          `execution_context @-ref "${ref.normalized}" must resolve to a file that exists on disk`,
        );
      }
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #3171 (Claim 3): the phase-start flow must not land a directory slug in
// STATE.md's `current_phase_name`. When a phase directory already exists on
// disk, `init execute-phase`'s disk-lookup path derived `phase_name` from the
// directory-name remainder — itself an already-slugified value (`phase.add`
// writes `${num}-${slug}` dirs) — so `phase_name` and `phase_slug` came out
// byte-identical, and the execute-phase workflow forwarded that slug into
// `state begin-phase --name`. The milestone-name half of #3171 was subsumed
// by #3216 / PR #3226; these tests cover the remaining current_phase_name half.
// ─────────────────────────────────────────────────────────────────────────────

describe('#3171: init execute-phase emits the display name, not the directory slug', () => {
  const DISPLAY_NAME = 'Loop-Termination and Baseline Correctness';
  const PHASE_SLUG_DIR = '35-loop-termination-and-baseline-correctness';
  const ROADMAP_3171 = [
    '# Roadmap',
    '',
    `### Phase 35: ${DISPLAY_NAME}`,
    '**Goal:** Fix loop termination',
    '**Plans:** 1 plans',
    '',
  ].join('\n');
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.realpathSync(createFixture());
    seedPhase(tmpDir, PHASE_SLUG_DIR, { '35-01-PLAN.md': '# Plan' });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), ROADMAP_3171);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('phase_name is the ROADMAP display name when the phase directory exists', () => {
    const result = runGsdTools('init execute-phase 35 --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phase_found, true, 'phase must be found on disk');
    assert.ok(
      typeof output.phase_dir === 'string' && output.phase_dir.includes(PHASE_SLUG_DIR),
      `phase_dir must point at the on-disk directory; got ${JSON.stringify(output.phase_dir)}`,
    );
    assert.strictEqual(
      output.phase_name,
      DISPLAY_NAME,
      `phase_name must be the ROADMAP display name, not the directory slug; got ${JSON.stringify(output.phase_name)}`,
    );
    assert.strictEqual(output.phase_slug, 'loop-termination-and-baseline-correctness');
    assert.notStrictEqual(output.phase_name, output.phase_slug,
      'phase_name must differ from phase_slug — a byte-identical pair is the #3171 defect signature');
  });

  test('the phase-start flow does not land a slug in current_phase_name', () => {
    // 1. init execute-phase → the value the execute-phase workflow forwards to begin-phase.
    const initResult = runGsdTools('init execute-phase 35 --raw', tmpDir);
    assert.ok(initResult.success, `init execute-phase failed: ${initResult.error}`);
    const initOutput = JSON.parse(initResult.output);
    assert.strictEqual(initOutput.phase_name, DISPLAY_NAME);

    // 2. Seed a STATE.md the transition module can rewrite (frontmatter + body).
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      [
        '---',
        'gsd_state_version: 1.0',
        'current_phase: 34',
        'current_phase_name: Prior Phase',
        'status: planning',
        '---',
        '',
        '# Project State',
        '',
        '## Current Position',
        '',
        'Phase: 34 — Prior Phase',
        'Plan: Not started',
        'Status: Ready to execute',
        '',
      ].join('\n'),
    );

    // 3. The orchestrator wiring: feed init's phase_name into begin-phase --name.
    const beginResult = runGsdTools(
      ['state', 'begin-phase', '--phase', '35', '--name', initOutput.phase_name, '--plans', '1'],
      tmpDir,
    );
    assert.ok(beginResult.success, `state begin-phase failed: ${beginResult.error}`);

    // 4. current_phase_name in STATE.md must be the display name, never the slug.
    const stateContent = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const fm = parseFrontmatter(stateContent);
    assert.strictEqual(
      fm.current_phase_name,
      DISPLAY_NAME,
      `current_phase_name must hold the display name, not a directory slug; got ${JSON.stringify(fm.current_phase_name)}`,
    );
    assert.ok(
      !/^[a-z0-9]+(-[a-z0-9]+)+$/.test(String(fm.current_phase_name)),
      `current_phase_name must not be slug-shaped; got ${JSON.stringify(fm.current_phase_name)}`,
    );
  });
});

// ─── #3581: init.progress frontier prefers roadmap order over stray artifacts ──
describe('#3581: init.progress next_phase prefers the roadmap frontier', () => {
  function writeProgressFixture(t, { strayNine, completeAll }) {
    fs.writeFileSync(path.join(tmpDirOf(t), '.planning', 'ROADMAP.md'),
      ['# Roadmap', '', '## Milestone v1.1.0', '', '### Phase 8: Payments', '**Goal:** g', '', '### Phase 9: Compatibility', '**Goal:** g', ''].join('\n'));
    fs.writeFileSync(path.join(tmpDirOf(t), '.planning', 'STATE.md'), [
      '---', 'gsd_state_version: 1.0', 'milestone: v1.1.0', 'milestone_name: Active',
      'status: executing', 'current_phase: 8', 'progress:', '  total_phases: 9',
      '  completed_phases: 7', '  percent: 78', '---', '', '# Project State', '',
      '## Current Position', '', 'Phase: 8', 'Status: Executing',
    ].join('\n'));
    if (strayNine) {
      const nine = path.join(tmpDirOf(t), '.planning', 'phases', '09-live-compatibility-diagnostics');
      fs.mkdirSync(nine, { recursive: true });
      fs.writeFileSync(path.join(nine, 'UAT.md'), '# UAT evidence\n');
    }
    if (completeAll) {
      // both phases complete on disk (plans, summaries, PASSING verification —
      // the #3168 disk-strict bar) + roadmap checkboxes
      for (const dir of ['08-payments', '09-compatibility']) {
        const d = path.join(tmpDirOf(t), '.planning', 'phases', dir);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'PLAN.md'), '# p\n');
        fs.writeFileSync(path.join(d, 'SUMMARY.md'), '# s\n');
        fs.writeFileSync(path.join(d, `${dir.split('-')[0]}-VERIFICATION.md`), '---\nstatus: passed\n---\n\n# V\n');
      }
    }
  }
  // local alias so the helper reads the same as the suite's own fixtures
  function tmpDirOf(t) { return t.tmpDir3581 ?? (t.tmpDir3581 = createTempProject('gsd-3581-')); }

  test('#3581: init.progress prefers the roadmap frontier over a stray out-of-order artifact', (t) => {
    writeProgressFixture(t, { strayNine: true });
    t.after(() => cleanup(tmpDirOf(t)));
    const result = runGsdTools(['init', 'progress', '--raw'], tmpDirOf(t));
    assert.ok(result.success, `init progress failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.ok(out.next_phase, `next_phase present; got keys ${Object.keys(out)}`);
    assert.equal(String(out.next_phase.number).replace(/^0+/, ''), '8',
      `the roadmap's Phase 8 (pending, unscaffolded) must be the frontier — not the stray 09 artifact dir; got ${out.next_phase.number}`);
    const eight = (out.phases || []).find((p) => String(p.number).replace(/^0+/, '') === '8');
    assert.ok(eight, 'Phase 8 present in the phases array (roadmap-derived)');
    assert.equal(eight.directory, null, 'Phase 8 has no directory (corroborating the stray-only-disk shape)');
  });

  test('#4023: init.progress sorts decimal phase ids before choosing the roadmap frontier', (t) => {
    const tmpDir = createTempProject('gsd-4023-init-');
    t.after(() => cleanup(tmpDir));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), [
      '# Roadmap',
      '',
      '## Milestone v1.1.0',
      '',
      '### Phase 12: Parent',
      '**Goal:** g',
      '',
      '### Phase 12.1: Inserted fix',
      '**Goal:** g',
      '',
      '### Phase 12.2: Second insert',
      '**Goal:** g',
      '',
      '### Phase 12.10: Tenth insert',
      '**Goal:** g',
      '',
      '### Phase 13: Follow-up',
      '**Goal:** g',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), [
      '---',
      'gsd_state_version: 1.0',
      'milestone: v1.1.0',
      'milestone_name: Active',
      'status: executing',
      'current_phase: 12.1',
      'progress:',
      '  total_phases: 13',
      '  completed_phases: 11',
      '  percent: 85',
      '---',
      '',
      '# Project State',
      '',
      '## Current Position',
      '',
      'Phase: 12.1',
      'Status: Executing',
      '',
    ].join('\n'));
    for (const dir of ['12.1-inserted-fix', '12.10-tenth-insert']) {
      fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', dir), { recursive: true });
    }

    const result = runGsdTools(['init', 'progress', '--raw'], tmpDir);
    assert.ok(result.success, `init progress failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.deepEqual(
      out.phases.map((phase) => String(phase.number).replace(/^0+(?=\d)/, '')),
      ['12', '12.1', '12.2', '12.10', '13'],
      'the disk/roadmap union follows component-wise phase-id order (12.2 before 12.10)',
    );
    assert.equal(
      String(out.next_phase.number).replace(/^0+(?=\d)/, ''),
      '12',
      'the pending parent remains the frontier when an inserted decimal directory exists first',
    );
  });

  test('#3581 (control): a pending roadmap-only phase outranks a later pending directory', (t) => {
    writeProgressFixture(t, { strayNine: false });
    // pure ordering property, no stray artifacts: roadmap-only pending 8 vs a
    // pending 9 DIRECTORY (empty). The pinned mixed-statuses contract (an
    // in-progress phase is currentPhase's lane, not nextPhase's) is untouched.
    const nine = path.join(tmpDirOf(t), '.planning', 'phases', '09-compatibility');
    fs.mkdirSync(nine, { recursive: true });
    t.after(() => cleanup(tmpDirOf(t)));
    const result = runGsdTools(['init', 'progress', '--raw'], tmpDirOf(t));
    assert.ok(result.success, `init progress failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.equal(String(out.next_phase.number).replace(/^0+/, ''), '8',
      'the unscaffolded roadmap Phase 8 is the frontier even against a legitimately-pending 9 directory');
  });

  test('#3581 (boundary): completed milestone yields no frontier', (t) => {
    writeProgressFixture(t, { strayNine: false, completeAll: true });
    fs.writeFileSync(path.join(tmpDirOf(t), '.planning', 'ROADMAP.md'),
      ['# Roadmap', '', '## Milestone v1.1.0', '', '- [x] **Phase 8: Payments**', '- [x] **Phase 9: Compatibility**', ''].join('\n'));
    t.after(() => cleanup(tmpDirOf(t)));
    const result = runGsdTools(['init', 'progress', '--raw'], tmpDirOf(t));
    assert.ok(result.success, `init progress failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.equal(out.next_phase, null, 'all-complete milestone: no frontier (completion flow owns the answer)');
  });
});

// ─── #3749: project_exists must follow project_path under GSD_PROJECT ───────
describe('init.new-project — GSD_PROJECT scoping (#3749)', () => {
  test('project_exists tracks the namespaced PROJECT.md, not the root one', (t) => {
    const tmpDir = createTempProject('gsd-3749-init-');
    t.after(() => cleanup(tmpDir));
    fs.mkdirSync(path.join(tmpDir, '.planning', 'second-product'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'second-product', 'PROJECT.md'), '# Second Product\n');

    const r1 = runGsdTools(['query', 'init.new-project'], tmpDir, { GSD_PROJECT: 'second-product' });
    assert.ok(r1.success, r1.error);
    const out1 = JSON.parse(r1.output);
    assert.equal(out1['project_exists'], true,
      `#3749: project_path (${out1['project_path']}) names an existing file — project_exists must be true`);
    // project_path is POSIX-normalized by toPosixPath — compare with a literal
    // forward-slash path, not path.join (which yields backslashes on Windows).
    assert.ok(String(out1['project_path']).includes('.planning/second-product'));

    // An unrelated root PROJECT.md must not change the verdict.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# unrelated\n');
    const r2 = runGsdTools(['query', 'init.new-project'], tmpDir, { GSD_PROJECT: 'second-product' });
    assert.ok(r2.success, r2.error);
    assert.equal(JSON.parse(r2.output)['project_exists'], true,
      '#3749: verdict must not flip when an unrelated root file appears');
  });

  test('without GSD_PROJECT the root PROJECT.md still answers project_exists', (t) => {
    const tmpDir = createTempProject('gsd-3749-init2-');
    t.after(() => cleanup(tmpDir));
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# Root Project\n');
    const r = runGsdTools(['query', 'init.new-project'], tmpDir);
    assert.ok(r.success, r.error);
    assert.equal(JSON.parse(r.output)['project_exists'], true, 'default (unscoped) behavior unchanged');
  });
});

// ─── #3964: three GSD_PROJECT-blind planning literals ────────────────────────
// Found in the #3955 review and filed as their own issue: waiting_signal read
// the root WAITING.json, skill-manifest --write wrote the root planning dir,
// and codebase_dir/exists were root-pinned while verify.cts scopes codebase/
// through the project-aware resolver.
describe('init — GSD_PROJECT scoping (#3964)', () => {
  function writeScopedScaffolding(tmpDir, slug) {
    const scoped = path.join(tmpDir, '.planning', slug);
    fs.mkdirSync(path.join(scoped, 'phases', '01-probe'), { recursive: true });
    fs.writeFileSync(path.join(scoped, 'ROADMAP.md'), '# Roadmap\n\n## Phase 1: Probe\n- [ ] w\n');
    fs.writeFileSync(path.join(scoped, 'STATE.md'), [
      '---',
      'gsd_state_version: 1.0',
      'current_phase: 01',
      'status: executing',
      'progress:',
      '  total_phases: 1',
      '---',
      '',
      '## Current Position',
      '',
      '**Status:** Executing',
      '',
    ].join('\n'));
    return scoped;
  }

  test('#3964: waiting_signal reads the scoped WAITING.json under GSD_PROJECT', (t) => {
    const tmpDir = createTempDir('gsd-3964-waiting-');
    t.after(() => cleanup(tmpDir));
    const scoped = writeScopedScaffolding(tmpDir, 'second-product');
    fs.writeFileSync(path.join(scoped, 'WAITING.json'), JSON.stringify({ type: 'decision_point', since: 'x' }));

    const r = runGsdTools(['query', 'init', 'manager'], tmpDir, { GSD_PROJECT: 'second-product' });
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.equal(out['waiting_signal'] && out['waiting_signal']['type'], 'decision_point',
      `#3964: waiting_signal must reflect the scoped WAITING.json; got ${JSON.stringify(out['waiting_signal'])}`);
  });

  test('#3964: a .gsd/WAITING.json wins over the planning-dir copy (mirrors the writer)', (t) => {
    const tmpDir = createTempDir('gsd-3964-waiting2-');
    t.after(() => cleanup(tmpDir));
    const scoped = writeScopedScaffolding(tmpDir, 'second-product');
    fs.writeFileSync(path.join(scoped, 'WAITING.json'), JSON.stringify({ type: 'from-planning' }));
    fs.mkdirSync(path.join(tmpDir, '.gsd'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.gsd', 'WAITING.json'), JSON.stringify({ type: 'from-gsd' }));

    const r = runGsdTools(['query', 'init', 'manager'], tmpDir, { GSD_PROJECT: 'second-product' });
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.equal(out['waiting_signal'] && out['waiting_signal']['type'], 'from-gsd',
      'the writer\'s primary location (.gsd) must win, matching cmdSignalWaiting');
  });

  test('#3964: codebase_dir and codebase_dir_exists are scoped under GSD_PROJECT', (t) => {
    const tmpDir = createTempDir('gsd-3964-codebase-');
    t.after(() => cleanup(tmpDir));
    const scoped = writeScopedScaffolding(tmpDir, 'second-product');
    fs.mkdirSync(path.join(scoped, 'codebase'), { recursive: true });

    const r = runGsdTools(['query', 'init', 'map-codebase'], tmpDir, { GSD_PROJECT: 'second-product' });
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    // codebase_dir is POSIX-normalized (toPosixPath) — compare against a
    // literal forward-slash path, not path.join (backslashes on Windows).
    assert.ok(String(out['codebase_dir']).includes('.planning/second-product'),
      `#3964: codebase_dir must be scoped, got ${out['codebase_dir']}`);
    assert.equal(out['codebase_dir_exists'], true,
      '#3964: the scoped codebase dir exists — must agree with verify scoping');
  });

  test('#3964: skill-manifest --write targets the scoped planning dir', (t) => {
    const tmpDir = createTempDir('gsd-3964-manifest-');
    t.after(() => cleanup(tmpDir));
    writeScopedScaffolding(tmpDir, 'second-product');

    const r = runGsdTools(['skill-manifest', '--write'], tmpDir, { GSD_PROJECT: 'second-product' });
    assert.ok(r.success, r.error);
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'second-product', 'skill-manifest.json')),
      '#3964: skill-manifest.json must be written inside the scoped project');
    assert.ok(!fs.existsSync(path.join(tmpDir, '.planning', 'skill-manifest.json')),
      '#3964: the root planning dir must not gain a manifest under GSD_PROJECT');
  });

  test('#3964: existing_maps/has_maps read the scoped codebase dir (same payload agreement)', (t) => {
    const tmpDir = createTempDir('gsd-3964-maps-');
    t.after(() => cleanup(tmpDir));
    const scoped = writeScopedScaffolding(tmpDir, 'second-product');
    fs.mkdirSync(path.join(scoped, 'codebase'), { recursive: true });
    fs.writeFileSync(path.join(scoped, 'codebase', 'STRUCTURE.md'), '# Structure\n');

    const r = runGsdTools(['query', 'init', 'map-codebase'], tmpDir, { GSD_PROJECT: 'second-product' });
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.equal(out['codebase_dir_exists'], true);
    assert.equal(out['has_maps'], true,
      '#3964: has_maps must agree with codebase_dir_exists — the scoped dir holds STRUCTURE.md');
    assert.ok((out['existing_maps'] || []).includes('STRUCTURE.md'),
      `#3964: existing_maps must list the scoped maps, got ${JSON.stringify(out['existing_maps'])}`);
  });

  test('#3964: init.new-project has_codebase_map is project-scoped (onboard projection)', (t) => {
    const tmpDir = createTempDir('gsd-3964-onboard-');
    t.after(() => cleanup(tmpDir));
    const scoped = writeScopedScaffolding(tmpDir, 'second-product');
    fs.mkdirSync(path.join(scoped, 'codebase'), { recursive: true });
    // has_codebase_map requires the COMPLETE map set (onboard-projection's
    // REQUIRED_CODEBASE_MAP_FILES), not just STRUCTURE.md.
    for (const f of ['STACK.md', 'ARCHITECTURE.md', 'STRUCTURE.md', 'CONVENTIONS.md', 'TESTING.md', 'INTEGRATIONS.md', 'CONCERNS.md']) {
      fs.writeFileSync(path.join(scoped, 'codebase', f), '# Map\n');
    }

    const r = runGsdTools(['query', 'init.new-project'], tmpDir, { GSD_PROJECT: 'second-product' });
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.equal(out['has_codebase_map'], true,
      `#3964: has_codebase_map must answer for the scoped project, got ${out['has_codebase_map']}`);
  });

  test('#3964 control: unscoped behavior unchanged (root paths)', (t) => {
    const tmpDir = createTempDir('gsd-3964-unscoped-');
    t.after(() => cleanup(tmpDir));
    writeScopedScaffolding(tmpDir, 'rootproj');
    // No GSD_PROJECT: the effective project is the plain .planning root; give it
    // the same scaffolding so the command runs.
    fs.mkdirSync(path.join(tmpDir, '.planning', 'codebase'), { recursive: true });

    const r = runGsdTools(['query', 'init', 'map-codebase'], tmpDir);
    assert.ok(r.success, r.error);
    const out = JSON.parse(r.output);
    assert.equal(out['codebase_dir_exists'], true, 'unscoped probe of the root codebase dir');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #4040: partial-init routing signal (interrupted bootstrap detection)
// ─────────────────────────────────────────────────────────────────────────────

describe('#4040 partial-init completeness fields', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.realpathSync(createFixture());
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('#4040 init.progress: interrupted bootstrap (PROJECT.md only) is flagged init_incomplete', () => {
    // Issue repro: bootstrap died after PROJECT.md + config.json, before
    // REQUIREMENTS.md / ROADMAP.md / STATE.md.
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# Project\nTest\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), '{}\n');

    const result = runGsdTools('init progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.planning_exists, true);
    assert.strictEqual(output.project_exists, true);
    assert.strictEqual(output.requirements_exists, false);
    assert.strictEqual(output.roadmap_exists, false);
    assert.strictEqual(output.state_exists, false);
    assert.strictEqual(output.milestones_exists, false);
    assert.strictEqual(output.init_incomplete, true,
      'interrupted bootstrap must be distinguishable from new project / between milestones');
  });

  test('#4040 init.progress: complete project is not init_incomplete', () => {
    writePlanningDocs(tmpDir); // STATE.md + ROADMAP.md + REQUIREMENTS.md
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# Project\nTest\n');

    const result = runGsdTools('init progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.requirements_exists, true);
    assert.strictEqual(output.init_incomplete, false);
  });

  test('#4040 init.progress: between-milestones archive state is not init_incomplete', () => {
    // milestone.complete archives ROADMAP (and REQUIREMENTS) but leaves
    // MILESTONES.md + STATE.md — Route F territory, NOT a partial bootstrap.
    writePlanningDocs(tmpDir, { roadmap: false, requirements: false });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# Project\nTest\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'MILESTONES.md'), '# Milestones\n\n## v1.0\n');

    const result = runGsdTools('init progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.milestones_exists, true);
    assert.strictEqual(output.init_incomplete, false,
      'an archived milestone (MILESTONES.md present) must keep the between-milestones route');
  });

  test('#4040 init.progress: empty .planning (config only) is init_incomplete, not "no planning"', () => {
    // Bootstrap that died before even PROJECT.md: .planning/ exists, so the
    // workflow must not claim "no planning structure found".
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), '{}\n');

    const result = runGsdTools('init progress', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.planning_exists, true);
    assert.strictEqual(output.project_exists, false);
    assert.strictEqual(output.init_incomplete, true);
  });

  test('#4040 init.resume: interrupted bootstrap flagged init_incomplete', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# Project\nTest\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), '{}\n');

    const result = runGsdTools('init resume', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.requirements_exists, false);
    assert.strictEqual(output.init_incomplete, true,
      'resume must route to initialization recovery, not STATE.md reconstruction');
  });

  test('#4040 init.new-project: interrupted bootstrap flagged init_incomplete', () => {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'PROJECT.md'), '# Project\nTest\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), '{}\n');

    const result = runGsdTools('init new-project', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.strictEqual(output.init_incomplete, true,
      'new-project gate must resume a partial bootstrap instead of erroring');
  });
});
