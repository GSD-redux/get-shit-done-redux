'use strict';

// Issue #966 — behavior-dependent must-haves must not pass on symbol presence.
// Content-assertion contract for the gsd-verifier agent: the
// PRESENT_BEHAVIOR_UNVERIFIED per-truth state, its routing to human_needed,
// the behavior-verified score split, and the parity invariant that the new
// per-truth state never leaks into the overall-status vocabulary.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const verifierPath = path.join(ROOT, 'agents', 'gsd-verifier.md');
const verifier = fs.readFileSync(verifierPath, 'utf-8');
const standaloneTemplatePath = path.join(ROOT, 'gsd-core', 'templates', 'verification-report.md');
const standalone = fs.readFileSync(standaloneTemplatePath, 'utf-8');

test('Step 3 defines the PRESENT_BEHAVIOR_UNVERIFIED per-truth state', () => {
  assert.match(verifier, /PRESENT_BEHAVIOR_UNVERIFIED/);
  assert.match(verifier, /present[^\n]*wired|wired[^\n]*present/i);
});

test('behavior-dependent trigger names transition + cancellation/cleanup/ordering invariants', () => {
  assert.match(verifier, /state transition/i);
  assert.match(verifier, /cancellation|cleanup|ordering/i);
  assert.match(verifier, /invariant/i);
});

test('PRESENT_BEHAVIOR_UNVERIFIED routes to human verification', () => {
  assert.match(verifier, /PRESENT_BEHAVIOR_UNVERIFIED[\s\S]{0,400}?human/i);
});

test('PRESENT_BEHAVIOR_UNVERIFIED is the only truth excluded from the verified score', () => {
  assert.match(
    verifier,
    /(do not count it toward the verified score)|(only[^\n]*excluded from `verified_truths`)|(only truths excluded)/i,
  );
});

test('score still credits PASSED (override) truths (override contract preserved)', () => {
  // The Step 9 score definition must count override-passed truths in verified_truths.
  assert.match(
    verifier,
    /verified_truths[\s\S]{0,200}?PASSED \(override\)/,
    'Step 9 score must count PASSED (override) truths in verified_truths',
  );
});

test('behavior-unverified truths get a structured frontmatter list that survives gaps_found', () => {
  assert.match(verifier, /behavior_unverified_items/);
  // and it must NOT be gated only to human_needed (must mention it is emitted regardless of status / when count > 0)
  assert.match(
    verifier,
    /behavior_unverified_items[\s\S]{0,160}?(regardless of (overall )?status|count > 0)/i,
  );
});

test('Step 9 / template carry the behavior_unverified score-split field', () => {
  assert.match(verifier, /behavior_unverified/);
});

test('critical_rules calibrates "presence is not behavior" without dropping the speed guard', () => {
  assert.match(verifier, /presence is not behavior/i);
  assert.match(verifier, /Keep verification fast/);
});

test('PARITY: per-truth state never leaks into the overall-status vocabulary', () => {
  assert.doesNotMatch(verifier, /→ \*\*status:\s*present_behavior_unverified\*\*/i);
  const unionLines = verifier.match(/^status:\s+[a-z_]+(?:\s*\|\s*[a-z_]+)+\s*$/gm) || [];
  assert.ok(unionLines.length > 0, 'expected at least one status union line');
  for (const line of unionLines) {
    assert.doesNotMatch(line, /present_behavior_unverified/i);
    // The real invariant is that the per-truth state is NOT in the union (above).
    // Membership (order-independent) avoids brittleness on a future legitimate reorder.
    for (const s of ['passed', 'gaps_found', 'human_needed']) {
      assert.ok(line.includes(s), `status union must still contain ${s}: ${line}`);
    }
  }
});

test('overall-status enum in verification.cts is unchanged (no per-truth leak)', () => {
  // Assert on the real exported runtime value rather than regexing the
  // source text — strictly stronger (exercises the built module) and
  // immune to source formatting changes.
  const verificationLib = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'verification.cjs'));
  const { VERIFIER_STATUSES } = verificationLib;
  assert.ok(Array.isArray(VERIFIER_STATUSES), 'VERIFIER_STATUSES array must be present');
  assert.ok(
    !VERIFIER_STATUSES.includes('present_behavior_unverified'),
    'VERIFIER_STATUSES must not leak the per-truth present_behavior_unverified state',
  );
  for (const s of ['passed', 'gaps_found', 'human_needed']) {
    assert.ok(VERIFIER_STATUSES.includes(s), `VERIFIER_STATUSES must contain ${s}`);
  }
});

