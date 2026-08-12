/**
 * Agent Install Check — moved from core.cts (ADR-857 T0 #1268 phase rehome-core-squatters).
 *
 * Owns:
 *   - getAgentsDir(runtime?, projectRoot?): string
 *   - checkAgentsInstalled(runtime?, projectRoot?): AgentsInstalledResult
 *
 * The core.cjs re-export spine was retired in epic #1267; callers import
 * these symbols from agent-install-check.cjs directly.
 */

import fs from 'node:fs';
import path from 'node:path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import modelProfiles = require('./model-profiles.cjs');
const { MODEL_PROFILES } = modelProfiles;
import { getGlobalConfigDir } from './runtime-homes.cjs';
import { getDirName, NO_LOCAL_CONFIG_DIR_SENTINEL } from './runtime-name-policy.cjs';
// #3242 — model-catalog is a genuine leaf (only node:path + its own JSON), which is
// exactly why Phase 1 (#3241) moved isAnthropicFlavoredModel there: this module can
// consume it without dragging model-resolver's config-loader chain into a
// pure read/verify surface.
import { isAnthropicFlavoredModel } from './model-catalog.cjs';
// #3243 — the Codex `.toml` block-range/BOM/scan primitives moved into the typed
// IR module (Phase 3), which this reader now imports rather than defining
// locally. Behavior is unchanged: scanTomlLines/stripBOM here are the exact
// same lenient functions that used to live in this file — see
// codex-agent-toml.cts's module header for the reader/writer reconciliation.
import { stripBOM, scanTomlLines } from './codex-agent-toml.cjs';
import { resolveRuntimeWithPersistedDefault } from './runtime-slash.cjs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import toolsContract = require('./agent-tools-contract.cjs');
const { parseToolsContract, toolsRequireWrite } = toolsContract;

interface SandboxViolation {
  agent: string;
  sandbox_mode: string;
  declared_tools: string;
  /**
   * Which way the .toml disagrees with the contract. `under-privileged` = the
   * sandbox is weaker than the tools require (the agent cannot write its
   * declared outputs); `over-privileged` = the sandbox grants write to a
   * contract that declares no write tool (#2540 direction 3).
   */
  direction: 'under-privileged' | 'over-privileged';
}

interface AgentsInstalledResult {
  agents_installed: boolean;
  missing_agents: string[];
  installed_agents: string[];
  incomplete_agents: string[];
  sandbox_violations: SandboxViolation[];
  agents_dir: string;
  agent_runtime: string;
}

/**
 * Extract the declared tool contract from an installed agent .md.
 * Codex installs embed it in the <codex_agent_role> header (frontmatter tools
 * are stripped by the converter); other layouts keep it in YAML frontmatter,
 * where both the inline and block-list `tools:` shapes occur — parsing goes
 * through the shared agent-tools-contract seam (#2540 review). Returns []
 * when no contract is found.
 */
function _extractDeclaredTools(md: string): string[] {
  const roleBlock = /<codex_agent_role>([\s\S]*?)<\/codex_agent_role>/.exec(md);
  const scope = roleBlock
    ? roleBlock[1]
    : (/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1] ?? '');
  return parseToolsContract(scope ?? '');
}

/**
 * Read the `sandbox_mode` scalar out of a generated agent .toml.
 *
 * Scoped deliberately to the shape GSD emits (generateCodexAgentToml): bare
 * top-level keys, `developer_instructions = \'\'\'` always last. The search is
 * cut at that exact line so a `sandbox_mode = "…"` line occurring inside the
 * agent body is never read as the key. Both basic and literal strings are
 * accepted because an install that drifted to `sandbox_mode = \'read-only\'` is
 * exactly the hand-edit this validator exists to catch.
 *
 * NOT a TOML parser, and deliberately not trying to be: arbitrary valid TOML
 * (dotted keys, escapes, nested tables, multiline openers of other keys) needs
 * a real parser, and this repo already has one in `bin/install.js`
 * (`parseTomlToObject`). That module consumes this leaf, so using it here means
 * extracting it to a shared leaf first — tracked as a follow-up rather than
 * carried by this bug-fix (#2540 review round 3). Returns null when no key is
 * present (e.g. sandboxTier "none").
 */
