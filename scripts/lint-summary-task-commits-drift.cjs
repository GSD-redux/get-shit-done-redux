#!/usr/bin/env node
'use strict';

/**
 * Drift guard for issue #3926: pin the `## Task Commits` line shape across the
 * four SUMMARY templates.
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
 * Deliberately NOT pinned: the hash's own spelling. Three templates ship the
 * literal placeholder `hash` and one ships `abc123f`, so requiring hex here
 * would fail on the shipped files; the hex filter belongs at parse time, where
 * it runs against real SUMMARYs. Nor is the trailing type token
 * (`(feat/fix/test/refactor)`) pinned — `summary.md` carries it and the other
 * three do not, and the parser does not read it.
 */

const fs = require('fs');
const path = require('path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');

const TEMPLATES = [
  'gsd-core/templates/summary.md',
  'gsd-core/templates/summary-minimal.md',
  'gsd-core/templates/summary-standard.md',
  'gsd-core/templates/summary-complex.md',
];

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

function main() {
  const failures = [];

  for (const rel of TEMPLATES) {
    const target = path.join(ROOT, rel);
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

  if (failures.length === 0) {
    process.stdout.write(`ok summary-task-commits-drift: ${TEMPLATES.length} templates\n`);
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

runMain(main);
