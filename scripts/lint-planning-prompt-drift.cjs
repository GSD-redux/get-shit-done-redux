#!/usr/bin/env node
'use strict';

/**
 * Anti-divergence drift guard for the PROMPT-LAYER plan/summary-COUNTING seam
 * (epic #3180, ADR-3180 "Planning Semantic Model Single Owner", Decision 4(e)).
 *
 * `scripts/lint-plan-count-drift.cjs` and `scripts/lint-milestone-window-drift.cjs`
 * scan `src/` only — but the `.planning/` semantic derivations they own are ALSO
 * re-derived a second time, in the PROMPT layer: the workflow markdown that
 * ships to every runtime, authored as raw shell rather than TypeScript. Issue
 * #1762's second reproduction traced a wrong `30 plans, 24 summaries` figure to
 * a `ls -1 ... *-PLAN.md | wc -l` snippet in `gsd-core/workflows/progress.md` —
 * a re-derivation no `.cts`-scoped guard can see, because it is markdown, not
 * source. ADR-3180 Decision 4(a) requires whole-repo discovery; this guard
 * extends that requirement from "the whole `src/` tree" to "every authored
 * surface that can carry a derivation", covering the prompt layer the two
 * sibling guards structurally cannot reach.
 *
 * Detection is intentionally NARROW, mirroring the sibling guards' precedent:
 * a line is a re-derivation when it carries BOTH, in ONE source line:
 *   (a) a plan/summary SET GLOB — a `*` followed by a run of
 *       `[-A-Za-z0-9_.{}$]` characters and then the literal `PLAN.md` or
 *       `SUMMARY.md`. The leading `*` is load-bearing: it is what makes the
 *       line enumerate a SET of files rather than name one specific plan.
 *       `gsd-core/workflows/execute-plan.md`'s
 *       `grep -cE '^\s*<task[[:space:]>]' .../{phase}-{plan}-PLAN.md` counts
 *       TASKS *inside* one already-named plan file — it has no glob token
 *       (no `*` anywhere near `PLAN.md`), so it is not a plan-count
 *       re-derivation and correctly never matches (a).
 *   (b) a COUNTING operation on that same line — `wc -l`, or `grep -c`
 *       (optionally with bundled short flags, e.g. `grep -cE`). Reading,
 *       globbing, or merely LISTING plan/summary files (`ls *-PLAN.md`,
 *       `cat *-PLAN.md`, `--files ".../*-PLAN.md"`) without counting them is
 *       not this derivation and must not be flagged — every non-counting
 *       `*-PLAN.md`/`*-SUMMARY.md` glob in `gsd-core/workflows/plan-phase.md`
 *       (backup, `--files`, `cat`, cross-reference prose) is exactly this
 *       shape and is deliberately left alone.
 * `*-UAT.md` never matches (a) — UAT artifacts are a different derivation
 * this guard does not own — so `gsd-core/workflows/progress.md`'s
 * `... *-UAT.md ... | wc -l` line correctly never fires even though it sits
 * one line below two lines that DO.
 *
 * Both regexes are small, bounded, and non-backtracking by construction (a
 * single fixed character class with no nested quantifiers) — `npm run
 * lint:ci` runs CodeQL js/redos over this repo, the same discipline the
 * sibling guards document in their own headers.
 *
 * Surfaces scanned (SCAN_DIRS): `gsd-core/workflows`, `commands`, `agents`,
 * `skills` — the prompt-layer markdown that ships to runtimes. SCAN_EXT:
 * `.md` only. The tree-walk / root-confinement / symlink / sanitizer
 * machinery is SHARED with the two sibling guards via `scripts/lib/drift-scan.cjs`
 * (ADR-3180 Decision 4's own "Rejected: let the new drift guard copy Phase 1's
 * tree-walk / root-confinement / sanitizer") — see that module for the
 * `isInsideRoot` case-sensitivity note, the `walk` symlink-confinement
 * rationale, and the ReDoS-avoidance rationale for its regex-literal reader
 * (unused by this guard's own regexes, which need no literal tokenizer, but
 * shared for the tree walk and report sanitization).
 *
 * RATCHET, not an allowlist. Per ADR-3180 Decision 4(e) this guard's baseline
 * (`scripts/baselines/planning-prompt-drift-baseline.json`) mirrors
 * `scripts/qa-smell-ratchet.cjs`'s precedent exactly: a violation whose
 * `(file, text)` pair is already RECORDED in the baseline is KNOWN and never
 * fails; a violation whose pair is NOT recorded is NEW and fails, telling the
 * author to route the count through the `gsd-core` CLI instead of re-deriving
 * it in shell; a recorded pair that no longer fires in this run is STALE and
 * ALSO fails, forcing `--update` (run by a maintainer after a migration) to
 * prune it — this is what makes the baseline SHRINK-ONLY as call sites
 * migrate off the shell re-derivation, rather than a list that only ever
 * grows. Matching is keyed on the pair (`file`, TRIMMED source `text`), never
 * the line number: a workflow markdown file's line numbers churn on every
 * unrelated edit (a new paragraph, a reworded step) and a number-keyed
 * baseline would need hand-maintenance on changes that have nothing to do
 * with this derivation at all.
 *
 * KNOWN, ACCEPTED limits of a per-line textual scan (same tradeoff the
 * sibling guards document): a re-derivation whose glob and counting operator
 * are split across two DIFFERENT lines (e.g. a variable holding the glob,
 * counted via `wc -l` on the next line) is not caught by this narrow shape.
 * That is left to code review, not this regex.
 */

