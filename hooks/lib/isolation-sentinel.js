'use strict';
// hooks/lib/isolation-sentinel.js — shared sentinel reader for the #3045
// agent-dispatch isolation guards (hooks/gsd-agent-isolation-guard.js,
// hooks/gsd-cursor-subagent-start.js).
//
// #3045 BLOCKER: the guards previously keyed enforcement on the capability
// REGISTRY's `dispatch.isolation` ("this host CAN isolate"), not the
// workflow's resolved per-dispatch ISOLATION ("this dispatch SHOULD be
// isolated"). Sequential ISOLATION=none legitimately happens on a
// harness-worktree-capable host — project-level `workflow.use_worktrees:
// false`, the #2474 per-plan submodule degrade, and the #683/#3060
// base-check auto-degrade all resolve to `none` and are NOT bugs
// (gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md:
// "Sequential mode … Omit isolation=\"worktree\" from the Agent call").
//
// The workflow already computes ISOLATION deterministically in shell before
// any executor dispatch — `record-dispatch-isolation` (gsd-tools.cjs)
// persists that resolved decision to a per-project sentinel file so the
// guard hooks read the real decision instead of re-deriving a capability.
//
// Sentinel path: `<cwd>/.gsd/dispatch-isolation-sentinel.json`. `.gsd` is
// gitignored (root `.gitignore`'s bare `.gsd` entry matches at any depth),
// and lives inside the checkout that ran the workflow — concurrent worktrees
// of the same repo are separate directories on disk, so each gets its own
// sentinel with no cross-worktree collision, no lock file needed.

const fs = require('fs');
const path = require('path');

// Isolation modes ADR-1239 declares (mirrors gsd-tools.cjs
// routeDispatchIsolation / routeRecordDispatchIsolation).
const VALID_ISOLATION = new Set(['harness-worktree', 'orchestrator-worktree', 'none']);

const SENTINEL_RELATIVE_PATH = path.join('.gsd', 'dispatch-isolation-sentinel.json');

// How long a written sentinel is trusted as "this dispatch's decision" before
// a reader falls back to the conservative registry+config check. Generous
// enough to cover a slow multi-wave phase execution (many sequential Agent()
// dispatches can span well over an hour); short enough that a sentinel left
// behind by a stale/abandoned session does not silently authorize a later,
// unrelated dispatch.
const SENTINEL_STALE_MS = 4 * 60 * 60 * 1000; // 4h

function sentinelPath(cwd) {
  return path.join(cwd, SENTINEL_RELATIVE_PATH);
}

/**
 * Read and validate the dispatch-isolation sentinel for `cwd`. Never throws.
 *
 * Returns one of:
 *   { present: false }
 *   { present: true, stale: true,  malformed: true }
 *   { present: true, stale: true,  malformed: false, isolation, harnessFlag, phase, writtenAt }
 *   { present: true, stale: false, malformed: false, isolation, harnessFlag, phase, writtenAt }
 *
 * A malformed/unparseable sentinel is treated as STALE, never fatal — the
 * caller's conservative fallback path covers both "absent" and "stale"
 * identically.
 *
 * `clock` is injectable (`{ now(): number }`, defaults to the real `Date`)
 * per the repo's clock-seam convention, so staleness is testable without
 * asserting on wall-clock time.
 */
function readSentinel(cwd, { clock = Date } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(sentinelPath(cwd), 'utf-8');
  } catch {
    return { present: false };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { present: true, stale: true, malformed: true };
  }

  if (
    !parsed || typeof parsed !== 'object' ||
    !VALID_ISOLATION.has(parsed.isolation) ||
    typeof parsed.written_at !== 'number' || !Number.isFinite(parsed.written_at)
  ) {
    return { present: true, stale: true, malformed: true };
  }

  const harnessFlag = typeof parsed.harness_flag === 'string' && parsed.harness_flag.length > 0
    ? parsed.harness_flag
    : null;
  const phase = typeof parsed.phase === 'string' && parsed.phase.length > 0 ? parsed.phase : null;

  const now = clock.now();
  const age = now - parsed.written_at;
  // Negative age beyond a small tolerance means the sentinel claims to be
  // written in the future — never trust it, but still surface the parsed
  // fields so callers can log an actionable reason.
  const stale = age > SENTINEL_STALE_MS || age < -5000;

  return {
    present: true,
    stale,
    malformed: false,
    isolation: parsed.isolation,
    harnessFlag,
    phase,
    writtenAt: parsed.written_at,
  };
}

module.exports = {
  VALID_ISOLATION,
  SENTINEL_RELATIVE_PATH,
  SENTINEL_STALE_MS,
  sentinelPath,
  readSentinel,
};
