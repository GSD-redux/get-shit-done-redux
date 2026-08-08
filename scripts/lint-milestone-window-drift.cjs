#!/usr/bin/env node
'use strict';

/**
 * Anti-divergence drift guard for the milestone-WINDOWING seam
 * (epic #3180, issue #3184, ADR-3180 "Planning Semantic Model Single Owner").
 *
 * `src/roadmap-parser.cts` is the SINGLE canonical owner of "where does a
 * given milestone's ROADMAP section begin and end" — `computeMilestoneSectionEnd`,
 * `locateMilestoneHeadings`, and `isMilestoneBoundedInRoadmap`. Every other
 * module that hand-rolls a heading-level quantifier together with the
 * milestone-boundary shape (a non-Phase heading carrying a version token or a
 * shipped/active marker) is a re-derivation that can silently drift from the
 * owner — the exact defect class #2562 fixed in one copy and never reached
 * the other two (design doc: `currentMilestoneRawRanges::computeSectionEnd`
 * carried a "keep in sync" comment that was already evidence the risk was
 * known, not controlled).
 *
 * Per ADR-3180 Decision 4(a) this guard discovers call sites by SCANNING THE
 * WHOLE `src/` TREE, not by consulting an allowlist of known files — an
 * allowlist only measures re-derivations in files someone remembered to
 * list. Exemptions below are FUNCTION-SCOPED with a written reason, never a
 * bare file allowlist, mirroring `lint-plan-count-drift.cjs`'s precedent.
 *
 * Detection is intentionally NARROW, mirroring the plan-count-drift and
 * phase-id-drift precedents: a line is a re-derivation when it carries BOTH,
 * in ONE source line:
 *   (a) a markdown heading-level quantifier token — `#{N,M}`, e.g. `#{1,3}`,
 *       `#{2,3}`, `#{2,4}` — inside either a regex literal or a
 *       quoted/backticked string, AND
 *   (b) a milestone-window token: either the negative-lookahead phase
 *       exclusion (`(?!Phase` / `(?!Phase\s+\S)`) or the milestone
 *       boundary-marker set — a `v\d+\.\d+`-shaped version token appearing
 *       together with any of the ✅ 📋 🚧 shipped/active markers.
 * Token (b) is deliberately narrow: a PHASE-heading regex (`#{2,4}\s*Phase`)
 * carries (a) alone, constantly, throughout this codebase (phase-numbering,
 * plan-index, wave-scheduling call sites) and must NOT be flagged — it asks
 * "where is phase N's heading", a different, already-single-owned question
 * (#2121). Only a line that ALSO carries the milestone-boundary shape — the
 * one `computeMilestoneSectionEnd`/`locateMilestoneHeadings` compute — is a
 * candidate re-derivation of THIS derivation.
 *
 * Both `(a)` and `(b)` must be readable through JS regex-literal AND
 * string/template-literal escaping: the two pre-#3184 `state.cts`
 * re-derivations this design is modelled on were
 * `new RegExp(\`^#{1,3}\\s+(?!Phase\\s+\\S)...\`)` — i.e. the SAME source
 * text as a real `/.../ ` regex literal, just doubly backslash-escaped
 * because it lives inside a template literal. `HEADING_QUANTIFIER_RE` and
 * `PHASE_LOOKAHEAD_RE` match either escaping level unchanged (no backslash
 * appears inside `#{`/`}`/`(?!Phase`'s literal characters); `VERSION_TOKEN_RE`
 * explicitly tolerates ONE or TWO backslashes before each `d`/`.` for exactly
 * this reason. Regex-LITERAL boundaries (used only to extract a reportable
 * `found` fragment, never for detection itself, which tests the raw line) are
 * located via the shared `readRegexLiteralAt` tokenizer
 * (`scripts/lib/drift-scan.cjs`) — a single left-to-right, no-backtracking
 * pass — never a backtracking "find the regex literal" regex (CodeQL js/redos
 * runs on `lint:ci`; see that module's own header for the full rationale).
 * `readStringLiteralAt` below is the same style, written locally for
 * quoted/backticked strings (not shared — `lint-plan-count-drift.cjs` has no
 * equivalent need, since its own literal-bearing shape is regex-only).
 *
 * Owner file (exempt by construction): `src/roadmap-parser.cts` — it not only
 * DEFINES this grammar but composes `#{1,3}` with `(?!Phase...)`/marker
 * alternations at several internal call sites (`computeMilestoneSectionEnd`,
 * `locateMilestoneHeadings`, `extractCurrentMilestoneScoped`'s
 * `anyMilestonePattern`/`anyMilestoneOrDetails`) that are the canonical
 * implementation, not copies of it.
 *
 * The tree-walk / root-confinement / regex-literal-tokenizer / sanitizer
 * machinery is SHARED with `scripts/lint-plan-count-drift.cjs` via
 * `scripts/lib/drift-scan.cjs` (ADR-3180 Decision 4, design doc's own
 * "Rejected: let the new drift guard copy Phase 1's tree-walk /
 * root-confinement / sanitizer") — see that module for the `isInsideRoot`
 * case-sensitivity note, the `walk` symlink-confinement rationale, and the
 * `readRegexLiteralAt` ReDoS-avoidance rationale.
 *
 * KNOWN, ACCEPTED limits of a per-line textual scan (same tradeoff the
 * sibling drift guards document): a re-derivation whose `(a)`/`(b)` tokens
 * are split across two DIFFERENT lines with no single line carrying both is
 * not caught by this narrow shape, nor is one routed through dynamic
 * dispatch. That is left to code review and the design's identity test
 * (ADR-3180 Decision 4b/4c), not this regex.
 */

