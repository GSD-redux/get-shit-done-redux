'use strict';

/**
 * Tests for the STATE.md write-path anti-divergence drift guard
 * (epic #3408, issue #3468, ADR-3408 Decision 5) —
 * `scripts/lint-state-write-path-drift.cjs`.
 *
 * Design contract: docs/adr/3408-state-write-path-preservation.md (§8.1/§8.2/§8.3)
 * Test matrix:      .gsd/phase/refactor-3468-table-driven-preservation/50-test-matrix.md
 *                    (section D, rows D1-D13 — this file covers section D only)
 *
 * Every row except D1 and D13 drives the guard's exported PURE functions
 * (`findSeamBypasses`, `findPromptSeamUses`, `applyRatchet`, `loadBaseline`)
 * directly with in-memory fixtures — no temp tree is needed, mirroring
 * tests/state-field-drift.test.cjs's own house pattern for this class of
 * guard. `REPO_ROOT` inside the guard module is a constant resolved from
 * `__dirname` at require time, so it cannot be pointed at a synthetic tree
 * without changing the guard's own interface — D1 (the real-tree contract)
 * is therefore driven through the CLI's `--json` output instead, and D13
 * (an unreadable file) through an `fs.readFileSync` monkeypatch rather than
 * a real synthetic tree.
 *
 * Fixtures use array `.join('\n')`, never an indented template literal —
 * indentation bleed would shift every asserted line number. Per D2/D5/D7's
 * matrix note ("guard fixtures come from outside the guard's own writer"),
 * the write-seam call lines reused below are copied VERBATIM from real,
 * pre-existing production call sites (the guard's own current baseline
 * entries) rather than invented by this test file:
 *   - `writeStateMd(statePath, modified, cwd);`        src/state.cts:3682
 *   - `writeStateMd(statePath, result.content, cwd);`  src/milestone.cts:865
 *   - `writeStateMd(statePath, stateContent, cwd);`     src/health-diagnostic.cts:337
 *
 * Assertions compare the frozen `REASON` enum values and the `--json`/pure
 * function return shapes only — never a substring/regex match on the human
 * formatter's prose (CONTRIBUTING.md, "Prohibited: Raw Text Matching on Test
 * Outputs").
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { runNode } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const guard = require('../scripts/lint-state-write-path-drift.cjs');
const {
  REASON,
  findSeamBypasses,
  findPromptSeamUses,
  findPolicyDispatchDrift,
  applyRatchet,
  loadBaseline,
  buildBaselineEntries,
  SEAM_OWNER_FILE,
  SEAM_OWNER_EXEMPT_FUNCTIONS,
  EXECUTOR_FILE,
  REPO_ROOT,
  BASELINE_PATH,
} = guard;

const GUARD_PATH = path.join(REPO_ROOT, 'scripts', 'lint-state-write-path-drift.cjs');

// A synthetic, non-owner, non-executor consumer file — never a real repo
// path — used as the `rel` argument wherever a row does not specifically
// need EXECUTOR_FILE or SEAM_OWNER_FILE behavior.
const OTHER_FILE = 'src/example-consumer.cts';
const OTHER_FILE_2 = 'src/example-consumer-2.cts';
const OTHER_FILE_3 = 'src/example-consumer-3.cts';

// ─── D1: the real tree, through the CLI's --json contract ─────────────────

describe('D1 — the real tree', () => {
  test('guard: clean tree passes', () => {
    // Expected RED until the sibling refactor of src/state-transition.cts
    // (issue #3468 Phase 1, concurrent with this test file's own authorship)
    // lands: at write time the executor still dispatches five fields by
    // literal name and leaves `derive`/`clear` unimplemented, which this
    // guard's policy-dispatch axis correctly reports as 7 findings. Mirrors
    // tests/milestone-window-drift-guard.test.cjs's own precedent of an
    // explicitly-documented real-tree row that is red until its companion
    // consolidation lands.
    const result = runNode([GUARD_PATH, '--json'], { cwd: REPO_ROOT, timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(result.outcome, 'exited');
    const body = JSON.parse(result.stdout);
    assert.strictEqual(body.ok, true);
    assert.deepStrictEqual(body.findings, []);
    assert.strictEqual(result.exitCode, 0);
  });
});

// ─── D2: the guard MUST be able to fail ────────────────────────────────────

describe('D2 — an unrecorded bypass fails', () => {
  test('guard: an unrecorded bypass fails', () => {
    const text = [
      'function cmdSomethingElse(cwd) {',
      '  const modified = deriveModifiedContent();',
      '  writeStateMd(statePath, modified, cwd);',
      '}',
    ].join('\n');

    const observed = findSeamBypasses(OTHER_FILE, text);
    assert.strictEqual(observed.length, 1);
    assert.strictEqual(observed[0].line, 3);

    const findings = applyRatchet(observed, { entries: [] });
    // A guard that cannot fail is worse than no guard: an unacknowledged
    // bypass against an empty baseline MUST produce exactly one finding,
    // reasoned, at the exact file and line — not merely "an array".
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].reason, REASON.SEAM_BYPASS_UNRECORDED);
    assert.strictEqual(findings[0].file, OTHER_FILE);
    assert.strictEqual(findings[0].line, 3);
    assert.strictEqual(findings[0].source, 'writeStateMd(statePath, modified, cwd);');
  });
});

// ─── D3: a recorded bypass is acknowledged ─────────────────────────────────

describe('D3 — a recorded bypass is acknowledged', () => {
  test('guard: a recorded bypass is acknowledged', () => {
    const text = [
      'function cmdSomethingElse(cwd) {',
      '  const modified = deriveModifiedContent();',
      '  writeStateMd(statePath, modified, cwd);',
      '}',
    ].join('\n');

    const observed = findSeamBypasses(OTHER_FILE, text);
    const baseline = {
      entries: [{ file: OTHER_FILE, source: 'writeStateMd(statePath, modified, cwd);', symbol: 'writeStateMd', count: 1, owner: null }],
    };
    assert.deepStrictEqual(applyRatchet(observed, baseline), []);
  });
});

// ─── D4: a stale acknowledgment fails ──────────────────────────────────────

describe('D4 — a stale acknowledgment fails', () => {
  test('guard: a stale acknowledgment fails', () => {
    // The call site the baseline acknowledges no longer fires at all this
    // scan — the acknowledgment has outlived what it describes.
    const baseline = {
      entries: [{ file: OTHER_FILE, source: 'writeStateMd(statePath, modified, cwd);', symbol: 'writeStateMd', count: 1, owner: null }],
    };
    const findings = applyRatchet([], baseline);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].reason, REASON.BASELINE_ENTRY_STALE);
    assert.strictEqual(findings[0].file, OTHER_FILE);
    assert.strictEqual(findings[0].observed, 0);
    assert.strictEqual(findings[0].acknowledged, 1);
  });
});

// ─── D5/D6/D7: the occurrence-count boundary triple (limit-1/limit/limit+1) ─
// The baseline acknowledges 2 occurrences throughout ("the limit"); only the
// OBSERVED count in the fixture source varies. This is why the ratchet keys
// entries on (file, trimmed source) instead of line number: two
// byte-identical call sites in one file are otherwise indistinguishable.

describe('D5 — occurrence count catches partial migration (limit-1)', () => {
  test('guard: occurrence count catches partial migration', () => {
    const text = [
      'function cmdSomethingElse(cwd) {',
      '  writeStateMd(statePath, result.content, cwd);',
      '}',
    ].join('\n');

    const observed = findSeamBypasses(OTHER_FILE_2, text);
    assert.strictEqual(observed.length, 1);

    const baseline = {
      entries: [{ file: OTHER_FILE_2, source: 'writeStateMd(statePath, result.content, cwd);', symbol: 'writeStateMd', count: 2, owner: null }],
    };
    const findings = applyRatchet(observed, baseline);
    // Only 1 of the 2 acknowledged call sites still fires — a genuine
    // partial migration, not a clean removal — must fail, not silently pass.
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].reason, REASON.SEAM_BYPASS_COUNT_SHRANK);
    assert.strictEqual(findings[0].observed, 1);
    assert.strictEqual(findings[0].acknowledged, 2);
  });
});

describe('D6 — matching occurrence count passes (limit)', () => {
  test('guard: matching occurrence count passes', () => {
    const text = [
      'function cmdSomethingElse(cwd) {',
      '  writeStateMd(statePath, result.content, cwd);',
      '  writeStateMd(statePath, result.content, cwd);',
      '}',
    ].join('\n');

    const observed = findSeamBypasses(OTHER_FILE_2, text);
    assert.strictEqual(observed.length, 2);

    const baseline = {
      entries: [{ file: OTHER_FILE_2, source: 'writeStateMd(statePath, result.content, cwd);', symbol: 'writeStateMd', count: 2, owner: null }],
    };
    assert.deepStrictEqual(applyRatchet(observed, baseline), []);
  });
});

describe('D7 — a new copy beside an acknowledged one fails (limit+1)', () => {
  test('guard: a new copy beside an acknowledged one fails', () => {
    const text = [
      'function cmdA(cwd) {',
      '  writeStateMd(statePath, stateContent, cwd);',
      '}',
      'function cmdB(cwd) {',
      '  writeStateMd(statePath, stateContent, cwd);',
      '}',
      'function cmdC(cwd) {',
      '  writeStateMd(statePath, stateContent, cwd);',
      '}',
    ].join('\n');

    const observed = findSeamBypasses(OTHER_FILE_3, text);
    assert.strictEqual(observed.length, 3);

    const baseline = {
      entries: [{ file: OTHER_FILE_3, source: 'writeStateMd(statePath, stateContent, cwd);', symbol: 'writeStateMd', count: 2, owner: null }],
    };
    const findings = applyRatchet(observed, baseline);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].reason, REASON.SEAM_BYPASS_COUNT_GREW);
    assert.strictEqual(findings[0].observed, 3);
    assert.strictEqual(findings[0].acknowledged, 2);
  });
});

// ─── D8: comments are not drift ────────────────────────────────────────────

describe('D8 — comments are not drift', () => {
  test('guard: comments are not drift', () => {
    const text = [
      '// writeStateMd(statePath, modified, cwd);',
      '/**',
      ' * writeStateMd(statePath, modified, cwd);',
      ' */',
      'function noop() {}',
    ].join('\n');

    // ADR-3180 Amendment 3's recorded false positive: a `//` line comment
    // and a `/* */` block comment both carrying the exact call text must
    // stay silent — both are blanked by `stripComments` before the seam-call
    // regex ever runs.
    assert.deepStrictEqual(findSeamBypasses(OTHER_FILE, text), []);
  });
});

