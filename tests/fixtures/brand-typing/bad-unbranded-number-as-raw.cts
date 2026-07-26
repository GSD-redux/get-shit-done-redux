/**
 * MUST NOT COMPILE (#2671) — proves the brand is not vacuously `number`.
 *
 * If `RawTokens` were a plain alias for `number`, every other fixture here would
 * still compile and the whole guard would be theatre. A bare number carries no
 * basis, so it must pass through `asRawTokens` / `asCalibratedTokens` and the
 * caller must state which one it is.
 */

import estimation = require('../../../src/phase-estimation.cjs');

export const calibrated = estimation.applyCalibration(50000, 2);
