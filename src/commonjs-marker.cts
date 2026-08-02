'use strict';

/**
 * CommonJS module-type marker — single source of truth (#2544).
 *
 * GSD stages its own hook scripts and native plugin adapters as `.js` files.
 * Node resolves a `.js` file's module type by walking up for the nearest
 * `package.json`, so an ambient `"type": "module"` above the install location
 * makes every one of those scripts fail with `require is not defined`. GSD
 * pins them to CommonJS by writing a minimal `{"type":"commonjs"}` marker.
 *
 * Two rules govern that marker, and this module exists so both are enforced in
 * exactly one place:
 *
 * 1. **Write only where GSD owns the contents.** The marker belongs in the
 *    directories GSD fills with its own `.js` files (`hooks/`, and the
 *    `nativePlugin.dir` for the runtimes that declare one) — never at the
 *    runtime's shared config root, which on OpenCode and Kilo is documented,
 *    user-writable territory for declaring local-plugin npm dependencies.
 *
 * 2. **Never overwrite a file GSD did not write.** Before #2544 the install
 *    path wrote the marker unconditionally while the uninstall path already
 *    compared content before unlinking. That asymmetry is the defect: the
 *    discipline existed in the codebase, it was simply not applied on the
 *    write side. `classifyMarker` is now the shared predicate behind both
 *    `ensureCommonJsMarker` and `removeCommonJsMarker`, so install and
 *    uninstall cannot drift apart again.
 *
 * Ownership is decided by exact content match against the marker GSD itself
 * writes — the same test the uninstall path has always used.
 */

import fs from 'node:fs';
import path from 'node:path';

/** The exact marker content GSD writes (and the only content it will remove). */
export const COMMONJS_MARKER = '{"type":"commonjs"}';

/** File bytes written to disk — the marker plus a trailing newline. */
export const COMMONJS_MARKER_CONTENT = `${COMMONJS_MARKER}\n`;

/**
 * `absent`     — no package.json here; GSD may create one.
 * `gsd-owned`  — content is exactly GSD's marker; GSD may rewrite or remove it.
 * `foreign`    — anything else, including a present-but-unreadable file. GSD
 *                must leave it strictly alone.
 */
export type MarkerOwnership = 'absent' | 'gsd-owned' | 'foreign';

/**
 * Outcome of an `ensureCommonJsMarker` call, for caller-side reporting.
 *
 * `failed` is the best-effort outcome: the marker could not be written for an
 * environmental reason (`EACCES` on a read-only `hooks/`, `EROFS`, `ENOSPC`).
 * It is reported, never thrown — see `ensureCommonJsMarker`.
 */
export type MarkerWriteOutcome = 'written' | 'unchanged' | 'preserved-foreign' | 'failed';

/** The marker path for a directory. */
export function markerPathFor(dir: string): string {
  return path.join(dir, 'package.json');
}

/**
 * Classify the package.json in `dir` by ownership.
 *
 * Fails CLOSED: a file that exists but cannot be read is reported `foreign`,
 * never `absent`. Reporting it absent would license the overwrite this module
 * exists to prevent. (Same posture as the unreadable-config branch in
 * capability-command-router.cjs: present-but-unreadable never downgrades to
 * the permissive answer.)
 */
export function classifyMarker(dir: string): MarkerOwnership {
  const markerPath = markerPathFor(dir);
  let stat: import('node:fs').Stats;
  try {
    // lstat, not existsSync: existsSync follows symlinks and reports `false`
    // for a DANGLING one, which would classify the path `absent` and let the
    // write below follow the link and land outside the directory GSD owns.
    stat = fs.lstatSync(markerPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    return 'foreign';
  }
  // Anything that is not a regular file (symlink, directory, socket) is not
  // something GSD wrote, so it is never ours to overwrite or remove.
  if (!stat.isFile()) return 'foreign';
  try {
    const content = fs.readFileSync(markerPath, 'utf8');
    return content.trim() === COMMONJS_MARKER ? 'gsd-owned' : 'foreign';
  } catch {
    return 'foreign';
  }
}

/**
 * Write the CommonJS marker into `dir`, unless a file GSD does not own is
 * already there.
 *
 * Creates `dir` when needed. Returns what happened so the caller can report
 * it; a `preserved-foreign` result is not an error — it is the guard working.
 *
 * NEVER THROWS. Every other marker interaction in this module is best-effort —
 * `removeCommonJsMarker` swallows unlink failures, `classifyMarker` swallows
 * read failures — and the write path is the one most likely to fail on a
 * locked-down config dir (`EACCES` on a read-only `hooks/`, `EROFS`, `ENOSPC`).
 * Letting it throw made an unwritable marker abort the entire install with a
 * raw stack trace, which is a strictly worse outcome than hooks that resolve as
 * ESM: the caller can warn and continue, and does. Both the `mkdir` and the
 * write are inside the guard — creating the directory is the same environmental
 * hazard as writing into it.
 */
export function ensureCommonJsMarker(dir: string): MarkerWriteOutcome {
  const ownership = classifyMarker(dir);
  if (ownership === 'foreign') return 'preserved-foreign';
  if (ownership === 'gsd-owned') return 'unchanged';
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Exclusive create closes the gap between classifying and writing: if
    // anything at all appeared at the path in between — including a symlink —
    // this fails with EEXIST instead of following or overwriting it.
    fs.writeFileSync(markerPathFor(dir), COMMONJS_MARKER_CONTENT, { flag: 'wx' });
    return 'written';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'preserved-foreign';
    return 'failed';
  }
}

/**
 * Remove the CommonJS marker from `dir` — only when the content is exactly
 * the marker GSD writes. Returns true when a file was removed.
 */
export function removeCommonJsMarker(dir: string): boolean {
  if (classifyMarker(dir) !== 'gsd-owned') return false;
  try {
    fs.unlinkSync(markerPathFor(dir));
    return true;
  } catch {
    return false;
  }
}