const path = require('node:path');
const driftScan = require('./lib/drift-scan.cjs');
const { readRegexLiteralAt, MAX_REGEX_LITERAL_LEN, sanitizeForReport, scanTree } = driftScan;

// (a) A markdown heading-level quantifier: `#{N,M}` — e.g. `#{1,3}`,
// `#{2,3}`, `#{2,4}`. Bounded to 1-2 digit levels (real Markdown headings
// never exceed level 6) so this stays a small, fixed, linear test — no
// unbounded quantifier, nothing for CodeQL js/redos to flag.
const HEADING_QUANTIFIER_RE = /#\{\d{1,2},\d{1,2}\}/;

// (b1) The negative-lookahead phase exclusion `computeMilestoneSectionEnd`/
// `locateMilestoneHeadings` use to skip `### Phase N: …` headings while
// scanning for the NEXT milestone boundary.
const PHASE_LOOKAHEAD_RE = /\(\?!Phase\b/;

// (b2) A `v\d+\.\d+`-shaped version token, tolerant of ONE or TWO backslash
// escaping levels (a bare regex literal carries `\d`/`\.` with a single
// backslash; a template-literal regex SOURCE string carries the SAME source
// text doubly-escaped, `\\d`/`\\.`, because the template literal's own
// backslash must itself be escaped in the .cts source) and an OPTIONAL
// capturing group immediately around the digit run (`v(\d+)\.\d+`, the shape
// `roadmap-command-router.cts`'s `MILESTONE_RE` actually uses to capture the
// major version number).
const VERSION_TOKEN_RE = /v\(?\\{1,2}d\+\)?\\{1,2}\.\\{1,2}d\+/;

// (b2) The milestone shipped/active marker set `isClosedMilestoneHeading`/
// `computeMilestoneSectionEnd` test for. `(b)` fires when this appears on the
// SAME line as a VERSION_TOKEN_RE match — a version token alone is not
// milestone-boundary-specific (plenty of non-heading code compares version
// strings), and a marker alone is not either (it can appear in unrelated
// prose-matching code); together, on one line, they are the boundary shape.
const MARKER_EMOJI_RE = /[✅📋🚧]/u;

// Authored TypeScript source only (the generated bin/lib/*.cjs mirror it).
const SCAN_DIRS = ['src'];
const SCAN_EXT = new Set(['.cts', '.ts', '.mts']);

// The canonical owner defines the grammar; it is exempt by construction (see
// header comment for why its OWN internal composition of these tokens is not
// a re-derivation).
const OWNER_FILE = path.join('src', 'roadmap-parser.cts');

// Per ADR-3180 Decision 4(a): NOT a bare file allowlist — each entry below is
// scoped to the SPECIFIC function asking a documented, DIFFERENT question, so
// an unrelated re-derivation added anywhere else in these same files is still
// caught. Mirrors `lint-plan-count-drift.cjs`'s FUNCTION_SCOPED_EXEMPTIONS
// mechanism.
//
//   - roadmap-command-router.cts checkW021: `MILESTONE_RE` CLASSIFIES a
//     single heading LINE as "is this a milestone heading, and if so what is
//     its major version" for the W021 phase/milestone-prefix-mismatch check
//     — it is a per-line classifier consumed one line at a time via
//     `content.split('\n')`, with no concept of a section END at all. It
//     never computes "where does this milestone's content stop" — the
//     question `computeMilestoneSectionEnd` answers — so it cannot diverge
//     from that computation; it answers a narrower, different question this
//     derivation does not own.
//   - verify.cts checkMilestonePrefixMismatches: `sectionRx` ENUMERATES
//     every milestone heading in the document to build a list of
//     `{version, start, end}` sections (each section's `end` is provisionally
//     "rest of document" until the NEXT heading is found, then backfilled) —
//     it is answering "what are ALL the milestone sections", to check every
//     phase against its OWN enclosing milestone, not "where does THIS ONE
//     milestone (the current/asserted one) end" — `computeMilestoneSectionEnd`
//     takes a single heading and returns a single boundary; this function
//     never calls anything with that shape. (Design brief named this
//     `cmdValidateConsistency` — the code actually lives in the sibling
//     function `checkMilestonePrefixMismatches`, called from
//     `cmdValidateHealth`; `cmdValidateConsistency` itself does not contain
//     `sectionRx`. Exempted here under its ACTUAL containing function.) Also:
//     `sectionRx` (`/^#{1,3}\s+(?:\[[^\]]{1,200}\]\s*)?.*v(\d+\.\d+)/gim`)
//     does not itself carry token (b) as this guard defines it (no
//     `(?!Phase` lookahead, no marker-emoji pairing) — this exemption
//     currently documents intent rather than suppressing a live match.
const FUNCTION_SCOPED_EXEMPTIONS = new Map([
  [path.join('src', 'roadmap-command-router.cts'), new Set(['checkW021'])],
  [path.join('src', 'verify.cts'), new Set(['checkMilestonePrefixMismatches'])],
]);

// Optional `export ` modifier, mirroring `lint-plan-count-drift.cjs`'s
// TOP_LEVEL_FUNCTION_RE — only a column-0 top-level `function` declaration
// updates the current-function tracker; a nested/arrow function does not
// reset it, matching every FUNCTION_SCOPED_EXEMPTIONS entry above (all
// top-level `function` declarations).
const TOP_LEVEL_FUNCTION_RE = /^(?:export\s+)?function\s+([A-Za-z0-9_]+)\s*\(/;

/**
 * Read the quoted or backtick-delimited string/template literal starting at
 * `line[start]` (which must be `'`, `"`, or `` ` ``). Returns `{ text, end }`
 * — `text` includes both delimiters, `end` is the index one past the literal
 * — or null if no matching close quote is found within MAX_REGEX_LITERAL_LEN
 * characters. Same single left-to-right, no-backtracking, escape-aware style
 * as the shared `readRegexLiteralAt` (`\x` escapes consume both characters,
 * so an escaped quote never terminates the literal early) — written locally
 * because `lint-plan-count-drift.cjs` has no equivalent need (its literal
 * shape is regex-only), so it does not belong in the shared module.
 */
function readStringLiteralAt(line, start) {
  const quote = line[start];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  const limit = Math.min(line.length, start + MAX_REGEX_LITERAL_LEN);
  for (let i = start + 1; i < limit; i++) {
    const ch = line[i];
    if (ch === '\\') {
      i++; // escape consumes the next character, whatever it is
      continue;
    }
    if (ch === '\r' || ch === '\n') return null; // a literal cannot span lines in this per-line scan
    if (ch === quote) return { text: line.slice(start, i + 1), end: i + 1 };
  }
  return null;
}

/**
 * The first literal (regex OR quoted/backtick string) on `line` whose text
 * contains a HEADING_QUANTIFIER_RE match — the "smoking gun" fragment worth
 * reporting, mirroring `findRegexLiteralMdMatch`'s role in the sibling guard.
 * Falls back to a bounded, trimmed slice of the raw line when the tokens are
 * not both inside one located literal (not currently reachable against this
 * repo — see the header comment's per-file audit — but a fail-safe rather
 * than a thrown error if a future line splits them).
 */
function extractFragment(line) {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    let literal = null;
    if (ch === '/') literal = readRegexLiteralAt(line, i);
    else if (ch === "'" || ch === '"' || ch === '`') literal = readStringLiteralAt(line, i);
    if (!literal) continue;
    if (HEADING_QUANTIFIER_RE.test(literal.text)) return literal.text;
    i = literal.end - 1; // resume scanning just past this literal
  }
  return line.trim().slice(0, MAX_REGEX_LITERAL_LEN);
}

/**
 * Pure: find every unsanctioned milestone-window re-derivation in `text`.
 * `relPath` is the repo-relative path, used both to report file:line and to
 * apply the narrow, function-scoped exemptions above.
 * Returns [{ line, found }].
 */
function findMilestoneWindowDrift(text, relPath) {
  const out = [];
  const lines = text.split('\n');
  const exemptFunctions = FUNCTION_SCOPED_EXEMPTIONS.get(relPath) || null;
  let currentFunction = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fnMatch = TOP_LEVEL_FUNCTION_RE.exec(line);
    if (fnMatch) currentFunction = fnMatch[1];

    if (!HEADING_QUANTIFIER_RE.test(line)) continue;
    const isMilestoneWindowToken = PHASE_LOOKAHEAD_RE.test(line) || (VERSION_TOKEN_RE.test(line) && MARKER_EMOJI_RE.test(line));
    if (!isMilestoneWindowToken) continue;

    if (exemptFunctions && exemptFunctions.has(currentFunction)) continue;

    out.push({ line: i + 1, found: extractFragment(line) });
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
      // symlinks before calling onFile), so this comparison — and
      // FUNCTION_SCOPED_EXEMPTIONS above, also keyed on `rel` — match
      // consistently regardless of which symlink reached the file.
      if (rel === OWNER_FILE) return [];
      return findMilestoneWindowDrift(text, rel).map((d) => ({ file: rel, ...d }));
    },
  });
}

