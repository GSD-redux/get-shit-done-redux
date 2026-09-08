#!/usr/bin/env node
'use strict';

/**
 * Benchmarks the token-count effect of every registered `workflow.compact_content`
 * spine/detail split (ADR-4139 Decision 3, Phase 3 #4403's `docs/PARTITION-RULES.md`).
 *
 * For every split it reports the "off" token count (spine + all detail parts —
 * what `workflow.compact_content=false` pays today, since an opted-out project's
 * spine reads every detail part back in) against the "on" token count (spine
 * alone — what `workflow.compact_content=true` pays, since the detail `Read`
 * never fires). See `.gsd/phase/enhance-4404-token-benchmark/40-design.md` for
 * the full design rationale.
 *
 * PROXY-TOKENIZER CAVEAT: Anthropic publishes no tokenizer for Claude 3+, so
 * `gpt-tokenizer` (pinned exact-version devDependency, see ADR-4139
 * Consequences) is a stand-in. The on/off COMPARISON is exact under this one
 * pinned tokenizer applied identically to both sides; the absolute counts are
 * NOT Claude's real token counts. Every output surface says so explicitly —
 * see the `label` field below.
 *
 * Discovery is REIMPLEMENTED here rather than imported from
 * `tests/helpers/compact-content-split.cjs`: a `scripts/` reporting tool
 * depending on a test-only helper module inverts this repo's normal layering,
 * and a test-only module changing shape should never be able to break a
 * benchmark. The discovery logic is intentionally small (see
 * `discoverRegisteredSplits` below) and mirrors `docs/PARTITION-RULES.md`'s
 * own description of what a "registered split" is.
 *
 * Usage:
 *   node scripts/benchmark-compact-content.cjs                     # print JSON to stdout
 *   node scripts/benchmark-compact-content.cjs --write             # write the committed baseline
 *   node scripts/benchmark-compact-content.cjs --check             # recompute, diff vs committed baseline, print drift
 *   node scripts/benchmark-compact-content.cjs --check --baseline-path=<path>
 *                                                                   # --check against a DIFFERENT baseline
 *                                                                   # file (testability seam; defaults to the
 *                                                                   # committed path when omitted)
 *
 * ============================================================================
 * CRITICAL — READ BEFORE "FIXING" ANYTHING BELOW (this is the issue's own
 * Done-when item; getting it wrong defeats the entire point of this tool):
 *
 * This script — and in particular `--check` — MUST NEVER exit non-zero
 * because a baseline is drifted, stale, or missing entirely. A drifted or
 * absent baseline is REPORTED (printed to stdout as a human-readable diff),
 * never treated as failure. The ONLY thing allowed to make this script exit
 * non-zero is a genuine I/O error reading a SOURCE file the benchmark is
 * measuring (a spine or detail `.md` file that `discoverRegisteredSplits`
 * found on disk but that fails to read) — never anything about the baseline
 * file. This is deliberate: the benchmark is a reporting instrument wired
 * into `npm run benchmark:compact-content`, which is never part of a gate,
 * `lint:ci`, or `pretest` — see `tests/benchmark-compact-content.test.cjs`'s
 * "never-fails-CI" tests, which assert this behavior directly against a
 * deliberately-wrong and a wholly-missing baseline. Do not add
 * `process.exit(1)` (or an `ExitError` with a non-zero code) on drift.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');

const { countTokens } = require('gpt-tokenizer');
const { runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, 'gsd-core', 'workflows');
const BASELINE_PATH = path.join(ROOT, 'tests', 'fixtures', 'compact-content-benchmark-baseline.json');

// The tokenizer's own package.json is read live (`require.resolve` + a plain
// `fs.readFileSync`/JSON.parse — NOT `require('gpt-tokenizer/package.json')`,
// which would work identically here but would tie this file to Node's CJS
// JSON-import behavior for no benefit) rather than hardcoding the version as
// a string literal. This repo's own `package.json` pins `gpt-tokenizer` at an
// EXACT version (no `^`/`~`), so the two are guaranteed to agree today — but
// reading the installed package's own version live means a future re-pin of
// that dependency never requires touching this file too, and the reported
// version can never silently drift from what actually ran.
function getTokenizerVersion() {
  const pkgPath = require.resolve('gpt-tokenizer/package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return pkg.version;
}

/**
 * Discover every registered spine/detail split under `workflowsDir`.
 *
 * A split is registered by a `<workflowsDir>/<name>/detail/` directory
 * (containing at least one `*.md` file) where `<name>` is exactly ONE path
 * segment directly under `workflowsDir`. Pairs with the spine at
 * `<workflowsDir>/<name>.md`; skipped entirely if that spine does not exist
 * (this benchmark only measures real, complete splits — an orphaned detail
 * directory with no spine is Phase 3's registration guard's problem, not
 * this benchmark's).
 *
 * Mirrors `tests/helpers/compact-content-split.cjs`'s `discoverRegisteredSplits`
 * in shape (same "one segment below workflowsDir, `detail/` dir, at least one
 * `.md` file" rule) but is a from-scratch, self-contained implementation —
 * see the module header for why this is not a shared import.
 *
 * @param {string} [workflowsDir]
 * @returns {Array<{name: string, spinePath: string, detailPaths: string[]}>}
 */
