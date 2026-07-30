'use strict';

/**
 * Agent Install Check Module — behaviour tests (#1268 T0, T1 #1277)
 *
 * Seam: gsd-core/bin/lib/agent-install-check.cjs
 * Interface: getAgentsDir, checkAgentsInstalled
 *
 * Verifies:
 *   1. getAgentsDir behaviour: GSD_AGENTS_DIR override, claude path, non-claude path
 *   2. checkAgentsInstalled behaviour against temp dirs via GSD_AGENTS_DIR:
 *      - missing dir → agents_installed:false, missing_agents = all expected
 *      - existing-but-empty dir → installed_agents:[], agents_installed:false
 *      - no manifest → completeness skipped (incomplete_agents empty)
 *      - partial manifest (agent.toml absent, agent.md present) → incomplete_agents includes agent
 *      - malformed manifest → no throw, completeness skipped
 */

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup } = require('./helpers.cjs');

const AGENT_INSTALL_CHECK_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'agent-install-check.cjs'
);
const RUNTIME_HOMES_PATH = path.join(
  __dirname, '..', 'gsd-core', 'bin', 'lib', 'runtime-homes.cjs'
);

const agentInstallCheck = require(AGENT_INSTALL_CHECK_PATH);
const { getGlobalConfigDir } = require(RUNTIME_HOMES_PATH);
const { getDirName } = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'runtime-name-policy.cjs'));

// Get EXPECTED_AGENTS from model-profiles (same source of truth)
const MODEL_PROFILES = require(path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'model-profiles.cjs')).MODEL_PROFILES;
const EXPECTED_AGENTS = Object.keys(MODEL_PROFILES);

// ─── Environment isolation ────────────────────────────────────────────────────

let savedAgentsDir;
let savedRuntime;
let savedCodexHome;

beforeEach(() => {
  savedAgentsDir = process.env['GSD_AGENTS_DIR'];
  savedRuntime = process.env['GSD_RUNTIME'];
  savedCodexHome = process.env['CODEX_HOME'];
  delete process.env['GSD_AGENTS_DIR'];
  delete process.env['GSD_RUNTIME'];
  delete process.env['CODEX_HOME'];
});

afterEach(() => {
  if (savedAgentsDir === undefined) {
    delete process.env['GSD_AGENTS_DIR'];
  } else {
    process.env['GSD_AGENTS_DIR'] = savedAgentsDir;
  }
  if (savedRuntime === undefined) {
    delete process.env['GSD_RUNTIME'];
  } else {
    process.env['GSD_RUNTIME'] = savedRuntime;
  }
  if (savedCodexHome === undefined) {
    delete process.env['CODEX_HOME'];
  } else {
    process.env['CODEX_HOME'] = savedCodexHome;
  }
});

function createCompleteAgents(agentsDir) {
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const agent of EXPECTED_AGENTS) {
    fs.writeFileSync(path.join(agentsDir, `${agent}.toml`), `name = "${agent}"\n`);
  }
}

function markLocalGsdInstall(configDir) {
  fs.writeFileSync(
    path.join(configDir, 'gsd-file-manifest.json'),
    JSON.stringify({ files: {} }),
  );
}

function createCompleteLocalGsdInstall(configDir) {
  const agentsDir = path.join(configDir, 'agents');
  createCompleteAgents(agentsDir);
  markLocalGsdInstall(configDir);
  return agentsDir;
}

// ─── 1. getAgentsDir behaviour ────────────────────────────────────────────────

