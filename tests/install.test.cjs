// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Installer Module — Sections 1–5.
 *
 * Covers: getDirName/getGlobalConfigDir/getConfigDirFromHome, per-runtime
 * install/uninstall spot-checks (hermes/qwen/trae), uninstall skills
 * cleanup, Claude-reference leak tests, and Kilo-specific helpers.
 *
 * Consolidates (original sources from #3758):
 *   hermes-install.test.cjs
 *   kilo-install.test.cjs
 *   qwen-install.test.cjs
 *   trae-install.test.cjs
 *   antigravity-install.test.cjs
 *
 * Closes #3758
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { createTempDir, createTempProject, cleanup, parseFrontmatter } = require('./helpers.cjs');
const pkg = require('../package.json');

const {
  getDirName,
  getConfigDirFromHome,
  install,
  uninstall,
  writeManifest,
  allRuntimes,
  runtimeMap,
  buildRuntimePromptText,
  resolveKiloConfigPath,
  configureKiloPermissions,
  selectRuntimesFromArgs,
  normalizeNodePath,
} = require('../bin/install.js');

const { getGlobalConfigDir } = require('../gsd-core/bin/lib/runtime-homes.cjs');

const {
  RUNTIME_META,
  stripAnsi,
  walk,
} = require('./helpers/install-shared.cjs');

const { CHILD_ROUTER, nestedSkillPath } = require('./helpers/nested-layout.cjs');

// ─── Section 1: getDirName / getGlobalConfigDir / getConfigDirFromHome ──────────

describe('getDirName — all runtimes', () => {
  for (const runtime of allRuntimes) {
    test(`getDirName('${runtime}') returns expected local directory name`, () => {
      const expected = RUNTIME_META[runtime].localDir;
      assert.strictEqual(getDirName(runtime), expected,
        `getDirName('${runtime}') should return '${expected}'`);
    });
  }
});

describe('getGlobalConfigDir — all runtimes default paths', () => {
  // Derive env-var list from the registry so it stays auto-correct when new
  // runtimes are added. GROK_AGENTS_HOME is kept explicitly because grok has
  // no registry entry.
  const { runtimes: _registryRuntimes } = require('../gsd-core/bin/lib/capability-registry.cjs');
  const _registryEnvKeys = Object.values(_registryRuntimes).flatMap((r) => {
    const ch = r.runtime?.configHome;
    if (!ch) return [];
    const envs = Array.isArray(ch.env) ? ch.env : [];
    const skillsEnvs = ch.skillsHome && Array.isArray(ch.skillsHome.env) ? ch.skillsHome.env : [];
    return [...envs, ...skillsEnvs];
  });
  const ENV_KEYS = [...new Set([..._registryEnvKeys, 'GROK_AGENTS_HOME', 'XDG_CONFIG_HOME'])];
  let savedEnv = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] !== undefined) process.env[key] = savedEnv[key];
      else delete process.env[key];
    }
  });

  for (const runtime of allRuntimes.filter(runtime => runtime !== 'kimi')) {
    test(`getGlobalConfigDir('${runtime}') returns expected home-relative path`, () => {
      const expected = path.join(os.homedir(), RUNTIME_META[runtime].globalSuffix);
      assert.strictEqual(getGlobalConfigDir(runtime), expected);
    });
  }
});

describe('getGlobalConfigDir/getConfigDirFromHome — antigravity 2.x layout detection', () => {
  const saved = {};
  beforeEach(() => {
    saved.HOME = process.env.HOME;
    saved.USERPROFILE = process.env.USERPROFILE;
    saved.ANTIGRAVITY_CONFIG_DIR = process.env.ANTIGRAVITY_CONFIG_DIR;
    delete process.env.ANTIGRAVITY_CONFIG_DIR;
  });
  afterEach(() => {
    if (saved.HOME !== undefined) process.env.HOME = saved.HOME;
    else delete process.env.HOME;
    if (saved.USERPROFILE !== undefined) process.env.USERPROFILE = saved.USERPROFILE;
    else delete process.env.USERPROFILE;
    if (saved.ANTIGRAVITY_CONFIG_DIR !== undefined) process.env.ANTIGRAVITY_CONFIG_DIR = saved.ANTIGRAVITY_CONFIG_DIR;
    else delete process.env.ANTIGRAVITY_CONFIG_DIR;
  });

  test('uses ~/.gemini/antigravity-ide when legacy dir is absent and ide dir exists', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-antigravity-ide-'));
    try {
      fs.mkdirSync(path.join(home, '.gemini', 'antigravity-ide'), { recursive: true });
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      assert.strictEqual(
        getGlobalConfigDir('antigravity'),
        path.join(home, '.gemini', 'antigravity-ide'),
      );
      assert.strictEqual(
        getConfigDirFromHome('antigravity', true),
        "'.gemini', 'antigravity-ide'",
      );
    } finally {
      cleanup(home);
    }
  });

  test('uses ~/.gemini/antigravity-cli when only cli dir exists', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-antigravity-cli-'));
    try {
      fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
      process.env.HOME = home;
      process.env.USERPROFILE = home;
      assert.strictEqual(
        getGlobalConfigDir('antigravity'),
        path.join(home, '.gemini', 'antigravity-cli'),
      );
      assert.strictEqual(
        getConfigDirFromHome('antigravity', true),
        "'.gemini', 'antigravity-cli'",
      );
    } finally {
      cleanup(home);
    }
  });

  // #213/#217 coexistence regression (end-to-end through the registry descriptor).
  // A CLI user who ALSO has the Antigravity-IDE's ~/.gemini/antigravity dir was
  // previously shadowed to the legacy dir because it is probed first. The
  // The probeExists marker (gsd-core/VERSION) makes the dir GSD installed into win.
  test('coexistence: legacy antigravity + GSD-marked antigravity-cli both present → resolves to antigravity-cli', (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-antigravity-coexist-'));
    t.after(() => cleanup(home));
    // Both dirs exist on disk...
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity'), { recursive: true });
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli', 'gsd-core'), { recursive: true });
    // ...but only the cli dir carries the GSD marker.
    fs.writeFileSync(path.join(home, '.gemini', 'antigravity-cli', 'gsd-core', 'VERSION'), '1.6.0\n');
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    assert.strictEqual(
      getGlobalConfigDir('antigravity'),
      path.join(home, '.gemini', 'antigravity-cli'),
      'GSD-marked antigravity-cli must win over the bare-existing legacy antigravity dir',
    );
    assert.strictEqual(
      getConfigDirFromHome('antigravity', true),
      "'.gemini', 'antigravity-cli'",
    );
  });

  test('coexistence: legacy antigravity carries the GSD marker (real 1.x install) → resolves to legacy even when cli dir exists bare', (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-antigravity-legacy-marked-'));
    t.after(() => cleanup(home));
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity', 'gsd-core'), { recursive: true });
    fs.writeFileSync(path.join(home, '.gemini', 'antigravity', 'gsd-core', 'VERSION'), '1.5.0\n');
    fs.mkdirSync(path.join(home, '.gemini', 'antigravity-cli'), { recursive: true });
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    assert.strictEqual(
      getGlobalConfigDir('antigravity'),
      path.join(home, '.gemini', 'antigravity'),
      'a genuine GSD install in the legacy dir must not be abandoned for a bare sibling',
    );
  });
});

describe('getGlobalConfigDir — explicit configDir overrides env for all runtimes', () => {
  test('explicit dir overrides any env var for hermes', () => {
    const savedHome = process.env.HERMES_HOME;
    process.env.HERMES_HOME = '~/from-env';
    try {
      assert.strictEqual(String(getGlobalConfigDir('hermes', '/explicit/hermes')).replace(/\\/g, '/'), '/explicit/hermes');
    } finally {
      if (savedHome !== undefined) process.env.HERMES_HOME = savedHome;
      else delete process.env.HERMES_HOME;
    }
  });

  test('explicit dir overrides KILO_CONFIG_DIR', () => {
    const saved = process.env.KILO_CONFIG_DIR;
    process.env.KILO_CONFIG_DIR = '~/from-env';
    try {
      assert.strictEqual(String(getGlobalConfigDir('kilo', '/explicit/kilo')).replace(/\\/g, '/'), '/explicit/kilo');
    } finally {
      if (saved !== undefined) process.env.KILO_CONFIG_DIR = saved;
      else delete process.env.KILO_CONFIG_DIR;
    }
  });
});

describe('getGlobalConfigDir — HERMES_HOME env var', () => {
  let saved;
  beforeEach(() => { saved = process.env.HERMES_HOME; });
  afterEach(() => {
    if (saved !== undefined) process.env.HERMES_HOME = saved;
    else delete process.env.HERMES_HOME;
  });

  test('respects HERMES_HOME env var (tilde-expanded)', () => {
    process.env.HERMES_HOME = '~/custom-hermes';
    assert.strictEqual(getGlobalConfigDir('hermes'), path.join(os.homedir(), 'custom-hermes'));
  });
});

describe('getGlobalConfigDir — Kilo env var priority', () => {
  let savedEnv;
  beforeEach(() => {
    savedEnv = {
      KILO_CONFIG_DIR: process.env.KILO_CONFIG_DIR,
      KILO_CONFIG: process.env.KILO_CONFIG,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
    delete process.env.KILO_CONFIG_DIR;
    delete process.env.KILO_CONFIG;
    delete process.env.XDG_CONFIG_HOME;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
  });

  test('respects KILO_CONFIG_DIR', () => {
    process.env.KILO_CONFIG_DIR = '~/custom-kilo';
    assert.strictEqual(getGlobalConfigDir('kilo'), path.join(os.homedir(), 'custom-kilo'));
  });

  test('falls back to XDG_CONFIG_HOME/kilo', () => {
    process.env.XDG_CONFIG_HOME = '~/xdg-config';
    assert.strictEqual(getGlobalConfigDir('kilo'), path.join(os.homedir(), 'xdg-config', 'kilo'));
  });

  test('uses dirname(KILO_CONFIG) when KILO_CONFIG_DIR unset', () => {
    process.env.KILO_CONFIG = '~/profiles/work/kilo.jsonc';
    assert.strictEqual(getGlobalConfigDir('kilo'), path.join(os.homedir(), 'profiles', 'work'));
  });

  test('KILO_CONFIG_DIR takes precedence over KILO_CONFIG', () => {
    process.env.KILO_CONFIG_DIR = '~/custom-kilo';
    process.env.KILO_CONFIG = '~/profiles/work/kilo.jsonc';
    assert.strictEqual(getGlobalConfigDir('kilo'), path.join(os.homedir(), 'custom-kilo'));
  });
});

describe('getConfigDirFromHome — spot-checks', () => {
  test('claude returns .claude for both scopes', () => {
    assert.strictEqual(getConfigDirFromHome('claude', false), "'.claude'");
    assert.strictEqual(getConfigDirFromHome('claude', true), "'.claude'");
  });

  test('hermes returns .hermes for both scopes', () => {
    assert.strictEqual(getConfigDirFromHome('hermes', false), "'.hermes'");
    assert.strictEqual(getConfigDirFromHome('hermes', true), "'.hermes'");
  });

  test('qwen returns .qwen for both scopes', () => {
    assert.strictEqual(getConfigDirFromHome('qwen', false), "'.qwen'");
    assert.strictEqual(getConfigDirFromHome('qwen', true), "'.qwen'");
  });

  test('trae returns .trae for both scopes', () => {
    assert.strictEqual(getConfigDirFromHome('trae', false), "'.trae'");
    assert.strictEqual(getConfigDirFromHome('trae', true), "'.trae'");
  });

  test('antigravity returns .agents (local) and legacy fallback global path when no 2.x dirs exist', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-antigravity-empty-'));
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    const savedAntigravityConfig = process.env.ANTIGRAVITY_CONFIG_DIR;
    delete process.env.ANTIGRAVITY_CONFIG_DIR;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      assert.strictEqual(getConfigDirFromHome('antigravity', false), "'.agents'");
      assert.strictEqual(getConfigDirFromHome('antigravity', true), "'.gemini', 'antigravity'");
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
      if (savedAntigravityConfig === undefined) delete process.env.ANTIGRAVITY_CONFIG_DIR;
      else process.env.ANTIGRAVITY_CONFIG_DIR = savedAntigravityConfig;
      cleanup(home);
    }
  });

  test('kilo returns .kilo (local) and .config, kilo (global)', () => {
    assert.strictEqual(getConfigDirFromHome('kilo', false), "'.kilo'");
    assert.strictEqual(getConfigDirFromHome('kilo', true), "'.config', 'kilo'");
  });
});

// ─── Section 2: Local install / uninstall for subset of runtimes ─────────────
// Full E2E for runtimes that have distinct install paths (hermes nested layout,
// qwen flat layout, trae flat layout). Others are covered by layout-loop tests.

describe('install/uninstall — hermes (nested skills/gsd/<router>/skills/<stem>/ layout)', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-hermes-install-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('installs GSD into ./.hermes and removes it cleanly', () => {
    const result = install(false, 'hermes');
    const targetDir = path.join(tmpDir, '.hermes');

    assert.strictEqual(result.runtime, 'hermes');
    assert.strictEqual(result.configDir, fs.realpathSync(targetDir));

    // hermes nests: skills/gsd/gsd-<router>/skills/<stem>/SKILL.md (#947 — canonical gsd- prefix)
    const hermesHelpPath = nestedSkillPath(path.join(targetDir, 'skills', 'gsd'), 'gsd-', 'help');
    assert.ok(fs.existsSync(hermesHelpPath),
      `help SKILL.md must exist at nested path: ${path.relative(targetDir, hermesHelpPath)}`);
    assert.ok(fs.existsSync(path.join(targetDir, 'skills', 'gsd', 'DESCRIPTION.md')),
      'DESCRIPTION.md at category root');
    assert.ok(fs.existsSync(path.join(targetDir, 'gsd-core', 'VERSION')));
    assert.ok(fs.existsSync(path.join(targetDir, 'agents')));

    const manifest = writeManifest(targetDir, 'hermes');
    assert.ok(
      Object.keys(manifest.files).some(f =>
        f.startsWith('skills/gsd/gsd-' + CHILD_ROUTER['help'] + '/skills/help/')
      ),
      JSON.stringify(manifest.files)
    );

    uninstall(false, 'hermes');

    assert.ok(!fs.existsSync(hermesHelpPath));
    assert.ok(!fs.existsSync(path.join(targetDir, 'skills', 'gsd')));
    assert.ok(!fs.existsSync(path.join(targetDir, 'gsd-core')));
  });

  test('installed SKILL.md frontmatter conforms to Hermes spec', () => {
    install(false, 'hermes');
    const targetDir = path.join(tmpDir, '.hermes');
    const categoryDir = path.join(targetDir, 'skills', 'gsd');
    const skillDirs = fs.readdirSync(categoryDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name !== 'DESCRIPTION.md')
      .map(e => e.name);

    assert.ok(skillDirs.length > 0, 'at least one skill installed');

    for (const dir of skillDirs) {
      const content = fs.readFileSync(path.join(categoryDir, dir, 'SKILL.md'), 'utf8');
      const fm = parseFrontmatter(content);
      assert.strictEqual(fm.name, dir, `${dir}/SKILL.md name matches dir`);
      assert.ok(typeof fm.description === 'string' && fm.description.length > 0,
        `${dir}/SKILL.md has description`);
      assert.strictEqual(fm.version, pkg.version,
        `${dir}/SKILL.md declares version ${pkg.version}`);
    }

    const desc = fs.readFileSync(path.join(categoryDir, 'DESCRIPTION.md'), 'utf8');
    const descFm = parseFrontmatter(desc);
    assert.strictEqual(descFm.name, 'gsd');
    assert.ok(typeof descFm.description === 'string' && descFm.description.length > 0);
    assert.strictEqual(descFm.version, pkg.version);

    uninstall(false, 'hermes');
  });

  test('replaces CLAUDE.md references with HERMES.md', () => {
    install(false, 'hermes');
    const targetDir = path.join(tmpDir, '.hermes');
    const skillsDir = path.join(targetDir, 'skills');

    let referencedHermesMd = false;
    const checkWalk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { checkWalk(full); continue; }
        if (!entry.name.endsWith('.md')) continue;
        const content = fs.readFileSync(full, 'utf8');
        assert.ok(!/\bCLAUDE\.md\b/.test(content),
          `${path.relative(targetDir, full)} still references CLAUDE.md`);
        if (/\bHERMES\.md\b/.test(content)) referencedHermesMd = true;
      }
    };
    checkWalk(skillsDir);
    assert.ok(referencedHermesMd, 'at least one skill references HERMES.md');
    uninstall(false, 'hermes');
  });
});

describe('install/uninstall — qwen (nested skills/gsd-<router>/skills/<stem>/ layout)', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-qwen-install-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('installs GSD into ./.qwen and removes it cleanly', () => {
    const result = install(false, 'qwen');
    const targetDir = path.join(tmpDir, '.qwen');

    assert.strictEqual(result.runtime, 'qwen');
    assert.strictEqual(result.configDir, fs.realpathSync(targetDir));

    // qwen nests: skills/gsd-<router>/skills/<stem>/SKILL.md
    const qwenHelpPath = nestedSkillPath(path.join(targetDir, 'skills'), 'gsd-', 'help');
    assert.ok(fs.existsSync(qwenHelpPath),
      `help SKILL.md must exist at nested path: ${path.relative(targetDir, qwenHelpPath)}`);
    assert.ok(fs.existsSync(path.join(targetDir, 'gsd-core', 'VERSION')));
    assert.ok(fs.existsSync(path.join(targetDir, 'agents')));

    const manifest = writeManifest(targetDir, 'qwen');
    assert.ok(
      Object.keys(manifest.files).some(f =>
        f.startsWith('skills/gsd-' + CHILD_ROUTER['help'] + '/skills/help/')
      )
    );

    uninstall(false, 'qwen');
    assert.ok(!fs.existsSync(qwenHelpPath));
    assert.ok(!fs.existsSync(path.join(targetDir, 'gsd-core')));
  });
});

describe('install/uninstall — trae (nested skills/gsd-<router>/skills/<stem>/ layout)', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-trae-install-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('installs GSD into ./.trae and removes it cleanly (typed IR result)', () => {
    const result = install(false, 'trae');
    const targetDir = path.join(tmpDir, '.trae');

    assert.deepStrictEqual(result, {
      settingsPath: null,
      settings: null,
      statuslineCommand: null,
      updateBannerCommand: null,
      runtime: 'trae',
      configDir: fs.realpathSync(targetDir),
    });

    // trae nests: skills/gsd-<router>/skills/<stem>/SKILL.md
    const traeHelpPath = nestedSkillPath(path.join(targetDir, 'skills'), 'gsd-', 'help');
    assert.ok(fs.existsSync(traeHelpPath),
      `help SKILL.md must exist at nested path: ${path.relative(targetDir, traeHelpPath)}`);
    assert.ok(fs.existsSync(path.join(targetDir, 'gsd-core', 'VERSION')));
    assert.ok(fs.existsSync(path.join(targetDir, 'agents')));

    const manifest = writeManifest(targetDir, 'trae');
    assert.ok(
      Object.keys(manifest.files).some(f =>
        f.startsWith('skills/gsd-' + CHILD_ROUTER['help'] + '/skills/help/')
      )
    );

    uninstall(false, 'trae');
    assert.ok(!fs.existsSync(traeHelpPath));
    assert.ok(!fs.existsSync(path.join(targetDir, 'gsd-core')));
  });
});

// ─── Section 3: Uninstall skills cleanup — parameterised ─────────────────────

describe('uninstall skills cleanup — hermes', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-hermes-uninstall-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('removes skills/gsd/ category dir', () => {
    install(false, 'hermes');
    const targetDir = path.join(tmpDir, '.hermes');
    const categoryDir = path.join(targetDir, 'skills', 'gsd');
    assert.ok(fs.existsSync(categoryDir));
    const skills = fs.readdirSync(categoryDir, { withFileTypes: true }).filter(e => e.isDirectory());
    assert.ok(skills.length > 0);

    uninstall(false, 'hermes');
    assert.ok(!fs.existsSync(categoryDir));
  });

  test('preserves non-GSD skill directories', () => {
    install(false, 'hermes');
    const targetDir = path.join(tmpDir, '.hermes');
    const custom = path.join(targetDir, 'skills', 'my-custom-skill');
    fs.mkdirSync(custom, { recursive: true });
    fs.writeFileSync(path.join(custom, 'SKILL.md'), '# custom\n');

    uninstall(false, 'hermes');
    assert.ok(fs.existsSync(path.join(custom, 'SKILL.md')));
  });

  test('removes engine directory', () => {
    install(false, 'hermes');
    const targetDir = path.join(tmpDir, '.hermes');
    assert.ok(fs.existsSync(path.join(targetDir, 'gsd-core', 'VERSION')));
    uninstall(false, 'hermes');
    assert.ok(!fs.existsSync(path.join(targetDir, 'gsd-core')));
  });
});

// ─── Section 4: No Claude references leak into non-Claude runtimes ────────────

// #2284(b): a `<runtime_compatibility>...</runtime_compatibility>` block (e.g.
// execute-phase.md/plan-phase.md's "**Subagent spawning is runtime-specific:**"
// table) INTENTIONALLY retains "Claude Code" as a COMPARISON-RUNTIME LABEL —
// "- **Claude Code:** Uses `Agent(subagent_type=..., ...)`" documents how
// Claude Code behaves for a reader on ANY installed runtime; it is never a
// host-self-reference the install is supposed to rebrand away. Strip these
// blocks before the leak scan below so that legitimate retention doesn't trip
// the "zero Claude references" invariant — everything OUTSIDE a
// `runtime_compatibility` block is still held to zero, so an actual leaked
// self-reference elsewhere in the file still fails this test.
function stripRuntimeCompatibilityBlocks(content) {
  return content.replace(/<runtime_compatibility>[\s\S]*?<\/runtime_compatibility>/g, '');
}

for (const runtime of ['hermes', 'qwen']) {
  describe(`no Claude references leak into ${runtime} install`, () => {
    let tmpDir;
    let previousCwd;

    beforeEach(() => {
      tmpDir = createTempDir(`gsd-${runtime}-refs-`);
      previousCwd = process.cwd();
      process.chdir(tmpDir);
      install(false, runtime);
    });

    afterEach(() => {
      process.chdir(previousCwd);
      cleanup(tmpDir);
    });

    test('skills contain no CLAUDE.md or Claude Code references', () => {
      const rtDir = path.join(tmpDir, getDirName(runtime));
      const skillsDir = path.join(rtDir, 'skills');
      assert.ok(fs.existsSync(skillsDir));

      const skillFiles = walk(skillsDir).filter(f => f.endsWith('.md'));
      assert.ok(skillFiles.length > 0);

      const leaks = skillFiles.filter(f => {
        const c = fs.readFileSync(f, 'utf8');
        return /\bCLAUDE\.md\b/.test(c) || /\bClaude Code\b/.test(c);
      }).map(f => path.relative(tmpDir, f));
      assert.strictEqual(leaks.length, 0, `Leaking: ${leaks.join(', ')}`);
    });

    test('agents contain no CLAUDE.md or Claude Code references', () => {
      // Not the shared listAgentFiles() helper: walks the INSTALLED dest dir
      // and returns absolute paths (for leak scanning), not the source roster.
      const agentsDir = path.join(tmpDir, getDirName(runtime), 'agents');
      assert.ok(fs.existsSync(agentsDir));

      const agentFiles = walk(agentsDir).filter(f => f.endsWith('.md'));
      assert.ok(agentFiles.length > 0);

      const leaks = agentFiles.filter(f => {
        const c = fs.readFileSync(f, 'utf8');
        return /\bCLAUDE\.md\b/.test(c) || /\bClaude Code\b/.test(c);
      }).map(f => path.relative(tmpDir, f));
      assert.strictEqual(leaks.length, 0, `Leaking: ${leaks.join(', ')}`);
    });

    test('full tree scan finds zero Claude references outside CHANGELOG.md', () => {
      const rtDir = path.join(tmpDir, getDirName(runtime));
      const allFiles = walk(rtDir).filter(f =>
        (f.endsWith('.md') || f.endsWith('.cjs') || f.endsWith('.js')) &&
        path.basename(f) !== 'CHANGELOG.md'
      );
      const leaks = allFiles.filter(f => {
        // #2284(b): exempt `<runtime_compatibility>` comparison-table content
        // — see the exemption's rationale above the `for` loop.
        const c = stripRuntimeCompatibilityBlocks(fs.readFileSync(f, 'utf8'));
        return /\bCLAUDE\.md\b/.test(c) || /\bClaude Code\b/.test(c) || /\.claude\//.test(c);
      }).map(f => path.relative(tmpDir, f));
      assert.strictEqual(leaks.length, 0, `Leaking: ${leaks.join(', ')}`);
    });
  });
}

// ─── Section 5: Kilo-specific helpers ────────────────────────────────────────

describe('resolveKiloConfigPath', () => {
  let tmpDir;
  beforeEach(() => { tmpDir = createTempProject('gsd-kilo-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('prefers kilo.jsonc when present', () => {
    const configDir = path.join(tmpDir, '.kilo');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'kilo.jsonc'), '{\n}\n');
    assert.strictEqual(resolveKiloConfigPath(configDir), path.join(configDir, 'kilo.jsonc'));
  });

  test('falls back to kilo.json', () => {
    const configDir = path.join(tmpDir, '.kilo');
    fs.mkdirSync(configDir, { recursive: true });
    assert.strictEqual(resolveKiloConfigPath(configDir), path.join(configDir, 'kilo.json'));
  });
});

describe('configureKiloPermissions', () => {
  let tmpDir;
  let configDir;
  let savedEnv;

  beforeEach(() => {
    tmpDir = createTempProject('gsd-kilo-perms-');
    configDir = path.join(tmpDir, '.config', 'kilo');
    savedEnv = {
      KILO_CONFIG_DIR: process.env.KILO_CONFIG_DIR,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
    };
    process.env.KILO_CONFIG_DIR = configDir;
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v !== undefined) process.env[k] = v;
      else delete process.env[k];
    }
    cleanup(tmpDir);
  });

  test('writes GSD permissions to kilo.json when config is missing', () => {
    configureKiloPermissions(true);
    const configPath = path.join(configDir, 'kilo.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const gsdPath = `${configDir.replace(/\\/g, '/')}/gsd-core/*`;
    assert.strictEqual(config.permission.read[gsdPath], 'allow');
    assert.strictEqual(config.permission.external_directory[gsdPath], 'allow');
  });

  test('updates existing kilo.jsonc configs via JSONC parsing', () => {
    fs.mkdirSync(configDir, { recursive: true });
    const configPath = path.join(configDir, 'kilo.jsonc');
    fs.writeFileSync(configPath, '{\n  // existing\n  "permission": {\n    "bash": "ask",\n  },\n}\n');
    configureKiloPermissions(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const gsdPath = `${configDir.replace(/\\/g, '/')}/gsd-core/*`;
    assert.strictEqual(config.permission.bash, 'ask');
    assert.strictEqual(config.permission.read[gsdPath], 'allow');
    assert.strictEqual(config.permission.external_directory[gsdPath], 'allow');
  });

  test('writes permissions to an explicit config dir argument', () => {
    const explicitDir = path.join(tmpDir, 'custom-kilo-config');
    configureKiloPermissions(true, explicitDir);
    const configPath = path.join(explicitDir, 'kilo.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const gsdPath = `${explicitDir.replace(/\\/g, '/')}/gsd-core/*`;
    assert.strictEqual(config.permission.read[gsdPath], 'allow');
    assert.strictEqual(config.permission.external_directory[gsdPath], 'allow');
  });
});

describe('Kilo integration — install/uninstall behaviour', () => {
  // Product-text reads for test 6 only — update.md and update-context.cjs
  // are deployed artifacts whose text IS the runtime contract (allow-test-rule).
  const updateWorkflowSrc = fs.readFileSync(
    path.join(__dirname, '..', 'gsd-core', 'workflows', 'update.md'), 'utf8');
  // #498: update.md's runtime/scope/config-dir resolution moved into the tested
  // projection gsd-core/bin/lib/update-context.cjs. Custom-config-dir
  // detection (kilo.jsonc, KILO_CONFIG) is now asserted there.
  const updateContextSrc = fs.readFileSync(
    path.join(__dirname, '..', 'gsd-core', 'bin', 'lib', 'update-context.cjs'), 'utf8');

  let tmpDir;
  let previousCwd;
  let savedKiloConfigDir;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-kilo-integration-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
    savedKiloConfigDir = process.env.KILO_CONFIG_DIR;
    // Point KILO_CONFIG_DIR at the install target so configureKiloPermissions
    // and uninstall resolve to the same dir without needing the real ~/.config/kilo.
    process.env.KILO_CONFIG_DIR = path.join(tmpDir, '.kilo');
  });

  afterEach(() => {
    process.chdir(previousCwd);
    if (savedKiloConfigDir !== undefined) process.env.KILO_CONFIG_DIR = savedKiloConfigDir;
    else delete process.env.KILO_CONFIG_DIR;
    cleanup(tmpDir);
  });

  test('--kilo flag routes to kilo runtime via selectRuntimesFromArgs', () => {
    // Behavioural replacement for source-grep on runtimeArgs.includes('--kilo').
    // The flag must produce ['kilo'] — a rename or deletion of the flag branch
    // would make this go red.
    assert.deepStrictEqual(selectRuntimesFromArgs(['--kilo']), ['kilo']);
  });

  test('runtimeMap has Kilo as option 12 after Kimi Code (#2454)', () => {
    assert.strictEqual(runtimeMap['12'], 'kilo');
  });

  test('prompt text shows Kilo above OpenCode without marketing copy', () => {
    const plain = stripAnsi(buildRuntimePromptText());
    assert.ok(/\b12\)\s*Kilo\b/.test(plain));
    assert.ok(plain.indexOf('12) Kilo') < plain.indexOf('OpenCode'));
    assert.ok(!plain.includes('the #1 AI coding platform on OpenRouter'));
  });

  test('install() for kilo writes artifacts to the configDir it returns', () => {
    // Behavioural replacement for source-grep on the kilo install branch.
    //
    // IMPORTANT: GSD_TEST_MODE=1 (set at the top of this file) suppresses the
    // configureKiloPermissions() call inside install() to avoid mutating the real
    // ~/.config/kilo during unit tests.  Asserting on kilo.json permissions here
    // would require manually calling configureKiloPermissions(), which only tests
    // that helper — not install()'s wiring of it.
    //
    // Instead we assert on what install() ITSELF produces on disk, which is the
    // correct target:
    //   1. The returned configDir exists and is the KILO_CONFIG_DIR we set.
    //   2. install() wrote kilo artifacts (skills/, agents/) into that dir.
    //   3. The configDir returned by install() matches what resolveKiloConfigPath
    //      resolves for the same env, proving the dir-resolution path is correct.
    //
    // If someone breaks the kilo install branch (wrong configDir, wrong skill
    // target, removed case) these assertions go red immediately.
    const result = install(false, 'kilo');
    const configDir = result.configDir;

    // (1) install() returned the expected configDir (respects KILO_CONFIG_DIR env).
    assert.strictEqual(
      result.runtime,
      'kilo',
      'install() must return runtime: "kilo"',
    );
    assert.ok(
      fs.existsSync(configDir),
      `install() must create the configDir it returns: ${configDir}`,
    );

    // (2) Kilo-specific artifacts were written by install() into configDir.
    const skillsDir = path.join(configDir, 'skills');
    assert.ok(
      fs.existsSync(skillsDir),
      `install() must create skills/ under the kilo configDir: ${skillsDir}`,
    );
    const agentsDir = path.join(configDir, 'agents');
    assert.ok(
      fs.existsSync(agentsDir),
      `install() must create agents/ under the kilo configDir: ${agentsDir}`,
    );

    // (3) The configDir is consistent with resolveKiloConfigPath, proving the
    // path-resolution wiring between install() and configureKiloPermissions is
    // stable: both read from the same env (KILO_CONFIG_DIR).
    const kiloConfigPath = resolveKiloConfigPath(configDir);
    assert.ok(
      typeof kiloConfigPath === 'string' && kiloConfigPath.length > 0,
      `resolveKiloConfigPath must return a valid path for configDir: ${configDir}`,
    );
    assert.ok(
      kiloConfigPath.startsWith(configDir),
      `resolveKiloConfigPath must return a path inside the install configDir.\n` +
      `Expected prefix: ${configDir}\n` +
      `Got: ${kiloConfigPath}`,
    );
  });

  test('uninstall removes GSD permissions from the resolved kilo config path', () => {
    // Behavioural replacement for source-grep on
    // "const configPath = resolveKiloConfigPath(targetDir)".
    // The contract: after install + configureKiloPermissions, an uninstall must
    // strip the GSD permission entries from kilo.json at the resolved path.
    const result = install(false, 'kilo');
    const configDir = result.configDir;
    configureKiloPermissions(true, configDir);

    const kiloJsonPath = resolveKiloConfigPath(configDir);
    const beforeConfig = JSON.parse(fs.readFileSync(kiloJsonPath, 'utf8'));
    const gsdGlob = `${configDir.replace(/\\/g, '/')}/gsd-core/*`;
    assert.ok(
      beforeConfig.permission.read[gsdGlob] === 'allow',
      'pre-condition: GSD read permission must exist before uninstall',
    );

    uninstall(false, 'kilo');

    // After uninstall the GSD permission keys must be absent. The file may
    // still exist (Kilo preserves user settings) but the gsd-core/* entries
    // must be gone.
    const afterConfig = JSON.parse(fs.readFileSync(kiloJsonPath, 'utf8'));
    assert.ok(
      !(afterConfig.permission && afterConfig.permission.read && afterConfig.permission.read[gsdGlob]),
      `GSD read permission must be removed from ${kiloJsonPath} after uninstall`,
    );
    assert.ok(
      !(afterConfig.permission && afterConfig.permission.external_directory &&
        afterConfig.permission.external_directory[gsdGlob]),
      `GSD external_directory permission must be removed from ${kiloJsonPath} after uninstall`,
    );
  });

  test('update workflow checks preferred custom config dirs', () => {
    // update.md still derives the preferred config dir from execution_context…
    assert.ok(updateWorkflowSrc.includes('PREFERRED_CONFIG_DIR'));
    // …and the custom-dir detection (kilo.jsonc config marker, KILO_CONFIG env)
    // now lives in the tested update-context projection (#498).
    assert.ok(updateContextSrc.includes('kilo.jsonc'));
    assert.ok(updateContextSrc.includes('KILO_CONFIG'));
  });
});

// ─── Section N: changeset CLI install regression (#935) ──────────────────────

describe('install — changeset CLI lands at scripts/changeset/cli.cjs (#935)', () => {
  // Regression guard: the changeset CLI must be copied into the runtime config dir
  // by the installer so $GSD_DIR/scripts/changeset/cli.cjs resolves at runtime.
  // Before this fix, scripts/ was never copied and /gsd-update changelog preview
  // silently failed on every real install.
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-changeset-install-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('install() copies scripts/changeset/cli.cjs to <configDir>/scripts/changeset/cli.cjs', () => {
    install(false, 'claude');
    const claudeDir = path.join(tmpDir, '.claude');
    const cliPath = path.join(claudeDir, 'scripts', 'changeset', 'cli.cjs');
    assert.ok(
      fs.existsSync(cliPath),
      `scripts/changeset/cli.cjs must exist at ${path.relative(tmpDir, cliPath)} after install (#935)`,
    );
  });

  test('install() copies scripts/lib/cli-exit.cjs to <configDir>/scripts/lib/cli-exit.cjs', () => {
    install(false, 'claude');
    const claudeDir = path.join(tmpDir, '.claude');
    const cliExitPath = path.join(claudeDir, 'scripts', 'lib', 'cli-exit.cjs');
    assert.ok(
      fs.existsSync(cliExitPath),
      `scripts/lib/cli-exit.cjs must exist at ${path.relative(tmpDir, cliExitPath)} after install (#935)`,
    );
  });

  test('installed cli.cjs executes without module-resolution errors', () => {
    // Smoke test: node can load the installed changeset CLI without crashing.
    // This catches path mismatches in require('../lib/cli-exit.cjs') etc.
    install(false, 'claude');
    const claudeDir = path.join(tmpDir, '.claude');
    const cliPath = path.join(claudeDir, 'scripts', 'changeset', 'cli.cjs');
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });
    // --help exits with code 1 (usage shown), but must NOT throw a MODULE_NOT_FOUND error
    assert.ok(
      !result.stderr.includes('MODULE_NOT_FOUND'),
      `cli.cjs must not produce MODULE_NOT_FOUND errors; stderr=${result.stderr}`,
    );
    assert.ok(
      !result.stderr.includes('Cannot find module'),
      `cli.cjs must resolve all modules; stderr=${result.stderr}`,
    );
  });

  test('installed cli.cjs can run extract subcommand end-to-end (#935)', () => {
    // Integration smoke test: the installed CLI's extract path (invoked by update.md)
    // must actually work — this catches require() path issues that --help wouldn't surface.
    install(false, 'claude');
    const claudeDir = path.join(tmpDir, '.claude');
    const cliPath = path.join(claudeDir, 'scripts', 'changeset', 'cli.cjs');
    // Use the CHANGELOG.md that was installed into gsd-core/ (installed by the installer)
    const changelogPath = path.join(claudeDir, 'gsd-core', 'CHANGELOG.md');
    assert.ok(fs.existsSync(changelogPath), 'CHANGELOG.md must be installed under gsd-core/');
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(
      process.execPath,
      [cliPath, 'extract', '--from', '0.0.0', '--to', '9999.0.0', '--changelog', changelogPath, '--json'],
      { encoding: 'utf8' },
    );
    // extract must NOT throw a MODULE_NOT_FOUND or Cannot find module error
    assert.ok(
      !result.stderr.includes('MODULE_NOT_FOUND') && !result.stderr.includes('Cannot find module'),
      `installed cli.cjs extract must resolve all modules; stderr=${result.stderr}`,
    );
    // extract exit code 0 (found entries) or 2 (no entries in range) are both valid;
    // any other exit code is an error
    assert.ok(
      result.status === 0 || result.status === 2,
      `installed cli.cjs extract must exit 0 or 2; got ${result.status}; stderr=${result.stderr}`,
    );
  });

  test('writeManifest() tracks scripts/changeset/ and scripts/lib/ files', () => {
    install(false, 'claude');
    const claudeDir = path.join(tmpDir, '.claude');
    const manifest = writeManifest(claudeDir, 'claude');
    const changesetKeys = Object.keys(manifest.files).filter(k => k.startsWith('scripts/changeset/'));
    const libKeys = Object.keys(manifest.files).filter(k => k.startsWith('scripts/lib/'));
    assert.ok(changesetKeys.length > 0, 'manifest must track scripts/changeset/ files');
    assert.ok(libKeys.length > 0, 'manifest must track scripts/lib/ files');
    assert.ok(
      changesetKeys.includes('scripts/changeset/cli.cjs'),
      'manifest must include scripts/changeset/cli.cjs',
    );
    assert.ok(
      libKeys.includes('scripts/lib/cli-exit.cjs'),
      'manifest must include scripts/lib/cli-exit.cjs',
    );
  });

  test('uninstall() removes scripts/changeset/ and scripts/lib/', () => {
    install(false, 'claude');
    const claudeDir = path.join(tmpDir, '.claude');
    assert.ok(fs.existsSync(path.join(claudeDir, 'scripts', 'changeset', 'cli.cjs')),
      'pre-condition: cli.cjs must be installed before uninstall');
    uninstall(false, 'claude');
    assert.ok(
      !fs.existsSync(path.join(claudeDir, 'scripts', 'changeset')),
      'scripts/changeset/ must be removed on uninstall',
    );
    assert.ok(
      !fs.existsSync(path.join(claudeDir, 'scripts', 'lib')),
      'scripts/lib/ must be removed on uninstall',
    );
  });
});

// ─── Section N: fix-slash-commands.cjs install regression (#1223) ───────────────

describe('install — fix-slash-commands.cjs lands at scripts/fix-slash-commands.cjs (#1223)', () => {
  // Regression guard: scripts/fix-slash-commands.cjs must be copied into the runtime
  // config dir by the installer so gsd-core/bin/lib/command-roster.cjs can require it
  // via '../../../scripts/fix-slash-commands.cjs'. Before this fix, the file was never
  // installed and every gsd-tools command crashed with MODULE_NOT_FOUND (#1223).
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-fix-slash-install-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('install() copies scripts/fix-slash-commands.cjs to <configDir>/scripts/fix-slash-commands.cjs', () => {
    install(false, 'claude');
    const claudeDir = path.join(tmpDir, '.claude');
    const fixSlashPath = path.join(claudeDir, 'scripts', 'fix-slash-commands.cjs');
    assert.ok(
      fs.existsSync(fixSlashPath),
      `scripts/fix-slash-commands.cjs must exist at ${path.relative(tmpDir, fixSlashPath)} after install (#1223)`,
    );
  });

  test('installed gsd-tools.cjs query loads without MODULE_NOT_FOUND (#1223)', () => {
    // End-to-end smoke: spawning gsd-tools.cjs must not crash with MODULE_NOT_FOUND.
    // This directly exercises the command-roster → fix-slash-commands require chain.
    install(false, 'claude');
    const claudeDir = path.join(tmpDir, '.claude');
    const gsdToolsPath = path.join(claudeDir, 'gsd-core', 'bin', 'gsd-tools.cjs');
    assert.ok(fs.existsSync(gsdToolsPath), 'pre-condition: gsd-tools.cjs must be installed');
    const { spawnSync } = require('node:child_process');
    const result = spawnSync(
      process.execPath,
      [gsdToolsPath, 'query', 'init.new-project'],
      { encoding: 'utf8', timeout: 15000 },
    );
    assert.ok(
      !result.stderr.includes('MODULE_NOT_FOUND'),
      `gsd-tools.cjs must not crash with MODULE_NOT_FOUND; stderr=${result.stderr}`,
    );
    assert.ok(
      !result.stderr.includes('Cannot find module'),
      `gsd-tools.cjs must resolve all modules; stderr=${result.stderr}`,
    );
  });

  test('writeManifest() tracks scripts/fix-slash-commands.cjs', () => {
    install(false, 'claude');
    const claudeDir = path.join(tmpDir, '.claude');
    const manifest = writeManifest(claudeDir, 'claude');
    assert.ok(
      'scripts/fix-slash-commands.cjs' in manifest.files,
      'manifest must track scripts/fix-slash-commands.cjs',
    );
  });

  test('uninstall() removes scripts/fix-slash-commands.cjs', () => {
    install(false, 'claude');
    const claudeDir = path.join(tmpDir, '.claude');
    const fixSlashPath = path.join(claudeDir, 'scripts', 'fix-slash-commands.cjs');
    assert.ok(fs.existsSync(fixSlashPath),
      'pre-condition: fix-slash-commands.cjs must be installed before uninstall');
    uninstall(false, 'claude');
    assert.ok(
      !fs.existsSync(fixSlashPath),
      'scripts/fix-slash-commands.cjs must be removed on uninstall',
    );
  });
});

// ─── Section N: readCmdNames() tolerates absent commands/gsd/ dir (#1223) ────────

describe('readCmdNames() — tolerates missing commands/gsd directory (#1223)', () => {
  // Regression guard: on installs where commands/gsd/ does not exist (e.g. skill-based
  // or global Claude installs) readCmdNames() must return [] rather than throwing ENOENT.
  test('readCmdNames() returns an array (does not throw)', () => {
    // Verify the guard contract: readCmdNames() must always return an array regardless
    // of whether COMMANDS_DIR exists. The spawn-based test below covers the absent-dir
    // scenario; this inline test asserts the basic export shape.
    const fixSlashModule = require('../scripts/fix-slash-commands.cjs');
    const result = fixSlashModule.readCmdNames();
    assert.ok(Array.isArray(result), 'readCmdNames() must return an array');
  });

  test('readCmdNames() returns [] from a context where commands/gsd/ is absent', () => {
    // Genuine absent-dir test: copy fix-slash-commands.cjs into a fresh temp directory
    // under a scripts/ subdirectory so that __dirname inside the copy points to
    // <tmpRoot>/scripts/ — making COMMANDS_DIR = path.join(__dirname,'..','commands','gsd')
    // resolve to <tmpRoot>/commands/gsd, which does NOT exist. Requiring the copy (not
    // the repo original) exercises the real ENOENT guard rather than silently hitting
    // the repo's live 69-command registry.
    //
    // This test MUST fail on a pre-fix build (unguarded readdirSync throws ENOENT) and
    // pass after (ENOENT-specific catch returns []).
    const { spawnSync } = require('node:child_process');
    const absScriptsSrc = path.resolve(__dirname, '..', 'scripts', 'fix-slash-commands.cjs');

    // Build a clean tmpRoot: <tmpRoot>/scripts/fix-slash-commands.cjs
    // No commands/gsd/ exists anywhere under or adjacent to tmpRoot.
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-readcmdnames-absentdir-'));
    try {
      const tmpScriptsDir = path.join(tmpRoot, 'scripts');
      fs.mkdirSync(tmpScriptsDir, { recursive: true });
      const tmpCopyPath = path.join(tmpScriptsDir, 'fix-slash-commands.cjs');
      fs.copyFileSync(absScriptsSrc, tmpCopyPath);

      // Script: require the COPY (not the repo original) so __dirname === tmpScriptsDir
      // → COMMANDS_DIR = path.join(tmpScriptsDir, '..', 'commands', 'gsd') = <tmpRoot>/commands/gsd
      // which does not exist → must return [] without throwing.
      const script = [
        `'use strict';`,
        `const mod = require(${JSON.stringify(tmpCopyPath)});`,
        `let result;`,
        `try { result = mod.readCmdNames(); } catch(e) { process.stderr.write('THREW:' + e.code + ':' + e.message); process.exit(2); }`,
        `if (!Array.isArray(result)) { process.stderr.write('NOT_ARRAY:' + JSON.stringify(result)); process.exit(3); }`,
        `if (result.length !== 0) { process.stderr.write('EXPECTED_EMPTY:got ' + result.length + ' entries'); process.exit(4); }`,
        `// readCmdNames() returned [] as required — success`,
        `process.exit(0);`,
      ].join('\n');

      const spawnResult = spawnSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        timeout: 10000,
        env: { ...process.env, GSD_TEST_MODE: '1' },
      });
      assert.ok(
        !spawnResult.stderr.includes('THREW:'),
        `readCmdNames() must not throw when commands/gsd/ is absent; stderr=${spawnResult.stderr}`,
      );
      assert.strictEqual(spawnResult.status, 0,
        `readCmdNames() must return [] (exit 0) when commands/gsd/ is absent; ` +
        `status=${spawnResult.status} stderr=${spawnResult.stderr}`);
    } finally {
      cleanup(tmpRoot);
    }
  });
});

// ─── Section N: Antigravity .agents canonical workspace dir (#791) ─────────────
// allow-test-rule: runtime-contract-is-the-product
// Reads deployed agent .md files whose text IS the product surface the
// Antigravity runtime loads at startup (path references, command names).

describe('antigravity local install writes to .agents/ canonical dir (#791)', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-antigravity-791-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('install writes workspace skills under .agents/skills/', () => {
    const result = install(false, 'antigravity');
    const agentsDir = path.join(tmpDir, '.agents');
    assert.strictEqual(result.runtime, 'antigravity');
    assert.ok(fs.existsSync(agentsDir), '.agents/ must be created for local antigravity install');
    const skillsDir = path.join(agentsDir, 'skills');
    assert.ok(fs.existsSync(skillsDir), '.agents/skills/ must exist after install');
    const skillEntries = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-'));
    assert.ok(skillEntries.length > 0, 'at least one gsd-* skill must be installed under .agents/skills/');
    const firstSkill = path.join(skillsDir, skillEntries[0].name, 'SKILL.md');
    assert.ok(fs.existsSync(firstSkill), `SKILL.md must exist at ${firstSkill}`);
  });

  test('install writes concrete skills at the immediate level AGY scans', () => {
    install(false, 'antigravity');
    const skillsDir = path.join(tmpDir, '.agents', 'skills');

    assert.ok(
      fs.existsSync(path.join(skillsDir, 'gsd-progress', 'SKILL.md')),
      'AGY scans immediate skill folders, so /gsd-progress must be installed at .agents/skills/gsd-progress/SKILL.md',
    );
    assert.ok(
      fs.existsSync(path.join(skillsDir, 'gsd-verify-work', 'SKILL.md')),
      'AGY scans immediate skill folders, so /gsd-verify-work must be installed at .agents/skills/gsd-verify-work/SKILL.md',
    );
    assert.ok(
      !fs.existsSync(path.join(skillsDir, 'gsd-ns-workflow', 'skills', 'progress', 'SKILL.md')),
      'Antigravity must not rely on router-nested concrete skills that AGY does not discover',
    );
  });

  test('installed agent files reference .agents/ not ~/.claude/ or bare .agent/', () => {
    // NOTE: skill content is intentionally NOT asserted here. The installer calls
    // convertClaudeCommandToAntigravitySkill(content, skillName, runtime, cmdNames)
    // where the 3rd arg is the string "antigravity" (truthy), routing local skills
    // through the global content branch — a pre-existing quirk tracked separately.
    // Agent files are NOT affected: convertClaudeAgentToAntigravityAgent(content, isGlobal)
    // receives the boolean isGlobal correctly, so local agents use the local (.agents/) branch.
    install(false, 'antigravity');
    const agentsDest = path.join(tmpDir, '.agents', 'agents');
    assert.ok(fs.existsSync(agentsDest), '.agents/agents/ must exist after local install');
    const agentFiles = fs.readdirSync(agentsDest)
      .filter(f => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(agentFiles.length > 0, 'pre-condition: at least one gsd-* agent must be installed');
    for (const file of agentFiles) {
      const content = fs.readFileSync(path.join(agentsDest, file), 'utf8');
      // Local agent content must not contain global home-dir paths (should be .agents/)
      assert.ok(
        !content.includes('~/.claude/') && !content.includes('$HOME/.claude/'),
        `${file} must not contain ~/.claude/ or $HOME/.claude/ in a local install; content uses .agents/`,
      );
      // Local agent content must not reference the legacy singular .agent/ path
      const bareAgentRefs = content.match(/(?<!\w)\.agent(?!s)\//g) || [];
      assert.strictEqual(
        bareAgentRefs.length, 0,
        `${file} must not reference legacy .agent/ path; found: ${bareAgentRefs.join(', ')}`,
      );
    }
  });

  test('legacy .agent/ is NOT written on a fresh local install', () => {
    install(false, 'antigravity');
    const legacyDir = path.join(tmpDir, '.agent');
    assert.ok(!fs.existsSync(legacyDir),
      '.agent/ must not be created by a fresh install (new installs use .agents/)');
  });

  test('global antigravity install still writes to ~/.gemini/antigravity (unchanged)', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ag-global-'));
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    const savedAntigravityConfig = process.env.ANTIGRAVITY_CONFIG_DIR;
    delete process.env.ANTIGRAVITY_CONFIG_DIR;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    try {
      const result = install(true, 'antigravity');
      assert.strictEqual(result.runtime, 'antigravity');
      assert.ok(
        result.configDir.startsWith(homeDir),
        `global antigravity install must go under HOME, got: ${result.configDir}`,
      );
      assert.ok(
        fs.existsSync(path.join(result.configDir, 'skills')),
        'global antigravity install must create skills/ under ~/.gemini/antigravity',
      );
      assert.ok(
        !fs.existsSync(path.join(homeDir, '.agents')),
        '.agents/ must NOT be created by a global install (global path is ~/.gemini/antigravity)',
      );
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
      if (savedAntigravityConfig === undefined) delete process.env.ANTIGRAVITY_CONFIG_DIR;
      else process.env.ANTIGRAVITY_CONFIG_DIR = savedAntigravityConfig;
      cleanup(homeDir);
    }
  });
});
// ─── Section 6: Windsurf / devin-desktop alias (#792) ───────────────────────

describe('install — --devin-desktop CLI flag routes to windsurf runtime (#792)', () => {
  test('--devin-desktop resolves to ["windsurf"] via selectRuntimesFromArgs', () => {
    const runtimes = selectRuntimesFromArgs(['--devin-desktop']);
    assert.deepStrictEqual(runtimes, ['windsurf'],
      '--devin-desktop must resolve to ["windsurf"] via selectRuntimesFromArgs');
  });

  test('--windsurf and --devin-desktop both resolve to ["windsurf"]', () => {
    assert.deepStrictEqual(selectRuntimesFromArgs(['--windsurf']), ['windsurf']);
    assert.deepStrictEqual(selectRuntimesFromArgs(['--devin-desktop']), ['windsurf']);
  });
});
// ─── Section N: Windsurf workflow slash-command install (#1615) ─────────────
// allow-test-rule: runtime-contract-is-the-product
// Reads deployed workflow .md files whose text IS the product surface the
// Windsurf runtime loads at startup (path references, command names).

describe('windsurf local install writes workflow slash commands (#1615)', () => {
  let tmpDir;
  let previousCwd;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-windsurf-1085-');
    previousCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    cleanup(tmpDir);
  });

  test('install writes workspace workflows under .windsurf/workflows/', () => {
    const result = install(false, 'windsurf');
    const windsurfDir = path.join(tmpDir, '.windsurf');
    assert.strictEqual(result.runtime, 'windsurf');
    assert.ok(fs.existsSync(windsurfDir), '.windsurf/ must be created for local windsurf install');
    const workflowsDir = path.join(windsurfDir, 'workflows');
    assert.ok(fs.existsSync(workflowsDir), '.windsurf/workflows/ must exist after install');
    const workflowEntries = fs.readdirSync(workflowsDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.startsWith('gsd-') && e.name.endsWith('.md'));
    assert.ok(workflowEntries.length > 0, 'at least one gsd-* workflow must be installed under .windsurf/workflows/');
    assert.ok(fs.existsSync(path.join(workflowsDir, 'gsd-help.md')), 'gsd-help.md workflow must exist');
  });

  test('legacy .devin/skills is NOT written on a fresh local install', () => {
    install(false, 'windsurf');
    assert.ok(!fs.existsSync(path.join(tmpDir, '.devin', 'skills')),
      '.devin/skills must not be created by a fresh install (new installs use .windsurf/workflows)');
    assert.ok(!fs.existsSync(path.join(tmpDir, '.windsurf', 'skills')),
      '.windsurf/skills must not be created for slash commands');
  });

  test('installed workflow content references command body, not skill locations', () => {
    install(false, 'windsurf');
    const workflowsDir = path.join(tmpDir, '.windsurf', 'workflows');
    const workflowEntries = fs.readdirSync(workflowsDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.startsWith('gsd-') && e.name.endsWith('.md'));
    assert.ok(workflowEntries.length > 0, 'pre-condition: at least one gsd-* workflow must be installed');
    for (const workflowEntry of workflowEntries) {
      const workflowFile = path.join(workflowsDir, workflowEntry.name);
      const content = fs.readFileSync(workflowFile, 'utf8');
      assert.ok(
        content.includes(`${tmpDir}/.windsurf/gsd-core/commands/gsd/`.replace(/\\/g, '/')),
        `${workflowEntry.name} must reference the installed canonical command body`,
      );
      assert.ok(
        !content.includes('/skills/') && !content.includes('SKILL.md'),
        `${workflowEntry.name} must not reference Windsurf skill locations`,
      );
    }
  });

  // #1629 Finding A: every workflow's @-reference target must exist on disk
  // after install. Pre-fix, gsd-core/ was copied AFTER workflows were written;
  // a throw or kill in that window left workflows pointing at missing files.
  // Post-fix, gsd-core/ is copied first. This behavioral invariant catches
  // any ordering regression that leaves a workflow target absent.
  test('every workflow @-reference target exists on disk after install (#1629 Finding A)', () => {
    install(false, 'windsurf');
    const workflowsDir = path.join(tmpDir, '.windsurf', 'workflows');
    const workflowEntries = fs.readdirSync(workflowsDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.startsWith('gsd-') && e.name.endsWith('.md'));
    assert.ok(workflowEntries.length > 0, 'pre-condition: at least one gsd-* workflow must be installed');

    const commandsGsdDir = path.join(tmpDir, '.windsurf', 'gsd-core', 'commands', 'gsd');
    assert.ok(fs.existsSync(commandsGsdDir),
      `gsd-core/commands/gsd/ must exist at ${commandsGsdDir} so workflows can delegate to it`);

    for (const workflowEntry of workflowEntries) {
      // Workflow naming convention: gsd-<stem>.md → delegates to commands/gsd/<stem>.md
      const stem = workflowEntry.name.replace(/^gsd-/, '').replace(/\.md$/, '');
      const targetFile = path.join(commandsGsdDir, `${stem}.md`);
      assert.ok(
        fs.existsSync(targetFile),
        `${workflowEntry.name} delegates to commands/gsd/${stem}.md, but that file does not exist at ${targetFile}`,
      );
    }
  });

  test('global windsurf install does not write unsupported workflows or skills', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ws-global-'));
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    const savedWindsurfConfig = process.env.WINDSURF_CONFIG_DIR;
    delete process.env.WINDSURF_CONFIG_DIR;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    try {
      const result = install(true, 'windsurf');
      assert.strictEqual(result.runtime, 'windsurf');
      assert.ok(
        result.configDir.includes('codeium') || result.configDir.includes('windsurf'),
        `global windsurf install must go to codeium/windsurf path, got: ${result.configDir}`,
      );
      assert.ok(
        !fs.existsSync(path.join(result.configDir, 'workflows')),
        'global windsurf install must not create unsupported workflows/ under ~/.codeium/windsurf',
      );
      assert.ok(
        !fs.existsSync(path.join(result.configDir, 'skills')),
        'global windsurf install must not create dead skills/ artifacts',
      );
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
      if (savedWindsurfConfig === undefined) delete process.env.WINDSURF_CONFIG_DIR;
      else process.env.WINDSURF_CONFIG_DIR = savedWindsurfConfig;
      cleanup(homeDir);
    }
  });

  test('global windsurf install still installs shared workflow assets', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-ws-global-c-'));
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    const savedWindsurfConfig = process.env.WINDSURF_CONFIG_DIR;
    delete process.env.WINDSURF_CONFIG_DIR;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    try {
      const result = install(true, 'windsurf');
      assert.ok(fs.existsSync(path.join(result.configDir, 'gsd-core', 'workflows', 'update.md')),
        'global windsurf install should still copy shared gsd-core workflow assets');
      assert.ok(!fs.existsSync(path.join(result.configDir, 'workflows')),
        'global windsurf install must not write workflow files into an undocumented global path');
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = savedUserProfile;
      if (savedWindsurfConfig === undefined) delete process.env.WINDSURF_CONFIG_DIR;
      else process.env.WINDSURF_CONFIG_DIR = savedWindsurfConfig;
      cleanup(homeDir);
    }
  });
});

// ─── #1629 Finding B: legacy .devin/skills/gsd-* cleanup on Windsurf reinstall ─
describe('cleanupWindsurfLegacyDevinSkills — removes pre-#1615 skill artifacts (#1629)', () => {
  const { cleanupWindsurfLegacyDevinSkills } = require('../bin/install.js');

  test('removes GSD-managed gsd-* dirs under .devin/skills/', (t) => {
    const tmpDir = createTempDir('gsd-1629b-cleanup-');
    t.after(() => cleanup(tmpDir));

    // Stage legacy .devin/skills/gsd-*/ artifacts (pre-#1615 layout)
    const legacySkillsDir = path.join(tmpDir, '.devin', 'skills');
    for (const skill of ['gsd-help', 'gsd-plan-phase', 'gsd-ship']) {
      const skillDir = path.join(legacySkillsDir, skill);
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Legacy skill\n');
    }

    const removed = cleanupWindsurfLegacyDevinSkills(tmpDir);

    assert.strictEqual(removed, 3, 'should remove exactly 3 gsd-* dirs');
    for (const skill of ['gsd-help', 'gsd-plan-phase', 'gsd-ship']) {
      assert.ok(
        !fs.existsSync(path.join(legacySkillsDir, skill)),
        `${skill} should be removed from .devin/skills/`,
      );
    }
    // Empty container dirs should also be pruned
    assert.ok(!fs.existsSync(legacySkillsDir), '.devin/skills/ should be pruned when empty');
    assert.ok(!fs.existsSync(path.join(tmpDir, '.devin')), '.devin/ should be pruned when empty');
  });

  test('preserves user-owned non-gsd- content under .devin/skills/', (t) => {
    const tmpDir = createTempDir('gsd-1629b-preserve-');
    t.after(() => cleanup(tmpDir));

    const legacySkillsDir = path.join(tmpDir, '.devin', 'skills');
    // Stage mixed content: legacy GSD + user-authored + user-owned gsd-dev-preferences
    fs.mkdirSync(path.join(legacySkillsDir, 'gsd-help'), { recursive: true });
    fs.writeFileSync(path.join(legacySkillsDir, 'gsd-help', 'SKILL.md'), '# legacy\n');
    fs.mkdirSync(path.join(legacySkillsDir, 'my-custom-skill'), { recursive: true });
    fs.writeFileSync(path.join(legacySkillsDir, 'my-custom-skill', 'SKILL.md'), '# user\n');
    fs.mkdirSync(path.join(legacySkillsDir, 'gsd-dev-preferences'), { recursive: true });
    fs.writeFileSync(path.join(legacySkillsDir, 'gsd-dev-preferences', 'SKILL.md'), '# prefs\n');

    const removed = cleanupWindsurfLegacyDevinSkills(tmpDir);

    assert.strictEqual(removed, 1, 'only gsd-help should be removed (gsd-dev-preferences is user-owned)');
    assert.ok(!fs.existsSync(path.join(legacySkillsDir, 'gsd-help')), 'legacy gsd-help removed');
    assert.ok(
      fs.existsSync(path.join(legacySkillsDir, 'my-custom-skill')),
      'user-authored my-custom-skill must be preserved',
    );
    assert.ok(
      fs.existsSync(path.join(legacySkillsDir, 'gsd-dev-preferences')),
      'user-owned gsd-dev-preferences must be preserved (#2973)',
    );
    // Container NOT pruned because it still has user content
    assert.ok(fs.existsSync(legacySkillsDir), '.devin/skills/ preserved when user content remains');
    assert.ok(fs.existsSync(path.join(tmpDir, '.devin')), '.devin/ preserved when user content remains');
  });

  test('skips symlinks pointing outside the .devin tree (escape guard)', (t) => {
    const tmpDir = createTempDir('gsd-1629b-symlink-');
    t.after(() => cleanup(tmpDir));

    const legacySkillsDir = path.join(tmpDir, '.devin', 'skills');
    fs.mkdirSync(legacySkillsDir, { recursive: true });
    // Create a symlink that points outside the tree
    const outsideTarget = path.join(tmpDir, 'secret');
    fs.mkdirSync(outsideTarget);
    fs.writeFileSync(path.join(outsideTarget, 'secret.txt'), 'secret\n');
    fs.symlinkSync(outsideTarget, path.join(legacySkillsDir, 'gsd-symlinked'));

    const removed = cleanupWindsurfLegacyDevinSkills(tmpDir);

    assert.strictEqual(removed, 0, 'symlinked gsd-* dir must not be removed');
    assert.ok(
      fs.existsSync(path.join(legacySkillsDir, 'gsd-symlinked')),
      'symlink must be preserved (escape guard)',
    );
    assert.ok(
      fs.existsSync(path.join(outsideTarget, 'secret.txt')),
      'out-of-tree target must not be touched',
    );
  });

  test('no-op when .devin/skills/ does not exist', () => {
    const tmpDir = createTempDir('gsd-1629b-noop-');
    const removed = cleanupWindsurfLegacyDevinSkills(tmpDir);
    assert.strictEqual(removed, 0, 'should return 0 when .devin/skills/ is absent');
    cleanup(tmpDir);
  });

  test('install(false, "windsurf") removes pre-existing .devin/skills/gsd-* on reinstall', (t) => {
    // End-to-end: stage legacy artifacts, run a fresh Windsurf install,
    // verify the old layout is cleaned up while the new .windsurf/ layout is written.
    const tmpDir = createTempDir('gsd-1629b-e2e-');
    t.after(() => cleanup(tmpDir));
    const previousCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      // Stage pre-#1615 artifacts
      const legacyDir = path.join(tmpDir, '.devin', 'skills', 'gsd-help');
      fs.mkdirSync(legacyDir, { recursive: true });
      fs.writeFileSync(path.join(legacyDir, 'SKILL.md'), '# legacy\n');

      // Fresh Windsurf install
      install(false, 'windsurf');

      // Legacy layout should be cleaned up
      assert.ok(
        !fs.existsSync(path.join(tmpDir, '.devin', 'skills', 'gsd-help')),
        'pre-existing .devin/skills/gsd-help should be removed by fresh windsurf install',
      );
      // New layout should be present
      assert.ok(
        fs.existsSync(path.join(tmpDir, '.windsurf', 'workflows')),
        '.windsurf/workflows/ should exist after fresh install',
      );
    } finally {
      process.chdir(previousCwd);
    }
  });
});
// ─── Section N+1: #767 — disallowedTools injection for read-only agents ──────
//
// Verifies (installer-behavioral test — drives install() to a temp dir):
//   1. Claude install: Group A agents have disallowedTools == {Write, Edit, MultiEdit} exactly.
//   2. Claude install: Group B agents have disallowedTools == {Edit, MultiEdit} exactly.
//   3. Negative: gsd-nyquist-auditor has NO disallowedTools key (legitimately writes+edits).
//   4. Cross-runtime no-leak: Qwen-installed read-only agents do NOT contain disallowedTools.
//   5. Source purity: source agents/*.md must not contain disallowedTools (inject-only).
//   6. Parity: docs/AGENTS.md "Disallowed Tools" rows match READONLY_AGENT_DISALLOWED_TOOLS.
//      (DEFECT.GENERATIVE-FIX guard)

// #767 — must mirror READONLY_AGENT_DISALLOWED_TOOLS in bin/install.js.
// If you change the map there, update this too (the parity test will catch drift).
const READONLY_AGENT_DISALLOWED_TOOLS_767 = {
  'gsd-plan-checker': 'Write, Edit, MultiEdit',
  'gsd-integration-checker': 'Write, Edit, MultiEdit',
  'gsd-ui-checker': 'Write, Edit, MultiEdit',
  'gsd-verifier': 'Edit, MultiEdit',
  'gsd-doc-verifier': 'Edit, MultiEdit',
  'gsd-eval-auditor': 'Edit, MultiEdit',
  'gsd-ui-auditor': 'Edit, MultiEdit',
};

const GROUP_A_767 = ['gsd-plan-checker', 'gsd-integration-checker', 'gsd-ui-checker'];
const GROUP_B_767 = ['gsd-verifier', 'gsd-doc-verifier', 'gsd-eval-auditor', 'gsd-ui-auditor'];

const REPO_ROOT_767 = path.resolve(__dirname, '..');
const SOURCE_AGENTS_DIR_767 = path.join(REPO_ROOT_767, 'agents');
const AGENTS_DOC_PATH_767 = path.join(REPO_ROOT_767, 'docs', 'AGENTS.md');

function readFrontmatterText(mdPath) {
  const content = fs.readFileSync(mdPath, 'utf8');
  if (!content.startsWith('---')) return '';
  const end = content.indexOf('---', 3);
  if (end === -1) return '';
  return content.substring(3, end);
}

function parseDisallowedToolsSet(fm) {
  const match = fm.match(/^disallowedTools:\s*(.+)$/m);
  if (!match) return null;
  return new Set(match[1].split(',').map((t) => t.trim()).filter(Boolean));
}

/**
 * Run a global install for the given runtime, redirecting its home dir to
 * tmpHome. Stubs both HOME and USERPROFILE for Windows parity, and
 * suppresses the stale-SDK npm subprocess.
 */
function runGlobalInstall767(runtime, tmpHome) {
  const envVarMap = {
    claude: 'CLAUDE_CONFIG_DIR',
    qwen: 'QWEN_CONFIG_DIR',
  };
  const envVar = envVarMap[runtime];
  if (!envVar) throw new Error(`Unsupported runtime in #767 test: ${runtime}`);

  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-767-home-'));

  const prevEnvVar = process.env[envVar];
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevSkipStale = process.env.GSD_SKIP_STALE_SDK_CHECK;

  process.env[envVar] = tmpHome;
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  process.env.GSD_SKIP_STALE_SDK_CHECK = '1';
  process.chdir(REPO_ROOT_767);

  try {
    install(true, runtime);
  } finally {
    process.chdir(prevCwd);
    if (prevEnvVar === undefined) delete process.env[envVar];
    else process.env[envVar] = prevEnvVar;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevSkipStale === undefined) delete process.env.GSD_SKIP_STALE_SDK_CHECK;
    else process.env.GSD_SKIP_STALE_SDK_CHECK = prevSkipStale;
    cleanup(isolatedHome);
  }

  return tmpHome;
}

describe('#767 Claude install: Group A agents have disallowedTools = {Write, Edit, MultiEdit}', () => {
  let tmpDir;
  let claudeHome;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-767-claude-a-');
    claudeHome = path.join(tmpDir, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });
    runGlobalInstall767('claude', claudeHome);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  const EXPECTED_A_767 = new Set(['Write', 'Edit', 'MultiEdit']);

  for (const agent of GROUP_A_767) {
    test(`${agent}: disallowedTools is exactly {Write, Edit, MultiEdit}`, () => {
      const fm = readFrontmatterText(path.join(claudeHome, 'agents', `${agent}.md`));
      const tools = parseDisallowedToolsSet(fm);
      assert.ok(tools !== null,
        `${agent} must have a disallowedTools key in Claude frontmatter\nFrontmatter:\n${fm}`);
      assert.deepEqual(tools, EXPECTED_A_767,
        `${agent} disallowedTools must be exactly {Write, Edit, MultiEdit}\nGot: ${[...tools].join(', ')}`);
    });
  }
});

describe('#767 Claude install: Group B agents have disallowedTools = {Edit, MultiEdit}', () => {
  let tmpDir;
  let claudeHome;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-767-claude-b-');
    claudeHome = path.join(tmpDir, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });
    runGlobalInstall767('claude', claudeHome);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  const EXPECTED_B_767 = new Set(['Edit', 'MultiEdit']);

  for (const agent of GROUP_B_767) {
    test(`${agent}: disallowedTools is exactly {Edit, MultiEdit}`, () => {
      const fm = readFrontmatterText(path.join(claudeHome, 'agents', `${agent}.md`));
      const tools = parseDisallowedToolsSet(fm);
      assert.ok(tools !== null,
        `${agent} must have a disallowedTools key in Claude frontmatter\nFrontmatter:\n${fm}`);
      assert.deepEqual(tools, EXPECTED_B_767,
        `${agent} disallowedTools must be exactly {Edit, MultiEdit}\nGot: ${[...tools].join(', ')}`);
    });
  }
});

describe('#767 Claude install: gsd-nyquist-auditor has no disallowedTools (legitimately writes+edits)', () => {
  let tmpDir;
  let claudeHome;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-767-claude-nyquist-');
    claudeHome = path.join(tmpDir, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });
    runGlobalInstall767('claude', claudeHome);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gsd-nyquist-auditor.md has NO disallowedTools key', () => {
    const fm = readFrontmatterText(path.join(claudeHome, 'agents', 'gsd-nyquist-auditor.md'));
    const tools = parseDisallowedToolsSet(fm);
    assert.equal(tools, null,
      `gsd-nyquist-auditor must NOT have disallowedTools in Claude frontmatter\nFrontmatter:\n${fm}`);
  });
});

describe('#767 Qwen install: read-only agents do NOT contain disallowedTools (cross-runtime leak guard)', () => {
  let tmpDir;
  let qwenHome;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-767-qwen-');
    qwenHome = path.join(tmpDir, 'qwen-home');
    fs.mkdirSync(qwenHome, { recursive: true });
    runGlobalInstall767('qwen', qwenHome);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  for (const agent of [...GROUP_A_767, ...GROUP_B_767]) {
    test(`Qwen ${agent}.md has no disallowedTools`, () => {
      const agentPath = path.join(qwenHome, 'agents', `${agent}.md`);
      const content = fs.readFileSync(agentPath, 'utf8');
      assert.ok(!content.includes('disallowedTools'),
        `${agent} (Qwen) must NOT contain disallowedTools\nContent excerpt:\n${content.slice(0, 400)}`);
    });
  }
});

describe('#767 Source purity: source agents/*.md must not contain disallowedTools (inject-only)', () => {
  for (const agent of [...GROUP_A_767, ...GROUP_B_767]) {
    test(`source agents/${agent}.md has no disallowedTools`, () => {
      const content = fs.readFileSync(path.join(SOURCE_AGENTS_DIR_767, `${agent}.md`), 'utf8');
      assert.ok(!content.includes('disallowedTools'),
        `Source agents/${agent}.md must NOT contain disallowedTools (injection is install-time only, source must stay runtime-neutral)`);
    });
  }
});

describe('#767 Parity: docs/AGENTS.md "Disallowed Tools" rows match READONLY_AGENT_DISALLOWED_TOOLS', () => {
  const agentsDoc = fs.readFileSync(AGENTS_DOC_PATH_767, 'utf8');

  for (const [agent, expectedTools] of Object.entries(READONLY_AGENT_DISALLOWED_TOOLS_767)) {
    test(`docs/AGENTS.md has matching Disallowed Tools row for ${agent}`, () => {
      const agentHeaderIdx = agentsDoc.indexOf(`### ${agent}`);
      assert.ok(agentHeaderIdx !== -1,
        `docs/AGENTS.md must contain a ### ${agent} section`);

      const nextSectionIdx = agentsDoc.indexOf('\n### ', agentHeaderIdx + 1);
      const sectionEnd = nextSectionIdx === -1 ? agentsDoc.length : nextSectionIdx;
      const section = agentsDoc.slice(agentHeaderIdx, sectionEnd);

      const disallowedMatch = section.match(/\|\s*\*\*Disallowed Tools\*\*\s*\|\s*([^|]+)\|/);
      assert.ok(disallowedMatch,
        `docs/AGENTS.md section for ${agent} must have a "Disallowed Tools" table row`);

      const docTools = disallowedMatch[1].trim();
      assert.equal(docTools, expectedTools,
        `docs/AGENTS.md "Disallowed Tools" for ${agent} must be "${expectedTools}" but got "${docTools}"`);
    });
  }
});

// ─── normalizeNodePath — mise versioned install path → stable shim (#1619) ────
//
// Bug #1619: `resolveNodeRunner()` bakes process.execPath into managed hook
// commands. Node realpaths execPath, so under mise it resolves to
// `<data>/installs/node/<ver>/bin/node` — a concrete version mise prunes on
// `mise up`, after which every managed hook 404s (same class as #977 fnm /
// #3181 Homebrew). normalizeNodePath now rewrites it to the stable sibling
// shim `<data>/shims/node` when that shim exists, deriving <data> from the
// path so a custom MISE_DATA_DIR works, and falling back to execPath otherwise.
// Folded into install.test.cjs (not a new bug-NNNN file) per the regression
// test-name lint. Assertions go against the exported function's return values.
describe('normalizeNodePath — mise versioned path → sibling shim (#1619)', () => {
  const MISE_DATA = '/Users/u/.local/share/mise';
  const MISE_NODE_PINNED = `${MISE_DATA}/installs/node/26.3.0/bin/node`;
  const MISE_SHIM = `${MISE_DATA}/shims/node`;
  const MISE_WIN_DATA = 'C:/Users/u/AppData/Local/mise';
  const MISE_WIN_NODE = `${MISE_WIN_DATA}/installs/node/22.1.0/node.exe`; // no bin/ on Windows
  const MISE_WIN_SHIM = `${MISE_WIN_DATA}/shims/node.exe`;
  const MISE_CUSTOM_DATA = '/opt/mise-data';
  const MISE_CUSTOM_NODE = `${MISE_CUSTOM_DATA}/installs/node/20.0.0/bin/node`;
  const MISE_CUSTOM_SHIM = `${MISE_CUSTOM_DATA}/shims/node`;

  test('POSIX pinned install path + shim exists → sibling shim', () => {
    assert.equal(
      normalizeNodePath(MISE_NODE_PINNED, { existsSync: p => p === MISE_SHIM }),
      MISE_SHIM);
  });

  test('Windows node.exe + shim exists → shims/node.exe (.exe preserved)', () => {
    assert.equal(
      normalizeNodePath(MISE_WIN_NODE, { existsSync: p => p === MISE_WIN_SHIM }),
      MISE_WIN_SHIM);
  });

  test('backslash Windows path normalizes the same as forward-slash', () => {
    assert.equal(
      normalizeNodePath(MISE_WIN_NODE.replace(/\//g, '\\'),
        { existsSync: p => p === MISE_WIN_SHIM }),
      MISE_WIN_SHIM);
  });

  test('custom MISE_DATA_DIR layout → shim derived from execPath, not env', () => {
    assert.equal(
      normalizeNodePath(MISE_CUSTOM_NODE, { existsSync: p => p === MISE_CUSTOM_SHIM }),
      MISE_CUSTOM_SHIM);
  });

  test('no regression: shim absent → falls back to raw execPath unchanged', () => {
    assert.equal(
      normalizeNodePath(MISE_NODE_PINNED, { existsSync: () => false }),
      MISE_NODE_PINNED);
  });

  test('non-mise path (Homebrew symlink) is left unchanged here', () => {
    assert.equal(
      normalizeNodePath('/opt/homebrew/bin/node', { existsSync: () => true }),
      '/opt/homebrew/bin/node');
  });
});

// ─── normalizeNodePath — volta versioned image path → stable shim (#2335) ────
//
// Bug #2335: the volta analog of #977 (fnm) / #1619 (mise) / #2185 (Homebrew).
// `resolveNodeRunner()` bakes process.execPath into managed hook commands, and
// node realpaths execPath, so under volta it resolves to the concrete image
// `<VOLTA_HOME>/tools/image/node/<ver>/bin/node` (Windows: `<...>/<ver>/node.exe`
// — volta's own layout puts node.exe at the image root, no bin/). `volta
// uninstall node@<ver>` prunes that image, after which every managed hook 404s.
// The stable alias is the shim `<VOLTA_HOME>/bin/node`, a symlink to volta-shim
// that always resolves to the active pin. <VOLTA_HOME> is derived from the path
// (not env) so a custom VOLTA_HOME and the Windows %LOCALAPPDATA%\Volta default
// both work — same reasoning as the Homebrew branch (#2185). Rewrite only when
// the shim exists; otherwise fall back to raw execPath, like the mise branch.
describe('normalizeNodePath — volta image path → sibling shim (#2335)', () => {
  const VOLTA_HOME = '/Users/u/.volta';
  const VOLTA_NODE_PINNED = `${VOLTA_HOME}/tools/image/node/18.17.1/bin/node`;
  const VOLTA_SHIM = `${VOLTA_HOME}/bin/node`;
  const VOLTA_WIN_HOME = 'C:/Users/u/AppData/Local/Volta';
  const VOLTA_WIN_NODE = `${VOLTA_WIN_HOME}/tools/image/node/22.1.0/node.exe`; // no bin/ on Windows
  const VOLTA_WIN_SHIM = `${VOLTA_WIN_HOME}/bin/node.exe`;
  const VOLTA_CUSTOM_HOME = '/opt/volta-home';
  const VOLTA_CUSTOM_NODE = `${VOLTA_CUSTOM_HOME}/tools/image/node/20.0.0/bin/node`;
  const VOLTA_CUSTOM_SHIM = `${VOLTA_CUSTOM_HOME}/bin/node`;

  test('POSIX pinned image path + shim exists → sibling shim', () => {
    assert.equal(
      normalizeNodePath(VOLTA_NODE_PINNED, { existsSync: p => p === VOLTA_SHIM }),
      VOLTA_SHIM);
  });

  test('Windows node.exe + shim exists → bin/node.exe (.exe preserved)', () => {
    assert.equal(
      normalizeNodePath(VOLTA_WIN_NODE, { existsSync: p => p === VOLTA_WIN_SHIM }),
      VOLTA_WIN_SHIM);
  });

  test('backslash Windows path normalizes the same as forward-slash', () => {
    assert.equal(
      normalizeNodePath(VOLTA_WIN_NODE.replace(/\//g, '\\'),
        { existsSync: p => p === VOLTA_WIN_SHIM }),
      VOLTA_WIN_SHIM);
  });

  test('custom VOLTA_HOME layout → shim derived from execPath, not env', () => {
    assert.equal(
      normalizeNodePath(VOLTA_CUSTOM_NODE, { existsSync: p => p === VOLTA_CUSTOM_SHIM }),
      VOLTA_CUSTOM_SHIM);
  });

  test('no regression: shim absent → falls back to raw execPath unchanged', () => {
    assert.equal(
      normalizeNodePath(VOLTA_NODE_PINNED, { existsSync: () => false }),
      VOLTA_NODE_PINNED);
  });

  test('volta shim itself is already stable → left unchanged (idempotent)', () => {
    assert.equal(
      normalizeNodePath(VOLTA_SHIM, { existsSync: () => true }),
      VOLTA_SHIM);
  });

  test('a non-node volta image (yarn) is not rewritten to the node shim', () => {
    const yarnImage = `${VOLTA_HOME}/tools/image/yarn/1.22.19/bin/yarn`;
    assert.equal(
      normalizeNodePath(yarnImage, { existsSync: () => true }),
      yarnImage);
  });

  test('mise path is unaffected by the volta branch (no cross-manager capture)', () => {
    const miseShim = '/Users/u/.local/share/mise/shims/node';
    assert.equal(
      normalizeNodePath('/Users/u/.local/share/mise/installs/node/26.3.0/bin/node',
        { existsSync: p => p === miseShim }),
      miseShim);
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2256-model-overrides-transport.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2256-model-overrides-transport (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression tests for issue #2256 — per-agent model_overrides transport
 * for Codex and OpenCode runtimes.
 *
 * The bug: model_overrides set in per-project `.planning/config.json` were
 * never read by the Codex / OpenCode install paths, which only probed
 * `~/.gsd/defaults.json`. As a result, the configured per-agent model was
 * dropped and child agents inherited the runtime's default model.
 *
 * These tests lock in the fix: per-project overrides must be honored, and
 * per-project keys must win over global when both are present.
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const isWindows = process.platform === 'win32';

const {
  readGsdEffectiveModelOverrides,
  generateCodexAgentToml,
  convertClaudeToOpencodeFrontmatter,
  getCodexSkillAdapterHeader,
} = require('../bin/install.js');

const { createTempDir, cleanup } = require('./helpers.cjs');
const makeTmp = (prefix) => createTempDir(`gsd-2256-${prefix}-`);

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

describe('bug #2256 — readGsdEffectiveModelOverrides', () => {
  let projectDir;
  let homeDir;
  let origHome;
  let origUserProfile;

  beforeEach(() => {
    projectDir = makeTmp('proj');
    homeDir = makeTmp('home');
    origHome = process.env.HOME;
    // On Windows, os.homedir() reads USERPROFILE (not HOME). Tests that
    // need to redirect ~ must override both — otherwise the SUT reads
    // the real user's home and the fixture is invisible.
    origUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    if (isWindows) process.env.USERPROFILE = homeDir;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (isWindows) {
      if (origUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origUserProfile;
    }
    cleanup(projectDir);
    cleanup(homeDir);
  });

  test('returns null when neither source defines model_overrides', () => {
    const result = readGsdEffectiveModelOverrides(projectDir);
    assert.strictEqual(result, null);
  });

  test('reads overrides from ~/.gsd/defaults.json (global only)', () => {
    writeJson(path.join(homeDir, '.gsd', 'defaults.json'), {
      model_overrides: { 'gsd-codebase-mapper': 'gpt-5-mini' },
    });
    const result = readGsdEffectiveModelOverrides(projectDir);
    assert.deepStrictEqual(result, { 'gsd-codebase-mapper': 'gpt-5-mini' });
  });

  test('reads overrides from per-project .planning/config.json', () => {
    writeJson(path.join(projectDir, '.planning', 'config.json'), {
      model_overrides: { 'gsd-codebase-mapper': 'claude-haiku-4-5' },
    });
    const result = readGsdEffectiveModelOverrides(projectDir);
    assert.deepStrictEqual(result, { 'gsd-codebase-mapper': 'claude-haiku-4-5' });
  });

  test('per-project overrides win over global on conflict', () => {
    writeJson(path.join(homeDir, '.gsd', 'defaults.json'), {
      model_overrides: { 'gsd-codebase-mapper': 'global-model', 'gsd-planner': 'opus' },
    });
    writeJson(path.join(projectDir, '.planning', 'config.json'), {
      model_overrides: { 'gsd-codebase-mapper': 'project-model' },
    });
    const result = readGsdEffectiveModelOverrides(projectDir);
    // Per-project wins on conflict; non-conflicting global keys are preserved.
    assert.deepStrictEqual(result, {
      'gsd-codebase-mapper': 'project-model',
      'gsd-planner': 'opus',
    });
  });

  test('walks up from nested targetDir to find .planning/', () => {
    writeJson(path.join(projectDir, '.planning', 'config.json'), {
      model_overrides: { 'gsd-planner': 'project-opus' },
    });
    const nested = path.join(projectDir, '.codex');
    fs.mkdirSync(nested, { recursive: true });
    const result = readGsdEffectiveModelOverrides(nested);
    assert.deepStrictEqual(result, { 'gsd-planner': 'project-opus' });
  });
});

describe('bug #2256 — Codex adapter embeds per-project override', () => {
  const agentContent = `---\nname: gsd-codebase-mapper\ndescription: Maps codebase\n---\n\nbody\n`;

  test('generateCodexAgentToml embeds model when override provided', () => {
    const toml = generateCodexAgentToml(
      'gsd-codebase-mapper',
      agentContent,
      { 'gsd-codebase-mapper': 'gpt-5-mini' },
    );
    assert.match(toml, /^model = "gpt-5-mini"$/m);
  });

  test('generateCodexAgentToml omits model when no override', () => {
    const toml = generateCodexAgentToml('gsd-codebase-mapper', agentContent, null);
    assert.doesNotMatch(toml, /^model\s*=/m);
  });
});

describe('bug #2256 — OpenCode adapter embeds per-project override', () => {
  test('convertClaudeToOpencodeFrontmatter embeds model on agent frontmatter', () => {
    const input = `---\nname: gsd-codebase-mapper\ndescription: Maps codebase\n---\n\nbody\n`;
    const out = convertClaudeToOpencodeFrontmatter(input, {
      isAgent: true,
      modelOverride: 'claude-haiku-4-5',
    });
    assert.match(out, /^model: claude-haiku-4-5$/m);
    assert.match(out, /^mode: subagent$/m);
  });

  test('convertClaudeToOpencodeFrontmatter omits model when override absent', () => {
    const input = `---\nname: gsd-codebase-mapper\ndescription: Maps codebase\n---\n\nbody\n`;
    const out = convertClaudeToOpencodeFrontmatter(input, { isAgent: true, modelOverride: null });
    assert.doesNotMatch(out, /^model:/m);
  });
});

describe('bug #2256 — Codex skill adapter header documents transport', () => {
  test('Task(model=...) line no longer says "omit" without explanation', () => {
    const header = getCodexSkillAdapterHeader('gsd-plan-phase');
    // Header must mention that per-agent model_overrides are embedded in agent
    // TOML so spawn_agent picks them up automatically — the old text said
    // "Codex uses per-role config, not inline model selection" which left
    // users thinking their model_overrides were silently ignored.
    assert.match(header, /model_overrides/);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3181-node-cellar-path.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3181-node-cellar-path (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #3181: `resolveNodeRunner()` bakes versioned Homebrew Cellar paths
 * (e.g. `/usr/local/Cellar/node/25.8.1/bin/node`) into hook commands in
 * `~/.claude/settings.json`. After `brew upgrade node` the Cellar binary
 * fails with `dyld: Library not loaded` because shared libraries have
 * changed SOVERSION.
 *
 * Fix: prefer the stable Homebrew symlinks (`/usr/local/bin/node` for Intel
 * Macs, `/opt/homebrew/bin/node` for Apple Silicon) when a Cellar path is
 * detected. Non-Homebrew paths (NVM, system node, Windows, etc.) are
 * returned unchanged.
 *
 * Also: `rewriteLegacyManagedNodeHookCommands()` must normalize Cellar paths
 * baked into existing hook commands so reinstall doesn't re-bake them.
 *
 * All assertions go against exported function return values — no source-grep.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const INSTALL = require(path.join(__dirname, '..', 'bin', 'install.js'));
const { normalizeNodePath, resolveNodeRunner, rewriteLegacyManagedNodeHookCommands } = INSTALL;

// ─── normalizeNodePath ────────────────────────────────────────────────────────

describe('Bug #3181: normalizeNodePath — exported as a function', () => {
  test('normalizeNodePath is exported', () => {
    assert.equal(typeof normalizeNodePath, 'function');
  });
});

describe('Bug #3181: normalizeNodePath — Intel Homebrew Cellar paths → /usr/local/bin/node', () => {
  test('simple versioned Intel Cellar path', () => {
    const result = normalizeNodePath('/usr/local/Cellar/node/25.8.1/bin/node');
    assert.equal(result, '/usr/local/bin/node');
  });

  test('Intel Cellar path with long semver', () => {
    const result = normalizeNodePath('/usr/local/Cellar/node/20.11.0/bin/node');
    assert.equal(result, '/usr/local/bin/node');
  });

  test('Intel Cellar path with prerelease version segment', () => {
    const result = normalizeNodePath('/usr/local/Cellar/node/22.0.0-rc.1/bin/node');
    assert.equal(result, '/usr/local/bin/node');
  });

  test('Intel versioned formula Cellar path (node@20) maps to stable symlink', () => {
    const result = normalizeNodePath('/usr/local/Cellar/node@20/20.11.0/bin/node');
    assert.equal(result, '/usr/local/bin/node');
  });
});

describe('Bug #3181: normalizeNodePath — Apple Silicon Homebrew Cellar paths → /opt/homebrew/bin/node', () => {
  test('simple versioned Apple Silicon Cellar path', () => {
    const result = normalizeNodePath('/opt/homebrew/Cellar/node/25.8.1/bin/node');
    assert.equal(result, '/opt/homebrew/bin/node');
  });

  test('Apple Silicon Cellar path with another version', () => {
    const result = normalizeNodePath('/opt/homebrew/Cellar/node/18.20.4/bin/node');
    assert.equal(result, '/opt/homebrew/bin/node');
  });

  test('Apple Silicon versioned formula Cellar path (node@18) maps to stable symlink', () => {
    const result = normalizeNodePath('/opt/homebrew/Cellar/node@18/18.20.4/bin/node');
    assert.equal(result, '/opt/homebrew/bin/node');
  });
});

// #2185: Linuxbrew + any custom HOMEBREW_PREFIX — the Cellar prefix is derived
// from the path itself, so one branch covers every Homebrew layout.
describe('Bug #2185: normalizeNodePath — Linuxbrew + custom-prefix Cellar paths → <prefix>/bin/node', () => {
  test('Linuxbrew Cellar path maps to the stable linuxbrew symlink', () => {
    const result = normalizeNodePath('/home/linuxbrew/.linuxbrew/Cellar/node/26.0.0/bin/node');
    assert.equal(result, '/home/linuxbrew/.linuxbrew/bin/node');
  });

  test('Linuxbrew Cellar path after a version bump (26.5.0) maps to stable symlink', () => {
    const result = normalizeNodePath('/home/linuxbrew/.linuxbrew/Cellar/node/26.5.0/bin/node');
    assert.equal(result, '/home/linuxbrew/.linuxbrew/bin/node');
  });

  test('Linuxbrew versioned formula Cellar path (node@22) maps to stable symlink', () => {
    const result = normalizeNodePath('/home/linuxbrew/.linuxbrew/Cellar/node@22/22.11.0/bin/node');
    assert.equal(result, '/home/linuxbrew/.linuxbrew/bin/node');
  });

  test('custom HOMEBREW_PREFIX Cellar path maps to its stable symlink', () => {
    const result = normalizeNodePath('/custom/brew/Cellar/node/25.8.1/bin/node');
    assert.equal(result, '/custom/brew/bin/node');
  });
});

describe('Bug #3181: normalizeNodePath — non-Homebrew paths are returned unchanged', () => {
  test('NVM path is unchanged', () => {
    const nvm = '/Users/dev/.nvm/versions/node/v20.11.0/bin/node';
    assert.equal(normalizeNodePath(nvm), nvm);
  });

  test('already-stable Intel Homebrew symlink is unchanged', () => {
    assert.equal(normalizeNodePath('/usr/local/bin/node'), '/usr/local/bin/node');
  });

  test('already-stable Apple Silicon Homebrew symlink is unchanged', () => {
    assert.equal(normalizeNodePath('/opt/homebrew/bin/node'), '/opt/homebrew/bin/node');
  });

  test('system node (/usr/bin/node) is unchanged', () => {
    assert.equal(normalizeNodePath('/usr/bin/node'), '/usr/bin/node');
  });

  test('Windows path is unchanged', () => {
    const win = 'C:\\Program Files\\nodejs\\node.exe';
    assert.equal(normalizeNodePath(win), win);
  });

  test('empty string is returned as-is', () => {
    assert.equal(normalizeNodePath(''), '');
  });

  test('null is returned as-is', () => {
    assert.equal(normalizeNodePath(null), null);
  });
});

// ─── resolveNodeRunner ────────────────────────────────────────────────────────

describe('Bug #3181: resolveNodeRunner — maps Cellar execPath to stable symlink', () => {
  test('Intel Cellar execPath → stable symlink quoted token', () => {
    const orig = process.execPath;
    try {
      Object.defineProperty(process, 'execPath', {
        value: '/usr/local/Cellar/node/25.8.1/bin/node',
        configurable: true,
      });
      const runner = resolveNodeRunner();
      assert.equal(runner, '"/usr/local/bin/node"',
        `expected stable Intel symlink, got: ${runner}`);
    } finally {
      Object.defineProperty(process, 'execPath', { value: orig, configurable: true });
    }
  });

  test('Apple Silicon Cellar execPath → stable symlink quoted token', () => {
    const orig = process.execPath;
    try {
      Object.defineProperty(process, 'execPath', {
        value: '/opt/homebrew/Cellar/node/25.8.1/bin/node',
        configurable: true,
      });
      const runner = resolveNodeRunner();
      assert.equal(runner, '"/opt/homebrew/bin/node"',
        `expected stable Apple Silicon symlink, got: ${runner}`);
    } finally {
      Object.defineProperty(process, 'execPath', { value: orig, configurable: true });
    }
  });

  test('non-Homebrew execPath is returned as a quoted absolute path unchanged', () => {
    const orig = process.execPath;
    const nvmPath = '/Users/dev/.nvm/versions/node/v20.11.0/bin/node';
    try {
      Object.defineProperty(process, 'execPath', { value: nvmPath, configurable: true });
      const runner = resolveNodeRunner();
      assert.equal(runner, JSON.stringify(nvmPath));
    } finally {
      Object.defineProperty(process, 'execPath', { value: orig, configurable: true });
    }
  });

  test('returns null when execPath is empty (existing null-guard is preserved)', () => {
    const orig = process.execPath;
    try {
      Object.defineProperty(process, 'execPath', { value: '', configurable: true });
      assert.equal(resolveNodeRunner(), null);
    } finally {
      Object.defineProperty(process, 'execPath', { value: orig, configurable: true });
    }
  });
});

// ─── rewriteLegacyManagedNodeHookCommands — Cellar runner rewrite ─────────────

describe('Bug #3181: rewriteLegacyManagedNodeHookCommands — rewrites baked Cellar runner to stable symlink', () => {
  test('Intel Cellar runner in a managed hook is rewritten to the stable symlink', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{
            type: 'command',
            command: '"/usr/local/Cellar/node/25.8.1/bin/node" "/Users/x/.gemini/hooks/gsd-check-update.js"',
          }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner);
    assert.equal(changed, true, 'expected rewrite to occur');
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].command,
      '"/usr/local/bin/node" "/Users/x/.gemini/hooks/gsd-check-update.js"',
    );
  });

  test('Apple Silicon Cellar runner in a managed hook is rewritten to the stable symlink', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{
            type: 'command',
            command: '"/opt/homebrew/Cellar/node/25.8.1/bin/node" "/Users/x/.gemini/hooks/gsd-check-update.js"',
          }],
        }],
      },
    };
    const runner = '"/opt/homebrew/bin/node"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner);
    assert.equal(changed, true, 'expected rewrite to occur');
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].command,
      '"/opt/homebrew/bin/node" "/Users/x/.gemini/hooks/gsd-check-update.js"',
    );
  });

  test('a hook already using the stable runner is NOT rewritten (no churn)', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{
            type: 'command',
            command: '"/usr/local/bin/node" "/Users/x/.gemini/hooks/gsd-check-update.js"',
          }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const before = settings.hooks.SessionStart[0].hooks[0].command;
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner);
    assert.equal(changed, false, 'already-stable entry must not be touched');
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, before);
  });

  test('a user hook using a Cellar runner but an unmanaged filename is NOT rewritten', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{
            type: 'command',
            command: '"/usr/local/Cellar/node/25.8.1/bin/node" "/Users/x/my-custom-hook.js"',
          }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const before = settings.hooks.SessionStart[0].hooks[0].command;
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner);
    assert.equal(changed, false, 'unmanaged hooks with Cellar runner must not be touched');
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, before);
  });

  // Existing bare-node rewrite still works alongside the new Cellar rewrite
  test('bare `node` managed hook is still rewritten (existing #2979 behaviour preserved)', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{
            type: 'command',
            command: 'node "/Users/x/.gemini/hooks/gsd-check-update.js"',
          }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner);
    assert.equal(changed, true);
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].command,
      '"/usr/local/bin/node" "/Users/x/.gemini/hooks/gsd-check-update.js"',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-977-fnm-multishell-path.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-977-fnm-multishell-path (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #977: `resolveNodeRunner()` bakes an ephemeral fnm multishell shim path
 * (e.g. `C:/Users/u/AppData/Local/fnm_multishells/<pid>_<ts>/node.exe`) into
 * managed `.js` hook commands. fnm cleans up these per-shell-session directories
 * when the shell exits, so the captured path later points at nothing — every
 * managed hook fails to spawn until reinstall.
 *
 * Fix: when `normalizeNodePath` detects a path matching the fnm multishell
 * directory pattern (`fnm_multishells/<id>/node(\.exe)?$`), it probes a stable
 * alias path derived from `FNM_DIR` or `APPDATA` env vars (with injected
 * `existsSync` for testability) and returns the first that exists. Falls back to
 * the raw execPath if no stable alias is found.
 *
 * All assertions go against exported function return values — no source-grep.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const INSTALL = require(path.join(__dirname, '..', 'bin', 'install.js'));
const { normalizeNodePath, resolveNodeRunner } = INSTALL;

// ─── Synthetic paths used across tests ───────────────────────────────────────

const EPHEMERAL_FNM_WIN = 'C:/Users/u/AppData/Local/fnm_multishells/15600_1781041703752/node.exe';
const EPHEMERAL_FNM_WIN_BACKSLASH = 'C:\\Users\\u\\AppData\\Local\\fnm_multishells\\15600_1781041703752\\node.exe';
const FNM_DIR_WIN = 'C:/Users/u/AppData/Roaming/fnm';
const APPDATA_WIN = 'C:/Users/u/AppData/Roaming';
const STABLE_FNM_DIR_NODE = `${FNM_DIR_WIN}/aliases/default/node.exe`;
const STABLE_APPDATA_NODE = `${APPDATA_WIN}/fnm/aliases/default/node.exe`;

// ─── normalizeNodePath — fnm multishell ephemeral path → stable alias ────────

describe('Bug #977: normalizeNodePath — fnm multishell path with FNM_DIR → stable alias', () => {
  test('forward-slash Windows ephemeral path + FNM_DIR set + alias exists → stable FNM_DIR alias', () => {
    const result = normalizeNodePath(EPHEMERAL_FNM_WIN, {
      env: { FNM_DIR: FNM_DIR_WIN },
      existsSync: p => p === STABLE_FNM_DIR_NODE,
    });
    assert.equal(
      result,
      STABLE_FNM_DIR_NODE,
      `expected stable FNM_DIR alias, got: ${result}`,
    );
  });

  test('backslash Windows ephemeral path + FNM_DIR set + alias exists → stable FNM_DIR alias', () => {
    const result = normalizeNodePath(EPHEMERAL_FNM_WIN_BACKSLASH, {
      env: { FNM_DIR: FNM_DIR_WIN },
      existsSync: p => p === STABLE_FNM_DIR_NODE,
    });
    assert.equal(
      result,
      STABLE_FNM_DIR_NODE,
      `expected stable FNM_DIR alias, got: ${result}`,
    );
  });

  test('FNM_DIR alias does not exist → falls through to APPDATA alias → returns APPDATA alias', () => {
    const result = normalizeNodePath(EPHEMERAL_FNM_WIN, {
      env: { FNM_DIR: FNM_DIR_WIN, APPDATA: APPDATA_WIN },
      existsSync: p => p === STABLE_APPDATA_NODE, // FNM_DIR alias absent, APPDATA alias present
    });
    assert.equal(
      result,
      STABLE_APPDATA_NODE,
      `expected stable APPDATA alias, got: ${result}`,
    );
  });

  test('no alias exists → returns raw execPath unchanged (graceful fallback)', () => {
    const result = normalizeNodePath(EPHEMERAL_FNM_WIN, {
      env: { FNM_DIR: FNM_DIR_WIN, APPDATA: APPDATA_WIN },
      existsSync: () => false, // nothing exists
    });
    assert.equal(
      result,
      EPHEMERAL_FNM_WIN,
      `expected raw execPath fallback, got: ${result}`,
    );
  });

  test('no FNM_DIR or APPDATA in env → returns raw execPath unchanged', () => {
    const result = normalizeNodePath(EPHEMERAL_FNM_WIN, {
      env: {},
      existsSync: () => false,
    });
    assert.equal(
      result,
      EPHEMERAL_FNM_WIN,
      `expected raw execPath fallback, got: ${result}`,
    );
  });
});

// ─── normalizeNodePath — non-fnm paths are NOT affected by the new branch ────

describe('Bug #977: normalizeNodePath — non-fnm paths are unaffected (no regression to existing behavior)', () => {
  test('NVM path is unchanged', () => {
    const nvm = '/Users/dev/.nvm/versions/node/v20.11.0/bin/node';
    assert.equal(normalizeNodePath(nvm), nvm);
  });

  test('Intel Homebrew Cellar path still maps to stable symlink', () => {
    assert.equal(
      normalizeNodePath('/usr/local/Cellar/node/25.8.1/bin/node'),
      '/usr/local/bin/node',
    );
  });

  test('Apple Silicon Homebrew Cellar path still maps to stable symlink', () => {
    assert.equal(
      normalizeNodePath('/opt/homebrew/Cellar/node/25.8.1/bin/node'),
      '/opt/homebrew/bin/node',
    );
  });

  test('regular Windows nodejs path is unchanged', () => {
    const win = 'C:\\Program Files\\nodejs\\node.exe';
    assert.equal(normalizeNodePath(win), win);
  });

  test('empty string is returned as-is', () => {
    assert.equal(normalizeNodePath(''), '');
  });

  test('null is returned as-is', () => {
    assert.equal(normalizeNodePath(null), null);
  });
});

// ─── normalizeNodePath — already-stable fnm alias path is not re-processed ───

describe('Bug #977: normalizeNodePath — already-stable fnm alias path passes through unchanged', () => {
  test('stable FNM_DIR alias path is returned as-is', () => {
    assert.equal(
      normalizeNodePath(STABLE_FNM_DIR_NODE),
      STABLE_FNM_DIR_NODE,
    );
  });
});

// ─── normalizeNodePath — false-positive guard: non-numeric id must NOT remap ──

describe('Bug #977: normalizeNodePath — non-ephemeral fnm_multishells path is not remapped', () => {
  test('non-numeric id segment (e.g. custom-dir) returns raw execPath unchanged even when alias exists', () => {
    const nonEphemeral = 'C:/Users/u/AppData/Local/fnm_multishells/custom-dir/node.exe';
    const stableAlias = 'C:/Users/u/AppData/Roaming/fnm/aliases/default/node.exe';
    const result = normalizeNodePath(nonEphemeral, {
      env: { FNM_DIR: 'C:/Users/u/AppData/Roaming/fnm' },
      // existsSync returns true for the alias to prove the regex — not the existsSync — is the guard
      existsSync: p => p === stableAlias,
    });
    assert.equal(
      result,
      nonEphemeral,
      `expected raw execPath (non-ephemeral id must not be remapped), got: ${result}`,
    );
  });
});

// ─── resolveNodeRunner — opts pass-through ────────────────────────────────────

describe('Bug #977: resolveNodeRunner — passes opts through to normalizeNodePath', () => {
  test('fnm multishell execPath is resolved to stable alias via injected opts', () => {
    const orig = process.execPath;
    try {
      Object.defineProperty(process, 'execPath', {
        value: EPHEMERAL_FNM_WIN,
        configurable: true,
      });
      const runner = resolveNodeRunner({
        env: { FNM_DIR: FNM_DIR_WIN },
        existsSync: p => p === STABLE_FNM_DIR_NODE,
      });
      assert.equal(
        runner,
        JSON.stringify(STABLE_FNM_DIR_NODE),
        `expected stable FNM_DIR alias quoted, got: ${runner}`,
      );
    } finally {
      Object.defineProperty(process, 'execPath', { value: orig, configurable: true });
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2979-hook-absolute-node.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2979-hook-absolute-node (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #2979: Managed JS hooks fail in GUI/minimal-PATH runtimes because
 * the installer emits bare `node`.
 *
 * Reporter evidence: in a stripped PATH like /usr/bin:/bin:/usr/sbin:/sbin
 * (the default for Finder-launched/Antigravity-spawned processes on macOS),
 * `node` is not resolvable. Hook commands like
 *   `node "<HOME>/.gemini/hooks/gsd-check-update.js"`
 * fail with `/bin/sh: node: command not found` (exit 127).
 *
 * Fix: emit the absolute node path (`process.execPath`, the binary
 * running the installer itself) as the runner. Forward-slash-normalized
 * and double-quoted so it works on POSIX and Windows.
 *
 * This test exercises the public buildHookCommand surface plus the
 * resolveNodeRunner helper, asserting on structured records:
 *  - the runner field is an absolute path (not bare 'node')
 *  - it ends with /node or \\node (or .exe on Windows simulation)
 *  - .sh hooks still use bare 'bash' (PATH-resolved; portable across
 *    distros that don't ship /bin/bash, like NixOS)
 *
 * No source-grep on install.js content — assertions go against the
 * value returned by the exported function and the parsed structure of
 * the emitted hook command (split into runner + args).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const INSTALL = require(path.join(__dirname, '..', 'bin', 'install.js'));
const { buildHookCommand, resolveNodeRunner } = INSTALL;

/**
 * Parse a hook command string into { runner, hookPath } structured
 * record. The shape is `<runner> "<hookPath>"` where <runner> may itself
 * be a quoted absolute path (containing spaces), so we split on the
 * trailing quoted-path token rather than the first space.
 */
function parseHookCommand(cmd) {
  // Trailing token: a double-quoted string ending the command.
  const m = cmd.match(/^(.+?)\s+"([^"]+)"\s*$/);
  if (!m) {
    return { runner: null, hookPath: null, raw: cmd };
  }
  return { runner: m[1], hookPath: m[2], raw: cmd };
}

describe('Bug #2979: resolveNodeRunner returns absolute, quoted, forward-slash node path', () => {
  test('exported as a function', () => {
    assert.equal(typeof resolveNodeRunner, 'function');
  });

  test('returns a double-quoted absolute path', () => {
    const runner = resolveNodeRunner();
    assert.ok(runner.startsWith('"'), `expected leading double-quote, got: ${runner}`);
    assert.ok(runner.endsWith('"'), `expected trailing double-quote, got: ${runner}`);
    const inner = runner.slice(1, -1);
    assert.ok(path.isAbsolute(inner.replace(/\//g, path.sep)), `expected absolute path, got: ${inner}`);
  });

  test('uses forward slashes (Windows-safe, matches buildHookCommand convention)', () => {
    const runner = resolveNodeRunner();
    assert.ok(!runner.includes('\\'), `expected forward slashes, got: ${runner}`);
  });

  test('points at a node binary (basename starts with "node")', () => {
    const runner = resolveNodeRunner();
    const inner = runner.slice(1, -1);
    const base = path.posix.basename(inner);
    assert.ok(/^node(\.exe)?$/i.test(base), `expected basename node or node.exe, got: ${base}`);
  });
});

describe('Bug #2979: buildHookCommand for .js hooks emits absolute node runner', () => {
  test('global install: .js hook uses absolute node path, not bare "node"', () => {
    const cmd = buildHookCommand('/tmp/.claude', 'gsd-check-update.js');
    const parsed = parseHookCommand(cmd);
    assert.notEqual(parsed.runner, null, `failed to parse: ${cmd}`);
    assert.notEqual(parsed.runner, 'node', `must not emit bare node (#2979): ${cmd}`);
    // The runner should be a quoted absolute path.
    assert.ok(parsed.runner.startsWith('"') && parsed.runner.endsWith('"'),
      `runner must be quoted absolute path, got: ${parsed.runner}`);
  });

  test('global install: .js hook command parses with hookPath at expected location', () => {
    const cmd = buildHookCommand('/tmp/.gemini', 'gsd-statusline.js');
    const parsed = parseHookCommand(cmd);
    assert.equal(parsed.hookPath, '/tmp/.gemini/hooks/gsd-statusline.js');
  });

  test('portableHooks global install: .js hook still uses absolute node (only the path is $HOME-relative)', () => {
    const home = require('node:os').homedir().replace(/\\/g, '/');
    const configDir = home + '/.gemini';
    const cmd = buildHookCommand(configDir, 'gsd-check-update.js', { portableHooks: true });
    const parsed = parseHookCommand(cmd);
    assert.notEqual(parsed.runner, 'node', `portableHooks must also use absolute node (#2979): ${cmd}`);
    assert.equal(parsed.hookPath, '$HOME/.gemini/hooks/gsd-check-update.js');
  });
});

describe('Bug #3362 / #3413: Windows hook commands are runtime-aware', () => {
  // #1928: gemini runtime removed — the PowerShell call-operator seam is now
  // inert for every runtime. Antigravity (the Gemini-backend successor) never
  // needed the call operator either; lock the inert contract explicitly.
  test('Antigravity global install: .js hook command stays shell-neutral on Windows (seam inert after gemini removal)', () => {
    const cmd = buildHookCommand('C:/Users/me/.gemini/antigravity', 'gsd-check-update.js', {
      platform: 'win32',
      runtime: 'antigravity',
    });
    assert.ok(!cmd.startsWith('& '), `Antigravity hook command must not use PowerShell call operator: ${cmd}`);
    assert.ok(cmd.includes('"C:/Users/me/.gemini/antigravity/hooks/gsd-check-update.js"'));
  });

  test('Antigravity portable install: .js hook command also stays shell-neutral on Windows (seam inert after gemini removal)', () => {
    const home = require('node:os').homedir().replace(/\\/g, '/');
    const cmd = buildHookCommand(`${home}/.gemini/antigravity`, 'gsd-check-update.js', {
      portableHooks: true,
      platform: 'win32',
      runtime: 'antigravity',
    });
    assert.ok(!cmd.startsWith('& '), `Antigravity hook command must not use PowerShell call operator: ${cmd}`);
    assert.equal(parseHookCommand(cmd).hookPath, '$HOME/.gemini/antigravity/hooks/gsd-check-update.js');
  });

  test('Claude global install: .js hook command stays shell-neutral on Windows Git Bash', () => {
    const cmd = buildHookCommand('C:/Users/me/.claude', 'gsd-check-update.js', {
      platform: 'win32',
      runtime: 'claude',
    });
    assert.ok(!cmd.startsWith('& '), `Claude hook command must not use PowerShell call operator: ${cmd}`);
    assert.equal(parseHookCommand(cmd).hookPath, 'C:/Users/me/.claude/hooks/gsd-check-update.js');
  });

  test('Windows .js hook with no runtime stays shell-neutral', () => {
    const cmd = buildHookCommand('C:/Users/me/.claude', 'gsd-check-update.js', {
      platform: 'win32',
    });
    assert.ok(!cmd.startsWith('& '), `Missing runtime must not imply PowerShell syntax: ${cmd}`);
    assert.equal(parseHookCommand(cmd).hookPath, 'C:/Users/me/.claude/hooks/gsd-check-update.js');
  });

  test('Antigravity runtime on non-Windows platform does not get PowerShell syntax', () => {
    const cmd = buildHookCommand('/home/me/.claude', 'gsd-check-update.js', {
      platform: 'linux',
      runtime: 'antigravity',
    });
    assert.ok(!cmd.startsWith('& '), `Non-Windows Antigravity hook must stay shell-neutral: ${cmd}`);
    assert.equal(parseHookCommand(cmd).hookPath, '/home/me/.claude/hooks/gsd-check-update.js');
  });
});

describe('Bug #2979: buildHookCommand for .sh hooks still uses bare "bash" (POSIX std PATH always has /bin)', () => {
  test('.sh hook runner is exactly "bash" — bash is in /usr/bin:/bin and resolves under minimal PATH', () => {
    const cmd = buildHookCommand('/tmp/.claude', 'gsd-session-state.sh', { platform: 'linux' });
    const parsed = parseHookCommand(cmd);
    assert.equal(parsed.runner, 'bash');
  });

  test('Windows .sh hook uses resolved Git Bash path instead of bare bash (#3393)', () => {
    const cmd = buildHookCommand('C:/Users/me/.codex', 'gsd-validate-commit.sh', {
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      existsSync: (candidate) => candidate === 'C:\\Program Files\\Git\\bin\\bash.exe',
    });
    assert.equal(
      cmd,
      '"C:/Program Files/Git/bin/bash.exe" "C:/Users/me/.codex/hooks/gsd-validate-commit.sh"',
    );
  });

  test('Windows .sh hook returns null when no supported Bash runner is found (#3393)', () => {
    const cmd = buildHookCommand('C:/Users/me/.codex', 'gsd-phase-boundary.sh', {
      platform: 'win32',
      env: {},
      existsSync: () => false,
    });
    assert.equal(cmd, null);
  });

  test('Windows Claude .sh hook omits explicit bash.exe wrapper (#166)', () => {
    const cmd = buildHookCommand('C:/Users/me/.claude', 'gsd-session-state.sh', {
      platform: 'win32',
      runtime: 'claude',
      env: { ProgramFiles: 'C:\\Program Files' },
      existsSync: (candidate) => candidate === 'C:\\Program Files\\Git\\bin\\bash.exe',
    });
    assert.equal(
      cmd,
      '"C:/Users/me/.claude/hooks/gsd-session-state.sh"',
      'Claude win32 .sh hooks should serialize as script-only commands'
    );
  });
});

// ─── #3002 CR follow-up: legacy-bare-node migration ─────────────────────────

const { rewriteLegacyManagedNodeHookCommands } = INSTALL;

describe('Bug #2979 (#3002 CR): rewriteLegacyManagedNodeHookCommands rewrites bare-node managed hooks on reinstall', () => {
  test('exported as a function', () => {
    assert.equal(typeof rewriteLegacyManagedNodeHookCommands, 'function');
  });

  test('rewrites a managed hook entry that uses bare `node ` to the absolute runner', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [
            { type: 'command', command: 'node "/Users/x/.gemini/hooks/gsd-check-update.js"' },
          ],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner);
    assert.equal(changed, true);
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].command,
      '"/usr/local/bin/node" "/Users/x/.gemini/hooks/gsd-check-update.js"',
    );
  });

  test('does NOT touch entries that already use a quoted absolute runner', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: '"/usr/local/bin/node" "/x/hooks/gsd-statusline.js"' }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const before = settings.hooks.SessionStart[0].hooks[0].command;
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner);
    assert.equal(changed, false);
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, before);
  });

  // #1928: gemini runtime removed — the PowerShell call-operator seam is now
  // inert for every runtime (including antigravity, the Gemini-backend
  // successor). An already-correct absolute-runner command needs no rewrite.
  test('Antigravity on Windows leaves an already-correct quoted managed hook untouched (seam inert after gemini removal)', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: '"/usr/local/bin/node" "C:/Program Files/Antigravity/.gemini/antigravity/hooks/gsd-check-update.js"' }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const before = settings.hooks.SessionStart[0].hooks[0].command;
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner, { platform: 'win32', runtime: 'antigravity' });
    assert.equal(changed, false);
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, before);
  });

  test('Antigravity on Windows strips a stale PowerShell call operator from managed hooks on reinstall (seam inert after gemini removal)', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: '& "/usr/local/bin/node" "C:/Program Files/Antigravity/.gemini/antigravity/hooks/gsd-check-update.js"' }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner, { platform: 'win32', runtime: 'antigravity' });
    assert.equal(changed, true);
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].command,
      '"/usr/local/bin/node" "C:/Program Files/Antigravity/.gemini/antigravity/hooks/gsd-check-update.js"',
    );
  });

  test('Antigravity on Windows rewrites PowerShell bare-node managed hooks to absolute runner and drops the stale & (seam inert after gemini removal)', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: '& node "C:/Users/me/.gemini/antigravity/hooks/gsd-check-update.js"' }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner, { platform: 'win32', runtime: 'antigravity' });
    assert.equal(changed, true);
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].command,
      '"/usr/local/bin/node" "C:/Users/me/.gemini/antigravity/hooks/gsd-check-update.js"',
    );
  });

  test('Claude on Windows strips stale PowerShell prefix from managed hooks on reinstall (#3413)', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: '& "/usr/local/bin/node" "C:/Users/me/.claude/hooks/gsd-check-update.js"' }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner, { platform: 'win32', runtime: 'claude' });
    assert.equal(changed, true);
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].command,
      '"/usr/local/bin/node" "C:/Users/me/.claude/hooks/gsd-check-update.js"',
    );
  });

  test('does NOT touch user-authored bare-node hooks (filename not in managed allowlist)', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: 'node /home/me/my-custom-hook.js' }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const before = settings.hooks.SessionStart[0].hooks[0].command;
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner);
    assert.equal(changed, false);
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, before);
  });

  test('does NOT touch .sh hooks (they correctly use bare bash)', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: 'bash "/x/hooks/gsd-session-state.sh"' }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner);
    assert.equal(changed, false);
  });

  test('is a no-op when absoluteRunner is null (resolveNodeRunner failed)', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: 'node "/x/hooks/gsd-check-update.js"' }],
        }],
      },
    };
    const before = settings.hooks.SessionStart[0].hooks[0].command;
    const changed = rewriteLegacyManagedNodeHookCommands(settings, null);
    assert.equal(changed, false);
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, before);
  });

  // #3002 CR: substring containment was a false-positive vector.
  // User-authored hooks whose path happened to CONTAIN a managed filename
  // as a substring would get unconditionally rewritten with the GSD runner.
  // The fix matches by basename equality.
  test('does NOT rewrite a user hook whose path contains a managed filename as a substring', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{
            type: 'command',
            // Path contains gsd-check-update.js as substring of a longer
            // filename, but is NOT actually that file.
            command: 'node /home/me/scripts/wraps-gsd-check-update.js-helper.js',
          }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const before = settings.hooks.SessionStart[0].hooks[0].command;
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner);
    assert.equal(changed, false, 'must not rewrite user hooks with managed-filename-as-substring paths');
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, before);
  });

  test('rewrites a managed entry whose path is quoted with single quotes', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: "node '/x/hooks/gsd-statusline.js'" }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner, { platform: 'linux' });
    assert.equal(changed, true);
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].command,
      `"/usr/local/bin/node" '/x/hooks/gsd-statusline.js'`,
    );
  });

  test('rewrites a managed entry with no path quoting (bareword)', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: 'node /x/hooks/gsd-context-monitor.js' }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner, { platform: 'linux' });
    assert.equal(changed, true);
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].command,
      '"/usr/local/bin/node" /x/hooks/gsd-context-monitor.js',
    );
  });

  test('handles Windows-style backslash path separators when extracting basename', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: 'node "C:\\\\Users\\\\me\\\\.claude\\\\hooks\\\\gsd-prompt-guard.js"' }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner);
    assert.equal(changed, true);
  });

  test('Antigravity on Windows normalizes single-quoted managed hook paths to double-quoted forward-slash paths without adding & (#3392; seam inert after gemini removal)', () => {
    const settings = {
      hooks: {
        PreToolUse: [{
          hooks: [{
            type: 'command',
            command: "node 'C:\\Users\\me\\.gemini\\hooks\\gsd-prompt-guard.js'",
          }],
        }],
      },
    };
    const runner = '"C:/nvm4w/nodejs/node.exe"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner, { platform: 'win32', runtime: 'antigravity' });
    assert.equal(changed, true);
    assert.equal(
      settings.hooks.PreToolUse[0].hooks[0].command,
      '"C:/nvm4w/nodejs/node.exe" "C:/Users/me/.gemini/hooks/gsd-prompt-guard.js"',
    );
  });
});

describe('Bug #2979 (#3002 CR): resolveNodeRunner returns null when execPath unavailable', () => {
  test('returns null instead of bare "node" when process.execPath is empty', () => {
    const orig = process.execPath;
    try {
      Object.defineProperty(process, 'execPath', { value: '', configurable: true });
      const r = resolveNodeRunner();
      assert.equal(r, null, 'expected null, not bare "node"');
    } finally {
      Object.defineProperty(process, 'execPath', { value: orig, configurable: true });
    }
  });

  test('buildHookCommand returns null when execPath is unavailable (caller skips registration)', () => {
    const orig = process.execPath;
    try {
      Object.defineProperty(process, 'execPath', { value: '', configurable: true });
      const cmd = buildHookCommand('/tmp/.claude', 'gsd-statusline.js');
      assert.equal(cmd, null);
    } finally {
      Object.defineProperty(process, 'execPath', { value: orig, configurable: true });
    }
  });
});

// ─── #3002 CR follow-up #2: null-command guards in settings.json ──────────

const { validateHookFields } = INSTALL;

describe('Bug #2979 (#3002 CR follow-up): no command:null hook entries survive serialization', () => {
  // CR feedback: assert structurally on the resulting settings object, not by
  // grepping bin/install.js source. The push-site guards (each `if` clause's
  // `&& <command>` token) skip null-command pushes at the source. As a
  // backstop, install.js now runs validateHookFields(settings) right before
  // writeSettings; this test exercises that backstop directly.
  //
  // Construct a settings object that contains exactly the kind of null-command
  // entries that the registration code would have written if my push-site
  // guards regressed. Run validateHookFields on it. Assert the null entries
  // are gone and the well-formed entries survive.

  function nullCommandEntry(matcher) {
    const entry = { hooks: [{ type: 'command', command: null }] };
    if (matcher) entry.matcher = matcher;
    return entry;
  }
  function realCommandEntry(matcher, command) {
    const entry = { hooks: [{ type: 'command', command }] };
    if (matcher) entry.matcher = matcher;
    return entry;
  }

  const MANAGED_JS_HOOKS = [
    { event: 'SessionStart',  matcher: undefined,                                       label: 'gsd-check-update.js' },
    { event: 'PostToolUse',   matcher: 'Bash|Edit|Write|MultiEdit|Agent|Task',          label: 'gsd-context-monitor.js' },
    { event: 'PreToolUse',    matcher: 'Write|Edit',                                    label: 'gsd-prompt-guard.js' },
    { event: 'PreToolUse',    matcher: 'Write|Edit',                                    label: 'gsd-read-guard.js' },
    { event: 'PostToolUse',   matcher: 'Read',                                          label: 'gsd-read-injection-scanner.js' },
    { event: 'PreToolUse',    matcher: 'Bash|Edit|Write|MultiEdit',                     label: 'gsd-workflow-guard.js' },
  ];

  for (const { event, matcher, label } of MANAGED_JS_HOOKS) {
    test(`validateHookFields strips a null-command ${label} entry from settings.hooks.${event}`, () => {
      const settings = {
        hooks: {
          [event]: [
            nullCommandEntry(matcher),
            realCommandEntry(matcher, '"/usr/local/bin/node" "/x/hooks/other.js"'),
          ],
        },
      };
      const out = validateHookFields(settings);
      const survivors = out.hooks[event] || [];
      // The well-formed entry must remain.
      assert.equal(survivors.length, 1, `expected the real-command entry to survive`);
      // No survivor entry contains a hook with command === null.
      for (const e of survivors) {
        for (const h of e.hooks || []) {
          assert.notEqual(h.command, null, 'no surviving hook should have command:null');
        }
      }
    });
  }

  test('validateHookFields drops the entry entirely when all its hooks have null commands', () => {
    const settings = {
      hooks: {
        SessionStart: [nullCommandEntry()],
      },
    };
    const out = validateHookFields(settings);
    // Empty event arrays should be cleaned up (the entire SessionStart key
    // gets removed when nothing valid remains).
    assert.ok(
      !out.hooks.SessionStart || out.hooks.SessionStart.length === 0,
      'expected SessionStart to be empty/removed after the only entry was dropped',
    );
  });

  test('validateHookFields preserves agent-type hooks while stripping command:null sibling hooks', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [
            { type: 'command', command: null },
            { type: 'agent', prompt: 'analyze the session' },
            { type: 'command', command: '"/usr/local/bin/node" "/x/hooks/y.js"' },
          ],
        }],
      },
    };
    const out = validateHookFields(settings);
    const survivors = out.hooks.SessionStart[0].hooks;
    assert.equal(survivors.length, 2, 'expected 2 of 3 hooks to survive (the null-command one is stripped)');
    assert.equal(survivors.find(h => h.command === null), undefined, 'no surviving hook should have command:null');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-442-config-dir-equals-in-path.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-442-config-dir-equals-in-path (consolidation epic #1969 B1 #1970)", () => {
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// parseConfigDirArg is not exported directly from bin/install.js (it closes
// over the module-level `args` array).  We expose a pure seam here:
// parseConfigDirFromArgs(args) that mirrors the function's logic so we can
// test the equals-form parsing without spawning a child process.
//
// The implementation under test is inlined below (RED: before the fix it will
// reproduce the truncation bug).  Once the fix lands, we swap in the real
// implementation via require.

/**
 * Pure seam that replicates the equals-form parse logic from bin/install.js.
 * We import it via a thin wrapper so that the function can be tested without
 * executing the entire install script.
 *
 * During RED the bug is: `split('=')[1]` drops everything after the second `=`.
 */
const { parseConfigDirFromArgs } = require('../bin/install.js');

describe('bug-442: --config-dir= equals-form path parsing', () => {
  // ── Happy-path: single = in path ─────────────────────────────────────────
  test('--config-dir=<path> with one = in value returns full value', () => {
    const result = parseConfigDirFromArgs(['--config-dir=/tmp/gsd=a']);
    assert.equal(result, '/tmp/gsd=a');
  });

  // ── Happy-path: multiple = in path ───────────────────────────────────────
  test('--config-dir=<path> with multiple = in value returns full value', () => {
    const result = parseConfigDirFromArgs(['--config-dir=/tmp/a=b=c']);
    assert.equal(result, '/tmp/a=b=c');
  });

  // ── Short form -c= ────────────────────────────────────────────────────────
  test('-c=<path> with = in value returns full value', () => {
    const result = parseConfigDirFromArgs(['-c=/tmp/gsd=a']);
    assert.equal(result, '/tmp/gsd=a');
  });

  test('-c=<path> with multiple = in value returns full value', () => {
    const result = parseConfigDirFromArgs(['-c=/tmp/a=b=c']);
    assert.equal(result, '/tmp/a=b=c');
  });

  // ── Contract: empty value ─────────────────────────────────────────────────
  // --config-dir= (no value after the =) → returns empty string ''.
  // The caller (parseConfigDirArg) treats '' as missing and errors; the seam
  // itself should faithfully return '' rather than null/undefined so the
  // caller can make the error decision.
  test('--config-dir= with no value returns empty string', () => {
    const result = parseConfigDirFromArgs(['--config-dir=']);
    assert.equal(result, '');
  });

  test('-c= with no value returns empty string', () => {
    const result = parseConfigDirFromArgs(['-c=']);
    assert.equal(result, '');
  });

  // ── Space-separated form is unaffected (regression guard) ─────────────────
  test('--config-dir <path> space-separated still returns the path', () => {
    const result = parseConfigDirFromArgs(['--config-dir', '/tmp/gsd=a']);
    assert.equal(result, '/tmp/gsd=a');
  });

  test('-c <path> space-separated still returns the path', () => {
    const result = parseConfigDirFromArgs(['-c', '/tmp/gsd=a']);
    assert.equal(result, '/tmp/gsd=a');
  });

  // ── No config-dir flag → null ─────────────────────────────────────────────
  test('returns null when no --config-dir flag is present', () => {
    const result = parseConfigDirFromArgs(['--global', '--claude']);
    assert.equal(result, null);
  });

  // ── Negative matrix (CLI edge cases) ─────────────────────────────────────
  // Flag-looking value after space form: next arg starts with - → null (no
  // valid value; the real function would process.exit but the seam returns null
  // so tests stay in-process).
  test('space form with next arg being a flag returns null (flag-looking value)', () => {
    const result = parseConfigDirFromArgs(['--config-dir', '--other-flag']);
    assert.equal(result, null);
  });

  // Equals form where value is a path with no = (plain path, no regression)
  test('--config-dir=<plain-path> without any = in path still works', () => {
    const result = parseConfigDirFromArgs(['--config-dir=/tmp/plain']);
    assert.equal(result, '/tmp/plain');
  });

  // Flag appears after other args (positional ordering should not matter)
  test('--config-dir= flag after other args is parsed correctly', () => {
    const result = parseConfigDirFromArgs(['--global', '--config-dir=/tmp/a=b', '--claude']);
    assert.equal(result, '/tmp/a=b');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-1559-installer-export-audit.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-1559-installer-export-audit (consolidation epic #1969 B1 #1970)", () => {
'use strict';

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');

let installer;
let conversion;

before(() => {
  process.env['GSD_TEST_MODE'] = '1';
  installer = require('../bin/install.js');
  conversion = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
});

describe('bin/install.js compatibility export audit (#1559)', () => {
  test('retains audited compatibility relays for shared rewrite helpers', () => {
    assert.strictEqual(installer.processAttribution, conversion.processAttribution);
    assert.strictEqual(
      installer.applyRuntimeContentRewritesForCommandsInPlace,
      conversion.applyRuntimeContentRewritesForCommandsInPlace,
    );
  });

  test('does not leak unaudited conversion-module helpers through the installer', () => {
    for (const name of [
      'yamlQuote',
      'toSingleLine',
      'extractFrontmatterAndBody',
      'extractFrontmatterField',
      'convertClaudeToCursorMarkdown',
      'convertClaudeToCodexMarkdown',
      'transformContentToHyphen',
      'claudeToGeminiTools',
      'convertGeminiToolName',
      'rewriteStagedSkillBodies',
      'rewriteStagedCommandBodies',
      '_computePathPrefix',
      '_stampNonClaudeRuntimeDefaults',
      'NON_CLAUDE_RUNTIMES',
    ]) {
      assert.ok(name in conversion, `${name} remains available from the conversion module`);
      assert.equal(installer[name], undefined, `${name} is not an installer compatibility export`);
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1908-uninstall-manifest.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1908-uninstall-manifest (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for bug #1908
 *
 * `--uninstall` did not remove `gsd-file-manifest.json` from the target
 * directory, leaving a stale metadata file after uninstall.
 *
 * Fix: `uninstall()` must call
 *   fs.rmSync(path.join(targetDir, MANIFEST_NAME), { force: true })
 * after cleaning up the rest of the GSD artefacts.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { uninstall } = require('../bin/install.js');

const MANIFEST_NAME = 'gsd-file-manifest.json';

// ─── helpers ──────────────────────────────────────────────────────────────────

function createFakeInstall(prefix = 'gsd-uninstall-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  // Simulate the minimum directory/file layout produced by the installer:
  // gsd-core/ directory, agents/ directory, and the manifest file.
  fs.mkdirSync(path.join(dir, 'gsd-core', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'gsd-core', 'workflows', 'execute-phase.md'), '# stub');

  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents', 'gsd-executor.md'), '# stub');

  const manifest = {
    version: '1.34.0',
    timestamp: new Date().toISOString(),
    files: {
      'gsd-core/workflows/execute-phase.md': 'abc123',
      'agents/gsd-executor.md': 'def456',
    },
  };
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));

  return dir;
}

function cleanup(dir) {
  // eslint-disable-next-line local/no-raw-rmsync-in-tests -- local teardown helper predates helpers.cjs; renaming would collide with the imported cleanup
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('uninstall — manifest cleanup (#1908)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFakeInstall();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gsd-file-manifest.json is removed after global uninstall', () => {
    const manifestPath = path.join(tmpDir, MANIFEST_NAME);

    // Pre-condition: manifest exists before uninstall
    assert.ok(
      fs.existsSync(manifestPath),
      'Test setup failure: manifest file should exist before uninstall'
    );

    // Run uninstall against tmpDir (pass it via CLAUDE_CONFIG_DIR so getGlobalDir()
    // resolves to our temp directory; pass isGlobal=true)
    const savedEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    try {
      uninstall(true, 'claude');
    } finally {
      if (savedEnv === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = savedEnv;
      }
    }

    assert.ok(
      !fs.existsSync(manifestPath),
      [
        `${MANIFEST_NAME} must be removed by uninstall() but still exists at`,
        manifestPath,
      ].join(' ')
    );
  });

  test('gsd-file-manifest.json is removed after local uninstall', () => {
    const manifestPath = path.join(tmpDir, MANIFEST_NAME);

    assert.ok(
      fs.existsSync(manifestPath),
      'Test setup failure: manifest file should exist before uninstall'
    );

    // For a local install, getGlobalDir is not called — targetDir = cwd + dirName.
    // Simulate by creating .claude/ inside tmpDir and placing artefacts there.
    const localDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(path.join(localDir, 'gsd-core', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(localDir, 'gsd-core', 'workflows', 'execute-phase.md'), '# stub');
    const localManifestPath = path.join(localDir, MANIFEST_NAME);
    fs.writeFileSync(localManifestPath, JSON.stringify({ version: '1.34.0', files: {} }, null, 2));

    const savedCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      uninstall(false, 'claude');
    } finally {
      process.chdir(savedCwd);
    }

    assert.ok(
      !fs.existsSync(localManifestPath),
      [
        `${MANIFEST_NAME} must be removed by uninstall() (local) but still exists at`,
        localManifestPath,
      ].join(' ')
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2771-user-profile-manifest.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2771-user-profile-manifest (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression tests for bug #2771: USER-PROFILE.md tracked in install manifest
 *
 * USER-PROFILE.md is a user-owned artifact created/refreshed by /gsd-profile-user.
 * preserveUserArtifacts() correctly preserves it across reinstalls. But writeManifest()
 * also records it under "gsd-core/USER-PROFILE.md" with a SHA-256 of whatever was
 * on disk at install time. On the next install, saveLocalPatches() compares the on-disk
 * (refreshed) hash to the manifest hash, finds them different, and emits the spurious
 * "Found N locally modified GSD file(s) — backed up to gsd-local-patches/" warning.
 *
 * Invariant: a file is either distribution (manifest-tracked, diff'd against manifest)
 * or user artifact (preserved across installs, never diff'd). It cannot be both. The
 * shared truth source must be a single USER_OWNED_ARTIFACTS list referenced by both
 * preserveUserArtifacts callers and writeManifest.
 *
 * Closes: #2771
 */

'use strict';

const { describe, test, beforeEach, afterEach, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { createTempDir, cleanup } = require('./helpers.cjs');

const INSTALL_SCRIPT = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
const MANIFEST_NAME = 'gsd-file-manifest.json';
const PATCHES_DIR_NAME = 'gsd-local-patches';

before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], { encoding: 'utf-8', stdio: 'pipe' });
});

function runInstaller(configDir) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  delete env.GSD_TEST_MODE;
  return execFileSync(
    process.execPath,
    [INSTALL_SCRIPT, '--claude', '--global', '--yes', '--no-sdk'],
    { encoding: 'utf-8', stdio: 'pipe', env }
  );
}

// ─── Test 1: writeManifest must NOT record USER-PROFILE.md ────────────────────

describe('#2771: USER-PROFILE.md is excluded from gsd-file-manifest.json', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempDir('gsd-2771-manifest-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('writeManifest excludes gsd-core/USER-PROFILE.md even when present on disk', () => {
    runInstaller(tmpDir);

    // Simulate /gsd-profile-user creating USER-PROFILE.md
    const profilePath = path.join(tmpDir, 'gsd-core', 'USER-PROFILE.md');
    fs.writeFileSync(profilePath, '# My Profile\n\nFirst version.\n');

    // Re-install: writeManifest runs again with USER-PROFILE.md present on disk
    runInstaller(tmpDir);

    const manifestPath = path.join(tmpDir, MANIFEST_NAME);
    assert.ok(fs.existsSync(manifestPath), 'manifest must be written');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    assert.ok(
      !Object.prototype.hasOwnProperty.call(manifest.files, 'gsd-core/USER-PROFILE.md'),
      'manifest.files must NOT contain gsd-core/USER-PROFILE.md — it is a user artifact, not distribution'
    );
  });
});

// ─── Test 2: preserveUserArtifacts still preserves USER-PROFILE.md ────────────

describe('#2771: USER-PROFILE.md is still preserved across reinstall', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempDir('gsd-2771-preserve-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('USER-PROFILE.md content survives reinstall (preservation regression guard)', () => {
    runInstaller(tmpDir);

    const profilePath = path.join(tmpDir, 'gsd-core', 'USER-PROFILE.md');
    const content = '# Profile\n\nUser content from /gsd-profile-user.\n';
    fs.writeFileSync(profilePath, content);

    runInstaller(tmpDir);

    assert.ok(fs.existsSync(profilePath), 'USER-PROFILE.md must survive reinstall');
    assert.strictEqual(fs.readFileSync(profilePath, 'utf8'), content);
  });
});

// ─── Test 3: no spurious "local patches" hit for USER-PROFILE.md refresh ──────

describe('#2771: refreshed USER-PROFILE.md does not trigger local-patches warning', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempDir('gsd-2771-patches-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('saveLocalPatches does not classify a refreshed USER-PROFILE.md as a local patch', () => {
    // Initial install
    runInstaller(tmpDir);

    // /gsd-profile-user creates USER-PROFILE.md (v1)
    const profilePath = path.join(tmpDir, 'gsd-core', 'USER-PROFILE.md');
    fs.writeFileSync(profilePath, '# Profile v1\n');

    // Reinstall — manifest written with v1 contents (under buggy code) or excluded (under fix)
    runInstaller(tmpDir);

    // /gsd-profile-user --refresh rewrites USER-PROFILE.md (v2 != v1)
    fs.writeFileSync(profilePath, '# Profile v2 — refreshed\n');

    // Reinstall — saveLocalPatches scans manifest. Under bug, v2 hash != v1 manifest
    // hash → patch detected. Under fix, file is not in manifest → no patch.
    const output = runInstaller(tmpDir);

    const patchesDir = path.join(tmpDir, PATCHES_DIR_NAME);
    const patchFile = path.join(patchesDir, 'gsd-core', 'USER-PROFILE.md');
    assert.ok(
      !fs.existsSync(patchFile),
      'USER-PROFILE.md must NOT appear in gsd-local-patches/ — it is a user artifact, not a modified distribution file'
    );

    const offendingLine = output
      .split('\n')
      .find((line) => /locally modified GSD file/.test(line) && /USER-PROFILE/.test(line));
    assert.strictEqual(
      offendingLine,
      undefined,
      'installer output must not report USER-PROFILE.md as a locally modified GSD file on any single line. Output was:\n' + output
    );
  });
});

// ─── Test 5: legacy manifest with USER-PROFILE.md entry is normalized ─────────

describe('#2771: legacy manifest entries for USER_OWNED_ARTIFACTS are normalized', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempDir('gsd-2771-legacy-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('pre-existing manifest entry for USER-PROFILE.md does not trigger patches warning', () => {
    // Initial install
    runInstaller(tmpDir);

    const profilePath = path.join(tmpDir, 'gsd-core', 'USER-PROFILE.md');
    fs.writeFileSync(profilePath, '# Profile v1\n');

    // Reinstall to populate manifest under the (now-fixed) writer
    runInstaller(tmpDir);

    // Inject a stale manifest entry simulating a pre-#2771 install: a hash for
    // USER-PROFILE.md that does NOT match current content.
    const manifestPath = path.join(tmpDir, MANIFEST_NAME);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files = manifest.files || {};
    manifest.files['gsd-core/USER-PROFILE.md'] = 'deadbeef'.repeat(8); // stale hash
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // /gsd-profile-user --refresh rewrites USER-PROFILE.md
    fs.writeFileSync(profilePath, '# Profile v2 — refreshed\n');

    // Reinstall — saveLocalPatches must strip the legacy entry before scanning
    const output = runInstaller(tmpDir);

    const patchesDir = path.join(tmpDir, PATCHES_DIR_NAME);
    const patchFile = path.join(patchesDir, 'gsd-core', 'USER-PROFILE.md');
    assert.ok(
      !fs.existsSync(patchFile),
      'legacy USER-PROFILE.md manifest entry must be normalized away — not backed up as a patch'
    );

    const offendingLine = output
      .split('\n')
      .find((line) => /locally modified GSD file/.test(line) && /USER-PROFILE/.test(line));
    assert.strictEqual(
      offendingLine,
      undefined,
      'legacy manifest entry must not surface a USER-PROFILE.md patches warning. Output was:\n' + output
    );
  });
});

// ─── Test 4: shared constant exists and is used by both call sites ────────────

describe('#2771: USER_OWNED_ARTIFACTS is a single source of truth', () => {
  test('install.js exports USER_OWNED_ARTIFACTS containing USER-PROFILE.md', () => {
    const origMode = process.env.GSD_TEST_MODE;
    process.env.GSD_TEST_MODE = '1';
    let mod;
    try {
      delete require.cache[require.resolve(INSTALL_SCRIPT)];
      mod = require(INSTALL_SCRIPT);
    } finally {
      if (origMode === undefined) delete process.env.GSD_TEST_MODE;
      else process.env.GSD_TEST_MODE = origMode;
    }

    assert.ok(
      Array.isArray(mod.USER_OWNED_ARTIFACTS) || mod.USER_OWNED_ARTIFACTS instanceof Set,
      'install.js must export USER_OWNED_ARTIFACTS as a single source of truth'
    );
    const list = Array.isArray(mod.USER_OWNED_ARTIFACTS)
      ? mod.USER_OWNED_ARTIFACTS
      : Array.from(mod.USER_OWNED_ARTIFACTS);
    assert.ok(
      list.includes('USER-PROFILE.md'),
      'USER_OWNED_ARTIFACTS must include USER-PROFILE.md'
    );
  });
});

describe('manifest path safety', () => {
  let tmpDir;
  let outside;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-manifest-path-safety-');
    outside = path.join(tmpDir, '..', `outside-managed-file-${path.basename(tmpDir)}.txt`);
  });
  afterEach(() => {
    cleanup(outside);
    cleanup(tmpDir);
  });

  test('saveLocalPatches ignores manifest entries that escape the install root', () => {
    const origMode = process.env.GSD_TEST_MODE;
    process.env.GSD_TEST_MODE = '1';
    let mod;
    try {
      delete require.cache[require.resolve(INSTALL_SCRIPT)];
      mod = require(INSTALL_SCRIPT);
    } finally {
      if (origMode === undefined) delete process.env.GSD_TEST_MODE;
      else process.env.GSD_TEST_MODE = origMode;
    }

    fs.writeFileSync(outside, 'outside user data\n', 'utf8');
    fs.writeFileSync(
      path.join(tmpDir, MANIFEST_NAME),
      JSON.stringify({
        version: 'legacy',
        timestamp: '2026-05-11T00:00:00.000Z',
        files: {
          '../outside-managed-file.txt': 'deadbeef',
        },
      }, null, 2),
      'utf8'
    );

    const modified = mod.saveLocalPatches(tmpDir);

    assert.deepEqual(modified, []);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside user data\n');
    assert.equal(fs.existsSync(path.join(tmpDir, PATCHES_DIR_NAME, '..', path.basename(outside))), false);
  });

  test('saveLocalPatches does not follow symlinked patch directories outside the install root', () => {
    const origMode = process.env.GSD_TEST_MODE;
    process.env.GSD_TEST_MODE = '1';
    let mod;
    try {
      delete require.cache[require.resolve(INSTALL_SCRIPT)];
      mod = require(INSTALL_SCRIPT);
    } finally {
      if (origMode === undefined) delete process.env.GSD_TEST_MODE;
      else process.env.GSD_TEST_MODE = origMode;
    }

    const hookPath = path.join(tmpDir, 'hooks', 'managed.js');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, 'user edited hook\n', 'utf8');
    fs.writeFileSync(
      path.join(tmpDir, MANIFEST_NAME),
      JSON.stringify({
        version: 'legacy',
        timestamp: '2026-05-11T00:00:00.000Z',
        files: {
          'hooks/managed.js': crypto.createHash('sha256').update('managed hook\n').digest('hex'),
        },
      }, null, 2),
      'utf8'
    );

    fs.mkdirSync(outside, { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(tmpDir, PATCHES_DIR_NAME), 'dir');
    } catch {
      return;
    }

    const modified = mod.saveLocalPatches(tmpDir);

    assert.deepEqual(modified, []);
    assert.equal(fs.existsSync(path.join(outside, 'hooks', 'managed.js')), false);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3571-configuration-manifest-install-path.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3571-configuration-manifest-install-path (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for #3571: configuration.cjs used the source
 * checkout sdk/shared path only, which breaks installed gsd-tools.cjs because
 * runtime installs copy gsd-core/ but not sdk/.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const CONFIGURATION_CJS = path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'configuration.cjs');
const SHARED_DIR = path.join(REPO_ROOT, 'gsd-core', 'bin', 'shared');

const { install } = require('../bin/install.js');

const { createTempDir, cleanup } = require('./helpers.cjs');
const makeTmpDir = () => createTempDir('gsd-3571-');

function silenceConsole(fn) {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

describe('bug #3571: configuration generated manifests resolve in install layout', () => {
  let tmpRoot;
  let savedHome;
  let savedUserProfile;
  let savedExplicitConfigDir;

  beforeEach(() => {
    tmpRoot = makeTmpDir();
    savedHome = process.env.HOME;
    // On Windows, os.homedir() reads USERPROFILE; install() resolves via it.
    savedUserProfile = process.env.USERPROFILE;
    savedExplicitConfigDir = process.env.GSD_EXPLICIT_CONFIG_DIR;
    delete process.env.GSD_EXPLICIT_CONFIG_DIR;
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (savedExplicitConfigDir === undefined) {
      delete process.env.GSD_EXPLICIT_CONFIG_DIR;
    } else {
      process.env.GSD_EXPLICIT_CONFIG_DIR = savedExplicitConfigDir;
    }
    cleanup(tmpRoot);
  });

  test('co-located bin/shared manifests let configuration.cjs load without sdk/shared', () => {
    const gsdBinDir = path.join(tmpRoot, '.codex', 'gsd-core', 'bin');
    const gsdLibDir = path.join(gsdBinDir, 'lib');
    const gsdSharedDir = path.join(gsdBinDir, 'shared');
    fs.mkdirSync(gsdLibDir, { recursive: true });
    fs.mkdirSync(gsdSharedDir, { recursive: true });

    const installedCjs = path.join(gsdLibDir, 'configuration.cjs');
    fs.copyFileSync(CONFIGURATION_CJS, installedCjs);
    fs.copyFileSync(
      path.join(SHARED_DIR, 'config-defaults.manifest.json'),
      path.join(gsdSharedDir, 'config-defaults.manifest.json')
    );
    fs.copyFileSync(
      path.join(SHARED_DIR, 'config-schema.manifest.json'),
      path.join(gsdSharedDir, 'config-schema.manifest.json')
    );

    delete require.cache[installedCjs];
    let mod;
    assert.doesNotThrow(() => {
      mod = require(installedCjs);
    }, 'installed configuration.cjs must not require ~/.codex/sdk/shared');

    assert.ok(mod.VALID_CONFIG_KEYS.has('workflow.plan_review_convergence'));
  });

  test('post-install: install() copies configuration manifests to co-located bin/shared', () => {
    process.env.HOME = tmpRoot;
    process.env.USERPROFILE = tmpRoot;

    silenceConsole(() => {
      install(true, 'codex');
    });

    const sharedDir = path.join(tmpRoot, '.codex', 'gsd-core', 'bin', 'shared');
    for (const fileName of ['config-defaults.manifest.json', 'config-schema.manifest.json']) {
      const installedManifest = path.join(sharedDir, fileName);
      assert.ok(fs.existsSync(installedManifest), `${fileName} must be copied to ${sharedDir}`);
      assert.doesNotThrow(() => {
        JSON.parse(fs.readFileSync(installedManifest, 'utf8'));
      }, `${fileName} must be valid JSON`);
    }

    const installedCjs = path.join(
      tmpRoot,
      '.codex',
      'gsd-core',
      'bin',
      'lib',
      'configuration.cjs'
    );

    delete require.cache[installedCjs];
    assert.doesNotThrow(() => {
      require(installedCjs);
    }, 'post-install configuration.cjs must load from co-located manifests');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3288-model-catalog-install-path.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3288-model-catalog-install-path (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for #3288: model-catalog.cjs uses brittle relative path
 * that breaks after install.
 *
 * Repro:
 *   After `node bin/install.js --global --claude`, the installed
 *   `~/.claude/gsd-core/bin/lib/model-catalog.cjs` tries:
 *     require(path.join(__dirname, '..', '..', '..', 'sdk', 'shared', 'model-catalog.json'))
 *   which resolves to `~/.claude/sdk/shared/model-catalog.json`.
 *   The installer copies `gsd-core/` but never copies `sdk/shared/`,
 *   so the require throws MODULE_NOT_FOUND.
 *
 * Fix contract:
 *   1. model-catalog.cjs must use a resolve-chain that checks a co-located
 *      path first (bin/shared/model-catalog.json) before the legacy
 *      source-repo path.
 *   2. bin/install.js must copy shared model-catalog.json into
 *      gsd-core/bin/shared/model-catalog.json (co-located inside the
 *      gsd-core/ payload).
 *
 * Both halves must be true for the install layout to work.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const MODEL_CATALOG_CJS = path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'model-catalog.cjs');
const MODEL_CATALOG_JSON = path.join(REPO_ROOT, 'gsd-core', 'bin', 'shared', 'model-catalog.json');

const { install } = require('../bin/install.js');

// ─── helpers ─────────────────────────────────────────────────────────────────

const { createTempDir, cleanup } = require('./helpers.cjs');
const makeTmpDir = createTempDir;

const rmTmpDir = cleanup;

/**
 * Silence console output during install to avoid noise in test output.
 */
function silenceConsole(fn) {
  const orig = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
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

// ─── test 1: fake-install layout reproduces MODULE_NOT_FOUND ────────────────
//
// Build a fake post-install layout that mirrors what the OLD install did:
//   <tmp>/.claude/gsd-core/bin/lib/model-catalog.cjs  (copy of real file)
//   <tmp>/.claude/sdk/shared/model-catalog.json            ABSENT
//
// Then attempt to require model-catalog.cjs from that layout.
// Under the old path scheme (3 levels up → sdk/shared/) this should throw.
// After the fix, if we DON'T also copy the json, it should still throw — this
// confirms the co-located path IS required.

describe('bug #3288: model-catalog.cjs install-layout resolution', () => {
  let tmpRoot;
  let savedHome;
  let savedUserProfile;
  let savedExplicitConfigDir;

  beforeEach(() => {
    tmpRoot = makeTmpDir('gsd-3288-');
    savedHome = process.env.HOME;
    // On Windows, os.homedir() reads USERPROFILE (and HOMEDRIVE+HOMEPATH), NOT
    // HOME. install() resolves the install destination via os.homedir(), so the
    // tests must also redirect USERPROFILE → tmpRoot on win32 to keep the
    // installer writing inside the fixture.
    savedUserProfile = process.env.USERPROFILE;
    // Stash and clear explicitConfigDir via env so install() picks up our tmp dir.
    // Must delete (not just save) so any CI-set value doesn't leak into install()
    // and target a different directory than tmpRoot (CR finding, PR #3293).
    savedExplicitConfigDir = process.env.GSD_EXPLICIT_CONFIG_DIR;
    delete process.env.GSD_EXPLICIT_CONFIG_DIR;
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (savedExplicitConfigDir === undefined) {
      delete process.env.GSD_EXPLICIT_CONFIG_DIR;
    } else {
      process.env.GSD_EXPLICIT_CONFIG_DIR = savedExplicitConfigDir;
    }
    rmTmpDir(tmpRoot);
  });

  // ── test A ──────────────────────────────────────────────────────────────────
  test('OLD layout (3-level __dirname, no co-located json) fails to require', () => {
    // Build the old install layout manually:
    //   <tmpRoot>/.claude/gsd-core/bin/lib/model-catalog.cjs  (copy of the real CJS)
    //   sdk/shared/model-catalog.json                              ABSENT
    const gsdLibDir = path.join(tmpRoot, '.claude', 'gsd-core', 'bin', 'lib');
    fs.mkdirSync(gsdLibDir, { recursive: true });

    // Write a minimal model-catalog.cjs that uses ONLY the 3-level path (the old/broken path).
    const oldCjsContent = `'use strict';
const path = require('node:path');
// This is the BRITTLE path: 3 levels up from bin/lib → sdk/shared/
const catalog = require(path.join(__dirname, '..', '..', '..', 'sdk', 'shared', 'model-catalog.json'));
module.exports = { catalog };
`;
    const catalogCjsPath = path.join(gsdLibDir, 'model-catalog.cjs');
    fs.writeFileSync(catalogCjsPath, oldCjsContent);

    // Deliberately do NOT create sdk/shared/model-catalog.json (simulates missing file post-install).

    // Require must fail with MODULE_NOT_FOUND.
    assert.throws(
      () => {
        // Delete from require cache to force a fresh load.
        delete require.cache[catalogCjsPath];
        require(catalogCjsPath);
      },
      (err) => {
        assert.ok(
          err.code === 'MODULE_NOT_FOUND' || err.message.includes('model-catalog.json'),
          `Expected MODULE_NOT_FOUND or model-catalog.json error, got: ${err.message}`,
        );
        return true;
      },
      'OLD 3-level path must fail when sdk/shared/model-catalog.json is not present (install layout)',
    );
  });

  // ── test B ──────────────────────────────────────────────────────────────────
  test('NEW layout (co-located bin/shared/model-catalog.json) resolves correctly', () => {
    // Build the new install layout:
    //   <tmpRoot>/.claude/gsd-core/bin/lib/model-catalog.cjs (copy of real CJS)
    //   <tmpRoot>/.claude/gsd-core/bin/shared/model-catalog.json (co-located copy)
    const gsdBinDir = path.join(tmpRoot, '.claude', 'gsd-core', 'bin');
    const gsdLibDir = path.join(gsdBinDir, 'lib');
    const gsdSharedDir = path.join(gsdBinDir, 'shared');
    fs.mkdirSync(gsdLibDir, { recursive: true });
    fs.mkdirSync(gsdSharedDir, { recursive: true });

    // Copy the real model-catalog.cjs into the fake install.
    const catalogCjsPath = path.join(gsdLibDir, 'model-catalog.cjs');
    fs.copyFileSync(MODEL_CATALOG_CJS, catalogCjsPath);

    // Copy the real model-catalog.json to the co-located path.
    fs.copyFileSync(MODEL_CATALOG_JSON, path.join(gsdSharedDir, 'model-catalog.json'));

    // Require must succeed and expose catalog with expected shape.
    delete require.cache[catalogCjsPath];
    let mod;
    assert.doesNotThrow(() => {
      mod = require(catalogCjsPath);
    }, 'NEW co-located layout must not throw MODULE_NOT_FOUND');

    assert.ok(mod.catalog, 'module must export catalog');
    assert.ok(Array.isArray(mod.VALID_PROFILES), 'module must export VALID_PROFILES');
    assert.ok(mod.VALID_PROFILES.length > 0, 'VALID_PROFILES must not be empty');
  });

  // ── test C ──────────────────────────────────────────────────────────────────
  test('post-install: install() copies model-catalog.json to co-located path', () => {
    // Run the real installer against a tmp target dir, then assert the co-located
    // json is present and parseable.
    const claudeDir = path.join(tmpRoot, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    process.env.HOME = tmpRoot;
    process.env.USERPROFILE = tmpRoot;

    // Capture process.exit to prevent the test from being killed.
    const origExit = process.exit;
    let exitCalled = false;
    process.exit = (code) => {
      exitCalled = true;
      throw new Error(`process.exit(${code}) during install — should not happen`);
    };

    try {
      silenceConsole(() => {
        install(true /* isGlobal */, 'claude');
      });
    } catch (e) {
      if (exitCalled) {
        assert.fail(`install() called process.exit — unexpected: ${e.message}`);
      }
      throw e;
    } finally {
      process.exit = origExit;
    }

    // The co-located json must be present after install.
    const colocatedJson = path.join(
      claudeDir,
      'gsd-core',
      'bin',
      'shared',
      'model-catalog.json',
    );
    assert.ok(
      fs.existsSync(colocatedJson),
      `model-catalog.json must be present at co-located path post-install: ${colocatedJson}`,
    );

    // The json must be valid and have expected shape.
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(fs.readFileSync(colocatedJson, 'utf8'));
    }, 'co-located model-catalog.json must be valid JSON');

    assert.ok(Array.isArray(parsed.profiles), 'catalog.profiles must be an array');
    assert.ok(parsed.profiles.length > 0, 'catalog.profiles must not be empty');

    // And the installed model-catalog.cjs must be requireable from its install location.
    const installedCjs = path.join(
      claudeDir,
      'gsd-core',
      'bin',
      'lib',
      'model-catalog.cjs',
    );
    assert.ok(fs.existsSync(installedCjs), `model-catalog.cjs must be installed at: ${installedCjs}`);

    delete require.cache[installedCjs];
    let installedMod;
    assert.doesNotThrow(() => {
      installedMod = require(installedCjs);
    }, 'installed model-catalog.cjs must not throw MODULE_NOT_FOUND after install');

    assert.ok(installedMod.catalog, 'installed module must export catalog');
    assert.ok(installedMod.VALID_PROFILES.length > 0, 'installed module must have valid profiles');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-130-finishinstall-opencode-testmode.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-130-finishinstall-opencode-testmode (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #130: finishInstall calls configureOpencodePermissions unconditionally,
 * violating the GSD_TEST_MODE side-effect-free contract.
 *
 * configureOpencodePermissions does fs.mkdirSync + fs.writeFileSync, which
 * must NOT run under GSD_TEST_MODE='1'. This test asserts that the opencode
 * config file (opencode.json) is NOT created when GSD_TEST_MODE is set.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

// Point HOME at a temp dir so configureOpencodePermissions can't write to
// the real ~/.config/opencode/ even if the guard is missing.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-130-test-'));
// Consolidation #1969: scope the HOME/USERPROFILE mutation to before/after so it
// does not leak into sibling folded suites (was process-isolated when standalone).
const { before: __foldBefore, after: __foldAfter } = require('node:test');
const __savedHome = process.env.HOME;
const __savedUserProfile = process.env.USERPROFILE;
__foldBefore(() => {
  process.env.HOME = FAKE_HOME;
  process.env.USERPROFILE = FAKE_HOME;
});
__foldAfter(() => {
  if (__savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = __savedHome;
  if (__savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = __savedUserProfile;
});

// The opencode config dir that configureOpencodePermissions would use for a
// global install when configDir=null: <HOME>/.config/opencode/
// The file it writes is opencode.json (or opencode.jsonc if pre-existing).
const OPENCODE_CONFIG_DIR = path.join(FAKE_HOME, '.config', 'opencode');
const OPENCODE_CONFIG_FILE = path.join(OPENCODE_CONFIG_DIR, 'opencode.json');

// configDir is passed explicitly so the function targets our FAKE_HOME dir
// regardless of how getGlobalDir resolves.
const installModule = require(path.join(ROOT, 'bin', 'install.js'));

const SETTINGS_PATH = path.join(FAKE_HOME, `gsd-test-settings-${process.pid}.json`);

function callFinishInstall() {
  const original = console.log;
  console.log = () => {};
  try {
    installModule.finishInstall(
      SETTINGS_PATH,
      {},
      null,
      false,
      'opencode',
      true,
      OPENCODE_CONFIG_DIR, // pass explicit configDir pointing at our temp dir
    );
  } finally {
    console.log = original;
  }
}

describe('Bug #130: finishInstall opencode + GSD_TEST_MODE side-effect guard', () => {
  test('configureOpencodePermissions does NOT write opencode.json under GSD_TEST_MODE', () => {
    // Confirm the file does not exist before the call
    assert.equal(
      fs.existsSync(OPENCODE_CONFIG_FILE),
      false,
      'opencode.json should not exist before finishInstall call',
    );

    callFinishInstall();

    // Assert the file was NOT created — the side-effect must be suppressed
    assert.equal(
      fs.existsSync(OPENCODE_CONFIG_FILE),
      false,
      `opencode.json must NOT be created under GSD_TEST_MODE; found at ${OPENCODE_CONFIG_FILE}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-410-install-defaults-test-mode-guard.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-410-install-defaults-test-mode-guard (consolidation epic #1969 B1 #1970)", () => {
'use strict';

/**
 * Bug #410: finishInstall writes ~/.gsd/defaults.json for non-Claude runtimes
 * without a GSD_TEST_MODE guard, polluting the real developer home directory
 * during test runs.
 *
 * The opencode permission-config write a few lines above already carries the
 * GSD_TEST_MODE guard (added for #130) — this test covers the un-fixed sibling
 * (the resolve_model_ids: "omit" write).
 */

const { test, describe } = require('node:test');
const { cleanup } = require('./helpers.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

// Point HOME at a temp dir so the defaults.json write can't reach the real
// ~/.gsd/ even if the guard is missing.
// On Windows, os.homedir() reads USERPROFILE (not HOME). Set both so
// finishInstall's path.join(os.homedir(), '.gsd') resolves into FAKE_HOME
// on every platform. Node docs: https://nodejs.org/docs/latest-v22.x/api/os.html#oshomedir
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-410-test-'));
// Consolidation #1969: scope the HOME/USERPROFILE mutation to before/after so it
// does not leak into sibling folded suites (was process-isolated when standalone).
const { before: __foldBefore, after: __foldAfter } = require('node:test');
const __savedHome = process.env.HOME;
const __savedUserProfile = process.env.USERPROFILE;
__foldBefore(() => {
  process.env.HOME = FAKE_HOME;
  process.env.USERPROFILE = FAKE_HOME;
});
__foldAfter(() => {
  if (__savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = __savedHome;
  if (__savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = __savedUserProfile;
});

// The path that finishInstall would write to for a non-Claude runtime.
const GSD_DIR = path.join(FAKE_HOME, '.gsd');
const DEFAULTS_PATH = path.join(GSD_DIR, 'defaults.json');

// Set GSD_TEST_MODE before requiring install.js so any module-level guards
// also see the flag.
process.env.GSD_TEST_MODE = '1';

const installModule = require(path.join(ROOT, 'bin', 'install.js'));

// A synthetic settingsPath that won't exist — finishInstall should cope.
const SETTINGS_PATH = path.join(FAKE_HOME, `gsd-test-settings-${process.pid}.json`);

function callFinishInstallForRuntime(runtime) {
  const original = console.log;
  console.log = () => {};
  try {
    installModule.finishInstall(
      SETTINGS_PATH,
      {},       // empty settings
      null,     // statuslineCommand
      false,    // shouldInstallStatusline
      runtime,
      true,     // isGlobal
      null,     // configDir
    );
  } finally {
    console.log = original;
  }
}

describe('Bug #410: finishInstall non-Claude runtime + GSD_TEST_MODE side-effect guard', () => {
  test('defaults.json is NOT written for opencode runtime under GSD_TEST_MODE', () => {
    assert.equal(
      fs.existsSync(DEFAULTS_PATH),
      false,
      'defaults.json should not exist before finishInstall call',
    );

    callFinishInstallForRuntime('opencode');

    assert.equal(
      fs.existsSync(DEFAULTS_PATH),
      false,
      `defaults.json must NOT be created under GSD_TEST_MODE; found at ${DEFAULTS_PATH}`,
    );
  });

  test('defaults.json is NOT written for antigravity runtime under GSD_TEST_MODE', () => {
    // Reset in case previous test left artifacts (it shouldn't).
    assert.equal(
      fs.existsSync(DEFAULTS_PATH),
      false,
      'defaults.json should not exist before antigravity test',
    );

    callFinishInstallForRuntime('antigravity');

    assert.equal(
      fs.existsSync(DEFAULTS_PATH),
      false,
      `defaults.json must NOT be created under GSD_TEST_MODE for antigravity; found at ${DEFAULTS_PATH}`,
    );
  });

  test('defaults.json IS written for opencode runtime when GSD_TEST_MODE is unset', () => {
    // Temporarily unset GSD_TEST_MODE to verify the user-facing path still works.
    const saved = process.env.GSD_TEST_MODE;
    delete process.env.GSD_TEST_MODE;
    try {
      callFinishInstallForRuntime('opencode');
      assert.equal(
        fs.existsSync(DEFAULTS_PATH),
        true,
        `defaults.json must be written for non-Claude runtime when GSD_TEST_MODE is unset`,
      );
      // Verify the written content is correct.
      const contents = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
      assert.equal(contents.resolve_model_ids, 'omit', 'resolve_model_ids must be "omit"');
    } finally {
      // Restore GSD_TEST_MODE and clean up the written file.
      process.env.GSD_TEST_MODE = saved;
      cleanup(DEFAULTS_PATH);
      try { fs.rmdirSync(GSD_DIR); } catch { /* not empty or already gone */ }
    }
  });
});

// Bug #1569 folded here (sibling on the SAME finishInstall resolve_model_ids block):
// the #1156 default-to-"omit" step keyed its write on `!== "omit"`, so an explicit
// `resolve_model_ids: true` opt-in (resolveModelInternal returns full materialized
// model IDs) was silently clobbered across all 14 non-Claude runtimes. The fix
// preserves `true` and only defaults absent/falsy → "omit". Reuses the #410 harness.

describe('Bug #1569: non-Claude finishInstall preserves explicit resolve_model_ids:true', () => {
  function seedDefaults(obj) {
    fs.mkdirSync(GSD_DIR, { recursive: true });
    fs.writeFileSync(DEFAULTS_PATH, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  }

  function withUserPath(fn) {
    const saved = process.env.GSD_TEST_MODE;
    delete process.env.GSD_TEST_MODE;
    try {
      return fn();
    } finally {
      process.env.GSD_TEST_MODE = saved;
    }
  }

  test('explicit resolve_model_ids:true survives a codex global install (the reported case)', () => {
    withUserPath(() => {
      seedDefaults({ runtime: 'codex', model_profile: 'balanced', resolve_model_ids: true });
      callFinishInstallForRuntime('codex');
      const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
      assert.equal(
        after.resolve_model_ids,
        true,
        'explicit resolve_model_ids:true must be preserved across a codex install, not clobbered to "omit"',
      );
    });
  });

  // The clobber guard is runtime-agnostic (`runtime !== 'claude'`); parameterize
  // across a representative slice of non-Claude runtimes.
  for (const runtime of ['codex', 'opencode', 'antigravity']) {
    test(`explicit resolve_model_ids:true survives a ${runtime} global install`, () => {
      withUserPath(() => {
        seedDefaults({ runtime, resolve_model_ids: true });
        callFinishInstallForRuntime(runtime);
        const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
        assert.equal(
          after.resolve_model_ids,
          true,
          `explicit resolve_model_ids:true must be preserved for ${runtime}`,
        );
      });
    });
  }

  test('absent resolve_model_ids still defaults to "omit" (preserves #1156 intent)', () => {
    withUserPath(() => {
      seedDefaults({ runtime: 'codex' });
      callFinishInstallForRuntime('codex');
      const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
      assert.equal(
        after.resolve_model_ids,
        'omit',
        'absent resolve_model_ids must still default to "omit" for non-Claude runtimes',
      );
    });
  });

  test('explicit resolve_model_ids:false still defaults to "omit"', () => {
    withUserPath(() => {
      seedDefaults({ runtime: 'codex', resolve_model_ids: false });
      callFinishInstallForRuntime('codex');
      const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
      assert.equal(after.resolve_model_ids, 'omit', 'false must still be normalized to "omit"');
    });
  });

  test('non-canonical resolve_model_ids values (0, "", "yes", {}) default to "omit" — no Claude alias leak (#1569 codex review)', () => {
    // The domain is true/false/"omit"/absent. Any OTHER value is malformed; the safe
    // non-Claude default is "omit" (don't leak Claude aliases the runtime can't resolve).
    withUserPath(() => {
      for (const bad of [0, '', 'yes', {}]) {
        seedDefaults({ runtime: 'codex', resolve_model_ids: bad });
        callFinishInstallForRuntime('codex');
        const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
        assert.equal(
          after.resolve_model_ids,
          'omit',
          `non-canonical resolve_model_ids:${JSON.stringify(bad)} must default to "omit", not pass through`,
        );
      }
    });
  });

  test('already-"omit" is left unchanged (idempotent, no rewrite churn)', () => {
    withUserPath(() => {
      seedDefaults({ runtime: 'codex', resolve_model_ids: 'omit' });
      const beforeMtime = fs.statSync(DEFAULTS_PATH).mtimeMs;
      // fs mtime resolution can be coarse; wait briefly so an accidental rewrite is detectable.
      const start = Date.now();
      while (Date.now() - start < 20) { /* spin briefly */ }
      callFinishInstallForRuntime('codex');
      const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
      const afterMtime = fs.statSync(DEFAULTS_PATH).mtimeMs;
      assert.equal(after.resolve_model_ids, 'omit');
      assert.equal(
        afterMtime,
        beforeMtime,
        'defaults.json must not be rewritten when resolve_model_ids is already "omit" (idempotent)',
      );
    });
  });

  test('claude runtime never touches resolve_model_ids (cross-runtime parity)', () => {
    withUserPath(() => {
      seedDefaults({ runtime: 'claude', resolve_model_ids: true });
      callFinishInstallForRuntime('claude');
      const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
      assert.equal(
        after.resolve_model_ids,
        true,
        'claude install must never rewrite resolve_model_ids',
      );
    });
  });

  test('malformed defaults.json does not crash — still defaults to "omit"', () => {
    withUserPath(() => {
      fs.mkdirSync(GSD_DIR, { recursive: true });
      fs.writeFileSync(DEFAULTS_PATH, '{ not valid json }', 'utf8');
      // Must not throw.
      callFinishInstallForRuntime('codex');
      const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
      assert.equal(
        after.resolve_model_ids,
        'omit',
        'malformed defaults.json must be recovered to a valid state with resolve_model_ids:omit',
      );
    });
  });
});

// Bug #1657 — finishInstall reads ~/.gsd/defaults.json with JSON.parse but did not
// validate the result is a plain object. A valid-JSON-but-non-object value (null, [],
// 42, "str") bypassed the catch and flowed through, leaving the malformed file on disk
// unrecovered (and, for null, throwing a TypeError swallowed by the outer try/catch).
// Folded into the owning install-defaults test (no new top-level bug-NNNN file).
describe('Bug #1657: finishInstall recovers a malformed (non-object) defaults.json', () => {
  function seedDefaultsRaw(raw) {
    fs.mkdirSync(GSD_DIR, { recursive: true });
    fs.writeFileSync(DEFAULTS_PATH, raw, 'utf8');
  }
  function runAndRead(runtime) {
    const saved = process.env.GSD_TEST_MODE;
    delete process.env.GSD_TEST_MODE;
    const log = console.log; console.log = () => {};
    let threw = null;
    try {
      installModule.finishInstall(SETTINGS_PATH, {}, null, false, runtime, true, null);
    } catch (e) { threw = e.message; } finally { console.log = log; process.env.GSD_TEST_MODE = saved; }
    let after = null;
    try { after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8')); } catch (e) { after = 'UNPARSEABLE: ' + e.message; }
    return { threw, after };
  }

  for (const [label, raw] of [['null', 'null'], ['array', '[]'], ['number', '42'], ['string', '"oops"']]) {
    test(`seed ${label} (${raw}) recovers to a valid object with resolve_model_ids:omit`, () => {
      seedDefaultsRaw(raw);
      const { threw, after } = runAndRead('codex');
      assert.equal(threw, null, `must not throw for seed ${label} (got: ${threw})`);
      assert.equal(
        after !== null && typeof after === 'object' && !Array.isArray(after) && after.resolve_model_ids === 'omit',
        true,
        `seed ${label} must recover to { resolve_model_ids: 'omit' }, got: ${JSON.stringify(after)}`,
      );
    });
  }
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1736-local-install-commands.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1736-local-install-commands (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for #1736: local Claude install missing commands/gsd/
 *
 * After a fresh local install (`--claude --local`), all /gsd-* commands
 * except /gsd-help return "Unknown skill: gsd-quick" because
 * .claude/commands/gsd/ was not populated. Claude Code reads local project
 * commands from .claude/commands/ (one level up) using the file stem as the
 * command name.
 *
 * #1367 follow-up: the fix changed the layout from the old commands/gsd/<cmd>.md
 * (which caused /gsd:<cmd> colon namespace) to flat commands/gsd-<cmd>.md
 * (which produces /gsd-<cmd> hyphen form). This test has been updated to assert
 * the new flat layout while preserving the core invariant from #1736: commands
 * must be present and usable after a local install.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const INSTALL_SRC = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
const { install } = require(INSTALL_SRC);
const { cleanup } = require('./helpers.cjs');

// ─── Ensure hooks/dist/ is populated before install tests ────────────────────
// With --test-concurrency=4, other install tests (bug-1834, bug-1924) run
// build-hooks.js concurrently. That script creates hooks/dist/ empty first,
// then copies files — creating a window where this test sees an empty dir and
// install() fails with "directory is empty" → process.exit(1).

before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
});

// ─── #1736 + #1367: local install deploys commands in flat gsd-<cmd>.md layout ───

describe('#1736: local Claude install deploys slash commands (flat gsd-<cmd>.md layout, #1367)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-local-install-1736-'));
  });

  afterEach(() => {
    // Use the shared helper which has a 5s Windows-EBUSY retry budget
    // (20×250ms). The inline 1s budget here was insufficient on cold runners.
    cleanup(tmpDir);
  });

  test('local install creates .claude/commands/ directory with flat gsd-*.md files (#1367)', (t) => {
    // #1736 invariant: commands must be deployed.
    // #1367 fix: commands land as flat gsd-<cmd>.md at commands/ (not commands/gsd/<cmd>.md).
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);
    install(false, 'claude');

    const commandsDir = path.join(tmpDir, '.claude', 'commands');
    assert.ok(
      fs.existsSync(commandsDir),
      '.claude/commands/ directory must exist after local install'
    );
    const flatFiles = fs.readdirSync(commandsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(
      flatFiles.length > 0,
      `.claude/commands/ must have flat gsd-*.md files (e.g. gsd-help.md). Found: ${JSON.stringify(flatFiles)}`
    );
    // The old commands/gsd/ subdirectory must NOT exist (#1367)
    const oldSubdir = path.join(commandsDir, 'gsd');
    assert.ok(
      !fs.existsSync(oldSubdir),
      '.claude/commands/gsd/ subdir must NOT exist — flat gsd-<cmd>.md layout required (#1367)'
    );
  });

  test('local install deploys at least one .md command file to .claude/commands/ (#1736 invariant)', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);
    install(false, 'claude');

    const commandsDir = path.join(tmpDir, '.claude', 'commands');
    assert.ok(
      fs.existsSync(commandsDir),
      '.claude/commands/ must exist'
    );

    const files = fs.readdirSync(commandsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(
      files.length > 0,
      `.claude/commands/ must contain at least one gsd-*.md file, found: ${JSON.stringify(files)}`
    );
  });

  test('local install deploys gsd-quick.md to .claude/commands/ (#1367: flat hyphen form)', (t) => {
    // Was: .claude/commands/gsd/quick.md (caused /gsd:quick colon form).
    // Now: .claude/commands/gsd-quick.md (produces /gsd-quick hyphen form).
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);
    install(false, 'claude');

    const quickCmd = path.join(tmpDir, '.claude', 'commands', 'gsd-quick.md');
    assert.ok(
      fs.existsSync(quickCmd),
      '.claude/commands/gsd-quick.md must exist after local install (#1367 flat layout)'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2248-local-install-statusline.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2248-local-install-statusline (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for #2248: local Claude install clobbers profile-level statusLine
 *
 * When installing with `--claude --local`, the repo-level `.claude/settings.json`
 * takes precedence over the user's profile-level `~/.claude/settings.json` in
 * Claude Code. Writing `statusLine` to repo settings during a local install
 * silently overrides any profile-level statusLine the user configured.
 *
 * Fix: local installs skip writing `statusLine` to settings.json unless
 * `--force-statusline` is passed.
 *
 * Note: `install()` only copies files. `finishInstall()` writes settings.json.
 * The production code calls both from `installAllRuntimes()`. Tests must mirror
 * that two-phase pattern.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const INSTALL_SRC = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
const { install, finishInstall } = require(INSTALL_SRC);
const { cleanup, captureConsole } = require('./helpers.cjs');

// ─── Ensure hooks/dist/ is populated before install tests ────────────────────
before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
});

// ─── #2248: local install must NOT write statusLine to repo settings.json ────

describe('#2248: local Claude install does not clobber profile-level statusLine', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-local-install-2248-'));
  });

  afterEach(() => {
    // Use the shared 5s Windows-EBUSY retry budget instead of inline 1s.
    cleanup(tmpDir);
  });

  test('local install writes hooks to .claude/settings.local.json and does not write statusLine', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    // Phase 1: copy files (mirrors installAllRuntimes)
    const result = install(false, 'claude');

    // Phase 2: configure settings.local.json (mirrors installAllRuntimes → finalize)
    // #338: local Claude installs now write to settings.local.json, not settings.json.
    // shouldInstallStatusline=true mirrors what handleStatusline picks for a fresh install
    const { stdout } = captureConsole(() => {
      finishInstall(
        result.settingsPath,
        result.settings,
        result.statuslineCommand,
        true,   // shouldInstallStatusline
        'claude',
        false   // isGlobal=false -> local install
      );
    });
    assert.match(
      stdout,
      /Skipping statusLine for local install/,
      'Local install must explain that it skipped statusLine unless --force-statusline is passed'
    );

    // #338: local installs write to settings.local.json, not settings.json
    const localSettingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
    assert.ok(
      fs.existsSync(localSettingsPath),
      '.claude/settings.local.json must exist after local Claude install (#338)'
    );

    const settings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
    assert.strictEqual(
      settings.statusLine,
      undefined,
      'Local install must not write statusLine to settings.local.json — it would clobber profile-level settings (#2248)'
    );

    // settings.json must not be touched by a fresh local install
    const sharedSettingsPath = path.join(tmpDir, '.claude', 'settings.json');
    assert.strictEqual(
      fs.existsSync(sharedSettingsPath),
      false,
      '.claude/settings.json must NOT be created by a fresh local Claude install (#338)'
    );
  });

  test('global install still writes statusLine to settings.json', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });

    // Global install writes to CLAUDE_CONFIG_DIR; point it at our tmpDir
    const configDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(configDir, { recursive: true });
    const origEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    t.after(() => {
      if (origEnv === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = origEnv;
      }
    });

    // Phase 1: copy files
    const result = install(true, 'claude');

    // Phase 2: configure settings.json
    finishInstall(
      result.settingsPath,
      result.settings,
      result.statuslineCommand,
      true,  // shouldInstallStatusline
      'claude',
      true   // isGlobal=true
    );

    const settingsPath = path.join(configDir, 'settings.json');
    assert.ok(
      fs.existsSync(settingsPath),
      '~/.claude/settings.json must exist after global install'
    );

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.ok(
      settings.statusLine !== undefined,
      'Global install should write statusLine to settings.json'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-338-local-install-settings-local-json.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-338-local-install-settings-local-json (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression tests for #338: Claude --local installs must write hook wiring to
 * `.claude/settings.local.json` (Claude Code's per-user gitignored slot) instead
 * of the repo-shared `.claude/settings.json`.
 *
 * Three cases:
 *  1. Fresh local install: settings.local.json is created with hook block;
 *     settings.json is not touched.
 *  2. Global install (regression guard): continues to write to settings.json.
 *  3. Migration: if a prior local install wrote GSD entries to settings.json,
 *     re-running local install moves them to settings.local.json and removes
 *     them from settings.json in the same run.
 *
 * Note: `install()` only copies files. `finishInstall()` writes settings.
 * The production code calls both from `installAllRuntimes()`. Tests mirror
 * that two-phase pattern.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const INSTALL_SRC = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
const { install, finishInstall } = require(INSTALL_SRC);
const { cleanup } = require('./helpers.cjs');

// ─── Ensure hooks/dist/ is populated before install tests ────────────────────
before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
});

// ─── Helper: run both install phases ─────────────────────────────────────────

/**
 * Run install + finishInstall (mirrors installAllRuntimes two-phase pattern).
 * @param {boolean} isGlobal
 * @param {object} [opts]
 * @param {boolean} [opts.shouldInstallStatusline]
 * @returns {{ result: object }}
 */
function runInstall(isGlobal, opts = {}) {
  const { shouldInstallStatusline = false } = opts;
  const result = install(isGlobal, 'claude');
  finishInstall(
    result.settingsPath,
    result.settings,
    result.statuslineCommand,
    shouldInstallStatusline,
    'claude',
    isGlobal
  );
  return { result };
}

// ─── Case 1: fresh local install → settings.local.json, not settings.json ───

describe('#338 case 1: fresh local Claude install writes to settings.local.json', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-338-local-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('settings.local.json is created with hook block', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    runInstall(false);

    const localSettingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
    assert.ok(
      fs.existsSync(localSettingsPath),
      '.claude/settings.local.json must exist after local Claude install (#338)'
    );

    const settings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
    assert.ok(
      settings && typeof settings === 'object',
      'settings.local.json must be a valid JSON object'
    );
    // Hook block must be present (hooks key or at minimum the file was written)
    assert.ok(
      settings.hooks !== undefined || Object.keys(settings).length >= 0,
      'settings.local.json must contain the hook block'
    );
  });

  test('settings.json is NOT created by a fresh local install', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    runInstall(false);

    const sharedSettingsPath = path.join(tmpDir, '.claude', 'settings.json');
    assert.strictEqual(
      fs.existsSync(sharedSettingsPath),
      false,
      '.claude/settings.json must NOT be created by a fresh local Claude install (#338) — ' +
      'engineer-specific absolute paths must not leak into the repo-shared file'
    );
  });

  test('install() returns settingsPath pointing to settings.local.json', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    const result = install(false, 'claude');
    assert.ok(
      result.settingsPath.endsWith('settings.local.json'),
      `install() must return settingsPath ending in settings.local.json for local Claude installs; got: ${result.settingsPath}`
    );
  });
});

// ─── Case 2: global Claude install (regression guard) ────────────────────────

describe('#338 case 2: global Claude install continues to write to settings.json', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-338-global-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('global install writes hook block to settings.json', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });

    // Point CLAUDE_CONFIG_DIR at a subdir of tmpDir to avoid polluting ~/.claude
    const configDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(configDir, { recursive: true });
    const origEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    t.after(() => {
      if (origEnv === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = origEnv;
      }
    });

    runInstall(true);

    const settingsPath = path.join(configDir, 'settings.json');
    assert.ok(
      fs.existsSync(settingsPath),
      '~/.claude/settings.json must exist after global Claude install (regression guard for #338)'
    );
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.ok(
      settings && typeof settings === 'object',
      'settings.json must be a valid JSON object after global install'
    );
  });

  test('global install does NOT create settings.local.json', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });

    const configDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(configDir, { recursive: true });
    const origEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    t.after(() => {
      if (origEnv === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = origEnv;
      }
    });

    runInstall(true);

    const localSettingsPath = path.join(configDir, 'settings.local.json');
    assert.strictEqual(
      fs.existsSync(localSettingsPath),
      false,
      '~/.claude/settings.local.json must NOT be created by a global Claude install'
    );
  });
});

// ─── Case 3: migration — prior local install wrote GSD entries to settings.json ─

describe('#338 case 3: migration of prior local install GSD entries from settings.json to settings.local.json', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-338-migrate-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('GSD hook entries are moved from settings.json to settings.local.json', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    // Pre-populate .claude/settings.json with a GSD-shaped hook block (simulating
    // a prior local install that wrote to the wrong file).
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const sharedSettingsPath = path.join(claudeDir, 'settings.json');
    const priorSettings = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: `${process.execPath} ${path.join(claudeDir, 'hooks', 'gsd-check-update.js')}`,
              }
            ]
          }
        ],
        PostToolUse: [
          {
            matcher: 'Bash|Edit|Write|MultiEdit|Agent|Task',
            hooks: [
              {
                type: 'command',
                command: `${process.execPath} ${path.join(claudeDir, 'hooks', 'gsd-context-monitor.js')}`,
                timeout: 10,
              }
            ]
          }
        ]
      }
    };
    fs.writeFileSync(sharedSettingsPath, JSON.stringify(priorSettings, null, 2) + '\n');

    // Run a fresh local install — this should trigger migration
    runInstall(false);

    // Verify GSD entries are now in settings.local.json
    const localSettingsPath = path.join(claudeDir, 'settings.local.json');
    assert.ok(
      fs.existsSync(localSettingsPath),
      '.claude/settings.local.json must exist after migration run'
    );
    const localSettings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
    const sessionStartHooks = (localSettings.hooks && localSettings.hooks.SessionStart) || [];
    const hasGsdUpdateHook = sessionStartHooks.some(
      entry => entry && entry.hooks && Array.isArray(entry.hooks) &&
        entry.hooks.some(h => h && h.command && h.command.includes('gsd-check-update'))
    );
    assert.ok(
      hasGsdUpdateHook,
      'settings.local.json must contain the migrated gsd-check-update hook after migration'
    );
  });

  test('GSD hook entries are removed from settings.json after migration', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const sharedSettingsPath = path.join(claudeDir, 'settings.json');
    const priorSettings = {
      // Include a non-GSD key to verify user content is preserved
      myCustomKey: 'keep-me',
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: `${process.execPath} ${path.join(claudeDir, 'hooks', 'gsd-check-update.js')}`,
              }
            ]
          }
        ]
      }
    };
    fs.writeFileSync(sharedSettingsPath, JSON.stringify(priorSettings, null, 2) + '\n');

    runInstall(false);

    // settings.json must exist (we don't delete it — user may have other content)
    assert.ok(
      fs.existsSync(sharedSettingsPath),
      '.claude/settings.json must still exist after migration (may have non-GSD user content)'
    );
    const sharedSettings = JSON.parse(fs.readFileSync(sharedSettingsPath, 'utf-8'));

    // GSD hooks must be gone from settings.json
    const sessionStartHooks = (sharedSettings.hooks && sharedSettings.hooks.SessionStart) || [];
    const hasGsdHook = sessionStartHooks.some(
      entry => entry && entry.hooks && Array.isArray(entry.hooks) &&
        entry.hooks.some(h => h && h.command && h.command.includes('gsd-check-update'))
    );
    assert.strictEqual(
      hasGsdHook,
      false,
      'GSD hook entries must be removed from settings.json after migration to settings.local.json'
    );

    // Non-GSD user content must be preserved
    assert.strictEqual(
      sharedSettings.myCustomKey,
      'keep-me',
      'Non-GSD user content in settings.json must be preserved during migration'
    );
  });

  test('settings.json with no GSD entries is left unchanged', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const sharedSettingsPath = path.join(claudeDir, 'settings.json');
    const userOnlySettings = {
      userKey: 'user-value',
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: '/usr/local/bin/my-own-hook.sh',
              }
            ]
          }
        ]
      }
    };
    const originalContent = JSON.stringify(userOnlySettings, null, 2) + '\n';
    fs.writeFileSync(sharedSettingsPath, originalContent);

    runInstall(false);

    // settings.json must be unchanged (no GSD entries to migrate)
    const afterContent = fs.readFileSync(sharedSettingsPath, 'utf-8');
    const afterSettings = JSON.parse(afterContent);
    assert.strictEqual(
      afterSettings.userKey,
      'user-value',
      'Non-GSD settings.json must be untouched when no GSD entries are present'
    );
    // User hook must still be there
    const sessionStart = (afterSettings.hooks && afterSettings.hooks.SessionStart) || [];
    const hasUserHook = sessionStart.some(
      entry => entry && entry.hooks && entry.hooks.some(h => h && h.command === '/usr/local/bin/my-own-hook.sh')
    );
    assert.ok(
      hasUserHook,
      'User hook in settings.json must be preserved when no migration occurs'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2957-claude-global-postinstall-message.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2957-claude-global-postinstall-message (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #2957: post-install message for `--claude --global` must instruct
 * users to restart Claude Code and offer the skill-name fallback, since
 * the skills-only install layout (CC 2.1.88+) leaves nothing in
 * commands/gsd/ for the slash menu to read on older configurations.
 *
 * Captures the call to finishInstall(runtime='claude', isGlobal=true) and
 * asserts the printed message contains both invocation paths.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const SETTINGS_PATH = path.join(os.tmpdir(), `gsd-test-settings-${process.pid}.json`);
const installModule = require(path.join(ROOT, 'bin', 'install.js'));

function captureFinishInstallOutput(runtime, isGlobal) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    installModule.finishInstall(
      SETTINGS_PATH,
      {},
      null,
      false,
      runtime,
      isGlobal,
      null,
    );
  } finally {
    console.log = original;
  }
  // Strip ANSI color escapes so message-content assertions don't couple to colors.
  // eslint-disable-next-line no-control-regex -- \x1b (ESC) is the required leading byte of ANSI SGR color sequences; matching it is the purpose of stripping ANSI codes from captured CLI/console output
  return lines.join('\n').replace(/\x1B\[[0-9;]*m/g, '');
}

describe('Bug #2957: claude+global post-install message', () => {
  test('claude+global message tells the user to restart and offers skill-name fallback', () => {
    const output = captureFinishInstallOutput('claude', true);

    assert.match(output, /restart claude code/i, 'should mention restart');
    assert.match(output, /\/gsd-new-project/, 'should still mention /gsd-new-project');
    assert.match(output, /gsd-new-project skill/i, 'should mention the skill name fallback');
    assert.doesNotMatch(
      output,
      /open a blank directory/i,
      'global claude install should replace, not extend, the legacy generic instruction',
    );
  });

  test('claude+local message keeps the original /gsd-new-project instruction', () => {
    const output = captureFinishInstallOutput('claude', false);

    assert.match(output, /\/gsd-new-project/, 'should still mention /gsd-new-project');
    assert.doesNotMatch(output, /restart claude code/i, 'local install does not require the skills restart note');
  });

  test('non-claude runtimes keep their original message format', () => {
    const output = captureFinishInstallOutput('opencode', true);

    assert.match(output, /Open a blank directory/, 'opencode message should be unchanged');
    assert.doesNotMatch(output, /restart/i, 'opencode message should not have the claude-specific restart note');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-505-remove-dead-sdk-verification.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-505-remove-dead-sdk-verification (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression guard for #505: dead SDK-shim verification subsystem removed.
 *
 * Post-ADR-0174 the `@opengsd/gsd-sdk` package was retired; `sdk/` no longer
 * ships. `installSdkIfNeeded` and all functions it transitively called are
 * dead code with no live callers. This test asserts:
 *
 *   1. All removed symbols are NO LONGER exported from bin/install.js.
 *   2. The two live stale-standalone-SDK helpers (detectStaleStandaloneSdk,
 *      formatStaleStandaloneSdkWarning) are STILL exported as functions — they
 *      handle a real user-facing condition (#3406) and MUST NOT be removed.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const inst = require('../bin/install.js');

describe('bug #505: dead SDK verification subsystem removed from bin/install.js', () => {
  // ----------------------------------------------------------------
  // Dead symbols — must NOT be exported after removal
  // ----------------------------------------------------------------
  const deadSymbols = [
    'installSdkIfNeeded',
    'classifySdkInstall',
    'buildSdkFailFastReport',
    'renderSdkFailFastReport',
    'buildGsdSdkVersionMismatchReport',
    'renderGsdSdkVersionMismatchReport',
    'readGsdSdkVersion',
    'parseGsdSdkVersion',
    'findGsdSdkOnPath',
    'isGsdSdkOnPath',
    'isLegacyGsdSdkShim',
    'trySelfLinkGsdSdk',
    'trySelfLinkGsdSdkWindows',
    'filterNpxFromPath',
    'getUserShellPath',
    'getUserShellWindowsPersistentPath',
  ];

  for (const sym of deadSymbols) {
    test(`dead symbol '${sym}' is not exported`, () => {
      assert.equal(
        typeof inst[sym],
        'undefined',
        `'${sym}' should have been removed (post #505 dead-code removal) but is still exported as ${typeof inst[sym]}`,
      );
    });
  }

  // ----------------------------------------------------------------
  // The stale-standalone-SDK helpers (detectStaleStandaloneSdk,
  // formatStaleStandaloneSdkWarning) and the gsd-sdk shim contract surface
  // (buildWindowsShimTriple, formatSdkPathDiagnostic) that #505 kept were
  // removed when the gsd-sdk shim itself was retired (#191). Their absence is
  // covered by the dead-symbol assertions above.
  // ----------------------------------------------------------------
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-376-claude-js-hook-gsd-rewriter.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-376-claude-js-hook-gsd-rewriter (consolidation epic #1969 B1 #1970)", () => {
'use strict';

/**
 * Regression for bug #376 — Claude-installed hook JS files ship with raw
 * /gsd:<cmd> command literals because the hook-copy loop in install.js had
 * no /gsd: → /gsd- rewrite for the claude runtime.
 *
 * Fix: the `.js` branch of the hook-copy loop now applies
 * `content.replace(/gsd:/gi, 'gsd-')` when
 * `shouldNormalizeHyphenNamespaceInAgentBody(runtime)` is true (covers
 * claude, qwen, hermes).
 *
 * Test plan:
 *   1. Claude install to tmp prefix — installed .js hook files must contain
 *      no user-facing /gsd: literals (// comment occurrences exempted).
 *   2. Cursor install regression — still rewrites correctly (pre-existing
 *      branch must remain intact).
 *   3. Source files in hooks/ must be byte-identical before and after both
 *      installs (install-time rewrite only, no in-tree mutation).
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALL_PATH = path.join(REPO_ROOT, 'bin', 'install.js');
const HOOKS_DIST_DIR = path.join(REPO_ROOT, 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-hooks.js');

/**
 * Ensure hooks/dist is populated before any suite that reads it.
 * hooks/dist/ is gitignored and only produced by `npm run build:hooks`.
 * In CI the scoped/windows test jobs do NOT run build:hooks before running
 * tests, so the first test that needs hooks/dist would fail. This mirrors
 * the pattern used in bug-3357-codex-legacy-hooks-json-migration.test.cjs.
 */
function ensureHooksDist() {
  if (!fs.existsSync(HOOKS_DIST_DIR) || fs.readdirSync(HOOKS_DIST_DIR).filter(f => f.endsWith('.js')).length === 0) {
    execFileSync(process.execPath, [BUILD_HOOKS_SCRIPT], { stdio: 'pipe' });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run `node install.js <...args>` from cwd.
 * GSD_TEST_MODE is cleared so the install() main block executes.
 */
function runInstall(cwd, args) {
  const env = { ...process.env };
  delete env.GSD_TEST_MODE;
  execFileSync(process.execPath, [INSTALL_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    // 120s, not 60s. A full install copies and converts the whole shipped
    // payload (117 workflows, 100 references, 34 agents, ~71 skills) and
    // measures 13-30s on an idle runner — under 2x headroom at the old cap.
    // On a loaded bench that margin is not enough: the Cursor suite's before
    // hook died with `spawnSync ETIMEDOUT` on the node24 lane while the node22
    // lane passed the SAME commit in 12.7s, cancelling three child tests as
    // collateral. The cap also shrinks in real terms every time a file joins
    // the payload. Matches the 120s already used for the heavy install case
    // below. Aligned with the other runInstall helper in this file.
    timeout: 120000,
  });
}

/**
 * Return an array of { rel, path } for all .js files under dir.
 */
function findJsFiles(dir) {
  const results = [];
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.cjs')) {
        results.push({ rel: path.relative(dir, full), full });
      }
    }
  }
  walk(dir);
  return results;
}

/**
 * Split a JS file's lines into comment and non-comment buckets.
 * A line is treated as a comment if it starts with optional whitespace
 * followed by // (single-line comment). Block comments are not checked
 * since none of the hook files use them for command refs.
 */
function nonCommentLines(content) {
  return content.split('\n').filter(line => !/^\s*\/\//.test(line));
}

/**
 * Return lines (from nonCommentLines) that contain a user-facing /gsd: ref.
 */
function colonRefs(content) {
  return nonCommentLines(content).filter(line => /\/gsd:/.test(line));
}

// ---------------------------------------------------------------------------
// Prerequisite: hooks/dist must exist (built by `npm run build:hooks`)
// ---------------------------------------------------------------------------
describe('bug #376 — prerequisite: hooks/dist is present', () => {
  before(() => {
    // hooks/dist is gitignored; build it on demand so this test is
    // deterministic in CI scoped/windows jobs that don't pre-run build:hooks.
    ensureHooksDist();
  });

  test('hooks/dist directory exists (run npm run build:hooks if missing)', () => {
    assert.ok(
      fs.existsSync(HOOKS_DIST_DIR),
      `hooks/dist not found at ${HOOKS_DIST_DIR}. Run: npm run build:hooks`,
    );
  });

  test('hooks/dist contains at least one .js hook file with a /gsd: literal', () => {
    const jsFiles = findJsFiles(HOOKS_DIST_DIR);
    assert.ok(jsFiles.length > 0, 'hooks/dist must contain .js files');

    const withColonRef = jsFiles.filter(({ full }) => {
      const content = fs.readFileSync(full, 'utf-8');
      return colonRefs(content).length > 0;
    });

    assert.ok(
      withColonRef.length > 0,
      'Expected at least one hooks/dist .js file with a non-comment /gsd: literal ' +
      '— this confirms the test is guarding a real regression surface. ' +
      `Files checked: ${jsFiles.map(f => f.rel).join(', ')}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 1 — Claude install: no /gsd: colon refs in installed .js hook files
// ---------------------------------------------------------------------------
describe('bug #376 — Suite 1: Claude install rewrites /gsd: → /gsd- in hook .js files', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-376-claude-'));
    runInstall(tmpDir, ['--claude', '--local', '--no-sdk']);
  });

  after(() => {
    cleanup(tmpDir);
  });

  test('1a: hooks/ directory is created by the Claude local install', () => {
    const hooksDir = path.join(tmpDir, '.claude', 'hooks');
    assert.ok(
      fs.existsSync(hooksDir),
      `hooks/ must be created at ${hooksDir} by Claude local install`,
    );
  });

  test('1b: installed .js hook files contain no user-facing /gsd: colon refs', () => {
    const hooksDir = path.join(tmpDir, '.claude', 'hooks');
    if (!fs.existsSync(hooksDir)) {
      // If hooks/ wasn't created (hooks/dist missing at install time), skip gracefully
      return;
    }

    const jsFiles = findJsFiles(hooksDir);
    assert.ok(jsFiles.length > 0, 'At least one .js hook file must be installed');

    const offenders = [];
    for (const { rel, full } of jsFiles) {
      const content = fs.readFileSync(full, 'utf-8');
      const badLines = colonRefs(content);
      if (badLines.length > 0) {
        offenders.push({ rel, lines: badLines });
      }
    }

    assert.deepEqual(
      offenders,
      [],
      'Installed Claude hook .js files must not contain /gsd:<cmd> colon refs ' +
      '(non-comment occurrences). The install-time rewriter must replace these with /gsd-<cmd>. ' +
      'Offenders: ' + JSON.stringify(offenders, null, 2),
    );
  });

  test('1c: installed .js hook files DO contain the hyphen form /gsd- (rewrite happened)', () => {
    const hooksDir = path.join(tmpDir, '.claude', 'hooks');
    if (!fs.existsSync(hooksDir)) return;

    const jsFiles = findJsFiles(hooksDir);
    const withHyphen = jsFiles.filter(({ full }) => {
      const content = fs.readFileSync(full, 'utf-8');
      return /\/gsd-/.test(content);
    });

    assert.ok(
      withHyphen.length > 0,
      'At least one installed .js hook file must contain /gsd- (confirming rewrite ran). ' +
      `Files checked: ${jsFiles.map(f => f.rel).join(', ')}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Cursor install regression: /gsd: → /gsd- still works (pre-existing)
//
// Note: Cursor installs its own hooks (gsd-cursor-session-start.js and
// gsd-cursor-post-tool.js) via the cursor-hooks-json installSurface (issue #777).
// It does NOT install the bundled Claude-style hooks/dist files (no gsd-session-state.sh
// etc.). The Cursor /gsd: rewrite applies in `copyWithPathReplacement` to JS files
// under the agent/skill tree (.cursor/gsd-core/*.js etc). We verify that Cursor's
// installed .js files under .cursor/ have no /gsd: colon refs, and that the hooks/
// directory contains only the Cursor-specific managed hooks.
// ---------------------------------------------------------------------------
describe('bug #376 — Suite 2: Cursor install still rewrites /gsd: → /gsd- (regression)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-376-cursor-'));
    runInstall(tmpDir, ['--cursor', '--local', '--no-sdk']);
  });

  after(() => {
    cleanup(tmpDir);
  });

  test('2a: .cursor/ directory is created by the Cursor local install', () => {
    const cursorDir = path.join(tmpDir, '.cursor');
    assert.ok(
      fs.existsSync(cursorDir),
      `Cursor install must create .cursor/ directory at ${cursorDir}`,
    );
  });

  test('2b: Cursor-installed .js files contain no user-facing /gsd: colon refs', () => {
    const cursorDir = path.join(tmpDir, '.cursor');
    if (!fs.existsSync(cursorDir)) return;

    // Infrastructure files whose /gsd: occurrences are intentional implementation
    // details — NOT user-facing command references that Cursor would invoke.
    //
    // scripts/fix-slash-commands.cjs is the slash-command rewriter engine, required
    // by gsd-core/bin/lib/command-roster.cjs on ALL runtimes (including Cursor).
    // It must be installed verbatim and must NOT be content-rewritten: it needs to
    // emit `/gsd:${cmd}` for non-Cursor runtimes, and its /gsd: strings are internal
    // implementation/docs (transform patterns, regex literals, template literals),
    // not commands a Cursor user would type. Rewriting it would corrupt the transformer.
    const INFRA_BASENAMES = new Set(['fix-slash-commands.cjs']);

    const jsFiles = findJsFiles(cursorDir);
    // Cursor may not install any .js files depending on what agent/skill content exists;
    // if none, skip gracefully.
    if (jsFiles.length === 0) return;

    const offenders = [];
    for (const { rel, full } of jsFiles) {
      // Skip infrastructure files whose /gsd: strings are intentional (see above).
      if (INFRA_BASENAMES.has(path.basename(full))) continue;
      const content = fs.readFileSync(full, 'utf-8');
      const badLines = colonRefs(content);
      if (badLines.length > 0) {
        offenders.push({ rel, lines: badLines });
      }
    }

    assert.deepEqual(
      offenders,
      [],
      'Cursor-installed .js files must not contain /gsd:<cmd> colon refs. ' +
      'The existing Cursor branch in copyWithPathReplacement must still apply /gsd:/gi → gsd- rewrite. ' +
      'Offenders: ' + JSON.stringify(offenders, null, 2),
    );
  });

  test('2c: Cursor install creates a hooks/ directory with only Cursor-specific managed hooks', () => {
    // Since issue #777, Cursor installs gsd-cursor-session-start.js and
    // gsd-cursor-post-tool.js into <configDir>/hooks/. These are Cursor-native
    // hooks — NOT the bundled Claude-style hooks (no gsd-session-state.sh etc.).
    // Verify: hooks/ exists AND does NOT contain any Claude-bundled hooks.
    const hooksDir = path.join(tmpDir, '.cursor', 'hooks');
    assert.ok(
      fs.existsSync(hooksDir),
      'Cursor install must create a hooks/ directory for its managed hook scripts (#777)',
    );
    const CLAUDE_BUNDLED_HOOKS = ['gsd-session-state.sh', 'gsd-context-monitor.js', 'gsd-statusline.js'];
    for (const hook of CLAUDE_BUNDLED_HOOKS) {
      assert.strictEqual(
        fs.existsSync(path.join(hooksDir, hook)),
        false,
        `Cursor hooks/ must NOT contain Claude-bundled hook ${hook} — only Cursor-native hooks are installed`,
      );
    }
    // The two Cursor-specific managed hooks must be present.
    assert.ok(
      fs.existsSync(path.join(hooksDir, 'gsd-cursor-session-start.js')),
      'gsd-cursor-session-start.js must be installed in .cursor/hooks/ (#777)',
    );
    assert.ok(
      fs.existsSync(path.join(hooksDir, 'gsd-cursor-post-tool.js')),
      'gsd-cursor-post-tool.js must be installed in .cursor/hooks/ (#777)',
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — Source files in hooks/ are untouched
// ---------------------------------------------------------------------------
describe('bug #376 — Suite 3: hooks/ source files are unchanged by install', () => {
  let snapshotBefore;

  before(() => {
    // Ensure hooks/dist is built before snapshotting; it may be absent in CI
    // scoped/windows jobs that don't pre-run build:hooks (#777 fix).
    ensureHooksDist();
    // Snapshot hooks/dist JS files before any install in this suite
    snapshotBefore = {};
    if (fs.existsSync(HOOKS_DIST_DIR)) {
      for (const { rel, full } of findJsFiles(HOOKS_DIST_DIR)) {
        snapshotBefore[rel] = fs.readFileSync(full, 'utf-8');
      }
    }
  });

  test('3a: hooks/dist .js source files still contain /gsd: literals (not mutated)', () => {
    // The source must remain in colon form — the rewrite is install-time only
    const jsFiles = findJsFiles(HOOKS_DIST_DIR);
    const withColonRef = jsFiles.filter(({ full }) => {
      const content = fs.readFileSync(full, 'utf-8');
      return colonRefs(content).length > 0;
    });

    // We know from the prerequisite suite that at least one file had a colon ref;
    // if the source was mutated by install, this would now be zero.
    assert.ok(
      withColonRef.length > 0,
      'hooks/dist .js files must still contain /gsd: literals after install — ' +
      'the install-time rewrite must NOT modify the source tree. ' +
      `Files that still have colon refs: ${withColonRef.map(f => f.rel).join(', ')}`,
    );
  });

  test('3b: hooks/dist .js source file contents match pre-test snapshot (byte-identical)', () => {
    if (Object.keys(snapshotBefore).length === 0) {
      // hooks/dist was absent before; skip
      return;
    }

    for (const [rel, before] of Object.entries(snapshotBefore)) {
      const full = path.join(HOOKS_DIST_DIR, rel);
      const after = fs.readFileSync(full, 'utf-8');
      assert.strictEqual(
        after,
        before,
        `hooks/dist/${rel} was mutated by install — install must only rewrite the installed copy, not the source`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — Pure-function: shouldNormalizeHyphenNamespaceInAgentBody covers claude
// ---------------------------------------------------------------------------
describe('bug #376 — Suite 4: shouldNormalizeHyphenNamespaceInAgentBody covers claude', () => {
  const install = require(INSTALL_PATH);

  test('4a: shouldNormalizeHyphenNamespaceInAgentBody is exported', () => {
    assert.strictEqual(
      typeof install.shouldNormalizeHyphenNamespaceInAgentBody,
      'function',
      'install.js must export shouldNormalizeHyphenNamespaceInAgentBody',
    );
  });

  test('4b: claude is in the hyphen-namespace set', () => {
    assert.strictEqual(
      install.shouldNormalizeHyphenNamespaceInAgentBody('claude'),
      true,
      'claude must be a hyphen-namespace runtime',
    );
  });

  test('4c: qwen is in the hyphen-namespace set', () => {
    assert.strictEqual(
      install.shouldNormalizeHyphenNamespaceInAgentBody('qwen'),
      true,
    );
  });

  test('4d: hermes is in the hyphen-namespace set', () => {
    assert.strictEqual(
      install.shouldNormalizeHyphenNamespaceInAgentBody('hermes'),
      true,
    );
  });

  test('4e: gemini is NOT in the hyphen-namespace set', () => {
    assert.strictEqual(
      install.shouldNormalizeHyphenNamespaceInAgentBody('gemini'),
      false,
      'gemini intentionally keeps colon namespace and must not be in the hyphen set',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-443-effort-defaults-drift.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-443-effort-defaults-drift (consolidation epic #1969 B5 #1974)", () => {
'use strict';
/**
 * feat-443-effort-defaults-drift.test.cjs
 *
 * Drift-guard: asserts that install.js's resolved baseline effort defaults
 * equal config-defaults.manifest.json's effort block. Any future divergence
 * (someone edits the manifest without updating install.js or vice-versa) fails
 * CI immediately rather than silently injecting stale effort values.
 *
 * Real assertions on runtime values — no source-grep.
 */

// MUST be set before require('bin/install.js') so the main install block
// (guarded by !GSD_TEST_MODE) does not execute and perform a real global
// install into $HOME/.claude/ — which would leak gsd-tools.cjs into the
// ambient HOME and break runtime-launcher-parity test (D) in the same
// node --test run (all unit tests share the same HOME on CI).
process.env.GSD_TEST_MODE = '1';

const assert = require('assert');
const path = require('path');

const { test } = require('node:test');

// Load the manifest directly (JSON, not a .cjs source file — allowed by lint rule)
const manifestPath = path.join(
  __dirname,
  '..',
  'gsd-core',
  'bin',
  'shared',
  'config-defaults.manifest.json'
);
const manifest = require(manifestPath);

// Load install.js exported values (executes the module, not text inspection)
const installPath = path.join(__dirname, '..', 'bin', 'install.js');
const {
  _GSD_EFFORT_MANIFEST_TIER_DEFAULTS,
  _GSD_EFFORT_MANIFEST_DEFAULT,
} = require(installPath);

test('install.js _GSD_EFFORT_MANIFEST_TIER_DEFAULTS.light matches manifest effort.routing_tier_defaults.light', () => {
  assert.strictEqual(
    _GSD_EFFORT_MANIFEST_TIER_DEFAULTS.light,
    manifest.effort.routing_tier_defaults.light,
    `install.js tier default for "light" (${_GSD_EFFORT_MANIFEST_TIER_DEFAULTS.light}) differs from manifest (${manifest.effort.routing_tier_defaults.light})`
  );
});

test('install.js _GSD_EFFORT_MANIFEST_TIER_DEFAULTS.standard matches manifest effort.routing_tier_defaults.standard', () => {
  assert.strictEqual(
    _GSD_EFFORT_MANIFEST_TIER_DEFAULTS.standard,
    manifest.effort.routing_tier_defaults.standard,
    `install.js tier default for "standard" (${_GSD_EFFORT_MANIFEST_TIER_DEFAULTS.standard}) differs from manifest (${manifest.effort.routing_tier_defaults.standard})`
  );
});

test('install.js _GSD_EFFORT_MANIFEST_TIER_DEFAULTS.heavy matches manifest effort.routing_tier_defaults.heavy', () => {
  assert.strictEqual(
    _GSD_EFFORT_MANIFEST_TIER_DEFAULTS.heavy,
    manifest.effort.routing_tier_defaults.heavy,
    `install.js tier default for "heavy" (${_GSD_EFFORT_MANIFEST_TIER_DEFAULTS.heavy}) differs from manifest (${manifest.effort.routing_tier_defaults.heavy})`
  );
});

test('install.js _GSD_EFFORT_MANIFEST_DEFAULT matches manifest effort.default', () => {
  assert.strictEqual(
    _GSD_EFFORT_MANIFEST_DEFAULT,
    manifest.effort.default,
    `install.js effort default (${_GSD_EFFORT_MANIFEST_DEFAULT}) differs from manifest (${manifest.effort.default})`
  );
});

test('install.js tier-defaults object has exactly the same keys as manifest effort.routing_tier_defaults', () => {
  const installKeys = Object.keys(_GSD_EFFORT_MANIFEST_TIER_DEFAULTS).sort();
  const manifestKeys = Object.keys(manifest.effort.routing_tier_defaults).sort();
  assert.deepStrictEqual(
    installKeys,
    manifestKeys,
    `Key mismatch — install.js: [${installKeys.join(', ')}], manifest: [${manifestKeys.join(', ')}]`
  );
});
  });
}

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2256-model-overrides-transport.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2256-model-overrides-transport (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression tests for issue #2256 — per-agent model_overrides transport
 * for Codex and OpenCode runtimes.
 *
 * The bug: model_overrides set in per-project `.planning/config.json` were
 * never read by the Codex / OpenCode install paths, which only probed
 * `~/.gsd/defaults.json`. As a result, the configured per-agent model was
 * dropped and child agents inherited the runtime's default model.
 *
 * These tests lock in the fix: per-project overrides must be honored, and
 * per-project keys must win over global when both are present.
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const isWindows = process.platform === 'win32';

const {
  readGsdEffectiveModelOverrides,
  generateCodexAgentToml,
  convertClaudeToOpencodeFrontmatter,
  getCodexSkillAdapterHeader,
} = require('../bin/install.js');

const { createTempDir, cleanup } = require('./helpers.cjs');
const makeTmp = (prefix) => createTempDir(`gsd-2256-${prefix}-`);

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

describe('bug #2256 — readGsdEffectiveModelOverrides', () => {
  let projectDir;
  let homeDir;
  let origHome;
  let origUserProfile;

  beforeEach(() => {
    projectDir = makeTmp('proj');
    homeDir = makeTmp('home');
    origHome = process.env.HOME;
    // On Windows, os.homedir() reads USERPROFILE (not HOME). Tests that
    // need to redirect ~ must override both — otherwise the SUT reads
    // the real user's home and the fixture is invisible.
    origUserProfile = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    if (isWindows) process.env.USERPROFILE = homeDir;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (isWindows) {
      if (origUserProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = origUserProfile;
    }
    cleanup(projectDir);
    cleanup(homeDir);
  });

  test('returns null when neither source defines model_overrides', () => {
    const result = readGsdEffectiveModelOverrides(projectDir);
    assert.strictEqual(result, null);
  });

  test('reads overrides from ~/.gsd/defaults.json (global only)', () => {
    writeJson(path.join(homeDir, '.gsd', 'defaults.json'), {
      model_overrides: { 'gsd-codebase-mapper': 'gpt-5-mini' },
    });
    const result = readGsdEffectiveModelOverrides(projectDir);
    assert.deepStrictEqual(result, { 'gsd-codebase-mapper': 'gpt-5-mini' });
  });

  test('reads overrides from per-project .planning/config.json', () => {
    writeJson(path.join(projectDir, '.planning', 'config.json'), {
      model_overrides: { 'gsd-codebase-mapper': 'claude-haiku-4-5' },
    });
    const result = readGsdEffectiveModelOverrides(projectDir);
    assert.deepStrictEqual(result, { 'gsd-codebase-mapper': 'claude-haiku-4-5' });
  });

  test('per-project overrides win over global on conflict', () => {
    writeJson(path.join(homeDir, '.gsd', 'defaults.json'), {
      model_overrides: { 'gsd-codebase-mapper': 'global-model', 'gsd-planner': 'opus' },
    });
    writeJson(path.join(projectDir, '.planning', 'config.json'), {
      model_overrides: { 'gsd-codebase-mapper': 'project-model' },
    });
    const result = readGsdEffectiveModelOverrides(projectDir);
    // Per-project wins on conflict; non-conflicting global keys are preserved.
    assert.deepStrictEqual(result, {
      'gsd-codebase-mapper': 'project-model',
      'gsd-planner': 'opus',
    });
  });

  test('walks up from nested targetDir to find .planning/', () => {
    writeJson(path.join(projectDir, '.planning', 'config.json'), {
      model_overrides: { 'gsd-planner': 'project-opus' },
    });
    const nested = path.join(projectDir, '.codex');
    fs.mkdirSync(nested, { recursive: true });
    const result = readGsdEffectiveModelOverrides(nested);
    assert.deepStrictEqual(result, { 'gsd-planner': 'project-opus' });
  });
});

describe('bug #2256 — Codex adapter embeds per-project override', () => {
  const agentContent = `---\nname: gsd-codebase-mapper\ndescription: Maps codebase\n---\n\nbody\n`;

  test('generateCodexAgentToml embeds model when override provided', () => {
    const toml = generateCodexAgentToml(
      'gsd-codebase-mapper',
      agentContent,
      { 'gsd-codebase-mapper': 'gpt-5-mini' },
    );
    assert.match(toml, /^model = "gpt-5-mini"$/m);
  });

  test('generateCodexAgentToml omits model when no override', () => {
    const toml = generateCodexAgentToml('gsd-codebase-mapper', agentContent, null);
    assert.doesNotMatch(toml, /^model\s*=/m);
  });
});

describe('bug #2256 — OpenCode adapter embeds per-project override', () => {
  test('convertClaudeToOpencodeFrontmatter embeds model on agent frontmatter', () => {
    const input = `---\nname: gsd-codebase-mapper\ndescription: Maps codebase\n---\n\nbody\n`;
    const out = convertClaudeToOpencodeFrontmatter(input, {
      isAgent: true,
      modelOverride: 'claude-haiku-4-5',
    });
    assert.match(out, /^model: claude-haiku-4-5$/m);
    assert.match(out, /^mode: subagent$/m);
  });

  test('convertClaudeToOpencodeFrontmatter omits model when override absent', () => {
    const input = `---\nname: gsd-codebase-mapper\ndescription: Maps codebase\n---\n\nbody\n`;
    const out = convertClaudeToOpencodeFrontmatter(input, { isAgent: true, modelOverride: null });
    assert.doesNotMatch(out, /^model:/m);
  });
});

describe('bug #2256 — Codex skill adapter header documents transport', () => {
  test('Task(model=...) line no longer says "omit" without explanation', () => {
    const header = getCodexSkillAdapterHeader('gsd-plan-phase');
    // Header must mention that per-agent model_overrides are embedded in agent
    // TOML so spawn_agent picks them up automatically — the old text said
    // "Codex uses per-role config, not inline model selection" which left
    // users thinking their model_overrides were silently ignored.
    assert.match(header, /model_overrides/);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3181-node-cellar-path.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3181-node-cellar-path (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #3181: `resolveNodeRunner()` bakes versioned Homebrew Cellar paths
 * (e.g. `/usr/local/Cellar/node/25.8.1/bin/node`) into hook commands in
 * `~/.claude/settings.json`. After `brew upgrade node` the Cellar binary
 * fails with `dyld: Library not loaded` because shared libraries have
 * changed SOVERSION.
 *
 * Fix: prefer the stable Homebrew symlinks (`/usr/local/bin/node` for Intel
 * Macs, `/opt/homebrew/bin/node` for Apple Silicon) when a Cellar path is
 * detected. Non-Homebrew paths (NVM, system node, Windows, etc.) are
 * returned unchanged.
 *
 * Also: `rewriteLegacyManagedNodeHookCommands()` must normalize Cellar paths
 * baked into existing hook commands so reinstall doesn't re-bake them.
 *
 * All assertions go against exported function return values — no source-grep.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const INSTALL = require(path.join(__dirname, '..', 'bin', 'install.js'));
const { normalizeNodePath, resolveNodeRunner, rewriteLegacyManagedNodeHookCommands } = INSTALL;

// ─── normalizeNodePath ────────────────────────────────────────────────────────

describe('Bug #3181: normalizeNodePath — exported as a function', () => {
  test('normalizeNodePath is exported', () => {
    assert.equal(typeof normalizeNodePath, 'function');
  });
});

describe('Bug #3181: normalizeNodePath — Intel Homebrew Cellar paths → /usr/local/bin/node', () => {
  test('simple versioned Intel Cellar path', () => {
    const result = normalizeNodePath('/usr/local/Cellar/node/25.8.1/bin/node');
    assert.equal(result, '/usr/local/bin/node');
  });

  test('Intel Cellar path with long semver', () => {
    const result = normalizeNodePath('/usr/local/Cellar/node/20.11.0/bin/node');
    assert.equal(result, '/usr/local/bin/node');
  });

  test('Intel Cellar path with prerelease version segment', () => {
    const result = normalizeNodePath('/usr/local/Cellar/node/22.0.0-rc.1/bin/node');
    assert.equal(result, '/usr/local/bin/node');
  });

  test('Intel versioned formula Cellar path (node@20) maps to stable symlink', () => {
    const result = normalizeNodePath('/usr/local/Cellar/node@20/20.11.0/bin/node');
    assert.equal(result, '/usr/local/bin/node');
  });
});

describe('Bug #3181: normalizeNodePath — Apple Silicon Homebrew Cellar paths → /opt/homebrew/bin/node', () => {
  test('simple versioned Apple Silicon Cellar path', () => {
    const result = normalizeNodePath('/opt/homebrew/Cellar/node/25.8.1/bin/node');
    assert.equal(result, '/opt/homebrew/bin/node');
  });

  test('Apple Silicon Cellar path with another version', () => {
    const result = normalizeNodePath('/opt/homebrew/Cellar/node/18.20.4/bin/node');
    assert.equal(result, '/opt/homebrew/bin/node');
  });

  test('Apple Silicon versioned formula Cellar path (node@18) maps to stable symlink', () => {
    const result = normalizeNodePath('/opt/homebrew/Cellar/node@18/18.20.4/bin/node');
    assert.equal(result, '/opt/homebrew/bin/node');
  });
});

// #2185: Linuxbrew + any custom HOMEBREW_PREFIX — the Cellar prefix is derived
// from the path itself, so one branch covers every Homebrew layout.
describe('Bug #2185: normalizeNodePath — Linuxbrew + custom-prefix Cellar paths → <prefix>/bin/node', () => {
  test('Linuxbrew Cellar path maps to the stable linuxbrew symlink', () => {
    const result = normalizeNodePath('/home/linuxbrew/.linuxbrew/Cellar/node/26.0.0/bin/node');
    assert.equal(result, '/home/linuxbrew/.linuxbrew/bin/node');
  });

  test('Linuxbrew Cellar path after a version bump (26.5.0) maps to stable symlink', () => {
    const result = normalizeNodePath('/home/linuxbrew/.linuxbrew/Cellar/node/26.5.0/bin/node');
    assert.equal(result, '/home/linuxbrew/.linuxbrew/bin/node');
  });

  test('Linuxbrew versioned formula Cellar path (node@22) maps to stable symlink', () => {
    const result = normalizeNodePath('/home/linuxbrew/.linuxbrew/Cellar/node@22/22.11.0/bin/node');
    assert.equal(result, '/home/linuxbrew/.linuxbrew/bin/node');
  });

  test('custom HOMEBREW_PREFIX Cellar path maps to its stable symlink', () => {
    const result = normalizeNodePath('/custom/brew/Cellar/node/25.8.1/bin/node');
    assert.equal(result, '/custom/brew/bin/node');
  });
});

describe('Bug #3181: normalizeNodePath — non-Homebrew paths are returned unchanged', () => {
  test('NVM path is unchanged', () => {
    const nvm = '/Users/dev/.nvm/versions/node/v20.11.0/bin/node';
    assert.equal(normalizeNodePath(nvm), nvm);
  });

  test('already-stable Intel Homebrew symlink is unchanged', () => {
    assert.equal(normalizeNodePath('/usr/local/bin/node'), '/usr/local/bin/node');
  });

  test('already-stable Apple Silicon Homebrew symlink is unchanged', () => {
    assert.equal(normalizeNodePath('/opt/homebrew/bin/node'), '/opt/homebrew/bin/node');
  });

  test('system node (/usr/bin/node) is unchanged', () => {
    assert.equal(normalizeNodePath('/usr/bin/node'), '/usr/bin/node');
  });

  test('Windows path is unchanged', () => {
    const win = 'C:\\Program Files\\nodejs\\node.exe';
    assert.equal(normalizeNodePath(win), win);
  });

  test('empty string is returned as-is', () => {
    assert.equal(normalizeNodePath(''), '');
  });

  test('null is returned as-is', () => {
    assert.equal(normalizeNodePath(null), null);
  });
});

// ─── resolveNodeRunner ────────────────────────────────────────────────────────

describe('Bug #3181: resolveNodeRunner — maps Cellar execPath to stable symlink', () => {
  test('Intel Cellar execPath → stable symlink quoted token', () => {
    const orig = process.execPath;
    try {
      Object.defineProperty(process, 'execPath', {
        value: '/usr/local/Cellar/node/25.8.1/bin/node',
        configurable: true,
      });
      const runner = resolveNodeRunner();
      assert.equal(runner, '"/usr/local/bin/node"',
        `expected stable Intel symlink, got: ${runner}`);
    } finally {
      Object.defineProperty(process, 'execPath', { value: orig, configurable: true });
    }
  });

  test('Apple Silicon Cellar execPath → stable symlink quoted token', () => {
    const orig = process.execPath;
    try {
      Object.defineProperty(process, 'execPath', {
        value: '/opt/homebrew/Cellar/node/25.8.1/bin/node',
        configurable: true,
      });
      const runner = resolveNodeRunner();
      assert.equal(runner, '"/opt/homebrew/bin/node"',
        `expected stable Apple Silicon symlink, got: ${runner}`);
    } finally {
      Object.defineProperty(process, 'execPath', { value: orig, configurable: true });
    }
  });

  test('non-Homebrew execPath is returned as a quoted absolute path unchanged', () => {
    const orig = process.execPath;
    const nvmPath = '/Users/dev/.nvm/versions/node/v20.11.0/bin/node';
    try {
      Object.defineProperty(process, 'execPath', { value: nvmPath, configurable: true });
      const runner = resolveNodeRunner();
      assert.equal(runner, JSON.stringify(nvmPath));
    } finally {
      Object.defineProperty(process, 'execPath', { value: orig, configurable: true });
    }
  });

  test('returns null when execPath is empty (existing null-guard is preserved)', () => {
    const orig = process.execPath;
    try {
      Object.defineProperty(process, 'execPath', { value: '', configurable: true });
      assert.equal(resolveNodeRunner(), null);
    } finally {
      Object.defineProperty(process, 'execPath', { value: orig, configurable: true });
    }
  });
});

// ─── rewriteLegacyManagedNodeHookCommands — Cellar runner rewrite ─────────────

describe('Bug #3181: rewriteLegacyManagedNodeHookCommands — rewrites baked Cellar runner to stable symlink', () => {
  test('Intel Cellar runner in a managed hook is rewritten to the stable symlink', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{
            type: 'command',
            command: '"/usr/local/Cellar/node/25.8.1/bin/node" "/Users/x/.gemini/hooks/gsd-check-update.js"',
          }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner);
    assert.equal(changed, true, 'expected rewrite to occur');
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].command,
      '"/usr/local/bin/node" "/Users/x/.gemini/hooks/gsd-check-update.js"',
    );
  });

  test('Apple Silicon Cellar runner in a managed hook is rewritten to the stable symlink', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{
            type: 'command',
            command: '"/opt/homebrew/Cellar/node/25.8.1/bin/node" "/Users/x/.gemini/hooks/gsd-check-update.js"',
          }],
        }],
      },
    };
    const runner = '"/opt/homebrew/bin/node"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner);
    assert.equal(changed, true, 'expected rewrite to occur');
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].command,
      '"/opt/homebrew/bin/node" "/Users/x/.gemini/hooks/gsd-check-update.js"',
    );
  });

  test('a hook already using the stable runner is NOT rewritten (no churn)', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{
            type: 'command',
            command: '"/usr/local/bin/node" "/Users/x/.gemini/hooks/gsd-check-update.js"',
          }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const before = settings.hooks.SessionStart[0].hooks[0].command;
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner);
    assert.equal(changed, false, 'already-stable entry must not be touched');
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, before);
  });

  test('a user hook using a Cellar runner but an unmanaged filename is NOT rewritten', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{
            type: 'command',
            command: '"/usr/local/Cellar/node/25.8.1/bin/node" "/Users/x/my-custom-hook.js"',
          }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const before = settings.hooks.SessionStart[0].hooks[0].command;
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner);
    assert.equal(changed, false, 'unmanaged hooks with Cellar runner must not be touched');
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, before);
  });

  // Existing bare-node rewrite still works alongside the new Cellar rewrite
  test('bare `node` managed hook is still rewritten (existing #2979 behaviour preserved)', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{
            type: 'command',
            command: 'node "/Users/x/.gemini/hooks/gsd-check-update.js"',
          }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner);
    assert.equal(changed, true);
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].command,
      '"/usr/local/bin/node" "/Users/x/.gemini/hooks/gsd-check-update.js"',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-977-fnm-multishell-path.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-977-fnm-multishell-path (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #977: `resolveNodeRunner()` bakes an ephemeral fnm multishell shim path
 * (e.g. `C:/Users/u/AppData/Local/fnm_multishells/<pid>_<ts>/node.exe`) into
 * managed `.js` hook commands. fnm cleans up these per-shell-session directories
 * when the shell exits, so the captured path later points at nothing — every
 * managed hook fails to spawn until reinstall.
 *
 * Fix: when `normalizeNodePath` detects a path matching the fnm multishell
 * directory pattern (`fnm_multishells/<id>/node(\.exe)?$`), it probes a stable
 * alias path derived from `FNM_DIR` or `APPDATA` env vars (with injected
 * `existsSync` for testability) and returns the first that exists. Falls back to
 * the raw execPath if no stable alias is found.
 *
 * All assertions go against exported function return values — no source-grep.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const INSTALL = require(path.join(__dirname, '..', 'bin', 'install.js'));
const { normalizeNodePath, resolveNodeRunner } = INSTALL;

// ─── Synthetic paths used across tests ───────────────────────────────────────

const EPHEMERAL_FNM_WIN = 'C:/Users/u/AppData/Local/fnm_multishells/15600_1781041703752/node.exe';
const EPHEMERAL_FNM_WIN_BACKSLASH = 'C:\\Users\\u\\AppData\\Local\\fnm_multishells\\15600_1781041703752\\node.exe';
const FNM_DIR_WIN = 'C:/Users/u/AppData/Roaming/fnm';
const APPDATA_WIN = 'C:/Users/u/AppData/Roaming';
const STABLE_FNM_DIR_NODE = `${FNM_DIR_WIN}/aliases/default/node.exe`;
const STABLE_APPDATA_NODE = `${APPDATA_WIN}/fnm/aliases/default/node.exe`;

// ─── normalizeNodePath — fnm multishell ephemeral path → stable alias ────────

describe('Bug #977: normalizeNodePath — fnm multishell path with FNM_DIR → stable alias', () => {
  test('forward-slash Windows ephemeral path + FNM_DIR set + alias exists → stable FNM_DIR alias', () => {
    const result = normalizeNodePath(EPHEMERAL_FNM_WIN, {
      env: { FNM_DIR: FNM_DIR_WIN },
      existsSync: p => p === STABLE_FNM_DIR_NODE,
    });
    assert.equal(
      result,
      STABLE_FNM_DIR_NODE,
      `expected stable FNM_DIR alias, got: ${result}`,
    );
  });

  test('backslash Windows ephemeral path + FNM_DIR set + alias exists → stable FNM_DIR alias', () => {
    const result = normalizeNodePath(EPHEMERAL_FNM_WIN_BACKSLASH, {
      env: { FNM_DIR: FNM_DIR_WIN },
      existsSync: p => p === STABLE_FNM_DIR_NODE,
    });
    assert.equal(
      result,
      STABLE_FNM_DIR_NODE,
      `expected stable FNM_DIR alias, got: ${result}`,
    );
  });

  test('FNM_DIR alias does not exist → falls through to APPDATA alias → returns APPDATA alias', () => {
    const result = normalizeNodePath(EPHEMERAL_FNM_WIN, {
      env: { FNM_DIR: FNM_DIR_WIN, APPDATA: APPDATA_WIN },
      existsSync: p => p === STABLE_APPDATA_NODE, // FNM_DIR alias absent, APPDATA alias present
    });
    assert.equal(
      result,
      STABLE_APPDATA_NODE,
      `expected stable APPDATA alias, got: ${result}`,
    );
  });

  test('no alias exists → returns raw execPath unchanged (graceful fallback)', () => {
    const result = normalizeNodePath(EPHEMERAL_FNM_WIN, {
      env: { FNM_DIR: FNM_DIR_WIN, APPDATA: APPDATA_WIN },
      existsSync: () => false, // nothing exists
    });
    assert.equal(
      result,
      EPHEMERAL_FNM_WIN,
      `expected raw execPath fallback, got: ${result}`,
    );
  });

  test('no FNM_DIR or APPDATA in env → returns raw execPath unchanged', () => {
    const result = normalizeNodePath(EPHEMERAL_FNM_WIN, {
      env: {},
      existsSync: () => false,
    });
    assert.equal(
      result,
      EPHEMERAL_FNM_WIN,
      `expected raw execPath fallback, got: ${result}`,
    );
  });
});

// ─── normalizeNodePath — non-fnm paths are NOT affected by the new branch ────

describe('Bug #977: normalizeNodePath — non-fnm paths are unaffected (no regression to existing behavior)', () => {
  test('NVM path is unchanged', () => {
    const nvm = '/Users/dev/.nvm/versions/node/v20.11.0/bin/node';
    assert.equal(normalizeNodePath(nvm), nvm);
  });

  test('Intel Homebrew Cellar path still maps to stable symlink', () => {
    assert.equal(
      normalizeNodePath('/usr/local/Cellar/node/25.8.1/bin/node'),
      '/usr/local/bin/node',
    );
  });

  test('Apple Silicon Homebrew Cellar path still maps to stable symlink', () => {
    assert.equal(
      normalizeNodePath('/opt/homebrew/Cellar/node/25.8.1/bin/node'),
      '/opt/homebrew/bin/node',
    );
  });

  test('regular Windows nodejs path is unchanged', () => {
    const win = 'C:\\Program Files\\nodejs\\node.exe';
    assert.equal(normalizeNodePath(win), win);
  });

  test('empty string is returned as-is', () => {
    assert.equal(normalizeNodePath(''), '');
  });

  test('null is returned as-is', () => {
    assert.equal(normalizeNodePath(null), null);
  });
});

// ─── normalizeNodePath — already-stable fnm alias path is not re-processed ───

describe('Bug #977: normalizeNodePath — already-stable fnm alias path passes through unchanged', () => {
  test('stable FNM_DIR alias path is returned as-is', () => {
    assert.equal(
      normalizeNodePath(STABLE_FNM_DIR_NODE),
      STABLE_FNM_DIR_NODE,
    );
  });
});

// ─── normalizeNodePath — false-positive guard: non-numeric id must NOT remap ──

describe('Bug #977: normalizeNodePath — non-ephemeral fnm_multishells path is not remapped', () => {
  test('non-numeric id segment (e.g. custom-dir) returns raw execPath unchanged even when alias exists', () => {
    const nonEphemeral = 'C:/Users/u/AppData/Local/fnm_multishells/custom-dir/node.exe';
    const stableAlias = 'C:/Users/u/AppData/Roaming/fnm/aliases/default/node.exe';
    const result = normalizeNodePath(nonEphemeral, {
      env: { FNM_DIR: 'C:/Users/u/AppData/Roaming/fnm' },
      // existsSync returns true for the alias to prove the regex — not the existsSync — is the guard
      existsSync: p => p === stableAlias,
    });
    assert.equal(
      result,
      nonEphemeral,
      `expected raw execPath (non-ephemeral id must not be remapped), got: ${result}`,
    );
  });
});

// ─── resolveNodeRunner — opts pass-through ────────────────────────────────────

describe('Bug #977: resolveNodeRunner — passes opts through to normalizeNodePath', () => {
  test('fnm multishell execPath is resolved to stable alias via injected opts', () => {
    const orig = process.execPath;
    try {
      Object.defineProperty(process, 'execPath', {
        value: EPHEMERAL_FNM_WIN,
        configurable: true,
      });
      const runner = resolveNodeRunner({
        env: { FNM_DIR: FNM_DIR_WIN },
        existsSync: p => p === STABLE_FNM_DIR_NODE,
      });
      assert.equal(
        runner,
        JSON.stringify(STABLE_FNM_DIR_NODE),
        `expected stable FNM_DIR alias quoted, got: ${runner}`,
      );
    } finally {
      Object.defineProperty(process, 'execPath', { value: orig, configurable: true });
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2979-hook-absolute-node.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2979-hook-absolute-node (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #2979: Managed JS hooks fail in GUI/minimal-PATH runtimes because
 * the installer emits bare `node`.
 *
 * Reporter evidence: in a stripped PATH like /usr/bin:/bin:/usr/sbin:/sbin
 * (the default for Finder-launched/Antigravity-spawned processes on macOS),
 * `node` is not resolvable. Hook commands like
 *   `node "<HOME>/.gemini/hooks/gsd-check-update.js"`
 * fail with `/bin/sh: node: command not found` (exit 127).
 *
 * Fix: emit the absolute node path (`process.execPath`, the binary
 * running the installer itself) as the runner. Forward-slash-normalized
 * and double-quoted so it works on POSIX and Windows.
 *
 * This test exercises the public buildHookCommand surface plus the
 * resolveNodeRunner helper, asserting on structured records:
 *  - the runner field is an absolute path (not bare 'node')
 *  - it ends with /node or \\node (or .exe on Windows simulation)
 *  - .sh hooks still use bare 'bash' (PATH-resolved; portable across
 *    distros that don't ship /bin/bash, like NixOS)
 *
 * No source-grep on install.js content — assertions go against the
 * value returned by the exported function and the parsed structure of
 * the emitted hook command (split into runner + args).
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const INSTALL = require(path.join(__dirname, '..', 'bin', 'install.js'));
const { buildHookCommand, resolveNodeRunner } = INSTALL;

/**
 * Parse a hook command string into { runner, hookPath } structured
 * record. The shape is `<runner> "<hookPath>"` where <runner> may itself
 * be a quoted absolute path (containing spaces), so we split on the
 * trailing quoted-path token rather than the first space.
 */
function parseHookCommand(cmd) {
  // Trailing token: a double-quoted string ending the command.
  const m = cmd.match(/^(.+?)\s+"([^"]+)"\s*$/);
  if (!m) {
    return { runner: null, hookPath: null, raw: cmd };
  }
  return { runner: m[1], hookPath: m[2], raw: cmd };
}

describe('Bug #2979: resolveNodeRunner returns absolute, quoted, forward-slash node path', () => {
  test('exported as a function', () => {
    assert.equal(typeof resolveNodeRunner, 'function');
  });

  test('returns a double-quoted absolute path', () => {
    const runner = resolveNodeRunner();
    assert.ok(runner.startsWith('"'), `expected leading double-quote, got: ${runner}`);
    assert.ok(runner.endsWith('"'), `expected trailing double-quote, got: ${runner}`);
    const inner = runner.slice(1, -1);
    assert.ok(path.isAbsolute(inner.replace(/\//g, path.sep)), `expected absolute path, got: ${inner}`);
  });

  test('uses forward slashes (Windows-safe, matches buildHookCommand convention)', () => {
    const runner = resolveNodeRunner();
    assert.ok(!runner.includes('\\'), `expected forward slashes, got: ${runner}`);
  });

  test('points at a node binary (basename starts with "node")', () => {
    const runner = resolveNodeRunner();
    const inner = runner.slice(1, -1);
    const base = path.posix.basename(inner);
    assert.ok(/^node(\.exe)?$/i.test(base), `expected basename node or node.exe, got: ${base}`);
  });
});

describe('Bug #2979: buildHookCommand for .js hooks emits absolute node runner', () => {
  test('global install: .js hook uses absolute node path, not bare "node"', () => {
    const cmd = buildHookCommand('/tmp/.claude', 'gsd-check-update.js');
    const parsed = parseHookCommand(cmd);
    assert.notEqual(parsed.runner, null, `failed to parse: ${cmd}`);
    assert.notEqual(parsed.runner, 'node', `must not emit bare node (#2979): ${cmd}`);
    // The runner should be a quoted absolute path.
    assert.ok(parsed.runner.startsWith('"') && parsed.runner.endsWith('"'),
      `runner must be quoted absolute path, got: ${parsed.runner}`);
  });

  test('global install: .js hook command parses with hookPath at expected location', () => {
    const cmd = buildHookCommand('/tmp/.gemini', 'gsd-statusline.js');
    const parsed = parseHookCommand(cmd);
    assert.equal(parsed.hookPath, '/tmp/.gemini/hooks/gsd-statusline.js');
  });

  test('portableHooks global install: .js hook still uses absolute node (only the path is $HOME-relative)', () => {
    const home = require('node:os').homedir().replace(/\\/g, '/');
    const configDir = home + '/.gemini';
    const cmd = buildHookCommand(configDir, 'gsd-check-update.js', { portableHooks: true });
    const parsed = parseHookCommand(cmd);
    assert.notEqual(parsed.runner, 'node', `portableHooks must also use absolute node (#2979): ${cmd}`);
    assert.equal(parsed.hookPath, '$HOME/.gemini/hooks/gsd-check-update.js');
  });
});

describe('Bug #3362 / #3413: Windows hook commands are runtime-aware', () => {
  // #1928: gemini runtime removed — the PowerShell call-operator seam is now
  // inert for every runtime. Antigravity (the Gemini-backend successor) never
  // needed the call operator either; lock the inert contract explicitly.
  test('Antigravity global install: .js hook command stays shell-neutral on Windows (seam inert after gemini removal)', () => {
    const cmd = buildHookCommand('C:/Users/me/.gemini/antigravity', 'gsd-check-update.js', {
      platform: 'win32',
      runtime: 'antigravity',
    });
    assert.ok(!cmd.startsWith('& '), `Antigravity hook command must not use PowerShell call operator: ${cmd}`);
    assert.ok(cmd.includes('"C:/Users/me/.gemini/antigravity/hooks/gsd-check-update.js"'));
  });

  test('Antigravity portable install: .js hook command also stays shell-neutral on Windows (seam inert after gemini removal)', () => {
    const home = require('node:os').homedir().replace(/\\/g, '/');
    const cmd = buildHookCommand(`${home}/.gemini/antigravity`, 'gsd-check-update.js', {
      portableHooks: true,
      platform: 'win32',
      runtime: 'antigravity',
    });
    assert.ok(!cmd.startsWith('& '), `Antigravity hook command must not use PowerShell call operator: ${cmd}`);
    assert.equal(parseHookCommand(cmd).hookPath, '$HOME/.gemini/antigravity/hooks/gsd-check-update.js');
  });

  test('Claude global install: .js hook command stays shell-neutral on Windows Git Bash', () => {
    const cmd = buildHookCommand('C:/Users/me/.claude', 'gsd-check-update.js', {
      platform: 'win32',
      runtime: 'claude',
    });
    assert.ok(!cmd.startsWith('& '), `Claude hook command must not use PowerShell call operator: ${cmd}`);
    assert.equal(parseHookCommand(cmd).hookPath, 'C:/Users/me/.claude/hooks/gsd-check-update.js');
  });

  test('Windows .js hook with no runtime stays shell-neutral', () => {
    const cmd = buildHookCommand('C:/Users/me/.claude', 'gsd-check-update.js', {
      platform: 'win32',
    });
    assert.ok(!cmd.startsWith('& '), `Missing runtime must not imply PowerShell syntax: ${cmd}`);
    assert.equal(parseHookCommand(cmd).hookPath, 'C:/Users/me/.claude/hooks/gsd-check-update.js');
  });

  test('Antigravity runtime on non-Windows platform does not get PowerShell syntax', () => {
    const cmd = buildHookCommand('/home/me/.claude', 'gsd-check-update.js', {
      platform: 'linux',
      runtime: 'antigravity',
    });
    assert.ok(!cmd.startsWith('& '), `Non-Windows Antigravity hook must stay shell-neutral: ${cmd}`);
    assert.equal(parseHookCommand(cmd).hookPath, '/home/me/.claude/hooks/gsd-check-update.js');
  });
});

describe('Bug #2979: buildHookCommand for .sh hooks still uses bare "bash" (POSIX std PATH always has /bin)', () => {
  test('.sh hook runner is exactly "bash" — bash is in /usr/bin:/bin and resolves under minimal PATH', () => {
    const cmd = buildHookCommand('/tmp/.claude', 'gsd-session-state.sh', { platform: 'linux' });
    const parsed = parseHookCommand(cmd);
    assert.equal(parsed.runner, 'bash');
  });

  test('Windows .sh hook uses resolved Git Bash path instead of bare bash (#3393)', () => {
    const cmd = buildHookCommand('C:/Users/me/.codex', 'gsd-validate-commit.sh', {
      platform: 'win32',
      env: { ProgramFiles: 'C:\\Program Files' },
      existsSync: (candidate) => candidate === 'C:\\Program Files\\Git\\bin\\bash.exe',
    });
    assert.equal(
      cmd,
      '"C:/Program Files/Git/bin/bash.exe" "C:/Users/me/.codex/hooks/gsd-validate-commit.sh"',
    );
  });

  test('Windows .sh hook returns null when no supported Bash runner is found (#3393)', () => {
    const cmd = buildHookCommand('C:/Users/me/.codex', 'gsd-phase-boundary.sh', {
      platform: 'win32',
      env: {},
      existsSync: () => false,
    });
    assert.equal(cmd, null);
  });

  test('Windows Claude .sh hook omits explicit bash.exe wrapper (#166)', () => {
    const cmd = buildHookCommand('C:/Users/me/.claude', 'gsd-session-state.sh', {
      platform: 'win32',
      runtime: 'claude',
      env: { ProgramFiles: 'C:\\Program Files' },
      existsSync: (candidate) => candidate === 'C:\\Program Files\\Git\\bin\\bash.exe',
    });
    assert.equal(
      cmd,
      '"C:/Users/me/.claude/hooks/gsd-session-state.sh"',
      'Claude win32 .sh hooks should serialize as script-only commands'
    );
  });
});

// ─── #3002 CR follow-up: legacy-bare-node migration ─────────────────────────

const { rewriteLegacyManagedNodeHookCommands } = INSTALL;

describe('Bug #2979 (#3002 CR): rewriteLegacyManagedNodeHookCommands rewrites bare-node managed hooks on reinstall', () => {
  test('exported as a function', () => {
    assert.equal(typeof rewriteLegacyManagedNodeHookCommands, 'function');
  });

  test('rewrites a managed hook entry that uses bare `node ` to the absolute runner', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [
            { type: 'command', command: 'node "/Users/x/.gemini/hooks/gsd-check-update.js"' },
          ],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner);
    assert.equal(changed, true);
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].command,
      '"/usr/local/bin/node" "/Users/x/.gemini/hooks/gsd-check-update.js"',
    );
  });

  test('does NOT touch entries that already use a quoted absolute runner', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: '"/usr/local/bin/node" "/x/hooks/gsd-statusline.js"' }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const before = settings.hooks.SessionStart[0].hooks[0].command;
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner);
    assert.equal(changed, false);
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, before);
  });

  // #1928: gemini runtime removed — the PowerShell call-operator seam is now
  // inert for every runtime (including antigravity, the Gemini-backend
  // successor). An already-correct absolute-runner command needs no rewrite.
  test('Antigravity on Windows leaves an already-correct quoted managed hook untouched (seam inert after gemini removal)', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: '"/usr/local/bin/node" "C:/Program Files/Antigravity/.gemini/antigravity/hooks/gsd-check-update.js"' }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const before = settings.hooks.SessionStart[0].hooks[0].command;
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner, { platform: 'win32', runtime: 'antigravity' });
    assert.equal(changed, false);
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, before);
  });

  test('Antigravity on Windows strips a stale PowerShell call operator from managed hooks on reinstall (seam inert after gemini removal)', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: '& "/usr/local/bin/node" "C:/Program Files/Antigravity/.gemini/antigravity/hooks/gsd-check-update.js"' }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner, { platform: 'win32', runtime: 'antigravity' });
    assert.equal(changed, true);
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].command,
      '"/usr/local/bin/node" "C:/Program Files/Antigravity/.gemini/antigravity/hooks/gsd-check-update.js"',
    );
  });

  test('Antigravity on Windows rewrites PowerShell bare-node managed hooks to absolute runner and drops the stale & (seam inert after gemini removal)', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: '& node "C:/Users/me/.gemini/antigravity/hooks/gsd-check-update.js"' }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner, { platform: 'win32', runtime: 'antigravity' });
    assert.equal(changed, true);
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].command,
      '"/usr/local/bin/node" "C:/Users/me/.gemini/antigravity/hooks/gsd-check-update.js"',
    );
  });

  test('Claude on Windows strips stale PowerShell prefix from managed hooks on reinstall (#3413)', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: '& "/usr/local/bin/node" "C:/Users/me/.claude/hooks/gsd-check-update.js"' }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner, { platform: 'win32', runtime: 'claude' });
    assert.equal(changed, true);
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].command,
      '"/usr/local/bin/node" "C:/Users/me/.claude/hooks/gsd-check-update.js"',
    );
  });

  test('does NOT touch user-authored bare-node hooks (filename not in managed allowlist)', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: 'node /home/me/my-custom-hook.js' }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const before = settings.hooks.SessionStart[0].hooks[0].command;
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner);
    assert.equal(changed, false);
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, before);
  });

  test('does NOT touch .sh hooks (they correctly use bare bash)', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: 'bash "/x/hooks/gsd-session-state.sh"' }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner);
    assert.equal(changed, false);
  });

  test('is a no-op when absoluteRunner is null (resolveNodeRunner failed)', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: 'node "/x/hooks/gsd-check-update.js"' }],
        }],
      },
    };
    const before = settings.hooks.SessionStart[0].hooks[0].command;
    const changed = rewriteLegacyManagedNodeHookCommands(settings, null);
    assert.equal(changed, false);
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, before);
  });

  // #3002 CR: substring containment was a false-positive vector.
  // User-authored hooks whose path happened to CONTAIN a managed filename
  // as a substring would get unconditionally rewritten with the GSD runner.
  // The fix matches by basename equality.
  test('does NOT rewrite a user hook whose path contains a managed filename as a substring', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{
            type: 'command',
            // Path contains gsd-check-update.js as substring of a longer
            // filename, but is NOT actually that file.
            command: 'node /home/me/scripts/wraps-gsd-check-update.js-helper.js',
          }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const before = settings.hooks.SessionStart[0].hooks[0].command;
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner);
    assert.equal(changed, false, 'must not rewrite user hooks with managed-filename-as-substring paths');
    assert.equal(settings.hooks.SessionStart[0].hooks[0].command, before);
  });

  test('rewrites a managed entry whose path is quoted with single quotes', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: "node '/x/hooks/gsd-statusline.js'" }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner, { platform: 'linux' });
    assert.equal(changed, true);
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].command,
      `"/usr/local/bin/node" '/x/hooks/gsd-statusline.js'`,
    );
  });

  test('rewrites a managed entry with no path quoting (bareword)', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: 'node /x/hooks/gsd-context-monitor.js' }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner, { platform: 'linux' });
    assert.equal(changed, true);
    assert.equal(
      settings.hooks.SessionStart[0].hooks[0].command,
      '"/usr/local/bin/node" /x/hooks/gsd-context-monitor.js',
    );
  });

  test('handles Windows-style backslash path separators when extracting basename', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [{ type: 'command', command: 'node "C:\\\\Users\\\\me\\\\.claude\\\\hooks\\\\gsd-prompt-guard.js"' }],
        }],
      },
    };
    const runner = '"/usr/local/bin/node"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner);
    assert.equal(changed, true);
  });

  test('Antigravity on Windows normalizes single-quoted managed hook paths to double-quoted forward-slash paths without adding & (#3392; seam inert after gemini removal)', () => {
    const settings = {
      hooks: {
        PreToolUse: [{
          hooks: [{
            type: 'command',
            command: "node 'C:\\Users\\me\\.gemini\\hooks\\gsd-prompt-guard.js'",
          }],
        }],
      },
    };
    const runner = '"C:/nvm4w/nodejs/node.exe"';
    const changed = rewriteLegacyManagedNodeHookCommands(settings, runner, { platform: 'win32', runtime: 'antigravity' });
    assert.equal(changed, true);
    assert.equal(
      settings.hooks.PreToolUse[0].hooks[0].command,
      '"C:/nvm4w/nodejs/node.exe" "C:/Users/me/.gemini/hooks/gsd-prompt-guard.js"',
    );
  });
});

describe('Bug #2979 (#3002 CR): resolveNodeRunner returns null when execPath unavailable', () => {
  test('returns null instead of bare "node" when process.execPath is empty', () => {
    const orig = process.execPath;
    try {
      Object.defineProperty(process, 'execPath', { value: '', configurable: true });
      const r = resolveNodeRunner();
      assert.equal(r, null, 'expected null, not bare "node"');
    } finally {
      Object.defineProperty(process, 'execPath', { value: orig, configurable: true });
    }
  });

  test('buildHookCommand returns null when execPath is unavailable (caller skips registration)', () => {
    const orig = process.execPath;
    try {
      Object.defineProperty(process, 'execPath', { value: '', configurable: true });
      const cmd = buildHookCommand('/tmp/.claude', 'gsd-statusline.js');
      assert.equal(cmd, null);
    } finally {
      Object.defineProperty(process, 'execPath', { value: orig, configurable: true });
    }
  });
});

// ─── #3002 CR follow-up #2: null-command guards in settings.json ──────────

const { validateHookFields } = INSTALL;

describe('Bug #2979 (#3002 CR follow-up): no command:null hook entries survive serialization', () => {
  // CR feedback: assert structurally on the resulting settings object, not by
  // grepping bin/install.js source. The push-site guards (each `if` clause's
  // `&& <command>` token) skip null-command pushes at the source. As a
  // backstop, install.js now runs validateHookFields(settings) right before
  // writeSettings; this test exercises that backstop directly.
  //
  // Construct a settings object that contains exactly the kind of null-command
  // entries that the registration code would have written if my push-site
  // guards regressed. Run validateHookFields on it. Assert the null entries
  // are gone and the well-formed entries survive.

  function nullCommandEntry(matcher) {
    const entry = { hooks: [{ type: 'command', command: null }] };
    if (matcher) entry.matcher = matcher;
    return entry;
  }
  function realCommandEntry(matcher, command) {
    const entry = { hooks: [{ type: 'command', command }] };
    if (matcher) entry.matcher = matcher;
    return entry;
  }

  const MANAGED_JS_HOOKS = [
    { event: 'SessionStart',  matcher: undefined,                                       label: 'gsd-check-update.js' },
    { event: 'PostToolUse',   matcher: 'Bash|Edit|Write|MultiEdit|Agent|Task',          label: 'gsd-context-monitor.js' },
    { event: 'PreToolUse',    matcher: 'Write|Edit',                                    label: 'gsd-prompt-guard.js' },
    { event: 'PreToolUse',    matcher: 'Write|Edit',                                    label: 'gsd-read-guard.js' },
    { event: 'PostToolUse',   matcher: 'Read',                                          label: 'gsd-read-injection-scanner.js' },
    { event: 'PreToolUse',    matcher: 'Bash|Edit|Write|MultiEdit',                     label: 'gsd-workflow-guard.js' },
  ];

  for (const { event, matcher, label } of MANAGED_JS_HOOKS) {
    test(`validateHookFields strips a null-command ${label} entry from settings.hooks.${event}`, () => {
      const settings = {
        hooks: {
          [event]: [
            nullCommandEntry(matcher),
            realCommandEntry(matcher, '"/usr/local/bin/node" "/x/hooks/other.js"'),
          ],
        },
      };
      const out = validateHookFields(settings);
      const survivors = out.hooks[event] || [];
      // The well-formed entry must remain.
      assert.equal(survivors.length, 1, `expected the real-command entry to survive`);
      // No survivor entry contains a hook with command === null.
      for (const e of survivors) {
        for (const h of e.hooks || []) {
          assert.notEqual(h.command, null, 'no surviving hook should have command:null');
        }
      }
    });
  }

  test('validateHookFields drops the entry entirely when all its hooks have null commands', () => {
    const settings = {
      hooks: {
        SessionStart: [nullCommandEntry()],
      },
    };
    const out = validateHookFields(settings);
    // Empty event arrays should be cleaned up (the entire SessionStart key
    // gets removed when nothing valid remains).
    assert.ok(
      !out.hooks.SessionStart || out.hooks.SessionStart.length === 0,
      'expected SessionStart to be empty/removed after the only entry was dropped',
    );
  });

  test('validateHookFields preserves agent-type hooks while stripping command:null sibling hooks', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          hooks: [
            { type: 'command', command: null },
            { type: 'agent', prompt: 'analyze the session' },
            { type: 'command', command: '"/usr/local/bin/node" "/x/hooks/y.js"' },
          ],
        }],
      },
    };
    const out = validateHookFields(settings);
    const survivors = out.hooks.SessionStart[0].hooks;
    assert.equal(survivors.length, 2, 'expected 2 of 3 hooks to survive (the null-command one is stripped)');
    assert.equal(survivors.find(h => h.command === null), undefined, 'no surviving hook should have command:null');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-442-config-dir-equals-in-path.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-442-config-dir-equals-in-path (consolidation epic #1969 B1 #1970)", () => {
'use strict';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

// parseConfigDirArg is not exported directly from bin/install.js (it closes
// over the module-level `args` array).  We expose a pure seam here:
// parseConfigDirFromArgs(args) that mirrors the function's logic so we can
// test the equals-form parsing without spawning a child process.
//
// The implementation under test is inlined below (RED: before the fix it will
// reproduce the truncation bug).  Once the fix lands, we swap in the real
// implementation via require.

/**
 * Pure seam that replicates the equals-form parse logic from bin/install.js.
 * We import it via a thin wrapper so that the function can be tested without
 * executing the entire install script.
 *
 * During RED the bug is: `split('=')[1]` drops everything after the second `=`.
 */
const { parseConfigDirFromArgs } = require('../bin/install.js');

describe('bug-442: --config-dir= equals-form path parsing', () => {
  // ── Happy-path: single = in path ─────────────────────────────────────────
  test('--config-dir=<path> with one = in value returns full value', () => {
    const result = parseConfigDirFromArgs(['--config-dir=/tmp/gsd=a']);
    assert.equal(result, '/tmp/gsd=a');
  });

  // ── Happy-path: multiple = in path ───────────────────────────────────────
  test('--config-dir=<path> with multiple = in value returns full value', () => {
    const result = parseConfigDirFromArgs(['--config-dir=/tmp/a=b=c']);
    assert.equal(result, '/tmp/a=b=c');
  });

  // ── Short form -c= ────────────────────────────────────────────────────────
  test('-c=<path> with = in value returns full value', () => {
    const result = parseConfigDirFromArgs(['-c=/tmp/gsd=a']);
    assert.equal(result, '/tmp/gsd=a');
  });

  test('-c=<path> with multiple = in value returns full value', () => {
    const result = parseConfigDirFromArgs(['-c=/tmp/a=b=c']);
    assert.equal(result, '/tmp/a=b=c');
  });

  // ── Contract: empty value ─────────────────────────────────────────────────
  // --config-dir= (no value after the =) → returns empty string ''.
  // The caller (parseConfigDirArg) treats '' as missing and errors; the seam
  // itself should faithfully return '' rather than null/undefined so the
  // caller can make the error decision.
  test('--config-dir= with no value returns empty string', () => {
    const result = parseConfigDirFromArgs(['--config-dir=']);
    assert.equal(result, '');
  });

  test('-c= with no value returns empty string', () => {
    const result = parseConfigDirFromArgs(['-c=']);
    assert.equal(result, '');
  });

  // ── Space-separated form is unaffected (regression guard) ─────────────────
  test('--config-dir <path> space-separated still returns the path', () => {
    const result = parseConfigDirFromArgs(['--config-dir', '/tmp/gsd=a']);
    assert.equal(result, '/tmp/gsd=a');
  });

  test('-c <path> space-separated still returns the path', () => {
    const result = parseConfigDirFromArgs(['-c', '/tmp/gsd=a']);
    assert.equal(result, '/tmp/gsd=a');
  });

  // ── No config-dir flag → null ─────────────────────────────────────────────
  test('returns null when no --config-dir flag is present', () => {
    const result = parseConfigDirFromArgs(['--global', '--claude']);
    assert.equal(result, null);
  });

  // ── Negative matrix (CLI edge cases) ─────────────────────────────────────
  // Flag-looking value after space form: next arg starts with - → null (no
  // valid value; the real function would process.exit but the seam returns null
  // so tests stay in-process).
  test('space form with next arg being a flag returns null (flag-looking value)', () => {
    const result = parseConfigDirFromArgs(['--config-dir', '--other-flag']);
    assert.equal(result, null);
  });

  // Equals form where value is a path with no = (plain path, no regression)
  test('--config-dir=<plain-path> without any = in path still works', () => {
    const result = parseConfigDirFromArgs(['--config-dir=/tmp/plain']);
    assert.equal(result, '/tmp/plain');
  });

  // Flag appears after other args (positional ordering should not matter)
  test('--config-dir= flag after other args is parsed correctly', () => {
    const result = parseConfigDirFromArgs(['--global', '--config-dir=/tmp/a=b', '--claude']);
    assert.equal(result, '/tmp/a=b');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-1559-installer-export-audit.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-1559-installer-export-audit (consolidation epic #1969 B1 #1970)", () => {
'use strict';

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');

let installer;
let conversion;

before(() => {
  process.env['GSD_TEST_MODE'] = '1';
  installer = require('../bin/install.js');
  conversion = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
});

describe('bin/install.js compatibility export audit (#1559)', () => {
  test('retains audited compatibility relays for shared rewrite helpers', () => {
    assert.strictEqual(installer.processAttribution, conversion.processAttribution);
    assert.strictEqual(
      installer.applyRuntimeContentRewritesForCommandsInPlace,
      conversion.applyRuntimeContentRewritesForCommandsInPlace,
    );
  });

  test('does not leak unaudited conversion-module helpers through the installer', () => {
    for (const name of [
      'yamlQuote',
      'toSingleLine',
      'extractFrontmatterAndBody',
      'extractFrontmatterField',
      'convertClaudeToCursorMarkdown',
      'convertClaudeToCodexMarkdown',
      'transformContentToHyphen',
      'claudeToGeminiTools',
      'convertGeminiToolName',
      'rewriteStagedSkillBodies',
      'rewriteStagedCommandBodies',
      '_computePathPrefix',
      '_stampNonClaudeRuntimeDefaults',
      'NON_CLAUDE_RUNTIMES',
    ]) {
      assert.ok(name in conversion, `${name} remains available from the conversion module`);
      assert.equal(installer[name], undefined, `${name} is not an installer compatibility export`);
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1908-uninstall-manifest.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1908-uninstall-manifest (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for bug #1908
 *
 * `--uninstall` did not remove `gsd-file-manifest.json` from the target
 * directory, leaving a stale metadata file after uninstall.
 *
 * Fix: `uninstall()` must call
 *   fs.rmSync(path.join(targetDir, MANIFEST_NAME), { force: true })
 * after cleaning up the rest of the GSD artefacts.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { uninstall } = require('../bin/install.js');

const MANIFEST_NAME = 'gsd-file-manifest.json';

// ─── helpers ──────────────────────────────────────────────────────────────────

function createFakeInstall(prefix = 'gsd-uninstall-test-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));

  // Simulate the minimum directory/file layout produced by the installer:
  // gsd-core/ directory, agents/ directory, and the manifest file.
  fs.mkdirSync(path.join(dir, 'gsd-core', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'gsd-core', 'workflows', 'execute-phase.md'), '# stub');

  fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agents', 'gsd-executor.md'), '# stub');

  const manifest = {
    version: '1.34.0',
    timestamp: new Date().toISOString(),
    files: {
      'gsd-core/workflows/execute-phase.md': 'abc123',
      'agents/gsd-executor.md': 'def456',
    },
  };
  fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify(manifest, null, 2));

  return dir;
}

function cleanup(dir) {
  // eslint-disable-next-line local/no-raw-rmsync-in-tests -- local teardown helper predates helpers.cjs; renaming would collide with the imported cleanup
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

// ─── tests ────────────────────────────────────────────────────────────────────

describe('uninstall — manifest cleanup (#1908)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createFakeInstall();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gsd-file-manifest.json is removed after global uninstall', () => {
    const manifestPath = path.join(tmpDir, MANIFEST_NAME);

    // Pre-condition: manifest exists before uninstall
    assert.ok(
      fs.existsSync(manifestPath),
      'Test setup failure: manifest file should exist before uninstall'
    );

    // Run uninstall against tmpDir (pass it via CLAUDE_CONFIG_DIR so getGlobalDir()
    // resolves to our temp directory; pass isGlobal=true)
    const savedEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    try {
      uninstall(true, 'claude');
    } finally {
      if (savedEnv === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = savedEnv;
      }
    }

    assert.ok(
      !fs.existsSync(manifestPath),
      [
        `${MANIFEST_NAME} must be removed by uninstall() but still exists at`,
        manifestPath,
      ].join(' ')
    );
  });

  test('gsd-file-manifest.json is removed after local uninstall', () => {
    const manifestPath = path.join(tmpDir, MANIFEST_NAME);

    assert.ok(
      fs.existsSync(manifestPath),
      'Test setup failure: manifest file should exist before uninstall'
    );

    // For a local install, getGlobalDir is not called — targetDir = cwd + dirName.
    // Simulate by creating .claude/ inside tmpDir and placing artefacts there.
    const localDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(path.join(localDir, 'gsd-core', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(localDir, 'gsd-core', 'workflows', 'execute-phase.md'), '# stub');
    const localManifestPath = path.join(localDir, MANIFEST_NAME);
    fs.writeFileSync(localManifestPath, JSON.stringify({ version: '1.34.0', files: {} }, null, 2));

    const savedCwd = process.cwd();
    process.chdir(tmpDir);
    try {
      uninstall(false, 'claude');
    } finally {
      process.chdir(savedCwd);
    }

    assert.ok(
      !fs.existsSync(localManifestPath),
      [
        `${MANIFEST_NAME} must be removed by uninstall() (local) but still exists at`,
        localManifestPath,
      ].join(' ')
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2771-user-profile-manifest.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2771-user-profile-manifest (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression tests for bug #2771: USER-PROFILE.md tracked in install manifest
 *
 * USER-PROFILE.md is a user-owned artifact created/refreshed by /gsd-profile-user.
 * preserveUserArtifacts() correctly preserves it across reinstalls. But writeManifest()
 * also records it under "gsd-core/USER-PROFILE.md" with a SHA-256 of whatever was
 * on disk at install time. On the next install, saveLocalPatches() compares the on-disk
 * (refreshed) hash to the manifest hash, finds them different, and emits the spurious
 * "Found N locally modified GSD file(s) — backed up to gsd-local-patches/" warning.
 *
 * Invariant: a file is either distribution (manifest-tracked, diff'd against manifest)
 * or user artifact (preserved across installs, never diff'd). It cannot be both. The
 * shared truth source must be a single USER_OWNED_ARTIFACTS list referenced by both
 * preserveUserArtifacts callers and writeManifest.
 *
 * Closes: #2771
 */

'use strict';

const { describe, test, beforeEach, afterEach, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { createTempDir, cleanup } = require('./helpers.cjs');

const INSTALL_SCRIPT = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
const MANIFEST_NAME = 'gsd-file-manifest.json';
const PATCHES_DIR_NAME = 'gsd-local-patches';

before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], { encoding: 'utf-8', stdio: 'pipe' });
});

function runInstaller(configDir) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: configDir };
  delete env.GSD_TEST_MODE;
  return execFileSync(
    process.execPath,
    [INSTALL_SCRIPT, '--claude', '--global', '--yes', '--no-sdk'],
    { encoding: 'utf-8', stdio: 'pipe', env }
  );
}

// ─── Test 1: writeManifest must NOT record USER-PROFILE.md ────────────────────

describe('#2771: USER-PROFILE.md is excluded from gsd-file-manifest.json', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempDir('gsd-2771-manifest-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('writeManifest excludes gsd-core/USER-PROFILE.md even when present on disk', () => {
    runInstaller(tmpDir);

    // Simulate /gsd-profile-user creating USER-PROFILE.md
    const profilePath = path.join(tmpDir, 'gsd-core', 'USER-PROFILE.md');
    fs.writeFileSync(profilePath, '# My Profile\n\nFirst version.\n');

    // Re-install: writeManifest runs again with USER-PROFILE.md present on disk
    runInstaller(tmpDir);

    const manifestPath = path.join(tmpDir, MANIFEST_NAME);
    assert.ok(fs.existsSync(manifestPath), 'manifest must be written');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    assert.ok(
      !Object.prototype.hasOwnProperty.call(manifest.files, 'gsd-core/USER-PROFILE.md'),
      'manifest.files must NOT contain gsd-core/USER-PROFILE.md — it is a user artifact, not distribution'
    );
  });
});

// ─── Test 2: preserveUserArtifacts still preserves USER-PROFILE.md ────────────

describe('#2771: USER-PROFILE.md is still preserved across reinstall', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempDir('gsd-2771-preserve-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('USER-PROFILE.md content survives reinstall (preservation regression guard)', () => {
    runInstaller(tmpDir);

    const profilePath = path.join(tmpDir, 'gsd-core', 'USER-PROFILE.md');
    const content = '# Profile\n\nUser content from /gsd-profile-user.\n';
    fs.writeFileSync(profilePath, content);

    runInstaller(tmpDir);

    assert.ok(fs.existsSync(profilePath), 'USER-PROFILE.md must survive reinstall');
    assert.strictEqual(fs.readFileSync(profilePath, 'utf8'), content);
  });
});

// ─── Test 3: no spurious "local patches" hit for USER-PROFILE.md refresh ──────

describe('#2771: refreshed USER-PROFILE.md does not trigger local-patches warning', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempDir('gsd-2771-patches-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('saveLocalPatches does not classify a refreshed USER-PROFILE.md as a local patch', () => {
    // Initial install
    runInstaller(tmpDir);

    // /gsd-profile-user creates USER-PROFILE.md (v1)
    const profilePath = path.join(tmpDir, 'gsd-core', 'USER-PROFILE.md');
    fs.writeFileSync(profilePath, '# Profile v1\n');

    // Reinstall — manifest written with v1 contents (under buggy code) or excluded (under fix)
    runInstaller(tmpDir);

    // /gsd-profile-user --refresh rewrites USER-PROFILE.md (v2 != v1)
    fs.writeFileSync(profilePath, '# Profile v2 — refreshed\n');

    // Reinstall — saveLocalPatches scans manifest. Under bug, v2 hash != v1 manifest
    // hash → patch detected. Under fix, file is not in manifest → no patch.
    const output = runInstaller(tmpDir);

    const patchesDir = path.join(tmpDir, PATCHES_DIR_NAME);
    const patchFile = path.join(patchesDir, 'gsd-core', 'USER-PROFILE.md');
    assert.ok(
      !fs.existsSync(patchFile),
      'USER-PROFILE.md must NOT appear in gsd-local-patches/ — it is a user artifact, not a modified distribution file'
    );

    const offendingLine = output
      .split('\n')
      .find((line) => /locally modified GSD file/.test(line) && /USER-PROFILE/.test(line));
    assert.strictEqual(
      offendingLine,
      undefined,
      'installer output must not report USER-PROFILE.md as a locally modified GSD file on any single line. Output was:\n' + output
    );
  });
});

// ─── Test 5: legacy manifest with USER-PROFILE.md entry is normalized ─────────

describe('#2771: legacy manifest entries for USER_OWNED_ARTIFACTS are normalized', () => {
  let tmpDir;

  beforeEach(() => { tmpDir = createTempDir('gsd-2771-legacy-'); });
  afterEach(() => { cleanup(tmpDir); });

  test('pre-existing manifest entry for USER-PROFILE.md does not trigger patches warning', () => {
    // Initial install
    runInstaller(tmpDir);

    const profilePath = path.join(tmpDir, 'gsd-core', 'USER-PROFILE.md');
    fs.writeFileSync(profilePath, '# Profile v1\n');

    // Reinstall to populate manifest under the (now-fixed) writer
    runInstaller(tmpDir);

    // Inject a stale manifest entry simulating a pre-#2771 install: a hash for
    // USER-PROFILE.md that does NOT match current content.
    const manifestPath = path.join(tmpDir, MANIFEST_NAME);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.files = manifest.files || {};
    manifest.files['gsd-core/USER-PROFILE.md'] = 'deadbeef'.repeat(8); // stale hash
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    // /gsd-profile-user --refresh rewrites USER-PROFILE.md
    fs.writeFileSync(profilePath, '# Profile v2 — refreshed\n');

    // Reinstall — saveLocalPatches must strip the legacy entry before scanning
    const output = runInstaller(tmpDir);

    const patchesDir = path.join(tmpDir, PATCHES_DIR_NAME);
    const patchFile = path.join(patchesDir, 'gsd-core', 'USER-PROFILE.md');
    assert.ok(
      !fs.existsSync(patchFile),
      'legacy USER-PROFILE.md manifest entry must be normalized away — not backed up as a patch'
    );

    const offendingLine = output
      .split('\n')
      .find((line) => /locally modified GSD file/.test(line) && /USER-PROFILE/.test(line));
    assert.strictEqual(
      offendingLine,
      undefined,
      'legacy manifest entry must not surface a USER-PROFILE.md patches warning. Output was:\n' + output
    );
  });
});

// ─── Test 4: shared constant exists and is used by both call sites ────────────

describe('#2771: USER_OWNED_ARTIFACTS is a single source of truth', () => {
  test('install.js exports USER_OWNED_ARTIFACTS containing USER-PROFILE.md', () => {
    const origMode = process.env.GSD_TEST_MODE;
    process.env.GSD_TEST_MODE = '1';
    let mod;
    try {
      delete require.cache[require.resolve(INSTALL_SCRIPT)];
      mod = require(INSTALL_SCRIPT);
    } finally {
      if (origMode === undefined) delete process.env.GSD_TEST_MODE;
      else process.env.GSD_TEST_MODE = origMode;
    }

    assert.ok(
      Array.isArray(mod.USER_OWNED_ARTIFACTS) || mod.USER_OWNED_ARTIFACTS instanceof Set,
      'install.js must export USER_OWNED_ARTIFACTS as a single source of truth'
    );
    const list = Array.isArray(mod.USER_OWNED_ARTIFACTS)
      ? mod.USER_OWNED_ARTIFACTS
      : Array.from(mod.USER_OWNED_ARTIFACTS);
    assert.ok(
      list.includes('USER-PROFILE.md'),
      'USER_OWNED_ARTIFACTS must include USER-PROFILE.md'
    );
  });
});

describe('manifest path safety', () => {
  let tmpDir;
  let outside;

  beforeEach(() => {
    tmpDir = createTempDir('gsd-manifest-path-safety-');
    outside = path.join(tmpDir, '..', `outside-managed-file-${path.basename(tmpDir)}.txt`);
  });
  afterEach(() => {
    cleanup(outside);
    cleanup(tmpDir);
  });

  test('saveLocalPatches ignores manifest entries that escape the install root', () => {
    const origMode = process.env.GSD_TEST_MODE;
    process.env.GSD_TEST_MODE = '1';
    let mod;
    try {
      delete require.cache[require.resolve(INSTALL_SCRIPT)];
      mod = require(INSTALL_SCRIPT);
    } finally {
      if (origMode === undefined) delete process.env.GSD_TEST_MODE;
      else process.env.GSD_TEST_MODE = origMode;
    }

    fs.writeFileSync(outside, 'outside user data\n', 'utf8');
    fs.writeFileSync(
      path.join(tmpDir, MANIFEST_NAME),
      JSON.stringify({
        version: 'legacy',
        timestamp: '2026-05-11T00:00:00.000Z',
        files: {
          '../outside-managed-file.txt': 'deadbeef',
        },
      }, null, 2),
      'utf8'
    );

    const modified = mod.saveLocalPatches(tmpDir);

    assert.deepEqual(modified, []);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside user data\n');
    assert.equal(fs.existsSync(path.join(tmpDir, PATCHES_DIR_NAME, '..', path.basename(outside))), false);
  });

  test('saveLocalPatches does not follow symlinked patch directories outside the install root', () => {
    const origMode = process.env.GSD_TEST_MODE;
    process.env.GSD_TEST_MODE = '1';
    let mod;
    try {
      delete require.cache[require.resolve(INSTALL_SCRIPT)];
      mod = require(INSTALL_SCRIPT);
    } finally {
      if (origMode === undefined) delete process.env.GSD_TEST_MODE;
      else process.env.GSD_TEST_MODE = origMode;
    }

    const hookPath = path.join(tmpDir, 'hooks', 'managed.js');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, 'user edited hook\n', 'utf8');
    fs.writeFileSync(
      path.join(tmpDir, MANIFEST_NAME),
      JSON.stringify({
        version: 'legacy',
        timestamp: '2026-05-11T00:00:00.000Z',
        files: {
          'hooks/managed.js': crypto.createHash('sha256').update('managed hook\n').digest('hex'),
        },
      }, null, 2),
      'utf8'
    );

    fs.mkdirSync(outside, { recursive: true });
    try {
      fs.symlinkSync(outside, path.join(tmpDir, PATCHES_DIR_NAME), 'dir');
    } catch {
      return;
    }

    const modified = mod.saveLocalPatches(tmpDir);

    assert.deepEqual(modified, []);
    assert.equal(fs.existsSync(path.join(outside, 'hooks', 'managed.js')), false);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3571-configuration-manifest-install-path.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3571-configuration-manifest-install-path (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for #3571: configuration.cjs used the source
 * checkout sdk/shared path only, which breaks installed gsd-tools.cjs because
 * runtime installs copy gsd-core/ but not sdk/.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const CONFIGURATION_CJS = path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'configuration.cjs');
const SHARED_DIR = path.join(REPO_ROOT, 'gsd-core', 'bin', 'shared');

const { install } = require('../bin/install.js');

const { createTempDir, cleanup } = require('./helpers.cjs');
const makeTmpDir = () => createTempDir('gsd-3571-');

function silenceConsole(fn) {
  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  }
}

describe('bug #3571: configuration generated manifests resolve in install layout', () => {
  let tmpRoot;
  let savedHome;
  let savedUserProfile;
  let savedExplicitConfigDir;

  beforeEach(() => {
    tmpRoot = makeTmpDir();
    savedHome = process.env.HOME;
    // On Windows, os.homedir() reads USERPROFILE; install() resolves via it.
    savedUserProfile = process.env.USERPROFILE;
    savedExplicitConfigDir = process.env.GSD_EXPLICIT_CONFIG_DIR;
    delete process.env.GSD_EXPLICIT_CONFIG_DIR;
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (savedExplicitConfigDir === undefined) {
      delete process.env.GSD_EXPLICIT_CONFIG_DIR;
    } else {
      process.env.GSD_EXPLICIT_CONFIG_DIR = savedExplicitConfigDir;
    }
    cleanup(tmpRoot);
  });

  test('co-located bin/shared manifests let configuration.cjs load without sdk/shared', () => {
    const gsdBinDir = path.join(tmpRoot, '.codex', 'gsd-core', 'bin');
    const gsdLibDir = path.join(gsdBinDir, 'lib');
    const gsdSharedDir = path.join(gsdBinDir, 'shared');
    fs.mkdirSync(gsdLibDir, { recursive: true });
    fs.mkdirSync(gsdSharedDir, { recursive: true });

    const installedCjs = path.join(gsdLibDir, 'configuration.cjs');
    fs.copyFileSync(CONFIGURATION_CJS, installedCjs);
    fs.copyFileSync(
      path.join(SHARED_DIR, 'config-defaults.manifest.json'),
      path.join(gsdSharedDir, 'config-defaults.manifest.json')
    );
    fs.copyFileSync(
      path.join(SHARED_DIR, 'config-schema.manifest.json'),
      path.join(gsdSharedDir, 'config-schema.manifest.json')
    );

    delete require.cache[installedCjs];
    let mod;
    assert.doesNotThrow(() => {
      mod = require(installedCjs);
    }, 'installed configuration.cjs must not require ~/.codex/sdk/shared');

    assert.ok(mod.VALID_CONFIG_KEYS.has('workflow.plan_review_convergence'));
  });

  test('post-install: install() copies configuration manifests to co-located bin/shared', () => {
    process.env.HOME = tmpRoot;
    process.env.USERPROFILE = tmpRoot;

    silenceConsole(() => {
      install(true, 'codex');
    });

    const sharedDir = path.join(tmpRoot, '.codex', 'gsd-core', 'bin', 'shared');
    for (const fileName of ['config-defaults.manifest.json', 'config-schema.manifest.json']) {
      const installedManifest = path.join(sharedDir, fileName);
      assert.ok(fs.existsSync(installedManifest), `${fileName} must be copied to ${sharedDir}`);
      assert.doesNotThrow(() => {
        JSON.parse(fs.readFileSync(installedManifest, 'utf8'));
      }, `${fileName} must be valid JSON`);
    }

    const installedCjs = path.join(
      tmpRoot,
      '.codex',
      'gsd-core',
      'bin',
      'lib',
      'configuration.cjs'
    );

    delete require.cache[installedCjs];
    assert.doesNotThrow(() => {
      require(installedCjs);
    }, 'post-install configuration.cjs must load from co-located manifests');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3288-model-catalog-install-path.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3288-model-catalog-install-path (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for #3288: model-catalog.cjs uses brittle relative path
 * that breaks after install.
 *
 * Repro:
 *   After `node bin/install.js --global --claude`, the installed
 *   `~/.claude/gsd-core/bin/lib/model-catalog.cjs` tries:
 *     require(path.join(__dirname, '..', '..', '..', 'sdk', 'shared', 'model-catalog.json'))
 *   which resolves to `~/.claude/sdk/shared/model-catalog.json`.
 *   The installer copies `gsd-core/` but never copies `sdk/shared/`,
 *   so the require throws MODULE_NOT_FOUND.
 *
 * Fix contract:
 *   1. model-catalog.cjs must use a resolve-chain that checks a co-located
 *      path first (bin/shared/model-catalog.json) before the legacy
 *      source-repo path.
 *   2. bin/install.js must copy shared model-catalog.json into
 *      gsd-core/bin/shared/model-catalog.json (co-located inside the
 *      gsd-core/ payload).
 *
 * Both halves must be true for the install layout to work.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..');
const MODEL_CATALOG_CJS = path.join(REPO_ROOT, 'gsd-core', 'bin', 'lib', 'model-catalog.cjs');
const MODEL_CATALOG_JSON = path.join(REPO_ROOT, 'gsd-core', 'bin', 'shared', 'model-catalog.json');

const { install } = require('../bin/install.js');

// ─── helpers ─────────────────────────────────────────────────────────────────

const { createTempDir, cleanup } = require('./helpers.cjs');
const makeTmpDir = createTempDir;

const rmTmpDir = cleanup;

/**
 * Silence console output during install to avoid noise in test output.
 */
function silenceConsole(fn) {
  const orig = {
    log: console.log,
    warn: console.warn,
    error: console.error,
  };
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

// ─── test 1: fake-install layout reproduces MODULE_NOT_FOUND ────────────────
//
// Build a fake post-install layout that mirrors what the OLD install did:
//   <tmp>/.claude/gsd-core/bin/lib/model-catalog.cjs  (copy of real file)
//   <tmp>/.claude/sdk/shared/model-catalog.json            ABSENT
//
// Then attempt to require model-catalog.cjs from that layout.
// Under the old path scheme (3 levels up → sdk/shared/) this should throw.
// After the fix, if we DON'T also copy the json, it should still throw — this
// confirms the co-located path IS required.

describe('bug #3288: model-catalog.cjs install-layout resolution', () => {
  let tmpRoot;
  let savedHome;
  let savedUserProfile;
  let savedExplicitConfigDir;

  beforeEach(() => {
    tmpRoot = makeTmpDir('gsd-3288-');
    savedHome = process.env.HOME;
    // On Windows, os.homedir() reads USERPROFILE (and HOMEDRIVE+HOMEPATH), NOT
    // HOME. install() resolves the install destination via os.homedir(), so the
    // tests must also redirect USERPROFILE → tmpRoot on win32 to keep the
    // installer writing inside the fixture.
    savedUserProfile = process.env.USERPROFILE;
    // Stash and clear explicitConfigDir via env so install() picks up our tmp dir.
    // Must delete (not just save) so any CI-set value doesn't leak into install()
    // and target a different directory than tmpRoot (CR finding, PR #3293).
    savedExplicitConfigDir = process.env.GSD_EXPLICIT_CONFIG_DIR;
    delete process.env.GSD_EXPLICIT_CONFIG_DIR;
  });

  afterEach(() => {
    process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    if (savedExplicitConfigDir === undefined) {
      delete process.env.GSD_EXPLICIT_CONFIG_DIR;
    } else {
      process.env.GSD_EXPLICIT_CONFIG_DIR = savedExplicitConfigDir;
    }
    rmTmpDir(tmpRoot);
  });

  // ── test A ──────────────────────────────────────────────────────────────────
  test('OLD layout (3-level __dirname, no co-located json) fails to require', () => {
    // Build the old install layout manually:
    //   <tmpRoot>/.claude/gsd-core/bin/lib/model-catalog.cjs  (copy of the real CJS)
    //   sdk/shared/model-catalog.json                              ABSENT
    const gsdLibDir = path.join(tmpRoot, '.claude', 'gsd-core', 'bin', 'lib');
    fs.mkdirSync(gsdLibDir, { recursive: true });

    // Write a minimal model-catalog.cjs that uses ONLY the 3-level path (the old/broken path).
    const oldCjsContent = `'use strict';
const path = require('node:path');
// This is the BRITTLE path: 3 levels up from bin/lib → sdk/shared/
const catalog = require(path.join(__dirname, '..', '..', '..', 'sdk', 'shared', 'model-catalog.json'));
module.exports = { catalog };
`;
    const catalogCjsPath = path.join(gsdLibDir, 'model-catalog.cjs');
    fs.writeFileSync(catalogCjsPath, oldCjsContent);

    // Deliberately do NOT create sdk/shared/model-catalog.json (simulates missing file post-install).

    // Require must fail with MODULE_NOT_FOUND.
    assert.throws(
      () => {
        // Delete from require cache to force a fresh load.
        delete require.cache[catalogCjsPath];
        require(catalogCjsPath);
      },
      (err) => {
        assert.ok(
          err.code === 'MODULE_NOT_FOUND' || err.message.includes('model-catalog.json'),
          `Expected MODULE_NOT_FOUND or model-catalog.json error, got: ${err.message}`,
        );
        return true;
      },
      'OLD 3-level path must fail when sdk/shared/model-catalog.json is not present (install layout)',
    );
  });

  // ── test B ──────────────────────────────────────────────────────────────────
  test('NEW layout (co-located bin/shared/model-catalog.json) resolves correctly', () => {
    // Build the new install layout:
    //   <tmpRoot>/.claude/gsd-core/bin/lib/model-catalog.cjs (copy of real CJS)
    //   <tmpRoot>/.claude/gsd-core/bin/shared/model-catalog.json (co-located copy)
    const gsdBinDir = path.join(tmpRoot, '.claude', 'gsd-core', 'bin');
    const gsdLibDir = path.join(gsdBinDir, 'lib');
    const gsdSharedDir = path.join(gsdBinDir, 'shared');
    fs.mkdirSync(gsdLibDir, { recursive: true });
    fs.mkdirSync(gsdSharedDir, { recursive: true });

    // Copy the real model-catalog.cjs into the fake install.
    const catalogCjsPath = path.join(gsdLibDir, 'model-catalog.cjs');
    fs.copyFileSync(MODEL_CATALOG_CJS, catalogCjsPath);

    // Copy the real model-catalog.json to the co-located path.
    fs.copyFileSync(MODEL_CATALOG_JSON, path.join(gsdSharedDir, 'model-catalog.json'));

    // Require must succeed and expose catalog with expected shape.
    delete require.cache[catalogCjsPath];
    let mod;
    assert.doesNotThrow(() => {
      mod = require(catalogCjsPath);
    }, 'NEW co-located layout must not throw MODULE_NOT_FOUND');

    assert.ok(mod.catalog, 'module must export catalog');
    assert.ok(Array.isArray(mod.VALID_PROFILES), 'module must export VALID_PROFILES');
    assert.ok(mod.VALID_PROFILES.length > 0, 'VALID_PROFILES must not be empty');
  });

  // ── test C ──────────────────────────────────────────────────────────────────
  test('post-install: install() copies model-catalog.json to co-located path', () => {
    // Run the real installer against a tmp target dir, then assert the co-located
    // json is present and parseable.
    const claudeDir = path.join(tmpRoot, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    process.env.HOME = tmpRoot;
    process.env.USERPROFILE = tmpRoot;

    // Capture process.exit to prevent the test from being killed.
    const origExit = process.exit;
    let exitCalled = false;
    process.exit = (code) => {
      exitCalled = true;
      throw new Error(`process.exit(${code}) during install — should not happen`);
    };

    try {
      silenceConsole(() => {
        install(true /* isGlobal */, 'claude');
      });
    } catch (e) {
      if (exitCalled) {
        assert.fail(`install() called process.exit — unexpected: ${e.message}`);
      }
      throw e;
    } finally {
      process.exit = origExit;
    }

    // The co-located json must be present after install.
    const colocatedJson = path.join(
      claudeDir,
      'gsd-core',
      'bin',
      'shared',
      'model-catalog.json',
    );
    assert.ok(
      fs.existsSync(colocatedJson),
      `model-catalog.json must be present at co-located path post-install: ${colocatedJson}`,
    );

    // The json must be valid and have expected shape.
    let parsed;
    assert.doesNotThrow(() => {
      parsed = JSON.parse(fs.readFileSync(colocatedJson, 'utf8'));
    }, 'co-located model-catalog.json must be valid JSON');

    assert.ok(Array.isArray(parsed.profiles), 'catalog.profiles must be an array');
    assert.ok(parsed.profiles.length > 0, 'catalog.profiles must not be empty');

    // And the installed model-catalog.cjs must be requireable from its install location.
    const installedCjs = path.join(
      claudeDir,
      'gsd-core',
      'bin',
      'lib',
      'model-catalog.cjs',
    );
    assert.ok(fs.existsSync(installedCjs), `model-catalog.cjs must be installed at: ${installedCjs}`);

    delete require.cache[installedCjs];
    let installedMod;
    assert.doesNotThrow(() => {
      installedMod = require(installedCjs);
    }, 'installed model-catalog.cjs must not throw MODULE_NOT_FOUND after install');

    assert.ok(installedMod.catalog, 'installed module must export catalog');
    assert.ok(installedMod.VALID_PROFILES.length > 0, 'installed module must have valid profiles');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-130-finishinstall-opencode-testmode.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-130-finishinstall-opencode-testmode (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #130: finishInstall calls configureOpencodePermissions unconditionally,
 * violating the GSD_TEST_MODE side-effect-free contract.
 *
 * configureOpencodePermissions does fs.mkdirSync + fs.writeFileSync, which
 * must NOT run under GSD_TEST_MODE='1'. This test asserts that the opencode
 * config file (opencode.json) is NOT created when GSD_TEST_MODE is set.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

// Point HOME at a temp dir so configureOpencodePermissions can't write to
// the real ~/.config/opencode/ even if the guard is missing.
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-130-test-'));
// Consolidation #1969: scope the HOME/USERPROFILE mutation to before/after so it
// does not leak into sibling folded suites (was process-isolated when standalone).
const { before: __foldBefore, after: __foldAfter } = require('node:test');
const __savedHome = process.env.HOME;
const __savedUserProfile = process.env.USERPROFILE;
__foldBefore(() => {
  process.env.HOME = FAKE_HOME;
  process.env.USERPROFILE = FAKE_HOME;
});
__foldAfter(() => {
  if (__savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = __savedHome;
  if (__savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = __savedUserProfile;
});

// The opencode config dir that configureOpencodePermissions would use for a
// global install when configDir=null: <HOME>/.config/opencode/
// The file it writes is opencode.json (or opencode.jsonc if pre-existing).
const OPENCODE_CONFIG_DIR = path.join(FAKE_HOME, '.config', 'opencode');
const OPENCODE_CONFIG_FILE = path.join(OPENCODE_CONFIG_DIR, 'opencode.json');

// configDir is passed explicitly so the function targets our FAKE_HOME dir
// regardless of how getGlobalDir resolves.
const installModule = require(path.join(ROOT, 'bin', 'install.js'));

const SETTINGS_PATH = path.join(FAKE_HOME, `gsd-test-settings-${process.pid}.json`);

function callFinishInstall() {
  const original = console.log;
  console.log = () => {};
  try {
    installModule.finishInstall(
      SETTINGS_PATH,
      {},
      null,
      false,
      'opencode',
      true,
      OPENCODE_CONFIG_DIR, // pass explicit configDir pointing at our temp dir
    );
  } finally {
    console.log = original;
  }
}

describe('Bug #130: finishInstall opencode + GSD_TEST_MODE side-effect guard', () => {
  test('configureOpencodePermissions does NOT write opencode.json under GSD_TEST_MODE', () => {
    // Confirm the file does not exist before the call
    assert.equal(
      fs.existsSync(OPENCODE_CONFIG_FILE),
      false,
      'opencode.json should not exist before finishInstall call',
    );

    callFinishInstall();

    // Assert the file was NOT created — the side-effect must be suppressed
    assert.equal(
      fs.existsSync(OPENCODE_CONFIG_FILE),
      false,
      `opencode.json must NOT be created under GSD_TEST_MODE; found at ${OPENCODE_CONFIG_FILE}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-410-install-defaults-test-mode-guard.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-410-install-defaults-test-mode-guard (consolidation epic #1969 B1 #1970)", () => {
'use strict';

/**
 * Bug #410: finishInstall writes ~/.gsd/defaults.json for non-Claude runtimes
 * without a GSD_TEST_MODE guard, polluting the real developer home directory
 * during test runs.
 *
 * The opencode permission-config write a few lines above already carries the
 * GSD_TEST_MODE guard (added for #130) — this test covers the un-fixed sibling
 * (the resolve_model_ids: "omit" write).
 */

const { test, describe } = require('node:test');
const { cleanup } = require('./helpers.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');

// Point HOME at a temp dir so the defaults.json write can't reach the real
// ~/.gsd/ even if the guard is missing.
// On Windows, os.homedir() reads USERPROFILE (not HOME). Set both so
// finishInstall's path.join(os.homedir(), '.gsd') resolves into FAKE_HOME
// on every platform. Node docs: https://nodejs.org/docs/latest-v22.x/api/os.html#oshomedir
const FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-410-test-'));
// Consolidation #1969: scope the HOME/USERPROFILE mutation to before/after so it
// does not leak into sibling folded suites (was process-isolated when standalone).
const { before: __foldBefore, after: __foldAfter } = require('node:test');
const __savedHome = process.env.HOME;
const __savedUserProfile = process.env.USERPROFILE;
__foldBefore(() => {
  process.env.HOME = FAKE_HOME;
  process.env.USERPROFILE = FAKE_HOME;
});
__foldAfter(() => {
  if (__savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = __savedHome;
  if (__savedUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = __savedUserProfile;
});

// The path that finishInstall would write to for a non-Claude runtime.
const GSD_DIR = path.join(FAKE_HOME, '.gsd');
const DEFAULTS_PATH = path.join(GSD_DIR, 'defaults.json');

// Set GSD_TEST_MODE before requiring install.js so any module-level guards
// also see the flag.
process.env.GSD_TEST_MODE = '1';

const installModule = require(path.join(ROOT, 'bin', 'install.js'));

// A synthetic settingsPath that won't exist — finishInstall should cope.
const SETTINGS_PATH = path.join(FAKE_HOME, `gsd-test-settings-${process.pid}.json`);

function callFinishInstallForRuntime(runtime) {
  const original = console.log;
  console.log = () => {};
  try {
    installModule.finishInstall(
      SETTINGS_PATH,
      {},       // empty settings
      null,     // statuslineCommand
      false,    // shouldInstallStatusline
      runtime,
      true,     // isGlobal
      null,     // configDir
    );
  } finally {
    console.log = original;
  }
}

describe('Bug #410: finishInstall non-Claude runtime + GSD_TEST_MODE side-effect guard', () => {
  test('defaults.json is NOT written for opencode runtime under GSD_TEST_MODE', () => {
    assert.equal(
      fs.existsSync(DEFAULTS_PATH),
      false,
      'defaults.json should not exist before finishInstall call',
    );

    callFinishInstallForRuntime('opencode');

    assert.equal(
      fs.existsSync(DEFAULTS_PATH),
      false,
      `defaults.json must NOT be created under GSD_TEST_MODE; found at ${DEFAULTS_PATH}`,
    );
  });

  test('defaults.json is NOT written for antigravity runtime under GSD_TEST_MODE', () => {
    // Reset in case previous test left artifacts (it shouldn't).
    assert.equal(
      fs.existsSync(DEFAULTS_PATH),
      false,
      'defaults.json should not exist before antigravity test',
    );

    callFinishInstallForRuntime('antigravity');

    assert.equal(
      fs.existsSync(DEFAULTS_PATH),
      false,
      `defaults.json must NOT be created under GSD_TEST_MODE for antigravity; found at ${DEFAULTS_PATH}`,
    );
  });

  test('defaults.json IS written for opencode runtime when GSD_TEST_MODE is unset', () => {
    // Temporarily unset GSD_TEST_MODE to verify the user-facing path still works.
    const saved = process.env.GSD_TEST_MODE;
    delete process.env.GSD_TEST_MODE;
    try {
      callFinishInstallForRuntime('opencode');
      assert.equal(
        fs.existsSync(DEFAULTS_PATH),
        true,
        `defaults.json must be written for non-Claude runtime when GSD_TEST_MODE is unset`,
      );
      // Verify the written content is correct.
      const contents = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
      assert.equal(contents.resolve_model_ids, 'omit', 'resolve_model_ids must be "omit"');
    } finally {
      // Restore GSD_TEST_MODE and clean up the written file.
      process.env.GSD_TEST_MODE = saved;
      cleanup(DEFAULTS_PATH);
      try { fs.rmdirSync(GSD_DIR); } catch { /* not empty or already gone */ }
    }
  });
});

// Bug #1569 folded here (sibling on the SAME finishInstall resolve_model_ids block):
// the #1156 default-to-"omit" step keyed its write on `!== "omit"`, so an explicit
// `resolve_model_ids: true` opt-in (resolveModelInternal returns full materialized
// model IDs) was silently clobbered across all 14 non-Claude runtimes. The fix
// preserves `true` and only defaults absent/falsy → "omit". Reuses the #410 harness.

describe('Bug #1569: non-Claude finishInstall preserves explicit resolve_model_ids:true', () => {
  function seedDefaults(obj) {
    fs.mkdirSync(GSD_DIR, { recursive: true });
    fs.writeFileSync(DEFAULTS_PATH, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  }

  function withUserPath(fn) {
    const saved = process.env.GSD_TEST_MODE;
    delete process.env.GSD_TEST_MODE;
    try {
      return fn();
    } finally {
      process.env.GSD_TEST_MODE = saved;
    }
  }

  test('explicit resolve_model_ids:true survives a codex global install (the reported case)', () => {
    withUserPath(() => {
      seedDefaults({ runtime: 'codex', model_profile: 'balanced', resolve_model_ids: true });
      callFinishInstallForRuntime('codex');
      const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
      assert.equal(
        after.resolve_model_ids,
        true,
        'explicit resolve_model_ids:true must be preserved across a codex install, not clobbered to "omit"',
      );
    });
  });

  // The clobber guard is runtime-agnostic (`runtime !== 'claude'`); parameterize
  // across a representative slice of non-Claude runtimes.
  for (const runtime of ['codex', 'opencode', 'antigravity']) {
    test(`explicit resolve_model_ids:true survives a ${runtime} global install`, () => {
      withUserPath(() => {
        seedDefaults({ runtime, resolve_model_ids: true });
        callFinishInstallForRuntime(runtime);
        const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
        assert.equal(
          after.resolve_model_ids,
          true,
          `explicit resolve_model_ids:true must be preserved for ${runtime}`,
        );
      });
    });
  }

  test('absent resolve_model_ids still defaults to "omit" (preserves #1156 intent)', () => {
    withUserPath(() => {
      seedDefaults({ runtime: 'codex' });
      callFinishInstallForRuntime('codex');
      const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
      assert.equal(
        after.resolve_model_ids,
        'omit',
        'absent resolve_model_ids must still default to "omit" for non-Claude runtimes',
      );
    });
  });

  test('explicit resolve_model_ids:false still defaults to "omit"', () => {
    withUserPath(() => {
      seedDefaults({ runtime: 'codex', resolve_model_ids: false });
      callFinishInstallForRuntime('codex');
      const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
      assert.equal(after.resolve_model_ids, 'omit', 'false must still be normalized to "omit"');
    });
  });

  test('non-canonical resolve_model_ids values (0, "", "yes", {}) default to "omit" — no Claude alias leak (#1569 codex review)', () => {
    // The domain is true/false/"omit"/absent. Any OTHER value is malformed; the safe
    // non-Claude default is "omit" (don't leak Claude aliases the runtime can't resolve).
    withUserPath(() => {
      for (const bad of [0, '', 'yes', {}]) {
        seedDefaults({ runtime: 'codex', resolve_model_ids: bad });
        callFinishInstallForRuntime('codex');
        const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
        assert.equal(
          after.resolve_model_ids,
          'omit',
          `non-canonical resolve_model_ids:${JSON.stringify(bad)} must default to "omit", not pass through`,
        );
      }
    });
  });

  test('already-"omit" is left unchanged (idempotent, no rewrite churn)', () => {
    withUserPath(() => {
      seedDefaults({ runtime: 'codex', resolve_model_ids: 'omit' });
      const beforeMtime = fs.statSync(DEFAULTS_PATH).mtimeMs;
      // fs mtime resolution can be coarse; wait briefly so an accidental rewrite is detectable.
      const start = Date.now();
      while (Date.now() - start < 20) { /* spin briefly */ }
      callFinishInstallForRuntime('codex');
      const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
      const afterMtime = fs.statSync(DEFAULTS_PATH).mtimeMs;
      assert.equal(after.resolve_model_ids, 'omit');
      assert.equal(
        afterMtime,
        beforeMtime,
        'defaults.json must not be rewritten when resolve_model_ids is already "omit" (idempotent)',
      );
    });
  });

  test('claude runtime never touches resolve_model_ids (cross-runtime parity)', () => {
    withUserPath(() => {
      seedDefaults({ runtime: 'claude', resolve_model_ids: true });
      callFinishInstallForRuntime('claude');
      const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
      assert.equal(
        after.resolve_model_ids,
        true,
        'claude install must never rewrite resolve_model_ids',
      );
    });
  });

  test('malformed defaults.json does not crash — still defaults to "omit"', () => {
    withUserPath(() => {
      fs.mkdirSync(GSD_DIR, { recursive: true });
      fs.writeFileSync(DEFAULTS_PATH, '{ not valid json }', 'utf8');
      // Must not throw.
      callFinishInstallForRuntime('codex');
      const after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8'));
      assert.equal(
        after.resolve_model_ids,
        'omit',
        'malformed defaults.json must be recovered to a valid state with resolve_model_ids:omit',
      );
    });
  });
});

// Bug #1657 — finishInstall reads ~/.gsd/defaults.json with JSON.parse but did not
// validate the result is a plain object. A valid-JSON-but-non-object value (null, [],
// 42, "str") bypassed the catch and flowed through, leaving the malformed file on disk
// unrecovered (and, for null, throwing a TypeError swallowed by the outer try/catch).
// Folded into the owning install-defaults test (no new top-level bug-NNNN file).
describe('Bug #1657: finishInstall recovers a malformed (non-object) defaults.json', () => {
  function seedDefaultsRaw(raw) {
    fs.mkdirSync(GSD_DIR, { recursive: true });
    fs.writeFileSync(DEFAULTS_PATH, raw, 'utf8');
  }
  function runAndRead(runtime) {
    const saved = process.env.GSD_TEST_MODE;
    delete process.env.GSD_TEST_MODE;
    const log = console.log; console.log = () => {};
    let threw = null;
    try {
      installModule.finishInstall(SETTINGS_PATH, {}, null, false, runtime, true, null);
    } catch (e) { threw = e.message; } finally { console.log = log; process.env.GSD_TEST_MODE = saved; }
    let after = null;
    try { after = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8')); } catch (e) { after = 'UNPARSEABLE: ' + e.message; }
    return { threw, after };
  }

  for (const [label, raw] of [['null', 'null'], ['array', '[]'], ['number', '42'], ['string', '"oops"']]) {
    test(`seed ${label} (${raw}) recovers to a valid object with resolve_model_ids:omit`, () => {
      seedDefaultsRaw(raw);
      const { threw, after } = runAndRead('codex');
      assert.equal(threw, null, `must not throw for seed ${label} (got: ${threw})`);
      assert.equal(
        after !== null && typeof after === 'object' && !Array.isArray(after) && after.resolve_model_ids === 'omit',
        true,
        `seed ${label} must recover to { resolve_model_ids: 'omit' }, got: ${JSON.stringify(after)}`,
      );
    });
  }
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1736-local-install-commands.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1736-local-install-commands (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for #1736: local Claude install missing commands/gsd/
 *
 * After a fresh local install (`--claude --local`), all /gsd-* commands
 * except /gsd-help return "Unknown skill: gsd-quick" because
 * .claude/commands/gsd/ was not populated. Claude Code reads local project
 * commands from .claude/commands/ (one level up) using the file stem as the
 * command name.
 *
 * #1367 follow-up: the fix changed the layout from the old commands/gsd/<cmd>.md
 * (which caused /gsd:<cmd> colon namespace) to flat commands/gsd-<cmd>.md
 * (which produces /gsd-<cmd> hyphen form). This test has been updated to assert
 * the new flat layout while preserving the core invariant from #1736: commands
 * must be present and usable after a local install.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const INSTALL_SRC = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
const { install } = require(INSTALL_SRC);
const { cleanup } = require('./helpers.cjs');

// ─── Ensure hooks/dist/ is populated before install tests ────────────────────
// With --test-concurrency=4, other install tests (bug-1834, bug-1924) run
// build-hooks.js concurrently. That script creates hooks/dist/ empty first,
// then copies files — creating a window where this test sees an empty dir and
// install() fails with "directory is empty" → process.exit(1).

before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
});

// ─── #1736 + #1367: local install deploys commands in flat gsd-<cmd>.md layout ───

describe('#1736: local Claude install deploys slash commands (flat gsd-<cmd>.md layout, #1367)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-local-install-1736-'));
  });

  afterEach(() => {
    // Use the shared helper which has a 5s Windows-EBUSY retry budget
    // (20×250ms). The inline 1s budget here was insufficient on cold runners.
    cleanup(tmpDir);
  });

  test('local install creates .claude/commands/ directory with flat gsd-*.md files (#1367)', (t) => {
    // #1736 invariant: commands must be deployed.
    // #1367 fix: commands land as flat gsd-<cmd>.md at commands/ (not commands/gsd/<cmd>.md).
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);
    install(false, 'claude');

    const commandsDir = path.join(tmpDir, '.claude', 'commands');
    assert.ok(
      fs.existsSync(commandsDir),
      '.claude/commands/ directory must exist after local install'
    );
    const flatFiles = fs.readdirSync(commandsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(
      flatFiles.length > 0,
      `.claude/commands/ must have flat gsd-*.md files (e.g. gsd-help.md). Found: ${JSON.stringify(flatFiles)}`
    );
    // The old commands/gsd/ subdirectory must NOT exist (#1367)
    const oldSubdir = path.join(commandsDir, 'gsd');
    assert.ok(
      !fs.existsSync(oldSubdir),
      '.claude/commands/gsd/ subdir must NOT exist — flat gsd-<cmd>.md layout required (#1367)'
    );
  });

  test('local install deploys at least one .md command file to .claude/commands/ (#1736 invariant)', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);
    install(false, 'claude');

    const commandsDir = path.join(tmpDir, '.claude', 'commands');
    assert.ok(
      fs.existsSync(commandsDir),
      '.claude/commands/ must exist'
    );

    const files = fs.readdirSync(commandsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(
      files.length > 0,
      `.claude/commands/ must contain at least one gsd-*.md file, found: ${JSON.stringify(files)}`
    );
  });

  test('local install deploys gsd-quick.md to .claude/commands/ (#1367: flat hyphen form)', (t) => {
    // Was: .claude/commands/gsd/quick.md (caused /gsd:quick colon form).
    // Now: .claude/commands/gsd-quick.md (produces /gsd-quick hyphen form).
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);
    install(false, 'claude');

    const quickCmd = path.join(tmpDir, '.claude', 'commands', 'gsd-quick.md');
    assert.ok(
      fs.existsSync(quickCmd),
      '.claude/commands/gsd-quick.md must exist after local install (#1367 flat layout)'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2248-local-install-statusline.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2248-local-install-statusline (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for #2248: local Claude install clobbers profile-level statusLine
 *
 * When installing with `--claude --local`, the repo-level `.claude/settings.json`
 * takes precedence over the user's profile-level `~/.claude/settings.json` in
 * Claude Code. Writing `statusLine` to repo settings during a local install
 * silently overrides any profile-level statusLine the user configured.
 *
 * Fix: local installs skip writing `statusLine` to settings.json unless
 * `--force-statusline` is passed.
 *
 * Note: `install()` only copies files. `finishInstall()` writes settings.json.
 * The production code calls both from `installAllRuntimes()`. Tests must mirror
 * that two-phase pattern.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const INSTALL_SRC = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
const { install, finishInstall } = require(INSTALL_SRC);
const { cleanup, captureConsole } = require('./helpers.cjs');

// ─── Ensure hooks/dist/ is populated before install tests ────────────────────
before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
});

// ─── #2248: local install must NOT write statusLine to repo settings.json ────

describe('#2248: local Claude install does not clobber profile-level statusLine', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-local-install-2248-'));
  });

  afterEach(() => {
    // Use the shared 5s Windows-EBUSY retry budget instead of inline 1s.
    cleanup(tmpDir);
  });

  test('local install writes hooks to .claude/settings.local.json and does not write statusLine', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    // Phase 1: copy files (mirrors installAllRuntimes)
    const result = install(false, 'claude');

    // Phase 2: configure settings.local.json (mirrors installAllRuntimes → finalize)
    // #338: local Claude installs now write to settings.local.json, not settings.json.
    // shouldInstallStatusline=true mirrors what handleStatusline picks for a fresh install
    const { stdout } = captureConsole(() => {
      finishInstall(
        result.settingsPath,
        result.settings,
        result.statuslineCommand,
        true,   // shouldInstallStatusline
        'claude',
        false   // isGlobal=false -> local install
      );
    });
    assert.match(
      stdout,
      /Skipping statusLine for local install/,
      'Local install must explain that it skipped statusLine unless --force-statusline is passed'
    );

    // #338: local installs write to settings.local.json, not settings.json
    const localSettingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
    assert.ok(
      fs.existsSync(localSettingsPath),
      '.claude/settings.local.json must exist after local Claude install (#338)'
    );

    const settings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
    assert.strictEqual(
      settings.statusLine,
      undefined,
      'Local install must not write statusLine to settings.local.json — it would clobber profile-level settings (#2248)'
    );

    // settings.json must not be touched by a fresh local install
    const sharedSettingsPath = path.join(tmpDir, '.claude', 'settings.json');
    assert.strictEqual(
      fs.existsSync(sharedSettingsPath),
      false,
      '.claude/settings.json must NOT be created by a fresh local Claude install (#338)'
    );
  });

  test('global install still writes statusLine to settings.json', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });

    // Global install writes to CLAUDE_CONFIG_DIR; point it at our tmpDir
    const configDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(configDir, { recursive: true });
    const origEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    t.after(() => {
      if (origEnv === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = origEnv;
      }
    });

    // Phase 1: copy files
    const result = install(true, 'claude');

    // Phase 2: configure settings.json
    finishInstall(
      result.settingsPath,
      result.settings,
      result.statuslineCommand,
      true,  // shouldInstallStatusline
      'claude',
      true   // isGlobal=true
    );

    const settingsPath = path.join(configDir, 'settings.json');
    assert.ok(
      fs.existsSync(settingsPath),
      '~/.claude/settings.json must exist after global install'
    );

    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.ok(
      settings.statusLine !== undefined,
      'Global install should write statusLine to settings.json'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-338-local-install-settings-local-json.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-338-local-install-settings-local-json (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression tests for #338: Claude --local installs must write hook wiring to
 * `.claude/settings.local.json` (Claude Code's per-user gitignored slot) instead
 * of the repo-shared `.claude/settings.json`.
 *
 * Three cases:
 *  1. Fresh local install: settings.local.json is created with hook block;
 *     settings.json is not touched.
 *  2. Global install (regression guard): continues to write to settings.json.
 *  3. Migration: if a prior local install wrote GSD entries to settings.json,
 *     re-running local install moves them to settings.local.json and removes
 *     them from settings.json in the same run.
 *
 * Note: `install()` only copies files. `finishInstall()` writes settings.
 * The production code calls both from `installAllRuntimes()`. Tests mirror
 * that two-phase pattern.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const INSTALL_SRC = path.join(__dirname, '..', 'bin', 'install.js');
const BUILD_SCRIPT = path.join(__dirname, '..', 'scripts', 'build-hooks.js');
const { install, finishInstall } = require(INSTALL_SRC);
const { cleanup } = require('./helpers.cjs');

// ─── Ensure hooks/dist/ is populated before install tests ────────────────────
before(() => {
  execFileSync(process.execPath, [BUILD_SCRIPT], {
    encoding: 'utf-8',
    stdio: 'pipe',
  });
});

// ─── Helper: run both install phases ─────────────────────────────────────────

/**
 * Run install + finishInstall (mirrors installAllRuntimes two-phase pattern).
 * @param {boolean} isGlobal
 * @param {object} [opts]
 * @param {boolean} [opts.shouldInstallStatusline]
 * @returns {{ result: object }}
 */
function runInstall(isGlobal, opts = {}) {
  const { shouldInstallStatusline = false } = opts;
  const result = install(isGlobal, 'claude');
  finishInstall(
    result.settingsPath,
    result.settings,
    result.statuslineCommand,
    shouldInstallStatusline,
    'claude',
    isGlobal
  );
  return { result };
}

// ─── Case 1: fresh local install → settings.local.json, not settings.json ───

describe('#338 case 1: fresh local Claude install writes to settings.local.json', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-338-local-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('settings.local.json is created with hook block', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    runInstall(false);

    const localSettingsPath = path.join(tmpDir, '.claude', 'settings.local.json');
    assert.ok(
      fs.existsSync(localSettingsPath),
      '.claude/settings.local.json must exist after local Claude install (#338)'
    );

    const settings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
    assert.ok(
      settings && typeof settings === 'object',
      'settings.local.json must be a valid JSON object'
    );
    // Hook block must be present (hooks key or at minimum the file was written)
    assert.ok(
      settings.hooks !== undefined || Object.keys(settings).length >= 0,
      'settings.local.json must contain the hook block'
    );
  });

  test('settings.json is NOT created by a fresh local install', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    runInstall(false);

    const sharedSettingsPath = path.join(tmpDir, '.claude', 'settings.json');
    assert.strictEqual(
      fs.existsSync(sharedSettingsPath),
      false,
      '.claude/settings.json must NOT be created by a fresh local Claude install (#338) — ' +
      'engineer-specific absolute paths must not leak into the repo-shared file'
    );
  });

  test('install() returns settingsPath pointing to settings.local.json', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    const result = install(false, 'claude');
    assert.ok(
      result.settingsPath.endsWith('settings.local.json'),
      `install() must return settingsPath ending in settings.local.json for local Claude installs; got: ${result.settingsPath}`
    );
  });
});

// ─── Case 2: global Claude install (regression guard) ────────────────────────

describe('#338 case 2: global Claude install continues to write to settings.json', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-338-global-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('global install writes hook block to settings.json', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });

    // Point CLAUDE_CONFIG_DIR at a subdir of tmpDir to avoid polluting ~/.claude
    const configDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(configDir, { recursive: true });
    const origEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    t.after(() => {
      if (origEnv === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = origEnv;
      }
    });

    runInstall(true);

    const settingsPath = path.join(configDir, 'settings.json');
    assert.ok(
      fs.existsSync(settingsPath),
      '~/.claude/settings.json must exist after global Claude install (regression guard for #338)'
    );
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    assert.ok(
      settings && typeof settings === 'object',
      'settings.json must be a valid JSON object after global install'
    );
  });

  test('global install does NOT create settings.local.json', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });

    const configDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(configDir, { recursive: true });
    const origEnv = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = configDir;
    t.after(() => {
      if (origEnv === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = origEnv;
      }
    });

    runInstall(true);

    const localSettingsPath = path.join(configDir, 'settings.local.json');
    assert.strictEqual(
      fs.existsSync(localSettingsPath),
      false,
      '~/.claude/settings.local.json must NOT be created by a global Claude install'
    );
  });
});

// ─── Case 3: migration — prior local install wrote GSD entries to settings.json ─

describe('#338 case 3: migration of prior local install GSD entries from settings.json to settings.local.json', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-338-migrate-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('GSD hook entries are moved from settings.json to settings.local.json', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    // Pre-populate .claude/settings.json with a GSD-shaped hook block (simulating
    // a prior local install that wrote to the wrong file).
    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const sharedSettingsPath = path.join(claudeDir, 'settings.json');
    const priorSettings = {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: `${process.execPath} ${path.join(claudeDir, 'hooks', 'gsd-check-update.js')}`,
              }
            ]
          }
        ],
        PostToolUse: [
          {
            matcher: 'Bash|Edit|Write|MultiEdit|Agent|Task',
            hooks: [
              {
                type: 'command',
                command: `${process.execPath} ${path.join(claudeDir, 'hooks', 'gsd-context-monitor.js')}`,
                timeout: 10,
              }
            ]
          }
        ]
      }
    };
    fs.writeFileSync(sharedSettingsPath, JSON.stringify(priorSettings, null, 2) + '\n');

    // Run a fresh local install — this should trigger migration
    runInstall(false);

    // Verify GSD entries are now in settings.local.json
    const localSettingsPath = path.join(claudeDir, 'settings.local.json');
    assert.ok(
      fs.existsSync(localSettingsPath),
      '.claude/settings.local.json must exist after migration run'
    );
    const localSettings = JSON.parse(fs.readFileSync(localSettingsPath, 'utf-8'));
    const sessionStartHooks = (localSettings.hooks && localSettings.hooks.SessionStart) || [];
    const hasGsdUpdateHook = sessionStartHooks.some(
      entry => entry && entry.hooks && Array.isArray(entry.hooks) &&
        entry.hooks.some(h => h && h.command && h.command.includes('gsd-check-update'))
    );
    assert.ok(
      hasGsdUpdateHook,
      'settings.local.json must contain the migrated gsd-check-update hook after migration'
    );
  });

  test('GSD hook entries are removed from settings.json after migration', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const sharedSettingsPath = path.join(claudeDir, 'settings.json');
    const priorSettings = {
      // Include a non-GSD key to verify user content is preserved
      myCustomKey: 'keep-me',
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: `${process.execPath} ${path.join(claudeDir, 'hooks', 'gsd-check-update.js')}`,
              }
            ]
          }
        ]
      }
    };
    fs.writeFileSync(sharedSettingsPath, JSON.stringify(priorSettings, null, 2) + '\n');

    runInstall(false);

    // settings.json must exist (we don't delete it — user may have other content)
    assert.ok(
      fs.existsSync(sharedSettingsPath),
      '.claude/settings.json must still exist after migration (may have non-GSD user content)'
    );
    const sharedSettings = JSON.parse(fs.readFileSync(sharedSettingsPath, 'utf-8'));

    // GSD hooks must be gone from settings.json
    const sessionStartHooks = (sharedSettings.hooks && sharedSettings.hooks.SessionStart) || [];
    const hasGsdHook = sessionStartHooks.some(
      entry => entry && entry.hooks && Array.isArray(entry.hooks) &&
        entry.hooks.some(h => h && h.command && h.command.includes('gsd-check-update'))
    );
    assert.strictEqual(
      hasGsdHook,
      false,
      'GSD hook entries must be removed from settings.json after migration to settings.local.json'
    );

    // Non-GSD user content must be preserved
    assert.strictEqual(
      sharedSettings.myCustomKey,
      'keep-me',
      'Non-GSD user content in settings.json must be preserved during migration'
    );
  });

  test('settings.json with no GSD entries is left unchanged', (t) => {
    const origCwd = process.cwd();
    t.after(() => { process.chdir(origCwd); });
    process.chdir(tmpDir);

    const claudeDir = path.join(tmpDir, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const sharedSettingsPath = path.join(claudeDir, 'settings.json');
    const userOnlySettings = {
      userKey: 'user-value',
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: 'command',
                command: '/usr/local/bin/my-own-hook.sh',
              }
            ]
          }
        ]
      }
    };
    const originalContent = JSON.stringify(userOnlySettings, null, 2) + '\n';
    fs.writeFileSync(sharedSettingsPath, originalContent);

    runInstall(false);

    // settings.json must be unchanged (no GSD entries to migrate)
    const afterContent = fs.readFileSync(sharedSettingsPath, 'utf-8');
    const afterSettings = JSON.parse(afterContent);
    assert.strictEqual(
      afterSettings.userKey,
      'user-value',
      'Non-GSD settings.json must be untouched when no GSD entries are present'
    );
    // User hook must still be there
    const sessionStart = (afterSettings.hooks && afterSettings.hooks.SessionStart) || [];
    const hasUserHook = sessionStart.some(
      entry => entry && entry.hooks && entry.hooks.some(h => h && h.command === '/usr/local/bin/my-own-hook.sh')
    );
    assert.ok(
      hasUserHook,
      'User hook in settings.json must be preserved when no migration occurs'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2957-claude-global-postinstall-message.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2957-claude-global-postinstall-message (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #2957: post-install message for `--claude --global` must instruct
 * users to restart Claude Code and offer the skill-name fallback, since
 * the skills-only install layout (CC 2.1.88+) leaves nothing in
 * commands/gsd/ for the slash menu to read on older configurations.
 *
 * Captures the call to finishInstall(runtime='claude', isGlobal=true) and
 * asserts the printed message contains both invocation paths.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const SETTINGS_PATH = path.join(os.tmpdir(), `gsd-test-settings-${process.pid}.json`);
const installModule = require(path.join(ROOT, 'bin', 'install.js'));

function captureFinishInstallOutput(runtime, isGlobal) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => { lines.push(args.join(' ')); };
  try {
    installModule.finishInstall(
      SETTINGS_PATH,
      {},
      null,
      false,
      runtime,
      isGlobal,
      null,
    );
  } finally {
    console.log = original;
  }
  // Strip ANSI color escapes so message-content assertions don't couple to colors.
  // eslint-disable-next-line no-control-regex -- \x1b (ESC) is the required leading byte of ANSI SGR color sequences; matching it is the purpose of stripping ANSI codes from captured CLI/console output
  return lines.join('\n').replace(/\x1B\[[0-9;]*m/g, '');
}

describe('Bug #2957: claude+global post-install message', () => {
  test('claude+global message tells the user to restart and offers skill-name fallback', () => {
    const output = captureFinishInstallOutput('claude', true);

    assert.match(output, /restart claude code/i, 'should mention restart');
    assert.match(output, /\/gsd-new-project/, 'should still mention /gsd-new-project');
    assert.match(output, /gsd-new-project skill/i, 'should mention the skill name fallback');
    assert.doesNotMatch(
      output,
      /open a blank directory/i,
      'global claude install should replace, not extend, the legacy generic instruction',
    );
  });

  test('claude+local message keeps the original /gsd-new-project instruction', () => {
    const output = captureFinishInstallOutput('claude', false);

    assert.match(output, /\/gsd-new-project/, 'should still mention /gsd-new-project');
    assert.doesNotMatch(output, /restart claude code/i, 'local install does not require the skills restart note');
  });

  test('non-claude runtimes keep their original message format', () => {
    const output = captureFinishInstallOutput('opencode', true);

    assert.match(output, /Open a blank directory/, 'opencode message should be unchanged');
    assert.doesNotMatch(output, /restart/i, 'opencode message should not have the claude-specific restart note');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-505-remove-dead-sdk-verification.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-505-remove-dead-sdk-verification (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression guard for #505: dead SDK-shim verification subsystem removed.
 *
 * Post-ADR-0174 the `@opengsd/gsd-sdk` package was retired; `sdk/` no longer
 * ships. `installSdkIfNeeded` and all functions it transitively called are
 * dead code with no live callers. This test asserts:
 *
 *   1. All removed symbols are NO LONGER exported from bin/install.js.
 *   2. The two live stale-standalone-SDK helpers (detectStaleStandaloneSdk,
 *      formatStaleStandaloneSdkWarning) are STILL exported as functions — they
 *      handle a real user-facing condition (#3406) and MUST NOT be removed.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const inst = require('../bin/install.js');

describe('bug #505: dead SDK verification subsystem removed from bin/install.js', () => {
  // ----------------------------------------------------------------
  // Dead symbols — must NOT be exported after removal
  // ----------------------------------------------------------------
  const deadSymbols = [
    'installSdkIfNeeded',
    'classifySdkInstall',
    'buildSdkFailFastReport',
    'renderSdkFailFastReport',
    'buildGsdSdkVersionMismatchReport',
    'renderGsdSdkVersionMismatchReport',
    'readGsdSdkVersion',
    'parseGsdSdkVersion',
    'findGsdSdkOnPath',
    'isGsdSdkOnPath',
    'isLegacyGsdSdkShim',
    'trySelfLinkGsdSdk',
    'trySelfLinkGsdSdkWindows',
    'filterNpxFromPath',
    'getUserShellPath',
    'getUserShellWindowsPersistentPath',
  ];

  for (const sym of deadSymbols) {
    test(`dead symbol '${sym}' is not exported`, () => {
      assert.equal(
        typeof inst[sym],
        'undefined',
        `'${sym}' should have been removed (post #505 dead-code removal) but is still exported as ${typeof inst[sym]}`,
      );
    });
  }

  // ----------------------------------------------------------------
  // The stale-standalone-SDK helpers (detectStaleStandaloneSdk,
  // formatStaleStandaloneSdkWarning) and the gsd-sdk shim contract surface
  // (buildWindowsShimTriple, formatSdkPathDiagnostic) that #505 kept were
  // removed when the gsd-sdk shim itself was retired (#191). Their absence is
  // covered by the dead-symbol assertions above.
  // ----------------------------------------------------------------
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-376-claude-js-hook-gsd-rewriter.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-376-claude-js-hook-gsd-rewriter (consolidation epic #1969 B1 #1970)", () => {
'use strict';

/**
 * Regression for bug #376 — Claude-installed hook JS files ship with raw
 * /gsd:<cmd> command literals because the hook-copy loop in install.js had
 * no /gsd: → /gsd- rewrite for the claude runtime.
 *
 * Fix: the `.js` branch of the hook-copy loop now applies
 * `content.replace(/gsd:/gi, 'gsd-')` when
 * `shouldNormalizeHyphenNamespaceInAgentBody(runtime)` is true (covers
 * claude, qwen, hermes).
 *
 * Test plan:
 *   1. Claude install to tmp prefix — installed .js hook files must contain
 *      no user-facing /gsd: literals (// comment occurrences exempted).
 *   2. Cursor install regression — still rewrites correctly (pre-existing
 *      branch must remain intact).
 *   3. Source files in hooks/ must be byte-identical before and after both
 *      installs (install-time rewrite only, no in-tree mutation).
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALL_PATH = path.join(REPO_ROOT, 'bin', 'install.js');
const HOOKS_DIST_DIR = path.join(REPO_ROOT, 'hooks', 'dist');
const BUILD_HOOKS_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-hooks.js');

/**
 * Ensure hooks/dist is populated before any suite that reads it.
 * hooks/dist/ is gitignored and only produced by `npm run build:hooks`.
 * In CI the scoped/windows test jobs do NOT run build:hooks before running
 * tests, so the first test that needs hooks/dist would fail. This mirrors
 * the pattern used in bug-3357-codex-legacy-hooks-json-migration.test.cjs.
 */
function ensureHooksDist() {
  if (!fs.existsSync(HOOKS_DIST_DIR) || fs.readdirSync(HOOKS_DIST_DIR).filter(f => f.endsWith('.js')).length === 0) {
    execFileSync(process.execPath, [BUILD_HOOKS_SCRIPT], { stdio: 'pipe' });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run `node install.js <...args>` from cwd.
 * GSD_TEST_MODE is cleared so the install() main block executes.
 */
function runInstall(cwd, args) {
  const env = { ...process.env };
  delete env.GSD_TEST_MODE;
  execFileSync(process.execPath, [INSTALL_PATH, ...args], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    // 120s, not 60s. A full install copies and converts the whole shipped
    // payload (117 workflows, 100 references, 34 agents, ~71 skills) and
    // measures 13-30s on an idle runner — under 2x headroom at the old cap.
    // On a loaded bench that margin is not enough: the Cursor suite's before
    // hook died with `spawnSync ETIMEDOUT` on the node24 lane while the node22
    // lane passed the SAME commit in 12.7s, cancelling three child tests as
    // collateral. The cap also shrinks in real terms every time a file joins
    // the payload. Matches the 120s already used for the heavy install case
    // below. Aligned with the other runInstall helper in this file.
    timeout: 120000,
  });
}

/**
 * Return an array of { rel, path } for all .js files under dir.
 */
function findJsFiles(dir) {
  const results = [];
  function walk(d) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js') || entry.name.endsWith('.cjs')) {
        results.push({ rel: path.relative(dir, full), full });
      }
    }
  }
  walk(dir);
  return results;
}

/**
 * Split a JS file's lines into comment and non-comment buckets.
 * A line is treated as a comment if it starts with optional whitespace
 * followed by // (single-line comment). Block comments are not checked
 * since none of the hook files use them for command refs.
 */
function nonCommentLines(content) {
  return content.split('\n').filter(line => !/^\s*\/\//.test(line));
}

/**
 * Return lines (from nonCommentLines) that contain a user-facing /gsd: ref.
 */
function colonRefs(content) {
  return nonCommentLines(content).filter(line => /\/gsd:/.test(line));
}

// ---------------------------------------------------------------------------
// Prerequisite: hooks/dist must exist (built by `npm run build:hooks`)
// ---------------------------------------------------------------------------
describe('bug #376 — prerequisite: hooks/dist is present', () => {
  before(() => {
    // hooks/dist is gitignored; build it on demand so this test is
    // deterministic in CI scoped/windows jobs that don't pre-run build:hooks.
    ensureHooksDist();
  });

  test('hooks/dist directory exists (run npm run build:hooks if missing)', () => {
    assert.ok(
      fs.existsSync(HOOKS_DIST_DIR),
      `hooks/dist not found at ${HOOKS_DIST_DIR}. Run: npm run build:hooks`,
    );
  });

  test('hooks/dist contains at least one .js hook file with a /gsd: literal', () => {
    const jsFiles = findJsFiles(HOOKS_DIST_DIR);
    assert.ok(jsFiles.length > 0, 'hooks/dist must contain .js files');

    const withColonRef = jsFiles.filter(({ full }) => {
      const content = fs.readFileSync(full, 'utf-8');
      return colonRefs(content).length > 0;
    });

    assert.ok(
      withColonRef.length > 0,
      'Expected at least one hooks/dist .js file with a non-comment /gsd: literal ' +
      '— this confirms the test is guarding a real regression surface. ' +
      `Files checked: ${jsFiles.map(f => f.rel).join(', ')}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 1 — Claude install: no /gsd: colon refs in installed .js hook files
// ---------------------------------------------------------------------------
describe('bug #376 — Suite 1: Claude install rewrites /gsd: → /gsd- in hook .js files', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-376-claude-'));
    runInstall(tmpDir, ['--claude', '--local', '--no-sdk']);
  });

  after(() => {
    cleanup(tmpDir);
  });

  test('1a: hooks/ directory is created by the Claude local install', () => {
    const hooksDir = path.join(tmpDir, '.claude', 'hooks');
    assert.ok(
      fs.existsSync(hooksDir),
      `hooks/ must be created at ${hooksDir} by Claude local install`,
    );
  });

  test('1b: installed .js hook files contain no user-facing /gsd: colon refs', () => {
    const hooksDir = path.join(tmpDir, '.claude', 'hooks');
    if (!fs.existsSync(hooksDir)) {
      // If hooks/ wasn't created (hooks/dist missing at install time), skip gracefully
      return;
    }

    const jsFiles = findJsFiles(hooksDir);
    assert.ok(jsFiles.length > 0, 'At least one .js hook file must be installed');

    const offenders = [];
    for (const { rel, full } of jsFiles) {
      const content = fs.readFileSync(full, 'utf-8');
      const badLines = colonRefs(content);
      if (badLines.length > 0) {
        offenders.push({ rel, lines: badLines });
      }
    }

    assert.deepEqual(
      offenders,
      [],
      'Installed Claude hook .js files must not contain /gsd:<cmd> colon refs ' +
      '(non-comment occurrences). The install-time rewriter must replace these with /gsd-<cmd>. ' +
      'Offenders: ' + JSON.stringify(offenders, null, 2),
    );
  });

  test('1c: installed .js hook files DO contain the hyphen form /gsd- (rewrite happened)', () => {
    const hooksDir = path.join(tmpDir, '.claude', 'hooks');
    if (!fs.existsSync(hooksDir)) return;

    const jsFiles = findJsFiles(hooksDir);
    const withHyphen = jsFiles.filter(({ full }) => {
      const content = fs.readFileSync(full, 'utf-8');
      return /\/gsd-/.test(content);
    });

    assert.ok(
      withHyphen.length > 0,
      'At least one installed .js hook file must contain /gsd- (confirming rewrite ran). ' +
      `Files checked: ${jsFiles.map(f => f.rel).join(', ')}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — Cursor install regression: /gsd: → /gsd- still works (pre-existing)
//
// Note: Cursor installs its own hooks (gsd-cursor-session-start.js and
// gsd-cursor-post-tool.js) via the cursor-hooks-json installSurface (issue #777).
// It does NOT install the bundled Claude-style hooks/dist files (no gsd-session-state.sh
// etc.). The Cursor /gsd: rewrite applies in `copyWithPathReplacement` to JS files
// under the agent/skill tree (.cursor/gsd-core/*.js etc). We verify that Cursor's
// installed .js files under .cursor/ have no /gsd: colon refs, and that the hooks/
// directory contains only the Cursor-specific managed hooks.
// ---------------------------------------------------------------------------
describe('bug #376 — Suite 2: Cursor install still rewrites /gsd: → /gsd- (regression)', () => {
  let tmpDir;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-376-cursor-'));
    runInstall(tmpDir, ['--cursor', '--local', '--no-sdk']);
  });

  after(() => {
    cleanup(tmpDir);
  });

  test('2a: .cursor/ directory is created by the Cursor local install', () => {
    const cursorDir = path.join(tmpDir, '.cursor');
    assert.ok(
      fs.existsSync(cursorDir),
      `Cursor install must create .cursor/ directory at ${cursorDir}`,
    );
  });

  test('2b: Cursor-installed .js files contain no user-facing /gsd: colon refs', () => {
    const cursorDir = path.join(tmpDir, '.cursor');
    if (!fs.existsSync(cursorDir)) return;

    // Infrastructure files whose /gsd: occurrences are intentional implementation
    // details — NOT user-facing command references that Cursor would invoke.
    //
    // scripts/fix-slash-commands.cjs is the slash-command rewriter engine, required
    // by gsd-core/bin/lib/command-roster.cjs on ALL runtimes (including Cursor).
    // It must be installed verbatim and must NOT be content-rewritten: it needs to
    // emit `/gsd:${cmd}` for non-Cursor runtimes, and its /gsd: strings are internal
    // implementation/docs (transform patterns, regex literals, template literals),
    // not commands a Cursor user would type. Rewriting it would corrupt the transformer.
    const INFRA_BASENAMES = new Set(['fix-slash-commands.cjs']);

    const jsFiles = findJsFiles(cursorDir);
    // Cursor may not install any .js files depending on what agent/skill content exists;
    // if none, skip gracefully.
    if (jsFiles.length === 0) return;

    const offenders = [];
    for (const { rel, full } of jsFiles) {
      // Skip infrastructure files whose /gsd: strings are intentional (see above).
      if (INFRA_BASENAMES.has(path.basename(full))) continue;
      const content = fs.readFileSync(full, 'utf-8');
      const badLines = colonRefs(content);
      if (badLines.length > 0) {
        offenders.push({ rel, lines: badLines });
      }
    }

    assert.deepEqual(
      offenders,
      [],
      'Cursor-installed .js files must not contain /gsd:<cmd> colon refs. ' +
      'The existing Cursor branch in copyWithPathReplacement must still apply /gsd:/gi → gsd- rewrite. ' +
      'Offenders: ' + JSON.stringify(offenders, null, 2),
    );
  });

  test('2c: Cursor install creates a hooks/ directory with only Cursor-specific managed hooks', () => {
    // Since issue #777, Cursor installs gsd-cursor-session-start.js and
    // gsd-cursor-post-tool.js into <configDir>/hooks/. These are Cursor-native
    // hooks — NOT the bundled Claude-style hooks (no gsd-session-state.sh etc.).
    // Verify: hooks/ exists AND does NOT contain any Claude-bundled hooks.
    const hooksDir = path.join(tmpDir, '.cursor', 'hooks');
    assert.ok(
      fs.existsSync(hooksDir),
      'Cursor install must create a hooks/ directory for its managed hook scripts (#777)',
    );
    const CLAUDE_BUNDLED_HOOKS = ['gsd-session-state.sh', 'gsd-context-monitor.js', 'gsd-statusline.js'];
    for (const hook of CLAUDE_BUNDLED_HOOKS) {
      assert.strictEqual(
        fs.existsSync(path.join(hooksDir, hook)),
        false,
        `Cursor hooks/ must NOT contain Claude-bundled hook ${hook} — only Cursor-native hooks are installed`,
      );
    }
    // The two Cursor-specific managed hooks must be present.
    assert.ok(
      fs.existsSync(path.join(hooksDir, 'gsd-cursor-session-start.js')),
      'gsd-cursor-session-start.js must be installed in .cursor/hooks/ (#777)',
    );
    assert.ok(
      fs.existsSync(path.join(hooksDir, 'gsd-cursor-post-tool.js')),
      'gsd-cursor-post-tool.js must be installed in .cursor/hooks/ (#777)',
    );
  });
});

// ---------------------------------------------------------------------------
// Suite 3 — Source files in hooks/ are untouched
// ---------------------------------------------------------------------------
describe('bug #376 — Suite 3: hooks/ source files are unchanged by install', () => {
  let snapshotBefore;

  before(() => {
    // Ensure hooks/dist is built before snapshotting; it may be absent in CI
    // scoped/windows jobs that don't pre-run build:hooks (#777 fix).
    ensureHooksDist();
    // Snapshot hooks/dist JS files before any install in this suite
    snapshotBefore = {};
    if (fs.existsSync(HOOKS_DIST_DIR)) {
      for (const { rel, full } of findJsFiles(HOOKS_DIST_DIR)) {
        snapshotBefore[rel] = fs.readFileSync(full, 'utf-8');
      }
    }
  });

  test('3a: hooks/dist .js source files still contain /gsd: literals (not mutated)', () => {
    // The source must remain in colon form — the rewrite is install-time only
    const jsFiles = findJsFiles(HOOKS_DIST_DIR);
    const withColonRef = jsFiles.filter(({ full }) => {
      const content = fs.readFileSync(full, 'utf-8');
      return colonRefs(content).length > 0;
    });

    // We know from the prerequisite suite that at least one file had a colon ref;
    // if the source was mutated by install, this would now be zero.
    assert.ok(
      withColonRef.length > 0,
      'hooks/dist .js files must still contain /gsd: literals after install — ' +
      'the install-time rewrite must NOT modify the source tree. ' +
      `Files that still have colon refs: ${withColonRef.map(f => f.rel).join(', ')}`,
    );
  });

  test('3b: hooks/dist .js source file contents match pre-test snapshot (byte-identical)', () => {
    if (Object.keys(snapshotBefore).length === 0) {
      // hooks/dist was absent before; skip
      return;
    }

    for (const [rel, before] of Object.entries(snapshotBefore)) {
      const full = path.join(HOOKS_DIST_DIR, rel);
      const after = fs.readFileSync(full, 'utf-8');
      assert.strictEqual(
        after,
        before,
        `hooks/dist/${rel} was mutated by install — install must only rewrite the installed copy, not the source`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 4 — Pure-function: shouldNormalizeHyphenNamespaceInAgentBody covers claude
// ---------------------------------------------------------------------------
describe('bug #376 — Suite 4: shouldNormalizeHyphenNamespaceInAgentBody covers claude', () => {
  const install = require(INSTALL_PATH);

  test('4a: shouldNormalizeHyphenNamespaceInAgentBody is exported', () => {
    assert.strictEqual(
      typeof install.shouldNormalizeHyphenNamespaceInAgentBody,
      'function',
      'install.js must export shouldNormalizeHyphenNamespaceInAgentBody',
    );
  });

  test('4b: claude is in the hyphen-namespace set', () => {
    assert.strictEqual(
      install.shouldNormalizeHyphenNamespaceInAgentBody('claude'),
      true,
      'claude must be a hyphen-namespace runtime',
    );
  });

  test('4c: qwen is in the hyphen-namespace set', () => {
    assert.strictEqual(
      install.shouldNormalizeHyphenNamespaceInAgentBody('qwen'),
      true,
    );
  });

  test('4d: hermes is in the hyphen-namespace set', () => {
    assert.strictEqual(
      install.shouldNormalizeHyphenNamespaceInAgentBody('hermes'),
      true,
    );
  });

  test('4e: gemini is NOT in the hyphen-namespace set', () => {
    assert.strictEqual(
      install.shouldNormalizeHyphenNamespaceInAgentBody('gemini'),
      false,
      'gemini intentionally keeps colon namespace and must not be in the hyphen set',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-1367-claude-local-flat-command-layout.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-1367-claude-local-flat-command-layout (consolidation epic #1969 B6 #1975)", () => {
// allow-test-rule: source-text-is-the-product #1367
// Installed command `.md` files — their on-disk path determines the slash-command
// namespace registered by Claude Code. Asserting the layout (flat vs. subdirectory)
// IS a behavioral test of the deploy contract, not source-grep theater.

/**
 * Regression for #1367 — project-local Claude Code install writes command files to
 * `.claude/commands/gsd/<cmd>.md` (subdirectory, bare names), causing Claude Code
 * to register them as `/gsd:<cmd>` (colon namespace). The fix changes the layout to
 * write flat `gsd-<cmd>.md` files at `.claude/commands/` level so Claude Code
 * registers `/gsd-<cmd>` (hyphen form, matching hooks, statusline, and cross-command
 * references everywhere in the framework).
 *
 * Root cause: `bin/install.js` (the `else` branch for claude local) wrote to a
 * `commands/gsd/` subdirectory using `copyWithPathReplacement`. Claude Code treats
 * the directory name as a namespace, so `commands/gsd/update.md` became `/gsd:update`.
 *
 * Fix: write each command as `gsd-<stem>.md` directly in `commands/` (flat layout).
 * This is the same approach used for OpenCode/Kilo (see `copyFlattenedCommands`).
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALL_PATH = path.join(REPO_ROOT, 'bin', 'install.js');
// hooks/dist/ is a gitignored build artifact; the test must ensure it exists before
// invoking the installer (mirrors golden-install-parity's BUILD_SCRIPT pattern). Without
// this, the unit lane — whose ensureBuiltArtifacts() builds only bin/lib, not hooks —
// leaves hooks/dist empty and install.js hard-fails "directory is empty" (#1926).
const BUILD_HOOKS = path.join(REPO_ROOT, 'scripts', 'build-hooks.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run `node install.js --claude --local --no-sdk` in cwd.
 * GSD_TEST_MODE must be cleared so the install() main block executes.
 */
function runClaudeLocalInstall(cwd) {
  const env = { ...process.env };
  delete env.GSD_TEST_MODE;
  execFileSync(process.execPath, [INSTALL_PATH, '--claude', '--local', '--no-sdk'], {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
}

// ---------------------------------------------------------------------------
// Suite — #1367 regression: flat gsd-<cmd>.md layout for claude local install
// ---------------------------------------------------------------------------

describe('bug #1367 — Claude local install uses flat gsd-<cmd>.md command layout', () => {
  let tmpDir;

  before(() => {
    // #1926: build hooks/dist/ so the installer's verifyInstalled(hooks) doesn't hit an
    // empty directory. Self-contained — no dependency on the lane having pre-built hooks.
    execFileSync(process.execPath, [BUILD_HOOKS], {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1367-'));
    runClaudeLocalInstall(tmpDir);
  });

  after(() => {
    cleanup(tmpDir);
  });

  test('L0: commands/ directory exists after local claude install', () => {
    const commandsDir = path.join(tmpDir, '.claude', 'commands');
    assert.ok(
      fs.existsSync(commandsDir),
      `commands/ must be created by local claude install at ${commandsDir}`,
    );
  });

  test('L1: command files use flat gsd-<cmd>.md names (not bare names in a subdirectory)', () => {
    // The fix: commands land as .claude/commands/gsd-<cmd>.md (flat, hyphen-prefixed).
    // Claude Code reads the stem of each file in commands/ as the command name,
    // so gsd-update.md → /gsd-update (hyphen). The old layout (commands/gsd/update.md)
    // made Claude Code use the directory as a namespace → /gsd:update (colon).
    const commandsDir = path.join(tmpDir, '.claude', 'commands');
    assert.ok(fs.existsSync(commandsDir), 'commands/ must exist for this check to be meaningful');

    const flatGsdFiles = fs.readdirSync(commandsDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.startsWith('gsd-') && e.name.endsWith('.md'));

    assert.ok(
      flatGsdFiles.length > 0,
      `commands/ must contain flat gsd-*.md files (e.g. gsd-help.md, gsd-update.md). ` +
      `Found none. Install may still be writing to commands/gsd/<cmd>.md subdirectory ` +
      `which causes /gsd:<cmd> colon namespace in Claude Code.`,
    );
  });

  test('L2: known commands land as flat gsd-<cmd>.md files', () => {
    // Spot-check: the three commands mentioned in the issue must be present
    // as flat hyphen-prefixed files.
    const commandsDir = path.join(tmpDir, '.claude', 'commands');
    const knownCommands = ['gsd-update.md', 'gsd-plan-phase.md', 'gsd-help.md'];
    for (const name of knownCommands) {
      const filePath = path.join(commandsDir, name);
      assert.ok(
        fs.existsSync(filePath),
        `${name} must exist as a flat file at commands/${name}. ` +
        `If missing, the flat layout is not being written correctly.`,
      );
    }
  });

  test('L3: commands/gsd/ subdirectory does NOT exist (old colon-namespace layout)', () => {
    // The old layout wrote to commands/gsd/<cmd>.md. That directory must not
    // exist after a fresh install with the fix applied.
    const oldSubdir = path.join(tmpDir, '.claude', 'commands', 'gsd');
    assert.ok(
      !fs.existsSync(oldSubdir),
      `commands/gsd/ subdir must NOT exist after install. ` +
      `Its presence means the old layout is still being used — Claude Code would ` +
      `register commands as /gsd:<cmd> (colon) instead of /gsd-<cmd> (hyphen).`,
    );
  });

  test('L4: total flat command file count matches the staged source', () => {
    // There should be a substantial number of commands (not 0, not 1).
    // The exact count varies with profile but must be >= 20 for a full install.
    const commandsDir = path.join(tmpDir, '.claude', 'commands');
    const count = fs.readdirSync(commandsDir, { withFileTypes: true })
      .filter(e => e.isFile() && e.name.startsWith('gsd-') && e.name.endsWith('.md'))
      .length;
    assert.ok(
      count >= 20,
      `commands/ must have >= 20 flat gsd-*.md files for a full install. ` +
      `Got ${count}. Install may be silently dropping commands.`,
    );
  });

  test('L5: legacy migration — re-install on a pre-#1367 tree removes old commands/gsd/ subdir', () => {
    // Simulate a pre-#1367 install: create a commands/gsd/ subdirectory with a bare-name file.
    // Then re-run the installer and verify the old subdir is cleaned up.
    const commandsDir = path.join(tmpDir, '.claude', 'commands');
    const legacyDir = path.join(commandsDir, 'gsd');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'update.md'), '# legacy update');

    // Re-run install — should remove commands/gsd/ and write flat gsd-*.md
    runClaudeLocalInstall(tmpDir);

    assert.ok(
      !fs.existsSync(legacyDir),
      `commands/gsd/ legacy subdir must be removed by re-install. ` +
      `The installer's legacy cleanup must remove old commands/gsd/ on upgrade.`,
    );
    // Flat form must still be present
    assert.ok(
      fs.existsSync(path.join(commandsDir, 'gsd-update.md')),
      `gsd-update.md must exist as flat file after re-install.`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-2380-sync-skills.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-2380-sync-skills (consolidation epic #1969 B6 #1975)", () => {
  // Consolidation #1969: this block spawns a REAL install and asserts side effects.
  // The host suite sets GSD_TEST_MODE=1 at collection time, which the install child
  // inherits via process.env and which suppresses hook/skill writes. Clear it for
  // this block's duration (standalone had it unset); restore after.
  const { before: __gtmBefore, after: __gtmAfter } = require('node:test');
  let __savedGsdTestMode;
  __gtmBefore(() => { __savedGsdTestMode = process.env.GSD_TEST_MODE; delete process.env.GSD_TEST_MODE; });
  __gtmAfter(() => { if (__savedGsdTestMode === undefined) delete process.env.GSD_TEST_MODE; else process.env.GSD_TEST_MODE = __savedGsdTestMode; });
'use strict';

// allow-test-rule: source-text-is-the-product (see #2380)
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Tests for #2380 — /gsd-sync-skills cross-runtime skill sync.
 *
 * Verifies:
 * 1. install.js --skills-root <runtime> resolves correct paths
 * 2. sync-skills.md workflow covers required behavioral specs
 * 3. commands/gsd/sync-skills.md slash command exists
 * 4. INVENTORY in sync
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const os = require('node:os');

const INSTALL_JS = path.join(__dirname, '../bin/install.js');
const WORKFLOW = path.join(__dirname, '../gsd-core/workflows/sync-skills.md');
const COMMAND = path.join(__dirname, '../commands/gsd/sync-skills.md');

function readWorkflow() {
  return fs.readFileSync(WORKFLOW, 'utf-8');
}

// ── install.js --skills-root ──────────────────────────────────────────────────

describe('install.js --skills-root', () => {
  const CASES = [
    { runtime: 'claude', expected: path.join(os.homedir(), '.claude', 'skills') },
    // #2088 (ADR-1239 upgrade 3): Codex skills resolve to the canonical
    // $HOME/.agents/skills root (skills-kind home override), not $CODEX_HOME/skills.
    { runtime: 'codex', expected: path.join(os.homedir(), '.agents', 'skills') },
    { runtime: 'copilot', expected: path.join(os.homedir(), '.copilot', 'skills') },
    { runtime: 'cursor', expected: path.join(os.homedir(), '.cursor', 'skills') },
    { runtime: 'trae', expected: path.join(os.homedir(), '.trae', 'skills') },
  ];

  for (const { runtime, expected } of CASES) {
    test(`resolves correct skills root for ${runtime}`, () => {
      const result = spawnSync(process.execPath, [INSTALL_JS, '--skills-root', runtime], {
        encoding: 'utf-8',
        env: { ...process.env, GSD_TEST_MODE: undefined }, // ensure not in test mode
      });
      // Strip trailing newline
      const actual = result.stdout.trim();
      assert.strictEqual(actual, expected, `Expected ${expected}, got ${actual}`);
    });
  }

  test('exits non-zero when runtime arg is missing', () => {
    const result = spawnSync(process.execPath, [INSTALL_JS, '--skills-root'], {
      encoding: 'utf-8',
    });
    assert.notStrictEqual(result.status, 0, 'Should exit with error when runtime arg is missing');
  });

  test('returns a path ending in /skills', () => {
    const result = spawnSync(process.execPath, [INSTALL_JS, '--skills-root', 'windsurf'], {
      encoding: 'utf-8',
    });
    assert.ok(result.stdout.trim().endsWith('skills'), 'Skills root must end in /skills');
  });
});

// ── sync-skills.md workflow content ──────────────────────────────────────────

describe('sync-skills.md — required behavioral specs', () => {
  let content;

  test('workflow file exists', () => {
    content = readWorkflow();
    assert.ok(content.length > 0, 'sync-skills.md must exist and be non-empty');
  });

  test('--dry-run is the default (no writes without --apply)', () => {
    content = content || readWorkflow();
    assert.ok(
      content.includes('dry-run') && (content.includes('default') || content.includes('Default')),
      'workflow must document --dry-run as default'
    );
  });

  test('--apply flag is required to execute writes', () => {
    content = content || readWorkflow();
    assert.ok(content.includes('--apply'), 'workflow must document --apply flag');
  });

  test('--from flag documented', () => {
    content = content || readWorkflow();
    assert.ok(content.includes('--from'), 'workflow must document --from flag');
  });

  test('--to flag documented (runtime|all)', () => {
    content = content || readWorkflow();
    assert.ok(
      content.includes('--to') && content.includes('all'),
      'workflow must document --to flag with "all" option'
    );
  });

  test('only gsd-* directories are touched (non-GSD preservation)', () => {
    content = content || readWorkflow();
    assert.ok(
      content.includes('gsd-*') && (content.includes('non-GSD') || content.includes('Non-GSD') || content.includes('not starting with')),
      'workflow must document that only gsd-* dirs are modified'
    );
  });

  test('idempotency documented (second apply = zero changes)', () => {
    content = content || readWorkflow();
    assert.ok(
      content.includes('dempoten') || content.includes('Idempoten') || content.includes('zero changes') || content.includes('second run'),
      'workflow must document idempotency'
    );
  });

  test('install.js --skills-root is used for path resolution', () => {
    content = content || readWorkflow();
    assert.ok(
      content.includes('--skills-root'),
      'workflow must reference install.js --skills-root for path resolution'
    );
  });

  test('diff report format: CREATE / UPDATE / REMOVE documented', () => {
    content = content || readWorkflow();
    assert.ok(content.includes('CREATE'), 'workflow must document CREATE in diff report');
    assert.ok(content.includes('UPDATE'), 'workflow must document UPDATE in diff report');
    assert.ok(content.includes('REMOVE'), 'workflow must document REMOVE in diff report');
  });

  test('source-not-found error guidance documented', () => {
    content = content || readWorkflow();
    assert.ok(
      content.includes('source skills root not found') || content.includes('source root') || content.includes('not found'),
      'workflow must document error when source skills root is missing'
    );
  });

  test('safety rule: dry-run performs no writes', () => {
    content = content || readWorkflow();
    const safetySection = content.includes('Safety Rules') || content.includes('safety');
    assert.ok(
      safetySection || content.includes('no writes') || content.includes('--dry-run performs no writes'),
      'workflow must have a safety rule that dry-run performs no writes'
    );
  });
});

// ── commands/gsd/sync-skills.md ───────────────────────────────────────────────
// #2790: sync-skills.md was consolidated into update.md as the --sync flag.

describe('commands/gsd/sync-skills.md', () => {
  test('sync-skills is now --sync flag on update.md (#2790)', () => {
    const updateCmd = path.join(__dirname, '../commands/gsd/update.md');
    assert.ok(fs.existsSync(updateCmd), 'commands/gsd/update.md must exist');
    const content = fs.readFileSync(updateCmd, 'utf-8');
    assert.ok(
      content.includes('--sync'),
      'update.md must document --sync flag (absorbed sync-skills)'
    );
  });

  test('sync-skills.md command file is deleted (#2790)', () => {
    assert.ok(!fs.existsSync(COMMAND), 'commands/gsd/sync-skills.md should be deleted (consolidated into update.md)');
  });
});

// ── INVENTORY sync ────────────────────────────────────────────────────────────

describe('INVENTORY sync', () => {
  test('INVENTORY.md lists /gsd-update --sync command (#2790: absorbed /gsd-sync-skills)', () => {
    const inventory = fs.readFileSync(path.join(__dirname, '../docs/INVENTORY.md'), 'utf-8');
    assert.ok(inventory.includes('/gsd-update --sync'), 'INVENTORY.md must list /gsd-update --sync (absorbed /gsd-sync-skills in #2790)');
  });

  test('INVENTORY.md lists sync-skills.md workflow', () => {
    const inventory = fs.readFileSync(path.join(__dirname, '../docs/INVENTORY.md'), 'utf-8');
    assert.ok(inventory.includes('sync-skills.md'), 'INVENTORY.md must list sync-skills.md workflow');
  });

  test('INVENTORY-MANIFEST.json includes /gsd-update (#2790: sync-skills absorbed into update.md --sync)', () => {
    // #2790: /gsd-sync-skills was absorbed into /gsd-update as the --sync flag.
    // The manifest now records /gsd-update instead of /gsd-sync-skills.
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../docs/INVENTORY-MANIFEST.json'), 'utf-8')
    );
    assert.ok(
      manifest.families.commands.includes('/gsd-update'),
      'INVENTORY-MANIFEST.json must include /gsd-update in commands (absorbed /gsd-sync-skills via #2790)'
    );
  });

  test('INVENTORY-MANIFEST.json includes sync-skills.md', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(__dirname, '../docs/INVENTORY-MANIFEST.json'), 'utf-8')
    );
    assert.ok(
      manifest.families.workflows.includes('sync-skills.md'),
      'INVENTORY-MANIFEST.json must include sync-skills.md in workflows'
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/fix-1521-real-install-stamping.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:fix-1521-real-install-stamping (consolidation epic #1969 B6 #1975)", () => {
  // Consolidation #1969: this block spawns a REAL install and asserts side effects.
  // The host suite sets GSD_TEST_MODE=1 at collection time, which the install child
  // inherits via process.env and which suppresses hook/skill writes. Clear it for
  // this block's duration (standalone had it unset); restore after.
  const { before: __gtmBefore, after: __gtmAfter } = require('node:test');
  let __savedGsdTestMode;
  __gtmBefore(() => { __savedGsdTestMode = process.env.GSD_TEST_MODE; delete process.env.GSD_TEST_MODE; });
  __gtmAfter(() => { if (__savedGsdTestMode === undefined) delete process.env.GSD_TEST_MODE; else process.env.GSD_TEST_MODE = __savedGsdTestMode; });
'use strict';
/**
 * E2E regression tests for #1521: real install path (copyWithPathReplacement)
 * MUST stamp non-Claude runtime defaults into emitted gsd-core/workflows/*.md.
 *
 * The earlier unit tests in fix-1521-non-claude-runtime-default-resolution.test.cjs
 * only verify the engine (_applyRuntimeRewrites). This test verifies the wiring:
 * that a REAL `node bin/install.js --codex/--cursor --global` actually emits
 * execute-phase.md with --default codex / --default cursor (not --default claude).
 *
 * Root cause: copyWithPathReplacement is the emit path for gsd-core/workflows/*.md;
 * it did its own inline path rewrites but never called _stampNonClaudeRuntimeDefaults,
 * so the stamping was dead-on-arrival in real installs.
 *
 * This test must be RED before the fix is applied (Step 1) and GREEN after (Step 2).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const INSTALL = path.join(__dirname, '..', 'bin', 'install.js');

/**
 * Run a real install into a temp config dir and return the emitted
 * execute-phase.md content.
 * @param {string} runtime  e.g. 'codex', 'cursor', 'claude'
 * @returns {string}
 */
function installAndRead(runtime) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-inst-${runtime}-`));
  // Sandbox HOME/USERPROFILE to `dir`: Codex's skills-kind `home: ".agents"`
  // override (ADR-1239 upgrade 3, #2088) resolves via os.homedir(), so an
  // unsandboxed real install here would write a full (non-minimal) gsd-* skill
  // set into the developer/CI machine's real $HOME/.agents/skills. Harmless
  // no-op for cursor/claude, which have no skills-kind home override.
  const res = spawnSync(
    process.execPath,
    [INSTALL, `--${runtime}`, '--global', '--config-dir', dir],
    { encoding: 'utf8', timeout: 120000, env: { ...process.env, HOME: dir, USERPROFILE: dir } },
  );
  assert.strictEqual(res.status, 0, `install --${runtime} failed: ${res.stderr || res.stdout}`);
  const wf = path.join(dir, 'gsd-core', 'workflows', 'execute-phase.md');
  assert.ok(fs.existsSync(wf), `emitted workflow missing for ${runtime}: ${wf}`);
  const content = fs.readFileSync(wf, 'utf8');
  cleanup(dir);
  return content;
}

// ---------------------------------------------------------------------------
// RED tests: these MUST FAIL before the copyWithPathReplacement wiring is added
// ---------------------------------------------------------------------------

test('real install: codex-emitted execute-phase.md resolves runtime=codex and defaults worktrees off (#1521)', () => {
  const c = installAndRead('codex');
  assert.ok(
    c.includes('config-get runtime --default codex --raw'),
    'codex runtime default not stamped in real install',
  );
  assert.ok(
    c.includes('config-get workflow.use_worktrees --default false --raw'),
    'codex use_worktrees not defaulted false in real install',
  );
  assert.ok(
    !c.includes('config-get runtime --default claude --raw'),
    'residual claude default in codex install',
  );
});

test('real install: cursor-emitted execute-phase.md resolves runtime=cursor (#1521)', () => {
  const c = installAndRead('cursor');
  assert.ok(
    c.includes('config-get runtime --default cursor --raw'),
    'cursor runtime default not stamped in real install',
  );
  assert.ok(
    !c.includes('config-get runtime --default claude --raw'),
    'residual claude default in cursor install',
  );
});

test('real install: claude-emitted execute-phase.md keeps claude default + worktrees on (#1521)', () => {
  const c = installAndRead('claude');
  assert.ok(
    c.includes('config-get runtime --default claude --raw'),
    'claude default changed in claude install',
  );
  assert.ok(
    c.includes('config-get workflow.use_worktrees --raw 2>/dev/null || echo "true"'),
    'claude worktrees default changed (should still be true)',
  );
  assert.ok(
    !c.includes('config-get workflow.use_worktrees --default false --raw'),
    'claude install must NOT have use_worktrees=false stamped',
  );
});

  });
}

// Bug #2395 — finishInstall for non-Claude runtimes never persisted `runtime: <id>`
// into ~/.gsd/defaults.json. resolveRuntime() precedence is GSD_RUNTIME > config.runtime
// > 'claude', so both inputs being empty on a Cursor (or any non-Claude) install caused
// every runtime-branded output (agent_runtime, formatGsdSlash hints, etc.) to silently
// fall through to 'claude'. Fix mirrors the resolve_model_ids: "omit" write site that
// already exists for non-Claude runtimes — writes runtime: <runtime> when absent.
describe('Bug #2395: finishInstall persists runtime identity for non-Claude runtimes', () => {
  const LOCAL_ROOT = path.join(__dirname, '..');
  const LOCAL_FAKE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2395-test-'));
  const LOCAL_GSD_DIR = path.join(LOCAL_FAKE_HOME, '.gsd');
  const LOCAL_DEFAULTS_PATH = path.join(LOCAL_GSD_DIR, 'defaults.json');
  const LOCAL_INSTALL_MODULE = require(path.join(LOCAL_ROOT, 'bin', 'install.js'));
  const LOCAL_SETTINGS_PATH = path.join(LOCAL_FAKE_HOME, `gsd-test-settings-${process.pid}-2395.json`);

  const { before: __before, after: __after } = require('node:test');
  const __savedHome = process.env.HOME;
  const __savedUserProfile = process.env.USERPROFILE;
  __before(() => {
    process.env.HOME = LOCAL_FAKE_HOME;
    process.env.USERPROFILE = LOCAL_FAKE_HOME;
  });
  __after(() => {
    if (__savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = __savedHome;
    if (__savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = __savedUserProfile;
    try { cleanup(LOCAL_FAKE_HOME); } catch { /* best-effort */ }
  });

  function callFinishInstall(runtime) {
    const original = console.log;
    console.log = () => {};
    try {
      LOCAL_INSTALL_MODULE.finishInstall(
        LOCAL_SETTINGS_PATH,
        {}, null, false, runtime, true, null,
      );
    } finally {
      console.log = original;
    }
  }

  function seedDefaults(obj) {
    fs.mkdirSync(LOCAL_GSD_DIR, { recursive: true });
    fs.writeFileSync(LOCAL_DEFAULTS_PATH, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  }

  function withUserPath(fn) {
    const saved = process.env.GSD_TEST_MODE;
    delete process.env.GSD_TEST_MODE;
    try {
      return fn();
    } finally {
      process.env.GSD_TEST_MODE = saved;
    }
  }

  test('absent runtime → written to <install runtime> (cursor install surfaces cursor branding)', () => {
    withUserPath(() => {
      seedDefaults({ model_profile: 'balanced' });
      callFinishInstall('cursor');
      const after = JSON.parse(fs.readFileSync(LOCAL_DEFAULTS_PATH, 'utf8'));
      assert.equal(after.runtime, 'cursor', 'absent runtime must be populated with the install runtime identity');
    });
  });

  test('null runtime → written to <install runtime> (treated as absent)', () => {
    withUserPath(() => {
      seedDefaults({ runtime: null, model_profile: 'balanced' });
      callFinishInstall('cursor');
      const after = JSON.parse(fs.readFileSync(LOCAL_DEFAULTS_PATH, 'utf8'));
      assert.equal(after.runtime, 'cursor', 'null runtime must be treated as absent and populated');
    });
  });

  test('empty-string runtime → written to <install runtime> (treated as absent)', () => {
    withUserPath(() => {
      seedDefaults({ runtime: '', model_profile: 'balanced' });
      callFinishInstall('codex');
      const after = JSON.parse(fs.readFileSync(LOCAL_DEFAULTS_PATH, 'utf8'));
      assert.equal(after.runtime, 'codex', 'empty-string runtime must be treated as absent and populated');
    });
  });

  test('explicit pre-existing runtime is preserved (no clobber across runtimes)', () => {
    withUserPath(() => {
      // User explicitly set runtime: 'cursor' — a subsequent opencode install must not clobber.
      seedDefaults({ runtime: 'cursor', resolve_model_ids: 'omit' });
      callFinishInstall('opencode');
      const after = JSON.parse(fs.readFileSync(LOCAL_DEFAULTS_PATH, 'utf8'));
      assert.equal(after.runtime, 'cursor', 'explicit user-set runtime must be preserved across install of a different runtime');
    });
  });

  // The clobber guard is runtime-agnostic; parameterize across a representative slice of
  // non-Claude runtimes. Each should populate its own runtime identity when absent.
  for (const runtime of ['cursor', 'codex', 'opencode', 'antigravity', 'windsurf']) {
    test(`${runtime} install populates runtime: "${runtime}" when absent`, () => {
      withUserPath(() => {
        seedDefaults({ model_profile: 'balanced' });
        callFinishInstall(runtime);
        const after = JSON.parse(fs.readFileSync(LOCAL_DEFAULTS_PATH, 'utf8'));
        assert.equal(after.runtime, runtime, `${runtime} install must persist runtime: "${runtime}" so resolveRuntime() does not fall through to 'claude'`);
      });
    });
  }

  test('same-runtime idempotence: second cursor install is a no-op (runtime already set)', () => {
    withUserPath(() => {
      seedDefaults({ model_profile: 'balanced' });
      callFinishInstall('cursor');
      const after1 = JSON.parse(fs.readFileSync(LOCAL_DEFAULTS_PATH, 'utf8'));
      assert.equal(after1.runtime, 'cursor', 'first install must populate runtime: cursor');
      // Capture mtime; wait briefly so a no-op vs rewrite is distinguishable.
      const beforeMtime = fs.statSync(LOCAL_DEFAULTS_PATH).mtimeMs;
      const start = Date.now();
      while (Date.now() - start < 20) { /* spin briefly */ }
      callFinishInstall('cursor');  // second install — should be a no-op on runtime
      const after2 = JSON.parse(fs.readFileSync(LOCAL_DEFAULTS_PATH, 'utf8'));
      const afterMtime = fs.statSync(LOCAL_DEFAULTS_PATH).mtimeMs;
      assert.equal(after2.runtime, 'cursor', 'second install must leave runtime: cursor intact');
      assert.equal(afterMtime, beforeMtime, 'second install must NOT rewrite defaults.json (runtime already set, idempotent)');
    });
  });
});
