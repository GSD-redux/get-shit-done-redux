'use strict';

// Issue #3304 — re-verification convergence: an out-of-contract, unevidenced
// blocker must not revert a completed gap-closure round or trigger another
// --gaps cycle. Content-assertion contract for the gsd-verifier agent (same
// basis as tests/verifier-behavior-unverified.test.cjs and
// tests/verifier-deferred-items.test.cjs — the agent .md file IS the deployed
// product; testing its text tests the shipped contract).
//
// Maintainer approval was narrowed to condition C only (deterministic
// evidence gates a new-scope blocker), rejecting the reporter's broader A/B
// (advisory whenever untraceable to a requirement/decision/prior-gap,
// regardless of evidence) — several tests below pin that narrowing so a
// future edit can't silently widen it back out.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const verifierPath = path.join(ROOT, 'agents', 'gsd-verifier.md');
const verifier = fs.readFileSync(verifierPath, 'utf-8');
const gatePath = path.join(ROOT, 'gsd-core', 'references', 'verifier-evidence-gate.md');
const gate = fs.readFileSync(gatePath, 'utf-8');

test('gsd-verifier.md required_reading loads the evidence-gate reference', () => {
  assert.match(
    verifier,
    /<required_reading>[\s\S]*?@~\/\.claude\/gsd-core\/references\/verifier-evidence-gate\.md[\s\S]*?<\/required_reading>/,
  );
});

test('verifier-evidence-gate.md reference file exists and is non-trivial', () => {
  assert.ok(fs.existsSync(gatePath), 'gsd-core/references/verifier-evidence-gate.md should exist');
  assert.ok(gate.length > 500, 'reference file should contain the full algorithm, not a stub');
});