const fs = require('node:fs');
const path = require('node:path');
const driftScan = require('./lib/drift-scan.cjs');
const { sanitizeForReport, scanTree } = driftScan;

// (a) A plan/summary SET GLOB: a `*` followed by a bounded run of path/brace/
// var-interpolation characters and then the literal `PLAN.md` or
// `SUMMARY.md`. The character class is fixed and the quantifier is a single
// `*` (regex "zero or more", not the shell glob character being matched) over
// that one class — no nesting, no alternation inside a repeated group, so
// there is nothing here for a backtracking engine to explore more than once.
const PLAN_SUMMARY_GLOB_RE = /\*[-A-Za-z0-9_.{}$]*(?:PLAN|SUMMARY)\.md/;

// (b) A counting operation: `wc -l`, or `grep -c` optionally followed by
// bundled short flags before the next space (e.g. `grep -cE`, `grep -cE`).
// `[A-Za-z]{0,4}` bounds the bundled-flag run so the alternative branch is
// exactly as fixed-width-bounded as `wc -l` — no unbounded quantifier chained
// to another, so nothing to backtrack.
const COUNTING_OP_RE = /wc -l|grep -c[A-Za-z]{0,4}\b/;

// Prompt-layer markdown that ships to every runtime.
const SCAN_DIRS = ['gsd-core/workflows', 'commands', 'agents', 'skills'];
const SCAN_EXT = new Set(['.md']);

const BASELINE_REL_PATH = path.join('scripts', 'baselines', 'planning-prompt-drift-baseline.json');

/**
 * Pure: find every plan/summary-count re-derivation line in `text`.
 * `relPath` is the repo-relative path, carried through only for the caller to
 * attach to each result (this function itself applies no per-file exemption).
 * Returns [{ line, found, text }] — `text` is the TRIMMED source line, the
 * same value the baseline keys on.
 */
function findPromptDrift(text, relPath) {
  void relPath; // no per-file exemption in this guard; kept for signature parity with the sibling guards
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const globMatch = PLAN_SUMMARY_GLOB_RE.exec(line);
    if (!globMatch) continue;
    if (!COUNTING_OP_RE.test(line)) continue;
    out.push({ line: i + 1, found: globMatch[0], text: line.trim() });
  }
  return out;
}

/**
 * Scan the prompt-layer markdown tree and return every re-derivation, each
 * annotated with the repo-relative file path.
 */
function scanRepo(root) {
  return scanTree({
    root,
    scanDirs: SCAN_DIRS,
    scanExt: SCAN_EXT,
    onFile(rel, text) {
      return findPromptDrift(text, rel).map((d) => ({ file: rel, ...d }));
    },
  });
}

/**
 * Read and parse the ratchet baseline. Returns `{ entries, errors }` —
 * `entries` is `[]` and `errors` names the problem when the file is missing,
 * empty, invalid JSON, or malformed; callers in check mode treat a non-empty
 * `errors` as a hard failure (mirrors `qa-smell-ratchet.cjs`'s `readBaseline`).
 */
function loadBaseline(root) {
  const baselinePath = path.join(root, BASELINE_REL_PATH);
  if (!fs.existsSync(baselinePath)) {
    return { entries: [], errors: [`${BASELINE_REL_PATH} is missing — run \`node scripts/lint-planning-prompt-drift.cjs --update\` to generate it`] };
  }
  const raw = fs.readFileSync(baselinePath, 'utf8');
  if (raw.trim() === '') {
    return { entries: [], errors: [`${BASELINE_REL_PATH} is present but empty`] };
  }
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    return { entries: [], errors: [`${BASELINE_REL_PATH} is not valid JSON: ${err.message}`] };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { entries: [], errors: [`${BASELINE_REL_PATH} must be a JSON object, got ${Array.isArray(doc) ? 'array' : typeof doc}`] };
  }
  if (!Array.isArray(doc.entries)) {
    return { entries: [], errors: [`${BASELINE_REL_PATH}: "entries" must be an array, got ${JSON.stringify(doc.entries)}`] };
  }
  const errors = [];
  const entries = [];
  doc.entries.forEach((entry, i) => {
    const where = `${BASELINE_REL_PATH}.entries[${i}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${where} must be an object, got ${JSON.stringify(entry)}`);
      return;
    }
    if (typeof entry.file !== 'string' || entry.file === '') {
      errors.push(`${where}.file must be a non-empty string, got ${JSON.stringify(entry.file)}`);
      return;
    }
    if (typeof entry.text !== 'string' || entry.text === '') {
      errors.push(`${where}.text must be a non-empty string, got ${JSON.stringify(entry.text)}`);
      return;
    }
    entries.push(entry);
  });
  return { entries, errors };
}

