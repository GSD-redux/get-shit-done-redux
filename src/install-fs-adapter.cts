'use strict';

/**
 * Install Fs Adapter — #2874 (epic #2866 Phase 5), governed by ADR-58.
 *
 * Narrow, enumerated fs seam for the install/staging call tree rooted at
 * `installRuntimeArtifacts` (install-engine.cts): layout source-root
 * resolution (runtime-artifact-layout.cts), profile staging
 * (install-profiles.cts), content-rewrite passes
 * (runtime-artifact-conversion.cts), the CommonJS module-type marker
 * (commonjs-marker.cts), and the two installer-migrations entry points this
 * call tree reaches — `readInstallManifest` / `classifyArtifact`
 * (installer-migrations.cts). Extends the `deps` bag precedent already
 * established by `createRuntimeArtifactInstallPlan`
 * (runtime-artifact-install-plan.cts:155) — this is NOT a general-purpose
 * `node:fs` wrapper (40-design.md "Rejected" #1): only the operations this
 * call tree actually performs are enumerated below. installer-migrations.cts
 * is ~1200 lines covering migration planning/apply/rollback/locking/journal
 * machinery unrelated to `installRuntimeArtifacts` — only its two reachable
 * entry points (and `sha256File`, their shared hashing helper, converted
 * from raw-fd streaming to `installFs().readFileSync` so it stays inside
 * this seam's method set) are routed; the rest of that file is untouched,
 * deliberately, because it is off this call tree.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DELIVERY MECHANISM — ambient, not threaded (read this before adding a call
 * site that needs a different adapter mid-call)
 * ─────────────────────────────────────────────────────────────────────────
 *
 * A single mutable "current adapter" (`current`, below) is swapped for the
 * duration of one synchronous `installRuntimeArtifacts` call via
 * `withInstallFs`, rather than a `deps` parameter threaded through every
 * function on the call tree. The rejected alternative was threading: it
 * would touch signatures across `install-profiles.cts` (5 staging
 * functions), the 3000+-line `runtime-artifact-conversion.cts` (rewrite
 * passes), `commonjs-marker.cts`, and `installer-migrations.cts` — a dozen+
 * unrelated call sites — for no behavioral gain over an ambient swap, and
 * `createRuntimeArtifactInstallPlan`'s own `deps` bag (the precedent this
 * seam extends) does not reach that deep either. Every fs-touching site on
 * the call tree reads the active adapter via `installFs()` instead of
 * importing `node:fs` directly.
 *
 * SYNCHRONOUS-ONLY / RE-ENTRANCY ASSUMPTION (load-bearing, not incidental):
 * every method on this seam is `*Sync`, and `installRuntimeArtifacts` never
 * awaits mid-call — the whole call tree from the top-level `withInstallFs`
 * wrap down to the last `fs` touch runs on one turn of the event loop with
 * no interleaving. That is what makes a single ambient variable safe instead
 * of a race: nothing else can observe or mutate `current` while it is set.
 * This assumption BREAKS if `installRuntimeArtifacts` (or anything it calls)
 * ever becomes `async`, or if two installs run concurrently in the same
 * process (the second `withInstallFs` call would clobber the first's
 * adapter mid-flight) — neither is true today, but a future change that
 * introduces either must revisit this module before trusting it.
 *
 * DEFERRED CLEANUP ACROSS THE RESTORE (#2874 leak-fix): staged directories
 * outlive one `withInstallFs` call — `install-profiles.cts`'s
 * `cleanupStagedSkills` runs later, from a `process.on('exit'/'SIGINT'/…)`
 * handler, by which time `withInstallFs`'s `finally` has already restored
 * `current` back to whatever was active before (real fs, in the top-level
 * case). A cleanup handler that resolved "which adapter do I use" via
 * `installFs()` at CLEANUP time would therefore always see the real adapter,
 * even for a directory that was staged entirely inside a fake-adapter call —
 * performing real filesystem IO on a path that only ever existed in the
 * fake's in-memory store. `install-profiles.cts` avoids this by capturing
 * the adapter OBJECT `installFs()` returns at STAGING (registration) time,
 * keyed by path, in its own `STAGED_DIR_ADAPTERS` map, and replaying that
 * captured object — not the ambient `current` — at cleanup time. A real
 * install's dirs were staged with the real adapter object, so their cleanup
 * is byte-identical to before this fix.
 *
 * `withInstallFs` ALWAYS restores the previous adapter in a `finally`, even
 * on throw — a failed install (or a test that intentionally throws to prove
 * a guard) must never leak a fake adapter into whatever runs next in the
 * same process (e.g. the next `node:test` in a shared worker).
 *
 * ⚠️ PARTIAL-ADAPTER TRAP: `withInstallFs` merges the injected `partial`
 * OVER the real adapter (`{ ...REAL_ADAPTER, ...partial }`) — any method the
 * partial does not define resolves to REAL `node:fs`, silently. An
 * incomplete fake is not a smaller fake adapter; for the methods it omits,
 * it IS the real filesystem. A test asserting "no real IO happened" against
 * a partial fake must either implement every method the exercised code path
 * touches, or explicitly account for the ones it does not (see
 * `tests/executed-plan.test.cjs`'s F2 test, which poisons real `fs` methods
 * for exactly this reason — a gap here shows up as the poisoned method
 * firing, not as a silent pass).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SECURITY NOTE (40-design.md rows 6/7, H1-H5)
 * ─────────────────────────────────────────────────────────────────────────
 * This module carries NO policy. `hasExistingSymlinkBetween` and
 * `assertDestWithinConfigHome` keep their REFUSAL DECISIONS outside this
 * seam — only their probe calls (existsSync/lstatSync/realpathSync) are
 * routed through it. Injecting a fake adapter can only change what those
 * probes observe for paths that were never real to begin with; it cannot
 * flip the decision logic itself.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DELIBERATELY NOT ROUTED (see the call sites themselves for the full
 * reasoning — this is the index)
 * ─────────────────────────────────────────────────────────────────────────
 * `findInstallSourceRoot` / `findAgentsSourceRoot`'s walk-up-from-__dirname
 * step (runtime-artifact-layout.cts) locates THIS PACKAGE'S OWN source tree
 * (`commands/gsd/`, `agents/`) — not the install destination — so it uses
 * `fs.statSync` directly, unrouted. A fake destination adapter's store
 * starts empty and is never seeded with real repo paths; routing this walk
 * through it would make every fake-adapter install throw
 * "could not locate commands/gsd", not gracefully stage nothing. See the
 * comment at each function's Step 2 for the full argument.
 *
 * RULE (40-design.md "Known limits"): this seam makes *destination* IO
 * fake-able; package-source IO (this section) stays real by design — the F2
 * test's poison list should be derived FROM that rule, not the reverse, or a
 * future "complete the poison list" edit that adds `statSync` will break a
 * correct `findInstallSourceRoot` for the wrong reason.
 */