// ─── D9/D10: the owner-file exemption is function-scoped, not file-scoped ──

describe('D9 — owner functions are exempt', () => {
  test('guard: owner functions are exempt', () => {
    assert.ok(SEAM_OWNER_EXEMPT_FUNCTIONS.includes('readModifyWriteStateMd'));

    const text = [
      'function readModifyWriteStateMd(cwd) {',
      '  const modified = compute();',
      '  writeStateMd(statePath, modified, cwd);',
      '  return modified;',
      '}',
    ].join('\n');

    // The seam's own internal plumbing (the I/O wrapper calling the pure
    // sync stage) is not a bypass.
    assert.deepStrictEqual(findSeamBypasses(SEAM_OWNER_FILE, text), []);
  });
});

describe('D10 — the owner file is not exempt', () => {
  test('guard: the owner file is not exempt', () => {
    // ADR-3408 Decision 5's named gaming route: a whole-FILE exemption on
    // the owner is exactly how getMilestoneInfo stayed invisible to an
    // earlier drift guard. A call inside any OTHER function in state.cts —
    // not one of SEAM_OWNER_EXEMPT_FUNCTIONS — must still be caught.
    const text = [
      'function patchCore(cwd) {',
      '  const modified = compute();',
      '  writeStateMd(statePath, modified, cwd);',
      '  return modified;',
      '}',
    ].join('\n');

    const out = findSeamBypasses(SEAM_OWNER_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].line, 3);
  });
});

