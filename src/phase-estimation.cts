/**
 * Phase Estimation — estimate/actuals schema, smart-zone threshold policy, and
 * estimate-vs-actual calibration.
 *
 * Epic #1952, Phase 1 (#2630). Design lock: docs/adr/2629-phase-effort-estimation-calibration.md.
 *
 * Pure functions only — no I/O, no config reads. Callers supply the budget and
 * the raw calibration document; this module decides policy over them. The CLI
 * seam (gsd-tools) owns reading `.planning/config.json` and
 * `.planning/estimation-calibration.json`.
 *
 * Two properties this module exists to preserve, both from ADR-2629:
 *
 *   1. Every signal is EXOGENOUS. The correction routes on a measured
 *      actual/estimate ratio; `confidence` routes on a calibration sample
 *      count. Nothing routes on a model's self-assessment. This project
 *      measured self-rated confidence and found it weak
 *      (gsd-core/references/honest-verifier.md:25-29 — "on a true blind spot it
 *      stays confidently wrong"), which is why deriveConfidence() takes a
 *      sample count and there is no "how sure are you?" input anywhere here.
 *
 *   2. Estimate and actual share ONE measurement scale — estimateTokens() from
 *      prompt-budget. A ratio between two different measurement methods would
 *      measure the methods, not the miss. measureTokens() below is the single
 *      re-export so no consumer reaches for a second estimator.
 *
 * ADR-457 build-at-publish: source here, compiled to
 * gsd-core/bin/lib/phase-estimation.cjs (gitignored).
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports -- prompt-budget.cjs is an export= CommonJS module
import promptBudget = require('./prompt-budget.cjs');

const { estimateTokens } = promptBudget;

/** Confidence in an estimate. DERIVED from calibration sample count — never self-rated. */
export type Confidence = 'low' | 'med' | 'high';

export const CONFIDENCE_VALUES: readonly Confidence[] = Object.freeze(['low', 'med', 'high'] as const);

/** Below this many calibration samples, no correction is applied (ADR-2629 Decision 4). */
export const MIN_CALIBRATION_SAMPLES = 3;

/** Sample-count thresholds for derived confidence (ADR-2629 Decision 1). */
export const CONFIDENCE_MED_MIN_SAMPLES = 3;
export const CONFIDENCE_HIGH_MIN_SAMPLES = 6;

/** Correction-factor clamp. Outside this range the estimator is wrong in kind, not degree. */
export const CALIBRATION_FACTOR_MIN = 0.5;
export const CALIBRATION_FACTOR_MAX = 3.0;

/** Schema version for the persisted calibration document. */
export const CALIBRATION_SCHEMA_VERSION = 1;

export interface PhaseEstimate {
  tokens: number;
  tasks: number;
  confidence: Confidence;
  /**
   * The planner's UNCALIBRATED projection, before the correction factor was
   * applied. Optional for backward compatibility with plans written before
   * #2632.
   *
   * Calibration MUST measure actual/raw, not actual/calibrated. Measuring
   * against the already-corrected figure makes the loop self-defeating: once
   * the correction works, the observed ratio approaches 1, which drags the
   * median back toward 1, which un-corrects the next estimate. Simulated over
   * 10 phases with a true 2x underestimate, that oscillates and settles at
   * ~1.41 instead of converging on 2.0.
   */
  rawTokens?: number;
}

export interface PhaseActuals {
  tokens: number;
  tasks: number;
  commits: number;
}

export interface BudgetClassification {
  /** True only when the estimate strictly exceeds the budget. At the budget exactly, false. */
  overBudget: boolean;
  /** estimate / budget. 0 when the budget is unusable. */
  ratio: number;
  /** Human-facing split advice. Null unless overBudget. Advisory — never a block. */
  recommendation: string | null;
  /** False when the supplied budget was not a positive finite number. */
  budgetValid: boolean;
}

export interface CalibrationSample {
  estimateTokens: number;
  actualTokens: number;
}

