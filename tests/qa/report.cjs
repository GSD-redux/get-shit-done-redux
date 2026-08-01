'use strict';

/**
 * report.cjs — turns an array of `runScenario` reports (see `scenario.cjs`)
 * into a single, serializable `qa-report.json` document.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * `runScenario` reports one walk at a time and is deliberately silent about
 * anything cross-scenario (totals, a merged smell index, a human-runnable
 * repro line). This module is the aggregation seam: `buildReport` takes the
 * raw per-scenario reports plus run metadata and produces one plain object;
 * `writeReport` serializes it to disk. Neither function performs a CLI
 * invocation, discovers scenario files, or reads the clock — see
 * `run-report.cjs` for the executable that wires this to the filesystem and
 * to `LoopWalk`/`runOracles`.
 *
 * DETERMINISM: `buildReport` never calls `Date.now()` / `new Date()` — the
 * caller supplies `meta.generatedAt`. A report builder that stamped its own
 * wall-clock time would make two builds of the exact same walk compare as
 * different documents, which defeats diffing/reviewing a report in CI.
 *
 * REPRO LINES ARE ALWAYS STRINGS: `step.repro` is either a real,
 * copy-pasteable `cd <dir> && node gsd-core/bin/gsd-tools.cjs ...` command,
 * or a string clearly prefixed `NOT RUNNABLE: ...` explaining why (the tree
 * was not preserved, or the step declared no CLI invocation at all). A
 * repro line that *looks* runnable but points at a directory that was
 * already deleted is worse than no repro line, so the two cases are never
 * conflated into one shape that "sometimes has a command".
 */

const fs = require('node:fs');
const path = require('node:path');

/** Bump when the shape of the emitted report document changes incompatibly. */
const REPORT_VERSION = 1;

/**
 * Build a single copy-pasteable repro command/explanation for one step.
 *
 * @param {{preservedDir?: string, argv: string[]}} params
 * @returns {string}
 */
function buildRepro({ preservedDir, argv }) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return 'NOT RUNNABLE: this step declared no CLI invocation (no "run" array) — there is nothing to reproduce.';
  }
  if (!preservedDir) {
    return 'NOT RUNNABLE: the scenario tree was not preserved for this run — re-run with `--keep` (or `GSD_QA_KEEP=1`) to get a reproducible command.';
  }
  return `cd ${preservedDir} && node gsd-core/bin/gsd-tools.cjs --json-errors ${argv.join(' ')}`;
}

/**
 * Merge one scenario's already-computed `smellSummary` (see
 * `scenario.cjs`'s `summarizeSmells`) into the running whole-report index.
 *
 * @param {Map<string, {count: number, examples: string[]}>} byId
 * @param {Array<{id: string, count: number, examples: string[]}>} smellSummary
 */
function mergeSmellSummary(byId, smellSummary) {
  for (const entry of smellSummary || []) {
    const existing = byId.get(entry.id) || { count: 0, examples: [] };
    existing.count += entry.count;
    if (existing.examples.length < 3) {
      existing.examples = existing.examples.concat(entry.examples).slice(0, 3);
    }
    byId.set(entry.id, existing);
  }
}

/**
 * Build the plain, serializable report document from an array of
 * `runScenario(...)` reports and run metadata. Never throws away input it
 * cannot classify — a scenario report with an unrecognized shape fails loud
 * (naming the offending index) rather than silently producing a hollow
 * document.
 *
 * @param {Array<{
 *   name: string,
 *   ok: boolean,
 *   fixture?: string,
 *   steps: Array<{at: string, argv: string[], kind: string|null,
 *     expectFailures: string[], oracleFailures: {id:string,detail:string}[],
 *     smells: {id:string,detail:string}[], mutation: {id:string,target:string}|null,
 *     mutationNoop: boolean, mutationObserved: boolean}>,
 *   smellSummary?: Array<{id:string, count:number, examples:string[]}>,
 *   preservedDir?: string,
 * }>} scenarioReports the array of objects returned by `runScenario`
 *   (optionally carrying a `fixture` field attached by the caller — see
 *   `run-report.cjs`, which knows the scenario's `fixture` even though
 *   `runScenario`'s own return value does not).
 * @param {{nodeVersion: string, platform: string, generatedAt: string}} meta
 *   caller-supplied run metadata. `generatedAt` MUST be supplied by the
 *   caller (e.g. `new Date().toISOString()`) — this function never reads the
 *   clock itself, to keep its output deterministic and reviewable.
 * @returns {object} the plain report document (see this file's header for
 *   its top-level shape).
 */
