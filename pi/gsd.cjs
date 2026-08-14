'use strict';

/**
 * GSD extension for pi (pi.dev) — ADR-1239 Phase D / #1944, upgraded #2102 Stage 2.
 *
 * pi is a Programmatic-CLI host whose TS extensions implement the ExtensionAPI
 * (`@earendil-works/pi-coding-agent`): registerCommand({handler(args, ctx)}) /
 * registerTool({execute(toolCallId, params, signal, onUpdate, ctx)}) / pi.on(event, handler).
 * This extension binds GSD's command surface to pi via the imperative adapter
 * path — the programmatic-CLI peer of the OpenCode worked binding.
 *
 * Installation: copy this file to ~/.pi/agent/extensions/gsd.js — note the
 * `.js` DEST suffix, not `.cjs`. pi auto-discovers extensions/ entries through
 * `isExtensionFile()`, which accepts only `.ts`/`.js` and skips anything else
 * SILENTLY (no error, no log line), so a `.cjs` dest installs fine and is then
 * never loaded (#2470). This source file keeps its `.cjs` suffix on purpose —
 * tests `require()` it directly and `.cjs` is unambiguous CommonJS — and pi
 * loads the copied file via jiti, which handles CommonJS and ESM alike, so the
 * suffix gates discovery, not parsing. The engine is resolved from the installed
 * GSD tree (walk-up like the OpenCode plugin). pi's shared hooks/ bundle
 * (hooks/*.js + hooks/lib/git-cmd.js) is installed alongside the extension —
 * capabilities/pi/capability.json does NOT set
 * `hostBehaviors.skipSharedHooksInstall` (#2102 Stage 2 fix; pi is
 * architecturally identical to OpenCode here: `hooksSurface: 'none'` +  a
 * native extension that spawns the staged hooks — not Kilo/ZCode's
 * no-plugin-surface case, where the same hooks would be genuine dead weight).
 * This is what makes the event bridges below (and the tokenizer require)
 * resolve for real in an installed tree, not just in this dev repo.
 *
 * Engine entry: dispatch is SUBPROCESS-REUSE to gsd-tools.cjs (bounded,
 * no-throw — dispatchGsdCommand in shell-command-projection.cjs), NOT an
 * in-process command-routing hub. No fully-populated hub factory exists
 * anywhere in gsd-core — every createHub() caller in the tree builds a
 * single-family hub for its own narrow purpose — so the "in-process createHub"
 * framing of the original #1944 cut was aspirational and is not achievable
 * without a hub factory that doesn't exist. This mirrors the precedent already
 * established for the OpenCode/Kilo hook bridge (.opencode/plugins/gsd-core.js
 * header: "Architecture: SUBPROCESS REUSE ... spawns existing hook scripts as
 * child processes") — the same pattern, applied to command dispatch. The
 * companion MCP server (gsd-mcp-server) dispatches through the SAME shared
 * helper for out-of-process hosts.
 *
 * @param {object} pi  pi ExtensionAPI (registerTool/registerCommand/on/…)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

// Resolve the GSD engine tree (the dir holding gsd-core/ + hooks/).
// Works across dev (<root>/pi/gsd.cjs → <root>) and installed layouts.
function resolveEngineRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'gsd-core'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir, '..');
}

const ENGINE_ROOT = resolveEngineRoot(__dirname);
const GSD_CORE = path.join(ENGINE_ROOT, 'gsd-core');

// #3023: pi reserves `hooks/` as its (now deprecated) extension directory and
// warns on every startup when one exists, so the installer stages GSD's shared
// hook bundle under `gsd-hooks/` for pi. Probe in preference order rather than
// hardcoding either name: an installed pi tree has `gsd-hooks/`, a dev checkout
// has the repo-root `hooks/`, and a half-upgraded tree can transiently have both
// — in which case the renamed bundle is the current one and wins.
const SHARED_HOOKS_DIR_CANDIDATES = ['gsd-hooks', 'hooks'];

/**
 * Absolute path to the staged shared-hook bundle, or null when none is present.
 * Never throws — a stat failure on any candidate is treated as "not this one".
 *
 * A candidate qualifies only when it is a directory AND non-empty. An install
 * can be interrupted between `mkdirSync(gsd-hooks)` and the file copy, leaving
 * a directory that exists but is empty; `gsd-hooks` is probed FIRST (it is the
 * preferred, current name), so an empty `gsd-hooks/` would otherwise win over
 * a fully-staged legacy `hooks/` and every hook would silently no-op —
 * `runHook`'s `fs.existsSync(hookPath)` guard degrades per-file, so binding to
 * an empty bundle produces no error at all, just silent inaction. A
 * partially-staged bundle must lose to a fully-staged one for that reason.
 * @param {string} engineRoot
 * @returns {string|null}
 */
