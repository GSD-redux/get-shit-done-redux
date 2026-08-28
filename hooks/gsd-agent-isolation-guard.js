#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// GSD Agent Isolation Dispatch Guard — PreToolUse hook (#3045)
//
// Problem: `gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md`
// resolves the project's dispatch isolation correctly
// (`gsd_run query dispatch-isolation --raw`), but DELIVERY of that value into
// the model-authored `Agent(subagent_type="gsd-executor", ...)` call is a
// prose instruction ("substitute $HARNESS_FLAG's value ... on Claude Code it
// is literally isolation=\"worktree\""). Nothing verifies the model actually
// copied it. When it is omitted, the executor runs and commits directly in
// the user's PRIMARY checkout instead of an isolated worktree, with no
// consent and no warning.
//
// A prose backstop cannot fix a prose defect — it is the same class of
// artifact the model may equally skip. This hook enforces the invariant at
// the tooling layer instead: HARD-BLOCKING.
//
// Applicability (must positively determine all three to act — otherwise
// inert):
//   1. this is a GSD project (`.planning/config.json` exists under cwd),
//   2. the project's resolved dispatch isolation is `harness-worktree`,
//   3. the dispatch target is an executor (`subagent_type === "gsd-executor"`;
//      no other executor-shaped subagent type exists in agents/ today).
//
// Fail-closed exception (#3050 lesson: a guard that cannot verify must not
// answer "safe"): if the project IS a GSD project but the hook cannot read
// or resolve its dispatch-isolation configuration, it DENIES rather than
// defaulting to the "safe-looking" none/allow value that
// `gsd-core/bin/gsd-tools.cjs`'s own `routeDispatchIsolation` degrades to on
// error. That existing query is fail-OPEN by design (sequential execution
// is always safe for the SCHEDULER); this guard's job is the opposite
// invariant (never dispatch unisolated when isolation was promised), so it
// cannot reuse that fail-open default and instead resolves isolation
// itself, distinguishing "resolved cleanly" from "could not resolve".
//
// Isolation resolution (#3045 BLOCKER fix, see hooks/lib/isolation-sentinel.js):
// prefers the workflow's own PERSISTED per-dispatch decision (a sentinel
// `record-dispatch-isolation` writes after `executor-isolation-dispatch.md`
// resolves ISOLATION in shell, applying workflow.use_worktrees, the #2474
// per-plan submodule degrade, and the #683/#3060 base-check auto-degrade)
// over re-deriving a host CAPABILITY from the registry. A fresh sentinel is
// authoritative — `none`/`orchestrator-worktree` ALLOW immediately
// (sequential/orchestrator-managed dispatch is legitimate, not a bug); an
// absent/stale sentinel falls back to a conservative registry+config check
// (GSD_RUNTIME env > .planning/config.json `runtime` > the per-install
// `.gsd-runtime` marker, #3566 — no confident signal degrades to inert rather
// than guessing 'claude', see resolveRegistryIsolation)
// gated additionally by `workflow.use_worktrees` — read directly, in-process,
// no subprocess spawn.
//
// Triggers on: Agent/Task tool calls with subagent_type === "gsd-executor"
//   (both names accepted — #3045 MAJOR 1: only Agent was previously matched,
//   silently inert on any host/version whose subagent tool is named Task).
// Action: BLOCK (exit 2) when isolation should be enforced and is not
// No-op: any tool other than Agent/Task, non-executor targets, GSD projects
//        whose resolved isolation is not harness-worktree, non-GSD projects,
//        malformed payloads, or a dispatch that already carries the correct
//        isolation parameter.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { readSentinel, VALID_ISOLATION, extractDispatchIdentifiers, sentinelAppliesToDispatch } = require('./lib/isolation-sentinel.js');
const { REASON_CODE } = require('./lib/isolation-deny-reason.js');
const { HOOK_ON_CRASH, allow, deny, crash } = require('./lib/hook-exit.js');

