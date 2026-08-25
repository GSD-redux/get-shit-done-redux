'use strict';

/**
 * Tests for the STATE.md write-path anti-divergence drift guard
 * (epic #3408, issue #3468, ADR-3408 Decision 5; SHRUNK per ADR-3473 §8.6,
 * issue #3871) — `scripts/lint-state-write-path-drift.cjs`.
 *
 * Design contract: docs/adr/3408-state-write-path-preservation.md (§8.1/§8.2/§8.3)
 *                   docs/adr/3473-enforcement-by-construction.md (§8.6)
 * Test matrix:      .gsd/phase/refactor-3468-table-driven-preservation/50-test-matrix.md
 *                    (section D, rows D1-D15 — this file previously covered
 *                    section D in full; ADR-3473 §8.6 retired the write-seam
 *                    bypass axis (`findSeamBypasses`) and its baseline-ratchet
 *                    machinery (`applyRatchet`/`loadBaseline`/`buildBaselineEntries`/
 *                    `scripts/state-write-path-drift-baseline.json`, all deleted),
 *                    since `writeStateMd`'s third parameter now requires a
 *                    `StateTransaction` the type system names
 *                    (`openStateTransaction`/`rebuildStateTransaction`,
 *                    `src/state-transition.cts`) rather than a ratcheted
 *                    string match. Rows D2-D10, D12, D13 (all of which drove
 *                    the retired `findSeamBypasses`/ratchet/baseline-file
 *                    machinery) are REMOVED along with it — the type system,
 *                    not this guard, is now what makes a `writeStateMd`
 *                    bypass unrepresentable. Rows D1, D11, D14, D15 and
 *                    section E rows E3-E5 (the axes ADR-3473 §8.6 did NOT
 *                    name for removal) are retained. F1/F2 are new: F1 drives
 *                    the raw-write axis (`findRawStateWrites`) as a pure
 *                    function; F2 proves the shrunk guard's real CLI entry
 *                    point can still fail.
 *
 * Every row except D1 and F2 drives the guard's exported PURE functions
 * directly with in-memory fixtures — no temp tree is needed, mirroring
 * tests/state-field-drift.test.cjs's own house pattern for this class of
 * guard. D1 (the real-tree contract: THIS repo's `src/` and prompt layer are
 * clean) is driven through the CLI's `--json` output against the real
 * `REPO_ROOT` — no `--root` override, no fixture. F2 (proving the guard CAN
 * fail) needs a tree that is NOT clean, and must never get that by mutating
 * this repository's own `src/`: a fixture planted in the real source tree
 * would be visible to any concurrent `tsc`/`npm run build:lib`/`npm run
 * lint`/another guard invocation, and would survive as permanent build-
 * breaking debris if the process were killed before `t.after` ran (a
 * real-race test, which this repo's rules say to redesign rather than
 * annotate around). `scripts/lint-state-write-path-drift.cjs` therefore
 * takes an explicit `--root <dir>` CLI flag (and `collect(root)` takes a
 * matching parameter), defaulting to the real repo so every existing
 * invocation (`npm run lint:ci` included) is byte-identical — F2 plants its
 * violation in a `createTempDir()` (`tests/helpers.cjs`) tree instead, runs
 * the real CLI against it via `--root`, and tears it down with `cleanup()`.
 *
 * Fixtures use array `.join('\n')`, never an indented template literal —
 * indentation bleed would shift every asserted line number.
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
const { createTempDir, cleanup } = require('./helpers.cjs');

const guard = require('../scripts/lint-state-write-path-drift.cjs');
const {
  REASON,
  findPromptSeamUses,
  findPolicyDispatchDrift,
  findUnstrippedContentWrites,
  findRawStateWrites,
  targetsStatePath,
  EXECUTOR_FILE,
  REPO_ROOT,
} = guard;

const GUARD_PATH = path.join(REPO_ROOT, 'scripts', 'lint-state-write-path-drift.cjs');

// A synthetic, non-executor consumer file — never a real repo path — used
// wherever a row does not specifically need EXECUTOR_FILE behavior.
const OTHER_FILE = 'src/example-consumer.cts';

// ─── D1: the real tree, through the CLI's --json contract ─────────────────

describe('D1 — the real tree', () => {
  test('guard: clean tree passes', () => {
    const result = runNode([GUARD_PATH, '--json'], { cwd: REPO_ROOT, timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(result.outcome, 'exited');
    const body = JSON.parse(result.stdout);
    assert.strictEqual(body.ok, true);
    assert.deepStrictEqual(body.findings, []);
    assert.strictEqual(result.exitCode, 0);
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
    assert.strictEqual(out[0].reason, REASON.PROMPT_LAYER_STATE_WRITE);
    assert.strictEqual(out[0].symbol, 'prompt-layer-state-write');
  });

  test('control: the same candidate wrapped in backticks is a mention, not an invocation, and is not reported', () => {
    // Proves the detection above is genuinely exercising the code-span
    // exclusion, not merely that the fixture happens to score zero.
    const text = 'Documentation only: `gsd-tools state.patch --field status --value done`.';
    assert.deepStrictEqual(findPromptSeamUses(PROMPT_FILE, text), []);
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
// this fix. Before this fix `file` reached `--json` stdout unsanitized —
// only the human formatter wrapped it. A finding's `file` (and any other
// attacker-derived field, like `field`) must come back escaped from the
// FINDER itself, so every consumer (human, `--json`) inherits the
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

  test('findRawStateWrites: an attacker-controlled filename comes back escaped', () => {
    const text = ['function cmdSomethingElse(cwd) {', '  fs.writeFileSync(statePath, modified);', '}'].join('\n');

    const out = findRawStateWrites(ATTACK_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].file, ESCAPED_FILE);
    // Neither raw attack codepoint survives in the finding at all — this is
    // exactly what reaches `--json` stdout verbatim (JSON.stringify
    // neutralizes C0 but NOT C1 or bidi codepoints, which is why
    // construction-time escaping — not JSON.stringify — is load-bearing).
    assert.ok(!out[0].file.includes(RLO));
    assert.ok(!out[0].file.includes(C1_CSI));
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
// Section E (Phase 2 / #3469) — ADR-3408 §8.3 Matrix section E: guard rows
// closing Phase 1's declared known gap (Axis 3, §8.3(b)). E1/E2/E6/E7/E8
// (all of which drove the retired `findSeamBypasses`/ratchet machinery) are
// REMOVED along with it, per ADR-3473 §8.6. E3/E4/E5 (the frontmatter-write
// axis ADR-3473 §8.6 did NOT name for removal) are retained.
// ─────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────
// F — ADR-3473 §8.6: the raw-write axis (`findRawStateWrites`), and the
// guard's own real CLI entry point proving the shrunk guard can still fail.
// ─────────────────────────────────────────────────────────────────────────

describe('F1 — the raw-write axis: pure function coverage', () => {
  test('guard: fs.writeFileSync against statePath is reported', () => {
    const text = [
      'function bogusRawWrite(statePath, content) {',
      '  fs.writeFileSync(statePath, content);',
      '}',
    ].join('\n');

    const out = findRawStateWrites(OTHER_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].reason, REASON.RAW_STATE_WRITE);
    assert.strictEqual(out[0].line, 2);
    assert.strictEqual(out[0].source, 'fs.writeFileSync(statePath, content);');
  });

  test('guard: fs.writeFileSync against a STATE.md literal is reported', () => {
    const text = [
      'function bogusRawWrite(cwd, content) {',
      "  fs.writeFileSync(path.join(cwd, 'STATE.md'), content);",
      '}',
    ].join('\n');

    const out = findRawStateWrites(OTHER_FILE, text);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].reason, REASON.RAW_STATE_WRITE);
  });

  test('control: fs.writeFileSync against an unrelated target is NOT reported', () => {
    const text = ['function writeSomethingElse(otherPath, content) {', '  fs.writeFileSync(otherPath, content);', '}'].join(
      '\n',
    );

    assert.deepStrictEqual(findRawStateWrites(OTHER_FILE, text), []);
  });

  test('control: platformWriteSync (the sanctioned seam) against statePath is NOT reported — a different call, by name', () => {
    // The type/seam this axis exists BESIDE, not instead of: every real
    // STATE.md writer in this codebase calls `platformWriteSync`, never raw
    // `fs.writeFileSync`, against `statePath`. This axis only matches the
    // literal `fs.writeFileSync` call shape.
    const text = ['function realWriter(statePath, content) {', '  platformWriteSync(statePath, content);', '}'].join(
      '\n',
    );

    assert.deepStrictEqual(findRawStateWrites(OTHER_FILE, text), []);
  });

  test('guard: comments are not drift', () => {
    const text = [
      '// fs.writeFileSync(statePath, modified);',
      '/**',
      ' * fs.writeFileSync(statePath, modified);',
      ' */',
      'function noop() {}',
    ].join('\n');

    assert.deepStrictEqual(findRawStateWrites(OTHER_FILE, text), []);
  });

  test('targetsStatePath: bare identifier and STATE.md-literal both match; an unrelated identifier does not', () => {
    assert.ok(targetsStatePath('statePath'));
    assert.ok(targetsStatePath("path.join(cwd, 'STATE.md')"));
    assert.ok(!targetsStatePath('otherPath'));
  });
});