export interface CalibrationResult {
  /** Multiply a raw estimate by this. Exactly 1 when not applied. */
  factor: number;
  /** Count of USABLE samples (both sides positive and finite). */
  sampleCount: number;
  /** True once sampleCount >= MIN_CALIBRATION_SAMPLES. */
  applied: boolean;
  /** Derived from sampleCount — the same signal, surfaced for the estimate block. */
  confidence: Confidence;
  /** True when the median ratio fell outside the clamp and was pinned to a bound. */
  clamped: boolean;
}

/**
 * A positive, finite, safe integer. Rejects NaN, Infinity, negatives, zero,
 * non-integers, and anything past MAX_SAFE_INTEGER (where integer arithmetic
 * silently stops being exact).
 */
function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value > 0;
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function isConfidence(value: unknown): value is Confidence {
  return typeof value === 'string' && (CONFIDENCE_VALUES as readonly string[]).includes(value);
}

/**
 * A usable calibration sample: both sides present, positive, and finite.
 * A zero or negative estimate would divide to Infinity or flip the ratio's
 * sign, so those are dropped rather than coerced.
 */
function isCalibrationSample(value: unknown): value is CalibrationSample {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return isPositiveFinite(record['estimateTokens']) && isPositiveFinite(record['actualTokens']);
}

/**
 * Measure text on the canonical scale. The ONE estimator both the estimate and
 * the actuals must use — see property 2 in the module header.
 */
export function measureTokens(text: string | null | undefined): number {
  return estimateTokens(text);
}

/**
 * Derive confidence from how much measured history backs the estimate.
 *
 * Exogenous by construction: the input is a count, not a judgment. A non-integer
 * or negative count degrades to 'low' rather than throwing — an unusable history
 * is exactly the low-confidence case.
 */
export function deriveConfidence(sampleCount: unknown): Confidence {
  if (typeof sampleCount !== 'number' || !Number.isFinite(sampleCount) || sampleCount < 0) return 'low';
  if (sampleCount >= CONFIDENCE_HIGH_MIN_SAMPLES) return 'high';
  if (sampleCount >= CONFIDENCE_MED_MIN_SAMPLES) return 'med';
  return 'low';
}

/**
 * Classify an estimate against the smart-zone budget.
 *
 * Boundary contract (ADR-2629 Decision 3 + RULESET.TESTS.boundary-coverage.fixtures):
 * budget-1 → under, budget → under, budget+1 → over. The comparison is strictly
 * greater-than, so landing exactly on the budget is not a violation.
 *
 * An unusable budget (hand-edited config, missing key) never fabricates a
 * violation: it reports budgetValid=false and overBudget=false, so a broken
 * config cannot spam split recommendations.
 */
export function classifyAgainstBudget(estimate: unknown, budget: unknown): BudgetClassification {
  if (!isPositiveFinite(budget) || !isPositiveFinite(estimate)) {
    return { overBudget: false, ratio: 0, recommendation: null, budgetValid: isPositiveFinite(budget) };
  }

  const ratio = estimate / budget;
  if (estimate <= budget) {
    return { overBudget: false, ratio, recommendation: null, budgetValid: true };
  }

  const slices = Math.ceil(ratio);
  return {
    overBudget: true,
    ratio,
    recommendation:
      `Estimated ${estimate} tokens exceeds the ${budget}-token smart-zone budget `
      + `(${ratio.toFixed(2)}x). Consider splitting this phase into about ${slices} `
      + `slices — a tracer plus ${slices - 1} expansion slice(s) — so each runs inside the budget.`,
    budgetValid: true,
  };
}

/** Median of a non-empty numeric array. Caller guarantees non-empty. */
function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Compute the correction factor from estimate/actual history.
 *
 * Median, not mean — one pathological phase (an aborted run, a mass rename)
 * must not swing every later projection. Clamped, because a ratio outside
 * [0.5, 3.0] means the estimator is wrong in kind and amplifying it would make
 * the next estimate worse, not better.
 *
 * Samples missing either side, or carrying a non-positive/non-finite value, are
 * dropped rather than coerced — a zero estimate would divide to Infinity.
 */