// ─── D11: the prompt layer is in the scan surface ──────────────────────────

describe('D11 — the prompt layer is in the scan surface', () => {
  const PROMPT_FILE = 'gsd-core/workflows/example-workflow.md';

  test('guard: the prompt layer is in the scan surface', () => {
    const text = [
      '# Example workflow',
      '',
      'Run gsd-tools state.patch --field status --value done to record completion directly.',
    ].join('\n');

    const out = findPromptSeamUses(PROMPT_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].line, 3);
    assert.strictEqual(out[0].symbol, 'prompt-layer-state-write');
  });

  test('control: the same candidate wrapped in backticks is a mention, not an invocation, and is not reported', () => {
    // Proves the detection above is genuinely exercising the code-span
    // exclusion, not merely that the fixture happens to score zero.
    const text = 'Documentation only: `gsd-tools state.patch --field status --value done`.';
    assert.deepStrictEqual(findPromptSeamUses(PROMPT_FILE, text), []);
  });
});

// ─── D12: CRLF is scanned identically to LF ────────────────────────────────

describe('D12 — CRLF is scanned identically', () => {
  test('guard: CRLF is scanned identically', () => {
    const lfText = [
      'function cmdSomethingElse(cwd) {',
      '  writeStateMd(statePath, modified, cwd);',
      '}',
    ].join('\n');
    const crlfText = lfText.split('\n').join('\r\n');

    const lfOut = findSeamBypasses(OTHER_FILE, lfText);
    const crlfOut = findSeamBypasses(OTHER_FILE, crlfText);

    assert.strictEqual(crlfOut.length, 1);
    const strip = (arr) => arr.map(({ line, symbol, source }) => ({ line, symbol, source }));
    assert.deepStrictEqual(strip(crlfOut), strip(lfOut));
    // A stray trailing \r surviving into the reported source (the repo's
    // documented \n-only-regex bug class) would show up here as a
    // sanitized `\x0d` escape — it must not.
    assert.strictEqual(crlfOut[0].source, 'writeStateMd(statePath, modified, cwd);');
  });
});