describe('F2 — a guard that cannot fail is not a guard: the real CLI entry point catches a raw write', () => {
  test('CLI: --root <synthetic tree> with fs.writeFileSync(statePath, ...) is reported, without touching the real src/ tree', (t) => {
    // A throwaway tree in an OS temp dir, never inside this repository — the
    // guard's own `--root` flag (default REPO_ROOT, so every OTHER caller of
    // this CLI is unaffected) is what makes this possible without mutating
    // the repo under test. See this file's header for why a real-src/
    // fixture was rejected.
    const tmpRoot = createTempDir('state-write-path-drift-guard-');
    t.after(() => cleanup(tmpRoot));

    const srcDir = path.join(tmpRoot, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    const fixtureContent = [
      "import * as fs from 'node:fs';",
      '',
      'function bogusRawWrite(statePath: string, content: string): void {',
      '  fs.writeFileSync(statePath, content);',
      '}',
    ].join('\n');
    fs.writeFileSync(path.join(srcDir, 'bogus.cts'), fixtureContent, 'utf8');

    const result = runNode([GUARD_PATH, '--root', tmpRoot, '--json'], { cwd: REPO_ROOT, timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(result.outcome, 'exited');
    assert.strictEqual(result.exitCode, 1, 'a real raw write against statePath must fail the CLI, not pass it');

    const body = JSON.parse(result.stdout);
    assert.strictEqual(body.ok, false);
    const finding = body.findings.find((f) => f.file === 'src/bogus.cts');
    assert.ok(finding, 'the planted fixture must appear in --json findings');
    assert.strictEqual(finding.reason, REASON.RAW_STATE_WRITE);
    assert.strictEqual(finding.line, 4);
  });

  test('CLI: --root <a clean synthetic tree> passes, proving --root does not silently widen scope back to REPO_ROOT', (t) => {
    const tmpRoot = createTempDir('state-write-path-drift-guard-clean-');
    t.after(() => cleanup(tmpRoot));

    const srcDir = path.join(tmpRoot, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'clean.cts'), "export const noop = () => 'noop';\n", 'utf8');
    const result = runNode([GUARD_PATH, '--root', tmpRoot, '--json'], { cwd: REPO_ROOT, timeoutMs: PROBE_TIMEOUT_MS });
    assert.strictEqual(result.outcome, 'exited');
    assert.strictEqual(result.exitCode, 0);
    const body = JSON.parse(result.stdout);
    assert.strictEqual(body.ok, true);
    assert.deepStrictEqual(body.findings, []);
  });
});
