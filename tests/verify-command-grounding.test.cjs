'use strict';

/**
 * Verify-command grounding (#2401).
 *
 * Module: gsd-core/bin/lib/verify-command-grounding.cjs
 * Exported: extractAutomatedCommands, resolveVerifyCommandTarget,
 *           probePhaseVerifyCommands, harvestPriorVerifyCommands
 *
 * #2401: a planner authored `<automated>cd ../../frontend && npm run lint</automated>`
 * whose target does not resolve from the executor's cwd, and the plan-checker —
 * lacking a deterministic probe — hand-reasoned the filesystem and prescribed two
 * successively-wrong replacement paths.
 *
 * This module answers "can this command's target directory be grounded?" WITHOUT
 * executing the command. It is a RECOGNIZER, not a shell interpreter: exactly two
 * forms are grounded (`cd <literal>` and `npm --prefix <literal>`), and anything
 * carrying a variable, glob, substitution or `~` returns `unresolvable` — a
 * warning, never a blocker. Refusing to guess is the whole point; guessing is the
 * defect being fixed.
 *
 * Row numbers below map to `.gsd/phase/feat-2401-verify-command-grounding/50-test-matrix.md`.
 *
 * IO-failure rows monkeypatch the `fs` method and restore in `finally` — never
 * `chmod 0o000`, which root bypasses in Docker/CI so the test would pass with
 * zero coverage.
 *
 * The final `describe('property-based invariants', …)` block below carries the
 * fast-check property tests for this module. Properties covered:
 *   (a) resolveVerifyCommandTarget never throws and always returns a known
 *       status/severity/base shape, for arbitrary string input.
 *   (b) a 'blocker' severity is only ever reported for a grounded form: form
 *       is non-null and target is a non-empty string.
 *   (c) extractAutomatedCommands recovers every generated <automated> command,
 *       in order, from synthesized plan text.
 *   (d) CRLF invariance: the same plan rendered with \r\n line joins produces
 *       an identical command list.
 *   (e) extractAutomatedCommands never throws on arbitrary input, including
 *       non-string values, and returns [] for non-strings.
 */

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('./helpers/fast-check-setup.cjs');
const { cleanup, runGsdTools } = require('./helpers.cjs');

const {
  extractAutomatedCommands,
  resolveVerifyCommandTarget,
  probePhaseVerifyCommands,
  harvestPriorVerifyCommands,
} = require('../gsd-core/bin/lib/verify-command-grounding.cjs');

const KNOWN_STATUSES = new Set([
  'ok',
  'broken',
  'unresolvable',
  'not_applicable',
  'pending_creation',
]);

/** Root for every fixture built by this file; removed in `after`. */
let ROOT = '';

function fixtureRoot(name) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writePackageJson(dir, scripts) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fx', scripts }), 'utf8');
}

/** Build a minimal PLAN.md body with one `<automated>` per supplied command. */
function planWith(commands, { taskFiles = [], artifacts = [], eol = '\n' } = {}) {
  const tasks = commands
    .map(
      (cmd, i) =>
        [
          '<task type="auto">',
          `  <name>task-${i}</name>`,
          `  <files>${taskFiles[i] ?? ''}</files>`,
          '  <action>do the thing</action>',
          `  <verify><automated>${cmd}</automated></verify>`,
          '  <acceptance_criteria>it works</acceptance_criteria>',
          '  <done>committed</done>',
          '</task>',
        ].join(eol),
    )
    .join(eol);
  const artifactSection = artifacts.length
    ? [eol, '## Artifacts this phase produces', ...artifacts.map((a) => `- ${a}`)].join(eol)
    : '';
  return ['# Plan', '', tasks, artifactSection].join(eol);
}

function writePhase(root, phaseName, plans) {
  const planningDir = path.join(root, '.planning');
  const phaseDir = path.join(planningDir, phaseName);
  fs.mkdirSync(phaseDir, { recursive: true });
  for (const [file, body] of Object.entries(plans)) {
    fs.writeFileSync(path.join(phaseDir, file), body, 'utf8');
  }
  return phaseDir;
}

before(() => {
  ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2401-'));
});

after(() => {
  if (ROOT) cleanup(ROOT);
});

