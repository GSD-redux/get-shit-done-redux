// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * GSD Tools Tests - Milestone
 *
 * Covers: milestone complete command, phases clear command,
 * requirements mark-complete command (regex-global fix), new-milestone
 * workflow verification gate, milestone complete version scoping (#3043).
 */

'use strict';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup, parseFrontmatter } = require('./helpers.cjs');

// ─── helpers ─────────────────────────────────────────────────────────────────

function writeState(tmpDir, extra = '') {
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    `# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n${extra}`,
  );
}

function writeRoadmap(tmpDir, content) {
  fs.writeFileSync(path.join(tmpDir, '.planning', 'ROADMAP.md'), content);
}

function mkPhaseDir(tmpDir, name, opts = {}) {
  const p = path.join(tmpDir, '.planning', 'phases', name);
  fs.mkdirSync(p, { recursive: true });
  if (opts.plan) fs.writeFileSync(path.join(p, `${name.split('-')[0]}-01-PLAN.md`), '# Plan\n');
  if (opts.oneLiner) {
    fs.writeFileSync(
      path.join(p, `${name.split('-')[0]}-01-SUMMARY.md`),
      `---\none-liner: ${opts.oneLiner}\n---\n# Summary\n`,
    );
  }
  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// milestone complete command
// ─────────────────────────────────────────────────────────────────────────────

describe('milestone complete command', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('preserves current_phase frontmatter through milestone complete (#2111)', () => {
    // Seed STATE.md mid-phase-19: the real current_phase lives in frontmatter
    // and the only body phase source is the `Phase:` prose line (no explicit
    // `Current Phase:` field — matching what milestoneCompleteCore writes).
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `---\ncurrent_phase: "19"\n---\n# State\n\n**Status:** In progress\n` +
      `**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n\n` +
      `## Current Position\n\nPhase: 19 — EXECUTING\nPlan: 1 of 1\n` +
      `Status: Executing\nLast activity: 2025-01-01 — Running phase\n`,
    );
    // No ROADMAP.md — mirrors 'handles missing ROADMAP.md gracefully' so the
    // milestone-phase-filter guard never fires.

    const result = runGsdTools('milestone complete v0.5 --name Test', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    const fm = parseFrontmatter(state);
    // Fails pre-migration: the unanchored parser mined "5" from
    // "Phase: Milestone v0.5 complete" and clobbered current_phase.
    assert.strictEqual(
      fm.current_phase, '19',
      `current_phase must be preserved across milestone complete, not mined from ` +
      `the version string (#2111); got ${JSON.stringify(fm.current_phase)}`,
    );
  });

  test('archives roadmap, requirements, creates MILESTONES.md', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0 MVP\n\n### Phase 1: Foundation\n**Goal:** Setup\n`);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements\n\n- [ ] User auth\n- [ ] Dashboard\n`,
    );
    writeState(tmpDir);
    mkPhaseDir(tmpDir, '01-foundation', { oneLiner: 'Set up project infrastructure' });

    const result = runGsdTools('milestone complete v1.0 --name MVP Foundation', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.version, 'v1.0');
    assert.strictEqual(output.phases, 1);
    assert.ok(output.archived.roadmap, 'roadmap should be archived');
    assert.ok(output.archived.requirements, 'requirements should be archived');
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-ROADMAP.md')),
      'archived roadmap should exist',
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-REQUIREMENTS.md')),
      'archived requirements should exist',
    );
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'MILESTONES.md')));
    const milestones = fs.readFileSync(path.join(tmpDir, '.planning', 'MILESTONES.md'), 'utf-8');
    assert.ok(milestones.includes('v1.0 MVP Foundation'));
    assert.ok(milestones.includes('Set up project infrastructure'));
  });

  test('#2118 — --dry-run does NOT mutate: no archive, no STATE.md rewrite, no phase move', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0 MVP\n\n### Phase 1: Foundation\n**Goal:** Setup\n`);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements\n\n- [x] User auth\n`,
    );
    writeState(tmpDir);
    const phasePath = mkPhaseDir(tmpDir, '01-foundation', { oneLiner: 'Set up project infrastructure' });

    // Capture pre-state
    const stateBefore = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    const result = runGsdTools('milestone complete v1.0 --name Test --dry-run', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.dry_run, true, 'dry_run must be true');
    assert.strictEqual(output.version, 'v1.0');
    assert.ok(output.stats.phases >= 1, 'should count at least 1 phase');
    assert.ok(output.would_archive.roadmap, 'should list roadmap archive plan');
    assert.ok(output.would_archive.requirements, 'should list requirements archive plan');
    assert.ok(
      output.would_archive.phases.includes('01-foundation'),
      'should list phase dir for archive',
    );
    assert.ok(
      Array.isArray(output.accomplishments) && output.accomplishments.includes('Set up project infrastructure'),
      'dry-run preview should surface accomplishments from phase SUMMARY one-liners (#2118)',
    );

    // CRITICAL: no mutations occurred
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'ROADMAP.md')),
      'ROADMAP.md must NOT be archived (dry-run)',
    );
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md')),
      'REQUIREMENTS.md must NOT be archived (dry-run)',
    );
    assert.ok(
      fs.existsSync(phasePath),
      'phase directory must NOT be moved (dry-run)',
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'MILESTONES.md')),
      'MILESTONES.md must NOT be created (dry-run)',
    );
    assert.strictEqual(
      fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'),
      stateBefore,
      'STATE.md must be unchanged (dry-run)',
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'milestones')),
      'archive dir must NOT be created (dry-run) — platformEnsureDir must be gated',
    );
  });

  test('#2118 — --dry-run --no-archive-phases omits phase list from preview', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0 MVP\n\n### Phase 1: Foundation\n**Goal:** Setup\n`);
    writeState(tmpDir);
    mkPhaseDir(tmpDir, '01-foundation');

    const result = runGsdTools('milestone complete v1.0 --dry-run --no-archive-phases', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.dry_run, true);
    assert.deepStrictEqual(output.would_archive.phases, [], 'phases list must be empty with --no-archive-phases');
  });

  test('#2118 — --dry-run --force bypasses the unstarted-phases guard', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0 MVP\n\n### Phase 1: Foundation\n**Goal:** Setup\n`);
    writeState(tmpDir, 'milestone: v1.0\n');
    // No phase directory for Phase 1 — guard would block without --force

    // Capture pre-state
    const stateBefore = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');

    const result = runGsdTools('milestone complete v1.0 --dry-run --force', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.dry_run, true, 'preview should run past the guard with --force');

    // CRITICAL: --force must still be a zero-mutation dry-run preview
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'milestones')),
      'archive dir must NOT be created (dry-run --force) — platformEnsureDir must be gated',
    );
    assert.strictEqual(
      fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8'),
      stateBefore,
      'STATE.md must be unchanged (dry-run --force)',
    );
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'MILESTONES.md')),
      'MILESTONES.md must NOT be created (dry-run --force)',
    );
  });

  test('#2118 — --dry-run --raw emits structured preview JSON, not the literal "dry-run" string', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0 MVP\n\n### Phase 1: Foundation\n**Goal:** Setup\n`);
    writeState(tmpDir);
    mkPhaseDir(tmpDir, '01-foundation', { oneLiner: 'Set up project infrastructure' });

    const result = runGsdTools(['milestone', 'complete', 'v1.0', '--name', 'Test', '--dry-run', '--raw'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // Before the fix, output(dryRunResult, raw, 'dry-run') meant --raw discarded
    // the structured payload and printed only the literal string "dry-run",
    // which is not parseable JSON.
    let output;
    assert.doesNotThrow(
      () => { output = JSON.parse(result.output); },
      `--dry-run --raw output must be parseable JSON, not the literal "dry-run" string; got ${JSON.stringify(result.output)}`,
    );
    assert.strictEqual(output.dry_run, true, 'dry_run must be true, not the literal string "dry-run"');
    assert.strictEqual(output.version, 'v1.0');
    assert.ok(
      Array.isArray(output.accomplishments) && output.accomplishments.includes('Set up project infrastructure'),
      'structured preview surviving --raw should include accomplishments',
    );
  });

  test('prepends to existing MILESTONES.md (reverse chronological)', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'MILESTONES.md'),
      `# Milestones\n\n## v0.9 Alpha (Shipped: 2025-01-01)\n\n---\n\n`,
    );
    writeRoadmap(tmpDir, `# Roadmap v1.0\n`);
    writeState(tmpDir);

    const result = runGsdTools('milestone complete v1.0 --name Beta', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const milestones = fs.readFileSync(path.join(tmpDir, '.planning', 'MILESTONES.md'), 'utf-8');
    assert.ok(milestones.includes('v0.9 Alpha'));
    assert.ok(milestones.includes('v1.0 Beta'));
    assert.ok(milestones.indexOf('v1.0 Beta') < milestones.indexOf('v0.9 Alpha'), 'new entry before old');
  });

  test('three sequential completions maintain reverse-chronological order', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'MILESTONES.md'),
      `# Milestones\n\n## v1.0 First (Shipped: 2025-01-01)\n\n---\n\n`,
    );
    writeRoadmap(tmpDir, `# Roadmap v1.1\n`);
    writeState(tmpDir);

    assert.ok(runGsdTools('milestone complete v1.1 --name Second', tmpDir).success);
    writeRoadmap(tmpDir, `# Roadmap v1.2\n`);
    assert.ok(runGsdTools('milestone complete v1.2 --name Third', tmpDir).success);

    const m = fs.readFileSync(path.join(tmpDir, '.planning', 'MILESTONES.md'), 'utf-8');
    const [i10, i11, i12] = ['v1.0 First', 'v1.1 Second', 'v1.2 Third'].map(s => m.indexOf(s));
    assert.ok(i10 !== -1 && i11 !== -1 && i12 !== -1);
    assert.ok(i12 < i11, 'v1.2 before v1.1');
    assert.ok(i11 < i10, 'v1.1 before v1.0');
  });

  test('archives phase directories with --archive-phases flag', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0\n`);
    writeState(tmpDir);
    mkPhaseDir(tmpDir, '01-foundation', { oneLiner: 'Set up project infrastructure' });

    const result = runGsdTools('milestone complete v1.0 --name MVP --archive-phases', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.archived.phases, true, 'phases should be archived');
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '01-foundation')));
    assert.ok(!fs.existsSync(path.join(tmpDir, '.planning', 'phases', '01-foundation')));
  });

  test('archived REQUIREMENTS.md contains archive header', () => {
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'REQUIREMENTS.md'),
      `# Requirements\n\n- [ ] **TEST-01**: core.cjs has tests\n- [ ] **TEST-02**: more tests\n`,
    );
    writeRoadmap(tmpDir, `# Roadmap v1.0\n`);
    writeState(tmpDir);

    assert.ok(runGsdTools('milestone complete v1.0 --name MVP', tmpDir).success);

    const archivedReq = fs.readFileSync(
      path.join(tmpDir, '.planning', 'milestones', 'v1.0-REQUIREMENTS.md'), 'utf-8',
    );
    assert.ok(archivedReq.includes('Requirements Archive: v1.0'));
    assert.ok(archivedReq.includes('SHIPPED'));
    assert.ok(archivedReq.includes('Archived:'));
    assert.ok(archivedReq.includes('# Requirements'));
    assert.ok(archivedReq.includes('**TEST-01**'));
  });

  test('STATE.md gets updated during milestone complete', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0\n`);
    writeState(tmpDir);

    const result = runGsdTools('milestone complete v1.0 --name Test', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.state_updated, true);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(state.includes('v1.0 milestone complete'));
    assert.ok(state.includes('v1.0 milestone completed and archived'));
  });

  test('normalizes stale STATE.md narrative tails after milestone complete (#3088)', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0\n`);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n\n## Current Position\n\nPhase: 03 — EXECUTING\nPlan: 03-02\nStatus: Executing\nLast activity: 2025-01-01 — Running phase\n\n## Operator Next Steps\n\n- Re-run /gsd:complete-milestone v1.0\n`,
    );

    const result = runGsdTools('milestone complete v1.0 --name Test', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(state.includes('Phase: Milestone v1.0 complete'));
    assert.ok(state.includes('Status: Awaiting next milestone'));
    assert.ok(!state.includes('Re-run /gsd:complete-milestone'));
    assert.ok(state.includes('/gsd-new-milestone'));
  });

  test('appends canonical narrative sections when STATE.md headings are missing (#3088)', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0\n`);
    writeState(tmpDir);

    const result = runGsdTools('milestone complete v1.0 --name Test', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const state = fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8');
    assert.ok(state.includes('## Current Position'));
    assert.ok(state.includes('Phase: Milestone v1.0 complete'));
    assert.ok(state.includes('## Operator Next Steps'));
    assert.ok(state.includes('/gsd-new-milestone'));
  });

  test('handles missing ROADMAP.md gracefully', () => {
    writeState(tmpDir);

    const result = runGsdTools('milestone complete v1.0 --name NoRoadmap', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.archived.roadmap, false);
    assert.strictEqual(output.archived.requirements, false);
    assert.strictEqual(output.milestones_updated, true);
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'MILESTONES.md')));
  });

  test('scopes stats to current milestone phases only', () => {
    writeRoadmap(tmpDir,
      `# Roadmap v1.1\n\n### Phase 3: New Feature\n**Goal:** Build it\n\n### Phase 4: Polish\n**Goal:** Ship it\n`,
    );
    writeState(tmpDir);

    // Previous milestone phases — must be excluded
    mkPhaseDir(tmpDir, '01-old-setup', { plan: true, oneLiner: 'Old setup work' });
    mkPhaseDir(tmpDir, '02-old-core', { plan: true, oneLiner: 'Old core work' });
    // Current milestone phases
    mkPhaseDir(tmpDir, '03-new-feature', { plan: true, oneLiner: 'Built new feature' });
    const p4 = path.join(tmpDir, '.planning', 'phases', '04-polish');
    fs.mkdirSync(p4, { recursive: true });
    fs.writeFileSync(path.join(p4, '04-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(p4, '04-02-PLAN.md'), '# Plan 2\n');
    fs.writeFileSync(path.join(p4, '04-01-SUMMARY.md'), '---\none-liner: Polished UI\n---\n# Summary\n');

    const result = runGsdTools('milestone complete v1.1 --name "Second Release"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases, 2, 'should count only phases 3 and 4');
    assert.strictEqual(output.plans, 3, 'should count only plans from phases 3 and 4');
    assert.ok(output.accomplishments.includes('Built new feature'));
    assert.ok(output.accomplishments.includes('Polished UI'));
    assert.ok(!output.accomplishments.includes('Old setup work'));
    assert.ok(!output.accomplishments.includes('Old core work'));
  });

  test('archive-phases only archives current milestone phases', () => {
    writeRoadmap(tmpDir,
      `# Roadmap v1.1\n\n### Phase 2: Current Work\n**Goal:** Do it\n`,
    );
    writeState(tmpDir);
    mkPhaseDir(tmpDir, '01-old', { plan: true });
    mkPhaseDir(tmpDir, '02-current', { plan: true });

    assert.ok(runGsdTools('milestone complete v1.1 --name Test --archive-phases', tmpDir).success);

    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.1-phases', '02-current')));
    assert.ok(fs.existsSync(path.join(tmpDir, '.planning', 'phases', '01-old')));
  });

  test('phase 1 in roadmap does NOT match directory 10-something (no prefix collision)', () => {
    writeRoadmap(tmpDir,
      `# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n`,
    );
    writeState(tmpDir);
    mkPhaseDir(tmpDir, '01-foundation', { plan: true, oneLiner: 'Foundation work' });
    mkPhaseDir(tmpDir, '10-scaling', { plan: true, oneLiner: 'Scaling work' });

    const result = runGsdTools('milestone complete v1.0 --name MVP', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases, 1, 'should count only phase 1, not phase 10');
    assert.strictEqual(output.plans, 1);
    assert.ok(output.accomplishments.includes('Foundation work'));
    assert.ok(!output.accomplishments.includes('Scaling work'));
  });

  test('non-numeric directory is excluded when milestone scoping is active', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0\n\n### Phase 1: Core\n**Goal:** Build core\n`);
    writeState(tmpDir);
    mkPhaseDir(tmpDir, '01-core', { plan: true });
    const misc = path.join(tmpDir, '.planning', 'phases', 'notes');
    fs.mkdirSync(misc, { recursive: true });
    fs.writeFileSync(path.join(misc, 'PLAN.md'), '# Not a phase\n');

    const result = runGsdTools('milestone complete v1.0 --name Test', tmpDir);
    assert.ok(result.success);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases, 1);
    assert.strictEqual(output.plans, 1);
  });

  test('large phase numbers (456, 457) scope correctly', () => {
    writeRoadmap(tmpDir,
      `# Roadmap v1.49\n\n### Phase 456: DACP\n**Goal:** Ship DACP\n\n### Phase 457: Integration\n**Goal:** Integrate\n`,
    );
    writeState(tmpDir);
    mkPhaseDir(tmpDir, '456-dacp', { plan: true });
    mkPhaseDir(tmpDir, '457-integration', { plan: true });
    mkPhaseDir(tmpDir, '45-old', { plan: true });

    const result = runGsdTools('milestone complete v1.49 --name DACP', tmpDir);
    assert.ok(result.success);
    assert.strictEqual(JSON.parse(result.output).phases, 2);
  });

  test('counts tasks from **Tasks:** N in summary body', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n`);
    writeState(tmpDir);
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(
      path.join(p1, '01-01-SUMMARY.md'),
      `---\none-liner: Built the foundation\n---\n\n# Phase 1: Foundation Summary\n\n**Built the foundation**\n\n## Performance\n\n- **Duration:** 28 min\n- **Tasks:** 7\n- **Files modified:** 12\n`,
    );

    const result = runGsdTools('milestone complete v1.0 --name MVP', tmpDir);
    assert.ok(result.success);
    assert.strictEqual(JSON.parse(result.output).tasks, 7);
  });

  test('extracts one-liner from body when not in frontmatter', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0\n\n### Phase 1: Foundation\n**Goal:** Setup\n`);
    writeState(tmpDir);
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(
      path.join(p1, '01-01-SUMMARY.md'),
      `---\nphase: "01"\n---\n\n# Phase 1: Foundation Summary\n\n**JWT auth with refresh rotation using jose library**\n\n## Performance\n`,
    );

    const result = runGsdTools('milestone complete v1.0 --name MVP', tmpDir);
    assert.ok(result.success);
    assert.ok(JSON.parse(result.output).accomplishments.includes('JWT auth with refresh rotation using jose library'));
  });

  test('updates STATE.md with plain format fields', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0\n`);
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      `# State\n\nStatus: In progress\nLast Activity: 2025-01-01\nLast Activity Description: Working\n`,
    );

    const result = runGsdTools('milestone complete v1.0 --name Test', tmpDir);
    assert.ok(result.success);
    assert.ok(fs.readFileSync(path.join(tmpDir, '.planning', 'STATE.md'), 'utf-8').includes('v1.0 milestone complete'));
  });

  test('handles empty phases directory', () => {
    writeRoadmap(tmpDir, `# Roadmap v1.0\n`);
    writeState(tmpDir);

    const result = runGsdTools('milestone complete v1.0 --name EmptyPhases', tmpDir);
    assert.ok(result.success);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.phases, 0);
    assert.strictEqual(output.plans, 0);
    assert.strictEqual(output.tasks, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// phases clear command
// ─────────────────────────────────────────────────────────────────────────────

describe('phases clear command', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  test('deletes normal phase directories when --confirm is passed', () => {
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(p1, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan\n');

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success);
    assert.strictEqual(JSON.parse(result.output).cleared, 1);
    assert.ok(!fs.existsSync(p1));
  });

  test('requires --confirm when phase directories exist', () => {
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(p1, { recursive: true });
    assert.ok(!runGsdTools('phases clear', tmpDir).success);
  });

  test('preserves 999.x backlog phase directories during clear (#1853)', () => {
    const p1 = path.join(tmpDir, '.planning', 'phases', '01-setup');
    const p999a = path.join(tmpDir, '.planning', 'phases', '999.1-some-idea');
    const p999b = path.join(tmpDir, '.planning', 'phases', '999.2-another-idea');
    fs.mkdirSync(p1, { recursive: true });
    fs.mkdirSync(p999a, { recursive: true });
    fs.mkdirSync(p999b, { recursive: true });
    fs.writeFileSync(path.join(p1, '01-01-PLAN.md'), '# Plan\n');
    fs.writeFileSync(path.join(p999a, 'PLAN.md'), '# Backlog\n');
    fs.writeFileSync(path.join(p999b, 'PLAN.md'), '# Backlog 2\n');

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success);
    assert.strictEqual(JSON.parse(result.output).cleared, 1);
    assert.ok(!fs.existsSync(p1));
    assert.ok(fs.existsSync(p999a));
    assert.ok(fs.existsSync(p999b));
  });

  test('reports 0 cleared when only backlog phases exist', () => {
    const p999a = path.join(tmpDir, '.planning', 'phases', '999.1-idea');
    fs.mkdirSync(p999a, { recursive: true });

    const result = runGsdTools('phases clear --confirm', tmpDir);
    assert.ok(result.success);
    assert.strictEqual(JSON.parse(result.output).cleared, 0);
    assert.ok(fs.existsSync(p999a));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requirements mark-complete command — regex global-state fix (#milestone-regex-global)
// ─────────────────────────────────────────────────────────────────────────────

describe('requirements mark-complete command', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  function writeRequirements(tmpDir, content) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), content, 'utf-8');
  }

  function readRequirements(tmpDir) {
    return fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
  }

  const STANDARD_REQUIREMENTS = `# Requirements

## Test Coverage
- [ ] **TEST-01**: core.cjs has tests for loadConfig
- [ ] **TEST-02**: core.cjs has tests for resolveModelInternal
- [x] **TEST-03**: core.cjs has tests for escapeRegex (already complete)

## Bug Regressions
- [ ] **REG-01**: Test confirms loadConfig returns model_overrides

## Infrastructure
- [ ] **INFRA-01**: GitHub Actions workflow runs tests

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| TEST-01 | Phase 1 | Pending |
| TEST-02 | Phase 1 | Pending |
| TEST-03 | Phase 1 | Complete |
| REG-01 | Phase 1 | Pending |
| INFRA-01 | Phase 6 | Pending |
`;

  // #2140: a traceability table EXISTS but has no row for the ID being completed.
  // Only the checkbox can reconcile; the table surface is unsynced. The CLI must
  // not report this as a payload indistinguishable from a full reconcile.
  const TABLE_WITHOUT_FOO = `# Requirements

## Coverage
- [ ] **FOO-01**: feature one
- [ ] **BAR-01**: feature two

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| BAR-01 | Phase 1 | Pending |
`;

  test('#2140 checkbox-only reconcile surfaces table_unmatched (not silent success)', () => {
    writeRequirements(tmpDir, TABLE_WITHOUT_FOO);

    const result = runGsdTools('requirements mark-complete FOO-01', tmpDir);
    assert.ok(result.success);

    const out = JSON.parse(result.output);
    // The checkbox WAS written, so it is in marked_complete...
    assert.ok(out.marked_complete.includes('FOO-01'), 'checkbox reconcile is reported');
    // ...but the traceability table had no FOO-01 row, which must be surfaced.
    assert.ok(Array.isArray(out.table_unmatched), 'table_unmatched bucket must exist');
    assert.ok(out.table_unmatched.includes('FOO-01'),
      'an ID with a checkbox but no table row must be surfaced as table_unmatched');

    const content = readRequirements(tmpDir);
    assert.ok(content.includes('- [x] **FOO-01**'), 'checkbox should be checked');
    // The table is untouched (no FOO-01 row synthesized).
    assert.ok(!content.includes('FOO-01 | Phase'), 'no FOO-01 row should be invented');

    // ADR-2143 §6 write-set: additive structured read of the same per-surface
    // facts — checkbox surface applied (fresh write this run), traceability
    // surface did NOT (no row existed to flip), so the set is not complete.
    // This does not change `updated`/`marked_complete` above. Per-ID: each
    // outcome carries `requirement` so a multi-ID batch cannot OR one ID's
    // outcome into another's (the #2140 class one level up).
    assert.deepStrictEqual(out.write_set, [
      { requirement: 'FOO-01', surface: 'checkbox', applied: true },
      { requirement: 'FOO-01', surface: 'traceability', applied: false },
    ]);
    assert.strictEqual(out.write_set_complete, false,
      'writeSetComplete requires EVERY surface applied, not an OR — a checkbox-only write is not complete');
  });

  test('#2140 re-run on the half-written file does NOT mask the drift as already_complete', () => {
    writeRequirements(tmpDir, TABLE_WITHOUT_FOO);
    // First run: flips the checkbox, surfaces table_unmatched.
    runGsdTools('requirements mark-complete FOO-01', tmpDir);
    // Second run on the now-[x]-checkbox-with-no-row file.
    const result = runGsdTools('requirements mark-complete FOO-01', tmpDir);
    assert.ok(result.success);
    const out = JSON.parse(result.output);

    assert.ok(!out.already_complete.includes('FOO-01'),
      'a [x] checkbox with no table row is PARTIALLY reconciled, not already_complete');
    assert.ok(!out.marked_complete.includes('FOO-01'),
      'nothing flipped on re-run, so not marked_complete');
    assert.ok(out.table_unmatched.includes('FOO-01'),
      'the drift must still be surfaced as table_unmatched on re-run');

    // ADR-2143 §6 write-set: nothing was written THIS run on either surface
    // (checkbox was already [x], the row still doesn't exist), so both
    // surfaces report applied:false and the set is not complete.
    assert.deepStrictEqual(out.write_set, [
      { requirement: 'FOO-01', surface: 'checkbox', applied: false },
      { requirement: 'FOO-01', surface: 'traceability', applied: false },
    ]);
    assert.strictEqual(out.write_set_complete, false);
  });

  test('#2140 no traceability table at all → still a clean success (no table_unmatched)', () => {
    // A REQUIREMENTS.md with no traceability table is legitimate; a checkbox-only
    // reconcile must remain an unqualified success with no table_unmatched entry.
    writeRequirements(tmpDir, '# Requirements\n\n- [ ] **NO-TABLE-01**: thing\n');
    const result = runGsdTools('requirements mark-complete NO-TABLE-01', tmpDir);
    assert.ok(result.success);
    const out = JSON.parse(result.output);
    assert.ok(out.marked_complete.includes('NO-TABLE-01'));
    assert.ok(!out.table_unmatched || !out.table_unmatched.includes('NO-TABLE-01'),
      'no table_unmatched when there is no traceability table');

    // ADR-2143 §6 write-set: the traceability surface is omitted entirely
    // (not reported as a false applied:false) when the file has no
    // traceability table — nothing was required of it. A single-surface
    // write-set that fully applied is complete.
    assert.deepStrictEqual(out.write_set, [
      { requirement: 'NO-TABLE-01', surface: 'checkbox', applied: true },
    ]);
    assert.strictEqual(out.write_set_complete, true);
  });

  test('#2140-class multi-ID: one ID\'s partial reconcile is not masked by another ID\'s full one', () => {
    // Adversarial-review regression: write_set/write_set_complete were built
    // from two INVOCATION-WIDE booleans OR-accumulated across every ID in the
    // batch, so a fully-reconciled REQ-02 in the same call could mask a
    // checkbox-only partial write on REQ-01. The write-set must be tracked
    // PER (requirement, surface) so REQ-01's unmatched traceability row
    // cannot be hidden by REQ-02 reconciling cleanly.
    writeRequirements(
      tmpDir,
      `# Requirements

## Coverage
- [ ] **REQ-01**: feature one (no traceability row)
- [ ] **REQ-02**: feature two (has traceability row)

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| REQ-02 | Phase 1 | Pending |
`,
    );

    const result = runGsdTools('requirements mark-complete REQ-01,REQ-02', tmpDir);
    assert.ok(result.success);
    const out = JSON.parse(result.output);

    // Pre-existing fields are unchanged: both checkboxes flip (marked_complete),
    // REQ-01 has no table row so it surfaces as table_unmatched.
    assert.deepStrictEqual(out.marked_complete.sort(), ['REQ-01', 'REQ-02']);
    assert.deepStrictEqual(out.table_unmatched, ['REQ-01']);
    assert.deepStrictEqual(out.not_found, []);
    assert.deepStrictEqual(out.already_complete, []);

    const content = readRequirements(tmpDir);
    assert.ok(content.includes('- [x] **REQ-01**'), 'REQ-01 checkbox should be checked');
    assert.ok(content.includes('- [x] **REQ-02**'), 'REQ-02 checkbox should be checked');
    assert.ok(content.includes('| REQ-02 | Phase 1 | Complete |'), 'REQ-02 table row should be Complete');
    assert.ok(!content.includes('REQ-01 | Phase'), 'no REQ-01 row should be invented');

    // The write-set is now per-ID: REQ-01's traceability surface did NOT
    // apply (no row to flip) even though REQ-02's did — the aggregate must
    // not OR REQ-02's success into REQ-01's outcome.
    assert.deepStrictEqual(out.write_set, [
      { requirement: 'REQ-01', surface: 'checkbox', applied: true },
      { requirement: 'REQ-01', surface: 'traceability', applied: false },
      { requirement: 'REQ-02', surface: 'checkbox', applied: true },
      { requirement: 'REQ-02', surface: 'traceability', applied: true },
    ]);
    // Because REQ-01's traceability entry did not apply, the batch as a
    // whole is NOT complete — this is the exact bug the fix closes.
    assert.strictEqual(out.write_set_complete, false,
      'REQ-01\'s unmatched traceability row must not be masked by REQ-02 fully reconciling');
  });

  test('#2140-class multi-ID: fully-reconciled batch reports write_set_complete:true', () => {
    writeRequirements(
      tmpDir,
      `# Requirements

## Coverage
- [ ] **REQ-01**: feature one
- [ ] **REQ-02**: feature two

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| REQ-01 | Phase 1 | Pending |
| REQ-02 | Phase 1 | Pending |
`,
    );

    const result = runGsdTools('requirements mark-complete REQ-01,REQ-02', tmpDir);
    assert.ok(result.success);
    const out = JSON.parse(result.output);

    assert.deepStrictEqual(out.marked_complete.sort(), ['REQ-01', 'REQ-02']);
    assert.deepStrictEqual(out.table_unmatched, []);

    assert.deepStrictEqual(out.write_set, [
      { requirement: 'REQ-01', surface: 'checkbox', applied: true },
      { requirement: 'REQ-01', surface: 'traceability', applied: true },
      { requirement: 'REQ-02', surface: 'checkbox', applied: true },
      { requirement: 'REQ-02', surface: 'traceability', applied: true },
    ]);
    assert.strictEqual(out.write_set_complete, true);
  });

  test('marks single requirement complete (checkbox + table)', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    const result = runGsdTools('requirements mark-complete TEST-01', tmpDir);
    assert.ok(result.success);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true);
    assert.ok(output.marked_complete.includes('TEST-01'));

    const content = readRequirements(tmpDir);
    assert.ok(content.includes('- [x] **TEST-01**'), 'checkbox should be checked');
    assert.ok(content.includes('| TEST-01 | Phase 1 | Complete |'), 'table row should be Complete');
    assert.ok(content.includes('- [ ] **TEST-02**'), 'TEST-02 should remain unchecked');

    // ADR-2143 §6 write-set: both surfaces got a fresh write this run, so the
    // write-set is complete.
    assert.deepStrictEqual(output.write_set, [
      { requirement: 'TEST-01', surface: 'checkbox', applied: true },
      { requirement: 'TEST-01', surface: 'traceability', applied: true },
    ]);
    assert.strictEqual(output.write_set_complete, true);
  });

  test('#2245 F1: traceability write is NOT fooled by an earlier Out of Scope table', () => {
    // The shipped requirements template (gsd-core/templates/requirements.md)
    // puts an `## Out of Scope` table (`| Feature | Reason |`, no Status
    // column) BEFORE `## Traceability`. updateTableCell binds to the FIRST
    // GFM table in whatever text it is given — an unscoped whole-file call
    // targets the Out-of-Scope table instead and silently fails with
    // `unknown column: Status`, so the real Traceability row is never
    // flipped even though the checkbox surface flips and the command
    // reports success (the #2140 silent-divergence class one level deeper).
    writeRequirements(
      tmpDir,
      `# Requirements

## Coverage
- [ ] **REQ-001**: feature one

## Out of Scope

| Feature | Reason |
|---------|--------|
| Foo | Bar |

## Traceability

| REQ-ID | Phase | Status |
|--------|-------|--------|
| REQ-001 | 1 | Pending |
`,
    );

    const result = runGsdTools('requirements mark-complete REQ-001', tmpDir);
    assert.ok(result.success);
    const out = JSON.parse(result.output);

    assert.ok(out.marked_complete.includes('REQ-001'));
    assert.deepStrictEqual(out.table_unmatched, [],
      'the Traceability row for REQ-001 DOES exist — it must not be reported as unmatched');
    assert.deepStrictEqual(out.write_set, [
      { requirement: 'REQ-001', surface: 'checkbox', applied: true },
      { requirement: 'REQ-001', surface: 'traceability', applied: true },
    ]);
    assert.strictEqual(out.write_set_complete, true,
      'both surfaces applied — the write is fully reconciled, not just the checkbox');

    const content = readRequirements(tmpDir);
    assert.ok(content.includes('- [x] **REQ-001**'), 'checkbox should be checked');
    assert.ok(content.includes('| REQ-001 | 1 | Complete |'),
      'the Traceability row (NOT the Out of Scope table) must be flipped to Complete');
    assert.ok(content.includes('| Foo | Bar |'), 'the Out of Scope table must be left untouched');
  });

  test('handles mixed prefixes in single call (TEST-XX, REG-XX, INFRA-XX)', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    const result = runGsdTools('requirements mark-complete TEST-01,REG-01,INFRA-01', tmpDir);
    assert.ok(result.success);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.marked_complete.length, 3);
    assert.ok(output.marked_complete.includes('TEST-01'));
    assert.ok(output.marked_complete.includes('REG-01'));
    assert.ok(output.marked_complete.includes('INFRA-01'));

    const content = readRequirements(tmpDir);
    assert.ok(content.includes('- [x] **TEST-01**'));
    assert.ok(content.includes('- [x] **REG-01**'));
    assert.ok(content.includes('- [x] **INFRA-01**'));
    assert.ok(content.includes('| TEST-01 | Phase 1 | Complete |'));
    assert.ok(content.includes('| REG-01 | Phase 1 | Complete |'));
    assert.ok(content.includes('| INFRA-01 | Phase 6 | Complete |'));
  });

  test('accepts space-separated IDs', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    const result = runGsdTools('requirements mark-complete TEST-01 TEST-02', tmpDir);
    assert.ok(result.success);
    assert.strictEqual(JSON.parse(result.output).marked_complete.length, 2);

    const content = readRequirements(tmpDir);
    assert.ok(content.includes('- [x] **TEST-01**'));
    assert.ok(content.includes('- [x] **TEST-02**'));
  });

  test('accepts bracket-wrapped IDs [REQ-01, REQ-02]', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    const result = runGsdTools('requirements mark-complete [TEST-01,TEST-02]', tmpDir);
    assert.ok(result.success);
    assert.strictEqual(JSON.parse(result.output).marked_complete.length, 2);

    const content = readRequirements(tmpDir);
    assert.ok(content.includes('- [x] **TEST-01**'));
    assert.ok(content.includes('- [x] **TEST-02**'));
  });

  test('returns not_found for invalid IDs while updating valid ones', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    const result = runGsdTools('requirements mark-complete TEST-01,FAKE-99', tmpDir);
    assert.ok(result.success);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.updated, true);
    assert.ok(output.marked_complete.includes('TEST-01'));
    assert.ok(output.not_found.includes('FAKE-99'));
    assert.strictEqual(output.total, 2);
  });

  test('idempotent — re-marking already-complete requirement does not corrupt', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    const result = runGsdTools('requirements mark-complete TEST-03', tmpDir);
    assert.ok(result.success);

    const output = JSON.parse(result.output);
    assert.ok(output.already_complete.includes('TEST-03'));
    assert.deepStrictEqual(output.not_found, []);

    const content = readRequirements(tmpDir);
    assert.ok(content.includes('- [x] **TEST-03**'));
    assert.ok(!content.includes('[xx]'));
    assert.ok(!content.includes('- [x] [x]'));
  });

  test('returns already_complete for idempotent calls on completed requirements', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    const output = JSON.parse(runGsdTools('requirements mark-complete TEST-03', tmpDir).output);
    assert.deepStrictEqual(output.already_complete, ['TEST-03']);
    assert.deepStrictEqual(output.not_found, []);
  });

  test('mixed: updates pending, reports already-complete, and flags missing', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);

    const output = JSON.parse(
      runGsdTools('requirements mark-complete TEST-01,TEST-03,FAKE-99', tmpDir).output,
    );
    assert.deepStrictEqual(output.marked_complete, ['TEST-01']);
    assert.deepStrictEqual(output.already_complete, ['TEST-03']);
    assert.deepStrictEqual(output.not_found, ['FAKE-99']);
  });

  test('missing REQUIREMENTS.md returns expected error structure', () => {
    const output = JSON.parse(runGsdTools('requirements mark-complete TEST-01', tmpDir).output);
    assert.strictEqual(output.updated, false);
    assert.strictEqual(output.reason, 'REQUIREMENTS.md not found');
  });

  // #2788: a requirement row stranded at `Gaps Found` (by revert-phase, the
  // gaps_found response) must be recoverable — mark-complete moves it to Complete.
  // Pre-fix the `/^pending$/i` guard rejected `Gaps Found`, stranding the row
  // permanently (no inverse transition existed) AND mark-complete reported
  // `updated: true` while the row stayed `Gaps Found` (defect 2, the lie).
  const GAPS_FOUND_REQUIREMENTS = `# Requirements

## Coverage
- [ ] **REQ-01**: feature one
- [ ] **REQ-02**: feature two

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| REQ-01 | Phase 1 | Gaps Found |
| REQ-02 | Phase 1 | Complete |
`;

  test('#2788 defect 1: a Gaps Found row moves to Complete via mark-complete (no longer terminal)', () => {
    writeRequirements(tmpDir, GAPS_FOUND_REQUIREMENTS);
    const result = runGsdTools('requirements mark-complete REQ-01', tmpDir);
    assert.ok(result.success);
    const out = JSON.parse(result.output);
    // The row EXISTS and moved to Complete, so updated/marked_complete are truthful.
    assert.ok(out.updated, 'the stranded Gaps Found row must be recoverable');
    assert.ok(out.marked_complete.includes('REQ-01'));
    const content = readRequirements(tmpDir);
    assert.ok(/REQ-01 \| Phase 1 \| Complete/.test(content),
      'the row must read Complete after mark-complete; got:\n' + content);
    assert.ok(content.includes('- [x] **REQ-01**'), 'the checkbox must be checked');
  });

  test('#2788 defect 2: when a row EXISTS but the write is rejected, updated is FALSE (no false success)', () => {
    // A row at `Blocked` (a status mark-complete does not accept) EXISTS for REQ-01.
    // The checkbox flips, but the row does not move — `updated` must be false so the
    // operator is not told it worked while the audit row still reads Blocked.
    const blockedRequirements = `# Requirements

## Coverage
- [ ] **REQ-01**: feature one

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| REQ-01 | Phase 1 | Blocked |
`;
    writeRequirements(tmpDir, blockedRequirements);
    const result = runGsdTools('requirements mark-complete REQ-01', tmpDir);
    assert.ok(result.success);
    const out = JSON.parse(result.output);
    assert.strictEqual(out.updated, false,
      'a checkbox flip on a table-bearing file whose row EXISTS but did not move must NOT report updated:true');
    assert.ok(!out.marked_complete.includes('REQ-01'),
      'REQ-01 must not be in marked_complete when the row write was rejected');
    const content = readRequirements(tmpDir);
    assert.ok(/REQ-01 \| Phase 1 \| Blocked/.test(content),
      'the row must still read Blocked (write rejected); got:\n' + content);
    // #2788 defect 2: the checkbox must NOT flip when the row write is rejected —
    // the checkbox and the row are two representations of the same fact, so they
    // must not silently diverge. The checkbox stays unchecked on disk.
    assert.ok(content.includes('- [ ] **REQ-01**'),
      'the checkbox must stay unchecked when the row write was rejected; got:\n' + content);
    // write_set carries the truth: NEITHER surface applied (checkbox rolled back,
    // traceability rejected).
    const checkboxEntry = out.write_set.find(
      (e) => e.requirement === 'REQ-01' && e.surface === 'checkbox');
    assert.ok(checkboxEntry && checkboxEntry.applied === false,
      'write_set must record the checkbox surface as not applied (rolled back)');
    const traceabilityEntry = out.write_set.find(
      (e) => e.requirement === 'REQ-01' && e.surface === 'traceability');
    assert.ok(traceabilityEntry && traceabilityEntry.applied === false,
      'write_set must record the traceability surface as not applied');
  });

  test('#2788 end-to-end: revert-phase (Complete → Gaps Found) then mark-complete (Gaps Found → Complete) round-trips', () => {
    const completeRequirements = `# Requirements

## Coverage
- [x] **REQ-01**: feature one

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| REQ-01 | Phase 1 | Complete |
`;
    writeRequirements(tmpDir, completeRequirements);
    // revert-phase strands the row at Gaps Found (the gaps_found response).
    const reverted = JSON.parse(runGsdTools('requirements revert-phase REQ-01', tmpDir).output);
    assert.ok(reverted.reverted.includes('REQ-01'));
    let content = readRequirements(tmpDir);
    assert.ok(/REQ-01 \| Phase 1 \| Gaps Found/.test(content), 'revert should strand at Gaps Found');
    // Now the requirement is genuinely satisfied again — mark-complete must recover it.
    const marked = JSON.parse(runGsdTools('requirements mark-complete REQ-01', tmpDir).output);
    assert.ok(marked.updated, 'the stranded row must be recoverable via mark-complete');
    content = readRequirements(tmpDir);
    assert.ok(/REQ-01 \| Phase 1 \| Complete/.test(content),
      'after mark-complete the row must read Complete again');
  });

  test('#2788 negative-space: the normal Pending → Complete path is unchanged', () => {
    writeRequirements(tmpDir, STANDARD_REQUIREMENTS);
    const out = JSON.parse(runGsdTools('requirements mark-complete TEST-01', tmpDir).output);
    assert.ok(out.updated);
    assert.ok(out.marked_complete.includes('TEST-01'));
    const content = readRequirements(tmpDir);
    assert.ok(/TEST-01 \| Phase 1 \| Complete/.test(content), 'Pending row still moves to Complete');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requirements mark-complete: traceability write (regression, ADR-2143 §7)
// ─────────────────────────────────────────────────────────────────────────────

describe('requirements mark-complete: traceability write (regression, ADR-2143 §7)', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  function writeRequirements(tmpDir, content) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), content, 'utf-8');
  }

  function readRequirements(tmpDir) {
    return fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
  }

  test('multi-ID batch: both rows flip, no regex lastIndex/global-state leak', () => {
    // Behavioural replacement for the retired structural guard: the old
    // test()+replace() idiom on a global regex would advance lastIndex on the
    // first ID's probe and silently miss the second ID's row. Two Pending
    // rows in one table, both IDs in a single invocation, both must flip.
    writeRequirements(
      tmpDir,
      `# Requirements

## Coverage
- [ ] **REQ-001**: feature one
- [ ] **REQ-002**: feature two

## Traceability

| REQ-ID | Phase | Status |
|--------|-------|--------|
| REQ-001 | Phase 1 | Pending |
| REQ-002 | Phase 1 | Pending |
`,
    );

    const result = runGsdTools('requirements mark-complete REQ-001,REQ-002', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.deepStrictEqual(out.marked_complete.sort(), ['REQ-001', 'REQ-002']);

    const content = readRequirements(tmpDir);
    assert.ok(
      content.includes('| REQ-001 | Phase 1 | Complete |'),
      'REQ-001 row should flip to Complete',
    );
    assert.ok(
      content.includes('| REQ-002 | Phase 1 | Complete |'),
      'REQ-002 row should flip to Complete — a global-regex lastIndex leak would miss this row',
    );
  });

  for (const header of ['REQ-ID', 'Requirement']) {
    test(`traceability row matched regardless of ID-column header name ('${header}') (#2769/#2203)`, () => {
      // Real tables head the requirement-ID column 'REQ-ID'; some head it
      // 'Requirement'. The row must be matched by its FIRST cell's value,
      // independent of what that column is named in the header.
      writeRequirements(
        tmpDir,
        `# Requirements

## Coverage
- [ ] **REQ-001**: feature one

## Traceability

| ${header} | Phase | Status |
|${'-'.repeat(header.length + 2)}|-------|--------|
| REQ-001 | Phase 1 | Pending |
`,
      );

      const result = runGsdTools('requirements mark-complete REQ-001', tmpDir);
      assert.ok(result.success, `Command failed: ${result.error}`);

      const out = JSON.parse(result.output);
      assert.ok(
        out.marked_complete.includes('REQ-001'),
        `REQ-001 should be marked complete under '${header}' header`,
      );

      const content = readRequirements(tmpDir);
      assert.ok(
        content.includes('| REQ-001 | Phase 1 | Complete |'),
        `REQ-001 row should flip to Complete under '${header}' header`,
      );
    });
  }

  test('REQ-ID-headed table participates in write_set (#2769/#2203)', () => {
    // hasTable must recognize a REQ-ID header (not just 'Requirement') so the
    // traceability surface is tracked in write_set, not silently omitted
    // despite the row actually flipping.
    writeRequirements(
      tmpDir,
      `# Requirements

## Coverage
- [ ] **REQ-001**: feature one

## Traceability

| REQ-ID | Phase | Status |
|--------|-------|--------|
| REQ-001 | Phase 1 | Pending |
`,
    );

    const result = runGsdTools('requirements mark-complete REQ-001', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.deepStrictEqual(out.write_set, [
      { requirement: 'REQ-001', surface: 'checkbox', applied: true },
      { requirement: 'REQ-001', surface: 'traceability', applied: true },
    ]);
    assert.strictEqual(out.write_set_complete, true);
  });

  test('REQ-ID-headed table trips #2140 table_unmatched drift check on a missing row', () => {
    // Checkbox flips, but there is no REQ-001 row in the REQ-ID-headed table.
    // Before the hasTable fix this was silently treated as "no table
    // required" (hasTable false for REQ-ID headers) and table_unmatched never
    // fired — masking the exact #2140 partial-reconcile class for the
    // real-world table format.
    writeRequirements(
      tmpDir,
      `# Requirements

## Coverage
- [ ] **REQ-001**: feature one (no traceability row)
- [ ] **REQ-002**: feature two (has traceability row)

## Traceability

| REQ-ID | Phase | Status |
|--------|-------|--------|
| REQ-002 | Phase 1 | Pending |
`,
    );

    const result = runGsdTools('requirements mark-complete REQ-001', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.deepStrictEqual(out.table_unmatched, ['REQ-001']);

    const content = readRequirements(tmpDir);
    assert.ok(content.includes('- [x] **REQ-001**'), 'REQ-001 checkbox should be checked');
    assert.ok(!content.includes('REQ-001 | Phase'), 'no REQ-001 row should be invented');
  });

  test('idempotent: already-Complete row reports already_complete, no double-write/corruption', () => {
    writeRequirements(
      tmpDir,
      `# Requirements

## Coverage
- [x] **REQ-001**: feature one

## Traceability

| REQ-ID | Phase | Status |
|--------|-------|--------|
| REQ-001 | Phase 1 | Complete |
`,
    );

    const result = runGsdTools('requirements mark-complete REQ-001', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const out = JSON.parse(result.output);
    assert.deepStrictEqual(out.already_complete, ['REQ-001']);
    assert.deepStrictEqual(out.marked_complete, []);

    const content = readRequirements(tmpDir);
    const rowMatches = content.match(/\|\s*REQ-001\s*\|\s*Phase 1\s*\|\s*Complete\s*\|/g) || [];
    assert.strictEqual(
      rowMatches.length, 1,
      `expected exactly one unchanged REQ-001 row, got ${rowMatches.length} (no double-write/corruption)`,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requirements ready-ids command — shared-ID sibling-plan gate (#2388)
// ─────────────────────────────────────────────────────────────────────────────

describe('requirements ready-ids command (#2388 shared-ID gate)', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  function writeRequirements(tmpDir, content) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), content, 'utf-8');
  }

  function readRequirements(tmpDir) {
    return fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
  }

  function makePhaseDir(tmpDir) {
    const dir = path.join(tmpDir, '.planning', 'phases', '05-05-feature');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  const SHARED_REQUIREMENTS = `# Requirements

## Feature

- [ ] **SHARED-01**: shared across two plans
- [ ] **SOLO-01**: only plan-02 declares this

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| SHARED-01 | Phase 5 | Pending |
| SOLO-01 | Phase 5 | Pending |
`;

  // #2388 acceptance criteria 2+3: a requirement ID shared by two plans in
  // the same phase must not read Complete until BOTH plans have a SUMMARY —
  // then, once the last declaring plan finishes, it marks Complete via the
  // normal (unmodified) mark-complete path.
  test('shared ID stays Pending until every declaring plan has a SUMMARY, then marks Complete', () => {
    writeRequirements(tmpDir, SHARED_REQUIREMENTS);
    const dir = makePhaseDir(tmpDir);
    const plan1 = path.join(dir, '05-05-01-a-PLAN.md');
    const plan2 = path.join(dir, '05-05-02-b-PLAN.md');
    fs.writeFileSync(plan1, '---\nphase: 05-05\nplan: 01\nrequirements: [SHARED-01]\n---\nPlan A\n');
    fs.writeFileSync(plan2, '---\nphase: 05-05\nplan: 02\nrequirements: [SHARED-01, SOLO-01]\n---\nPlan B\n');

    // Plan 01 finishes first (its own SUMMARY now exists) and gates its own
    // requirement IDs before calling mark-complete — plan 02 has not
    // finished yet, so SHARED-01 must be blocked.
    fs.writeFileSync(path.join(dir, '05-05-01-a-SUMMARY.md'), 'done\n');
    const readyForPlan1 = JSON.parse(
      runGsdTools(['query', 'requirements.ready-ids', plan1, 'SHARED-01'], tmpDir).output,
    );
    assert.deepStrictEqual(readyForPlan1.ready, [], 'SHARED-01 must be blocked — plan 02 has not finished yet');
    assert.deepStrictEqual(readyForPlan1.blocked, ['SHARED-01']);

    // The workflow only hands the READY subset to mark-complete (empty here),
    // so REQUIREMENTS.md must be untouched.
    let content = readRequirements(tmpDir);
    assert.ok(content.includes('- [ ] **SHARED-01**'), 'SHARED-01 checkbox must stay unchecked');
    assert.ok(content.includes('| SHARED-01 | Phase 5 | Pending |'), 'SHARED-01 traceability must stay Pending');

    // Plan 02 finishes: its own SUMMARY now exists too, so when IT gates its
    // own IDs, plan 01 (the sibling) already has a SUMMARY — SHARED-01 is
    // ready. SOLO-01 has no sibling declaring it at all, so it was always ready.
    fs.writeFileSync(path.join(dir, '05-05-02-b-SUMMARY.md'), 'done\n');
    const readyForPlan2 = JSON.parse(
      runGsdTools(['query', 'requirements.ready-ids', plan2, 'SHARED-01,SOLO-01'], tmpDir).output,
    );
    assert.deepStrictEqual(readyForPlan2.ready.sort(), ['SHARED-01', 'SOLO-01']);
    assert.deepStrictEqual(readyForPlan2.blocked, []);

    // Hand the ready subset to the UNMODIFIED mark-complete path.
    runGsdTools(['query', 'requirements.mark-complete', ...readyForPlan2.ready], tmpDir);
    content = readRequirements(tmpDir);
    assert.ok(content.includes('- [x] **SHARED-01**'), 'SHARED-01 checkbox should now be checked');
    assert.ok(content.includes('| SHARED-01 | Phase 5 | Complete |'), 'SHARED-01 traceability should now be Complete');
  });

  // #2388 acceptance criteria 4: a single-plan (non-shared) ID must not incur
  // any added latency — it is ready even before its OWN plan has a SUMMARY,
  // as long as no sibling plan also declares it.
  test('a single-plan (non-shared) requirement ID is always ready — no added latency', () => {
    writeRequirements(tmpDir, SHARED_REQUIREMENTS);
    const dir = makePhaseDir(tmpDir);
    const plan1 = path.join(dir, '05-05-01-a-PLAN.md');
    fs.writeFileSync(plan1, '---\nphase: 05-05\nplan: 01\nrequirements: [SOLO-01]\n---\nSolo plan\n');

    const result = JSON.parse(
      runGsdTools(['query', 'requirements.ready-ids', plan1, 'SOLO-01'], tmpDir).output,
    );
    assert.deepStrictEqual(result.ready, ['SOLO-01']);
    assert.deepStrictEqual(result.blocked, []);
  });

  test('no sibling *-PLAN.md files at all → every ID is ready', () => {
    writeRequirements(tmpDir, SHARED_REQUIREMENTS);
    const dir = makePhaseDir(tmpDir);
    const plan1 = path.join(dir, '05-05-01-a-PLAN.md');
    fs.writeFileSync(plan1, '---\nphase: 05-05\nplan: 01\nrequirements: [SHARED-01]\n---\nOnly plan\n');

    const result = JSON.parse(
      runGsdTools(['query', 'requirements.ready-ids', plan1, 'SHARED-01'], tmpDir).output,
    );
    assert.deepStrictEqual(result.ready, ['SHARED-01']);
    assert.deepStrictEqual(result.blocked, []);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// requirements revert-phase command — gaps_found revert (#2388)
// ─────────────────────────────────────────────────────────────────────────────

describe('requirements revert-phase command (#2388 gaps_found revert)', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => { cleanup(tmpDir); });

  function writeRequirements(tmpDir, content) {
    fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), content, 'utf-8');
  }

  function readRequirements(tmpDir) {
    return fs.readFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), 'utf-8');
  }

  // #2388 acceptance criterion 5 (phase-scoping): reverting one phase's IDs
  // must never touch a DIFFERENT phase's Complete row.
  test('reverts a phase\'s own Complete IDs (checkbox + traceability) without touching another phase\'s Complete', () => {
    writeRequirements(
      tmpDir,
      `# Requirements

## Feature

- [x] **PHASE5-01**: phase 5 thing
- [x] **PHASE6-01**: phase 6 thing

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| PHASE5-01 | Phase 5 | Complete |
| PHASE6-01 | Phase 6 | Complete |
`,
    );

    const result = runGsdTools('requirements revert-phase PHASE5-01', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.deepStrictEqual(out.reverted, ['PHASE5-01']);
    assert.deepStrictEqual(out.unchanged, []);

    const content = readRequirements(tmpDir);
    assert.ok(content.includes('- [ ] **PHASE5-01**'), 'PHASE5-01 checkbox must revert to unchecked');
    assert.ok(content.includes('| PHASE5-01 | Phase 5 | Gaps Found |'), 'PHASE5-01 traceability must revert to Gaps Found');
    assert.ok(content.includes('- [x] **PHASE6-01**'), 'a DIFFERENT phase\'s Complete checkbox must be untouched');
    assert.ok(content.includes('| PHASE6-01 | Phase 6 | Complete |'), 'a DIFFERENT phase\'s traceability row must be untouched');
  });

  test('an ID that is not currently Complete is reported unchanged, not reverted', () => {
    writeRequirements(
      tmpDir,
      `# Requirements

## Feature

- [ ] **PHASE5-01**: not complete yet

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| PHASE5-01 | Phase 5 | Pending |
`,
    );

    const result = runGsdTools('requirements revert-phase PHASE5-01', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.deepStrictEqual(out.reverted, []);
    assert.deepStrictEqual(out.unchanged, ['PHASE5-01']);

    const content = readRequirements(tmpDir);
    assert.ok(content.includes('- [ ] **PHASE5-01**'), 'checkbox must stay unchecked (nothing to revert)');
    assert.ok(content.includes('| PHASE5-01 | Phase 5 | Pending |'), 'traceability status must stay Pending (nothing to revert)');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// new-milestone workflow verification gate (#1269)
// ─────────────────────────────────────────────────────────────────────────────

describe('new-milestone workflow verification gate', () => {
  test('new-milestone workflow has verification step before writing PROJECT.md', () => {
    const workflowPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'new-milestone.md');
    const content = fs.readFileSync(workflowPath, 'utf8');

    assert.ok(content.includes('Verify Milestone Understanding'));
    const verifyIdx = content.indexOf('Verify Milestone Understanding');
    const updateIdx = content.indexOf('## 4. Update PROJECT.md');
    assert.ok(verifyIdx > 0);
    assert.ok(updateIdx > 0);
    assert.ok(verifyIdx < updateIdx);
  });

  test('verification step uses AskUserQuestion with adjust loop', () => {
    const workflowPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'new-milestone.md');
    const content = fs.readFileSync(workflowPath, 'utf8');

    const section = content.slice(content.indexOf('## 3.5'), content.indexOf('## 4.'));
    assert.ok(section.includes('AskUserQuestion'));
    assert.ok(section.includes('Adjust'));
    assert.ok(section.includes('Looks good'));
    assert.ok(
      section.includes('Loop until') || section.includes('loop until') || section.includes('re-present'),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// milestone complete respects explicit version scope (#3043)
// ─────────────────────────────────────────────────────────────────────────────

describe('milestone complete explicit version scope (#3043)', () => {
  test('milestone.complete v3.6 uses v3.6 phases even when STATE milestone is v3.5', () => {
    const tmpDir = createTempProject('gsd-bug-3043-');
    try {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '---\nmilestone: v3.5\n---\n');
      writeRoadmap(
        tmpDir,
        '# Roadmap\n\n## 🚧 v3.5 Paused\n### Phase 103: old\n### Phase 104: old2\n\n## 🚧 v3.6 Current\n### Phase 108: new\n',
      );
      fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), '# Requirements\n');

      for (const [dir, liner] of [['103.old', 'old milestone A'], ['104.old', 'old milestone B'], ['108.new', 'new milestone']]) {
        const p = path.join(tmpDir, '.planning', 'phases', dir);
        fs.mkdirSync(p, { recursive: true });
        fs.writeFileSync(path.join(p, 'SUMMARY.md'), `one-liner: ${liner}\n\n## Summary\n${liner.split(' ')[0]}\n`);
      }

      const result = runGsdTools(['milestone', 'complete', 'v3.6', '--raw'], tmpDir);
      assert.equal(result.success, true, result.error || result.output);
      const payload = JSON.parse(result.output);
      assert.equal(payload.version, 'v3.6');
      assert.equal(payload.phases, 1, `expected 1 phase for v3.6, got ${payload.phases}`);
    } finally {
      cleanup(tmpDir);
    }
  });

  test('milestone.complete fails when explicit milestone version resolves no phases', () => {
    const tmpDir = createTempProject('gsd-bug-3043-empty-');
    try {
      fs.writeFileSync(path.join(tmpDir, '.planning', 'STATE.md'), '---\nmilestone: v1.0\n---\n');
      writeRoadmap(tmpDir, '# Roadmap\n\n## 🚧 v1.0\n### Phase 1: foundation\n');
      fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), '# Requirements\n');
      fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-foundation'), { recursive: true });

      const result = runGsdTools(['milestone', 'complete', 'v9.9', '--raw'], tmpDir);
      assert.equal(result.success, false, 'expected command to fail when no phases match explicit version');
      assert.match(result.error || '', /no phases|phase/i);
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1911: milestone complete --ws must archive to the workstream, not root
// ─────────────────────────────────────────────────────────────────────────────

describe('#1911 — milestone complete --ws archives to the workstream', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => cleanup(tmpDir));

  test('--ws archives roadmap/requirements into the workstream milestones dir, not root', () => {
    const wsBase = path.join(tmpDir, '.planning', 'workstreams', 'ws1');
    fs.mkdirSync(path.join(wsBase, 'phases', '01-foo'), { recursive: true });
    fs.writeFileSync(path.join(wsBase, 'STATE.md'), 'milestone: v2.0\nstatus: executing\n');
    fs.writeFileSync(
      path.join(wsBase, 'ROADMAP.md'),
      '# Roadmap\n## Milestones\n- v2.0 Test (Phases 1) — IN PROGRESS\n## Phases\n### Phase 1: Foo\n**Goal:** foo\n',
    );
    fs.writeFileSync(path.join(wsBase, 'REQUIREMENTS.md'), '# Requirements\n- [ ] REQ-01\n');
    fs.writeFileSync(path.join(wsBase, 'phases', '01-foo', '01-SUMMARY.md'), '---\none-liner: foo done\n---\n# Summary\n');
    // Root milestones dir pre-exists; it must NOT receive the workstream archive.
    fs.mkdirSync(path.join(tmpDir, '.planning', 'milestones'), { recursive: true });

    const result = runGsdTools('milestone complete v2.0 --ws ws1 --force', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    // Archive lands inside the workstream.
    assert.ok(
      fs.existsSync(path.join(wsBase, 'milestones', 'v2.0-ROADMAP.md')),
      'v2.0-ROADMAP.md should be archived into the workstream milestones dir',
    );
    assert.ok(
      fs.existsSync(path.join(wsBase, 'milestones', 'v2.0-REQUIREMENTS.md')),
      'v2.0-REQUIREMENTS.md should be archived into the workstream milestones dir',
    );
    // And NOT in root.
    assert.ok(
      !fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v2.0-ROADMAP.md')),
      'must not archive to root .planning/milestones/ in workstream mode',
    );
  });

  test('#1993 — --ws requirements archive header points at the workstream REQUIREMENTS.md, not root', () => {
    const wsBase = path.join(tmpDir, '.planning', 'workstreams', 'ws1');
    fs.mkdirSync(path.join(wsBase, 'phases', '01-foo'), { recursive: true });
    fs.writeFileSync(path.join(wsBase, 'STATE.md'), 'milestone: v2.0\nstatus: executing\n');
    fs.writeFileSync(
      path.join(wsBase, 'ROADMAP.md'),
      '# Roadmap\n## Milestones\n- v2.0 Test (Phases 1) — IN PROGRESS\n## Phases\n### Phase 1: Foo\n**Goal:** foo\n',
    );
    fs.writeFileSync(path.join(wsBase, 'REQUIREMENTS.md'), '# Requirements\n- [ ] REQ-01\n');
    fs.writeFileSync(path.join(wsBase, 'phases', '01-foo', '01-SUMMARY.md'), '---\none-liner: foo done\n---\n# Summary\n');
    fs.mkdirSync(path.join(tmpDir, '.planning', 'milestones'), { recursive: true });

    const result = runGsdTools('milestone complete v2.0 --ws ws1 --force', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const archivedReq = fs.readFileSync(
      path.join(wsBase, 'milestones', 'v2.0-REQUIREMENTS.md'), 'utf-8',
    );
    // Header must point readers at the WORKSTREAM requirements file...
    assert.ok(
      archivedReq.includes('see `.planning/workstreams/ws1/REQUIREMENTS.md`'),
      `workstream archive header must reference the workstream path; got:\n${archivedReq.split(/\r?\n/).slice(0, 6).join('\n')}`,
    );
    // ...and must NOT point at the root path (the #1993 bug).
    assert.ok(
      !/\bsee\s+`\.planning\/REQUIREMENTS\.md`\b/.test(archivedReq),
      'workstream archive header must not hardcode the root REQUIREMENTS.md path',
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// #1871: milestone complete archives phase dirs by default
// ─────────────────────────────────────────────────────────────────────────────

describe('#1871 — milestone complete archives phase dirs by default', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempProject(); });
  afterEach(() => cleanup(tmpDir));

  function seedCompletableMilestone() {
    writeRoadmap(tmpDir, '# Roadmap v1.0 MVP\n\n### Phase 1: Foundation\n**Goal:** Setup\n');
    fs.writeFileSync(path.join(tmpDir, '.planning', 'REQUIREMENTS.md'), '# Requirements\n- [ ] x\n');
    writeState(tmpDir);
    mkPhaseDir(tmpDir, '01-foundation', { oneLiner: 'Set up project infrastructure' });
  }

  test('archives phase dirs by default (no --archive-phases flag needed)', () => {
    seedCompletableMilestone();
    const result = runGsdTools('milestone complete v1.0 --name MVP', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.ok(out.archived.phases, 'phases should be archived by default');
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '01-foundation')),
      'phase dir should be archived under milestones/v1.0-phases/',
    );
  });

  test('--no-archive-phases opts out of default archiving', () => {
    seedCompletableMilestone();
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-foundation');
    const result = runGsdTools('milestone complete v1.0 --name MVP --no-archive-phases', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);
    const out = JSON.parse(result.output);
    assert.ok(!out.archived.phases, 'phases should NOT be archived with --no-archive-phases');
    assert.ok(fs.existsSync(phaseDir), 'phase dir should remain in place with --no-archive-phases');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-978-milestone-complete-force.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-978-milestone-complete-force (consolidation epic #1969 B2 #1971)", () => {
'use strict';

/**
 * Regression test for bug #978: `gsd-tools milestone complete --force` was a
 * dead flag.  The milestone source (src/milestone.cts) has a guard that checks
 * `options.force` and tells users to "Re-run with --force to override", but the
 * CLI dispatcher (gsd-core/bin/gsd-tools.cjs) never parsed `--force` and never
 * passed it into the options object.  So `options.force` was always `undefined`
 * and the guard could never be overridden regardless of what the user typed.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

/**
 * Build a fixture where the guard will fire:
 *  - STATE.md has `milestone: <version>` so the guard's version-match check is
 *    satisfied.
 *  - ROADMAP.md lists a `### Phase 2: Real Work` heading for that milestone, but
 *    there is NO on-disk phase directory for it.
 *
 * This guarantees "unstarted phase" detection without touching any real phases.
 * NOTE: the unstarted phase must be a REAL phase number — Phase 0 and Phase 999
 * are backlog/pre-milestone sentinels that are intentionally excluded from this
 * guard (#1580), so they would not fire it.
 */
function makeGuardFixture(tmpDir, version) {
  // STATE.md with frontmatter milestone field matching the version
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'STATE.md'),
    `---\nmilestone: ${version}\n---\n# State\n\n**Status:** In progress\n**Last Activity:** 2025-01-01\n**Last Activity Description:** Working\n`,
  );

  // ROADMAP.md — the heading must include the version so getMilestonePhaseFilter
  // does not return missingExplicitVersion.  Phase 2 has no on-disk dir.
  fs.writeFileSync(
    path.join(tmpDir, '.planning', 'ROADMAP.md'),
    `# Roadmap ${version}\n\n### Phase 2: Real Work\n**Goal:** Not started\n`,
  );
}

describe('bug-978: milestone complete --force overrides unstarted-phase guard', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-bug-978-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('without --force the guard fires and emits the documented error message', () => {
    makeGuardFixture(tmpDir, 'v1.0');

    const result = runGsdTools(
      ['milestone', 'complete', 'v1.0', '--name', 'Regression Test'],
      tmpDir,
    );

    assert.strictEqual(result.success, false, 'command should fail without --force');
    assert.ok(
      result.error.includes('Re-run with --force to override'),
      `expected guard error message; got: ${result.error}`,
    );
  });

  test('with --force the guard is bypassed and the command succeeds', () => {
    makeGuardFixture(tmpDir, 'v1.0');

    const result = runGsdTools(
      ['milestone', 'complete', 'v1.0', '--name', 'Regression Test', '--force'],
      tmpDir,
    );

    assert.ok(
      result.success,
      `command should succeed with --force but failed: ${result.error}`,
    );

    const output = JSON.parse(result.output);
    assert.strictEqual(output.version, 'v1.0');
    // Milestone entry should have been created even though phase 2 has no dir
    assert.ok(
      fs.existsSync(path.join(tmpDir, '.planning', 'MILESTONES.md')),
      'MILESTONES.md should have been created',
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2660-one-liner-extraction.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2660-one-liner-extraction (consolidation epic #1969 B3 #1972)", () => {
/**
 * Bug #2660: `gsd-tools milestone complete <version>` writes MILESTONES.md
 * bullets that read "- One-liner:" (the literal label) instead of the prose
 * after the label.
 *
 * Root cause: extractOneLinerFromBody() matches the first **...** span. In
 * `**One-liner:** prose`, the first span contains only `One-liner:` so the
 * function returns the label instead of the prose after it.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { extractOneLinerFromBody } = require(
  path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'core-utils.cjs')
);

describe('bug #2660: extractOneLinerFromBody', () => {
  test('a) body-style **One-liner:** label returns prose after the label', () => {
    const content =
      '# Phase 2 Plan 01: Foundation Summary\n\n**One-liner:** Real prose here.\n';
    assert.strictEqual(extractOneLinerFromBody(content), 'Real prose here.');
  });

  test('b) frontmatter-only one-liner returns null (caller handles frontmatter)', () => {
    const content =
      '---\none-liner: Set up project\n---\n\n# Phase 1: Foundation Summary\n\nBody prose with no bold line.\n';
    assert.strictEqual(extractOneLinerFromBody(content), null);
  });

  test('c) no one-liner at all returns null', () => {
    const content =
      '# Phase 1: Foundation Summary\n\nJust some narrative, no bold line.\n';
    assert.strictEqual(extractOneLinerFromBody(content), null);
  });

  test('d) bold spans inside the prose are preserved', () => {
    const content =
      '# Phase 1: Foundation Summary\n\n**One-liner:** This is **important** stuff.\n';
    assert.strictEqual(
      extractOneLinerFromBody(content),
      'This is **important** stuff.'
    );
  });

  test('e) empty prose after label returns null (no bogus bullet)', () => {
    const empty =
      '# Phase 1: Foundation Summary\n\n**One-liner:**\n\nRest of body.\n';
    const whitespace =
      '# Phase 1: Foundation Summary\n\n**One-liner:**   \n\nRest of body.\n';
    assert.strictEqual(extractOneLinerFromBody(empty), null);
    assert.strictEqual(extractOneLinerFromBody(whitespace), null);
  });

  test('f) legacy bare **prose** format still works (no label, no colon)', () => {
    // Preserve pre-existing behavior: SUMMARY files historically used
    // `**bold prose**` with no label. See tests/commands.test.cjs:366 and
    // tests/milestone.test.cjs:451 — both assert this form.
    const content =
      '---\nphase: "01"\n---\n\n# Phase 1: Foundation Summary\n\n**JWT auth with refresh rotation using jose library**\n\n## Performance\n';
    assert.strictEqual(
      extractOneLinerFromBody(content),
      'JWT auth with refresh rotation using jose library'
    );
  });

  test('g) other **Label:** prefixes (e.g. Summary:) also capture prose after label', () => {
    const content =
      '# Phase 1: Foundation Summary\n\n**Summary:** Built the thing.\n';
    assert.strictEqual(extractOneLinerFromBody(content), 'Built the thing.');
  });

  test('h) CRLF line endings (Windows) are handled', () => {
    const content =
      '---\r\nphase: "01"\r\n---\r\n\r\n# Phase 1: Foundation Summary\r\n\r\n**One-liner:** Windows-authored prose.\r\n';
    assert.strictEqual(
      extractOneLinerFromBody(content),
      'Windows-authored prose.'
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-72-business-context.test.cjs — consolidation epic #1969 (B8 #1977)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-72-business-context (consolidation epic #1969 B8 #1977)", () => {
// allow-test-rule: source-text-is-the-product (see #72)
// The PROJECT.md template + complete-milestone workflow .md ARE the product surface
// the runtime loads; asserting on their text tests the deployed contract directly.
/**
 * Enhancement #72 — optional Business Context section in the PROJECT.md template.
 *
 * Contract tests over the product-text surfaces (template + milestone workflow .md):
 * the template offers a Business Context section that is explicitly OPTIONAL, capped
 * at the four approved one-line fields, and the milestone evolution review treats it
 * as conditional so non-business projects that deleted it are never forced to review it.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const TEMPLATE = path.join(__dirname, '..', 'gsd-core', 'templates', 'project.md');
const COMPLETE_MILESTONE = path.join(__dirname, '..', 'gsd-core', 'workflows', 'complete-milestone.md');

function parseTemplateContract(content) {
  const lines = content.split(/\r?\n/);
  const lower = content.toLowerCase();
  // The Business Context block lives between its heading and the next "## " heading.
  const startIdx = lines.findIndex(l => l.trim() === '## Business Context');
  let sectionBody = '';
  if (startIdx !== -1) {
    const rest = lines.slice(startIdx + 1);
    const endOffset = rest.findIndex(l => l.startsWith('## '));
    sectionBody = (endOffset === -1 ? rest : rest.slice(0, endOffset)).join('\n');
  }
  const fieldOf = (label) => new RegExp(`^- \\*\\*${label}\\*\\*:`, 'm').test(sectionBody);
  return {
    hasSection: startIdx !== -1,
    // Optional-by-default: an HTML comment tells non-business projects to delete it.
    hasOptionalMarker: /<!--\s*OPTIONAL/i.test(sectionBody) && /delete this section/i.test(sectionBody),
    fields: {
      customer: fieldOf('Customer'),
      revenueModel: fieldOf('Revenue model'),
      successMetric: fieldOf('Success metric'),
      strategyNotes: fieldOf('Strategy notes'),
    },
    fieldCount: (sectionBody.match(/^- \*\*/gm) || []).length,
    // Positioned between Core Value and Requirements.
    orderedBetweenCoreValueAndRequirements:
      lower.indexOf('## core value') < lower.indexOf('## business context') &&
      lower.indexOf('## business context') < lower.indexOf('## requirements'),
    hasGuidelinesEntry: /\*\*Business Context:\*\*/.test(content),
  };
}

function parseMilestoneContract(content) {
  const lower = content.toLowerCase();
  const lines = content.split(/\r?\n/);
  const reviewLine = lines.find(l =>
    l.toLowerCase().includes('business context') &&
    (l.toLowerCase().includes('if present') || l.toLowerCase().includes('only if')),
  );
  return {
    mentionsBusinessContext: lower.includes('business context'),
    hasConditionalReview: Boolean(reviewLine),
  };
}

describe('enhancement #72 — Business Context template section', () => {
  const tpl = parseTemplateContract(fs.readFileSync(TEMPLATE, 'utf-8'));

  test('template includes a Business Context section', () => {
    assert.ok(tpl.hasSection, 'template must contain a "## Business Context" section');
  });

  test('section is marked OPTIONAL with delete-for-non-business guidance', () => {
    assert.ok(tpl.hasOptionalMarker, 'section must carry an OPTIONAL HTML comment telling non-business projects to delete it');
  });

  test('section carries exactly the four approved one-line fields', () => {
    assert.ok(tpl.fields.customer, 'missing **Customer** field');
    assert.ok(tpl.fields.revenueModel, 'missing **Revenue model** field');
    assert.ok(tpl.fields.successMetric, 'missing **Success metric** field');
    assert.ok(tpl.fields.strategyNotes, 'missing **Strategy notes** field');
    assert.strictEqual(tpl.fieldCount, 4, 'section is capped at four fields (constraint reference, not a business plan)');
  });

  test('section is positioned between Core Value and Requirements', () => {
    assert.ok(tpl.orderedBetweenCoreValueAndRequirements, 'Business Context must sit between Core Value and Requirements');
  });

  test('guidelines document the Business Context section', () => {
    assert.ok(tpl.hasGuidelinesEntry, 'guidelines block must include a **Business Context:** entry');
  });

  test('milestone evolution reviews Business Context only when present', () => {
    const ms = parseMilestoneContract(fs.readFileSync(COMPLETE_MILESTONE, 'utf-8'));
    assert.ok(ms.mentionsBusinessContext, 'complete-milestone must mention Business Context in its review');
    assert.ok(ms.hasConditionalReview, 'the Business Context milestone review must be conditional on the section being present');
  });
});
  });
}
