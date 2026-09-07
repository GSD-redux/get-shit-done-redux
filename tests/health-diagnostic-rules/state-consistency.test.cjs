'use strict';

/**
 * Tests for `src/health-diagnostic-rules/state-consistency.cts` (Phase 11,
 * #3309, ADR-3180 §8.2/§8.3/§8.5) — group "STATE.md consistency": W024,
 * W002, W011, W021, W026.
 *
 * Design: .gsd/phase/refactor-3309-health-diagnostic-rule-table/40-design.md
 *
 * Fixture provenance (§8.5 + CONTRIBUTING "Fixture provenance (#2371)"):
 * every fixture below is a MECHANICAL MUTATION of a realistic multi-phase
 * ROADMAP/STATE/config.json shape (the shipped `templates/state.md` /
 * `templates/roadmap.md` field layout, filled in with real values) with
 * exactly ONE targeted field flipped per rule under test (an extra phase
 * reference, a checkbox left `[x]` while status stays `In progress`, a
 * `phase_id_convention` + a milestone-prefixed phase heading placed under
 * the wrong version section, a `milestone complete` status left with an
 * unstarted phase) — never a fixture invented purely to trip the rule with
 * no other realistic content. Every case drives the REAL
 * `buildPlanningSnapshot(cwd)` (`src/planning-snapshot.cts`) against a REAL
 * temp `.planning/` tree — no hand-built in-memory `PlanningSnapshot` mock.
 *
 * W024 is a deliberate exception: its `check` is documented dead code (see
 * `src/health-diagnostic-rules/state-consistency.cts`'s `RULE_W024`
 * comment) — its tests assert the INERT `[] `contract directly rather than
 * a trigger fixture, since no snapshot field can drive it to fire.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('../helpers.cjs');

const stateConsistency = require('../../gsd-core/bin/lib/health-diagnostic-rules/state-consistency.cjs');
const { RULES } = stateConsistency;

const { buildPlanningSnapshot } = require('../../gsd-core/bin/lib/planning-snapshot.cjs');
const { SEVERITY, REMEDY_ACTION, REMEDY_RISK } = require('../../gsd-core/bin/lib/health-diagnostic.cjs');

function planningDirOf(cwd) {
  return path.join(cwd, '.planning');
}

function writeState(cwd, content) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'STATE.md'), content);
}

function writeRoadmap(cwd, content) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'ROADMAP.md'), content);
}

function writeFile(cwd, relPath, content) {
  const full = path.join(cwd, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function writeConfig(cwd, obj) {
  fs.mkdirSync(planningDirOf(cwd), { recursive: true });
  fs.writeFileSync(path.join(planningDirOf(cwd), 'config.json'), JSON.stringify(obj, null, 2));
}

function makePhaseDir(cwd, dirName) {
  writeFile(cwd, `.planning/phases/${dirName}/01-01-PLAN.md`, '# Plan\n');
  writeFile(cwd, `.planning/phases/${dirName}/01-01-SUMMARY.md`, '# Summary\n');
  writeFile(cwd, `.planning/phases/${dirName}/01-VERIFICATION.md`, '---\nstatus: passed\n---\n');
}

function ruleFor(code) {
  const rule = RULES.find((r) => r.code === code);
  assert.ok(rule, `rule ${code} not found in RULES`);
  return rule;
}

// ─── RULES shape ────────────────────────────────────────────────────────────

describe('RULES (state-consistency group)', () => {
  test('exports exactly 5 rules: W024, W002, W011, W021, W026', () => {
    assert.deepEqual(
      RULES.map((r) => r.code).sort(),
      ['W002', 'W011', 'W021', 'W024', 'W026'],
    );
  });

  test('every rule is severity WARNING', () => {
    for (const code of ['W024', 'W002', 'W011', 'W021', 'W026']) {
      assert.equal(ruleFor(code).severity, SEVERITY.WARNING);
    }
  });
});

// ─── W024 — STATE.md commit-age freshness (DELIBERATELY INERT) ─────────────

describe('W024 — deliberately inert (no snapshot field backs git-log freshness)', () => {
  test('always returns [] on an empty snapshot', (t) => {
    const cwd = createTempDir('gsd-3309-w024-1-');
    t.after(() => cleanup(cwd));
    fs.mkdirSync(planningDirOf(cwd), { recursive: true });

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W024').check(snapshot), []);
  });

  test('always returns [] even with a state_head-carrying STATE.md and full roadmap/config', (t) => {
    const cwd = createTempDir('gsd-3309-w024-2-');
    t.after(() => cleanup(cwd));
    writeState(
      cwd,
      ['---', 'state_head: deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'status: In progress', '---', '', '## Current Position', '', 'Phase: 1 of 2', ''].join('\n'),
    );
    writeRoadmap(cwd, '## v1.0 Current 🚧\n\n### Phase 1: Foo\n\n### Phase 2: Bar\n');

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W024').check(snapshot), []);
  });
});

// ─── W002 — STATE.md references an undeclared phase token ──────────────────

describe('W002 — STATE.md references a phase not declared on disk or ROADMAP', () => {
  test('fires when STATE.md mentions a phase not on disk and not in ROADMAP', (t) => {
    const cwd = createTempDir('gsd-3309-w002-1-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, '## v1.0 Current 🚧\n\n### Phase 1: Foo\n\n### Phase 2: Bar\n');
    makePhaseDir(cwd, '01-foo');
    makePhaseDir(cwd, '02-bar');
    writeState(
      cwd,
      [
        '---',
        'status: In progress',
        '---',
        '',
        '## Current Position',
        '',
        'Phase: 1 of 2',
        '',
        '### Decisions',
        '',
        '- Phase 9: referenced a phase that does not exist',
        '',
      ].join('\n'),
    );

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W002').check(snapshot);

    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'W002');
    assert.equal(diagnostics[0].severity, SEVERITY.WARNING);
    // #4257: root scope (no active workstream) keeps the BYTE-IDENTICAL
    // message grammar — no scope clause is appended when none applies.
    assert.match(diagnostics[0].message, /STATE\.md references phase 9, but only phases .* are declared$/);
    assert.deepEqual(diagnostics[0].remedy, {
      action: REMEDY_ACTION.ADVISE,
      risk: REMEDY_RISK.NONE,
      args: {
        command:
          'Review STATE.md manually before changing it; /gsd-health --repair will not overwrite an existing STATE.md for phase mismatches',
      },
    });
  });

  test('does not fire when every STATE.md phase reference is declared (disk or ROADMAP)', (t) => {
    const cwd = createTempDir('gsd-3309-w002-2-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, '## v1.0 Current 🚧\n\n### Phase 1: Foo\n\n### Phase 2: Bar\n');
    makePhaseDir(cwd, '01-foo');
    makePhaseDir(cwd, '02-bar');
    writeState(
      cwd,
      [
        '---',
        'status: In progress',
        '---',
        '',
        '## Current Position',
        '',
        'Phase: 1 of 2',
        '',
        '### Decisions',
        '',
        '- Phase 2: fine, this is declared',
        '',
      ].join('\n'),
    );

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W002').check(snapshot), []);
  });

  // Boundary: `validPhases.size === 0` guard — mirrors `verify.cts:1765`'s
  // `if (normalizedValid.size > 0)` exactly, so a project with no declared
  // phases at all never reports every STATE.md phase mention as invalid.
  test('does not fire when the valid-phase set is empty (no ROADMAP, no disk phases)', (t) => {
    const cwd = createTempDir('gsd-3309-w002-3-');
    t.after(() => cleanup(cwd));
    writeState(
      cwd,
      ['---', 'status: In progress', '---', '', '### Decisions', '', '- Phase 3: referenced with nothing declared anywhere', ''].join(
        '\n',
      ),
    );

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W002').check(snapshot), []);
  });

  // `snapshot.archivedPhaseTokens` (#3652) now covers archived-milestone
  // phase-dir tokens, so `buildValidPhaseSet` includes them — a STATE.md
  // reference to a phase whose only home is an archived milestone is
  // correctly treated as declared and does NOT fire.
  test('does not fire on a phase reference whose only home is an archived milestone', (t) => {
    const cwd = createTempDir('gsd-3309-w002-4-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, '## v2.0 Current 🚧\n\n### Phase 3: Baz\n');
    makePhaseDir(cwd, '03-baz');
    writeFile(cwd, '.planning/milestones/v1.0-phases/01-archived-foo/01-VERIFICATION.md', '---\nstatus: passed\n---\n');
    writeState(
      cwd,
      [
        '---',
        'status: In progress',
        '---',
        '',
        '## Current Position',
        '',
        'Phase: 3 of 3',
        '',
        '### Decisions',
        '',
        '- Phase 1: this phase is archived, covered by snapshot.archivedPhaseTokens',
        '',
      ].join('\n'),
    );

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W002').check(snapshot);
    assert.deepEqual(diagnostics, []);
  });

  // ─── #4257: command mentions are not phase references; the warning names ──
  // ─── its workstream scope ─────────────────────────────────────────────────
  //
  // Fixture shape: the issue's own repro — active workstream `alpha` declares
  // phases 1-2, sibling `beta` declares phase 5, and alpha's STATE.md carries
  // a Queue/Ledger row mentioning the phase via a GSD command name or a quoted
  // roadmap line. GSD_WORKSTREAM is set directly (save/restore per
  // tests/health-diagnostic.test.cjs:598-602) — the same discriminator
  // planningDir applies and the CLI bootstrap folds the stored pointer into.
  function withWorkstreamEnv(t, name) {
    const prev = process.env['GSD_WORKSTREAM'];
    if (name === null) delete process.env['GSD_WORKSTREAM'];
    else process.env['GSD_WORKSTREAM'] = name;
    t.after(() => {
      if (prev === undefined) delete process.env['GSD_WORKSTREAM'];
      else process.env['GSD_WORKSTREAM'] = prev;
    });
  }

  function makeTwoWorkstreamFixture(cwd, stateQueueLine) {
    writeFile(cwd, '.planning/config.json', '{}');
    writeFile(
      cwd,
      '.planning/workstreams/alpha/ROADMAP.md',
      '## v1.0 Current 🚧\n\n### Phase 1: One\n\n### Phase 2: Two\n',
    );
    writeFile(
      cwd,
      '.planning/workstreams/beta/ROADMAP.md',
      '## v1.0 Current 🚧\n\n### Phase 5: Five\n',
    );
    writeFile(
      cwd,
      '.planning/workstreams/alpha/STATE.md',
      [
        '---',
        'status: planning',
        '---',
        '',
        '## Current Position',
        '',
        'Phase: 1 of 2 (One)',
        'Status: planning',
        '',
        '## Queue',
        '',
        `- ${stateQueueLine}`,
        '',
      ].join('\n'),
    );
  }

  test('#4257 row 1 (regression): `/gsd-execute-phase 5` in a Queue row is a command mention, not a phase reference — no W002 even though 5 is only declared in a sibling workstream', (t) => {
    const cwd = createTempDir('gsd-4257-w002-1-');
    t.after(() => cleanup(cwd));
    makeTwoWorkstreamFixture(cwd, '`/gsd-execute-phase 5`');
    withWorkstreamEnv(t, 'alpha');

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W002').check(snapshot), []);
  });

  test('#4257: a quoted roadmap line `- [ ] **Phase 40:**` in a code span is a quoted literal, not a reference — no W002', (t) => {
    const cwd = createTempDir('gsd-4257-w002-2-');
    t.after(() => cleanup(cwd));
    writeFile(cwd, '.planning/config.json', '{}');
    writeFile(
      cwd,
      '.planning/workstreams/alpha/ROADMAP.md',
      '## v1.0 Current 🚧\n\n### Phase 1: One\n\n### Phase 2: Two\n',
    );
    writeFile(
      cwd,
      '.planning/workstreams/beta/ROADMAP.md',
      '## v1.0 Current 🚧\n\n### Phase 40: Forty\n',
    );
    writeFile(
      cwd,
      '.planning/workstreams/alpha/STATE.md',
      [
        '---',
        'status: planning',
        '---',
        '',
        '## Ledger',
        '',
        // Closed code span (matching the A3 snapshot-level twin and the
        // 50-test-matrix.md B2 row). An UNTERMINATED backtick run is literal
        // text per CommonMark, so its content is prose and W002 SHOULD fire
        // on it — not the fixture this row pins.
        '- `- [ ] **Phase 40:** quoted from the beta roadmap`',
        '',
      ].join('\n'),
    );
    withWorkstreamEnv(t, 'alpha');

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W002').check(snapshot), []);
  });

  test('#4257: a GENUINE undeclared prose reference still warns under a workstream, and the warning names its scope', (t) => {
    const cwd = createTempDir('gsd-4257-w002-3-');
    t.after(() => cleanup(cwd));
    makeTwoWorkstreamFixture(cwd, 'Phase 5 wrap-up blocked on beta');
    withWorkstreamEnv(t, 'alpha');

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W002').check(snapshot);

    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'W002');
    // The valid set is workstream-scoped BY DESIGN (planningPaths under
    // GSD_WORKSTREAM); the message must say so — phase 5 IS declared, in
    // sibling `beta`, and the unqualified form read as a false project-wide
    // claim (#4257 sub-defect 2).
    assert.equal(
      diagnostics[0].message,
      'STATE.md references phase 5, but only phases 1, 2 are declared in workstream alpha',
    );
  });

  test('#4257: a command mention naming a DECLARED phase stays silent (no false negative introduced either)', (t) => {
    const cwd = createTempDir('gsd-4257-w002-4-');
    t.after(() => cleanup(cwd));
    makeTwoWorkstreamFixture(cwd, '`/gsd-execute-phase 2`');
    withWorkstreamEnv(t, 'alpha');

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W002').check(snapshot), []);
  });
});

// ─── W011 — STATE current-phase status vs. ROADMAP checkbox disagree ───────

describe('W011 — STATE current-phase status disagrees with ROADMAP [x] checkbox', () => {
  test('fires when ROADMAP checkbox says the current phase is [x] complete but STATE status is not complete/done', (t) => {
    const cwd = createTempDir('gsd-3309-w011-1-');
    t.after(() => cleanup(cwd));
    writeRoadmap(
      cwd,
      ['## v1.0 Current 🚧', '', '- [x] Phase 3: Auth', '- [ ] Phase 4: Billing', ''].join('\n'),
    );
    writeState(
      cwd,
      ['---', 'status: In progress', '---', '', '## Current Position', '', 'Phase: 3 of 4 (Auth)', 'Status: In progress', ''].join(
        '\n',
      ),
    );

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W011').check(snapshot);

    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0], {
      code: 'W011',
      severity: SEVERITY.WARNING,
      message:
        'STATE.md says current phase is 3 (status: in progress) but ROADMAP.md shows it as [x] complete — state files may be out of sync',
      remedy: {
        action: REMEDY_ACTION.ADVISE,
        risk: REMEDY_RISK.NONE,
        args: { command: 'Run /gsd-progress to re-derive current position, or manually update STATE.md' },
      },
    });
  });

  test('does not fire when STATE status is already "complete"', (t) => {
    const cwd = createTempDir('gsd-3309-w011-2-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '- [x] Phase 3: Auth', ''].join('\n'));
    writeState(
      cwd,
      ['---', 'status: complete', '---', '', '## Current Position', '', 'Phase: 3 of 4 (Auth)', 'Status: complete', ''].join('\n'),
    );

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W011').check(snapshot), []);
  });

  test('does not fire when the ROADMAP checkbox for the current phase is [ ] (not checked)', (t) => {
    const cwd = createTempDir('gsd-3309-w011-3-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '- [ ] Phase 3: Auth', ''].join('\n'));
    writeState(
      cwd,
      ['---', 'status: In progress', '---', '', '## Current Position', '', 'Phase: 3 of 4 (Auth)', 'Status: In progress', ''].join(
        '\n',
      ),
    );

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W011').check(snapshot), []);
  });

  // ─── #3280 — the machine-readable frontmatter format gsd-tools itself
  // writes (`state update` / `state begin-phase` persist `current_phase` +
  // `status` via syncStateFrontmatter). W011's phase extraction previously
  // never consulted frontmatter, so the exact staleness class it exists to
  // catch went undetected on the PRIMARY written format. Fixtures added
  // alongside the legacy-prose cases above (not by retrofitting them), so the
  // legacy path real user repos still carry keeps its coverage.

  test('#3280 AC1: fires when the current phase is recorded in frontmatter (the format gsd-tools writes), even when a body Phase field would shadow it', (t) => {
    const cwd = createTempDir('gsd-3280-w011-fm-1-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '- [x] Phase 2: Auth', '- [ ] Phase 3: Billing', ''].join('\n'));
    // The shape `state.cts`'s syncStateFrontmatter persists: frontmatter owns
    // current_phase/status; the body's `Phase:` line is a stale remnant the
    // frontmatter must override (resolveStatePhase's own ladder order).
    writeState(
      cwd,
      [
        '---',
        'gsd_state_version: \'1.0\'',
        'milestone: v1.0',
        'current_phase: 2',
        'status: executing',
        '---',
        '',
        '## Current Position',
        '',
        'Phase: 5 of 5 (Legacy remnant)',
        '',
      ].join('\n'),
    );

    const snapshot = buildPlanningSnapshot(cwd);
    assert.equal(snapshot.currentPhaseLabel.value, '2', 'frontmatter current_phase must win over the body Phase field');
    const diagnostics = ruleFor('W011').check(snapshot);

    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'W011');
    assert.equal(diagnostics[0].severity, SEVERITY.WARNING);
    assert.match(diagnostics[0].message, /STATE\.md says current phase is 2 \(status: executing\) but ROADMAP\.md shows it as \[x\] complete/);
  });

  test('#3280 AC1: fires when frontmatter carries current_phase and the body has no Phase field at all', (t) => {
    const cwd = createTempDir('gsd-3280-w011-fm-2-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '- [x] Phase 2: Auth', ''].join('\n'));
    writeState(
      cwd,
      ['---', 'current_phase: 2', 'status: planning', '---', '', '## Session', '', 'Last activity: 2026-08-01', ''].join('\n'),
    );

    const snapshot = buildPlanningSnapshot(cwd);
    assert.equal(snapshot.currentPhaseLabel.value, '2');
    const diagnostics = ruleFor('W011').check(snapshot);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'W011');
  });

  test('#3280 AC3: does not fire when frontmatter status reports completion in the state writer\'s own vocabulary (status: completed)', (t) => {
    const cwd = createTempDir('gsd-3280-w011-fm-3-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '- [x] Phase 2: Auth', ''].join('\n'));
    // `normalizeStateStatus` — the vocabulary `syncStateFrontmatter` persists —
    // emits `completed` (not `complete`/`done`), so an exact-token comparison
    // here would turn every legitimately completed frontmatter STATE.md into a
    // false positive the moment the phase read is fixed.
    writeState(
      cwd,
      ['---', 'current_phase: 2', 'status: completed', '---', '', '## Current Position', '', 'Phase: 5 of 5', ''].join('\n'),
    );

    const snapshot = buildPlanningSnapshot(cwd);
    assert.equal(snapshot.currentPhaseLabel.value, '2');
    assert.deepEqual(ruleFor('W011').check(snapshot), []);
  });

  test('#3280 AC3: does not fire when frontmatter status is "done" either', (t) => {
    const cwd = createTempDir('gsd-3280-w011-fm-4-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '- [x] Phase 2: Auth', ''].join('\n'));
    writeState(cwd, ['---', 'current_phase: 2', 'status: done', '---', ''].join('\n'));

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W011').check(snapshot), []);
  });

  test('#3280 AC2 (locked): fires when the current phase is recorded in a pipe table under ## Current Position', (t) => {
    const cwd = createTempDir('gsd-3280-w011-pipe-1-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '- [x] Phase 2: Auth', ''].join('\n'));
    writeState(
      cwd,
      [
        '---',
        'status: discussing',
        '---',
        '',
        '## Current Position',
        '',
        '| Phase | 2 of 5 |',
        '| --- | --- |',
        '| Status | discussing |',
        '',
      ].join('\n'),
    );

    const snapshot = buildPlanningSnapshot(cwd);
    assert.equal(snapshot.currentPhaseLabel.value, '2 of 5');
    const diagnostics = ruleFor('W011').check(snapshot);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'W011');
  });
});

// ─── W021 — phase_id_convention integer-prefix/milestone mismatch ──────────

describe('W021 — milestone-prefixed phase integer-prefix implies a different milestone', () => {
  test('fires when a milestone-prefixed phase heading is listed under the wrong version section', (t) => {
    const cwd = createTempDir('gsd-3309-w021-1-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, { phase_id_convention: 'milestone-prefixed' });
    writeRoadmap(cwd, ['## v2.0 Current 🚧', '', '### Phase 1-1: Misplaced', ''].join('\n'));

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W021').check(snapshot);

    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0], {
      code: 'W021',
      severity: SEVERITY.WARNING,
      message: 'Phase 1-1: integer prefix implies v1.0 but listed under v2.0',
      remedy: {
        action: REMEDY_ACTION.ADVISE,
        risk: REMEDY_RISK.NONE,
        args: { command: 'gsd-tools roadmap upgrade --convention milestone-prefixed' },
      },
    });
  });

  test('does not fire when the milestone-prefixed phase is listed under its implied version', (t) => {
    const cwd = createTempDir('gsd-3309-w021-2-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, { phase_id_convention: 'milestone-prefixed' });
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1-1: Correctly Placed', ''].join('\n'));

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W021').check(snapshot), []);
  });

  test('does not fire when phase_id_convention is not "milestone-prefixed"', (t) => {
    const cwd = createTempDir('gsd-3309-w021-3-');
    t.after(() => cleanup(cwd));
    writeConfig(cwd, { phase_id_convention: 'flat' });
    writeRoadmap(cwd, ['## v2.0 Current 🚧', '', '### Phase 1-1: Misplaced', ''].join('\n'));

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W021').check(snapshot), []);
  });
});

// ─── W026 — STATE says milestone complete but ROADMAP lists unstarted phase ─

describe('W026 — STATE milestone-complete/archived but ROADMAP lists a phase with no disk directory', () => {
  test('fires when STATE says "milestone complete" and the current milestone still lists an unstarted phase', (t) => {
    const cwd = createTempDir('gsd-3309-w026-1-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo', '', '### Phase 2: Bar', ''].join('\n'));
    makePhaseDir(cwd, '01-foo');
    // Phase 2 deliberately has NO disk directory.
    writeState(cwd, ['---', 'status: milestone complete', 'milestone: v1.0', '---', ''].join('\n'));

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W026').check(snapshot);

    assert.equal(diagnostics.length, 1);
    assert.deepEqual(diagnostics[0], {
      code: 'W026',
      severity: SEVERITY.WARNING,
      message: 'STATE says milestone complete but ROADMAP lists 1 unstarted phase(s) (e.g. Phase 2)',
      remedy: {
        action: REMEDY_ACTION.ADVISE,
        risk: REMEDY_RISK.NONE,
        args: {
          command: 'Run validate consistency or re-run complete-milestone after verifying all phases are done',
        },
      },
    });
  });

  test('does not fire when every phase in the current milestone has a disk directory', (t) => {
    const cwd = createTempDir('gsd-3309-w026-2-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo', '', '### Phase 2: Bar', ''].join('\n'));
    makePhaseDir(cwd, '01-foo');
    makePhaseDir(cwd, '02-bar');
    writeState(cwd, ['---', 'status: milestone complete', 'milestone: v1.0', '---', ''].join('\n'));

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W026').check(snapshot), []);
  });

  test('does not fire when STATE status is not "milestone complete"/"archived"', (t) => {
    const cwd = createTempDir('gsd-3309-w026-3-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo', '', '### Phase 2: Bar', ''].join('\n'));
    makePhaseDir(cwd, '01-foo');
    writeState(cwd, ['---', 'status: In progress', 'milestone: v1.0', '---', ''].join('\n'));

    const snapshot = buildPlanningSnapshot(cwd);
    assert.deepEqual(ruleFor('W026').check(snapshot), []);
  });

  test('fires when STATE status is "archived" (the other trigger token)', (t) => {
    const cwd = createTempDir('gsd-3309-w026-4-');
    t.after(() => cleanup(cwd));
    writeRoadmap(cwd, ['## v1.0 Current 🚧', '', '### Phase 1: Foo', '', '### Phase 2: Bar', ''].join('\n'));
    makePhaseDir(cwd, '01-foo');
    writeState(cwd, ['---', 'status: archived', 'milestone: v1.0', '---', ''].join('\n'));

    const snapshot = buildPlanningSnapshot(cwd);
    const diagnostics = ruleFor('W026').check(snapshot);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].code, 'W026');
  });
});
