'use strict';

/**
 * Shared helpers and constants for the install test suites and the
 * golden-install-parity harness. Provides the install/uninstall drivers
 * (walk, runMinimalInstall, RUNTIME_META, BUILD_SCRIPT) and the single
 * canonical golden-parity manifest builder (buildParityManifest) plus its
 * exclusion constants (VOLATILE_FILES, HOOK_CONFIG_FILES,
 * HOOK_CONFIG_RELATIVE_PATHS, EXCLUDED_PREFIXES). Imported by many
 * tests/*.test.cjs and by scripts/gen-golden-install-parity-zcode.cjs — do
 * NOT re-declare the builder/constants inline (enforced by
 * tests/golden-parity-single-source.test.cjs, #2266).
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');

const {
  resolveRuntimeArtifactLayout,
} = require('../../gsd-core/bin/lib/runtime-artifact-layout.cjs');

const INSTALL_SCRIPT = path.join(__dirname, '..', '..', 'bin', 'install.js');
const MANIFEST_NAME = 'gsd-file-manifest.json';

const BUILD_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'build-hooks.js');
const HOOKS_DIST = path.join(__dirname, '..', '..', 'hooks', 'dist');

const EXPECTED_SH_HOOKS = [
  'gsd-session-state.sh',
  'gsd-validate-commit.sh',
  'gsd-phase-boundary.sh',
];

const EXPECTED_ALL_HOOKS = [
  'gsd-check-update.js',
  'gsd-config-reload.js',
  'gsd-context-monitor.js',
  // #997: SessionStart canonical-path bootstrap for plugin installs.
  'gsd-ensure-canonical-path.js',
  'gsd-prompt-guard.js',
  'gsd-read-guard.js',
  'gsd-read-injection-scanner.js',
  'gsd-statusline.js',
  'gsd-workflow-guard.js',
  ...EXPECTED_SH_HOOKS,
];

// ─── Runtime metadata table ───────────────────────────────────────────────────

const RUNTIME_META = {
  claude:       { localDir: '.claude',           globalSuffix: '.claude' },
  antigravity:  { localDir: '.agents',           globalSuffix: path.join('.gemini', 'antigravity') },
  augment:      { localDir: '.augment',          globalSuffix: '.augment' },
  cline:        { localDir: '.cline',            globalSuffix: '.cline' },
  codebuddy:    { localDir: '.codebuddy',        globalSuffix: '.codebuddy' },
  codex:        { localDir: '.codex',            globalSuffix: '.codex' },
  copilot:      { localDir: '.github',           globalSuffix: '.copilot' },
  cursor:       { localDir: '.cursor',           globalSuffix: '.cursor' },
  hermes:       { localDir: '.hermes',           globalSuffix: '.hermes' },
  kimi:         { localDir: '.kimi-code',        globalSuffix: path.join('.config', 'agents') },
  'kimi-code':  { localDir: '.kimi-code',        globalSuffix: '.kimi-code' },
  kilo:         { localDir: '.kilo',             globalSuffix: path.join('.config', 'kilo') },
  opencode:     { localDir: '.opencode',         globalSuffix: path.join('.config', 'opencode') },
  pi:           { localDir: '.pi',               globalSuffix: path.join('.pi', 'agent') },
  qwen:         { localDir: '.qwen',             globalSuffix: '.qwen' },
  trae:         { localDir: '.trae',             globalSuffix: '.trae' },
  windsurf:     { localDir: '.windsurf',          globalSuffix: path.join('.codeium', 'windsurf') },
  zcode:        { localDir: '.zcode',             globalSuffix: '.zcode' },
};

/**
 * The emitted manifest families, as (fixtureName -> install spec).
 *
 * NOT simply `Object.keys(RUNTIME_META)`: that has 18 entries while the fixture set has
 * 19. The extra one is `claude-local` — claude is the reference host and the ONLY
 * runtime with a distinct LOCAL "legacy flat-commands" layout (`commands/gsd-*.md` +
 * `agents/gsd-*.md` at project scope), which `golden-install-parity.test.cjs` guards
 * with a hand-coded test outside its RUNTIME_META loop (#2086).
 *
 * Enumerating from RUNTIME_META alone dropped that family from BOTH sides of the
 * differential, so a same-count self-check (18 === 18) passed vacuously and a PR
 * changing Claude's local-scope output would fail the golden while the attribution
 * check reported ok.
 *
 * Lives HERE, beside RUNTIME_META, so the emitted-attribution helpers and the
 * emitted-provenance table read ONE derivation rather than each carrying a literal.
 * Two surfaces sharing a hand-maintained count is what produced the #2723 deadlock:
 * a single constant was asserted against both the base ref and the PR head, which
 * legitimately differ whenever a PR adds or removes a runtime.
 */
