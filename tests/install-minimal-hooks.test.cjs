// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Installer Module — Sections 9–11 + 13.
 *
 * Covers: install-profiles unit tests (MINIMAL_SKILL_ALLOWLIST, isMinimalMode,
 * shouldInstallSkill, stageSkillsForMode, cleanupStagedSkills),
 * --minimal per-runtime E2E (spawned), --minimal manifest mode + downgrade,
 * and hooks copy / manifest / uninstall settings cleanup.
 *
 * Consolidates (original sources from #3758):
 *   install-minimal.test.cjs
 *   install-minimal-all-runtimes.test.cjs
 *   install-minimal-backcompat.test.cjs
 *   install-hooks-copy.test.cjs
 *
 * Closes #3758
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync, execFileSync } = require('node:child_process');

const { createTempDir, cleanup } = require('./helpers.cjs');

const {
  writeManifest,
  GSD_UNINSTALL_HOOKS,
} = require('../bin/install.js');

const {
  MINIMAL_SKILL_ALLOWLIST,
  PROFILES,
  isMinimalMode,
  shouldInstallSkill,
  stageSkillsForMode,
  cleanupStagedSkills,
} = require('../gsd-core/bin/lib/install-profiles.cjs');

const {
  INSTALL_SCRIPT,
  MANIFEST_NAME,
  BUILD_SCRIPT,
  HOOKS_DIST,
  EXPECTED_SH_HOOKS,
  EXPECTED_ALL_HOOKS,
  SKILL_RUNTIMES,
  walk,
  simulateHookCopy,
  installerEnv,
  runMinimalInstall,
  manifestSkillSet,
  manifestAgentCount,
  collectSkillBasenamesOnDisk,
} = require('./helpers/install-shared.cjs');

/**
 * collectSkillBasenamesOnDisk(configDir, runtime, scope) re-resolves the
 * runtime's skills-kind layout via os.homedir(). runMinimalInstall() already
 * sandboxes HOME/USERPROFILE to `root` for the spawned install subprocess,
 * but that sandboxing does not persist into this (parent) process — without
 * re-sandboxing here, Codex's skills-kind `home: ".agents"` override
 * (ADR-1239 upgrade 3, #2088) would resolve against the developer's REAL
 * $HOME/.agents/skills instead of the sandboxed install root. Sandbox
 * HOME/USERPROFILE to `root` for the synchronous duration of the on-disk scan.
 */
function collectSkillBasenamesOnDiskSandboxed(configDir, runtime, scope, root) {
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  try {
    return collectSkillBasenamesOnDisk(configDir, runtime, scope);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  }
}

// ─── Section 9: install-profiles — MINIMAL_SKILL_ALLOWLIST ───────────────────

describe('install-profiles: MINIMAL_SKILL_ALLOWLIST', () => {
  test('contains exactly the main-loop core (frozen)', () => {
    assert.deepStrictEqual(
      [...MINIMAL_SKILL_ALLOWLIST].sort(),
      ['discuss-phase', 'execute-phase', 'help', 'new-project', 'phase', 'plan-phase', 'surface', 'update'],
    );
    assert.ok(Object.isFrozen(MINIMAL_SKILL_ALLOWLIST));
  });

  test('every allowlisted skill exists in commands/gsd/', () => {
    const commandsDir = path.join(__dirname, '..', 'commands', 'gsd');
    for (const name of MINIMAL_SKILL_ALLOWLIST) {
      assert.ok(
        fs.existsSync(path.join(commandsDir, `${name}.md`)),
        `${name} is allowlisted but commands/gsd/${name}.md does not exist`,
      );
    }
  });
});

// ─── #834: --help profile skill counts must track PROFILES ───────────────────

describe('install: --help profile counts match PROFILES (#834)', () => {
  function helpText() {
    return execFileSync(process.execPath, [INSTALL_SCRIPT, '--help'], {
      encoding: 'utf8',
      env: installerEnv(),
    });
  }

  test('core line advertises PROFILES.core.length main-loop skills', () => {
    const out = helpText();
    const m = out.match(/core\s+—\s+~?(\d+)\s+main-loop skills/);
    assert.ok(m, `--help must advertise a core profile skill count; got:\n${out}`);
    assert.strictEqual(
      Number(m[1]),
      PROFILES.core.length,
      `--help core count (${m[1]}) must equal PROFILES.core.length (${PROFILES.core.length})`,
    );
  });

  test('standard line advertises PROFILES.standard.length skills', () => {
    const out = helpText();
    const m = out.match(/standard\s+—\s+~?(\d+)\s+skills/);
    assert.ok(m, `--help must advertise a standard profile skill count; got:\n${out}`);
    assert.strictEqual(
      Number(m[1]),
      PROFILES.standard.length,
      `--help standard count (${m[1]}) must equal PROFILES.standard.length (${PROFILES.standard.length})`,
    );
  });

  test('full line does not hardcode a drift-prone skill count', () => {
    const out = helpText();
    const m = out.match(/full\s+—\s+([^\n]*?)\s+\(default\)/);
    assert.ok(m, `--help must advertise a full profile line; got:\n${out}`);
    assert.doesNotMatch(
      m[1],
      /\d/,
      `--help full line must not hardcode a numeric skill count (drifts); got: "${m[1]}"`,
    );
  });
});

describe('install-profiles: isMinimalMode', () => {
  test('returns true only for "minimal"', () => {
    assert.strictEqual(isMinimalMode('minimal'), true);
    assert.strictEqual(isMinimalMode('full'), false);
    assert.strictEqual(isMinimalMode(''), false);
    assert.strictEqual(isMinimalMode(undefined), false);
    assert.strictEqual(isMinimalMode(null), false);
    assert.strictEqual(isMinimalMode('MINIMAL'), false);
  });
});

describe('install-profiles: shouldInstallSkill', () => {
  test('full mode admits every skill', () => {
    assert.strictEqual(shouldInstallSkill('plan-phase', 'full'), true);
    assert.strictEqual(shouldInstallSkill('autonomous', 'full'), true);
    assert.strictEqual(shouldInstallSkill('arbitrary-future-name', 'full'), true);
  });

  test('minimal mode admits only allowlisted skills', () => {
    for (const name of MINIMAL_SKILL_ALLOWLIST) {
      assert.strictEqual(shouldInstallSkill(name, 'minimal'), true, name);
    }
    for (const denied of ['autonomous', 'do', 'progress', 'next', 'fast', 'quick']) {
      assert.strictEqual(shouldInstallSkill(denied, 'minimal'), false, denied);
    }
  });

  test('minimal mode rejects .md-suffixed names (callers must strip)', () => {
    assert.strictEqual(shouldInstallSkill('plan-phase.md', 'minimal'), false);
  });

  test('unknown mode falls through to full behavior', () => {
    for (const unknownMode of ['compact', 'tier2', 'CORE', 'Minimal', 'mini']) {
      assert.ok(shouldInstallSkill('autonomous', unknownMode),
        `unknown mode "${unknownMode}" should admit all skills`);
    }
  });
});

describe('install-profiles: stageSkillsForMode', () => {
  function createFixtureSkillsDir() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-stage-fixture-'));
    for (const name of ['plan-phase', 'execute-phase', 'autonomous', 'do', 'help',
      'new-project', 'phase', 'discuss-phase', 'update', 'progress', 'surface']) {
      fs.writeFileSync(path.join(tmp, `${name}.md`), `# ${name}\n`);
    }
    return tmp;
  }

  test('full mode returns original src dir unchanged', () => {
    const src = createFixtureSkillsDir();
    try {
      assert.strictEqual(stageSkillsForMode(src, 'full'), src);
    } finally {
      cleanup(src);
    }
  });

  test('minimal mode returns new dir with only allowlisted skills', () => {
    const src = createFixtureSkillsDir();
    let staged;
    try {
      staged = stageSkillsForMode(src, 'minimal');
      assert.notStrictEqual(staged, src);
      assert.deepStrictEqual(
        fs.readdirSync(staged).sort(),
        ['discuss-phase.md', 'execute-phase.md', 'help.md', 'new-project.md',
          'phase.md', 'plan-phase.md', 'surface.md', 'update.md'],
      );
    } finally {
      cleanup(src);
      cleanup(staged);
    }
  });

  test('minimal mode preserves file content byte-for-byte', () => {
    const src = createFixtureSkillsDir();
    let staged;
    try {
      staged = stageSkillsForMode(src, 'minimal');
      const original = fs.readFileSync(path.join(src, 'plan-phase.md'), 'utf8');
      const copied = fs.readFileSync(path.join(staged, 'plan-phase.md'), 'utf8');
      assert.strictEqual(copied, original);
    } finally {
      cleanup(src);
      cleanup(staged);
    }
  });

  test('minimal mode against non-existent source returns source path', () => {
    const ghost = path.join(os.tmpdir(), 'gsd-stage-does-not-exist-' + Date.now());
    assert.strictEqual(stageSkillsForMode(ghost, 'minimal'), ghost);
  });

  test('minimal mode skips non-md files and subdirectories', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-stage-mixed-'));
    let staged;
    try {
      fs.writeFileSync(path.join(src, 'plan-phase.md'), '# plan\n');
      fs.writeFileSync(path.join(src, 'README.txt'), 'not a skill\n');
      fs.mkdirSync(path.join(src, 'nested-dir'));
      fs.writeFileSync(path.join(src, 'nested-dir', 'plan-phase.md'), '# nested\n');
      staged = stageSkillsForMode(src, 'minimal');
      assert.deepStrictEqual(fs.readdirSync(staged), ['plan-phase.md']);
    } finally {
      cleanup(src);
      cleanup(staged);
    }
  });
});

describe('install-profiles: cleanupStagedSkills', () => {
  test('removes staged dirs created during process', () => {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-stage-cleanup-'));
    fs.writeFileSync(path.join(src, 'plan-phase.md'), '# plan\n');
    try {
      const a = stageSkillsForMode(src, 'minimal');
      const b = stageSkillsForMode(src, 'minimal');
      assert.notStrictEqual(a, b);
      assert.ok(fs.existsSync(a));
      assert.ok(fs.existsSync(b));
      cleanupStagedSkills();
      assert.ok(!fs.existsSync(a));
      assert.ok(!fs.existsSync(b));
    } finally {
      cleanup(src);
    }
  });

  test('is idempotent', () => {
    cleanupStagedSkills();
    cleanupStagedSkills();
  });

  test('exit handler registers at most once across many calls', () => {
    cleanupStagedSkills();
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-stage-exit-handler-'));
    fs.writeFileSync(path.join(src, 'plan-phase.md'), '# plan\n');
    try {
      const before = process.listenerCount('exit');
      for (let i = 0; i < 5; i++) stageSkillsForMode(src, 'minimal');
      const after = process.listenerCount('exit');
      assert.ok(after - before <= 1, `expected <=1 new exit listener, got ${after - before}`);
    } finally {
      cleanup(src);
      cleanupStagedSkills();
    }
  });

  test('mid-copy failure removes partial staged dir and re-throws', () => {
    cleanupStagedSkills();
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-stage-fail-'));
    fs.writeFileSync(path.join(src, 'plan-phase.md'), '# plan\n');
    fs.writeFileSync(path.join(src, 'execute-phase.md'), '# x\n');
    const realCopy = fs.copyFileSync;
    const realMkdtemp = fs.mkdtempSync;
    let stagedDir = null;
    fs.mkdtempSync = (prefix, ...rest) => {
      const out = realMkdtemp(prefix, ...rest);
      if (typeof prefix === 'string' && prefix.endsWith('gsd-minimal-skills-')) stagedDir = out;
      return out;
    };
    let copyCount = 0;
    fs.copyFileSync = (s, d) => {
      copyCount++;
      if (copyCount === 2) throw new Error('synthetic disk full');
      return realCopy(s, d);
    };
    try {
      assert.throws(() => stageSkillsForMode(src, 'minimal'), /synthetic disk full/);
      assert.notStrictEqual(stagedDir, null);
      assert.equal(fs.existsSync(stagedDir), false);
    } finally {
      fs.copyFileSync = realCopy;
      fs.mkdtempSync = realMkdtemp;
      cleanup(src);
      cleanupStagedSkills();
    }
  });
});

describe('install-profiles: allowlist scope guards', () => {
  test('every main-loop command is in the allowlist', () => {
    for (const required of ['new-project', 'discuss-phase', 'plan-phase', 'execute-phase']) {
      assert.ok(shouldInstallSkill(required, 'minimal'), `"${required}" must be in allowlist`);
    }
  });

  test('off-loop commands are NOT in the allowlist', () => {
    for (const offLoop of ['autonomous', 'ship', 'do', 'progress', 'next', 'fast', 'quick', 'debug', 'code-review', 'verify-work']) {
      assert.ok(!shouldInstallSkill(offLoop, 'minimal'), `"${offLoop}" must NOT be in allowlist`);
    }
  });
});

// ─── Section 10: --minimal install — per-runtime E2E (spawned) ───────────────

describe('install: --minimal honoured for every runtime in --global mode', () => {
  for (const runtime of SKILL_RUNTIMES) {
    test(`${runtime} --global --minimal: mode=minimal, correct skills, zero agents`, () => {
      const { manifest, root } = runMinimalInstall({ runtime, scope: 'global', extraArgs: ['--minimal'] });
      try {
        assert.ok(manifest, `${runtime} global must produce manifest`);
        assert.strictEqual(manifest.mode, 'minimal');
        assert.deepStrictEqual(
          [...manifestSkillSet(manifest)].sort(),
          [...MINIMAL_SKILL_ALLOWLIST].sort(),
        );
        assert.strictEqual(manifestAgentCount(manifest), 0);
      } finally {
        cleanup(root);
      }
    });
  }
});

describe('install: --minimal honoured for every runtime in --local mode', () => {
  for (const runtime of SKILL_RUNTIMES) {
    test(`${runtime} --local --minimal: mode=minimal, correct skills, zero agents`, () => {
      const { manifest, root } = runMinimalInstall({ runtime, scope: 'local', extraArgs: ['--minimal'] });
      try {
        assert.ok(manifest, `${runtime} local must produce manifest`);
        assert.strictEqual(manifest.mode, 'minimal');
        assert.deepStrictEqual(
          [...manifestSkillSet(manifest)].sort(),
          [...MINIMAL_SKILL_ALLOWLIST].sort(),
        );
        assert.strictEqual(manifestAgentCount(manifest), 0);
      } finally {
        cleanup(root);
      }
    });
  }
});

describe('install: Cline --minimal (rules-based, no skills/ dir)', () => {
  for (const scope of ['global', 'local']) {
    test(`cline --${scope} --minimal: mode=minimal, zero agents, .clinerules present`, () => {
      const { manifest, configDir, root } = runMinimalInstall({
        runtime: 'cline', scope, extraArgs: ['--minimal'],
      });
      try {
        assert.ok(manifest, 'cline must produce manifest');
        assert.strictEqual(manifest.mode, 'minimal');
        assert.strictEqual(manifestAgentCount(manifest), 0);
        assert.ok(fs.existsSync(path.join(configDir, '.clinerules')));
      } finally {
        cleanup(root);
      }
    });
  }
});

describe('install: on-disk skill files match manifest for --minimal', () => {
  for (const runtime of SKILL_RUNTIMES) {
    for (const scope of ['global', 'local']) {
      test(`${runtime} --${scope} --minimal: on-disk matches manifest`, () => {
        const { manifest, configDir, root } = runMinimalInstall({
          runtime, scope, extraArgs: ['--minimal'],
        });
        try {
          assert.ok(manifest);
          const onDisk = collectSkillBasenamesOnDiskSandboxed(configDir, runtime, scope, root);
          const inManifest = manifestSkillSet(manifest);
          assert.deepStrictEqual([...onDisk].sort(), [...inManifest].sort());
          // Not the shared listAgentFiles() helper: asserts on the INSTALLED
          // dest dir (must be empty in --minimal mode), not the source roster.
          const agentsDir = path.join(configDir, 'agents');
          if (fs.existsSync(agentsDir)) {
            const gsdAgents = fs.readdirSync(agentsDir)
              .filter(f => f.startsWith('gsd-') && f.endsWith('.md'));
            assert.deepStrictEqual(gsdAgents, []);
          }
        } finally {
          cleanup(root);
        }
      });
    }
  }
});

// ─── Section 11: --minimal manifest mode + downgrade ─────────────────────────

describe('install: manifest records mode for both profiles', () => {
  function manifestModeAfterInstall(extraArgs) {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-manifest-mode-'));
    try {
      spawnSync(
        process.execPath,
        [INSTALL_SCRIPT, '--claude', '--global', '--config-dir', targetDir, ...extraArgs],
        { encoding: 'utf8', env: installerEnv() },
      );
      const manifestPath = path.join(targetDir, MANIFEST_NAME);
      if (!fs.existsSync(manifestPath)) return { mode: '<no manifest>', skillCount: 0, agentCount: 0 };
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      // Count SKILL.md files under skills/ (works for both flat and ns-nested layouts).
      const skillCount = Object.keys(m.files || {}).filter(
        k => k.startsWith('skills/') && k.endsWith('/SKILL.md'),
      ).length;
      const agentCount = Object.keys(m.files || {}).filter(k => k.startsWith('agents/')).length;
      return { mode: m.mode, skillCount, agentCount };
    } finally {
      cleanup(targetDir);
    }
  }

  test('default install records mode: "full" with full skill+agent count', () => {
    const r = manifestModeAfterInstall([]);
    assert.strictEqual(r.mode, 'full');
    assert.ok(r.skillCount > 7);
    assert.ok(r.agentCount > 0);
  });

  test('--minimal records mode: "minimal" with exactly 8 skills and 0 agents', () => {
    const r = manifestModeAfterInstall(['--minimal']);
    assert.strictEqual(r.mode, 'minimal');
    assert.strictEqual(r.skillCount, 8);
    assert.strictEqual(r.agentCount, 0);
  });

  test('--core-only is an alias for --minimal', () => {
    const r = manifestModeAfterInstall(['--core-only']);
    assert.strictEqual(r.mode, 'minimal');
    assert.strictEqual(r.skillCount, 8);
    assert.strictEqual(r.agentCount, 0);
  });
});

describe('install-minimal-backcompat: PROFILES.core matches MINIMAL_SKILL_ALLOWLIST', () => {
  test('PROFILES.core contains the same 8 skills as MINIMAL_SKILL_ALLOWLIST', () => {
    assert.deepStrictEqual(
      [...PROFILES.core].sort(),
      [...MINIMAL_SKILL_ALLOWLIST].sort(),
    );
  });
});

describe('install-minimal-backcompat: --minimal and --profile=core produce same manifest', () => {
  function installAndGetManifest(extraArgs) {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-backcompat-'));
    try {
      spawnSync(
        process.execPath,
        [INSTALL_SCRIPT, '--claude', '--global', '--config-dir', targetDir, ...extraArgs],
        { encoding: 'utf8', env: installerEnv() },
      );
      const manifestPath = path.join(targetDir, MANIFEST_NAME);
      if (!fs.existsSync(manifestPath)) return { mode: null, skillCount: 0, profileMarker: null };
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      // Count SKILL.md files under skills/ (works for both flat and ns-nested layouts).
      const skillCount = Object.keys(m.files || {}).filter(
        k => k.startsWith('skills/') && k.endsWith('/SKILL.md'),
      ).length;
      const markerPath = path.join(targetDir, '.gsd-profile');
      const profileMarker = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8').trim() : null;
      return { mode: m.mode, skillCount, profileMarker };
    } finally {
      cleanup(targetDir);
    }
  }

  test('--minimal produces mode "minimal" with exactly 8 skills', () => {
    const r = installAndGetManifest(['--minimal']);
    assert.strictEqual(r.mode, 'minimal');
    assert.strictEqual(r.skillCount, 8);
  });

  test('--minimal writes .gsd-profile marker "core"', () => {
    const r = installAndGetManifest(['--minimal']);
    assert.strictEqual(r.profileMarker, 'core');
  });

  test('default install writes .gsd-profile marker "full"', () => {
    const r = installAndGetManifest([]);
    assert.strictEqual(r.profileMarker, 'full');
  });

  test('--profile=core writes .gsd-profile marker "core"', () => {
    const r = installAndGetManifest(['--profile=core']);
    assert.strictEqual(r.profileMarker, 'core');
  });

  test('--profile=standard writes .gsd-profile marker "standard"', () => {
    const r = installAndGetManifest(['--profile=standard']);
    assert.strictEqual(r.profileMarker, 'standard');
  });
});

