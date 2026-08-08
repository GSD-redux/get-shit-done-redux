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
 * `isInsideRoot`'s root-confinement check (used by the symlink-following
 * `walk`, below) is an EXACT string comparison, deliberately not
 * case-normalized. On a case-insensitive filesystem (macOS default; not CI,
 * which is ubuntu) a symlink whose target is a case-VARIANT of an in-root
 * path — a path the OS itself would still resolve to the same file — is
 * REJECTED by this exact comparison and silently left unscanned. This is a
 * fail-CLOSED miss (a re-derivation goes unreported), never an escape (never
 * a wrongly-admitted outside-root read), so it is left as-is: making the
 * comparison case-insensitive would WEAKEN confinement (a resolved path
 * merely case-differing from a sibling-of-root name, `/repo-Evil` vs
 * `/repo-evil`, could then be wrongly admitted) to fix a gap that only ever
 * under-reports on a platform this guard is not gated on.
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

const fs = require('node:fs');
const path = require('node:path');

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

// Longest regex literal this scanner will consider, in characters. Real
// plan/summary filename filters are far shorter; the bound is what keeps the
// scan linear. The tokenizer restarts at every `/` on the line (so that a
// literal preceded by a stray unpaired `/` is still found, matching the
// previous regex's "find anywhere" behaviour), which without a per-literal
// bound would be quadratic on a pathological line. With it the whole-line
// cost is O(n * MAX_REGEX_LITERAL_LEN) with no backtracking at all.
const MAX_REGEX_LITERAL_LEN = 400;

// The two tokens that, appearing together INSIDE one regex literal, make it a
// plan/summary filename filter. `\.md` is matched as literal source text, not
// as a pattern, so there is nothing here to backtrack.
const PLAN_SUMMARY_TOKEN_RE = /PLAN|SUMMARY/i;
const ESCAPED_MD_TOKEN = '\\.md';

// Authored TypeScript source only (the generated bin/lib/*.cjs mirror it).
const SCAN_DIRS = ['src'];
const SCAN_EXT = new Set(['.cts', '.ts', '.mts']);

// Directory names this scanner never descends into or reports out of —
// `.git` (repo internals, e.g. a persisted CI token in `.git/config`),
// `node_modules` (thousands of third-party files, none of them authored
// source), `dist` (build output). Named once and used at BOTH skip sites
// below: the cheap `entry.name` fast path in `walk`, and the resolved-path
// component check in `isUnderSkippedDir` — a symlink whose OWN name is not
// in this set but whose target resolves through a directory that IS (e.g.
// `src/g -> ../.git`, `src/nm -> ../node_modules`) must still be skipped, or
// the name-only check is a trivial bypass.
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', '.git']);

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
 * Read the JS regex literal starting at `line[start]` (which must be `/`).
 * Returns `{ text, end }` — `text` includes the delimiters and any trailing
 * flags, `end` is the index one past the literal — or null if no literal
 * closes within MAX_REGEX_LITERAL_LEN characters.
 *
 * Single left-to-right pass, no backtracking. It models the two constructs a
 * backtracking pattern gets wrong, which is why this is a tokenizer and not a
 * regex:
 *   - `\x` escapes consume BOTH characters, so an escaped `\/` never
 *     terminates the literal;
 *   - inside a `[...]` character class a bare `/` does NOT terminate, so
 *     `/PLAN[\\/].*\.md$/` is one literal rather than two fragments. The
 *     previous regex silently MISSED every re-derivation using a
 *     cross-platform path-separator class for exactly this reason.
 */
function readRegexLiteralAt(line, start) {
  if (line[start] !== '/') return null;
  const limit = Math.min(line.length, start + MAX_REGEX_LITERAL_LEN);
  let inClass = false;
  for (let i = start + 1; i < limit; i++) {
    const ch = line[i];
    if (ch === '\\') {
      i++; // escape consumes the next character, whatever it is
      continue;
    }
    if (ch === '\r' || ch === '\n') return null; // a literal cannot span lines
    if (ch === '[') {
      inClass = true;
    } else if (ch === ']') {
      inClass = false;
    } else if (ch === '/' && !inClass) {
      // Trailing flags are bounded by the SAME `limit` as the literal body
      // itself (not `line.length`) — a literal followed by an unbounded run
      // of lowercase letters must not make `text` grow past
      // MAX_REGEX_LITERAL_LEN either.
      let end = i + 1;
      while (end < limit && line[end] >= 'a' && line[end] <= 'z') end++;
      return { text: line.slice(start, end), end };
    }
  }
  return null;
}

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