import nodeFs from 'node:fs';
import type { Dirent } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// Precisely typed (unlike install-engine.cts's own house style) so every
// OTHER file this adapter is imported into — install-profiles.cts,
// runtime-artifact-layout.cts, retired-artifact-cleanup.cts,
// command-roster.cts, commonjs-marker.cts, installer-migrations.cts — none
// of which blanket-disable the `no-unsafe-*` rules — keeps its existing
// strict typing at each call site instead of degrading to `any` through
// this seam.
interface InstallFsAdapter {
  existsSync(p: string): boolean;
  mkdirSync(p: string, opts?: { recursive?: boolean }): string | undefined;
  rmSync(p: string, opts?: { recursive?: boolean; force?: boolean }): void;
  readdirSync(p: string, opts: { withFileTypes: true }): Dirent[];
  readdirSync(p: string): string[];
  readFileSync(p: string, encoding: BufferEncoding): string;
  readFileSync(p: string): Buffer;
  writeFileSync(p: string, data: string | Buffer, opts?: BufferEncoding | { encoding?: BufferEncoding; flag?: string }): void;
  copyFileSync(src: string, dest: string): void;
  cpSync(src: string, dest: string, opts?: { recursive?: boolean }): void;
  lstatSync(p: string): { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean };
  /** Optional — a partial injected adapter that omits this falls back to the
   *  real fs.realpathSync (merged in by `withInstallFs`). The symlink guard
   *  already treats a realpathSync FAILURE as "fall back to the lexical
   *  form" (see its own doc comment); an absent method degrades the same
   *  way — never a hard failure. */
  realpathSync(p: string): string;
  unlinkSync(p: string): void;
  rmdirSync(p: string): void;
}