function discoverRegisteredSplits(workflowsDir = WORKFLOWS_DIR) {
  const found = new Map();

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory: nothing to discover under it
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);

      if (entry.name === 'detail') {
        let mdFiles = [];
        try {
          mdFiles = fs
            .readdirSync(full, { withFileTypes: true })
            .filter((e) => e.isFile() && e.name.endsWith('.md'))
            .map((e) => e.name);
        } catch {
          mdFiles = [];
        }
        if (mdFiles.length > 0) {
          const segments = path.relative(workflowsDir, dir).split(path.sep).filter(Boolean);
          if (segments.length === 1) {
            const name = segments[0];
            if (!found.has(name)) {
              const spinePath = path.join(workflowsDir, `${name}.md`);
              if (fs.existsSync(spinePath)) {
                const detailPaths = mdFiles.map((f) => path.join(full, f)).sort();
                found.set(name, { name, spinePath, detailPaths });
              }
            }
          }
        }
      }

      walk(full);
    }
  }

  walk(workflowsDir);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Compute the off/on/reduction numbers for ONE registered split.
 *
 * Throws on a genuine read failure of a source file (see the module-header
 * CRITICAL note — this is the one thing allowed to throw). `reductionPct` is
 * reported as `0` rather than `NaN`/`Infinity` when `offTokens` is `0` (an
 * empty spine — should never happen for a real split, but must not crash).
 *
 * @param {{name: string, spinePath: string, detailPaths: string[]}} split
 * @returns {{offTokens: number, onTokens: number, reductionPct: number}}
 */