// Required at module top, alongside the other ./lib requires — NOT behind
// ensureRuntimeBuild() below. Terminating on a parse/timeout failure must
// never depend on the gitignored build artifacts this hook self-heals for
// its own registry lookups (#3911).
//
// This guard's outer catch (main(), below) has always exited 0 (fail open):
// that outer catch only covers payload PARSING failing before applicability
// could even be determined (malformed stdin JSON, etc.) — the guard's real
// fail-closed logic (a GSD project whose dispatch-isolation configuration
// cannot be verified) is handled separately, inside evaluateDispatch/
// resolveIsolationState, and already returns a 'block' decision through the
// normal exit-2 path rather than through this catch. So an unparseable
// payload has nothing to enforce; allowing it preserves today's behavior
// exactly.
const ON_CRASH = HOOK_ON_CRASH.ALLOW;
// #3582: gsd-core/bin/lib/*.cjs (runtime-name-policy.cjs, capability-registry.cjs
// below) are tsc build artifacts (ADR-457), gitignored and absent on a raw
// plugin-marketplace / git-clone install that never ran `npm run build:lib`.
// Self-heal before the first such require (resolveRegistryIsolation, below) —
// see ensureRuntimeBuild's own header for the full rationale. This module
// itself (gsd-core/bin/ensure-runtime-build.cjs) depends on nothing under
// ./lib, so requiring it here is always safe.
const { ensureRuntimeBuild, RuntimeBuildError } = require('../gsd-core/bin/ensure-runtime-build.cjs');

// No other executor-shaped subagent_type exists in agents/ today
// (verified: only agents/gsd-executor.md). A Set, not a bare string compare,
// so a future sibling executor role can be added here without touching the
// matching logic below.
const EXECUTOR_SUBAGENT_TYPES = new Set(['gsd-executor']);

/**
 * Parse a registry `harnessIsolationFlag` of the shape `key="value"` (the
 * only shape an `Agent()` tool_input kwarg can express) into its parameter
 * name and expected value. Bare CLI-flag shapes (e.g. a hypothetical
 * `--worktree`) have no tool_input kwarg equivalent and are not checkable
 * here — this hook is scoped to the Claude Code `Agent` tool's keyword-arg
 * dispatch surface.
 */
function parseHarnessFlag(flag) {
  if (typeof flag !== 'string') return null;
  const m = /^([A-Za-z_][\w-]*)="([^"]*)"$/.exec(flag);
  if (!m) return null;
  return { param: m[1], value: m[2] };
}

// ─── #3897 rung 2: per-install runtime marker, single canonical owner ────────
// bin/install.js writes `<install>/gsd-core/.gsd-runtime` for EVERY runtime
// install (#2297), co-located with VERSION. Unlike `~/.gsd/defaults.json` —
// which is host-wide and names whichever runtime's install ran LAST, the exact
// leakage #2840's config.cjs change exists to prevent — the marker describes
// THIS install, which is the property runtime identity needs on a machine
// with 2+ runtimes. Previously this hook held its own private reader/cache
// (one of four #3897 found); it now delegates to the single canonical owner,
// `src/runtime-slash.cts` (compiled to gsd-core/bin/lib/runtime-slash.cjs),
// reached through `ensureRuntimeBuild()` like every other compiled-lib require
// in this file (`scripts/lint-hooks-runtime-build-seam.cjs`).
function readInstallRuntimeMarker() {
  try {
    ensureRuntimeBuild();
    const runtimeSlash = require('../gsd-core/bin/lib/runtime-slash.cjs');
    return runtimeSlash.readInstallRuntimeMarker();
  } catch {
    // Unbuilt runtime library, or any other failure reaching the canonical
    // owner — "no signal from this rung" (N4), never a resolution failure.
    return null;
  }
}

// Test seam for the marker rung — forwards to the canonical owner's seam so
// this hook and runtime-slash.cjs always share one cache (#3897 rung 2).
function _setInstallRuntimeMarkerForTests(value) {
  try {
    ensureRuntimeBuild();
    const runtimeSlash = require('../gsd-core/bin/lib/runtime-slash.cjs');
    runtimeSlash._setInstallRuntimeMarkerForTests(value);
  } catch {
    // Test-only seam; an unbuilt library here means the test itself will fail
    // downstream, which is a louder and more actionable signal than throwing here.
  }
}

