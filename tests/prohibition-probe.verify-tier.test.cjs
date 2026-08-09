// allow-test-rule: source-text-is-the-product (see #644) — the verify-time disposition of a test-tier
// prohibition is the deployed safety contract; this pins its fail-closed default to the code.
//
// RED-first SAFETY HALF of ADR-550 Decision 5(d) [maintainer decision 2026-06-12 "B-with-guard"].
// A WELL-FORMED test-tier prohibition (statement + status: resolved + verification: test) with NO
// wired enforcement evidence MUST yield a NON-GREEN / flagged-unverified disposition — proving an
// unwired test-tier item can NEVER be silently skipped (fail-closed default).
//
// This lives in its OWN test file (not the schema file) because it asserts a verify-disposition
// behavior — a different production module than frontmatter. The deterministic disposition helper
// does not exist yet (plan 01-04 implements the fail-closed default; the seam mirrors
// projectProhibitions in probe-core) — assert its expected contract so this is RED now.
//
// This is the cheap safety-guarantee half; the heavy "real negative-test enforcement mechanism" half
// is OUT of #644 scope (follow-up PR). No `polarity` key; no LLM judgment asserted (ADR-550 D5).
'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PROBE_CORE_LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'probe-core.cjs');
// The ENFORCEMENT-half producer (#1259, ADR-550 D5d heavy half). Authored as
// src/prohibition-enforcement.cts and compiled by `npm run build:lib` to this gitignored
// artifact — mirroring how PROBE_CORE_LIB requires the BUILT probe-core.cjs above.
const ENFORCEMENT_LIB = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'prohibition-enforcement.cjs');

describe('prohibition-probe verify-tier: test-tier fail-closed safety (PROB-12 / ADR-550 D5d)', () => {
  test('probe-core exports a deterministic prohibition-disposition helper', () => {
    const pc = require(PROBE_CORE_LIB);
    assert.equal(typeof pc.dispositionForProhibition, 'function',
      'probe-core must export dispositionForProhibition() — the deterministic verify-time disposition (ADR-550 D5d)');
  });

  test('a well-formed test-tier item with NO enforcement evidence is flagged non-green (fail-closed)', () => {
    const pc = require(PROBE_CORE_LIB);

    // Synthetic, well-formed test-tier prohibition with NO wired enforcement evidence.
    const unwiredTestTier = {
      requirement_id: 'R1',
      category: 'safety',
      status: 'resolved',
      verification: 'test',
      resolution: null,
      reason: null,
      statement: 'MUST NOT store raw SSN in plaintext',
      // deliberately: no enforcement evidence wired (no test reference / no proof)
    };

    const disposition = pc.dispositionForProhibition(unwiredTestTier, { enforcementEvidence: [] });

    // The disposition must NOT be a silent pass. Accept any explicit non-green signal the helper
    // chooses, but it must be unambiguously NOT 'green'/'pass' and must carry a flag.
    assert.ok(disposition && typeof disposition === 'object', 'disposition must be a structured object');
    assert.notEqual(disposition.status, 'green', 'an unwired test-tier item must NEVER be green (fail-closed)');
    assert.notEqual(disposition.status, 'pass', 'an unwired test-tier item must NEVER pass silently (fail-closed)');
    assert.equal(disposition.flagged, true,
      'an unwired test-tier item must be flagged unverified — it can never be silently skipped');
  });
});

