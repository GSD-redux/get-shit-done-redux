/**
 * GSD Tools Tests - Agent Skills Injection
 *
 * CLI integration tests for the `agent-skills` command that reads
 * `agent_skills` from .planning/config.json and returns a formatted
 * skills block for injection into Task() prompts.
 *
 * Migrated (#455): uses `--json` flag to get typed IR
 *   { agent_type, block, skills_count }
 * instead of asserting on raw XML output text.
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { runGsdTools, createTempProject, cleanup, TOOLS_PATH } = require('./helpers.cjs');
const TEST_ENV_BASE = {
  GSD_SESSION_KEY: '',
  CODEX_THREAD_ID: '',
  CLAUDE_SESSION_ID: '',
  CLAUDE_CODE_SSE_PORT: '',
  OPENCODE_SESSION_ID: '',
  GEMINI_SESSION_ID: '',
  CURSOR_SESSION_ID: '',
  WINDSURF_SESSION_ID: '',
  TERM_SESSION_ID: '',
  WT_SESSION: '',
  TMUX_PANE: '',
  ZELLIJ_SESSION_NAME: '',
  GSD_WORKSTREAM: '',
  TTY: '',
  SSH_TTY: '',
};

/**
 * Run gsd-tools and capture BOTH stdout and stderr on success.
 * Returns { success, stdout, stderr }.
 */
function runGsdToolsWithStderr(args, cwd, env) {
  const childEnv = { ...process.env, ...TEST_ENV_BASE, ...(env || {}) };
  try {
    const result = spawnSync(process.execPath, [TOOLS_PATH, ...args], {
      cwd,
      encoding: 'utf-8',
      env: childEnv,
    });
    return {
      success: result.status === 0,
      stdout: (result.stdout || '').trim(),
      stderr: (result.stderr || '').trim(),
      exitCode: result.status,
    };
  } catch (err) {
    return { success: false, stdout: '', stderr: String(err), exitCode: 1 };
  }
}

const { loadTrustedGlobalRoots, validatePath } = require('../gsd-core/bin/lib/security.cjs');

// ─── helpers ──────────────────────────────────────────────────────────────────

function writeConfig(tmpDir, obj) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(obj, null, 2), 'utf-8');
}

function readConfig(tmpDir) {
  const configPath = path.join(tmpDir, '.planning', 'config.json');
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function markLocalGsdInstall(tmpDir) {
  fs.writeFileSync(
    path.join(tmpDir, '.codex', 'gsd-file-manifest.json'),
    JSON.stringify({ files: {} }),
  );
}

// Run agent-skills with --json for typed IR assertions
function runAgentSkillsJson(args, tmpDir, env) {
  // Insert --json after 'agent-skills' subcommand
  const allArgs = Array.isArray(args) ? args : [args];
  const cmdIdx = allArgs.indexOf('agent-skills');
  const withJson = [...allArgs];
  if (cmdIdx !== -1) {
    withJson.splice(cmdIdx + 1, 0, '--json');
  }
  const result = runGsdTools(withJson, tmpDir, env || { HOME: tmpDir, USERPROFILE: tmpDir });
  if (!result.success) return { success: false, error: result.error, ir: null };
  try {
    return { success: true, ir: JSON.parse(result.output) };
  } catch (e) {
    return { success: false, error: `JSON parse failed: ${e.message} output=${result.output}`, ir: null };
  }
}

// ─── agent-skills command ────────────────────────────────────────────────────

describe('agent-skills command', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('returns empty block when no config exists', () => {
    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.agent_type, 'gsd-executor');
    assert.strictEqual(r.ir.block, '', 'block must be empty when no skills configured');
  });

  test('returns empty block when config has no agent_skills section', () => {
    writeConfig(tmpDir, { model_profile: 'balanced' });
    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '');
  });

  test('returns empty block for unconfigured agent type', () => {
    writeConfig(tmpDir, {
      agent_skills: {
        'gsd-executor': ['skills/test-skill'],
      },
    });
    const r = runAgentSkillsJson(['agent-skills', 'gsd-planner'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.agent_type, 'gsd-planner');
    assert.strictEqual(r.ir.block, '');
  });

  test('unconfigured Codex reads its local companion agent from a descendant cwd', () => {
    const agentsDir = path.join(tmpDir, '.codex', 'agents');
    const descendant = path.join(tmpDir, 'src', 'feature');
    const localPersona = '# Local Codex executor\nUse the project-local agent.\n';
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.mkdirSync(descendant, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'gsd-executor.md'), localPersona);
    markLocalGsdInstall(tmpDir);
    writeConfig(tmpDir, { runtime: 'codex' });

    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], descendant, {
      HOME: tmpDir,
      USERPROFILE: tmpDir,
      CODEX_HOME: path.join(tmpDir, 'global-codex'),
      GSD_RUNTIME: '',
    });
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, localPersona);
  });

  test('workstream runtime selects the local Codex companion when root config differs', () => {
    const agentsDir = path.join(tmpDir, '.codex', 'agents');
    const localPersona = '# Local Codex executor\nUse the overridden runtime.\n';
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'gsd-executor.md'), localPersona);
    markLocalGsdInstall(tmpDir);
    writeConfig(tmpDir, { runtime: 'claude' });
    const workstreamDir = path.join(tmpDir, '.planning', 'workstreams', 'feature-x');
    fs.mkdirSync(workstreamDir, { recursive: true });
    fs.writeFileSync(path.join(workstreamDir, 'config.json'), JSON.stringify({ runtime: 'codex' }));

    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir, {
      HOME: tmpDir,
      USERPROFILE: tmpDir,
      CODEX_HOME: path.join(tmpDir, 'global-codex'),
      GSD_RUNTIME: '',
      GSD_WORKSTREAM: 'feature-x',
    });
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, localPersona);
  });

  test('unconfigured Claude remains empty when a local Codex companion exists', () => {
    const agentsDir = path.join(tmpDir, '.codex', 'agents');
    fs.mkdirSync(agentsDir, { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'gsd-executor.md'), '# Local Codex executor\n');
    writeConfig(tmpDir, { runtime: 'claude' });

    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir, { GSD_RUNTIME: 'claude' });
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '');
  });

  test('returns block containing agent_skills XML for configured agent', () => {
    const skillDir = path.join(tmpDir, 'skills', 'test-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Test Skill\n');

    writeConfig(tmpDir, {
      agent_skills: {
        'gsd-executor': ['skills/test-skill'],
      },
    });

    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.agent_type, 'gsd-executor');
    assert.ok(r.ir.block.includes('<agent_skills>'), `block must contain <agent_skills> tag, got: ${r.ir.block}`);
    assert.ok(r.ir.block.includes('</agent_skills>'), 'block must contain closing tag');
    assert.ok(r.ir.block.includes('skills/test-skill/SKILL.md'), 'block must contain skill path');
  });

  test('skills_count reflects configured skill paths for agent type', () => {
    const skillDir = path.join(tmpDir, 'skills', 'test-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Test Skill\n');

    writeConfig(tmpDir, {
      agent_skills: {
        'gsd-executor': ['skills/test-skill'],
      },
    });

    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.skills_count, 1, 'skills_count must be 1 for single configured skill path');
  });

  test('returns block for configured agent with single string path', () => {
    const skillDir = path.join(tmpDir, 'skills', 'my-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# My Skill\n');

    writeConfig(tmpDir, {
      agent_skills: {
        'gsd-executor': 'skills/my-skill',
      },
    });

    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.ok(r.ir.block.includes('skills/my-skill/SKILL.md'), 'block must contain skill path');
    assert.strictEqual(r.ir.skills_count, 1, 'skills_count must be 1 for single string path');
  });

  test('handles multiple skill paths', () => {
    const skill1 = path.join(tmpDir, 'skills', 'skill-a');
    const skill2 = path.join(tmpDir, 'skills', 'skill-b');
    fs.mkdirSync(skill1, { recursive: true });
    fs.mkdirSync(skill2, { recursive: true });
    fs.writeFileSync(path.join(skill1, 'SKILL.md'), '# Skill A\n');
    fs.writeFileSync(path.join(skill2, 'SKILL.md'), '# Skill B\n');

    writeConfig(tmpDir, {
      agent_skills: {
        'gsd-executor': ['skills/skill-a', 'skills/skill-b'],
      },
    });

    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.ok(r.ir.block.includes('skills/skill-a/SKILL.md'), 'block must contain first skill');
    assert.ok(r.ir.block.includes('skills/skill-b/SKILL.md'), 'block must contain second skill');
    assert.strictEqual(r.ir.skills_count, 2, 'skills_count must be 2 for two configured paths');
  });

  test('warns for nonexistent skill path but does not error', () => {
    writeConfig(tmpDir, {
      agent_skills: {
        'gsd-executor': ['skills/nonexistent'],
      },
    });

    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(r.success, 'Command should succeed even with missing skill paths');
    assert.strictEqual(r.ir.block, '', 'block must be empty when all skill paths are missing');
    // The --json IR carries a warnings[] field (#1374): a skipped path must not
    // be dropped silently. Assert it names the missing path so this test guards
    // the silent-drop regression, not merely the empty block.
    assert.ok(Array.isArray(r.ir.warnings), 'IR must include a warnings array');
    assert.ok(
      r.ir.warnings.some((w) => w.includes('skills/nonexistent')),
      `warnings must name the skipped path, got: ${JSON.stringify(r.ir.warnings)}`,
    );
  });

  test('validates path safety — rejects traversal attempts', () => {
    writeConfig(tmpDir, {
      agent_skills: {
        'gsd-executor': ['../../../etc/passwd'],
      },
    });

    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(!r.ir || !r.ir.block.includes('/etc/passwd'), 'block must not include traversal path');
  });

  test('returns typed empty IR when no agent type argument provided', () => {
    const r = runAgentSkillsJson(['agent-skills'], tmpDir);
    assert.ok(r.success, 'Command should succeed');
    // With --json and no agent type, cmdAgentSkills calls output('', raw, ''),
    // so the IR is the JSON-encoded empty string "" which parses to ''. Pin that
    // exact contract: the old assertion (=== '' || typeof === 'object') passed
    // even for a null IR because typeof null === 'object', so it guarded nothing.
    assert.strictEqual(r.ir, '', 'empty IR must be the empty string when no agent type is provided');
  });
});