describe('install: Codex full → minimal downgrade cleans stale agent state', () => {
  test('--minimal removes stale .toml agents and strips [agents.gsd-*] from config.toml', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-codex-downgrade-'));
    try {
      const agentsDir = path.join(targetDir, 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'gsd-executor.md'), 'stale\n');
      fs.writeFileSync(path.join(agentsDir, 'gsd-planner.md'), 'stale\n');
      fs.writeFileSync(path.join(agentsDir, 'gsd-executor.toml'), 'name = "gsd-executor"\n');
      fs.writeFileSync(path.join(agentsDir, 'gsd-planner.toml'), 'name = "gsd-planner"\n');
      fs.writeFileSync(path.join(agentsDir, 'my-custom-agent.md'), 'user owns this\n');
      const codexConfig = [
        '# user-owned setting',
        'model = "gpt-5"',
        '',
        '# GSD Agent Configuration — managed by gsd-core installer',
        '[agents.gsd-executor]',
        'cmd = "stale"',
        '',
        '[agents.gsd-planner]',
        'cmd = "stale"',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(targetDir, 'config.toml'), codexConfig);

      // Sandbox HOME/USERPROFILE to targetDir: Codex's skills-kind `home: ".agents"`
      // override (ADR-1239 upgrade 3, #2088) resolves via os.homedir(), so an
      // unsandboxed spawn here would write gsd-* skill dirs into the developer's
      // real $HOME/.agents/skills. This test only asserts on agents/ and
      // config.toml (both under targetDir), so the sandbox has no effect on intent.
      const result = spawnSync(
        process.execPath,
        [INSTALL_SCRIPT, '--codex', '--global', '--config-dir', targetDir, '--minimal'],
        { encoding: 'utf8', env: installerEnv({ HOME: targetDir, USERPROFILE: targetDir }) },
      );
      assert.ok(result.stdout || result.stderr);

      const remaining = fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir) : [];
      assert.ok(!remaining.includes('gsd-executor.md'));
      assert.ok(!remaining.includes('gsd-planner.md'));
      assert.ok(!remaining.includes('gsd-executor.toml'));
      assert.ok(!remaining.includes('gsd-planner.toml'));
      assert.ok(remaining.includes('my-custom-agent.md'));

      const configPath = path.join(targetDir, 'config.toml');
      if (fs.existsSync(configPath)) {
        const config = fs.readFileSync(configPath, 'utf8');
        assert.ok(!config.includes('[agents.gsd-executor]'));
        assert.ok(!config.includes('[agents.gsd-planner]'));
        assert.ok(config.includes('model = "gpt-5"'));
      }
      assert.ok(fs.existsSync(configPath));
    } finally {
      cleanup(targetDir);
    }
  });
});

describe('install: Claude full → minimal downgrade removes stale agents', () => {
  test('--minimal removes stale gsd-*.md agents but preserves user-owned agents', () => {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-claude-downgrade-'));
    try {
      const agentsDir = path.join(targetDir, 'agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      fs.writeFileSync(path.join(agentsDir, 'gsd-executor.md'), 'stale\n');
      fs.writeFileSync(path.join(agentsDir, 'gsd-planner.md'), 'stale\n');
      fs.writeFileSync(path.join(agentsDir, 'my-custom-agent.md'), 'user owns this\n');

      spawnSync(
        process.execPath,
        [INSTALL_SCRIPT, '--claude', '--global', '--config-dir', targetDir, '--minimal'],
        { encoding: 'utf8', env: installerEnv() },
      );

      const remaining = fs.existsSync(agentsDir) ? fs.readdirSync(agentsDir) : [];
      assert.ok(!remaining.includes('gsd-executor.md'));
      assert.ok(!remaining.includes('gsd-planner.md'));
      assert.ok(remaining.includes('my-custom-agent.md'));
      assert.deepStrictEqual(remaining.filter(f => f.startsWith('gsd-')), []);
    } finally {
      cleanup(targetDir);
    }
  });
});

// ─── Section 13: Hooks copy, manifest, uninstall settings cleanup ─────────────

before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], { encoding: 'utf-8', stdio: 'pipe' });
});

const isWindows = process.platform === 'win32';

describe('#1755: .sh hooks are copied and executable after install', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempDir('gsd-hook-copy-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('all expected hooks are copied from hooks/dist/ to target', () => {
    const hooksDest = path.join(tmpDir, 'hooks');
    simulateHookCopy(HOOKS_DIST, hooksDest);
    for (const hook of EXPECTED_ALL_HOOKS) {
      assert.ok(fs.existsSync(path.join(hooksDest, hook)), `${hook} should exist`);
    }
  });

  test('.sh hooks are executable after copy', {
    skip: isWindows ? 'Windows has no POSIX file permissions' : false,
  }, () => {
    const hooksDest = path.join(tmpDir, 'hooks');
    simulateHookCopy(HOOKS_DIST, hooksDest);
    for (const sh of EXPECTED_SH_HOOKS) {
      const stat = fs.statSync(path.join(hooksDest, sh));
      assert.ok((stat.mode & 0o111) !== 0, `${sh} should be executable`);
    }
  });

  test('.js hooks are executable after copy', {
    skip: isWindows ? 'Windows has no POSIX file permissions' : false,
  }, () => {
    const hooksDest = path.join(tmpDir, 'hooks');
    simulateHookCopy(HOOKS_DIST, hooksDest);
    for (const js of EXPECTED_ALL_HOOKS.filter(h => h.endsWith('.js'))) {
      const stat = fs.statSync(path.join(hooksDest, js));
      assert.ok((stat.mode & 0o111) !== 0, `${js} should be executable`);
    }
  });
});

// ─── #1821/#2305: hooks staged iff a surface consumes them ─────────────────────
//
// #1821 reported dead hook scripts staged for runtimes with hooksSurface:'none'.
// OpenCode, pi — and, corrected by #2305, Kilo — ALSO declare
// hooksSurface:'none', but each has a native plugin adapter that spawns the
// staged hooks/*.js scripts as subprocesses (OpenCode's #1914
// plugins/gsd-core.js via OpenCode's event bus; pi's #2102 Stage 2 pi/gsd.cjs
// → extensions/gsd.js via pi.on(...) bridges; Kilo's plugins/gsd-core.js,
// byte-identical to OpenCode's) — so for all three, the hooks are LIVE and
// must keep being copied. ZCode has no plugin surface at all, so its staged
// hooks are genuinely dead: that is the case #1821's fix removes. (#1821
// originally excluded Kilo too, on the false premise that it had no plugin
// surface — #2305 reversed that: the skip flag silently no-opped every guard
// hook Kilo's plugin spawns.) These tests assert the split: ZCode gets no
// hooks; Kilo/OpenCode/pi (and Claude) do.

describe('#1821/#2305: ZCode receives no dead hook files; Kilo/OpenCode/Claude keep their hooks', () => {
  function gsdHookFilesUnder(configDir) {
    const hooksDir = path.join(configDir, 'hooks');
    if (!fs.existsSync(hooksDir)) return [];
    return walk(hooksDir).filter((f) => {
      const base = path.basename(f);
      return /^gsd-.*\.(js|sh)$/.test(base);
    });
  }

  function installAndCollect(runtime, opts = {}) {
    const targetDir = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-1821-${runtime}-`));
    try {
      const result = spawnSync(
        process.execPath,
        [INSTALL_SCRIPT, `--${runtime}`, '--global', '--config-dir', targetDir],
        { encoding: 'utf8', env: installerEnv() },
      );
      assert.strictEqual(result.status, 0,
        `installer exited with status ${result.status} for --${runtime} --global\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
      // Collect results while targetDir still exists — cleanup() below removes it.
      const pluginRelPath = opts.pluginRelPath || path.join('plugins', 'gsd-core.js');
      return {
        hookFiles: gsdHookFilesUnder(targetDir),
        hooksLibExists: fs.existsSync(path.join(targetDir, 'hooks', 'lib')),
        gitCmdExists: fs.existsSync(path.join(targetDir, 'hooks', 'lib', 'git-cmd.js')),
        pluginExists: fs.existsSync(path.join(targetDir, pluginRelPath)),
      };
    } finally {
      cleanup(targetDir);
    }
  }

  // ZCode declares hooksSurface:'none' with no plugin surface, so its staged
  // hooks are genuinely dead weight (#1821) — this is the case the fix
  // removes. (Kilo was originally in this loop; #2305 moved it to the
  // OpenCode group below — its native plugin spawns the staged guard hooks.)
  for (const runtime of ['zcode']) {
    test(`${runtime} --global install creates no gsd-*.js/.sh hook files or hooks/lib`, () => {
      const { hookFiles, hooksLibExists } = installAndCollect(runtime);
      assert.deepStrictEqual(hookFiles, [], `${runtime} install must not copy any gsd-*.js/.sh hook files, found: ${hookFiles.join(', ')}`);
      assert.ok(!hooksLibExists, `${runtime} install must not create hooks/lib/`);
    });
  }

  // #2305: Kilo's native plugin (plugins/gsd-core.js, byte-identical to
  // OpenCode's) spawns the staged PreToolUse guard hooks as subprocesses, so
  // Kilo must receive the shared hooks bundle as a sibling of gsd-core/ —
  // the shape the plugin's resolveRepoRoot walk requires. #1821 excluded
  // Kilo on the false premise that it had no plugin surface; with the skip
  // flag set, every guard silently no-opped on every Kilo install.
  test('kilo --global install stages the guard hooks its plugin spawns, hooks/lib, and the plugin', () => {
    const { hookFiles, hooksLibExists, gitCmdExists, pluginExists } = installAndCollect('kilo');
    const basenames = hookFiles.map((f) => path.basename(f));
    for (const expected of ['gsd-prompt-guard.js', 'gsd-read-guard.js', 'gsd-worktree-path-guard.js']) {
      assert.ok(
        basenames.includes(expected),
        `kilo install must copy ${expected} (spawned by the plugin's runHook), found: ${basenames.join(', ')}`,
      );
    }
    assert.ok(hooksLibExists, 'kilo install must create hooks/lib/');
    assert.ok(gitCmdExists, 'kilo install must copy hooks/lib/git-cmd.js (required by the shared hooks)');
    assert.ok(pluginExists, 'kilo install must install plugins/gsd-core.js (the hook-spawning plugin)');
  });

  // Regression guard for #1914: OpenCode's plugin adapter spawns the staged
  // hooks, so excluding OpenCode from the hook copy would break it. OpenCode
  // must KEEP its hooks and receive the plugin.
  test('opencode --global install still copies hooks and installs the #1914 plugin', () => {
    const { hookFiles, pluginExists } = installAndCollect('opencode');
    const basenames = hookFiles.map((f) => path.basename(f));
    assert.ok(
      basenames.includes('gsd-context-monitor.js'),
      `opencode install must still copy gsd-*.js hooks (spawned by the #1914 plugin), found: ${basenames.join(', ')}`,
    );
    assert.ok(pluginExists, 'opencode install must install plugins/gsd-core.js (#1914 hook bridge)');
  });

  // pi ALSO declares hooksSurface:'none', but — like OpenCode — it is NOT a
  // dead-weight case: pi's native extension (pi/gsd.cjs → extensions/gsd.js)
  // spawns the staged hooks/*.js scripts as bounded subprocesses (session_start
  // → gsd-ensure-canonical-path.js, before_agent_start → gsd-workflow-guard.js,
  // session_before_compact → gsd-context-monitor.js — #2102 Stage 2), and its
  // /gsd command handler tokenizes raw args via the shared hooks/lib/git-cmd.js
  // tokenizer. hostBehaviors.skipSharedHooksInstall is therefore NOT set for
  // pi (unlike Kilo/ZCode/Cursor/Cline/Trae/Copilot/Windsurf/Kimi) — pi is in
  // the OpenCode group, not the Kilo/ZCode group.
  test('pi --global install still copies hooks (spawned by the native extension) + hooks/lib/git-cmd.js + the extension itself', () => {
    // #2470: derive the extension filename from pi's own descriptor rather than
    // hardcoding it, and assert it satisfies pi's isExtensionFile() discovery
    // filter (.ts/.js only) — a dest pi cannot discover installs "successfully"
    // while /gsd never registers, which is exactly how this shipped broken.
    const piNativePlugin = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'capabilities', 'pi', 'capability.json'), 'utf8'),
    ).runtime.hostBehaviors.nativePlugin;
    assert.ok(
      piNativePlugin.file.endsWith('.ts') || piNativePlugin.file.endsWith('.js'),
      `pi's installed extension "${piNativePlugin.file}" must end in .ts or .js — pi silently ` +
        'skips any other suffix during extensions/ auto-discovery (#2470)',
    );
    const { hookFiles, hooksLibExists, gitCmdExists, pluginExists } = installAndCollect('pi', {
      pluginRelPath: path.join(piNativePlugin.dir, piNativePlugin.file),
    });
    const basenames = hookFiles.map((f) => path.basename(f));
    for (const expected of ['gsd-ensure-canonical-path.js', 'gsd-workflow-guard.js', 'gsd-context-monitor.js']) {
      assert.ok(
        basenames.includes(expected),
        `pi install must copy ${expected} (spawned by pi/gsd.cjs's event bridges), found: ${basenames.join(', ')}`,
      );
    }
    assert.ok(hooksLibExists, 'pi install must create hooks/lib/');
    assert.ok(gitCmdExists, 'pi install must copy hooks/lib/git-cmd.js (the /gsd command tokenizer)');
    assert.ok(
      pluginExists,
      `pi install must install ${piNativePlugin.dir}/${piNativePlugin.file} (the native-extension hook bridge)`,
    );
  });

  // Positive control: guards against over-exclusion breaking runtimes that
  // legitimately need hooks (hooksSurface !== 'none').
  test('claude --global install still copies gsd-*.js hooks', () => {
    const { hookFiles } = installAndCollect('claude');
    const basenames = hookFiles.map((f) => path.basename(f));
    assert.ok(
      basenames.includes('gsd-context-monitor.js'),
      `claude install must still copy gsd-context-monitor.js, found: ${basenames.join(', ')}`,
    );
  });
});

// Migrated (#455): uses typed export GSD_UNINSTALL_HOOKS instead of
// source-grep assertions on bin/install.js for the uninstall hook list tests.
describe('install.js uninstall hooks registry (typed assertions)', () => {
  test('GSD_UNINSTALL_HOOKS is a non-empty array', () => {
    assert.ok(Array.isArray(GSD_UNINSTALL_HOOKS), 'GSD_UNINSTALL_HOOKS must be an array');
    assert.ok(GSD_UNINSTALL_HOOKS.length > 0, 'GSD_UNINSTALL_HOOKS must not be empty');
  });

  test('gsd-workflow-guard.js is in GSD_UNINSTALL_HOOKS', () => {
    assert.ok(
      GSD_UNINSTALL_HOOKS.includes('gsd-workflow-guard.js'),
      'GSD_UNINSTALL_HOOKS must include gsd-workflow-guard.js'
    );
  });

  test('phantom gsd-check-update.sh is NOT in GSD_UNINSTALL_HOOKS', () => {
    assert.ok(
      !GSD_UNINSTALL_HOOKS.includes('gsd-check-update.sh'),
      'GSD_UNINSTALL_HOOKS must not include the phantom gsd-check-update.sh entry'
    );
  });

  test('GSD_UNINSTALL_HOOKS covers all 3 opt-in bash hooks', () => {
    const required = ['gsd-session-state.sh', 'gsd-validate-commit.sh', 'gsd-phase-boundary.sh'];
    for (const hook of required) {
      assert.ok(
        GSD_UNINSTALL_HOOKS.includes(hook),
        `GSD_UNINSTALL_HOOKS must include ${hook}`
      );
    }
  });

  test('GSD_UNINSTALL_HOOKS covers core JS hooks', () => {
    const coreJsHooks = [
      'gsd-check-update.js', 'gsd-statusline.js', 'gsd-session-state.sh',
      'gsd-context-monitor.js', 'gsd-phase-boundary.sh', 'gsd-prompt-guard.js',
      'gsd-read-guard.js', 'gsd-validate-commit.sh', 'gsd-workflow-guard.js',
    ];
    for (const hook of coreJsHooks) {
      assert.ok(
        GSD_UNINSTALL_HOOKS.includes(hook),
        `GSD_UNINSTALL_HOOKS must include ${hook}`
      );
    }
  });
});

describe('writeManifest includes .sh hooks', () => {
  let tmpDir;
  beforeEach(() => {
    tmpDir = createTempDir('gsd-manifest-');
    const hooksDir = path.join(tmpDir, 'hooks');
    simulateHookCopy(HOOKS_DIST, hooksDir);
  });
  afterEach(() => { cleanup(tmpDir); });

  test('manifest contains .sh hook entries', () => {
    writeManifest(tmpDir, 'claude');
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'gsd-file-manifest.json'), 'utf8'));
    for (const sh of EXPECTED_SH_HOOKS) {
      assert.ok(manifest.files['hooks/' + sh], `manifest should contain hash for ${sh}`);
    }
  });

  test('manifest contains .js hook entries', () => {
    writeManifest(tmpDir, 'claude');
    const manifest = JSON.parse(fs.readFileSync(path.join(tmpDir, 'gsd-file-manifest.json'), 'utf8'));
    for (const js of EXPECTED_ALL_HOOKS.filter(h => h.endsWith('.js'))) {
      assert.ok(manifest.files['hooks/' + js], `manifest should contain hash for ${js}`);
    }
  });
});