export function computeCalibration(samples: unknown): CalibrationResult {
  const candidates: unknown[] = Array.isArray(samples) ? samples : [];
  const usable = candidates.filter(isCalibrationSample);

  const sampleCount = usable.length;
  const confidence = deriveConfidence(sampleCount);

  if (sampleCount < MIN_CALIBRATION_SAMPLES) {
    return { factor: 1, sampleCount, applied: false, confidence, clamped: false };
  }

  const ratios = usable.map((s) => s.actualTokens / s.estimateTokens).sort((a, b) => a - b);
  const raw = median(ratios);
  const factor = Math.min(CALIBRATION_FACTOR_MAX, Math.max(CALIBRATION_FACTOR_MIN, raw));

  return { factor, sampleCount, applied: true, confidence, clamped: factor !== raw };
}

/**
 * Apply a correction factor to a raw estimate. Rounds to an integer because
 * `estimate.tokens` is an integer field; floors at 1 so a heavy shrink factor
 * can never produce a zero-token estimate.
 */
export function applyCalibration(rawTokens: unknown, factor: unknown): number {
  if (!isPositiveFinite(rawTokens)) return 0;
  if (!isPositiveFinite(factor)) return Math.max(1, Math.round(rawTokens));
  // Bound the product: an inexact float past MAX_SAFE_INTEGER would masquerade
  // as an integer token count. Unreachable through today's CLI (which is
  // safe-integer bounded) but the function is exported and must not depend on
  // its caller for that guarantee.
  const scaled = Math.round(rawTokens * factor);
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(1, scaled));
}

/**
 * Extract a two-space-indented scalar block (`estimate:` / `actuals:`) out of a
 * document's leading YAML frontmatter.
 *
 * Hand-rolled because gsd-core ships no external dependencies (CONTRIBUTING.md
 * "No external dependencies in core") — js-yaml is a devDependency and is not
 * available at runtime. Scope is deliberately narrow: the leading `---` block
 * only, so a `estimate:` line inside a fenced code block in the body cannot be
 * mistaken for frontmatter (the DEFECT.FRONTMATTER-SCALAR-BROAD-GREP class).
 *
 * Numeric-looking values are returned as numbers so parseEstimate/parseActuals
 * see the types they validate; everything else stays a string.
 */