/**
 * Resolve this project's declared `runtime` identity WITHOUT defaulting to
 * 'claude' when no explicit signal exists (#3045 MAJOR 2).
 *
 * `gsd-core/templates/config.json` — the actual scaffold used to write every
 * new project's config.json — ships with NO `runtime` key, so "no signal"
 * is the COMMON case, not a corner case. Previously this resolution silently
 * defaulted to 'claude' in that case, which meant every non-Claude runtime
 * that also installs this hook (any `hostIntegration.hooksSurface ===
 * 'settings-json'` runtime, not only Claude) had Claude's
 * `harnessIsolationFlag` ("isolation=\"worktree\"") demanded on its Agent()
 * -equivalent dispatch — a kwarg that runtime's own tool never accepts.
 *
 * Returns `{ runtimeId, confident }`. `confident` is true only when an
 * explicit signal exists (GSD_RUNTIME env override, a `runtime` key literally
 * present in config.json, the per-install `.gsd-runtime` marker, or a
 * `runtime` persisted to `~/.gsd/defaults.json` by the installer — see
 * below); false means "cannot determine" and callers must NOT silently
 * substitute 'claude' — see resolveRegistryIsolation.
 *
 * #3045 BLOCKER 2 fix: precedence is GSD_RUNTIME env > config.json `runtime`
 * key > `~/.gsd/defaults.json` `runtime`. The first two are unchanged; the
 * third is NEW — `bin/install.js`'s `writeNonClaudeDefaults` already persists
 * the installed runtime to `~/.gsd/defaults.json` for every non-Claude
 * runtime install (`defaults.runtime = runtime`, #2395), so this is real,
 * already-shipping data, not a new write. Before this fix, "no signal" was
 * the COMMON case for any project whose config.json was scaffolded from
 * `gsd-core/templates/config.json` (which ships with NO `runtime` key) and
 * whose session had no `GSD_RUNTIME` override — i.e. nearly every non-Claude
 * install, since Claude installs never reach `writeNonClaudeDefaults` at all
 * (`nativeModelAliases` short-circuits it) and therefore correctly still rely
 * on config.json/env. Reading the installer's own persisted signal makes
 * "confident" the common case instead.
 *
 * #3566: the per-install `.gsd-runtime` marker now sits BETWEEN config.json
 * and defaults.json. defaults.json is host-wide and names whichever runtime
 * installed LAST — on a 2-runtime machine that confidently resolves the WRONG
 * runtime (a Codex install's `runtime:"codex"` leaking into Claude projects),
 * and when the wrong runtime declares no harnessIsolationFlag the guard goes
 * silently inert. The marker describes THIS install (written for every
 * runtime since #2297), which is the source #2840's config.cjs change names
 * as correct. defaults.json stays as the final rung so single-runtime default
 * installs and pre-#2297 installs (no marker on disk) keep the #3045
 * BLOCKER 2 behavior.
 */
function resolveRuntimeIdentity(cwd, configPath, resolveRuntimeNameFromCandidates) {
  const envRuntime = resolveRuntimeNameFromCandidates(process.env.GSD_RUNTIME);
  if (envRuntime) return { runtimeId: envRuntime, confident: true };

  // A throw here (corrupt JSON, EISDIR, permission error) propagates to the
  // caller's catch as a resolution failure — this function only decides
  // "confident vs not", never resolution failure.
  const raw = fs.readFileSync(configPath, 'utf-8');
  const parsed = JSON.parse(raw);
  if (parsed && typeof parsed === 'object' && 'runtime' in parsed) {
    const configRuntime = resolveRuntimeNameFromCandidates(parsed.runtime);
    if (configRuntime) return { runtimeId: configRuntime, confident: true };
  }

  // #3566: the per-install marker, above the host-wide defaults — see the
  // block comment on readInstallRuntimeMarker. An empty/whitespace-only file
  // or an unknown value degrades exactly like the other rungs (no signal /
  // future-runtime tolerance via resolveRuntimeNameFromCandidates).
  const markerRuntime = resolveRuntimeNameFromCandidates(readInstallRuntimeMarker());
  if (markerRuntime) return { runtimeId: markerRuntime, confident: true };

  // #3045 BLOCKER 2: fall back to the installer-persisted default. Read
  // defensively — an absent/corrupt/non-object defaults.json is "no signal",
  // never a resolution failure (this function only ever throws for the
  // config.json read above, which the caller's catch already handles).
  try {
    const defaultsPath = path.join(os.homedir(), '.gsd', 'defaults.json');
    const defaultsRaw = fs.readFileSync(defaultsPath, 'utf-8');
    const defaultsParsed = JSON.parse(defaultsRaw);
    if (defaultsParsed && typeof defaultsParsed === 'object' && 'runtime' in defaultsParsed) {
      const defaultsRuntime = resolveRuntimeNameFromCandidates(defaultsParsed.runtime);
      if (defaultsRuntime) return { runtimeId: defaultsRuntime, confident: true };
    }
  } catch {
    // Absent or unreadable ~/.gsd/defaults.json — no signal, fall through.
  }

  return { runtimeId: null, confident: false };
}