const MANIFEST_FAMILIES = [
  ...Object.keys(RUNTIME_META).map((runtime) => ({ name: runtime, runtime, scope: 'global' })),
  { name: 'claude-local', runtime: 'claude', scope: 'local' },
];

/**
 * Absolute floor on the family set, independent of any derivation.
 *
 * A pure equality between "derived" and "recorded" cannot catch a universe that shrank
 * on BOTH sides at once (drop a RUNTIME_META entry and delete its fixture together, and
 * 18 === 18 passes over a smaller world). This floor is the one number that must not be
 * derived — it ratchets, and lowering it is a deliberate, reviewable act. It never
 * blocks ADDING a runtime, which is the asymmetry the old shared literal lacked.
 */
const MINIMUM_MANIFEST_FAMILIES = 19;

// Runtimes that emit per-skill files under skills/ (not rules-based or commands-based)
const SKILL_RUNTIMES = [
  'claude', 'opencode', 'kilo', 'codex', 'copilot', 'antigravity',
  'cursor', 'augment', 'trae', 'qwen', 'codebuddy',
];

// ─── Golden install-parity manifest (canonical — issue #2266) ────────────────
//
// Single source of truth for the parity-manifest exclusion rules and hash
// formula. Both tests/golden-install-parity.test.cjs (the test harness) and
// scripts/gen-golden-install-parity-zcode.cjs (the build-time fixture
// generator) import buildParityManifest + these constants from here instead
// of each re-declaring their own copy — the prior duplication had drifted
// (the generator's copy was missing the realpath normalization below) and
// shipped broken fixtures three times (#2086, #2095, #2100).

// The installed package version, normalized to '<VERSION>' in hash computation so
// the golden is stable across version bumps (the rc step runs `npm version X.Y.Z-rc.N`
// before tests, which rebakes the version into hook files and gsd-core/VERSION).
const PKG_VERSION = require('../../package.json').version;

// Volatile metadata files always excluded from the parity manifest.
// .gsd-source (#1477, claude-global only) records the install-time absolute path
// to the package's commands/gsd source tree, which is the checkout/CI workspace
// path — NOT the temp HOME root, so it is never normalized to '<HOME>' and its
// hash varies by environment. Excluded for the same reason as gsd-install-state.json.
// gsd-core/CHANGELOG.md is excluded because it contains historical version strings
// that cause hash drift between local (PKG_VERSION=1.x.x) and CI (PKG_VERSION=1.x.x-rc.N):
// the PKG_VERSION normalization below replaces only the *current* version, but
// CHANGELOG.md references prior-release versions, so the normalized hash diverges.
const VOLATILE_FILES = new Set([
  'gsd-file-manifest.json',
  'gsd-install-state.json',
  '.gsd-source',
  'gsd-core/CHANGELOG.md',
]);

// Hook-registration config files excluded from the parity manifest. These are
// written by the hook/permission install path (applySettingsJsonHooks /
// finishInstall) — NOT by installRuntimeArtifacts, so they are outside the scope
// of the engine deep-move this harness guards. They also embed the resolved
// node-runner invocation, whose FORM (absolute-quoted "/abs/bin/node" on macOS
// vs bare `node` resolved from PATH on Linux/CI) — not just the binary path —
// varies by platform and cannot be normalized to a single sentinel reliably.
// Their content is asserted directly by the dedicated hook tests
// (install-minimal-hooks, sh-hook-paths, codex-config, etc.). Matched by basename.
// settings.json = Claude/Antigravity/Augment/etc. hook surface; hooks.json =
// Codex/Cursor hook surface — both embed the platform-varying node-runner command.
// settings.local.json = Claude LOCAL hook surface (#338): same platform-varying
// node-runner command as settings.json, so excluded for the same reason (#2086).
const HOOK_CONFIG_FILES = new Set(['settings.json', 'settings.local.json', 'hooks.json']);