// ─── empty-resolution diagnostics (silent-drop visibility) ────────────────────
//
// When an agent is CONFIGURED with skill paths but every path fails to resolve
// (missing SKILL.md, unsafe path, invalid global name), buildAgentSkillsBlock
// previously returned '' with only per-path stderr warnings and no aggregate
// signal — so `query agent-skills --json` reported skills_count > 0 with an
// empty block and no indication the configured skills were dropped.
//
// Fix: emit an aggregate stderr WARNING when configured paths all resolve to
// zero skills, and surface every skip reason in a `warnings[]` field on the
// --json IR.
describe('agent-skills empty-resolution diagnostics', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('configured agent whose only skill is missing → warnings[] names the path and the aggregate drop', () => {
    writeConfig(tmpDir, {
      agent_skills: { 'gsd-phase-researcher': ['references/other-skill'] },
    });

    const r = runAgentSkillsJson(['agent-skills', 'gsd-phase-researcher'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '', 'block must be empty when the only configured skill is missing');
    assert.strictEqual(r.ir.skills_count, 1, 'skills_count still reflects the configured path count');
    assert.ok(Array.isArray(r.ir.warnings), 'IR must include a warnings array');
    assert.ok(r.ir.warnings.length >= 1, `warnings must be non-empty, got: ${JSON.stringify(r.ir.warnings)}`);
    assert.ok(
      r.ir.warnings.some((w) => w.includes('references/other-skill')),
      `warnings must name the skipped path, got: ${JSON.stringify(r.ir.warnings)}`,
    );
    assert.ok(
      r.ir.warnings.some((w) => /none resolved to a valid skill/.test(w)),
      `warnings must include the aggregate empty-resolution diagnostic, got: ${JSON.stringify(r.ir.warnings)}`,
    );
  });

  test('configured agent with all skills missing → aggregate WARNING on stderr naming the agent', () => {
    writeConfig(tmpDir, {
      agent_skills: { 'gsd-planner': ['references/a', 'references/b'] },
    });

    const r = runGsdToolsWithStderr(['agent-skills', '--json', 'gsd-planner'], tmpDir, {
      HOME: tmpDir,
      USERPROFILE: tmpDir,
    });
    assert.ok(r.success, `Command failed (exit ${r.exitCode}): ${r.stderr}`);
    assert.ok(
      r.stderr.includes('[agent-skills] WARNING') &&
        r.stderr.includes('gsd-planner') &&
        r.stderr.includes('none resolved to a valid skill'),
      `stderr must carry the aggregate empty-resolution warning naming the agent, got: ${r.stderr}`,
    );
    const ir = JSON.parse(r.stdout);
    assert.strictEqual(ir.block, '');
    assert.ok(ir.warnings.length >= 2, `warnings must list both skipped paths, got: ${JSON.stringify(ir.warnings)}`);
  });

  test('partial resolution: one valid + one missing → block present, NO aggregate warning, skipped path still listed', () => {
    const skillDir = path.join(tmpDir, 'skills', 'present');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# present\n');

    writeConfig(tmpDir, {
      agent_skills: { 'gsd-executor': ['skills/present', 'skills/absent'] },
    });

    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.ok(r.ir.block.includes('skills/present/SKILL.md'), 'block must include the resolvable skill');
    assert.strictEqual(r.ir.skills_count, 2, 'skills_count reflects both configured paths');
    assert.ok(Array.isArray(r.ir.warnings), 'IR must include a warnings array');
    assert.ok(
      r.ir.warnings.some((w) => w.includes('skills/absent')),
      `warnings must list the one skipped path, got: ${JSON.stringify(r.ir.warnings)}`,
    );
    assert.ok(
      !r.ir.warnings.some((w) => /none resolved to a valid skill/.test(w)),
      `aggregate empty-resolution warning must NOT fire when at least one skill resolved, got: ${JSON.stringify(r.ir.warnings)}`,
    );
  });

  test('all skills resolve → warnings[] is empty', () => {
    const skillDir = path.join(tmpDir, 'skills', 'only');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# only\n');

    writeConfig(tmpDir, {
      agent_skills: { 'gsd-executor': ['skills/only'] },
    });

    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.ok(r.ir.block.includes('skills/only/SKILL.md'), 'block must include the resolved skill');
    assert.ok(Array.isArray(r.ir.warnings), 'IR must include a warnings array');
    assert.strictEqual(r.ir.warnings.length, 0, `warnings must be empty when all skills resolve, got: ${JSON.stringify(r.ir.warnings)}`);
  });

  test('unconfigured agent → warnings[] empty (no skills configured is not a drop)', () => {
    writeConfig(tmpDir, {
      agent_skills: { 'gsd-executor': ['skills/whatever'] },
    });

    const r = runAgentSkillsJson(['agent-skills', 'gsd-planner'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '');
    assert.ok(Array.isArray(r.ir.warnings), 'IR must include a warnings array');
    assert.strictEqual(r.ir.warnings.length, 0, 'an agent with no configured skills is not a drop — warnings must be empty');
  });

  test('malformed (non-array, non-string) configured value → flagged in warnings[], not a silent drop', () => {
    // A hand-edited config.json could carry a scalar instead of an array.
    // cmdAgentSkills still counts it as a configured path, so it must be surfaced.
    writeConfig(tmpDir, {
      agent_skills: { 'gsd-executor': 42 },
    });

    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '', 'block must be empty for a malformed value');
    assert.ok(Array.isArray(r.ir.warnings), 'IR must include a warnings array');
    assert.ok(
      r.ir.warnings.some((w) => /malformed agent_skills value/.test(w)),
      `malformed scalar config must be flagged in warnings[], got: ${JSON.stringify(r.ir.warnings)}`,
    );
  });
});

// ─── config-ensure-section includes agent_skills ────────────────────────────

describe('config-ensure-section with agent_skills', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('new configs include agent_skills key', () => {
    const result = runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.ok('agent_skills' in config, 'config should have agent_skills key');
    assert.deepStrictEqual(config.agent_skills, {}, 'agent_skills should default to empty object');
  });
});

// ─── config-set agent_skills ─────────────────────────────────────────────────

describe('config-set agent_skills', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Ensure config exists first
    runGsdTools('config-ensure-section', tmpDir, { HOME: tmpDir, USERPROFILE: tmpDir });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('can set agent_skills via dot notation', () => {
    const result = runGsdTools(
      ['config-set', 'agent_skills.gsd-executor', '["skills/my-skill"]'],
      tmpDir,
      { HOME: tmpDir, USERPROFILE: tmpDir }
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const config = readConfig(tmpDir);
    assert.deepStrictEqual(
      config.agent_skills['gsd-executor'],
      ['skills/my-skill'],
      'Should store array of skill paths'
    );
  });
});

