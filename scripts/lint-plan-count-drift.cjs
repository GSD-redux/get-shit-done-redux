#!/usr/bin/env node
'use strict';

/**
 * Anti-divergence drift guard for the live-plan-counting seam
 * (epic #3180, issue #3183, ADR-3180 "Planning Semantic Model Single Owner").
 *
 * `src/plan-scan.cts`'s `scanPhasePlans` is the SINGLE canonical owner of
 * live-plan/summary counting: which files on disk are a "plan", which are a
 * "summary", and how the two pair up. Every other module that reads a phase
 * directory and re-derives that filename grammar itself — `readdirSync(...)`
 * filtered by an inline `-PLAN.md` / `PLAN.md` / `-SUMMARY.md` / `SUMMARY.md`
 * pattern — is a re-derivation that can silently drift from the owner (the
 * exact failure class this epic removes; see #2349, #1988).
 *
 * Per ADR-3180 Decision 4(a) this guard discovers call sites by SCANNING THE
 * WHOLE `src/` TREE, not by consulting an allowlist of known files — an
 * allowlist only measures re-derivations in files someone remembered to
 * list, and a new call site added anywhere else would sail through silently.
 *
 * Detection is intentionally NARROW and mirrors the existing
 * `lint-phase-id-drift.cjs` precedent: a small, readable per-line regex pair
 * over authored TypeScript source, with a short, explicitly-named exemption
 * list — not a general-purpose AST/control-flow analysis. A line counts as a
 * re-derivation when it contains BOTH:
 *   (a) a filename-TEST operation — `.filter(`, `.test(`, `.match(`,
 *       `.exec(`, `.endsWith(`, `.startsWith(`, `.includes(`, `.some(`,
 *       `.every(`, or `===` — and
 *   (b) a plan/summary filename-suffix pattern, either a quoted literal
 *       ('-PLAN.md', 'PLAN.md', '-SUMMARY.md', 'SUMMARY.md') OR an unquoted
 *       regex literal that mentions PLAN or SUMMARY and `\.md` together
 *       (`/-PLAN\.md$/`, `/^PLAN-\d+.*\.md$/i`)
 * on the same source line. #3183 originally required (a) to be specifically
 * `.filter(` on the SAME line as the literal — that missed a regex-literal
 * predicate (`files.filter(f => /-PLAN\.md$/.test(f))`, no quotes) and a
 * predicate defined on one line and consumed by `.filter(` on another
 * (`const isPlan = f => f.endsWith('-PLAN.md'); … files.filter(isPlan)`).
 * Widening (a) to any filename-test operator — not just `.filter(` itself —
 * catches both: the predicate's OWN line already carries a qualifying test
 * operation (`.test(`/`.endsWith(`) alongside the literal, independent of
 * where `.filter(` ends up.
 *
 * KNOWN, ACCEPTED limits of a per-line textual scan (same tradeoff the
 * phase-id-drift guard documents): a re-derivation that filters via a
 * hand-rolled loop with none of the listed test operators (e.g. a manual
 * character-index scan), or one whose literal and test operator are split
 * across two DIFFERENT lines with no single line carrying both, is not
 * caught by this narrow shape. That is left to code review, not this regex.
 *
 * The tree-walk / root-confinement / regex-literal-tokenizer / sanitizer
 * machinery below is SHARED with `scripts/lint-milestone-window-drift.cjs`
 * (#3184) via `scripts/lib/drift-scan.cjs` — see that module for the
 * `isInsideRoot` case-sensitivity note, the `walk` symlink-confinement
 * rationale, and the `readRegexLiteralAt` tokenizer's ReDoS-avoidance
 * rationale. It is deliberately NOT duplicated here a second time (ADR-3180
 * Decision 4's own "Rejected" list: "let the new drift guard copy Phase 1's
 * tree-walk / root-confinement / sanitizer").
 *
 * A regex literal longer than MAX_REGEX_LITERAL_LEN (400) characters is not
 * read, and is therefore not caught. That bound is what keeps the scan
 * linear; no real plan/summary filename filter approaches it. The scan is
 * scoped to SCAN_DIRS (`src`) with SCAN_EXT (.cts/.ts/.mts) — 186 files and
 * 4,299 lines matching FILENAME_TEST_RE within SCAN_DIRS/SCAN_EXT as of this
 * commit, 43 of them holding 7 or more backslashes and one (`src/milestone.cts`)
 * holding 16. (Definition used, so this is reproducible: walk SCAN_DIRS
 * filtering by SCAN_EXT exactly as `walk` does, split each file on `\n`, and
 * count every line for which the exported `FILENAME_TEST_RE.test(line)` is
 * true — independent of whether a PLAN/SUMMARY literal is also present on
 * that line.) Those are the lines the old backtracking detector had to
 * survive, and the reason the detector is now a tokenizer.
 */