describe('getAgentsDir', () => {
  test('GSD_AGENTS_DIR override takes priority', () => {
    process.env['GSD_AGENTS_DIR'] = '/tmp/x';
    assert.strictEqual(agentInstallCheck.getAgentsDir(), '/tmp/x');
    assert.strictEqual(agentInstallCheck.getAgentsDir('cursor'), '/tmp/x');
  });

  test('claude runtime returns __dirname-relative path', () => {
    const fromModule = agentInstallCheck.getAgentsDir('claude');
    // Should end with /agents
    assert.ok(fromModule.endsWith(path.sep + 'agents') || fromModule.endsWith('/agents'),
      `Expected path to end with /agents, got: ${fromModule}`);
  });

  test('non-claude runtime returns getGlobalConfigDir(runtime)/agents', () => {
    const runtime = 'cursor';
    const expected = path.join(getGlobalConfigDir(runtime), 'agents');
    assert.strictEqual(agentInstallCheck.getAgentsDir(runtime), expected);
  });

  test('GSD_RUNTIME env var is respected when no argument provided', () => {
    process.env['GSD_RUNTIME'] = 'codex';
    const expected = path.join(getGlobalConfigDir('codex'), 'agents');
    assert.strictEqual(agentInstallCheck.getAgentsDir(), expected);
  });

  test('defaults to claude when no arg and no GSD_RUNTIME', () => {
    const fromModule = agentInstallCheck.getAgentsDir();
    const fromClaude = agentInstallCheck.getAgentsDir('claude');
    assert.strictEqual(fromModule, fromClaude);
  });

  test('a manifest-backed local runtime installation wins over global agents', (t) => {
    const projectRoot = createTempDir('gsd-local-codex-');
    const globalHome = createTempDir('gsd-global-codex-');
    const localAgentsDir = createCompleteLocalGsdInstall(path.join(projectRoot, '.codex'));
    t.after(() => cleanup(projectRoot));
    t.after(() => cleanup(globalHome));
    createCompleteAgents(path.join(globalHome, 'agents'));
    process.env['CODEX_HOME'] = globalHome;

    assert.strictEqual(agentInstallCheck.getAgentsDir('codex', projectRoot), localAgentsDir);
    assert.strictEqual(agentInstallCheck.checkAgentsInstalled('codex', projectRoot).agents_installed, true);
  });

  test('GSD_AGENTS_DIR remains terminal when a local Codex installation exists', (t) => {
    const projectRoot = createTempDir('gsd-local-codex-');
    const overrideDir = path.join(projectRoot, 'override-agents');
    createCompleteLocalGsdInstall(path.join(projectRoot, '.codex'));
    t.after(() => cleanup(projectRoot));
    fs.mkdirSync(overrideDir, { recursive: true });
    process.env['GSD_AGENTS_DIR'] = overrideDir;

    const result = agentInstallCheck.checkAgentsInstalled('codex', projectRoot);
    assert.strictEqual(result.agents_dir, overrideDir);
    assert.strictEqual(result.agents_installed, false);
    assert.deepStrictEqual(result.missing_agents, EXPECTED_AGENTS);
  });

  test('a manifest-backed empty local directory is authoritative over complete global agents', (t) => {
    const projectRoot = createTempDir('gsd-local-codex-');
    const globalHome = createTempDir('gsd-global-codex-');
    const localAgentsDir = path.join(projectRoot, '.codex', 'agents');
    t.after(() => cleanup(projectRoot));
    t.after(() => cleanup(globalHome));
    fs.mkdirSync(localAgentsDir, { recursive: true });
    markLocalGsdInstall(path.dirname(localAgentsDir));
    createCompleteAgents(path.join(globalHome, 'agents'));
    process.env['CODEX_HOME'] = globalHome;

    const result = agentInstallCheck.checkAgentsInstalled('codex', projectRoot);
    assert.strictEqual(result.agents_dir, localAgentsDir);
    assert.strictEqual(result.agents_installed, false);
    assert.deepStrictEqual(result.missing_agents, EXPECTED_AGENTS);
  });

  test('Codex falls back to global agents when no local directory exists', (t) => {
    const projectRoot = createTempDir('gsd-local-codex-');
    const globalHome = createTempDir('gsd-global-codex-');
    t.after(() => cleanup(projectRoot));
    t.after(() => cleanup(globalHome));
    createCompleteAgents(path.join(globalHome, 'agents'));
    process.env['CODEX_HOME'] = globalHome;

    const result = agentInstallCheck.checkAgentsInstalled('codex', projectRoot);
    assert.strictEqual(result.agents_dir, path.join(globalHome, 'agents'));
    assert.strictEqual(result.agents_installed, true);
  });

  test('Codex falls back to global agents when the local candidate is a regular file', (t) => {
    const projectRoot = createTempDir('gsd-local-codex-');
    const globalHome = createTempDir('gsd-global-codex-');
    const localCandidate = path.join(projectRoot, '.codex', 'agents');
    t.after(() => cleanup(projectRoot));
    t.after(() => cleanup(globalHome));
    fs.mkdirSync(path.dirname(localCandidate), { recursive: true });
    fs.writeFileSync(localCandidate, 'not an agents directory\n');
    createCompleteAgents(path.join(globalHome, 'agents'));
    process.env['CODEX_HOME'] = globalHome;

    const result = agentInstallCheck.checkAgentsInstalled('codex', projectRoot);
    assert.strictEqual(result.agents_dir, path.join(globalHome, 'agents'));
    assert.strictEqual(result.agents_installed, true);
  });

  test('Codex falls back to global agents when the local candidate cannot be inspected', (t) => {
    const projectRoot = createTempDir('gsd-local-codex-');
    const globalHome = createTempDir('gsd-global-codex-');
    const localAgentsDir = path.join(projectRoot, '.codex', 'agents');
    const realLstatSync = fs.lstatSync;
    t.after(() => cleanup(projectRoot));
    t.after(() => cleanup(globalHome));
    fs.mkdirSync(localAgentsDir, { recursive: true });
    markLocalGsdInstall(path.dirname(localAgentsDir));
    createCompleteAgents(path.join(globalHome, 'agents'));
    process.env['CODEX_HOME'] = globalHome;
    t.mock.method(fs, 'lstatSync', function injectedLocalProbeFailure(target, ...args) {
      if (target === localAgentsDir) {
        throw Object.assign(new Error('injected EACCES'), { code: 'EACCES' });
      }
      return realLstatSync.call(fs, target, ...args);
    });

    const result = agentInstallCheck.checkAgentsInstalled('codex', projectRoot);
    assert.strictEqual(result.agents_dir, path.join(globalHome, 'agents'));
    assert.strictEqual(result.agents_installed, true);
  });

  test('Codex does not follow a symlinked local agents directory', (t) => {
    const projectRoot = createTempDir('gsd-local-codex-');
    const globalHome = createTempDir('gsd-global-codex-');
    const localConfigDir = path.join(projectRoot, '.codex');
    const localAgentsDir = path.join(localConfigDir, 'agents');
    const symlinkTarget = path.join(projectRoot, 'shared-agents');
    t.after(() => cleanup(projectRoot));
    t.after(() => cleanup(globalHome));
    createCompleteAgents(symlinkTarget);
    fs.mkdirSync(localConfigDir, { recursive: true });
    markLocalGsdInstall(localConfigDir);
    createCompleteAgents(path.join(globalHome, 'agents'));
    process.env['CODEX_HOME'] = globalHome;
    try {
      fs.symlinkSync(symlinkTarget, localAgentsDir, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      if (error && ['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
        t.skip('symlink creation is not available on this platform');
        return;
      }
      throw error;
    }

    const result = agentInstallCheck.checkAgentsInstalled('codex', projectRoot);
    assert.strictEqual(result.agents_dir, path.join(globalHome, 'agents'));
    assert.strictEqual(result.agents_installed, true);
  });

  test('a project-native agents directory without a GSD manifest does not override global agents', (t) => {
    const projectRoot = createTempDir('gsd-local-codex-');
    const globalHome = createTempDir('gsd-global-codex-');
    const localAgentsDir = path.join(projectRoot, '.codex', 'agents');
    t.after(() => cleanup(projectRoot));
    t.after(() => cleanup(globalHome));
    createCompleteAgents(localAgentsDir);
    createCompleteAgents(path.join(globalHome, 'agents'));
    process.env['CODEX_HOME'] = globalHome;

    const result = agentInstallCheck.checkAgentsInstalled('codex', projectRoot);
    assert.strictEqual(result.agents_dir, path.join(globalHome, 'agents'));
    assert.strictEqual(result.agents_installed, true);
  });

  test('a manifest-backed Cursor installation resolves from the project root', (t) => {
    const projectRoot = createTempDir('gsd-local-cursor-');
    const localAgentsDir = createCompleteLocalGsdInstall(path.join(projectRoot, getDirName('cursor')));
    t.after(() => cleanup(projectRoot));

    assert.strictEqual(agentInstallCheck.getAgentsDir('cursor', projectRoot), localAgentsDir);
    assert.strictEqual(agentInstallCheck.checkAgentsInstalled('cursor', projectRoot).agents_installed, true);
  });

  test('a manifest-backed Cline installation resolves from the project root', (t) => {
    const projectRoot = createTempDir('gsd-local-cline-');
    const localAgentsDir = createCompleteLocalGsdInstall(projectRoot);
    t.after(() => cleanup(projectRoot));

    assert.strictEqual(agentInstallCheck.getAgentsDir('cline', projectRoot), localAgentsDir);
    assert.strictEqual(agentInstallCheck.checkAgentsInstalled('cline', projectRoot).agents_installed, true);
  });

  test('a partial manifest-backed local installation remains selected and incomplete', (t) => {
    const projectRoot = createTempDir('gsd-local-codex-');
    const localConfigDir = path.join(projectRoot, '.codex');
    const localAgentsDir = createCompleteLocalGsdInstall(localConfigDir);
    const partialAgent = EXPECTED_AGENTS[0];
    t.after(() => cleanup(projectRoot));
    fs.writeFileSync(path.join(localAgentsDir, `${partialAgent}.md`), `# ${partialAgent}\n`);
    fs.unlinkSync(path.join(localAgentsDir, `${partialAgent}.toml`));
    fs.writeFileSync(
      path.join(localConfigDir, 'gsd-file-manifest.json'),
      JSON.stringify({ files: { [`agents/${partialAgent}.md`]: {}, [`agents/${partialAgent}.toml`]: {} } }),
    );

    const result = agentInstallCheck.checkAgentsInstalled('codex', projectRoot);
    assert.strictEqual(result.agents_dir, localAgentsDir);
    assert.strictEqual(result.agents_installed, false);
    assert.deepStrictEqual(result.missing_agents, []);
    assert.deepStrictEqual(result.incomplete_agents, [partialAgent]);
  });

  test('Claude and other runtimes ignore a supplied Codex-local candidate', (t) => {
    const projectRoot = createTempDir('gsd-local-codex-');
    t.after(() => cleanup(projectRoot));
    createCompleteLocalGsdInstall(path.join(projectRoot, '.codex'));

    assert.strictEqual(
      agentInstallCheck.getAgentsDir('claude', projectRoot),
      agentInstallCheck.getAgentsDir('claude'),
    );
    assert.strictEqual(
      agentInstallCheck.getAgentsDir('cursor', projectRoot),
      path.join(getGlobalConfigDir('cursor'), 'agents'),
    );
  });
});

// ─── 2. checkAgentsInstalled behaviour ───────────────────────────────────────

describe('checkAgentsInstalled', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-agent-check-');
    // Point GSD_AGENTS_DIR at a path we control
    process.env['GSD_AGENTS_DIR'] = path.join(tmpDir, 'agents');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('missing dir → agents_installed:false, missing_agents = all expected', () => {
    // agents dir does not exist
    const result = agentInstallCheck.checkAgentsInstalled();
    assert.strictEqual(result.agents_installed, false);
    assert.deepStrictEqual(result.missing_agents, EXPECTED_AGENTS);
    assert.deepStrictEqual(result.installed_agents, []);
    assert.deepStrictEqual(result.incomplete_agents, []);
  });

  test('existing-but-empty dir → installed_agents:[], agents_installed:false', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    const result = agentInstallCheck.checkAgentsInstalled();
    assert.strictEqual(result.agents_installed, false);
    assert.deepStrictEqual(result.installed_agents, []);
    assert.ok(result.missing_agents.length > 0, 'missing_agents should not be empty');
    // No manifest → completeness skipped
    assert.deepStrictEqual(result.incomplete_agents, []);
  });

  test('all agents present, no manifest → agents_installed:true, incomplete_agents:[]', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    // Write all expected agent .md files
    for (const agent of EXPECTED_AGENTS) {
      fs.writeFileSync(path.join(agentsDir, `${agent}.md`), `# ${agent}\n`);
    }

    const result = agentInstallCheck.checkAgentsInstalled();
    assert.strictEqual(result.agents_installed, true);
    assert.deepStrictEqual(result.missing_agents, []);
    assert.deepStrictEqual(result.installed_agents, EXPECTED_AGENTS);
    assert.deepStrictEqual(result.incomplete_agents, []);
  });

  test('partial manifest: agent.toml absent but agent.md present → incomplete_agents includes agent', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    // Write all agent .md files so presence check passes
    for (const agent of EXPECTED_AGENTS) {
      fs.writeFileSync(path.join(agentsDir, `${agent}.md`), `# ${agent}\n`);
    }

    // Pick the first expected agent to make "incomplete" via manifest
    const targetAgent = EXPECTED_AGENTS[0];

    // Write manifest that tracks agent.toml for targetAgent (absent on disk)
    // and tracks agent.md for all others (present)
    const manifestFiles = {};
    for (const agent of EXPECTED_AGENTS) {
      manifestFiles[`agents/${agent}.md`] = {};
    }
    // Add a .toml for targetAgent to manifest (not present on disk)
    manifestFiles[`agents/${targetAgent}.toml`] = {};

    const manifest = { files: manifestFiles };
    fs.writeFileSync(
      path.join(tmpDir, 'gsd-file-manifest.json'),
      JSON.stringify(manifest)
    );

    const result = agentInstallCheck.checkAgentsInstalled();
    assert.ok(result.incomplete_agents.includes(targetAgent),
      `Expected ${targetAgent} in incomplete_agents, got: ${JSON.stringify(result.incomplete_agents)}`);
    assert.strictEqual(result.agents_installed, false,
      'agents_installed must be false when any agent is incomplete');
  });

  test('malformed manifest → no throw, completeness skipped (incomplete_agents:[])', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    // Write all agent files
    for (const agent of EXPECTED_AGENTS) {
      fs.writeFileSync(path.join(agentsDir, `${agent}.md`), `# ${agent}\n`);
    }

    // Write malformed manifest
    fs.writeFileSync(path.join(tmpDir, 'gsd-file-manifest.json'), '{not json"');

    let result;
    assert.doesNotThrow(() => {
      result = agentInstallCheck.checkAgentsInstalled();
    });
    // Malformed → completeness skipped → incomplete_agents empty
    assert.deepStrictEqual(result.incomplete_agents, []);
    // But presence check still passed
    assert.strictEqual(result.agents_installed, true);
  });

  test('agents_dir and agent_runtime are returned in result', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    const result = agentInstallCheck.checkAgentsInstalled('cursor');
    // GSD_AGENTS_DIR overrides, so agents_dir = our tmp path
    assert.strictEqual(result.agents_dir, agentsDir);
    assert.strictEqual(result.agent_runtime, 'cursor');
  });
});
