#!/usr/bin/env node
// gsd-hook-version: {{GSD_VERSION}}
//
// gsd-ensure-canonical-path — SessionStart hook (#997)
//
// PROBLEM: GSD agents/commands/templates use markdown `@`-file-includes that
// hardcode the canonical path `@~/.claude/gsd-core/...` (references, workflows,
// templates, contexts, bin). Markdown @-includes expand `~` but do NOT expand
// environment variables, so `${CLAUDE_PLUGIN_ROOT}` cannot be used in them.
// In a classic `bin/install.js` install the canonical path is a real directory
// holding the bundled tree, so the includes resolve. In a Claude Code
// *marketplace plugin* install the plugin manager only unpacks the package
// into the version-pinned plugin cache and never runs `bin/install.js`, so
// `~/.claude/gsd-core/` is never created and every @-include resolves to
// nothing — every agent that depends on one fails (e.g. the executor).
//
// FIX: On SessionStart, when running under a plugin install (CLAUDE_PLUGIN_ROOT
// set and a bundled `gsd-core/` tree found beneath it), ensure
// `~/.claude/gsd-core/` exists and its immutable subdirs (bin, contexts,
// references, templates, workflows) are symlinked to the plugin's bundled tree.
// This changes ZERO @-references, is a no-op in classic installs (where each
// subdir is already a real directory), preserves user-generated files
// (USER-PROFILE.md, STATE.md, VERSION, …), prunes stale links so it self-heals
// after `claude plugin update` rotates the version dir, and uses Windows
// junctions for symlinks on win32.
//
// SECURITY: the resolved bundled-tree path and every per-subdir link target are
// kept strictly inside the resolved plugin root (realpath-normalised, prefix-
// checked). A real (non-symlink) file or directory already sitting at a managed
// link target is NEVER clobbered.

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { allow } = require('./lib/hook-exit.js');

// Immutable, bundled subdirectories that the canonical path must expose. These
// are the directories `@~/.claude/gsd-core/<subdir>/...` includes point into.
// User-generated artifacts (USER-PROFILE.md, STATE.md, VERSION, config, …) are
// NOT in this list and are never created, moved, or deleted by this hook.
const MANAGED_SUBDIRS = ['bin', 'contexts', 'references', 'templates', 'workflows'];

/**
 * Resolve the canonical runtime config dir for the active runtime.
 *
 * Honours CLAUDE_CONFIG_DIR for custom/multi-account setups (mirrors
 * gsd-check-update.js detectConfigDir), else falls back to ~/.claude. The
 * canonical GSD tree always lives at `<configDir>/gsd-core`.
 */
function resolveConfigDir(homeDir, env) {
  const envDir = env.CLAUDE_CONFIG_DIR;
  if (envDir && typeof envDir === 'string' && envDir.trim().length > 0) {
    return envDir;
  }
  return path.join(homeDir, '.claude');
}

/**
 * Locate the bundled `gsd-core/` tree beneath a plugin root.
 *
 * Claude Code unpacks the package so the bundled tree sits at
 * `<pluginRoot>/gsd-core/`. Returns the absolute, realpath-normalised path to
 * that directory, or null if it is absent / not a directory. Resolving with
 * realpath collapses symlinks/.. so the subsequent containment check is sound.
 */
function resolveBundledTree(pluginRoot) {
  if (!pluginRoot || typeof pluginRoot !== 'string' || pluginRoot.trim().length === 0) {
    return null;
  }
  let root;
  try {
    root = fs.realpathSync(pluginRoot);
  } catch (_) {
    return null; // plugin root does not exist
  }
  const bundled = path.join(root, 'gsd-core');
  let bundledReal;
  try {
    // The bundled tree must be a real directory (or a symlink to one) that
    // resolves to a path inside the plugin root. realpathSync throws ENOENT/
    // ENOTDIR if <pluginRoot>/gsd-core is absent, so no separate existence
    // check is needed. Reject anything that does not resolve to a directory.
    bundledReal = fs.realpathSync(bundled);
    if (!fs.statSync(bundledReal).isDirectory()) return null;
  } catch (_) {
    return null;
  }
  // SECURITY: the resolved bundled tree must stay inside the resolved plugin
  // root. A crafted symlink at <pluginRoot>/gsd-core pointing outside the root
  // is rejected — we never link the canonical path at content we do not own.
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (bundledReal !== root && !bundledReal.startsWith(rootWithSep)) {
    return null;
  }
  return bundledReal;
}

