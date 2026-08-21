'use strict';

/**
 * #3712 — refuse to let an in-process test run reach the developer's REAL home.
 *
 * A runtime kind may declare a global `home` override that is resolved from
 * `os.homedir()` rather than from the caller's `configDir` (today: codex's
 * skills kind, `home: ".agents"`, ADR-1239 / #2088 — Codex auto-discovers
 * global skills from `$HOME/.agents/skills`). Sandboxing `configDir`/`targetDir`
 * therefore does NOT contain such a kind, and no `assertDestWithinConfigHome`
 * check can see it: that gate confines a destSubpath to whatever root it is
 * handed, and here the root IS the escaped home.
 *
 * The live defect: an in-process caller that forgot to sandbox HOME installed —
 * and, via `_removeGsdEntries` / `_syncGsdDir`, PRUNED — inside the real
 * `~/.agents/skills`, deleting every `gsd-*` skill (observed 71 -> 0, a foreign
 * `cloudflare` skill surviving) while the suite still exited 0. It is silent
 * because the runtime's own config home is untouched, so the manifest keeps
 * reporting a healthy install.
 *
 * This lives in its own module because FIVE writers resolve a kind `home` and then
 * destroy what is under it. Three are reachable today —
 * `installRuntimeArtifacts` and `uninstallRuntimeArtifacts` (install-engine.cts)
 * and `applySurface` (surface.cts); guarding only the install path, as the first
 * cut of this fix did, left the other two as live bypasses. Two more are
 * descriptor-dependent and guarded against a future descriptor change rather than
 * a present escape: `installOpencodeFamilySkills`, which sits behind the
 * combined-family early return and honors `skillsKindEntry.home` (no
 * combined-family runtime declares one), and `installAgentsKindStandalone`, which
 * honors `agentsKindEntry.home` and prunes it (no agents kind declares one).
 *
 * DETECTION — three signals, in order:
 *
 *   1. `NODE_TEST_CONTEXT` is set by `node --test` and inherited by children, and
 *      is absent from normal installs outside a Node test context, so ordinary
 *      production installs are untouched. Precisely: an install spawned BENEATH a
 *      `node --test` process with an un-sandboxed HOME is refused — that is the
 *      point, and it is also why this is not stated as "never affects installs".
 *      `GSD_TEST_MODE` is NOT usable: several in-process test files — including
 *      the one that caused #3712 — never set it, so gating on it would miss the
 *      exact case this guard exists for.
 *   2. `os.userInfo().homedir` reads the passwd entry and ignores `$HOME`, while
 *      `os.homedir()` prefers `$HOME`. They disagree exactly when a caller
 *      redirected HOME and agree when one forgot. This is the PRIMARY signal and
 *      the only one used whenever a passwd entry is readable. It is asked about
 *      the DESTINATION, not about HOME state: a destination outside the passwd
 *      home is allowed, and one inside it is refused UNLESS it sits beneath a
 *      HOME that was sandboxed away from the passwd home. That last exemption is
 *      not a softening — on Windows the temp root is inside the user's home, so
 *      without it every sandboxed run is refused (#3725). Both halves are
 *      required; see `derivesFromSandboxedHome`.
 *   3. `SANDBOX_MARKER` — consulted ONLY when the passwd entry cannot be read.
 *
 * FAILS CLOSED. If the passwd entry is unreadable (some CI images) we cannot
 * establish that HOME is sandboxed, so a home-override kind is refused rather
 * than allowed. The cost of a false refusal is a failed test naming its own fix;
 * the cost of a false allow is silent, unrecoverable deletion of a developer's
 * skills.
 *
 * The marker carries the sandbox PATH, not a boolean, and is checked only in that
 * unreadable-passwd branch — deliberately, because a boolean checked first is not
 * proof of anything. An ambient or stale `=1` inherited from a parent process, or
 * left set by an earlier in-process test, would have disarmed the guard entirely
 * even when HOME plainly equalled the passwd home. Requiring the value to EQUAL
 * the home now in effect means a leftover marker from some other directory cannot
 * vouch for this call.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Set by tests/helpers.cjs `sandboxHome()` to the sandboxed home PATH. Only
 * consulted when the passwd entry is unreadable; see the module docblock.
 */