test('VERIFICATION.md templates carry behavior_unverified + the new truth-state', () => {
  assert.match(verifier, /behavior_unverified/);
  assert.match(standalone, /PRESENT_BEHAVIOR_UNVERIFIED/);
  assert.match(standalone, /behavior_unverified/);
  assert.match(verifier, /behavior_unverified_items/);
  assert.match(standalone, /behavior_unverified_items/);
});

const verifyPhase = fs.readFileSync(path.join(ROOT, 'gsd-core', 'references', 'verifier-phase-gates.md'), 'utf-8');
const planningArtifacts = fs.readFileSync(path.join(ROOT, 'docs', 'reference', 'planning-artifacts.md'), 'utf-8');

test('shipped verifier-phase-gates reference mirrors the behavior-unverified calibration', () => {
  assert.match(verifyPhase, /PRESENT_BEHAVIOR_UNVERIFIED/);
  assert.match(verifyPhase, /behavior_unverified/);
  assert.match(verifyPhase, /state transition/i);
});

test('planning-artifacts reference documents the behavior-unverified calibration', () => {
  assert.match(planningArtifacts, /PRESENT_BEHAVIOR_UNVERIFIED/);
  assert.match(planningArtifacts, /behavior_unverified/);
});

test('Step 9 keeps gaps_found precedence and preserves behavior-unverified items', () => {
  assert.match(verifier, /gaps_found's precedence|gaps_found[\s\S]{0,160}?precedence/i);
  assert.match(verifier, /behavior_unverified_items[\s\S]{0,120}?(never lost|survive|regardless)/i);
});

test('shipped workflow flags behavior-unverified truths even on infrastructure phases', () => {
  assert.match(
    verifyPhase,
    /PRESENT_BEHAVIOR_UNVERIFIED[\s\S]{0,400}?infrastructure|infrastructure[\s\S]{0,400}?PRESENT_BEHAVIOR_UNVERIFIED/i,
  );
});

test('standalone template per-truth guideline respects gaps_found precedence', () => {
  assert.match(standalone, /becomes `human_needed`[\s\S]{0,80}?gaps_found/i);
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3321-verifier-runs-probes.test.cjs — consolidation epic #1969 (B7 #1976)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3321-verifier-runs-probes (consolidation epic #1969 B7 #1976)", () => {
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const VERIFIER_AGENT = path.join(REPO_ROOT, 'agents', 'gsd-verifier.md');

function verifierProbeContract(content) {
  const sectionStart = content.indexOf('## Step 7c: Probe Execution');
  const sectionEnd = content.indexOf('## Step 8:', sectionStart);
  assert.notEqual(sectionStart, -1, 'verifier must define Step 7c');
  assert.notEqual(sectionEnd, -1, 'verifier must close Step 7c before Step 8');

  const section = content.slice(sectionStart, sectionEnd);
  const codeBlocks = [...section.matchAll(/```bash\r?\n([\s\S]*?)\r?\n```/g)].map((match) => match[1].split(/\r?\n/).join('\n'));
  const executionSteps = [...section.matchAll(/^\d+\.\s+(.+)$/gm)].map((match) => match[1]);
  return {
    title: 'Step 7c: Probe Execution',
    conventionalDiscoveryCommand: codeBlocks[0]?.split('\n').find((line) => line.startsWith('find scripts')) || null,
    declaredDiscoveryCommand: codeBlocks[0]?.split('\n').find((line) => line.startsWith('grep -R')) || null,
    executionCommand: codeBlocks[1] || '',
    executionSteps,
    statusRows: [...section.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|[^|]+\|\s*([^|]+)\|$/gm)]
      .map((match) => ({ probe: match[1], command: match[2], statuses: match[3].trim() })),
    summaryClaimsRejected: section.includes('SUMMARY.md probe pass claims are not evidence'),
  };
}

describe('bug #3321: gsd-verifier runs probes instead of trusting SUMMARY claims', () => {
  test('verifier prompt requires direct probe discovery and execution', () => {
    const content = fs.readFileSync(VERIFIER_AGENT, 'utf8');
    const contract = verifierProbeContract(content);

    assert.equal(contract.title, 'Step 7c: Probe Execution');
    assert.equal(contract.conventionalDiscoveryCommand, "find scripts -path '*/tests/probe-*.sh' -type f 2>/dev/null | sort");
    assert.equal(
      contract.declaredDiscoveryCommand,
      "grep -R -n -E 'probe-[^[:space:]]+\\.sh|scripts/.*/tests/probe-.*\\.sh' \"$PHASE_DIR\"/*-PLAN.md \"$PHASE_DIR\"/*-SUMMARY.md 2>/dev/null",
    );
    assert.deepEqual(contract.executionSteps, [
      'Build the `PROBES` list from explicit PLAN declarations first; include conventional `scripts/*/tests/probe-*.sh` when the phase is a migration/tooling phase or the success criteria mention probes.',
      'For every documented probe path, if the file is missing or unreadable, mark `MISSING_PROBE` and set `status: gaps_found`. Do not require the executable bit because probes run through `bash "$probe"`.',
      'Run each probe from the built `PROBES` list from the repository root:',
      'Exit code 0 is PASS. Any non-zero exit is FAILED and must include stdout/stderr evidence in VERIFICATION.md.',
      'Do not substitute executor narration, SUMMARY.md PASS-marker counts, or a different dry-run driver command for the probe result.',
    ]);
    assert.equal(contract.executionCommand, 'for probe in "${PROBES[@]}"; do\n  gsd_run run-with-timeout 30 -- bash "$probe"\ndone');
    assert.deepEqual(contract.statusRows, [{
      probe: 'scripts/.../probe-name.sh',
      command: 'bash "$probe"',
      statuses: 'PASS / FAILED / MISSING_PROBE',
    }]);
    assert.equal(contract.summaryClaimsRejected, true);
  });
});
  });
}

