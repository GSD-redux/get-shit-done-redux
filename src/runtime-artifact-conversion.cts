/* eslint-disable @typescript-eslint/ban-ts-comment,
                  @typescript-eslint/no-require-imports,
                  @typescript-eslint/no-unsafe-assignment,
                  @typescript-eslint/no-unsafe-member-access,
                  @typescript-eslint/no-unsafe-return,
                  @typescript-eslint/no-unsafe-call,
                  @typescript-eslint/no-unsafe-argument */
// Mechanical extraction from bin/install.js; keep behavior parity before typing.
// @ts-nocheck
'use strict';
/**
 * Runtime Artifact Conversion Module.
 *
 * First slice: layout-reached command/skill artifact converters moved out of
 * bin/install.js so Runtime Artifact Layout no longer reaches through the
 * Installer Module for conversion behavior.
 */

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import commandRoster = require('./command-roster.cjs');
const { readGsdCommandNames, transformContentToHyphen } = commandRoster;
import runtimeNamePolicy = require('./runtime-name-policy.cjs');
const { getDirName } = runtimeNamePolicy;
import capabilityRegistry = require('./capability-registry.cjs');
import { posixNormalize } from './shell-command-projection.cjs';

// #1383: resolve GSD's version WITHOUT a top-level
// `require('../../../package.json')`. That require ran at module load on every
// gsd-tools invocation (this module sits in the gsd-tools loader chain) and
// threw `Cannot find module '../../../package.json'` on runtimes whose root has
// no package.json — notably Codex, where the installer omits the synthetic root
// package.json — taking the entire CLI down before it did anything. And even
// where it resolved (Claude's synthetic `{"type":"commonjs"}`), there is no
// `version` field, so the single consumer below already emitted
// `version: undefined`. Resolve lazily and defensively instead:
//   1. Installed trees carry <root>/gsd-core/VERSION (written by the installer);
//      this module lives at <root>/gsd-core/bin/lib, so VERSION is two dirs up.
//   2. The source / npm-package tree has no gsd-core/VERSION but carries a real
//      package.json three dirs up — read it lazily, never at module-load time.
// A failed/invalid lookup degrades to '' (the caller omits the field) rather
// than crashing or emitting `version: undefined`. Both sources are validated
// against the same semver shape the repo's other VERSION reader enforces
// (src/update-context.cts) so a garbled VERSION file is never emitted verbatim.
// Exported for the #1383 regression.
const SEMVER_PREFIX = /^\d+\.\d+\.\d+/; // mirrors src/update-context.cts SEMVER_PREFIX
function resolveVersionFrom(libDir: string): string {
  try {
    const v = fs.readFileSync(path.join(libDir, '..', '..', 'VERSION'), 'utf8').trim();
    if (SEMVER_PREFIX.test(v)) return v;
  } catch { /* not an installed tree (no gsd-core/VERSION) */ }
  try {
    const pkg = require(path.join(libDir, '..', '..', '..', 'package.json'));
    if (pkg && typeof pkg.version === 'string' && SEMVER_PREFIX.test(pkg.version)) return pkg.version;
  } catch { /* runtime root has no package.json (e.g. Codex) */ }
  return '';
}

let cachedVersion: string | undefined;
function gsdVersion(): string {
  if (cachedVersion === undefined) cachedVersion = resolveVersionFrom(__dirname);
  return cachedVersion;
}

/**
 * Host-specific install behaviors declared on the runtime descriptor
 * (capabilities/<runtime>/capability.json -> runtime.hostBehaviors). Mirrors
 * bin/install.js's / install-engine.cts's `_hostBehaviors` (ADR-1239 / #2086
 * / #2092). Returns {} for runtimes that declare none, so every behavior
 * branch degrades to the generic path by default. Unlike the bin/install.js
 * and install-engine.cts variants, this module already imports
 * `capabilityRegistry` statically (see NON_CLAUDE_RUNTIMES below), so this
 * reads it directly rather than re-require()-ing inside a try/catch.
 */
function _hostBehaviors(runtime: string): Record<string, unknown> {
  return (
    (capabilityRegistry &&
      capabilityRegistry.runtimes &&
      capabilityRegistry.runtimes[runtime] &&
      capabilityRegistry.runtimes[runtime].runtime &&
      capabilityRegistry.runtimes[runtime].runtime.hostBehaviors) ||
    {}
  );
}

/**
 * Public accessor for the `hostBehaviors.agentFileExtension` descriptor field
 * (ADR-1239 / #2099 / #2103). Returns the runtime's declared agent-file
 * destination-suffix rename target (e.g. copilot's `.agent.md`), or
 * `undefined` when the runtime declares none (the generic no-rename
 * default). Exported so callers outside this module (surface.cts's
 * `_syncGsdDir`) can derive the SAME rename decision as
 * install-engine.cts's staged-copy loop from ONE descriptor read, instead of
 * duplicating a hardcoded `runtime === 'copilot'` check (#2103 fold).
 */
