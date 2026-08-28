#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
// gsd-cursor-subagent-start.js — Cursor subagentStart hook (ADR-1239 / #2089,
// isolation guard #3045)
//
// Cursor invokes this script when a subagent session starts.
// Protocol: JSON from Cursor on stdin; JSON response on stdout.
//
// Input schema (cursor subagentStart) — Cursor's hooks contract is a COMMON
// envelope shared by every hook, PLUS event-specific fields layered on top
// (cursor.com/docs/hooks, "Reference > Common schema"). A prior version of
// this comment documented only the envelope and omitted the event-specific
// fields entirely — that omission is exactly what caused #3045's isolation
// guard work to stall on a false schema conflict, so every field below is
// still read defensively (assume any of them may be absent/malformed):
//   Common envelope (all hooks): conversation_id, generation_id, model,
//     model_id, model_params, hook_event_name, cursor_version,
//     workspace_roots (array of paths), user_email, transcript_path.
//     (Some fields are omitted for app-lifecycle hooks; this script's own
//     prior comment listed session_id/is_background_agent instead of
//     model_id/model_params — the exact set observed is not guaranteed.)
//   subagentStart-specific additions: subagent_id, subagent_type, task,
//     parent_conversation_id, tool_call_id, subagent_model,
//     is_parallel_worker, git_branch (optional).
//
// Output schema (cursor subagentStart):
//   { additional_context?: string, permission?: "allow"|"deny", user_message?: string }
//   "ask" is NOT a supported permission value for subagentStart — Cursor
//   treats it as "deny". This script only ever emits "allow" (by omitting
//   `permission`, preserving the pre-#3045 output shape) or an explicit
//   "deny" with `user_message`.
//
// Behaviour:
//   - Injects a brief GSD state reminder so subagents (planner, executor,
//     verifier) have the current phase context (unchanged since #2587).
//   - NEW (#3045): denies spawning a GSD executor subagent when this
//     project's dispatch isolation resolves to "harness-worktree" but the
//     session is NOT actually running isolated from the user's primary
//     checkout. Cursor's `--worktree` is a SESSION-level flag (no per-call
//     isolation parameter exists on `subagentStart`, unlike Claude's
//     `Agent(isolation=...)` kwarg), so this guard verifies EFFECTIVE STATE
//     instead of looking for a flag — see resolveIsolationDecision() below.
//   - Fails open on a payload it cannot parse or that carries fields it does
//     not need: never throws, never blocks a call it cannot evaluate.
//     Isolation resolution itself fails CLOSED (denies) for the two cases
//     that are load-bearing and are NOT the same as "cannot parse": (a) a
//     GSD project resolved to harness-worktree whose isolation state cannot
//     be verified, and (b) a harness-worktree GSD project dispatch with no
//     usable subagent_type — a guard that cannot verify must not answer
//     "safe" (#3050).
//
// Cursor docs: https://cursor.com/docs/hooks

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { allow } = require('./lib/hook-exit.js');

// Workspace resolution is shared across the Cursor hooks (#2587) — see
// hooks/lib/cursor-workspace.js. Staged next to these scripts by
// writeCursorHooksJson so the require always resolves post-install.
const { resolveStatePath } = require('./lib/cursor-workspace.js');
const { readSentinel, VALID_ISOLATION, extractDispatchIdentifiers, sentinelAppliesToDispatch } = require('./lib/isolation-sentinel.js');
const { REASON_CODE } = require('./lib/isolation-deny-reason.js');
// #3582: gsd-core/bin/lib/*.cjs (runtime-homes.cjs, worktree-safety.cjs,
// runtime-name-policy.cjs, capability-registry.cjs — required below, inside
// resolveIsolationEvidence and resolveFallbackIsolation) are tsc build
// artifacts (ADR-457), gitignored and absent on a raw plugin-marketplace /
// git-clone install that never ran `npm run build:lib`. Self-heal once, in
// evaluateRootIsolation, before any of those four requires run — see the
// call site below. This module itself depends on nothing under ./lib.
const { ensureRuntimeBuild, RuntimeBuildError } = require('../gsd-core/bin/ensure-runtime-build.cjs');

