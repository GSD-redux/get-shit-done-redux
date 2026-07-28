'use strict';

/**
 * @file workflow-size.cjs
 *
 * Single source of truth for measuring workflow `.md` file sizes in bytes.
 *
 * Shared by `tests/workflow-size-budget.test.cjs` (the CI guard) and
 * `scripts/update-size-baseline.cjs` (the baseline generator) so the two can
 * never disagree on HOW a file is measured.  A divergence between the generator
 * and the guard would silently mis-record the baseline (issue #1074).
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

module.exports = {
  WORKFLOWS_DIR,
  lfByteCount,
  listWorkflowStems,
  measureMdFiles,
  measureWorkflows,
};