function resolveSharedHooksDir(engineRoot) {
  for (const name of SHARED_HOOKS_DIR_CANDIDATES) {
    const candidate = path.join(engineRoot, name);
    try {
      if (!fs.statSync(candidate).isDirectory()) continue;
      if (fs.readdirSync(candidate).length === 0) continue;
      return candidate;
    } catch { /* absent or unreadable — try the next candidate */ }
  }
  return null;
}

const SHARED_HOOKS_DIR = resolveSharedHooksDir(ENGINE_ROOT);

// ── curated top-level command families (gsd-tools.cjs TOP_LEVEL_USAGE) ──────
// readCmdNames() (scripts/fix-slash-commands.cjs) reads commands/, which pi
// does NOT install (it ships a single native-extension file, no shared
// commands/ dir) — it would always return []. This is a self-contained,
// hand-curated subset of the STABLE top-level families documented by
// `node gsd-core/bin/gsd-tools.cjs --help` (gsd-tools.cjs:689-705). Named +
// exported (via _internals) so a test can assert against it directly.
const PI_COMMAND_FAMILIES = Object.freeze([
  'agent', 'capability', 'check', 'commit', 'config-get', 'config-path',
  'config-set', 'effort', 'git', 'graphify', 'init', 'intel', 'learnings',
  'list-todos', 'loop', 'milestone', 'phase', 'phases', 'progress',
  'requirements', 'research-plan', 'research-store', 'resolve-granularity',
  'resolve-model', 'roadmap', 'scaffold', 'smart-entry', 'state', 'task',
  'template', 'user-story', 'validate', 'verify', 'workstream', 'worktree',
]);

/**
 * Filter PI_COMMAND_FAMILIES by prefix (startsWith). Returns null when there
 * are no matches, per pi's `AutocompleteItem[]|null` contract.
 * @param {string} prefix
 * @returns {{value: string, label: string}[] | null}
 */
function getArgumentCompletions(prefix) {
  const p = typeof prefix === 'string' ? prefix : '';
  const matches = PI_COMMAND_FAMILIES.filter((name) => name.startsWith(p));
  if (matches.length === 0) return null;
  return matches.map((value) => ({ value, label: value }));
}

/**
 * Tokenize the raw `/gsd <args>` string into { family, subcommand, args }.
 * Reuses the quote-aware whitespace tokenizer already shipped for hooks
 * (the staged shared-hook bundle's `lib/git-cmd.js`'s `tokenize`) rather than
 * re-implementing shell-word splitting a second time. #2102 Stage 2: pi's capability descriptor no
 * longer sets `hostBehaviors.skipSharedHooksInstall` (adversarial-review
 * finding #1/#2 — pi ships NO hooks/ with that flag set, so this require was
 * dead in a real install), so the shared hooks/ bundle — including
 * hooks/lib/git-cmd.js — is installed alongside the extension for real
 * (mirrors OpenCode, whose native plugin also spawns the staged hooks/*.js
 * bundle). The require below is therefore the PRIMARY, live path in an
 * installed pi tree; the whitespace-split fallback stays as defense-in-depth
 * for a corrupted/partial install (e.g. a user who deleted hooks/lib/ by
 * hand) rather than the only-ever-taken path.
 * @param {string} rawArgs
 * @returns {{ family: string, subcommand?: string, args: string[] }}
 */
function parseGsdCommandArgs(rawArgs) {
  let tokenize;
  try {
    if (!SHARED_HOOKS_DIR) throw new Error('no staged hook bundle');
    ({ tokenize } = require(path.join(SHARED_HOOKS_DIR, 'lib', 'git-cmd.js')));
  } catch {
    tokenize = (s) => String(s || '').split(/\s+/).filter(Boolean);
  }
  const tokens = tokenize(typeof rawArgs === 'string' ? rawArgs : '');
  return {
    // Empty args → dispatch gsd-tools.cjs's own --help surface (a real,
    // working, ok:true default — NOT the 'query'/'help' pairing the original
    // #1944 cut used, which is not a valid gsd-tools.cjs command).
    family: tokens[0] || '--help',
    subcommand: tokens[1],
    args: tokens.slice(2),
  };
}

