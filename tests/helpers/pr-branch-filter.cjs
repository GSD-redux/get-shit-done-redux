'use strict';

/**
 * Parsing seam for `tests/pr-branch-planning-filter.test.cjs` against
 * `/gsd-pr-branch`'s planning-path filter.
 *
 * The workflow (`gsd-core/workflows/pr-branch.md`) is the single source of
 * truth for which `.planning/` subdirectories are "transient" (excluded from
 * a PR branch in non-strict mode) and for the "structural" regex that carves
 * out an exception even in that non-strict filter. Rather than hardcoding a
 * second copy of that path list / regex here — which could silently drift
 * from the shipped workflow the moment either changes — this module PARSES
 * the workflow's own `TRANSIENT_DIRS="..."` and `STRUCTURAL_RE="..."` shell
 * declarations out of its markdown text and mirrors, in JS, the same
 * derivation the workflow's shell performs on them. If the workflow's
 * declarations move, get renamed, or are duplicated, this module throws
 * rather than silently falling back to a stale/guessed value.
 *
 * ## Known limits
 *
 * This is a targeted regex extraction of two specific `NAME="..."` shell
 * assignments, not a shell parser: it assumes each declaration appears
 * verbatim, unquoted-value-free (no embedded `"` — shell wouldn't allow that
 * unescaped inside a double-quoted assignment either), and on its own line.
 * It does not evaluate shell variable expansion, comments, or conditionals
 * around the declaration — only the literal assigned string.
 */

const fs = require('fs');
const path = require('path');
const { escapeRegex: escapeRe } = require('../../gsd-core/bin/lib/pattern.cjs');

const WORKFLOW_PATH = path.join(__dirname, '..', '..', 'gsd-core', 'workflows', 'pr-branch.md');

const TRANSIENT_DIRS_RE = /^\s*TRANSIENT_DIRS="([^"]*)"/gm;
const STRUCTURAL_RE_RE = /^\s*STRUCTURAL_RE="([^"]*)"/gm;

// Collects every match of `re` (a global regex) against `text`, returning
// the captured group-1 values in order. `re.lastIndex` is reset first so
// repeated calls against the same shared regex object are safe.
const collectMatches = (re, text) => {
  re.lastIndex = 0;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(m[1]);
  }
  return out;
};

const parseWorkflow = (text) => {
  if (typeof text !== 'string') {
    throw new Error('parseWorkflow: expected the workflow text as a string');
  }

  const transientMatches = collectMatches(TRANSIENT_DIRS_RE, text);
  if (transientMatches.length === 0) {
    throw new Error('pr-branch.md: no TRANSIENT_DIRS declaration');
  }
  if (transientMatches.length > 1) {
    throw new Error(`pr-branch.md: TRANSIENT_DIRS declared ${transientMatches.length} times — the filter must have exactly one canonical declaration`);
  }

  const structuralMatches = collectMatches(STRUCTURAL_RE_RE, text);
  if (structuralMatches.length === 0) {
    throw new Error('pr-branch.md: no STRUCTURAL_RE declaration');
  }
  if (structuralMatches.length > 1) {
    throw new Error(`pr-branch.md: STRUCTURAL_RE declared ${structuralMatches.length} times — the filter must have exactly one canonical declaration`);
  }

  const transientDirs = transientMatches[0].split(/\s+/).filter((s) => s.length > 0);
  const structuralRe = structuralMatches[0];

  return { transientDirs, structuralRe };
};

const readWorkflow = () => parseWorkflow(fs.readFileSync(WORKFLOW_PATH, 'utf-8'));

const normalizePaths = (input) => {
  const raw = typeof input === 'string' ? input.split('\n') : input;
  return raw.map((s) => s.replace(/\r$/, '')).filter((s) => s.length > 0);
};

const forbiddenRegex = ({ strict, transientDirs }) => {
  if (strict === true) {
    return /^\.planning\//;
  }
  if (!transientDirs || transientDirs.length === 0) {
    return /(?!)/;
  }
  const alt = transientDirs.map((d) => escapeRe(d)).join('|');
  return new RegExp(`^\\.planning/(${alt})/`);
};

const forbiddenPaths = (files, opts) => {
  const re = forbiddenRegex(opts);
  return normalizePaths(files).filter((p) => re.test(p));
};

const structuralPaths = (files, { structuralRe }) => {
  const re = new RegExp(structuralRe);
  return normalizePaths(files).filter((p) => re.test(p));
};

const classifyCommit = (files, opts) => {
  const paths = normalizePaths(files);
  if (paths.length === 0) return 'exclude';

  const nonPlanning = paths.filter((p) => !/^\.planning\//.test(p));
  if (nonPlanning.length > 0) return 'include';

  if (opts.strict) return 'exclude';

  if (structuralPaths(paths, opts).length > 0) return 'include';

  return 'exclude';
};

const otherPlanningPaths = (files, opts) => {
  const paths = normalizePaths(files);
  const forbidden = new Set(forbiddenPaths(paths, opts));
  const structural = new Set(structuralPaths(paths, opts));
  return paths.filter(
    (p) => /^\.planning\//.test(p) && !forbidden.has(p) && !structural.has(p),
  );
};

module.exports = {
  WORKFLOW_PATH,
  parseWorkflow,
  readWorkflow,
  normalizePaths,
  forbiddenRegex,
  forbiddenPaths,
  structuralPaths,
  classifyCommit,
  otherPlanningPaths,
};
