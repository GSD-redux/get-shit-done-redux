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

// Workspace resolution is shared across the Cursor hooks (#2587) — see
// hooks/lib/cursor-workspace.js. Staged next to these scripts by
// writeCursorHooksJson so the require always resolves post-install.
const { resolveStatePath } = require('./lib/cursor-workspace.js');

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

const VALID_ISOLATION = new Set(['harness-worktree', 'orchestrator-worktree', 'none']);

/**
 * Resolve whether `root` is running in a session Cursor is isolating from the
 * user's primary checkout. Two independent (OR'd) signals:
 *
 *   1. `resolveWorktreeLinkage` (gsd-core's shortcut-free git-dir-vs-
 *      git-common-dir comparison, #3045) reports `linked_worktree_root` for
 *      `root`. This is deliberately NOT `resolveWorktreeContext` — that
 *      function's `has_local_planning` shortcut would misclassify an
 *      isolated worktree (which normally has its own checked-out
 *      `.planning/`) as "not isolated", the exact false positive that would
 *      make this guard unusable.
 *   2. `root` resolves under Cursor's own managed worktree root
 *      (`<cursor config dir>/worktrees`, i.e. `~/.cursor/worktrees` by
 *      default — `getGlobalConfigDir('cursor')` honors the
 *      `CURSOR_CONFIG_DIR` env override and `~` expansion for free).
 *
 * Returns `{ isolated: true|false, cannotDetermine: bool }`. `cannotDetermine`
 * is set only when git itself failed to answer (timeout) AND the managed-root
 * check also did not confirm isolation — a directory that is definitively
 * not a git repo (`not_git_repo`) is a confident negative, not an unknown,
 * since Cursor's worktree mechanism is git-based.
 */
function resolveIsolationEvidence(root) {
  let underManagedRoot = false;
  try {
    // Sibling data/policy module, staged alongside this hook at install time
    // (same pattern as hooks/gsd-statusline.js's requires of gsd-core/bin/lib/*).
    const { getGlobalConfigDir } = require('../gsd-core/bin/lib/runtime-homes.cjs');
    const managedRoot = path.join(getGlobalConfigDir('cursor'), 'worktrees');
    const rel = path.relative(managedRoot, root);
    underManagedRoot = rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    // Secondary signal only — degrade to "not confirmed by this signal" and
    // rely on the git-based linkage check below, which has its own explicit
    // cannot-determine handling.
    underManagedRoot = false;
  }

  let linkage;
  try {
    // Sibling data/policy module, staged alongside this hook at install time.
    const { resolveWorktreeLinkage } = require('../gsd-core/bin/lib/worktree-safety.cjs');
    linkage = resolveWorktreeLinkage(root);
  } catch {
    return { isolated: underManagedRoot, cannotDetermine: !underManagedRoot };
  }

  if (linkage.mode === 'linked_worktree_root' || underManagedRoot) {
    return { isolated: true, cannotDetermine: false };
  }
  if (linkage.reason === 'git_timed_out') {
    return { isolated: false, cannotDetermine: true };
  }
  // 'not_git_repo' or 'main_worktree' (or the shortcut-free primitive's
  // fallback 'current_directory' shape for any other case) — a confident
  // negative, not an unknown.
  return { isolated: false, cannotDetermine: false };
}

/**
 * Resolve the first non-empty string entry of `workspace_roots` — the real
 * checkout path Cursor is operating on for this hook invocation. Cursor runs
 * hooks with cwd set to its own config dir (~/.cursor), NOT the workspace
 * (hooks/lib/cursor-workspace.js), so `workspace_roots` is the only reliable
 * source for "what directory is this dispatch actually in".
 */