// ─── D13: an unreadable file degrades, never crashes ───────────────────────

describe('D13 — an unreadable file is reported, not fatal', () => {
  test('guard: an unreadable file is reported, not fatal', (t) => {
    const originalReadFileSync = fs.readFileSync;
    t.after(() => {
      fs.readFileSync = originalReadFileSync;
    });

    // Monkeypatch (never chmod 0o000, which root bypasses under Docker/CI
    // and would leave this assertion covering nothing). Scoped to
    // BASELINE_PATH only, so no other read in this process is disturbed.
    fs.readFileSync = function patchedReadFileSync(target, ...rest) {
      if (target === BASELINE_PATH) {
        const err = new Error('simulated unreadable baseline file');
        err.code = 'EACCES';
        throw err;
      }
      return originalReadFileSync.call(fs, target, ...rest);
    };

    // loadBaseline() must not throw — it degrades to a returned value.
    assert.doesNotThrow(() => loadBaseline());
    const result = loadBaseline();
    // An unreadable file (EACCES) is NOT the same state as an absent one
    // (ENOENT) and must not degrade to the same "no baseline yet" shape —
    // collapsing the two is the exact ADR-3180/ADR-3408 failure mode this
    // guard exists to catch. loadBaseline() must surface a distinguishable
    // `entries: null` result carrying the underlying fs error code.
    assert.deepStrictEqual(result, { entries: null, code: 'EACCES' });
  });

  test('CLI: an unreadable baseline reaches REASON.BASELINE_UNREADABLE with its error code, not the first-run shape', (t) => {
    const originalReadFileSync = fs.readFileSync;
    t.after(() => {
      fs.readFileSync = originalReadFileSync;
    });

    fs.readFileSync = function patchedReadFileSync(target, ...rest) {
      if (target === BASELINE_PATH) {
        const err = new Error('simulated unreadable baseline file');
        err.code = 'EACCES';
        throw err;
      }
      return originalReadFileSync.call(fs, target, ...rest);
    };

    // Drive main() in-process (not via the CLI subprocess helper) so the
    // monkeypatched fs.readFileSync is actually in effect for the call.
    const originalArgv = process.argv;
    const originalWrite = process.stdout.write;
    t.after(() => {
      process.stdout.write = originalWrite;
      process.argv = originalArgv;
      process.exitCode = 0;
    });
    let captured = '';
    process.stdout.write = function patchedWrite(chunk) {
      captured += chunk;
      return true;
    };
    process.argv = [originalArgv[0], GUARD_PATH, '--json'];
    guard.main(['--json']);
    const exitCode = process.exitCode;

    assert.strictEqual(exitCode, 1);
    const parsed = JSON.parse(captured);
    assert.strictEqual(parsed.ok, false);
    assert.strictEqual(parsed.findings.length, 1);
    assert.strictEqual(parsed.findings[0].reason, REASON.BASELINE_UNREADABLE);
    assert.strictEqual(parsed.findings[0].code, 'EACCES');
  });
});

