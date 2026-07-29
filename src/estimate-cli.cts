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

// WIN-1 parity (DEFECT.WINDOWS-FS-OPS): on Windows a concurrent reader, indexer,
// or AV scanner can transiently hold the rename target open. Retry the transient
// errnos with backoff, matching the writeLedger / writeConsentStore idiom.
const RENAME_RETRY_ERRNOS = new Set(['EPERM', 'EBUSY', 'EACCES']);
const RENAME_MAX_ATTEMPTS = 3;
const RENAME_RETRY_BACKOFF_MS = 50;
let _renameSleepBuf: Int32Array | null = null;
function renameBackoff(): void {
  if (_renameSleepBuf === null) _renameSleepBuf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(_renameSleepBuf, 0, 0, RENAME_RETRY_BACKOFF_MS);
}

/** Rename with a bounded retry on the transient Windows errnos. Rethrows anything else. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 1; ; attempt += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (attempt < RENAME_MAX_ATTEMPTS && RENAME_RETRY_ERRNOS.has(code)) {
        renameBackoff();
        continue;
      }
      throw err;
    }
  }
}

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
 *
 * Returns a PLAIN number, deliberately (#2671). This function validates the
 * magnitude of `--tokens`; it cannot know the figure's basis, because that is
 * decided by a DIFFERENT flag (`--calibrated`). Branding here would force it to
 * pick RawTokens or CalibratedTokens for every caller, and it would be wrong
 * half the time — a type that lies is worse than no type. The basis assertion
 * therefore belongs to the caller that reads both flags; today that is
 * `cmdEstimateCheck`, which is this function's only caller. A future second
 * caller must make the same assertion explicitly rather than inherit a guess.
 */
