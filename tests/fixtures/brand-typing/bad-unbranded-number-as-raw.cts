/**
 * MUST NOT COMPILE (#2671) — proves the brand is not vacuously `number`.
 *
 * If `RawTokens` were a plain alias for `number`, every other fixture here would
 * still compile and the whole guard would be theatre. A bare number carries no
 * basis, so it must pass through `asRawTokens` / `asCalibratedTokens` and the
 * caller must state which one it is.
 *
 * `OFFENDING` is the marker the test pins the diagnostic to — see the README.
 */

import estimation = require('../../../src/phase-estimation.cjs');

const OFFENDING = 50000;

export const calibrated = estimation.applyCalibration(OFFENDING, 2);
