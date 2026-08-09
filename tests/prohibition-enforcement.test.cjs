// Behavioral tests for the deterministic prohibition-enforcement producer (#1259, ADR-550 D5d
// "heavy half"). Requires the BUILT gsd-core/bin/lib/prohibition-enforcement.cjs — authored as
// src/prohibition-enforcement.cts and compiled by `npm run build:lib` (mirrors how the verify-tier
// suite requires the built probe-core.cjs). Typed-field assertions only; the check-runner is
// injected so no real subprocess is spawned. No source-grep.
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');

const ENFORCEMENT_LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'prohibition-enforcement.cjs');

const TEST_TIER = Object.freeze({
  requirement_id: 'R1',
  category: 'safety',
  status: 'resolved',
  verification: 'test',
  resolution: null,
  reason: null,
  statement: 'MUST NOT read source files and text-search them in tests',
});

describe('prohibition-enforcement: deterministic test-tier producer (#1259 / ADR-550 D5d)', () => {
  test('exports the producer + route functions', () => {
    const enforce = require(ENFORCEMENT_LIB);
    assert.equal(typeof enforce.runProhibitionEnforcement, 'function',
      'must export runProhibitionEnforcement (the deterministic producer)');
    assert.equal(typeof enforce.routeProhibitionEnforcement, 'function',
      'must export routeProhibitionEnforcement (the CLI surface)');
  });

  test('locate-miss (no check descriptor) -> fail-closed, located:false, no evidence', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(TEST_TIER, null, {
      runCheck: () => ({ passed: true }),
    });
    assert.equal(result.located, false, 'no locatable check');
    assert.notEqual(result.status, 'green', 'locate-miss must never be green');
    assert.equal(result.flagged, true, 'locate-miss must be flagged');
    assert.equal(result.kind, null, 'no kind when nothing located');
    assert.ok(Array.isArray(result.evidence) && result.evidence.length === 0, 'no evidence on locate-miss');
  });

  test('malformed check descriptor (missing target) -> treated as locate-miss', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(TEST_TIER, { kind: 'node-test' }, {
      runCheck: () => ({ passed: true }),
    });
    assert.equal(result.located, false, 'a descriptor without a target is not locatable');
    assert.notEqual(result.status, 'green');
    assert.equal(result.flagged, true);
  });

  test('node-test check that passes AND is machine-proven fail-first -> green + non-empty typed evidence', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // Migrated to machine proof (#1279): green now requires an injected proving prover, not
    // attestation. `failFirstProof` is asserted on the evidence (FF-07).
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
      {
        runCheck: () => ({ passed: true }),
        proveFailFirst: () => ({ provenFailFirst: true, method: 'violation-fixture' }),
      },
    );
    assert.equal(result.status, 'green');
    assert.equal(result.flagged, false);
    assert.equal(result.tier, 'test');
    assert.equal(result.located, true);
    assert.equal(result.kind, 'node-test');
    assert.equal(result.evidence.length, 1, 'one evidence record built');
    const ev = result.evidence[0];
    assert.equal(ev.kind, 'node-test');
    assert.equal(ev.target, 'tests/neg.test.cjs');
    assert.equal(ev.failFirst, true);
    assert.equal(ev.passed, true);
    assert.equal(ev.failFirstProof, 'violation-fixture',
      'evidence records HOW fail-first was machine-proven (FF-07)');
  });

  test('lint-rule (no-source-grep) check that passes AND is machine-proven -> green, evidence carries rule id', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // Migrated to machine proof (#1279): inject a proving prover alongside the clean runCheck.
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'lint-rule', rule: 'local/no-source-grep', target: 'tests/', failFirst: true },
      {
        runCheck: () => ({ passed: true }),
        proveFailFirst: () => ({ provenFailFirst: true, method: 'violation-fixture' }),
      },
    );
    assert.equal(result.status, 'green');
    assert.equal(result.flagged, false);
    assert.equal(result.kind, 'lint-rule');
    assert.equal(result.evidence[0].kind, 'lint-rule');
    assert.equal(result.evidence[0].rule, 'local/no-source-grep', 'evidence records which rule asserted the must-NOT');
    assert.equal(result.evidence[0].target, 'tests/', 'evidence records the linted target path, not the rule id');
  });

  test('buildLintArgs runs the project eslint as JSON over the target (plugins load via flat config; #1259 SF-01)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    assert.equal(typeof enforce.buildLintArgs, 'function',
      'must export buildLintArgs — the eslint argv builder for the lint-rule real runner');
    const argv = enforce.buildLintArgs({ kind: 'lint-rule', rule: 'local/no-source-grep', target: 'tests/' });
    assert.ok(Array.isArray(argv), 'argv is an array');
    const fmtIdx = argv.indexOf('--format');
    assert.ok(fmtIdx !== -1 && argv[fmtIdx + 1] === 'json',
      'emits --format json so the report can be filtered by ruleId');
    assert.ok(argv.includes('--no-warn-ignored'),
      'must pass --no-warn-ignored so an eslint-ignored target returns [] (fails closed), not a length-1 warning result');
    assert.ok(!argv.includes('--rule'),
      'must NOT use --rule — it cannot load a plugin rule like local/no-source-grep (the SF-01 bug)');
    assert.equal(argv[argv.length - 1], 'tests/', 'the LAST arg is the lint target path');
  });

  test('lint-rule descriptor missing its rule id -> locate-miss, never green', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'lint-rule', target: 'tests/', failFirst: true }, // no `rule`
      { runCheck: () => ({ passed: true }) },
    );
    assert.notEqual(result.status, 'green', 'a lint-rule with no rule id is not a valid wired check');
    assert.equal(result.flagged, true);
    assert.equal(result.located, false, 'an under-specified lint-rule descriptor is not locatable');
  });

  test('check that FAILS -> hard-gate (non-green, flagged), located:true, no evidence', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
      { runCheck: () => ({ passed: false }) },
    );
    assert.notEqual(result.status, 'green');
    assert.equal(result.flagged, true);
    assert.equal(result.located, true, 'the check was located even though it failed');
    assert.equal(result.evidence.length, 0, 'a failing check builds no evidence');
  });

  test('caller does NOT attest fail-first (descriptor failFirst:false) -> hard-gate, never green', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // fail-first is caller-attested (#1259 BL-02): a check the caller does not attest as fail-first
    // is not a valid regression proof and must never green, even if the run passes.
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: false },
      { runCheck: () => ({ passed: true }) },
    );
    assert.notEqual(result.status, 'green', 'a non-attested check is not a valid regression proof');
    assert.equal(result.flagged, true);
  });

  test('a runCheck that THROWS fails closed, never propagates (no-throw contract, NEW-WR-01)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
      { runCheck: () => { throw new Error('runner blew up'); } },
    );
    assert.notEqual(result.status, 'green', 'a throwing runner must never green');
    assert.equal(result.flagged, true);
    assert.equal(result.located, true);
  });

  test('hard-gates in BOTH modes on a failing check (ADR-550 D4)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    for (const mode of ['interactive', 'autonomous']) {
      const result = enforce.runProhibitionEnforcement(
        TEST_TIER,
        { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
        { runCheck: () => ({ passed: false }), mode },
      );
      assert.notEqual(result.status, 'green', `non-green in ${mode}`);
      assert.equal(result.flagged, true, `flagged in ${mode}`);
      assert.equal(result.mode, mode, 'mode echoed for transparency');
    }
  });

  test('passing run echoes the requested mode without changing the green verdict', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // Migrated to machine proof (#1279): inject a proving prover so green is reached via proof.
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
      {
        runCheck: () => ({ passed: true }),
        proveFailFirst: () => ({ provenFailFirst: true, method: 'violation-fixture' }),
        mode: 'autonomous',
      },
    );
    assert.equal(result.status, 'green', 'a passing wired check is green in autonomous mode too');
    assert.equal(result.mode, 'autonomous');
  });

  // ─── #1279 RED-first adversarial guards (FF-01 / FF-04 / FF-05) ───────────────
  // These pin MACHINE-PROVEN fail-first BEFORE the producer change. They inject a NEW
  // `proveFailFirst` option that the current producer does not read, so they FAIL against the
  // attestation-greens code (src/prohibition-enforcement.cts:411). Their failure IS the FF-01 RED
  // signal; Plans 02-03 wire the prover and turn them green. No source is edited in this plan.

  test('attestation alone no longer greens: a clean pass with no proving prover hard-gates (FF-01)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // The single most important guard: caller attests failFirst:true AND the run passes cleanly,
    // but the prover could NOT prove the check fails-on-violation (provenFailFirst:false). Without a
    // machine proof, attestation alone must NEVER green — it must hard-gate, flagged, located.
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
      {
        runCheck: () => ({ passed: true }),
        proveFailFirst: () => ({ provenFailFirst: false }),
      },
    );
    assert.notEqual(result.status, 'green',
      'attestation + a clean pass but no machine proof of fail-first must NEVER green (FF-01)');
    assert.equal(result.flagged, true, 'an un-proven check is flagged');
    assert.equal(result.located, true, 'the descriptor was located; it just was not proven fail-first');
  });

  test('a machine-proven fail-first check with a clean pass greens (FF-01 positive)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
      {
        runCheck: () => ({ passed: true }),
        proveFailFirst: () => ({ provenFailFirst: true, method: 'violation-fixture' }),
      },
    );
    assert.equal(result.status, 'green',
      'a check proven to fail-on-violation AND pass-on-clean must green');
    assert.equal(result.located, true);
    assert.equal(result.evidence.length, 1, 'one evidence record built on a proven green');
  });

  test('passes-on-violation (prover could not prove red) hard-gates, never green (FF-04 both-directions)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // The wired check passes on a clean run, but the prover ran it against a known violation and the
    // check did NOT go red (provenFailFirst:false). A check that passes-on-violation is not a
    // regression guard -> hard-gate.
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
      {
        runCheck: () => ({ passed: true }),
        proveFailFirst: () => ({ provenFailFirst: false }),
      },
    );
    assert.notEqual(result.status, 'green',
      'a check that does not go red on a known violation is not a regression guard (FF-04)');
    assert.equal(result.flagged, true);
    assert.equal(result.located, true);
  });

  test('fails-on-clean (clean run did not pass) hard-gates even when fail-first is proven (FF-04 both-directions)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // The prover proved the check goes red on a violation, but the clean run FAILED — both directions
    // must hold (fail-on-violation AND non-vacuous pass-on-clean) for green. A failing clean run
    // hard-gates regardless of the proof.
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
      {
        runCheck: () => ({ passed: false }),
        proveFailFirst: () => ({ provenFailFirst: true, method: 'violation-fixture' }),
      },
    );
    assert.notEqual(result.status, 'green',
      'a proven-fail-first check whose clean run failed must still hard-gate (FF-04)');
    assert.equal(result.flagged, true);
    assert.equal(result.located, true);
  });

  test('node-test with NO violationFixture fail-closes via the default prover, never falls back to attestation (FF-05)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // Decision-layer/default-prover guard: a node-test descriptor with no violationFixture cannot be
    // machine-proven (a generic producer cannot synthesize a violation), so the DEFAULT real prover
    // returns provenFailFirst:false -> hard-gate. We inject NO proveFailFirst so the default path is
    // exercised. It must NEVER silently weaken to attestation. (Default prover lands in Plans 02-03,
    // so this is RED now and greens with the producer change.)
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
      { runCheck: () => ({ passed: true }) },
    );
    assert.notEqual(result.status, 'green',
      'a node-test with no violationFixture cannot be proven fail-first -> fail-closed (FF-05)');
    assert.equal(result.flagged, true, 'an un-provable check is flagged');
    assert.equal(result.located, true, 'the descriptor was located; it just could not be proven');
  });

  test('a proveFailFirst that THROWS fails closed, never propagates and never greens (FF-05 no-throw)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // No-throw contract on the prove seam, mirroring the runCheck-throws guard: a prover that blows up
    // must fail closed (treated as provenFailFirst:false), never propagate and never green.
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
      {
        runCheck: () => ({ passed: true }),
        proveFailFirst: () => { throw new Error('prover blew up'); },
      },
    );
    assert.notEqual(result.status, 'green', 'a throwing prover must never green (FF-05)');
    assert.equal(result.flagged, true);
    assert.equal(result.located, true);
  });

  test('an un-provable fail-first check fails closed in BOTH interactive and autonomous modes (FF-04 / ADR-550 D4)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // A clean pass + a prover that could not prove fail-first must hard-gate in BOTH modes, with the
    // mode echoed for transparency. Mirrors the existing both-modes failing-check guard (:158).
    for (const mode of ['interactive', 'autonomous']) {
      const result = enforce.runProhibitionEnforcement(
        TEST_TIER,
        { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
        {
          runCheck: () => ({ passed: true }),
          proveFailFirst: () => ({ provenFailFirst: false }),
          mode,
        },
      );
      assert.notEqual(result.status, 'green', `un-provable check must not green in ${mode}`);
      assert.equal(result.flagged, true, `un-provable check is flagged in ${mode}`);
      assert.equal(result.mode, mode, 'mode echoed for transparency');
    }
  });

  test('routeProhibitionEnforcement parses a JSON request file and emits a structured result', (t) => {
    const fs = require('node:fs');
    const { runNode } = require('./helpers/process-seam.cjs');
    const { throwIfFailed } = require('./helpers/git-fixture.cjs');
    const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
    // Write a request file; the route reads it and runs the node-test descriptor's default runner
    // (its target does not exist, so it fail-closes deterministically — we assert the JSON SHAPE,
    // not a green verdict). We invoke the built CLI surface in a child process so output()
    // (writeAllSync to fd 1) is captured on stdout — no source-grep (we parse our own emitted JSON).
    const dir = createTempDir('prohib-enf-');
    const reqPath = path.join(dir, 'req.json');
    const runnerPath = path.join(dir, 'runner.cjs');
    fs.writeFileSync(reqPath, JSON.stringify({
      prohibition: TEST_TIER,
      check: { kind: 'node-test', target: 'tests/neg.test.cjs', failFirst: true },
      mode: 'autonomous',
    }));
    // A tiny runner that requires the BUILT module and invokes the route — output() writes to fd 1.
    fs.writeFileSync(runnerPath,
      "require(" + JSON.stringify(ENFORCEMENT_LIB) + ")" +
      ".routeProhibitionEnforcement(['check','prohibition-enforcement'," + JSON.stringify(reqPath) + "], false);\n");
    t.after(() => cleanup(dir));

    const r = runNode([runnerPath], { timeoutMs: PROBE_TIMEOUT_MS });
    throwIfFailed(r, `node ${runnerPath}`);
    const parsed = JSON.parse(r.stdout);
    assert.equal(typeof parsed, 'object', 'route emits a JSON object');
    assert.equal(parsed.tier, 'test', 'tier is preserved through the CLI surface');
    assert.equal(parsed.located, true, 'the check descriptor was located');
    assert.equal(parsed.mode, 'autonomous', 'mode flows through the CLI surface');
    assert.equal(typeof parsed.flagged, 'boolean', 'flagged is a typed boolean');
    assert.ok(Array.isArray(parsed.evidence), 'evidence is an array');
  });
});

