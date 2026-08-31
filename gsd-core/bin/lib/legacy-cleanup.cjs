'use strict';

/**
 * legacy-cleanup.cjs — detect and remove leftover artifacts from the old package.
 *
 * Provides a pure-ish scan phase (planLegacyCleanup) and a thin IO applier
 * (applyLegacyCleanup) that together root out stale files from the old
 * package across every GSD-managed runtime config directory.
 *
 * Issue: #607
 *
 * House style: CommonJS, 'use strict', pure functions + thin IO appliers.
 * Seams (opts.fs, opts.logger) allow full unit-test coverage without touching
 * the real filesystem except in the apply phase.
 */

const os   = require('os');
const path = require('path');
const fs   = require('fs');

// ─── Constants ───────────────────────────────────────────────────────────────

/**
 * Substring that identifies a file as belonging to the old package.
 * Assembled from parts so this source file itself never contains the literal
 * as a plain substring (avoids self-flagging if the content scan were ever
 * widened back to include this subtree).
 */
const OLD_PACKAGE_SIGNAL = 'gsd-core' + '-cc';

/**
 * Subtrees within a configDir that GSD actively scans for old-package content.
 * Deliberately excludes 'gsd-core' — the current package's own infra and
 * docs live there (CHANGELOG.md, this file, etc.) and are overwritten by
 * install anyway. Poisoning hooks from the old package live in 'hooks/', which
 * IS scanned.
 */
const GSD_MANAGED_SUBTREES = ['hooks', 'commands'];

/**
 * Substring that identifies a skill file as referencing the pre-rename GSD
 * runtime config subdirectory. Assembled from parts to avoid self-flagging.
 *
 * Old installs wrote skill bodies that embed the path to the GSD runtime
 * directory — e.g. `@$HOME/.codex/get-shit-done/workflows/plan.md`. After // gsd-allow-legacy-name
 * the rename to `gsd-core/` (#604), those embedded paths are stale and the
 * skill file must be removed so the runtime does not pick up the wrong copy.
 *
 * Issue: #1453
 */
const LEGACY_SKILL_PATH_SIGNAL = 'get-shit-done'; // gsd-allow-legacy-name

/**
 * Prefix that identifies a skill directory as GSD-managed.
 * Only `gsd-*` subdirectories under the `skills/` subtree are scanned; user
 * skill directories with other prefixes are never touched.
 */
const GSD_SKILL_DIR_PREFIX = 'gsd-';

/**
 * File extensions eligible for the stale-skill-path scan.
 * SKILL.md is the only file in a codex/cursor/kilo/etc skill directory that
 * embeds an @-import path to the GSD runtime config tree.
 */
const SKILL_MD_EXTENSIONS = new Set(['.md']);

/**
 * Extensions eligible for the content-reference scan.
 *
 * WHY: The current @opengsd/gsd-core package ships ZERO references to the old
 * package name in any code file (.js/.cjs/.mjs/.sh). Therefore a code file
 * that still contains that string is genuinely a leftover from the old package
 * and is safe to flag.
 *
 * Markdown, JSON, TOML, YAML, and other doc/config files, however,
 * legitimately cite the old name in historical or reference context
 * (e.g. CHANGELOG.md, workflow .md files). Scanning them caused the
 * installer to delete the freshly-installed gsd-core/CHANGELOG.md,
 * breaking installs. Fix: restrict the content scan to code extensions only.
 */
const CODE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.sh']);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Return true if any segment of the absolute file path is `dev-preferences`
 * or the file is named `dev-preferences.md`. These are always user artifacts.
 *
 * @param {string} absPath
 * @returns {boolean}
 */
function isDevPreferencesPath(absPath) {
  const parts = absPath.split(path.sep);
  return parts.some(
    (seg) => seg === 'dev-preferences' || seg === 'dev-preferences.md'
  );
}

/**
 * Recursively collect all file paths under `dir` (bounded; skips
 * unreadable entries silently).
 *
 * @param {string} dir
 * @param {object} fsMod - injectable fs module
 * @returns {string[]} absolute file paths
 */