const SANDBOX_MARKER = 'GSD_TEST_HOME_SANDBOX';

/**
 * Are these two paths the same directory on disk?
 *
 * Compared by FILESYSTEM IDENTITY — `st_dev` + `st_ino` — not by pathname.
 * `path.resolve()` normalizes separators and `..` but resolves neither symlinks
 * nor case, and `realpathSync` returns a canonical *pathname*, which two routes to
 * one directory can still disagree on (a Linux bind mount is the standard case).
 * `statSync` follows symlinks and reports the inode itself, so a case-variant
 * HOME, a symlinked HOME, and a bind-mounted HOME all compare equal.
 *
 * Fails CLOSED. A pair is only reported as DIFFERENT when both sides are
 * identified, or when one is definitively absent (ENOENT/ENOTDIR — a path that is
 * not there cannot be the one that is) while the other identifies. Every other
 * failure — permission, I/O, long-path, transient — is treated as "cannot tell",
 * which reports "same" so the caller refuses. Treating an arbitrary errno as
 * proof of difference is the fail-open shape this guard exists to remove.
 */
function sameDirectory(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  const ia = identify(a);
  const ib = identify(b);
  if (ia.kind === 'ok' && ib.kind === 'ok') return ia.dev === ib.dev && ia.ino === ib.ino;
  if (ia.kind === 'absent' && ib.kind === 'ok') return false;
  if (ib.kind === 'absent' && ia.kind === 'ok') return false;
  return true;
}

type Identity =
  | { kind: 'ok'; dev: number; ino: number }
  | { kind: 'absent' }
  | { kind: 'unknown' };

function identify(p: string): Identity {
  try {
    const st = fs.statSync(p);
    return { kind: 'ok', dev: st.dev, ino: st.ino };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'absent' };
    return { kind: 'unknown' };
  }
}

type Kind = { kind?: string; home?: string; destSubpath?: string };
/** The slice of `node:os` this guard needs — injected so the trigger condition is testable. */
type OsLike = { homedir(): string; userInfo(): { homedir: string } };
type Deps = { os?: OsLike; env?: Record<string, string | undefined> };

/**
 * @param operation - the writer being guarded, for the error message
 *   (e.g. `installRuntimeArtifacts`), so a failure names its own call site.
 * @param runtime - canonical runtime id, for the error message.
 * @param kinds - resolved layout kinds; only those carrying `home` can escape.
 * @param deps - test seam. The guard's own trigger condition is "HOME equals the
 *   passwd home", which cannot be reproduced without pointing at the developer's
 *   real home, so it is injected rather than simulated. Mirrors the `deps.os`
 *   seam in scripts/live-config-guard.cjs.
 * @throws {Error} when a global `home` override cannot be shown to be sandboxed.
 */
