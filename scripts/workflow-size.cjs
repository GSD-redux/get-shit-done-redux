'use strict';

/**
 * @file workflow-size.cjs
 *
 * Single source of truth for measuring workflow `.md` file sizes in bytes.
 *
 * Shared by `tests/workflow-size-budget.test.cjs` / `tests/agent-size-budget.test.cjs`
 * (the tier hard-cap guards), `tests/helpers/emitted-runtime.cjs`'s `currentSizes()`
 * (the differential attribution check's size ratchet, ADR-2719 Phase 4), and
 * `scripts/gen-emitted-baseline.cjs` (the baseline publisher) so none of them can
 * disagree on HOW a file is measured (issue #1074). `scripts/update-size-baseline.cjs`,
 * the original third consumer, was removed by #2724 along with the per-file baseline
 * it generated.
 */

const fs = require('fs');
const path = require('path');

const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');

/**
 * Byte size of a file, counted as on an LF (Unix) checkout.
 *
 * The size budget is calibrated against `wc -c` on a Unix (LF) checkout.
 * Counting raw on-disk bytes on a CRLF checkout adds one byte per line, a
 * Windows-only false positive that diverges from the LF calibration basis
 * (issue #683).  Stripping CR yields the same LF byte count on every platform.
 *
 * `.gitattributes:2` (`* text=auto eol=lf`, added in #1088) now normalizes these
 * files to LF on checkout everywhere, so the CRLF case should not arise from a
 * normal clone — but this stays unconditional because it also covers a working
 * tree produced some other way (an unpacked archive, an editor that rewrites
 * line endings, a checkout predating that attribute).
 * This is still a raw byte count (not a trailing-newline-stripping line count).
 *
 * @param {string} filePath - Absolute or relative path to the file.
 * @returns {number} LF-normalized byte length.
 */
function lfByteCount(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  return Buffer.byteLength(content.replace(/\r\n/g, '\n'), 'utf-8');
}

/**
 * List top-level workflow stems (filenames without the `.md` extension), sorted.
 * Non-recursive by design: per-mode bodies under `workflows/<name>/modes/` and
 * templates are NOT measured — only the always-loaded top-level workflows.
 *
 * @param {string} [dir] - Workflows directory (defaults to the canonical one).
 * @returns {string[]} Sorted stems, e.g. `['autonomous', 'plan-phase', ...]`.
 */
function listWorkflowStems(dir = WORKFLOWS_DIR) {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.replace(/\.md$/, ''))
    .sort();
}

/**
 * Measure every top-level `.md` file in `dir`, keyed by filename, byte sizes.
 * Generic over directory and an optional filename predicate — used for both
 * workflows (`gsd-core/workflows/*.md`) and agents (`agents/gsd-*.md`) so the
 * size guards and the baseline generator share one measurement path (#1074).
 * Non-recursive by design.
 *
 * @param {string} dir - Directory to scan.
 * @param {function(string): boolean} [predicate] - Filename filter (default: all `.md`).
 * @returns {Object<string, number>} Map of filename → LF byte size, keys sorted.
 */
function measureMdFiles(dir, predicate = () => true) {
  const out = {};
  const names = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md') && predicate(f))
    .sort();
  for (const name of names) out[name] = lfByteCount(path.join(dir, name));
  return out;
}

/**
 * Measure every top-level workflow file, keyed by filename (`<stem>.md`).
 *
 * @param {string} [dir] - Workflows directory (defaults to the canonical one).
 * @returns {Object<string, number>} Map of `<stem>.md` → LF byte size, sorted.
 */
function measureWorkflows(dir = WORKFLOWS_DIR) {
  return measureMdFiles(dir);
}

/**
 * #4261: the reserved margin, as a fraction of a tier's hard cap.
 *
 * The hard caps are red lines and stay exactly where they are. This is the
 * second, softer level the caps never had: `execute-phase.md` already carries
 * a hand-rolled version of this shape (a hard `< 93600` plus a `<= 93400`
 * margin whose own message says it exists "so minor future edits don't
 * re-trip the gate"), and it is the only capped file that does. Everywhere
 * else a file is either fine or already over, with nothing in between — so
 * the first signal a contributor gets is a failure, and by then the cheap
 * moment to extract has passed.
 *
 * 95% is deliberately not derived from anything. It is the round number the
 * issue proposed, and the census below is what makes it reviewable: if it
 * turns out to name too many or too few files, that is visible in one table
 * rather than argued from first principles.
 */
const MARGIN_RATIO = 0.95;

/**
 * The reserved-margin threshold for a hard cap, in bytes.
 *
 * Floor, not round: the margin must never land ON or above the cap it is
 * meant to sit under, however small the cap.
 *
 * @param {number} cap - Tier hard cap in bytes.
 * @returns {number} Margin threshold in bytes.
 */