// ─── D14: field-name-keyed BRANCH comparisons (not just CALLS) ────────────
// #3468: `applyPreserveIfPlaceholder` shipped a `field !== 'milestone_name'`
// branch — a field-name-keyed dispatch that routed around
// `getFieldClassification` entirely, so `FIELD_NAME_DISPATCH_RE` (which only
// matches the CALL shape) reported zero violations while the branch shape
// sat in the executor undetected. This section drives the widened detector
// directly against in-memory fixtures, mirroring D2's own "guard: does the
// pure function itself report" pattern.

describe('D14 — field-name-keyed branch comparisons are caught', () => {
  test('guard: field !== literal is reported as FIELD_NAME_DISPATCH', () => {
    const text = [
      'function applyPreserveIfPlaceholder(field, cls, ctx) {',
      "  if (field !== 'milestone_name') return;",
      '}',
    ].join('\n');

    const out = findPolicyDispatchDrift(EXECUTOR_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].reason, REASON.FIELD_NAME_DISPATCH);
    assert.strictEqual(out[0].line, 2);
    assert.strictEqual(out[0].field, 'milestone_name');
  });

  test('guard: field === literal is reported as FIELD_NAME_DISPATCH', () => {
    const text = [
      'function applyPreserveWhenUnchanged(field, cls, ctx) {',
      "  if (field === 'status') return;",
      '}',
    ].join('\n');

    const out = findPolicyDispatchDrift(EXECUTOR_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].reason, REASON.FIELD_NAME_DISPATCH);
    assert.strictEqual(out[0].line, 2);
    assert.strictEqual(out[0].field, 'status');
  });

  test('guard: the reversed literal === field is reported as FIELD_NAME_DISPATCH', () => {
    const text = [
      'function applyPreserveIfPlaceholder(field, cls, ctx) {',
      "  if ('milestone' === field) return;",
      '}',
    ].join('\n');

    const out = findPolicyDispatchDrift(EXECUTOR_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].reason, REASON.FIELD_NAME_DISPATCH);
    assert.strictEqual(out[0].line, 2);
    assert.strictEqual(out[0].field, 'milestone');
  });

  test('control: preservation === literal (the CORRECT policy-dispatch shape) is NOT reported', () => {
    const text = [
      'function applyPreserveAlways(field, cls, ctx) {',
      "  if (cls.preservation === 'preserve-always') return;",
      '}',
    ].join('\n');

    assert.deepStrictEqual(findPolicyDispatchDrift(EXECUTOR_FILE, text), []);
  });

  test('control: an unrelated variable compared to a literal is NOT reported', () => {
    const text = [
      'function helper(status, cls, ctx) {',
      "  if (status !== 'unknown') return;",
      '}',
    ].join('\n');

    assert.deepStrictEqual(findPolicyDispatchDrift(EXECUTOR_FILE, text), []);
  });

  test('control: bracket-indexed field access (ctx.postFm[field]) compared to a non-literal is NOT reported', () => {
    const text = [
      'function applyPreserveWhenUnchanged(field, cls, ctx) {',
      '  if (ctx.postFm[field] === snapshot) return;',
      '}',
    ].join('\n');

    assert.deepStrictEqual(findPolicyDispatchDrift(EXECUTOR_FILE, text), []);
  });
});