function computeSplitTokens(split) {
  const spineContent = fs.readFileSync(split.spinePath, 'utf8');
  const onTokens = countTokens(spineContent);
  let detailTokens = 0;
  for (const detailPath of split.detailPaths) {
    const detailContent = fs.readFileSync(detailPath, 'utf8');
    detailTokens += countTokens(detailContent);
  }
  const offTokens = onTokens + detailTokens;
  const reductionPct = offTokens === 0 ? 0 : round2(((offTokens - onTokens) / offTokens) * 100);
  return { offTokens, onTokens, reductionPct };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Aggregate per-split numbers. `aggregateReductionPct` is computed from the
 * SUMMED off/on totals, never averaged across per-split percentages — a
 * 2-split fixture with very different sizes is what
 * `tests/benchmark-compact-content.test.cjs` uses to pin this down. Reports
 * `0` (not `NaN`) when there are zero registered splits or `aggregateOff` is
 * `0` — a valid, non-crashing state, not an error.
 *
 * @param {Record<string, {offTokens: number, onTokens: number}>} splitResults
 * @returns {{offTokens: number, onTokens: number, reductionPct: number}}
 */
function computeAggregate(splitResults) {
  let offTokens = 0;
  let onTokens = 0;
  for (const key of Object.keys(splitResults)) {
    offTokens += splitResults[key].offTokens;
    onTokens += splitResults[key].onTokens;
  }
  const reductionPct = offTokens === 0 ? 0 : round2(((offTokens - onTokens) / offTokens) * 100);
  return { offTokens, onTokens, reductionPct };
}

const LABEL =
  "PROXY-TOKENIZER DELTA — gpt-tokenizer is a stand-in; Anthropic publishes no tokenizer for Claude 3+. " +
  "The on/off COMPARISON is exact under this pinned tokenizer; absolute counts are not Claude's real token counts.";

/**
 * Build the full report object — the "committed baseline" shape. Keys of
 * `splits` are sorted (`discoverRegisteredSplits` already returns
 * name-sorted records; `Object.keys` insertion order on a plain object built
 * in that order preserves it, and `--check`'s comparison re-sorts anyway so
 * this is belt-and-suspenders, not load-bearing).
 *
 * @param {string} [workflowsDir]
 * @returns {object}
 */
function buildReport(workflowsDir = WORKFLOWS_DIR) {
  const splits = discoverRegisteredSplits(workflowsDir);
  const splitReports = {};
  for (const split of splits) {
    splitReports[split.name] = computeSplitTokens(split);
  }
  return {
    schema_version: 1,
    generated_by: 'scripts/benchmark-compact-content.cjs',
    tokenizer: { name: 'gpt-tokenizer', version: getTokenizerVersion() },
    label: LABEL,
    splits: splitReports,
    aggregate: computeAggregate(splitReports),
  };
}

/**
 * Format a human-readable drift summary between a (possibly missing/invalid)
 * committed baseline and a freshly-computed live report. Never throws — a
 * missing or unparseable baseline is reported as "no baseline found" /
 * "baseline could not be parsed", not propagated as an error, per the
 * module's CRITICAL contract.
 *
 * @param {string} baselinePath
 * @param {object} live
 * @returns {string}
 */
function formatDriftReport(baselinePath, live) {
  const lines = [];
  let baseline = null;
  let baselineReadError = null;
  try {
    const raw = fs.readFileSync(baselinePath, 'utf8');
    try {
      baseline = JSON.parse(raw);
    } catch (parseErr) {
      baselineReadError = `baseline at ${baselinePath} could not be parsed as JSON: ${parseErr.message}`;
    }
  } catch {
    baselineReadError = `no baseline found at ${baselinePath}`;
  }

  if (baselineReadError) {
    lines.push(`DRIFT: ${baselineReadError} — treating as fully drifted (this is reported, not an error).`);
    lines.push('Live splits:');
    for (const name of Object.keys(live.splits).sort()) {
      const s = live.splits[name];
      lines.push(`  + ${name}: off=${s.offTokens} on=${s.onTokens} reduction=${s.reductionPct}%`);
    }
    lines.push(
      `Live aggregate: off=${live.aggregate.offTokens} on=${live.aggregate.onTokens} ` +
      `reduction=${live.aggregate.reductionPct}%`,
    );
    return lines.join('\n');
  }

  const baselineSplits = (baseline && typeof baseline === 'object' && baseline.splits) || {};
  const liveSplits = live.splits;
  const allNames = new Set([...Object.keys(baselineSplits), ...Object.keys(liveSplits)]);
  let anyDrift = false;

  if (!baseline || typeof baseline.label !== 'string' || !baseline.label.includes('PROXY-TOKENIZER')) {
    anyDrift = true;
    lines.push('DRIFT: committed baseline is missing the required "PROXY-TOKENIZER" label.');
  }

  for (const name of [...allNames].sort()) {
    const b = baselineSplits[name];
    const l = liveSplits[name];
    if (!b) {
      anyDrift = true;
      lines.push(`DRIFT: split "${name}" is new (not in committed baseline) — live off=${l.offTokens} on=${l.onTokens} reduction=${l.reductionPct}%`);
    } else if (!l) {
      anyDrift = true;
      lines.push(`DRIFT: split "${name}" was removed (present in committed baseline, not found live) — baseline off=${b.offTokens} on=${b.onTokens} reduction=${b.reductionPct}%`);
    } else if (b.offTokens !== l.offTokens || b.onTokens !== l.onTokens || b.reductionPct !== l.reductionPct) {
      anyDrift = true;
      lines.push(
        `DRIFT: split "${name}": off ${b.offTokens} -> ${l.offTokens} (${l.offTokens - b.offTokens >= 0 ? '+' : ''}${l.offTokens - b.offTokens}), ` +
        `on ${b.onTokens} -> ${l.onTokens} (${l.onTokens - b.onTokens >= 0 ? '+' : ''}${l.onTokens - b.onTokens}), ` +
        `reduction ${b.reductionPct}% -> ${l.reductionPct}% (${round2(l.reductionPct - b.reductionPct) >= 0 ? '+' : ''}${round2(l.reductionPct - b.reductionPct)}pp)`,
      );
    }
  }

  const ba = (baseline && baseline.aggregate) || {};
  const la = live.aggregate;
  if (ba.offTokens !== la.offTokens || ba.onTokens !== la.onTokens || ba.reductionPct !== la.reductionPct) {
    anyDrift = true;
    lines.push(
      `DRIFT: aggregate: off ${ba.offTokens} -> ${la.offTokens}, on ${ba.onTokens} -> ${la.onTokens}, ` +
      `reduction ${ba.reductionPct}% -> ${la.reductionPct}%`,
    );
  }

  if (!anyDrift) {
    lines.push(`Baseline at ${baselinePath} is up to date with the live recompute.`);
  } else {
    lines.push('');
    lines.push('Run `node scripts/benchmark-compact-content.cjs --write` to refresh the committed baseline.');
    lines.push('(This is a REPORT, not a gate — exiting 0 regardless of drift, per this script\'s own contract.)');
  }
  return lines.join('\n');
}

function parseArgs(argv) {
  const opts = { write: false, check: false, baselinePath: BASELINE_PATH };
  for (const arg of argv) {
    if (arg === '--write') opts.write = true;
    else if (arg === '--check') opts.check = true;
    else if (arg.startsWith('--baseline-path=')) opts.baselinePath = arg.slice('--baseline-path='.length);
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.write) {
    const report = buildReport();
    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(report, null, 2) + '\n');
    process.stdout.write(`Wrote ${BASELINE_PATH}\n`);
    return;
  }

  if (opts.check) {
    const live = buildReport();
    // See the module-header CRITICAL note: this branch NEVER throws or sets a
    // non-zero exit code on a drifted/missing/invalid baseline — only
    // `buildReport()` above (a genuine source-file read failure) can throw.
    process.stdout.write(formatDriftReport(opts.baselinePath, live) + '\n');
    return;
  }

  process.stdout.write(JSON.stringify(buildReport(), null, 2) + '\n');
}

/* c8 ignore next 3 -- CLI entry guard; this repo measures coverage with c8, which does not honor istanbul pragmas */
if (require.main === module) {
  runMain(main);
}

module.exports = {
  discoverRegisteredSplits,
  computeSplitTokens,
  computeAggregate,
  buildReport,
  formatDriftReport,
  getTokenizerVersion,
  parseArgs,
  LABEL,
  BASELINE_PATH,
  WORKFLOWS_DIR,
};
