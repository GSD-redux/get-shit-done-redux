/**
 * GSD plugin for OpenCode.ai  (CommonJS)
 *
 * Architecture: SUBPROCESS REUSE. Instead of re-implementing hook logic inside
 * the plugin, this file is a thin adapter that spawns the existing Claude Code
 * hook scripts under hooks/ as child processes. The hooks speak a stable
 * protocol (JSON on stdin, JSON + exit code on stdout); this adapter:
 *   1. Translates OpenCode plugin events into Claude Code hook payloads
 *   2. Spawns `node <HOOKS_DIR>/<hook>.js` with the payload on stdin
 *   3. Translates hook output back into OpenCode semantics
 *      - block  → throw Error (OpenCode returns the error to the model)
 *      - advisory → output.metadata + console.error (best-effort surfacing)
 *
 * Namespace conversion (/gsd:xxx → /gsd-xxx) reuses scripts/fix-slash-commands.cjs
 * via require(), keeping the single source of truth.
 *
 * ── Two distribution shapes, one adapter (issue #1914) ─────────────────────
 * This single file serves both distribution paths, distinguished at load time
 * by REPO_ROOT (path.resolve(__dirname, "../..")):
 *
 *   • Option 1 — file copy (the supported GSD path). `bin/install.js` copies
 *     this file to <opencodeConfigDir>/plugins/gsd-core.js, so REPO_ROOT is the
 *     OpenCode config dir. GSD's own install already stages `hooks/*.js` and
 *     `gsd-core/` there (ADR-857 skips hook *registration* for OpenCode, not the
 *     file copy), so the hook bridge and content rewriting resolve natively.
 *     Commands/agents/skills are ALREADY registered by GSD's native file copy in
 *     this mode, so the plugin's own config-hook registration is redundant and is
 *     SKIPPED (see IS_PACKAGE_TREE) to avoid double-registration.
 *
 *   • Option 2 — package / git-spec. When loaded from the package tree (npm
 *     `main`, or an OpenCode git-spec install), REPO_ROOT is the package root and
 *     the source layout (commands/gsd/, agents/, skills/) is present. Here the
 *     plugin IS the sole registrar, so it registers commands/agents/skills too.
 *
 * IS_PACKAGE_TREE keys off the presence of the SOURCE command layout
 * (commands/gsd/), which only exists in the package tree — never in an installed
 * config dir (that uses the flattened command/ layout). The hook bridge and
 * Read-time content rewriting run in BOTH modes; only the config-hook
 * registration of commands/agents/skills is gated.
 *
 * Runtime-specific hooks are deliberately excluded:
 *   - gsd-statusline.js / gsd-update-banner.js (Claude Code statusline)
 *   - gsd-cursor-*.js (Cursor-specific)
 *   - *.sh scripts (invoked directly by commands/agents, not hook events)
 */

"use strict";

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawnSync } = require("child_process");

