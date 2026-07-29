/**
 * POSITIVE CONTROL (#2671) — the correct composition must compile clean.
 *
 * Without this, every `bad-*` fixture could be passing for the wrong reason (a
 * typo, a bad import path, a mis-built compiler option set) and the suite would
 * still be green. This file is what makes the negative fixtures non-vacuous.
 */

import estimation = require('../../../src/phase-estimation.cjs');

const FACTOR = 2;
const BUDGET = 100000;

// argv/disk figure -> caller asserts the basis -> correction -> budget verdict.
const raw = estimation.asRawTokens(50000);
const calibrated = estimation.applyCalibration(raw, FACTOR);
export const verdict = estimation.classifyAgainstBudget(calibrated, BUDGET);

// `estimate-check --calibrated`: the caller states the factor is already applied,
// so the figure goes straight to the budget without a second correction.
export const preCalibratedVerdict = estimation.classifyAgainstBudget(
  estimation.asCalibratedTokens(50000),
  BUDGET,
);

// ADR-2629 Decision 4: the calibration denominator is the RAW basis.
const estimate: estimation.PhaseEstimate = {
  tokens: estimation.asCalibratedTokens(100000),
  rawTokens: estimation.asRawTokens(50000),
  tasks: 5,
  confidence: 'med',
};

export const sample: estimation.CalibrationSample = {
  estimateTokens: estimation.calibrationBasis(estimate),
  actualTokens: 74000,
};
