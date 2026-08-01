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
      lines.includes('Milestone Close: Open Artifact Audit'),
      `report title must appear as a standalone line; got: ${JSON.stringify(lines.slice(0, 5))}`,
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
 *      Result: stdout contains `"━━━…\n  Milestone Close: …\n…"` (a JSON string
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

const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');

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

    // The first non-empty line must be the divider character row, *not* a
    // JSON-encoded string starting with a quote. If core.output JSON-stringified
    // the formatted report, the entire payload sits on one line wrapped in
    // double quotes ("━━━…\n…").
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
      lines.includes('Milestone Close: Open Artifact Audit'),
      `expected report title as a standalone line; got lines: ${JSON.stringify(lines.slice(0, 5))}`
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