/**
 * Best-effort TypeBox schema for gsd_invoke's `parameters`, falling back to a
 * plain JSON-Schema object when the `typebox` package is unavailable (it is
 * NOT a gsd-core dependency — pi's own ExtensionAPI contract expects TypeBox,
 * but nothing in this repo installs it). TypeBox schemas ARE JSON Schema, so
 * the fallback object is structurally equivalent for hosts that accept plain
 * JSON Schema; this is a best-effort shim for the flat-file extension case.
 * @returns {object}
 */
function buildGsdInvokeParameters() {
  try {
    const typebox = require('typebox');
    const Type = typebox && typebox.Type;
    if (Type) {
      return Type.Object({
        family: Type.String(),
        subcommand: Type.Optional(Type.String()),
        args: Type.Optional(Type.Array(Type.String())),
      });
    }
  } catch {
    // typebox is not installed in this environment — fall through to the
    // plain JSON-Schema fallback below. This is the normal path (typebox is
    // NOT a gsd-core dependency), so no warning is emitted (#3022).
  }
  return {
    type: 'object',
    properties: {
      family: { type: 'string' },
      subcommand: { type: 'string' },
      args: { type: 'array', items: { type: 'string' } },
    },
    required: ['family'],
  };
}

/**
 * Build the `before_provider_request` handler that steers pi's model
 * selection to GSD's tier-resolved id (modelMode: 'active' per
 * capabilities/pi/capability.json). GSD does NOT call `pi.registerProvider` —
 * that registers a NEW model provider; GSD's job here is only to pick a
 * tier-appropriate id AMONG pi's EXISTING built-in anthropic models, so
 * registerProvider would be the wrong primitive (it would wrongly add a fake
 * provider instead of steering the real one).
 *
 * v1 tier policy: GSD does not yet expose a per-turn/per-agent tier signal to
 * this event, so a conservative fixed default tier is used (parameterized —
 * default 'sonnet' — so a future richer signal, or a test, can override it).
 *
 * ASSUMPTION (flagged — verify against a live pi host): the event payload's
 * model field is named `model`, matching the anthropic-messages payload shape
 * (Context7-confirmed for the wire protocol; pi's own before_provider_request
 * event schema was not independently verifiable in this environment). If pi's
 * actual field name differs, this returns the WRONG key and pi's fail-open
 * default takes over only because bare-model-id mismatches degrade to
 * provider-level errors, not GSD-level ones — a discrepancy here needs a
 * live-host smoke test before shipping past this stage.
 *
 * Fail-open: any resolution failure (or a null/falsy resolved model — e.g. an
 * unrecognized tier) returns `undefined`, leaving pi's model choice untouched.
 * NEVER returns a payload with a missing/empty model id.
 *
 * @param {{ tier?: string }} [opts]
 * @returns {(event: object, ctx: object) => Promise<object|undefined>}
 */
function buildBeforeProviderRequestHandler({ tier = 'sonnet' } = {}) {
  return async function onBeforeProviderRequest(event, ctx) {
    try {
      const effectiveCwd = (ctx && ctx.cwd) || process.cwd();
      const { loadConfig } = require(path.join(GSD_CORE, 'bin', 'lib', 'config-loader.cjs'));
      const config = loadConfig(effectiveCwd);
      const overrides = (config && config.model_profile_overrides) || undefined;

      // #2460: FAIL-OPEN when the user has not explicitly configured
      // model_profile_overrides[runtime][tier]. pi is provider-agnostic
      // (kimi-coding, zai, openrouter, openai-codex, minimax, anthropic, …);
      // the built-in RUNTIME_PROFILE_MAP.pi.sonnet default is `claude-sonnet-5`,
      // an Anthropic-ecosystem assumption that is wrong for every non-Anthropic
      // provider. Returning the built-in default unconditionally rewrote every
      // outgoing request to a model the active provider did not know.
      //
      // resolveTierEntry falls back to the built-in catalog when no override is
      // present, so we cannot call it to detect "did the user opt in?" — we
      // inspect the override map directly. Only when the user has explicitly
      // set model_profile_overrides[runtime][tier] do we steer; otherwise we
      // return undefined and pi's chosen model flows through untouched.
      const userRaw = overrides && overrides.pi ? overrides.pi[tier] : undefined;
      // `''` is treated the same as null/undefined: an explicit empty-string
      // override is the user clearing a previously-set value, NOT opting in to
      // steering. Without this guard, `resolveTierEntry`'s falsy `if (userRaw)`
      // check would silently fall back to the built-in catalog and rewrite
      // payload.model to claude-sonnet-5 — re-introducing the exact bug this
      // handler exists to prevent.
      if (userRaw === undefined || userRaw === null || userRaw === '') {
        return undefined; // fail-open — leave pi's model untouched
      }

      const { resolveTierEntry } = require(path.join(GSD_CORE, 'bin', 'lib', 'model-resolver.cjs'));
      const entry = resolveTierEntry({ runtime: 'pi', tier, overrides });
      const modelId = entry && typeof entry.model === 'string' && entry.model.length > 0 ? entry.model : null;
      if (!modelId) return undefined; // fail-open — leave pi's model untouched
      const basePayload = (event && typeof event === 'object' && event.payload && typeof event.payload === 'object')
        ? event.payload
        : {};
      return { ...basePayload, model: modelId };
    } catch {
      return undefined; // fail-open on any resolution error
    }
  };
}