// Kimi's native config.toml (#2095 EoS/kimi Upgrade 1) embeds the same
// platform-varying node-runner command as the HOOK_CONFIG_FILES above (via the
// same buildHookCommand/projectManagedHookCommand machinery), so it needs the
// same exclusion — but it is NOT matched by basename like HOOK_CONFIG_FILES:
// Codex's OWN config.toml (installSurface 'codex-toml') is a stable, tracked
// top-level `config.toml` entry in its golden fixture (it only ever gets a
// platform-stable `[features] hooks = true` flag — the real hook commands
// live in Codex's separate hooks.json, already excluded above). Blanket-
// excluding the 'config.toml' basename would silently blind Codex's fixture
// to any future regression there. Kimi's config.toml instead lives OUTSIDE
// its GSD configDir at runtime (resolveKimiHooksTomlDir resolves ~/.kimi, a
// sibling of the configDir ~/.config/agents) — it only appears inside this
// harness's walked tree at all because runMinimalInstall sets HOME to the
// same temp root used as --config-dir, collapsing the two into one directory
// for the isolated test run. So it is excluded by its exact relative path
// under that collapsed root, not by basename.
const HOOK_CONFIG_RELATIVE_PATHS = new Set(['.kimi/config.toml']);

// Path prefixes excluded from the parity manifest. `gsd-core/bin/lib/` holds the
// tsc-built runtime artifacts (compiled from src/*.cts) that the install COPIES
// verbatim — they are NOT produced by installRuntimeArtifacts (the move's parity
// scope), and their exact bytes depend on the BUILD environment (a clean tsc
// build vs a stale incremental one yields different output for unchanged sources).
// Including them made the golden non-portable: CI's clean build legitimately
// differs from a local incremental build for modules the PR never touched
// (e.g. milestone.cjs, roadmap.cjs). The .cts sources are type-checked + drift-
// guarded + coverage-gated elsewhere; this harness asserts the CONVERTED artifact
// output (skills/commands/agents) that the engine actually emits.
const EXCLUDED_PREFIXES = ['gsd-core/bin/lib/'];

// ─── Helper functions ─────────────────────────────────────────────────────────

function stripAnsi(str) {
   
  return str.replace(/\x1b\[[0-9;]*m/g, '');
}

function walk(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) results.push(...walk(full));
    else results.push(full);
  }
  return results;
}

/**
 * Build a deterministic hash-map of all non-volatile files under configDir.
 *
 * For each file:
 *   - rel  = POSIX-slash relative path from configDir
 *   - hash = sha256(content with root replaced by '<HOME>').slice(0,16)
 *
 * Returns a plain object with sorted keys for stable JSON comparison.
 *
 * @param {string} configDir - absolute path to the installed runtime config dir
 * @param {string} root      - temp root path to replace with '<HOME>'
 * @returns {{ [rel: string]: string }}
 */
function buildParityManifest(configDir, root) {
  const allFiles = walk(configDir);
  const unsorted = {};

  // The claude LOCAL install resolves its config dir via realpath, which on macOS
  // prepends `/private` to the temp root (`/var/folders/…` -> `/private/var/folders/…`)
  // and embeds that resolved path in the projected agents/commands/workflows (`@…`
  // references). On Linux the temp root has no `/private` symlink, so normalizing
  // ONLY `root` left the `/private` prefix on macOS and produced platform-divergent
  // hashes (#2086). Normalize the realpath form FIRST (it is the longer, `/private`-
  // prefixed string) so both platforms collapse to `<HOME>`. No-op for the global
  // fixtures (global install uses the literal `--config-dir`, never realpath-resolved).
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch { /* root already gone / not resolvable */ }

  for (const full of allFiles) {
    // Build POSIX-style relative path for cross-platform stability
    const rel = path.relative(configDir, full).split(path.sep).join('/');

    if (VOLATILE_FILES.has(rel)) continue;
    if (HOOK_CONFIG_FILES.has(path.basename(rel))) continue;
    if (HOOK_CONFIG_RELATIVE_PATHS.has(rel)) continue;
    if (EXCLUDED_PREFIXES.some((p) => rel.startsWith(p))) continue;

    const content = fs.readFileSync(full);
    // Normalize every occurrence of the temp root so hashes are stable across runs.
    // Also normalize the package version so the golden survives `npm version` bumps
    // (the rc release step bakes the new version into hook files before running tests).
    const normalized = content.toString('utf8')
      .split(realRoot).join('<HOME>')
      .split(root).join('<HOME>')
      .split(PKG_VERSION).join('<VERSION>');
    const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
    unsorted[rel] = hash;
  }

  // Reconstruct with sorted keys for stable JSON serialisation
  const sorted = {};
  for (const key of Object.keys(unsorted).sort()) {
    sorted[key] = unsorted[key];
  }
  return sorted;
}