function main() {
  const root = path.join(__dirname, '..');
  const violations = scanRepo(root);
  if (violations.length === 0) {
    process.stdout.write('ok milestone-window-drift: no unsanctioned milestone-window re-derivations outside roadmap-parser.cts\n');
    return;
  }
  process.stderr.write('milestone-window-drift: independent re-derivation(s) of milestone-window bounding found.\n');
  process.stderr.write('Use src/roadmap-parser.cjs `computeMilestoneSectionEnd` / `locateMilestoneHeadings` /\n');
  process.stderr.write('`isMilestoneBoundedInRoadmap` instead of re-deriving the milestone heading/boundary regex:\n');
  for (const d of violations) {
    // `d.file` is exactly as attacker-controlled as `d.found`: a repo can
    // legally track a filename containing control bytes / bidi overrides,
    // and it is a fork-PR-authored value reaching a CI log the same way the
    // matched literal does — sanitize it at the same reporting boundary.
    process.stderr.write(`  ${sanitizeForReport(d.file)}:${d.line}  ${sanitizeForReport(d.found)}\n`);
  }
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  findMilestoneWindowDrift,
  scanRepo,
  HEADING_QUANTIFIER_RE,
  PHASE_LOOKAHEAD_RE,
  VERSION_TOKEN_RE,
  MARKER_EMOJI_RE,
  OWNER_FILE,
  FUNCTION_SCOPED_EXEMPTIONS,
  readStringLiteralAt,
  extractFragment,
};