// Symlinks report `isDirectory()`/`isFile()` as false on the Dirent from
// `readdirSync`, so a symlinked `src/*.cts` (or a symlinked directory
// containing one) was previously invisible to this scanner — an evasion of a
// guard whose stated design principle (ADR-3180 Decision 4a) is whole-repo
// discovery with no allowlist. Resolve each entry with `fs.statSync` (which
// follows symlinks) to classify it, skipping broken links. `ctx.visitedRealDirs`
// guards against a symlink cycle sending `walk` into infinite recursion.
//
// Every sibling drift guard in `scripts/` (`lint-phase-id-drift.cjs`,
// `lint-package-identity-drift.cjs`, `lint-portable-timeout.cjs`,
// `lint-test-file-count.cjs`, `lint-allow-test-rule-refs.cjs`) uses the
// `Dirent` classification straight off `readdirSync` and does NOT follow
// symlinks at all. This guard follows them so a symlinked `src/*.cts` cannot
// evade ADR-3180 Decision 4a's whole-repo discovery — root confinement
// (`isInsideRoot` below) is the price of doing so: without it, a symlink
// planted anywhere under `src/` could walk this scanner out to read and
// report arbitrary files elsewhere on disk.
//
// DIRECTORY vs FILE symlinks are confined to two DIFFERENT roots, tracked as
// `ctx.scanDirRoot` (the realpath of the current top-level SCAN_DIRS entry,
// e.g. `<realRoot>/src`) vs `ctx.realRoot` (the whole repo):
//   - a DIRECTORY symlink is descended ONLY if its resolved realpath is
//     inside `ctx.scanDirRoot` — NOT merely inside `ctx.realRoot`. Without
//     this, `src/up -> ..` (or `-> <realRoot>`) resolves inside the repo
//     root and `walk` descends the ENTIRE repo, reporting violations under
//     paths like `tests/not-src.cts` or `docs/other.cts` — files the header
//     above says the scan is scoped OUT of (`SCAN_DIRS`). This is a
//     deliberate, fail-CLOSED trade-off: a directory symlink pointing
//     elsewhere INSIDE the repo (but outside the scan directory) is simply
//     not followed. The alternative — descending it — is exactly the
//     whole-repo sweep this rule exists to prevent, and a fork PR could use
//     that sweep to redden `lint:ci` on files this guard was never meant to
//     read. The narrower rule is worth more than the missed edge case.
//   - a FILE symlink is still scanned if its resolved realpath is inside
//     `ctx.realRoot` (the whole repo, not just the scan directory) — this is
//     what keeps `src/alias.cts -> vendor/real.cts` covered (test (f)): an
//     aliased file genuinely is part of the compiled surface even when its
//     real target lives outside `src/`, and it is still reported under its
//     canonical (real) path.
//
// A resolved path is inside a root only if it IS that root or begins with
// root + separator — a plain `startsWith(root)` would also accept a sibling
// directory whose name merely starts with the root's name (`/repo-evil`).
function isInsideRoot(realPath, realRoot) {
  return realPath === realRoot || realPath.startsWith(realRoot + path.sep);
}

// True when `realPath` (already confirmed inside `realRoot` by `isInsideRoot`)
// resolves THROUGH a skip-list directory anywhere along its path relative to
// the root — not just when `realPath` itself IS one. This is what closes the
// symlink bypass the `entry.name` fast path alone cannot: `walk` tests
// `entry.name` (the symlink's OWN name in its parent directory), but a
// symlink named something innocuous can still RESOLVE into `.git` /
// `node_modules` / `dist` (`src/g -> ../.git`, `src/leak.cts ->
// ../.git/config`, `src/nm -> ../node_modules`) — `isInsideRoot` alone admits
// all three, because every one of those real paths is still under the root.
function isUnderSkippedDir(realPath, realRoot) {
  const rel = path.relative(realRoot, realPath);
  return rel.split(path.sep).some((segment) => SKIP_DIR_NAMES.has(segment));
}

