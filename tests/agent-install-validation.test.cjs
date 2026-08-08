/**
 * GSD Agent Installation Validation Tests (#1371)
 *
 * Validates that GSD detects missing or incomplete agent installations and
 * surfaces warnings through init commands and health checks. When agents are
 * not installed, Task(subagent_type="gsd-*") silently falls back to
 * general-purpose, losing specialized instructions.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runNode } = require('./helpers/process-seam.cjs');
const { runGsdTools, createTempProject, cleanup } = require('./helpers.cjs');
const { installerEnv } = require('./helpers/install-shared.cjs');

// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const AGENTS_DIR_NAME = 'agents';
const MODEL_PROFILES = require('../gsd-core/bin/lib/model-profiles.cjs').MODEL_PROFILES;
const EXPECTED_AGENTS = Object.keys(MODEL_PROFILES);
const ROOT = path.join(__dirname, '..');
const INSTALL_SCRIPT = path.join(ROOT, 'bin', 'install.js');

/**
 * Create a fake GSD install directory structure that mirrors what the installer
 * produces. gsd-tools.cjs lives at <configDir>/gsd-core/bin/gsd-tools.cjs,
 * so the agents dir is at <configDir>/agents/.
 *
 * We use --cwd to point at the project, and GSD_INSTALL_DIR env to override
 * the agents directory location for testing.
 */
function _createAgentsDir(configDir, agentNames = []) {
  const agentsDir = path.join(configDir, AGENTS_DIR_NAME);
  fs.mkdirSync(agentsDir, { recursive: true });
  for (const name of agentNames) {
    fs.writeFileSync(
      path.join(agentsDir, `${name}.md`),
      `---\nname: ${name}\ndescription: Test agent\ntools: Read, Bash\ncolor: cyan\n---\nAgent content.\n`
    );
  }
  return agentsDir;
}

function createCompleteCodexAgents(configDir) {
  const agentsDir = path.join(configDir, '.codex', AGENTS_DIR_NAME);
  fs.mkdirSync(agentsDir, { recursive: true });
  const files = {};
  for (const name of EXPECTED_AGENTS) {
    fs.writeFileSync(path.join(agentsDir, `${name}.md`), `# ${name}\n`);
    fs.writeFileSync(path.join(agentsDir, `${name}.toml`), `name = "${name}"\n`);
    files[`agents/${name}.md`] = {};
    files[`agents/${name}.toml`] = {};
  }
  fs.writeFileSync(
    path.join(configDir, '.codex', 'gsd-file-manifest.json'),
    JSON.stringify({ files }),
  );
  return agentsDir;
}

// ─── Init command agent validation ──────────────────────────────────────────

describe('init commands: agents_installed field (#1371)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Point the SDK at the repo's agents/ dir (sibling of gsd-core/) via the
  // GSD_AGENTS_DIR override. The SDK side of init resolves agents from
  // GSD_AGENTS_DIR or the runtime config dir (~/.claude/agents for Claude); it
  // does NOT walk up from cwd like the CJS-era code did. Without this override
  // these tests would only pass on a dev machine with ~/.claude/agents/
  // populated — which masked the divergence on Linux CI where that path is
  // absent. See sdk/src/query/QUERY-HANDLERS.md ("subprocess vs in-process
  // path resolution") and sdk/src/query/helpers.ts:resolveAgentsDir.
  const REPO_AGENTS_DIR = path.resolve(__dirname, '..', 'agents');

  test('init execute-phase includes agents_installed=true when agents exist', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });

    const result = runGsdTools('init execute-phase 1 --raw', tmpDir, { GSD_AGENTS_DIR: REPO_AGENTS_DIR });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(typeof output.agents_installed, 'boolean',
      'init execute-phase must include agents_installed field');
    assert.strictEqual(output.agents_installed, true,
      'agents_installed should be true when GSD_AGENTS_DIR has gsd-*.md files');
  });

  test('init plan-phase includes agents_installed=true when agents exist', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });

    const result = runGsdTools('init plan-phase 1 --raw', tmpDir, { GSD_AGENTS_DIR: REPO_AGENTS_DIR });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(typeof output.agents_installed, 'boolean',
      'init plan-phase must include agents_installed field');
    assert.strictEqual(output.agents_installed, true);
  });

  test('init plan-phase reports the complete project-local Codex installation', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    const globalHome = path.join(tmpDir, 'global-codex');
    fs.mkdirSync(phaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ runtime: 'codex' }),
    );
    createCompleteCodexAgents(tmpDir);
    const canonicalRoot = fs.realpathSync(tmpDir);
    const localAgentsDir = path.join(canonicalRoot, '.codex', AGENTS_DIR_NAME);
    _createAgentsDir(globalHome, EXPECTED_AGENTS);

    const result = runGsdTools('init plan-phase 1 --raw', tmpDir, { CODEX_HOME: globalHome });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.project_root, canonicalRoot);
    assert.strictEqual(output.agent_runtime, 'codex');
    assert.strictEqual(output.agents_dir, localAgentsDir);
    assert.strictEqual(output.agents_installed, true);
    assert.deepStrictEqual(output.missing_agents, []);
  });

  test('init execute-phase includes missing_agents list when agents are missing', () => {
    const phaseDir = path.join(tmpDir, '.planning', 'phases', '01-setup');
    fs.mkdirSync(phaseDir, { recursive: true });

    const result = runGsdTools('init execute-phase 1 --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(Array.isArray(output.missing_agents),
      'init execute-phase must include missing_agents array');
  });

  test('init quick includes agents_installed field', () => {
    const result = runGsdTools(['init', 'quick', 'test description', '--raw'], tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(typeof output.agents_installed, 'boolean',
      'init quick must include agents_installed field');
  });
});