function assertTestHomeSandboxed(
  operation: string,
  runtime: string,
  kinds: Kind[] | undefined,
  deps: Deps = {},
): void {
  const osMod = deps.os ?? os;
  const env = deps.env ?? process.env;

  if (!env['NODE_TEST_CONTEXT']) return;               // a real install

  const overriding = (kinds ?? []).filter((k) => k && k.home);
  if (overriding.length === 0) return;                 // nothing can escape

  let passwdHome: string | null = null;
  try {
    passwdHome = osMod.userInfo().homedir || null;
  } catch {
    passwdHome = null;
  }

  const fix =
    `Fix the TEST, not this guard: sandbox HOME and USERPROFILE BEFORE resolving the ` +
    `layout, for the duration of the call — use sandboxHome(t, dir) from tests/helpers.cjs ` +
    `(see #3712).`;

  const realHome = passwdHome === null ? { kind: 'unknown' as const } : identify(passwdHome);
  if (realHome.kind === 'ok') {
    let effectiveHome: string | null = null;
    try {
      effectiveHome = osMod.homedir() || null;
    } catch {
      effectiveHome = null;
    }

    // The question is NOT "is HOME sandboxed right now" — it is "does this
    // destination land in the real home, other than by deriving from a sandbox
    // beneath it". The first half alone is not enough: a layout resolved BEFORE
    // sandboxHome() captures the real `~/.agents` in `kind.home`, and applySurface
    // takes an already-resolved layout, so a HOME-state check returns "sandboxed"
    // while the stale destination still points at the real home.
    //
    // The second half is not optional either — see `derivesFromSandboxedHome`.
    // Containment in the real home is not by itself evidence of danger on a
    // platform whose temp root lives inside the home.
    for (const kind of overriding) {
      const dest = path.resolve(path.join(kind.home as string, kind.destSubpath ?? ''));
      if (!isInside(dest, realHome)) continue;
      if (derivesFromSandboxedHome(dest, effectiveHome, realHome)) continue;
      throw new Error(
        `${operation}("${runtime}") was called under a test runner with a destination inside ` +
        `your REAL home. The "${kind.kind}" kind declares a global home override, so it ` +
        `resolves from os.homedir() and NOT from the sandboxed configDir — this call would ` +
        `write to (and prune GSD entries from) ${dest}.\n${fix}`,
      );
    }
    return;
  }

  // The real home cannot be identified, so containment cannot be evaluated at all.
  // Fall back to the weaker signal: a marker naming the home currently in effect.
  // Weaker deliberately — it attests that a caller sandboxed HOME, not that these
  // destinations derive from it — and it is only reachable on hosts with no
  // readable passwd entry, where the alternative is refusing every such run.
  const marker = env[SANDBOX_MARKER];
  if (marker && sameDirectory(marker, osMod.homedir())) return;
  throw new Error(
    `${operation}("${runtime}") was called under a test runner and this environment has no ` +
    `identifiable passwd home, so GSD cannot establish where the real home is. The ` +
    `"${overriding[0]?.kind}" kind declares a global home override, which resolves from ` +
    `os.homedir() and would write to (and prune GSD entries from) whatever real home that ` +
    `is. Refusing rather than guessing.\n${fix}`,
  );
}

/**
 * Is `dest` inside a HOME that has been sandboxed away from the passwd home?
 *
 * Asked only once `dest` is already known to be inside the real home, and it is
 * what makes that fact non-fatal on Windows: there `os.tmpdir()` is
 * `%LOCALAPPDATA%\Temp` — `%USERPROFILE%\AppData\Local\Temp` — so EVERY
 * sandbox a test creates is a descendant of the real home. Containment in the
 * real home is therefore true of the correctly-sandboxed case and the dangerous
 * one alike, and cannot separate them by itself. POSIX conceals this, because
 * `/tmp` and `/var/folders` both sit outside `$HOME`. All six Windows shards of
 * #3725 failed on legitimately sandboxed destinations before this conjunct
 * existed.
 *
 * BOTH conditions are required, and neither is sufficient:
 *
 *   - HOME differs from the passwd home — otherwise nothing was sandboxed and
 *     `dest` is simply in the real home.
 *   - `dest` is beneath that sandboxed HOME — otherwise this decays into the
 *     "is HOME sandboxed?" check the module docblock rejects, and a layout
 *     resolved before the sandbox walks straight through.
 *
 * Fails CLOSED: an unreadable or unidentifiable HOME returns false, so the
 * caller refuses rather than exempting a destination it cannot place.
 */
function derivesFromSandboxedHome(
  dest: string,
  effectiveHome: string | null,
  realHome: { dev: number; ino: number },
): boolean {
  if (effectiveHome === null) return false;
  const eff = identify(effectiveHome);
  if (eff.kind !== 'ok') return false;
  if (eff.dev === realHome.dev && eff.ino === realHome.ino) return false;
  return isInside(dest, eff);
}

/**
 * Is `child` at or beneath the directory identified by `rootId`?
 *
 * Walks `child`'s ancestors comparing filesystem identity rather than string
 * prefixes, because `child` typically does not exist yet (that is the point — it
 * is about to be created) while its ancestors do. A prefix test would miss a
 * case-variant or symlinked spelling of the same ancestor, which is the exact
 * class this guard exists to catch.
 */
function isInside(child: string, rootId: { dev: number; ino: number }): boolean {
  let cur = path.resolve(child);
  for (;;) {
    const id = identify(cur);
    if (id.kind === 'ok' && id.dev === rootId.dev && id.ino === rootId.ino) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

export = { assertTestHomeSandboxed, SANDBOX_MARKER };