function collectFilesUnder(dir, fsMod) {
  const results = [];
  let entries;
  try {
    entries = fsMod.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFilesUnder(full, fsMod));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Return true if the file at `absPath` contains the old-package substring.
 * Skips unreadable files (returns false on any error).
 *
 * @param {string} absPath
 * @param {object} fsMod
 * @returns {boolean}
 */
function fileContainsOldPackageSignal(absPath, fsMod) {
  try {
    const content = fsMod.readFileSync(absPath, 'utf8');
    return content.includes(OLD_PACKAGE_SIGNAL);
  } catch {
    return false;
  }
}

/**
 * Return true if the file at `absPath` contains the legacy skill path signal
 * (`get-shit-done` as a path component inside an @-import or similar reference). // gsd-allow-legacy-name
 * Skips unreadable files (returns false on any error).
 *
 * @param {string} absPath
 * @param {object} fsMod
 * @returns {boolean}
 */
function fileContainsLegacySkillPathSignal(absPath, fsMod) {
  try {
    const content = fsMod.readFileSync(absPath, 'utf8');
    return content.includes('/' + LEGACY_SKILL_PATH_SIGNAL + '/'); // gsd-allow-legacy-name
  } catch {
    return false;
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Scan `configDirs` for leftover old-package artifacts and the legacy
 * shared cache, returning an ordered array of removal candidates.
 *
 * Possible reasons in returned entries:
 *   - 'content-references-old-package': a code file whose content contains
 *     the old package name signal (hooks/ and commands/ subtrees only).
 *   - 'stale-get-shit-done-path': a skill markdown file whose content contains
 *     a path reference to the pre-rename `get-shit-done/` runtime directory // gsd-allow-legacy-name
 *     (skills/ subtree, gsd-* directories only). Issue #1453.
 *   - 'legacy-shared-cache': the old package's shared update-check cache file.
 *
 * @param {string[]} configDirs - absolute paths to runtime config dirs to scan
 * @param {object}  [opts]
 * @param {string}  [opts.homeDir]  - home directory (default: os.homedir())
 * @param {object}  [opts.fs]       - injectable fs module (default: require('node:fs'))
 * @returns {{ path: string, reason: string }[]}
 */
function planLegacyCleanup(configDirs, opts = {}) {
  const homeDir  = opts.homeDir || os.homedir();
  const fsMod    = opts.fs || fs;

  /** @type {Map<string, string>} path → reason (de-dup by path) */
  const candidates = new Map();

  const addCandidate = (absPath, reason) => {
    if (!candidates.has(absPath)) {
      candidates.set(absPath, reason);
    }
  };

  for (const configDir of configDirs) {
    for (const subtree of GSD_MANAGED_SUBTREES) {
      const subtreeDir = path.join(configDir, subtree);

      // Collect all files under this subtree (skip if absent)
      const files = collectFilesUnder(subtreeDir, fsMod);

      for (const absPath of files) {
        // Never flag user-authored dev-preferences artifacts
        if (isDevPreferencesPath(absPath)) continue;

        // Content signal: code files referencing the old package name.
        // Only scan files with code extensions — docs/config files (.md, .json,
        // .yml, etc.) legitimately cite the old name in historical context and
        // must never be deleted (see CODE_EXTENSIONS declaration above).
        const ext = path.extname(absPath).toLowerCase();
        if (CODE_EXTENSIONS.has(ext) && fileContainsOldPackageSignal(absPath, fsMod)) {
          addCandidate(absPath, 'content-references-old-package');
        }
      }
    }

    // #1453: Scan skills/gsd-* directories for stale get-shit-done path references. // gsd-allow-legacy-name
    //
    // Background: older GSD installs wrote SKILL.md files that embedded a path to
    // the GSD runtime config directory, e.g.:
    //   @$HOME/.codex/get-shit-done/workflows/docs-update.md // gsd-allow-legacy-name
    //
    // After the rename to gsd-core/ (#604), the correct path is:
    //   @$HOME/.codex/gsd-core/workflows/docs-update.md
    //
    // When Codex upgrades to gsd-core 1.5.0 it writes fresh skill files to
    // ~/.codex/skills/ but does NOT remove stale copies that an older install
    // may have placed under OTHER discoverable skill roots (e.g. ~/.agents/skills/,
    // ~/.config/agents/skills/). Codex can pick up either copy and the stale one
    // breaks the session (#1453).
    //
    // This scan removes GSD-managed skill files (under gsd-* subdirs) that still
    // reference the old path. Only .md files are scanned (SKILL.md is the sole
    // embedded-path carrier in a skill dir). The skills/ dir itself is not deleted;
    // user-owned non-gsd-* skill dirs are never touched.
    const skillsDir = path.join(configDir, 'skills');
    let skillDirEntries;
    try {
      skillDirEntries = fsMod.readdirSync(skillsDir, { withFileTypes: true });
    } catch {
      skillDirEntries = null;
    }
    if (skillDirEntries) {
      for (const entry of skillDirEntries) {
        // Only process gsd-* subdirectories (GSD-managed skill dirs).
        if (!entry.isDirectory()) continue;
        if (!entry.name.startsWith(GSD_SKILL_DIR_PREFIX)) continue;

        const skillDir = path.join(skillsDir, entry.name);
        const files = collectFilesUnder(skillDir, fsMod);

        for (const absPath of files) {
          // Never flag user-authored dev-preferences artifacts
          if (isDevPreferencesPath(absPath)) continue;

          // Only scan .md files for the stale path signal.
          const ext = path.extname(absPath).toLowerCase();
          if (SKILL_MD_EXTENSIONS.has(ext) && fileContainsLegacySkillPathSignal(absPath, fsMod)) {
            addCandidate(absPath, 'stale-get-shit-done-path'); // gsd-allow-legacy-name
          }
        }
      }
    }
  }

  // Legacy shared cache (fixed name from the old package). #3799: under an
  // explicit configDirs override the cache lives under the SCOPE root(s), not
  // the default home — the override means "clean only what this redirected
  // install owns", and the default home's cache belongs to the live install.
  const cacheRoot = (Array.isArray(opts.configDirs) && opts.configDirs.length > 0)
    ? opts.configDirs[0]
    : homeDir;
  const legacyCachePath = path.join(cacheRoot, '.cache', 'gsd', 'gsd-update-check.json');
  try {
    const stat = fsMod.statSync(legacyCachePath);
    if (stat.isFile()) {
      addCandidate(legacyCachePath, 'legacy-shared-cache');
    }
  } catch {
    // absent — skip
  }

  // Sort deterministically by path
  const sorted = [...candidates.entries()]
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([p, reason]) => ({ path: p, reason }));

  return sorted;
}

/**
 * Execute the plan returned by `planLegacyCleanup`.
 *
 * @param {{ path: string, reason: string }[]} plan
 * @param {object}  [opts]
 * @param {boolean} [opts.dryRun=false] - when true, log but do not remove
 * @param {object}  [opts.fs]           - injectable fs module
 * @param {object}  [opts.logger]       - injectable logger (default: console)
 * @returns {{ removed: string[], skipped: string[], errors: Array<{path:string,error:string}>, dryRun: boolean }}
 */
function applyLegacyCleanup(plan, opts = {}) {
  const dryRun  = opts.dryRun === true;
  const fsMod   = opts.fs || fs;
  const logger  = opts.logger || console;

  if (dryRun) {
    for (const item of plan) {
      logger.log('[dry-run] would remove: ' + item.path + '  (' + item.reason + ')');
    }
    return {
      removed: [],
      skipped: plan.map((item) => item.path),
      errors: [],
      dryRun: true,
    };
  }

  const removed = [];
  const errors  = [];

  for (const item of plan) {
    let lastErr;
    const maxAttempts = process.platform === 'win32' ? 3 : 1;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        if (attempt > 0) {
          // Synchronous 100ms delay before retry (win32 EBUSY/EPERM from Defender)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
        }
        fsMod.rmSync(item.path, { force: true });
        lastErr = undefined;
        break;
      } catch (err) {
        lastErr = err;
        if (process.platform !== 'win32' ||
            (err.code !== 'EBUSY' && err.code !== 'EPERM')) {
          break; // non-retryable error; stop immediately
        }
      }
    }
    if (lastErr) {
      errors.push({ path: item.path, error: lastErr.message });
    } else {
      removed.push(item.path);
    }
  }

  return { removed, skipped: [], errors, dryRun: false };
}

// ─── Exports ─────────────────────────────────────────────────────────────────

module.exports = {
  planLegacyCleanup,
  applyLegacyCleanup,
};