/**
 * Resolve the registry-declared `harnessIsolationFlag` descriptor for
 * `runtimeId` — pure host-CAPABILITY lookup, used both when the sentinel
 * confirms harness-worktree but omitted the flag, and by the conservative
 * fallback path. Returns `null` when the host declares no usable flag.
 */
function resolveHarnessFlag(runtimeId, runtimes) {
  const runtimeEntry = runtimes != null ? runtimes[runtimeId] : null;
  const declaredFlag = runtimeEntry?.runtime?.harnessIsolationFlag ?? null;
  return (typeof declaredFlag === 'string' && declaredFlag.length > 0) ? declaredFlag : null;
}

/**
 * Conservative fallback resolution used when the #3045 sentinel is absent or
 * stale: re-derive isolation from the registry CAPABILITY, gated by
 * `workflow.use_worktrees` (config-schema key confirmed present in
 * gsd-core/bin/shared/config-schema.manifest.json's validKeys, so it survives
 * loadConfig's whitelist; read directly from the raw config.json here — same
 * side-effect-free approach cmdConfigGet itself uses, not through loadConfig).
 *
 * MAJOR 2: when the runtime cannot be confidently determined (no GSD_RUNTIME
 * override, no `runtime` key in config.json — the common case, since the
 * project scaffold ships without one), this resolves to 'none' (inert)
 * rather than guessing 'claude' and demanding Claude's flag on a host that
 * may not even be Claude. Denying every dispatch on an undeterminable
 * runtime would repeat the exact false-positive class the #3045 BLOCKER
 * itself was — this is the fallback path only (the sentinel-fresh path above
 * already carries the workflow's own confirmed decision + flag, so this
 * degrades coverage only for dispatches that happen outside a GSD workflow
 * run, e.g. a manual Agent() call before any sentinel has been written).
 */
