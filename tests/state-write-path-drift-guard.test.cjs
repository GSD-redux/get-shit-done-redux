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
  findUnstrippedContentWrites,
  applyRatchet,
  loadBaseline,
  buildBaselineEntries,
  collect,
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
    // #3469: `readModifyWriteStateMd` now calls the single
    // `syncAndPreserveStateMd` symbol rather than assembling the two seam
    // calls itself, so it needs no exemption — `syncAndPreserveStateMd` is
    // the sole legitimate place `syncStateFrontmatter(` and
    // `applyPostSyncPreservation(` appear together (the composition every
    // OTHER caller, including `readModifyWriteStateMd`, now routes through).
    assert.ok(SEAM_OWNER_EXEMPT_FUNCTIONS.includes('syncAndPreserveStateMd'));

    const text = [
      'function syncAndPreserveStateMd(originalContent, transformedContent, statePath, cwd, resync) {',
      '  const synced = syncStateFrontmatter(transformedContent, cwd);',
      '  return applyPostSyncPreservation(originalContent, transformedContent, synced, statePath, resync);',
      '}',
    ].join('\n');

    // The seam's own internal plumbing (the one owned composition —
    // sync then post-sync preservation) is not a bypass.
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

// ─────────────────────────────────────────────────────────────────────────
// Phase 2 (#3469) — ADR-3408 §8.3 Matrix section E: guard rows closing
// Phase 1's declared known gap (Axis 3, §8.3(b)) and pinning the ratchet's
// new 2-permanent-entry shape (Amendment 2). Test matrix:
// .gsd/phase/refactor-3469-one-write-seam/50-test-matrix.md
//
// E4/E5 are the false-positive guards — the exact shape that measured 29
// false positives to 1 true positive in Phase 1's naive co-occurrence
// approximation (see this guard's own header, Axis 3). E7 is the inverse: a
// sanctioned-permanent entry vanishing from the observed tree must FAIL, not
// silently reach zero — a guard reaching zero here would only do so by
// having stopped looking at a real writer.
// ─────────────────────────────────────────────────────────────────────────

describe('E1 — a re-assembled composition at a new call site is detected', () => {
  test('guard: a call site invoking syncStateFrontmatter and applyPostSyncPreservation directly (bypassing syncAndPreserveStateMd) is caught on BOTH calls', () => {
    // Finding 3's exact shape (ADR-3408 Amendment 2): every step calls an
    // owner, so neither call alone is undeclared — but assembling the PAIR
    // at a call site outside the seam composition is the re-derivation §8.3
    // forbids by name. Synthetic: the real instance of this shape
    // (cmdPhaseComplete's pre-#3469 adapter) was fixed by this same phase.
    const text = [
      'function cmdReassembledAdapter(cwd, statePath, stateContent) {',
      '  let synced = syncStateFrontmatter(stateContent, cwd, authoritativeFm);',
      '  synced = applyPostSyncPreservation(originalStateContent, stateContent, synced, statePath, true, authoritativeFm);',
      '  return synced;',
      '}',
    ].join('\n');

    const observed = findSeamBypasses(OTHER_FILE, text);
    assert.strictEqual(observed.length, 2, 'both re-assembled stages must be caught, not just one');
    assert.deepStrictEqual(observed.map((f) => f.symbol).sort(), ['applyPostSyncPreservation', 'syncStateFrontmatter']);

    const findings = applyRatchet(observed, { entries: [] });
    assert.strictEqual(findings.length, 2);
    assert.ok(findings.every((f) => f.reason === REASON.SEAM_BYPASS_UNRECORDED));
  });
});

describe('E2 — a legitimate single call to the composition is not detected', () => {
  test('guard: calling syncAndPreserveStateMd (the ONE write-seam composition) is not a bypass', () => {
    // Verbatim from src/milestone.cts's real cmdMilestoneComplete call site
    // (ADR-3408 Amendment 2's third caller).
    const text = [
      '      const finalContent = syncAndPreserveStateMd(',
      '        originalStateContent,',
      '        result.content,',
      '        statePath,',
      '        cwd,',
      '        true,',
      '        undefined,',
      '        undefined,',
      '        divergedFields,',
      '      );',
    ].join('\n');

    assert.deepStrictEqual(findSeamBypasses(OTHER_FILE, text), []);
  });
});

describe('E3 — a patchCore-style frontmatter write is detected (closes the Phase 1 declared gap)', () => {
  test('guard: stateReplaceField over unstripped content with a variable field name is caught', () => {
    // The pre-Phase-2 shape #3469 fixed: patchCore ran stateReplaceField
    // over content that was never stripped of frontmatter, letting a
    // lowercase/frontmatter-shaped patch key rewrite the YAML block
    // directly, outside FIELD_CLASSIFICATION.
    const text = [
      'function patchCoreOld(content, intent) {',
      '  let modified = content;',
      '  for (const [field, value] of Object.entries(intent.patches)) {',
      '    const replaced = stateReplaceField(modified, field, value);',
      '    if (replaced !== null) modified = replaced;',
      '  }',
      '  return { content: modified };',
      '}',
    ].join('\n');

    const out = findUnstrippedContentWrites(EXECUTOR_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].reason, REASON.UNSTRIPPED_CONTENT_WRITE);
    assert.strictEqual(out[0].line, 4);
  });
});

