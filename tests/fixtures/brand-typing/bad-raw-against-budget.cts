/**
 * MUST NOT COMPILE (#2671) — an uncorrected projection compared to the budget.
 *
 * The smart-zone verdict is only meaningful against the project's corrected
 * figure. Classifying the raw projection reports the estimator's bias as if it
 * were the phase's size, and silently under-reports every over-budget phase on
 * a project whose factor is above 1.
 */

import estimation = require('../../../src/phase-estimation.cjs');

export const verdict = estimation.classifyAgainstBudget(estimation.asRawTokens(50000), 100000);