const MSG_PRESENT =
  'GSD: Subagent session started — review .planning/STATE.md for the current phase and any blockers before acting.';
const MSG_ABSENT =
  'GSD: Subagent session started — no .planning/ workflow found.';

// GSD's Cursor agent artifacts install with `destSubpath: "agents"`,
// `prefix: "gsd-"`, flat nesting, via the `convertClaudeAgentToCursorAgent`
// converter, and `hostIntegration.dispatch.namedDispatch === true`
// (gsd-core/bin/lib/capability-registry.cjs, runtimes.cursor) — i.e. Cursor
// dispatches named subagents by their real agent name, identically to
// Claude. So GSD's executor surfaces as subagent_type === "gsd-executor" on
// Cursor too, the same identifier hooks/gsd-agent-isolation-guard.js checks
// for on Claude. A Set, not a bare string compare, so a future sibling
// executor role can be added here without touching the matching logic below.
const EXECUTOR_SUBAGENT_TYPES = new Set(['gsd-executor']);

/**
 * Runs `realpathFn`, never throwing. A path that cannot be resolved (does not
 * exist, dangling symlink, ELOOP, ...) yields `null` rather than an
 * exception — the caller decides what "cannot resolve" means for its own
 * verdict (#3045 finding 2).
 *
 * `realpathFn` is injectable (defaults to `fs.realpathSync`), per the repo's
 * dependency-injection seam convention (mirrors the `clock` seam elsewhere in
 * these hooks) — this lets tests exercise the realpath-based spoof-resistance
 * logic below with a fabricated symlink-resolution mapping, without ever
 * creating a real filesystem symlink (directory symlinks require elevated
 * privileges on unprivileged Windows CI).
 */
function realpathOrNull(p, realpathFn) {
  try {
    return realpathFn(p);
  } catch {
    return null;
  }
}

/**
 * Resolve whether `root` is running in a session Cursor ISOLATED FOR THIS
 * DISPATCH — i.e. a worktree the harness itself created and manages, not
 * merely "some linked git worktree".
 *
 * #3045 security review (finding 3): "is a linked git worktree" is NOT "is
 * isolated from the tree the human is using". A developer who opens Cursor
 * directly in a hand-made `git worktree add` checkout — routine, see
 * `.claude/worktrees/` in this very repo — is not protected by anything;
 * nothing stops them from also editing that same checkout by hand. The ONLY
 * signal that actually proves harness isolation is that `root` resolves
 * under Cursor's OWN managed worktree root (`<cursor config dir>/worktrees`,
 * i.e. `~/.cursor/worktrees` by default — `getGlobalConfigDir('cursor')`
 * honors the `CURSOR_CONFIG_DIR` env override and `~` expansion for free).
 * That is made NECESSARY AND SUFFICIENT below. Do NOT reinstate
 * `resolveWorktreeLinkage`'s `linked_worktree_root` mode as an alternative
 * OR'd proof of isolation — that is precisely the bypass finding 3 closed;
 * a future "simplification" that merges it back in re-opens unconsented
 * writes to the human's active checkout.
 *
 * `resolveWorktreeLinkage` is still called, but ONLY as a diagnostic: it
 * distinguishes "confidently not isolated" from "git could not answer
 * (timeout) — cannot determine" so the eventual deny reason stays
 * actionable. Its result never flips `isolated`.
 *
 * Both the workspace root and the managed root are realpath'd before
 * comparison (#3045 finding 2) — lexical `path.relative` alone is spoofable
 * by a symlink or bind mount at either location, plantable by any process
 * running with the user's permissions (including an agent already inside a
 * legitimately isolated worktree, which has shell access by design).
 * `fs.realpathSync` throwing (nonexistent path) never propagates — it
 * degrades to "cannot resolve", never to "isolated". realpath also resolves
 * the `CURSOR_CONFIG_DIR`-derived managed root itself (not just `root`), so a
 * symlinked or case-differing `CURSOR_CONFIG_DIR` (case-insensitive
 * filesystems normalize to on-disk casing via realpath's dirent walk, not
 * string comparison) is covered on BOTH sides of the comparison, not only
 * `root`'s.
 *
 * Returns `{ isolated: true|false, cannotDetermine: bool, notApplicable: bool }`.
 * `notApplicable` (#3045 MAJOR 3) is true only for a confidently-not-a-git-repo
 * root — see the `not_git_repo` branch below.
 *
 * `realpath` is injectable (`(p: string) => string`, throws like
 * `fs.realpathSync` on an unresolvable path; defaults to the real
 * `fs.realpathSync`) per the repo's clock-seam-style dependency-injection
 * convention. This lets tests drive the exact spoof-resistance logic this
 * function exists for (a symlink at the managed root pointing OUTSIDE it)
 * with an injected resolution mapping, in-process, on every platform —
 * without creating a real directory symlink, which requires elevated
 * privileges on unprivileged Windows CI.
 */
