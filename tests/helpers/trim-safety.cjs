'use strict';

/**
 * trim-safety.cjs — the trim-safety contract gate over `ComposeMetadata`
 * (issue #2931, epic #1671, Phase 4).
 *
 * `composeWithinBudget` (src/context-composer.cts) is a pressure-aware
 * budgeter: under load it may shrink, floor, or drop fragments entirely. This
 * module is the gate a caller runs AFTER composing to prove that pressure
 * never silently touched a fragment the caller has declared load-bearing —
 * an id whose full, unshrunk content the caller is relying on to be present.
 *
 * Pure: no fs, no git, no clock. It only ever reads the `ComposeMetadata`
 * shape (`omitted`, `shrunk`, `floored`, `isolatePrefix`, `hardFailed`,
 * `hardFailReason`) and a caller-declared `loadBearingIds` list.
 *
 * ── The anti-vacuity rule is the most important rule in this module ────────
 * A trim-safety gate that runs with an EMPTY `loadBearingIds` set would pass
 * on every input, forever, having asserted nothing at all — the exact "looks
 * like coverage and is not" failure this repo's test-matrix discipline
 * exists to catch. `loadBearingIds` empty or absent is therefore a hard
 * error (REASON.NO_LOAD_BEARING_DECLARED), not a vacuous pass.
 */

const REASON = Object.freeze({
  LOAD_BEARING_OMITTED: 'load_bearing_omitted',
  LOAD_BEARING_SHRUNK: 'load_bearing_shrunk',
  ISOLATE_PREFIX_DRIFT: 'isolate_prefix_drift',
  MINIMUM_SET_HARD_FAIL: 'minimum_set_hard_fail',
  NO_LOAD_BEARING_DECLARED: 'no_load_bearing_declared',
});

/** Stable comparator over findings of possibly-different shapes: sort by
 *  `reason`, then by `id` (absent for ISOLATE_PREFIX_DRIFT, which sorts
 *  first within its reason bucket via the empty-string fallback). */
function byReasonThenId(a, b) {
  if (a.reason !== b.reason) return a.reason < b.reason ? -1 : 1;
  const aId = a.id || '';
  const bId = b.id || '';
  if (aId === bId) return 0;
  return aId < bId ? -1 : 1;
}

/**
 * Evaluate a compose result against a caller-declared load-bearing set.
 *
 * @param {object} opts
 * @param {object} opts.metadata          a `ComposeMetadata` from
 *   `composeWithinBudget` (src/context-composer.cts): `omitted`, `shrunk`,
 *   `floored` (string[] fragment ids), `isolatePrefix` (string),
 *   `hardFailed` (boolean), `hardFailReason` ('minimum-set' | null).
 * @param {string[]} opts.loadBearingIds  fragment ids the caller declares
 *   must survive intact. MUST be non-empty — see the anti-vacuity rule above.
 * @param {string} [opts.expectedIsolatePrefix] when provided, the exact
 *   byte-for-byte prefix `metadata.isolatePrefix` must equal.
 * @returns {{ findings: Array, errors: Array, ok: boolean }}
 */
function evaluateTrimSafety({ metadata, loadBearingIds, expectedIsolatePrefix } = {}) {
  if (!Array.isArray(loadBearingIds) || loadBearingIds.length === 0) {
    // Anti-vacuity: return immediately. Every other check below would be
    // evaluated against a caller who declared nothing worth protecting, so
    // computing them would dress up "proves nothing" as a real result.
    return {
      findings: [],
      errors: [{
        reason: REASON.NO_LOAD_BEARING_DECLARED,
        message:
          'loadBearingIds must be a non-empty array — a trim-safety gate with an empty '
          + 'assertion set proves nothing',
      }],
      ok: false,
    };
  }

  const errors = [];
  const findings = [];

  const meta = metadata && typeof metadata === 'object' ? metadata : {};
  const omitted = Array.isArray(meta.omitted) ? meta.omitted : [];
  const shrunk = Array.isArray(meta.shrunk) ? meta.shrunk : [];

  if (meta.hardFailed === true) {
    errors.push({
      reason: REASON.MINIMUM_SET_HARD_FAIL,
      hardFailReason: meta.hardFailReason ?? null,
      message: 'compose hard-failed (minimum required set could not fit the budget) — never a silent empty compose',
    });
  }

  for (const id of loadBearingIds) {
    if (omitted.includes(id)) {
      findings.push({ reason: REASON.LOAD_BEARING_OMITTED, id });
    }
    if (shrunk.includes(id)) {
      findings.push({ reason: REASON.LOAD_BEARING_SHRUNK, id });
    }
    // `floored` is deliberately never a finding: it means the floor did its
    // job and the fragment's declared minimum survived.
  }

  if (expectedIsolatePrefix !== undefined) {
    const actual = typeof meta.isolatePrefix === 'string' ? meta.isolatePrefix : '';
    if (actual !== expectedIsolatePrefix) {
      // Byte-identical means byte-identical: no trimming, no normalizing —
      // a trailing-whitespace-only difference IS drift.
      findings.push({ reason: REASON.ISOLATE_PREFIX_DRIFT, expected: expectedIsolatePrefix, actual });
    }
  }

  findings.sort(byReasonThenId);

  const ok = errors.length === 0 && findings.length === 0;

  return { findings, errors, ok };
}

module.exports = {
  REASON,
  evaluateTrimSafety,
};
