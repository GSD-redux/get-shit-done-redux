'use strict';
/**
 * audit-command-cutover.test.cjs — ADR-959 phase 4d-impl-3 equivalence tests.
 *
 * Verifies that `audit-uat` and `audit-open`, after cutover from the hardcoded
 * `case 'audit-uat':` and `case 'audit-open':` arms in gsd-tools.cjs to the
 * capability registry dispatch path (default → dispatchCapabilityCommand →
 * audit-command-router.cjs → routeAuditUat | routeAuditOpen), behave
 * identically to the old inline cases.
 *
 * Test categories:
 *   1. UNIT (recording mock) — precise arg/call equivalence for each router
 *   2. DISPATCH — commands reach routers via default-case registry dispatch
 *   3. BEHAVIOR — subprocess tests with real output-shape assertions
 *   4. JSON-ERRORS — structured {ok:false,reason,message} for error paths
 *   5. REGISTRY — commandFamilies entries, audit capability in registry
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

const registry = require('../gsd-core/bin/lib/capability-registry.cjs');
const { routeAuditUat, routeAuditOpen } = require('../gsd-core/bin/lib/audit-command-router.cjs');

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeErrorRecorder() {
  const calls = [];
  const fn = (msg, reason) => calls.push({ msg, reason });
  fn.calls = calls;
  return fn;
}

// ─── 1. UNIT — recording mocks (precise routing equivalence) ─────────────────

describe('audit routers: unit tests via recording mocks', () => {
  const CWD = '/fake/cwd';
  const RAW = false;

  // ── routeAuditUat ──────────────────────────────────────────────────────────

  test('routeAuditUat: calls _uat.cmdAuditUat(cwd, raw) exactly once', () => {
    const uatCalls = [];
    const mockUat = {
      cmdAuditUat: (cwd, raw) => uatCalls.push({ cwd, raw }),
    };
    const errFn = makeErrorRecorder();

    routeAuditUat({
      args: ['audit-uat'],
      cwd: CWD, raw: RAW, error: errFn,
      _uat: mockUat,
    });

    assert.strictEqual(errFn.calls.length, 0, 'error must not be called');
    assert.strictEqual(uatCalls.length, 1, 'cmdAuditUat must be called exactly once');
    assert.strictEqual(uatCalls[0].cwd, CWD, 'cwd passed through correctly');
    assert.strictEqual(uatCalls[0].raw, RAW, 'raw passed through correctly');
  });

  test('routeAuditUat: raw=true is forwarded correctly', () => {
    const uatCalls = [];
    const mockUat = {
      cmdAuditUat: (cwd, raw) => uatCalls.push({ cwd, raw }),
    };
    routeAuditUat({
      args: ['audit-uat'],
      cwd: CWD, raw: true, error: makeErrorRecorder(),
      _uat: mockUat,
    });
    assert.strictEqual(uatCalls[0].raw, true, 'raw=true must be forwarded');
  });

  // ── routeAuditOpen ─────────────────────────────────────────────────────────

  test('routeAuditOpen (no --json): calls auditOpenArtifacts, formatAuditReport; output(null, true, report)', () => {
    const auditCalls = [];
    const coreCalls = [];
    const FAKE_RESULT = { fake: true };
    const FAKE_REPORT = 'REPORT TEXT';
    const mockAudit = {
      auditOpenArtifacts: (cwd) => { auditCalls.push({ fn: 'auditOpenArtifacts', cwd }); return FAKE_RESULT; },
      formatAuditReport: (res) => { auditCalls.push({ fn: 'formatAuditReport', res }); return FAKE_REPORT; },
    };
    // Inject a recording _core stub so no bytes reach the real process stdout.
    const mockCore = {
      output: (...callArgs) => coreCalls.push(callArgs),
    };
    routeAuditOpen({
      args: ['audit-open'],
      cwd: CWD, raw: RAW, error: makeErrorRecorder(),
      _audit: mockAudit,
      _core: mockCore,
    });
    // auditOpenArtifacts called first, then formatAuditReport with its result
    assert.strictEqual(auditCalls.length, 2, 'must call auditOpenArtifacts then formatAuditReport');
    assert.strictEqual(auditCalls[0].fn, 'auditOpenArtifacts', 'first call must be auditOpenArtifacts');
    assert.strictEqual(auditCalls[0].cwd, CWD, 'auditOpenArtifacts cwd must match');
    assert.strictEqual(auditCalls[1].fn, 'formatAuditReport', 'second call must be formatAuditReport');
    assert.strictEqual(auditCalls[1].res, FAKE_RESULT, 'formatAuditReport must receive auditOpenArtifacts result');
    // Assert the exact 3-arg core.output call form for text mode:
    //   core.output(null, true, formatAuditReport(result))
    assert.strictEqual(coreCalls.length, 1, 'core.output must be called exactly once');
    assert.strictEqual(coreCalls[0][0], null, 'text mode: first arg to core.output must be null');
    assert.strictEqual(coreCalls[0][1], true, 'text mode: second arg to core.output must be true');
    assert.strictEqual(coreCalls[0][2], FAKE_REPORT, 'text mode: third arg to core.output must be the formatted report');
  });

  test('routeAuditOpen (--json): calls auditOpenArtifacts but NOT formatAuditReport; output(result, raw)', () => {
    const auditCalls = [];
    const coreCalls = [];
    const FAKE_RESULT = { fake: true };
    const mockAudit = {
      auditOpenArtifacts: (cwd) => { auditCalls.push({ fn: 'auditOpenArtifacts', cwd }); return FAKE_RESULT; },
      formatAuditReport: (res) => { auditCalls.push({ fn: 'formatAuditReport', res }); return 'REPORT'; },
    };
    // Inject a recording _core stub so no bytes reach the real process stdout.
    const mockCore = {
      output: (...callArgs) => coreCalls.push(callArgs),
    };
    routeAuditOpen({
      args: ['audit-open', '--json'],
      cwd: CWD, raw: RAW, error: makeErrorRecorder(),
      _audit: mockAudit,
      _core: mockCore,
    });
    // auditOpenArtifacts called; formatAuditReport must NOT be called for --json
    const fmtCalls = auditCalls.filter(c => c.fn === 'formatAuditReport');
    assert.strictEqual(fmtCalls.length, 0, '--json mode must NOT call formatAuditReport');
    const artifactCalls = auditCalls.filter(c => c.fn === 'auditOpenArtifacts');
    assert.strictEqual(artifactCalls.length, 1, '--json mode must call auditOpenArtifacts once');
    // Assert the exact 2-arg core.output call form for JSON mode:
    //   core.output(result, raw)
    assert.strictEqual(coreCalls.length, 1, 'core.output must be called exactly once');
    assert.strictEqual(coreCalls[0][0], FAKE_RESULT, 'json mode: first arg to core.output must be the result object');
    assert.strictEqual(coreCalls[0][1], RAW, 'json mode: second arg to core.output must be raw');
    assert.strictEqual(coreCalls[0].length, 2, 'json mode: core.output must be called with exactly 2 args');
  });
});

// ─── 2. DISPATCH — commands reach routers via default-case ───────────────────

describe('audit cutover: dispatch path (default-case → capability registry)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-audit-cutover-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('audit-uat dispatches via capability registry (no "Unknown command" error)', () => {
    const result = runGsdTools(['audit-uat'], tmpDir);
    // audit-uat with a minimal project may succeed or fail on file-not-found;
    // the key assertion is it never emits "Unknown command: audit-uat"
    const isUnknownCmd = (result.error || '').includes('Unknown command: audit-uat');
    assert.strictEqual(isUnknownCmd, false,
      `Must not emit "Unknown command: audit-uat". stderr: ${result.error}`);
    assert.ok(result.success,
      `audit-uat must exit 0. stderr: ${result.error}`);
  });

  test('audit-open dispatches via capability registry (no "Unknown command" error)', () => {
    const result = runGsdTools(['audit-open'], tmpDir);
    const isUnknownCmd = (result.error || '').includes('Unknown command: audit-open');
    assert.strictEqual(isUnknownCmd, false,
      `Must not emit "Unknown command: audit-open". stderr: ${result.error}`);
    assert.ok(result.success,
      `audit-open must exit 0. stderr: ${result.error}`);
  });

  test('audit-open --json dispatches via capability registry', () => {
    const result = runGsdTools(['audit-open', '--json'], tmpDir);
    const isUnknownCmd = (result.error || '').includes('Unknown command: audit-open');
    assert.strictEqual(isUnknownCmd, false,
      `Must not emit "Unknown command: audit-open" with --json. stderr: ${result.error}`);
    // Must also produce valid JSON output
    assert.ok(result.success,
      `audit-open --json must succeed. stderr: ${result.error}`);
    assert.doesNotThrow(
      () => JSON.parse(result.output),
      'audit-open --json must produce valid JSON',
    );
  });
});

// ─── 3. BEHAVIOR — subprocess output shape (equivalence to old inline cases) ──

describe('audit cutover: output shape equivalence', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-audit-behavior-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('audit-open (text) succeeds and produces non-empty output', () => {
    const result = runGsdTools(['audit-open'], tmpDir);
    assert.ok(result.success,
      `audit-open must succeed. stderr: ${result.error}`);
    assert.ok(result.output && result.output.length > 0,
      'audit-open text output must be non-empty');
    // Must be raw text, not JSON-encoded (regression guard from #2911)
    assert.ok(!result.output.startsWith('"'),
      'text mode must not start with a JSON quote');
    assert.ok(!result.output.includes('\\n'),
      'text mode must not contain literal \\n sequences');
  });

  test('audit-open --json produces valid JSON with expected shape', () => {
    const result = runGsdTools(['audit-open', '--json'], tmpDir);
    assert.ok(result.success,
      `audit-open --json must succeed. stderr: ${result.error}`);
    let parsed;
    assert.doesNotThrow(
      () => { parsed = JSON.parse(result.output); },
      'audit-open --json must emit valid JSON',
    );
    assert.equal(typeof parsed, 'object', 'parsed payload must be an object');
    assert.ok(parsed !== null, 'parsed payload must not be null');
    // Shape contract from auditOpenArtifacts() (regression guard from #2911)
    assert.equal(typeof parsed.scanned_at, 'string', 'must include scanned_at');
    assert.equal(typeof parsed.has_open_items, 'boolean', 'must include has_open_items');
    assert.equal(typeof parsed.counts, 'object', 'must include counts');
    assert.equal(typeof parsed.items, 'object', 'must include items');
  });

  test('audit-open (text) report title present as standalone line', () => {
    const result = runGsdTools(['audit-open'], tmpDir);
    assert.ok(result.success,
      `audit-open must succeed. stderr: ${result.error}`);
    const lines = result.output.split('\n').map(l => l.trim()).filter(Boolean);
    assert.ok(
      lines.includes('### Milestone Close: Open Artifact Audit'),
      `report title must appear as a standalone Markdown heading line; got: ${JSON.stringify(lines.slice(0, 5))}`,
    );
  });

  test('audit-uat succeeds and produces non-empty stdout', () => {
    const result = runGsdTools(['audit-uat'], tmpDir);
    assert.ok(result.success,
      `audit-uat must succeed. stderr: ${result.error}`);
    assert.ok(result.output && result.output.length > 0,
      'audit-uat must write non-empty output to stdout');
  });

  test('audit-uat --raw flag passes through (does not break dispatch)', () => {
    const result = runGsdTools(['audit-uat', '--raw'], tmpDir);
    // --raw is a gsd-tools global flag; it modifies output encoding but
    // the command must still succeed and produce output
    assert.ok(result.success,
      `audit-uat --raw must succeed. stderr: ${result.error}`);
  });
});

// ─── 4. JSON-ERRORS — GSD_JSON_ERRORS mode passes through cleanly ────────────

describe('audit cutover: GSD_JSON_ERRORS mode (both commands succeed without structured error)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-audit-jsonerr-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('audit-open --json with GSD_JSON_ERRORS=1 succeeds (no spurious error payload)', () => {
    // Successful commands must not emit JSON error payloads; verify exit 0.
    const result = runGsdTools(['audit-open', '--json'], tmpDir, { GSD_JSON_ERRORS: '1' });
    assert.ok(result.success,
      `audit-open --json must succeed even with GSD_JSON_ERRORS=1; stderr: ${result.error}`);
  });

  test('audit-open text with GSD_JSON_ERRORS=1 succeeds (no spurious error payload)', () => {
    const result = runGsdTools(['audit-open'], tmpDir, { GSD_JSON_ERRORS: '1' });
    assert.ok(result.success,
      `audit-open text mode must succeed even with GSD_JSON_ERRORS=1; stderr: ${result.error}`);
  });

  test('audit-uat with GSD_JSON_ERRORS=1 succeeds (no spurious error payload)', () => {
    const result = runGsdTools(['audit-uat'], tmpDir, { GSD_JSON_ERRORS: '1' });
    assert.ok(result.success,
      `audit-uat must succeed even with GSD_JSON_ERRORS=1; stderr: ${result.error}`);
  });
});

// ─── 5. REGISTRY — commandFamilies entries ───────────────────────────────────

describe('audit cutover: registry entries correct', () => {
  test('commandFamilies["audit-uat"] present and well-shaped', () => {
    const entry = registry.commandFamilies['audit-uat'];
    assert.ok(entry, 'commandFamilies["audit-uat"] must be present');
    assert.strictEqual(entry.capId, 'audit',
      'commandFamilies["audit-uat"].capId must be "audit"');
    assert.strictEqual(entry.module, 'audit-command-router.cjs',
      'commandFamilies["audit-uat"].module must be "audit-command-router.cjs"');
    assert.strictEqual(entry.router, 'routeAuditUat',
      'commandFamilies["audit-uat"].router must be "routeAuditUat"');
  });

  test('commandFamilies["audit-open"] present and well-shaped', () => {
    const entry = registry.commandFamilies['audit-open'];
    assert.ok(entry, 'commandFamilies["audit-open"] must be present');
    assert.strictEqual(entry.capId, 'audit',
      'commandFamilies["audit-open"].capId must be "audit"');
    assert.strictEqual(entry.module, 'audit-command-router.cjs',
      'commandFamilies["audit-open"].module must be "audit-command-router.cjs"');
    assert.strictEqual(entry.router, 'routeAuditOpen',
      'commandFamilies["audit-open"].router must be "routeAuditOpen"');
  });

  test('capabilities.audit present with role:feature and tier:full', () => {
    const cap = registry.capabilities.audit;
    assert.ok(cap, 'capabilities.audit must be present');
    assert.strictEqual(cap.role, 'feature', 'audit capability must have role: feature');
    assert.strictEqual(cap.tier, 'full', 'audit capability must have tier: full');
  });

  test('capabilities.audit.commands has both audit-uat and audit-open entries', () => {
    const cap = registry.capabilities.audit;
    assert.ok(Array.isArray(cap.commands) && cap.commands.length === 2,
      'audit capability must have exactly 2 commands');

    const uatCmd = cap.commands.find(c => c.family === 'audit-uat');
    assert.ok(uatCmd, 'commands must include audit-uat family');
    assert.strictEqual(uatCmd.module, 'audit-command-router.cjs');
    assert.strictEqual(uatCmd.router, 'routeAuditUat');

    const openCmd = cap.commands.find(c => c.family === 'audit-open');
    assert.ok(openCmd, 'commands must include audit-open family');
    assert.strictEqual(openCmd.module, 'audit-command-router.cjs');
    assert.strictEqual(openCmd.router, 'routeAuditOpen');
  });

  test('routeAuditUat and routeAuditOpen are exported functions', () => {
    assert.strictEqual(typeof routeAuditUat, 'function',
      'routeAuditUat must be an exported function');
    assert.strictEqual(typeof routeAuditOpen, 'function',
      'routeAuditOpen must be an exported function');
  });

  test('profileMembership.audit is vacuous (no skills → no skill-cluster entry)', () => {
    // audit declares skills:[] → no skill-cluster-based profileMembership entry.
    // This is correct: profileMembership tracks skill ownership, not capability existence.
    const pm = registry.profileMembership.audit;
    assert.strictEqual(pm, undefined,
      'profileMembership.audit must be undefined (no skills declared)');
  });

  test('capabilityClusters.audit is vacuous (no skills → no cluster entry)', () => {
    // Same as profileMembership — skill-less capabilities produce no cluster entries.
    const clusters = registry.capabilityClusters.audit;
    assert.strictEqual(clusters, undefined,
      'capabilityClusters.audit must be undefined (no skills declared)');
  });

  test('audit has no skills — vacuous install/surface (no skill-index entries)', () => {
    // audit capability declares no skills, so bySkill has no "audit" entry
    // (there is no skill named "audit")
    const cap = registry.capabilities.audit;
    assert.deepStrictEqual(cap.skills, [],
      'audit capability must have empty skills array');
  });

  test('graphify commandFamilies entry still present (no regression)', () => {
    const entry = registry.commandFamilies['graphify'];
    assert.ok(entry, 'commandFamilies["graphify"] must still be present');
    assert.strictEqual(entry.capId, 'graphify');
    assert.strictEqual(entry.module, 'graphify-command-router.cjs');
    assert.strictEqual(entry.router, 'routeGraphifyCommand');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2659-audit-open-crash.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2659-audit-open-crash (consolidation epic #1969 B2 #1971)", () => {
'use strict';

/**
 * Regression test for #2659.
 *
 * The `audit-open` dispatch case in bin/gsd-tools.cjs previously called bare
 * `output(...)` on both the --json and text branches. `output` is never in
 * local scope — the entire core module is imported as `const core`, so every
 * other case uses `core.output(...)`. The bare calls therefore crashed with
 * `ReferenceError: output is not defined` the moment `audit-open` ran.
 *
 * This test runs both invocations against a minimal temp project and asserts
 * they exit successfully with non-empty stdout. It fails with the
 * ReferenceError on any revision that still has the bare `output(...)` calls.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

describe('audit-open — does not crash with ReferenceError (#2659)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-bug-2659-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('audit-open (text output) succeeds and produces stdout', () => {
    const result = runGsdTools('audit-open', tmpDir);
    assert.ok(
      result.success,
      `audit-open must not crash. stderr: ${result.error}`
    );
    assert.ok(
      !/ReferenceError.*output is not defined/.test(result.error || ''),
      `audit-open must not throw ReferenceError. stderr: ${result.error}`
    );
    assert.ok(
      result.output && result.output.length > 0,
      'audit-open must write a non-empty report to stdout'
    );
  });

  test('audit-open --json succeeds and produces stdout', () => {
    const result = runGsdTools(['audit-open', '--json'], tmpDir);
    assert.ok(
      result.success,
      `audit-open --json must not crash. stderr: ${result.error}`
    );
    assert.ok(
      !/ReferenceError.*output is not defined/.test(result.error || ''),
      `audit-open --json must not throw ReferenceError. stderr: ${result.error}`
    );
    assert.ok(
      result.output && result.output.length > 0,
      'audit-open --json must write output to stdout'
    );
    let parsed;
    assert.doesNotThrow(
      () => { parsed = JSON.parse(result.output); },
      'audit-open --json must emit valid JSON'
    );
    assert.ok(
      parsed !== null && typeof parsed === 'object',
      'audit-open --json must emit a JSON object or array'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2911-audit-open-output-shape.test.cjs — consolidation epic #1969 (B2 #1971)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2911-audit-open-output-shape (consolidation epic #1969 B2 #1971)", () => {
'use strict';

/**
 * Regression test for #2911.
 *
 * Two bugs in the `audit-open` dispatch case in bin/gsd-tools.cjs:
 *
 *   1. Bare `output(...)` calls (only `core.output` is in scope) → ReferenceError.
 *   2. Even after switching to `core.output(formatted, raw)`, the human-readable
 *      branch JSON-stringifies the formatted string because `core.output` only
 *      bypasses JSON encoding when called as `core.output(null, true, rawValue)`.
 *      Result: stdout contains `"### Milestone Close: …\n…"` (a JSON string
 *      literal) instead of the rendered report.
 *
 * The shape assertions below catch both regressions structurally — never via
 * substring matching on serialized output:
 *
 *   - text mode: parse stdout as a sequence of lines and assert the expected
 *     section headers exist as standalone lines (i.e. raw text, not escaped).
 *     If the report is JSON-stringified, the stdout is a single line wrapped
 *     in double quotes with `\n` escapes — line-array assertions fail.
 *   - --json mode: JSON.parse the stdout and assert the keys returned by
 *     `auditOpenArtifacts(cwd)` (scanned_at, has_open_items, counts, items)
 *     are present and well-typed.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

// ─── #3458 fixtures: phase-scoped scanners must also see archived phases ─────
//
// scanUatGaps, scanVerificationGaps, scanContextQuestions, and scanDeferredItems
// resolve ONLY the active `.planning/phases/` root. Once a milestone closes and
// its phase dirs move to `.planning/milestones/v<X.Y>-phases/`, items still
// unresolved at that moment become invisible to every later audit — these
// fixtures carry one item of each of the four kinds, in both an "unresolved"
// (must be counted) and a "resolved" (must NOT be counted) shape, verified
// against the real scanner formats before being repurposed for the archived
// layout below.

const UAT_GAP_UNRESOLVED = [
  '# UAT',
  '',
  '## Gaps',
  '',
  '- truth: an unresolved UAT gap that survived milestone close',
  '  status: open',
  '',
].join('\n');

const UAT_GAP_RESOLVED = [
  '---',
  'status: resolved',
  '---',
  '',
  '# UAT',
  '',
  '## Gaps',
  '',
  '- truth: a gap that was resolved',
  '',
].join('\n');

const VERIFICATION_GAP_UNRESOLVED = [
  '---',
  'status: gaps_found',
  '---',
  '',
  '# Verification',
  '',
  'Gaps found during verification.',
  '',
].join('\n');

const VERIFICATION_GAP_RESOLVED = [
  '---',
  'status: passed',
  '---',
  '',
  '# Verification',
  '',
  'All checks passed.',
  '',
].join('\n');

const CONTEXT_QUESTION_OPEN = [
  '# Context',
  '',
  '## Open Questions',
  '',
  '- Should this default to strict mode?',
  '',
].join('\n');

const CONTEXT_QUESTION_RESOLVED = [
  '# Context',
  '',
  '## Open Questions',
  '',
  'None',
  '',
].join('\n');

const DEFERRED_ITEM_UNRESOLVED = [
  '# Deferred Items',
  '',
  '- **STILL-OPEN:** an unresolved deferred item that survived milestone close',
  '',
].join('\n');

const DEFERRED_ITEM_RESOLVED = [
  '# Deferred Items',
  '',
  '- **RESOLVED-ITEM:** an item that was resolved',
  '  status: resolved',
  '',
].join('\n');

/**
 * Write one phase's worth of UAT/VERIFICATION/CONTEXT/deferred-items files
 * (one of each of the four scanner-recognized kinds) into `phaseDir`, using
 * `phaseNumberPrefix` (e.g. '01') as the file-token so `scopeToPhase` (#3511)
 * accepts them for a dir named `<phaseNumberPrefix>-<slug>`.
 */
