'use strict';

/**
 * #3712 — refuse to let an in-process test run reach the developer's REAL home.
 *
 * NAMED `real-home-guard`, NOT `test-home-guard`: this is a SOURCE module, and a
 * source filename matching Node's `test-*` convention gets COLLECTED and EXECUTED
 * as a test by the remote runner, which never imports it and throws immediately
 * on load — proven against the unmodified `next` tip 622f43353 (linux-node24,
 * 37199 passed / 1 failed, failure at `src/test-home-guard.cts`). Meanwhile
 * `scripts/run-tests.cjs` only globs `tests/**\/*.test.cjs`, so GitHub CI never
 * sees the failure and stays green while the remote push-gate runner goes red.
 * Any name works except one matching `test-*`, `*-test`, `*_test`, `*.test.*`,
 * or `test.*`.
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
 * This lives in its own module because SIX writers resolve a kind `home` and then
 * write or destroy what is under it. Four are reachable today —
 * `installRuntimeArtifacts` and `uninstallRuntimeArtifacts` (install-engine.cts)
 * and `applySurface` (surface.cts); guarding only the install path, as the first
 * cut of this fix did, left the other two as live bypasses. Two more are
 * descriptor-dependent and guarded against a future descriptor change rather than
 * a present escape: `installOpencodeFamilySkills`, which sits behind the
 * combined-family early return and honors `skillsKindEntry.home` (no
 * combined-family runtime declares one), and `installAgentsKindStandalone`, which
 * honors `agentsKindEntry.home` and prunes it (antigravity's global agents kind declares one since #3738; it was the first agents-kind override).
 * The sixth is `migrateLegacyDevPreferencesToSkill`, which resolves the skills
 * kind's `home` and writes `SKILL.md` under it. It CREATES rather than prunes,
 * which is why the first pass of this fix missed it, and it runs from
 * `_runLegacyInstallMigrations` — i.e. BEFORE `installRuntimeArtifacts`' own
 * assertion — so it carries its own call.
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
 * FAILS CLOSED, with one named exception. If the passwd entry is unreadable
 * (some CI images) we cannot establish that HOME is sandboxed, so a home-override
 * kind is refused rather than allowed — UNLESS the marker below names the home in
 * effect. That branch is a deliberate weakening, not a closed door: with no passwd
 * entry there is nothing that could contradict a marker naming the real home, so a
 * caller that sandboxed to its own real home would be believed. The alternative is
 * refusing every run on such a host. Everything else in that branch answers NO
 * when it cannot tell — see `sameDirectory`. The cost of a false refusal is a failed test naming its own fix;
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
 * Fails CLOSED, and "closed" here means returning FALSE. The sole caller is the
 * passwd-less marker branch, which READS a true as permission to proceed:
 *
 *     if (marker && sameDirectory(marker, osMod.homedir())) return;   // allows
 *
 * So "cannot tell" must answer NO. An earlier revision returned true for the
 * unknown/unknown case (both stats failing with something other than
 * ENOENT/ENOTDIR — EACCES, EPERM, EIO) on the reasoning that "cannot tell" should
 * make the caller refuse; that reasoning was inverted with respect to this
 * caller, and it turned an unreadable-stat environment into an unconditional
 * bypass for anyone who set the marker to any value at all. Reported in review of
 * #3725. Only two things now answer yes: the same resolved pathname, or two
 * readable identities that match.
 */
