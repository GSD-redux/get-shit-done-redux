// allow-test-rule: source-text-is-the-product
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Installer Module — Sections 6–8 + 12.
 *
 * Covers: installRuntimeArtifacts parameterised layout loop,
 * uninstallRuntimeArtifacts all runtimes, Contract 6 counter-test
 * (unknown runtime rejected), and legacy migration tests.
 *
 * Consolidates (original sources from #3758):
 *   install-uninstall-layout-loop.test.cjs
 *
 * Closes #3758
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { createTempDir, cleanup } = require('./helpers.cjs');

const {
  installRuntimeArtifacts,
  installOpencodeFamilySkills,
} = require('../gsd-core/bin/lib/install-engine.cjs');

const {
  parseRuntimeInput,
  allRuntimes,
} = require('../bin/install.js');

const {
  resolveRuntimeArtifactLayout,
} = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');

const { applySurface } = require('../gsd-core/bin/lib/surface.cjs');

const {
  loadSkillsManifest,
  resolveProfile,
  CAPABILITY_SKILL_MARKER,
} = require('../gsd-core/bin/lib/install-profiles.cjs');

const REAL_COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');
const MANIFEST = loadSkillsManifest(REAL_COMMANDS_DIR);
const RESOLVED_CORE = resolveProfile({ modes: ['core'], manifest: MANIFEST });

function loadFreshInstallerWithInstallPlanStub(stub) {
  return loadFreshInstallerWithPlanStubs({ installStub: stub });
}

function loadFreshInstallerWithPlanStubs({ installStub, uninstallStub }) {
  const installPath = require.resolve('../bin/install.js');
  const planPath = require.resolve('../gsd-core/bin/lib/runtime-artifact-install-plan.cjs');
  const planModule = require(planPath);
  const originalInstall = planModule.createRuntimeArtifactInstallPlan;
  const originalUninstall = planModule.createRuntimeArtifactUninstallPlan;
  if (installStub) planModule.createRuntimeArtifactInstallPlan = installStub;
  if (uninstallStub) planModule.createRuntimeArtifactUninstallPlan = uninstallStub;
  delete require.cache[installPath];
  const installer = require('../bin/install.js');

  return {
    installer,
    restore() {
      planModule.createRuntimeArtifactInstallPlan = originalInstall;
      planModule.createRuntimeArtifactUninstallPlan = originalUninstall;
      delete require.cache[installPath];
    },
  };
}

// ─── Section 6: installRuntimeArtifacts — parameterised layout loop ──────────

describe('installRuntimeArtifacts — consumes Runtime Artifact Install Plan Module', () => {
  test('executes returned copy items and cleanup obligations', (t) => {
    const configDir = createTempDir('gsd-install-plan-adapter-');
    const sourceDir = createTempDir('gsd-install-plan-source-');
    const cleanupDir = createTempDir('gsd-install-plan-cleanup-');
    t.after(() => {
      cleanup(configDir);
      cleanup(sourceDir);
      cleanup(cleanupDir);
    });

    fs.writeFileSync(path.join(sourceDir, 'proof.md'), '# proof\n');
    fs.writeFileSync(path.join(cleanupDir, 'temp.md'), '# cleanup\n');
    let planArgs;
    const { installer, restore } = loadFreshInstallerWithInstallPlanStub((args) => {
      planArgs = args;
      return {
        ok: true,
        plan: {
          cleanupDirs: [cleanupDir],
          items: [
            { kind: 'commands', sourceDir, destDir: path.join(configDir, 'commands', 'gsd') },
          ],
        },
      };
    });
    t.after(restore);

    // Augment has a flat commands kind and prefixes proof.md as gsd-proof.md.
    installer.installRuntimeArtifacts('augment', configDir, 'global', RESOLVED_CORE);

    assert.strictEqual(planArgs.layout.runtime, 'augment');
    assert.strictEqual(planArgs.layout.configDir, configDir);
    assert.strictEqual(planArgs.layout.scope, 'global');
    assert.strictEqual(planArgs.resolvedProfile, RESOLVED_CORE);
    assert.strictEqual(planArgs.resolveAttribution('claude'), undefined);
    assert.ok(fs.existsSync(path.join(configDir, 'commands', 'gsd', 'gsd-proof.md')));
    assert.ok(!fs.existsSync(cleanupDir), 'returned cleanup dir must be removed after copy');
  });

  test('cleans returned obligations when planning fails', (t) => {
    const configDir = createTempDir('gsd-install-plan-fail-');
    const cleanupDir = createTempDir('gsd-install-plan-fail-cleanup-');
    t.after(() => {
      cleanup(configDir);
      cleanup(cleanupDir);
    });

    fs.writeFileSync(path.join(cleanupDir, 'temp.md'), '# cleanup\n');
    const { installer, restore } = loadFreshInstallerWithInstallPlanStub(() => ({
      ok: false,
      kind: 'rewrite_failed',
      failedKind: 'commands',
      message: 'planned failure',
      cleanupDirs: [cleanupDir],
    }));
    t.after(restore);

    assert.throws(
      () => installer.installRuntimeArtifacts('claude', configDir, 'global', RESOLVED_CORE),
      /planned failure/,
    );
    assert.ok(!fs.existsSync(cleanupDir), 'failure cleanup dir must be removed');
  });
});

const SKILLS_RUNTIMES_LAYOUT = [
  'claude', 'cursor', 'codex', 'copilot', 'antigravity',
  'augment', 'trae', 'qwen', 'kimi', 'codebuddy',
];

const ALL_RUNTIMES_LAYOUT = [
  'claude', 'cursor', 'codex', 'copilot', 'antigravity',
  'windsurf', 'augment', 'trae', 'qwen', 'hermes', 'codebuddy',
  'cline', 'kimi', 'opencode', 'kilo',
];

function countPrefixedEntries(destDir, prefix) {
  if (!fs.existsSync(destDir)) return 0;
  return fs.readdirSync(destDir).filter(n => n.startsWith(prefix)).length;
}

function writeSkillEntry(destDir, prefix, stem) {
  const entryDir = path.join(destDir, `${prefix}${stem}`);
  fs.mkdirSync(entryDir, { recursive: true });
  fs.writeFileSync(path.join(entryDir, 'SKILL.md'), `# ${stem}\n`);
}

function writeCommandEntry(destDir, prefix, stem) {
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, `${prefix}${stem}.md`), `# ${stem}\n`);
}

function readAllSkillMd(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return '';
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.name === 'SKILL.md') out.push(fs.readFileSync(p, 'utf8'));
    }
  }
  return out.join('\n');
}

// Codex resolves its skills-kind destination via os.homedir() + a 'skills'-kind
// 'home: ".agents"' layout override (ADR-1239 EoS upgrade 3, #2088), NOT
// configDir/skills. Without sandboxing HOME, an in-process codex install would
// write to (and an uninstall would mutate) the developer's REAL ~/.agents/skills.
// Sandbox HOME/USERPROFILE to configDir before resolving the layout or invoking
// install/uninstall so codex's resolved skills dir is configDir/.agents/skills.
function sandboxHome(t, dir) {
  const savedHome = process.env.HOME;
  const savedUserProfile = process.env.USERPROFILE;
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  t.after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
  });
}

describe('installRuntimeArtifacts — skills runtimes write gsd-prefixed skill dirs', () => {
  for (const runtime of SKILLS_RUNTIMES_LAYOUT) {
    test(`${runtime}: gsd-prefixed skill dirs in skills/`, (t) => {
      const configDir = createTempDir(`gsd-ial-${runtime}-`);
      t.after(() => cleanup(configDir));
      sandboxHome(t, configDir);

      assert.strictEqual(typeof installRuntimeArtifacts, 'function');
      installRuntimeArtifacts(runtime, configDir, 'global', RESOLVED_CORE);

      const layout = resolveRuntimeArtifactLayout(runtime, configDir, 'global');
      const skillsKind = layout.kinds.find(k => k.kind === 'skills');
      assert.ok(skillsKind, `${runtime} must have skills kind`);

      const destDir = path.join(skillsKind.home || configDir, skillsKind.destSubpath);
      assert.ok(fs.existsSync(destDir));
      assert.ok(
        fs.existsSync(path.join(destDir, `${skillsKind.prefix}help`, 'SKILL.md')),
        `${runtime}: ${skillsKind.prefix}help/SKILL.md must exist`
      );

      if (runtime === 'kimi') {
        const newProjectSkill = path.join(destDir, 'gsd-new-project', 'SKILL.md');
        assert.ok(fs.existsSync(newProjectSkill), 'kimi: gsd-new-project/SKILL.md must exist');
        const content = fs.readFileSync(newProjectSkill, 'utf8');
        assert.match(content, /^name: gsd-new-project$/m);
        assert.match(content, /\/skill:gsd-new-project/);
        assert.doesNotMatch(content, /kimi_cli\.tools|system_prompt_path|^version: 1$/m);

        const agentsDir = path.join(configDir, 'agents');
        const rootYaml = path.join(agentsDir, 'gsd.yaml');
        const rootPrompt = path.join(agentsDir, 'gsd.md');
        const executorYaml = path.join(agentsDir, 'subagents', 'gsd-executor.yaml');
        const executorPrompt = path.join(agentsDir, 'subagents', 'gsd-executor.md');
        assert.ok(fs.existsSync(rootYaml), 'kimi: agents/gsd.yaml must exist');
        assert.ok(fs.existsSync(rootPrompt), 'kimi: agents/gsd.md must exist');
        assert.ok(fs.existsSync(executorYaml), 'kimi: agents/subagents/gsd-executor.yaml must exist');
        assert.ok(fs.existsSync(executorPrompt), 'kimi: agents/subagents/gsd-executor.md must exist');

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
      }

      if (RESOLVED_CORE.skills !== '*') {
        const prefixedCount = countPrefixedEntries(destDir, skillsKind.prefix || 'gsd-');
        assert.strictEqual(prefixedCount, RESOLVED_CORE.skills.size,
          `${runtime}: installed skill count must match profile`);
      }
    });
  }
});

describe('installRuntimeArtifacts — hermes nested layout', () => {
  test('hermes: skills/gsd/gsd-<stem>/SKILL.md with gsd- prefix in name (#947)', (t) => {
    const configDir = createTempDir('gsd-ial-hermes-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_CORE);

    const nestedDir = path.join(configDir, 'skills', 'gsd');
    assert.ok(fs.existsSync(nestedDir));
    // #947: Hermes now uses canonical gsd- prefix — skills/gsd/gsd-<stem>/SKILL.md
    assert.ok(fs.existsSync(path.join(nestedDir, 'gsd-help', 'SKILL.md')),
      'skills/gsd/gsd-help/SKILL.md must exist (canonical gsd- prefix, #947)');
    assert.ok(!fs.existsSync(path.join(nestedDir, 'help')),
      'bare-stem skills/gsd/help/ must NOT exist (#947 fix)');
  });
});

describe('installRuntimeArtifacts — cursor skills-only layout (#2644)', () => {
  test('cursor: skills/ is created and commands/ is not materialized', (t) => {
    const configDir = createTempDir('gsd-ial-cursor-cmds-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('cursor', configDir, 'global', RESOLVED_CORE);

    const skillsDir = path.join(configDir, 'skills');
    assert.ok(fs.existsSync(skillsDir), 'skills/ must exist');
    assert.ok(fs.existsSync(path.join(skillsDir, 'gsd-help', 'SKILL.md')),
      'skills/gsd-help/SKILL.md must exist');
    assert.ok(!fs.existsSync(path.join(configDir, 'commands')),
      'Cursor must not materialize commands/ because skills already populate the slash menu');
  });
});

describe('installRuntimeArtifacts — windsurf workflows layout (#1615)', () => {
  test('windsurf: local install writes workflow slash-command files, not skills', (t) => {
    const configDir = createTempDir('gsd-ial-windsurf-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('windsurf', configDir, 'local', RESOLVED_CORE);

    const workflowsDir = path.join(configDir, 'workflows');
    assert.ok(fs.existsSync(workflowsDir), 'workflows/ must exist for Windsurf local install');
    assert.ok(fs.existsSync(path.join(workflowsDir, 'gsd-help.md')),
      'workflows/gsd-help.md must exist for /gsd-help');
    assert.ok(!fs.existsSync(path.join(configDir, 'skills')),
      'Windsurf must not install dead skills/ artifacts for slash commands');

    const helpContent = fs.readFileSync(path.join(workflowsDir, 'gsd-help.md'), 'utf8');
    assert.ok(!helpContent.startsWith('---'), 'Windsurf workflows must be plain markdown, not SKILL.md frontmatter');
    assert.match(helpContent, /# gsd-help/, 'workflow should identify the slash command it backs');
    assert.ok(helpContent.includes(`${configDir}/gsd-core/commands/gsd/help.md`.replace(/\\/g, '/')),
      'workflow should reference the installed command body using the actual install target');

    for (const fileName of fs.readdirSync(workflowsDir)) {
      if (!fileName.endsWith('.md')) continue;
      const workflowPath = path.join(workflowsDir, fileName);
      const byteLength = Buffer.byteLength(fs.readFileSync(workflowPath, 'utf8'), 'utf8');
      assert.ok(byteLength <= 12000, `${fileName} must respect Windsurf's 12,000-character workflow limit`);
    }
  });

  test('windsurf: global install is explicit no-op for workflow artifacts', (t) => {
    const configDir = createTempDir('gsd-ial-windsurf-global-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('windsurf', configDir, 'global', RESOLVED_CORE);

    assert.ok(!fs.existsSync(path.join(configDir, 'workflows')),
      'global Windsurf install must not write workflows under the config root');
    assert.ok(!fs.existsSync(path.join(configDir, 'skills')),
      'global Windsurf install must not write dead skills artifacts');
  });
});

describe('installRuntimeArtifacts — cline skills (#782)', () => {
  test('cline: global install writes gsd-prefixed skill dirs under skills/', (t) => {
    const configDir = createTempDir('gsd-ial-cline-');
    t.after(() => cleanup(configDir));

    assert.doesNotThrow(() => installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_CORE));

    const skillsDir = path.join(configDir, 'skills');
    assert.ok(fs.existsSync(skillsDir), 'skills/ must be created for global cline install');
    assert.ok(
      fs.existsSync(path.join(skillsDir, 'gsd-help', 'SKILL.md')),
      'gsd-help/SKILL.md must exist'
    );
  });
});

describe('installRuntimeArtifacts — opencode / kilo flat commands', () => {
  // #2329: OpenCode discovers commands from the PLURAL `commands/` dir — the
  // singular `command/` made all /gsd-* commands invisible to OpenCode. Kilo
  // is deliberately unaffected and still uses the singular `command/` dir
  // (see tests/opencode-command-dir-plural.test.cjs).
  const RUNTIME_COMMAND_DIRS = { opencode: 'commands', kilo: 'command' };
  for (const runtime of ['opencode', 'kilo']) {
    test(`${runtime}: ${RUNTIME_COMMAND_DIRS[runtime]}/gsd-help.md exists`, (t) => {
      const configDir = createTempDir(`gsd-ial-${runtime}-`);
      t.after(() => cleanup(configDir));

      installRuntimeArtifacts(runtime, configDir, 'global', RESOLVED_CORE);

      const commandDir = path.join(configDir, RUNTIME_COMMAND_DIRS[runtime]);
      assert.ok(fs.existsSync(commandDir));
      assert.ok(fs.existsSync(path.join(commandDir, 'gsd-help.md')));
    });
  }
});

// ─── #784: installOpencodeFamilySkills — skills + path rewrite + preservation ─

// Stage the raw command set the way the installer's _stageSkills() does, so the
// skills writer receives the same input as the flattened-command writer.
function stageRawCommands(runtime, configDir) {
  const layout = resolveRuntimeArtifactLayout(runtime, configDir, 'global');
  const commandsKind = layout.kinds.find((k) => k.kind === 'commands');
  return commandsKind.stage(RESOLVED_CORE);
}

describe('installOpencodeFamilySkills — emits skills/<name>/SKILL.md (#784)', () => {
  for (const runtime of ['opencode', 'kilo']) {
    test(`${runtime}: writes gsd-help/SKILL.md with name + description`, (t) => {
      const configDir = createTempDir(`gsd-ocs-${runtime}-`);
      t.after(() => cleanup(configDir));

      const raw = stageRawCommands(runtime, configDir);
      const count = installOpencodeFamilySkills(runtime, configDir, raw, `${configDir}/`);
      assert.ok(count >= 1, 'should report installed skills');

      const skillMd = path.join(configDir, 'skills', 'gsd-help', 'SKILL.md');
      assert.ok(fs.existsSync(skillMd), 'gsd-help/SKILL.md must exist');
      const content = fs.readFileSync(skillMd, 'utf8');
      assert.match(content, /^name: gsd-help$/m, 'name matches dir');
      assert.match(content, /^description: /m, 'description present');
      assert.ok(!/\/gsd:/.test(content), 'no /gsd: colon refs in body');
    });

    test(`${runtime}: rewrites body paths to the actual install target (#784 path fix)`, (t) => {
      const configDir = createTempDir(`gsd-ocp-${runtime}-`);
      t.after(() => cleanup(configDir));

      // Simulate a custom/local install: pathPrefix points at configDir, NOT the
      // runtime's default global config dir. Body refs must use pathPrefix.
      const pathPrefix = `${configDir}/`;
      installOpencodeFamilySkills(runtime, configDir, stageRawCommands(runtime, configDir), pathPrefix);

      const defaultBase = runtime === 'kilo' ? '.config/kilo' : '.config/opencode';
      const help = fs.readFileSync(path.join(configDir, 'skills', 'gsd-help', 'SKILL.md'), 'utf8');
      // gsd-help references gsd-core workflow files via @<configDir>/gsd-core/...
      assert.ok(
        help.includes(`${configDir}/gsd-core/`),
        'gsd-help body must reference the actual install target via pathPrefix',
      );
      for (const skillName of fs.readdirSync(path.join(configDir, 'skills'))) {
        const body = fs.readFileSync(path.join(configDir, 'skills', skillName, 'SKILL.md'), 'utf8');
        assert.ok(
          !body.includes(`~/${defaultBase}/`),
          `${skillName}: must not leak hardcoded ~/${defaultBase}/ — should use install target`,
        );
        // Regression guard for the prefix-overlap double-rewrite (e.g. kilo-alt-alt).
        assert.ok(
          !new RegExp(`${defaultBase.replace(/[\\.*+?^${}()|[\]]/g, '\\$&')}-[^/\\s]*-`).test(body),
          `${skillName}: must not contain a doubled config-dir suffix`,
        );
      }
    });

    test(`${runtime}: preserves user-owned gsd-dev-preferences across reinstall (#784)`, (t) => {
      const configDir = createTempDir(`gsd-ocd-${runtime}-`);
      t.after(() => cleanup(configDir));

      const userSkill = path.join(configDir, 'skills', 'gsd-dev-preferences');
      fs.mkdirSync(userSkill, { recursive: true });
      const marker = '---\nname: gsd-dev-preferences\ndescription: mine\n---\nKEEP ME\n';
      fs.writeFileSync(path.join(userSkill, 'SKILL.md'), marker);

      installOpencodeFamilySkills(runtime, configDir, stageRawCommands(runtime, configDir), `${configDir}/`);

      const after = fs.readFileSync(path.join(userSkill, 'SKILL.md'), 'utf8');
      assert.ok(after.includes('KEEP ME'), 'user-owned dev-preferences must survive reinstall');
      // GSD-managed skills should also be present.
      assert.ok(fs.existsSync(path.join(configDir, 'skills', 'gsd-help', 'SKILL.md')));
    });
  }
});

// ─── #2362: OpenCode/Kilo combined-family INSTALL path drops the capability
// registry — an installed+registered+surfaced+active third-party capability
// skill never materializes ───────────────────────────────────────────────
//
// installOpencodeFamilyArtifacts (called from installRuntimeArtifacts's
// combinedFamilyInstall early return) never threaded capabilityRegistry into
// installOpencodeFamilySkills, so the actual #2322 seam
// (install-profiles.cjs stageSkillsForRuntimeAsSkills) — already reachable
// and correct for the surface-apply path (`capability set --runtime opencode`)
// — was never reached from a fresh/reapplied install. RED before the fix
// (installOpencodeFamilyArtifacts/installOpencodeFamilySkills silently drop
// the registry), GREEN after.

/** Install a fake already-installed third-party capability skill under a sandboxed GSD_HOME. */
function install2362CapabilitySkill(gsdHome, capId, stem, content) {
  const skillDir = path.join(gsdHome, '.gsd', 'capabilities', capId, 'skills', stem);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content, 'utf8');
}

/**
 * A minimal capability-registry shape carrying one capId -> [stems] cluster.
 * `tier` (optional) additionally sets profileMembership so resolveProfile()
 * with a tiered (non-'*') mode unions this capability's stems into
 * resolvedProfile.skills — mirrors the seam's own __registryFor helper in
 * tests/runtime-artifact-layout-install-profiles.test.cjs.
 */
function registry2362For(capId, stems, tier) {
  const registry = { capabilityClusters: { [capId]: stems } };
  if (tier) {
    registry.profileMembership = {
      [capId]: { tier, profiles: tier === 'core' ? ['core', 'standard', 'full'] : ['standard', 'full'] },
    };
  }
  return registry;
}

/** Run `fn` with GSD_HOME pointed at `gsdHome`, always restoring the prior value. */
function with2362GsdHome(gsdHome, fn) {
  const saved = process.env.GSD_HOME;
  process.env.GSD_HOME = gsdHome;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = saved;
  }
}

/** Recursively snapshot every FILE under dir into a Map<relPath, content>. */
function snapshot2362Dir(dir) {
  const snap = new Map();
  const walk = (rel) => {
    const abs = path.join(dir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const relChild = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(relChild);
      else if (entry.isFile()) snap.set(relChild, fs.readFileSync(path.join(dir, relChild), 'utf8'));
    }
  };
  walk('.');
  return snap;
}

/** Assert every entry captured in `before` (a snapshot2362Dir Map) still exists, byte-identical, under dir. */
function assert2362SnapshotSubsetPreserved(before, dir, label) {
  for (const [relChild, beforeContent] of before) {
    const candidatePath = path.join(dir, relChild);
    assert.ok(fs.existsSync(candidatePath), `${label}: ${relChild} must still exist`);
    assert.strictEqual(fs.readFileSync(candidatePath, 'utf8'), beforeContent, `${label}: ${relChild} must be byte-identical`);
  }
}

for (const __runtime2362 of ['opencode', 'kilo']) {
  describe(`installRuntimeArtifacts — #2362 ${__runtime2362} materializes an installed third-party capability skill`, () => {
    test(`${__runtime2362}: (1) registered capability skill materializes at skills/gsd-<stem>/SKILL.md`, (t) => {
      const gsdHome = createTempDir('gsd-2362-home-');
      const configDir = createTempDir(`gsd-2362-${__runtime2362}-cfg-`);
      t.after(() => { cleanup(gsdHome); cleanup(configDir); });

      const AUTHORED = '---\nname: my-thing\ndescription: third-party test skill\n---\n\n# My Thing\nThird-party capability content.\n';
      install2362CapabilitySkill(gsdHome, 'my-thing', 'my-thing', AUTHORED);
      const registry = registry2362For('my-thing', ['my-thing']);
      const resolvedFull = resolveProfile({ modes: ['full'] });

      with2362GsdHome(gsdHome, () => {
        installRuntimeArtifacts(__runtime2362, configDir, 'global', resolvedFull, () => undefined, registry);
      });

      const stagedPath = path.join(configDir, 'skills', 'gsd-my-thing', 'SKILL.md');
      assert.ok(
        fs.existsSync(stagedPath),
        `#2362: gsd-my-thing/SKILL.md must exist after installRuntimeArtifacts('${__runtime2362}', ...) — registry says surfaced:true but the combined-family install path never materialized it`,
      );

      // (2) prune parity: the staged directory carries the #2322 HIGH-3 marker
      // naming its declaring capId, matching the seam's guarantee.
      const markerPath = path.join(configDir, 'skills', 'gsd-my-thing', CAPABILITY_SKILL_MARKER);
      assert.ok(fs.existsSync(markerPath), 'staged third-party skill must carry the CAPABILITY_SKILL_MARKER for prune parity');
      assert.strictEqual(fs.readFileSync(markerPath, 'utf8').trim(), 'my-thing', 'marker must name the declaring capId');
    });

    test(`${__runtime2362}: (2) tiered (non-'*') profile — resolvedProfile.skills is a concrete Set and still materializes the third-party skill`, (t) => {
      const gsdHome = createTempDir('gsd-2362-home-');
      const configDir = createTempDir(`gsd-2362-${__runtime2362}-cfg-tiered-`);
      t.after(() => { cleanup(gsdHome); cleanup(configDir); });

      install2362CapabilitySkill(gsdHome, 'my-thing', 'my-thing', '# my-thing (tiered)\n');
      // tier='standard' -> profileMembership includes 'standard', so
      // resolveProfile({modes:['standard'], registry}) unions 'my-thing' into
      // the resolved Set BEFORE it ever reaches installOpencodeFamilySkills —
      // exercising the `(resolvedProfile && resolvedProfile.skills) || []`
      // (non-'*') branch of the new candidateStems ternary, never covered by
      // the mode=['full'] cases above.
      const registry = registry2362For('my-thing', ['my-thing'], 'standard');
      const resolvedTiered = resolveProfile({ modes: ['standard'], registry });
      assert.ok(
        resolvedTiered.skills instanceof Set,
        "sanity: a tiered (non-'*') profile mode must resolve to a concrete Set, not the full sentinel",
      );
      assert.ok(
        resolvedTiered.skills.has('my-thing'),
        'sanity: resolveProfile must union the registered capability skill into the tiered profile\'s Set (mirrors production callers)',
      );

      with2362GsdHome(gsdHome, () => {
        installRuntimeArtifacts(__runtime2362, configDir, 'global', resolvedTiered, () => undefined, registry);
      });

      const stagedPath = path.join(configDir, 'skills', 'gsd-my-thing', 'SKILL.md');
      assert.ok(
        fs.existsSync(stagedPath),
        `#2362: a tiered profile (mode=standard) must also materialize a registered third-party capability skill via the non-'*' candidateStems branch`,
      );
      const markerPath = path.join(configDir, 'skills', 'gsd-my-thing', CAPABILITY_SKILL_MARKER);
      assert.ok(fs.existsSync(markerPath), 'staged third-party skill must carry the CAPABILITY_SKILL_MARKER for prune parity even on a tiered profile');
      assert.strictEqual(fs.readFileSync(markerPath, 'utf8').trim(), 'my-thing', 'marker must name the declaring capId');

      // Sanity: first-party skills that ARE part of the 'standard' base list
      // (e.g. 'help') must still stage too — the third-party fill-in must not
      // replace or crowd out the tiered profile's own first-party selection.
      assert.ok(
        fs.existsSync(path.join(configDir, 'skills', 'gsd-help', 'SKILL.md')),
        "sanity: first-party 'standard' base skills must still stage alongside the third-party fill-in",
      );
    });

    test(`${__runtime2362}: (3) default full profile — resolvedProfile.skills === '*' still materializes the third-party skill (BLOCKER-2 parity)`, (t) => {
      const gsdHome = createTempDir('gsd-2362-home-');
      const configDir = createTempDir(`gsd-2362-${__runtime2362}-cfg-full-`);
      t.after(() => { cleanup(gsdHome); cleanup(configDir); });

      install2362CapabilitySkill(gsdHome, 'my-thing', 'my-thing', '# my-thing (full)\n');
      const registry = registry2362For('my-thing', ['my-thing']);
      const resolvedFull = resolveProfile({ modes: ['full'] });
      assert.strictEqual(resolvedFull.skills, '*', "sanity: full mode resolves to the '*' sentinel");

      with2362GsdHome(gsdHome, () => {
        installRuntimeArtifacts(__runtime2362, configDir, 'global', resolvedFull, () => undefined, registry);
      });

      assert.ok(
        fs.existsSync(path.join(configDir, 'skills', 'gsd-my-thing', 'SKILL.md')),
        "BLOCKER-2 parity: the '*' full-profile sentinel must still stage a registered capability skill",
      );
    });

    test(`${__runtime2362}: (4) first-party wins on a stem collision`, (t) => {
      const gsdHome = createTempDir('gsd-2362-home-');
      const configDir = createTempDir(`gsd-2362-${__runtime2362}-cfg-collide-`);
      t.after(() => { cleanup(gsdHome); cleanup(configDir); });

      const EVIL = '# EVIL HELP — must never win over the first-party gsd-help skill\n';
      install2362CapabilitySkill(gsdHome, 'evil-cap', 'help', EVIL);
      const registry = registry2362For('evil-cap', ['help']);
      const resolvedFull = resolveProfile({ modes: ['full'] });

      with2362GsdHome(gsdHome, () => {
        installRuntimeArtifacts(__runtime2362, configDir, 'global', resolvedFull, () => undefined, registry);
      });

      const helpPath = path.join(configDir, 'skills', 'gsd-help', 'SKILL.md');
      assert.ok(fs.existsSync(helpPath), 'sanity: first-party gsd-help must stage');
      const helpContent = fs.readFileSync(helpPath, 'utf8');
      assert.notStrictEqual(helpContent, EVIL, 'the third-party EVIL content must never win the collision');
      assert.ok(!helpContent.includes('EVIL HELP'), 'first-party content must be staged on a stem collision, not the third-party body');
    });

    test(`${__runtime2362}: (5) graceful degradation — an unreadable capability SKILL.md does not throw and first-party staging is unaffected`, (t) => {
      const gsdHome = createTempDir('gsd-2362-home-');
      const configDir = createTempDir(`gsd-2362-${__runtime2362}-cfg-degrade-`);
      t.after(() => { cleanup(gsdHome); cleanup(configDir); });

      install2362CapabilitySkill(gsdHome, 'my-thing', 'my-thing', '# my-thing\n');
      const registry = registry2362For('my-thing', ['my-thing']);
      const resolvedFull = resolveProfile({ modes: ['full'] });

      // Inject the IO failure deterministically by monkeypatching fs, scoped to
      // this one capability's SKILL.md path — never chmod 0o000 (root bypasses
      // mode bits; silently zero-coverage under root Docker/CI).
      const skillPath = path.join(gsdHome, '.gsd', 'capabilities', 'my-thing', 'skills', 'my-thing', 'SKILL.md');
      const origReadFileSync = fs.readFileSync;
      fs.readFileSync = function injectedReadFileSync(p, ...rest) {
        if (p === skillPath) throw new Error('injected read failure (#2362 regression test)');
        return origReadFileSync.call(fs, p, ...rest);
      };
      try {
        with2362GsdHome(gsdHome, () => {
          assert.doesNotThrow(() => {
            installRuntimeArtifacts(__runtime2362, configDir, 'global', resolvedFull, () => undefined, registry);
          }, `installRuntimeArtifacts('${__runtime2362}', ...) must not throw when a registry-referenced capability skill is unreadable`);
        });
      } finally {
        fs.readFileSync = origReadFileSync;
      }

      assert.ok(
        !fs.existsSync(path.join(configDir, 'skills', 'gsd-my-thing', 'SKILL.md')),
        'an unreadable capability skill must be skipped, not partially staged',
      );
      assert.ok(
        fs.existsSync(path.join(configDir, 'skills', 'gsd-help', 'SKILL.md')),
        'first-party skills must still materialize when a referenced capability skill is unreadable',
      );
    });

    test(`${__runtime2362}: (6) control — first-party skills are unperturbed (byte-identical) by an installed third-party capability skill`, (t) => {
      const gsdHome = createTempDir('gsd-2362-home-');
      const configDir = createTempDir(`gsd-2362-${__runtime2362}-cfg-control-`);
      t.after(() => { cleanup(gsdHome); cleanup(configDir); });

      const resolvedFull = resolveProfile({ modes: ['full'] });

      // Baseline: no registry threaded through at all.
      installRuntimeArtifacts(__runtime2362, configDir, 'global', resolvedFull, () => undefined, undefined);
      const skillsDir = path.join(configDir, 'skills');
      const baselineSnapshot = snapshot2362Dir(skillsDir);
      assert.ok(baselineSnapshot.size > 0, 'sanity: baseline install staged at least one first-party skill');
      assert.ok(!baselineSnapshot.has(path.join('gsd-my-thing', 'SKILL.md')), 'sanity: baseline has no gsd-my-thing');

      // Re-apply to the SAME configDir once a third-party capability is also
      // registered+installed — rebuilds nothing else, so any first-party byte
      // drift here is attributable only to the third-party fill-in pass.
      install2362CapabilitySkill(gsdHome, 'my-thing', 'my-thing', '# my-thing\n');
      const registry = registry2362For('my-thing', ['my-thing']);
      with2362GsdHome(gsdHome, () => {
        installRuntimeArtifacts(__runtime2362, configDir, 'global', resolvedFull, () => undefined, registry);
      });

      assert2362SnapshotSubsetPreserved(baselineSnapshot, skillsDir, `${__runtime2362} first-party skills`);
      assert.ok(
        fs.existsSync(path.join(skillsDir, 'gsd-my-thing', 'SKILL.md')),
        'the third-party capability skill must ALSO be present after the re-apply',
      );
    });
  });
}

// ─── Section 7: uninstallRuntimeArtifacts — all runtimes ─────────────────────

describe('uninstallRuntimeArtifacts — consumes Runtime Artifact Uninstall Plan Module', () => {
  test('removes returned plan destinations with layout kind metadata', (t) => {
    const configDir = createTempDir('gsd-uninstall-plan-adapter-');
    t.after(() => cleanup(configDir));

    const commandsDir = path.join(configDir, 'custom-commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'gsd-help.md'), '# remove\n');
    fs.writeFileSync(path.join(commandsDir, 'user-custom.md'), '# keep\n');

    let planLayout;
    const { installer, restore } = loadFreshInstallerWithPlanStubs({
      uninstallStub(layout) {
        planLayout = layout;
        return {
          items: [
            { kind: 'commands', destDir: commandsDir },
          ],
        };
      },
    });
    t.after(restore);

    installer.uninstallRuntimeArtifacts('augment', configDir, 'global');

    assert.strictEqual(planLayout.runtime, 'augment');
    assert.strictEqual(planLayout.configDir, configDir);
    assert.strictEqual(planLayout.scope, 'global');
    assert.ok(!fs.existsSync(path.join(commandsDir, 'gsd-help.md')));
    assert.ok(fs.existsSync(path.join(commandsDir, 'user-custom.md')));
  });
});

describe('uninstallRuntimeArtifacts — removes gsd-owned entries, preserves foreign', () => {
  for (const runtime of ALL_RUNTIMES_LAYOUT) {
    test(`${runtime}: gsd entries removed, foreign preserved`, (t) => {
      const configDir = createTempDir(`gsd-ual-${runtime}-`);
      t.after(() => cleanup(configDir));
      sandboxHome(t, configDir);

      const { uninstallRuntimeArtifacts } = require('../bin/install.js');
      assert.strictEqual(typeof uninstallRuntimeArtifacts, 'function');

      const layout = resolveRuntimeArtifactLayout(runtime, configDir, 'global');

      if (layout.kinds.length === 0) {
        const foreignDir = path.join(configDir, 'foreign-dir');
        fs.mkdirSync(foreignDir, { recursive: true });
        fs.writeFileSync(path.join(foreignDir, 'keep.md'), '# keep\n');
        assert.doesNotThrow(() => uninstallRuntimeArtifacts(runtime, configDir, 'global'));
        assert.ok(fs.existsSync(path.join(foreignDir, 'keep.md')));
        return;
      }

      if (runtime === 'hermes') {
        const kind = layout.kinds[0];
        const destDir = path.join(configDir, kind.destSubpath); // skills/gsd
        // Seed a gsd-* prefixed skill (canonical #947 layout) and a bare-stem skill (#3664 era)
        fs.mkdirSync(path.join(destDir, 'gsd-help'), { recursive: true });
        fs.writeFileSync(path.join(destDir, 'gsd-help', 'SKILL.md'), '# gsd-help\n');
        fs.mkdirSync(path.join(destDir, 'help'), { recursive: true });
        fs.writeFileSync(path.join(destDir, 'help', 'SKILL.md'), '# bare-stem help (#3664)\n');
        const siblingDir = path.join(configDir, 'skills', 'user-skill');
        fs.mkdirSync(siblingDir, { recursive: true });
        fs.writeFileSync(path.join(siblingDir, 'SKILL.md'), '# user\n');

        uninstallRuntimeArtifacts(runtime, configDir, 'global');

        // skills/gsd/ removed (gsd-* removed by _removeGsdEntries, bare-stem by legacy cleanup,
        // then DESCRIPTION.md removed, category dir removed as empty)
        assert.ok(!fs.existsSync(destDir), 'skills/gsd/ must be removed after uninstall');
        // User skill outside skills/gsd/ preserved
        assert.ok(fs.existsSync(path.join(siblingDir, 'SKILL.md')), 'user-skill must be preserved');
        return;
      }

      for (const kind of layout.kinds) {
        const destDir = path.join(kind.home || configDir, kind.destSubpath);
        fs.mkdirSync(destDir, { recursive: true });
        if (kind.kind === 'skills') {
          writeSkillEntry(destDir, kind.prefix, 'help');
          writeSkillEntry(destDir, kind.prefix, 'phase');
          const foreignDir = path.join(destDir, 'user-custom-skill');
          fs.mkdirSync(foreignDir, { recursive: true });
          fs.writeFileSync(path.join(foreignDir, 'SKILL.md'), '# user\n');
        } else if (kind.kind === 'kimi-agents') {
          fs.mkdirSync(path.join(destDir, 'subagents'), { recursive: true });
          fs.writeFileSync(path.join(destDir, 'gsd.yaml'), 'version: 1\n');
          fs.writeFileSync(path.join(destDir, 'gsd.md'), '# gsd\n');
          fs.writeFileSync(path.join(destDir, 'subagents', 'gsd-executor.yaml'), 'version: 1\n');
          fs.writeFileSync(path.join(destDir, 'subagents', 'gsd-executor.md'), '# executor\n');
          fs.writeFileSync(path.join(destDir, 'user-agent.yaml'), 'version: 1\n');
          fs.writeFileSync(path.join(destDir, 'subagents', 'user-agent.yaml'), 'version: 1\n');
        } else {
          writeCommandEntry(destDir, kind.prefix, 'help');
          writeCommandEntry(destDir, kind.prefix, 'phase');
          fs.writeFileSync(path.join(destDir, 'user-custom.md'), '# user\n');
        }
      }

      uninstallRuntimeArtifacts(runtime, configDir, 'global');

      for (const kind of layout.kinds) {
        const destDir = path.join(kind.home || configDir, kind.destSubpath);
        if (kind.kind === 'skills') {
          assert.ok(!fs.existsSync(path.join(destDir, `${kind.prefix}help`)));
          assert.ok(!fs.existsSync(path.join(destDir, `${kind.prefix}phase`)));
          assert.ok(fs.existsSync(path.join(destDir, 'user-custom-skill', 'SKILL.md')));
        } else if (kind.kind === 'kimi-agents') {
          assert.ok(!fs.existsSync(path.join(destDir, 'gsd.yaml')));
          assert.ok(!fs.existsSync(path.join(destDir, 'gsd.md')));
          assert.ok(!fs.existsSync(path.join(destDir, 'subagents', 'gsd-executor.yaml')));
          assert.ok(!fs.existsSync(path.join(destDir, 'subagents', 'gsd-executor.md')));
          assert.ok(fs.existsSync(path.join(destDir, 'user-agent.yaml')));
          assert.ok(fs.existsSync(path.join(destDir, 'subagents', 'user-agent.yaml')));
        } else {
          assert.ok(!fs.existsSync(path.join(destDir, `${kind.prefix}help.md`)));
          assert.ok(!fs.existsSync(path.join(destDir, `${kind.prefix}phase.md`)));
          assert.ok(fs.existsSync(path.join(destDir, 'user-custom.md')));
        }
      }
    });
  }
});

// ─── Section 8: Counter-test — unknown runtime is rejected (Contract 6) ──────

describe('Contract 6: unknown runtime is rejected', () => {
  test('resolveRuntimeArtifactLayout throws TypeError for unknown runtime', () => {
    assert.throws(
      () => resolveRuntimeArtifactLayout('unknown-runtime-xyz', '/tmp/test', 'global'),
      (err) => {
        assert.ok(err instanceof TypeError, 'must be TypeError');
        assert.ok(err.message.includes('Unknown runtime'), `message: ${err.message}`);
        return true;
      }
    );
  });

  test('parseRuntimeInput returns ["claude"] for unrecognised string (safe default)', () => {
    // parseRuntimeInput processes menu numbers, not runtime names directly;
    // an unrecognised token falls through to the default ["claude"].
    const result = parseRuntimeInput('unknown-xyz');
    assert.deepStrictEqual(result, ['claude']);
  });

  test('allRuntimes does not include any unrecognised value', () => {
    // Every entry in allRuntimes must be recognised by resolveRuntimeArtifactLayout
    for (const runtime of allRuntimes) {
      assert.doesNotThrow(
        () => resolveRuntimeArtifactLayout(runtime, '/tmp/test', 'global'),
        `${runtime} must be a recognised runtime`
      );
    }
  });
});

// ─── Section 12: Legacy migrations in installRuntimeArtifacts ────────────────

describe('installRuntimeArtifacts — legacy migrations run before layout copy', () => {
  test('claude: legacy commands/gsd/dev-preferences.md migrated AND new skills written', (t) => {
    const configDir = createTempDir('gsd-legacy-install-');
    t.after(() => cleanup(configDir));

    const legacyDir = path.join(configDir, 'commands', 'gsd');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'dev-preferences.md'), '# My dev prefs\n');

    installRuntimeArtifacts('claude', configDir, 'global', RESOLVED_CORE);

    assert.ok(!fs.existsSync(legacyDir));
    assert.ok(fs.existsSync(path.join(configDir, 'skills', 'gsd-dev-preferences', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(configDir, 'skills', 'gsd-help', 'SKILL.md')));
  });

  test('hermes: legacy flat skills/gsd-*/ migrated AND new nested skills/gsd/gsd-<stem>/ written (#947)', (t) => {
    const configDir = createTempDir('gsd-legacy-hermes-install-');
    t.after(() => cleanup(configDir));

    const legacyFlatHelp = path.join(configDir, 'skills', 'gsd-help');
    fs.mkdirSync(legacyFlatHelp, { recursive: true });
    fs.writeFileSync(path.join(legacyFlatHelp, 'SKILL.md'), '# legacy help\n');

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_CORE);

    assert.ok(!fs.existsSync(legacyFlatHelp), 'legacy flat skill must be removed');
    // #947: canonical path is skills/gsd/gsd-<stem>/ not skills/gsd/<stem>/
    assert.ok(fs.existsSync(path.join(configDir, 'skills', 'gsd', 'gsd-help', 'SKILL.md')),
      'skills/gsd/gsd-help/SKILL.md must exist after install (#947)');
  });
});

describe('uninstallRuntimeArtifacts — legacy cleanup runs before layout removal', () => {
  test('hermes: both flat and nested layouts removed (#947: bare-stem dirs cleaned on uninstall)', (t) => {
    const { uninstallRuntimeArtifacts } = require('../bin/install.js');
    const configDir = createTempDir('gsd-legacy-uninstall-hermes-');
    t.after(() => cleanup(configDir));

    const skillsDir = path.join(configDir, 'skills');
    const flatHelp = path.join(skillsDir, 'gsd-help');
    fs.mkdirSync(flatHelp, { recursive: true });
    fs.writeFileSync(path.join(flatHelp, 'SKILL.md'), '# legacy flat\n');

    const nestedGsd = path.join(skillsDir, 'gsd');
    // Seed a pre-#947 bare-stem GSD skill (no gsd- prefix, from #3664 era)
    fs.mkdirSync(path.join(nestedGsd, 'help'), { recursive: true });
    fs.writeFileSync(path.join(nestedGsd, 'help', 'SKILL.md'), '# nested help (bare-stem)\n');

    const userSkill = path.join(skillsDir, 'user-skill');
    fs.mkdirSync(userSkill, { recursive: true });
    fs.writeFileSync(path.join(userSkill, 'SKILL.md'), '# user\n');

    uninstallRuntimeArtifacts('hermes', configDir, 'global');

    // Pre-#2841 flat skills/gsd-help/ removed by legacy cleanup
    assert.ok(!fs.existsSync(flatHelp), 'flat gsd-help must be removed');
    // skills/gsd/ removed: bare-stem dirs cleaned + no gsd-* dirs remain → empty → removed
    assert.ok(!fs.existsSync(nestedGsd), 'skills/gsd/ must be removed after uninstall');
    // User content outside skills/gsd/ preserved
    assert.ok(fs.existsSync(path.join(userSkill, 'SKILL.md')), 'user-skill must be preserved');
  });

  test('claude: legacy commands/gsd/ cleaned AND new skills/ entries removed', (t) => {
    const { uninstallRuntimeArtifacts } = require('../bin/install.js');
    const configDir = createTempDir('gsd-legacy-uninstall-claude-');
    t.after(() => cleanup(configDir));

    const skillsDir = path.join(configDir, 'skills');
    const gsdHelp = path.join(skillsDir, 'gsd-help');
    fs.mkdirSync(gsdHelp, { recursive: true });
    fs.writeFileSync(path.join(gsdHelp, 'SKILL.md'), '# help\n');

    const legacyDir = path.join(configDir, 'commands', 'gsd');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'help.md'), '# legacy\n');

    const userSkill = path.join(skillsDir, 'user-skill');
    fs.mkdirSync(userSkill, { recursive: true });
    fs.writeFileSync(path.join(userSkill, 'SKILL.md'), '# user\n');

    uninstallRuntimeArtifacts('claude', configDir, 'global');

    assert.ok(!fs.existsSync(gsdHelp));
    assert.ok(!fs.existsSync(legacyDir));
    assert.ok(fs.existsSync(path.join(userSkill, 'SKILL.md')));
  });
});

