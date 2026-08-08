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
 *   (a) a `.filter(` call, and
 *   (b) a quoted plan/summary filename-suffix literal
 *       ('-PLAN.md', 'PLAN.md', '-SUMMARY.md', or 'SUMMARY.md')
 * on the same source line — the shape every current re-derivation in this
 * codebase takes (`files.filter(f => f.endsWith('-PLAN.md') || f ===
 * 'PLAN.md')`, `fs.readdirSync(dir).filter(f => f.endsWith('-SUMMARY.md'))`,
 * etc).
 *
 * KNOWN, ACCEPTED limits of a per-line textual scan (same tradeoff the
 * phase-id-drift guard documents): a re-derivation that filters via a
 * hand-rolled loop instead of `.filter(...)`, or one split across multiple
 * lines/helper functions, is not caught by this narrow shape. That is left
 * to code review, not this regex.
 */

const fs = require('node:fs');
const path = require('node:path');

// A `.filter(` call on the line — the shape every current re-derivation uses
// to turn a directory listing into a plan-or-summary subset.
const FILTER_CALL_RE = /\.filter\(/;

// A quoted plan/summary filename-suffix literal: 'PLAN.md', '-PLAN.md',
// 'SUMMARY.md', or '-SUMMARY.md', single- or double-quoted (opening and
// closing quote must match).
const PLAN_SUMMARY_LITERAL_RE = /(['"])-?(?:PLAN|SUMMARY)\.md\1/;

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
const FUNCTION_SCOPED_EXEMPTIONS = new Map([
  [CORE_UTILS_FILE, CORE_UTILS_EXEMPT_FUNCTIONS],
  [path.join('src', 'audit.cts'), new Set(['scanQuickTasks'])],
  [path.join('src', 'gsd2-import.cts'), new Set(['readTasksDir'])],
]);

const TOP_LEVEL_FUNCTION_RE = /^function\s+([A-Za-z0-9_]+)\s*\(/;

function walk(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      walk(full, acc);
    } else if (entry.isFile() && SCAN_EXT.has(path.extname(entry.name))) {
      acc.push(full);
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

    if (!FILTER_CALL_RE.test(line)) continue;
    const literalMatch = PLAN_SUMMARY_LITERAL_RE.exec(line);
    if (!literalMatch) continue;

    if (exemptFunctions && exemptFunctions.has(currentFunction)) continue;

    out.push({ line: i + 1, found: literalMatch[0] });
  }
  return out;
}

/**
 * Scan the authored source tree and return every unsanctioned re-derivation,
 * each annotated with the repo-relative file path.
 */
function scanRepo(root) {
  const violations = [];
  for (const dir of SCAN_DIRS) {
    for (const file of walk(path.join(root, dir), [])) {
      const rel = path.relative(root, file);
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
    process.stderr.write(`  ${d.file}:${d.line}  ${d.found}\n`);
  }
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = { findPlanCountDrift, scanRepo, FILTER_CALL_RE, PLAN_SUMMARY_LITERAL_RE };
