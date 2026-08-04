'use strict';

/**
 * Prod-shape integration tests for `src/init.cts`'s `buildSectionManifestField`
 * seam (compiled into `gsd-core/bin/lib/init.cjs`) — #2994 (epic #1671 Phase
 * 6.3), `.gsd/phase/chore-2994-fragment-model-workflows/50-test-matrix.md`
 * sections B (compound-fact folding), D (flag value shapes), and E (the
 * `null` vs `[]` distinction).
 *
 * Every test drives the REAL CLI (`runGsdTools`, spawns `gsd-tools.cjs`) —
 * never a direct `require()` of `cmdInit*`, since `buildSectionManifestField`
 * itself is not exported and the whole point of this suite is proving the
 * flag/config plumbing that only exists at the CLI seam (`init-command-router.cjs`'s
 * `parseNamedArgs` calls) actually reaches `section_manifest`.
 *
 * Group E uses the `GSD_SECTION_MANIFEST` env override
 * (`gsd-core/bin/lib/init.cjs`'s `_sectionManifestCandidatePath`) to point the
 * CLI at a temp fixture manifest instead of the shipped
 * `gsd-core/workflows/section-manifest.json` — this is the ONLY way to
 * exercise "workflow absent from the manifest" today, because every
 * `cmdInit*` this repo currently wires (#2994's own completion) already has
 * an explicit key in the shipped artifact; Groups B and D deliberately do NOT
 * override it, driving the shipped manifest directly per the matrix's own
 * "drive from the shipped artifact wherever possible" rule.
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { runGsdTools, cleanup, createTempDir, createTempProject } = require('./helpers.cjs');
const { seedPhase } = require('./fixtures/index.cjs');

function writeConfig(tmpDir, config) {
  fs.mkdirSync(path.join(tmpDir, '.planning'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.planning', 'config.json'), JSON.stringify(config, null, 2));
}

function runInitJson(argv, cwd, env = {}) {
  const result = runGsdTools(argv, cwd, env);
  assert.ok(result.success, `Command failed: ${result.error}`);
  return JSON.parse(result.output);
}

// ─── Group E: the null vs [] distinction (matrix rows E1/E2/E3/E5/E6) ──────

describe('section_manifest: null (degraded) vs [] (computed, nothing applicable) — matrix §E', () => {
  let tmpDir;
  let manifestDir;

  beforeEach(() => {
    tmpDir = createTempProject('section-manifest-e-');
    manifestDir = createTempDir('section-manifest-e-manifest-');
  });

  afterEach(() => {
    cleanup(tmpDir);
    cleanup(manifestDir);
  });

  test('a manifest with no "quick" key degrades section_manifest to null (row E1)', () => {
    const manifestPath = path.join(manifestDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ workflows: {} }));

    const output = runInitJson(['init', 'quick', 'desc'], tmpDir, { GSD_SECTION_MANIFEST: manifestPath });
    assert.equal(output.section_manifest, null, 'an absent workflow key must degrade to null, never []');
  });

  test('a manifest with an explicit empty "quick" section list yields a computed [] (row E2)', () => {
    const manifestPath = path.join(manifestDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({ workflows: { quick: [] } }));

    const output = runInitJson(['init', 'quick', 'desc'], tmpDir, { GSD_SECTION_MANIFEST: manifestPath });
    assert.notEqual(output.section_manifest, null, 'a present (even empty) workflow key must NOT degrade to null');
    assert.deepEqual(output.section_manifest.included, []);
    assert.deepEqual(output.section_manifest.excluded, []);
    assert.deepEqual(output.section_manifest.read, []);
  });

  test('null and the computed [] shape are DIFFERENT values, not interchangeable (row E3)', () => {
    const absentKeyManifest = path.join(manifestDir, 'absent.json');
    fs.writeFileSync(absentKeyManifest, JSON.stringify({ workflows: {} }));
    const emptyListManifest = path.join(manifestDir, 'empty.json');
    fs.writeFileSync(emptyListManifest, JSON.stringify({ workflows: { quick: [] } }));

    const degraded = runInitJson(['init', 'quick', 'desc'], tmpDir, { GSD_SECTION_MANIFEST: absentKeyManifest });
    const computed = runInitJson(['init', 'quick', 'desc'], tmpDir, { GSD_SECTION_MANIFEST: emptyListManifest });

    assert.equal(degraded.section_manifest, null);
    assert.notEqual(computed.section_manifest, null);
    assert.notDeepEqual(degraded.section_manifest, computed.section_manifest, 'null must never compare equal to the computed {included:[],excluded:[],...} shape');
  });

  test('a section list where every when= evaluates false is still the computed [] shape, not null (row E2, second case)', () => {
    // "Applicable" is a FACTS question, not a shape question: a real section
    // whose gating flag was simply never passed on this invocation must still
    // be the computed {included:[],...} object, never collapse to null.
    const manifestPath = path.join(manifestDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      workflows: {
        quick: [{ id: 'discussion-phase', when: 'flag:--discuss', read: 'gsd-core/workflows/quick/steps/discussion-phase.md' }],
      },
    }));

    const output = runInitJson(['init', 'quick', 'desc'], tmpDir, { GSD_SECTION_MANIFEST: manifestPath });
    assert.notEqual(output.section_manifest, null);
    assert.deepEqual(output.section_manifest.included, []);
    assert.deepEqual(output.section_manifest.excluded, ['discussion-phase']);
  });

  test('a missing manifest file degrades to null without throwing (row E5)', () => {
    const neverCreatedPath = path.join(manifestDir, 'does-not-exist.json');
    assert.equal(fs.existsSync(neverCreatedPath), false, 'sanity: file must not exist');

    const result = runGsdTools(['init', 'quick', 'desc'], tmpDir, { GSD_SECTION_MANIFEST: neverCreatedPath });
    assert.ok(result.success, `a missing manifest file must not crash the command: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.equal(output.section_manifest, null);
  });

  test('a malformed-JSON manifest file degrades to null without throwing (row E6)', () => {
    const manifestPath = path.join(manifestDir, 'malformed.json');
    fs.writeFileSync(manifestPath, '{ this is not valid JSON');

    const result = runGsdTools(['init', 'quick', 'desc'], tmpDir, { GSD_SECTION_MANIFEST: manifestPath });
    assert.ok(result.success, `a malformed manifest file must not crash the command: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.equal(output.section_manifest, null);
  });
});

// ─── Group B: compound-fact folding lives in init.cts, never the grammar ──

describe('compound-fact folding at the init seam — matrix §B', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('section-manifest-b-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // B1-B4: cmdInitQuick folds --full into --discuss/--research/--validate BEFORE
  // buildSectionManifestField evaluates flag:--discuss/flag:--research/flag:--validate.
  describe('cmdInitQuick folds --full into each mode fact (rows B1-B4)', () => {
    test('--discuss alone includes discussion-phase (row B1, baseline)', () => {
      const output = runInitJson(['init', 'quick', 'desc', '--discuss'], tmpDir);
      assert.ok(output.section_manifest.included.includes('discussion-phase'));
    });

    test('--full alone (no --discuss) STILL includes discussion-phase — the fold this PR exists to prove (row B2)', () => {
      const output = runInitJson(['init', 'quick', 'desc', '--full'], tmpDir);
      assert.ok(
        output.section_manifest.included.includes('discussion-phase'),
        '--full must imply --discuss for section-gating purposes, folded in cmdInitQuick before evaluation',
      );
      assert.ok(output.section_manifest.included.includes('research-phase'), '--full must also imply --research');
      assert.ok(output.section_manifest.included.includes('plan-checker-loop'), '--full must also imply --validate (plan-checker-loop)');
      assert.ok(output.section_manifest.included.includes('quick-verification'), '--full must also imply --validate (quick-verification)');
    });

    test('neither --discuss nor --full excludes discussion-phase (row B3)', () => {
      const output = runInitJson(['init', 'quick', 'desc'], tmpDir);
      assert.ok(output.section_manifest.excluded.includes('discussion-phase'));
    });

    test('--full AND --discuss together still include discussion-phase exactly once, no double-counting (row B4)', () => {
      const output = runInitJson(['init', 'quick', 'desc', '--full', '--discuss'], tmpDir);
      const occurrences = output.section_manifest.included.filter((id) => id === 'discussion-phase');
      assert.equal(occurrences.length, 1, 'discussion-phase must appear exactly once in included, never duplicated by the fold');
    });
  });

  // B5-B6: cmdInitAutonomous folds --converge OR --cross-ai into one plan_strategy_converge fact.
  describe('cmdInitAutonomous folds --converge OR --cross-ai (rows B5-B6)', () => {
    test('--converge alone drives state:plan-strategy-converge sections into included (row B5)', () => {
      const output = runInitJson(['init', 'autonomous', '--converge'], tmpDir);
      assert.equal(output.plan_strategy_converge, true);
      assert.ok(output.section_manifest.included.includes('converge-fail-fast'));
      assert.ok(output.section_manifest.included.includes('converge-banner'));
    });

    test('--cross-ai alone (the documented alias, no --converge) ALSO drives inclusion (row B6)', () => {
      const output = runInitJson(['init', 'autonomous', '--cross-ai'], tmpDir);
      assert.equal(output.plan_strategy_converge, true);
      assert.ok(output.section_manifest.included.includes('converge-fail-fast'));
      assert.ok(output.section_manifest.included.includes('converge-loop'));
    });

    test('neither flag excludes every converge-* section', () => {
      const output = runInitJson(['init', 'autonomous'], tmpDir);
      assert.equal(output.plan_strategy_converge, false);
      for (const id of ['converge-fail-fast', 'converge-banner', 'converge-dispatch-bg', 'converge-dispatch-inline', 'converge-loop']) {
        assert.ok(output.section_manifest.excluded.includes(id), `expected "${id}" excluded when neither --converge nor --cross-ai is set`);
      }
    });
  });

  // B7: cmdInitUpdate folds --next OR --rc into one next_channel fact.
  describe('cmdInitUpdate folds --next OR --rc (row B7)', () => {
    test('--rc alone (not --next) drives channel-banner into included', () => {
      const output = runInitJson(['init', 'update', '--rc'], tmpDir);
      assert.equal(output.next_channel, true);
      assert.ok(output.section_manifest.included.includes('channel-banner'));
    });

    test('--next alone also drives channel-banner into included (the other half of the OR)', () => {
      const output = runInitJson(['init', 'update', '--next'], tmpDir);
      assert.equal(output.next_channel, true);
      assert.ok(output.section_manifest.included.includes('channel-banner'));
    });

    test('neither flag excludes channel-banner', () => {
      const output = runInitJson(['init', 'update'], tmpDir);
      assert.equal(output.next_channel, false);
      assert.ok(output.section_manifest.excluded.includes('channel-banner'));
    });
  });

  // B8: cmdInitDiscussPhaseAssumptions folds --auto OR consolidated auto-mode config.
  describe('cmdInitDiscussPhaseAssumptions folds --auto flag OR config auto-mode (row B8)', () => {
    test('no --auto flag, but config workflow._auto_chain_active=true, still includes auto-advance-dispatch', () => {
      writeConfig(tmpDir, { workflow: { _auto_chain_active: true } });
      const output = runInitJson(['init', 'discuss-phase-assumptions', '99'], tmpDir);
      assert.ok(output.section_manifest.included.includes('auto-advance-dispatch'));
    });

    test('no --auto flag, but config workflow.auto_advance=true, still includes auto-advance-dispatch (the other config source)', () => {
      writeConfig(tmpDir, { workflow: { auto_advance: true } });
      const output = runInitJson(['init', 'discuss-phase-assumptions', '99'], tmpDir);
      assert.ok(output.section_manifest.included.includes('auto-advance-dispatch'));
    });

    test('--auto flag present with no config also includes auto-advance-dispatch', () => {
      const output = runInitJson(['init', 'discuss-phase-assumptions', '99', '--auto'], tmpDir);
      assert.ok(output.section_manifest.included.includes('auto-advance-dispatch'));
    });

    test('neither --auto nor either config key excludes auto-advance-dispatch', () => {
      const output = runInitJson(['init', 'discuss-phase-assumptions', '99'], tmpDir);
      assert.ok(output.section_manifest.excluded.includes('auto-advance-dispatch'));
    });
  });
});

// ─── Group D: flag value shapes — token presence, not value truthiness ────

describe('flag value shapes drive section_manifest by truthiness, not semantic value — matrix §D', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('section-manifest-d-');
    seedPhase(tmpDir, '01-sample', { '01-CONTEXT.md': '# Phase Context\n' });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('absent boolean flag (--reviews never passed) does not mark reviews-prerequisite present (row D1)', () => {
    const output = runInitJson(['init', 'plan-phase', '1'], tmpDir);
    assert.ok(output.section_manifest.excluded.includes('reviews-prerequisite'));
    assert.ok(!output.section_manifest.included.includes('reviews-prerequisite'));
  });

  test('empty-string value flag (--prd "") excludes prd-express-gate — an empty value is not a branch selection (row D2)', () => {
    const output = runInitJson(['init', 'plan-phase', '1', '--prd', ''], tmpDir);
    assert.ok(output.section_manifest.excluded.includes('prd-express-gate'));
  });

  test('string-"0" value flag (--prd "0") INCLUDES prd-express-gate — token-presence semantics, not value truthiness (row D3)', () => {
    const output = runInitJson(['init', 'plan-phase', '1', '--prd', '0'], tmpDir);
    assert.ok(output.section_manifest.included.includes('prd-express-gate'), '--prd "0" is a non-empty string and must be treated as present');
  });

  test('whitespace-only value flag (--prd "   ") includes prd-express-gate, asserted deliberately (row D4)', () => {
    const output = runInitJson(['init', 'plan-phase', '1', '--prd', '   '], tmpDir);
    assert.ok(output.section_manifest.included.includes('prd-express-gate'));
  });

  test('duplicate flag tokens (--prd a --prd b) resolve to a single membership, no crash (row D5)', () => {
    const result = runGsdTools(['init', 'plan-phase', '1', '--prd', 'a', '--prd', 'b'], tmpDir);
    assert.ok(result.success, `duplicate --prd tokens must not crash the command: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(output.section_manifest.included.includes('prd-express-gate'));
    const occurrences = output.section_manifest.included.filter((id) => id === 'prd-express-gate');
    assert.equal(occurrences.length, 1, 'must be a single membership, not one entry per duplicate token');
  });

  test('flag-shaped value (--prd --weird) does not crash and deterministically excludes prd-express-gate (row D6)', () => {
    // parseNamedArgs treats a token starting with "--" as the NEXT flag, never
    // as this flag's value — so --prd here resolves to null (absent), not the
    // literal string "--weird".
    const result = runGsdTools(['init', 'plan-phase', '1', '--prd', '--weird'], tmpDir);
    assert.ok(result.success, `a flag-shaped value must not crash the command: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(output.section_manifest.excluded.includes('prd-express-gate'), '--prd immediately followed by another --flag token must resolve to absent, per parseNamedArgs');
  });

  test('unicode / very long value does not crash and is included as present (row D7)', () => {
    const longUnicodeValue = `产品需求文档-🚀-${'x'.repeat(2000)}`;
    const result = runGsdTools(['init', 'plan-phase', '1', '--prd', longUnicodeValue], tmpDir);
    assert.ok(result.success, `a unicode/very-long --prd value must not crash the command: ${result.error}`);
    const output = JSON.parse(result.output);
    assert.ok(output.section_manifest.included.includes('prd-express-gate'));
  });
});
