#!/usr/bin/env node
'use strict';

/**
 * Deterministic latest-version check for /gsd-update (#2992).
 *
 * The /gsd-update workflow's check_latest_version step was previously
 * prescribed in LLM-driven prose ("run `npm view gsd-core
 * version`"). The executing model could shortcut the prescription and
 * invent npm queries against wrong-shaped names (`@gsd-core/cli`,
 * `get-shit-done-cli`, `gsd`), all of which 404 or — worse — return an
 * unrelated typosquat package.
 *
 * This script makes the package name a CONSTANT in code, not a free
 * choice at execution time. The workflow calls it via `npm run
 * check-latest-version -- --json` and parses the structured response.
 *
 * Tests assert on the typed CHECK_REASON enum and the structured result
 * record, never on console prose. See CONTRIBUTING.md "Prohibited: Raw
 * Text Matching on Test Outputs".
 */

const { execNpm } = require('./lib/shell-command-projection.cjs');
const { runMain } = require('./lib/cli-exit.cjs');

// Sourced from the single Package Identity seam (#498), not re-typed. The seam
// bakes the value from package.json at build time, so it is a code constant —
// still NOT a runtime choice for the caller (#2992) — and a rename propagates
// from one place (#378). The drift-guard lint forbids re-introducing a literal.
const { packageName: PACKAGE_NAME } = require('./lib/package-identity.cjs');

const CHECK_REASON = Object.freeze({
  OK: 'ok',
  FAIL_NPM_FAILED: 'fail_npm_failed',
  FAIL_INVALID_OUTPUT: 'fail_invalid_output',
});

const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

// #815: the one RC channel ADR #660 sanctions, plus the stable default.
// An allowlist (not a free string) keeps a typo from silently resolving
// `npm view` to an empty or foreign dist-tag.
const ALLOWED_TAGS = Object.freeze(['latest', 'next']);

// Bounded at 15s so a hung registry doesn't block /gsd-update (#2993 CR).
// Exported so callers (e.g. the worker's own test harness, #4091) can derive
// their own outer timeout with real margin above this inner bound instead of
// re-hardcoding 15000 and silently drifting into a zero-margin race.
const NPM_VIEW_TIMEOUT_MS = 15_000;

/**
 * Build the `npm view` args for a dist-tag. `latest` keeps the bare package
 * spec so the default invocation is byte-for-byte identical to before tag
 * support existed (#815); any other allowlisted tag appends `@<tag>` so
 * `npm view @opengsd/gsd-core@next version` resolves the RC channel (#660).
 */
function buildViewArgs(tag = 'latest') {
  if (!ALLOWED_TAGS.includes(tag)) {
    throw new RangeError(`invalid dist-tag '${tag}'; allowed: ${ALLOWED_TAGS.join(', ')}`);
  }
  const spec = tag === 'latest' ? PACKAGE_NAME : `${PACKAGE_NAME}@${tag}`;
  return ['view', spec, 'version'];
}

/**
 * Resolve the requested dist-tag from argv. Defaults to `latest` (no flag =>
 * no behavior change). Restricted to ALLOWED_TAGS so a typo can't silently
 * resolve to an empty/foreign tag (#815 alternative 1).
 */
function resolveTag(argv) {
  let val;
  const eq = argv.find((a) => typeof a === 'string' && a.startsWith('--tag='));
  if (eq !== undefined) {
    val = eq.slice('--tag='.length);
  } else {
    const i = argv.indexOf('--tag');
    if (i === -1) return 'latest';
    val = argv[i + 1];
  }
  if (!val || !ALLOWED_TAGS.includes(val)) {
    throw new RangeError(
      `invalid --tag '${val || ''}'; allowed: ${ALLOWED_TAGS.join(', ')}`,
    );
  }
  return val;
}

/**
 * Pure-ish: takes an injected spawn function so tests don't actually run npm.
 * In production, defaults to execNpm() from the shell-projection seam.
 */
function checkLatestVersion(opts = {}) {
  const tag = opts.tag || 'latest';
  if (!ALLOWED_TAGS.includes(tag)) {
    throw new RangeError(`invalid dist-tag '${tag}'; allowed: ${ALLOWED_TAGS.join(', ')}`);
  }
  // Default path routes through the shell-projection seam (execNpm owns the
  // Windows shell-flag policy and timeout default). The injection point
  // remains spawnSync-shaped for test compatibility — the adapter below
  // translates { exitCode } → { status } so the consumer logic is unchanged.
  const defaultSpawn = () => {
    const r = execNpm(buildViewArgs(tag), { timeout: NPM_VIEW_TIMEOUT_MS });
    return {
      status: r.exitCode,
      stdout: r.stdout,
      stderr: r.stderr,
      signal: r.signal,
      error: r.error,
    };
  };
  const spawn = opts.spawn || defaultSpawn;

  const r = spawn();
  if (!r || r.status !== 0) {
    // Distinguish timeout (status null, signal set, stderr empty) from a
    // genuine npm failure. Without this, both surfaced as "npm exited
    // non-zero" and the operator couldn't tell which (#2993 CR).
    let detail;
    if (r && r.signal) {
      detail = `npm timed out (signal: ${r.signal})`;
    } else if (r && r.stderr) {
      detail = r.stderr.trim();
    } else {
      detail = 'npm exited non-zero';
    }
    return {
      ok: false,
      reason: CHECK_REASON.FAIL_NPM_FAILED,
      detail,
    };
  }
  const version = (r.stdout || '').trim();
  if (!SEMVER_RE.test(version)) {
    return {
      ok: false,
      reason: CHECK_REASON.FAIL_INVALID_OUTPUT,
      detail: version || '(empty)',
    };
  }
  return { ok: true, version, reason: CHECK_REASON.OK };
}

function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  let tag;
  try {
    tag = resolveTag(argv);
  } catch (e) {
    process.stderr.write(`check-latest-version: ${e.message}\n`);
    return 2;
  }
  const r = checkLatestVersion({ tag });
  if (json) {
    process.stdout.write(JSON.stringify(r) + '\n');
  } else if (r.ok) {
    process.stdout.write(r.version + '\n');
  } else {
    process.stderr.write(`check-latest-version: ${r.reason}: ${r.detail}\n`);
  }
  return r.ok ? 0 : 1;
}

if (require.main === module) runMain(main);

module.exports = { checkLatestVersion, CHECK_REASON, PACKAGE_NAME, ALLOWED_TAGS, NPM_VIEW_TIMEOUT_MS, buildViewArgs, resolveTag };
