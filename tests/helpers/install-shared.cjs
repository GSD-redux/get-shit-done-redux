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

// This checkout's own package version — the DEFAULT normalized in hash computation so
// the golden is stable across version bumps (the rc step runs `npm version X.Y.Z-rc.N`
// before tests, which rebakes the version into hook files and gsd-core/VERSION).
//
// This is only a default. buildParityManifest's `pkgVersion` option exists precisely
// because the tree being MEASURED is not always this checkout (#2767's `repoRoot`
// installer-spawn path measures a DIFFERENT tree's `bin/install.js` output). The
// version that must be normalized is always the version of the tree that PRODUCED
// the emitted bytes, not the version of whichever checkout happens to be running this
// test file — see the pkgVersion JSDoc on buildParityManifest below.
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

// A version string can itself contain regex metacharacters (`.`, and — via
// prerelease/build metadata — `-`/`+`), so it must be escaped before being spliced
// into a RegExp source, or e.g. the `.` in "1.9.0" would match ANY character.
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Loosely semver-shaped: leading `MAJOR.MINOR.PATCH`, optional `-prerelease` and/or
// `+build` metadata (e.g. `1.9.0`, `1.9.0-rc.1`, `1.9.0+abc`). Deliberately loose
// (not the full semver grammar) — this only needs to reject obviously-malformed
// values like `'1'` (FINDING 2, #2891 review) before they reach regex construction,
// not to be a semver validator.
const SEMVER_ISH_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

/**
 * Anchored, narrow version-stamp normalization — the FINDING 1 (#2891 review) fix for
 * the prior `.split(pkgVersion).join('<VERSION>')`, which blind-replaced EVERY
 * occurrence of the version string anywhere in emitted content. That was unsound in
 * both directions once each side of a diff normalizes against a DIFFERENT pkgVersion
 * (baseline vs current tree, #2891): a bare semver literal that genuinely changed
 * between the two versions collapses to '<VERSION>' on both sides and goes invisible
 * (false negative), while an UNCHANGED file that happens to contain a literal equal to
 * only the CURRENT version collapses on one side only and reports as spurious drift
 * (false positive). Emitted sources really do carry bare semver literals that are NOT
 * install-time stamps — e.g. gsd-core/workflows/update.md's `1.4.0`/`1.3.1` examples,
 * agents/gsd-project-researcher.md's `1.2.3`, gsd-core/workflows/help/modes/full.md's
 * `1.0.0` — and those must stay VISIBLE to the parity gate if they ever change.
 *
 * So instead of replacing the version everywhere, this only normalizes it at the
 * specific places `bin/install.js` actually stamps `pkg.version` into emitted content
 * as a version FIELD/marker (not prose):
 *   - `// gsd-hook-version: <ver>` / `# gsd-hook-version: <ver>` — the
 *     `{{GSD_VERSION}}` substitution done for every emitted hook file.
 *   - `"version": "<ver>"` — JSON manifests (plugin/extension/capability-style)
 *     embedding the package version as a string field.
 *   - `version: "<ver>"` / `version: <ver>` — YAML frontmatter version fields (e.g.
 *     skill frontmatter's `yamlQuote(pkg.version)`, Hermes' category
 *     `DESCRIPTION.md`).
 *   - `@opengsd/gsd-core@<ver>` — pinned package-spec references.
 *   - a file whose ENTIRE trimmed content IS the version (`gsd-core/VERSION`).
 * Each pattern only matches when the version in the content EQUALS the supplied
 * `pkgVersion` — this is deliberately narrow, at the cost of needing a new pattern any
 * time the installer grows a new stamp site (see the empirical repro-harness check
 * this fix was verified against, #2891 review FINDING 1).
 *
 * @param {string} content
 * @param {string} pkgVersion - already validated non-empty semver-ish string.
 * @returns {string}
 */