function buildReport(scenarioReports, meta) {
  if (!Array.isArray(scenarioReports)) {
    throw new Error(`buildReport: scenarioReports must be an array, got ${JSON.stringify(scenarioReports)}`);
  }
  if (!meta || typeof meta !== 'object') {
    throw new Error(`buildReport: meta must be an object, got ${JSON.stringify(meta)}`);
  }
  for (const key of ['nodeVersion', 'platform', 'generatedAt']) {
    if (typeof meta[key] !== 'string' || meta[key] === '') {
      throw new Error(`buildReport: meta.${key} must be a non-empty string, got ${JSON.stringify(meta[key])}`);
    }
  }

  let totalSteps = 0;
  let totalViolations = 0;
  let mutationsApplied = 0;
  let mutationsObserved = 0;
  /** @type {Map<string, {count: number, examples: string[]}>} */
  const smellById = new Map();

  const scenarios = scenarioReports.map((sr, index) => {
    if (!sr || typeof sr !== 'object' || typeof sr.name !== 'string' || !Array.isArray(sr.steps)) {
      throw new Error(`buildReport: scenarioReports[${index}] does not look like a runScenario report, got ${JSON.stringify(sr)}`);
    }

    const preservedDir = typeof sr.preservedDir === 'string' ? sr.preservedDir : undefined;

    const steps = sr.steps.map((step) => {
      totalSteps += 1;
      const violations = step.oracleFailures || [];
      const expectFailures = step.expectFailures || [];
      totalViolations += violations.length + expectFailures.length;

      if (step.mutation && !step.mutationNoop) mutationsApplied += 1;
      if (step.mutationObserved) mutationsObserved += 1;

      return {
        at: step.at,
        argv: Array.isArray(step.argv) ? step.argv : [],
        kind: step.kind,
        expectFailures,
        violations,
        smells: step.smells || [],
        mutation: step.mutation || null,
        mutationNoop: !!step.mutationNoop,
        mutationObserved: !!step.mutationObserved,
        repro: buildRepro({ preservedDir, argv: step.argv }),
      };
    });

    mergeSmellSummary(smellById, sr.smellSummary);

    return {
      name: sr.name,
      ok: !!sr.ok,
      fixture: typeof sr.fixture === 'string' ? sr.fixture : null,
      steps,
      ...(preservedDir ? { preservedDir } : {}),
    };
  });

  const totalSmells = [...smellById.values()].reduce((sum, entry) => sum + entry.count, 0);
  const smellSummary = [...smellById.entries()]
    .map(([id, entry]) => ({ id, count: entry.count, examples: entry.examples }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    reportVersion: REPORT_VERSION,
    meta,
    totals: {
      scenarios: scenarios.length,
      steps: totalSteps,
      violations: totalViolations,
      smells: totalSmells,
      mutationsApplied,
      mutationsObserved,
    },
    scenarios,
    smellSummary,
  };
}

/**
 * Serialize `reportObject` to `outPath` as pretty-printed JSON, creating any
 * missing parent directories, and return the absolute path written.
 *
 * @param {object} reportObject
 * @param {string} outPath
 * @returns {string} the absolute path the report was written to.
 */
function writeReport(reportObject, outPath) {
  if (!reportObject || typeof reportObject !== 'object') {
    throw new Error(`writeReport: reportObject must be an object, got ${JSON.stringify(reportObject)}`);
  }
  if (typeof outPath !== 'string' || outPath === '') {
    throw new Error(`writeReport: outPath must be a non-empty string, got ${JSON.stringify(outPath)}`);
  }
  const abs = path.resolve(outPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${JSON.stringify(reportObject, null, 2)}\n`, 'utf-8');
  return abs;
}

module.exports = { buildReport, writeReport, REPORT_VERSION };