const path = require('node:path');
const driftScan = require('./lib/drift-scan.cjs');
const { readRegexLiteralAt, MAX_REGEX_LITERAL_LEN, isInsideRoot, sanitizeForReport, scanTree } = driftScan;

// A `.filter(` call on the line — the shape every current re-derivation uses
// to turn a directory listing into a plan-or-summary subset. Kept as its own
// export for back-compat / documentation; FILENAME_TEST_RE below is the
// broadened detector actually used (any filename-test operator, not just
// `.filter(`).
const FILTER_CALL_RE = /\.filter\(/;

// A filename-TEST operation: `.filter(`, `.test(`, `.match(`, `.exec(`,
// `.endsWith(`, `.startsWith(`, `.includes(`, `.some(`, `.every(`, or a
// strict-equality comparison. Any one of these on a line asking "is this
// filename a plan/summary" is a re-derivation, independent of whether the
// literal shows up as a `.filter(...)` predicate specifically.
const FILENAME_TEST_RE = /\.(?:filter|test|match|exec|endsWith|startsWith|includes|some|every)\(|===/;

// A quoted plan/summary filename-suffix literal: 'PLAN.md', '-PLAN.md',
// 'SUMMARY.md', or '-SUMMARY.md', single- or double-quoted (opening and
// closing quote must match).
const PLAN_SUMMARY_LITERAL_RE = /(['"])-?(?:PLAN|SUMMARY)\.md\1/;

// The two tokens that, appearing together INSIDE one regex literal, make it a
// plan/summary filename filter. `\.md` is matched as literal source text, not
// as a pattern, so there is nothing here to backtrack.
const PLAN_SUMMARY_TOKEN_RE = /PLAN|SUMMARY/i;
const ESCAPED_MD_TOKEN = '\\.md';

// Authored TypeScript source only (the generated bin/lib/*.cjs mirror it).
const SCAN_DIRS = ['src'];
const SCAN_EXT = new Set(['.cts', '.ts', '.mts']);

// The canonical owner defines the grammar; it is exempt by construction.
const OWNER_FILE = path.join('src', 'plan-scan.cts');

// core-utils.cts's canonical pairing rule (#1988/#2648): these three
// functions build/match `*-SUMMARY.md` CANDIDATE strings for a given plan —
// that IS the single pairing rule, not a re-derivation of it. Scoped to just
// these functions (not the whole file) so an unrelated re-derivation added
// elsewhere in core-utils.cts is still caught.
const CORE_UTILS_FILE = path.join('src', 'core-utils.cts');
const CORE_UTILS_EXEMPT_FUNCTIONS = new Set([
  'summaryCandidates',
  'countMatchedSummaries',
  'findUnsummarizedPlans',
  'findOrphanSummaries',
]);

// Per ADR-3180 Decision 4(a): NOT a bare file allowlist — each entry below is
// scoped to the SPECIFIC function asking a documented, different question
// (see the inline comment at each site), so an unrelated re-derivation added
// anywhere else in these same files is still caught. Mirrors the
// CORE_UTILS_EXEMPT_FUNCTIONS mechanism above, generalized per-file.
//
//   - audit.cts scanQuickTasks: scans a quick task's OWN directory
//     (`.planning/quick/<task>/`) for that ONE task's completion record —
//     not a phase directory's live-plan/summary counting question.
//   - gsd2-import.cts readTasksDir: reads a FOREIGN GSD-2 legacy project's
//     `tasks/` dir convention during a one-time import, not this project's
//     `.planning/phases/` layout at all.
//   - estimate-cli.cts collectCalibrationSamples: pairs a PLAN.md and a
//     SUMMARY.md by their identical `<stem>` to build an estimation
//     CALIBRATION sample (projected vs. actual token counts) — a stem-keyed
//     join for a statistics question, not a live-plan/completion count.
//     It intentionally does NOT use the canonical three-candidate pairing
//     rule (marker-swap / `-SUMMARY.md` / extended) or exclude superseded
//     plans — an unmatched or superseded plan simply yields no sample,
//     which is correct for calibration, not a live-completion determination.
//   - roadmap.cts cmdRoadmapAnnotateDependencies: matches a plan-ID token
//     out of an ALREADY-RENDERED ROADMAP.md checklist LINE OF TEXT
//     (`- [ ] 01-01-PLAN.md — …`), not a filesystem directory listing — it
//     can never diverge from scanPhasePlans's file-existence rule because it
//     never tests file existence at all.
//   - worktree-safety.cts defaultFindSummaryFiles: a recursive walk of the
//     ENTIRE `.planning/` tree (not a single phase directory) for a
//     pre-merge rescue of any `*SUMMARY.md` artifact, deliberately mirroring
//     the shell fallback's own `find … -name "*SUMMARY.md"` glob (quick.md,
//     #2296/#2070/#2838) byte-for-behaviour rather than the phase-scoped
//     plan-scan owner's root+nested rule — "rescue every summary before a
//     merge blows it away" is not a live-plan/completion count.
//   - verify.cts cmdValidateConsistency: the strict `-(\d{2})-PLAN\.md$`
//     match extracts a zero-padded SEQUENCE NUMBER from filenames the owner
//     (`allPlanFiles`) already classified as plans — it does not re-derive
//     "is this a plan", it answers a different, narrower question (does the
//     canonical 2-digit numbering sequence have a gap) that the owner's
//     boolean plan/summary classification cannot answer. See the extended
//     inline comment at that call site for the full Question 1/2/3 split.
const FUNCTION_SCOPED_EXEMPTIONS = new Map([
  [CORE_UTILS_FILE, CORE_UTILS_EXEMPT_FUNCTIONS],
  [path.join('src', 'audit.cts'), new Set(['scanQuickTasks'])],
  [path.join('src', 'gsd2-import.cts'), new Set(['readTasksDir'])],
  [path.join('src', 'estimate-cli.cts'), new Set(['collectCalibrationSamples'])],
  [path.join('src', 'roadmap.cts'), new Set(['cmdRoadmapAnnotateDependencies'])],
  [path.join('src', 'worktree-safety.cts'), new Set(['defaultFindSummaryFiles'])],
  [path.join('src', 'verify.cts'), new Set(['cmdValidateConsistency'])],
]);

// Optional `export ` modifier: `collectCalibrationSamples` (estimate-cli.cts)
// is declared `export function …` rather than a bare `function …`, and the
// function-boundary tracker below must still recognize it for its
// FUNCTION_SCOPED_EXEMPTIONS entry above to take effect.
const TOP_LEVEL_FUNCTION_RE = /^(?:export\s+)?function\s+([A-Za-z0-9_]+)\s*\(/;

/**
 * The regex literal on `line` that mentions PLAN or SUMMARY together with an
 * escaped `.md` suffix — e.g. `/-PLAN\.md$/`, `/^PLAN-\d+.*\.md$/i`,
 * `/-SUMMARY-\d+.*\.md$/i` — or null if there is none. Replaces the former
 * `REGEX_LITERAL_MD_RE`, which was both exponentially/cubically backtracking
 * (CodeQL js/redos; this guard runs in `lint:ci` on fork PRs) and unable to
 * see a `[\\/]` character class.
 */
function findRegexLiteralMdMatch(line) {
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== '/') continue;
    const literal = readRegexLiteralAt(line, i);
    if (!literal) continue;
    // Case-insensitive `\.md` test — the regex literal this replaced carried
    // the `i` flag, so `\.MD`/`\.Md` must still match. A lowercased-copy
    // `.includes()` preserves that behaviour without reintroducing a
    // backtracking regex.
    if (PLAN_SUMMARY_TOKEN_RE.test(literal.text) && literal.text.toLowerCase().includes(ESCAPED_MD_TOKEN)) {
      return literal.text;
    }
  }
  return null;
}

/**
 * Pure: find every unsanctioned plan/summary-filter re-derivation in `text`.
 * `relPath` is the repo-relative path, used both to report file:line and to
 * apply the narrow, function-scoped core-utils.cts exemption.
 * Returns [{ line, found }].
 */
function findPlanCountDrift(text, relPath) {
  const out = [];
  const lines = text.split('\n');
  const exemptFunctions = FUNCTION_SCOPED_EXEMPTIONS.get(relPath) || null;
  let currentFunction = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fnMatch = TOP_LEVEL_FUNCTION_RE.exec(line);
    if (fnMatch) currentFunction = fnMatch[1];

    if (!FILENAME_TEST_RE.test(line)) continue;
    const quoted = PLAN_SUMMARY_LITERAL_RE.exec(line);
    const found = quoted ? quoted[0] : findRegexLiteralMdMatch(line);
    if (!found) continue;

    if (exemptFunctions && exemptFunctions.has(currentFunction)) continue;

    out.push({ line: i + 1, found });
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
      return findPlanCountDrift(text, rel).map((d) => ({ file: rel, ...d }));
    },
  });
}

function main() {
  const root = path.join(__dirname, '..');
  const violations = scanRepo(root);
  if (violations.length === 0) {
    process.stdout.write('ok plan-count-drift: no unsanctioned plan/summary re-derivations outside plan-scan.cts\n');
    return;
  }
  process.stderr.write('plan-count-drift: independent re-derivation(s) of plan/summary filename filtering found.\n');
  process.stderr.write('Use src/plan-scan.cjs `scanPhasePlans` (or core-utils.cjs `getPhaseFileStats`, which now\n');
  process.stderr.write('sources plans/summaries from it) instead of re-deriving the -PLAN.md/-SUMMARY.md filter:\n');
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
  findPlanCountDrift,
  scanRepo,
  FILTER_CALL_RE,
  FILENAME_TEST_RE,
  PLAN_SUMMARY_LITERAL_RE,
  findRegexLiteralMdMatch,
  readRegexLiteralAt,
  MAX_REGEX_LITERAL_LEN,
  isInsideRoot,
  sanitizeForReport,
};