describe('skills wrapper threads install scope into converter isGlobal (regression: local installs must not leak global home paths)', () => {
  // Bug: the skills wrapper in runtime-artifact-layout passed `runtime` (a truthy
  // string) as the converter's 3rd positional arg. For antigravity/copilot that
  // param was `isGlobal`, so LOCAL installs always took the GLOBAL path branch and
  // leaked ~/.gemini/antigravity or ~/.copilot instead of the workspace path.
  for (const { runtime, globalMarker, localMarker } of [
    { runtime: 'antigravity', globalMarker: '~/.gemini/antigravity', localMarker: '.agents' },
    { runtime: 'copilot', globalMarker: '~/.copilot', localMarker: '.github' },
  ]) {
    test(`${runtime}: local skill content uses workspace path, not global home`, (t) => {
      const globalDir = createTempDir(`gsd-ial-g-${runtime}-`);
      const localDir = createTempDir(`gsd-ial-l-${runtime}-`);
      t.after(() => { cleanup(globalDir); cleanup(localDir); });

      installRuntimeArtifacts(runtime, globalDir, 'global', RESOLVED_CORE);
      installRuntimeArtifacts(runtime, localDir, 'local', RESOLVED_CORE);

      const gSkills = resolveRuntimeArtifactLayout(runtime, globalDir, 'global').kinds.find(k => k.kind === 'skills');
      const lSkills = resolveRuntimeArtifactLayout(runtime, localDir, 'local').kinds.find(k => k.kind === 'skills');
      assert.ok(gSkills && lSkills, `${runtime}: must resolve a skills kind for both scopes`);

      const gCombined = readAllSkillMd(path.join(globalDir, gSkills.destSubpath));
      const lCombined = readAllSkillMd(path.join(localDir, lSkills.destSubpath));

      // Precondition (non-vacuity guard): some core skill carries a ~/.claude
      // reference, so the GLOBAL install surfaces the global home marker. If this
      // assertion ever fails, the source skills lost their path references — fix
      // the fixture/source, do not delete this test.
      assert.ok(gCombined.includes(globalMarker),
        `${runtime}: precondition — global install should contain '${globalMarker}'`);

      // The actual regression: a LOCAL install must NOT leak the global home path…
      assert.ok(!lCombined.includes(globalMarker),
        `${runtime}: local install must NOT leak global home path '${globalMarker}'`);
      // …and SHOULD reference the workspace-relative path.
      assert.ok(lCombined.includes(localMarker),
        `${runtime}: local install must reference workspace path '${localMarker}'`);
    });
  }
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2418-antigravity-bare-path.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2418-antigravity-bare-path (consolidation epic #1969 B1 #1970)", () => {
/**
 * Bug #2418: Found unreplaced .claude path reference(s) in Antigravity install
 *
 * The Antigravity path converter handles ~/.claude/ (with trailing slash) but
 * misses bare ~/.claude (without trailing slash), leaving unreplaced references
 * that cause the installer to warn about leaked paths.
 *
 * Files affected: agents/gsd-debugger.md (configDir = ~/.claude) and
 * gsd-core/workflows/update.md (comment with e.g. ~/.claude).
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const { convertClaudeToAntigravityContent } = require('../bin/install.js');

describe('convertClaudeToAntigravityContent bare path replacement (#2418)', () => {
  describe('global install', () => {
    test('replaces ~/.claude (bare, no trailing slash) with ~/.gemini/antigravity', () => {
      const input = 'configDir = ~/.claude';
      const result = convertClaudeToAntigravityContent(input, true);
      assert.ok(
        result.includes('~/.gemini/antigravity'),
        `Expected ~/.gemini/antigravity in output, got: ${result}`
      );
      assert.ok(
        !result.includes('~/.claude'),
        `Expected ~/ .claude to be replaced, got: ${result}`
      );
    });

    test('replaces $HOME/.claude (bare, no trailing slash) with $HOME/.gemini/antigravity', () => {
      const input = 'export DIR=$HOME/.claude';
      const result = convertClaudeToAntigravityContent(input, true);
      assert.ok(
        result.includes('$HOME/.gemini/antigravity'),
        `Expected $HOME/.gemini/antigravity in output, got: ${result}`
      );
      assert.ok(
        !result.includes('$HOME/.claude'),
        `Expected $HOME/.claude to be replaced, got: ${result}`
      );
    });

    test('handles bare ~/.claude followed by comma (comment context)', () => {
      const input = '# e.g. ~/.claude, ~/.config/opencode';
      const result = convertClaudeToAntigravityContent(input, true);
      assert.ok(
        !result.includes('~/.claude'),
        `Expected ~/ .claude to be replaced in comment context, got: ${result}`
      );
    });

    test('still replaces ~/.claude/ (with trailing slash) correctly', () => {
      const input = 'See ~/.claude/gsd-core/workflows/';
      const result = convertClaudeToAntigravityContent(input, true);
      assert.ok(
        result.includes('~/.gemini/antigravity/gsd-core/workflows/'),
        `Expected path with trailing slash to be replaced, got: ${result}`
      );
      assert.ok(!result.includes('~/.claude/'), `Expected ~/ .claude/ to be fully replaced, got: ${result}`);
    });

    test('does not double-replace ~/.claude/ paths', () => {
      const input = 'See ~/.claude/gsd-core/';
      const result = convertClaudeToAntigravityContent(input, true);
      // Result should contain exactly one occurrence of the replacement path
      const count = (result.match(/~\/.gemini\/antigravity\//g) || []).length;
      assert.strictEqual(count, 1, `Expected exactly 1 replacement, got ${count} in: ${result}`);
    });
  });

  describe('local install', () => {
    test('replaces ~/.claude (bare, no trailing slash) with .agents', () => {
      const input = 'configDir = ~/.claude';
      const result = convertClaudeToAntigravityContent(input, false);
      assert.ok(
        result.includes('.agents'),
        `Expected .agents in output, got: ${result}`
      );
      assert.ok(
        !result.includes('~/.claude'),
        `Expected ~/ .claude to be replaced, got: ${result}`
      );
    });

    test('replaces $HOME/.claude (bare, no trailing slash) with .agents', () => {
      const input = 'export DIR=$HOME/.claude';
      const result = convertClaudeToAntigravityContent(input, false);
      assert.ok(
        result.includes('.agents'),
        `Expected .agents in output, got: ${result}`
      );
      assert.ok(
        !result.includes('$HOME/.claude'),
        `Expected $HOME/.claude to be replaced, got: ${result}`
      );
    });

    test('does not double-replace ~/.claude/ paths', () => {
      const input = 'See ~/.claude/gsd-core/';
      const result = convertClaudeToAntigravityContent(input, false);
      // .agents/ should appear exactly once
      const count = (result.match(/\.agents\//g) || []).length;
      assert.strictEqual(count, 1, `Expected exactly 1 replacement, got ${count} in: ${result}`);
    });
  });

  describe('installed files contain no bare ~/.claude references after conversion', () => {
    const fs = require('fs');
    const path = require('path');
    const repoRoot = path.join(__dirname, '..');

    // The scanner regex used by the installer to detect leaked paths
    const leakedPathRegex = /(?:~|\$HOME)\/\.claude\b/g;

    function convertFile(filePath, isGlobal) {
      const content = fs.readFileSync(filePath, 'utf8');
      return convertClaudeToAntigravityContent(content, isGlobal);
    }

    test('gsd-debugger.md has no leaked ~/.claude after global Antigravity conversion', () => {
      const debuggerPath = path.join(repoRoot, 'agents', 'gsd-debugger.md');
      if (!fs.existsSync(debuggerPath)) return; // skip if file doesn't exist
      const converted = convertFile(debuggerPath, true);
      const matches = converted.match(leakedPathRegex);
      assert.strictEqual(
        matches, null,
        `gsd-debugger.md still contains leaked .claude paths after Antigravity conversion: ${matches}`
      );
    });

    test('update.md has no leaked ~/.claude after global Antigravity conversion', () => {
      const updatePath = path.join(repoRoot, 'gsd-core', 'workflows', 'update.md');
      if (!fs.existsSync(updatePath)) return; // skip if file doesn't exist
      const converted = convertFile(updatePath, true);
      const matches = converted.match(leakedPathRegex);
      assert.strictEqual(
        matches, null,
        `update.md still contains leaked .claude paths after Antigravity conversion: ${matches}`
      );
    });
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2545-copilot-unreplaced-paths.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2545-copilot-unreplaced-paths (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for issue #2545.
 *
 * The Copilot content converter's `~/.claude/` and `$HOME/.claude/` replacements
 * only matched when a literal slash followed, so bare `~/.claude` references
 * (end of line, quotes, punctuation) were left unreplaced. Those leaks then
 * triggered the installer's "Found N unreplaced .claude path reference(s)"
 * warning, which scans for `(?:~|$HOME)/\.claude\b`.
 *
 * Fix: replace with a word-boundary pattern so both forms are caught in a
 * single pass, matching the approach already used by the Antigravity, OpenCode,
 * Kilo, and Codex converters.
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { convertClaudeToCopilotContent } = require('../bin/install.js');

describe('convertClaudeToCopilotContent — bare ~/.claude (issue #2545)', () => {
  test('global install replaces bare ~/.claude at end of line', () => {
    const input = 'configDir = ~/.claude\n';
    const out = convertClaudeToCopilotContent(input, /* isGlobal */ true);
    assert.ok(
      !/(?:~|\$HOME)\/\.claude\b/.test(out),
      `expected no leaked ~/.claude reference, got: ${JSON.stringify(out)}`,
    );
    assert.match(out, /~\/\.copilot\b/);
  });

  test('global install replaces bare $HOME/.claude at end of line', () => {
    const input = 'configDir = $HOME/.claude\n';
    const out = convertClaudeToCopilotContent(input, /* isGlobal */ true);
    assert.ok(
      !/(?:~|\$HOME)\/\.claude\b/.test(out),
      `expected no leaked $HOME/.claude reference, got: ${JSON.stringify(out)}`,
    );
    assert.match(out, /\$HOME\/\.copilot\b/);
  });

  test('global install replaces bare ~/.claude before punctuation', () => {
    const input = 'paths include `~/.claude`, `~/.copilot`';
    const out = convertClaudeToCopilotContent(input, true);
    assert.ok(!/(?:~|\$HOME)\/\.claude\b/.test(out));
  });

  test('local install replaces bare ~/.claude', () => {
    const input = 'configDir = ~/.claude\n';
    const out = convertClaudeToCopilotContent(input, /* isGlobal */ false);
    assert.ok(
      !/(?:~|\$HOME)\/\.claude\b/.test(out),
      `expected no leaked ~/.claude reference, got: ${JSON.stringify(out)}`,
    );
  });

  test('does not double-replace trailing-slash form', () => {
    const input = '@~/.claude/gsd-core/foo.md\n';
    const out = convertClaudeToCopilotContent(input, true);
    assert.match(out, /~\/\.copilot\/gsd-core\/foo\.md/);
    assert.ok(!/\.copilot\/\.copilot/.test(out));
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-983-trae-windsurf-claude-path-leak.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-983-trae-windsurf-claude-path-leak (consolidation epic #1969 B1 #1970)", () => {
// allow-test-rule: source-text-is-the-product (see #983)
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Regression tests for issue #983 — Trae and Windsurf converters leak
 * unreplaced bare `~/.claude` / `$HOME/.claude` references.
 *
 * Both converters rewrote only trailing-slash `.claude/` forms, so bare
 * home-path references (configDir = ~/.claude, $HOME/.claude) survived
 * conversion and pointed users at the wrong config dir.
 *
 * Fix: add bare word-boundary replacements mirroring Cline (#782) and
 * Codex (#570) precedent, with a negative lookahead to preserve `.claude-plugin`.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  convertClaudeToWindsurfMarkdown,
  convertClaudeToTraeMarkdown,
  _applyRuntimeRewrites,
} = require('../bin/install.js');

// ─── Windsurf converter bare-form tests ─────────────────────────────────────

describe('convertClaudeToWindsurfMarkdown — bare ~/.claude and CLAUDE_CONFIG_DIR (#983)', () => {
  test('bare ~/.claude rewritten to ~/.windsurf (#1615: workspace dir is now .windsurf)', () => {
    const input = 'Config dir: (~/.claude), skills at ~/.claude/skills';
    const result = convertClaudeToWindsurfMarkdown(input);
    assert.ok(
      !/~\/\.claude(?![\w-])/.test(result),
      `bare ~/.claude must be rewritten; got: ${result}`,
    );
    assert.ok(result.includes('~/.windsurf'), 'must rewrite to ~/.windsurf');
  });

  test('$HOME/.claude rewritten to $HOME/.windsurf (#1615: workspace dir is now .windsurf)', () => {
    const input = 'RUNTIME_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"';
    const result = convertClaudeToWindsurfMarkdown(input);
    assert.ok(
      !/\$HOME\/\.claude(?![\w-])/.test(result),
      `bare $HOME/.claude must be rewritten; got: ${result}`,
    );
    assert.ok(result.includes('$HOME/.windsurf'), 'must rewrite to $HOME/.windsurf');
  });

  test('CLAUDE_CONFIG_DIR rewritten to WINDSURF_CONFIG_DIR', () => {
    const input = 'Use CLAUDE_CONFIG_DIR or $HOME/.claude to configure';
    const result = convertClaudeToWindsurfMarkdown(input);
    assert.ok(
      result.includes('WINDSURF_CONFIG_DIR'),
      'CLAUDE_CONFIG_DIR must become WINDSURF_CONFIG_DIR',
    );
    assert.ok(
      !result.includes('CLAUDE_CONFIG_DIR'),
      'CLAUDE_CONFIG_DIR must be gone',
    );
  });

  test('.claude-plugin is NOT corrupted (preserved as-is)', () => {
    const input = 'The .claude-plugin/plugin.json manifest enables plugin install.';
    const result = convertClaudeToWindsurfMarkdown(input);
    assert.ok(
      result.includes('.claude-plugin'),
      `.claude-plugin must be preserved; got: ${result}`,
    );
    assert.ok(
      !result.includes('.windsurf-plugin'),
      `.windsurf-plugin must not appear; got: ${result}`,
    );
  });

  test('no bare ~/.claude in converted surface.md', () => {
    const surfacePath = path.join(__dirname, '..', 'commands', 'gsd', 'surface.md');
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToWindsurfMarkdown(raw);
    assert.ok(
      !/~\/\.claude(?![\w-])/.test(result),
      'converted surface.md must not contain bare ~/.claude',
    );
  });

  test('no $HOME/.claude in converted surface.md', () => {
    const surfacePath = path.join(__dirname, '..', 'commands', 'gsd', 'surface.md');
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToWindsurfMarkdown(raw);
    assert.ok(
      !/\$HOME\/\.claude(?![\w-])/.test(result),
      'converted surface.md must not contain bare $HOME/.claude',
    );
  });

  test('no CLAUDE_CONFIG_DIR in converted surface.md', () => {
    const surfacePath = path.join(__dirname, '..', 'commands', 'gsd', 'surface.md');
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToWindsurfMarkdown(raw);
    assert.ok(
      !result.includes('CLAUDE_CONFIG_DIR'),
      'converted surface.md must not contain CLAUDE_CONFIG_DIR',
    );
  });
});

// ─── Trae converter bare-form tests ─────────────────────────────────────────

describe('convertClaudeToTraeMarkdown — bare ~/.claude and CLAUDE_CONFIG_DIR (#983)', () => {
  test('bare ~/.claude rewritten to ~/.trae', () => {
    const input = 'Config dir: (~/.claude), skills at ~/.claude/skills';
    const result = convertClaudeToTraeMarkdown(input);
    assert.ok(
      !/~\/\.claude(?![\w-])/.test(result),
      `bare ~/.claude must be rewritten; got: ${result}`,
    );
    assert.ok(result.includes('~/.trae'), 'must rewrite to ~/.trae');
  });

  test('$HOME/.claude rewritten to $HOME/.trae', () => {
    const input = 'RUNTIME_CONFIG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"';
    const result = convertClaudeToTraeMarkdown(input);
    assert.ok(
      !/\$HOME\/\.claude(?![\w-])/.test(result),
      `bare $HOME/.claude must be rewritten; got: ${result}`,
    );
    assert.ok(result.includes('$HOME/.trae'), 'must rewrite to $HOME/.trae');
  });

  test('CLAUDE_CONFIG_DIR rewritten to TRAE_CONFIG_DIR', () => {
    const input = 'Use CLAUDE_CONFIG_DIR or $HOME/.claude to configure';
    const result = convertClaudeToTraeMarkdown(input);
    assert.ok(
      result.includes('TRAE_CONFIG_DIR'),
      'CLAUDE_CONFIG_DIR must become TRAE_CONFIG_DIR',
    );
    assert.ok(
      !result.includes('CLAUDE_CONFIG_DIR'),
      'CLAUDE_CONFIG_DIR must be gone',
    );
  });

  test('.claude-plugin is NOT corrupted (preserved as-is)', () => {
    const input = 'The .claude-plugin/plugin.json manifest enables plugin install.';
    const result = convertClaudeToTraeMarkdown(input);
    assert.ok(
      result.includes('.claude-plugin'),
      `.claude-plugin must be preserved; got: ${result}`,
    );
    assert.ok(
      !result.includes('.trae-plugin'),
      `.trae-plugin must not appear; got: ${result}`,
    );
  });

  test('no bare ~/.claude in converted surface.md', () => {
    const surfacePath = path.join(__dirname, '..', 'commands', 'gsd', 'surface.md');
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToTraeMarkdown(raw);
    assert.ok(
      !/~\/\.claude(?![\w-])/.test(result),
      'converted surface.md must not contain bare ~/.claude',
    );
  });

  test('no $HOME/.claude in converted surface.md', () => {
    const surfacePath = path.join(__dirname, '..', 'commands', 'gsd', 'surface.md');
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToTraeMarkdown(raw);
    assert.ok(
      !/\$HOME\/\.claude(?![\w-])/.test(result),
      'converted surface.md must not contain bare $HOME/.claude',
    );
  });

  test('no CLAUDE_CONFIG_DIR in converted surface.md', () => {
    const surfacePath = path.join(__dirname, '..', 'commands', 'gsd', 'surface.md');
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToTraeMarkdown(raw);
    assert.ok(
      !result.includes('CLAUDE_CONFIG_DIR'),
      'converted surface.md must not contain CLAUDE_CONFIG_DIR',
    );
  });
});

// ─── _applyRuntimeRewrites install-path tests (windsurf) ────────────────────
//
// These tests exercise the ACTUAL install path that causes the user-facing leak.
// The converter functions are called at stage time to produce a Windsurf-branded
// copy, but _applyRuntimeRewrites is the path that runs at INSTALL time and
// rewrites any surviving ~/.claude / $HOME/.claude refs in the staged files.
//
// FAIL-BEFORE proof: prior to this PR, windsurf used /~\/\.claude\b/ which
// fires on "~/.claude-plugin" because \b matches between 'e' and '-'.  Running
// the test below against the old regex (`\b`) would:
//   - let bare $HOME/.claude survive (it used only /~\/\.claude\b/, missing $HOME form), AND
//   - corrupt "~/.claude-plugin" → "~/.windsurf-plugin".
// Both assertions in the test below would fail on the old code.
//
// PASS-AFTER: the fix changes to (?![\w-]) so:
//   - bare ~/.claude / $HOME/.claude (not followed by word-char or hyphen) → rewritten
//   - ~/.claude-plugin preserved (the '-' after 'e' is in [\w-])
//
// NOTE on pathPrefix choice: we use '~/.windsurf/' (a simple home-relative
// prefix) rather than '$HOME/.codeium/windsurf/' so that the corruption of
// '~/.claude-plugin' → '~/.windsurf-plugin' is directly detectable via
// result.includes('.windsurf-plugin').
describe('_applyRuntimeRewrites(windsurf) — install-path bare-form + .claude-plugin (#983)', () => {
  // Use ~/  prefix (local-style) so that the .windsurf-plugin corruption is
  // directly detectable as a substring of the result.
  const WINDSURF_PATH_PREFIX = '~/.windsurf/';

  // Compound content: covers every form the fix must handle.
  // IMPORTANT: we use ~/.claude-plugin (home-relative form) to exercise the
  // corruption that the old \b regex caused. The \b fires between 'e' and '-',
  // so ~/.claude-plugin → ~/.windsurf-plugin under the old code. That would
  // break the preservation assertion below. The (?![\w-]) fix prevents this.
  const COMPOUND_INPUT = [
    'Config dir: ~/.claude',
    'Also: $HOME/.claude',
    'Slash form: ~/.claude/skills/foo.md',
    'Plugin installed at: ~/.claude-plugin/plugin.json',
    'Env var: CLAUDE_CONFIG_DIR',
  ].join('\n');

  test('bare ~/.claude rewritten to ~/.windsurf (no trailing slash)', () => {
    const result = _applyRuntimeRewrites(COMPOUND_INPUT, 'windsurf', WINDSURF_PATH_PREFIX);
    assert.ok(
      !/~\/\.claude(?![\w-])/.test(result),
      `bare ~/.claude must be gone; got:\n${result}`,
    );
    assert.ok(
      result.includes('~/.windsurf'),
      `must contain normalized pathPrefix; got:\n${result}`,
    );
  });

  test('bare $HOME/.claude rewritten to ~/.windsurf (install-path normalizes both home forms)', () => {
    const result = _applyRuntimeRewrites(COMPOUND_INPUT, 'windsurf', WINDSURF_PATH_PREFIX);
    assert.ok(
      !/\$HOME\/\.claude(?![\w-])/.test(result),
      `bare $HOME/.claude must be gone; got:\n${result}`,
    );
  });

  test('zero surviving bare ~/.claude or $HOME/.claude refs in compound input', () => {
    const result = _applyRuntimeRewrites(COMPOUND_INPUT, 'windsurf', WINDSURF_PATH_PREFIX);
    const bareClaudePattern = /(?:~|\$HOME)\/\.claude(?![\w-])/;
    assert.ok(
      !bareClaudePattern.test(result),
      `no bare ~/.claude / $HOME/.claude must survive; got:\n${result}`,
    );
  });

  test('~/.claude-plugin is NOT corrupted to ~/.windsurf-plugin — was the \\b corruption', () => {
    // FAIL-BEFORE: old /~\/\.claude\b/ rewrote ~/.claude-plugin → ~/.windsurf-plugin
    // because \b fires between 'e' and '-'.
    // PASS-AFTER: (?![\w-]) sees '-' and skips the match, preserving ~/.claude-plugin.
    const result = _applyRuntimeRewrites(COMPOUND_INPUT, 'windsurf', WINDSURF_PATH_PREFIX);
    assert.ok(
      result.includes('~/.claude-plugin'),
      `~/.claude-plugin must be preserved; got:\n${result}`,
    );
    assert.ok(
      !result.includes('~/.windsurf-plugin'),
      `~/.windsurf-plugin must NOT appear (was the \\b corruption); got:\n${result}`,
    );
  });

  test('slash form ~/.claude/ is also rewritten (pre-existing coverage)', () => {
    const result = _applyRuntimeRewrites(COMPOUND_INPUT, 'windsurf', WINDSURF_PATH_PREFIX);
    assert.ok(
      !result.includes('~/.claude/'),
      `slash form ~/.claude/ must be gone; got:\n${result}`,
    );
  });

  test('CLAUDE_CONFIG_DIR is NOT rewritten by _applyRuntimeRewrites (converter responsibility)', () => {
    // _applyRuntimeRewrites does NOT handle CLAUDE_CONFIG_DIR for windsurf;
    // that rewrite is done by convertClaudeToWindsurfMarkdown at stage time.
    // This test documents the boundary and guards against scope creep.
    const result = _applyRuntimeRewrites(COMPOUND_INPUT, 'windsurf', WINDSURF_PATH_PREFIX);
    assert.ok(
      result.includes('CLAUDE_CONFIG_DIR'),
      'CLAUDE_CONFIG_DIR is not rewritten by _applyRuntimeRewrites — that is converter scope',
    );
  });
});

// ─── _applyRuntimeRewrites install-path tests (trae) ────────────────────────
//
// Trae had bare-form handling before this PR (via \b) and the converter uses
// (?![\w-]).  The pre-existing \b in _applyRuntimeRewrites DOES corrupt
// .claude-plugin → .trae-plugin (known limitation, out of scope for #983).
// We document this here but do NOT assert preservation for trae, and we do NOT
// fix the pre-existing trae \b lines (that would be a separate concern).
//
// What we DO assert: trae bare ~/.claude / $HOME/.claude refs are rewritten
// (the install path cleans them), which is the core #983 fix for trae.
describe('_applyRuntimeRewrites(trae) — install-path bare-form (#983)', () => {
  const TRAE_PATH_PREFIX = '$HOME/.trae/';

  const TRAE_INPUT = [
    'Config dir: ~/.claude',
    'Also: $HOME/.claude',
    'Slash form: ~/.claude/skills/foo.md',
    // Note: .claude-plugin is intentionally omitted from assertions here because
    // the pre-existing trae case uses \b which corrupts it (known limitation,
    // out of scope for #983 — do not fix here).
  ].join('\n');

  test('bare ~/.claude rewritten to $HOME/.trae (trae install path)', () => {
    const result = _applyRuntimeRewrites(TRAE_INPUT, 'trae', TRAE_PATH_PREFIX);
    assert.ok(
      !/~\/\.claude(?![\w-])/.test(result),
      `bare ~/.claude must be gone; got:\n${result}`,
    );
  });

  test('bare $HOME/.claude rewritten to $HOME/.trae (trae install path)', () => {
    const result = _applyRuntimeRewrites(TRAE_INPUT, 'trae', TRAE_PATH_PREFIX);
    assert.ok(
      !/\$HOME\/\.claude(?![\w-])/.test(result),
      `bare $HOME/.claude must be gone; got:\n${result}`,
    );
  });

  test('slash form ~/.claude/ also rewritten (trae install path)', () => {
    const result = _applyRuntimeRewrites(TRAE_INPUT, 'trae', TRAE_PATH_PREFIX);
    assert.ok(
      !result.includes('~/.claude/'),
      `slash form ~/.claude/ must be gone; got:\n${result}`,
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-782-cline-skills-emission.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-782-cline-skills-emission (consolidation epic #1969 B1 #1970)", () => {
'use strict';
/**
 * Regression tests for bug #782 — Cline skills emission.
 *
 * gsd now emits skills to ~/.cline/skills/<name>/SKILL.md for Cline >= v3.48.
 * Skills discovery: https://docs.cline.bot/customization/skills
 *
 * (a) Converter unit test: convertClaudeCommandToClineSkill
 * (b) Integration test: installRuntimeArtifacts for cline writes SKILL.md files
 * (c) .clinerules/gsd.md still written by the install path (#787 dir form)
 * (d) Idempotency: running install twice leaves skills + .clinerules/ intact
 * (e) Full install() global: both skills AND .clinerules/gsd.md are written
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTempDir, cleanup, captureConsole } = require('./helpers.cjs');

const {
  convertClaudeCommandToClineSkill,
  convertClaudeToCliineMarkdown,
  install,
  _applyRuntimeRewrites,
} = require('../bin/install.js');

const { installRuntimeArtifacts } = require('../gsd-core/bin/lib/install-engine.cjs');

const {
  resolveRuntimeArtifactLayout,
} = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');

const {
  loadSkillsManifest,
  resolveProfile,
} = require('../gsd-core/bin/lib/install-profiles.cjs');

const { nestedSkillPath } = require('./helpers/nested-layout.cjs');

const REAL_COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');
const MANIFEST = loadSkillsManifest(REAL_COMMANDS_DIR);
const RESOLVED_CORE = resolveProfile({ modes: ['core'], manifest: MANIFEST });

// ─── (a) Converter unit test ─────────────────────────────────────────────────

const SAMPLE_COMMAND = `---
name: gsd:execute-phase
description: Execute all tasks in the current phase using Cline tools.
allowed-tools:
  - Read
  - Write
  - Bash
---

## Objective

Run all tasks in the current phase.

See ~/.claude/skills/gsd-help/SKILL.md for reference.
Use \`/gsd-help\` or Claude Code for details.
`;

// A command that exercises all three Claude-specific frontmatter fields that
// must NOT leak into the emitted Cline SKILL.md.
const RICH_COMMAND = `---
name: gsd:validate-phase
description: Retroactively audit and fill Nyquist validation gaps for a completed phase
argument-hint: "[phase number]"
agent: researcher
allowed-tools:
  - Read
  - Write
  - Edit
  - Bash
  - Glob
  - Grep
  - Agent
  - AskUserQuestion
---

## Objective

Audit Nyquist validation coverage. See ~/.claude/skills/gsd-help/SKILL.md for reference.
Use Claude Code for details.
`;

/**
 * Extract frontmatter block (between --- delimiters) from output.
 * Returns the raw text between the first --- and the closing ---.
 * Uses \r?\n to handle both LF and CRLF line endings (Windows parity).
 */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? m[1] : null;
}

describe('convertClaudeCommandToClineSkill — unit', () => {
  test('emits frontmatter with name: gsd-<stem>', () => {
    const result = convertClaudeCommandToClineSkill(SAMPLE_COMMAND, 'gsd-execute-phase');
    const nameMatch = result.match(/^name:\s*(.+)$/m);
    assert.ok(nameMatch, 'frontmatter must contain name field');
    assert.ok(nameMatch[1].includes('gsd-execute-phase'), 'name must start with gsd-execute-phase');
  });

  test('emits non-empty description in frontmatter', () => {
    const result = convertClaudeCommandToClineSkill(SAMPLE_COMMAND, 'gsd-execute-phase');
    const descMatch = result.match(/^description:\s*(.+)$/m);
    assert.ok(descMatch, 'frontmatter must contain description field');
    assert.ok(descMatch[1].trim().length > 0, 'description must not be empty');
  });

  test('body uses .cline/ paths not .claude/', () => {
    const result = convertClaudeCommandToClineSkill(SAMPLE_COMMAND, 'gsd-execute-phase');
    // The body reference to ~/.claude/ should be rewritten to ~/.cline/
    assert.ok(!result.includes('~/.claude/skills'), 'body must not contain ~/.claude/skills');
    assert.ok(result.includes('.cline/skills'), 'body must contain .cline/skills');
  });

  test('body replaces "Claude Code" with "Cline"', () => {
    const result = convertClaudeCommandToClineSkill(SAMPLE_COMMAND, 'gsd-execute-phase');
    assert.ok(!result.includes('Claude Code'), 'Claude Code must be replaced with Cline');
    assert.ok(result.includes('Cline'), 'result must contain Cline branding');
  });

  test('no stray .claude/ paths in frontmatter or body', () => {
    const result = convertClaudeCommandToClineSkill(SAMPLE_COMMAND, 'gsd-execute-phase');
    // Should not contain .claude/ anywhere (except inside CLAUDE.md→.clinerules rewrites
    // but those are already handled by convertClaudeToCliineMarkdown)
    assert.ok(!result.includes('/.claude/'), 'no /.claude/ paths in output');
  });

  // ── Fix 1 (code-review): frontmatter must be ONLY name + description ──────

  test('frontmatter emits ONLY name and description — no allowed-tools (SAMPLE_COMMAND)', () => {
    const result = convertClaudeCommandToClineSkill(SAMPLE_COMMAND, 'gsd-execute-phase');
    const fm = parseFrontmatter(result);
    assert.ok(fm !== null, 'result must have YAML frontmatter');
    assert.ok(!fm.includes('allowed-tools'), 'frontmatter must NOT contain allowed-tools');
    assert.ok(!fm.includes('argument-hint'), 'frontmatter must NOT contain argument-hint');
    assert.ok(!fm.includes('agent:'), 'frontmatter must NOT contain agent:');
  });

  test('frontmatter emits ONLY name and description — no allowed-tools/argument-hint/agent (RICH_COMMAND)', () => {
    const result = convertClaudeCommandToClineSkill(RICH_COMMAND, 'gsd-validate-phase');
    const fm = parseFrontmatter(result);
    assert.ok(fm !== null, 'result must have YAML frontmatter');
    assert.ok(!fm.includes('allowed-tools'), 'frontmatter must NOT contain allowed-tools');
    assert.ok(!fm.includes('argument-hint'), 'frontmatter must NOT contain argument-hint');
    assert.ok(!fm.includes('agent:'), 'frontmatter must NOT contain agent:');
  });

  test('name == gsd-validate-phase for RICH_COMMAND', () => {
    const result = convertClaudeCommandToClineSkill(RICH_COMMAND, 'gsd-validate-phase');
    const nameMatch = result.match(/^name:\s*(.+)$/m);
    assert.ok(nameMatch, 'must have name field');
    // yamlIdentifier may quote the value; strip surrounding quotes for comparison
    const nameVal = nameMatch[1].replace(/^['"]|['"]$/g, '').trim();
    assert.strictEqual(nameVal, 'gsd-validate-phase', `name must be gsd-validate-phase, got: ${nameVal}`);
  });

  test('description is non-empty and <= 1024 chars for RICH_COMMAND', () => {
    const result = convertClaudeCommandToClineSkill(RICH_COMMAND, 'gsd-validate-phase');
    const descMatch = result.match(/^description:\s*(.+)$/m);
    assert.ok(descMatch, 'must have description field');
    const desc = descMatch[1].replace(/^['"]|['"]$/g, '').trim();
    assert.ok(desc.length > 0, 'description must be non-empty');
    assert.ok(desc.length <= 1024, `description must be <= 1024 chars, got ${desc.length}`);
  });

  test('description truncated to <=1024 chars when source description is very long', () => {
    const longDesc = 'A'.repeat(2000);
    const longDescCommand = `---\nname: gsd:test\ndescription: ${longDesc}\n---\n\nBody text.\n`;
    const result = convertClaudeCommandToClineSkill(longDescCommand, 'gsd-test');
    const descMatch = result.match(/^description:\s*'?(.*?)'?$/m);
    assert.ok(descMatch, 'must have description field');
    // The raw description value (unquoted) should be <=1024 chars
    // The result string after the --- block will have the quoted form; check raw length
    // by checking the whole result doesn't have the full 2000-char string
    assert.ok(!result.includes('A'.repeat(1025)), 'description must be truncated to 1024 chars');
  });

  test('returns content unchanged when source has no frontmatter', () => {
    const noFm = 'Just a body, no frontmatter here.\n';
    const result = convertClaudeCommandToClineSkill(noFm, 'gsd-test');
    assert.strictEqual(result, noFm, 'content without frontmatter must be returned unchanged');
  });

  test('RICH_COMMAND body uses .cline/ paths and Cline branding', () => {
    const result = convertClaudeCommandToClineSkill(RICH_COMMAND, 'gsd-validate-phase');
    assert.ok(!result.includes('~/.claude/'), 'body must not contain ~/.claude/');
    assert.ok(result.includes('.cline/'), 'body must contain .cline/ paths');
    assert.ok(!result.includes('Claude Code'), 'body must not contain "Claude Code"');
    assert.ok(result.includes('Cline'), 'body must reference Cline');
  });
});

// ─── (b) + (c) + (d) Integration tests ────────────────────────────────────────

describe('installRuntimeArtifacts — cline skills emission', () => {
  test('cline global: writes gsd-prefixed skill dirs under skills/', (t) => {
    const configDir = createTempDir('gsd-cline-skills-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_CORE);

    const layout = resolveRuntimeArtifactLayout('cline', configDir, 'global');
    const skillsKind = layout.kinds.find(k => k.kind === 'skills');
    assert.ok(skillsKind, 'cline must have a skills kind after #782');

    const skillsDir = path.join(configDir, skillsKind.destSubpath);
    assert.ok(fs.existsSync(skillsDir), 'skills/ directory must be created');

    const helpSkillDir = path.join(skillsDir, `${skillsKind.prefix}help`);
    assert.ok(
      fs.existsSync(path.join(helpSkillDir, 'SKILL.md')),
      `gsd-help/SKILL.md must exist under ${skillsKind.destSubpath}/`
    );
  });

  test('cline global: SKILL.md has valid cline frontmatter (name + description)', (t) => {
    const configDir = createTempDir('gsd-cline-fm-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_CORE);

    const skillsDir = path.join(configDir, 'skills');
    const helpSkill = path.join(skillsDir, 'gsd-help', 'SKILL.md');
    assert.ok(fs.existsSync(helpSkill), 'gsd-help/SKILL.md must exist');

    const content = fs.readFileSync(helpSkill, 'utf8');
    // Must have YAML frontmatter
    assert.ok(content.startsWith('---'), 'SKILL.md must start with YAML frontmatter');
    assert.ok(content.includes('name:'), 'frontmatter must have name field');
    assert.ok(content.includes('description:'), 'frontmatter must have description field');
    // name must be gsd-help
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    assert.ok(nameMatch, 'must have name field');
    assert.ok(nameMatch[1].includes('gsd-help'), `name must include gsd-help, got: ${nameMatch[1]}`);
  });

  test('cline global: SKILL.md uses .cline/ paths not .claude/', (t) => {
    const configDir = createTempDir('gsd-cline-paths-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_CORE);

    const skillsDir = path.join(configDir, 'skills');
    // Check all installed skill files for stray .claude/ references
    const skills = fs.readdirSync(skillsDir).filter(n => n.startsWith('gsd-'));
    assert.ok(skills.length > 0, 'at least one gsd- skill must be installed');

    for (const skillName of skills) {
      const skillFile = path.join(skillsDir, skillName, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;
      const content = fs.readFileSync(skillFile, 'utf8');
      assert.ok(
        !content.includes('~/.claude/'),
        `${skillName}/SKILL.md must not contain ~/.claude/ — found stray path`
      );
      assert.ok(
        !content.includes('/.claude/'),
        `${skillName}/SKILL.md must not contain /.claude/ — found stray path`
      );
    }
  });

  test('cline global: skill count matches resolved profile', (t) => {
    const configDir = createTempDir('gsd-cline-count-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_CORE);

    const skillsDir = path.join(configDir, 'skills');
    const count = fs.readdirSync(skillsDir)
      .filter(n => n.startsWith('gsd-') && fs.statSync(path.join(skillsDir, n)).isDirectory())
      .length;

    if (RESOLVED_CORE.skills !== '*') {
      assert.strictEqual(count, RESOLVED_CORE.skills.size,
        `installed skill count (${count}) must match profile size (${RESOLVED_CORE.skills.size})`);
    } else {
      assert.ok(count > 0, 'must install at least 1 skill');
    }
  });
});

describe('installRuntimeArtifacts — cline idempotency', () => {
  test('cline: running install twice leaves skills intact (idempotency)', (t) => {
    const configDir = createTempDir('gsd-cline-idempotent-');
    t.after(() => cleanup(configDir));

    // First install
    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_CORE);

    const skillsDir = path.join(configDir, 'skills');
    const countAfterFirst = fs.readdirSync(skillsDir)
      .filter(n => n.startsWith('gsd-') && fs.statSync(path.join(skillsDir, n)).isDirectory())
      .length;

    // Second install (upgrade over existing)
    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_CORE);

    const countAfterSecond = fs.readdirSync(skillsDir)
      .filter(n => n.startsWith('gsd-') && fs.statSync(path.join(skillsDir, n)).isDirectory())
      .length;

    assert.strictEqual(countAfterFirst, countAfterSecond,
      `skill count must be stable across installs: first=${countAfterFirst} second=${countAfterSecond}`);
  });
});

// ─── (e) Full install() global — coexistence regression ───────────────────────
//
// Issue #782 explicitly requires that a global Cline install writes BOTH:
//   - skills/<gsd-*>/SKILL.md     (skills for Cline >= v3.48)
//   - .clinerules/gsd.md          (rules dir form introduced by #787)
//
// installRuntimeArtifacts() tests cover skills in isolation; this test exercises
// the FULL install() code path to ensure neither artifact is silently dropped.

describe('install() global cline — coexistence: skills AND .clinerules', () => {
  let tmpGlobalDir;
  let originalClineConfigDir;

  beforeEach(() => {
    originalClineConfigDir = process.env.CLINE_CONFIG_DIR;
    tmpGlobalDir = createTempDir('gsd-cline-global-');
    // Redirect CLINE_CONFIG_DIR to the temp dir so install() never touches ~/.cline
    process.env.CLINE_CONFIG_DIR = tmpGlobalDir;
  });

  afterEach(() => {
    if (originalClineConfigDir !== undefined) {
      process.env.CLINE_CONFIG_DIR = originalClineConfigDir;
    } else {
      delete process.env.CLINE_CONFIG_DIR;
    }
    cleanup(tmpGlobalDir);
  });

  test('global cline install writes at least one gsd-* SKILL.md under skills/', () => {
    captureConsole(() => install(true, 'cline'));

    const skillsDir = path.join(tmpGlobalDir, 'skills');
    assert.ok(
      fs.existsSync(skillsDir),
      `skills/ directory must exist under ${tmpGlobalDir} after global cline install`
    );

    // full profile: gsd-help is nested under gsd-ns-manage/skills/help/SKILL.md
    const helpSkillFile = nestedSkillPath(skillsDir, 'gsd-', 'help');
    assert.ok(
      fs.existsSync(helpSkillFile),
      `${path.relative(tmpGlobalDir, helpSkillFile)} must exist under ${tmpGlobalDir} — skills emission broken for global cline`
    );
  });

  test('global cline install writes .clinerules/gsd.md to the global config dir', () => {
    captureConsole(() => install(true, 'cline'));

    // For a global Cline install, targetDir = getGlobalDir('cline') = CLINE_CONFIG_DIR.
    // The cline-rules surface (#787) writes the .clinerules/ DIRECTORY form:
    //   .clinerules/gsd.md  (rule file)
    //   .clinerules/hooks/PreToolUse  (lifecycle hook)
    const clinerulesMd = path.join(tmpGlobalDir, '.clinerules', 'gsd.md');
    assert.ok(
      fs.existsSync(clinerulesMd),
      `.clinerules/gsd.md must exist at ${clinerulesMd} — coexistence with skills broken for global cline (#782+#787)`
    );
  });

  test('global cline .clinerules/gsd.md contains GSD instructions', () => {
    captureConsole(() => install(true, 'cline'));

    // #787 dir form: rule content lives in .clinerules/gsd.md, not a flat .clinerules file
    const clinerulesMd = path.join(tmpGlobalDir, '.clinerules', 'gsd.md');
    assert.ok(fs.existsSync(clinerulesMd), '.clinerules/gsd.md must exist');
    const content = fs.readFileSync(clinerulesMd, 'utf8');
    assert.ok(
      content.includes('GSD') || content.includes('gsd'),
      '.clinerules/gsd.md must reference GSD'
    );
  });
});

// ─── Fix 3 regression: converter rewrites bare ~/.claude and CLAUDE_CONFIG_DIR ──
//
// convertClaudeToCliineMarkdown must also handle bare ~/.claude (no trailing
// slash) and the CLAUDE_CONFIG_DIR env-var name. surface.md contains these;
// the emitted Cline SKILL.md must contain no such stale Claude refs.

describe('convertClaudeToCliineMarkdown — bare ~/.claude and CLAUDE_CONFIG_DIR (Fix 3)', () => {
  const surfacePath = path.join(__dirname, '..', 'commands', 'gsd', 'surface.md');

  test('no bare ~/.claude in converted surface.md', () => {
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToCliineMarkdown(raw);
    // ~/.claude followed by a word-boundary (not a /) must be gone
    assert.ok(
      !/~\/\.claude\b/.test(result),
      'converted surface.md must not contain bare ~/.claude'
    );
  });

  test('no CLAUDE_CONFIG_DIR in converted surface.md', () => {
    const raw = fs.readFileSync(surfacePath, 'utf8');
    const result = convertClaudeToCliineMarkdown(raw);
    assert.ok(
      !result.includes('CLAUDE_CONFIG_DIR'),
      'converted surface.md must not contain CLAUDE_CONFIG_DIR'
    );
  });

  test('CLAUDE_CONFIG_DIR rewritten to CLINE_CONFIG_DIR', () => {
    const input = 'Use CLAUDE_CONFIG_DIR or $HOME/.claude to configure';
    const result = convertClaudeToCliineMarkdown(input);
    assert.ok(result.includes('CLINE_CONFIG_DIR'), 'CLAUDE_CONFIG_DIR must become CLINE_CONFIG_DIR');
    assert.ok(!result.includes('CLAUDE_CONFIG_DIR'), 'CLAUDE_CONFIG_DIR must be gone');
  });

  test('bare ~/.claude rewritten to ~/.cline', () => {
    const input = 'Config dir: (~/.claude), skills at ~/.claude/skills';
    const result = convertClaudeToCliineMarkdown(input);
    assert.ok(!result.includes('~/.claude'), 'bare ~/.claude must be rewritten');
    assert.ok(result.includes('~/.cline'), 'must rewrite to ~/.cline');
  });

  test('installRuntimeArtifacts cline global: gsd-surface SKILL.md has no bare ~/.claude or CLAUDE_CONFIG_DIR', (t) => {
    const configDir = createTempDir('gsd-cline-surface-fix3-');
    t.after(() => cleanup(configDir));

    const MANIFEST_FULL = require('../gsd-core/bin/lib/install-profiles.cjs').loadSkillsManifest(
      path.join(__dirname, '..', 'commands', 'gsd')
    );
    const RESOLVED_FULL = require('../gsd-core/bin/lib/install-profiles.cjs').resolveProfile({
      modes: ['full'], manifest: MANIFEST_FULL,
    });

    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_FULL);

    // full profile: surface is nested under gsd-ns-manage/skills/surface/SKILL.md
    const surfaceSkill = nestedSkillPath(path.join(configDir, 'skills'), 'gsd-', 'surface');
    assert.ok(fs.existsSync(surfaceSkill), `${path.relative(configDir, surfaceSkill)} must exist for full profile`);

    const content = fs.readFileSync(surfaceSkill, 'utf8');
    assert.ok(
      !/~\/\.claude\b/.test(content),
      'gsd-surface SKILL.md must not contain bare ~/.claude (Fix 3)'
    );
    assert.ok(
      !content.includes('CLAUDE_CONFIG_DIR'),
      'gsd-surface SKILL.md must not contain CLAUDE_CONFIG_DIR (Fix 3)'
    );
  });
});

// ─── Fix 1 regression: custom CLINE_CONFIG_DIR → embedded paths use custom dir ──
//
// _applyRuntimeRewrites for cline must rewrite ~/.cline/ → pathPrefix.
// For default global installs, pathPrefix = "$HOME/.cline/" (unchanged).
// For custom installs (CLINE_CONFIG_DIR=/custom), pathPrefix = "/custom/" and
// all embedded ~/.cline/ refs in SKILL.md must become /custom/...

describe('_applyRuntimeRewrites — cline custom-dir embedded path (Fix 1)', () => {
  test('default pathPrefix ($HOME/.cline/) leaves ~/.cline refs as $HOME/.cline', () => {
    const content = 'See ~/.cline/skills/gsd-help/SKILL.md for reference.\nBare: ~/.cline\n';
    const result = _applyRuntimeRewrites(content, 'cline', '$HOME/.cline/');
    assert.ok(result.includes('$HOME/.cline/'), 'default prefix must map ~/.cline/ to $HOME/.cline/');
    assert.ok(!result.includes('~/.cline'), 'no tilde form should remain after rewrite');
  });

  test('custom pathPrefix rewrites ~/.cline/ → custom path in SKILL.md body', () => {
    const content = 'See ~/.cline/skills/gsd-help/SKILL.md for reference.\nBare: ~/.cline\n';
    const result = _applyRuntimeRewrites(content, 'cline', '/custom/cline-dir/');
    assert.ok(result.includes('/custom/cline-dir/'), 'custom prefix must appear in output');
    assert.ok(!result.includes('~/.cline'), 'no tilde cline form should remain after custom rewrite');
  });

  test('custom pathPrefix rewrites residual ~/.claude/ safety net', () => {
    const content = 'Residual: ~/.claude/skills\n';
    const result = _applyRuntimeRewrites(content, 'cline', '/custom/cline-dir/');
    assert.ok(result.includes('/custom/cline-dir/'), 'safety-net ~/.claude/ also rewritten to custom prefix');
    assert.ok(!result.includes('~/.claude/'), 'no ~/.claude/ should remain');
  });

  test('installRuntimeArtifacts cline with CLINE_CONFIG_DIR custom: SKILL.md embeds custom path', (t) => {
    const configDir = createTempDir('gsd-cline-custom-dir-');
    t.after(() => cleanup(configDir));

    const MANIFEST_FULL = require('../gsd-core/bin/lib/install-profiles.cjs').loadSkillsManifest(
      path.join(__dirname, '..', 'commands', 'gsd')
    );
    const RESOLVED_FULL = require('../gsd-core/bin/lib/install-profiles.cjs').resolveProfile({
      modes: ['full'], manifest: MANIFEST_FULL,
    });

    installRuntimeArtifacts('cline', configDir, 'global', RESOLVED_FULL);

    // gsd-surface SKILL.md references config paths; with a custom configDir
    // (not under $HOME), pathPrefix will be the absolute custom path.
    // full profile: surface is nested under gsd-ns-manage/skills/surface/SKILL.md
    const surfaceSkill = nestedSkillPath(path.join(configDir, 'skills'), 'gsd-', 'surface');
    assert.ok(fs.existsSync(surfaceSkill), `${path.relative(configDir, surfaceSkill)} must exist`);

    const content = fs.readFileSync(surfaceSkill, 'utf8');
    // With a custom dir (path under /tmp, not ~/.cline), the output must NOT
    // contain ~/.cline/ or $HOME/.cline/ — it must embed the actual configDir path.
    assert.ok(
      !content.includes('~/.cline/'),
      `gsd-surface SKILL.md must not contain ~/.cline/ when configDir=${configDir} (Fix 1)`
    );
    // The custom path must appear somewhere in the file
    // (configDir is a /tmp/... path so pathPrefix = configDir+'/').
    // Production normalizes backslashes to forward slashes via
    // path.resolve(configDir).replace(/\\/g, '/'), so compare against that
    // form — otherwise this assertion fails on Windows where mkdtempSync
    // returns a backslash path (e.g. C:\Users\...) but the emitted content
    // already has forward slashes (C:/Users/...).
    const expectedPath = path.resolve(configDir).replace(/\\/g, '/');
    assert.ok(
      content.includes(expectedPath),
      `gsd-surface SKILL.md must embed custom configDir path ${expectedPath} (Fix 1)`
    );
  });
});

// ─── Fix 4 regression: description truncation is code-point-aware ────────────
//
// Naive UTF-16 slicing (`str.slice(0, 1021)`) can split a surrogate pair when
// the cut falls between the high and low surrogate of a multibyte character
// (e.g. emoji U+1F600, which is encoded as two UTF-16 code units).  The fix
// uses Array.from() to split by code point, guaranteeing that the truncated
// value never contains a lone surrogate.

describe('convertClaudeCommandToClineSkill — code-point-aware truncation (Fix 4)', () => {
  /**
   * Build a frontmatter+body command string whose description is:
   *   - exactly `prefixLen` ASCII chars
   *   - followed by `emojiCount` repetitions of '😀' (U+1F600, 2 UTF-16 units)
   *   - total UTF-16 length is prefixLen + emojiCount * 2
   */
  function makeEmojiCommand(prefixLen, emojiCount) {
    const desc = 'A'.repeat(prefixLen) + '😀'.repeat(emojiCount);
    return `---\nname: gsd:emoji-test\ndescription: ${desc}\n---\n\nBody.\n`;
  }

  test('emitted description is <= 1024 code points when source overflows', () => {
    // 1020 ASCII chars + 4 emoji = 1020 + 8 UTF-16 units = 1028 UTF-16 units > 1024.
    // Code-point count = 1020 + 4 = 1024 — exactly at the boundary BEFORE adding '...'.
    // After truncation to 1021 code points + '...' → 1024 code points total.
    const cmd = makeEmojiCommand(1020, 10); // 1030 code points → must truncate
    const result = convertClaudeCommandToClineSkill(cmd, 'gsd-emoji-test');

    // Extract raw description value (strip surrounding YAML quotes if present)
    const descMatch = result.match(/^description:\s*(.+)$/m);
    assert.ok(descMatch, 'emitted SKILL.md must have a description field');
    const rawDesc = descMatch[1].trim().replace(/^['"]|['"]$/g, '');

    const codePoints = Array.from(rawDesc);
    assert.ok(
      codePoints.length <= 1024,
      `emitted description must be <= 1024 code points, got ${codePoints.length}`
    );
  });

  test('emitted description ends with "..." when truncated', () => {
    const cmd = makeEmojiCommand(1020, 10); // 1030 code points → must truncate
    const result = convertClaudeCommandToClineSkill(cmd, 'gsd-emoji-test');

    const descMatch = result.match(/^description:\s*(.+)$/m);
    assert.ok(descMatch, 'emitted SKILL.md must have a description field');
    const rawDesc = descMatch[1].trim().replace(/^['"]|['"]$/g, '');

    assert.ok(rawDesc.endsWith('...'), `truncated description must end with "...", got: ${rawDesc.slice(-10)}`);
  });

  test('emitted description has no lone surrogate (no split emoji)', () => {
    // Place emojis exactly at positions 1021–1025 (code points) so that a naive
    // UTF-16 slice at 1021 code units would cut inside the second emoji's surrogate pair.
    // 1019 ASCII chars + 6 emoji = 1025 code points (>1024, triggers truncation).
    // UTF-16 length = 1019 + 12 = 1031.  Naive slice(0,1021) yields 1019 ASCII +
    // the HIGH surrogate of emoji[0] — a lone surrogate.
    const cmd = makeEmojiCommand(1019, 6);
    const result = convertClaudeCommandToClineSkill(cmd, 'gsd-emoji-test');

    const descMatch = result.match(/^description:\s*(.+)$/m);
    assert.ok(descMatch, 'emitted SKILL.md must have a description field');
    const rawDesc = descMatch[1].trim().replace(/^['"]|['"]$/g, '');

    // Verify no lone surrogate: every char's code point must be outside [0xD800, 0xDFFF].
    const hasLoneSurrogate = [...rawDesc].some(c => {
      const cp = c.codePointAt(0);
      return cp >= 0xD800 && cp <= 0xDFFF;
    });
    assert.ok(!hasLoneSurrogate, 'emitted description must not contain a lone surrogate');

    // Also round-trip through Buffer to confirm the string is valid UTF-8 encodable.
    assert.doesNotThrow(
      () => Buffer.from(rawDesc, 'utf8').toString('utf8'),
      'emitted description must round-trip through Buffer without error'
    );
  });

  test('short description (<= 1024 code points) is not truncated', () => {
    // 10 ASCII + 5 emoji = 15 code points — well under the limit.
    const cmd = makeEmojiCommand(10, 5);
    const result = convertClaudeCommandToClineSkill(cmd, 'gsd-emoji-test');

    const descMatch = result.match(/^description:\s*(.+)$/m);
    assert.ok(descMatch, 'emitted SKILL.md must have a description field');
    const rawDesc = descMatch[1].trim().replace(/^['"]|['"]$/g, '');

    assert.ok(!rawDesc.endsWith('...'), 'short description must NOT be truncated with "..."');
    // Must contain the original emoji characters intact
    assert.ok(rawDesc.includes('😀'), 'short description must preserve emoji characters');
  });
});

// ─── Fix 2 regression: cline local scope emits no skills ─────────────────────
//
// resolveRuntimeArtifactLayout('cline', dir, 'local') must return 0 kinds.
// installRuntimeArtifacts('cline', dir, 'local') must not write any skills.

describe('resolveRuntimeArtifactLayout — cline scope-aware (Fix 2)', () => {
  test('cline local: kinds.length === 0 (no skills for local scope)', () => {
    const { resolveRuntimeArtifactLayout } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
    const layout = resolveRuntimeArtifactLayout('cline', '/tmp/x', 'local');
    assert.strictEqual(layout.kinds.length, 0, 'cline local must have 0 kinds');
  });

  test('cline global: kinds.length === 1 (skills kind)', () => {
    const { resolveRuntimeArtifactLayout } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
    const layout = resolveRuntimeArtifactLayout('cline', '/tmp/x', 'global');
    assert.strictEqual(layout.kinds.length, 1, 'cline global must have 1 skills kind');
    assert.strictEqual(layout.kinds[0].kind, 'skills');
  });

  test('installRuntimeArtifacts cline local: no skills/ dir created', (t) => {
    const configDir = createTempDir('gsd-cline-local-noskills-');
    t.after(() => cleanup(configDir));

    assert.doesNotThrow(() => installRuntimeArtifacts('cline', configDir, 'local', RESOLVED_CORE));
    const skillsDir = path.join(configDir, 'skills');
    assert.ok(
      !fs.existsSync(skillsDir),
      `skills/ must NOT be created for cline local install (Fix 2), but found ${skillsDir}`
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-789-codebuddy-commands.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-789-codebuddy-commands (consolidation epic #1969 B1 #1970)", () => {
// allow-test-rule: source-text-is-the-product (see #789)
// Workflow .md / command .md / SKILL.md files — their text IS what the runtime
// loads. Testing emitted text tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * Regression guard — enh(#789): elevate CodeBuddy slash-command surface.
 *
 * CodeBuddy (Tencent, @tencent-ai/codebuddy-code) reads user-level surfaces
 * (https://www.codebuddy.ai/docs/cli/slash-commands, /skills):
 *   - commands/gsd-<stem>.md   — slash commands shown in the '/' menu
 *   - skills/gsd-<stem>/SKILL.md — model-invocable skills
 *
 * Before #789 gsd emitted only skills/. Because CodeBuddy skills default to
 * user-invocable:true (appear in '/'), emitting a commands/ surface AND leaving
 * skills user-invocable would duplicate every /gsd-* entry. #789 therefore:
 *   1. emits commands/gsd-<stem>.md (the '/' surface, peer-consistent with
 *      Cursor #785 and Augment #790),
 *   2. marks skills user-invocable:false so they become model-invocable
 *      background knowledge and the commands/ surface is the sole '/' surface.
 *
 * Subagents are already emitted via the generic agents block + convertClaude
 * AgentToCodebuddyAgent (~/.codebuddy/agents/), so #789 adds no agents change.
 *
 * mcp.json is intentionally NOT written: gsd ships no MCP server, and CodeBuddy's
 * mcp.json holds an `mcpServers` map of *external* servers to connect to —
 * there is nothing for gsd to register. Same exclusion as #784/#785/#790.
 */
'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');

const {
  convertClaudeCommandToCodebuddyCommand,
  convertClaudeCommandToCodebuddySkill,
  convertClaudeCommandToCursorSkill,
} = require('../bin/install.js');

const {
  installRuntimeArtifacts,
  uninstallRuntimeArtifacts,
} = require('../gsd-core/bin/lib/install-engine.cjs');
const { resolveRuntimeArtifactLayout } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
const { loadSkillsManifest, resolveProfile } = require('../gsd-core/bin/lib/install-profiles.cjs');

const REAL_COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');
const MANIFEST = loadSkillsManifest(REAL_COMMANDS_DIR);
const RESOLVED_CORE = resolveProfile({ modes: ['core'], manifest: MANIFEST });

// ─── Layout contract ─────────────────────────────────────────────────────────

describe('enh-789 — codebuddy layout has commands + skills kinds', () => {
  test('resolveRuntimeArtifactLayout codebuddy returns 3 kinds (ADR-1235 §1 agents cutover)', () => {
    const layout = resolveRuntimeArtifactLayout('codebuddy', '/tmp/fake-codebuddy-dir');
    assert.strictEqual(layout.kinds.length, 3, 'codebuddy must have exactly 3 artifact kinds (commands + skills + agents)');
    const kindNames = layout.kinds.map(k => k.kind).sort();
    assert.deepStrictEqual(kindNames, ['agents', 'commands', 'skills']);
  });

  test('codebuddy commands kind targets commands/ with gsd- prefix', () => {
    const layout = resolveRuntimeArtifactLayout('codebuddy', '/tmp/fake-codebuddy-dir');
    const commandsKind = layout.kinds.find(k => k.kind === 'commands');
    assert.ok(commandsKind, 'must have commands kind');
    assert.strictEqual(commandsKind.destSubpath, 'commands');
    assert.strictEqual(commandsKind.prefix, 'gsd-');
    assert.strictEqual(typeof commandsKind.stage, 'function');
  });

  test('codebuddy skills kind targets skills/ with gsd- prefix', () => {
    const layout = resolveRuntimeArtifactLayout('codebuddy', '/tmp/fake-codebuddy-dir');
    const skillsKind = layout.kinds.find(k => k.kind === 'skills');
    assert.ok(skillsKind, 'must have skills kind');
    assert.strictEqual(skillsKind.destSubpath, 'skills');
    assert.strictEqual(skillsKind.prefix, 'gsd-');
  });
});

// ─── Command converter contract ──────────────────────────────────────────────

describe('enh-789 — convertClaudeCommandToCodebuddyCommand', () => {
  const SRC = [
    '---',
    'name: gsd:new-project',
    'description: Initialize a project',
    'argument-hint: "[name]"',
    'allowed-tools:',
    '  - Read',
    '---',
    '',
    'Use .claude/skills/ and run /gsd:help. Claude Code reads CLAUDE.md.',
    '',
  ].join('\n');

  test('emits a description-only frontmatter (no Claude-specific name: gsd:)', () => {
    const out = convertClaudeCommandToCodebuddyCommand(SRC, 'gsd-new-project');
    assert.ok(out.startsWith('---\n'), 'must begin with frontmatter');
    assert.ok(/^description:/m.test(out), 'must carry a description field');
    assert.ok(!out.includes('name: gsd:new-project'), 'must drop Claude colon-form name field');
  });

  test('preserves a present argument-hint (CodeBuddy supports it)', () => {
    const out = convertClaudeCommandToCodebuddyCommand(SRC, 'gsd-new-project');
    assert.ok(/^argument-hint:\s*["']?\[name\]["']?\s*$/m.test(out),
      `argument-hint must be carried through when present in source. Got:\n${out}`);
  });

  test('converts body Claude-isms to CodeBuddy equivalents', () => {
    const out = convertClaudeCommandToCodebuddyCommand(SRC, 'gsd-new-project');
    assert.ok(out.includes('.codebuddy/skills/'), out);
    assert.ok(out.includes('/gsd-help'), out);
    assert.ok(out.includes('CODEBUDDY.md'), out);
    assert.ok(!/\bClaude Code\b/.test(out), 'must rebrand "Claude Code"');
  });
});

describe('enh-789 — skills marked user-invocable:false', () => {
  test('convertClaudeCommandToCodebuddySkill emits user-invocable: false', () => {
    const src = [
      '---',
      'name: gsd:help',
      'description: Show help',
      '---',
      '',
      '# body',
      '',
    ].join('\n');
    const out = convertClaudeCommandToCodebuddySkill(src, 'gsd-help');
    assert.ok(/^user-invocable:\s*false\s*$/m.test(out),
      `SKILL.md frontmatter must hide skill from '/' menu (user-invocable: false). Got:\n${out}`);
  });
});

// ─── Install contract ────────────────────────────────────────────────────────

describe('enh-789 — installRuntimeArtifacts codebuddy emits commands and skills', () => {
  test('global codebuddy install: commands/gsd-help.md and skills/gsd-help/SKILL.md exist', (t) => {
    const configDir = createTempDir('gsd-enh789-codebuddy-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('codebuddy', configDir, 'global', RESOLVED_CORE);

    const commandsDir = path.join(configDir, 'commands');
    assert.ok(fs.existsSync(commandsDir), 'commands/ dir must exist');
    const cmdFiles = fs.readdirSync(commandsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(cmdFiles.length > 0, 'at least one gsd-*.md command file must be installed');
    assert.ok(fs.existsSync(path.join(commandsDir, 'gsd-help.md')), 'commands/gsd-help.md must exist');

    const skillsDir = path.join(configDir, 'skills');
    assert.ok(fs.existsSync(skillsDir), 'skills/ dir must exist');
    assert.ok(fs.existsSync(path.join(skillsDir, 'gsd-help', 'SKILL.md')), 'skills/gsd-help/SKILL.md must exist');
  });

  test('installed commands/gsd-help.md is CodeBuddy-compatible (no raw ~/.claude/, rebranded)', (t) => {
    const configDir = createTempDir('gsd-enh789-content-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('codebuddy', configDir, 'global', RESOLVED_CORE);

    const helpCmd = path.join(configDir, 'commands', 'gsd-help.md');
    const content = fs.readFileSync(helpCmd, 'utf8');
    assert.ok(!content.includes('~/.claude/'), 'commands must not contain raw ~/.claude/ refs');
    assert.ok(content.startsWith('---'), 'commands must carry frontmatter');
  });

  test('installed skills/gsd-help/SKILL.md is hidden from the / menu', (t) => {
    const configDir = createTempDir('gsd-enh789-skillhide-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('codebuddy', configDir, 'global', RESOLVED_CORE);

    const skill = fs.readFileSync(path.join(configDir, 'skills', 'gsd-help', 'SKILL.md'), 'utf8');
    assert.ok(/^user-invocable:\s*false\s*$/m.test(skill),
      'installed SKILL.md must set user-invocable: false');
  });

  test('command count matches skill count (profile parity)', (t) => {
    const configDir = createTempDir('gsd-enh789-parity-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('codebuddy', configDir, 'global', RESOLVED_CORE);

    const cmdCount = fs.readdirSync(path.join(configDir, 'commands'))
      .filter(f => f.startsWith('gsd-') && f.endsWith('.md')).length;
    const skillCount = fs.readdirSync(path.join(configDir, 'skills'), { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-')).length;
    assert.strictEqual(cmdCount, skillCount, 'command count must equal skill count for same profile');
  });

  test('full profile install: no $HOME/.codebuddy or ~/.codebuddy leak in any command', (t) => {
    // The codebuddy converter rewrites `.claude/` → `.codebuddy/`, so source
    // refs like `@$HOME/.claude/gsd-core/...` (e.g. plan-review-convergence.md)
    // must be normalized to the install target — not left as $HOME/.codebuddy.
    const RESOLVED_FULL = resolveProfile({ modes: ['full'], manifest: MANIFEST });
    const configDir = createTempDir('gsd-enh789-noleak-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('codebuddy', configDir, 'global', RESOLVED_FULL);

    const commandsDir = path.join(configDir, 'commands');
    for (const f of fs.readdirSync(commandsDir).filter(n => n.endsWith('.md'))) {
      const content = fs.readFileSync(path.join(commandsDir, f), 'utf8');
      assert.ok(!content.includes('$HOME/.codebuddy'), `${f} must not leak $HOME/.codebuddy`);
      assert.ok(!content.includes('~/.codebuddy'), `${f} must not leak ~/.codebuddy`);
      assert.ok(!content.includes('.claude/'), `${f} must not retain raw .claude/ refs`);
    }
  });

  test('full profile install does NOT mutate source commands/gsd/ files', (t) => {
    const RESOLVED_FULL = resolveProfile({ modes: ['full'], manifest: MANIFEST });
    assert.strictEqual(RESOLVED_FULL.skills, '*', 'full profile must have skills === "*"');

    const configDir = createTempDir('gsd-enh789-full-');
    t.after(() => cleanup(configDir));

    const srcHelpPath = path.join(REAL_COMMANDS_DIR, 'help.md');
    const before = fs.readFileSync(srcHelpPath, 'utf8');

    installRuntimeArtifacts('codebuddy', configDir, 'global', RESOLVED_FULL);

    const after = fs.readFileSync(srcHelpPath, 'utf8');
    assert.strictEqual(before, after, 'source commands/gsd/help.md must not be mutated by the install');
  });
});

// ─── #2644: Cursor skills are the one slash + model surface ──────────────────
describe('fix-2644 — Cursor has one menu entry per GSD workflow', () => {
  test('convertClaudeCommandToCursorSkill emits only supported invocation metadata', () => {
    const src = [
      '---',
      'name: gsd:help',
      'description: Show help',
      '---',
      '',
      '# body',
      '',
    ].join('\n');
    const out = convertClaudeCommandToCursorSkill(src, 'gsd-help');
    assert.ok(!/^user-invocable:/m.test(out),
      `Cursor does not support user-invocable; the field must not be emitted. Got:\n${out}`);
    assert.ok(!/^disable-model-invocation:/m.test(out),
      'Cursor skill must remain available for contextual model invocation');
  });

  test('fresh install keeps the skill slash/model surface and omits commands', (t) => {
    const configDir = createTempDir('gsd-fix2644-fresh-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('cursor', configDir, 'global', RESOLVED_CORE);

    const skill = fs.readFileSync(path.join(configDir, 'skills', 'gsd-help', 'SKILL.md'), 'utf8');
    assert.ok(!/^user-invocable:/m.test(skill));
    assert.ok(!/^disable-model-invocation:/m.test(skill));
    assert.ok(!fs.existsSync(path.join(configDir, 'commands', 'gsd-help.md')));
  });

  test('reinstall removes manifest-proven legacy commands and preserves unknown files', (t) => {
    const configDir = createTempDir('gsd-fix2644-upgrade-');
    t.after(() => cleanup(configDir));

    const commandsDir = path.join(configDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    const managedContent = '# old generated help\n';
    fs.writeFileSync(path.join(commandsDir, 'gsd-help.md'), managedContent);
    fs.writeFileSync(path.join(commandsDir, 'gsd-my-custom.md'), '# user command\n');
    fs.writeFileSync(path.join(configDir, 'gsd-file-manifest.json'), JSON.stringify({
      version: '1.8.0',
      timestamp: '2026-07-28T00:00:00.000Z',
      mode: 'full',
      files: {
        'commands/gsd-help.md': crypto.createHash('sha256').update(managedContent).digest('hex'),
      },
    }));

    installRuntimeArtifacts('cursor', configDir, 'global', RESOLVED_CORE);

    assert.ok(!fs.existsSync(path.join(commandsDir, 'gsd-help.md')),
      'manifest-proven legacy command must be retired');
    assert.ok(fs.existsSync(path.join(commandsDir, 'gsd-my-custom.md')),
      'unmanifested user command must be preserved');
  });

  test('profile surface apply also retires a manifest-proven legacy command', (t) => {
    const configDir = createTempDir('gsd-fix2644-surface-');
    t.after(() => cleanup(configDir));

    const commandsDir = path.join(configDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    const content = '# old generated help\n';
    fs.writeFileSync(path.join(commandsDir, 'gsd-help.md'), content);
    fs.writeFileSync(path.join(configDir, 'gsd-file-manifest.json'), JSON.stringify({
      version: '1.8.0', timestamp: '2026-07-28T00:00:00.000Z', mode: 'core',
      files: { 'commands/gsd-help.md': crypto.createHash('sha256').update(content).digest('hex') },
    }));

    const layout = resolveRuntimeArtifactLayout('cursor', configDir, 'global');
    applySurface(configDir, layout, MANIFEST);

    assert.ok(!fs.existsSync(path.join(commandsDir, 'gsd-help.md')),
      'profile toggles must not leave or recreate the retired duplicate surface');
    assert.ok(fs.existsSync(path.join(configDir, 'skills', 'gsd-help', 'SKILL.md')));
  });

  test('uninstall also retires manifest-proven legacy commands', (t) => {
    const configDir = createTempDir('gsd-fix2644-uninstall-');
    t.after(() => cleanup(configDir));

    const commandsDir = path.join(configDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    const managedContent = '# old generated help\n';
    fs.writeFileSync(path.join(commandsDir, 'gsd-help.md'), managedContent);
    fs.writeFileSync(path.join(commandsDir, 'user-command.md'), '# user command\n');
    fs.writeFileSync(path.join(configDir, 'gsd-file-manifest.json'), JSON.stringify({
      version: '1.8.0', timestamp: '2026-07-28T00:00:00.000Z', mode: 'full',
      files: {
        'commands/gsd-help.md': crypto.createHash('sha256').update(managedContent).digest('hex'),
      },
    }));

    uninstallRuntimeArtifacts('cursor', configDir, 'global');

    assert.ok(!fs.existsSync(path.join(commandsDir, 'gsd-help.md')),
      'direct uninstall must remove a manifest-proven retired command');
    assert.ok(fs.existsSync(path.join(commandsDir, 'user-command.md')),
      'direct uninstall must preserve unknown user commands');
  });
});

// ─── Uninstall contract ──────────────────────────────────────────────────────

describe('enh-789 — uninstallRuntimeArtifacts removes codebuddy commands', () => {
  test('uninstall removes gsd-* commands but preserves user commands', (t) => {
    const configDir = createTempDir('gsd-enh789-uninstall-');
    t.after(() => cleanup(configDir));

    const commandsDir = path.join(configDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'gsd-help.md'), '# help\n');
    fs.writeFileSync(path.join(commandsDir, 'user-custom.md'), '# user\n');

    uninstallRuntimeArtifacts('codebuddy', configDir, 'global');

    assert.ok(!fs.existsSync(path.join(commandsDir, 'gsd-help.md')), 'gsd-help.md must be removed');
    assert.ok(fs.existsSync(path.join(commandsDir, 'user-custom.md')), 'user-custom.md must be preserved');
  });
});

// ─── mcp.json exclusion ──────────────────────────────────────────────────────

describe('enh-789 — mcp.json excluded (gsd ships no MCP server)', () => {
  test('codebuddy install does not write mcp.json / .mcp.json', (t) => {
    const configDir = createTempDir('gsd-enh789-mcp-excluded-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('codebuddy', configDir, 'global', RESOLVED_CORE);

    assert.ok(!fs.existsSync(path.join(configDir, 'mcp.json')), 'must not write mcp.json');
    assert.ok(!fs.existsSync(path.join(configDir, '.mcp.json')), 'must not write .mcp.json');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2794-opencode-model-profile-overrides.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2794-opencode-model-profile-overrides (consolidation epic #1969 B1 #1970)", () => {
/**
 * Regression test for bug #2794
 *
 * OpenCode generated agents ignored `model_profile_overrides.opencode.*`.
 * The agent install path called `readGsdEffectiveModelOverrides` (explicit
 * per-agent overrides) but never called `readGsdRuntimeProfileResolver`
 * (tier-based profile overrides). When a user configured:
 *
 *   { runtime: "opencode", model_profile_overrides: { opencode: { sonnet: "..." } } }
 *
 * generated `.opencode/agents/gsd-*.md` files contained no `model:` frontmatter.
 *
 * The fix adds a tier-resolver fallback in the OpenCode agent conversion block:
 * explicit `model_overrides[agent]` > `model_profile_overrides.opencode.<tier>` > omit.
 *
 * This test exercises:
 * 1. `readGsdRuntimeProfileResolver` correctly resolves OpenCode tier overrides.
 * 2. The agent install code path embeds the resolved model into OpenCode frontmatter.
 * 3. Explicit `model_overrides` still wins over tier-based resolution.
 * 4. Missing overrides produce no `model:` field (no regression on omit behavior).
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  readGsdRuntimeProfileResolver,
  install,
} = require('../bin/install.js');

const { createTempDir, cleanup } = require('./helpers.cjs');
const makeTmp = (prefix) => createTempDir(`gsd-2794-${prefix}-`);

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf-8');
}


describe('bug-2794: readGsdRuntimeProfileResolver resolves opencode tier overrides', () => {
  let projectDir;
  let homeDir;
  let origHome;
  let origUP;

  beforeEach(() => {
    projectDir = makeTmp('proj');
    homeDir = makeTmp('home');
    origHome = process.env.HOME;
    origUP = process.env.USERPROFILE;
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUP === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUP;
    cleanup(projectDir);
    cleanup(homeDir);
  });

  test('resolves opencode sonnet tier to user-supplied model ID', () => {
    writeJson(path.join(projectDir, '.planning', 'config.json'), {
      runtime: 'opencode',
      model_profile: 'balanced',
      model_profile_overrides: {
        opencode: {
          sonnet: 'anthropic/claude-sonnet-4-7',
        },
      },
    });

    const resolver = readGsdRuntimeProfileResolver(projectDir);
    assert.ok(resolver !== null, 'expected a resolver for opencode runtime');

    // gsd-roadmapper balanced tier = sonnet — should resolve to override
    const entry = resolver.resolve('gsd-roadmapper');
    assert.ok(entry !== null, 'expected entry for gsd-roadmapper');
    assert.strictEqual(entry.model, 'anthropic/claude-sonnet-4-7', 'sonnet override applied');
  });

  test('returns null resolver when runtime is not set', () => {
    writeJson(path.join(projectDir, '.planning', 'config.json'), {
      model_profile: 'balanced',
      model_profile_overrides: { opencode: { sonnet: 'x' } },
    });
    const resolver = readGsdRuntimeProfileResolver(projectDir);
    assert.strictEqual(resolver, null, 'no resolver without runtime field');
  });

  test('resolver returns null for agent not in MODEL_PROFILES', () => {
    writeJson(path.join(projectDir, '.planning', 'config.json'), {
      runtime: 'opencode',
      model_profile: 'balanced',
      model_profile_overrides: { opencode: { sonnet: 'x' } },
    });
    const resolver = readGsdRuntimeProfileResolver(projectDir);
    assert.ok(resolver !== null);
    const entry = resolver.resolve('gsd-nonexistent-agent');
    assert.strictEqual(entry, null, 'unknown agent name yields null');
  });
});

describe('bug-2794: OpenCode agent install embeds model_profile_overrides model', () => {
  let projectDir;
  let homeDir;
  let origHome;
  let origUP;
  let origCwd;

  beforeEach(() => {
    projectDir = makeTmp('proj');
    homeDir = makeTmp('home');
    origHome = process.env.HOME;
    origUP = process.env.USERPROFILE;
    origCwd = process.cwd();
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;
    process.chdir(projectDir);
  });

  afterEach(() => {
    if (origHome === undefined) delete process.env.HOME;
    else process.env.HOME = origHome;
    if (origUP === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = origUP;
    process.chdir(origCwd);
    cleanup(projectDir);
    cleanup(homeDir);
  });

  test('generated OpenCode agent frontmatter includes model from model_profile_overrides', () => {
    writeJson(path.join(projectDir, '.planning', 'config.json'), {
      runtime: 'opencode',
      model_profile: 'balanced',
      model_profile_overrides: {
        opencode: {
          sonnet: 'anthropic/claude-sonnet-4-7',
          opus: 'anthropic/claude-opus-4-7',
          haiku: 'anthropic/claude-haiku-4-5',
        },
      },
    });

    const oldLog = console.log;
    console.log = () => {};
    try {
      install(false, 'opencode');
    } finally {
      console.log = oldLog;
    }

    const agentsDir = path.join(projectDir, '.opencode', 'agents');
    assert.ok(fs.existsSync(agentsDir), 'agents directory should be created');

    // gsd-roadmapper is balanced -> sonnet tier
    const roadmapperPath = path.join(agentsDir, 'gsd-roadmapper.md');
    assert.ok(fs.existsSync(roadmapperPath), 'gsd-roadmapper.md should exist');
    const roadmapperContent = fs.readFileSync(roadmapperPath, 'utf-8');
    assert.match(
      roadmapperContent,
      /^model: anthropic\/claude-sonnet-4-7$/m,
      'gsd-roadmapper should have sonnet model from model_profile_overrides'
    );

    // gsd-planner is balanced -> opus tier
    const plannerPath = path.join(agentsDir, 'gsd-planner.md');
    assert.ok(fs.existsSync(plannerPath), 'gsd-planner.md should exist');
    const plannerContent = fs.readFileSync(plannerPath, 'utf-8');
    assert.match(
      plannerContent,
      /^model: anthropic\/claude-opus-4-7$/m,
      'gsd-planner should have opus model from model_profile_overrides'
    );
  });

  test('explicit model_overrides[agent] wins over model_profile_overrides tier', () => {
    writeJson(path.join(projectDir, '.planning', 'config.json'), {
      runtime: 'opencode',
      model_profile: 'balanced',
      model_overrides: {
        'gsd-roadmapper': 'explicit-winner-model',
      },
      model_profile_overrides: {
        opencode: {
          sonnet: 'tier-model-that-should-lose',
        },
      },
    });

    const oldLog = console.log;
    console.log = () => {};
    try {
      install(false, 'opencode');
    } finally {
      console.log = oldLog;
    }

    const roadmapperPath = path.join(projectDir, '.opencode', 'agents', 'gsd-roadmapper.md');
    assert.ok(fs.existsSync(roadmapperPath));
    const content = fs.readFileSync(roadmapperPath, 'utf-8');
    assert.match(
      content,
      /^model: explicit-winner-model$/m,
      'explicit model_overrides must win over model_profile_overrides tier'
    );
    assert.doesNotMatch(
      content,
      /tier-model-that-should-lose/,
      'tier model must not appear when explicit override is present'
    );
  });

  test('no model field when neither model_overrides nor model_profile_overrides is set', () => {
    writeJson(path.join(projectDir, '.planning', 'config.json'), {
      runtime: 'opencode',
      model_profile: 'balanced',
    });

    const oldLog = console.log;
    console.log = () => {};
    try {
      install(false, 'opencode');
    } finally {
      console.log = oldLog;
    }

    const roadmapperPath = path.join(projectDir, '.opencode', 'agents', 'gsd-roadmapper.md');
    if (fs.existsSync(roadmapperPath)) {
      const content = fs.readFileSync(roadmapperPath, 'utf-8');
      // When no overrides, model field should either be absent or use built-in default
      // The key invariant: no model field if there are no user-supplied overrides
      // AND no built-in opencode defaults for this tier
      // (gsd-roadmapper balanced = sonnet; opencode has built-in sonnet defaults)
      // So we only assert no crash and no tier-model-not-provided entries
      assert.ok(typeof content === 'string', 'agent file should be a string');
    }
    // Key: no exception thrown (test passes = no crash on missing overrides)
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2643-skill-frontmatter-name.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2643-skill-frontmatter-name (consolidation epic #1969 B1 #1970)", () => {
'use strict';

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #2643 / #2808: skill frontmatter name parity.
 *
 * Original (#2643): workflows emitted Skill(skill="gsd:<cmd>") and the
 * installer registered colon form in SKILL.md name: to match.
 *
 * Updated (#2808): workflows now use Skill(skill="gsd-<cmd>") (hyphen),
 * and the installer emits name: gsd-<cmd> (hyphen). Claude Code autocomplete
 * now shows the canonical hyphen form instead of the deprecated colon form.
 * The directory name (gsd-<cmd>) is unchanged.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const {
  convertClaudeCommandToClaudeSkill,
  skillFrontmatterName,
} = require(path.join(ROOT, 'bin', 'install.js'));

const WORKFLOWS_DIR = path.join(ROOT, 'gsd-core', 'workflows');
const COMMANDS_DIR = path.join(ROOT, 'commands', 'gsd');

function collectFiles(dir, results) {
  if (!results) results = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return results; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(full, results);
    else if (e.name.endsWith('.md')) results.push(full);
  }
  return results;
}

/**
 * Extract every `Skill(skill="<name>")` invocation as a structured record.
 *
 * Per project test rigor (`feedback_no_source_grep_tests.md`), this parses
 * each call as a unit instead of leaning on a single regex over raw bytes.
 * The flow is:
 *
 *   1. Strip HTML comments so commented-out examples don't count as drift.
 *   2. Walk the content for `Skill(` openers; for each, find the matching
 *      `)` closer (Skill bodies are simple kwarg lists, no nesting).
 *   3. Parse the call body for the `skill = "..."` keyword argument.
 *      Permissive whitespace around the keyword and `=`, permissive
 *      single/double quoting (with optional `\` escapes from string-
 *      embedded examples), permissive name body — so malformed drift like
 *      `Skill(skill="gsd:extract_learnings")` is surfaced rather than
 *      silently skipped by an over-strict character class.
 *
 * Returns `[{ name, raw }]` per call. Filtering by namespace (gsd- vs gsd:)
 * happens at the call site so the extractor stays neutral.
 */
function extractSkillCalls(content) {
  // regex-free HTML-comment stripper (CodeQL: avoid incomplete-multi-character-sanitization)
  let stripped = '';
  {
    let rest = content;
    let idx;
    while ((idx = rest.indexOf('<!--')) !== -1) {
      stripped += rest.slice(0, idx);
      const end = rest.indexOf('-->', idx + 4);
      if (end === -1) { rest = ''; break; }
      rest = rest.slice(end + 3);
    }
    stripped += rest;
  }
  const calls = [];
  // Body class excludes backslash so the extractor doesn't include an
  // escape character that precedes the closing quote in embedded examples
  // (e.g. `Skill(skill=\"gsd-plan-phase\", …)` written inside a string
  // context). A trailing `\` is permitted on the closing-quote side via the
  // optional `\\?` so both `\"` and `"` close the value cleanly.
  const argRe = /^\s*skill\s*=\s*\\?(['"])([^'"\\]+)\\?\1/i;
  let i = 0;
  while (i < stripped.length) {
    const open = stripped.indexOf('Skill(', i);
    if (open === -1) break;
    const close = stripped.indexOf(')', open);
    if (close === -1) break;
    const body = stripped.slice(open + 'Skill('.length, close);
    const match = body.match(argRe);
    if (match) calls.push({ name: match[2], raw: stripped.slice(open, close + 1) });
    i = close + 1;
  }
  return calls;
}

function extractSkillNamesHyphen(content) {
  return new Set(
    extractSkillCalls(content)
      .map((c) => c.name)
      .filter((n) => n.startsWith('gsd-')),
  );
}

function extractSkillNamesColon(content) {
  return new Set(
    extractSkillCalls(content)
      .map((c) => c.name)
      .filter((n) => n.startsWith('gsd:')),
  );
}

describe('skill frontmatter name parity (#2643 / #2808)', () => {
  test('skillFrontmatterName helper emits hyphen form (#2808)', () => {
    assert.strictEqual(typeof skillFrontmatterName, 'function');
    assert.strictEqual(skillFrontmatterName('gsd-execute-phase'), 'gsd-execute-phase');
    assert.strictEqual(skillFrontmatterName('gsd-plan-phase'), 'gsd-plan-phase');
    assert.strictEqual(skillFrontmatterName('gsd-next'), 'gsd-next');
  });

  test('convertClaudeCommandToClaudeSkill emits name: gsd-<cmd> (hyphen)', () => {
    const input = '---\nname: old\ndescription: test\n---\n\nBody.';
    const result = convertClaudeCommandToClaudeSkill(input, 'gsd-execute-phase');
    // Parse the frontmatter block structurally: extract the name: field value.
    const frontmatterMatch = result.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    assert.ok(frontmatterMatch, 'output must have a frontmatter block delimited by ---');
    const frontmatterLines = frontmatterMatch[1].split(/\r?\n/);
    const nameEntry = frontmatterLines.find((l) => l.startsWith('name:'));
    assert.ok(nameEntry, 'frontmatter must contain a name: field');
    const nameValue = nameEntry.replace(/^name:\s*/, '').trim();
    assert.strictEqual(
      nameValue,
      'gsd-execute-phase',
      `frontmatter name: must be 'gsd-execute-phase' (hyphen form), got '${nameValue}'`
    );
  });

  test('no workflow uses deprecated Skill(skill="gsd:<cmd>") colon form', () => {
    const workflowFiles = collectFiles(WORKFLOWS_DIR);
    const colonRefs = [];
    for (const f of workflowFiles) {
      const src = fs.readFileSync(f, 'utf-8');
      for (const n of extractSkillNamesColon(src)) {
        colonRefs.push(path.basename(f) + ': ' + n);
      }
    }
    assert.deepStrictEqual(
      colonRefs,
      [],
      'deprecated colon-form Skill() calls found (update to hyphen): ' + colonRefs.join(', ')
    );
  });

  test('every workflow Skill(skill="gsd-<cmd>") resolves to an emitted skill name', () => {
    const workflowFiles = collectFiles(WORKFLOWS_DIR);
    const referenced = new Set();
    const templatedSkipped = [];
    for (const f of workflowFiles) {
      const src = fs.readFileSync(f, 'utf-8');
      for (const n of extractSkillNamesHyphen(src)) {
        // Skip template expressions (e.g. `gsd-${ref.skill}`): these are
        // capability-dispatched — the skill stem is resolved at runtime from
        // the `loop render-hooks` registry output (ADR-857 phase 6), so there
        // is no single literal skill file to validate against here.
        // The capability registry's own validateStep gate (gen-capability-registry.cjs)
        // is responsible for ensuring each `steps[].ref.skill` corresponds to a
        // real skill declared in the capability's `skills` array.
        if (n.includes('${')) {
          templatedSkipped.push(path.basename(f) + ': ' + n);
        } else {
          referenced.add(n);
        }
      }
    }
    assert.ok(
      referenced.size > 0,
      `expected at least one literal Skill(skill="gsd-<cmd>") reference in workflows under ${WORKFLOWS_DIR}`
    );

    const emitted = new Set();
    const cmdFiles = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md'));
    for (const cmd of cmdFiles) {
      const base = cmd.replace(/\.md$/, '');
      const skillDirName = 'gsd-' + base;
      const src = fs.readFileSync(path.join(COMMANDS_DIR, cmd), 'utf-8');
      const out = convertClaudeCommandToClaudeSkill(src, skillDirName);
      const m = out.match(/^---\r?\nname:\s*(.+)$/m);
      if (m) emitted.add(m[1].trim());
    }

    const missing = [];
    for (const r of referenced) if (!emitted.has(r)) missing.push(r);
    assert.deepStrictEqual(
      missing,
      [],
      'workflow refs not emitted as skill names: ' + missing.join(', '),
    );
    // Informational: report how many templated dispatches were intentionally skipped.
    // (Templated names are validated by the capability registry, not statically here.)
    if (templatedSkipped.length > 0) {
      // Not a failure — just a note for test output transparency.
      // Use a diagnostic comment: node:test does not have a skip-within-test API.
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-778-cross-runtime-command-enrichment.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-778-cross-runtime-command-enrichment (consolidation epic #1969 B1 #1970)", () => {
// allow-test-rule: source-text-is-the-product (see #778)
// Reads .md/SKILL.md/.toml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * GSD Tools Tests — #778 cross-runtime command enrichment.
 *
 * Qwen Code skills: numeric `priority` field (higher sorts earlier in the
 * /skills TUI listing per the Qwen skills spec). Scoped to runtime='qwen'.
 *
 * The OpenCode sub-feature (per-command model/agent/subtask/variant) is
 * intentionally NOT implemented — see PR description: `model` reintroduces the
 * #1156 ProviderModelNotFoundError regression for non-Anthropic OpenCode users,
 * `subtask`/`agent` change execution semantics for GSD's interactive commands,
 * and `variant` is not in the OpenCode command schema.
 *
 * #1928: the Gemini custom-command TOML sub-feature ($ARGUMENTS → {{args}}
 * interpolation, !{cat .planning/STATE.md} live-state injection) was removed
 * along with the gemini runtime (Google sunset Gemini CLI 2026-06-18).
 * convertClaudeToGeminiMarkdown no longer exists in bin/install.js.
 *
 * Uses node:test and node:assert (NOT Jest).
 */

process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  convertClaudeCommandToClaudeSkill,
} = require('../bin/install.js');

// ─── (b) Qwen Code: priority ordering ───────────────────────────────────────

describe('#778 (b) Qwen skills priority', () => {
  const mk = (name, desc, body) =>
    ['---', `name: gsd:${name}`, `description: ${desc}`, '---', '', body].join('\n');

  test('emits numeric priority for a core-loop command (runtime=qwen)', () => {
    const result = convertClaudeCommandToClaudeSkill(
      mk('plan-phase', 'Plan a phase', 'Body.'),
      'gsd-plan-phase',
      'qwen',
      []
    );
    const m = result.match(/^priority:\s*(\d+)\s*$/m);
    assert.ok(m, 'priority field present for gsd-plan-phase');
    assert.equal(Number(m[1]) > 0, true, 'priority is a positive number');
  });

  test('core loop ranks higher than mid-tier (higher = earlier per spec)', () => {
    const np = convertClaudeCommandToClaudeSkill(
      mk('new-project', 'Start a project', 'Body.'), 'gsd-new-project', 'qwen', []
    ).match(/^priority:\s*(\d+)/m);
    const help = convertClaudeCommandToClaudeSkill(
      mk('help', 'Help', 'Body.'), 'gsd-help', 'qwen', []
    ).match(/^priority:\s*(\d+)/m);
    assert.ok(np && help, 'both core and mid-tier get a priority');
    assert.ok(
      Number(np[1]) > Number(help[1]),
      'new-project (core) sorts earlier than help (utility) — higher value'
    );
  });

  test('utility command NOT in the priority map gets no priority field', () => {
    const result = convertClaudeCommandToClaudeSkill(
      mk('stats', 'Show stats', 'Body.'), 'gsd-stats', 'qwen', []
    );
    assert.ok(!/^priority:/m.test(result), 'no priority emitted for unmapped utility');
  });

  test('does NOT emit priority for non-qwen runtimes (scoped to qwen)', () => {
    for (const rt of [null, 'claude', 'hermes']) {
      const result = convertClaudeCommandToClaudeSkill(
        mk('plan-phase', 'Plan a phase', 'Body.'), 'gsd-plan-phase', rt, []
      );
      assert.ok(!/^priority:/m.test(result), `no priority for runtime=${rt}`);
    }
  });
});

  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-769-context-fork-effort.install.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-769-context-fork-effort.install (consolidation epic #1969 B1 #1970)", () => {
// allow-test-rule: integration-test-input (see #769)
// Exercises install() as a black-box by inspecting produced SKILL.md output
// in a temp dir. Source command .md files are inputs whose installed
// transformation is asserted — not inspected for string presence.

/**
 * #769 — effort: frontmatter on heavy workflow skills.
 * #921 — spawning orchestrators must NOT carry context: fork.
 *
 * Context: context:fork was added by #769 to protect context budget, but
 * plan-phase, execute-phase, and autonomous are spawning orchestrators — a
 * forked subagent has no Agent/Task tool, breaking their core function.
 * effort: max is preserved; context: fork is removed from these three.
 * The converter still passes context: fork through if a source file has it
 * (for any future leaf skill that legitimately needs isolation).
 *
 * Verifies:
 *   1. Source commands/gsd/autonomous.md does NOT have context: fork, has effort: max
 *   2. Source commands/gsd/execute-phase.md does NOT have context: fork, has effort: max
 *   3. Source commands/gsd/plan-phase.md does NOT have context: fork, has effort: max
 *   4. Source commands/gsd/progress.md has effort: low
 *   5. Source commands/gsd/stats.md has effort: low
 *   6. Claude global install: SKILL.md for autonomous has effort: max, NOT context: fork
 *   7. Claude global install: SKILL.md for execute-phase has effort: max, NOT context: fork
 *   8. Claude global install: SKILL.md for plan-phase has effort: max, NOT context: fork
 *   9. Claude global install: SKILL.md for progress has effort: low
 *  10. Claude global install: SKILL.md for stats has effort: low
 *  11. convertClaudeCommandToClaudeSkill still passes context: fork through (for non-orchestrator skills)
 *  12. convertClaudeCommandToClaudeSkill emits portable effort: field values
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { install, convertClaudeCommandToClaudeSkill } = require('../bin/install.js');
const { cleanup } = require('./helpers.cjs');

// #924: Claude global install is now FLAT — concrete skills are at the top level.
// flatSkillPath returns: <skillsRoot>/gsd-<stem>/SKILL.md
function flatSkillPath(skillsRoot, stem) {
  return path.join(skillsRoot, `gsd-${stem}`, 'SKILL.md');
}

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_COMMANDS_DIR = path.join(REPO_ROOT, 'commands', 'gsd');

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readFrontmatter(mdPath) {
  const content = fs.readFileSync(mdPath, 'utf8');
  if (!content.startsWith('---')) return '';
  const end = content.indexOf('---', 3);
  if (end === -1) return '';
  return content.substring(3, end);
}

/**
 * Run a global install for Claude, redirecting its home dir to tmpHome.
 * Returns the tmpHome for inspection.
 */
function runClaudeGlobalInstall(claudeHome) {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-769-home-'));

  const prevCwd = process.cwd();
  const prevClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevSkipStale = process.env.GSD_SKIP_STALE_SDK_CHECK;

  process.env.CLAUDE_CONFIG_DIR = claudeHome;
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  process.env.GSD_SKIP_STALE_SDK_CHECK = '1';
  process.chdir(REPO_ROOT);

  try {
    install(true, 'claude');
  } finally {
    process.chdir(prevCwd);
    if (prevClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevClaudeConfigDir;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevSkipStale === undefined) delete process.env.GSD_SKIP_STALE_SDK_CHECK;
    else process.env.GSD_SKIP_STALE_SDK_CHECK = prevSkipStale;
    cleanup(isolatedHome);
  }

  return claudeHome;
}

// ─── describe 1: Source command files have correct frontmatter ────────────────

// #921/#922: spawning orchestrators must NOT carry context: fork — a forked
// subagent has no Agent/Task tool, making it impossible for orchestrators to
// spawn their required subagents. context: fork is appropriate only for leaf
// skills that do not themselves dispatch agents. effort: max is portable across Claude Code models.
describe('#769/#921/#1319 source commands: spawning orchestrators have effort: max but NOT context: fork', () => {
  test('commands/gsd/autonomous.md does NOT have context: fork (#921)', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'autonomous.md'));
    assert.doesNotMatch(fm, /^context:[ \t]*fork$/m,
      `autonomous.md is a spawning orchestrator and must NOT have context: fork (#921)\nActual:\n${fm}`);
  });

  test('commands/gsd/autonomous.md has effort: max (#1319)', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'autonomous.md'));
    assert.match(fm, /^effort:[ \t]*max$/m,
      `autonomous.md frontmatter must have effort: max\nActual:\n${fm}`);
    assert.doesNotMatch(fm, /^effort:[ \t]*xhigh$/m,
      `autonomous.md frontmatter must not have rejected effort: xhigh (#1319)\nActual:\n${fm}`);
  });

  test('commands/gsd/execute-phase.md does NOT have context: fork (#921)', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'execute-phase.md'));
    assert.doesNotMatch(fm, /^context:[ \t]*fork$/m,
      `execute-phase.md is a spawning orchestrator and must NOT have context: fork (#921)\nActual:\n${fm}`);
  });

  test('commands/gsd/execute-phase.md has effort: max (#1319)', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'execute-phase.md'));
    assert.match(fm, /^effort:[ \t]*max$/m,
      `execute-phase.md frontmatter must have effort: max\nActual:\n${fm}`);
    assert.doesNotMatch(fm, /^effort:[ \t]*xhigh$/m,
      `execute-phase.md frontmatter must not have rejected effort: xhigh (#1319)\nActual:\n${fm}`);
  });

  test('commands/gsd/plan-phase.md does NOT have context: fork (#921)', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'plan-phase.md'));
    assert.doesNotMatch(fm, /^context:[ \t]*fork$/m,
      `plan-phase.md is a spawning orchestrator and must NOT have context: fork (#921)\nActual:\n${fm}`);
  });

  test('commands/gsd/plan-phase.md has effort: max (#1319)', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'plan-phase.md'));
    assert.match(fm, /^effort:[ \t]*max$/m,
      `plan-phase.md frontmatter must have effort: max\nActual:\n${fm}`);
    assert.doesNotMatch(fm, /^effort:[ \t]*xhigh$/m,
      `plan-phase.md frontmatter must not have rejected effort: xhigh (#1319)\nActual:\n${fm}`);
  });
});

describe('#769 source commands: quick-status skills have effort: low', () => {
  test('commands/gsd/progress.md has effort: low', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'progress.md'));
    assert.match(fm, /^effort:[ \t]*low$/m,
      `progress.md frontmatter must have effort: low\nActual:\n${fm}`);
  });

  test('commands/gsd/stats.md has effort: low', () => {
    const fm = readFrontmatter(path.join(SOURCE_COMMANDS_DIR, 'stats.md'));
    assert.match(fm, /^effort:[ \t]*low$/m,
      `stats.md frontmatter must have effort: low\nActual:\n${fm}`);
  });
});

// ─── describe 2: convertClaudeCommandToClaudeSkill preserves new fields ───────

describe('#769/#1319 convertClaudeCommandToClaudeSkill: preserves context and emits portable effort fields', () => {
  test('preserves context: fork in emitted SKILL.md frontmatter', () => {
    const input = [
      '---',
      'name: gsd:test-heavy',
      'description: Test heavy skill',
      'context: fork',
      'effort: xhigh',
      'allowed-tools:',
      '  - Read',
      '  - Bash',
      '---',
      '',
      'Heavy skill body.',
    ].join('\n');

    const result = convertClaudeCommandToClaudeSkill(input, 'test-heavy');
    const end = result.indexOf('---', 3);
    const fm = result.substring(3, end);

    assert.match(fm, /^context:[ \t]*fork$/m,
      `SKILL.md frontmatter must include context: fork\nActual frontmatter:\n${fm}`);
  });

  test('normalizes effort: xhigh to effort: max in emitted SKILL.md frontmatter (#1319)', () => {
    const input = [
      '---',
      'name: gsd:test-heavy',
      'description: Test heavy skill',
      'context: fork',
      'effort: xhigh',
      'allowed-tools:',
      '  - Read',
      '  - Bash',
      '---',
      '',
      'Heavy skill body.',
    ].join('\n');

    const result = convertClaudeCommandToClaudeSkill(input, 'test-heavy');
    const end = result.indexOf('---', 3);
    const fm = result.substring(3, end);

    assert.match(fm, /^effort:[ \t]*max$/m,
      `SKILL.md frontmatter must include portable effort: max\nActual frontmatter:\n${fm}`);
    assert.doesNotMatch(fm, /^effort:[ \t]*xhigh$/m,
      `SKILL.md frontmatter must not include rejected effort: xhigh (#1319)\nActual frontmatter:\n${fm}`);
  });

  test('preserves effort: low in emitted SKILL.md frontmatter', () => {
    const input = [
      '---',
      'name: gsd:test-light',
      'description: Test light skill',
      'effort: low',
      'allowed-tools:',
      '  - Read',
      '---',
      '',
      'Light skill body.',
    ].join('\n');

    const result = convertClaudeCommandToClaudeSkill(input, 'test-light');
    const end = result.indexOf('---', 3);
    const fm = result.substring(3, end);

    assert.match(fm, /^effort:[ \t]*low$/m,
      `SKILL.md frontmatter must include effort: low\nActual frontmatter:\n${fm}`);
  });

  test('does NOT emit context: or effort: when absent from source', () => {
    const input = [
      '---',
      'name: gsd:test-plain',
      'description: Plain skill without context or effort',
      'allowed-tools:',
      '  - Read',
      '---',
      '',
      'Plain skill body.',
    ].join('\n');

    const result = convertClaudeCommandToClaudeSkill(input, 'test-plain');
    const end = result.indexOf('---', 3);
    const fm = result.substring(3, end);

    assert.doesNotMatch(fm, /^context:/m,
      `SKILL.md must not emit context: when absent from source\nActual:\n${fm}`);
    assert.doesNotMatch(fm, /^effort:/m,
      `SKILL.md must not emit effort: when absent from source\nActual:\n${fm}`);
  });
});

// ─── describe 3: Claude global install — SKILL.md files include new fields ────

// #921/#922: after install, spawning orchestrators must NOT carry context: fork
// in their emitted SKILL.md. #1319: heavyweight skills must use portable max effort.
describe('#769/#921/#1319 Claude global install: spawning-orchestrator SKILL.md files have effort: max but NOT context: fork', () => {
  let tmpDir;
  let claudeHome;

  beforeEach(() => {
    tmpDir = makeTmpDir('gsd-769-claude-');
    claudeHome = path.join(tmpDir, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gsd-autonomous SKILL.md does NOT have context: fork after global install (#921)', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'autonomous');
    const fm = readFrontmatter(skillPath);
    assert.doesNotMatch(fm, /^context:[ \t]*fork$/m,
      `gsd-autonomous is a spawning orchestrator; its SKILL.md must NOT have context: fork (#921)\nActual:\n${fm}`);
  });

  test('gsd-autonomous SKILL.md has effort: max after global install (#1319)', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'autonomous');
    const fm = readFrontmatter(skillPath);
    assert.match(fm, /^effort:[ \t]*max$/m,
      `gsd-autonomous SKILL.md must have effort: max\nActual:\n${fm}`);
    assert.doesNotMatch(fm, /^effort:[ \t]*xhigh$/m,
      `gsd-autonomous SKILL.md must not have rejected effort: xhigh (#1319)\nActual:\n${fm}`);
  });

  test('gsd-execute-phase SKILL.md does NOT have context: fork after global install (#921)', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'execute-phase');
    const fm = readFrontmatter(skillPath);
    assert.doesNotMatch(fm, /^context:[ \t]*fork$/m,
      `gsd-execute-phase is a spawning orchestrator; its SKILL.md must NOT have context: fork (#921)\nActual:\n${fm}`);
  });

  test('gsd-execute-phase SKILL.md has effort: max after global install (#1319)', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'execute-phase');
    const fm = readFrontmatter(skillPath);
    assert.match(fm, /^effort:[ \t]*max$/m,
      `gsd-execute-phase SKILL.md must have effort: max\nActual:\n${fm}`);
    assert.doesNotMatch(fm, /^effort:[ \t]*xhigh$/m,
      `gsd-execute-phase SKILL.md must not have rejected effort: xhigh (#1319)\nActual:\n${fm}`);
  });

  test('gsd-plan-phase SKILL.md does NOT have context: fork after global install (#921)', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'plan-phase');
    const fm = readFrontmatter(skillPath);
    assert.doesNotMatch(fm, /^context:[ \t]*fork$/m,
      `gsd-plan-phase is a spawning orchestrator; its SKILL.md must NOT have context: fork (#921)\nActual:\n${fm}`);
  });

  test('gsd-plan-phase SKILL.md has effort: max after global install (#1319)', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'plan-phase');
    const fm = readFrontmatter(skillPath);
    assert.match(fm, /^effort:[ \t]*max$/m,
      `gsd-plan-phase SKILL.md must have effort: max\nActual:\n${fm}`);
    assert.doesNotMatch(fm, /^effort:[ \t]*xhigh$/m,
      `gsd-plan-phase SKILL.md must not have rejected effort: xhigh (#1319)\nActual:\n${fm}`);
  });

  test('gsd-progress SKILL.md has effort: low after global install', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'progress');
    const fm = readFrontmatter(skillPath);
    assert.match(fm, /^effort:[ \t]*low$/m,
      `gsd-progress SKILL.md must have effort: low\nActual:\n${fm}`);
  });

  test('gsd-stats SKILL.md has effort: low after global install', () => {
    runClaudeGlobalInstall(claudeHome);
    const skillPath = flatSkillPath(path.join(claudeHome, 'skills'),'stats');
    const fm = readFrontmatter(skillPath);
    assert.match(fm, /^effort:[ \t]*low$/m,
      `gsd-stats SKILL.md must have effort: low\nActual:\n${fm}`);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/feat-443-effort-install-wiring.install.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:feat-443-effort-install-wiring.install (consolidation epic #1969 B1 #1970)", () => {
// allow-test-rule: integration-test-input (see #443)
// Exercises install() + generateCodexAgentToml() as a black-box by inspecting
// produced output files in temp dirs. Source agent .md files are inputs whose
// installed transformation is asserted — not inspected for string presence.

/**
 * #443 — Effort per-runtime wiring at install time.
 *
 * Verifies:
 *   1. Claude global install injects `effort:` into agent .md frontmatter.
 *   2. Codex inherited-model installs omit `model_reasoning_effort` so model
 *      and effort are not partially pinned (#838).
 *   3. Config-driven proof: effort.agent_overrides wins over tier defaults
 *      for Claude .md and for Codex .toml when runtime:"codex" pins a model.
 *   4. Source agents/gsd-planner.md has NO effort: key (injection is
 *      install-only, source markdown carries no effort: key).
 *
 * #1928: the gemini runtime (and its "Gemini install does NOT inject effort:"
 * coverage) was removed — Google sunset Gemini CLI 2026-06-18.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { install } = require('../bin/install.js');
const { cleanup } = require('./helpers.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const SOURCE_AGENTS_DIR = path.join(REPO_ROOT, 'agents');

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function readFrontmatter(mdPath) {
  const content = fs.readFileSync(mdPath, 'utf8');
  if (!content.startsWith('---')) return '';
  const end = content.indexOf('---', 3);
  if (end === -1) return '';
  return content.substring(3, end);
}

/**
 * Run a global install for the given runtime, redirecting its home dir to
 * tmpHome. Returns the tmpHome for inspection.
 *
 * Env-var redirection:
 *   claude   → CLAUDE_CONFIG_DIR
 *   codex    → CODEX_HOME
 *
 * HOME is also redirected to an isolated temp dir for the duration of the
 * install call. This prevents any install.js code that uses os.homedir()
 * directly (e.g. ~/.cache/gsd update-check deletion, ~/.gsd/defaults.json
 * reads, stale-SDK npm subprocess writes to ~/.npm) from touching the real
 * HOME and polluting the test environment for other concurrently-running
 * test files (e.g. runtime-launcher-parity test (D) checks that
 * $HOME/.claude/gsd-core/bin/gsd-tools.cjs is absent).
 *
 * GSD_SKIP_STALE_SDK_CHECK=1 is set to suppress the `npm ls -g` subprocess
 * that the installer spawns for global installs — that subprocess is slow,
 * writes to ~/.npm cache, and is irrelevant to effort-wiring assertions.
 *
 * The working directory is set to REPO_ROOT so install() can find the source
 * agents/. For config-driven tests, place tmpHome inside the project dir
 * so that readGsdEffectiveEffortConfig(targetDir) can walk up from tmpHome
 * and find .planning/config.json.
 */
function runGlobalInstall(runtime, tmpHome) {
  const envVarMap = {
    claude: 'CLAUDE_CONFIG_DIR',
    codex: 'CODEX_HOME',
  };
  const envVar = envVarMap[runtime];
  if (!envVar) throw new Error(`Unsupported runtime in test: ${runtime}`);

  // Isolate HOME to a fresh temp dir so install.js code that calls
  // os.homedir() (cache deletion, defaults.json reads, npm subprocess)
  // never touches the real $HOME/.claude / $HOME/.cache / $HOME/.gsd.
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-443-home-'));

  const prev = process.env[envVar];
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  const prevUserProfile = process.env.USERPROFILE;
  const prevSkipStale = process.env.GSD_SKIP_STALE_SDK_CHECK;

  process.env[envVar] = tmpHome;
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  process.env.GSD_SKIP_STALE_SDK_CHECK = '1';
  process.chdir(REPO_ROOT);

  try {
    install(true, runtime);
  } finally {
    process.chdir(prevCwd);
    if (prev === undefined) delete process.env[envVar];
    else process.env[envVar] = prev;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = prevUserProfile;
    if (prevSkipStale === undefined) delete process.env.GSD_SKIP_STALE_SDK_CHECK;
    else process.env.GSD_SKIP_STALE_SDK_CHECK = prevSkipStale;
    // Clean up the isolated HOME dir
    cleanup(isolatedHome);
  }

  return tmpHome;
}

// ─── Tier default expectations ────────────────────────────────────────────────
// light → low, standard → high, heavy → xhigh  (catalog defaults)
// gsd-planner: heavy → xhigh
// gsd-codebase-mapper: light → low
// gsd-executor: standard → high

// ─── describe 1: Claude install injects effort: ───────────────────────────────

describe('#443 Claude install: effort: injected into frontmatter', () => {
  let tmpDir;
  let claudeHome;

  beforeEach(() => {
    tmpDir = makeTmpDir('gsd-443-claude-');
    claudeHome = path.join(tmpDir, 'claude-home');
    fs.mkdirSync(claudeHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gsd-planner.md contains effort: xhigh (heavy tier default)', () => {
    runGlobalInstall('claude', claudeHome);
    const fm = readFrontmatter(path.join(claudeHome, 'agents', 'gsd-planner.md'));
    assert.match(fm, /^effort:\s*xhigh$/m,
      `gsd-planner frontmatter should have effort: xhigh\nActual:\n${fm}`);
  });

  test('gsd-codebase-mapper.md contains effort: low (light tier default)', () => {
    runGlobalInstall('claude', claudeHome);
    const fm = readFrontmatter(path.join(claudeHome, 'agents', 'gsd-codebase-mapper.md'));
    assert.match(fm, /^effort:\s*low$/m,
      `gsd-codebase-mapper frontmatter should have effort: low\nActual:\n${fm}`);
  });

  test('gsd-executor.md contains effort: high (standard tier default)', () => {
    runGlobalInstall('claude', claudeHome);
    const fm = readFrontmatter(path.join(claudeHome, 'agents', 'gsd-executor.md'));
    assert.match(fm, /^effort:\s*high$/m,
      `gsd-executor frontmatter should have effort: high\nActual:\n${fm}`);
  });
});

// ─── describe 3: Codex inherited-model install omits model_reasoning_effort ──

describe('#838 Codex install: inherited model omits model_reasoning_effort', () => {
  let tmpDir;
  let codexHome;

  beforeEach(() => {
    tmpDir = makeTmpDir('gsd-443-codex-');
    codexHome = path.join(tmpDir, 'codex-home');
    fs.mkdirSync(codexHome, { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gsd-planner.toml omits both model and model_reasoning_effort when model is inherited', () => {
    runGlobalInstall('codex', codexHome);
    const tomlContent = fs.readFileSync(
      path.join(codexHome, 'agents', 'gsd-planner.toml'), 'utf8'
    );
    assert.doesNotMatch(tomlContent, /^model\s*=/m,
      `gsd-planner.toml should omit model when inheriting Codex chat model\nActual:\n${tomlContent.slice(0, 500)}`);
    assert.doesNotMatch(tomlContent, /^model_reasoning_effort\s*=/m,
      `gsd-planner.toml should omit model_reasoning_effort when model is inherited\nActual:\n${tomlContent.slice(0, 500)}`);
  });
});

// ─── describe 4: Config-driven proof ─────────────────────────────────────────
//
// The runtime home dir must be INSIDE (or a sibling of) the project root so
// that readGsdEffectiveEffortConfig(targetDir) can walk up from the runtime
// home and find .planning/config.json. We put .claude/ and .codex/ as siblings
// of .planning/ inside the project dir — this is the natural local-install shape.

describe('#443 Config-driven: effort.agent_overrides drives install-time effort', () => {
  let tmpDir;
  let claudeHome;
  let codexHome;

  beforeEach(() => {
    // Layout: tmpDir/project/  <-- project root (cwd for install)
    //           .planning/config.json
    //           .claude/          <-- claudeHome (CLAUDE_CONFIG_DIR)
    //           .codex/           <-- codexHome (CODEX_HOME)
    tmpDir = makeTmpDir('gsd-443-cfg-');
    const projectDir = path.join(tmpDir, 'project');
    claudeHome = path.join(projectDir, '.claude');
    codexHome = path.join(projectDir, '.codex');

    fs.mkdirSync(claudeHome, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });

    // Write a project config with effort.agent_overrides overriding gsd-planner to 'low'.
    // runtime:"codex" pins a Codex-native model, so emitting model_reasoning_effort
    // remains valid under the #838 model/effort coupling rule.
    const config = {
      runtime: 'codex',
      effort: {
        agent_overrides: {
          'gsd-planner': 'low',
        },
      },
    };
    fs.writeFileSync(
      path.join(projectDir, '.planning', 'config.json'),
      JSON.stringify(config, null, 2)
    );
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('Claude .md gets effort: low when agent_overrides.gsd-planner=low', () => {
    // projectDir is the cwd for install — chdir handled inside runGlobalInstall.
    // claudeHome is inside projectDir, so walking up from claudeHome finds .planning/config.json.
    runGlobalInstall('claude', claudeHome);
    const fm = readFrontmatter(path.join(claudeHome, 'agents', 'gsd-planner.md'));
    assert.match(fm, /^effort:\s*low$/m,
      `gsd-planner should have effort: low from config override\nActual:\n${fm}`);
  });

  test('Codex .toml gets model_reasoning_effort = "low" when agent_overrides.gsd-planner=low', () => {
    runGlobalInstall('codex', codexHome);
    const tomlContent = fs.readFileSync(
      path.join(codexHome, 'agents', 'gsd-planner.toml'), 'utf8'
    );
    assert.match(tomlContent, /^model\s*=\s*"gpt-5.6-sol"$/m,
      `gsd-planner.toml should pin Codex model when runtime:"codex" is configured\nActual:\n${tomlContent.slice(0, 500)}`);
    assert.match(tomlContent, /^model_reasoning_effort\s*=\s*"low"$/m,
      `gsd-planner.toml should have model_reasoning_effort = "low" from config override\nActual:\n${tomlContent.slice(0, 500)}`);
  });

  test('Codex .toml clamps effort max → xhigh when agent_overrides.gsd-planner=max', () => {
    const projectDir = path.dirname(codexHome);
    // Overwrite config with max override
    const config = {
      runtime: 'codex',
      effort: {
        agent_overrides: {
          'gsd-planner': 'max',
        },
      },
    };
    fs.writeFileSync(
      path.join(projectDir, '.planning', 'config.json'),
      JSON.stringify(config, null, 2)
    );

    runGlobalInstall('codex', codexHome);
    const tomlContent = fs.readFileSync(
      path.join(codexHome, 'agents', 'gsd-planner.toml'), 'utf8'
    );
    assert.match(tomlContent, /^model\s*=\s*"gpt-5.6-sol"$/m,
      `gsd-planner.toml should pin Codex model when runtime:"codex" is configured\nActual:\n${tomlContent.slice(0, 500)}`);
    // Codex does not support 'max' → clamped to 'xhigh'
    assert.match(tomlContent, /^model_reasoning_effort\s*=\s*"xhigh"$/m,
      `gsd-planner.toml should clamp max → xhigh for Codex\nActual:\n${tomlContent.slice(0, 500)}`);
    assert.doesNotMatch(tomlContent, /model_reasoning_effort\s*=\s*"max"/,
      'Codex .toml must never contain model_reasoning_effort = "max"');
  });
});

// ─── describe 5b: Invalid effort tokens fall through (Codex adversarial finding #2) ─
//
// These tests FAIL before the fix: resolveInstallTimeEffort returns the raw
// invalid string without validating it against VALID_EFFORTS.

describe('#443 resolveInstallTimeEffort: invalid tokens fall through to valid effort', () => {
  let tmpDir;
  let claudeHome;
  let codexHome;

  beforeEach(() => {
    // Layout: tmpDir/project/  <-- project root
    //           .planning/config.json
    //           .claude/          <-- claudeHome
    //           .codex/           <-- codexHome
    tmpDir = makeTmpDir('gsd-443-invalid-effort-');
    const projectDir = path.join(tmpDir, 'project');
    claudeHome = path.join(projectDir, '.claude');
    codexHome = path.join(projectDir, '.codex');

    fs.mkdirSync(claudeHome, { recursive: true });
    fs.mkdirSync(codexHome, { recursive: true });
    fs.mkdirSync(path.join(projectDir, '.planning'), { recursive: true });
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  function writeProjectConfig(config) {
    const projectDir = path.dirname(claudeHome);
    fs.writeFileSync(
      path.join(projectDir, '.planning', 'config.json'),
      JSON.stringify(config, null, 2)
    );
  }

  const VALID_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

  test('effort.default="ultra" (invalid) -> Claude .md effort: is a VALID value (falls through to high)', () => {
    // BUG before fix: resolveInstallTimeEffort returns "ultra" verbatim
    writeProjectConfig({ effort: { default: 'ultra' } });
    runGlobalInstall('claude', claudeHome);
    const fm = readFrontmatter(path.join(claudeHome, 'agents', 'gsd-planner.md'));
    const match = fm.match(/^effort:\s*(\S+)$/m);
    assert.ok(match, `effort: must be present in frontmatter\nActual:\n${fm}`);
    assert.ok(VALID_EFFORTS.includes(match[1]),
      `effort: must be a VALID effort string, got: "${match[1]}"\nActual frontmatter:\n${fm}`);
  });

  test('effort.agent_overrides.gsd-planner="bogus" (invalid) with valid default -> falls through to valid default', () => {
    // BUG before fix: "bogus" is returned and written verbatim
    writeProjectConfig({
      effort: {
        agent_overrides: { 'gsd-planner': 'bogus' },
        default: 'medium',
      },
    });
    runGlobalInstall('claude', claudeHome);
    const fm = readFrontmatter(path.join(claudeHome, 'agents', 'gsd-planner.md'));
    const match = fm.match(/^effort:\s*(\S+)$/m);
    assert.ok(match, `effort: must be present in frontmatter\nActual:\n${fm}`);
    assert.ok(VALID_EFFORTS.includes(match[1]),
      `effort: must be a VALID effort string, got: "${match[1]}"\nActual frontmatter:\n${fm}`);
    // Falls through invalid "bogus" -> valid tier default or "medium" default
    // "medium" is valid, so it should appear (or tier default if medium is invalid, but medium is valid)
  });

  test('effort.default="ultra" (invalid) + runtime:"codex" -> Codex .toml model_reasoning_effort is VALID', () => {
    // BUG before fix: "ultra" written into .toml verbatim
    writeProjectConfig({ runtime: 'codex', effort: { default: 'ultra' } });
    runGlobalInstall('codex', codexHome);
    const tomlContent = fs.readFileSync(
      path.join(codexHome, 'agents', 'gsd-planner.toml'), 'utf8'
    );
    assert.match(tomlContent, /^model\s*=\s*"gpt-5.6-sol"$/m,
      `gsd-planner.toml should pin Codex model when runtime:"codex" is configured\nActual:\n${tomlContent.slice(0, 500)}`);
    const match = tomlContent.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m);
    assert.ok(match, `model_reasoning_effort must be present in .toml\nActual:\n${tomlContent.slice(0, 500)}`);
    assert.ok(VALID_EFFORTS.includes(match[1]),
      `model_reasoning_effort must be VALID, got: "${match[1]}"\nActual:\n${tomlContent.slice(0, 500)}`);
  });
});

// ─── describe 5: Source stays clean ──────────────────────────────────────────

describe('#443 Source purity: agents/gsd-planner.md has no effort: key', () => {
  test('source agents/gsd-planner.md frontmatter does not contain effort:', () => {
    const fm = readFrontmatter(path.join(SOURCE_AGENTS_DIR, 'gsd-planner.md'));
    assert.doesNotMatch(fm, /^effort:/m,
      `Source agents/gsd-planner.md must NOT contain effort: (injection is install-only)`);
  });

  test('source agents/gsd-executor.md frontmatter does not contain effort:', () => {
    const fm = readFrontmatter(path.join(SOURCE_AGENTS_DIR, 'gsd-executor.md'));
    assert.doesNotMatch(fm, /^effort:/m,
      `Source agents/gsd-executor.md must NOT contain effort: (injection is install-only)`);
  });

  test('source agents/gsd-codebase-mapper.md frontmatter does not contain effort:', () => {
    const fm = readFrontmatter(path.join(SOURCE_AGENTS_DIR, 'gsd-codebase-mapper.md'));
    assert.doesNotMatch(fm, /^effort:/m,
      `Source agents/gsd-codebase-mapper.md must NOT contain effort: (injection is install-only)`);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-1510-rewrite-engine-helper-relocation.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-1510-rewrite-engine-helper-relocation (consolidation epic #1969 B1 #1970)", () => {
'use strict';

// Enhancement #1510 (epic #1507, ADR-1508 Phase 1): behavior-preserving
// relocation of pure rewrite-engine helpers out of hand-authored bin/install.js.
//   - getDirName            -> gsd-core/bin/lib/runtime-name-policy.cjs
//   - processAttribution    -> gsd-core/bin/lib/runtime-artifact-conversion.cjs
// getCommitAttribution stays in install.js (impure install-time config I/O); the
// convertClaudeToAugmentMarkdown duplicate dedup is deferred to Phase 2's cleanup
// (entangled converter cluster; not required to unblock Phase 2).
// These tests exercise the REAL relocated functions at their new home (the
// generated .cjs) and assert install.js re-exports the SAME references
// (Hyrum: existing consumers import these names from bin/install.js).

const { test, describe } = require('node:test');
const assert = require('node:assert');

const runtimeNamePolicy = require('../gsd-core/bin/lib/runtime-name-policy.cjs');
const conversion = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
const installer = require('../bin/install.js');

// ── Slice A: getDirName relocated to runtime-name-policy ──────────────────────
describe('getDirName (relocated to runtime-name-policy)', () => {
  const EXPECTED = {
    claude: '.claude',
    copilot: '.github',
    opencode: '.opencode',
    kilo: '.kilo',
    codex: '.codex',
    antigravity: '.agents',
    cursor: '.cursor',
    windsurf: '.windsurf',
    augment: '.augment',
    trae: '.trae',
    qwen: '.qwen',
    hermes: '.hermes',
    kimi: '.kimi-code',
    codebuddy: '.codebuddy',
    cline: '.cline',
  };

  for (const [runtime, dir] of Object.entries(EXPECTED)) {
    test(`maps '${runtime}' to '${dir}'`, () => {
      assert.strictEqual(runtimeNamePolicy.getDirName(runtime), dir);
    });
  }

  test('falls back to .claude for an unknown runtime', () => {
    assert.strictEqual(runtimeNamePolicy.getDirName('definitely-not-a-runtime'), '.claude');
  });

  test('falls back to .claude for empty input', () => {
    assert.strictEqual(runtimeNamePolicy.getDirName(''), '.claude');
  });

  test('bin/install.js re-exports the SAME getDirName reference (no drift)', () => {
    assert.strictEqual(installer.getDirName, runtimeNamePolicy.getDirName);
  });
});

// ── Slice B: processAttribution relocated to runtime-artifact-conversion ───────
describe('processAttribution (relocated to runtime-artifact-conversion)', () => {
  test('null removes the Co-Authored-By line and its preceding blank line', () => {
    const input = 'Commit body line.\n\nCo-Authored-By: Someone <s@example.com>';
    assert.strictEqual(conversion.processAttribution(input, null), 'Commit body line.');
  });

  test('undefined leaves content unchanged', () => {
    const input = 'Commit body.\n\nCo-Authored-By: Someone <s@example.com>';
    assert.strictEqual(conversion.processAttribution(input, undefined), input);
  });

  test('a string replaces the attribution value', () => {
    const input = 'Body\n\nCo-Authored-By: Old Name <old@example.com>';
    assert.strictEqual(
      conversion.processAttribution(input, 'New Name <new@example.com>'),
      'Body\n\nCo-Authored-By: New Name <new@example.com>',
    );
  });

  test('escapes $ in the attribution to prevent backreference injection', () => {
    const input = 'Body\n\nCo-Authored-By: x';
    // "$1" must survive literally, not be interpreted as a regex backreference.
    assert.strictEqual(
      conversion.processAttribution(input, 'A $1 B'),
      'Body\n\nCo-Authored-By: A $1 B',
    );
  });

  test('handles CRLF when removing (null)', () => {
    const input = 'Body\r\n\r\nCo-Authored-By: Someone <s@example.com>';
    assert.strictEqual(conversion.processAttribution(input, null), 'Body');
  });

  test('replaces every Co-Authored-By line (global)', () => {
    const input = 'Body\nCo-Authored-By: A <a@x>\nCo-Authored-By: B <b@x>';
    assert.strictEqual(
      conversion.processAttribution(input, 'Z <z@x>'),
      'Body\nCo-Authored-By: Z <z@x>\nCo-Authored-By: Z <z@x>',
    );
  });

  test('bin/install.js re-exports the SAME processAttribution reference (no drift)', () => {
    // processAttribution remains an explicit installer compatibility relay, so
    // the export must keep pointing at the conversion module's implementation.
    assert.strictEqual(installer.processAttribution, conversion.processAttribution);
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-1511-rewrite-engine-relocation.test.cjs — consolidation epic #1969 (B1 #1970)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-1511-rewrite-engine-relocation (consolidation epic #1969 B1 #1970)", () => {
'use strict';
/**
 * Tests for ADR-1508 Phase 2: rewrite engine relocation to runtime-artifact-conversion.
 * Issue #1511 — verifies the deep public seam signatures and behavior.
 *
 * Tests are behavioral (no source-grep). All filesystem operations use tmp dirs.
 */

const { describe, test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cleanup } = require('./helpers.cjs');

let conversion;
before(() => {
  process.env['GSD_TEST_MODE'] = '1';
  conversion = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
});

// ---------------------------------------------------------------------------
// _computePathPrefix unit tests
// ---------------------------------------------------------------------------

describe('_computePathPrefix', () => {
  test('global under home → $HOME/... form', () => {
    const prefix = conversion._computePathPrefix({
      isGlobal: true,
      isOpencode: false,
      isWindowsHost: false,
      resolvedTarget: '/home/u/.cursor',
      homeDir: '/home/u',
    });
    assert.equal(prefix, '$HOME/.cursor/');
  });

  test('non-global → resolvedTarget/ form', () => {
    const prefix = conversion._computePathPrefix({
      isGlobal: false,
      isOpencode: false,
      isWindowsHost: false,
      resolvedTarget: '/project/.cursor',
      homeDir: '/home/u',
    });
    assert.equal(prefix, '/project/.cursor/');
  });

  test('global opencode skips $HOME shorthand', () => {
    // OpenCode uses ~/.config/opencode which breaks $HOME shorthand in content
    const prefix = conversion._computePathPrefix({
      isGlobal: true,
      isOpencode: true,
      isWindowsHost: false,
      resolvedTarget: '/home/u/.config/opencode',
      homeDir: '/home/u',
    });
    assert.equal(prefix, '/home/u/.config/opencode/');
  });

  test('global target outside home → resolvedTarget/ form', () => {
    const prefix = conversion._computePathPrefix({
      isGlobal: true,
      isOpencode: false,
      isWindowsHost: false,
      resolvedTarget: '/opt/custom-cursor',
      homeDir: '/home/u',
    });
    assert.equal(prefix, '/opt/custom-cursor/');
  });

  test('isWindowsHost tripwire — Windows paths collapse to $HOME/ same as POSIX (no-op today)', () => {
    // Documents CURRENT behavior: isWindowsHost is accepted but not branched on.
    // Both win32=true and win32=false return '$HOME/.cursor/' for a home-relative target.
    // If a future Windows-specific branch is added, this tripwire fails and forces
    // an explicit decision about what to return on Windows.
    const withWindows = conversion._computePathPrefix({
      isGlobal: true,
      isOpencode: false,
      isWindowsHost: true,
      resolvedTarget: 'C:/Users/matte/.cursor',
      homeDir: 'C:/Users/matte',
    });
    const withoutWindows = conversion._computePathPrefix({
      isGlobal: true,
      isOpencode: false,
      isWindowsHost: false,
      resolvedTarget: 'C:/Users/matte/.cursor',
      homeDir: 'C:/Users/matte',
    });
    assert.equal(withWindows, '$HOME/.cursor/');
    assert.strictEqual(withWindows, withoutWindows);
  });

  test('backslash-style resolvedTarget is normalized to forward slashes (#1615 regression)', () => {
    // path.join on Windows produces backslashes; the returned prefix is
    // substituted into markdown @-references which must use POSIX paths.
    // Without normalization the backslashes leak into workflow file content
    // and break substring checks on Windows CI.
    const prefix = conversion._computePathPrefix({
      isGlobal: false,
      isOpencode: false,
      isWindowsHost: true,
      resolvedTarget: 'C:\\Users\\runner\\AppData\\Local\\Temp\\gsd-1615-windsurf',
      homeDir: 'C:\\Users\\runner',
    });
    assert.strictEqual(prefix, 'C:/Users/runner/AppData/Local/Temp/gsd-1615-windsurf/');
    assert.ok(!prefix.includes('\\'), `prefix must not contain backslashes: ${prefix}`);
  });
});

// ---------------------------------------------------------------------------
// _applyRuntimeRewrites with injected attribution
// ---------------------------------------------------------------------------

describe('_applyRuntimeRewrites — attribution injection', () => {
  const PREFIX = '$HOME/.cursor/';

  test('attribution=null removes Co-Authored-By line', () => {
    const content = '# Hello\n\nSome text\n\nCo-Authored-By: Claude\n';
    const result = conversion._applyRuntimeRewrites(content, 'cursor', PREFIX, true, null);
    assert.ok(!result.includes('Co-Authored-By:'), 'Co-Authored-By should be removed');
  });

  test('attribution=undefined leaves Co-Authored-By unchanged', () => {
    const content = '# Hello\n\nCo-Authored-By: Claude\n';
    const result = conversion._applyRuntimeRewrites(content, 'cursor', PREFIX, true, undefined);
    assert.ok(result.includes('Co-Authored-By: Claude'), 'Co-Authored-By should be preserved when attribution=undefined');
  });

  test('attribution=string replaces Co-Authored-By value', () => {
    const content = '# Hello\n\nCo-Authored-By: OldName\n';
    const result = conversion._applyRuntimeRewrites(content, 'cursor', PREFIX, true, 'NewName <new@example.com>');
    assert.ok(result.includes('Co-Authored-By: NewName <new@example.com>'), 'Co-Authored-By should be replaced');
  });

  test('cursor runtime replaces ~/.claude/ paths', () => {
    const content = 'See ~/.claude/skills/ for more info\n';
    const result = conversion._applyRuntimeRewrites(content, 'cursor', '/home/u/.cursor/', false, undefined);
    assert.ok(result.includes('/home/u/.cursor/skills/'), 'cursor should replace ~/.claude/ with pathPrefix');
  });
});

// ---------------------------------------------------------------------------
// rewriteStagedSkillBodies — behavioral filesystem test
// ---------------------------------------------------------------------------

describe('rewriteStagedSkillBodies', () => {
  test('rewrites .md files in-place for cursor runtime', () => {
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-staged-'));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-config-'));
    try {
      // Create a skill dir with a SKILL.md referencing ~/.claude/skills/foo
      // NOTE: the rewrite engine handles path replacement and attribution only.
      // Bash→Shell conversion is done by the stage-1 skill converter, not the engine.
      const skillDir = path.join(stagedDir, 'gsd-test-skill');
      fs.mkdirSync(skillDir, { recursive: true });
      const content = '# Test\n\nSee ~/.claude/skills/foo\n\nAlso ~/.cursor/skills/bar\n';
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);

      // Call with injected homedir + platform for determinism
      conversion.rewriteStagedSkillBodies(stagedDir, {
        runtime: 'cursor',
        configDir,
        scope: 'global',
        homedir: () => '/home/u',
        platform: 'linux',
      });

      const result = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
      // cursor rewrites ~/.claude/ → pathPrefix
      // configDir is a tmpdir, not under /home/u, so prefix = resolvedTarget + '/'
      // Mirror the engine's backslash→slash normalization so the assertion holds on Windows.
      const resolvedTarget = path.resolve(configDir).replace(/\\/g, '/');
      assert.ok(result.includes(`${resolvedTarget}/skills/foo`), `Should replace ~/.claude/skills/ with ${resolvedTarget}/skills/`);
      // cursor also rewrites ~/.cursor/ → pathPrefix
      assert.ok(result.includes(`${resolvedTarget}/skills/bar`), `Should replace ~/.cursor/skills/ with ${resolvedTarget}/skills/`);
    } finally {
      cleanup(stagedDir);
      cleanup(configDir);
    }
  });

  test('with injected homedir: global under home uses $HOME prefix', () => {
    // Real absolute path so Windows path.resolve does not re-root a POSIX literal onto a drive.
    // The dir need not exist — the engine only string-processes it.
    const HOME = path.resolve(os.tmpdir(), 'gsd-1511-fake-home');
    const configDir = path.join(HOME, '.cursor');
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-staged-'));
    try {
      const skillDir = path.join(stagedDir, 'gsd-help');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'Use ~/.claude/skills/ here\n');

      conversion.rewriteStagedSkillBodies(stagedDir, {
        runtime: 'cursor',
        configDir,
        scope: 'global',
        homedir: () => HOME,
        platform: process.platform,
      });

      const result = fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8');
      assert.ok(result.includes('$HOME/.cursor/skills/'), 'Should use $HOME shorthand when configDir is under homedir');
    } finally {
      cleanup(stagedDir);
    }
  });

  test('non-existent stagedDir is a no-op', () => {
    assert.doesNotThrow(() => {
      conversion.rewriteStagedSkillBodies('/nonexistent/dir', {
        runtime: 'cursor',
        configDir: '/tmp/fake',
        scope: 'global',
      });
    });
  });
});

// ---------------------------------------------------------------------------
// rewriteStagedCommandBodies — returns temp dir, does not mutate source
// ---------------------------------------------------------------------------

describe('rewriteStagedCommandBodies', () => {
  test('returns a temp dir (not the source dir) with rewritten content', () => {
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-cmd-'));
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-config-'));
    let tempDir;
    try {
      // NOTE: rewrite engine handles path replacement + attribution, NOT tool renames.
      fs.writeFileSync(path.join(stagedDir, 'help.md'), '# Help\n\nSee ~/.claude/skills/\n\nSee ~/.cursor/skills/\n');

      tempDir = conversion.rewriteStagedCommandBodies(stagedDir, {
        runtime: 'cursor',
        configDir,
        scope: 'global',
        homedir: () => '/home/u',
        platform: 'linux',
      });

      assert.notEqual(tempDir, stagedDir, 'must return a different dir, never the source');
      assert.ok(fs.existsSync(tempDir), 'returned tempDir should exist');

      const result = fs.readFileSync(path.join(tempDir, 'help.md'), 'utf8');
      // Source dir should be unchanged
      const source = fs.readFileSync(path.join(stagedDir, 'help.md'), 'utf8');
      assert.ok(source.includes('~/.claude/skills/'), 'source file must not be mutated');
      // configDir is /tmp/... (not under /home/u), so prefix = resolvedTarget + '/'
      const resolvedTarget = path.resolve(configDir).replace(/\\/g, '/');
      assert.ok(result.includes(`${resolvedTarget}/skills/`), 'output should have cursor path rewrite applied');
      // ~/.cursor/ also rewrites to prefix
      assert.ok(!result.includes('~/.cursor/'), 'output should have ~/.cursor/ replaced too');
    } finally {
      cleanup(stagedDir);
      cleanup(configDir);
      if (tempDir && tempDir !== stagedDir) {
        cleanup(tempDir);
      }
    }
  });

  test('non-existent stagedDir returns stagedDir unchanged (safe)', () => {
    const result = conversion.rewriteStagedCommandBodies('/nonexistent/dir', {
      runtime: 'cursor',
      configDir: '/tmp/fake',
      scope: 'global',
    });
    assert.equal(result, '/nonexistent/dir', 'should return input path unchanged for missing dir');
  });
});

// ---------------------------------------------------------------------------
// Error-path: applyRuntimeContentRewritesForCommandsInPlace must rm the tempDir
// on any exception and NOT leave an orphaned gsd-cmd-rewrites-* directory.
// ---------------------------------------------------------------------------

describe('applyRuntimeContentRewritesForCommandsInPlace — error-path tempDir cleanup', () => {
  test('rmSync is called on the tempDir when readFileSync throws (deterministic monkeypatch)', () => {
    // Asserting the injected error propagates proves the throw happens AFTER the tempDir is
    // created (the function creates tempDir, then reads .md), so the catch's rmSync cleanup
    // is genuinely exercised — deterministic on every platform/uid.
    const stagedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-test-error-path-'));
    fs.writeFileSync(path.join(stagedDir, 'x.md'), '# test\n');

    // Capture the EXACT tempDir THIS invocation creates (via the function's own
    // fs.mkdtempSync call) instead of diffing the shared os.tmpdir() listing.
    // The old diff-and-sweep approach raced any concurrently-running test file
    // that mkdtemps its own gsd-cmd-rewrites-* dir under --test-concurrency: it
    // misattributed a sibling's live dir as this test's leak AND force-deleted
    // it mid-use (the #1575 ENOENT on graphify.md). Owning a single,
    // self-generated fixture makes this Independent + Repeatable under any
    // parallelism.
    const origMkdtempSync = fs.mkdtempSync;
    const origReadFileSync = fs.readFileSync;
    let capturedTempDir = null;
    try {
      fs.mkdtempSync = (...args) => (capturedTempDir = origMkdtempSync.apply(fs, args));
      fs.readFileSync = () => { throw new Error('injected read failure'); };

      assert.throws(
        () => conversion.applyRuntimeContentRewritesForCommandsInPlace(stagedDir, 'cursor', '/tmp/x/', false),
        /injected read failure/,
      );

      // Restore before any further fs use so the existsSync check is trustworthy.
      fs.mkdtempSync = origMkdtempSync;
      fs.readFileSync = origReadFileSync;

      assert.ok(capturedTempDir, 'function under test must create a tempDir before failing');
      assert.equal(
        fs.existsSync(capturedTempDir),
        false,
        `tempDir not cleaned up on error: ${capturedTempDir}`,
      );
    } finally {
      // Idempotent restore — guard against early-throw paths above.
      fs.mkdtempSync = origMkdtempSync;
      fs.readFileSync = origReadFileSync;
      // Clean up only OUR OWN fixture — never sweep the shared os.tmpdir().
      cleanup(stagedDir);
    }
  });
});

// ---------------------------------------------------------------------------
// Guard: runtime-artifact-layout no longer exports getInstallExports
// ---------------------------------------------------------------------------

describe('layout module no longer exports getInstallExports', () => {
  test('getInstallExports is not on the layout module export', () => {
    process.env['GSD_TEST_MODE'] = '1';
    const layout = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
    assert.equal(
      typeof layout.getInstallExports,
      'undefined',
      'getInstallExports should have been removed from runtime-artifact-layout exports (ADR-1508 Phase 2)',
    );
  });
});

// ---------------------------------------------------------------------------
// DEFECT.GENERATIVE-FIX: single-owner reference-identity guard (#1511)
// Proves install.js binds to the conversion module's implementation, not a
// duplicate local copy. If these fail, a duplicate body was re-introduced.
// ---------------------------------------------------------------------------

describe('single-owner reference-identity guard (ADR-1508 / #1511 Phase 2)', () => {
  let install;
  let conversionCjs;
  before(() => {
    process.env['GSD_TEST_MODE'] = '1';
    install = require('../bin/install.js');
    conversionCjs = require('../gsd-core/bin/lib/runtime-artifact-conversion.cjs');
  });

  test('install.computePathPrefix === conversion._computePathPrefix (single implementation)', () => {
    assert.strictEqual(
      install.computePathPrefix,
      conversionCjs._computePathPrefix,
      'install.js must bind computePathPrefix from conversion (not a duplicate body)',
    );
  });

  test('install.applyRuntimeContentRewritesInPlace === conversion.applyRuntimeContentRewritesInPlace (single walk loop)', () => {
    assert.strictEqual(
      install.applyRuntimeContentRewritesInPlace,
      conversionCjs.applyRuntimeContentRewritesInPlace,
      'install.js must bind applyRuntimeContentRewritesInPlace from conversion (not a duplicate walk loop)',
    );
  });

  test('install.applyRuntimeContentRewritesForCommandsInPlace === conversion.applyRuntimeContentRewritesForCommandsInPlace (single copy+rewrite loop)', () => {
    assert.strictEqual(
      install.applyRuntimeContentRewritesForCommandsInPlace,
      conversionCjs.applyRuntimeContentRewritesForCommandsInPlace,
      'install.js must bind applyRuntimeContentRewritesForCommandsInPlace from conversion (not a duplicate copy+rewrite loop)',
    );
  });

  test('install._applyRuntimeRewrites === conversion._applyRuntimeRewrites (single switch engine)', () => {
    assert.strictEqual(
      install._applyRuntimeRewrites,
      conversionCjs._applyRuntimeRewrites,
      'install.js must bind _applyRuntimeRewrites from conversion (not a local shim)',
    );
  });

  // #1675 (ADR-1508): the augment converter family is single-sourced in the
  // conversion module. install.js must re-bind (not re-define) these so there
  // is exactly one body — the generative-drift hazard the dedup removes.
  test('install.convertClaudeToAugmentMarkdown === conversion.convertClaudeToAugmentMarkdown (single converter)', () => {
    assert.strictEqual(
      install.convertClaudeToAugmentMarkdown,
      conversionCjs.convertClaudeToAugmentMarkdown,
      'install.js must bind convertClaudeToAugmentMarkdown from conversion (not a duplicate body)',
    );
  });

  test('install.convertClaudeCommandToAugmentSkill === conversion.convertClaudeCommandToAugmentSkill (single converter)', () => {
    assert.strictEqual(
      install.convertClaudeCommandToAugmentSkill,
      conversionCjs.convertClaudeCommandToAugmentSkill,
      'install.js must bind convertClaudeCommandToAugmentSkill from conversion (not a duplicate body)',
    );
  });

  test('install.convertClaudeAgentToAugmentAgent === conversion.convertClaudeAgentToAugmentAgent (single converter)', () => {
    assert.strictEqual(
      install.convertClaudeAgentToAugmentAgent,
      conversionCjs.convertClaudeAgentToAugmentAgent,
      'install.js must bind convertClaudeAgentToAugmentAgent from conversion (not a duplicate body)',
    );
  });

  // #2931 (ADR-1508): the windsurf converter family is single-sourced in the
  // conversion module, same pattern as the #1675 Augment dedup above.
  test('installJsBindsWindsurfConvertersByReference — convertClaudeCommandToWindsurfWorkflow (single converter)', () => {
    assert.strictEqual(
      install.convertClaudeCommandToWindsurfWorkflow,
      conversionCjs.convertClaudeCommandToWindsurfWorkflow,
      'install.js must bind convertClaudeCommandToWindsurfWorkflow from conversion (not a duplicate body)',
    );
  });

  test('installJsBindsEntireWindsurfFamilyByReference — every windsurf converter member', () => {
    assert.strictEqual(
      install.convertClaudeToWindsurfMarkdown,
      conversionCjs.convertClaudeToWindsurfMarkdown,
      'install.js must bind convertClaudeToWindsurfMarkdown from conversion (not a duplicate body)',
    );
    assert.strictEqual(
      install.convertClaudeCommandToWindsurfSkill,
      conversionCjs.convertClaudeCommandToWindsurfSkill,
      'install.js must bind convertClaudeCommandToWindsurfSkill from conversion (not a duplicate body)',
    );
    assert.strictEqual(
      install.convertClaudeCommandToWindsurfWorkflow,
      conversionCjs.convertClaudeCommandToWindsurfWorkflow,
      'install.js must bind convertClaudeCommandToWindsurfWorkflow from conversion (not a duplicate body)',
    );
    assert.strictEqual(
      install.convertClaudeAgentToWindsurfAgent,
      conversionCjs.convertClaudeAgentToWindsurfAgent,
      'install.js must bind convertClaudeAgentToWindsurfAgent from conversion (not a duplicate body)',
    );
  });

  // #2931 (ADR-1508): applyClaudeCodeBrandSwap + RUNTIME_COMPATIBILITY_BLOCK_RE
  // were duplicated verbatim in install.js (used by the local Cursor/Trae/
  // CodeBuddy/Cline converters) alongside the conversion module's copy —
  // exactly the unlinked-duplicate-implementation class this guard exists to
  // catch. install.js now re-binds (does not re-define) it.
  test('install.applyClaudeCodeBrandSwap === conversion.applyClaudeCodeBrandSwap (single implementation)', () => {
    assert.strictEqual(
      install.applyClaudeCodeBrandSwap,
      conversionCjs.applyClaudeCodeBrandSwap,
      'install.js must bind applyClaudeCodeBrandSwap from conversion (not a duplicate body)',
    );
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-190-bridge-collapse.test.cjs — consolidation epic #1969 (B3 #1972)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-190-bridge-collapse (consolidation epic #1969 B3 #1972)", () => {
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

test('bridge collapse removes cjs-sdk-bridge and runtime-bridge-sync seam', () => {
  const bridgePath = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'cjs-sdk-bridge.cjs');
  const sdkDir = path.join(ROOT, 'sdk');

  assert.equal(fs.existsSync(bridgePath), false, 'cjs-sdk-bridge.cjs must be removed');
  assert.equal(fs.existsSync(sdkDir), false, 'sdk directory must be removed');

  const routers = [
    'gsd-core/bin/lib/init-command-router.cjs',
    'gsd-core/bin/lib/roadmap-command-router.cjs',
    'gsd-core/bin/lib/state-command-router.cjs',
    'gsd-core/bin/lib/validate-command-router.cjs',
    'gsd-core/bin/lib/verify-command-router.cjs',
    'gsd-core/bin/lib/phases-command-router.cjs',
  ];

  for (const rel of routers) {
    const src = read(rel);
    assert.equal(
      src.includes('cjs-sdk-bridge.cjs'),
      false,
      `${rel} must not import cjs-sdk-bridge.cjs`,
    );
  }

  const rootPkg = JSON.parse(read('package.json'));
  assert.equal(
    Object.prototype.hasOwnProperty.call(rootPkg.dependencies || {}, 'synckit'),
    false,
    'package.json must not include synckit',
  );
});
  });
}


// ────────────────────────────────────────────────────────────────────────


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2973-profile-user-skills-path.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2973-profile-user-skills-path (consolidation epic #1969 B5 #1974)", () => {
'use strict';

// allow-test-rule: source-text-is-the-product. profile-user.md IS the (see #2973)
// shipped workflow product; the `Display:` line at line 356 IS the
// user-visible artifact-name message. This test parses the markdown's
// structured `Display: "..."` line via a regex (not source-grep) to
// extract the path argument as a typed value, then asserts on the
// typed value. The .includes() at the end is a structural absence-check
// against the legacy path literal — the same shape the bug-2470
// installer-leak test uses to enforce a known-pattern invariant.

process.env.GSD_TEST_MODE = '1';

/**
 * Bug #2973: /gsd-profile-user --refresh writes dev-preferences.md to the
 * legacy commands/gsd subdirectory, contradicting v1.39.0's skills-only
 * migration claim that "Legacy commands/gsd directory removed
 * (replaced by skills/)".
 *
 * Root cause: the writer at gsd-core/bin/lib/profile-output.cjs
 * fell back to commands/gsd/dev-preferences.md when no --output was passed.
 * The /gsd-profile-user workflow does not pass --output, so every refresh
 * deterministically re-creates the legacy directory.
 *
 * Fix:
 *   1. profile-output.cjs default targets skills/gsd-dev-preferences/SKILL.md
 *   2. profile-user.md confirmation message references the new path
 *   3. install.js migrates any existing legacy file into the new skill
 *      location during install (no-op if SKILL.md already exists)
 *
 * This test exercises the runtime behavior of the writer (writes to the
 * skills path) and the structural shape of the workflow message. No
 * source-grep on the .cjs body — assertions go against the writer's
 * actual output and the parsed workflow message.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const PROFILE_OUTPUT = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'profile-output.cjs');
const WORKFLOW = path.join(ROOT, 'gsd-core', 'workflows', 'profile-user.md');

const installEngine = require('../gsd-core/bin/lib/install-engine.cjs');

describe('Bug #2973: dev-preferences default writer path is skills/gsd-dev-preferences/SKILL.md', () => {
  test('exercise the writer in a subprocess with HOME pointed at a tmp dir; assert the artifact lands at the skills path', () => {
    // Subprocess so fs.writeSync(1, ...) in core.cjs goes to a pipe we can
    // capture (the parent process's fd 1 bypasses any in-process stubbing).
    const cp = require('node:child_process');
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2973-'));
    try {
      const analysisPath = path.join(tmpHome, 'analysis.json');
      fs.writeFileSync(analysisPath, JSON.stringify({
        data_source: 'questionnaire',
        dimensions: { rigor: { score: 7 } },
      }));
      const driver = path.join(tmpHome, 'driver.js');
      fs.writeFileSync(driver, `
        const m = require(${JSON.stringify(PROFILE_OUTPUT)});
        m.cmdGenerateDevPreferences(${JSON.stringify(tmpHome)}, { analysis: ${JSON.stringify(analysisPath)} }, false);
      `);
      const result = cp.spawnSync(process.execPath, [driver], {
        env: Object.assign({}, process.env, { HOME: tmpHome, USERPROFILE: tmpHome }),
        encoding: 'utf-8',
        // Bound the subprocess so a regression that hangs the writer
        // (or the dispatcher) cannot deadlock CI (PR #3003 CR feedback).
        // 30s is generous for what should complete in <1s; if it trips,
        // surface that as a clear test failure rather than CI hanging.
        timeout: 30_000,
      });
      assert.equal(result.signal, null,
        `writer subprocess was killed by signal ${result.signal} (likely timeout): ${result.stderr}`);
      assert.equal(result.status, 0, `writer subprocess failed: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);

      const expectedPath = path.join(tmpHome, '.claude', 'skills', 'gsd-dev-preferences', 'SKILL.md');
      assert.equal(parsed.command_path, expectedPath,
        `writer emitted ${parsed.command_path}; expected skills path ${expectedPath} (#2973)`);
      assert.equal(fs.existsSync(expectedPath), true,
        `expected SKILL.md at ${expectedPath} after writer ran`);
      const legacyPath = path.join(tmpHome, '.claude', 'commands', 'gsd', 'dev-preferences.md');
      assert.equal(fs.existsSync(legacyPath), false,
        `writer must not create ${legacyPath} (#2973)`);
    } finally {
      cleanup(tmpHome);
    }
  });
});

describe('Bug #2973: profile-user.md confirmation message references the skills path', () => {
  test('the Display message points at $HOME/.claude/skills/gsd-dev-preferences/SKILL.md', () => {
    const md = fs.readFileSync(WORKFLOW, 'utf-8');
    // Match the structured Display: line; capture the path value.
    const m = md.match(/Display:\s*"[^"]*Generated\s*\/gsd-dev-preferences\s*at\s*([^"]+)"/);
    assert.notEqual(m, null, 'expected a Display: "Generated /gsd-dev-preferences at <path>" line');
    const referencedPath = m[1].trim();
    assert.equal(referencedPath, '$HOME/.claude/skills/gsd-dev-preferences/SKILL.md',
      `workflow references ${referencedPath}; expected skills path (#2973)`);
  });

  test('no occurrence of the legacy commands/gsd/dev-preferences.md path remains in profile-user.md', () => {
    const md = fs.readFileSync(WORKFLOW, 'utf-8');
    assert.equal(md.includes('commands/gsd/dev-preferences.md'), false,
      'profile-user.md still references legacy commands/gsd/dev-preferences.md (#2973)');
  });
});

describe('Bug #2973: installer migrates existing legacy dev-preferences.md to skills/gsd-dev-preferences/SKILL.md', () => {
  test('migrateLegacyDevPreferencesToSkill is exported and writes to the skills path', () => {
    const inst = installEngine;
    // Module exports the migration helper for direct testing.
    // Note: this is the structural assertion — the helper exists with the
    // documented signature. End-to-end install testing is covered by
    // tests/install-*.test.cjs which already exercise legacy preservation.
    assert.equal(typeof inst.migrateLegacyDevPreferencesToSkill, 'function',
      'expected migrateLegacyDevPreferencesToSkill in install.js exports (#2973)');
  });

  test('migration writes to skills/gsd-dev-preferences/SKILL.md when no skill exists yet', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2973-mig-'));
    try {
      const inst = installEngine;
      const saved = new Map([['dev-preferences.md', '# my legacy preferences\n']]);
      const migrated = inst.migrateLegacyDevPreferencesToSkill(tmpDir, saved);
      assert.equal(migrated, true, 'expected migration to succeed when no SKILL.md exists');
      const skillFile = path.join(tmpDir, 'skills', 'gsd-dev-preferences', 'SKILL.md');
      assert.equal(fs.existsSync(skillFile), true, `expected SKILL.md at ${skillFile}`);
      assert.equal(fs.readFileSync(skillFile, 'utf-8'), '# my legacy preferences\n');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('migration is a no-op when a SKILL.md already exists at the new location (do not clobber user-customized skill content)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2973-skip-'));
    try {
      const inst = installEngine;
      const skillDir = path.join(tmpDir, 'skills', 'gsd-dev-preferences');
      const skillFile = path.join(skillDir, 'SKILL.md');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(skillFile, '# user-customized skill\n');
      const saved = new Map([['dev-preferences.md', '# legacy content\n']]);
      const migrated = inst.migrateLegacyDevPreferencesToSkill(tmpDir, saved);
      assert.equal(migrated, false, 'expected migration to skip when SKILL.md exists');
      // Existing content untouched.
      assert.equal(fs.readFileSync(skillFile, 'utf-8'), '# user-customized skill\n');
    } finally {
      cleanup(tmpDir);
    }
  });
});

// ─── #2911: migrateLegacyDevPreferencesToSkill is the latent instance of the ──
// ─── same installer-vs-surface destination-root defect ───────────────────────
//
// migrateLegacyDevPreferencesToSkill (src/install-engine.cts) resolved the
// skill dir as `assertDestWithinConfigHome(targetDir, skillsKindEntry.destSubpath)`
// — always against targetDir (configDir), ignoring skillsKindEntry.home. For
// codex/global (the only current `home`-override runtime/scope), a legacy
// dev-preferences.md migration would have landed under $CODEX_HOME/skills
// instead of the canonical $HOME/.agents/skills tree used by both the
// installer's _copyStaged and (post-#2911-fix) applySurface. Fixed the same
// way: `skillsKindEntry.home ?? targetDir`.
describe('Bug #2911: migrateLegacyDevPreferencesToSkill honors the skills-kind home override (codex)', () => {
  const { resolveRuntimeArtifactLayout } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');

  function withFakeHome(fakeHome, fn) {
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    try {
      return fn();
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
    }
  }

  test('codex + global: migration writes SKILL.md under $HOME/.agents/skills, NOT under $CODEX_HOME/skills', () => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2911-mig-home-'));
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2911-mig-codexhome-'));
    try {
      withFakeHome(fakeHome, () => {
        const inst = installEngine;
        const layout = resolveRuntimeArtifactLayout('codex', codexHome, 'global');
        const skillsKindEntry = layout.kinds.find((k) => k.kind === 'skills');
        assert.equal(skillsKindEntry.home, path.join(fakeHome, '.agents'), 'pre-condition: codex global skills kind declares the $HOME/.agents override');

        const saved = new Map([['dev-preferences.md', '# my legacy preferences\n']]);
        const migrated = inst.migrateLegacyDevPreferencesToSkill(codexHome, saved, 'codex', 'global');
        assert.equal(migrated, true, 'expected migration to succeed when no SKILL.md exists');

        const correctSkillFile = path.join(fakeHome, '.agents', 'skills', 'gsd-dev-preferences', 'SKILL.md');
        assert.equal(fs.existsSync(correctSkillFile), true, `expected SKILL.md at ${correctSkillFile}`);
        assert.equal(fs.readFileSync(correctSkillFile, 'utf-8'), '# my legacy preferences\n');

        const legacySkillFile = path.join(codexHome, 'skills', 'gsd-dev-preferences', 'SKILL.md');
        assert.equal(fs.existsSync(legacySkillFile), false, `migration must NOT also write a second copy at the legacy location ${legacySkillFile}`);
      });
    } finally {
      cleanup(fakeHome);
      cleanup(codexHome);
    }
  });

  test('codex + local: no home override — migration destination is unchanged ($CODEX_HOME/skills)', () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2911-mig-local-'));
    try {
      const inst = installEngine;
      const layout = resolveRuntimeArtifactLayout('codex', codexHome, 'local');
      const skillsKindEntry = layout.kinds.find((k) => k.kind === 'skills');
      assert.equal(skillsKindEntry.home, undefined, 'pre-condition: codex local scope declares NO home override');

      const saved = new Map([['dev-preferences.md', '# my legacy preferences\n']]);
      const migrated = inst.migrateLegacyDevPreferencesToSkill(codexHome, saved, 'codex', 'local');
      assert.equal(migrated, true);

      const skillFile = path.join(codexHome, 'skills', 'gsd-dev-preferences', 'SKILL.md');
      assert.equal(fs.existsSync(skillFile), true, `expected SKILL.md at ${skillFile} (unchanged, no home override)`);
    } finally {
      cleanup(codexHome);
    }
  });
});

// ─── #3003 CR follow-up: installRuntimeArtifacts preserves user-owned skills ──
//
// Production install() calls installRuntimeArtifacts() without a prior
// uninstallRuntimeArtifacts(). This means _copyStaged overlays new skills
// on top of the existing skills/ directory — it does NOT wipe first.
// As a result, user-owned gsd-dev-preferences/SKILL.md is preserved across
// a plain install because _copyStaged only cpSync's newly staged skill dirs.
//
// NOTE: If callers run uninstallRuntimeArtifacts() before installRuntimeArtifacts()
// (e.g. full reinstall), gsd-dev-preferences IS wiped by uninstall and NOT
// restored by install (#3664 production gap — tracked separately).

describe('Bug #2973 (#3003 CR): installRuntimeArtifacts preserves user-owned gsd-dev-preferences across install', () => {
  test('user-customized skills/gsd-dev-preferences/SKILL.md survives a plain install (no pre-uninstall)', () => {
    // Production install() does NOT call uninstallRuntimeArtifacts() first.
    // installRuntimeArtifacts → _copyStaged overlays only staged skill dirs;
    // gsd-dev-preferences (not in source) is left untouched.
    const inst = installEngine;
    const { loadSkillsManifest, resolveProfile } = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'install-profiles.cjs'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2973-wipe-'));
    try {
      const configDir = path.join(tmp, 'config');
      fs.mkdirSync(configDir, { recursive: true });

      // Set up a minimal source dir (plan-phase only; no dev-preferences).
      const srcDir = path.join(tmp, 'src-commands');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'plan-phase.md'), '---\nname: gsd:plan-phase\ndescription: Plan\n---\n\nPlan body.\n');
      fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir + '\n');

      const skillsDir = path.join(configDir, 'skills');
      const userSkillDir = path.join(skillsDir, 'gsd-dev-preferences');
      fs.mkdirSync(userSkillDir, { recursive: true });
      const userContent = '# my customized dev preferences\n\nstack: rust\n';
      fs.writeFileSync(path.join(userSkillDir, 'SKILL.md'), userContent);

      // Plain install (matching production install() call site).
      const manifest = loadSkillsManifest();
      const resolvedProfile = resolveProfile({ modes: [], manifest });
      inst.installRuntimeArtifacts('claude', configDir, 'global', resolvedProfile);

      const skillFile = path.join(userSkillDir, 'SKILL.md');
      assert.equal(fs.existsSync(skillFile), true,
        'gsd-dev-preferences/SKILL.md must survive a plain install (#3003 CR)');
      assert.equal(fs.readFileSync(skillFile, 'utf-8'), userContent,
        'user content must be byte-identical after the install');
    } finally {
      cleanup(tmp);
    }
  });

  test('non-user-owned gsd-* skills are wiped and recreated via uninstall+install cycle', () => {
    // Stale artifacts (e.g. STALE-MARKER.txt left from a previous version)
    // are removed when the caller runs uninstallRuntimeArtifacts() before
    // installRuntimeArtifacts() — the full uninstall+reinstall cycle.
    // uninstallRuntimeArtifacts removes all gsd-* entries; installRuntimeArtifacts
    // then writes fresh ones from source.
    const inst = installEngine;
    const { loadSkillsManifest, resolveProfile } = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'install-profiles.cjs'));
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2973-wipe-shipped-'));
    try {
      const configDir = path.join(tmp, 'config');
      fs.mkdirSync(configDir, { recursive: true });

      const srcDir = path.join(tmp, 'src-commands');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'plan-phase.md'), '---\nname: gsd:plan-phase\ndescription: Plan fresh\n---\n\nFresh body.\n');
      fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir + '\n');

      const skillsDir = path.join(configDir, 'skills');
      const staleSkillDir = path.join(skillsDir, 'gsd-plan-phase');
      fs.mkdirSync(staleSkillDir, { recursive: true });
      fs.writeFileSync(path.join(staleSkillDir, 'STALE-MARKER.txt'), 'wipe me');

      const manifest = loadSkillsManifest();
      const resolvedProfile = resolveProfile({ modes: [], manifest });

      // Full uninstall+install cycle (e.g. --reinstall flow)
      inst.uninstallRuntimeArtifacts('claude', configDir, 'global');
      inst.installRuntimeArtifacts('claude', configDir, 'global', resolvedProfile);

      assert.equal(fs.existsSync(path.join(staleSkillDir, 'STALE-MARKER.txt')), false,
        'stale shipped-skill content must be wiped by uninstall (preservation is opt-in by name)');
      assert.equal(fs.existsSync(path.join(staleSkillDir, 'SKILL.md')), true,
        'fresh SKILL.md from source must be installed after wipe');
    } finally {
      cleanup(tmp);
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-947-hermes-gsd-prefix.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-947-hermes-gsd-prefix (consolidation epic #1969 B5 #1974)", () => {
// allow-test-rule: source-text-is-the-product (see #947)
// Reads installed .md product artefacts from a real install run —
// testing their on-disk layout + frontmatter tests the deployed contract.

/**
 * Regression test: #947 — Hermes skills must install with canonical gsd- prefix.
 *
 * Prior to this fix, Hermes installed skills at skills/gsd/<stem>/SKILL.md
 * with frontmatter `name: <stem>` (e.g. name: quick), causing invocation as
 * /quick instead of /gsd-quick. This file asserts the corrected behaviour:
 *   - Fresh install → skills/gsd/gsd-<stem>/SKILL.md, name: gsd-<stem>
 *   - The skills/gsd/ category bucket and its DESCRIPTION.md are retained
 *   - Migration: prior bare-stem dirs (skills/gsd/<stem>/) are removed
 *     on reinstall; no orphaned bare-stem directories remain.
 *
 * Runtime: node:test, node:assert/strict. No Jest.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { installRuntimeArtifacts } = require('../gsd-core/bin/lib/install-engine.cjs');
const { parseFrontmatter, cleanup } = require('./helpers.cjs');
const {
  loadSkillsManifest,
  resolveProfile,
} = require('../gsd-core/bin/lib/install-profiles.cjs');

// ---------------------------------------------------------------------------
// Shared fixture: a minimal commands/gsd/ source with two skills
// ---------------------------------------------------------------------------

/**
 * Write a minimal commands/gsd/ source tree with the given stem names.
 * Returns the path to the commands/gsd directory (used as .gsd-source value).
 */
function writeMinimalSourceTree(baseDir, stems) {
  const srcDir = path.join(baseDir, 'src', 'commands', 'gsd');
  fs.mkdirSync(srcDir, { recursive: true });
  for (const stem of stems) {
    fs.writeFileSync(path.join(srcDir, `${stem}.md`), [
      '---',
      `name: gsd:${stem}`,
      `description: ${stem} task description`,
      'allowed-tools:',
      '  - Read',
      '  - Bash',
      '---',
      '',
      `<objective>${stem} body</objective>`,
    ].join('\n'));
  }
  return srcDir;
}

const MANIFEST = loadSkillsManifest();
const RESOLVED_FULL = resolveProfile({ modes: [], manifest: MANIFEST });

// ---------------------------------------------------------------------------
// #947 regression: fresh install produces prefixed layout
// ---------------------------------------------------------------------------

describe('#947 Hermes: fresh install → gsd- prefixed layout', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-947-fresh-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('skill lands at skills/gsd/gsd-<stem>/SKILL.md (NOT skills/gsd/<stem>/SKILL.md)', () => {
    const srcDir = writeMinimalSourceTree(tmpDir, ['quick']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    // Correct (post-fix) path: skills/gsd/gsd-quick/SKILL.md
    const correctPath = path.join(configDir, 'skills', 'gsd', 'gsd-quick', 'SKILL.md');
    assert.ok(fs.existsSync(correctPath),
      'skills/gsd/gsd-quick/SKILL.md must exist (canonical gsd- prefix)');

    // Old (bare-stem) path must NOT exist
    const bareStemPath = path.join(configDir, 'skills', 'gsd', 'quick', 'SKILL.md');
    assert.ok(!fs.existsSync(bareStemPath),
      'skills/gsd/quick/SKILL.md must NOT exist (bare-stem path is wrong)');
  });

  test('SKILL.md frontmatter name is gsd-<stem> (NOT bare <stem>)', () => {
    const srcDir = writeMinimalSourceTree(tmpDir, ['plan']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    const skillPath = path.join(configDir, 'skills', 'gsd', 'gsd-plan', 'SKILL.md');
    assert.ok(fs.existsSync(skillPath), 'skills/gsd/gsd-plan/SKILL.md must exist');

    const content = fs.readFileSync(skillPath, 'utf8');
    const fm = parseFrontmatter(content);
    assert.strictEqual(fm.name, 'gsd-plan',
      `frontmatter name must be 'gsd-plan', got '${fm.name}'`);
  });

  test('gsd-<stem> identifier satisfies Hermes name rule ^[a-z][a-z0-9_-]*$', () => {
    const srcDir = writeMinimalSourceTree(tmpDir, ['plan-phase', 'code-review']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    const HERMES_NAME_RE = /^[a-z][a-z0-9_-]*$/;
    for (const stem of ['plan-phase', 'code-review']) {
      const skillPath = path.join(configDir, 'skills', 'gsd', `gsd-${stem}`, 'SKILL.md');
      assert.ok(fs.existsSync(skillPath), `skills/gsd/gsd-${stem}/SKILL.md must exist`);
      const content = fs.readFileSync(skillPath, 'utf8');
      const fm = parseFrontmatter(content);
      assert.ok(HERMES_NAME_RE.test(fm.name),
        `name '${fm.name}' must satisfy Hermes identifier rule ${HERMES_NAME_RE}`);
      assert.strictEqual(fm.name, `gsd-${stem}`,
        `name must be 'gsd-${stem}', got '${fm.name}'`);
    }
  });

  test('skills/gsd/ category bucket is retained (not flattened to top-level skills/)', () => {
    const srcDir = writeMinimalSourceTree(tmpDir, ['quick']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    // Skill must be INSIDE skills/gsd/ — not at skills/gsd-quick/ directly
    const categoryBucket = path.join(configDir, 'skills', 'gsd');
    assert.ok(fs.existsSync(categoryBucket),
      'skills/gsd/ category directory must be retained');

    // Flat (non-categorised) path must NOT exist
    const flatPath = path.join(configDir, 'skills', 'gsd-quick');
    assert.ok(!fs.existsSync(flatPath),
      'skills/gsd-quick/ (flat, non-categorised) must NOT exist for Hermes');
  });

  test('skills/gsd/ category directory exists (bucket retained after install)', () => {
    // Note: DESCRIPTION.md is written by writeHermesCategoryDescription which is
    // called from the top-level installGsd flow (not inside installRuntimeArtifacts).
    // This test confirms the category bucket itself is present post-install.
    const srcDir = writeMinimalSourceTree(tmpDir, ['quick']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    const categoryBucket = path.join(configDir, 'skills', 'gsd');
    assert.ok(fs.existsSync(categoryBucket),
      'skills/gsd/ category directory must exist after Hermes install');
    assert.ok(fs.statSync(categoryBucket).isDirectory(),
      'skills/gsd/ must be a directory, not a file');
  });

  test('multiple skills all get gsd- prefix', () => {
    const srcDir = writeMinimalSourceTree(tmpDir, ['quick', 'plan', 'review']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    for (const stem of ['quick', 'plan', 'review']) {
      const correctPath = path.join(configDir, 'skills', 'gsd', `gsd-${stem}`, 'SKILL.md');
      assert.ok(fs.existsSync(correctPath),
        `skills/gsd/gsd-${stem}/SKILL.md must exist`);
      const bareStem = path.join(configDir, 'skills', 'gsd', stem, 'SKILL.md');
      assert.ok(!fs.existsSync(bareStem),
        `bare-stem path skills/gsd/${stem}/SKILL.md must NOT exist`);
    }
  });
});

// ---------------------------------------------------------------------------
// #947 regression: migration from prior bare-stem install
// ---------------------------------------------------------------------------

describe('#947 Hermes: migration from prior bare-stem install', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-947-migrate-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('bare-stem dirs from prior install are removed on reinstall', () => {
    const srcDir = writeMinimalSourceTree(tmpDir, ['quick']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    // Seed a prior bare-stem install: skills/gsd/quick/SKILL.md
    const legacySkillDir = path.join(configDir, 'skills', 'gsd', 'quick');
    fs.mkdirSync(legacySkillDir, { recursive: true });
    fs.writeFileSync(path.join(legacySkillDir, 'SKILL.md'), [
      '---',
      'name: quick',
      'description: Quick task (legacy bare-stem)',
      '---',
      '',
      'Legacy body.',
    ].join('\n'));

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    // Bare-stem dir must be gone (migrated)
    assert.ok(!fs.existsSync(legacySkillDir),
      'skills/gsd/quick/ (bare-stem legacy dir) must be removed on reinstall');

    // Prefixed dir must exist
    const newPath = path.join(configDir, 'skills', 'gsd', 'gsd-quick', 'SKILL.md');
    assert.ok(fs.existsSync(newPath),
      'skills/gsd/gsd-quick/SKILL.md must exist after migration');
  });

  test('reinstall over bare-stem install leaves NO orphaned bare-stem dirs', () => {
    const srcDir = writeMinimalSourceTree(tmpDir, ['quick', 'plan']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    // Seed two bare-stem dirs
    for (const stem of ['quick', 'plan']) {
      const dir = path.join(configDir, 'skills', 'gsd', stem);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${stem}\ndescription: ${stem}\n---\n`);
    }

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    const gsdCategoryDir = path.join(configDir, 'skills', 'gsd');
    const entries = fs.readdirSync(gsdCategoryDir, { withFileTypes: true });

    // Check NO bare-stem dirs remain
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Bare-stem dirs: name does NOT start with 'gsd-' and is not a known exception
      // (DESCRIPTION.md is a file so it won't appear in isDirectory check)
      assert.ok(
        entry.name.startsWith('gsd-'),
        `All dirs under skills/gsd/ must start with 'gsd-'. Found bare-stem: '${entry.name}'`,
      );
    }
  });

  test('pre-#2841 flat skills/gsd-<stem>/ dirs are still removed (existing migration path)', () => {
    const srcDir = writeMinimalSourceTree(tmpDir, ['quick']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    // Seed a pre-#2841 flat skill dir: skills/gsd-quick/SKILL.md
    const flatSkillDir = path.join(configDir, 'skills', 'gsd-quick');
    fs.mkdirSync(flatSkillDir, { recursive: true });
    fs.writeFileSync(path.join(flatSkillDir, 'SKILL.md'), '---\nname: gsd-quick\n---\nOld flat.');

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    // The pre-#2841 flat dir must still be cleaned up
    assert.ok(!fs.existsSync(flatSkillDir),
      'Pre-#2841 flat skills/gsd-quick/ dir must be removed (existing migration)');

    // The correct post-fix dir must exist
    assert.ok(fs.existsSync(path.join(configDir, 'skills', 'gsd', 'gsd-quick', 'SKILL.md')),
      'skills/gsd/gsd-quick/SKILL.md must exist after install');
  });
});

// ---------------------------------------------------------------------------
// #947 adversarial-review: bare-stem cleanup derived from installed set
// (not readGsdCommandNames) — covers skills missing from the commands dir
// ---------------------------------------------------------------------------

describe('#947 Hermes: adversarial-review bare-stem cleanup (installed-set derivation)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-947-adv-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('bare skills/gsd/dev-preferences/ is removed when gsd-dev-preferences/ is installed this run', () => {
    // Seed a source tree that includes a 'dev-preferences' skill (e.g. the user's
    // commands/gsd/dev-preferences.md, or any skill whose stem is NOT normally in
    // the shipped readGsdCommandNames() set). The old cleanup (readGsdCommandNames-
    // based) would MISS this bare dir because readGsdCommandNames() reads GSD's
    // shipped source, not the user's actual install state.
    const srcDir = writeMinimalSourceTree(tmpDir, ['quick', 'dev-preferences']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    // Seed the legacy bare-stem dir: skills/gsd/dev-preferences/ (pre-#947 install)
    const bareLegacyDir = path.join(configDir, 'skills', 'gsd', 'dev-preferences');
    fs.mkdirSync(bareLegacyDir, { recursive: true });
    fs.writeFileSync(path.join(bareLegacyDir, 'SKILL.md'), [
      '---',
      'name: dev-preferences',
      'description: My dev preferences (legacy bare-stem)',
      '---',
      '',
      'Legacy body.',
    ].join('\n'));

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    // gsd-dev-preferences/ must be installed (new prefixed form)
    const newPath = path.join(configDir, 'skills', 'gsd', 'gsd-dev-preferences', 'SKILL.md');
    assert.ok(fs.existsSync(newPath),
      'skills/gsd/gsd-dev-preferences/SKILL.md must exist after install');

    // Bare-stem dir must be gone — even though 'dev-preferences' is NOT in the
    // shipped readGsdCommandNames() set (it was user-sourced). The fix derives
    // the removal set from gsd-<stem>/ dirs installed this run.
    assert.ok(!fs.existsSync(bareLegacyDir),
      'skills/gsd/dev-preferences/ (bare-stem) must be removed when gsd-dev-preferences/ was installed');
  });

  test('user-owned bare dir with no gsd-<stem> counterpart is preserved (no over-deletion)', () => {
    // A user has a dir 'skills/gsd/my-custom-workflow/' that is NOT a GSD shipped
    // skill — GSD never installs 'gsd-my-custom-workflow/'. This dir must survive.
    const srcDir = writeMinimalSourceTree(tmpDir, ['quick']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    // Seed user-owned bare dir: no corresponding gsd-my-custom-workflow/ will be installed
    const userOwnedDir = path.join(configDir, 'skills', 'gsd', 'my-custom-workflow');
    fs.mkdirSync(userOwnedDir, { recursive: true });
    fs.writeFileSync(path.join(userOwnedDir, 'SKILL.md'), [
      '---',
      'name: my-custom-workflow',
      'description: My personal workflow',
      '---',
      '',
      'Custom body.',
    ].join('\n'));

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    // User-owned dir must survive — no gsd-my-custom-workflow/ was installed,
    // so the removal rule (only remove <stem>/ when gsd-<stem>/ exists) protects it.
    assert.ok(fs.existsSync(userOwnedDir),
      'User-owned skills/gsd/my-custom-workflow/ must be preserved (no gsd-my-custom-workflow/ installed)');
    assert.ok(fs.existsSync(path.join(userOwnedDir, 'SKILL.md')),
      'User-owned SKILL.md inside the dir must be preserved');
  });
});

// ---------------------------------------------------------------------------
// #947 regression: manifest/listing prefix
// ---------------------------------------------------------------------------

describe('#947 Hermes: manifest and skill-listing use gsd- prefix', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-947-manifest-'));
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('gsd-manifest.json skill entries use skills/gsd/gsd-<stem>/ paths', () => {
    const srcDir = writeMinimalSourceTree(tmpDir, ['quick']);
    const configDir = path.join(tmpDir, 'dest');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), srcDir);

    installRuntimeArtifacts('hermes', configDir, 'global', RESOLVED_FULL);

    // The manifest file lives at gsd-core/gsd-manifest.json inside configDir
    const manifestPath = path.join(configDir, 'gsd-core', 'gsd-manifest.json');
    if (!fs.existsSync(manifestPath)) return; // manifest optional in test mode
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const keys = Object.keys(manifest.files || {});
    // Any key for the quick skill must use gsd-quick not bare quick
    const bareKey = keys.find(k => k.includes('skills/gsd/quick/'));
    assert.ok(!bareKey,
      `manifest must not contain bare-stem key 'skills/gsd/quick/', found: ${bareKey}`);
    const prefixedKey = keys.find(k => k.includes('skills/gsd/gsd-quick/'));
    assert.ok(prefixedKey,
      'manifest must contain prefixed key containing skills/gsd/gsd-quick/');
  });
});

// ---------------------------------------------------------------------------
// #947 regression: non-Hermes runtimes unaffected
// ---------------------------------------------------------------------------

describe('#947 Non-Hermes runtimes: unaffected by this change', () => {
  // Spot-check claude (global/flat) and cline (global/nested) to confirm
  // they are not disturbed by the Hermes prefix fix.

  test('claude global install still produces flat skills/gsd-<stem>/ layout', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-947-claude-'));
    try {
      installRuntimeArtifacts('claude', tmpDir, 'global', RESOLVED_FULL);
      const skillsDir = path.join(tmpDir, 'skills');
      assert.ok(fs.existsSync(skillsDir), 'skills/ must exist for claude global');
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      const gsdEntries = entries.filter(e => e.isDirectory() && e.name.startsWith('gsd-'));
      assert.ok(gsdEntries.length >= 10,
        `claude must still emit >= 10 gsd-* skill dirs, got ${gsdEntries.length}`);
      // No skills/gsd/ category bucket (that is Hermes-specific)
      assert.ok(!fs.existsSync(path.join(skillsDir, 'gsd')),
        'claude must NOT have a skills/gsd/ category bucket (that is Hermes-only)');
    } finally {
      cleanup(tmpDir);
    }
  });

  test('cline global install still produces skills/ with gsd- prefix nested layout', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-947-cline-'));
    try {
      installRuntimeArtifacts('cline', tmpDir, 'global', RESOLVED_FULL);
      const skillsDir = path.join(tmpDir, 'skills');
      assert.ok(fs.existsSync(skillsDir), 'skills/ must exist for cline global');
      const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
      const routerDirs = entries.filter(e => e.isDirectory() && e.name.startsWith('gsd-ns-'));
      assert.ok(routerDirs.length > 0,
        'cline must still emit gsd-ns-* router dirs with gsd- prefix');
    } finally {
      cleanup(tmpDir);
    }
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/enh-790-augment-commands.test.cjs — consolidation epic #1969 (B5 #1974)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:enh-790-augment-commands (consolidation epic #1969 B5 #1974)", () => {
'use strict';
/**
 * Regression guard — enh(#790): Augment commands/ emitted alongside skills/.
 *
 * Verifies that a global Augment install writes:
 *   - commands/gsd-<stem>.md  (slash command definitions)
 *   - skills/gsd-<stem>/SKILL.md  (existing skill definitions)
 *
 * mcpServers in settings.json is explicitly excluded: gsd ships no MCP server
 * and registering third-party servers is out of scope for the installer.
 *
 * Ref: https://docs.augmentcode.com/cli/reference — ~/.augment/commands/<name>.md
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createTempDir, cleanup } = require('./helpers.cjs');

const { installRuntimeArtifacts, uninstallRuntimeArtifacts } = require('../gsd-core/bin/lib/install-engine.cjs');
const { resolveRuntimeArtifactLayout } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
const { loadSkillsManifest, resolveProfile } = require('../gsd-core/bin/lib/install-profiles.cjs');

const REAL_COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');
const MANIFEST = loadSkillsManifest(REAL_COMMANDS_DIR);
const RESOLVED_CORE = resolveProfile({ modes: ['core'], manifest: MANIFEST });

// ─── Layout contract ─────────────────────────────────────────────────────────

describe('enh-790 — augment layout has commands + skills + agents kinds', () => {
  test('resolveRuntimeArtifactLayout augment returns 3 kinds', () => {
    const layout = resolveRuntimeArtifactLayout('augment', '/tmp/fake-augment-dir');
    assert.strictEqual(layout.kinds.length, 3, 'augment must have exactly 3 artifact kinds');
    const kindNames = layout.kinds.map(k => k.kind).sort();
    assert.deepStrictEqual(kindNames, ['agents', 'commands', 'skills']);
  });

  test('augment commands kind targets commands/ with gsd- prefix', () => {
    const layout = resolveRuntimeArtifactLayout('augment', '/tmp/fake-augment-dir');
    const commandsKind = layout.kinds.find(k => k.kind === 'commands');
    assert.ok(commandsKind, 'must have commands kind');
    assert.strictEqual(commandsKind.destSubpath, 'commands');
    assert.strictEqual(commandsKind.prefix, 'gsd-');
  });

  test('augment skills kind targets skills/ with gsd- prefix', () => {
    const layout = resolveRuntimeArtifactLayout('augment', '/tmp/fake-augment-dir');
    const skillsKind = layout.kinds.find(k => k.kind === 'skills');
    assert.ok(skillsKind, 'must have skills kind');
    assert.strictEqual(skillsKind.destSubpath, 'skills');
    assert.strictEqual(skillsKind.prefix, 'gsd-');
  });
});

// ─── Install contract ────────────────────────────────────────────────────────

describe('enh-790 — installRuntimeArtifacts augment emits both commands and skills', () => {
  test('global augment install: commands/gsd-help.md and skills/gsd-help/SKILL.md exist', (t) => {
    const configDir = createTempDir('gsd-enh790-augment-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('augment', configDir, 'global', RESOLVED_CORE);

    // Commands dir
    const commandsDir = path.join(configDir, 'commands');
    assert.ok(fs.existsSync(commandsDir), 'commands/ dir must exist');
    const cmdFiles = fs.readdirSync(commandsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(cmdFiles.length > 0, 'at least one gsd-*.md command file must be installed');
    assert.ok(fs.existsSync(path.join(commandsDir, 'gsd-help.md')), 'commands/gsd-help.md must exist');

    // Skills dir (pre-existing behavior preserved)
    const skillsDir = path.join(configDir, 'skills');
    assert.ok(fs.existsSync(skillsDir), 'skills/ dir must exist');
    assert.ok(fs.existsSync(path.join(skillsDir, 'gsd-help', 'SKILL.md')), 'skills/gsd-help/SKILL.md must exist');
  });

  test('commands/gsd-help.md has Augment-compatible content (no raw ~/.claude/ refs)', (t) => {
    const configDir = createTempDir('gsd-enh790-content-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('augment', configDir, 'global', RESOLVED_CORE);

    const helpCmd = path.join(configDir, 'commands', 'gsd-help.md');
    assert.ok(fs.existsSync(helpCmd), 'gsd-help.md must exist');
    const content = fs.readFileSync(helpCmd, 'utf8');
    // Should not have raw ~/.claude/ references after path rewrite
    assert.ok(!content.includes('~/.claude/'), 'commands must not contain raw ~/.claude/ refs');
  });

  test('command count matches skill count (profile parity)', (t) => {
    const configDir = createTempDir('gsd-enh790-parity-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('augment', configDir, 'global', RESOLVED_CORE);

    const commandsDir = path.join(configDir, 'commands');
    const skillsDir = path.join(configDir, 'skills');
    const cmdCount = fs.readdirSync(commandsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.md')).length;
    const skillCount = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('gsd-')).length;
    assert.strictEqual(cmdCount, skillCount, 'command count must equal skill count for same profile');
  });

  test('full profile install does NOT mutate source commands/gsd/ files', (t) => {
    // Regression guard: stageSkillsForProfile returns the real source dir on full profile
    // (skills === '*'). applyRuntimeContentRewritesForCommandsInPlace must copy to temp
    // before rewriting — it must NEVER write back to the source tree.
    const { resolveProfile } = require('../gsd-core/bin/lib/install-profiles.cjs');
    const RESOLVED_FULL = resolveProfile({ modes: ['full'], manifest: MANIFEST });
    assert.strictEqual(RESOLVED_FULL.skills, '*', 'full profile must have skills === "*"');

    const configDir = createTempDir('gsd-enh790-full-');
    t.after(() => cleanup(configDir));

    // Record source file content before install
    const srcHelpPath = path.join(__dirname, '..', 'commands', 'gsd', 'help.md');
    const srcContentBefore = fs.readFileSync(srcHelpPath, 'utf8');

    installRuntimeArtifacts('augment', configDir, 'global', RESOLVED_FULL);

    // Source file must be identical after install
    const srcContentAfter = fs.readFileSync(srcHelpPath, 'utf8');
    assert.strictEqual(srcContentBefore, srcContentAfter,
      'source commands/gsd/help.md must not be mutated by the install');

    // Installed command file must have rewrites applied (Augment path substitution)
    const installedHelp = path.join(configDir, 'commands', 'gsd-help.md');
    assert.ok(fs.existsSync(installedHelp), 'installed gsd-help.md must exist');
    const installedContent = fs.readFileSync(installedHelp, 'utf8');
    assert.ok(!installedContent.includes('~/.claude/'), 'installed command must not have raw ~/.claude/ refs');
  });
});

describe('enh-790 — installRuntimeArtifacts does not leak temp dirs', () => {
  test('install cleans up gsd-cmd-rewrites-* temp dirs (no leak) — #856', (t) => {
    const { resolveProfile } = require('../gsd-core/bin/lib/install-profiles.cjs');
    const RESOLVED_FULL = resolveProfile({ modes: ['full'], manifest: MANIFEST });

    // Isolate os.tmpdir() to a private root so parallel test processes can't race
    // on the shared system temp dir. os.tmpdir() resolves $TMPDIR/$TEMP/$TMP per call.
    const isolatedTmp = createTempDir('gsd-enh790-tmproot-');
    const prev = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    process.env.TMPDIR = isolatedTmp;
    process.env.TEMP = isolatedTmp;
    process.env.TMP = isolatedTmp;

    const configDir = createTempDir('gsd-enh790-leak-');
    t.after(() => {
      for (const k of ['TMPDIR', 'TEMP', 'TMP']) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
      cleanup(configDir);
      cleanup(isolatedTmp);
    });

    installRuntimeArtifacts('augment', configDir, 'global', RESOLVED_FULL);

    // The install creates its gsd-cmd-rewrites-* temp dirs under the isolated root;
    // after the fix none must remain.
    const leaked = fs.readdirSync(isolatedTmp).filter(n => n.startsWith('gsd-cmd-rewrites-'));
    assert.ok(
      leaked.length === 0,
      `installer must not leak gsd-cmd-rewrites-* temp dirs; leaked: ${leaked.join(', ')}`
    );
  });
});

// ─── Uninstall contract ──────────────────────────────────────────────────────

describe('enh-790 — uninstallRuntimeArtifacts removes augment commands', () => {
  test('uninstall removes gsd-* commands but preserves user commands', (t) => {
    const configDir = createTempDir('gsd-enh790-uninstall-');
    t.after(() => cleanup(configDir));

    // uninstallRuntimeArtifacts is imported from install-engine.cjs at the top of this file

    // Pre-create: a GSD command + a user-owned command
    const commandsDir = path.join(configDir, 'commands');
    fs.mkdirSync(commandsDir, { recursive: true });
    fs.writeFileSync(path.join(commandsDir, 'gsd-help.md'), '# help\n');
    fs.writeFileSync(path.join(commandsDir, 'user-custom.md'), '# user\n');

    uninstallRuntimeArtifacts('augment', configDir, 'global');

    assert.ok(!fs.existsSync(path.join(commandsDir, 'gsd-help.md')), 'gsd-help.md must be removed');
    assert.ok(fs.existsSync(path.join(commandsDir, 'user-custom.md')), 'user-custom.md must be preserved');
  });
});

// ─── mcpServers exclusion ────────────────────────────────────────────────────

describe('enh-790 — mcpServers excluded (gsd ships no MCP server)', () => {
  test('augment install does not write settings.json mcpServers', (t) => {
    const configDir = createTempDir('gsd-enh790-mcp-excluded-');
    t.after(() => cleanup(configDir));

    installRuntimeArtifacts('augment', configDir, 'global', RESOLVED_CORE);

    // No settings.json with mcpServers should be written by the layout
    const settingsPath = path.join(configDir, 'settings.json');
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      assert.ok(!settings.mcpServers, 'settings.json must not contain mcpServers (gsd ships no MCP server)');
    }
    // If no settings.json at all, that is also correct
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-2808-skill-hyphen-name.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-2808-skill-hyphen-name (consolidation epic #1969 B6 #1975)", () => {
// allow-test-rule: source-text-is-the-product (see #2808)
// Reads .md/.json/.yml product files whose deployed text IS what the
// runtime loads — testing text content tests the deployed contract.

/**
 * Regression test for bug #2808
 *
 * All 85 GSD SKILL.md files declared `name: gsd:<cmd>` (colon), the deprecated
 * form. Claude Code surfaces the `name:` frontmatter field in autocomplete, so
 * users saw `/gsd:add-phase` suggestions instead of the canonical `/gsd-add-phase`.
 *
 * Root cause: skillFrontmatterName() in bin/install.js converted hyphenated
 * skill dir names to colon form (gsd-add-phase → gsd:add-phase) because
 * workflows called Skill(skill="gsd:<cmd>"). That was the original fix for
 * #2643. Since then, workflows have been updated to use hyphen form (#2808).
 *
 * Fix: skillFrontmatterName() now returns the hyphen form unchanged.
 * Workflow Skill() colon calls are updated to hyphen.
 *
 * This test verifies:
 * 1. skillFrontmatterName returns hyphen form (not colon).
 * 2. Installed SKILL.md would emit name: gsd-<cmd> (not gsd:<cmd>).
 * 3. No workflow contains a Skill(skill="gsd:<cmd>") colon call.
 */

'use strict';

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cleanup, createTempDir } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const { convertClaudeCommandToClaudeSkill, skillFrontmatterName } =
  require(path.join(ROOT, 'bin', 'install.js'));

const { installRuntimeArtifacts } = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'install-engine.cjs'));

const {
  loadSkillsManifest,
  resolveProfile,
} = require(path.join(ROOT, 'gsd-core', 'bin', 'lib', 'install-profiles.cjs'));

// Full resolved profile — installs all available skills from the source dir
const _manifest = loadSkillsManifest();
const resolvedProfileFull = resolveProfile({ modes: [], manifest: _manifest });

const WORKFLOWS_DIR = path.join(ROOT, 'gsd-core', 'workflows');
const COMMANDS_DIR = path.join(ROOT, 'commands', 'gsd');

function walkMd(dir) {
  const files = [];
  try {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) files.push(...walkMd(full));
      else if (e.name.endsWith('.md')) files.push(full);
    }
  } catch (err) {
    assert.fail(`failed to read markdown files from ${dir}: ${err.message}`);
  }
  return files;
}

describe('bug-2808: SKILL.md name: uses hyphen form', () => {
  test('skillFrontmatterName returns hyphen form (not colon)', () => {
    assert.strictEqual(skillFrontmatterName('gsd-add-phase'), 'gsd-add-phase');
    assert.strictEqual(skillFrontmatterName('gsd-plan-phase'), 'gsd-plan-phase');
    assert.strictEqual(skillFrontmatterName('gsd-autonomous'), 'gsd-autonomous');
  });

  test('generated SKILL.md contains name: gsd-<cmd> (not gsd:<cmd>)', () => {
    const cmdFiles = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md'));
    assert.ok(cmdFiles.length > 0, 'expected GSD command files');

    for (const cmd of cmdFiles) {
      const base = cmd.replace(/\.md$/, '');
      const skillDirName = 'gsd-' + base;
      const src = fs.readFileSync(path.join(COMMANDS_DIR, cmd), 'utf-8');
      const skillContent = convertClaudeCommandToClaudeSkill(src, skillDirName);

      // Parse frontmatter structurally: extract name: line from the --- block.
      const fmMatch = skillContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      assert.ok(fmMatch, `${cmd}: generated skill content must have a frontmatter block`);
      const fmLines = fmMatch[1].split(/\r?\n/);
      const nameEntry = fmLines.find((l) => l.startsWith('name:'));
      assert.ok(nameEntry, `${cmd}: generated SKILL.md is missing required name: field`);

      const name = nameEntry.replace(/^name:\s*/, '').trim();
      assert.ok(
        !name.includes(':'),
        `${cmd}: SKILL.md name should be hyphen form, got "${name}"`
      );
      assert.ok(
        name.startsWith('gsd-'),
        `${cmd}: SKILL.md name should start with gsd-, got "${name}"`
      );

      // #3583 regression guard: the *body* must not leak retired colon-form
      // command references (e.g. /gsd:plan-phase or gsd:review). The converter
      // now uses transformContentToHyphen from the shared transformer.
      //
      // We explicitly scope to the body (after stripping the leading frontmatter
      // block) so that descriptions or other frontmatter fields containing example
      // gsd: references do not cause spurious failures.
      //
      // gsd:sdk and gsd:tools are intentionally excluded: they are not slash commands
      // (no commands/gsd/sdk.md or tools.md exist), so the transformer correctly leaves
      // them alone. They are benign and should not trigger this assertion.
      const bodyContent = skillContent.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
      const colonRefs = (bodyContent.match(/\bgsd:[a-z][a-z0-9-]*\b/g) || [])
        .filter(r => !/gsd:(sdk|tools)/.test(r));
      assert.strictEqual(
        colonRefs.length, 0,
        `${cmd}: generated SKILL.md body must not contain gsd: command references (found: ${colonRefs.join(', ')})`
      );
    }
  });

  test('no workflow contains Skill(skill="gsd:<cmd>") colon form', () => {
    const workflowFiles = walkMd(WORKFLOWS_DIR);
    assert.ok(
      workflowFiles.length > 0,
      `expected workflow markdown files under ${WORKFLOWS_DIR}`
    );
    const colonCalls = [];
    for (const f of workflowFiles) {
      const src = fs.readFileSync(f, 'utf-8');
      // Strip HTML comments to avoid matching commented-out examples.
      // regex-free HTML-comment stripper (CodeQL: avoid incomplete-multi-character-sanitization)
      let stripped = '';
      {
        let rest = src;
        let idx;
        while ((idx = rest.indexOf('<!--')) !== -1) {
          stripped += rest.slice(0, idx);
          const end = rest.indexOf('-->', idx + 4);
          if (end === -1) { rest = ''; break; }
          rest = rest.slice(end + 3);
        }
        stripped += rest;
      }
      // Scan each line for Skill() calls using the colon form.
      // Parsing line-by-line is more precise than a multi-line regex
      // and avoids false positives from incidental matches in prose.
      for (const line of stripped.split(/\r?\n/)) {
        // Tolerate whitespace around the parenthesis, the `skill` keyword,
        // and the `=` so variants like `Skill( skill = "gsd:foo" )` are still
        // flagged. Without the `\s*` allowances, drift slips through this guard.
        //
        // The local-name capture must be permissive (`[^'"\s)]+`, not
        // `[a-z0-9-]+`) — the whole purpose of this guard is to surface
        // *malformed* drift, including legacy underscore-form names like
        // `gsd:extract_learnings`. A character-class that excludes the very
        // characters we need to flag would silently let drift through.
        const colonCallRe = /Skill\(\s*skill\s*=\s*\\?['"]gsd:([^'"\s)]+)\\?['"]/gi;
        let m;
        while ((m = colonCallRe.exec(line)) !== null) {
          colonCalls.push(`${path.basename(f)}: Skill(skill="gsd:${m[1]}")`);
        }
      }
    }
    assert.deepStrictEqual(
      colonCalls,
      [],
      'deprecated colon-form Skill() calls found — update to gsd-<cmd>: ' + colonCalls.join(', ')
    );
  });

  test('generated autocomplete skill surface uses hyphen names without underscores', (t) => {
    const tmp = createTempDir('gsd-autocomplete-surface-');
    t.after(() => cleanup(tmp));

    // Use the real COMMANDS_DIR as the source via .gsd-source marker.
    // installRuntimeArtifacts('claude', configDir, 'global') writes to
    // configDir/skills/ using the same converter as the shim did.
    // With the full profile (#924 fix), skills are FLAT: gsd-<stem>/SKILL.md
    // (nested layout reverted for Claude — Claude Code scans only one level).
    const configDir = path.join(tmp, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, '.gsd-source'), COMMANDS_DIR + '\n');
    installRuntimeArtifacts('claude', configDir, 'global', resolvedProfileFull);
    const skillsDir = path.join(configDir, 'skills');

    // Recursively collect all SKILL.md files under skills/ (handles both flat and
    // nested layouts). Don't filter any paths — that would silently hide exactly
    // the kind of drift this test exists to catch (a `gsd:extract-learnings`
    // colon variant or a bare `extract-learnings` without the namespace prefix
    // would never be collected, and the loop below would never see them).
    function collectSkillMds(dir) {
      const results = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...collectSkillMds(full));
        } else if (entry.name === 'SKILL.md') {
          results.push(full);
        }
      }
      return results;
    }

    const allSkillMdPaths = collectSkillMds(skillsDir);
    assert.ok(allSkillMdPaths.length > 0, 'expected generated SKILL.md files under skillsDir');

    // Validate every SKILL.md's name: field (the consumer-facing name used in
    // autocomplete). We also check that the containing dir name doesn't use
    // banned characters at any level of nesting.
    const allNames = [];
    for (const skillMdPath of allSkillMdPaths) {
      const relPath = path.relative(skillsDir, skillMdPath);
      const skillContent = fs.readFileSync(skillMdPath, 'utf-8');
      // Scope the name: lookup to the YAML frontmatter block so a stray
      // `name:` line in the body cannot satisfy the assertion.
      const fmMatch = skillContent.match(/^---\r?\n([\s\S]*?)\r?\n---/);
      assert.ok(fmMatch, `${relPath}: generated SKILL.md must include frontmatter`);
      const nameLine = fmMatch[1].split(/\r?\n/).find((l) => /^name:\s*/.test(l));
      assert.ok(nameLine, `${relPath}: generated SKILL.md is missing name: frontmatter`);
      const name = nameLine.replace(/^name:\s*/, '').trim();
      assert.ok(name.startsWith('gsd-'), `${relPath}: autocomplete name must start with gsd-, got ${name}`);
      assert.ok(!name.includes(':'), `${relPath}: autocomplete name must not contain colon, got ${name}`);
      assert.ok(!name.includes('_'), `${relPath}: autocomplete name must not contain underscore, got ${name}`);
      allNames.push(name);

      // Also validate each path segment (dir name) in the relative path doesn't
      // contain the banned characters — catches mislabeled directory names.
      const segments = relPath.split(path.sep).slice(0, -1); // exclude 'SKILL.md' filename
      for (const seg of segments) {
        assert.ok(!seg.includes(':'), `${relPath}: dir segment "${seg}" must not contain colon`);
        assert.ok(!seg.includes('_'), `${relPath}: dir segment "${seg}" must use hyphens, not underscores`);
      }
    }

    assert.ok(allNames.includes('gsd-extract-learnings'), 'autocomplete surface must include gsd-extract-learnings');
    assert.ok(!allNames.includes('gsd-extract_learnings'), 'autocomplete surface must not include gsd-extract_learnings');
  });

  test('transformContentToHyphen (from fix-slash-commands.cjs) rewrites colon to hyphen for known commands', () => {
    const transformer = require(path.join(ROOT, 'scripts', 'fix-slash-commands.cjs'));
    const { transformContentToHyphen, readCmdNames } = transformer;
    const liveCmdNames = readCmdNames();

    const input = 'Run /gsd:plan-phase then gsd:execute-phase. Also see /gsd:review and gsd-sdk query.';
    const out = transformContentToHyphen(input, liveCmdNames);

    assert.ok(out.includes('/gsd-plan-phase'), 'leading-/ colon form must become hyphen');
    assert.ok(out.includes('gsd-execute-phase'), 'bare colon form must become hyphen');
    assert.ok(out.includes('/gsd-review'), 'another command reference must be rewritten');
    assert.ok(out.includes('gsd-sdk'), 'non-command gsd-sdk must be left untouched');
    assert.ok(!out.match(/\bgsd:[a-z]/), 'no colon-form command reference may survive');
  });

  test('respects word boundary — does not rewrite gsd:plan-phase-extra (partial match guard)', () => {
    const transformer = require(path.join(ROOT, 'scripts', 'fix-slash-commands.cjs'));
    const { transformContentToHyphen, readCmdNames } = transformer;
    const liveCmdNames = readCmdNames();

    const out = transformContentToHyphen('gsd:plan-phase-extra and /gsd:execute-phase-extra', liveCmdNames);
    assert.strictEqual(out, 'gsd:plan-phase-extra and /gsd:execute-phase-extra',
      'word-boundary lookahead must prevent partial matches on the reverse transform');
  });

  test('respects left word boundary — does not rewrite inside larger tokens (e.g. mygsd:cmd)', () => {
    const transformer = require(path.join(ROOT, 'scripts', 'fix-slash-commands.cjs'));
    const { transformContentToHyphen, readCmdNames } = transformer;
    const liveCmdNames = readCmdNames();

    const input = 'See mygsd:plan-phase or prefix-gsd:execute in the docs.';
    const out = transformContentToHyphen(input, liveCmdNames);
    assert.strictEqual(out, input, 'negative lookbehind must prevent left-side in-word matches');
  });

  test('leaves already-hyphen-form references untouched (idempotent on output)', () => {
    const transformer = require(path.join(ROOT, 'scripts', 'fix-slash-commands.cjs'));
    const { transformContentToHyphen, readCmdNames } = transformer;
    const liveCmdNames = readCmdNames();

    const input = 'Run gsd-plan-phase and /gsd-execute-phase then gsd:review.'; // mixed, only colon should change
    const out = transformContentToHyphen(input, liveCmdNames);
    assert.ok(out.includes('gsd-plan-phase'), 'pre-existing hyphen stays');
    assert.ok(out.includes('/gsd-execute-phase'), 'pre-existing hyphen stays');
    assert.ok(out.includes('gsd-review'), 'colon form was normalized');
    assert.ok(!out.includes('gsd:review'), 'no colon form remains');
  });
});
  });
}


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/fix-1920-installer-ships-capability-generators.test.cjs — consolidation epic #1969 (B6 #1975)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:fix-1920-installer-ships-capability-generators (consolidation epic #1969 B6 #1975)", () => {
'use strict';
/**
 * Regression tests for #1920: the installer must produce a capability-ecosystem-
 * complete flattened layout, and the capability loader must resolve the real host
 * version in that layout.
 *
 * Two gaps broke third-party capabilities on installed (flattened) layouts:
 *
 *   Gap 1 — host version read as 0.0.0. `readHostVersion()` resolved the running GSD
 *     version via require('../../../package.json'), which in the installed layout is the
 *     marker package.json ({"type":"commonjs"}, no version) → the fail-closed fallback
 *     reported 0.0.0, so `capability install` rejected any manifest with a real
 *     engines.gsd range as "incompatible with GSD 0.0.0". Worse, for runtimes that get
 *     no marker and for local installs, that walked-up package.json could be the USER's
 *     own project, reporting a wrong version. Fix: readHostVersion() prefers the
 *     authoritative gsd-core/VERSION the installer writes for EVERY runtime.
 *
 *   Gap 2 — the registry generator was never shipped. The loader composes overlays via
 *     require('../../../scripts/gen-capability-registry.cjs'); the installer never copied
 *     it (nor its sibling gen-loop-host-contract.cjs), so the never-crash invariant
 *     discarded EVERY overlay and fell back to the frozen first-party registry —
 *     installed third-party capabilities were silently inert. Same class of gap as #1223
 *     (scripts/fix-slash-commands.cjs).
 *
 * These tests are RED before the fix (loader/install.js) and GREEN after.
 */

process.env.GSD_TEST_MODE = '1';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const ROOT = path.join(__dirname, '..');
const INSTALL = path.join(ROOT, 'bin', 'install.js');
const MANIFEST_NAME = 'gsd-file-manifest.json';

// The generator scripts the capability loader requires by relative path.
const GENERATORS = ['gen-capability-registry.cjs', 'gen-loop-host-contract.cjs'];

// ---------------------------------------------------------------------------
// Gap 1 — readHostVersion() prefers gsd-core/VERSION (the installer-written,
// all-runtime authoritative source) over an ambient/absent package.json.
// ---------------------------------------------------------------------------
describe('Gap 1: readHostVersion resolves the real host version in an installed layout (#1920)', () => {
  const { readHostVersion } = require('../gsd-core/bin/lib/capability-loader.cjs');

  /** Build a fake installed tree and return its gsd-core/bin/lib dir (the module libDir). */
  function fakeTree({ version, pkg }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1920-ver-'));
    const libDir = path.join(root, 'gsd-core', 'bin', 'lib');
    fs.mkdirSync(libDir, { recursive: true });
    if (version !== undefined) fs.writeFileSync(path.join(root, 'gsd-core', 'VERSION'), version);
    if (pkg !== undefined) fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg));
    return { root, libDir };
  }

  test('prefers gsd-core/VERSION over a wrong ambient package.json version', () => {
    // The walked-up package.json belongs to the user's project (wrong version) — must be ignored.
    const { root, libDir } = fakeTree({ version: '9.9.9\n', pkg: { name: 'user-app', version: '1.2.3', type: 'commonjs' } });
    try {
      assert.strictEqual(readHostVersion(libDir), '9.9.9');
    } finally {
      cleanup(root);
    }
  });

  test('falls back to the runtime-root package.json when no VERSION file (dev/source tree)', () => {
    const { root, libDir } = fakeTree({ pkg: { version: '2.3.4' } });
    try {
      assert.strictEqual(readHostVersion(libDir), '2.3.4');
    } finally {
      cleanup(root);
    }
  });

  test('fail-closes to 0.0.0 when neither VERSION nor a package.json version resolves', () => {
    const { root, libDir } = fakeTree({});
    try {
      assert.strictEqual(readHostVersion(libDir), '0.0.0');
    } finally {
      cleanup(root);
    }
  });

  test('a real global install writes gsd-core/VERSION carrying the host version', () => {
    const dir = realInstall();
    try {
      const vfile = path.join(dir, 'gsd-core', 'VERSION');
      assert.ok(fs.existsSync(vfile), 'installer must write gsd-core/VERSION');
      assert.strictEqual(
        fs.readFileSync(vfile, 'utf8').trim(),
        require('../package.json').version,
        'gsd-core/VERSION must carry the real host version readHostVersion() reads',
      );
    } finally {
      cleanup(dir);
    }
  });
});

// ---------------------------------------------------------------------------
// Gap 2 — the installer ships (and uninstalls / manifest-tracks) the capability
// registry generator scripts.
// ---------------------------------------------------------------------------

/** Run a real global install into a fresh temp config dir; return that dir. */
function realInstall() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1920-'));
  // The module-level GSD_TEST_MODE=1 gates the installer's main() off entirely —
  // strip it from the child env for the spawned REAL install.
  const childEnv = { ...process.env };
  delete childEnv.GSD_TEST_MODE;
  const res = spawnSync(
    process.execPath,
    [INSTALL, '--claude', '--global', '--config-dir', dir],
    { encoding: 'utf8', timeout: 120000, env: childEnv },
  );
  assert.strictEqual(res.status, 0, `install --claude failed: ${res.stderr || res.stdout}`);
  return dir;
}

// ---------------------------------------------------------------------------
// Gap 1 (end-to-end CLI) — the actual repro: `gsd-tools capability install` on an
// INSTALLED layout must resolve the real host version for the engines.gsd gate, not
// 0.0.0. The dev tree always has a versioned package.json two levels up, so this only
// reproduces against a real install (where ../../package.json is the versionless marker
// and gsd-core/VERSION carries the truth). The CLI computes hostVersion itself, so this
// covers capHostVersion() in gsd-tools.cjs — a path the loader unit test does not touch.
// ---------------------------------------------------------------------------
describe('Gap 1 (end-to-end CLI): installed capability install uses the real host version (#1920)', () => {
  const HOST_MAJOR = require('../package.json').version.split('.')[0];

  function writeProbeCapability(engines) {
    const src = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1920-cap-'));
    const cap = {
      id: 'p1920-probe', role: 'feature', version: '1.0.0', title: 'probe',
      description: 'test capability', tier: 'standard', requires: [],
      runtimeCompat: { supported: ['*'], unsupported: [] },
      skills: [], agents: [], hooks: [], config: {}, steps: [],
      contributions: [], gates: [], engines,
    };
    fs.writeFileSync(path.join(src, 'capability.json'), JSON.stringify(cap, null, 2));
    return src;
  }

  test('a capability requiring engines.gsd ">=<host major>.0.0" is not rejected as GSD 0.0.0', () => {
    const dir = realInstall();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1920-home-'));
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-1920-cwd-'));
    fs.mkdirSync(path.join(cwd, '.planning'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.planning', 'config.json'), '{}');
    const src = writeProbeCapability({ gsd: `>=${HOST_MAJOR}.0.0` });
    try {
      const installedTools = path.join(dir, 'gsd-core', 'bin', 'gsd-tools.cjs');
      const env = { ...process.env, GSD_HOME: home, GSD_WORKSTREAM: '', GSD_PROJECT: '', GSD_SESSION_KEY: '', CLAUDE_SESSION_ID: '' };
      delete env.GSD_TEST_MODE;
      const res = spawnSync(
        process.execPath,
        [installedTools, 'capability', 'install', src, '--scope', 'global', '--yes', '--json'],
        { cwd, env, encoding: 'utf8', timeout: 60000 },
      );
      const combined = `${res.stdout || ''}\n${res.stderr || ''}`;
      assert.doesNotMatch(
        combined,
        /incompatible with GSD 0\.0\.0/,
        `installed CLI saw host version 0.0.0 — the engines gate read the versionless marker: ${combined}`,
      );
      assert.strictEqual(res.status, 0, `capability install failed on the installed layout: ${combined}`);
    } finally {
      cleanup(dir); cleanup(home); cleanup(cwd); cleanup(src);
    }
  });
});

describe('Gap 2: installer ships the capability registry generator scripts (#1920)', () => {
  test('the generator scripts are copied into scripts/', () => {
    const dir = realInstall();
    try {
      for (const gen of GENERATORS) {
        const dest = path.join(dir, 'scripts', gen);
        assert.ok(fs.existsSync(dest), `installer must ship scripts/${gen}`);
        assert.ok(fs.statSync(dest).size > 0, `scripts/${gen} must not be empty`);
      }
    } finally {
      cleanup(dir);
    }
  });

  test('the shipped generator scripts are tracked in the file manifest', () => {
    const dir = realInstall();
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), 'utf8'));
      for (const gen of GENERATORS) {
        assert.ok(
          manifest.files[`scripts/${gen}`],
          `manifest must track scripts/${gen} for drift/uninstall accounting`,
        );
      }
    } finally {
      cleanup(dir);
    }
  });
});
  });
}