describe('uninstall settings cleanup preserves user hooks', () => {
  const isGsdHook = (cmd) =>
    cmd && (cmd.includes('gsd-check-update') || cmd.includes('gsd-statusline') ||
      cmd.includes('gsd-session-state') || cmd.includes('gsd-context-monitor') ||
      cmd.includes('gsd-phase-boundary') || cmd.includes('gsd-prompt-guard') ||
      cmd.includes('gsd-read-guard') || cmd.includes('gsd-validate-commit') ||
      cmd.includes('gsd-workflow-guard'));

  function filterGsdHooks(entries) {
    return entries
      .map(e => {
        if (!e.hooks || !Array.isArray(e.hooks)) return e;
        e.hooks = e.hooks.filter(h => !isGsdHook(h.command));
        return e.hooks.length > 0 ? e : null;
      })
      .filter(Boolean);
  }

  test('mixed entry preserves user hooks', () => {
    const entries = [{
      matcher: 'Bash',
      hooks: [
        { type: 'command', command: 'node /path/gsd-prompt-guard.js' },
        { type: 'command', command: 'bash /my/custom-lint.sh' },
      ],
    }];
    const result = filterGsdHooks(entries);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].hooks.length, 1);
    assert.ok(result[0].hooks[0].command.includes('custom-lint'));
  });

  test('entry with only GSD hooks is fully removed', () => {
    const entries = [{
      hooks: [
        { type: 'command', command: 'node /path/gsd-check-update.js' },
        { type: 'command', command: 'node /path/gsd-statusline.js' },
      ],
    }];
    assert.strictEqual(filterGsdHooks(entries).length, 0);
  });

  test('entry with only user hooks is untouched', () => {
    const entries = [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bash /my/pre-check.sh' }] }];
    const result = filterGsdHooks(entries);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].hooks.length, 1);
  });

  test('non-array hook entries are preserved (#1825)', () => {
    const entries = [
      { type: 'custom', command: 'echo hello' },
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'node /path/gsd-prompt-guard.js' }] },
      { url: 'https://example.com/webhook' },
    ];
    const result = filterGsdHooks(JSON.parse(JSON.stringify(entries)));
    assert.strictEqual(result.length, 2);
    assert.deepStrictEqual(result[0], { type: 'custom', command: 'echo hello' });
    assert.deepStrictEqual(result[1], { url: 'https://example.com/webhook' });
  });

  test('all GSD hook names are recognised', () => {
    const cmds = [
      'node /path/gsd-check-update.js', 'node /path/gsd-statusline.js',
      'bash /path/gsd-session-state.sh', 'node /path/gsd-context-monitor.js',
      'bash /path/gsd-phase-boundary.sh', 'node /path/gsd-prompt-guard.js',
      'node /path/gsd-read-guard.js', 'bash /path/gsd-validate-commit.sh',
      'node /path/gsd-workflow-guard.js',
    ];
    for (const cmd of cmds) {
      assert.ok(isGsdHook(cmd), `should recognise: ${cmd}`);
    }
  });
});