function sameDirectory(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  const ia = identify(a);
  const ib = identify(b);
  if (ia.kind === 'ok' && ib.kind === 'ok') return ia.dev === ib.dev && ia.ino === ib.ino;
  return false;
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
/**
 * Stamped on every Error this module throws.
 *
 * A refusal happens before any LAYOUT-DRIVEN write — legacy install migrations
 * run first and are rolled back on their own path — so it is not a partial
 * codex-skills install and must not trigger that rollback. `bin/install.js`'s
 * pre-config rollback
 * deletes and recreates every snapshotted `gsd-*` directory in the resolved
 * skills root, which for an un-sandboxed codex install IS the real
 * `~/.agents/skills`. Without this marker the guard's own refusal would provoke
 * the mutation it exists to prevent. Found by review, not by CI.
 */
const REFUSAL_FLAG = 'gsdTestHomeGuardRefusal';

/**
 * Static remediation line, shared by every refusal this module raises. Hoisted to
 * module scope because `resolveThroughLinks` refuses too and sits outside
 * `assertTestHomeSandboxed`'s body, where this used to be a local.
 */
const SANDBOX_FIX_HINT =
  `Fix the TEST, not this guard: sandbox HOME and USERPROFILE BEFORE resolving the ` +
  `layout, for the duration of the call — use sandboxHome(t, dir) from tests/helpers.cjs ` +
  `(see #3712).`;

function refusal(message: string): Error {
  const err = new Error(message);
  (err as Error & Record<string, unknown>)[REFUSAL_FLAG] = true;
  return err;
}

/** Did `err` come from this guard refusing before any write happened? */
function isTestHomeGuardRefusal(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as Record<string, unknown>)[REFUSAL_FLAG]);
}

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

  const fix = SANDBOX_FIX_HINT;

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
      const declared = path.resolve(path.join(kind.home as string, kind.destSubpath ?? ''));
      // Both questions are asked of the path the write will REACH, not the one
      // it was spelled as; see resolveThroughLinks.
      const dest = resolveThroughLinks(declared);
      if (!isInside(dest, realHome)) continue;
      if (derivesFromSandboxedHome(dest, effectiveHome, realHome, passwdHome as string)) continue;
      throw refusal(
        `${operation}("${runtime}") was called under a test runner with a destination inside ` +
        `your REAL home. The "${kind.kind}" kind declares a global home override, so it ` +
        `resolves from os.homedir() and NOT from the sandboxed configDir — this call would ` +
        `write inside ${dest} (and install, uninstall and surface-apply also PRUNE GSD ` +
        `entries there).\nThe real home it was ` +
        `compared against is ${passwdHome} — if that is not your home, this ` +
        `refusal is the bug and not the call.\n${fix}`,
      );
    }
    return;
  }

  // The real home cannot be identified, so containment against it cannot be
  // evaluated at all. Fall back to the weaker signal: a marker naming the home
  // currently in effect. Only reachable on hosts with no readable passwd entry,
  // where the alternative is refusing every such run.
  //
  // TWO things are required, not one. An earlier revision returned as soon as the
  // marker matched the effective HOME, which attested that a caller sandboxed HOME
  // but said NOTHING about where these destinations resolve — so a layout captured
  // BEFORE sandboxHome(), still naming the real `~/.agents`, was waved straight
  // through on a passwd-less host. That is the same stale-layout shape the primary
  // branch above refuses by design, and it made the marker a bypass for exactly
  // the case the guard exists for. Reported in Codex review of #3725.
  //
  // The marker must also IDENTIFY: `sameDirectory` answers yes for two identical
  // unidentifiable pathnames (see its docblock), and that is not enough to place a
  // destination against.
  const marker = env[SANDBOX_MARKER];
  const markerId = marker ? identify(marker) : { kind: 'unknown' as const };
  if (marker && markerId.kind === 'ok' && sameDirectory(marker, osMod.homedir())) {
    const stale = overriding.find(
      (kind) => !isInside(resolveThroughLinks(path.resolve(path.join(kind.home as string, kind.destSubpath ?? ''))), markerId),
    );
    if (!stale) return;
    throw refusal(
      `${operation}("${runtime}") was called under a test runner on a host with no identifiable ` +
      `passwd home. HOME was sandboxed and recorded, but the "${stale.kind}" kind resolves to ` +
      `${resolveThroughLinks(path.resolve(path.join(stale.home as string, stale.destSubpath ?? '')))}, ` +
      `which is NOT beneath that sandbox — so this layout was resolved before the sandbox and still ` +
      `names another home. A recorded sandbox vouches for HOME, never for a destination that does ` +
      `not derive from it.\n${fix}`,
    );
  }
  throw refusal(
    `${operation}("${runtime}") was called under a test runner and this environment has no ` +
    `identifiable passwd home, so GSD cannot establish where the real home is. The ` +
    `"${overriding[0]?.kind}" kind declares a global home override, which resolves from ` +
    `os.homedir() and would write inside whatever real home that is (and, for the pruning ` +
    `writers, delete GSD entries there). Refusing rather than guessing.\n${fix}`,
  );
}

/**
 * The path `dest` will actually resolve to when it is written.
 *
 * `dest` usually does not exist yet — that is the point, it is about to be
 * created — so `realpathSync` cannot be called on it directly. Walk up to the
 * nearest ancestor that DOES exist, canonicalize that, and re-append the tail.
 *
 * Without this the sandbox exemption below is escapable: with HOME sandboxed to
 * `$REAL/tmp-home` and `$REAL/tmp-home/.agents` a symlink (or Windows junction)
 * onto the real `$REAL/.agents`, the lexical ancestor
 * walk reaches the sandbox and the write is allowed — straight into the real
 * home. Identity comparison alone does not close it, because each ancestor is
 * identified in isolation and the alias sits BETWEEN dest and the sandbox.
 * Found by review, not by CI.
 *
 * KNOWN LIMITATION — a subordinate BIND MOUNT of the real `~/.agents` at
 * `<sandbox>/.agents` is NOT closed by this. A bind mount is not a link:
 * `realpathSync` keeps the mount-point spelling, so the canonical destination
 * still reads as "beneath the sandbox" while the write reaches the real
 * directory. `sameDirectory` above already records that realpath cannot unify
 * bind-mounted spellings; this inherits that limit. Closing it needs mount-table
 * introspection, which is not portable, and the setup — deliberately mounting the
 * one directory this guard protects into a sandbox inside the home — is not a
 * shape any caller here produces. A cross-process swap of a checked directory
 * between this call and the write (TOCTOU) is likewise out of reach and not
 * claimed.
 *
 * Canonicalization itself fails CLOSED — see the errno split below. A component
 * that EXISTS but cannot be resolved is refused, because falling back to the
 * lexical spelling is the exact ALLOW an unresolvable alias needs.
 */