// ─── Real-runner helpers (mutation-pinned; #1259 BL-01 / SF-01) ─────────────────
// These pin the deterministic parsing/threshold logic of the REAL runner so a Stryker mutant that
// weakens "non-vacuous pass" or the ruleId filter is caught — the contract the injected-runner tests
// above deliberately bypass.
describe('prohibition-enforcement real-runner helpers (#1259)', () => {
  test('parseNodeTestSummary extracts the TAP tests/pass/fail/cancelled counts', () => {
    const enforce = require(ENFORCEMENT_LIB);
    assert.deepEqual(enforce.parseNodeTestSummary('# tests 3\n# pass 2\n# fail 1\n# cancelled 1\n'),
      { tests: 3, pass: 2, fail: 1, cancelled: 1 });
    assert.deepEqual(enforce.parseNodeTestSummary('no summary here'), { tests: 0, pass: 0, fail: 0, cancelled: 0 });
  });

  // ─── #1279 isNodeTestRed pure helper (FF-03 / FF-06) — mutation-pinned `>= 1` boundary ───
  test('isNodeTestRed is true iff the TAP summary reports # fail >= 1 (mutation-pinned boundary)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // The `# fail 1` case is load-bearing: it pins `>= 1`, not `> 1`. A mutant flipping `>=`→`>`
    // (or bumping the threshold) flips this assertion and is caught.
    assert.equal(enforce.isNodeTestRed('# fail 1\n'), true, '# fail 1 is RED (boundary: >= 1, not > 1)');
    assert.equal(enforce.isNodeTestRed('# fail 0\n'), false, '# fail 0 is not RED');
    assert.equal(enforce.isNodeTestRed('# fail 2\n'), true, '# fail 2 is RED');
    assert.equal(enforce.isNodeTestRed('no summary'), false, 'no parseable summary -> not RED (fail-closed for the prover)');
  });

  // ─── #1279 isNonVacuousNodeTestRed (FF-03 hardening) — a NON-VACUOUS red proof ───
  // The fail-first PROOF must mirror the clean-pass non-vacuity discipline: a violation fixture that
  // makes the negative test CRASH at load (ENOENT/throw/syntax) emits a FILE-NAMED `# fail 1` — the
  // test never ran its assertion, so that is NOT proof the test is a regression guard. Require at
  // least one FAILING test named DISTINCTLY from the target file (symmetric with isNonVacuousNodeTestPass).
  test('isNonVacuousNodeTestRed: a file-named-only failure (a crash, not an assertion) does NOT prove fail-first', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // node --test of a file that throws at load: `not ok 1 - <file>`, `# fail 1` — a crash, not a
    // negative assertion firing red. Must NOT count as a non-vacuous red.
    const crash = 'not ok 1 - neg.test.cjs\n# tests 1\n# pass 0\n# fail 1\n';
    assert.equal(enforce.isNonVacuousNodeTestRed(crash, 'neg.test.cjs'), false,
      'a file-named-only failure is a load crash, not a proven regression guard — fail-closed');
    // BASENAME-NORMALIZED: node may report the file failure by an absolute/normalized path.
    const crashAbs = 'not ok 1 - /tmp/x/neg.test.cjs\n# tests 1\n# pass 0\n# fail 1\n';
    assert.equal(enforce.isNonVacuousNodeTestRed(crashAbs, 'neg.test.cjs'), false,
      'an absolute-path file-named failure is still a crash (basename compare)');
    // A genuine negative assertion firing red carries a descriptive name distinct from the file.
    const realRed = 'not ok 1 - rejects the forbidden pattern\n# tests 1\n# pass 0\n# fail 1\n';
    assert.equal(enforce.isNonVacuousNodeTestRed(realRed, 'neg.test.cjs'), true,
      'a distinctly-named failing test is a genuine non-vacuous red — proves fail-first');
    // No failure at all -> not red.
    assert.equal(enforce.isNonVacuousNodeTestRed('ok 1 - guards\n# tests 1\n# pass 1\n# fail 0\n', 'neg.test.cjs'), false,
      '# fail 0 is not red regardless of names');
    // SKIP/TODO failing lines never ran -> excluded (mirror tapTestNames m1).
    const skippedRed = 'not ok 1 - rejects the forbidden pattern # SKIP\n# tests 1\n# pass 0\n# fail 1\n';
    assert.equal(enforce.isNonVacuousNodeTestRed(skippedRed, 'neg.test.cjs'), false,
      'a SKIP/TODO failing line did not actually run -> not a proof');
  });

  test('tapTestNames EXCLUDES skipped/todo tests (they never ran, m1)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    assert.deepEqual(enforce.tapTestNames('ok 1 - guards the must-NOT\nok 2 - other # SKIP\nok 3 - later # TODO\n'),
      ['guards the must-NOT'], 'a # SKIP / # TODO test is not a real run and must not count');
  });

  test('isNonVacuousNodeTestPass: a SKIPPED negative test (file wrapper passes) is NOT a pass (m1)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // file wrapper + a skipped negative test: pass>=1 but the only named test is skipped -> vacuous.
    const skipped = 'ok 1 - empty.test.cjs\nok 2 - the negative test # SKIP\n# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n';
    assert.equal(enforce.isNonVacuousNodeTestPass(skipped, 'empty.test.cjs'), false,
      'a skipped negative test never executed -> must not green');
  });

  test('isNonVacuousNodeTestPass: a CANCELLED run is not a pass (m1)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const cancelled = 'ok 1 - guards\n# tests 1\n# pass 1\n# fail 0\n# cancelled 1\n';
    assert.equal(enforce.isNonVacuousNodeTestPass(cancelled, 'neg.test.cjs'), false,
      'a cancelled run is not a clean pass');
  });

  test('isNonVacuousNodeTestPass: an empty file (node names the test after the file) is NOT a pass (BL-01)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // node --test of a zero-test file: `ok 1 - empty.test.cjs`, `# tests 1 # pass 1` — counts alone
    // cannot distinguish it from a real test, so the file-named result must NOT count as a pass.
    const empty = 'ok 1 - empty.test.cjs\n1..1\n# tests 1\n# pass 1\n# fail 0\n';
    assert.equal(enforce.isNonVacuousNodeTestPass(empty, 'empty.test.cjs'), false,
      'a file-named-only result is vacuous — the BL-01 false-green guard');
    // BASENAME-NORMALIZED: node may report the file-test by an ABSOLUTE/normalized path while the
    // descriptor target is relative (cross-OS / node-version). The basenames must still match → vacuous.
    const emptyAbs = 'ok 1 - /tmp/x/empty.test.cjs\n1..1\n# tests 1\n# pass 1\n# fail 0\n';
    assert.equal(enforce.isNonVacuousNodeTestPass(emptyAbs, 'empty.test.cjs'), false,
      'an absolute-path file-test name must still be recognized as vacuous (basename compare, WR-02)');
    // Mirror case (pins the TARGET-side basename): relative TAP name vs ABSOLUTE descriptor target.
    const emptyRelName = 'ok 1 - neg.test.cjs\n1..1\n# tests 1\n# pass 1\n# fail 0\n';
    assert.equal(enforce.isNonVacuousNodeTestPass(emptyRelName, '/abs/path/neg.test.cjs'), false,
      'a relative file-test name vs an absolute target must still be vacuous — both sides basename-normalized (WR-R4-01)');
    const real = 'ok 1 - guards the must-NOT\n1..1\n# tests 1\n# pass 1\n# fail 0\n';
    assert.equal(enforce.isNonVacuousNodeTestPass(real, '/abs/path/neg.test.cjs'), true,
      'a real named test distinct from the file is a genuine pass (even vs an absolute target)');
    const failing = 'not ok 1 - guards\n# tests 1\n# pass 0\n# fail 1\n';
    assert.equal(enforce.isNonVacuousNodeTestPass(failing, 'neg.test.cjs'), false,
      'any failure means not a pass');
  });

  test('eslintJsonHasRule detects a ruleId; unparseable report -> true (fail-closed)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    assert.equal(enforce.eslintJsonHasRule(JSON.stringify([{ messages: [{ ruleId: 'local/no-source-grep' }] }]), 'local/no-source-grep'), true);
    assert.equal(enforce.eslintJsonHasRule(JSON.stringify([{ messages: [{ ruleId: 'other' }] }]), 'local/no-source-grep'), false);
    assert.equal(enforce.eslintJsonHasRule('not json', 'local/no-source-grep'), true,
      'an unreadable report must be treated as a violation, never a silent pass');
  });

  test('eslintFileResultCount: 0 when nothing linted (vacuity guard)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    assert.equal(enforce.eslintFileResultCount(JSON.stringify([{}, {}])), 2);
    assert.equal(enforce.eslintFileResultCount('[]'), 0);
    assert.equal(enforce.eslintFileResultCount('garbage'), 0);
  });

  test('eslintHasFatalError: a parse/fatal error must fail closed (B1)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const fatal = JSON.stringify([{ messages: [{ ruleId: null, fatal: true, severity: 2, message: 'Parsing error' }], fatalErrorCount: 1 }]);
    assert.equal(enforce.eslintHasFatalError(fatal), true, 'a fatal/parse error means the rule never ran -> fail closed');
    const clean = JSON.stringify([{ messages: [], fatalErrorCount: 0 }]);
    assert.equal(enforce.eslintHasFatalError(clean), false, 'a clean lint has no fatal error');
    assert.equal(enforce.eslintHasFatalError('not json'), true, 'an unreadable report is treated as fatal (fail closed)');
  });

  test('eslintJsonHasRule also reads suppressedMessages — an inline-disabled violation still counts (B1)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const suppressed = JSON.stringify([{ messages: [], suppressedMessages: [{ ruleId: 'local/no-source-grep' }] }]);
    assert.equal(enforce.eslintJsonHasRule(suppressed, 'local/no-source-grep'), true,
      'a violation suppressed via // eslint-disable must NOT be treated as clean');
  });
});