function resolveRegistryIsolation(cwd, configPath) {
  // #3582: self-heal the compiled runtime library BEFORE either require
  // below — this is the only reaching path to both (resolveRegistryIsolation
  // is the sole caller of each), so one call here covers both. Throws
  // RuntimeBuildError on an unbuildable tree; the caller (resolveIsolationState)
  // already wraps this whole function in try/catch and folds any error into
  // its fail-closed `error` result — evaluateDispatch below distinguishes a
  // RuntimeBuildError there so it surfaces this seam's actionable message
  // instead of being misreported as an unreadable config.json (#3050 lesson).
  ensureRuntimeBuild();
  const { resolveRuntimeNameFromCandidates } = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
  const { runtimes } = require('../gsd-core/bin/lib/capability-registry.cjs');

  const { runtimeId, confident } = resolveRuntimeIdentity(cwd, configPath, resolveRuntimeNameFromCandidates);
  if (!confident) {
    return { isolation: 'none', harnessFlag: null };
  }

  const runtimeEntry = runtimes != null ? runtimes[runtimeId] : null;
  const declared = runtimeEntry?.runtime?.hostIntegration?.dispatch?.isolation ?? null;
  let isolation = (typeof declared === 'string' && VALID_ISOLATION.has(declared)) ? declared : 'none';

  let harnessFlag = null;
  if (isolation === 'harness-worktree') {
    harnessFlag = resolveHarnessFlag(runtimeId, runtimes);
    if (harnessFlag === null) {
      // A host claiming harness isolation with no declared flag gives this
      // guard nothing to check for — degrade to 'none' rather than block on
      // an unspecifiable requirement.
      isolation = 'none';
    }
  }

  if (isolation === 'harness-worktree') {
    let useWorktrees = true;
    // #3972: the opt-out read shares the ONE owner every other
    // isolation-deciding surface uses — planning-workspace's
    // worktreesOptedOut ladder (scoped own-key wins; root inherited under
    // the GSD_WORKSTREAM gate; strict === false). A flat single-file read
    // here made a workstream-LOCAL opt-out invisible, so the sentinel-absent
    // fallback denied a sequential dispatch the config explicitly allowed.
    // Reached through ensureRuntimeBuild() like every other compiled-lib
    // require in this file (scripts/lint-hooks-runtime-build-seam.cjs); if
    // the library is unreachable the flat-root read below remains as the
    // degraded fallback — today's behavior, never worse.
    let ladderAnswered = false;
    try {
      ensureRuntimeBuild();
      const { worktreesOptedOut } = require('../gsd-core/bin/lib/planning-workspace.cjs');
      useWorktrees = !worktreesOptedOut(cwd);
      ladderAnswered = true;
    } catch {
      // Unbuilt runtime library or a ladder failure — fall through to the
      // legacy flat-root read (conservative: keep enforcing).
    }
    if (!ladderAnswered) {
      try {
        const raw = fs.readFileSync(configPath, 'utf-8');
        const parsedCfg = JSON.parse(raw);
        if (parsedCfg && typeof parsedCfg === 'object' && parsedCfg.workflow &&
            typeof parsedCfg.workflow === 'object' && parsedCfg.workflow.use_worktrees === false) {
          useWorktrees = false;
        }
      } catch {
        // Unreadable config already propagated to the outer caller's catch
        // before this point in practice (resolveRuntimeIdentity reads it
        // first); tolerate defensively and keep the conservative (enforce)
        // default rather than silently disabling the guard.
      }
    }
    if (!useWorktrees) isolation = 'none';
  }

  return { isolation, harnessFlag };
}

/**
 * Resolve this project's dispatch isolation mode, distinguishing three
 * outcomes:
 *   - { gsdProject: false }                        — not a GSD project, inert
 *   - { gsdProject: true, error: <Error> }          — cannot verify, DENY
 *   - { gsdProject: true, isolation, harnessFlag }  — resolved cleanly
 *
 * `.planning/config.json` EXISTING (regardless of whether it can be read) is
 * the GSD-project signal, mirroring gsd-workflow-guard.js /
 * gsd-context-monitor.js. Any failure reading or parsing it, or requiring the
 * sibling registry/policy modules, after that point means "GSD project
 * present, isolation mode unknown" — folded into the DENY path rather than
 * silently defaulting to a mode that happens to look safe.
 *
 * #3045 BLOCKER fix: prefer the workflow's own PERSISTED per-dispatch
 * decision (the sentinel `record-dispatch-isolation` writes) over
 * re-deriving a host CAPABILITY from the registry. The registry's
 * harness-worktree entry means "this host CAN isolate", not "this dispatch
 * SHOULD be isolated" — sequential ISOLATION=none legitimately happens even
 * on a harness-worktree-capable host (project opt-out, per-plan submodule
 * intersection, #683/#3060 base-check auto-degrade). A fresh sentinel is
 * authoritative; an absent/stale one falls back to the conservative
 * registry+config check via resolveRegistryIsolation.
 *
 * `clock` is injectable for the sentinel-staleness check (repo clock-seam
 * convention); defaults to the real `Date`.
 *
 * `dispatchIds` (optional, `{plan, phase}`) is the identifiers extracted from
 * THIS dispatch's own prompt/description text (#3045 SECURITY F2 —
 * `extractDispatchIdentifiers` in `hooks/lib/isolation-sentinel.js`). When
 * supplied and a fresh sentinel disagrees with it on a shared identifier, the
 * sentinel is treated as NOT APPLICABLE to this dispatch (falls through to
 * the conservative registry+config fallback below) rather than trusted —
 * "a mismatch is 'no applicable sentinel', not an allow" (#3045 review).
 */
