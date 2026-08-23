'use strict';

/**
 * overlay-repo.cjs — shared "overlay repo" builder for install-spawning test
 * suites (extracted from tests/workflow-fragments-emission.install.test.cjs,
 * issue #2933, so a second divergent copy is never written — see
 * CONTEXT.md's Generative Fix Divergence anti-pattern).
 *
 * ── The overlay technique ────────────────────────────────────────────────
 *
 * A test that needs a spawned `bin/install.js` to read a DIFFERENT
 * `gsd-core/workflows/execute-phase.md` (or any other repo file) than this
 * checkout's real one, without paying to copy the ~400 MB repository (mostly
 * node_modules) for every run, calls `buildOverlayRepo` with a map of
 * POSIX-relative-path -> replacement content. `buildOverlayRepo` mirrors the
 * repo tree with real directories (so `copyWithPathReplacement`'s own
 * `entry.isDirectory()` / `entry.isFile()` Dirent checks — which do NOT
 * follow symlinks — see the correct type) and HARD-LINKS every unmodified
 * leaf file (not symlinks: a symlinked leaf file also fails an `isFile()`
 * Dirent check elsewhere in the installer, verified empirically — "Failed
 * to install agents: directory is empty" against a symlink-leaf overlay).
 * Only `node_modules` and `.git` are symlinked at the top level (install.js
 * never walks into either), which is what keeps the overlay build fast.
 * Every overlay-spawned installer should run with `--preserve-symlinks
 * --preserve-symlinks-main` as a defensive belt: with an all-hardlink leaf
 * layout this checkout does not currently NEED symlink-preservation for
 * correctness, but the flag is free insurance against a future install.js
 * change that resolves a node_modules package by real path.
 *
 * `buildOverlayRepo` can only REPLACE the content of a real leaf file that
 * already exists somewhere under `REPO_ROOT` — it cannot graft in a net-new
 * path (a `fileOverrides` key naming a path with no existing file/directory
 * ancestor in the real tree is silently never created, since `place()` only
 * walks `fs.readdirSync` of the REAL source directory).
 *
 * ── `opts.mode`: 'link' (default) vs 'copy' ─────────────────────────────
 *
 * `'link'` (the default, and every pre-existing caller's behavior) hard-links
 * every unmodified leaf — cheap, but a `--write` generator run inside the
 * overlay does an in-place `writeFileSync` through that hard link, i.e. the
 * SAME INODE as this real checkout's own tracked file, silently corrupting
 * it. `'copy'` mode instead COPIES every unmodified leaf (`fs.copyFileSync`,
 * a real independent inode), so a real `--write` generator — or a full `npm
 * run regen:derived` chain — can safely run to completion inside the overlay
 * without ever touching `REPO_ROOT`. `node_modules` and `.git` are still
 * symlinked at the top level in BOTH modes (unchanged from `'link'` mode):
 * `install.js`/`npm`/`tsc` never write into either through the overlay path,
 * only read/resolve through them, and symlinking is what keeps even
 * `'copy'` mode affordable (`node_modules` alone dwarfs the rest of the
 * tree).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');

const OVERLAY_SKIP_TOP = new Set(['node_modules', '.git']);

/**
 * True when `err` reports that a path was not there.
 *
 * @param {unknown} err
 * @returns {boolean}
 */
function isMissingPath(err) {
  return Boolean(err) && typeof err === 'object' && err.code === 'ENOENT';
}

/**
 * Run `attempt` against a source path that another process may be replacing
 * underneath the walk, and report whether the leaf was actually placed.
 *
 * `buildOverlayRepo` enumerates names with `readdirSync` and then acts on them,
 * which is a TOCTOU window. It is not theoretical: `hooks/dist` is regenerated
 * by an ATOMIC REPLACE (`scripts/build-hooks.js` unlinks and renames), so any
 * concurrently running test that rebuilds hooks makes a just-listed name vanish
 * mid-walk. That took down three runs on three different branches with a bare
 * `ENOENT ... link '/work/hooks/dist/...'`.
 *
 * On ENOENT the source is re-examined ONCE rather than slept on: an atomic
 * rename is a single syscall, so by the time the failure surfaces the successor
 * is either already in place (retry succeeds) or the path is genuinely gone from
 * the tree (nothing to mirror, so the leaf is skipped). No sleep, no spin — a
 * timing-based wait here would be the flake this is fixing, not a fix for it.
 *
 * The retry itself can also lose the race — a second atomic replace landing in
 * the same window makes the retry throw ENOENT too (e.g. two concurrent
 * `build:hooks` runs). That is still just "the path is vanishing": the same
 * conclusion the single-vanish case reaches, so it is likewise treated as
 * skipped rather than left to escape as a bare uncaught ENOENT (#3108). There
 * is still only ONE retry — a second retry would turn this into the sleep/spin
 * loop the comment above already rejects.
 *
 * Returns false only when the path left the source tree entirely (on the
 * first attempt OR the retry); the overlay mirrors the tree, and a file that
 * is no longer in it is not part of the snapshot. Every other error — from
 * EITHER attempt, non-ENOENT — propagates untouched; that invariant must hold
 * for any future widening of this tolerance.
 *
 * @param {string} srcPath
 * @param {() => void} attempt
 * @returns {boolean} whether the leaf was placed
 */
