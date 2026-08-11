#!/usr/bin/env node
'use strict';

/**
 * Anti-divergence drift guard for the completion-RATIO seam
 * (epic #3180, ADR-3180 "Planning Semantic Model Single Owner").
 *
 * `src/phase-lifecycle.cts`'s `clampPercent(completed, total)` /
 * `clampPercentFromFraction(fraction)` are the SINGLE canonical owner of
 * "turn a completed/total pair into an integer completion percentage,
 * clamped to 100". Until just before this guard was added, the identical
 * expression `total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0`
 * was hand-inlined at six call sites across five modules while the owner sat
 * exported and unused by them — the exact ADR-3180 divergence class, in a
 * derivation the epic had not previously named. Those six sites have been
 * migrated onto the owner; this guard is what stops a seventh copy.
 *
 * Per ADR-3180 Decision 4(a) this guard discovers call sites by SCANNING THE
 * WHOLE `src/` TREE, not by consulting an allowlist of known files — an
 * allowlist only measures re-derivations in files someone remembered to
 * list, and a new call site added anywhere else would sail through silently.
 *
 * DETECTION. A line is a re-derivation when ALL THREE hold, on that ONE
 * source line:
 *   (a) it calls one of the `Math.round(`/`Math.floor(`/`Math.trunc(`/
 *       `Math.ceil(` rounding family — MATH_ROUND_FAMILY_RE;
 *   (b) it SCALES by 100 — a `*` followed by optional whitespace then `100`
 *       at a word boundary — SCALE_100_RE;
 *   (c) it contains a DIVISION — an identifier/closing-bracket, optional
 *       whitespace, `/`, optional whitespace, an identifier/opening-paren —
 *       DIVISION_RE — AND that division's index in the line is EARLIER than
 *       the index of the `* 100` scale from (b).
 *
 * Clause (c)'s ORDERING requirement is the whole precision of this guard.
 * `(a / b) * 100` — divide FIRST, scale SECOND — is a percentage: the
 * completed/total-derived shape this guard exists to catch. `Math.round(n *
 * 100) / 100` — scale FIRST, divide SECOND — is a completely unrelated
 * idiom (2-decimal-place rounding of an already-fractional value) that
 * happens to share both a rounding call and a `* 100` token; it appears in
 * this repo at `src/eval.cts` and `src/commands.cts` and MUST stay
 * unflagged. Comparing leftmost-match indices (rather than merely testing
 * "does a division exist anywhere on the line") is what tells the two
 * idioms apart: this guard finds the EARLIEST division and the EARLIEST
 * `* 100` scale on the line and requires divIdx < scaleIdx, so a line with a
 * scale-then-divide shape (divIdx > scaleIdx, or no division at all) never
 * matches, regardless of what else is on the line.
 *
 * `Math.floor(Math.random() * 100)` carries (a) and (b) but no division
 * anywhere on the line (DIVISION_RE finds nothing, divIdx === -1) and is
 * correctly excluded by clause (c) alone.
 *
 * `src/context-utilization.cts`'s `Math.min(Math.round(ratio * 100), 100)`
 * is OUT OF SCOPE BY DOMAIN, not by exemption: it scales an
 * ALREADY-COMPUTED fraction (`ratio`, a context-window utilization figure —
 * unrelated to `.planning/` phase/plan completion) and there is no division
 * anywhere on that line either, so clause (c) excludes it the same way as
 * the `Math.random()` case above; it needs no FUNCTION_SCOPED_EXEMPTIONS
 * entry because it was never going to match.
 *
 * Every regex below is small, bounded, and has no nested/overlapping
 * quantifiers — each character class is followed by a fixed literal or a
 * single `\s*` run bounded by the next required literal, so there is
 * nothing for a backtracking engine to explore more than linearly.
 * `npm run lint:ci` runs CodeQL js/redos over this repo; mirrors the
 * ReDoS discipline of `lint-plan-count-drift.cjs` / `lint-milestone-window-drift.cjs`.
 *
 * The tree-walk / root-confinement / sanitizer machinery is SHARED with the
 * sibling drift guards via `scripts/lib/drift-scan.cjs` (ADR-3180 Decision 4)
 * — see that module for the `isInsideRoot` case-sensitivity note and the
 * `walk` symlink-confinement rationale. This guard's detection shape needs
 * no regex-LITERAL extraction (unlike the milestone-window guard), so it
 * does not use `readRegexLiteralAt`; the reported fragment is simply the
 * trimmed source line, bounded to MAX_REGEX_LITERAL_LEN characters.
 *
 * KNOWN, ACCEPTED limits of a per-line textual scan (same tradeoff the
 * sibling drift guards document): a re-derivation whose division and
 * `Math.round`/scale are split across two DIFFERENT lines with no single
 * line carrying all three tokens is not caught by this narrow shape, nor is
 * one routed through a helper that itself performs the division one call
 * away from the rounding. That is left to code review, not this regex.
 */

const path = require('node:path');
const driftScan = require('./lib/drift-scan.cjs');
const { MAX_REGEX_LITERAL_LEN, sanitizeForReport, scanTree } = driftScan;

