'use strict';

/**
 * Tests for the STATE.md field-extraction fallback-chain drift guard
 * (epic #3180, issue #3187 Phase 5, ADR-3180 §7.7) —
 * `scripts/lint-state-field-drift.cjs`.
 *
 * Per ADR-3180 Decision 4(b) the guard AND this paired test are both
 * required; neither alone is sufficient. Every test here drives the
 * guard's exported PURE functions (`findStateFieldDrift`, `buildFunctionInfo`,
 * `scanRepo`) with string fixtures — no temp tree is needed for anything but
 * `scanRepo`'s own tree-walk contract (D1), which runs against the real repo.
 *
 * Covers .gsd/phase/refactor-3187-state-field-extraction-single-owner/
 * 50-test-matrix.md section D, rows D1-D9 (D3b/D8b/D8c included), plus the
 * multi-line-signature attribution regression the guard's own module header
 * documents (`buildFunctionInfo`'s `pendingDeclName` deferral).
 *
 * Fixtures use array `.join('\n')`, never an indented template literal —
 * indentation bleed would shift every asserted line number.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const drift = require('../scripts/lint-state-field-drift.cjs');
const { sanitizeForReport } = require('../scripts/lib/drift-scan.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const OWNER_RELPATH = drift.OWNER_FILE;
const OTHER_RELPATH = path.join('src', 'unrelated.cts');

// ─── D1: the real repo tree reports zero re-derivations ───────────────────

describe('D1 — scanRepo against the real repo tree', () => {
  test('guard reports zero on the consolidated tree', () => {
    // This is the guard's actual contract, exercised through its own
    // scanRepo tree-walk (not a synthetic fixture) — the test that fails
    // the day an eighth copy of the fallback chain lands anywhere in src/.
    const violations = drift.scanRepo(REPO_ROOT);
    assert.deepStrictEqual(violations, []);
  });
});

// ─── D2: the guard MUST be able to fail ────────────────────────────────────

describe('D2 — the guard must be able to fail', () => {
  test('guard catches a reintroduced ladder', () => {
    const text = [
      'function fmScalarLadder(fm, body) {',
      '  const v = fm.x;',
      "  if (typeof v === 'number' || typeof v === 'boolean') {",
      '    return String(v);',
      '  }',
      "  return stateExtractField(body, 'x');",
      '}',
    ].join('\n');

    const out = drift.findStateFieldDrift(text, OTHER_RELPATH);
    // A guard that cannot fail is worse than no guard: this fixture is a
    // synthetic re-derivation (coercion ladder + fallback call, same
    // function), and it MUST produce exactly one violation at the exact
    // line of the fallback call — not merely "an array".
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].line, 6);
    assert.match(out[0].found, /stateExtractField/);
  });
});

// ─── D3 / D3b: body-only case-variant chain, with and without a ladder ────

describe('D3 — body-only case-variant chain without a ladder is not drift', () => {
  test('body-only case-variant chain without a ladder is not drift', () => {
    const text = [
      'function noLadderFunction(body) {',
      "  const a = stateExtractField(body, 'Last Activity') ?? stateExtractField(body, 'Last activity');",
      '  return a;',
      '}',
    ].join('\n');

    // No ladder anywhere in this function — a bare case-variant fallback
    // chain over the body alone is not the derivation this guard owns.
    const out = drift.findStateFieldDrift(text, OTHER_RELPATH);
    assert.deepStrictEqual(out, []);
  });
});

describe('D3b — case-variant chain beside a ladder is drift', () => {
  test('case-variant chain beside a ladder is drift', () => {
    const text = [
      'function withLadderFunction(fm, body) {',
      '  const v = fm.status;',
      "  if (typeof v === 'number' || typeof v === 'boolean') {",
      '    // handled elsewhere in this same function',
      '  }',
      "  const a = stateExtractField(body, 'Last Activity') ?? stateExtractField(body, 'Last activity');",
      '  return a;',
      '}',
    ].join('\n');

    // The SAME case-variant chain, now inside a function that also bears
    // the coercion ladder — the function must route through the owner
    // instead of hand-rolling its own body-side fallback.
    const out = drift.findStateFieldDrift(text, OTHER_RELPATH);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].line, 6);
  });
});

// ─── D4: nested frontmatter object read is not drift ───────────────────────

describe('D4 — nested frontmatter read is not drift', () => {
  test('nested frontmatter read is not drift', () => {
    const text = [
      'function fmScalarKey(fm) {',
      '  const v = fm.nested ? fm.nested.key : undefined;',
      "  if (typeof v === 'number' || typeof v === 'boolean') {",
      '    return String(v);',
      '  }',
      '  return null;',
      '}',
    ].join('\n');

    // Ladder-bearing (the coercion ladder is present) but call-free — this
    // is the live smart-entry.cts `fmScalarKey` control case proving the
    // guard distinguishes "has a ladder" from "re-derives the fallback
    // chain": a ladder alone with no stateExtractField( call in the same
    // function is a different question and must stay silent.
    const out = drift.findStateFieldDrift(text, OTHER_RELPATH);
    assert.deepStrictEqual(out, []);
  });
});

// ─── D5: comment-awareness ──────────────────────────────────────────────────

describe('D5 — documented ladder in prose is not drift', () => {
  test('documented ladder in prose is not drift', () => {
    const text = [
      'function commented(fm, body) {',
      "  // typeof v === 'number' || typeof v === 'boolean' then stateExtractField(body, 'x')",
      '  /*',
      "   * typeof v === 'number' || typeof v === 'boolean'",
      "   * stateExtractField(body, 'x')",
      '   */',
      '  return null;',
      '}',
    ].join('\n');

    // Both a `//` line comment and a `/* */` block comment carry the exact
    // ladder + call text. ADR-3180 Amendment 3: a guard that reports prose
    // as drift trains readers to reflexively exempt documentation, so
    // scanCode must blank both before either detection regex runs.
    const out = drift.findStateFieldDrift(text, OTHER_RELPATH);
    assert.deepStrictEqual(out, []);
  });
});