function placeVanishableLeaf(srcPath, attempt) {
  try {
    attempt();
    return true;
  } catch (err) {
    if (!isMissingPath(err)) throw err;
    if (!fs.existsSync(srcPath)) return false;
    try {
      attempt();
      return true;
    } catch (retryErr) {
      if (!isMissingPath(retryErr)) throw retryErr;
      return false;
    }
  }
}

/** Hard-link a file, falling back to a real copy only if the two paths sit on
 *  different filesystems/devices (EXDEV) or linking is denied (EPERM) — both
 *  cross-platform-legitimate, unlike a symlink's Dirent type-detection gap.
 *  Returns whether the leaf was placed; false means the source vanished
 *  mid-walk (see `placeVanishableLeaf`). */
function linkOrCopyFile(src, dest) {
  return placeVanishableLeaf(src, () => {
    try {
      fs.linkSync(src, dest);
    } catch (err) {
      if (err.code === 'EXDEV' || err.code === 'EPERM') {
        fs.copyFileSync(src, dest);
      } else {
        throw err;
      }
    }
  });
}

/**
 * Build a throwaway mirror of REPO_ROOT with real directories throughout and
 * every unmodified leaf file hard-linked (or copied — see `opts.mode`
 * above), except the paths named in `fileOverrides`
 * (POSIX-relative-path -> content string), which are written as real files.
 * Returns the mirror's absolute path; caller must
 * `fs.rmSync(..., {recursive:true, force:true})` it away.
 *
 * @param {{[relPath: string]: string}} fileOverrides
 * @param {{mode?: 'link'|'copy'}} [opts] - `mode` defaults to `'link'` so
 *   every pre-existing caller is unchanged. Pass `{mode: 'copy'}` when the
 *   overlay must survive a real `--write` generator run (see the module doc
 *   above) — every leaf file becomes a real independent inode, so no write
 *   inside the overlay can ever reach `REPO_ROOT`.
 */
function buildOverlayRepo(fileOverrides, opts = {}) {
  const mode = opts.mode || 'link';
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2930-overlay-'));
  const entries = Object.entries(fileOverrides).map(([relPath, content]) => ({
    parts: relPath.split('/'),
    content,
  }));
  const skipped = [];

  function place(srcDir, destDir, pending, isTop) {
    fs.mkdirSync(destDir, { recursive: true });
    const grouped = new Map();
    for (const e of pending) {
      const [head, ...rest] = e.parts;
      if (!grouped.has(head)) grouped.set(head, []);
      grouped.get(head).push({ parts: rest, content: e.content });
    }
    for (const de of fs.readdirSync(srcDir, { withFileTypes: true })) {
      if (isTop && OVERLAY_SKIP_TOP.has(de.name)) {
        fs.symlinkSync(path.join(srcDir, de.name), path.join(destDir, de.name));
        continue;
      }
      const srcPath = path.join(srcDir, de.name);
      const destPath = path.join(destDir, de.name);
      const overridden = grouped.get(de.name);
      const leaf = overridden && overridden.find((s) => s.parts.length === 0);
      if (leaf) {
        fs.writeFileSync(destPath, leaf.content);
        continue;
      }
      // fs.statSync follows symlinks (unlike Dirent.isDirectory()), so a
      // symlinked source directory is still recursed as a REAL directory in
      // the overlay — the property copyWithPathReplacement itself needs.
      //
      // The stat sits in the same TOCTOU window as the copy/link below: the
      // name came from readdirSync, and an atomic replace elsewhere in the tree
      // can retire it before we get here.
      let srcStat;
      try {
        srcStat = fs.statSync(srcPath);
      } catch (err) {
        if (isMissingPath(err)) continue;
        throw err;
      }
      if (srcStat.isDirectory()) {
        place(srcPath, destPath, overridden || [], false);
      } else if (mode === 'copy') {
        // Real independent inode — a write through this path in the overlay
        // can never alias back to REPO_ROOT's own tracked file (see
        // opts.mode doc above).
        const placed = placeVanishableLeaf(srcPath, () => fs.copyFileSync(srcPath, destPath));
        if (!placed) skipped.push(srcPath);
      } else {
        const placed = linkOrCopyFile(srcPath, destPath);
        if (!placed) skipped.push(srcPath);
      }
    }
  }

  place(REPO_ROOT, tmpRepo, entries, true);

  if (skipped.length > 0) {
    // Not thrown: a source that left the tree mid-walk is genuinely not part of
    // the snapshot, and failing here would reintroduce the crash this tolerance
    // exists to remove. But it must not be SILENT either — a dropped leaf can
    // surface later as a confusing "file missing" in an unrelated assertion, or
    // as nothing at all for a test that never touches it.
    console.warn(
      `buildOverlayRepo: ${skipped.length} source file(s) vanished mid-walk and were ` +
      `omitted from the overlay (likely a concurrent atomic replace, e.g. hooks/dist — ` +
      `run \`npm run build:hooks\` to regenerate it):\n  ` +
      skipped.join('\n  '),
    );
  }

  return tmpRepo;
}

module.exports = { buildOverlayRepo, linkOrCopyFile, placeVanishableLeaf, isMissingPath, REPO_ROOT, OVERLAY_SKIP_TOP };
