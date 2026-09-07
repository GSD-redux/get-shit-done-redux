#!/usr/bin/env node
'use strict';

/**
 * Drift guard for issue #3926: pin the `## Task Commits` line shape across
 * every SUMMARY template in gsd-core/templates/.
 *
 * `gsd-core/workflows/code-review.md` derives a phase's own commit set by
 * slicing each `*-SUMMARY.md` between its `## Task Commits` heading and the
 * next `## ` heading, then matching BACKTICK-DELIMITED hex tokens inside that
 * slice. That derivation replaced a commit-message grep, a class that had
 * failed and been re-fixed five times (#2989/#3191/#3503/#3995), so the
 * coupling to the template's line shape is load-bearing rather than
 * incidental — and it is otherwise implicit, which is what this lint makes
 * explicit.
 *
 * Two properties are pinned, and only two, because only these two are what the
 * parser actually reads:
 *
 *   1. the `## Task Commits` heading exists, and is followed by another `## `
 *      heading (the parser's slice needs a terminator);
 *   2. inside that slice, every task line carries its hash in BACKTICKS.
 *
 * Deliberately NOT pinned: the hash's own spelling. Some templates ship the
 * literal placeholder `hash` and others `abc123f`, so requiring hex here
 * would fail on the shipped files; the hex filter belongs at parse time, where
 * it runs against real SUMMARYs. Nor is the trailing type token
 * (`(feat/fix/test/refactor)`) pinned — only some templates carry it, and the
 * parser does not read it either way.
 */

const fs = require('fs');
const path = require('path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');

const TEMPLATE_DIR = 'gsd-core/templates';
// Every SUMMARY template, not a list of the four that exist today. The parser
// reads whichever template produced the SUMMARY on disk, so the guard's set has
// to be the DIRECTORY's set: a hardcoded list silently stops covering the
// domain the moment a fifth `summary-*.md` lands, and a template whose Task
// Commits line shape differs is exactly what this guard exists to refuse.
const TEMPLATE_RE = /^summary(-[^/]*)?\.md$/;

/**
 * Enumerate the SUMMARY templates. Throws rather than returning an empty set:
 * zero templates means the directory moved or the pattern stopped matching, and
 * a guard that silently checks nothing reports `ok` over an unguarded domain.
 */
function listTemplates(root = ROOT) {
  const dir = path.join(root, TEMPLATE_DIR);
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    throw new ExitError(1, `lint-summary-task-commits-drift: cannot read ${TEMPLATE_DIR}: ${error.message}`);
  }
  const found = entries.filter((name) => TEMPLATE_RE.test(name)).sort();
  if (found.length === 0) {
    throw new ExitError(1, `lint-summary-task-commits-drift: no SUMMARY templates matched ${TEMPLATE_RE} in ${TEMPLATE_DIR} — the guard would check nothing`);
  }
  return found.map((name) => `${TEMPLATE_DIR}/${name}`);
}

// EXACTLY the shipped awk's class, `/^## Task Commits[ \t\r]*$/`. Mirroring it
// beats normalising the input: stripping `\r` globally first made
// `## Task\r Commits` a heading here that neither parser recognises, so the
// guard reported clean over a section the parser never opens.
const HEADING = /^## Task Commits[ \t\r]*$/;
const NEXT_HEADING = /^## /;
// TWO patterns, and the split is the point: one DETECTS a task row, the other
// says whether that row is CANONICAL. A finding is a row the first matches and
// the second does not.
//
// This guard is deliberately STRICTER than the production parser, and that is a
// design choice rather than an accident. Four earlier shapes each tried to
// approximate what the parser accepts and each disagreed with it in both
// directions: a separator-keyed pair missed an em-dash drift; a
// presence-anywhere test passed a code span sitting in the LABEL; a positional
// test matched the closing `**` of a LATER bold phrase; and excluding `*` from
// the label made an ordinary title like `migrate src/*.js` fail DETECTION, so
// the row was skipped and its missing hash never reported. The parser locates a
// hash by shape (`[0-9a-f]{7,40}` in backticks) and the templates ship the
// placeholders `hash` and `abc123f`, so the guard cannot run the parser's own
// test — but it can pin the ONE canonical row shape these authored files use,
// including what the token must LOOK like, and refuse everything else.
//
// The label runs to its FIRST closing `**` and admits anything else —
// asterisks and code spans included. Excluding either produced misses above; a
// title is prose and the guard has no business constraining it.
//
// TEMPERED, not merely non-greedy, and the difference is a live defect. `.*?`
// backtracks: when the rest of the pattern fails at the first `**`, the engine
// extends the label through a LATER bold phrase and tries again, so
// ``- B (**see** - `parser`)`` matched with `see` supplying the closing `**`
// and read clean while both parsers omitted B. `(?:(?!\*\*).)*` cannot cross a
// `**` at all, so the label ends where the label ends.
// `[\s\S]`, not `.`: the dot excludes `\r`, so a carriage return INSIDE a title
// made detection skip the whole row and its missing hash went unreported —
// the same silent-miss direction as the asterisk exclusion above.
const LABEL = String.raw`\*\*Task\s+\d+:(?:(?!\*\*)[\s\S])*\*\*`;
// DETECT: a numbered task row whose label closes. The closing `**` is required
// — without it, prose inside the section that merely opens with `2. **Task 2: …`
// is read as a task row and reported as drifted.
const TASK_LINE = new RegExp(String.raw`^\s*\d+\.\s+${LABEL}`);
// CANONICAL: label, one punctuation separator, then IMMEDIATELY a backticked
// token that is a single ALPHANUMERIC RUN. Pinning the token's SHAPE is what
// closes the last miss class: `` `B, C` `` and `` `B;C` `` satisfy any "there is
// a backticked thing here" test while the parser's hex match rejects the whole
// token and records no commit at all.
//
// Shape, not content, and the distinction is load-bearing — these are TEMPLATES.
// A real hash is alphanumeric, but the shipped placeholders are illustrative
// rather than valid (`summary.md` uses `def456g` and `hij789k`, which the
// parser's own `[0-9a-f]{7,40}` would reject), so requiring hex here fails on
// the very files the guard exists to watch. Separators are what a hash slot
// cannot contain; letters outside a-f are simply someone's placeholder.
const CANONICAL_TASK_LINE = new RegExp(
  String.raw`^\s*\d+\.\s+${LABEL}\s*[-–—:]\s*\x60[0-9A-Za-z]+\x60`,
);