// ─── global: prefix support (#1992) ──────────────────────────────────────────

describe('agent-skills global: prefix', () => {
  let tmpDir;
  let fakeHome;
  let globalSkillsDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    // Create a fake HOME with ~/.claude/skills/ structure
    fakeHome = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gsd-1992-home-'));
    globalSkillsDir = path.join(fakeHome, '.claude', 'skills');
    fs.mkdirSync(globalSkillsDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
    cleanup(fakeHome);
  });

  function createGlobalSkill(name) {
    const skillDir = path.join(globalSkillsDir, name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${name}\nGlobal skill content.\n`);
    return skillDir;
  }

  test('global:valid-skill resolves to $HOME/.claude/skills/valid-skill/SKILL.md', () => {
    createGlobalSkill('valid-skill');
    writeConfig(tmpDir, {
      agent_skills: { 'gsd-executor': ['global:valid-skill'] },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.ok(r.ir.block.includes('valid-skill/SKILL.md'), `block must reference the global skill: ${r.ir.block}`);
    assert.ok(r.ir.block.includes('<agent_skills>'), 'block must emit agent_skills XML');
  });

  test('global:invalid!name is rejected by regex and skipped', () => {
    writeConfig(tmpDir, {
      agent_skills: { 'gsd-executor': ['global:invalid!name'] },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '', 'block must be empty when invalid name is rejected');
  });

  test('global:missing-skill is skipped when directory is absent', () => {
    writeConfig(tmpDir, {
      agent_skills: { 'gsd-executor': ['global:missing-skill'] },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '', 'block must be empty when skill is missing');
  });

  test('mix of global: and project-relative paths both resolve correctly', () => {
    createGlobalSkill('shadcn');

    const projectSkillDir = path.join(tmpDir, 'skills', 'local-skill');
    fs.mkdirSync(projectSkillDir, { recursive: true });
    fs.writeFileSync(path.join(projectSkillDir, 'SKILL.md'), '# local\n');

    writeConfig(tmpDir, {
      agent_skills: { 'gsd-executor': ['global:shadcn', 'skills/local-skill'] },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.ok(r.ir.block.includes('shadcn/SKILL.md'), 'block must include global shadcn');
    assert.ok(r.ir.block.includes('skills/local-skill/SKILL.md'), 'block must include project-relative skill');
    assert.strictEqual(r.ir.skills_count, 2, 'skills_count must be 2 for both configured paths');
  });

  test('global: with empty name produces clear warning and skips', () => {
    writeConfig(tmpDir, {
      agent_skills: { 'gsd-executor': ['global:'] },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '', 'block must be empty for empty global: prefix');
  });
});

// ─── loadTrustedGlobalRoots unit tests (#52) ──────────────────────────────────

describe('loadTrustedGlobalRoots', () => {
  test('returns [] for undefined config', () => {
    assert.deepStrictEqual(loadTrustedGlobalRoots(undefined), []);
  });

  test('returns [] for null config', () => {
    assert.deepStrictEqual(loadTrustedGlobalRoots(null), []);
  });

  test('returns [] when agent_skills_security is absent', () => {
    assert.deepStrictEqual(loadTrustedGlobalRoots({}), []);
  });

  test('returns [] when trusted_global_roots is absent', () => {
    assert.deepStrictEqual(loadTrustedGlobalRoots({ agent_skills_security: {} }), []);
  });

  test('returns [] when trusted_global_roots is not an array', () => {
    assert.deepStrictEqual(loadTrustedGlobalRoots({ agent_skills_security: { trusted_global_roots: '/some/path' } }), []);
    assert.deepStrictEqual(loadTrustedGlobalRoots({ agent_skills_security: { trusted_global_roots: 42 } }), []);
    assert.deepStrictEqual(loadTrustedGlobalRoots({ agent_skills_security: { trusted_global_roots: true } }), []);
  });

  test('drops non-string entries from the array', () => {
    // Use a real temp dir so realpathSync succeeds; non-strings are still dropped
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-tgr-ns-'));
    try {
      const realPath = fs.realpathSync(realDir);
      const config = { agent_skills_security: { trusted_global_roots: [42, null, realDir, true] } };
      assert.deepStrictEqual(loadTrustedGlobalRoots(config), [realPath]);
    } finally {
      cleanup(realDir);
    }
  });

  test('drops project-relative (non-absolute) entries', () => {
    const config = { agent_skills_security: { trusted_global_roots: ['foo/bar', 'relative/path'] } };
    assert.deepStrictEqual(loadTrustedGlobalRoots(config), []);
  });

  test('keeps absolute paths — real dirs are kept and canonicalized', () => {
    // Non-existent dirs are dropped; use real temp dirs and compare against realpaths
    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-tgr-d1-'));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-tgr-d2-'));
    try {
      const real1 = fs.realpathSync(dir1);
      const real2 = fs.realpathSync(dir2);
      const config = { agent_skills_security: { trusted_global_roots: [dir1, dir2] } };
      assert.deepStrictEqual(loadTrustedGlobalRoots(config), [real1, real2]);
    } finally {
      cleanup(dir1);
      cleanup(dir2);
    }
  });

  test('expands leading ~/ to os.homedir() — kept only if the dir exists', () => {
    // Create a real subdir under os.tmpdir() and verify it is kept (canonical compare)
    // Note: we cannot reliably create a dir under os.homedir() in CI, so we verify
    // the expansion logic using a known-existing absolute path that happens to be
    // "within" homedir — the tilde expansion is exercised separately; this test
    // verifies the returned value equals the realpath of the expanded path.
    const subdir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-tgr-tilde-'));
    try {
      const realSub = fs.realpathSync(subdir);
      // Pass a raw path (non-tilde) to verify realpath canonicalization at minimum
      const config = { agent_skills_security: { trusted_global_roots: [subdir] } };
      const result = loadTrustedGlobalRoots(config);
      assert.deepStrictEqual(result, [realSub], 'result must equal realpath of existing dir');
    } finally {
      cleanup(subdir);
    }
  });

  test('non-existent absolute root is dropped (returns [])', () => {
    const config = { agent_skills_security: { trusted_global_roots: ['/nonexistent-gsd-root-12345xyz'] } };
    assert.deepStrictEqual(loadTrustedGlobalRoots(config), [], 'non-existent root must be dropped');
  });

  test('trusted root that is a symlink is canonicalized to the link target', () => {
    const realTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-tgr-symtgt-'));
    const symlinkPath = path.join(os.tmpdir(), `gsd-tgr-symlink-${Date.now()}`);
    let symlinkCreated = false;
    try {
      try {
        fs.symlinkSync(realTarget, symlinkPath);
        symlinkCreated = true;
      } catch (err) {
        if (err.code === 'EPERM' || err.code === 'ENOSYS') {
          // symlinks not supported on this platform — skip
          return;
        }
        throw err;
      }
      const realResolved = fs.realpathSync(realTarget);
      const config = { agent_skills_security: { trusted_global_roots: [symlinkPath] } };
      const result = loadTrustedGlobalRoots(config);
      assert.deepStrictEqual(result, [realResolved], 'symlink root must be canonicalized to the link target');
    } finally {
      cleanup(realTarget);
      if (symlinkCreated) {
        try { fs.unlinkSync(symlinkPath); } catch { /* ignore */ }
      }
    }
  });

  test('de-duplicates entries by canonical path', () => {
    // Both entries point to the same real dir — after canonicalization, only one is kept
    const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-tgr-dedup-'));
    try {
      const realPath = fs.realpathSync(realDir);
      const config = { agent_skills_security: { trusted_global_roots: [realDir, realDir, realPath] } };
      assert.deepStrictEqual(loadTrustedGlobalRoots(config), [realPath]);
    } finally {
      cleanup(realDir);
    }
  });

  test('expands ~/ before absolute check — non-existent ~/x is dropped after expansion', () => {
    // ~/x becomes an absolute path after expansion, but if ~/x does not exist it is
    // dropped by the realpathSync guard (non-existent root is not trustworthy).
    const expandedX = path.join(os.homedir(), 'x-gsd-nonexistent-12345');
    // Ensure it really doesn't exist
    if (fs.existsSync(expandedX)) {
      // Cannot test non-existence reliably — skip assertion
      return;
    }
    const config = { agent_skills_security: { trusted_global_roots: ['~/x-gsd-nonexistent-12345'] } };
    const result = loadTrustedGlobalRoots(config);
    assert.deepStrictEqual(result, [], 'non-existent ~/x must be dropped after expansion');
  });

  test('expands bare ~ to os.homedir()', () => {
    // Bare ~ (exactly) must expand to homedir — mirrors runtime-homes.cts:28
    const config = { agent_skills_security: { trusted_global_roots: ['~'] } };
    const result = loadTrustedGlobalRoots(config);
    // ~ expands to homedir, which is then rejected as a dangerously broad root
    // So the result must be [] (rejected after expansion)
    assert.deepStrictEqual(result, [], 'bare ~ expands to homedir and is then rejected as too broad');
  });

  test('rejects filesystem root /', () => {
    const config = { agent_skills_security: { trusted_global_roots: ['/'] } };
    assert.deepStrictEqual(loadTrustedGlobalRoots(config), [], 'filesystem root must be rejected');
  });

  test('rejects os.homedir() itself', () => {
    const config = { agent_skills_security: { trusted_global_roots: [os.homedir()] } };
    assert.deepStrictEqual(loadTrustedGlobalRoots(config), [], 'homedir itself must be rejected as too broad');
  });
});

// ─── trusted_global_roots integration guard (#52) ─────────────────────────────
//
// NOTE: These tests validate the trusted-root bypass logic by directly calling
// loadTrustedGlobalRoots + validatePath rather than invoking the full CLI
// (which would require controlling the runtime HOME path in a way that also
// triggers a symlink escape scenario through gsd-tools subprocess invocation).
// Full end-to-end symlink testing would require OS-level symlink setup in tmp
// dirs and a mechanism to redirect the runtime home path — coverage here is
// sufficient to verify the core guard logic.

describe('trusted_global_roots guard logic', () => {
  let tmpDir;
  let externalDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-52-trusted-'));
    externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-52-external-'));
    // Create a skill file in externalDir
    fs.writeFileSync(path.join(externalDir, 'SKILL.md'), '# External\n');
  });

  afterEach(() => {
    cleanup(tmpDir);
    cleanup(externalDir);
  });

  test('validatePath rejects skill outside globalSkillsBase (baseline — no trusted roots)', () => {
    const skillMd = path.join(externalDir, 'SKILL.md');
    const result = validatePath(skillMd, tmpDir, { allowAbsolute: true });
    assert.ok(!result.safe, 'skill outside base must be rejected by validatePath');
  });

  test('with trusted root matching real target dir — validatePath accepts', () => {
    // Simulate the trusted-root fallback: skill is outside base but inside trusted root
    const skillMd = path.join(externalDir, 'SKILL.md');
    const baseCheck = validatePath(skillMd, tmpDir, { allowAbsolute: true });
    assert.ok(!baseCheck.safe, 'base check must fail (prerequisite)');

    // Trusted root fallback: check against externalDir
    const config = { agent_skills_security: { trusted_global_roots: [externalDir] } };
    const trustedRoots = loadTrustedGlobalRoots(config);
    const acceptedViaTrustedRoot = trustedRoots.some((root) => {
      const rootCheck = validatePath(skillMd, root, { allowAbsolute: true });
      return rootCheck.safe;
    });
    assert.ok(acceptedViaTrustedRoot, 'skill must be accepted when within a trusted root');
  });

  test('with unrelated trusted root — skill still rejected', () => {
    const skillMd = path.join(externalDir, 'SKILL.md');
    const unrelatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-52-unrelated-'));
    try {
      const config = { agent_skills_security: { trusted_global_roots: [unrelatedDir] } };
      const trustedRoots = loadTrustedGlobalRoots(config);
      const acceptedViaTrustedRoot = trustedRoots.some((root) => {
        const rootCheck = validatePath(skillMd, root, { allowAbsolute: true });
        return rootCheck.safe;
      });
      assert.ok(!acceptedViaTrustedRoot, 'skill must still be rejected when trusted root is unrelated');
    } finally {
      cleanup(unrelatedDir);
    }
  });

  test('with empty trusted_global_roots array — skill still rejected (byte-identical to today)', () => {
    const skillMd = path.join(externalDir, 'SKILL.md');
    const config = { agent_skills_security: { trusted_global_roots: [] } };
    const trustedRoots = loadTrustedGlobalRoots(config);
    assert.strictEqual(trustedRoots.length, 0, 'no roots loaded');
    const acceptedViaTrustedRoot = trustedRoots.some((root) => {
      const rootCheck = validatePath(skillMd, root, { allowAbsolute: true });
      return rootCheck.safe;
    });
    assert.ok(!acceptedViaTrustedRoot, 'skill must be rejected when trusted roots is empty');
  });
});

// ─── trusted_global_roots e2e CLI tests (#52) ─────────────────────────────────
//
// These tests exercise the full CLI path (runAgentSkillsJson → gsd-tools →
// loadConfig → agent-skills command) to verify that agent_skills_security is
// properly threaded through the config pipeline. Symlinks are created so a
// global: skill's realpath escapes the ~/.claude/skills/ base, requiring a
// trusted root to be accepted.

describe('trusted_global_roots e2e CLI (#52)', () => {
  let tmpDir;
  let fakeHome;
  let globalSkillsDir;
  let sharedRoot;
  let symlinkSupported;

  beforeEach(() => {
    tmpDir = createTempProject();
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-52-e2e-home-'));
    globalSkillsDir = path.join(fakeHome, '.claude', 'skills');
    fs.mkdirSync(globalSkillsDir, { recursive: true });
    sharedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-52-e2e-shared-'));

    // Create the shared skill directory OUTSIDE fakeHome
    const sharedSkillDir = path.join(sharedRoot, 'shared-skill');
    fs.mkdirSync(sharedSkillDir, { recursive: true });
    fs.writeFileSync(path.join(sharedSkillDir, 'SKILL.md'), '# Shared Skill\nContent from shared root.\n');

    // Attempt to create a symlink inside globalSkillsDir pointing to the shared skill
    symlinkSupported = true;
    try {
      fs.symlinkSync(sharedSkillDir, path.join(globalSkillsDir, 'shared-skill'));
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'ENOSYS') {
        symlinkSupported = false;
      } else {
        throw err;
      }
    }
  });

  afterEach(() => {
    cleanup(tmpDir);
    cleanup(fakeHome);
    cleanup(sharedRoot);
  });

  test('REGRESSION: symlinked-escape skill with NO agent_skills_security in config → block is empty', (t) => {
    if (!symlinkSupported) {
      t.skip('symlinks not supported on this platform');
      return;
    }
    // No agent_skills_security in config — symlink escape must be blocked
    writeConfig(tmpDir, {
      runtime: 'claude',
      agent_skills: { 'gsd-executor': ['global:shared-skill'] },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '', 'block must be empty when symlink escapes base and no trusted root configured');
  });

  test('FEATURE: symlink escape with matching trusted_global_roots → block includes skill', (t) => {
    if (!symlinkSupported) {
      t.skip('symlinks not supported on this platform');
      return;
    }
    // Configure the sharedRoot as a trusted global root
    writeConfig(tmpDir, {
      runtime: 'claude',
      agent_skills: { 'gsd-executor': ['global:shared-skill'] },
      agent_skills_security: { trusted_global_roots: [sharedRoot] },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.ok(r.ir.block.includes('<agent_skills>'), `block must contain <agent_skills> tag, got: ${r.ir.block}`);
    assert.ok(r.ir.block.includes('shared-skill/SKILL.md'), `block must include the shared skill, got: ${r.ir.block}`);
    assert.ok(r.ir.skills_count >= 1, 'skills_count must be at least 1');
  });

  test('FEATURE NOTE: accepted-via-trusted-root emits NOTE on stderr', (t) => {
    if (!symlinkSupported) {
      t.skip('symlinks not supported on this platform');
      return;
    }
    // Capture stderr using spawnSync (runGsdTools only captures stderr on failure)
    writeConfig(tmpDir, {
      runtime: 'claude',
      agent_skills: { 'gsd-executor': ['global:shared-skill'] },
      agent_skills_security: { trusted_global_roots: [sharedRoot] },
    });

    const r = runGsdToolsWithStderr(
      ['agent-skills', '--json', 'gsd-executor'],
      tmpDir,
      { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed (exit ${r.exitCode}): ${r.stderr}`);
    // The NOTE must appear on stderr using only the skill name (no full paths)
    assert.ok(
      r.stderr.includes('[agent-skills] NOTE: Global skill "shared-skill" accepted via trusted_global_roots'),
      `stderr must contain the trusted-root NOTE, got: ${r.stderr}`,
    );
  });

  test('NEGATIVE: symlink escape with unrelated trusted root (existing dir) → block is empty', (t) => {
    if (!symlinkSupported) {
      t.skip('symlinks not supported on this platform');
      return;
    }
    // The unrelated dir MUST exist so it isn't dropped for the wrong reason (non-existence).
    // Rejection must be because it doesn't cover the shared skill location, not because
    // the dir is missing — otherwise the test would pass vacuously.
    const unrelatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-52-e2e-unrelated-'));
    // Verify the dir actually exists so the trusted root is loaded (not silently dropped)
    assert.ok(fs.existsSync(unrelatedRoot), 'unrelated root must exist so it enters the trusted roots list');
    try {
      writeConfig(tmpDir, {
        runtime: 'claude',
        agent_skills: { 'gsd-executor': ['global:shared-skill'] },
        agent_skills_security: { trusted_global_roots: [unrelatedRoot] },
      });

      const r = runAgentSkillsJson(
        ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
      );
      assert.ok(r.success, `Command failed: ${r.error}`);
      assert.strictEqual(r.ir.block, '', 'block must be empty when trusted root does not cover the shared skill location');
    } finally {
      cleanup(unrelatedRoot);
    }
  });

  test('HARDENING: trusted_global_roots: ["/"] → block is empty (broad root rejected)', (t) => {
    if (!symlinkSupported) {
      t.skip('symlinks not supported on this platform');
      return;
    }
    writeConfig(tmpDir, {
      runtime: 'claude',
      agent_skills: { 'gsd-executor': ['global:shared-skill'] },
      agent_skills_security: { trusted_global_roots: ['/'] },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '', 'block must be empty when "/" is the trusted root (rejected as too broad)');
  });
});

