# ADR-3574: Install materialization shares primitives, not one writer

- **Status:** Accepted
- **Date:** 2026-08-16
- **Issue:** [#3574](https://github.com/open-gsd/gsd-core/issues/3574)
- **Epic:** [#2866](https://github.com/open-gsd/gsd-core/issues/2866) — Phase 6 ([#2875](https://github.com/open-gsd/gsd-core/issues/2875))
- **Amends:** none. Constrained by [ADR-58](58-runtime-install-policy-module.md), [ADR-3660](3660-runtime-artifact-layout-module.md), [ADR-1508](1508-runtime-artifact-conversion-module.md).

## Context

Epic #2866 Phase 6 was scoped on the premise that *"materialize this layout"* is implemented three
times and skipped once, and that the remedy is to extract the
preserve → prune → stage → copy → restore choreography into **one** module with the three sites
becoming callers.

That premise was measured against the tree on 2026-08-16, after Phase 5 ([#2874](https://github.com/open-gsd/gsd-core/issues/2874))
landed. **It does not hold.** The three sites overlap in *shape* and diverge in *mechanism*:

| step | `installRuntimeArtifacts`<br>`src/install-engine.cts:770-958` | `applySurface`<br>`src/surface.cts:359-452` | agent loop<br>`bin/install.js:11120+` |
|---|---|---|---|
| preserve | snapshot-based, **`skills` kind only** (`_snapshotDir`) | **none** | none |
| prune | `_removeGsdEntries`, prefix-scoped wipe | `pruneSkillDirs` — **allow-list, never wipes** | stale `gsd-*` unlink |
| stage | copies straight into `dest` | **temp dir first**, then syncs | inline transform, no staging dir |
| restore | `_restoreDir` the snapshot | none | none |

The divergence is deliberate on at least one side. `applySurface`'s prune is allow-list precisely
so that it *structurally cannot* delete a user's files — its own doc comment ties that to the
#2973/#3664 user-directory-preserving fix. `installRuntimeArtifacts` instead wipes a prefix-scoped
set and restores a snapshot of the one user-owned directory it knows about.

A single writer must pick one of these. Forcing `applySurface` onto snapshot-restore would replace
a design that *cannot* lose user files with one that deletes them and puts them back — trading a
structural guarantee for a procedural one. Forcing `installRuntimeArtifacts` onto temp-staging adds
a staging hop it does not need.

Two further premises of the original scoping are stale:

- **The `agents` bypass is shrinking, not static.** `_DESCRIPTOR_AGENTS_RUNTIMES`
  (`bin/install.js:11152`) already routes ten runtimes — cursor, windsurf, augment, trae, codebuddy,
  copilot, antigravity, qwen, kimi, zcode — through the descriptor. The inline `_hostBehaviors()`
  dispatch survives only for codex, cline, hermes and generic runtimes.
- **The duplication comment is stale in the opposite direction.** It lives at
  `src/runtime-artifact-layout.cts:277-297` (not the range #2875 cites) and reads: *"That
  duplication is deliberate until the second `layout.kinds` consumer — `applySurface` … — mirrors
  the legacy agent pipeline."* That condition has **partly** been met, via `agentCtx` /
  `stageAgentsForRuntimeWithConverter` in `applySurface`.

Separately and independently, **#1874-F19 is confirmed real**: `preserveUserArtifacts`
(`src/install-engine.cts:168-179`) builds an in-memory `Map<string,string>` via `readFileSync`, and
`restoreUserArtifacts` (`:187-195`) writes it back. Nothing touches disk in between. Any process
death between the intervening wipe and the restore loses the content outright, at four call sites
(`install-engine.cts:633`, `:705`; `bin/install.js:8658`, `:11056`).

## Decision

### 1. There will be no single materializer module

The three choreographies stay distinct. This ADR explicitly declines Phase 6's first acceptance
criterion as written — *"One module writes a `Layout`; the three former call sites delegate to it"* —
because satisfying it requires breaking one of two mechanisms that are each correct for their own
caller.

Recording the refusal is the point: the next reader who notices three similar-looking loops should
find this file rather than re-derive the extraction and rediscover the conflict.

### 2. What IS extracted: durable user-artifact staging (F19)

`preserveUserArtifacts` / `restoreUserArtifacts` move to a shared module and stage to a **durable
on-disk path before any wipe**, reusing `copyPreservingSymlink`
(`src/installer-migrations.cts:166-177`) — a pure two-argument function with no migration-specific
state, already used by the `backup-and-remove` migration action in exactly this
copy-strictly-before-delete order.

`copyPreservingSymlink` is the correct primitive for a second reason beyond durability: it never
dereferences a symlink target. Its own doc comment records why — dereferencing could copy the bytes
behind a link like `~/.ssh/id_rsa` into the backup tree. A hand-rolled `copyFileSync` here would
reintroduce that.

The journal / `backupRoot` / `runId` scaffolding around it is migration-specific and is **not**
extracted. Only the primitive is shared.

### 3. What IS extracted: the retired-kind prune

`pruneRetiredRuntimeArtifacts` is already called by both `installRuntimeArtifacts` and
`applySurface` with the same intent. That is genuine shared behavior rather than parallel
evolution, and it is the one step where a single owner costs nothing.

### 4. The `agents` bypass is closed on its own terms

Removing the inline `_hostBehaviors()` agent dispatch so the descriptor is authoritative for every
runtime is **independent of the prune question** and proceeds regardless. It is the part of Phase 6
whose evidence survived scrutiny intact, and ten runtimes have already made the trip.

### 5. Placement and content ownership are unchanged

Per [ADR-3660](3660-runtime-artifact-layout-module.md), placement knowledge outside
`runtime-artifact-layout` is drift; the extracted primitives consume `Layout`, never re-derive it.
Per [ADR-1508](1508-runtime-artifact-conversion-module.md), *"Layout owns placement; this module
owns content"*, and the conversion module imports nothing upward. The primitives sit **downstream**
of both and introduce no upward dependency.

Per [ADR-58](58-runtime-install-policy-module.md), these primitives are on the **adapter** side of
the pure-policy/thin-adapter split — they execute IO. Phase 5 routed that IO through an injectable
seam and established that the write-confinement *decisions* (`hasExistingSymlinkBetween`,
`assertDestWithinConfigHome`) stay outside the adapter, so a fake cannot certify an install the real
filesystem would refuse. **The extraction must not relocate those decisions.**

## What this ADR does not decide

- **Whether the three choreographies ever unify.** The `applySurface` descriptor-agents migration is
  partly landed; when it completes, the shapes may converge enough that the question is worth
  reopening on evidence. Revisit then, not before — and not by re-deriving the extraction this file
  declines.
- **The prune model itself.** Whether allow-list or prefix-scoped-wipe is the better default across
  the installer is a real question and a separate one. Nothing here endorses either as canonical.
- **`USER_OWNED_ARTIFACTS`' membership.** #2875 names `USER-PROFILE.md` as at risk; that could not be
  confirmed in this codebase state — `dev-preferences.md` is confirmed at three of four call sites.
  The implementing phase must enumerate the list rather than inherit the claim.

## Consequences

- **Phase 6's acceptance criterion 1 is not met as written, deliberately.** #2875 needs a scope
  update to match this decision before implementation. That is the cost of having measured the
  premise instead of executing it.
- Three loops that look duplicated remain, now with a recorded reason. Future reviews should treat
  *this file*, not the loops, as the answer.
- The `agents` bypass closes; the `runtime-artifact-layout.cts:277-297` comment is rewritten rather
  than deleted, because its "deliberate until X" framing is stale in a way a plain deletion would
  not capture.
- **F19's durability fix lands here rather than in #1874**, per maintainer direction on #2875.
  #1874's F5, F6 and F18 are untouched.
- The regression test for F19 must inject the crash window by monkeypatching the `fs` method and
  restoring in a `finally` — **never** via `chmod`/permission tricks, which root bypasses, yielding a
  test that passes with zero coverage in root Docker and CI.

## Alternatives considered

1. **One materializer, three callers delegate — Phase 6 as originally scoped.** Rejected on the
   measured evidence above: it forces either `applySurface` off its non-wiping prune or
   `installRuntimeArtifacts` into unnecessary temp-staging.
2. **One materializer with a preservation-strategy parameter.** Rejected. It preserves both
   behaviors but makes the module own two concepts and defer the choice to its callers — the exact
   widening [ADR-2866](2866-install-surface-resolution.md) warns future reviews to resist, and a
   strategy flag is how a shared module becomes two modules wearing one name.
3. **Do nothing; leave F19 to #1874.** Rejected. This phase rewrites that precise choreography, so
   landing the durability fix elsewhere means two conflicting passes over the same code.
4. **Delete the duplication comment as no longer true.** Rejected. It is not simply false — it is
   stale in a specific, informative way, and its "deliberate until X" condition is now partly met.
   A rewrite carries that; a deletion loses it.

## A note on the evidence

Blast-radius figures for this seam are **not** reliable and were not used to justify anything above.
`get_impact` on `installRuntimeArtifacts` resolved to a same-named test helper
(`tests/adapter-declarative-equivalence.test.cjs:52`) and reported zero affected — the same
name-collision failure mode that produced a misleading clean radius during
[#3544](https://github.com/open-gsd/gsd-core/issues/3544). `applySurface` returned **CRITICAL /
184+** from one tool and **LOW / 0** from another, disambiguating to two different in-file matches of
the same name. The decision above rests on read code, not on those numbers.

## References

- Epic: [#2866](https://github.com/open-gsd/gsd-core/issues/2866); this phase: [#2875](https://github.com/open-gsd/gsd-core/issues/2875); this ADR: [#3574](https://github.com/open-gsd/gsd-core/issues/3574)
- Durability finding: [#1874](https://github.com/open-gsd/gsd-core/issues/1874)-F19 (and its closed child #1878 — do not re-file)
- Placement seam: [ADR-3660](3660-runtime-artifact-layout-module.md) · content seam: [ADR-1508](1508-runtime-artifact-conversion-module.md) · policy/adapter split: [ADR-58](58-runtime-install-policy-module.md)
- The epic's own frame: [ADR-2866](2866-install-surface-resolution.md), which mandated that this module owe its own ADR
- User-directory preservation this ADR protects: #2973, #3664