/** Sorted list of emitted relative paths for a runtime install (file-set snapshot,
 *  #2267). Reuses buildParityManifest's exact exclusion set so the tree and the
 *  content manifest never diverge on which files they cover. */
function buildInstallTree(configDir, root) {
  return Object.keys(buildParityManifest(configDir, root)).sort();
}

function simulateHookCopy(hooksSrc, hooksDest) {
  fs.mkdirSync(hooksDest, { recursive: true });
  for (const entry of fs.readdirSync(hooksSrc)) {
    const srcFile = path.join(hooksSrc, entry);
    if (!fs.statSync(srcFile).isFile()) continue;
    const destFile = path.join(hooksDest, entry);
    if (entry.endsWith('.js')) {
      fs.writeFileSync(destFile, fs.readFileSync(srcFile, 'utf8'));
      try { fs.chmodSync(destFile, 0o755); } catch { /* Windows */ }
    } else {
      fs.copyFileSync(srcFile, destFile);
      if (entry.endsWith('.sh')) {
        try { fs.chmodSync(destFile, 0o755); } catch { /* Windows */ }
      }
    }
  }
}

/** Build a clean env for spawned installer processes.
 *  Must strip GSD_TEST_MODE so the child runs the real install, not the no-op guard. */
function installerEnv(overrides = {}) {
  const env = { ...process.env, ...overrides };
  delete env.GSD_TEST_MODE;
  return env;
}