// ─── bug #1243: plugin-namespaced agent skills ─────────────────────────────────
// allow-test-rule: source-text-is-the-product (#1243)

describe('bug #1243: plugin-namespaced agent skills', () => {
  let tmpDir;
  let fakeHome;
  let globalSkillsDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    fakeHome = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gsd-1243-home-'));
    globalSkillsDir = path.join(fakeHome, '.claude', 'skills');
    fs.mkdirSync(globalSkillsDir, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
    cleanup(fakeHome);
  });

  function createGlobalSkill1243(name) {
    const skillDir = path.join(globalSkillsDir, name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `# ${name}\nGlobal skill content.\n`);
    return skillDir;
  }

  // ─── happy path ────────────────────────────────────────────────────────────

  test('happy: global:coderabbit:code-review (claude) emits directive naming coderabbit:code-review, no @-line, no path', () => {
    writeConfig(tmpDir, {
      runtime: 'claude',
      agent_skills: { 'gsd-executor': ['global:coderabbit:code-review'] },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    // Must contain the namespaced name
    assert.ok(
      r.ir.block.includes('coderabbit:code-review'),
      `block must contain namespaced name, got: ${r.ir.block}`
    );
    // Must NOT be a @-include line
    assert.ok(
      !r.ir.block.includes('- @'),
      `block must not contain @-include line, got: ${r.ir.block}`
    );
    // Must NOT contain filesystem path or plugins/cache
    assert.ok(
      !r.ir.block.includes('plugins/cache'),
      `block must not contain plugins/cache, got: ${r.ir.block}`
    );
    // Must have the <agent_skills> wrapper
    assert.ok(
      r.ir.block.includes('<agent_skills>'),
      `block must contain <agent_skills> wrapper, got: ${r.ir.block}`
    );
  });

  // ─── mixed: path-resolvable + namespaced ────────────────────────────────────

  test('mixed: path-resolvable global + namespaced → @-include AND directive in block', () => {
    createGlobalSkill1243('my-local-skill');
    writeConfig(tmpDir, {
      runtime: 'claude',
      agent_skills: {
        'gsd-executor': ['global:my-local-skill', 'global:vendor:remote-skill'],
      },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    // The path-resolvable one must be a @-include
    assert.ok(
      r.ir.block.includes('- @') && r.ir.block.includes('my-local-skill/SKILL.md'),
      `block must contain @-include for path-resolvable skill, got: ${r.ir.block}`
    );
    // The namespaced one must be a directive, not a @-include
    assert.ok(
      r.ir.block.includes('vendor:remote-skill'),
      `block must contain namespaced directive, got: ${r.ir.block}`
    );
  });

  // ─── precedence: bare unresolved vs resolved ─────────────────────────────────

  test('precedence: bare global:foo not-on-disk → not found/skipped, no directive', () => {
    // foo is NOT created on disk
    writeConfig(tmpDir, {
      runtime: 'claude',
      agent_skills: { 'gsd-executor': ['global:foo'] },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '', `bare unresolved name must produce empty block, got: ${r.ir.block}`);
  });

  test('precedence: bare global:foo that resolves → @-include (existing path behavior)', () => {
    createGlobalSkill1243('foo');
    writeConfig(tmpDir, {
      runtime: 'claude',
      agent_skills: { 'gsd-executor': ['global:foo'] },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.ok(
      r.ir.block.includes('- @') && r.ir.block.includes('foo/SKILL.md'),
      `path-resolvable bare name must produce @-include, got: ${r.ir.block}`
    );
  });

  // ─── negative validation ─────────────────────────────────────────────────────

  test('negative: global:../evil rejected', () => {
    writeConfig(tmpDir, {
      runtime: 'claude',
      agent_skills: { 'gsd-executor': ['global:../evil'] },
    });
    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '', `traversal must be rejected, got: ${r.ir.block}`);
  });

  test('negative: global:a::b rejected (empty segment)', () => {
    writeConfig(tmpDir, {
      runtime: 'claude',
      agent_skills: { 'gsd-executor': ['global:a::b'] },
    });
    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '', `double-colon must be rejected, got: ${r.ir.block}`);
  });

  test('negative: global::x rejected (leading colon)', () => {
    writeConfig(tmpDir, {
      runtime: 'claude',
      agent_skills: { 'gsd-executor': ['global::x'] },
    });
    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '', `leading colon must be rejected, got: ${r.ir.block}`);
  });

  test('negative: global:x: rejected (trailing colon)', () => {
    writeConfig(tmpDir, {
      runtime: 'claude',
      agent_skills: { 'gsd-executor': ['global:x:'] },
    });
    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '', `trailing colon must be rejected, got: ${r.ir.block}`);
  });

  test('negative: global:a/b rejected (slash in name)', () => {
    writeConfig(tmpDir, {
      runtime: 'claude',
      agent_skills: { 'gsd-executor': ['global:a/b'] },
    });
    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '', `slash in name must be rejected, got: ${r.ir.block}`);
  });

  test('negative: global: (empty name) rejected', () => {
    writeConfig(tmpDir, {
      runtime: 'claude',
      agent_skills: { 'gsd-executor': ['global:'] },
    });
    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '', `empty name must be rejected, got: ${r.ir.block}`);
  });

  // ─── cross-runtime ──────────────────────────────────────────────────────────

  test('cross-runtime: namespaced + codex runtime → no directive (skipped/warned)', () => {
    writeConfig(tmpDir, {
      runtime: 'codex',
      agent_skills: { 'gsd-executor': ['global:vendor:remote-skill'] },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(
      r.ir.block,
      '',
      `namespaced skill on non-claude runtime must produce empty block, got: ${r.ir.block}`
    );
  });

  test('cross-runtime: namespaced + claude runtime → directive emitted', () => {
    writeConfig(tmpDir, {
      runtime: 'claude',
      agent_skills: { 'gsd-executor': ['global:vendor:remote-skill'] },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.ok(
      r.ir.block.includes('vendor:remote-skill'),
      `claude runtime must emit directive for namespaced skill, got: ${r.ir.block}`
    );
  });

  // ─── regression (Hyrum) ─────────────────────────────────────────────────────

  test('HYRUM regression: include-only block is BYTE-IDENTICAL to expected format', () => {
    // This test asserts the FULL block output is byte-identical for an include-only
    // config (path-resolvable global skill + project-relative local skill).
    // It protects the ~22 workflow consumers that depend on this exact block shape.
    createGlobalSkill1243('shadcn');
    const projectSkillDir = path.join(tmpDir, 'skills', 'local');
    fs.mkdirSync(projectSkillDir, { recursive: true });
    fs.writeFileSync(path.join(projectSkillDir, 'SKILL.md'), '# local\n');

    writeConfig(tmpDir, {
      runtime: 'claude',
      agent_skills: { 'gsd-executor': ['global:shadcn', 'skills/local'] },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);

    // Compute the expected absolute path for the global skill (resolved via fakeHome)
    const expectedGlobalPath = path.join(fakeHome, '.claude', 'skills', 'shadcn', 'SKILL.md');
    // The local path is always project-relative (not absolute)
    const expectedLocalPath = 'skills/local/SKILL.md';

    const expectedBlock = [
      '<agent_skills>',
      'Read these user-configured skills:',
      `- @${expectedGlobalPath.replace(/\\/g, '/')}`,
      `- @${expectedLocalPath}`,
      '</agent_skills>',
    ].join('\n');

    assert.strictEqual(
      r.ir.block.replace(/\\/g, '/'),
      expectedBlock,
      `HYRUM: block must be byte-identical to expected include-only format.\nExpected: ${JSON.stringify(expectedBlock)}\nGot:      ${JSON.stringify(r.ir.block)}`
    );
  });

  test('regression: empty/missing config → empty block', () => {
    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.block, '', `missing config must produce empty block, got: ${r.ir.block}`);
  });

  test('BYTE-IDENTICAL mixed-block: path-resolvable global + plugin-namespaced → single section, interleaved, exact format', () => {
    // Regression for code-review finding: docs previously showed a bogus two-section format
    // with a separate "Load these plugin-provided skills using the Skill tool:" header.
    // The ACTUAL emitted block is a single <agent_skills> section where @-includes and
    // plugin-provided directives are interleaved in config order under the same header.
    //
    // Config order: global:my-local-skill (path-resolvable) FIRST, then global:vendor:remote-skill (namespaced).
    createGlobalSkill1243('my-local-skill');
    writeConfig(tmpDir, {
      runtime: 'claude',
      agent_skills: {
        'gsd-executor': ['global:my-local-skill', 'global:vendor:remote-skill'],
      },
    });

    const r = runAgentSkillsJson(
      ['agent-skills', 'gsd-executor'], tmpDir, { HOME: fakeHome, USERPROFILE: fakeHome }
    );
    assert.ok(r.success, `Command failed: ${r.error}`);

    // Compute the expected @-include path (absolute path to the resolved global skill)
    const expectedInclude = path.join(fakeHome, '.claude', 'skills', 'my-local-skill', 'SKILL.md');

    const expectedBlock = [
      '<agent_skills>',
      'Read these user-configured skills:',
      `- @${expectedInclude.replace(/\\/g, '/')}`,
      '- Load the `vendor:remote-skill` skill via the Skill tool before proceeding (plugin-provided).',
      '</agent_skills>',
    ].join('\n');

    assert.strictEqual(
      r.ir.block.replace(/\\/g, '/'),
      expectedBlock,
      `BYTE-IDENTICAL: mixed block must be a single section with @-include and directive interleaved.\nExpected: ${JSON.stringify(expectedBlock)}\nGot:      ${JSON.stringify(r.ir.block)}`
    );

    // Structural assertions: must NOT contain any secondary header
    assert.ok(
      !r.ir.block.includes('Load these plugin-provided skills using the Skill tool:'),
      `block must NOT contain the bogus two-section header, got: ${r.ir.block}`
    );
  });

  // ─── grant: Skill tool in consumer agent frontmatter ─────────────────────────

  test('grant: all 22 agent_skills consumer agents have Skill in their tools frontmatter', () => {
    const CONSUMER_AGENTS = [
      'gsd-advisor-researcher',
      'gsd-assumptions-analyzer',
      'gsd-code-fixer',
      'gsd-code-reviewer',
      'gsd-codebase-mapper',
      'gsd-debugger',
      'gsd-doc-writer',
      'gsd-eval-auditor',
      'gsd-executor',
      'gsd-integration-checker',
      'gsd-nyquist-auditor',
      'gsd-phase-researcher',
      'gsd-plan-checker',
      'gsd-planner',
      'gsd-project-researcher',
      'gsd-research-synthesizer',
      'gsd-roadmapper',
      'gsd-security-auditor',
      'gsd-ui-auditor',
      'gsd-ui-checker',
      'gsd-ui-researcher',
      'gsd-verifier',
    ];
    const AGENTS_DIR = path.join(__dirname, '..', 'agents');

    /**
     * Extract tool names from an agent file's frontmatter.
     * Handles both inline CSV format ("tools: Read, Write") and
     * YAML block sequence format ("tools:\n  - Read\n  - Write").
     */
    function extractTools(content) {
      // Parse frontmatter between first pair of --- delimiters
      const lines = content.split('\n');
      let fmStart = -1;
      let fmEnd = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '---') {
          if (fmStart === -1) fmStart = i;
          else { fmEnd = i; break; }
        }
      }
      if (fmStart === -1 || fmEnd === -1) return [];
      const fmLines = lines.slice(fmStart + 1, fmEnd);
      // Find 'tools:' line
      const toolsIdx = fmLines.findIndex((l) => /^tools:/.test(l));
      if (toolsIdx === -1) return [];
      const toolsLine = fmLines[toolsIdx];
      const inlineValue = toolsLine.replace(/^tools:\s*/, '').trim();
      if (inlineValue) {
        // Inline CSV format: "tools: Read, Write, ..."
        return inlineValue.split(',').map((t) => t.trim()).filter(Boolean);
      }
      // Block sequence format: next lines starting with "  - ..."
      const tools = [];
      for (let i = toolsIdx + 1; i < fmLines.length; i++) {
        const m = fmLines[i].match(/^\s+-\s+(\S.*)/);
        if (!m) break; // end of block list
        tools.push(m[1].trim());
      }
      return tools;
    }

    const failures = [];
    for (const agentName of CONSUMER_AGENTS) {
      const agentPath = path.join(AGENTS_DIR, agentName + '.md');
      assert.ok(fs.existsSync(agentPath), `Agent file not found: ${agentPath}`);
      const content = fs.readFileSync(agentPath, 'utf8');
      const toolsList = extractTools(content);
      if (!toolsList.includes('Skill')) {
        failures.push(`${agentName}: tools=[${toolsList.join(', ')}] — missing Skill`);
      }
    }
    assert.deepStrictEqual(
      failures,
      [],
      `These consumer agents are missing "Skill" in their tools frontmatter:\n${failures.join('\n')}`
    );
  });

  test('grant: exact set of agents with Skill equals the 22 consumers (drift guard)', () => {
    // This test asserts that the SET of agents declaring Skill in their frontmatter
    // tools: field is EXACTLY the 22 known consumers — no more, no less.
    //
    // If a new agent legitimately needs Skill outside this set, add it to
    // KNOWN_SKILL_AGENTS with a comment explaining why.
    //
    // Empirically verified 2026-06-14: no agent outside the 22 consumers declares
    // Skill in its frontmatter tools: — KNOWN_SKILL_AGENTS is the 22 consumers only.
    const KNOWN_SKILL_AGENTS = new Set([
      // ── 22 agent_skills consumers (spawn child agents + inject skill context) ──
      'gsd-advisor-researcher',
      'gsd-assumptions-analyzer',
      'gsd-code-fixer',
      'gsd-code-reviewer',
      'gsd-codebase-mapper',
      'gsd-debugger',
      'gsd-doc-writer',
      'gsd-eval-auditor',
      'gsd-executor',
      'gsd-integration-checker',
      'gsd-nyquist-auditor',
      'gsd-phase-researcher',
      'gsd-plan-checker',
      'gsd-planner',
      'gsd-project-researcher',
      'gsd-research-synthesizer',
      'gsd-roadmapper',
      'gsd-security-auditor',
      'gsd-ui-auditor',
      'gsd-ui-checker',
      'gsd-ui-researcher',
      'gsd-verifier',
    ]);

    // allow-test-rule: source-text-is-the-product (#1243)
    const AGENTS_DIR = path.join(__dirname, '..', 'agents');
    const agentFiles = fs.readdirSync(AGENTS_DIR).filter((f) => f.startsWith('gsd-') && f.endsWith('.md'));

    /**
     * Extract tool names from an agent file's frontmatter (same logic as above).
     * Handles both inline CSV and YAML block-sequence forms.
     */
    function extractToolsForDriftGuard(content) {
      const lines = content.split('\n');
      let fmStart = -1, fmEnd = -1;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '---') {
          if (fmStart === -1) fmStart = i;
          else { fmEnd = i; break; }
        }
      }
      if (fmStart === -1 || fmEnd === -1) return [];
      const fmLines = lines.slice(fmStart + 1, fmEnd);
      const toolsIdx = fmLines.findIndex((l) => /^tools:/.test(l));
      if (toolsIdx === -1) return [];
      const toolsLine = fmLines[toolsIdx];
      const inlineValue = toolsLine.replace(/^tools:\s*/, '').trim();
      if (inlineValue) return inlineValue.split(',').map((t) => t.trim()).filter(Boolean);
      const tools = [];
      for (let i = toolsIdx + 1; i < fmLines.length; i++) {
        const m = fmLines[i].match(/^\s+-\s+(\S.*)/);
        if (!m) break;
        tools.push(m[1].trim());
      }
      return tools;
    }

    // Collect actual set of agents with Skill in frontmatter
    const actualSkillSet = new Set();
    for (const file of agentFiles) {
      const name = file.replace('.md', '');
      const content = fs.readFileSync(path.join(AGENTS_DIR, file), 'utf8');
      const tools = extractToolsForDriftGuard(content);
      if (tools.includes('Skill')) actualSkillSet.add(name);
    }

    // 1. Every consumer MUST have Skill
    const missingSkill = [];
    for (const agent of KNOWN_SKILL_AGENTS) {
      if (!actualSkillSet.has(agent)) missingSkill.push(agent);
    }
    assert.deepStrictEqual(
      missingSkill,
      [],
      `These consumer agents are MISSING "Skill" in their tools frontmatter:\n${missingSkill.join('\n')}`
    );

    // 2. The actual skill set must EQUAL the known set exactly (no extras)
    const unexpectedSkill = [];
    for (const agent of actualSkillSet) {
      if (!KNOWN_SKILL_AGENTS.has(agent)) unexpectedSkill.push(agent);
    }
    assert.deepStrictEqual(
      unexpectedSkill,
      [],
      `These agents declare "Skill" but are NOT in KNOWN_SKILL_AGENTS:\n${unexpectedSkill.join('\n')}\nIf this is intentional, add the agent to KNOWN_SKILL_AGENTS with a comment.`
    );
  });
});