// ─── D6 / D7: owner-file exemption is function-scoped, never file-scoped ──

describe('D6 — owner file is scanned; only named functions exempt', () => {
  test('owner file is scanned; only named functions exempt', () => {
    const text = [
      'function stateFieldValue(fm, body, fmKey, bodyField) {',
      '  const v = fm[fmKey];',
      "  if (typeof v === 'number' || typeof v === 'boolean') {",
      '    return String(v);',
      '  }',
      '  return stateExtractField(body, bodyField);',
      '}',
    ].join('\n');

    // The canonical owner function itself IS the derivation by
    // construction — it must stay silent when scanned under the real
    // owner relPath.
    const out = drift.findStateFieldDrift(text, OWNER_RELPATH);
    assert.deepStrictEqual(out, []);
  });
});

describe('D7 — a second copy inside the owner file is still caught', () => {
  test('a second copy inside the owner file is still caught', () => {
    // The exact Amendment-4 blind spot: a whole-file exemption on the
    // owner is precisely how getMilestoneInfo stayed invisible to an
    // earlier guard. FUNCTION_SCOPED_EXEMPTIONS must never let a SECOND,
    // unrelated re-derivation elsewhere in the SAME owner file go unseen.
    const text = [
      'function stateFieldValue(fm, body, fmKey, bodyField) {',
      '  const v = fm[fmKey];',
      "  if (typeof v === 'number' || typeof v === 'boolean') {",
      '    return String(v);',
      '  }',
      '  return stateExtractField(body, bodyField);',
      '}',
      '',
      'function stateFieldValueDuplicate(fm, body) {',
      '  const w = fm.other;',
      "  if (typeof w === 'number' || typeof w === 'boolean') {",
      '    return String(w);',
      '  }',
      "  return stateExtractField(body, 'other');",
      '}',
    ].join('\n');

    const out = drift.findStateFieldDrift(text, OWNER_RELPATH);
    // The canonical stateFieldValue (lines 1-7) stays silent; the
    // unrelated second copy (stateFieldValueDuplicate, lines 9-15) is
    // flagged — proving the exemption is keyed on FUNCTION NAME, not on
    // the whole file.
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].line, 14);
  });
});

