// verify-work.md / execute-plan.md / summary*.md are workflow & template text the
// runtime loads and executes. Asserting that they wire the deterministic coverage
// classifier (and preserve the legacy prose fall-through) tests the deployed
// contract. Per CONTRIBUTING.md exception matrix. The behavioral classification
// itself is exercised through the CLI (no source-grep) in the first half of this
// file and in coverage-metadata-parser.test.cjs.

'use strict';

/**
 * Issue #1602 — `verify-work` consumes the SUMMARY `coverage:` block
 * deterministically (auto-pass vs human-UAT), and the authoring/consuming
 * workflows + templates are wired for it.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempProject, cleanup, runGsdTools } = require('./helpers.cjs');

const ROOT = path.resolve(__dirname, '..');
const PHASE_DIR_REL = path.join('.planning', 'phases', '01-foundation');

function summaryDoc(frontmatterBodyLines) {
  return [
    '---',
    'phase: 01-foundation',
    'plan: 01',
    'status: complete',
    ...frontmatterBodyLines,
    '---',
    '',
    '# Phase 1 Plan 1: Foundation Summary',
    '',
    '## Accomplishments',
    '- Built the thing',
    '',
  ].join('\n');
}

function writeSummary(tmpDir, frontmatterBodyLines) {
  const dir = path.join(tmpDir, PHASE_DIR_REL);
  fs.mkdirSync(dir, { recursive: true });
  const rel = path.join(PHASE_DIR_REL, '01-01-SUMMARY.md');
  fs.writeFileSync(path.join(tmpDir, rel), summaryDoc(frontmatterBodyLines), 'utf-8');
  return rel;
}

function classify(tmpDir, rel) {
  const result = runGsdTools(`uat classify-coverage --summary ${rel}`, tmpDir);
  assert.ok(result.success, `command should succeed: ${result.error || result.output}`);
  return JSON.parse(result.output);
}

describe('verify-work coverage consumption — issue scenarios (behavioral, via CLI)', () => {
  test('(a) all entries auto-covered => all_auto_covered true, nothing presented', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const rel = writeSummary(tmpDir, [
      'coverage:',
      '  - id: D1',
      '    description: "covered one"',
      '    verification:',
      '      - kind: unit',
      '        ref: "tests/a.test.ts#a"',
      '        status: pass',
      '    human_judgment: false',
      '  - id: D2',
      '    description: "covered two"',
      '    verification:',
      '      - kind: integration',
      '        ref: "tests/b.test.ts#b"',
      '        status: pass',
      '    human_judgment: false',
    ]);
    const out = classify(tmpDir, rel);
    assert.equal(out.all_auto_covered, true);
    assert.equal(out.present.length, 0);
    assert.equal(out.auto_passed.length, 2);
  });

  test('(b) mixed => only the non-auto entries are presented', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const rel = writeSummary(tmpDir, [
      'coverage:',
      '  - id: D1',
      '    description: "auto covered"',
      '    verification:',
      '      - kind: unit',
      '        ref: "tests/a.test.ts#a"',
      '        status: pass',
      '    human_judgment: false',
      '  - id: D2',
      '    description: "needs judgment"',
      '    verification:',
      '      - kind: automated_ui',
      '        ref: "playwright:x.png"',
      '        status: pass',
      '    human_judgment: true',
      '    rationale: "visual sign-off"',
      '  - id: D3',
      '    description: "uncovered"',
      '    verification: []',
      '    human_judgment: false',
    ]);
    const out = classify(tmpDir, rel);
    assert.equal(out.total, 3);
    assert.equal(out.all_auto_covered, false);
    assert.equal(out.auto_passed.length, 1);
    assert.equal(out.auto_passed[0].id, 'D1');
    const presentedIds = out.present.map((e) => e.id).sort();
    assert.deepEqual(presentedIds, ['D2', 'D3']);
  });

  test('(c) absent coverage block => legacy mode (caller uses prose extraction unchanged)', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const rel = writeSummary(tmpDir, ['tags: [auth]']);
    const out = classify(tmpDir, rel);
    assert.equal(out.mode, 'legacy');
  });

  test('(d) fail-safe: an entry the executor left unclassified routes to present, never auto', (t) => {
    const tmpDir = createTempProject();
    t.after(() => cleanup(tmpDir));
    const rel = writeSummary(tmpDir, [
      'coverage:',
      '  - id: D1',
      '    description: "left unclassified"',
      '    verification: []',
      '    human_judgment: true',
      '    rationale: "Coverage not determined at authoring time — verifier must classify"',
    ]);
    const out = classify(tmpDir, rel);
    assert.equal(out.auto_passed.length, 0);
    assert.equal(out.present.length, 1);
    assert.equal(out.present[0].reason, 'human_judgment');
  });
});

describe('verify-work.md is wired to the deterministic classifier (deployed contract)', () => {
  const VERIFY_WORK = fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'verify-work.md'), 'utf-8');

  test('extract_tests invokes the deterministic classify-coverage verb', () => {
    assert.ok(
      /uat[. ]classify-coverage/.test(VERIFY_WORK),
      'verify-work.md extract_tests must invoke the `uat classify-coverage` verb',
    );
  });

  test('preserves the legacy prose fall-through for un-migrated SUMMARYs', () => {
    assert.ok(
      /legacy/i.test(VERIFY_WORK) && /fall (through|back)/i.test(VERIFY_WORK),
      'verify-work.md must describe the legacy fall-through when the coverage block is absent',
    );
  });

  test('routes human_judgment / non-passing entries to human UAT', () => {
    assert.ok(
      VERIFY_WORK.includes('human_judgment') || VERIFY_WORK.includes('present'),
      'verify-work.md must reference the present/human_judgment routing',
    );
  });
});

describe('execute-plan.md create_summary populates the coverage block (deployed contract)', () => {
  const EXECUTE_PLAN = fs.readFileSync(path.join(ROOT, 'gsd-core', 'workflows', 'execute-plan.md'), 'utf-8');

  test('create_summary documents coverage population with the fail-safe default', () => {
    assert.ok(EXECUTE_PLAN.includes('coverage'), 'create_summary must mention the coverage block');
    assert.ok(
      EXECUTE_PLAN.includes('human_judgment'),
      'create_summary must reference human_judgment for the fail-safe default',
    );
  });
});

describe('SUMMARY templates carry the coverage field (deployed contract)', () => {
  const templates = {
    main: fs.readFileSync(path.join(ROOT, 'gsd-core', 'templates', 'summary.md'), 'utf-8'),
    standard: fs.readFileSync(path.join(ROOT, 'gsd-core', 'templates', 'summary-standard.md'), 'utf-8'),
    complex: fs.readFileSync(path.join(ROOT, 'gsd-core', 'templates', 'summary-complex.md'), 'utf-8'),
    minimal: fs.readFileSync(path.join(ROOT, 'gsd-core', 'templates', 'summary-minimal.md'), 'utf-8'),
  };

  test('the main template documents the coverage schema and field semantics', () => {
    assert.ok(templates.main.includes('coverage:'), 'summary.md must include the coverage block');
    assert.ok(templates.main.includes('human_judgment'), 'summary.md must document human_judgment');
    assert.ok(templates.main.includes('verification'), 'summary.md must document verification');
  });

  for (const [name, body] of Object.entries(templates)) {
    test(`${name} template references coverage`, () => {
      assert.ok(body.includes('coverage'), `${name} template must reference the coverage field`);
    });
  }

  test('variant templates do not ship a live empty coverage list (fail-open footgun guard)', () => {
    for (const name of ['standard', 'complex', 'minimal']) {
      const body = templates[name];
      const live = body.split('\n').some((l) => /^coverage:\s*\[\]\s*$/.test(l));
      assert.ok(
        !live,
        `${name} template must not default to a live \`coverage: []\` — that would auto-skip UAT; keep it commented/illustrative`,
      );
    }
  });
});