function marginFor(cap) {
  return Math.floor(cap * MARGIN_RATIO);
}

/**
 * Build the headroom census for a set of measured files.
 *
 * Sorted by pressure (least headroom first) because that is the reading
 * order that matters: the top row is the file that will break next.
 *
 * @param {Object<string, number>} sizes - Map of filename -> LF byte size.
 * @param {function(string): {tier: string, cap: number}} capFor - Tier lookup, keyed by stem.
 * @returns {Array<{name: string, tier: string, bytes: number, cap: number, margin: number, headroom: number, usedPct: number, overMargin: boolean}>}
 */
function buildHeadroomRows(sizes, capFor) {
  return Object.entries(sizes)
    .map(([file, bytes]) => {
      const name = file.replace(/\.md$/, '');
      const { tier, cap } = capFor(name);
      const margin = marginFor(cap);
      return {
        name,
        tier,
        bytes,
        cap,
        margin,
        headroom: cap - bytes,
        usedPct: (bytes / cap) * 100,
        overMargin: bytes > margin,
      };
    })
    .sort((a, b) => a.headroom - b.headroom || a.name.localeCompare(b.name));
}

/**
 * Render the census as a fixed-width text table for the test diagnostics.
 *
 * @param {ReturnType<typeof buildHeadroomRows>} rows
 * @param {{limit?: number}} [opts] - How many rows to render (default: all).
 * @returns {string[]} Lines, ready to hand to `t.diagnostic` one at a time.
 */
function formatHeadroomTable(rows, { limit = Infinity } = {}) {
  const shown = rows.slice(0, limit);
  const width = Math.max(4, ...shown.map((r) => r.name.length));
  const head = `${'file'.padEnd(width)}  ${'tier'.padEnd(7)}  ${'bytes'.padStart(7)}  ${'cap'.padStart(7)}  ${'margin'.padStart(7)}  ${'headroom'.padStart(8)}  ${'used'.padStart(6)}`;
  const body = shown.map(
    (r) =>
      `${r.name.padEnd(width)}  ${r.tier.padEnd(7)}  ${String(r.bytes).padStart(7)}  ${String(r.cap).padStart(7)}  ${String(r.margin).padStart(7)}  ${String(r.headroom).padStart(8)}  ${r.usedPct.toFixed(1).padStart(5)}%`,
  );
  return [head, ...body];
}

/**
 * Render the census as a GitHub job-summary markdown table.
 *
 * Only the rows over the reserved margin: a job summary that lists all 124
 * capped files is a log dump nobody reads, and every row below the margin is
 * by definition not the problem. The count of the rest is still reported so
 * an empty table cannot be mistaken for an unmeasured one.
 *
 * @param {string} title - Section heading (e.g. `'Agent size headroom'`).
 * @param {ReturnType<typeof buildHeadroomRows>} rows
 * @returns {string} Markdown block.
 */
function buildHeadroomSummaryMarkdown(title, rows) {
  const pressured = rows.filter((r) => r.overMargin);
  const lines = [`### ${title}`, ''];
  if (pressured.length === 0) {
    lines.push(`All ${rows.length} files are under the ${Math.round(MARGIN_RATIO * 100)}% reserved margin.`);
    return `${lines.join('\n')}\n`;
  }
  lines.push(
    `**${pressured.length} of ${rows.length}** files are over the ${Math.round(MARGIN_RATIO * 100)}% reserved margin.`,
    '',
    '| file | tier | bytes | cap | headroom | used |',
    '| --- | --- | ---: | ---: | ---: | ---: |',
  );
  for (const r of pressured) {
    lines.push(`| \`${r.name}\` | ${r.tier} | ${r.bytes} | ${r.cap} | ${r.headroom} | ${r.usedPct.toFixed(1)}% |`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Append a census block to `$GITHUB_STEP_SUMMARY` when running in CI.
 *
 * No-op off CI, and never throws: this is reporting, and a test suite must
 * not go red because a summary file was not writable.
 *
 * @param {string} title - Section heading.
 * @param {ReturnType<typeof buildHeadroomRows>} rows
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean} Whether anything was written.
 */
function appendHeadroomStepSummary(title, rows, env = process.env) {
  if (!env.GITHUB_STEP_SUMMARY) return false;
  try {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${buildHeadroomSummaryMarkdown(title, rows)}\n`);
    return true;
  } catch (err) {
    process.stderr.write(`workflow-size: could not write GITHUB_STEP_SUMMARY: ${err.message}\n`);
    return false;
  }
}

module.exports = {
  WORKFLOWS_DIR,
  MARGIN_RATIO,
  lfByteCount,
  listWorkflowStems,
  measureMdFiles,
  measureWorkflows,
  marginFor,
  buildHeadroomRows,
  formatHeadroomTable,
  buildHeadroomSummaryMarkdown,
  appendHeadroomStepSummary,
};
