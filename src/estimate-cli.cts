/**
 * Estimate CLI — the I/O seam over the pure phase-estimation module.
 *
 * Epic #1952 Phase 1 (#2630). Design lock: docs/adr/2629-phase-effort-estimation-calibration.md.
 *
 * `phase-estimation.cts` is pure policy; everything that touches disk or config
 * lives here. Two leaf verbs (a pair, so leaves rather than a family per
 * ADR-2346's ">=3 subcommands" rule):
 *
 *   gsd-tools query estimate-check --tokens <n>
 *   gsd-tools query estimate-calibration
 *
 * Both degrade rather than fail. A missing or corrupt
 * `.planning/estimation-calibration.json` yields an inert calibration
 * (factor 1, applied false) instead of breaking planning — the file is a disk
 * trust boundary that steers planning output, so it is parsed defensively and
 * never trusted structurally.
 */

import fs from 'node:fs';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports -- io.cjs is an export= CommonJS module
import io = require('./io.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- phase-estimation.cjs is an export= CommonJS module
import estimation = require('./phase-estimation.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- planning-workspace.cjs is an export= CommonJS module
import planningWorkspace = require('./planning-workspace.cjs');
// eslint-disable-next-line @typescript-eslint/no-require-imports -- config-loader.cjs is an export= CommonJS module
import configLoader = require('./config-loader.cjs');

const { output, error, ERROR_REASON } = io;
const { planningDir } = planningWorkspace;
const { CONFIG_DEFAULTS } = configLoader;

/** Filename of the persisted calibration document, written by extract-learnings (Phase 3). */
export const CALIBRATION_FILENAME = 'estimation-calibration.json';

function defaultBudget(): number {
  const fromManifest = Number(CONFIG_DEFAULTS.smart_zone_tokens);
  return Number.isSafeInteger(fromManifest) && fromManifest > 0 ? fromManifest : 100000;
}

/**
 * Read the configured smart-zone budget, degrading to the manifest default.
 *
 * Reads config.json directly rather than through the flat loadConfig
 * projection: a hand-edited config can hold any value, and this seam must
 * validate rather than assume. An out-of-shape value falls back to the default
 * instead of propagating NaN into the comparison.
 */
export function readSmartZoneBudget(cwd: string): number {
  try {
    const configPath = path.join(planningDir(cwd), 'config.json');
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (parsed !== null && typeof parsed === 'object') {
      const workflow = (parsed as Record<string, unknown>)['workflow'];
      if (workflow !== null && typeof workflow === 'object') {
        const value = (workflow as Record<string, unknown>)['smart_zone_tokens'];
        if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
      }
    }
  } catch {
    // Absent, unreadable, or malformed config — the default is the answer.
  }
  return defaultBudget();
}

/** Read and defensively parse the calibration history. Never throws. */
export function readCalibrationSamples(cwd: string): ReturnType<typeof estimation.parseCalibrationDocument> {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(planningDir(cwd), CALIBRATION_FILENAME), 'utf-8');
  } catch {
    return [];
  }
  return estimation.parseCalibrationDocument(raw);
}

/**
 * Parse `--tokens <n>`.
 *
 * Rejects a missing value, an empty/whitespace value, a value that is really
 * the next flag, and anything that is not a positive integer. Uses an exact
 * digit match rather than Number()/parseInt so that "1; touch x", "1e5",
 * "0x10", and " 1 " are all refused — the value reaches us as argv, is never
 * shell-interpolated, and must not be coerced into looking valid.
 */
export function parseTokensFlag(args: string[]): number {
  const idx = args.indexOf('--tokens');
  if (idx === -1) {
    error('Usage: estimate-check --tokens <positive integer>', ERROR_REASON.USAGE);
  }

  const value = args[idx + 1];
  if (value === undefined || value.startsWith('--') || !/^[0-9]+$/.test(value)) {
    error(
      `Invalid --tokens ${JSON.stringify(value ?? '')}. Must be a positive integer (token count).`,
      ERROR_REASON.USAGE,
    );
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    error(
      `Invalid --tokens ${JSON.stringify(value)}. Must be a positive integer (token count).`,
      ERROR_REASON.USAGE,
    );
  }
  return parsed;
}

/**
 * `estimate-check --tokens <n>` — classify an estimate against the configured
 * smart-zone budget, with the current calibration applied.
 *
 * The advisory contract (ADR-2629 Decision 5): this reports, it never blocks.
 * Exit status is 0 whether or not the estimate is over budget; `over_budget`
 * in the payload is the signal.
 */
export function cmdEstimateCheck(cwd: string, args: string[], raw: boolean): void {
  const rawTokens = parseTokensFlag(args);
  const budget = readSmartZoneBudget(cwd);
  const calibration = estimation.computeCalibration(readCalibrationSamples(cwd));
  const calibratedTokens = estimation.applyCalibration(rawTokens, calibration.factor);
  const classification = estimation.classifyAgainstBudget(calibratedTokens, budget);

  output({
    raw_tokens: rawTokens,
    calibrated_tokens: calibratedTokens,
    budget,
    over_budget: classification.overBudget,
    budget_valid: classification.budgetValid,
    ratio: Number(classification.ratio.toFixed(4)),
    recommendation: classification.recommendation,
    confidence: calibration.confidence,
    calibration_applied: calibration.applied,
    calibration_factor: calibration.factor,
    sample_count: calibration.sampleCount,
  }, raw);
}

/**
 * `estimate-calibration` — report the current correction factor and the
 * history behind it.
 */
export function cmdEstimateCalibration(cwd: string, _args: string[], raw: boolean): void {
  const calibration = estimation.computeCalibration(readCalibrationSamples(cwd));

  output({
    factor: calibration.factor,
    applied: calibration.applied,
    sample_count: calibration.sampleCount,
    confidence: calibration.confidence,
    clamped: calibration.clamped,
    min_samples: estimation.MIN_CALIBRATION_SAMPLES,
  }, raw);
}