describe('D6/D7 combined — the same line in a non-owner file is always reported', () => {
  test('the same canonical-shaped line outside the owner file is reported (no exemption applies)', () => {
    const text = [
      'function stateFieldValue(fm, body, fmKey, bodyField) {',
      '  const v = fm[fmKey];',
      "  if (typeof v === 'number' || typeof v === 'boolean') {",
      '    return String(v);',
      '  }',
      '  return stateExtractField(body, bodyField);',
      '}',
    ].join('\n');

    // FUNCTION_SCOPED_EXEMPTIONS is keyed on relPath === OWNER_RELPATH; a
    // function of the SAME name in a DIFFERENT file gets no exemption at
    // all.
    const out = drift.findStateFieldDrift(text, OTHER_RELPATH);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].line, 6);
  });
});

// ─── D8 / D8b: distance and attribution are per-function, not a window ────

describe('D8 — distance within a function is irrelevant', () => {
  test('distance within a function is irrelevant', () => {
    const filler = [];
    for (let i = 0; i < 40; i++) filler.push(`  // filler line ${i} — no ladder or call text here`);

    const text = [
      'function farApart(fm, body) {',
      '  const v = fm.x;',
      "  if (typeof v === 'number' || typeof v === 'boolean') {",
      '    return String(v);',
      '  }',
      ...filler,
      "  return stateExtractField(body, 'x');",
      '}',
    ].join('\n');

    // No fixed line-distance window anywhere in this detection — an
    // earlier draft used one and was rejected (ADR-3180 Decision 4(a)):
    // it produced "a zero it did not earn" on live copies further from
    // their ladder than any defensible line count. 40 filler lines here
    // proves the current shape has no such ceiling.
    const out = drift.findStateFieldDrift(text, OTHER_RELPATH);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].line, 5 + filler.length + 1);
  });
});

describe('D8b — a neighbouring function is not implicated', () => {
  test('a neighbouring function is not implicated', () => {
    const text = [
      'function ladderOwner(fm) {',
      '  const v = fm.x;',
      "  if (typeof v === 'number' || typeof v === 'boolean') {",
      '    return String(v);',
      '  }',
      '  return null;',
      '}',
      '',
      'function neighbour(body) {',
      "  return stateExtractField(body, 'x');",
      '}',
    ].join('\n');

    // The file, taken as a whole, carries BOTH a ladder and a
    // stateExtractField( call — but they sit in two DIFFERENT named
    // functions with no shared enclosing scope. Attribution is
    // per-function, not per-file, so neither function alone qualifies.
    const out = drift.findStateFieldDrift(text, OTHER_RELPATH);
    assert.deepStrictEqual(out, []);
  });
});

// ─── D8c: closure-scoped ladders (both real-world shapes) ─────────────────

describe('D8c — closure-scoped ladder is attributed correctly', () => {
  test('an arrow-function closure (const fmScalar = (...) => {...}) is attributed to its enclosing function', () => {
    const text = [
      'function cmdStateSnapshotLike(fm, body) {',
      '  const fmScalar = (key) => {',
      '    const v = fm[key];',
      "    if (typeof v === 'number' || typeof v === 'boolean') return String(v);",
      '    return null;',
      '  };',
      "  const status = fmScalar('status') ?? stateExtractField(body, 'Status');",
      '  return status;',
      '}',
    ].join('\n');

    const out = drift.findStateFieldDrift(text, OTHER_RELPATH);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].line, 7);

    // Attribution proof: the call line's innermost open frame is the
    // OUTER named function, not the closure (which has already closed by
    // that line) — and the ladder marks the outer frame transitively,
    // because the closure's body is lexically part of the outer
    // function's own body.
    const lines = text.split('\n');
    const { ladderBearing, innermostAt } = drift.buildFunctionInfo(lines);
    assert.strictEqual(innermostAt[6], 'cmdStateSnapshotLike'); // 0-indexed line 7
    assert.ok(ladderBearing.has('cmdStateSnapshotLike'));
  });

  test('a nested function-declaration closure (function fmScalar(...) {...}) is attributed to its enclosing function', () => {
    const text = [
      'function outerWithNestedFn(fm, body) {',
      '  function fmScalarNested(key) {',
      '    const v = fm[key];',
      "    if (typeof v === 'number' || typeof v === 'boolean') return String(v);",
      '    return null;',
      '  }',
      "  const status = fmScalarNested('status') ?? stateExtractField(body, 'Status');",
      '  return status;',
      '}',
    ].join('\n');

    const out = drift.findStateFieldDrift(text, OTHER_RELPATH);
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].line, 7);

    const lines = text.split('\n');
    const { ladderBearing, innermostAt } = drift.buildFunctionInfo(lines);
    assert.strictEqual(innermostAt[6], 'outerWithNestedFn'); // 0-indexed line 7
    assert.ok(ladderBearing.has('outerWithNestedFn'));
  });
});