const REAL_ADAPTER: InstallFsAdapter = {
  existsSync: (p) => nodeFs.existsSync(p),
  mkdirSync: (p, opts) => nodeFs.mkdirSync(p, opts),
  rmSync: (p, opts) => nodeFs.rmSync(p, opts),
  readdirSync: ((p: string, opts?: { withFileTypes: true }) =>
    (opts ? nodeFs.readdirSync(p, opts) : nodeFs.readdirSync(p))) as InstallFsAdapter['readdirSync'],
  readFileSync: ((p: string, encoding?: BufferEncoding) =>
    (encoding ? nodeFs.readFileSync(p, encoding) : nodeFs.readFileSync(p))) as InstallFsAdapter['readFileSync'],
  writeFileSync: (p, data, opts) => nodeFs.writeFileSync(p, data, opts),
  copyFileSync: (src, dest) => nodeFs.copyFileSync(src, dest),
  cpSync: (src, dest, opts) => nodeFs.cpSync(src, dest, opts),
  lstatSync: (p) => nodeFs.lstatSync(p),
  realpathSync: (p) => nodeFs.realpathSync(p),
  unlinkSync: (p) => nodeFs.unlinkSync(p),
  rmdirSync: (p) => nodeFs.rmdirSync(p),
};

let current: InstallFsAdapter = REAL_ADAPTER;

/**
 * Returns the fs adapter active for the currently-running install call —
 * the real adapter when no `deps.fs` was injected, or the injected partial
 * adapter merged over the real one (any method it did not override still
 * resolves to real fs — see the module doc's "PARTIAL-ADAPTER TRAP").
 */
function installFs(): InstallFsAdapter {
  return current;
}

/**
 * Run `fn` with `partial` merged over the real adapter as the active
 * install-fs adapter, restoring the previous adapter afterward — even on
 * throw (see the module doc's re-entrancy/synchronous-only assumption for
 * why a bare module-level variable is safe here, and why it would not be
 * under async interleaving or concurrent installs). `partial` undefined is
 * a no-op: `fn` runs against whatever adapter was already active (real fs
 * by default) — this is what keeps every existing `deps`-less call site
 * (AC4) byte-identical.
 */
function withInstallFs<T>(partial: Partial<InstallFsAdapter> | undefined, fn: () => T): T {
  if (!partial) return fn();
  const previous = current;
  current = { ...REAL_ADAPTER, ...partial };
  try {
    return fn();
  } finally {
    current = previous;
  }
}

/**
 * Create a fresh, uniquely-named directory via `installFs().mkdirSync`
 * instead of `fs.mkdtempSync`. The injected adapter contract deliberately
 * does not require `mkdtempSync` — every staging call site that used to call
 * `fs.mkdtempSync` directly now synthesizes its own unique name and creates
 * it through the same adapter every other write in this seam goes through,
 * so a fake adapter (which only needs to implement `mkdirSync`) can still
 * drive the full staging pipeline.
 */
function mkInstallTempDir(prefix: string): string {
  const dir = path.join(os.tmpdir(), `${prefix}${crypto.randomBytes(8).toString('hex')}`);
  installFs().mkdirSync(dir, { recursive: true });
  return dir;
}

export = { installFs, withInstallFs, mkInstallTempDir };