function resolveIsolationEvidence(root, { realpath = fs.realpathSync } = {}) {
  let managedRoot = null;
  try {
    // Sibling data/policy module, staged alongside this hook at install time
    // (same pattern as hooks/gsd-statusline.js's requires of gsd-core/bin/lib/*).
    const { getGlobalConfigDir } = require('../gsd-core/bin/lib/runtime-homes.cjs');
    managedRoot = path.join(getGlobalConfigDir('cursor'), 'worktrees');
  } catch {
    managedRoot = null;
  }

  const realRoot = realpathOrNull(root, realpath);
  const realManagedRoot = managedRoot === null ? null : realpathOrNull(managedRoot, realpath);

  if (realRoot !== null && realManagedRoot !== null) {
    const rel = path.relative(realManagedRoot, realRoot);
    const underManagedRoot = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    if (underManagedRoot) return { isolated: true, cannotDetermine: false, notApplicable: false };
  }

  // Not proven isolated by the only signal that counts. Resolve the
  // diagnostic-only linkage check purely to make the deny reason legible —
  // see the doc comment above; this NEVER flips `isolated`.
  let linkageReason = null;
  try {
    // Sibling data/policy module, staged alongside this hook at install time.
    const { resolveWorktreeLinkage } = require('../gsd-core/bin/lib/worktree-safety.cjs');
    linkageReason = resolveWorktreeLinkage(root).reason;
  } catch {
    linkageReason = null;
  }

  if (realRoot === null) {
    // `root` itself could not be resolved on disk. In the live hook this is
    // defense in depth rather than a reachable path today: the GSD-project
    // existence gate in resolveIsolationDecision already requires `root` to
    // resolve (it must contain a readable `.planning/config.json`) before
    // evidence is ever consulted, so a workspace root that plainly does not
    // exist allows earlier as "not a GSD project" — never here. Kept anyway
    // per finding 2's explicit directive: an unresolvable path must never
    // silently read as "isolated".
    return { isolated: false, cannotDetermine: true, notApplicable: false };
  }
  if (linkageReason === 'git_timed_out') {
    return { isolated: false, cannotDetermine: true, notApplicable: false };
  }
  if (linkageReason === 'not_git_repo') {
    // #3045 MAJOR 3: a confidently-non-git `root` has no primary git
    // checkout to protect from an isolated-worktree bypass — Cursor's
    // `--worktree` / `/worktree` (the deny message's own remediation) create
    // a GIT worktree, so telling the user to start one is unactionable
    // advice for a directory that isn't a git repo at all. Treat as INERT
    // (allow) rather than a confident negative; this is distinct from
    // `cannotDetermine` (git responded definitively here, it just said "not
    // a repo") and from `isolated` (nothing was proven isolated) — it is its
    // own "this guard's threat model does not apply" outcome.
    return { isolated: false, cannotDetermine: false, notApplicable: true };
  }
  return { isolated: false, cannotDetermine: false, notApplicable: false };
}