// ─── Resolution Provenance diagnostics (#1415 / #1366) ────────────────────────
//
// Verifies that cmdAgentSkills uses findProjectRoot (cwd-drift anchor) and
// loadConfigResolved (provenance-aware config loading), and that the --json IR
// includes the new fields: configured, reason, source, degraded.

describe('agent-skills — Resolution Provenance (#1415)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('--json IR includes configured, reason, source, degraded fields', () => {
    // Minimal smoke: just the field presence
    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.ok('configured' in r.ir, 'IR must include "configured" field');
    assert.ok('reason' in r.ir, 'IR must include "reason" field');
    assert.ok('source' in r.ir, 'IR must include "source" field');
    assert.ok('degraded' in r.ir, 'IR must include "degraded" field');
  });

  test('not_configured: agent not in map → configured:false, reason:not_configured, no stderr warning', () => {
    writeConfig(tmpDir, {
      agent_skills: { 'gsd-executor': ['skills/foo'] },
    });
    const r = runGsdToolsWithStderr(['agent-skills', '--json', 'gsd-planner'], tmpDir, {
      HOME: tmpDir,
      USERPROFILE: tmpDir,
    });
    assert.ok(r.success, `Command failed: ${r.stderr}`);
    const ir = JSON.parse(r.stdout);
    assert.strictEqual(ir.configured, false);
    assert.strictEqual(ir.reason, 'not_configured');
    // No warning on stderr for not_configured
    assert.ok(
      !r.stderr.includes('WARNING'),
      `Should NOT emit WARNING for not_configured agent, got stderr: ${r.stderr}`,
    );
  });

  test('configured_empty: agent_skills[X]=[] → configured:true, reason:configured_empty, stderr WARNING, skills_count:0', () => {
    writeConfig(tmpDir, {
      agent_skills: { 'gsd-executor': [] },
    });
    const r = runGsdToolsWithStderr(['agent-skills', '--json', 'gsd-executor'], tmpDir, {
      HOME: tmpDir,
      USERPROFILE: tmpDir,
    });
    assert.ok(r.success, `Command failed: ${r.stderr}`);
    const ir = JSON.parse(r.stdout);
    assert.strictEqual(ir.configured, true);
    assert.strictEqual(ir.reason, 'configured_empty');
    assert.strictEqual(ir.skills_count, 0);
    assert.strictEqual(ir.block, '');
    assert.ok(
      r.stderr.includes('WARNING') || r.stderr.toLowerCase().includes('warning'),
      `Should emit WARNING for configured_empty, got stderr: ${r.stderr}`,
    );
  });

  test('configured_unresolved: configured path that does not exist → reason:configured_unresolved, stderr WARNING', () => {
    writeConfig(tmpDir, {
      agent_skills: { 'gsd-executor': ['skills/nonexistent-1415'] },
    });
    const r = runGsdToolsWithStderr(['agent-skills', '--json', 'gsd-executor'], tmpDir, {
      HOME: tmpDir,
      USERPROFILE: tmpDir,
    });
    assert.ok(r.success, `Command failed: ${r.stderr}`);
    const ir = JSON.parse(r.stdout);
    assert.strictEqual(ir.configured, true);
    assert.strictEqual(ir.reason, 'configured_unresolved');
    assert.strictEqual(ir.block, '');
    assert.ok(
      r.stderr.includes('WARNING') || r.stderr.toLowerCase().includes('warning'),
      `Should emit WARNING for configured_unresolved, got stderr: ${r.stderr}`,
    );
  });

  test('resolved: valid configured path → configured:true, reason:resolved, block non-empty', () => {
    const skillDir = path.join(tmpDir, 'skills', 'my-skill-1415');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# My Skill\n');
    writeConfig(tmpDir, {
      agent_skills: { 'gsd-executor': ['skills/my-skill-1415'] },
    });
    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.configured, true);
    assert.strictEqual(r.ir.reason, 'resolved');
    assert.ok(r.ir.block.includes('<agent_skills>'), 'block must be non-empty for resolved');
  });

  test('cwd-drift: invoking from descendant subdir resolves config from project root', () => {
    const skillDir = path.join(tmpDir, 'skills', 'drift-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Drift Skill\n');
    writeConfig(tmpDir, {
      agent_skills: { 'gsd-executor': ['skills/drift-skill'] },
    });
    // Invoke from a descendant subdirectory
    const deepDir = path.join(tmpDir, 'src', 'feature');
    fs.mkdirSync(deepDir, { recursive: true });
    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], deepDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.configured, true);
    assert.strictEqual(r.ir.reason, 'resolved');
    assert.ok(r.ir.block.includes('<agent_skills>'), `block must be non-empty for drift test, got: ${r.ir.block}`);
  });

  test('source field matches config provenance (root when config.json present)', () => {
    writeConfig(tmpDir, {
      agent_skills: { 'gsd-executor': [] },
    });
    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.strictEqual(r.ir.source, 'root');
    assert.strictEqual(r.ir.degraded, false);
  });

  test('Fix 3: agent_skills[X]="" (empty string) → configured_empty, skills_count:0, stderr WARNING', () => {
    writeConfig(tmpDir, {
      agent_skills: { 'gsd-executor': '' },
    });
    const r = runGsdToolsWithStderr(['agent-skills', '--json', 'gsd-executor'], tmpDir, {
      HOME: tmpDir,
      USERPROFILE: tmpDir,
    });
    assert.ok(r.success, `Command failed: ${r.stderr}`);
    const ir = JSON.parse(r.stdout);
    assert.strictEqual(ir.configured, true, 'should be configured');
    assert.strictEqual(ir.reason, 'configured_empty',
      `empty string must yield configured_empty, got: ${ir.reason}`);
    assert.strictEqual(ir.skills_count, 0, 'skills_count must be 0 for empty string');
    assert.strictEqual(ir.block, '', 'block must be empty');
    assert.ok(
      r.stderr.includes('WARNING') || r.stderr.toLowerCase().includes('warning'),
      `Should emit WARNING for empty-string configured_empty, got stderr: ${r.stderr}`,
    );
  });

  // ─── Resolution Convention P3 (#1416) ────────────────────────────────────────
  // The --json IR gains an additive `value: { block, skills_count }` field
  // (Resolution<AgentSkillsValue> envelope). All existing flat fields are retained
  // for back-compat. RED: value field absent before build; GREEN: after build:lib.

  test('P3 (#1416): --json IR includes value.block and value.skills_count matching flat fields (back-compat)', () => {
    const skillDir = path.join(tmpDir, 'skills', 'p3-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# P3 Skill\n');
    writeConfig(tmpDir, {
      agent_skills: { 'gsd-executor': ['skills/p3-skill'] },
    });
    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);

    // value field must exist and be an object
    assert.ok(r.ir.value !== undefined && r.ir.value !== null, 'ir.value must be present (Resolution<AgentSkillsValue>)');
    assert.strictEqual(typeof r.ir.value, 'object', 'ir.value must be an object');

    // value.block must match flat block
    assert.strictEqual(r.ir.value.block, r.ir.block, 'value.block must match flat block field');
    assert.ok(r.ir.value.block.includes('<agent_skills>'), 'value.block must contain <agent_skills>');

    // value.skills_count must match flat skills_count
    assert.strictEqual(r.ir.value.skills_count, r.ir.skills_count, 'value.skills_count must match flat skills_count field');
    assert.strictEqual(r.ir.value.skills_count, 1, 'value.skills_count must be 1 for one configured path');

    // All existing flat fields must still be present (back-compat)
    assert.strictEqual(typeof r.ir.agent_type, 'string', 'flat agent_type must still be present');
    assert.strictEqual(typeof r.ir.block, 'string', 'flat block must still be present');
    assert.strictEqual(typeof r.ir.skills_count, 'number', 'flat skills_count must still be present');
    assert.ok(Array.isArray(r.ir.warnings), 'flat warnings must still be present');
    assert.strictEqual(typeof r.ir.configured, 'boolean', 'flat configured must still be present');
    assert.strictEqual(typeof r.ir.reason, 'string', 'flat reason must still be present');
    assert.ok('source' in r.ir, 'flat source must still be present');
    assert.ok('degraded' in r.ir, 'flat degraded must still be present');
  });

  test('P3 (#1416): value.block and value.skills_count are consistent when unconfigured', () => {
    // No config → not_configured; value must still be present with empty block and 0 count
    const r = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir);
    assert.ok(r.success, `Command failed: ${r.error}`);
    assert.ok(r.ir.value !== undefined, 'ir.value must be present even when unconfigured');
    assert.strictEqual(r.ir.value.block, r.ir.block, 'value.block must match flat block (empty)');
    assert.strictEqual(r.ir.value.skills_count, r.ir.skills_count, 'value.skills_count must match flat skills_count (0)');
    assert.strictEqual(r.ir.value.block, '', 'value.block must be empty when unconfigured');
    assert.strictEqual(r.ir.value.skills_count, 0, 'value.skills_count must be 0 when unconfigured');
  });
});