function normalizeVersionStamps(content, pkgVersion) {
  const v = escapeRegExp(pkgVersion);
  // `(?![\w.+-])` after a bare (unquoted/uncaptured-suffix) match stops a version
  // from matching as a PREFIX of a longer version-shaped string it is not equal to
  // (e.g. pkgVersion '1.9.0' must not match inside '1.9.0-rc.1' or '1.9.0.1').
  return content
    .replace(new RegExp(`((?:\\/\\/|#)\\s*gsd-hook-version:\\s*)${v}(?![\\w.+-])`, 'g'), '$1<VERSION>')
    .replace(new RegExp(`("version"\\s*:\\s*")${v}(")`, 'g'), '$1<VERSION>$2')
    .replace(new RegExp(`(version:\\s*")${v}(")`, 'g'), '$1<VERSION>$2')
    .replace(new RegExp(`(version:\\s*)${v}(?![\\w.+-])`, 'g'), '$1<VERSION>')
    .replace(new RegExp(`(@opengsd/gsd-core@)${v}(?![\\w.+-])`, 'g'), '$1<VERSION>')
    .replace(new RegExp(`^(\\s*)${v}(\\s*)$`), '$1<VERSION>$2');
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
 * @param {object} [opts]
 * @param {string} [opts.pkgVersion] - the version string to normalize to '<VERSION>'.
 *   MUST be the version of the tree that PRODUCED the emitted content at `configDir`
 *   — NOT necessarily this checkout's own version. OMITTING this option (or the whole
 *   `opts` argument) defaults to this checkout's own PKG_VERSION, which is only
 *   correct when `configDir` was emitted by THIS checkout's installer. A caller
 *   measuring a DIFFERENT tree's installer output (#2767's `repoRoot`-driven spawns)
 *   must pass that other tree's own version explicitly, or the normalization silently
 *   compares apples to oranges: baseline hooks baked with version X never collapse to
 *   '<VERSION>' when normalized against version Y, so every emitted file looks changed
 *   even when byte-identical apart from the version stamp. Must be a non-empty
 *   semver-ish string (`MAJOR.MINOR.PATCH` with optional prerelease/build metadata)
 *   when the key is REACHABLE at all — see the guard below for why, and why an
 *   explicit `{ pkgVersion: undefined }` is treated as a caller error rather than
 *   silently falling back to the default (that fallback is the exact bug being
 *   fixed). `opts` itself must be a plain object (or omitted/undefined) — `null` or a
 *   non-object throws rather than reaching `Object`'s coercion of `null`/`undefined`
 *   (#2891 review FINDING 5).
 * @returns {{ [rel: string]: string }}
 */
function buildParityManifest(configDir, root, opts = {}) {
  // `opts = {}` only substitutes for an OMITTED (or explicit `undefined`) third
  // argument — `null` and other non-object values sail past a default parameter and
  // would otherwise reach the `in` check below and throw a raw, unhelpful
  // `TypeError: Cannot convert undefined or null to object` (#2891 review FINDING 5).
  // Fail with a clear, attributable message instead.
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new Error(
      `buildParityManifest: opts must be a plain object or omitted, got ${JSON.stringify(opts)}.`
    );
  }

  // Distinguish "the caller didn't pass pkgVersion at all" (legitimate — use this
  // checkout's own PKG_VERSION) from "the caller passed pkgVersion explicitly, and it
  // happens to be undefined/null/empty/non-string" (a caller error that must throw,
  // never silently fall back). A plain default-parameter (`{ pkgVersion = PKG_VERSION
  // } = {}`) cannot make this distinction — JS treats an explicit `undefined` value
  // identically to an absent key, which would let a caller-side bug (e.g. a repoRoot
  // version lookup that resolved to undefined) silently normalize against THIS
  // checkout's version instead of throwing — exactly the cross-tree mis-attribution
  // bug #2891 fixes. Use the `in` operator (not `hasOwnProperty`) so the key is honored
  // whether it is OWN or INHERITED — `Object.create({ pkgVersion: 'x' })` reaches this
  // function with the key reachable via the prototype chain, and a caller-error value
  // sitting there must still be validated (and rejected) rather than silently ignored
  // in favor of the default; only a key ABSENT from the whole chain means "caller
  // didn't specify one, use this checkout's own version" (#2891 review FINDING 4).
  const pkgVersion = 'pkgVersion' in opts ? opts.pkgVersion : PKG_VERSION;

  // GUARD: an empty/falsy/non-string/non-semver-shaped pkgVersion must never reach the
  // normalization below. A careless caller passing e.g. '1' would silently match and
  // corrupt content that merely contains that digit as a substring of an unrelated
  // number (#2891 review FINDING 2) — and, pre-FINDING-1, an empty string reaching
  // `.split('')` would have exploded manifest content into individual characters. Fail
  // closed instead of falling back to this checkout's PKG_VERSION: a silent fallback is
  // exactly the cross-tree mis-attribution bug this option exists to fix (#2891).
  if (typeof pkgVersion !== 'string' || pkgVersion.length === 0 || !SEMVER_ISH_RE.test(pkgVersion)) {
    throw new Error(
      `buildParityManifest: pkgVersion must be a non-empty semver-ish string ` +
      `(MAJOR.MINOR.PATCH, optional -prerelease/+build), got ${JSON.stringify(pkgVersion)}. ` +
      'Pass the version of the tree that produced the emitted content at configDir.'
    );
  }
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
    // Also normalize the PRODUCING tree's package version at its known stamp sites
    // (pkgVersion, defaulted to this checkout's own) — via the ANCHORED
    // normalizeVersionStamps, not a blind substring replace — so the golden survives
    // `npm version` bumps (the rc release step bakes the new version into hook files
    // before running tests) and, for a cross-tree caller, so the version stamp baked
    // in by a DIFFERENT tree's installer doesn't masquerade as a real content diff,
    // WITHOUT also masking a genuine content change to an unrelated bare semver
    // literal that happens to equal pkgVersion (#2891; see normalizeVersionStamps'
    // own doc comment for the blind-replace failure modes this replaced).
    const normalized = normalizeVersionStamps(
      content.toString('utf8')
        .split(realRoot).join('<HOME>')
        .split(root).join('<HOME>'),
      pkgVersion,
    );
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
 *  content manifest never diverge on which files they cover. Deliberately does NOT
 *  take (or forward) a `pkgVersion`/`opts` parameter: the emitted FILE SET is
 *  version-independent — `pkgVersion` only ever changes which bytes a file's HASH
 *  normalizes to, never which paths buildParityManifest walks or excludes — so there
 *  is nothing for a caller to pass here, and forwarding one through would only let a
 *  bad version value make a pure file-set query throw for no file-set-shaped reason
 *  (#2891 review FINDING 6; verified no caller passes a third argument —
 *  tests/golden-install-tree.test.cjs, scripts/gen-install-tree-fixtures.cjs). */
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

/**
 * @param {object} opts
 * @param {string} opts.runtime
 * @param {string} opts.scope
 * @param {string[]} [opts.extraArgs]
 * @param {string} [opts.installScript] - Absolute path to the `bin/install.js` to spawn.
 *   Defaults to THIS checkout's own INSTALL_SCRIPT. Overridable (#2767) so a caller can
 *   measure a DIFFERENT tree's installer — e.g. the differential baseline builder
 *   pointing at a `git worktree` checked out at the base ref, so the emitted manifest it
 *   produces reflects that ref's own installer code, not the PR checkout's.
 */
function runMinimalInstall({ runtime, scope, extraArgs = [], installScript = INSTALL_SCRIPT }) {
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
    const args = [installScript, `--${runtime}`];
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