/**
 * Resolve every non-empty string entry of `workspace_roots` — ALL checkout
 * paths Cursor is operating on for this hook invocation, not just the first.
 *
 * #3045 security review (finding 1): a multi-root Cursor workspace whose
 * FIRST root is a non-GSD directory (or an isolated worktree) and whose
 * SECOND root is the GSD project in the primary checkout must still be
 * caught — every root is a directory the dispatched subagent can reach and
 * write to, regardless of position. `hooks/lib/cursor-workspace.js` already
 * established the "scan every root" precedent for its own (different)
 * purpose; this is a parallel scan for isolation applicability, not a
 * duplicate of that module's single-root-resolution job (it resolves ONE
 * root to report state-file presence; this resolves the full set to decide
 * whether ANY of them is an unconsented write target).
 *
 * Cursor runs hooks with cwd set to its own config dir (~/.cursor), NOT the
 * workspace (hooks/lib/cursor-workspace.js), so `workspace_roots` is the
 * only reliable source for "what directories is this dispatch actually in".
 *
 * #3045 MINOR: a RELATIVE entry is rejected (`path.isAbsolute`), not merely
 * accepted-and-hoped — every downstream consumer (`.planning/config.json`
 * existence check, `realpathOrNull`, `resolveWorktreeLinkage`) joins/resolves
 * it against whatever the CURRENT PROCESS cwd happens to be, which for this
 * hook is Cursor's own config dir (~/.cursor per the comment above), NOT the
 * workspace. A relative root would therefore resolve against the wrong
 * directory and — because a wrong/nonexistent `.planning/config.json` path
 * reads as "not a GSD project" — silently ALLOW a dispatch this guard should
 * have evaluated (fail OPEN). Filtering it out here instead makes it "not a
 * resolvable workspace root", which degrades the SAME way (allow, step 2 of
 * resolveIsolationDecision's applicability list) but for the honest reason.
 */
function getWorkspaceRoots(data) {
  const roots = Array.isArray(data.workspace_roots) ? data.workspace_roots : [];
  return roots.filter((r) => typeof r === 'string' && r.length > 0 && path.isAbsolute(r));
}

/**
 * Decide whether to deny this subagentStart. Returns
 * `{ action: 'allow' } | { action: 'deny', reason: string }`.
 *
 * Applicability (must positively determine all of the following to deny —
 * otherwise allow):
 *   1. `subagent_type` is not confidently a NON-executor (a present,
 *      non-empty string that isn't in EXECUTOR_SUBAGENT_TYPES short-circuits
 *      to allow immediately, before any project/isolation resolution runs —
 *      mirrors hooks/gsd-agent-isolation-guard.js checking subagent_type
 *      first, and matters here specifically: an unreadable config must never
 *      deny a dispatch this guard was never going to enforce against),
 *   2. a workspace root is resolvable from `workspace_roots`,
 *   3. that root is a GSD project (`.planning/config.json` exists there),
 *   4. the resolved dispatch isolation is `harness-worktree`,
 *   5. `subagent_type` identifies a GSD executor (or is missing/malformed —
 *      see the cannot-determine case below),
 *   6. the session is NOT actually isolated (resolveIsolationEvidence).
 *
 * No workspace root at all degrades to allow (step 2), mirroring
 * hooks/gsd-agent-isolation-guard.js's own "not a GSD project → allow"
 * branch: project-existence is the gate that makes fail-closed apply in the
 * first place, so being unable to even locate a candidate project is not
 * itself a fail-closed trigger — it is the same "not a GSD project" shape
 * that guard already treats as inert.
 *
 * Two DISTINCT fail-closed ("cannot determine") reasons per #3050's lesson
 * that a guard which cannot verify must not answer "safe" — both scoped to
 * "GSD project resolved to harness-worktree", never to a dispatch already
 * confirmed to be a non-executor:
 *   - this project's dispatch-isolation configuration cannot be read/resolved
 *     (registry require/parse failure, or config.json unreadable),
 *   - `subagent_type` is missing or not a usable non-empty string on a
 *     dispatch this guard could not rule out as an executor.
 *
 * Isolation resolution (#3045 BLOCKER fix, see hooks/lib/isolation-sentinel.js):
 * prefers the workflow's own PERSISTED per-dispatch decision (the sentinel
 * `record-dispatch-isolation` writes) over re-deriving a host CAPABILITY from
 * the registry. `none`/`orchestrator-worktree` from a fresh sentinel ALLOW
 * immediately — sequential/orchestrator-managed dispatch is legitimate. An
 * absent/stale sentinel falls back to `resolveFallbackIsolation` (registry +
 * `workflow.use_worktrees`, runtime resolved GSD_RUNTIME env >
 * .planning/config.json `runtime` key > 'cursor'). The default is
 * confidently "cursor" here — UNLIKE hooks/gsd-agent-isolation-guard.js's own
 * fallback, which must treat "no explicit signal" as cannot-determine
 * because that hook installs across every `hostIntegration.hooksSurface ===
 * 'settings-json'` runtime — because THIS script only ever runs as Cursor's
 * own subagentStart hook; there is no other host it could be executing
 * under, so defaulting to 'cursor' is a confirmed fact of the execution
 * context, not a guess (#3045 MINOR — this note replaces a prior comment
 * that inaccurately claimed to "mirror" runtime-slash.cjs's resolveRuntime,
 * which defaults to 'claude'; the two intentionally diverge).
 *
 * #3045 security review (finding 1): applicability step 2 above now means
 * "a workspace root is resolvable", plural — resolveIsolationDecision
 * evaluates EVERY entry of `workspace_roots` via evaluateRootIsolation() and
 * denies on the first one that fails. `subagent_type` is still resolved
 * exactly once, up front, before any root is touched (applicability step 1
 * stays a single check, not per-root — an unreadable config on one root must
 * never even be attempted for a confirmed non-executor dispatch).
 */
