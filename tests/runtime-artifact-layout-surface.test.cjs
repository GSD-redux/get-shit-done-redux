'use strict';
/**
 * Runtime Artifact Layout Module (ADR-3660) — surface seam.
 * Consolidated from: surface-apply, surface-resolve, surface-state,
 *   surface-clusters, surface-list (5 files deleted).
 * See also: runtime-artifact-layout.test.cjs, runtime-artifact-layout-install-profiles.test.cjs
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { writeSurface, readSurface, resolveSurface, listSurface, applySurface } = require('../gsd-core/bin/lib/surface.cjs');
const { loadSkillsManifest, writeActiveProfile, resolveProfile } = require('../gsd-core/bin/lib/install-profiles.cjs');
const { resolveRuntimeArtifactLayout } = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');
const { CLUSTERS, allClusteredSkills } = require('../gsd-core/bin/lib/clusters.cjs');
const { createTempDir, cleanup, sandboxHome } = require('./helpers.cjs');

const REAL_COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');

// ─── helpers ────────────────────────────────────────────────────────────────

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'gsd-ral-surf-'));
}

function createFixtureRuntime() {
  const base = createTempDir('gsd-surface-apply-');
  const runtimeConfigDir = base;
  // #1367: claude local uses flat commands/ (not commands/gsd/) — commandsDir is commands/.
  const commandsDir = path.join(runtimeConfigDir, 'commands');
  const agentsDir = path.join(runtimeConfigDir, 'agents');
  fs.mkdirSync(commandsDir, { recursive: true });
  fs.mkdirSync(agentsDir, { recursive: true });
  return { base, runtimeConfigDir, commandsDir, agentsDir };
}

function realManifest() {
  return loadSkillsManifest(REAL_COMMANDS_DIR);
}

function readFrontmatterDescription(markdown) {
  const lines = markdown.split('\n');
  if (lines[0].trim() !== '---') return '';
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---') break;
    const sep = line.indexOf(':');
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim();
    if (key !== 'description') continue;
    return line.slice(sep + 1).trim();
  }
  return '';
}

// ─── applySurface ────────────────────────────────────────────────────────────

describe('applySurface', () => {
  test('core profile: only core skills appear in commandsDir', (t) => {
    // #1367: claude local uses flat gsd-<stem>.md files at commands/ (not commands/gsd/<stem>.md).
    const { base, runtimeConfigDir, commandsDir } = createFixtureRuntime();
    t.after(() => cleanup(base));
    writeActiveProfile(runtimeConfigDir, 'core');
    writeSurface(runtimeConfigDir, {
      baseProfile: 'core',
      disabledClusters: [],
      explicitAdds: [],
      explicitRemoves: [],
    });
    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const layout = resolveRuntimeArtifactLayout('claude', runtimeConfigDir, 'local');
    const resolved = applySurface(runtimeConfigDir, layout, manifest, CLUSTERS);

    // After #1367: files are gsd-<stem>.md (not bare stem.md). Strip the gsd- prefix
    // to check against the REAL_COMMANDS_DIR (which still uses bare names).
    const files = fs.readdirSync(commandsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.md'));
    for (const file of files) {
      const bareName = file.slice('gsd-'.length); // gsd-help.md → help.md
      assert.ok(fs.existsSync(path.join(REAL_COMMANDS_DIR, bareName)), `unexpected file: ${file} (no source: ${bareName})`);
    }
    const expectedCore = [...resolved.skills].map(stem => `gsd-${stem}.md`).sort();
    assert.deepStrictEqual(
      [...files].sort(),
      expectedCore,
      'commandsDir should contain exactly core commands'
    );
  });

  test('removes superseded files when profile shrinks', (t) => {
    const { base, runtimeConfigDir, commandsDir } = createFixtureRuntime();
    t.after(() => cleanup(base));
    writeActiveProfile(runtimeConfigDir, 'standard');
    writeSurface(runtimeConfigDir, {
      baseProfile: 'standard',
      disabledClusters: [],
      explicitAdds: [],
      explicitRemoves: [],
    });
    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const layout = resolveRuntimeArtifactLayout('claude', runtimeConfigDir, 'local');
    applySurface(runtimeConfigDir, layout, manifest, CLUSTERS);

    // #1367: files are gsd-<stem>.md in flat commands/
    const afterStandard = new Set(fs.readdirSync(commandsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.md')));

    writeSurface(runtimeConfigDir, {
      baseProfile: 'core',
      disabledClusters: [],
      explicitAdds: [],
      explicitRemoves: [],
    });
    const resolvedCore = applySurface(runtimeConfigDir, layout, manifest, CLUSTERS);

    const afterCore = new Set(fs.readdirSync(commandsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.md')));

    assert.ok(afterCore.size <= afterStandard.size, 'core should have fewer or equal files than standard');

    const expectedCore = [...resolvedCore.skills].map(stem => `gsd-${stem}.md`).sort();
    assert.deepStrictEqual(
      [...afterCore].sort(),
      expectedCore,
      'afterCore should contain exactly core commands'
    );

    for (const file of afterCore) {
      const bareName = file.slice('gsd-'.length);
      assert.ok(
        fs.existsSync(path.join(REAL_COMMANDS_DIR, bareName)),
        `file in commandsDir not a real skill: ${file}`
      );
    }
  });

  test('leaves non-gsd .md files alone in agentsDir', (t) => {
    const { base, runtimeConfigDir, agentsDir } = createFixtureRuntime();
    t.after(() => cleanup(base));
    const foreignAgent = path.join(agentsDir, 'my-custom-agent.md');
    fs.writeFileSync(foreignAgent, '# custom agent\n', 'utf8');

    writeActiveProfile(runtimeConfigDir, 'core');
    writeSurface(runtimeConfigDir, {
      baseProfile: 'core',
      disabledClusters: [],
      explicitAdds: [],
      explicitRemoves: [],
    });
    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const layout = resolveRuntimeArtifactLayout('claude', runtimeConfigDir, 'local');
    applySurface(runtimeConfigDir, layout, manifest, CLUSTERS);

    assert.ok(fs.existsSync(foreignAgent), 'non-gsd agent file should not be touched');
  });

  test('adds missing skill files from install source', (t) => {
    const { base, runtimeConfigDir, commandsDir } = createFixtureRuntime();
    t.after(() => cleanup(base));
    writeActiveProfile(runtimeConfigDir, 'core');
    writeSurface(runtimeConfigDir, {
      baseProfile: 'core',
      disabledClusters: [],
      explicitAdds: [],
      explicitRemoves: [],
    });
    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const layout = resolveRuntimeArtifactLayout('claude', runtimeConfigDir, 'local');
    applySurface(runtimeConfigDir, layout, manifest, CLUSTERS);

    // #1367: flat gsd-<stem>.md files at commands/ (not commands/gsd/<stem>.md)
    assert.ok(
      fs.existsSync(path.join(commandsDir, 'gsd-help.md')),
      'gsd-help.md should be copied from install source (#1367: flat hyphen layout)'
    );
    assert.ok(
      fs.existsSync(path.join(commandsDir, 'gsd-new-project.md')),
      'gsd-new-project.md should be copied from install source (#1367: flat hyphen layout)'
    );
  });

  test('_syncGsdDir skills kind: adds missing skill dirs, removes stale prefix-matched dirs, preserves foreign dirs', (t) => {
    const { _syncGsdDir } = require('../gsd-core/bin/lib/surface.cjs');

    const base = createTempDir('gsd-surface-skills-');
    t.after(() => cleanup(base));
    const stagedDir = path.join(base, 'staged');
    const destDir = path.join(base, 'dest');
    fs.mkdirSync(destDir, { recursive: true });

    const stem1 = 'gsd-help';
    const stem2 = 'gsd-update';
    fs.mkdirSync(path.join(stagedDir, stem1), { recursive: true });
    fs.writeFileSync(path.join(stagedDir, stem1, 'SKILL.md'), '# help\n', 'utf8');
    fs.mkdirSync(path.join(stagedDir, stem2), { recursive: true });
    fs.writeFileSync(path.join(stagedDir, stem2, 'SKILL.md'), '# update\n', 'utf8');

    const staleDir = path.join(destDir, 'gsd-old-skill');
    fs.mkdirSync(staleDir, { recursive: true });
    fs.writeFileSync(path.join(staleDir, 'SKILL.md'), '# old\n', 'utf8');

    const foreignDir = path.join(destDir, 'my-custom-skill');
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.writeFileSync(path.join(foreignDir, 'SKILL.md'), '# custom\n', 'utf8');

    const skillsKind = { kind: 'skills', destSubpath: 'skills', prefix: 'gsd-', stage: () => stagedDir };

    // Build a minimal manifest that includes the GSD-owned stems so that the
    // manifest-membership gate (Finding 1 fix) correctly identifies gsd-old-skill
    // as GSD-owned and prunes it. Without a manifest the new code conservatively
    // preserves all gsd-* dirs it cannot confirm are GSD-owned.
    const manifest = new Map([
      ['help', []],
      ['update', []],
      ['old-skill', []],  // GSD-owned stale stem — must be pruned when not in staged set
    ]);

    _syncGsdDir(stagedDir, destDir, skillsKind, manifest);

    assert.ok(fs.existsSync(path.join(destDir, stem1, 'SKILL.md')), 'gsd-help/SKILL.md should be copied');
    assert.ok(fs.existsSync(path.join(destDir, stem2, 'SKILL.md')), 'gsd-update/SKILL.md should be copied');
    // stale gsd- dir removed (it's in the manifest so it is GSD-owned, but not in staged set)
    assert.ok(!fs.existsSync(staleDir), 'stale gsd-old-skill dir should be removed');
    assert.ok(fs.existsSync(foreignDir), 'my-custom-skill dir should be preserved');
  });

  test('applySurface recreates missing destination directories', (t) => {
    const base = createTempDir('gsd-surface-missing-dest-');
    t.after(() => cleanup(base));
    const runtimeConfigDir = base;
    writeActiveProfile(runtimeConfigDir, 'core');
    writeSurface(runtimeConfigDir, {
      baseProfile: 'core',
      disabledClusters: [],
      explicitAdds: [],
      explicitRemoves: [],
    });
    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const layout = resolveRuntimeArtifactLayout('claude', runtimeConfigDir, 'local');
    applySurface(runtimeConfigDir, layout, manifest, CLUSTERS);

    // #1367: claude local uses flat commands/ (not commands/gsd/)
    const commandsDir = path.join(runtimeConfigDir, 'commands');
    assert.ok(fs.existsSync(commandsDir), 'commands/ dir should be created even if initially absent');
    const files = fs.readdirSync(commandsDir).filter(f => f.startsWith('gsd-') && f.endsWith('.md'));
    assert.ok(files.length > 0, 'commands/ should contain staged skill files (gsd-*.md)');
    assert.ok(files.includes('gsd-help.md'), 'gsd-help.md should be present after applySurface on missing dest');
  });

  test('Hermes profile shrink: stale GSD skill dirs are removed; user skills preserved', (t) => {
    const { _syncGsdDir } = require('../gsd-core/bin/lib/surface.cjs');

    const base = createTempDir('gsd-surface-hermes-shrink-');
    t.after(() => cleanup(base));
    const stagedDir = path.join(base, 'staged');
    const destDir = path.join(base, 'dest');
    fs.mkdirSync(destDir, { recursive: true });

    fs.mkdirSync(path.join(stagedDir, 'gsd-executor'), { recursive: true });
    fs.writeFileSync(path.join(stagedDir, 'gsd-executor', 'SKILL.md'), '# executor\n', 'utf8');

    fs.mkdirSync(path.join(destDir, 'gsd-executor'), { recursive: true });
    fs.writeFileSync(path.join(destDir, 'gsd-executor', 'SKILL.md'), '# executor\n', 'utf8');
    fs.mkdirSync(path.join(destDir, 'gsd-planner'), { recursive: true });
    fs.writeFileSync(path.join(destDir, 'gsd-planner', 'SKILL.md'), '# planner\n', 'utf8');
    fs.mkdirSync(path.join(destDir, 'user-skill'), { recursive: true });
    fs.writeFileSync(path.join(destDir, 'user-skill', 'SKILL.md'), '# user\n', 'utf8');

    const manifest = new Map([
      ['gsd-executor', []],
      ['gsd-planner', []],
    ]);

    const hermesKind = { kind: 'skills', destSubpath: 'skills/gsd', prefix: '', stage: () => stagedDir };
    _syncGsdDir(stagedDir, destDir, hermesKind, manifest);

    assert.ok(
      fs.existsSync(path.join(destDir, 'gsd-executor', 'SKILL.md')),
      'gsd-executor should be kept (in staged set)'
    );
    assert.ok(
      !fs.existsSync(path.join(destDir, 'gsd-planner')),
      'gsd-planner should be removed (in manifest but not in staged set — stale GSD skill)'
    );
    assert.ok(
      fs.existsSync(path.join(destDir, 'user-skill', 'SKILL.md')),
      'user-skill should be preserved (not in manifest — user-owned)'
    );
  });

  test('_syncGsdDir skills kind (hermes): preserves non-GSD user dir under skills/gsd/ when kindPrefix is empty', (t) => {
    const { _syncGsdDir } = require('../gsd-core/bin/lib/surface.cjs');

    const base = createTempDir('gsd-surface-hermes-');
    t.after(() => cleanup(base));
    const stagedDir = path.join(base, 'staged');
    const destDir = path.join(base, 'dest');
    fs.mkdirSync(destDir, { recursive: true });

    const stem1 = 'help';
    fs.mkdirSync(path.join(stagedDir, stem1), { recursive: true });
    fs.writeFileSync(path.join(stagedDir, stem1, 'SKILL.md'), '# help\n', 'utf8');

    const userDir = path.join(destDir, 'user-custom-skill');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'SKILL.md'), '# user custom\n', 'utf8');

    const hermesKind = { kind: 'skills', destSubpath: 'skills/gsd', prefix: '', stage: () => stagedDir };
    _syncGsdDir(stagedDir, destDir, hermesKind);

    assert.ok(fs.existsSync(userDir), 'user-custom-skill dir must be preserved when kindPrefix is empty (Hermes)');
    assert.ok(fs.existsSync(path.join(destDir, stem1, 'SKILL.md')), 'GSD help/SKILL.md must be copied');
  });

  // Regression guard for #816: applySurface must write gsd-prefixed command files
  // (matching installRuntimeArtifacts/_copyStaged behaviour) and must NOT prune
  // user-created command files that install would preserve.
  //
  // Affected runtimes have a FLAT command dir (opencode `commands/` — #2329,
  // cursor `commands/`, augment `commands/`, kilo `command/`) with kind.prefix='gsd-'.
  // _copyStaged names files `gsd-<stem>.md` but the buggy _syncGsdDir copies
  // them as `<stem>.md` (unprefixed) and also deletes ALL .md files not in the
  // staged set, including user files.
  test('applySurface writes gsd-prefixed command files matching install and preserves user commands (#816)', (t) => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-surface-816-'));
    t.after(() => cleanup(configDir));

    writeActiveProfile(configDir, 'standard');
    writeSurface(configDir, {
      baseProfile: 'standard',
      disabledClusters: [],
      explicitAdds: [],
      explicitRemoves: [],
    });

    // Determine the command dest dir for opencode: commandsKind destSubpath='commands' (#2329)
    const layout = resolveRuntimeArtifactLayout('opencode', configDir, 'global');
    const commandsKind = layout.kinds.find(k => k.kind === 'commands');
    assert.ok(commandsKind, 'opencode layout must have a commands kind');
    const commandDir = path.join(configDir, commandsKind.destSubpath);

    // Pre-seed a user command file BEFORE applySurface — install would preserve it
    fs.mkdirSync(commandDir, { recursive: true });
    fs.writeFileSync(path.join(commandDir, 'my-user-cmd.md'), '# user custom command\n', 'utf8');

    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    applySurface(configDir, layout, manifest, CLUSTERS);

    const files = fs.readdirSync(commandDir).filter(f => f.endsWith('.md'));

    // (a) At least one gsd-prefixed command file must exist — on buggy code only
    //     unprefixed files like 'help.md' are written, so this assertion fails.
    assert.ok(
      files.some(f => f.startsWith('gsd-') && f.endsWith('.md')),
      '#816: applySurface must write at least one gsd-prefixed command file ' +
      '(e.g. gsd-help.md) to match installRuntimeArtifacts/_copyStaged behaviour. ' +
      `Actual files: [${files.join(', ')}]`
    );

    // (b) Every GSD-owned command file must be prefixed — no bare <stem>.md files
    //     allowed among GSD-owned output (excluding the user file).
    const gsdFiles = files.filter(f => f !== 'my-user-cmd.md');
    const unprefixed = gsdFiles.filter(f => !f.startsWith('gsd-'));
    assert.deepStrictEqual(
      unprefixed,
      [],
      '#816: all GSD-owned command files must start with gsd- to match install. ' +
      `Found unprefixed: [${unprefixed.join(', ')}]`
    );

    // (c) The pre-seeded user file must survive applySurface — on buggy code the
    //     commands-kind pruning loop deletes ALL .md files not in the staged set,
    //     which wipes user files that installRuntimeArtifacts would never touch.
    assert.ok(
      files.includes('my-user-cmd.md'),
      '#816: applySurface must preserve user command file my-user-cmd.md that was ' +
      'present before sync — _syncGsdDir must not prune files not owned by GSD. ' +
      `Actual files: [${files.join(', ')}]`
    );
  });

  // Parity regression guard for #816: applySurface command-dir filenames must
  // match a fresh installRuntimeArtifacts for every command runtime. Guards
  // against future drift between _syncGsdDir (surface) and _copyStaged (install)
  // command-naming logic.
  //
  // Matrix: opencode/cursor/augment = flat commands/ + prefix gsd- (#2329: opencode
  //         moved from singular command/ to commands/); kilo = flat command/ + prefix gsd-.
  // For each runtime we: run install into installDir, run applySurface into
  // surfaceDir (same 'standard' profile both sides), then compare sorted .md
  // filename sets in the commands dest dir. On a fresh dir (no superseded files)
  // both paths must produce identical sets.
  test('applySurface command-dir filenames match a fresh install for every command runtime (#816 parity)', async (t) => {
    process.env.GSD_TEST_MODE = '1';
    const { installRuntimeArtifacts } = require('../gsd-core/bin/lib/install-engine.cjs');

    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    // Build the resolved profile once. Both install and surface sides must use
    // the same skill set so any filename difference is purely a naming bug.
    const resolvedProfile = resolveProfile({ modes: ['standard'], manifest });

    const PARITY_RUNTIMES = ['opencode', 'cursor', 'augment', 'kilo'];

    for (const runtime of PARITY_RUNTIMES) {
      // Create two independent temp dirs — one for install, one for surface.
      const installDir = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-816-install-${runtime}-`));
      const surfaceDir = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-816-surface-${runtime}-`));
      t.after(() => { cleanup(installDir); cleanup(surfaceDir); });

      // --- Install path ---
      installRuntimeArtifacts(runtime, installDir, 'global', resolvedProfile);

      // --- Surface path ---
      writeActiveProfile(surfaceDir, 'standard');
      writeSurface(surfaceDir, {
        baseProfile: 'standard',
        disabledClusters: [],
        explicitAdds: [],
        explicitRemoves: [],
      });
      const layout = resolveRuntimeArtifactLayout(runtime, surfaceDir, 'global');
      applySurface(surfaceDir, layout, manifest, CLUSTERS);

      // --- Find commands kind ---
      const cmdKind = layout.kinds.find(k => k.kind === 'commands');
      if (!cmdKind) {
        // Runtime has no commands kind at global scope — skip gracefully.
        continue;
      }

      // --- Compare sorted .md filename sets ---
      const installCmdDir = path.join(installDir, cmdKind.destSubpath);
      const surfaceCmdDir = path.join(surfaceDir, cmdKind.destSubpath);

      const installFiles = fs.existsSync(installCmdDir)
        ? fs.readdirSync(installCmdDir).filter(f => f.endsWith('.md')).sort()
        : [];
      const surfaceFiles = fs.existsSync(surfaceCmdDir)
        ? fs.readdirSync(surfaceCmdDir).filter(f => f.endsWith('.md')).sort()
        : [];

      assert.deepStrictEqual(
        surfaceFiles,
        installFiles,
        `#816 parity: command filenames for ${runtime} (${cmdKind.destSubpath}) must match a fresh install.\n` +
        `  install: [${installFiles.slice(0, 5).join(', ')}${installFiles.length > 5 ? '...' : ''}]\n` +
        `  surface: [${surfaceFiles.slice(0, 5).join(', ')}${surfaceFiles.length > 5 ? '...' : ''}]`
      );
    }
  });

  // Regression test for #813: applySurface must apply per-runtime path rewrites
  // (applyRuntimeContentRewritesInPlace) just as installRuntimeArtifacts does.
  // Without the fix, skill bodies retain the converter's default ~/.claude/ paths
  // instead of being rewritten to the install target (pathPrefix).
  //
  // Both 'cursor' and 'codex' use skillsKind AND have a path-rewrite case in
  // _applyRuntimeRewrites — so the regression guard covers both.
  for (const runtime of ['cursor', 'codex']) {
    test(`applySurface rewrites ${runtime} skill bodies to the install pathPrefix, not the converter default ~/.claude path (#813)`, (t) => {
      // Use mkdtempSync under os.tmpdir() — NOT under the user's home dir — so that
      // computePathPrefix returns an ABSOLUTE prefix `${configDir}/` for local installs,
      // clearly distinguishable from the `~/.claude/` converter default.
      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-surface-813-${runtime}-`));
      t.after(() => cleanup(configDir));

      writeActiveProfile(configDir, 'standard');
      writeSurface(configDir, {
        baseProfile: 'standard',
        disabledClusters: [],
        explicitAdds: [],
        explicitRemoves: [],
      });

      const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
      // skills/gsd-<name>/SKILL.md (destSubpath 'skills', prefix 'gsd-')
      // scope='local' ensures computePathPrefix returns an absolute configDir prefix
      // rather than the home-relative default (e.g. ~/.cursor/ or ~/.codex/).
      const layout = resolveRuntimeArtifactLayout(runtime, configDir, 'local');
      applySurface(configDir, layout, manifest, CLUSTERS);

      // Collect every SKILL.md body under ${configDir}/skills/
      const skillsRoot = path.join(configDir, 'skills');
      const skillBodies = [];
      if (fs.existsSync(skillsRoot)) {
        for (const dirEntry of fs.readdirSync(skillsRoot)) {
          const skillMd = path.join(skillsRoot, dirEntry, 'SKILL.md');
          if (fs.existsSync(skillMd)) {
            skillBodies.push(fs.readFileSync(skillMd, 'utf8'));
          }
        }
      }

      // (a) Sanity: at least one SKILL.md must have been staged
      assert.ok(
        skillBodies.length > 0,
        `applySurface must stage at least one ${runtime} SKILL.md under ${skillsRoot}/ but found none`
      );

      // (b) BUG SYMPTOM (#813): after the rewrite, no body should contain '~/.claude/'
      //     or '$HOME/.claude/' — both are converter-default forms that must be eliminated.
      //     This assertion FAILS on unpatched code — applySurface does not call
      //     applyRuntimeContentRewritesInPlace, so the converter's default ~/.claude/
      //     paths are left verbatim in the staged files.
      const bodiesWithTildeClaude = skillBodies.filter(b => b.includes('~/.claude/') || b.includes('$HOME/.claude/'));
      assert.strictEqual(
        bodiesWithTildeClaude.length,
        0,
        `#813 regression: ${bodiesWithTildeClaude.length} ${runtime} SKILL.md(s) still contain '~/.claude/' or '$HOME/.claude/' after applySurface — ` +
        `applyRuntimeContentRewritesInPlace was not applied (mirrors installRuntimeArtifacts' rewrite step)`
      );

      // (c) The rewrite must inject the real install target path, not just remove the tilde.
      //     This also fails on unpatched code for the same reason.
      //     NOTE: this assertion depends on the command corpus emitting rewritable
      //     '~/.claude/'-style paths in at least one skill body. If a future corpus
      //     change removes all such paths, this assertion will become vacuously true
      //     (no body will contain configDirPrefix either) — update the test rather than
      //     treating a silent zero-match as a pass.
      // Production derives pathPrefix as `path.resolve(configDir).replace(/\\/g, '/')`
      // (mirrors installRuntimeArtifacts), so on Windows the rewritten body uses
      // forward slashes. Normalize the expected prefix the same way so this assertion
      // is cross-platform (Windows CI leg is not covered by local gsd-test) (#813).
      const configDirPrefix = `${path.resolve(configDir).replace(/\\/g, '/')}/`;
      const bodiesWithAbsolutePrefix = skillBodies.filter(b => b.includes(configDirPrefix));
      assert.ok(
        bodiesWithAbsolutePrefix.length > 0,
        `#813 regression: no ${runtime} SKILL.md contains the absolute configDir prefix '${configDirPrefix}' — ` +
        `the path rewrite was not applied by applySurface. ` +
        `(If the command corpus no longer emits any '~/.claude/'-style paths, update this test.)`
      );
    });
  }
});

// ─── resolveSurface ──────────────────────────────────────────────────────────

describe('resolveSurface', () => {
  test('no surface state + core base profile → identical to resolveProfile core', () => {
    const dir = tmpDir('gsd-surface-resolve-');
    try {
      writeActiveProfile(dir, 'core');
      const manifest = realManifest();
      const surfaceResolved = resolveSurface(dir, manifest, CLUSTERS);
      const profileResolved = resolveProfile({ modes: ['core'], manifest });

      assert.ok(surfaceResolved.skills instanceof Set);
      assert.ok(profileResolved.skills instanceof Set);
      assert.deepStrictEqual(
        [...surfaceResolved.skills].sort(),
        [...profileResolved.skills].sort(),
        'surface with no state should equal profile resolution'
      );
    } finally {
      cleanup(dir);
    }
  });

  test('standard base + disabledClusters:["utility"] removes utility skills', () => {
    const dir = tmpDir('gsd-surface-resolve-');
    try {
      writeActiveProfile(dir, 'standard');
      writeSurface(dir, {
        baseProfile: 'standard',
        disabledClusters: ['utility'],
        explicitAdds: [],
        explicitRemoves: [],
      });
      const manifest = realManifest();
      const resolved = resolveSurface(dir, manifest, CLUSTERS);

      assert.ok(resolved.skills instanceof Set);
      for (const stem of CLUSTERS.utility) {
        const standardResolved = resolveProfile({ modes: ['standard'], manifest });
        if (standardResolved.skills.has(stem)) {
          assert.ok(
            !resolved.skills.has(stem),
            `"${stem}" should be removed by disabling utility cluster`
          );
        }
      }
    } finally {
      cleanup(dir);
    }
  });

  test('explicitAdds:["sketch"] adds sketch to a core install', () => {
    const dir = tmpDir('gsd-surface-resolve-');
    try {
      writeActiveProfile(dir, 'core');
      writeSurface(dir, {
        baseProfile: 'core',
        disabledClusters: [],
        explicitAdds: ['sketch'],
        explicitRemoves: [],
      });
      const manifest = realManifest();
      const resolved = resolveSurface(dir, manifest, CLUSTERS);

      assert.ok(resolved.skills instanceof Set);
      assert.ok(resolved.skills.has('sketch'), 'sketch must be in resolved skills');

      const sketchRequires = manifest.get('sketch') || [];
      for (const dep of sketchRequires) {
        assert.ok(resolved.skills.has(dep), `transitive dep "${dep}" of sketch must be present`);
      }
    } finally {
      cleanup(dir);
    }
  });

  test('explicitRemoves removes individual skill stems', () => {
    const dir = tmpDir('gsd-surface-resolve-');
    try {
      writeSurface(dir, {
        baseProfile: 'standard',
        disabledClusters: [],
        explicitAdds: [],
        explicitRemoves: ['progress'],
      });
      writeActiveProfile(dir, 'standard');
      const manifest = realManifest();
      const resolved = resolveSurface(dir, manifest, CLUSTERS);

      assert.ok(!resolved.skills.has('progress'), '"progress" must be removed by explicitRemoves');
    } finally {
      cleanup(dir);
    }
  });

  test('result is a Set<string> with name property and agents Set', () => {
    const dir = tmpDir('gsd-surface-resolve-');
    try {
      writeActiveProfile(dir, 'core');
      const manifest = realManifest();
      const resolved = resolveSurface(dir, manifest, CLUSTERS);

      assert.ok(resolved.skills instanceof Set);
      assert.ok(typeof resolved.name === 'string');
      assert.ok(resolved.agents instanceof Set);
    } finally {
      cleanup(dir);
    }
  });

  test('surface with baseProfile overrides .gsd-profile marker', () => {
    const dir = tmpDir('gsd-surface-resolve-');
    try {
      writeActiveProfile(dir, 'core');
      writeSurface(dir, {
        baseProfile: 'standard',
        disabledClusters: [],
        explicitAdds: [],
        explicitRemoves: [],
      });
      const manifest = realManifest();
      const resolved = resolveSurface(dir, manifest, CLUSTERS);
      const standardResolved = resolveProfile({ modes: ['standard'], manifest });

      assert.deepStrictEqual(
        [...resolved.skills].sort(),
        [...standardResolved.skills].sort(),
        'surface baseProfile takes precedence over marker'
      );
    } finally {
      cleanup(dir);
    }
  });

  test('disabled cluster + explicitAdds can re-add specific skills from disabled cluster', () => {
    const dir = tmpDir('gsd-surface-resolve-');
    try {
      writeSurface(dir, {
        baseProfile: 'standard',
        disabledClusters: ['workspace_state'],
        explicitAdds: ['capture'],
        explicitRemoves: [],
      });
      writeActiveProfile(dir, 'standard');
      const manifest = realManifest();
      const resolved = resolveSurface(dir, manifest, CLUSTERS);

      assert.ok(resolved.skills.has('capture'), '"capture" must be present via explicitAdds');
      const standardResolved = resolveProfile({ modes: ['standard'], manifest });
      for (const stem of CLUSTERS.workspace_state) {
        if (stem === 'capture') continue;
        if (standardResolved.skills.has(stem)) {
          assert.ok(
            !resolved.skills.has(stem),
            `"${stem}" should be removed (workspace_state disabled, not explicitly re-added)`
          );
        }
      }
    } finally {
      cleanup(dir);
    }
  });
});

// ─── readSurface / writeSurface ──────────────────────────────────────────────

describe('readSurface / writeSurface', () => {
  test('round-trips a complete surface state', () => {
    const dir = tmpDir('gsd-surface-state-');
    try {
      const state = {
        baseProfile: 'standard',
        disabledClusters: ['utility'],
        explicitAdds: ['sketch'],
        explicitRemoves: [],
      };
      writeSurface(dir, state);
      const read = readSurface(dir);
      assert.deepStrictEqual(read, state);
    } finally {
      cleanup(dir);
    }
  });

  test('round-trips empty arrays', () => {
    const dir = tmpDir('gsd-surface-state-');
    try {
      const state = {
        baseProfile: 'core',
        disabledClusters: [],
        explicitAdds: [],
        explicitRemoves: [],
      };
      writeSurface(dir, state);
      assert.deepStrictEqual(readSurface(dir), state);
    } finally {
      cleanup(dir);
    }
  });

  test('round-trips composed base profile', () => {
    const dir = tmpDir('gsd-surface-state-');
    try {
      const state = {
        baseProfile: 'core,audit',
        disabledClusters: [],
        explicitAdds: [],
        explicitRemoves: ['health'],
      };
      writeSurface(dir, state);
      assert.deepStrictEqual(readSurface(dir), state);
    } finally {
      cleanup(dir);
    }
  });

  test('missing file returns null', () => {
    const dir = tmpDir('gsd-surface-state-');
    try {
      const result = readSurface(dir);
      assert.strictEqual(result, null);
    } finally {
      cleanup(dir);
    }
  });

  test('non-existent directory returns null', () => {
    const ghost = path.join(os.tmpdir(), 'gsd-surface-no-exist-' + Date.now());
    const result = readSurface(ghost);
    assert.strictEqual(result, null);
  });

  test('corrupt JSON returns null', () => {
    const dir = tmpDir('gsd-surface-state-');
    try {
      fs.writeFileSync(path.join(dir, '.gsd-surface.json'), '{not valid json', 'utf8');
      const result = readSurface(dir);
      assert.strictEqual(result, null);
    } finally {
      cleanup(dir);
    }
  });

  test('JSON missing baseProfile field returns null', () => {
    const dir = tmpDir('gsd-surface-state-');
    try {
      fs.writeFileSync(
        path.join(dir, '.gsd-surface.json'),
        JSON.stringify({ disabledClusters: [], explicitAdds: [], explicitRemoves: [] }),
        'utf8'
      );
      const result = readSurface(dir);
      assert.strictEqual(result, null);
    } finally {
      cleanup(dir);
    }
  });

  test('JSON with non-array disabledClusters returns null', () => {
    const dir = tmpDir('gsd-surface-state-');
    try {
      fs.writeFileSync(
        path.join(dir, '.gsd-surface.json'),
        JSON.stringify({ baseProfile: 'standard', disabledClusters: 'utility', explicitAdds: [], explicitRemoves: [] }),
        'utf8'
      );
      const result = readSurface(dir);
      assert.strictEqual(result, null);
    } finally {
      cleanup(dir);
    }
  });

  test('atomic write: result file is never a partial tmp file', () => {
    const dir = tmpDir('gsd-surface-state-');
    try {
      const state = { baseProfile: 'full', disabledClusters: [], explicitAdds: [], explicitRemoves: [] };
      writeSurface(dir, state);
      const files = fs.readdirSync(dir);
      const tmpFiles = files.filter(f => f.includes('.tmp.'));
      assert.deepStrictEqual(tmpFiles, [], 'no tmp files should remain after write');
      assert.ok(files.includes('.gsd-surface.json'));
    } finally {
      cleanup(dir);
    }
  });

  test('second write overwrites first', () => {
    const dir = tmpDir('gsd-surface-state-');
    try {
      writeSurface(dir, { baseProfile: 'core', disabledClusters: [], explicitAdds: [], explicitRemoves: [] });
      writeSurface(dir, { baseProfile: 'standard', disabledClusters: ['utility'], explicitAdds: [], explicitRemoves: [] });
      const read = readSurface(dir);
      assert.strictEqual(read.baseProfile, 'standard');
      assert.deepStrictEqual(read.disabledClusters, ['utility']);
    } finally {
      cleanup(dir);
    }
  });

  test('writeSurface creates directory if it does not exist', () => {
    const base = tmpDir('gsd-surface-state-');
    const nested = path.join(base, 'skills', 'subdir');
    try {
      writeSurface(nested, { baseProfile: 'full', disabledClusters: [], explicitAdds: [], explicitRemoves: [] });
      assert.ok(fs.existsSync(nested));
      assert.ok(readSurface(nested) !== null);
    } finally {
      cleanup(base);
    }
  });
});

// ─── CLUSTERS data structure ─────────────────────────────────────────────────

describe('CLUSTERS data structure', () => {
  test('no cluster is empty', () => {
    for (const [name, members] of Object.entries(CLUSTERS)) {
      assert.ok(members.length > 0, `cluster ${name} must not be empty`);
    }
  });

  test('every cluster member is a real skill stem in commands/gsd/', () => {
    const entries = fs.readdirSync(REAL_COMMANDS_DIR, { withFileTypes: true });
    const realStems = new Set(
      entries
        .filter(e => e.isFile() && e.name.endsWith('.md'))
        .map(e => e.name.slice(0, -3))
    );
    const mismatches = [];
    for (const [cluster, members] of Object.entries(CLUSTERS)) {
      for (const stem of members) {
        if (!realStems.has(stem)) {
          mismatches.push(`${cluster}: "${stem}" not found in commands/gsd/`);
        }
      }
    }
    assert.deepStrictEqual(mismatches, [], `Cluster members missing from disk:\n${mismatches.join('\n')}`);
  });

  test('union of all clusters covers every skill in commands/gsd/', () => {
    const entries = fs.readdirSync(REAL_COMMANDS_DIR, { withFileTypes: true });
    const realStems = new Set(
      entries
        .filter(e => e.isFile() && e.name.endsWith('.md'))
        .map(e => e.name.slice(0, -3))
    );
    const clustered = allClusteredSkills();
    const uncategorized = [];
    for (const stem of realStems) {
      if (!clustered.has(stem)) uncategorized.push(stem);
    }
    assert.deepStrictEqual(
      uncategorized,
      [],
      `Uncategorized skills (not in any cluster):\n${uncategorized.sort().join('\n')}`
    );
  });

  test('CLUSTERS is frozen (immutable)', () => {
    assert.ok(Object.isFrozen(CLUSTERS), 'CLUSTERS must be frozen');
    for (const [name, members] of Object.entries(CLUSTERS)) {
      assert.ok(Object.isFrozen(members), `CLUSTERS.${name} must be frozen`);
    }
  });

  test('cluster names contain the expected set from research memo §3.2', () => {
    const expectedClusterNames = new Set([
      'core_loop',
      'audit_review',
      'milestone',
      'research_ideate',
      'workspace_state',
      'docs',
      'ui',
      'ai_eval',
      'ns_meta',
      'utility',
    ]);
    const actualClusterNames = new Set(Object.keys(CLUSTERS));
    for (const name of expectedClusterNames) {
      assert.ok(actualClusterNames.has(name), `expected cluster "${name}" missing from CLUSTERS`);
    }
  });

  test('allClusteredSkills returns a Set containing all cluster members', () => {
    const result = allClusteredSkills();
    assert.ok(result instanceof Set, 'allClusteredSkills() must return a Set');
    for (const members of Object.values(CLUSTERS)) {
      for (const stem of members) {
        assert.ok(result.has(stem), `allClusteredSkills() missing "${stem}"`);
      }
    }
  });
});

// ─── listSurface ─────────────────────────────────────────────────────────────

describe('listSurface', () => {
  test('accepts parsed gsd-file-manifest JSON objects without crashing (#322)', () => {
    const dir = tmpDir('gsd-surface-list-');
    try {
      fs.writeFileSync(path.join(dir, '.gsd-source'), REAL_COMMANDS_DIR, 'utf8');
      writeActiveProfile(dir, 'core');
      const diskManifestShape = {
        version: '1.0.0',
        timestamp: new Date().toISOString(),
        mode: 'core',
        files: {},
      };
      const result = listSurface(dir, diskManifestShape, CLUSTERS);

      assert.ok(Array.isArray(result.enabled), 'enabled must be array');
      assert.ok(Array.isArray(result.disabled), 'disabled must be array');
      assert.ok(typeof result.tokenCost === 'number', 'tokenCost must be number');
    } finally {
      cleanup(dir);
    }
  });

  test('returns { enabled, disabled, tokenCost } structure', () => {
    const dir = tmpDir('gsd-surface-list-');
    try {
      fs.writeFileSync(path.join(dir, '.gsd-source'), REAL_COMMANDS_DIR, 'utf8');
      writeActiveProfile(dir, 'core');
      const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
      const result = listSurface(dir, manifest, CLUSTERS);

      assert.ok(Array.isArray(result.enabled), 'enabled must be array');
      assert.ok(Array.isArray(result.disabled), 'disabled must be array');
      assert.ok(typeof result.tokenCost === 'number', 'tokenCost must be number');
      assert.ok(result.tokenCost >= 0, 'tokenCost must be non-negative');
    } finally {
      cleanup(dir);
    }
  });

  test('core profile: enabled has fewer skills than full; enabled + disabled = total stems', () => {
    const dir = tmpDir('gsd-surface-list-');
    try {
      fs.writeFileSync(path.join(dir, '.gsd-source'), REAL_COMMANDS_DIR, 'utf8');
      writeActiveProfile(dir, 'core');
      const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
      const coreList = listSurface(dir, manifest, CLUSTERS);

      const totalStems = [...manifest.keys()].filter(k => !k.startsWith('_calls_agents_')).length;
      assert.ok(
        coreList.enabled.length < totalStems,
        'core should enable fewer skills than total'
      );
      assert.ok(coreList.disabled.length > 0, 'core should have some disabled skills');
      assert.ok(coreList.enabled.length + coreList.disabled.length === totalStems,
        'enabled + disabled must equal total stems');
    } finally {
      cleanup(dir);
    }
  });

  test('disabling utility cluster reduces enabled count', () => {
    const dir = tmpDir('gsd-surface-list-');
    try {
      fs.writeFileSync(path.join(dir, '.gsd-source'), REAL_COMMANDS_DIR, 'utf8');
      writeActiveProfile(dir, 'standard');
      const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);

      const beforeList = listSurface(dir, manifest, CLUSTERS);

      writeSurface(dir, {
        baseProfile: 'standard',
        disabledClusters: ['utility'],
        explicitAdds: [],
        explicitRemoves: [],
      });
      const afterList = listSurface(dir, manifest, CLUSTERS);

      assert.ok(afterList.enabled.length <= beforeList.enabled.length,
        'disabling utility cluster should not increase enabled count');
      assert.ok(afterList.tokenCost <= beforeList.tokenCost,
        'disabling a cluster should not increase token cost');
    } finally {
      cleanup(dir);
    }
  });

  test('tokenCost is sum of description char lengths ÷ 4 for enabled skills', () => {
    const dir = tmpDir('gsd-surface-list-');
    try {
      fs.writeFileSync(path.join(dir, '.gsd-source'), REAL_COMMANDS_DIR, 'utf8');
      writeActiveProfile(dir, 'core');
      const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
      const result = listSurface(dir, manifest, CLUSTERS);

      let expected = 0;
      for (const stem of result.enabled) {
        const filePath = path.join(REAL_COMMANDS_DIR, `${stem}.md`);
        if (!fs.existsSync(filePath)) continue;
        const markdown = fs.readFileSync(filePath, 'utf8');
        const description = readFrontmatterDescription(markdown);
        if (description) expected += Math.ceil(description.length / 4);
      }

      assert.strictEqual(result.tokenCost, expected, 'tokenCost must equal sum of description lengths ÷ 4');
    } finally {
      cleanup(dir);
    }
  });

  test('enabled and disabled arrays are sorted', () => {
    const dir = tmpDir('gsd-surface-list-');
    try {
      fs.writeFileSync(path.join(dir, '.gsd-source'), REAL_COMMANDS_DIR, 'utf8');
      writeActiveProfile(dir, 'standard');
      const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
      const result = listSurface(dir, manifest, CLUSTERS);

      assert.deepStrictEqual(result.enabled, [...result.enabled].sort());
      assert.deepStrictEqual(result.disabled, [...result.disabled].sort());
    } finally {
      cleanup(dir);
    }
  });
});

// ─── #1615: applySurface must rewrite commands kind (Windsurf workflows) ─────
// Adversarial review of PR #1622 found that applySurface only rewrites 'skills'
// kinds, skipping 'commands'. Windsurf's capability now stages workflow files
// as kind='commands'; without the rewrite, /gsd-surface would write workflow
// bodies containing raw @~/.claude/... references that don't exist on a
// Windsurf install. The same gap affected any runtime with commands kinds.
describe('applySurface — commands kind path rewrite (#1615 adversarial review)', () => {
  test('windsurf workflow bodies are rewritten to install target (no raw ~/.claude/)', (t) => {
    const base = createTempDir('gsd-surface-cmds-windsurf-');
    t.after(() => cleanup(base));
    const runtimeConfigDir = base;

    // Stage the canonical command body the workflow delegates to.
    const canonicalDir = path.join(runtimeConfigDir, 'gsd-core', 'commands', 'gsd');
    fs.mkdirSync(canonicalDir, { recursive: true });
    fs.writeFileSync(path.join(canonicalDir, 'help.md'),
      '---\nname: help\ndescription: Show help\n---\n\nHelp body\n');

    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const layout = resolveRuntimeArtifactLayout('windsurf', runtimeConfigDir, 'local');

    // Sanity: layout must have a commands kind (workflows) — pre-condition
    // introduced by PR #1622; if a future refactor removes it, this test
    // would silently pass without exercising the rewrite path.
    const commandsKind = layout.kinds.find((k) => k.kind === 'commands');
    assert.ok(commandsKind, 'pre-condition: windsurf layout has a commands kind');

    applySurface(runtimeConfigDir, layout, manifest, CLUSTERS);

    // Workflow files should be written to <configDir>/workflows/gsd-*.md
    const workflowsDir = path.join(runtimeConfigDir, 'workflows');
    const workflowFiles = fs.existsSync(workflowsDir)
      ? fs.readdirSync(workflowsDir).filter((f) => f.startsWith('gsd-') && f.endsWith('.md'))
      : [];
    assert.ok(workflowFiles.length > 0,
      `expected at least one gsd-*.md workflow under ${workflowsDir}; got [${workflowFiles.join(', ')}]`);

    // Every workflow body must reference the install target, NOT the raw
    // ~/.claude/ path. This is the regression: pre-fix, the commands kind
    // was skipped and raw @~/.claude/... survived into the synced file.
    for (const fileName of workflowFiles) {
      const workflowPath = path.join(workflowsDir, fileName);
      const content = fs.readFileSync(workflowPath, 'utf8');
      assert.ok(
        !content.includes('~/.claude/'),
        `${fileName} must not contain raw ~/.claude/ after applySurface rewrite (got: ${content.slice(0, 200)})`,
      );
      assert.ok(
        !content.includes('$HOME/.claude/'),
        `${fileName} must not contain raw $HOME/.claude/ after applySurface rewrite`,
      );
    }
  });
});

// ─── #2911: skills-kind destination parity (installer vs surface-apply) ──────
//
// _copyStaged (src/install-engine.cts) resolves the write root as
// `kind.home ?? layout.configDir`. Before the #2911 fix, applySurface's
// _syncGsdDir call always resolved against `layout.configDir`, ignoring
// `kind.home`. For runtimes whose skills kind declares a `home` override
// (currently only codex: home='.agents' at GLOBAL scope — see
// capabilities/codex/capability.json), a fresh install landed skills under
// the override root while a surface re-stage created a SECOND tree under
// the runtime's own configDir.
//
// These tests exercise the REAL applySurface code path (not a hand-copy of
// its destination formula) so a future regression that re-diverges the two
// writers is caught by actual file placement, not by a self-consistent
// re-derivation of the (possibly still-buggy) formula.
describe('skills-kind destination parity: installer vs surface-apply (#2911)', () => {
  const runtimeArtifactInstallPlan = require('../gsd-core/bin/lib/runtime-artifact-install-plan.cjs');
  const capabilityRegistry = require('../gsd-core/bin/lib/capability-registry.cjs');

  const RUNTIME_IDS = Object.keys(capabilityRegistry.runtimes);
  const PARITY_MANIFEST = loadSkillsManifest(REAL_COMMANDS_DIR);

  // os.homedir() on POSIX/Windows reads HOME/USERPROFILE from the environment
  // (Node docs), so redirecting it here for the duration of a test is safe and
  // avoids ever touching the real developer home directory even though the
  // only current `home`-override runtime (codex) resolves via os.homedir().
  function withFakeHome(fakeHome, fn) {
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    // #3712: record WHICH home this sandboxed to. src/real-home-guard.cts fails
    // closed on hosts with no readable passwd entry, and this is what proves a
    // genuinely-sandboxed caller there. Without it these calls would be refused.
    const savedMarker = process.env.GSD_TEST_HOME_SANDBOX;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.GSD_TEST_HOME_SANDBOX = fakeHome;
    try {
      return fn();
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
      if (savedMarker === undefined) delete process.env.GSD_TEST_HOME_SANDBOX;
      else process.env.GSD_TEST_HOME_SANDBOX = savedMarker;
    }
  }

  // Runtimes whose registry entry declares a `home` override on any kind —
  // stated explicitly per the #2911 acceptance criteria, not hidden. Recomputed
  // from the registry (not hardcoded) so a newly-added override is picked up.
  function runtimesWithHomeOverride() {
    const found = [];
    for (const runtime of RUNTIME_IDS) {
      for (const scope of ['global', 'local']) {
        let layout;
        try {
          layout = resolveRuntimeArtifactLayout(runtime, '/tmp/fake-config-dir-2911', scope);
        } catch {
          continue;
        }
        if (layout.kinds.some((k) => typeof k.home === 'string' && k.home !== '')) {
          found.push(`${runtime}/${scope}`);
        }
      }
    }
    return found;
  }

  test('registry home-override discrimination report (#2911)', () => {
    const overrides = runtimesWithHomeOverride();
    // Stated per the brief: at time of writing only codex/global had a `home`
    // override; #3738 added antigravity/global (skills AND agents →
    // ~/.gemini/config, the dir AGY scans). This parity test discriminates on
    // exactly these runtime/scope pairs. This assertion documents that fact and
    // fails loudly if the set ever changes shape unexpectedly empty (a
    // discrimination-less parity test would be silently vacuous).
    assert.ok(overrides.length > 0, 'expected at least one runtime/scope with a home override (codex/global)');
    assert.deepStrictEqual(overrides, ['antigravity/global', 'codex/global'], `home-override set changed — update this test's documentation. Found: ${overrides.join(', ')}`);
  });

  for (const scope of ['global', 'local']) {
    test(`applySurface writes skills-kind output to the SAME destination the installer would use, for every runtime in the registry (${scope})`, (t) => {
      const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2911-fakehome-'));
      t.after(() => cleanup(fakeHome));

      const failures = [];
      let discriminatingRuntimes = 0;

      for (const runtime of RUNTIME_IDS) {
        const configDir = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-2911-parity-${runtime}-${scope}-`));
        t.after(() => cleanup(configDir));

        withFakeHome(fakeHome, () => {
          let layout;
          try {
            layout = resolveRuntimeArtifactLayout(runtime, configDir, scope);
          } catch {
            return; // runtime/scope combination not supported
          }
          const skillsKind = layout.kinds.find((k) => k.kind === 'skills');
          if (!skillsKind) return; // e.g. cline/kimi at local scope: no skills kind

          if (typeof skillsKind.home === 'string' && skillsKind.home !== '') {
            discriminatingRuntimes++;
          }

          writeActiveProfile(configDir, 'core');
          writeSurface(configDir, {
            baseProfile: 'core',
            disabledClusters: [],
            explicitAdds: [],
            explicitRemoves: [],
          });

          applySurface(configDir, layout, PARITY_MANIFEST, CLUSTERS);

          // The installer's REAL destination-selection formula (verbatim from
          // createRuntimeArtifactInstallPlan / _copyStaged): honor kind.home as
          // a FALLBACK-preferred override, else configDir.
          const installerDest = runtimeArtifactInstallPlan.assertDestWithinConfigHome(
            skillsKind.home ?? layout.configDir,
            skillsKind.destSubpath,
          );

          if (!fs.existsSync(installerDest) || fs.readdirSync(installerDest).length === 0) {
            failures.push(
              `${runtime}/${scope}: applySurface did NOT write skills-kind output to the installer's ` +
              `destination "${installerDest}" — surface-apply and installer destination formulas have diverged.`,
            );
            return;
          }

          // If the runtime declares a home override, the OLD buggy root
          // (configDir/destSubpath) must not have ALSO been populated —
          // otherwise a re-stage creates a second, stale tree (#2911 symptom).
          if (typeof skillsKind.home === 'string' && skillsKind.home !== '') {
            const legacyDest = path.join(layout.configDir, skillsKind.destSubpath);
            if (legacyDest !== installerDest && fs.existsSync(legacyDest) && fs.readdirSync(legacyDest).length > 0) {
              failures.push(
                `${runtime}/${scope}: applySurface ALSO wrote a second tree at the legacy location ` +
                `"${legacyDest}" (kind.home override "${skillsKind.home}" was not honored consistently).`,
              );
            }
          }
        });
      }

      assert.deepStrictEqual(failures, [], `#2911 parity failures (${scope}):\n${failures.join('\n')}`);
      // Not a hard requirement, but surfaces how many runtime/scope pairs this
      // run actually discriminated on (i.e. exercised a non-trivial home
      // override), matching the acceptance-criteria ask to state this plainly.
      t.diagnostic(`${scope}: ${discriminatingRuntimes} runtime(s) discriminated on a home override`);
    });
  }
});

// ─── #2911: codex-specific regression (skills-kind home override) ───────────
describe('codex skills-kind destination: home override (#2911)', () => {
  const runtimeArtifactInstallPlan = require('../gsd-core/bin/lib/runtime-artifact-install-plan.cjs');

  function withFakeHome(fakeHome, fn) {
    const savedHome = process.env.HOME;
    const savedUserProfile = process.env.USERPROFILE;
    // #3712: record WHICH home this sandboxed to. src/real-home-guard.cts fails
    // closed on hosts with no readable passwd entry, and this is what proves a
    // genuinely-sandboxed caller there. Without it these calls would be refused.
    const savedMarker = process.env.GSD_TEST_HOME_SANDBOX;
    process.env.HOME = fakeHome;
    process.env.USERPROFILE = fakeHome;
    process.env.GSD_TEST_HOME_SANDBOX = fakeHome;
    try {
      return fn();
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      if (savedUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = savedUserProfile;
      if (savedMarker === undefined) delete process.env.GSD_TEST_HOME_SANDBOX;
      else process.env.GSD_TEST_HOME_SANDBOX = savedMarker;
    }
  }

  test('codex + global: applySurface stages skills under $HOME/.agents, NOT under $CODEX_HOME (#2911 AC)', (t) => {
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2911-codex-home-'));
    t.after(() => cleanup(fakeHome));
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2911-codex-home-dir-'));
    t.after(() => cleanup(codexHome));

    withFakeHome(fakeHome, () => {
      const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
      writeActiveProfile(codexHome, 'core');
      writeSurface(codexHome, {
        baseProfile: 'core',
        disabledClusters: [],
        explicitAdds: [],
        explicitRemoves: [],
      });
      const layout = resolveRuntimeArtifactLayout('codex', codexHome, 'global');
      const skillsKind = layout.kinds.find((k) => k.kind === 'skills');
      assert.ok(skillsKind, 'pre-condition: codex global layout has a skills kind');
      assert.strictEqual(skillsKind.home, path.join(fakeHome, '.agents'), 'pre-condition: codex skills kind declares the $HOME/.agents override');

      applySurface(codexHome, layout, manifest, CLUSTERS);

      const expectedDest = runtimeArtifactInstallPlan.assertDestWithinConfigHome(
        path.join(fakeHome, '.agents'),
        skillsKind.destSubpath,
      );
      assert.ok(
        fs.existsSync(expectedDest) && fs.readdirSync(expectedDest).length > 0,
        `#2911: codex global surface-apply must stage skills under $HOME/.agents (expected non-empty dir at ${expectedDest})`,
      );

      const wrongDest = path.join(codexHome, skillsKind.destSubpath);
      assert.ok(
        !fs.existsSync(wrongDest) || fs.readdirSync(wrongDest).length === 0,
        `#2911: codex global surface-apply must NOT create a second skills tree under $CODEX_HOME (found populated dir at ${wrongDest})`,
      );
    });
  });

  test('codex + local: no home override — surface-apply destination is unchanged (#2911 AC3)', (t) => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2911-codex-local-'));
    t.after(() => cleanup(codexHome));

    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    writeActiveProfile(codexHome, 'core');
    writeSurface(codexHome, {
      baseProfile: 'core',
      disabledClusters: [],
      explicitAdds: [],
      explicitRemoves: [],
    });
    const layout = resolveRuntimeArtifactLayout('codex', codexHome, 'local');
    const skillsKind = layout.kinds.find((k) => k.kind === 'skills');
    assert.ok(skillsKind, 'pre-condition: codex local layout has a skills kind');
    assert.strictEqual(skillsKind.home, undefined, 'pre-condition (AC3): codex local scope declares NO home override');

    applySurface(codexHome, layout, manifest, CLUSTERS);

    const expectedDest = runtimeArtifactInstallPlan.assertDestWithinConfigHome(codexHome, skillsKind.destSubpath);
    assert.ok(
      fs.existsSync(expectedDest) && fs.readdirSync(expectedDest).length > 0,
      `#2911 AC3: codex local surface-apply must stage skills under $CODEX_HOME (expected non-empty dir at ${expectedDest})`,
    );
  });
});

// ─── installOpencodeFamilySkills destination parity (#2911 sibling coverage) ─
//
// installOpencodeFamilySkills (src/install-engine.cts) is a FOURTH destination-
// computation writer, alongside _copyStaged, the inline guard in
// installRuntimeArtifacts, and createRuntimeArtifactUninstallPlan — all three of
// which honor `skillsKindEntry.home ?? <install root>`. This writer originally did
// not, and would silently reproduce the #2911 duplicate-tree symptom the moment
// any combined-family runtime (opencode, kilo) gains a `home` override. Neither
// declares one today, so this test exercises the REAL production code path
// (installOpencodeFamilySkills, via the module-ref call convention documented at
// src/install-engine.cts:37-38) under a synthetic `home` override injected by
// monkeypatching resolveRuntimeArtifactLayout's shared module export — the same
// object install-engine.cjs calls through at runtime — rather than re-deriving
// the destination formula by hand. This proves discrimination even though no
// registry runtime exercises it yet, and will catch a future divergence the
// moment a combined-family runtime's descriptor grows a `home` override.
describe('installOpencodeFamilySkills destination parity (#2911 sibling coverage)', () => {
  const installEngine = require('../gsd-core/bin/lib/install-engine.cjs');
  const runtimeArtifactLayoutModule = require('../gsd-core/bin/lib/runtime-artifact-layout.cjs');

  function stageRawCommands(runtime, configDir) {
    const layout = resolveRuntimeArtifactLayout(runtime, configDir, 'global');
    const commandsKind = layout.kinds.find((k) => k.kind === 'commands');
    return commandsKind.stage(resolveProfile({ modes: ['core'], manifest: loadSkillsManifest(REAL_COMMANDS_DIR) }));
  }

  for (const runtime of ['opencode', 'kilo']) {
    test(`${runtime}: installOpencodeFamilySkills honors a skills-kind home override instead of always resolving against configDir (#2911 sibling)`, (t) => {
      const configDir = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-2911-ocfs-${runtime}-`));
      const fakeHomeOverride = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-2911-ocfs-home-${runtime}-`));
      t.after(() => { cleanup(configDir); cleanup(fakeHomeOverride); });
      // #3712 — this row drives a skills-kind `home` override on purpose, which is
      // exactly what the test-home guard exists to police, so it has to declare the
      // sandbox rather than rely on the destination happening to sit outside the
      // real home. On POSIX it does (os.tmpdir() is /tmp or /var/folders); on
      // Windows os.tmpdir() is under %USERPROFILE%, so without this the guard
      // correctly refuses and the row fails on Windows only. HOME is the override
      // itself, which is the home this call actually writes under.
      sandboxHome(t, fakeHomeOverride);

      const originalResolve = runtimeArtifactLayoutModule.resolveRuntimeArtifactLayout;
      // Capture the real destSubpath before patching so the assertion below
      // never hardcodes a literal path fragment.
      const realLayout = originalResolve(runtime, configDir, 'global');
      const skillsKindReal = realLayout.kinds.find((k) => k.kind === 'skills');
      assert.ok(skillsKindReal, `pre-condition: ${runtime} global layout has a skills kind`);

      runtimeArtifactLayoutModule.resolveRuntimeArtifactLayout = function (rt, targetDir, scope) {
        const layout = originalResolve(rt, targetDir, scope);
        if (rt === runtime) {
          const patchedKinds = layout.kinds.map((k) => (k.kind === 'skills' ? { ...k, home: fakeHomeOverride } : k));
          return { ...layout, kinds: patchedKinds };
        }
        return layout;
      };

      try {
        const raw = stageRawCommands(runtime, configDir);
        const count = installEngine.installOpencodeFamilySkills(runtime, configDir, raw, `${configDir}/`);
        assert.ok(count >= 1, `${runtime}: installOpencodeFamilySkills should report installed skills`);

        const overrideDest = path.join(fakeHomeOverride, skillsKindReal.destSubpath);
        assert.ok(
          fs.existsSync(overrideDest) && fs.readdirSync(overrideDest).length > 0,
          `${runtime}: installOpencodeFamilySkills must write skills-kind output under the home override ` +
          `"${overrideDest}" — it must not always resolve against configDir.`,
        );

        // If the home override is not honored, output lands under the legacy
        // configDir/destSubpath location instead (the #2911 duplicate-tree symptom).
        const legacyDest = path.join(configDir, skillsKindReal.destSubpath);
        assert.ok(
          !fs.existsSync(legacyDest) || fs.readdirSync(legacyDest).length === 0,
          `${runtime}: installOpencodeFamilySkills must NOT ALSO write a second tree at the legacy location ` +
          `"${legacyDest}" once a home override is declared.`,
        );
      } finally {
        runtimeArtifactLayoutModule.resolveRuntimeArtifactLayout = originalResolve;
      }
    });
  }
});

// ────────────────────────────────────────────────────────────────────────
// Folded from tests/issue-69-surface-keeps-nested.test.cjs — consolidation epic #1969 (H3 #3336)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe('folded:issue-69-surface-keeps-nested', () => {

// #69 regression, folded from issue-69-surface-keeps-nested.test.cjs:
// stageSkillsForRuntimeAsSkills gated nesting on `resolvedProfile.skills === '*'`
// (the sentinel). applySurface → resolveSurface materializes the full profile
// into a concrete Set<string>, so the sentinel check was never true on the
// surface path, causing applySurface to re-flatten a nested install. Fix
// (install-profiles.cts): gate nesting on full OR full-equivalent (all
// routerStems present in the concrete Set).
//
// #924: Claude was reverted to FLAT, so the claude case below asserts the
// flat layout is preserved (not re-nested) rather than a nested one.
describe('issue-69: applySurface preserves nested skill layout (no re-flatten)', () => {
  test('cline global full: applySurface keeps 6 router dirs and nested gsd-ns-manage/skills/help/SKILL.md', (t) => {
    process.env.GSD_TEST_MODE = '1';
    const { installRuntimeArtifacts } = require('../gsd-core/bin/lib/install-engine.cjs');
    const dir = tmpDir('gsd-69-surface-');
    t.after(() => { try { cleanup(dir); } catch { /* best-effort */ } });

    // Step 1: full install
    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const resolved = resolveProfile({ modes: ['full'], manifest });
    installRuntimeArtifacts('cline', dir, 'global', resolved);

    const skillsDir = path.join(dir, 'skills');

    // Sanity: install must produce nested layout (6 top-level router dirs)
    const topLevelAfterInstall = fs.readdirSync(skillsDir).filter((n) => n.startsWith('gsd-'));
    assert.strictEqual(
      topLevelAfterInstall.length,
      6,
      `Install must produce exactly 6 gsd-* top-level dirs (routers). Got ${topLevelAfterInstall.length}: [${topLevelAfterInstall.join(', ')}]`,
    );
    assert.ok(
      fs.existsSync(path.join(skillsDir, 'gsd-ns-workflow', 'skills', 'plan-phase', 'SKILL.md')),
      'After install: gsd-ns-workflow/skills/plan-phase/SKILL.md must exist',
    );

    // Step 2: applySurface (full surface, no surface state file → resolves to full)
    const layout = resolveRuntimeArtifactLayout('cline', dir, 'global');
    applySurface(dir, layout, manifest);

    // Step 3: assert nested layout is preserved after applySurface
    const topLevelAfterSurface = fs.readdirSync(skillsDir).filter((n) => n.startsWith('gsd-'));
    assert.strictEqual(
      topLevelAfterSurface.length,
      6,
      `After applySurface: expected exactly 6 gsd-* top-level dirs (routers only). Got ${topLevelAfterSurface.length}: [${topLevelAfterSurface.join(', ')}]. ` +
      'Re-flattening detected: applySurface must preserve nested layout (#69 regression).',
    );

    // The nested SKILL.md must still exist (not re-flattened to top-level concrete dir)
    assert.ok(
      fs.existsSync(path.join(skillsDir, 'gsd-ns-workflow', 'skills', 'plan-phase', 'SKILL.md')),
      'After applySurface: gsd-ns-workflow/skills/plan-phase/SKILL.md must still exist (nested layout preserved)',
    );

    // The concrete skill must NOT have been promoted to a top-level flat dir
    assert.ok(
      !fs.existsSync(path.join(skillsDir, 'gsd-plan-phase', 'SKILL.md')),
      'After applySurface: gsd-plan-phase/ must NOT exist at top level (#69 re-flatten regression guard)',
    );
  });

  // #924 companion: Claude must use FLAT layout and applySurface must NOT re-nest it.
  test('claude global full: install produces flat layout and applySurface preserves it (#924)', (t) => {
    process.env.GSD_TEST_MODE = '1';
    const { installRuntimeArtifacts } = require('../gsd-core/bin/lib/install-engine.cjs');
    const dir = tmpDir('gsd-924-69-');
    t.after(() => { try { cleanup(dir); } catch { /* best-effort */ } });

    const manifest = loadSkillsManifest(REAL_COMMANDS_DIR);
    const resolved = resolveProfile({ modes: ['full'], manifest });
    installRuntimeArtifacts('claude', dir, 'global', resolved);

    const skillsDir = path.join(dir, 'skills');

    // Install must produce FLAT layout (>= 60 gsd-* dirs)
    const topLevelAfterInstall = fs.readdirSync(skillsDir).filter((n) => n.startsWith('gsd-'));
    assert.ok(
      topLevelAfterInstall.length >= 60,
      `Claude install must produce >= 60 gsd-* top-level dirs (flat, #924). Got ${topLevelAfterInstall.length}.`,
    );

    // gsd-plan-phase must be directly at top level
    assert.ok(
      fs.existsSync(path.join(skillsDir, 'gsd-plan-phase', 'SKILL.md')),
      'After claude install: gsd-plan-phase/SKILL.md must be at top level (flat layout, #924)',
    );

    // No nested skills/ subdirs under gsd-ns-* in Claude
    assert.ok(
      !fs.existsSync(path.join(skillsDir, 'gsd-ns-workflow', 'skills')),
      'After claude install: gsd-ns-workflow/skills/ must NOT exist (flat layout, no nesting, #924)',
    );

    // applySurface must preserve flat layout
    const layout = resolveRuntimeArtifactLayout('claude', dir, 'global');
    applySurface(dir, layout, manifest);

    const topLevelAfterSurface = fs.readdirSync(skillsDir).filter((n) => n.startsWith('gsd-'));
    assert.ok(
      topLevelAfterSurface.length >= 60,
      `After applySurface: claude must still have >= 60 gsd-* dirs (flat preserved). Got ${topLevelAfterSurface.length}.`,
    );

    assert.ok(
      fs.existsSync(path.join(skillsDir, 'gsd-plan-phase', 'SKILL.md')),
      'After applySurface: gsd-plan-phase/SKILL.md must remain at top level (#924)',
    );
  });
});
  });
}