// ─── Real runner end-to-end (NO injected runCheck; #1259 SF-02 / BL-01 / SF-01) ──
// Spawns real subprocesses so the SHIPPING default runner is exercised — the gap that let BL-01 and
// SF-01 slip past the injected-double tests. Typed-field assertions only.
describe('prohibition-enforcement REAL runner end-to-end (#1259)', () => {
  const fs = require('node:fs');

  test('a genuine non-vacuous passing node-test proven fail-first greens via the real runner + real prover', (t) => {
    const enforce = require(ENFORCEMENT_LIB);
    const dir = createTempDir('prohib-real-pass-');
    t.after(() => cleanup(dir));
    // Migrated to the SHIPPING prover (#1279): a REAL negative test that honors the
    // GSD_PROHIB_SUBJECT convention — it asserts its subject is clean. The clean runCheck run reads
    // the CLEAN subject (passes, non-vacuous); the prover runs it against a KNOWN-BAD subject so it
    // goes RED (fail-first proven). Both directions exercised against real `node --test`.
    const tf = path.join(dir, 'neg.test.cjs');
    fs.writeFileSync(tf,
      "const { test } = require('node:test');\n" +
      "const assert = require('node:assert');\n" +
      "const fs = require('node:fs');\n" +
      "test('guards the must-NOT: subject is clean', () => {\n" +
      "  const subject = fs.readFileSync(process.env.GSD_PROHIB_SUBJECT, 'utf-8');\n" +
      "  assert.ok(!subject.includes('FORBIDDEN'), 'subject must not contain FORBIDDEN');\n" +
      "});\n");
    const cleanSubject = path.join(dir, 'clean-subject.txt');
    fs.writeFileSync(cleanSubject, 'this subject is clean\n');
    const badFixture = path.join(dir, 'bad-subject.txt');
    fs.writeFileSync(badFixture, 'this subject contains FORBIDDEN content\n');
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      // #1906: the node-test causation control is mandatory — supply the clean control subject the
      // test already writes so the honest content-dependent path proves fail-first and greens.
      { kind: 'node-test', target: tf, failFirst: true, violationFixture: badFixture, cleanFixture: cleanSubject },
      { cwd: dir, runCheck: () => ({ passed: true }) },
    );
    assert.equal(result.status, 'green', 'a real negative test proven fail-first + clean pass must green');
    assert.equal(result.located, true);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].failFirstProof, 'violation-fixture');
  });

  // ─── #1346 causation control: prove the RED is caused by the violation's CONTENT ───
  // The documented residual (#1279 review Major 1): existence + a non-vacuous RED is necessary but
  // NOT sufficient — a deceptive negative test that reds merely BECAUSE GSD_PROHIB_SUBJECT is SET
  // (not because the subject's CONTENT violates the must-NOT) is still accepted. The mitigation is an
  // OPTIONAL clean-subject control: when the descriptor carries a `cleanFixture`, the prover also runs
  // the check against the KNOWN-CLEAN subject and requires it to stay GREEN. A content-independent red
  // reds on the clean subject too -> control fails -> NOT proven (fail-closed).
  test('a DECEPTIVE content-independent red is NOT proven fail-first when a clean control fixture is supplied (#1346)', (t) => {
    const enforce = require(ENFORCEMENT_LIB);
    const dir = createTempDir('prohib-deceptive-');
    t.after(() => cleanup(dir));
    // Deceptive: reds whenever a subject is PRESENT, regardless of its content. Goes RED against the
    // bad fixture (looks fail-first) but ALSO reds against the clean subject -> the control catches it.
    const tf = path.join(dir, 'neg.test.cjs');
    fs.writeFileSync(tf,
      "const { test } = require('node:test');\n" +
      "const assert = require('node:assert');\n" +
      "test('reds whenever a subject is present (deceptive, content-independent)', () => {\n" +
      "  assert.ok(!process.env.GSD_PROHIB_SUBJECT, 'fails whenever a subject is set');\n" +
      "});\n");
    const cleanSubject = path.join(dir, 'clean-subject.txt');
    fs.writeFileSync(cleanSubject, 'this subject is clean\n');
    const badFixture = path.join(dir, 'bad-subject.txt');
    fs.writeFileSync(badFixture, 'this subject contains FORBIDDEN content\n');
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: tf, failFirst: true, violationFixture: badFixture, cleanFixture: cleanSubject },
      { cwd: dir, runCheck: () => ({ passed: true }) },
    );
    assert.notEqual(result.status, 'green',
      'a content-independent red must NOT prove fail-first when a clean control is supplied — fail-closed');
  });

  test('an honest content-dependent node-test WITH a clean control fixture still greens (#1346 positive)', (t) => {
    const enforce = require(ENFORCEMENT_LIB);
    const dir = createTempDir('prohib-content-dep-');
    t.after(() => cleanup(dir));
    // Honest: reds ONLY when the subject's CONTENT contains FORBIDDEN. RED on the bad fixture, GREEN
    // on the clean subject -> the control confirms content-dependence -> proven.
    const tf = path.join(dir, 'neg.test.cjs');
    fs.writeFileSync(tf,
      "const { test } = require('node:test');\n" +
      "const assert = require('node:assert');\n" +
      "const fs = require('node:fs');\n" +
      "test('rejects the forbidden content (content-dependent)', () => {\n" +
      "  const subject = fs.readFileSync(process.env.GSD_PROHIB_SUBJECT, 'utf-8');\n" +
      "  assert.ok(!subject.includes('FORBIDDEN'), 'subject must not contain FORBIDDEN');\n" +
      "});\n");
    const cleanSubject = path.join(dir, 'clean-subject.txt');
    fs.writeFileSync(cleanSubject, 'this subject is clean\n');
    const badFixture = path.join(dir, 'bad-subject.txt');
    fs.writeFileSync(badFixture, 'this subject contains FORBIDDEN content\n');
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: tf, failFirst: true, violationFixture: badFixture, cleanFixture: cleanSubject },
      { cwd: dir, runCheck: () => ({ passed: true }) },
    );
    assert.equal(result.status, 'green',
      'a content-dependent red (clean subject stays green) IS proven fail-first -> green');
    assert.equal(result.evidence[0].failFirstProof, 'violation-fixture');
  });

  test('a supplied-but-MISSING clean control fixture fails closed (#1346, symmetric with the violation guard)', (t) => {
    const enforce = require(ENFORCEMENT_LIB);
    const dir = createTempDir('prohib-missing-clean-');
    t.after(() => cleanup(dir));
    const tf = path.join(dir, 'neg.test.cjs');
    fs.writeFileSync(tf,
      "const { test } = require('node:test');\n" +
      "const assert = require('node:assert');\n" +
      "const fs = require('node:fs');\n" +
      "test('rejects the forbidden content', () => {\n" +
      "  const subject = fs.readFileSync(process.env.GSD_PROHIB_SUBJECT, 'utf-8');\n" +
      "  assert.ok(!subject.includes('FORBIDDEN'), 'subject must not contain FORBIDDEN');\n" +
      "});\n");
    const badFixture = path.join(dir, 'bad-subject.txt');
    fs.writeFileSync(badFixture, 'this subject contains FORBIDDEN content\n');
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      // cleanFixture points at a path that does not exist -> the control can't run -> fail-closed.
      { kind: 'node-test', target: tf, failFirst: true, violationFixture: badFixture, cleanFixture: path.join(dir, 'nope.txt') },
      { cwd: dir, runCheck: () => ({ passed: true }) },
    );
    assert.notEqual(result.status, 'green',
      'a supplied clean fixture that does not exist cannot run the control -> fail-closed');
  });

  // ─── #1906: the causation control is now MANDATORY for the node-test kind ───
  // Supersedes #1346's opt-in (ADR-1606 Decision 4; ADR-550 2026-06-21 addendum). Without a clean
  // fixture the causation control cannot run, so a node-test that reds merely BECAUSE
  // GSD_PROHIB_SUBJECT is set (ignoring the subject's CONTENT) would pass the fail-first proof. A
  // node-test descriptor that omits `cleanFixture` is therefore treated as UN-PROVABLE (fail-closed),
  // never accepted under the weaker proof. The lint-rule kind is unchanged (its subject IS the linted
  // file; no GSD_PROHIB_SUBJECT indirection, so the "reds because the env var is set" gap can't exist).
  test('a DECEPTIVE content-independent red is NOT proven fail-first when NO clean fixture is supplied (#1906 regression)', (t) => {
    const enforce = require(ENFORCEMENT_LIB);
    const dir = createTempDir('prohib-deceptive-noclean-');
    t.after(() => cleanup(dir));
    // Deceptive: reds whenever a subject is PRESENT, regardless of its content. Goes RED against the
    // bad fixture (looks fail-first) — pre-#1906 this GREENED because no clean control ran. Now the
    // mandatory control's absence makes the check un-provable -> fail-closed.
    const tf = path.join(dir, 'neg.test.cjs');
    fs.writeFileSync(tf,
      "const { test } = require('node:test');\n" +
      "const assert = require('node:assert');\n" +
      "test('reds whenever a subject is present (deceptive, content-independent)', () => {\n" +
      "  assert.ok(!process.env.GSD_PROHIB_SUBJECT, 'fails whenever a subject is set');\n" +
      "});\n");
    const badFixture = path.join(dir, 'bad-subject.txt');
    fs.writeFileSync(badFixture, 'this subject contains FORBIDDEN content\n');
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      // NO cleanFixture — pre-#1906 the causation control was skipped and this greened.
      { kind: 'node-test', target: tf, failFirst: true, violationFixture: badFixture },
      { cwd: dir, runCheck: () => ({ passed: true }) },
    );
    assert.notEqual(result.status, 'green',
      'a node-test that omits the mandatory clean control is un-provable -> fail-closed (#1906)');
    assert.equal(result.located, true, 'the check is still located; it just cannot be proven fail-first');
  });

  test('even an HONEST content-dependent node-test hard-gates when NO clean fixture is supplied (#1906 mandatory)', (t) => {
    const enforce = require(ENFORCEMENT_LIB);
    const dir = createTempDir('prohib-honest-noclean-');
    t.after(() => cleanup(dir));
    // Honest: reds ONLY when the subject's CONTENT contains FORBIDDEN. Pre-#1906 this greened on the
    // violation alone. Post-#1906 the control is required, so an honest test with no clean fixture is
    // un-provable — the author must supply a clean control subject to earn the green.
    const tf = path.join(dir, 'neg.test.cjs');
    fs.writeFileSync(tf,
      "const { test } = require('node:test');\n" +
      "const assert = require('node:assert');\n" +
      "const fs = require('node:fs');\n" +
      "test('rejects the forbidden content (content-dependent)', () => {\n" +
      "  const subject = fs.readFileSync(process.env.GSD_PROHIB_SUBJECT, 'utf-8');\n" +
      "  assert.ok(!subject.includes('FORBIDDEN'), 'subject must not contain FORBIDDEN');\n" +
      "});\n");
    const badFixture = path.join(dir, 'bad-subject.txt');
    fs.writeFileSync(badFixture, 'this subject contains FORBIDDEN content\n');
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: tf, failFirst: true, violationFixture: badFixture },
      { cwd: dir, runCheck: () => ({ passed: true }) },
    );
    assert.notEqual(result.status, 'green',
      'the node-test causation control is mandatory (#1906); no clean fixture -> un-provable -> fail-closed');
  });

  test('a HANGING node-test fails closed via the bounded timeout (B2: no unbounded subprocess)', (t) => {
    const enforce = require(ENFORCEMENT_LIB);
    const dir = createTempDir('prohib-hang-');
    t.after(() => cleanup(dir));
    const tf = path.join(dir, 'hang.test.cjs');
    // A test that never returns; the bounded timeout must kill it and dispose non-green.
    fs.writeFileSync(tf,
      "const { test } = require('node:test');\ntest('hangs forever', () => { while (true) {} });\n");
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: tf, failFirst: true },
      { cwd: dir, timeoutMs: 1500 },
    );
    assert.notEqual(result.status, 'green', 'a hung check must be killed and fail closed — never hang verify or green');
    assert.equal(result.located, true);
  });

  test('an EMPTY node-test file (exit 0, zero tests) does NOT green via the real runner (BL-01)', (t) => {
    const enforce = require(ENFORCEMENT_LIB);
    const dir = createTempDir('prohib-real-empty-');
    t.after(() => cleanup(dir));
    const tf = path.join(dir, 'empty.test.cjs');
    fs.writeFileSync(tf, '// intentionally empty — no test cases\n');
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: tf, failFirst: true },
      { cwd: dir },
    );
    assert.notEqual(result.status, 'green', 'an empty (zero-test) file must NEVER green — fail-closed');
    assert.equal(result.located, true, 'the check was located; it just did not genuinely pass');
    assert.equal(result.evidence.length, 0);
  });

  test('a clean in-tree target greens the lint-rule kind via the real eslint + real prover (SF-01: plugin loads)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // Migrated to the SHIPPING prover (#1279): the default real prover lints the committed
    // `_ff_lint_violation.cjs` violationFixture (the rule fires -> fail-first proven) while the
    // clean runCheck lints tests/_ff_lint_clean.cjs (no violation -> non-vacuous pass). Both via real eslint.
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      {
        kind: 'lint-rule',
        rule: 'local/no-source-grep',
        target: 'tests/_ff_lint_clean.cjs',
        failFirst: true,
        violationFixture: path.join('tests', '_ff_lint_violation.cjs'),
      },
      { cwd: process.cwd() },
    );
    assert.equal(result.status, 'green', 'a clean target proven fail-first must green via real eslint');
    assert.equal(result.kind, 'lint-rule');
    assert.equal(result.evidence[0].rule, 'local/no-source-grep');
    assert.equal(result.evidence[0].failFirstProof, 'violation-fixture',
      'the real prover records the proof method (FF-07)');
  });

  test('an eslint-IGNORED target does NOT green the lint-rule kind (vacuous-green guard, NEW-BL-01)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // The generated bin/lib artifact is eslint-ignored. Without --no-warn-ignored, eslint returns a
    // length-1 "File ignored" result that would falsely pass the vacuity guard. It must fail closed.
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'lint-rule', rule: 'local/no-source-grep', target: 'gsd-core/bin/lib/prohibition-enforcement.cjs', failFirst: true },
      { cwd: process.cwd() },
    );
    assert.notEqual(result.status, 'green', 'an ignored path lints nothing — must NEVER green');
    assert.equal(result.located, true, 'the descriptor was well-formed; it just did not genuinely pass');
  });

  // ─── #1279 FULL-producer real-runner capstone (NO injected runCheck / proveFailFirst) ───────────
  // These exercise the COMPOSED runProhibitionEnforcement producer with NEITHER seam injected — the
  // SHIPPING defaultProveFailFirst + defaultRunCheck both run real subprocesses. This is the exact
  // path #1259's BL-01/SF-01 bypassed: an injected double can fake the runner, so the real-subprocess
  // behavior (eslint plugin load, GSD_PROHIB_SUBJECT convention, fail-first proof) was unproven at the
  // producer level until now. Both kinds, both directions, both modes. Typed-field assertions only.

  test('FULL producer (real prover + real runner): lint-rule greens on a real no-source-grep violation fixture + clean target (FF-02/FF-10)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // No injected runCheck/proveFailFirst: the default prover lints the committed
    // `_ff_lint_violation.cjs` (the rule fires -> fail-first proven) AND the default runner lints
    // the clean `tests/_ff_lint_clean.cjs` (no violation -> non-vacuous pass). BOTH directions via real eslint.
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      {
        kind: 'lint-rule',
        rule: 'local/no-source-grep',
        target: 'tests/_ff_lint_clean.cjs',
        violationFixture: path.join('tests', '_ff_lint_violation.cjs'),
      },
      { cwd: process.cwd() },
    );
    assert.equal(result.status, 'green', 'real prover (violation fixture red) + real runner (clean pass) must green');
    assert.equal(result.kind, 'lint-rule');
    assert.equal(result.located, true);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].failFirstProof, 'violation-fixture',
      'the SHIPPING prover records the proof method (FF-07)');
  });

  test('FULL producer (real): lint-rule hard-gates on a TOOTHLESS violationFixture (rule does not flag it) (FF-02 wrong-direction)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // The "violation fixture" is a CLEAN in-tree file (tests/_ff_lint_clean.cjs) the rule does NOT flag, so the
    // default prover cannot prove fail-first -> the producer must hard-gate (never green), even though
    // the clean target itself would pass the runner. A toothless guard is not a guard.
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      {
        kind: 'lint-rule',
        rule: 'local/no-source-grep',
        target: 'tests/_ff_lint_clean.cjs',
        violationFixture: 'tests/_ff_lint_clean.cjs',
      },
      { cwd: process.cwd() },
    );
    assert.notEqual(result.status, 'green', 'a fixture the rule does not flag cannot prove fail-first -> not green');
    assert.equal(result.flagged, true, 'the toothless-fixture miss is flagged');
    assert.equal(result.located, true, 'the descriptor was well-formed; it just could not be machine-proven');
    assert.equal(result.evidence.length, 0, 'no enforcement evidence on a hard-gate');
  });

  test('FULL producer (real): lint-rule TOOTHLESS-fixture hard-gate holds in BOTH interactive and autonomous modes (FF-04)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    for (const mode of ['interactive', 'autonomous']) {
      const result = enforce.runProhibitionEnforcement(
        TEST_TIER,
        {
          kind: 'lint-rule',
          rule: 'local/no-source-grep',
          target: 'tests/_ff_lint_clean.cjs',
          violationFixture: 'tests/_ff_lint_clean.cjs',
        },
        { cwd: process.cwd(), mode },
      );
      assert.notEqual(result.status, 'green', `un-provable lint-rule must not green in ${mode}`);
      assert.equal(result.flagged, true, `un-provable lint-rule is flagged in ${mode}`);
      assert.equal(result.mode, mode, 'mode echoed for transparency');
    }
  });

  test('FULL producer (real prover + real runner): node-test greens via GSD_PROHIB_SUBJECT — red on bad fixture, clean pass on clean subject (FF-03/FF-10)', (t) => {
    const enforce = require(ENFORCEMENT_LIB);
    const dir = createTempDir('prohib-full-node-green-');
    t.after(() => cleanup(dir));
    // A REAL negative test that honors the GSD_PROHIB_SUBJECT convention: it reads its subject and
    // asserts it is CLEAN. The default runner runs it with NO GSD_PROHIB_SUBJECT set -> the fixture
    // defaults to a clean in-dir subject -> passes non-vacuously. The default prover runs it with
    // GSD_PROHIB_SUBJECT=<bad fixture> -> the assertion fails -> RED -> fail-first proven.
    const negTest = path.join(dir, 'neg.test.cjs');
    fs.writeFileSync(negTest,
      "const { test } = require('node:test');\n" +
      "const assert = require('node:assert');\n" +
      "const fs = require('node:fs');\n" +
      "const path = require('node:path');\n" +
      "test('guards the must-NOT: subject is clean', () => {\n" +
      "  const subjectPath = process.env.GSD_PROHIB_SUBJECT || path.join(__dirname, 'clean-subject.txt');\n" +
      "  const subject = fs.readFileSync(subjectPath, 'utf-8');\n" +
      "  assert.ok(!subject.includes('FORBIDDEN'), 'subject must not contain FORBIDDEN');\n" +
      "});\n");
    fs.writeFileSync(path.join(dir, 'clean-subject.txt'), 'this subject is clean\n');
    const badFixture = path.join(dir, 'bad-subject.txt');
    fs.writeFileSync(badFixture, 'this subject contains FORBIDDEN content\n');
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      // #1906: the node-test causation control is mandatory — supply the clean control subject the
      // test already writes so the honest content-dependent path greens.
      { kind: 'node-test', target: negTest, violationFixture: badFixture, cleanFixture: path.join(dir, 'clean-subject.txt') },
      { cwd: dir },
    );
    assert.equal(result.status, 'green', 'real node-test proven RED on the bad subject + clean pass must green');
    assert.equal(result.kind, 'node-test');
    assert.equal(result.located, true);
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].failFirstProof, 'violation-fixture');
  });

  test('FULL producer (real): node-test WITHOUT a violationFixture hard-gates — default prover cannot prove fail-first (FF-05)', (t) => {
    const enforce = require(ENFORCEMENT_LIB);
    const dir = createTempDir('prohib-full-node-nofix-');
    t.after(() => cleanup(dir));
    // The SAME genuinely-passing negative test, but NO violationFixture. The default runner observes a
    // real non-vacuous pass, yet the default prover returns provenFailFirst:false (no fixture to prove
    // against) -> the producer must hard-gate. Pass alone never greens (machine proof required).
    const negTest = path.join(dir, 'neg.test.cjs');
    fs.writeFileSync(negTest,
      "const { test } = require('node:test');\n" +
      "const assert = require('node:assert');\n" +
      "const fs = require('node:fs');\n" +
      "const path = require('node:path');\n" +
      "test('guards the must-NOT: subject is clean', () => {\n" +
      "  const subjectPath = process.env.GSD_PROHIB_SUBJECT || path.join(__dirname, 'clean-subject.txt');\n" +
      "  const subject = fs.readFileSync(subjectPath, 'utf-8');\n" +
      "  assert.ok(!subject.includes('FORBIDDEN'), 'subject must not contain FORBIDDEN');\n" +
      "});\n");
    fs.writeFileSync(path.join(dir, 'clean-subject.txt'), 'this subject is clean\n');
    const result = enforce.runProhibitionEnforcement(
      TEST_TIER,
      { kind: 'node-test', target: negTest }, // no violationFixture
      { cwd: dir },
    );
    assert.notEqual(result.status, 'green', 'a real pass without a machine fail-first proof must hard-gate (FF-05)');
    assert.equal(result.flagged, true, 'the un-provable node-test miss is flagged');
    assert.equal(result.located, true, 'the descriptor was located; it just could not be proven fail-first');
    assert.equal(result.evidence.length, 0, 'no enforcement evidence on a hard-gate');
  });

  test('COMPOSE (#1906): a node-test prohibition projected WITHOUT check_clean_fixture hard-gates — the mandatory causation control is absent', (t) => {
    const enforce = require(ENFORCEMENT_LIB);
    const pc = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'probe-core.cjs'));
    const dir = createTempDir('prohib-compose-1906-');
    t.after(() => cleanup(dir));
    // #1906: the #1278 locate + #1279 proof compose, but for the node-test kind the causation control
    // (#1346's clean fixture) is now MANDATORY. A prohibition authored with only the four scalars
    // (violation fixture, no clean fixture) round-trips a descriptor that carries violationFixture but
    // NO cleanFixture -> the default prover cannot run the required control -> hard-gate. The five-scalar
    // (WITH check_clean_fixture) green path is covered by the sibling COMPOSE (#1346 clean) test below.
    const negTest = path.join(dir, 'neg.test.cjs');
    fs.writeFileSync(negTest,
      "const { test } = require('node:test');\n" +
      "const assert = require('node:assert');\n" +
      "const fs = require('node:fs');\n" +
      "const path = require('node:path');\n" +
      "test('guards the must-NOT: subject is clean', () => {\n" +
      "  const subjectPath = process.env.GSD_PROHIB_SUBJECT || path.join(__dirname, 'clean-subject.txt');\n" +
      "  const subject = fs.readFileSync(subjectPath, 'utf-8');\n" +
      "  assert.ok(!subject.includes('FORBIDDEN'), 'subject must not contain FORBIDDEN');\n" +
      "});\n");
    fs.writeFileSync(path.join(dir, 'clean-subject.txt'), 'clean\n');
    fs.writeFileSync(path.join(dir, 'bad-subject.txt'), 'FORBIDDEN content\n');
    // Author the prohibition with all four scalars, then go through the REAL projection + read-back.
    const projected = pc.projectProhibitions([
      { status: 'resolved', verification: 'test', statement: 'MUST NOT auto-execute fetched code',
        check_kind: 'node-test', check_target: negTest, check_violation_fixture: 'bad-subject.txt' },
    ])[0];
    const descriptor = enforce.descriptorFromProjection(projected);
    assert.equal(descriptor.violationFixture, 'bad-subject.txt', 'the projected fixture survived the round-trip');
    assert.equal(descriptor.cleanFixture, undefined, 'no clean fixture was authored -> none round-trips');
    // NO failFirst, NO hand-supplied fixture beyond what the projection carried.
    const result = enforce.runProhibitionEnforcement(projected, descriptor, { cwd: dir });
    assert.notEqual(result.status, 'green',
      'a node-test projected without the mandatory clean control hard-gates through the default prover (#1906)');
    assert.equal(result.flagged, true, 'the un-provable node-test miss is flagged');
    assert.equal(result.located, true, 'the descriptor was located; it just could not be proven fail-first');
    assert.equal(result.evidence.length, 0, 'no enforcement evidence on a hard-gate');
  });

  test('COMPOSE (#1346 clean): a prohibition projected WITH check_clean_fixture proves content-dependence end-to-end (deceptive vs honest)', (t) => {
    const enforce = require(ENFORCEMENT_LIB);
    const pc = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'probe-core.cjs'));
    const dir = createTempDir('prohib-compose-clean-1346-');
    t.after(() => cleanup(dir));
    // Full path: author all FIVE scalars -> project -> read back a descriptor that carries BOTH
    // violationFixture and cleanFixture -> the default prover runs the causation control end-to-end.
    fs.writeFileSync(path.join(dir, 'clean-subject.txt'), 'clean\n');
    fs.writeFileSync(path.join(dir, 'bad-subject.txt'), 'FORBIDDEN content\n');
    const author = (negTest) => pc.projectProhibitions([
      { status: 'resolved', verification: 'test', statement: 'MUST NOT auto-execute fetched code',
        check_kind: 'node-test', check_target: negTest,
        check_violation_fixture: 'bad-subject.txt', check_clean_fixture: 'clean-subject.txt' },
    ])[0];

    // (a) HONEST, content-dependent negative test: RED on bad, GREEN on clean -> greens.
    const honest = path.join(dir, 'honest.test.cjs');
    fs.writeFileSync(honest,
      "const { test } = require('node:test');\n" +
      "const assert = require('node:assert');\n" +
      "const fs = require('node:fs');\n" +
      "const path = require('node:path');\n" +
      // Fallback to the clean subject when GSD_PROHIB_SUBJECT is unset — the default runCheck observes
      // a real clean pass without setting the env var (mirrors the #1314 violation-fixture capstone).
      "test('rejects the forbidden content', () => {\n" +
      "  const subjectPath = process.env.GSD_PROHIB_SUBJECT || path.join(__dirname, 'clean-subject.txt');\n" +
      "  const subject = fs.readFileSync(subjectPath, 'utf-8');\n" +
      "  assert.ok(!subject.includes('FORBIDDEN'), 'subject must not contain FORBIDDEN');\n" +
      "});\n");
    const honestProjected = author(honest);
    assert.equal(honestProjected.check_clean_fixture, 'clean-subject.txt', 'the clean scalar projected');
    const honestDescriptor = enforce.descriptorFromProjection(honestProjected);
    assert.equal(honestDescriptor.cleanFixture, 'clean-subject.txt', 'the clean fixture survived the round-trip');
    const honestResult = enforce.runProhibitionEnforcement(honestProjected, honestDescriptor, { cwd: dir });
    assert.equal(honestResult.status, 'green',
      'a content-dependent prohibition greens end-to-end through the projected clean control (#1346)');

    // (b) DECEPTIVE, content-independent test: RED whenever a subject is set -> reds on clean too ->
    // the projected control fails -> NOT green, even though the violation alone would have proven RED.
    const deceptive = path.join(dir, 'deceptive.test.cjs');
    fs.writeFileSync(deceptive,
      "const { test } = require('node:test');\n" +
      "const assert = require('node:assert');\n" +
      "test('reds whenever a subject is present (deceptive)', () => {\n" +
      "  assert.ok(!process.env.GSD_PROHIB_SUBJECT, 'fails whenever a subject is set');\n" +
      "});\n");
    const deceptiveProjected = author(deceptive);
    const deceptiveDescriptor = enforce.descriptorFromProjection(deceptiveProjected);
    const deceptiveResult = enforce.runProhibitionEnforcement(deceptiveProjected, deceptiveDescriptor, { cwd: dir });
    assert.notEqual(deceptiveResult.status, 'green',
      'a content-independent deceptive prohibition is caught by the projected clean control end-to-end (#1346)');
  });
});

