'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * Unit + whole-repo coverage for the PHASE-COMPLETION drift guard
 * (scripts/lint-completion-predicate-drift.cjs, epic #3180, issue #3186,
 * ADR-3180 §7.4, Decision 4). Modelled on tests/milestone-window-drift-guard.test.cjs
 * / tests/completion-ratio-single-owner.test.cjs's guard sections: behavioral
 * throughout — every assertion drives the guard's exported pure functions
 * directly, never `readFileSync().includes()`.
 *
 * Covers 50-test-matrix.md section E (the guard) plus D3 (the dependency-
 * direction guard: plan-scan.cts does not import verification.cts).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const drift = require('../scripts/lint-completion-predicate-drift.cjs');
const { sanitizeForReport } = require('../scripts/lib/drift-scan.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const OWNER_RELPATH = drift.OWNER_FILE; // path.join('src', 'verification.cts')

// ═════════════════════════════════════════════════════════════════════════
// E1 — the real repo tree, post-migration: 0 violations, earned per shape.
// ═════════════════════════════════════════════════════════════════════════

describe('E1 — scanRepo(repoRoot) against the real repo: earned zero', () => {
  test('zero violations across the whole scan surface (src/ + prompt layer)', () => {
    const violations = drift.scanRepo(ROOT);
    assert.deepStrictEqual(
      violations,
      [],
      'unsanctioned phase-completion re-derivation(s) — route through src/verification.cts '
        + '`isPhaseComplete` (issue #3186, ADR-3180 §7.4):\n'
        + violations.map((d) => `  ${d.file}:${d.line} [shape ${d.shape}] ${d.found}`).join('\n'),
    );
  });

  test('per-shape proof: a deliberate (a)/(b)/(c) fixture is NOT silently swallowed by scanRepo', (t) => {
    // Distinguishes "0 because nothing to find" from "0 because the detector
    // is broken" — scanRepo on a synthetic tree carrying all three shapes
    // must report exactly 3, proving the same code path scanRepo(ROOT) took
    // is capable of finding violations at all.
    const root = createTempDir('gsd-completion-predicate-drift-');
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'src', 'fake.cts'),
      [
        'function fakeConsumer(roadmapComplete, planCount, summaryCount) {',
        "  let status = 'pending';",
        '  if (roadmapComplete && status !== \'complete\') {',
        "    status = 'complete';",
        '  }',
        '  const verificationStatus = planCount > 0',
        '    ? readVerificationStatus(phaseDir)',
        "    : { status: 'not_required' };",
        '  const done = summaryCount >= planCount && planCount > 0;',
        '  return { status, verificationStatus, done };',
        '}',
      ].join('\n'),
    );
    const violations = drift.scanRepo(root);
    const shapes = violations.map((v) => v.shape).sort();
    assert.deepStrictEqual(shapes, ['a', 'b', 'c']);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// E2 — fixture reintroducing shapes (a), (b), (c): each flagged, one hit
// apiece.
// ═════════════════════════════════════════════════════════════════════════

describe('E2 — each shape flagged in isolation, exactly one hit apiece', () => {
  test('shape (a): checkbox-derived completion override', () => {
    const text = [
      'function fakeConsumer(roadmapComplete) {',
      "  let diskStatus = 'planned';",
      '  if (roadmapComplete && diskStatus !== \'complete\') {',
      "    diskStatus = 'complete';",
      '  }',
      '  return diskStatus;',
      '}',
    ].join('\n');
    const out = drift.findCompletionPredicateDrift(text, path.join('src', 'unrelated.cts'));
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].shape, 'a');
  });

  test('shape (b): plan-count precondition gating a verification read', () => {
    const text = [
      'function fakeConsumer(planCount, phaseDir) {',
      '  return planCount > 0',
      '    ? readVerificationStatus(phaseDir)',
      "    : { status: 'not_required' };",
      '}',
    ].join('\n');
    const out = drift.findCompletionPredicateDrift(text, path.join('src', 'unrelated.cts'));
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].shape, 'b');
  });

  test('shape (c): local re-implementation of "complete" from counts', () => {
    const text = [
      'function fakeConsumer(summaryCount, planCount) {',
      '  return summaryCount >= planCount && planCount > 0;',
      '}',
    ].join('\n');
    const out = drift.findCompletionPredicateDrift(text, path.join('src', 'unrelated.cts'));
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].shape, 'c');
  });

  test('shape (c): the reversed operand order (planCount <= summaryCount) is also flagged', () => {
    const text = [
      'function fakeConsumer(summaryCount, planCount) {',
      '  return planCount <= summaryCount;',
      '}',
    ].join('\n');
    const out = drift.findCompletionPredicateDrift(text, path.join('src', 'unrelated.cts'));
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].shape, 'c');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// E3 — shape (a) with a nested-paren if-condition: flagged. (The first draft
// missed exactly this on cmdInitManager's `(completion.phase_complete ||
// planCount === 0)` nested group.)
// ═════════════════════════════════════════════════════════════════════════