// ─── ENFORCEMENT HALF (#1259, ADR-550 D5d heavy half) ──────────────────────────
//
// RED-first: these assertions require the BUILT gsd-core/bin/lib/prohibition-enforcement.cjs,
// which does not exist until Task 2 authors src/prohibition-enforcement.cts and runs build:lib.
// They prove the previously-unreachable green branch in dispositionForProhibition (probe-core
// 420-427) becomes reachable from a real PRODUCER: a passing wired test-tier check builds
// non-empty enforcementEvidence -> green; a missing or failing check hard-gates (flagged,
// non-green) in BOTH interactive and autonomous modes (ADR-550 D4 / D3).
//
// Typed-field assertions ONLY (status / flagged / tier / evidence / located / kind / mode-block).
// The check-runner is injected via options.runCheck so no real subprocess is spawned; the GREEN
// cases (A/B) ALSO inject options.proveFailFirst since #1279 (FF-08) requires fail-first to be
// MACHINE-PROVEN — caller attestation (failFirst:true) alone no longer greens.
describe('prohibition-probe verify-tier: test-tier ENFORCEMENT (REQ-PROHIB-07 / ADR-550 D5d)', () => {
  const testTierProhibition = {
    requirement_id: 'R1',
    category: 'safety',
    status: 'resolved',
    verification: 'test',
    resolution: null,
    reason: null,
    statement: 'MUST NOT read source files and text-search them in tests',
  };

  // Test A — node --test negative test that PASSES -> green + non-empty evidence.
  // #1279 (FF-08): attestation alone no longer greens — the producer requires the fail-first to be
  // MACHINE-PROVEN. With injected runCheck (no real subprocess) we also inject a proving prover so
  // the GREEN direction is exercised; the hard-gate directions (C/D/D2 below) need no prover.
  test('A: wired node-test check that passes disposes green with non-empty enforcement evidence', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(
      testTierProhibition,
      { kind: 'node-test', target: 'tests/some-negative.test.cjs', failFirst: true },
      { runCheck: () => ({ passed: true }), proveFailFirst: () => ({ provenFailFirst: true }) },
    );
    assert.ok(result && typeof result === 'object', 'result must be a structured object');
    assert.equal(result.status, 'green', 'a passing wired node-test check must dispose green');
    assert.equal(result.flagged, false, 'a green test-tier disposition must not be flagged');
    assert.equal(result.tier, 'test', 'tier must be preserved as test');
    assert.equal(result.located, true, 'the wired check was locatable');
    assert.ok(Array.isArray(result.evidence) && result.evidence.length >= 1,
      'a passing check must build non-empty enforcementEvidence (the array dispositionForProhibition reads)');
  });

  // Test B — lint/AST-rule (no-source-grep) check that PASSES -> green (D4 dogfood anchor).
  test('B: wired lint-rule (no-source-grep) check that passes disposes green', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(
      testTierProhibition,
      { kind: 'lint-rule', rule: 'local/no-source-grep', target: 'tests/', failFirst: true },
      { runCheck: () => ({ passed: true }), proveFailFirst: () => ({ provenFailFirst: true }) },
    );
    assert.equal(result.status, 'green', 'a passing wired lint-rule check must dispose green');
    assert.equal(result.flagged, false, 'a green disposition must not be flagged');
    assert.equal(result.kind, 'lint-rule', 'the located check kind must be the lint-rule kind');
    assert.ok(Array.isArray(result.evidence) && result.evidence.length >= 1,
      'a passing lint-rule check must build non-empty enforcementEvidence');
  });

  // Test C — MISSING check (no locatable wired check) -> hard-gate (non-green, flagged).
  test('C: a test-tier prohibition with NO locatable wired check hard-gates (non-green, flagged)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(
      testTierProhibition,
      null,
      { runCheck: () => ({ passed: true }) },
    );
    assert.notEqual(result.status, 'green', 'a missing wired check must NEVER be green (fail-closed)');
    assert.equal(result.flagged, true, 'a missing wired check must be flagged unverified');
    assert.equal(result.located, false, 'no check was locatable');
    assert.ok(Array.isArray(result.evidence) && result.evidence.length === 0,
      'a missing check builds no enforcement evidence');
  });

  // Test D — FAILING check -> hard-gate in BOTH modes (interactive + autonomous).
  test('D: a wired check that FAILS hard-gates (non-green, flagged) in both modes', () => {
    const enforce = require(ENFORCEMENT_LIB);
    for (const mode of ['interactive', 'autonomous']) {
      const result = enforce.runProhibitionEnforcement(
        testTierProhibition,
        { kind: 'node-test', target: 'tests/some-negative.test.cjs', failFirst: true },
        { runCheck: () => ({ passed: false }), mode },
      );
      assert.notEqual(result.status, 'green',
        `a failing wired check must NEVER be green (mode=${mode})`);
      assert.equal(result.flagged, true,
        `a failing wired check must be flagged in both modes (mode=${mode})`);
      assert.equal(result.located, true, 'the check was located even though it failed');
    }
  });

  // D (fail-first not satisfied) — a check that is NOT fail-first is not a valid regression proof.
  test('D2: a wired check that is not fail-first hard-gates (non-green, flagged)', () => {
    const enforce = require(ENFORCEMENT_LIB);
    const result = enforce.runProhibitionEnforcement(
      testTierProhibition,
      { kind: 'node-test', target: 'tests/some-negative.test.cjs', failFirst: false },
      { runCheck: () => ({ passed: true }) },
    );
    assert.notEqual(result.status, 'green',
      'a check that is not fail-first is not a valid regression-must-fail-first proof — never green');
    assert.equal(result.flagged, true, 'a non-fail-first check must be flagged');
  });
});