describe('E4 — updateCore\'s strip-then-replace is NOT detected', () => {
  test('guard: the real updateCore call site (content stripped first) is not flagged', () => {
    // Verbatim from src/state-transition.cts's real updateCore — the shape
    // Phase 1 measured a naive co-occurrence detector at 29 false positives
    // to 1 true positive against; this is one of the 29.
    const text = [
      'function updateCore(content, intent) {',
      '  const existingFm = extractFrontmatter(content) as Record<string, unknown>;',
      '  const hasFrontmatter = Object.keys(existingFm).length > 0;',
      '  const body = stripFrontmatter(content);',
      '  const result = stateReplaceField(body, intent.field, intent.value);',
      '  if (result === null) {',
      '    return { content, updated: [], data: { updated: false } };',
      '  }',
      '}',
    ].join('\n');

    assert.deepStrictEqual(findUnstrippedContentWrites(EXECUTOR_FILE, text), []);
  });
});

describe('E5 — sectionBody-scoped stateReplaceField calls are NOT detected', () => {
  test('guard: a literal field name against a non-stripFrontmatter-derived section slice is not flagged', () => {
    // Verbatim from src/state-transition.cts's real mutateCurrentPositionFirstTime:
    // sectionBody is a Current-Position section slice (frontmatter-free by
    // construction — it comes from body.slice(...), never from raw content),
    // and the field name is a fixed Title-Case literal that can never
    // collide with a lowercase/snake_case YAML key. One of the ~20 calls
    // Phase 1's naive detector over-reported.
    const text = [
      'function mutateCurrentPositionFirstTime(body, intent, today, updated) {',
      '  const span = locateCurrentPosition(body);',
      '  if (span === null) return body;',
      '  let sectionBody = body.slice(span.start, span.end);',
      '  const phaseLabel = `${intent.phaseNumber} — EXECUTING`;',
      '  if (/^Phase:/m.test(sectionBody)) {',
      '    sectionBody = sectionBody.replace(/^Phase:.*$/m, `Phase: ${phaseLabel}`);',
      '  } else {',
      "    const replaced = stateReplaceField(sectionBody, 'Phase', phaseLabel);",
      '    if (replaced !== null) sectionBody = replaced;',
      '  }',
      '}',
    ].join('\n');

    assert.deepStrictEqual(findUnstrippedContentWrites(EXECUTOR_FILE, text), []);
  });
});

describe('E6 — ratchet: exactly 2 sanctioned-permanent entries remain (limit)', () => {
  test('guard: the real baseline has exactly 2 permanent entries, and the real tree matches it with zero findings', () => {
    const baseline = loadBaseline();
    assert.strictEqual(
      baseline.entries.length,
      2,
      'ADR-3408 Amendment 2: the ratchet holds exactly 2 sanctioned-permanent entries, not 0 — ' +
      'Phase 4 does not drive this baseline to empty',
    );
    for (const entry of baseline.entries) {
      assert.strictEqual(entry.owner, 'sanctioned-permanent');
    }
    const { seamFindings } = collect();
    const findings = applyRatchet(seamFindings, baseline);
    assert.deepStrictEqual(findings, [], 'the real tree must match the 2-entry baseline exactly');
  });
});

describe('E7 — ratchet: a sanctioned-permanent entry disappearing fails (limit-1)', () => {
  test('guard: removing one of the two permanent entries from the observed tree is reported STALE, not silently accepted', () => {
    const baseline = loadBaseline();
    assert.strictEqual(baseline.entries.length, 2);
    // Simulate one sanctioned entry (cmdStateSync's writeStateMd call)
    // vanishing from the observed tree — exactly the shape §8.3's closed
    // exception list forbids: a sanctioned exception may not silently
    // disappear (a guard reaching zero here would only do so by having
    // stopped looking at a real writer).
    const vanished = baseline.entries[0];
    const stillPresent = baseline.entries[1];
    const observed = [{ file: stillPresent.file, source: stillPresent.source, symbol: stillPresent.symbol, line: 1 }];

    const findings = applyRatchet(observed, baseline);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].reason, REASON.BASELINE_ENTRY_STALE);
    assert.strictEqual(findings[0].file, vanished.file);
    assert.strictEqual(findings[0].observed, 0);
    assert.strictEqual(findings[0].acknowledged, 1);
  });
});

describe('E8 — ratchet: a 3rd bypass beside the 2 sanctioned entries fails as unrecorded (limit+1)', () => {
  test('guard: a new, unacknowledged writeStateMd call alongside the 2 sanctioned entries fails', () => {
    const baseline = loadBaseline();
    assert.strictEqual(baseline.entries.length, 2);
    const matchingObserved = baseline.entries.map((e) => ({ file: e.file, source: e.source, symbol: e.symbol, line: 1 }));
    const newBypass = { file: OTHER_FILE, source: 'writeStateMd(statePath, modified, cwd);', symbol: 'writeStateMd', line: 42 };
    const observed = [...matchingObserved, newBypass];

    const findings = applyRatchet(observed, baseline);
    assert.strictEqual(findings.length, 1);
    assert.strictEqual(findings[0].reason, REASON.SEAM_BYPASS_UNRECORDED);
    assert.strictEqual(findings[0].file, OTHER_FILE);
  });
});
