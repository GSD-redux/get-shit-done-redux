/**
 * MUST NOT COMPILE (#2671) — the #2631 defect in its pure form.
 *
 * `gsd-planner` emitted an already-calibrated figure; `gsd-plan-checker` fed it
 * to a parameter named `rawTokens`, which applied the factor a second time. The
 * effective correction became factor^2 — with the [0.5, 3.0] clamp, anywhere
 * from 4x under to 9x over — and it was invisible below 3 samples because there
 * factor === 1 and 1^2 === 1.
 *
 * `OFFENDING` is the marker the test pins the diagnostic to — see the README.
 */

import estimation = require('../../../src/phase-estimation.cjs');

const OFFENDING = estimation.applyCalibration(estimation.asRawTokens(50000), 2);

export const squared = estimation.applyCalibration(OFFENDING, 2);