export function parseTokensFlag(args: string[]): number {
  const idx = args.indexOf('--tokens');
  if (idx === -1) {
    error('Usage: estimate-check --tokens <positive integer> [--calibrated]', ERROR_REASON.USAGE);
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
  const inputTokens = parseTokensFlag(args);
  const preCalibrated = args.includes('--calibrated');
  const budget = readSmartZoneBudget(cwd);
  const calibration = estimation.computeCalibration(readCalibrationSamples(cwd));
  // `--calibrated` says the caller already applied the factor. Without it we
  // would apply the correction a SECOND time and compare factor^2 against the
  // budget — with the [0.5, 3.0] clamp that is anywhere from 4x under to 9x
  // over, and it is invisible until a project reaches 3 samples (below that
  // factor === 1, and 1^2 === 1). A plan's recorded `estimate.tokens` is
  // calibrated at emission time per ADR-2629 Decision 1, so the plan-checker
  // MUST pass this flag.
  //
  // `--calibrated` is the whole basis question, and argv cannot answer it for
  // the type system — so this is where the caller's claim is turned into a type
  // (#2671). Past this expression the basis is carried by RawTokens /
  // CalibratedTokens and the wrong composition stops compiling; the ambiguity
  // is confined to these two lines instead of running the length of the seam.
  const calibratedTokens = preCalibrated
    ? estimation.asCalibratedTokens(inputTokens)
    : estimation.applyCalibration(estimation.asRawTokens(inputTokens), calibration.factor);
  const classification = estimation.classifyAgainstBudget(calibratedTokens, budget);

  output({
    raw_tokens: inputTokens,
    calibrated_tokens: calibratedTokens,
    pre_calibrated: preCalibrated,
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
 * Pair each completed phase's PLAN estimate with its SUMMARY actuals.
 *
 * A phase contributes a sample only when BOTH sides are present and well-formed.
 * A plan with no `estimate` block, a summary with no `actuals`, or a malformed
 * value is skipped rather than guessed — a fabricated sample would silently
 * steer every future estimate.
 */
export function collectCalibrationSamples(cwd: string): estimation.CalibrationSample[] {
  const phasesRoot = path.join(planningDir(cwd), 'phases');
  let phases: string[];
  try {
    phases = fs.readdirSync(phasesRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }

  const readBlock = (file: string, key: string): Record<string, unknown> | null => {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf-8');
    } catch {
      return null;
    }
    return estimation.extractFrontmatterBlock(text, key);
  };

  const samples: estimation.CalibrationSample[] = [];
  for (const phase of phases) {
    const dir = path.join(phasesRoot, phase);
    let files: string[];
    try {
      files = fs.readdirSync(dir).sort();
    } catch {
      continue;
    }

    // Pair PER PLAN, keyed on the `<NN>-<PP>` stem, NOT per phase directory.
    // A phase routinely holds several plans (docs/reference/planning-artifacts.md:
    // "one file per plan"). Taking the first plan with an estimate and the first
    // summary with actuals independently cross-pairs one plan's projection with
    // another's cost — a fabricated sample — and discards every later plan.
    const stems = new Map<string, { plan?: string; summary?: string }>();
    for (const f of files) {
      const m = /^(.*?)-(PLAN|SUMMARY)\.md$/.exec(f);
      if (m === null) continue;
      const stem = m[1];
      const entry = stems.get(stem) ?? {};
      if (m[2] === 'PLAN') entry.plan = path.join(dir, f);
      else entry.summary = path.join(dir, f);
      stems.set(stem, entry);
    }

    for (const stem of [...stems.keys()].sort()) {
      const { plan, summary } = stems.get(stem) as { plan?: string; summary?: string };
      if (plan === undefined || summary === undefined) continue;

      const estimate = estimation.parseEstimate(readBlock(plan, 'estimate'));
      const actuals = estimation.parseActuals(readBlock(summary, 'actuals'));
      if (estimate === null || actuals === null) continue;

      // Measure against the RAW projection — see PhaseEstimate.rawTokens for why
      // measuring against the calibrated figure makes the loop self-defeating.
      samples.push({
        estimateTokens: estimation.calibrationBasis(estimate),
        actualTokens: actuals.tokens,
      });
    }
  }
  return samples;
}

/**
 * `estimate-calibrate` — rebuild the calibration document from completed phases.
 *
 * Rebuilds from scratch every run rather than appending, so it is idempotent and
 * a corrupt prior document is replaced rather than merged. This is the verb that
 * closes the loop (#1952 AC4): extract-learnings invokes it, and the planner's
 * next estimate reads the result.
 */
export function cmdEstimateCalibrate(cwd: string, _args: string[], raw: boolean): void {
  const samples = collectCalibrationSamples(cwd);
  const calibration = estimation.computeCalibration(samples);

  const target = path.join(planningDir(cwd), CALIBRATION_FILENAME);
  let written = true;
  let writeError: string | null = null;
  try {
    // Write-then-rename: a direct writeFileSync can leave a truncated file if
    // interrupted, and parseCalibrationDocument treats malformed JSON exactly
    // like "no history yet" — so a torn write would silently erase the
    // calibration instead of surfacing.
    const tmp = `${target}.tmp-${String(process.pid)}`;
    try {
      fs.writeFileSync(tmp, estimation.renderCalibrationDocument(samples), 'utf-8');
      renameWithRetry(tmp, target);
    } catch (err) {
      // Never leave the temp behind for a later run to trip over.
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
      throw err;
    }
  } catch (err) {
    // Persisting is best-effort: a read-only .planning must not fail the phase.
    // But report WHY — a genuine bug and a benign permission issue are otherwise
    // indistinguishable to both the caller and the workflow.
    written = false;
    writeError = err instanceof Error ? (err.message || String(err)) : String(err);
  }

  output({
    factor: calibration.factor,
    applied: calibration.applied,
    sample_count: calibration.sampleCount,
    confidence: calibration.confidence,
    clamped: calibration.clamped,
    min_samples: estimation.MIN_CALIBRATION_SAMPLES,
    written,
    write_error: writeError,
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
