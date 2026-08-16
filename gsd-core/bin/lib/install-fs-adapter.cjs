'use strict';
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
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
 */
const node_fs_1 = __importDefault(require("node:fs"));
const node_os_1 = __importDefault(require("node:os"));
const node_path_1 = __importDefault(require("node:path"));
const node_crypto_1 = __importDefault(require("node:crypto"));
const REAL_ADAPTER = {
    existsSync: (p) => node_fs_1.default.existsSync(p),
    mkdirSync: (p, opts) => node_fs_1.default.mkdirSync(p, opts),
    rmSync: (p, opts) => node_fs_1.default.rmSync(p, opts),
    readdirSync: ((p, opts) => (opts ? node_fs_1.default.readdirSync(p, opts) : node_fs_1.default.readdirSync(p))),
    readFileSync: ((p, encoding) => (encoding ? node_fs_1.default.readFileSync(p, encoding) : node_fs_1.default.readFileSync(p))),
    writeFileSync: (p, data, opts) => node_fs_1.default.writeFileSync(p, data, opts),
    copyFileSync: (src, dest) => node_fs_1.default.copyFileSync(src, dest),
    cpSync: (src, dest, opts) => node_fs_1.default.cpSync(src, dest, opts),
    lstatSync: (p) => node_fs_1.default.lstatSync(p),
    realpathSync: (p) => node_fs_1.default.realpathSync(p),
    unlinkSync: (p) => node_fs_1.default.unlinkSync(p),
    rmdirSync: (p) => node_fs_1.default.rmdirSync(p),
};
let current = REAL_ADAPTER;
/**
 * Returns the fs adapter active for the currently-running install call —
 * the real adapter when no `deps.fs` was injected, or the injected partial
 * adapter merged over the real one (any method it did not override still
 * resolves to real fs — see the module doc's "PARTIAL-ADAPTER TRAP").
 */
function installFs() {
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
function withInstallFs(partial, fn) {
    if (!partial)
        return fn();
    const previous = current;
    current = { ...REAL_ADAPTER, ...partial };
    try {
        return fn();
    }
    finally {
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
function mkInstallTempDir(prefix) {
    const dir = node_path_1.default.join(node_os_1.default.tmpdir(), `${prefix}${node_crypto_1.default.randomBytes(8).toString('hex')}`);
    installFs().mkdirSync(dir, { recursive: true });
    return dir;
}
module.exports = { installFs, withInstallFs, mkInstallTempDir };
