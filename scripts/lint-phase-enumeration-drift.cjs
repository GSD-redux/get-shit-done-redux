#!/usr/bin/env node
'use strict';

/**
 * Anti-divergence drift guard for the PHASE-ENUMERATION seam (epic #3180,
 * issue #3185, ADR-3180 Decision 1 row "Phase enumeration").
 *
 * `src/phase-locator.cts` is the SINGLE canonical owner of "which phase
 * directories belong to the current milestone" — `listMilestonePhaseDirs`.
 * `src/phase-id.cts` is the SINGLE canonical owner of "is this phase id a
 * reserved sentinel (Phase 0 / Phase 999.x)" — `isSentinelPhaseId` /
 * `SENTINEL_RANGES`. Before these existed the derivation had four
 * independent implementations, and the sentinel rule had five copies across
 * three different regexes that disagreed about Phase 0 (see
 * `listMilestonePhaseDirs`'s own doc comment). Every other module that
 * hand-rolls a `readdirSync` over the phases directory, or hand-rolls a
 * `999`-shaped sentinel test, is a re-derivation that can silently drift
 * from one of these two owners — the same generative-fix-divergence class
 * `lint-plan-count-drift.cjs` and `lint-milestone-window-drift.cjs` exist to
 * remove, now applied to the phase-enumeration seam.
 *
 * Per ADR-3180 Decision 4(a) this guard discovers call sites by SCANNING THE
 * WHOLE `src/` TREE, not by consulting an allowlist of known files — an
 * allowlist only measures re-derivations in files someone remembered to
 * list. Exemptions below are FUNCTION-SCOPED with a written reason, never a
 * bare file allowlist, mirroring `lint-plan-count-drift.cjs`'s and
 * `lint-milestone-window-drift.cjs`'s precedent.
 *
 * TWO INDEPENDENT DETECTORS. A line matching EITHER is a violation:
 *
 *   DETECTOR 1 (enumeration): a single source line carrying BOTH
 *     (a) `readdirSync`, AND
 *     (b) a phases-directory token — the identifier `phasesDir`, or a
 *         quoted/backticked `'phases'` string.
 *   This is the shape every consumer used before routing through the owner.
 *
 *   DETECTOR 2 (sentinel): a single source line carrying a sentinel-range
 *   literal outside the owner —
 *     - a bare `999` inside a regex literal or a quoted/backticked string
 *       (e.g. `/^999\b/`, `/^999(?:\.|$)/`, `'999'`), OR
 *     - a numeric comparison against 999 (`=== 999`, `== 999`, `!== 999`),
 *       or a bare reference to `SENTINEL_RANGES` outside its owner.
 *   Deliberately NARROW, mirroring the sibling guards' token discipline: the
 *   `999` must be a STANDALONE digit run (no digit immediately before or
 *   after it, inside the literal or right after the comparison operator), so
 *   unrelated arithmetic (`total + 1999`, `=== 9990`) never fires — only a
 *   line that actually spells the reserved sentinel value fires.
 *
 * Owner files (exempt by construction — each not only DEFINES its half of
 * the grammar but composes it at internal call sites that are the canonical
 * implementation, not copies of it):
 *   - `src/phase-locator.cts` — defines `listMilestonePhaseDirs`, the
 *     enumeration owner, and legitimately calls `readdirSync` on the phases
 *     dir inside it.
 *   - `src/phase-id.cts` — defines `isSentinelPhaseId` and
 *     `SENTINEL_RANGES`, the sentinel owner.
 *
 * FUNCTION-SCOPED EXEMPTIONS (per ADR-3180 Decision 4(a) — a written reason,
 * never a bare file allowlist, so an unrelated re-derivation added anywhere
 * ELSE in these same files is still caught). Generalizing #3183's rule ("a
 * diagnostic about file NAMING wants the physical set; only a question about
 * outstanding WORK wants the live set"): a LOOKUP, DIAGNOSTIC or ARCHIVAL
 * pass wants the physical set; only "which phases belong to this milestone"
 * wants the scoped set.
 *   - `src/roadmap.cts` `cmdRoadmapAnalyze` — MIGRATED (#3882, ADR-3473 §8.2):
 *     `_phaseDirNames`, a heading->directory LOOKUP INDEX (not a milestone
 *     enumeration; must see the PHYSICAL set so a heading already scoped by
 *     `extractCurrentMilestoneScoped` can find its directory), now calls
 *     `listAllPhaseDirs(phasesDir, { includeSentinels: true })` instead of a
 *     hand-rolled `readdirSync` — no longer exempted, since there is nothing
 *     left in this function for either detector to catch.
 *   - `src/init.cts` `cmdInitMilestoneOp`'s `diskPhaseDirs` — MIGRATED (#3882,
 *     ADR-3473 §8.2): the same heading->directory LOOKUP INDEX shape as
 *     `cmdRoadmapAnalyze`'s `_phaseDirNames` above, now calls
 *     `listAllPhaseDirs(phasesDir, { includeSentinels: true })`. Its sibling
 *     readdirSync (the no-ROADMAP-headings-found fallback) was already routed
 *     through `listMilestonePhaseDirs` before this phase and remains so — no
 *     longer exempted; the function's other former exemption reason
 *     (`detectHasPriorPhases`/`detectUiPhaseActive`, unrelated call sites in
 *     the same file) is unaffected.
 *   - `src/verify.cts` `cmdValidateHealth`: a project-wide HEALTH-CHECK sweep
 *     (config drift, phase-directory naming, duplicate-directory collisions,
 *     unsummarized-plan detection) — same "sweep everything, report gaps"
 *     shape as `collectDiskPhases` and the `audit.cts` scanners; it must see
 *     every phase directory regardless of milestone window to catch a
 *     naming/duplicate defect wherever it lives.
 *   - `src/verify.cts` `cmdVerifySchemaDrift`: resolves ONE caller-supplied
 *     `phase` argument to its directory (falling back to an exact-name
 *     match) — a single-phase LOOKUP, not a current-milestone enumeration.
 *   - `src/init.cts` `detectHasPriorPhases`: answers "has this project EVER
 *     completed a phase", explicitly excluding the current one. A history
 *     probe across all milestones, not a current-milestone enumeration.
 *   - `src/init.cts` `detectUiPhaseActive`: its `readdirSync` targets a
 *     SINGLE already-resolved phase directory's own FILES
 *     (`phases/<dirName>`) to check for a `*-UI-SPEC.md` file — not the
 *     phases directory itself. It never enumerates which phases exist at
 *     all, so it is not this derivation, only shaped like it textually.
 *   - `src/init.cts` `cmdInitMilestoneOp`: `diskPhaseDirs` is a heading->
 *     directory LOOKUP INDEX (same role as `cmdRoadmapAnalyze`'s
 *     `_phaseDirNames` below) — the ROADMAP heading scan just above it
 *     already scopes `roadmapPhaseNumbers` to the current milestone, so this
 *     map must see the PHYSICAL set to resolve each heading's phase number
 *     to its actual directory name; scoping it again would look up inside
 *     an already-scoped set for no benefit. Its sibling readdirSync (the
 *     no-ROADMAP-headings-found fallback, where there is no heading scope
 *     to look inside) is a real current-milestone enumeration and is routed
 *     through the owner, not exempted.
 *   - `src/milestone.cts` `archivePhaseDirectories`: archival MOVES the
 *     physical set. Scoping it would silently leave out-of-window
 *     directories behind in the live tree.
 *   - `src/milestone.cts` `cmdMilestoneComplete`: its one remaining
 *     unrouted readdirSync (`phaseDirEntries`, the unstarted-phase guard)
 *     is a token-match LOOKUP against ROADMAP headings already scoped by
 *     `sliceMilestoneWindow`/`extractCurrentMilestone` above it — same
 *     "physical set feeds an already-scoped lookup" shape as
 *     `cmdRoadmapAnalyze`'s `_phaseDirNames`. Its three OTHER former
 *     readdirSync call sites (the stats aggregation, the dry-run archive
 *     preview, and the real archive-move loop) all genuinely asked "which
 *     phases belong to the current milestone" and are routed through the
 *     owner with the resolved `version` as `versionOverride`.
 *   - `src/milestone.cts` `cmdPhasesClear`: a destructive CLEAR that must
 *     remove every live phase directory except sentinels, regardless of
 *     milestone window — `new-milestone` runs this to wipe the ENTIRE
 *     phases tree before starting fresh, not just the outgoing milestone's
 *     slice. Scoping it to one milestone's window would silently leave
 *     out-of-window directories behind instead of clearing/archiving them.
 *   - `src/phase.cts` `cmdPhasesList`: its `--phase <n>` lookup and
 *     `--include-archived` merge are phase LOCATION and archive
 *     enumeration, not current-milestone enumeration; both legitimately
 *     read the physical set. Its ENUMERATION path routes through the owner.
 *   - `src/roadmap-parser.cts` `getMilestonePhaseFilter` and its shared
 *     set-building implementation `scanMilestonePhaseIdSets` (the public
 *     `scanMilestonePhaseIds` wrapper remains a directly iterable Set; the
 *     same two heading/
 *     #3577 `collectTablePhaseRows` — the table-scan sibling feeding the same
 *     membership set; its local 999-only exclusion mirrors the owner's
 *     deliberate NOT-isSentinelPhaseId choice (a leading 0 is a real decimal
 *     phase, #2554), so it cannot route through the sentinel owner either).
 *     bullet scans, lifted verbatim so the `roadmap milestone-scope` probe
 *     reads the identical derivation): both deliberately use the local
 *     `999`-only literal, NOT `isSentinelPhaseId`. That canonical predicate
 *     additionally treats a leading `0` as sentinel milestone 0 (via its
 *     `/^0*(\d+)/` backtrack), which would swallow #2554's decimal phase ids
 *     ("00.1" is a real phase, not milestone 0). This scan asks a narrower
 *     question — "which phase ids does this milestone's window declare" —
 *     where only the 999 icebox range is excluded.
 *   - `src/state.cts` `countRoadmapPhaseHeadings`: its bracket branch composes
 *     bracket-milestone sentinel detection through `isSentinelPhaseId`, but
 *     retains a separate bare-token `999` rule. That rule intentionally does
 *     NOT use the convention-blind canonical predicate: the latter also reads
 *     leading `0`/`00.1` as milestone-0 sentinels, while a legacy-spelled bare
 *     zero token inside an opted-in bracket project is a real mid-migration
 *     phase. This is the state-counter twin of the roadmap-parser exemption.
 *     The guard has no per-detector exemption scope: it ORs the enumeration
 *     and sentinel detectors before consulting this function-only map. The
 *     whole-function exemption is therefore accepted; it is bounded because
 *     this counter performs no phases-directory `readdirSync` and needs the
 *     exemption only for its intentional bare-token `999` sentinel literal.
 *   - `src/state.cts` `cmdStateValidate` ("Gate 1: Validate STATE.md against
 *     filesystem"): resolves ONE directory — the disk match for STATE.md's
 *     own `Current Phase` field — by prefix, a single-phase LOOKUP, not an
 *     enumeration of the current milestone's phase set.
 *   - `src/state.cts` `cmdStateSync` ("Gate 2: Sync STATE.md from filesystem
 *     ground truth"): a ground-truth RECONCILIATION pass, same family as
 *     `collectDiskPhases` below — it deliberately scans every phase
 *     directory on disk (minus #1514 retired-phase exclusion) so STATE.md's
 *     rewritten counters reflect the true disk state, not a re-derivation of
 *     "which phases belong to the current milestone" the way its sibling
 *     `buildStateFrontmatter` computes (that one IS routed through the
 *     owner, scoped to the stored milestone, because it exists specifically
 *     to answer the milestone-scoped question at STATE.md construction
 *     time).
 *   - `src/state.cts` `cmdStateRebuild`: its nested `phaseInventoryProvider`
 *     deliberately does NOT route through `listMilestonePhaseDirs`. `state
 *     rebuild` is a RECONCILIATION pass against ground truth — it must see
 *     every phase directory on disk so an orphan STATE.md row for a phase
 *     that no longer exists (or sits outside the current milestone window) is
 *     dropped. Scoping this enumeration would make the rebuild silently
 *     preserve stale rows instead of dropping them, and a non-`readdirSync`-
 *     shaped owner call also cannot propagate the original fault message the
 *     #3057 B1 contract requires to surface verbatim.
 *   - `src/phase.cts` `cmdPhaseNextDecimal`: computes the next free decimal
 *     sub-phase id (e.g. `2.3`) by scanning EVERY on-disk directory and the
 *     WHOLE ROADMAP (not milestone-scoped) for existing `2.N` ids — an id
 *     collision it must avoid can come from any milestone, so it needs the
 *     physical set, matching the CREATE-adjacent exemption category.
 *   - `src/phase.cts` `cmdPhasePlanIndex`: resolves ONE caller-supplied
 *     `phase` id to its directory — a single-phase LOCATION lookup, not an
 *     enumeration of the current milestone's phase set.
 *   - `src/phase.cts` `cmdPhaseInsert`: the same next-free-decimal-id scan as
 *     `cmdPhaseNextDecimal` (id collisions can come from any milestone),
 *     immediately followed by creating the new phase directory — a CREATE
 *     operation, physical set by definition.
 *   - `src/phase.cts` `renameDecimalPhases`, `renameIntegerPhases`: RENAME
 *     mutations. Each `readdirSync` targets a SINGLE just-renamed phase
 *     directory's own FILES (`phasesDir/newDirName`) to rename the files
 *     inside it to match — not an enumeration of the phases directory at
 *     all; only shaped like one because `phasesDir` is a substring of the
 *     joined path.
 *   - `src/audit.cts` `listAuditPhaseTargets` (#3458): the shared active-root
 *     enumeration for the pre-milestone-close audit gate (`gsd-tools.cjs
 *     audit-open`, called by `/gsd:complete-milestone`'s pre-close gate).
 *     `scanUatGaps`, `scanVerificationGaps`, `scanContextQuestions`, and
 *     `scanDeferredItems` used to each hand-roll this same readdirSync
 *     independently (four copies of one re-derivation — the very drift class
 *     this guard exists to catch); #3458 consolidated all four into this one
 *     function, so the exemption moved with the call site instead of
 *     multiplying. It deliberately SWEEPS EVERY phase directory on disk to
 *     report open UAT/VERIFICATION/CONTEXT/deferred-item gaps — the audit's
 *     whole purpose is catching stragglers before a milestone closes, so
 *     scoping it to the current milestone's window would hide exactly the
 *     drift (e.g. a still-open item in a phase that somehow fell outside the
 *     window) it exists to surface.
 *   - `src/roadmap-upgrade.cts` `computeMigrationPlan`: a legacy-id-to-
 *     milestone-prefixed-id MIGRATION. It must see and rename EVERY existing
 *     phase directory across every milestone in one pass (a legacy phase
 *     number can legitimately collide across milestones — that ambiguity is
 *     exactly what the migration resolves) — the physical set by definition.
 *   - `src/smart-entry.cts` `detectVerifyFailed`: resolves ONE phase — the
 *     current phase from STATE.md, falling back to the highest-numbered
 *     directory when STATE.md has none — to check its own verify/UAT
 *     artifacts. A single-phase LOOKUP (with an explicit fallback rule of
 *     its own), not a current-milestone enumeration.
 *   - `src/commands.cts` `cmdHistoryDigest`: explicitly builds `allPhaseDirs`
 *     as archived-milestone dirs (via `getArchivedPhaseDirs`) PLUS every
 *     live phase directory, to produce a project-wide historical digest
 *     spanning every milestone ever shipped — the union is a strict
 *     superset of any one milestone's window by design; scoping the live
 *     half would silently drop history the digest exists to preserve.
 *   - `src/planning-snapshot.cts` `buildAllPhaseDirNamesField` (Phase 11,
 *     #3309): the un-windowed twin of `phaseDirs`/`listMilestonePhaseDirs` —
 *     every directory actually present under the active `phases/` root,
 *     UNFILTERED by current-milestone-window membership. Backs the migrated
 *     `cmdValidateHealth`'s W007 rule ("an on-disk phase directory has no
 *     matching ROADMAP entry"): sourcing that check from the WINDOWED owner
 *     would make it structurally unable to fire on the exact orphan
 *     directory it exists to find (an orphan-by-definition can never be a
 *     member of a set defined as "directories the roadmap already
 *     declares") — see that field's own doc comment on `PlanningSnapshot`
 *     for the full, empirically-verified rationale. Same "must see the
 *     physical set by definition" shape as `collectDiskPhases`/
 *     `cmdValidateHealth` above, generalized from a raw `readdirSync` call
 *     site to a dedicated snapshot-builder function.
 *
 * The tree-walk / root-confinement / regex-literal-tokenizer / sanitizer
 * machinery is SHARED with the sibling drift guards via
 * `scripts/lib/drift-scan.cjs` (ADR-3180 Decision 4) — see that module for
 * the `isInsideRoot` case-sensitivity note, the `walk` symlink-confinement
 * rationale, and the `readRegexLiteralAt` ReDoS-avoidance rationale.
 * `readStringLiteralAt` below is the same style, written locally for
 * quoted/backticked strings, mirroring `lint-milestone-window-drift.cjs`'s
 * own local copy (not shared — each guard's literal-bearing shape differs).
 *
 * KNOWN, ACCEPTED limits of a per-line textual scan (same tradeoff the
 * sibling drift guards document): a re-derivation whose detector tokens are
 * split across two DIFFERENT lines with no single line carrying both is not
 * caught by this narrow shape. That is left to code review and the design's
 * identity tests, not this regex.
 */