describe('E3 — shape (a): nested-paren if-condition', () => {
  test('a second parenthesised group inside the if-condition is still detected', () => {
    const text = [
      'function fakeConsumer(roadmapComplete, completion, planCount) {',
      "  let diskStatus = 'planned';",
      '  if (roadmapComplete && (completion.phase_complete || planCount === 0) && diskStatus !== \'complete\') {',
      "    diskStatus = 'complete';",
      '  }',
      '  return diskStatus;',
      '}',
    ].join('\n');
    const out = drift.findCompletionPredicateDrift(text, path.join('src', 'unrelated.cts'));
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].shape, 'a');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// E4 — an unconditional readVerificationStatus( call (the cmdPhaseComplete
// shape): NOT flagged.
// ═════════════════════════════════════════════════════════════════════════

describe('E4 — an unconditional readVerificationStatus( call is not flagged', () => {
  test('no ternary gate on the call, no count-gate in the function: clean', () => {
    const text = [
      'function fakeConsumer(phaseDir) {',
      '  const verificationStatus = readVerificationStatus(phaseDir, { runtime: \'claude\' });',
      '  return verificationStatus;',
      '}',
    ].join('\n');
    const out = drift.findCompletionPredicateDrift(text, path.join('src', 'unrelated.cts'));
    assert.deepStrictEqual(out, []);
  });

  test('a count-gate present elsewhere in the SAME function but the read is unconditional: still clean', () => {
    // Shape (b) requires the readVerificationStatus( call ITSELF to be
    // ternary-gated on the same line — a count-gate merely coexisting with
    // an unconditional call must not fire.
    const text = [
      'function fakeConsumer(phaseDir, retryCount) {',
      '  if (retryCount > 0) { /* retry bookkeeping, unrelated */ }',
      '  const verificationStatus = readVerificationStatus(phaseDir);',
      '  return verificationStatus;',
      '}',
    ].join('\n');
    const out = drift.findCompletionPredicateDrift(text, path.join('src', 'unrelated.cts'));
    assert.deepStrictEqual(out, []);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// E5 — all three shapes inside `//` and `/* */` comments: NOT flagged.
// ═════════════════════════════════════════════════════════════════════════

describe('E5 — commented-out shapes are not flagged', () => {
  test('shape (a) inside a // line comment', () => {
    const text = [
      "// if (roadmapComplete && diskStatus !== 'complete') diskStatus = 'complete';",
    ].join('\n');
    assert.deepStrictEqual(drift.findCompletionPredicateDrift(text, path.join('src', 'unrelated.cts')), []);
  });

  test('shape (b) inside a /* */ block comment', () => {
    const text = [
      '/*',
      '  const v = planCount > 0 ? readVerificationStatus(phaseDir) : { status: "not_required" };',
      '*/',
    ].join('\n');
    assert.deepStrictEqual(drift.findCompletionPredicateDrift(text, path.join('src', 'unrelated.cts')), []);
  });

  test('shape (c) inside a JSDoc continuation comment', () => {
    const text = [
      '/**',
      ' * e.g. `summaryCount >= planCount && planCount > 0` is the old shape.',
      ' */',
    ].join('\n');
    assert.deepStrictEqual(drift.findCompletionPredicateDrift(text, path.join('src', 'unrelated.cts')), []);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// E6 — retryCount > 0 and other unrelated count gates: NOT flagged.
// ═════════════════════════════════════════════════════════════════════════

describe('E6 — unrelated count gates alone are not flagged', () => {
  test('retryCount > 0 with no readVerificationStatus( call anywhere in the function', () => {
    const text = [
      'function fakeRetry(retryCount) {',
      '  if (retryCount > 0) return doRetry();',
      '  return doOnce();',
      '}',
    ].join('\n');
    assert.deepStrictEqual(drift.findCompletionPredicateDrift(text, path.join('src', 'unrelated.cts')), []);
  });

  test('itemCount > 0 gating an unrelated ternary (no verification call at all)', () => {
    const text = [
      'function fakeList(itemCount) {',
      "  return itemCount > 0 ? 'has items' : 'empty';",
      '}',
    ].join('\n');
    assert.deepStrictEqual(drift.findCompletionPredicateDrift(text, path.join('src', 'unrelated.cts')), []);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// E7 — owner file: `isPhaseComplete` exempt BY FUNCTION NAME, never whole-file.
// ═════════════════════════════════════════════════════════════════════════

describe('E7 — owner-file exemption is function-scoped, not file-scoped', () => {
  test('the canonical isPhaseComplete body is exempt in the owner file', () => {
    const text = [
      'function isPhaseComplete(phaseDir, deps) {',
      '  const verification = readVerificationStatus(phaseDir, deps);',
      "  return { value: { complete: verification.status === 'passed', verification }, scope: SCOPE.COMPLETE };",
      '}',
    ].join('\n');
    assert.deepStrictEqual(drift.findCompletionPredicateDrift(text, OWNER_RELPATH), []);
  });

  test('a differently-named function in the SAME owner file carrying shape (c) IS flagged', () => {
    const text = [
      'function isPhaseComplete(phaseDir) { return true; }',
      '',
      'function someOtherHelper(summaryCount, planCount) {',
      '  return summaryCount >= planCount && planCount > 0;',
      '}',
    ].join('\n');
    const out = drift.findCompletionPredicateDrift(text, OWNER_RELPATH);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].fn, 'someOtherHelper');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// E8 — a SECOND, unrelated predicate added elsewhere IN THE OWNER FILE:
// flagged (the Amendment-4 blind spot — a whole-file exemption on the owner
// is precisely how a prior guard's owner grew an invisible second copy).
// ═════════════════════════════════════════════════════════════════════════

describe('E8 — a second predicate elsewhere in the owner file is flagged (Amendment-4 blind spot)', () => {
  test('shape (a) added to a non-canonical function in src/verification.cts is caught', () => {
    const text = [
      'function isPhaseComplete(phaseDir) { return true; }',
      '',
      'function cmdSomeNewVerb(roadmapComplete) {',
      "  let status = 'pending';",
      '  if (roadmapComplete && status !== \'complete\') {',
      "    status = 'complete';",
      '  }',
      '  return status;',
      '}',
    ].join('\n');
    const out = drift.findCompletionPredicateDrift(text, OWNER_RELPATH);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].shape, 'a');
    assert.strictEqual(out[0].fn, 'cmdSomeNewVerb');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// E9 — prompt-layer fixture reintroducing the checkbox OR: flagged (the
// scan surface really covers gsd-core/workflows, not just src/).
// ═════════════════════════════════════════════════════════════════════════

describe('E9 — prompt-layer checkbox-OR re-derivation is flagged', () => {
  test('findPromptCompletionDrift flags the two-line assign/test pairing', () => {
    const lines = [
      'PHASE_COMPLETE=$(echo "$PHASE_INFO" | jq -r \'.roadmap_complete // false\')',
      'DISK_STATUS=$(echo "$ANALYZE" | jq -r \'.disk_status\')',
      'if [[ "$DISK_STATUS" == "complete" || "$PHASE_COMPLETE" == "true" ]]; then',
      '  STATUS="completed"',
      'fi',
    ].join('\n');
    const out = drift.findPromptCompletionDrift(lines, path.join('gsd-core', 'workflows', 'fake.md'));
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].shape, 'a');
  });

  test('scanRepo finds the same fixture when it is a real .md file under gsd-core/workflows', (t) => {
    const root = createTempDir('gsd-completion-predicate-drift-');
    t.after(() => cleanup(root));
    fs.mkdirSync(path.join(root, 'gsd-core', 'workflows'), { recursive: true });
    fs.writeFileSync(
      path.join(root, 'gsd-core', 'workflows', 'fake.md'),
      [
        'PHASE_COMPLETE=$(echo "$PHASE_INFO" | jq -r \'.roadmap_complete // false\')',
        'if [[ "$DISK_STATUS" == "complete" || "$PHASE_COMPLETE" == "true" ]]; then',
        '  STATUS="completed"',
        'fi',
      ].join('\n'),
    );
    const violations = drift.scanRepo(root);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].shape, 'a');
  });

  test('a DISK_STATUS-only check (no checkbox OR) is not flagged', () => {
    const lines = [
      'if [[ "$DISK_STATUS" == "complete" ]]; then',
      '  STATUS="completed"',
      'fi',
    ].join('\n');
    assert.deepStrictEqual(drift.findPromptCompletionDrift(lines, path.join('gsd-core', 'workflows', 'fake.md')), []);
  });
});

// ═════════════════════════════════════════════════════════════════════════
// E10 — filename with control bytes / bidi: sanitized in report output.
// ═════════════════════════════════════════════════════════════════════════

describe('E10 — sanitizeForReport neutralizes control bytes and bidi overrides', () => {
  test('a C0 control byte in a violation "found" fragment is escaped, not passed through raw', () => {
    const raw = 'diskStatus = \x1b[31m\'complete\'\x1b[0m;';
    const sanitized = sanitizeForReport(raw);
    assert.ok(!sanitized.includes('\x1b'), 'raw ESC byte must not survive sanitization');
    assert.ok(sanitized.includes('\\x1b'), 'ESC byte must be rendered as a visible \\xNN escape');
  });

  test('a bidi right-to-left override codepoint in a reported file path is escaped', () => {
    const raw = 'src/‮evil.cts';
    const sanitized = sanitizeForReport(raw);
    assert.ok(!sanitized.includes('‮'), 'raw RLO codepoint must not survive sanitization');
    assert.ok(sanitized.includes('\\u202e'), 'RLO codepoint must be rendered as a visible \\uNNNN escape');
  });
});

// ═════════════════════════════════════════════════════════════════════════
// D3 — the 0.x-split over-consolidation guard: plan-scan.cts does NOT
// import verification.cts (the owner consumes plan counts, never the
// reverse — ADR-3180 §7.4 HARD CONSTRAINT).
// ═════════════════════════════════════════════════════════════════════════

describe('D3 — dependency direction: plan-scan.cts does not import verification.cts', () => {
  test('the compiled plan-scan.cjs source contains no reference to verification.cjs', () => {
    const compiled = fs.readFileSync(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'plan-scan.cjs'), 'utf-8');
    assert.ok(!/require\(['"]\.\/verification(\.cjs)?['"]\)/.test(compiled), 'plan-scan.cjs must not require verification.cjs');
  });

  test('the plan-scan.cts source has no import/require of verification.cjs/.cts (a prose comment MENTIONING it, e.g. explaining why a field is not routed through it, is not an import and must not false-positive)', () => {
    const source = fs.readFileSync(path.join(ROOT, 'src', 'plan-scan.cts'), 'utf-8');
    assert.ok(
      !/\b(?:require|import)\s*(?:\(|\{|[A-Za-z_$][\w$]*\s*=)[^;\r\n]*verification\.c(?:j|t)s/.test(source),
      'src/plan-scan.cts must not import/require verification.cts/.cjs',
    );
  });

  test('src/verification.cts DOES import plan-scan.cjs (the direction that is allowed: owner consumes counts)', () => {
    // Documents the ALLOWED direction so the pair of assertions above reads
    // as a genuine one-way constraint, not an accidental total decoupling.
    const source = fs.readFileSync(path.join(ROOT, 'src', 'verification.cts'), 'utf-8');
    assert.ok(/require\(['"]\.\/plan-scan\.cjs['"]\)/.test(source), 'src/verification.cts is expected to import plan-scan.cjs (for staleness-check summary listing, pre-existing/unrelated to isPhaseComplete)');
  });
});