function resolveThroughLinks(dest: string): string {
  const tail: string[] = [];
  let cur = path.resolve(dest);
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...tail);
    } catch (err) {
      // Same errno split `identify` already draws, and deliberately the same one:
      // both functions are asking "does this path exist as named?", so they must
      // not disagree. ENOENT/ENOTDIR mean NOT THERE — the expected case, since a
      // fresh install resolves a destination that does not exist yet and realpath
      // fails on the leaf and on every not-yet-created ancestor. That is what this
      // walk is FOR, so keep walking.
      //
      // Any other errno means the component EXISTS but could not be canonicalized —
      // EACCES/EPERM on a directory whose mode changed, ELOOP on a symlink cycle,
      // EIO on a failing mount. Falling through to the lexical spelling there is a
      // FAIL-OPEN that precisely inverts this function's purpose: an aliased
      // `<sandbox>/.agents` that cannot be resolved keeps its sandbox spelling,
      // satisfies the nested-sandbox exemption, and the write is ALLOWED straight
      // into the real home. The module documents that it fails CLOSED with exactly
      // ONE named exception (the marker branch); a swallowed canonicalization error
      // was a second, unnamed one. Refuse instead. (Codex review of #3725.)
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        throw refusal(
          `A component of the destination could not be canonicalized, so this guard cannot ` +
          `tell whether the write would reach your REAL home.\nFailed on: ${cur} ` +
          `(${code ?? 'unknown error'})\nSymlinks and junctions are resolved BEFORE the ` +
          `decision, because an aliased "<sandbox>/.agents" would otherwise read as confined ` +
          `while pointing at the real one. A component that cannot be resolved is refused ` +
          `rather than assumed safe.\n${SANDBOX_FIX_HINT}`,
        );
      }
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(dest);
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/**
 * Is `dest` inside a HOME that has been sandboxed away from the passwd home?
 *
 * Asked only once `dest` is already known to be inside the real home, and it is
 * what makes that fact non-fatal on Windows: there `os.tmpdir()` is
 * `%USERPROFILE%\AppData\Local\Temp` by default (Node honors `TEMP`/`TMP`,
 * so this is the usual case rather than a guarantee) — so in practice every
 * sandbox a test creates is a descendant of the real home. Containment in the
 * real home is therefore true of the correctly-sandboxed case and the dangerous
 * one alike, and cannot separate them by itself. POSIX conceals this, because
 * `/tmp` and `/var/folders` both sit outside `$HOME`. All six Windows shards of
 * #3725 failed on legitimately sandboxed destinations before this conjunct
 * existed.
 *
 * TWO conditions carry the decision, and neither suffices alone:
 *
 *   - the passwd home is NOT beneath that HOME — see the comment on that check;
 *     without it a HOME that merely spells the real home more widely (`/Users`,
 *     `C:\Users`) is mistaken for a sandbox.
 *   - `dest` is beneath that sandboxed HOME — otherwise this decays into the
 *     "is HOME sandboxed?" check the module docblock rejects, and a layout
 *     resolved before the sandbox walks straight through.
 *
 * The first check below — HOME differs from the passwd home — is a cheap fast
 * path, NOT an independent condition: `isInside` is reflexive, so whenever HOME
 * identifies the passwd home the second check already returns false on its own.
 * Removing it changes no outcome; it is kept to answer the common case without
 * an ancestor walk. Raised in review of #3725 against prose that claimed the
 * three were independent.
 *
 * Fails CLOSED: an unreadable or unidentifiable HOME returns false, so the
 * caller refuses rather than exempting a destination it cannot place.
 */
function derivesFromSandboxedHome(
  dest: string,
  effectiveHome: string | null,
  realHome: { dev: number; ino: number },
  passwdHome: string,
): boolean {
  if (effectiveHome === null) return false;
  const eff = identify(effectiveHome);
  if (eff.kind !== 'ok') return false;
  if (eff.dev === realHome.dev && eff.ino === realHome.ino) return false;
  // A sandbox sits BENEATH the real home (the Windows temp shape) — never above
  // it. A destination's ancestor chain is linear, so "inside the real home AND
  // inside the effective HOME" admits two arrangements, not one: the intended
  // `effectiveHome ⊂ realHome`, and `realHome ⊂ effectiveHome` — HOME pointed at
  // `/Users`, `/home`, or `C:\Users`. The second is not a sandbox, it is the real
  // home reached by a wider spelling, and without this it exempts a stale
  // destination. Reported in review of #3725 as the one leaking cell of a
  // six-row truth table.
  if (isInside(passwdHome, eff)) return false;
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

export = { assertTestHomeSandboxed, isTestHomeGuardRefusal, SANDBOX_MARKER };
