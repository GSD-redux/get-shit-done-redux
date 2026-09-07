'use strict';

/**
 * ADR-612 PR-5 (#3638) — bracket display surfaces.
 *
 * Breaks caught:
 * - progress/stats re-parse a bracket directory with the legacy numeric shape;
 * - stats/init-manager fail to read label-less bracket headings;
 * - a display surface hand-builds an ID that diverges from the canonical
 *   parse/render pair;
 * - a non-bracket project gains the new display_id field or widened heading
 *   recognition without opting in.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fc = require('./helpers/fast-check-setup.cjs');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');
const {
  parsePhaseId,
  renderMilestoneId,
  renderPhaseId,
  toDir,
} = require('../gsd-core/bin/lib/phase-id.cjs');
const {
  renderBracketMilestoneDisplay,
} = require('../gsd-core/bin/lib/phase-id-display.cjs');
const statusline = require('../hooks/gsd-statusline.js');

const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CODE_TAIL = `${UPPER}0123456789_`;
const codeArb = fc
  .tuple(
    fc.constantFrom(...UPPER),
    fc.string({ unit: fc.constantFrom(...CODE_TAIL), maxLength: 5 }),
  )
  .map(([head, tail]) => head + tail);
const canonicalNumberArb = fc.oneof(
  fc.integer({ min: 0, max: 99 }).map((n) => String(n).padStart(2, '0')),
  fc.integer({ min: 100, max: 9999 }).map(String),
);

function writeState(planningDir) {
  fs.writeFileSync(
    path.join(planningDir, 'STATE.md'),
    [
      '---',
      'milestone: v2.0',
      'milestone_name: Display',
      'status: planning',
      'active_phase: null',
      '---',
      '',
      '# State',
      '',
      'Phase: 1 of 1 (Display Slice)',
      '',
    ].join('\n'),
  );
}

function bracketProject(t) {
  const cwd = createTempProject('adr-612-display-');
  t.after(() => cleanup(cwd));
  const planning = path.join(cwd, '.planning');
  fs.writeFileSync(
    path.join(planning, 'config.json'),
    JSON.stringify({ phase_id_convention: 'bracket', project_code: 'GSD' }),
  );
  fs.writeFileSync(
    path.join(planning, 'ROADMAP.md'),
    [
      '# Roadmap',
      '',
      '## [GSD.02] v2.0: Display',
      '',
      '- [ ] **[GSD.02] 05.03: Display Slice**',
      '',
      '### [GSD.02] 05.03: Display Slice',
      '',
      '**Goal:** Render the canonical ID',
      '',
    ].join('\n'),
  );
  writeState(planning);
  const phaseDir = path.join(planning, 'phases', 'GSD.02-05.03-display-slice');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, '05.03-01-PLAN.md'), '# Plan\n');
  return cwd;
}

function legacyProject(t) {
  const cwd = createTempProject('adr-612-display-legacy-');
  t.after(() => cleanup(cwd));
  const planning = path.join(cwd, '.planning');
  fs.writeFileSync(
    path.join(planning, 'config.json'),
    JSON.stringify({ phase_id_convention: 'sequential', project_code: 'GSD' }),
  );
  fs.writeFileSync(
    path.join(planning, 'ROADMAP.md'),
    [
      '# Roadmap',
      '',
      '## v2.0: Display',
      '',
      '- [ ] **Phase 05.03: Display Slice**',
      '',
      '### Phase 05.03: Display Slice',
      '',
      '**Goal:** Preserve legacy display',
      '',
    ].join('\n'),
  );
  writeState(planning);
  const phaseDir = path.join(planning, 'phases', '05.03-display-slice');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, '05.03-01-PLAN.md'), '# Plan\n');
  return cwd;
}

function malformedBracketProject(t) {
  const cwd = createTempProject('adr-612-display-malformed-');
  t.after(() => cleanup(cwd));
  const planning = path.join(cwd, '.planning');
  fs.writeFileSync(
    path.join(planning, 'config.json'),
    JSON.stringify({ phase_id_convention: 'bracket', project_code: 'GSD' }),
  );
  fs.writeFileSync(
    path.join(planning, 'ROADMAP.md'),
    [
      '# Roadmap',
      '',
      '## [GSD.02] v2.0: Display',
      '',
    ].join('\n'),
  );
  writeState(planning);
  const phaseDir = path.join(planning, 'phases', 'gsd.02-05.03-recovered-display-name');
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, '05.03-01-PLAN.md'), '# Plan\n');
  return cwd;
}

function runJson(command, cwd) {
  const result = runGsdTools(command, cwd);
  assert.ok(result.success, `${command} failed: ${result.error}`);
  return JSON.parse(result.output);
}

describe('#3638: canonical bracket display examples', () => {
  test('progress and stats expose canonical display_id while retaining the phase token', (t) => {
    const cwd = bracketProject(t);

    for (const [command, expectedName] of [
      ['progress json', 'display slice'],
      ['stats json', 'Display Slice'],
    ]) {
      const output = runJson(command, cwd);
      assert.equal(output.phases.length, 1, `${command} must report the bracket phase`);
      assert.equal(output.milestone_version, '[GSD.02]');
      assert.deepEqual(
        {
          number: output.phases[0].number,
          display_id: output.phases[0].display_id,
          name: output.phases[0].name,
        },
        { number: '05.03', display_id: '[GSD.02] 05.03', name: expectedName },
      );
    }

    const progressTable = runJson('progress table', cwd).rendered;
    const statsTable = runJson('stats table', cwd).rendered;
    assert.match(progressTable, /\| \[GSD\.02\] 05\.03 \| display slice \|/);
    assert.match(statsTable, /\| \[GSD\.02\] 05\.03 \| Display Slice \|/);
    assert.doesNotMatch(progressTable, /v2\.0/);
    assert.doesNotMatch(statsTable, /v2\.0/);
  });

  test('init manager reads the label-less bracket heading and emits its canonical display_id', (t) => {
    const cwd = bracketProject(t);
    const output = runJson('init manager', cwd);

    assert.equal(output.phases.length, 1);
    assert.deepEqual(
      {
        number: output.phases[0].number,
        display_id: output.phases[0].display_id,
        name: output.phases[0].name,
        disk_status: output.phases[0].disk_status,
      },
      {
        number: '05.03',
        display_id: '[GSD.02] 05.03',
        name: 'Display Slice',
        disk_status: 'planned',
      },
    );
  });

  test('a non-bracket project preserves the legacy object and table shape', (t) => {
    const cwd = legacyProject(t);

    for (const [command, expectedName] of [
      ['progress json', 'display slice'],
      ['stats json', 'Display Slice'],
      ['init manager', 'Display Slice'],
    ]) {
      const output = runJson(command, cwd);
      assert.equal(output.phases.length, 1, `${command} must retain its legacy phase`);
      assert.equal(output.phases[0].number, '05.03');
      assert.equal(output.phases[0].name, expectedName);
      assert.equal(Object.hasOwn(output.phases[0], 'display_id'), false);
    }

    assert.match(runJson('progress table', cwd).rendered, /\| 05\.03 \| display slice \|/);
    assert.match(runJson('stats table', cwd).rendered, /\| 05\.03 \| Display Slice \|/);
  });

  test('progress recovers a malformed bracket directory name without a display_id', (t) => {
    const output = runJson('progress json', malformedBracketProject(t));

    assert.equal(output.phases.length, 1);
    assert.deepEqual(
      {
        number: output.phases[0].number,
        name: output.phases[0].name,
        hasDisplayId: Object.hasOwn(output.phases[0], 'display_id'),
      },
      { number: '05.03', name: 'recovered display name', hasDisplayId: false },
    );
  });

  test('stats recovers a malformed bracket directory name without a display_id', (t) => {
    const output = runJson('stats json', malformedBracketProject(t));

    assert.equal(output.phases.length, 1);
    assert.deepEqual(
      {
        number: output.phases[0].number,
        name: output.phases[0].name,
        hasDisplayId: Object.hasOwn(output.phases[0], 'display_id'),
      },
      { number: '05.03', name: 'recovered display name', hasDisplayId: false },
    );
  });
});

describe('#3638: bracket milestone renderer', () => {
  test('pins the milestone label as the shared phase-display prefix', () => {
    const id = parsePhaseId('[GSD.02] 05.03-01');

    assert.equal(renderMilestoneId(id), '[GSD.02]');
    assert.equal(renderPhaseId(id), `${renderMilestoneId(id)} 05.03-01`);
    assert.equal(renderBracketMilestoneDisplay('v2.0', 'GSD'), '[GSD.02]');
  });
});

describe('#3638: statusline/progress-card convention gate', () => {
  const state = {
    milestone: 'v2.0',
    milestoneName: 'Display',
    activePhase: '05.03',
    status: 'executing',
    percent: '50',
  };
  const bracket = { convention: 'bracket', projectCode: 'GSD' };

  test('full and compact cards render only the canonical bracket identity', () => {
    const full = statusline.formatGsdState(state, bracket);
    const compact = statusline.formatGsdStateCompact(state, bracket);

    assert.equal(
      full,
      '[GSD.02] Display [█████░░░░░] 50% · [GSD.02] 05.03 executing',
    );
    assert.equal(compact, '[GSD.02] · [GSD.02] 05.03 · executing');
    assert.doesNotMatch(`${full}\n${compact}`, /v2\.0|\bPhase\b|\bP05\.03\b/);
  });

  test('a non-bracket convention retains the exact legacy card strings', () => {
    assert.equal(
      statusline.formatGsdState(state, { convention: 'sequential', projectCode: 'GSD' }),
      'v2.0 Display [█████░░░░░] 50% · Phase 05.03 executing',
    );
    assert.equal(
      statusline.formatGsdStateCompact(state, { convention: 'sequential', projectCode: 'GSD' }),
      'v2.0 · P05.03 · executing',
    );
  });

  test('renderStatusline threads the bracket configuration through both entry points', (t) => {
    const cwd = bracketProject(t);
    const input = {
      model: { display_name: 'Claude' },
      workspace: { current_dir: cwd },
      context_window: {},
    };

    const full = statusline.renderStatusline(input);
    assert.match(full, /\[GSD\.02\]/);
    assert.doesNotMatch(full, /v2\.0/);

    fs.writeFileSync(
      path.join(cwd, '.planning', 'config.json'),
      JSON.stringify({
        phase_id_convention: 'bracket',
        project_code: 'GSD',
        statusline: { state_format: 'compact' },
      }),
    );
    const compact = statusline.renderStatusline(input);
    assert.match(compact, /\[GSD\.02\]/);
    assert.doesNotMatch(compact, /v2\.0/);
  });
});

describe('#3638: pure bracket pair remains the display/disk oracle', () => {
  test('render(parse(display)) is identity and toDir(parse(display)) reaches the hand-built dir', () => {
    fc.assert(
      fc.property(
        codeArb,
        canonicalNumberArb,
        canonicalNumberArb,
        fc.option(canonicalNumberArb, { nil: undefined }),
        (project, milestone, phase, subphase) => {
          const token = subphase === undefined ? phase : `${phase}.${subphase}`;
          const display = `[${project}.${milestone}] ${token}`;
          const dir = `${project}.${milestone}-${token}-display-slice`;
          const parsed = parsePhaseId(display);

          assert.equal(renderPhaseId(parsed), display);
          assert.equal(toDir(parsed, 'display slice'), dir);
        },
      ),
    );
  });
});