function writePhaseArtifacts(phaseDir, phaseNumberPrefix, { uat, verification, context, deferred }) {
  fs.mkdirSync(phaseDir, { recursive: true });
  fs.writeFileSync(path.join(phaseDir, `${phaseNumberPrefix}-UAT.md`), uat);
  fs.writeFileSync(path.join(phaseDir, `${phaseNumberPrefix}-VERIFICATION.md`), verification);
  fs.writeFileSync(path.join(phaseDir, `${phaseNumberPrefix}-CONTEXT.md`), context);
  fs.writeFileSync(path.join(phaseDir, 'deferred-items.md'), deferred);
}

const UNRESOLVED_ARTIFACTS = {
  uat: UAT_GAP_UNRESOLVED,
  verification: VERIFICATION_GAP_UNRESOLVED,
  context: CONTEXT_QUESTION_OPEN,
  deferred: DEFERRED_ITEM_UNRESOLVED,
};

const RESOLVED_ARTIFACTS = {
  uat: UAT_GAP_RESOLVED,
  verification: VERIFICATION_GAP_RESOLVED,
  context: CONTEXT_QUESTION_RESOLVED,
  deferred: DEFERRED_ITEM_RESOLVED,
};

describe('audit-open — output shape (#2911)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-bug-2911-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('text mode emits the formatted report as raw text (not JSON-encoded)', () => {
    const result = runGsdTools('audit-open', tmpDir);
    assert.ok(
      result.success,
      `audit-open must not crash. stderr: ${result.error}`
    );

    const lines = result.output.split('\n').map(l => l.trim()).filter(Boolean);

    // The first non-empty line must be the rendered Markdown heading row, *not*
    // a JSON-encoded string starting with a quote. If core.output JSON-stringified
    // the formatted report, the entire payload sits on one line wrapped in
    // double quotes ("### Milestone Close: …\n…").
    assert.ok(
      !result.output.startsWith('"'),
      'text-mode stdout must not begin with a JSON quote (would mean the report was JSON.stringified)'
    );
    assert.ok(
      !result.output.includes('\\n'),
      'text-mode stdout must not contain literal "\\n" sequences (would mean the report was JSON.stringified)'
    );

    // Section headers from formatAuditReport that must appear as standalone lines.
    assert.ok(
      lines.includes('### Milestone Close: Open Artifact Audit'),
      `expected report title as a standalone Markdown heading line; got lines: ${JSON.stringify(lines.slice(0, 5))}`
    );
    assert.ok(
      lines.includes('All artifact types clear. Safe to proceed.'),
      `expected the empty-state line as standalone text; got lines: ${JSON.stringify(lines)}`
    );
  });

  test('--json mode emits parseable JSON matching auditOpenArtifacts shape', () => {
    const result = runGsdTools(['audit-open', '--json'], tmpDir);
    assert.ok(
      result.success,
      `audit-open --json must not crash. stderr: ${result.error}`
    );

    let parsed;
    assert.doesNotThrow(
      () => { parsed = JSON.parse(result.output); },
      'audit-open --json must emit valid JSON (not a doubly-stringified string)'
    );

    assert.equal(typeof parsed, 'object', 'parsed payload must be an object');
    assert.ok(parsed !== null, 'parsed payload must not be null');

    // Shape contract from auditOpenArtifacts() in gsd-core/bin/lib/audit.cjs.
    assert.equal(typeof parsed.scanned_at, 'string', 'must include scanned_at ISO timestamp');
    assert.equal(typeof parsed.has_open_items, 'boolean', 'must include has_open_items boolean');
    assert.equal(typeof parsed.counts, 'object', 'must include counts object');
    assert.equal(typeof parsed.items, 'object', 'must include items object');

    const expectedCountKeys = [
      'debug_sessions', 'quick_tasks', 'threads', 'todos',
      'seeds', 'uat_gaps', 'verification_gaps', 'context_questions',
      'deferred_items', 'total',
    ];
    for (const key of expectedCountKeys) {
      assert.equal(
        typeof parsed.counts[key], 'number',
        `counts.${key} must be a number`
      );
    }

    const expectedItemKeys = [
      'debug_sessions', 'quick_tasks', 'threads', 'todos',
      'seeds', 'uat_gaps', 'verification_gaps', 'context_questions',
      'deferred_items',
    ];
    for (const key of expectedItemKeys) {
      assert.ok(
        Array.isArray(parsed.items[key]),
        `items.${key} must be an array`
      );
    }
  });

  // ── #3458: phase-scoped scanners must also see archived phases ────────────
  //
  // scanUatGaps, scanVerificationGaps, scanContextQuestions, and
  // scanDeferredItems resolve ONLY the active `.planning/phases/` root. Once a
  // milestone closes and its phase dirs move to
  // `.planning/milestones/v<X.Y>-phases/`, items still unresolved at that
  // moment become invisible to every later audit.

  test('#3458 archived-only project: unresolved items in .planning/milestones/vX.Y-phases/ are counted', () => {
    // The active phases root is scaffolded empty by createTempProject; the bug
    // report's own repro has it ABSENT entirely in a fully-archived project —
    // remove it so this fixture matches that exactly, not just "empty".
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- removing only the .planning/phases subdir within a still-live fixture (INFO-7 fix for #3458 review: fs.rmdirSync threw on a non-empty dir); helpers.cleanup() tears down the whole tmpDir, not a subdirectory, so it cannot substitute here.
    fs.rmSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true, force: true });

    const archivedPhaseDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '01-alpha');
    writePhaseArtifacts(archivedPhaseDir, '01', UNRESOLVED_ARTIFACTS);

    const result = runGsdTools(['audit-open', '--json'], tmpDir);
    assert.ok(result.success, `audit-open --json must not crash. stderr: ${result.error}`);
    const parsed = JSON.parse(result.output);

    assert.equal(parsed.counts.uat_gaps, 1, `uat_gaps: expected 1, got ${parsed.counts.uat_gaps}`);
    assert.equal(parsed.counts.verification_gaps, 1, `verification_gaps: expected 1, got ${parsed.counts.verification_gaps}`);
    assert.equal(parsed.counts.context_questions, 1, `context_questions: expected 1, got ${parsed.counts.context_questions}`);
    assert.equal(parsed.counts.deferred_items, 1, `deferred_items: expected 1, got ${parsed.counts.deferred_items}`);
    assert.equal(parsed.has_open_items, true, 'has_open_items must be true when an archived phase carries unresolved items');
  });

  test('#3458 mixed project: active AND archived phases are both scanned and summed (not one replacing the other)', () => {
    const activePhaseDir = path.join(tmpDir, '.planning', 'phases', '01-alpha');
    writePhaseArtifacts(activePhaseDir, '01', UNRESOLVED_ARTIFACTS);

    const archivedPhaseDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '02-beta');
    writePhaseArtifacts(archivedPhaseDir, '02', UNRESOLVED_ARTIFACTS);

    const result = runGsdTools(['audit-open', '--json'], tmpDir);
    assert.ok(result.success, `audit-open --json must not crash. stderr: ${result.error}`);
    const parsed = JSON.parse(result.output);

    assert.equal(parsed.counts.uat_gaps, 2, `uat_gaps: expected 2 (1 active + 1 archived), got ${parsed.counts.uat_gaps}`);
    assert.equal(parsed.counts.verification_gaps, 2, `verification_gaps: expected 2, got ${parsed.counts.verification_gaps}`);
    assert.equal(parsed.counts.context_questions, 2, `context_questions: expected 2, got ${parsed.counts.context_questions}`);
    assert.equal(parsed.counts.deferred_items, 2, `deferred_items: expected 2, got ${parsed.counts.deferred_items}`);
    assert.equal(parsed.has_open_items, true, 'has_open_items must be true');
  });

  test('#3458 active-only project: unchanged behavior, unresolved items still counted (guards the pre-existing path)', () => {
    const activePhaseDir = path.join(tmpDir, '.planning', 'phases', '01-alpha');
    writePhaseArtifacts(activePhaseDir, '01', UNRESOLVED_ARTIFACTS);

    const result = runGsdTools(['audit-open', '--json'], tmpDir);
    assert.ok(result.success, `audit-open --json must not crash. stderr: ${result.error}`);
    const parsed = JSON.parse(result.output);

    assert.equal(parsed.counts.uat_gaps, 1, `uat_gaps: expected 1, got ${parsed.counts.uat_gaps}`);
    assert.equal(parsed.counts.verification_gaps, 1, `verification_gaps: expected 1, got ${parsed.counts.verification_gaps}`);
    assert.equal(parsed.counts.context_questions, 1, `context_questions: expected 1, got ${parsed.counts.context_questions}`);
    assert.equal(parsed.counts.deferred_items, 1, `deferred_items: expected 1, got ${parsed.counts.deferred_items}`);
    assert.equal(parsed.has_open_items, true, 'has_open_items must be true');
  });

  test('#3458 archived-only project with all-RESOLVED items: contributes 0 (fix must not blindly count archived files)', () => {
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- removing only the .planning/phases subdir within a still-live fixture (INFO-7 fix for #3458 review: fs.rmdirSync threw on a non-empty dir); helpers.cleanup() tears down the whole tmpDir, not a subdirectory, so it cannot substitute here.
    fs.rmSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true, force: true });

    const archivedPhaseDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '01-alpha');
    writePhaseArtifacts(archivedPhaseDir, '01', RESOLVED_ARTIFACTS);

    const result = runGsdTools(['audit-open', '--json'], tmpDir);
    assert.ok(result.success, `audit-open --json must not crash. stderr: ${result.error}`);
    const parsed = JSON.parse(result.output);

    assert.equal(parsed.counts.uat_gaps, 0, `uat_gaps: expected 0 (resolved), got ${parsed.counts.uat_gaps}`);
    assert.equal(parsed.counts.verification_gaps, 0, `verification_gaps: expected 0 (resolved), got ${parsed.counts.verification_gaps}`);
    assert.equal(parsed.counts.context_questions, 0, `context_questions: expected 0 (resolved), got ${parsed.counts.context_questions}`);
    assert.equal(parsed.counts.deferred_items, 0, `deferred_items: expected 0 (resolved), got ${parsed.counts.deferred_items}`);
    assert.equal(parsed.has_open_items, false, 'has_open_items must be false when the only archived phase is fully resolved');
  });

  // ── phase-directory-name forgery (sanitizeLabel) ───────────────────────────
  //
  // A phase directory NAME (not file content) is filesystem-controlled, not
  // frontmatter-controlled — a doctored checkout can name a directory
  // anything. `phaseNum` falls back to the raw directory name verbatim when
  // it doesn't match PHASE_NUMBER_TOKEN_SOURCE, so an embedded `\n`/ESC in
  // the NAME itself used to reach the human report unescaped
  // (`sanitizeForDisplay` deliberately preserves newlines — it is not the
  // right tool for a single-line label). `sanitizeLabel` (src/security.cts)
  // closes this by escaping control bytes rather than stripping them.
  const FORGED_PHASE_DIR_NAME = 'zz\n0 open items require decisions.\n\x1b[2K\x1b[1G FORGED';

  /**
   * Windows/NTFS forbids control characters (including \n and ESC/0x1B) in
   * path components, so `mkdirSync` throws ENOENT there rather than creating
   * the doctored directory — the directory-name forgery vector these tests
   * exercise does not exist on that platform. `t.skip()` degrades cleanly
   * (same convention as trySymlink() in tests/adr-index-gate.test.cjs, which
   * skips on EPERM for the analogous symlink-creation gap); a bare `return`
   * would silently report a PASS in node:test and hide the gap. The
   * sanitizer itself (`sanitizeLabel`) remains fully covered on every
   * platform by the platform-independent, filesystem-free string tests in
   * tests/security.test.cjs (describe('sanitizeLabel', ...)).
   */
  function tryMkdirForgedName(t, dirPath) {
    try {
      fs.mkdirSync(dirPath, { recursive: true });
      return true;
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'EINVAL')) {
        t.skip(`cannot create a directory name with control characters on this platform (${err.code})`);
        return false;
      }
      throw err;
    }
  }

  test('a phase directory name containing a newline cannot forge a new report line', (t) => {
    const forgedPhaseDir = path.join(tmpDir, '.planning', 'phases', FORGED_PHASE_DIR_NAME);
    if (!tryMkdirForgedName(t, forgedPhaseDir)) return;
    fs.writeFileSync(path.join(forgedPhaseDir, 'deferred-items.md'), DEFERRED_ITEM_UNRESOLVED);

    const result = runGsdTools('audit-open', tmpDir);
    assert.ok(result.success, `audit-open must not crash. stderr: ${result.error}`);

    const lines = result.output.split('\n').map(l => l.trim());
    assert.ok(
      !lines.includes('0 open items require decisions.'),
      `the doctored directory name must not inject its own report line; got lines: ${JSON.stringify(lines)}`
    );
  });

  test('a phase directory name with an ESC/ANSI payload never reaches raw output', (t) => {
    const forgedPhaseDir = path.join(tmpDir, '.planning', 'phases', FORGED_PHASE_DIR_NAME);
    if (!tryMkdirForgedName(t, forgedPhaseDir)) return;
    fs.writeFileSync(path.join(forgedPhaseDir, 'deferred-items.md'), DEFERRED_ITEM_UNRESOLVED);

    const result = runGsdTools('audit-open', tmpDir);
    assert.ok(result.success, `audit-open must not crash. stderr: ${result.error}`);

    assert.ok(
      !result.output.includes('\x1b'),
      'no raw ESC byte from the doctored directory name may reach the report output'
    );
  });

  // ── adversarial-review follow-ups on #3458 ─────────────────────────────────

  test('WARNING-4a: archived_milestone is present (correct value) on archived items and absent (no key at all) on active items', () => {
    const activePhaseDir = path.join(tmpDir, '.planning', 'phases', '01-alpha');
    writePhaseArtifacts(activePhaseDir, '01', UNRESOLVED_ARTIFACTS);

    const archivedPhaseDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '02-beta');
    writePhaseArtifacts(archivedPhaseDir, '02', UNRESOLVED_ARTIFACTS);

    const result = runGsdTools(['audit-open', '--json'], tmpDir);
    assert.ok(result.success, `audit-open --json must not crash. stderr: ${result.error}`);
    const parsed = JSON.parse(result.output);

    for (const category of ['uat_gaps', 'verification_gaps', 'context_questions', 'deferred_items']) {
      const items = parsed.items[category].filter(i => !i.scan_error);
      const active = items.find(i => i.phase === '01');
      const archived = items.find(i => i.phase === '02');
      assert.ok(active, `${category}: expected an active-phase item; got: ${JSON.stringify(items)}`);
      assert.ok(archived, `${category}: expected an archived-phase item; got: ${JSON.stringify(items)}`);
      assert.strictEqual('archived_milestone' in active, false,
        `${category}: active item must not carry the archived_milestone key at all`);
      assert.strictEqual(archived.archived_milestone, 'v1.0',
        `${category}: archived item must carry archived_milestone: 'v1.0'`);
    }
  });

  test('BLOCKER-1 regression: an unreadable active root (a FILE at .planning/phases) still yields a scan_error sentinel in all four phase-scoped categories', () => {
    // eslint-disable-next-line local/no-raw-rmsync-in-tests -- removing only the .planning/phases subdir within a still-live fixture (INFO-7 fix for #3458 review: fs.rmdirSync threw on a non-empty dir); helpers.cleanup() tears down the whole tmpDir, not a subdirectory, so it cannot substitute here.
    fs.rmSync(path.join(tmpDir, '.planning', 'phases'), { recursive: true, force: true });
    fs.writeFileSync(path.join(tmpDir, '.planning', 'phases'), 'not a directory');

    const result = runGsdTools(['audit-open', '--json'], tmpDir);
    assert.ok(result.success, `audit-open --json must not crash. stderr: ${result.error}`);
    const parsed = JSON.parse(result.output);

    for (const category of ['uat_gaps', 'verification_gaps', 'context_questions', 'deferred_items']) {
      const sentinel = parsed.items[category].find(i => i.scan_error === true);
      assert.ok(sentinel,
        `${category}: expected a scan_error sentinel when the active root is unreadable (ENOTDIR); ` +
        `got: ${JSON.stringify(parsed.items[category])}`);
    }
  });

  test('an unreadable archived root does not prevent the active half from being scanned (no sentinel for the archive half — see docstring)', () => {
    const activePhaseDir = path.join(tmpDir, '.planning', 'phases', '01-alpha');
    writePhaseArtifacts(activePhaseDir, '01', UNRESOLVED_ARTIFACTS);

    // Make `.planning/milestones` an unreadable FILE instead of a directory so
    // getArchivedPhaseDirs's readdirSync throws (ENOTDIR).
    fs.writeFileSync(path.join(tmpDir, '.planning', 'milestones'), 'not a directory');

    const result = runGsdTools(['audit-open', '--json'], tmpDir);
    assert.ok(result.success, `audit-open --json must not crash. stderr: ${result.error}`);
    const parsed = JSON.parse(result.output);

    // Active half still scanned — the four counts include the active item.
    assert.equal(parsed.counts.uat_gaps, 1, `uat_gaps: expected 1 (active only), got ${parsed.counts.uat_gaps}`);
    assert.equal(parsed.counts.verification_gaps, 1, `verification_gaps: expected 1, got ${parsed.counts.verification_gaps}`);
    assert.equal(parsed.counts.context_questions, 1, `context_questions: expected 1, got ${parsed.counts.context_questions}`);
    assert.equal(parsed.counts.deferred_items, 1, `deferred_items: expected 1, got ${parsed.counts.deferred_items}`);

    // Pinned decision: an unreadable archive root does NOT get a scan_error
    // sentinel (no pre-#3458 contract to preserve for it — see the
    // listAuditPhaseTargets docstring).
    for (const category of ['uat_gaps', 'verification_gaps', 'context_questions', 'deferred_items']) {
      const hasSentinel = parsed.items[category].some(i => i.scan_error === true);
      assert.strictEqual(hasSentinel, false,
        `${category}: an unreadable archive root must not produce a scan_error sentinel; got: ${JSON.stringify(parsed.items[category])}`);
    }
  });

  test('WARNING-3: duplicate phase name across active and archived roots produces two distinct entries, and the human report distinguishes them', () => {
    const activePhaseDir = path.join(tmpDir, '.planning', 'phases', '01-alpha');
    writePhaseArtifacts(activePhaseDir, '01', UNRESOLVED_ARTIFACTS);

    const archivedPhaseDir = path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '01-alpha');
    writePhaseArtifacts(archivedPhaseDir, '01', UNRESOLVED_ARTIFACTS);

    const jsonResult = runGsdTools(['audit-open', '--json'], tmpDir);
    assert.ok(jsonResult.success, `audit-open --json must not crash. stderr: ${jsonResult.error}`);
    const parsed = JSON.parse(jsonResult.output);

    const uatEntries = parsed.items.uat_gaps.filter(i => !i.scan_error);
    assert.equal(uatEntries.length, 2,
      `same-named active + archived phase must produce two distinct uat_gaps entries; got: ${JSON.stringify(uatEntries)}`);
    const archivedFlags = uatEntries.map(i => Boolean(i.archived_milestone)).sort();
    assert.deepEqual(archivedFlags, [false, true],
      'exactly one of the two duplicate-named entries must carry archived_milestone');

    const textResult = runGsdTools(['audit-open'], tmpDir);
    assert.ok(textResult.success, `audit-open (text) must not crash. stderr: ${textResult.error}`);
    const uatLines = textResult.output.split('\n').filter(l => l.includes('01-UAT.md'));
    assert.equal(uatLines.length, 2,
      `expected two UAT-gap report lines (one active, one archived); got: ${JSON.stringify(uatLines)}`);
    assert.notStrictEqual(uatLines[0], uatLines[1],
      'the active and archived duplicate-named entries must render as distinguishable lines, not byte-identical duplicates');
    assert.ok(uatLines.some(l => l.includes('archived v1.0')),
      `expected one report line to be labeled with its archived milestone; got: ${JSON.stringify(uatLines)}`);
  });

  test('INFO-5: archived milestones v1.0, v1.9, v1.10 sort newest-first, numerically (v1.10 before v1.9, not lexicographically)', () => {
    writePhaseArtifacts(path.join(tmpDir, '.planning', 'milestones', 'v1.0-phases', '01-a'), '01', UNRESOLVED_ARTIFACTS);
    writePhaseArtifacts(path.join(tmpDir, '.planning', 'milestones', 'v1.9-phases', '01-b'), '01', UNRESOLVED_ARTIFACTS);
    writePhaseArtifacts(path.join(tmpDir, '.planning', 'milestones', 'v1.10-phases', '01-c'), '01', UNRESOLVED_ARTIFACTS);

    const result = runGsdTools(['audit-open', '--json'], tmpDir);
    assert.ok(result.success, `audit-open --json must not crash. stderr: ${result.error}`);
    const parsed = JSON.parse(result.output);

    const milestoneOrder = parsed.items.uat_gaps.filter(i => !i.scan_error).map(i => i.archived_milestone);
    assert.deepEqual(milestoneOrder, ['v1.10', 'v1.9', 'v1.0'],
      `expected numeric-aware newest-first ordering (v1.10, v1.9, v1.0); got: ${JSON.stringify(milestoneOrder)}`);
  });

  // ── quick-task directory-name forgery (sanitizeLabel) ──────────────────────
  //
  // scanQuickTasks derives `slug` from the `.planning/quick/<dirName>`
  // directory NAME (filesystem-controlled, same shape as the phase-directory
  // case above), not from file content. Before sanitizeLabel was applied
  // here, an embedded `\n`/ESC byte in the directory name reached the human
  // report unescaped via `sanitizeForDisplay` (which deliberately preserves
  // newlines — it is not the right tool for a single-line label).
  const FORGED_QUICK_TASK_DIR_NAME = 'zz\n0 open items require decisions.\n\x1b[2K\x1b[1G FORGED';

  test('a quick-task directory name containing a newline cannot forge a new report line', (t) => {
    const forgedQuickDir = path.join(tmpDir, '.planning', 'quick', FORGED_QUICK_TASK_DIR_NAME);
    if (!tryMkdirForgedName(t, forgedQuickDir)) return;

    const result = runGsdTools('audit-open', tmpDir);
    assert.ok(result.success, `audit-open must not crash. stderr: ${result.error}`);

    const lines = result.output.split('\n').map(l => l.trim());
    assert.ok(
      !lines.includes('0 open items require decisions.'),
      `the doctored directory name must not inject its own report line; got lines: ${JSON.stringify(lines)}`
    );
  });

  test('a quick-task directory name with an ESC/ANSI payload never reaches raw output', (t) => {
    const forgedQuickDir = path.join(tmpDir, '.planning', 'quick', FORGED_QUICK_TASK_DIR_NAME);
    if (!tryMkdirForgedName(t, forgedQuickDir)) return;

    const result = runGsdTools('audit-open', tmpDir);
    assert.ok(result.success, `audit-open must not crash. stderr: ${result.error}`);

    assert.ok(
      !result.output.includes('\x1b'),
      'no raw ESC byte from the doctored directory name may reach the report output'
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2836-audit-open-summary-uat-drift.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2836-audit-open-summary-uat-drift (consolidation epic #1969 B3 #1972)", () => {
/**
 * Regression tests for bug #2836
 *
 * audit-open had two convention drifts vs the documented workflows:
 *   1. quick-task scanner looked for bare `SUMMARY.md`, but workflows/quick.md
 *      mandates `${quick_id}-SUMMARY.md`. Result: every documented quick task
 *      reported as `status: missing`.
 *   2. UAT terminal-status enum only accepted `complete`, but
 *      workflows/execute-phase.md uses `resolved` post-gap-closure.
 *      Result: gap-closed UATs reported as open.
 *
 * Tests structurally invoke auditOpenArtifacts() against real fixtures on disk
 * and assert the returned items array — never regex on raw file content.
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const auditModule = require('../gsd-core/bin/lib/audit.cjs');
const { auditOpenArtifacts } = auditModule;
const { cleanup } = require('./helpers.cjs');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bug-2836-'));
}

describe('bug #2836: audit-open quick-task summary filename + UAT terminal status', () => {
  // Ensure GSD env vars do not redirect planningDir() away from our fixture.
  let prevProject, prevWorkstream;
  before(() => {
    prevProject = process.env.GSD_PROJECT;
    prevWorkstream = process.env.GSD_WORKSTREAM;
    delete process.env.GSD_PROJECT;
    delete process.env.GSD_WORKSTREAM;
  });
  after(() => {
    if (prevProject !== undefined) process.env.GSD_PROJECT = prevProject;
    if (prevWorkstream !== undefined) process.env.GSD_WORKSTREAM = prevWorkstream;
  });

  test('quick task with ${quick_id}-SUMMARY.md is recognized as complete (not missing)', () => {
    const cwd = mkTmp();
    try {
      const quickId = '260429-test-foo';
      const taskDir = path.join(cwd, '.planning', 'quick', quickId);
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(
        path.join(taskDir, `${quickId}-SUMMARY.md`),
        '---\nstatus: complete\n---\ntest summary\n',
        'utf-8'
      );

      const result = auditOpenArtifacts(cwd);
      const realQuickTasks = result.items.quick_tasks.filter(
        i => !i.scan_error && !i._remainder_count
      );

      assert.equal(
        realQuickTasks.length, 0,
        `quick task with ${quickId}-SUMMARY.md (status: complete) must not appear ` +
        `as an open item; got: ${JSON.stringify(realQuickTasks)}`
      );
      assert.equal(result.counts.quick_tasks, 0);
    } finally {
      cleanup(cwd);
    }
  });

  test('UAT with status: resolved is treated as terminal (not an open gap)', () => {
    const cwd = mkTmp();
    try {
      const phaseDir = path.join(cwd, '.planning', 'phases', '01-test');
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(
        path.join(phaseDir, '01-UAT.md'),
        '---\nstatus: resolved\n---\nUAT body — gap closed via execute-phase flow.\n',
        'utf-8'
      );

      const result = auditOpenArtifacts(cwd);
      const realUatGaps = result.items.uat_gaps.filter(i => !i.scan_error);

      assert.equal(
        realUatGaps.length, 0,
        `UAT with status: resolved must not appear as an open gap; ` +
        `got: ${JSON.stringify(realUatGaps)}`
      );
      assert.equal(result.counts.uat_gaps, 0);
    } finally {
      cleanup(cwd);
    }
  });

  test('UAT with status: complete remains terminal (no regression)', () => {
    const cwd = mkTmp();
    try {
      const phaseDir = path.join(cwd, '.planning', 'phases', '02-test');
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(
        path.join(phaseDir, '02-UAT.md'),
        '---\nstatus: complete\n---\nUAT body.\n',
        'utf-8'
      );

      const result = auditOpenArtifacts(cwd);
      const realUatGaps = result.items.uat_gaps.filter(i => !i.scan_error);
      assert.equal(realUatGaps.length, 0);
    } finally {
      cleanup(cwd);
    }
  });

  test('UAT with status: pending is still flagged as an open gap', () => {
    const cwd = mkTmp();
    try {
      const phaseDir = path.join(cwd, '.planning', 'phases', '03-test');
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(
        path.join(phaseDir, '03-UAT.md'),
        '---\nstatus: pending\n---\nresult: pending\n',
        'utf-8'
      );

      const result = auditOpenArtifacts(cwd);
      const realUatGaps = result.items.uat_gaps.filter(i => !i.scan_error);
      assert.equal(realUatGaps.length, 1, 'pending UAT must still be flagged');
      assert.equal(realUatGaps[0].status, 'pending');
    } finally {
      cleanup(cwd);
    }
  });

  test('#3511: scanUatGaps excludes a cross-phase stray UAT file sitting in the same phase dir; this phase\'s own open gap still reports', () => {
    const cwd = mkTmp();
    try {
      const phaseDir = path.join(cwd, '.planning', 'phases', '03-test');
      fs.mkdirSync(phaseDir, { recursive: true });
      // This phase's own open UAT gap.
      fs.writeFileSync(
        path.join(phaseDir, '03-UAT.md'),
        '---\nstatus: pending\n---\nresult: pending\n',
        'utf-8',
      );
      // Cross-phase stray in the SAME directory — token "04", not "03".
      fs.writeFileSync(
        path.join(phaseDir, '04-UAT.md'),
        '---\nstatus: pending\n---\nresult: pending\n',
        'utf-8',
      );

      const result = auditOpenArtifacts(cwd);
      const realUatGaps = result.items.uat_gaps.filter(i => !i.scan_error);

      assert.equal(realUatGaps.length, 1,
        `only this phase's own gap must report; got: ${JSON.stringify(realUatGaps)}`);
      assert.equal(realUatGaps[0].file, '03-UAT.md');
      assert.equal(realUatGaps[0].phase, '03');
      assert.ok(!realUatGaps.some(i => i.file === '04-UAT.md'),
        'the cross-phase stray must not appear in uat_gaps');
      assert.equal(result.counts.uat_gaps, 1);
    } finally {
      cleanup(cwd);
    }
  });

  test('#3511: scanVerificationGaps excludes a cross-phase stray VERIFICATION file sitting in the same phase dir; this phase\'s own open gap still reports', () => {
    const cwd = mkTmp();
    try {
      const phaseDir = path.join(cwd, '.planning', 'phases', '03-test');
      fs.mkdirSync(phaseDir, { recursive: true });
      // This phase's own open VERIFICATION gap.
      fs.writeFileSync(
        path.join(phaseDir, '03-VERIFICATION.md'),
        '---\nstatus: gaps_found\n---\n# Verification\n',
        'utf-8',
      );
      // Cross-phase stray in the SAME directory — token "04", not "03".
      fs.writeFileSync(
        path.join(phaseDir, '04-VERIFICATION.md'),
        '---\nstatus: human_needed\n---\n# Verification\n',
        'utf-8',
      );

      const result = auditOpenArtifacts(cwd);
      const realVerificationGaps = result.items.verification_gaps.filter(i => !i.scan_error);

      assert.equal(realVerificationGaps.length, 1,
        `only this phase's own gap must report; got: ${JSON.stringify(realVerificationGaps)}`);
      assert.equal(realVerificationGaps[0].file, '03-VERIFICATION.md');
      assert.equal(realVerificationGaps[0].phase, '03');
      assert.ok(!realVerificationGaps.some(i => i.file === '04-VERIFICATION.md'),
        'the cross-phase stray must not appear in verification_gaps');
      assert.equal(result.counts.verification_gaps, 1);
    } finally {
      cleanup(cwd);
    }
  });

  test('#3511 follow-up: own gap still reports from a NON-canonical dir shape (over-exclusion check)', () => {
    const cwd = mkTmp();
    try {
      // "1-unpadded" tokenizes to literal "1", but scaffold writes the PADDED
      // "01-…" form — a literal token compare excluded the phase's own file.
      const phaseDir = path.join(cwd, '.planning', 'phases', '1-unpadded');
      fs.mkdirSync(phaseDir, { recursive: true });
      fs.writeFileSync(
        path.join(phaseDir, '01-UAT.md'),
        '---\nstatus: partial\n---\n\n## Tests\n\n### 1. Test\nexpected: works\nresult: pending\n',
        'utf-8',
      );
      fs.writeFileSync(
        path.join(phaseDir, '01-VERIFICATION.md'),
        '---\nstatus: gaps_found\n---\n# Verification\n',
        'utf-8',
      );

      const result = auditOpenArtifacts(cwd);
      const realUatGaps = result.items.uat_gaps.filter(i => !i.scan_error);
      const realVerificationGaps = result.items.verification_gaps.filter(i => !i.scan_error);

      assert.equal(realUatGaps.length, 1,
        `own UAT gap in an unpadded-dir phase must still report; got: ${JSON.stringify(realUatGaps)}`);
      assert.equal(realVerificationGaps.length, 1,
        `own VERIFICATION gap in an unpadded-dir phase must still report; got: ${JSON.stringify(realVerificationGaps)}`);
    } finally {
      cleanup(cwd);
    }
  });

  test('quick task without any SUMMARY file is still flagged as missing', () => {
    const cwd = mkTmp();
    try {
      const quickId = '260429-test-bar';
      const taskDir = path.join(cwd, '.planning', 'quick', quickId);
      fs.mkdirSync(taskDir, { recursive: true });
      // No SUMMARY file at all.

      const result = auditOpenArtifacts(cwd);
      const realQuickTasks = result.items.quick_tasks.filter(
        i => !i.scan_error && !i._remainder_count
      );
      assert.equal(realQuickTasks.length, 1);
      assert.equal(realQuickTasks[0].status, 'missing');
    } finally {
      cleanup(cwd);
    }
  });
});

describe('bug #2836: workflows/help.md one-liner reconciliation', () => {
  test('help.md quick-task one-liner uses ${quick_id}-SUMMARY.md pattern', () => {
    // After #3039, help content moved into help/modes/full.md.
    const helpPath = path.resolve(
      __dirname, '..', 'gsd-core', 'workflows', 'help', 'modes', 'full.md'
    );
    const content = fs.readFileSync(helpPath, 'utf-8');

    // Locate the documented "Result: Creates ..." quick-task one-liner and
    // assert it references the per-task SUMMARY filename pattern, not bare
    // SUMMARY.md. We parse by line to avoid false positives elsewhere.
    const resultLines = content.split(/\r?\n/).filter(l =>
      l.includes('Result: Creates') && l.includes('.planning/quick/')
    );
    assert.ok(resultLines.length > 0, 'expected a quick-task Result line in help.md');
    for (const line of resultLines) {
      assert.ok(
        /\$\{quick_id\}-SUMMARY\.md|NNN-slug-SUMMARY\.md/.test(line),
        `help.md quick-task Result line must reference per-task SUMMARY filename ` +
        `(e.g. \${quick_id}-SUMMARY.md); got: ${line}`
      );
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-950-quick-summary-status-complete.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-950-quick-summary-status-complete (consolidation epic #1969 B3 #1972)", () => {
// allow-test-rule: source-text-is-the-product (see #950)
/**
 * Regression tests for bug #950
 *
 * audit-open chronically flagged genuinely-complete quick tasks as [unknown]
 * because NO shipped summary template carried a `status:` frontmatter field —
 * so status was only emitted when the writing agent improvised it.
 *
 * The fix: add `status: complete` to all four summary templates and enforce it
 * in the executor agent + quick.md workflow. Tests here exercise the scanner
 * directly via auditOpenArtifacts() and also guard template text as a secondary
 * contract check.
 *
 * Primary guard:   behavioral audit-scanner tests (tasks read by scanQuickTasks)
 * Secondary guard: template-contract text checks (template text IS the runtime contract)
 * Writer-path guard: contract assertions on quick.md + gsd-executor.md (source-text-is-the-product)
 */

'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const auditModule = require('../gsd-core/bin/lib/audit.cjs');
const { auditOpenArtifacts } = auditModule;
const { cleanup } = require('./helpers.cjs');

const TEMPLATES_DIR = path.resolve(__dirname, '..', 'gsd-core', 'templates');
const QUICK_MD = path.resolve(__dirname, '..', 'gsd-core', 'workflows', 'quick.md');
const EXECUTOR_MD = path.resolve(__dirname, '..', 'agents', 'gsd-executor.md');

function mkTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bug-950-'));
}

/**
 * Extract the first YAML frontmatter block from a file's content.
 *
 * Two layouts are handled:
 *  - Leading frontmatter: file starts with `---\n…\n---` (summary-minimal/standard/complex.md)
 *  - Fenced frontmatter: frontmatter lives inside a ```markdown … ``` fence (summary.md,
 *    whose content IS a markdown example showing the template). In that case we extract
 *    the `---\n…\n---` block that sits immediately after the opening fence line.
 *
 * Returns the raw text of the YAML block (between the two `---` delimiters, exclusive),
 * or null if no frontmatter could be found.
 */
function extractFrontmatter(content) {
  // Case 1: file begins with --- (leading frontmatter)
  if (/^---\r?\n/.test(content)) {
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    return match ? match[1] : null;
  }

  // Case 2: frontmatter is embedded inside a fenced block (```markdown\n---\n…\n---\n)
  const fenceMatch = content.match(/```(?:markdown|md)?\r?\n(---\r?\n[\s\S]*?\r?\n---)\r?\n/);
  if (fenceMatch) {
    // Strip the outer --- delimiters to get just the YAML body
    const block = fenceMatch[1];
    const inner = block.match(/^---\r?\n([\s\S]*?)\r?\n---$/);
    return inner ? inner[1] : null;
  }

  return null;
}

describe('bug #950: quick-task SUMMARY must carry status: complete', () => {
  // Ensure GSD env vars do not redirect planningDir() away from our fixture.
  let prevProject, prevWorkstream;
  before(() => {
    prevProject = process.env.GSD_PROJECT;
    prevWorkstream = process.env.GSD_WORKSTREAM;
    delete process.env.GSD_PROJECT;
    delete process.env.GSD_WORKSTREAM;
  });
  after(() => {
    if (prevProject !== undefined) process.env.GSD_PROJECT = prevProject;
    if (prevWorkstream !== undefined) process.env.GSD_WORKSTREAM = prevWorkstream;
  });

  // ── Behavioral: scanner recognizes complete quick tasks ───────────────────

  test('[PRIMARY] quick task SUMMARY with status: complete is NOT flagged open', () => {
    // Simulates an executor that correctly wrote the SUMMARY with status: complete
    // (as required after the fix). The scanner must report 0 open quick tasks.
    const cwd = mkTmp();
    try {
      const quickId = '260609-test-status-complete';
      const taskDir = path.join(cwd, '.planning', 'quick', quickId);
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(
        path.join(taskDir, `${quickId}-SUMMARY.md`),
        [
          '---',
          'status: complete',
          'date: 2026-06-09',
          'slug: test-status-complete',
          '---',
          '',
          '# Quick Task Summary',
          '',
          'Task completed successfully.',
        ].join('\n'),
        'utf-8'
      );

      const result = auditOpenArtifacts(cwd);
      const realQuickTasks = result.items.quick_tasks.filter(
        i => !i.scan_error && !i._remainder_count
      );

      assert.equal(
        realQuickTasks.length,
        0,
        `quick task SUMMARY with status: complete must NOT appear as open; ` +
        `got: ${JSON.stringify(realQuickTasks)}`
      );
      assert.equal(result.counts.quick_tasks, 0);
    } finally {
      cleanup(cwd);
    }
  });

  test('[PRIMARY] quick task SUMMARY without status: field is still flagged [unknown]', () => {
    // Negative case: a SUMMARY that lacks status: still surfaces as [unknown].
    // This proves the scanner still catches real gaps — the fix must be on the writer side.
    const cwd = mkTmp();
    try {
      const quickId = '260609-test-no-status';
      const taskDir = path.join(cwd, '.planning', 'quick', quickId);
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(
        path.join(taskDir, `${quickId}-SUMMARY.md`),
        [
          '---',
          'date: 2026-06-09',
          'slug: test-no-status',
          '---',
          '',
          '# Quick Task Summary',
          '',
          'Task done, but no status field.',
        ].join('\n'),
        'utf-8'
      );

      const result = auditOpenArtifacts(cwd);
      const realQuickTasks = result.items.quick_tasks.filter(
        i => !i.scan_error && !i._remainder_count
      );

      assert.equal(
        realQuickTasks.length,
        1,
        `quick task SUMMARY without status: must appear as open (unknown); ` +
        `got: ${JSON.stringify(realQuickTasks)}`
      );
      assert.equal(realQuickTasks[0].status, 'unknown', 'expected status to be unknown');
    } finally {
      cleanup(cwd);
    }
  });

  test('[PRIMARY] quick task without any SUMMARY is still flagged [missing]', () => {
    // Proves the missing-SUMMARY case still surfaces.
    const cwd = mkTmp();
    try {
      const quickId = '260609-test-missing-summary';
      const taskDir = path.join(cwd, '.planning', 'quick', quickId);
      fs.mkdirSync(taskDir, { recursive: true });
      // No SUMMARY file at all.

      const result = auditOpenArtifacts(cwd);
      const realQuickTasks = result.items.quick_tasks.filter(
        i => !i.scan_error && !i._remainder_count
      );

      assert.equal(realQuickTasks.length, 1, 'missing SUMMARY must still be flagged');
      assert.equal(realQuickTasks[0].status, 'missing');
    } finally {
      cleanup(cwd);
    }
  });

  test('[PRIMARY] SUMMARY with status: COMPLETE (uppercase) is also recognized', () => {
    // Scanner lowercases before comparing — verify case-insensitivity holds.
    const cwd = mkTmp();
    try {
      const quickId = '260609-test-uppercase-complete';
      const taskDir = path.join(cwd, '.planning', 'quick', quickId);
      fs.mkdirSync(taskDir, { recursive: true });
      fs.writeFileSync(
        path.join(taskDir, `${quickId}-SUMMARY.md`),
        '---\nstatus: COMPLETE\n---\n# Summary\nDone.\n',
        'utf-8'
      );

      const result = auditOpenArtifacts(cwd);
      const realQuickTasks = result.items.quick_tasks.filter(
        i => !i.scan_error && !i._remainder_count
      );

      assert.equal(
        realQuickTasks.length,
        0,
        `quick task SUMMARY with status: COMPLETE (uppercase) must not appear as open; ` +
        `got: ${JSON.stringify(realQuickTasks)}`
      );
    } finally {
      cleanup(cwd);
    }
  });

  // ── Secondary: template-contract checks ──────────────────────────────────
  // Assertions are scoped to the actual YAML frontmatter block, not the whole file,
  // so a stray `status: complete` in prose or examples cannot produce a false green.

  test('[TEMPLATE CONTRACT] summary.md contains status: complete in frontmatter', () => {
    // summary.md is a documentation template — its frontmatter lives inside a
    // ```markdown fence. extractFrontmatter() finds and returns that block.
    const content = fs.readFileSync(path.join(TEMPLATES_DIR, 'summary.md'), 'utf-8');
    const fm = extractFrontmatter(content);
    assert.ok(
      fm !== null,
      'gsd-core/templates/summary.md: could not locate a YAML frontmatter block (leading --- or fenced ```markdown --- block)'
    );
    assert.ok(
      /^status:\s*complete\s*$/m.test(fm),
      `gsd-core/templates/summary.md: \`status: complete\` not found in the frontmatter block.\n` +
      `Frontmatter extracted:\n${fm}`
    );
  });

  test('[TEMPLATE CONTRACT] summary-minimal.md contains status: complete in frontmatter', () => {
    const content = fs.readFileSync(path.join(TEMPLATES_DIR, 'summary-minimal.md'), 'utf-8');
    const fm = extractFrontmatter(content);
    assert.ok(
      fm !== null,
      'gsd-core/templates/summary-minimal.md: could not locate a leading YAML frontmatter block'
    );
    assert.ok(
      /^status:\s*complete\s*$/m.test(fm),
      `gsd-core/templates/summary-minimal.md: \`status: complete\` not found in the frontmatter block.\n` +
      `Frontmatter extracted:\n${fm}`
    );
  });

  test('[TEMPLATE CONTRACT] summary-standard.md contains status: complete in frontmatter', () => {
    const content = fs.readFileSync(path.join(TEMPLATES_DIR, 'summary-standard.md'), 'utf-8');
    const fm = extractFrontmatter(content);
    assert.ok(
      fm !== null,
      'gsd-core/templates/summary-standard.md: could not locate a leading YAML frontmatter block'
    );
    assert.ok(
      /^status:\s*complete\s*$/m.test(fm),
      `gsd-core/templates/summary-standard.md: \`status: complete\` not found in the frontmatter block.\n` +
      `Frontmatter extracted:\n${fm}`
    );
  });

  test('[TEMPLATE CONTRACT] summary-complex.md contains status: complete in frontmatter', () => {
    const content = fs.readFileSync(path.join(TEMPLATES_DIR, 'summary-complex.md'), 'utf-8');
    const fm = extractFrontmatter(content);
    assert.ok(
      fm !== null,
      'gsd-core/templates/summary-complex.md: could not locate a leading YAML frontmatter block'
    );
    assert.ok(
      /^status:\s*complete\s*$/m.test(fm),
      `gsd-core/templates/summary-complex.md: \`status: complete\` not found in the frontmatter block.\n` +
      `Frontmatter extracted:\n${fm}`
    );
  });

  // ── Writer-path contract checks ───────────────────────────────────────────
  // Guards quick.md and gsd-executor.md so a future edit removing `status: complete`
  // from the SUMMARY-creation instructions would fail the suite before the bug recurs.
  // (source-text-is-the-product: the deployed .md text IS the runtime contract for agents)

  test('[WRITER-PATH] quick.md constraints require status: complete in SUMMARY frontmatter', () => {
    const content = fs.readFileSync(QUICK_MD, 'utf-8');
    assert.ok(
      /status:\s*complete/.test(content),
      'gsd-core/workflows/quick.md must instruct the executor to write `status: complete` in the SUMMARY frontmatter. ' +
      'The <constraints> block must contain the `status: complete` requirement so a future edit cannot silently drop it.'
    );
  });

  test('[WRITER-PATH] gsd-executor.md frontmatter spec requires status: complete', () => {
    const content = fs.readFileSync(EXECUTOR_MD, 'utf-8');
    assert.ok(
      /status[\s\S]{0,40}complete/.test(content),
      'agents/gsd-executor.md must document `status: complete` as a required SUMMARY frontmatter field. ' +
      'The Frontmatter section must include `status: complete` so the executor always emits it.'
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// #3458 follow-up: `audit_acknowledged` suppression seam + the
// `audit-open acknowledge` CLI writer.
//
// BACKGROUND: #3458 made `audit-open` scan archived milestone phase dirs too,
// so an item still unresolved when a milestone closed now resurfaces at
// EVERY later close, forever — `[A] Acknowledge all` documented that
// decision to STATE.md but never suppressed it. This suite verifies the
// suppression seam: `audit_acknowledged` is VERDICT-PRESERVING (never
// touches the artifact's own `status:` verdict) and SELF-INVALIDATING (a
// stale acknowledgment resurfaces automatically the moment the artifact's
// current state stops matching the marker's recorded snapshot).
// ────────────────────────────────────────────────────────────────────────
{
  const fs = require('node:fs');
  const path = require('node:path');
  const { splitLines } = require('../gsd-core/bin/lib/text-lines.cjs');

  function readJson(result) {
    assert.ok(result.success, `command must succeed. stdout: ${result.output}\nstderr: ${result.error}`);
    return JSON.parse(result.output);
  }

  function ack(tmpDir, args) {
    return runGsdTools(['audit-open', 'acknowledge', ...args, '--json'], tmpDir);
  }

  function audit(tmpDir) {
    return readJson(runGsdTools(['audit-open', '--json'], tmpDir));
  }

  describe('audit-open acknowledge — suppression seam (#3458 follow-up)', () => {
    let tmpDir;

    beforeEach(() => { tmpDir = createTempProject('gsd-3458-ack-'); });
    afterEach(() => { cleanup(tmpDir); });

    function planningPath(...segs) {
      return path.join(tmpDir, '.planning', ...segs);
    }

    // ── per-category suppression + verdict preservation ───────────────────

    test('debug_sessions: acknowledged item drops out of counts/has_open_items; status: field unchanged', () => {
      const debugDir = planningPath('debug');
      fs.mkdirSync(debugDir, { recursive: true });
      const filePath = path.join(debugDir, 'investigate.md');
      fs.writeFileSync(filePath, '---\nstatus: open\n---\n## Current Focus\ndigging\n');

      assert.equal(audit(tmpDir).counts.debug_sessions, 1);

      const result = ack(tmpDir, ['--category', 'debug_sessions', '--slug', 'investigate', '--milestone', 'v1.0', '--at', '2026-08-15']);
      assert.ok(result.success, `acknowledge must succeed. stderr: ${result.error}`);

      const after = audit(tmpDir);
      assert.equal(after.counts.debug_sessions, 0);
      assert.equal(after.acknowledged.debug_sessions, 1);
      assert.equal(after.has_open_items, false);
      assert.match(fs.readFileSync(filePath, 'utf-8'), /^status: open$/m, 'verdict-preserving: status: must be unchanged');
    });

    test('quick_tasks: acknowledged item drops out of counts; status: field unchanged', () => {
      const taskDir = planningPath('quick', '20260810-fixthing');
      fs.mkdirSync(taskDir, { recursive: true });
      const filePath = path.join(taskDir, '20260810-fixthing-SUMMARY.md');
      fs.writeFileSync(filePath, '---\nstatus: needs_review\n---\nbody\n');

      assert.equal(audit(tmpDir).counts.quick_tasks, 1);

      const result = ack(tmpDir, ['--category', 'quick_tasks', '--dir', '20260810-fixthing', '--milestone', 'v1.0', '--at', '2026-08-15']);
      assert.ok(result.success, `acknowledge must succeed. stderr: ${result.error}`);

      const after = audit(tmpDir);
      assert.equal(after.counts.quick_tasks, 0);
      assert.equal(after.acknowledged.quick_tasks, 1);
      assert.match(fs.readFileSync(filePath, 'utf-8'), /^status: needs_review$/m, 'verdict-preserving: status: must be unchanged');
    });

    test('quick_tasks: task with NO SUMMARY.md at all can still be acknowledged (writer creates the marker file)', () => {
      const taskDir = planningPath('quick', '20260811-nosummary');
      fs.mkdirSync(taskDir, { recursive: true });

      assert.equal(audit(tmpDir).counts.quick_tasks, 1);

      const result = ack(tmpDir, ['--category', 'quick_tasks', '--dir', '20260811-nosummary', '--milestone', 'v1.0', '--at', '2026-08-15']);
      assert.ok(result.success, `acknowledge must succeed. stderr: ${result.error}`);

      const after = audit(tmpDir);
      assert.equal(after.counts.quick_tasks, 0);
      assert.equal(after.acknowledged.quick_tasks, 1);
    });

    test('threads: acknowledged item drops out of counts; status: field unchanged', () => {
      const threadsDir = planningPath('threads');
      fs.mkdirSync(threadsDir, { recursive: true });
      const filePath = path.join(threadsDir, 'design-debate.md');
      fs.writeFileSync(filePath, '---\nstatus: open\n---\n# Thread: design debate\n');

      assert.equal(audit(tmpDir).counts.threads, 1);

      const result = ack(tmpDir, ['--category', 'threads', '--slug', 'design-debate', '--milestone', 'v1.0', '--at', '2026-08-15']);
      assert.ok(result.success, `acknowledge must succeed. stderr: ${result.error}`);

      const after = audit(tmpDir);
      assert.equal(after.counts.threads, 0);
      assert.equal(after.acknowledged.threads, 1);
      assert.match(fs.readFileSync(filePath, 'utf-8'), /^status: open$/m, 'verdict-preserving: status: must be unchanged');
    });

    test('seeds: acknowledged item drops out of counts; status: field unchanged', () => {
      const seedsDir = planningPath('seeds');
      fs.mkdirSync(seedsDir, { recursive: true });
      const filePath = path.join(seedsDir, 'SEED-idea.md');
      fs.writeFileSync(filePath, '---\nstatus: dormant\n---\n# An idea\n');

      assert.equal(audit(tmpDir).counts.seeds, 1);

      const result = ack(tmpDir, ['--category', 'seeds', '--seed-id', 'SEED-idea', '--milestone', 'v1.0', '--at', '2026-08-15']);
      assert.ok(result.success, `acknowledge must succeed. stderr: ${result.error}`);

      const after = audit(tmpDir);
      assert.equal(after.counts.seeds, 0);
      assert.equal(after.acknowledged.seeds, 1);
      assert.match(fs.readFileSync(filePath, 'utf-8'), /^status: dormant$/m, 'verdict-preserving: status: must be unchanged');
    });

    test('todos: acknowledged item drops out of counts (presence-only — no snapshot field)', () => {
      const pendingDir = planningPath('todos', 'pending');
      fs.mkdirSync(pendingDir, { recursive: true });
      const filePath = path.join(pendingDir, 'fix-thing.md');
      fs.writeFileSync(filePath, '---\npriority: low\narea: docs\n---\nFix the thing\n');

      assert.equal(audit(tmpDir).counts.todos, 1);

      const result = ack(tmpDir, ['--category', 'todos', '--filename', 'fix-thing.md', '--milestone', 'v1.0', '--at', '2026-08-15']);
      assert.ok(result.success, `acknowledge must succeed. stderr: ${result.error}`);

      const after = audit(tmpDir);
      assert.equal(after.counts.todos, 0);
      assert.equal(after.acknowledged.todos, 1);
    });

    test('uat_gaps: acknowledged item drops out of counts; status: field unchanged (CLI writer round-trip)', () => {
      const phaseDir = planningPath('phases', '01-alpha');
      fs.mkdirSync(phaseDir, { recursive: true });
      const filePath = path.join(phaseDir, '01-UAT.md');
      fs.writeFileSync(filePath, '---\nstatus: gaps_found\n---\n# UAT\n\n## Gaps\n\n- truth: "something broke"\n  status: open\n');

      assert.equal(audit(tmpDir).counts.uat_gaps, 1);

      const result = ack(tmpDir, ['--category', 'uat_gaps', '--phase', '01', '--file', '01-UAT.md', '--milestone', 'v1.0', '--at', '2026-08-15']);
      assert.ok(result.success, `acknowledge must succeed. stderr: ${result.error}`);

      const after = audit(tmpDir);
      assert.equal(after.counts.uat_gaps, 0);
      assert.equal(after.acknowledged.uat_gaps, 1);
      assert.equal(after.has_open_items, false);
      assert.match(
        fs.readFileSync(filePath, 'utf-8'), /^status: gaps_found$/m,
        'CLI writer round-trip: the artifact\'s own status: must be UNCHANGED after acknowledge (verdict-preserving)',
      );
    });

    test('verification_gaps: acknowledged item drops out of counts; status: field unchanged', () => {
      const phaseDir = planningPath('phases', '01-alpha');
      fs.mkdirSync(phaseDir, { recursive: true });
      const filePath = path.join(phaseDir, '01-VERIFICATION.md');
      fs.writeFileSync(filePath, '---\nstatus: gaps_found\n---\n# Verification\n\nGaps found.\n');

      assert.equal(audit(tmpDir).counts.verification_gaps, 1);

      const result = ack(tmpDir, ['--category', 'verification_gaps', '--phase', '01', '--file', '01-VERIFICATION.md', '--milestone', 'v1.0', '--at', '2026-08-15']);
      assert.ok(result.success, `acknowledge must succeed. stderr: ${result.error}`);

      const after = audit(tmpDir);
      assert.equal(after.counts.verification_gaps, 0);
      assert.equal(after.acknowledged.verification_gaps, 1);
      assert.match(fs.readFileSync(filePath, 'utf-8'), /^status: gaps_found$/m, 'verdict-preserving: status: must be unchanged');
    });

    test('context_questions: acknowledged item drops out of counts; question_count snapshot recorded', () => {
      const phaseDir = planningPath('phases', '01-alpha');
      fs.mkdirSync(phaseDir, { recursive: true });
      const filePath = path.join(phaseDir, '01-CONTEXT.md');
      fs.writeFileSync(filePath, '# Context\n\n## Open Questions\n\n- Which backend?\n- What about auth?\n');

      assert.equal(audit(tmpDir).counts.context_questions, 1);

      const result = ack(tmpDir, ['--category', 'context_questions', '--phase', '01', '--file', '01-CONTEXT.md', '--milestone', 'v1.0', '--at', '2026-08-15']);
      assert.ok(result.success, `acknowledge must succeed. stderr: ${result.error}`);

      const after = audit(tmpDir);
      assert.equal(after.counts.context_questions, 0);
      assert.equal(after.acknowledged.context_questions, 1);
      // WARNING 2 (#3458 follow-up review): the marker snapshots a content
      // digest of the FULL question set, not a bare count — a count-only
      // snapshot cannot see a same-count REPLACEMENT of every question (see
      // the WARNING-2 disproof tests below).
      assert.match(fs.readFileSync(filePath, 'utf-8'), /questions_digest: [0-9a-f]{64}/, 'marker records the questions_digest snapshot');
    });

    test('deferred_items: acknowledged entry drops out of counts; entry text otherwise unchanged', () => {
      const phaseDir = planningPath('phases', '01-alpha');
      fs.mkdirSync(phaseDir, { recursive: true });
      const filePath = path.join(phaseDir, 'deferred-items.md');
      fs.writeFileSync(filePath, '## Deferred Items\n\n- an out of scope thing\n  severity: low\n');

      assert.equal(audit(tmpDir).counts.deferred_items, 1);

      const result = ack(tmpDir, ['--category', 'deferred_items', '--phase', '01', '--file', 'deferred-items.md', '--text', 'an out of scope thing severity: low', '--milestone', 'v1.0', '--at', '2026-08-15']);
      assert.ok(result.success, `acknowledge must succeed. stderr: ${result.error}`);

      const after = audit(tmpDir);
      assert.equal(after.counts.deferred_items, 0);
      assert.equal(after.acknowledged.deferred_items, 1);
      const content = fs.readFileSync(filePath, 'utf-8');
      assert.match(content, /an out of scope thing/, 'entry text is preserved');
      assert.match(content, /status: acknowledged/, 'entry now carries status: acknowledged');
      assert.match(content, /severity: low/, 'sibling field is preserved');
    });

    // ── SELF-INVALIDATION: edit the artifact after acknowledging → resurfaces ──

    test('SELF-INVALIDATION debug_sessions: status changes after acknowledge → item resurfaces', () => {
      const debugDir = planningPath('debug');
      fs.mkdirSync(debugDir, { recursive: true });
      const filePath = path.join(debugDir, 'investigate.md');
      fs.writeFileSync(filePath, '---\nstatus: open\n---\n## Current Focus\ndigging\n');

      assert.ok(ack(tmpDir, ['--category', 'debug_sessions', '--slug', 'investigate', '--milestone', 'v1.0', '--at', '2026-08-15']).success);
      assert.equal(audit(tmpDir).counts.debug_sessions, 0, 'BEFORE edit: suppressed');

      const content = fs.readFileSync(filePath, 'utf-8').replace('status: open', 'status: in_progress');
      fs.writeFileSync(filePath, content);

      assert.equal(audit(tmpDir).counts.debug_sessions, 1, 'AFTER edit: resurfaces — stale acknowledgment no longer applies');
    });

    test('SELF-INVALIDATION quick_tasks: status changes after acknowledge → item resurfaces', () => {
      const taskDir = planningPath('quick', '20260810-fixthing');
      fs.mkdirSync(taskDir, { recursive: true });
      const filePath = path.join(taskDir, '20260810-fixthing-SUMMARY.md');
      fs.writeFileSync(filePath, '---\nstatus: needs_review\n---\nbody\n');

      assert.ok(ack(tmpDir, ['--category', 'quick_tasks', '--dir', '20260810-fixthing', '--milestone', 'v1.0', '--at', '2026-08-15']).success);
      assert.equal(audit(tmpDir).counts.quick_tasks, 0, 'BEFORE edit: suppressed');

      const content = fs.readFileSync(filePath, 'utf-8').replace('status: needs_review', 'status: in_progress');
      fs.writeFileSync(filePath, content);

      assert.equal(audit(tmpDir).counts.quick_tasks, 1, 'AFTER edit: resurfaces');
    });

    test('SELF-INVALIDATION threads: status changes after acknowledge → item resurfaces', () => {
      const threadsDir = planningPath('threads');
      fs.mkdirSync(threadsDir, { recursive: true });
      const filePath = path.join(threadsDir, 'design-debate.md');
      fs.writeFileSync(filePath, '---\nstatus: open\n---\n# Thread: design debate\n');

      assert.ok(ack(tmpDir, ['--category', 'threads', '--slug', 'design-debate', '--milestone', 'v1.0', '--at', '2026-08-15']).success);
      assert.equal(audit(tmpDir).counts.threads, 0, 'BEFORE edit: suppressed');

      const content = fs.readFileSync(filePath, 'utf-8').replace('status: open', 'status: in_progress');
      fs.writeFileSync(filePath, content);

      assert.equal(audit(tmpDir).counts.threads, 1, 'AFTER edit: resurfaces (still open, but a DIFFERENT open status than the snapshot)');
    });

    test('SELF-INVALIDATION seeds: status changes after acknowledge → item resurfaces', () => {
      const seedsDir = planningPath('seeds');
      fs.mkdirSync(seedsDir, { recursive: true });
      const filePath = path.join(seedsDir, 'SEED-idea.md');
      fs.writeFileSync(filePath, '---\nstatus: dormant\n---\n# An idea\n');

      assert.ok(ack(tmpDir, ['--category', 'seeds', '--seed-id', 'SEED-idea', '--milestone', 'v1.0', '--at', '2026-08-15']).success);
      assert.equal(audit(tmpDir).counts.seeds, 0, 'BEFORE edit: suppressed');

      const content = fs.readFileSync(filePath, 'utf-8').replace('status: dormant', 'status: active');
      fs.writeFileSync(filePath, content);

      assert.equal(audit(tmpDir).counts.seeds, 1, 'AFTER edit: resurfaces');
    });

    test('SELF-INVALIDATION uat_gaps: status changes after acknowledge → item resurfaces', () => {
      const phaseDir = planningPath('phases', '01-alpha');
      fs.mkdirSync(phaseDir, { recursive: true });
      const filePath = path.join(phaseDir, '01-UAT.md');
      fs.writeFileSync(filePath, '---\nstatus: gaps_found\n---\n# UAT\n\n## Gaps\n\n- truth: "something broke"\n  status: open\n');

      assert.ok(ack(tmpDir, ['--category', 'uat_gaps', '--phase', '01', '--file', '01-UAT.md', '--milestone', 'v1.0', '--at', '2026-08-15']).success);
      assert.equal(audit(tmpDir).counts.uat_gaps, 0, 'BEFORE edit: suppressed');

      const content = fs.readFileSync(filePath, 'utf-8').replace('status: gaps_found', 'status: human_needed');
      fs.writeFileSync(filePath, content);

      assert.equal(audit(tmpDir).counts.uat_gaps, 1, 'AFTER edit: resurfaces');
    });

    test('SELF-INVALIDATION verification_gaps: status changes after acknowledge → item resurfaces', () => {
      const phaseDir = planningPath('phases', '01-alpha');
      fs.mkdirSync(phaseDir, { recursive: true });
      const filePath = path.join(phaseDir, '01-VERIFICATION.md');
      fs.writeFileSync(filePath, '---\nstatus: gaps_found\n---\n# Verification\n\nGaps found.\n');

      assert.ok(ack(tmpDir, ['--category', 'verification_gaps', '--phase', '01', '--file', '01-VERIFICATION.md', '--milestone', 'v1.0', '--at', '2026-08-15']).success);
      assert.equal(audit(tmpDir).counts.verification_gaps, 0, 'BEFORE edit: suppressed');

      const content = fs.readFileSync(filePath, 'utf-8').replace('status: gaps_found', 'status: human_needed');
      fs.writeFileSync(filePath, content);

      assert.equal(audit(tmpDir).counts.verification_gaps, 1, 'AFTER edit: resurfaces');
    });

    test('SELF-INVALIDATION context_questions: question_count changes after acknowledge → item resurfaces', () => {
      const phaseDir = planningPath('phases', '01-alpha');
      fs.mkdirSync(phaseDir, { recursive: true });
      const filePath = path.join(phaseDir, '01-CONTEXT.md');
      fs.writeFileSync(filePath, '# Context\n\n## Open Questions\n\n- Which backend?\n- What about auth?\n');

      assert.ok(ack(tmpDir, ['--category', 'context_questions', '--phase', '01', '--file', '01-CONTEXT.md', '--milestone', 'v1.0', '--at', '2026-08-15']).success);
      assert.equal(audit(tmpDir).counts.context_questions, 0, 'BEFORE edit: suppressed');

      const content = fs.readFileSync(filePath, 'utf-8') + '- What about the third thing?\n';
      fs.writeFileSync(filePath, content);

      assert.equal(audit(tmpDir).counts.context_questions, 1, 'AFTER a new open question is added: resurfaces');
    });

    test('SELF-INVALIDATION deferred_items: reopening the entry (status changed away from acknowledged) → item resurfaces', () => {
      const phaseDir = planningPath('phases', '01-alpha');
      fs.mkdirSync(phaseDir, { recursive: true });
      const filePath = path.join(phaseDir, 'deferred-items.md');
      fs.writeFileSync(filePath, '## Deferred Items\n\n- an out of scope thing\n  severity: low\n');

      assert.ok(ack(tmpDir, ['--category', 'deferred_items', '--phase', '01', '--file', 'deferred-items.md', '--text', 'an out of scope thing severity: low', '--milestone', 'v1.0', '--at', '2026-08-15']).success);
      assert.equal(audit(tmpDir).counts.deferred_items, 0, 'BEFORE reopen: suppressed');

      const content = fs.readFileSync(filePath, 'utf-8').replace('status: acknowledged', 'status: reopened');
      fs.writeFileSync(filePath, content);

      assert.equal(audit(tmpDir).counts.deferred_items, 1, 'AFTER reopen: resurfaces');
    });

    // ── malformed marker never suppresses ──────────────────────────────────

    test('malformed audit_acknowledged (not a map) does NOT suppress — item still surfaces', () => {
      const debugDir = planningPath('debug');
      fs.mkdirSync(debugDir, { recursive: true });
      const filePath = path.join(debugDir, 'investigate.md');
      // Hand-authored, deliberately malformed: audit_acknowledged is a bare
      // scalar, not a map — must be treated as ABSENT, never suppress.
      fs.writeFileSync(filePath, '---\nstatus: open\naudit_acknowledged: not-a-map\n---\nstill open\n');

      const parsed = audit(tmpDir);
      assert.equal(parsed.counts.debug_sessions, 1, 'a malformed marker must never suppress');
      assert.equal(parsed.acknowledged.debug_sessions, 0);
    });

    test('malformed audit_acknowledged (missing milestone/at) does NOT suppress — item still surfaces', () => {
      const phaseDir = planningPath('phases', '01-alpha');
      fs.mkdirSync(phaseDir, { recursive: true });
      const filePath = path.join(phaseDir, '01-UAT.md');
      fs.writeFileSync(
        filePath,
        '---\nstatus: gaps_found\naudit_acknowledged:\n  status: gaps_found\n---\n# UAT\n\n## Gaps\n\n- truth: "x"\n  status: open\n',
      );

      const parsed = audit(tmpDir);
      assert.equal(parsed.counts.uat_gaps, 1, 'a marker missing milestone/at must never suppress');
    });

    // ── deferred_items status matrix ───────────────────────────────────────

    test('deferred_items status matrix: acknowledged suppresses, resolved still suppresses, no status still surfaces', () => {
      const phaseDir = planningPath('phases', '01-alpha');
      fs.mkdirSync(phaseDir, { recursive: true });
      const filePath = path.join(phaseDir, 'deferred-items.md');
      fs.writeFileSync(
        filePath,
        [
          '## Deferred Items',
          '',
          '- an acknowledged item',
          '  status: acknowledged',
          '- a resolved item',
          '  status: resolved',
          '- a plain open item with no status field',
          '',
        ].join('\n'),
      );

      const parsed = audit(tmpDir);
      assert.equal(parsed.counts.deferred_items, 1, 'only the no-status entry is open');
      assert.equal(parsed.acknowledged.deferred_items, 1, 'the acknowledged entry is tallied, not silenced');
      assert.deepEqual(
        parsed.items.deferred_items.map((i) => i.text),
        ['a plain open item with no status field'],
      );
    });

    // ── BLOCKER 1 (#3458 follow-up review): deferred_items writer must be
    // section-anchored, never write into the wrong span, and refuse rather
    // than guess on every shape it cannot safely handle ────────────────────

    test('BLOCKER 1: an identical bullet OUTSIDE `## Deferred Items` is never targeted — mixed-section fixture', () => {
      const phaseDir = planningPath('phases', '01-alpha');
      fs.mkdirSync(phaseDir, { recursive: true });
      const filePath = path.join(phaseDir, 'deferred-items.md');
      // The SAME bullet text appears once under an unrelated `# Notes`
      // section and once under `## Deferred Items`. Before the fix, the
      // unanchored regex matched the FIRST occurrence anywhere in the file —
      // i.e. the one under `# Notes` — not the one `matches`/`ambiguous`
      // were computed over.
      fs.writeFileSync(
        filePath,
        [
          '# Notes',
          '',
          '- Fix the parser',
          '',
          '## Deferred Items',
          '',
          '- Fix the parser',
          '',
        ].join('\n'),
      );

      const result = ack(tmpDir, ['--category', 'deferred_items', '--phase', '01', '--file', 'deferred-items.md', '--text', 'Fix the parser', '--milestone', 'v1.0', '--at', '2026-08-15']);
      assert.ok(result.success, `acknowledge must succeed. stderr: ${result.error}`);

      const content = fs.readFileSync(filePath, 'utf-8');
      const notesSection = content.slice(content.indexOf('# Notes'), content.indexOf('## Deferred Items'));
      const deferredSection = content.slice(content.indexOf('## Deferred Items'));
      assert.doesNotMatch(notesSection, /status: acknowledged/, 'the UNRELATED # Notes bullet must never be touched');
      assert.match(deferredSection, /status: acknowledged/, 'the actual Deferred Items entry must carry the marker');

      const after = audit(tmpDir);
      assert.equal(after.counts.deferred_items, 0, 're-audit: the correct entry is suppressed');
      assert.equal(after.acknowledged.deferred_items, 1);
    });

    test('BLOCKER 1: --text matching 2+ deferred entries is refused as ambiguous, nothing written', () => {
      const phaseDir = planningPath('phases', '01-alpha');
      fs.mkdirSync(phaseDir, { recursive: true });
      const filePath = path.join(phaseDir, 'deferred-items.md');
      const before = ['## Deferred Items', '', '- duplicated text', '- duplicated text', ''].join('\n');
      fs.writeFileSync(filePath, before);

      const result = ack(tmpDir, ['--category', 'deferred_items', '--phase', '01', '--file', 'deferred-items.md', '--text', 'duplicated text', '--milestone', 'v1.0']);
      assert.equal(result.success, false, 'ambiguous --text must be refused');
      assert.match(result.error, /matches more than one/i);
      assert.equal(fs.readFileSync(filePath, 'utf-8'), before, 'file must be byte-identical — nothing written on refusal');
    });

    test('BLOCKER 1: --text matching no deferred entry is refused as not_found', () => {
      const phaseDir = planningPath('phases', '01-alpha');
      fs.mkdirSync(phaseDir, { recursive: true });
      const filePath = path.join(phaseDir, 'deferred-items.md');
      fs.writeFileSync(filePath, '## Deferred Items\n\n- a real entry\n');

      const result = ack(tmpDir, ['--category', 'deferred_items', '--phase', '01', '--file', 'deferred-items.md', '--text', 'no such entry', '--milestone', 'v1.0']);
      assert.equal(result.success, false, 'unmatched --text must be refused');
      assert.match(result.error, /no deferred item matched/i);
    });

    test('BLOCKER 1: heading-delimited (#3457) deferred-items shape is refused as unsupported_heading_shape, not guessed at', () => {
      const phaseDir = planningPath('phases', '01-alpha');
      fs.mkdirSync(phaseDir, { recursive: true });
      const filePath = path.join(phaseDir, 'deferred-items.md');
      const before = ['## Deferred Items', '', '### Something out of scope', '', 'Some detail line.', ''].join('\n');
      fs.writeFileSync(filePath, before);

      const result = ack(tmpDir, ['--category', 'deferred_items', '--phase', '01', '--file', 'deferred-items.md', '--text', 'Something out of scope', '--milestone', 'v1.0']);
      assert.equal(result.success, false, 'heading-delimited shape must be refused');
      assert.match(result.error, /heading-delimited/i);
      assert.equal(fs.readFileSync(filePath, 'utf-8'), before, 'file must be byte-identical — nothing written on refusal');
    });

    // ── F1 (#3458 follow-up review, HIGH): the writer must splice by the
    // SELECTED entry's own carried span, never re-find it by searching —
    // otherwise a byte-identical substring living inside an EARLIER entry
    // (a continuation/quoted line) can steal the write ─────────────────────

    test('F1: a target entry text appearing as a continuation line INSIDE an earlier entry is never targeted — the earlier (CRITICAL) entry is untouched', () => {
      const phaseDir = planningPath('phases', '03-x');
      fs.mkdirSync(phaseDir, { recursive: true });
      const filePath = path.join(phaseDir, 'deferred-items.md');
      const before = [
        '## Deferred Items',
        '',
        '- CRITICAL unfixed auth bypass',
        '  see also: - minor typo',
        '- minor typo',
        '',
      ].join('\n');
      fs.writeFileSync(filePath, before);

      const result = ack(tmpDir, ['--category', 'deferred_items', '--phase', '03', '--file', 'deferred-items.md', '--text', 'minor typo', '--milestone', 'v1.0', '--at', '2026-08-15']);
      assert.ok(result.success, `acknowledge must succeed. stderr: ${result.error}`);

      const content = fs.readFileSync(filePath, 'utf-8');
      // Derive the CRITICAL entry's block by LINES, not by `content.indexOf('- minor typo')`
      // on the raw string — that substring also occurs INSIDE the CRITICAL entry's own
      // continuation line ("  see also: - minor typo"), so an indexOf-based slice truncates
      // before the continuation line is fully captured. Walk lines from the CRITICAL bullet
      // up to (not including) the next TOP-LEVEL bullet (a line starting with "- ", no
      // leading indentation) to get the entry's own span, continuation lines included.
      const lines = splitLines(content);
      const criticalIdx = lines.findIndex((l) => l.startsWith('- CRITICAL'));
      let criticalEndIdx = lines.length;
      for (let i = criticalIdx + 1; i < lines.length; i++) {
        if (lines[i].startsWith('- ')) { criticalEndIdx = i; break; }
      }
      const criticalBlock = lines.slice(criticalIdx, criticalEndIdx).join('\n');
      assert.doesNotMatch(criticalBlock, /status: acknowledged/, 'the CRITICAL entry (and its continuation line) must NEVER be touched');
      assert.match(criticalBlock, /see also: - minor typo/, 'the CRITICAL entry continuation line is preserved verbatim');
      // Measured: the write seam's `_normalizeMd` (src/shell-command-projection.cts:837)
      // inserts a blank line before a list item whose predecessor is a non-blank, non-list
      // line — so a blank line appears between the CRITICAL continuation line and the
      // "- minor typo" bullet after this write. That is repo-wide `.md`-write normalization
      // (50 callers through the single write seam), not something specific to this feature.
      assert.match(content, /- minor typo\n {2}status: acknowledged/, 'the standalone "minor typo" entry (its OWN span) now carries the marker');

      const after = audit(tmpDir);
      assert.equal(after.counts.deferred_items, 1, 're-audit: the CRITICAL entry is still open');
      assert.equal(after.acknowledged.deferred_items, 1, 're-audit: only the typo entry is acknowledged');
      assert.deepEqual(
        after.items.deferred_items.filter((i) => !i.scan_error).map((i) => i.text),
        ['CRITICAL unfixed auth bypass see also: - minor typo'],
        'the still-open item must be the CRITICAL one, not suppressed',
      );
    });

    test('F1 (weaker/prose variant): the target text also appears as a decoy substring INLINE inside an earlier entry\'s prose — the decoy prose must never be corrupted, and the one real matching entry is acknowledged (pre-fix: the decoy prose line was split mid-sentence, the real entry was never touched, and the CLI still exited 0)', () => {
      const phaseDir = planningPath('phases', '03-x');
      fs.mkdirSync(phaseDir, { recursive: true });
      const filePath = path.join(phaseDir, 'deferred-items.md');
      const before = [
        '## Deferred Items',
        '',
        '- Note: reference - minor typo elsewhere, ignore',
        '- minor typo',
        '',
      ].join('\n');
      fs.writeFileSync(filePath, before);

      const result = ack(tmpDir, ['--category', 'deferred_items', '--phase', '03', '--file', 'deferred-items.md', '--text', 'minor typo', '--milestone', 'v1.0', '--at', '2026-08-15']);
      assert.ok(result.success, `acknowledge must succeed — the real "minor typo" entry unambiguously matches. stderr: ${result.error}`);

      const content = fs.readFileSync(filePath, 'utf-8');
      assert.match(
        content,
        /- Note: reference - minor typo elsewhere, ignore\n/,
        'the decoy prose line must be preserved VERBATIM, never split mid-sentence by an inserted status: field',
      );
      assert.match(content, /- minor typo\n {2}status: acknowledged/, 'the real, standalone "minor typo" entry (its OWN carried span) is the one acknowledged');

      const after = audit(tmpDir);
      // The decoy `- Note: reference - minor typo elsewhere, ignore` line is ITSELF a
      // separate, un-acknowledged deferred entry — it was never targeted or written to,
      // so it remains open. Only the real "minor typo" entry was suppressed.
      assert.equal(after.counts.deferred_items, 1, 're-audit: the decoy Note entry remains open — it was never acknowledged');
      assert.equal(after.acknowledged.deferred_items, 1, 're-audit: only the real "minor typo" entry is acknowledged');
      assert.deepEqual(
        after.items.deferred_items.filter((i) => !i.scan_error).map((i) => i.text),
        ['Note: reference - minor typo elsewhere, ignore'],
        'the one remaining open item is the decoy Note entry — proving the REAL entry (not the decoy) was the one suppressed',
      );
    });

    test('F1: --text matching only a SUBSTRING of a prose entry (no entry\'s OWN text equals it) is refused as not_found, not silently corrupted', () => {
      const phaseDir = planningPath('phases', '03-x');
      fs.mkdirSync(phaseDir, { recursive: true });
      const filePath = path.join(phaseDir, 'deferred-items.md');
      const before = [
        '## Deferred Items',
        '',
        '- Some unrelated note mentioning minor typo inline as commentary',
        '',
      ].join('\n');
      fs.writeFileSync(filePath, before);

      const result = ack(tmpDir, ['--category', 'deferred_items', '--phase', '03', '--file', 'deferred-items.md', '--text', 'minor typo', '--milestone', 'v1.0', '--at', '2026-08-15']);
      assert.equal(result.success, false, 'a --text that only matches a SUBSTRING of an entry (not the whole entry) must be refused, never silently split/corrupted');
      assert.match(result.error, /no deferred item matched/i);
      assert.equal(fs.readFileSync(filePath, 'utf-8'), before, 'file must be byte-identical — nothing written on refusal');

      const after = audit(tmpDir);
      assert.equal(after.counts.deferred_items, 1, 'the prose entry remains open and intact — not silently acknowledged/corrupted');
    });

    // ── WARNING 1 (#3458 follow-up review): every `.md` write normalizes to
    // LF — a CRLF deferred-items.md is normalized, not byte-preserved,
    // matching every other `.md` writer in this codebase ─────────────────

    test('WARNING 1: acknowledging an entry in a CRLF deferred-items.md normalizes the whole file to LF (no dead CRLF preservation)', () => {
      const phaseDir = planningPath('phases', '01-alpha');
      fs.mkdirSync(phaseDir, { recursive: true });
      const filePath = path.join(phaseDir, 'deferred-items.md');
      fs.writeFileSync(filePath, '## Deferred Items\r\n\r\n- a crlf entry\r\n  severity: low\r\n');

      const result = ack(tmpDir, ['--category', 'deferred_items', '--phase', '01', '--file', 'deferred-items.md', '--text', 'a crlf entry severity: low', '--milestone', 'v1.0', '--at', '2026-08-15']);
      assert.ok(result.success, `acknowledge must succeed. stderr: ${result.error}`);

      const content = fs.readFileSync(filePath, 'utf-8');
      assert.ok(!content.includes('\r'), 'the whole file normalizes to LF on any .md write — no stray \\r bytes');
      assert.match(content, /status: acknowledged/, 'the entry still carries the marker after normalization');
      assert.match(content, /a crlf entry/, 'entry text is preserved');

      const after = audit(tmpDir);
      assert.equal(after.counts.deferred_items, 0);
      assert.equal(after.acknowledged.deferred_items, 1);
    });

    // ── BLOCKER 2 (#3458 follow-up review): todos beyond the display cap
    // must not be permanently hidden by acknowledging the displayed 5 ─────

    test('BLOCKER 2: acknowledging the 5 displayed todos surfaces the remaining 2, not zero — filter-before-cap', () => {
      const pendingDir = planningPath('todos', 'pending');
      fs.mkdirSync(pendingDir, { recursive: true });
      for (let i = 1; i <= 7; i++) {
        fs.writeFileSync(path.join(pendingDir, `t${i}.md`), `---\npriority: low\narea: misc\n---\ntodo ${i}\n`);
      }

      const before = audit(tmpDir);
      assert.equal(before.counts.todos, 5, 'display cap: 5 of 7 shown in one scan');
      assert.equal(before.has_open_items, true);

      const shown = before.items.todos.filter((i) => !i.scan_error && !i._remainder_count).map((i) => i.filename);
      assert.equal(shown.length, 5);

      for (const filename of shown) {
        const result = ack(tmpDir, ['--category', 'todos', '--filename', filename, '--milestone', 'v1.0', '--at', '2026-08-15']);
        assert.ok(result.success, `acknowledge must succeed for ${filename}. stderr: ${result.error}`);
      }

      const after = audit(tmpDir);
      // Pre-fix this was 0 (the 2 unshown files were permanently invisible —
      // `mdFiles.length` drove both the cap and the remainder count, so once
      // the raw 7 dropped to the still-raw-7-minus-nothing count computation
      // never noticed 2 files had never been shown at all).
      assert.equal(after.counts.todos, 2, 'the 2 never-displayed todos must still surface');
      assert.equal(after.has_open_items, true, 'must not report clean while 2 todos remain unacknowledged');
      assert.equal(after.acknowledged.todos, 5);
    });

    // ── WARNING 2 (#3458 follow-up review): the snapshot must identify
    // CONTENT, not just its size — a same-count/same-status change must
    // still resurface ───────────────────────────────────────────────────

    test('WARNING-2 disproof: replacing every acknowledged open_question with a NEW one (same count) resurfaces the item', () => {
      const phaseDir = planningPath('phases', '01-alpha');
      fs.mkdirSync(phaseDir, { recursive: true });
      const filePath = path.join(phaseDir, '01-CONTEXT.md');
      fs.writeFileSync(filePath, '---\nopen_questions:\n  - "Which backend?"\n  - "What about auth?"\n---\n# Context\n');

      assert.ok(ack(tmpDir, ['--category', 'context_questions', '--phase', '01', '--file', '01-CONTEXT.md', '--milestone', 'v1.0', '--at', '2026-08-15']).success);
      assert.equal(audit(tmpDir).counts.context_questions, 0, 'BEFORE replacement: suppressed');

      // Same COUNT (2), completely different TEXT.
      fs.writeFileSync(filePath, '---\nopen_questions:\n  - "BRAND NEW BLOCKER: is data loss possible?"\n  - "ANOTHER NEW BLOCKER: auth bypass?"\n---\n# Context\n');

      const after = audit(tmpDir);
      assert.equal(after.counts.context_questions, 1, 'AFTER replacement: must RESURFACE — a count-only snapshot cannot see this');
      assert.deepEqual(
        after.items.context_questions.filter((i) => !i.scan_error).map((i) => i.questions),
        [['BRAND NEW BLOCKER: is data loss possible?', 'ANOTHER NEW BLOCKER: auth bypass?']],
      );
    });

    // ── F2 (#3458 follow-up review): the digest must see the WHOLE question
    // set, not the first-3-display-truncated slice `deriveOpenQuestions` used
    // to hash — a 4th+ question was invisible to the snapshot ─────────────

    test('F2: a 4th open question added after acknowledging a 3-question body-section set RESURFACES the item (digest was blind past position 3)', () => {
      const phaseDir = planningPath('phases', '02-beta');
      fs.mkdirSync(phaseDir, { recursive: true });
      const filePath = path.join(phaseDir, '02-CONTEXT.md');
      fs.writeFileSync(
        filePath,
        '# Context\n\n## Open Questions\n\n- Q1?\n- Q2?\n- Q3?\n- Q4?\n',
      );

      const before = audit(tmpDir);
      const beforeItem = before.items.context_questions.find((i) => !i.scan_error && i.file === '02-CONTEXT.md');
      assert.equal(beforeItem.question_count, 4, 'question_count must reflect all 4 questions, not the display cap');

      const result = ack(tmpDir, ['--category', 'context_questions', '--phase', '02', '--file', '02-CONTEXT.md', '--milestone', 'v1.0', '--at', '2026-08-15']);
      assert.ok(result.success, `acknowledge must succeed. stderr: ${result.error}`);
      assert.equal(audit(tmpDir).items.context_questions.filter((i) => !i.scan_error && i.file === '02-CONTEXT.md').length, 0, 'BEFORE mutation: suppressed');

      // Q1–Q3 UNCHANGED (still the first 3 lines — a pre-fix digest hashing
      // only `slice(0, 3)` would see NO difference at all); Q4 replaced with
      // two brand-new unanswered blockers.
      fs.writeFileSync(
        filePath,
        '# Context\n\n## Open Questions\n\n- Q1?\n- Q2?\n- Q3?\n- Brand new unanswered blocker A?\n- Brand new unanswered blocker B?\n',
      );

      const after = audit(tmpDir);
      const afterItem = after.items.context_questions.find((i) => !i.scan_error && i.file === '02-CONTEXT.md');
      assert.ok(afterItem, 'AFTER replacing Q4 with new blockers: the item must RESURFACE — a slice(0,3) digest cannot see past position 3');
      assert.equal(afterItem.question_count, 5);
    });

    // ── SWEEP finding (#3458 follow-up review): the digest's element-join
    // must be unambiguous — two DIFFERENT question sets must never encode to
    // the same joined string and collide on the same digest ───────────────

    test('SWEEP: two different open-question sets that collide under a naive separator-join must record DIFFERENT digests', () => {
      const phase1Dir = planningPath('phases', '03-one');
      const phase2Dir = planningPath('phases', '04-two');
      fs.mkdirSync(phase1Dir, { recursive: true });
      fs.mkdirSync(phase2Dir, { recursive: true });
      const file1 = path.join(phase1Dir, '03-CONTEXT.md');
      const file2 = path.join(phase2Dir, '04-CONTEXT.md');

      // Both sets embed a literal NUL codepoint (via the YAML `\x00`
      // double-quoted hex escape) at the exact position needed to make the
      // TWO DIFFERENT arrays below encode to the byte-identical string under
      // ANY single-character-separator join (a plain space join, OR the
      // separator this seam actually shipped with) — the general proof that
      // NO fixed separator closes this class, only a length-prefixed,
      // self-delimiting encoding does.
      //   Set 1: ["foo\0bar", "baz"]  →  "foo\0bar" + SEP + "baz"
      //   Set 2: ["foo", "bar\0baz"]  →  "foo" + SEP + "bar\0baz"
      // For SEP = "\0" both concatenate to the identical "foo\0bar\0baz".
      fs.writeFileSync(file1, '---\nopen_questions:\n  - "foo\\x00bar"\n  - "baz"\n---\n# Context\n');
      fs.writeFileSync(file2, '---\nopen_questions:\n  - "foo"\n  - "bar\\x00baz"\n---\n# Context\n');

      const r1 = ack(tmpDir, ['--category', 'context_questions', '--phase', '03', '--file', '03-CONTEXT.md', '--milestone', 'v1.0', '--at', '2026-08-15']);
      const r2 = ack(tmpDir, ['--category', 'context_questions', '--phase', '04', '--file', '04-CONTEXT.md', '--milestone', 'v1.0', '--at', '2026-08-15']);
      assert.ok(r1.success, `stderr: ${r1.error}`);
      assert.ok(r2.success, `stderr: ${r2.error}`);

      const digest1 = fs.readFileSync(file1, 'utf-8').match(/questions_digest:\s*([0-9a-f]{64})/)[1];
      const digest2 = fs.readFileSync(file2, 'utf-8').match(/questions_digest:\s*([0-9a-f]{64})/)[1];
      assert.notEqual(digest1, digest2, 'two DIFFERENT question sets must never record the same digest, even when they collide under a naive separator-join');
    });

    test('WARNING-2 disproof: adding more pending scenarios to an acknowledged UAT gap (status unchanged) resurfaces the item', () => {
      const phaseDir = planningPath('phases', '01-alpha');
      fs.mkdirSync(phaseDir, { recursive: true });
      const filePath = path.join(phaseDir, '01-UAT.md');
      fs.writeFileSync(filePath, '---\nstatus: gaps_found\n---\n# UAT\n\n## Scenarios\n\n1. result: pending\n');

      assert.ok(ack(tmpDir, ['--category', 'uat_gaps', '--phase', '01', '--file', '01-UAT.md', '--milestone', 'v1.0', '--at', '2026-08-15']).success);
      let after = audit(tmpDir);
      assert.equal(after.counts.uat_gaps, 0, 'BEFORE: 1 pending scenario, suppressed');

      // status: stays `gaps_found` — only the scenario count moves, 1 → 6.
      fs.writeFileSync(
        filePath,
        '---\nstatus: gaps_found\n---\n# UAT\n\n## Scenarios\n\n1. result: pending\n2. result: pending\n3. result: pending\n4. result: pending\n5. result: pending\n6. result: pending\n',
      );

      after = audit(tmpDir);
      assert.equal(after.counts.uat_gaps, 1, 'AFTER: same status, MORE pending scenarios — must RESURFACE');
      const item = after.items.uat_gaps.find((i) => !i.scan_error);
      assert.equal(item.open_scenario_count, 6);
    });

    // ── WARNING 3 (#3458 follow-up review): the human report must carry the
    // same "clean vs silenced" signal --json already did ──────────────────

    test('WARNING 3: human-readable report shows the acknowledged tally, per-category and in the all-clear footer', () => {
      const phaseDir = planningPath('phases', '01-alpha');
      fs.mkdirSync(phaseDir, { recursive: true });
      const filePath = path.join(phaseDir, '01-UAT.md');
      fs.writeFileSync(filePath, '---\nstatus: gaps_found\n---\n# UAT\n\n## Gaps\n\n- truth: "x"\n  status: open\n');
      assert.ok(ack(tmpDir, ['--category', 'uat_gaps', '--phase', '01', '--file', '01-UAT.md', '--milestone', 'v1.0', '--at', '2026-08-15']).success);

      // All-clear case: the only item left is a previously-acknowledged one.
      const clearReport = runGsdTools(['audit-open'], tmpDir);
      assert.ok(clearReport.success, `stderr: ${clearReport.error}`);
      assert.match(clearReport.output, /1 previously acknowledged item/i, 'all-clear footer must disclose the suppressed item');

      // Now add a genuinely NEW open item so has_open_items is true, and
      // confirm the per-category line also discloses the acknowledged one
      // still sitting alongside it.
      const debugDir = planningPath('debug');
      fs.mkdirSync(debugDir, { recursive: true });
      fs.writeFileSync(path.join(debugDir, 'investigate.md'), '---\nstatus: open\n---\n## Current Focus\ndigging\n');

      const openReport = runGsdTools(['audit-open'], tmpDir);
      assert.ok(openReport.success, `stderr: ${openReport.error}`);
      assert.match(openReport.output, /previously acknowledged item/i, 'footer must still disclose the acknowledged item while other items are open');
    });

    // ── writer refuses a path outside the project ──────────────────────────

    test('writer refuses to acknowledge a path that escapes the project (path traversal)', () => {
      const result = ack(tmpDir, ['--category', 'debug_sessions', '--slug', '../../../../etc/passwd', '--milestone', 'v1.0']);
      assert.equal(result.success, false, 'a traversal-shaped --slug must be refused, not written');
    });

    test('writer refuses to acknowledge a category with a required flag missing', () => {
      const result = ack(tmpDir, ['--category', 'uat_gaps', '--milestone', 'v1.0']); // no --phase/--file
      assert.equal(result.success, false, 'missing --phase/--file must be refused');
    });
  });
}
