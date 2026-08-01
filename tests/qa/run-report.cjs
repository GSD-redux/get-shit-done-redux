#!/usr/bin/env node
'use strict';

/**
 * run-report.cjs — developer/CI entry point that discovers every QA-walk
 * scenario, runs it for real against `gsd-tools`, and writes a single
 * `qa-report.json` document (see `report.cjs`).
 *
 * This is a TOOL, not a test file — it is invoked directly with `node`,
 * never through `gsd-test` / `node --test`, and is deliberately NOT named
 * `*.test.cjs` so it is never picked up by the test runner's glob.
 *
 * Usage:
 *   node tests/qa/run-report.cjs [--out <path>] [--keep]
 *
 * `--out <path>` defaults to `qa-report.json` at the repo root.
 * `--keep` (or `GSD_QA_KEEP=1`) preserves every scenario's temp project
 * directory instead of deleting it, and threads real repro commands for it
 * into the report — see `report.cjs`'s `buildRepro`.
 */

const fs = require('node:fs');
const path = require('node:path');

const { loadScenario, runScenario } = require('./scenario.cjs');
const { buildReport, writeReport } = require('./report.cjs');
const { LoopWalk } = require('./loop-walk.cjs');
const { runOracles } = require('./oracles.cjs');
const { getLiveCommandTokens } = require('../helpers/live-command-registry.cjs');

/** Absolute path to the repo root (`tests/qa/` -> `tests/` -> repo root). */
const REPO_ROOT = path.join(__dirname, '..', '..');

/** Absolute path to the scenarios directory. */
const SCENARIOS_DIR = path.join(__dirname, 'scenarios');

/**
 * Parse `argv` (excluding `node`/script name) into `{ out, keep }`.
 *
 * @param {string[]} argv
 * @returns {{out: string, keep: boolean}}
 */
function parseArgs(argv) {
  let out = path.join(REPO_ROOT, 'qa-report.json');
  let keep = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      const value = argv[i + 1];
      if (typeof value !== 'string' || value === '') {
        throw new Error('run-report: --out requires a path argument');
      }
      out = path.resolve(value);
      i += 1;
    } else if (arg === '--keep') {
      keep = true;
    } else {
      throw new Error(`run-report: unrecognized argument "${arg}" (expected --out <path> and/or --keep)`);
    }
  }
  return { out, keep };
}

/**
 * Every `.json` scenario file under `tests/qa/scenarios/`, EXCLUDING
 * underscore-prefixed self-test scenarios (e.g. `_selftest-must-fail.json`),
 * which are deliberately broken and must never run as a normal walk — see
 * `scenario.cjs`'s `assertWiringIsLive`.
 *
 * @returns {string[]} absolute file paths, sorted for a deterministic run order.
 */
function discoverScenarioFiles() {
  return fs
    .readdirSync(SCENARIOS_DIR)
    .filter((name) => name.endsWith('.json') && !name.startsWith('_'))
    .sort()
    .map((name) => path.join(SCENARIOS_DIR, name));
}

function main() {
  const { out, keep } = parseArgs(process.argv.slice(2));
  const liveCommands = [...getLiveCommandTokens()];

  const scenarioFiles = discoverScenarioFiles();
  if (scenarioFiles.length === 0) {
    throw new Error(`run-report: no scenario files discovered under "${SCENARIOS_DIR}"`);
  }

  const scenarioReports = scenarioFiles.map((file) => {
    const scenario = loadScenario(file);
    const report = runScenario(scenario, { LoopWalk, runOracles, liveCommands, keep });
    // `runScenario`'s own return value carries no `fixture` field — attach it
    // here from the (already-validated) scenario so the report document can
    // show which starting world each scenario walked.
    return { ...report, fixture: scenario.fixture };
  });

  const meta = {
    nodeVersion: process.version,
    platform: process.platform,
    generatedAt: new Date().toISOString(),
  };

  const reportObject = buildReport(scenarioReports, meta);
  const absOut = writeReport(reportObject, out);

  console.log(`qa-report written to ${absOut}`);
  console.log(
    `scenarios=${reportObject.totals.scenarios} steps=${reportObject.totals.steps} `
      + `violations=${reportObject.totals.violations} smells=${reportObject.totals.smells} `
      + `mutationsApplied=${reportObject.totals.mutationsApplied} mutationsObserved=${reportObject.totals.mutationsObserved}`,
  );
}

main();