const path = require('node:path');
const driftScan = require('./lib/drift-scan.cjs');
const { readRegexLiteralAt, MAX_REGEX_LITERAL_LEN, sanitizeForReport, scanTree } = driftScan;

// (1a) The enumeration primitive itself.
const READDIR_SYNC_RE = /readdirSync/;

// (1b1) The phases-directory identifier every routed call site used to bind
// its `readdirSync` target to.
const PHASES_DIR_ID_RE = /\bphasesDir\b/;

// (1b2) A quoted/backticked `'phases'` string — the other shape a phases-dir
// path segment takes at a call site that builds the path inline instead of
// through a `phasesDir` local.
const PHASES_STRING_RE = /['"`]phases['"`]/;

// (2b) A numeric comparison against the sentinel value, or a bare reference
// to the owner's exported range constant used outside the owner. The digit
// run is anchored on both sides (`\b`, and no digit can precede it inside
// the `\s*` gap immediately after the operator) so `=== 9990` / `=== 19999`
// never fire — only the standalone value `999` does.
const SENTINEL_COMPARISON_RE = /(?:===|==|!==)\s*999\b|\bSENTINEL_RANGES\b/;

// A standalone `999` inside an already-located literal's text: no digit
// immediately before or after, so `1999`/`9990`/`19999` inside a string or
// regex literal never fire — only the literal spelling of the reserved
// sentinel value does.
const STANDALONE_999_RE = /(?<!\d)999(?!\d)/;

// Authored TypeScript source only (the generated bin/lib/*.cjs mirror it).
const SCAN_DIRS = ['src'];
const SCAN_EXT = new Set(['.cts', '.ts', '.mts']);

// The two canonical owners; each defines and internally composes its half
// of the grammar and is exempt by construction (see header comment).
const OWNER_FILES = new Set([
  path.join('src', 'phase-locator.cts'),
  path.join('src', 'phase-id.cts'),
]);

// Per ADR-3180 Decision 4(a): NOT a bare file allowlist — each entry below
// is scoped to the SPECIFIC function asking a documented, DIFFERENT
// question, so an unrelated re-derivation added anywhere else in these same
// files is still caught. Mirrors `lint-plan-count-drift.cjs`'s and
// `lint-milestone-window-drift.cjs`'s FUNCTION_SCOPED_EXEMPTIONS mechanism.
// See the header comment for the full written reason behind each entry.
const FUNCTION_SCOPED_EXEMPTIONS = new Map([
  [path.join('src', 'verify.cts'), new Set(['cmdValidateHealth', 'cmdVerifySchemaDrift'])],
  [path.join('src', 'init.cts'), new Set(['detectHasPriorPhases', 'detectUiPhaseActive'])],
  [path.join('src', 'milestone.cts'), new Set(['archivePhaseDirectories', 'cmdMilestoneComplete', 'cmdPhasesClear'])],
  // #3849: collectSiblingWorktreePhaseNums reads a SIBLING worktree's phases dir —
  // a different checkout listMilestonePhaseDirs (cwd-scoped) cannot serve; the
  // allocators' own on-disk scans stay unexempted.
  [path.join('src', 'phase.cts'), new Set(['cmdPhasesList', 'cmdPhaseNextDecimal', 'cmdPhasePlanIndex', 'cmdPhaseInsert', 'renameDecimalPhases', 'renameIntegerPhases', 'collectSiblingWorktreePhaseNums'])],
  [path.join('src', 'audit.cts'), new Set(['listAuditPhaseTargets'])],
  [path.join('src', 'commands.cts'), new Set(['cmdHistoryDigest'])],
  [path.join('src', 'state.cts'), new Set(['cmdStateValidate', 'cmdStateSync', 'cmdStateRebuild', 'countRoadmapPhaseHeadings'])],
  [path.join('src', 'roadmap-upgrade.cts'), new Set(['computeMigrationPlan'])],
  [path.join('src', 'smart-entry.cts'), new Set(['detectVerifyFailed'])],
  [path.join('src', 'roadmap-parser.cts'), new Set(['getMilestonePhaseFilter', 'scanMilestonePhaseIdSets', 'collectTablePhaseRows'])],
  [path.join('src', 'planning-snapshot.cts'), new Set(['buildAllPhaseDirNamesField'])],
]);

// Optional `export ` modifier, mirroring the sibling guards' function
// tracker — only a column-0 top-level `function` declaration updates the
// current-function tracker; a nested/arrow function does not reset it,
// matching every FUNCTION_SCOPED_EXEMPTIONS entry above (all top-level
// `function` declarations).
const TOP_LEVEL_FUNCTION_RE = /^(?:export\s+)?function\s+([A-Za-z0-9_]+)\s*\(/;

/**
 * Read the quoted or backtick-delimited string/template literal starting at
 * `line[start]` (which must be `'`, `"`, or `` ` ``). Returns `{ text, end }`
 * — `text` includes both delimiters, `end` is the index one past the literal
 * — or null if no matching close quote is found within MAX_REGEX_LITERAL_LEN
 * characters. Same single left-to-right, no-backtracking, escape-aware style
 * as the shared `readRegexLiteralAt` (`\x` escapes consume both characters,
 * so an escaped quote never terminates the literal early) — written locally,
 * mirroring `lint-milestone-window-drift.cjs`'s own copy (not shared — each
 * guard's literal-bearing shape differs).
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
 * True when `line` contains a regex-literal or quoted/backtick-string
 * literal whose text carries a STANDALONE `999` (see STANDALONE_999_RE).
 */
function hasSentinelLiteral(line) {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    let literal = null;
    if (ch === '/') literal = readRegexLiteralAt(line, i);
    else if (ch === "'" || ch === '"' || ch === '`') literal = readStringLiteralAt(line, i);
    if (!literal) continue;
    if (STANDALONE_999_RE.test(literal.text)) return true;
    i = literal.end - 1; // resume scanning just past this literal
  }
  return false;
}

/**
 * The first literal (regex OR quoted/backtick string) on `line` whose text
 * contains a STANDALONE `999` or the exact `'phases'` token — the "smoking
 * gun" fragment worth reporting, mirroring `extractFragment`'s role in
 * `lint-milestone-window-drift.cjs`. Falls back to a bounded, trimmed slice
 * of the raw line when neither is inside a located literal (the
 * `phasesDir` identifier / `SENTINEL_RANGES` / bare numeric-comparison
 * shapes never are).
 */
function extractFragment(line) {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    let literal = null;
    if (ch === '/') literal = readRegexLiteralAt(line, i);
    else if (ch === "'" || ch === '"' || ch === '`') literal = readStringLiteralAt(line, i);
    if (!literal) continue;
    if (STANDALONE_999_RE.test(literal.text) || /^['"`]phases['"`]$/.test(literal.text)) return literal.text;
    i = literal.end - 1; // resume scanning just past this literal
  }
  return line.trim().slice(0, MAX_REGEX_LITERAL_LEN);
}

/**
 * Strip comment text from a line before detection. A guard that fires on a
 * COMMENT — including a comment documenting that the code below uses the
 * canonical owner — reports prose as drift and trains readers to add
 * exemptions for documentation. Handles the three shapes that appear in this
 * codebase: a whole-line block-comment continuation (`*` or `/*` leading), a
 * `//` line comment, and a trailing `//` after code.
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
 * Pure: find every unsanctioned phase-enumeration re-derivation in `text`.
 * `relPath` is the repo-relative path, used both to report file:line and to
 * apply the narrow, function-scoped exemptions above.
 * Returns [{ line, found }].
 */
function findPhaseEnumerationDrift(text, relPath) {
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

    const isEnumerationDrift = READDIR_SYNC_RE.test(code) && (PHASES_DIR_ID_RE.test(code) || PHASES_STRING_RE.test(code));
    const isSentinelDrift = SENTINEL_COMPARISON_RE.test(code) || hasSentinelLiteral(code);
    if (!isEnumerationDrift && !isSentinelDrift) continue;

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
      if (OWNER_FILES.has(rel)) return [];
      return findPhaseEnumerationDrift(text, rel).map((d) => ({ file: rel, ...d }));
    },
  });
}

function main() {
  const root = path.join(__dirname, '..');
  const violations = scanRepo(root);
  if (violations.length === 0) {
    process.stdout.write('ok phase-enumeration-drift: no unsanctioned phase-enumeration re-derivations outside phase-locator.cts / phase-id.cts\n');
    return;
  }
  process.stderr.write('phase-enumeration-drift: independent re-derivation(s) of phase enumeration found.\n');
  process.stderr.write('Use src/phase-locator.cjs `listMilestonePhaseDirs` instead of re-deriving a phases-directory\n');
  process.stderr.write('readdirSync, and src/phase-id.cjs `isSentinelPhaseId` instead of re-deriving a `999` sentinel test:\n');
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
  findPhaseEnumerationDrift,
  scanRepo,
  READDIR_SYNC_RE,
  PHASES_DIR_ID_RE,
  PHASES_STRING_RE,
  SENTINEL_COMPARISON_RE,
  STANDALONE_999_RE,
  OWNER_FILES,
  FUNCTION_SCOPED_EXEMPTIONS,
  readStringLiteralAt,
  hasSentinelLiteral,
  extractFragment,
  stripComments,
};
