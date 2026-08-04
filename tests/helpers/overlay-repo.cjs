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
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');

const OVERLAY_SKIP_TOP = new Set(['node_modules', '.git']);

/** Hard-link a file, falling back to a real copy only if the two paths sit on
 *  different filesystems/devices (EXDEV) or linking is denied (EPERM) — both
 *  cross-platform-legitimate, unlike a symlink's Dirent type-detection gap. */
function linkOrCopyFile(src, dest) {
  try {
    fs.linkSync(src, dest);
  } catch (err) {
    if (err.code === 'EXDEV' || err.code === 'EPERM') {
      fs.copyFileSync(src, dest);
    } else {
      throw err;
    }
  }
}

/**
 * Build a throwaway mirror of REPO_ROOT with real directories throughout and
 * every unmodified leaf file hard-linked, except the paths named in
 * `fileOverrides` (POSIX-relative-path -> content string), which are written
 * as real files. Returns the mirror's absolute path; caller must
 * `fs.rmSync(..., {recursive:true, force:true})` it away.
 *
 * @param {{[relPath: string]: string}} fileOverrides
 */
function buildOverlayRepo(fileOverrides) {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-2930-overlay-'));
  const entries = Object.entries(fileOverrides).map(([relPath, content]) => ({
    parts: relPath.split('/'),
    content,
  }));

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
      if (fs.statSync(srcPath).isDirectory()) {
        place(srcPath, destPath, overridden || [], false);
      } else {
        linkOrCopyFile(srcPath, destPath);
      }
    }
  }

  place(REPO_ROOT, tmpRepo, entries, true);
  return tmpRepo;
}

module.exports = { buildOverlayRepo, linkOrCopyFile, REPO_ROOT, OVERLAY_SKIP_TOP };
