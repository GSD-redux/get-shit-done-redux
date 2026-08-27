#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const crypto = require('crypto');
const {
  isManagedHookBasename,
  isManagedHookCommand,
  projectLocalHookPrefix,
  projectLegacySettingsHookCommand,
  projectManagedHookCommand,
  projectPathActionProjection,
  projectPortableHookBaseDir,
  projectPersistentPathExportActions,
  PATH_ACTION_REASON,
  projectShellCommandText,
  projectCodexHookTomlCommand,
  shellHookOmitsBashRunner,
  buildLocalShellHookCommand,
} = require('../gsd-core/bin/lib/shell-command-projection.cjs');

// Bidirectional GSD slash-command namespace transformer (#3583).
// Required at module scope so the command list can be computed once per install
// and passed down to convertClaudeCommandToClaudeSkill, avoiding repeated
// fs.readdirSync + RegExp work for every skill.
const {
  transformContentToHyphen,
  readGsdCommandNames,
} = require('../gsd-core/bin/lib/command-roster.cjs');
const {
  resolveAntigravityGlobalDir,
  getGlobalConfigDir,
  getGlobalSkillsBase,
  resolveKimiHooksTomlDir,
  isRegisteredRuntimeId,
} = require('../gsd-core/bin/lib/runtime-homes.cjs');
// #2870: the Install Scope Module — turns a bare 'global' | 'local' scope id
// plus a runtime into one resolved value (configHome, settingsFile,
// consentRequired, hostPrecedenceRank) instead of the id being re-derived
// and re-interpreted at each call site. See src/install-scope.cts.
const { resolveScope } = require('../gsd-core/bin/lib/install-scope.cjs');
const { isTestHomeGuardRefusal } = require('../gsd-core/bin/lib/real-home-guard.cjs');
// getDirName (runtime -> local config dir name) is relocated out of this
// installer to the runtime-name-policy leaf (ADR-1508 / #1510 Phase 1) so the
// conversion module's rewrite engine can consume it without importing
// bin/install.js. Imported here for install.js's own internal call sites
// (getConfigDirFromHome and the runtime-content-rewrite loops below) — #2876
// retired the re-export; tests now import getDirName directly from
// gsd-core/bin/lib/runtime-name-policy.cjs.
const { getDirName, getRuntimeLabel, getGlobalConfigHomeFragment, runtimeFlags, getRuntimeNewProjectCommand } = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
const {
  applyWorktreeBaseRef,
  readBaseRefFromSettings,
} = require('../gsd-core/bin/lib/worktree-base-ref.cjs');
const { resolveInstallPlan } = require('../gsd-core/bin/lib/runtime-config-adapter-registry.cjs');
const { createImperativeAdapter } = require('../gsd-core/bin/lib/adapter-imperative.cjs');
// #2930 (epic #1671 Phase 3): strips `<!-- gsd:section -->` markers from
// workflow .md content at emit time, before any per-runtime rewrite runs.
const { composeWorkflow } = require('../gsd-core/bin/lib/workflow-fragments.cjs');
// #3072: THE shared composition-scope predicate (also consumed by the served
// MCP catalog, src/mcp-catalog.cts) — see the comment at its call site below.
const { shouldCompose } = require('../gsd-core/bin/lib/mcp-catalog.cjs');
const runtimeArtifactConversion = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
const { escapeRegex: escapeRegExp } = require('../gsd-core/bin/lib/pattern.cjs');
// #2873: cross-scope shadow detection — reports (never fails) when a
// GSD-owned scope shadows another on this machine (design doc:
// .gsd/phase/feat-2873-cross-scope-shadowing/40-design.md).
const { buildShadowReport, renderShadowReport } = require('../gsd-core/bin/lib/install-shadow-report.cjs');
// #2544: the CommonJS marker's single source of truth. classifyMarker() backs
// BOTH ensureCommonJsMarker() (install) and removeCommonJsMarker() (uninstall),
// so the write side can no longer clobber a package.json the remove side would
// correctly refuse to delete.
const { ensureCommonJsMarker, removeCommonJsMarker } = require('../gsd-core/bin/lib/commonjs-marker.cjs');
// Canonical set of hook files shipped to users. Imported here so writeManifest()
// records exactly the same set that build-hooks.js copies to hooks/dist/, making
// the manifest and the installed hooks/ dir structurally identical. Avoids the
// prefix/extension-regex approach that missed managed-hooks-registry.cjs (#941).
const { HOOKS_TO_COPY: _HOOKS_TO_COPY } = require('../scripts/build-hooks.js');
const INSTALLED_HOOK_FILES = new Set(_HOOKS_TO_COPY);

// ADR-857 phase 5f-1: hook-surface writer functions extracted to a dedicated
// module. install.js used to re-export the whole hooksSurface surface so
// existing callers (require('../bin/install.js').writeCursorHooksJson etc.)
// kept working — #2876 found zero production/test consumers of any of those
// re-exports (tests import runtime-hooks-surface.cjs directly) and retired
// them from module.exports. install.js still requires hooksSurface below for
// its own internal call sites (writeCursorHooksJson, writeClineArtifacts,
// resolveNodeRunner, applySettingsJsonHooks, etc.).
const hooksSurface = require('../gsd-core/bin/lib/runtime-hooks-surface.cjs');

/**
 * #3677 predicate — true when an agent body needs `/gsd:<cmd>` → `/gsd-<cmd>`
 * normalization at install time. Descriptor-driven
 * (capabilities/<runtime>/capability.json -> runtime.hostBehaviors.hyphenNameAgentBody)
 * instead of a hardcoded runtime allow-list (ADR-1239 / #2086). Sibling fixes
 * #3583 / #3629 covered SKILL.md bodies, #3584 / #3606 covered runtime
 * emissions — this is the agent-body surface (#3677).
 *
 * Unknown / future runtimes that don't declare the flag default to "no
 * rewrite" (better to leak than to mangle a runtime whose namespace
 * behavior we haven't verified).
 */
function shouldNormalizeHyphenNamespaceInAgentBody(runtime) {
  if (typeof runtime !== 'string' || runtime === '') return false;
  return _hostBehaviors(runtime).hyphenNameAgentBody === true;
}

/**
 * #3677 helper — applies the hyphen-namespace transform iff the predicate
 * says so. Pure function; safe to call unconditionally from the install
 * loop. Returns the input unchanged for runtimes that self-convert or
 * intentionally keep colon refs.
 */
function normalizeAgentBodyForRuntime(content, runtime, cmdNames) {
  if (!shouldNormalizeHyphenNamespaceInAgentBody(runtime)) return content;
  return transformContentToHyphen(content, cmdNames);
}

// Colors
const cyan = '\x1b[36m';
const green = '\x1b[32m';
const yellow = '\x1b[33m';
const red = '\x1b[31m';
const bold = '\x1b[1m';
const dim = '\x1b[2m';
const reset = '\x1b[0m';

// Codex config.toml constants
const GSD_CODEX_MARKER = '# GSD Agent Configuration \u2014 managed by gsd-core installer';
const GSD_CODEX_HOOKS_OWNERSHIP_PREFIX = '# GSD codex_hooks ownership: ';
// Known scalar fields of Codex's `AgentsToml` struct (codex-rs/config/src/
// config_toml.rs \u2014 `[agents]` table). Codex marks the struct
// `#[schemars(deny_unknown_fields)]`, so a bare `[agents]` table is valid ONLY
// when every direct key is one of these (named agent roles live in the flattened
// `[agents.<name>]` sub-tables, a separate `AgentRoleToml`). GSD writes only
// `max_depth` (ADR-1239 upgrade 2 / #2088); the full set is enumerated so the
// schema check accepts a user's other legitimate AgentsToml scalars too.
const CODEX_AGENTS_TOML_SCALAR_KEYS = new Set([
  'max_threads',
  'max_depth',
  'job_max_runtime_seconds',
  'interrupt_message',
]);
// GSD's managed dispatch-depth value. Codex's implicit default is also 1 (root
// sessions start at depth 0); writing it EXPLICITLY pins the negotiated
// `dispatch.maxDepth: 1` axis instead of relying on codex-cli's implicit default
// (ADR-1239 upgrade 2 / #2088). Per the negotiated capability, GSD-hosted Codex
// dispatch is single-level (maxDepth === 1 \u2192 `degradationFor` flattens waves).
const GSD_CODEX_AGENTS_MAX_DEPTH = 1;
// Codex hooks.json lifecycle events GSD registers beyond SessionStart (which has
// its own dedicated path). This is Codex's OWN hook-event vocabulary (per
// developers.openai.com/codex/config-reference), distinct from the cross-runtime
// settings.json `extendedHookEvents` descriptor field (a claude/gemini-family
// allowlist consumed only by hooksSurface==='settings-json' runtimes — Codex is
// codex-hooks-json). All route through gsd-context-monitor.js. #772 wired the
// first three; #2088 adds the remaining six documented events so GSD's monitor
// fires at the same lifecycle points as in Claude Code. Install and uninstall
// share this list so the registered set and the removed set never diverge.
const CODEX_EXTENDED_HOOK_EVENTS = [
  'SubagentStart',
  'Stop',
  'PostToolUse',
  'PreToolUse',
  'PermissionRequest',
  'PreCompact',
  'PostCompact',
  'SubagentStop',
  'UserPromptSubmit',
];
// Codex's hook-enabling feature flag (issue #3566). Codex itself marks
// `codex_hooks` as a `legacy_key` in codex-rs/features/src/legacy.rs; the
// canonical current key under [features] is `hooks`. The installer always
// emits the canonical key going forward, recognizes legacy aliases as
// equivalent during reinstall, and migrates them forward on rewrite. The
// audit-marker string above is intentionally unchanged so existing
// installs' ownership lines continue to round-trip.
const CODEX_HOOKS_FEATURE_KEY = 'hooks';
const CODEX_HOOKS_FEATURE_LEGACY_KEYS = ['codex_hooks'];
const CODEX_HOOKS_FEATURE_ALL_KEYS = [CODEX_HOOKS_FEATURE_KEY, ...CODEX_HOOKS_FEATURE_LEGACY_KEYS];
function isCodexHooksFeatureKey(key) {
  return CODEX_HOOKS_FEATURE_ALL_KEYS.includes(key);
}

// #768 \u2014 Claude Code permissions.allow / permissions.deny entries.
// Pre-populated during Claude installs to eliminate first-run approval friction
// for gsd-core's own known-safe tool calls, and to add defense-in-depth deny
// entries for common credential files.
//
// Format: each string uses Claude Code's documented permission rule syntax \u2014
//   "Tool(pattern)"  e.g. "Bash(npx gsd-core *)", "Read(.planning/*)"
//   "Tool"           (bare tool name, no pattern)
//
// Merge policy: additive, non-destructive \u2014 existing user entries are preserved;
// GSD entries are appended only when not already present (idempotent).
// The reference/default runtime (ADR-1239 reference host). Single-sourced here
// instead of scattered literal 'claude' defaults/rosters (#2086).
const DEFAULT_RUNTIME = 'claude';
const GSD_CLAUDE_ALLOW_PERMISSIONS = Object.freeze([
  'Bash(npx gsd-core *)',
  'Read(.planning/*)',
  'Edit(.planning/*)',
  'Read(STATE.md)',
  'Edit(STATE.md)',
]);
const GSD_CLAUDE_DENY_PERMISSIONS = Object.freeze([
  'Read(.env)',
  'Read(.env.*)',
  'Read(.secrets)',
]);
// #2278 — Stale allow-rule forms from before the fix. Claude Code has no
// standalone `Write` permission gate: file-editing tools (Write/Edit/
// NotebookEdit) are gated collectively via `Edit(pattern)`. The original
// `Write(.planning/*)` / `Write(STATE.md)` entries were therefore silently
// unmatched (never granted anything) and Claude Code additionally surfaces a
// session-start warning about unmatched permission rules. This list lets
// mergeClaudePermissions and uninstall cleanup retire those stale entries on
// existing installs while the current GSD_CLAUDE_ALLOW_PERMISSIONS above
// carries the working `Edit(...)` forms.
const GSD_CLAUDE_LEGACY_ALLOW_PERMISSIONS = Object.freeze([
  'Write(.planning/*)',
  'Write(STATE.md)',
]);

/**
 * Merge GSD-owned permission entries into a Claude Code settings object.
 *
 * Additive and idempotent: existing allow/deny entries are preserved; GSD
 * entries are appended only if not already present. No other permission sub-keys
 * (ask, disableBypassPermissionsMode, etc.) are touched.
 *
 * Migration (#2278): before adding the current GSD_CLAUDE_ALLOW_PERMISSIONS,
 * any stale GSD_CLAUDE_LEGACY_ALLOW_PERMISSIONS entry (e.g. the unmatched
 * `Write(...)` forms from before the fix) is removed from permissions.allow,
 * so existing installs end up with the working `Edit(...)` forms instead of
 * both the dead legacy entry and its replacement sitting side by side.
 *
 * Defensive: if settings is not a plain object, returns immediately without
 * throwing. If permissions.allow / permissions.deny exist but are not arrays
 * (malformed settings), they are replaced with valid arrays.
 *
 * @param {object} settings - The parsed settings.json object to mutate in-place.
 */
function mergeClaudePermissions(settings) {
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) return;

  if (!settings.permissions || typeof settings.permissions !== 'object' || Array.isArray(settings.permissions)) {
    settings.permissions = {};
  }

  if (!Array.isArray(settings.permissions.allow)) {
    settings.permissions.allow = [];
  }
  if (!Array.isArray(settings.permissions.deny)) {
    settings.permissions.deny = [];
  }

  settings.permissions.allow = settings.permissions.allow.filter(
    (e) => !GSD_CLAUDE_LEGACY_ALLOW_PERMISSIONS.includes(e)
  );

  for (const entry of GSD_CLAUDE_ALLOW_PERMISSIONS) {
    if (!settings.permissions.allow.includes(entry)) {
      settings.permissions.allow.push(entry);
    }
  }
  for (const entry of GSD_CLAUDE_DENY_PERMISSIONS) {
    if (!settings.permissions.deny.includes(entry)) {
      settings.permissions.deny.push(entry);
    }
  }
}

// Copilot instructions marker constants
const GSD_COPILOT_INSTRUCTIONS_MARKER = '<!-- GSD Configuration \u2014 managed by gsd-core installer -->';
const GSD_COPILOT_INSTRUCTIONS_CLOSE_MARKER = '<!-- /GSD Configuration -->';

// #786 \u2014 GitHub Copilot CLI lifecycle hook constants.
// Copilot reads hook configs from <config>/hooks/*.json (repo scope: .github/hooks/,
// user scope: ~/.copilot/hooks/) with the shape { version, hooks: { <event>: [...] } }.
// Events use camelCase (sessionStart, preToolUse, postToolUse, ...). A `command`
// hook runs an INLINE shell command (bash / powershell), so the GSD hook is fully
// self-contained \u2014 there is no separate hook script to install, and therefore
// nothing that can dangle if a script copy is skipped. See
// https://docs.github.com/en/copilot/reference/hooks-configuration
const GSD_COPILOT_HOOK_FILE = 'gsd-session.json';
// Copilot parses a command hook's stdout as the hook-output JSON. For sessionStart
// the schema is `{ additionalContext?: string }` (the text is prepended to the
// session as context). So the hook must emit that JSON envelope — not bare text.
// The two messages contain no JSON-special characters, so they embed verbatim.
const GSD_COPILOT_SESSION_MSG_PRESENT =
  'GSD: .planning/STATE.md present - review the current phase and any blockers before acting.';
const GSD_COPILOT_SESSION_MSG_ABSENT =
  'GSD: no .planning/ workflow found - run /gsd-new-project to start a tracked workflow.';
const GSD_COPILOT_SESSION_HOOK_BASH =
  'if [ -f .planning/STATE.md ]; then ' +
  `printf '%s' '{"additionalContext":"${GSD_COPILOT_SESSION_MSG_PRESENT}"}'; else ` +
  `printf '%s' '{"additionalContext":"${GSD_COPILOT_SESSION_MSG_ABSENT}"}'; fi`;
const GSD_COPILOT_SESSION_HOOK_PWSH =
  'if (Test-Path .planning/STATE.md) ' +
  `{ '{"additionalContext":"${GSD_COPILOT_SESSION_MSG_PRESENT}"}' } ` +
  `else { '{"additionalContext":"${GSD_COPILOT_SESSION_MSG_ABSENT}"}' }`;

// #777 — Cursor CLI lifecycle hook constants.
// Cursor reads hook configs from <project-root>/.cursor/hooks.json (local) or
// ~/.cursor/hooks.json (global) with the shape { version: 1, hooks: { <event>: [...] } }.
// Events use camelCase: sessionStart, postToolUse, preToolUse, etc.
// A `command` hook entry runs an external script. GSD registers six managed hooks
// (AC4a upgrade, #2089 — ADR-1239):
//   sessionStart   → gsd-cursor-session-start.js   (context injection)
//   postToolUse    → gsd-cursor-post-tool.js        (STATE.md update monitor)
//   preToolUse     → gsd-cursor-pre-tool.js         (write-path guard)
//   stop           → gsd-cursor-stop.js             (verify-work reminder)
//   subagentStart  → gsd-cursor-subagent-start.js   (subagent context injection)
//   subagentStop   → gsd-cursor-subagent-stop.js    (subagent completion reminder)
// Cursor docs: https://cursor.com/docs/hooks
//
// These script-name/marker constants used to be independently re-declared
// here with their own string literals — a second, unlinked copy of exactly
// the values runtime-hooks-surface.cts also defines for its own internal use
// (buildCursorHookEntry, writeCursorHooksJson, etc.). #2876's code review
// found tests reading the constant from install.js's copy while calling
// functions built from hooksSurface's copy, with nothing guarding the two
// staying equal — the same unlinked-duplicate-value hazard the ADR-1508
// dedup elsewhere in this file exists to prevent. Fixed at the root: these
// are now bare references to hooksSurface's own exports, so there is exactly
// one literal definition of each value, full stop.
const GSD_CURSOR_SESSION_HOOK_SCRIPT = hooksSurface.GSD_CURSOR_SESSION_HOOK_SCRIPT;
const GSD_CURSOR_POST_TOOL_HOOK_SCRIPT = hooksSurface.GSD_CURSOR_POST_TOOL_HOOK_SCRIPT;
const GSD_CURSOR_PRE_TOOL_HOOK_SCRIPT = hooksSurface.GSD_CURSOR_PRE_TOOL_HOOK_SCRIPT;
const GSD_CURSOR_STOP_HOOK_SCRIPT = hooksSurface.GSD_CURSOR_STOP_HOOK_SCRIPT;
const GSD_CURSOR_SUBAGENT_START_HOOK_SCRIPT = hooksSurface.GSD_CURSOR_SUBAGENT_START_HOOK_SCRIPT;
const GSD_CURSOR_SUBAGENT_STOP_HOOK_SCRIPT = hooksSurface.GSD_CURSOR_SUBAGENT_STOP_HOOK_SCRIPT;
// All GSD-managed Cursor hook scripts (used by uninstall cleanup). Not
// independently defined in hooksSurface — built here from the bare
// references above, so it can never drift from them either.
const GSD_CURSOR_HOOK_SCRIPTS = [
  GSD_CURSOR_SESSION_HOOK_SCRIPT,
  GSD_CURSOR_POST_TOOL_HOOK_SCRIPT,
  GSD_CURSOR_PRE_TOOL_HOOK_SCRIPT,
  GSD_CURSOR_STOP_HOOK_SCRIPT,
  GSD_CURSOR_SUBAGENT_START_HOOK_SCRIPT,
  GSD_CURSOR_SUBAGENT_STOP_HOOK_SCRIPT,
];
// Marker comment embedded in managed hook entries so GSD can find+remove them.
const GSD_CURSOR_HOOK_MARKER = hooksSurface.GSD_CURSOR_HOOK_MARKER;

// #2100 Stage 2 — Windsurf/Cascade lifecycle hook constants.
// Windsurf/Cascade reads hook configs from <project-root>/.windsurf/hooks.json
// (local) or ~/.codeium/windsurf/hooks.json (global) with the shape
// { hooks: { <event>: [ { command, ... } ] } } — note: no top-level `version`
// field, and each entry carries a bare `command` shell string (no `type`
// field), unlike Cursor's hooks.json. GSD registers two managed BLOCKING
// hooks (exit code 2 to block, vs. Cursor's stdout-JSON form):
//   pre_write_code   → gsd-windsurf-pre-write.js    (write-path guard)
//   pre_run_command  → gsd-windsurf-pre-command.js  (destructive-command guard)
// Cascade has no context-injection channel, so the 4 advisory hooks GSD
// registers on Cursor (sessionStart, postToolUse, stop, subagentStart/Stop)
// have no Windsurf counterpart and are deliberately NOT ported.
// Cascade hooks docs (reference): https://docs.windsurf.com/llms-full.txt ,
//                                  https://docs.devin.ai/desktop/cascade/hooks
//
// Same #2876 fix as the Cursor block above: bare references to hooksSurface's
// own exports instead of a second, unlinked literal copy.
const GSD_WINDSURF_PRE_WRITE_HOOK_SCRIPT = hooksSurface.GSD_WINDSURF_PRE_WRITE_HOOK_SCRIPT;
const GSD_WINDSURF_PRE_COMMAND_HOOK_SCRIPT = hooksSurface.GSD_WINDSURF_PRE_COMMAND_HOOK_SCRIPT;
// All GSD-managed Windsurf hook scripts (used by uninstall cleanup).
// hooksSurface independently defines the same array — bare reference here so
// the two can never drift.
const GSD_WINDSURF_HOOK_SCRIPTS = hooksSurface.GSD_WINDSURF_HOOK_SCRIPTS;

// GSD-managed files under hooks/lib/ (helpers required by gsd-*.js hooks).
// git-cmd.js does not start with "gsd-" (shared classifier for #3129), gsd-graphify-rebuild.sh does.
// cursor-workspace.js (#2587) is required by the Cursor lifecycle hooks. Those
// are staged individually by writeCursorHooksJson (Cursor sets
// hostBehaviors.skipSharedHooksInstall, so it never reaches the bulk hooks/lib
// copy below) — that function stages this helper alongside them. Listing it
// here keeps uninstall and the manifest managing it for every OTHER runtime
// that does receive hooks/lib.
// injection-patterns.js (#3504) is required by gsd-prompt-guard.js and
// gsd-read-injection-scanner.js — the shared prompt-injection pattern list the
// two guards require so their copies cannot drift.
const GSD_HOOK_LIB_FILES = ['git-cmd.js', 'gsd-graphify-rebuild.sh', 'cursor-workspace.js', 'injection-patterns.js'];

/**
 * Directory name GSD stages its shared hook bundle under, inside a runtime's
 * install root. Defaults to 'hooks' — the name every runtime used before #3023.
 *
 * pi (pi.dev) reserves `hooks/` as its own now-deprecated extension location and
 * prints a migration warning on every startup when one exists, so pi overrides
 * this via hostBehaviors.sharedHooksDirName. Following pi's advised remediation
 * (move it into extensions/) would break the adapter's path resolution AND expose
 * GSD's .js helpers to pi's extension auto-discovery, so the bundle is renamed in
 * place instead — same depth, so every `__dirname/..`-relative resolution inside
 * the bundle (e.g. hooks/gsd-context-monitor.js reaching ../gsd-core/bin/) keeps
 * working.
 */
const SHARED_HOOKS_DIR_DEFAULT = 'hooks';

// #3184 — GSD-managed file enumerations for scripts/changeset/ and scripts/lib/
// uninstall. The install-side copy of both directories is wholesale ("copy every
// file present"), so these enumerations MUST be kept in parity with the real
// directory contents or an added file ships on install and then orphans on
// uninstall (survives removal, keeps the dir non-empty, blocks its rmdir).
// Hoisted to module scope (and exported below) so tests/install.test.cjs can
// assert parity against fs.readdirSync(scripts/lib) / fs.readdirSync(scripts/changeset)
// without source-grepping this file.
const GSD_CHANGESET_FILES = [
  'cli.cjs', 'parse.cjs', 'render.cjs', 'serialize.cjs',
  'github-release-notes.cjs', 'lint.cjs', 'new.cjs',
  'README.md', // documentation only — not user-authored
];
const GSD_SCRIPTS_LIB_FILES = ['cli-exit.cjs', 'allowlist-ratchet.cjs', 'drift-scan.cjs', 'alias-drift-families.cjs'];

/**
 * Resolve a runtime's shared-hooks directory name from its descriptor.
 *
 * The value is a single path SEGMENT. This string is joined onto a user's config
 * root and then written to and recursively read, so anything that is not a plain,
 * non-empty, separator-free, non-dot segment is rejected back to the default —
 * a descriptor typo must never let the installer write outside the install root.
 *
 * The "non-dot" part of that contract is enforced beyond the literal '.' / '..'
 * segments: an all-dot (or dot-and-whitespace-only) segment is rejected as a
 * meaningless name, a segment with a trailing dot or space is rejected because
 * Windows silently strips it at directory-creation time (which would split the
 * name the installer creates from the name callers probe for), and a Windows
 * reserved device name (CON, PRN, AUX, NUL, COM1-9, LPT1-9, with or without an
 * extension) is rejected because it cannot exist as a directory on Windows at
 * all. These checks are unconditional on every platform: the descriptor is
 * authored once and shipped everywhere, so a value invalid on Windows must be
 * rejected identically on Linux/macOS, or the install and its fixtures disagree
 * cross-platform.
 *
 * @param {string} runtime
 * @returns {string}
 */
function resolveSharedHooksDirName(runtime) {
  const raw = _hostBehaviors(runtime).sharedHooksDirName;
  if (typeof raw !== 'string') return SHARED_HOOKS_DIR_DEFAULT;
  const name = raw.trim();
  if (name === '') return SHARED_HOOKS_DIR_DEFAULT;
  if (name === '.' || name === '..') return SHARED_HOOKS_DIR_DEFAULT;
  // All-dot or dot+whitespace segments ('...', '. .') are not meaningful
  // directory names and are almost certainly a descriptor typo.
  if (name.replace(/[.\s]/g, '') === '') return SHARED_HOOKS_DIR_DEFAULT;
  // Windows silently strips a trailing dot or space at creation time, so the
  // directory the installer creates would not match the name the adapter
  // probes for — a split-brain that only reproduces off-Linux.
  if (/[. ]$/.test(name)) return SHARED_HOOKS_DIR_DEFAULT;
  // Windows reserved device names cannot exist as directories.
  if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(name)) return SHARED_HOOKS_DIR_DEFAULT;
  if (name.includes('/') || name.includes('\\')) return SHARED_HOOKS_DIR_DEFAULT;
  // Belt-and-braces: reject anything path.basename() would reduce, and any
  // Windows drive/UNC-flavoured value.
  if (path.basename(name) !== name) return SHARED_HOOKS_DIR_DEFAULT;
  if (path.isAbsolute(name)) return SHARED_HOOKS_DIR_DEFAULT;
  if (name.includes('\0')) return SHARED_HOOKS_DIR_DEFAULT;
  return name;
}

const CODEX_AGENT_SANDBOX = {
  'gsd-executor': 'workspace-write',
  'gsd-planner': 'workspace-write',
  'gsd-phase-researcher': 'workspace-write',
  'gsd-project-researcher': 'workspace-write',
  'gsd-research-synthesizer': 'workspace-write',
  'gsd-verifier': 'workspace-write',
  'gsd-codebase-mapper': 'workspace-write',
  'gsd-roadmapper': 'workspace-write',
  'gsd-debugger': 'workspace-write',
  'gsd-plan-checker': 'read-only',
  'gsd-integration-checker': 'read-only',
};

// Copilot tool name mapping — Claude Code tools to GitHub Copilot tools
// Tool mapping applies ONLY to agents, NOT to skills (per CONTEXT.md decision)
const claudeToCopilotTools = {
  Read: 'read',
  Write: 'edit',
  Edit: 'edit',
  Bash: 'execute',
  Grep: 'search',
  Glob: 'search',
  Task: 'agent',
  WebSearch: 'web',
  WebFetch: 'web',
  TodoWrite: 'todo',
  AskUserQuestion: 'ask_user',
  SlashCommand: 'skill',
};

// Get version from package.json
const pkg = require('../package.json');

// #2517 — runtime-aware tier resolution shared with core.cjs.
// Hoisted to top with absolute __dirname-based paths so `gsd install codex` works
// when invoked via npm global install (cwd is the user's project, not the gsd repo
// root). Inline `require('../gsd-core/...')` from inside install functions
// works only because Node resolves it relative to the install.js file regardless
// of cwd, but keeping the require at the top makes the dependency explicit and
// surfaces resolution failures at process start instead of at first install call.
const _gsdLibDir = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib');
const {
  RUNTIME_PROFILE_MAP: GSD_RUNTIME_PROFILE_MAP,
  isAnthropicFlavoredModel: gsdIsAnthropicFlavoredModel,
} = require(path.join(_gsdLibDir, 'model-catalog.cjs'));
// #2875 Part 2: MODEL_PROFILES + resolveTierEntry are now consumed only by
// install-model-override-resolver.cjs's readGsdRuntimeProfileResolver
// (required below) — this installer no longer needs its own bindings.

// #2071 — install-time effort resolution (readGsdEffectiveEffortConfig /
// resolveInstallTimeEffort, plus their _getGsdEffortCatalog + _readGsdConfigFile
// helpers) was extracted into the shipped gsd-core/bin/lib/install-effort-resolver.cjs
// so `gsd-tools effort sync` can require it from the installed runtime instead of this
// package-root bin/install.js, which the installer never copies (#2071 crash). The
// installer imports it back here — single source of truth for both surfaces.
const {
  readGsdEffectiveEffortConfig,
  resolveInstallTimeEffort,
  _getGsdEffortCatalog,
  _readGsdConfigFile,
} = require(path.join(_gsdLibDir, 'install-effort-resolver.cjs'));

const {
  MINIMAL_SKILL_ALLOWLIST,
  PROFILES,
  isMinimalMode,
  stageSkillsForMode,
  readActiveProfile,
  writeActiveProfile,
  resolveEffectiveProfile,
  mostRestrictiveProfile,
  resolveProfile,
  loadSkillsManifest,
  stageSkillsForProfile,
  stageAgentsForProfile,
  stageSkillsForRuntimeAsSkills,
} = require(path.join(_gsdLibDir, 'install-profiles.cjs'));
// ADR-857 phase 4c: load capability registry (optional; missing → falls back to undefined)
let _capabilityRegistry;
try {
  _capabilityRegistry = require(path.join(_gsdLibDir, 'capability-registry.cjs'));
} catch (_) {
  _capabilityRegistry = undefined;
}

// #2322 BLOCKER 2: `_capabilityRegistry` above is the FROZEN first-party registry
// (capability-registry.cjs, built at publish time) — it never reflects an
// INSTALLED third-party overlay capability, so a fresh `gsd install` could never
// stage an installed third-party capability's skill regardless of registration,
// even on the DEFAULT `--profile full`. `_installedCapabilityRegistry` composes
// the overlay via capability-loader's `loadRegistry({includeInstalled:true})` —
// the SAME call capability-writer.cts's `capability set --runtime` path already
// uses — so a fresh install and a post-install `capability set` agree on
// third-party skill availability. Used ONLY for skill-profile resolution and
// runtime-artifact-layout staging below; `_capabilityRegistry` (frozen) remains
// the source for gsd-core's OWN runtime/host-behavior descriptors (unaffected —
// those are always first-party). A load failure degrades to the frozen
// `_capabilityRegistry` (no overlay data -> no third-party skills staged; never
// a crash and never a scan-and-guess fallback).
let _installedCapabilityRegistry;
try {
  const _capabilityLoader = require(path.join(_gsdLibDir, 'capability-loader.cjs'));
  _installedCapabilityRegistry = _capabilityLoader.loadRegistry({
    includeInstalled: true,
    cwd: process.cwd(),
    gsdHome: process.env['GSD_HOME'],
  });
} catch (_) {
  _installedCapabilityRegistry = _capabilityRegistry;
}

// Fail-safe floor for the reference host's #338-privacy-critical behaviors, used
// ONLY when the first-party capability registry cannot be loaded (a broken bundle).
// Without it, a registry-load failure would make `_hostBehaviors('claude')` return
// {} and silently route a claude LOCAL install to the repo-shared, committed
// `settings.json` instead of the gitignored `settings.local.json` (#338) — leaking
// engineer-specific absolute paths. Keyed by runtime id (a DATA lookup, not a
// hardcoded string-equality branch) so behavior degrades CLOSED (safe), never open.
// The live descriptor (capabilities/claude/capability.json) remains the source of
// truth; this mirrors only the privacy-load-bearing subset. (ADR-1239 / #2086)
//
// #2870: NOT routed through the Install Scope Module (resolveScope,
// src/install-scope.cts) despite that module owning per-scope settings-file
// resolution elsewhere in this file. resolveScope's own descriptor lookup
// goes through the SAME capability registry require this floor exists to
// survive the failure of (see getRegistry() in install-scope.cts) — so on
// exactly the "registry failed to load" path this constant is for,
// resolveScope would throw too. Routing through it here would trade a
// graceful, documented degrade for a crash in the one case this floor was
// added to prevent. This hardcoded literal is the correct, honest answer,
// not an un-migrated leftover.
const FALLBACK_HOST_BEHAVIORS = Object.freeze({
  claude: Object.freeze({
    settingsFileByScope: Object.freeze({ local: 'settings.local.json', global: 'settings.json' }),
    permissionsSchema: 'claude',
    sourceMarkerFile: '.gsd-source',
    hyphenNameAgentBody: true,
    legacyCommandsGsdInstallMigration: true,
    legacyCommandsGsdUninstall: 'global',
  }),
  // antigravity's global config dir is resolved dynamically (env-overridable,
  // multi-segment) via resolveAntigravityGlobalDir in getConfigDirFromHome. If the
  // registry fails to load, this floor keeps that routing intact instead of
  // silently falling through to the generic getGlobalConfigHomeFragment default
  // (which would return the wrong '.claude' fragment). (ADR-1239 / #2096)
  antigravity: Object.freeze({ globalDirResolver: 'antigravity' }),
});

/**
 * Resolve a runtime's host behaviors from a capability registry, with the
 * #338-privacy fail-safe floor when the registry (or the runtime's descriptor)
 * is unavailable. Registry is passed in so this is unit-testable under a
 * simulated registry-load failure. (ADR-1239 / #2086)
 */
function _resolveHostBehaviors(runtime, registry) {
  const cap = registry && registry.runtimes && registry.runtimes[runtime];
  const declared = cap && cap.runtime && cap.runtime.hostBehaviors;
  if (declared) return declared;
  return FALLBACK_HOST_BEHAVIORS[runtime] || {};
}

/**
 * Host-specific install behaviors, declared on the runtime descriptor
 * (capabilities/<runtime>/capability.json -> runtime.hostBehaviors) instead of
 * scattered `runtime === '<id>'` string checks (ADR-1239 / #2086). Returns {}
 * for runtimes that declare none, so every behavior branch degrades to the
 * generic path by default — EXCEPT the reference host's #338-critical keys, which
 * fall back to FALLBACK_HOST_BEHAVIORS if the registry failed to load.
 */
function _hostBehaviors(runtime) {
  return _resolveHostBehaviors(runtime, _capabilityRegistry);
}

/**
 * Read a runtime's documentation-sourced `hostIntegration.dispatch` axes
 * (ADR-1239 Phase A — `capabilities/<runtime>/capability.json`
 * `runtime.hostIntegration.dispatch`): `{namedDispatch, nested, maxDepth,
 * background, backgroundDispatch, subagentToolkit}`. These are validated,
 * closed-vocabulary FACTS about what the runtime's real dispatch primitive
 * supports (never inferred) — see `docs/reference/host-integration-capability-
 * matrix.md` for citations. Unlike `_hostBehaviors` (install *policy*), this is
 * the negotiated *capability* surface; #2284 is its first content-projection
 * consumer (previously read only by `shouldFlattenDispatch`). Returns `{}` if
 * the registry or the runtime's descriptor is unavailable, so callers must
 * treat every axis as absent/unknown (fail-closed) rather than assume a value.
 */
function _hostIntegrationDispatch(runtime) {
  const cap = _capabilityRegistry && _capabilityRegistry.runtimes && _capabilityRegistry.runtimes[runtime];
  const dispatch = cap && cap.runtime && cap.runtime.hostIntegration && cap.runtime.hostIntegration.dispatch;
  return dispatch || {};
}

/**
 * #2870: shared install()/uninstall() scope resolution. Routes `id` through
 * the Install Scope Module (src/install-scope.cts) and degrades to `null` on
 * failure (unknown/non-installable runtime, broken registry bundle) instead
 * of throwing, so each call site's own plain-id fallback keeps working
 * exactly as it did before this migration. Both call sites previously carried
 * their own copy of this try/catch; this is the one shared copy.
 */
function _resolveScopeSafe(id, runtime) {
  try {
    return resolveScope({ id, runtime });
  } catch (_) {
    return null;
  }
}

/**
 * Resolve a layout kind's on-disk destination directory. Shared by the
 * skills-root resolution above and the #3664 warning below so the
 * home-override + destSubpath join exists once (#3659-class re-encoding guard).
 */
function _kindDestDir(layout, kindName, targetDir) {
  const kind = layout.kinds.find((k) => k.kind === kindName);
  if (!kind) return null;
  return path.join(kind.home || targetDir, kind.destSubpath);
}

/**
 * #3738: scope-aware, layout-resolving wrapper over _kindDestDir for callers
 * that have (runtime, configDir, scope) rather than a resolved Layout — the
 * writeManifest agents surface being the first. Never throws: a runtime whose
 * layout cannot be resolved (unknown id, descriptor error) keeps the caller's
 * own fallback rather than losing the manifest.
 */
function _kindDestDirSafe(runtime, configDir, scope, kindName) {
  try {
    return _kindDestDir(resolveRuntimeArtifactLayout(runtime, configDir, scope), kindName, configDir);
  } catch {
    return null;
  }
}

/**
 * #3664 — warn (never refuse) when `--config-dir` points the install at a
 * directory whose agent destination already holds FOREIGN (non-GSD) agent
 * files — the fingerprint of another harness's config home (e.g. ~/.junie,
 * ~/.factory) or a hand-curated agents dir. GSD emits the selected runtime's
 * artifacts verbatim: tool IDs (`Skill`) and MCP grants (`mcp__server__tool`)
 * that are inert or invalid in a foreign harness surface only at dispatch
 * time, months later. Warn-and-proceed is the issue-sanctioned option (b):
 * a fresh custom dir (the documented brand-specific-dir use), a gsd-only dir
 * (updates, the --all shared dir — including kimi's root `gsd.md`, which is
 * GSD-owned despite the bare `gsd` stem), and the no-flag default-home path
 * (users keep personal agents in ~/.claude/agents) all stay silent. Degrades
 * silently on any resolution failure — the warn path never blocks install.
 */
function warnIfForeignAgentDest(runtime, targetDir, scope, explicitConfigDir) {
  if (explicitConfigDir !== true) return;
  try {
    const layout = resolveRuntimeArtifactLayout(runtime, targetDir, scope);
    // kimi's global agents kind is `kimi-agents` (#2095 EoS), every other
    // runtime's is `agents`.
    const agentsDir = _kindDestDir(layout, 'agents', targetDir)
      || _kindDestDir(layout, 'kimi-agents', targetDir);
    if (!agentsDir) return;
    if (!fs.existsSync(agentsDir) || !fs.statSync(agentsDir).isDirectory()) return;
    const foreign = fs
      .readdirSync(agentsDir)
      .filter((f) => f.endsWith('.md') && !f.startsWith('gsd-') && f !== 'gsd.md');
    if (foreign.length === 0) return;
    console.log(
      `  ${yellow}⚠${reset} ${bold}${targetDir}${reset} already contains ${foreign.length} non-GSD agent file(s) — this may be another harness's config home. GSD emits artifacts shaped for ${runtime}: tool IDs and MCP grants may be inert or invalid for whatever harness reads this directory (#3664).`
    );
  } catch (_) {
    /* never block install on the warning path */
  }
}

/**
 * Resolve the ACTUAL on-disk skills-install directory for a runtime, honoring a
 * skills-kind `home` override (ADR-1239 upgrade 3 / #2088: e.g. Codex skills ->
 * $HOME/.agents/skills instead of the runtime's configDir). Descriptor-driven
 * (no runtime === '<id>' check) so the snapshot/rollback machinery and post-install
 * verification look where the skills actually landed. Falls back to <targetDir>/skills.
 */
function _resolveSkillsRootDir(runtime, targetDir, scope) {
  try {
    const layout = resolveRuntimeArtifactLayout(runtime, targetDir, scope);
    const skillsDir = _kindDestDir(layout, 'skills', targetDir);
    if (skillsDir) return skillsDir;
  } catch (_e) { /* fall through to the configDir default */ }
  return path.join(targetDir, 'skills');
}

/**
 * Construct the imperative Host-Integration adapter (ADR-1239 / #2086), FAIL-OPEN.
 * `createImperativeAdapter` composes the capability registry via
 * `loadRegistry({includeInstalled:true})`, which require()s several capability
 * modules. If any is unavailable (e.g. a packaging regression), return null so
 * the caller degrades to the engine directly rather than hard-crashing install/
 * uninstall — matching the optional `capability-registry.cjs` load posture above.
 */
function _runtimeAdapter(runtime) {
  try {
    return createImperativeAdapter({ runtime });
  } catch {
    return null;
  }
}
const {
  applyInstallerMigrationPlan,
  discoverInstallerMigrations,
  MANIFEST_SCHEMA_VERSION,
  runInstallerMigrations,
} = require(path.join(_gsdLibDir, 'installer-migrations.cjs'));
const {
  assertInstallerMigrationsUnblocked,
  resolveInstallerMigrationPromptsForNonTty,
  summarizeInstallerMigrationResult,
} = require(path.join(_gsdLibDir, 'installer-migration-report.cjs'));
const {
  resolveRuntimeArtifactLayout,
} = require(path.join(_gsdLibDir, 'runtime-artifact-layout.cjs'));
const {
  assertDestWithinConfigHome,
  createRuntimeArtifactInstallPlan,
  createRuntimeArtifactUninstallPlan,
} = require(path.join(_gsdLibDir, 'runtime-artifact-install-plan.cjs'));
const {
  planLegacyCleanup,
  applyLegacyCleanup,
} = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'legacy-cleanup.cjs'));
const {
  updateCacheFileName,
  PACKAGE_NAME,
} = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'package-identity.cjs'));

// ADR-1239 Phase B: runtime-artifact install cluster extracted to install-engine.cjs.
// getCommitAttribution STAYS here (impure install-time config I/O); it is injected
// into the engine functions via the resolveAttribution parameter at each call site.
const installEngine = require(path.join(_gsdLibDir, 'install-engine.cjs'));
// #2876: _copyStaged, convertClaudeCommandToOpencodeSkill, and
// convertClaudeCommandToKiloSkill used to be destructured here too — all
// three had no install.js internal caller and no export consumer (tests
// import all three directly from gsd-core/bin/lib/install-engine.cjs), so
// the retired bindings were dead code. applyOpencodeFamilyPathPrefix,
// _runLegacyInstallMigrations, _runLegacyUninstallCleanup,
// _removeGsdEntries, _restoreDir, and _removeHermesBareStemDirs were the
// same — unused local bindings that were never part of this module's export
// surface either — found and retired in the same sweep.
const {
  installRuntimeArtifacts,
  uninstallRuntimeArtifacts,
  installOpencodeFamilySkills,
  installAgentsKindStandalone,
  _installNativePluginIfDeclared,
  hasExistingSymlinkBetween,
  isSymlinkedDestOptIn,
  migrateLegacyDevPreferencesToSkill,
  USER_OWNED_ARTIFACTS,
  _snapshotDir,
} = installEngine;

// #2875 (epic #2866 Phase 6): durable on-disk staging for USER_OWNED_ARTIFACTS
// across the preserve -> wipe -> restore window (#1874-F19). See
// src/user-artifact-staging.cts's module doc.
const {
  stageUserArtifacts,
  restoreStagedUserArtifacts,
  discardStagedUserArtifacts,
  recoverOrphanedUserArtifacts,
} = require(path.join(_gsdLibDir, 'user-artifact-staging.cjs'));

/**
 * Resolve the durable staging root for `configDir`, confined via
 * `assertDestWithinConfigHome` and refused via `hasExistingSymlinkBetween`
 * (test-matrix E1/E4) — mirrors install-engine.cts's
 * `_resolveUserArtifactStagingRoot`, kept local here because bin/install.js's
 * two call sites (uninstall's legacy-migration block, install's mainline
 * gsd-core copy) are not inside that module.
 */
function _resolveUserArtifactStagingRoot(configDir) {
  const stagingRoot = assertDestWithinConfigHome(configDir, path.posix.join('.gsd-staging', 'user-artifacts'));
  if (hasExistingSymlinkBetween(path.resolve(configDir), stagingRoot, { allowOptInFollow: isSymlinkedDestOptIn() })) {
    throw new Error(
      `_resolveUserArtifactStagingRoot: staging root "${stagingRoot}" contains a symlink the install root "${configDir}" does not trust — refusing to stage. If this is an intentional user-owned symlink layout, re-run with GSD_ALLOW_SYMLINKED_DEST=1.`,
    );
  }
  return stagingRoot;
}

/**
 * Degrade-not-abort wrapper over `_resolveUserArtifactStagingRoot` — mirrors
 * install-engine.cts's own `_tryResolveUserArtifactStagingRoot` (kept local
 * here for the same reason the throwing version above is: bin/install.js's
 * own call sites are not inside that module). A hostile/broken
 * `.gsd-staging` path (or a symlinked configDir itself) must never brick
 * `install()` or `uninstall()` — before this fix, `_resolveUserArtifactStagingRoot`
 * was called UNGUARDED as the first statement of both, so
 * `ln -s /nonexistent ~/.claude/.gsd-staging` killed both commands, including
 * uninstall, the remedy for the first problem. Returns `null` (never throws),
 * logging one warning; every call site MUST treat `null` as "skip the
 * staging-dependent step for this run".
 */
function _tryResolveUserArtifactStagingRoot(configDir) {
  try {
    return _resolveUserArtifactStagingRoot(configDir);
  } catch (err) {
    console.warn(`  ${yellow}!${reset} user-artifact staging unavailable for "${configDir}" (${err.message}) — proceeding without durable staging for this step.`);
    return null;
  }
}

// Parse args
const args = process.argv.slice(2);
const hasGlobal = args.includes('--global') || args.includes('-g');
const hasLocal = args.includes('--local') || args.includes('-l');
const hasUninstall = args.includes('--uninstall') || args.includes('-u');
const hasSkillsRoot = args.includes('--skills-root');
const hasPortableHooks = args.includes('--portable-hooks') || process.env.GSD_PORTABLE_HOOKS === '1';
const hasMinimal = args.includes('--minimal') || args.includes('--core-only');
const hasDryRun = args.includes('--dry-run');
// #3031: opt-in reclaim of the GSD artifacts a PRE-#2755 `--kimi-code` install
// orphaned in Kimi CLI's `~/.kimi`. Opt-in and not automatic because the stale
// block is BYTE-IDENTICAL to a legitimate Kimi CLI one — both runtimes render
// the same bytes for the same root, since the command paths derive from the
// hooks root and not from the runtime — so no inspection can tell "litter GSD
// wrote for kimi-code" from "Kimi CLI's working hooks". Cleaning unasked would
// break #2755's own acceptance criterion ("Uninstalling GSD hooks for one
// runtime does not touch or remove the other runtime's hooks") for anyone with
// both products installed. The user, who knows which products they run, is the
// only party that can decide — so they ask for it explicitly.
const hasReclaimKimiLegacy = args.includes('--reclaim-kimi-legacy');
// --profile=<name> or --profile=<n1>,<n2> (composable); mutually exclusive with --minimal
const _profileArgRaw = (() => {
  for (const arg of args) {
    if (arg.startsWith('--profile=')) return arg.slice('--profile='.length);
  }
  return null;
})();
// Resolve active profile name:
// 1. --minimal / --core-only → 'core' (back-compat alias)
// 2. --profile=<name> → named profile
// 3. neither → 'full' (default, back-compat)
// Note: when re-running as `gsd update` the marker is read later (after
// configDir is resolved) and may override 'full' — see writeActiveProfile call below.
const _profileIsCore = _profileArgRaw === 'core';
const _requestedProfileName = (hasMinimal || _profileIsCore) ? 'core' : (_profileArgRaw || null);

if (hasMinimal && _profileArgRaw) {
  console.error(`  ${yellow}Cannot specify both --minimal/--core-only and --profile${reset}`);
  process.exit(1);
}

function selectRuntimesFromArgs(runtimeArgs) {
  if (runtimeArgs.includes('--all')) {
    return ['claude', 'kimi', 'kimi-code', 'kilo', 'opencode', 'pi', 'codex', 'copilot', 'antigravity', 'cursor', 'windsurf', 'augment', 'trae', 'qwen', 'hermes', 'codebuddy', 'cline', 'zcode'];
  }
  if (runtimeArgs.includes('--both')) {
    return ['claude', 'opencode'];
  }

  const selected = [];
  if (runtimeArgs.includes('--claude')) selected.push('claude');
  if (runtimeArgs.includes('--opencode')) selected.push('opencode');
  if (runtimeArgs.includes('--pi')) selected.push('pi');
  if (runtimeArgs.includes('--kilo')) selected.push('kilo');
  if (runtimeArgs.includes('--codex')) selected.push('codex');
  if (runtimeArgs.includes('--copilot')) selected.push('copilot');
  if (runtimeArgs.includes('--antigravity')) selected.push('antigravity');
  if (runtimeArgs.includes('--cursor')) selected.push('cursor');
  if (runtimeArgs.includes('--windsurf') || runtimeArgs.includes('--devin-desktop')) selected.push('windsurf');
  if (runtimeArgs.includes('--augment')) selected.push('augment');
  if (runtimeArgs.includes('--trae')) selected.push('trae');
  if (runtimeArgs.includes('--qwen')) selected.push('qwen');
  if (runtimeArgs.includes('--hermes')) selected.push('hermes');
  if (runtimeArgs.includes('--kimi')) selected.push('kimi');
  if (runtimeArgs.includes('--kimi-code')) selected.push('kimi-code');
  if (runtimeArgs.includes('--codebuddy')) selected.push('codebuddy');
  if (runtimeArgs.includes('--cline')) selected.push('cline');
  if (runtimeArgs.includes('--zcode')) selected.push('zcode');
  return selected;
}

// Runtime selection - can be set by flags or interactive prompt
let selectedRuntimes = selectRuntimesFromArgs(args);

// #2505 Phase 5: Kimi variant disambiguation (#2513). Kimi CLI (Python, ~/.kimi/)
// and Kimi Code (Node, ~/.kimi-code/) are two distinct Moonshot products that
// share the "kimi" brand. Probe for each product's config.toml and warn when
// the selected runtime doesn't match the detected install — catches the common
// "ran --kimi --global but actually on Kimi Code" mistake that produced inert
// YAMLs and empty agent-skills before the Phase 1 descriptor split.
function disambiguateKimiVariant(runtimes) {
  const home = os.homedir();
  const hasKimiCli = fs.existsSync(path.join(home, '.kimi', 'config.toml'));
  const hasKimiCode = fs.existsSync(path.join(home, '.kimi-code', 'config.toml'));
  const notices = [];
  if (runtimes.includes('kimi') && hasKimiCode && !hasKimiCli) {
    notices.push({
      kind: 'wrong-variant',
      selected: 'kimi',
      detected: 'kimi-code',
      message: `Detected ~/.kimi-code/config.toml (Kimi Code, Node CLI) but not ~/.kimi/config.toml (Kimi CLI, Python). You selected --kimi but appear to be on Kimi Code. Re-run with --kimi-code for a working install. (Kimi CLI = Python kimi-cli with named subagents; Kimi Code = Node CLI with coder/explore/plan built-ins only.)`,
    });
  }
  if (runtimes.includes('kimi-code') && hasKimiCli && !hasKimiCode) {
    notices.push({
      kind: 'wrong-variant',
      selected: 'kimi-code',
      detected: 'kimi',
      message: `Detected ~/.kimi/config.toml (Kimi CLI, Python) but not ~/.kimi-code/config.toml (Kimi Code, Node CLI). You selected --kimi-code but appear to be on Kimi CLI. Re-run with --kimi for a working install.`,
    });
  }
  // Distinct-entry descriptions when either Kimi variant is selected.
  if (runtimes.includes('kimi')) {
    notices.push({
      kind: 'description',
      runtime: 'kimi',
      message: 'Kimi CLI (Python kimi-cli): named subagents via YAML, config at ~/.kimi/, hooks via ~/.kimi/config.toml [[hooks]].',
    });
  }
  if (runtimes.includes('kimi-code')) {
    notices.push({
      kind: 'description',
      runtime: 'kimi-code',
      message: 'Kimi Code (Node CLI): three built-in subagents (coder/explore/plan), Agent Skills at ~/.kimi-code/skills/, config at ~/.kimi-code/.',
    });
  }
  return notices;
}

// #3031: `--reclaim-kimi-legacy` only ever acts inside the kimi-code GLOBAL
// install branch. Say so when it cannot act, rather than exiting 0 having
// silently done nothing: the user asked for a cleanup, and silence is
// indistinguishable from "it ran and found nothing". Not a hard error — it
// stays composable with `--all`, where it is legitimately inert for the other
// seventeen runtimes.
if (hasReclaimKimiLegacy && !selectedRuntimes.includes('kimi-code')) {
  console.error(`${yellow}⚠ --reclaim-kimi-legacy ignored${reset} — it applies only to a --kimi-code install; nothing in ~/.kimi was touched.`);
} else if (hasReclaimKimiLegacy && hasLocal) {
  // Scope, checked HERE rather than inside install(): kimi-code declares
  // hostBehaviors.localInstallDeferred, so install() returns early long before
  // the kimi-hooks-toml branch — a warning placed there would be unreachable.
  console.error(`${yellow}⚠ --reclaim-kimi-legacy ignored${reset} — the legacy root is a global location; re-run with --global to reclaim it.`);
}

if (selectedRuntimes.includes('kimi') || selectedRuntimes.includes('kimi-code')) {
  const kimiNotices = disambiguateKimiVariant(selectedRuntimes);
  for (const notice of kimiNotices) {
    if (notice.kind === 'wrong-variant') {
      console.error(`${yellow}⚠ Kimi variant mismatch (${notice.selected} → ${notice.detected}).${reset} ${notice.message}`);
    } else if (notice.kind === 'description') {
      console.log(`${dim}  ${notice.runtime}: ${notice.message}${reset}`);
    }
  }
}

// #1928: Google sunset Gemini CLI on 2026-06-18; Antigravity CLI is its
// official successor. `--gemini` is no longer a valid runtime selector —
// selectRuntimesFromArgs above no longer recognizes it, so it never lands in
// selectedRuntimes. Print a one-time redirect notice, and — when `--gemini`
// was the ONLY runtime flag supplied (selectedRuntimes is empty) — exit
// deterministically rather than silently falling through to the "no runtime
// specified" defaults below (which would install Claude Code, surprising a
// user who explicitly asked for Gemini). Other flags (e.g. `--codex`) still
// parse and install normally alongside the notice.
if (args.includes('--gemini')) {
  const wantsHelp = args.includes('--help') || args.includes('-h');
  console.error('Gemini CLI was sunset by Google on 2026-06-18 and is no longer served for free/Pro/Ultra tiers.');
  console.error('GSD now supports Antigravity CLI (the official successor). Re-run with: --antigravity');
  if (hasUninstall) {
    // The gemini runtime was removed (#1928), so there is no automated
    // `--gemini --uninstall`. Guide manual cleanup and exit — do NOT fall
    // through to the uninstall dispatch below, which defaults an empty runtime
    // selection to 'claude' and would wrongly uninstall the user's Claude install.
    console.error('The gemini runtime was removed, so `--gemini --uninstall` is no longer available.');
    console.error('To remove a prior Gemini install, delete GSD files under your Gemini config dir');
    console.error('(e.g. ~/.gemini/commands/gsd) and GSD hook entries in ~/.gemini/settings.json.');
    process.exit(1);
  }
  // For `--gemini --help`, fall through so the usage block still prints. For a
  // bare install attempt (no other runtime selected), exit rather than silently
  // installing Claude.
  if (!wantsHelp && selectedRuntimes.length === 0) {
    process.exit(1);
  }
}

// WSL + Windows Node.js detection
// When Windows-native Node runs on WSL, os.homedir() and path.join() produce
// backslash paths that don't resolve correctly on the Linux filesystem.
if (process.platform === 'win32') {
  let isWSL = false;
  try {
    if (process.env.WSL_DISTRO_NAME) {
      isWSL = true;
    } else if (fs.existsSync('/proc/version')) {
      const procVersion = fs.readFileSync('/proc/version', 'utf8').toLowerCase();
      if (procVersion.includes('microsoft') || procVersion.includes('wsl')) {
        isWSL = true;
      }
    }
  } catch {
    // Ignore read errors — not WSL
  }

  if (isWSL) {
    console.error(`
${yellow}⚠ Detected WSL with Windows-native Node.js.${reset}

This causes path resolution issues that prevent correct installation.
Please install a Linux-native Node.js inside WSL:

  curl -fsSL https://fnm.vercel.app/install | bash
  fnm install --lts

Then re-run: npx ${pkg.name}@latest
`);
    process.exit(1);
  }
}

// getDirName (runtime -> local config dir name) now lives in
// runtime-name-policy.cjs (ADR-1508 / #1510 Phase 1); imported above for
// install.js's own internal use only — #2876 retired the re-export.

/**
 * Get the config directory path relative to home directory for a runtime
 * Used for templating hooks that use path.join(homeDir, '<configDir>', ...)
 * @param {string} runtime - 'claude', 'opencode', 'codex', or 'copilot'
 * @param {boolean} isGlobal - Whether this is a global install
 */
function getConfigDirFromHome(runtime, isGlobal) {
  if (!isGlobal) {
    // Local installs use the same dir name pattern
    return `'${getDirName(runtime)}'`;
  }
  // Global installs. antigravity's home is resolved dynamically (env-overridable,
  // multi-segment via resolveAntigravityGlobalDir + path.relative) — not a table
  // entry. (The prior inner `if (!isGlobal) return "'.agents'"` was unreachable:
  // !isGlobal returns at the top of this function.)
  // Descriptor-driven (ADR-1239 / #2096): folded from a hardcoded
  // `runtime === 'antigravity'` literal into a read of the runtime's
  // `hostBehaviors.globalDirResolver` descriptor field (via _hostBehaviors, which
  // also degrades to FALLBACK_HOST_BEHAVIORS on registry-load failure). This is
  // antigravity-unique: unlike `configHome.kind === 'dot-home-nested'` (which
  // windsurf also declares — see capabilities/windsurf/capability.json — and
  // would wrongly route windsurf's global dir through
  // resolveAntigravityGlobalDir), `globalDirResolver` is only set by antigravity.
  if (_hostBehaviors(runtime).globalDirResolver === 'antigravity') {
    const antigravityDir = resolveAntigravityGlobalDir();
    const rel = path.relative(os.homedir(), antigravityDir);
    const segments = rel.split(path.sep).filter(Boolean);
    if (segments.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return segments.map((seg) => `'${seg}'`).join(', ');
    }
    // If resolution points outside HOME (e.g. via env override), keep the
    // stable legacy template so generated path.join() calls remain valid.
    return "'.gemini', 'antigravity'";
  }
  // All other runtimes: single source-of-truth fragment table (ADR-1239 Phase B,
  // #1679). claude/unknown fall through to the table's default '.claude'.
  return getGlobalConfigHomeFragment(runtime);
}

/**
 * Compatibility seam for tests and older installer consumers.
 * Runtime home resolution now lives in runtime-homes.cjs.
 */
function getGlobalDir(runtime, explicitDir = null) {
  return getGlobalConfigDir(runtime, explicitDir);
}
const banner = '\n' +
  cyan + '   ██████╗ ███████╗██████╗\n' +
  '  ██╔════╝ ██╔════╝██╔══██╗\n' +
  '  ██║  ███╗███████╗██║  ██║\n' +
  '  ██║   ██║╚════██║██║  ██║\n' +
  '  ╚██████╔╝███████║██████╔╝\n' +
  '   ╚═════╝ ╚══════╝╚═════╝' + reset + '\n' +
  '\n' +
  '  GSD Core ' + dim + 'v' + pkg.version + reset + '\n' +
  '  Git. Ship. Done.\n' +
  '  A meta-prompting, context engineering and spec-driven\n' +
  '  development workflows for Claude Code, OpenCode, Kimi CLI, Kilo, Codex, Copilot, Antigravity, Cursor, Windsurf, Augment, Trae, Qwen Code, Hermes Agent, Cline, CodeBuddy, ZCode and pi.\n';

// Pure seam: parse --config-dir / -c from an arbitrary args array.
// Returns the path string, '' for an empty equals-form value, or null when the
// flag is absent.  Space-separated form returns null (not an error string) when
// the next token is missing or flag-looking — callers that want process.exit
// behaviour must check after calling this function.
// Exported via module.exports so unit tests can exercise it directly.
function parseConfigDirFromArgs(argsArray) {
  const configDirIndex = argsArray.findIndex(arg => arg === '--config-dir' || arg === '-c');
  if (configDirIndex !== -1) {
    const nextArg = argsArray[configDirIndex + 1];
    // No value / next token is a flag → signal "missing" by returning null
    if (!nextArg || nextArg.startsWith('-')) {
      return null;
    }
    return nextArg;
  }
  // Handle --config-dir=value and -c=value format.
  // Use indexOf('=') + 1 so that = signs inside the path value are preserved.
  const configDirArg = argsArray.find(arg => arg.startsWith('--config-dir=') || arg.startsWith('-c='));
  if (configDirArg) {
    return configDirArg.slice(configDirArg.indexOf('=') + 1);
  }
  return null;
}

// Parse --config-dir argument
function parseConfigDirArg() {
  const result = parseConfigDirFromArgs(args);
  if (result === null) {
    // Check if the space-separated form was present but missing a value
    const configDirIndex = args.findIndex(arg => arg === '--config-dir' || arg === '-c');
    if (configDirIndex !== -1) {
      console.error(`  ${yellow}--config-dir requires a path argument${reset}`);
      process.exit(1);
    }
    return null;
  }
  if (result === '') {
    console.error(`  ${yellow}--config-dir requires a non-empty path${reset}`);
    process.exit(1);
  }
  return result;
}
const explicitConfigDir = parseConfigDirArg();
const hasHelp = args.includes('--help') || args.includes('-h');
const forceStatusline = args.includes('--force-statusline');

if (!hasSkillsRoot) console.log(banner);

if (hasUninstall) {
  console.log('  Mode: Uninstall\n');
}

// Show help if requested
if (hasHelp) {
  console.log(`  ${yellow}Usage:${reset} npx ${pkg.name} [options]\n\n  ${yellow}Options:${reset}\n    ${cyan}-g, --global${reset}              Install globally (to config directory)\n    ${cyan}-l, --local${reset}               Install locally (to current directory)\n    ${cyan}--claude${reset}                  Install for Claude Code only\n    ${cyan}--opencode${reset}                Install for OpenCode only\n    ${cyan}--kilo${reset}                    Install for Kilo only\n    ${cyan}--codex${reset}                   Install for Codex only\n    ${cyan}--kimi${reset}                    Install for Kimi CLI only\n    ${cyan}--kimi-code${reset}               Install for Kimi Code only\n    ${cyan}--copilot${reset}                 Install for Copilot only\n    ${cyan}--antigravity${reset}             Install for Antigravity only\n    ${cyan}--cursor${reset}                  Install for Cursor only\n    ${cyan}--windsurf${reset}                Install for Windsurf only\n    ${cyan}--augment${reset}                 Install for Augment only\n    ${cyan}--trae${reset}                    Install for Trae only\n    ${cyan}--qwen${reset}                    Install for Qwen Code only\n    ${cyan}--hermes${reset}                  Install for Hermes Agent only\n    ${cyan}--cline${reset}                   Install for Cline only\n    ${cyan}--codebuddy${reset}              Install for CodeBuddy only\n    ${cyan}--zcode${reset}                  Install for ZCode only\n    ${cyan}--pi${reset}                      Install for Pi only\n    ${cyan}--gemini${reset}                  Install for Gemini CLI only\n    ${cyan}--all${reset}                     Install for all runtimes\n    ${cyan}-u, --uninstall${reset}           Uninstall GSD (remove all GSD files)\n    ${cyan}-c, --config-dir <path>${reset}   Specify custom config directory\n    ${cyan}-h, --help${reset}                Show this help message\n    ${cyan}--force-statusline${reset}        Replace existing statusline config\n    ${cyan}--portable-hooks${reset}          Emit \$HOME-relative hook paths in settings.json\n                              and resolve the node runner at hook-fire time via\n                              hooks/gsd-node-runner.sh (WSL/Docker bind-mount\n                              setups; also GSD_PORTABLE_HOOKS=1)\n    ${cyan}--reclaim-kimi-legacy${reset}     With --kimi-code: also remove the GSD hooks a\n                              pre-1.10.0 --kimi-code install orphaned in ~/.kimi.\n                              Opt-in — those artifacts are indistinguishable from\n                              Kimi CLI's own, so skip it if you use Kimi CLI too.\n    ${cyan}--profile=<name>${reset}         Install a named skill profile. Profiles:\n                              core     — ${PROFILES.core.length} main-loop skills incl. phase (~130 desc tokens)\n                              standard — ${PROFILES.standard.length} skills incl. phase, review, config (~700)\n                              full     — all skills (default)\n                              Composable: --profile=core,audit installs union of closures.\n                              Profile is persisted and respected by \`gsd update\`.\n    ${cyan}--minimal${reset}                 Alias for --profile=core (back-compat).\n                              Cuts cold-start overhead from ~12k tokens to ~700.\n                              Alias: --core-only.\n\n  ${yellow}Examples:${reset}\n    ${dim}# Interactive install (prompts for runtime and location)${reset}\n    npx ${pkg.name}\n\n    ${dim}# Install for Claude Code globally${reset}\n    npx ${pkg.name} --claude --global\n\n    ${dim}# Install for Kilo globally${reset}\n    npx ${pkg.name} --kilo --global\n\n    ${dim}# Install for Codex globally${reset}\n    npx ${pkg.name} --codex --global\n\n    ${dim}# Install for Kimi CLI globally${reset}\n    npx ${pkg.name} --kimi --global\n\n    ${dim}# Install for Kimi Code globally (its own ~/.kimi-code root)${reset}\n    npx ${pkg.name} --kimi-code --global\n\n    ${dim}# Kimi Code, also reclaiming hooks a pre-1.10.0 install left in ~/.kimi${reset}\n    npx ${pkg.name} --kimi-code --global --reclaim-kimi-legacy\n\n    ${dim}# Install for Copilot globally${reset}\n    npx ${pkg.name} --copilot --global\n\n    ${dim}# Install for Copilot locally${reset}\n    npx ${pkg.name} --copilot --local\n\n    ${dim}# Install for Antigravity globally${reset}\n    npx ${pkg.name} --antigravity --global\n\n    ${dim}# Install for Antigravity locally${reset}\n    npx ${pkg.name} --antigravity --local\n\n    ${dim}# Install for Cursor globally${reset}\n    npx ${pkg.name} --cursor --global\n\n    ${dim}# Install for Cursor locally${reset}\n    npx ${pkg.name} --cursor --local\n\n    ${dim}# Install for Windsurf globally${reset}\n    npx ${pkg.name} --windsurf --global\n\n    ${dim}# Install for Windsurf locally${reset}\n    npx ${pkg.name} --windsurf --local\n\n    ${dim}# Install for Augment globally${reset}\n    npx ${pkg.name} --augment --global\n\n    ${dim}# Install for Augment locally${reset}\n    npx ${pkg.name} --augment --local\n\n    ${dim}# Install for Trae globally${reset}\n    npx ${pkg.name} --trae --global\n\n    ${dim}# Install for Trae locally${reset}\n    npx ${pkg.name} --trae --local\n\n    ${dim}# Install for Hermes Agent globally${reset}\n    npx ${pkg.name} --hermes --global\n\n    ${dim}# Install for Hermes Agent locally${reset}\n    npx ${pkg.name} --hermes --local\n\n    ${dim}# Install for Cline globally${reset}\n    npx ${pkg.name} --cline --global\n\n    ${dim}# Install for Cline locally${reset}\n    npx ${pkg.name} --cline --local\n\n    ${dim}# Install for CodeBuddy globally${reset}\n    npx ${pkg.name} --codebuddy --global\n\n    ${dim}# Install for CodeBuddy locally${reset}\n    npx ${pkg.name} --codebuddy --local\n\n    ${dim}# Install for all runtimes globally${reset}\n    npx ${pkg.name} --all --global\n\n    ${dim}# Install to custom config directory${reset}\n    npx ${pkg.name} --kilo --global --config-dir ~/.kilo-work\n\n    ${dim}# Install to current project only${reset}\n    npx ${pkg.name} --claude --local\n\n    ${dim}# Uninstall GSD from Cursor globally${reset}\n    npx ${pkg.name} --cursor --global --uninstall\n\n  ${yellow}Notes:${reset}\n    The --config-dir option is useful when you have multiple configurations.\n    It takes priority over CLAUDE_CONFIG_DIR / OPENCODE_CONFIG_DIR / KILO_CONFIG_DIR / CODEX_HOME / KIMI_CONFIG_DIR / COPILOT_CONFIG_DIR / COPILOT_HOME / ANTIGRAVITY_CONFIG_DIR / CURSOR_CONFIG_DIR / WINDSURF_CONFIG_DIR / AUGMENT_CONFIG_DIR / TRAE_CONFIG_DIR / QWEN_CONFIG_DIR / HERMES_HOME / CLINE_CONFIG_DIR / CODEBUDDY_CONFIG_DIR environment variables.\n    Kimi CLI defaults to the first existing generic skills root: ${cyan}~/.config/agents/skills${reset}, then ${cyan}~/.agents/skills${reset}; if neither exists, GSD creates ${cyan}~/.config/agents${reset}.\n    Kimi CLI and Kimi Code are separate products with separate hook roots: use ${cyan}--kimi${reset} (${cyan}~/.kimi${reset}, ${cyan}KIMI_SHARE_DIR${reset}) or ${cyan}--kimi-code${reset} (${cyan}~/.kimi-code${reset}, ${cyan}KIMI_CODE_HOME${reset}).\n`);
  process.exit(0);
}

// computePathPrefix: implementation moved to runtimeArtifactConversion._computePathPrefix
// (ADR-1508 / #1511 Phase 2 — single owner). The const binding above re-binds
// it here for install.js's own internal call sites only — #2876 retired the
// module.exports entry (zero consumers found; tests import
// runtimeArtifactConversion._computePathPrefix directly).
// Original doc: Compute the path prefix used for `@file` references in installed
// command/skill markdown. For global installs under $HOME uses $HOME/... form;
// OpenCode always uses the absolute path (#2376 Windows, #2831 macOS/Linux).

// resolveNodeRunner, resolveBashRunner, referencesHook are now owned by the
// runtime-hooks-surface module. Import them here so install.js callers
// continue to work and so there is a single implementation of these helpers.
// (normalizeNodePath was re-bound here too until #2876 found bin/install.js
// had no internal caller and no export consumer for it — hooksSurface owns
// the single implementation now, used internally by resolveNodeRunner there.)
const resolveNodeRunner = hooksSurface.resolveNodeRunner;
// #3662: the runtime-resolving runner token for managed JS hooks — the baked
// absolute node path tried FIRST, then `command -v node`, then well-known
// layouts, resolved by the shell at hook-fire time instead of bake time.
const buildNodeRunnerChainToken = hooksSurface.buildNodeRunnerChainToken;
const resolveBashRunner = hooksSurface.resolveBashRunner;
// referencesHook: pure predicate over hook entry objects, shared between
// install() and finishInstall() (ADR-857 phase 5f-1b).
const referencesHook = hooksSurface.referencesHook;
// applySettingsJsonHooks: mutates settings.hooks.* in place with all GSD-managed
// hook registrations for settings.json-surface runtimes (ADR-857 phase 5f-1b).
const applySettingsJsonHooks = hooksSurface.applySettingsJsonHooks;
// writeKimiHooksToml / removeKimiHooksToml: kimi's native config.toml [[hooks]]
// surface (#2095 EoS/kimi Upgrade 1) — separate from settings.json entirely.
const writeKimiHooksToml = hooksSurface.writeKimiHooksToml;
const removeKimiHooksToml = hooksSurface.removeKimiHooksToml;
// processAttribution: pure Co-Authored-By content transform, relocated to the
// conversion module (ADR-1508 / #1510 Phase 1). Bound here so install.js
// callers continue to work and there is a single implementation. (All call
// sites are below this line, so the const binding has no TDZ hazard.)
const processAttribution = runtimeArtifactConversion.processAttribution;
// computePathPrefix: implementation lives in runtimeArtifactConversion
// (ADR-1508 / #1511 Phase 2 — single owner). Re-bound here so install.js call
// sites continue to work. #2876 retired the sibling
// applyRuntimeContentRewritesInPlace / applyRuntimeContentRewritesForCommandsInPlace
// re-bindings that used to sit alongside it, and the entire #1675 Augment
// converter family re-binding (convertClaudeToAugmentMarkdown /
// convertClaudeCommandToAugmentSkill / convertClaudeAgentToAugmentAgent) that
// used to follow — bin/install.js had no internal caller for any of them (the
// descriptor pipeline in runtimeArtifactConversion calls them directly).
// (All call sites are below this line → no TDZ hazard.)
const computePathPrefix = runtimeArtifactConversion._computePathPrefix;
// #2931 (ADR-1508): the windsurf converter family is single-sourced in the
// conversion module. install.js re-binds (does not re-define) the one member
// it still calls internally so there is exactly one body — the
// generative-drift hazard the dedup removes. #2876 retired the sibling
// convertClaudeCommandToWindsurfSkill / convertClaudeCommandToWindsurfWorkflow /
// convertClaudeAgentToWindsurfAgent re-bindings — bin/install.js had no
// internal caller for any of them (the descriptor pipeline in
// runtimeArtifactConversion calls them directly).
// (All call sites are below this line → no TDZ hazard.)
const convertClaudeToWindsurfMarkdown = runtimeArtifactConversion.convertClaudeToWindsurfMarkdown;
// #2931 (ADR-1508): single-sourced in the conversion module — was a second,
// unlinked verbatim copy here (used by the local Cursor/Trae/CodeBuddy/Cline
// converters below), the exact drift class this PR exists to reduce. Verified
// behaviorally identical (no block / one block / adjacent blocks / whole-
// content block / unclosed opening tag / nested-looking tags / repeated
// sequential calls for global-regex lastIndex leakage) before merging.
// install.js re-binds (does not re-define) — RUNTIME_COMPATIBILITY_BLOCK_RE
// is no longer duplicated here either. (All call sites are below this line
// → no TDZ hazard.)
const applyClaudeCodeBrandSwap = runtimeArtifactConversion.applyClaudeCodeBrandSwap;

function rewriteLegacyManagedNodeHookCommands(settings, absoluteRunner, opts) {
  return hooksSurface.rewriteLegacyManagedNodeHookCommands(settings, absoluteRunner, opts);
}

// #2876: reconcileManagedShellHookCommands, buildCodexHookBlock,
// rewriteLegacyCodexHookBlock, reconcileCodexHooksJsonEvent, and
// reconcileCodexHooksJsonSessionStart used to be re-bound here as one-line
// delegates to the equivalent hooksSurface.* implementations. None had an
// install.js internal caller or an export consumer (tests import all five
// directly from gsd-core/bin/lib/runtime-hooks-surface.cjs), so the retired
// bindings were dead code with no reachable body — removed rather than kept
// as unreachable wrappers.

/**
 * Ensure Codex hooks.json contains exactly one managed SessionStart
 * gsd-check-update hook entry, while preserving user-owned entries.
 *
 * Codex accepts hook config from hooks.json and config.toml. To avoid the
 * startup warning for mixed representations in the same layer, GSD now stores
 * the managed SessionStart hook in hooks.json and keeps config.toml for
 * feature flags / agent metadata only.
 *
 * Supports both known hooks.json shapes:
 *   1) { "SessionStart": [...] }
 *   2) { "hooks": { "SessionStart": [...] } }
 *
 * On Windows, writes a .cmd shim alongside the .js hook file and uses the
 * .cmd shim path as the hook command to avoid the `bash.exe: cannot execute
 * binary file` failure (#3426).
 *
 * #772: also emits `commandWindows` in the hook entry so that a
 * cross-platform hooks.json works on both POSIX and Windows without
 * requiring per-OS regeneration. Codex dispatches `commandWindows` on
 * Windows and `command` on other platforms (HookHandlerConfig in
 * codex-rs/config/src/hook_config.rs).
 *
 * @param {string} targetDir
 * @param {{ absoluteRunner: string|null, platform?: NodeJS.Platform }} opts
 * @returns {{ changed: boolean, wrote: boolean, path: string }}
 */
function ensureCodexHooksJsonSessionStart(targetDir, opts = {}) {
  return hooksSurface.ensureCodexHooksJsonSessionStart(targetDir, opts);
}

/**
 * Ensure hooks.json contains exactly one managed GSD hook entry for the given
 * Codex event, wired to gsd-context-monitor.js. Preserves user-owned entries.
 *
 * Used for the new Codex events added in #772:
 *   SubagentStart — inject context / GSD_AGENT_NAME awareness at subagent open
 *   Stop          — post-session context headroom tracking
 *   PostToolUse   — mirror the Claude Code PostToolUse context monitor
 *
 * All three events are routed through gsd-context-monitor.js — the same hook
 * used for PostToolUse in the Claude Code baseline — so context-headroom
 * warnings surface at these key Codex session lifecycle moments.
 *
 * On Windows (#3426): writes a gsd-context-monitor.cmd shim alongside the .js
 * file and uses the .cmd path as the hook command — exactly the same fix as
 * SessionStart uses for gsd-check-update — to avoid the bash.exe POSIX-exec
 * failure when Codex's hook dispatcher tries to run node.exe through Git Bash.
 *
 * @param {string} targetDir
 * @param {string} eventName - One of 'SubagentStart', 'Stop', 'PostToolUse'.
 * @param {{ absoluteRunner: string|null, platform?: NodeJS.Platform }} opts
 * @returns {{ changed: boolean, wrote: boolean, path: string }}
 */
function ensureCodexHooksJsonEvent(targetDir, eventName, opts = {}) {
  return hooksSurface.ensureCodexHooksJsonEvent(targetDir, eventName, opts);
}

/**
 * Remove a GSD-managed event entry from hooks.json. Called during uninstall.
 *
 * @param {string} targetDir
 * @param {string} eventName
 */
function removeCodexHooksJsonEvent(targetDir, eventName) {
  return hooksSurface.removeCodexHooksJsonEvent(targetDir, eventName);
}

function removeCodexHooksJsonSessionStart(targetDir) {
  return hooksSurface.removeCodexHooksJsonSessionStart(targetDir);
}

/**
 * Build a hook command path using forward slashes for cross-platform compatibility.
 * On Windows, $HOME is not expanded by cmd.exe/PowerShell, so we use the actual path.
 *
 * @param {string} configDir - Resolved absolute config directory path
 * @param {string} hookName - Hook filename (e.g. 'gsd-statusline.js')
 * @param {{ portableHooks?: boolean, platform?: NodeJS.Platform, runtime?: string }} [opts] - Options
 *   portableHooks: when true, emit $HOME-relative paths instead of absolute paths.
 *   Safe for Linux/macOS global installs and WSL/Docker bind-mount scenarios.
 *   Not suitable for pure Windows (cmd.exe/PowerShell do not expand $HOME).
 *   platform: test injection for shell command formatting. Defaults to process.platform.
 *   runtime: target runtime name for shell projection policy.
 */
function buildHookCommand(configDir, hookName, opts) {
  return hooksSurface.buildHookCommand(configDir, hookName, opts);
}

/**
 * Resolve the opencode config file path, preferring .jsonc if it exists.
 */
function resolveOpencodeConfigPath(configDir) {
  const jsoncPath = path.join(configDir, 'opencode.jsonc');
  if (fs.existsSync(jsoncPath)) {
    return jsoncPath;
  }
  return path.join(configDir, 'opencode.json');
}

/**
 * Resolve the Kilo config file path, preferring .jsonc if it exists.
 */
function resolveKiloConfigPath(configDir) {
  const jsoncPath = path.join(configDir, 'kilo.jsonc');
  if (fs.existsSync(jsoncPath)) {
    return jsoncPath;
  }
  return path.join(configDir, 'kilo.json');
}

// #2087 — attribution config-path resolvers, keyed by descriptor (hostBehaviors.attributionConfigResolver)
const ATTRIBUTION_CONFIG_RESOLVERS = { opencode: resolveOpencodeConfigPath, kilo: resolveKiloConfigPath };

/**
 * Strip JSONC comments (// and /* *​/) from a string to produce valid JSON.
 * Handles comments inside strings correctly (does not strip them).
 */
function stripJsonComments(text) {
  let result = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
  while (i < text.length) {
    // Handle string literals — don't strip comments inside strings
    if (inString) {
      if (text[i] === '\\') {
        result += text[i] + (text[i + 1] || '');
        i += 2;
        continue;
      }
      if (text[i] === stringChar) {
        inString = false;
      }
      result += text[i];
      i++;
      continue;
    }
    // Start of string
    if (text[i] === '"' || text[i] === "'") {
      inString = true;
      stringChar = text[i];
      result += text[i];
      i++;
      continue;
    }
    // Line comment
    if (text[i] === '/' && text[i + 1] === '/') {
      // Skip to end of line
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    // Block comment
    if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2; // skip closing */
      continue;
    }
    result += text[i];
    i++;
  }
  // Remove trailing commas before } or ] (common in JSONC)
  return result.replace(/,\s*([}\]])/g, '$1');
}

/**
 * Read and parse settings.json, returning empty object if it doesn't exist.
 * Supports JSONC (JSON with comments) — many CLI tools allow comments in
 * their settings files, so we strip them before parsing to avoid silent
 * data loss from JSON.parse failures.
 */
function readSettings(settingsPath) {
  if (fs.existsSync(settingsPath)) {
    try {
      const raw = fs.readFileSync(settingsPath, 'utf8');
      let parsed;
      // Try standard JSON first (fast path)
      try { parsed = JSON.parse(raw); }
      catch { parsed = JSON.parse(stripJsonComments(raw)); }
      return parsed === null ? {} : parsed;   // valid JSON null = empty settings, not malformed
    } catch (e) {
      // If even JSONC stripping fails, warn instead of silently returning {}
      console.warn('  ' + yellow + '⚠' + reset + '  Warning: Could not parse ' + settingsPath + ' — file may be malformed. Existing settings preserved.');
      return null;
    }
  }
  return {};
}

/**
 * Write settings.json with proper formatting
 */
function writeSettings(settingsPath, settings) {
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

// #2875 Part 2 (J8): model-override resolution (readGsdGlobalModelOverrides /
// readGsdEffectiveModelOverrides / readGsdRuntimeProfileResolver, plus the
// shared resolveAgentModelOverride precedence chain) was extracted into the
// shipped gsd-core/bin/lib/install-model-override-resolver.cjs, mirroring
// install-effort-resolver.cjs's existing #2071 precedent, so the descriptor-
// driven agents pipeline (runtime-artifact-layout.cts's convertedAgentsKind)
// and this installer resolve model_overrides / model_profile_overrides
// through the SAME code — a single source of truth for the precedence chain
// the inline agent loop below used to duplicate across ~24 lines per runtime
// (kilo, opencode). See install-model-override-resolver.cts's module doc.
const {
  readGsdEffectiveModelOverrides,
  readGsdRuntimeProfileResolver,
  resolveAgentModelOverride,
} = require(path.join(_gsdLibDir, 'install-model-override-resolver.cjs'));

// #2875 Part 2: effort frontmatter injection moved to runtimeArtifactConversion
// (single source of truth with the descriptor pipeline's
// applyAgentFrontmatterExtensions step, which now also owns disallowedTools
// injection + the read-only agent deny-list internally — see its module doc
// in src/runtime-artifact-conversion.cts). injectEffortFrontmatter used to be
// re-bound here purely to stay on this module's export surface; #2876 found
// no install.js internal caller either (tests import it directly from
// gsd-core/bin/lib/runtime-artifact-conversion.cjs) and retired the binding.

// Cache for attribution settings (populated once per runtime during install)
const attributionCache = new Map();

/**
 * Get commit attribution setting for a runtime
 * @param {string} runtime - 'claude', 'opencode', 'codex', or 'copilot'
 * @returns {null|undefined|string} null = remove, undefined = keep default, string = custom
 */
function getCommitAttribution(runtime) {
  // Return cached value if available
  if (attributionCache.has(runtime)) {
    return attributionCache.get(runtime);
  }

  let result;

  const _attrResolverKey = _hostBehaviors(runtime).attributionConfigResolver;
  if (_attrResolverKey && ATTRIBUTION_CONFIG_RESOLVERS[_attrResolverKey]) {
    const resolveConfigPath = ATTRIBUTION_CONFIG_RESOLVERS[_attrResolverKey];
    const config = readSettings(resolveConfigPath(getGlobalConfigDir(runtime, null)));
    result = (config && config.disable_ai_attribution === true) ? null : undefined;
  } else if (_hostBehaviors(runtime).attributionSource === 'settings-json-commit') {
    // Claude Code
    const settings = readSettings(path.join(getGlobalConfigDir(runtime, explicitConfigDir), 'settings.json'));
    if (!settings || !settings.attribution || settings.attribution.commit === undefined) {
      result = undefined;
    } else if (settings.attribution.commit === '') {
      result = null;
    } else {
      result = settings.attribution.commit;
    }
  } else {
    // Codex and Copilot currently have no attribution setting equivalent
    result = undefined;
  }

  // Cache and return
  attributionCache.set(runtime, result);
  return result;
}

// processAttribution (pure Co-Authored-By content transform) relocated to
// runtime-artifact-conversion.cjs (ADR-1508 / #1510 Phase 1); bound above.
// getCommitAttribution stays here — it is impure install-time config I/O.

/**
 * Convert Claude Code frontmatter to opencode format
 * - Converts 'allowed-tools:' array to 'permission:' object
 * @param {string} content - Markdown file content with YAML frontmatter
 * @returns {string} - Content with converted frontmatter
 */
// Color name to hex mapping for opencode compatibility
const colorNameToHex = {
  cyan: '#00FFFF',
  red: '#FF0000',
  green: '#00FF00',
  blue: '#0000FF',
  yellow: '#FFFF00',
  magenta: '#FF00FF',
  orange: '#FFA500',
  purple: '#800080',
  pink: '#FFC0CB',
  white: '#FFFFFF',
  black: '#000000',
  gray: '#808080',
  grey: '#808080',
};

// Tool name mapping from Claude Code to OpenCode
// OpenCode uses lowercase tool names; special mappings for renamed tools
const claudeToOpencodeTools = {
  AskUserQuestion: 'question',
  SlashCommand: 'skill',
  TodoWrite: 'todowrite',
  WebFetch: 'webfetch',
  WebSearch: 'websearch',  // Plugin/MCP - keep for compatibility
};

// Tool name mapping from Claude Code to Gemini CLI
// Gemini CLI uses snake_case built-in tool names
const claudeToGeminiTools = {
  Read: 'read_file',
  Write: 'write_file',
  Edit: 'replace',
  Bash: 'run_shell_command',
  Glob: 'glob',
  Grep: 'search_file_content',
  WebSearch: 'google_web_search',
  WebFetch: 'web_fetch',
  TodoWrite: 'write_todos',
};

// Tool name mapping from Claude/GSD agents to Kimi CLI module paths.
// Kimi custom agent YAML requires fully-qualified module paths.
const claudeToKimiTools = {
  Read: 'kimi_cli.tools.file:ReadFile',
  ReadFile: 'kimi_cli.tools.file:ReadFile',
  Write: 'kimi_cli.tools.file:WriteFile',
  WriteFile: 'kimi_cli.tools.file:WriteFile',
  Edit: 'kimi_cli.tools.file:StrReplaceFile',
  MultiEdit: 'kimi_cli.tools.file:StrReplaceFile',
  StrReplaceFile: 'kimi_cli.tools.file:StrReplaceFile',
  Bash: 'kimi_cli.tools.shell:Shell',
  Shell: 'kimi_cli.tools.shell:Shell',
  Grep: 'kimi_cli.tools.file:Grep',
  Glob: 'kimi_cli.tools.file:Glob',
  Agent: 'kimi_cli.tools.agent:Agent',
  Task: 'kimi_cli.tools.agent:Agent',
  AskUserQuestion: 'kimi_cli.tools.ask_user:AskUserQuestion',
  TodoWrite: 'kimi_cli.tools.todo:SetTodoList',
  SetTodoList: 'kimi_cli.tools.todo:SetTodoList',
  WebSearch: 'kimi_cli.tools.web:SearchWeb',
  SearchWeb: 'kimi_cli.tools.web:SearchWeb',
  WebFetch: 'kimi_cli.tools.web:FetchURL',
  FetchURL: 'kimi_cli.tools.web:FetchURL',
  ReadMediaFile: 'kimi_cli.tools.file:ReadMediaFile',
  TaskList: 'kimi_cli.tools.background:TaskList',
  TaskOutput: 'kimi_cli.tools.background:TaskOutput',
  TaskStop: 'kimi_cli.tools.background:TaskStop',
};

/**
 * Convert a Claude Code tool name to OpenCode format
 * - Applies special mappings (AskUserQuestion -> question, etc.)
 * - Converts to lowercase (except MCP tools which keep their format)
 */
function convertToolName(claudeTool) {
  // Check for special mapping first
  if (claudeToOpencodeTools[claudeTool]) {
    return claudeToOpencodeTools[claudeTool];
  }
  // MCP tools (mcp__*) keep their format
  if (claudeTool.startsWith('mcp__')) {
    return claudeTool;
  }
  // Default: convert to lowercase
  return claudeTool.toLowerCase();
}

/**
 * Convert a Claude Code tool name to Gemini CLI format
 * - Applies Claude→Gemini mapping (Read→read_file, Bash→run_shell_command, etc.)
 * - Filters out MCP tools (mcp__*) — they are auto-discovered at runtime in Gemini
 * - Filters out Task/Agent — agents are auto-registered as tools in Gemini
 * @returns {string|null} Gemini tool name, or null if tool should be excluded
 */
function convertGeminiToolName(claudeTool) {
  // MCP tools: exclude — auto-discovered from mcpServers config at runtime
  if (claudeTool.startsWith('mcp__')) {
    return null;
  }
  // Task/Agent: exclude — agents are auto-registered as callable tools.
  // AskUserQuestion: exclude — Gemini CLI does not expose an ask_user tool;
  // emitting it causes frontmatter validation errors (#3362).
  // Skill/SlashCommand: exclude — Gemini CLI has no 'skill' built-in tool;
  // the lowercase fallback would emit an invalid 'skill'/'slashcommand' name
  // that fails frontmatter validation (tools.N: Invalid tool name) and aborts
  // the entire agent load (#1394).
  if (
    claudeTool === 'Task' ||
    claudeTool === 'Agent' ||
    claudeTool === 'AskUserQuestion' ||
    claudeTool === 'ask_user' ||
    claudeTool === 'Skill' ||
    claudeTool === 'SlashCommand'
  ) {
    return null;
  }
  // Check for explicit mapping
  if (claudeToGeminiTools[claudeTool]) {
    return claudeToGeminiTools[claudeTool];
  }
  // Default: lowercase
  return claudeTool.toLowerCase();
}

function createKimiToolDiagnostic(reason, tool, source = null) {
  const isMcp = reason === 'mcp_managed';
  return {
    level: 'warning',
    code: isMcp ? 'kimi_mcp_tool_excluded' : 'kimi_unsupported_tool',
    reason,
    message: isMcp
      ? `MCP-managed tool '${tool}' is configured outside Kimi agent YAML.`
      : `Tool '${tool}' is not supported by the Kimi tool mapper.`,
    value: tool,
    source,
  };
}

/**
 * Convert a Claude/GSD tool name to a Kimi CLI module path.
 * @returns {string|null} Kimi module path, or null when excluded/unsupported.
 */
function convertKimiToolName(claudeTool) {
  const tool = String(claudeTool || '').trim();
  if (!tool) return null;
  if (tool.startsWith('mcp__')) return null;
  return claudeToKimiTools[tool] || null;
}

function mapClaudeToolsToKimiTools(claudeTools, options = {}) {
  const diagnostics = [];
  const tools = [];
  const seen = new Set();
  const source = options && Object.prototype.hasOwnProperty.call(options, 'source')
    ? options.source
    : null;

  for (const rawTool of Array.isArray(claudeTools) ? claudeTools : []) {
    const tool = String(rawTool || '').trim();
    if (!tool) continue;

    if (tool.startsWith('mcp__')) {
      diagnostics.push(createKimiToolDiagnostic('mcp_managed', tool, source));
      continue;
    }

    const kimiTool = convertKimiToolName(tool);
    if (!kimiTool) {
      diagnostics.push(createKimiToolDiagnostic('unsupported_tool', tool, source));
      continue;
    }

    if (!seen.has(kimiTool)) {
      seen.add(kimiTool);
      tools.push(kimiTool);
    }
  }

  return { tools, diagnostics };
}

const claudeToKiloAgentPermissions = {
  Read: 'read',
  Write: 'edit',
  Edit: 'edit',
  Bash: 'bash',
  Grep: 'grep',
  Glob: 'glob',
  Task: 'task',
  WebFetch: 'webfetch',
  WebSearch: 'websearch',
  TodoWrite: 'todowrite',
  AskUserQuestion: 'question',
  SlashCommand: 'skill',
};

const kiloAgentPermissionOrder = [
  'read',
  'edit',
  'bash',
  'grep',
  'glob',
  'task',
  'webfetch',
  'websearch',
  'skill',
  'question',
  'todowrite',
  'list',
  'codesearch',
  'lsp',
];

function convertClaudeToKiloPermissionTool(claudeTool) {
  return claudeToKiloAgentPermissions[claudeTool] || null;
}

function buildKiloAgentPermissionBlock(claudeTools) {
  const allowedPermissions = new Set();

  for (const tool of claudeTools) {
    const mapped = convertClaudeToKiloPermissionTool(tool);
    if (mapped) {
      allowedPermissions.add(mapped);
    }
  }

  const lines = ['permission:'];
  for (const permission of kiloAgentPermissionOrder) {
    lines.push(`  ${permission}: ${allowedPermissions.has(permission) ? 'allow' : 'deny'}`);
  }

  return lines;
}

function replaceRelativePathReference(content, fromPath, toPath) {
  const escapedPath = escapeRegExp(fromPath);
  return content.replace(
    new RegExp(`(^|[^A-Za-z0-9_./-])${escapedPath}`, 'g'),
    (_, prefix) => `${prefix}${toPath}`,
  );
}

/**
 * Convert a Claude Code tool name to GitHub Copilot format.
 * - Applies explicit mapping from claudeToCopilotTools
 * - Handles mcp__context7__* prefix → io.github.upstash/context7/*
 * - Falls back to lowercase for unknown tools
 */
function convertCopilotToolName(claudeTool) {
  // mcp__context7__* wildcard → io.github.upstash/context7/*
  if (claudeTool.startsWith('mcp__context7__')) {
    return 'io.github.upstash/context7/' + claudeTool.slice('mcp__context7__'.length);
  }
  // Check explicit mapping
  if (claudeToCopilotTools[claudeTool]) {
    return claudeToCopilotTools[claudeTool];
  }
  // mcp__{tavily,ref,jina,exa,firecrawl}__* use the generic MCP passthrough like exa/firecrawl;
  // add explicit Copilot registry mappings when the io.github ids are confirmed (#657 follow-up)
  // Default: lowercase
  return claudeTool.toLowerCase();
}

/**
 * Apply Copilot-specific content conversion — CONV-06 (paths) + CONV-07 (command names).
 * Path mappings depend on install mode:
 *   Global: ~/.claude/ → ~/.copilot/, ./.claude/ → ./.github/
 *   Local:  ~/.claude/ → ./.github/, ./.claude/ → ./.github/
 * Applied to ALL Copilot content (skills, agents, engine files).
 * @param {string} content - Source content to convert
 * @param {boolean} [isGlobal=false] - Whether this is a global install
 */
function convertClaudeToCopilotContent(content, isGlobal = false) {
  let c = content;
  // CONV-06: Path replacement — most specific first to avoid substring matches.
  // Handle both `~/.claude/foo` (trailing slash) and bare `~/.claude` forms in
  // one pass via a capture group, matching the approach used by Antigravity,
  // OpenCode, Kilo, and Codex converters (issue #2545).
  if (isGlobal) {
    c = c.replace(/\$HOME\/\.claude(\/|\b)/g, '$HOME/.copilot$1');
    c = c.replace(/~\/\.claude(\/|\b)/g, '~/.copilot$1');
  } else {
    c = c.replace(/\$HOME\/\.claude\//g, '.github/');
    c = c.replace(/~\/\.claude\//g, '.github/');
    c = c.replace(/\$HOME\/\.claude\b/g, '.github');
    c = c.replace(/~\/\.claude\b/g, '.github');
  }
  c = c.replace(/\.\/\.claude\//g, './.github/');
  c = c.replace(/\.claude\//g, '.github/');
  // CONV-07: Command name conversion (all gsd: references → gsd-)
  c = c.replace(/gsd:/g, 'gsd-');
  // Runtime-neutral agent name replacement (#766)
  c = neutralizeAgentReferences(c, 'copilot-instructions.md');
  return c;
}

// isGlobal is the 5th positional arg (3rd/4th are runtime/cmdNames passed by the skills wrapper). See runtime-artifact-layout skillsKind.
/**
 * Convert a Claude command (.md) to a Copilot skill (SKILL.md).
 * Transforms frontmatter only — body passes through with CONV-06/07 applied.
 * Skills keep original tool names (no mapping) per CONTEXT.md decision.
 */
function convertClaudeCommandToCopilotSkill(content, skillName, _runtime = null, _cmdNames = null, isGlobal = false) {
  const converted = convertClaudeToCopilotContent(content, isGlobal);
  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  if (!frontmatter) return converted;

  const description = extractFrontmatterField(frontmatter, 'description') || '';
  const argumentHint = extractFrontmatterField(frontmatter, 'argument-hint');
  const agent = extractFrontmatterField(frontmatter, 'agent');

  // CONV-02: Extract allowed-tools YAML multiline list → comma-separated string
  const toolsMatch = frontmatter.match(/^allowed-tools:\s*\n((?:\s+-\s+.+\n?)*)/m);
  let toolsLine = '';
  if (toolsMatch) {
    const tools = toolsMatch[1].match(/^\s+-\s+(.+)/gm);
    if (tools) {
      toolsLine = tools.map(t => t.replace(/^\s+-\s+/, '').trim()).join(', ');
    }
  }

  // Reconstruct frontmatter in Copilot format
  // #2876: descriptions starting with a YAML flow indicator (`[BETA] …`,
  // `{ … }`, `*ref`, `&anchor`, etc.) parse as flow sequences/mappings and
  // crash gh-copilot's frontmatter loader. Always quote so any leading
  // character is parser-safe.
  let fm = `---\nname: ${skillName}\ndescription: ${yamlQuote(description)}\n`;
  if (argumentHint) fm += `argument-hint: ${yamlQuote(argumentHint)}\n`;
  if (agent) fm += `agent: ${agent}\n`;
  if (toolsLine) fm += `allowed-tools: ${toolsLine}\n`;
  fm += '---';

  return `${fm}\n${body}`;
}

/**
 * Map a skill directory name (gsd-<cmd>) to the frontmatter `name:` used
 * by Claude Code as the skill identity. Emits the hyphen form (gsd-<cmd>)
 * so Claude Code autocomplete shows the canonical invocation form, not the
 * deprecated colon form. See #2808.
 *
 * Historical note: this previously returned `gsd:<cmd>` (colon) because
 * workflows called Skill(skill="gsd:<cmd>"). Those calls have been updated
 * to use hyphen form (#2808) so the colon rewrite is no longer needed.
 *
 * Codex must NOT use this helper: its adapter invokes skills as `$gsd-<cmd>`
 * (shell-var syntax) — hyphen form is already correct there.
 */
function skillFrontmatterName(skillDirName) {
  if (typeof skillDirName !== 'string') return skillDirName;
  // Return the hyphen form as-is (gsd-<cmd>) — canonical since #2808.
  return skillDirName;
}

/**
 * Qwen Code skills accept an optional numeric `priority` frontmatter field.
 * Per the Qwen skills spec (qwen-code/docs/users/features/skills.md, verified
 * #778): HIGHER values sort EARLIER in the `/skills` TUI listing (omitted ≈ 0;
 * negatives sort below unset). It affects ONLY the `/skills` list order —
 * slash-command completion and the `/help` view stay alphabetical.
 *
 * We assign descending priorities to GSD's main-loop commands so the most-used
 * workflow skills surface first; utility skills are deliberately left unset
 * (default 0) and sort below.
 *
 * NOTE: the #778 issue body proposed the INVERSE numbering (plan-phase: 10,
 * utilities: 90+). The verified spec shows that would BURY the core loop below
 * utilities, so we implement the spec-correct direction (core = high) instead.
 * Keyed by command stem (skill dir is `gsd-<stem>`).
 */
const QWEN_SKILL_PRIORITY = Object.freeze({
  'new-project': 100,
  'discuss-phase': 95,
  'plan-phase': 90,
  'execute-phase': 85,
  progress: 80,
  'verify-work': 75,
  phase: 70,
  review: 65,
  ship: 60,
  config: 55,
  surface: 50,
  'resume-work': 45,
  'pause-work': 40,
  help: 35,
  update: 30,
});

/**
 * Convert a Claude command (.md) to a Claude skill (SKILL.md).
 * Claude Code is the native format, so minimal conversion needed —
 * preserve allowed-tools as YAML multiline list, preserve argument-hint.
 * Emits `name: gsd-<cmd>` (hyphen) so Skill(skill="gsd-<cmd>") calls and
 * tab autocomplete use the canonical command namespace.
 */
function convertClaudeCommandToClaudeSkill(content, skillName, runtime = null, cmdNames = null) {
  const { frontmatter, body } = extractFrontmatterAndBody(content);
  if (!frontmatter) return content;

  // #3583: rewrite any /gsd:<cmd> or gsd:<cmd> in the body to the canonical
  // hyphen form (gsd-<cmd>) so installed SKILL.md bodies match the hyphen
  // `name:` Claude Code (and Qwen/Hermes) register under (#2808). `cmdNames`
  // is optional and pre-computed by the caller for performance; direct test
  // calls fall back to reading the list.
  const names = cmdNames || readGsdCommandNames();
  const normalizedBody = transformContentToHyphen(body, names);

  const description = extractFrontmatterField(frontmatter, 'description') || '';
  const argumentHint = extractFrontmatterField(frontmatter, 'argument-hint');
  const agent = extractFrontmatterField(frontmatter, 'agent');
  // #769: preserve context: from source command files so it is emitted into
  // the installed SKILL.md frontmatter unchanged. (#3151: effort: is no longer
  // emitted into skill frontmatter — a static effort value invalidates the
  // caller's prompt cache at both scope boundaries.)
  const context = extractFrontmatterField(frontmatter, 'context');

  // Preserve allowed-tools as YAML multiline list (Claude native format)
  const toolsMatch = frontmatter.match(/^allowed-tools:\s*\n((?:\s+-\s+.+\n?)*)/m);
  let toolsBlock = '';
  if (toolsMatch) {
    toolsBlock = 'allowed-tools:\n' + toolsMatch[1];
    // Ensure trailing newline
    if (!toolsBlock.endsWith('\n')) toolsBlock += '\n';
  }

  // Reconstruct frontmatter in Claude skill format
  const frontmatterName = skillFrontmatterName(skillName);
  let fm = `---\nname: ${frontmatterName}\ndescription: ${yamlQuote(description)}\n`;
  // Hermes' SKILL.md spec lists `version` as a required frontmatter field.
  // Track GSD's package version so Hermes' skill_view() reports a stable
  // identifier per install.
  if (_hostBehaviors(runtime).skillFrontmatterVersion) fm += `version: ${yamlQuote(pkg.version)}\n`;
  // #778 (b) — numeric priority for /skills ordering, declared on the runtime
  // descriptor (runtime.hostBehaviors.skillPriorityFrontmatter). Scoped to
  // runtimes that declare the flag so Claude/Hermes skill frontmatter is
  // unchanged (they ignore the field, but we keep their output byte-stable).
  // skillName is the `gsd-<stem>` dir name. (ADR-1239 / #2086)
  if (_hostBehaviors(runtime).skillPriorityFrontmatter) {
    const stem = typeof skillName === 'string' && skillName.startsWith('gsd-')
      ? skillName.slice(4)
      : skillName;
    const priority = Object.prototype.hasOwnProperty.call(QWEN_SKILL_PRIORITY, stem)
      ? QWEN_SKILL_PRIORITY[stem]
      : undefined;
    if (typeof priority === 'number') fm += `priority: ${priority}\n`;
  }
  if (argumentHint) fm += `argument-hint: ${yamlQuote(argumentHint)}\n`;
  if (agent) fm += `agent: ${agent}\n`;
  // #769: emit context: when present so the runtime can honour it natively
  // (context: fork = isolated subagent window). Claude-specific; unknown
  // frontmatter fields are silently ignored by other runtimes (backward-compatible).
  // (#3151: effort: is intentionally NOT emitted into skill frontmatter — a
  // static effort value changes output_config.effort on invocation and
  // invalidates the caller's prompt cache at both scope boundaries.)
  if (context) fm += `context: ${context}\n`;
  if (toolsBlock) fm += toolsBlock;
  fm += '---';

  return `${fm}\n${normalizedBody}`;
}

function normalizeKimiSkillName(skillName) {
  let text = String(skillName || '').trim().toLowerCase();
  if (text.startsWith('/')) text = text.slice(1);
  if (text.startsWith('$')) text = text.slice(1);
  text = text.replace(/^gsd:/, 'gsd-');
  if (!text.startsWith('gsd-')) text = `gsd-${text}`;
  text = text.replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return text || 'gsd-command';
}

function convertGsdCommandReferencesToKimiSkillInvocations(content, cmdNames) {
  if (!Array.isArray(cmdNames) || cmdNames.length === 0) return content;
  const commands = [...cmdNames].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const commandGroup = commands.join('|');
  const colonPattern = new RegExp(`(?<![A-Za-z0-9_/:.-])/?gsd:(${commandGroup})(?=[^A-Za-z0-9_-]|$)`, 'g');
  const hyphenPattern = new RegExp(`(?:/|\\$)gsd-(${commandGroup})(?=[^A-Za-z0-9_-]|$)`, 'g');

  return content
    .replace(colonPattern, (_, cmd) => `/skill:gsd-${cmd}`)
    .replace(hyphenPattern, (_, cmd) => `/skill:gsd-${cmd}`);
}

// DEFECT.GENERATIVE-FIX: this body is mirrored in
// src/runtime-artifact-conversion.cts's convertClaudeCommandToKimiSkill (dead
// for the live skills-install path, which routes here via
// install-engine.cts's SKILLS_CONVERTER_REGISTRY through the kimi capability
// descriptor's artifactLayout `converter: "convertClaudeCommandToKimiSkill"`;
// kept for bin/install.js's own module-level export/test surface). Neither
// copy re-exports the other — mirror any behavior change into both. Guarded
// by the output-parity test in tests/runtime-converters.test.cjs (#2095).
function convertClaudeCommandToKimiSkill(content, skillName, _runtime = null, cmdNames = null) {
  const { frontmatter, body } = extractFrontmatterAndBody(content);
  const kimiSkillName = normalizeKimiSkillName(skillName);
  const names = cmdNames || readGsdCommandNames();
  const description = frontmatter
    ? extractFrontmatterField(frontmatter, 'description') || `Run GSD workflow ${kimiSkillName}.`
    : `Run GSD workflow ${kimiSkillName}.`;
  const normalizedBody = convertGsdCommandReferencesToKimiSkillInvocations(
    frontmatter ? body : content,
    names
  );

  return `---\nname: ${kimiSkillName}\ndescription: ${yamlQuote(toSingleLine(description))}\n---\nInvoke this Kimi skill with \`/skill:${kimiSkillName}\`.\n\n${normalizedBody}`;
}

const KIMI_CANONICAL_GSD_AGENT_RE = /^gsd-[a-z0-9-]+$/;

function parseKimiAgentSource(source) {
  if (typeof source === 'string') {
    return {
      path: null,
      content: source,
    };
  }
  if (!source || typeof source !== 'object' || typeof source.content !== 'string') {
    return null;
  }
  return {
    path: typeof source.path === 'string' ? source.path : null,
    content: source.content,
  };
}

function parseFrontmatterTools(frontmatter) {
  if (!frontmatter) return [];
  const lines = frontmatter.split(/\r?\n/);
  const tools = [];
  let collecting = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (collecting) {
      if (trimmed.startsWith('- ')) {
        tools.push(trimmed.slice(2).trim());
        continue;
      }
      collecting = false;
    }

    if (trimmed === 'tools:' || trimmed === 'allowed-tools:') {
      collecting = true;
      continue;
    }

    if (trimmed.startsWith('tools:') || trimmed.startsWith('allowed-tools:')) {
      const value = trimmed.slice(trimmed.indexOf(':') + 1).trim();
      if (value) {
        for (const tool of value.split(',')) {
          const name = tool.trim();
          if (name) tools.push(name);
        }
      } else {
        collecting = true;
      }
    }
  }

  return tools;
}

function addKimiAgentDiagnostic(diagnostics, code, message, value, source = null) {
  diagnostics.push({
    level: 'warning',
    code,
    message,
    value,
    source,
  });
}

function mapKimiAgentContractTools(toolNames, diagnostics, sourceName) {
  const result = mapClaudeToolsToKimiTools(toolNames, { source: sourceName });
  diagnostics.push(...result.diagnostics);
  return result.tools;
}

function neutralizeKimiAgentPrompt(content) {
  const { frontmatter, body } = extractFrontmatterAndBody(content);
  let prompt = frontmatter ? body : content;
  prompt = neutralizeAgentReferences(prompt, 'AGENTS.md');
  prompt = prompt.replace(/~\/\.claude\/gsd-core\b/g, 'GSD core');
  prompt = prompt.replace(/\$HOME\/\.claude\/gsd-core\b/g, 'GSD core');
  return prompt.replace(/^\s*\r?\n/, '');
}

function pushKimiToolsYaml(lines, indent, tools) {
  const prefix = ' '.repeat(indent);
  if (!Array.isArray(tools) || tools.length === 0) {
    lines.push(`${prefix}tools: []`);
    return;
  }
  lines.push(`${prefix}tools:`);
  for (const tool of tools) {
    lines.push(`${prefix}  - ${yamlQuote(tool)}`);
  }
}

function buildKimiRootAgentYaml({ description, tools, subagents }) {
  const lines = [
    'version: 1',
    'agent:',
    '  name: gsd',
    `  description: ${yamlQuote(toSingleLine(description || 'Run GSD workflows in Kimi CLI.'))}`,
    '  extend: default',
    '  system_prompt_path: ./gsd.md',
  ];
  pushKimiToolsYaml(lines, 2, tools);

  if (subagents.length > 0) {
    lines.push('  subagents:');
    for (const subagent of subagents) {
      lines.push(`    ${subagent.name}:`);
      lines.push(`      path: ./subagents/${subagent.name}.yaml`);
      lines.push(`      description: ${yamlQuote(toSingleLine(subagent.description))}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function buildKimiSubagentYaml({ name, description, tools }) {
  const lines = [
    'version: 1',
    'agent:',
    `  name: ${name}`,
    `  description: ${yamlQuote(toSingleLine(description || `Run ${name}.`))}`,
    `  system_prompt_path: ./${name}.md`,
  ];
  pushKimiToolsYaml(lines, 2, tools);
  return `${lines.join('\n')}\n`;
}

// DEFECT.GENERATIVE-FIX: this body is mirrored in
// src/runtime-artifact-conversion.cts's buildKimiAgentArtifacts (dead for the
// live install path, which routes here via runtime-artifact-layout.cts's
// kimiAgentsKind — see its `conversionExports['buildKimiAgentArtifacts']`
// dynamic lookup against the compiled runtime-artifact-conversion.cjs; kept
// for bin/install.js's own module-level export/test surface). Neither copy
// re-exports the other — mirror any behavior change into both, including the
// kimi_cli.tools.agent:Agent grant that enables background dispatch
// (#2095 Upgrade 2). Guarded by the output-parity test in
// tests/runtime-converters.test.cjs (#2095).
function buildKimiAgentArtifacts({
  rootAgent = '',
  subagents = [],
  requestedSubagents = null,
} = {}) {
  const diagnostics = [];
  const rootSource = parseKimiAgentSource(rootAgent) || { path: null, content: '' };
  const { frontmatter: rootFrontmatter } = extractFrontmatterAndBody(rootSource.content);
  const rootDescription = rootFrontmatter
    ? extractFrontmatterField(rootFrontmatter, 'description') || 'Run GSD workflows in Kimi CLI.'
    : 'Run GSD workflows in Kimi CLI.';

  const subagentSources = Array.isArray(subagents) ? subagents : [];
  if (!Array.isArray(subagents)) {
    addKimiAgentDiagnostic(
      diagnostics,
      'kimi_unsupported_subagents_input',
      'Subagents input must be an array of Markdown strings or source objects.',
      typeof subagents,
      null
    );
  }

  const subagentMap = new Map();
  for (const source of subagentSources) {
    const parsed = parseKimiAgentSource(source);
    if (!parsed) {
      addKimiAgentDiagnostic(
        diagnostics,
        'kimi_unsupported_subagent_input',
        'Subagent source must be a Markdown string or an object with content.',
        typeof source,
        null
      );
      continue;
    }

    const { frontmatter } = extractFrontmatterAndBody(parsed.content);
    const fallbackName = parsed.path ? path.basename(parsed.path, path.extname(parsed.path)) : null;
    const name = frontmatter
      ? extractFrontmatterField(frontmatter, 'name') || fallbackName
      : fallbackName;
    if (!name || !KIMI_CANONICAL_GSD_AGENT_RE.test(name)) {
      addKimiAgentDiagnostic(
        diagnostics,
        'kimi_invalid_subagent_name',
        'Subagent source does not use a canonical gsd-* Kimi agent name.',
        name || '(missing)',
        parsed.path
      );
      continue;
    }

    const description = frontmatter
      ? extractFrontmatterField(frontmatter, 'description') || `Run ${name}.`
      : `Run ${name}.`;
    const tools = mapKimiAgentContractTools(parseFrontmatterTools(frontmatter), diagnostics, name);
    subagentMap.set(name, {
      name,
      description,
      tools,
      prompt: neutralizeKimiAgentPrompt(parsed.content),
    });
  }

  const requested = Array.isArray(requestedSubagents) && requestedSubagents.length > 0
    ? requestedSubagents
    : [...subagentMap.keys()];
  const selectedSubagents = [];
  for (const requestedName of requested) {
    if (subagentMap.has(requestedName)) {
      selectedSubagents.push(subagentMap.get(requestedName));
      continue;
    }
    addKimiAgentDiagnostic(
      diagnostics,
      'kimi_unknown_subagent',
      'Requested subagent was not generated and will not be emitted in Kimi YAML.',
      requestedName,
      null
    );
  }

  const rootTools = mapKimiAgentContractTools(parseFrontmatterTools(rootFrontmatter), diagnostics, 'gsd');
  if (selectedSubagents.length > 0 && !rootTools.includes('kimi_cli.tools.agent:Agent')) {
    rootTools.push('kimi_cli.tools.agent:Agent');
  }

  return {
    root: {
      name: 'gsd',
      yamlPath: 'agents/gsd.yaml',
      promptPath: 'agents/gsd.md',
      yaml: buildKimiRootAgentYaml({
        description: rootDescription,
        tools: rootTools,
        subagents: selectedSubagents,
      }),
      prompt: neutralizeKimiAgentPrompt(rootSource.content),
    },
    subagents: selectedSubagents.map((subagent) => ({
      name: subagent.name,
      yamlPath: `agents/subagents/${subagent.name}.yaml`,
      promptPath: `agents/subagents/${subagent.name}.md`,
      yaml: buildKimiSubagentYaml(subagent),
      prompt: subagent.prompt,
    })),
    diagnostics,
  };
}

/**
 * Convert a Claude agent (.md) to a Copilot agent (.agent.md).
 * Applies tool mapping + deduplication, formats tools as JSON array.
 * CONV-04: JSON array format. CONV-05: Tool name mapping.
 */
function convertClaudeAgentToCopilotAgent(content, isGlobal = false) {
  const converted = convertClaudeToCopilotContent(content, isGlobal);
  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  if (!frontmatter) return converted;

  const name = extractFrontmatterField(frontmatter, 'name') || 'unknown';
  const description = extractFrontmatterField(frontmatter, 'description') || '';
  const color = extractFrontmatterField(frontmatter, 'color');
  const toolsRaw = extractFrontmatterField(frontmatter, 'tools') || '';

  // CONV-04 + CONV-05: Map tools, deduplicate, format as JSON array
  const claudeTools = toolsRaw.split(',').map(t => t.trim()).filter(Boolean);
  const mappedTools = claudeTools.map(t => convertCopilotToolName(t));
  const uniqueTools = [...new Set(mappedTools)];
  const toolsArray = uniqueTools.length > 0
    ? "['" + uniqueTools.join("', '") + "']"
    : '[]';

  // Reconstruct frontmatter in Copilot format. Quote description (#2876)
  // so a leading YAML flow indicator (`[BETA] …`, `{ … }`, etc.) doesn't
  // crash the Copilot frontmatter loader.
  let fm = `---\nname: ${name}\ndescription: ${yamlQuote(description)}\ntools: ${toolsArray}\n`;
  if (color) fm += `color: ${color}\n`;
  fm += '---';

  return `${fm}\n${body}`;
}

/**
 * Apply Antigravity-specific content conversion — path replacement + command name conversion.
 * Path mappings depend on install mode:
 *   Global: ~/.claude/skills/ → ~/.gemini/config/skills/ (#3738),
 *          ~/.claude/ → ~/.gemini/antigravity/, ./.claude/ → ./.agents/
 *   Local:  ~/.claude/ → .agents/, ./.claude/ → ./.agents/
 * Applied to ALL Antigravity content (skills, agents, engine files).
 * @param {string} content - Source content to convert
 * @param {boolean} [isGlobal=false] - Whether this is a global install
 */
function convertClaudeToAntigravityContent(content, isGlobal = false) {
  let c = content;
  if (isGlobal) {
    // #3738: global skills install under ~/.gemini/config/skills (the dir AGY
    // scans for global discovery), so skills-path references must divert there
    // — BEFORE the configHome rewrite below, which is correct for gsd-core
    // runtime-file references (settings, workflows, VERSION) but wrong for the
    // skills dir itself. Mirrors src/runtime-artifact-conversion.cts (ADR-1508
    // keeps bin/install.js hand-authored; the two copies must stay in sync).
    c = c.replace(/\$HOME\/\.claude\/skills\//g, '$HOME/.gemini/config/skills/');
    c = c.replace(/~\/\.claude\/skills\//g, '~/.gemini/config/skills/');
    // Bare skills form (no trailing slash) — must also precede the generic
    // slash rule, which would otherwise divert it to the retired configHome
    // path ($HOME/.gemini/antigravity/skills).
    c = c.replace(/\$HOME\/\.claude\/skills\b/g, '$HOME/.gemini/config/skills');
    c = c.replace(/~\/\.claude\/skills\b/g, '~/.gemini/config/skills');
    c = c.replace(/\$HOME\/\.claude\//g, '$HOME/.gemini/antigravity/');
    c = c.replace(/~\/\.claude\//g, '~/.gemini/antigravity/');
    // Bare form (no trailing slash) — must come after slash form to avoid double-replace
    c = c.replace(/\$HOME\/\.claude\b/g, '$HOME/.gemini/antigravity');
    c = c.replace(/~\/\.claude\b/g, '~/.gemini/antigravity');
  } else {
    c = c.replace(/\$HOME\/\.claude\//g, '.agents/');
    c = c.replace(/~\/\.claude\//g, '.agents/');
    // Bare form (no trailing slash) — must come after slash form to avoid double-replace
    c = c.replace(/\$HOME\/\.claude\b/g, '.agents');
    c = c.replace(/~\/\.claude\b/g, '.agents');
  }
  c = c.replace(/\.\/\.claude\//g, './.agents/');
  c = c.replace(/\.claude\//g, '.agents/');
  // Command name conversion (all gsd: references → gsd-)
  c = c.replace(/gsd:/g, 'gsd-');
  // Runtime-neutral agent name replacement (#766)
  c = neutralizeAgentReferences(c, 'GEMINI.md');
  return c;
}

// isGlobal is the 5th positional arg (3rd/4th are runtime/cmdNames passed by the skills wrapper). See runtime-artifact-layout skillsKind.
/**
 * Convert a Claude command (.md) to an Antigravity skill (SKILL.md).
 * Transforms frontmatter to minimal name + description only.
 * Body passes through with path/command conversions applied.
 */
function convertClaudeCommandToAntigravitySkill(content, skillName, _runtime = null, _cmdNames = null, isGlobal = false) {
  const converted = convertClaudeToAntigravityContent(content, isGlobal);
  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  if (!frontmatter) return converted;

  const name = skillName || extractFrontmatterField(frontmatter, 'name') || 'unknown';
  const description = extractFrontmatterField(frontmatter, 'description') || '';

  // #2876: quote description so YAML flow indicators in the source
  // (e.g. `[BETA] …`) don't break downstream frontmatter parsers.
  const fm = `---\nname: ${name}\ndescription: ${yamlQuote(description)}\n---`;
  return `${fm}\n${body}`;
}

/**
 * Convert a Claude agent (.md) to an Antigravity agent.
 * Uses Gemini tool names since Antigravity runs on Gemini 3 backend.
 */
function convertClaudeAgentToAntigravityAgent(content, isGlobal = false) {
  const converted = convertClaudeToAntigravityContent(content, isGlobal);
  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  if (!frontmatter) return converted;

  const name = extractFrontmatterField(frontmatter, 'name') || 'unknown';
  const description = extractFrontmatterField(frontmatter, 'description') || '';
  const color = extractFrontmatterField(frontmatter, 'color');
  const toolsRaw = extractFrontmatterField(frontmatter, 'tools') || '';

  // Map tools to Gemini equivalents (reuse existing convertGeminiToolName)
  const claudeTools = toolsRaw.split(',').map(t => t.trim()).filter(Boolean);
  const mappedTools = claudeTools.map(t => convertGeminiToolName(t)).filter(Boolean);

  // #2876: quote description for the same reason as the skill variant.
  let fm = `---\nname: ${name}\ndescription: ${yamlQuote(description)}\ntools: ${mappedTools.join(', ')}\n`;
  if (color) fm += `color: ${color}\n`;
  fm += '---';

  return `${fm}\n${body}`;
}

function toSingleLine(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function yamlQuote(value) {
  return JSON.stringify(value);
}

function yamlIdentifier(value) {
  const text = String(value).trim();
  if (/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(text)) {
    return text;
  }
  return yamlQuote(text);
}

function extractFrontmatterAndBody(content) {
  if (!content.startsWith('---')) {
    return { frontmatter: null, body: content };
  }

  const endIndex = content.indexOf('---', 3);
  if (endIndex === -1) {
    return { frontmatter: null, body: content };
  }

  return {
    frontmatter: content.substring(3, endIndex).trim(),
    body: content.substring(endIndex + 3),
  };
}

function extractFrontmatterField(frontmatter, fieldName) {
  const regex = new RegExp(`^${fieldName}:\\s*(.+)$`, 'm');
  const match = frontmatter.match(regex);
  if (!match) return null;
  return match[1].trim().replace(/^['"]|['"]$/g, '');
}

// Tool name mapping from Claude Code to Cursor CLI
const claudeToCursorTools = {
  Bash: 'Shell',
  Edit: 'StrReplace',
  AskUserQuestion: null, // No direct equivalent — use conversational prompting
  SlashCommand: null,    // No equivalent — skills are auto-discovered
};

function convertSlashCommandsToCursorSkillMentions(content) {
  // Keep leading "/" for slash commands; only normalize gsd: -> gsd-.
  // This preserves rendered "next step" commands like "/gsd-execute-phase 17".
  return content.replace(/gsd:/gi, 'gsd-');
}

function convertClaudeToCursorMarkdown(content) {
  let converted = convertSlashCommandsToCursorSkillMentions(content);
  // Replace tool name references in body text
  converted = converted.replace(/\bBash\(/g, 'Shell(');
  converted = converted.replace(/\bEdit\(/g, 'StrReplace(');
  converted = converted.replace(/\bAskUserQuestion\b/g, 'conversational prompting');
  // Replace subagent_type from Claude to Cursor format
  converted = converted.replace(/subagent_type="general-purpose"/g, 'subagent_type="generalPurpose"');
  converted = converted.replace(/\$ARGUMENTS\b/g, '{{GSD_ARGS}}');
  // Replace project-level Claude conventions with Cursor equivalents
  converted = converted.replace(/`\.\/CLAUDE\.md`/g, '`.cursor/rules/`');
  converted = converted.replace(/\.\/CLAUDE\.md/g, '.cursor/rules/');
  converted = converted.replace(/`CLAUDE\.md`/g, '`.cursor/rules/`');
  converted = converted.replace(/\bCLAUDE\.md\b/g, '.cursor/rules/');
  converted = converted.replace(/\.claude\/skills\//g, '.cursor/skills/');
  // Remove Claude Code-specific bug workarounds before brand replacement
  converted = converted.replace(/\*\*Known Claude Code bug \(classifyHandoffIfNeeded\):\*\*[^\n]*\n/g, '');
  converted = converted.replace(/- \*\*classifyHandoffIfNeeded false failure:\*\*[^\n]*\n/g, '');
  // Replace "Claude Code" brand references with "Cursor" — #2284(b): skips
  // <runtime_compatibility> comparison-table content (protected region).
  converted = applyClaudeCodeBrandSwap(converted, 'Cursor');
  return converted;
}

function getCursorSkillAdapterHeader(skillName) {
  return `<cursor_skill_adapter>
## A. Skill Invocation
- This skill is invoked when the user mentions \`${skillName}\` or describes a task matching this skill.
- Treat all user text after the skill mention as \`{{GSD_ARGS}}\`.
- If no arguments are present, treat \`{{GSD_ARGS}}\` as empty.

## B. User Prompting
When the workflow needs user input, prompt the user conversationally:
- Present options as a numbered list in your response text
- Ask the user to reply with their choice
- For multi-select, ask for comma-separated numbers

## C. Tool Usage
Use these Cursor tools when executing GSD workflows:
- \`Shell\` for running commands (terminal operations)
- \`StrReplace\` for editing existing files
- \`Read\`, \`Write\`, \`Glob\`, \`Grep\`, \`Task\`, \`WebSearch\`, \`WebFetch\`, \`TodoWrite\` as needed

## D. Subagent Spawning
When the workflow needs to spawn a subagent:
- Use \`Task(subagent_type="generalPurpose", ...)\`
- The \`model\` parameter maps to Cursor's model options (e.g., "fast")
</cursor_skill_adapter>`;
}

function convertClaudeCommandToCursorSkill(content, skillName) {
  const converted = convertClaudeToCursorMarkdown(content);
  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  let description = `Run GSD workflow ${skillName}.`;
  if (frontmatter) {
    const maybeDescription = extractFrontmatterField(frontmatter, 'description');
    if (maybeDescription) {
      description = maybeDescription;
    }
  }
  description = toSingleLine(description);
  const shortDescription = description.length > 180 ? `${description.slice(0, 177)}...` : description;
  const adapter = getCursorSkillAdapterHeader(skillName);

  // Cursor skills are both slash-invocable and model-invocable. Do not emit the
  // unsupported `user-invocable` field: it is ignored by Cursor and previously
  // hid the real cause of duplicate entries, the parallel commands/ surface
  // retired in #2644.
  return `---\nname: ${yamlIdentifier(skillName)}\ndescription: ${yamlQuote(shortDescription)}\n---\n\n${adapter}\n\n${body.trimStart()}`;
}

/**
 * Convert Claude Code agent markdown to Cursor agent format.
 * Strips frontmatter fields Cursor doesn't support (color, skills),
 * converts tool references, and adds a role context header.
 */
function convertClaudeAgentToCursorAgent(content) {
  let converted = convertClaudeToCursorMarkdown(content);

  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  if (!frontmatter) return converted;

  const name = extractFrontmatterField(frontmatter, 'name') || 'unknown';
  const description = extractFrontmatterField(frontmatter, 'description') || '';

  const cleanFrontmatter = `---\nname: ${yamlIdentifier(name)}\ndescription: ${yamlQuote(toSingleLine(description))}\n---`;

  return `${cleanFrontmatter}\n${body}`;
}

// --- Windsurf converters ---
// #2931 (ADR-1508): single-sourced in runtimeArtifactConversion, bound near
// the top of this file alongside the #1675 Augment family. This block
// previously carried byte-identical local duplicates of
// convertSlashCommandsToWindsurfSkillMentions, convertClaudeToWindsurfMarkdown,
// getWindsurfSkillAdapterHeader, convertClaudeCommandToWindsurfSkill,
// convertClaudeCommandToWindsurfWorkflow, and convertClaudeAgentToWindsurfAgent,
// plus an unused claudeToWindsurfTools table. Deleted here; the two
// unexported helpers (getWindsurfSkillAdapterHeader,
// convertSlashCommandsToWindsurfSkillMentions) now live only in the
// conversion module, with no other caller in this file.

// --- Augment converters ---
// Augment uses a tool set similar to Cursor/Windsurf.
// Config lives in .augment/ (local) and ~/.augment/ (global).

// #1675 (ADR-1508): the augment converter family below was a byte-identical
// duplicate of runtime-artifact-conversion.cjs:
//   convertSlashCommandsToAugmentSkillMentions, convertClaudeToAugmentMarkdown,
//   getAugmentSkillAdapterHeader, convertClaudeCommandToAugmentSkill,
//   convertClaudeAgentToAugmentAgent
// Deleted here and bound from runtimeArtifactConversion above (single source).
// The DEFECT.GENERATIVE-FIX parity guard in
// tests/enh-1511-rewrite-engine-relocation.test.cjs asserts reference identity.

function convertSlashCommandsToTraeSkillMentions(content) {
  return content.replace(/\/gsd:([a-z0-9-]+)/g, (_, commandName) => {
    return `/gsd-${commandName}`;
  });
}

function convertClaudeToTraeMarkdown(content) {
  let converted = convertSlashCommandsToTraeSkillMentions(content);
  converted = converted.replace(/\bBash\(/g, 'Shell(');
  converted = converted.replace(/\bEdit\(/g, 'StrReplace(');
  // Replace general-purpose subagent type with Trae's equivalent "general_purpose_task"
  converted = converted.replace(/subagent_type="general-purpose"/g, 'subagent_type="general_purpose_task"');
  converted = converted.replace(/\$ARGUMENTS\b/g, '{{GSD_ARGS}}');
  // #2658: full-path forms (with a leading dot-claude-slash prefix) MUST be
  // replaced before the bare Claude-instruction-file pattern and before the
  // generic dot-claude-slash rewrite below — otherwise the bare pattern
  // consumes only the instruction-filename tail, leaving that prefix stale
  // in place, and the generic rewrite then mutates the stale leftover too,
  // producing a doubled trae-prefix segment ahead of the rules path instead
  // of a single clean one. (Deliberately never spelling the instruction
  // filename as one contiguous "CLAUDE" + dot + "md" token, and never
  // spelling either malformed shape out as a literal contiguous string, in
  // ANY comment in this function: this file ships verbatim into local
  // `--trae` installs, where it is itself run through this same class of
  // find/replace — a literal instruction-filename token sitting in a
  // comment gets "fixed" right along with real code, and the emitted-content
  // regression test added alongside this fix asserts neither malformed
  // shape appears anywhere in the installed tree, comments included; this
  // bit the fix itself twice during development.) All forms converge on the
  // same concrete file (never a bare directory) so this stays in parity
  // with the `trae.js` RUNTIME_CONTENT_DISPATCH entry.
  converted = converted.replace(/`\.\/\.claude\/CLAUDE\.md`/g, '`.trae/rules/rules.md`');
  converted = converted.replace(/\.\/\.claude\/CLAUDE\.md/g, '.trae/rules/rules.md');
  converted = converted.replace(/`\.claude\/CLAUDE\.md`/g, '`.trae/rules/rules.md`');
  converted = converted.replace(/\.claude\/CLAUDE\.md/g, '.trae/rules/rules.md');
  // #2658 (found via the end-to-end install regression test, not the static
  // trace above): `copyWithPathReplacement` runs a GENERIC dot-claude-slash
  // -> runtime-config-dir rewrite on every .md file before calling this
  // converter — for `~/.claude/`, `$HOME/.claude/`, AND `./.claude/` alike —
  // substituting a runtime-appropriate `pathPrefix` this function is never
  // given and cannot itself compute (it differs per install invocation: a
  // relative `./.trae/` for a project-local install, an arbitrary absolute
  // path for a local install rooted elsewhere, `~/.trae/` for a global one).
  // So for source using any of those prefixed forms, the patterns above
  // never fire here — this converter only ever sees the ALREADY-rewritten
  // "<runtime-config-dir>/" + instruction-filename shape, with whatever
  // prefix the install actually used. The generic pattern below preserves
  // that prefix verbatim (via the capture group) and only fixes the
  // filename suffix, rather than assuming a fixed `./.trae/` shape — a
  // narrower fixed-prefix version of this pattern shipped first and still
  // left the doubled-prefix defect live for the `$HOME/.claude/` and
  // `~/.claude/` forms specifically (found the same way, one regression-test
  // run later). Scoped to a `.trae/` tail so it cannot also swallow the
  // unprefixed `./CLAUDE.md` form the very next pattern handles differently
  // (discarding the prefix entirely, not preserving it). Must run before
  // the bare pattern for the same consume-the-full-match-first reason.
  converted = converted.replace(/`([^\s`]*\.trae\/)CLAUDE\.md`/g, '`$1rules/rules.md`');
  converted = converted.replace(/([^\s`]*\.trae\/)CLAUDE\.md/g, '$1rules/rules.md');
  converted = converted.replace(/`\.\/CLAUDE\.md`/g, '`.trae/rules/rules.md`');
  converted = converted.replace(/\.\/CLAUDE\.md/g, '.trae/rules/rules.md');
  converted = converted.replace(/`CLAUDE\.md`/g, '`.trae/rules/rules.md`');
  converted = converted.replace(/\bCLAUDE\.md\b/g, '.trae/rules/rules.md');
  converted = converted.replace(/\.claude\/skills\//g, '.trae/skills/');
  converted = converted.replace(/\.\/\.claude\//g, './.trae/');
  converted = converted.replace(/\.claude\//g, '.trae/');
  // Bare forms (no trailing slash) — after slash forms to avoid double-rewrite.
  // Use negative lookahead (?![\w-]) to preserve .claude-plugin and .claudeignore.
  converted = converted.replace(/~\/\.claude(?![\w-])/g, '~/.trae');
  converted = converted.replace(/\$HOME\/\.claude(?![\w-])/g, '$HOME/.trae');
  // Environment variable name rewrite
  converted = converted.replace(/\bCLAUDE_CONFIG_DIR\b/g, 'TRAE_CONFIG_DIR');
  converted = converted.replace(/\*\*Known Claude Code bug \(classifyHandoffIfNeeded\):\*\*[^\n]*\n/g, '');
  converted = converted.replace(/- \*\*classifyHandoffIfNeeded false failure:\*\*[^\n]*\n/g, '');
  // #2284(b): skips <runtime_compatibility> comparison-table content (protected region).
  converted = applyClaudeCodeBrandSwap(converted, 'Trae');
  return converted;
}

// DEFECT.GENERATIVE-FIX: this body is mirrored in
// src/runtime-artifact-conversion.cts's convertClaudeCommandToTraeSkill (used
// by src/install-engine.cts's skills-install path via
// SKILLS_CONVERTER_REGISTRY). This bin/install.js copy is dead for the live
// skills-install path — kept for this file's own module-level export/test
// surface. Neither copy re-exports the other — mirror any behavior change
// into both. Guarded by the output-parity test in
// tests/runtime-converters.test.cjs (#2094).
function convertClaudeCommandToTraeSkill(content, skillName) {
  const converted = convertClaudeToTraeMarkdown(content);
  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  let description = `Run GSD workflow ${skillName}.`;
  if (frontmatter) {
    const maybeDescription = extractFrontmatterField(frontmatter, 'description');
    if (maybeDescription) {
      description = maybeDescription;
    }
  }
  description = toSingleLine(description);
  const shortDescription = description.length > 180 ? `${description.slice(0, 177)}...` : description;
  // #2876: quote so YAML flow indicators (`[BETA] …`) don't break Trae's
  // frontmatter parser.
  let fm = `---\nname: ${yamlIdentifier(skillName)}\ndescription: ${yamlQuote(shortDescription)}\n`;
  // #2094: emit `stage:` so Trae's SOLO agent can auto-invoke GSD skills at
  // the corresponding stage (docs.trae.ai/ide/agent). The field name/schema
  // is not formally documented (thin SPA docs) — descriptor-driven, single
  // fixed GSD-side value (runtime.hostBehaviors.soloStageMetadata), inferred/
  // best-effort.
  const soloStage = _hostBehaviors('trae').soloStageMetadata;
  if (soloStage) fm += `stage: ${soloStage}\n`;
  fm += '---';
  return `${fm}\n${body}`;
}

function convertClaudeAgentToTraeAgent(content) {
  let converted = convertClaudeToTraeMarkdown(content);

  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  if (!frontmatter) return converted;

  const name = extractFrontmatterField(frontmatter, 'name') || 'unknown';
  const description = extractFrontmatterField(frontmatter, 'description') || '';

  const cleanFrontmatter = `---\nname: ${yamlIdentifier(name)}\ndescription: ${yamlQuote(toSingleLine(description))}\n---`;

  return `${cleanFrontmatter}\n${body}`;
}

function convertSlashCommandsToCodebuddySkillMentions(content) {
  return content.replace(/\/gsd:([a-z0-9-]+)/g, (_, commandName) => {
    return `/gsd-${commandName}`;
  });
}

function convertClaudeToCodebuddyMarkdown(content) {
  let converted = convertSlashCommandsToCodebuddySkillMentions(content);
  // CodeBuddy uses the same tool names as Claude Code (Bash, Edit, Read, Write, etc.)
  // No tool name conversion needed
  converted = converted.replace(/\$ARGUMENTS\b/g, '{{GSD_ARGS}}');
  converted = converted.replace(/`\.\/CLAUDE\.md`/g, '`CODEBUDDY.md`');
  converted = converted.replace(/\.\/CLAUDE\.md/g, 'CODEBUDDY.md');
  converted = converted.replace(/`CLAUDE\.md`/g, '`CODEBUDDY.md`');
  converted = converted.replace(/\bCLAUDE\.md\b/g, 'CODEBUDDY.md');
  converted = converted.replace(/\.claude\/skills\//g, '.codebuddy/skills/');
  converted = converted.replace(/\.\/\.claude\//g, './.codebuddy/');
  converted = converted.replace(/\.claude\//g, '.codebuddy/');
  converted = converted.replace(/\*\*Known Claude Code bug \(classifyHandoffIfNeeded\):\*\*[^\n]*\n/g, '');
  converted = converted.replace(/- \*\*classifyHandoffIfNeeded false failure:\*\*[^\n]*\n/g, '');
  // #2284(b): skips <runtime_compatibility> comparison-table content (protected region).
  converted = applyClaudeCodeBrandSwap(converted, 'CodeBuddy');
  return converted;
}

function convertClaudeCommandToCodebuddySkill(content, skillName) {
  const converted = convertClaudeToCodebuddyMarkdown(content);
  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  let description = `Run GSD workflow ${skillName}.`;
  if (frontmatter) {
    const maybeDescription = extractFrontmatterField(frontmatter, 'description');
    if (maybeDescription) {
      description = maybeDescription;
    }
  }
  description = toSingleLine(description);
  const shortDescription = description.length > 180 ? `${description.slice(0, 177)}...` : description;
  // #2876: quote so YAML flow indicators (`[BETA] …`) don't break
  // CodeBuddy's frontmatter parser.
  //
  // #789: mark user-invocable:false so the skill is NOT shown in CodeBuddy's
  // '/' menu (it defaults to true). The commands/ surface (#789) is the sole
  // '/' entry point; skills remain model-invocable background knowledge,
  // avoiding a duplicated /gsd-* entry per workflow.
  return `---\nname: ${yamlIdentifier(skillName)}\ndescription: ${yamlQuote(shortDescription)}\nuser-invocable: false\n---\n${body}`;
}

/**
 * Convert a Claude Code slash-command (.md) to a CodeBuddy slash-command (.md).
 *
 * CodeBuddy reads user-level slash commands from ~/.codebuddy/commands/<name>.md
 * (https://www.codebuddy.ai/docs/cli/slash-commands). The filename determines the
 * command name (gsd-help.md → /gsd-help), so the Claude-specific `name: gsd:<x>`
 * frontmatter field is dropped. CodeBuddy command frontmatter supports
 * `description` and `argument-hint`; both are preserved when present. The body is
 * brand/path-converted via convertClaudeToCodebuddyMarkdown.
 *
 * @param {string} content      raw Claude command markdown
 * @param {string} commandName  installed command name (e.g. 'gsd-help')
 * @returns {string}
 */
function convertClaudeCommandToCodebuddyCommand(content, commandName) {
  const converted = convertClaudeToCodebuddyMarkdown(content);
  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  let description = `Run GSD workflow ${commandName}.`;
  let argumentHint = '';
  if (frontmatter) {
    const maybeDescription = extractFrontmatterField(frontmatter, 'description');
    if (maybeDescription) description = maybeDescription;
    const maybeArgHint = extractFrontmatterField(frontmatter, 'argument-hint');
    if (maybeArgHint) argumentHint = maybeArgHint;
  }
  description = toSingleLine(description);
  const shortDescription = description.length > 180 ? `${description.slice(0, 177)}...` : description;
  // #2876: quote values so YAML flow indicators (`[BETA] …`, `[name]`) don't
  // break CodeBuddy's frontmatter parser.
  const lines = ['---', `description: ${yamlQuote(shortDescription)}`];
  if (argumentHint) lines.push(`argument-hint: ${yamlQuote(toSingleLine(argumentHint))}`);
  lines.push('---', body.trimStart());
  return lines.join('\n');
}

function convertClaudeAgentToCodebuddyAgent(content) {
  let converted = convertClaudeToCodebuddyMarkdown(content);

  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  if (!frontmatter) return converted;

  const name = extractFrontmatterField(frontmatter, 'name') || 'unknown';
  const description = extractFrontmatterField(frontmatter, 'description') || '';

  const cleanFrontmatter = `---\nname: ${yamlIdentifier(name)}\ndescription: ${yamlQuote(toSingleLine(description))}\n---`;

  return `${cleanFrontmatter}\n${body}`;
}

// ── Cline converters ────────────────────────────────────────────────────────

function convertClaudeToCliineMarkdown(content) {
  let converted = content;
  // Cline uses the same tool names as Claude Code — no tool name conversion needed
  converted = converted.replace(/`\.\/CLAUDE\.md`/g, '`.clinerules`');
  converted = converted.replace(/\.\/CLAUDE\.md/g, '.clinerules');
  converted = converted.replace(/`CLAUDE\.md`/g, '`.clinerules`');
  converted = converted.replace(/\bCLAUDE\.md\b/g, '.clinerules');
  // Slash forms first (most specific — superset of bare forms)
  converted = converted.replace(/\.claude\/skills\//g, '.cline/skills/');
  converted = converted.replace(/\.\/\.claude\//g, './.cline/');
  converted = converted.replace(/\.claude\//g, '.cline/');
  // Bare forms (no trailing slash) — after slash forms to avoid double-rewrite
  converted = converted.replace(/~\/\.claude\b/g, '~/.cline');
  converted = converted.replace(/\$HOME\/\.claude\b/g, '$HOME/.cline');
  // Environment variable name rewrite
  converted = converted.replace(/\bCLAUDE_CONFIG_DIR\b/g, 'CLINE_CONFIG_DIR');
  converted = converted.replace(/\*\*Known Claude Code bug \(classifyHandoffIfNeeded\):\*\*[^\n]*\n/g, '');
  converted = converted.replace(/- \*\*classifyHandoffIfNeeded false failure:\*\*[^\n]*\n/g, '');
  // #2284(b): skips <runtime_compatibility> comparison-table content (protected region).
  converted = applyClaudeCodeBrandSwap(converted, 'Cline');
  return converted;
}

function convertClaudeAgentToClineAgent(content) {
  let converted = convertClaudeToCliineMarkdown(content);
  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  if (!frontmatter) return converted;
  const name = extractFrontmatterField(frontmatter, 'name') || 'unknown';
  const description = extractFrontmatterField(frontmatter, 'description') || '';
  const cleanFrontmatter = `---\nname: ${yamlIdentifier(name)}\ndescription: ${yamlQuote(toSingleLine(description))}\n---`;
  return `${cleanFrontmatter}\n${body}`;
}

/**
 * Convert a Claude command (.md) to a Cline skill (SKILL.md).
 * Emits ONLY name + description frontmatter per the Cline skills spec
 * (https://docs.cline.bot/customization/skills) — no allowed-tools,
 * argument-hint, agent, or other Claude-specific fields.
 * Body is hyphen-normalised then converted via convertClaudeToCliineMarkdown
 * (.claude/→.cline/, "Claude Code"→"Cline", etc.).
 * Cline uses Claude-Code-compatible tool names, so no adapter header is needed.
 * Targets ~/.cline/skills/<name>/SKILL.md for Cline >= v3.48.0.
 */
function convertClaudeCommandToClineSkill(content, skillName, runtime = null, cmdNames = null) {
  const { frontmatter, body } = extractFrontmatterAndBody(content);
  if (!frontmatter) return content;

  // Hyphen-normalise /gsd:<cmd> → gsd-<cmd> references in the body, then
  // apply Cline-specific markdown rewrites (.claude/→.cline/, etc.).
  const names = cmdNames || readGsdCommandNames();
  const normalizedBody = transformContentToHyphen(body, names);
  const clineBody = convertClaudeToCliineMarkdown(normalizedBody);

  // Extract description; fall back to a generic string if absent.
  let description = extractFrontmatterField(frontmatter, 'description');
  if (!description) description = `Run GSD workflow ${skillName}.`;
  description = toSingleLine(description);
  // Cline documented max is 1024 code points (not UTF-16 code units).
  // Use Array.from to iterate by code point so that multibyte characters
  // (e.g. emoji, astral-plane chars) are never split, which would produce
  // lone surrogates and corrupt the YAML output.
  const cp = Array.from(description);
  const shortDescription = cp.length > 1024
    ? cp.slice(0, 1021).join('') + '...'
    : description;

  const fm = `---\nname: ${yamlIdentifier(skillName)}\ndescription: ${yamlQuote(shortDescription)}\n---`;
  return `${fm}\n${clineBody}`;
}

// ── End Cline converters ─────────────────────────────────────────────────────

// ── Hermes converters (#2284) ────────────────────────────────────────────────
//
// Hermes exposes `delegate_task` for subagent dispatch, not the Claude-shaped
// `Agent(...)` tool the host-neutral `gsd-core/workflows/*.md` corpus assumes.
// Prior to this fix, the hermes `.md` hook (RUNTIME_CONTENT_DISPATCH.hermes)
// only brand-swapped "Claude Code" → "Hermes Agent" via
// hostBehaviors.brandingRewrites, leaving the false "Agent tool IS available"
// assertion and literal `Agent(...)` call syntax installed verbatim.
//
// `projectNamedDispatchToStructuralDelegate` is GENERIC projection machinery:
// it branches ENTIRELY on the runtime's documentation-sourced
// `hostIntegration.dispatch` facts (read via `_hostIntegrationDispatch`,
// capabilities/<runtime>/capability.json — never hardcoded here) and a
// `toolConfig` that supplies only the target primitive's own vocabulary (its
// call name + native parameter names — not a capability claim; there is no
// `dispatch` axis for "the call's own parameter names", so that vocabulary is
// necessarily supplied by the caller, exactly as every other runtime's
// converter supplies its own tool-name vocabulary, e.g. Trae's `Shell(`).
//
// Hermes-specific facts consumed (capabilities/hermes/capability.json,
// docs/reference/host-integration-capability-matrix.md:244-249 — UNCHANGED by
// this fix):
//   - dispatch.namedDispatch: false — Hermes's delegate_task has no named-
//     agent lookup ("Subagents are identified only by role ('leaf' or
//     'orchestrator')"). GSD resolves the referenced gsd-* role itself
//     (fail-closed against the staged agents/ dir) and embeds the loaded
//     PROMPT CONTENT into the delegate_task payload.
//   - dispatch.background: true — `delegate_task(background=true)` "returns a
//     handle immediately"; Claude's `run_in_background=` maps onto Hermes's
//     own `background=` parameter, preserving the async-handle / no-busy-poll
//     / resume-on-completion wording already used throughout these workflows.
//   - dispatch.subagentToolkit: "read-only" / dispatch.maxDepth: 1 — dispatched
//     roles never themselves further delegate, so no nested-delegation
//     instruction is ever emitted toward them.

/**
 * Resolve the set of gsd-* role-prompt stems actually shipped in this
 * package's `agents/` directory (the FULL source set, not profile-staged —
 * `--minimal`/`--profile=core` intentionally excludes many agents from a
 * given install without those workflows being unreachable, so validating
 * against the profile-filtered subset would fail every restricted-profile
 * Hermes install; validating against the shipped source catches genuine
 * authoring bugs — a stale/typo'd role reference — without that regression).
 * Returns `null` if the directory cannot be resolved (fail-closed: callers
 * must refuse to install rather than skip validation).
 */
function _resolveAvailableGsdRoles() {
  try {
    const agentsDir = path.join(__dirname, '..', 'agents');
    return new Set(
      fs.readdirSync(agentsDir, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.md'))
        .map((e) => e.name.slice(0, -3)),
    );
  } catch (_e) {
    return null;
  }
}

/**
 * Fail-closed validation (#2284 AC: "Missing role prompts fail closed" /
 * "never emit a workflow referencing an unresolvable role"). A single literal
 * `gsd-*` role value must resolve to a real `agents/<role>.md` file — throws
 * an explicit Error otherwise, aborting the install (the standard
 * `copyWithPathReplacement` failure path already used for its own
 * confinement-violation throws). Called per extracted role value from EVERY
 * call-syntax form (`subagent_type=`, `subagent_type:`, post-rename
 * `gsd_role=`) — the check operates on the resolved value, independent of
 * which source syntax produced it. Non-literal / dynamic expressions (e.g.
 * `research_hook.ref.agent`) are not quoted strings and are never passed
 * here; they carry their own runtime resolution + fail-closed instruction via
 * the injected per-call resolution line.
 */
function _assertRoleResolvable(role, availableRoles, runtime, sourceDescription) {
  if (!availableRoles) {
    throw new Error(
      `${runtime} workflow install: could not resolve the shipped agents/ directory to validate named-role ` +
      'dispatch references — refusing to install (fail-closed, #2284)',
    );
  }
  if (role.startsWith('gsd-') && !availableRoles.has(role)) {
    throw new Error(
      `${runtime} workflow install: dispatch references role "${role}" via ${sourceDescription}, but no ` +
      `matching agents/${role}.md prompt file is shipped — refusing to install a workflow that dispatches ` +
      'an unresolvable role (fail-closed, #2284)',
    );
  }
}

/**
 * Segment `text` into 'code' and 'string' runs (recognizes `"..."`, `'...'`,
 * and Python-style `"""..."""`, with backslash-escaping). Required because
 * the real corpus embeds unescaped parens inside quoted prompt bodies (e.g.
 * discuss-phase-assumptions.md's `(e.g., "Technical Approach")` inside a
 * `"""`-quoted prompt) — naive paren/keyword scanning across raw text would
 * desync on these. Downstream call-span detection and header-token
 * extraction operate on a same-length MASK derived from this segmentation
 * (see `maskStringLiterals`) so string content can never be mistaken for
 * call structure.
 */
function _segmentCodeAndStrings(text) {
  const segments = [];
  let i = 0;
  let segStart = 0;
  const flushCode = (end) => { if (end > segStart) segments.push({ type: 'code', start: segStart, end }); };
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' && text[i + 1] === '"' && text[i + 2] === '"') {
      flushCode(i);
      const strStart = i;
      i += 3;
      while (i < text.length && !(text[i] === '"' && text[i + 1] === '"' && text[i + 2] === '"')) {
        i += text[i] === '\\' ? 2 : 1;
      }
      i = Math.min(i + 3, text.length);
      segments.push({ type: 'string', start: strStart, end: i, quoteLen: 3 });
      segStart = i;
      continue;
    }
    // Only `"` is recognized as a single-char string delimiter — NOT `'`.
    // The corpus is markdown prose, not code: apostrophes are routine English
    // contractions/possessives ("install's", "don't") and treating them as
    // string delimiters would swallow everything up to the next unrelated
    // apostrophe as "inside a string" (verified against the real corpus —
    // this was a real, disqualifying bug during development of this fix).
    // Every real call-argument value in the corpus uses `"`/`"""` only.
    if (ch === '"') {
      flushCode(i);
      const strStart = i;
      i += 1;
      while (i < text.length && text[i] !== '"') {
        i += text[i] === '\\' ? 2 : 1;
      }
      i = Math.min(i + 1, text.length);
      segments.push({ type: 'string', start: strStart, end: i, quoteLen: 1 });
      segStart = i;
      continue;
    }
    i += 1;
  }
  flushCode(text.length);
  return segments;
}

/**
 * Same-length mask of `text` with the INTERIOR of every string literal
 * replaced by a space (newlines preserved, so line-based regexes still work).
 * The delimiting quote character(s) themselves (`"`, `'`, `"""`) are kept
 * verbatim so a value-extraction regex like `key\s*[=:]\s*"[^"]*"` still
 * matches correctly against the mask — only the STRING CONTENT is blanked,
 * never the quote structure. Positions in the mask line up 1:1 with `text`,
 * so match indices/offsets found against the mask are valid offsets into the
 * original.
 */
function maskStringLiterals(text) {
  let mask = '';
  for (const seg of _segmentCodeAndStrings(text)) {
    const slice = text.slice(seg.start, seg.end);
    if (seg.type === 'code') { mask += slice; continue; }
    const q = seg.quoteLen;
    if (slice.length <= q) { mask += slice; continue; } // truncated/unterminated — keep verbatim
    const closeLen = Math.min(q, slice.length - q);
    const open = slice.slice(0, q);
    const close = slice.slice(slice.length - closeLen);
    const interiorLen = slice.length - q - closeLen;
    const interior = interiorLen > 0 ? slice.slice(q, q + interiorLen) : '';
    mask += open + interior.replace(/[^\n]/g, ' ') + close;
  }
  return mask;
}

/**
 * Locate every `<headWord>(` / `<headWord>({` call span in `text`.
 *
 * #2284 round-2 CRITICAL fix: this MUST NOT rely on whole-document quote
 * parity. A markdown workflow file mixes prose, ```bash code fences (full of
 * their own double-quoted strings), and shell quoting — there is no single
 * document-wide quote grammar, so a `"`-heavy bash `echo` upstream of a real
 * call (e.g. code-review.md's fenced `echo "..."` block before its
 * `Agent(subagent_type="gsd-code-reviewer", ...)` call) can desync a
 * CUMULATIVE quote-state scan, making the scanner believe the real call's
 * `Agent(` sits "inside a string" and silently skipping it entirely — the
 * call then survives completely unnormalized. (Reproduced and root-caused
 * against the real corpus.)
 *
 * Fixed shape: find each `<headWord>(` occurrence via a PLAIN literal-text
 * search (`indexOf`, immune to any prior document content), then run a
 * balanced paren-matching scan whose quote-tracking state STARTS FRESH AT
 * THE HEAD — local to this one call, never inherited from (or able to be
 * corrupted by) anything earlier in the document. Handles all three real
 * corpus shapes: multi-line one-key-per-line, single-line object-literal
 * (`Agent({ ... })`), and single-line compact
 * (`Agent(subagent_type="x", model="y", prompt="...")`) — including prompt
 * bodies containing their own unescaped `()`/`{}` (skipped via the SAME
 * span-local quote tracking, e.g. discuss-phase-assumptions.md's
 * `"""`-quoted parenthetical prose).
 *
 * Returns `[{start, end, hasBraceWrapper}]` — `start`/`end` bound the FULL
 * call INCLUDING the head word and the closing `)`/`})`.
 */
function findDispatchCallSpans(text, headWord) {
  const spans = [];
  const headToken = `${headWord}(`;
  let searchFrom = 0;
  for (;;) {
    const start = text.indexOf(headToken, searchFrom);
    if (start === -1) break;
    const prevChar = start > 0 ? text[start - 1] : '';
    if (/[A-Za-z0-9_]/.test(prevChar)) { searchFrom = start + 1; continue; } // word-boundary guard

    let i = start + headToken.length; // just past the '('
    let j = i;
    while (j < text.length && /\s/.test(text[j])) j++;
    const hasBraceWrapper = text[j] === '{';

    // LOCAL scan — quote/paren state is fresh here, never inherited from
    // anything before `start` in the document.
    let parenDepth = 1;
    let inString = null; // null | '"' | 'triple'
    let end = -1;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === '\\') { i++; continue; }
        if (inString === 'triple') {
          if (ch === '"' && text[i + 1] === '"' && text[i + 2] === '"') { inString = null; i += 2; }
          continue;
        }
        if (ch === inString) inString = null;
        continue;
      }
      if (ch === '"' && text[i + 1] === '"' && text[i + 2] === '"') { inString = 'triple'; i += 2; continue; }
      if (ch === '"') { inString = '"'; continue; }
      if (ch === '(') { parenDepth++; continue; }
      if (ch === ')') {
        parenDepth--;
        if (parenDepth === 0) { end = i + 1; break; }
        continue;
      }
    }
    if (end === -1) { searchFrom = start + 1; continue; } // unterminated — skip past, keep scanning
    spans.push({ start, end, hasBraceWrapper });
    searchFrom = end;
  }
  return spans;
}

/**
 * Remove a call argument's `[matchStart, matchEnd)` token from `spanText`,
 * consuming its surrounding comma/whitespace so no dangling `, ,` or trailing
 * comment survives. When the argument owns its whole line, the whole line
 * (including a trailing inline `# comment`) is removed; `consumeLeadingComments`
 * additionally removes contiguous comment-only lines immediately ABOVE it —
 * #2284 Finding 5: explanatory prose describing a now-removed conditional
 * (e.g. execute-phase.md's "# Only include model= when ...") must not survive
 * describing a branch that no longer exists. Inline (single-line-compact /
 * object-literal) occurrences instead eat one adjacent comma.
 */
function _stripCallArgument(spanText, matchStart, matchEnd, { consumeLeadingComments = false } = {}) {
  let end = matchEnd;
  const afterRe = /^[ \t]*,?[ \t]*(#[^\n]*)?\r?\n?/;
  const afterMatch = afterRe.exec(spanText.slice(end));
  const hadTrailingComma = !!(afterMatch && /,/.test(afterMatch[0]));
  if (afterMatch) end += afterMatch[0].length;

  let start = matchStart;
  const lineStart = spanText.lastIndexOf('\n', start - 1) + 1;
  const ownLine = /^[ \t]*$/.test(spanText.slice(lineStart, start));
  if (ownLine) {
    start = lineStart;
    if (consumeLeadingComments) {
      for (;;) {
        const prevLineStart = start > 0 ? spanText.lastIndexOf('\n', start - 2) + 1 : 0;
        const prevLine = spanText.slice(prevLineStart, start);
        if (/^[ \t]*#[^\n]*\r?\n$/.test(prevLine)) {
          start = prevLineStart;
          if (prevLineStart === 0) break;
        } else break;
      }
    }
  } else if (!hadTrailingComma) {
    // Inline form and this was the LAST arg (no trailing comma) — eat a
    // leading comma so the previous arg doesn't dangle one.
    const before = spanText.slice(0, start);
    const cm = /,[ \t]*$/.exec(before);
    if (cm) start -= cm[0].length;
  }
  return spanText.slice(0, start) + spanText.slice(end);
}

/**
 * Replace a named-role argument token's `[matchStart, matchEnd)` span
 * (`subagent_type=`/`subagent_type:` + its value) with the projected
 * `gsd_role=` / role-prompt-resolution / structural-role argument group.
 * Preserves the pretty multi-line one-arg-per-line style when the original
 * token owned its own line; falls back to an inline, comma-joined group for
 * the single-line-compact and object-literal forms.
 */
function _projectRoleArgument(spanText, matchStart, matchEnd, roleValueExpr, toolConfig, canOrchestrate) {
  const { namedRoleParam, promptContentParam, structuralRoleParam, leafRoleValue } = toolConfig;
  const lineStart = spanText.lastIndexOf('\n', matchStart - 1) + 1;
  const startsOwnLine = /^[ \t]*$/.test(spanText.slice(lineStart, matchStart));

  // Consume an immediately-following separator comma (+ same-line whitespace/
  // newline) into `end` — never leave it dangling AFTER an injected trailing
  // `# comment` (a bare `,` after `#...` would sit on the comment's own line,
  // outside any real argument list).
  let end = matchEnd;
  const afterRe = /^[ \t]*,[ \t]*\r?\n?/;
  const afterMatch = afterRe.exec(spanText.slice(end));
  const hadTrailingComma = !!afterMatch;
  if (afterMatch) end += afterMatch[0].length;
  const ownLine = startsOwnLine && hadTrailingComma && /\n$/.test(afterMatch[0]);

  const promptContentPhrase =
    `${promptContentParam}=<resolve ${roleValueExpr} against the active install's gsd-* role prompts and load ` +
    'its contents; FAIL CLOSED with an explicit error if unresolved — never execute the role inline>';

  let replacement;
  if (ownLine) {
    const indent = spanText.slice(lineStart, matchStart);
    const depthNote = canOrchestrate ? '' : '  # nested delegation is unavailable at this dispatch depth/toolkit';
    replacement =
      `${namedRoleParam}=${roleValueExpr},\n` +
      `${indent}${promptContentPhrase},\n` +
      `${indent}${structuralRoleParam}="${leafRoleValue}",${depthNote}\n`;
  } else {
    // Inline forms never carry a trailing `#` comment mid-argument-list (it
    // would silently "comment out" the remainder of the call), so the
    // depth/toolkit caveat is only ever emitted in the pretty own-line form.
    // Re-emit exactly the separator that originally followed this argument
    // (a comma if more args follow; nothing if it was the last one).
    replacement =
      `${namedRoleParam}=${roleValueExpr}, ${promptContentPhrase}, ${structuralRoleParam}="${leafRoleValue}"` +
      (hadTrailingComma ? ', ' : '');
  }
  return spanText.slice(0, matchStart) + replacement + spanText.slice(end);
}

// Matches a `subagent_type`/`model` argument's key+delimiter+value across all
// three corpus forms: quoted-string values ("gsd-planner", "{model}") and
// bare dynamic-expression values (ref.agent, research_hook.ref.agent,
// executor_model). The captured group is always the value (a suffix of the
// whole match), so its start offset is `match.index + match[0].length -
// match[1].length` — avoids needing the regex `d` (indices) flag.
function _callArgValueRe(key) {
  return new RegExp(`\\b${key}\\s*[=:]\\s*("(?:[^"\\\\]|\\\\.)*"|[A-Za-z_][\\w.]*)`);
}

/**
 * Returns the literal role name from a captured role-argument value EXPR
 * (e.g. `"gsd-planner"`) — or `null` when it is not a genuine static
 * literal: a bare dynamic expression (`ref.agent`), OR a quoted value that
 * still contains `{...}` template interpolation (the corpus's own
 * placeholder convention, e.g. `model="{researcher_model}"` — and,
 * critically, `subagent_type: "gsd-{agent}"` in
 * gsd-core/references/universal-anti-patterns.md, a DOCUMENTATION template
 * illustrating the naming pattern, never a concrete role to resolve).
 * Fail-closed validation only ever runs on a genuine static literal; a
 * template/dynamic value still gets the full role-prompt-resolution
 * projection treatment (the resolve+fail-closed instruction applies equally
 * once a template is substituted at runtime) — only the STATIC CHECK is
 * skipped, never the projection itself.
 */
function _literalRoleValue(roleValueExpr) {
  const m = /^"([^"]*)"$/.exec(roleValueExpr);
  if (!m) return null;
  if (/[{}]/.test(m[1])) return null;
  return m[1];
}

/**
 * `maskStringLiterals` PLUS `#`-to-end-of-line comment blanking (comments are
 * never string literals, so they survive string-masking as literal `#...`
 * text). Header-token searches (subagent_type/model/run_in_background) must
 * use THIS mask, not the string-only one — verified necessary against the
 * real corpus: execute-phase.md's explanatory comment "# Only include
 * model= when executor_model is..." literally contains the substring
 * "model= when", which a comment-blind `model` regex mismatches as a real
 * `model=when` argument, corrupting the comment AND missing the real
 * `model="{executor_model}"` line beneath it. Scoped to call-span text only
 * (never the whole document), so markdown `#`/`##` headings elsewhere are
 * unaffected.
 */
function _maskStringsAndComments(text) {
  return maskStringLiterals(text).replace(/#[^\n]*/g, (m) => ' '.repeat(m.length));
}

/**
 * Normalize ONE `Agent(...)`/`Agent({...})` call span (already isolated by
 * `findDispatchCallSpans`) onto the target's real dispatch primitive. Every
 * behavioral branch reads `dispatch` (the runtime's sourced
 * `hostIntegration.dispatch` facts) — none is hardcoded. Handles all three
 * corpus call-argument shapes uniformly via string-aware token location
 * (`maskStringLiterals` recomputed after each structural edit, since prior
 * edits shift offsets).
 */
function _normalizeDispatchCallSpan(spanText, hasBraceWrapper, dispatch, toolConfig) {
  const namedDispatch = dispatch.namedDispatch === true;
  const backgroundCapable = dispatch.background === true;
  const canOrchestrate = dispatch.subagentToolkit === 'full'
    && (dispatch.maxDepth === -1 || (typeof dispatch.maxDepth === 'number' && dispatch.maxDepth > 1));
  const { toolName, backgroundParam, supportsPerCallModel, availableRoles, runtime } = toolConfig;

  let text = spanText;

  // 1. Named-role argument (subagent_type= / subagent_type:) — only when the
  //    target has no native named-agent lookup (dispatch.namedDispatch).
  //    Fail-closed validation runs on the extracted value REGARDLESS of
  //    which source syntax produced it (#2284 requirement 2).
  if (!namedDispatch) {
    const roleRe = _callArgValueRe('subagent_type');
    const rm = roleRe.exec(_maskStringsAndComments(text));
    if (rm) {
      // Read the VALUE from the original (unmasked) text at the matched
      // offset — `rm[1]` was captured against the mask, whose string
      // INTERIOR is blanked, so it must never be used as the real value.
      const roleValueExpr = text.slice(rm.index + rm[0].length - rm[1].length, rm.index + rm[0].length);
      const literalRole = _literalRoleValue(roleValueExpr);
      if (literalRole !== null) {
        _assertRoleResolvable(literalRole, availableRoles, runtime, 'subagent_type');
      } else if (!availableRoles) {
        // No literal value to check, but a null availableRoles still means
        // the shipped agents/ dir couldn't be resolved at all — fail closed
        // unconditionally rather than silently install an unverifiable call.
        _assertRoleResolvable('', availableRoles, runtime, 'subagent_type');
      }
      text = _projectRoleArgument(text, rm.index, rm.index + rm[0].length, roleValueExpr, toolConfig, canOrchestrate);
    }
  }

  // 2. Per-call model argument (model= / model:) — stripped entirely when the
  //    target has no per-call model-selection parameter (there is no
  //    `dispatch` axis for this — it is inherent tool vocabulary, like the
  //    parameter names themselves). Also removes now-dead explanatory
  //    comment lines directly above a `model=` line that owns its own line
  //    (#2284 Finding 5).
  if (!supportsPerCallModel) {
    const modelRe = _callArgValueRe('model');
    const mm = modelRe.exec(_maskStringsAndComments(text));
    if (mm) {
      text = _stripCallArgument(text, mm.index, mm.index + mm[0].length, { consumeLeadingComments: true });
    }
  }

  // 3. Background-dispatch flag (run_in_background= / run_in_background:) —
  //    maps onto the target's own background parameter ONLY when documented
  //    to support it; otherwise stripped rather than forwarding a parameter
  //    the primitive doesn't accept.
  {
    const bgRe = /\brun_in_background\s*[=:]\s*(?:true|false)/;
    const bm = bgRe.exec(_maskStringsAndComments(text));
    if (bm) {
      if (backgroundCapable) {
        const matched = text.slice(bm.index, bm.index + bm[0].length);
        const replaced = matched.replace(/^run_in_background(\s*[=:]\s*)/, `${backgroundParam}$1`);
        text = text.slice(0, bm.index) + replaced + text.slice(bm.index + bm[0].length);
      } else {
        text = _stripCallArgument(text, bm.index, bm.index + bm[0].length);
      }
    }
  }

  // 4. Call-syntax head rename + object-literal brace stripping. Hermes's
  //    delegate_task is a flat kwarg call — `Agent({...})`'s wrapper braces
  //    are dropped rather than carried through, so every projected call ends
  //    up in the same flat shape regardless of source syntax.
  text = text.replace(/^Agent\(/, `${toolName}(`);
  if (hasBraceWrapper) {
    const openMask = maskStringLiterals(text);
    const braceOpenIdx = openMask.indexOf('{');
    if (braceOpenIdx !== -1) text = text.slice(0, braceOpenIdx) + text.slice(braceOpenIdx + 1);
    const closeMask = maskStringLiterals(text);
    const braceCloseIdx = closeMask.lastIndexOf('}');
    if (braceCloseIdx !== -1) text = text.slice(0, braceCloseIdx) + text.slice(braceCloseIdx + 1);
  }

  return text;
}

/**
 * Blank the interior (and delimiters) of every string literal inside
 * `spanText` to spaces — same length, newlines preserved — using a fresh,
 * LOCAL quote-tracking scan that starts at `spanText[0]` with NO inherited
 * state. This is deliberately the SAME state-machine shape as the
 * `inString`/`\\`/triple-quote handling inside `findDispatchCallSpans`
 * (double-quoted and `"""`-triple-quoted, backslash-escape aware) — reused
 * here so a call span's quoted argument VALUES (documentation prose, prompt
 * bodies) never masquerade as real call syntax, without EVER falling back to
 * a whole-document cumulative quote-parity mask (the round-2 defect
 * documented on `findDispatchCallSpans` above).
 */
function _blankStringLiteralInteriors(spanText) {
  let out = '';
  let inString = null; // null | '"' | 'triple'
  for (let i = 0; i < spanText.length; i++) {
    const ch = spanText[i];
    if (inString) {
      if (ch === '\\') {
        out += ' ';
        i++;
        if (i < spanText.length) out += (spanText[i] === '\n') ? '\n' : ' ';
        continue;
      }
      if (inString === 'triple') {
        if (ch === '"' && spanText[i + 1] === '"' && spanText[i + 2] === '"') {
          inString = null;
          out += '   ';
          i += 2;
          continue;
        }
        out += (ch === '\n') ? '\n' : ' ';
        continue;
      }
      if (ch === inString) { inString = null; out += ' '; continue; }
      out += (ch === '\n') ? '\n' : ' ';
      continue;
    }
    if (ch === '"' && spanText[i + 1] === '"' && spanText[i + 2] === '"') {
      inString = 'triple';
      out += '   ';
      i += 2;
      continue;
    }
    if (ch === '"') { inString = '"'; out += ' '; continue; }
    out += ch;
  }
  return out;
}

/**
 * Quote-aware view of `content` for the completeness checks below: for every
 * REAL call span located via `findDispatchCallSpans` (once per head word in
 * `headWords`), the string-literal ARGUMENT VALUES inside that span are
 * blanked via `_blankStringLiteralInteriors`; the call's own head word and
 * bare (unquoted) argument tokens are left untouched. `headWords` is
 * processed in order and each pass re-scans the PROGRESSIVELY-masked string
 * — `toolName` first, then `'Agent'` — so a spurious `Agent(` that
 * `findDispatchCallSpans('Agent')` would otherwise "find" purely because it
 * sits inside an outer call's quoted string (e.g. a `description="...Agent()
 * ...subagent_type=x"` argument value) has ALREADY been blanked away by the
 * outer `toolName` pass by the time the `'Agent'` pass runs, so it is never
 * mistaken for a real, independent call. A genuinely real (unquoted) `Agent(`
 * — including one nested as a raw, un-renamed argument value — survives every
 * pass and remains visible to the caller's regex checks.
 */
function _maskQuotedRegionsWithinCallSpans(content, headWords) {
  let masked = content;
  for (const headWord of headWords) {
    const spans = findDispatchCallSpans(masked, headWord);
    for (let i = spans.length - 1; i >= 0; i--) {
      const { start, end } = spans[i];
      const maskedSpan = _blankStringLiteralInteriors(masked.slice(start, end));
      masked = masked.slice(0, start) + maskedSpan + masked.slice(end);
    }
  }
  return masked;
}

/**
 * Post-projection guard (#2284 requirement 3 — belt-and-suspenders): after
 * projection, assert the corpus form the projection could not anticipate
 * never silently ships. Throws an explicit install error (fail-LOUD) rather
 * than let an unprojected/incompletely-projected dispatch call install.
 *
 * #2284 round-2 CRITICAL fix: this is an INDEPENDENT check — it does NOT use
 * `maskStringLiterals` over the whole document (the round-1 primitive whose
 * cumulative, document-wide quote-parity tracking was the root cause of the
 * round-2 defect: a `"`-heavy bash fence upstream of a real call desynced
 * quote state and made `findDispatchCallSpans` blind to that call, shipping
 * a Frankenstein `Agent(gsd_role="...", model="...")` with no detection).
 *
 * #2284 round-3 fix: a BLUNT, mask-free literal check over the whole
 * document (round-2's fix) over-throws — it cannot tell a real residual
 * `Agent(`/`subagent_type` call from the SAME text appearing INSIDE a quoted
 * string (documentation/prompt prose, e.g. `description="...Agent()..."`).
 * The completeness checks (residual `subagent_type` / literal `Agent(`) now
 * run against `_maskQuotedRegionsWithinCallSpans` — quote-aware, but scoped
 * strictly to already-correctly-bounded, per-occurrence-LOCAL call spans
 * (never a whole-document cumulative mask), so a real Frankenstein call
 * (unquoted, real call syntax) still fires while a same-text mention genuinely
 * inside a quoted string does not.
 *
 * The completeness checks also only apply when `namedDispatch` is false: when
 * `dispatch.namedDispatch === true`, `_normalizeDispatchCallSpan` step 1
 * INTENTIONALLY leaves `subagent_type` unprojected (the target primitive
 * resolves named agents itself) — a residual `subagent_type` in that case is
 * the correct, intended output, not a defect. (The call HEAD is still renamed
 * unconditionally regardless of `namedDispatch` — see step 4 there — so a
 * literal `Agent(` residual is gated the same way purely for symmetry with
 * the dispatch-facts-driven contract; it is never actually left unrenamed by
 * the projection in practice.)
 *
 * The model-leak check is unaffected by either fix above — it is orthogonal
 * to `namedDispatch` (gated only by `supportsPerCallModel`) and already
 * bounds each real call via the independently-fixed, per-occurrence-local,
 * non-cumulative `findDispatchCallSpans`, then does a raw substring check
 * within that bound.
 */
function _assertProjectionComplete(content, toolConfig, namedDispatch = false) {
  const { toolName, runtime, supportsPerCallModel } = toolConfig;

  if (!namedDispatch) {
    const quoteAware = _maskQuotedRegionsWithinCallSpans(content, [toolName, 'Agent']);
    if (/\bsubagent_type\s*[=:]/.test(quoteAware)) {
      throw new Error(
        `${runtime} workflow install: projection left a residual subagent_type reference — refusing to install ` +
        '(fail-closed post-projection guard, #2284)',
      );
    }
    if (/\bAgent\(/.test(quoteAware)) {
      throw new Error(
        `${runtime} workflow install: projection left literal Agent( call syntax — refusing to install ` +
        '(fail-closed post-projection guard, #2284)',
      );
    }
  }

  if (!supportsPerCallModel) {
    for (const span of findDispatchCallSpans(content, toolName)) {
      const rawSpanText = content.slice(span.start, span.end);
      if (/\bmodel\s*[=:]/.test(rawSpanText)) {
        throw new Error(
          `${runtime} workflow install: projection left a leaked model= argument inside a ${toolName}(...) call ` +
          '— refusing to install (fail-closed post-projection guard, #2284)',
        );
      }
    }
  }
}

/**
 * Project host-neutral `Agent(...)` named-subagent dispatch prose onto a
 * target runtime's real dispatch primitive. See the file-header comment above
 * for the governing rule: every behavioral branch reads `dispatch` (the
 * runtime's sourced `hostIntegration.dispatch` facts) — none is a hardcoded
 * assumption about a specific runtime. Handles all three real corpus call
 * forms (multi-line one-key-per-line, single-line object-literal, single-line
 * compact) via string-aware call-span detection rather than three independent
 * line-anchored regexes, and closes with a post-projection guard that fails
 * loud on any form it did not anticipate (#2284).
 *
 * @param {string} content
 * @param {{namedDispatch?: boolean, nested?: boolean, maxDepth?: number, background?: boolean, backgroundDispatch?: boolean, subagentToolkit?: string}} dispatch
 * @param {{toolName: string, namedRoleParam: string, promptContentParam: string, structuralRoleParam: string, leafRoleValue: string, backgroundParam: string, supportsPerCallModel: boolean, availableRoles: Set<string>|null, runtime: string}} toolConfig
 */
function projectNamedDispatchToStructuralDelegate(content, dispatch, toolConfig) {
  const d = dispatch || {};
  const namedDispatch = d.namedDispatch === true;
  const backgroundCapable = d.background === true;
  const { toolName, promptContentParam } = toolConfig;

  let converted = content;

  // 1. The "Agent tool IS available" contract assertion (currently unique to
  //    plan-phase.md, matched generically in case of future reuse elsewhere).
  const assertionRe = /The Agent tool IS available in a top-level ([^\n]+?) session\.\s+Always spawn\s+([\s\S]*?)\s+as separate Agent\(\) calls\./;
  converted = converted.replace(assertionRe, (_m, sessionName, roster) => {
    const rosterFlat = roster.replace(/\s+/g, ' ').trim();
    if (namedDispatch) {
      return `The \`${toolName}\` tool IS available in a top-level ${sessionName} session. Always dispatch ${rosterFlat} as separate \`${toolName}()\` calls.`;
    }
    return (
      `${sessionName} has no \`Agent\` tool. It exposes \`${toolName}\`, which dispatches by structural role — ` +
      'it has no concept of a named subagent identity. GSD projects each named gsd-* role onto this primitive ' +
      `itself: resolve the role's prompt file from the active install, load its contents, and embed them in the ` +
      `\`${toolName}\` payload via \`${promptContentParam}\` as the dispatched task's operating instructions. ` +
      'FAIL CLOSED — surface an explicit error and stop — if a referenced role prompt cannot be resolved; never ' +
      `execute the role inline as a substitute. In a top-level ${sessionName} session, always dispatch ` +
      `${rosterFlat} as separate \`${toolName}\` calls.`
    );
  });

  // 1b. Dispatch-depth-availability prose immediately adjacent to a renamed
  //     `Agent()` mention in the SAME sentence (plan-review-convergence.md
  //     ~lines 108, 347, 355) — a bare "Agent" left un-renamed right next to
  //     the projection's own `Agent()`→`${toolName}()` rename produced
  //     self-contradictory installed text (e.g. "...delegate_task(...)...
  //     with Agent available..."). Narrowly scoped to the EXACT known
  //     phrases the projection itself creates the inconsistency beside —
  //     never a broad bare-word `Agent` rename, which would corrupt
  //     legitimate `Agent`-adjacent prose elsewhere in the corpus (role
  //     names, "Agent Brief", agent-file references).
  converted = converted.replace(
    /\borchestrator runs at depth 0 with Agent available\b/g,
    `orchestrator runs at depth 0 with ${toolName} available`,
  );
  converted = converted.replace(
    /\(bug #936: depth-1 Agent has no Agent tool\)/g,
    `(bug #936: depth-1 ${toolName} has no nested ${toolName})`,
  );

  // 2. Per-call model-selection prose ("Model resolution:" paragraph,
  //    execute-phase.md) + inline backtick-quoted model-mention prose
  //    examples (not live call sites) — only rewritten when the target
  //    primitive has no per-call model parameter at all.
  if (!toolConfig.supportsPerCallModel) {
    const modelResolutionRe = /\*\*Model resolution:\*\* If `executor_model` is `"inherit"`, omit the `model=` parameter from all `Agent\(\)` calls — do NOT pass `model="inherit"` to Agent\. Omitting the `model=` parameter causes [^.]+\. Only set `model=` when `executor_model` is an explicit model name \(e\.g\., `"claude-sonnet-5"`, `"claude-opus-4-8"`\)\./;
    converted = converted.replace(
      modelResolutionRe,
      `**Model resolution:** \`${toolName}\` has no per-call model-selection parameter — every dispatched role ` +
      `always inherits the host session's active model. Never pass \`model=\` to \`${toolName}\`; drop the ` +
      '`executor_model` value entirely for this runtime.',
    );
    converted = converted.replace(/`model="[^"`\n]*"`,?\s*(?:and\s+)?/g, '');
  }

  // 3. Background-dispatch PROSE mentions outside any real call span (e.g.
  //    execute-phase.md:595,600 — `run_in_background: true` inline
  //    documentation, not a call argument) — #2284 Finding 3. Only rewritten
  //    when the target is documented to support background dispatch (a
  //    prose mention of an unsupported capability would be equally
  //    misleading as a real leaked argument).
  if (backgroundCapable) {
    converted = converted.replace(
      /\brun_in_background(\s*[=:]\s*(?:true|false))/g,
      `${toolConfig.backgroundParam}$1`,
    );
  }

  // 4. Call-span-based normalization — the core of the fix. Every
  //    `Agent(...)`/`Agent({...})` occurrence (all three corpus forms) is
  //    located via string-aware balanced paren/brace matching, then
  //    normalized as a unit; spans are rebuilt right-to-left so earlier
  //    offsets stay valid while later ones are rewritten.
  const spans = findDispatchCallSpans(converted, 'Agent');
  for (let i = spans.length - 1; i >= 0; i--) {
    const { start, end, hasBraceWrapper } = spans[i];
    const rebuilt = _normalizeDispatchCallSpan(converted.slice(start, end), hasBraceWrapper, d, toolConfig);
    converted = converted.slice(0, start) + rebuilt + converted.slice(end);
  }

  // 5. "Agent tool" capability mentions (conditions gating parallel vs.
  //    sequential dispatch, e.g. map-codebase.md) → the real target primitive
  //    name, which resolves these conditions accurately since it IS a real,
  //    always-available dispatch primitive for this target.
  converted = converted.replace(/\bAgent tool\b/g, toolName);

  // 5b. Catch-all: a `subagent_type` mention that is NOT part of any real
  //     `Agent(...)` call span (e.g. map-codebase.md's inline documentation
  //     prose ``Use Agent tool with `subagent_type="X"`, ...`` — disconnected
  //     example syntax, not a live call). Renamed for the same accuracy the
  //     real calls get; a literal quoted role value is still fail-closed
  //     validated even though there is no call structure to inject
  //     role-prompt/fail-closed guidance INTO.
  if (!namedDispatch) {
    converted = converted.replace(
      /\bsubagent_type(\s*[=:]\s*"[^"]*")/g,
      (_m, rest) => {
        const literalRole = _literalRoleValue(rest.replace(/^\s*[=:]\s*/, ''));
        if (literalRole !== null) {
          _assertRoleResolvable(literalRole, toolConfig.availableRoles, toolConfig.runtime, 'subagent_type (prose mention)');
        }
        return `${toolConfig.namedRoleParam}${rest}`;
      },
    );
    converted = converted.replace(/\bsubagent_type(\s*[=:])/g, `${toolConfig.namedRoleParam}$1`);
  }

  // 5c. Safety net (#2284 requirement 2): the PRIMARY mechanism for
  //     eliminating literal `Agent(` syntax is complete span detection (step
  //     4) — this unconditional final rename exists only so that even a call
  //     span detection somehow misses at least loses its `Agent(` head
  //     rather than shipping the literal Claude-shaped tool name verbatim.
  //     A call caught only by this safety net is still INCOMPLETELY
  //     normalized (no role/model handling) and gets caught by the
  //     independent post-projection guard below via its OTHER invariants
  //     (residual subagent_type / leaked model=), which this safety net does
  //     not touch — the install still fails closed for a missed span.
  converted = converted.replace(/\bAgent\(/g, `${toolName}(`);

  // 6. Post-projection guard (#2284 requirement 3): fail loud, never ship
  //    silently, on any residual/leaked form the projection above did not
  //    anticipate. `namedDispatch` gates the completeness checks — a
  //    residual subagent_type is INTENTIONAL, not a defect, when the target
  //    resolves named agents itself (see `_assertProjectionComplete`).
  _assertProjectionComplete(converted, toolConfig, namedDispatch);

  return converted;
}

const HERMES_DISPATCH_TOOL_CONFIG = Object.freeze({
  toolName: 'delegate_task',
  namedRoleParam: 'gsd_role',
  promptContentParam: 'gsd_role_prompt',
  structuralRoleParam: 'role',
  leafRoleValue: 'leaf',
  backgroundParam: 'background',
  supportsPerCallModel: false,
});

/**
 * Hermes `.md` content converter (#2284): brand-swap (unchanged behavior,
 * descriptor-driven per `hostBehaviors.brandingRewrites`) followed by the
 * generic named-dispatch → `delegate_task` projection above, driven by
 * `capabilities/hermes/capability.json`'s `hostIntegration.dispatch` (read
 * via `_hostIntegrationDispatch`, values UNCHANGED by this fix — they are
 * already documentation-sourced and correct).
 */
function convertClaudeToHermesMarkdown(content, ctx) {
  const runtime = (ctx && ctx.runtime) || 'hermes';
  const b = _hostBehaviors(runtime).brandingRewrites;
  let converted = content;
  if (b) {
    converted = converted.replace(/CLAUDE\.md/g, b['CLAUDE.md']);
    // #2284(b): skips <runtime_compatibility> comparison-table content (protected region).
    converted = applyClaudeCodeBrandSwap(converted, b['Claude Code']);
    converted = converted.replace(/\.claude\//g, b['.claude/']);
  }
  const dispatch = _hostIntegrationDispatch(runtime);
  const toolConfig = Object.assign({}, HERMES_DISPATCH_TOOL_CONFIG, {
    availableRoles: _resolveAvailableGsdRoles(),
    runtime,
  });
  return projectNamedDispatchToStructuralDelegate(converted, dispatch, toolConfig);
}

// ── End Hermes converters ────────────────────────────────────────────────────

function convertSlashCommandsToCodexSkillMentions(content) {
  // Colon-style /gsd: never appears as a filesystem path segment, so no boundary guard is needed (unlike the hyphen-style below).
  let converted = content.replace(/\/gsd:([a-z0-9-]+)/gi, (_, commandName) => {
    return `$gsd-${String(commandName).toLowerCase()}`;
  });
  // Convert hyphen-style command references (workflow output) to Codex $ prefix.
  // A real /gsd-<cmd> MENTION is defined positively by two boundaries, so any
  // in-path occurrence is excluded by construction (no denylist of preceding
  // chars to maintain — see #712, supersedes the #637/#704 lookbehind treadmill):
  //   1. Left boundary: opens at start-of-string, whitespace, or an inline-prose
  //      delimiter (backtick/quote/paren/bracket) — e.g. `/gsd-execute-phase`.
  //   2. Right boundary: the command token is NOT followed by a path separator
  //      `/` (a path continues: `/gsd-core/bin/...`; a command does not). The
  //      `(?![a-z0-9/-])` also blocks regex backtracking to a shorter command.
  // This converts backtick-wrapped MENTIONS (`/gsd-foo`) while leaving backtick-
  // wrapped PATHS (`/gsd-core/workflows/update.md`) untouched (#712).
  converted = converted.replace(/(?<=^|[\s`"'([])\/gsd-([a-z0-9-]+)(?![a-z0-9/-])/gi, (_, commandName) => {
    return `$gsd-${String(commandName).toLowerCase()}`;
  });
  return converted;
}

const CODEX_GSD_TOOLS_INVOCATION = 'node "$HOME/.codex/gsd-core/bin/gsd-tools.cjs"';

function rewriteBareGsdToolsCommandsForCodex(content) {
  return content
    .replace(/(^[ \t]*)gsd-tools(?=\s)/gm, `$1${CODEX_GSD_TOOLS_INVOCATION}`)
    .replace(/(\$\(\s*)gsd-tools(?=\s)/g, `$1${CODEX_GSD_TOOLS_INVOCATION}`)
    .replace(/(`\s*)gsd-tools(?=\s)/g, `$1${CODEX_GSD_TOOLS_INVOCATION}`)
    .replace(/((?:&&|\|\||[;|])\s*)gsd-tools(?=\s)/g, `$1${CODEX_GSD_TOOLS_INVOCATION}`);
}

function convertClaudeToCodexMarkdown(content) {
  let converted = convertSlashCommandsToCodexSkillMentions(content);
  converted = converted.replace(/\$ARGUMENTS\b/g, '{{GSD_ARGS}}');
  // Remove /clear references — Codex has no equivalent command
  // Handle backtick-wrapped: `\/clear` then: → (removed)
  converted = converted.replace(/`\/clear`\s*,?\s*then:?\s*\n?/gi, '');
  // Handle bare: /clear then: → (removed)
  converted = converted.replace(/\/clear\s*,?\s*then:?\s*\n?/gi, '');
  // Handle standalone /clear on its own line
  converted = converted.replace(/^\s*`?\/clear`?\s*$/gm, '');
  // Path replacement: .claude → .codex (#1430)
  converted = converted.replace(/\$HOME\/\.claude\//g, '$HOME/.codex/');
  converted = converted.replace(/~\/\.claude\//g, '~/.codex/');
  converted = converted.replace(/\.\/\.claude\//g, './.codex/');
  // Bare ~/.claude without trailing slash (e.g. configDir = ~/.claude)
  converted = converted.replace(/\$HOME\/\.claude\b/g, '$HOME/.codex');
  converted = converted.replace(/~\/\.claude\b/g, '~/.codex');
  // Bare/project-relative .claude/... references (#2639). Covers strings like
  // "check `.claude/skills/`" where there is no ~/, $HOME/, or ./ anchor.
  // Negative lookbehind prevents double-replacing already-anchored forms and
  // avoids matching inside URLs or other slash-prefixed paths.
  converted = converted.replace(/(?<![A-Za-z0-9_\-./~$])\.claude\//g, '.codex/');
  // `.claudeignore` → `.codexignore` (#2639). Codex honors its own ignore
  // file; leaving the Claude-specific name is misleading in agent prompts.
  converted = converted.replace(/\.claudeignore\b/g, '.codexignore');
  // Codex installs the tools shim under ~/.codex but does not guarantee a
  // bare `gsd-tools` binary on PATH. Keep resolver probes such as
  // `command -v gsd-tools` intact; rewrite only command invocations.
  converted = rewriteBareGsdToolsCommandsForCodex(converted);
  // Runtime-neutral agent name replacement (#766)
  converted = neutralizeAgentReferences(converted, 'AGENTS.md');
  return converted;
}

function getCodexSkillAdapterHeader(skillName) {
  const invocation = `$${skillName}`;
  return `<codex_skill_adapter>
## A. Skill Invocation
- This skill is invoked by mentioning \`${invocation}\`.
- Treat all user text after \`${invocation}\` as \`{{GSD_ARGS}}\`.
- If no arguments are present, treat \`{{GSD_ARGS}}\` as empty.

## B. AskUserQuestion → request_user_input Mapping
GSD workflows use \`AskUserQuestion\` (Claude Code syntax). Translate to Codex \`request_user_input\`:

Parameter mapping:
- \`header\` → \`header\`
- \`question\` → \`question\`
- Options formatted as \`"Label" — description\` → \`{label: "Label", description: "description"}\`
- Generate \`id\` from header: lowercase, replace spaces with underscores

Batched calls:
- \`AskUserQuestion([q1, q2])\` → single \`request_user_input\` with multiple entries in \`questions[]\`

Multi-select workaround:
- Codex has no \`multiSelect\`. Use sequential single-selects, or present a numbered freeform list asking the user to enter comma-separated numbers.

Execute mode fallback:
- When \`request_user_input\` is rejected or unavailable, activate TEXT_MODE: append \`--text\` to \`{{GSD_ARGS}}\` so the workflow's built-in text-mode branching takes over. Present every \`AskUserQuestion\` call as a plain-text numbered list, then stop and wait for the user's reply. Do NOT pick a default and continue (#3018 / #3808).
- You may only proceed without a user answer when one of these is true:
  (a) the invocation included an explicit non-interactive flag (\`--auto\` or \`--all\`),
  (b) the user has explicitly approved a specific default for this question, or
  (c) the workflow's documented contract says defaults are safe (e.g. autonomous lifecycle paths).
- Do NOT write workflow artifacts (CONTEXT.md, DISCUSSION-LOG.md, PLAN.md, checkpoint files) until the user has answered the plain-text questions or one of (a)-(c) above applies. Surfacing the questions and waiting is the correct response — silently defaulting and writing artifacts is the #3018 failure mode.

## C. Task() → spawn_agent Mapping
GSD workflows use \`Task(...)\` (Claude Code syntax). Translate to Codex collaboration tools:

**Schema detection (required first step):** Codex exposes two \`spawn_agent\` schemas:
- **agent_type-capable schema** (e.g. \`multi_agent_v2\`): \`spawn_agent\` accepts \`agent_type\`, \`message\`, \`reasoning_effort\`, \`fork_context\`, etc. — typed GSD agent dispatch is available.
- **Generic schema** (\`multi_agent_v1\`): \`spawn_agent\` accepts only \`message\`, \`items\`, \`fork_context\` — there is **no \`agent_type\` field**. Typed GSD agent dispatch is unavailable in this session.

Before spawning, inspect the \`spawn_agent\` tool's visible parameter schema (via \`tool_search\` or the tool list) to determine which form is active.

Typed mapping (agent_type-capable schema only):
- \`Task(subagent_type="X", prompt="Y")\` → \`spawn_agent(agent_type="X", message="Y")\`
- \`Agent(subagent_type="X", prompt="Y")\` → \`spawn_agent(agent_type="X", message="Y")\`
- \`Task(model="...")\` → omit. \`spawn_agent\` has no inline \`model\` parameter;
  GSD embeds the resolved per-agent model directly into each agent's \`.toml\`
  at install time so \`model_overrides\` from \`.planning/config.json\` and
  \`~/.gsd/defaults.json\` are honored automatically by Codex's agent router.
- Resolved \`reasoning_effort="low|medium|high|xhigh"\` (\`xhigh\` is a GSD/Codex tier, not a generic runtime enum) → pass \`reasoning_effort\`
  to \`spawn_agent\` when the runtime/tool supports it. Omit missing, empty,
  inherited, or unsupported values; do not invent one-off effort literals in
  workflow prose.
- \`fork_context: false\` by default — GSD agents load their own context via \`<required_reading>\` blocks
- \`task_name\` — required by the collaboration schema; provide a descriptive name for each spawned task
- \`fork_turns\` — optional parameter controlling turn-forking depth; coexists with \`fork_context\` (not a replacement)
- \`Task(isolation="worktree")\` / \`Agent(isolation="worktree")\` → no direct \`spawn_agent\` mapping,
  but Codex declares \`dispatch.isolation: orchestrator-worktree\` (#2584). Codex
  \`spawn_agent\` still does not create or bind a git worktree; instead GSD itself
  creates the worktree and process-spawns the executor into it with
  \`codex exec --cd <dir>\`, performing every git operation on the executor's behalf
  (its \`workspace-write\` sandbox makes \`.git\` read-only). Workflows must therefore
  never fabricate a manual worktree protocol — route through the negotiated
  isolation adapter, which still fails closed for hosts declaring \`none\` (#3360).

Generic-agent workaround (multi_agent_v1 schema — NO agent_type field):
When only the generic \`multi_agent_v1\` schema is available, typed GSD agent dispatch
(\`gsd-planner\`, \`gsd-executor\`, etc.) is NOT possible. This is a known Codex limitation
(openai/codex#15250). **This workaround is NOT equivalent to typed gsd-planner/gsd-executor
execution** — GSD agents carry project-aware prompts, audit logging, and workflow context
that a generic subagent lacks. Use the following fallback:
1. Resolve your active Codex config root — the directory that contains your \`config.toml\`.
   This directory is determined in priority order: \`$CODEX_HOME\` (if set), the path given
   by \`--config-dir\` (if passed on invocation), a local \`.codex\` directory in the current
   project (if \`--local\` was used), or the default global config directory. Read
   \`agents/<agent-name>.toml\` relative to that config root to extract the agent's system
   instructions.
2. Inject those instructions as a role-preamble into a generic \`spawn_agent(message=...)\` call.
3. Label results and logs clearly as "generic-agent workaround" so the orchestrator and user
   know full typed-agent guarantees are not in effect.
4. Where typed dispatch is mandatory for correctness (e.g. worktree isolation), fail closed
   and report the schema limitation rather than silently degrading.

Spawn restriction:
- Codex restricts \`spawn_agent\` to cases where the user has explicitly
  requested sub-agents. When automatic spawning is not permitted, do the
  work inline in the current agent rather than attempting to force a spawn.
- In some Codex sessions, multi-agent tooling can be deferred. If \`spawn_agent\`
  is not currently visible, discover tools first via \`tool_search\` before
  defaulting to inline execution.

Parallel fan-out:
- Spawn multiple agents → collect agent IDs → \`collaboration.wait_agent(timeout_ms=...)\` for each to complete
- Do NOT use \`functions.wait(cell_id=...)\` — that is an unrelated exec-cell tool, not the collaboration wait

Result parsing:
- Look for structured markers in agent output: \`CHECKPOINT\`, \`PLAN COMPLETE\`, \`SUMMARY\`, etc.
- \`close_agent(id)\` after collecting results — but only if \`close_agent\` is visible in the current
  tool schema (check via \`tool_search\` first, same schema-detection gate as \`spawn_agent\` above)
</codex_skill_adapter>`;
}

function convertClaudeCommandToCodexSkill(content, skillName) {
  const converted = convertClaudeToCodexMarkdown(content);
  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  let description = `Run GSD workflow ${skillName}.`;
  if (frontmatter) {
    const maybeDescription = extractFrontmatterField(frontmatter, 'description');
    if (maybeDescription) {
      description = maybeDescription;
    }
  }
  description = toSingleLine(description);
  const shortDescription = description.length > 180 ? `${description.slice(0, 177)}...` : description;
  const adapter = getCodexSkillAdapterHeader(skillName);

  return `---\nname: ${yamlQuote(skillName)}\ndescription: ${yamlQuote(description)}\nmetadata:\n  short-description: ${yamlQuote(shortDescription)}\n---\n\n${adapter}\n\n${body.trimStart()}`;
}

/**
 * Convert Claude Code agent markdown to Codex agent format.
 * Applies base markdown conversions, then adds a <codex_agent_role> header
 * and cleans up frontmatter (removes tools/color fields).
 */
function convertClaudeAgentToCodexAgent(content) {
  let converted = convertClaudeToCodexMarkdown(content);

  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  if (!frontmatter) return converted;

  const name = extractFrontmatterField(frontmatter, 'name') || 'unknown';
  const description = extractFrontmatterField(frontmatter, 'description') || '';
  const tools = extractFrontmatterField(frontmatter, 'tools') || '';

  const roleHeader = `<codex_agent_role>
role: ${name}
tools: ${tools}
purpose: ${toSingleLine(description)}
</codex_agent_role>`;

  const cleanFrontmatter = `---\nname: ${yamlQuote(name)}\ndescription: ${yamlQuote(toSingleLine(description))}\n---`;

  return `${cleanFrontmatter}\n\n${roleHeader}\n${body}`;
}

/**
 * #2310 — True if `model` is an Anthropic-flavored value that must never appear as a
 * Codex agent `.toml` `model`. Two forms: (a) a bare Claude Agent-tool tier alias
 * (opus/sonnet/haiku/fable — the canonical CLAUDE_AGENT_ALIASES); (b) any Claude model
 * id in any provider namespacing — `claude-*`, `anthropic/claude-*`, `us.anthropic.claude-*`
 * (the forms the catalog assigns to opencode/hermes/kilo, reachable on a Codex .toml via
 * the runtime-resolver path). No OpenAI/Codex model id contains "claude", so a
 * case-insensitive substring test is a safe, exhaustive guard for (b). Codex/ChatGPT
 * rejects all of these.
 *
 * #3241 — thin delegation to the shared predicate on src/model-catalog.cts (moved there
 * so it can't diverge across Codex-posture surfaces); kept as a local name because it
 * reads better at the call sites below.
 */
function _isAnthropicFlavoredModel(model) {
  return gsdIsAnthropicFlavoredModel(model);
}

// #2310 — dedupe stderr warnings so repeated agent emits don't spam (mirrors the
// #2041/#1133 model-resolver warn-dedupe). Value is length-capped so an oversized
// or secret-shaped override cannot leak in full to logs.
const _codexModelOverrideDroppedWarned = new Set();
function _warnCodexModelOverrideDropped(agentName, value) {
  const key = `${agentName}::${value}`;
  if (_codexModelOverrideDroppedWarned.has(key)) return;
  _codexModelOverrideDroppedWarned.add(key);
  const safe = String(value).length > 64 ? `${String(value).slice(0, 64)}…` : String(value);
  process.stderr.write(
    `gsd: warning — Codex agent "${agentName}" model "${safe}" is not a valid Codex model ` +
    `(Anthropic alias/id); dropping it so Codex uses a valid default. ` +
    `Set runtime:"codex" or pin a gpt-* model to route it.\n`,
  );
}

// #3241 — one-time per-install deprecation notice: the automatic runtime-resolver
// per-tier Codex model embed was removed (D1/D5, ADR-2313 passive-posture epic). When
// the resolver *would have* supplied a model and nothing else ends up pinned, this
// notice points the user at model_overrides as the explicit-pin replacement. Dedupes
// with a module-level boolean (mirrors _codexModelOverrideDroppedWarned's Set above)
// so a multi-agent install — every Codex agent hits this condition simultaneously —
// emits exactly one line, not one per agent. Reset once per install() call (see
// install()) so the "at most once" window is per-install, not per-process. That
// reset lives ONLY inside install() (~:10116) — generateCodexAgentToml is also
// exported standalone (~:13460), and a caller invoking it directly/repeatedly
// outside install() gets process-lifetime dedupe instead of per-install. No
// current test depends on the standalone caller's dedupe window.
let _codexResolverModelOmittedWarned = false;
function _warnCodexResolverModelOmitted() {
  if (_codexResolverModelOmittedWarned) return;
  _codexResolverModelOmittedWarned = true;
  process.stderr.write(
    'gsd: notice — Codex agents no longer auto-pin a per-tier model from the runtime ' +
    'resolver; set model_overrides for an agent if you want a specific Codex model ' +
    'instead of the session model.\n',
  );
}

// Test seam only — bin/install.js deliberately keeps per-install warning/notice
// dedupe in module scope (both the _codexModelOverrideDroppedWarned Set above and
// the _codexResolverModelOmittedWarned boolean; install() resets the latter at
// ~:10116). A unit test that drives generateCodexAgentToml() directly, without
// going through install(), has no other way to reset either store between
// assertions without busting the require.cache (which breaks module-instance
// sharing with the rest of the suite). This is the single sanctioned way for a
// unit test to clear both dedupe stores — exported so tests can call it instead.
function _resetCodexWarningDedupeForTests() {
  _codexModelOverrideDroppedWarned.clear();
  _codexResolverModelOmittedWarned = false;
}

/**
 * Generate a per-agent .toml config file for Codex.
 * Sets required agent metadata, sandbox_mode, and developer_instructions
 * from the agent markdown content.
 *
 * @param {string} agentName
 * @param {string} agentContent
 * @param {object|null} modelOverrides
 * @param {object|null} runtimeResolver  — runtime-aware tier resolver from readGsdRuntimeProfileResolver
 * @param {object|null} effortCfg        — #443: merged effort config from readGsdEffectiveEffortConfig
 */
function generateCodexAgentToml(agentName, agentContent, modelOverrides = null, runtimeResolver = null, effortCfg = null, sandboxTier = 'codex-agent-sandbox') {
  const sandboxMode = CODEX_AGENT_SANDBOX[agentName] || 'read-only';
  const { frontmatter, body } = extractFrontmatterAndBody(agentContent);
  const frontmatterText = frontmatter || '';
  const resolvedName = extractFrontmatterField(frontmatterText, 'name') || agentName;
  const resolvedDescription = toSingleLine(
    extractFrontmatterField(frontmatterText, 'description') || `GSD agent ${resolvedName}`
  );
  const instructions = body.trim();

  const lines = [
    `name = ${JSON.stringify(resolvedName)}`,
    `description = ${JSON.stringify(resolvedDescription)}`,
  ];
  if (sandboxTier != null && sandboxTier !== 'none') {
    lines.push(`sandbox_mode = "${sandboxMode}"`);
  }

  // Embed model override when configured in ~/.gsd/defaults.json so that
  // model_overrides is respected on Codex (which uses static TOML, not inline
  // Task() model parameters). See #2256.
  // #2310 — a Codex .toml `model` MUST be a real Codex/OpenAI model id. Codex is a
  // passive/session-only model host (ADR-1239): GSD cannot reliably route per-agent
  // tiers, and a bare GSD/Claude tier alias (opus/sonnet/haiku/fable) or a claude-*
  // id 400s on a ChatGPT-account Codex ("The 'sonnet' model is not supported when
  // using Codex with a ChatGPT account"). So: embed ONLY an explicit real-Codex
  // model pin from model_overrides; omit anything Anthropic-flavored so the agent
  // inherits the always-available session model.
  // #3241 (D1/D5) — the runtime-aware tier-resolver auto-embed that used to fall
  // through here when model_overrides had nothing was removed: Codex is passive by
  // default now, and only an explicit model_overrides pin survives. See the
  // deprecation-notice block below for the population that used to get a pin from
  // the resolver and no longer does.
  const rawModelOverride = modelOverrides?.[resolvedName] || modelOverrides?.[agentName];
  let pinnedModel = null;
  if (rawModelOverride) {
    // Trim before the truthiness test (#3241 defect fix): a whitespace-only value
    // (e.g. '   ') is a truthy JS string but not a model id — it must not be
    // embedded verbatim (`model = "   "`, a live pre-fix defect) or routed to
    // _warnCodexModelOverrideDropped, whose "is not a valid Codex model
    // (Anthropic alias/id)" text would misdescribe a blank config field. It is
    // silently dropped, matching how '' already behaves (no pin, no warning).
    const trimmedOverride = typeof rawModelOverride === 'string' ? rawModelOverride.trim() : rawModelOverride;
    if (typeof trimmedOverride === 'string' && trimmedOverride && !_isAnthropicFlavoredModel(trimmedOverride)) {
      pinnedModel = trimmedOverride;   // explicit real-Codex model pin → embed verbatim (#2256)
    } else if (typeof rawModelOverride === 'string' && trimmedOverride === '') {
      // whitespace-only override — no pin, no warning (#3241).
    } else {
      _warnCodexModelOverrideDropped(resolvedName, rawModelOverride);   // alias/claude-* → omit
    }
  }
  // #2310 — final safety gate: never emit an Anthropic-flavored model into a Codex
  // .toml, even one that reached here through some other path than the override
  // check above.
  if (pinnedModel && _isAnthropicFlavoredModel(pinnedModel)) {
    _warnCodexModelOverrideDropped(resolvedName, pinnedModel);
    pinnedModel = null;
  }
  // #3241 — one-time deprecation notice: if nothing ends up pinned but the
  // runtime resolver would have supplied a per-tier model that would actually
  // have been EMBEDDED (the population that loses a pin now that the
  // auto-embed above is gone), point the user at model_overrides. The would-be
  // model must also clear the #2310 Anthropic-flavored gate above — if it
  // wouldn't have survived that gate, the user never had that pin pre-Phase-1
  // either, and the notice would be false. Never fires when the resolver is
  // null, resolves to nothing, resolves to an Anthropic-flavored model, or an
  // explicit real-Codex pin survived — in all of those cases nothing was lost.
  if (!pinnedModel && runtimeResolver) {
    const wouldHavePinned = runtimeResolver.resolve(resolvedName) || runtimeResolver.resolve(agentName);
    if (wouldHavePinned?.model && !_isAnthropicFlavoredModel(wouldHavePinned.model)) {
      _warnCodexResolverModelOmitted();
    }
  }
  let hasPinnedModel = false;
  if (pinnedModel) {
    lines.push(`model = ${JSON.stringify(pinnedModel)}`);
    hasPinnedModel = true;
    // model is resolved here; reasoning_effort from catalog tier is REPLACED by the
    // unified effort resolver below (#443). Do NOT emit entry.reasoning_effort here.
  }

  // #443 — Unified effort for Codex .toml. Uses the same config-driven precedence chain
  // as the Claude .md effort injection (resolveInstallTimeEffort), so both runtimes read
  // from the same effort.agent_overrides / effort.routing_tier_defaults / effort.default
  // config source. #3007 — Codex advertises supported_reasoning_levels per model, so the
  // pinned model id is passed through and the value is resolved against that model's own
  // set: 'max' now passes, 'minimal' clamps up to 'low', and 'ultra' is refused (no key
  // emitted) rather than clamped to a fabricated level.
  // #838 — Do not pin effort when Codex is intentionally inheriting the parent
  // chat model. A TOML with no `model` but a static `model_reasoning_effort`
  // creates confusing partial routing: model follows the Codex UI while effort
  // follows GSD. Keep those knobs coupled unless GSD also pins the model.
  if (hasPinnedModel) {
    const _universalEffortCodex = resolveInstallTimeEffort(effortCfg, resolvedName !== agentName ? resolvedName : agentName);
    // #3533 (10d): 'inherit' means OMIT the pin — the agent follows the host's
    // own effort default. Never write the literal.
    if (_universalEffortCodex !== 'inherit') {
      const _renderedEffortCodex = _getGsdEffortCatalog().renderEffortForRuntime('codex', _universalEffortCodex, pinnedModel).value;
      // #3007 — 'ultra' is rejected by the model's supported_reasoning_levels and
      // renders as null. Omit the key entirely rather than write a literal `null`.
      if (_renderedEffortCodex !== null) {
        lines.push(`model_reasoning_effort = ${JSON.stringify(_renderedEffortCodex)}`);
      }
    }
  }

  // #774 — Emit service_tier and model_verbosity for light-tier agents.
  // Light-tier agents (routingTier: "light" in model-catalog.json) are haiku-equivalent
  // and benefit from Codex's "flex" service tier (lower cost, background processing)
  // and "low" verbosity (reduced token output). Both fields are validated against the
  // Codex ConfigProfile schema (codex-rs/config/src/profile_toml.rs):
  //   service_tier: Option<String>  — "flex" | "fast" (legacy)
  //   model_verbosity: Option<Verbosity> — "low" | "medium" | "high"
  const { AGENT_DEFAULT_TIERS: _agentTiers } = _getGsdEffortCatalog();
  const _agentRoutingTier = _agentTiers?.[resolvedName] || _agentTiers?.[agentName];
  if (_agentRoutingTier === 'light') {
    lines.push(`service_tier = "flex"`);
    lines.push(`model_verbosity = "low"`);
  }

  // Agent prompts contain raw backslashes in regexes and shell snippets.
  // TOML literal multiline strings preserve them without escape parsing.
  lines.push(`developer_instructions = '''`);
  lines.push(instructions);
  lines.push(`'''`);

  return lines.join('\n') + '\n';
}

/**
 * Remove stale agents/openai.yaml sidecar files from GSD-managed Codex skill dirs.
 *
 * Prior to #1326, GSD's Codex install path wrote an agents/openai.yaml file
 * alongside each gsd-* SKILL.md. Recent Codex builds index BOTH SKILL.md and
 * the sidecar, causing each GSD skill to appear twice in autocomplete. This
 * function removes those stale sidecars and — if the agents/ subdirectory is
 * now empty — prunes it too.
 *
 * Behaviour:
 *   - Returns immediately if skillsDir does not exist (fails open).
 *   - Only touches directories whose names start with "gsd-".
 *   - Skips user-owned dirs (gsd-dev-preferences) — their agents/ content is
 *     never modified, mirroring the same USER_OWNED_SKILL_DIRS guard used by
 *     installOpencodeFamilySkills.
 *   - For each managed gsd-* dir, if agents/openai.yaml exists, deletes it.
 *   - If agents/ is now empty, removes the directory; if it still contains
 *     other files (e.g. user-added content), leaves it in place.
 *   - Non-gsd-* dirs and their agents/ content are never touched.
 *   - Individual failures are caught and swallowed so a single bad dir cannot
 *     block the install (fail-open, matching the original design).
 *
 * @param {string} skillsDir - Path to the skills/ directory (e.g. ~/.codex/skills)
 */
function cleanupCodexSkillMetadataSidecars(skillsDir) {
  if (!fs.existsSync(skillsDir)) return;
  // Mirror the user-owned list from installOpencodeFamilySkills (#2973).
  // We MUST skip these dirs — their contents are user-generated and must
  // never be modified by GSD's install path.
  const _userOwnedSkillDirs = new Set(['gsd-dev-preferences']);
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('gsd-')) continue;
    if (_userOwnedSkillDirs.has(entry.name)) continue; // preserve user content
    const agentsSubdir = path.join(skillsDir, entry.name, 'agents');
    const sidecarPath = path.join(agentsSubdir, 'openai.yaml');
    try {
      // Symlink guard: if agents/ is a symlink pointing outside the skills tree,
      // deleting through it could escape the tree. Skip this dir entirely.
      let agentsStat;
      try { agentsStat = fs.lstatSync(agentsSubdir); } catch (_e) { continue; }
      if (agentsStat.isSymbolicLink()) continue;
      if (fs.existsSync(sidecarPath)) {
        fs.rmSync(sidecarPath);
      }
      // Prune the agents/ dir only if it is now empty (leave it if other files remain).
      if (fs.existsSync(agentsSubdir) && fs.readdirSync(agentsSubdir).length === 0) {
        fs.rmdirSync(agentsSubdir);
      }
    } catch (_err) {
      // Fail open — a single bad dir must not block the install.
    }
  }
}

/**
 * Remove legacy Windsurf skill artifacts from .devin/skills/gsd- directories.
 *
 * Pre-#1615 Windsurf installs wrote skills under .devin/ (Devin Desktop
 * preferred dir, #1085). #1615 moved Windsurf to .windsurf/workflows/.
 * Old .devin/skills/gsd- dirs linger on disk indefinitely and confuse
 * users who see two GSD trees.
 *
 * Preserves user-owned content:
 *   - non-gsd-* dirs under .devin/skills/ (user-authored skills)
 *   - gsd-dev-preferences/ (user-owned per #2973)
 *   - any files (not dirs) under .devin/skills/
 *
 * @param {string} workspaceDir - workspace root (process.cwd() for local installs)
 * @returns {number} count of removed legacy gsd-* skill directories
 */
function cleanupWindsurfLegacyDevinSkills(workspaceDir) {
  const legacySkillsDir = path.join(workspaceDir, '.devin', 'skills');
  if (!fs.existsSync(legacySkillsDir)) return 0;

  // Mirror the user-owned list from cleanupCodexSkillMetadataSidecars (#2973).
  const _userOwnedSkillDirs = new Set(['gsd-dev-preferences']);
  let removed = 0;

  for (const entry of fs.readdirSync(legacySkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('gsd-')) continue;
    if (_userOwnedSkillDirs.has(entry.name)) continue;

    const dirToRemove = path.join(legacySkillsDir, entry.name);
    try {
      // Symlink guard: if the gsd-* dir is itself a symlink pointing outside
      // the .devin tree, deleting through it could escape the tree. Skip.
      const stat = fs.lstatSync(dirToRemove);
      if (stat.isSymbolicLink()) continue;

      fs.rmSync(dirToRemove, { recursive: true, force: true });
      removed++;
    } catch (_err) {
      // Fail open — a single bad dir must not block the install.
    }
  }

  // If .devin/skills/ is now empty, prune it. If .devin/ itself is then empty,
  // prune that too — leaves the workspace clean for the new .windsurf/ layout.
  // Never remove non-empty containers (user may have other Devin content).
  try {
    if (fs.existsSync(legacySkillsDir) && fs.readdirSync(legacySkillsDir).length === 0) {
      fs.rmdirSync(legacySkillsDir);
      const devinDir = path.join(workspaceDir, '.devin');
      if (fs.existsSync(devinDir) && fs.readdirSync(devinDir).length === 0) {
        fs.rmdirSync(devinDir);
      }
    }
  } catch (_err) {
    // best-effort container cleanup
  }

  return removed;
}

/**
 * Migrate a skills kind that moved to an alternate `home` (ADR-1239 split-home):
 * remove now-stale `<prefix>*` skill dirs left at the OLD configDir-rooted
 * location by installs from before the move. Without this, upgrading (e.g. Codex
 * relocating skills to ~/.agents/skills) orphans the pre-move dirs at
 * ~/.codex/skills. Only managed `<prefix>*` dirs are touched; user-owned content
 * (non-prefixed dirs, gsd-dev-preferences, symlinks) is preserved. Fail-open.
 * @param {string} oldSkillsDir absolute path to the pre-move skills location
 * @param {string} prefix managed skill-dir prefix (e.g. 'gsd-')
 * @returns {number} count of stale dirs removed
 */
function cleanupMovedSkillsOldLocation(oldSkillsDir, prefix) {
  if (!fs.existsSync(oldSkillsDir)) return 0;

  // Mirror the user-owned list from cleanupCodexSkillMetadataSidecars (#2973).
  const _userOwnedSkillDirs = new Set(['gsd-dev-preferences']);
  let removed = 0;

  for (const entry of fs.readdirSync(oldSkillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    if (_userOwnedSkillDirs.has(entry.name)) continue;

    const dirToRemove = path.join(oldSkillsDir, entry.name);
    try {
      // Symlink guard (mirrors cleanupWindsurfLegacyDevinSkills): never delete
      // through a symlinked gsd-* dir — it could escape the tree.
      const stat = fs.lstatSync(dirToRemove);
      if (stat.isSymbolicLink()) continue;

      fs.rmSync(dirToRemove, { recursive: true, force: true });
      removed++;
    } catch (_err) {
      // Fail open — a single bad dir must not block install/uninstall.
    }
  }

  // Prune the old skills dir if now empty — leaves the configHome clean.
  // Never remove a non-empty container (user may keep other content there).
  try {
    if (fs.existsSync(oldSkillsDir) && fs.readdirSync(oldSkillsDir).length === 0) {
      fs.rmdirSync(oldSkillsDir);
    }
  } catch (_err) {
    // best-effort container cleanup
  }

  return removed;
}

/**
 * When a runtime's skills kind declares an alternate `home` (split-home move),
 * return the now-stale configDir-rooted skills location that installs before the
 * move used; null when no move is in effect (no home override, or home resolves
 * to the same path). Descriptor-driven — no per-runtime hardcoding.
 * @returns {string|null}
 */
function _resolveMovedSkillsOldDir(runtime, targetDir, scope) {
  try {
    const layout = resolveRuntimeArtifactLayout(runtime, targetDir, scope);
    const skillsKind = layout.kinds.find((k) => k.kind === 'skills');
    if (skillsKind && skillsKind.home) {
      const oldDir = path.join(targetDir, skillsKind.destSubpath);
      const newDir = path.join(skillsKind.home, skillsKind.destSubpath);
      if (path.resolve(oldDir) !== path.resolve(newDir)) return oldDir;
    }
  } catch (_e) {
    // No migration when the layout can't resolve — never block on this.
  }
  return null;
}

/**
 * Generate the GSD config block for Codex config.toml.
 *
 * #2406 — standalone per-agent TOMLs (written by installCodexConfig to
 * `$CODEX_HOME/agents/<name>.toml`) are auto-discovered by Codex and are the
 * SOLE canonical registration source for each role. This block therefore no
 * longer emits `[agents.<name>]` role tables that point `config_file` back at
 * those same standalone TOMLs — that was a second, redundant declaration of
 * the same role in one config layer, and Codex logged "Ignoring malformed
 * agent role definition: duplicate agent role name" once per agent as a
 * result. Only the bare `[agents]` dispatch-tuning scalar table is emitted
 * here; role name/description/model/reasoning-effort/sandbox settings remain
 * fully discoverable through the standalone TOML alone.
 * @param {Array<{name: string, description: string}>} _agents unused — kept
 *   in the signature for call-site compatibility (installCodexConfig and
 *   existing tests still pass it positionally); per-agent role tables are no
 *   longer generated from it.
 * @param {string} [_targetDir] unused — the standalone-TOML `config_file`
 *   path it used to resolve is no longer emitted here; kept for the same
 *   call-site-compatibility reason as `_agents`.
 */
function generateCodexConfigBlock(_agents, _targetDir) {
  const lines = [
    GSD_CODEX_MARKER,
    '',
  ];

  // ADR-1239 upgrade 2 / #2088 — explicit dispatch tuning. Pin `max_depth` on the
  // `[agents]` (AgentsToml) table rather than relying on codex-cli's implicit
  // default, realizing the negotiated `dispatch.maxDepth: 1` axis. This bare
  // `[agents]` scalar table is validated by validateCodexConfigSchema, which
  // permits a known-scalar-only `[agents]`.
  lines.push('[agents]');
  lines.push(`max_depth = ${GSD_CODEX_AGENTS_MAX_DEPTH}`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Extract a user's pre-existing AgentsToml scalar assignments from a bare
 * `[agents]` table — every known scalar EXCEPT `max_depth` (which GSD manages
 * and always re-emits as 1). Returned as raw `key = value` line strings so
 * mergeCodexConfig can PRESERVE them in the managed block instead of silently
 * dropping the user's tuning when the bare `[agents]` table is purged (#2088
 * review finding: the loosened validator declares such a table legitimate, so
 * install must not destroy it). Only the first bare `[agents]` section is read;
 * `[agents.<name>]` role tables are ignored. Fail-open → [].
 * @returns {string[]}
 */
function extractCodexUserAgentsScalars(content) {
  const preserved = [];
  let section;
  try {
    section = getTomlTableSections(content).find((s) => !s.array && s.path === 'agents');
  } catch (_e) {
    return preserved;
  }
  if (!section) return preserved;
  const body = content.slice(section.headerEnd, section.end);
  for (const record of getTomlLineRecords(body)) {
    if (record.startsInMultilineString || record.tableHeader) continue;
    const trimmed = record.text.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!record.keySegments || record.keySegments.length !== 1) continue;
    const key = record.keySegments[0];
    if (key === 'max_depth') continue; // GSD-managed — GSD's value wins.
    if (!CODEX_AGENTS_TOML_SCALAR_KEYS.has(key)) continue;
    preserved.push(trimmed);
  }
  return preserved;
}

/**
 * Splice preserved user AgentsToml scalar lines into the managed GSD config
 * block, immediately after the `[agents]` header and before GSD's `max_depth`
 * line. Operates on the pre-EOL-normalization block (LF joins), matching only
 * the bare `[agents]` header (never `[agents.<name>]`). Returns the block
 * unchanged when there is nothing to preserve or the anchor is absent.
 */
function spliceCodexAgentsScalars(block, scalarLines) {
  if (!scalarLines || scalarLines.length === 0) return block;
  return block.replace(/(\n\[agents\]\n)(max_depth = )/, `$1${scalarLines.join('\n')}\n$2`);
}

/**
 * Strip any managed GSD agent sections from a TOML string.
 *
 * Used by the uninstall path (`stripGsdFromCodexConfig`). Removes only what GSD
 * owns; user-authored `[agents.<name>]` and `[[agents]]` entries are preserved
 * so uninstall returns the file to its pre-GSD shape.
 *
 * Handles BOTH shapes so reinstall self-heals configs from all GSD versions:
 *   - Current (#2727): `[agents.gsd-*]` struct tables (Codex 0.120.0+).
 *   - Legacy (#2645): `[[agents]]` array-of-tables whose `name = "gsd-*"`.
 *
 * A section runs from its header to the next `[` header or EOF.
 */
function stripCodexGsdAgentSections(content) {
  // Use the TOML-aware section parser so we never absorb adjacent user-authored
  // tables — even if their headers are indented or otherwise oddly placed.
  const sections = getTomlTableSections(content).filter((section) => {
    // Current `[agents.gsd-<name>]` struct tables (#2727, Codex 0.120.0+).
    if (!section.array && /^agents\.gsd-/.test(section.path)) {
      return true;
    }

    // GSD's managed `[agents]` scalar block (ADR-1239 upgrade 2 / #2088 — the
    // `max_depth` dispatch-tuning table). Install purges any pre-existing bare
    // `[agents]` and writes its own, so a known-scalar-only bare `[agents]` is
    // GSD-owned; strip it on uninstall. (The marker path already removes it via
    // the marker-to-EOF cut; this covers the no-marker fallback.)
    if (!section.array && section.path === 'agents') {
      const body = content.slice(section.headerEnd, section.end);
      return codexBareAgentsHasOnlyKnownScalars(body);
    }

    // Legacy `[[agents]]` array-of-tables (#2645) — only strip blocks whose
    // `name = "gsd-..."`, preserving user-authored [[agents]] entries.
    if (section.array && section.path === 'agents') {
      const body = content.slice(section.headerEnd, section.end);
      const nameMatch = body.match(/^[ \t]*name[ \t]*=[ \t]*["']([^"']+)["']/m);
      return Boolean(nameMatch && /^gsd-/.test(nameMatch[1]));
    }

    return false;
  });

  return removeContentRanges(
    content,
    sections.map(({ start, end }) => ({ start, end })),
  );
}

/**
 * Strip GSD sections from Codex config.toml content.
 * Returns cleaned content, or null if file would be empty.
 */
function stripGsdFromCodexConfig(content) {
  const eol = detectLineEnding(content);
  const markerIndex = content.indexOf(GSD_CODEX_MARKER);
  const codexHooksOwnership = getManagedCodexHooksOwnership(content);

  if (markerIndex !== -1) {
    // Has GSD marker — remove everything from marker to EOF. First recover the
    // user's own AgentsToml scalars (max_threads etc.) that install folded into
    // the managed [agents] block (#2088), so a full install→uninstall cycle
    // round-trips the user's tuning. GSD-managed max_depth is dropped.
    const preservedScalars = extractCodexUserAgentsScalars(content.slice(markerIndex));
    let before = content.substring(0, markerIndex);
    before = stripCodexHooksFeatureAssignments(before, codexHooksOwnership);
    // Also strip GSD-injected feature keys above the marker (Case 3 inject)
    before = before.replace(/^multi_agent\s*=\s*true\s*(?:\r?\n)?/m, '');
    before = before.replace(/^default_mode_request_user_input\s*=\s*true\s*(?:\r?\n)?/m, '');
    before = before.replace(/^\[features\]\s*\n(?=\[|$)/m, '');
    before = before.replace(/^\[agents\]\s*\n(?=\[|$)/m, '');
    before = before.replace(/^(?:\r?\n)+/, '').trimEnd();
    if (preservedScalars.length > 0) {
      before = (before ? before + eol + eol : '') + '[agents]' + eol + preservedScalars.join(eol);
    }
    if (!before) return null;
    return before + eol;
  }

  // No marker but may have GSD-injected feature keys
  let cleaned = content;
  cleaned = stripCodexHooksFeatureAssignments(cleaned, codexHooksOwnership);
  cleaned = cleaned.replace(/^multi_agent\s*=\s*true\s*(?:\r?\n)?/m, '');
  cleaned = cleaned.replace(/^default_mode_request_user_input\s*=\s*true\s*(?:\r?\n)?/m, '');

  // #2088: recover the user's own AgentsToml scalars before the [agents] table is
  // stripped, so they survive uninstall even in the no-marker fallback path.
  const preservedScalars = extractCodexUserAgentsScalars(cleaned);

  // Remove [agents.gsd-*] sections + the managed known-scalar [agents] table.
  cleaned = stripCodexGsdAgentSections(cleaned);

  // Remove [features] section if now empty (only header, no keys before next section)
  cleaned = cleaned.replace(/^\[features\]\s*\n(?=\[|$)/m, '');

  // Remove [agents] section if now empty
  cleaned = cleaned.replace(/^\[agents\]\s*\n(?=\[|$)/m, '');

  cleaned = cleaned.replace(/^(?:\r?\n)+/, '').trimEnd();

  if (preservedScalars.length > 0) {
    cleaned = (cleaned ? cleaned + eol + eol : '') + '[agents]' + eol + preservedScalars.join(eol);
  }

  if (!cleaned) return null;
  return cleaned + eol;
}

function detectLineEnding(content) {
  const firstNewlineIndex = content.indexOf('\n');
  if (firstNewlineIndex === -1) {
    return '\n';
  }
  return firstNewlineIndex > 0 && content[firstNewlineIndex - 1] === '\r' ? '\r\n' : '\n';
}

function splitTomlLines(content) {
  const lines = [];
  let start = 0;

  while (start < content.length) {
    const newlineIndex = content.indexOf('\n', start);
    if (newlineIndex === -1) {
      lines.push({
        start,
        end: content.length,
        text: content.slice(start),
        eol: '',
      });
      break;
    }

    const hasCr = newlineIndex > start && content[newlineIndex - 1] === '\r';
    const end = hasCr ? newlineIndex - 1 : newlineIndex;
    lines.push({
      start,
      end,
      text: content.slice(start, end),
      eol: hasCr ? '\r\n' : '\n',
    });
    start = newlineIndex + 1;
  }

  return lines;
}

function findTomlCommentStart(line) {
  let i = 0;
  let multilineState = null;

  while (i < line.length) {
    if (multilineState === 'literal') {
      const closeIndex = line.indexOf('\'\'\'', i);
      if (closeIndex === -1) {
        return -1;
      }
      i = closeIndex + 3;
      multilineState = null;
      continue;
    }

    if (multilineState === 'basic') {
      const closeIndex = findMultilineBasicStringClose(line, i);
      if (closeIndex === -1) {
        return -1;
      }
      i = closeIndex + 3;
      multilineState = null;
      continue;
    }

    const ch = line[i];

    if (ch === '#') {
      return i;
    }

    if (ch === '\'') {
      if (line.startsWith('\'\'\'', i)) {
        multilineState = 'literal';
        i += 3;
        continue;
      }
      const close = line.indexOf('\'', i + 1);
      if (close === -1) return -1;
      i = close + 1;
      continue;
    }

    if (ch === '"') {
      if (line.startsWith('"""', i)) {
        multilineState = 'basic';
        i += 3;
        continue;
      }
      i += 1;
      while (i < line.length) {
        if (line[i] === '\\') {
          i += 2;
          continue;
        }
        if (line[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    i += 1;
  }

  return -1;
}

function isEscapedInBasicString(line, index) {
  let slashCount = 0;
  let cursor = index - 1;

  while (cursor >= 0 && line[cursor] === '\\') {
    slashCount += 1;
    cursor -= 1;
  }

  return slashCount % 2 === 1;
}

function findMultilineBasicStringClose(line, startIndex) {
  let searchIndex = startIndex;

  while (searchIndex < line.length) {
    const closeIndex = line.indexOf('"""', searchIndex);
    if (closeIndex === -1) {
      return -1;
    }
    if (!isEscapedInBasicString(line, closeIndex)) {
      return closeIndex;
    }
    searchIndex = closeIndex + 1;
  }

  return -1;
}

function advanceTomlMultilineStringState(line, multilineState) {
  let i = 0;
  let state = multilineState;

  while (i < line.length) {
    if (state === 'literal') {
      const closeIndex = line.indexOf('\'\'\'', i);
      if (closeIndex === -1) {
        return state;
      }
      i = closeIndex + 3;
      state = null;
      continue;
    }

    if (state === 'basic') {
      const closeIndex = findMultilineBasicStringClose(line, i);
      if (closeIndex === -1) {
        return state;
      }
      i = closeIndex + 3;
      state = null;
      continue;
    }

    const ch = line[i];

    if (ch === '#') {
      return state;
    }

    if (ch === '\'') {
      if (line.startsWith('\'\'\'', i)) {
        state = 'literal';
        i += 3;
        continue;
      }
      const close = line.indexOf('\'', i + 1);
      if (close === -1) {
        return state;
      }
      i = close + 1;
      continue;
    }

    if (ch === '"') {
      if (line.startsWith('"""', i)) {
        state = 'basic';
        i += 3;
        continue;
      }
      i += 1;
      while (i < line.length) {
        if (line[i] === '\\') {
          i += 2;
          continue;
        }
        if (line[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    i += 1;
  }

  return state;
}

function parseTomlBracketHeader(line, array) {
  let i = 0;

  while (i < line.length && /\s/.test(line[i])) {
    i += 1;
  }

  const open = array ? '[[' : '[';
  const close = array ? ']]' : ']';
  if (!line.startsWith(open, i)) {
    return null;
  }

  i += open.length;
  const start = i;

  while (i < line.length) {
    if (line[i] === '\'' || line[i] === '"') {
      const quote = line[i];
      i += 1;

      while (i < line.length) {
        if (quote === '"' && line[i] === '\\') {
          i += 2;
          continue;
        }

        if (line[i] === quote) {
          i += 1;
          break;
        }

        i += 1;
      }

      continue;
    }

    if (line.startsWith(close, i)) {
      const rawPath = line.slice(start, i).trim();
      const segments = parseTomlKeyPath(rawPath);
      if (!segments) {
        return null;
      }

      i += close.length;
      while (i < line.length && /\s/.test(line[i])) {
        i += 1;
      }

      if (i < line.length && line[i] !== '#') {
        return null;
      }

      return { path: segments.join('.'), segments, array };
    }

    if (line[i] === '#' || line[i] === '\r' || line[i] === '\n') {
      return null;
    }

    i += 1;
  }

  return null;
}

function parseTomlTableHeader(line) {
  return parseTomlBracketHeader(line, true) || parseTomlBracketHeader(line, false);
}

function findTomlAssignmentEquals(line) {
  let i = 0;

  while (i < line.length) {
    const ch = line[i];

    if (ch === '#') {
      return -1;
    }

    if (ch === '\'') {
      i += 1;
      while (i < line.length) {
        if (line[i] === '\'') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === '"') {
      i += 1;
      while (i < line.length) {
        if (line[i] === '\\') {
          i += 2;
          continue;
        }
        if (line[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === '=') {
      return i;
    }

    i += 1;
  }

  return -1;
}

function parseTomlKeyPath(keyText) {
  const segments = [];
  let i = 0;

  while (i < keyText.length) {
    while (i < keyText.length && /\s/.test(keyText[i])) {
      i += 1;
    }

    if (i >= keyText.length) {
      break;
    }

    if (keyText[i] === '\'' || keyText[i] === '"') {
      const quote = keyText[i];
      let segment = '';
      let closed = false;
      i += 1;

      while (i < keyText.length) {
        if (quote === '"' && keyText[i] === '\\') {
          if (i + 1 >= keyText.length) {
            return null;
          }
          segment += keyText[i + 1];
          i += 2;
          continue;
        }

        if (keyText[i] === quote) {
          i += 1;
          closed = true;
          break;
        }

        segment += keyText[i];
        i += 1;
      }

      if (!closed) {
        return null;
      }

      segments.push(segment);
    } else {
      const match = keyText.slice(i).match(/^[A-Za-z0-9_-]+/);
      if (!match) {
        return null;
      }
      segments.push(match[0]);
      i += match[0].length;
    }

    while (i < keyText.length && /\s/.test(keyText[i])) {
      i += 1;
    }

    if (i >= keyText.length) {
      break;
    }

    if (keyText[i] !== '.') {
      return null;
    }

    i += 1;
  }

  return segments.length > 0 ? segments : null;
}

function parseTomlKey(line) {
  const header = parseTomlTableHeader(line);
  if (header) {
    return null;
  }

  const equalsIndex = findTomlAssignmentEquals(line);
  if (equalsIndex === -1) {
    return null;
  }

  const raw = line.slice(0, equalsIndex).trim();
  const segments = parseTomlKeyPath(raw);
  if (!segments) {
    return null;
  }

  return { raw, segments };
}

function getTomlLineRecords(content) {
  const lines = splitTomlLines(content);
  const records = [];
  let currentTablePath = null;
  let multilineState = null;

  for (const line of lines) {
    const startsInMultilineString = multilineState !== null;
    const record = {
      ...line,
      startsInMultilineString,
      tablePath: currentTablePath,
      tableHeader: null,
      keySegments: null,
    };

    if (!startsInMultilineString) {
      const header = parseTomlTableHeader(line.text);
      if (header) {
        record.tableHeader = header;
        currentTablePath = header.path;
      } else {
        const key = parseTomlKey(line.text);
        record.keySegments = key ? key.segments : null;
        record.keyRaw = key ? key.raw : null;
      }
    }

    multilineState = advanceTomlMultilineStringState(line.text, multilineState);
    records.push(record);
  }

  return records;
}

function getTomlTableSections(content) {
  const headerLines = getTomlLineRecords(content).filter((record) => record.tableHeader);

  return headerLines.map((record, index) => ({
    path: record.tableHeader.path,
    // segments preserves the true parsed key count so callers that need to
    // distinguish a 2-segment path like hooks."before.tool" from a 3-segment
    // path like hooks.SessionStart.hooks can do so without splitting on dots
    // (which misclassifies quoted key names that contain dot characters).
    segments: record.tableHeader.segments,
    array: record.tableHeader.array,
    start: record.start,
    headerEnd: record.end + record.eol.length,
    end: index + 1 < headerLines.length ? headerLines[index + 1].start : content.length,
  }));
}

function collapseTomlBlankLines(content) {
  const eol = detectLineEnding(content);
  return content.replace(/(?:\r?\n){3,}/g, eol + eol);
}

function removeContentRanges(content, ranges) {
  const normalizedRanges = ranges
    .filter((range) => range && range.start < range.end)
    .sort((a, b) => a.start - b.start);

  if (normalizedRanges.length === 0) {
    return content;
  }

  const mergedRanges = [{ ...normalizedRanges[0] }];

  for (let i = 1; i < normalizedRanges.length; i += 1) {
    const current = normalizedRanges[i];
    const previous = mergedRanges[mergedRanges.length - 1];

    if (current.start <= previous.end) {
      previous.end = Math.max(previous.end, current.end);
      continue;
    }

    mergedRanges.push({ ...current });
  }

  let cleaned = '';
  let cursor = 0;

  for (const range of mergedRanges) {
    cleaned += content.slice(cursor, range.start);
    cursor = range.end;
  }

  cleaned += content.slice(cursor);
  return cleaned;
}

function stripCodexHooksFeatureAssignments(content, ownership = null) {
  const lineRecords = getTomlLineRecords(content);
  const tableSections = getTomlTableSections(content);
  const removalRanges = [];
  const featuresSection = tableSections.find((section) => !section.array && section.path === 'features');
  const shouldStripSectionKey = ownership === 'section' || ownership === 'all';
  const shouldStripRootDottedKey = ownership === 'root_dotted' || ownership === 'all';

  if (featuresSection && shouldStripSectionKey) {
    const sectionRecords = lineRecords.filter((record) =>
      !record.tableHeader &&
      record.start >= featuresSection.headerEnd &&
      record.end + record.eol.length <= featuresSection.end
    );

    const codexHookRecords = sectionRecords.filter((record) =>
      !record.startsInMultilineString &&
      record.keySegments &&
      record.keySegments.length === 1 &&
      isCodexHooksFeatureKey(record.keySegments[0])
    );

    for (const record of codexHookRecords) {
      removalRanges.push({
        start: record.start,
        end: findTomlAssignmentBlockEnd(content, record),
      });
    }

    if (codexHookRecords.length > 0) {
      const removedStarts = new Set(codexHookRecords.map((record) => record.start));
      const hasRemainingContent = sectionRecords.some((record) => {
        if (removedStarts.has(record.start)) {
          return false;
        }

        const trimmed = record.text.trim();
        return trimmed !== '' && !trimmed.startsWith('#');
      });
      const hasRemainingComments = sectionRecords.some((record) => {
        if (removedStarts.has(record.start)) {
          return false;
        }

        return record.text.trim().startsWith('#');
      });

      if (!hasRemainingContent && !hasRemainingComments) {
        removalRanges.push({
          start: featuresSection.start,
          end: featuresSection.end,
        });
      }
    }
  }

  if (shouldStripRootDottedKey) {
    const rootCodexHookRecords = lineRecords.filter((record) =>
      !record.tableHeader &&
      !record.startsInMultilineString &&
      record.tablePath === null &&
      record.keySegments &&
      record.keySegments.length === 2 &&
      record.keySegments[0] === 'features' &&
      isCodexHooksFeatureKey(record.keySegments[1])
    );

    for (const record of rootCodexHookRecords) {
      removalRanges.push({
        start: record.start,
        end: findTomlAssignmentBlockEnd(content, record),
      });
    }
  }

  return removeContentRanges(content, removalRanges);
}

function getManagedCodexHooksOwnership(content) {
  const markerIndex = content.indexOf(GSD_CODEX_MARKER);
  if (markerIndex === -1) {
    return null;
  }

  const afterMarker = content.slice(markerIndex + GSD_CODEX_MARKER.length);
  const match = afterMarker.match(/^\r?\n# GSD codex_hooks ownership: (section|root_dotted)\r?\n/);
  return match ? match[1] : null;
}

function setManagedCodexHooksOwnership(content, ownership) {
  const markerIndex = content.indexOf(GSD_CODEX_MARKER);
  if (markerIndex === -1) {
    return content;
  }

  const eol = detectLineEnding(content);
  const markerEnd = markerIndex + GSD_CODEX_MARKER.length;
  const afterMarker = content.slice(markerEnd);
  const normalizedAfterMarker = afterMarker.replace(
    /^\r?\n# GSD codex_hooks ownership: (?:section|root_dotted)\r?\n/,
    eol
  );

  if (!ownership) {
    return content.slice(0, markerEnd) + normalizedAfterMarker;
  }

  const remainder = normalizedAfterMarker.replace(/^\r?\n/, '');
  return content.slice(0, markerEnd) +
    eol +
    `${GSD_CODEX_HOOKS_OWNERSHIP_PREFIX}${ownership}${eol}` +
    remainder;
}

function isLegacyGsdAgentsSection(body) {
  const lineRecords = getTomlLineRecords(body);
  const legacyKeys = new Set(['max_threads', 'max_depth']);
  let sawLegacyKey = false;

  for (const record of lineRecords) {
    if (record.startsInMultilineString) {
      return false;
    }

    if (record.tableHeader) {
      return false;
    }

    const trimmed = record.text.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    if (!record.keySegments || record.keySegments.length !== 1 || !legacyKeys.has(record.keySegments[0])) {
      return false;
    }

    sawLegacyKey = true;
  }

  return sawLegacyKey;
}

function stripLeakedGsdCodexSections(content) {
  // Defensive precedence (#2760): we own the `agents` namespace under our
  // managed `gsd-*` names, and the legacy bare-table and sequence forms
  // (`[agents]`, `[[agents]]`) are invalid in the current Codex schema —
  // they trigger "invalid type: ..., expected struct AgentsToml" and break
  // every Codex CLI invocation. They MUST never coexist with the new
  // `[agents.<name>]` struct format we now emit, so install-time always
  // purges them regardless of GSD marker presence. Users who had legitimate
  // user-authored `[[agents]]` entries before are already broken on Codex
  // ≥0.124 — purging is the only path to a loadable config.
  const leakedSections = getTomlTableSections(content)
    .filter((section) => {
      // Legacy [agents.gsd-<name>] map tables (pre-#2645).
      if (!section.array && section.path.startsWith('agents.gsd-')) return true;

      // ANY bare [agents] single-bracket table — invalid in current Codex
      // schema, always purged at install time (#2760). Previously gated
      // on `isLegacyGsdAgentsSection`, which missed bare tables holding
      // arbitrary user keys (`default = "..."`, etc.) that still produce
      // the AgentsToml type error.
      if (!section.array && section.path === 'agents') return true;

      // ANY [[agents]] array-of-tables — invalid in current Codex schema,
      // always purged at install time (#2760). Previously gated on
      // `name = "gsd-..."` which preserved user-authored entries that are
      // themselves rejected by Codex 0.124+.
      if (section.array && section.path === 'agents') return true;

      return false;
    });

  if (leakedSections.length === 0) {
    return content;
  }

  let cleaned = '';
  let cursor = 0;

  for (const section of leakedSections) {
    cleaned += content.slice(cursor, section.start);
    cursor = section.end;
  }

  cleaned += content.slice(cursor);
  return collapseTomlBlankLines(cleaned);
}

/**
 * Strip GSD-managed legacy Codex hook blocks from a config.toml string
 * using the TOML AST already used elsewhere in this file
 * (`getTomlTableSections` + `removeContentRanges`). The earlier regex-based
 * implementation required a precise key order, exact single-space padding
 * around `=`, and exactly one blank line between Shape 4's parent/child
 * tables — any deviation (an extra blank line, key reorder, an added
 * `timeout` key, `event="SessionStart"` without spaces) silently leaked the
 * stale block, sometimes corrupting the file by leaving orphaned key=value
 * lines outside any table.
 *
 * The structural approach: find every `hooks*` table whose body contains a
 * `command = "...gsd-(check-update|update-check).js"` value, remove its
 * exact byte range, and additionally remove any orphaned parent
 * `[[hooks.SessionStart]]` whose body becomes empty as a result (Shape 4).
 * The leading `# GSD Hooks` header line is swallowed by extending the
 * removal range backward through any single preceding comment line.
 *
 * Pure function, exported for test coverage. Returns the input unchanged
 * if no GSD-managed hook section is present.
 */
function stripStaleGsdHookBlocks(configContent) {
  const sections = getTomlTableSections(configContent);
  const lineRecords = getTomlLineRecords(configContent);
  const hookSections = sections.filter(
    (s) => s.path === 'hooks' || s.path.startsWith('hooks.')
  );
  if (hookSections.length === 0) {
    return configContent;
  }

  // A section is GSD-managed if any structural `command` key inside its
  // body parses to a string whose basename matches `gsd-(check-update|
  // update-check).js`. The TOML line parser already classified each line's
  // `keySegments`, so we never inspect raw text — this handles arbitrary
  // whitespace, key reordering, and additional keys robustly.
  function sectionHasStaleCommand(section) {
    const records = lineRecords.filter(
      (r) => !r.startsInMultilineString
        && !r.tableHeader
        && r.start >= section.headerEnd
        && r.end + r.eol.length <= section.end
        && r.keySegments
        && r.keySegments.length === 1
        && r.keySegments[0] === 'command'
    );
    for (const record of records) {
      const equalsIndex = findTomlAssignmentEquals(record.text);
      if (equalsIndex === -1) continue;
      let parsed;
      try {
        parsed = parseTomlValue(record.text, equalsIndex + 1);
      } catch {
        continue;
      }
      if (typeof parsed.value !== 'string') continue;
      if (isManagedHookCommand(parsed.value, {
        surface: 'codex-toml',
        includeLegacyAliases: true,
      })) {
        return true;
      }
    }
    return false;
  }

  const stale = new Set(hookSections.filter(sectionHasStaleCommand));
  if (stale.size === 0) {
    return configContent;
  }

  // Shape 4: a `[[hooks.SessionStart]]` event-table whose body is empty and
  // whose immediately following section is a stale child handler table
  // (`[[hooks.SessionStart.hooks]]`) becomes orphaned once the child is
  // stripped. Detect emptiness via line records — no key/value lines and no
  // non-blank, non-comment text between this section's header and the next.
  function sectionBodyHasContent(section) {
    return lineRecords.some(
      (r) => !r.startsInMultilineString
        && !r.tableHeader
        && r.start >= section.headerEnd
        && r.end + r.eol.length <= section.end
        && r.text.trim() !== ''
        && !r.text.trim().startsWith('#')
    );
  }
  for (let i = 0; i < sections.length; i += 1) {
    const parent = sections[i];
    if (stale.has(parent)) continue;
    if (!parent.array || parent.path !== 'hooks.SessionStart') continue;
    if (sectionBodyHasContent(parent)) continue;
    const next = sections[i + 1];
    if (next && stale.has(next) && next.path.startsWith('hooks.SessionStart.')) {
      stale.add(parent);
    }
  }

  // Each removal range starts at the table header. If the immediately
  // preceding line is the GSD marker comment `# GSD Hooks` (and is not part
  // of an already-removed section), extend the range backward to swallow it
  // — preserves cleanliness on round-trip strip+rewrite.
  const ranges = [];
  for (const section of stale) {
    let start = section.start;
    const headerLineIdx = lineRecords.findIndex((r) => r.start === section.start);
    const prev = headerLineIdx > 0 ? lineRecords[headerLineIdx - 1] : null;
    if (prev && !prev.startsInMultilineString && prev.text.trim() === '# GSD Hooks') {
      start = prev.start;
    }
    ranges.push({ start, end: section.end });
  }

  return collapseTomlBlankLines(removeContentRanges(configContent, ranges));
}

/**
 * Migrate legacy Codex [hooks] map format to [[hooks]] array-of-tables format.
 *
 * Codex 0.124.0 changed from the old map-style hooks config:
 *   [hooks]
 *     [hooks.shell]
 *     command = "..."
 *
 * to the new array-of-tables format. #2760 CR5 finding 3 — emit the
 * namespaced AoT shape directly so a mixed flat + namespaced layout never
 * arises post-install:
 *   [[hooks.shell]]
 *   command = "..."
 *
 * This function detects any non-array hooks sections in the config and
 * converts them to the namespaced `[[hooks.<TYPE>]]` array-of-tables form,
 * preserving all key-value pairs and user comments. Bare [hooks] container
 * sections (no key-value content) are dropped. User-authored AoT entries are
 * left untouched.
 *
 * Returns the migrated content, or the original content unchanged if no
 * legacy hooks sections were found.
 */
function migrateCodexHooksMapFormat(content) {
  const sections = getTomlTableSections(content);

  // Find all non-array hooks sections: bare [hooks] container or [hooks.TYPE] event tables.
  // Use section.segments (parsed key count) rather than section.path.startsWith() so that
  // nested handler tables like [hooks.SessionStart.hooks] (3 segments) are not mistakenly
  // included and re-emitted as an event named "SessionStart.hooks".
  // Exclude hooks.state and hooks.state.* — these are Codex's persistent hook-trust
  // namespace (Codex CLI 0.130.0+) and use regular-table shape, never AoT.
  const legacyMapSections = sections.filter(
    (section) => !section.array && (
      section.path === 'hooks' ||
      (section.path.startsWith('hooks.') && section.segments.length === 2 &&
        section.path !== 'hooks.state' && !section.path.startsWith('hooks.state.'))
    )
  );

  // Find flat [[hooks]] array-of-tables entries (path === 'hooks', array === true).
  // These are incompatible with [[hooks.<EVENT>]] namespaced form — both cannot
  // coexist in the same TOML file because `hooks` cannot be simultaneously an
  // array and a table. Migrate each flat entry to [[hooks.<EVENT>]] form using
  // the `event` key as the event name.
  const flatAotSections = sections.filter(
    (section) => section.array && section.path === 'hooks'
  );

  // Find [[hooks.TYPE]] namespaced AoT entries that carry handler fields
  // (command, type, timeout, statusMessage) at event-entry level but have no
  // [[hooks.TYPE.hooks]] sub-table. This is the pre-#2773 single-block shape
  // that Codex 0.124.0+ rejects. Promote them to the two-level nested form.
  // Entries that already have a [[hooks.TYPE.hooks]] sub-table are left untouched.
  // Matcher-only entries (no handler fields) are intentionally valid and skipped.
  const STALE_HANDLER_FIELD_PATTERN = /^\s*(?:command|type|timeout|statusMessage)\s*=/m;
  const staleNamespacedAotSections = sections.filter((section) => {
    if (!section.array) return false;
    if (!section.path.startsWith('hooks.')) return false;
    // [[hooks.TYPE.hooks]] sub-tables have 3 parsed segments — skip them.
    // Use section.segments (true parsed key count) rather than splitting
    // section.path on '.', which misclassifies quoted event names that contain
    // dots (e.g. [[hooks."before.tool"]] has segments ['hooks','before.tool']
    // but path 'hooks.before.tool' would split into 3 parts).
    if (section.segments.length !== 2) return false;
    // Must carry at least one handler field at event-entry level.
    const body = content.slice(section.headerEnd, section.end);
    if (!STALE_HANDLER_FIELD_PATTERN.test(body)) return false;
    // Don't migrate when the nested [[hooks.TYPE.hooks]] sub-table already exists.
    const subPath = section.path + '.hooks';
    return !sections.some((s) => s.array && s.path === subPath);
  });

  if (legacyMapSections.length === 0 && flatAotSections.length === 0 && staleNamespacedAotSections.length === 0) {
    return content;
  }

  const eol = detectLineEnding(content);

  // Helper: parse a hooks body into event-level and handler-level entries,
  // returning { eventEntries, handlerEntries, hasExplicitType }.
  // Event-level keys: matcher. Everything else is handler-level.
  // The `event` key (used in flat [[hooks]] blocks) is consumed as the type
  // name and excluded from both levels.
  const EVENT_LEVEL_KEYS = new Set(['matcher']);
  function parseHooksBody(body, skipKeys = new Set()) {
    const bodyLines = body.split(/\r?\n/);
    const eventEntries = [];
    const handlerEntries = [];
    let hasExplicitType = false;
    for (const line of bodyLines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      // Use parseTomlKey so hyphenated keys (e.g. status-message) and quoted
      // keys are recognised — the old /^([\w.]+)\s*=/ regex silently dropped them.
      const parsed = parseTomlKey(trimmed);
      if (!parsed) continue;
      // Hook body keys are always single-segment; use segments[0] for the name.
      const key = parsed.segments[0];
      if (skipKeys.has(key)) continue;
      if (key === 'type') {
        hasExplicitType = true;
        handlerEntries.push(trimmed);
      } else if (EVENT_LEVEL_KEYS.has(key)) {
        eventEntries.push(trimmed);
      } else {
        handlerEntries.push(trimmed);
      }
    }
    return { eventEntries, handlerEntries, hasExplicitType };
  }

  // TOML key quoting: bare keys may only contain [A-Za-z0-9_-]. Event names
  // containing spaces, dots, or other punctuation must be wrapped in double-
  // quoted TOML strings with backslash and double-quote characters escaped.
  // Using raw event names in [[hooks.${type}]] headers produces invalid TOML
  // for any non-bare-key character (e.g. "Before Tool" → [[hooks.Before Tool]]).
  function tomlBareKey(key) {
    if (/^[A-Za-z0-9_-]+$/.test(key)) return key;
    return '"' + key.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  function buildNestedBlock(type, body, skipKeys = new Set()) {
    const quotedType = tomlBareKey(type);
    const { eventEntries, handlerEntries, hasExplicitType } = parseHooksBody(body, skipKeys);
    const eventBody = eventEntries.length > 0 ? eventEntries.join(eol) + eol : '';
    // If no handler fields were found (e.g. matcher-only entry), do not synthesise
    // an empty [[hooks.TYPE.hooks]] block — that would produce structurally valid
    // TOML but semantically broken output (a handler entry with no command).
    if (handlerEntries.length === 0) {
      return `[[hooks.${quotedType}]]${eol}${eventBody}`;
    }
    if (!hasExplicitType) handlerEntries.unshift('type = "command"');
    const handlerBody = handlerEntries.join(eol) + eol;
    return `[[hooks.${quotedType}]]${eol}${eventBody}${eol}[[hooks.${quotedType}.hooks]]${eol}${handlerBody}`;
  }

  // Extract the event name from a flat [[hooks]] section body.
  // Returns null if no `event` key is found, if the value is an empty string, or if
  // the quoting is unrecognised. Both TOML double-quoted ("...") and single-quoted
  // ('...') strings are accepted. An empty event string (event = "" or event = '')
  // is explicitly rejected — it cannot be meaningfully namespaced and is left untouched.
  function extractFlatHookEventName(body) {
    const TOML_EVENT_CAPTURE = /^\s*event\s*=\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)')/m;
    const m = body.match(TOML_EVENT_CAPTURE);
    if (!m) return null;
    const name = (m[1] ?? m[2] ?? '').trim();
    return name || null;
  }

  const migratedFlatAotSections = flatAotSections.filter((section) => {
    const body = content.slice(section.headerEnd, section.end);
    return extractFlatHookEventName(body) !== null;
  });

  const legacyHooksSections = [...legacyMapSections, ...migratedFlatAotSections, ...staleNamespacedAotSections];

  // Remove all legacy hooks sections from the content
  let result = removeContentRanges(
    content,
    legacyHooksSections.map(({ start, end }) => ({ start, end })),
  );
  result = collapseTomlBlankLines(result);

  // Map-format blocks ([hooks.TYPE]) are inserted at the position of the first
  // remaining table section (preserving their relative placement in the file).
  // Flat AoT blocks ([[hooks]] with event = "...") are always APPENDED because
  // flat [[hooks]] entries only appear at the END of a TOML file (AoT cannot
  // precede a regular table), and inserting before the first table would push
  // them above [features] / [model] etc., corrupting relative ordering.
  const mapOnlyBlocks = legacyMapSections
    .filter((s) => s.path !== 'hooks')   // skip bare [hooks] container
    .map((s) => {
      const body = content.slice(s.headerEnd, s.end);
      // #3346: when the legacy `[hooks.<X>]` body declares `event = "..."`,
      // prefer that as the event-name leaf key. The path segment <X> may be
      // a `<file>:<event>:<line>:<col>` location identifier (Codex pre-AoT
      // wrote those as table keys), which is not a valid leaf event name —
      // emitting it verbatim produces a TOML key chain Codex 0.124.0+ rejects.
      const bodyEvent = extractFlatHookEventName(body);
      const type = bodyEvent !== null ? bodyEvent : s.path.slice('hooks.'.length);
      const skipKeys = bodyEvent !== null ? new Set(['event']) : new Set();
      return buildNestedBlock(type, body, skipKeys);
    });

  // Stale namespaced AoT blocks: [[hooks.TYPE]] entries with handler fields at
  // event-entry level (no .hooks sub-table). Treated like map-format blocks —
  // inserted before the first remaining table section.
  const staleNamespacedAotBlocks = staleNamespacedAotSections.map((s) => {
    const body = content.slice(s.headerEnd, s.end);
    // #3346: see note in mapOnlyBlocks — body `event = "..."` wins over the
    // raw path segment when both are present.
    const bodyEvent = extractFlatHookEventName(body);
    const type = bodyEvent !== null ? bodyEvent : s.path.slice('hooks.'.length);
    const skipKeys = bodyEvent !== null ? new Set(['event']) : new Set();
    return buildNestedBlock(type, body, skipKeys);
  });

  const flatAotBlocks = migratedFlatAotSections.map((s) => {
    const body = content.slice(s.headerEnd, s.end);
    const eventName = extractFlatHookEventName(body);
    if (!eventName) return '';
    return buildNestedBlock(eventName, body, new Set(['event']));
  }).filter(Boolean);

  // Insert map-format and stale-namespaced-AoT conversions before the first
  // remaining table section (both share the same placement strategy).
  const allMapStyleBlocks = [...mapOnlyBlocks, ...staleNamespacedAotBlocks];
  if (allMapStyleBlocks.length > 0) {
    const insertionText = allMapStyleBlocks.join('');
    const remainingSections = getTomlTableSections(result);
    if (remainingSections.length > 0) {
      const firstTable = remainingSections[0];
      const before = result.slice(0, firstTable.start);
      const after = result.slice(firstTable.start);
      const needsLeadingGap = before.length > 0 && !before.endsWith(eol + eol);
      const needsTrailingGap = after.length > 0 && !insertionText.endsWith(eol + eol);
      result = before +
        (needsLeadingGap ? eol : '') +
        insertionText +
        (needsTrailingGap ? eol : '') +
        after;
    } else {
      const needsGap = result.length > 0 && !result.endsWith(eol + eol);
      result = result + (needsGap ? eol : '') + insertionText;
    }
  }

  // Insert flat-AoT conversions before the GSD managed marker (if present) so
  // the migrated user hooks stay in the "user" portion of the file and are not
  // swept away when stripGsdFromCodexConfig strips from the marker to EOF.
  // If no marker exists, append at the end of the file.
  if (flatAotBlocks.length > 0) {
    const insertionText = flatAotBlocks.join('');
    const markerIdx = result.indexOf(GSD_CODEX_MARKER);
    if (markerIdx !== -1) {
      const before = result.slice(0, markerIdx).trimEnd();
      const after = result.slice(markerIdx);
      result = before + eol + eol + insertionText + eol + after;
    } else {
      const needsGap = result.length > 0 && !result.endsWith(eol + eol);
      result = result + (needsGap ? eol : '') + insertionText;
    }
  }

  return result;
}

/**
 * Detect whether the user already uses the namespaced AoT hooks form
 * (`[[hooks.<EVENT>]]`) for the given event in the config. When true,
 * the GSD-managed hook block must be emitted in the same shape so it
 * coexists cleanly — mixing `[[hooks]]` (flat) with `[[hooks.SessionStart]]`
 * (namespaced) in the same file confuses round-trip writers and can
 * produce a config that Codex rejects (#2760, defect 3).
 */
function hasUserNamespacedAotHooks(content, event) {
  const sections = getTomlTableSections(content);
  return sections.some(
    (section) => section.array && section.path === `hooks.${event}`
  );
}

/**
 * Parse a TOML value RHS expression starting at index `i` of `text`.
 * Returns { value, end } on success or throws on parse failure.
 *
 * Supports the value forms GSD emits or that real Codex configs commonly use:
 *   - basic strings ("…" with simple escapes)
 *   - literal strings ('…')
 *   - booleans (true / false)
 *   - integers (optional sign, decimal digits)
 *   - inline arrays of the above
 *   - inline tables { k = v, … }
 *
 * This is intentionally not a complete TOML implementation — it is the
 * minimal value grammar required to validate Codex config structure and to
 * back behavioral assertions in tests (#2760).
 */
function parseTomlValue(text, i) {
  // Skip leading whitespace.
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) {
    i += 1;
  }
  if (i >= text.length) {
    throw new Error('expected value, got end of input');
  }

  const ch = text[i];

  // Basic string
  if (ch === '"') {
    if (text.startsWith('"""', i)) {
      const close = findMultilineBasicStringClose(text, i + 3);
      if (close === -1) {
        throw new Error('unterminated multi-line basic string');
      }
      const raw = text.slice(i + 3, close);
      return { value: raw.replace(/^\r?\n/, ''), end: close + 3 };
    }
    let j = i + 1;
    let out = '';
    while (j < text.length) {
      const c = text[j];
      if (c === '\\') {
        const next = text[j + 1];
        if (next === 'n') { out += '\n'; j += 2; continue; }
        if (next === 't') { out += '\t'; j += 2; continue; }
        if (next === 'r') { out += '\r'; j += 2; continue; }
        if (next === '\\') { out += '\\'; j += 2; continue; }
        if (next === '"') { out += '"'; j += 2; continue; }
        if (next === '/') { out += '/'; j += 2; continue; }
        // Pass-through unrecognized escape (Codex/GSD don't use these).
        out += next === undefined ? '' : next;
        j += 2;
        continue;
      }
      if (c === '"') {
        return { value: out, end: j + 1 };
      }
      out += c;
      j += 1;
    }
    throw new Error('unterminated basic string');
  }

  // Literal string
  if (ch === '\'') {
    if (text.startsWith('\'\'\'', i)) {
      const close = text.indexOf('\'\'\'', i + 3);
      if (close === -1) throw new Error('unterminated multi-line literal string');
      return { value: text.slice(i + 3, close).replace(/^\r?\n/, ''), end: close + 3 };
    }
    const close = text.indexOf('\'', i + 1);
    if (close === -1) throw new Error('unterminated literal string');
    return { value: text.slice(i + 1, close), end: close + 1 };
  }

  // Boolean
  if (text.startsWith('true', i) && !/[A-Za-z0-9_-]/.test(text[i + 4] || '')) {
    return { value: true, end: i + 4 };
  }
  if (text.startsWith('false', i) && !/[A-Za-z0-9_-]/.test(text[i + 5] || '')) {
    return { value: false, end: i + 5 };
  }

  // Inline array
  if (ch === '[') {
    const arr = [];
    let j = i + 1;
    while (true) {
      while (j < text.length && /[\s\r\n]/.test(text[j])) j += 1;
      if (j >= text.length) throw new Error('unterminated inline array');
      if (text[j] === ']') return { value: arr, end: j + 1 };
      if (text[j] === '#') {
        const nl = text.indexOf('\n', j);
        j = nl === -1 ? text.length : nl + 1;
        continue;
      }
      const parsed = parseTomlValue(text, j);
      arr.push(parsed.value);
      j = parsed.end;
      while (j < text.length && /[\s\r\n]/.test(text[j])) j += 1;
      if (j < text.length && text[j] === ',') {
        j += 1;
        continue;
      }
      while (j < text.length && /[\s\r\n]/.test(text[j])) j += 1;
      if (text[j] === ']') return { value: arr, end: j + 1 };
      throw new Error(`expected , or ] in inline array at offset ${j}`);
    }
  }

  // Inline table
  if (ch === '{') {
    const obj = {};
    let j = i + 1;
    while (true) {
      while (j < text.length && /[\s\r\n]/.test(text[j])) j += 1;
      if (text[j] === '}') return { value: obj, end: j + 1 };
      const keyMatch = text.slice(j).match(/^([A-Za-z0-9_-]+|"[^"]*"|'[^']*')\s*=\s*/);
      if (!keyMatch) throw new Error(`expected key in inline table at offset ${j}`);
      let rawKey = keyMatch[1];
      if ((rawKey.startsWith('"') && rawKey.endsWith('"')) || (rawKey.startsWith('\'') && rawKey.endsWith('\''))) {
        rawKey = rawKey.slice(1, -1);
      }
      j += keyMatch[0].length;
      const parsed = parseTomlValue(text, j);
      obj[rawKey] = parsed.value;
      j = parsed.end;
      while (j < text.length && /[\s\r\n]/.test(text[j])) j += 1;
      if (text[j] === ',') { j += 1; continue; }
      if (text[j] === '}') return { value: obj, end: j + 1 };
      throw new Error(`expected , or } in inline table at offset ${j}`);
    }
  }

  // Number — integer or TOML 1.0 float. (#2760 CR4 finding 3 required explicit
  // rejection of floats; #3245 inverts that: Codex CLI's serde schema requires
  // f64 for tool_timeout_sec / startup_timeout_sec, so integers are what Codex
  // rejects. Accept TOML floats and store as JS Number.)
  //
  // Still rejected: date/time literals (`-`, `:`, `T`, `Z` after integer prefix)
  // and hex/oct/bin literals (`0x`, `0o`, `0b` — `x`, `o`, `b` fall through to
  // the unsupported-value throw below because the integer-part pattern won't match `x`).
  // TOML 1.0 §2: underscores in numeric literals are only allowed BETWEEN
  // digits (each underscore must have a digit on both sides). The pre-check
  // regex uses (?:_?\d)* rather than [\d_]* so `1__0`, `1_.0`, and `1._0`
  // are rejected before normalization silently hides them.
  //
  // TOML 1.0 §2 (integer part): the integer part of a number must follow
  // decimal-integer rules — no leading zeros except the value 0 itself.
  // `01`, `00`, `01.5`, `00e2`, `+01`, `-01` are therefore all invalid.
  // The pre-check and float regexes use (0|[1-9](?:_?\d)*) for the integer
  // part so that `01` and `00` are rejected (k021 sibling rule).
  const numMatch = text.slice(i).match(/^[+-]?(0|[1-9](?:_?\d)*)/);
  if (numMatch) {
    const afterInt = text[i + numMatch[0].length];
    // Reject date/time separators that cannot be part of a float.
    if (afterInt !== undefined && /[:\-TZ]/.test(afterInt)) {
      throw new Error(
        `unsupported TOML value at offset ${i}: dates and times are not supported (got ${text.slice(i, i + 20)})`
      );
    }
    // Accept float: optional decimal part, optional exponent part.
    // Each segment uses (?:_?\d)* so underscores are only between digits.
    // Integer part uses (0|[1-9](?:_?\d)*) to reject leading zeros per TOML 1.0.
    const floatMatch = text.slice(i).match(
      /^[+-]?(0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?/
    );
    const raw = floatMatch ? floatMatch[0] : numMatch[0];
    const normalized = raw.replace(/_/g, '');
    const n = Number(normalized);
    if (!Number.isFinite(n)) throw new Error(`invalid number: ${raw}`);
    return { value: n, end: i + raw.length };
  }

  throw new Error(`unsupported value at offset ${i}: ${text.slice(i, i + 20)}`);
}

/**
 * Parse TOML content into a JavaScript object. Throws on malformed input.
 *
 * Handles `[table]`, `[[array.of.tables]]`, dotted key paths, and the value
 * forms supported by parseTomlValue. Sufficient for validating Codex config
 * structure and for behavioral test assertions in #2760 — not a general
 * TOML implementation.
 */
function parseTomlToObject(content) {
  const root = {};
  const records = getTomlLineRecords(content);
  // Tracks the *object* (not path) that subsequent key=value lines target.
  let currentTable = root;

  // #2760 CR5 finding 2 — track shape and definition status of every path so
  // we can reject duplicate header redeclarations, shape mismatches, and
  // duplicate keys per real TOML 1.0 semantics. Without this, walkPath
  // silently reuses existing tables and assignment overwrites existing keys —
  // a real TOML parser would refuse the file.
  //
  // pathShape: dotted path -> 'table' | 'array' | 'inline_parent' | 'key'
  //   - 'table' — declared via [a.b]
  //   - 'array' — declared via [[a.b]] (path is the array itself; each
  //               element is its own implicit table)
  //   - 'inline_parent' — created implicitly while walking parents
  //   - 'key'   — assigned a scalar value
  // declaredHeaders: set of dotted paths explicitly declared via [hdr] (not
  //   [[arr]]) — used to reject duplicate [a] / [a] sections.
  // tableKeys: dotted-path -> Set<string> of keys assigned in that exact
  //   table instance. For [[arr]] elements we use a per-element marker.
  const pathShape = new Map();
  const declaredHeaders = new Set();
  const tableKeys = new Map();
  // currentTableId — string identifier for the current table instance, used
  // as the key into tableKeys so that key uniqueness is per-table-instance
  // (each [[arr]] element gets its own id).
  let currentTableId = '__root__';
  pathShape.set('__root__', 'table');
  tableKeys.set('__root__', new Set());

  function ensureKeySet(id) {
    if (!tableKeys.has(id)) tableKeys.set(id, new Set());
    return tableKeys.get(id);
  }

  function walkPath(segments, { creatingArrayElement = false } = {}) {
    let node = root;
    const parents = segments.slice(0, -1);
    const last = segments[segments.length - 1];

    for (let p = 0; p < parents.length; p += 1) {
      const seg = parents[p];
      const partialPath = parents.slice(0, p + 1).join('.');
      if (node[seg] === undefined) {
        node[seg] = {};
        if (!pathShape.has(partialPath)) {
          pathShape.set(partialPath, 'inline_parent');
        }
      } else if (Array.isArray(node[seg])) {
        // Walk into the latest element of an array-of-tables.
        node = node[seg][node[seg].length - 1];
        continue;
      } else if (typeof node[seg] !== 'object' || node[seg] === null) {
        throw new Error(`path segment ${seg} is not a table`);
      }
      node = node[seg];
    }

    const fullPath = segments.join('.');

    if (creatingArrayElement) {
      const existingShape = pathShape.get(fullPath);
      if (node[last] === undefined) {
        node[last] = [];
        pathShape.set(fullPath, 'array');
      } else if (!Array.isArray(node[last])) {
        throw new Error(
          `duplicate or shape-mismatched table header at ${fullPath}: ` +
          `cannot redefine as array of tables (previously seen as ${existingShape || 'table'})`
        );
      } else if (existingShape && existingShape !== 'array') {
        throw new Error(
          `duplicate or shape-mismatched table header at ${fullPath}: ` +
          `previously seen as ${existingShape}, cannot extend as array of tables`
        );
      }
      const elem = {};
      node[last].push(elem);
      const elemId = `${fullPath}[${node[last].length - 1}]`;
      pathShape.set(elemId, 'array_element');
      tableKeys.set(elemId, new Set());
      currentTableId = elemId;
      return elem;
    }

    // Plain [table] header.
    if (node[last] === undefined) {
      node[last] = {};
      pathShape.set(fullPath, 'table');
      declaredHeaders.add(fullPath);
      tableKeys.set(fullPath, new Set());
    } else if (Array.isArray(node[last])) {
      throw new Error(
        `duplicate or shape-mismatched table header at ${fullPath}: ` +
          `previously declared as array of tables ([[${fullPath}]]), cannot redeclare as table ([${fullPath}])`
      );
    } else if (typeof node[last] !== 'object') {
      throw new Error(`cannot redefine ${fullPath} as table`);
    } else if (declaredHeaders.has(fullPath)) {
      throw new Error(
        `duplicate or shape-mismatched table header at ${fullPath}: ` +
          `[${fullPath}] declared more than once`
      );
    } else {
      // Implicitly created earlier (e.g., as a parent path); first explicit
      // declaration is allowed.
      pathShape.set(fullPath, 'table');
      declaredHeaders.add(fullPath);
      if (!tableKeys.has(fullPath)) tableKeys.set(fullPath, new Set());
    }
    currentTableId = fullPath;
    return node[last];
  }

  for (let idx = 0; idx < records.length; idx += 1) {
    const rec = records[idx];
    if (rec.startsInMultilineString) continue;
    if (rec.tableHeader) {
      const segs = rec.tableHeader.segments;
      currentTable = walkPath(segs, { creatingArrayElement: rec.tableHeader.array });
      continue;
    }

    const trimmed = rec.text.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const equalsIndex = findTomlAssignmentEquals(rec.text);
    if (equalsIndex === -1) continue;

    const keyText = rec.text.slice(0, equalsIndex).trim();
    const segments = parseTomlKeyPath(keyText);
    if (!segments) {
      throw new Error(`invalid TOML key on line ${idx + 1}: ${rec.text}`);
    }

    // Value RHS may span multiple lines (inline arrays, multi-line strings,
    // inline tables). Parse from the absolute content offset right after `=`.
    const valueStartAbs = rec.start + equalsIndex + 1;
    const parsed = parseTomlValue(content, valueStartAbs);

    // #2760 CR4 finding 3 — verify the full RHS was consumed. Anything other
    // than whitespace + optional # comment between parsed.end and the next
    // newline (or EOF) means the parser silently accepted a prefix and
    // dropped trailing bytes. Reject so malformed TOML cannot slip past
    // "parse before commit" guarantees.
    let scan = parsed.end;
    while (scan < content.length && (content[scan] === ' ' || content[scan] === '\t')) {
      scan += 1;
    }
    if (scan < content.length && content[scan] !== '\n' && content[scan] !== '\r' && content[scan] !== '#') {
      const lineEnd = content.indexOf('\n', scan);
      const trailing = content.slice(scan, lineEnd === -1 ? content.length : lineEnd);
      throw new Error(
        `trailing bytes after value on line ${idx + 1}: ${JSON.stringify(trailing)}`
      );
    }

    // Place value into currentTable under dotted key.
    // #2760 CR5 finding 2 — reject duplicate keys per real TOML 1.0. Track
    // the dotted key against the current table instance id; an exact repeat
    // throws.
    let target = currentTable;
    for (let s = 0; s < segments.length - 1; s += 1) {
      const seg = segments[s];
      if (target[seg] === undefined) target[seg] = {};
      else if (typeof target[seg] !== 'object' || Array.isArray(target[seg])) {
        throw new Error(`cannot descend into non-table key ${seg}`);
      }
      target = target[seg];
    }
    const finalKey = segments[segments.length - 1];
    const dottedKey = segments.join('.');
    const keySet = ensureKeySet(currentTableId);
    if (keySet.has(dottedKey) || Object.prototype.hasOwnProperty.call(target, finalKey)) {
      throw new Error(
        `duplicate key ${dottedKey} in ${currentTableId === '__root__' ? 'root table' : currentTableId}`
      );
    }
    keySet.add(dottedKey);
    target[finalKey] = parsed.value;
  }

  return root;
}

/**
 * Validate that the post-install config.toml matches Codex's expected schema
 * (#2760, fix 3). Returns { ok: true } on success, or { ok: false, reason }
 * with a human-readable explanation of the offending section.
 *
 * Strategy: parse the bytes into a structured object first — malformed TOML
 * fails validation immediately rather than slipping past a header-only scan.
 * Then enforce the schema-shape rules against the parsed structure.
 *
 * Schema rules enforced:
 *   - File MUST parse as TOML (no syntax errors).
 *   - `agents` MUST be a struct table (`[agents.<name>]`) — never a bare
 *     table value or an array of tables.
 *   - `hooks.<Event>` MUST be an array of tables when present (Codex ≥0.124
 *     rejects bare `[hooks.<Event>]` single-bracket maps).
 */
/**
 * True when a bare `[agents]` table body contains ONLY known AgentsToml scalar
 * keys (CODEX_AGENTS_TOML_SCALAR_KEYS) — i.e. it is a valid AgentsToml struct
 * that Codex's `deny_unknown_fields` will accept, not the break-causing form
 * (#2760) that carries an unknown key. Comments and blank lines are ignored; an
 * empty body is trivially valid. Mirrors isLegacyGsdAgentsSection's line scan.
 */
function codexBareAgentsHasOnlyKnownScalars(body) {
  const lineRecords = getTomlLineRecords(body);
  for (const record of lineRecords) {
    // Conservative reject of anything not positively a single known-scalar
    // assignment. A multiline-string value cannot be a valid AgentsToml scalar
    // (max_threads/max_depth/job_max_runtime_seconds are integers,
    // interrupt_message is a bool — none are strings), so codex would reject it
    // too; rejecting here is correct, not a false negative.
    if (record.startsInMultilineString) return false;
    if (record.tableHeader) return false;
    const trimmed = record.text.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!record.keySegments || record.keySegments.length !== 1 ||
        !CODEX_AGENTS_TOML_SCALAR_KEYS.has(record.keySegments[0])) {
      return false;
    }
  }
  return true;
}

function validateCodexConfigSchema(content) {
  let parsed;
  try {
    parsed = parseTomlToObject(content);
  } catch (e) {
    return {
      ok: false,
      reason: `TOML parse failed: ${e.message}`,
    };
  }

  // Header-shape check: arrays-of-tables are visible in the parsed structure
  // (as Array values) but bare-vs-struct distinction for `[agents]` requires
  // looking at section headers too — `[agents]` with `default = "x"` parses
  // to `{ agents: { default: 'x' } }`, indistinguishable from
  // `[agents.foo]` writing into the same shape. Use header sections to
  // disambiguate.
  const sections = getTomlTableSections(content);

  for (const section of sections) {
    if (section.array && section.path === 'agents') {
      return {
        ok: false,
        reason: '[[agents]] sequence form is invalid in current Codex schema (expected [agents.<name>] struct form)',
      };
    }

    if (!section.array && section.path === 'agents') {
      // #2760 rejected ALL bare `[agents]` tables because a bare table holding a
      // non-AgentsToml key (`default = "x"`, a role name, etc.) triggers Codex's
      // "invalid type: ..., expected struct AgentsToml" and breaks every CLI
      // invocation. But a bare `[agents]` whose keys are all valid AgentsToml
      // scalars (max_depth/max_threads/...) IS a valid struct — that is exactly
      // GSD's managed `max_depth` dispatch-tuning block (ADR-1239 upgrade 2 /
      // #2088), and a user's own scalar tuning. Permit known-scalar-only; still
      // reject any bare `[agents]` carrying an unknown key.
      const body = content.slice(section.headerEnd, section.end);
      if (!codexBareAgentsHasOnlyKnownScalars(body)) {
        return {
          ok: false,
          reason: 'bare [agents] table with a non-AgentsToml key is invalid in current Codex schema (expected [agents.<name>] struct form, or only AgentsToml scalars like max_depth/max_threads)',
        };
      }
    }

    // hooks.state.* is Codex's persistent hook-trust namespace (added in
    // Codex CLI 0.130.0). It uses regular-table shape, NOT array-of-tables.
    // [[hooks.state]] or [[hooks.state.<key>]] (AoT) is invalid; reject it.
    if (section.array && (section.path === 'hooks.state' || section.path.startsWith('hooks.state.'))) {
      return {
        ok: false,
        reason: `[[${section.path}]] is invalid; hooks.state namespace must use regular tables`,
      };
    }

    // All other hooks.* paths (event handlers like hooks.SessionStart) require
    // AoT shape — bare [hooks.<Event>] (single-bracket) is invalid.
    if (!section.array && section.path.startsWith('hooks.') &&
        section.path !== 'hooks.state' && !section.path.startsWith('hooks.state.')) {
      return {
        ok: false,
        reason: `bare [${section.path}] table is invalid in current Codex schema (expected [[${section.path}]] array-of-tables)`,
      };
    }
  }

  // Structural confirmation against parsed object: any present hooks.<Event>
  // must be an array, and flat top-level [[hooks]] (parsed as Array on root)
  // is rejected — Codex 0.124.0+ requires [[hooks.<Event>]] namespaced form.
  if (parsed.hooks !== undefined) {
    if (Array.isArray(parsed.hooks)) {
      return {
        ok: false,
        reason: 'flat [[hooks]] array-of-tables is invalid in Codex 0.124.0+ (expected [[hooks.<Event>]] namespaced form)',
      };
    }
    if (typeof parsed.hooks === 'object' && parsed.hooks !== null) {
      for (const [event, value] of Object.entries(parsed.hooks)) {
        // hooks.state is Codex's persistent hook-trust namespace — a regular
        // object (table), not an array of event-handler tables.
        // Reject AoT shape (Array) and scalar forms; only plain objects are valid.
        if (event === 'state') {
          if (Array.isArray(value)) {
            return {
              ok: false,
              reason: `hooks.state must be a regular table/object, got array-of-tables`,
            };
          }
          if (typeof value !== 'object' || value === null) {
            return {
              ok: false,
              reason: `hooks.state must be a regular table/object, got ${typeof value}`,
            };
          }
          continue;
        }
        // Skip the nested .hooks sub-array — it lives under hooks.<Event>[n].hooks
        // and is validated separately below.
        if (!Array.isArray(value)) {
          return {
            ok: false,
            reason: `hooks.${event} must be an array of tables, got ${typeof value}`,
          };
        }
        // Each entry in hooks.<Event> must either be a matcher-only filter (no
        // handler fields) or carry a .hooks sub-array of handler tables.
        // Entries with handler fields (command, type, timeout, statusMessage) at
        // event-entry level but without a .hooks sub-table are the pre-#2773
        // single-block shape that Codex 0.124.0+ rejects. migrateCodexHooksMapFormat
        // converts these before validation runs; their presence here means migration
        // failed to cover this entry — fail loudly rather than pass a broken config.
        const HANDLER_FIELD_NAMES = new Set(['command', 'type', 'timeout', 'statusMessage']);
        for (const entry of value) {
          if (!entry || typeof entry !== 'object') continue;
          if (entry.hooks === undefined) {
            const strayKey = Object.keys(entry).find((k) => HANDLER_FIELD_NAMES.has(k));
            if (strayKey) {
              return {
                ok: false,
                reason: `hooks.${event}[] entry has handler field "${strayKey}" at event-entry level; ` +
                  `Codex 0.124.0+ requires handler fields nested under [[hooks.${event}.hooks]]`,
              };
            }
            continue;
          }
          if (!Array.isArray(entry.hooks)) {
            return {
              ok: false,
              reason: `hooks.${event}[].hooks must be an array of handler tables, got ${typeof entry.hooks}`,
            };
          }
          for (const handler of entry.hooks) {
            if (handler && typeof handler === 'object' && handler.type !== undefined) {
              if (handler.type !== 'command') {
                return {
                  ok: false,
                  reason: `hooks.${event}[].hooks[].type must be "command", got "${handler.type}"`,
                };
              }
            }
          }
        }
      }
    }
  }

  return { ok: true };
}

function normalizeCodexHooksLine(line, key) {
  const leadingWhitespace = line.match(/^\s*/)[0];
  const commentStart = findTomlCommentStart(line);
  const comment = commentStart === -1 ? '' : line.slice(commentStart);
  return `${leadingWhitespace}${key} = true${comment ? ` ${comment}` : ''}`;
}

function findTomlAssignmentBlockEnd(content, record) {
  const equalsIndex = findTomlAssignmentEquals(record.text);
  if (equalsIndex === -1) {
    return record.end + record.eol.length;
  }

  let i = record.start + equalsIndex + 1;
  let arrayDepth = 0;
  let inlineTableDepth = 0;

  while (i < content.length) {
    if (content.startsWith('\'\'\'', i)) {
      const closeIndex = content.indexOf('\'\'\'', i + 3);
      if (closeIndex === -1) {
        return content.length;
      }
      i = closeIndex + 3;
      continue;
    }

    if (content.startsWith('"""', i)) {
      const closeIndex = findMultilineBasicStringClose(content, i + 3);
      if (closeIndex === -1) {
        return content.length;
      }
      i = closeIndex + 3;
      continue;
    }

    const ch = content[i];

    if (ch === '\'') {
      i += 1;
      while (i < content.length) {
        if (content[i] === '\'') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === '"') {
      i += 1;
      while (i < content.length) {
        if (content[i] === '\\') {
          i += 2;
          continue;
        }
        if (content[i] === '"') {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    if (ch === '[') {
      arrayDepth += 1;
      i += 1;
      continue;
    }

    if (ch === ']') {
      if (arrayDepth > 0) {
        arrayDepth -= 1;
      }
      i += 1;
      continue;
    }

    if (ch === '{') {
      inlineTableDepth += 1;
      i += 1;
      continue;
    }

    if (ch === '}') {
      if (inlineTableDepth > 0) {
        inlineTableDepth -= 1;
      }
      i += 1;
      continue;
    }

    if (ch === '#') {
      while (i < content.length && content[i] !== '\n') {
        i += 1;
      }
      continue;
    }

    if (ch === '\n' && arrayDepth === 0 && inlineTableDepth === 0) {
      return i + 1;
    }

    i += 1;
  }

  return content.length;
}

function rewriteTomlKeyLines(content, matches, key) {
  if (matches.length === 0) {
    return content;
  }

  let rewritten = '';
  let cursor = 0;

  matches.forEach((match, index) => {
    rewritten += content.slice(cursor, match.start);
    if (index === 0) {
      const blockEnd = findTomlAssignmentBlockEnd(content, match);
      const blockEol = blockEnd > 0 && content[blockEnd - 1] === '\n'
        ? (blockEnd > 1 && content[blockEnd - 2] === '\r' ? '\r\n' : '\n')
        : '';
      // Preserve the existing key when one is present on the line
      // (`match.keyRaw`). This respects user ownership: a user-authored
      // `codex_hooks = true` line stays as `codex_hooks = true` even
      // though `hooks` is the canonical key in current Codex (#3566).
      // Codex's own `legacy_key` alias mechanism in codex-rs handles the
      // backward compat at the runtime layer. Migration to canonical is
      // a fresh-insert-only operation in ensureCodexHooksFeature.
      rewritten += normalizeCodexHooksLine(match.text, match.keyRaw || key) + blockEol;
      cursor = blockEnd;
      return;
    }
    cursor = findTomlAssignmentBlockEnd(content, match);
  });

  rewritten += content.slice(cursor);
  return rewritten;
}

// atomicWriteFileSync and __atomicWrittenTmps are now owned by the
// runtime-hooks-surface module and imported here so both install.js's
// direct config.toml writes and the module's Cursor/Codex hooks.json
// writes share the SAME tracking Set. _cleanTmpFiles() below reads
// hooksSurface.__atomicWrittenTmps to scope cleanup to installer-owned
// temps only.
const atomicWriteFileSync = hooksSurface.atomicWriteFileSync;
const __atomicWrittenTmps = hooksSurface.__atomicWrittenTmps;

/**
 * Merge GSD config block into an existing or new config.toml.
 * Three cases: new file, existing with GSD marker, existing without marker.
 *
 * All writes go through atomicWriteFileSync so a mid-write failure leaves
 * the original config.toml untouched (#2760 fix 4).
 */
/**
 * Split TOML content into its leading TOP-LEVEL key lines and everything from
 * the first table header onward (#3610).
 *
 * Top-level keys were file-scoped before a merge. The regenerated GSD block
 * opens with a table header (`[agents]`, #2088/ADR-1239 upgrade 2), so placing
 * that block ABOVE surviving top-level keys re-scopes them into `[agents]` —
 * `validateCodexConfigSchema` then correctly rejects the merged file and the
 * install aborts. Hoisting the keys above the block preserves their scope.
 *
 * Table headers inside multiline strings do not start the "rest" region (the
 * record parser already excludes them via startsInMultilineString).
 */
function splitTopLevelKeys(content) {
  for (const record of getTomlLineRecords(content)) {
    if (record.tableHeader && !record.startsInMultilineString) {
      return {
        topLevel: content.slice(0, record.start).trim(),
        rest: content.slice(record.start).trim(),
      };
    }
  }
  return { topLevel: content.trim(), rest: '' };
}

function mergeCodexConfig(configPath, gsdBlock) {
  // Case 1: No config.toml — create fresh
  if (!fs.existsSync(configPath)) {
    atomicWriteFileSync(configPath, gsdBlock + '\n');
    return;
  }

  const existing = fs.readFileSync(configPath, 'utf8');
  const eol = detectLineEnding(existing);
  // #2088 review: the bare `[agents]` table is purged below (Case 2/3 via
  // stripLeakedGsdCodexSections) to keep a single managed `[agents]`. Preserve
  // the user's own AgentsToml scalar tuning (max_threads, job_max_runtime_seconds,
  // interrupt_message — everything except GSD-managed max_depth) by re-emitting
  // it inside the managed block, so install never silently drops it.
  const mergedGsdBlock = spliceCodexAgentsScalars(gsdBlock, extractCodexUserAgentsScalars(existing));
  const normalizedGsdBlock = mergedGsdBlock.replace(/\r?\n/g, eol);
  const markerIndex = existing.indexOf(GSD_CODEX_MARKER);

  // Case 2: Has GSD marker — preserve user content on BOTH sides, regenerate the GSD block.
  //
  // #2940: the marker delimits where GSD's OWN block begins, NOT where every post-marker byte
  // is GSD-owned. A fresh install writes the GSD block as the file's entire content, so any
  // settings the user or Codex CLI later adds ([model], [mcp_servers.*], [profiles.*]) land
  // AFTER the block. The previous truncate-to-marker logic discarded that trailing region on
  // every update, destroying user config. The fix routes the trailing region through the
  // existing AST-based `stripLeakedGsdCodexSections`, which removes GSD's own managed/leaked
  // sections (the bare [agents] table GSD regenerates, legacy [agents.gsd-*], [[agents]])
  // while preserving genuine user TOML — so #2406's de-dup still holds AND user content survives.
  if (markerIndex !== -1) {
    let before = existing.substring(0, markerIndex).trimEnd();
    if (before) {
      // Strip any GSD-managed sections that leaked above the marker from previous installs
      before = stripLeakedGsdCodexSections(before).trimEnd();
    }
    // Capture and preserve genuine user content AFTER the GSD-managed region. The whole
    // post-marker region is passed through stripLeakedGsdCodexSections: GSD's own previously-
    // emitted [agents] table (regenerated above as normalizedGsdBlock) and any leaked sections
    // are removed, while user tables ([model], [mcp_servers.*], [profiles.*]) are kept. The
    // marker comment line itself (and the optional codex_hooks ownership line right under it)
    // is GSD-owned and is stripped from the trailing region so it is not duplicated alongside
    // the freshly regenerated block.
    const rawAfter = existing.substring(markerIndex);
    const markerStripped = rawAfter
      .replace(GSD_CODEX_MARKER, '')
      .replace(/^\r?\n# GSD codex_hooks ownership: (?:section|root_dotted)\r?\n/, '');
    const afterUser = stripLeakedGsdCodexSections(markerStripped).trim();

    // #3610: top-level keys that survived BELOW the marker were file-scoped
    // before this merge; the regenerated block opens with the `[agents]` table
    // header, so they must be hoisted to FILE scope or TOML re-scopes them
    // into a table. File scope means BEFORE the first table header of the
    // pre-marker region too — appending them after a pre-marker table (the
    // default real-world layout: user tables precede the marker) would merely
    // capture them into THAT table instead of [agents], and the schema
    // validator is blind to non-agents tables.
    const beforeSplit = before ? splitTopLevelKeys(before) : { topLevel: '', rest: '' };
    const { topLevel: afterTopLevel, rest: afterTables } = splitTopLevelKeys(afterUser);

    const parts = [];
    const topParts = [];
    if (beforeSplit.topLevel) topParts.push(beforeSplit.topLevel);
    if (afterTopLevel) topParts.push(afterTopLevel);
    if (topParts.length > 0) parts.push(topParts.join(eol + eol));
    if (beforeSplit.rest) parts.push(beforeSplit.rest);
    parts.push(normalizedGsdBlock);
    if (afterTables) parts.push(afterTables);
    atomicWriteFileSync(configPath, parts.join(eol + eol) + eol);
    return;
  }

  // Case 3: No marker — append GSD block
  let content = stripLeakedGsdCodexSections(existing).trimEnd();
  if (content) {
    content = content + eol + eol + normalizedGsdBlock + eol;
  } else {
    content = normalizedGsdBlock + eol;
  }

  atomicWriteFileSync(configPath, content);
}

/**
 * Repair config.toml files corrupted by pre-#1346 GSD installs.
 * Non-boolean keys (e.g. model = "gpt-5.4") that ended up under [features]
 * are relocated before the [features] header so Codex can parse them correctly.
 * Returns the content unchanged if no trapped keys are found.
 */
function repairTrappedFeaturesKeys(content) {
  const eol = detectLineEnding(content);
  const lineRecords = getTomlLineRecords(content);
  const featuresSection = getTomlTableSections(content)
    .find((section) => !section.array && section.path === 'features');

  if (!featuresSection) {
    return content;
  }

  // Find non-boolean key-value lines inside [features] that don't belong there.
  // Boolean keys (codex_hooks, multi_agent, etc.) are legitimate feature flags.
  const trappedLines = lineRecords.filter((record) => {
    if (record.tableHeader || record.startsInMultilineString) return false;
    if (record.tablePath !== 'features') return false;
    if (record.start < featuresSection.headerEnd) return false;
    if (record.end + record.eol.length > featuresSection.end) return false;
    if (!record.keySegments || record.keySegments.length === 0) return false;

    // Check if the value is a boolean — if so, it belongs under [features]
    const equalsIndex = findTomlAssignmentEquals(record.text);
    if (equalsIndex === -1) return false;
    const commentStart = findTomlCommentStart(record.text);
    const valueText = record.text
      .slice(equalsIndex + 1, commentStart === -1 ? record.text.length : commentStart)
      .trim();
    if (valueText === 'true' || valueText === 'false') return false;

    // Skip values that start a multiline string — they may legitimately live
    // under [features] and spanning multiple lines makes relocation unsafe.
    if (valueText.startsWith("'''") || valueText.startsWith('"""')) return false;

    // Non-boolean value — this key is trapped
    return true;
  });

  if (trappedLines.length === 0) {
    return content;
  }

  // Build the relocated text block from trapped lines
  const relocatedText = trappedLines.map((r) => r.text).join(eol) + eol;

  // Remove trapped lines from their current positions (with their EOLs)
  const removalRanges = trappedLines.map((r) => ({
    start: r.start,
    end: r.end + r.eol.length,
  }));
  let cleaned = removeContentRanges(content, removalRanges);

  // Collapse any runs of 3+ blank lines left behind
  cleaned = collapseTomlBlankLines(cleaned);

  // Re-locate the [features] header in the cleaned content
  const cleanedRecords = getTomlLineRecords(cleaned);
  const cleanedFeaturesHeader = cleanedRecords.find(
    (r) => r.tableHeader && r.tableHeader.path === 'features' && !r.tableHeader.array
  );

  if (!cleanedFeaturesHeader) {
    return cleaned;
  }

  // Insert relocated keys before [features]
  const before = cleaned.slice(0, cleanedFeaturesHeader.start);
  const after = cleaned.slice(cleanedFeaturesHeader.start);
  const needsGap = before.length > 0 && !before.endsWith(eol + eol);
  const trailingGap = after.length > 0 && !relocatedText.endsWith(eol + eol) ? eol : '';

  return before + (needsGap ? eol : '') + relocatedText + trailingGap + after;
}

function ensureCodexHooksFeature(configContent) {
  const eol = detectLineEnding(configContent);
  const lineRecords = getTomlLineRecords(configContent);

  const featuresSection = getTomlTableSections(configContent)
    .find((section) => !section.array && section.path === 'features');

  if (featuresSection) {
    const sectionLines = lineRecords
      .filter((record) =>
        !record.tableHeader &&
        !record.startsInMultilineString &&
        record.tablePath === 'features' &&
        record.start >= featuresSection.headerEnd &&
        record.end + record.eol.length <= featuresSection.end &&
        record.keySegments &&
        record.keySegments.length === 1 &&
        isCodexHooksFeatureKey(record.keySegments[0])
      );

    if (sectionLines.length > 0) {
      // Rewrite to canonical key — this migrates legacy `codex_hooks` to
      // `hooks` in-place on every reinstall. If the file already has the
      // canonical key the rewrite is a no-op shape-wise (same key, same
      // value). The rewriteTomlKeyLines helper preserves indentation,
      // trailing comments, and ownership-marker positioning, and always
      // emits the caller-supplied canonical key (#3566).
      const rewritten = rewriteTomlKeyLines(configContent, sectionLines, CODEX_HOOKS_FEATURE_KEY);
      return {
        content: repairTrappedFeaturesKeys(rewritten),
        ownership: null,
      };
    }

    const sectionBody = configContent.slice(featuresSection.headerEnd, featuresSection.end);
    const needsSeparator = sectionBody.length > 0 && !sectionBody.endsWith('\n') && !sectionBody.endsWith('\r\n');
    const insertPrefix = sectionBody.length === 0 && featuresSection.headerEnd === configContent.length ? eol : '';
    const insertText = `${insertPrefix}${needsSeparator ? eol : ''}${CODEX_HOOKS_FEATURE_KEY} = true${eol}`;
    const merged = configContent.slice(0, featuresSection.end) + insertText + configContent.slice(featuresSection.end);
    return {
      content: repairTrappedFeaturesKeys(merged),
      ownership: 'section',
    };
  }

  const rootFeatureLines = lineRecords
    .filter((record) =>
      !record.tableHeader &&
      !record.startsInMultilineString &&
      record.tablePath === null &&
      record.keySegments &&
      record.keySegments[0] === 'features'
    );

  const rootCodexHooksLines = rootFeatureLines
    .filter((record) => record.keySegments.length === 2 && isCodexHooksFeatureKey(record.keySegments[1]));

  if (rootCodexHooksLines.length > 0) {
    return {
      content: rewriteTomlKeyLines(configContent, rootCodexHooksLines, `features.${CODEX_HOOKS_FEATURE_KEY}`),
      ownership: null,
    };
  }

  const rootFeaturesValueLines = rootFeatureLines
    .filter((record) => record.keySegments.length === 1);

  if (rootFeaturesValueLines.length > 0) {
    return { content: configContent, ownership: null };
  }

  if (rootFeatureLines.length > 0) {
    const lastFeatureLine = rootFeatureLines[rootFeatureLines.length - 1];
    const insertAt = findTomlAssignmentBlockEnd(configContent, lastFeatureLine);
    const prefix = insertAt > 0 && configContent[insertAt - 1] === '\n' ? '' : eol;
    return {
      content: configContent.slice(0, insertAt) +
        `${prefix}features.${CODEX_HOOKS_FEATURE_KEY} = true${eol}` +
        configContent.slice(insertAt),
      ownership: 'root_dotted',
    };
  }

  const featuresBlock = `[features]${eol}${CODEX_HOOKS_FEATURE_KEY} = true${eol}`;
  if (!configContent) {
    return { content: featuresBlock, ownership: 'section' };
  }
  // Insert [features] before the first table header, preserving bare top-level keys.
  // Prepending would trap them under [features] where Codex expects only booleans (#1202).
  const firstTableHeader = lineRecords.find(r => r.tableHeader);
  if (firstTableHeader) {
    const before = configContent.slice(0, firstTableHeader.start);
    const after = configContent.slice(firstTableHeader.start);
    const needsGap = before.length > 0 && !before.endsWith(eol + eol);
    return {
      content: before + (needsGap ? eol : '') + featuresBlock + eol + after,
      ownership: 'section',
    };
  }
  // No table headers — append [features] after top-level keys
  const needsGap = configContent.length > 0 && !configContent.endsWith(eol + eol);
  return { content: configContent + (needsGap ? eol : '') + featuresBlock, ownership: 'section' };
}

function hasEnabledCodexHooksFeature(configContent) {
  const lineRecords = getTomlLineRecords(configContent);

  return lineRecords.some((record) => {
    if (record.tableHeader || record.startsInMultilineString || !record.keySegments) {
      return false;
    }

    const isSectionKey = record.tablePath === 'features' &&
      record.keySegments.length === 1 &&
      isCodexHooksFeatureKey(record.keySegments[0]);
    const isRootDottedKey = record.tablePath === null &&
      record.keySegments.length === 2 &&
      record.keySegments[0] === 'features' &&
      isCodexHooksFeatureKey(record.keySegments[1]);

    if (!isSectionKey && !isRootDottedKey) {
      return false;
    }

    const equalsIndex = findTomlAssignmentEquals(record.text);
    if (equalsIndex === -1) {
      return false;
    }

    const commentStart = findTomlCommentStart(record.text);
    const valueText = record.text.slice(equalsIndex + 1, commentStart === -1 ? record.text.length : commentStart).trim();
    return valueText === 'true';
  });
}

/**
 * Merge GSD instructions into copilot-instructions.md.
 * Three cases: new file, existing with markers, existing without markers.
 * @param {string} filePath - Full path to copilot-instructions.md
 * @param {string} gsdContent - Template content (without markers)
 */
function mergeCopilotInstructions(filePath, gsdContent) {
  const gsdBlock = GSD_COPILOT_INSTRUCTIONS_MARKER + '\n' +
    gsdContent.trim() + '\n' +
    GSD_COPILOT_INSTRUCTIONS_CLOSE_MARKER;

  // Case 1: No file — create fresh
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, gsdBlock + '\n');
    return;
  }

  const existing = fs.readFileSync(filePath, 'utf8');
  const openIndex = existing.indexOf(GSD_COPILOT_INSTRUCTIONS_MARKER);
  const closeIndex = existing.indexOf(GSD_COPILOT_INSTRUCTIONS_CLOSE_MARKER);

  // Case 2: Has GSD markers — replace between markers
  if (openIndex !== -1 && closeIndex !== -1) {
    const before = existing.substring(0, openIndex).trimEnd();
    const after = existing.substring(closeIndex + GSD_COPILOT_INSTRUCTIONS_CLOSE_MARKER.length).trimStart();
    let newContent = '';
    if (before) newContent += before + '\n\n';
    newContent += gsdBlock;
    if (after) newContent += '\n\n' + after;
    newContent += '\n';
    fs.writeFileSync(filePath, newContent);
    return;
  }

  // Case 3: No markers — append at end
  const content = existing.trimEnd() + '\n\n' + gsdBlock + '\n';
  fs.writeFileSync(filePath, content);
}

/**
 * Strip GSD section from copilot-instructions.md content.
 * Returns cleaned content, or null if file should be deleted (was GSD-only).
 * @param {string} content - File content
 * @returns {string|null} - Cleaned content or null if empty
 */
function stripGsdFromCopilotInstructions(content) {
  const openIndex = content.indexOf(GSD_COPILOT_INSTRUCTIONS_MARKER);
  const closeIndex = content.indexOf(GSD_COPILOT_INSTRUCTIONS_CLOSE_MARKER);

  if (openIndex !== -1 && closeIndex !== -1) {
    const before = content.substring(0, openIndex).trimEnd();
    const after = content.substring(closeIndex + GSD_COPILOT_INSTRUCTIONS_CLOSE_MARKER.length).trimStart();
    const cleaned = (before + (before && after ? '\n\n' : '') + after).trim();
    if (!cleaned) return null;
    return cleaned + '\n';
  }

  // No markers found — nothing to strip
  return content;
}

// ── Cline directory-form rules + hooks + AGENTS.md (issue #787) ────────────────
//
// Cline v3.36 added a hooks system and a `.clinerules/` directory form. Because
// `.clinerules` cannot be both a file AND a directory, emitting hooks under
// `.clinerules/hooks/` requires migrating the rules content into the directory
// form (`.clinerules/gsd.md`). Sources adjudicated:
//   - https://cline.bot/blog/cline-v3-36-hooks
//   - https://docs.cline.bot/customization/cline-rules

const GSD_AGENTS_MD_MARKER = '<!-- GSD Configuration — managed by gsd-core installer -->';
const GSD_AGENTS_MD_CLOSE_MARKER = '<!-- End GSD Configuration -->';

// #2876: buildClineRulesBody, buildClineAgentsMdBody, buildClinePreToolUseHook,
// and mergeGsdAgentsMd used to be re-bound here as one-line delegates to the
// equivalent hooksSurface.* implementations. None had an install.js internal
// caller or an export consumer (tests import all four directly from
// gsd-core/bin/lib/runtime-hooks-surface.cjs), so the retired bindings were
// dead code with no reachable body — removed rather than kept as unreachable
// wrappers.

/**
 * Strip the GSD block from AGENTS.md content. Returns null if the file became
 * empty (was GSD-only), the unchanged content if no markers were found, or the
 * cleaned content otherwise.
 */
function stripGsdFromAgentsMd(content) {
  const openIndex = content.indexOf(GSD_AGENTS_MD_MARKER);
  const closeIndex = content.indexOf(GSD_AGENTS_MD_CLOSE_MARKER);
  if (openIndex !== -1 && closeIndex !== -1) {
    const before = content.substring(0, openIndex).trimEnd();
    const after = content.substring(closeIndex + GSD_AGENTS_MD_CLOSE_MARKER.length).trimStart();
    const cleaned = (before + (before && after ? '\n\n' : '') + after).trim();
    if (!cleaned) return null;
    return cleaned + '\n';
  }
  return content;
}

/**
 * Write the full Cline runtime artifact set (directory-form rules + PreToolUse
 * hook) into targetDir, migrating a legacy single-file `.clinerules` if present.
 * For global installs, also merge the cross-tool ~/.agents/AGENTS.md target.
 *
 * Returns the list of manifest-relative paths written under targetDir (so the
 * caller can hash-track them).
 */
function writeClineArtifacts(targetDir, isGlobalInstall) {
  return hooksSurface.writeClineArtifacts(targetDir, isGlobalInstall);
}

// ── Cursor hooks.json reconciler (issue #777) ────────────────────────────────
//
// Cursor v2.4+ supports a hooks.json lifecycle hook system. GSD registers two
// managed command hooks:
//   sessionStart → gsd-cursor-session-start.js  (context injection)
//   postToolUse  → gsd-cursor-post-tool.js       (STATE.md update monitor)
//
// hooks.json schema:
//   { "version": 1, "hooks": { "<event>": [ { "type": "command", "command": "<path>" } ] } }
//
// Location:
//   Global:  ~/.cursor/hooks.json
//   Local:   <project-root>/.cursor/hooks.json
//
// GSD entries are identified by a top-level `"gsd-managed": true` field on
// each hook entry. Non-GSD entries are preserved. The reconciler is idempotent
// (safe to re-run) and preserves user-owned entries in the file.
//
// References: https://cursor.com/docs/hooks

// #2876: buildCursorHookEntry, isManagedCursorHookEntry, and
// reconcileCursorHooksJson used to be re-bound here as one-line delegates to
// the equivalent hooksSurface.* implementations. None had an install.js
// internal caller or an export consumer (tests import all three directly from
// gsd-core/bin/lib/runtime-hooks-surface.cjs), so the retired bindings were
// dead code with no reachable body — removed rather than kept as unreachable
// wrappers.

/**
 * #777 — Write GSD-managed Cursor lifecycle hooks into <targetDir>/hooks.json.
 *
 * Both managed hook scripts (gsd-cursor-session-start.js, gsd-cursor-post-tool.js)
 * are copied from the GSD hooks/ source to <targetDir>/hooks/ first, so the
 * hooks.json entries never reference a script that wasn't installed.
 *
 * @param {string} targetDir - The Cursor config dir (global: ~/.cursor; local: .cursor)
 * @param {string} src       - The GSD install source root (for copying hook scripts)
 * @param {{ absoluteRunner?: string|null }} opts
 * @returns {{ hooksJsonPath: string, changed: boolean }}
 */
function writeCursorHooksJson(targetDir, src, opts) {
  return hooksSurface.writeCursorHooksJson(targetDir, src, opts);
}

/**
 * Remove all GSD-managed Cursor lifecycle hook entries from hooks.json.
 * User-owned entries are preserved. If the file becomes empty, it is removed.
 *
 * @param {string} targetDir - The Cursor config dir
 * @returns {{ changed: boolean }}
 */
function removeCursorHooksJson(targetDir) {
  return hooksSurface.removeCursorHooksJson(targetDir);
}

/**
 * #2100 Stage 2 — Write GSD-managed Windsurf/Cascade lifecycle hooks into
 * <targetDir>/hooks.json. Both managed hook scripts
 * (gsd-windsurf-pre-write.js, gsd-windsurf-pre-command.js) are copied from
 * the GSD hooks/ source to <targetDir>/hooks/ first, so the hooks.json
 * entries never reference a script that wasn't installed. Mirrors
 * writeCursorHooksJson's structure; Cascade's blocking protocol (exit code 2)
 * and entry shape (bare `command` string, no `type` field) are distinct from
 * Cursor's.
 *
 * @param {string} targetDir - The Windsurf config dir (global: ~/.codeium/windsurf; local: .windsurf)
 * @param {string} src       - The GSD install source root (for copying hook scripts)
 * @param {{ platform?: string }} opts
 * @returns {{ hooksJsonPath: string, changed: boolean }}
 */
function writeWindsurfHooksJson(targetDir, src, opts) {
  return hooksSurface.writeWindsurfHooksJson(targetDir, src, opts);
}

/**
 * Remove all GSD-managed Windsurf/Cascade lifecycle hook entries from
 * hooks.json. User-owned entries are preserved. If the file becomes empty,
 * it is removed.
 *
 * @param {string} targetDir - The Windsurf config dir
 * @returns {{ changed: boolean }}
 */
function removeWindsurfHooksJson(targetDir) {
  return hooksSurface.removeWindsurfHooksJson(targetDir);
}

// #2876: buildCopilotHookConfig used to be re-bound here as a one-line
// delegate to hooksSurface.buildCopilotHookConfig. It had no install.js
// internal caller or export consumer (tests import it directly from
// gsd-core/bin/lib/runtime-hooks-surface.cjs), so the retired binding was
// dead code with no reachable body — removed rather than kept as an
// unreachable wrapper. writeCopilotHookConfig below is unaffected — it still
// has an internal caller (finishInstall).

/**
 * #786 — Write the GSD-managed Copilot lifecycle hook config under the runtime
 * config dir (`<targetDir>/hooks/gsd-session.json`). For local installs
 * targetDir is `.github` (→ `.github/hooks/`); for global installs it is
 * `~/.copilot` (→ `~/.copilot/hooks/`) — both are valid Copilot hook locations.
 *
 * The managed file is fully owned by GSD, so it is overwritten wholesale on
 * every install (idempotent). User-authored sibling `*.json` hook files in the
 * same directory are untouched.
 *
 * @param {string} targetDir - The Copilot config dir
 * @returns {string} The path the hook config was written to
 */
function writeCopilotHookConfig(targetDir) {
  return hooksSurface.writeCopilotHookConfig(targetDir);
}

/**
 * Generate config.toml and per-agent .toml files for Codex.
 * Reads agent .md files from source, extracts metadata, writes .toml configs.
 */

/**
 * #2834: Write ~/.gsd/defaults.json for non-Claude runtimes — sets
 * resolve_model_ids="omit" (so resolveModelInternal() returns '' instead of
 * Claude aliases the runtime can't resolve) and runtime=<runtime> (so
 * resolveRuntime() resolves correctly out of the box). MUST be called BEFORE
 * installCodexConfig (or any other step that reads defaults.json at generation
 * time), so a clean first install produces correctly-model-routed agent TOMLs.
 * No-op for Claude runtimes (Claude is the resolveRuntime fallback + has native
 * model aliases). Preserves an explicit `true` opt-in and existing values.
 */
function writeNonClaudeDefaults(runtime) {
  if (_hostBehaviors(runtime).nativeModelAliases || process.env.GSD_TEST_MODE) return;
  const gsdDir = path.join(os.homedir(), '.gsd');
  const defaultsPath = path.join(gsdDir, 'defaults.json');
  try {
    fs.mkdirSync(gsdDir, { recursive: true });
    let defaults = {};
    try { defaults = JSON.parse(fs.readFileSync(defaultsPath, 'utf8')); } catch { /* new file */ }
    if (defaults === null || typeof defaults !== 'object' || Array.isArray(defaults)) {
      defaults = {};
    }
    // Three-valued domain: false/absent → aliases; true → full IDs; "omit" → ''.
    const existing = defaults.resolve_model_ids;
    const shouldDefaultToOmit = existing !== true && existing !== 'omit';
    if (shouldDefaultToOmit) {
      defaults.resolve_model_ids = 'omit';
      fs.writeFileSync(defaultsPath, JSON.stringify(defaults, null, 2) + '\n');
      console.log(`  ${green}✓${reset} Set resolve_model_ids: "omit" in ~/.gsd/defaults.json`);
    }
    // #2395: persist runtime for non-Claude runtimes.
    if (defaults.runtime === undefined || defaults.runtime === null || defaults.runtime === '') {
      defaults.runtime = runtime;
      fs.writeFileSync(defaultsPath, JSON.stringify(defaults, null, 2) + '\n');
      console.log(`  ${green}✓${reset} Set runtime: "${runtime}" in ~/.gsd/defaults.json`);
    }
  } catch (e) {
    console.log(`  ${yellow}⚠${reset} Could not write ~/.gsd/defaults.json: ${e.message}`);
  }
}

function installCodexConfig(targetDir, agentsSrc, sandboxTier = 'codex-agent-sandbox') {
  // ADR-1239 Phase B write-confinement: every Codex config write stays under targetDir.
  const configPath = assertDestWithinConfigHome(targetDir, 'config.toml');
  const agentsTomlDir = assertDestWithinConfigHome(targetDir, 'agents');
  const resolvedTargetRoot = path.resolve(targetDir);
  // Symlink-escape guard (parity with _copyStaged / copyWithPathReplacement): the
  // lexical gate above does not resolve symlinks, so a pre-existing config.toml or
  // agents/ symlink could redirect writes outside targetDir. Reject those.
  // #2393: honor GSD_ALLOW_SYMLINKED_DEST for intentional user-owned symlink layouts.
  const symlinkOptIn = isSymlinkedDestOptIn();
  if (
    hasExistingSymlinkBetween(resolvedTargetRoot, configPath, { allowOptInFollow: symlinkOptIn }) ||
    hasExistingSymlinkBetween(resolvedTargetRoot, path.resolve(agentsTomlDir), { allowOptInFollow: symlinkOptIn })
  ) {
    throw new Error(
      `installCodexConfig: a Codex config path under "${targetDir}" contains a symlink the install root does not trust — refusing to write. If this is an intentional user-owned symlink layout, re-run with GSD_ALLOW_SYMLINKED_DEST=1.`,
    );
  }
  fs.mkdirSync(agentsTomlDir, { recursive: true });

  const agentEntries = fs.readdirSync(agentsSrc).filter(f => f.startsWith('gsd-') && f.endsWith('.md'));
  const agents = [];

  // Compute the Codex GSD install path (absolute, so subagents with empty $HOME work — #820)
  const codexGsdPath = `${path.resolve(targetDir, 'gsd-core').replace(/\\/g, '/')}/`;

  for (const file of agentEntries) {
    const agentTomlSourcePath = path.join(agentsSrc, file);
    let content = fs.readFileSync(agentTomlSourcePath, 'utf8');
    // #2995 (epic #1671 Phase 6.4): Codex embeds each agent's prompt into a
    // per-agent `.toml`, reading the source .md independently of the inline
    // agent loop — a separate emission path that must strip gsd:section
    // markers too, or a marked agent ships its markers inside the TOML.
    // Found by the exhaustive per-runtime emission sweep in
    // tests/agent-fragments-emission.install.test.cjs, not by call-graph
    // analysis, which is why that guard is behavioral rather than structural.
    content = composeWorkflow(content, { sourcePath: agentTomlSourcePath });
    // Replace full .claude/gsd-core prefix so path resolves to the Codex
    // GSD install before generic .claude → .codex conversion rewrites it.
    content = content.replace(/~\/\.claude\/gsd-core\//g, codexGsdPath);
    content = content.replace(/\$HOME\/\.claude\/gsd-core\//g, codexGsdPath);
    // Route TOML emit through the same full Claude→Codex conversion pipeline
    // used on the `.md` emit path (#2639). Covers: slash-command rewrites,
    // $ARGUMENTS → {{GSD_ARGS}}, /clear removal, anchored and bare .claude/
    // paths, .claudeignore → .codexignore, and standalone "Claude" /
    // CLAUDE.md neutralization via neutralizeAgentReferences(..., 'AGENTS.md').
    content = convertClaudeToCodexMarkdown(content);
    const { frontmatter } = extractFrontmatterAndBody(content);
    const name = extractFrontmatterField(frontmatter, 'name') || file.replace('.md', '');
    const description = extractFrontmatterField(frontmatter, 'description') || '';

    agents.push({ name, description: toSingleLine(description) });

    // Pass model overrides from both per-project `.planning/config.json` and
    // `~/.gsd/defaults.json` (project wins on conflict) so Codex TOML files
    // embed the configured model — Codex cannot receive model inline (#2256).
    // Previously only the global file was read, which silently dropped the
    // per-project override the reporter had set for gsd-codebase-mapper.
    // #2517 — also pass the runtime-aware tier resolver so profile tiers can
    // resolve to Codex-native model IDs + reasoning_effort when `runtime: "codex"`
    // is set in defaults.json.
    const modelOverrides = readGsdEffectiveModelOverrides(targetDir);
    // Pass `targetDir` so per-project .planning/config.json wins over global
    // ~/.gsd/defaults.json — without this, the PR's headline claim that
    // setting runtime in the project config reaches the Codex emit path is
    // false (review finding #1).
    const runtimeResolver = readGsdRuntimeProfileResolver(targetDir);
    // #443 — pass unified effort config so model_reasoning_effort in the .toml
    // follows the same config-driven precedence as the Claude .md effort key.
    const effortCfg = readGsdEffectiveEffortConfig(targetDir);
    const tomlContent = generateCodexAgentToml(name, content, modelOverrides, runtimeResolver, effortCfg, sandboxTier);
    // Confine the per-agent write to the agents/ dir itself: a crafted agent
    // `name` containing path separators must not escape agents/ (which would let
    // it clobber config.toml or write elsewhere under the configHome).
    const agentTomlPath = assertDestWithinConfigHome(agentsTomlDir, `${name}.toml`);
    if (hasExistingSymlinkBetween(resolvedTargetRoot, agentTomlPath, { allowOptInFollow: symlinkOptIn })) {
      throw new Error(
        `installCodexConfig: agent toml path "${agentTomlPath}" contains a symlink the install root does not trust — refusing to write. If this is an intentional user-owned symlink layout, re-run with GSD_ALLOW_SYMLINKED_DEST=1.`,
      );
    }
    fs.writeFileSync(agentTomlPath, tomlContent);
  }

  const gsdBlock = generateCodexConfigBlock(agents, targetDir);
  mergeCodexConfig(configPath, gsdBlock);

  return agents.length;
}

/**
 * Runtime-neutral agent name and instruction file replacement.
 * Used by ALL non-Claude runtime converters to avoid Claude-specific
 * references in workflow prompts, agent definitions, and documentation.
 *
 * Replaces:
 * - Standalone "Claude" (agent name) → "the agent"
 *   Preserves: "Claude Code" (product), "Claude Opus/Sonnet/Haiku" (models),
 *   "claude-" (prefixes), "CLAUDE.md" (handled separately)
 * - "CLAUDE.md" → runtime-appropriate instruction file
 * - "Do NOT load full AGENTS.md" → removed (harmful for AGENTS.md runtimes)
 *
 * @param {string} content - File content to neutralize
 * @param {string} instructionFile - Runtime's instruction file ('AGENTS.md', 'GEMINI.md', etc.)
 * @returns {string} Content with runtime-neutral references
 */
function neutralizeAgentReferences(content, instructionFile) {
  let c = content;
  // Replace standalone "Claude" (the agent) but preserve product/model names.
  // Negative lookahead avoids: Claude Code, Claude Opus/Sonnet/Haiku, Claude native, Claude-based
  c = c.replace(/\bClaude(?! Code| Opus| Sonnet| Haiku| native| based|-)\b(?!\.md)/g, 'the agent');
  // Replace CLAUDE.md with runtime-appropriate instruction file
  if (instructionFile) {
    c = c.replace(/CLAUDE\.md/g, instructionFile);
  }
  // Remove instructions that conflict with AGENTS.md-based runtimes
  c = c.replace(/Do NOT load full `AGENTS\.md` files[^\n]*/g, '');
  return c;
}

function convertClaudeToOpencodeFrontmatter(content, { isAgent = false, modelOverride = null } = {}) {
  // Replace tool name references in content (applies to all files)
  let convertedContent = content;
  convertedContent = convertedContent.replace(/\bAskUserQuestion\b/g, 'question');
  convertedContent = convertedContent.replace(/\bSlashCommand\b/g, 'skill');
  convertedContent = convertedContent.replace(/\bTodoWrite\b/g, 'todowrite');
  // Replace /gsd-command colon variant with /gsd-command for opencode (flat command structure)
  convertedContent = convertedContent.replace(/\/gsd:/g, '/gsd-');
  // Replace ~/.claude and $HOME/.claude with OpenCode's config location
  convertedContent = convertedContent.replace(/~\/\.claude\b/g, '~/.config/opencode');
  convertedContent = convertedContent.replace(/\$HOME\/\.claude\b/g, '$HOME/.config/opencode');
  // Replace general-purpose subagent type with OpenCode's equivalent "general"
  convertedContent = convertedContent.replace(/subagent_type="general-purpose"/g, 'subagent_type="general"');
  // Runtime-neutral agent name replacement (#766)
  convertedContent = neutralizeAgentReferences(convertedContent, 'AGENTS.md');

  // Check if content has frontmatter
  if (!convertedContent.startsWith('---')) {
    return convertedContent;
  }

  // Find the end of frontmatter
  const endIndex = convertedContent.indexOf('---', 3);
  if (endIndex === -1) {
    return convertedContent;
  }

  const frontmatter = convertedContent.substring(3, endIndex).trim();
  const body = convertedContent.substring(endIndex + 3);

  // Parse frontmatter line by line (simple YAML parsing)
  const lines = frontmatter.split('\n');
  const newLines = [];
  let inAllowedTools = false;
  let inSkippedArray = false;
  const allowedTools = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // For agents: skip commented-out lines (e.g. hooks blocks)
    if (isAgent && trimmed.startsWith('#')) {
      continue;
    }

    // Detect start of allowed-tools array
    if (trimmed.startsWith('allowed-tools:')) {
      inAllowedTools = true;
      continue;
    }

    // Detect inline tools: field (comma-separated string)
    if (trimmed.startsWith('tools:')) {
      if (isAgent) {
        // Agents: strip tools entirely (not supported in OpenCode agent frontmatter)
        inSkippedArray = true;
        continue;
      }
      const toolsValue = trimmed.substring(6).trim();
      if (toolsValue) {
        // Parse comma-separated tools
        const tools = toolsValue.split(',').map(t => t.trim()).filter(t => t);
        allowedTools.push(...tools);
      }
      continue;
    }

    // For agents: strip skills:, color:, memory:, maxTurns:, permissionMode:, disallowedTools:
    if (isAgent && /^(skills|color|memory|maxTurns|permissionMode|disallowedTools):/.test(trimmed)) {
      inSkippedArray = true;
      continue;
    }

    // Skip continuation lines of a stripped array/object field
    if (inSkippedArray) {
      if (trimmed.startsWith('- ') || trimmed.startsWith('#') || /^\s/.test(line)) {
        continue;
      }
      inSkippedArray = false;
    }

    // For commands: remove name: field (opencode uses filename for command name)
    // For agents: keep name: (required by OpenCode agents)
    if (!isAgent && trimmed.startsWith('name:')) {
      continue;
    }

    // Strip model: field — OpenCode doesn't support Claude Code model aliases
    // like 'haiku', 'sonnet', 'opus', or 'inherit'. Omitting lets OpenCode use
    // its configured default model. See #1156.
    if (trimmed.startsWith('model:')) {
      continue;
    }

    // Convert color names to hex for opencode (commands only; agents strip color above)
    if (trimmed.startsWith('color:')) {
      const colorValue = trimmed.substring(6).trim().toLowerCase();
      const hexColor = colorNameToHex[colorValue];
      if (hexColor) {
        newLines.push(`color: "${hexColor}"`);
      } else if (colorValue.startsWith('#')) {
        // Validate hex color format (#RGB or #RRGGBB)
        if (/^#[0-9a-f]{3}$|^#[0-9a-f]{6}$/i.test(colorValue)) {
          // Already hex and valid, keep as is
          newLines.push(line);
        }
        // Skip invalid hex colors
      }
      // Skip unknown color names
      continue;
    }

    // Collect allowed-tools items
    if (inAllowedTools) {
      if (trimmed.startsWith('- ')) {
        allowedTools.push(trimmed.substring(2).trim());
        continue;
      } else if (trimmed && !trimmed.startsWith('-')) {
        // End of array, new field started
        inAllowedTools = false;
      }
    }

    // Keep other fields
    if (!inAllowedTools) {
      newLines.push(line);
    }
  }

  // For agents: add required OpenCode agent fields
  // Note: Do NOT add 'model: inherit' — OpenCode does not recognize the 'inherit'
  // keyword and throws ProviderModelNotFoundError. Omitting model: lets OpenCode
  // use its default model for subagents. See #1156.
  if (isAgent) {
    newLines.push('mode: subagent');
    // Embed model override from ~/.gsd/defaults.json so model_overrides is
    // respected on OpenCode (which uses static agent frontmatter, not inline
    // Task() model parameters). See #2256.
    if (modelOverride) {
      newLines.push(`model: ${modelOverride}`);
    }
  }

  // For commands: add tools object if we had allowed-tools or tools
  if (!isAgent && allowedTools.length > 0) {
    newLines.push('tools:');
    for (const tool of allowedTools) {
      newLines.push(`  ${convertToolName(tool)}: true`);
    }
  }

  // Rebuild frontmatter (body already has tool names converted)
  const newFrontmatter = newLines.join('\n').trim();
  return `---\n${newFrontmatter}\n---${body}`;
}

// Kilo CLI — same conversion logic as OpenCode, different config paths.
// DEFECT.GENERATIVE-FIX: this body is mirrored in
// src/runtime-artifact-conversion.cts's convertClaudeToKiloFrontmatter (used by
// src/install-engine.cts's install path). Neither copy re-exports the other —
// mirror any behavior change into both. Guarded by the output-parity test in
// tests/runtime-converters.test.cjs (#2093).
function convertClaudeToKiloFrontmatter(content, { isAgent = false, modelOverride = null } = {}) {
  // Replace tool name references in content (applies to all files)
  let convertedContent = content;
  convertedContent = convertedContent.replace(/\bAskUserQuestion\b/g, 'question');
  convertedContent = convertedContent.replace(/\bSlashCommand\b/g, 'skill');
  convertedContent = convertedContent.replace(/\bTodoWrite\b/g, 'todowrite');
  // Replace /gsd-command colon variant with /gsd-command for Kilo (flat command structure)
  convertedContent = convertedContent.replace(/\/gsd:/g, '/gsd-');
  // Replace ~/.claude and $HOME/.claude with Kilo's config location
  convertedContent = convertedContent.replace(/~\/\.claude\b/g, '~/.config/kilo');
  convertedContent = convertedContent.replace(/\$HOME\/\.claude\b/g, '$HOME/.config/kilo');
  convertedContent = convertedContent.replace(/\.\/\.claude\//g, './.kilo/');
  // Normalize both Claude skill directory variants to Kilo's canonical skills dir.
  convertedContent = replaceRelativePathReference(convertedContent, '.claude/skills/', '.kilo/skills/');
  convertedContent = replaceRelativePathReference(convertedContent, '.agents/skills/', '.kilo/skills/');
  convertedContent = replaceRelativePathReference(convertedContent, '.claude/agents/', '.kilo/agents/');
  // Replace general-purpose subagent type with Kilo's equivalent "general"
  convertedContent = convertedContent.replace(/subagent_type="general-purpose"/g, 'subagent_type="general"');
  // Runtime-neutral agent name replacement (#766)
  convertedContent = neutralizeAgentReferences(convertedContent, 'AGENTS.md');

  // Check if content has frontmatter
  if (!convertedContent.startsWith('---')) {
    return convertedContent;
  }

  // Find the end of frontmatter
  const endIndex = convertedContent.indexOf('---', 3);
  if (endIndex === -1) {
    return convertedContent;
  }

  const frontmatter = convertedContent.substring(3, endIndex).trim();
  const body = convertedContent.substring(endIndex + 3);

  // Parse frontmatter line by line (simple YAML parsing)
  const lines = frontmatter.split('\n');
  const newLines = [];
  let inAllowedTools = false;
  let inAgentTools = false;
  let inSkippedArray = false;
  const allowedTools = [];
  const agentTools = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // For agents: skip commented-out lines (e.g. hooks blocks)
    if (isAgent && trimmed.startsWith('#')) {
      continue;
    }

    // Detect start of allowed-tools array
    if (trimmed.startsWith('allowed-tools:')) {
      inAllowedTools = true;
      continue;
    }

    if (isAgent && inAgentTools) {
      if (trimmed.startsWith('- ')) {
        agentTools.push(trimmed.substring(2).trim());
        continue;
      }
      if (trimmed && !trimmed.startsWith('-')) {
        inAgentTools = false;
      }
    }

    // Detect inline tools: field (comma-separated string)
    if (trimmed.startsWith('tools:')) {
      if (isAgent) {
        const toolsValue = trimmed.substring(6).trim();
        if (toolsValue) {
          const tools = toolsValue.split(',').map(t => t.trim()).filter(t => t);
          agentTools.push(...tools);
        } else {
          inAgentTools = true;
        }
        continue;
      }
      const toolsValue = trimmed.substring(6).trim();
      if (toolsValue) {
        // Parse comma-separated tools
        const tools = toolsValue.split(',').map(t => t.trim()).filter(t => t);
        allowedTools.push(...tools);
      }
      continue;
    }

    // For agents: strip skills:, color:, memory:, maxTurns:, permissionMode:, disallowedTools:
    if (isAgent && /^(skills|color|memory|maxTurns|permissionMode|disallowedTools):/.test(trimmed)) {
      inSkippedArray = true;
      continue;
    }

    // Skip continuation lines of a stripped array/object field
    if (inSkippedArray) {
      if (trimmed.startsWith('- ') || trimmed.startsWith('#') || /^\s/.test(line)) {
        continue;
      }
      inSkippedArray = false;
    }

    // For commands: remove name: field (Kilo uses filename for command name)
    // For agents: keep name: (required by Kilo agents)
    if (!isAgent && trimmed.startsWith('name:')) {
      continue;
    }

    // Strip model: field — Kilo doesn't support Claude Code model aliases
    // like 'haiku', 'sonnet', 'opus', or 'inherit'. Omitting lets Kilo use
    // its configured default model.
    if (trimmed.startsWith('model:')) {
      continue;
    }

    // Convert color names to hex for Kilo (commands only; agents strip color above)
    if (trimmed.startsWith('color:')) {
      const colorValue = trimmed.substring(6).trim().toLowerCase();
      const hexColor = colorNameToHex[colorValue];
      if (hexColor) {
        newLines.push(`color: "${hexColor}"`);
      } else if (colorValue.startsWith('#')) {
        // Validate hex color format (#RGB or #RRGGBB)
        if (/^#[0-9a-f]{3}$|^#[0-9a-f]{6}$/i.test(colorValue)) {
          // Already hex and valid, keep as is
          newLines.push(line);
        }
        // Skip invalid hex colors
      }
      // Skip unknown color names
      continue;
    }

    // Collect allowed-tools items
    if (inAllowedTools) {
      if (trimmed.startsWith('- ')) {
        const tool = trimmed.substring(2).trim();
        if (isAgent) {
          agentTools.push(tool);
        } else {
          allowedTools.push(tool);
        }
        continue;
      } else if (trimmed && !trimmed.startsWith('-')) {
        // End of array, new field started
        inAllowedTools = false;
      }
    }

    // Keep other fields
    if (!inAllowedTools) {
      newLines.push(line);
    }
  }

  // For agents: add required Kilo agent fields
  if (isAgent) {
    newLines.push('mode: subagent');
    // Embed model override from ~/.gsd/defaults.json so model_overrides is
    // respected on Kilo (which uses static agent frontmatter, not inline
    // Task() model parameters) — mirrors convertClaudeToOpencodeFrontmatter's
    // model emission exactly (#2093 UPGRADE 2 / ADR-1239). See #2256.
    if (modelOverride) {
      newLines.push(['model:', modelOverride].join(' '));
    }
    newLines.push(...buildKiloAgentPermissionBlock(agentTools));
  }

  // For commands: add tools object if we had allowed-tools or tools
  if (!isAgent && allowedTools.length > 0) {
    newLines.push('tools:');
    for (const tool of allowedTools) {
      newLines.push(`  ${convertToolName(tool)}: true`);
    }
  }

  // Rebuild frontmatter (body already has tool names converted)
  const newFrontmatter = newLines.join('\n').trim();
  return `---\n${newFrontmatter}\n---${body}`;
}

// convertClaudeCommandToOpencodeFamilySkill, convertClaudeCommandToOpencodeSkill,
// convertClaudeCommandToKiloSkill: moved to src/install-engine.cts (ADR-1239 Phase B).
// #2876 found no install.js internal caller for the latter two (tests import
// them directly from gsd-core/bin/lib/install-engine.cjs) and retired the
// destructured bindings above.

// applyOpencodeFamilyPathPrefix: moved to src/install-engine.cts (ADR-1239 Phase B).
// #2876 found no install.js internal caller (never had one either — it was
// never part of this module's export surface) and retired the destructured
// binding above.
//
// copyFlattenedCommands (OpenCode/Kilo flattened command/ writer): moved to
// src/install-engine.cts as installOpencodeFamilyCommands (ADR-1239 / #2087).
// OpenCode/Kilo installs now route through installRuntimeArtifacts's
// combinedFamilyInstall path (installOpencodeFamilyArtifacts) instead of the
// bespoke inline block that used to call this function.

function listCodexSkillNames(skillsDir, prefix = 'gsd-') {
  if (!fs.existsSync(skillsDir)) return [];
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix))
    .filter(entry => fs.existsSync(path.join(skillsDir, entry.name, 'SKILL.md')))
    .map(entry => entry.name)
    .sort();
}

/**
 * Generic skills install helper used by all copyCommandsAs*Skills shims.
 *
 * Recursively walks srcDir, applies converter to each .md file (mirroring the
 * old per-function recurse() bodies), applies runtime content rewrites
 * (path + branding), and writes each skill as <prefix>-<stem>/SKILL.md under
 * skillsDir. Replaces the ~50-line recursion bodies in the 9 old functions.
 *
 * @param {string} srcDir          source commands directory
 * @param {string} skillsDir       destination skills directory
 * @param {string} prefix          skill name prefix without trailing dash (e.g. 'gsd')
 * @param {string} pathPrefix      trailing-slash path prefix for content rewrites
 * @param {string} runtime         canonical runtime ID for rewrite table
 * @param {Function} converter     wrapped converter (content, skillName) → string
 */



/**
 * Copy Claude commands as Windsurf skills — one folder per skill with SKILL.md.
 * Mirrors copyCommandsAsCursorSkills but uses Windsurf converters.
 */


/**
 * Copy Claude commands as CodeBuddy skills — one folder per skill with SKILL.md.
 * CodeBuddy uses the same tool names as Claude Code, but has its own config directory structure.
 */

/**
 * Copy Claude commands as Copilot skills — one folder per skill with SKILL.md.
 * Applies CONV-01 (structure), CONV-02 (allowed-tools), CONV-06 (paths), CONV-07 (command names).
 */

/**
 * Copy Claude commands as Claude skills — one folder per skill with SKILL.md.
 * Claude Code 2.1.88+ uses skills/xxx/SKILL.md instead of commands/gsd/xxx.md.
 * Supports runtime='claude'|'qwen'|'hermes'; branding rewrites are applied via
 * applyRuntimeContentRewritesInPlace inside _copyCommandsAsSkillsViaConverter.
 * @param {string} srcDir - Source commands directory
 * @param {string} skillsDir - Target skills directory
 * @param {string} prefix - Skill name prefix (e.g. 'gsd')
 * @param {string} pathPrefix - Path prefix for file references
 * @param {string} runtime - Target runtime
 * @param {boolean} isGlobal - Whether this is a global install (unused; kept for compat)
 */

/**
 * Write the Hermes "gsd" category DESCRIPTION.md.
 * Hermes' skill loader reads DESCRIPTION.md at the top of each skill category
 * directory and surfaces it in the system prompt so the model knows when to
 * reach for that category. Per spec in #2841 we collapse all 86 GSD commands
 * under a single "gsd" category to keep system-prompt overhead bounded.
 */
function writeHermesCategoryDescription(categoryDir) {
  fs.mkdirSync(categoryDir, { recursive: true });
  const body = [
    '---',
    'name: gsd',
    `version: ${pkg.version}`,
    'description: GSD Core — Git. Ship. Done. Disciplined planning, execution, and shipping workflows. Use any gsd-* skill in this category to drive a project through new-project → discuss-phase → plan-phase → execute-phase → ship.',
    '---',
    '',
    '# GSD Core',
    '',
    'GSD is a structured development workflow. Skills in this category cover',
    'project initialization, phase planning, execution, code review, and shipping.',
    '',
    'Invoke any `gsd-*` skill in this category to drive the corresponding step.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(categoryDir, 'DESCRIPTION.md'), body);
}

/**
 * Recursively install GSD commands as Antigravity skills.
 * Each command becomes a skill-name/ folder containing SKILL.md.
 * Mirrors copyCommandsAsCopilotSkills but uses Antigravity converters.
 * @param {string} srcDir - Source commands directory
 * @param {string} skillsDir - Target skills directory
 * @param {string} prefix - Skill name prefix (e.g. 'gsd')
 * @param {boolean} isGlobal - Whether this is a global install
 */

// USER_OWNED_ARTIFACTS, migrateLegacyDevPreferencesToSkill, _snapshotDir,
// installRuntimeArtifacts, installOpencodeFamilySkills, uninstallRuntimeArtifacts:
// ALL moved to src/install-engine.cts (ADR-1239 Phase B). Imported from
// installEngine above. _copyStaged, _removeGsdEntries,
// _runLegacyInstallMigrations, _runLegacyUninstallCleanup, _restoreDir, and
// _removeHermesBareStemDirs moved there too but #2876 found no install.js
// internal caller for any of them and retired their destructured bindings.

// ---------------------------------------------------------------------------
// Phase 2 — Layout-driven install/uninstall orchestrators (moved to engine)
// _applyRuntimeRewrites / _stampNonClaudeRuntimeDefaults remain here for
// call sites in copyWithPathReplacement (not moved).
// ---------------------------------------------------------------------------
const _applyRuntimeRewrites = runtimeArtifactConversion._applyRuntimeRewrites;
const _stampNonClaudeRuntimeDefaults = runtimeArtifactConversion._stampNonClaudeRuntimeDefaults;

/**
 * Data-driven dispatch table for copyWithPathReplacement (ADR-1239 Phase B).
 * Keyed by runtime id. Each entry declares ONLY what that runtime does differently.
 * The DEFAULT (no entry, or entry with no md/js key) = identity transform after
 * the uniform steps — covers claude, augment, codebuddy, kimi, etc.
 *
 * Entry shape:
 *   mdSkipGenericRewrite?: boolean  — skip the ~/.claude/ rewrite block (copilot, antigravity)
 *   md?: (content, ctx) => string   — per-runtime .md transform
 *   mdReattributeAfter?: boolean    — re-run processAttribution after md() (copilot, antigravity)
 *   mdTomlRenameOnCommand?: boolean — when isCommand, rename dest .md → .toml
 *                                     (unused since the gemini runtime was removed, #1928;
 *                                     kept as generic dispatch infra for a future TOML-command runtime)
 *   js?: (content, ctx) => string   — per-runtime .cjs/.js transform (absent = plain copyFileSync)
 *
 * ctx = { isCommand, isGlobal, dirName, pathPrefix, entryName, runtime }
 */
const RUNTIME_CONTENT_DISPATCH = {
  opencode: {
    md: (content) => convertClaudeToOpencodeFrontmatter(content),
  },
  kilo: {
    md: (content) => convertClaudeToKiloFrontmatter(content),
  },
  codex: {
    md: (content) => convertClaudeToCodexMarkdown(content),
  },
  copilot: {
    mdSkipGenericRewrite: true,
    md: (content, ctx) => convertClaudeToCopilotContent(content, ctx.isGlobal),
    mdReattributeAfter: true,
    js: (content, ctx) => convertClaudeToCopilotContent(content, ctx.isGlobal),
  },
  antigravity: {
    mdSkipGenericRewrite: true,
    md: (content, ctx) => convertClaudeToAntigravityContent(content, ctx.isGlobal),
    mdReattributeAfter: true,
    js: (content, ctx) => convertClaudeToAntigravityContent(content, ctx.isGlobal),
  },
  cursor: {
    md: (content) => convertClaudeToCursorMarkdown(content),
    js: (content) => {
      content = content.replace(/gsd:/gi, 'gsd-');
      content = content.replace(/\.claude\/skills\//g, '.cursor/skills/');
      content = content.replace(/CLAUDE\.md/g, '.cursor/rules/');
      content = content.replace(/\bClaude Code\b/g, 'Cursor');
      return content;
    },
  },
  windsurf: {
    md: (content) => convertClaudeToWindsurfMarkdown(content),
    js: (content) => {
      // Workspace skills install to .devin/ (Devin Desktop preferred dir, #1085).
      content = content.replace(/gsd:/gi, 'gsd-');
      content = content.replace(/\.claude\/skills\//g, '.devin/skills/');
      content = content.replace(/CLAUDE\.md/g, '.devin/rules');
      content = content.replace(/\bClaude Code\b/g, 'Windsurf');
      return content;
    },
  },
  trae: {
    md: (content) => convertClaudeToTraeMarkdown(content),
    js: (content) => {
      content = content.replace(/\/gsd:([a-z0-9-]+)/g, (_, commandName) => {
        return `/gsd-${commandName}`;
      });
      content = content.replace(/\.claude\/skills\//g, '.trae/skills/');
      // #2658: the full dot-claude-slash-prefixed instruction-file path must
      // be replaced before the bare instruction-filename fallback, or the
      // bare regex only rewrites that filename and leaves the prefix stale
      // in place, producing a malformed doubled-prefix path (see the longer
      // note in convertClaudeToTraeMarkdown above — the instruction filename
      // and either malformed shape are deliberately never spelled out
      // contiguously here either, for the same reason: this file ships
      // verbatim). Both forms target the same concrete file (never a bare
      // directory), matching the `.md` converter (convertClaudeToTraeMarkdown)
      // so js/cjs and md content agree on one canonical path.
      content = content.replace(/\.claude\/CLAUDE\.md/g, '.trae/rules/rules.md');
      content = content.replace(/CLAUDE\.md/g, '.trae/rules/rules.md');
      content = content.replace(/\bClaude Code\b/g, 'Trae');
      return content;
    },
  },
  cline: {
    md: (content) => convertClaudeToCliineMarkdown(content),
    js: (content) => {
      content = content.replace(/\.claude\/skills\//g, '.cline/skills/');
      content = content.replace(/CLAUDE\.md/g, '.clinerules');
      content = content.replace(/\bClaude Code\b/g, 'Cline');
      return content;
    },
  },
  // qwen/hermes: brand VALUES are descriptor-driven (ADR-1239 / #2092) via
  // _hostBehaviors(ctx.runtime).brandingRewrites — EXACT regexes/ordering
  // preserved from the prior hardcoded-literal versions (including the
  // qwen-specific `.claude/skills/` -> `.qwen/skills/` pre-rewrite, whose
  // target is derived as `${b['.claude/']}skills/`).
  qwen: {
    md: (content, ctx) => {
      // Guarded (post-review #2092): degrade closed to a no-op if the
      // registry fails to load, instead of throwing on `b['CLAUDE.md']`.
      const b = _hostBehaviors(ctx.runtime).brandingRewrites;
      if (b) {
        content = content.replace(/CLAUDE\.md/g, b['CLAUDE.md']);
        // #2284(b): skips <runtime_compatibility> comparison-table content (protected region).
        content = applyClaudeCodeBrandSwap(content, b['Claude Code']);
        content = content.replace(/\.claude\//g, b['.claude/']);
      }
      return content;
    },
    js: (content, ctx) => {
      const b = _hostBehaviors(ctx.runtime).brandingRewrites;
      if (b) {
        content = content.replace(/\.claude\/skills\//g, `${b['.claude/']}skills/`);
        content = content.replace(/\.claude\//g, b['.claude/']);
        content = content.replace(/CLAUDE\.md/g, b['CLAUDE.md']);
        content = content.replace(/\bClaude Code\b/g, b['Claude Code']);
      }
      return content;
    },
  },
  hermes: {
    // #2284: brand-swap alone left the false "Agent tool IS available"
    // assertion + literal `Agent(...)` call syntax installed verbatim — see
    // convertClaudeToHermesMarkdown / projectNamedDispatchToStructuralDelegate
    // above (the Hermes converters section) for the full named-dispatch →
    // `delegate_task` projection, driven by capabilities/hermes/capability.json's
    // hostIntegration.dispatch facts.
    md: (content, ctx) => convertClaudeToHermesMarkdown(content, ctx),
    js: (content, ctx) => {
      const b = _hostBehaviors(ctx.runtime).brandingRewrites;
      if (b) {
        content = content.replace(/\.claude\/skills\//g, `${b['.claude/']}skills/`);
        content = content.replace(/\.claude\//g, b['.claude/']);
        content = content.replace(/CLAUDE\.md/g, b['CLAUDE.md']);
        content = content.replace(/\bClaude Code\b/g, b['Claude Code']);
      }
      return content;
    },
  },
};

/**
 * Recursively copy directory, replacing paths in .md files
 * Deletes existing destDir first to remove orphaned files from previous versions
 * @param {string} srcDir - Source directory
 * @param {string} destDir - Destination directory
 * @param {string} pathPrefix - Path prefix for file references
 * @param {string} runtime - Target runtime ('claude', 'opencode', 'codex')
 * @param {boolean} isCommand - Whether the source is a command directory
 * @param {boolean} isGlobal - Whether the install is global
 */
function copyWithPathReplacement(srcDir, destDir, pathPrefix, runtime, isCommand = false, isGlobal = false, confinementRoot) {
  const dirName = getDirName(runtime);

  // ADR-1239 Phase B write-confinement: refuse to wipe/write a destDir that
  // escapes the caller-declared install root. Runs BEFORE the rmSync below so a
  // crafted destDir can never delete or write outside confinementRoot.
  if (confinementRoot === undefined) {
    throw new Error(
      'copyWithPathReplacement: confinementRoot is required to confine writes to the install root — refusing to write',
    );
  }
  const resolvedConfinementRoot = path.resolve(confinementRoot);
  const resolvedDestDir = assertDestWithinConfigHome(confinementRoot, destDir);
  // #2393: honor GSD_ALLOW_SYMLINKED_DEST for intentional user-owned symlink layouts.
  if (hasExistingSymlinkBetween(resolvedConfinementRoot, resolvedDestDir, { allowOptInFollow: isSymlinkedDestOptIn() })) {
    throw new Error(
      `copyWithPathReplacement: destDir "${destDir}" contains a symlink the install root "${confinementRoot}" does not trust — refusing to write. If this is an intentional user-owned symlink layout, re-run with GSD_ALLOW_SYMLINKED_DEST=1.`,
    );
  }
  // Use the validated absolute path for all writes below so the gate validates
  // exactly what is written (a relative destDir would otherwise resolve to cwd).
  destDir = resolvedDestDir;

  // Clean install: remove existing destination to prevent orphaned files
  if (fs.existsSync(destDir)) {
    fs.rmSync(destDir, { recursive: true });
  }
  fs.mkdirSync(destDir, { recursive: true });

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    // #3333: srcPath was enumerated by readdirSync above, but a filesystem is not
    // transactional — the file it named can vanish between listing and this read
    // (a concurrent process, or another test in this suite writing/cleaning up a
    // fixture inside this same real directory). Treat "gone by the time we get
    // here" as benign and skip it, never a fatal crash of the whole install.
    if (!entry.isDirectory() && !fs.existsSync(srcPath)) {
      continue;
    }

    if (entry.isDirectory()) {
      copyWithPathReplacement(srcPath, destPath, pathPrefix, runtime, isCommand, isGlobal, confinementRoot);
    } else if (entry.name.endsWith('.md')) {
      const dispatch = RUNTIME_CONTENT_DISPATCH[runtime] || {};
      const ctx = { isCommand, isGlobal, dirName, pathPrefix, entryName: entry.name, runtime };

      // Replace ~/.claude/ and $HOME/.claude/ and ./.claude/ with runtime-appropriate paths
      // Skip generic replacement for Copilot/Antigravity — their converters handle all paths
      let content = fs.readFileSync(srcPath, 'utf8');

      // #2930 (epic #1671 Phase 3): strip `<!-- gsd:section -->` markers
      // BEFORE any per-runtime rewrite so a `.claude/` -> `.windsurf/` regex
      // (or any other converter below) never reaches inside a marker
      // attribute and corrupts it. composeWorkflow is a no-op (byte-identical
      // return) for the 88+ workflows and every non-workflow .md that carries
      // no markers, and for a malformed marker it throws loudly naming
      // srcPath — never emit a half-composed workflow.
      //
      // Scoped to gsd-core/workflows/ ONLY (two independent reviewers,
      // chore/2930): copyWithPathReplacement is the emit path for every .md
      // under gsd-core/, skills/, and commands/ (see the three call sites),
      // not just workflows. A doc that merely DOCUMENTS the marker syntax
      // with an unfenced example (docs/reference/workflow-fragments.md is
      // the live instance of this class, though not under the install tree
      // today) would otherwise get silently mis-parsed as a real marker and
      // that line lossily dropped — a file class issue #2930 never scoped
      // to. Path is normalized UNCONDITIONALLY (backslash paths arrive on
      // Linux too — CONTEXT.md path-separator rule) and checked as a
      // path-segment match so the recursive descent (srcPath may be several
      // directory levels below gsd-core/workflows/) is still caught.
      //
      // #3072: the scoping predicate itself now lives in ONE place —
      // shouldCompose (src/mcp-catalog.cts, imported above) — rather than
      // being re-declared inline here. The MCP served catalog calls the
      // SAME function to decide what it composes vs serves verbatim, so this
      // install path and the catalog can never independently drift on what
      // gets composed (ADR-1671:309, DEFECT.GENERATIVE-FIX; the parity gate
      // is tests/mcp-catalog-parity.test.cjs). shouldCompose normalizes with
      // the identical unconditional `.replace(/\\/g, '/')` internally, so
      // this call is behavior-preserving byte-for-behavior with the regex it
      // replaces.
      if (shouldCompose(srcPath)) {
        content = composeWorkflow(content, { sourcePath: srcPath });
      }

      if (!dispatch.mdSkipGenericRewrite) {
        const globalClaudeRegex = /~\/\.claude\//g;
        const globalClaudeHomeRegex = /\$HOME\/\.claude\//g;
        const localClaudeRegex = /\.\/\.claude\//g;
        content = content.replace(globalClaudeRegex, pathPrefix);
        content = content.replace(globalClaudeHomeRegex, pathPrefix);
        content = content.replace(localClaudeRegex, `./${dirName}/`);
        // #3544 review (Finding 1 fallout): guarded with the SAME
        // negative-lookahead convention already used at ~:2859-2860 below
        // ("preserve .claude-plugin and .claudeignore"). A naive `\b` here
        // is satisfied by ANY non-word character, including '-' — so for a
        // --config-dir whose name EXTENDS '.claude' (e.g. '.claude-work',
        // pathPrefix '$HOME/.claude-work/'), this pass re-matched the
        // '$HOME/.claude' PREFIX of its own slash-form output (lines above)
        // and re-appended the full prefix, corrupting every emitted path to
        // '$HOME/.claude-work-work/...'. Harmless no-op for the literal
        // default '.claude' (self-replace with an identical string), which
        // is why this went undetected until a non-default config-dir name
        // was exercised.
        content = content.replace(/~\/\.claude(?![\w-])/g, pathPrefix.replace(/\/$/, ''));
        content = content.replace(/\$HOME\/\.claude(?![\w-])/g, pathPrefix.replace(/\/$/, ''));
        content = content.replace(/\.\/\.claude\b/g, `./${dirName}`);
        content = content.replace(/~\/\.qwen\//g, pathPrefix);
        content = content.replace(/\$HOME\/\.qwen\//g, pathPrefix);
        content = content.replace(/\.\/\.qwen\//g, `./${dirName}/`);
        content = content.replace(/~\/\.hermes\//g, pathPrefix);
        content = content.replace(/\$HOME\/\.hermes\//g, pathPrefix);
        content = content.replace(/\.\/\.hermes\//g, `./${dirName}/`);
        // #3544: restore @-file-reference lines to the tilde form Claude Code
        // actually expands — the SAME correction #3133 already applies to
        // skill/command bodies via _applyRuntimeRewrites's 'claude' case (see
        // restoreClaudeGlobalAtRefTilde's doc comment in
        // runtime-artifact-conversion.cts). This is the gsd-core/ spec-tree
        // emit path, which never had it: every @~/.claude/gsd-core/… include
        // in a global install's workflows/references tree silently resolved
        // to nothing (54 includes across 22 files on a live install).
        if (runtime === 'claude') {
          content = runtimeArtifactConversion._restoreClaudeGlobalAtRefTilde(content, pathPrefix);
        }
      }
      content = processAttribution(content, getCommitAttribution(runtime));

      // #1521: stamp the workflow runtime-resolution block so every non-Claude
      // install resolves its own runtime identity and defaults use_worktrees=false.
      // copyWithPathReplacement is the emit path for gsd-core/workflows/*.md;
      // _applyRuntimeRewrites is NOT invoked here, so this is what makes the fix
      // live in real installs (it is a no-op for files without those lines).
      if (!_hostBehaviors(runtime).authorsCanonicalWorkflow) {
        content = _stampNonClaudeRuntimeDefaults(content, runtime);
      }

      // #3683 — normalize /gsd:<cmd> → /gsd-<cmd> in any body passing through
      // copyWithPathReplacement for runtimes that register commands under the
      // hyphen form; normalizeAgentBodyForRuntime self-gates on
      // shouldNormalizeHyphenNamespaceInAgentBody(runtime) and is a no-op for
      // colon-canonical / self-converting runtimes.
      content = normalizeAgentBodyForRuntime(content, runtime, readGsdCommandNames());

      // Apply per-runtime .md converter (if any)
      if (dispatch.md) content = dispatch.md(content, ctx);

      // Re-run attribution after converter for runtimes that need it (copilot, antigravity)
      if (dispatch.mdReattributeAfter) content = processAttribution(content, getCommitAttribution(runtime));

      // Rename .md → .toml for command files (unused since gemini removal, #1928)
      const finalPath = (dispatch.mdTomlRenameOnCommand && isCommand) ? destPath.replace(/\.md$/, '.toml') : destPath;
      fs.writeFileSync(finalPath, content);
    } else if (entry.name.endsWith('.cjs') || entry.name.endsWith('.js')) {
      const dispatch = RUNTIME_CONTENT_DISPATCH[runtime] || {};
      if (dispatch.js) {
        const ctx = { isCommand, isGlobal, dirName, pathPrefix, entryName: entry.name, runtime };
        let content = fs.readFileSync(srcPath, 'utf8');
        content = dispatch.js(content, ctx);
        fs.writeFileSync(destPath, content);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Clean up orphaned hook registrations from settings.json
 */
function cleanupOrphanedHooks(settings) {
  const orphanedHookPatterns = [
    'gsd-notify.sh',  // Removed in v1.6.x
    'hooks/statusline.js',  // Renamed to gsd-statusline.js in v1.9.0
    'gsd-intel-index.js',  // Removed in v1.9.2
    'gsd-intel-session.js',  // Removed in v1.9.2
    'gsd-intel-prune.js',  // Removed in v1.9.2
  ];

  let cleanedHooks = false;

  // Check all hook event types (Stop, SessionStart, etc.)
  if (settings.hooks) {
    for (const eventType of Object.keys(settings.hooks)) {
      const hookEntries = settings.hooks[eventType];
      if (Array.isArray(hookEntries)) {
        // Filter out entries that contain orphaned hooks
        const filtered = hookEntries.filter(entry => {
          if (entry.hooks && Array.isArray(entry.hooks)) {
            // Check if any hook in this entry matches orphaned patterns
            const hasOrphaned = entry.hooks.some(h =>
              h.command && orphanedHookPatterns.some(pattern => h.command.includes(pattern))
            );
            if (hasOrphaned) {
              cleanedHooks = true;
              return false;  // Remove this entry
            }
          }
          return true;  // Keep this entry
        });
        settings.hooks[eventType] = filtered;
      }
    }
  }

  if (cleanedHooks) {
    console.log(`  ${green}✓${reset} Removed orphaned hook registrations`);
  }

  // Fix #330: Update statusLine if it points to old GSD statusline.js path
  // Only match the specific old GSD path pattern (hooks/statusline.js),
  // not third-party statusline scripts that happen to contain 'statusline.js'
  if (settings.statusLine && settings.statusLine.command &&
    /hooks[\/\\]statusline\.js/.test(settings.statusLine.command)) {
    settings.statusLine.command = settings.statusLine.command.replace(
      /hooks([\/\\])statusline\.js/,
      'hooks$1gsd-statusline.js'
    );
    console.log(`  ${green}✓${reset} Updated statusline path (hooks/statusline.js → hooks/gsd-statusline.js)`);
  }

  return settings;
}

/**
 * Validate hook field requirements to prevent silent settings.json rejection.
 *
 * Claude Code validates the entire settings file with a strict Zod schema.
 * If ANY hook has an invalid schema (e.g., type: "agent" missing "prompt"),
 * the ENTIRE settings.json is silently discarded — disabling all plugins,
 * env vars, and other configuration.
 *
 * This defensive check removes invalid hook entries and cleans up empty
 * event arrays to prevent this. It validates:
 *   - agent hooks require a "prompt" field
 *   - command hooks require a "command" field
 *   - entries must have a valid "hooks" array (non-array/missing is removed)
 *
 * @param {object} settings - The settings object (mutated in place)
 * @returns {object} The same settings object
 */
function validateHookFields(settings) {
  if (!settings.hooks || typeof settings.hooks !== 'object') return settings;

  let fixedHooks = false;
  const emptyKeys = [];

  for (const [eventType, hookEntries] of Object.entries(settings.hooks)) {
    if (!Array.isArray(hookEntries)) continue;

    // Pass 1: validate each entry, building a new array without mutation
    const validated = [];
    for (const entry of hookEntries) {
      // Entries without a hooks sub-array are structurally invalid — remove them
      if (!entry.hooks || !Array.isArray(entry.hooks)) {
        fixedHooks = true;
        continue;
      }

      // Filter invalid hooks within the entry
      const validHooks = entry.hooks.filter(h => {
        if (h.type === 'agent' && !h.prompt) {
          fixedHooks = true;
          return false;
        }
        if (h.type === 'command' && !h.command) {
          fixedHooks = true;
          return false;
        }
        return true;
      });

      // Drop entries whose hooks are now empty
      if (validHooks.length === 0) {
        fixedHooks = true;
        continue;
      }

      // Build a clean copy instead of mutating the original entry
      validated.push({ ...entry, hooks: validHooks });
    }

    settings.hooks[eventType] = validated;

    // Collect empty event arrays for removal (avoid delete during iteration)
    if (validated.length === 0) {
      emptyKeys.push(eventType);
      fixedHooks = true;
    }
  }

  // Pass 2: remove empty event arrays
  for (const key of emptyKeys) {
    delete settings.hooks[key];
  }

  if (fixedHooks) {
    console.log(`  ${green}✓${reset} Fixed invalid hook entries (prevents settings.json schema rejection)`);
  }

  return settings;
}

/**
 * GSD hook filenames removed during uninstall.
 * Module-level so tests can assert structurally instead of regex-parsing source
 * (retires pending-migration-to-typed-ir on hooks-opt-in.test.cjs, per #455).
 *
 * Derived from _HOOKS_TO_COPY (scripts/build-hooks.js — the SAME single source
 * of truth INSTALLED_HOOK_FILES uses for manifest-tracking above) instead of a
 * separately hand-maintained literal array. The hand-maintained array had
 * silently drifted out of sync with the install-time set — missing
 * gsd-check-update-worker.js, gsd-ensure-canonical-path.js,
 * managed-hooks-registry.cjs, gsd-cursor-pre-tool.js, gsd-cursor-stop.js,
 * gsd-cursor-subagent-start.js, gsd-cursor-subagent-stop.js, and
 * gsd-worktree-path-guard.js — so every one of those files (and the hooks/ dir
 * itself, via the non-empty-dir rmdir guard) was left behind on uninstall for
 * every settings-json-hook runtime. `gsd-check-update.cmd` is added on top: a
 * Windows-only SessionStart shim generated at install time (not copied from
 * hooks/dist/, so it is not in _HOOKS_TO_COPY).
 */
const GSD_UNINSTALL_HOOKS = [..._HOOKS_TO_COPY, 'gsd-check-update.cmd'];

/**
 * Whether two paths denote the SAME directory — used to stop a reclaim from
 * deleting the very root the current install just wrote (#3031).
 *
 * A plain `path.resolve` comparison is not enough here, because both roots come
 * from user-controlled env vars (`KIMI_SHARE_DIR`, `KIMI_CODE_HOME`) and two
 * different strings routinely name one directory:
 *   - case-insensitive filesystems (macOS, Windows): `~/Kimi` vs `~/kimi`
 *   - symlinks / bind mounts: `~/link-to-kimi` vs the real target
 * Getting this wrong is not cosmetic — it is the difference between skipping a
 * reclaim and deleting a live install's own hooks.
 *
 * Strategy, cheapest-first: string equality after `resolve`, then identity by
 * `dev`+`ino` (definitive when both exist and the platform reports them), then
 * `realpath` string equality (resolves symlinks AND canonicalizes case). Any
 * rung answering "same" wins; a path that does not exist cannot be the root we
 * just wrote, so a failed stat simply falls through.
 *
 * @returns {boolean} true only when both paths are proven to be one directory.
 */
function isSameDirectory(a, b) {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    // `ino` is 0 on some Windows filesystems; only trust a positive match.
    if (sa.ino && sb.ino && sa.dev === sb.dev && sa.ino === sb.ino) return true;
  } catch (_) { /* one side missing — fall through to realpath */ }
  try {
    return fs.realpathSync.native(a) === fs.realpathSync.native(b);
  } catch (_) {
    return false;
  }
}

/**
 * Remove every GSD-owned artifact from a Kimi hooks root (`~/.kimi` for kimi,
 * `~/.kimi-code` for kimi-code — resolveKimiHooksTomlDir, #2755): the managed
 * `[[hooks]]` block in the native config.toml, the hook scripts, hooks/lib/,
 * and the CommonJS marker at both its current (hooks/) and pre-#2544 (root)
 * locations.
 *
 * This root is Kimi's own native config home — SHARED space that may hold the
 * user's real config.toml, providers and their own scripts — so only exact
 * GSD-owned filenames are removed and directories are pruned only when that
 * removal leaves them empty.
 *
 * TWO callers, deliberately one implementation (#3031). `uninstall()` calls it
 * for the runtime being uninstalled; the opt-in `--reclaim-kimi-legacy` path in
 * `install()` calls it for the LEGACY `~/.kimi` root a pre-#2755 `--kimi-code`
 * install orphaned. Duplicating this sequence for the second caller would be
 * exactly the generative-divergence hazard the repo bans — the reclaim must
 * remove precisely what a real uninstall removes, forever, by construction.
 *
 * @param {string} kimiHooksRoot - Absolute path to the Kimi hooks root.
 * @returns {number} count of removal steps performed (0 when nothing matched).
 */
function reclaimKimiHooksRoot(kimiHooksRoot) {
  let steps = 0;
  const kimiHooksTomlPath = path.join(kimiHooksRoot, 'config.toml');
  const kimiHooksCleanup = removeKimiHooksToml(kimiHooksTomlPath);
  if (kimiHooksCleanup.changed) {
    steps++;
    console.log(`  ${green}✓${reset} Removed GSD hooks from ${kimiHooksTomlPath}`);
  }

  // Kimi's shared hook scripts + CommonJS package.json marker are installed
  // into this SAME ~/.kimi root (installSharedHooksBundle, install()'s
  // kimi-hooks-toml branch) rather than under targetDir — mirror steps "4.
  // Remove GSD hooks" / "5. Remove GSD package.json" below, but scoped to
  // kimiHooksRoot. ~/.kimi is Kimi's own native config home (shared space —
  // may hold the user's real config.toml/providers), so only the exact
  // GSD-owned filenames are removed, and directories are pruned only if left
  // empty by that removal.
  const kimiHooksDir = path.join(kimiHooksRoot, 'hooks');
  if (fs.existsSync(kimiHooksDir)) {
    let kimiHookCount = 0;
    for (const hook of GSD_UNINSTALL_HOOKS) {
      const hookPath = path.join(kimiHooksDir, hook);
      if (fs.existsSync(hookPath)) {
        fs.unlinkSync(hookPath);
        kimiHookCount++;
      }
    }
    if (kimiHookCount > 0) {
      steps++;
      console.log(`  ${green}✓${reset} Removed ${kimiHookCount} GSD hooks from ${kimiHooksDir}`);
    }

    const kimiHooksLibDir = path.join(kimiHooksDir, 'lib');
    if (fs.existsSync(kimiHooksLibDir)) {
      let removedKimiLibFiles = 0;
      for (const file of GSD_HOOK_LIB_FILES) {
        try {
          fs.unlinkSync(path.join(kimiHooksLibDir, file));
          removedKimiLibFiles++;
        } catch (_) { /* best-effort */ }
      }
      try { fs.rmdirSync(kimiHooksLibDir); } catch (_) { /* not empty or other error — leave it */ }
      if (removedKimiLibFiles > 0) {
        steps++;
        console.log(`  ${green}✓${reset} Removed ${removedKimiLibFiles} hooks/lib/ helper(s) from ${kimiHooksLibDir}`);
      }
    }

    // #2544: the marker now lives inside kimi's hooks/ dir — remove it
    // before the emptiness check below, or the dir would never prune.
    if (removeCommonJsMarker(kimiHooksDir)) {
      steps++;
      console.log(`  ${green}✓${reset} Removed GSD package.json from ${kimiHooksDir}`);
    }

    try {
      if (fs.readdirSync(kimiHooksDir).length === 0) fs.rmdirSync(kimiHooksDir);
    } catch (_) { /* not empty — leave it */ }
  }

  // Retire the pre-#2544 marker at kimi's root (~/.kimi), where the bundle
  // used to write it. Exact content match — a user's own package.json in
  // kimi's native config home is never touched.
  if (removeCommonJsMarker(kimiHooksRoot)) {
    steps++;
    console.log(`  ${green}✓${reset} Removed GSD package.json from ${kimiHooksRoot} (pre-#2544 marker)`);
  }
  return steps;
}

/**
 * Uninstall GSD from the specified directory for a specific runtime
 * Removes only GSD-specific files/directories, preserves user content
 * @param {boolean} isGlobal - Whether to uninstall from global or local
 * @param {string} runtime - Target runtime ('claude', 'opencode', 'codex', 'copilot')
 */
function uninstall(isGlobal, runtime = DEFAULT_RUNTIME) {
  // #2093: isKilo dropped — the Kilo permission-cleanup branch below is
  // descriptor-driven (resolveInstallPlan(runtime).finishPermissionWriter),
  // not gated on this flag.
  // #2094: isTrae dropped — unused in this function after the
  // skipSharedHooksInstall fold (was never referenced here besides the
  // destructure). #2095: isKimi likewise dropped — kimi is now a hooks/
  // consumer, so its former `&& !isKimi` uninstall guards were removed.
  // #2096: isAntigravity dropped — unused in this function.
  // #2098: isCodebuddy dropped — unused in this function.
  // #2099: isCopilot dropped — both Copilot side-effect branches below are now
  // gated on resolveInstallPlan(runtime).installSurface === 'copilot-instructions'.
  // #2100: isWindsurf dropped — unused in this function.
  const { isOpencode, isCodex, isCursor, isAugment, isQwen, isHermes, isCline } = runtimeFlags(runtime);
  const dirName = getDirName(runtime);

  // Get the target directory based on runtime and install type. Cline local
  // installs write to the project root (.clinerules/ lives at the root, not in
  // a .cline/ subdir), mirroring the install() path resolution (#787).
  // Descriptor-driven (ADR-1239 / #2090): cline local installs write to the
  // project root (.clinerules/ lives at the root, not in a .cline/ subdir),
  // mirroring the install() path resolution (#787). Folded from a hardcoded
  // `runtime === 'cline'` branch into hostBehaviors.localTargetIsProjectRoot.
  const targetDir = isGlobal
    ? getGlobalConfigDir(runtime, explicitConfigDir)
    : _hostBehaviors(runtime).localTargetIsProjectRoot
      ? process.cwd()
      : path.join(process.cwd(), dirName);

  const locationLabel = isGlobal
    ? targetDir.replace(os.homedir(), '~')
    : targetDir.replace(process.cwd(), '.');

  // runtimeLabel is now the single-source getRuntimeLabel lookup (ADR-1239
  // Phase B / #1679) — collapses the prior 15-line assignment chain.
  const runtimeLabel = getRuntimeLabel(runtime);

  console.log(`  Uninstalling GSD from ${cyan}${runtimeLabel}${reset} at ${cyan}${locationLabel}${reset}\n`);

  // #786: AGENTS.md lives at the repo root (outside targetDir) for local Copilot
  // installs, so its cleanup must run even when .github (targetDir) was already
  // removed — i.e. BEFORE the "target directory missing" early-return below.
  // #2099: descriptor-driven via resolveInstallPlan(runtime).installSurface ===
  // 'copilot-instructions' (was hardcoded `isCopilot`). Mirrors the install-time
  // gate at the 'copilot-instructions' branch below (~line 10471 equivalent),
  // which writes this same repo-root AGENTS.md only for local ('!isGlobal')
  // installs — 'copilot-instructions' is unique to copilot's descriptor, so
  // this is byte-parity.
  if (resolveInstallPlan(runtime).installSurface === 'copilot-instructions' && !isGlobal) {
    const agentsMdPath = path.join(process.cwd(), 'AGENTS.md');
    if (fs.existsSync(agentsMdPath)) {
      const content = fs.readFileSync(agentsMdPath, 'utf8');
      const cleaned = stripGsdFromCopilotInstructions(content);
      if (cleaned === null) {
        fs.unlinkSync(agentsMdPath);
        console.log(`  ${green}✓${reset} Removed AGENTS.md (was GSD-only)`);
      } else if (cleaned !== content) {
        fs.writeFileSync(agentsMdPath, cleaned);
        console.log(`  ${green}✓${reset} Cleaned GSD section from AGENTS.md`);
      }
    }
  }

  // Check if target directory exists
  if (!fs.existsSync(targetDir)) {
    console.log(`  ${yellow}⚠${reset} Directory does not exist: ${locationLabel}`);
    console.log(`  Nothing to uninstall.\n`);
    return;
  }

  let removedCount = 0;

  // #2875 (#1874-F19 anti-inertness, test-matrix C7): recover any user
  // artifact orphaned by a PRIOR uninstall run that died between staging and
  // its own restore/discard, BEFORE this run's own preserve steps (sites 2,
  // 3, 5 below) stage anything new. Uninstall's own gsd-core/ removal and
  // legacy-commands cleanup are exactly as crash-exposed as install's —
  // without this, an orphan from a crashed uninstall is recoverable only if
  // the user later re-installs.
  // #2875 defect fix: DEGRADE, never abort uninstall, when the staging root
  // itself cannot be resolved — skip this recovery pass rather than throw
  // out of uninstall() before it does anything.
  {
    const _uninstallEntryStagingRoot = _tryResolveUserArtifactStagingRoot(targetDir);
    if (_uninstallEntryStagingRoot !== null) {
      recoverOrphanedUserArtifacts(_uninstallEntryStagingRoot, targetDir);
    }
  }

  // Remove profile marker so a clean reinstall defaults to full surface.
  try {
    fs.unlinkSync(path.join(targetDir, '.gsd-profile'));
    removedCount++;
  } catch {}

  // 1. Remove GSD commands/skills (layout-driven)
  // #2870: scope id resolved ONCE here and reused below (was two independent
  // isGlobal-derived re-derivations). Routed through the Install Scope
  // Module (src/install-scope.cts) when the capability registry is
  // available; degrades to the plain id on failure (unknown/non-installable
  // runtime, broken bundle) so this function's scope-id uses — which never
  // depended on registry availability before this migration — keep working
  // exactly as they did pre-migration.
  const _uninstallScopeId = isGlobal ? 'global' : 'local';
  const _resolvedUninstallScope = _resolveScopeSafe(_uninstallScopeId, runtime);
  const scope = _resolvedUninstallScope ? _resolvedUninstallScope.id : _uninstallScopeId;
  // ADR-1239 / #2086: drive uninstall through the public Host-Integration Interface.
  // Fail-open to the engine directly if the composed-registry adapter can't load.
  const _uninstallAdapter = _runtimeAdapter(runtime);
  if (_uninstallAdapter) {
    _uninstallAdapter.uninstall({ configDir: targetDir, scope });
  } else {
    uninstallRuntimeArtifacts(runtime, targetDir, scope);
  }
  removedCount++;

  // ADR-1239 split-home migration: the adapter/plan uninstall targets the new
  // `home` location (e.g. Codex → ~/.agents/skills). A user who installed
  // BEFORE the move and never reinstalled still has managed gsd-* skill dirs at
  // the old configDir-rooted location (~/.codex/skills) — remove those too so
  // uninstall leaves nothing behind. User-owned content is preserved.
  {
    const _movedOldSkillsDir = _resolveMovedSkillsOldDir(runtime, targetDir, scope);
    if (_movedOldSkillsDir) {
      const migrated = cleanupMovedSkillsOldLocation(_movedOldSkillsDir, 'gsd-');
      if (migrated > 0) {
        removedCount++;
        console.log(`  ${green}✓${reset} Removed ${migrated} legacy skill dir(s) from ${_movedOldSkillsDir}`);
      }
    }
  }

  // 1a. Non-layout Codex side-effects: agent .toml files, config.toml sections, hooks.json
  if (_hostBehaviors(runtime).tomlConfigInstall) {
    const codexAgentsDir = path.join(targetDir, 'agents');
    if (fs.existsSync(codexAgentsDir)) {
      const tomlFiles = fs.readdirSync(codexAgentsDir);
      let tomlCount = 0;
      for (const file of tomlFiles) {
        if (file.startsWith('gsd-') && file.endsWith('.toml')) {
          fs.unlinkSync(path.join(codexAgentsDir, file));
          tomlCount++;
        }
      }
      if (tomlCount > 0) {
        removedCount++;
        console.log(`  ${green}✓${reset} Removed ${tomlCount} agent .toml configs`);
      }
    }

    // Codex: clean GSD sections from config.toml
    const codexConfigPath = path.join(targetDir, 'config.toml');
    if (fs.existsSync(codexConfigPath)) {
      const content = fs.readFileSync(codexConfigPath, 'utf8');
      const cleaned = stripGsdFromCodexConfig(content);
      if (cleaned === null) {
        fs.unlinkSync(codexConfigPath);
        removedCount++;
        console.log(`  ${green}✓${reset} Removed config.toml (was GSD-only)`);
      } else if (cleaned !== content) {
        fs.writeFileSync(codexConfigPath, cleaned);
        removedCount++;
        console.log(`  ${green}✓${reset} Cleaned GSD sections from config.toml`);
      }
    }

    const hooksJsonCleanup = removeCodexHooksJsonSessionStart(targetDir);
    if (hooksJsonCleanup.changed) {
      removedCount++;
      console.log(`  ${green}✓${reset} Removed managed Codex SessionStart hook from hooks.json`);
    }

    // #772/#2088: remove every managed Codex extended hook-event registration.
    // Shares CODEX_EXTENDED_HOOK_EVENTS with the install loop — removal set ==
    // registration set, so no managed event is ever orphaned.
    for (const eventName of CODEX_EXTENDED_HOOK_EVENTS) {
      const eventCleanup = removeCodexHooksJsonEvent(targetDir, eventName);
      if (eventCleanup.changed) {
        removedCount++;
        console.log(`  ${green}✓${reset} Removed managed Codex ${eventName} hook from hooks.json`);
      }
    }
  }

  // 1a-kimi. Non-layout Kimi side-effect (#2095 EoS/kimi Upgrade 1): kimi's
  // native config.toml lives outside targetDir entirely (resolveKimiHooksTomlDir
  // resolves ~/.kimi for kimi and ~/.kimi-code for kimi-code (#2755), a sibling
  // of targetDir's ~/.config/agents), so its
  // cleanup can't be driven by anything under targetDir the way every other
  // hook surface above is.
  if (resolveInstallPlan(runtime).hooksSurface === 'kimi-hooks-toml') {
    removedCount += reclaimKimiHooksRoot(resolveKimiHooksTomlDir({ runtime }));
  }

  // 1b. Non-layout Copilot side-effect: copilot-instructions.md cleanup
  // #2099: descriptor-driven via resolveInstallPlan(runtime).installSurface ===
  // 'copilot-instructions' (was hardcoded `isCopilot`), mirroring the same
  // gate used at the install-time 'copilot-instructions' branch.
  if (resolveInstallPlan(runtime).installSurface === 'copilot-instructions') {
    const instructionsPath = path.join(targetDir, 'copilot-instructions.md');
    if (fs.existsSync(instructionsPath)) {
      const content = fs.readFileSync(instructionsPath, 'utf8');
      const cleaned = stripGsdFromCopilotInstructions(content);
      if (cleaned === null) {
        fs.unlinkSync(instructionsPath);
        removedCount++;
        console.log(`  ${green}✓${reset} Removed copilot-instructions.md (was GSD-only)`);
      } else if (cleaned !== content) {
        fs.writeFileSync(instructionsPath, cleaned);
        removedCount++;
        console.log(`  ${green}✓${reset} Cleaned GSD section from copilot-instructions.md`);
      }
    }

    // #786: remove the GSD-managed Copilot lifecycle hook config and prune the
    // hooks dir if we left it empty.
    const hookPath = path.join(targetDir, 'hooks', GSD_COPILOT_HOOK_FILE);
    if (fs.existsSync(hookPath)) {
      fs.unlinkSync(hookPath);
      removedCount++;
      console.log(`  ${green}✓${reset} Removed Copilot lifecycle hook (${GSD_COPILOT_HOOK_FILE})`);
      try {
        const hooksDir = path.join(targetDir, 'hooks');
        if (fs.existsSync(hooksDir) && fs.readdirSync(hooksDir).length === 0) {
          fs.rmdirSync(hooksDir);
        }
      } catch { /* non-fatal: leave a non-empty/locked hooks dir in place */ }
    }
    // Note: AGENTS.md (repo root) is cleaned earlier, before the targetDir
    // existence early-return, since it lives outside targetDir (#786).
  }

  // 1b-cline. Non-layout Cline side-effects (issue #787): remove the
  // directory-form rules + PreToolUse hook, and strip the GSD block from the
  // global cross-tool ~/.agents/AGENTS.md target.
  // Descriptor-driven (ADR-1239 / #2090): folded from `runtime === 'cline'`
  // into hostBehaviors.clineRulesSurface.
  if (_hostBehaviors(runtime).clineRulesSurface) {
    const clinerulesDir = path.join(targetDir, '.clinerules');
    for (const rel of ['gsd.md', path.join('hooks', 'PreToolUse')]) {
      const p = path.join(clinerulesDir, rel);
      try {
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
          removedCount++;
        }
      } catch { /* best-effort */ }
    }
    // Also remove a legacy single-file .clinerules left by pre-#787 installs.
    try {
      if (fs.existsSync(clinerulesDir) && fs.statSync(clinerulesDir).isFile()) {
        fs.unlinkSync(clinerulesDir);
        removedCount++;
      }
    } catch { /* best-effort */ }
    // Prune now-empty GSD-created directories (leave any user-added rule files).
    for (const dir of [path.join(clinerulesDir, 'hooks'), clinerulesDir]) {
      try {
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory() && fs.readdirSync(dir).length === 0) {
          fs.rmdirSync(dir);
        }
      } catch { /* best-effort */ }
    }
    if (isGlobal) {
      const agentsPath = path.join(os.homedir(), '.agents', 'AGENTS.md');
      try {
        if (fs.existsSync(agentsPath)) {
          const content = fs.readFileSync(agentsPath, 'utf8');
          const cleaned = stripGsdFromAgentsMd(content);
          if (cleaned === null) {
            fs.unlinkSync(agentsPath);
            removedCount++;
            console.log(`  ${green}✓${reset} Removed ~/.agents/AGENTS.md (was GSD-only)`);
          } else if (cleaned !== content) {
            fs.writeFileSync(agentsPath, cleaned);
            removedCount++;
            console.log(`  ${green}✓${reset} Cleaned GSD section from ~/.agents/AGENTS.md`);
          }
        }
      } catch { /* best-effort */ }
    }
  }

  // 1b-cursor. Descriptor-driven hook-bus cleanup (ADR-1239 / #2089): remove
  // GSD-managed hook entries from hooks.json and clean up the managed hook
  // scripts. Gated by the hostBehaviors.hooksJsonSurface descriptor axis, not a
  // hardcoded `isCursor` branch.
  if (_hostBehaviors(runtime).hooksJsonSurface) {
    const hooksJsonCleanup = removeCursorHooksJson(targetDir);
    if (hooksJsonCleanup.changed) {
      removedCount++;
      console.log(`  ${green}✓${reset} Removed GSD-managed Cursor hooks from hooks.json`);
    }
    // Remove all GSD-managed hook scripts (sessionStart, postToolUse, preToolUse,
    // stop, subagentStart, subagentStop — AC4a, #2089).
    const hooksDir = path.join(targetDir, 'hooks');
    for (const script of GSD_CURSOR_HOOK_SCRIPTS) {
      const p = path.join(hooksDir, script);
      try {
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
          removedCount++;
        }
      } catch { /* best-effort */ }
    }
    // Prune hooks/ if empty.
    try {
      if (fs.existsSync(hooksDir) && fs.readdirSync(hooksDir).length === 0) {
        fs.rmdirSync(hooksDir);
      }
    } catch { /* best-effort */ }
  }

  // 1b-windsurf. Descriptor-driven hook-bus cleanup (ADR-1239 / #2100 Stage 2):
  // remove GSD-managed Cascade hook entries from hooks.json and clean up the
  // managed hook scripts. Gated on resolveInstallPlan(runtime).hooksSurface
  // === 'windsurf-hooks-json' (mirrors the kimi-hooks-toml gate above) —
  // NOT the shared hostBehaviors.hooksJsonSurface flag the Cursor block above
  // uses, since that flag drives Cursor's own remove function + script list
  // and is not (and must not be) set for Windsurf.
  if (resolveInstallPlan(runtime).hooksSurface === 'windsurf-hooks-json') {
    const windsurfHooksJsonCleanup = removeWindsurfHooksJson(targetDir);
    if (windsurfHooksJsonCleanup.changed) {
      removedCount++;
      console.log(`  ${green}✓${reset} Removed GSD-managed Windsurf hooks from hooks.json`);
    }
    // Remove all GSD-managed hook scripts (pre_write_code, pre_run_command).
    const windsurfHooksDir = path.join(targetDir, 'hooks');
    for (const script of GSD_WINDSURF_HOOK_SCRIPTS) {
      const p = path.join(windsurfHooksDir, script);
      try {
        if (fs.existsSync(p)) {
          fs.unlinkSync(p);
          removedCount++;
        }
      } catch { /* best-effort */ }
    }
    // Prune hooks/ if empty.
    try {
      if (fs.existsSync(windsurfHooksDir) && fs.readdirSync(windsurfHooksDir).length === 0) {
        fs.rmdirSync(windsurfHooksDir);
      }
    } catch { /* best-effort */ }
  }

  // 1c. Claude local: remove flat gsd-*.md commands from commands/ (current layout,
  //     #1367 fix). Also remove legacy commands/gsd/ subdirectory from prior installs.
  if (!isGlobal && _hostBehaviors(runtime).localInstallStyle === 'legacy-flat') {
    const commandsDir = path.join(targetDir, 'commands');
    // Remove flat gsd-*.md files (current layout after #1367 fix)
    if (fs.existsSync(commandsDir)) {
      let removed = 0;
      for (const f of fs.readdirSync(commandsDir)) {
        if (f.startsWith('gsd-') && f.endsWith('.md')) {
          fs.rmSync(path.join(commandsDir, f), { force: true });
          removed++;
        }
      }
      if (removed > 0) {
        removedCount++;
        console.log(`  ${green}✓${reset} Removed ${removed} flat gsd-*.md commands from commands/`);
      }
    }
    // Remove legacy commands/gsd/ subdirectory if it still exists (pre-#1367 layout).
    // Preserve user-owned dev-preferences.md if present (#1423 parity).
    const legacyGsdCommandsDir = path.join(targetDir, 'commands', 'gsd');
    if (fs.existsSync(legacyGsdCommandsDir)) {
      // Stage user-owned dev-preferences.md DURABLY before wiping (#2875 /
      // #1874-F19 "site 7" — found by sweeping bin/install.js for the
      // read-then-wipe-then-write PATTERN, not for preserveUserArtifacts'
      // callers; this uninstall-path block open-coded the same round-trip).
      // #2875 defect fix: DEGRADE, never abort uninstall, when the staging
      // root cannot be resolved — skip this legacy-cleanup block entirely
      // (leave the stale dir in place) rather than wipe without a durable
      // backup for dev-preferences.md.
      const _legacyGsdCommandsStagingRoot = _tryResolveUserArtifactStagingRoot(targetDir);
      if (_legacyGsdCommandsStagingRoot !== null) {
        const stagedDevPrefs = stageUserArtifacts(legacyGsdCommandsDir, ['dev-preferences.md'], _legacyGsdCommandsStagingRoot);
        // Preserve the ORIGINAL truthy-content check exactly: an existing but
        // EMPTY dev-preferences.md was (and still is) silently not restored.
        const savedDevPrefs = stagedDevPrefs.names.includes('dev-preferences.md')
          ? fs.readFileSync(path.join(stagedDevPrefs.filesDir, 'dev-preferences.md'), 'utf8')
          : null;
        fs.rmSync(legacyGsdCommandsDir, { recursive: true });
        removedCount++;
        console.log(`  ${green}✓${reset} Removed legacy commands/gsd/`);
        if (savedDevPrefs) {
          try {
            restoreStagedUserArtifacts(legacyGsdCommandsDir, stagedDevPrefs);
            discardStagedUserArtifacts(stagedDevPrefs);
            console.log(`  ${green}✓${reset} Preserved commands/gsd/dev-preferences.md`);
          } catch (err) {
            console.error(`  ${red}✗${reset} Failed to restore dev-preferences.md: ${err.message}`);
          }
        } else {
          // #2875 defect fix: an existing-but-EMPTY dev-preferences.md was (and
          // still is) never restored — the original truthy-content check is
          // preserved byte-for-byte above — but the staged batch was never
          // discarded either, leaking a <configDir>/.gsd-staging/ record
          // forever and re-materializing the just-deleted file on a future
          // install's orphan-recovery pass. Discard unconditionally when there
          // is nothing to restore.
          discardStagedUserArtifacts(stagedDevPrefs);
        }
      }
    }
  }

  // 1d. Qwen/Hermes: migrate dev-preferences.md from legacy commands/gsd/ location
  //     during uninstall. _runLegacyUninstallCleanup (called by uninstallRuntimeArtifacts)
  //     removes the directory; we must preserve/restore user artifacts before that path.
  //     This block runs AFTER uninstallRuntimeArtifacts, so we check if the directory
  //     was already removed and skip if so (idempotent).
  if (_hostBehaviors(runtime).legacyCommandsGsdCleanup === true) {
    // dev-preferences may have survived in skills/ as SKILL.md — nothing to do for
    // that case. If a stale commands/gsd/ still exists (e.g. legacy was not removed),
    // attempt migration. In practice _runLegacyUninstallCleanup removes it first,
    // so this is a best-effort guard.
    const legacyDir = path.join(targetDir, 'commands', 'gsd');
    if (fs.existsSync(legacyDir)) {
      // #2875 (#1874-F19): staged DURABLY to disk before the wipe below,
      // instead of an in-memory Map only — a crash between the wipe and the
      // restore-on-failure branch below now survives via
      // recoverOrphanedUserArtifacts on the next run.
      // #2875 defect fix: DEGRADE, never abort uninstall, when the staging
      // root cannot be resolved — skip this legacy-migration block entirely
      // (leave the stale dir in place) rather than wipe without a durable
      // backup.
      const stagingRoot = _tryResolveUserArtifactStagingRoot(targetDir);
      if (stagingRoot !== null) {
        const stagedLegacyArtifacts = stageUserArtifacts(legacyDir, ['dev-preferences.md'], stagingRoot);
        fs.rmSync(legacyDir, { recursive: true });
        removedCount++;
        console.log(`  ${green}✓${reset} Removed legacy commands/gsd/`);
        const _uninstallScope = scope;
        // migrateLegacyDevPreferencesToSkill's Map<string,string> contract is
        // unchanged — read the staged content back from disk (not an in-memory
        // value held across the wipe above).
        //
        // #2875 defect fix (readFileSync following a staged symlink) — matches
        // install-engine.cts's _runLegacyInstallMigrations call site 1 exactly:
        // readFileSync ALWAYS follows a symlink, so a staged artifact that is
        // itself a symlink (user-artifact-staging.cts's "Symlink safety": a
        // symlinked user artifact is recreated AS a symlink in the staging
        // tree, never copied by content) would have its REFERENT's bytes read
        // here and land in SKILL.md. Excluded from migration below and
        // restored to its original location unchanged instead.
        // #2875 defect fix (regression closed — was previously unguarded and
        // BRICKED uninstall, the very command that should recover from this):
        // legacyDir was already removed above, so stagedLegacyArtifacts is
        // the only surviving copy. migrateLegacyDevPreferencesToSkill
        // correctly THROWS when it finds a planted/dangling symlink at the
        // skill-file leaf (security fix); a raw `fs.lstatSync` in the loop
        // below can also throw on a TOCTOU-vanished staged file. Either one,
        // left unguarded, propagated straight out of uninstall, aborting it
        // WITHOUT ever reaching the restore-or-discard branch below — the
        // staged batch was orphaned on disk and every retry hit the same
        // throw again. Degrade identically to every other #2875 staging step
        // in this function: catch, warn once, and treat the batch as
        // unmigrated so the restore branch below always fires.
        let _legacyMigrated = false;
        let migratableLegacyNames = [];
        try {
          const savedLegacyArtifacts = new Map();
          for (const name of stagedLegacyArtifacts.names) {
            const stagedPath = path.join(stagedLegacyArtifacts.filesDir, name);
            if (fs.lstatSync(stagedPath).isSymbolicLink()) continue;
            savedLegacyArtifacts.set(name, fs.readFileSync(stagedPath, 'utf8'));
            migratableLegacyNames.push(name);
          }
          _legacyMigrated = migrateLegacyDevPreferencesToSkill(targetDir, savedLegacyArtifacts, runtime, _uninstallScope);
        } catch (err) {
          console.warn(`  ${yellow}!${reset} dev-preferences.md migration skipped (${err.message}) — restoring the legacy copy instead.`);
          _legacyMigrated = false;
          migratableLegacyNames = [];
        }
        if (_legacyMigrated && migratableLegacyNames.length === stagedLegacyArtifacts.names.length) {
          // Compute the actual path written so the log line is accurate per-runtime
          const _layout = resolveRuntimeArtifactLayout(runtime, targetDir, _uninstallScope);
          const _sk = _layout.kinds.find((k) => k.kind === 'skills');
          const _stem = _sk && _sk.prefix === '' ? 'dev-preferences' : 'gsd-dev-preferences';
          const _skillRelPath = _sk ? `${_sk.destSubpath}/${_stem}/SKILL.md` : 'skills/gsd-dev-preferences/SKILL.md';
          console.log(`  ${green}✓${reset} Migrated dev-preferences.md → ${_skillRelPath} (#2973)`);
          discardStagedUserArtifacts(stagedLegacyArtifacts);
        } else {
          // Migration failed, already exists, or a symlinked name was excluded
          // above — restore the WHOLE batch to the legacy location so no user
          // content is silently lost.
          restoreStagedUserArtifacts(legacyDir, stagedLegacyArtifacts);
          discardStagedUserArtifacts(stagedLegacyArtifacts);
        }
      }
    }
  }

  // 2. Remove gsd-core directory
  const gsdDir = path.join(targetDir, 'gsd-core');
  if (fs.existsSync(gsdDir)) {
    // Stage user-generated files DURABLY to disk before wipe (#1423; #2875 /
    // #1874-F19 "site 5" — this block open-coded its own preserve/restore
    // instead of calling preserveUserArtifacts, which is why it was missed
    // by the original symbol-search measurement).
    // #2875 defect fix: this IS the core uninstall step (removing gsd-core/)
    // — unlike the optional legacy-cleanup blocks above, uninstall must
    // still be able to proceed and actually remove gsd-core/ even when the
    // staging root cannot be resolved. Degrade by skipping ONLY the
    // USER-PROFILE.md preserve/restore wrapper (warn), never the removal
    // itself.
    const _gsdDirStagingRoot = _tryResolveUserArtifactStagingRoot(targetDir);
    if (_gsdDirStagingRoot === null) {
      console.warn(`  ${yellow}!${reset} Skipping gsd-core/USER-PROFILE.md preservation (staging unavailable) — it will be lost if present.`);
      fs.rmSync(gsdDir, { recursive: true });
      removedCount++;
      console.log(`  ${green}✓${reset} Removed gsd-core/`);
    } else {
      const stagedProfile = stageUserArtifacts(gsdDir, USER_OWNED_ARTIFACTS, _gsdDirStagingRoot);
      // Preserve the ORIGINAL truthy-content check exactly: an existing but
      // EMPTY USER-PROFILE.md was (and still is) silently not restored —
      // matching prior behavior byte-for-byte rather than widening scope.
      const preservedProfile = stagedProfile.names.includes('USER-PROFILE.md')
        ? fs.readFileSync(path.join(stagedProfile.filesDir, 'USER-PROFILE.md'), 'utf8')
        : null;

      fs.rmSync(gsdDir, { recursive: true });
      removedCount++;
      console.log(`  ${green}✓${reset} Removed gsd-core/`);

      // Restore user-generated files
      if (preservedProfile) {
        try {
          restoreStagedUserArtifacts(gsdDir, stagedProfile);
          discardStagedUserArtifacts(stagedProfile);
          console.log(`  ${green}✓${reset} Preserved gsd-core/USER-PROFILE.md`);
        } catch (err) {
          console.error(`  ${red}✗${reset} Failed to restore USER-PROFILE.md: ${err.message}`);
        }
      } else {
        // #2875 defect fix: same empty-file orphan leak as the legacy
        // commands/gsd/ site above — discard the staging batch regardless of
        // whether the staged content was truthy.
        discardStagedUserArtifacts(stagedProfile);
      }
    }
  }

  // 3. Remove GSD agents (gsd-*.md files only)
  const agentsDir = path.join(targetDir, 'agents');
  if (fs.existsSync(agentsDir)) {
    const files = fs.readdirSync(agentsDir);
    let agentCount = 0;
    for (const file of files) {
      if (file.startsWith('gsd-') && file.endsWith('.md')) {
        fs.unlinkSync(path.join(agentsDir, file));
        agentCount++;
      }
    }
    if (agentCount > 0) {
      removedCount++;
      console.log(`  ${green}✓${reset} Removed ${agentCount} GSD agents`);
    }
  }

  // 4. Remove GSD hooks
  // #3023: mirror the install site's descriptor-driven bundle dir name.
  const hooksDir = path.join(targetDir, resolveSharedHooksDirName(runtime));
  if (fs.existsSync(hooksDir)) {
    let hookCount = 0;
    for (const hook of GSD_UNINSTALL_HOOKS) {
      const hookPath = path.join(hooksDir, hook);
      if (fs.existsSync(hookPath)) {
        fs.unlinkSync(hookPath);
        hookCount++;
      }
    }
    if (hookCount > 0) {
      removedCount++;
      console.log(`  ${green}✓${reset} Removed ${hookCount} GSD hooks`);
    }

    // Remove only the GSD-managed files from hooks/lib/ (git-cmd.js + gsd-graphify-rebuild.sh).
    // hooks/lib/ lives inside the user's runtime hooks directory (shared space) and
    // may contain user-owned custom helpers. We must not recursively delete the dir.
    const hooksLibDir = path.join(hooksDir, 'lib');
    if (fs.existsSync(hooksLibDir)) {
      let removedLibFiles = 0;
      for (const file of GSD_HOOK_LIB_FILES) {
        const filePath = path.join(hooksLibDir, file);
        try {
          fs.unlinkSync(filePath);
          removedLibFiles++;
        } catch (_) {
          // Ignore missing files (best effort, non-fatal)
        }
      }
      // Only remove the directory itself if it is now empty (preserve any user files)
      try {
        fs.rmdirSync(hooksLibDir);
      } catch (_) {
        // Directory not empty or other error — leave it alone
      }
      if (removedLibFiles > 0) {
        removedCount++;
        console.log(`  ${green}✓${reset} Removed ${removedLibFiles} hooks/lib/ helper(s)`);
      }
    }

    // Retire the CommonJS marker staged into hooks/. hooks/ is shared space and
    // is deliberately never rmdir'd here, so the marker must be removed
    // explicitly or it would be left behind. Removed ONLY when it still carries
    // GSD's exact content — a user-authored package.json is never deleted.
    //
    // #2717 reaches the runtimes that stage .js hooks via dedicated paths
    // (cursor/windsurf/codex); #2544 reaches the shared-bundle runtimes, whose
    // marker this PR moves out of the config root and into hooks/. Both land in
    // the same directory, so one guarded call covers both.
    try {
      if (hooksSurface.removeCommonJsMarkerIfGsdOwned(hooksDir)) {
        removedCount++;
        console.log(`  ${green}✓${reset} Removed GSD hooks/package.json (CommonJS marker)`);
      }
    } catch { /* best-effort */ }
  }

  // 4z. Remove the native plugin adapter (#1914, extended to Kilo by #2093).
  // Descriptor-driven via hostBehaviors.nativePlugin — covers every runtime
  // that declares the block (OpenCode, Kilo, ...), not just OpenCode. Only
  // GSD's own plugin file is removed; the plugins/ dir is pruned only if it
  // becomes empty, preserving any user-authored plugins for that host.
  const _np = _hostBehaviors(runtime).nativePlugin;
  if (_np) {
    const pluginsDir = path.join(targetDir, _np.dir);
    const pluginPath = path.join(pluginsDir, _np.file);
    // Tracks whether GSD actually removed anything from pluginsDir. The rmdir
    // below is gated on it: pruning a directory GSD never wrote to is the same
    // "don't touch territory GSD didn't fill" violation this issue is about,
    // just inverted — a user-created but empty plugin/ or extensions/ dir is
    // theirs, and an uninstall that never removed anything has no business
    // deleting it.
    let removedFromPluginsDir = false;
    if (fs.existsSync(pluginPath)) {
      try {
        fs.unlinkSync(pluginPath);
        removedCount++;
        removedFromPluginsDir = true;
        console.log(`  ${green}✓${reset} Removed native plugin adapter (${runtime})`);
      } catch (_) { /* best-effort */ }
    }
    // #2544: the adapter's CommonJS marker sits beside it. Cleaned up OUTSIDE
    // the adapter-exists guard above — a partial install (or a hand-deleted
    // adapter) would otherwise strand GSD's marker forever and keep the dir
    // from ever pruning. Conditioned on the adapter being GONE, though: if the
    // unlink above failed, pulling the marker out from under a still-present
    // CommonJS adapter would leave it unloadable. The exact content match
    // still leaves any user-authored package.json in place.
    if (!fs.existsSync(pluginPath) && removeCommonJsMarker(pluginsDir)) {
      removedCount++;
      removedFromPluginsDir = true;
      console.log(`  ${green}✓${reset} Removed GSD package.json from ${_np.dir}/`);
    }
    // Only prune a dir GSD emptied. Pre-fix this rmdir sat inside the
    // adapter-exists guard, so it could never fire on a dir GSD had not
    // written to; hoisting it out to catch the marker-only case must not
    // silently widen it to "any empty plugin dir".
    if (removedFromPluginsDir) {
      try { fs.rmdirSync(pluginsDir); } catch (_) { /* not empty — user plugins present */ }
    }
  }

  // 4a. Remove scripts/changeset/ and scripts/lib/ (#935)
  // GSD-managed files only: enumerate the exact set the installer writes.
  // Any file NOT in this set is user-owned and must survive uninstall.
  // After removing GSD files, attempt to rmdir — if the directory is still
  // non-empty (user has custom helpers) it stays; otherwise it goes cleanly.
  // GSD_CHANGESET_FILES / GSD_SCRIPTS_LIB_FILES are module-scoped (#3184) so
  // tests can assert their parity against the real directory contents.
  const changesetUninstallDir = path.join(targetDir, 'scripts', 'changeset');
  if (fs.existsSync(changesetUninstallDir)) {
    let removedChangeset = 0;
    for (const file of GSD_CHANGESET_FILES) {
      const fp = path.join(changesetUninstallDir, file);
      try { fs.unlinkSync(fp); removedChangeset++; } catch (_) { /* best-effort */ }
    }
    // Remove directory if empty after our cleanup
    try { fs.rmdirSync(changesetUninstallDir); } catch (_) { /* Not empty — user content present */ }
    if (removedChangeset > 0) {
      removedCount++;
      console.log(`  ${green}✓${reset} Removed scripts/changeset/ GSD files`);
    }
  }
  const scriptsLibUninstallDir = path.join(targetDir, 'scripts', 'lib');
  if (fs.existsSync(scriptsLibUninstallDir)) {
    let removedScriptsLib = 0;
    for (const file of GSD_SCRIPTS_LIB_FILES) {
      const fp = path.join(scriptsLibUninstallDir, file);
      try { fs.unlinkSync(fp); removedScriptsLib++; } catch (_) { /* best-effort */ }
    }
    // Remove directory if empty after our cleanup
    try { fs.rmdirSync(scriptsLibUninstallDir); } catch (_) { /* Not empty — user content present */ }
    if (removedScriptsLib > 0) {
      removedCount++;
      console.log(`  ${green}✓${reset} Removed scripts/lib/ GSD files`);
    }
  }
  // Remove scripts/fix-slash-commands.cjs (#1223) — must come before the scripts/ rmdir
  const fixSlashUninstallPath = path.join(targetDir, 'scripts', 'fix-slash-commands.cjs');
  try { fs.unlinkSync(fixSlashUninstallPath); } catch (_) { /* best-effort */ }

  // Remove the capability registry generator scripts (#1920) — before the scripts/ rmdir
  for (const gen of ['gen-capability-registry.cjs', 'gen-loop-host-contract.cjs']) {
    try { fs.unlinkSync(path.join(targetDir, 'scripts', gen)); } catch (_) { /* best-effort */ }
  }

  // If scripts/ dir is now empty, remove it too
  const scriptsUninstallDir = path.join(targetDir, 'scripts');
  if (fs.existsSync(scriptsUninstallDir)) {
    try { fs.rmdirSync(scriptsUninstallDir); } catch (_) { /* Not empty — leave it */ }
  }

  // 5. Remove GSD package.json (CommonJS mode marker)
  // Since #2544 the marker is staged into hooks/ (and the nativePlugin dir,
  // handled at 4z above) rather than at targetDir. The targetDir removal is
  // retained to retire the marker written by pre-#2544 installs — same exact
  // content match as before, so a user-authored package.json is still never
  // touched.
  if (removeCommonJsMarker(targetDir)) {
    removedCount++;
    console.log(`  ${green}✓${reset} Removed GSD package.json (pre-#2544 config-root marker)`);
  }

  // 6. Clean up settings.json (remove GSD hooks and statusline)
  const settingsPath = path.join(targetDir, 'settings.json');
  if (fs.existsSync(settingsPath)) {
    let settings = readSettings(settingsPath);
    if (settings === null) {
      console.log(`  ${yellow}i${reset} Skipping settings.json cleanup — file could not be parsed`);
      settings = {}; // prevent downstream crashes, but don't write back
    }
    let settingsModified = false;

    // Remove GSD statusline if it references our hook
    if (settings.statusLine && settings.statusLine.command &&
      settings.statusLine.command.includes('gsd-statusline')) {
      delete settings.statusLine;
      settingsModified = true;
      console.log(`  ${green}✓${reset} Removed GSD statusline from settings`);
    }

    // Remove GSD hooks from settings — per-hook granularity to preserve
    // user hooks that share an entry with a GSD hook (#1755 followup).
    // Includes the 3 Qwen-only events added in #788 (SubagentStop, Stop,
    // PreCompact, also registered for Claude in #770), the 3 Antigravity-only
    // events added in #776 (BeforeAgent, AfterAgent, BeforeModel), and the
    // Claude-only FileChanged event added in #770 — safe to iterate for all
    // runtimes; installs that don't register these events simply find no
    // entries and skip.
    for (const eventName of ['SessionStart', 'PostToolUse', 'AfterTool', 'PreToolUse', 'BeforeTool', 'SubagentStop', 'Stop', 'PreCompact', 'BeforeAgent', 'AfterAgent', 'BeforeModel', 'FileChanged']) {
      if (settings.hooks && settings.hooks[eventName]) {
        const before = JSON.stringify(settings.hooks[eventName]);
        settings.hooks[eventName] = settings.hooks[eventName]
          .map(entry => {
            if (!entry || typeof entry !== 'object' || !Array.isArray(entry.hooks)) return entry;
            // Filter out individual GSD hooks, keep user hooks
            entry.hooks = entry.hooks.filter((h) => {
              if (!h || typeof h.command !== 'string') return true;
              return !isManagedHookCommand(h.command, {
                surface: 'settings-json',
              });
            });
            return entry.hooks.length > 0 ? entry : null;
          })
          .filter(Boolean);
        if (JSON.stringify(settings.hooks[eventName]) !== before) {
          settingsModified = true;
        }
        if (settings.hooks[eventName].length === 0) {
          delete settings.hooks[eventName];
        }
      }
    }
    if (settingsModified) {
      console.log(`  ${green}✓${reset} Removed GSD hooks from settings`);
    }

    // Clean up empty hooks object
    if (settings.hooks && Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    // #768 — Remove GSD-owned Claude permissions from settings.json.
    // Applies only to Claude uninstalls. Filter only the exact GSD-owned entries
    // to preserve any user-added allow/deny entries.
    // Uses a local flag to avoid the shared `settingsModified` producing a false
    // "Removed GSD permissions" message when only hooks/statusline changed.
    if (_hostBehaviors(runtime).permissionsSchema === 'claude' && settings.permissions) {
      let permissionsModified = false;
      if (Array.isArray(settings.permissions.allow)) {
        const before = settings.permissions.allow.length;
        // #2278 — filter against the union of the current allow-rule forms
        // AND the retired legacy forms, so uninstall still cleans up
        // pre-fix installs that still carry the stale `Write(...)` entries.
        settings.permissions.allow = settings.permissions.allow.filter(
          (e) => !GSD_CLAUDE_ALLOW_PERMISSIONS.includes(e) && !GSD_CLAUDE_LEGACY_ALLOW_PERMISSIONS.includes(e)
        );
        if (settings.permissions.allow.length !== before) {
          permissionsModified = true;
        }
      }
      if (Array.isArray(settings.permissions.deny)) {
        const before = settings.permissions.deny.length;
        settings.permissions.deny = settings.permissions.deny.filter(
          (e) => !GSD_CLAUDE_DENY_PERMISSIONS.includes(e)
        );
        if (settings.permissions.deny.length !== before) {
          permissionsModified = true;
        }
      }
      if (permissionsModified) {
        settingsModified = true;
        console.log(`  ${green}✓${reset} Removed GSD permissions from settings.json`);
      }
    }

    // #2096 Phase B Upgrade 1 — Remove GSD-owned Antigravity permissions.allow
    // rules from settings.json. Symmetric to the Claude branch above: filters
    // only the exact GSD-owned rule strings (regenerated from the current
    // configDir) to preserve any user-added allow entries and all deny/ask.
    if (resolveInstallPlan(runtime).finishPermissionWriter === 'antigravity' && settings.permissions) {
      let antigravityPermissionsModified = false;
      if (Array.isArray(settings.permissions.allow)) {
        const gsdRules = new Set(buildAntigravityAllowRules(targetDir));
        const before = settings.permissions.allow.length;
        settings.permissions.allow = settings.permissions.allow.filter((e) => !gsdRules.has(e));
        if (settings.permissions.allow.length !== before) {
          antigravityPermissionsModified = true;
        }
        if (settings.permissions.allow.length === 0) {
          delete settings.permissions.allow;
        }
      }
      if (Object.keys(settings.permissions).length === 0) {
        delete settings.permissions;
      }
      if (antigravityPermissionsModified) {
        settingsModified = true;
        console.log(`  ${green}✓${reset} Removed GSD permissions from settings.json`);
      }
    }

    // #2097 UPGRADE 3 — Remove the MCP companion entry from settings.json for
    // runtimes that host MCP there (Augment), symmetric to the mcp_config.json
    // removal for Antigravity below. Only the GSD-owned mcpServers.gsd key is
    // removed — any other user-configured MCP servers are preserved.
    if (_hostBehaviors(runtime).mcpCompanion === 'settings-json' &&
      settings.mcpServers && typeof settings.mcpServers === 'object' &&
      settings.mcpServers.gsd !== undefined) {
      delete settings.mcpServers.gsd;
      if (Object.keys(settings.mcpServers).length === 0) {
        delete settings.mcpServers;
      }
      settingsModified = true;
      console.log(`  ${green}✓${reset} Removed GSD MCP companion server from settings.json`);
    }

    if (settingsModified) {
      writeSettings(settingsPath, settings);
      removedCount++;
    }
  }

  // 6. For OpenCode, clean up permissions from opencode.json or opencode.jsonc
  if (resolveInstallPlan(runtime).finishPermissionWriter === 'opencode') {
    const configPath = resolveOpencodeConfigPath(targetDir);
    if (fs.existsSync(configPath)) {
      try {
        const config = parseJsonc(fs.readFileSync(configPath, 'utf8'));
        let modified = false;

        // Remove GSD permission entries
        if (config.permission) {
          for (const permType of ['read', 'external_directory']) {
            if (config.permission[permType]) {
              const keys = Object.keys(config.permission[permType]);
              for (const key of keys) {
                if (key.includes('gsd-core')) {
                  delete config.permission[permType][key];
                  modified = true;
                }
              }
              // Clean up empty objects
              if (Object.keys(config.permission[permType]).length === 0) {
                delete config.permission[permType];
              }
            }
          }
          if (Object.keys(config.permission).length === 0) {
            delete config.permission;
          }
        }

        if (modified) {
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
          removedCount++;
          console.log(`  ${green}✓${reset} Removed GSD permissions from ${path.basename(configPath)}`);
        }
      } catch (e) {
        // Ignore JSON parse errors
      }
    }
  }

  // 7. For Kilo, clean up permissions from kilo.json or kilo.jsonc
  // #2093: descriptor-driven via resolveInstallPlan(runtime).finishPermissionWriter,
  // mirroring the OpenCode branch above (was hardcoded `isKilo`).
  if (resolveInstallPlan(runtime).finishPermissionWriter === 'kilo') {
    const configPath = resolveKiloConfigPath(targetDir);
    if (fs.existsSync(configPath)) {
      try {
        const config = parseJsonc(fs.readFileSync(configPath, 'utf8'));
        let modified = false;

        // Remove GSD permission entries
        if (config.permission) {
          for (const permType of ['read', 'external_directory']) {
            if (config.permission[permType]) {
              const keys = Object.keys(config.permission[permType]);
              for (const key of keys) {
                if (key.includes('gsd-core')) {
                  delete config.permission[permType][key];
                  modified = true;
                }
              }
              // Clean up empty objects
              if (Object.keys(config.permission[permType]).length === 0) {
                delete config.permission[permType];
              }
            }
          }
          if (Object.keys(config.permission).length === 0) {
            delete config.permission;
          }
        }

        if (modified) {
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
          removedCount++;
          console.log(`  ${green}✓${reset} Removed GSD permissions from ${path.basename(configPath)}`);
        }
      } catch (e) {
        // Ignore JSON parse errors
      }
    }
  }

  // 8. For Antigravity, remove the MCP companion entry from mcp_config.json
  // (#2096 Phase B Upgrade 2). Only the GSD-owned mcpServers.gsd key is
  // removed — any other user-configured MCP servers are preserved.
  if (resolveInstallPlan(runtime).finishPermissionWriter === 'antigravity') {
    const mcpConfigPath = path.join(targetDir, 'mcp_config.json');
    if (fs.existsSync(mcpConfigPath)) {
      try {
        const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf8'));
        if (mcpConfig && typeof mcpConfig === 'object' && mcpConfig.mcpServers && mcpConfig.mcpServers.gsd !== undefined) {
          delete mcpConfig.mcpServers.gsd;
          if (Object.keys(mcpConfig.mcpServers).length === 0) {
            delete mcpConfig.mcpServers;
          }
          fs.writeFileSync(mcpConfigPath, JSON.stringify(mcpConfig, null, 2) + '\n');
          removedCount++;
          console.log(`  ${green}✓${reset} Removed GSD MCP companion server from mcp_config.json`);
        }
      } catch (e) {
        // Ignore JSON parse errors
      }
    }
  }

  // Remove the file manifest that the installer wrote at install time.
  // Without this step the metadata file persists after uninstall (#1908).
  const manifestPath = path.join(targetDir, MANIFEST_NAME);
  if (fs.existsSync(manifestPath)) {
    fs.rmSync(manifestPath, { force: true });
    removedCount++;
    console.log(`  ${green}✓${reset} Removed ${MANIFEST_NAME}`);
  }

  if (removedCount === 0) {
    console.log(`  ${yellow}⚠${reset} No GSD files found to remove.`);
  }

  console.log(`
  ${green}Done!${reset} GSD has been uninstalled from ${runtimeLabel}.
  Your other files and settings have been preserved.
`);
}

/**
 * Parse JSONC (JSON with Comments) by stripping comments and trailing commas.
 * OpenCode supports JSONC format via jsonc-parser, so users may have comments.
 * This is a lightweight inline parser to avoid adding dependencies.
 */
function parseJsonc(content) {
  // Strip BOM if present
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }

  // Remove single-line and block comments while preserving strings
  let result = '';
  let inString = false;
  let i = 0;
  while (i < content.length) {
    const char = content[i];
    const next = content[i + 1];

    if (inString) {
      result += char;
      // Handle escape sequences
      if (char === '\\' && i + 1 < content.length) {
        result += next;
        i += 2;
        continue;
      }
      if (char === '"') {
        inString = false;
      }
      i++;
    } else {
      if (char === '"') {
        inString = true;
        result += char;
        i++;
      } else if (char === '/' && next === '/') {
        // Skip single-line comment until end of line
        while (i < content.length && content[i] !== '\n') {
          i++;
        }
      } else if (char === '/' && next === '*') {
        // Skip block comment
        i += 2;
        while (i < content.length - 1 && !(content[i] === '*' && content[i + 1] === '/')) {
          i++;
        }
        i += 2; // Skip closing */
      } else {
        result += char;
        i++;
      }
    }
  }

  // Remove trailing commas before } or ]
  result = result.replace(/,(\s*[}\]])/g, '$1');

  return JSON.parse(result);
}

/**
 * Configure OpenCode permissions to allow reading GSD reference docs
 * This prevents permission prompts when GSD accesses the gsd-core directory
 * @param {boolean} isGlobal - Whether this is a global or local install
 * @param {string|null} configDir - Resolved config directory when already known
 */
function configureOpencodePermissions(isGlobal = true, configDir = null) {
  // For local installs, use ./.opencode/
  // For global installs, use ~/.config/opencode/
  const opencodeConfigDir = configDir || (isGlobal
    ? getGlobalConfigDir('opencode', explicitConfigDir)
    : path.join(process.cwd(), '.opencode'));
  // Ensure config directory exists
  fs.mkdirSync(opencodeConfigDir, { recursive: true });

  const configPath = resolveOpencodeConfigPath(opencodeConfigDir);

  // Read existing config or create empty object
  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      config = parseJsonc(content);
    } catch (e) {
      // Cannot parse - DO NOT overwrite user's config
      const configFile = path.basename(configPath);
      console.log(`  ${yellow}⚠${reset} Could not parse ${configFile} - skipping permission config`);
      console.log(`    ${dim}Reason: ${e.message}${reset}`);
      console.log(`    ${dim}Your config was NOT modified. Fix the syntax manually if needed.${reset}`);
      return;
    }
  }

  // OpenCode also allows a top-level string permission like "allow".
  // In that case, path-specific permission entries are unnecessary.
  if (typeof config.permission === 'string') {
    return;
  }

  // Ensure permission structure exists
  if (!config.permission || typeof config.permission !== 'object') {
    config.permission = {};
  }

  // Build the GSD path using the actual config directory
  // Use ~ shorthand if it's in the default location, otherwise use full path
  const defaultConfigDir = path.join(os.homedir(), '.config', 'opencode');
  const gsdPath = opencodeConfigDir === defaultConfigDir
    ? '~/.config/opencode/gsd-core/*'
    : `${opencodeConfigDir.replace(/\\/g, '/')}/gsd-core/*`;

  let modified = false;

  // Configure read permission
  if (!config.permission.read || typeof config.permission.read !== 'object') {
    config.permission.read = {};
  }
  if (config.permission.read[gsdPath] !== 'allow') {
    config.permission.read[gsdPath] = 'allow';
    modified = true;
  }

  // Configure external_directory permission (the safety guard for paths outside)
  if (!config.permission.external_directory || typeof config.permission.external_directory !== 'object') {
    config.permission.external_directory = {};
  }
  if (config.permission.external_directory[gsdPath] !== 'allow') {
    config.permission.external_directory[gsdPath] = 'allow';
    modified = true;
  }

  // ADR-1239 Phase D / #1682 — register the companion MCP server (Phase 4) so
  // OpenCode connects to GSD's command (point 1) + state-IO (point 5) surface
  // with NO bespoke plugin. Idempotent + non-clobbering: only added when
  // `mcp.gsd` is absent (a user-defined `mcp.gsd` is respected — Hyrum's Law).
  // Local-stdio schema per OpenCode config (packages/core/src/config/mcp.ts).
  // `-p @opengsd/gsd-core` resolves the `gsd-mcp-server` bin from this package
  // (bin name != package name) regardless of global-install state.
  if (!config.mcp || typeof config.mcp !== 'object') {
    config.mcp = {};
  }
  if (config.mcp.gsd === undefined) {
    config.mcp.gsd = {
      type: 'local',
      command: ['npx', '-y', '-p', PACKAGE_NAME, 'gsd-mcp-server'],
      enabled: true,
    };
    modified = true;
  }

  if (!modified) {
    return; // Already configured
  }

  // Write config back
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`  ${green}✓${reset} Configured read permission for GSD docs`);
}

/**
 * Configure Kilo permissions to allow reading GSD reference docs
 * This prevents permission prompts when GSD accesses the gsd-core directory
 * @param {boolean} isGlobal - Whether this is a global or local install
 * @param {string|null} configDir - Resolved config directory when already known
 */
function configureKiloPermissions(isGlobal = true, configDir = null) {
  // For local installs, use ./.kilo/
  // For global installs, use ~/.config/kilo/
  const kiloConfigDir = configDir || (isGlobal
    ? getGlobalConfigDir('kilo', explicitConfigDir)
    : path.join(process.cwd(), '.kilo'));
  // Ensure config directory exists
  fs.mkdirSync(kiloConfigDir, { recursive: true });

  const configPath = resolveKiloConfigPath(kiloConfigDir);

  // Read existing config or create empty object
  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      const content = fs.readFileSync(configPath, 'utf8');
      config = parseJsonc(content);
    } catch (e) {
      // Cannot parse - DO NOT overwrite user's config
      const configFile = path.basename(configPath);
      console.log(`  ${yellow}⚠${reset} Could not parse ${configFile} - skipping permission config`);
      console.log(`    ${dim}Reason: ${e.message}${reset}`);
      console.log(`    ${dim}Your config was NOT modified. Fix the syntax manually if needed.${reset}`);
      return;
    }
  }

  // Ensure permission structure exists
  if (!config.permission || typeof config.permission !== 'object') {
    config.permission = {};
  }

  // Build the GSD path using the actual config directory
  // Use ~ shorthand if it's in the default location, otherwise use full path
  const defaultConfigDir = path.join(os.homedir(), '.config', 'kilo');
  const gsdPath = kiloConfigDir === defaultConfigDir
    ? '~/.config/kilo/gsd-core/*'
    : `${kiloConfigDir.replace(/\\/g, '/')}/gsd-core/*`;

  let modified = false;

  // Configure read permission
  if (!config.permission.read || typeof config.permission.read !== 'object') {
    config.permission.read = {};
  }
  if (config.permission.read[gsdPath] !== 'allow') {
    config.permission.read[gsdPath] = 'allow';
    modified = true;
  }

  // Configure external_directory permission (the safety guard for paths outside project)
  if (!config.permission.external_directory || typeof config.permission.external_directory !== 'object') {
    config.permission.external_directory = {};
  }
  if (config.permission.external_directory[gsdPath] !== 'allow') {
    config.permission.external_directory[gsdPath] = 'allow';
    modified = true;
  }

  if (!modified) {
    return; // Already configured
  }

  // Write config back
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`  ${green}✓${reset} Configured read permission for GSD docs`);
}

/**
 * Convert an absolute path to a `~`-relative form when it lives under the
 * user's home directory (generalizes configureKiloPermissions'
 * single-default-dir shorthand to Antigravity's three probed sibling config
 * dirs — antigravity/antigravity-ide/antigravity-cli under ~/.gemini — none of
 * which is a single fixed "default").
 */
function toTildePosixPath(absPath) {
  const posixPath = absPath.replace(/\\/g, '/');
  const posixHome = os.homedir().replace(/\\/g, '/');
  return posixPath === posixHome || posixPath.startsWith(`${posixHome}/`)
    ? `~${posixPath.slice(posixHome.length)}`
    : posixPath;
}

/**
 * Antigravity permission rule strings this installer contributes.
 * Schema: antigravity.google/docs/cli/permissions — "action(target)" rule
 * strings in permissions.{allow,deny,ask}, evaluated deny > ask > allow. GSD
 * only ever contributes to `allow` — never deny/ask (those are user-owned risk
 * decisions this installer has no business making).
 */
function buildAntigravityAllowRules(configDir) {
  const gsdPath = toTildePosixPath(configDir);
  return [
    `read_file(${gsdPath}/gsd-core/*)`,
    `read_file(${gsdPath}/agents/gsd-*)`,
    `read_file(${gsdPath}/skills/gsd-*)`,
    `command(node ${gsdPath}/hooks/*)`,
  ];
}

/**
 * Configure Antigravity permissions to allow reading/executing GSD's installed
 * tree without per-call approval prompts (#2096 Phase B Upgrade 1 — mirrors
 * configureKiloPermissions/configureOpencodePermissions).
 *
 * Antigravity's permission schema (antigravity.google/docs/cli/permissions) is
 * `{"permissions":{"allow":[...],"deny":[...],"ask":[...]}}`, living in the
 * SAME settings.json GSD's own hook registration writes for this runtime
 * (installSurface: 'settings-json', writesSharedSettings: true) — unlike
 * Kilo/OpenCode, which write a separate native config file. This function
 * re-reads the file (already containing GSD's hooks by the time finishInstall
 * reaches this call) and only appends to permissions.allow.
 *
 * Non-destructive + idempotent: only `permissions.allow` is touched; an
 * existing user permissions block (including any deny/ask entries, or
 * unrelated allow entries) is preserved untouched.
 *
 * @param {boolean} isGlobal - Whether this is a global or local install
 * @param {string|null} configDir - Resolved config directory when already known
 */
function configureAntigravityPermissions(isGlobal = true, configDir = null) {
  // For local installs, use ./.agents/ (GSD's antigravity localConfigDir)
  // For global installs, use the resolved ~/.gemini/antigravity{,-ide,-cli}
  const antigravityConfigDir = configDir || (isGlobal
    ? getGlobalConfigDir('antigravity', explicitConfigDir)
    : path.join(process.cwd(), '.agents'));
  // Ensure config directory exists
  fs.mkdirSync(antigravityConfigDir, { recursive: true });

  const configPath = path.join(antigravityConfigDir, 'settings.json');

  // Read existing settings.json (readSettings tolerates JSONC + missing file;
  // returns null — and warns — only when the file exists but fails to parse).
  const config = readSettings(configPath);
  if (config === null) {
    // Cannot parse — DO NOT overwrite user's config (readSettings already warned).
    return;
  }

  // Ensure permission structure exists
  if (!config.permissions || typeof config.permissions !== 'object' || Array.isArray(config.permissions)) {
    config.permissions = {};
  }
  if (!Array.isArray(config.permissions.allow)) {
    config.permissions.allow = [];
  }

  let modified = false;
  for (const rule of buildAntigravityAllowRules(antigravityConfigDir)) {
    if (!config.permissions.allow.includes(rule)) {
      config.permissions.allow.push(rule);
      modified = true;
    }
  }

  if (!modified) {
    return; // Already configured
  }

  writeSettings(configPath, config);
  console.log(`  ${green}✓${reset} Configured Antigravity permissions for GSD paths`);
}

/**
 * Configure Antigravity's MCP companion server config (#2096 Phase B
 * Upgrade 2).
 *
 * Antigravity CLI manages MCP servers via standalone `mcp_config.json`
 * profiles rather than nesting them in settings.json (antigravity.google/docs/
 * cli/gcli-migration: "Antigravity CLI uses standalone mcp_config.json
 * profiles in ~/.gemini/config/ for global servers and .agents/mcp_config.json
 * for workspace servers"). The raw schema for the Antigravity IDE surface
 * itself is unpublished (docs are JS-rendered), so this follows the CLI's
 * documented standalone-profile convention plus the standard Gemini/MCP
 * `mcpServers` shape.
 *
 * BEST-EFFORT PATH CHOICE: rather than the CLI doc's separate `~/.gemini/config/`
 * directory for global scope, this writes `<configDir>/mcp_config.json` — the
 * SAME resolved configDir as settings.json (configureAntigravityPermissions) —
 * because (1) GSD's own antigravity configDir resolution already varies
 * per-user across three sibling dirs (antigravity/antigravity-ide/
 * antigravity-cli — see resolveAntigravityGlobalDir), so a hardcoded separate
 * shared path would not track that resolution, and (2) it matches the doc's
 * OWN workspace-scope convention exactly (`.agents/mcp_config.json`, which IS
 * GSD's local configDir for antigravity), keeping global/local symmetric and
 * consistent with the configDir-relative convention every other GSD
 * permission writer (kilo/opencode) already uses.
 *
 * Non-destructive + idempotent: only adds mcpServers.gsd when entirely absent;
 * any other user-configured mcpServers entries (or a user's OWN "gsd" override)
 * are preserved untouched (Hyrum's Law — mirrors OpenCode's config.mcp.gsd guard).
 *
 * @param {boolean} isGlobal - Whether this is a global or local install
 * @param {string|null} configDir - Resolved config directory when already known
 */
function configureAntigravityMcpConfig(isGlobal = true, configDir = null) {
  const antigravityConfigDir = configDir || (isGlobal
    ? getGlobalConfigDir('antigravity', explicitConfigDir)
    : path.join(process.cwd(), '.agents'));
  fs.mkdirSync(antigravityConfigDir, { recursive: true });

  const configPath = path.join(antigravityConfigDir, 'mcp_config.json');

  let config = {};
  if (fs.existsSync(configPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      config = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
    } catch (e) {
      // Cannot parse - DO NOT overwrite user's config
      console.log(`  ${yellow}⚠${reset} Could not parse mcp_config.json - skipping MCP companion config`);
      console.log(`    ${dim}Reason: ${e.message}${reset}`);
      console.log(`    ${dim}Your config was NOT modified. Fix the syntax manually if needed.${reset}`);
      return;
    }
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) {
    config.mcpServers = {};
  }

  if (config.mcpServers.gsd !== undefined) {
    return; // Already configured (or a user-owned override) — never clobber.
  }

  config.mcpServers.gsd = {
    command: 'npx',
    args: ['-y', '-p', PACKAGE_NAME, 'gsd-mcp-server'],
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  console.log(`  ${green}✓${reset} Configured Antigravity MCP companion server (gsd)`);
}

/**
 * #2097 (ADR-1239 transport:mcp): register the GSD companion MCP server inside a
 * runtime's settings.json (Augment hosts MCP in settings.json.mcpServers, unlike
 * Antigravity's standalone mcp_config.json). Mutates the in-memory settings object
 * that finishInstall already writes — non-destructive + idempotent: only sets
 * mcpServers.gsd, preserving any user-defined servers (a user's own `gsd` override
 * is respected — Hyrum's Law).
 * @param {object} settings - the in-memory settings object finishInstall will write
 */
function mergeGsdMcpServerIntoSettings(settings) {
  if (!settings.mcpServers || typeof settings.mcpServers !== 'object' || Array.isArray(settings.mcpServers)) {
    settings.mcpServers = {};
  }
  if (settings.mcpServers.gsd === undefined) {
    settings.mcpServers.gsd = {
      command: 'npx',
      args: ['-y', '-p', PACKAGE_NAME, 'gsd-mcp-server'],
    };
  }
}

/**
 * Verify a directory exists and contains files
 */
function verifyInstalled(dirPath, description) {
  if (!fs.existsSync(dirPath)) {
    console.error(`  ${yellow}✗${reset} Failed to install ${description}: directory not created`);
    return false;
  }
  try {
    const entries = fs.readdirSync(dirPath);
    if (entries.length === 0) {
      console.error(`  ${yellow}✗${reset} Failed to install ${description}: directory is empty`);
      return false;
    }
  } catch (e) {
    console.error(`  ${yellow}✗${reset} Failed to install ${description}: ${e.message}`);
    return false;
  }
  return true;
}

/**
 * Verify a file exists
 */
function verifyFileInstalled(filePath, description) {
  if (!fs.existsSync(filePath)) {
    console.error(`  ${yellow}✗${reset} Failed to install ${description}: file not created`);
    return false;
  }
  return true;
}

/**
 * Install to the specified directory for a specific runtime
 * @param {boolean} isGlobal - Whether to install globally or locally
 * @param {string} runtime - Target runtime ('claude', 'opencode', 'codex')
 */

// ──────────────────────────────────────────────────────
// Local Patch Persistence
// ──────────────────────────────────────────────────────

const PATCHES_DIR_NAME = 'gsd-local-patches';
const MANIFEST_NAME = 'gsd-file-manifest.json';

/**
 * Compute SHA256 hash of file contents
 */
function fileHash(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Recursively collect all files in dir with their hashes
 */
function generateManifest(dir, baseDir) {
  if (!baseDir) baseDir = dir;
  const manifest = {};
  if (!fs.existsSync(dir)) return manifest;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      Object.assign(manifest, generateManifest(fullPath, baseDir));
    } else {
      manifest[relPath] = fileHash(fullPath);
    }
  }
  return manifest;
}

function normalizeInstallRelativePath(relPath) {
  if (typeof relPath !== 'string' || relPath.trim() === '' || relPath.includes('\0')) {
    return null;
  }
  if (path.isAbsolute(relPath) || path.win32.isAbsolute(relPath)) {
    return null;
  }
  const normalized = relPath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }
  return segments.join('/');
}

function resolveInstallRelativePath(baseDir, relPath) {
  const normalized = normalizeInstallRelativePath(relPath);
  if (!normalized) return null;
  const root = path.resolve(baseDir);
  const fullPath = path.resolve(root, normalized);
  if (fullPath !== root && !fullPath.startsWith(root + path.sep)) {
    return null;
  }
  if (hasExistingSymlinkBetween(root, fullPath, { allowOptInFollow: isSymlinkedDestOptIn() })) {
    return null;
  }
  return { relPath: normalized, fullPath };
}

// hasExistingSymlinkBetween: moved to src/install-engine.cts (ADR-1239 Phase B).
// Imported from installEngine above.

/**
 * Write file manifest after installation for future modification detection
 */
function writeManifest(configDir, runtime = DEFAULT_RUNTIME, options = {}) {
  // #2093: isKilo dropped — unused in this function.
  // #2094: isTrae dropped — was only used in the hooks-tracking conditional
  // above, now covered by hostBehaviors.skipSharedHooksInstall.
  // #2095: isKimi dropped — kimi is now a hooks/ consumer like every other
  // settings-json-adjacent runtime, so the `&& !isKimi` term below was removed.
  // #2096: isAntigravity dropped — unused in this function.
  // #2098: isCodebuddy dropped — unused in this function.
  // #2099: isCopilot dropped — was only used in the hooks-tracking conditional
  // above, now covered by hostBehaviors.skipSharedHooksInstall.
  // #2100: isWindsurf dropped — was only used in the hooks-tracking conditional
  // above, now covered by hostBehaviors.skipSharedHooksInstall.
  const { isOpencode, isCodex, isCursor, isAugment, isQwen, isHermes, isCline } = runtimeFlags(runtime);
  const gsdDir = path.join(configDir, 'gsd-core');
  // #1367: Claude local now writes flat gsd-*.md files at commands/ (not commands/gsd/).
  // Claude local uses flatCommandsDir instead for manifest recording.
  const flatCommandsDir = path.join(configDir, 'commands');
  const opencodeCommandDir = path.join(configDir, _hostBehaviors(runtime).flatCommandDir || 'command');
  // Hermes nests GSD skills under skills/gsd/ as a single category (#2841) —
  // already encoded in its layout descriptor's destSubpath ('skills/gsd').
  // All other runtimes that use the Codex-style skills layout use a flat skills/ root.
  // ADR-1239 upgrade 3 (#2088): honor a skills-kind `home` override (e.g. Codex
  // skills -> $HOME/.agents/skills instead of configDir/skills) via the same
  // descriptor-driven helper used by the snapshot/rollback/verification paths,
  // so the manifest records what's actually on disk. _resolveSkillsRootDir already
  // resolves destSubpath (which includes hermes's 'skills/gsd' nesting) — do not
  // re-append 'gsd' or the hermes dir gets double-nested to skills/gsd/gsd.
  // #2872 (ADR-2866 Phase 3): the scope used to pick the skills root and the
  // scope RECORDED in the manifest are one value, resolved once. Two reads of
  // `options.scope` could drift; one cannot.
  const resolvedScope = options.scope === 'local' ? 'local' : 'global';
  const codexSkillsDir = _resolveSkillsRootDir(runtime, configDir, resolvedScope);
  const codexSkillsManifestPrefix = _hostBehaviors(runtime).skillsManifestPrefix || 'skills/';
  // #3738: resolve the ACTUAL agents-install dir honoring an agents-kind `home`
  // override (antigravity global → $HOME/.gemini/config/agents), mirroring
  // _resolveSkillsRootDir for skills. Hardcoding configDir/agents left the
  // manifest blind to the whole agents surface the moment the override landed —
  // no drift detection, no patch backup. Falls back to <configDir>/agents.
  const agentsDir = _kindDestDirSafe(runtime, configDir, resolvedScope, 'agents')
    || _kindDestDirSafe(runtime, configDir, resolvedScope, 'kimi-agents')
    || path.join(configDir, 'agents');
  const manifest = {
    // Schema version of this DOCUMENT (#2872) — distinct from `version`
    // below, which is the GSD package version. Absent ⇒ a pre-#2872 (v1)
    // manifest, which readInstallManifest still reads without error and
    // without requiring a reinstall. Read from the Installer Migration
    // Module rather than repeated as a second literal: the writer here and
    // the reader's normalizeManifestVersion are two surfaces over one
    // constant, and this repo's "generative fix divergence" class is exactly
    // two such literals drifting apart.
    manifestVersion: MANIFEST_SCHEMA_VERSION,
    version: pkg.version,
    timestamp: new Date().toISOString(),
    mode: options.mode === 'minimal' ? 'minimal' : 'full',
    // Recorded so an Installed Surface Resolver can answer "which surfaces
    // are installed, at which scopes, for which runtimes" without re-deriving
    // it from the directory it happened to be found in (#2872).
    runtime,
    scope: resolvedScope,
    files: {},
  };

  const gsdHashes = generateManifest(gsdDir);
  for (const [rel, hash] of Object.entries(gsdHashes)) {
    // Skip user-owned artifacts (e.g. USER-PROFILE.md). They are staged
    // durably and restored across reinstalls (user-artifact-staging.cts,
    // #2875) and must NOT be hashed into the manifest — otherwise
    // saveLocalPatches() would flag every refresh as a "local patch"
    // (bug #2771). Single source of truth: USER_OWNED_ARTIFACTS at top of file.
    if (USER_OWNED_ARTIFACTS.includes(rel)) continue;
    manifest.files['gsd-core/' + rel] = hash;
  }
  // Record commands surface for runtimes that emit it:
  //   Claude local (#1367 fix): flat gsd-<cmd>.md at commands/ level
  // Manifest must reflect everything on disk so saveLocalPatches() can detect
  // user edits and per-runtime minimal-mode assertions can read manifest.files.
  // Claude local (#1367): flat gsd-*.md files at commands/ level.
  // Only claude local writes gsd-*.md here; global installs don't emit commands,
  // so this branch is a no-op for global (no matching files to find).
  if (_hostBehaviors(runtime).localInstallStyle === 'legacy-flat' && fs.existsSync(flatCommandsDir)) {
    for (const file of fs.readdirSync(flatCommandsDir)) {
      if (file.startsWith('gsd-') && file.endsWith('.md')) {
        manifest.files['commands/' + file] = fileHash(path.join(flatCommandsDir, file));
      }
    }
  }
  if (_hostBehaviors(runtime).flatCommandDir && fs.existsSync(opencodeCommandDir)) {
    // #2329: derive the manifest key prefix from the SAME descriptor value used
    // to compute opencodeCommandDir above, instead of a separately-hardcoded
    // literal — a divergence here would silently break the manifest even after
    // the destSubpath descriptor is corrected (Generative Fix Divergence guard).
    const flatCommandDirPrefix = _hostBehaviors(runtime).flatCommandDir || 'command';
    for (const file of fs.readdirSync(opencodeCommandDir)) {
      if (file.startsWith('gsd-') && file.endsWith('.md')) {
        manifest.files[flatCommandDirPrefix + '/' + file] = fileHash(path.join(opencodeCommandDir, file));
      }
    }
  }
  if (!_hostBehaviors(runtime).skipCodexSkillsManifest && fs.existsSync(codexSkillsDir)) {
    // All runtimes (including Hermes post-#947) use the canonical 'gsd-' prefix.
    const skillListPrefix = 'gsd-';
    for (const skillName of listCodexSkillNames(codexSkillsDir, skillListPrefix)) {
      const skillRoot = path.join(codexSkillsDir, skillName);
      const skillHashes = generateManifest(skillRoot);
      for (const [rel, hash] of Object.entries(skillHashes)) {
        manifest.files[`${codexSkillsManifestPrefix}${skillName}/${rel}`] = hash;
      }
    }
    // Descriptor-driven (#2090): hash the category DESCRIPTION.md so reinstall detects drift.
    if (_hostBehaviors(runtime).trackCategoryDescription) {
      const descPath = path.join(codexSkillsDir, 'DESCRIPTION.md');
      if (fs.existsSync(descPath)) {
        manifest.files['skills/gsd/DESCRIPTION.md'] = fileHash(descPath);
      }
    }
  }
  if (_hostBehaviors(runtime).agentManifestStyle === 'kimi-nested' && fs.existsSync(agentsDir)) {
    const agentHashes = generateManifest(agentsDir);
    for (const [rel, hash] of Object.entries(agentHashes)) {
      const isRootAgent = rel === 'gsd.yaml' || rel === 'gsd.md';
      const isSubagent = /^subagents\/gsd-[^/]+\.(yaml|md)$/.test(rel);
      if (isRootAgent || isSubagent) {
        manifest.files['agents/' + rel] = hash;
      }
    }
  } else if (fs.existsSync(agentsDir)) {
    for (const file of fs.readdirSync(agentsDir)) {
      if (file.startsWith('gsd-') && (file.endsWith('.md') || file.endsWith('.toml'))) {
        manifest.files['agents/' + file] = fileHash(path.join(agentsDir, file));
      }
    }
  }
  // Track Cline directory-form artifacts in the manifest (issue #787): the
  // rules file and the PreToolUse hook. (~/.agents/AGENTS.md is tracked via its
  // marker block, not the per-configDir manifest, since it lives outside it.)
  // Descriptor-driven (ADR-1239 / #2090): folded from `isCline` into
  // hostBehaviors.clineRulesSurface.
  if (_hostBehaviors(runtime).clineRulesSurface) {
    for (const rel of ['.clinerules/gsd.md', '.clinerules/hooks/PreToolUse']) {
      const dest = path.join(configDir, rel);
      if (fs.existsSync(dest)) {
        manifest.files[rel] = fileHash(dest);
      }
    }
  }

  // Track hook files so saveLocalPatches() can detect user modifications
  // Hooks are only installed for runtimes that use settings.json (not Codex/Copilot/Cline)
  // Descriptor-driven (ADR-1239 / #2089+#2090): cline's exclusion is via
  // hostBehaviors.skipSharedHooksInstall (was hardcoded !isCline).
  // #2094: Trae's exclusion is likewise descriptor-driven (trae declares
  // skipSharedHooksInstall:true) — the redundant `&& !isTrae` was removed.
  // #2095: kimi is now a hooks/ consumer (native config.toml [[hooks]] bus) —
  // the redundant `&& !isKimi` was removed so its hook files are tracked too.
  // #2099: Copilot's exclusion is likewise descriptor-driven (copilot declares
  // skipSharedHooksInstall:true) — the redundant `&& !isCopilot` was removed.
  // #2100: Windsurf's exclusion is likewise descriptor-driven (windsurf declares
  // skipSharedHooksInstall:true) — the redundant `&& !isWindsurf` was removed.
  if (!isCodex && _hostBehaviors(runtime).skipSharedHooksInstall !== true) {
    // #3023: manifest keys must track the bundle wherever the descriptor put it,
    // or uninstall/saveLocalPatches silently orphan the tree.
    const sharedHooksDirName = resolveSharedHooksDirName(runtime);
    const hooksDir = path.join(configDir, sharedHooksDirName);
    if (fs.existsSync(hooksDir)) {
      // Drive from INSTALLED_HOOK_FILES (the canonical HOOKS_TO_COPY set from
      // scripts/build-hooks.js) rather than a prefix/extension regex, so the
      // manifest set is structurally identical to the build set. The old regex
      // `file.startsWith('gsd-') && (file.endsWith('.js') || file.endsWith('.sh'))`
      // missed managed-hooks-registry.cjs (wrong prefix, .cjs extension), causing
      // detect-custom-files to flag it as a perpetual false-positive custom file
      // on every /gsd-update. See #941.
      for (const hook of INSTALLED_HOOK_FILES) {
        const hookPath = path.join(hooksDir, hook);
        if (fs.existsSync(hookPath)) {
          manifest.files[sharedHooksDirName + '/' + hook] = fileHash(hookPath);
        }
      }
      // Track hooks/lib/ helpers so saveLocalPatches() can back up user edits
      // to git-cmd.js (validate-commit classifier) and gsd-graphify-rebuild.sh.
      const hooksLibDir = path.join(hooksDir, 'lib');
      if (fs.existsSync(hooksLibDir)) {
        for (const file of fs.readdirSync(hooksLibDir)) {
          if (GSD_HOOK_LIB_FILES.includes(file)) {
            manifest.files[sharedHooksDirName + '/lib/' + file] = fileHash(path.join(hooksLibDir, file));
          }
        }
      }
    }
  }

  // Track scripts/changeset/ and scripts/lib/ so saveLocalPatches() can detect drift
  const changesetInstallDir = path.join(configDir, 'scripts', 'changeset');
  if (fs.existsSync(changesetInstallDir)) {
    for (const file of fs.readdirSync(changesetInstallDir)) {
      if (file.endsWith('.cjs')) {
        manifest.files['scripts/changeset/' + file] = fileHash(path.join(changesetInstallDir, file));
      }
    }
  }
  const scriptsLibInstallDir = path.join(configDir, 'scripts', 'lib');
  if (fs.existsSync(scriptsLibInstallDir)) {
    for (const file of fs.readdirSync(scriptsLibInstallDir)) {
      if (file.endsWith('.cjs')) {
        manifest.files['scripts/lib/' + file] = fileHash(path.join(scriptsLibInstallDir, file));
      }
    }
  }

  // Track scripts/fix-slash-commands.cjs (top-level scripts/ file, not covered by changeset/lib loops)
  const fixSlashInstallPath = path.join(configDir, 'scripts', 'fix-slash-commands.cjs');
  if (fs.existsSync(fixSlashInstallPath)) {
    manifest.files['scripts/fix-slash-commands.cjs'] = fileHash(fixSlashInstallPath);
  }

  // Track the capability registry generator scripts (#1920) — top-level scripts/ files
  // not covered by the changeset/lib loops.
  for (const gen of ['gen-capability-registry.cjs', 'gen-loop-host-contract.cjs']) {
    const genInstallPath = path.join(configDir, 'scripts', gen);
    if (fs.existsSync(genInstallPath)) {
      manifest.files['scripts/' + gen] = fileHash(genInstallPath);
    }
  }

  // Track the OpenCode native plugin adapter (#1914) so update/drift detection
  // and uninstall can account for it.
  const _npM = _hostBehaviors(runtime).nativePlugin;
  if (_npM) {
    const pluginInstallPath = path.join(configDir, _npM.dir, _npM.file);
    if (fs.existsSync(pluginInstallPath)) {
      manifest.files[`${_npM.dir}/${_npM.file}`] = fileHash(pluginInstallPath);
    }
  }

  fs.writeFileSync(path.join(configDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  return manifest;
}

/**
 * Populate gsd-pristine/ with the transformed pristine versions of every
 * `modified` file, derived from the current package's source tree by
 * running the install transform pipeline (`copyWithPathReplacement`)
 * into a tmp directory, then copying out only the relevant paths.
 *
 * Pristine semantically represents "what the install would write to
 * configDir/<relPath> if the user had not modified it." This is what the
 * /gsd-reapply-patches Step 5 verifier (#2972) uses as the diff base
 * for "user-added lines" — lines in the user's backup that are NOT in
 * the pristine baseline. Without this dir, the verifier degrades to its
 * over-broad fallback ("every significant backup line"), exactly the
 * silent-success-on-lost-content failure mode #2969 was designed to
 * prevent (#2998).
 *
 * Implementation note: we run the FULL transform pipeline against a tmp
 * staging dir (one-time, only when modified.length > 0), then copy out
 * just the modified paths. This re-uses the existing transform code
 * exactly — pristine is byte-identical to what `copyWithPathReplacement`
 * would have written under normal install. Cost: one extra full transform
 * pass per install where local patches were detected; acceptable.
 */
function populatePristineDir({ packageSrc, pristineDir, modified, runtime, pathPrefix, isGlobal }) {
  if (!modified || modified.length === 0) return 0;
  // Modified paths come from manifest.files which can live under several
  // install roots: gsd-core/, commands/gsd/, command/, skills/, agents/,
  // hooks/, plus runtime-specific root files (#3004 CR). Stage every
  // top-level dir that actually contains a modified path; root-level files
  // are copied directly without the transform pipeline (they don't need
  // path replacement).
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-pristine-stage-'));
  let written = 0;
  try {
    const topLevels = new Set();
    const safeModified = [];
    for (const relPath of modified) {
      const norm = normalizeInstallRelativePath(relPath);
      if (!norm) continue;
      safeModified.push(norm);
      const slash = norm.indexOf('/');
      topLevels.add(slash === -1 ? '' : norm.slice(0, slash));
    }

    for (const top of topLevels) {
      if (top === '') {
        // Root-level files — copy directly from package source. The transform
        // pipeline is directory-oriented; root files don't need path-prefix
        // substitution (they're not markdown content with embedded paths).
        for (const relPath of safeModified) {
          const norm = normalizeInstallRelativePath(relPath);
          if (!norm) continue;
          if (norm.includes('/')) continue;
          const srcRef = resolveInstallRelativePath(packageSrc, norm);
          const stagedRef = resolveInstallRelativePath(stageRoot, norm);
          if (!srcRef || !stagedRef || !fs.existsSync(srcRef.fullPath)) continue;
          const stagedFile = stagedRef.fullPath;
          fs.mkdirSync(path.dirname(stagedFile), { recursive: true });
          fs.copyFileSync(srcRef.fullPath, stagedFile);
        }
        continue;
      }
      const srcDir = path.join(packageSrc, top);
      const stageDir = path.join(stageRoot, top);
      if (!fs.existsSync(srcDir)) continue;
      copyWithPathReplacement(srcDir, stageDir, pathPrefix, runtime, false, isGlobal, stageRoot);
    }

    for (const relPath of safeModified) {
      // Only populate pristine for paths we successfully staged. If a path's
      // source dir does not exist (obsolete manifest entry), skip silently
      // rather than corrupting pristine with stale data.
      const stagedRef = resolveInstallRelativePath(stageRoot, relPath);
      const outRef = resolveInstallRelativePath(pristineDir, relPath);
      if (!stagedRef || !outRef || !fs.existsSync(stagedRef.fullPath)) continue;
      fs.mkdirSync(path.dirname(outRef.fullPath), { recursive: true });
      fs.copyFileSync(stagedRef.fullPath, outRef.fullPath);
      written++;
    }
  } finally {
    try { fs.rmSync(stageRoot, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
  return written;
}

/**
 * Detect user-modified GSD files by comparing against install manifest.
 * Backs up modified files to gsd-local-patches/ for reapply after update.
 * Also saves pristine copies (from manifest) to gsd-pristine/ to enable
 * three-way merge during reapply-patches (pristine vs user vs new).
 *
 * The optional `pristineCtx` parameter (set by the install entry point)
 * carries the source package root, runtime, pathPrefix, and isGlobal
 * needed to populate gsd-pristine/. If omitted (legacy callers), pristine
 * stays empty — the verifier falls back to its over-broad heuristic, same
 * behavior as before #2998.
 */
function saveLocalPatches(configDir, pristineCtx) {
  const manifestPath = path.join(configDir, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return [];

  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch { return []; }

  // Normalize legacy manifests written before #2771 fix: strip user-owned artifacts
  // that were incorrectly recorded so refreshes don't surface false patches warnings.
  if (manifest.files) {
    for (const artifact of USER_OWNED_ARTIFACTS) {
      delete manifest.files[`gsd-core/${artifact}`];
    }
  }

  const patchesDir = path.join(configDir, PATCHES_DIR_NAME);
  const pristineDir = path.join(configDir, 'gsd-pristine');
  const modified = [];
  const pristineHashes = {};

  for (const [relPath, originalHash] of Object.entries(manifest.files || {})) {
    const safeRef = resolveInstallRelativePath(configDir, relPath);
    if (!safeRef) continue;
    const { relPath: safeRelPath, fullPath } = safeRef;
    if (!fs.existsSync(fullPath)) continue;
    const currentHash = fileHash(fullPath);
    if (currentHash !== originalHash) {
      // Back up the user's modified version
      const backupRef = resolveInstallRelativePath(patchesDir, safeRelPath);
      if (!backupRef) continue;
      const backupPath = backupRef.fullPath;
      fs.mkdirSync(path.dirname(backupPath), { recursive: true });
      fs.copyFileSync(fullPath, backupPath);
      modified.push(safeRelPath);
      pristineHashes[safeRelPath] = originalHash;
    }
  }

  // Save pristine copies of modified files from the CURRENT install (before wipe).
  // Pristine semantically represents "what the install would write to configDir
  // if the user had not modified it" — used by /gsd-reapply-patches Step 5
  // (#2972) as the diff baseline for the user-added-lines computation. Without
  // this dir the verifier degrades to its over-broad fallback heuristic (#2998).
  if (modified.length > 0) {
    const meta = {
      backed_up_at: new Date().toISOString(),
      from_version: manifest.version,
      from_manifest_timestamp: manifest.timestamp,
      files: modified,
      pristine_hashes: {}
    };
    // Record the original (pristine) hash for each modified file
    // This lets the reapply workflow verify reconstructed pristine files
    for (const relPath of modified) {
      meta.pristine_hashes[relPath] = pristineHashes[relPath];
    }
    fs.writeFileSync(path.join(patchesDir, 'backup-meta.json'), JSON.stringify(meta, null, 2));
    console.log('  ' + yellow + 'i' + reset + '  Found ' + modified.length + ' locally modified GSD file(s) — backed up to ' + PATCHES_DIR_NAME + '/');
    for (const f of modified) {
      console.log('     ' + dim + f + reset);
    }

    // #2998 / #3407: maintain gsd-pristine/ as the diff baseline for the
    // reapply-patches verifier (#2972).
    //
    // #3407 root-cause fix: the prior approach (#3004 CR) wiped gsd-pristine/
    // and re-populated it from pristineCtx.packageSrc (the NEW release source).
    // For files that changed between the old and new release this wrote NEW-
    // release bytes as the pristine baseline while backup-meta.json recorded
    // OLD-release hashes — a hash mismatch that caused the #3657 verifier guard
    // (OK_PRISTINE_DRIFT_DETECTED) to skip the baseline and fall back to over-
    // broad mode on every upgrade.
    //
    // Correct approach: `gsd-pristine/` is populated lazily by saveLocalPatches'
    // regenerate branch (not by a separate install-time step); the fix works by
    // induction across upgrades — each clean upgrade persists hash-validated
    // entries for the next run.  During this call we must PRESERVE entries whose
    // hash matches originalHash, not overwrite them with new-release bytes.
    //
    // Per-file decision:
    //   - sha256(gsd-pristine/X) === originalHash  →  correct; keep it
    //   - gsd-pristine/X exists but hash mismatch  →  stale from a previous
    //     buggy run (#3407); remove so verifier falls back cleanly
    //   - gsd-pristine/X absent                    →  attempt hash-validated
    //     regeneration: generate candidate from new-release source; if
    //     sha256(candidate) === originalHash the file is identical between
    //     old and new releases so candidate bytes ARE the old-release pristine
    //     and can be used; discard otherwise (over-broad fallback)
    if (pristineCtx) {
      let preserved = 0;
      // Track which relPaths had stale pristine entries (hash mismatch) that we
      // removed. After the regeneration pass we compute `removed` = stale entries
      // that could NOT be recovered (over-broad fallback applies to those only).
      const stalePaths = new Set();
      // Track which relPaths were successfully regenerated (from either missing or stale).
      const regeneratedPaths = new Set();
      const missingPaths = [];
      for (const relPath of modified) {
        const outRef = resolveInstallRelativePath(pristineDir, relPath);
        if (!outRef) continue;
        const { fullPath: pristinePath } = outRef;
        if (fs.existsSync(pristinePath)) {
          try {
            const onDiskHash = fileHash(pristinePath);
            if (onDiskHash === pristineHashes[relPath]) {
              preserved++;
              continue; // correct old-release bytes already in place — keep them
            }
          } catch { /* read error — treat as mismatch */ }
          // Hash mismatch or read error: stale pristine from a previous buggy
          // run (#3407). Remove so verifier falls back to over-broad mode.
          try { fs.rmSync(pristinePath, { force: true, recursive: true }); } catch { /* best-effort */ }
          // Only count as removed if the file is actually gone post-removal.
          if (!fs.existsSync(pristinePath)) {
            stalePaths.add(relPath);
          }
        }
        // File absent from gsd-pristine/ (or just removed above as stale):
        // attempt hash-validated regeneration from new-release source.
        missingPaths.push(relPath);
      }
      // Regenerate missing entries into a temp dir, then validate each hash
      // before promoting. Only files whose new-release generated bytes hash to
      // originalHash are safe to use — they were unchanged between releases.
      if (missingPaths.length > 0) {
        let tempPristineDir = null;
        try {
          tempPristineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-pristine-regen-'));
          populatePristineDir({
            packageSrc: pristineCtx.packageSrc,
            pristineDir: tempPristineDir,
            modified: missingPaths,
            runtime: pristineCtx.runtime,
            pathPrefix: pristineCtx.pathPrefix,
            isGlobal: pristineCtx.isGlobal,
          });
          for (const relPath of missingPaths) {
            const tempRef = resolveInstallRelativePath(tempPristineDir, relPath);
            const outRef = resolveInstallRelativePath(pristineDir, relPath);
            if (!tempRef || !outRef || !fs.existsSync(tempRef.fullPath)) continue;
            try {
              const candidateHash = fileHash(tempRef.fullPath);
              if (candidateHash !== pristineHashes[relPath]) continue; // new-release differs — discard
              fs.mkdirSync(path.dirname(outRef.fullPath), { recursive: true });
              fs.copyFileSync(tempRef.fullPath, outRef.fullPath);
              regeneratedPaths.add(relPath);
            } catch { /* hash or copy error — skip; over-broad fallback applies */ }
          }
        } catch (err) {
          // Match the pre-fix behavior: log a warning and continue (verifier falls back to over-broad mode for missing files).
          console.warn(`gsd-pristine regen skipped: ${err.message}`);
        } finally {
          if (tempPristineDir) {
            try { fs.rmSync(tempPristineDir, { recursive: true, force: true }); } catch { /* best-effort */ }
          }
        }
      }
      // `regenerated` = total files successfully regenerated (from missing OR stale).
      const regenerated = regeneratedPaths.size;
      // `removed` = stale entries that were deleted and NOT subsequently regenerated.
      // Entries that were stale-deleted but then successfully regenerated are counted
      // only in `regenerated` — the counts are non-overlapping.
      const removed = [...stalePaths].filter(p => !regeneratedPaths.has(p)).length;
      if (preserved > 0) {
        console.log('  ' + green + '✓' + reset + '  Preserved ' + cyan + 'gsd-pristine/' + reset + ' (' + preserved + ' file(s)) for three-way merge');
      }
      if (regenerated > 0) {
        console.log('  ' + green + '✓' + reset + '  Regenerated ' + cyan + 'gsd-pristine/' + reset + ' (' + regenerated + ' file(s)) via hash-validated new-release source');
      }
      if (removed > 0) {
        console.log('  ' + yellow + 'i' + reset + '  Removed ' + removed + ' stale gsd-pristine/ snapshot(s); regenerated ' + regenerated + ' of those — falls back to over-broad verify heuristic for the rest');
      }
    }
  }
  return modified;
}

/**
 * After install, report backed-up patches for user to reapply.
 */
function reportLocalPatches(configDir, runtime = DEFAULT_RUNTIME) {
  const patchesDir = path.join(configDir, PATCHES_DIR_NAME);
  const metaPath = path.join(patchesDir, 'backup-meta.json');
  if (!fs.existsSync(metaPath)) return [];

  let meta;
  try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return []; }

  if (meta.files && meta.files.length > 0) {
    const reapplyCommand = _hostBehaviors(runtime).reapplyCommand || '/gsd-update --reapply';
    console.log('');
    console.log('  ' + yellow + 'Local patches detected' + reset + ' (from v' + meta.from_version + '):');
    for (const f of meta.files) {
      console.log('     ' + cyan + f + reset);
    }
    console.log('');
    console.log('  Your modifications are saved in ' + cyan + PATCHES_DIR_NAME + '/' + reset);
    console.log('  Run ' + cyan + reapplyCommand + reset + ' to merge them into the new version.');
    console.log('  Or manually compare and merge the files.');
    console.log('');
  }
  return meta.files || [];
}

function reportInstallerMigrationResult(result) {
  const summary = summarizeInstallerMigrationResult(result);
  if (!summary.hasReportableActions) return;

  console.log(`  ${green}✓${reset} Installer migrations`);
  for (const row of summary.rows) {
    const reason = row.reason ? ` — ${row.reason}` : '';
    console.log(`     ${row.label} ${dim}${row.relPath}${reset}${reason}`);
  }
}

function install(isGlobal, runtime = DEFAULT_RUNTIME, options = {}) {
  // #2093: isKilo dropped — Kilo's agent/model-override handling below reads
  // _hostBehaviors(runtime).frontmatterDialect === 'kilo' instead of this flag.
  // #2095: isKimi dropped — kimi is now a hooks/ consumer like every other
  // settings-json-adjacent runtime; the two `&& !isKimi` hooks-copy guards
  // below were removed, leaving isKimi unused in this function (the kimi
  // local-install-deferred branch above already reads
  // _hostBehaviors(runtime).localInstallDeferred instead of this flag).
  // #2096: isAntigravity dropped — antigravity's agents were already
  // descriptor-driven (installRuntimeArtifacts), so its two legacy-agent-loop
  // branches (the path-rewrite skip and the converter dispatch) were
  // unreachable dead code; both were removed rather than re-gated on
  // hostBehaviors. (#2875 Part 2 later deleted that legacy loop and its
  // `_DESCRIPTOR_AGENTS_RUNTIMES` gate entirely — EVERY runtime is now
  // descriptor-driven for agents, not just this subset.)
  // #2098: isCodebuddy dropped — codebuddy's agents were likewise already
  // descriptor-driven, so its legacy converter-dispatch branch (the
  // `isCodebuddy` arm calling convertClaudeAgentToCodebuddyAgent) was
  // unreachable dead code and was removed rather than re-gated.
  // #2099: isCopilot dropped — copilot's agents were likewise already
  // descriptor-driven, so its three legacy-agent-loop branches (the
  // path-rewrite skip, the converter dispatch, and the .agent.md destName
  // ternary) were unreachable dead code and were removed rather than
  // re-gated; the .agent.md suffix now lives on
  // hostBehaviors.agentFileExtension in src/install-engine.cts, and the
  // skipSharedHooksInstall check above no longer needs `&& !isCopilot`.
  // #2100: isWindsurf dropped — its four former isWindsurf-gated branches
  // (legacy .devin/skills/gsd-* cleanup, the #1629 command-bodies copy, the
  // workflow-verification report, and the shared-hooks-install exclusion) are
  // now descriptor-driven via hostBehaviors.legacyDevinSkillsCleanup,
  // hostBehaviors.installsCommandBodiesForWorkflowDelegation,
  // hostBehaviors.verificationStyle === 'windsurf-workflows', and
  // hostBehaviors.skipSharedHooksInstall respectively; its legacy-agent-loop
  // converter arm was likewise unreachable dead code (windsurf's agents were
  // already descriptor-driven) and was removed above.
  // #2101: isZcode dropped — folded onto hostBehaviors.skipSharedHooksInstall.
  const { isOpencode, isCodex, isCursor, isAugment, isTrae, isQwen, isHermes, isCline } = runtimeFlags(runtime);
  const plan = resolveInstallPlan(runtime);
  const dirName = getDirName(runtime);
  const src = path.join(__dirname, '..');

  // #3241 — the Codex resolver-model-omitted notice dedupes "at most once", but
  // scoped per install() call rather than per process — each install() run gets
  // its own fresh window so a second install (e.g. a second runtime, or a test
  // re-running install()) can warn again if the same condition recurs.
  _codexResolverModelOmittedWarned = false;

  if (_hostBehaviors(runtime).localInstallDeferred && !isGlobal) {
    console.log(`  ${yellow}⚠${reset} Kimi local install is deferred for Phase 2.`);
    console.log(`      No .kimi-code/skills or .agents/skills project artifacts were written.`);
    console.log(`      Project-level Kimi install semantics remain deferred.`);
    return {
      runtime,
      skipped: true,
      reason: 'kimi_local_deferred',
      configDir: null,
      settingsPath: null,
      settings: null,
      statuslineCommand: null,
      updateBannerCommand: null,
      rollbackInstallerMigrations: () => {},
    };
  }

  // #2870: scope id resolved ONCE here and reused at every use below (was 10
  // independent isGlobal-derived re-derivations). Placed AFTER the kimi
  // local-deferred early return above so that return path does no extra
  // work. Routed through the Install Scope Module (src/install-scope.cts)
  // when the capability registry is available; degrades to the plain id on
  // failure (unknown/non-installable runtime, broken bundle) so this
  // function's plain scope-id uses — which never depended on registry
  // availability before this migration — keep working exactly as they did
  // pre-migration. `_installScope` (the full resolved value, not just the
  // id) additionally backs the settingsFileByScope routing below.
  const _installScopeId = isGlobal ? 'global' : 'local';
  const _installScope = _resolveScopeSafe(_installScopeId, runtime);

  // Reusable helper to copy hooks/lib/ (git-cmd.js + gsd-graphify-rebuild.sh).
  // Defined early so it is visible to both the main and Codex code paths.
  // `allowlist` (when non-empty) restricts copying to the named top-level entries,
  // keeping install scope aligned with GSD_HOOK_LIB_FILES (which uninstall/manifest manage).
  const copyLibDir = (sDir, dDir, allowlist = []) => {
    const allowed = allowlist.length > 0 ? new Set(allowlist) : null;
    for (const entry of fs.readdirSync(sDir)) {
      if (allowed && !allowed.has(entry)) continue;
      const s = path.join(sDir, entry);
      const d = path.join(dDir, entry);
      let st;
      try { st = fs.lstatSync(s); } catch (_) { continue; }
      if (st.isSymbolicLink()) continue; // defense-in-depth
      if (st.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        copyLibDir(s, d);
      } else if (entry.endsWith('.sh')) {
        let content = fs.readFileSync(s, 'utf8');
        content = content.replace(/\{\{GSD_VERSION\}\}/g, pkg.version);
        fs.writeFileSync(d, content);
        try { fs.chmodSync(d, 0o755); } catch (_) { /* Windows */ }
      } else {
        fs.copyFileSync(s, d);
        if (entry.endsWith('.js')) {
          try { fs.chmodSync(d, 0o755); } catch (_) { /* Windows */ }
        }
      }
    }
  };

  // Get the target directory based on runtime and install type.
  // Descriptor-driven (ADR-1239 / #2090): cline local installs write to the
  // project root (like Claude Code) — .clinerules lives at the root, not inside
  // a .cline/ subdirectory. Folded from `isCline` into
  // hostBehaviors.localTargetIsProjectRoot.
  // #791: antigravity local installs write to .agents/ (canonical). The legacy .agent/
  // directory is recognized by RUNTIME_DIRS (update-context) and _LEGACY_SCAN_SUBDIR_NAMES
  // but NOT auto-removed here; legacy .agent/ gsd artifacts are recognized but not
  // auto-removed on reinstall (dual-read fallback per issue #791 spec).
  const targetDir = isGlobal
    ? getGlobalConfigDir(runtime, explicitConfigDir)
    : _hostBehaviors(runtime).localTargetIsProjectRoot
      ? process.cwd()
      : path.join(process.cwd(), dirName);

  // #3664: a --config-dir destination holding foreign agent files gets an
  // explicit install-time warning — never a silent Claude-shaped emit.
  if (isGlobal) {
    warnIfForeignAgentDest(runtime, targetDir, _installScopeId, Boolean(explicitConfigDir));
  }

  // #2875 (#1874-F19 anti-inertness, test-matrix C7): recover any user
  // artifact orphaned by a PRIOR install run that died between staging and
  // its own restore/discard, BEFORE this run's own preserve step stages
  // anything new. This is the production entry point every install() call
  // reaches — the only place this phase's durability fix is complete rather
  // than merely callable (40-design.md "The inertness trap this design must
  // avoid" / #1879-F15). Runs for every runtime, ahead of both the
  // layout-driven path's _runLegacyInstallMigrations (site 1, inside
  // installRuntimeArtifacts) and this function's own mainline gsd-core copy
  // (site 4, below).
  // #2875 defect fix: DEGRADE, never abort install, when the staging root
  // itself cannot be resolved — skip this recovery pass rather than throw
  // out of install() before it does anything.
  {
    const _installEntryStagingRoot = _tryResolveUserArtifactStagingRoot(targetDir);
    if (_installEntryStagingRoot !== null) {
      recoverOrphanedUserArtifacts(_installEntryStagingRoot, targetDir);
    }
  }

  const locationLabel = isGlobal
    ? targetDir.replace(os.homedir(), '~')
    : targetDir.replace(process.cwd(), '.');

  // Path prefix for file references in markdown content (e.g. gsd-tools.cjs).
  // Replaces $HOME/.claude/ or ~/.claude/ so the result is <pathPrefix>gsd-core/bin/...
  // For global installs: use $HOME/ so paths expand correctly inside double-quoted
  // shell commands (~ does NOT expand inside double quotes, causing MODULE_NOT_FOUND).
  // For local installs: use resolved absolute path (may be outside $HOME).
  // Exception: OpenCode does not expand $HOME in @file references on any platform —
  // `@$HOME/...` is treated as a literal path relative to the config dir, producing
  // `command/$HOME/...` (file not found). Use the absolute path for OpenCode so
  // @-references resolve correctly (#2376 Windows, #2831 macOS/Linux).
  // gsd update marker re-application (ADR-0010 Deviation 2):
  // Resolve which profile to use for this runtime's install:
  //   1. --minimal / --core-only → back-compat alias for the core profile
  //   2. Explicit --profile=<name> → use it (overrides any marker)
  //   3. Marker exists in targetDir → honor it (prevents silent expansion on update)
  //   4. Else → 'full' (back-compat for fresh non-interactive installs)
  //
  // Multi-runtime disagreement: if installing across runtimes and their markers
  // differ, the caller may use mostRestrictiveProfile() across the per-runtime
  // results — here we resolve each runtime independently.
  //
  // ADR-857 phase 4c: ALL profiles (including core/minimal) use stageSkillsForProfile
  // with the registry-aware _resolvedProfile so future tier:core capabilities are
  // staged on core installs.  The 'minimal' back-compat distinction is now ONLY the
  // empty manifest (core profile has no transitive deps); the registry IS consulted.
  // MINIMAL is intentionally the same skill set as the 'core' profile
  // (MINIMAL_ALLOWLIST_SET === Set(PROFILES.core)) — it is NOT a separately curated
  // subset.  Any future tier:core capability therefore DOES belong in a minimal/core
  // install.  Using stageSkillsForProfile(_resolvedProfile) honors the registry while
  // keeping the effective skill set identical to the prior stageSkillsForMode path
  // until a tier:core capability is registered.
  const _activeProfileName = hasMinimal
    ? 'core'  // --minimal is a back-compat alias for the core profile; marker records 'core'
    : resolveEffectiveProfile({
        requestedProfileName: _requestedProfileName,
        targetDir,
      });
  const _isCoreProfileAlias = _activeProfileName === 'core';
  const _effectiveInstallMode = _isCoreProfileAlias ? 'minimal' : 'full';
  // Load the manifest and compute resolved profile for named profiles.
  // For --minimal/core: use an empty manifest (core profile has no transitive
  // deps) to produce a resolvedProfile with the core skill set.  For core/
  // standard profiles, resolveProfile's `registry` arg IS consulted (via
  // _capabilitySkillsForMode) so tier:core/tier:standard capability skills are
  // unioned in when registered. #2322 correction: for the DEFAULT `full`
  // profile, resolveProfile short-circuits to the `{skills:'*'}` sentinel
  // BEFORE ever reading `registry` (there is nothing to union — '*' already
  // means "everything"), so the registry consultation that matters for `full`
  // happens LATER, at staging time (stageSkillsForRuntimeAsSkills's '*'
  // fill-in, resolveRuntimeArtifactLayout's `capabilityRegistry` param below) —
  // not here. `_installedCapabilityRegistry` (not the frozen `_capabilityRegistry`)
  // is passed so an INSTALLED third-party capability (not just a first-party
  // one) is honored on every profile, `full` included (#2322 blocker 2).
  const _commandsDir = path.join(src, 'commands', 'gsd');
  const _skillsManifest = _isCoreProfileAlias ? new Map() : loadSkillsManifest(_commandsDir);
  const _resolvedProfile = resolveProfile({
    modes: [_activeProfileName],
    manifest: _skillsManifest,
    registry: _installedCapabilityRegistry,
  });
  // Unified staging function: all profiles use stageSkillsForProfile with the
  // registry-aware _resolvedProfile (ADR-857 phase 4c cutover).
  function _stageSkills(commandsGsdDir) {
    return stageSkillsForProfile(commandsGsdDir, _resolvedProfile);
  }
  function _stageAgents(agentsDir) {
    if (_isCoreProfileAlias) return agentsDir;
    return stageAgentsForProfile(agentsDir, _resolvedProfile);
  }
  const persistActiveProfileMarker = () => {
    try {
      writeActiveProfile(targetDir, _activeProfileName);
    } catch {
      // Non-fatal: marker persistence failure doesn't break the install.
    }
  };

  const resolvedTarget = path.resolve(targetDir).replace(/\\/g, '/');
  const homeDir = os.homedir().replace(/\\/g, '/');
  const isWindowsHost = process.platform === 'win32';
  const pathPrefix = computePathPrefix({
    isGlobal,
    isOpencode: _hostBehaviors(runtime).skipHomePrefixSubstitution === true,
    isWindowsHost,
    resolvedTarget,
    homeDir,
  });

  // runtimeLabel is now the single-source getRuntimeLabel lookup (ADR-1239
  // Phase B / #1679) — collapses the prior 16-line assignment chain.
  const runtimeLabel = getRuntimeLabel(runtime);

  console.log(`  Installing for ${cyan}${runtimeLabel}${reset} to ${cyan}${locationLabel}${reset}\n`);

  // Track installation failures
  const failures = [];
  let installerMigrationResult = null;
  const rollbackInstallerMigrations = () => {
    if (!installerMigrationResult || typeof installerMigrationResult.rollback !== 'function') return;
    const rollback = installerMigrationResult.rollback;
    installerMigrationResult = null;
    rollback();
  };

  // Save any locally modified GSD files before they get wiped.
  // The pristine context lets saveLocalPatches populate gsd-pristine/ via
  // the install transform pipeline, giving the reapply-patches Step 5
  // verifier a real diff baseline (#2998).
  saveLocalPatches(targetDir, {
    packageSrc: src,
    runtime,
    pathPrefix,
    isGlobal,
  });

  // Run manifest-backed cleanup migrations before package materialization.
  installerMigrationResult = runInstallerMigrations({ configDir: targetDir });

  // #3245 — Codex idempotent rollback. Capture pre-install state of ALL
  // directories and files GSD will mutate so that any post-install validation
  // failure (config.toml schema check, write failure, etc.) can revert the
  // entire install atomically — not just config.toml.
  //
  // Captured BEFORE the first Codex-specific write (skills/) so the snapshots
  // reflect the true pre-GSD state. Non-Codex runtimes skip this block.
  //
  // Snapshot contents:
  //   codexPreInstallSkillNames  — Set of gsd-* skill dir names that existed
  //   codexPreInstallSkillContents — Map<skillName, Map<relPath, Buffer>> of
  //       the full file tree of each pre-existing gsd-* skill dir, so that
  //       overwritten dirs can be fully restored on rollback (not just removed).
  //   codexPreInstallAgentFiles  — Set of gsd-*.{md,toml} filenames in agents/
  //   codexPreInstallAgentContents — Map<filename, Buffer> of pre-existing agent
  //       file bytes, enabling full content restore (not just deletion) on rollback.
  //   codexPreInstallVersionBytes — Buffer (or null) of gsd-core/VERSION
  //
  // These are referenced by restoreCodexSnapshot(), defined below inside the
  // config block. Defining the variables here (outer scope) makes them
  // accessible by closure.
  const codexPreInstallSkillNames = new Set();
  // Map<skillDirName, Map<relPath, Buffer>> — full content snapshot of each
  // pre-existing gsd-* skill directory. Best-effort: read errors are silently
  // skipped so a partial snapshot is still better than none.
  const codexPreInstallSkillContents = new Map();
  const codexPreInstallAgentFiles = new Set();
  // Map<filename, Buffer> — content snapshot of each pre-existing gsd-* agent file.
  const codexPreInstallAgentContents = new Map();
  let codexPreInstallVersionBytes = null;
  if (_hostBehaviors(runtime).tomlConfigInstall && !isMinimalMode(_effectiveInstallMode)) {
    const _preSkillsDir = _resolveSkillsRootDir(runtime, targetDir, _installScopeId);
    if (fs.existsSync(_preSkillsDir)) {
      for (const entry of fs.readdirSync(_preSkillsDir, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.startsWith('gsd-')) {
          codexPreInstallSkillNames.add(entry.name);
          // Recursively snapshot all files in this skill dir.
          const skillDir = path.join(_preSkillsDir, entry.name);
          const fileMap = new Map();
          const _snapshotDir = (dir, relBase) => {
            let children;
            try { children = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
            for (const child of children) {
              const relPath = relBase ? `${relBase}/${child.name}` : child.name;
              const fullPath = path.join(dir, child.name);
              if (child.isDirectory()) {
                _snapshotDir(fullPath, relPath);
              } else {
                try { fileMap.set(relPath, fs.readFileSync(fullPath)); } catch (_) { /* best-effort */ }
              }
            }
          };
          _snapshotDir(skillDir, '');
          codexPreInstallSkillContents.set(entry.name, fileMap);
        }
      }
    }
    const _preAgentsDir = path.join(targetDir, 'agents');
    if (fs.existsSync(_preAgentsDir)) {
      for (const file of fs.readdirSync(_preAgentsDir)) {
        if (file.startsWith('gsd-') && (file.endsWith('.md') || file.endsWith('.toml'))) {
          codexPreInstallAgentFiles.add(file);
          try {
            codexPreInstallAgentContents.set(file, fs.readFileSync(path.join(_preAgentsDir, file)));
          } catch (_) { /* best-effort */ }
        }
      }
    }
    const _preVersionPath = path.join(targetDir, 'gsd-core', 'VERSION');
    if (fs.existsSync(_preVersionPath)) {
      try { codexPreInstallVersionBytes = fs.readFileSync(_preVersionPath); } catch (_) { /* best-effort */ }
    }
  }

  // #3245 CR finding 2 — Rollback coverage extends to ALL post-snapshot operations,
  // not just the Codex config/hook error paths. Any throw between snapshot capture and
  // the Codex config block (skills copy, agents copy, VERSION write, manifest write, etc.)
  // must also trigger rollback so the caller is never left in a partially-installed state.
  //
  // _codexPreConfigRollback covers the four surfaces that can be mutated before
  // config.toml is touched: skills/, agents/, gsd-core/VERSION, and orphaned
  // atomic-write temp files. It is safe to call before any writes have happened.
  // The full restoreCodexSnapshot() (defined inside the config block) additionally
  // handles config.toml, which is not yet touched at this point in the pipeline.
  const _codexPreConfigRollback = !_hostBehaviors(runtime).tomlConfigInstall || isMinimalMode(_effectiveInstallMode) ? null : () => {
    rollbackInstallerMigrations();
    // skills/gsd-* — pass 1: restore snapshot entries (may be absent if deleted mid-install).
    const _earlySkillsDir = _resolveSkillsRootDir(runtime, targetDir, _installScopeId);
    for (const skillName of codexPreInstallSkillNames) {
      const skillDirPath = path.join(_earlySkillsDir, skillName);
      const fileMap = codexPreInstallSkillContents.get(skillName);
      try {
        fs.rmSync(skillDirPath, { recursive: true, force: true });
        fs.mkdirSync(skillDirPath, { recursive: true });
        if (fileMap) {
          for (const [relPath, buf] of fileMap) {
            const destFile = path.join(skillDirPath, relPath);
            try {
              fs.mkdirSync(path.dirname(destFile), { recursive: true });
              fs.writeFileSync(destFile, buf);
            } catch (_) { /* best-effort */ }
          }
        }
      } catch (_) { /* best-effort */ }
    }
    // skills/gsd-* — pass 2: remove any newly-created dirs not in the snapshot.
    if (fs.existsSync(_earlySkillsDir)) {
      try {
        for (const entry of fs.readdirSync(_earlySkillsDir, { withFileTypes: true })) {
          if (entry.isDirectory() && entry.name.startsWith('gsd-') && !codexPreInstallSkillNames.has(entry.name)) {
            try { fs.rmSync(path.join(_earlySkillsDir, entry.name), { recursive: true, force: true }); }
            catch (_) { /* best-effort */ }
          }
        }
      } catch (_) { /* best-effort */ }
    }
    // agents/gsd-* — pass 1: restore snapshot entries.
    const _earlyAgentsDir = path.join(targetDir, 'agents');
    for (const file of codexPreInstallAgentFiles) {
      const buf = codexPreInstallAgentContents.get(file);
      if (buf !== undefined) {
        try {
          fs.mkdirSync(_earlyAgentsDir, { recursive: true });
          fs.writeFileSync(path.join(_earlyAgentsDir, file), buf);
        } catch (_) { /* best-effort */ }
      }
    }
    // agents/gsd-* — pass 2: remove any newly-created files not in the snapshot.
    if (fs.existsSync(_earlyAgentsDir)) {
      try {
        for (const file of fs.readdirSync(_earlyAgentsDir)) {
          if (file.startsWith('gsd-') && (file.endsWith('.md') || file.endsWith('.toml')) && !codexPreInstallAgentFiles.has(file)) {
            try { fs.unlinkSync(path.join(_earlyAgentsDir, file)); } catch (_) { /* best-effort */ }
          }
        }
      } catch (_) { /* best-effort */ }
    }
    // gsd-core/VERSION
    const _earlyVersionPath = path.join(targetDir, 'gsd-core', 'VERSION');
    if (codexPreInstallVersionBytes !== null) {
      try { fs.writeFileSync(_earlyVersionPath, codexPreInstallVersionBytes); } catch (_) { /* best-effort */ }
    } else if (fs.existsSync(_earlyVersionPath)) {
      try { fs.unlinkSync(_earlyVersionPath); } catch (_) { /* best-effort */ }
    }
    // Orphaned atomic-write temp files.
    const _earlyTmpPattern = /\.tmp-\d+-\d+$/;
    function _earlyCleanTmpFiles(dir) {
      if (!fs.existsSync(dir)) return;
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          _earlyCleanTmpFiles(full);
        } else if (_earlyTmpPattern.test(entry.name) && __atomicWrittenTmps.has(full)) {
          try { fs.unlinkSync(full); } catch (_) { /* best-effort */ }
        }
      }
    }
    _earlyCleanTmpFiles(targetDir);
  };

  // Run manifest-backed cleanup migrations after rollback snapshots exist and
  // before package materialization. Codex rollback paths invoke the migration
  // rollback handle if a later install step fails.
  //
  // Runtime scope comes from docs/installer-migrations.md#runtime-configuration-contract-registry:
  // every supported runtime uses this same planner/apply/report path, while
  // individual migration records decide whether a runtime-specific config
  // rewrite is allowed by that runtime's documented ownership boundary.
  // #3245 CR finding 2 — wrap the pre-config install operations in a try/catch so
  // that ANY throw between snapshot capture and the Codex config block triggers rollback.
  // Non-Codex paths are unaffected (_codexPreConfigRollback is null for them).
  //
  // agentsSrc is declared here (let, not const) because installCodexConfig() inside the
  // Codex config block below also references it, and that block is outside the try scope.
  let agentsSrc = path.join(src, 'agents');
  // Capture upgrade signal BEFORE files are written (#683). Must be declared at function
  // scope (outside the try block below) so it is accessible in the settings section later.
  // Absent VERSION = fresh install; present VERSION = upgrade/re-install.
  const priorInstallExisted = fs.existsSync(path.join(targetDir, 'gsd-core', 'VERSION'));
  try {
  installerMigrationResult = runInstallerMigrations({
    configDir: targetDir,
    runtime,
    scope: _installScopeId,
    migrations: options.installerMigrations,
    baselineScan: true,
  });
  // #3541: non-interactive runs (typical /gsd-update via Claude Code) have
  // no stdin TTY and therefore no way to answer prompt-user migration
  // actions. Resolve safe categories by classification (stale SDK build
  // artifacts → remove; user-facing skills → keep; bundled GSD hooks →
  // remove [#3610]) and log every resolution; anything that cannot be
  // safely defaulted falls through to assertInstallerMigrationsUnblocked,
  // which now emits a grouped error with the documented resolution path.
  //
  // #3610: the classifier-based resolution must run regardless of TTY.
  // For unambiguous categories (e.g. `hooks/gsd-*` bundled hooks left
  // behind by a previous version), there is no actual "user choice" to
  // make — the file is a known GSD-managed artifact and the installer is
  // about to write the fresh bundled version. Gating the resolver on
  // `!isTTY` made `npx @opengsd/gsd-core@latest --codex` hard-abort with
  // 12 blocked bundled hooks. The env-override branch (operator-supplied
  // GSD_INSTALLER_MIGRATION_RESOLVE) still applies only in non-TTY mode.
  const _migrationIsTty = process.stdin && process.stdin.isTTY === true;
  if (Array.isArray(installerMigrationResult.blocked) &&
      installerMigrationResult.blocked.length > 0 &&
      installerMigrationResult.plan &&
      Array.isArray(installerMigrationResult.plan.actions)) {
    const { resolutions } = resolveInstallerMigrationPromptsForNonTty(
      installerMigrationResult,
      { isTty: false }
    );
    for (const entry of resolutions) {
      console.log(
        `  ↪ installer-migration auto-resolved: ${entry.relPath} → ${entry.choice} ` +
        `(category=${entry.category}, source=${entry.source})`
      );
    }
    // If we resolved anything, the original run returned early without
    // applying the (now-unblocked) plan — apply it here.
    if (resolutions.length > 0 && installerMigrationResult.plan.blocked.length === 0) {
      const applyResult = applyInstallerMigrationPlan({
        configDir: targetDir,
        plan: installerMigrationResult.plan,
      });
      installerMigrationResult = {
        ...installerMigrationResult,
        ...applyResult,
        blocked: [],
      };
    }
  }
  reportInstallerMigrationResult(installerMigrationResult);
  assertInstallerMigrationsUnblocked(installerMigrationResult);

  // Artifact install dispatcher — routes to layout-driven path for all
  // skills-based runtimes (both full and minimal/core profiles); keeps
  // back-compat paths for commands-based runtimes (OpenCode/Kilo/
  // Claude-local).
  //
  // installRuntimeArtifacts handles legacy migration + skill/agent staging
  // via layout kinds for all profile modes. _resolvedProfile already reflects
  // the user's --profile=core / --minimal choice.
  //
  // Non-layout side-effects preserved inline:
  //   Hermes: writeHermesCategoryDescription (not a layout kind)
  //   Cline global: skills emitted via layout; .clinerules still written below (#782)
  //   Cline local: no skills (only .clinerules) — falls through to cline-rules surface
  //   Claude local: copyWithPathReplacement + stale-skills cleanup

  // Layout-driven path for all skills-based runtimes (full and minimal modes).
  // applyRuntimeContentRewritesInPlace (called inside installRuntimeArtifacts)
  // handles per-runtime path + branding rewrites, including Qwen/Hermes.
  // Cline global: emit skills to ~/.cline/skills/ (Cline >= v3.48.0 — #782).
  // Descriptor-driven (ADR-1016 / ADR-1239): a runtime takes the layout-driven
  // installRuntimeArtifacts path when its scoped artifactLayout is non-empty
  // (it declares any skills/commands/agents/kimi-agents kind for this scope).
  // This replaces the prior hardcoded `isCodex || isCopilot || ...` roster so a
  // newly-added runtime with an artifact layout installs without a per-runtime
  // branch — the add-a-host tax ADR-1239 Phase B retires. OpenCode/Kilo now
  // route through this SAME path too: their hostBehaviors.combinedFamilyInstall
  // flag makes installRuntimeArtifacts (in src/install-engine.cts) delegate to
  // installOpencodeFamilyArtifacts for the combined commands+skills+native-plugin
  // install (ADR-1239 / #2087), replacing the bespoke inline block this comment
  // used to describe. Claude-local remains the one special-cased path
  // (copyWithPathReplacement + stale-skills cleanup).
  const _isSkillsRuntime = (() => {
    if (_hostBehaviors(runtime).localInstallStyle === 'legacy-flat' && !isGlobal) return false;  // legacy flat local path (descriptor-driven; #2086)
    // #2875 Part 2 defect fix: a runtime whose LOCAL commands are embedded in a
    // rules file rather than materialized as files (hostBehaviors.localCommandsViaRules
    // — cline is the only declarant, capabilities/cline/capability.json) must not
    // flip into this skills/commands-reporting branch merely because its local
    // artifactLayout now also declares an `agents` kind (#2875 Part 2 cline-local
    // agents regression fix). That branch's own verification reporting expects a
    // skills/ or commands/ directory this runtime never writes locally and would
    // spuriously fail; the `localCommandsViaRules` branch below (unchanged
    // messaging) and the unconditional agents-materialization block further down
    // (installAgentsKindStandalone) already cover this runtime/scope correctly.
    if (!isGlobal && _hostBehaviors(runtime).localCommandsViaRules) return false;
    const cap = _capabilityRegistry && _capabilityRegistry.runtimes && _capabilityRegistry.runtimes[runtime];
    const layout = cap && cap.runtime && cap.runtime.artifactLayout;
    if (!layout) return false;
    const scopeLayout = isGlobal ? layout.global : layout.local;
    return Array.isArray(scopeLayout) && scopeLayout.length > 0;
  })();

  // #2624: write the .gsd-source marker. Extracted from its former late position so it can be
  // called BEFORE staging reads the marker (see the call site below). Scoped to the Claude-global
  // layout (issue #1477) — the only install path that ships the skills layout without a
  // commands/gsd source tree, so findInstallSourceRoot's walk-up has nothing to find and
  // /gsd-surface (list/status) throws without it. Points at the package's own commands/gsd
  // source. Guarded on source presence so a half-published package never writes a dangling
  // marker. Write failure is non-fatal (install proceeds; warn so /gsd-surface breakage is
  // diagnosable) — the same contract the late write had.
  function _writeGsdSourceMarker(runtime, targetDir, src, isGlobal) {
    if (_hostBehaviors(runtime).sourceMarkerFile && isGlobal) {
      const gsdSourceCommands = path.join(src, 'commands', 'gsd');
      if (fs.existsSync(gsdSourceCommands)) {
        try {
          // ADR-1239 Phase B write-confinement: the descriptor-sourced marker filename
          // must resolve under targetDir (parity with the other descriptor-driven writes).
          const _markerPath = assertDestWithinConfigHome(targetDir, _hostBehaviors(runtime).sourceMarkerFile);
          fs.writeFileSync(_markerPath, gsdSourceCommands + '\n', 'utf8');
        } catch (err) {
          // Non-fatal: install proceeds. But on the Claude-global layout walk-up
          // also fails (no commands/gsd source tree), so a silent write failure
          // still leaves /gsd-surface broken at runtime — warn so it's diagnosable.
          console.warn(`  ${yellow}!${reset} Could not write .gsd-source marker (${err.message}); /gsd-surface list/status may fail`);
        }
      }
    }
  }

  // #2624: write the .gsd-source marker BEFORE any staging reads it. The marker write
  // formerly lived AFTER staging; on an upgrade the marker still held the PREVIOUS
  // install's source path (e.g. an npx per-version cache dir that still exists on disk),
  // so findInstallSourceRoot(configDir) — called inside installRuntimeArtifacts below —
  // returned the stale path and every converted skill was generated from the OLD version's
  // commands/gsd, silently installing prior-version content with a self-consistent manifest
  // hash. Writing first closes the read-before-write hole for every findInstallSourceRoot
  // consumer (skills, commands, /gsd-surface, capability-state). Placed here (before the
  // _isSkillsRuntime branch) so it runs for every Claude-global install, matching the
  // original write's sourceMarkerFile && isGlobal guard exactly.
  _writeGsdSourceMarker(runtime, targetDir, src, isGlobal);

  if (_isSkillsRuntime) {
    // Layout-driven install for skills-based runtimes (full and minimal modes)
    const scope = _installScopeId;
    // ADR-1239 upgrade 3 / #2088: a kind may declare an alternate install `home`
    // (e.g. Codex skills -> $HOME/.agents/skills) instead of the runtime's normal
    // configDir. Resolve the ACTUAL on-disk skills root here, descriptor-driven
    // (no isCodex check), so downstream sidecar-cleanup and post-install
    // verification look in the right place regardless of which runtime declares
    // an alternate home for its skills kind.
    const _skillsRootDir = _resolveSkillsRootDir(runtime, targetDir, scope);
    // ADR-1239 / #2086: drive install through the public Host-Integration Interface
    // (imperative adapter). The adapter delegates to the SAME installRuntimeArtifacts
    // engine call -> byte-identical output (gated by golden-install-parity). Fail-open
    // to the engine directly if the composed-registry adapter can't load.
    const _adapter = _runtimeAdapter(runtime);
    if (_adapter) {
      _adapter.install({
        configDir: targetDir,
        scope,
        resolvedProfile: _resolvedProfile,
        resolveAttribution: getCommitAttribution,
      });
    } else {
      // #2322: fallback path (adapter unavailable) — thread the composed
      // registry too, so this path stages third-party capability skills
      // identically to the primary adapter path above.
      installRuntimeArtifacts(runtime, targetDir, scope, _resolvedProfile, getCommitAttribution, _installedCapabilityRegistry);
    }

    // #1326 — Codex only: remove stale agents/openai.yaml sidecars from managed
    // gsd-* skill dirs. Prior installs wrote these files so Codex would show a
    // display name and description in the /skills TUI popup. Recent Codex builds
    // index BOTH SKILL.md and the sidecar, causing each GSD skill to appear twice
    // in autocomplete. Cleaning them up fixes the duplication; SKILL.md alone is
    // sufficient for Codex discovery. User-owned dirs are never touched.
    if (_hostBehaviors(runtime).cleanupSkillSidecars) {
      cleanupCodexSkillMetadataSidecars(_skillsRootDir);
    }

    // ADR-1239 split-home migration: when a runtime's skills kind moved to an
    // alternate `home` (e.g. Codex → ~/.agents/skills), pre-move installs left
    // managed gsd-* skill dirs at the old configDir-rooted location
    // (~/.codex/skills). Reinstalling here writes the new location but would
    // otherwise orphan the old one — clean up the stale gsd-* dirs.
    {
      const _movedOldSkillsDir = _resolveMovedSkillsOldDir(runtime, targetDir, scope);
      if (_movedOldSkillsDir) {
        const migrated = cleanupMovedSkillsOldLocation(_movedOldSkillsDir, 'gsd-');
        if (migrated > 0) {
          console.log(`  ${green}✓${reset} Migrated ${migrated} skill dir(s) off the legacy ${_movedOldSkillsDir} location`);
        }
      }
    }

    // #1629 Finding B: Windsurf local only — remove legacy .devin/skills/gsd-*
    // dirs from pre-#1615 installs. #1615 moved Windsurf to .windsurf/workflows/
    // but never cleaned up the old .devin/skills/ layout (#1085). User-owned
    // content is preserved (non-gsd- dirs, gsd-dev-preferences, symlinks).
    // Descriptor-driven (ADR-1239 / #2100): folded from `isWindsurf` into
    // hostBehaviors.legacyDevinSkillsCleanup (windsurf is the only runtime that
    // declares it, so this is byte-parity).
    if (_hostBehaviors(runtime).legacyDevinSkillsCleanup && !isGlobal) {
      const removedCount = cleanupWindsurfLegacyDevinSkills(process.cwd());
      if (removedCount > 0) {
        console.log(`  ${green}✓${reset} Removed ${removedCount} legacy .devin/skills/gsd-* dir(s) (pre-#1615 Windsurf layout)`);
      }
    }

    // Descriptor-driven (#2090): write DESCRIPTION.md for the gsd/ category after layout install
    if (_hostBehaviors(runtime).writeCategoryDescription) {
      writeHermesCategoryDescription(path.join(targetDir, 'skills', 'gsd'));
    }

    // Verify installed artifacts and report
    if (_hostBehaviors(runtime).reportSkillsCount) {
      const hermesSkillsDir = path.join(targetDir, 'skills', 'gsd');
      if (fs.existsSync(hermesSkillsDir)) {
        // Hermes layout uses prefix: 'gsd-' (#947) — skill dirs have gsd-<stem> names
        const count = fs.readdirSync(hermesSkillsDir, { withFileTypes: true })
          .filter(e => e.isDirectory() && e.name.startsWith('gsd-')).length;
        if (count > 0) {
          console.log(`  ${green}✓${reset} Installed ${count} skills to skills/gsd/`);
        } else {
          failures.push('skills/gsd/*');
        }
      } else {
        failures.push('skills/gsd/*');
      }
    } else if (_hostBehaviors(runtime).verificationStyle === 'kimi') {
      const skillsDir = path.join(targetDir, 'skills');
      const rootAgentPath = path.join(targetDir, 'agents', 'gsd.yaml');
      if (fs.existsSync(skillsDir)) {
        const count = fs.readdirSync(skillsDir, { withFileTypes: true })
          .filter(e => e.isDirectory() && e.name.startsWith('gsd-')).length;
        if (count > 0) {
          console.log(`  ${green}✓${reset} Installed ${count} Kimi skills to skills/`);
        } else {
          failures.push('skills/gsd-*');
        }
      } else {
        failures.push('skills/gsd-*');
      }
      if (fs.existsSync(rootAgentPath)) {
        console.log(`  ${green}✓${reset} Generated Kimi root agent: ${rootAgentPath}`);
        console.log(`      Launch with: kimi --agent-file ${rootAgentPath}`);
      } else {
        failures.push('agents/gsd.yaml');
      }
    // Descriptor-driven (ADR-1239 / #2100): folded from `isWindsurf` into
    // hostBehaviors.verificationStyle === 'windsurf-workflows' (extends the
    // same mechanism the 'kimi' verificationStyle branch above uses; windsurf
    // is the only runtime that declares this value, so this is byte-parity).
    } else if (_hostBehaviors(runtime).verificationStyle === 'windsurf-workflows') {
      if (isGlobal) {
        console.log(`  ${green}✓${reset} Windsurf global install skipped workflow artifacts (workspace-only)`);
      } else {
        const workflowsDir = path.join(targetDir, 'workflows');
        if (fs.existsSync(workflowsDir)) {
          const workflowCount = fs.readdirSync(workflowsDir)
            .filter(f => f.startsWith('gsd-') && f.endsWith('.md')).length;
          if (workflowCount > 0) {
            console.log(`  ${green}✓${reset} Installed ${workflowCount} workflows to workflows/`);
          } else {
            failures.push('workflows/gsd-*');
          }
        } else {
          failures.push('workflows/gsd-*');
        }
      }
    } else {
      const skillsDir = _skillsRootDir;
      if (fs.existsSync(skillsDir)) {
        const count = fs.readdirSync(skillsDir, { withFileTypes: true })
          .filter(e => e.isDirectory() && e.name.startsWith('gsd-')).length;
        if (count > 0) {
          console.log(`  ${green}✓${reset} Installed ${count} skills to skills/`);
        } else {
          failures.push('skills/gsd-*');
        }
      } else {
        failures.push('skills/gsd-*');
      }
      // Augment: also verify commands/ (emitted alongside skills/)
      if (isAugment) {
        const commandsDir = path.join(targetDir, 'commands');
        if (fs.existsSync(commandsDir)) {
          const cmdCount = fs.readdirSync(commandsDir)
            .filter(f => f.startsWith('gsd-') && f.endsWith('.md')).length;
          if (cmdCount > 0) {
            console.log(`  ${green}✓${reset} Installed ${cmdCount} commands to commands/`);
          } else {
            failures.push('commands/gsd-*');
          }
        } else {
          failures.push('commands/gsd-*');
        }
      }

      // Descriptor-driven commands/ output report (currently CodeBuddy).
      // Cursor retired this parallel surface in #2644 because its skills are
      // already slash-menu entries as well as model-invocable context.
      if (_hostBehaviors(runtime).reportCommandsDir) {
        const commandsDir = path.join(targetDir, 'commands');
        if (fs.existsSync(commandsDir)) {
          const cmdCount = fs.readdirSync(commandsDir)
            .filter(f => f.startsWith('gsd-') && f.endsWith('.md')).length;
          if (cmdCount > 0) {
            console.log(`  ${green}✓${reset} Installed ${cmdCount} slash commands to commands/`);
          } else {
            failures.push('commands/gsd-*');
          }
        } else {
          failures.push('commands/gsd-*');
        }
      }
    }
  } else if (_hostBehaviors(runtime).localCommandsViaRules) {
    // Cline local install: rules-based only — commands are embedded in .clinerules (generated below).
    // No skills/commands directory needed for local installs.
    // Global installs are handled above by _isSkillsRuntime (#782).
    // Descriptor-driven (ADR-1239 / #2090): folded from `isCline` into
    // hostBehaviors.localCommandsViaRules.
    console.log(`  ${green}✓${reset} Cline: commands will be available via .clinerules`);
  } else if (_hostBehaviors(runtime).pluginOnlyInstall) {
    // pi (ADR-1239 / #2102 Stage 1): plugin-only install — pi's /gsd command is
    // registered programmatically by the native extension (pi/gsd.cjs →
    // extensions/gsd.js, staged separately below; the dest suffix must be
    // .ts/.js or pi's auto-discovery skips it silently — #2470) and dispatches in-process
    // through the embedded gsd-core command-routing hub. pi has no host-read
    // markdown surface (unlike Claude/OpenCode/etc., which scan commands/ or
    // command/ directories), so writing flat gsd-<cmd>.md files here would be
    // dead weight the extension never reads. Skip the flat-commands fallback
    // entirely for pluginOnlyInstall runtimes.
    console.log(`  ${green}✓${reset} pi: /gsd registered via native extension (no declarative command files)`);
  } else {
    // Claude Code local: flat gsd-<cmd>.md layout — Claude Code registers
    // commands from .claude/commands/ using the filename stem as the command
    // name, so gsd-<cmd>.md produces the /gsd-<cmd> hyphen form used everywhere
    // in the framework. The old commands/gsd/<cmd>.md subdirectory layout caused
    // Claude Code to namespace commands as /gsd:<cmd> (colon form). (#1367)
    const commandsDir = path.join(targetDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    const gsdSrc = _stageSkills(_commandsDir);
    const cmdNames = readGsdCommandNames();

    // Remove stale gsd-*.md files before writing new ones (clean install)
    if (fs.existsSync(commandsDir)) {
      for (const f of fs.readdirSync(commandsDir)) {
        if (f.startsWith('gsd-') && f.endsWith('.md')) {
          fs.unlinkSync(path.join(commandsDir, f));
        }
      }
    }

    // Write each command as gsd-<stem>.md (flat, hyphen-prefixed)
    let cmdCount = 0;
    if (fs.existsSync(gsdSrc)) {
      for (const entry of fs.readdirSync(gsdSrc, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const stem = entry.name.slice(0, -3);
        let content = fs.readFileSync(path.join(gsdSrc, entry.name), 'utf8');
        content = _applyRuntimeRewrites(content, runtime, pathPrefix, isGlobal, getCommitAttribution(runtime));
        content = normalizeAgentBodyForRuntime(content, runtime, cmdNames);
        fs.writeFileSync(path.join(commandsDir, `gsd-${stem}.md`), content);
        cmdCount++;
      }
    }

    if (cmdCount > 0) {
      console.log(`  ${green}✓${reset} Installed ${cmdCount} commands to commands/ (gsd-<cmd>.md flat form)`);
    } else {
      failures.push('commands/gsd-*');
    }

    // Legacy cleanup: remove old commands/gsd/ subdirectory from prior installs
    // that used the namespaced layout (wrote bare-name files under commands/gsd/).
    const legacyGsdDir = path.join(commandsDir, 'gsd');
    if (fs.existsSync(legacyGsdDir)) {
      // Stage user-owned dev-preferences.md DURABLY before wiping (#2875 /
      // #1874-F19 "site 6" — this Claude commands-install path open-coded
      // its own preserve/restore instead of calling preserveUserArtifacts,
      // found by sweeping for the read-then-wipe-then-write PATTERN rather
      // than for that helper's callers).
      // #2875 defect fix: DEGRADE, never abort install, when the staging
      // root cannot be resolved — skip this legacy-migration block entirely
      // (leave the stale dir in place) rather than wipe without a durable
      // backup.
      const _legacyGsdStagingRoot = _tryResolveUserArtifactStagingRoot(targetDir);
      if (_legacyGsdStagingRoot !== null) {
        const stagedDevPrefs = stageUserArtifacts(legacyGsdDir, ['dev-preferences.md'], _legacyGsdStagingRoot);
        // Preserve the ORIGINAL truthy-content check exactly: an existing but
        // EMPTY dev-preferences.md was (and still is) silently not migrated —
        // matching prior behavior byte-for-byte rather than widening scope.
        const preservedDevPrefs = stagedDevPrefs.names.includes('dev-preferences.md')
          ? fs.readFileSync(path.join(stagedDevPrefs.filesDir, 'dev-preferences.md'), 'utf8')
          : null;
        fs.rmSync(legacyGsdDir, { recursive: true });
        console.log(`  ${green}✓${reset} Removed legacy commands/gsd/ (migrated to flat gsd-<cmd>.md layout)`);
        if (preservedDevPrefs) {
          // Migrate dev-preferences to the new flat form — a RENAME on
          // restore (staged as 'dev-preferences.md', restored as
          // 'gsd-dev-preferences.md'), not a round-trip.
          restoreStagedUserArtifacts(commandsDir, stagedDevPrefs, { rename: { 'dev-preferences.md': 'gsd-dev-preferences.md' } });
          console.log(`  ${green}✓${reset} Migrated dev-preferences.md to commands/gsd-dev-preferences.md`);
        }
        discardStagedUserArtifacts(stagedDevPrefs);
      }
    }

    // Clean up any stale skills/ from a previous local install
    const staleSkillsDir = path.join(targetDir, 'skills');
    if (fs.existsSync(staleSkillsDir)) {
      const staleGsd = fs.readdirSync(staleSkillsDir, { withFileTypes: true })
        .filter(e => e.isDirectory() && e.name.startsWith('gsd-'));
      for (const e of staleGsd) {
        fs.rmSync(path.join(staleSkillsDir, e.name), { recursive: true });
      }
      if (staleGsd.length > 0) {
        console.log(`  ${green}✓${reset} Removed ${staleGsd.length} stale GSD skill(s) from skills/`);
      }
    }
  }

  // Native-extension/plugin staging for runtimes OUTSIDE the layout-driven
  // _isSkillsRuntime branch above (ADR-1239 / #2102 Stage 1: pi). OpenCode/Kilo
  // already get their nativePlugin file from installOpencodeFamilyArtifacts
  // (called inside the _isSkillsRuntime branch, since both declare a non-empty
  // artifactLayout) — guard on `!_isSkillsRuntime` so this standalone call never
  // double-stages their plugin file. A runtime like pi, whose artifactLayout is
  // intentionally empty for both scopes (`_isSkillsRuntime` is false), still
  // needs its declared hostBehaviors.nativePlugin file copied into targetDir.
  if (!_isSkillsRuntime && _hostBehaviors(runtime).nativePlugin) {
    _installNativePluginIfDeclared(runtime, targetDir, _hostBehaviors(runtime), src);
  }

  // Copy gsd-core skill with path replacement
  // Stage user-generated files DURABLY to disk before the wipe-and-copy so
  // they survive re-install even if the process dies mid-copy (#2875 /
  // #1874-F19) — copyWithPathReplacement wipes and recursively re-copies the
  // entire gsd-core/ tree, the single longest operation in the install, on
  // the path every user takes (40-design.md "Site 4 is far worse...").
  const skillSrc = path.join(src, 'gsd-core');
  const skillDest = path.join(targetDir, 'gsd-core');
  // #2875 defect fix: this IS the mainline install step (installing
  // gsd-core/ itself) — unlike the optional legacy-cleanup blocks above,
  // install must still be able to proceed and actually write gsd-core/ even
  // when the staging root cannot be resolved. Degrade by skipping ONLY the
  // USER_OWNED_ARTIFACTS preserve/restore wrapper around the copy (warn),
  // never the copy itself.
  const _gsdArtifactsStagingRoot = _tryResolveUserArtifactStagingRoot(targetDir);
  if (_gsdArtifactsStagingRoot === null) {
    console.warn(`  ${yellow}!${reset} Skipping gsd-core/${USER_OWNED_ARTIFACTS.join(', gsd-core/')} preservation (staging unavailable) — it will be lost if present.`);
    copyWithPathReplacement(skillSrc, skillDest, pathPrefix, runtime, false, isGlobal, targetDir);
  } else {
    const stagedGsdArtifacts = stageUserArtifacts(skillDest, USER_OWNED_ARTIFACTS, _gsdArtifactsStagingRoot);
    copyWithPathReplacement(skillSrc, skillDest, pathPrefix, runtime, false, isGlobal, targetDir);
    restoreStagedUserArtifacts(skillDest, stagedGsdArtifacts);
    discardStagedUserArtifacts(stagedGsdArtifacts);
  }
  if (verifyInstalled(skillDest, 'gsd-core')) {
    console.log(`  ${green}✓${reset} Installed workflow assets`);
  } else {
    failures.push('gsd-core');
  }

  // #2624: the .gsd-source marker is now written by _writeGsdSourceMarker()
  // BEFORE staging reads it (see the early call above the _isSkillsRuntime
  // block). The former write lived here — AFTER staging — which on an upgrade
  // let staging read a stale prior-version marker and silently install
  // old-version skill content. Moved up; this site intentionally left empty.

  // #1629 critical fix: Windsurf workflow wrappers (convertClaudeCommandToWindsurfWorkflow)
  // delegate to command bodies at <targetDir>/gsd-core/commands/gsd/${stem}.md via a
  // hardcoded @~/.claude/gsd-core/commands/gsd/ path that _applyRuntimeRewrites rewrites
  // to the install target. The source gsd-core/ dir does NOT ship with commands/ —
  // the canonical command source lives at the package root (commands/gsd/). Without
  // this copy, every /gsd-* workflow in Cascade references a missing file and the LLM
  // cannot execute the command body. Surfaced by the #1629 regression test after the
  // original adversarial review of #1622 missed it.
  // Descriptor-driven (ADR-1239 / #2100): folded from `isWindsurf` into
  // hostBehaviors.installsCommandBodiesForWorkflowDelegation (windsurf is the
  // only runtime that declares it, so this is byte-parity — the #1629 fix
  // itself is unchanged).
  if (_hostBehaviors(runtime).installsCommandBodiesForWorkflowDelegation && !isGlobal) {
    const commandsSrc = path.join(src, 'commands', 'gsd');
    const commandsDest = path.join(skillDest, 'commands', 'gsd');
    if (fs.existsSync(commandsSrc)) {
      copyWithPathReplacement(commandsSrc, commandsDest, pathPrefix, runtime, true, isGlobal, targetDir);
      console.log(`  ${green}✓${reset} Installed command bodies to gsd-core/commands/gsd/ (workflow delegation targets)`);
    }
  }

  // Copy shared manifests into the gsd-core payload
  // at the co-located path that CJS modules resolve first:
  //   gsd-core/bin/shared/*.json
  //
  // This source now lives under gsd-core/bin/shared in-repo.
  const sharedPayloadFiles = [
    'model-catalog.json',
    'config-defaults.manifest.json',
    'config-schema.manifest.json',
    'runtime-aliases.manifest.json',
  ];
  for (const fileName of sharedPayloadFiles) {
    const sharedSrc = path.join(src, 'gsd-core', 'bin', 'shared', fileName);
    const sharedDest = path.join(skillDest, 'bin', 'shared', fileName);
    const displayPath = `gsd-core/bin/shared/${fileName}`;
    if (fs.existsSync(sharedSrc)) {
      fs.mkdirSync(path.dirname(sharedDest), { recursive: true });
      fs.copyFileSync(sharedSrc, sharedDest);
      if (verifyFileInstalled(sharedDest, displayPath)) {
        console.log(`  ${green}✓${reset} Installed ${displayPath}`);
      } else {
        failures.push(displayPath);
      }
    } else {
      failures.push(`gsd-core/bin/shared/${fileName} (source missing)`);
    }
  }

  // Agents directory materialization.
  // #2875 Part 2 (the agents-bypass closure): EVERY runtime is now
  // descriptor-driven for agents — installRuntimeArtifacts (called earlier in
  // this function, the `_isSkillsRuntime` branch above) already wrote
  // agents/ for any runtime whose capability.json declares an `agents` kind,
  // via convertedAgentsKind/agentsKind (generic layout loop) or
  // installAgentsKindStandalone (OpenCode/Kilo's combinedFamilyInstall
  // branch, called from within installOpencodeFamilyArtifacts) — both reuse
  // the SAME stageAgentsForRuntimeWithConverter pipeline (path-rewrite →
  // attribution → converter → frontmatter extensions → normalize) the
  // inline loop this replaces used to hand-roll, and both prune stale gsd-*
  // entries via their own _removeGsdEntries pass BEFORE copying (broader
  // than this loop's old extension-gated stale check — see
  // runtime-artifact-layout.cts's convertedAgentsKind doc comment).
  // Minimal-mode agent filtering is handled the SAME way it already was for
  // the ten runtimes cut over before this change: via resolvedProfile.agents
  // at staging time, not a separate branch here.
  //
  // `!_isSkillsRuntime` runtimes (claude-local's legacy-flat local path, and
  // pi) never reach that loop at all — installAgentsKindStandalone is called
  // here explicitly to cover them (install-engine.cts's own doc comment
  // explains why; a regression here was caught by the install-tree golden
  // fixture, tests/fixtures/install-tree/claude-local.json). It is a no-op
  // for pi: its capability.json declares an EMPTY artifactLayout for both
  // scopes (programmatic dispatch, no named-dispatch subagent toolkit, no
  // host-read markdown surface), so the resolved layout has no `agents` kind
  // to stage and the function returns `null` without writing anything.
  if (_hostBehaviors(runtime).pluginOnlyInstall) {
    console.log(`  ${green}✓${reset} pi: no subagent files (programmatic dispatch, no named-dispatch toolkit)`);
  } else if (_isSkillsRuntime) {
    console.log(`  ${dim}↳${reset} Agents installed via descriptor-driven layout (${runtime})`);
  } else {
    const _standaloneAgentsResult = installAgentsKindStandalone(runtime, targetDir, _installScopeId, _resolvedProfile, pathPrefix, getCommitAttribution, _installedCapabilityRegistry);
    if (_standaloneAgentsResult) {
      // #2875 defect fix: installAgentsKindStandalone now returns `null`
      // (rather than a truthy result pointing at an empty destDir) whenever a
      // restricted (non-'*') resolvedProfile — --minimal being the common
      // case — legitimately stages ZERO agents, matching the pre-#2875-Part-2
      // inline loop's behavior of never creating agentsDest under --minimal
      // at all (see the deleted `isMinimalMode` branch). `destDir` is
      // therefore guaranteed non-empty whenever we reach this branch, so a
      // real staging failure still fails loudly via verifyInstalled below.
      if (verifyInstalled(_standaloneAgentsResult.destDir, 'agents')) {
        console.log(`  ${green}✓${reset} Installed agents`);
      } else {
        failures.push('agents');
      }
    } else if (_resolvedProfile.skills !== '*') {
      console.log(`  ${dim}↳${reset} Skipping agents (${_resolvedProfile.name} profile excludes all agents — run \`gsd update\` with a broader profile to add them)`);
    } else {
      console.log(`  ${dim}↳${reset} No agents kind declared for ${runtime} at this scope`);
    }
  }

  // Codex registers agents in `config.toml` via `[agents.gsd-*]` sections —
  // NOT agents-directory materialization (design doc "Deliberately not in
  // scope"), so this stays independent of the agents/ write above. Without
  // stripping these on a full → minimal reinstall, the runtime would keep
  // advertising the old full agent surface even though the descriptor-driven
  // write above already skipped writing the .md files for a minimal-tier
  // resolvedProfile. Reuse the same helper that powers `--uninstall`.
  if (isMinimalMode(_effectiveInstallMode) && _hostBehaviors(runtime).tomlConfigInstall) {
    const codexConfigPath = path.join(targetDir, 'config.toml');
    if (fs.existsSync(codexConfigPath)) {
      const existing = fs.readFileSync(codexConfigPath, 'utf8');
      const cleaned = stripGsdFromCodexConfig(existing);
      if (cleaned === null) {
        fs.unlinkSync(codexConfigPath);
      } else if (cleaned !== existing) {
        fs.writeFileSync(codexConfigPath, cleaned);
      }
    }
  }

  // agentsSrc is declared as `let` before the enclosing try block (not const)
  // so it is accessible by installCodexConfig() in the Codex config section
  // below — that function reads RAW source agents/*.md (not the
  // descriptor-staged output above) to build Codex's per-agent config.toml
  // sidecar files, a separate writer this migration deliberately does not
  // touch (design doc: "Codex's config.toml [agents.gsd-*] strip... is not
  // agents-directory materialization").
  agentsSrc = _stageAgents(path.join(src, 'agents'));

  // Copy CHANGELOG.md
  const changelogSrc = path.join(src, 'CHANGELOG.md');
  const changelogDest = path.join(targetDir, 'gsd-core', 'CHANGELOG.md');
  if (fs.existsSync(changelogSrc)) {
    fs.copyFileSync(changelogSrc, changelogDest);
    if (verifyFileInstalled(changelogDest, 'CHANGELOG.md')) {
      console.log(`  ${green}✓${reset} Installed CHANGELOG.md`);
    } else {
      failures.push('CHANGELOG.md');
    }
  }

  // Write VERSION file
  const versionDest = path.join(targetDir, 'gsd-core', 'VERSION');
  fs.writeFileSync(versionDest, pkg.version);
  if (verifyFileInstalled(versionDest, 'VERSION')) {
    console.log(`  ${green}✓${reset} Wrote VERSION (${pkg.version})`);
  } else {
    failures.push('VERSION');
  }

  // #2297: write a per-install runtime marker co-located with VERSION at
  // <install>/gsd-core/.gsd-runtime. It gives resolveModelInternal a reliable
  // "which runtime owns THIS install" signal in a no-project session (config.runtime
  // is null and GSD_RUNTIME is not exported), so the shared ~/.gsd/defaults.json
  // resolve_model_ids:"omit" policy (written below for non-alias runtimes only)
  // applies ONLY when a non-alias runtime is actually resolving — a Claude session
  // reads its own marker and keeps its tier aliases instead of inheriting another
  // runtime's install-order-dependent "omit". See src/model-resolver.cts.
  const runtimeMarkerDest = path.join(targetDir, 'gsd-core', '.gsd-runtime');
  fs.writeFileSync(runtimeMarkerDest, `${runtime}\n`);
  if (verifyFileInstalled(runtimeMarkerDest, '.gsd-runtime')) {
    console.log(`  ${green}✓${reset} Wrote runtime marker (.gsd-runtime: ${runtime})`);
  } else {
    failures.push('.gsd-runtime');
  }

  // Reusable: copy hooks/dist/ + hooks/lib/ into destRootDir, writing the
  // CommonJS package.json marker alongside them. Used below for the generic
  // configDir install path (guarded by hostBehaviors.skipSharedHooksInstall),
  // and — since #2095 — for Kimi's OWN native hook-install root (~/.kimi,
  // resolved by resolveKimiHooksTomlDir), a directory entirely separate from
  // Kimi's configDir/agents-root. Kimi's contract forbids hooks/ or
  // package.json under its generic Agent-Skills root (see
  // capabilities/kimi/capability.json hostBehaviors.skipSharedHooksInstall
  // and the kimi-hooks-toml branch further below), so its shared-hooks bundle
  // is installed into its own root via this same helper instead.
  // Returns false when hooks/dist/ exists but failed to verify post-copy (a
  // genuine failure the caller should surface); true otherwise (including
  // when hooks/dist/ is absent from the package — nothing to verify).
  function installSharedHooksBundle(destRootDir) {
    // destRootDir already exists for the generic call site (targetDir — created
    // earlier in install() by the skills/agents writes above). It does NOT yet
    // exist for kimi's call site (~/.kimi, resolved by resolveKimiHooksTomlDir):
    // a fresh install has never created that dir before. mkdirSync recursive is
    // a safe no-op when the dir is already present.
    fs.mkdirSync(destRootDir, { recursive: true });

    // #3023: the bundle's directory NAME is descriptor-driven — a host that
    // reserves `hooks/` (pi) must be able to opt out. Resolved once here so the
    // stage / lib / marker sites can never disagree about where the bundle is.
    const sharedHooksDirName = resolveSharedHooksDirName(runtime);

    // #2544: the CommonJS marker is NOT written here (destRootDir is the
    // runtime's shared config root — user-writable territory on OpenCode and
    // Kilo, where it is the documented place to declare local-plugin npm
    // dependencies). It is written into hooks/ below, the directory GSD
    // creates and fills with its own .js scripts, once that directory exists.

    let hooksOk = true;
    // #2544: true once GSD has actually written into destRootDir/hooks/, which
    // is what licenses the CommonJS marker below.
    let stagedHooks = false;

    // Copy hooks from dist/ (bundled with dependencies)
    // Template paths for the target runtime (replaces '.claude' with correct config dir)
    const hooksSrc = path.join(src, 'hooks', 'dist');
    if (fs.existsSync(hooksSrc)) {
      const hooksDest = path.join(destRootDir, sharedHooksDirName);
      fs.mkdirSync(hooksDest, { recursive: true });
      const hookEntries = fs.readdirSync(hooksSrc);
      if (hookEntries.some((e) => fs.statSync(path.join(hooksSrc, e)).isFile())) stagedHooks = true;
      const configDirReplacement = getConfigDirFromHome(runtime, isGlobal);
      for (const entry of hookEntries) {
        const srcFile = path.join(hooksSrc, entry);
        if (fs.statSync(srcFile).isFile()) {
          const destFile = path.join(hooksDest, entry);
          if (entry.endsWith('.js') || entry.endsWith('.cjs')) {
            let content = fs.readFileSync(srcFile, 'utf8');
            content = content.replace(/'\.claude'/g, configDirReplacement);
            content = content.replace(/\/\.claude\//g, `/${getDirName(runtime)}/`);
            content = content.replace(/\.claude\//g, `${getDirName(runtime)}/`);
            // Descriptor-driven (ADR-1239 / #2092): folded from separate
            // `isQwen` / hermes-hardcoded branches into a single read of
            // runtime.hostBehaviors.brandingRewrites. This site only
            // rewrites the two brand-name keys (no `.claude/` here — the
            // config-dir replace above already handled path fragments).
            const _b2 = _hostBehaviors(runtime).brandingRewrites;
            if (_b2) {
              content = content.replace(/CLAUDE\.md/g, _b2['CLAUDE.md']);
              content = content.replace(/\bClaude Code\b/g, _b2['Claude Code']);
            }
            // #376: rewrite gsd: → gsd- for hyphen-namespace runtimes
            if (shouldNormalizeHyphenNamespaceInAgentBody(runtime)) {
              content = content.replace(/gsd:/gi, 'gsd-');
            }
            content = content.replace(/\{\{GSD_VERSION\}\}/g, pkg.version);
            fs.writeFileSync(destFile, content);
            try { fs.chmodSync(destFile, 0o755); } catch (e) { /* Windows */ }
          } else {
            // non-.js: .sh hooks need {{GSD_VERSION}} stamped; others are copied as-is
            if (entry.endsWith('.sh')) {
              let content = fs.readFileSync(srcFile, 'utf8');
              content = content.replace(/\{\{GSD_VERSION\}\}/g, pkg.version);
              fs.writeFileSync(destFile, content);
              try { fs.chmodSync(destFile, 0o755); } catch (e) { /* Windows doesn't support chmod */ }
            } else {
              fs.copyFileSync(srcFile, destFile);
            }
          }
        } else if (fs.statSync(srcFile).isDirectory()) {
          // #3579: recurse one level into hook subdirs (lib/ etc.). The
          // graphify auto-update hook's rebuild helper lives at
          // hooks/dist/lib/gsd-graphify-rebuild.sh and must land at the
          // mirrored target path so the hook's REBUILD_SCRIPT lookup resolves.
          const subDest = path.join(hooksDest, entry);
          fs.mkdirSync(subDest, { recursive: true });
          const subEntries = fs.readdirSync(srcFile);
          for (const subEntry of subEntries) {
            const subSrcFile = path.join(srcFile, subEntry);
            if (!fs.statSync(subSrcFile).isFile()) continue;
            const subDestFile = path.join(subDest, subEntry);
            if (subEntry.endsWith('.sh')) {
              let content = fs.readFileSync(subSrcFile, 'utf8');
              content = content.replace(/\{\{GSD_VERSION\}\}/g, pkg.version);
              fs.writeFileSync(subDestFile, content);
              try { fs.chmodSync(subDestFile, 0o755); } catch (e) { /* Windows */ }
            } else {
              fs.copyFileSync(subSrcFile, subDestFile);
            }
          }
        }
      }
      if (verifyInstalled(hooksDest, 'hooks')) {
        console.log(`  ${green}✓${reset} Installed ${sharedHooksDirName} (bundled)`);
        // Warn if expected community .sh hooks are missing (non-fatal)
        const expectedShHooks = ['gsd-session-state.sh', 'gsd-validate-commit.sh', 'gsd-phase-boundary.sh', 'gsd-graphify-update.sh'];
        for (const sh of expectedShHooks) {
          if (!fs.existsSync(path.join(hooksDest, sh))) {
            console.warn(`  ${yellow}⚠${reset}  Missing expected hook: ${sh}`);
          }
        }
      } else {
        hooksOk = false;
      }
    }

    // Gate hooks/lib/ install on the same set of runtimes that receive hooks/.
    // Codex/Copilot/Cursor/Windsurf/Trae/Cline do not use the shared
    // hooks/lib/ helpers (Cursor uses standalone .js hook scripts registered
    // via hooks.json — gated descriptor-driven via
    // hostBehaviors.skipSharedHooksInstall, #2089; Cline likewise #2090;
    // Trae likewise #2094; Codex uses hooks.json directly;
    // the others skip hooks entirely); ZCode also skips hooks entirely
    // (hooksSurface:'none' with no plugin surface — #1821). Kilo is NOT
    // excluded since #2305: its native plugin adapter (#2093) spawns the
    // staged hooks/*.js scripts, same as OpenCode. None of the
    // excluded runtimes must receive the hooks/lib/ helpers — otherwise the
    // Codex comment downstream ("we deliberately do *not* copy hooks/lib/ for
    // Codex") is contradicted in practice. (Gating lives at the call sites
    // below; this helper itself only checks source presence.)
    const hooksLibSrc = path.join(src, 'hooks', 'lib');
    if (fs.existsSync(hooksLibSrc)) {
      const hooksLibDest = path.join(destRootDir, sharedHooksDirName, 'lib');
      fs.mkdirSync(hooksLibDest, { recursive: true });
      copyLibDir(hooksLibSrc, hooksLibDest, GSD_HOOK_LIB_FILES);
      if (GSD_HOOK_LIB_FILES.some((f) => fs.existsSync(path.join(hooksLibDest, f)))) stagedHooks = true;
      console.log(`  ${green}✓${reset} Installed ${sharedHooksDirName}/lib/ helpers (git-cmd, graphify-rebuild, ...)`);
    }

    // #2544: pin the staged hook scripts to CommonJS from inside hooks/ — the
    // directory GSD just created and filled — instead of from destRootDir.
    // Scoping the marker to GSD's own directory keeps `require` working in
    // hooks/*.js and hooks/lib/*.js under any ambient "type": "module", while
    // leaving the shared config root untouched.
    //
    // Gated on `stagedHooks`, NOT on the directory merely existing: hooks/ is
    // shared space, so an existence check would drop a GSD marker into a
    // hooks/ directory the user created and GSD never wrote to — the same
    // write-into-someone-else's-territory this issue is about. And never
    // written over a package.json GSD does not own.
    //
    // ALSO gated on `hooksOk`: `stagedHooks` is computed from the SOURCE
    // listing before the copy loop, so it stays true when the copies land but
    // `verifyInstalled` then fails. Marking a hooks/ GSD did not successfully
    // populate as CommonJS claims an ownership the install did not earn — the
    // two flags answer different questions ("did we intend to fill it" vs "is
    // it actually filled"), and the marker needs both.
    const hooksMarkerDir = path.join(destRootDir, sharedHooksDirName);
    if (stagedHooks && hooksOk) {
      switch (ensureCommonJsMarker(hooksMarkerDir)) {
        case 'written':
          console.log(`  ${green}✓${reset} Wrote ${sharedHooksDirName}/package.json (CommonJS mode)`);
          break;
        case 'preserved-foreign':
          console.warn(`  ${yellow}⚠${reset}  Left existing ${sharedHooksDirName}/package.json untouched (not GSD's marker) — GSD hooks may not resolve as CommonJS`);
          break;
        case 'failed':
          // Best-effort: a read-only or full config dir must not abort the
          // install with a raw stack trace. The hooks themselves are staged.
          console.warn(`  ${yellow}⚠${reset}  Could not write ${sharedHooksDirName}/package.json (CommonJS mode) — install continued; GSD hooks may not resolve as CommonJS`);
          break;
        default:
          break;
      }
    }

    return hooksOk;
  }

  // #1821: ZCode declares hooksSurface:'none' AND has no plugin surface,
  // so the staged hook scripts are dead weight for it — excluded here.
  // OpenCode also declares hooksSurface:'none' but is deliberately NOT excluded:
  // its native plugin adapter (#1914, installed above under plugins/gsd-core.js)
  // spawns the staged hooks/*.js scripts via OpenCode's event bus and needs both
  // them and the CommonJS package.json marker written below. Kilo is the same
  // shape since #2093 (a nativePlugin spawning the staged hooks), so it must
  // NOT skip either — declaring skipSharedHooksInstall:true alongside a
  // nativePlugin left every guard the plugin spawns a silent no-op (#2305).
  // #2089: Cursor's exclusion is now descriptor-driven via
  // hostBehaviors.skipSharedHooksInstall (was hardcoded !isCursor).
  // #2090: Cline's exclusion is likewise descriptor-driven (cline declares
  // skipSharedHooksInstall:true) — the redundant `&& !isCline` was removed.
  // #2093/#2305: Kilo's former exclusion (descriptor-driven via
  // skipSharedHooksInstall:true) was removed in #2305 — see above.
  // #2094: Trae's exclusion is likewise descriptor-driven (trae declares
  // skipSharedHooksInstall:true) — the redundant `&& !isTrae` was removed.
  // #2101: ZCode's exclusion is likewise descriptor-driven (zcode declares
  // skipSharedHooksInstall:true) — the redundant `&& !isZcode` was removed.
  // #2095: Kimi's exclusion is likewise descriptor-driven (kimi declares
  // skipSharedHooksInstall:true) — kimi's shared hooks/ + package.json marker
  // are instead installed into its OWN native hook root (~/.kimi, resolved by
  // resolveKimiHooksTomlDir) via installSharedHooksBundle, at the
  // kimi-hooks-toml branch further below — never under the generic
  // Agent-Skills configDir GSD installs skills/agents into for kimi.
  // #2099: Copilot's exclusion is likewise descriptor-driven (copilot declares
  // skipSharedHooksInstall:true) — the redundant `&& !isCopilot` was removed.
  // #2100: Windsurf's exclusion is likewise descriptor-driven (windsurf declares
  // skipSharedHooksInstall:true) — the redundant `&& !isWindsurf` was removed.
  if (!isCodex && _hostBehaviors(runtime).skipSharedHooksInstall !== true) {
    if (!installSharedHooksBundle(targetDir)) {
      failures.push('hooks');
    }
  }

  // Install scripts/changeset/ and scripts/lib/ into <configDir>/scripts/
  // so that `node "$GSD_DIR/scripts/changeset/cli.cjs"` resolves at runtime.
  //
  // The changeset CLI (scripts/changeset/cli.cjs) is invoked by the update
  // workflow (gsd-core/workflows/update.md) to extract changelog ranges for
  // the /gsd-update preview step. It was previously only present in the npm
  // tarball root but never copied to the runtime config dir, causing the
  // preview to always silently fail (#935).
  //
  // cli.cjs requires:
  //   - sibling files in scripts/changeset/ (parse/render/serialize/github-release-notes)
  //   - ../lib/cli-exit.cjs  → scripts/lib/cli-exit.cjs
  //   - ../../gsd-core/bin/lib/semver-compare.cjs  (already installed under gsd-core/)
  //   - ../../gsd-core/bin/lib/package-identity.cjs (already installed under gsd-core/)
  //
  // All runtimes that use the update workflow need this, so we copy unconditionally
  // (same scope as gsd-core/ itself — every runtime that installs workflows gets it).
  const changesetSrc = path.join(src, 'scripts', 'changeset');
  const scriptsLibSrc = path.join(src, 'scripts', 'lib');
  if (!fs.existsSync(changesetSrc)) {
    // The changeset CLI source is missing from the package — mark as a hard failure
    // so the user knows the changelog preview will not work rather than silently degrading.
    failures.push('scripts/changeset/ (source missing from package — reinstall from npm)');
  } else {
    const changesetDest = path.join(targetDir, 'scripts', 'changeset');
    const scriptsLibDest = path.join(targetDir, 'scripts', 'lib');
    fs.mkdirSync(changesetDest, { recursive: true });
    fs.mkdirSync(scriptsLibDest, { recursive: true });
    // Copy scripts/changeset/ — all .cjs and .md files
    for (const entry of fs.readdirSync(changesetSrc)) {
      const srcFile = path.join(changesetSrc, entry);
      if (fs.statSync(srcFile).isFile()) {
        fs.copyFileSync(srcFile, path.join(changesetDest, entry));
      }
    }
    // Copy scripts/lib/ — cli-exit.cjs (required by cli.cjs) and any future lib helpers.
    // Hard-fail if missing: without cli-exit.cjs the installed CLI throws MODULE_NOT_FOUND.
    if (!fs.existsSync(scriptsLibSrc)) {
      failures.push('scripts/lib/ (source missing from package — reinstall from npm)');
    } else {
      for (const entry of fs.readdirSync(scriptsLibSrc)) {
        const srcFile = path.join(scriptsLibSrc, entry);
        if (fs.statSync(srcFile).isFile()) {
          fs.copyFileSync(srcFile, path.join(scriptsLibDest, entry));
        }
      }
      // Verify the critical dep cli-exit.cjs landed
      if (!verifyFileInstalled(path.join(scriptsLibDest, 'cli-exit.cjs'), 'scripts/lib/cli-exit.cjs')) {
        failures.push('scripts/lib/cli-exit.cjs');
      }
    }
    if (verifyFileInstalled(path.join(changesetDest, 'cli.cjs'), 'scripts/changeset/cli.cjs')) {
      console.log(`  ${green}✓${reset} Installed scripts/changeset/ (changelog preview CLI)`);
    } else {
      failures.push('scripts/changeset/cli.cjs');
    }
  }

  // Copy scripts/fix-slash-commands.cjs — required by gsd-core/bin/lib/command-roster.cjs
  // at load time via require('../../../scripts/fix-slash-commands.cjs'). Without this file
  // every gsd-tools command crashes with MODULE_NOT_FOUND (#1223).
  // This copy is independent of scripts/changeset/ — it must land even when the
  // changeset CLI source is absent.
  {
    const fixSlashSrc = path.join(src, 'scripts', 'fix-slash-commands.cjs');
    const fixSlashDest = path.join(targetDir, 'scripts', 'fix-slash-commands.cjs');
    fs.mkdirSync(path.join(targetDir, 'scripts'), { recursive: true });
    if (!fs.existsSync(fixSlashSrc)) {
      failures.push('scripts/fix-slash-commands.cjs (source missing from package — reinstall from npm)');
    } else {
      fs.copyFileSync(fixSlashSrc, fixSlashDest);
      if (!verifyFileInstalled(fixSlashDest, 'scripts/fix-slash-commands.cjs')) {
        failures.push('scripts/fix-slash-commands.cjs');
      }
    }
  }

  // Copy scripts/gen-capability-registry.cjs + scripts/gen-loop-host-contract.cjs —
  // required by gsd-core/bin/lib/capability-loader.cjs at overlay-composition time via
  // require('../../../scripts/gen-capability-registry.cjs') (which itself requires
  // gen-loop-host-contract.cjs). Without these, the loader's never-crash invariant
  // discards EVERY third-party capability overlay and silently falls back to the frozen
  // first-party registry, so installed capabilities are inert (#1920). Same class of
  // gap as #1223 (fix-slash-commands.cjs) and copied unconditionally for the same reason:
  // any runtime that installs gsd-core/ needs the capability system to compose.
  {
    const capGenDestDir = path.join(targetDir, 'scripts');
    fs.mkdirSync(capGenDestDir, { recursive: true });
    for (const gen of ['gen-capability-registry.cjs', 'gen-loop-host-contract.cjs']) {
      const genSrc = path.join(src, 'scripts', gen);
      const genDest = path.join(capGenDestDir, gen);
      if (!fs.existsSync(genSrc)) {
        failures.push(`scripts/${gen} (source missing from package — reinstall from npm)`);
      } else {
        fs.copyFileSync(genSrc, genDest);
        if (!verifyFileInstalled(genDest, `scripts/${gen}`)) {
          failures.push(`scripts/${gen}`);
        }
      }
    }
  }

  // Remove legacy get-shit-done-cc artifacts and stale update caches (#607).
  // cleanupLegacyGsdCc handles both the legacy shared cache and the per-package
  // cache (formerly an inline unlinkSync here). A cleanup failure must never
  // abort a successful install — log a warning and continue.
  // install() is never reached in --dry-run mode (the early-exit at the CLI
  // dispatch handles preview), so cleanup here always applies for real.
  try {
    cleanupLegacyGsdCc({ dryRun: false });
  } catch (cleanupErr) {
    console.warn(`  ${yellow}Warning: legacy cleanup failed: ${cleanupErr.message}${reset}`);
  }

  if (failures.length > 0) {
    console.error(`\n  ${yellow}Installation incomplete!${reset} Failed: ${failures.join(', ')}`);
    process.exit(1);
  }

  // Write file manifest for future modification detection
  writeManifest(targetDir, runtime, { mode: _effectiveInstallMode, scope: _installScopeId });
  console.log(`  ${green}✓${reset} Wrote file manifest (${MANIFEST_NAME})`);

  // Report any backed-up local patches
  reportLocalPatches(targetDir, runtime);

  // #2873: cross-scope shadow report. Fires ONCE per install (this is the
  // only writeManifest call site that gets it — the other four sites are
  // sub-writes within a single install, not separate installs). A shadowed
  // install is a warning, never a failure (ADR-2866 Consequences), so this
  // never touches `failures` or `process.exit`, and the whole block is
  // wrapped in a try/catch that swallows everything: a report failure must
  // never fail an otherwise-successful install (design row C5). No options
  // are injected into buildShadowReport — this is the production call shape,
  // resolving the real machine via os.homedir()/process.cwd() defaults
  // inside the resolver.
  try {
    const shadowReport = buildShadowReport(runtime);
    const shadowLines = renderShadowReport(shadowReport);
    if (shadowLines.length > 0) {
      console.warn(`\n  ${yellow}⚠${reset}  ${shadowLines[0]}`);
      for (const line of shadowLines.slice(1)) {
        console.warn(`  ${dim}${line}${reset}`);
      }
    }
  } catch (_shadowReportErr) {
    // Never fail an install over a reporting concern — see comment above.
  }

  // Verify no leaked .claude paths in non-Claude runtimes (manifest-scoped)
  if (!_hostBehaviors(runtime).ownsClaudePaths) {
    const leakedPaths = [];
    // Only scan files that were written by this install (manifest-tracked).
    // Scanning the entire targetDir can match user-authored content that
    // legitimately references ~/.claude (e.g. personal notes), producing
    // false-positive warnings. Restricting to the manifest avoids that.
    let manifestFiles = null;
    try {
      const manifestPath = path.join(targetDir, MANIFEST_NAME);
      if (fs.existsSync(manifestPath)) {
        const manifestData = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifestData && typeof manifestData.files === 'object') {
          manifestFiles = Object.keys(manifestData.files);
        }
      }
    } catch (_manifestParseErr) {
      // If we cannot read/parse the manifest, skip the scan entirely to
      // avoid false positives rather than falling back to a full directory walk.
      manifestFiles = null;
    }
    if (manifestFiles !== null) {
      for (const relPath of manifestFiles) {
        const fileName = path.basename(relPath);
        if (!(fileName.endsWith('.md') || fileName.endsWith('.toml'))) continue;
        if (fileName === 'CHANGELOG.md') continue;
        const fullPath = path.join(targetDir, relPath);
        let content;
        try {
          content = fs.readFileSync(fullPath, 'utf8');
        } catch (err) {
          if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'ENOENT') {
            continue; // skip inaccessible or missing files
          }
          throw err;
        }
        const matches = content.match(/(?:~|\$HOME)\/\.claude\b/g);
        if (matches) {
          leakedPaths.push({ file: relPath, count: matches.length });
        }
      }
    }
    if (leakedPaths.length > 0) {
      const totalLeaks = leakedPaths.reduce((sum, l) => sum + l.count, 0);
      console.warn(`\n  ${yellow}⚠${reset}  Found ${totalLeaks} unreplaced .claude path reference(s) in ${leakedPaths.length} file(s):`);
      for (const leak of leakedPaths.slice(0, 5)) {
        console.warn(`     ${dim}${leak.file}${reset} (${leak.count})`);
      }
      if (leakedPaths.length > 5) {
        console.warn(`     ${dim}... and ${leakedPaths.length - 5} more file(s)${reset}`);
      }
      console.warn(`  ${dim}These paths may not resolve correctly for ${runtimeLabel}.${reset}`);
    }
  }

  } catch (_earlyInstallErr) {
    // Installer Migration Module Phase 4: docs/installer-migrations.md
    // requires safe migrations to run before package materialization without
    // leaving stale state behind when materialization fails. Roll migration
    // actions back for every runtime; Codex then layers its broader runtime
    // snapshot rollback on top.
    rollbackInstallerMigrations();
    // #3245 CR finding 2 — any throw in the pre-config install operations (skills copy,
    // agents copy, VERSION write, manifest write, etc.) triggers the Codex pre-config
    // rollback so the caller is never left in a partially-installed state.
    // (The second, identical rollbackInstallerMigrations() that used to sit here was
    // a duplicate of the line above, not a second phase — removed in #3725 review.)
    // #3712 — the test-home guard refuses before any LAYOUT-DRIVEN write, so no
    // gsd-* directory in the skills root has been touched and there is nothing
    // there to undo. (Legacy install migrations DO run first; that is why the
    // rollbackInstallerMigrations() calls above still execute, and why the one
    // migration that can reach a `home` override carries its own assertion.)
    // Running the codex rollback anyway would delete and recreate every
    // snapshotted gsd-* directory in the resolved skills root, which for an
    // un-sandboxed codex install IS the real ~/.agents/skills: the guard's own
    // refusal would provoke the mutation it exists to prevent. This is the only
    // _codexPreConfigRollback() call site, and applySurface/uninstall cannot
    // reach it. Every other error still rolls back. Found by review, not by CI.
    if (isTestHomeGuardRefusal(_earlyInstallErr)) throw _earlyInstallErr;
    if (_codexPreConfigRollback) {
      _codexPreConfigRollback();
    }
    throw _earlyInstallErr;
  }

  // #2695: this branch runs for BOTH `core` (minimal) and `full` profiles.
  // Hooks are lightweight infrastructure (update-check + context monitor), not the
  // "full agent surface" that `core` deliberately omits. The config.toml / agent
  // generation below is still gated by its own inner `!isMinimalMode` guard, so
  // `core` enters the branch to receive the hook-file copy + hooks.json wiring but
  // does NOT get agent roles generated. Before #2695 the outer `!isMinimalMode`
  // here skipped the whole branch for `core`, so the registered parent hook pointed
  // at a worker/registry the same installer never delivered.
  if (plan.installSurface === 'codex-toml') {
    // Capture pre-install snapshots before ANY GSD mutation
    // (#2760 fix 3). On post-write schema-validation failure OR any throw
    // during the mutation sequence (write failure, merge throw, etc.) we
    // restore these exact bytes so the user is never left with a broken
    // Codex CLI (#2760 fix 4 — extends snapshot coverage to write-failure
    // paths, paired with atomic temp-file writes in mergeCodexConfig and
    // the final hooks-write below).
    const codexConfigPathPreInstall = path.join(targetDir, 'config.toml');
    const codexConfigPreInstallSnapshot = fs.existsSync(codexConfigPathPreInstall)
      ? fs.readFileSync(codexConfigPathPreInstall)
      : null;
    const codexHooksJsonPathPreInstall = path.join(targetDir, 'hooks.json');
    const codexHooksJsonPreInstallSnapshot = fs.existsSync(codexHooksJsonPathPreInstall)
      ? fs.readFileSync(codexHooksJsonPathPreInstall)
      : null;
    const migrationTouchesHooksJson =
      !!(installerMigrationResult
        && installerMigrationResult.plan
        && Array.isArray(installerMigrationResult.plan.actions)
        && installerMigrationResult.plan.actions.some((action) => action && action.relPath === 'hooks.json'));

    // #3245 — unified idempotent rollback. Reverts ALL Codex-specific mutations:
    //   config.toml  — restore pre-install bytes (or remove if was absent)
    //   hooks.json   — restore pre-install bytes (or remove if was absent)
    //   skills/gsd-* — restore pre-existing dirs from content snapshot; remove
    //                   newly-created dirs (i.e. those not in the pre-install Set)
    //   agents/gsd-* — restore pre-existing files from content snapshot; remove
    //                   newly-created files
    //   gsd-core/VERSION — restore or remove
    //   *.tmp-*      — best-effort cleanup of installer-owned atomic-write temps
    //
    // Safe to call multiple times (idempotent): each remove/write is guarded by
    // existence checks. Safe to call before any snapshots are captured (variables
    // default to empty Set / null). Does NOT touch non-gsd-* user content.
    const restoreCodexSnapshot = () => {
      rollbackInstallerMigrations();
      // 1. config.toml
      if (codexConfigPreInstallSnapshot !== null) {
        try { fs.writeFileSync(codexConfigPathPreInstall, codexConfigPreInstallSnapshot); }
        catch (_) { /* best-effort restore — surface the original error */ }
      } else if (fs.existsSync(codexConfigPathPreInstall)) {
        try { fs.rmSync(codexConfigPathPreInstall); } catch (_) { /* best-effort */ }
      }

      // 1b. hooks.json
      // If installer migrations touched hooks.json, rollbackInstallerMigrations()
      // already restored the pre-migration file. Don't overwrite that state with
      // a post-migration snapshot.
      if (!migrationTouchesHooksJson) {
        if (codexHooksJsonPreInstallSnapshot !== null) {
          try { fs.writeFileSync(codexHooksJsonPathPreInstall, codexHooksJsonPreInstallSnapshot); }
          catch (_) { /* best-effort restore — surface the original error */ }
        } else if (fs.existsSync(codexHooksJsonPathPreInstall)) {
          try { fs.rmSync(codexHooksJsonPathPreInstall); } catch (_) { /* best-effort */ }
        }
      }

      // 2. skills/gsd-*
      //   • Dirs that pre-existed: wipe current contents, restore snapshotted files.
      //     The restore iterates the SNAPSHOT manifest (codexPreInstallSkillNames) rather
      //     than just the current filesystem so that dirs deleted during the install
      //     (copyCommandsAsCodexSkills removes pre-existing gsd-* dirs before re-writing)
      //     are restored even when they are absent from disk at rollback time (#3245 CR).
      //   • Dirs that did not pre-exist: remove entirely.
      const _rollbackSkillsDir = _resolveSkillsRootDir(runtime, targetDir, _installScopeId);
      // Pass 1 — restore snapshot entries (may be absent from disk if deleted mid-install).
      for (const skillName of codexPreInstallSkillNames) {
        const skillDirPath = path.join(_rollbackSkillsDir, skillName);
        const fileMap = codexPreInstallSkillContents.get(skillName);
        try {
          fs.rmSync(skillDirPath, { recursive: true, force: true });
          fs.mkdirSync(skillDirPath, { recursive: true });
          if (fileMap) {
            for (const [relPath, buf] of fileMap) {
              const destFile = path.join(skillDirPath, relPath);
              try {
                fs.mkdirSync(path.dirname(destFile), { recursive: true });
                fs.writeFileSync(destFile, buf);
              } catch (_) { /* best-effort file restore */ }
            }
          }
        } catch (_) { /* best-effort dir restore */ }
      }
      // Pass 2 — remove any newly-created gsd-* dirs (not in the pre-install snapshot).
      if (fs.existsSync(_rollbackSkillsDir)) {
        try {
          for (const entry of fs.readdirSync(_rollbackSkillsDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || !entry.name.startsWith('gsd-')) continue;
            if (!codexPreInstallSkillNames.has(entry.name)) {
              // New dir written this session: remove entirely.
              try { fs.rmSync(path.join(_rollbackSkillsDir, entry.name), { recursive: true, force: true }); }
              catch (_) { /* best-effort */ }
            }
          }
        } catch (_) { /* best-effort */ }
      }

      // 3. agents/gsd-*.{md,toml}
      //   • Files that pre-existed: restore bytes from content snapshot.
      //     Iterates the SNAPSHOT manifest (codexPreInstallAgentFiles) so that files
      //     deleted by the pre-copy stale-removal pass (lines 7862-7870) are restored
      //     even when absent from disk at rollback time (#3245 CR).
      //   • Files that did not pre-exist: remove.
      const _rollbackAgentsDir = path.join(targetDir, 'agents');
      // Pass 1 — restore snapshot entries (may be absent from disk if deleted mid-install).
      for (const file of codexPreInstallAgentFiles) {
        const buf = codexPreInstallAgentContents.get(file);
        if (buf !== undefined) {
          try {
            fs.mkdirSync(_rollbackAgentsDir, { recursive: true });
            fs.writeFileSync(path.join(_rollbackAgentsDir, file), buf);
          } catch (_) { /* best-effort */ }
        }
      }
      // Pass 2 — remove any newly-created gsd-* agent files (not in the pre-install snapshot).
      if (fs.existsSync(_rollbackAgentsDir)) {
        try {
          for (const file of fs.readdirSync(_rollbackAgentsDir)) {
            if (!file.startsWith('gsd-') || (!file.endsWith('.md') && !file.endsWith('.toml'))) continue;
            if (!codexPreInstallAgentFiles.has(file)) {
              // New file written this session: remove.
              try { fs.unlinkSync(path.join(_rollbackAgentsDir, file)); } catch (_) { /* best-effort */ }
            }
          }
        } catch (_) { /* best-effort */ }
      }

      // 4. gsd-core/VERSION
      const _rollbackVersionPath = path.join(targetDir, 'gsd-core', 'VERSION');
      if (codexPreInstallVersionBytes !== null) {
        try { fs.writeFileSync(_rollbackVersionPath, codexPreInstallVersionBytes); }
        catch (_) { /* best-effort */ }
      } else if (fs.existsSync(_rollbackVersionPath)) {
        try { fs.unlinkSync(_rollbackVersionPath); } catch (_) { /* best-effort */ }
      }

      // 5. Orphaned atomic-write temp files (<file>.tmp-<pid>-<n>) in targetDir.
      // These can accumulate if an atomic write fails mid-rename. Best-effort scan.
      //
      // Only delete temp files whose absolute path is in __atomicWrittenTmps —
      // the Set populated by atomicWriteFileSync for every temp this installer
      // process actually created. This scopes cleanup to installer-owned writes
      // and avoids clobbering unrelated tools' temp files that happen to match
      // the same *.tmp-<pid>-<n> suffix pattern.
      const _tmpPattern = /\.tmp-\d+-\d+$/;
      function _cleanTmpFiles(dir) {
        if (!fs.existsSync(dir)) return;
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            _cleanTmpFiles(full);
          } else if (_tmpPattern.test(entry.name) && __atomicWrittenTmps.has(full)) {
            try { fs.unlinkSync(full); } catch (_) { /* best-effort */ }
          }
        }
      }
      _cleanTmpFiles(targetDir);
    };

    let agentCount = 0;
    if (!isMinimalMode(_effectiveInstallMode)) {
      // #2834: write ~/.gsd/defaults.json (resolve_model_ids + runtime) BEFORE generating
      // agent TOMLs — installCodexConfig reads defaults.json at generation time, so on a
      // clean first install the runtime-aware model resolver must already know the runtime.
      writeNonClaudeDefaults(runtime);
      try {
        // Generate Codex config.toml and per-agent .toml files.
        agentCount = installCodexConfig(targetDir, agentsSrc, plan.sandboxTier);
      } catch (e) {
        restoreCodexSnapshot();
        throw e;
      }
      console.log(`  ${green}✓${reset} Generated config.toml with ${agentCount} agent roles`);
      console.log(`  ${green}✓${reset} Generated ${agentCount} agent .toml config files`);
      // Re-write the manifest now that .toml agent files exist on disk.
      // The initial writeManifest call (before Codex config generation) could
      // not include agents/gsd-*.toml because those files did not yet exist.
      writeManifest(targetDir, runtime, { mode: _effectiveInstallMode, scope: _installScopeId });
    } else {
      console.log(`  ${dim}↳${reset} Skipping Codex agent config generation (minimal install)`);
    }

    // Copy only the hook files that Codex actually registers via its hook configuration (#2153).
    // #772: added gsd-context-monitor.js for the new SubagentStart/Stop/PostToolUse events.
    // #2695: the parent gsd-check-update.js spawn()s gsd-check-update-worker.js, which
    //   require()s managed-hooks-registry.cjs for MANAGED_HOOKS — so all four must be
    //   installed/refreshed together for every profile, or Codex is wired to a dependency
    //   chain the same installer never delivers.
    // We deliberately do *not* copy gsd-graphify-update.sh or hooks/lib/ for Codex
    // in this change (graphify auto-update support for Codex is out of scope for #3579).
    const CODEX_HOOKS_TO_COPY = [
      'gsd-check-update.js',
      'gsd-check-update-worker.js',
      'managed-hooks-registry.cjs',
      'gsd-context-monitor.js',
    ];
    const codexHooksSrc = path.join(src, 'hooks', 'dist');
    if (fs.existsSync(codexHooksSrc)) {
      const codexHooksDest = path.join(targetDir, 'hooks');
      fs.mkdirSync(codexHooksDest, { recursive: true });
      const configDirReplacement = getConfigDirFromHome(runtime, isGlobal);
      // #2544: track whether anything was actually staged. hooks/dist existing
      // is not the same as an allowlisted file landing in it — see the marker
      // gate below.
      let codexStagedHooks = false;
      for (const entry of fs.readdirSync(codexHooksSrc)) {
        if (!CODEX_HOOKS_TO_COPY.includes(entry)) continue;
        const srcFile = path.join(codexHooksSrc, entry);
        if (!fs.statSync(srcFile).isFile()) continue;
        const destFile = path.join(codexHooksDest, entry);
        if (entry.endsWith('.js')) {
          let content = fs.readFileSync(srcFile, 'utf8');
          content = content.replace(/'\.claude'/g, configDirReplacement);
          content = content.replace(/\/\.claude\//g, `/${getDirName(runtime)}/`);
          content = content.replace(/\.claude\//g, `${getDirName(runtime)}/`);
          content = content.replace(/\{\{GSD_VERSION\}\}/g, pkg.version);
          fs.writeFileSync(destFile, content);
          try { fs.chmodSync(destFile, 0o755); } catch (e) { /* Windows */ }
        } else if (entry.endsWith('.sh')) {
          // #2136: any .sh hook reaching this loop must have {{GSD_VERSION}}
          // stamped so installed scripts carry a concrete version header and
          // stale-hook detection keeps working across upgrades. The current
          // CODEX_HOOKS_TO_COPY allowlist excludes .sh files, so this branch
          // is defensive — it preserves the invariant if the allowlist is
          // extended later (e.g. to ship gsd-graphify-update.sh for Codex).
          let content = fs.readFileSync(srcFile, 'utf8');
          content = content.replace(/\{\{GSD_VERSION\}\}/g, pkg.version);
          fs.writeFileSync(destFile, content);
          try { fs.chmodSync(destFile, 0o755); } catch (e) { /* Windows */ }
        } else {
          // #2695: raw byte-for-byte copy for allowlisted artifacts that carry
          // no {{GSD_VERSION}} placeholder and no runtime path token (e.g.
          // managed-hooks-registry.cjs, whose only `.claude` mention is inside a
          // doc comment). Version/path transforms would be a no-op at best and a
          // surprise at worst; the issue requires the registry copied verbatim.
          fs.copyFileSync(srcFile, destFile);
          try { fs.chmodSync(destFile, 0o755); } catch (e) { /* Windows */ }
        }
        codexStagedHooks = true;
      }
      console.log(`  ${green}✓${reset} Installed hooks (Codex)`);
      // #2717: write the CommonJS marker into hooks/ alongside the staged .js
      // scripts. Codex is excluded from installSharedHooksBundle by the
      // !isCodex gate, so it never received the marker the shared-bundle path
      // writes for the other runtimes. Without it, a ~/.codex/package.json
      // declaring {"type":"module"} makes Node load gsd-check-update.js /
      // gsd-context-monitor.js as ESM and their require() calls fail silently.
      // Reuses the same helper the Cursor/Windsurf writers call so the marker
      // content + user-file-preservation contract is identical everywhere.
      //
      // #2544: gated on codexStagedHooks, mirroring installSharedHooksBundle's
      // `stagedHooks`. The enclosing guard only proves hooks/dist EXISTS; if it
      // holds none of CODEX_HOOKS_TO_COPY, this block mkdirs hooks/ and stages
      // nothing, and an ungated marker would claim a directory GSD did not fill.
      if (codexStagedHooks && hooksSurface.ensureCommonJsMarker(codexHooksDest)) {
        console.log(`  ${green}✓${reset} Wrote hooks/package.json (CommonJS mode)`);
      }
    }

    // Add Codex hooks (SessionStart for update checking) — requires codex_hooks feature flag
    const configPath = path.join(targetDir, 'config.toml');
    // Use the pre-install snapshot captured before installCodexConfig ran so
    // restore returns the file to its true pre-GSD state on validation
    // failure (#2760 fix 3) — not to the post-agent-merge state.
    const preWriteBackup = codexConfigPreInstallSnapshot;
    try {
      let configContent = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : '';
      const eol = detectLineEnding(configContent);

      // Strip ALL prior GSD-managed hook blocks BEFORE migration so the migration
      // only touches user-authored hooks, not GSD-owned stale entries. Running
      // strip after migration causes Shape 1 (legacy gsd-update-check filename)
      // to be converted by migration before the strip regex can match it (#2698).
      //
      // Historical shapes stripped, in order:
      //   Shape 1 — legacy gsd-update-check filename (pre-#1755): flat [[hooks]] + event
      //   Shape 2 — flat [[hooks]] + event = "SessionStart" (#2637 era, never correct)
      //   Shape 4 — correct two-block nested (strip before shape 3 to avoid orphaned header)
      //   Shape 3 — single-block [[hooks.SessionStart]] without nested .hooks (#2760 era)
      configContent = stripStaleGsdHookBlocks(configContent);

      // Migrate legacy [hooks] map format and flat [[hooks]] AoT entries to the
      // namespaced [[hooks.<EVENT>]] form after stripping GSD-managed stale blocks.
      // Running migration after strip ensures only user-authored hooks are migrated
      // (#2698 regression: migration before strip converts stale GSD blocks before
      // the strip regexes can match their original shape).
      const migratedContent = migrateCodexHooksMapFormat(configContent);
      if (migratedContent !== configContent) {
        configContent = migratedContent;
        console.log(`  ${green}✓${reset} Migrated legacy Codex [hooks] format to two-level nested AoT`);
      }

      const codexHooksFeature = ensureCodexHooksFeature(configContent);
      configContent = setManagedCodexHooksOwnership(codexHooksFeature.content, codexHooksFeature.ownership);

      // GSD-managed Codex hook payloads now live in hooks.json to avoid mixed
      // representation warnings when a single layer contains both hooks.json
      // and inline [hooks] entries. Keep config.toml focused on feature flags
      // and agent metadata.
      const codexNodeRunner = resolveNodeRunner();

      // #2760 fix 3 — post-write schema validation. Parse the bytes we are
      // about to commit and assert they match Codex's expected shape. If
      // validation fails we restore the pre-install backup and abort so the
      // user is never left with a Codex CLI that won't load.
      // Test seam: tests can inject `__codexSchemaValidator` to force the
      // validator to fail and exercise the restore-and-abort path.
      const validatorFn = (typeof module !== 'undefined' && module.exports && module.exports.__codexSchemaValidator)
        ? module.exports.__codexSchemaValidator
        : validateCodexConfigSchema;
      const validation = validatorFn(configContent);
      if (!validation.ok) {
        restoreCodexSnapshot();
        throw new Error(
          `post-write Codex schema validation failed: ${validation.reason}. ` +
          `Restored ${preWriteBackup !== null ? 'pre-install backup' : 'empty state'}.`
        );
      }

      // Atomic write (#2760 fix 4) — write to a sibling temp file, then
      // renameSync over the target. A mid-write failure cannot truncate the
      // existing config; the snapshot restore below is a second line of
      // defense if even the rename fails.
      try {
        atomicWriteFileSync(configPath, configContent, 'utf-8');
      } catch (writeErr) {
        // #2760 CR4 finding 1 — write failure must be loud and fatal. Wrap
        // with a `post-write` prefix the outer catch recognises so install
        // aborts with a clear error rather than warn-and-continue (which
        // produced "Done!" with no Codex agents configured).
        restoreCodexSnapshot();
        const wrapped = new Error(
          `post-write Codex install failed: ${writeErr && writeErr.message ? writeErr.message : String(writeErr)}. ` +
          `Restored ${preWriteBackup !== null ? 'pre-install backup' : 'empty state'}.`
        );
        throw wrapped;
      }
      if (hasEnabledCodexHooksFeature(configContent)) {
        const checkUpdateFile = path.join(targetDir, 'hooks', 'gsd-check-update.js');
        if (!fs.existsSync(checkUpdateFile)) {
          console.warn(`  ${yellow}⚠${reset}  Skipped Codex SessionStart hook registration — gsd-check-update.js not found at target`);
        } else if (!codexNodeRunner) {
          console.warn(`  ${yellow}⚠${reset}  Skipping Codex SessionStart hook registration — Node executable path unavailable (process.execPath is empty). See #2979 / #3002 / #3017.`);
        } else {
          const hookWrite = ensureCodexHooksJsonSessionStart(targetDir, {
            absoluteRunner: codexNodeRunner,
            platform: process.platform,
          });
          if (hookWrite.wrote) {
            console.log(`  ${green}✓${reset} Configured Codex hooks (SessionStart via hooks.json)`);
          } else {
            console.log(`  ${green}✓${reset} Verified Codex hooks (SessionStart via hooks.json)`);
          }
        }

        // ── Codex extended hook events (#772, #2088) ─────────────────────────
        // Codex CLI stabilised a full hook-event set in rust-v0.137.0. GSD
        // registers CODEX_EXTENDED_HOOK_EVENTS (#2088 adds the 6 documented
        // events beyond the original #772 three) — all routed through
        // gsd-context-monitor.js so context-headroom warnings surface at each
        // lifecycle point: SubagentStart/SubagentStop (subagent open/close),
        // Stop (final-response), PreToolUse/PostToolUse (tool boundaries),
        // PermissionRequest (approval prompts), Pre/PostCompact (context
        // compaction), and UserPromptSubmit (per-turn context injection). The
        // context-monitor script decides per-payload what to do; unregistered
        // events simply never fire.
        //
        // Guard: only register when the context-monitor file exists and the node
        // runner is available — same guards as the SessionStart path above.
        const contextMonitorFile = path.join(targetDir, 'hooks', 'gsd-context-monitor.js');
        if (codexNodeRunner && fs.existsSync(contextMonitorFile)) {
          for (const codexEvent of CODEX_EXTENDED_HOOK_EVENTS) {
            const eventWrite = ensureCodexHooksJsonEvent(targetDir, codexEvent, {
              absoluteRunner: codexNodeRunner,
              platform: process.platform,
            });
            if (eventWrite.wrote) {
              console.log(`  ${green}✓${reset} Configured Codex hooks (${codexEvent} via hooks.json)`);
            } else if (eventWrite.changed) {
              console.log(`  ${green}✓${reset} Verified Codex hooks (${codexEvent} via hooks.json)`);
            }
          }
        } else if (!codexNodeRunner) {
          console.warn(`  ${yellow}⚠${reset}  Skipped Codex extended hook-event registration — Node runner unavailable.`);
        }
        // ── end Codex extended hook events ────────────────────────────────────
      }
    } catch (e) {
      // #2760 — schema-validation and write failures must be loud and fatal
      // so the user is never left with a config Codex refuses to load (or no
      // Codex agents configured at all). The pre-install snapshot restore has
      // already run for write-side throws via the inner catch above and via
      // restoreCodexSnapshot in the validation branch.
      if (e && typeof e.message === 'string' && e.message.startsWith('post-write')) {
        console.error(`  ${red}✗${reset} ${e.message}`);
        throw e;
      }
      // #2760 CR5 finding 1 — pre-write failures (migrateCodexHooksMapFormat,
      // ensureCodexHooksFeature, config reads, configContent construction,
      // etc.) must ALSO be fatal. Previously this branch downgraded to a
      // console.warn, leaving the install to print "Done!" with no Codex
      // hooks configured — same defect class as finding 1, different layer.
      // Restore the pre-install snapshot and rethrow so the outer install
      // pipeline aborts.
      restoreCodexSnapshot();
      const wrapped = new Error(
        `Codex hook configuration failed (pre-write): ${e && e.message ? e.message : String(e)}. ` +
          `Restored ${preWriteBackup !== null ? 'pre-install backup' : 'empty state'}.`
      );
      console.error(`  ${red}✗${reset} ${wrapped.message}`);
      throw wrapped;
    }

    persistActiveProfileMarker();
    return { settingsPath: null, settings: null, statuslineCommand: null, updateBannerCommand: null, runtime, configDir: targetDir };
  }

  if (plan.installSurface === 'copilot-instructions') {
    // Generate copilot-instructions.md
    const templatePath = path.join(targetDir, 'gsd-core', 'templates', 'copilot-instructions.md');
    const instructionsPath = path.join(targetDir, 'copilot-instructions.md');
    if (fs.existsSync(templatePath)) {
      const template = fs.readFileSync(templatePath, 'utf8');
      mergeCopilotInstructions(instructionsPath, template);
      console.log(`  ${green}✓${reset} Generated copilot-instructions.md`);
      // #786: also emit AGENTS.md, which Copilot CLI reads as primary
      // instructions from the repository root. AGENTS.md is a repo-root concept
      // (no documented user-scope home), so emit it only for local installs;
      // global scope is already covered by ~/.copilot/copilot-instructions.md.
      if (!isGlobal) {
        const agentsMdPath = path.join(process.cwd(), 'AGENTS.md');
        mergeCopilotInstructions(agentsMdPath, template);
        console.log(`  ${green}✓${reset} Generated AGENTS.md`);
      }
    }
    // #786: emit a self-contained Copilot lifecycle hook (sessionStart). Copilot
    // command hooks run inline bash/powershell, so this needs no separate hook
    // script and cannot dangle. Repo scope → .github/hooks/, user → ~/.copilot/hooks/.
    // The hook is a required install artifact, so a write failure is fatal (it
    // propagates) rather than silently producing a "successful" install missing
    // the feature.
    writeCopilotHookConfig(targetDir);
    console.log(`  ${green}✓${reset} Configured Copilot lifecycle hook (sessionStart)`);
    persistActiveProfileMarker();
    return { settingsPath: null, settings: null, statuslineCommand: null, updateBannerCommand: null, runtime, configDir: targetDir };
  }

  if (plan.installSurface === 'cursor-hooks-json') {
    // ADR-1239 / #2089: Cursor hooks.json driven by the descriptor-managed hook-bus
    // adapter. Registers all 6 managed events (sessionStart, postToolUse, preToolUse,
    // stop, subagentStart, subagentStop) via runtime-hooks-surface.cts, which reads
    // the event list from the descriptor-driven adapter module.
    const cursorHookResult = writeCursorHooksJson(targetDir, src, {
      managedHookEvents: _hostBehaviors(runtime).managedHookEvents,
    });
    if (cursorHookResult.changed) {
      console.log(`  ${green}✓${reset} Configured Cursor lifecycle hooks (sessionStart, postToolUse, preToolUse, stop, subagentStart, subagentStop)`);
    } else {
      console.log(`  ${green}✓${reset} Cursor lifecycle hooks already up to date`);
    }
    // Re-run the manifest pass to capture any files the hooks-json write path
    // produced. NOTE: hooks.json and the gsd-cursor-*.js scripts are NOT
    // manifest-tracked (verified) — uninstall removes them explicitly via
    // removeCursorHooksJson + its script list, and reconcile is idempotent.
    // The re-run is retained for parity with the settings.json install path.
    writeManifest(targetDir, runtime, { mode: _effectiveInstallMode, scope: _installScopeId });
    persistActiveProfileMarker();
    return { settingsPath: null, settings: null, statuslineCommand: null, updateBannerCommand: null, runtime, configDir: targetDir };
  }

  if (plan.installSurface === 'profile-marker-only') {
    // Windsurf/Trae use artifact-only surfaces — no config.toml or settings.json
    // hooks needed. Kimi is also artifact-only for its INSTALL surface (skills +
    // kimi-agents, no settings.json) but #2095 Upgrade 1 gives it its own
    // independent hooksSurface: kimi's native config.toml [[hooks]] array, which
    // lives outside targetDir entirely (resolveKimiHooksTomlDir resolves the
    // per-runtime root — ~/.kimi for kimi, ~/.kimi-code for kimi-code, #2755 —
    // a sibling of targetDir's ~/.config/agents) — hence writing it here, inside
    // this early-return, rather than requiring installSurface to change.
    //
    // GATED TO GLOBAL ONLY (belt-and-suspenders): kimi local installs already
    // return early at the top of install() via hostBehaviors.localInstallDeferred,
    // long before this point is ever reached — so `isGlobal` is always true here
    // in practice. The explicit check documents that invariant and fails closed
    // if that early-return is ever refactored away.
    //
    // Kimi's contract forbids hooks/ or package.json under its generic
    // Agent-Skills configDir (targetDir) — capabilities/kimi/capability.json
    // declares hostBehaviors.skipSharedHooksInstall:true, which excludes it from
    // the shared installSharedHooksBundle(targetDir) call above. Kimi still needs
    // those SAME hook scripts + the CommonJS package.json marker, but SELF-
    // CONTAINED under its own native hook root instead — so install them there,
    // and point buildHookCommand (via writeKimiHooksToml's second arg) at that
    // same root so the generated [[hooks]] command paths reference
    // ~/.kimi/hooks/<script> rather than a script that doesn't exist under
    // targetDir/hooks (which kimi no longer receives).
    if (plan.hooksSurface === 'kimi-hooks-toml' && isGlobal) {
      const kimiHooksRoot = resolveKimiHooksTomlDir({ runtime });
      // Note: the `failures` array's hard-fail gate (`if (failures.length > 0)
      // process.exit(1)`) runs earlier in this function, before this
      // profile-marker-only branch is ever reached — pushing to it here would
      // be silently ineffective. Warn instead; a failed hooks copy still
      // leaves kimi's skills/agents artifacts installed correctly.
      if (!installSharedHooksBundle(kimiHooksRoot)) {
        console.warn(`  ${yellow}⚠${reset}  Kimi hook bundle did not verify at ${path.join(kimiHooksRoot, 'hooks')} — GSD lifecycle hooks may be incomplete`);
      }
      // #2544: retire the pre-fix marker at kimi's root. installSharedHooksBundle
      // used to write {"type":"commonjs"} at destRootDir itself; it now writes it
      // under destRootDir/hooks/, so on an upgrade the old root file is stale and
      // would keep ~/.kimi pinned to CommonJS.
      //
      // Done HERE rather than in installer-migration 007 (which retires the same
      // stale marker for every other runtime) because kimi's hook root is
      // the per-runtime Kimi root — resolved by resolveKimiHooksTomlDir, OUTSIDE the configDir.
      // Migration relPaths are structurally confined to configDir, so the
      // framework cannot address this path at all. Same exact-content predicate
      // either way, so a user-authored ~/.kimi/package.json is never touched.
      if (removeCommonJsMarker(kimiHooksRoot)) {
        console.log(`  ${green}✓${reset} Removed stale package.json from ${kimiHooksRoot} (pre-#2544 marker)`);
      }
      const kimiHookOpts = { portableHooks: hasPortableHooks, runtime };
      const kimiHooksTomlPath = path.join(kimiHooksRoot, 'config.toml');
      const kimiHooksResult = writeKimiHooksToml(kimiHooksTomlPath, kimiHooksRoot, { hookOpts: kimiHookOpts });
      if (kimiHooksResult.changed) {
        console.log(`  ${green}✓${reset} Configured ${kimiHooksResult.entryCount} GSD hook(s) in ${kimiHooksTomlPath}`);
      }

      // #3031: opt-in reclaim of the pre-#2755 legacy root. Runs LAST in this
      // branch so the kimi-code install above is already complete and durable —
      // a reclaim can only ever remove, never leave the install half-written.
      //
      // Gated on `runtime === 'kimi-code'`: a `--kimi` install resolves this
      // very same `~/.kimi` as its own hooks root, so reclaiming there would
      // delete the hooks it just wrote. The flag is silently inert for kimi
      // rather than an error — `--all` passes every runtime through this branch,
      // and one opt-in flag must not fail an otherwise valid multi-runtime run.
      //
      // ALSO gated on kimi NOT being installed by this same invocation. The
      // flag asserts "I only use Kimi Code"; `--all`, or an explicit `--kimi
      // --kimi-code`, falsifies that outright. Both orderings put `kimi` BEFORE
      // `kimi-code` (selectRuntimesFromArgs), so without this guard the run
      // installs Kimi CLI's hooks and then deletes them moments later — the run
      // reports success and the user is left with the very breakage the opt-in
      // exists to prevent. Verified reproducible before this guard existed.
      const kimiInstalledThisRun = selectedRuntimes.includes('kimi');
      if (hasReclaimKimiLegacy && runtime === 'kimi-code' && kimiInstalledThisRun) {
        console.log(`  ${dim}•${reset} Skipped --reclaim-kimi-legacy: this run also installs --kimi, so ${resolveKimiHooksTomlDir({ runtime: 'kimi' })} is a live Kimi CLI install`);
      } else if (hasReclaimKimiLegacy && runtime === 'kimi-code') {
        const legacyKimiRoot = resolveKimiHooksTomlDir({ runtime: 'kimi' });
        // Both roots honor their own env override (KIMI_SHARE_DIR /
        // KIMI_CODE_HOME). A user who points both at ONE directory collapses
        // "the legacy root" onto "the root this install just wrote", and an
        // unguarded reclaim would delete its own output. isSameDirectory compares
        // the DIRECTORIES, not the strings — case-insensitive filesystems and
        // symlinked aliases both name one dir with two spellings.
        if (isSameDirectory(legacyKimiRoot, kimiHooksRoot)) {
          console.log(`  ${dim}•${reset} Skipped --reclaim-kimi-legacy: ${legacyKimiRoot} is this install's own hooks root`);
        } else {
          const reclaimed = reclaimKimiHooksRoot(legacyKimiRoot);
          console.log(reclaimed > 0
            ? `  ${green}✓${reset} Reclaimed ${reclaimed} orphaned GSD artifact group(s) from ${legacyKimiRoot} (pre-#2755)`
            : `  ${dim}•${reset} No orphaned GSD artifacts found in ${legacyKimiRoot}`);
        }
      }
    }

    // ADR-1239 / #2100 Stage 2: Windsurf's own independent hooksSurface —
    // Cascade's native hooks.json blocking hook bus (pre_write_code,
    // pre_run_command), wired via runtime-hooks-surface.cts exactly like
    // Cursor's writeCursorHooksJson but with Cascade's exit-code-2 blocking
    // protocol instead of Cursor's stdout-JSON form. Unlike kimi's branch
    // above, this is NOT gated to `isGlobal` — Windsurf has no
    // hostBehaviors.localInstallDeferred early-return, so both local
    // (.windsurf/hooks.json) and global (~/.codeium/windsurf/hooks.json)
    // installs reach this branch and must get the hook bus wired.
    if (plan.hooksSurface === 'windsurf-hooks-json') {
      const windsurfHookResult = writeWindsurfHooksJson(targetDir, src, {
        platform: process.platform,
      });
      if (windsurfHookResult.changed) {
        console.log(`  ${green}✓${reset} Configured Windsurf lifecycle hooks (pre_write_code, pre_run_command)`);
      } else {
        console.log(`  ${green}✓${reset} Windsurf lifecycle hooks already up to date`);
      }
      // Re-run the manifest pass, mirroring the cursor writer's pattern above
      // for parity. This does NOT hash-track hooks.json or the
      // gsd-windsurf-*.js scripts (same as cursor): uninstall removes them
      // explicitly via removeWindsurfHooksJson, and reconcileWindsurfHooksJson
      // is idempotent on repeated installs, so manifest tracking isn't needed
      // for correctness here.
      writeManifest(targetDir, runtime, { mode: _effectiveInstallMode, scope: _installScopeId });
    }

    persistActiveProfileMarker();
    return { settingsPath: null, settings: null, statuslineCommand: null, updateBannerCommand: null, runtime, configDir: targetDir };
  }

  if (plan.installSurface === 'cline-rules') {
    // Cline uses the `.clinerules/` directory form (issue #787): GSD rules live
    // at .clinerules/gsd.md and a PreToolUse lifecycle hook at
    // .clinerules/hooks/PreToolUse. Global installs also get ~/.agents/AGENTS.md.
    writeClineArtifacts(targetDir, isGlobal);
    // Re-run the manifest pass: these artifacts are written *after* the earlier
    // writeManifest() call, so a second pass is needed to hash-track them.
    writeManifest(targetDir, runtime, { mode: _effectiveInstallMode, scope: _installScopeId });
    persistActiveProfileMarker();
    return { settingsPath: null, settings: null, statuslineCommand: null, updateBannerCommand: null, runtime, configDir: targetDir };
  }

  // Configure statusline and hooks in settings.json (or settings.local.json for local Claude installs).
  // ADR-857 phase 5f-2: drive the hook event dialect from the registry descriptor.
  // runtimes with hookEvents='gemini' use AfterTool/BeforeTool; all others use PostToolUse/PreToolUse.
  // Equivalence: hookEvents='gemini' iff runtime===antigravity — identical to the old check.
  // A missing registry or missing descriptor defaults to 'not gemini' → PostToolUse (safe).
  const _hookEventsDialect = plan.hookEvents;
  const postToolEvent = _hookEventsDialect === 'gemini' ? 'AfterTool' : 'PostToolUse';
  // #338: local Claude installs write to settings.local.json (Claude Code's per-user/gitignored slot)
  // so engineer-specific absolute paths (Node binary, home dir) never land in the repo-shared
  // settings.json. Global installs and all other runtimes continue to use settings.json.
  // #2870: the CURRENT scope's settings filename is sourced from the Install
  // Scope Module (_installScope.settingsFile, resolveScope's per-scope field)
  // instead of indexing _scopedSettings by hand. _scopedSettings itself is
  // retained unchanged as the #338-privacy fail-safe path: _hostBehaviors
  // already degrades to FALLBACK_HOST_BEHAVIORS (see that constant's comment
  // above) when the registry fails to load, whereas resolveScope's registry
  // lookup throws in that same scenario (_installScope is null when it did).
  // Falling back to _scopedSettings[_installScopeId] there — and keeping the
  // non-local-claude branch's expression untouched — means this is
  // byte-identical to the pre-migration computation in every case, including
  // the broken-registry fail-safe floor.
  const _scopedSettings = _hostBehaviors(runtime).settingsFileByScope || null;
  const _currentScopeSettingsFile = _installScope
    ? _installScope.settingsFile
    : (_scopedSettings ? (_scopedSettings[_installScopeId] ?? null) : null);
  const isLocalClaude = (!isGlobal && !!_currentScopeSettingsFile);
  const settingsFileName = isLocalClaude
    ? _currentScopeSettingsFile
    : ((_scopedSettings && _scopedSettings.global) || 'settings.json');
  // ADR-1239 Phase B write-confinement: the descriptor-sourced settings filename
  // must resolve under targetDir (this path also drives a recursive mkdirSync).
  const settingsPath = assertDestWithinConfigHome(targetDir, settingsFileName);

  // #338 migration: if a prior local Claude install wrote GSD-shaped entries to settings.json,
  // relocate them to settings.local.json and clear them from the shared file in the same run.
  if (isLocalClaude) {
    const sharedSettingsPath = path.join(targetDir, 'settings.json');
    const sharedRaw = readSettings(sharedSettingsPath);
    if (sharedRaw && typeof sharedRaw === 'object') {
      const hasGsdHooks = sharedRaw.hooks && Object.values(sharedRaw.hooks).some(
        entries => Array.isArray(entries) && entries.some(
          entry => entry && entry.hooks && Array.isArray(entry.hooks) && entry.hooks.some(
            h => h && typeof h.command === 'string' && isManagedHookCommand(h.command, { surface: 'settings-json' })
          )
        )
      );
      const hasGsdStatusline = sharedRaw.statusLine && sharedRaw.statusLine.command &&
        isManagedHookCommand(sharedRaw.statusLine.command, { surface: 'settings-json' });
      if (hasGsdHooks || hasGsdStatusline) {
        // Merge GSD entries into settings.local.json
        const localRaw = readSettings(settingsPath) || {};
        if (hasGsdStatusline && !localRaw.statusLine) {
          localRaw.statusLine = sharedRaw.statusLine;
        }
        if (hasGsdHooks) {
          if (!localRaw.hooks) localRaw.hooks = {};
          for (const [eventName, entries] of Object.entries(sharedRaw.hooks || {})) {
            if (!Array.isArray(entries)) continue;
            const gsdEntries = entries.filter(
              entry => entry && entry.hooks && Array.isArray(entry.hooks) && entry.hooks.some(
                h => h && typeof h.command === 'string' && isManagedHookCommand(h.command, { surface: 'settings-json' })
              )
            );
            if (gsdEntries.length > 0) {
              if (!localRaw.hooks[eventName]) localRaw.hooks[eventName] = [];
              // Only merge entries not already present in local
              for (const entry of gsdEntries) {
                const alreadyPresent = localRaw.hooks[eventName].some(
                  le => le && le.hooks && Array.isArray(le.hooks) && le.hooks.some(
                    lh => lh && entry.hooks.some(eh => eh && eh.command === lh.command)
                  )
                );
                if (!alreadyPresent) localRaw.hooks[eventName].push(entry);
              }
            }
          }
        }
        fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
        writeSettings(settingsPath, localRaw);

        // Remove GSD entries from shared settings.json
        if (hasGsdStatusline) {
          delete sharedRaw.statusLine;
        }
        if (hasGsdHooks) {
          for (const [eventName, entries] of Object.entries(sharedRaw.hooks || {})) {
            if (!Array.isArray(entries)) continue;
            sharedRaw.hooks[eventName] = entries.filter(
              entry => !(entry && entry.hooks && Array.isArray(entry.hooks) && entry.hooks.some(
                h => h && typeof h.command === 'string' && isManagedHookCommand(h.command, { surface: 'settings-json' })
              ))
            );
            if (sharedRaw.hooks[eventName].length === 0) {
              delete sharedRaw.hooks[eventName];
            }
          }
          if (sharedRaw.hooks && Object.keys(sharedRaw.hooks).length === 0) {
            delete sharedRaw.hooks;
          }
        }
        writeSettings(sharedSettingsPath, sharedRaw);
        console.log(`  ${green}✓${reset} Migrated GSD hook entries from settings.json to settings.local.json (#338)`);
      }
    }
  }

  const rawSettings = readSettings(settingsPath);
  if (rawSettings === null) {
    console.log('  ' + yellow + 'i' + reset + '  Skipping settings.local.json configuration — file could not be parsed (comments or malformed JSON). Your existing settings are preserved.');
    persistActiveProfileMarker();
    return;
  }
  const settings = validateHookFields(cleanupOrphanedHooks(rawSettings));
  // #3002 CR / #3662: rewrite legacy `node .../gsd-*.js` command strings (pre-
  // #2979 installs) AND entries baked with another environment's absolute node
  // path onto the runtime-resolving runner. Without this, existing managed
  // hook entries stay bare-`node`-prefixed or foreign-absolute across
  // reinstalls and remain broken under GUI/minimal-PATH runtimes and shared
  // config roots — the #3662 mixed state where no environment can run all
  // hooks.
  const settingsRunner = buildNodeRunnerChainToken();
  if (settingsRunner && rewriteLegacyManagedNodeHookCommands(settings, settingsRunner, { platform: process.platform, runtime })) {
    console.log(`  ${green}✓${reset} Rewrote legacy managed-hook commands to the runtime-resolving node runner (#2979/#3662)`);
  }
  // Local installs anchor hook paths so they resolve regardless of cwd (#1906).
  // Claude Code sets $CLAUDE_PROJECT_DIR; Antigravity does not — and on
  // Windows its own substitution logic doubles the path (#2557). It runs
  // project hooks with the project dir as cwd, so bare relative paths work.
  // Descriptor-driven (ADR-1239 / #2096): hookPathStyle comes from the
  // runtime's hostBehaviors instead of a hardcoded `runtime === 'antigravity'`
  // check inside projectLocalHookPrefix.
  const localPrefix = projectLocalHookPrefix({ runtime, dirName, hookPathStyle: _hostBehaviors(runtime).hookPathStyle });
  const hookOpts = { portableHooks: hasPortableHooks, runtime };
  // #2979: local-install hook commands also use a runner GUI/minimal-PATH
  // runtimes can resolve. Bare `node` fails when the host launches the
  // runtime with a stripped PATH (Finder/Antigravity/etc) — #3662 replaces
  // the baked absolute path with the runtime-resolving chain (baked path
  // first, so the minimal-PATH guarantee is unchanged).
  const localNodeRunner = buildNodeRunnerChainToken();
  const localBashRunner = resolveBashRunner({ platform: process.platform });
  // If we cannot resolve a node runner AND this is a local install,
  // skip managed-hook registration. Returning null from buildHookCommand on
  // global installs has the same effect. Better to skip than to emit a bare
  // `node` command that recreates the #2979 failure.
  const localCmd = (hookFile) => localNodeRunner === null
    ? null
    : projectShellCommandText({
      runnerToken: localNodeRunner,
      argTokens: [`${localPrefix}/hooks/${hookFile}`],
      runtime,
      platform: process.platform,
    });
  const localShellCmd = (hookFile) => buildLocalShellHookCommand({
    localPrefix,
    hookFile,
    bashRunner: localBashRunner,
    runtime,
    platform: process.platform,
  });
  const statuslineCommand = isGlobal
    ? buildHookCommand(targetDir, 'gsd-statusline.js', hookOpts)
    : localCmd('gsd-statusline.js');
  const updateCheckCommand = isGlobal
    ? buildHookCommand(targetDir, 'gsd-check-update.js', hookOpts)
    : localCmd('gsd-check-update.js');
  const contextMonitorCommand = isGlobal
    ? buildHookCommand(targetDir, 'gsd-context-monitor.js', hookOpts)
    : localCmd('gsd-context-monitor.js');
  const promptGuardCommand = isGlobal
    ? buildHookCommand(targetDir, 'gsd-prompt-guard.js', hookOpts)
    : localCmd('gsd-prompt-guard.js');
  const readGuardCommand = isGlobal
    ? buildHookCommand(targetDir, 'gsd-read-guard.js', hookOpts)
    : localCmd('gsd-read-guard.js');
  const readInjectionScannerCommand = isGlobal
    ? buildHookCommand(targetDir, 'gsd-read-injection-scanner.js', hookOpts)
    : localCmd('gsd-read-injection-scanner.js');
  const configReloadCommand = isGlobal
    ? buildHookCommand(targetDir, 'gsd-config-reload.js', hookOpts)
    : localCmd('gsd-config-reload.js');

  // #3002 CR: when resolveNodeRunner() returns null, every dependent JS-hook
  // command is null too. Emit one warning here so the operator sees the cause
  // ONCE instead of per-hook. Each registration site below also guards on its
  // own *Command variable being truthy, so we never write `command: null`
  // entries to settings.json (which the runtime's hook schema would reject).
  const anyJsHookCommandNull = !statuslineCommand
    || !updateCheckCommand
    || !contextMonitorCommand
    || !promptGuardCommand
    || !readGuardCommand
    || !readInjectionScannerCommand;
  if (anyJsHookCommandNull) {
    console.warn(`  ${yellow}⚠${reset}  Skipping managed JS hook registration — Node executable path unavailable (process.execPath is empty). See #2979 / #3002.`);
  }

  // Register all GSD-managed hook entries into settings.hooks.* for runtimes
  // that use the settings.json hook surface (ADR-857 phase 5f-1b).
  // settings is mutated in place by applySettingsJsonHooks.
  applySettingsJsonHooks(settings, {
    runtime,
    isGlobal,
    targetDir,
    postToolEvent,
    hookEvents: _hookEventsDialect,
    extendedHookEvents: plan.extendedHookEvents,
    hooksSurface: plan.hooksSurface,
    updateCheckCommand,
    contextMonitorCommand,
    promptGuardCommand,
    readGuardCommand,
    readInjectionScannerCommand,
    configReloadCommand,
    hookOpts,
    localCmd,
    localShellCmd,
  });

  // Compute the update-banner hook command alongside the others so
  // installAllRuntimes can register it at finalize time when the user opts
  // in (#2795). Computed here (not in finishInstall) so the same buildHookCommand
  // / localCmd resolution logic is shared with the other JS hooks.
  const updateBannerCommand = _hostBehaviors(runtime).skipUpdateBannerCommand
    ? null
    : (isGlobal
      ? buildHookCommand(targetDir, 'gsd-update-banner.js', hookOpts)
      : localCmd('gsd-update-banner.js'));

  // #683: Set worktree.baseRef:"head" in settings.local.json for local Claude installs.
  // Both fresh and upgrade paths apply only when worktrees are enabled for the project.
  // Never applies to global installs, non-Claude runtimes, or when the user already
  // has an explicit baseRef in EITHER settings.local.json OR settings.json (no-clobber).
  // Guard: skip entirely when settings is not a plain object (e.g. parsed to [] or primitive)
  // to avoid crashing applyWorktreeBaseRef on unexpected top-level shapes.
  if (isLocalClaude && settings !== null && typeof settings === 'object' && !Array.isArray(settings)) {
    // Read shared settings.json baseRef so no-clobber spans both files (#683 FIX 1).
    // shared settings.json no-clobber is checked here; settings.local.json no-clobber
    // is enforced inside applyWorktreeBaseRef itself.
    const sharedSettingsForBaseRef = readSettings(path.join(targetDir, 'settings.json')) || {};
    const sharedBaseRef = readBaseRefFromSettings(sharedSettingsForBaseRef);

    // Compute worktrees-enabled ONCE for both fresh and upgrade paths (FIX A: DRY + consistency).
    // Read workflow.use_worktrees from .planning/config.json by walking up from
    // targetDir (same walk-up pattern as readGsdRuntimeProfileResolver). Defaults
    // to enabled (true) when the file is missing, unreadable, or the key is absent;
    // only boolean false disables (string "false" stays enabled).
    let worktreesEnabled = true; // default: enabled
    try {
      let probeDir = path.resolve(targetDir);
      for (let depth = 0; depth < 8; depth += 1) {
        const candidate = path.join(probeDir, '.planning', 'config.json');
        if (fs.existsSync(candidate)) {
          try {
            const parsed = JSON.parse(stripJsonComments(fs.readFileSync(candidate, 'utf-8')));
            if (parsed && typeof parsed === 'object' &&
                parsed.workflow && parsed.workflow.use_worktrees === false) {
              worktreesEnabled = false;
            }
          } catch {
            // Malformed config.json — treat as enabled (safe fallback).
          }
          break;
        }
        const parent = path.dirname(probeDir);
        if (parent === probeDir) break;
        probeDir = parent;
      }
    } catch {
      // Any unexpected error reading .planning — default to enabled.
    }

    if (worktreesEnabled && sharedBaseRef === null) {
      if (!priorInstallExisted) {
        // Fresh install — apply no-clobber baseRef set.
        // canonical no-clobber logic: src/worktree-base-ref.cts applyWorktreeBaseRef (#683)
        const { changed } = applyWorktreeBaseRef(settings);
        if (changed) {
          console.log(`  ${green}✓${reset} Set worktree.baseRef:"head" for Claude Code worktrees (forks phase worktrees off HEAD; #683)`);
        }
      } else {
        // Upgrade — auto-apply no-clobber baseRef set when worktrees are enabled.
        const { changed } = applyWorktreeBaseRef(settings);
        if (changed) {
          console.log(`  ${green}✓${reset} Enabled worktree.baseRef:"head" for Claude Code worktrees (forks phase worktrees off HEAD; #683)`);
        }
      }
    }
    // When worktreesEnabled is false: do nothing, print nothing (both fresh and upgrade).
  }

  persistActiveProfileMarker();
  return {
    settingsPath,
    settings,
    statuslineCommand,
    updateBannerCommand,
    runtime,
    configDir: targetDir,
    rollbackInstallerMigrations,
  };
}

/**
 * Apply statusline config, then print completion message
 */
function finishInstall(settingsPath, settings, statuslineCommand, shouldInstallStatusline, runtime = DEFAULT_RUNTIME, isGlobal = true, configDir = null, bannerOpts = {}) {
  // #2093: isKilo dropped — the Kilo permissions-writer call below is gated
  // on plan.finishPermissionWriter === 'kilo' (descriptor-driven), not this flag.
  // #2094: isTrae dropped — unused in this function.
  // #2095: isKimi dropped — the Kimi "Done!" banner below reads
  // _hostBehaviors(runtime).doneBannerStyle === 'kimi-agent-file' (descriptor-driven), not this flag.
  // #2096: isAntigravity dropped — unused in this function.
  // #2098: isCodebuddy dropped — unused in this function.
  // #2099: isCopilot dropped — unused in this function.
  // #2100: isWindsurf dropped — unused in this function.
  const { isOpencode, isCodex, isCursor, isAugment, isQwen, isHermes, isCline } = runtimeFlags(runtime);
  const plan = resolveInstallPlan(runtime);

  if (shouldInstallStatusline && plan.writesSharedSettings && !_hostBehaviors(runtime).skipSettingsUi) {
    if (!isGlobal && !forceStatusline) {
      // Local installs skip statusLine by default: repo settings.json takes precedence over
      // profile-level settings.json in Claude Code, so writing here would silently clobber
      // any profile-level statusLine the user has configured (#2248).
      // Pass --force-statusline to override this guard.
      console.log(`  ${yellow}⚠${reset} Skipping statusLine for local install (avoids overriding profile-level settings; use --force-statusline to override)`);
    } else if (!statuslineCommand) {
      // #3002 CR: don't write { type: 'command', command: null } — the
      // runtime's settings schema rejects null commands and the failure
      // surfaces as a confusing parse error rather than a usable diagnostic.
      console.warn(`  ${yellow}⚠${reset}  Skipped statusline registration — Node executable path unavailable (process.execPath is empty). See #2979 / #3002.`);
    } else {
      settings.statusLine = {
        type: 'command',
        command: statuslineCommand
      };
      console.log(`  ${green}✓${reset} Configured statusline`);
    }
  }

  // Register the opt-in update banner (#2795) when the user accepted the
  // banner offer at install time. Only applies to runtimes that own a
  // settings.json hooks block — opencode/kilo/codex/cursor/windsurf/trae/
  // cline either lack the surface or use a different config schema.
  const { shouldInstallBanner, bannerCommand } = bannerOpts;
  if (shouldInstallBanner && settings && plan.writesSharedSettings && !_hostBehaviors(runtime).skipSettingsUi) {
    if (!bannerCommand) {
      console.warn(`  ${yellow}⚠${reset}  Skipped update banner registration — Node executable path unavailable. See #2979 / #3002.`);
    } else {
      if (!settings.hooks) settings.hooks = {};
      if (!settings.hooks.SessionStart) settings.hooks.SessionStart = [];
      const alreadyRegistered = settings.hooks.SessionStart.some(entry =>
        entry && entry.hooks && entry.hooks.some(h => h && referencesHook(h, 'gsd-update-banner'))
      );
      const bannerHookFile = configDir ? path.join(configDir, 'hooks', 'gsd-update-banner.js') : null;
      const bannerInstalled = bannerHookFile ? fs.existsSync(bannerHookFile) : false;
      if (alreadyRegistered) {
        // Idempotent re-install: don't double-register.
      } else if (!bannerInstalled) {
        console.warn(`  ${yellow}⚠${reset}  Skipped update banner — gsd-update-banner.js not found at target`);
      } else {
        const entry = buildUpdateBannerHookEntry(bannerCommand);
        if (entry) {
          settings.hooks.SessionStart.push(entry);
          console.log(`  ${green}✓${reset} Configured update banner hook (opt-in)`);
        }
      }
    }
  }

  // #768 — Pre-populate permissions.allow/deny for Claude Code installs.
  // Merges GSD-owned entries non-destructively (preserves existing user permissions).
  // Scoped to Claude only: antigravity/qwen/hermes/codebuddy also write
  // settings.json but use different runtimes and do not use these permission strings.
  if (_hostBehaviors(runtime).permissionsSchema === 'claude') {
    mergeClaudePermissions(settings);
  }

  // #2097 UPGRADE 3 (transport:mcp): companion MCP server for runtimes that host
  // MCP in settings.json (Augment). settings.json is golden-excluded, so no golden change.
  if (_hostBehaviors(runtime).mcpCompanion === 'settings-json' && settings && plan.writesSharedSettings) {
    mergeGsdMcpServerIntoSettings(settings);
  }

  // Write settings when runtime supports settings.json.
  // #3002 CR: defense-in-depth — re-run validateHookFields right before
  // serialization. The push-site guards above already skip null-command
  // entries, but a future regression that bypasses them would still produce
  // {type: 'command', command: null} items that the runtime hook schema
  // rejects at parse time. validateHookFields filters those out so the file
  // we write is always schema-valid.
  if (settingsPath && settings && plan.writesSharedSettings) {
    writeSettings(settingsPath, validateHookFields(settings));
  }

  // Configure OpenCode permissions
  if (plan.finishPermissionWriter === 'opencode' && !process.env.GSD_TEST_MODE) {
    configureOpencodePermissions(isGlobal, configDir);
  }

  // Configure Kilo permissions
  if (plan.finishPermissionWriter === 'kilo') {
    configureKiloPermissions(isGlobal, configDir);
  }

  // Configure Antigravity permissions + MCP companion server (#2096 Phase B
  // Upgrades 1+2). Not GSD_TEST_MODE-gated — mirrors Kilo's dispatch exactly;
  // both writers target files (settings.json, mcp_config.json) scoped under
  // this runtime's own configDir, so they are safe to run unconditionally.
  if (plan.finishPermissionWriter === 'antigravity') {
    configureAntigravityPermissions(isGlobal, configDir);
    configureAntigravityMcpConfig(isGlobal, configDir);
  }

  // #2834: defaults.json (resolve_model_ids + runtime) is now written BEFORE
  // installCodexConfig via writeNonClaudeDefaults(runtime) — extracted into a
  // function so it can run at the right point in the flow (before agent TOML
  // generation reads it). This call is idempotent (preserves existing values).
  writeNonClaudeDefaults(runtime);

  // program + command are now single-source lookups (ADR-1239 Phase B / #1679):
  // program is the runtime display label; command is the per-host /gsd-new-project
  // invocation syntax.
  const program = getRuntimeLabel(runtime);
  const command = getRuntimeNewProjectCommand(runtime);

  // Claude Code global installs use the skills/ format (CC 2.1.88+).
  // Restart is required for CC to pick up newly-installed skills, and the
  // slash-menu surface depends on CC version — so the instruction needs to
  // cover both invocation paths to avoid #2957-style "no commands appear".
  if (_hostBehaviors(runtime).skillsGlobalOnboarding && isGlobal) {
    console.log(`
  ${green}Done!${reset} Restart ${program}, then in any directory either type ${cyan}${command}${reset} or ask Claude to run the ${cyan}gsd-new-project${reset} skill.

  ${cyan}Join the community:${reset} https://discord.gg/mYgfVNfA2r
`);
    return;
  }

  if (_hostBehaviors(runtime).doneBannerStyle === 'kimi-agent-file') {
    const agentPath = configDir ? path.join(configDir, 'agents', 'gsd.yaml') : 'agents/gsd.yaml';
    console.log(`
  ${green}Done!${reset} Start ${program} with ${cyan}kimi --agent-file ${agentPath}${reset}, then run ${cyan}${command}${reset}.

  ${cyan}Join the community:${reset} https://discord.gg/mYgfVNfA2r
`);
    return;
  }

  console.log(`
  ${green}Done!${reset} Open a blank directory in ${program} and run ${cyan}${command}${reset}.

  ${cyan}Join the community:${reset} https://discord.gg/mYgfVNfA2r
`);
}

/**
 * Handle statusline configuration with optional prompt
 */
function handleStatusline(settings, isInteractive, callback) {
  const hasExisting = settings.statusLine != null;

  if (!hasExisting) {
    callback(true);
    return;
  }

  if (forceStatusline) {
    callback(true);
    return;
  }

  if (!isInteractive) {
    console.log(`  ${yellow}⚠${reset} Skipping statusline (already configured)`);
    console.log(`    Use ${cyan}--force-statusline${reset} to replace\n`);
    callback(false);
    return;
  }

  const existingCmd = settings.statusLine.command || settings.statusLine.url || '(custom)';

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log(`
  ${yellow}⚠${reset} Existing statusline detected\n
  Your current statusline:
    ${dim}command: ${existingCmd}${reset}

  GSD includes a statusline showing:
    • Model name
    • Current task (from todo list)
    • Context window usage (color-coded)

  ${cyan}1${reset}) Keep existing
  ${cyan}2${reset}) Replace with GSD statusline
`);

  rl.question(`  Choice ${dim}[1]${reset}: `, (answer) => {
    rl.close();
    const choice = answer.trim() || '1';
    callback(choice === '2');
  });
}

/**
 * Prompt for runtime selection
 */
/**
 * Runtime selection options for the interactive installer prompt.
 * Module-level so tests can import and assert structurally without grepping source.
 */
const runtimeMap = {
  '1': 'claude',
  '2': 'antigravity',
  '3': 'augment',
  '4': 'cline',
  '5': 'codebuddy',
  '6': 'codex',
  '7': 'copilot',
  '8': 'cursor',
  '9': 'hermes',
  '10': 'kimi',
  '11': 'kimi-code',
  '12': 'kilo',
  '13': 'opencode',
  '14': 'pi',
  '15': 'qwen',
  '16': 'trae',
  '17': 'windsurf',
  '18': 'zcode'
};
const allRuntimes = ['claude', 'antigravity', 'augment', 'cline', 'codebuddy', 'codex', 'copilot', 'cursor', 'hermes', 'kimi', 'kimi-code', 'kilo', 'opencode', 'pi', 'qwen', 'trae', 'windsurf', 'zcode'];
const ALL_RUNTIMES_OPTION = '19';

/**
 * Build the runtime-selection prompt text shown by the interactive installer.
 * Pure function — no I/O. Exported for tests so they can assert against the
 * rendered prompt instead of grepping bin/install.js source text.
 */
function buildRuntimePromptText() {
  return `  ${yellow}Which runtime(s) would you like to install for?${reset}\n\n  ${cyan}1${reset}) Claude Code  ${dim}(~/.claude)${reset}
  ${cyan}2${reset}) Antigravity  ${dim}(~/.gemini/antigravity)${reset}
  ${cyan}3${reset}) Augment      ${dim}(~/.augment)${reset}
  ${cyan}4${reset}) Cline        ${dim}(.clinerules)${reset}
  ${cyan}5${reset}) CodeBuddy    ${dim}(~/.codebuddy)${reset}
  ${cyan}6${reset}) Codex        ${dim}(~/.codex)${reset}
  ${cyan}7${reset}) Copilot      ${dim}(~/.copilot)${reset}
  ${cyan}8${reset}) Cursor       ${dim}(~/.cursor)${reset}
  ${cyan}9${reset}) Hermes Agent ${dim}(~/.hermes)${reset}
  ${cyan}10${reset}) Kimi         ${dim}(~/.config/agents, then ~/.agents if existing)${reset}
  ${cyan}11${reset}) Kimi Code    ${dim}(~/.kimi-code)${reset}
  ${cyan}12${reset}) Kilo         ${dim}(~/.config/kilo)${reset}
  ${cyan}13${reset}) OpenCode     ${dim}(~/.config/opencode)${reset}
  ${cyan}14${reset}) pi           ${dim}(~/.pi/agent)${reset}
  ${cyan}15${reset}) Qwen Code    ${dim}(~/.qwen)${reset}
  ${cyan}16${reset}) Trae         ${dim}(~/.trae)${reset}
  ${cyan}17${reset}) Windsurf     ${dim}(~/.codeium/windsurf)${reset}
  ${cyan}18${reset}) ZCode        ${dim}(~/.zcode)${reset}
  ${cyan}19${reset}) All

  ${dim}Select multiple: 1,2,6 or 1 2 6${reset}
`;
}

/**
 * Parse user input from the runtime-selection prompt into a runtime list.
 * Pure function — exported so tests can verify split/dedupe/fallback behavior.
 *  - Accepts comma- and/or whitespace-separated choices
 *  - Deduplicates while preserving order
 *  - Maps option 19 ("All") to every runtime
 *  - Falls back to ['claude'] when nothing valid is selected
 */
function parseRuntimeInput(answer) {
  const input = (answer == null ? '' : String(answer)).trim() || '1';

  // Tokenize first so the all-runtimes shortcut also fires for inputs the
  // prompt encourages — "16,", "16 1", etc. — not just the bare "16".
  const choices = input.split(/[\s,]+/).filter(Boolean);
  if (choices.includes(ALL_RUNTIMES_OPTION)) {
    return allRuntimes.slice();
  }

  const selected = [];
  for (const c of choices) {
    const runtime = runtimeMap[c];
    if (runtime && !selected.includes(runtime)) {
      selected.push(runtime);
    }
  }

  return selected.length > 0 ? selected : [DEFAULT_RUNTIME];
}

function promptRuntime(callback) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let answered = false;

  rl.on('close', () => {
    if (!answered) {
      answered = true;
      console.log(`\n  ${yellow}Installation cancelled${reset}\n`);
      process.exit(0);
    }
  });

  console.log(buildRuntimePromptText());

  rl.question(`  Choice ${dim}[1]${reset}: `, (answer) => {
    answered = true;
    rl.close();
    callback(parseRuntimeInput(answer));
  });
}

// ─── Update banner (#2795) ──────────────────────────────────────────────────

/**
 * Build the prompt text shown when offering the opt-in update banner.
 * Pure function — no I/O. Exported for tests so they can assert against the
 * rendered prompt structurally instead of grepping bin/install.js source.
 */
function buildUpdateBannerPromptText() {
  return `
  ${yellow}Optional: GSD update banner${reset}
  Without GSD's statusline, update notifications won't be visible. You can
  install a SessionStart banner that surfaces a one-line message when a new
  GSD release is available. The banner appears only at session start and
  only when an update exists.

  ${cyan}1${reset}) ${dim}No banner (default)${reset}
  ${cyan}2${reset}) Install update banner
`;
}

/**
 * Parse user input from the banner prompt. Returns true when the user opted
 * in. Pure function — exported for direct unit testing.
 *
 *  - Empty input or "1" → false (default: no banner).
 *  - "2" → true.
 *  - "y" / "yes" (case-insensitive) → true. Affirmative shortcuts.
 */
function parseUpdateBannerInput(answer) {
  const input = (answer == null ? '' : String(answer)).trim().toLowerCase();
  if (input === '2' || input === 'y' || input === 'yes') return true;
  return false;
}

/**
 * Build a SessionStart hook entry (settings.json shape) that runs the
 * update-banner script. Returns null when the input command is empty so
 * callers can warn-and-skip rather than writing { command: null } and
 * tripping the runtime's hook schema (#3002).
 *
 * @param {string|null} bannerCommand - Result of buildHookCommand() / localCmd().
 * @returns {{hooks: Array<{type: 'command', command: string}>}|null}
 */
function buildUpdateBannerHookEntry(bannerCommand) {
  if (!bannerCommand) return null;
  return {
    hooks: [
      {
        type: 'command',
        command: bannerCommand,
      },
    ],
  };
}

/**
 * Interactive prompt that asks the user whether to install the opt-in
 * update banner. Used by `installAllRuntimes` only when GSD's statusline
 * was declined or skipped.
 *
 * @param {boolean} isInteractive
 * @param {(shouldInstallBanner: boolean) => void} callback
 */
function handleUpdateBanner(isInteractive, callback) {
  if (!isInteractive) {
    // Never auto-install in non-interactive mode — user can re-run install
    // interactively or hand-edit settings.json to opt in later.
    callback(false);
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(buildUpdateBannerPromptText());

  rl.question(`  Choice ${dim}[1]${reset}: `, (answer) => {
    rl.close();
    callback(parseUpdateBannerInput(answer));
  });
}

/**
 * Prompt for install location
 */
function promptLocation(runtimes) {
  if (!process.stdin.isTTY) {
    console.log(`  ${yellow}Non-interactive terminal detected, defaulting to global install${reset}\n`);
    installAllRuntimes(runtimes, true, false);
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  let answered = false;

  rl.on('close', () => {
    if (!answered) {
      answered = true;
      console.log(`\n  ${yellow}Installation cancelled${reset}\n`);
      process.exit(0);
    }
  });

  const pathExamples = runtimes.map(r => {
    const globalPath = getGlobalConfigDir(r, explicitConfigDir);
    return globalPath.replace(os.homedir(), '~');
  }).join(', ');

  const localExamples = runtimes.map(r => `./${getDirName(r)}`).join(', ');

  console.log(`  ${yellow}Where would you like to install?${reset}\n\n  ${cyan}1${reset}) Global ${dim}(${pathExamples})${reset} - available in all projects
  ${cyan}2${reset}) Local  ${dim}(${localExamples})${reset} - this project only
`);

  rl.question(`  Choice ${dim}[1]${reset}: `, (answer) => {
    answered = true;
    rl.close();
    const choice = answer.trim() || '1';
    const isGlobal = choice !== '2';
    installAllRuntimes(runtimes, isGlobal, true);
  });
}

/**
 * Check whether any common shell rc file already contains a `PATH=` line
 * whose HOME-expanded value places `globalBin` on PATH (#2620).
 *
 * Parses `~/.zshrc`, `~/.bashrc`, `~/.bash_profile`, `~/.profile` (or the
 * override list in `rcFileNames`), matches `export PATH=` / bare `PATH=`
 * lines, and substitutes the common HOME forms (`$HOME`, `${HOME}`, `~`)
 * with `homeDir` before comparing each PATH segment against `globalBin`.
 *
 * Best-effort: any unreadable / malformed / non-existent rc file is ignored
 * and the fallback is the caller's existing absolute-path suggestion. Only
 * the `$HOME/…`, `${HOME}/…`, and `~/…` forms are handled — we do not try
 * to fully parse bash syntax.
 *
 * @param {string} globalBin  Absolute path to npm's global bin directory.
 * @param {string} homeDir    Absolute path used to substitute HOME / ~.
 * @param {string[]} [rcFileNames]  Override the default rc file list.
 * @returns {boolean}         true iff any rc file adds globalBin to PATH.
 */
function homePathCoveredByRc(globalBin, homeDir, rcFileNames) {
  if (!globalBin || !homeDir) return false;
  const path = require('path');
  const fs = require('fs');

  const normalise = (p) => {
    if (!p) return '';
    let n = p.replace(/[\\/]+$/g, '');
    if (n === '') n = p.startsWith('/') ? '/' : p;
    return n;
  };

  const targetAbs = normalise(path.resolve(globalBin));
  const homeAbs = path.resolve(homeDir);
  const files = rcFileNames || ['.zshrc', '.bashrc', '.bash_profile', '.profile'];

  const expandHome = (segment) => {
    let s = segment;
    s = s.replace(/\$\{HOME\}/g, homeAbs);
    s = s.replace(/\$HOME/g, homeAbs);
    if (s.startsWith('~/') || s === '~') {
      s = s === '~' ? homeAbs : path.join(homeAbs, s.slice(2));
    }
    return s;
  };

  // Match `PATH=…` (optionally prefixed with `export `). The RHS captures
  // through end-of-line; surrounding quotes are stripped before splitting.
  const assignRe = /^\s*(?:export\s+)?PATH\s*=\s*(.+?)\s*$/;

  for (const name of files) {
    const rcPath = path.join(homeAbs, name);
    let content;
    try {
      content = fs.readFileSync(rcPath, 'utf8');
    } catch {
      continue;
    }

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.replace(/^\s+/, '');
      if (line.startsWith('#')) continue;

      const m = assignRe.exec(rawLine);
      if (!m) continue;

      let rhs = m[1];
      if ((rhs.startsWith('"') && rhs.endsWith('"')) ||
          (rhs.startsWith("'") && rhs.endsWith("'"))) {
        rhs = rhs.slice(1, -1);
      }

      for (const segment of rhs.split(':')) {
        if (!segment) continue;
        const trimmed = segment.trim();
        const expanded = expandHome(trimmed);
        if (expanded.includes('$')) continue;
        // Skip segments that are still relative after HOME expansion. A bare
        // `bin` entry (or `./bin`, `node_modules/.bin`, etc.) depends on the
        // shell's cwd at lookup time — it is NOT equivalent to `$HOME/bin`,
        // so resolving against homeAbs would produce false positives.
        if (!path.isAbsolute(expanded)) continue;
        try {
          const abs = normalise(path.resolve(expanded));
          if (abs === targetAbs) return true;
        } catch {
          // ignore unresolvable segments
        }
      }
    }
  }

  return false;
}

/**
 * Decode fish's universal-variable value escaping (the inverse of fish's
 * `full_escape`). fish serializes every non-`[A-Za-z0-9/_]` byte in
 * `fish_variables` — e.g. space -> `\x20`, hyphen -> `\x2d`, dot -> `\x2e` —
 * and joins list elements with the literal 4-char token `\x1e` (NOT a raw
 * 0x1e byte). Callers split on `\x1e` first, then decode each element here.
 *
 * Pure and total: any unrecognised `\`-sequence is passed through verbatim,
 * so `decode(fishEscape(p)) === p` holds for every path string. Exported for
 * a fast-check round-trip property test (#323).
 *
 * @param {string} s  A single (already `\x1e`-split) escaped value.
 * @returns {string}  The decoded literal.
 */
function decodeFishUniversalValue(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const n = s[i + 1];
    if (n === 'n') { out += '\n'; i += 1; }
    else if (n === 'r') { out += '\r'; i += 1; }
    else if (n === 't') { out += '\t'; i += 1; }
    else if (n === '\\') { out += '\\'; i += 1; }
    else if (n === 'x' || n === 'X') {
      const hex = s.slice(i + 2, i + 4);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 3; }
      else { out += c; }
    } else if (n === 'u') {
      const hex = s.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 5; }
      else { out += c; }
    } else if (n === 'U') {
      const hex = s.slice(i + 2, i + 10);
      if (/^[0-9a-fA-F]{8}$/.test(hex)) { out += String.fromCodePoint(parseInt(hex, 16)); i += 9; }
      else { out += c; }
    } else { out += c; }
  }
  return out;
}

/**
 * Check whether fish's configuration already places `globalBin` on PATH (#323).
 *
 * fish does not use the sh-style `export PATH=` rc files that
 * `homePathCoveredByRc()` parses, so a fish user whose `fish_user_paths`
 * already covers the global bin would otherwise see a false-positive
 * "not on your PATH" warning on every install. Two detection routes,
 * mirroring how `fish_add_path` actually persists:
 *
 *  1. The universal-variable store `fish_variables` — a
 *     `SETUVAR fish_user_paths:<a>\x1e<b>…` line whose `\x1e`-separated
 *     entries are absolute paths (fish does not HOME-expand them here).
 *  2. `config.fish` — explicit `fish_add_path …`, `set -gx PATH …`, or
 *     `set -Ux fish_user_paths …` lines that name the directory after
 *     HOME expansion.
 *
 * Best-effort and side-effect-free: any unreadable / missing file is ignored
 * (no fish subprocess is spawned). Honours `$XDG_CONFIG_HOME` and always also
 * checks `~/.config/fish`. Pass `fishConfigDir` to override the lookup
 * directory (tests).
 *
 * @param {string} globalBin  Absolute path to npm's global bin directory.
 * @param {string} homeDir    Absolute path used to substitute HOME / ~.
 * @param {string} [fishConfigDir]  Override the fish config directory.
 * @returns {boolean}         true iff fish config adds globalBin to PATH.
 */
function homePathCoveredByFishConfig(globalBin, homeDir, fishConfigDir) {
  if (!globalBin || !homeDir) return false;
  const path = require('path');
  const fs = require('fs');

  const normalise = (p) => {
    if (!p) return '';
    let n = p.replace(/[\\/]+$/g, '');
    if (n === '') n = p.startsWith('/') ? '/' : p;
    return n;
  };

  const targetAbs = normalise(path.resolve(globalBin));
  const homeAbs = path.resolve(homeDir);

  const baseDirs = [];
  if (fishConfigDir) {
    baseDirs.push(fishConfigDir);
  } else {
    if (process.env.XDG_CONFIG_HOME) {
      baseDirs.push(path.join(process.env.XDG_CONFIG_HOME, 'fish'));
    }
    baseDirs.push(path.join(homeAbs, '.config', 'fish'));
  }

  const expandHome = (segment) => {
    let s = segment;
    s = s.replace(/\$\{HOME\}/g, homeAbs).replace(/\$HOME/g, homeAbs);
    if (s.startsWith('~/') || s === '~') {
      s = s === '~' ? homeAbs : path.join(homeAbs, s.slice(2));
    }
    return s;
  };

  // Compare an already-resolved absolute literal (a decoded fish_user_paths
  // entry — fish stores these resolved, never as `$VAR`/`~`). A literal `$`
  // here is part of the directory name, so it must NOT be treated as an
  // unexpanded variable.
  const matchesLiteral = (segment) => {
    if (!segment || !path.isAbsolute(segment)) return false;
    try {
      return normalise(path.resolve(segment)) === targetAbs;
    } catch {
      return false;
    }
  };

  // Compare a config.fish shell token: strip surrounding quotes, expand the
  // common HOME forms, and skip anything still holding a `$` (an unexpanded
  // variable such as `$PATH` / `$fish_user_paths`) or still relative.
  const matchesTarget = (rawSegment) => {
    if (!rawSegment) return false;
    let seg = rawSegment.trim();
    if ((seg.startsWith('"') && seg.endsWith('"')) ||
        (seg.startsWith("'") && seg.endsWith("'"))) {
      seg = seg.slice(1, -1);
    }
    const expanded = expandHome(seg);
    if (expanded.includes('$')) return false;
    return matchesLiteral(expanded);
  };

  const readLines = (filePath) => {
    try {
      return fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    } catch {
      return null;
    }
  };

  for (const baseDir of baseDirs) {
    // Route 1: universal variable store.
    const uvarLines = readLines(path.join(baseDir, 'fish_variables'));
    if (uvarLines) {
      for (const rawLine of uvarLines) {
        const m = /^SETUVAR(?:\s+--\S+)*\s+fish_user_paths:(.*)$/.exec(rawLine);
        if (!m) continue;
        // Elements are joined by the literal `\x1e` token; decode each. The
        // decoded entry is an absolute literal — compare it directly.
        for (const entry of m[1].split('\\x1e')) {
          if (matchesLiteral(decodeFishUniversalValue(entry))) return true;
        }
      }
    }

    // Route 2: config.fish explicit PATH mutations.
    const configLines = readLines(path.join(baseDir, 'config.fish'));
    if (configLines) {
      for (const rawLine of configLines) {
        const line = rawLine.replace(/^\s+/, '');
        if (line.startsWith('#')) continue;

        let rest = null;
        let m;
        if ((m = /^fish_add_path\s+(.+)$/.exec(line))) {
          rest = m[1];
        } else if ((m = /^set\s+(?:-\S+\s+)*PATH\s+(.+)$/.exec(line))) {
          rest = m[1];
        } else if ((m = /^set\s+(?:-\S+\s+)*fish_user_paths\s+(.+)$/.exec(line))) {
          rest = m[1];
        }
        if (rest === null) continue;

        // Tokens are whitespace-separated; flag tokens (`-g`, `--path`) and
        // variable references are skipped by matchesTarget / the `-` guard.
        for (const tok of rest.split(/\s+/)) {
          if (!tok || tok.startsWith('-')) continue;
          if (matchesTarget(tok)) return true;
        }
      }
    }
  }

  return false;
}

/**
 * Emit a PATH-export suggestion if globalBin is not already on PATH AND
 * the user's shell rc files do not already cover it via a HOME-relative
 * entry (#2620).
 *
 * Prints one of:
 *   - nothing, if `globalBin` is already present on `process.env.PATH`
 *   - a diagnostic "already covered via rc file" note, if an rc file has
 *     `export PATH="$HOME/…/bin:$PATH"` (or equivalent) and the user just
 *     needs to reopen their shell
 *   - projected shell actions that append `export PATH="…:$PATH"` to
 *     `~/.zshrc` / `~/.bashrc` when neither PATH nor rc files cover globalBin
 *     if neither PATH nor any rc file covers globalBin
 *
 * Exported for tests; the installer calls this from finishInstall.
 *
 * @param {string} globalBin  Absolute path to npm's global bin directory.
 * @param {string} homeDir    Absolute HOME path.
 */
function maybeSuggestPathExport(globalBin, homeDir) {
  if (!globalBin || !homeDir) return;
  const path = require('path');

  const pathEnv = process.env.PATH || '';
  const targetAbs = path.resolve(globalBin).replace(/[\\/]+$/g, '') || globalBin;
  const onPath = pathEnv.split(path.delimiter).some((seg) => {
    if (!seg) return false;
    const abs = path.resolve(seg).replace(/[\\/]+$/g, '') || seg;
    return abs === targetAbs;
  });
  if (onPath) return;

  // Already added to PATH via an rc file, but the current shell predates that
  // edit — tell the user to reopen rather than (wrongly) suggesting they add it
  // again. Applies to whatever bin dir we install into (retained shim-agnostic).
  if (homePathCoveredByRc(globalBin, homeDir)) {
    console.log('');
    console.log(`  ${yellow}⚠${reset} ${bold}${globalBin}${reset}'s directory is already on your PATH via an rc file entry — try reopening your shell (or ${cyan}source ~/.zshrc${reset}).`);
    console.log('');
    return;
  }

  // Same idea for fish users: fish_user_paths / config.fish already covers the
  // dir, the current session just predates it. fish has no sh-style rc file so
  // homePathCoveredByRc never sees it — check the fish config explicitly (#323).
  if (homePathCoveredByFishConfig(globalBin, homeDir)) {
    console.log('');
    console.log(`  ${yellow}⚠${reset} ${bold}${globalBin}${reset}'s directory is already on your PATH via fish's universal variables — open a new fish session (or run ${cyan}exec fish${reset}).`);
    console.log('');
    return;
  }

  console.log('');
  console.log(`  ${yellow}⚠${reset} ${bold}${globalBin}${reset} is not on your PATH.`);
  const projected = projectPersistentPathExportActions({
    targetDir: globalBin,
    platform: process.platform,
  });
  if (projected.reason === PATH_ACTION_REASON.WIN32_RESERVED_QUOTE) {
    // #3118 review MINOR: a win32 targetDir containing `"` makes
    // projectPathActionProjection return [] (no command can quote it safely
    // on Windows) — printing the "Add it with one of:" header with nothing
    // under it is a silent dead-end. Name the cause instead.
    console.log(`    No command can be suggested: the path contains a ${cyan}"${reset} character, which cannot appear in a Windows path.`);
  } else if (projected.shellActions.length === 0) {
    // #3118: no target directory to talk about (reason === NO_TARGET_DIR, or
    // no reason at all) — there is nothing to print beyond the "not on your
    // PATH" line above.
  } else {
    console.log(`    Add it with one of:`);
    for (const action of projected.shellActions) {
      const labelPrefix = action.label ? `${action.label}: ` : '';
      console.log(`      ${cyan}${labelPrefix}${action.command}${reset}`);
    }
  }
  console.log('');
}

// Runtime subdir names to scan for legacy get-shit-done-cc artifacts (#607).
// Covers both local (project-relative) and common global forms.
const _LEGACY_SCAN_SUBDIR_NAMES = [
  '.claude',
  '.gemini',
  '.opencode',
  '.config/opencode',
  '.kilo',
  '.config/kilo',
  '.codex',
  '.copilot',
  '.github',    // copilot local form
  '.agents',    // antigravity local form (canonical, #791)
  '.agent',     // antigravity local form (legacy, backward-compat)
  '.cursor',
  '.devin',     // windsurf local form (legacy, pre-#1615; Devin Desktop preferred dir, #1085)
  '.windsurf',  // windsurf local form (canonical since #1615; capability.json localConfigDir)
  '.codeium/windsurf',
  '.augment',
  '.trae',
  '.qwen',
  '.hermes',
  '.codebuddy',
  '.cline',
];

/**
 * Detect and remove leftover get-shit-done-cc artifacts across ALL known
 * runtime config directories (issue #607).
 *
 * Exported so tests can call it directly without spawning a subprocess.
 *
 * Scans ONLY subdirs under homeDir — never cwd — to avoid touching the
 * user's active-project hooks when the installer is run from a project dir.
 *
 * @param {object} [opts]
 * @param {string}  [opts.homeDir=os.homedir()]  - home directory to scan
 * @param {boolean} [opts.dryRun=false]          - preview only; no mutations
 * @param {object}  [opts.logger=console]        - injectable logger
 * @returns {{ plan: {path:string,reason:string}[], result: object }}
 */
function cleanupLegacyGsdCc({ homeDir = os.homedir(), dryRun = false, logger = console } = {}) {
  // Build de-duplicated list of candidate config dirs to scan.
  // Only scan under homeDir — never cwd — to prevent accidental deletion of
  // the user's active-project hooks when the installer is invoked from a
  // project directory that has .claude/hooks or similar subdirs.
  const seen = new Set();
  const configDirs = [];
  for (const name of _LEGACY_SCAN_SUBDIR_NAMES) {
    const candidate = path.join(homeDir, name);
    if (!seen.has(candidate) && fs.existsSync(candidate)) {
      seen.add(candidate);
      configDirs.push(candidate);
    }
  }

  // planLegacyCleanup scans each configDir and already includes the legacy
  // shared cache (gsd-update-check.json) as a plan entry.
  const plan = planLegacyCleanup(configDirs, { homeDir });

  // Apply the plan (dryRun honors the flag).
  const result = applyLegacyCleanup(plan, { dryRun, logger });

  // Also clear / preview the per-package cache so next session re-evaluates
  // hook versions (replaces the former inline unlinkSync on line ~9104).
  const perPkgCacheFile = path.join(homeDir, '.cache', 'gsd', updateCacheFileName);
  if (dryRun) {
    logger.log('[dry-run] would remove: ' + perPkgCacheFile + '  (per-package-update-cache)');
  } else {
    try { fs.unlinkSync(perPkgCacheFile); } catch (_e) { /* cache may not exist yet */ }
  }

  // Concise summary
  if (plan.length > 0 || !dryRun) {
    const verb = dryRun ? 'Would remove' : 'Removed';
    const count = dryRun ? plan.length : result.removed.length;
    logger.log(`[legacy-cleanup] ${verb} ${count} legacy artifact(s).`);
  }

  return { plan, result };
}

/**
 * Install GSD for all selected runtimes
 */
function installAllRuntimes(runtimes, isGlobal, isInteractive) {
  const results = [];
  const installerMigrations = discoverInstallerMigrations({
    migrationsDir: path.join(_gsdLibDir, 'installer-migrations'),
  });

  const rollbackFinalizedInstallerMigrations = (error) => {
    const rollbackFailures = [];
    for (const result of [...results].reverse()) {
      if (!result || typeof result.rollbackInstallerMigrations !== 'function') continue;
      try {
        result.rollbackInstallerMigrations();
      } catch (rollbackError) {
        rollbackFailures.push({
          runtime: result.runtime,
          error: rollbackError.message,
        });
      }
    }
    if (rollbackFailures.length > 0) {
      error.installerMigrationRollbackFailures = rollbackFailures;
    }
  };

  try {
    for (const runtime of runtimes) {
      const result = install(isGlobal, runtime, { installerMigrations });
      results.push(result);
    }
  } catch (error) {
    rollbackFinalizedInstallerMigrations(error);
    throw error;
  }

  const statuslineRuntimes = [DEFAULT_RUNTIME];
  const primaryStatuslineResult = results.find(r => statuslineRuntimes.includes(r.runtime));

  const finalize = (shouldInstallStatusline, shouldInstallBanner) => {
    try {
      const printSummaries = () => {
        for (const result of results) {
          if (result && result.skipped) continue;
          if (!result) continue;
          const useStatusline = statuslineRuntimes.includes(result.runtime) && shouldInstallStatusline;
          finishInstall(
            result.settingsPath,
            result.settings,
            result.statuslineCommand,
            useStatusline,
            result.runtime,
            isGlobal,
            result.configDir,
            { shouldInstallBanner: !!shouldInstallBanner, bannerCommand: result.updateBannerCommand }
          );
        }
      };

      printSummaries();
    } catch (error) {
      // Phase 4 install/update integration requires safe migrations to roll
      // back when later package/finalization materialization fails:
      // docs/installer-migrations.md#phase-4-installupdate-integration.
      rollbackFinalizedInstallerMigrations(error);
      throw error;
    }
  };

  // Statusline first; if it won't actually be installed (declined, or local
  // install without --force-statusline silently skips it per #2248), offer
  // the opt-in update banner (#2795) as the secondary surface for update
  // notifications. Skip the banner prompt entirely when no runtime in this
  // install set can host the banner (e.g. Codex/Copilot/Cursor/Windsurf/
  // Trae/Cline-only installs whose updateBannerCommand is null).
  //
  // CR #3035: gate on actual installability — `shouldInstallStatusline`
  // returned by handleStatusline is the raw user choice, but
  // `finishInstall` later skips the statusline write on local installs
  // unless --force-statusline is set. Passing the raw flag to
  // continueAfterStatusline previously caused two bugs: (1) interactive
  // local installs got neither a statusline nor a banner offer, and (2)
  // banner-incapable runtimes got prompted even though every
  // updateBannerCommand was null.
  const canInstallBanner = results.some((r) => r && r.updateBannerCommand);
  const continueAfterStatusline = (shouldInstallStatusline) => {
    const willInstallStatusline =
      shouldInstallStatusline && (isGlobal || forceStatusline);
    if (willInstallStatusline) {
      finalize(true, false);
      return;
    }
    if (!canInstallBanner) {
      finalize(shouldInstallStatusline, false);
      return;
    }
    handleUpdateBanner(isInteractive, (shouldInstallBanner) => {
      finalize(shouldInstallStatusline, shouldInstallBanner);
    });
  };

  if (primaryStatuslineResult) {
    handleStatusline(primaryStatuslineResult.settings, isInteractive, continueAfterStatusline);
  } else if (canInstallBanner) {
    // No statusline-capable runtime, but at least one runtime can host the
    // banner — still offer it.
    handleUpdateBanner(isInteractive, (shouldInstallBanner) => {
      finalize(false, shouldInstallBanner);
    });
  } else {
    // Nothing to prompt about — no statusline, no banner-capable runtime.
    finalize(false, false);
  }
}

// Always export so runtime-artifact-layout.cjs's lazy loader can access
// converter functions when called from within the CLI path (circular require).
// The main() block below is gated on !GSD_TEST_MODE, as before.
module.exports = {
    // #3677 — hyphen-namespace normalization seam for agent bodies
    shouldNormalizeHyphenNamespaceInAgentBody,
    // #3664: --config-dir foreign-agent-destination warning (warn-and-proceed)
    warnIfForeignAgentDest,
    normalizeAgentBodyForRuntime,
    yamlIdentifier,
    getCodexSkillAdapterHeader,
    convertClaudeCommandToCursorSkill,
    convertClaudeAgentToCursorAgent,
    convertClaudeAgentToCodexAgent,
    generateCodexAgentToml,
    _resetCodexWarningDedupeForTests,
    cleanupCodexSkillMetadataSidecars,
    cleanupWindsurfLegacyDevinSkills,
    cleanupMovedSkillsOldLocation,
    _resolveMovedSkillsOldDir,
    _resolveSkillsRootDir,
    codexBareAgentsHasOnlyKnownScalars,
    extractCodexUserAgentsScalars,
    CODEX_EXTENDED_HOOK_EVENTS,
    generateCodexConfigBlock,
    stripGsdFromCodexConfig,
    migrateCodexHooksMapFormat,
    stripStaleGsdHookBlocks,
    hasUserNamespacedAotHooks,
    parseTomlToObject,
    validateCodexConfigSchema,
    mergeCodexConfig,
    installCodexConfig,
    install,
    installAllRuntimes,
    uninstall,
    // #2086 — host-behavior resolution + the #338 privacy fail-safe floor (exported for tests)
    _resolveHostBehaviors,
    FALLBACK_HOST_BEHAVIORS,
    // #3023 — shared hook bundle directory name, descriptor-driven
    SHARED_HOOKS_DIR_DEFAULT,
    resolveSharedHooksDirName,
    // #3184 — uninstall-side GSD-managed file enumerations, exported for
    // parity assertions against the wholesale-copy source directories
    GSD_CHANGESET_FILES,
    GSD_SCRIPTS_LIB_FILES,
    convertSlashCommandsToCodexSkillMentions,
    convertClaudeCommandToCodexSkill,
    convertClaudeCommandToKimiSkill,
    convertKimiToolName,
    mapClaudeToolsToKimiTools,
    buildKimiAgentArtifacts,
    convertClaudeToOpencodeFrontmatter,
    convertClaudeToKiloFrontmatter,
    configureOpencodePermissions,
    neutralizeAgentReferences,
    // #768 — Claude Code permissions pre-population
    mergeClaudePermissions,
    GSD_CLAUDE_ALLOW_PERMISSIONS,
    GSD_CLAUDE_LEGACY_ALLOW_PERMISSIONS,
    GSD_CLAUDE_DENY_PERMISSIONS,
    GSD_CODEX_MARKER,
    CODEX_AGENT_SANDBOX,
    getGlobalDir,
    getConfigDirFromHome,
    resolveKiloConfigPath,
    configureKiloPermissions,
    // #2096 Phase B Upgrades 1+2 — Antigravity permission-writer + MCP companion
    toTildePosixPath,
    buildAntigravityAllowRules,
    configureAntigravityPermissions,
    configureAntigravityMcpConfig,
    // #2097 UPGRADE 3 — Augment MCP companion (settings.json-hosted)
    mergeGsdMcpServerIntoSettings,
    claudeToCopilotTools,
    convertCopilotToolName,
    convertClaudeToCopilotContent,
    convertClaudeCommandToCopilotSkill,
    convertClaudeAgentToCopilotAgent,
    GSD_COPILOT_INSTRUCTIONS_MARKER,
    GSD_COPILOT_INSTRUCTIONS_CLOSE_MARKER,
    mergeCopilotInstructions,
    stripGsdFromCopilotInstructions,
    GSD_COPILOT_HOOK_FILE,
    convertClaudeToAntigravityContent,
    convertClaudeCommandToAntigravitySkill,
    convertClaudeAgentToAntigravityAgent,
    convertClaudeCommandToClaudeSkill,
    skillFrontmatterName,
    convertClaudeToTraeMarkdown,
    convertClaudeCommandToTraeSkill,
    convertClaudeAgentToTraeAgent,
    convertClaudeToCodebuddyMarkdown,
    convertClaudeCommandToCodebuddySkill,
    convertClaudeCommandToCodebuddyCommand,
    convertClaudeAgentToCodebuddyAgent,
    convertClaudeToCliineMarkdown,
    convertClaudeCommandToClineSkill,
    convertClaudeAgentToClineAgent,
    // #2284 — Hermes named-dispatch → delegate_task projection
    convertClaudeToHermesMarkdown,
    projectNamedDispatchToStructuralDelegate,
    _hostIntegrationDispatch,
    _resolveAvailableGsdRoles,
    HERMES_DISPATCH_TOOL_CONFIG,
    maskStringLiterals,
    findDispatchCallSpans,
    _assertProjectionComplete,
    GSD_CURSOR_SESSION_HOOK_SCRIPT,
    GSD_CURSOR_POST_TOOL_HOOK_SCRIPT,
    GSD_CURSOR_HOOK_MARKER,
    GSD_WINDSURF_PRE_WRITE_HOOK_SCRIPT,
    GSD_WINDSURF_PRE_COMMAND_HOOK_SCRIPT,
    stripGsdFromAgentsMd,
    GSD_AGENTS_MD_MARKER,
    GSD_AGENTS_MD_CLOSE_MARKER,
    writeManifest,
    saveLocalPatches,
    reportLocalPatches,
    validateHookFields,
    populatePristineDir,
    _resolveUserArtifactStagingRoot,
    _tryResolveUserArtifactStagingRoot,
    finishInstall,
    homePathCoveredByRc,
    homePathCoveredByFishConfig,
    decodeFishUniversalValue,
    maybeSuggestPathExport,
    runtimeMap,
    allRuntimes,
    selectRuntimesFromArgs,
    GSD_UNINSTALL_HOOKS,
    parseRuntimeInput,
    buildRuntimePromptText,
    buildUpdateBannerPromptText,
    parseUpdateBannerInput,
    buildUpdateBannerHookEntry,
    parseConfigDirFromArgs,
    cleanupLegacyGsdCc,
    // #1191 — exported so tests exercise the REAL readSettings, not a replica
    readSettings,
    stripJsonComments,
    copyWithPathReplacement,
  };

// Main logic — only run when not loaded as a module for testing
if (require.main === module && !process.env.GSD_TEST_MODE) {
  if (hasDryRun) {
    // --dry-run: preview legacy cleanup and exit without installing.
    if (hasUninstall) {
      console.log('Note: --dry-run previews legacy get-shit-done-cc cleanup only; it does not preview --uninstall.');
    }
    console.log('Dry run — no files will be modified.\n');
    // cleanupLegacyGsdCc with dryRun:true is the single source of truth for
    // both the legacy artifacts and the per-package cache path — no duplicate
    // printing here.
    const { plan } = cleanupLegacyGsdCc({ dryRun: true });
    if (plan.length === 0) {
      console.log('  (no legacy get-shit-done-cc artifacts found)');
    }
    process.exit(0);
  } else if (hasSkillsRoot) {
    // Print the skills root directory for a given runtime (used by /gsd-sync-skills).
    // Usage: node install.js --skills-root <runtime>
    const runtimeArg = args[args.indexOf('--skills-root') + 1];
    if (!runtimeArg || runtimeArg.startsWith('--')) {
      console.error('Usage: node install.js --skills-root <runtime>');
      process.exit(1);
    }
    // #3024: validate the runtime id against the shipped capability registry
    // BEFORE resolving anything. getGlobalSkillsBase's bare `runtimes[runtime]`
    // lookup falls through the prototype chain to claude's skills root for an
    // unregistered/hostile id (`__proto__`, `constructor`, `prototype`, …)
    // instead of failing loudly. isRegisteredRuntimeId is the SAME validator
    // gsd-tools' `routeSkillsRoot` calls, so this entry point and the shipped
    // `gsd-tools query skills-root` entry point can never diverge on which
    // runtime ids they accept.
    if (!isRegisteredRuntimeId(runtimeArg)) {
      console.error(`Unknown runtime "${runtimeArg}" — must be a registered runtime id`);
      process.exit(1);
    }
    const skillsRoot = getGlobalSkillsBase(runtimeArg.trim());
    if (skillsRoot === null) {
      console.error(`${runtimeArg} does not use a skills directory`);
      process.exit(1);
    }
    console.log(skillsRoot);
  } else if (hasGlobal && hasLocal) {
    console.error(`  ${yellow}Cannot specify both --global and --local${reset}`);
    process.exit(1);
  } else if (explicitConfigDir && hasLocal) {
    console.error(`  ${yellow}Cannot use --config-dir with --local${reset}`);
    process.exit(1);
  } else if (hasUninstall) {
    if (!hasGlobal && !hasLocal) {
      console.error(`  ${yellow}--uninstall requires --global or --local${reset}`);
      process.exit(1);
    }
    const runtimes = selectedRuntimes.length > 0 ? selectedRuntimes : [DEFAULT_RUNTIME];
    for (const runtime of runtimes) {
      uninstall(hasGlobal, runtime);
    }
  } else if (selectedRuntimes.length > 0) {
    if (!hasGlobal && !hasLocal) {
      promptLocation(selectedRuntimes);
    } else {
      installAllRuntimes(selectedRuntimes, hasGlobal, false);
    }
  } else if (hasGlobal || hasLocal) {
    // Default to Claude if no runtime specified but location is
    installAllRuntimes([DEFAULT_RUNTIME], hasGlobal, false);
  } else {
    // Interactive
    if (!process.stdin.isTTY) {
      console.log(`  ${yellow}Non-interactive terminal detected, defaulting to Claude Code global install${reset}\n`);
      installAllRuntimes([DEFAULT_RUNTIME], true, false);
    } else {
      promptRuntime((runtimes) => {
        promptLocation(runtimes);
      });
    }
  }

} // end of !GSD_TEST_MODE main logic block
