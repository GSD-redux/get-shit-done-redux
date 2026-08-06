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

interface AgentsInstalledResult {
  agents_installed: boolean;
  missing_agents: string[];
  installed_agents: string[];
  incomplete_agents: string[];
  agents_dir: string;
  agent_runtime: string;
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
 * @param runtime - the active runtime name; defaults to GSD_RUNTIME env, then 'claude'
 * @param projectRoot - canonical project root for local-install discovery
 */
function checkAgentsInstalled(runtime?: string, projectRoot?: string): AgentsInstalledResult {
  const resolvedRuntime = runtime ?? (process.env['GSD_RUNTIME'] || 'claude');
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
  const manifestPath = path.join(path.dirname(agentsDir), 'gsd-file-manifest.json');
  let manifestFiles: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'files' in parsed &&
      typeof (parsed as Record<string, unknown>)['files'] === 'object' &&
      (parsed as Record<string, unknown>)['files'] !== null
    ) {
      manifestFiles = (parsed as Record<string, Record<string, unknown>>)['files'];
    }
  } catch {
    // No manifest or unreadable — completeness check is skipped
  }

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

  return {
    agents_installed: installed.length > 0 && missing.length === 0 && incomplete.length === 0,
    missing_agents: missing,
    installed_agents: installed,
    incomplete_agents: incomplete,
    agents_dir: agentsDir,
    agent_runtime: resolvedRuntime,
  };
}

export = {
  getAgentsDir,
  checkAgentsInstalled,
};