describe('Codex legacy gsd-update-check migration', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'install.js'), 'utf8');

  test('install.js strips legacy gsd-update-check hook blocks', () => {
    assert.ok(src.includes('gsd-update-check') && src.includes('replace('));
  });

  test('migration regex removes LF legacy hook block', () => {
    const legacyBlock = ['[features]', 'codex_hooks = true', '',
      '# GSD Hooks', '[[hooks]]', 'event = "SessionStart"',
      'command = "node /old/path/gsd-update-check.js"', ''].join('\n');
    let content = legacyBlock.replace(
      /\n# GSD Hooks\n\[\[hooks\]\]\nevent = "SessionStart"\ncommand = "node [^\n]*gsd-update-check\.js"\n/g, '\n',
    );
    assert.ok(!content.includes('gsd-update-check'));
    assert.ok(content.includes('[features]'));
  });

  test('migration regex removes CRLF legacy hook block', () => {
    const legacyBlock = ['[features]', 'codex_hooks = true', '',
      '# GSD Hooks', '[[hooks]]', 'event = "SessionStart"',
      'command = "node /old/path/gsd-update-check.js"', ''].join('\r\n');
    let content = legacyBlock.replace(
      /\r\n# GSD Hooks\r\n\[\[hooks\]\]\r\nevent = "SessionStart"\r\ncommand = "node [^\r\n]*gsd-update-check\.js"\r\n/g, '\r\n',
    );
    assert.ok(!content.includes('gsd-update-check'));
    assert.ok(content.includes('[features]'));
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1754-js-hook-guard.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1754-js-hook-guard (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression tests for bug #1754
 *
 * The installer must NOT register .js hook entries in settings.json when the
 * corresponding .js file does not exist at the target path. The original bug:
 * on fresh installs where hooks/dist/ was missing from the npm package (as in
 * v1.32.0), the hook copy step produced no files, yet the registration step
 * ran unconditionally for .js hooks — leaving users with "PreToolUse:Bash
 * hook error" on every tool invocation.
 *
 * The .sh hooks already had fs.existsSync() guards (added in #1817). This
 * test verifies the same defensive pattern exists for all .js hooks.
 */

'use strict';

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const INSTALL_SRC = path.join(__dirname, '..', 'bin', 'install.js');
// ADR-857 phase 5f-1b: settings-json hook registration moved to runtime-hooks-surface.cts.
const HOOKS_SURFACE_SRC = path.join(__dirname, '..', 'src', 'runtime-hooks-surface.cts');

const JS_HOOKS = [
  { name: 'gsd-check-update.js',      registrationAnchor: 'hasGsdUpdateHook' },
  { name: 'gsd-context-monitor.js',   registrationAnchor: 'hasContextMonitorHook' },
  { name: 'gsd-prompt-guard.js',      registrationAnchor: 'hasPromptGuardHook' },
  { name: 'gsd-read-guard.js',        registrationAnchor: 'hasReadGuardHook' },
  { name: 'gsd-workflow-guard.js',    registrationAnchor: 'hasWorkflowGuardHook' },
  { name: 'gsd-worktree-path-guard.js', registrationAnchor: 'hasWorktreePathGuardHook' },
  { name: 'gsd-write-guard.js',         registrationAnchor: 'hasWriteGuardHook' },
];

describe('bug #1754: .js hook registration guards', () => {
  let src;

  before(() => {
    // ADR-857 phase 5f-1b: hook registration moved to runtime-hooks-surface.cts.
    // Concatenate both sources so structural assertions find patterns in either file.
    const installSrc = fs.readFileSync(INSTALL_SRC, 'utf-8');
    let hooksSurfaceSrc = '';
    try { hooksSurfaceSrc = fs.readFileSync(HOOKS_SURFACE_SRC, 'utf-8'); } catch { /* ok */ }
    src = installSrc + '\n' + hooksSurfaceSrc;
  });

  for (const { name, registrationAnchor } of JS_HOOKS) {
    describe(`${name} registration`, () => {
      test(`install.js checks file existence before registering ${name}`, () => {
        // Find the registration block by locating the "has...Hook" variable
        const anchorIdx = src.indexOf(registrationAnchor);
        assert.ok(
          anchorIdx !== -1,
          `${registrationAnchor} variable not found in install.js`
        );

        // Extract a window around the registration block to find the guard
        const blockStart = anchorIdx;
        const blockEnd = Math.min(src.length, anchorIdx + 1200);
        const block = src.slice(blockStart, blockEnd);

        // The block must contain an fs.existsSync check for the hook file
        assert.ok(
          block.includes('fs.existsSync') || block.includes('existsSync'),
          `install.js must call fs.existsSync on the target path before registering ${name} ` +
          `in settings.json. Without this guard, hooks are registered even when the .js file ` +
          `was never copied (the root cause of #1754).`
        );
      });

      test(`install.js emits a warning when ${name} is missing`, () => {
        // The hook file name (without extension) should appear in a warning message
        const hookBaseName = name.replace('.js', '');
        const warnPattern = `Skipped`;
        const anchorIdx = src.indexOf(registrationAnchor);
        const block = src.slice(anchorIdx, Math.min(src.length, anchorIdx + 1200));

        assert.ok(
          block.includes(warnPattern) && block.includes(hookBaseName),
          `install.js must emit a skip warning when ${name} is not found at the target path`
        );
      });
    });
  }

  test('all .js hooks use the same guard pattern as .sh hooks', () => {
    // Count existsSync calls in the hook registration section.
    // There should be guards for all JS hooks plus the existing SH hooks.
    // This test ensures new hooks added in the future follow the same pattern.
    // ADR-857 phase 5f-1b: registration moved to runtime-hooks-surface.cts so scan the
    // full concatenated source (install.js + runtime-hooks-surface.cts) rather than slicing.
    const registrationSection = src;

    // Count unique hook file existence checks (pattern: path.join(targetDir, 'hooks', 'gsd-*.js'))
    const jsGuards = (registrationSection.match(/gsd-[\w-]+\.js.*not found at target/g) || []);
    const shGuards = (registrationSection.match(/gsd-[\w-]+\.sh.*not found at target/g) || []);

    assert.ok(
      jsGuards.length >= JS_HOOKS.length,
      `Expected at least ${JS_HOOKS.length} .js hook guards, found ${jsGuards.length}. ` +
      `Every .js hook registration must check file existence before registering.`
    );

    assert.ok(
      shGuards.length >= 3,
      `Expected at least 3 .sh hook guards (validate-commit, session-state, phase-boundary), ` +
      `found ${shGuards.length}.`
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1817-sh-hook-guard.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1817-sh-hook-guard (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression tests for bug #1817
 *
 * The installer must NOT register .sh hook entries in settings.json when the
 * corresponding .sh file does not exist at the target path. The original bug:
 * v1.32.0's npm package omitted the .sh files from hooks/dist/, so the copy
 * step produced no files, yet the registration step ran unconditionally —
 * leaving users with hook errors on every tool invocation.
 *
 * Defensive guard: before registering each .sh hook in settings.json,
 * install.js must verify the target file exists. If it doesn't, skip
 * registration and emit a warning.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const INSTALL_SRC = path.join(__dirname, '..', 'bin', 'install.js');
// ADR-857 phase 5f-1b: settings-json hook registration moved to runtime-hooks-surface.cts.
const HOOKS_SURFACE_SRC = path.join(__dirname, '..', 'src', 'runtime-hooks-surface.cts');

const SH_HOOKS = [
  { name: 'gsd-validate-commit.sh', settingsVar: 'validateCommitCommand' },
  { name: 'gsd-session-state.sh',   settingsVar: 'sessionStateCommand' },
  { name: 'gsd-phase-boundary.sh',  settingsVar: 'phaseBoundaryCommand' },
];

describe('bug #1817: .sh hook registration guards', () => {
  let src;

  // Read once — all tests in this suite share the same source snapshot.
  // ADR-857 phase 5f-1b: hook registration moved to runtime-hooks-surface.cts.
  // Concatenate both sources so structural assertions find patterns in either file.
  try {
    const installSrc = fs.readFileSync(INSTALL_SRC, 'utf-8');
    let hooksSurfaceSrc = '';
    try { hooksSurfaceSrc = fs.readFileSync(HOOKS_SURFACE_SRC, 'utf-8'); } catch { /* ok */ }
    src = installSrc + '\n' + hooksSurfaceSrc;
  } catch {
    src = '';
  }

  for (const { name, settingsVar } of SH_HOOKS) {
    describe(`${name} registration`, () => {
      test(`install.js checks file existence before registering ${name}`, () => {
        // Find the block where this .sh hook is registered.
        // Each registration block is preceded by the command variable declaration
        // and followed by the next hook or end of registration section.
        const varIdx = src.indexOf(settingsVar);
        assert.ok(varIdx !== -1, `${settingsVar} variable not found in install.js`);

        // Extract ~900 chars around the variable to find the registration block
        const blockStart = Math.max(0, varIdx - 50);
        const blockEnd = Math.min(src.length, varIdx + 900);
        const block = src.slice(blockStart, blockEnd);

        assert.ok(
          block.includes('fs.existsSync') || block.includes('existsSync'),
          `install.js must call fs.existsSync on the target path before registering ${name} in settings.json. ` +
          `Without this guard, hooks are registered even when the .sh file was never copied ` +
          `(the root cause of #1817).`
        );
      });
    });
  }
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-1076-extended-hook-events-drive.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-1076-extended-hook-events-drive (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * ADR-857 phase 5f-3: extended hook event guards are driven by the
 * extendedHookEvents descriptor field, not hardcoded runtime-name checks.
 *
 * Before this change:
 *   - SubagentStop/Stop/PreCompact were wired only when (isQwen || runtime==='claude')
 *   - FileChanged was wired only when (runtime === 'claude')
 *   - BeforeAgent/AfterAgent/BeforeModel were wired only when (isGemini)
 *
 * After this change:
 *   - All three guard blocks are driven purely by extendedEvents.includes(eventName)
 *   - Any runtime (or arbitrary string) that passes the right extendedHookEvents
 *     array gets exactly those events registered, regardless of its runtime name.
 *
 * This suite proves descriptor-drive by calling applySettingsJsonHooks directly
 * with a controlled extendedHookEvents array and asserting on settings.hooks.
 * No source-grep; purely behavioral.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOKS_DIST_DIR = path.join(REPO_ROOT, 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-hooks.js');

/** Idempotently ensure hooks/dist contains built .js files. */
function ensureHooksDist() {
  if (!fs.existsSync(HOOKS_DIST_DIR) || fs.readdirSync(HOOKS_DIST_DIR).filter(f => f.endsWith('.js')).length === 0) {
    execFileSync(process.execPath, [BUILD_HOOKS_SCRIPT], { stdio: 'pipe' });
  }
}

before(() => {
  ensureHooksDist();
});

const { applySettingsJsonHooks } = require('../bin/install.js');
const { cleanup } = require('./helpers.cjs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Return all hook commands registered under an event key. */
function hooksForEvent(settings, eventName) {
  if (!settings || !settings.hooks || !Array.isArray(settings.hooks[eventName])) return [];
  return settings.hooks[eventName].flatMap(entry =>
    (entry && Array.isArray(entry.hooks) ? entry.hooks : [])
      .map(h => h && h.command)
      .filter(Boolean)
  );
}

/** True if any hook is registered under eventName. */
function hasHooksFor(settings, eventName) {
  return hooksForEvent(settings, eventName).length > 0;
}

/**
 * Create a temporary directory with stub hook files so fs.existsSync guards pass.
 * Returns the targetDir path.
 */
function createStubTargetDir() {
  const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gsd-1076-'));
  const hooksDir = path.join(tmpDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  // Stubs for the hooks applySettingsJsonHooks existsSync-checks
  const stubs = [
    'gsd-check-update.js',
    'gsd-context-monitor.js',
    'gsd-prompt-guard.js',
    'gsd-read-guard.js',
    'gsd-read-injection-scanner.js',
    'gsd-config-reload.js',
    'gsd-workflow-guard.js',
    'gsd-worktree-path-guard.js',
    'gsd-validate-commit.sh',
    'gsd-session-state.sh',
    'gsd-phase-boundary.sh',
    'gsd-graphify-update.sh',
  ];
  const hooksDistDir = path.join(REPO_ROOT, 'hooks', 'dist');
  for (const stub of stubs) {
    const dest = path.join(hooksDir, stub);
    const distSrc = path.join(hooksDistDir, stub);
    if (fs.existsSync(distSrc)) {
      fs.copyFileSync(distSrc, dest);
    } else {
      // Minimal stub so existsSync passes
      const ext = path.extname(stub);
      fs.writeFileSync(dest, ext === '.sh' ? '#!/bin/bash\n# stub\n' : '#!/usr/bin/env node\n// stub\n');
    }
    try { fs.chmodSync(dest, 0o755); } catch { /* Windows */ }
  }
  return tmpDir;
}

function cleanupDir(dir) {
  cleanup(dir);
}

/**
 * Build the minimal opts bag for applySettingsJsonHooks.
 * postToolEvent: 'PostToolUse' (default dialect).
 * All commands: non-null strings so the "command truthy" guard passes.
 */
function buildOpts(targetDir, { runtime, extendedHookEvents }) {
  const hookOpts = { platform: process.platform, runtime };
  const node = process.execPath;
  return {
    runtime,
    isGlobal: true,
    targetDir,
    postToolEvent: 'PostToolUse',
    hookEvents: undefined,         // not the hookEvents dialect — we're testing extendedHookEvents
    extendedHookEvents,
    updateCheckCommand: `${node} "${path.join(targetDir, 'hooks', 'gsd-check-update.js')}"`,
    contextMonitorCommand: `${node} "${path.join(targetDir, 'hooks', 'gsd-context-monitor.js')}"`,
    promptGuardCommand: `${node} "${path.join(targetDir, 'hooks', 'gsd-prompt-guard.js')}"`,
    readGuardCommand: `${node} "${path.join(targetDir, 'hooks', 'gsd-read-guard.js')}"`,
    readInjectionScannerCommand: `${node} "${path.join(targetDir, 'hooks', 'gsd-read-injection-scanner.js')}"`,
    configReloadCommand: `${node} "${path.join(targetDir, 'hooks', 'gsd-config-reload.js')}"`,
    hookOpts,
    localCmd: () => null,
    localShellCmd: () => null,
  };
}

// ─── Suite 1: claude shape (SubagentStop+Stop+PreCompact+FileChanged) ─────────

describe('enh-1076 phase 5f-3: claude extendedHookEvents → SubagentStop/Stop/PreCompact/FileChanged', () => {
  let targetDir;
  let settings;

  before(() => {
    targetDir = createStubTargetDir();
    settings = { hooks: {} };
    const opts = buildOpts(targetDir, {
      runtime: 'claude',
      extendedHookEvents: ['SubagentStop', 'Stop', 'PreCompact', 'FileChanged'],
    });
    applySettingsJsonHooks(settings, opts);
  });

  test('SubagentStop is wired (descriptor-driven)', () => {
    assert.ok(
      hasHooksFor(settings, 'SubagentStop'),
      `Expected SubagentStop hooks; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('Stop is wired (descriptor-driven)', () => {
    assert.ok(
      hasHooksFor(settings, 'Stop'),
      `Expected Stop hooks; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('PreCompact is wired (descriptor-driven)', () => {
    assert.ok(
      hasHooksFor(settings, 'PreCompact'),
      `Expected PreCompact hooks; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('FileChanged is wired (descriptor-driven)', () => {
    assert.ok(
      hasHooksFor(settings, 'FileChanged'),
      `Expected FileChanged hooks; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('cleanup', () => {
    cleanupDir(targetDir);
  });
});

// ─── Suite 2: qwen shape (SubagentStop+Stop+PreCompact, no FileChanged) ───────

describe('enh-1076 phase 5f-3: qwen extendedHookEvents → SubagentStop/Stop/PreCompact only', () => {
  let targetDir;
  let settings;

  before(() => {
    targetDir = createStubTargetDir();
    settings = { hooks: {} };
    const opts = buildOpts(targetDir, {
      runtime: 'qwen',
      extendedHookEvents: ['SubagentStop', 'Stop', 'PreCompact'],
    });
    applySettingsJsonHooks(settings, opts);
  });

  test('SubagentStop is wired', () => {
    assert.ok(hasHooksFor(settings, 'SubagentStop'));
  });

  test('Stop is wired', () => {
    assert.ok(hasHooksFor(settings, 'Stop'));
  });

  test('PreCompact is wired', () => {
    assert.ok(hasHooksFor(settings, 'PreCompact'));
  });

  test('FileChanged is NOT wired (not in extendedHookEvents)', () => {
    assert.strictEqual(
      hasHooksFor(settings, 'FileChanged'),
      false,
      `FileChanged must NOT be wired for qwen shape; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('cleanup', () => {
    cleanupDir(targetDir);
  });
});

// ─── Suite 3: gemini shape (BeforeAgent+AfterAgent+BeforeModel) ───────────────

describe('enh-1076 phase 5f-3: extendedHookEvents → BeforeAgent/AfterAgent/BeforeModel (Gemini-3 backend dialect)', () => {
  let targetDir;
  let settings;

  before(() => {
    targetDir = createStubTargetDir();
    settings = { hooks: {} };
    const opts = buildOpts(targetDir, {
      runtime: 'antigravity',
      extendedHookEvents: ['BeforeAgent', 'AfterAgent', 'BeforeModel'],
    });
    applySettingsJsonHooks(settings, opts);
  });

  test('BeforeAgent is wired', () => {
    assert.ok(
      hasHooksFor(settings, 'BeforeAgent'),
      `Expected BeforeAgent hooks; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('AfterAgent is wired', () => {
    assert.ok(hasHooksFor(settings, 'AfterAgent'));
  });

  test('BeforeModel is wired', () => {
    assert.ok(hasHooksFor(settings, 'BeforeModel'));
  });

  test('SubagentStop is NOT wired (not in extendedHookEvents)', () => {
    assert.strictEqual(
      hasHooksFor(settings, 'SubagentStop'),
      false,
      'SubagentStop must NOT be wired for gemini shape'
    );
  });

  test('FileChanged is NOT wired (not in extendedHookEvents)', () => {
    assert.strictEqual(
      hasHooksFor(settings, 'FileChanged'),
      false,
      'FileChanged must NOT be wired for gemini shape'
    );
  });

  test('cleanup', () => {
    cleanupDir(targetDir);
  });
});

// ─── Suite 4: empty extendedHookEvents → none of the extended events ──────────

describe('enh-1076 phase 5f-3: empty extendedHookEvents → no extended events wired', () => {
  let targetDir;
  let settings;

  before(() => {
    targetDir = createStubTargetDir();
    settings = { hooks: {} };
    // Use runtime='someruntime' to prove it's the descriptor, not the name, that matters
    const opts = buildOpts(targetDir, {
      runtime: 'someruntime',
      extendedHookEvents: [],
    });
    applySettingsJsonHooks(settings, opts);
  });

  const EXTENDED_EVENTS = [
    'SubagentStop', 'Stop', 'PreCompact', 'FileChanged',
    'BeforeAgent', 'AfterAgent', 'BeforeModel',
  ];

  for (const event of EXTENDED_EVENTS) {
    test(`${event} is NOT wired when extendedHookEvents is empty`, () => {
      assert.strictEqual(
        hasHooksFor(settings, event),
        false,
        `${event} must not be wired when extendedHookEvents=[] (runtime=someruntime); hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
      );
    });
  }

  test('cleanup', () => {
    cleanupDir(targetDir);
  });
});

// ─── Suite 5: descriptor-drive is runtime-name-agnostic ───────────────────────
// Pass an arbitrary runtime name ('hypothetical') with SubagentStop in its
// extendedHookEvents. This could NEVER have worked under the old hardcoded check.
// Under the new descriptor-driven guard it MUST work.

describe('enh-1076 phase 5f-3: arbitrary runtime with SubagentStop in descriptor gets it wired', () => {
  let targetDir;
  let settings;

  before(() => {
    targetDir = createStubTargetDir();
    settings = { hooks: {} };
    const opts = buildOpts(targetDir, {
      runtime: 'hypothetical',   // NOT 'claude' or 'qwen' — would have been skipped before
      extendedHookEvents: ['SubagentStop'],
    });
    applySettingsJsonHooks(settings, opts);
  });

  test('SubagentStop IS wired for a hypothetical runtime when descriptor includes it', () => {
    assert.ok(
      hasHooksFor(settings, 'SubagentStop'),
      `SubagentStop must be wired via descriptor even for unknown runtime names; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('Stop is NOT wired (not in extendedHookEvents)', () => {
    assert.strictEqual(hasHooksFor(settings, 'Stop'), false);
  });

  test('cleanup', () => {
    cleanupDir(targetDir);
  });
});

// ─── Suite 6: hooksSurface drive (ADR-857 phase 5g drive 3) ──────────────────
//
// applySettingsJsonHooks is gated by opts.hooksSurface !== 'none'.
// - hooksSurface:'none'         → entire body is skipped; no hooks written
// - hooksSurface:'settings-json'→ hooks are written (even for a runtime whose
//   name was previously hardcoded to skip, e.g. 'opencode')
//
// This proves the skip is driven by the descriptor field, not the runtime name.

describe('enh-1076 phase 5g drive 3: hooksSurface:none skips all hooks regardless of runtime', () => {
  let targetDir;
  let settings;

  before(() => {
    targetDir = createStubTargetDir();
    settings = { hooks: {} };
    // 'claude' would normally write hooks, but hooksSurface:'none' must skip entirely.
    const opts = {
      ...buildOpts(targetDir, { runtime: 'claude', extendedHookEvents: ['SubagentStop'] }),
      hooksSurface: 'none',
    };
    applySettingsJsonHooks(settings, opts);
  });

  test('SessionStart is NOT written when hooksSurface is "none"', () => {
    assert.strictEqual(
      hasHooksFor(settings, 'SessionStart'),
      false,
      `SessionStart must not be written when hooksSurface="none"; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('PostToolUse is NOT written when hooksSurface is "none"', () => {
    assert.strictEqual(hasHooksFor(settings, 'PostToolUse'), false);
  });

  test('PreToolUse is NOT written when hooksSurface is "none"', () => {
    assert.strictEqual(hasHooksFor(settings, 'PreToolUse'), false);
  });

  test('cleanup', () => {
    cleanupDir(targetDir);
  });
});

describe('enh-1076 phase 5g drive 3: hooksSurface:settings-json writes hooks even for previously-skipped runtime name', () => {
  let targetDir;
  let settings;

  before(() => {
    targetDir = createStubTargetDir();
    settings = { hooks: {} };
    // 'opencode' previously was hardcoded to skip hooks; with descriptor drive it
    // should write hooks whenever hooksSurface !== 'none'.
    const opts = {
      ...buildOpts(targetDir, { runtime: 'opencode', extendedHookEvents: [] }),
      hooksSurface: 'settings-json',
    };
    applySettingsJsonHooks(settings, opts);
  });

  test('SessionStart IS written with at least one command when hooksSurface is "settings-json" (even for opencode name)', () => {
    // ensureHooksDist() in before() guarantees hooks/dist is built, so the
    // existsSync guards inside applySettingsJsonHooks pass and commands are registered.
    assert.ok(
      settings.hooks && typeof settings.hooks === 'object',
      `settings.hooks must be initialized when hooksSurface="settings-json"`,
    );
    assert.ok(
      hasHooksFor(settings, 'SessionStart'),
      `settings.hooks.SessionStart must contain at least one registered command when hooksSurface="settings-json"; ` +
      `keys: ${JSON.stringify(Object.keys(settings.hooks))}`,
    );
  });

  test('cleanup', () => {
    cleanupDir(targetDir);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-1077-install-hook-events-dialect-drive.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-1077-install-hook-events-dialect-drive (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * ADR-857 phase 5f-2: hook-events dialect is driven from the registry descriptor.
 *
 * Before this change, postToolEvent and preToolEvent were hardcoded strings
 * derived from runtime-name checks:
 *
 *   (runtime === 'gemini' || runtime === 'antigravity') ? 'AfterTool'  : 'PostToolUse'
 *   (runtime === 'gemini' || runtime === 'antigravity') ? 'BeforeTool' : 'PreToolUse'
 *
 * After phase 5f-2, both are driven by the registry descriptor's
 * `hookEvents` field: hookEvents === 'gemini' → AfterTool/BeforeTool;
 * any other value (or missing) → PostToolUse/PreToolUse.
 *
 * Equivalence (i.e. identical observable behaviour for all runtimes):
 *   hookEvents === 'gemini'  iff  runtime ∈ {gemini, antigravity}
 *
 * This suite asserts the equivalence and the registry-parity invariant:
 * any runtime whose descriptor carries hookEvents='gemini' gets the
 * AfterTool/BeforeTool dialect; all others get PostToolUse/PreToolUse.
 */

const { test, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { install } = require('../bin/install.js');
const { createTempDir, cleanup } = require('./helpers.cjs');

// ─── hooks/dist build guard ───────────────────────────────────────────────────
//
// hooks/dist/ is gitignored and only produced by `npm run build:hooks`.
// In CI the scoped/windows test jobs do NOT run build:hooks before running
// tests, so install() finds no hook files → event arrays come back empty →
// every "expected AfterTool/PostToolUse/BeforeTool/PreToolUse hooks" assertion
// fails. This mirrors the pattern in bug-376-claude-js-hook-gsd-rewriter.test.cjs.

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOKS_DIST_DIR = path.join(REPO_ROOT, 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-hooks.js');

/**
 * Idempotently ensure hooks/dist contains built .js files.
 * Runs build-hooks.js only when the directory is absent or empty of .js files.
 */
function ensureHooksDist() {
  if (!fs.existsSync(HOOKS_DIST_DIR) || fs.readdirSync(HOOKS_DIST_DIR).filter(f => f.endsWith('.js')).length === 0) {
    execFileSync(process.execPath, [BUILD_HOOKS_SCRIPT], { stdio: 'pipe' });
  }
}

before(() => {
  ensureHooksDist();
});

// ─── Registry lookup ──────────────────────────────────────────────────────────

const REGISTRY_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'capability-registry.cjs');
const registry = (() => {
  try { return require(REGISTRY_PATH); } catch { return undefined; }
})();

/**
 * Return the hookEvents dialect for a runtime ID from the live registry.
 * Returns undefined when the registry is absent or the runtime has no descriptor.
 */
function registryHookEvents(runtimeId) {
  return registry?.runtimes?.[runtimeId]?.runtime?.hookEvents;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Collect all hook commands registered under a settings event key. */
function hooksForEvent(settings, eventName) {
  if (!settings || !settings.hooks || !Array.isArray(settings.hooks[eventName])) return [];
  return settings.hooks[eventName].flatMap(entry =>
    (entry && Array.isArray(entry.hooks) ? entry.hooks : [])
      .map(h => h && h.command)
      .filter(Boolean)
  );
}

/** True if at least one hook is registered under eventName. */
function hasHooksFor(settings, eventName) {
  return hooksForEvent(settings, eventName).length > 0;
}

// ─── Suite 1: Gemini-dialect runtimes use AfterTool/BeforeTool ───────────────
//
// Registry runtimes with hookEvents='gemini': gemini, antigravity

describe('enh-1077 phase 5f-2: gemini hookEvents dialect → AfterTool/BeforeTool', () => {
  // #1928: the gemini runtime was removed (Google sunset Gemini CLI
  // 2026-06-18). antigravity — the Gemini-backend successor — is the only
  // remaining runtime whose descriptor carries hookEvents='gemini'.

  describe('antigravity install uses AfterTool/BeforeTool (gemini dialect)', () => {
    let tmpDir;
    let previousCwd;
    let settings;

    beforeEach(() => {
      tmpDir = createTempDir('gsd-1077-antigrav-');
      previousCwd = process.cwd();
      process.chdir(tmpDir);

      const agDir = path.join(tmpDir, '.gemini', 'antigravity');
      fs.mkdirSync(agDir, { recursive: true });
      const result = install(false, 'antigravity');
      settings = result && result.settings;
    });

    afterEach(() => {
      process.chdir(previousCwd);
      cleanup(tmpDir);
    });

    test('registry confirms antigravity hookEvents is "gemini"', () => {
      const he = registryHookEvents('antigravity');
      if (he !== undefined) {
        assert.strictEqual(he, 'gemini',
          'Registry descriptor for antigravity must declare hookEvents="gemini"');
      }
    });

    test('antigravity install returns a settings object', () => {
      assert.ok(settings !== null && typeof settings === 'object',
        'antigravity install must return a non-null settings object');
    });

    test('antigravity install registers at least one hook under AfterTool', () => {
      assert.ok(hasHooksFor(settings, 'AfterTool'),
        `Expected AfterTool hooks on antigravity; got hooks keys: ${JSON.stringify(Object.keys((settings && settings.hooks) || {}))}`);
    });

    test('antigravity install does NOT register context-monitor under PostToolUse', () => {
      const cmds = hooksForEvent(settings, 'PostToolUse');
      const hasMonitor = cmds.some(c => c && c.includes('gsd-context-monitor'));
      assert.strictEqual(hasMonitor, false,
        `antigravity must NOT use PostToolUse for context-monitor; got: ${JSON.stringify(cmds)}`);
    });

    test('antigravity install registers at least one pre-tool hook (prompt-guard) under BeforeTool', () => {
      const cmds = hooksForEvent(settings, 'BeforeTool');
      const hasPromptGuard = cmds.some(c => c && c.includes('gsd-prompt-guard'));
      assert.ok(hasPromptGuard,
        `Expected prompt-guard hook under BeforeTool on antigravity; BeforeTool commands: ${JSON.stringify(cmds)}; hooks keys: ${JSON.stringify(Object.keys((settings && settings.hooks) || {}))}`);
    });

    test('antigravity install does NOT register prompt-guard under PreToolUse (wrong pre-tool dialect)', () => {
      const cmds = hooksForEvent(settings, 'PreToolUse');
      const hasPromptGuard = cmds.some(c => c && c.includes('gsd-prompt-guard'));
      assert.strictEqual(hasPromptGuard, false,
        `antigravity must NOT use PreToolUse for prompt-guard; got PreToolUse commands: ${JSON.stringify(cmds)}`);
    });
  });
});

// ─── Suite 2: Claude-dialect runtimes use PostToolUse/PreToolUse ──────────────
//
// Registry runtimes with hookEvents='claude': claude, augment

describe('enh-1077 phase 5f-2: claude hookEvents dialect → PostToolUse/PreToolUse', () => {
  // ── claude ──

  describe('claude install uses PostToolUse for post-tool hooks', () => {
    let tmpDir;
    let previousCwd;
    let settings;

    beforeEach(() => {
      tmpDir = createTempDir('gsd-1077-claude-');
      previousCwd = process.cwd();
      process.chdir(tmpDir);

      const claudeDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const result = install(false, 'claude');
      settings = result && result.settings;
    });

    afterEach(() => {
      process.chdir(previousCwd);
      cleanup(tmpDir);
    });

    test('registry confirms claude hookEvents is "claude"', () => {
      const he = registryHookEvents('claude');
      if (he !== undefined) {
        assert.strictEqual(he, 'claude',
          'Registry descriptor for claude must declare hookEvents="claude"');
      }
    });

    test('claude install returns a settings object', () => {
      assert.ok(settings !== null && typeof settings === 'object',
        'claude install must return a non-null settings object');
    });

    test('claude install registers at least one hook under PostToolUse', () => {
      assert.ok(hasHooksFor(settings, 'PostToolUse'),
        `Expected PostToolUse hooks on claude; got hooks keys: ${JSON.stringify(Object.keys((settings && settings.hooks) || {}))}`);
    });

    test('claude install does NOT register context-monitor under AfterTool (wrong dialect)', () => {
      const cmds = hooksForEvent(settings, 'AfterTool');
      const hasMonitor = cmds.some(c => c && c.includes('gsd-context-monitor'));
      assert.strictEqual(hasMonitor, false,
        `claude must NOT use AfterTool for context-monitor; got AfterTool commands: ${JSON.stringify(cmds)}`);
    });

    test('claude install registers at least one pre-tool hook (prompt-guard) under PreToolUse', () => {
      const cmds = hooksForEvent(settings, 'PreToolUse');
      const hasPromptGuard = cmds.some(c => c && c.includes('gsd-prompt-guard'));
      assert.ok(hasPromptGuard,
        `Expected prompt-guard hook under PreToolUse on claude; PreToolUse commands: ${JSON.stringify(cmds)}; hooks keys: ${JSON.stringify(Object.keys((settings && settings.hooks) || {}))}`);
    });

    test('claude install does NOT register prompt-guard under BeforeTool (wrong pre-tool dialect)', () => {
      const cmds = hooksForEvent(settings, 'BeforeTool');
      const hasPromptGuard = cmds.some(c => c && c.includes('gsd-prompt-guard'));
      assert.strictEqual(hasPromptGuard, false,
        `claude must NOT use BeforeTool for prompt-guard; got BeforeTool commands: ${JSON.stringify(cmds)}`);
    });
  });

  // ── augment ──

  describe('augment install uses PostToolUse/PreToolUse (claude dialect)', () => {
    let tmpDir;
    let previousCwd;
    let settings;

    beforeEach(() => {
      tmpDir = createTempDir('gsd-1077-augment-');
      previousCwd = process.cwd();
      process.chdir(tmpDir);

      const augDir = path.join(tmpDir, '.augment');
      fs.mkdirSync(augDir, { recursive: true });
      const result = install(false, 'augment');
      settings = result && result.settings;
    });

    afterEach(() => {
      process.chdir(previousCwd);
      cleanup(tmpDir);
    });

    test('registry confirms augment hookEvents is "claude"', () => {
      const he = registryHookEvents('augment');
      if (he !== undefined) {
        assert.strictEqual(he, 'claude',
          'Registry descriptor for augment must declare hookEvents="claude"');
      }
    });

    test('augment install returns a settings object', () => {
      assert.ok(settings !== null && typeof settings === 'object',
        'augment install must return a non-null settings object');
    });

    test('augment install registers at least one hook under PostToolUse', () => {
      assert.ok(hasHooksFor(settings, 'PostToolUse'),
        `Expected PostToolUse hooks on augment; got hooks keys: ${JSON.stringify(Object.keys((settings && settings.hooks) || {}))}`);
    });

    test('augment install does NOT register context-monitor under AfterTool', () => {
      const cmds = hooksForEvent(settings, 'AfterTool');
      const hasMonitor = cmds.some(c => c && c.includes('gsd-context-monitor'));
      assert.strictEqual(hasMonitor, false,
        `augment must NOT use AfterTool for context-monitor; got: ${JSON.stringify(cmds)}`);
    });

    test('augment install registers at least one pre-tool hook (prompt-guard) under PreToolUse', () => {
      const cmds = hooksForEvent(settings, 'PreToolUse');
      const hasPromptGuard = cmds.some(c => c && c.includes('gsd-prompt-guard'));
      assert.ok(hasPromptGuard,
        `Expected prompt-guard hook under PreToolUse on augment; PreToolUse commands: ${JSON.stringify(cmds)}; hooks keys: ${JSON.stringify(Object.keys((settings && settings.hooks) || {}))}`);
    });

    test('augment install does NOT register prompt-guard under BeforeTool (wrong pre-tool dialect)', () => {
      const cmds = hooksForEvent(settings, 'BeforeTool');
      const hasPromptGuard = cmds.some(c => c && c.includes('gsd-prompt-guard'));
      assert.strictEqual(hasPromptGuard, false,
        `augment must NOT use BeforeTool for prompt-guard; got BeforeTool commands: ${JSON.stringify(cmds)}`);
    });
  });
});

// ─── Suite 3: Registry-parity invariant ──────────────────────────────────────
//
// For every runtime in the registry that exposes a settings.json surface
// (i.e. hookEvents is defined), assert that the installed hook dialect matches
// the registry value. This is the generative-fix parity assertion
// (DEFECT.GENERATIVE-FIX): adding a new runtime with hookEvents to the
// registry automatically requires a passing install test for that runtime.

describe('enh-1077 phase 5f-2: registry-parity — hookEvents descriptor drives install dialect', () => {
  test('all registry runtimes with hookEvents use the matching install dialect', () => {
    if (!registry || !registry.runtimes) {
      // Registry absent — skip parity check (equivalence still verified above)
      return;
    }

    // Runtimes that have settings.json surfaces and a hookEvents descriptor
    const SETTINGS_JSON_RUNTIMES = ['claude', 'antigravity', 'augment', 'qwen', 'hermes', 'codebuddy'];

    const failures = [];

    for (const runtimeId of SETTINGS_JSON_RUNTIMES) {
      const he = registryHookEvents(runtimeId);
      if (he === undefined) continue; // no hookEvents in descriptor — skip

      const expectedPostEvent = he === 'gemini' ? 'AfterTool' : 'PostToolUse';
      const unexpectedPostEvent = he === 'gemini' ? 'PostToolUse' : 'AfterTool';
      const expectedPreEvent = he === 'gemini' ? 'BeforeTool' : 'PreToolUse';
      const unexpectedPreEvent = he === 'gemini' ? 'PreToolUse' : 'BeforeTool';

      const previousCwd = process.cwd();
      const tmpDir = createTempDir(`gsd-1077-parity-${runtimeId}-`);
      try {
        process.chdir(tmpDir);
        const result = install(false, runtimeId);
        const settings = result && result.settings;
        if (!settings) continue; // non-settings-json surface, skip

        // Post-tool event assertions
        const hasExpected = hasHooksFor(settings, expectedPostEvent);
        const hasUnexpected = hooksForEvent(settings, unexpectedPostEvent)
          .some(c => c && c.includes('gsd-context-monitor'));

        if (!hasExpected) {
          failures.push(`${runtimeId}: expected context-monitor hook under ${expectedPostEvent} (hookEvents=${he}), but none found`);
        }
        if (hasUnexpected) {
          failures.push(`${runtimeId}: must NOT register context-monitor under ${unexpectedPostEvent}, but it was found`);
        }

        // Pre-tool event assertions: prompt-guard must land under the dialect-correct key.
        const preToolCmdsExpected = hooksForEvent(settings, expectedPreEvent);
        const hasPromptGuardExpected = preToolCmdsExpected.some(c => c && c.includes('gsd-prompt-guard'));
        const preToolCmdsUnexpected = hooksForEvent(settings, unexpectedPreEvent);
        const hasPromptGuardUnexpected = preToolCmdsUnexpected.some(c => c && c.includes('gsd-prompt-guard'));

        if (!hasPromptGuardExpected) {
          failures.push(`${runtimeId}: expected prompt-guard hook under ${expectedPreEvent} (hookEvents=${he}), but none found; ${expectedPreEvent} cmds: ${JSON.stringify(preToolCmdsExpected)}`);
        }
        if (hasPromptGuardUnexpected) {
          failures.push(`${runtimeId}: must NOT register prompt-guard under ${unexpectedPreEvent} (hookEvents=${he}), but it was found`);
        }
      } finally {
        process.chdir(previousCwd);
        cleanup(tmpDir);
      }
    }

    assert.deepEqual(failures, [],
      'Registry-parity failures (hookEvents descriptor must drive install dialect):\n' +
      failures.join('\n'));
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-788-qwen-hook-events.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-788-qwen-hook-events (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Enhancement #788: Expand Qwen Code hook-event coverage.
 *
 * Qwen Code supports 15 hook events; gsd previously registered only
 * SessionStart and PostToolUse.  This suite asserts that a Qwen install
 * registers the 3 new high-value events:
 *   - SubagentStop  — subagent lifecycle finalisation (context tracking)
 *   - Stop          — model stop / final-response hook (context tracking)
 *   - PreCompact    — pre-compaction awareness (context tracking)
 *
 * All three are wired to gsd-context-monitor.js — the same hook used for
 * PostToolUse — so context headroom warnings surface at these moments too.
 *
 * Note: UserPromptSubmit is NOT wired — gsd-prompt-guard exits unless
 * tool_name is Write|Edit (PreToolUse shape), so it would be a no-op for
 * the UserPromptSubmit payload.  Deferred to a follow-on issue.
 *
 * Also asserts the inverse: Claude Code installs do NOT gain these events
 * (strict isQwen scope guard).
 *
 * Source: https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { install, uninstall, validateHookFields } = require('../bin/install.js');
const { createTempDir, cleanup } = require('./helpers.cjs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract all hook commands registered under `eventName` from settings. */
function hooksForEvent(settings, eventName) {
  if (!settings || !settings.hooks || !Array.isArray(settings.hooks[eventName])) return [];
  return settings.hooks[eventName].flatMap(entry =>
    (entry && Array.isArray(entry.hooks) ? entry.hooks : [])
      .map(h => h && h.command)
      .filter(Boolean)
  );
}

// Stub JS hook files that the installer checks with fs.existsSync() so hook
// registration guards pass even when hooks/dist/ isn't built.
const HOOKS_SRC = path.join(__dirname, '..', 'hooks');
const STUB_HOOKS = [
  'gsd-context-monitor.js',
  'gsd-prompt-guard.js',
  'gsd-check-update.js',
  'gsd-config-reload.js', // Added in #770
];

function stubHooksIntoTarget(targetDir) {
  const hooksDest = path.join(targetDir, 'hooks');
  fs.mkdirSync(hooksDest, { recursive: true });
  for (const hookFile of STUB_HOOKS) {
    const src = path.join(HOOKS_SRC, hookFile);
    const dest = path.join(hooksDest, hookFile);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    } else {
      // Minimal stub so existsSync passes
      fs.writeFileSync(dest, '#!/usr/bin/env node\n// stub\n');
    }
    try { fs.chmodSync(dest, 0o755); } catch { /* Windows */ }
  }
}

/**
 * Persist in-memory settings to disk, simulating what finishInstall() does
 * (finishInstall is not exported).  Required for tests that call install()
 * twice and need the second call to read the first call's hook registrations.
 */
function persistSettings(settingsPath, settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(validateHookFields(settings), null, 2) + '\n', 'utf8');
}

// ─── Suite 1: Qwen — new events are registered ───────────────────────────────

describe('enh-788: Qwen install registers 3 new hook events', () => {
  let tmpDir;
  let previousCwd;
  let settings;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-788-qwen-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);

    const targetDir = path.join(tmpDir, '.qwen');
    fs.mkdirSync(targetDir, { recursive: true });
    // Pre-populate hook files so installer registration guards (fs.existsSync)
    // pass and hooks are actually registered in settings.json.
    stubHooksIntoTarget(targetDir);

    const result = install(false, 'qwen');
    settings = result.settings;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('install returns a settings object (not null)', () => {
    assert.ok(settings !== null && typeof settings === 'object',
      'Qwen install must return a non-null settings object');
  });

  test('SubagentStop event is registered with at least one hook', () => {
    const cmds = hooksForEvent(settings, 'SubagentStop');
    assert.ok(cmds.length > 0,
      `Expected SubagentStop hooks; got hooks: ${JSON.stringify(settings && settings.hooks)}`);
  });

  test('Stop event is registered with at least one hook', () => {
    const cmds = hooksForEvent(settings, 'Stop');
    assert.ok(cmds.length > 0,
      `Expected Stop hooks; got hooks: ${JSON.stringify(settings && settings.hooks)}`);
  });

  test('PreCompact event is registered with at least one hook', () => {
    const cmds = hooksForEvent(settings, 'PreCompact');
    assert.ok(cmds.length > 0,
      `Expected PreCompact hooks; got hooks: ${JSON.stringify(settings && settings.hooks)}`);
  });

  test('UserPromptSubmit is NOT registered (handler not yet implemented for that payload shape)', () => {
    // gsd-prompt-guard exits unless tool_name is Write|Edit — it is a no-op
    // for UserPromptSubmit payloads.  Registration is deferred until a
    // dedicated hook can process the user-prompt payload shape.
    const cmds = hooksForEvent(settings, 'UserPromptSubmit');
    assert.strictEqual(cmds.length, 0,
      `UserPromptSubmit should NOT be registered yet; got: ${JSON.stringify(cmds)}`);
  });

  test('SubagentStop / Stop / PreCompact all use gsd-context-monitor', () => {
    for (const event of ['SubagentStop', 'Stop', 'PreCompact']) {
      const cmds = hooksForEvent(settings, event);
      assert.ok(
        cmds.some(c => c.includes('gsd-context-monitor')),
        `Event ${event} should use gsd-context-monitor; got commands: ${JSON.stringify(cmds)}`
      );
    }
  });

  test('FileChanged is NOT registered for Qwen (Claude-only event)', () => {
    // gsd-config-reload / FileChanged is a Claude Code-only registration.
    // Qwen does not support the FileChanged hook event at all.
    const cmds = hooksForEvent(settings, 'FileChanged');
    assert.strictEqual(cmds.length, 0,
      `FileChanged should NOT be registered for Qwen; got: ${JSON.stringify(cmds)}`);
  });
});

// ─── Suite 2: Claude install DOES get the context events (since #770) ───────
// Note: Prior to #770, these were Qwen-only events.  #770 extended them to
// Claude Code.  This suite is updated to match the new expected behavior.

describe('enh-788 (updated by #770): Claude install registers context lifecycle events', () => {
  let tmpDir;
  let previousCwd;
  let settings;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-788-claude-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
    stubHooksIntoTarget(path.join(tmpDir, '.claude'));

    const result = install(false, 'claude', { installerMigrations: [] });
    settings = result && result.settings;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('Claude install registers SubagentStop (since #770)', () => {
    const cmds = hooksForEvent(settings, 'SubagentStop');
    assert.ok(cmds.length > 0,
      `Claude should have SubagentStop since #770; got: ${JSON.stringify(cmds)}`);
  });

  test('Claude install registers Stop (since #770)', () => {
    const cmds = hooksForEvent(settings, 'Stop');
    assert.ok(cmds.length > 0,
      `Claude should have Stop since #770; got: ${JSON.stringify(cmds)}`);
  });

  test('Claude install registers PreCompact (since #770)', () => {
    const cmds = hooksForEvent(settings, 'PreCompact');
    assert.ok(cmds.length > 0,
      `Claude should have PreCompact since #770; got: ${JSON.stringify(cmds)}`);
  });
});

// ─── Suite 3: Idempotency — persisted reinstall does not duplicate hooks ──────

describe('enh-788: Qwen install is idempotent across persisted reinstalls', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-788-idem-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);

    const targetDir = path.join(tmpDir, '.qwen');
    fs.mkdirSync(targetDir, { recursive: true });
    stubHooksIntoTarget(targetDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('re-running after persisted first install does not duplicate hook entries', () => {
    // First install: get settings and persist to disk (simulating finishInstall)
    const result1 = install(false, 'qwen');
    persistSettings(result1.settingsPath, result1.settings);

    // Second install: reads the persisted settings.json — dedup guards apply
    process.chdir(tmpDir);
    const result2 = install(false, 'qwen');
    const s2 = result2.settings;

    for (const event of ['SubagentStop', 'Stop', 'PreCompact']) {
      const cmds = hooksForEvent(s2, event);
      assert.strictEqual(cmds.length, 1,
        `Event ${event} should have exactly 1 hook command after idempotent reinstall; got ${cmds.length}: ${JSON.stringify(cmds)}`);
    }
  });
});

// ─── Suite 4: Uninstall removes the new event registrations ──────────────────

describe('enh-788: Qwen uninstall removes new hook event entries', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-788-uninstall-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);

    const targetDir = path.join(tmpDir, '.qwen');
    fs.mkdirSync(targetDir, { recursive: true });
    stubHooksIntoTarget(targetDir);

    // Install and persist to disk so uninstall has a settings.json to clean
    const result = install(false, 'qwen');
    persistSettings(result.settingsPath, result.settings);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('settings.json hook entries are removed on uninstall', () => {
    uninstall(false, 'qwen');
    const settingsPath = path.join(tmpDir, '.qwen', 'settings.json');
    if (!fs.existsSync(settingsPath)) return; // file removed entirely is fine
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    for (const event of ['SubagentStop', 'Stop', 'PreCompact']) {
      const cmds = hooksForEvent(settings, event);
      assert.strictEqual(cmds.length, 0,
        `After uninstall, ${event} should have 0 hooks; got: ${JSON.stringify(cmds)}`);
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3735-profiles-core-includes-surface.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3735-profiles-core-includes-surface (consolidation epic #1969 B5 #1974)", () => {
'use strict';
/**
 * Regression test for #3735: PROFILES.core must include 'surface' in its
 * resolved closure so that --profile=core users can expand via
 * /gsd:surface enable <cluster> — the advertised use-case from ADR-0011.
 *
 * Stage 2 (RED): This test must fail before the fix is applied.
 * Stage 3 (GREEN): This test must pass after 'surface' is added to PROFILES.core.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  resolveProfile,
  loadSkillsManifest,
} = require('../gsd-core/bin/lib/install-profiles.cjs');

const REAL_COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');

describe('PROFILES.core — ADR-0011 expand contract', () => {
  test("PROFILES.core includes 'surface' so users can expand via /gsd:surface enable", () => {
    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const result = resolveProfile({ modes: ['core'], manifest });

    assert.ok(result.skills instanceof Set,
      'resolveProfile must return a skills Set for core profile');

    // The primary assertion: surface must be in the resolved closure.
    // ADR-0011 documents that --profile=core users expand via /gsd:surface enable <cluster>.
    // That sub-command is only available if surface.md is staged — which requires it to be
    // in the resolved set for the core profile.
    assert.ok(result.skills.has('surface'),
      `PROFILES.core resolved closure must include 'surface'; got: [${[...result.skills].sort().join(', ')}]`);
  });

  // Counter-test: 'forensics' is NOT in core — proves the assertion above is selective,
  // not vacuously true for all skills.
  test("PROFILES.core does NOT include 'forensics' (selective assertion counter-check)", () => {
    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const result = resolveProfile({ modes: ['core'], manifest });

    assert.ok(result.skills instanceof Set);
    assert.ok(!result.skills.has('forensics'),
      `'forensics' should NOT be in core closure — it is a specialist skill, not a core loop skill`);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-770-claude-hook-events.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-770-claude-hook-events (consolidation epic #1969 B5 #1974)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Enhancement #770: Register Claude Code lifecycle hooks (SubagentStop / Stop /
 * PreCompact / FileChanged).
 *
 * Claude Code now supports the same SubagentStop, Stop, and PreCompact events
 * that were wired for Qwen Code in #788.  This suite asserts:
 *
 *   1. Claude Code installs register SubagentStop, Stop, and PreCompact, each
 *      wired to gsd-context-monitor.js (same as Qwen).
 *   2. Claude Code installs register a FileChanged hook for .planning/config.json
 *      wired to gsd-config-reload.js (new hook; hot-reloads gsd config).
 *   3. All four registrations are idempotent (reinstall does not duplicate).
 *   4. Uninstall removes all four event registrations.
 *   5. The gsd-config-reload.js hook script exists in hooks/ and has the
 *      expected structure (reads on stdin, emits additionalContext or exits 0).
 *   6. The hooks/hooks.json plugin manifest includes the new events.
 *
 * Source: https://code.claude.com/docs/en/hooks
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { install, uninstall, validateHookFields } = require('../bin/install.js');
const { createTempDir, cleanup } = require('./helpers.cjs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract all hook commands registered under `eventName` from settings. */
function hooksForEvent(settings, eventName) {
  if (!settings || !settings.hooks || !Array.isArray(settings.hooks[eventName])) return [];
  return settings.hooks[eventName].flatMap(entry =>
    (entry && Array.isArray(entry.hooks) ? entry.hooks : [])
      .map(h => h && h.command)
      .filter(Boolean)
  );
}

/** Extract all matchers registered under `eventName` from settings. */
function matchersForEvent(settings, eventName) {
  if (!settings || !settings.hooks || !Array.isArray(settings.hooks[eventName])) return [];
  return settings.hooks[eventName]
    .map(entry => entry && entry.matcher)
    .filter(Boolean);
}

const HOOKS_SRC = path.join(__dirname, '..', 'hooks');
// Hooks the installer existsSync-checks before registering; must be present
// in targetDir/hooks/ so the registration guards pass.
const STUB_HOOKS = [
  'gsd-context-monitor.js',
  'gsd-prompt-guard.js',
  'gsd-check-update.js',
  'gsd-config-reload.js',
];

/**
 * Pre-populate targetDir/hooks/ with stub hook files so the installer's
 * fs.existsSync guards pass even when hooks/dist/ is absent (e.g. CI without
 * a build step).  Each test suite passes its own per-test tmpDir/.claude path
 * so stubs are isolated to that test's temp directory — no shared filesystem
 * state, no cross-test races.
 *
 * When hooks/dist/ DOES exist (local dev with npm run build:hooks), the
 * installer copies real files over these stubs during install() — that is
 * fine and correct.
 */
function stubHooksIntoTarget(targetDir) {
  const hooksDest = path.join(targetDir, 'hooks');
  fs.mkdirSync(hooksDest, { recursive: true });
  for (const hookFile of STUB_HOOKS) {
    const src = path.join(HOOKS_SRC, hookFile);
    const dest = path.join(hooksDest, hookFile);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    } else {
      // Minimal stub so existsSync passes
      fs.writeFileSync(dest, '#!/usr/bin/env node\n// stub\n');
    }
    try { fs.chmodSync(dest, 0o755); } catch { /* Windows */ }
  }
}

function persistSettings(settingsPath, settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(validateHookFields(settings), null, 2) + '\n', 'utf8');
}

// ─── Suite 1: Claude — new context monitor events are registered ──────────────

describe('enh-770: Claude install registers SubagentStop / Stop / PreCompact context hooks', () => {
  let tmpDir;
  let previousCwd;
  let settings;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-770-claude-ctx-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
    stubHooksIntoTarget(path.join(tmpDir, '.claude'));

    const result = install(false, 'claude', { installerMigrations: [] });
    settings = result && result.settings;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('install returns a settings object (not null)', () => {
    assert.ok(settings !== null && typeof settings === 'object',
      'Claude install must return a non-null settings object');
  });

  test('SubagentStop event is registered with at least one hook', () => {
    const cmds = hooksForEvent(settings, 'SubagentStop');
    assert.ok(cmds.length > 0,
      `Expected SubagentStop hooks; got hooks: ${JSON.stringify(settings && settings.hooks)}`);
  });

  test('Stop event is registered with at least one hook', () => {
    const cmds = hooksForEvent(settings, 'Stop');
    assert.ok(cmds.length > 0,
      `Expected Stop hooks; got hooks: ${JSON.stringify(settings && settings.hooks)}`);
  });

  test('PreCompact event is registered with at least one hook', () => {
    const cmds = hooksForEvent(settings, 'PreCompact');
    assert.ok(cmds.length > 0,
      `Expected PreCompact hooks; got hooks: ${JSON.stringify(settings && settings.hooks)}`);
  });

  test('SubagentStop / Stop / PreCompact all use gsd-context-monitor', () => {
    for (const event of ['SubagentStop', 'Stop', 'PreCompact']) {
      const cmds = hooksForEvent(settings, event);
      assert.ok(
        cmds.some(c => c.includes('gsd-context-monitor')),
        `Event ${event} should use gsd-context-monitor; got commands: ${JSON.stringify(cmds)}`
      );
    }
  });
});

// ─── Suite 2: Claude — FileChanged hook for config hot-reload ─────────────────

describe('enh-770: Claude install registers FileChanged hook for .planning/config.json', () => {
  let tmpDir;
  let previousCwd;
  let settings;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-770-filechanged-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
    stubHooksIntoTarget(path.join(tmpDir, '.claude'));

    const result = install(false, 'claude', { installerMigrations: [] });
    settings = result && result.settings;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('FileChanged event is registered with at least one hook', () => {
    const cmds = hooksForEvent(settings, 'FileChanged');
    assert.ok(cmds.length > 0,
      `Expected FileChanged hooks; got hooks: ${JSON.stringify(settings && settings.hooks)}`);
  });

  test('FileChanged hook uses gsd-config-reload', () => {
    const cmds = hooksForEvent(settings, 'FileChanged');
    assert.ok(
      cmds.some(c => c.includes('gsd-config-reload')),
      `FileChanged should use gsd-config-reload; got commands: ${JSON.stringify(cmds)}`
    );
  });

  test('FileChanged hook has a matcher targeting .planning/config.json', () => {
    const matchers = matchersForEvent(settings, 'FileChanged');
    assert.ok(
      matchers.some(m => m && m.includes('config.json')),
      `FileChanged matcher should target config.json; got matchers: ${JSON.stringify(matchers)}`
    );
  });
});

// ─── Suite 3: Idempotency ─────────────────────────────────────────────────────

describe('enh-770: Claude install is idempotent for the new hook events', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-770-idem-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
    stubHooksIntoTarget(path.join(tmpDir, '.claude'));
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('re-running after persisted first install does not duplicate context monitor hooks', () => {
    const result1 = install(false, 'claude', { installerMigrations: [] });
    persistSettings(result1.settingsPath, result1.settings);

    process.chdir(tmpDir);
    const result2 = install(false, 'claude', { installerMigrations: [] });
    const s2 = result2.settings;

    for (const event of ['SubagentStop', 'Stop', 'PreCompact']) {
      const cmds = hooksForEvent(s2, event);
      assert.strictEqual(cmds.length, 1,
        `Event ${event} should have exactly 1 hook after idempotent reinstall; got ${cmds.length}: ${JSON.stringify(cmds)}`);
    }
  });

  test('re-running after persisted first install does not duplicate FileChanged hook', () => {
    const result1 = install(false, 'claude', { installerMigrations: [] });
    persistSettings(result1.settingsPath, result1.settings);

    process.chdir(tmpDir);
    const result2 = install(false, 'claude', { installerMigrations: [] });
    const s2 = result2.settings;

    const cmds = hooksForEvent(s2, 'FileChanged');
    assert.strictEqual(cmds.length, 1,
      `FileChanged should have exactly 1 hook after idempotent reinstall; got ${cmds.length}: ${JSON.stringify(cmds)}`);
  });
});

// ─── Suite 4: Uninstall removes registrations ─────────────────────────────────

describe('enh-770: Uninstall removes new hook event entries', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-770-uninstall-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
    stubHooksIntoTarget(path.join(tmpDir, '.claude'));

    const result = install(false, 'claude', { installerMigrations: [] });
    persistSettings(result.settingsPath, result.settings);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('settings.json hook entries are removed on uninstall', () => {
    uninstall(false, 'claude', { installerMigrations: [] });
    const settingsPath = path.join(tmpDir, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) return; // file removed entirely is fine
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    for (const event of ['SubagentStop', 'Stop', 'PreCompact', 'FileChanged']) {
      const cmds = hooksForEvent(settings, event);
      assert.strictEqual(cmds.length, 0,
        `After uninstall, ${event} should have 0 hooks; got: ${JSON.stringify(cmds)}`);
    }
  });
});

// ─── Suite 5: gsd-config-reload.js hook script exists and has correct shape ───

describe('enh-770: gsd-config-reload.js hook script', () => {
  const reloadScript = path.join(__dirname, '..', 'hooks', 'gsd-config-reload.js');

  test('gsd-config-reload.js exists in hooks/', () => {
    assert.ok(fs.existsSync(reloadScript),
      `gsd-config-reload.js must exist at ${reloadScript}`);
  });

  test('gsd-config-reload.js contains the gsd-hook-version stamp', () => {
    // allow-test-rule: runtime-contract-is-the-product — the stamp template token (see #770)
    // IS the product surface that the installer must find and replace with the
    // real version at copy time; asserting its presence is required.
    const content = fs.readFileSync(reloadScript, 'utf8');
    assert.ok(
      content.includes('gsd-hook-version'),
      'gsd-config-reload.js must contain the gsd-hook-version stamp for installer stamping'
    );
  });

  test('gsd-config-reload.js reads from stdin and emits JSON output', () => {
    // allow-test-rule: runtime-contract-is-the-product — the stdin-read and (see #770)
    // JSON-emit pattern IS the hook contract; asserting its presence is required.
    const content = fs.readFileSync(reloadScript, 'utf8');
    assert.ok(
      content.includes('process.stdin') && content.includes('JSON.stringify'),
      'gsd-config-reload.js must read stdin and emit JSON output per hook protocol'
    );
  });

  test('gsd-config-reload.js targets the FileChanged hook event', () => {
    // allow-test-rule: runtime-contract-is-the-product — the hookEventName is (see #770)
    // the protocol surface; asserting its presence verifies the contract.
    const content = fs.readFileSync(reloadScript, 'utf8');
    assert.ok(
      content.includes('FileChanged'),
      'gsd-config-reload.js must reference FileChanged in its hookSpecificOutput'
    );
  });
});

// ─── Suite 6: hooks.json plugin manifest includes new events ──────────────────

describe('enh-770: hooks/hooks.json plugin manifest includes new hook events', () => {
  const hooksJsonPath = path.join(__dirname, '..', 'hooks', 'hooks.json');

  test('hooks.json exists', () => {
    assert.ok(fs.existsSync(hooksJsonPath), `hooks.json must exist at ${hooksJsonPath}`);
  });

  test('hooks.json contains SubagentStop event', () => {
    // allow-test-rule: runtime-contract-is-the-product — hooks.json IS the (see #770)
    // plugin manifest surface that Claude Code reads at plugin load time.
    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.ok(
      content.hooks && content.hooks.SubagentStop,
      'hooks.json must contain SubagentStop'
    );
  });

  test('hooks.json contains Stop event', () => {
    // allow-test-rule: runtime-contract-is-the-product — hooks.json IS the (see #770)
    // plugin manifest surface that Claude Code reads at plugin load time.
    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.ok(
      content.hooks && content.hooks.Stop,
      'hooks.json must contain Stop'
    );
  });

  test('hooks.json contains PreCompact event', () => {
    // allow-test-rule: runtime-contract-is-the-product — hooks.json IS the (see #770)
    // plugin manifest surface that Claude Code reads at plugin load time.
    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.ok(
      content.hooks && content.hooks.PreCompact,
      'hooks.json must contain PreCompact'
    );
  });

  test('hooks.json contains FileChanged event', () => {
    // allow-test-rule: runtime-contract-is-the-product — hooks.json IS the (see #770)
    // plugin manifest surface that Claude Code reads at plugin load time.
    const content = JSON.parse(fs.readFileSync(hooksJsonPath, 'utf8'));
    assert.ok(
      content.hooks && content.hooks.FileChanged,
      'hooks.json must contain FileChanged'
    );
  });
});

// ─── Suite 7: managed-hooks-registry includes gsd-config-reload.js ───────────

describe('enh-770: managed-hooks-registry includes gsd-config-reload.js', () => {
  test('MANAGED_HOOKS array includes gsd-config-reload.js', () => {
    const { MANAGED_HOOKS } = require('../hooks/managed-hooks-registry.cjs');
    assert.ok(
      MANAGED_HOOKS.includes('gsd-config-reload.js'),
      `MANAGED_HOOKS must include gsd-config-reload.js; got: ${JSON.stringify(MANAGED_HOOKS)}`
    );
  });
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1754-js-hook-guard.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1754-js-hook-guard (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression tests for bug #1754
 *
 * The installer must NOT register .js hook entries in settings.json when the
 * corresponding .js file does not exist at the target path. The original bug:
 * on fresh installs where hooks/dist/ was missing from the npm package (as in
 * v1.32.0), the hook copy step produced no files, yet the registration step
 * ran unconditionally for .js hooks — leaving users with "PreToolUse:Bash
 * hook error" on every tool invocation.
 *
 * The .sh hooks already had fs.existsSync() guards (added in #1817). This
 * test verifies the same defensive pattern exists for all .js hooks.
 */

'use strict';

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const INSTALL_SRC = path.join(__dirname, '..', 'bin', 'install.js');
// ADR-857 phase 5f-1b: settings-json hook registration moved to runtime-hooks-surface.cts.
const HOOKS_SURFACE_SRC = path.join(__dirname, '..', 'src', 'runtime-hooks-surface.cts');

const JS_HOOKS = [
  { name: 'gsd-check-update.js',      registrationAnchor: 'hasGsdUpdateHook' },
  { name: 'gsd-context-monitor.js',   registrationAnchor: 'hasContextMonitorHook' },
  { name: 'gsd-prompt-guard.js',      registrationAnchor: 'hasPromptGuardHook' },
  { name: 'gsd-read-guard.js',        registrationAnchor: 'hasReadGuardHook' },
  { name: 'gsd-workflow-guard.js',    registrationAnchor: 'hasWorkflowGuardHook' },
  { name: 'gsd-worktree-path-guard.js', registrationAnchor: 'hasWorktreePathGuardHook' },
  { name: 'gsd-write-guard.js',         registrationAnchor: 'hasWriteGuardHook' },
];

describe('bug #1754: .js hook registration guards', () => {
  let src;

  before(() => {
    // ADR-857 phase 5f-1b: hook registration moved to runtime-hooks-surface.cts.
    // Concatenate both sources so structural assertions find patterns in either file.
    const installSrc = fs.readFileSync(INSTALL_SRC, 'utf-8');
    let hooksSurfaceSrc = '';
    try { hooksSurfaceSrc = fs.readFileSync(HOOKS_SURFACE_SRC, 'utf-8'); } catch { /* ok */ }
    src = installSrc + '\n' + hooksSurfaceSrc;
  });

  for (const { name, registrationAnchor } of JS_HOOKS) {
    describe(`${name} registration`, () => {
      test(`install.js checks file existence before registering ${name}`, () => {
        // Find the registration block by locating the "has...Hook" variable
        const anchorIdx = src.indexOf(registrationAnchor);
        assert.ok(
          anchorIdx !== -1,
          `${registrationAnchor} variable not found in install.js`
        );

        // Extract a window around the registration block to find the guard
        const blockStart = anchorIdx;
        const blockEnd = Math.min(src.length, anchorIdx + 1200);
        const block = src.slice(blockStart, blockEnd);

        // The block must contain an fs.existsSync check for the hook file
        assert.ok(
          block.includes('fs.existsSync') || block.includes('existsSync'),
          `install.js must call fs.existsSync on the target path before registering ${name} ` +
          `in settings.json. Without this guard, hooks are registered even when the .js file ` +
          `was never copied (the root cause of #1754).`
        );
      });

      test(`install.js emits a warning when ${name} is missing`, () => {
        // The hook file name (without extension) should appear in a warning message
        const hookBaseName = name.replace('.js', '');
        const warnPattern = `Skipped`;
        const anchorIdx = src.indexOf(registrationAnchor);
        const block = src.slice(anchorIdx, Math.min(src.length, anchorIdx + 1200));

        assert.ok(
          block.includes(warnPattern) && block.includes(hookBaseName),
          `install.js must emit a skip warning when ${name} is not found at the target path`
        );
      });
    });
  }

  test('all .js hooks use the same guard pattern as .sh hooks', () => {
    // Count existsSync calls in the hook registration section.
    // There should be guards for all JS hooks plus the existing SH hooks.
    // This test ensures new hooks added in the future follow the same pattern.
    // ADR-857 phase 5f-1b: registration moved to runtime-hooks-surface.cts so scan the
    // full concatenated source (install.js + runtime-hooks-surface.cts) rather than slicing.
    const registrationSection = src;

    // Count unique hook file existence checks (pattern: path.join(targetDir, 'hooks', 'gsd-*.js'))
    const jsGuards = (registrationSection.match(/gsd-[\w-]+\.js.*not found at target/g) || []);
    const shGuards = (registrationSection.match(/gsd-[\w-]+\.sh.*not found at target/g) || []);

    assert.ok(
      jsGuards.length >= JS_HOOKS.length,
      `Expected at least ${JS_HOOKS.length} .js hook guards, found ${jsGuards.length}. ` +
      `Every .js hook registration must check file existence before registering.`
    );

    assert.ok(
      shGuards.length >= 3,
      `Expected at least 3 .sh hook guards (validate-commit, session-state, phase-boundary), ` +
      `found ${shGuards.length}.`
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1817-sh-hook-guard.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1817-sh-hook-guard (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression tests for bug #1817
 *
 * The installer must NOT register .sh hook entries in settings.json when the
 * corresponding .sh file does not exist at the target path. The original bug:
 * v1.32.0's npm package omitted the .sh files from hooks/dist/, so the copy
 * step produced no files, yet the registration step ran unconditionally —
 * leaving users with hook errors on every tool invocation.
 *
 * Defensive guard: before registering each .sh hook in settings.json,
 * install.js must verify the target file exists. If it doesn't, skip
 * registration and emit a warning.
 */

'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const INSTALL_SRC = path.join(__dirname, '..', 'bin', 'install.js');
// ADR-857 phase 5f-1b: settings-json hook registration moved to runtime-hooks-surface.cts.
const HOOKS_SURFACE_SRC = path.join(__dirname, '..', 'src', 'runtime-hooks-surface.cts');

const SH_HOOKS = [
  { name: 'gsd-validate-commit.sh', settingsVar: 'validateCommitCommand' },
  { name: 'gsd-session-state.sh',   settingsVar: 'sessionStateCommand' },
  { name: 'gsd-phase-boundary.sh',  settingsVar: 'phaseBoundaryCommand' },
];

describe('bug #1817: .sh hook registration guards', () => {
  let src;

  // Read once — all tests in this suite share the same source snapshot.
  // ADR-857 phase 5f-1b: hook registration moved to runtime-hooks-surface.cts.
  // Concatenate both sources so structural assertions find patterns in either file.
  try {
    const installSrc = fs.readFileSync(INSTALL_SRC, 'utf-8');
    let hooksSurfaceSrc = '';
    try { hooksSurfaceSrc = fs.readFileSync(HOOKS_SURFACE_SRC, 'utf-8'); } catch { /* ok */ }
    src = installSrc + '\n' + hooksSurfaceSrc;
  } catch {
    src = '';
  }

  for (const { name, settingsVar } of SH_HOOKS) {
    describe(`${name} registration`, () => {
      test(`install.js checks file existence before registering ${name}`, () => {
        // Find the block where this .sh hook is registered.
        // Each registration block is preceded by the command variable declaration
        // and followed by the next hook or end of registration section.
        const varIdx = src.indexOf(settingsVar);
        assert.ok(varIdx !== -1, `${settingsVar} variable not found in install.js`);

        // Extract ~900 chars around the variable to find the registration block
        const blockStart = Math.max(0, varIdx - 50);
        const blockEnd = Math.min(src.length, varIdx + 900);
        const block = src.slice(blockStart, blockEnd);

        assert.ok(
          block.includes('fs.existsSync') || block.includes('existsSync'),
          `install.js must call fs.existsSync on the target path before registering ${name} in settings.json. ` +
          `Without this guard, hooks are registered even when the .sh file was never copied ` +
          `(the root cause of #1817).`
        );
      });
    });
  }
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-1076-extended-hook-events-drive.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-1076-extended-hook-events-drive (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * ADR-857 phase 5f-3: extended hook event guards are driven by the
 * extendedHookEvents descriptor field, not hardcoded runtime-name checks.
 *
 * Before this change:
 *   - SubagentStop/Stop/PreCompact were wired only when (isQwen || runtime==='claude')
 *   - FileChanged was wired only when (runtime === 'claude')
 *   - BeforeAgent/AfterAgent/BeforeModel were wired only when (isGemini)
 *
 * After this change:
 *   - All three guard blocks are driven purely by extendedEvents.includes(eventName)
 *   - Any runtime (or arbitrary string) that passes the right extendedHookEvents
 *     array gets exactly those events registered, regardless of its runtime name.
 *
 * This suite proves descriptor-drive by calling applySettingsJsonHooks directly
 * with a controlled extendedHookEvents array and asserting on settings.hooks.
 * No source-grep; purely behavioral.
 */

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOKS_DIST_DIR = path.join(REPO_ROOT, 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-hooks.js');

/** Idempotently ensure hooks/dist contains built .js files. */
function ensureHooksDist() {
  if (!fs.existsSync(HOOKS_DIST_DIR) || fs.readdirSync(HOOKS_DIST_DIR).filter(f => f.endsWith('.js')).length === 0) {
    execFileSync(process.execPath, [BUILD_HOOKS_SCRIPT], { stdio: 'pipe' });
  }
}

before(() => {
  ensureHooksDist();
});

const { applySettingsJsonHooks } = require('../bin/install.js');
const { cleanup } = require('./helpers.cjs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Return all hook commands registered under an event key. */
function hooksForEvent(settings, eventName) {
  if (!settings || !settings.hooks || !Array.isArray(settings.hooks[eventName])) return [];
  return settings.hooks[eventName].flatMap(entry =>
    (entry && Array.isArray(entry.hooks) ? entry.hooks : [])
      .map(h => h && h.command)
      .filter(Boolean)
  );
}

/** True if any hook is registered under eventName. */
function hasHooksFor(settings, eventName) {
  return hooksForEvent(settings, eventName).length > 0;
}

/**
 * Create a temporary directory with stub hook files so fs.existsSync guards pass.
 * Returns the targetDir path.
 */
function createStubTargetDir() {
  const tmpDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gsd-1076-'));
  const hooksDir = path.join(tmpDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  // Stubs for the hooks applySettingsJsonHooks existsSync-checks
  const stubs = [
    'gsd-check-update.js',
    'gsd-context-monitor.js',
    'gsd-prompt-guard.js',
    'gsd-read-guard.js',
    'gsd-read-injection-scanner.js',
    'gsd-config-reload.js',
    'gsd-workflow-guard.js',
    'gsd-worktree-path-guard.js',
    'gsd-validate-commit.sh',
    'gsd-session-state.sh',
    'gsd-phase-boundary.sh',
    'gsd-graphify-update.sh',
  ];
  const hooksDistDir = path.join(REPO_ROOT, 'hooks', 'dist');
  for (const stub of stubs) {
    const dest = path.join(hooksDir, stub);
    const distSrc = path.join(hooksDistDir, stub);
    if (fs.existsSync(distSrc)) {
      fs.copyFileSync(distSrc, dest);
    } else {
      // Minimal stub so existsSync passes
      const ext = path.extname(stub);
      fs.writeFileSync(dest, ext === '.sh' ? '#!/bin/bash\n# stub\n' : '#!/usr/bin/env node\n// stub\n');
    }
    try { fs.chmodSync(dest, 0o755); } catch { /* Windows */ }
  }
  return tmpDir;
}

function cleanupDir(dir) {
  cleanup(dir);
}

/**
 * Build the minimal opts bag for applySettingsJsonHooks.
 * postToolEvent: 'PostToolUse' (default dialect).
 * All commands: non-null strings so the "command truthy" guard passes.
 */
function buildOpts(targetDir, { runtime, extendedHookEvents }) {
  const hookOpts = { platform: process.platform, runtime };
  const node = process.execPath;
  return {
    runtime,
    isGlobal: true,
    targetDir,
    postToolEvent: 'PostToolUse',
    hookEvents: undefined,         // not the hookEvents dialect — we're testing extendedHookEvents
    extendedHookEvents,
    updateCheckCommand: `${node} "${path.join(targetDir, 'hooks', 'gsd-check-update.js')}"`,
    contextMonitorCommand: `${node} "${path.join(targetDir, 'hooks', 'gsd-context-monitor.js')}"`,
    promptGuardCommand: `${node} "${path.join(targetDir, 'hooks', 'gsd-prompt-guard.js')}"`,
    readGuardCommand: `${node} "${path.join(targetDir, 'hooks', 'gsd-read-guard.js')}"`,
    readInjectionScannerCommand: `${node} "${path.join(targetDir, 'hooks', 'gsd-read-injection-scanner.js')}"`,
    configReloadCommand: `${node} "${path.join(targetDir, 'hooks', 'gsd-config-reload.js')}"`,
    hookOpts,
    localCmd: () => null,
    localShellCmd: () => null,
  };
}

// ─── Suite 1: claude shape (SubagentStop+Stop+PreCompact+FileChanged) ─────────

describe('enh-1076 phase 5f-3: claude extendedHookEvents → SubagentStop/Stop/PreCompact/FileChanged', () => {
  let targetDir;
  let settings;

  before(() => {
    targetDir = createStubTargetDir();
    settings = { hooks: {} };
    const opts = buildOpts(targetDir, {
      runtime: 'claude',
      extendedHookEvents: ['SubagentStop', 'Stop', 'PreCompact', 'FileChanged'],
    });
    applySettingsJsonHooks(settings, opts);
  });

  test('SubagentStop is wired (descriptor-driven)', () => {
    assert.ok(
      hasHooksFor(settings, 'SubagentStop'),
      `Expected SubagentStop hooks; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('Stop is wired (descriptor-driven)', () => {
    assert.ok(
      hasHooksFor(settings, 'Stop'),
      `Expected Stop hooks; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('PreCompact is wired (descriptor-driven)', () => {
    assert.ok(
      hasHooksFor(settings, 'PreCompact'),
      `Expected PreCompact hooks; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('FileChanged is wired (descriptor-driven)', () => {
    assert.ok(
      hasHooksFor(settings, 'FileChanged'),
      `Expected FileChanged hooks; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('cleanup', () => {
    cleanupDir(targetDir);
  });
});

// ─── Suite 2: qwen shape (SubagentStop+Stop+PreCompact, no FileChanged) ───────

describe('enh-1076 phase 5f-3: qwen extendedHookEvents → SubagentStop/Stop/PreCompact only', () => {
  let targetDir;
  let settings;

  before(() => {
    targetDir = createStubTargetDir();
    settings = { hooks: {} };
    const opts = buildOpts(targetDir, {
      runtime: 'qwen',
      extendedHookEvents: ['SubagentStop', 'Stop', 'PreCompact'],
    });
    applySettingsJsonHooks(settings, opts);
  });

  test('SubagentStop is wired', () => {
    assert.ok(hasHooksFor(settings, 'SubagentStop'));
  });

  test('Stop is wired', () => {
    assert.ok(hasHooksFor(settings, 'Stop'));
  });

  test('PreCompact is wired', () => {
    assert.ok(hasHooksFor(settings, 'PreCompact'));
  });

  test('FileChanged is NOT wired (not in extendedHookEvents)', () => {
    assert.strictEqual(
      hasHooksFor(settings, 'FileChanged'),
      false,
      `FileChanged must NOT be wired for qwen shape; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('cleanup', () => {
    cleanupDir(targetDir);
  });
});

// ─── Suite 3: gemini shape (BeforeAgent+AfterAgent+BeforeModel) ───────────────

describe('enh-1076 phase 5f-3: extendedHookEvents → BeforeAgent/AfterAgent/BeforeModel (Gemini-3 backend dialect)', () => {
  let targetDir;
  let settings;

  before(() => {
    targetDir = createStubTargetDir();
    settings = { hooks: {} };
    const opts = buildOpts(targetDir, {
      runtime: 'antigravity',
      extendedHookEvents: ['BeforeAgent', 'AfterAgent', 'BeforeModel'],
    });
    applySettingsJsonHooks(settings, opts);
  });

  test('BeforeAgent is wired', () => {
    assert.ok(
      hasHooksFor(settings, 'BeforeAgent'),
      `Expected BeforeAgent hooks; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('AfterAgent is wired', () => {
    assert.ok(hasHooksFor(settings, 'AfterAgent'));
  });

  test('BeforeModel is wired', () => {
    assert.ok(hasHooksFor(settings, 'BeforeModel'));
  });

  test('SubagentStop is NOT wired (not in extendedHookEvents)', () => {
    assert.strictEqual(
      hasHooksFor(settings, 'SubagentStop'),
      false,
      'SubagentStop must NOT be wired for gemini shape'
    );
  });

  test('FileChanged is NOT wired (not in extendedHookEvents)', () => {
    assert.strictEqual(
      hasHooksFor(settings, 'FileChanged'),
      false,
      'FileChanged must NOT be wired for gemini shape'
    );
  });

  test('cleanup', () => {
    cleanupDir(targetDir);
  });
});

// ─── Suite 4: empty extendedHookEvents → none of the extended events ──────────

describe('enh-1076 phase 5f-3: empty extendedHookEvents → no extended events wired', () => {
  let targetDir;
  let settings;

  before(() => {
    targetDir = createStubTargetDir();
    settings = { hooks: {} };
    // Use runtime='someruntime' to prove it's the descriptor, not the name, that matters
    const opts = buildOpts(targetDir, {
      runtime: 'someruntime',
      extendedHookEvents: [],
    });
    applySettingsJsonHooks(settings, opts);
  });

  const EXTENDED_EVENTS = [
    'SubagentStop', 'Stop', 'PreCompact', 'FileChanged',
    'BeforeAgent', 'AfterAgent', 'BeforeModel',
  ];

  for (const event of EXTENDED_EVENTS) {
    test(`${event} is NOT wired when extendedHookEvents is empty`, () => {
      assert.strictEqual(
        hasHooksFor(settings, event),
        false,
        `${event} must not be wired when extendedHookEvents=[] (runtime=someruntime); hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
      );
    });
  }

  test('cleanup', () => {
    cleanupDir(targetDir);
  });
});

// ─── Suite 5: descriptor-drive is runtime-name-agnostic ───────────────────────
// Pass an arbitrary runtime name ('hypothetical') with SubagentStop in its
// extendedHookEvents. This could NEVER have worked under the old hardcoded check.
// Under the new descriptor-driven guard it MUST work.

describe('enh-1076 phase 5f-3: arbitrary runtime with SubagentStop in descriptor gets it wired', () => {
  let targetDir;
  let settings;

  before(() => {
    targetDir = createStubTargetDir();
    settings = { hooks: {} };
    const opts = buildOpts(targetDir, {
      runtime: 'hypothetical',   // NOT 'claude' or 'qwen' — would have been skipped before
      extendedHookEvents: ['SubagentStop'],
    });
    applySettingsJsonHooks(settings, opts);
  });

  test('SubagentStop IS wired for a hypothetical runtime when descriptor includes it', () => {
    assert.ok(
      hasHooksFor(settings, 'SubagentStop'),
      `SubagentStop must be wired via descriptor even for unknown runtime names; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('Stop is NOT wired (not in extendedHookEvents)', () => {
    assert.strictEqual(hasHooksFor(settings, 'Stop'), false);
  });

  test('cleanup', () => {
    cleanupDir(targetDir);
  });
});

// ─── Suite 6: hooksSurface drive (ADR-857 phase 5g drive 3) ──────────────────
//
// applySettingsJsonHooks is gated by opts.hooksSurface !== 'none'.
// - hooksSurface:'none'         → entire body is skipped; no hooks written
// - hooksSurface:'settings-json'→ hooks are written (even for a runtime whose
//   name was previously hardcoded to skip, e.g. 'opencode')
//
// This proves the skip is driven by the descriptor field, not the runtime name.

describe('enh-1076 phase 5g drive 3: hooksSurface:none skips all hooks regardless of runtime', () => {
  let targetDir;
  let settings;

  before(() => {
    targetDir = createStubTargetDir();
    settings = { hooks: {} };
    // 'claude' would normally write hooks, but hooksSurface:'none' must skip entirely.
    const opts = {
      ...buildOpts(targetDir, { runtime: 'claude', extendedHookEvents: ['SubagentStop'] }),
      hooksSurface: 'none',
    };
    applySettingsJsonHooks(settings, opts);
  });

  test('SessionStart is NOT written when hooksSurface is "none"', () => {
    assert.strictEqual(
      hasHooksFor(settings, 'SessionStart'),
      false,
      `SessionStart must not be written when hooksSurface="none"; hooks keys: ${JSON.stringify(Object.keys(settings.hooks || {}))}`
    );
  });

  test('PostToolUse is NOT written when hooksSurface is "none"', () => {
    assert.strictEqual(hasHooksFor(settings, 'PostToolUse'), false);
  });

  test('PreToolUse is NOT written when hooksSurface is "none"', () => {
    assert.strictEqual(hasHooksFor(settings, 'PreToolUse'), false);
  });

  test('cleanup', () => {
    cleanupDir(targetDir);
  });
});

describe('enh-1076 phase 5g drive 3: hooksSurface:settings-json writes hooks even for previously-skipped runtime name', () => {
  let targetDir;
  let settings;

  before(() => {
    targetDir = createStubTargetDir();
    settings = { hooks: {} };
    // 'opencode' previously was hardcoded to skip hooks; with descriptor drive it
    // should write hooks whenever hooksSurface !== 'none'.
    const opts = {
      ...buildOpts(targetDir, { runtime: 'opencode', extendedHookEvents: [] }),
      hooksSurface: 'settings-json',
    };
    applySettingsJsonHooks(settings, opts);
  });

  test('SessionStart IS written with at least one command when hooksSurface is "settings-json" (even for opencode name)', () => {
    // ensureHooksDist() in before() guarantees hooks/dist is built, so the
    // existsSync guards inside applySettingsJsonHooks pass and commands are registered.
    assert.ok(
      settings.hooks && typeof settings.hooks === 'object',
      `settings.hooks must be initialized when hooksSurface="settings-json"`,
    );
    assert.ok(
      hasHooksFor(settings, 'SessionStart'),
      `settings.hooks.SessionStart must contain at least one registered command when hooksSurface="settings-json"; ` +
      `keys: ${JSON.stringify(Object.keys(settings.hooks))}`,
    );
  });

  test('cleanup', () => {
    cleanupDir(targetDir);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-1077-install-hook-events-dialect-drive.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-1077-install-hook-events-dialect-drive (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * ADR-857 phase 5f-2: hook-events dialect is driven from the registry descriptor.
 *
 * Before this change, postToolEvent and preToolEvent were hardcoded strings
 * derived from runtime-name checks:
 *
 *   (runtime === 'gemini' || runtime === 'antigravity') ? 'AfterTool'  : 'PostToolUse'
 *   (runtime === 'gemini' || runtime === 'antigravity') ? 'BeforeTool' : 'PreToolUse'
 *
 * After phase 5f-2, both are driven by the registry descriptor's
 * `hookEvents` field: hookEvents === 'gemini' → AfterTool/BeforeTool;
 * any other value (or missing) → PostToolUse/PreToolUse.
 *
 * Equivalence (i.e. identical observable behaviour for all runtimes):
 *   hookEvents === 'gemini'  iff  runtime ∈ {gemini, antigravity}
 *
 * This suite asserts the equivalence and the registry-parity invariant:
 * any runtime whose descriptor carries hookEvents='gemini' gets the
 * AfterTool/BeforeTool dialect; all others get PostToolUse/PreToolUse.
 */

const { test, describe, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { install } = require('../bin/install.js');
const { createTempDir, cleanup } = require('./helpers.cjs');

// ─── hooks/dist build guard ───────────────────────────────────────────────────
//
// hooks/dist/ is gitignored and only produced by `npm run build:hooks`.
// In CI the scoped/windows test jobs do NOT run build:hooks before running
// tests, so install() finds no hook files → event arrays come back empty →
// every "expected AfterTool/PostToolUse/BeforeTool/PreToolUse hooks" assertion
// fails. This mirrors the pattern in bug-376-claude-js-hook-gsd-rewriter.test.cjs.

const REPO_ROOT = path.resolve(__dirname, '..');
const HOOKS_DIST_DIR = path.join(REPO_ROOT, 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-hooks.js');

/**
 * Idempotently ensure hooks/dist contains built .js files.
 * Runs build-hooks.js only when the directory is absent or empty of .js files.
 */
function ensureHooksDist() {
  if (!fs.existsSync(HOOKS_DIST_DIR) || fs.readdirSync(HOOKS_DIST_DIR).filter(f => f.endsWith('.js')).length === 0) {
    execFileSync(process.execPath, [BUILD_HOOKS_SCRIPT], { stdio: 'pipe' });
  }
}

before(() => {
  ensureHooksDist();
});

// ─── Registry lookup ──────────────────────────────────────────────────────────

const REGISTRY_PATH = path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'capability-registry.cjs');
const registry = (() => {
  try { return require(REGISTRY_PATH); } catch { return undefined; }
})();

/**
 * Return the hookEvents dialect for a runtime ID from the live registry.
 * Returns undefined when the registry is absent or the runtime has no descriptor.
 */
function registryHookEvents(runtimeId) {
  return registry?.runtimes?.[runtimeId]?.runtime?.hookEvents;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Collect all hook commands registered under a settings event key. */
function hooksForEvent(settings, eventName) {
  if (!settings || !settings.hooks || !Array.isArray(settings.hooks[eventName])) return [];
  return settings.hooks[eventName].flatMap(entry =>
    (entry && Array.isArray(entry.hooks) ? entry.hooks : [])
      .map(h => h && h.command)
      .filter(Boolean)
  );
}

/** True if at least one hook is registered under eventName. */
function hasHooksFor(settings, eventName) {
  return hooksForEvent(settings, eventName).length > 0;
}

// ─── Suite 1: Gemini-dialect runtimes use AfterTool/BeforeTool ───────────────
//
// Registry runtimes with hookEvents='gemini': gemini, antigravity

describe('enh-1077 phase 5f-2: gemini hookEvents dialect → AfterTool/BeforeTool', () => {
  // #1928: the gemini runtime was removed (Google sunset Gemini CLI
  // 2026-06-18). antigravity — the Gemini-backend successor — is the only
  // remaining runtime whose descriptor carries hookEvents='gemini'.

  describe('antigravity install uses AfterTool/BeforeTool (gemini dialect)', () => {
    let tmpDir;
    let previousCwd;
    let settings;

    beforeEach(() => {
      tmpDir = createTempDir('gsd-1077-antigrav-');
      previousCwd = process.cwd();
      process.chdir(tmpDir);

      const agDir = path.join(tmpDir, '.gemini', 'antigravity');
      fs.mkdirSync(agDir, { recursive: true });
      const result = install(false, 'antigravity');
      settings = result && result.settings;
    });

    afterEach(() => {
      process.chdir(previousCwd);
      cleanup(tmpDir);
    });

    test('registry confirms antigravity hookEvents is "gemini"', () => {
      const he = registryHookEvents('antigravity');
      if (he !== undefined) {
        assert.strictEqual(he, 'gemini',
          'Registry descriptor for antigravity must declare hookEvents="gemini"');
      }
    });

    test('antigravity install returns a settings object', () => {
      assert.ok(settings !== null && typeof settings === 'object',
        'antigravity install must return a non-null settings object');
    });

    test('antigravity install registers at least one hook under AfterTool', () => {
      assert.ok(hasHooksFor(settings, 'AfterTool'),
        `Expected AfterTool hooks on antigravity; got hooks keys: ${JSON.stringify(Object.keys((settings && settings.hooks) || {}))}`);
    });

    test('antigravity install does NOT register context-monitor under PostToolUse', () => {
      const cmds = hooksForEvent(settings, 'PostToolUse');
      const hasMonitor = cmds.some(c => c && c.includes('gsd-context-monitor'));
      assert.strictEqual(hasMonitor, false,
        `antigravity must NOT use PostToolUse for context-monitor; got: ${JSON.stringify(cmds)}`);
    });

    test('antigravity install registers at least one pre-tool hook (prompt-guard) under BeforeTool', () => {
      const cmds = hooksForEvent(settings, 'BeforeTool');
      const hasPromptGuard = cmds.some(c => c && c.includes('gsd-prompt-guard'));
      assert.ok(hasPromptGuard,
        `Expected prompt-guard hook under BeforeTool on antigravity; BeforeTool commands: ${JSON.stringify(cmds)}; hooks keys: ${JSON.stringify(Object.keys((settings && settings.hooks) || {}))}`);
    });

    test('antigravity install does NOT register prompt-guard under PreToolUse (wrong pre-tool dialect)', () => {
      const cmds = hooksForEvent(settings, 'PreToolUse');
      const hasPromptGuard = cmds.some(c => c && c.includes('gsd-prompt-guard'));
      assert.strictEqual(hasPromptGuard, false,
        `antigravity must NOT use PreToolUse for prompt-guard; got PreToolUse commands: ${JSON.stringify(cmds)}`);
    });
  });
});

// ─── Suite 2: Claude-dialect runtimes use PostToolUse/PreToolUse ──────────────
//
// Registry runtimes with hookEvents='claude': claude, augment

describe('enh-1077 phase 5f-2: claude hookEvents dialect → PostToolUse/PreToolUse', () => {
  // ── claude ──

  describe('claude install uses PostToolUse for post-tool hooks', () => {
    let tmpDir;
    let previousCwd;
    let settings;

    beforeEach(() => {
      tmpDir = createTempDir('gsd-1077-claude-');
      previousCwd = process.cwd();
      process.chdir(tmpDir);

      const claudeDir = path.join(tmpDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const result = install(false, 'claude');
      settings = result && result.settings;
    });

    afterEach(() => {
      process.chdir(previousCwd);
      cleanup(tmpDir);
    });

    test('registry confirms claude hookEvents is "claude"', () => {
      const he = registryHookEvents('claude');
      if (he !== undefined) {
        assert.strictEqual(he, 'claude',
          'Registry descriptor for claude must declare hookEvents="claude"');
      }
    });

    test('claude install returns a settings object', () => {
      assert.ok(settings !== null && typeof settings === 'object',
        'claude install must return a non-null settings object');
    });

    test('claude install registers at least one hook under PostToolUse', () => {
      assert.ok(hasHooksFor(settings, 'PostToolUse'),
        `Expected PostToolUse hooks on claude; got hooks keys: ${JSON.stringify(Object.keys((settings && settings.hooks) || {}))}`);
    });

    test('claude install does NOT register context-monitor under AfterTool (wrong dialect)', () => {
      const cmds = hooksForEvent(settings, 'AfterTool');
      const hasMonitor = cmds.some(c => c && c.includes('gsd-context-monitor'));
      assert.strictEqual(hasMonitor, false,
        `claude must NOT use AfterTool for context-monitor; got AfterTool commands: ${JSON.stringify(cmds)}`);
    });

    test('claude install registers at least one pre-tool hook (prompt-guard) under PreToolUse', () => {
      const cmds = hooksForEvent(settings, 'PreToolUse');
      const hasPromptGuard = cmds.some(c => c && c.includes('gsd-prompt-guard'));
      assert.ok(hasPromptGuard,
        `Expected prompt-guard hook under PreToolUse on claude; PreToolUse commands: ${JSON.stringify(cmds)}; hooks keys: ${JSON.stringify(Object.keys((settings && settings.hooks) || {}))}`);
    });

    test('claude install does NOT register prompt-guard under BeforeTool (wrong pre-tool dialect)', () => {
      const cmds = hooksForEvent(settings, 'BeforeTool');
      const hasPromptGuard = cmds.some(c => c && c.includes('gsd-prompt-guard'));
      assert.strictEqual(hasPromptGuard, false,
        `claude must NOT use BeforeTool for prompt-guard; got BeforeTool commands: ${JSON.stringify(cmds)}`);
    });
  });

  // ── augment ──

  describe('augment install uses PostToolUse/PreToolUse (claude dialect)', () => {
    let tmpDir;
    let previousCwd;
    let settings;

    beforeEach(() => {
      tmpDir = createTempDir('gsd-1077-augment-');
      previousCwd = process.cwd();
      process.chdir(tmpDir);

      const augDir = path.join(tmpDir, '.augment');
      fs.mkdirSync(augDir, { recursive: true });
      const result = install(false, 'augment');
      settings = result && result.settings;
    });

    afterEach(() => {
      process.chdir(previousCwd);
      cleanup(tmpDir);
    });

    test('registry confirms augment hookEvents is "claude"', () => {
      const he = registryHookEvents('augment');
      if (he !== undefined) {
        assert.strictEqual(he, 'claude',
          'Registry descriptor for augment must declare hookEvents="claude"');
      }
    });

    test('augment install returns a settings object', () => {
      assert.ok(settings !== null && typeof settings === 'object',
        'augment install must return a non-null settings object');
    });

    test('augment install registers at least one hook under PostToolUse', () => {
      assert.ok(hasHooksFor(settings, 'PostToolUse'),
        `Expected PostToolUse hooks on augment; got hooks keys: ${JSON.stringify(Object.keys((settings && settings.hooks) || {}))}`);
    });

    test('augment install does NOT register context-monitor under AfterTool', () => {
      const cmds = hooksForEvent(settings, 'AfterTool');
      const hasMonitor = cmds.some(c => c && c.includes('gsd-context-monitor'));
      assert.strictEqual(hasMonitor, false,
        `augment must NOT use AfterTool for context-monitor; got: ${JSON.stringify(cmds)}`);
    });

    test('augment install registers at least one pre-tool hook (prompt-guard) under PreToolUse', () => {
      const cmds = hooksForEvent(settings, 'PreToolUse');
      const hasPromptGuard = cmds.some(c => c && c.includes('gsd-prompt-guard'));
      assert.ok(hasPromptGuard,
        `Expected prompt-guard hook under PreToolUse on augment; PreToolUse commands: ${JSON.stringify(cmds)}; hooks keys: ${JSON.stringify(Object.keys((settings && settings.hooks) || {}))}`);
    });

    test('augment install does NOT register prompt-guard under BeforeTool (wrong pre-tool dialect)', () => {
      const cmds = hooksForEvent(settings, 'BeforeTool');
      const hasPromptGuard = cmds.some(c => c && c.includes('gsd-prompt-guard'));
      assert.strictEqual(hasPromptGuard, false,
        `augment must NOT use BeforeTool for prompt-guard; got BeforeTool commands: ${JSON.stringify(cmds)}`);
    });
  });
});

// ─── Suite 3: Registry-parity invariant ──────────────────────────────────────
//
// For every runtime in the registry that exposes a settings.json surface
// (i.e. hookEvents is defined), assert that the installed hook dialect matches
// the registry value. This is the generative-fix parity assertion
// (DEFECT.GENERATIVE-FIX): adding a new runtime with hookEvents to the
// registry automatically requires a passing install test for that runtime.

describe('enh-1077 phase 5f-2: registry-parity — hookEvents descriptor drives install dialect', () => {
  test('all registry runtimes with hookEvents use the matching install dialect', () => {
    if (!registry || !registry.runtimes) {
      // Registry absent — skip parity check (equivalence still verified above)
      return;
    }

    // Runtimes that have settings.json surfaces and a hookEvents descriptor
    const SETTINGS_JSON_RUNTIMES = ['claude', 'antigravity', 'augment', 'qwen', 'hermes', 'codebuddy'];

    const failures = [];

    for (const runtimeId of SETTINGS_JSON_RUNTIMES) {
      const he = registryHookEvents(runtimeId);
      if (he === undefined) continue; // no hookEvents in descriptor — skip

      const expectedPostEvent = he === 'gemini' ? 'AfterTool' : 'PostToolUse';
      const unexpectedPostEvent = he === 'gemini' ? 'PostToolUse' : 'AfterTool';
      const expectedPreEvent = he === 'gemini' ? 'BeforeTool' : 'PreToolUse';
      const unexpectedPreEvent = he === 'gemini' ? 'PreToolUse' : 'BeforeTool';

      const previousCwd = process.cwd();
      const tmpDir = createTempDir(`gsd-1077-parity-${runtimeId}-`);
      try {
        process.chdir(tmpDir);
        const result = install(false, runtimeId);
        const settings = result && result.settings;
        if (!settings) continue; // non-settings-json surface, skip

        // Post-tool event assertions
        const hasExpected = hasHooksFor(settings, expectedPostEvent);
        const hasUnexpected = hooksForEvent(settings, unexpectedPostEvent)
          .some(c => c && c.includes('gsd-context-monitor'));

        if (!hasExpected) {
          failures.push(`${runtimeId}: expected context-monitor hook under ${expectedPostEvent} (hookEvents=${he}), but none found`);
        }
        if (hasUnexpected) {
          failures.push(`${runtimeId}: must NOT register context-monitor under ${unexpectedPostEvent}, but it was found`);
        }

        // Pre-tool event assertions: prompt-guard must land under the dialect-correct key.
        const preToolCmdsExpected = hooksForEvent(settings, expectedPreEvent);
        const hasPromptGuardExpected = preToolCmdsExpected.some(c => c && c.includes('gsd-prompt-guard'));
        const preToolCmdsUnexpected = hooksForEvent(settings, unexpectedPreEvent);
        const hasPromptGuardUnexpected = preToolCmdsUnexpected.some(c => c && c.includes('gsd-prompt-guard'));

        if (!hasPromptGuardExpected) {
          failures.push(`${runtimeId}: expected prompt-guard hook under ${expectedPreEvent} (hookEvents=${he}), but none found; ${expectedPreEvent} cmds: ${JSON.stringify(preToolCmdsExpected)}`);
        }
        if (hasPromptGuardUnexpected) {
          failures.push(`${runtimeId}: must NOT register prompt-guard under ${unexpectedPreEvent} (hookEvents=${he}), but it was found`);
        }
      } finally {
        process.chdir(previousCwd);
        cleanup(tmpDir);
      }
    }

    assert.deepEqual(failures, [],
      'Registry-parity failures (hookEvents descriptor must drive install dialect):\n' +
      failures.join('\n'));
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-788-qwen-hook-events.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-788-qwen-hook-events (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Enhancement #788: Expand Qwen Code hook-event coverage.
 *
 * Qwen Code supports 15 hook events; gsd previously registered only
 * SessionStart and PostToolUse.  This suite asserts that a Qwen install
 * registers the 3 new high-value events:
 *   - SubagentStop  — subagent lifecycle finalisation (context tracking)
 *   - Stop          — model stop / final-response hook (context tracking)
 *   - PreCompact    — pre-compaction awareness (context tracking)
 *
 * All three are wired to gsd-context-monitor.js — the same hook used for
 * PostToolUse — so context headroom warnings surface at these moments too.
 *
 * Note: UserPromptSubmit is NOT wired — gsd-prompt-guard exits unless
 * tool_name is Write|Edit (PreToolUse shape), so it would be a no-op for
 * the UserPromptSubmit payload.  Deferred to a follow-on issue.
 *
 * Also asserts the inverse: Claude Code installs do NOT gain these events
 * (strict isQwen scope guard).
 *
 * Source: https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { install, uninstall, validateHookFields } = require('../bin/install.js');
const { createTempDir, cleanup } = require('./helpers.cjs');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Extract all hook commands registered under `eventName` from settings. */
function hooksForEvent(settings, eventName) {
  if (!settings || !settings.hooks || !Array.isArray(settings.hooks[eventName])) return [];
  return settings.hooks[eventName].flatMap(entry =>
    (entry && Array.isArray(entry.hooks) ? entry.hooks : [])
      .map(h => h && h.command)
      .filter(Boolean)
  );
}

// Stub JS hook files that the installer checks with fs.existsSync() so hook
// registration guards pass even when hooks/dist/ isn't built.
const HOOKS_SRC = path.join(__dirname, '..', 'hooks');
const STUB_HOOKS = [
  'gsd-context-monitor.js',
  'gsd-prompt-guard.js',
  'gsd-check-update.js',
  'gsd-config-reload.js', // Added in #770
];

function stubHooksIntoTarget(targetDir) {
  const hooksDest = path.join(targetDir, 'hooks');
  fs.mkdirSync(hooksDest, { recursive: true });
  for (const hookFile of STUB_HOOKS) {
    const src = path.join(HOOKS_SRC, hookFile);
    const dest = path.join(hooksDest, hookFile);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
    } else {
      // Minimal stub so existsSync passes
      fs.writeFileSync(dest, '#!/usr/bin/env node\n// stub\n');
    }
    try { fs.chmodSync(dest, 0o755); } catch { /* Windows */ }
  }
}

/**
 * Persist in-memory settings to disk, simulating what finishInstall() does
 * (finishInstall is not exported).  Required for tests that call install()
 * twice and need the second call to read the first call's hook registrations.
 */
function persistSettings(settingsPath, settings) {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(validateHookFields(settings), null, 2) + '\n', 'utf8');
}

// ─── Suite 1: Qwen — new events are registered ───────────────────────────────

describe('enh-788: Qwen install registers 3 new hook events', () => {
  let tmpDir;
  let previousCwd;
  let settings;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-788-qwen-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);

    const targetDir = path.join(tmpDir, '.qwen');
    fs.mkdirSync(targetDir, { recursive: true });
    // Pre-populate hook files so installer registration guards (fs.existsSync)
    // pass and hooks are actually registered in settings.json.
    stubHooksIntoTarget(targetDir);

    const result = install(false, 'qwen');
    settings = result.settings;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('install returns a settings object (not null)', () => {
    assert.ok(settings !== null && typeof settings === 'object',
      'Qwen install must return a non-null settings object');
  });

  test('SubagentStop event is registered with at least one hook', () => {
    const cmds = hooksForEvent(settings, 'SubagentStop');
    assert.ok(cmds.length > 0,
      `Expected SubagentStop hooks; got hooks: ${JSON.stringify(settings && settings.hooks)}`);
  });

  test('Stop event is registered with at least one hook', () => {
    const cmds = hooksForEvent(settings, 'Stop');
    assert.ok(cmds.length > 0,
      `Expected Stop hooks; got hooks: ${JSON.stringify(settings && settings.hooks)}`);
  });

  test('PreCompact event is registered with at least one hook', () => {
    const cmds = hooksForEvent(settings, 'PreCompact');
    assert.ok(cmds.length > 0,
      `Expected PreCompact hooks; got hooks: ${JSON.stringify(settings && settings.hooks)}`);
  });

  test('UserPromptSubmit is NOT registered (handler not yet implemented for that payload shape)', () => {
    // gsd-prompt-guard exits unless tool_name is Write|Edit — it is a no-op
    // for UserPromptSubmit payloads.  Registration is deferred until a
    // dedicated hook can process the user-prompt payload shape.
    const cmds = hooksForEvent(settings, 'UserPromptSubmit');
    assert.strictEqual(cmds.length, 0,
      `UserPromptSubmit should NOT be registered yet; got: ${JSON.stringify(cmds)}`);
  });

  test('SubagentStop / Stop / PreCompact all use gsd-context-monitor', () => {
    for (const event of ['SubagentStop', 'Stop', 'PreCompact']) {
      const cmds = hooksForEvent(settings, event);
      assert.ok(
        cmds.some(c => c.includes('gsd-context-monitor')),
        `Event ${event} should use gsd-context-monitor; got commands: ${JSON.stringify(cmds)}`
      );
    }
  });

  test('FileChanged is NOT registered for Qwen (Claude-only event)', () => {
    // gsd-config-reload / FileChanged is a Claude Code-only registration.
    // Qwen does not support the FileChanged hook event at all.
    const cmds = hooksForEvent(settings, 'FileChanged');
    assert.strictEqual(cmds.length, 0,
      `FileChanged should NOT be registered for Qwen; got: ${JSON.stringify(cmds)}`);
  });
});

// ─── Suite 2: Claude install DOES get the context events (since #770) ───────
// Note: Prior to #770, these were Qwen-only events.  #770 extended them to
// Claude Code.  This suite is updated to match the new expected behavior.

describe('enh-788 (updated by #770): Claude install registers context lifecycle events', () => {
  let tmpDir;
  let previousCwd;
  let settings;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-788-claude-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
    stubHooksIntoTarget(path.join(tmpDir, '.claude'));

    const result = install(false, 'claude', { installerMigrations: [] });
    settings = result && result.settings;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('Claude install registers SubagentStop (since #770)', () => {
    const cmds = hooksForEvent(settings, 'SubagentStop');
    assert.ok(cmds.length > 0,
      `Claude should have SubagentStop since #770; got: ${JSON.stringify(cmds)}`);
  });

  test('Claude install registers Stop (since #770)', () => {
    const cmds = hooksForEvent(settings, 'Stop');
    assert.ok(cmds.length > 0,
      `Claude should have Stop since #770; got: ${JSON.stringify(cmds)}`);
  });

  test('Claude install registers PreCompact (since #770)', () => {
    const cmds = hooksForEvent(settings, 'PreCompact');
    assert.ok(cmds.length > 0,
      `Claude should have PreCompact since #770; got: ${JSON.stringify(cmds)}`);
  });
});

// ─── Suite 3: Idempotency — persisted reinstall does not duplicate hooks ──────

describe('enh-788: Qwen install is idempotent across persisted reinstalls', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-788-idem-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);

    const targetDir = path.join(tmpDir, '.qwen');
    fs.mkdirSync(targetDir, { recursive: true });
    stubHooksIntoTarget(targetDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('re-running after persisted first install does not duplicate hook entries', () => {
    // First install: get settings and persist to disk (simulating finishInstall)
    const result1 = install(false, 'qwen');
    persistSettings(result1.settingsPath, result1.settings);

    // Second install: reads the persisted settings.json — dedup guards apply
    process.chdir(tmpDir);
    const result2 = install(false, 'qwen');
    const s2 = result2.settings;

    for (const event of ['SubagentStop', 'Stop', 'PreCompact']) {
      const cmds = hooksForEvent(s2, event);
      assert.strictEqual(cmds.length, 1,
        `Event ${event} should have exactly 1 hook command after idempotent reinstall; got ${cmds.length}: ${JSON.stringify(cmds)}`);
    }
  });
});

// ─── Suite 4: Uninstall removes the new event registrations ──────────────────

describe('enh-788: Qwen uninstall removes new hook event entries', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-788-uninstall-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);

    const targetDir = path.join(tmpDir, '.qwen');
    fs.mkdirSync(targetDir, { recursive: true });
    stubHooksIntoTarget(targetDir);

    // Install and persist to disk so uninstall has a settings.json to clean
    const result = install(false, 'qwen');
    persistSettings(result.settingsPath, result.settings);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('settings.json hook entries are removed on uninstall', () => {
    uninstall(false, 'qwen');
    const settingsPath = path.join(tmpDir, '.qwen', 'settings.json');
    if (!fs.existsSync(settingsPath)) return; // file removed entirely is fine
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    for (const event of ['SubagentStop', 'Stop', 'PreCompact']) {
      const cmds = hooksForEvent(settings, event);
      assert.strictEqual(cmds.length, 0,
        `After uninstall, ${event} should have 0 hooks; got: ${JSON.stringify(cmds)}`);
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1834-sh-hooks-installed.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1834-sh-hooks-installed (consolidation epic #1969 B6 #1975)", () => {
  // Consolidation #1969: this block spawns a REAL install and asserts side effects.
  // The host suite sets GSD_TEST_MODE=1 at collection time, which the install child
  // inherits via process.env and which suppresses hook/skill writes. Clear it for
  // this block's duration (standalone had it unset); restore after.
  const { before: __gtmBefore, after: __gtmAfter } = require('node:test');
  let __savedGsdTestMode;
  __gtmBefore(() => { __savedGsdTestMode = process.env.GSD_TEST_MODE; delete process.env.GSD_TEST_MODE; });
  __gtmAfter(() => { if (__savedGsdTestMode === undefined) delete process.env.GSD_TEST_MODE; else process.env.GSD_TEST_MODE = __savedGsdTestMode; });
/**
 * Regression tests for bug #1834
 *
 * The installer must copy all three .sh hook files to the target hooks/
 * directory during installation. In v1.32.0, only .js hooks were deployed
 * because the install loop did not handle non-.js files from hooks/dist/.
 *
 * This test runs the actual installer (not a simulation) and verifies that
 * gsd-session-state.sh, gsd-validate-commit.sh, and gsd-phase-boundary.sh
 * are present and executable in the target hooks directory.
 *
 * Distinct from:
 *   #1656 — .sh files missing from build-hooks.js HOOKS_TO_COPY
 *   #1817 — settings.json registration ran even when .sh files were absent
 */

'use strict';

const { describe, test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const INSTALL_SCRIPT = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
const isWindows = process.platform === 'win32';

const SH_HOOKS = [
  'gsd-session-state.sh',
  'gsd-validate-commit.sh',
  'gsd-phase-boundary.sh',
];

// ─── Ensure hooks/dist/ is populated before any install test ────────────────

before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanup(dir) {
  // eslint-disable-next-line local/no-raw-rmsync-in-tests -- local cleanup wrapper; try/catch swallows ENOENT so runInstaller teardown never fails the test
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Run the installer targeting a temp directory.
 * Uses CLAUDE_CONFIG_DIR to redirect the global install target.
 * Returns the path to the installed hooks directory.
 */
function runInstaller(configDir) {
  // --no-sdk: this test covers hook deployment only; skip SDK build to avoid
  // flakiness and keep the test fast (SDK install path has dedicated coverage
  // in install-smoke.yml).
  execFileSync(process.execPath, [INSTALL_SCRIPT, '--claude', '--global', '--yes', '--no-sdk'], {
    encoding: 'utf-8',
    stdio: 'pipe',
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
    },
  });
  return path.join(configDir, 'hooks');
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. End-to-end install: .sh hooks are deployed
// ─────────────────────────────────────────────────────────────────────────────

describe('#1834: installer deploys .sh hooks alongside .js hooks', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-install-1834-');
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gsd-session-state.sh is present after install', () => {
    const hooksDir = runInstaller(tmpDir);
    const target = path.join(hooksDir, 'gsd-session-state.sh');
    assert.ok(
      fs.existsSync(target),
      'gsd-session-state.sh must be installed to hooks/ — missing file causes SessionStart hook errors'
    );
  });

  test('gsd-validate-commit.sh is present after install', () => {
    const hooksDir = runInstaller(tmpDir);
    const target = path.join(hooksDir, 'gsd-validate-commit.sh');
    assert.ok(
      fs.existsSync(target),
      'gsd-validate-commit.sh must be installed to hooks/ — missing file causes PreToolUse hook errors'
    );
  });

  test('gsd-phase-boundary.sh is present after install', () => {
    const hooksDir = runInstaller(tmpDir);
    const target = path.join(hooksDir, 'gsd-phase-boundary.sh');
    assert.ok(
      fs.existsSync(target),
      'gsd-phase-boundary.sh must be installed to hooks/ — missing file causes PostToolUse hook errors'
    );
  });

  test('all three .sh hooks are present after a single install', () => {
    const hooksDir = runInstaller(tmpDir);
    for (const hook of SH_HOOKS) {
      assert.ok(
        fs.existsSync(path.join(hooksDir, hook)),
        `${hook} must be present in hooks/ after install`
      );
    }
  });

  test('.sh hooks are executable after install', {
    skip: isWindows ? 'Windows does not support POSIX file permissions' : false,
  }, () => {
    const hooksDir = runInstaller(tmpDir);
    for (const hook of SH_HOOKS) {
      const stat = fs.statSync(path.join(hooksDir, hook));
      assert.ok(
        (stat.mode & 0o111) !== 0,
        `${hook} must be executable (chmod +x) after install — missing +x causes hook invocation failures`
      );
    }
  });
});
  });
}
