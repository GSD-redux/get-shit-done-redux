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
// any executor dispatch. CORE REDESIGN (two-review follow-up): the PRIMARY
// write path is now `dispatch-isolation` itself (gsd-tools.cjs
// routeDispatchIsolation) — it persists mode + harnessFlag + phase/plan
// identifiers to the sentinel as an unconditional side effect of resolving
// them, since the workflow must call it to learn ISOLATION at all.
// `record-dispatch-isolation` (routeRecordDispatchIsolation) remains as an
// explicit fallback for the per-plan submodule-degrade override and shares
// the exact same atomic-write implementation.
//
// Sentinel path: `<cwd>/.gsd/dispatch-isolation-sentinel.json`. `.gsd` is
// gitignored (root `.gitignore`'s bare `.gsd` entry matches at any depth),
// and lives inside the checkout that ran the workflow — concurrent worktrees
// of the same repo are separate directories on disk, so each gets its own
// sentinel with no cross-worktree collision, no lock file needed.
//
// #3045 SECURITY F3 (LOW, accepted risk — documented, not redesigned for):
// the sentinel lives at a fixed, predictable, gitignored path inside the
// PRIMARY checkout. An agent already running inside a legitimately isolated
// worktree (i.e. one that has shell/filesystem access to the primary
// checkout's absolute path, which every worktree-isolated agent does by
// construction) could write a fabricated fresh `{isolation:"none"}` sentinel
// into the primary checkout to silence this guard for that checkout's next
// dispatch.
//   - This grants NO NEW write privilege: that same agent could already edit
//     any file in the primary checkout directly (worktree isolation protects
//     the primary checkout from an UNTRUSTED executor's own dispatch, not
//     from a trusted orchestrator process choosing to reach across).
//   - It DOES add an evasion path: silencing the guard via the sentinel
//     leaves no trace in `git status` (`.gsd/` is gitignored), where a direct
//     edit to a tracked file would.
// Accepted because the threat model this guard defends against is an
// UNCONSENTED, UNVERIFIED dispatch — not a deliberately adversarial
// orchestrator process, which already has strictly more direct means to
// cause harm than forging this one file. If that threat model changes (e.g.
// executors become mutually distrusting / sandboxed from the orchestrator's
// own filesystem), the hardening path is a SESSION-KEYED sentinel written
// outside any worktree the executor can reach (e.g. under the harness's own
// config dir, keyed by a session/run id neither the executor nor a forged
// file can predict) rather than a path derivable from `cwd`.

const fs = require('fs');
const path = require('path');

// Isolation modes ADR-1239 declares (mirrors gsd-tools.cjs
// routeDispatchIsolation / routeRecordDispatchIsolation).
const VALID_ISOLATION = new Set(['harness-worktree', 'orchestrator-worktree', 'none']);

const SENTINEL_RELATIVE_PATH = path.join('.gsd', 'dispatch-isolation-sentinel.json');

// #3045 SECURITY F2 fix: how long a written sentinel is trusted as "this
// dispatch's decision" before a reader falls back to the conservative
// registry+config check.
//
// Previously 4h, on the theory that a slow multi-wave phase execution could
// span well over an hour. That reasoning no longer holds: the #3045 CORE
// REDESIGN makes `dispatch-isolation` (gsd-tools.cjs routeDispatchIsolation)
// the sole write path, called as a side effect of resolving ISOLATION — and
// the workflow now re-resolves (and therefore re-records) immediately before
// EVERY plan's dispatch, at the per-plan worktree gate
// (execute-phase/steps/per-plan-worktree-gate.md), not once per phase. A long
// trust window no longer buys the workflow anything and only widens the
// window in which a stale sentinel from an EARLIER, DIFFERENT phase/plan
// (e.g. one that legitimately degraded to `none`) could be misread as
// authorizing a LATER dispatch that never got its own fresh record (a model
// skipping the kwarg on a harness-worktree phase while a same-session
// same-project stale `none` from a prior phase is still "fresh" by the old
// 4h window).
//
// 10 minutes generously covers the real latency between a per-plan gate's
// resolve call and that same plan's `Agent()`/`Task()` dispatch (worktree
// creation, orphan-worktree sweep, base-check, prompt composition) — all
// bounded, sub-minute operations per their own repo-mandated subprocess
// timeouts — while being far too short for a sentinel to survive into a
// later, unrelated phase.
const SENTINEL_STALE_MS = 10 * 60 * 1000; // 10 minutes

function sentinelPath(cwd) {
  return path.join(cwd, SENTINEL_RELATIVE_PATH);
}

/**
 * Resolve the project root a sentinel should be read from/written to, using
 * the SAME derivation gsd-tools.cjs's dispatcher applies to every `--cwd`
 * before invoking a route handler: `findProjectRoot(resolveMainWorktreeCwd(cwd))`
 * (gsd-core/bin/gsd-tools.cjs main(), :3506/:3603 — `record-dispatch-isolation`
 * and `dispatch-isolation` are not in SKIP_ROOT_RESOLUTION, so every write
 * goes through both steps).
 *
 * #3045 MINOR fix: the guard hooks previously read the sentinel from the raw
 * `data.cwd` / `workspace_roots[i]` the harness reports, with NO equivalent
 * resolution. For a linked worktree that does not itself own a `.planning/`
 * (the common shape — `.planning/` lives in the main worktree only), the
 * writer resolves up to the MAIN worktree and writes there, while the reader
 * checked `.planning/config.json` at the raw (unresolved) linked-worktree
 * path, found nothing, and silently treated the dispatch as "not a GSD
 * project" (inert allow) — the guard was reading a sentinel that was never
 * written where it looked. Deriving both sides through this one function
 * closes that divergence.
 *
 * `findProjectRoot`/`resolveWorktreeRoot` are read from the sibling
 * `gsd-core/bin/lib/*.cjs` modules staged alongside these hooks at install
 * time (same pattern the guard hooks already use for
 * capability-registry.cjs/runtime-name-policy.cjs) — two directories up from
 * `hooks/lib/` (`hooks/lib/isolation-sentinel.js` -> `hooks/` -> repo/install
 * root -> `gsd-core/bin/lib/`), mirroring the one-directory-up requires the
 * top-level `hooks/*.js` guard scripts already use successfully.
 *
 * Never throws; any resolution failure (module missing, git unavailable,
 * git timeout) degrades to the raw `cwd` unchanged — the caller's existing
 * "sentinel absent -> conservative fallback" path already covers that safely.
 */