function _sandboxModeOf(toml: string): string | null {
  // Cut at the canonical trailing multiline value, and at the first table
  // header — a key under `[table]` is not the top-level sandbox, and reading
  // one would report a violation that does not exist.
  const beforeInstructions = toml.split(/^developer_instructions\s*=\s*(?:'''|""")/m)[0] ?? toml;
  const body = beforeInstructions.split(/^\s*\[/m)[0] ?? '';
  const m = /^sandbox_mode\s*=\s*(?:"([^"]*)"|'([^']*)')/m.exec(body);
  return m ? (m[1] ?? m[2] ?? '') : null;
}

/**
 * Frozen reason enum for {@link checkCodexModelPosture}. Per CONTRIBUTING's
 * typed-IR rule ("Error / status / reason → a frozen enum"): callers and tests
 * assert on these wire values, never on prose. Adding a member is a deliberate
 * three-way coordinated change — enum, emitting site, and the enum-lock test.
 */
const POSTURE_REASON = Object.freeze({
  ANTHROPIC_FLAVORED_MODEL: 'anthropic_flavored_model',
  ORPHANED_REASONING_EFFORT: 'orphaned_reasoning_effort',
  UNREADABLE: 'unreadable',
  NOT_CODEX: 'not_codex',
  AGENTS_DIR_MISSING: 'agents_dir_missing',
});

type PostureReason = (typeof POSTURE_REASON)[keyof typeof POSTURE_REASON];

interface PostureViolation {
  agent: string;
  file: string;
  reason: PostureReason;
  value?: string;
}

interface CodexModelPostureResult {
  ok: boolean;
  violations: PostureViolation[];
  checked: string[];
  agents_dir: string;
  agent_runtime: string;
  reason?: PostureReason;
}

// Matches the value-truncation convention in bin/install.js's
// _warnCodexModelOverrideDropped: values over 64 chars are capped so an
// oversized or secret-shaped config value can never reach a report in full.
function truncatePostureValue(value: string): string {
  return value.length > 64 ? `${value.slice(0, 64)}…` : value;
}

/**
 * Resolve the agents directory for the given runtime.
 *
 * Priority:
 *   1. GSD_AGENTS_DIR env var (explicit override, any runtime)
 *   2. For claude runtime: __dirname-relative path (agents/ sibling of gsd-core/)
 *      This is correct for both repo runs and real installs (the runtime config dir's
 *      agents/ folder) because gsd-tools.cjs lives inside gsd-core/bin/ in both cases.
 *   3. For non-claude runtimes with a manifest-backed project-local install:
 *      <projectRoot>/<localConfigDir>/agents (or <projectRoot>/agents when
 *      the runtime's local install targets the project root). Requiring the
 *      GSD manifest prevents runtime-native project agents from shadowing a
 *      working global GSD install. Symlinked local agent directories are ignored.
 *   4. For non-claude runtimes: getGlobalConfigDir(runtime)/agents
 *
 * @param runtime - the active runtime name; defaults to GSD_RUNTIME env, then 'claude'
 * @param projectRoot - canonical project root for local-install discovery
 */
function getAgentsDir(runtime?: string, projectRoot?: string): string {
  if (process.env['GSD_AGENTS_DIR']) {
    return process.env['GSD_AGENTS_DIR'];
  }
  const resolved = runtime ?? (process.env['GSD_RUNTIME'] || 'claude');
  if (resolved === 'claude') {
    return path.join(__dirname, '..', '..', '..', 'agents');
  }
  if (projectRoot) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runtimes } = require('./capability-registry.cjs') as {
      runtimes: Record<string, { runtime?: { hostBehaviors?: { localTargetIsProjectRoot?: boolean } } }>;
    };
    const runtimeConfig = runtimes[resolved]?.runtime;
    const localConfigDirName = getDirName(resolved);
    const localConfigDir = localConfigDirName === NO_LOCAL_CONFIG_DIR_SENTINEL
      ? undefined
      : runtimeConfig?.hostBehaviors?.localTargetIsProjectRoot
        ? projectRoot
        : path.join(projectRoot, localConfigDirName);
    if (!localConfigDir) {
      return path.join(getGlobalConfigDir(resolved), 'agents');
    }
    const localAgentsDir = path.join(localConfigDir, 'agents');
    const manifestPath = path.join(localConfigDir, 'gsd-file-manifest.json');
    try {
      if (fs.lstatSync(localAgentsDir).isDirectory() && fs.lstatSync(manifestPath).isFile()) {
        return localAgentsDir;
      }
    } catch {
      // Local discovery is best-effort; any probe failure preserves global fallback.
    }
  }
  return path.join(getGlobalConfigDir(resolved), 'agents');
}

/**
 * Check which GSD agents are installed on disk.
 *
 * @param runtime - the active runtime name; when omitted, resolved from
 *   GSD_RUNTIME, then `.planning/config.json`, then the runtime the installer
 *   persisted to `~/.gsd/defaults.json`, then 'claude'
 * @param projectRoot - canonical project root for local-install discovery
 */
function checkAgentsInstalled(runtime?: string, projectRoot?: string): AgentsInstalledResult {
  // #2540 BLOCKER (review round 7): this previously read GSD_RUNTIME then fell
  // straight to 'claude', so on the issue's own repro — a Codex install with no
  // GSD_RUNTIME exported and no project-level runtime — it resolved 'claude',
  // the codex-gated sandbox loop below never ran, and `validate agents`
  // reported the same false pass #2540 was filed about. The installer persists
  // `runtime: "codex"` to ~/.gsd/defaults.json (bin/install.js
  // writeNonClaudeDefaults); the read path now looks where the write path
  // writes. Scoped to a separate resolver rather than changing resolveRuntime
  // itself, whose 118-symbol blast radius makes a precedence change its own
  // piece of work.
  const resolvedRuntime = runtime ?? resolveRuntimeWithPersistedDefault(projectRoot ?? null);
  const agentsDir = getAgentsDir(resolvedRuntime, projectRoot);
  const expectedAgents = Object.keys(MODEL_PROFILES);
  const installed: string[] = [];
  const missing: string[] = [];

  if (!fs.existsSync(agentsDir)) {
    return {
      agents_installed: false,
      missing_agents: expectedAgents,
      installed_agents: [],
      incomplete_agents: [],
      sandbox_violations: [],
      agents_dir: agentsDir,
      agent_runtime: resolvedRuntime,
    };
  }

  for (const agent of expectedAgents) {
    const agentFile = path.join(agentsDir, `${agent}.md`);
    const agentFileCopilot = path.join(agentsDir, `${agent}.agent.md`);
    const agentFileCodex = path.join(agentsDir, `${agent}.toml`);
    const agentFileKimiYaml = path.join(agentsDir, 'subagents', `${agent}.yaml`);
    const agentFileKimiPrompt = path.join(agentsDir, 'subagents', `${agent}.md`);
    const kimiAgentInstalled =
      resolvedRuntime === 'kimi' &&
      fs.existsSync(agentFileKimiYaml) &&
      fs.existsSync(agentFileKimiPrompt);
    if (
      fs.existsSync(agentFile) ||
      fs.existsSync(agentFileCopilot) ||
      fs.existsSync(agentFileCodex) ||
      kimiAgentInstalled
    ) {
      installed.push(agent);
    } else {
      missing.push(agent);
    }
  }

  // ── Manifest-backed completeness check ──────────────────────────────────────
  // If a gsd-file-manifest.json exists alongside the agents dir (parent dir),
  // verify that every manifest-tracked file for each expected agent is present
  // on disk. Missing manifest-tracked files indicate an incomplete install even
  // when the plain presence check above passed (e.g. .md present, .toml absent).
  // If no manifest is found the check is a no-op (graceful for claude/bundled).
  const incomplete: string[] = [];
  // #2872: the manifest read is the Installer Migration Module's, not a
  // fourth private copy of it. Lazily required — matching this file's own
  // capability-registry idiom — so a pure read/verify surface on the
  // init/verify hot path takes no new static dependency.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { readInstallManifest } = require('./installer-migrations.cjs') as {
    readInstallManifest: (configDir: string) => { files: Record<string, string> };
  };
  const manifestFiles: Record<string, unknown> = readInstallManifest(path.dirname(agentsDir)).files;

  if (Object.keys(manifestFiles).length > 0) {
    for (const agent of expectedAgents) {
      // Find all manifest keys that belong to this agent:
      // key must be "agents/<agentName>.<ext>" with no further path segments.
      const agentPrefix = `agents/${agent}.`;
      const agentManifestKeys = Object.keys(manifestFiles).filter(key => {
        if (!key.startsWith(agentPrefix)) return false;
        const rest = key.slice(agentPrefix.length);
        // rest must be a bare extension (no slashes, non-empty)
        return rest.length > 0 && !rest.includes('/');
      });
      if (agentManifestKeys.length === 0) {
        // Agent not tracked in manifest — skip completeness check for this agent
        continue;
      }
      const allPresent = agentManifestKeys.every(key => {
        const basename = key.slice('agents/'.length);
        return fs.existsSync(path.join(agentsDir, basename));
      });
      if (!allPresent) {
        incomplete.push(agent);
      }
    }
  }

  // ── Sandbox/tool-contract semantic check (#2540) ────────────────────────────
  // A generated agent .toml whose sandbox_mode is weaker than the role's
  // declared tool contract (Write/Edit/NotebookEdit → workspace-write) means
  // the agent cannot produce its declared outputs even though every file is
  // present — exactly the false-pass this check closes. The contract is read
  // from the sibling installed .md (<codex_agent_role> header or frontmatter).
  // Agents without a .toml, without a sandbox_mode key (sandboxTier "none"),
  // or without a readable contract are skipped — and the whole check is gated
  // to the codex runtime (#2566 review), because `sandbox_mode` is Codex's
  // vocabulary: only the Codex installer emits it, so on any other runtime a
  // `sandbox_mode`-bearing .toml is not GSD's artifact and its semantics are
  // not ours to judge.
  //
  // The inverse direction — workspace-write on a contract declaring no write
  // tool — is checked symmetrically (#2540 direction 3, review round 4). It
  // needs no new parsing: `_sandboxModeOf` is the same reader the read-only
  // direction already trusts, and the comparison stays inside the two-value
  // closed vocabulary, so a mode outside it (a hand-written
  // `danger-full-access`, say) is left alone rather than guessed at. A real
  // TOML parser is still the prerequisite for a *general* privilege audit;
  // this is the narrow check against the derived value.
  //
  // The install-time drift it closes: install while an agent legitimately
  // needs Write, later tighten its `tools:` to drop Write without re-running
  // the installer, and the stale on-disk .toml keeps `workspace-write`
  // indefinitely while `validate agents` and `validate health` both report
  // clean. Nothing else re-derives the live TOML's privilege against the
  // current contract in that direction.
  const sandboxViolations: SandboxViolation[] = [];
  const sandboxCheckAgents = resolvedRuntime === 'codex' ? expectedAgents : [];
  for (const agent of sandboxCheckAgents) {
    const tomlPath = path.join(agentsDir, `${agent}.toml`);
    if (!fs.existsSync(tomlPath)) continue;
    let toml: string;
    let md: string;
    try {
      toml = fs.readFileSync(tomlPath, 'utf8');
    } catch {
      continue; // unreadable toml — presence/completeness checks own this case
    }
    try {
      md = fs.readFileSync(path.join(agentsDir, `${agent}.md`), 'utf8');
    } catch {
      // A Codex install always writes the .md beside the .toml, so a missing
      // contract source there is an incomplete install, not a silent skip —
      // otherwise this semantic check goes vacuous exactly where it matters
      // (#2540). Other runtimes may legitimately ship .toml-only layouts, but
      // they never reach here: the whole loop is codex-gated above.
      if (!incomplete.includes(agent)) {
        incomplete.push(agent);
      }
      continue;
    }
    const sandboxMode = _sandboxModeOf(toml);
    if (sandboxMode === null) continue;
    const declaredTools = _extractDeclaredTools(md);
    // An absent or unreadable contract is not evidence about privilege: []
    // would read as "declares no write tool" and flag every such agent as
    // over-privileged. Skipping is behaviour-preserving for the read-only
    // direction too — `toolsRequireWrite([])` was already false.
    if (declaredTools.length === 0) continue;
    const requiresWrite = toolsRequireWrite(declaredTools);
    const direction =
      requiresWrite && sandboxMode === 'read-only'
        ? 'under-privileged'
        : !requiresWrite && sandboxMode === 'workspace-write'
          ? 'over-privileged'
          : null;
    if (direction) {
      sandboxViolations.push({
        agent,
        sandbox_mode: sandboxMode,
        declared_tools: declaredTools.join(', '),
        direction,
      });
    }
  }

  return {
    agents_installed:
      installed.length > 0 &&
      missing.length === 0 &&
      incomplete.length === 0 &&
      sandboxViolations.length === 0,
    missing_agents: missing,
    installed_agents: installed,
    incomplete_agents: incomplete,
    sandbox_violations: sandboxViolations,
    agents_dir: agentsDir,
    agent_runtime: resolvedRuntime,
  };
}

/**
 * Validate Codex `.toml` agent files for Anthropic-flavored `model` pins and
 * orphaned `model_reasoning_effort` values (ADR-2313 D6, #3242).
 *
 * A new sibling export to {@link checkAgentsInstalled}, deliberately — that
 * function carries 33 upstream dependents and cyclomatic complexity 25, so this
 * posture check gets zero new branches there (see 40-design.md "Rejected" #1).
 * Presence is `checkAgentsInstalled`'s job; this function's job starts only once
 * the runtime is confirmed `codex` and only inspects posture, never presence.
 *
 * Read-only: detects, never repairs (repair is Phase 3, #3243).
 *
 * @param runtime - the active runtime name; defaults to GSD_RUNTIME env, then 'claude'
 * @param projectRoot - canonical project root for local-install discovery
 */
function checkCodexModelPosture(runtime?: string, projectRoot?: string): CodexModelPostureResult {
  // Short-circuit BEFORE any filesystem access: a non-codex runtime must never
  // have its agents directory resolved or a stray .toml inspected, however
  // violating that file's contents would be if it were ever read (#3242 row 25).
  const resolvedRuntime = runtime ?? (process.env['GSD_RUNTIME'] || 'claude');
  if (resolvedRuntime !== 'codex') {
    return {
      ok: true,
      violations: [],
      checked: [],
      agents_dir: '',
      agent_runtime: resolvedRuntime,
      reason: POSTURE_REASON.NOT_CODEX,
    };
  }

  const agentsDir = getAgentsDir(resolvedRuntime, projectRoot);
  if (!fs.existsSync(agentsDir)) {
    // Presence is checkAgentsInstalled's job — an absent agents dir here is a
    // distinct, non-violating outcome, not a failure of this check.
    return {
      ok: true,
      violations: [],
      checked: [],
      agents_dir: agentsDir,
      agent_runtime: resolvedRuntime,
      reason: POSTURE_REASON.AGENTS_DIR_MISSING,
    };
  }

  // Skip symlinks — matches cmdEffortSync's existing idiom in commands.cts
  // ("Skip symlinks — only write regular files..."). Here the risk is reading
  // (not writing) through a symlink: readFileSync follows symlinks, so an
  // agents-dir symlink pointing at an arbitrary file would let that target's
  // contents be echoed into this function's `value` field. A symlinked agent
  // file is a structural install choice (checkAgentsInstalled's territory),
  // not a model-content posture defect, so it is silently excluded from
  // `checked` rather than reported as a distinct violation — same shape as
  // cmdEffortSync, which silently drops symlinks from its file list rather
  // than inventing a new skip/violation reason.
  const tomlFiles = fs
    .readdirSync(agentsDir)
    .filter((entry) => {
      if (!entry.endsWith('.toml')) return false;
      try {
        return fs.lstatSync(path.join(agentsDir, entry)).isFile();
      } catch {
        return false;
      }
    })
    .sort();

  const checked: string[] = [];
  const violations: PostureViolation[] = [];

  for (const entry of tomlFiles) {
    const agentName = entry.slice(0, -'.toml'.length);
    const filePath = path.join(agentsDir, entry);
    checked.push(agentName);

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch {
      // Never throws, never silently skips — an unreadable file is reported and
      // the loop continues checking the rest (40-design.md "Rejected" #5).
      violations.push({ agent: agentName, file: filePath, reason: POSTURE_REASON.UNREADABLE });
      continue;
    }

    const { model, hasReasoningEffort } = scanTomlLines(stripBOM(raw));

    if (model !== null && isAnthropicFlavoredModel(model)) {
      violations.push({
        agent: agentName,
        file: filePath,
        reason: POSTURE_REASON.ANTHROPIC_FLAVORED_MODEL,
        value: truncatePostureValue(model),
      });
    } else if (model === null && hasReasoningEffort) {
      // #838 coupling: a reasoning-effort pin with no model pin means Codex
      // inherits the session model while the effort pin silently disagrees.
      violations.push({
        agent: agentName,
        file: filePath,
        reason: POSTURE_REASON.ORPHANED_REASONING_EFFORT,
      });
    }
  }

  return {
    ok: violations.length === 0,
    violations,
    checked,
    agents_dir: agentsDir,
    agent_runtime: resolvedRuntime,
  };
}

export = {
  getAgentsDir,
  checkAgentsInstalled,
  checkCodexModelPosture,
  POSTURE_REASON,
};