/**
 * Collect EVERY `## Task Commits` section, matching the production awk exactly:
 * `/^## Task Commits/ { inside=1; next } /^## / { inside=0 } inside` reopens on
 * a second matching heading, so a guard that read only the first section left
 * later ones — including one inside a fenced example — unchecked while the
 * parser consumed them.
 */
function sliceSections(lines) {
  const sections = [];
  let current = null;
  // A `## Task Commits` line is itself a `## ` line, so it TERMINATES the
  // previous section as well as opening a new one. Opening without closing left
  // consecutive sections reporting the first as unterminated — a finding on a
  // file both production fences read correctly.
  const close = () => { if (current) { current.terminated = true; current = null; } };
  for (const line of lines) {
    if (HEADING.test(line)) { close(); current = { body: [], terminated: false }; sections.push(current); continue; }
    if (NEXT_HEADING.test(line)) { close(); continue; }
    if (current) current.body.push(line);
  }
  return sections;
}

/**
 * Pure driver: return the drift failures for `root`, one string per finding.
 * Separated from `main` so the guard is exercisable against a fixture tree —
 * the sibling `lint-table-schema-drift.cjs` exports its own driver for the
 * same reason. A guard with no fail-first test is a guard nothing has ever
 * seen fire.
 */
function findSummaryTaskCommitsDrift(root = ROOT) {
  const failures = [];

  for (const rel of listTemplates(root)) {
    const target = path.join(root, rel);
    let content;
    try {
      content = fs.readFileSync(target, 'utf8');
    } catch (error) {
      throw new ExitError(1, `lint-summary-task-commits-drift: failed to read ${rel}: ${error.message}`);
    }

    const lines = content.split('\n');   // no CR normalisation — HEADING mirrors the awk's own class
    const sections = sliceSections(lines);

    if (sections.length === 0) {
      failures.push(`${rel}: no '## Task Commits' heading — the parser's section anchor is gone`);
      continue;
    }

    let canonicalTotal = 0;
    for (const section of sections) {
      if (!section.terminated) {
        failures.push(`${rel}: '## Task Commits' is the last '## ' section — the parser slices to the next '## ' heading and would run to EOF`);
      }
      for (const line of section.body) {
        if (!TASK_LINE.test(line)) continue;
        if (CANONICAL_TASK_LINE.test(line)) { canonicalTotal += 1; continue; }
        failures.push(`${rel}: task line is not the canonical \`**Task N: …** - \`hash\`\` shape: ${line.trim()}`);
      }
    }
    if (canonicalTotal === 0) {
      failures.push(`${rel}: no '## Task Commits' section carries a canonical task line — the parser matches \`hash\` inside these slices`);
    }
  }

  return failures;
}

function main() {
  const templates = listTemplates(ROOT);
  const failures = findSummaryTaskCommitsDrift(ROOT);

  if (failures.length === 0) {
    process.stdout.write(`ok summary-task-commits-drift: ${templates.length} templates\n`);
    return 0;
  }

  process.stderr.write('ERROR summary-task-commits-drift: SUMMARY template shape drifted from the #3926 phase-scope parser\n');
  for (const failure of failures) {
    process.stderr.write(`  - ${failure}\n`);
  }
  process.stderr.write("The parser lives in gsd-core/workflows/code-review.md (compute_file_scope): it slices between\n");
  process.stderr.write("'## Task Commits' and the next '## ' heading, then matches backticked hex tokens inside the slice.\n");
  process.stderr.write('Keep the templates and that parser in step, or #3926 silently loses phase scope.\n');
  return 1;
}

if (require.main === module) runMain(main);

module.exports = { findSummaryTaskCommitsDrift, listTemplates, sliceSections, TEMPLATE_DIR, TEMPLATE_RE };