function resolveIsolationState(cwd, { clock = Date, dispatchIds = null } = {}) {
  const configPath = path.join(cwd, '.planning', 'config.json');
  let projectExists;
  try {
    fs.accessSync(configPath, fs.constants.F_OK);
    projectExists = true;
  } catch {
    projectExists = false;
  }
  if (!projectExists) {
    return { gsdProject: false, isolation: null, harnessFlag: null, error: null };
  }

  const sentinel = readSentinel(cwd, { clock });
  if (sentinel.present && !sentinel.stale && sentinelAppliesToDispatch(sentinel, dispatchIds)) {
    if (sentinel.isolation !== 'harness-worktree') {
      return { gsdProject: true, isolation: sentinel.isolation, harnessFlag: null, error: null };
    }
    if (sentinel.harnessFlag) {
      return { gsdProject: true, isolation: 'harness-worktree', harnessFlag: sentinel.harnessFlag, error: null };
    }
    // #3045 BLOCKER 2 fix: the sentinel already PROVED this dispatch requires
    // isolation (it resolved harness-worktree) but carries no usable flag —
    // this must DENY, not degrade to the registry's "not confident -> none"
    // fallback. That degrade exists for the case where NOTHING has resolved
    // isolation yet (the conservative fallback path below); reusing it here
    // was the BLOCKER: a fresh sentinel asserting harness-worktree with no
    // flag fell through to a registry lookup that, on the common "runtime not
    // confidently determinable" case, silently returned isolation:'none' and
    // ALLOWED the dispatch to run unisolated in the primary checkout — the
    // exact failure this guard exists to prevent, and on the default-install
    // path (no `runtime` key in gsd-core/templates/config.json), not a corner
    // case. With the #3045 CORE REDESIGN, `dispatch-isolation` always resolves
    // and records `harnessFlag` together with `isolation` in one atomic write
    // whenever isolation is 'harness-worktree' (routeDispatchIsolation
    // degrades to 'none' itself when no flag is declared) — so a fresh
    // sentinel with isolation:'harness-worktree' and no flag should not occur
    // in practice. This branch is defense-in-depth for a sentinel written by
    // an older gsd-tools.cjs, a hand-crafted/corrupted-in-a-*valid*-way
    // sentinel, or any other path that reaches this state; it MUST deny.
    return {
      gsdProject: true,
      isolation: null,
      harnessFlag: null,
      error: new Error(
        'dispatch-isolation sentinel resolved "harness-worktree" but recorded no harness_flag — ' +
        'cannot verify what parameter the dispatch must carry.'
      ),
    };
  }

  // Sentinel absent, stale, or does not apply to this dispatch (F2 mismatch):
  // conservative fallback (#3045 finding — must still cover fail-closed case
  // (a): a project that opted out of worktrees entirely via
  // workflow.use_worktrees).
  try {
    const { isolation, harnessFlag } = resolveRegistryIsolation(cwd, configPath);
    return { gsdProject: true, isolation, harnessFlag, error: null };
  } catch (err) {
    return { gsdProject: true, isolation: null, harnessFlag: null, error: err };
  }
}

/**
 * Process one PreToolUse payload (already JSON-parsed) and return the
 * decision without touching stdin/stdout/process.exit — the exported,
 * directly-testable core of this hook's logic (#3045 MAJOR: "the clock seam
 * is dead code" fix). The stdin-driven script below is now a thin adapter
 * over this function so tests can `require()` it and inject a `clock`
 * (`{now(): number}`) directly per the repo's clock-seam convention, instead
 * of racing real `Date.now()` across a spawned subprocess boundary.
 *
 * Returns `{ action: 'allow' } | { action: 'block', reason: string }`.
 */
