/**
 * Kimi CLI agent artifact contract tests.
 *
 * Kimi custom agents are explicit YAML files loaded with `kimi --agent-file`.
 * This suite tests the in-memory artifact contract only; install/layout wiring
 * belongs to the later Phase 3 slices.
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildKimiAgentArtifacts,
} = require('../bin/install.js');

const ROOT_AGENT = `---
name: gsd
description: Root GSD agent for Kimi CLI
tools: Agent, mcp__github__search, DefinitelyUnknownTool
color: blue
---

# GSD Root

Coordinate GSD workflows through subagents.
Read ~/.claude/gsd-core when source-package context is needed.`;

const EXECUTOR_AGENT = `---
name: gsd-executor
description: Execute planned GSD task slices with atomic commits.
tools: Read, Write, Edit, Bash, Grep, Glob
color: yellow
---

<role>
You are a GSD plan executor.
</role>`;

const INVALID_AGENT = `---
name: not a valid kimi agent
description: Invalid name should be diagnosed and skipped.
tools: Agent
---

This should not become a Kimi custom subagent.`;

describe('buildKimiAgentArtifacts', () => {
  test('builds a root Kimi agent YAML contract with explicit subagent paths', () => {
    const result = buildKimiAgentArtifacts({
      rootAgent: ROOT_AGENT,
      subagents: [
        { path: 'agents/gsd-executor.md', content: EXECUTOR_AGENT },
      ],
      requestedSubagents: ['gsd-executor', 'gsd-missing'],
    });

    assert.equal(result.root.yamlPath, 'agents/gsd.yaml');
    assert.equal(result.root.promptPath, 'agents/gsd.md');
    assert.ok(result.root.yaml.includes('version: 1'), 'root YAML includes Kimi version marker');
    assert.ok(result.root.yaml.includes('agent:'), 'root YAML includes agent object');
    assert.ok(result.root.yaml.includes('name: gsd'), 'root agent name is gsd');
    assert.ok(result.root.yaml.includes('extend: default'), 'root agent extends default Kimi behavior');
    assert.ok(result.root.yaml.includes('system_prompt_path: ./gsd.md'), 'root prompt path is relative');
    assert.ok(result.root.yaml.includes('tools:'), 'root YAML has a tools field');
    assert.ok(result.root.yaml.includes('kimi_cli.tools.agent:Agent'), 'root can call Kimi subagents');
    assert.ok(
      result.root.yaml.includes('kimi_cli.tools.agent:Agent'),
      'root tools use Kimi module paths'
    );
    assert.ok(!result.root.yaml.includes('- Agent'), 'root YAML does not emit raw Claude Agent tool');
    assert.ok(result.root.yaml.includes('subagents:'), 'root YAML declares custom subagents');
    assert.ok(result.root.yaml.includes('gsd-executor:'), 'known GSD subagent key is canonical');
    assert.ok(
      result.root.yaml.includes('path: ./subagents/gsd-executor.yaml'),
      'known GSD subagent path is relative to root YAML'
    );
    assert.ok(!result.root.yaml.includes('gsd-missing'), 'unknown requested subagent is excluded');
  });

  test('emits separate frontmatter-free Markdown prompts for root and subagents', () => {
    const result = buildKimiAgentArtifacts({
      rootAgent: ROOT_AGENT,
      subagents: [
        { path: 'agents/gsd-executor.md', content: EXECUTOR_AGENT },
      ],
      requestedSubagents: ['gsd-executor'],
    });

    const executor = result.subagents.find((artifact) => artifact.name === 'gsd-executor');
    assert.ok(executor, 'executor subagent artifact exists');

    assert.equal(executor.yamlPath, 'agents/subagents/gsd-executor.yaml');
    assert.equal(executor.promptPath, 'agents/subagents/gsd-executor.md');
    assert.ok(executor.yaml.includes('system_prompt_path: ./gsd-executor.md'));
    assert.ok(executor.yaml.includes('kimi_cli.tools.file:ReadFile'), 'Read maps to Kimi file tool');
    assert.ok(executor.yaml.includes('kimi_cli.tools.file:WriteFile'), 'Write maps to Kimi file tool');
    assert.ok(executor.yaml.includes('kimi_cli.tools.file:StrReplaceFile'), 'Edit maps to Kimi file tool');
    assert.ok(executor.yaml.includes('kimi_cli.tools.shell:Shell'), 'Bash maps to Kimi shell tool');
    assert.ok(executor.yaml.includes('kimi_cli.tools.file:Grep'), 'Grep maps to Kimi grep tool');
    assert.ok(executor.yaml.includes('kimi_cli.tools.file:Glob'), 'Glob maps to Kimi glob tool');
    assert.ok(!executor.yaml.includes('- Read'), 'subagent YAML does not emit raw Claude Read tool');
    assert.ok(!executor.yaml.includes('- Bash'), 'subagent YAML does not emit raw Claude Bash tool');
    assert.ok(!executor.yaml.includes('kimi_cli.tools.agent:Agent'), 'subagent does not inherit nested Agent tool');

    for (const prompt of [result.root.prompt, executor.prompt]) {
      assert.ok(!prompt.trimStart().startsWith('---'), 'source frontmatter is removed');
      assert.ok(!prompt.includes('tools:'), 'source frontmatter tools do not leak into prompt');
      assert.ok(!prompt.includes('color:'), 'source frontmatter color does not leak into prompt');
    }
    assert.ok(result.root.prompt.includes('# GSD Root'), 'root body content is preserved');
    assert.ok(executor.prompt.includes('You are a GSD plan executor.'), 'subagent body content is preserved');
    assert.ok(!result.root.prompt.includes('~/.claude/gsd-core'), 'Claude-specific path is neutralized');
  });

  test('diagnoses unknown subagents and unsupported inputs instead of emitting invalid names', () => {
    const result = buildKimiAgentArtifacts({
      rootAgent: ROOT_AGENT,
      subagents: [
        { path: 'agents/gsd-executor.md', content: EXECUTOR_AGENT },
        { path: 'agents/not-valid.md', content: INVALID_AGENT },
      ],
      requestedSubagents: ['gsd-executor', 'gsd-missing'],
    });

    assert.deepEqual(
      result.subagents.map((artifact) => artifact.name),
      ['gsd-executor'],
      'invalid and unknown subagents are not emitted'
    );
    assert.ok(
      result.diagnostics.some((item) => item.code === 'kimi_unknown_subagent' && item.value === 'gsd-missing'),
      'unknown requested subagent is diagnosed'
    );
    assert.ok(
      result.diagnostics.some((item) => item.code === 'kimi_invalid_subagent_name'),
      'invalid source subagent name is diagnosed'
    );
    assert.ok(
      result.diagnostics.some((item) => item.code === 'kimi_mcp_tool_excluded'),
      'MCP-managed tools are diagnosed and excluded'
    );
    assert.ok(
      result.diagnostics.some((item) => item.reason === 'mcp_managed'),
      'MCP diagnostics expose mapper reason'
    );
    assert.ok(
      result.diagnostics.some((item) => item.code === 'kimi_unsupported_tool'),
      'unsupported tools are diagnosed and excluded'
    );
    assert.ok(
      result.diagnostics.some((item) => item.reason === 'unsupported_tool'),
      'unsupported diagnostics expose mapper reason'
    );
    assert.ok(!result.root.yaml.includes('mcp__github__search'), 'MCP tool names are not emitted');
    assert.ok(!result.root.yaml.includes('DefinitelyUnknownTool'), 'unsupported tool names are not emitted');
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-kimi-path-layout-local-guard.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-kimi-path-layout-local-guard (consolidation epic #1969 B3 #1972)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runNode } = require('./helpers/process-seam.cjs');

const { cleanup } = require('./helpers.cjs');
const { installerEnv } = require('./helpers/install-shared.cjs');

const ROOT = path.join(__dirname, '..');

// Cross-platform temp paths for test fixtures (avoids hardcoded /tmp)
const KIMI_CFG = path.join(os.tmpdir(), 'gsd-kimi-config-test').replace(/\\/g, '/');
const XDG_HOME = path.join(os.tmpdir(), 'gsd-xdg-home-test');
const INSTALL_SCRIPT = path.join(ROOT, 'bin', 'install.js');
// #3145: class-norm timeout, not a per-suite value — see helpers/timeouts.cjs.
const { INSTALL_TIMEOUT_MS } = require('./helpers/timeouts.cjs');

const {
  getGlobalConfigDir,
  getGlobalSkillsBase,
  getGlobalSkillDir,
  resolveKimiGlobalDir,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-homes.cjs'));
const {
  resolveRuntimeArtifactLayout,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-artifact-layout.cjs'));
const {
  getGlobalDir,
  getConfigDirFromHome,
} = require('../bin/install.js');

function withEnv(updates, fn) {
  const saved = {};
  for (const key of Object.keys(updates)) {
    saved[key] = process.env[key];
    const value = updates[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(updates)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

describe('Kimi runtime homes', () => {
  test('default Kimi global root is recommended ~/.config/agents when no generic skills root exists', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-home-default-'));
    try {
      withEnv({ KIMI_CONFIG_DIR: undefined, XDG_CONFIG_HOME: undefined, HOME: tmpHome, USERPROFILE: tmpHome }, () => {
        assert.strictEqual(
          getGlobalConfigDir('kimi'),
          path.join(tmpHome, '.config', 'agents'),
        );
        assert.strictEqual(
          getGlobalSkillsBase('kimi'),
          path.join(tmpHome, '.config', 'agents', 'skills'),
        );
        assert.strictEqual(
          getGlobalSkillDir('kimi', 'gsd-help'),
          path.join(tmpHome, '.config', 'agents', 'skills', 'gsd-help'),
        );
        assert.notStrictEqual(
          getGlobalSkillsBase('kimi'),
          path.join(tmpHome, '.kimi-code', 'skills'),
        );
      });
    } finally {
      cleanup(tmpHome);
    }
  });

  test('Kimi root resolution follows first-existing generic skills directory order', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-home-existing-'));
    try {
      const recommendedRoot = path.join(tmpHome, '.config', 'agents');
      const fallbackRoot = path.join(tmpHome, '.agents');
      assert.strictEqual(
        resolveKimiGlobalDir({ env: {}, home: tmpHome, existsSync: fs.existsSync }),
        recommendedRoot,
      );

      fs.mkdirSync(path.join(fallbackRoot, 'skills'), { recursive: true });
      assert.strictEqual(
        resolveKimiGlobalDir({ env: {}, home: tmpHome, existsSync: fs.existsSync }),
        fallbackRoot,
      );

      fs.mkdirSync(path.join(recommendedRoot, 'skills'), { recursive: true });
      assert.strictEqual(
        resolveKimiGlobalDir({ env: {}, home: tmpHome, existsSync: fs.existsSync }),
        recommendedRoot,
      );
    } finally {
      cleanup(tmpHome);
    }
  });

  test('KIMI_CONFIG_DIR can select the brand-specific ~/.kimi-code root', () => {
    const customKimiDir = path.join(os.tmpdir(), 'custom-kimi-code');
    withEnv({ KIMI_CONFIG_DIR: customKimiDir, XDG_CONFIG_HOME: undefined }, () => {
      assert.strictEqual(String(getGlobalConfigDir('kimi')).replace(/\\/g, '/'), customKimiDir.replace(/\\/g, '/'));
      assert.strictEqual(
        getGlobalSkillsBase('kimi'),
        path.join(customKimiDir, 'skills'),
      );
      assert.strictEqual(String(getGlobalDir('kimi')).replace(/\\/g, '/'), customKimiDir.replace(/\\/g, '/'));
    });
  });

  test('XDG_CONFIG_HOME does not change Kimi default root', () => {
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-home-xdg-'));
    try {
      withEnv({ KIMI_CONFIG_DIR: undefined, XDG_CONFIG_HOME: XDG_HOME, HOME: tmpHome, USERPROFILE: tmpHome }, () => {
        assert.strictEqual(
          getGlobalConfigDir('kimi'),
          path.join(tmpHome, '.config', 'agents'),
        );
        assert.strictEqual(
          getConfigDirFromHome('kimi', true),
          "'.config', 'agents'",
        );
      });
    } finally {
      cleanup(tmpHome);
    }
  });

  test('Kimi global install reuses existing ~/.agents/skills when recommended root is absent', () => {
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-existing-agents-project-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-existing-agents-home-'));
    try {
      fs.mkdirSync(path.join(tmpHome, '.agents', 'skills'), { recursive: true });
      const result = runNode(
        [INSTALL_SCRIPT, '--kimi', '--global', '--no-sdk'],
        {
          cwd: tmpProject,
          env: installerEnv({ HOME: tmpHome, USERPROFILE: tmpHome }),
          timeoutMs: INSTALL_TIMEOUT_MS,
        },
      );

      assert.strictEqual(
        result.exitCode,
        0,
        `expected --kimi --global to reuse existing ~/.agents/skills\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      assert.strictEqual(
        fs.existsSync(path.join(tmpHome, '.agents', 'skills', 'gsd-new-project', 'SKILL.md')),
        true,
      );
      assert.strictEqual(
        fs.existsSync(path.join(tmpHome, '.config', 'agents', 'skills', 'gsd-new-project', 'SKILL.md')),
        false,
      );
    } finally {
      cleanup(tmpProject);
      cleanup(tmpHome);
    }
  });
});

describe('Kimi runtime artifact layout', () => {
  test('global layout stages Kimi skills and agents while local layout remains guarded', () => {
    const globalLayout = resolveRuntimeArtifactLayout('kimi', KIMI_CFG, 'global');
    assert.strictEqual(globalLayout.runtime, 'kimi');
    assert.strictEqual(String(globalLayout.configDir).replace(/\\/g, '/'), KIMI_CFG);
    assert.strictEqual(globalLayout.kinds.length, 2);
    assert.strictEqual(globalLayout.kinds[0].kind, 'skills');
    assert.strictEqual(globalLayout.kinds[0].destSubpath, 'skills');
    assert.strictEqual(globalLayout.kinds[0].prefix, 'gsd-');
    assert.strictEqual(typeof globalLayout.kinds[0].stage, 'function');
    assert.strictEqual(globalLayout.kinds[1].kind, 'kimi-agents');
    assert.strictEqual(globalLayout.kinds[1].destSubpath, 'agents');
    assert.strictEqual(globalLayout.kinds[1].prefix, 'gsd');
    assert.strictEqual(typeof globalLayout.kinds[1].stage, 'function');

    const localLayout = resolveRuntimeArtifactLayout('kimi', KIMI_CFG, 'local');
    assert.strictEqual(localLayout.runtime, 'kimi');
    assert.deepStrictEqual(localLayout.kinds, []);
  });
});

describe('Kimi local install guard', () => {
  test('--kimi --local exits successfully without writing local Kimi project artifacts', () => {
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-local-project-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-local-home-'));
    try {
      const result = runNode(
        [INSTALL_SCRIPT, '--kimi', '--local', '--no-sdk'],
        {
          cwd: tmpProject,
          env: installerEnv({ HOME: tmpHome, USERPROFILE: tmpHome }),
          timeoutMs: INSTALL_TIMEOUT_MS,
        },
      );

      assert.strictEqual(
        result.exitCode,
        0,
        `expected --kimi --local guard to no-op successfully\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      const combined = `${result.stdout}\n${result.stderr}`;
      assert.match(combined, /Kimi local install/i);
      assert.match(combined, /deferred/i);

      assert.ok(!fs.existsSync(path.join(tmpProject, '.kimi')), 'must not create legacy .kimi/');
      assert.ok(!fs.existsSync(path.join(tmpProject, '.kimi-code')), 'must not create .kimi-code/');
      assert.ok(!fs.existsSync(path.join(tmpProject, '.agents')), 'must not create .agents/');
      assert.ok(!fs.existsSync(path.join(tmpProject, '.claude')), 'must not fall back to Claude local install');
    } finally {
      cleanup(tmpProject);
      cleanup(tmpHome);
    }
  });

  test('--kimi --global writes converted Kimi skills and agent artifacts', () => {
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-global-project-'));
    const tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-global-config-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-global-home-'));
    try {
      const result = runNode(
        [INSTALL_SCRIPT, '--kimi', '--global', '--config-dir', tmpConfig, '--no-sdk'],
        {
          cwd: tmpProject,
          env: installerEnv({ HOME: tmpHome, USERPROFILE: tmpHome }),
          timeoutMs: INSTALL_TIMEOUT_MS,
        },
      );

      assert.strictEqual(
        result.exitCode,
        0,
        `expected --kimi --global to install Kimi skills successfully\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
      );
      const combined = `${result.stdout}\n${result.stderr}`;
      assert.match(combined, /Installing for .*Kimi/i);
      assert.match(combined, /Installed \d+ Kimi skills to skills\//i);
      assert.match(combined, /Generated Kimi root agent: .*agents.*gsd\.yaml/i);
      assert.match(combined, /kimi --agent-file/i);
      assert.match(combined, /Wrote file manifest/i);

      const skillFile = path.join(tmpConfig, 'skills', 'gsd-new-project', 'SKILL.md');
      assert.ok(fs.existsSync(skillFile), 'must write gsd-new-project/SKILL.md');
      const skillContent = fs.readFileSync(skillFile, 'utf8');
      assert.match(skillContent, /^name: gsd-new-project$/m);
      assert.match(skillContent, /\/skill:gsd-new-project/);
      assert.match(skillContent, /gsd-core\/workflows\/new-project\.md/);
      assert.doesNotMatch(skillContent, /@~\/\.claude\/gsd-core|@\$HOME\/\.claude\/gsd-core/);
      assert.doesNotMatch(skillContent, /@[^\r\n]*\\/, 'serialized Kimi payload references must use forward slashes');
      assert.doesNotMatch(skillContent, /kimi_cli\.tools|system_prompt_path|^version: 1$/m);

      const rootYaml = path.join(tmpConfig, 'agents', 'gsd.yaml');
      const rootPrompt = path.join(tmpConfig, 'agents', 'gsd.md');
      const executorYaml = path.join(tmpConfig, 'agents', 'subagents', 'gsd-executor.yaml');
      const executorPrompt = path.join(tmpConfig, 'agents', 'subagents', 'gsd-executor.md');
      assert.ok(fs.existsSync(rootYaml), 'must write agents/gsd.yaml');
      assert.ok(fs.existsSync(rootPrompt), 'must write agents/gsd.md');
      assert.ok(fs.existsSync(executorYaml), 'must write agents/subagents/gsd-executor.yaml');
      assert.ok(fs.existsSync(executorPrompt), 'must write agents/subagents/gsd-executor.md');

      const rootYamlContent = fs.readFileSync(rootYaml, 'utf8');
      assert.match(rootYamlContent, /^version: 1$/m);
      assert.match(rootYamlContent, /^agent:$/m);
      assert.match(rootYamlContent, /extend: default/);
      assert.match(rootYamlContent, /system_prompt_path: \.\/gsd\.md/);
      assert.match(rootYamlContent, /tools:/);
      assert.match(rootYamlContent, /subagents:/);
      assert.match(rootYamlContent, /kimi_cli\.tools\./);
      assert.doesNotMatch(rootYamlContent, /mcp__/);

      const executorYamlContent = fs.readFileSync(executorYaml, 'utf8');
      assert.match(executorYamlContent, /system_prompt_path: \.\/gsd-executor\.md/);
      assert.match(executorYamlContent, /kimi_cli\.tools\./);
      assert.doesNotMatch(executorYamlContent, /mcp__/);

      assert.ok(fs.existsSync(path.join(tmpConfig, 'gsd-core', 'workflows', 'new-project.md')), 'must write workflow payloads used by Kimi skills');
      const manifestPath = path.join(tmpConfig, 'gsd-file-manifest.json');
      assert.ok(fs.existsSync(manifestPath), 'must write gsd-file-manifest.json for Kimi installs');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.ok(manifest.files['skills/gsd-new-project/SKILL.md'], 'manifest tracks generated Kimi skill');
      assert.ok(manifest.files['agents/gsd.yaml'], 'manifest tracks Kimi root agent YAML');
      assert.ok(manifest.files['agents/gsd.md'], 'manifest tracks Kimi root agent prompt');
      assert.ok(manifest.files['agents/subagents/gsd-executor.yaml'], 'manifest tracks Kimi subagent YAML');
      assert.ok(manifest.files['agents/subagents/gsd-executor.md'], 'manifest tracks Kimi subagent prompt');
      assert.ok(manifest.files['gsd-core/workflows/new-project.md'], 'manifest tracks installed workflow payload');
      assert.ok(!fs.existsSync(path.join(tmpConfig, 'hooks')), 'must not write hooks under the Kimi root');
      assert.ok(!fs.existsSync(path.join(tmpConfig, 'settings.json')), 'must not write settings.json under the Kimi root');
      assert.ok(!fs.existsSync(path.join(tmpConfig, '.clinerules')), 'must not write rules under the Kimi root');
    } finally {
      cleanup(tmpProject);
      cleanup(tmpConfig);
      cleanup(tmpHome);
    }
  });

  test('--kimi --global backs up local edits to generated skills and agent artifacts on reinstall', () => {
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-reinstall-project-'));
    const tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-reinstall-config-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-reinstall-home-'));
    const env = installerEnv({ HOME: tmpHome, USERPROFILE: tmpHome });

    try {
      const installArgs = [INSTALL_SCRIPT, '--kimi', '--global', '--config-dir', tmpConfig, '--no-sdk'];
      const first = runNode(installArgs, {
        cwd: tmpProject,
        env,
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
      assert.strictEqual(
        first.exitCode,
        0,
        `first install failed\nstdout: ${first.stdout}\nstderr: ${first.stderr}`,
      );

      const skillFile = path.join(tmpConfig, 'skills', 'gsd-new-project', 'SKILL.md');
      const agentPrompt = path.join(tmpConfig, 'agents', 'subagents', 'gsd-executor.md');
      fs.appendFileSync(skillFile, '\nUSER LOCAL KIMI SKILL EDIT\n');
      fs.appendFileSync(agentPrompt, '\nUSER LOCAL KIMI AGENT EDIT\n');

      const second = runNode(installArgs, {
        cwd: tmpProject,
        env,
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
      assert.strictEqual(
        second.exitCode,
        0,
        `second install failed\nstdout: ${second.stdout}\nstderr: ${second.stderr}`,
      );
      const secondOutput = `${second.stdout}\n${second.stderr}`;
      assert.match(secondOutput, /locally modified GSD file/i);
      assert.match(secondOutput, /\/skill:gsd-update --reapply/);
      assert.doesNotMatch(secondOutput, /Run\s+\/gsd-update --reapply/);

      const skillBackup = path.join(tmpConfig, 'gsd-local-patches', 'skills', 'gsd-new-project', 'SKILL.md');
      const agentBackup = path.join(tmpConfig, 'gsd-local-patches', 'agents', 'subagents', 'gsd-executor.md');
      assert.match(fs.readFileSync(skillBackup, 'utf8'), /USER LOCAL KIMI SKILL EDIT/);
      assert.match(fs.readFileSync(agentBackup, 'utf8'), /USER LOCAL KIMI AGENT EDIT/);

      const meta = JSON.parse(fs.readFileSync(path.join(tmpConfig, 'gsd-local-patches', 'backup-meta.json'), 'utf8'));
      assert.ok(meta.files.includes('skills/gsd-new-project/SKILL.md'));
      assert.ok(meta.files.includes('agents/subagents/gsd-executor.md'));
    } finally {
      cleanup(tmpProject);
      cleanup(tmpConfig);
      cleanup(tmpHome);
    }
  });

  test('--kimi --global --uninstall removes GSD artifacts and preserves non-GSD Kimi content', () => {
    const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-uninstall-project-'));
    const tmpConfig = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-uninstall-config-'));
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-kimi-uninstall-home-'));
    const env = installerEnv({ HOME: tmpHome, USERPROFILE: tmpHome });

    try {
      const installArgs = [INSTALL_SCRIPT, '--kimi', '--global', '--config-dir', tmpConfig, '--no-sdk'];
      const installResult = runNode(installArgs, {
        cwd: tmpProject,
        env,
        timeoutMs: INSTALL_TIMEOUT_MS,
      });
      assert.strictEqual(
        installResult.exitCode,
        0,
        `install failed\nstdout: ${installResult.stdout}\nstderr: ${installResult.stderr}`,
      );

      const foreignSkill = path.join(tmpConfig, 'skills', 'user-custom-skill', 'SKILL.md');
      const foreignRootAgent = path.join(tmpConfig, 'agents', 'user-agent.yaml');
      const foreignSubagent = path.join(tmpConfig, 'agents', 'subagents', 'user-agent.yaml');
      fs.mkdirSync(path.dirname(foreignSkill), { recursive: true });
      fs.mkdirSync(path.dirname(foreignSubagent), { recursive: true });
      fs.writeFileSync(foreignSkill, '# user skill\n', 'utf8');
      fs.writeFileSync(foreignRootAgent, 'version: 1\n', 'utf8');
      fs.writeFileSync(foreignSubagent, 'version: 1\n', 'utf8');

      const uninstallResult = runNode(
        [INSTALL_SCRIPT, '--kimi', '--global', '--config-dir', tmpConfig, '--uninstall'],
        {
          cwd: tmpProject,
          env,
          timeoutMs: INSTALL_TIMEOUT_MS,
        },
      );
      assert.strictEqual(
        uninstallResult.exitCode,
        0,
        `uninstall failed\nstdout: ${uninstallResult.stdout}\nstderr: ${uninstallResult.stderr}`,
      );
      assert.match(`${uninstallResult.stdout}\n${uninstallResult.stderr}`, /Kimi CLI/);

      assert.ok(!fs.existsSync(path.join(tmpConfig, 'skills', 'gsd-new-project')), 'must remove generated Kimi skills');
      assert.ok(!fs.existsSync(path.join(tmpConfig, 'agents', 'gsd.yaml')), 'must remove Kimi root agent YAML');
      assert.ok(!fs.existsSync(path.join(tmpConfig, 'agents', 'gsd.md')), 'must remove Kimi root agent prompt');
      assert.ok(!fs.existsSync(path.join(tmpConfig, 'agents', 'subagents', 'gsd-executor.yaml')), 'must remove generated Kimi subagent YAML');
      assert.ok(!fs.existsSync(path.join(tmpConfig, 'agents', 'subagents', 'gsd-executor.md')), 'must remove generated Kimi subagent prompt');
      assert.ok(!fs.existsSync(path.join(tmpConfig, 'gsd-core')), 'must remove installed workflow payload');
      assert.ok(!fs.existsSync(path.join(tmpConfig, 'gsd-file-manifest.json')), 'must remove the manifest');

      assert.ok(fs.existsSync(foreignSkill), 'must preserve non-GSD Kimi skills');
      assert.ok(fs.existsSync(foreignRootAgent), 'must preserve non-GSD root agents');
      assert.ok(fs.existsSync(foreignSubagent), 'must preserve non-GSD subagents');
    } finally {
      cleanup(tmpProject);
      cleanup(tmpConfig);
      cleanup(tmpHome);
    }
  });
});
  });
}