// ─── Health check: agent installation ───────────────────────────────────────

describe('validate health: agent installation check W010 (#1371)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Write minimal project files so health check doesn't fail on E001-E005
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'PROJECT.md'),
      '# Project\n\n## What This Is\nTest\n\n## Core Value\nTest\n\n## Requirements\nTest\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'ROADMAP.md'),
      '# Roadmap\n\n### Phase 1: Setup\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'STATE.md'),
      '# Session State\n\n## Current Position\n\nPhase: 1\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({
        model_profile: 'balanced',
        commit_docs: true,
        workflow: { nyquist_validation: true },
      }, null, 2)
    );
    fs.mkdirSync(path.join(tmpDir, '.planning', 'phases', '01-setup'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('health check reports healthy when agents are installed (repo layout)', () => {
    // In the repo, agents/ exists as a sibling of gsd-core/, so the
    // health check should find them via the gsd-tools.cjs path resolution.
    // #2540 round 8: health now honors a runtime persisted to
    // ~/.gsd/defaults.json, so sandbox HOME — otherwise a developer machine
    // whose real defaults.json names another runtime would (correctly!) check
    // that runtime's agents dir and fail this claude-layout expectation.
    const isolatedHome = path.join(tmpDir, 'isolated-home');
    fs.mkdirSync(isolatedHome, { recursive: true });
    const result = runGsdTools('validate health --raw', tmpDir, {
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
    });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Should not have W010 warning about missing agents
    const w010 = (output.warnings || []).find(w => w.code === 'W010');
    assert.ok(!w010, 'Should not warn about missing agents when agents/ dir exists with files');
  });
});

// ─── Codex project-local validation status ──────────────────────────────────