// ─── Regression: multi-line function signature must not strand its frame ──
// buildFunctionInfo's module-header documents a real bug: FUNCTION_DECL_RE
// can match a line with no `{` at all (a signature spilling across several
// lines); pushing that frame immediately recorded `openDepth` at the
// ENCLOSING scope's depth rather than the function's own, so the frame could
// NEVER pop and silently misattributed every later top-level line to it.
// `pendingDeclName` defers the push to the line whose brace count actually
// increases. 229 functions across 76 files share this multi-line-signature
// shape, so this proof is load-bearing, not decorative.

describe('regression — a multi-line function signature does not strand its frame', () => {
  test('a ladder+call inside a function whose signature spans several lines is flagged and attributed there; a later top-level call is not', () => {
    const text = [
      'function preferNewerLike(',
      '  fm,',
      '  body,',
      '  fmKey',
      ')',
      '{',
      '  const v = fm[fmKey];',
      "  if (typeof v === 'number' || typeof v === 'boolean') {",
      '    return String(v);',
      '  }',
      '  return stateExtractField(body, fmKey);',
      '}',
      '',
      "stateExtractField(body, 'decoy');",
    ].join('\n');

    const out = drift.findStateFieldDrift(text, OTHER_RELPATH);
    // Only the in-function call (line 11) is flagged. If the frame had
    // been stranded open (the pre-fix bug), the decoy top-level call on
    // line 14 would ALSO be flagged — this assertion is the whole proof
    // the fix holds.
    assert.strictEqual(out.length, 1);
    assert.strictEqual(out[0].line, 11);

    const lines = text.split('\n');
    const { innermostAt } = drift.buildFunctionInfo(lines);
    assert.strictEqual(innermostAt[10], 'preferNewerLike'); // 0-indexed line 11
    assert.strictEqual(innermostAt[13], null); // 0-indexed line 14 — module scope, unattributed
  });
});

// ─── D9: report-output sanitization ────────────────────────────────────────
// `main()` sanitizes both a violation's file path and its matched fragment
// through `sanitizeForReport` (scripts/lib/drift-scan.cjs) before writing
// either to stderr — the exact boundary a fork-authored filename or source
// line reaches a CI log through. Direct coverage of the sanitizer itself,
// mirroring tests/plan-count-single-owner.test.cjs's `sanitizeForReport`
// describe block.

describe('D9 — report output is sanitized', () => {
  test('C0 control bytes are escaped', () => {
    assert.strictEqual(sanitizeForReport(String.fromCharCode(0x1b)), '\\x1b');
  });

  test('DEL (0x7f) is escaped', () => {
    assert.strictEqual(sanitizeForReport(String.fromCharCode(0x7f)), '\\x7f');
  });

  test('C1 control bytes are escaped', () => {
    assert.strictEqual(sanitizeForReport(String.fromCharCode(0x9b)), '\\x9b');
  });

  test('zero-width space (U+200B) is escaped', () => {
    assert.strictEqual(sanitizeForReport(String.fromCharCode(0x200b)), '\\u200b');
  });

  test('Unicode LINE SEPARATOR (U+2028) is escaped', () => {
    assert.strictEqual(sanitizeForReport(String.fromCharCode(0x2028)), '\\u2028');
  });

  test('Unicode PARAGRAPH SEPARATOR (U+2029) is escaped', () => {
    assert.strictEqual(sanitizeForReport(String.fromCharCode(0x2029)), '\\u2029');
  });

  test('a bidi RIGHT-TO-LEFT OVERRIDE (U+202E) is escaped', () => {
    assert.strictEqual(sanitizeForReport(String.fromCharCode(0x202e)), '\\u202e');
  });

  test('ordinary ASCII filename/fragment text passes through unchanged', () => {
    const text = "src/state-document.cts:296 stateExtractField(body, 'x')";
    assert.strictEqual(sanitizeForReport(text), text);
  });
});