/**
 * Diff scanned `violations` (from `scanRepo`) against baseline `entries`,
 * matched by the pair (`file`, TRIMMED `text`) — never the line number.
 * Returns `{ fresh, stale }`:
 *   - `fresh`: violations whose (file, text) pair is NOT in the baseline —
 *     these fail the build as NEW.
 *   - `stale`: baseline entries whose (file, text) pair matched no violation
 *     in this run — these fail the build too, forcing `--update` to prune
 *     them (this is what keeps the baseline shrink-only).
 */
function diffAgainstBaseline(violations, baseline) {
  const key = (file, text) => `${file} ${text}`;
  const known = new Set(baseline.map((e) => key(e.file, e.text)));
  const seen = new Set();
  const fresh = [];
  for (const v of violations) {
    const k = key(v.file, v.text);
    seen.add(k);
    if (!known.has(k)) fresh.push(v);
  }
  const stale = baseline.filter((e) => !seen.has(key(e.file, e.text)));
  return { fresh, stale };
}

/** Stable sort: by `file`, then by `text`. */
function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.file !== b.file) return a.file < b.file ? -1 : 1;
    if (a.text !== b.text) return a.text < b.text ? -1 : 1;
    return 0;
  });
}

function writeBaseline(root, violations) {
  const entries = sortEntries(
    violations.map((v) => ({ file: v.file, text: v.text, derivation: 'plan-count', owner_issue: '#3180' })),
  );
  const doc = {
    $comment:
      'ADR-3180 Decision 4(e) ratchet. See scripts/lint-planning-prompt-drift.cjs. SHRINK-ONLY: entries are '
      + 'removed as sites migrate to the gsd-core CLI; new or changed entries fail lint:ci.',
    entries,
  };
  const baselinePath = path.join(root, BASELINE_REL_PATH);
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return entries;
}

function main() {
  const root = path.join(__dirname, '..');
  const update = process.argv.includes('--update');
  const violations = scanRepo(root);

  if (update) {
    const entries = writeBaseline(root, violations);
    process.stdout.write(`ok planning-prompt-drift: baseline regenerated with ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}\n`);
    return;
  }

  const { entries: baseline, errors } = loadBaseline(root);
  if (errors.length > 0) {
    process.stderr.write('planning-prompt-drift: baseline load error(s):\n');
    for (const e of errors) process.stderr.write(`  ${e}\n`);
    process.exitCode = 1;
    return;
  }

  const { fresh, stale } = diffAgainstBaseline(violations, baseline);

  if (fresh.length === 0 && stale.length === 0) {
    process.stdout.write(`ok planning-prompt-drift: no unacknowledged plan/summary count re-derivations in the prompt layer (${baseline.length} known)\n`);
    return;
  }

  if (fresh.length > 0) {
    process.stderr.write('planning-prompt-drift: NEW plan/summary count re-derivation(s) found in the prompt layer.\n');
    process.stderr.write('Route the count through the gsd-core CLI instead of re-deriving it in shell (ls .../*-PLAN.md | wc -l\n');
    process.stderr.write('or grep -c on a *-PLAN.md/*-SUMMARY.md glob), or add an acknowledged entry to\n');
    process.stderr.write(`${BASELINE_REL_PATH} via --update:\n`);
    for (const v of fresh) {
      process.stderr.write(`  ${sanitizeForReport(v.file)}:${v.line}  ${sanitizeForReport(v.found)}  ${sanitizeForReport(v.text)}\n`);
    }
  }

  if (stale.length > 0) {
    process.stderr.write('\nplanning-prompt-drift: STALE baseline entr' + (stale.length === 1 ? 'y' : 'ies') + " (no longer produced by this run — the site was migrated, delete the row):\n");
    for (const e of stale) {
      process.stderr.write(`  ${sanitizeForReport(e.file)}  ${sanitizeForReport(e.text)}\n`);
    }
    process.stderr.write(`\n  remedy: node scripts/lint-planning-prompt-drift.cjs --update\n`);
  }

  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  findPromptDrift,
  scanRepo,
  loadBaseline,
  diffAgainstBaseline,
  writeBaseline,
  PLAN_SUMMARY_GLOB_RE,
  COUNTING_OP_RE,
  SCAN_DIRS,
  SCAN_EXT,
  BASELINE_REL_PATH,
};