export function extractFrontmatterBlock(text: unknown, key: string): Record<string, unknown> | null {
  if (typeof text !== 'string') return null;

  // Anchor at byte 0 — CRLF-tolerant.
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?(?:\n|$)/.exec(text);
  if (fm === null) return null;

  const lines = fm[1].split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l === `${key}:` || l.startsWith(`${key}:`));
  if (startIdx === -1) return null;

  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (let i = startIdx + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^\s/.test(line)) break;            // dedent ends the block
    const m = /^\s+([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (m === null) continue;
    const rawValue = m[2].replace(/\s+#.*$/, '').trim();
    if (rawValue === '') continue;
    const asNumber = Number(rawValue);
    out[m[1]] = /^-?\d+(?:\.\d+)?$/.test(rawValue) && Number.isFinite(asNumber)
      ? asNumber
      : rawValue.replace(/^['"]|['"]$/g, '');
  }
  return Object.keys(out).length > 0 ? { ...out } : null;
}

/** Pull the `estimate:` mapping out of an already-parsed frontmatter object. */
function estimateBlockOf(input: unknown): unknown {
  if (input === null || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(record, 'estimate') ? record['estimate'] : record;
}

/**
 * Parse an estimate block. Returns null for anything that is not a complete,
 * well-typed estimate — a partial block is not a usable estimate, and silently
 * defaulting a missing field would fabricate data the planner never produced.
 *
 * Accepts either the whole frontmatter object (`{estimate: {...}}`) or the
 * estimate mapping itself, so callers need not unwrap.
 */
export function parseEstimate(input: unknown): PhaseEstimate | null {
  const block = estimateBlockOf(input);
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return null;

  const record = block as Record<string, unknown>;
  const tokens = record['tokens'];
  const tasks = record['tasks'];
  const confidence = record['confidence'];

  if (!isPositiveInt(tokens) || !isPositiveInt(tasks) || !isConfidence(confidence)) return null;

  const rawTokens = record['raw_tokens'];
  return isPositiveInt(rawTokens)
    ? { tokens, tasks, confidence, rawTokens }
    : { tokens, tasks, confidence };
}

/** Pull the `actuals:` mapping out of an already-parsed frontmatter object. */
function actualsBlockOf(input: unknown): unknown {
  if (input === null || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(record, 'actuals') ? record['actuals'] : record;
}

/**
 * Parse an actuals block. `commits` may be 0 — a phase can legitimately record
 * zero commits — so it is validated as a non-negative integer while tokens and
 * tasks stay strictly positive.
 */
export function parseActuals(input: unknown): PhaseActuals | null {
  const block = actualsBlockOf(input);
  if (block === null || typeof block !== 'object' || Array.isArray(block)) return null;

  const record = block as Record<string, unknown>;
  const tokens = record['tokens'];
  const tasks = record['tasks'];
  const commits = record['commits'];

  if (!isPositiveInt(tokens) || !isPositiveInt(tasks)) return null;
  if (typeof commits !== 'number' || !Number.isSafeInteger(commits) || commits < 0) return null;

  return { tokens, tasks, commits };
}

/**
 * Render an estimate as the YAML block that lands in PLAN.md frontmatter.
 * Inverse of parseEstimate over the same value domain — the bijection the
 * property test pins.
 */
export function renderEstimate(estimate: PhaseEstimate): string {
  const lines = [
    'estimate:',
    `  tokens: ${estimate.tokens}`,
  ];
  if (isPositiveInt(estimate.rawTokens)) lines.push(`  raw_tokens: ${estimate.rawTokens}`);
  lines.push(`  tasks: ${estimate.tasks}`, `  confidence: ${estimate.confidence}`);
  return lines.join('\n');
}

/**
 * The figure calibration must measure against: the uncalibrated projection when
 * the plan recorded one, else the stored value (pre-#2632 plans, where the two
 * were the same because no factor had yet been applied).
 */
export function calibrationBasis(estimate: PhaseEstimate): number {
  return isPositiveInt(estimate.rawTokens) ? estimate.rawTokens : estimate.tokens;
}

/** Render an actuals block for SUMMARY.md frontmatter. Inverse of parseActuals. */
export function renderActuals(actuals: PhaseActuals): string {
  return [
    'actuals:',
    `  tokens: ${actuals.tokens}`,
    `  tasks: ${actuals.tasks}`,
    `  commits: ${actuals.commits}`,
  ].join('\n');
}

export interface CalibrationDocument {
  schema_version: number;
  samples: CalibrationSample[];
}

/**
 * Parse the persisted calibration document.
 *
 * This is a trust boundary: the file is on disk, may be hand-edited, and its
 * contents steer planning output. Every failure mode degrades to an empty
 * sample set rather than throwing or partially trusting — malformed JSON, a
 * non-object root, a missing/!== current schema_version, a non-array samples
 * field, or individual malformed samples.
 *
 * A schema_version we do not recognize is refused outright rather than
 * best-effort read: a future writer may change the ratio's meaning, and
 * misreading it would silently corrupt every subsequent estimate.
 */
export function parseCalibrationDocument(raw: unknown): CalibrationSample[] {
  if (typeof raw !== 'string' || raw.trim() === '') return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return [];

  const doc = parsed as Record<string, unknown>;
  if (doc['schema_version'] !== CALIBRATION_SCHEMA_VERSION) return [];
  if (!Array.isArray(doc['samples'])) return [];

  // Rebuild each sample from its two known fields rather than passing the
  // parsed object through — a hostile document cannot smuggle extra keys
  // (or a __proto__ payload) into anything downstream.
  return (doc['samples'] as unknown[])
    .filter(isCalibrationSample)
    .map((s) => ({ estimateTokens: s.estimateTokens, actualTokens: s.actualTokens }));
}

/** Serialize a calibration document. Inverse of parseCalibrationDocument. */
export function renderCalibrationDocument(samples: CalibrationSample[]): string {
  const doc: CalibrationDocument = { schema_version: CALIBRATION_SCHEMA_VERSION, samples };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