/**
 * The fs.symlinkSync `type` to use for a directory link on a given platform.
 *
 * On Windows, unprivileged users cannot create symlinks but CAN create
 * junctions; 'junction' requires an absolute target (we always pass one). On
 * POSIX a 'dir' symlink is used. Exported so the win32 branch is unit-testable
 * without a Windows host.
 */
function dirLinkType(platform) {
  return platform === 'win32' ? 'junction' : 'dir';
}

/**
 * Create a directory symlink (junction on win32) from linkPath -> target.
 * Throws on real failure so the caller records it.
 */
function createDirLink(target, linkPath, platform) {
  fs.symlinkSync(target, linkPath, dirLinkType(platform));
}

/**
 * Does `linkPath` already correctly point at `expectedTarget`?
 * Used to make the hook idempotent — a correct link is left untouched.
 */
function linkPointsAt(linkPath, expectedTarget) {
  try {
    if (!fs.lstatSync(linkPath).isSymbolicLink()) return false;
    const resolved = fs.realpathSync(linkPath);
    return resolved === fs.realpathSync(expectedTarget);
  } catch (_) {
    return false;
  }
}

/**
 * Ensure the canonical `~/.claude/gsd-core/` path exposes the bundled subdirs.
 *
 * Pure, dependency-injected core so tests drive it with a fake home, fake
 * plugin root, and explicit platform. Returns a structured result describing
 * exactly what happened (never throws for ordinary conditions — only truly
 * unexpected I/O errors propagate, and the thin CLI wrapper swallows those so
 * a hook failure never blocks a session).
 *
 * @param {object} opts
 * @param {string} [opts.homeDir]    home directory (default os.homedir())
 * @param {string} [opts.pluginRoot] CLAUDE_PLUGIN_ROOT (default from env)
 * @param {string} [opts.platform]   process.platform override (tests)
 * @param {object} [opts.env]        environment (default process.env)
 * @returns {{status:string, canonicalDir?:string, bundledTree?:string,
 *            linked?:string[], prunedStale?:string[], preserved?:string[],
 *            skipped?:string[], reason?:string}}
 */