function evaluateDispatch(data, { clock = Date } = {}) {
  if (!data || typeof data !== 'object') return { action: 'allow' };
  // #3045 MAJOR 1: accept both subagent-dispatch tool names. hooks.json's
  // matcher is "Agent|Task" (mirroring the repo's own PostToolUse
  // precedent) so this must match both, or it is silently inert on any
  // host/version whose subagent tool is named "Task".
  if (data.tool_name !== 'Agent' && data.tool_name !== 'Task') return { action: 'allow' };

  const toolInput = (data.tool_input && typeof data.tool_input === 'object') ? data.tool_input : {};
  const subagentType = toolInput.subagent_type;
  if (typeof subagentType !== 'string' || !EXECUTOR_SUBAGENT_TYPES.has(subagentType)) {
    return { action: 'allow' };
  }

  const cwd = data.cwd || process.cwd();
  // #3045 SECURITY F2: best-effort plan/phase extraction from this
  // dispatch's own description text, so a fresh sentinel that disagrees
  // with THIS dispatch is treated as inapplicable rather than trusted.
  const dispatchIds = extractDispatchIdentifiers(toolInput.description);
  const state = resolveIsolationState(cwd, { clock, dispatchIds });

  if (!state.gsdProject) return { action: 'allow' };

  if (state.error) {
    // #3582: a missing/unbuildable compiled runtime library (RuntimeBuildError,
    // thrown by ensureRuntimeBuild in resolveRegistryIsolation) is a DIFFERENT,
    // actionable failure from an unreadable/unparsable config.json — surface
    // its own message instead of misreporting it as the generic
    // "could not read or resolve ... configuration" text (the exact #3050
    // misreport this issue exists to fix). Both cases still fail closed
    // (block); only the message differs.
    const isBuildFailure = state.error instanceof RuntimeBuildError;
    const reason = isBuildFailure
      ? `Agent isolation guard: cannot resolve this project's dispatch-isolation ` +
        `configuration because the GSD runtime library failed to self-build. ` +
        `${state.error.message} Refusing to dispatch subagent_type="${subagentType}" until ` +
        `the runtime library is built — a guard that cannot verify must not answer "safe" ` +
        `(#3050).`
      : `Agent isolation guard: could not read or resolve this project's dispatch-isolation ` +
        `configuration ('.planning/config.json' under '${cwd}'). Refusing to dispatch ` +
        `subagent_type="${subagentType}" without being able to verify whether isolation is ` +
        `required — a guard that cannot verify must not answer "safe" (#3050). Retry once the ` +
        `project configuration is readable.`;
    const reasonCode = isBuildFailure ? REASON_CODE.RUNTIME_BUILD_FAILED : REASON_CODE.CONFIG_UNREADABLE;
    return { action: 'block', reason, reasonCode };
  }

  if (state.isolation !== 'harness-worktree') return { action: 'allow' };

  const parsed = parseHarnessFlag(state.harnessFlag);
  if (!parsed) return { action: 'allow' };

  if (toolInput[parsed.param] === parsed.value) return { action: 'allow' };

  const reason =
    `Agent isolation guard: this project's dispatch isolation resolves to "harness-worktree", ` +
    `but the Agent() dispatch for subagent_type="${subagentType}" is missing ` +
    `${parsed.param}="${parsed.value}". Add ${parsed.param}="${parsed.value}" to the Agent() ` +
    `call so the executor runs in an isolated worktree instead of the primary checkout ` +
    `(gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md).`;
  return { action: 'block', reason, reasonCode: REASON_CODE.HARNESS_FLAG_MISSING };
}

/* istanbul ignore next -- stdin adapter, exercised via spawnSync in tests */
function main() {
  let input = '';
  const stdinTimeout = setTimeout(() => allow(undefined), 3000);
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    clearTimeout(stdinTimeout);
    try {
      const data = JSON.parse(input);
      const decision = evaluateDispatch(data);
      if (decision.action === 'block') {
        const out = { decision: 'block', reason: decision.reason, reason_code: decision.reasonCode };
        // Kimi feeds stderr (not stdout) back to the model on exit 2.
        deny(out, decision.reason);
      }
      allow(undefined);
    } catch {
      // Silent fail — never block valid tool calls due to hook errors
      // (malformed payload, etc.). This is distinct from resolveIsolationState's
      // internal error handling, which DOES deny — this outer catch only
      // covers payload parsing before applicability could even be determined.
      // ON_CRASH is declared ALLOW at module top: this preserves today's
      // exit(0) fail-open behavior exactly (#3911).
      crash(ON_CRASH, undefined);
    }
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluateDispatch,
  resolveIsolationState,
  resolveRuntimeIdentity,
  resolveHarnessFlag,
  resolveRegistryIsolation,
  parseHarnessFlag,
  _setInstallRuntimeMarkerForTests,
};
