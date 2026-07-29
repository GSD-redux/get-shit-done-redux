'use strict';
/**
 * Consolidated tests for the Runtime Artifact Layout Module (ADR-3660) — layout seam.
 *
 * Covers:
 *   - resolveRuntimeArtifactLayout — structural shape per runtime
 *   - resolveRuntimeArtifactLayout edge-cases (error paths, invalid input)
 *   - kind.stage() invocations per kind type
 *
 * Sources consolidated (3 files deleted):
 *   tests/runtime-artifact-layout-resolve.test.cjs
 *   tests/runtime-artifact-layout-edge-cases.test.cjs
 *   tests/runtime-artifact-layout-stage.test.cjs
 *
 * See also:
 *   runtime-artifact-layout-surface.test.cjs       — surface seam
 *   runtime-artifact-layout-install-profiles.test.cjs — install-profiles seam
 */

const { test, describe, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { resolveRuntimeArtifactLayout, findInstallSourceRoot } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
const installProfiles = require('../gsd-core/bin/lib/install-profiles.cjs');
const { install } = require('../bin/install.js');
const { createTempDir, cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.join(__dirname, '..');

const FAKE_DIR = '/tmp/fake-config-dir';

// ─── resolveRuntimeArtifactLayout — structural shape ────────────────────────

describe('resolveRuntimeArtifactLayout — claude local', () => {
  test('returns correct layout for claude scope=local', () => {
    const layout = resolveRuntimeArtifactLayout('claude', FAKE_DIR, 'local');
    assert.strictEqual(layout.runtime, 'claude');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 2);
    assert.strictEqual(layout.kinds[0].kind, 'commands');
    assert.strictEqual(layout.kinds[0].destSubpath, 'commands'); // #1367: flat gsd-<cmd>.md layout
    assert.strictEqual(layout.kinds[0].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[0].stage, 'function');
    assert.strictEqual(layout.kinds[1].kind, 'agents');
    assert.strictEqual(layout.kinds[1].destSubpath, 'agents');
    assert.strictEqual(layout.kinds[1].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[1].stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — claude global', () => {
  test('returns correct layout for claude scope=global', () => {
    const layout = resolveRuntimeArtifactLayout('claude', FAKE_DIR, 'global');
    assert.strictEqual(layout.runtime, 'claude');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 1);
    assert.strictEqual(layout.kinds[0].kind, 'skills');
    assert.strictEqual(layout.kinds[0].destSubpath, 'skills');
    assert.strictEqual(layout.kinds[0].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[0].stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — cursor', () => {
  test('returns correct layout for cursor — skills + commands + agents kinds (#785, ADR-1235)', () => {
    const layout = resolveRuntimeArtifactLayout('cursor', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'cursor');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 3);

    const skillsKind = layout.kinds.find(k => k.kind === 'skills');
    assert.ok(skillsKind, 'must have a skills kind');
    assert.strictEqual(skillsKind.destSubpath, 'skills');
    assert.strictEqual(skillsKind.prefix, 'gsd-');
    assert.strictEqual(typeof skillsKind.stage, 'function');

    const commandsKind = layout.kinds.find(k => k.kind === 'commands');
    assert.ok(commandsKind, 'must have a commands kind (#785 Cursor 1.6 slash commands)');
    assert.strictEqual(commandsKind.destSubpath, 'commands');
    assert.strictEqual(commandsKind.prefix, 'gsd-');
    assert.strictEqual(typeof commandsKind.stage, 'function');

    const agentsKind = layout.kinds.find(k => k.kind === 'agents');
    assert.ok(agentsKind, 'must have an agents kind (ADR-1235 §1 descriptor cutover)');
    assert.strictEqual(agentsKind.destSubpath, 'agents');
    assert.strictEqual(agentsKind.prefix, 'gsd-');
    assert.strictEqual(typeof agentsKind.stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — codex', () => {
  test('returns correct layout for codex', () => {
    const layout = resolveRuntimeArtifactLayout('codex', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'codex');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 1);
    assert.strictEqual(layout.kinds[0].kind, 'skills');
    assert.strictEqual(layout.kinds[0].destSubpath, 'skills');
    assert.strictEqual(layout.kinds[0].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[0].stage, 'function');
  });

  test('#2429: codex local scope does not set $HOME/.agents skills home override', () => {
    const layout = resolveRuntimeArtifactLayout('codex', FAKE_DIR, 'local');
    const skills = layout.kinds.find(k => k.kind === 'skills');
    assert.ok(skills, 'codex local must have a skills kind');
    assert.strictEqual(skills.home, undefined,
      'codex local skills must NOT have a home override (would redirect to $HOME/.agents instead of project-local)');
  });

  test('#2429: codex global scope DOES set $HOME/.agents skills home override', () => {
    const layout = resolveRuntimeArtifactLayout('codex', FAKE_DIR, 'global');
    const skills = layout.kinds.find(k => k.kind === 'skills');
    assert.ok(skills, 'codex global must have a skills kind');
    assert.ok(typeof skills.home === 'string' && skills.home.length > 0,
      'codex global skills MUST have a home override ($HOME/.agents)');
    assert.ok(skills.home.includes('.agents'),
      'codex global skills home should point to .agents directory');
  });
});

describe('resolveRuntimeArtifactLayout — copilot', () => {
  test('returns correct layout for copilot', () => {
    const layout = resolveRuntimeArtifactLayout('copilot', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'copilot');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    // #1575: agents kind added (copilot cutover)
    assert.strictEqual(layout.kinds.length, 2);
    assert.strictEqual(layout.kinds[0].kind, 'skills');
    assert.strictEqual(layout.kinds[0].destSubpath, 'skills');
    assert.strictEqual(layout.kinds[0].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[0].stage, 'function');
    assert.strictEqual(layout.kinds[1].kind, 'agents');
    assert.strictEqual(layout.kinds[1].destSubpath, 'agents');
    assert.strictEqual(layout.kinds[1].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[1].stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — antigravity', () => {
  test('returns correct layout for antigravity', () => {
    const layout = resolveRuntimeArtifactLayout('antigravity', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'antigravity');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    // #1575: agents kind added (antigravity cutover)
    assert.strictEqual(layout.kinds.length, 2);
    assert.strictEqual(layout.kinds[0].kind, 'skills');
    assert.strictEqual(layout.kinds[0].destSubpath, 'skills');
    assert.strictEqual(layout.kinds[0].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[0].stage, 'function');
    assert.strictEqual(layout.kinds[1].kind, 'agents');
    assert.strictEqual(layout.kinds[1].destSubpath, 'agents');
    assert.strictEqual(layout.kinds[1].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[1].stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — windsurf', () => {
  test('returns local workflow + agents layout for windsurf (ADR-1235)', () => {
    const layout = resolveRuntimeArtifactLayout('windsurf', FAKE_DIR, 'local');
    assert.strictEqual(layout.runtime, 'windsurf');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 2);

    const commandsKind = layout.kinds.find(k => k.kind === 'commands');
    assert.ok(commandsKind, 'must have a commands/workflows kind');
    assert.strictEqual(commandsKind.destSubpath, 'workflows');
    assert.strictEqual(commandsKind.prefix, 'gsd-');
    assert.strictEqual(typeof commandsKind.stage, 'function');

    const agentsKind = layout.kinds.find(k => k.kind === 'agents');
    assert.ok(agentsKind, 'must have an agents kind (ADR-1235 §1 descriptor cutover)');
    assert.strictEqual(agentsKind.destSubpath, 'agents');
    assert.strictEqual(agentsKind.prefix, 'gsd-');
    assert.strictEqual(typeof agentsKind.stage, 'function');
  });

  test('returns agents-only global layout for windsurf (ADR-1235)', () => {
    const layout = resolveRuntimeArtifactLayout('windsurf', FAKE_DIR, 'global');
    assert.strictEqual(layout.runtime, 'windsurf');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 1);

    const agentsKind = layout.kinds.find(k => k.kind === 'agents');
    assert.ok(agentsKind, 'global windsurf must have agents kind (ADR-1235 §1)');
    assert.strictEqual(agentsKind.destSubpath, 'agents');
    assert.strictEqual(agentsKind.prefix, 'gsd-');
    assert.strictEqual(typeof agentsKind.stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — augment', () => {
  test('returns correct layout for augment (commands + skills + agents — ADR-1235)', () => {
    const layout = resolveRuntimeArtifactLayout('augment', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'augment');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 3);

    const commandsKind = layout.kinds.find(k => k.kind === 'commands');
    assert.ok(commandsKind, 'must have a commands kind');
    assert.strictEqual(commandsKind.destSubpath, 'commands');
    assert.strictEqual(commandsKind.prefix, 'gsd-');
    assert.strictEqual(typeof commandsKind.stage, 'function');

    const skillsKind = layout.kinds.find(k => k.kind === 'skills');
    assert.ok(skillsKind, 'must have a skills kind');
    assert.strictEqual(skillsKind.destSubpath, 'skills');
    assert.strictEqual(skillsKind.prefix, 'gsd-');
    assert.strictEqual(typeof skillsKind.stage, 'function');

    const agentsKind = layout.kinds.find(k => k.kind === 'agents');
    assert.ok(agentsKind, 'must have an agents kind (ADR-1235 §1 descriptor cutover)');
    assert.strictEqual(agentsKind.destSubpath, 'agents');
    assert.strictEqual(agentsKind.prefix, 'gsd-');
    assert.strictEqual(typeof agentsKind.stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — trae', () => {
  test('returns correct layout for trae (skills + agents — ADR-1235)', () => {
    const layout = resolveRuntimeArtifactLayout('trae', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'trae');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 2);

    const skillsKind = layout.kinds.find(k => k.kind === 'skills');
    assert.ok(skillsKind, 'must have a skills kind');
    assert.strictEqual(skillsKind.destSubpath, 'skills');
    assert.strictEqual(skillsKind.prefix, 'gsd-');
    assert.strictEqual(typeof skillsKind.stage, 'function');

    const agentsKind = layout.kinds.find(k => k.kind === 'agents');
    assert.ok(agentsKind, 'must have an agents kind (ADR-1235 §1 descriptor cutover)');
    assert.strictEqual(agentsKind.destSubpath, 'agents');
    assert.strictEqual(agentsKind.prefix, 'gsd-');
    assert.strictEqual(typeof agentsKind.stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — qwen', () => {
  test('returns correct layout for qwen (skills + agents — #2092 Phase B Upgrade 1)', () => {
    const layout = resolveRuntimeArtifactLayout('qwen', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'qwen');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 2);

    const skillsKind = layout.kinds.find(k => k.kind === 'skills');
    assert.ok(skillsKind, 'must have a skills kind');
    assert.strictEqual(skillsKind.destSubpath, 'skills');
    assert.strictEqual(skillsKind.prefix, 'gsd-');
    assert.strictEqual(typeof skillsKind.stage, 'function');

    const agentsKind = layout.kinds.find(k => k.kind === 'agents');
    assert.ok(agentsKind, 'must have an agents kind (#2092 Phase B Upgrade 1 — native .qwen/agents/*.md subagent projection)');
    assert.strictEqual(agentsKind.destSubpath, 'agents');
    assert.strictEqual(agentsKind.prefix, 'gsd-');
    assert.strictEqual(typeof agentsKind.stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — kimi', () => {
  test('returns global skills layout and guarded empty local layout for kimi', () => {
    const globalLayout = resolveRuntimeArtifactLayout('kimi', FAKE_DIR, 'global');
    assert.strictEqual(globalLayout.runtime, 'kimi');
    assert.strictEqual(globalLayout.configDir, FAKE_DIR);
    assert.strictEqual(globalLayout.kinds.length, 2);
    assert.strictEqual(globalLayout.kinds[0].kind, 'skills');
    assert.strictEqual(globalLayout.kinds[0].destSubpath, 'skills');
    assert.strictEqual(globalLayout.kinds[0].prefix, 'gsd-');
    assert.strictEqual(typeof globalLayout.kinds[0].stage, 'function');
    assert.strictEqual(globalLayout.kinds[1].kind, 'kimi-agents');
    assert.strictEqual(globalLayout.kinds[1].destSubpath, 'agents');
    assert.strictEqual(globalLayout.kinds[1].prefix, 'gsd');
    assert.strictEqual(typeof globalLayout.kinds[1].stage, 'function');

    const localLayout = resolveRuntimeArtifactLayout('kimi', FAKE_DIR, 'local');
    assert.strictEqual(localLayout.runtime, 'kimi');
    assert.strictEqual(localLayout.configDir, FAKE_DIR);
    assert.deepStrictEqual(localLayout.kinds, []);
  });
});

describe('resolveRuntimeArtifactLayout — hermes', () => {
  test('returns correct layout for hermes', () => {
    const layout = resolveRuntimeArtifactLayout('hermes', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'hermes');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 1);
    assert.strictEqual(layout.kinds[0].kind, 'skills');
    assert.strictEqual(layout.kinds[0].destSubpath, 'skills/gsd');
    assert.strictEqual(layout.kinds[0].prefix, 'gsd-'); // #947: restored canonical prefix
    assert.strictEqual(typeof layout.kinds[0].stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — codebuddy', () => {
  test('returns correct layout for codebuddy (commands + skills + agents — #789, ADR-1235)', () => {
    const layout = resolveRuntimeArtifactLayout('codebuddy', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'codebuddy');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 3);

    const commandsKind = layout.kinds.find(k => k.kind === 'commands');
    assert.ok(commandsKind, 'must have a commands kind');
    assert.strictEqual(commandsKind.destSubpath, 'commands');
    assert.strictEqual(commandsKind.prefix, 'gsd-');
    assert.strictEqual(typeof commandsKind.stage, 'function');

    const skillsKind = layout.kinds.find(k => k.kind === 'skills');
    assert.ok(skillsKind, 'must have a skills kind');
    assert.strictEqual(skillsKind.destSubpath, 'skills');
    assert.strictEqual(skillsKind.prefix, 'gsd-');
    assert.strictEqual(typeof skillsKind.stage, 'function');

    const agentsKind = layout.kinds.find(k => k.kind === 'agents');
    assert.ok(agentsKind, 'must have an agents kind (ADR-1235 §1 descriptor cutover)');
    assert.strictEqual(agentsKind.destSubpath, 'agents');
    assert.strictEqual(agentsKind.prefix, 'gsd-');
    assert.strictEqual(typeof agentsKind.stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — cline', () => {
  test('returns correct layout for cline global (skills-capable since v3.48.0 — #782)', () => {
    const layout = resolveRuntimeArtifactLayout('cline', FAKE_DIR, 'global');
    assert.strictEqual(layout.runtime, 'cline');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 1);
    assert.strictEqual(layout.kinds[0].kind, 'skills');
    assert.strictEqual(layout.kinds[0].destSubpath, 'skills');
    assert.strictEqual(layout.kinds[0].prefix, 'gsd-');
    assert.strictEqual(typeof layout.kinds[0].stage, 'function');
  });

  test('cline local: no skills kinds (global-only, #782)', () => {
    const layout = resolveRuntimeArtifactLayout('cline', FAKE_DIR, 'local');
    assert.strictEqual(layout.runtime, 'cline');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 0);
  });
});

describe('resolveRuntimeArtifactLayout — opencode', () => {
  test('returns commands + skills layout for opencode (#784)', () => {
    const layout = resolveRuntimeArtifactLayout('opencode', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'opencode');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 2);

    const commands = layout.kinds.find((k) => k.kind === 'commands');
    assert.ok(commands, 'should have a commands kind');
    // #2329: OpenCode discovers commands from the PLURAL `commands/` dir — the
    // singular `command/` made all /gsd-* commands invisible to OpenCode.
    assert.strictEqual(commands.destSubpath, 'commands');
    assert.strictEqual(commands.prefix, 'gsd-');
    assert.strictEqual(typeof commands.stage, 'function');

    const skills = layout.kinds.find((k) => k.kind === 'skills');
    assert.ok(skills, 'should have a skills kind');
    assert.strictEqual(skills.destSubpath, 'skills');
    assert.strictEqual(skills.prefix, 'gsd-');
    assert.strictEqual(typeof skills.stage, 'function');
  });
});

describe('resolveRuntimeArtifactLayout — kilo', () => {
  test('returns commands + skills layout for kilo (#784)', () => {
    const layout = resolveRuntimeArtifactLayout('kilo', FAKE_DIR);
    assert.strictEqual(layout.runtime, 'kilo');
    assert.strictEqual(layout.configDir, FAKE_DIR);
    assert.strictEqual(layout.kinds.length, 2);

    const commands = layout.kinds.find((k) => k.kind === 'commands');
    assert.ok(commands, 'should have a commands kind');
    assert.strictEqual(commands.destSubpath, 'command');
    assert.strictEqual(commands.prefix, 'gsd-');
    assert.strictEqual(typeof commands.stage, 'function');

    const skills = layout.kinds.find((k) => k.kind === 'skills');
    assert.ok(skills, 'should have a skills kind');
    assert.strictEqual(skills.destSubpath, 'skills');
    assert.strictEqual(skills.prefix, 'gsd-');
    assert.strictEqual(typeof skills.stage, 'function');
  });
});

// ─── resolveRuntimeArtifactLayout — edge-cases ──────────────────────────────

describe('resolveRuntimeArtifactLayout edge-cases', () => {
  test('hermes has destSubpath skills/gsd and gsd- prefix (#947: restored from bare-stem)', () => {
    const layout = resolveRuntimeArtifactLayout('hermes', '/tmp/x');
    assert.strictEqual(layout.kinds[0].destSubpath, 'skills/gsd');
    assert.strictEqual(layout.kinds[0].prefix, 'gsd-'); // #947: bare-stem prefix='' reversed
  });

  test('claude local has both commands and agents kinds', () => {
    const layout = resolveRuntimeArtifactLayout('claude', '/tmp/x', 'local');
    const kindNames = layout.kinds.map(k => k.kind);
    assert.ok(kindNames.includes('commands'), 'should have commands kind');
    assert.ok(kindNames.includes('agents'), 'should have agents kind');
  });

  test('cursor has both skills and commands kinds (#785)', () => {
    const layout = resolveRuntimeArtifactLayout('cursor', '/tmp/x');
    const kindNames = layout.kinds.map(k => k.kind);
    assert.ok(kindNames.includes('skills'), 'cursor must have skills kind');
    assert.ok(kindNames.includes('commands'), 'cursor must have commands kind (#785 Cursor 1.6)');
  });

  test('claude global has only skills kind', () => {
    const layout = resolveRuntimeArtifactLayout('claude', '/tmp/x', 'global');
    assert.strictEqual(layout.kinds.length, 1);
    assert.strictEqual(layout.kinds[0].kind, 'skills');
  });

  test('unknown runtime grok throws TypeError containing runtime name', () => {
    assert.throws(
      () => resolveRuntimeArtifactLayout('grok', '/tmp/x'),
      (err) => {
        assert.ok(err instanceof TypeError);
        assert.ok(err.message.includes('grok'), 'error message must contain the runtime name');
        return true;
      }
    );
  });

  test('unknown runtime xyzunknown throws TypeError', () => {
    assert.throws(
      () => resolveRuntimeArtifactLayout('xyzunknown', '/tmp/x'),
      TypeError
    );
  });

  test('empty configDir throws TypeError', () => {
    assert.throws(
      () => resolveRuntimeArtifactLayout('claude', ''),
      TypeError
    );
  });

  test('non-string configDir throws TypeError', () => {
    assert.throws(
      () => resolveRuntimeArtifactLayout('claude', null),
      TypeError
    );
  });

  test('bad scope throws TypeError', () => {
    assert.throws(
      () => resolveRuntimeArtifactLayout('claude', '/x', 'invalid'),
      TypeError
    );
  });
});

// ─── kind.stage() invocations ────────────────────────────────────────────────

const CORE_SKILLS = new Set(['help', 'phase', 'new-project']);
const CORE_AGENTS = new Set(['gsd-planner']);
const PROFILE_CORE = { skills: CORE_SKILLS, agents: CORE_AGENTS };
const PROFILE_FULL = { skills: '*', agents: new Set() };
const FAKE_STAGE_DIR = '/tmp/fake-config-dir-stage';

describe('stage — agents kind (claude local)', () => {
  test('stage returns a valid directory for the agents kind', () => {
    const layout = resolveRuntimeArtifactLayout('claude', FAKE_STAGE_DIR, 'local');
    const agentsKind = layout.kinds.find(k => k.kind === 'agents');
    assert.ok(agentsKind, 'should have an agents kind');

    const stagedDir = agentsKind.stage(PROFILE_CORE);
    assert.ok(fs.existsSync(stagedDir), 'stagedDir must exist');
    assert.ok(fs.statSync(stagedDir).isDirectory(), 'stagedDir must be a directory');
  });
});

describe('stage — skills kind (claude global)', () => {
  test('stage returns a directory containing gsd-<stem>/SKILL.md entries', () => {
    const layout = resolveRuntimeArtifactLayout('claude', FAKE_STAGE_DIR, 'global');
    const skillsKind = layout.kinds.find(k => k.kind === 'skills');
    assert.ok(skillsKind, 'should have a skills kind');

    const stagedDir = skillsKind.stage(PROFILE_CORE);
    assert.ok(fs.existsSync(stagedDir), 'stagedDir must exist');
    const entries = fs.readdirSync(stagedDir);
    for (const entry of entries) {
      assert.ok(entry.startsWith('gsd-'), `entry should start with gsd-: ${entry}`);
      const skillMd = path.join(stagedDir, entry, 'SKILL.md');
      assert.ok(fs.existsSync(skillMd), `SKILL.md must exist in ${entry}`);
    }
    assert.ok(entries.length >= 1, 'at least one skill dir should be staged');
  });

  test('stage with skills="*" produces flat layout for claude (#924: reverted from nested)', () => {
    const layout = resolveRuntimeArtifactLayout('claude', FAKE_STAGE_DIR, 'global');
    const skillsKind = layout.kinds.find(k => k.kind === 'skills');
    assert.ok(skillsKind, 'should have a skills kind');

    const stagedDir = skillsKind.stage(PROFILE_FULL);
    assert.ok(fs.existsSync(stagedDir), 'stagedDir must exist');

    // #924: Claude is reverted to FLAT. Full profile produces >= 60 top-level gsd-* dirs.
    // (Previously nested: exactly 6 gsd-ns-* router dirs. That broke Skill-tool discovery.)
    const topEntries = fs.readdirSync(stagedDir);
    assert.ok(
      topEntries.length >= 60,
      `full profile should have >= 60 top-level skill dirs (flat layout, #924), got ${topEntries.length}`,
    );
    for (const entry of topEntries) {
      assert.ok(entry.startsWith('gsd-'), `entry should start with gsd-: ${entry}`);
      // Each skill dir has its own SKILL.md at the top level.
      const skillMd = path.join(stagedDir, entry, 'SKILL.md');
      assert.ok(fs.existsSync(skillMd), `SKILL.md must exist at top level in ${entry}`);
      // No nested skills/ subdirectory: flat layout means no nesting.
      const skillsSubdir = path.join(stagedDir, entry, 'skills');
      assert.ok(!fs.existsSync(skillsSubdir), `skills/ subdir must NOT exist in ${entry} (flat layout, #924)`);
    }
  });
});

describe('stage — skills kind (kimi global)', () => {
  test('stage returns Kimi SKILL.md dirs and agent YAML/prompt artifacts', () => {
    const layout = resolveRuntimeArtifactLayout('kimi', FAKE_STAGE_DIR, 'global');
    const skillsKind = layout.kinds.find(k => k.kind === 'skills');
    assert.ok(skillsKind, 'should have a skills kind');

    const stagedDir = skillsKind.stage(PROFILE_CORE);
    assert.ok(fs.existsSync(stagedDir), 'stagedDir must exist');
    const skillMd = path.join(stagedDir, 'gsd-new-project', 'SKILL.md');
    assert.ok(fs.existsSync(skillMd), 'gsd-new-project/SKILL.md must exist');
    const content = fs.readFileSync(skillMd, 'utf8');
    assert.match(content, /^name: gsd-new-project$/m);
    assert.match(content, /\/skill:gsd-new-project/);
    assert.doesNotMatch(content, /kimi_cli\.tools|system_prompt_path|^version: 1$/m);

    const agentsKind = layout.kinds.find(k => k.kind === 'kimi-agents');
    assert.ok(agentsKind, 'should have a kimi-agents kind');

    const stagedAgentsDir = agentsKind.stage(PROFILE_FULL);
    const rootYamlPath = path.join(stagedAgentsDir, 'gsd.yaml');
    const rootPromptPath = path.join(stagedAgentsDir, 'gsd.md');
    const executorYamlPath = path.join(stagedAgentsDir, 'subagents', 'gsd-executor.yaml');
    const executorPromptPath = path.join(stagedAgentsDir, 'subagents', 'gsd-executor.md');
    assert.ok(fs.existsSync(rootYamlPath), 'agents/gsd.yaml must be staged');
    assert.ok(fs.existsSync(rootPromptPath), 'agents/gsd.md must be staged');
    assert.ok(fs.existsSync(executorYamlPath), 'agents/subagents/gsd-executor.yaml must be staged');
    assert.ok(fs.existsSync(executorPromptPath), 'agents/subagents/gsd-executor.md must be staged');

    const rootYaml = fs.readFileSync(rootYamlPath, 'utf8');
    assert.match(rootYaml, /^version: 1$/m);
    assert.match(rootYaml, /^agent:$/m);
    assert.match(rootYaml, /extend: default/);
    assert.match(rootYaml, /system_prompt_path: \.\/gsd\.md/);
    assert.match(rootYaml, /tools:/);
    assert.match(rootYaml, /subagents:/);
    assert.match(rootYaml, /kimi_cli\.tools\./);
    assert.doesNotMatch(rootYaml, /mcp__/);

    const executorYaml = fs.readFileSync(executorYamlPath, 'utf8');
    assert.match(executorYaml, /system_prompt_path: \.\/gsd-executor\.md/);
    assert.match(executorYaml, /kimi_cli\.tools\./);
    assert.doesNotMatch(executorYaml, /mcp__/);
  });

  test('tracks Kimi agent staging dir before writing artifacts', () => {
    const layout = resolveRuntimeArtifactLayout('kimi', FAKE_STAGE_DIR, 'global');
    const agentsKind = layout.kinds.find(k => k.kind === 'kimi-agents');
    assert.ok(agentsKind, 'should have a kimi-agents kind');

    const originalWriteFileSync = fs.writeFileSync;
    const before = new Set(installProfiles.STAGED_DIRS);
    let added = [];

    try {
      fs.writeFileSync = function writeFileSyncWithInjectedFailure(file, ...args) {
        const filePath = String(file);
        if (filePath.includes('gsd-kimi-agents-') && path.basename(filePath) === 'gsd.yaml') {
          throw new Error('forced Kimi stage write failure');
        }
        return originalWriteFileSync.call(this, file, ...args);
      };

      assert.throws(
        () => agentsKind.stage(PROFILE_FULL),
        /forced Kimi stage write failure/
      );

      added = [...installProfiles.STAGED_DIRS]
        .filter(dir => !before.has(dir) && path.basename(dir).startsWith('gsd-kimi-agents-'));
      assert.strictEqual(added.length, 1, 'partially written Kimi stage dir must be tracked for cleanup');
      assert.ok(fs.existsSync(added[0]), 'tracked partial Kimi stage dir should exist');
    } finally {
      fs.writeFileSync = originalWriteFileSync;
      for (const dir of added) {
        cleanup(dir);
        installProfiles.STAGED_DIRS.delete(dir);
      }
    }
  });
});

describe('stage — opencode commands kind', () => {
  test('opencode stage returns directory with .md files for selected skills', () => {
    const layout = resolveRuntimeArtifactLayout('opencode', FAKE_STAGE_DIR);
    const commandsKind = layout.kinds.find(k => k.kind === 'commands');
    assert.ok(commandsKind, 'should have a commands kind');

    const stagedDir = commandsKind.stage(PROFILE_CORE);
    assert.ok(fs.existsSync(stagedDir), 'stagedDir must exist');
    const entries = fs.readdirSync(stagedDir).filter(f => f.endsWith('.md'));
    for (const entry of entries) {
      const stem = entry.slice(0, -3);
      assert.ok(CORE_SKILLS.has(stem), `unexpected skill staged: ${stem}`);
    }
  });
});

describe('stage — opencode/kilo skills kind (#784)', () => {
  for (const runtime of ['opencode', 'kilo']) {
    test(`${runtime} skills stage writes gsd-<stem>/SKILL.md with name + description`, () => {
      const layout = resolveRuntimeArtifactLayout(runtime, FAKE_STAGE_DIR);
      const skillsKind = layout.kinds.find(k => k.kind === 'skills');
      assert.ok(skillsKind, 'should have a skills kind');

      const stagedDir = skillsKind.stage(PROFILE_CORE);
      assert.ok(fs.existsSync(stagedDir), 'stagedDir must exist');
      const entries = fs.readdirSync(stagedDir);
      assert.ok(entries.length >= 1, 'at least one skill dir should be staged');
      for (const entry of entries) {
        assert.ok(entry.startsWith('gsd-'), `entry should start with gsd-: ${entry}`);
        const skillMd = path.join(stagedDir, entry, 'SKILL.md');
        assert.ok(fs.existsSync(skillMd), `SKILL.md must exist in ${entry}`);
        const content = fs.readFileSync(skillMd, 'utf8');
        // OpenCode skill spec: name must match the dir, description required.
        assert.ok(content.startsWith('---\n'), 'SKILL.md must open with frontmatter');
        assert.match(content, new RegExp(`^name: ${entry}$`, 'm'), `name must equal dir ${entry}`);
        assert.match(content, /^description: /m, 'description frontmatter required');
        // No colon-namespace command leaks in the converted body.
        assert.ok(!/\/gsd:/.test(content), 'body must not contain /gsd: colon refs');
      }
    });
  }
});

describe('stage — cursor commands kind (#785)', () => {
  test('cursor commands kind stage returns directory with converted .md files', () => {
    const layout = resolveRuntimeArtifactLayout('cursor', FAKE_STAGE_DIR);
    const commandsKind = layout.kinds.find(k => k.kind === 'commands');
    assert.ok(commandsKind, 'cursor should have a commands kind (#785)');

    const stagedDir = commandsKind.stage(PROFILE_CORE);
    assert.ok(fs.existsSync(stagedDir), 'stagedDir must exist');

    const entries = fs.readdirSync(stagedDir).filter(f => f.endsWith('.md'));
    assert.ok(entries.length >= 1, 'at least one command file should be staged');

    // Cursor commands are plain markdown — no YAML frontmatter
    for (const entry of entries) {
      const content = fs.readFileSync(path.join(stagedDir, entry), 'utf8');
      assert.ok(!content.startsWith('---'), `${entry}: cursor commands must not start with YAML frontmatter`);
    }
  });

  test('cursor commands stage applies Cursor-specific content transforms', () => {
    const layout = resolveRuntimeArtifactLayout('cursor', FAKE_STAGE_DIR);
    const commandsKind = layout.kinds.find(k => k.kind === 'commands');
    assert.ok(commandsKind, 'cursor should have a commands kind (#785)');

    const stagedDir = commandsKind.stage(PROFILE_FULL);
    assert.ok(fs.existsSync(stagedDir), 'stagedDir must exist');

    // Verify all staged files are .md only (no subdirectory SKILL.md layout)
    const entries = fs.readdirSync(stagedDir, { withFileTypes: true });
    for (const entry of entries) {
      assert.ok(entry.isFile(), `${entry.name}: cursor commands dir must contain only flat files`);
      assert.ok(entry.name.endsWith('.md'), `${entry.name}: must be .md file`);
    }
  });
});

// ─── #1477: .gsd-source marker provisioning ───────────────────────────────────
//
// Regression for #1477: the Claude Code global skills layout ships
// gsd-core/{bin,contexts,references,templates,workflows} but no commands/gsd
// source tree, and _runLegacyUninstallCleanup removes any commands/gsd/ for that
// scope. At runtime findInstallSourceRoot's walk-up from gsd-core/bin/lib had
// nothing to find and /gsd-surface threw for every subcommand (list/status
// included); the marker reader added in #1476 never fired because nothing wrote
// the marker.
//
// Fix: bin/install.js writes <configDir>/.gsd-source pointing at a resolvable
// commands/gsd, and findInstallSourceRoot prefers that marker over its walk-up.
//
// (The original #1477 also covered a deployed-install MODULE_NOT_FOUND from the
// surface path's relative require('../../../bin/install.js'); ADR-1508 / #1511
// removed that getInstallExports relay entirely — surface.cjs now calls the
// shipped runtime-artifact-conversion sibling directly — so that half no longer
// applies and is covered by the #1511 relocation suite.)

describe('#1477 .gsd-source marker provisioning', () => {
  let tmpRoot;
  let savedHome;
  let savedUserProfile;
  let savedExplicitConfigDir;
  let savedTestMode;

  function silenceConsole(fn) {
    const orig = { log: console.log, warn: console.warn, error: console.error };
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    try {
      return fn();
    } finally {
      console.log = orig.log;
      console.warn = orig.warn;
      console.error = orig.error;
    }
  }

  // Guard against process.exit killing the runner mid-install.
  function runInstall(isGlobal, runtime) {
    const origExit = process.exit;
    let exitCalled = false;
    process.exit = (code) => {
      exitCalled = true;
      throw new Error(`process.exit(${code}) during install — should not happen`);
    };
    try {
      return silenceConsole(() => install(isGlobal, runtime));
    } catch (e) {
      if (exitCalled) assert.fail(`install() called process.exit — unexpected: ${e.message}`);
      throw e;
    } finally {
      process.exit = origExit;
    }
  }

  beforeEach(() => {
    tmpRoot = createTempDir('gsd-1477-');
    savedHome = process.env.HOME;
    // os.homedir() reads USERPROFILE on win32, HOME elsewhere; redirect both so
    // install() targets the fixture regardless of platform.
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpRoot;
    process.env.USERPROFILE = tmpRoot;
    savedExplicitConfigDir = process.env.GSD_EXPLICIT_CONFIG_DIR;
    delete process.env.GSD_EXPLICIT_CONFIG_DIR;
    savedTestMode = process.env.GSD_TEST_MODE;
    process.env.GSD_TEST_MODE = '1';
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (savedExplicitConfigDir === undefined) delete process.env.GSD_EXPLICIT_CONFIG_DIR;
    else process.env.GSD_EXPLICIT_CONFIG_DIR = savedExplicitConfigDir;
    if (savedTestMode === undefined) delete process.env.GSD_TEST_MODE;
    else process.env.GSD_TEST_MODE = savedTestMode;
    cleanup(tmpRoot);
  });

  // ── Failure 1: the installer provisions a valid marker ──────────────────────
  test('global claude install writes a .gsd-source marker pointing at a real commands/gsd', () => {
    const claudeDir = path.join(tmpRoot, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    runInstall(true /* isGlobal */, 'claude');

    const markerPath = path.join(claudeDir, '.gsd-source');
    assert.ok(fs.existsSync(markerPath), `.gsd-source marker must be written at ${markerPath}`);

    const markerSrc = fs.readFileSync(markerPath, 'utf8').trim();
    assert.ok(path.isAbsolute(markerSrc), `marker must contain an absolute path, got: ${markerSrc}`);
    assert.ok(fs.existsSync(markerSrc), `marker target must exist on disk: ${markerSrc}`);
    assert.equal(path.basename(markerSrc), 'gsd', 'marker must point at a commands/gsd directory');
    assert.equal(path.basename(path.dirname(markerSrc)), 'commands');
  });

  // ── Guard: marker is scoped to claude-global ONLY (#1477 PR-scope) ───────────
  // Locks the `runtime === 'claude' && isGlobal` write guard. Every other layout
  // (non-claude runtimes, and claude *local*) ships a commands/gsd source tree, so
  // findInstallSourceRoot's walk-up already resolves and the marker must not appear.
  function findGsdSourceMarkers(root) {
    const found = [];
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name === '.gsd-source') found.push(full);
      }
    };
    walk(root);
    return found;
  }

  test('non-claude global install writes no .gsd-source marker (locks runtime === claude)', () => {
    runInstall(true /* isGlobal */, 'cursor');
    assert.deepEqual(
      findGsdSourceMarkers(tmpRoot), [],
      'a non-claude runtime must not provision the claude-global marker',
    );
  });

  test('claude local install writes no .gsd-source marker (locks isGlobal)', () => {
    // Local installs target process.cwd()/.claude — chdir into the fixture so the
    // install is contained within tmpRoot rather than polluting the repo.
    const savedCwd = process.cwd();
    process.chdir(tmpRoot);
    try {
      runInstall(false /* isGlobal */, 'claude');
    } finally {
      process.chdir(savedCwd);
    }
    assert.deepEqual(
      findGsdSourceMarkers(tmpRoot), [],
      'a claude local install must not provision the marker — local ships commands/gsd',
    );
  });

  // ── Writer fault-injection: marker write failure is non-fatal + warns ────────
  // CONTRIBUTING.md filesystem-write QA matrix: prove the marker-writer catch
  // branch (bin/install.js) is reachable. A failed write (e.g. read-only target)
  // must not abort the install, and — because walk-up also fails on this layout —
  // must surface a diagnostic so the broken /gsd-surface is traceable.
  test('marker write failure does not abort install and warns (locks the writer catch)', () => {
    const claudeDir = path.join(tmpRoot, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    const markerPath = path.join(claudeDir, '.gsd-source');
    const realWriteFileSync = fs.writeFileSync;
    // Fault-inject ONLY the marker write; every other install write proceeds.
    mock.method(fs, 'writeFileSync', (file, ...rest) => {
      if (path.resolve(String(file)) === path.resolve(markerPath)) {
        throw new Error('EACCES: read-only target (injected)');
      }
      return realWriteFileSync(file, ...rest);
    });

    // Capture console.warn around the install (runInstall's silenceConsole would
    // otherwise swallow it); still guard process.exit.
    const warnings = [];
    const origExit = process.exit;
    const origWarn = console.warn;
    const origLog = console.log;
    process.exit = (code) => { throw new Error(`process.exit(${code}) during install`); };
    console.warn = (msg) => { warnings.push(String(msg)); };
    console.log = () => {};
    try {
      assert.doesNotThrow(() => install(true /* isGlobal */, 'claude'),
        'a marker write failure must be non-fatal — install proceeds via the catch');
    } finally {
      process.exit = origExit;
      console.warn = origWarn;
      console.log = origLog;
      mock.restoreAll();
    }

    assert.ok(!fs.existsSync(markerPath), 'the injected fault must leave no marker on disk');
    assert.ok(
      warnings.some((w) => /\.gsd-source marker/.test(w)),
      `the writer catch must warn for diagnosability; got: ${JSON.stringify(warnings)}`,
    );
  });

  // ── Failure 1 end-to-end: resolution succeeds FROM the deployed tree ─────────
  // The deployed module's __dirname is <claudeDir>/gsd-core/bin/lib, which has no
  // commands/gsd ancestor (global skills layout). Only the marker rescues it.
  test('deployed global layout resolves the source root via the marker', () => {
    const claudeDir = path.join(tmpRoot, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    runInstall(true /* isGlobal */, 'claude');

    // Sanity: the global layout genuinely ships no commands/gsd source tree.
    assert.ok(
      !fs.existsSync(path.join(claudeDir, 'commands', 'gsd')),
      'precondition: global claude install must not ship commands/gsd',
    );

    const deployedLayoutPath = path.join(claudeDir, 'gsd-core', 'bin', 'lib', 'runtime-artifact-layout.cjs');
    assert.ok(fs.existsSync(deployedLayoutPath), 'deployed runtime-artifact-layout.cjs must exist');
    delete require.cache[deployedLayoutPath];
    const deployed = require(deployedLayoutPath);

    // Negative proof that the bug condition exists: WITHOUT consulting the marker
    // (no configDir argument), walk-up from the deployed tree has nothing to find.
    assert.throws(
      () => deployed.findInstallSourceRoot(),
      /could not locate commands\/gsd/,
      'deployed walk-up must fail without the marker — this is the regression condition',
    );

    // With the marker (configDir provided), list/status resolution succeeds.
    let resolved;
    assert.doesNotThrow(() => {
      resolved = deployed.findInstallSourceRoot(claudeDir);
    }, 'findInstallSourceRoot must resolve via the .gsd-source marker');
    assert.equal(path.basename(resolved), 'gsd');
    assert.ok(fs.existsSync(resolved));
  });

  // ── Adversarial marker-reader cases (no full install needed) ─────────────────
  describe('findInstallSourceRoot marker handling', () => {
    let cfgDir;
    beforeEach(() => { cfgDir = createTempDir('gsd-1477-marker-'); });
    afterEach(() => { cleanup(cfgDir); });

    test('marker pointing at a valid commands/gsd takes precedence over walk-up', () => {
      const fakeSrc = path.join(cfgDir, 'pkg', 'commands', 'gsd');
      fs.mkdirSync(fakeSrc, { recursive: true });
      fs.writeFileSync(path.join(cfgDir, '.gsd-source'), fakeSrc + '\n', 'utf8');

      const resolved = findInstallSourceRoot(cfgDir);
      assert.equal(path.resolve(resolved), path.resolve(fakeSrc),
        'marker target must win over the repo walk-up');
    });

    test('marker pointing at a non-existent path is ignored (falls through to walk-up)', () => {
      const ghost = path.join(cfgDir, 'does', 'not', 'exist', 'commands', 'gsd');
      fs.writeFileSync(path.join(cfgDir, '.gsd-source'), ghost + '\n', 'utf8');

      const resolved = findInstallSourceRoot(cfgDir);
      assert.notEqual(path.resolve(resolved), path.resolve(ghost));
      assert.equal(path.resolve(resolved), path.resolve(REPO_ROOT, 'commands', 'gsd'));
    });

    test('empty / whitespace-only marker is ignored', () => {
      fs.writeFileSync(path.join(cfgDir, '.gsd-source'), '   \n', 'utf8');
      const resolved = findInstallSourceRoot(cfgDir);
      assert.equal(path.resolve(resolved), path.resolve(REPO_ROOT, 'commands', 'gsd'));
    });
  });
});

// ─── #2624: stale .gsd-source marker read before rewrite on upgrade ──────────
//
// Regression for #2624: a Claude-global upgrade silently installed skill content
// from the PREVIOUS version. findInstallSourceRoot prefers <configDir>/.gsd-source,
// and install() used to REWRITE that marker AFTER staging had already read it — so
// on an upgrade the marker still pointed at the prior version's source (an npx
// cache dir that still exists on disk) and every converted skill was generated from
// the OLD commands/gsd. Fix: write the marker BEFORE staging reads it.
//
// These exercise the real install(true, 'claude') with HOME redirected to a tmp dir,
// pre-seeding a STALE marker that points at a different (still-existing) source —
// the exact upgrade condition. No live npx / network.
describe('#2624 .gsd-source marker is rewritten before staging reads it', () => {
  let tmpRoot;
  let savedHome;
  let savedUserProfile;
  let savedExplicitConfigDir;
  let savedTestMode;

  // Run install() with process.exit and console output mocked via t.mock (auto-restored),
  // per CONTRIBUTING.md test rules (no manual monkeypatch / try-finally in test bodies).
  // process.exit during install is a hard failure — surface it, don't let it kill the runner.
  function runInstall(t, isGlobal, runtime) {
    t.mock.method(process, 'exit', (code) => {
      throw new Error(`process.exit(${code}) during install — should not happen`);
    });
    t.mock.method(console, 'log', () => {});
    t.mock.method(console, 'warn', () => {});
    t.mock.method(console, 'error', () => {});
    return install(isGlobal, runtime);
  }

  beforeEach(() => {
    tmpRoot = createTempDir('gsd-2624-');
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = tmpRoot;
    process.env.USERPROFILE = tmpRoot;
    savedExplicitConfigDir = process.env.GSD_EXPLICIT_CONFIG_DIR;
    delete process.env.GSD_EXPLICIT_CONFIG_DIR;
    savedTestMode = process.env.GSD_TEST_MODE;
    process.env.GSD_TEST_MODE = '1';
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (savedExplicitConfigDir === undefined) delete process.env.GSD_EXPLICIT_CONFIG_DIR;
    else process.env.GSD_EXPLICIT_CONFIG_DIR = savedExplicitConfigDir;
    if (savedTestMode === undefined) delete process.env.GSD_TEST_MODE;
    else process.env.GSD_TEST_MODE = savedTestMode;
    cleanup(tmpRoot);
  });

  // The current package's commands/gsd — what the marker MUST point at after install.
  const CURRENT_SOURCE = path.join(REPO_ROOT, 'commands', 'gsd');

  test('claude-global install overwrites a stale .gsd-source marker before staging reads it', (t) => {
    const claudeDir = path.join(tmpRoot, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });

    // Simulate the PREVIOUS install's marker: a different source dir that STILL EXISTS
    // on disk (mirroring a coexisting npx per-version cache dir). findInstallSourceRoot
    // returns this immediately if it is read before the marker is rewritten.
    const staleSource = path.join(tmpRoot, 'old-npx-cache', 'commands', 'gsd');
    fs.mkdirSync(staleSource, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, '.gsd-source'), staleSource + '\n', 'utf8');

    // Spy on findInstallSourceRoot to capture WHICH source staging actually resolves.
    // The marker ends up correct either way (the late write corrected it on the old code),
    // so the marker content alone cannot prove the ordering — the resolved-source captures
    // can. Before the fix, staging resolves the stale path; after, the current path.
    // install-engine.cjs calls runtimeArtifactLayout.findInstallSourceRoot via the module
    // object (not a captured ref), so mocking the property on the shared module instance
    // intercepts the staging call. Same pattern as tests/phase.test.cjs (capture original,
    // delegate).
    const runtimeArtifactLayout = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
    const realFindInstallSourceRoot = runtimeArtifactLayout.findInstallSourceRoot;
    const resolvedSources = [];
    t.mock.method(runtimeArtifactLayout, 'findInstallSourceRoot', function (configDir) {
      const result = realFindInstallSourceRoot.call(this, configDir);
      resolvedSources.push(path.resolve(result));
      return result;
    });

    runInstall(t, true /* isGlobal */, 'claude');

    const markerPath = path.join(claudeDir, '.gsd-source');
    assert.ok(fs.existsSync(markerPath), 'marker must exist after install');
    const finalMarker = path.resolve(fs.readFileSync(markerPath, 'utf8').trim());
    assert.equal(finalMarker, path.resolve(CURRENT_SOURCE),
      `final marker must point at the current package source, not ${finalMarker}`);

    // The decisive assertion: staging must NEVER have resolved the stale source. Before the
    // fix, at least one staging resolution returned the stale path (read before rewrite).
    const resolvedStale = resolvedSources.filter((p) => p === path.resolve(staleSource));
    assert.equal(resolvedStale.length, 0,
      `staging must not resolve the stale source during install, but did ${resolvedStale.length} time(s). ` +
      `Resolved: ${JSON.stringify(resolvedSources)}`);
  });

  test('fresh claude-global install (no prior marker) still writes the correct marker', (t) => {
    const claudeDir = path.join(tmpRoot, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    // No pre-existing marker — fresh install (negative space, must stay correct).
    runInstall(t, true /* isGlobal */, 'claude');

    const markerPath = path.join(claudeDir, '.gsd-source');
    assert.ok(fs.existsSync(markerPath), 'fresh claude-global install must write the marker');
    const resolved = fs.readFileSync(markerPath, 'utf8').trim();
    assert.equal(
      path.resolve(resolved),
      path.resolve(CURRENT_SOURCE),
      'fresh install marker must point at the current package source',
    );
  });

  test('claude-global install rewrites a marker pointing at a deleted (ghost) source', (t) => {
    const claudeDir = path.join(tmpRoot, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    // A ghost path that does NOT exist on disk — findInstallSourceRoot ignores it and
    // falls through to walk-up, then install() rewrites the marker to the current source.
    const ghost = path.join(tmpRoot, 'gone', 'commands', 'gsd');
    fs.writeFileSync(path.join(claudeDir, '.gsd-source'), ghost + '\n', 'utf8');

    runInstall(t, true /* isGlobal */, 'claude');

    const markerPath = path.join(claudeDir, '.gsd-source');
    assert.ok(fs.existsSync(markerPath), 'marker must exist after install');
    const resolved = fs.readFileSync(markerPath, 'utf8').trim();
    assert.equal(
      path.resolve(resolved),
      path.resolve(CURRENT_SOURCE),
      'ghost marker must be rewritten to the current package source',
    );
  });
});