describe('Codex project-local validation status', () => {
  let tmpDir;
  let globalHome;

  beforeEach(() => {
    tmpDir = createTempProject();
    globalHome = path.join(tmpDir, 'global-codex');
    fs.writeFileSync(
      path.join(tmpDir, '.planning', 'config.json'),
      JSON.stringify({ runtime: 'codex' }),
    );
    _createAgentsDir(globalHome, EXPECTED_AGENTS);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('validate agents and health use a complete project-local Codex installation', () => {
    createCompleteCodexAgents(tmpDir);
    const localAgentsDir = path.join(fs.realpathSync(tmpDir), '.codex', AGENTS_DIR_NAME);
    const env = { CODEX_HOME: globalHome };

    const validateResult = runGsdTools('validate agents --raw', tmpDir, env);
    assert.ok(validateResult.success, `validate agents failed: ${validateResult.error}`);
    const validateOutput = JSON.parse(validateResult.output);
    assert.strictEqual(validateOutput.agents_dir, localAgentsDir);
    assert.strictEqual(validateOutput.agents_found, true);
    assert.deepStrictEqual(validateOutput.missing, []);
    assert.deepStrictEqual(validateOutput.incomplete, []);

    const healthResult = runGsdTools('validate health --raw', tmpDir, env);
    assert.ok(healthResult.success, `validate health failed: ${healthResult.error}`);
    const healthOutput = JSON.parse(healthResult.output);
    assert.ok(!(healthOutput.warnings || []).some(warning => warning.code === 'W010'));
  });

  test('an empty project-local Codex directory remains authoritative for validate agents and health', () => {
    fs.mkdirSync(path.join(tmpDir, '.codex', AGENTS_DIR_NAME), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.codex', 'gsd-file-manifest.json'), JSON.stringify({ files: {} }));
    const localAgentsDir = path.join(fs.realpathSync(tmpDir), '.codex', AGENTS_DIR_NAME);
    const env = { CODEX_HOME: globalHome };

    const validateResult = runGsdTools('validate agents --raw', tmpDir, env);
    assert.ok(validateResult.success, `validate agents failed: ${validateResult.error}`);
    const validateOutput = JSON.parse(validateResult.output);
    assert.strictEqual(validateOutput.agents_dir, localAgentsDir);
    assert.strictEqual(validateOutput.agents_found, false);
    assert.deepStrictEqual(validateOutput.installed, []);
    assert.deepStrictEqual(validateOutput.incomplete, []);
    assert.deepStrictEqual(validateOutput.missing, EXPECTED_AGENTS);

    const healthResult = runGsdTools('validate health --raw', tmpDir, env);
    assert.ok(healthResult.success, `validate health failed: ${healthResult.error}`);
    const healthOutput = JSON.parse(healthResult.output);
    assert.ok((healthOutput.warnings || []).some(warning => warning.code === 'W010'));
  });
});

// ─── Copilot .agent.md detection (#1512) ────────────────────────────────────

describe('checkAgentsInstalled: Copilot .agent.md format (#1512)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('agents_installed=true when agents exist as .agent.md (Copilot format)', () => {
    // Simulate a Copilot install: agents are named gsd-*.agent.md, not gsd-*.md
    // Use GSD_AGENTS_DIR to point at an isolated dir with ONLY .agent.md files,
    // so the test does not accidentally pass via the repo's own agents/ dir.
    const agentsDir = path.join(tmpDir, 'copilot-agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const name of EXPECTED_AGENTS) {
      fs.writeFileSync(
        path.join(agentsDir, `${name}.agent.md`),
        `---\nname: ${name}\ndescription: Test agent\n---\nAgent content.\n`
      );
    }

    const result = runGsdTools('validate agents --raw', tmpDir, { GSD_AGENTS_DIR: agentsDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // Must report the custom dir, not the default repo agents dir
    assert.strictEqual(output.agents_dir, agentsDir,
      'agents_dir must be the GSD_AGENTS_DIR override, not the repo default');
    assert.strictEqual(output.agents_found, true,
      'agents_found must be true when agents exist as .agent.md (Copilot format)');
    assert.deepStrictEqual(output.missing, [],
      'missing must be empty when all agents exist as .agent.md');
  });

  test('agents_installed=false when .agent.md files exist for only some agents', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    // Only install the first agent
    const firstAgent = EXPECTED_AGENTS[0];
    fs.writeFileSync(
      path.join(agentsDir, `${firstAgent}.agent.md`),
      `---\nname: ${firstAgent}\ndescription: Test agent\n---\nAgent content.\n`
    );

    const result = runGsdTools('validate agents --raw', tmpDir, { GSD_AGENTS_DIR: agentsDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.agents_found, false,
      'agents_found must be false when only some agents exist');
    assert.ok(output.missing.length > 0, 'missing must be non-empty when some agents are absent');
  });

  test('init new-workspace includes agents_installed=true with Copilot .agent.md files', () => {
    // Use an isolated dir with ONLY .agent.md files (no .md fallback)
    const agentsDir = path.join(tmpDir, 'copilot-agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const name of EXPECTED_AGENTS) {
      fs.writeFileSync(
        path.join(agentsDir, `${name}.agent.md`),
        `---\nname: ${name}\ndescription: Test agent\n---\nAgent content.\n`
      );
    }

    const result = runGsdTools('init new-workspace --raw', tmpDir, { GSD_AGENTS_DIR: agentsDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.agents_installed, true,
      'agents_installed must be true when Copilot .agent.md files are present');
    assert.deepStrictEqual(output.missing_agents, [],
      'missing_agents must be empty when all .agent.md files are present');
  });

  test('agents_installed=true when agents exist as .toml (Codex format) (#278)', () => {
    const agentsDir = path.join(tmpDir, 'codex-agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const name of EXPECTED_AGENTS) {
      fs.writeFileSync(
        path.join(agentsDir, `${name}.toml`),
        `name = "${name}"\ndescription = "Test agent"\n`
      );
    }

    const result = runGsdTools('validate agents --raw', tmpDir, { GSD_AGENTS_DIR: agentsDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.agents_found, true,
      'agents_found must be true when agents exist as .toml (Codex format)');
    assert.deepStrictEqual(output.missing, [],
      'missing must be empty when all agents exist as .toml');
  });

  test('GSD_AGENTS_DIR env var overrides default agents directory', () => {
    // Create a custom agents dir in a subdirectory
    const customAgentsDir = path.join(tmpDir, 'custom-agents');
    fs.mkdirSync(customAgentsDir, { recursive: true });
    // Put one agent there as .md (standard format)
    fs.writeFileSync(
      path.join(customAgentsDir, `${EXPECTED_AGENTS[0]}.md`),
      `---\nname: ${EXPECTED_AGENTS[0]}\ndescription: Test agent\n---\nAgent content.\n`
    );

    const result = runGsdTools('validate agents --raw', tmpDir, { GSD_AGENTS_DIR: customAgentsDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // The custom dir path should be reported
    assert.strictEqual(output.agents_dir, customAgentsDir,
      'agents_dir must reflect GSD_AGENTS_DIR override');
  });
});

// ─── Kimi agents/subagents detection (#743 review) ─────────────────────────

describe('checkAgentsInstalled: Kimi agents/subagents layout', () => {
  test('Kimi install is detected by init, validate agents, and health checks', () => {
    const tmpDir = createTempProject('gsd-kimi-agent-status-project-');
    const tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-agent-status-config-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-agent-status-home-'));
    const env = installerEnv({
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      KIMI_CONFIG_DIR: tmpConfig,
    });

    try {
      const installResult = runNode(
        [INSTALL_SCRIPT, '--kimi', '--global', '--config-dir', tmpConfig, '--no-sdk'],
        {
          cwd: tmpDir,
          env,
          timeoutMs: INSTALL_TIMEOUT_MS,
        },
      );
      assert.strictEqual(
        installResult.exitCode,
        0,
        `Kimi install failed\nstdout: ${installResult.stdout}\nstderr: ${installResult.stderr}`,
      );

      fs.writeFileSync(
        path.join(tmpDir, '.planning', 'config.json'),
        JSON.stringify({ runtime: 'kimi', model_profile: 'balanced' }, null, 2),
      );

      const initResult = runGsdTools('init new-workspace --raw', tmpDir, env);
      assert.ok(initResult.success, `init failed: ${initResult.error}`);
      const initOutput = JSON.parse(initResult.output);
      assert.strictEqual(initOutput.agent_runtime, 'kimi');
      assert.strictEqual(initOutput.agents_dir, path.join(tmpConfig, 'agents'));
      assert.strictEqual(initOutput.agents_installed, true);
      assert.deepStrictEqual(initOutput.missing_agents, []);

      const validateResult = runGsdTools('validate agents --raw', tmpDir, {
        ...env,
        GSD_RUNTIME: 'kimi',
      });
      assert.ok(validateResult.success, `validate agents failed: ${validateResult.error}`);
      const validateOutput = JSON.parse(validateResult.output);
      assert.strictEqual(validateOutput.agents_dir, path.join(tmpConfig, 'agents'));
      assert.strictEqual(validateOutput.agents_found, true);
      assert.deepStrictEqual(validateOutput.missing, []);

      const healthResult = runGsdTools('validate health --raw', tmpDir, {
        ...env,
        GSD_RUNTIME: 'kimi',
      });
      assert.ok(healthResult.success, `validate health failed: ${healthResult.error}`);
      const healthOutput = JSON.parse(healthResult.output);
      const agentWarnings = (healthOutput.warnings || []).filter(
        (warning) => warning.code === 'W010' || /GSD agents/i.test(warning.message || ''),
      );
      assert.deepStrictEqual(agentWarnings, []);
    } finally {
      cleanup(tmpDir);
      cleanup(tmpConfig);
      cleanup(tmpHome);
    }
  });
});

// ─── validate agents subcommand ─────────────────────────────────────────────

describe('validate agents subcommand (#1371)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('validate agents returns status with agent list', () => {
    const result = runGsdTools('validate agents --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok('agents_dir' in output, 'Must include agents_dir path');
    assert.ok('installed' in output, 'Must include installed array');
    assert.ok('missing' in output, 'Must include missing array');
    assert.ok('agents_found' in output, 'Must include agents_found boolean');
  });

  test('validate agents lists all expected agent types', () => {
    const result = runGsdTools('validate agents --raw', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    // The expected agents come from MODEL_PROFILES keys
    assert.ok(output.expected.length > 0, 'Must have expected agents');
  });
});

// ─── Bug #1058: validate agents detects manifest-backed .md/.toml pair drift ──

describe('bug #1058: validate agents detects manifest-backed .md/.toml pair drift', () => {
  // All real agents/gsd-*.md files in the repo (used to populate fixtures)
  const REPO_AGENTS_DIR_1058 = path.resolve(__dirname, '..', 'agents');

  /**
   * Copy all gsd-*.md files from the repo agents dir into destDir.
   */
  function copyAgentMdFiles(destDir) {
    const files = fs.readdirSync(REPO_AGENTS_DIR_1058).filter(f => /^gsd-.*\.md$/.test(f));
    for (const file of files) {
      const src = path.join(REPO_AGENTS_DIR_1058, file);
      const dst = path.join(destDir, file);
      fs.copyFileSync(src, dst);
    }
  }

  /**
   * Build a gsd-file-manifest.json whose files map includes both .md and .toml
   * entries for every EXPECTED_AGENTS entry.
   */
  function buildManifestBothPairs(agents) {
    const files = {};
    for (const name of agents) {
      files[`agents/${name}.md`] = 'deadbeef';
      files[`agents/${name}.toml`] = 'deadbeef';
    }
    return { version: '1.0.0', files };
  }

  let tmpDir;

  afterEach(() => {
    if (tmpDir) {
      cleanup(tmpDir);
      tmpDir = null;
    }
  });

  test('agents_found=false and incomplete non-empty when .toml files are absent but manifest expects them', () => {
    // Arrange: all .md files present, manifest says both .md and .toml are expected,
    // but NO .toml files are created on disk.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-bug-1058-missing-toml-'));
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    // Copy real .md files
    copyAgentMdFiles(agentsDir);

    // Write manifest with both .md and .toml entries but no .toml files on disk
    fs.writeFileSync(
      path.join(tmpDir, 'gsd-file-manifest.json'),
      JSON.stringify(buildManifestBothPairs(EXPECTED_AGENTS), null, 2),
    );

    // Act
    const result = runGsdTools('validate agents --raw', tmpDir, {
      GSD_RUNTIME: 'codex',
      GSD_AGENTS_DIR: agentsDir,
    });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    // Assert: the completeness check must catch the missing .toml files
    assert.strictEqual(
      output.agents_found,
      false,
      `Expected agents_found=false when manifest-tracked .toml files are absent, got agents_found=${output.agents_found}`,
    );
    assert.ok(
      Array.isArray(output.incomplete),
      'Expected output.incomplete to be an array',
    );
    // Every agent whose .toml is absent must appear in incomplete (sorted deep-equal)
    assert.deepStrictEqual(
      [...output.incomplete].sort(),
      [...EXPECTED_AGENTS].sort(),
      `Expected incomplete to equal full EXPECTED_AGENTS set; got ${JSON.stringify(output.incomplete)}`,
    );
    // missing (entirely-absent .md) must be empty — these agents are not missing, only incomplete
    assert.deepStrictEqual(
      output.missing,
      [],
      `Expected missing=[] when all .md files are present; got ${JSON.stringify(output.missing)}`,
    );
  });

  test('agents_found=false and incomplete non-empty when .md files are absent but manifest expects them', () => {
    // Arrange: only .toml files present on disk, manifest says both .md and .toml are expected,
    // but NO .md files exist. This is the opposite-side pair-drift case.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-bug-1058-missing-md-'));
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    // Create ONLY .toml files — deliberately skip .md files
    for (const name of EXPECTED_AGENTS) {
      fs.writeFileSync(path.join(agentsDir, `${name}.toml`), `name = "${name}"
`);
    }

    // Write manifest with both .md and .toml entries
    fs.writeFileSync(
      path.join(tmpDir, 'gsd-file-manifest.json'),
      JSON.stringify(buildManifestBothPairs(EXPECTED_AGENTS), null, 2),
    );

    // Act
    const result = runGsdTools('validate agents --raw', tmpDir, {
      GSD_RUNTIME: 'codex',
      GSD_AGENTS_DIR: agentsDir,
    });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    // Assert: missing .md files must surface as incomplete (pair-drift detected symmetrically)
    assert.strictEqual(
      output.agents_found,
      false,
      `Expected agents_found=false when manifest-tracked .md files are absent, got agents_found=${output.agents_found}`,
    );
    assert.ok(
      Array.isArray(output.incomplete),
      'Expected output.incomplete to be an array',
    );
    assert.ok(
      output.incomplete.length > 0,
      `Expected incomplete to be non-empty when .md files are absent; got ${JSON.stringify(output.incomplete)}`,
    );
  });

  test('agents_found=true and incomplete=[] when both .md and .toml files are present', () => {
    // Arrange: all .md AND .toml present, manifest says both expected
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-bug-1058-complete-pair-'));
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    // Copy real .md files
    copyAgentMdFiles(agentsDir);

    // Create .toml files for each expected agent
    for (const name of EXPECTED_AGENTS) {
      fs.writeFileSync(path.join(agentsDir, `${name}.toml`), `name = "${name}"\n`);
    }

    // Write manifest with both .md and .toml entries
    fs.writeFileSync(
      path.join(tmpDir, 'gsd-file-manifest.json'),
      JSON.stringify(buildManifestBothPairs(EXPECTED_AGENTS), null, 2),
    );

    // Act
    const result = runGsdTools('validate agents --raw', tmpDir, {
      GSD_RUNTIME: 'codex',
      GSD_AGENTS_DIR: agentsDir,
    });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    // Assert: complete pair => no false positive
    assert.strictEqual(
      output.agents_found,
      true,
      `Expected agents_found=true when both .md and .toml files are present; got ${output.agents_found}`,
    );
    assert.deepStrictEqual(
      output.incomplete,
      [],
      `Expected incomplete=[] when all manifest-tracked files are present; got ${JSON.stringify(output.incomplete)}`,
    );
  });

  test('no spurious incomplete flags when no manifest is present (protects claude/bundled installs)', () => {
    // Arrange: all .md files present, NO manifest file at all
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-bug-1058-no-manifest-'));
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });

    // Copy real .md files
    copyAgentMdFiles(agentsDir);

    // Explicitly do NOT write gsd-file-manifest.json

    // Act
    const result = runGsdTools('validate agents --raw', tmpDir, {
      GSD_RUNTIME: 'codex',
      GSD_AGENTS_DIR: agentsDir,
    });
    assert.ok(result.success, `Command failed: ${result.error}`);
    const output = JSON.parse(result.output);

    // Assert: without a manifest, completeness check must no-op (incomplete empty)
    assert.deepStrictEqual(
      output.incomplete,
      [],
      `Expected incomplete=[] when no manifest present; got ${JSON.stringify(output.incomplete)}`,
    );
    // agents_found should reflect plain file presence (all .md files copied => true)
    assert.strictEqual(
      output.agents_found,
      true,
      `Expected agents_found=true when all .md files are present and no manifest; got ${output.agents_found}`,
    );
  });
});

// ─── #2540 regression: validate agents surfaces sandbox violations ───────────

describe('#2540 regression: validate agents --raw exposes sandbox_violations', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('a Write-tool role with a read-only TOML is reported with detail, not just a bare false', () => {
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const name of EXPECTED_AGENTS) {
      fs.writeFileSync(
        path.join(agentsDir, `${name}.md`),
        `---\nname: ${name}\ndescription: Test agent\ntools: Read, Bash\n---\nAgent content.\n`
      );
    }
    const target = EXPECTED_AGENTS[0];
    // Codex-shaped pair: converted .md with the contract in the role header,
    // and a generated TOML whose sandbox is weaker than the contract requires.
    fs.writeFileSync(
      path.join(agentsDir, `${target}.md`),
      `---\nname: "${target}"\ndescription: "Test agent"\n---\n\n<codex_agent_role>\nrole: ${target}\ntools: Read, Write, Edit\npurpose: Test agent\n</codex_agent_role>\n\nAgent content.\n`
    );
    fs.writeFileSync(
      path.join(agentsDir, `${target}.toml`),
      `name = "${target}"\ndescription = "Test agent"\nsandbox_mode = "read-only"\n`
    );

    const result = runGsdTools('validate agents --raw', tmpDir, {
      GSD_AGENTS_DIR: agentsDir,
      // The semantic check is codex-scoped (#2566 review) — the fixture pair
      // above is Codex's artifact shape, so the runtime must say so.
      GSD_RUNTIME: 'codex',
    });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.agents_found, false,
      'agents_found must be false on a sandbox/contract violation');
    assert.deepStrictEqual(output.missing, [], 'violation is not a missing agent');
    assert.ok(Array.isArray(output.sandbox_violations),
      'sandbox_violations must be present in the JSON so a false agents_found is explainable');
    assert.strictEqual(output.sandbox_violations.length, 1);
    assert.strictEqual(output.sandbox_violations[0].agent, target);
    assert.strictEqual(output.sandbox_violations[0].sandbox_mode, 'read-only');
  });

  test('#2540 round 8 BLOCKER: the PRODUCTION call shape fires with NO GSD_RUNTIME — defaults.json alone must open the gate', () => {
    // Every prior CLI test injected GSD_RUNTIME=codex, which is precisely the
    // condition #2540 says is ABSENT. This test drives the real `validate
    // agents` entry (cmdValidateAgents → checkAgentsInstalled) the issue's
    // repro runs: no GSD_RUNTIME (explicitly neutralized — the TEST_ENV_BASE
    // empty-string convention), no project-level runtime, only the installer's
    // persisted ~/.gsd/defaults.json saying codex. Before the round-8 fix,
    // cmdValidateAgents pre-resolved the runtime with resolveRuntime (which
    // never reads defaults.json), got 'claude', and the callee's
    // persisted-default fallback was unreachable — this test fails on that
    // revision with sandbox_violations = [].
    const homeDir = path.join(tmpDir, 'sandbox-home');
    fs.mkdirSync(path.join(homeDir, '.gsd'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.gsd', 'defaults.json'),
      JSON.stringify({ runtime: 'codex' }, null, 2) + '\n'
    );

    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const name of EXPECTED_AGENTS) {
      fs.writeFileSync(
        path.join(agentsDir, `${name}.md`),
        `---\nname: ${name}\ndescription: Test agent\ntools: Read, Bash\n---\nAgent content.\n`
      );
    }
    const target = EXPECTED_AGENTS[0];
    fs.writeFileSync(
      path.join(agentsDir, `${target}.md`),
      `---\nname: "${target}"\ndescription: "Test agent"\n---\n\n<codex_agent_role>\nrole: ${target}\ntools: Read, Write, Edit\npurpose: Test agent\n</codex_agent_role>\n\nAgent content.\n`
    );
    fs.writeFileSync(
      path.join(agentsDir, `${target}.toml`),
      `name = "${target}"\ndescription = "Test agent"\nsandbox_mode = "read-only"\n`
    );

    const result = runGsdTools('validate agents --raw', tmpDir, {
      GSD_AGENTS_DIR: agentsDir,
      GSD_RUNTIME: '',
      HOME: homeDir,
      USERPROFILE: homeDir,
    });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.sandbox_violations.length, 1,
      "the sandbox gate must open on #2540's own repro: no env runtime, no project runtime, defaults.json = codex");
    assert.strictEqual(output.sandbox_violations[0].agent, target);
    assert.strictEqual(output.agents_found, false);
  });

  test('#2540 round 8 discrimination: same production shape with NO persisted runtime stays inert', () => {
    // Same fixture, same neutralized env — only defaults.json lacks a runtime.
    // If this also reported a violation, the test above would prove nothing
    // about where the runtime came from.
    const homeDir = path.join(tmpDir, 'sandbox-home');
    fs.mkdirSync(path.join(homeDir, '.gsd'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.gsd', 'defaults.json'),
      JSON.stringify({ resolve_model_ids: 'omit' }, null, 2) + '\n'
    );

    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    for (const name of EXPECTED_AGENTS) {
      fs.writeFileSync(
        path.join(agentsDir, `${name}.md`),
        `---\nname: ${name}\ndescription: Test agent\ntools: Read, Bash\n---\nAgent content.\n`
      );
    }
    const target = EXPECTED_AGENTS[0];
    fs.writeFileSync(
      path.join(agentsDir, `${target}.md`),
      `---\nname: "${target}"\ndescription: "Test agent"\n---\n\n<codex_agent_role>\nrole: ${target}\ntools: Read, Write, Edit\npurpose: Test agent\n</codex_agent_role>\n\nAgent content.\n`
    );
    fs.writeFileSync(
      path.join(agentsDir, `${target}.toml`),
      `name = "${target}"\ndescription = "Test agent"\nsandbox_mode = "read-only"\n`
    );

    const result = runGsdTools('validate agents --raw', tmpDir, {
      GSD_AGENTS_DIR: agentsDir,
      GSD_RUNTIME: '',
      HOME: homeDir,
      USERPROFILE: homeDir,
    });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.deepStrictEqual(output.sandbox_violations, [],
      'nothing resolves codex, so the codex-scoped sandbox check must not run');
  });

  test('#2540 review: a sandbox violation still surfaces in W010 when another agent is MISSING', () => {
    // The sandbox clause used to live in a branch guarded by
    // `missing_agents.length === 0`, so a single missing agent hid every
    // sandbox violation from the health report. Both must be reported.
    const agentsDir = path.join(tmpDir, 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    const violating = EXPECTED_AGENTS[0];
    const absent = EXPECTED_AGENTS[1];
    for (const name of EXPECTED_AGENTS) {
      if (name === absent) continue; // deliberately not written → missing
      fs.writeFileSync(
        path.join(agentsDir, `${name}.md`),
        `---\nname: ${name}\ndescription: Test agent\ntools: Read, Bash\n---\nAgent content.\n`
      );
    }
    fs.writeFileSync(
      path.join(agentsDir, `${violating}.md`),
      `---\nname: "${violating}"\ndescription: "Test agent"\n---\n\n<codex_agent_role>\nrole: ${violating}\ntools: Read, Write, Edit\npurpose: Test agent\n</codex_agent_role>\n\nAgent content.\n`
    );
    fs.writeFileSync(
      path.join(agentsDir, `${violating}.toml`),
      `name = "${violating}"\ndescription = "Test agent"\nsandbox_mode = "read-only"\n`
    );

    const result = runGsdTools('validate health --raw', tmpDir, {
      GSD_AGENTS_DIR: agentsDir,
      GSD_RUNTIME: 'codex',
    });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    const w010 = (output.warnings || []).find((w) => w.code === 'W010');
    assert.ok(w010, 'W010 must be raised when an agent is missing');
    assert.match(w010.message, new RegExp(absent), 'the missing agent must be named');
    // #2540 M1: the sandbox finding is asserted on health's TYPED surface, not
    // re-derived from the warning prose — CONTRIBUTING's typed-surface rule.
    // The typed array also makes the round-2 hiding bug structurally
    // impossible: it is populated before any presence branching.
    assert.ok(Array.isArray(output.sandbox_violations),
      'validate health must expose sandbox_violations as a typed array');
    assert.strictEqual(output.sandbox_violations.length, 1,
      'the sandbox violation must not be hidden by the missing agent');
    assert.strictEqual(output.sandbox_violations[0].agent, violating);
    assert.strictEqual(output.sandbox_violations[0].sandbox_mode, 'read-only');
  });
});