function ensureCanonicalPath(opts = {}) {
  const env = opts.env || process.env;
  const homeDir = opts.homeDir || os.homedir();
  const platform = opts.platform || process.platform;
  const pluginRoot = opts.pluginRoot !== undefined ? opts.pluginRoot : env.CLAUDE_PLUGIN_ROOT;

  // Uniform result contract: every return carries the four action arrays so
  // callers can read result.linked/etc without first switching on status.
  const empty = { linked: [], prunedStale: [], preserved: [], skipped: [] };

  // No plugin context → classic/npm install or non-plugin runtime. No-op.
  const bundledTree = resolveBundledTree(pluginRoot);
  if (!bundledTree) {
    return { status: 'noop', reason: 'no-plugin-bundle', ...empty };
  }

  const configDir = resolveConfigDir(homeDir, env);
  const canonicalDir = path.join(configDir, 'gsd-core');

  // Inspect the canonical path itself exactly once.
  //  - If it is a SYMLINK, the user (or another tool) deliberately pointed the
  //    canonical path elsewhere. We must NOT write managed links *through* that
  //    symlink into a directory we do not own — bail as a no-op.
  //  - If it is a REAL directory with at least one REAL (non-link) managed
  //    subdir, this is a classic `bin/install.js` install — leave it alone.
  let canonicalStat = null;
  try { canonicalStat = fs.lstatSync(canonicalDir); } catch (_) { canonicalStat = null; }

  if (canonicalStat && canonicalStat.isSymbolicLink()) {
    return { status: 'noop', reason: 'canonical-is-symlink', canonicalDir, bundledTree, ...empty };
  }

  if (canonicalStat && canonicalStat.isDirectory()) {
    for (const sub of MANAGED_SUBDIRS) {
      try {
        const subSt = fs.lstatSync(path.join(canonicalDir, sub));
        if (subSt.isDirectory() && !subSt.isSymbolicLink()) {
          return { status: 'noop', reason: 'classic-install', canonicalDir, bundledTree, ...empty };
        }
      } catch (_) { /* subdir absent — keep checking */ }
    }
  }

  // Ensure the canonical directory exists (as a real directory). We never
  // replace an existing real directory; recursive mkdir is a no-op if present.
  try {
    fs.mkdirSync(canonicalDir, { recursive: true });
  } catch (e) {
    return { status: 'error', reason: `mkdir-canonical: ${e.code || e.message}`, canonicalDir, bundledTree, ...empty };
  }

  const linked = [];
  const prunedStale = [];
  const preserved = [];
  const skipped = [];

  // SECURITY: prefix used to confirm every per-subdir link target resolves
  // strictly inside the bundled tree. Defence-in-depth against a tampered
  // bundle that ships an internally-escaping symlink at <bundledTree>/<sub>.
  const bundledWithSep = bundledTree.endsWith(path.sep) ? bundledTree : bundledTree + path.sep;

  for (const sub of MANAGED_SUBDIRS) {
    const target = path.join(bundledTree, sub);
    // Only expose subdirs the bundle actually ships, AND only when the target
    // resolves to a real directory that stays inside the bundled tree. A
    // subdir whose realpath escapes the bundle (e.g. a planted symlink) is
    // skipped — we never point the canonical path at content outside the
    // validated plugin bundle.
    let targetIsDir = false;
    try {
      const targetReal = fs.realpathSync(target);
      // A NAMED subdir must resolve strictly BELOW the bundled tree root. We do
      // NOT accept targetReal === bundledTree here: a subdir that self-links to
      // the tree root would otherwise be exposed at the wrong level (e.g.
      // `workflows` -> the whole tree), making `@.../workflows/foo` resolve to
      // `<tree>/foo` instead of `<tree>/workflows/foo`.
      targetIsDir = fs.statSync(targetReal).isDirectory()
        && targetReal.startsWith(bundledWithSep);
    } catch (_) { targetIsDir = false; }
    if (!targetIsDir) {
      skipped.push(sub);
      continue;
    }

    const linkPath = path.join(canonicalDir, sub);

    // Already a correct link → idempotent no-op.
    if (linkPointsAt(linkPath, target)) {
      linked.push(sub);
      continue;
    }

    let existing = null;
    try { existing = fs.lstatSync(linkPath); } catch (_) { existing = null; }

    if (existing) {
      // lstat().isSymbolicLink() is true for BOTH POSIX symlinks and Windows
      // junctions, so this single predicate identifies every GSD-managed link.
      if (existing.isSymbolicLink()) {
        // A GSD-managed link that is stale or points elsewhere (e.g. previous
        // plugin version after `claude plugin update`). Prune and recreate.
        try {
          fs.unlinkSync(linkPath);
          prunedStale.push(sub);
        } catch (e) {
          skipped.push(sub);
          continue;
        }
      } else {
        // A REAL file or directory the user (or a classic install) owns. NEVER
        // clobber it — preserve it untouched. This is the USER-PROFILE.md /
        // partially-real-canonical-dir safety case.
        preserved.push(sub);
        continue;
      }
    }

    try {
      createDirLink(target, linkPath, platform);
      linked.push(sub);
    } catch (e) {
      skipped.push(sub);
    }
  }

  return {
    status: 'ensured',
    canonicalDir,
    bundledTree,
    linked,
    prunedStale,
    preserved,
    skipped,
  };
}

module.exports = {
  ensureCanonicalPath,
  resolveBundledTree,
  resolveConfigDir,
  dirLinkType,
  MANAGED_SUBDIRS,
};

// CLI entry: run on SessionStart. Never block the session — any unexpected
// failure is swallowed (best-effort self-heal). Emit nothing on stdout to keep
// the hook silent in normal operation.
if (require.main === module) {
  try {
    ensureCanonicalPath();
  } catch (_) {
    // Best-effort: a canonical-path failure must never abort a session.
  }
  allow(undefined);
}
