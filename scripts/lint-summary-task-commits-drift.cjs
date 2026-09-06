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
const TEMPLATE_RE = /^summary(-[A-Za-z0-9]+)*\.md$/;

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

const HEADING = /^## Task Commits[ \t]*$/;
const NEXT_HEADING = /^## /;
// A numbered task line. The hash must be backticked; everything between the
// task label and the hash is free prose.
const TASK_LINE = /^\d+\.\s+\*\*Task\s+\d+:.*\*\*\s*-\s*`[^`]+`/;
// A task-shaped line whose hash is NOT backticked — the specific drift this
// guard exists to catch, reported separately so the message is actionable.
const TASK_LINE_NO_BACKTICK = /^\d+\.\s+\*\*Task\s+\d+:.*\*\*\s*-\s*[^`\s]/;

function sliceSection(lines) {
  const start = lines.findIndex((line) => HEADING.test(line));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (NEXT_HEADING.test(lines[i])) { end = i; break; }
  }
  return { body: lines.slice(start + 1, end), terminated: end < lines.length };
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

    const lines = content.replace(/\r\n/g, '\n').split('\n');
    const section = sliceSection(lines);

    if (!section) {
      failures.push(`${rel}: no '## Task Commits' heading — the parser's section anchor is gone`);
      continue;
    }
    if (!section.terminated) {
      failures.push(`${rel}: '## Task Commits' is the last '## ' section — the parser slices to the next '## ' heading and would run to EOF`);
    }

    const backticked = section.body.filter((line) => TASK_LINE.test(line));
    if (backticked.length === 0) {
      failures.push(`${rel}: '## Task Commits' section carries no backtick-delimited task line — the parser matches \`hash\` inside this slice`);
    }

    for (const line of section.body) {
      if (!TASK_LINE.test(line) && TASK_LINE_NO_BACKTICK.test(line)) {
        failures.push(`${rel}: task line drops the backtick delimiter: ${line.trim()}`);
      }
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

module.exports = { findSummaryTaskCommitsDrift, listTemplates, sliceSection, TEMPLATE_DIR, TEMPLATE_RE };