// ─── #3206: explicit-evidence definition inline + cite resolution ────────────
// The agent file IS the deployed product; content assertions test the shipped
// contract (same basis as every test above).

const verifierPhaseGatesPath = path.join(ROOT, 'gsd-core', 'references', 'verifier-phase-gates.md');
const verifierPhaseGates = fs.readFileSync(verifierPhaseGatesPath, 'utf-8');

test('#3206: step 5b defines explicit evidence inline — presence+wiring never qualifies', () => {
  const m = verifier.match(/5b\.\s+\*\*Non-inferable[^\r\n]{0,400}/);
  assert.ok(m, 'step 5b line must exist');
  assert.match(m[0], /held-out\/property-based test/i);
  assert.match(m[0], /directly observed/i);
  assert.match(m[0], /presence\+wirting|presence\+wiring/i);
  assert.match(m[0], /\*never\* qualifies/, 'presence+wiring must be excluded in the 5b line itself');
});

test('#3206: every references-tree cite in gsd-verifier.md resolves on disk as written', () => {
  // Pre-fix, this file cited `references/honest-verifier.md` — a bare path that
  // 404s from repo root after the reference-tree reorg. Every cite must now
  // resolve exactly as written.
  const citeRe = /`((?:gsd-core\/)?references\/[A-Za-z0-9._-]+\.md)`/g;
  const cites = [...verifier.matchAll(citeRe)].map((m) => m[1]);
  assert.ok(cites.includes('gsd-core/references/honest-verifier.md'), 'the 5c honest-verifier cite');
  assert.ok(cites.includes('gsd-core/references/verify-mvp-mode.md'), 'the MVP-mode cite');
  assert.ok(cites.length >= 2, `expected the two repaired cites, found ${cites.length}`);
  for (const cited of cites) {
    assert.ok(
      fs.existsSync(path.join(ROOT, cited)),
      `gsd-verifier.md cites \`${cited}\` but no such file exists — the agent is handed a path that does not resolve (#3206)`,
    );
  }
});

test('#3206: backstop reporting contract is in the eagerly-included verifier-phase-gates.md', () => {
  // The AFK-projection and insufficient_spec-distinctness clauses must be
  // reachable from the agent's guaranteed reading path: verifier-phase-gates.md
  // is @~/-included by gsd-verifier.md, so pinning their presence there pins
  // their reachability.
  assert.match(verifier, /@~\/\.claude\/gsd-core\/references\/verifier-phase-gates\.md/);
  assert.match(verifierPhaseGates, /Never silent, never a hard halt/);
  assert.match(verifierPhaseGates, /complete with N unverified non-inferable checks/);
  assert.match(verifierPhaseGates, /Distinguishable reason/);
  assert.match(verifierPhaseGates, /reason: insufficient_spec/);
});