function firstWorkspaceRoot(data) {
  const roots = Array.isArray(data.workspace_roots) ? data.workspace_roots : [];
  for (const r of roots) {
    if (typeof r === 'string' && r.length > 0) return r;
  }
  return null;
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
 * Runtime resolution mirrors hooks/gsd-agent-isolation-guard.js's
 * resolveIsolationState (GSD_RUNTIME env > .planning/config.json `runtime`
 * key > default) so the same GSD_RUNTIME override technique that hook's own
 * tests use to exercise orchestrator-worktree/none paths works here too —
 * the default is "cursor" (not "claude"), since this script only ever runs
 * under Cursor's own subagentStart event.
 */
function resolveIsolationDecision(data) {
  const subagentType = data.subagent_type;
  const isConfirmedNonExecutor = typeof subagentType === 'string'
    && subagentType.length > 0
    && !EXECUTOR_SUBAGENT_TYPES.has(subagentType);
  if (isConfirmedNonExecutor) return { action: 'allow' };

  const root = firstWorkspaceRoot(data);
  if (!root) return { action: 'allow' };

  const configPath = path.join(root, '.planning', 'config.json');
  let isGsdProject;
  try {
    fs.accessSync(configPath, fs.constants.F_OK);
    isGsdProject = true;
  } catch {
    isGsdProject = false;
  }
  if (!isGsdProject) return { action: 'allow' };

  let declaredIsolation;
  try {
    // Sibling data/policy modules, staged alongside this hook at install time.
    const { resolveRuntimeNameFromCandidates } = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
    const { runtimes } = require('../gsd-core/bin/lib/capability-registry.cjs');

    let runtimeId = resolveRuntimeNameFromCandidates(process.env.GSD_RUNTIME);
    if (!runtimeId) {
      const rawConfig = fs.readFileSync(configPath, 'utf-8');
      const parsedConfig = JSON.parse(rawConfig);
      if (parsedConfig && typeof parsedConfig === 'object' && 'runtime' in parsedConfig) {
        runtimeId = resolveRuntimeNameFromCandidates(parsedConfig.runtime) || 'cursor';
      } else {
        runtimeId = 'cursor';
      }
    }

    const runtimeEntry = runtimes != null ? runtimes[runtimeId] : null;
    const declared = runtimeEntry?.runtime?.hostIntegration?.dispatch?.isolation ?? null;
    declaredIsolation = (typeof declared === 'string' && VALID_ISOLATION.has(declared)) ? declared : 'none';
  } catch {
    return {
      action: 'deny',
      reason:
        `GSD subagent isolation guard: could not read or resolve this project's ` +
        `dispatch-isolation configuration ('.planning/config.json' exists under "${root}"). ` +
        `Refusing to allow this subagent to spawn without being able to verify whether ` +
        `isolation is required — a guard that cannot verify must not answer "safe" (#3050). ` +
        `Retry once the project configuration is readable.`,
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
    };
  }

  const evidence = resolveIsolationEvidence(root);
  if (evidence.isolated) return { action: 'allow' };

  if (evidence.cannotDetermine) {
    return {
      action: 'deny',
      reason:
        `GSD subagent isolation guard: this project's dispatch isolation resolves to ` +
        `"harness-worktree", but whether "${root}" is running in an isolated Cursor worktree ` +
        `could not be determined (git did not respond). Refusing to allow subagent_type=` +
        `"${subagentType}" to spawn without being able to verify isolation — a guard that ` +
        `cannot verify must not answer "safe" (#3050). Retry once git is responsive.`,
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
  };
}

let raw = '';
const stdinTimeout = setTimeout(() => {
  process.exit(0);
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
      process.stdout.write(JSON.stringify({ permission: 'deny', user_message: decision.reason }));
      return;
    }
  }

  try {
    const statePath = resolveStatePath(raw);
    const statePresent = fs.existsSync(statePath);
    const msg = statePresent ? MSG_PRESENT : MSG_ABSENT;
    process.stdout.write(JSON.stringify({ additional_context: msg }));
  } catch {
    process.stdout.write(JSON.stringify({}));
  }
});