test('Step 7 gates on re-verification mode only', () => {
  assert.match(verifier, /Re-verification evidence gate[\s\S]{0,80}#3304/);
  assert.match(verifier, /in re-verification mode[\s\S]{0,400}?blocks unconditionally only if/);
});

test('debt marker gate stays self-evidencing and unconditional (not routed through the new gate)', () => {
  const m = verifier.match(/Re-verification evidence gate[\s\S]{0,600}/);
  assert.ok(m, 'evidence gate paragraph must exist');
  assert.match(m[0], /other than an unresolved debt marker \(always self-evidencing\)/);
});

test('carried-forward gaps and regressions still block unconditionally, evidence or not', () => {
  const m = verifier.match(/Re-verification evidence gate[\s\S]{0,600}/);
  assert.match(m[0], /carried-forward gap \(Step 0's `gaps:`\)/);
  assert.match(m[0], /git-modified since the prior `verified:` timestamp/);
});

test('unresolvable git history fails closed toward blocking', () => {
  assert.match(verifier, /fail closed: unresolvable history counts as modified/);
  assert.match(gate, /\*\*Fail closed\*\*/);
});

test('unevidenced new-scope findings route to advisory, not gaps_found', () => {
  const m = verifier.match(/Re-verification evidence gate[\s\S]{0,600}/);
  assert.match(m[0], /Unevidenced → 📋 Advisory/);
  assert.match(m[0], /exclude from Step 9 Rule 1/);
  assert.match(m[0], /never revert a completed must-have/);
});

test('Categorize line adds the Advisory bucket alongside Blocker/Warning/Info', () => {
  const line = verifier.match(/^Categorize:.*$/m);
  assert.ok(line, 'Categorize line must exist');
  assert.match(line[0], /🛑 Blocker/);
  assert.match(line[0], /⚠️ Warning/);
  assert.match(line[0], /ℹ️ Info/);
  assert.match(line[0], /📋 Advisory/);
});

test('VERIFICATION.md frontmatter template carries the advisory: list', () => {
  assert.match(
    verifier,
    /advisory: # Only if unevidenced new-scope findings exist \(Step 7, re-verification only\)/,
  );
  assert.match(verifier, /advisory:[\s\S]{0,200}?category: architectural \| security \| other/);
  assert.match(verifier, /advisory:[\s\S]{0,300}?evidence_status:/);
});

test('report body template includes an Advisory section, positioned after Deferred Items', () => {
  const deferredIdx = verifier.indexOf('### Deferred Items');
  const advisoryIdx = verifier.indexOf('### Advisory (New Scope, Unevidenced)');
  assert.notEqual(deferredIdx, -1, 'Deferred Items section must exist');
  assert.notEqual(advisoryIdx, -1, 'Advisory section must exist');
  assert.ok(advisoryIdx > deferredIdx, 'Advisory section should follow Deferred Items');
});

test('Advisory section instructs inclusion even when empty', () => {
  const sectionStart = verifier.indexOf('### Advisory (New Scope, Unevidenced)');
  const nextSection = verifier.indexOf('### Required Artifacts', sectionStart);
  assert.notEqual(sectionStart, -1);
  assert.notEqual(nextSection, -1);
  const section = verifier.slice(sectionStart, nextSection);
  assert.match(section, /even "None"/);
});

// ─── Reference file: definitions and rejected-scope pins ──────────────────

test('reference file scopes the gate to Step 7 only — truths/artifacts/key-links excluded', () => {
  assert.match(
    gate,
    /Truths, artifacts, and key links[\s\S]{0,200}?can \*\*never\*\* produce this\s*\nfailure mode/,
  );
});

test('reference file explicitly rejects conditions A/B from the issue (contract-traceability alone)', () => {
  const m = gate.match(/## What this deliberately does NOT implement[\s\S]{0,700}/);
  assert.ok(m, 'the "does NOT implement" section must exist');
  assert.match(m[0], /conditions A and B/);
  assert.match(m[0], /maintainer approved \*\*condition C only\*\*/);
  assert.match(m[0], /Do not implement A\/B/);
});

test('reference file defines deterministic evidence as a run-red test or a reproducible artifact', () => {
  assert.match(gate, /named test that FAILS when actually run/);
  assert.match(gate, /Another concrete, reproducible artifact/);
  assert.match(gate, /is not evidence, however well-reasoned/);
});

test('reference file uses file-level git check, not line-level (reliability tradeoff is disclosed)', () => {
  assert.match(gate, /git log --since="\$PREV_VERIFIED_TS" --oneline -- "\$file"/);
  assert.match(gate, /Check file-level, not\s*\nline-level/);
});

test('reference file carries a worked example grounded in the reported incident', () => {
  assert.match(gate, /## Worked example \(from the issue's reported incident\)/);
  assert.match(gate, /→ \*\*advisory\*\*, does not\s*\nblock/);
});

// ─── Parity: advisory is a per-finding annotation, never an overall status ─

test('PARITY: advisory never leaks into the overall-status vocabulary', () => {
  const unionLines = verifier.match(/^status:\s+[a-z_]+(?:\s*\|\s*[a-z_]+)+\s*$/gm) || [];
  assert.ok(unionLines.length > 0, 'expected at least one status union line');
  for (const line of unionLines) {
    assert.doesNotMatch(line, /advisory/i);
  }
});

test('PARITY: overall-status enum in verification.cts does not gain an "advisory" status', () => {
  const verificationLib = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'verification.cjs'));
  const { VERIFIER_STATUSES } = verificationLib;
  assert.ok(Array.isArray(VERIFIER_STATUSES), 'VERIFIER_STATUSES array must be present');
  assert.ok(
    !VERIFIER_STATUSES.includes('advisory'),
    'VERIFIER_STATUSES must not gain a per-finding "advisory" state — it stays a per-finding annotation',
  );
  for (const s of ['passed', 'gaps_found', 'human_needed']) {
    assert.ok(VERIFIER_STATUSES.includes(s), `VERIFIER_STATUSES must still contain ${s}`);
  }
});