describe('extractAutomatedCommands', () => {
  test('row 29 — non-string plan text yields empty list', () => {
    for (const bad of [0, '', [], null, undefined, true, {}]) {
      assert.deepEqual(extractAutomatedCommands(bad), [], `input ${JSON.stringify(bad)}`);
    }
  });

  test('row 30 — empty automated block is skipped', () => {
    const out = extractAutomatedCommands(planWith(['', '   ', 'npm test']));
    assert.equal(out.length, 1);
    assert.equal(out[0].command, 'npm test');
  });

  test('row 31 — attribute-bearing automated tag is extracted', () => {
    const md = '<task type="auto"><name>t</name><verify><automated tier="fast">npm test</automated></verify></task>';
    const out = extractAutomatedCommands(md);
    assert.equal(out.length, 1);
    assert.equal(out[0].command, 'npm test');
  });

  test('row 32 — unclosed automated openers terminate', () => {
    const md = '<automated>'.repeat(200);
    const out = extractAutomatedCommands(md);
    assert.ok(Array.isArray(out));
  });

  test('row 27 — repeated command reports both occurrences', () => {
    const out = extractAutomatedCommands(planWith(['npm test', 'npm test']));
    assert.equal(out.length, 2);
  });

  test('carries the owning task name', () => {
    const out = extractAutomatedCommands(planWith(['npm test']));
    assert.equal(out[0].task, 'task-0');
  });

  test('row 25 — CRLF plan yields identical extraction to LF', () => {
    const lf = extractAutomatedCommands(planWith(['cd web && npm test', 'npm run build']));
    const crlf = extractAutomatedCommands(planWith(['cd web && npm test', 'npm run build'], { eol: '\r\n' }));
    assert.deepEqual(
      crlf.map((c) => c.command),
      lf.map((c) => c.command),
    );
  });
});

