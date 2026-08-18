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
 * entry points (and `sha256File`, their shared hashing helper — still raw-fd
 * streaming via `openSync`/`readSync`/`closeSync`, now routed through this
 * seam instead of calling `node:fs` directly, so large-file hashing never
 * buffers a whole file through the injected adapter either) are routed; the
 * rest of that file is untouched, deliberately, because it is off this call
 * tree.
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
 * ⚠️ PARTIAL-ADAPTER TRAP (#2875 defect fix — CLOSED, not merely documented):
 * `withInstallFs` used to merge the injected `partial` OVER the real adapter
 * (`{ ...REAL_ADAPTER, ...partial }`), so any method the partial did not
 * define silently resolved to REAL `node:fs`. An incomplete fake was not a
 * smaller fake adapter; for the methods it omitted, it WAS the real
 * filesystem — a genuine production hazard, not only a test-authoring
 * footgun: `user-artifact-staging.cts`'s `stageUserArtifacts` calls
 * `installFs().rmSync(entryDir)` unconditionally as its entryDir-clearing
 * step, and a `deps.fs` that omits `rmSync` (an easy oversight — nothing in
 * the type system catches a plain-JS test object missing a key at runtime)
 * silently deleted the real `<configDir>/.gsd-staging/<key>` on disk instead
 * of failing loudly or staying confined to the fake's own store.
 *
 * `withInstallFs` now builds a GUARDED adapter instead: every method the
 * partial does not define — except `realpathSync`, the one method this
 * module's own contract documents as intentionally degrading to real fs
 * (see its own doc comment below) — throws immediately IF CALLED, naming the
 * missing method, instead of silently delegating to real fs. This only
 * changes behavior for the injected-partial path (`withInstallFs(partial,
 * fn)` with a defined `partial`); the no-adapter-injected default (AC4)
 * still resolves to `REAL_ADAPTER` untouched, and any partial fake that
 * genuinely implements every method its code path touches — the documented,
 * intended usage — is byte-identical to before. A test asserting "no real IO
 * happened" against a partial fake can now rely on this guard directly
 * instead of having to hand-poison real `fs` methods itself (see
 * `tests/executed-plan.test.cjs`'s F2 test, which still poisons real `fs` as
 * defense-in-depth belt-and-suspenders, not because this guard is
 * insufficient on its own).
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
  /** #2875 (epic #2866 Phase 6 / user-artifact-staging.cts): added so
   *  installer-migrations.cts's `copyPreservingSymlink` — reused by the
   *  staging module to copy a user-owned artifact without ever dereferencing
   *  a symlink (test-matrix A4) — can route ALL FIVE of its fs calls through
   *  this seam instead of punching a hole through it for just these two. */
  symlinkSync(target: string, p: string): void;
  readlinkSync(p: string): string;
  /** Raw-fd streaming trio, added so `installer-migrations.cts`'s
   *  `sha256File` can hash a file in fixed-size chunks through this seam
   *  instead of buffering the whole file via `readFileSync` — see the
   *  module doc's opening paragraph and `tests/installer-migrations.test.cjs`'s
   *  "classifies large files without loading the whole file through
   *  readFileSync", which pins this contract directly: it monkeypatches real
   *  `fs.readFileSync` to throw for the file under test and asserts hashing
   *  still succeeds, proving the hash path never calls it. */
  openSync(p: string, flags: string): number;
  readSync(fd: number, buffer: Buffer, offset: number, length: number, position: number | null): number;
  closeSync(fd: number): void;
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
  symlinkSync: (target, p) => nodeFs.symlinkSync(target, p),
  readlinkSync: (p) => nodeFs.readlinkSync(p),
  openSync: (p, flags) => nodeFs.openSync(p, flags),
  readSync: (fd, buffer, offset, length, position) => nodeFs.readSync(fd, buffer, offset, length, position),
  closeSync: (fd) => nodeFs.closeSync(fd),
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

// Methods allowed to silently degrade to real fs when a partial injected
// adapter omits them — see the module doc's "PARTIAL-ADAPTER TRAP". This is
// deliberately a single, narrow, documented exception: `realpathSync`'s own
// interface doc comment already promises graceful real-fs fallback (the
// symlink guard treats a `realpathSync` failure as "fall back to the lexical
// form" anyway, so an absent method degrading the same way changes nothing
// observable). Every other method is REQUIRED by `InstallFsAdapter`'s own
// type (no `?`) and now enforces that at runtime too.
const OPTIONAL_ADAPTER_METHODS: ReadonlySet<keyof InstallFsAdapter> = new Set(['realpathSync']);

/**
 * Build a merged adapter for an injected `partial`: every method `partial`
 * defines is used as-is; `realpathSync` (only) falls back to real fs when
 * absent; every other omitted method becomes a stub that THROWS if actually
 * called, naming the missing method — turning a silent real-fs fall-through
 * into an immediate, diagnosable failure (module doc "PARTIAL-ADAPTER TRAP").
 * A method never invoked by the exercised code path never throws, so this is
 * safe for any existing partial fake that only implements what it touches.
 */
function buildGuardedAdapter(partial: Partial<InstallFsAdapter>): InstallFsAdapter {
  const guarded = {} as Record<keyof InstallFsAdapter, unknown>;
  for (const key of Object.keys(REAL_ADAPTER) as (keyof InstallFsAdapter)[]) {
    if (Object.prototype.hasOwnProperty.call(partial, key)) {
      guarded[key] = partial[key];
    } else if (OPTIONAL_ADAPTER_METHODS.has(key)) {
      guarded[key] = REAL_ADAPTER[key];
    } else {
      guarded[key] = (..._args: unknown[]) => {
        throw new Error(
          `installFs().${key}(...) was called but the injected partial adapter does not implement it. ` +
          `A fake adapter must implement every method its code path touches (install-fs-adapter.cts's ` +
          `PARTIAL-ADAPTER TRAP) — falling through to real fs is no longer allowed for this method.`,
        );
      };
    }
  }
  return guarded as unknown as InstallFsAdapter;
}

/**
 * Run `fn` with a GUARDED merge of `partial` over the real adapter as the
 * active install-fs adapter, restoring the previous adapter afterward — even
 * on throw (see the module doc's re-entrancy/synchronous-only assumption for
 * why a bare module-level variable is safe here, and why it would not be
 * under async interleaving or concurrent installs). `partial` undefined is
 * a no-op: `fn` runs against whatever adapter was already active (real fs
 * by default) — this is what keeps every existing `deps`-less call site
 * (AC4) byte-identical. See `buildGuardedAdapter` for what "guarded" means.
 */
function withInstallFs<T>(partial: Partial<InstallFsAdapter> | undefined, fn: () => T): T {
  if (!partial) return fn();
  const previous = current;
  current = buildGuardedAdapter(partial);
  try {
    return fn();
  } finally {
    current = previous;
  }
}

/**
 * Create a fresh, uniquely-named temp directory.
 *
 * AC4 requires the no-adapter-injected path to stay byte-identical to the
 * pre-#2874 code, which called real `fs.mkdtempSync` directly — several
 * existing tests (e.g. tests/install-runtime-artifacts.test.cjs's "rmSync is
 * called on the tempDir when readFileSync throws") monkeypatch real
 * `fs.mkdtempSync` to capture the exact directory a call under test creates,
 * and stop working if that real syscall is no longer made. So: when NO fake
 * adapter is active (`current === REAL_ADAPTER`, the exact top-level-install
 * default), this calls `nodeFs.mkdtempSync` directly — the same real call
 * the old code made, still visible to a monkeypatch applied after import
 * because it is a live property lookup on the `node:fs` module object, not a
 * captured reference.
 *
 * When a fake adapter IS active (any `withInstallFs(partial, …)` call, even
 * a partial one — see `current`'s assignment in `withInstallFs`, which
 * always produces a NEW merged object, never `=== REAL_ADAPTER`), this falls
 * back to synthesizing a unique name and creating it via
 * `installFs().mkdirSync`, exactly as before: the injected adapter contract
 * still does not require `mkdtempSync`, so a fake (which only needs to
 * implement `mkdirSync`) can drive the full staging pipeline without ever
 * touching real fs.
 */
function mkInstallTempDir(prefix: string): string {
  if (current === REAL_ADAPTER) {
    return nodeFs.mkdtempSync(path.join(os.tmpdir(), prefix));
  }
  const dir = path.join(os.tmpdir(), `${prefix}${crypto.randomBytes(8).toString('hex')}`);
  installFs().mkdirSync(dir, { recursive: true });
  return dir;
}

export = { installFs, withInstallFs, mkInstallTempDir };