function agentFileExtensionFor(runtime: string): string | undefined {
  const ext = _hostBehaviors(runtime).agentFileExtension;
  return typeof ext === 'string' ? ext : undefined;
}


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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function replaceRelativePathReference(content, fromPath, toPath) {
  const escapedPath = escapeRegExp(fromPath);
  return content.replace(
    new RegExp(`(^|[^A-Za-z0-9_./-])${escapedPath}`, 'g'),
    (_, prefix) => `${prefix}${toPath}`,
  );
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

/**
 * Convert a Claude command (.md) to a Copilot skill (SKILL.md).
 * Transforms frontmatter only — body passes through with CONV-06/07 applied.
 * Skills keep original tool names (no mapping) per CONTEXT.md decision.
 */
// isGlobal is the 5th positional arg (3rd/4th are runtime/cmdNames passed by the skills wrapper). See runtime-artifact-layout skillsKind.
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

function normalizeClaudeSkillEffort(effort) {
  return effort === 'xhigh' ? 'max' : effort;
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
  // #769: preserve context: and effort: from source command files so they
  // are emitted into the installed SKILL.md frontmatter unchanged.
  const context = extractFrontmatterField(frontmatter, 'context');
  const effort = extractFrontmatterField(frontmatter, 'effort');

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
  if (runtime === 'hermes') {
    const version = gsdVersion();
    if (version) fm += `version: ${yamlQuote(version)}\n`;
  }
  // #778 (b) — numeric priority for /skills ordering, declared on the runtime
  // descriptor (runtime.hostBehaviors.skillPriorityFrontmatter). Scoped to
  // runtimes that declare the flag so Claude/Hermes skill frontmatter is
  // unchanged (they ignore the field, but we keep their output byte-stable).
  // skillName is the `gsd-<stem>` dir name. (ADR-1239 / #2092)
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
  // #769: emit context: and effort: when present so the runtime can honour
  // them natively (context: fork = isolated subagent window; effort: =
  // token-budget tier). Fields are Claude-specific; unknown frontmatter
  // fields are silently ignored by other runtimes (backward-compatible).
  if (context) fm += `context: ${context}\n`;
  if (effort) fm += `effort: ${normalizeClaudeSkillEffort(effort)}\n`;
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

// DEFECT.GENERATIVE-FIX: this body is mirrored in bin/install.js's
// convertClaudeCommandToKimiSkill (kept for bin/install.js's own
// module-level export/test surface; dead for the live skills-install path,
// which routes here via install-engine.cts's SKILLS_CONVERTER_REGISTRY
// through the kimi capability descriptor's artifactLayout
// `converter: "convertClaudeCommandToKimiSkill"`). Neither copy re-exports
// the other — mirror any behavior change into both. Guarded by the
// output-parity test in tests/runtime-converters.test.cjs (#2095).
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

/**
 * Convert a Claude command-markdown source into a Kimi Code Agent Skill.
 *
 * Kimi Code (Moonshot's Node CLI) uses the standard Agent Skills format —
 * a directory containing SKILL.md with frontmatter (name/description) and
 * body — auto-discovered from `~/.kimi-code/skills/` (per Kimi Code docs:
 * "Agent Skills is an open format for adding specialized knowledge and
 * workflows to AI agents"). The invocation prefix is `/skill:<name>`,
 * identical to Python kimi-cli.
 *
 * Today the output is byte-identical to `convertClaudeCommandToKimiSkill`
 * (the Python kimi-cli converter) because both products consume the same
 * Agent Skills format + `/skill:` invocation. The distinct function name
 * lets a future divergence land cleanly if Kimi Code's skill format evolves
 * independently of Python kimi-cli.
 *
 * Registered as `convertClaudeCommandToKimiCodeSkill` in the capabilities/
 * kimi-code/capability.json `artifactLayout` `converter` field (#2454 PR 2).
 */
function convertClaudeCommandToKimiCodeSkill(content, skillName, _runtime = null, cmdNames = null) {
  return convertClaudeCommandToKimiSkill(content, skillName, _runtime, cmdNames);
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

// DEFECT.GENERATIVE-FIX: this body is mirrored in bin/install.js's
// buildKimiAgentArtifacts (kept for bin/install.js's own module-level
// export/test surface; dead for the live install path, which routes here via
// runtime-artifact-layout.cts's kimiAgentsKind through a dynamic
// `conversionExports['buildKimiAgentArtifacts']` lookup against this
// compiled module). Neither copy re-exports the other — mirror any behavior
// change into both, including the kimi_cli.tools.agent:Agent grant that
// enables background dispatch (#2095 Upgrade 2). Guarded by the
// output-parity test in tests/runtime-converters.test.cjs (#2095).
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
 * Apply Antigravity-specific content conversion — path replacement + command name conversion.
 * Path mappings depend on install mode:
 *   Global: ~/.claude/ → ~/.gemini/antigravity/, ./.claude/ → ./.agents/
 *   Local:  ~/.claude/ → .agents/, ./.claude/ → ./.agents/
 * Applied to ALL Antigravity content (skills, agents, engine files).
 * @param {string} content - Source content to convert
 * @param {boolean} [isGlobal=false] - Whether this is a global install
 */
function convertClaudeToAntigravityContent(content, isGlobal = false) {
  let c = content;
  if (isGlobal) {
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

/**
 * Convert a Claude command (.md) to an Antigravity skill (SKILL.md).
 * Transforms frontmatter to minimal name + description only.
 * Body passes through with path/command conversions applied.
 */
// isGlobal is the 5th positional arg (3rd/4th are runtime/cmdNames passed by the skills wrapper). See runtime-artifact-layout skillsKind.
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
  // Replace "Claude Code" brand references with "Cursor"
  converted = converted.replace(/\bClaude Code\b/g, 'Cursor');
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

  // #2341: mark user-invocable:false so the skill is NOT shown in Cursor's '/'
  // menu (it defaults to true). Cursor also writes a commands/ surface (#785),
  // and surfacing both duplicated every /gsd-* entry. This mirrors the #789
  // CodeBuddy de-dup: the commands/ surface is the sole '/' entry point; skills
  // stay model-invocable background knowledge. (user-invocable:false hides from
  // '/' while keeping model invocation — distinct from disable-model-invocation.)
  return `---\nname: ${yamlIdentifier(skillName)}\ndescription: ${yamlQuote(shortDescription)}\nuser-invocable: false\n---\n\n${adapter}\n\n${body.trimStart()}`;
}

/**
 * Convert a Claude Code command to a Cursor 1.6 slash command (#785).
 *
 * Cursor slash commands live in `.cursor/commands/<name>.md` and are
 * plain markdown — no YAML frontmatter, no adapter header. The filename
 * becomes the command name (e.g. `gsd-help.md` → `/gsd-help`).
 *
 * Applies the same `convertClaudeToCursorMarkdown` transforms as the skill
 * converter (tool renames, brand substitution, slash-command normalisation),
 * then strips the YAML frontmatter block so only the prose body remains.
 *
 * @param {string} content   raw Claude Code command markdown (may have frontmatter)
 * @param {string} _commandName  the target command name (unused; present for
 *   API symmetry with other converters so the runtime-artifact-layout stage
 *   function can call it uniformly)
 * @returns {string} plain markdown body, no frontmatter
 */
function convertClaudeCommandToCursorCommand(content, _commandName) {
  const converted = convertClaudeToCursorMarkdown(content);
  const { body } = extractFrontmatterAndBody(converted);
  return body.trimStart();
}

// --- Windsurf converters ---
// Windsurf uses a tool set similar to Cursor.
// Config lives in .windsurf/ (local) and ~/.codeium/windsurf/ (global).

function convertSlashCommandsToWindsurfSkillMentions(content) {
  // Keep leading "/" for slash commands; only normalize gsd: -> gsd-.
  return content.replace(/gsd:/gi, 'gsd-');
}

function convertClaudeToWindsurfMarkdown(content) {
  let converted = convertSlashCommandsToWindsurfSkillMentions(content);
  // Replace tool name references in body text
  converted = converted.replace(/\bBash\(/g, 'Shell(');
  converted = converted.replace(/\bEdit\(/g, 'StrReplace(');
  converted = converted.replace(/\bAskUserQuestion\b/g, 'conversational prompting');
  // Replace subagent_type from Claude to Windsurf format
  converted = converted.replace(/subagent_type="general-purpose"/g, 'subagent_type="generalPurpose"');
  converted = converted.replace(/\$ARGUMENTS\b/g, '{{GSD_ARGS}}');
  // Replace project-level Claude conventions with Windsurf equivalents.
  converted = converted.replace(/`\.\/CLAUDE\.md`/g, '`.windsurf/rules`');
  converted = converted.replace(/\.\/CLAUDE\.md/g, '.windsurf/rules');
  converted = converted.replace(/`CLAUDE\.md`/g, '`.windsurf/rules`');
  converted = converted.replace(/\bCLAUDE\.md\b/g, '.windsurf/rules');
  converted = converted.replace(/\.claude\/skills\//g, '.windsurf/skills/');
  converted = converted.replace(/\.\/\.claude\//g, './.windsurf/');
  converted = converted.replace(/\.claude\//g, '.windsurf/');
  // Bare forms (no trailing slash) — after slash forms to avoid double-rewrite.
  // Use negative lookahead (?![\w-]) to preserve .claude-plugin and .claudeignore.
  converted = converted.replace(/~\/\.claude(?![\w-])/g, '~/.windsurf');
  converted = converted.replace(/\$HOME\/\.claude(?![\w-])/g, '$HOME/.windsurf');
  // Environment variable name rewrite
  converted = converted.replace(/\bCLAUDE_CONFIG_DIR\b/g, 'WINDSURF_CONFIG_DIR');
  // Remove Claude Code-specific bug workarounds before brand replacement
  converted = converted.replace(/\*\*Known Claude Code bug \(classifyHandoffIfNeeded\):\*\*[^\n]*\n/g, '');
  converted = converted.replace(/- \*\*classifyHandoffIfNeeded false failure:\*\*[^\n]*\n/g, '');
  // Replace "Claude Code" brand references with "Windsurf"
  converted = converted.replace(/\bClaude Code\b/g, 'Windsurf');
  return converted;
}

function getWindsurfSkillAdapterHeader(skillName) {
  return `<windsurf_skill_adapter>
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
Use these Windsurf tools when executing GSD workflows:
- \`Shell\` for running commands (terminal operations)
- \`StrReplace\` for editing existing files
- \`Read\`, \`Write\`, \`Glob\`, \`Grep\`, \`Task\`, \`WebSearch\`, \`WebFetch\`, \`TodoWrite\` as needed

## D. Subagent Spawning
When the workflow needs to spawn a subagent:
- Use \`Task(subagent_type="generalPurpose", ...)\`
- The \`model\` parameter maps to Windsurf's model options (e.g., "fast")
</windsurf_skill_adapter>`;
}

function convertClaudeCommandToWindsurfSkill(content, skillName) {
  const converted = convertClaudeToWindsurfMarkdown(content);
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
  const adapter = getWindsurfSkillAdapterHeader(skillName);

  return `---\nname: ${yamlIdentifier(skillName)}\ndescription: ${yamlQuote(shortDescription)}\n---\n\n${adapter}\n\n${body.trimStart()}`;
}

function convertClaudeCommandToWindsurfWorkflow(content, commandName) {
  // #1615 security: commandName flows unsanitized into a markdown body that
  // Windsurf loads as an LLM-readable workflow. Validate at entry to prevent
  // (a) prompt injection via newlines / markdown structure in the filename,
  // (b) path-component injection via .., /, \ in stem → @-reference target.
  // Pattern: optional gsd- prefix + lowercase alphanumeric + dashes; rejects
  // everything else. See DEFECT.PROMPT-INJECTION-SCAN-COLLISION and the
  // PR #1622 security review.
  if (typeof commandName !== 'string' || !/^(?:gsd-)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(commandName)) {
    const preview = typeof commandName === 'string' ? JSON.stringify(commandName.slice(0, 60)) : String(commandName);
    throw new Error(
      `convertClaudeCommandToWindsurfWorkflow: rejected commandName ${preview}; ` +
      'must match /^(?:gsd-)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/ (no slashes, backslashes, spaces, dots, trailing dash, or control chars — prevents prompt injection and path-component injection into the workflow body)'
    );
  }
  const converted = convertClaudeToWindsurfMarkdown(content);
  const { frontmatter } = extractFrontmatterAndBody(converted);
  const description = frontmatter ? extractFrontmatterField(frontmatter, 'description') : '';
  const stem = commandName.startsWith('gsd-') ? commandName.slice(4) : commandName;
  const workflow = `# ${commandName}\n\n${toSingleLine(description || `Run ${commandName}.`)}\n\nRead and execute the GSD command at @~/.claude/gsd-core/commands/gsd/${stem}.md end-to-end. Treat the user's message after /${commandName} as the command arguments.`;
  const byteLength = Buffer.byteLength(workflow, 'utf8');
  if (byteLength > 12000) {
    throw new Error(`Windsurf workflow ${commandName} exceeds 12000 bytes (${byteLength}); extract references before installing`);
  }
  return workflow;
}

// --- Augment converters ---
// Augment uses a tool set similar to Cursor/Windsurf.
// Config lives in .augment/ (local) and ~/.augment/ (global).

function convertSlashCommandsToAugmentSkillMentions(content) {
  return content.replace(/gsd:/gi, 'gsd-');
}

function convertClaudeToAugmentMarkdown(content) {
  let converted = convertSlashCommandsToAugmentSkillMentions(content);
  converted = converted.replace(/\bBash\(/g, 'launch-process(');
  converted = converted.replace(/\bEdit\(/g, 'str-replace-editor(');
  converted = converted.replace(/\bRead\(/g, 'view(');
  converted = converted.replace(/\bWrite\(/g, 'save-file(');
  converted = converted.replace(/\bTodoWrite\(/g, 'add_tasks(');
  converted = converted.replace(/\bAskUserQuestion\b/g, 'conversational prompting');
  // Replace subagent_type from Claude to Augment format
  converted = converted.replace(/subagent_type="general-purpose"/g, 'subagent_type="generalPurpose"');
  converted = converted.replace(/\$ARGUMENTS\b/g, '{{GSD_ARGS}}');
  // Replace project-level Claude conventions with Augment equivalents
  converted = converted.replace(/`\.\/CLAUDE\.md`/g, '`.augment/rules/`');
  converted = converted.replace(/\.\/CLAUDE\.md/g, '.augment/rules/');
  converted = converted.replace(/`CLAUDE\.md`/g, '`.augment/rules/`');
  converted = converted.replace(/\bCLAUDE\.md\b/g, '.augment/rules/');
  converted = converted.replace(/\.claude\/skills\//g, '.augment/skills/');
  // Remove Claude Code-specific bug workarounds before brand replacement
  converted = converted.replace(/\*\*Known Claude Code bug \(classifyHandoffIfNeeded\):\*\*[^\n]*\n/g, '');
  converted = converted.replace(/- \*\*classifyHandoffIfNeeded false failure:\*\*[^\n]*\n/g, '');
  // Replace "Claude Code" brand references with "Augment"
  converted = converted.replace(/\bClaude Code\b/g, 'Augment');
  return converted;
}

// #2097 (ADR-1239): command-body converters selected by descriptor
// (runtime.hostBehaviors.commandBodyConverter) instead of a runtime-name
// branch. Degrade-closed: unknown/absent name → no conversion.
const COMMAND_BODY_CONVERTERS = { convertClaudeToAugmentMarkdown };

function getAugmentSkillAdapterHeader(skillName) {
  return `<augment_skill_adapter>
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
Use these Augment tools when executing GSD workflows:
- \`launch-process\` for running commands (terminal operations)
- \`str-replace-editor\` for editing existing files
- \`view\` for reading files and listing directories
- \`save-file\` for creating new files
- \`grep\` for searching code (or use MCP servers for advanced search)
- \`web-search\`, \`web-fetch\` for web queries
- \`add_tasks\`, \`view_tasklist\`, \`update_tasks\` for task management

## D. Subagent Spawning
When the workflow needs to spawn a subagent:
- Use the built-in subagent spawning capability
- Define agent prompts in \`.augment/agents/\` directory
</augment_skill_adapter>`;
}

function convertClaudeCommandToAugmentSkill(content, skillName) {
  const converted = convertClaudeToAugmentMarkdown(content);
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
  const adapter = getAugmentSkillAdapterHeader(skillName);

  return `---\nname: ${yamlIdentifier(skillName)}\ndescription: ${yamlQuote(shortDescription)}\n---\n\n${adapter}\n\n${body.trimStart()}`;
}

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
  converted = converted.replace(/`\.\/CLAUDE\.md`/g, '`.trae/rules/`');
  converted = converted.replace(/\.\/CLAUDE\.md/g, '.trae/rules/');
  converted = converted.replace(/`CLAUDE\.md`/g, '`.trae/rules/`');
  converted = converted.replace(/\bCLAUDE\.md\b/g, '.trae/rules/');
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
  converted = converted.replace(/\bClaude Code\b/g, 'Trae');
  return converted;
}

// DEFECT.GENERATIVE-FIX: this body is mirrored in bin/install.js's
// convertClaudeCommandToTraeSkill (dead for the live skills-install path,
// which routes here via install-engine.cts's SKILLS_CONVERTER_REGISTRY; kept
// for bin/install.js's own module-level export/test surface). Neither copy
// re-exports the other — mirror any behavior change into both. Guarded by
// the output-parity test in tests/runtime-converters.test.cjs (#2094).
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
  const soloStage = _hostBehaviors('trae').soloStageMetadata as string | undefined;
  if (soloStage) fm += `stage: ${soloStage}\n`;
  fm += '---';
  return `${fm}\n${body}`;
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
  converted = converted.replace(/\bClaude Code\b/g, 'CodeBuddy');
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
  converted = converted.replace(/\bClaude Code\b/g, 'Cline');
  return converted;
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
function convertClaudeCommandToClineSkill(content, skillName, _runtime = null, cmdNames = null) {
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
- \`fork_context: false\` by default — GSD agents load their own context via \`<files_to_read>\` blocks
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
- Spawn multiple agents → collect agent IDs → \`wait(ids)\` for all to complete

Result parsing:
- Look for structured markers in agent output: \`CHECKPOINT\`, \`PLAN COMPLETE\`, \`SUMMARY\`, etc.
- \`close_agent(id)\` after collecting results from each agent
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
      newLines.push(['model:', modelOverride].join(' '));
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
// DEFECT.GENERATIVE-FIX: this body is mirrored in bin/install.js's
// convertClaudeToKiloFrontmatter (used by bin/install.js's own legacy install
// path). Neither copy re-exports the other — mirror any behavior change into
// both. Guarded by the output-parity test in tests/runtime-converters.test.cjs
// (#2093).
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
    // model emission exactly (#2093 UPGRADE 2 / ADR-1239; Kilo is an OpenCode
    // fork with the same static-frontmatter model constraint). See #2256.
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

// ── Agent converters — #1182 extraction ─────────────────────────────────────
// These were previously only in bin/install.js. Extracted here so the module
// is self-contained and #1173 descriptor-driven dispatch can call them without
// reaching through the Installer Module.
// NOTE: Do NOT remove the inline copies from bin/install.js in this PR —
// that is #1175. This PR only adds them to the module's export surface.

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
 * Convert a Claude agent (.md) to a GitHub Copilot agent.
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

/**
 * Convert Claude Code agent markdown to Cursor agent format.
 * Strips frontmatter fields Cursor doesn't support (color, skills),
 * converts tool references, and adds a role context header.
 */
function convertClaudeAgentToCursorAgent(content) {
  const converted = convertClaudeToCursorMarkdown(content);

  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  if (!frontmatter) return converted;

  const name = extractFrontmatterField(frontmatter, 'name') || 'unknown';
  const description = extractFrontmatterField(frontmatter, 'description') || '';

  const cleanFrontmatter = `---\nname: ${yamlIdentifier(name)}\ndescription: ${yamlQuote(toSingleLine(description))}\n---`;

  return `${cleanFrontmatter}\n${body}`;
}

/**
 * Convert Claude Code agent markdown to Windsurf agent format.
 * Strips frontmatter fields Windsurf doesn't support (color, skills),
 * converts tool references, and adds a role context header.
 */
function convertClaudeAgentToWindsurfAgent(content) {
  const converted = convertClaudeToWindsurfMarkdown(content);

  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  if (!frontmatter) return converted;

  const name = extractFrontmatterField(frontmatter, 'name') || 'unknown';
  const description = extractFrontmatterField(frontmatter, 'description') || '';

  const cleanFrontmatter = `---\nname: ${yamlIdentifier(name)}\ndescription: ${yamlQuote(toSingleLine(description))}\n---`;

  return `${cleanFrontmatter}\n${body}`;
}

/**
 * Convert Claude Code agent markdown to Augment agent format.
 * Strips frontmatter fields Augment doesn't support (color, skills),
 * converts tool references, and cleans up for Augment agents.
 */
function convertClaudeAgentToAugmentAgent(content) {
  const converted = convertClaudeToAugmentMarkdown(content);

  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  if (!frontmatter) return converted;

  const name = extractFrontmatterField(frontmatter, 'name') || 'unknown';
  const description = extractFrontmatterField(frontmatter, 'description') || '';

  const cleanFrontmatter = `---\nname: ${yamlIdentifier(name)}\ndescription: ${yamlQuote(toSingleLine(description))}\n---`;

  return `${cleanFrontmatter}\n${body}`;
}

function convertClaudeAgentToTraeAgent(content) {
  const converted = convertClaudeToTraeMarkdown(content);

  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  if (!frontmatter) return converted;

  const name = extractFrontmatterField(frontmatter, 'name') || 'unknown';
  const description = extractFrontmatterField(frontmatter, 'description') || '';

  const cleanFrontmatter = `---\nname: ${yamlIdentifier(name)}\ndescription: ${yamlQuote(toSingleLine(description))}\n---`;

  return `${cleanFrontmatter}\n${body}`;
}

/**
 * Convert a Claude agent (.md) to a native Qwen Code subagent file
 * (`.qwen/agents/gsd-*.md` / `<qwenhome>/agents/gsd-*.md`, ADR-1239 / #2092
 * Phase B Upgrade 1). Qwen Code is a Claude-dialect host: its docs' "Claude
 * Code Compatibility Fields" section confirms CC agent files parse under
 * `.qwen/agents/` (https://qwenlm.github.io/qwen-code-docs/en/users/features/sub-agents),
 * so — unlike Cursor/Trae/Copilot/Antigravity — tool names pass through
 * UNCHANGED (no remapping table).
 *
 * Emits DETERMINISTIC frontmatter: `name:` + `description:` (mirrors
 * convertClaudeAgentToCursorAgent), plus `tools:` as a YAML block list when the
 * source declares one. Qwen's documented `tools:` schema is a YAML array
 * (`tools:\n- tool1\n- tool2`), not Claude's single-line comma-separated string
 * — passing the raw single-line string through unchanged would parse as one
 * malformed tool name and be silently dropped ("Optional fields with invalid
 * values are silently dropped at parse time" — same docs page). Reuses
 * `parseFrontmatterTools` (already relied on by the Kimi agent path), which
 * tolerates BOTH source formats Claude's own agents/*.md files use — the
 * single-line comma list (most agents) and the YAML block list (e.g.
 * agents/gsd-nyquist-auditor.md, agents/gsd-security-auditor.md) — so no tools
 * are lost regardless of which the source agent uses.
 *
 * `color` IS preserved: Qwen's docs list `color` under "Claude Code
 * Compatibility Fields" as a supported optional field, so it is passed
 * through as a plain scalar (unlike the cursor/trae/augment/windsurf
 * reduced-frontmatter converters, which drop it — those hosts have no such
 * compatibility field). `model:` and `approvalMode:` are intentionally NOT
 * emitted: both are optional per the docs and out of scope for #2092 (model:
 * would couple to the model catalog and introduce nondeterminism;
 * approvalMode is a deliberate follow-on).
 *
 * Body: preserved verbatim after the qwen branding rewrite (CLAUDE.md /
 * Claude Code / .claude/ literal-substring values — descriptor-driven via
 * runtime.hostBehaviors.brandingRewrites, mirrors the qwen case in
 * _applyRuntimeRewrites). The anchored `~/.claude/` / `$HOME/.claude/` forms
 * are already rewritten upstream by applyAgentPathRewrites (agentCtx Step 1 in
 * stageAgentsForRuntimeWithConverter) before this converter runs, so only the
 * bare/non-anchored forms are handled here — mirrors how
 * convertClaudeToTraeMarkdown orders its bare-form rewrites after the slash
 * forms to avoid double-rewriting the same substring.
 */
function convertClaudeAgentToQwenAgent(content) {
  const _b = _hostBehaviors('qwen').brandingRewrites || {};
  let converted = content;
  if (_b['CLAUDE.md']) converted = converted.replace(/CLAUDE\.md/g, _b['CLAUDE.md']);
  if (_b['Claude Code']) converted = converted.replace(/\bClaude Code\b/g, _b['Claude Code']);
  if (_b['.claude/']) converted = converted.replace(/\.claude\//g, _b['.claude/']);

  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  if (!frontmatter) return converted;

  const name = extractFrontmatterField(frontmatter, 'name') || 'unknown';
  const description = extractFrontmatterField(frontmatter, 'description') || '';
  const tools = parseFrontmatterTools(frontmatter);
  const color = extractFrontmatterField(frontmatter, 'color');

  let fm = `---\nname: ${yamlIdentifier(name)}\ndescription: ${yamlQuote(toSingleLine(description))}\n`;
  if (tools.length > 0) {
    fm += 'tools:\n';
    for (const tool of tools) {
      fm += `  - ${yamlIdentifier(tool)}\n`;
    }
  }
  if (color) {
    fm += `color: ${yamlIdentifier(color)}\n`;
  }
  fm += '---';

  return `${fm}\n${body}`;
}

function convertClaudeAgentToCodebuddyAgent(content) {
  const converted = convertClaudeToCodebuddyMarkdown(content);

  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  if (!frontmatter) return converted;

  const name = extractFrontmatterField(frontmatter, 'name') || 'unknown';
  const description = extractFrontmatterField(frontmatter, 'description') || '';

  const cleanFrontmatter = `---\nname: ${yamlIdentifier(name)}\ndescription: ${yamlQuote(toSingleLine(description))}\n---`;

  return `${cleanFrontmatter}\n${body}`;
}

function convertClaudeAgentToClineAgent(content) {
  const converted = convertClaudeToCliineMarkdown(content);
  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  if (!frontmatter) return converted;
  const name = extractFrontmatterField(frontmatter, 'name') || 'unknown';
  const description = extractFrontmatterField(frontmatter, 'description') || '';
  const cleanFrontmatter = `---\nname: ${yamlIdentifier(name)}\ndescription: ${yamlQuote(toSingleLine(description))}\n---`;
  return `${cleanFrontmatter}\n${body}`;
}

/**
 * Convert Claude Code agent markdown to Codex agent format.
 * Applies base markdown conversions, then adds a <codex_agent_role> header
 * and cleans up frontmatter (removes tools/color fields).
 */
function convertClaudeAgentToCodexAgent(content) {
  const converted = convertClaudeToCodexMarkdown(content);

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

// ── End agent converters #1182 ───────────────────────────────────────────────

/**
 * Shared SKILL.md writer for the OpenCode-family runtimes (OpenCode + Kilo),
 * which share a config schema (Kilo derives from OpenCode). OpenCode discovers
 * skills as `skills/<name>/SKILL.md` and Kilo follows the same layout
 * (https://opencode.ai/docs/skills, https://kilo.ai/docs/customize/skills).
 *
 * The skill body reuses the runtime's command-frontmatter converter for tool,
 * path, and `/gsd:`→`/gsd-` body rewrites, then rebuilds a minimal skill
 * frontmatter: only `name` (lowercase-hyphen, must match the containing
 * directory) and `description` (1–1024 chars) are emitted, per the OpenCode
 * skill spec. The command's `tools:`/`permission:` block is intentionally
 * dropped — OpenCode skills are loaded on-demand via the native skill tool and
 * inherit the calling agent's permissions.
 *
 * @param {string} content - Claude command markdown (with YAML frontmatter)
 * @param {string} skillName - Skill directory name (e.g. gsd-help)
 * @param {(content: string) => string} frontmatterConverter - runtime command converter
 * @returns {string} SKILL.md content
 */
function convertClaudeCommandToOpencodeFamilySkill(content, skillName, frontmatterConverter) {
  const converted = frontmatterConverter(content);
  const { frontmatter, body } = extractFrontmatterAndBody(converted);
  let description = `Run GSD workflow ${skillName}.`;
  if (frontmatter) {
    const maybeDescription = extractFrontmatterField(frontmatter, 'description');
    if (maybeDescription) {
      description = maybeDescription;
    }
  }
  description = toSingleLine(description);
  // OpenCode skill descriptions must be 1–1024 characters.
  if (description.length > 1024) {
    description = `${description.slice(0, 1021)}...`;
  }
  // `name` must be lowercase alphanumeric with single-hyphen separators and
  // match the containing directory name (the staged dir is `${skillName}/`).
  const name = yamlIdentifier(skillName);
  return `---\nname: ${name}\ndescription: ${yamlQuote(description)}\n---\n\n${body.trimStart()}`;
}

/**
 * Convert a Claude command (.md) to an OpenCode skill (SKILL.md).
 * Thin wrapper over the shared OpenCode-family writer.
 */
function convertClaudeCommandToOpencodeSkill(content, skillName) {
  return convertClaudeCommandToOpencodeFamilySkill(
    content,
    skillName,
    (c) => convertClaudeToOpencodeFrontmatter(c),
  );
}

/**
 * Convert a Claude command (.md) to a Kilo skill (SKILL.md).
 * Thin wrapper over the shared OpenCode-family writer (Kilo shares the schema).
 */
function convertClaudeCommandToKiloSkill(content, skillName) {
  return convertClaudeCommandToOpencodeFamilySkill(
    content,
    skillName,
    (c) => convertClaudeToKiloFrontmatter(c),
  );
}


// ── Rewrite engine — ADR-1508 Phase 2 ───────────────────────────────────────
// Relocated from bin/install.js (#1511). Behavior is byte-for-behavior identical
// to the originals; the only change is the injected `attribution` 5th param in
// _applyRuntimeRewrites (replacing the internal getCommitAttribution() call).

/**
 * Compute the path prefix for a runtime install.
 * Global installs under $HOME use $HOME/... form; others use the resolved target.
 * isOpencode excludes OpenCode (uses ~/.config/opencode which breaks $HOME shorthand).
 * isWindowsHost is not used today but reserved for future Windows-specific logic.
 *
 * @private — exported as `_computePathPrefix` for tests.
 */
function computePathPrefix({ isGlobal, isOpencode, isWindowsHost: _isWindowsHost, resolvedTarget, homeDir }) {
  // #1615: normalize Windows backslashes to forward slashes. This prefix is
  // substituted into markdown @-references (e.g. Windsurf workflow files),
  // which use POSIX paths universally. Idempotent on POSIX (no backslashes).
  // Without this, path.join on Windows produces a backslash prefix that
  // leaks into markdown content and breaks cross-platform substring checks.
  // See DEFECT.WINDOWS-PATH-LEAK-IN-MARKDOWN-CONTENT in CONTEXT.md.
  const posixTarget = posixNormalize(String(resolvedTarget));
  const posixHome = homeDir ? posixNormalize(String(homeDir)) : homeDir;
  if (isGlobal && posixTarget.startsWith(posixHome) && !isOpencode) {
    return '$HOME' + posixTarget.slice(posixHome.length) + '/';
  }
  return `${posixTarget}/`;
}

/**
 * Canonical list of every non-Claude runtime that gsd-core emits artifacts for.
 * DERIVED from the capability registry (ADR-1239 Phase B, #1679) — the registry's
 * `runtimes` map is the single source of truth for runtime identity, so the
 * non-Claude set is its key set minus 'claude'. This replaces a hand-maintained
 * literal that had to be kept in sync with bin/install.js and getDirName(), and
 * can no longer drift from the registry. Exported so tests import one source (#1521).
 */
const NON_CLAUDE_RUNTIMES: string[] = Object.keys(capabilityRegistry.runtimes)
  .filter((id) => id !== 'claude')
  .sort();

/**
 * #1521: Every non-Claude runtime resolves its own runtime identity from a
 * runtime-neutral config, and defaults workflow.use_worktrees to false —
 * GSD's worktree isolation uses Claude Code's isolation="worktree" spawn
 * parameter, which no other runtime honors. Stamped into the emitted
 * workflow runtime-resolution blocks. (Generalizes the Codex-only #1515 fix.)
 *
 * @private — exported as `_stampNonClaudeRuntimeDefaults` for tests.
 */
function _stampNonClaudeRuntimeDefaults(content: string, runtime: string): string {
  content = content.replace(
    /config-get workflow\.use_worktrees --raw 2>\/dev\/null \|\| echo "true"/g,
    'config-get workflow.use_worktrees --default false --raw 2>/dev/null || echo "false"',
  );
  content = content.replace(
    /config-get runtime --default claude --raw 2>\/dev\/null \|\| echo "claude"/g,
    `config-get runtime --default ${runtime} --raw 2>/dev/null || echo "${runtime}"`,
  );
  return content;
}

/**
 * Apply the per-runtime rewrite table to a single content string.
 * Relocated from bin/install.js `_applyRuntimeRewrites`.
 *
 * The 5th `attribution` param replaces the internal getCommitAttribution() call
 * so the function is pure (no config I/O). Pass the resolved attribution value
 * from the installer; pass `undefined` to leave Co-Authored-By lines untouched.
 *
 * @private — exported as `_applyRuntimeRewrites` for tests.
 */
function _applyRuntimeRewrites(content, runtime, pathPrefix, isGlobal = false, attribution = undefined) {
  const dirName = getDirName(runtime);
  const normalizedPathPrefix = pathPrefix.replace(/\/$/, '');

  // #1521: stamp runtime identity + use_worktrees=false for every non-Claude runtime
  // before brand-specific path rewrites, so the replace operates on the pristine
  // source line and is idempotent regardless of subsequent path substitutions.
  if (runtime !== 'claude') {
    content = _stampNonClaudeRuntimeDefaults(content, runtime);
  }

  switch (runtime) {
    case 'codex':
      content = content.replace(/~\/\.claude\//g, pathPrefix);
      content = content.replace(/\$HOME\/\.claude\//g, pathPrefix);
      content = content.replace(/\.\/\.claude\//g, `./${dirName}/`);
      content = content.replace(/~\/\.codex\//g, pathPrefix);
      // #1515 stamp moved to _stampNonClaudeRuntimeDefaults (#1521 generalisation).
      content = processAttribution(content, attribution);
      break;

    case 'cline':
      content = content.replace(/~\/\.claude\//g, pathPrefix);
      content = content.replace(/\$HOME\/\.claude\//g, pathPrefix);
      content = content.replace(/\.\/\.claude\//g, `./${dirName}/`);
      content = content.replace(/~\/\.cline\//g, pathPrefix);
      content = content.replace(/\$HOME\/\.cline\//g, pathPrefix);
      content = content.replace(/~\/\.claude\b/g, normalizedPathPrefix);
      content = content.replace(/\$HOME\/\.claude\b/g, normalizedPathPrefix);
      content = content.replace(/~\/\.cline\b/g, normalizedPathPrefix);
      content = content.replace(/\$HOME\/\.cline\b/g, normalizedPathPrefix);
      content = processAttribution(content, attribution);
      break;

    case 'cursor':
      content = content.replace(/~\/\.claude\//g, pathPrefix);
      content = content.replace(/\$HOME\/\.claude\//g, pathPrefix);
      content = content.replace(/\.\/\.claude\//g, `./${dirName}/`);
      content = content.replace(/~\/\.claude(?![\w-])/g, normalizedPathPrefix);
      content = content.replace(/\$HOME\/\.claude(?![\w-])/g, normalizedPathPrefix);
      content = content.replace(/\.\/\.claude(?![\w-])/g, `./${dirName}`);
      content = content.replace(/~\/\.cursor\//g, pathPrefix);
      content = processAttribution(content, attribution);
      break;

    case 'windsurf': {
      content = content.replace(/~\/\.claude\//g, pathPrefix);
      content = content.replace(/\$HOME\/\.claude\//g, pathPrefix);
      content = content.replace(/\.\/\.claude\//g, `./${dirName}/`);
      content = content.replace(/~\/\.claude(?![\w-])/g, normalizedPathPrefix);
      content = content.replace(/\$HOME\/\.claude(?![\w-])/g, normalizedPathPrefix);
      content = content.replace(/~\/\.codeium\/windsurf\//g, pathPrefix);
      if (isGlobal) {
        content = content.replace(/\.devin\/skills\//g, `${pathPrefix}skills/`);
        content = content.replace(/\.\/\.devin\//g, pathPrefix);
        content = content.replace(/~\/\.devin(?![\w-])/g, normalizedPathPrefix);
        content = content.replace(/\$HOME\/\.devin(?![\w-])/g, normalizedPathPrefix);
      }
      content = processAttribution(content, attribution);
      break;
    }

    case 'augment': {
      content = content.replace(/~\/\.claude\//g, pathPrefix);
      content = content.replace(/\$HOME\/\.claude\//g, pathPrefix);
      content = content.replace(/\.\/\.claude\//g, `./${dirName}/`);
      content = content.replace(/~\/\.claude(?![\w-])/g, normalizedPathPrefix);
      content = content.replace(/\$HOME\/\.claude(?![\w-])/g, normalizedPathPrefix);
      content = content.replace(/\.\/\.claude(?![\w-])/g, `./${dirName}`);
      // #2097: dot-dir self-references (~/.augment/…) → resolved prefix,
      // dirName-derived (no runtime literal). getDirName('augment') resolves
      // to '.augment', so this is byte-identical to the prior hardcoded regexes.
      const _dd = escapeRegExp(dirName);
      content = content.replace(new RegExp('~/' + _dd + '/', 'g'), pathPrefix);
      content = content.replace(new RegExp('\\$HOME/' + _dd + '/', 'g'), pathPrefix);
      content = content.replace(new RegExp('~/' + _dd + '(?![\\w-])', 'g'), normalizedPathPrefix);
      content = content.replace(new RegExp('\\$HOME/' + _dd + '(?![\\w-])', 'g'), normalizedPathPrefix);
      content = processAttribution(content, attribution);
      break;
    }

    case 'trae':
      content = content.replace(/~\/\.claude\//g, pathPrefix);
      content = content.replace(/\$HOME\/\.claude\//g, pathPrefix);
      content = content.replace(/\.\/\.claude\//g, `./${dirName}/`);
      content = content.replace(/~\/\.claude\b/g, normalizedPathPrefix);
      content = content.replace(/\$HOME\/\.claude\b/g, normalizedPathPrefix);
      content = content.replace(/\.\/\.claude\b/g, `./${dirName}`);
      // #2094: descriptor-driven — dirName resolves to '.trae' via
      // getDirName()/localConfigDir, so this regex is built rather than
      // hardcoded as `/~\/\.trae\//g` (byte-identical output for trae).
      content = content.replace(new RegExp('~/' + escapeRegExp(dirName) + '/', 'g'), pathPrefix);
      content = processAttribution(content, attribution);
      break;

    case 'codebuddy':
      content = content.replace(/~\/\.claude\//g, pathPrefix);
      content = content.replace(/\$HOME\/\.claude\//g, pathPrefix);
      content = content.replace(/\.\/\.claude\//g, `./${dirName}/`);
      content = content.replace(/~\/\.claude\b/g, normalizedPathPrefix);
      content = content.replace(/\$HOME\/\.claude\b/g, normalizedPathPrefix);
      content = content.replace(/\.\/\.claude\b/g, `./${dirName}`);
      content = content.replace(/~\/\.codebuddy\//g, pathPrefix);
      content = content.replace(/\$HOME\/\.codebuddy\//g, pathPrefix);
      content = content.replace(/~\/\.codebuddy\b/g, normalizedPathPrefix);
      content = content.replace(/\$HOME\/\.codebuddy\b/g, normalizedPathPrefix);
      content = processAttribution(content, attribution);
      break;

    case 'copilot':
      content = processAttribution(content, attribution);
      break;

    case 'antigravity':
      content = processAttribution(content, attribution);
      break;

    case 'claude':
      content = content.replace(/~\/\.claude\//g, pathPrefix);
      content = content.replace(/\$HOME\/\.claude\//g, pathPrefix);
      content = content.replace(/\.\/\.claude\//g, `./${dirName}/`);
      content = processAttribution(content, attribution);
      break;

    // Descriptor-driven brand literals (ADR-1239 / #2092): the qwen/hermes
    // brand VALUES (CLAUDE.md/Claude Code/.claude/ replacements) now read from
    // runtime.hostBehaviors.brandingRewrites instead of hardcoded literals.
    // EXACT regexes/order preserved — only the replacement values changed.
    case 'qwen': {
      // Guarded (post-review #2092): brandingRewrites is undefined if the
      // capability registry fails to load — degrade closed (skip the
      // brand-literal replacements, still apply the non-branding path
      // rewrites below) instead of throwing on `_b['CLAUDE.md']`.
      const _b = _hostBehaviors(runtime).brandingRewrites;
      if (_b) {
        content = content.replace(/CLAUDE\.md/g, _b['CLAUDE.md']);
        content = content.replace(/\bClaude Code\b/g, _b['Claude Code']);
      }
      content = content.replace(/~\/\.claude\//g, pathPrefix);
      content = content.replace(/\$HOME\/\.claude\//g, pathPrefix);
      content = content.replace(/~\/\.qwen\//g, pathPrefix);
      content = content.replace(/\$HOME\/\.qwen\//g, pathPrefix);
      content = content.replace(/~\/\.claude(?![\w-])/g, normalizedPathPrefix);
      content = content.replace(/\$HOME\/\.claude(?![\w-])/g, normalizedPathPrefix);
      content = content.replace(/~\/\.qwen(?![\w-])/g, normalizedPathPrefix);
      content = content.replace(/\$HOME\/\.qwen(?![\w-])/g, normalizedPathPrefix);
      if (_b) {
        content = content.replace(/\.claude\//g, _b['.claude/']);
      }
      content = content.replace(/\.\/\.claude\//g, `./${dirName}/`);
      content = content.replace(/\.\/\.qwen\//g, `./${dirName}/`);
      content = processAttribution(content, attribution);
      break;
    }

    case 'hermes': {
      // Guarded (post-review #2092): see qwen case above — same degrade-closed
      // rationale.
      const _b = _hostBehaviors(runtime).brandingRewrites;
      if (_b) {
        content = content.replace(/CLAUDE\.md/g, _b['CLAUDE.md']);
        content = content.replace(/\bClaude Code\b/g, _b['Claude Code']);
      }
      content = content.replace(/~\/\.claude\//g, pathPrefix);
      content = content.replace(/\$HOME\/\.claude\//g, pathPrefix);
      content = content.replace(/~\/\.hermes\//g, pathPrefix);
      content = content.replace(/\$HOME\/\.hermes\//g, pathPrefix);
      content = content.replace(/~\/\.claude(?![\w-])/g, normalizedPathPrefix);
      content = content.replace(/\$HOME\/\.claude(?![\w-])/g, normalizedPathPrefix);
      content = content.replace(/~\/\.hermes(?![\w-])/g, normalizedPathPrefix);
      content = content.replace(/\$HOME\/\.hermes(?![\w-])/g, normalizedPathPrefix);
      if (_b) {
        content = content.replace(/\.claude\//g, _b['.claude/']);
      }
      content = content.replace(/\.\/\.claude\//g, `./${dirName}/`);
      content = content.replace(/\.\/\.hermes\//g, `./${dirName}/`);
      content = processAttribution(content, attribution);
      break;
    }

    case 'kimi':
      content = content.replace(/~\/\.claude\//g, pathPrefix);
      content = content.replace(/\$HOME\/\.claude\//g, pathPrefix);
      content = content.replace(/\.\/\.claude\//g, `./${dirName}/`);
      content = content.replace(/~\/\.claude\b/g, normalizedPathPrefix);
      content = content.replace(/\$HOME\/\.claude\b/g, normalizedPathPrefix);
      content = content.replace(/\.\/\.claude\b/g, `./${dirName}`);
      content = processAttribution(content, attribution);
      break;

    default:
      // Unknown runtime — no rewrites (OpenCode/Kilo handled by their own install path).
      break;
  }

  return content;
}

/**
 * LOW-LEVEL: In-place fs walk: rewrite all .md files under stagedDir.
 *
 * pathPrefix and attribution are passed in (already resolved by the caller).
 * Single owner of the walk loop — both the high-level rewriteStagedSkillBodies
 * and the install.js compat wrapper delegate here.
 *
 * @param stagedDir    directory of staged skill/agent files
 * @param runtime      canonical runtime ID
 * @param pathPrefix   trailing-slash path prefix (e.g. '$HOME/.cursor/')
 * @param isGlobal     true for global scope installs
 * @param attribution  Co-Authored-By value (string | null | undefined)
 */
function applyRuntimeContentRewritesInPlace(stagedDir, runtime, pathPrefix, isGlobal = false, attribution = undefined) {
  if (!fs.existsSync(stagedDir)) return;

  const walkAndRewrite = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkAndRewrite(fullPath);
      } else if (entry.name.endsWith('.md')) {
        let content = fs.readFileSync(fullPath, 'utf8');
        content = _applyRuntimeRewrites(content, runtime, pathPrefix, isGlobal, attribution);
        fs.writeFileSync(fullPath, content);
      }
    }
  };
  walkAndRewrite(stagedDir);
}

/**
 * LOW-LEVEL: Copy-to-temp then rewrite all .md files.
 *
 * pathPrefix and attribution are passed in (already resolved by the caller).
 * Single owner of the copy+rewrite loop — both the high-level
 * rewriteStagedCommandBodies and the install.js compat wrapper delegate here.
 *
 * IMPORTANT: always copies to a fresh mkdtemp dir — never mutates the source dir
 * (stageSkillsForProfile returns the source dir on full profile; mutation would
 * corrupt the package source).
 *
 * @param stagedDir    directory of staged flat .md command files
 * @param runtime      canonical runtime ID
 * @param pathPrefix   trailing-slash path prefix
 * @param isGlobal     true for global scope installs
 * @param attribution  Co-Authored-By value (string | null | undefined)
 * @returns {string} path to the temp dir (caller is responsible for cleanup)
 */
function applyRuntimeContentRewritesForCommandsInPlace(stagedDir, runtime, pathPrefix, isGlobal = false, attribution = undefined) {
  if (!fs.existsSync(stagedDir)) return stagedDir;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-cmd-rewrites-'));
  try {
    for (const entry of fs.readdirSync(stagedDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      let content = fs.readFileSync(path.join(stagedDir, entry.name), 'utf8');
      content = _applyRuntimeRewrites(content, runtime, pathPrefix, isGlobal, attribution);
      // #2097 (ADR-1239): descriptor-driven — commandBodyConverter name comes
      // from runtime.hostBehaviors instead of a hardcoded runtime-name branch.
      const _cmdConv = _hostBehaviors(runtime).commandBodyConverter;
      if (_cmdConv && COMMAND_BODY_CONVERTERS[_cmdConv]) {
        content = COMMAND_BODY_CONVERTERS[_cmdConv](content);
      }
      fs.writeFileSync(path.join(tempDir, entry.name), content);
    }
  } catch (err) {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }
  return tempDir;
}

/**
 * HIGH-LEVEL: In-place fs walk: rewrite all .md files under stagedDir for the given runtime.
 *
 * Deep public seam (ADR-1508 Phase 2). Derives resolvedTarget/homeDir/isGlobal/pathPrefix/
 * attribution from opts, then delegates to applyRuntimeContentRewritesInPlace (single walk owner).
 *
 * @param stagedDir   directory of staged skill/agent files
 * @param opts.runtime          canonical runtime ID
 * @param opts.configDir        runtime config directory (absolute path)
 * @param opts.scope            'global' | 'local'
 * @param opts.homedir          optional homedir resolver (injectable for tests; defaults to os.homedir)
 * @param opts.platform         optional platform string (injectable for tests; defaults to process.platform)
 * @param opts.resolveAttribution  optional fn(runtime)→string|null|undefined; called once per invocation
 */
function rewriteStagedSkillBodies(stagedDir, opts) {
  const {
    runtime,
    configDir,
    scope = 'global',
    homedir = () => os.homedir(),
    platform = process.platform,
    resolveAttribution,
  } = opts;
  if (!fs.existsSync(stagedDir)) return;

  const resolvedTarget = posixNormalize(path.resolve(configDir));
  const homeDir = posixNormalize(homedir());
  const isGlobal = scope === 'global';
  const isOpencode = false;  // #2087: opencode installs via the combined-family engine path, never through the generic rewrite
  const isWindowsHost = platform === 'win32';
  const pathPrefix = computePathPrefix({ isGlobal, isOpencode, isWindowsHost, resolvedTarget, homeDir });
  const attribution = resolveAttribution ? resolveAttribution(runtime) : undefined;

  applyRuntimeContentRewritesInPlace(stagedDir, runtime, pathPrefix, isGlobal, attribution);
}

/**
 * HIGH-LEVEL: Copy-to-temp then rewrite all .md files for the given runtime.
 *
 * Deep public seam (ADR-1508 Phase 2). Derives resolvedTarget/homeDir/isGlobal/pathPrefix/
 * attribution from opts, then delegates to applyRuntimeContentRewritesForCommandsInPlace
 * (single copy+rewrite owner).
 *
 * @internal — symmetric companion to rewriteStagedSkillBodies; the deep-seam API for
 * command bodies. Production callers: applySurface (surface.cts) and the install path
 * in createRuntimeArtifactInstallPlan (runtime-artifact-install-plan.cts) — both keep
 * the returned temp dir alive until they have copied its contents out, then clean it up
 * in their own finally. (A test that treats this as a throwaway shared-tmp path will
 * race those live temp dirs under --test-concurrency; see #1575/#2090.)
 *
 * @returns {string} path to the temp dir (caller is responsible for cleanup)
 */
function rewriteStagedCommandBodies(stagedDir, opts) {
  const {
    runtime,
    configDir,
    scope = 'global',
    homedir = () => os.homedir(),
    platform = process.platform,
    resolveAttribution,
  } = opts;
  if (!fs.existsSync(stagedDir)) return stagedDir;

  const resolvedTarget = posixNormalize(path.resolve(configDir));
  const homeDir = posixNormalize(homedir());
  const isGlobal = scope === 'global';
  const isOpencode = false;  // #2087: opencode installs via the combined-family engine path, never through the generic rewrite
  const isWindowsHost = platform === 'win32';
  const pathPrefix = computePathPrefix({ isGlobal, isOpencode, isWindowsHost, resolvedTarget, homeDir });
  const attribution = resolveAttribution ? resolveAttribution(runtime) : undefined;

  return applyRuntimeContentRewritesForCommandsInPlace(stagedDir, runtime, pathPrefix, isGlobal, attribution);
}

/**
 * Normalize `/gsd:<cmd>` colon refs in the agent body to `/gsd-<cmd>` for
 * runtimes that declare `runtime.hostBehaviors.hyphenNameAgentBody` on their
 * descriptor (claude / qwen / hermes use hyphen-`name:` frontmatter;
 * cursor/windsurf/etc self-convert and don't declare the flag). Descriptor-
 * driven (ADR-1239 / #2092) — folded from the hardcoded
 * `HYPHEN_NAME_AGENT_RUNTIMES` allow-list set. Mirrors the per-file call in
 * bin/install.js line 9370 / `shouldNormalizeHyphenNamespaceInAgentBody`.
 *
 * @param content   raw agent file content (post-converter)
 * @param runtime   canonical runtime ID
 * @param cmdNames  gsd command names from readGsdCommandNames()
 */
function normalizeAgentBodyForRuntime(content: string, runtime: string, cmdNames: string[]): string {
  if (_hostBehaviors(runtime).hyphenNameAgentBody !== true) return content;
  return transformContentToHyphen(content, cmdNames);
}

/**
 * Apply the 4 base `~/.claude/` path-prefix rewrites to a single agent content
 * string. Mirrors the inline agent loop in bin/install.js lines 9330-9340:
 *   ~/\.claude/ → pathPrefix
 *   $HOME/\.claude/ → pathPrefix
 *   ~/\.claude\b → normalizedPathPrefix
 *   $HOME/\.claude\b → normalizedPathPrefix
 *
 * Skipped for any runtime that declares `hostBehaviors.noPathRewrite`
 * (descriptor-driven, ADR-1239 / #2096 — folds the prior hardcoded
 * `runtime === 'antigravity'` literal; Antigravity does NOT do path rewrites
 * in the inline loop / #2103 — folds the prior hardcoded
 * `runtime === 'copilot'` literal onto the same descriptor field, since
 * copilot also skips these rewrites). NO stamp
 * (_stampNonClaudeRuntimeDefaults) — agents are NOT stamped in the inline loop.
 *
 * ADR-1235 §1: pre-converter cross-cutting for descriptor-driven agent pipeline.
 * Exported as `applyAgentPathRewrites` for testing and for injection into
 * stageAgentsForRuntimeWithConverter via agentCtx.
 *
 * @param content     raw agent file content
 * @param runtime     canonical runtime ID
 * @param pathPrefix  trailing-slash path prefix (e.g. '$HOME/.cursor/')
 * @returns content with path-prefix rewrites applied (or unchanged for noPathRewrite runtimes, e.g. copilot)
 */
function applyAgentPathRewrites(content: string, runtime: string, pathPrefix: string): string {
  if (_hostBehaviors(runtime).noPathRewrite === true) return content;
  const normalizedPathPrefix = pathPrefix.replace(/\/$/, '');
  content = content.replace(/~\/\.claude\//g, pathPrefix);
  content = content.replace(/\$HOME\/\.claude\//g, pathPrefix);
  content = content.replace(/~\/\.claude\b/g, normalizedPathPrefix);
  content = content.replace(/\$HOME\/\.claude\b/g, normalizedPathPrefix);
  return content;
}

// ── End rewrite engine ────────────────────────────────────────────────────────

/**
 * Apply Co-Authored-By attribution policy to file content.
 *   - null      -> remove the Co-Authored-By line and its preceding blank line
 *   - undefined -> leave content unchanged
 *   - string    -> replace the value ($ escaped to block backreference injection)
 *
 * Pure content transform, relocated from bin/install.js per ADR-1508
 * (epic #1507, #1510 Phase 1). NOTE: getCommitAttribution stays in the
 * installer — it is impure install-time config I/O (reads runtime
 * settings.json, uses the install-time config-dir + cache), not a content
 * transform, so it does not belong behind this content-conversion seam.
 */
function processAttribution(
  content: string,
  attribution: string | null | undefined,
): string {
  if (attribution === null) {
    // Remove Co-Authored-By lines and the preceding blank line
    return content.replace(/(\r?\n){2}Co-Authored-By:.*$/gim, '');
  }
  if (attribution === undefined) {
    return content;
  }
  // Replace with custom attribution (escape $ to prevent backreference injection)
  const safeAttribution = attribution.replace(/\$/g, '$$$$');
  return content.replace(/Co-Authored-By:.*$/gim, `Co-Authored-By: ${safeAttribution}`);
}

export = {
  processAttribution,
  // #2103: public accessor for hostBehaviors.agentFileExtension, exported so
  // surface.cts's _syncGsdDir can derive the .agent.md rename from the SAME
  // descriptor read as install-engine.cts (folds a duplicated hardcoded
  // `runtime === 'copilot'` literal).
  agentFileExtensionFor,
  yamlIdentifier,
  yamlQuote,
  toSingleLine,
  extractFrontmatterAndBody,
  extractFrontmatterField,
  skillFrontmatterName,
  convertClaudeToCopilotContent,
  convertClaudeCommandToCopilotSkill,
  convertClaudeToAntigravityContent,
  convertClaudeCommandToAntigravitySkill,
  convertClaudeCommandToClaudeSkill,
  convertClaudeCommandToKimiSkill,
  convertClaudeCommandToKimiCodeSkill,
  buildKimiAgentArtifacts,
  convertClaudeToCursorMarkdown,
  convertClaudeCommandToCursorSkill,
  convertClaudeCommandToCursorCommand,
  convertClaudeToWindsurfMarkdown,
  convertClaudeCommandToWindsurfSkill,
  convertClaudeCommandToWindsurfWorkflow,
  convertClaudeToAugmentMarkdown,
  convertClaudeCommandToAugmentSkill,
  convertClaudeToTraeMarkdown,
  convertClaudeCommandToTraeSkill,
  convertClaudeToCodebuddyMarkdown,
  convertClaudeCommandToCodebuddySkill,
  convertClaudeCommandToCodebuddyCommand,
  convertClaudeToCliineMarkdown,
  convertClaudeCommandToClineSkill,
  convertSlashCommandsToCodexSkillMentions,
  getCodexSkillAdapterHeader,
  convertClaudeToCodexMarkdown,
  convertClaudeCommandToCodexSkill,
  neutralizeAgentReferences,
  convertClaudeCommandToOpencodeSkill,
  convertClaudeCommandToKiloSkill,
  // #2087 — opencode/kilo command-frontmatter converters, exported so the
  // layout-driven `convertedCommandsKind` can resolve them by name (routes the
  // opencode/kilo command install through the engine instead of the bespoke path).
  convertClaudeToOpencodeFrontmatter,
  convertClaudeToKiloFrontmatter,
  readGsdCommandNames,
  transformContentToHyphen,
  // #1383: version resolver (exported for regression test of the Codex
  // missing-package.json crash + the VERSION-file source of truth).
  resolveVersionFrom,
  // #1182: agent converters + tool-name table dependency closure
  claudeToCopilotTools,
  convertCopilotToolName,
  claudeToGeminiTools,
  convertGeminiToolName,
  convertClaudeAgentToCopilotAgent,
  convertClaudeAgentToAntigravityAgent,
  convertClaudeAgentToCursorAgent,
  convertClaudeAgentToWindsurfAgent,
  convertClaudeAgentToAugmentAgent,
  convertClaudeAgentToTraeAgent,
  convertClaudeAgentToCodebuddyAgent,
  convertClaudeAgentToClineAgent,
  convertClaudeAgentToCodexAgent,
  // ADR-1239 / #2092 Phase B Upgrade 1: native .qwen/agents/*.md subagent
  // projection — registered by name so convertedAgentsKind's
  // conversionExports[converterName] dispatch (runtime-artifact-layout.cts)
  // can resolve it from capabilities/qwen/capability.json's agents kind.
  convertClaudeAgentToQwenAgent,
  // #1511 ADR-1508 Phase 2: rewrite engine deep seam
  // Low-level walkers (pathPrefix + attribution pre-resolved by caller):
  applyRuntimeContentRewritesInPlace,
  applyRuntimeContentRewritesForCommandsInPlace,
  // High-level wrappers (derive pathPrefix + attribution from opts):
  rewriteStagedSkillBodies,
  rewriteStagedCommandBodies,
  // ADR-1235 §1: descriptor-driven agent cross-cutting
  applyAgentPathRewrites,
  normalizeAgentBodyForRuntime,
  _computePathPrefix: computePathPrefix,
  _applyRuntimeRewrites,
  _stampNonClaudeRuntimeDefaults,
  // #1521: canonical non-Claude runtime list for test files and tooling
  NON_CLAUDE_RUNTIMES,
};