function runMinimalInstall({ runtime, scope, extraArgs = [] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `gsd-${runtime}-${scope}-`));
  try {
    const LOCAL_DIR_NAME = {
      claude: '.claude', opencode: '.opencode', kilo: '.kilo',
      codex: '.codex', copilot: '.github', antigravity: '.agents', cursor: '.cursor',
      windsurf: '.windsurf', augment: '.augment', trae: '.trae', qwen: '.qwen',
      codebuddy: '.codebuddy', cline: '.',
    };
    let configDir;
    let cwd = process.cwd();
    const args = [INSTALL_SCRIPT, `--${runtime}`];
    if (scope === 'global') {
      args.push('--global', '--config-dir', root);
      configDir = root;
    } else {
      args.push('--local');
      cwd = root;
      configDir = runtime === 'cline' ? root : path.join(root, LOCAL_DIR_NAME[runtime]);
    }
    args.push(...extraArgs);
    const result = spawnSync(process.execPath, args, {
      cwd, encoding: 'utf8',
      env: installerEnv({ HOME: root, USERPROFILE: root }),
    });
    assert.strictEqual(result.status, 0,
      `installer exited with status ${result.status} for ${runtime} --${scope}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const manifestPath = path.join(configDir, MANIFEST_NAME);
    const manifest = fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      : null;
    return { manifest, configDir, root, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

function manifestSkillSet(manifest) {
  if (!manifest || !manifest.files) return new Set();
  const out = new Set();
  for (const key of Object.keys(manifest.files)) {
    if (key.startsWith('skills/')) {
      const seg = key.split('/')[1].replace(/^gsd-/, '').replace(/\.md$/, '');
      out.add(seg);
    } else if (key.startsWith('command/')) {
      // OpenCode/Kilo: command/gsd-<cmd>.md
      const file = key.split('/')[1];
      out.add(file.replace(/^gsd-/, '').replace(/\.md$/, ''));
    } else if (key.startsWith('commands/gsd/')) {
      // Gemini: commands/gsd/<cmd>.toml (nested, colon-namespaced)
      const file = key.split('/')[2];
      out.add(file.replace(/\.(md|toml)$/, ''));
    } else if (key.startsWith('commands/') && key.split('/').length === 2) {
      // Claude local (#1367 fix): flat commands/gsd-<cmd>.md
      const file = key.split('/')[1];
      if (file.startsWith('gsd-') && file.endsWith('.md')) {
        out.add(file.replace(/^gsd-/, '').replace(/\.md$/, ''));
      }
    }
  }
  return out;
}

function manifestAgentCount(manifest) {
  if (!manifest || !manifest.files) return 0;
  return Object.keys(manifest.files).filter((k) => k.startsWith('agents/')).length;
}

/**
 * Collect gsd-* skill/command basenames actually present on disk under configDir.
 *
 * @param {string} configDir
 * @param {string} [runtime] - when provided, the skills-kind destination is
 *   resolved via resolveRuntimeArtifactLayout so a skills-kind `home` override
 *   (Codex only, ADR-1239 upgrade 3 / #2088: skills -> $HOME/.agents/skills
 *   instead of configDir/skills) is honored. Omitted callers keep the prior
 *   configDir/skills default.
 * @param {string} [scope='global']
 */
function collectSkillBasenamesOnDisk(configDir, runtime, scope = 'global') {
  const out = new Set();
  let skillsDir = path.join(configDir, 'skills');
  if (runtime) {
    try {
      const layout = resolveRuntimeArtifactLayout(runtime, configDir, scope);
      const skillsKind = layout.kinds.find((k) => k.kind === 'skills');
      if (skillsKind) skillsDir = path.join(skillsKind.home || configDir, skillsKind.destSubpath);
    } catch { /* fall back to configDir/skills */ }
  }
  if (fs.existsSync(skillsDir)) {
    for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith('gsd-')) {
        out.add(entry.name.replace(/^gsd-/, ''));
      } else if (entry.isFile() && entry.name.startsWith('gsd-') && entry.name.endsWith('.md')) {
        out.add(entry.name.replace(/^gsd-/, '').replace(/\.md$/, ''));
      }
    }
  }
  const commandDir = path.join(configDir, 'command');
  if (fs.existsSync(commandDir)) {
    for (const file of fs.readdirSync(commandDir)) {
      if (file.startsWith('gsd-') && file.endsWith('.md')) {
        out.add(file.replace(/^gsd-/, '').replace(/\.md$/, ''));
      }
    }
  }
  const commandsGsdDir = path.join(configDir, 'commands', 'gsd');
  if (fs.existsSync(commandsGsdDir)) {
    for (const file of fs.readdirSync(commandsGsdDir)) {
      if (file.endsWith('.md') || file.endsWith('.toml')) {
        out.add(file.replace(/\.(md|toml)$/, ''));
      }
    }
  }
  // Claude local (#1367 fix): flat gsd-*.md files at commands/ level
  const flatCommandsDir = path.join(configDir, 'commands');
  if (fs.existsSync(flatCommandsDir)) {
    for (const file of fs.readdirSync(flatCommandsDir)) {
      if (file.startsWith('gsd-') && file.endsWith('.md')) {
        out.add(file.replace(/^gsd-/, '').replace(/\.md$/, ''));
      }
    }
  }
  return out;
}

module.exports = {
  INSTALL_SCRIPT,
  MANIFEST_NAME,
  BUILD_SCRIPT,
  HOOKS_DIST,
  EXPECTED_SH_HOOKS,
  EXPECTED_ALL_HOOKS,
  RUNTIME_META,
  MANIFEST_FAMILIES,
  MINIMUM_MANIFEST_FAMILIES,
  SKILL_RUNTIMES,
  PKG_VERSION,
  VOLATILE_FILES,
  HOOK_CONFIG_FILES,
  HOOK_CONFIG_RELATIVE_PATHS,
  EXCLUDED_PREFIXES,
  stripAnsi,
  walk,
  buildParityManifest,
  buildInstallTree,
  simulateHookCopy,
  installerEnv,
  runMinimalInstall,
  manifestSkillSet,
  manifestAgentCount,
  collectSkillBasenamesOnDisk,
};