function resolveIsolationDecision(data, { clock = Date, realpath = fs.realpathSync } = {}) {
  const subagentType = data.subagent_type;
  const isConfirmedNonExecutor = typeof subagentType === 'string'
    && subagentType.length > 0
    && !EXECUTOR_SUBAGENT_TYPES.has(subagentType);
  if (isConfirmedNonExecutor) return { action: 'allow' };

  const roots = getWorkspaceRoots(data);
  if (roots.length === 0) return { action: 'allow' };

  // #3045 SECURITY F2: best-effort plan/phase extraction from this
  // dispatch's own `task` text (Cursor carries the same prompt content the
  // Claude Agent() dispatch does — see extractDispatchIdentifiers), so a
  // fresh sentinel that disagrees with THIS dispatch is treated as
  // inapplicable rather than trusted.
  const dispatchIds = extractDispatchIdentifiers(data.task);

  for (const root of roots) {
    const verdict = evaluateRootIsolation(root, subagentType, { clock, dispatchIds, realpath });
    if (verdict.action === 'deny') return verdict;
  }
  return { action: 'allow' };
}

// ─── #3897 rung 2: per-install runtime marker, single canonical owner ────────
// bin/install.js writes `<install>/gsd-core/.gsd-runtime` beside VERSION for
// every runtime install (#2297); this hook ships at `<install>/hooks/`, so the
// marker is the `gsd-core` sibling of this file's own directory. Previously
// this hook held its own private reader/cache (one of four #3897 found); it
// now delegates to the single canonical owner, `src/runtime-slash.cts`
// (compiled to gsd-core/bin/lib/runtime-slash.cjs), reached through
// `ensureRuntimeBuild()` like the other compiled-lib requires in this file
// (`scripts/lint-hooks-runtime-build-seam.cjs`).
function readInstallRuntimeMarker() {
  try {
    ensureRuntimeBuild();
    const runtimeSlash = require('../gsd-core/bin/lib/runtime-slash.cjs');
    return runtimeSlash.readInstallRuntimeMarker();
  } catch {
    // Unbuilt runtime library, or any other failure reaching the canonical
    // owner — "no signal from this rung", never a resolution failure.
    return null;
  }
}

