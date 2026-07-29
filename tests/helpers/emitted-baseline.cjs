'use strict';

/**
 * Baseline acquisition for the differential attribution check (ADR-2719 §5, #2723).
 *
 * The baseline is the emitted-manifest set built at `next` HEAD. It is CACHED, not
 * committed — committing it would recreate the derived-state-in-git problem this epic
 * exists to delete, and would double the rate `next` advances.
 *
 * ── The load-bearing part ────────────────────────────────────────────────────
 * ADR-2719 §5: "keyed on the `next` sha the PR was merged with. That key discipline is
 * the one thing that has to be exactly right — a stale baseline silently mis-attributes."
 *
 * Note the asymmetry that makes staleness worse than absence: a MISSING baseline fails
 * loudly and gets fixed. A STALE one produces a confident wrong answer — it attributes
 * deltas to the wrong commit's state, so real ripples read as explained. Every path
 * through this module therefore fails closed on a key mismatch.
 *
 * ── No bare `return` anywhere ────────────────────────────────────────────────
 * ADR-2719 §6 calls this out explicitly: in node:test a bare `return` is a PASS, not a
 * skip, so a baseline-unavailable path that returns would make the whole gate fail open
 * with nothing in CI to say so. This module returns an explicit {ok:false} result and
 * the caller asserts on it.
 *
 * IO is INJECTED (readJson / exists / buildFallback) so every failure mode above is
 * unit-testable without touching the filesystem or spawning 19 installers.
 */

/** Env var a CI cache-restore step points at the recovered baseline artifact. */
const BASELINE_ENV = 'GSD_EMITTED_BASELINE';

/** Default on-disk cache location, relative to the repo root. */
const DEFAULT_CACHE_PATH = '.gsd-cache/emitted-baseline.json';

/** Baseline artifact schema version — pinned so a format change fails loudly. */
const BASELINE_VERSION = 1;

/**
 * Validate a baseline artifact's shape and freshness.
 *
 * @param {*} doc          parsed artifact
 * @param {string} expectedSha  the `next` sha this PR is being evaluated against
 * @param {string} source  where it came from (named in every error)
 * @returns {{ok: true, baseline: object, sizeBaseline: object|null, sha: string}
 *          |{ok: false, errors: string[]}}
 */
function validateBaseline(doc, expectedSha, source) {
  const errors = [];

  if (doc === null || doc === undefined) {
    return { ok: false, errors: [`${source}: baseline is absent`] };
  }
  if (typeof doc !== 'object' || Array.isArray(doc)) {
    // Same class as Phase 2's fixture loader: a document that parses but is not an
    // object must never be read as "no entries", which would pass vacuously.
    return {
      ok: false,
      errors: [`${source}: baseline must be a JSON object, got ${Array.isArray(doc) ? 'array' : typeof doc}`],
    };
  }

  if (doc.version !== undefined && doc.version !== BASELINE_VERSION) {
    errors.push(`${source}: unsupported baseline version ${JSON.stringify(doc.version)} (expected ${BASELINE_VERSION})`);
  }

  if (typeof doc.sha !== 'string' || !/^[0-9a-f]{40}$/.test(doc.sha)) {
    errors.push(`${source}: baseline "sha" must be a 40-hex commit sha, got ${JSON.stringify(doc.sha)}`);
  } else if (typeof expectedSha === 'string' && expectedSha !== '' && doc.sha !== expectedSha) {
    // THE staleness gate. Never silently used.
    errors.push(
      `${source}: STALE baseline — built at ${doc.sha} but this PR is being evaluated ` +
      `against next@${expectedSha}. A stale baseline mis-attributes silently, so it is ` +
      'refused rather than used. Rebuild it, or let the in-job fallback run.',
    );
  }

  if (!doc.manifests || typeof doc.manifests !== 'object' || Array.isArray(doc.manifests)) {
    errors.push(`${source}: baseline "manifests" must be an object keyed by runtime`);
  }

  if (errors.length) return { ok: false, errors };

  return {
    ok: true,
    baseline: doc.manifests,
    sizeBaseline: (doc.sizes && typeof doc.sizes === 'object' && !Array.isArray(doc.sizes))
      ? doc.sizes
      : null,
    sha: doc.sha,
  };
}