// ─── #1279 defaultProveFailFirst REAL prover end-to-end (FF-02 / FF-03 / FF-05 / FF-06 / FF-07) ──
// Exercises the SHIPPING default prover against REAL subprocesses (eslint + node --test) — the gap
// that let #1259's BL-01/SF-01 slip past injected doubles. The lint-rule path dogfoods the committed
// `tests/_ff_lint_violation.cjs` fixture; the node-test path uses synthetic temp fixtures that
// demonstrate the `GSD_PROHIB_SUBJECT` subject-injection convention. Typed-result assertions only.
describe('prohibition-enforcement defaultProveFailFirst REAL prover (#1279)', () => {
  const fs = require('node:fs');
  // The committed load-bearing lint fixture (a real, suppressed no-source-grep violation).
  const LINT_FIXTURE = 'tests/_ff_lint_violation.cjs';

  test('exports the prover surface (defaultProveFailFirst + FailFirstProof-shaped result)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    assert.equal(typeof enforce.defaultProveFailFirst, 'function',
      'must export defaultProveFailFirst — the default real prover');
  });

  test('lint-rule: proves red on the committed no-source-grep violation fixture (FF-02 red direction)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // Lint the KNOWN-violating fixture through the project flat config; the rule id MUST appear
    // (in messages or suppressedMessages) → the rule has teeth → fail-first proven.
    const proof = enforce.defaultProveFailFirst(
      { kind: 'lint-rule', rule: 'local/no-source-grep', target: LINT_FIXTURE, violationFixture: LINT_FIXTURE },
      process.cwd(),
    );
    assert.equal(proof.provenFailFirst, true,
      'a real no-source-grep violation fixture proves the lint rule fails-on-violation');
    assert.equal(proof.method, 'violation-fixture', 'records the proof method');
  });

  test('lint-rule: a CLEAN violationFixture (rule does not flag) is NOT proven (FF-02 toothless direction)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // tests/_ff_lint_clean.cjs is a clean in-tree source with no no-source-grep violation. If a "violation
    // fixture" does not actually trigger the rule, the rule is toothless on it → not a guard → not
    // proven → must hard-gate.
    const proof = enforce.defaultProveFailFirst(
      { kind: 'lint-rule', rule: 'local/no-source-grep', target: 'tests/_ff_lint_clean.cjs', violationFixture: 'tests/_ff_lint_clean.cjs' },
      process.cwd(),
    );
    assert.equal(proof.provenFailFirst, false,
      'a fixture the rule does not flag cannot prove fail-first');
  });

  test('lint-rule: no violationFixture -> not proven (FF-05 fail-closed)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const proof = enforce.defaultProveFailFirst(
      { kind: 'lint-rule', rule: 'local/no-source-grep', target: 'tests/_ff_lint_clean.cjs' }, // no violationFixture
      process.cwd(),
    );
    assert.equal(proof.provenFailFirst, false, 'no violationFixture -> cannot prove -> hard-gate');
  });

  test('node-test: a negative test that goes RED against a known-bad GSD_PROHIB_SUBJECT is proven (FF-03 red direction)', (t) => {
    const enforce = require(ENFORCEMENT_LIB);
    const dir = createTempDir('prohib-ff-node-red-');
    t.after(() => cleanup(dir));
    // A negative test that HONORS the GSD_PROHIB_SUBJECT convention: it reads the subject path and
    // asserts the subject is "clean" (does not contain the forbidden token). Against a KNOWN-BAD
    // fixture, the assertion fails → the run goes RED → fail-first proven.
    const negTest = path.join(dir, 'neg.test.cjs');
    fs.writeFileSync(negTest,
      "const { test } = require('node:test');\n" +
      "const assert = require('node:assert');\n" +
      "const fs = require('node:fs');\n" +
      "test('subject must not contain FORBIDDEN', () => {\n" +
      "  const subject = fs.readFileSync(process.env.GSD_PROHIB_SUBJECT, 'utf-8');\n" +
      "  assert.ok(!subject.includes('FORBIDDEN'), 'subject is clean');\n" +
      "});\n");
    const badFixture = path.join(dir, 'bad-subject.txt');
    fs.writeFileSync(badFixture, 'this subject contains FORBIDDEN content\n');
    // #1906: the causation control is mandatory for node-test — supply a KNOWN-CLEAN control subject
    // so the honest content-dependent test proves fail-first (RED on bad AND non-vacuous GREEN on clean).
    const cleanFixture = path.join(dir, 'clean-subject.txt');
    fs.writeFileSync(cleanFixture, 'this subject is clean\n');
    const proof = enforce.defaultProveFailFirst(
      { kind: 'node-test', target: negTest, violationFixture: badFixture, cleanFixture },
      dir,
    );
    assert.equal(proof.provenFailFirst, true,
      'the negative test goes RED against the known-bad subject -> fail-first proven');
    assert.equal(proof.method, 'violation-fixture');
  });

  test('node-test: a toothless negative test that PASSES even against the violation is NOT proven (FF-03 toothless direction)', (t) => {
    const enforce = require(ENFORCEMENT_LIB);
    const dir = createTempDir('prohib-ff-node-tooth-');
    t.after(() => cleanup(dir));
    // A negative test that ignores the subject and always passes — it never goes red, so it cannot
    // prove fail-first even with a violation fixture supplied.
    const negTest = path.join(dir, 'neg.test.cjs');
    fs.writeFileSync(negTest,
      "const { test } = require('node:test');\n" +
      "const assert = require('node:assert');\n" +
      "test('always passes (toothless)', () => { assert.ok(true); });\n");
    const badFixture = path.join(dir, 'bad-subject.txt');
    fs.writeFileSync(badFixture, 'FORBIDDEN\n');
    const proof = enforce.defaultProveFailFirst(
      { kind: 'node-test', target: negTest, violationFixture: badFixture },
      dir,
    );
    assert.equal(proof.provenFailFirst, false,
      'a test that does not go red against the violation is toothless -> not proven');
  });

  test('node-test: no violationFixture -> not proven (FF-05 fail-closed)', (t) => {
    const enforce = require(ENFORCEMENT_LIB);
    const dir = createTempDir('prohib-ff-node-nofix-');
    t.after(() => cleanup(dir));
    const negTest = path.join(dir, 'neg.test.cjs');
    fs.writeFileSync(negTest,
      "const { test } = require('node:test');\ntest('guards', () => {});\n");
    const proof = enforce.defaultProveFailFirst(
      { kind: 'node-test', target: negTest }, // no violationFixture
      dir,
    );
    assert.equal(proof.provenFailFirst, false,
      'a node-test with no violationFixture cannot be proven -> hard-gate, never attestation');
  });

  test('node-test: an HONEST test + a non-existent violationFixture path is NOT proven (FF-05 fail-OPEN guard, #1314 Major 1)', (t) => {
    const enforce = require(ENFORCEMENT_LIB);
    const dir = createTempDir('prohib-ff-node-missingfix-');
    t.after(() => cleanup(dir));
    // REGRESSION (#1314 review, Major 1): a REAL, honest negative test (its target file EXISTS and
    // loads cleanly) reads GSD_PROHIB_SUBJECT and fs.readFileSync's it. Point violationFixture at a
    // MISSING path (the realistic author typo / stale / moved-fixture case). Before the fix the missing
    // subject made the honest test throw ENOENT *inside its callback* — a failing test named distinctly
    // from the file — which isNonVacuousNodeTestRed accepted as a genuine RED, FORGING provenFailFirst:true
    // from a setup crash (fail-OPEN). The fs.existsSync(fixture) guard now fail-CLOSES this, symmetric
    // with the lint-rule path. Note this is the SAME honest-test shape as the FF-03 red-direction test —
    // only the fixture path is missing — so it is exactly the green-able producer minus a valid fixture.
    const negTest = path.join(dir, 'neg.test.cjs');
    fs.writeFileSync(negTest,
      "const { test } = require('node:test');\n" +
      "const assert = require('node:assert');\n" +
      "const fs = require('node:fs');\n" +
      "test('subject must not contain FORBIDDEN', () => {\n" +
      "  const subject = fs.readFileSync(process.env.GSD_PROHIB_SUBJECT, 'utf-8');\n" +
      "  assert.ok(!subject.includes('FORBIDDEN'), 'subject is clean');\n" +
      "});\n");
    const missingFixture = path.join(dir, 'does-not-exist-subject.txt'); // deliberately NOT written
    const proof = enforce.defaultProveFailFirst(
      { kind: 'node-test', target: negTest, violationFixture: missingFixture },
      dir,
    );
    assert.equal(proof.provenFailFirst, false,
      'a missing/typo\'d violationFixture must NOT forge a green from the honest test\'s ENOENT crash (fail-closed, symmetric with lint-rule)');
  });

  test('node-test: a RELATIVE violationFixture is resolved against cwd (existence guard matches the child, #1314 Major 1)', (t) => {
    const enforce = require(ENFORCEMENT_LIB);
    const dir = createTempDir('prohib-ff-node-relfix-');
    t.after(() => cleanup(dir));
    // The fixture is named RELATIVELY; the prover runs with cwd=dir and sets GSD_PROHIB_SUBJECT to the
    // raw relative name, which the child resolves against its cwd (=dir). The existence guard must use
    // the SAME base (path.resolve(cwd, fixture)) — a bare existsSync against the verify process's cwd
    // would not find it and would wrongly hard-gate a valid fixture. Proving TRUE here confirms the
    // relative path is honored end-to-end and the guard is cwd-correct.
    const negTest = path.join(dir, 'neg.test.cjs');
    fs.writeFileSync(negTest,
      "const { test } = require('node:test');\n" +
      "const assert = require('node:assert');\n" +
      "const fs = require('node:fs');\n" +
      "test('subject must not contain FORBIDDEN', () => {\n" +
      "  const subject = fs.readFileSync(process.env.GSD_PROHIB_SUBJECT, 'utf-8');\n" +
      "  assert.ok(!subject.includes('FORBIDDEN'), 'subject is clean');\n" +
      "});\n");
    fs.writeFileSync(path.join(dir, 'bad-subject.txt'), 'this subject contains FORBIDDEN content\n');
    // #1906: mandatory clean control, also named RELATIVELY so both runs exercise the cwd-relative guard.
    fs.writeFileSync(path.join(dir, 'clean-subject.txt'), 'this subject is clean\n');
    const proof = enforce.defaultProveFailFirst(
      { kind: 'node-test', target: negTest, violationFixture: 'bad-subject.txt', cleanFixture: 'clean-subject.txt' }, // RELATIVE to cwd
      dir,
    );
    assert.equal(proof.provenFailFirst, true,
      'a relative violationFixture resolved against cwd is found, runs RED, and proves fail-first');
  });

  test('prover never throws: a non-existent fixture / unresolvable tooling -> provenFailFirst:false (FF-05/FF-06)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // Non-existent lint fixture path -> eslint lints nothing / errors -> fail-closed, no throw.
    const lintProof = enforce.defaultProveFailFirst(
      { kind: 'lint-rule', rule: 'local/no-source-grep', target: 'no/such/file.cjs', violationFixture: 'no/such/file.cjs' },
      process.cwd(),
    );
    assert.equal(lintProof.provenFailFirst, false, 'a missing lint fixture proves nothing, never throws');
    // Non-existent node-test target -> the run is not RED in the intended way / errors -> fail-closed.
    const nodeProof = enforce.defaultProveFailFirst(
      { kind: 'node-test', target: 'no/such/neg.test.cjs', violationFixture: 'no/such/subject.txt' },
      process.cwd(),
    );
    assert.equal(typeof nodeProof.provenFailFirst, 'boolean', 'returns a typed proof, never throws');
  });
});