/**
 * Bounded subprocess bridge to GSD's Claude Code hook scripts. Mirrors
 * .opencode/plugins/gsd-core.js's `runHook` (SUBPROCESS-REUSE): spawns
 * `node <hooks/hookFile>` with the payload piped to stdin, on a bounded
 * timeout. NEVER throws — a missing hook file, a spawn error, or a timeout
 * all degrade to a silent-allow result so a hook problem can never block pi.
 * @param {string} hookFile  filename under the resolved shared-hook bundle, e.g. "gsd-context-monitor.js"
 * @param {object} payload
 * @param {{ timeout?: number, cwd?: string }} [opts]
 * @returns {{ stdout: string, exitCode: number, timedOut: boolean }}
 */
function runHook(hookFile, payload, opts = {}) {
  if (!SHARED_HOOKS_DIR) return { stdout: '', exitCode: 0, timedOut: false };
  const hookPath = path.join(SHARED_HOOKS_DIR, hookFile);
  if (!fs.existsSync(hookPath)) return { stdout: '', exitCode: 0, timedOut: false };
  const timeout = opts.timeout || 8000;
  let result;
  try {
    result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload || {}),
      encoding: 'utf8',
      timeout,
      cwd: opts.cwd || process.cwd(),
      windowsHide: true,
    });
  } catch {
    return { stdout: '', exitCode: 0, timedOut: false };
  }
  const stdout = (result && typeof result.stdout === 'string') ? result.stdout.trim() : '';
  const exitCode = (result && result.status != null) ? result.status : 0;
  return { stdout, exitCode, timedOut: !!(result && result.signal === 'SIGTERM') };
}