describe('resolveVerifyCommandTarget — grounded forms', () => {
  test('row 1 — no cd or prefix is not applicable', () => {
    const root = fixtureRoot('row1');
    const r = resolveVerifyCommandTarget('npm test -- --filter=x', { projectRoot: root });
    assert.equal(r.status, 'not_applicable');
    assert.equal(r.target, null);
    assert.equal(r.severity, 'none');
  });

  test('row 2 — resolves a cd target that exists', () => {
    const root = fixtureRoot('row2');
    writePackageJson(path.join(root, 'frontend'), { lint: 'eslint .' });
    const r = resolveVerifyCommandTarget('cd frontend && npm run lint', { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.form, 'cd');
    assert.equal(r.target, path.join(root, 'frontend'));
    assert.equal(r.manifest, 'package.json');
    assert.equal(r.severity, 'none');
  });

  test('row 3 — flags the reported unresolvable cd target', () => {
    // Nested two levels deep so `cd ../../frontend` resolves to
    // `<row3-root>/frontend` — inside the suite's own temp root, which it
    // controls and does not create — rather than escaping into the shared OS
    // temp directory where a stray `frontend/` could silently flip the
    // assertion.
    const root = fixtureRoot('row3/a/b');
    const r = resolveVerifyCommandTarget('cd ../../frontend && npm run lint && npm run build', {
      projectRoot: root,
    });
    assert.equal(r.status, 'broken');
    assert.equal(r.reason, 'missing_dir');
    assert.equal(r.severity, 'blocker');
    // The probe reports what it resolved; it never prescribes a replacement.
    assert.equal(r.rawTarget, '../../frontend');
    assert.ok(!('suggestion' in r), 'probe must not prescribe a replacement path');
  });

  test('row 4 — dir without a manifest is broken for an npm command', () => {
    const root = fixtureRoot('row4');
    fs.mkdirSync(path.join(root, 'docs-only'), { recursive: true });
    const r = resolveVerifyCommandTarget('cd docs-only && npm run lint', { projectRoot: root });
    assert.equal(r.status, 'broken');
    assert.equal(r.reason, 'no_manifest');
    assert.equal(r.severity, 'blocker');
  });

  test('row 5 — non-npm command needs no manifest', () => {
    const root = fixtureRoot('row5');
    fs.mkdirSync(path.join(root, 'docs-only'), { recursive: true });
    const r = resolveVerifyCommandTarget('cd docs-only && grep -q x README.md', { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.severity, 'none');
  });

  test('row 6 — resolves npm --prefix', () => {
    const root = fixtureRoot('row6');
    writePackageJson(path.join(root, 'web'), { build: 'vite build' });
    const r = resolveVerifyCommandTarget('npm --prefix ./web run build', { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.form, 'prefix');
    assert.equal(r.target, path.join(root, 'web'));
  });

  test('row 7 — resolves trailing --prefix', () => {
    const root = fixtureRoot('row7');
    writePackageJson(path.join(root, 'web'), { build: 'vite build' });
    const r = resolveVerifyCommandTarget('npm run build --prefix ./web', { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.target, path.join(root, 'web'));
  });

  test('row 8 — absolute prefix is not joined to root', () => {
    const root = fixtureRoot('row8');
    const abs = path.join(ROOT, 'row8-abs');
    writePackageJson(abs, { lint: 'eslint .' });
    const r = resolveVerifyCommandTarget(`npm --prefix ${abs} run lint`, { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.target, abs);
  });

  test('row 9 — folds chained cd segments', () => {
    const root = fixtureRoot('row9');
    writePackageJson(path.join(root, 'a', 'b'), { test: 'node --version' });
    const r = resolveVerifyCommandTarget('cd a && cd b && npm test', { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.target, path.join(root, 'a', 'b'));
  });

  test('row 22 — cd dot resolves to project root', () => {
    const root = fixtureRoot('row22');
    writePackageJson(root, { test: 'node --version' });
    const r = resolveVerifyCommandTarget('cd . && npm test', { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.target, root);
  });

  test('row 20 — normalizes windows separators', () => {
    const root = fixtureRoot('row20');
    const back = resolveVerifyCommandTarget('cd ..\\..\\frontend && npm test', { projectRoot: root });
    const fwd = resolveVerifyCommandTarget('cd ../../frontend && npm test', { projectRoot: root });
    assert.equal(back.status, fwd.status);
    assert.equal(back.target, fwd.target);
  });

  test('row 35 — file at target path is not a directory', () => {
    const root = fixtureRoot('row35');
    fs.writeFileSync(path.join(root, 'frontend'), 'not a dir', 'utf8');
    const r = resolveVerifyCommandTarget('cd frontend && npm test', { projectRoot: root });
    assert.equal(r.status, 'broken');
    assert.equal(r.reason, 'missing_dir');
  });
});

describe('#2401 review Finding 1 — script check runs for --prefix form regardless of flag order', () => {
  test('npm --prefix ./web run <missing-script> is script_missing/warning', () => {
    const root = fixtureRoot('finding1-prefix-first-missing');
    writePackageJson(path.join(root, 'web'), { build: 'vite build' });
    const r = resolveVerifyCommandTarget('npm --prefix ./web run nope', { projectRoot: root });
    assert.equal(r.reason, 'script_missing');
    assert.equal(r.severity, 'warning');
  });

  test('npm run <missing-script> --prefix ./web is script_missing/warning', () => {
    const root = fixtureRoot('finding1-prefix-trailing-missing');
    writePackageJson(path.join(root, 'web'), { build: 'vite build' });
    const r = resolveVerifyCommandTarget('npm run nope --prefix ./web', { projectRoot: root });
    assert.equal(r.reason, 'script_missing');
    assert.equal(r.severity, 'warning');
  });

  test('npm --prefix ./web run <existing-script> is reason:null/severity:none', () => {
    const root = fixtureRoot('finding1-prefix-first-present');
    writePackageJson(path.join(root, 'web'), { build: 'vite build' });
    const r = resolveVerifyCommandTarget('npm --prefix ./web run build', { projectRoot: root });
    assert.equal(r.reason, null);
    assert.equal(r.severity, 'none');
  });

  test('npm run <existing-script> --prefix ./web is reason:null/severity:none', () => {
    const root = fixtureRoot('finding1-prefix-trailing-present');
    writePackageJson(path.join(root, 'web'), { build: 'vite build' });
    const r = resolveVerifyCommandTarget('npm run build --prefix ./web', { projectRoot: root });
    assert.equal(r.reason, null);
    assert.equal(r.severity, 'none');
  });
});

describe('#2401 review Finding 2 — quoted --prefix paths containing spaces', () => {
  for (const [label, quote] of [['double-quoted', '"'], ['single-quoted', "'"]]) {
    test(`npm --prefix ${quote}my dir${quote} run test resolves the ${label} directory`, () => {
      const root = fixtureRoot(`finding2-present-${label}`);
      writePackageJson(path.join(root, 'my dir'), { test: 'node --version' });
      const r = resolveVerifyCommandTarget(`npm --prefix ${quote}my dir${quote} run test`, { projectRoot: root });
      assert.equal(r.status, 'ok');
      assert.equal(r.severity, 'none');
      assert.equal(r.target, path.join(root, 'my dir'));
    });

    test(`npm --prefix ${quote}my dir${quote} run test is broken/missing_dir when the ${label} dir does not exist`, () => {
      const root = fixtureRoot(`finding2-absent-${label}`);
      const r = resolveVerifyCommandTarget(`npm --prefix ${quote}my dir${quote} run test`, { projectRoot: root });
      assert.equal(r.status, 'broken');
      assert.equal(r.reason, 'missing_dir');
    });
  }
});

describe('#2401 review Finding 3 — an absolute segment in a chained cd resets, not concatenates', () => {
  test('cd sub && cd <abs-existing-dir> && npm test resolves to the absolute dir', () => {
    const root = fixtureRoot('finding3-abs-reset');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    const abs = path.join(ROOT, 'finding3-abs-target');
    writePackageJson(abs, { test: 'node --version' });
    const r = resolveVerifyCommandTarget(`cd sub && cd ${abs} && npm test`, { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.severity, 'none');
    assert.equal(r.target, abs);
    assert.equal(r.rawTarget, abs);
  });

  test('cd a && cd b && npm test (both relative) still resolves to <root>/a/b', () => {
    const root = fixtureRoot('finding3-relative-chain');
    writePackageJson(path.join(root, 'a', 'b'), { test: 'node --version' });
    const r = resolveVerifyCommandTarget('cd a && cd b && npm test', { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.target, path.join(root, 'a', 'b'));
  });
});

describe('resolveVerifyCommandTarget — refusals and negative space', () => {
  const hostile = [
    ['row 10 — refuses a variable path', 'cd "$FRONTEND" && npm test'],
    ['row 11 — refuses a glob path', 'cd frontend-* && npm test'],
    ['row 12 — refuses command substitution', 'cd $(git rev-parse --show-toplevel)/web && npm test'],
    ['row 13 — refuses backtick substitution', 'cd `pwd`/web && npm test'],
    ['row 14 — refuses tilde expansion', 'cd ~/web && npm test'],
  ];

  for (const [name, command] of hostile) {
    test(name, () => {
      const root = fixtureRoot('hostile');
      const r = resolveVerifyCommandTarget(command, { projectRoot: root });
      assert.equal(r.status, 'unresolvable', command);
      assert.equal(r.reason, 'dynamic_path');
      assert.equal(r.severity, 'warning', 'an ungroundable path must never block');
    });
  }

  test('row 15 — Nyquist MISSING sentinel is not applicable', () => {
    const root = fixtureRoot('row15');
    const r = resolveVerifyCommandTarget('MISSING — Wave 0 must create tests/x.py first', {
      projectRoot: root,
    });
    assert.equal(r.status, 'not_applicable');
    assert.equal(r.sentinel, true);
    assert.equal(r.severity, 'none');
  });

  test('row 16 — pseudo-shell assertion is not applicable', () => {
    const root = fixtureRoot('row16');
    const r = resolveVerifyCommandTarget("grep -c '?from=' src/x.tsx == 0", { projectRoot: root });
    assert.equal(r.status, 'not_applicable');
  });

  test('row 17 — dir created by an earlier task is pending, not broken', () => {
    const root = fixtureRoot('row17');
    const r = resolveVerifyCommandTarget('cd frontend && npm test', {
      projectRoot: root,
      declaredPaths: ['frontend/package.json'],
    });
    assert.equal(r.status, 'pending_creation');
    assert.notEqual(r.severity, 'blocker');
  });

  test('row 21 — target above project root warns', () => {
    const root = fixtureRoot('row21');
    const r = resolveVerifyCommandTarget('cd ../.. && npm test', { projectRoot: root });
    assert.equal(r.reason, 'outside_root');
    assert.equal(r.severity, 'warning');
    assert.equal(r.base, root, 'the resolved base must be reported');
  });

  test('row 19 — missing npm script warns, never blocks', () => {
    const root = fixtureRoot('row19');
    writePackageJson(path.join(root, 'frontend'), { lint: 'eslint .' });
    const r = resolveVerifyCommandTarget('cd frontend && npm run nope', { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.reason, 'script_missing');
    assert.equal(r.severity, 'warning');
    assert.equal(r.script, 'nope');
  });

  test('row 33 — invalid manifest json degrades to warning', () => {
    const root = fixtureRoot('row33');
    const dir = path.join(root, 'frontend');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{ not json', 'utf8');
    const r = resolveVerifyCommandTarget('cd frontend && npm run lint', { projectRoot: root });
    assert.equal(r.status, 'ok');
    assert.equal(r.reason, 'manifest_unreadable');
    assert.equal(r.severity, 'warning');
  });

  test('row 34 — non-object manifest json does not crash', () => {
    for (const [i, body] of ['0', '"s"', '[]', 'null', 'true'].entries()) {
      const root = fixtureRoot(`row34-${i}`);
      const dir = path.join(root, 'frontend');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), body, 'utf8');
      const r = resolveVerifyCommandTarget('cd frontend && npm run lint', { projectRoot: root });
      assert.ok(KNOWN_STATUSES.has(r.status), `body ${body} → ${r.status}`);
      assert.notEqual(r.severity, 'blocker', `body ${body} must not block`);
    }
  });

  test('row 28 — bare call shape does not throw', () => {
    const r = resolveVerifyCommandTarget('cd frontend && npm test');
    assert.ok(KNOWN_STATUSES.has(r.status));
    assert.equal(typeof r.base, 'string');
  });

  test('row 46 — probe never executes the command', () => {
    const root = fixtureRoot('row46');
    const canary = path.join(root, 'pwned');
    resolveVerifyCommandTarget(`cd . && touch ${canary}`, { projectRoot: root });
    resolveVerifyCommandTarget(`npm --prefix . run x; touch ${canary}`, { projectRoot: root });
    assert.equal(fs.existsSync(canary), false, 'the probe must never execute command text');
  });
});

describe('probePhaseVerifyCommands', () => {
  test('row 23 — plan with no automated blocks is ok', () => {
    const root = fixtureRoot('row23');
    const phaseDir = writePhase(root, 'phase-1', { '01-PLAN.md': '# Plan\n\nno tasks here\n' });
    const r = probePhaseVerifyCommands({ phaseDir, projectRoot: root });
    assert.deepEqual(r.commands, []);
    assert.equal(r.status, 'ok');
  });

  test('row 26 — overall status is the worst present', () => {
    const root = fixtureRoot('row26');
    writePackageJson(path.join(root, 'good'), { test: 'node --version' });
    const phaseDir = writePhase(root, 'phase-1', {
      '01-PLAN.md': planWith(['cd good && npm test']),
      '02-PLAN.md': planWith(['cd nowhere && npm test']),
    });
    const r = probePhaseVerifyCommands({ phaseDir, projectRoot: root });
    assert.equal(r.commands.length, 2);
    assert.equal(r.status, 'broken');
    assert.equal(r.counts.blocker, 1);
  });

  test('row 18 — artifact-section path is pending, not broken', () => {
    const root = fixtureRoot('row18');
    const phaseDir = writePhase(root, 'phase-1', {
      '01-PLAN.md': planWith(['cd frontend && npm test'], { artifacts: ['frontend/package.json'] }),
    });
    const r = probePhaseVerifyCommands({ phaseDir, projectRoot: root });
    assert.equal(r.commands[0].status, 'pending_creation');
    assert.equal(r.counts.blocker, 0);
  });

  test('row 17b — a path declared in an earlier task <files> is pending', () => {
    const root = fixtureRoot('row17b');
    const phaseDir = writePhase(root, 'phase-1', {
      '01-PLAN.md': planWith(['cd frontend && npm test'], { taskFiles: ['frontend/package.json'] }),
    });
    const r = probePhaseVerifyCommands({ phaseDir, projectRoot: root });
    assert.equal(r.commands[0].status, 'pending_creation');
  });

  test('row 25b — CRLF plan yields identical verdicts', () => {
    const root = fixtureRoot('row25b');
    writePackageJson(path.join(root, 'web'), { test: 'node --version' });
    const lfDir = writePhase(root, 'phase-lf', {
      '01-PLAN.md': planWith(['cd web && npm test', 'cd nowhere && npm test']),
    });
    const crlfDir = writePhase(root, 'phase-crlf', {
      '01-PLAN.md': planWith(['cd web && npm test', 'cd nowhere && npm test'], { eol: '\r\n' }),
    });
    const lf = probePhaseVerifyCommands({ phaseDir: lfDir, projectRoot: root });
    const crlf = probePhaseVerifyCommands({ phaseDir: crlfDir, projectRoot: root });
    assert.deepEqual(
      crlf.commands.map((c) => [c.command, c.status, c.reason]),
      lf.commands.map((c) => [c.command, c.status, c.reason]),
    );
  });

  test('row 24 — unreadable phase degrades, never throws', () => {
    const root = fixtureRoot('row24');
    const phaseDir = writePhase(root, 'phase-1', { '01-PLAN.md': planWith(['npm test']) });
    const realReadFile = fs.readFileSync;
    try {
      fs.readFileSync = (p, ...rest) => {
        if (String(p).endsWith('01-PLAN.md')) {
          const err = new Error('EIO: simulated read failure');
          err.code = 'EIO';
          throw err;
        }
        return realReadFile.call(fs, p, ...rest);
      };
      const r = probePhaseVerifyCommands({ phaseDir, projectRoot: root });
      assert.ok(r.readError, 'a read failure must surface as readError');
      assert.deepEqual(r.commands, []);
    } finally {
      fs.readFileSync = realReadFile;
    }
  });

  test('row 24b — absent phase dir degrades, never throws', () => {
    const root = fixtureRoot('row24b');
    const r = probePhaseVerifyCommands({
      phaseDir: path.join(root, 'no-such-phase'),
      projectRoot: root,
    });
    assert.ok(r.readError);
    assert.deepEqual(r.commands, []);
  });
});

describe('harvestPriorVerifyCommands', () => {
  function planningWithPhases(name, phases) {
    const root = fixtureRoot(name);
    for (const [phaseName, plans] of Object.entries(phases)) writePhase(root, phaseName, plans);
    return { root, planningDir: path.join(root, '.planning') };
  }

  test('row 36 — harvests prior phase commands', () => {
    const { planningDir } = planningWithPhases('row36', {
      '01-alpha': { '01-PLAN.md': planWith(['npm --prefix ./web run lint']) },
      '02-beta': { '01-PLAN.md': planWith(['cd nowhere && npm test']) },
    });
    const r = harvestPriorVerifyCommands({ planningDir, beforePhase: 2 });
    assert.equal(r.commands.length, 1);
    assert.equal(r.commands[0].command, 'npm --prefix ./web run lint');
    assert.equal(r.commands[0].phase, '01');
    assert.ok(r.commands[0].plan.endsWith('01-PLAN.md'));
  });

  test('row 37 — no prior phase harvests empty', () => {
    const { planningDir } = planningWithPhases('row37', {
      '01-alpha': { '01-PLAN.md': planWith(['npm test']) },
    });
    assert.deepEqual(harvestPriorVerifyCommands({ planningDir, beforePhase: 1 }).commands, []);
  });

  test('row 38 — walks back to the nearest phase with commands', () => {
    const { planningDir } = planningWithPhases('row38', {
      '01-alpha': { '01-PLAN.md': planWith(['npm --prefix ./web run build']) },
      '02-beta': { '01-PLAN.md': '# Plan\n\nno automated blocks\n' },
      '03-gamma': { '01-PLAN.md': planWith(['cd x && npm test']) },
    });
    const r = harvestPriorVerifyCommands({ planningDir, beforePhase: 3 });
    assert.equal(r.commands.length, 1);
    assert.equal(r.commands[0].phase, '01');
  });

  test('row 39 — walkback stops at three phases', () => {
    const { planningDir } = planningWithPhases('row39', {
      '01-alpha': { '01-PLAN.md': planWith(['npm --prefix ./web run build']) },
      '02-beta': { '01-PLAN.md': '# Plan\n' },
      '03-gamma': { '01-PLAN.md': '# Plan\n' },
      '04-delta': { '01-PLAN.md': '# Plan\n' },
      '05-epsilon': { '01-PLAN.md': planWith(['cd x && npm test']) },
    });
    assert.deepEqual(harvestPriorVerifyCommands({ planningDir, beforePhase: 5 }).commands, []);
  });

  test('row 40 — harvest caps at twenty commands (19 / 20 / 21)', () => {
    for (const [n, expected] of [
      [19, 19],
      [20, 20],
      [21, 20],
    ]) {
      const cmds = Array.from({ length: n }, (_, i) => `npm --prefix ./p${i} run build`);
      const { planningDir } = planningWithPhases(`row40-${n}`, {
        '01-alpha': { '01-PLAN.md': planWith(cmds) },
        '02-beta': { '01-PLAN.md': '# Plan\n' },
      });
      const r = harvestPriorVerifyCommands({ planningDir, beforePhase: 2 });
      assert.equal(r.commands.length, expected, `${n} distinct commands → ${expected}`);
    }
  });

  test('row 40b — duplicate commands are deduped before the cap', () => {
    const { planningDir } = planningWithPhases('row40b', {
      '01-alpha': { '01-PLAN.md': planWith(['npm test', 'npm test', 'npm run lint']) },
      '02-beta': { '01-PLAN.md': '# Plan\n' },
    });
    const r = harvestPriorVerifyCommands({ planningDir, beforePhase: 2 });
    assert.deepEqual(
      r.commands.map((c) => c.command),
      ['npm test', 'npm run lint'],
    );
  });

  test('row 41 — harvest degrades on unreadable planning dir', () => {
    const { planningDir } = planningWithPhases('row41', {
      '01-alpha': { '01-PLAN.md': planWith(['npm test']) },
      '02-beta': { '01-PLAN.md': '# Plan\n' },
    });
    const realReaddir = fs.readdirSync;
    try {
      fs.readdirSync = () => {
        const err = new Error('EACCES: simulated');
        err.code = 'EACCES';
        throw err;
      };
      const r = harvestPriorVerifyCommands({ planningDir, beforePhase: 2 });
      assert.deepEqual(r.commands, []);
      assert.ok(r.readError);
    } finally {
      fs.readdirSync = realReaddir;
    }
  });

  test('harvest never throws on a missing planning dir', () => {
    const root = fixtureRoot('harvest-missing');
    const r = harvestPriorVerifyCommands({
      planningDir: path.join(root, 'nope'),
      beforePhase: 3,
    });
    assert.deepEqual(r.commands, []);
  });

  // #2401 review fix: production phase directories are NOT named `phase-N-slug`
  // — they are `01-foundation`, `3-thing`, `2.1-thing`, `12A-thing`, and
  // optionally project-code-prefixed (`CK-01-name`). The bespoke
  // `/^phase-(\d+(?:\.\d+)?)/` regex this module previously used matched none
  // of these, so `harvestPriorVerifyCommands` always returned `[]` in
  // production. These rows pin every real directory-naming form via the
  // canonical `phase-id.cjs` grammar.

  test('#2401 — zero-padded phase dir (01-foundation)', () => {
    const { planningDir } = planningWithPhases('naming-zero-padded', {
      '01-foundation': { '01-PLAN.md': planWith(['npm --prefix ./web run lint']) },
      '02-next': { '01-PLAN.md': '# Plan\n' },
    });
    const r = harvestPriorVerifyCommands({ planningDir, beforePhase: 2 });
    assert.equal(r.commands.length, 1);
    assert.equal(r.commands[0].command, 'npm --prefix ./web run lint');
    assert.equal(r.commands[0].phase, '01');
  });

  test('#2401 — unpadded phase dir (3-thing)', () => {
    const { planningDir } = planningWithPhases('naming-unpadded', {
      '3-thing': { '01-PLAN.md': planWith(['npm test']) },
      '4-next': { '01-PLAN.md': '# Plan\n' },
    });
    const r = harvestPriorVerifyCommands({ planningDir, beforePhase: 4 });
    assert.equal(r.commands.length, 1);
    assert.equal(r.commands[0].command, 'npm test');
    assert.equal(r.commands[0].phase, '3');
  });

  test('#2401 — decimal sub-phase (2.1-thing) orders between 2-thing and 3-thing', () => {
    const { planningDir } = planningWithPhases('naming-decimal', {
      '2-thing': { '01-PLAN.md': planWith(['npm run build:base']) },
      '2.1-thing': { '01-PLAN.md': planWith(['npm run build:subphase']) },
      '3-thing': { '01-PLAN.md': '# Plan\n' },
    });
    // beforePhase 3 walks back descending: 3-thing (empty) → 2.1-thing (has
    // commands, stop) — 2.1 must sort BETWEEN 2 and 3, not after 3 or before 2.
    const r = harvestPriorVerifyCommands({ planningDir, beforePhase: 3 });
    assert.equal(r.commands.length, 1);
    assert.equal(r.commands[0].command, 'npm run build:subphase');
    assert.equal(r.commands[0].phase, '2.1');
  });

  test('#2401 — variant-suffixed phase dir (12A-thing)', () => {
    const { planningDir } = planningWithPhases('naming-variant-suffix', {
      '12A-thing': { '01-PLAN.md': planWith(['npm test']) },
      '13-next': { '01-PLAN.md': '# Plan\n' },
    });
    const r = harvestPriorVerifyCommands({ planningDir, beforePhase: 13 });
    assert.equal(r.commands.length, 1);
    assert.equal(r.commands[0].command, 'npm test');
    assert.equal(r.commands[0].phase, '12A');
  });

  test('#2401 — project-code-prefixed phase dir (CK-01-name)', () => {
    const { planningDir } = planningWithPhases('naming-project-code', {
      'CK-01-name': { '01-PLAN.md': planWith(['npm --prefix ./web run lint']) },
      'CK-02-next': { '01-PLAN.md': '# Plan\n' },
    });
    const r = harvestPriorVerifyCommands({ planningDir, beforePhase: 2 });
    assert.equal(r.commands.length, 1);
    assert.equal(r.commands[0].command, 'npm --prefix ./web run lint');
  });

  test('#2401 — non-phase directories (notes, archive) are ignored, not thrown on', () => {
    const { planningDir } = planningWithPhases('naming-non-phase-dirs', {
      '01-alpha': { '01-PLAN.md': planWith(['npm test']) },
      notes: { 'README.md': '# not a plan\n' },
      archive: { 'old-PLAN.md': planWith(['npm run stale']) },
    });
    const r = harvestPriorVerifyCommands({ planningDir, beforePhase: 2 });
    assert.equal(r.commands.length, 1);
    assert.equal(r.commands[0].command, 'npm test');
  });
});

describe('check verify-command-paths verb', () => {
  /** Fixture matching the real `.planning/phases/<dir>/` layout findPhaseInternal resolves against. */
  function writeCliPhase(root, dirName, planBody) {
    const phaseDir = path.join(root, '.planning', 'phases', dirName);
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(path.join(phaseDir, '01-PLAN.md'), planBody, 'utf8');
    return phaseDir;
  }

  test('row 44 — check verb emits documented json', () => {
    const root = fixtureRoot('row44');
    writeCliPhase(root, '01-test-phase', planWith(['npm test']));

    const result = runGsdTools(['check', 'verify-command-paths', '1', '--raw'], root);
    assert.ok(result.success, `check verify-command-paths should succeed. stderr: ${result.error}`);

    const payload = JSON.parse(result.output);
    assert.equal(typeof payload.status, 'string');
    assert.ok(Array.isArray(payload.commands));
    assert.equal(typeof payload.counts, 'object');
    assert.equal(typeof payload.counts.blocker, 'number');
    assert.equal(typeof payload.counts.warning, 'number');
    assert.equal(typeof payload.counts.total, 'number');
    assert.ok('readError' in payload);
  });

  test('row 45 — check verb degrades on unknown phase', () => {
    const root = fixtureRoot('row45');
    fs.mkdirSync(path.join(root, '.planning', 'phases'), { recursive: true });

    // Capture the result rather than asserting on exit code: an unknown phase
    // is a degraded-but-valid JSON payload, not necessarily a clean exit.
    const result = runGsdTools(['check', 'verify-command-paths', '999', '--raw'], root);
    const payload = JSON.parse(result.output);
    assert.deepEqual(payload.commands, []);
    assert.equal(typeof payload.readError, 'string');
    assert.ok(payload.readError.length > 0);
  });
});

describe('property-based invariants', () => {
  const KNOWN_STATUSES_PROP = new Set([
    'ok',
    'broken',
    'unresolvable',
    'not_applicable',
    'pending_creation',
  ]);
  const KNOWN_SEVERITIES = new Set(['blocker', 'warning', 'none']);

  // Safe alphabet for synthesized <automated> command bodies: excludes '<', '>'
  // and '&' so the generated body cannot forge XML markup inside the rendered
  // plan text, and is non-empty after trimming.
  const commandArb = fc
    .stringMatching(/^[A-Za-z0-9_./ :=-]+$/)
    .filter(s => s.trim().length > 0);

  describe('#2401 resolveVerifyCommandTarget — grounding properties', () => {
    test('(a) never throws; always returns a known status/severity/base shape', () => {
      fc.assert(fc.property(fc.string(), (s) => {
        let result;
        assert.doesNotThrow(() => {
          result = resolveVerifyCommandTarget(s, { projectRoot: os.tmpdir() });
        });
        assert.ok(result && typeof result === 'object', 'must return an object');
        assert.ok(KNOWN_STATUSES_PROP.has(result.status), `unknown status ${result.status}`);
        assert.ok(KNOWN_SEVERITIES.has(result.severity), `unknown severity ${result.severity}`);
        assert.strictEqual(typeof result.base, 'string');
      }));
    });

    test('(a) never throws for full-unicode input; always returns a known status/severity/base shape', () => {
      fc.assert(fc.property(fc.fullUnicodeString(), (s) => {
        let result;
        assert.doesNotThrow(() => {
          result = resolveVerifyCommandTarget(s, { projectRoot: os.tmpdir() });
        });
        assert.ok(result && typeof result === 'object', 'must return an object');
        assert.ok(KNOWN_STATUSES_PROP.has(result.status), `unknown status ${result.status}`);
        assert.ok(KNOWN_SEVERITIES.has(result.severity), `unknown severity ${result.severity}`);
        assert.strictEqual(typeof result.base, 'string');
      }));
    });

    test('(b) a blocker severity is only ever reported for a grounded form', () => {
      fc.assert(fc.property(fc.string(), (s) => {
        const result = resolveVerifyCommandTarget(s, { projectRoot: os.tmpdir() });
        if (result.severity === 'blocker') {
          assert.ok(result.form !== null && result.form !== undefined,
            `blocker for ${JSON.stringify(s)} must have a non-null form`);
          assert.strictEqual(typeof result.target, 'string',
            `blocker for ${JSON.stringify(s)} must have a string target`);
          assert.ok(result.target.length > 0,
            `blocker for ${JSON.stringify(s)} must have a non-empty target`);
        }
      }));
    });

    test('(b) a blocker severity is only ever reported for a grounded form (full-unicode)', () => {
      fc.assert(fc.property(fc.fullUnicodeString(), (s) => {
        const result = resolveVerifyCommandTarget(s, { projectRoot: os.tmpdir() });
        if (result.severity === 'blocker') {
          assert.ok(result.form !== null && result.form !== undefined,
            `blocker for ${JSON.stringify(s)} must have a non-null form`);
          assert.strictEqual(typeof result.target, 'string',
            `blocker for ${JSON.stringify(s)} must have a string target`);
          assert.ok(result.target.length > 0,
            `blocker for ${JSON.stringify(s)} must have a non-empty target`);
        }
      }));
    });
  });

  describe('#2401 extractAutomatedCommands — recovery properties', () => {
    test('(c) recovers every generated command, in order, from synthesized plan text', () => {
      fc.assert(fc.property(fc.array(commandArb, { minLength: 0, maxLength: 8 }), (commands) => {
        const planText = commands
          .map((cmd, i) => `<task type="auto"><name>t${i}</name><verify><automated>${cmd}</automated></verify></task>`)
          .join('\n');

        const extracted = extractAutomatedCommands(planText);
        assert.deepStrictEqual(
          extracted.map(c => c.command),
          commands.map(c => c.trim()),
        );
        extracted.forEach((row, i) => {
          assert.strictEqual(row.task, `t${i}`);
        });
      }));
    });

    test('(d) CRLF invariance: \\r\\n-joined plan text yields an identical command list', () => {
      fc.assert(fc.property(fc.array(commandArb, { minLength: 0, maxLength: 8 }), (commands) => {
        const lfPlanText = commands
          .map((cmd, i) => `<task type="auto"><name>t${i}</name><verify><automated>${cmd}</automated></verify></task>`)
          .join('\n');
        const crlfPlanText = commands
          .map((cmd, i) => `<task type="auto"><name>t${i}</name><verify><automated>${cmd}</automated></verify></task>`)
          .join('\r\n');

        const lfExtracted = extractAutomatedCommands(lfPlanText);
        const crlfExtracted = extractAutomatedCommands(crlfPlanText);
        assert.deepStrictEqual(crlfExtracted, lfExtracted);
      }));
    });

    test('(e) never throws on arbitrary string input', () => {
      fc.assert(fc.property(fc.string(), (s) => {
        let result;
        assert.doesNotThrow(() => {
          result = extractAutomatedCommands(s);
        });
        assert.ok(Array.isArray(result), 'must return an array');
      }));
    });

    test('(e) never throws on non-string input and returns [] for each', () => {
      const nonStrings = [0, [], null, undefined, true, {}];
      for (const v of nonStrings) {
        let result;
        assert.doesNotThrow(() => {
          result = extractAutomatedCommands(v);
        }, `must not throw for ${JSON.stringify(v)}`);
        assert.deepStrictEqual(result, [], `must return [] for ${JSON.stringify(v)}`);
      }
    });
  });
});
