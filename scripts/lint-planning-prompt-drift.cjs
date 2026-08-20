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
 * COUNT, not duplicate rows. Two DIFFERENT source lines can carry the exact
 * same (file, TRIMMED text) pair — `gsd-core/workflows/plan-phase.md` has two
 * byte-identical `DISK_PLANS=$(ls "${PHASE_DIR}"/*-PLAN.md 2>/dev/null | wc -l
 * | tr -d ' ')` sites. Keying on (file, text) alone with one baseline row per
 * OCCURRENCE made a partial migration invisible: migrating ONE of the two
 * sites still leaves a violation matching the row, so nothing goes fresh and
 * nothing goes stale — the remaining, unmigrated copy is silently covered by
 * the row meant to acknowledge the pair NO LONGER MIGRATING. Each baseline
 * entry therefore carries a `count` — the number of byte-identical
 * occurrences of that (file, text) pair acknowledged at this site, not a
 * duplicated row per occurrence:
 *   - actual occurrences this run < entry.count  -> STALE as a PARTIAL
 *     migration: some but not all acknowledged copies are gone, so the entry
 *     no longer describes reality and must be re-recorded via `--update`;
 *   - actual occurrences this run > entry.count  -> the occurrences beyond
 *     the acknowledged count are FRESH: a new copy landed next to one that
 *     was already acknowledged;
 *   - actual occurrences this run === 0          -> fully STALE, the
 *     existing "site was migrated, delete the row" case;
 *   - actual occurrences this run === entry.count -> fully acknowledged, no
 *     failure.
 * Line numbers stay OUT of the key even with counting — that is still what
 * keeps the baseline immune to unrelated churn; `count` answers "how many",
 * never "which lines".
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

// `scanTree` (scripts/lib/drift-scan.cjs) builds its repo-relative path via
// `path.relative()`, which uses NATIVE separators: on Windows that is
// `gsd-core\workflows\execute-plan.md`, while the committed baseline
// (`scripts/baselines/planning-prompt-drift-baseline.json`) stores POSIX
// paths (`gsd-core/workflows/execute-plan.md`). Every baseline lookup in this
// guard is keyed on that path, so an un-normalized Windows path silently
// fails to match ANY baseline entry — every real violation reports as FRESH
// and every baseline entry reports as STALE (100% failure rate on Windows,
// caught by GitHub Actions' Windows CI lane on PR #3223; the remote runner
// this repo otherwise gates on is Linux-only and cannot see this class).
// Normalized UNCONDITIONALLY — never gated on `process.platform` — because a
// platform-conditional normalizer is itself the bug: it makes the POSIX path
// the tested case and leaves the Windows branch exercised only on Windows.
// Applied at the single seam `findPromptDrift` owns (the only place a
// repo-relative path enters this guard's violation objects), so ONE
// normalized value flows into all four consumers: the baseline key
// (`diffAgainstBaseline`), the `--update` writer (`writeBaseline` via
// `dedupeViolationsForBaseline`), the violation report (`main`), and the
// tests.
function toPosixRel(relPath) {
  return relPath.replace(/\\/g, '/');
}

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

// ADR-3180 Decision 4(e): a baseline entry is "acknowledged, in writing, with
// the issue that owns its removal" — that is Phase 8 (#3218, "the prompt
// layer": give the workflow layer a CLI surface to ask for plan and phase
// counts, and burn this ratchet baseline to zero), NOT the epic (#3180)
// itself. #3180 is the scope authority for the whole consolidation; #3218 is
// the phase that actually deletes these shell re-derivations.
const RATCHET_OWNER_ISSUE = '#3218';

/**
 * Pure: find every plan/summary-count re-derivation line in `text`.
 * `relPath` is the repo-relative path (native separators or POSIX, either
 * is accepted) — normalized via `toPosixRel` and attached as `file` on every
 * result; this function applies no per-file exemption, so `relPath` is not
 * otherwise consulted for detection.
 * Returns [{ file, line, found, text }] — `file` is always POSIX-separated,
 * `text` is the TRIMMED source line, the same value the baseline keys on.
 */
