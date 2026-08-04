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
// Resolution mirrors `routeDispatchIsolation` in `gsd-core/bin/gsd-tools.cjs`
// (resolveRuntime precedence: GSD_RUNTIME env > .planning/config.json
// `runtime` > 'claude'; then `capability-registry.cjs`
// runtimes[id].runtime.hostIntegration.dispatch.isolation +
// harnessIsolationFlag) — read directly, in-process, no subprocess spawn.
//
// Triggers on: Agent tool calls with subagent_type === "gsd-executor"
// Action: BLOCK (exit 2) when isolation should be enforced and is not
// No-op: any tool other than Agent, non-executor targets, GSD projects whose
//        resolved isolation is not harness-worktree, non-GSD projects,
//        malformed payloads, or a dispatch that already carries the correct
//        isolation parameter.

'use strict';

const fs = require('fs');
const path = require('path');

// No other executor-shaped subagent_type exists in agents/ today
// (verified: only agents/gsd-executor.md). A Set, not a bare string compare,
// so a future sibling executor role can be added here without touching the
// matching logic below.
const EXECUTOR_SUBAGENT_TYPES = new Set(['gsd-executor']);

const VALID_ISOLATION = new Set(['harness-worktree', 'orchestrator-worktree', 'none']);

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
 */
function resolveIsolationState(cwd) {
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

  try {
    // Sibling data/policy modules, staged alongside this hook at install time
    // (same pattern as hooks/gsd-statusline.js's requires of gsd-core/bin/lib/*).
    const { resolveRuntimeNameFromCandidates } = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
    const { runtimes } = require('../gsd-core/bin/lib/capability-registry.cjs');

    let runtimeId = resolveRuntimeNameFromCandidates(process.env.GSD_RUNTIME);
    if (!runtimeId) {
      // Read config.json directly for the `runtime` key (side-effect-free,
      // same reasoning as runtime-slash.cjs's resolveRuntime). A throw here
      // (corrupt JSON, EISDIR, permission error) is NOT "no override
      // configured" — that case is excluded by the existence check above —
      // it is "GSD project present, config unreadable", and must propagate
      // to the outer catch as a resolution failure.
      const raw = fs.readFileSync(configPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && 'runtime' in parsed) {
        runtimeId = resolveRuntimeNameFromCandidates(parsed.runtime) || 'claude';
      } else {
        runtimeId = 'claude';
      }
    }

    const runtimeEntry = runtimes != null ? runtimes[runtimeId] : null;
    const declared = runtimeEntry?.runtime?.hostIntegration?.dispatch?.isolation ?? null;
    let isolation = (typeof declared === 'string' && VALID_ISOLATION.has(declared)) ? declared : 'none';

    let harnessFlag = null;
    if (isolation === 'harness-worktree') {
      const declaredFlag = runtimeEntry?.runtime?.harnessIsolationFlag ?? null;
      if (typeof declaredFlag === 'string' && declaredFlag.length > 0) {
        harnessFlag = declaredFlag;
      } else {
        // A host claiming harness isolation with no declared flag gives this
        // guard nothing to check for — degrade to 'none' rather than block
        // on an unspecifiable requirement.
        isolation = 'none';
      }
    }

    return { gsdProject: true, isolation, harnessFlag, error: null };
  } catch (err) {
    return { gsdProject: true, isolation: null, harnessFlag: null, error: err };
  }
}

let input = '';
const stdinTimeout = setTimeout(() => process.exit(0), 3000);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  clearTimeout(stdinTimeout);
  try {
    const data = JSON.parse(input);
    if (!data || typeof data !== 'object') { process.exit(0); }
    if (data.tool_name !== 'Agent') { process.exit(0); }

    const toolInput = (data.tool_input && typeof data.tool_input === 'object') ? data.tool_input : {};
    const subagentType = toolInput.subagent_type;
    if (typeof subagentType !== 'string' || !EXECUTOR_SUBAGENT_TYPES.has(subagentType)) {
      process.exit(0);
    }

    const cwd = data.cwd || process.cwd();
    const state = resolveIsolationState(cwd);

    if (!state.gsdProject) { process.exit(0); }

    if (state.error) {
      const reason =
        `Agent isolation guard: could not read or resolve this project's dispatch-isolation ` +
        `configuration ('.planning/config.json' under '${cwd}'). Refusing to dispatch ` +
        `subagent_type="${subagentType}" without being able to verify whether isolation is ` +
        `required — a guard that cannot verify must not answer "safe" (#3050). Retry once the ` +
        `project configuration is readable.`;
      const out = { decision: 'block', reason };
      process.stdout.write(JSON.stringify(out));
      // Kimi feeds stderr (not stdout) back to the model on exit 2.
      process.stderr.write(reason);
      process.exit(2);
    }

    if (state.isolation !== 'harness-worktree') { process.exit(0); }

    const parsed = parseHarnessFlag(state.harnessFlag);
    if (!parsed) { process.exit(0); }

    if (toolInput[parsed.param] === parsed.value) { process.exit(0); }

    const reason =
      `Agent isolation guard: this project's dispatch isolation resolves to "harness-worktree", ` +
      `but the Agent() dispatch for subagent_type="${subagentType}" is missing ` +
      `${parsed.param}="${parsed.value}". Add ${parsed.param}="${parsed.value}" to the Agent() ` +
      `call so the executor runs in an isolated worktree instead of the primary checkout ` +
      `(gsd-core/workflows/execute-phase/steps/executor-isolation-dispatch.md).`;
    const out = { decision: 'block', reason };
    process.stdout.write(JSON.stringify(out));
    process.stderr.write(reason);
    process.exit(2);
  } catch {
    // Silent fail — never block valid tool calls due to hook errors
    // (malformed payload, etc.). This is distinct from resolveIsolationState's
    // internal error handling, which DOES deny — this outer catch only
    // covers payload parsing before applicability could even be determined.
    process.exit(0);
  }
});
