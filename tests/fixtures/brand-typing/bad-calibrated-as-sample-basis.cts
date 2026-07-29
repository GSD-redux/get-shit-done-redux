/**
 * MUST NOT COMPILE (#2671) — the #2632 defect: the self-defeating loop.
 *
 * Calibration must measure actual/raw. Measuring actual/calibrated makes the
 * loop un-correct itself: once the correction works the observed ratio
 * approaches 1, which drags the median back toward 1. Simulated over 10 phases
 * against a true 2x miss it oscillates and settles near 1.41 instead of
 * converging on 2.0 (ADR-2629 Decision 4, amended #2632).
 *
 * `OFFENDING` is the marker the test pins the diagnostic to — see the README.
 * TypeScript reports an object-literal property mismatch on the property NAME,
 * so the test accepts that span too.
 */

import estimation = require('../../../src/phase-estimation.cjs');

const estimate: estimation.PhaseEstimate = {
  tokens: estimation.asCalibratedTokens(100000),
  rawTokens: estimation.asRawTokens(50000),
  tasks: 5,
  confidence: 'med',
};

const OFFENDING = estimate.tokens;

export const sample: estimation.CalibrationSample = {
  estimateTokens: OFFENDING,
  actualTokens: 74000,
};
