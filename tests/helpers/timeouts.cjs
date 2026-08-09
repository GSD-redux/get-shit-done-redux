'use strict';

/**
 * Shared CLASS-NORM subprocess timeouts for the test suite (#3145 pre-PR
 * review finding).
 *
 * These four values are not per-suite fixture bindings — each is a fact
 * about how long a CLASS of subprocess call takes, derived from observed
 * bench behavior. Before this module existed, all four were hand-copied
 * across dozens of files with the same justifying comment restated each
 * time (52 copies across this wave's diff alone), so the norm could drift
 * silently the next time it moved — as `INSTALL_TIMEOUT_MS` already did
 * once, from 60000 to 120000, after a real bench `ETIMEDOUT`. Import from
 * here instead of re-declaring.
 *
 * This module is for the shared norms ONLY. A call site that genuinely
 * differs from its class (e.g. a real `tsc` compile in
 * tests/ensure-runtime-build.test.cjs, or a `regen:derived` run in
 * tests/fragment-single-edit-propagation.install.test.cjs) keeps its own
 * local constant with its own justifying comment — do not force those
 * sites onto a shared value that doesn't describe them.
 */

const { DEFAULT_GIT_TIMEOUT_MS } = require('./git-fixture.cjs');

/**
 * A single short CLI query or `node -e` probe against a temp fixture —
 * e.g. reading back a version string or a small piece of emitted state.
 * 15000ms is well over any observed duration for that class of call.
 */
const PROBE_TIMEOUT_MS = 15000;

/**
 * Git plumbing (rev-parse, branch, log, ...) against a small mkdtemp
 * fixture repo. Re-exports `tests/helpers/git-fixture.cjs`'s
 * `DEFAULT_GIT_TIMEOUT_MS` rather than restating the literal, so the two
 * can never disagree.
 */
const GIT_TIMEOUT_MS = DEFAULT_GIT_TIMEOUT_MS;

/**
 * Hooks bundling via `scripts/build-hooks.js` (not a full project build —
 * see per-site comments for sites that run a heavier build and therefore
 * keep a larger local value). 30000ms is well over any observed duration
 * for a hooks-only bundle pass.
 */
const BUILD_TIMEOUT_MS = 30000;

/**
 * A full `bin/install.js` run. Idle runs measure 13-30s; a load-tested
 * bench recorded a real `spawnSync ETIMEDOUT` at a 60000ms cap
 * (tests/install.test.cjs:5505-5513) while another lane passed the SAME
 * commit in 12.7s — 60000 is too tight for this class of spawn under
 * load. 120000ms is the load-tested norm.
 */
const INSTALL_TIMEOUT_MS = 120000;

module.exports = {
  PROBE_TIMEOUT_MS,
  GIT_TIMEOUT_MS,
  BUILD_TIMEOUT_MS,
  INSTALL_TIMEOUT_MS,
};
