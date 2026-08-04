# How overlay capabilities compose

> **Explanation** — This document describes *why* GSD composes first-party and
> third-party capabilities the way it does, and *what the precedence and conflict
> rules are*. It is not a step-by-step guide; for the consumer lifecycle see
> [Install your first capability](../tutorials/install-your-first-capability.md),
> and for the field-level rules see the
> [capability manifest reference](../reference/capability-manifest.md). For the
> security side of the same boundary, see
> [the capability trust model](capability-trust-model.md). For the decision
> record, see
> [ADR-1244 D2](../adr/1244-capability-ecosystem.md#d2--runtime-capability-registry-overlay).

---

## The central idea: the registry is a module, not a data file

GSD's capabilities — first-party and third-party alike — are described by a single
**capability registry**: a composed object that every consumer (the loop resolver,
the config loader, the surface command, `gsd capability list`) reads to learn which
skills, agents, config keys, and loop hooks exist.

The first-party registry is *frozen and generated*: it is built at release time from
the shipped `capabilities/*/capability.json` manifests into a committed
`capability-registry.cjs`, and it never changes at runtime. Third-party capabilities
cannot be baked into that file — they are installed on the user's machine, after the
release. So the registry is not consumed as a static data file. It is consumed through
a function:

```text
loadRegistry({ includeInstalled: true }) → composed registry
```

`loadRegistry` reads the frozen first-party registry and, when asked, composes a
**validated installed overlay** on top of it: the third-party capability manifests
found at runtime under the per-scope install roots. The result is one registry that
covers first-party and third-party capabilities identically — every derived view
(`bySkill`, `byAgent`, `byLoopPoint`, `configKeys`, the cluster map) spans both. The
whole point of the overlay model is that an installed capability is *not* a
second-class citizen: once it composes cleanly, it participates in the loop exactly
as a shipped one does.

The interesting question is everything that can go wrong while composing two sources
that were authored independently — and what GSD does about each case. That is the rest
of this document.

---

## The activation chain

Before a third-party capability contributes anything to your loop, it passes through
four distinct stages. They are worth naming because they fail in different ways and at
different times — and the order matters: **the consent gate runs during composition,
before surface and config**, not after them.

1. **Install** writes the capability into a scope root and records it in the ledger.
   This is the lifecycle's job; it never runs capability code (see the trust model).
   The capability now exists *on disk*.
2. **Load / compose (with the project-scope consent gate)** is what `loadRegistry`
   does. As it composes each overlay it applies the composition gates — id/skill/agent/
   config/family collisions, the `engines.gsd` re-check, and, for a *project-scoped*
   overlay, **the project-scope consent gate**. That gate runs *inside* `loadRegistry`,
   before any of the overlay's fragments are even materialised: a project overlay is
   inert (discovered-but-inactive) until a matching record exists in your user-owned
   consent store. This is the security gate described in
   [the trust model](capability-trust-model.md#the-project-scope-trust-boundary). A
   capability that fails any composition gate — consent included — never enters the
   registry the rest of GSD reads, so it cannot reach the later stages at all.
3. **Surface** decides which of the *composed* registry's skills are projected into the
   host runtime. This is the install-profile and `/gsd-surface` layer — a capability's
   skills can be on the surface or held back without uninstalling it. It only ever sees
   capabilities that already cleared composition.
4. **Config activation** decides, per loop hook, whether it fires. A hook's `when`
   key (a dotted config key) gates it: a `step` or `gate` whose key is falsy does not
   run. This is the `gsd capability set <id> --gate <key>=<bool>` and `/gsd-settings`
   layer — again, only for capabilities that survived composition.

This document is about what `loadRegistry` does at the moment of composition — stage 2,
which sits between install and the later surface/config stages and contains the consent
gate. A capability that is installed but skipped at composition (including for missing
consent) never reaches the surface or config stages, because it is not in the registry
the rest of GSD reads.

---

## Where overlays come from, and the order they are considered

`loadRegistry` scans two install roots, in this order:

- **Global** — `$GSD_HOME/.gsd/capabilities/<id>/` (where `GSD_HOME` defaults to your
  home directory). This is under your own control and is trusted without a per-project
  record.
- **Project** — `<projectRoot>/.gsd/capabilities/<id>/`. This lives inside a repository
  and is therefore only as trustworthy as the repository; it is gated by the consent
  store.

The roots are deduplicated by their *canonical* (symlink-resolved) physical path, so a
single directory is never scanned twice — and, crucially, so a symlinked `GSD_HOME`
that physically *is* the project root cannot smuggle an in-repo bundle into the trusted
global slot. When the global and project roots resolve to the same physical directory
(or distinctness cannot be proven), the surviving scope escalates to the more
restrictive `project` — consent-required. This is a deliberately conservative choice:
when GSD cannot prove a global root is distinct from your project tree, it treats it as
project-scoped rather than risk granting trusted-global activation to repo-plantable
content.

Within this ordering, the composition rules below decide which overlays survive.

---

## First-party always wins

The single load-bearing precedence rule is: **first-party always wins.** When a
third-party overlay collides with a first-party capability, the overlay is rejected —
never the other way round.

Collision is defined broadly, because impersonation can happen along several axes. An
overlay is rejected if it collides on any of:

- **`id`** — the capability identifier. Two capabilities cannot share an id; a
  first-party id always keeps it.
- **A skill or agent stem** — exactly one capability may own each skill/agent stem
  across the entire merged registry. An overlay that claims a stem already owned
  (by first-party *or* by an already-accepted overlay) is rejected.
- **A federated config key** — a key declared in the overlay's `config` slice that
  already exists in the central config schema or in another capability's slice.
- **A command family** — the `family` of a declared command module, if another
  capability already owns it.

Two further rules protect the first-party namespace directly:

- **Reserved prefixes.** The `gsd-`, `gsd-core-`, and `anthropic-` id prefixes are
  reserved. An overlay whose id begins with one is rejected outright — a third party
  cannot publish `gsd-security` and borrow the implicit trust of the GSD namespace.
- **Cross-capability invariants.** Each candidate overlay is added to the merged
  capability map and the *full* cross-capability validation suite (contract roles,
  `consumes`-satisfiability, owner uniqueness, config-key exclusivity, `requires`
  acyclicity and tier-monotonicity) is re-run. First-party alone is always clean, so
  any new error is provably the candidate's fault, and the candidate is dropped.

### Why this asymmetry

The asymmetry is intentional and follows directly from the trust model's central
thesis — *artifact parity is not trust parity*. A third-party capability is allowed to
ship the same kinds of artifacts as GSD Core, but first-party capabilities carry an
authority third-party ones do not: their provenance is the GSD release process itself.
If a collision could let an overlay shadow a first-party skill, agent, or command, then
installing a capability could silently *replace* a shipped behaviour — the install would
be the attack. By making first-party unconditionally win every collision, GSD
guarantees that no installed capability can ever redefine what GSD Core does. An overlay
can only *add*; it can never *override*.

---

## When a single overlay fails: skip, don't crash

Overlays are untrusted, independently authored, and read at runtime from a possibly
repo-plantable directory. A malformed one must never bring down the loop. So the second
rule of composition is: **a bad overlay is skipped with a warning; the loop always gets
a usable registry.**

A capability is skipped (and a warning recorded in the registry's `_overlay.warnings`)
for any of these reasons:

- its `capability.json` is missing, unreadable, non-regular (a planted FIFO/device), or
  oversized;
- it fails structural or cross-capability validation;
- it collides with first-party or an already-accepted overlay (the precedence rule
  above);
- its `engines.gsd` range does not satisfy the running GSD version (the load-time
  re-gate, which mirrors the install-time gate so an upgrade of GSD itself can retire an
  incompatible overlay);
- it carries an in-flight `_pending` install/upgrade marker (deferred until
  reconciliation completes);
- (for a project overlay) it has no matching consent record on this machine — it is
  *discovered but inactive*.

The composition body is total: even an unexpected throw from a validator or a
fragment-materialisation step is caught per-candidate, turned into a skip, and the next
candidate is processed. A single broken overlay cannot poison the rest of the set.

---

## The one place where a skip must be loud: gates

Skipping a broken overlay is the safe default for every surface — including gates, though
gates get special treatment.

A capability's loop hooks come in three kinds:

- a **step** adds an independent unit of work at an extension point;
- a **contribution** injects a prompt fragment into an agent role;
- a **gate** checks a condition and can *block* the loop from proceeding.

For steps and contributions, skipping a capability means the loop simply proceeds
**without** that addition. That is *fail-open*, and it is correct: the loop is missing an
optional step, not doing something unsafe.

A gate looks different at first glance. The whole purpose of a gate is to *stop* the loop
when a condition is not met — a deploy gate, a house-style verification gate, a safety
check. Silently skipping a broken gate-declaring capability and proceeding as if the gate
had *passed* would wave through the very thing the gate existed to block, with no signal
to the operator at all.

So, per the maintainer decision on [#2009](https://github.com/open-gsd/gsd-core/issues/2009),
composition treats gates like steps and contributions for control flow — the loop always
proceeds — but never silently. When a capability that declares a gate is skipped, GSD
records its gate points in `_overlay.incompatibleGateCapIds` and `_overlay.blockedGates`,
and the loop resolver **injects no gate** at each of those extension points. The loop
**fails open**, but loudly: it emits a warning through two channels — stderr (the channel
host workflows/agents see when they run `gsd_run loop render-hooks <point>`) and the
`loop render-hooks` JSON envelope's top-level `warnings` array. The warning names the
skipped capability, why it could not be loaded (for example, an incompatible
`engines.gsd` range), and the exact remediation — `gsd capability remove <id>` — so the
operator sees the missing control on every pass through the loop until they act on it,
instead of the loop halting project-wide over a single incompatible overlay.

The discriminator is therefore *not* "is this overlay broken?" but "what does failing
to load it mean?" — and for a gate, failing to load it means the operator must be told,
unmistakably, until they resolve it.

---

## When the whole compose fails: fall back to first-party

There is one more failure layer above the per-candidate skip. A set of overlays can
each pass every per-candidate check yet still trip a stricter whole-set check when the
canonical builder (`buildRegistry`) materialises the merged registry — a topological
cycle that only appears across the combined set, a config-slice shape problem, a format
mismatch. An unguarded failure there would crash every consumer of the registry.

The fallback is uncompromising: if the whole-set build fails, GSD **discards every
overlay** and returns the frozen first-party registry, plus a warning recording why. The
loop keeps running with exactly the shipped capabilities and none of the overlays. Two
details make this safe rather than merely convenient:

- Every accepted overlay's **command root is cleared**, so no dropped overlay can leave
  behind a path that a runtime dispatcher might `require()` a command module from.
- Every dropped overlay's **gates are recorded as blocked** — using the same extraction
  as the per-candidate path — so a gate-declaring overlay that vanishes in the fallback
  still **surfaces a loud warning** (stderr + envelope `warnings`) at its gate points
  rather than vanishing silently (#2009).

The principle is the same at every layer: when GSD cannot compose an overlay, it removes
the overlay's *additions* but never silences a *control* — a missing gate always
surfaces, even though, per #2009, it no longer blocks the loop.

---

## Why compose through one builder

A subtle but important design choice: the merged registry is materialised by the **same**
`buildRegistry` function that produces the first-party registry, run over a map of
first-party capabilities *plus* the accepted overlays. GSD does not have one code path
that builds the first-party views and a separate path that bolts overlay views on.

The reason is drift. Every derived view — `bySkill`, `byLoopPoint`, the config schema,
the cluster map, profile membership — is a projection of the capability set. If overlays
were projected by a different builder, those projections could diverge from the
first-party ones in subtle ways, and an overlay capability might behave *almost* like a
first-party one but not quite. By forcing both through the single canonical builder, GSD
guarantees that an accepted overlay is indistinguishable from a first-party capability in
every derived view — which is exactly the artifact-parity promise the platform makes.

---

## Summary

The overlay model rests on a few rules applied consistently:

- The registry is composed at runtime by `loadRegistry`, not read as a static file.
- **First-party always wins** every collision — id, skill/agent stem, config key,
  command family, reserved prefix. An overlay can only add, never override.
- A bad overlay is **skipped, not crashed** — the loop always gets a usable registry.
- Skipping **fails open** for steps and contributions (a missing optional addition) and,
  per [#2009](https://github.com/open-gsd/gsd-core/issues/2009), **fails open** for gates
  too (a missing control, no gate injected) — but loudly, via a warning (stderr + the
  envelope's `warnings` array) that names the load failure and its
  `gsd capability remove <id>` remediation.
- A whole-set compose failure **falls back to first-party**, clearing command roots and
  still surfacing dropped gates as loud warnings.
- One canonical builder materialises both first-party and overlay views, so an accepted
  overlay has true parity with a shipped capability.

Every one of these choices answers the same question — *what does it mean if this
composition step fails?* — and resolves it in favour of first-party authority and,
per #2009, a loud fail-open posture: never silent, never a project-wide halt over a
single incompatible overlay.

---

## Related documents

- [ADR-1244 D2 — Runtime Capability Registry overlay](../adr/1244-capability-ecosystem.md#d2--runtime-capability-registry-overlay)
- [The capability trust model](capability-trust-model.md) — the security side of the same boundary
- [Capability Overlay (Configuration)](../CONFIGURATION.md#capability-overlay-installed-third-party-capabilities) — the operator-facing view of the same rules
- [Capability manifest reference](../reference/capability-manifest.md) — the field-level conformance invariants
- [`gsd capability` command reference](../reference/gsd-capability-command.md)
- [Install your first capability](../tutorials/install-your-first-capability.md)