describe('#1400 regression: plain agent-skills output survives pipe/file stdout', () => {
  // The plain (non---json) path previously did process.stdout.write(block)
  // immediately followed by process.exit(0). When stdout is a pipe or file
  // (how workflows consume it via `$(gsd_run query agent-skills <type>)`)
  // rather than a TTY, process.exit() tears the process down before Node
  // flushes the async stdout buffer — on Windows that reliably truncates the
  // write to 0 bytes, so every ${AGENT_SKILLS_*} substitution expands empty.
  // The fix routes the plain path through the same synchronous-flush output()
  // helper the --json branch uses. These tests capture stdout via a real file
  // descriptor (not a TTY) and assert the block arrives intact.
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempProject();
    const skillDir = path.join(tmpDir, 'skills', 'test-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Test Skill\n');
    writeConfig(tmpDir, {
      agent_skills: {
        'gsd-executor': ['skills/test-skill'],
      },
    });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  // Run the plain path with stdout redirected to a real file descriptor
  // (the truncation-prone case), then read the file back.
  function runPlainToFile(agentType) {
    const outPath = path.join(tmpDir, 'agent-skills.out');
    const fd = fs.openSync(outPath, 'w');
    try {
      const result = spawnSync(
        process.execPath,
        [TOOLS_PATH, 'query', 'agent-skills', agentType],
        {
          cwd: tmpDir,
          env: { ...process.env, ...TEST_ENV_BASE, HOME: tmpDir, USERPROFILE: tmpDir },
          stdio: ['ignore', fd, 'pipe'],
        },
      );
      return { status: result.status, contents: fs.readFileSync(outPath, 'utf-8') };
    } finally {
      fs.closeSync(fd);
    }
  }

  test('writes the full block to a redirected file (non-empty, not truncated)', () => {
    const { status, contents } = runPlainToFile('gsd-executor');
    assert.strictEqual(status, 0, 'command must exit 0');
    assert.ok(contents.length > 0, 'redirected file must not be empty (exit-before-flush truncation)');
    assert.ok(contents.includes('<agent_skills>'), `file must contain opening tag, got: ${JSON.stringify(contents)}`);
    assert.ok(contents.includes('</agent_skills>'), 'file must contain closing tag');
    assert.ok(contents.includes('skills/test-skill/SKILL.md'), 'file must contain the configured skill path');
  });

  test('plain file output equals the --json .block content byte-for-byte', () => {
    const { contents } = runPlainToFile('gsd-executor');
    const jsonResult = runAgentSkillsJson(['agent-skills', 'gsd-executor'], tmpDir, {
      HOME: tmpDir,
      USERPROFILE: tmpDir,
    });
    assert.ok(jsonResult.success, `--json command failed: ${jsonResult.error}`);
    assert.strictEqual(
      contents,
      jsonResult.ir.block,
      'plain stdout block must match the --json .block exactly',
    );
    assert.ok(contents.length > 0, 'block must be non-empty for a configured agent');
  });

  // RULESET.TESTS.boundary-coverage — at/over the OS pipe-buffer limit.
  // The earlier tests use a ~95-byte block; this one drives a payload well past
  // the ~64 KB pipe buffer through a pipe. The pre-fix `process.stdout.write +
  // process.exit(0)` emitted only the first ~64 KB before the process tore down;
  // writeAllSync's offset loop instead writes every byte synchronously, however
  // the OS chooses to chunk a write that large. (This is an integration check on
  // the boundary, not a forced-partial-write unit test — depending on the host,
  // a single writeSync may still drain the whole buffer.)
  test('writes a >64 KB block through a pipe without truncation (pipe-buffer boundary)', () => {
    const PIPE_BUFFER = 64 * 1024;
    // Each resolved skill adds one `- @<path>/SKILL.md` line. Keep each path
    // component short (Windows MAX_PATH safety) and use many skills to clear the
    // pipe buffer comfortably (~80 KB).
    const filler = 'p'.repeat(60);
    const skillPaths = [];
    for (let i = 0; i < 900; i++) {
      const rel = path.join('skills', `skill-${String(i).padStart(4, '0')}-${filler}`);
      fs.mkdirSync(path.join(tmpDir, rel), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, rel, 'SKILL.md'), '# s\n');
      skillPaths.push(rel.split(path.sep).join('/')); // POSIX form for config
    }
    writeConfig(tmpDir, { agent_skills: { 'gsd-executor': skillPaths } });

    // stdout to a pipe (the truncation-prone case the bug is about), captured
    // by spawnSync — proves writeAllSync drained every byte before exit.
    const result = spawnSync(
      process.execPath,
      [TOOLS_PATH, 'query', 'agent-skills', 'gsd-executor'],
      {
        cwd: tmpDir,
        encoding: 'utf-8',
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, ...TEST_ENV_BASE, HOME: tmpDir, USERPROFILE: tmpDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const out = result.stdout || '';
    assert.strictEqual(result.status, 0, `command must exit 0; stderr=${result.stderr}`);
    assert.ok(
      Buffer.byteLength(out, 'utf-8') > PIPE_BUFFER,
      `block must exceed the ${PIPE_BUFFER}-byte pipe buffer to exercise partial writes (got ${Buffer.byteLength(out, 'utf-8')} bytes)`,
    );
    // No head/tail truncation, and both the first and last configured skills
    // present — a partial-write bug would drop the tail (or everything).
    assert.ok(out.trim().startsWith('<agent_skills>'), 'block must start with the opening tag');
    assert.ok(out.trim().endsWith('</agent_skills>'), 'block must end with the closing tag (no tail truncation)');
    assert.ok(out.includes(`- @${skillPaths[0]}/SKILL.md`), 'first skill ref must be present');
    assert.ok(out.includes(`- @${skillPaths[skillPaths.length - 1]}/SKILL.md`), 'last skill ref must be present');
  });
});
