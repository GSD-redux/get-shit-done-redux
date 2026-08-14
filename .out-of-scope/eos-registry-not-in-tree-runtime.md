# New host runtimes as first-class in-tree registry entries

**Source:** [#3346](https://github.com/open-gsd/gsd-core/issues/3346)
**Decision:** wontfix — closed as filed; redirected to the EoS Registry / out-of-tree host-plugin path
**Date:** 2026-08-11

## Proposal summary

#3346 asked to add a `reasonix` runtime as a **first-party, in-tree** integration: a
`capabilities/reasonix/capability.json` descriptor merged into the generated runtime
`bin/lib/capability-registry.cjs`, so `gsd-tools` dispatch/isolation/effort queries resolve
when GSD runs inside "Reasonix." The stated motivation was that launcher skills picked up by
Reasonix reference tools/paths of another host, and dispatch resolves to the wrong integration.

This is the same shape of ask as the OMP request: a previously-unsupported host proposed as a
new entry in the in-tree runtime registry GSD maintains itself.

## Why GSD does not own this

- **GSD is not expanding its in-tree supported-runtime set.** Each first-class runtime is a
  permanent maintenance obligation across the registry, installer, artifact conversion, agent
  discovery, model routing, dispatch isolation, golden install-parity fixtures, and localized
  capability matrices — carried indefinitely for a host GSD does not control. This is the same
  ground recorded for OMP (see [`omp-runtime-in-core.md`](./omp-runtime-in-core.md)).
- **The supported direction is the Embeddable Orchestration System (EoS), and it is already
  available.** [ADR-1239](../docs/adr/1239-gsd-embeddable-orchestration-engine.md) exists
  precisely so a host embeds GSD through a stable negotiated interface and a thin **host-plugin**
  authored against the published Host-Integration SDK
  ([`docs/how-to/author-a-host-plugin.md`](../docs/how-to/author-a-host-plugin.md)) — **without
  modifying gsd-core source.** New hosts are listed in the
  [EoS Registry](../docs/registries/eos-registry.md) (`docs/registries/eos.json`, `type: "eos"`),
  the non-endorsing discoverability catalog, via a docs PR (`npm run gen:registry`). Existing
  entries (`gsd-cursor`, `gsd-omp`) already follow this path.
- **The directly-analogous precedent is one month old and on point.** The Devin CLI request
  ([#2170](https://github.com/open-gsd/gsd-core/issues/2170), closed not planned 2026-07-11) — a
  genuinely new terminal coding agent proposed as a new runtime integration — was declined with
  an explicit policy statement: *"The point of the EoS is to let people deploy and curate their
  own integrations, not to have the maintainers continually monitor all the platforms and make
  sure they work… If you want to use Devin, then you can build the extension for it."* Reasonix is
  the same category of request.
- **The filed draft's load-bearing claim did not match the host's own documentation.** The
  feature's entire justification — that Reasonix reads the `.agents/skills` and `.claude/skills`
  convention roots — is contradicted by Reasonix's own SPEC.md/site, which describe
  `~/.reasonix/skills/` and `.reasonix/commands/`. A registry entry must source every axis from
  the host's authoritative docs per `docs/how-to/add-or-update-a-host-integration.md`'s "never
  infer, guess, or assume" rule; the draft asserted values that the primary source contradicts.
  This is recorded as a correction so a resubmission does not repeat it — not as an additional
  ground for the decision, which holds on the EoS-direction ground alone.

## What this does NOT cover

This entry denies **first-party, in-tree runtime registration for new hosts.** It does not deny,
and must never be cited against:

- **Shipping an out-of-tree host-plugin for Reasonix, or for any other host.** This is welcome
  and supported, and is the intended route. A Reasonix plugin that embeds GSD via the
  Host-Integration SDK and is listed in `docs/registries/eos.json` is exactly the path this
  decision points to.
- **Feature capabilities** (`role: "feature"`) published out-of-tree under ADR-1244 — a different
  axis (what loop behavior you add, not which runtime you are).
- **Fixing defects that surface through a non-registered runtime**, or improving the documented
  override/SDK contracts a host plugin depends on.
- **Migrations of *already-supported* runtimes** onto the EoS architecture (the #2086/#2095/#2096/
  #2097/#2099 family). Those are lower-risk upgrades of hosts GSD already owns, not new-host
  onboardings, and are unaffected by this decision.
- **Any existing runtime's support tier.**

## Re-open criteria

- GSD reopens first-class in-tree runtime registration — e.g. funded development changes the
  maintenance calculus, or third-party `role: "runtime"` descriptors become loadable from outside
  the repo (ADR-857 D8's deferred purely-additive external loader). Until one of these holds, the
  answer for any new host is the EoS Registry, not the in-tree registry.
- A host demonstrates an integration need the EoS Host-Integration Interface genuinely cannot
  express (none shown to date; Reasonix's real artifact needs map onto existing `skills`/`commands`
  artifact kinds).

## Related

- [`omp-runtime-in-core.md`](./omp-runtime-in-core.md) — sibling decision; same ground (new host
  as in-tree runtime), same redirect to EoS
- [ADR-1239](../docs/adr/1239-gsd-embeddable-orchestration-engine.md) — GSD as an Embeddable
  Orchestration Engine (EoS)
- [`docs/how-to/author-a-host-plugin.md`](../docs/how-to/author-a-host-plugin.md) — the supported
  out-of-tree authoring path
- [`docs/registries/README.md`](../docs/registries/README.md) — EoS Registry entry schema +
  submission process
- [#2170](https://github.com/open-gsd/gsd-core/issues/2170) — Devin CLI runtime, the one-month-old
  on-point precedent
