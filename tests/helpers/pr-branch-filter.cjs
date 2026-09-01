'use strict';

/**
 * Parsing seam for `tests/pr-branch-planning-filter.test.cjs` against
 * `/gsd-pr-branch`'s planning-path filter.
 *
 * The workflow (`gsd-core/workflows/pr-branch.md`) is the single source of
 * truth for which `.planning/` subdirectories are "transient" (excluded from
 * a PR branch in non-strict mode), for the "structural" regex that carves
 * out an exception even in that non-strict filter, AND for the
 * `create_pr_branch` cherry-pick/filter recipe itself. Rather than hardcoding
 * a second copy of that path list / regex / recipe here — which could
 * silently drift from the shipped workflow the moment any of them changes —
 * this module PARSES the workflow's own `TRANSIENT_DIRS="..."` and
 * `STRUCTURAL_RE="..."` shell declarations, and EXTRACTS its
 * `for HASH in $INCLUDED_COMMITS` cherry-pick loop, out of its markdown text.
 * The path/regex parsing mirrors, in JS, the same derivation the workflow's
 * shell performs on them; the loop extraction returns the shell body
 * verbatim so callers execute the actual shipped recipe rather than a
 * hand-copied mirror of it. If the workflow's declarations or recipe move,
 * get renamed, are duplicated, or go missing, this module throws rather than
 * silently falling back to a stale/guessed value — the workflow is the
 * single source of truth for behavior as well as for data.
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

const BASH_FENCE_OPEN_RE = /^```bash\s*$/;
const BASH_FENCE_CLOSE_RE = /^```\s*$/;
const PICK_LOOP_MARKER = 'for HASH in $(printf \'%s\' "$INCLUDED_COMMITS")';

// Scans `text` for fenced ```bash blocks and returns the verbatim body
// (fence markers stripped, lines rejoined with '\n') of the single block
// that contains `create_pr_branch`'s cherry-pick loop. Throws if the marker
// is found in zero or more-than-one bash block, since the recipe must have
// exactly one canonical form.
const extractPickLoop = (text) => {
  if (typeof text !== 'string') {
    throw new Error('extractPickLoop: expected the workflow text as a string');
  }

  const lines = text.split('\n');
  const matches = [];
  let i = 0;
  while (i < lines.length) {
    if (BASH_FENCE_OPEN_RE.test(lines[i])) {
      const bodyLines = [];
      let j = i + 1;
      while (j < lines.length && !BASH_FENCE_CLOSE_RE.test(lines[j])) {
        bodyLines.push(lines[j]);
        j += 1;
      }
      const body = bodyLines.join('\n');
      if (body.includes(PICK_LOOP_MARKER)) {
        matches.push(body);
      }
      i = j + 1;
    } else {
      i += 1;
    }
  }

  if (matches.length === 0) {
    throw new Error(`pr-branch.md: no create_pr_branch cherry-pick loop found (expected a bash block containing "${PICK_LOOP_MARKER}")`);
  }
  if (matches.length > 1) {
    throw new Error(`pr-branch.md: cherry-pick loop found in ${matches.length} bash blocks — the recipe must have exactly one canonical form`);
  }

  return matches[0];
};

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
  extractPickLoop,
  normalizePaths,
  forbiddenRegex,
  forbiddenPaths,
  structuralPaths,
  classifyCommit,
  otherPlanningPaths,
};