// (a) The `Math.round`/`Math.floor`/`Math.trunc`/`Math.ceil` rounding family,
// called with an open paren. `\b` before `Math` keeps this from matching
// inside a longer identifier (e.g. `fooMath.round(` never occurs in this
// codebase, but the boundary costs nothing and documents intent).
const MATH_ROUND_FAMILY_RE = /\bMath\.(?:round|floor|trunc|ceil)\(/;

// (b) A `* 100` scale — a `*` operator, optional whitespace, then the
// literal digits `100` at a word boundary (so `*1000` or `*100.5` do not
// match a bare `100` inside a longer number).
const SCALE_100_RE = /\*\s*100\b/;

// (c) A division: an identifier character/closing-bracket (the end of the
// numerator expression), optional whitespace, `/`, optional whitespace, an
// identifier character/opening-paren (the start of the denominator
// expression). Deliberately does not try to distinguish this from a regex
// literal or a `//` comment — the detection window is a Math.round-family
// call on the same line, which neither idiom co-occurs with in practice, and
// keeping the class small is what keeps the regex non-backtracking.
const DIVISION_RE = /[A-Za-z0-9_$)\]]\s*\/\s*[A-Za-z0-9_$(]/;

// Authored TypeScript source only (the generated bin/lib/*.cjs mirror it).
const SCAN_DIRS = ['src'];
const SCAN_EXT = new Set(['.cts', '.ts', '.mts']);

// The canonical owner defines the ratio-to-percent grammar. It is NOT
// exempt as a whole file (ADR-3180 Decision 4(a) forbids bare file
// allowlists) — it is scanned like every other file in SCAN_DIRS, and only
// the two named functions below are exempt, each for a documented reason.
// An unrelated re-derivation added elsewhere in this same file (including a
// future one) is still caught.
const OWNER_FILE = path.join('src', 'phase-lifecycle.cts');

// Per ADR-3180 Decision 4(a): function-scoped, not a bare file allowlist.
//   - clampPercentFromFraction: `Math.min(100, Math.round(fraction * 100))`
//     IS the canonical fraction-to-percent kernel this guard exists to
//     protect, not a copy of it — every other caller in the tree is
//     expected to CALL this function rather than re-express its body.
//   - clampPercent: the canonical count-shaped entry point; it delegates to
//     `clampPercentFromFraction(completed / total)` rather than computing
//     `Math.round(...)` itself, so it is exempted for the same reason even
//     though its own line does not currently carry a Math.round-family call.
const FUNCTION_SCOPED_EXEMPTIONS = new Map([[OWNER_FILE, new Set(['clampPercent', 'clampPercentFromFraction'])]]);

// Optional `export ` modifier, matching the sibling guards' convention —
// only a column-0 top-level `function` declaration updates the
// current-function tracker.
const TOP_LEVEL_FUNCTION_RE = /^(?:export\s+)?function\s+([A-Za-z0-9_]+)\s*\(/;

/**
 * Pure: find every unsanctioned completion-ratio re-derivation in `text`.
 * `relPath` is the repo-relative path, used both to report file:line and to
 * apply the narrow, function-scoped owner exemptions above.
 * Returns [{ line, found }].
 */
function findCompletionRatioDrift(text, relPath) {
  const out = [];
  const lines = text.split('\n');
  const exemptFunctions = FUNCTION_SCOPED_EXEMPTIONS.get(relPath) || null;
  let currentFunction = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fnMatch = TOP_LEVEL_FUNCTION_RE.exec(line);
    if (fnMatch) currentFunction = fnMatch[1];

    if (!MATH_ROUND_FAMILY_RE.test(line)) continue;
    const scaleIdx = line.search(SCALE_100_RE);
    if (scaleIdx === -1) continue;
    const divIdx = line.search(DIVISION_RE);
    if (divIdx === -1 || divIdx >= scaleIdx) continue;

    if (exemptFunctions && exemptFunctions.has(currentFunction)) continue;

    out.push({ line: i + 1, found: line.trim().slice(0, MAX_REGEX_LITERAL_LEN) });
  }
  return out;
}

/**
 * Scan the authored source tree and return every unsanctioned re-derivation,
 * each annotated with the repo-relative file path.
 */
function scanRepo(root) {
  return scanTree({
    root,
    scanDirs: SCAN_DIRS,
    scanExt: SCAN_EXT,
    onFile(rel, text) {
      // `rel` is already the REAL (canonical) path (scanTree resolves
      // symlinks before calling onFile), so this — and
      // FUNCTION_SCOPED_EXEMPTIONS above, also keyed on `rel` — match
      // consistently regardless of which symlink reached the file.
      return findCompletionRatioDrift(text, rel).map((d) => ({ file: rel, ...d }));
    },
  });
}

function main() {
  const root = path.join(__dirname, '..');
  const violations = scanRepo(root);
  if (violations.length === 0) {
    process.stdout.write('ok completion-ratio-drift: no unsanctioned completed/total percent re-derivations outside phase-lifecycle.cts\n');
    return;
  }
  process.stderr.write('completion-ratio-drift: independent re-derivation(s) of completed/total percent found.\n');
  process.stderr.write('Use src/phase-lifecycle.cjs `clampPercent(completed, total)` (or `clampPercentFromFraction(fraction)`\n');
  process.stderr.write('when you already hold a fraction) instead of re-deriving Math.round((completed / total) * 100):\n');
  for (const d of violations) {
    // `d.file` is exactly as attacker-controlled as `d.found`: a repo can
    // legally track a filename containing control bytes / bidi overrides,
    // and it is a fork-PR-authored value reaching a CI log the same way the
    // matched line text does — sanitize it at the same reporting boundary.
    process.stderr.write(`  ${sanitizeForReport(d.file)}:${d.line}  ${sanitizeForReport(d.found)}\n`);
  }
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  findCompletionRatioDrift,
  scanRepo,
  MATH_ROUND_FAMILY_RE,
  SCALE_100_RE,
  DIVISION_RE,
  OWNER_FILE,
  FUNCTION_SCOPED_EXEMPTIONS,
  MAX_REGEX_LITERAL_LEN,
};