function resolveSentinelRoot(cwd) {
  try {
    if (fs.existsSync(path.join(cwd, '.planning'))) {
      return cwd;
    }
    const { resolveWorktreeRoot } = require('../../gsd-core/bin/lib/worktree-safety.cjs');
    const { root } = resolveWorktreeRoot(cwd);
    const { findProjectRoot } = require('../../gsd-core/bin/lib/project-root.cjs');
    return findProjectRoot(root);
  } catch {
    return cwd;
  }
}

/**
 * Read and validate the dispatch-isolation sentinel for `cwd`. Never throws.
 * `cwd` is resolved through `resolveSentinelRoot` first (#3045 MINOR — see
 * its doc comment), so callers may pass the raw, unresolved dispatch cwd
 * directly.
 *
 * Returns one of:
 *   { present: false }
 *   { present: true, stale: true,  malformed: true }
 *   { present: true, stale: true,  malformed: false, isolation, harnessFlag, phase, plan, writtenAt }
 *   { present: true, stale: false, malformed: false, isolation, harnessFlag, phase, plan, writtenAt }
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
  const root = resolveSentinelRoot(cwd);
  let raw;
  try {
    raw = fs.readFileSync(sentinelPath(root), 'utf-8');
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
  // #3045 SECURITY F2: `plan` was not previously part of the sentinel shape.
  // Recorded so a phase-level-only sentinel (plan: null) is distinguishable
  // from a plan-scoped one — see the guards' dispatch-matching logic, which
  // treats a plan/phase MISMATCH (both sides present and disagreeing) as "no
  // applicable sentinel", not an allow.
  const plan = typeof parsed.plan === 'string' && parsed.plan.length > 0 ? parsed.plan : null;

  const now = clock.now();
  const age = now - parsed.written_at;
  // Negative age beyond a small tolerance means the sentinel claims to be
  // written in the future — never trust it, but still surface the parsed
  // fields so callers can log an actionable reason.
  const stale = age >= SENTINEL_STALE_MS || age < -5000;

  return {
    present: true,
    stale,
    malformed: false,
    isolation: parsed.isolation,
    harnessFlag,
    phase,
    plan,
    writtenAt: parsed.written_at,
  };
}

/**
 * #3045 SECURITY F2: extract the `{plan, phase}` a specific Agent()/Task()
 * dispatch is FOR, from the one place that data is reliably embedded today —
 * the dispatch prompt/description text (`execute-phase.md`'s Agent() block
 * uses the literal shape `description="Execute plan {plan_number} of phase
 * {phase_number}"`, and the prompt body's `<objective>` repeats "Execute plan
 * {plan_number} of phase {phase_number}-{phase_name}." verbatim — the SAME
 * text the orchestrator-worktree EXECUTOR_PROMPT template and Cursor's `task`
 * field carry, since Cursor dispatches the same prompt content). There is no
 * structured per-dispatch kwarg carrying plan/phase identifiers today (#3045
 * would need a larger dispatch-protocol change to add one) — this is
 * therefore a best-effort, NOT a guaranteed, extraction: a dispatch whose
 * text doesn't match the expected shape returns `{ plan: null, phase: null }`
 * and the caller must NOT treat that as a mismatch (see
 * `sentinelAppliesToDispatch`).
 */
function extractDispatchIdentifiers(text) {
  if (typeof text !== 'string' || text.length === 0) return { plan: null, phase: null };
  const m = /execute\s+plan\s+(\S+)\s+of\s+phase\s+(\S+)/i.exec(text);
  if (!m) return { plan: null, phase: null };
  return { plan: m[1], phase: m[2] };
}

/**
 * #3045 SECURITY F2: does a fresh, non-malformed sentinel apply to THIS
 * dispatch? `dispatchIds` is the `{plan, phase}` extracted from the
 * dispatch's own text via `extractDispatchIdentifiers` (or manually supplied
 * by a caller with a more reliable source).
 *
 * Returns false (mismatch — "no applicable sentinel") ONLY when both sides
 * carry a value for the SAME identifier and they disagree. Any side missing
 * a value (sentinel predates this fix, or the dispatch text didn't match the
 * expected shape) is treated as "cannot compare" and does NOT itself produce
 * a mismatch — this stays a defense-in-depth narrowing of an otherwise-fresh
 * sentinel's applicability, not a new fail-open/fail-closed axis on its own.
 */
function sentinelAppliesToDispatch(sentinel, dispatchIds) {
  if (!sentinel || !dispatchIds) return true;
  if (sentinel.phase && dispatchIds.phase && sentinel.phase !== dispatchIds.phase) return false;
  if (sentinel.plan && dispatchIds.plan && sentinel.plan !== dispatchIds.plan) return false;
  return true;
}

module.exports = {
  VALID_ISOLATION,
  SENTINEL_RELATIVE_PATH,
  SENTINEL_STALE_MS,
  sentinelPath,
  resolveSentinelRoot,
  readSentinel,
  extractDispatchIdentifiers,
  sentinelAppliesToDispatch,
};