function walk(dir, acc, ctx) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (SKIP_DIR_NAMES.has(entry.name)) continue; // cheap fast path
    let stat;
    try {
      stat = entry.isSymbolicLink() ? fs.statSync(full) : entry;
    } catch {
      continue; // broken symlink target
    }
    let realPath;
    try {
      realPath = fs.realpathSync(full);
    } catch {
      continue; // broken symlink target (race, or a link stat() followed but realpath cannot)
    }
    if (stat.isDirectory()) {
      // Directories (symlinked or real) are confined to the CURRENT scan
      // directory root, not merely the repo root — see the comment above
      // `isInsideRoot` for why (`src/up -> ..` whole-repo sweep).
      if (!isInsideRoot(realPath, ctx.scanDirRoot)) continue;
      if (isUnderSkippedDir(realPath, ctx.realRoot)) continue; // symlink resolves through a skipped dir
      if (ctx.visitedRealDirs.has(realPath)) continue; // symlink cycle guard
      ctx.visitedRealDirs.add(realPath);
      walk(full, acc, ctx);
    } else if (stat.isFile() && SCAN_EXT.has(path.extname(entry.name))) {
      // Files are confined to the whole repo root — a symlinked FILE whose
      // real target lives outside the scan directory but inside the repo
      // (e.g. `src/alias.cts -> vendor/real.cts`) is still part of the
      // compiled surface and must be scanned.
      if (!isInsideRoot(realPath, ctx.realRoot)) continue;
      if (isUnderSkippedDir(realPath, ctx.realRoot)) continue; // symlink resolves through a skipped dir
      if (ctx.visitedRealFiles.has(realPath)) continue; // two symlinks, same real file
      ctx.visitedRealFiles.add(realPath);
      acc.push(realPath);
    }
  }
  return acc;
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
  const violations = [];
  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    return violations; // root itself does not exist / is unreadable
  }
  for (const dir of SCAN_DIRS) {
    const scanDirPath = path.join(root, dir);
    let scanDirRoot;
    try {
      scanDirRoot = fs.realpathSync(scanDirPath);
    } catch {
      continue; // scan directory itself does not exist / is unreadable
    }
    const ctx = { realRoot, scanDirRoot, visitedRealDirs: new Set(), visitedRealFiles: new Set() };
    for (const file of walk(scanDirPath, [], ctx)) {
      // `file` is already the REAL path (walk pushes realPath, not the
      // symlink path), so `rel` is the file's single canonical location
      // regardless of which symlink reached it — this is what makes
      // FUNCTION_SCOPED_EXEMPTIONS/OWNER_FILE, which are keyed on the
      // repo-relative path, match consistently.
      const rel = path.relative(realRoot, file);
      if (rel === OWNER_FILE) continue;
      let text;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      for (const d of findPlanCountDrift(text, rel)) {
        violations.push({ file: rel, ...d });
      }
    }
  }
  return violations;
}

// Both a `found` fragment AND a reported file path are attacker-controlled
// source text on a fork PR (a repo can legally track a filename containing
// control bytes, so the path is exactly as attacker-controlled as the
// fragment — see the call sites in main() below), and both are written
// straight to a CI log. Replace C0/C1 control bytes (ANSI escapes included)
// with a visible \xNN, AND the non-Latin-1 formatting/bidi/line-separator
// codepoints below with \uNNNN, so a crafted literal or filename cannot
// rewrite the terminal rendering of the report or hide/reorder its own text:
//   - U+200B-U+200F: zero-width space/joiners and directional marks
//   - U+2028/U+2029: Unicode LINE SEPARATOR / PARAGRAPH SEPARATOR (line
//     breaks a `\n`-only log scan would not catch)
//   - U+202A-U+202E: bidi embedding/override controls (RLO etc.)
//   - U+2066-U+2069: bidi isolate controls
function sanitizeForReport(text) {
  return text
    // eslint-disable-next-line no-control-regex -- the control range IS the target
    .replace(/[\x00-\x1f\x7f-\x9f]/g, (c) => '\\x' + c.charCodeAt(0).toString(16).padStart(2, '0'))
    .replace(/[\u200B-\u200F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
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