/**
 * Resolve the baseline through the documented precedence, reporting WHICH step supplied
 * it so a failure message can say where the answer came from.
 *
 *   1. `GSD_EMITTED_BASELINE` — explicit path (CI cache restore writes here)
 *   2. the on-disk cache, validated against the expected sha
 *   3. an in-job build at `origin/next` (slow fallback)
 *   4. none → explicit failure (NEVER a silent pass)
 *
 * @param {object}   opts
 * @param {string}   opts.expectedSha    `next` sha under test
 * @param {object}   [opts.env]          environment (injected)
 * @param {string}   [opts.cachePath]
 * @param {function} opts.readJson       (path) => parsed | null  (null when absent)
 * @param {function} [opts.buildFallback] () => artifact | null   (the slow path)
 * @returns {{ok: true, via: string, baseline: object, sizeBaseline: object|null, sha: string}
 *          |{ok: false, via: string, errors: string[]}}
 */
function resolveBaseline({
  expectedSha,
  env = process.env,
  cachePath = DEFAULT_CACHE_PATH,
  readJson,
  buildFallback = null,
} = {}) {
  if (typeof readJson !== 'function') {
    return { ok: false, via: 'none', errors: ['resolveBaseline: readJson must be supplied'] };
  }

  const attempts = [];

  const envPath = env && env[BASELINE_ENV];
  if (envPath) {
    let doc = null;
    let readError = null;
    try {
      doc = readJson(envPath);
    } catch (err) {
      readError = `${BASELINE_ENV}=${envPath}: ${err.message}`;
    }
    if (readError) {
      attempts.push(readError);
    } else {
      const v = validateBaseline(doc, expectedSha, `${BASELINE_ENV}=${envPath}`);
      if (v.ok) return { ok: true, via: `env:${BASELINE_ENV}`, ...v };
      attempts.push(...v.errors);
      // An EXPLICITLY pointed-at baseline that is stale or malformed is a hard stop, not
      // a reason to quietly fall through to a different one — the operator said "use this".
      return { ok: false, via: `env:${BASELINE_ENV}`, errors: attempts };
    }
  }

  let cacheDoc = null;
  let cacheErr = null;
  try {
    cacheDoc = readJson(cachePath);
  } catch (err) {
    cacheErr = `${cachePath}: ${err.message}`;
  }
  if (cacheErr) {
    attempts.push(cacheErr);
  } else if (cacheDoc !== null && cacheDoc !== undefined) {
    const v = validateBaseline(cacheDoc, expectedSha, cachePath);
    if (v.ok) return { ok: true, via: `cache:${cachePath}`, ...v };
    // A stale CACHE is recoverable: fall through to the build fallback, but keep the
    // reason so the final message explains why the slow path ran.
    attempts.push(...v.errors);
  } else {
    attempts.push(`${cachePath}: absent`);
  }

  if (typeof buildFallback === 'function') {
    let built = null;
    try {
      built = buildFallback();
    } catch (err) {
      attempts.push(`in-job build at origin/next failed: ${err.message}`);
      return { ok: false, via: 'build', errors: attempts };
    }
    const v = validateBaseline(built, expectedSha, 'in-job build at origin/next');
    if (v.ok) return { ok: true, via: 'build', ...v };
    attempts.push(...v.errors);
    return { ok: false, via: 'build', errors: attempts };
  }

  attempts.push(
    'no baseline available and no in-job build fallback was supplied. This is a hard ' +
    'failure on purpose: a skipped propagation gate is worth less than a slow one ' +
    '(ADR-2719 §6), and in node:test a bare `return` is a PASS, not a skip.',
  );
  return { ok: false, via: 'none', errors: attempts };
}

module.exports = {
  BASELINE_ENV,
  BASELINE_VERSION,
  DEFAULT_CACHE_PATH,
  validateBaseline,
  resolveBaseline,
};