module.exports = function gsdPiExtension(pi) {
  if (!pi || typeof pi !== 'object') {
    throw new TypeError('gsdPiExtension: pi ExtensionAPI is required');
  }

  // ── /gsd command: dispatch through gsd-tools.cjs (subprocess-reuse) ──────
  pi.registerCommand('gsd', {
    description: 'Invoke a GSD command via the embedded engine (subprocess-reuse adapter).',
    getArgumentCompletions,
    handler: async (args, ctx) => {
      const cwd = (ctx && ctx.cwd) || process.cwd();
      // #3456: Pi's command dispatcher awaits the handler and DISCARDS its
      // return value (agent-session.ts: `await command.handler(args, ctx);
      // return true;`) — #3097's `{ content: [...] }` return was silently
      // dropped exactly like the pre-#3097 bare string. The ONLY command-
      // output mechanism Pi consumes is `ctx.ui.notify(message, type)`
      // (pi docs: extensions.md#piregistercommandname-options), so the output
      // is pushed as a side effect on both the success and error paths.
      // Guarded so a host ctx without `ui` degrades silently instead of
      // crashing the command.
      const notify = (ctx && ctx.ui && typeof ctx.ui.notify === 'function')
        ? (message, type) => ctx.ui.notify(message, type)
        : null;
      const { family, subcommand, args: rest } = parseGsdCommandArgs(args);
      let dispatchGsdCommand;
      try {
        ({ dispatchGsdCommand } = require(path.join(GSD_CORE, 'bin', 'lib', 'shell-command-projection.cjs')));
      } catch (e) {
        if (notify) {
          notify(`GSD engine unavailable: ${e && e.message ? e.message : String(e)}`, 'error');
        }
        return;
      }
      const result = dispatchGsdCommand({ family, subcommand, args: rest, cwd });
      const text = result.ok
        ? result.stdout
        : `GSD error: ${result.stderr || result.stdout || `dispatch failed (exit ${result.code})`}`;
      if (notify) {
        notify(text, result.ok ? 'info' : 'error');
      }
    },
  });

  // ── gsd_invoke tool: programmatic command invocation ────────────────────
  pi.registerTool({
    name: 'gsd_invoke',
    label: 'GSD Invoke',
    description: 'Invoke a GSD command family/subcommand through the engine.',
    parameters: buildGsdInvokeParameters(),
    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      const p = (params && typeof params === 'object') ? params : {};
      const family = typeof p.family === 'string' ? p.family : '';
      if (!family) {
        return { content: [{ type: 'text', text: 'gsd_invoke requires a non-empty string "family".' }] };
      }
      const subcommand = typeof p.subcommand === 'string' ? p.subcommand : undefined;
      const invokeArgs = Array.isArray(p.args) ? p.args : [];
      const cwd = (ctx && ctx.cwd) || process.cwd();
      let dispatchGsdCommand;
      try {
        ({ dispatchGsdCommand } = require(path.join(GSD_CORE, 'bin', 'lib', 'shell-command-projection.cjs')));
      } catch (e) {
        return { content: [{ type: 'text', text: `GSD engine unavailable: ${e && e.message ? e.message : String(e)}` }] };
      }
      const result = dispatchGsdCommand({ family, subcommand, args: invokeArgs, cwd });
      const text = result.ok ? result.stdout : (result.stderr || result.stdout || `dispatch failed (exit ${result.code})`);
      return { content: [{ type: 'text', text }] };
    },
  });

  // ── before_provider_request: active-model steering (modelMode: 'active') ──
  // GSD steers pi's EXISTING built-in anthropic models; it does NOT call
  // pi.registerProvider (that would wrongly register a NEW fake provider —
  // see buildBeforeProviderRequestHandler's doc comment).
  pi.on('before_provider_request', buildBeforeProviderRequestHandler());

  // ── Event bindings: bounded subprocess bridge to GSD's hook scripts ──────
  // Each binding fails open — a hook error/timeout/missing-file never blocks
  // pi (mirrors .opencode/plugins/gsd-core.js's runHook SUBPROCESS-REUSE
  // pattern, applied to pi's ExtensionAPI event names).

  // session_start → SessionStart-equivalent bootstrap.
  pi.on('session_start', async (event, ctx) => {
    try {
      const cwd = (ctx && ctx.cwd) || process.cwd();
      runHook('gsd-ensure-canonical-path.js', { hook_event_name: 'SessionStart', cwd }, { cwd });
    } catch { /* fail-open */ }
  });

  // before_agent_start → workflow-guard bridge. Forward-compatible binding:
  // gsd-workflow-guard.js's current triggers are tool-scoped (Write/Edit/
  // Bash via tool_name/tool_input), so with no tool_name in the payload it
  // fires as a safe no-op today — wired so a future agent-start-scoped check
  // can attach without a plugin change (mirrors the OpenCode session.idle
  // recognized-but-unused sentinel pattern).
  pi.on('before_agent_start', async (event, ctx) => {
    try {
      const cwd = (ctx && ctx.cwd) || process.cwd();
      runHook('gsd-workflow-guard.js', { hook_event_name: 'before_agent_start', cwd }, { cwd });
    } catch { /* fail-open */ }
  });

  // session_before_compact → PreCompact-equivalent (context-usage bridge).
  pi.on('session_before_compact', async (event, ctx) => {
    try {
      const cwd = (ctx && ctx.cwd) || process.cwd();
      runHook('gsd-context-monitor.js', { hook_event_name: 'PreCompact', cwd }, { cwd });
    } catch { /* fail-open */ }
  });

  // tool_call event: lifecycle hook bridge attachment point (kept from the
  // original cut — the PreToolUse/PostToolUse tool_name/tool_input mapping
  // is a follow-up once pi's tool_call payload shape is verified against a
  // live host).
  pi.on('tool_call', async function () {
    /* GSD hook bridge attachment point (PreToolUse/PostToolUse mapping). */
  });
};

// Test-only internals (mirrors the OpenCode plugin pattern) — wired to the
// real functions (not stubs) so tests can exercise parsing/completions/model
// resolution WITHOUT a live pi runtime.
module.exports._internals = {
  resolveEngineRoot,
  resolveSharedHooksDir,
  SHARED_HOOKS_DIR_CANDIDATES,
  parseGsdCommandArgs,
  getArgumentCompletions,
  PI_COMMAND_FAMILIES,
  buildBeforeProviderRequestHandler,
  buildGsdInvokeParameters,
  runHook,
};