// Test seam — forwards to the canonical owner's seam so this hook and
// runtime-slash.cjs always share one cache (#3897 rung 2). Spawned-hook tests
// (fresh process, no marker) are unaffected.
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
 * Conservative fallback resolution used when the #3045 sentinel is absent or
 * stale for `root`: re-derive isolation from the registry CAPABILITY, gated
 * by `workflow.use_worktrees` (config-schema key confirmed present in
 * gsd-core/bin/shared/config-schema.manifest.json's validKeys, so it survives
 * loadConfig's whitelist; read directly from the raw config.json here, same
 * side-effect-free approach cmdConfigGet itself uses).
 *
 * #3045 MAJOR fix ("Cursor residual false-deny"): previously defaulted
 * confidently to 'cursor' whenever no `GSD_RUNTIME`/config.json `runtime`
 * signal existed, purely because this script only ever executes as Cursor's
 * OWN `subagentStart` hook — true of the PROCESS, but not evidence the
 * PROJECT itself declared an isolation requirement this guard can verify.
 * Combined with a stale/absent sentinel (outside `execute-phase`, after
 * `.gsd` cleanup, a phase running past the sentinel's staleness window, or a
 * base-check-degraded run whose sentinel went stale before a fresh one was
 * recorded), that default made every such `gsd-executor` dispatch resolve to
 * "harness-worktree" and then hard-DENY unless the session happened to be
 * running under Cursor's own managed worktree root — a false-deny of
 * otherwise legitimate dispatches, unlike `hooks/gsd-agent-isolation-guard.js`,
 * which degrades an undeterminable runtime to inert (#3045 MAJOR 2). Aligned
 * here: an explicit signal is now required — `GSD_RUNTIME` > config.json
 * `runtime` key > the per-install `.gsd-runtime` marker (#3566) >
 * `~/.gsd/defaults.json` `runtime` (mirrors the Claude hook's
 * `resolveRuntimeIdentity`; `bin/install.js`'s `writeNonClaudeDefaults`
 * persists the installed runtime there for every non-Claude install,
 * including Cursor, so a REAL Cursor+GSD install still resolves confidently
 * — this only stops GUESSING 'cursor' for a project that never declared any
 * runtime signal at all).
 */
function resolveFallbackIsolation(root, configPath) {
  const { resolveRuntimeNameFromCandidates } = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
  const { runtimes } = require('../gsd-core/bin/lib/capability-registry.cjs');

  let runtimeId = resolveRuntimeNameFromCandidates(process.env.GSD_RUNTIME);
  const rawConfig = fs.readFileSync(configPath, 'utf-8');
  const parsedConfig = JSON.parse(rawConfig);
  if (!runtimeId && parsedConfig && typeof parsedConfig === 'object' && 'runtime' in parsedConfig) {
    runtimeId = resolveRuntimeNameFromCandidates(parsedConfig.runtime) || null;
  }
  if (!runtimeId) {
    // #3566: the per-install marker, above the host-wide defaults — same fix as
    // hooks/gsd-agent-isolation-guard.js's resolveRuntimeIdentity. defaults.json
    // is host-wide and names whichever runtime installed LAST (#2840's poison);
    // the marker describes THIS install (written for every runtime since #2297).
    runtimeId = resolveRuntimeNameFromCandidates(readInstallRuntimeMarker()) || null;
  }
  if (!runtimeId) {
    try {
      const defaultsPath = path.join(os.homedir(), '.gsd', 'defaults.json');
      const defaultsParsed = JSON.parse(fs.readFileSync(defaultsPath, 'utf-8'));
      if (defaultsParsed && typeof defaultsParsed === 'object' && 'runtime' in defaultsParsed) {
        runtimeId = resolveRuntimeNameFromCandidates(defaultsParsed.runtime) || null;
      }
    } catch {
      // Absent/unreadable ~/.gsd/defaults.json — no signal, fall through.
    }
  }
  if (!runtimeId) {
    // No explicit signal anywhere confirms this project resolved
    // harness-worktree — degrade to inert rather than guess 'cursor'.
    return 'none';
  }

  const runtimeEntry = runtimes != null ? runtimes[runtimeId] : null;
  const declared = runtimeEntry?.runtime?.hostIntegration?.dispatch?.isolation ?? null;
  let declaredIsolation = (typeof declared === 'string' && VALID_ISOLATION.has(declared)) ? declared : 'none';

  if (declaredIsolation === 'harness-worktree' &&
      parsedConfig && typeof parsedConfig === 'object' && parsedConfig.workflow &&
      typeof parsedConfig.workflow === 'object' && parsedConfig.workflow.use_worktrees === false) {
    declaredIsolation = 'none';
  }

  return declaredIsolation;
}

/**
 * Applicability + isolation verdict for a SINGLE workspace root. Returns
 * `{ action: 'allow' } | { action: 'deny', reason: string }`. Extracted from
 * resolveIsolationDecision (#3045 finding 1) so every root in a multi-root
 * workspace runs the identical check.
 */
function evaluateRootIsolation(root, subagentType, { clock = Date, dispatchIds = null, realpath = fs.realpathSync } = {}) {
  const configPath = path.join(root, '.planning', 'config.json');
  let isGsdProject;
  try {
    fs.accessSync(configPath, fs.constants.F_OK);
    isGsdProject = true;
  } catch {
    isGsdProject = false;
  }
  if (!isGsdProject) return { action: 'allow' };

  // #3582: self-heal the compiled runtime library BEFORE any of its four
  // downstream requires (resolveFallbackIsolation's two, resolveIsolationEvidence's
  // two — reached only below this point). Checked separately from the
  // sentinel/fallback try block below so a build failure surfaces its own
  // actionable RuntimeBuildError message rather than being folded into the
  // generic "could not read or resolve ... configuration" deny reason (the
  // #3050 misreport this issue exists to fix). Still fails closed either way.
  try {
    ensureRuntimeBuild();
  } catch (err) {
    return {
      action: 'deny',
      reason:
        `GSD subagent isolation guard: cannot resolve this project's dispatch-isolation ` +
        `configuration because the GSD runtime library failed to self-build. ` +
        `${err instanceof RuntimeBuildError ? err.message : String(err && err.message || err)} ` +
        `Refusing to allow this subagent to spawn until the runtime library is built — a guard ` +
        `that cannot verify must not answer "safe" (#3050).`,
      reasonCode: REASON_CODE.RUNTIME_BUILD_FAILED,
    };
  }

  let declaredIsolation;
  try {
    // #3045 BLOCKER fix: a fresh sentinel is authoritative for THIS
    // dispatch's actual resolved isolation — see the doc comment above.
    // #3045 SECURITY F2: a fresh sentinel that names a DIFFERENT
    // plan/phase than this dispatch is not applicable to it — fall through
    // to the conservative fallback exactly as a stale sentinel would.
    const sentinel = readSentinel(root, { clock });
    declaredIsolation = (sentinel.present && !sentinel.stale && sentinelAppliesToDispatch(sentinel, dispatchIds))
      ? sentinel.isolation
      : resolveFallbackIsolation(root, configPath);
  } catch {
    return {
      action: 'deny',
      reason:
        `GSD subagent isolation guard: could not read or resolve this project's ` +
        `dispatch-isolation configuration ('.planning/config.json' exists under "${root}"). ` +
        `Refusing to allow this subagent to spawn without being able to verify whether ` +
        `isolation is required — a guard that cannot verify must not answer "safe" (#3050). ` +
        `Retry once the project configuration is readable.`,
      reasonCode: REASON_CODE.CONFIG_UNREADABLE,
    };
  }

  if (declaredIsolation !== 'harness-worktree') return { action: 'allow' };

  // isConfirmedNonExecutor already excluded "present, non-empty, unrecognized
  // string" above — reaching here means subagentType is either the confirmed
  // executor or missing/malformed (cannot rule it out).
  if (typeof subagentType !== 'string' || subagentType.length === 0) {
    return {
      action: 'deny',
      reason:
        `GSD subagent isolation guard: this project's dispatch isolation resolves to ` +
        `"harness-worktree", but the subagentStart payload for this dispatch carries no usable ` +
        `subagent_type. Refusing to allow it to spawn without being able to confirm whether it ` +
        `is a GSD executor — a guard that cannot verify must not answer "safe" (#3050).`,
      reasonCode: REASON_CODE.NO_SUBAGENT_TYPE,
    };
  }

  const evidence = resolveIsolationEvidence(root, { realpath });
  if (evidence.isolated) return { action: 'allow' };
  if (evidence.notApplicable) return { action: 'allow' };

  if (evidence.cannotDetermine) {
    return {
      action: 'deny',
      reason:
        `GSD subagent isolation guard: this project's dispatch isolation resolves to ` +
        `"harness-worktree", but whether "${root}" is running in an isolated Cursor worktree ` +
        `could not be determined (git did not respond). Refusing to allow subagent_type=` +
        `"${subagentType}" to spawn without being able to verify isolation — a guard that ` +
        `cannot verify must not answer "safe" (#3050). Retry once git is responsive.`,
      reasonCode: REASON_CODE.CANNOT_DETERMINE_ISOLATION,
    };
  }

  return {
    action: 'deny',
    reason:
      `GSD subagent isolation guard: this project's dispatch isolation resolves to ` +
      `"harness-worktree", but subagent_type="${subagentType}" is about to spawn in "${root}", ` +
      `which is not an isolated Cursor worktree — it would edit the user's primary checkout ` +
      `directly, with no consent and no warning. Start an isolated session first (the ` +
      `"--worktree" CLI flag or the "/worktree" chat command; Cursor manages these worktrees ` +
      `under "~/.cursor/worktrees/") and retry.`,
    reasonCode: REASON_CODE.NOT_ISOLATED_WORKTREE,
  };
}

/* istanbul ignore next -- stdin adapter, exercised via spawnSync in tests */
function main() {
  let raw = '';
  const stdinTimeout = setTimeout(() => {
    allow(undefined);
  }, 10000);

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    clearTimeout(stdinTimeout);

    let data = null;
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }

    // Resolve the state-reminder context ONCE, up front, so it can ride along
    // with EITHER outcome below (#3045 MINOR: a deny previously dropped this
    // reminder entirely — process.stdout.write for the deny branch returned
    // before the additional_context block ever ran — instead of preserving it
    // alongside the deny; the subagent still benefits from phase/blocker
    // context even when its dispatch is refused).
    let additionalContext = null;
    try {
      const statePath = resolveStatePath(raw);
      const statePresent = fs.existsSync(statePath);
      additionalContext = statePresent ? MSG_PRESENT : MSG_ABSENT;
    } catch {
      additionalContext = null;
    }

    if (data && typeof data === 'object') {
      let decision = { action: 'allow' };
      try {
        decision = resolveIsolationDecision(data);
      } catch {
        // Defense in depth only: every verify-and-deny path above has its own
        // explicit try/catch that resolves to a deny with a distinct reason.
        // Anything reaching here is an unexpected failure outside those paths
        // (e.g. malformed workspace_roots entries) — never crash the hook.
        decision = { action: 'allow' };
      }
      if (decision.action === 'deny') {
        const out = { permission: 'deny', user_message: decision.reason, reason_code: decision.reasonCode };
        if (additionalContext !== null) out.additional_context = additionalContext;
        process.stdout.write(JSON.stringify(out));
        return;
      }
    }

    process.stdout.write(JSON.stringify(additionalContext !== null ? { additional_context: additionalContext } : {}));
  });
}

if (require.main === module) {
  main();
}

// #3045 MAJOR ("clock seam is dead code" fix): exported so tests can
// `require()` this module and inject a `clock` (`{now(): number}`) directly
// per the repo's clock-seam convention, instead of racing real `Date.now()`
// across a spawned subprocess boundary.
module.exports = {
  resolveIsolationDecision,
  evaluateRootIsolation,
  resolveFallbackIsolation,
  resolveIsolationEvidence,
  getWorkspaceRoots,
  _setInstallRuntimeMarkerForTests,
};
