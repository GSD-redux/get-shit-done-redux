/**
 * MUST NOT COMPILE (#2671) — laundering a corrected figure back into the basis.
 *
 * Without this guard the brand would be decorative: `asRawTokens()` would accept
 * any number, so re-labelling a calibrated figure as raw would restore both
 * shipped defects through the front door.
 *
 * The one legitimate crossover — a pre-#2632 plan whose `tokens` IS the raw
 * projection because no factor had been applied yet — lives in
 * `calibrationBasis()` behind an explicit, commented assertion, so it stays a
 * single auditable line rather than an open door.
 *
 * `OFFENDING` is the marker the test pins the diagnostic to — see the README.
 */

import estimation = require('../../../src/phase-estimation.cjs');

const OFFENDING = estimation.asCalibratedTokens(100000);

export const relabelled = estimation.asRawTokens(OFFENDING);