// Resolve REPO_ROOT to the directory that actually holds the GSD payload
// (hooks/ + gsd-core/). This must work across three physical layouts because a
// single adapter file serves both distribution shapes (see header):
//   • package/git-spec tree:  <root>/.opencode/plugins/gsd-core.js   → <root>
//   • global file-copy:       ~/.config/opencode/plugins/gsd-core.js → ~/.config/opencode
//   • local file-copy:        <proj>/.opencode/plugins/gsd-core.js   → <proj>/.opencode
// A fixed "../.." only works for the first; the copied layouts sit one level
// shallower. Walking up to the first ancestor containing BOTH payload markers
// resolves all three deterministically. Falls back to the package-tree
// assumption ("../..") if no ancestor matches (keeps graceful degradation).
function resolveRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (
      fs.existsSync(path.join(dir, "hooks")) &&
      fs.existsSync(path.join(dir, "gsd-core"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // filesystem root
    dir = parent;
  }
  // No ancestor carried both markers (broken/partial layout — the plugin can't
  // function regardless). Fall back to the package-tree assumption ("../.."),
  // matching the historical fixed-depth behavior and the .opencode/plugins/
  // source layout.
  return path.resolve(startDir, "../..");
}

// CJS: __dirname is a global, no need to derive from import.meta.url
const REPO_ROOT = resolveRepoRoot(__dirname);
const HOOKS_DIR = path.join(REPO_ROOT, "hooks");
const COMMANDS = path.join(REPO_ROOT, "commands", "gsd");
const AGENTS = path.join(REPO_ROOT, "agents");
const SKILLS = path.join(REPO_ROOT, "skills");
const GSD_CORE = path.join(REPO_ROOT, "gsd-core");

// True only when loaded from the package/source tree (Option 2), detected by the
// presence of the SOURCE command layout (commands/gsd/). In an installed OpenCode
// config dir (Option 1) this directory is absent — the flattened command/ layout
// is used instead — so the plugin skips its own command/agent/skill registration
// and lets GSD's native file copy own that surface (avoids double-registration).
const IS_PACKAGE_TREE = fs.existsSync(COMMANDS);

// ---------------------------------------------------------------------------
// Namespace conversion — reuse the single source of truth
// ---------------------------------------------------------------------------

let _cmdNames = null;
let _transformFn = null;

/**
 * Lazily load scripts/fix-slash-commands.cjs and cache the transform function
 * + command name list. Returns null if the module is unavailable (the plugin
 * still works, just without namespace conversion).
 */
function getNamespaceConverter() {
  if (_transformFn) return _transformFn;
  try {
    const mod = require(
      path.join(REPO_ROOT, "scripts", "fix-slash-commands.cjs"),
    );
    _cmdNames = mod.readCmdNames();
    _transformFn = mod.transformContentToHyphen;
    return _transformFn;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Session state — tracked across plugin hook invocations
// ---------------------------------------------------------------------------

let currentSessionId = null;
let currentCwd = process.cwd();

// ---------------------------------------------------------------------------
// Tool name / argument mapping  (OpenCode ↔ Claude Code)
// ---------------------------------------------------------------------------

const TOOL_NAME_MAP = {
  read: "Read",
  write: "Write",
  edit: "Edit",
  apply_patch: "MultiEdit",
  multi_edit: "MultiEdit",
  bash: "Bash",
  webfetch: "WebFetch",
  web_search: "WebSearch",
  websearch: "WebSearch",
  task: "Task",
  subagent: "Task",
};

function mapToolName(tool) {
  if (!tool) return "";
  return TOOL_NAME_MAP[String(tool).toLowerCase()] || tool;
}

// Build a Claude-style `tool_input` object from OpenCode's `output.args`.
function mapToolInput(args) {
  const input = {};
  if (!args || typeof args !== "object") return input;

  // File-path keys (OpenCode uses filePath/path; Claude uses file_path)
  const filePath = args.filePath || args.path || args.file_path;
  if (filePath) input.file_path = filePath;

  // Content for Write
  if (args.content !== undefined) input.content = args.content;

  // Edit patch fields
  if (args.new_string !== undefined) input.new_string = args.new_string;
  if (args.newString !== undefined) input.new_string = args.newString;
  if (args.old_string !== undefined) input.old_string = args.old_string;
  if (args.oldString !== undefined) input.old_string = args.oldString;

  // Bash command
  if (args.command !== undefined) input.command = args.command;

  // Web
  if (args.url !== undefined) input.url = args.url;
  if (args.query !== undefined) input.query = args.query;

  return input;
}

// ---------------------------------------------------------------------------
// Hook subprocess runner
// ---------------------------------------------------------------------------

/**
 * Spawn a Claude Code hook script and pipe a JSON payload to its stdin.
 *
 * Hooks follow the convention:
 *   - stdout: JSON object (decision/advisory) or empty
 *   - exit 0: allow (with optional advisory JSON on stdout)
 *   - exit 2: block (Claude convention; reason in stdout JSON)
 *   - any error: exit 0 silently (hooks swallow their own errors)
 *
 * @param {string} hookFile  filename under hooks/, e.g. "gsd-prompt-guard.js"
 * @param {object} payload   stdin JSON (hook_event_name, tool_name, ...)
 * @param {object} [opts]
 * @param {number} [opts.timeout=8000] spawn timeout in ms
 * @param {string} [opts.cwd]         working directory for the child
 * @returns {{ stdout: string, exitCode: number, timedOut: boolean }}
 */
const warnedMissingHooks = new Set();

function runHook(hookFile, payload, opts = {}) {
  const hookPath = path.join(HOOKS_DIR, hookFile);
  if (!fs.existsSync(hookPath)) {
    // A missing guard script means the guard is silently NOT enforced — the
    // exact failure mode of #2305 (plugin staged, hooks bundle not). Never
    // break the tool call (the adapter's design contract), but never be
    // silent about it either: warn loudly, once per hook file.
    if (!warnedMissingHooks.has(hookFile)) {
      warnedMissingHooks.add(hookFile);
      console.error(
        `[gsd-core] hook script missing: ${hookPath} — ${hookFile} is NOT ` +
          "enforced. The GSD install may be incomplete; reinstall (or run " +
          "/gsd-update) to restage the hooks/ bundle.",
      );
    }
    return { stdout: "", exitCode: 0, timedOut: false };
  }
  const timeout = opts.timeout ?? 8000;
  let result;
  try {
    result = spawnSync(process.execPath, [hookPath], {
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout,
      cwd: opts.cwd || currentCwd,
      windowsHide: true,
    });
  } catch {
    // Spawn failure — never break the tool call
    return { stdout: "", exitCode: 0, timedOut: false };
  }

  const stdout = (result.stdout || "").trim();
  const exitCode = result.status == null ? 0 : result.status;
  return { stdout, exitCode, timedOut: result.signal === "SIGTERM" };
}

/**
 * In-process check for whether context-usage warnings are disabled in project
 * config. Mirrors the exact semantics of the same check inside
 * hooks/gsd-context-monitor.js (introduced by #1073): an explicit
 * `config.hooks.context_warnings === false` disables them; a missing or
 * unparseable .planning/config.json keeps them enabled (the default).
 *
 * #2697: hoisting this check in-process lets the adapter SKIP the context-monitor
 * spawn entirely when the user has opted out, instead of paying a full Node boot
 * inside the child only to read the boolean and exit. Missing/unparseable config
 * MUST behave identically to the hook (enabled) so the default path is unchanged.
 *
 * @param {string} cwd  project working directory (the plugin's currentCwd)
 * @returns {boolean} true when context warnings are explicitly disabled
 */
function contextWarningsDisabled(cwd) {
  try {
    const configPath = path.join(cwd, '.planning', 'config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config.hooks?.context_warnings === false;
  } catch {
    // Missing or unparseable config → proceed with defaults (context warnings enabled).
    return false;
  }
}

// ---------------------------------------------------------------------------
// Hook output translation → OpenCode semantics
// ---------------------------------------------------------------------------

/**
 * Parse a hook's stdout and apply its effect to the OpenCode output object.
 *
 * - Block   → throw Error(parsed.reason) so OpenCode aborts the tool call
 * - Advisory→ append to output.metadata._gsdAdvisory[] and log to stderr
 * - Silent  → no-op
 *
 * @param {{ stdout: string, exitCode: number }} hookResult
 * @param {object} [output]  OpenCode mutable output object (optional)
 */
function handleHookResult(hookResult, output) {
  const { stdout, exitCode } = hookResult;
  if (!stdout && exitCode !== 2) return; // silent allow

  let parsed = null;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      // Non-JSON stdout (e.g. a stray log) — treat exit 2 as hard block, else allow
    }
  }

  // Block: explicit decision OR Claude exit-code-2 convention
  const isBlock = exitCode === 2 || (parsed && parsed.decision === "block");
  if (isBlock) {
    const reason =
      (parsed && parsed.reason) || "Blocked by GSD hook (no reason provided).";
    throw new Error(reason);
  }

  // Advisory: inject additionalContext into metadata + log
  const advisory =
    parsed &&
    parsed.hookSpecificOutput &&
    parsed.hookSpecificOutput.additionalContext;
  if (advisory) {
    if (output) {
      output.metadata = output.metadata || {};
      // Accumulate: a single tool call can run several advisory hooks in
      // sequence (prompt guard, read guard, worktree guard, workflow guard).
      // Storing a scalar would let a later advisory clobber an earlier one, so
      // collect them all.
      if (!Array.isArray(output.metadata._gsdAdvisory)) {
        output.metadata._gsdAdvisory = [];
      }
      output.metadata._gsdAdvisory.push(advisory);
    }
    // Best-effort visibility when metadata isn't surfaced to the model
    console.error(advisory);
  }
}

// ---------------------------------------------------------------------------
// Frontmatter helpers (for config registration)
// ---------------------------------------------------------------------------

function parseFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: content };
  const fm = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) {
      let v = line.slice(i + 1).trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      fm[line.slice(0, i).trim()] = v;
    }
  }
  return { frontmatter: fm, body: m[2] };
}

