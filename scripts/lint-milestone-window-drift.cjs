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
 * Owner file: `src/roadmap-parser.cts` DEFINES this grammar, but it is NOT
 * exempt as a whole file — that was the original design (a bare per-file
 * allowlist) and it closed off exactly the blind spot ADR-3180 Decision 4(a)
 * warns about: `getMilestoneInfo`, added later in this same owner file,
 * hand-rolled its own milestone-heading regex (issues #3171, #3197) and the
 * whole-file exemption made it invisible to this guard. The owner file is now
 * scanned like every other file in SCAN_DIRS; only its named canonical
 * functions are exempt (`FUNCTION_SCOPED_EXEMPTIONS`, keyed on `OWNER_FILE`),
 * each with a written reason — `isMilestoneShippedInRoadmap`,
 * `locateMilestoneHeadings`, `hasMilestoneSectioning`, and
 * `extractCurrentMilestoneScoped` (whose `anyMilestonePattern`/
 * `anyMilestoneOrDetails` locals compose `#{1,3}` with the `(?!Phase...)`/
 * marker alternations as part of the canonical implementation, not a copy of
 * it). `computeMilestoneSectionEnd` carries (a) and (b) on two DIFFERENT
 * lines (the heading-quantifier match and the version/marker test are two
 * separate statements) rather than one line carrying both, so this guard's
 * own documented per-line-scan limit means it never fires there and it needs
 * no listed exemption. An unrelated re-derivation added anywhere else
 * in this file — including inside a function added after this guard, such as
 * a future `getMilestoneInfo`-shaped one — is still caught.
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

// (a-bis) #3216: a LITERAL markdown heading anchor — `##`, `###`, … — as
// opposed to the `#{N,M}` quantifier token (a) above. `getMilestoneInfo`
// hand-rolled its milestone-heading match with a literal `^##` / `## ` rather
// than a quantifier, so token (a) alone reported a clean zero on a file that
// carried two live re-derivations (#3171, #3197). The negative lookahead for
// `{` keeps this from double-matching the quantifier form.
//
// A `#` run is far more common in source than `#{N,M}` (private-field sigils,
// colour literals, fragment URLs, prose), so this token is admitted ONLY
// inside a heading-MATCHER literal — a regex literal, or a string/template
// literal handed to `new RegExp(` — never a bare line match. A template that
// BUILDS a heading for output (`## ${version}`) is not a re-derivation of
// where a milestone's section begins, and conflating the two would flag every
// heading writer in the tree.
const LITERAL_HEADING_RUN_RE = /#{2,6}(?!\{)/;

// A line that constructs a regex from a string/template literal, which is what
// admits the `new RegExp(`^##…${escapedVer}…`)` shape while leaving ordinary
// heading-building templates alone.
const NEW_REGEXP_RE = /new\s+RegExp\s*\(/;

// (b2-bis) #3216: the `v(\d+(?:\.\d+)+)` version shape — a capturing group
// around the major, then a NON-capturing `(?:\.\d+)+` repeat. VERSION_TOKEN_RE
// cannot see it: after `v(` + `\d+` it requires a backslash next, and this
// shape has `(` there instead.
const VERSION_TOKEN_GROUPED_RE = /v\(\\{1,2}d\+\(\?:\\{1,2}\.\\{1,2}d\+\)\+\)/;

// (b3) #3216: an INTERPOLATED version placeholder — `${escapedVer}`,
// `${escapedVersion}`, `${version}`. A regex that interpolates its version
// spells no literal `v\d+\.\d+` anywhere, so (b) could never fire. Inside a
// heading-matcher literal, "a heading anchor plus an interpolated version" IS
// the milestone-heading shape the canonical `locateMilestoneHeadings`
// composes — and so is a copy of it.
const INTERPOLATED_VERSION_RE = /\$\{[A-Za-z0-9_.]*[Vv]er[A-Za-z0-9_.]*\}/;

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
//   - (Phase 11, #3309: `verify.cts`'s pre-migration `checkMilestonePrefixMismatches`
//     — formerly exempted here — was DELETED when `cmdValidateHealth` migrated
//     onto the rule table; its `sectionRx` walk relocated verbatim into
//     `planning-snapshot.cts`'s `buildRoadmapDeclaredPhasesField`, which needs
//     no exemption of its own: like the deleted function, its `sectionRx`
//     never carries token (b) as this guard defines it — no `(?!Phase`
//     lookahead, no marker-emoji pairing — so it was never a live match.)
//   - roadmap-parser.cts isMilestoneShippedInRoadmap: composes the heading
//     quantifier with the shipped/active MARKER check (via
//     isClosedMilestoneHeading) to answer "is THIS milestone version marked
//     shipped by the ROADMAP" — a documented, narrower question than
//     computeMilestoneSectionEnd/locateMilestoneHeadings' "where does it
//     end"/"which heading is it", not a copy of either.
//   - roadmap-parser.cts locateMilestoneHeadings: this literally IS the
//     canonical heading-locator this guard exists to protect (see the
//     function's own header comment) — every other module's heading lookup
//     is expected to call it, not re-express it.
//   - roadmap-parser.cts hasMilestoneSectioning: the canonical "does this
//     ROADMAP use milestone sectioning at all" predicate — a deliberately
//     WEAKER, version-agnostic composition of the same two tokens, owned
//     here per its own header comment so the milestone-heading vocabulary
//     has one home rather than a third hand-rolled copy in state.cts.
//   - roadmap-parser.cts extractCurrentMilestoneScoped: its
//     `anyMilestoneOrDetails`/`anyMilestonePattern` locals are the two
//     internal call sites the header comment already names as part of the
//     canonical implementation (composing `#{1,3}` with the
//     `(?!Phase...)`/marker alternations to find "the next milestone
//     boundary" while assembling the current-milestone window) — not
//     re-derivations of a question answered elsewhere.
//   - roadmap-parser.cts listMilestoneHeadings: #3216 (epic #3180 §7.2's
//     Scope amendment) — the version-AGNOSTIC sibling of
//     `locateMilestoneHeadings`, and the function that textually DEFINES
//     `MILESTONE_HEADING_LINE_SOURCE` (the one shared grammar constant both
//     it and `locateMilestoneHeadings` build their pattern from) in its own
//     source span. It is a named canonical function defining the grammar,
//     not a copy of it — replacing the third independent re-derivation the
//     widened guard found at `roadmap.cts:454`.
//   - planning-snapshot.cts buildMilestoneArchiveStatusField (Phase 11,
//     #3309): its `## <version>` heading scan reads `MILESTONES.md` — a
//     FLAT version registry, not `ROADMAP.md` — asking "which versions does
//     the registry already document", never "where does THIS milestone's
//     ROADMAP section begin/end" (`computeMilestoneSectionEnd`/
//     `locateMilestoneHeadings`'s own question). A different document, a
//     different question; not a re-derivation of ROADMAP windowing.
//   - health-diagnostic.cts computeMissingMilestoneVersions (Phase 11,
//     #3309): `applyRepairs` is not a `Rule` and is not handed a
//     `PlanningSnapshot` (see that file's header comment), so
//     `backfillMilestones` recomputes the IDENTICAL `MILESTONES.md`
//     heading-membership check `buildMilestoneArchiveStatusField` already
//     performs for the W018 rule's read side — same non-ROADMAP-windowing
//     question as that function, for the same reason.
const FUNCTION_SCOPED_EXEMPTIONS = new Map([
  [path.join('src', 'roadmap-command-router.cts'), new Set(['checkW021'])],
  [
    OWNER_FILE,
    new Set([
      'isMilestoneShippedInRoadmap',
      'locateMilestoneHeadings',
      'listMilestoneHeadings',
      'hasMilestoneSectioning',
      'extractCurrentMilestoneScoped',
    ]),
  ],
  [path.join('src', 'planning-snapshot.cts'), new Set(['buildMilestoneArchiveStatusField'])],
  [path.join('src', 'health-diagnostic.cts'), new Set(['computeMissingMilestoneVersions'])],
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
 * Strip comment text from a line before detection. A guard that fires on a
 * COMMENT — including a comment documenting that the code below uses the
 * canonical owner, or prose quoting this guard's own detector shapes — reports
 * prose as drift and trains readers to add exemptions for documentation.
 * Handles the three shapes that appear in this codebase: a whole-line
 * block-comment continuation (`*` or `/*` leading), a `//` line comment, and
 * a trailing `//` after code. Mirrors `lint-phase-enumeration-drift.cjs`'s
 * own copy (not shared — each guard applies it at a slightly different point
 * in its detection pipeline).
 *
 * Deliberately simple and conservative: it does not attempt full block-comment
 * state tracking across lines (this is a per-line scan, same tradeoff the
 * sibling guards document). A `//` inside a string literal would be stripped
 * early — accepted, because the effect is to UNDER-report on a pathological
 * line, never to over-report prose as drift.
 */
function stripComments(line) {
  const trimmed = line.trim();
  // Whole-line block comment or JSDoc continuation.
  if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) return '';
  // Trailing line comment after code.
  const idx = line.indexOf('//');
  return idx === -1 ? line : line.slice(0, idx);
}

/**
 * The first literal (regex OR quoted/backtick string) on `line` whose text
 * contains a HEADING_QUANTIFIER_RE match — the "smoking gun" fragment worth
 * reporting, mirroring `findRegexLiteralMdMatch`'s role in the sibling guard.
 * Falls back to a bounded, trimmed slice of the raw line when the tokens are
 * not both inside one located literal (not currently reachable against this
 * repo — see the header comment's per-file audit — but a fail-safe rather
 * than a thrown error if a future line splits them). Takes the RAW `line`
 * (not comment-stripped) so a reported fragment still shows the actual source
 * text — comment-stripping is applied only to the detection decision, never
 * to the reported fragment.
 */
/**
 * All heading-MATCHER literals on `line` — a regex literal always counts; a
 * quoted/backtick string literal counts only when `code` (the comment-stripped
 * line passed in from the caller) constructs a regex via `new RegExp(`. A
 * plain string/template literal that is not fed to `new RegExp(` is not a
 * matcher — most commonly a heading BUILT for output, not one matched against.
 */
function headingMatcherLiterals(line, code) {
  const out = [];
  const allowStrings = NEW_REGEXP_RE.test(code);
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    let literal = null;
    let isRegex = false;
    if (ch === '/') {
      literal = readRegexLiteralAt(line, i);
      isRegex = true;
    } else if (ch === "'" || ch === '"' || ch === '`') {
      literal = readStringLiteralAt(line, i);
    }
    if (!literal) continue;
    if (isRegex || allowStrings) out.push(literal.text);
    i = literal.end - 1;
  }
  return out;
}

function extractFragment(line) {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    let literal = null;
    if (ch === '/') literal = readRegexLiteralAt(line, i);
    else if (ch === "'" || ch === '"' || ch === '`') literal = readStringLiteralAt(line, i);
    if (!literal) continue;
    if (HEADING_QUANTIFIER_RE.test(literal.text) || LITERAL_HEADING_RUN_RE.test(literal.text)) return literal.text;
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

    const code = stripComments(line);
    if (!code.trim()) continue;

    const matcherLiterals = headingMatcherLiterals(line, code);
    const hasQuantifier = HEADING_QUANTIFIER_RE.test(code);
    const hasLiteralHeading = matcherLiterals.some((t) => LITERAL_HEADING_RUN_RE.test(t));
    if (!hasQuantifier && !hasLiteralHeading) continue;

    const anyVersionToken = VERSION_TOKEN_RE.test(code) || VERSION_TOKEN_GROUPED_RE.test(code);
    const isMilestoneWindowToken =
      PHASE_LOOKAHEAD_RE.test(code)
      || (anyVersionToken && MARKER_EMOJI_RE.test(code))
      || (hasLiteralHeading && (anyVersionToken || INTERPOLATED_VERSION_RE.test(code)));
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
      // symlinks before calling onFile), so this — and
      // FUNCTION_SCOPED_EXEMPTIONS above, also keyed on `rel` — match
      // consistently regardless of which symlink reached the file. The owner
      // file is NOT short-circuited here; it is scanned like every other
      // file, and only its named canonical functions are exempt (see
      // FUNCTION_SCOPED_EXEMPTIONS).
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
  stripComments,
  LITERAL_HEADING_RUN_RE,
  VERSION_TOKEN_GROUPED_RE,
  INTERPOLATED_VERSION_RE,
  headingMatcherLiterals,
};
