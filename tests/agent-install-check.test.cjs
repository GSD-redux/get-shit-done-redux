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
    // #2540: a real Codex install writes the contract-bearing .md beside the
    // .toml, and checkAgentsInstalled treats a toml-only codex agent as
    // incomplete — a "complete" fixture must carry both.
    fs.writeFileSync(path.join(agentsDir, `${agent}.md`), `# ${agent}\n`);
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

// ─── 3. #2540 regression: sandbox_mode vs tool contract ───────────────────────

describe('#2540 regression: sandbox_mode weaker than declared tool contract is reported', () => {
  let tmpDir;
  let agentsDir;
  const target = EXPECTED_AGENTS[0];

  const writeAllAgents = () => {
    for (const agent of EXPECTED_AGENTS) {
      fs.writeFileSync(path.join(agentsDir, `${agent}.md`), `---\nname: ${agent}\n---\nbody`);
    }
  };
  const codexMd = (tools) =>
    `---\nname: "${target}"\ndescription: "d"\n---\n\n<codex_agent_role>\nrole: ${target}\ntools: ${tools}\npurpose: d\n</codex_agent_role>\n\nbody`;
  const toml = (sandbox) =>
    `name = "${target}"\ndescription = "d"\nsandbox_mode = "${sandbox}"\n`;

  beforeEach(() => {
    tmpDir = createTempDir();
    agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    process.env['GSD_AGENTS_DIR'] = agentsDir;
    writeAllAgents();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('read-only TOML for a Write-tool role is a violation and fails the check', () => {
    // The pre-#2540 false pass: every file present, contract requires Write,
    // generated sandbox is read-only — the agent cannot write its output.
    fs.writeFileSync(path.join(agentsDir, `${target}.md`), codexMd('Read, Write, Edit, Bash'));
    fs.writeFileSync(path.join(agentsDir, `${target}.toml`), toml('read-only'));

    const result = agentInstallCheck.checkAgentsInstalled('codex');
    assert.strictEqual(result.sandbox_violations.length, 1, 'one violation reported');
    assert.strictEqual(result.sandbox_violations[0].agent, target);
    assert.strictEqual(result.sandbox_violations[0].sandbox_mode, 'read-only');
    assert.strictEqual(result.agents_installed, false, 'semantic violation fails the install check');
  });

  test('#2566 review: the semantic check is codex-scoped — the same violating pair on another runtime does not misfire', () => {
    // `sandbox_mode` is Codex's vocabulary; only the Codex installer emits it.
    // A sandbox_mode-bearing TOML seen under a different runtime is not GSD's
    // artifact, so the identical fixture that IS a violation on codex must
    // produce silence — not a violation, not a failed install — elsewhere.
    fs.writeFileSync(path.join(agentsDir, `${target}.md`), codexMd('Read, Write, Edit, Bash'));
    fs.writeFileSync(path.join(agentsDir, `${target}.toml`), toml('read-only'));

    const result = agentInstallCheck.checkAgentsInstalled('opencode');
    assert.deepStrictEqual(result.sandbox_violations, [], 'non-codex runtime must not run the codex sandbox check');
    assert.strictEqual(result.agents_installed, true);
  });

  test('workspace-write TOML for a Write-tool role is clean', () => {
    fs.writeFileSync(path.join(agentsDir, `${target}.md`), codexMd('Read, Write, Edit, Bash'));
    fs.writeFileSync(path.join(agentsDir, `${target}.toml`), toml('workspace-write'));

    const result = agentInstallCheck.checkAgentsInstalled('codex');
    assert.deepStrictEqual(result.sandbox_violations, []);
    assert.strictEqual(result.agents_installed, true);
  });

  test('read-only TOML for a read-only contract is clean', () => {
    fs.writeFileSync(path.join(agentsDir, `${target}.md`), codexMd('Read, Bash, Grep, Glob'));
    fs.writeFileSync(path.join(agentsDir, `${target}.toml`), toml('read-only'));

    const result = agentInstallCheck.checkAgentsInstalled('codex');
    assert.deepStrictEqual(result.sandbox_violations, []);
    assert.strictEqual(result.agents_installed, true);
  });

  test('frontmatter tools contract is honored when no codex_agent_role header exists', () => {
    fs.writeFileSync(
      path.join(agentsDir, `${target}.md`),
      `---\nname: ${target}\ntools: Read, Edit\n---\nbody`
    );
    fs.writeFileSync(path.join(agentsDir, `${target}.toml`), toml('read-only'));

    const result = agentInstallCheck.checkAgentsInstalled('codex');
    assert.strictEqual(result.sandbox_violations.length, 1, 'frontmatter Edit contract flags read-only TOML');
  });

  test('#2540 review: block-list frontmatter tools contract flags a read-only TOML', () => {
    // gsd-nyquist-auditor's shape: `tools:` declared as a multi-line YAML
    // block list. The single-line regex read it as "- Read" (write tools
    // lost), so the validator false-passed the exact downgrade it exists to
    // catch. The full declared contract must also surface in the violation.
    fs.writeFileSync(
      path.join(agentsDir, `${target}.md`),
      `---\nname: ${target}\ntools:\n  - Read\n  - Write\n  - Edit\n  - Bash\n---\nbody`
    );
    fs.writeFileSync(path.join(agentsDir, `${target}.toml`), toml('read-only'));

    const result = agentInstallCheck.checkAgentsInstalled('codex');
    assert.strictEqual(result.sandbox_violations.length, 1, 'block-list Write/Edit contract flags read-only TOML');
    assert.strictEqual(result.sandbox_violations[0].declared_tools, 'Read, Write, Edit, Bash');
    assert.strictEqual(result.agents_installed, false);
  });

  // ── #2540 BLOCKER (review round 7): default runtime resolution ─────────────
  //
  // Every other test in this describe injects the runtime explicitly
  // (`checkAgentsInstalled('codex')`). That is exactly why the blocker
  // survived seven rounds: the ONE path that matters in production — a user
  // who installed for Codex and just runs `validate agents` — is the one path
  // the suite never took. `checkAgentsInstalled` read GSD_RUNTIME then fell
  // straight to 'claude', while `bin/install.js` persists `runtime: "codex"`
  // to `~/.gsd/defaults.json`. Read path and write path disagreed, the
  // codex-gate early-returned, and the check reported the same false pass
  // #2540 was filed about.
  //
  // These two tests therefore pass NO runtime argument, export NO GSD_RUNTIME,
  // and supply NO project config. The only thing that says "codex" is a
  // sandboxed defaults.json.
  describe('#2540 BLOCKER: the gate fires on the issue\'s own repro (no env, no project config)', () => {
    let homeDir;
    let savedHome;
    let savedUserProfile;

    const writeDefaults = (contents) => {
      fs.mkdirSync(path.join(homeDir, '.gsd'), { recursive: true });
      fs.writeFileSync(
        path.join(homeDir, '.gsd', 'defaults.json'), JSON.stringify(contents, null, 2) + '\n',
      );
    };

    beforeEach(() => {
      homeDir = createTempDir();
      savedHome = process.env['HOME'];
      savedUserProfile = process.env['USERPROFILE'];
      // os.homedir() reads HOME on POSIX and USERPROFILE on Windows; set both
      // so this test never touches the developer's real ~/.gsd.
      process.env['HOME'] = homeDir;
      process.env['USERPROFILE'] = homeDir;
      // The violating pair: contract needs Write, generated sandbox is read-only.
      fs.writeFileSync(path.join(agentsDir, `${target}.md`), codexMd('Read, Write, Edit, Bash'));
      fs.writeFileSync(path.join(agentsDir, `${target}.toml`), toml('read-only'));
    });

    afterEach(() => {
      if (savedHome === undefined) delete process.env['HOME'];
      else process.env['HOME'] = savedHome;
      if (savedUserProfile === undefined) delete process.env['USERPROFILE'];
      else process.env['USERPROFILE'] = savedUserProfile;
      cleanup(homeDir);
    });

    test('a persisted codex runtime makes the sandbox check run', () => {
      writeDefaults({ resolve_model_ids: 'omit', runtime: 'codex' });

      assert.equal(process.env['GSD_RUNTIME'], undefined, 'precondition: no runtime in env');

      const result = agentInstallCheck.checkAgentsInstalled();
      assert.strictEqual(
        result.agent_runtime, 'codex',
        'the runtime must resolve from ~/.gsd/defaults.json when nothing upstream asserts one',
      );
      assert.strictEqual(
        result.sandbox_violations.length, 1,
        'the sandbox check must run on a Codex install that only declared itself in defaults.json — ' +
          'this is #2540\'s stated reproduction, and the pre-fix code reported a clean pass here',
      );
      assert.strictEqual(result.agents_installed, false);
    });

    test('no persisted runtime still resolves claude, so the gate stays inert (discrimination proof)', () => {
      // Same fixture, same absent env, same absent project config — only the
      // defaults.json runtime differs. If this also reported a violation, the
      // test above would prove nothing about where the runtime came from.
      writeDefaults({ resolve_model_ids: 'omit' });

      const result = agentInstallCheck.checkAgentsInstalled();
      assert.strictEqual(result.agent_runtime, 'claude', 'no persisted runtime → the claude default');
      assert.deepStrictEqual(
        result.sandbox_violations, [],
        'the codex-only sandbox check must not run when nothing resolves codex',
      );
    });

    test('an explicit runtime argument still wins over the persisted default', () => {
      // defaults.json is the LAST tier. A caller that knows the runtime, or a
      // project/env that asserts one, must not be overridden by a stale
      // global default left behind by an earlier install.
      writeDefaults({ runtime: 'codex' });

      const result = agentInstallCheck.checkAgentsInstalled('opencode');
      assert.strictEqual(result.agent_runtime, 'opencode');
      assert.deepStrictEqual(result.sandbox_violations, []);
    });
  });

  test('#2540 review: a TOML literal string sandbox_mode does not evade the check', () => {
    // GSD emits basic (double-quoted) strings, but this validator exists to
    // catch installs that no longer match what GSD emitted — a drifted
    // single-quoted value silently skipped the check entirely.
    fs.writeFileSync(path.join(agentsDir, `${target}.md`), codexMd('Read, Write, Edit'));
    fs.writeFileSync(
      path.join(agentsDir, `${target}.toml`),
      `name = "${target}"\ndescription = "d"\nsandbox_mode = 'read-only'\n`
    );

    const result = agentInstallCheck.checkAgentsInstalled('codex');
    assert.strictEqual(result.sandbox_violations.length, 1, "literal-string sandbox_mode must still be checked");
    assert.strictEqual(result.sandbox_violations[0].sandbox_mode, 'read-only');
  });

  test('#2540 review: a sandbox_mode line inside developer_instructions is not read as the sandbox', () => {
    // The /m scan covered the whole file including the trailing instructions
    // literal, so an agent body line could be mistaken for the real key.
    //
    // The contract/value pairing here is deliberate: a WRITE-requiring
    // contract with a fake `read-only` inside the body. The validator flags
    // write-contract + read-only, so the old whole-file scan reads the fake
    // key and reports a violation that does not exist, while the scoped read
    // correctly finds no key at all. Pairing a no-write contract with a fake
    // `workspace-write` would pass under BOTH readers and guard nothing.
    fs.writeFileSync(path.join(agentsDir, `${target}.md`), codexMd('Read, Write, Edit'));
    fs.writeFileSync(
      path.join(agentsDir, `${target}.toml`),
      `name = "${target}"\ndescription = "d"\ndeveloper_instructions = '''\nExample config:\nsandbox_mode = "read-only"\n'''\n`
    );

    const result = agentInstallCheck.checkAgentsInstalled('codex');
    assert.deepStrictEqual(
      result.sandbox_violations,
      [],
      'no real sandbox_mode key is present (sandboxTier "none"), so the check must skip rather than read the body'
    );
  });

  test('#2540 review: TOML shapes that must not defeat (or falsely trip) the sandbox_mode read', () => {
    // Each row is a shape that an earlier cut of this reader got wrong in one
    // direction or the other. Table-driven so a future narrowing fails on the
    // specific shape it broke. `true` = violation expected.
    const shapes = [
      ['trailing comment on the value', 'Read, Write, Edit', `name = "x"\nsandbox_mode = "read-only" # policy note\n`, true],
      ["a ''' inside an ordinary string value", 'Read, Write', `name = "x"\ndescription = "has ''' inside"\nsandbox_mode = "read-only"\n`, true],
      ['CRLF line endings', 'Read, Write', `name = "x"\r\nsandbox_mode = "read-only"\r\n`, true],
      ['a commented-out key (no real key)', 'Read, Write', `name = "x"\n# sandbox_mode = "read-only"\n`, false],
      ['a key only under a [table] header', 'Read, Write', `name = "x"\n\n[profile.ex]\nsandbox_mode = "read-only"\n`, false],
    ];
    for (const [label, tools, tomlBody, expectViolation] of shapes) {
      fs.writeFileSync(path.join(agentsDir, `${target}.md`), codexMd(tools));
      fs.writeFileSync(path.join(agentsDir, `${target}.toml`), tomlBody);
      const result = agentInstallCheck.checkAgentsInstalled('codex');
      assert.strictEqual(
        result.sandbox_violations.length > 0,
        expectViolation,
        `${label}: expected violation=${expectViolation}`
      );
    }
  });

  // ── Round-4 review: the over-privileged direction (#2540 direction 3) ──────
  // The vector is install-time drift, not the map/contract mismatch the parity
  // test already covers: install while an agent legitimately needs Write, then
  // tighten its `tools:` to drop Write without re-running the installer. The
  // stale .toml keeps workspace-write indefinitely and both `validate agents`
  // and `validate health` reported clean.

  test('#2540 round 4: workspace-write TOML for a contract with no write tool is a violation', () => {
    fs.writeFileSync(path.join(agentsDir, `${target}.md`), codexMd('Read, Grep, Glob'));
    fs.writeFileSync(path.join(agentsDir, `${target}.toml`), toml('workspace-write'));

    const result = agentInstallCheck.checkAgentsInstalled('codex');
    assert.strictEqual(result.sandbox_violations.length, 1, 'over-privileged drift must be reported');
    assert.strictEqual(result.sandbox_violations[0].direction, 'over-privileged');
    assert.strictEqual(result.sandbox_violations[0].sandbox_mode, 'workspace-write');
    assert.strictEqual(result.sandbox_violations[0].declared_tools, 'Read, Grep, Glob');
    assert.strictEqual(result.agents_installed, false, 'privilege drift fails the install check');
  });

  test('#2540 round 4: the two directions are labelled distinctly (they are not the same defect)', () => {
    // A weaker sandbox breaks the agent; a stronger one grants privilege the
    // contract no longer asks for. Collapsing them into one label would make
    // the health report misdescribe half its findings.
    fs.writeFileSync(path.join(agentsDir, `${target}.md`), codexMd('Read, Write'));
    fs.writeFileSync(path.join(agentsDir, `${target}.toml`), toml('read-only'));
    assert.strictEqual(
      agentInstallCheck.checkAgentsInstalled('codex').sandbox_violations[0].direction,
      'under-privileged',
    );
  });

  test('#2540 round 4: an absent contract is NOT read as "declares no write tool"', () => {
    // The false-positive trap in the symmetric check: an unreadable or absent
    // `tools:` yields [], which reads as "no write tool required" and would
    // flag every workspace-write agent that simply has no contract.
    fs.writeFileSync(path.join(agentsDir, `${target}.md`), `---\nname: ${target}\n---\nbody`);
    fs.writeFileSync(path.join(agentsDir, `${target}.toml`), toml('workspace-write'));

    assert.deepStrictEqual(
      agentInstallCheck.checkAgentsInstalled('codex').sandbox_violations,
      [],
      'no contract means no evidence about privilege — skip, do not guess',
    );
  });

  test('#2540 round 4: a sandbox_mode outside the two-value vocabulary is left alone', () => {
    // The check compares within a closed vocabulary rather than asserting
    // inequality, so a hand-written mode it does not model produces silence
    // rather than a guess. A general privilege audit needs a real TOML parser.
    fs.writeFileSync(path.join(agentsDir, `${target}.md`), codexMd('Read, Grep'));
    fs.writeFileSync(path.join(agentsDir, `${target}.toml`), toml('danger-full-access'));

    assert.deepStrictEqual(
      agentInstallCheck.checkAgentsInstalled('codex').sandbox_violations,
      [],
      'an unmodelled mode must not be reported as drift',
    );
  });

  test('#2540 review: a UTF-8 BOM before the frontmatter does not hide the contract from the validator', () => {
    fs.writeFileSync(
      path.join(agentsDir, `${target}.md`),
      `\uFEFF---\nname: ${target}\ntools: Read, Edit\n---\nbody`
    );
    fs.writeFileSync(path.join(agentsDir, `${target}.toml`), toml('read-only'));

    const result = agentInstallCheck.checkAgentsInstalled('codex');
    assert.strictEqual(result.sandbox_violations.length, 1, 'BOM must not make the semantic check vacuous');
  });

  test('codex TOML with a missing sibling .md is incomplete, not silently skipped (no manifest)', () => {
    // Without this, the semantic check goes vacuous exactly where it matters:
    // a .toml whose contract source is gone would pass unverified. There is no
    // gsd-file-manifest.json in this fixture, so the older manifest-based
    // completeness path cannot be what catches it.
    fs.unlinkSync(path.join(agentsDir, `${target}.md`));
    fs.writeFileSync(path.join(agentsDir, `${target}.toml`), toml('read-only'));

    const result = agentInstallCheck.checkAgentsInstalled('codex');
    assert.ok(result.incomplete_agents.includes(target), 'md-less codex toml reported incomplete');
    assert.deepStrictEqual(result.sandbox_violations, [], 'no violation claim without a readable contract');
    assert.strictEqual(result.agents_installed, false);
  });

  test('non-codex TOML with a missing sibling .md keeps the skip (toml-only layouts are legitimate)', () => {
    fs.unlinkSync(path.join(agentsDir, `${target}.md`));
    fs.writeFileSync(path.join(agentsDir, `${target}.toml`), toml('read-only'));

    const result = agentInstallCheck.checkAgentsInstalled('cursor');
    assert.deepStrictEqual(result.incomplete_agents, []);
    assert.deepStrictEqual(result.sandbox_violations, []);
  });

  test('TOML without a sandbox_mode key is skipped (sandboxTier "none" layouts)', () => {
    fs.writeFileSync(path.join(agentsDir, `${target}.md`), codexMd('Read, Write'));
    fs.writeFileSync(path.join(agentsDir, `${target}.toml`), `name = "${target}"\ndescription = "d"\n`);

    const result = agentInstallCheck.checkAgentsInstalled('codex');
    assert.deepStrictEqual(result.sandbox_violations, []);
    assert.strictEqual(result.agents_installed, true);
  });
});