// Rewrite @~/.claude/ includes to point at the repo root.
// Also applies /gsd:xxx → /gsd-xxx namespace conversion via the shared
// transform from scripts/fix-slash-commands.cjs (single source of truth).
function rewriteRefs(content) {
  let out = content.replace(/@~\/\.claude\//g, `@${REPO_ROOT}/`);
  const transform = getNamespaceConverter();
  if (transform && _cmdNames && _cmdNames.length) {
    out = transform(out, _cmdNames);
  }
  return out;
}

function loadDir(dir, keyFn, valFn) {
  const result = {};
  if (!fs.existsSync(dir)) return result;
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    const raw = fs.readFileSync(path.join(dir, f), "utf8");
    const { frontmatter, body } = parseFrontmatter(raw);
    result[keyFn(f)] = valFn(body, frontmatter, f);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Runtime content transform — for Read tool results on GSD-managed files
// ---------------------------------------------------------------------------

// Directories whose .md files may contain ~/.claude/ paths and gsd: namespace
// refs. When the model reads these via the Read tool, we transparently rewrite
// both so OpenCode sees correct paths and hyphen-form command names.
const GSD_MANAGED_DIRS = [
  path.join(GSD_CORE, "workflows"),
  path.join(GSD_CORE, "references"),
  path.join(GSD_CORE, "templates"),
  path.join(GSD_CORE, "contexts"),
  COMMANDS,
  AGENTS,
  SKILLS,
];

function isGsdManagedFile(filePath) {
  if (!filePath) return false;
  const resolved = path.resolve(filePath);
  return GSD_MANAGED_DIRS.some(
    (dir) => resolved === dir || resolved.startsWith(dir + path.sep),
  );
}

// Rewrite content for OpenCode consumption:
//   1. @-include paths:  @~/.claude/  →  @<REPO_ROOT>/
//   2. plain-text paths: ~/.claude/gsd-core/  →  <GSD_CORE>/
//   3. namespace:        gsd:xxx  →  gsd-xxx  (via fix-slash-commands.cjs)
function rewriteContent(content) {
  let out = content;
  out = out.replace(/@~\/\.claude\//g, `@${REPO_ROOT}/`);
  out = out.replace(/~\/\.claude\/gsd-core\//g, `${GSD_CORE}/`);
  const transform = getNamespaceConverter();
  if (transform && _cmdNames && _cmdNames.length) {
    out = transform(out, _cmdNames);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Skills cache — copy SKILL.md files with rewritten @-include paths
// ---------------------------------------------------------------------------
//
// OpenCode's skill loader reads SKILL.md files directly from disk and resolves
// @-includes internally — this bypasses our tool.execute hooks. To make
// @~/.claude/gsd-core/... includes resolve, we copy all SKILL.md files to a
// cache directory with paths rewritten to the actual GSD_CORE location.
//
// Only used in package-tree mode (Option 2). In an installed OpenCode config
// dir (Option 1) skills are already staged + registered by GSD's native file
// copy, so we never register skills from the plugin (see IS_PACKAGE_TREE).

const SKILLS_CACHE = path.join(
  os.homedir(),
  ".cache",
  "opencode",
  "gsd-skills",
);

function prepareSkillsCache() {
  if (!fs.existsSync(SKILLS)) return null;
  fs.mkdirSync(SKILLS_CACHE, { recursive: true });
  for (const dir of fs.readdirSync(SKILLS)) {
    const srcFile = path.join(SKILLS, dir, "SKILL.md");
    if (!fs.existsSync(srcFile)) continue;
    const raw = fs.readFileSync(srcFile, "utf8");
    // Rewrite @-include paths only; namespace conversion is handled at
    // Read-time via tool.execute.after for workflow/reference files.
    const rewritten = raw
      .replace(/@~\/\.claude\/gsd-core\//g, `@${GSD_CORE}/`)
      .replace(/~\/\.claude\/gsd-core\//g, `${GSD_CORE}/`);
    const destDir = path.join(SKILLS_CACHE, dir);
    fs.mkdirSync(destDir, { recursive: true });
    fs.writeFileSync(path.join(destDir, "SKILL.md"), rewritten);
  }
  return SKILLS_CACHE;
}

// ===========================================================================
// Plugin entry
// ===========================================================================

const GsdCorePlugin = async ({ directory } = {}) => {
  if (directory) currentCwd = directory;

  return {
    // ── Config: register commands / agents / skills paths ──────────────
    // Only in package-tree mode (Option 2). In an installed config dir
    // (Option 1) GSD's native file copy already registered these, so the
    // plugin stays out of registration to avoid double-registering.
    config: async (config) => {
      if (!IS_PACKAGE_TREE) return;

      // Commands (commands/gsd/*.md → gsd-<name>)
      config.command = config.command || {};
      const cmds = loadDir(
        COMMANDS,
        (f) => "gsd-" + f.slice(0, -3),
        (body, fm, name) => ({
          template: rewriteRefs(body.trim()),
          description: fm.description || `GSD ${name.slice(0, -3)} command`,
        }),
      );
      for (const [k, v] of Object.entries(cmds)) {
        if (!config.command[k]) config.command[k] = v;
      }

      // Agents (agents/*.md)
      config.agent = config.agent || {};
      const agents = loadDir(
        AGENTS,
        (f) => f.slice(0, -3),
        (body, fm, name) => ({
          prompt: rewriteRefs(body.trim()),
          description: fm.description || `GSD ${name.slice(0, -3)} agent`,
          mode: fm.mode || "subagent",
        }),
      );
      for (const [k, v] of Object.entries(agents)) {
        if (!config.agent[k]) config.agent[k] = v;
      }

      // Skills — copy SKILL.md files to cache with rewritten @-include paths,
      // then register the cache directory. OpenCode's skill loader reads
      // SKILL.md from disk and resolves @-includes internally (bypassing our
      // tool.execute hooks), so we must pre-process the files.
      const skillsCache = prepareSkillsCache();
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      const skillsPath = skillsCache || SKILLS;
      if (!config.skills.paths.includes(skillsPath)) {
        config.skills.paths.push(skillsPath);
      }
    },

    // ── shell.env ───────────────────────────────────────────────────────
    "shell.env": async (_input, output) => {
      output.env = output.env || {};
      output.env.GSD_DIR = GSD_CORE;
    },

    // ── tool.execute.before — PreToolUse hooks ─────────────────────────
    "tool.execute.before": async (input, output) => {
      const claudeTool = mapToolName(input.tool);
      const toolInput = mapToolInput(output.args || {});
      const cwd = currentCwd;

      // 0. Read path rewrite — redirect ~/.claude/gsd-core/ to actual GSD_CORE
      //    so the model can read workflow/reference/template files that SKILL.md
      //    and command templates reference via the canonical Claude path.
      if (claudeTool === "Read" && toolInput.file_path) {
        const original = toolInput.file_path;
        const rewritten = original
          .replace(/^~\/\.claude\/gsd-core\//, GSD_CORE + "/")
          .replace(/(?:.*)\/\.claude\/gsd-core\//, GSD_CORE + "/");
        if (rewritten !== original) {
          const args = output.args || {};
          if (args.filePath) args.filePath = rewritten;
          else if (args.path) args.path = rewritten;
          else if (args.file_path) args.file_path = rewritten;
          else args.filePath = rewritten;
        }
      }

      const basePayload = {
        hook_event_name: "PreToolUse",
        cwd,
      };
      // NOTE: session_id intentionally omitted for PreToolUse hooks.
      // gsd-read-guard.js treats a non-empty session_id as a Claude Code
      // session and skips its advisory. On OpenCode we WANT the advisory.
      const prePayload = (overrides = {}) => ({
        ...basePayload,
        tool_name: claudeTool,
        tool_input: toolInput,
        ...overrides,
      });

      const isWriteLike = ["Write", "Edit", "MultiEdit"].includes(claudeTool);

      // 1. gsd-prompt-guard.js — injection scan on .planning/ writes
      if (claudeTool === "Write" || claudeTool === "Edit") {
        const r = runHook("gsd-prompt-guard.js", prePayload());
        handleHookResult(r, output);
      }

      // 2. gsd-read-guard.js — read-before-edit advisory
      if (claudeTool === "Write" || claudeTool === "Edit") {
        const r = runHook("gsd-read-guard.js", prePayload());
        handleHookResult(r, output);
      }

      // 3. gsd-worktree-path-guard.js — hard-block edits outside worktree
      if (isWriteLike) {
        const r = runHook("gsd-worktree-path-guard.js", prePayload());
        handleHookResult(r, output);
      }

      // 4. gsd-workflow-guard.js — workflow advisory + git-force-add block
      //    (covers Write/Edit/MultiEdit AND Bash force-add detection)
      if (isWriteLike || claudeTool === "Bash") {
        const r = runHook("gsd-workflow-guard.js", prePayload());
        handleHookResult(r, output);
      }
    },

    // ── tool.execute.after — PostToolUse hooks ─────────────────────────
    "tool.execute.after": async (input, output) => {
      const claudeTool = mapToolName(input.tool);
      // NOTE: In the `after` hook, `args` lives on `input` (not `output`).
      // The `output` object only has { title, output, metadata }.
      const toolInput = mapToolInput(input.args || {});
      const cwd = currentCwd;

      // GSD content transform — rewrite paths + namespace in Read results
      // BEFORE injection scanning so the scanner sees the final content.
      if (
        claudeTool === "Read" &&
        output.output &&
        isGsdManagedFile(toolInput.file_path)
      ) {
        const content =
          typeof output.output === "string"
            ? output.output
            : String(output.output);
        output.output = rewriteContent(content);
      }

      // gsd-read-injection-scanner.js — scan Read/WebFetch/WebSearch results
      if (
        claudeTool === "Read" ||
        claudeTool === "WebFetch" ||
        claudeTool === "WebSearch"
      ) {
        const payload = {
          hook_event_name: "PostToolUse",
          tool_name: claudeTool,
          tool_input: toolInput,
          tool_response: output.output,
          cwd,
        };
        const r = runHook("gsd-read-injection-scanner.js", payload);
        handleHookResult(r, output);
        return;
      }

      // gsd-context-monitor.js — context usage warnings (Bash/Edit/Write/Task/...)
      // Only meaningful when a session_id is tracked (writes metrics sentinel).
      // #2697: skip the subprocess spawn entirely when context warnings are
      // explicitly disabled in project config — the hook would exit early anyway,
      // so hoisting the check in-process avoids paying a Node boot per tool call.
      // Missing/unparseable config = enabled (default), so the spawn still runs.
      if (currentSessionId && !contextWarningsDisabled(cwd)) {
        const payload = {
          hook_event_name: "PostToolUse",
          tool_name: claudeTool,
          tool_input: toolInput,
          session_id: currentSessionId,
          cwd,
        };
        const r = runHook("gsd-context-monitor.js", payload);
        handleHookResult(r, output);
      }
    },

    // ── experimental.session.compacting — PreCompact ───────────────────
    "experimental.session.compacting": async (_input, output) => {
      if (!currentSessionId) return;
      const payload = {
        hook_event_name: "PreCompact",
        session_id: currentSessionId,
        cwd: currentCwd,
      };
      const r = runHook("gsd-context-monitor.js", payload);
      handleHookResult(r, output);

      // Also inject a GSD compaction breadcrumb (mirrors the original plugin)
      output.context = output.context || [];
      output.context.push(
        `[GSD] Active session: ${currentSessionId}. Preserve any in-flight phase/plan state.`,
      );
    },

    // ── General event subscriptions ─────────────────────────────────────
    event: async ({ event }) => {
      // session.created → SessionStart hooks
      if (event.type === "session.created") {
        // Track session for context-monitor payloads.
        // SDK type EventSessionCreated: { properties: { info: Session } }
        // Session has `id` and `directory` (not `cwd`).
        const info = event.properties?.info;
        currentSessionId =
          info?.id || event.sessionID || event.session_id || null;
        if (info?.directory) currentCwd = info.directory;

        // gsd-ensure-canonical-path.js — no stdin dependency; silent
        runHook("gsd-ensure-canonical-path.js", {
          hook_event_name: "SessionStart",
          session_id: currentSessionId,
          cwd: currentCwd,
        });
        // gsd-check-update.js — spawns its own background worker; no stdin
        runHook("gsd-check-update.js", {
          hook_event_name: "SessionStart",
          session_id: currentSessionId,
          cwd: currentCwd,
        });
        return;
      }

      // file.edited → FileChanged hook (config.json reload)
      if (event.type === "file.edited") {
        // SDK type EventFileEdited: { properties: { file: string } }
        const filePath = event.properties?.file || event.filePath || "";
        if (!filePath.endsWith("config.json")) return;
        const cwd = event.properties?.cwd || currentCwd;
        const expected = path.join(cwd, ".planning", "config.json");
        if (path.resolve(filePath) !== path.resolve(expected)) return;

        const payload = {
          hook_event_name: "FileChanged",
          file_path: filePath,
          event: "change",
          cwd,
        };
        const r = runHook("gsd-config-reload.js", payload);
        // Advisory-only (additionalContext); surface to logs
        handleHookResult(r);
        return;
      }

      // session.idle ↔ Claude Stop lifecycle point (#1682 Slice 1b/c).
      // OpenCode fires session.idle when the run quiesces. GSD maps it to the
      // Stop equivalent — the opencode-subset lifecycle peer of compaction
      // (compaction preserves state across context-window summarization; idle
      // marks end-of-turn). No-op sentinel today (GSD state is already
      // persisted to .planning/), but it MUST be recognized so the declared
      // opencode-subset surface is fully wired and a future Stop-class hook can
      // attach without a plugin change.
      if (event.type === "session.idle") {
        return;
      }

      // permission.asked / permission.replied — OpenCode permission lifecycle
      // (#2087, opencode.ai/docs/plugins). GSD gates tool INPUTS at
      // tool.execute.before (read-guard, injection-scanner); the permission
      // grant/deny decision itself carries no GSD workflow-phase contribution,
      // so these are recognized sentinels — wired so a future permission-aware
      // gate can attach without a plugin change (the engine owns phase
      // sequencing; this host bus is session/tool/permission-scoped, never
      // phase-scoped — ADR-1239 §OpenCode).
      if (event.type === "permission.asked" || event.type === "permission.replied") {
        return;
      }

      // session.error — OpenCode session-error lifecycle point (#2087). No GSD
      // hook fires here today (loop state is already persisted to .planning/);
      // recognized so the declared extension-event surface is fully wired and a
      // future error-class hook can attach without a plugin change.
      if (event.type === "session.error") {
        return;
      }
    },
  };
};

// Export shape — verified against OpenCode's plugin loader source
// (packages/opencode/src/plugin). The loader imports this module and runs
// `for (const entry of Object.values(mod)) { getServerPlugin(entry) }`, where
// `getServerPlugin` accepts a bare function OR an object exposing a `.server`
// function, and THROWS `TypeError("Plugin export is not a function")` for
// anything else. So EVERY enumerable value the loader iterates must be a
// function or an object with `.server`.
//
// The subtlety: depending on how OpenCode's runtime (Node or Bun) imports a
// CommonJS file, `mod` may be the raw `module.exports` OR an ESM namespace of
// the form `{ default: module.exports, ...syntheticNamedExports }`. A plain
// `module.exports = { id: "gsd-core", server }` literal risks a string `id`
// appearing in `Object.values(mod)` (as a raw property, or as a lexer-
// synthesized named export) — which would trip the throw. Two defenses:
//   1. `id` is defined NON-ENUMERABLE, so it never appears in Object.values yet
//      stays readable (via property access) for the loader's identity/dedup.
//   2. `module.exports` is assigned from a VARIABLE (not an object literal), so
//      cjs-module-lexer cannot statically synthesize named exports from it —
//      only `default` is exposed under ESM/Bun interop.
// Result: raw-CJS `Object.values` = `[server]`; ESM `Object.values` =
// `[{server, <id non-enum>}]` — both fully extractable. Test-only helpers hang
// off the `server` FUNCTION (`server._internals`), never as a sibling export.
GsdCorePlugin._internals = {
  REPO_ROOT,
  IS_PACKAGE_TREE,
  mapToolName,
  mapToolInput,
  parseFrontmatter,
  rewriteContent,
  isGsdManagedFile,
  handleHookResult,
  GsdCorePlugin,
};

const gsdCorePluginExport = { server: GsdCorePlugin };
Object.defineProperty(gsdCorePluginExport, "id", {
  value: "gsd-core",
  enumerable: false,
  writable: false,
  configurable: false,
});
module.exports = gsdCorePluginExport;