// ─── D15: `file` (and other attacker-derived fields) are sanitized AT
// CONSTRUCTION, not just by the human formatter ─────────────────────────────
// Security review finding: a repo can legally track a filename containing C1
// control bytes or bidi-override codepoints — exactly as attacker-controlled
// on a fork PR as the `source` fragment this guard already sanitized before
// this fix. Before this fix `file` reached `--json` stdout and the committed
// baseline (`scripts/state-write-path-drift-baseline.json`) unsanitized —
// only the human formatter wrapped it. A finding's `file` (and any other
// attacker-derived field, like `field`) must come back escaped from the
// FINDER itself, so every consumer (human, `--json`, baseline) inherits the
// sanitization uniformly.
//
// The two attack codepoints are built via `String.fromCharCode` rather than
// embedded as literal bytes, so this test file's own source never carries a
// live control/bidi codepoint on disk.

describe('D15 — file (and field) values are sanitized at construction', () => {
  const RLO = String.fromCharCode(0x202e); // RIGHT-TO-LEFT OVERRIDE (bidi)
  const C1_CSI = String.fromCharCode(0x9b); // C1 CONTROL: CSI
  const ATTACK_FILE = `src/evil${RLO}${C1_CSI}name.cts`;
  const ESCAPED_FILE = 'src/evil\\u202e\\x9bname.cts';

  test('findSeamBypasses: an attacker-controlled filename comes back escaped', () => {
    const text = ['function cmdSomethingElse(cwd) {', '  writeStateMd(statePath, modified, cwd);', '}'].join('\n');

    const out = findSeamBypasses(ATTACK_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].file, ESCAPED_FILE);
    // Neither raw attack codepoint survives in the finding at all — this is
    // exactly what reaches `--json` stdout verbatim (JSON.stringify
    // neutralizes C0 but NOT C1 or bidi codepoints, which is why
    // construction-time escaping — not JSON.stringify — is load-bearing).
    assert.ok(!out[0].file.includes(RLO));
    assert.ok(!out[0].file.includes(C1_CSI));

    // The SAME escaped value is what a regenerated baseline entry persists —
    // proving the fix reaches the committed
    // scripts/state-write-path-drift-baseline.json, not just the finding.
    const entries = buildBaselineEntries(out, null);
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].file, ESCAPED_FILE);
    assert.ok(!entries[0].file.includes(RLO));
    assert.ok(!entries[0].file.includes(C1_CSI));
  });

  test('findPromptSeamUses: an attacker-controlled filename comes back escaped', () => {
    const text = 'Run gsd-tools state.patch --field status --value done to record completion directly.';

    const out = findPromptSeamUses(ATTACK_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].file, ESCAPED_FILE);
    assert.ok(!out[0].file.includes(RLO));
    assert.ok(!out[0].file.includes(C1_CSI));
  });

  test('findPolicyDispatchDrift: filename AND the field literal are both escaped', () => {
    const text = ["  if (field === 'status" + RLO + C1_CSI + "') return;"].join('\n');

    const out = findPolicyDispatchDrift(ATTACK_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].file, ESCAPED_FILE);
    assert.strictEqual(out[0].field, 'status\\u202e\\x9b');
    assert.ok(!out[0].field.includes(RLO));
    assert.ok(!out[0].field.includes(C1_CSI));
  });
});