function findPromptDrift(text, relPath) {
  const file = toPosixRel(relPath);
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const globMatch = PLAN_SUMMARY_GLOB_RE.exec(line);
    if (!globMatch) continue;
    if (!COUNTING_OP_RE.test(line)) continue;
    out.push({ file, line: i + 1, found: globMatch[0], text: line.trim() });
  }
  return out;
}

/**
 * Scan the prompt-layer markdown tree and return every re-derivation, each
 * annotated with the repo-relative file path (POSIX-normalized — see
 * `toPosixRel`).
 */
function scanRepo(root) {
  return scanTree({
    root,
    scanDirs: SCAN_DIRS,
    scanExt: SCAN_EXT,
    onFile(rel, text) {
      return findPromptDrift(text, rel);
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
    // `count` is optional on read (diffAgainstBaseline defaults an absent
    // count to 1) but when present must be a positive integer — the number
    // of byte-identical (file, text) occurrences this entry acknowledges.
    if (entry.count !== undefined && !(Number.isInteger(entry.count) && entry.count >= 1)) {
      errors.push(`${where}.count must be a positive integer when present, got ${JSON.stringify(entry.count)}`);
      return;
    }
    entries.push(entry);
  });
  return { entries, errors };
}

/**
 * Diff scanned `violations` (from `scanRepo`) against baseline `entries`,
 * matched by the pair (`file`, TRIMMED `text`) — never the line
 * number — and COUNT-aware: an entry acknowledges `entry.count`
 * (default 1 when absent) byte-identical occurrences of that pair, not
 * merely its presence. Returns `{ fresh, stale }`:
 *   - `fresh`: violations whose (file, text) pair is NOT in the baseline at
 *     all (a brand new site), PLUS any occurrences of a KNOWN pair beyond
 *     its acknowledged `count` (a new copy landed next to an
 *     already-acknowledged one) — both fail the build as NEW.
 *   - `stale`: baseline entries whose actual occurrence count this run is
 *     LESS than their acknowledged `count` — zero actual
 *     occurrences is the fully-migrated case ("site was migrated, delete
 *     the row"); a positive but short count is a PARTIAL migration (some
 *     but not all acknowledged copies are gone). Both fail the build,
 *     forcing `--update` to re-record the pair (this is what keeps the
 *     baseline shrink-only and what makes a partial migration visible
 *     instead of silently covered by the still-present sibling
 *     occurrence).
 */
function diffAgainstBaseline(violations, baseline) {
  const key = (file, text) => `${file} ${text}`;

  // Group this run's violations by (file, text) so a duplicated pair's
  // occurrence COUNT — not merely its presence — can be
  // compared against what the baseline entry acknowledges.
  const actualByKey = new Map();
  for (const v of violations) {
    const k = key(v.file, v.text);
    let vs = actualByKey.get(k);
    if (!vs) { vs = []; actualByKey.set(k, vs); }
    vs.push(v);
  }

  const knownKeys = new Set(baseline.map((e) => key(e.file, e.text)));

  const fresh = [];
  const stale = [];

  // Every occurrence of a pair the baseline has never recorded at all is NEW.
  for (const [k, vs] of actualByKey) {
    if (!knownKeys.has(k)) fresh.push(...vs);
  }

  // For every RECORDED pair, compare its acknowledged count against how
  // many occurrences this run actually found.
  for (const entry of baseline) {
    const k = key(entry.file, entry.text);
    const expected = entry.count ?? 1;
    const vs = actualByKey.get(k) || [];
    const actual = vs.length;
    if (actual < expected) {
      // Zero actual occurrences is the fully-stale case; 0 < actual <
      // expected is a partial migration — both are STALE, and
      // both carry the expected/actual counts so the caller can name the
      // mismatch.
      stale.push({ ...entry, count: expected, actualCount: actual });
    } else if (actual > expected) {
      // Occurrences beyond the acknowledged count are a NEW copy landing
      // next to one that was already acknowledged.
      fresh.push(...vs.slice(expected));
    }
    // actual === expected: fully acknowledged, no failure.
  }

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

/**
 * Collapse `violations` into one baseline row per distinct (file, text) pair,
 * carrying a `count` of how many occurrences that pair has in THIS run — see
 * the module header's "COUNT, not duplicate rows" note. Pure; no I/O.
 */
function dedupeViolationsForBaseline(violations) {
  const order = [];
  const byKey = new Map();
  for (const v of violations) {
    const k = `${v.file} ${v.text}`;
    let entry = byKey.get(k);
    if (!entry) {
      entry = { file: v.file, text: v.text, derivation: 'plan-count', owner_issue: RATCHET_OWNER_ISSUE, count: 0 };
      byKey.set(k, entry);
      order.push(entry);
    }
    entry.count += 1;
  }
  return order;
}

function writeBaseline(root, violations) {
  const entries = sortEntries(dedupeViolationsForBaseline(violations));
  const doc = {
    $comment:
      'ADR-3180 Decision 4(e) ratchet, owned by Phase 8 (#3218). See scripts/lint-planning-prompt-drift.cjs. '
      + 'SHRINK-ONLY: entries are removed as sites migrate to the gsd-core CLI; new or changed entries fail '
      + 'lint:ci. `count` is the number of byte-identical (file, text) occurrences acknowledged at this site '
      + '— a run producing fewer fails as a partial migration, more fails as an unacknowledged new copy.',
    entries,
  };
  const baselinePath = path.join(root, BASELINE_REL_PATH);
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
  return entries;
}

/**
 * Resolve the scan root for a CLI run. Default: this repo — exactly what
 * `lint:ci` invokes. `--root <dir>` overrides it (#3640) so the CLI
 * end-to-end test can prove the guard's FAIL path against an isolated temp
 * tree instead of writing its fixture into the shared `gsd-core/workflows/`
 * that parallel test chunks observe mid-lifecycle (the emitted-provenance
 * manifest build copies the transient file into all 19 runtime manifests;
 * the #3333 TOCTOU ENOENT crash was the same writer's first symptom).
 *
 * Usage errors exit 2 — a code distinct from the guard's own findings exit
 * (1), so tests and CI can tell "bad invocation" from "drift found" without
 * parsing stderr. Fail-closed on every bad shape, because a wrong root is
 * not harmless: `--root --update` would otherwise resolve the flag itself
 * into a cwd-relative path and --update would happily `mkdir -p` a stray
 * baseline tree inside the shared source directory (#3640's write class).
 * A value that starts with `-` (another flag) or does not name an existing
 * directory is therefore a usage error, never a scan root. With repeated
 * `--root` flags the first wins (same first-match convention as the boolean
 * `--update` parse).
 */
function resolveScanRoot() {
  const rootIdx = process.argv.indexOf('--root');
  if (rootIdx === -1) return path.join(__dirname, '..');
  const value = process.argv[rootIdx + 1];
  const isDir = value !== undefined
    && !value.startsWith('-')
    && fs.existsSync(value)
    && fs.statSync(value).isDirectory();
  if (!isDir) {
    process.stderr.write('planning-prompt-drift: --root requires an existing directory argument (usage: --root <dir>)\n');
    process.exitCode = 2;
    return null;
  }
  return path.resolve(value);
}

function main() {
  const root = resolveScanRoot();
  if (root === null) return;
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
    process.stderr.write('\nplanning-prompt-drift: STALE baseline entr' + (stale.length === 1 ? 'y' : 'ies') + " (fully migrated, or a PARTIAL migration — fewer occurrences found than acknowledged; delete or re-record the row):\n");
    for (const e of stale) {
      process.stderr.write(`  ${sanitizeForReport(e.file)}  ${sanitizeForReport(e.text)}  (found ${e.actualCount}/${e.count} acknowledged occurrence${e.count === 1 ? '' : 's'})\n`);
    }
    process.stderr.write(`\n  remedy: node scripts/lint-planning-prompt-drift.cjs --update\n`);
  }

  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  findPromptDrift,
  scanRepo,
  toPosixRel,
  loadBaseline,
  diffAgainstBaseline,
  writeBaseline,
  PLAN_SUMMARY_GLOB_RE,
  COUNTING_OP_RE,
  SCAN_DIRS,
  SCAN_EXT,
  BASELINE_REL_PATH,
};