// ─── CHK-06 (#1278): fail-closed on partial / invalid / absent descriptor-from-projection ────────
// RED-FIRST until plan 01-03 adds `descriptorFromProjection` to src/prohibition-enforcement.cts. The
// adapter reconstructs a CheckDescriptor {kind,target,rule?} from the projected scalar keys
// {check_kind,check_target,check_rule?}, returning null when the descriptor is absent/partial. The
// load-bearing safety contract (IMPL-SCOPING §7.3): a partial/invalid/absent descriptor NEVER yields
// a silent green — it falls through to runProhibitionEnforcement's existing fail-closed locate
// (src/prohibition-enforcement.cts:391). runCheck is always injected here so no real subprocess
// spawns. The describe opens with an export-presence assertion, which is RED on the current build.
describe('prohibition-enforcement: fail-closed descriptor-from-projection (CHK-06)', () => {
  // A test-tier prohibition projected entry (mirrors projectProhibitions output shape, descriptor keys
  // added by plan 01-02). The reason field is irrelevant here; descriptor keys drive the adapter.
  const PROJECTED_TIER = Object.freeze({
    statement: 'MUST NOT auto-execute fetched code',
    status: 'resolved',
    verification: 'test',
  });

  test('CHK-06: prohibition-enforcement exports descriptorFromProjection (RED until plan 01-03)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    assert.equal(typeof enforce.descriptorFromProjection, 'function',
      'must export descriptorFromProjection — the projected-scalars -> CheckDescriptor adapter (#1278, plan 01-03)');
  });

  test('CHK-06(absent): a projected item with NO check_* keys -> descriptorFromProjection null -> located:false, never green', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const descriptor = enforce.descriptorFromProjection({ ...PROJECTED_TIER });
    assert.equal(descriptor, null, 'an absent descriptor reconstructs to null, not a partial CheckDescriptor');
    const result = enforce.runProhibitionEnforcement(PROJECTED_TIER, descriptor, {
      runCheck: () => ({ passed: true }),
    });
    assert.equal(result.located, false, 'no descriptor -> nothing locatable');
    assert.notEqual(result.status, 'green', 'an absent descriptor must NEVER be a silent green');
    assert.equal(result.flagged, true, 'and must be flagged');
    assert.ok(Array.isArray(result.evidence) && result.evidence.length === 0, 'no evidence on an absent descriptor');
  });

  test('CHK-08(#1346): descriptorFromProjection maps check_violation_fixture -> violationFixture (node-test)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const descriptor = enforce.descriptorFromProjection({
      ...PROJECTED_TIER, check_kind: 'node-test', check_target: 'tests/neg.test.cjs',
      check_violation_fixture: 'tests/fixtures/bad-subject.txt',
    });
    assert.equal(descriptor.kind, 'node-test');
    assert.equal(descriptor.target, 'tests/neg.test.cjs');
    assert.equal(descriptor.violationFixture, 'tests/fixtures/bad-subject.txt',
      'the projected check_violation_fixture must reconstruct as violationFixture so #1278 locate + #1279 proof compose');
  });

  test('CHK-08(#1346): descriptorFromProjection maps check_violation_fixture -> violationFixture (lint-rule)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const descriptor = enforce.descriptorFromProjection({
      ...PROJECTED_TIER, check_kind: 'lint-rule', check_target: 'src/', check_rule: 'local/no-source-grep',
      check_violation_fixture: 'tests/_ff_lint_violation.cjs',
    });
    assert.equal(descriptor.kind, 'lint-rule');
    assert.equal(descriptor.rule, 'local/no-source-grep');
    assert.equal(descriptor.violationFixture, 'tests/_ff_lint_violation.cjs');
  });

  test('CHK-08(#1346): no check_violation_fixture -> descriptor carries no violationFixture (fail-closed: green needs a fixture)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const descriptor = enforce.descriptorFromProjection({
      ...PROJECTED_TIER, check_kind: 'node-test', check_target: 'tests/neg.test.cjs',
    });
    assert.equal(descriptor.violationFixture, undefined,
      'absent check_violation_fixture must NOT fabricate a fixture; the default prover then hard-gates (no green)');
  });

  test('CHK-08(#1346 clean): descriptorFromProjection maps check_clean_fixture -> cleanFixture (node-test)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const descriptor = enforce.descriptorFromProjection({
      ...PROJECTED_TIER, check_kind: 'node-test', check_target: 'tests/neg.test.cjs',
      check_violation_fixture: 'tests/fixtures/bad-subject.txt',
      check_clean_fixture: 'tests/fixtures/clean-subject.txt',
    });
    assert.equal(descriptor.cleanFixture, 'tests/fixtures/clean-subject.txt',
      'the projected check_clean_fixture must reconstruct as cleanFixture so the causation control runs end-to-end (#1346)');
  });

  test('CHK-08(#1346 clean): no check_clean_fixture -> descriptor carries no cleanFixture (no control; documented residual remains)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const descriptor = enforce.descriptorFromProjection({
      ...PROJECTED_TIER, check_kind: 'node-test', check_target: 'tests/neg.test.cjs',
      check_violation_fixture: 'tests/fixtures/bad-subject.txt',
    });
    assert.equal(descriptor.cleanFixture, undefined,
      'absent check_clean_fixture must NOT fabricate a control; the prover keeps the documented residual, backward-compatible');
  });

  test('CHK-06(lint-rule missing rule): {check_kind:lint-rule, check_target:src/} (no check_rule) -> located:false, never green', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const descriptor = enforce.descriptorFromProjection({
      ...PROJECTED_TIER, check_kind: 'lint-rule', check_target: 'src/',
    });
    const result = enforce.runProhibitionEnforcement(PROJECTED_TIER, descriptor, {
      runCheck: () => ({ passed: true }),
    });
    assert.equal(result.located, false, 'an under-specified lint-rule (no rule id) is not locatable (validRule guard, :390)');
    assert.notEqual(result.status, 'green', 'a lint-rule missing its rule id must NEVER green');
    assert.equal(result.flagged, true);
  });

  test('CHK-06(unknown kind): {check_kind:shell-script} -> validKind false -> located:false, never green', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const descriptor = enforce.descriptorFromProjection({
      ...PROJECTED_TIER, check_kind: 'shell-script', check_target: 'x',
    });
    const result = enforce.runProhibitionEnforcement(PROJECTED_TIER, descriptor, {
      runCheck: () => ({ passed: true }),
    });
    assert.equal(result.located, false, 'an unknown kind is not a valid wired check (validKind guard, :388)');
    assert.notEqual(result.status, 'green', 'an unknown check kind must NEVER green');
    assert.equal(result.flagged, true);
  });

  test('CHK-06(well-formed but runCheck reports non-pass): located:true, never green (no false green)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const descriptor = enforce.descriptorFromProjection({
      ...PROJECTED_TIER, check_kind: 'node-test', check_target: 'tests/no-autoexec.test.cjs',
    });
    // A complete node-test descriptor; failFirst is caller-attested at verify time (#1279), not sourced
    // from the projection, so attest it here. The injected runCheck reports a non-pass.
    const result = enforce.runProhibitionEnforcement(
      PROJECTED_TIER,
      descriptor ? { ...descriptor, failFirst: true } : descriptor,
      { runCheck: () => ({ passed: false }) },
    );
    assert.equal(result.located, true, 'a well-formed descriptor IS located even though the run did not pass');
    assert.notEqual(result.status, 'green', 'a located check that does not genuinely pass must NEVER green');
    assert.equal(result.flagged, true);
  });

  test('CHK-06(MD-01 numeric coercion): a numeric-looking check_target reconstructs as a STRING (parseMustHavesBlock coerces ^\\d+$ to number) -> located, no type-lie / silent un-locate', () => {
    const enforce = require(ENFORCEMENT_LIB);
    // The shared parseMustHavesBlock (src/frontmatter.cts) coerces a /^\d+$/ scalar value to a NUMBER on
    // round-trip, so a numeric-looking check_target arrives at the adapter as a number. The adapter must
    // String()-coerce it (not cast `as string` over a number), so the descriptor is honestly typed AND a
    // numeric-looking target still locates instead of silently un-locating (the round-trip is lossless
    // across the full string domain — closes review finding MD-01/LW-01).
    const descriptor = enforce.descriptorFromProjection({
      ...PROJECTED_TIER, check_kind: 'node-test', check_target: 12345,
    });
    assert.equal(typeof descriptor.target, 'string',
      'a numeric-coerced check_target must reconstruct as a string, never a number behind an `as string` cast');
    assert.equal(descriptor.target, '12345');
    const result = enforce.runProhibitionEnforcement(
      PROJECTED_TIER,
      { ...descriptor, failFirst: true },
      { runCheck: () => ({ passed: true }) },
    );
    assert.equal(result.located, true,
      'a numeric-looking but valid target locates after String() coercion — no silent un-locate');
  });

  test('CHK-06(LW-02 stray rule): a check_rule on a node-test descriptor is dropped (rule belongs to lint-rule only)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const descriptor = enforce.descriptorFromProjection({
      ...PROJECTED_TIER, check_kind: 'node-test', check_target: 'tests/x.test.cjs', check_rule: 'local/no-source-grep',
    });
    assert.equal(descriptor.rule, undefined, 'a node-test descriptor carries no rule even if a stray check_rule is present');
  });
});
