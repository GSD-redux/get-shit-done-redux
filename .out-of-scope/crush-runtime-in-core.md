# crush as a first-class in-tree registry entry

**Source:** [#4033](https://github.com/open-gsd/gsd-core/issues/4033)
**Decision:** wontfix — closed as filed; redirected to the EoS Registry / out-of-tree host-plugin path (or a Capability, if the actual need turns out to be feature-shaped rather than runtime-shaped)
**Date:** 2026-08-29

## Policy (standing, not case-by-case)

**GSD is not accepting new runtimes or add-ons as first-party, in-tree work at
this time — full stop, not a "go-with-conditions" case-by-case call.** Any "add
X to GSD" request for a new runtime, host integration, or add-on that is not
already community-maintained gets the same disposition: redirect to the EoS
Registry (new host/runtime identity) or the Capability system (new toggleable
feature), never conditional approval into gsd-core itself. A future triage pass
must not re-litigate this per-request — the diligence to apply is "does this
ask for a new runtime or add-on in-tree", not "is this particular one well
executed."

## Proposal summary

#4033 asked to add `crush` (Charm's terminal AI coding agent) as a **first-party,
in-tree** runtime: a `capabilities/crush/capability.json` descriptor plus wiring
across `runtimeTierDefaults` in `gsd-core/bin/shared/model-catalog.json`,
`src/runtime-name-policy.cts`, `src/runtime-artifact-layout.cts`,
`src/runtime-artifact-conversion.cts`, and `bin/install.js`, following `zcode` as
the reference runtime. The reporter explicitly flagged five open questions about
crush's agent-artifact format, permission model, frontmatter tolerance, MCP
support, and install-scope conventions that could not be answered from inside
gsd-core alone.

This is the same shape of ask as the Reasonix and OMP requests: a
previously-unsupported host proposed as a new entry in the in-tree runtime
registry GSD maintains itself.

## Why GSD does not own this

- **GSD is not expanding its in-tree supported-runtime set.** Each first-class
  runtime is a permanent maintenance obligation across the registry, installer,
  artifact conversion, agent discovery, model routing, dispatch isolation,
  golden install-parity fixtures, and localized capability matrices — carried
  indefinitely for a host GSD does not control. This is the same ground already
  recorded twice: [`omp-runtime-in-core.md`](./omp-runtime-in-core.md) and
  [`eos-registry-not-in-tree-runtime.md`](./eos-registry-not-in-tree-runtime.md).
- **The supported direction is the Embeddable Orchestration System (EoS), and it
  is already available.** [ADR-1239](../docs/adr/1239-gsd-embeddable-orchestration-engine.md)
  exists precisely so a host embeds GSD through a stable negotiated interface and
  a thin host-plugin authored against the published Host-Integration SDK
  ([`docs/how-to/author-a-host-plugin.md`](../docs/how-to/author-a-host-plugin.md))
  — without modifying gsd-core source. New hosts are listed in the
  [EoS Registry](../docs/registries/eos-registry.md) (`docs/registries/eos.json`,
  `type: "eos"`), via a docs PR (`npm run gen:registry`). Existing entries
  (`gsd-cursor`, `gsd-omp`, `gsd-reasonix`) already follow this path. If the
  actual need is narrower — a loop-behavior addition rather than a whole new
  host — the [Capability](../docs/how-to/develop-a-capability.md) path
  (`role: "feature"`, ADR-1244) is the other supported out-of-tree route; which
  one fits depends on what crush support actually turns out to require.
- **Two directly-analogous precedents are on point and recent.** Reasonix
  (#3346, 2026-08-11) and OMP (#3037/#874/#1948, most recently 2026-06-08) were
  both declined on this exact ground — new terminal coding agent, proposed as an
  in-tree runtime — with the same redirect. The reviewer's own maturity research
  (crush's actual agent-config format is plain context files + a Bash-DSL
  config, not the MD+frontmatter the issue assumed; permission-model and MCP
  support unconfirmed) independently reinforces why this shouldn't be built
  in-tree against unverified assumptions about crush's real interface.

## What this does NOT cover

This entry denies **first-party, in-tree runtime registration for crush.** It
does not deny, and must never be cited against:

- **Shipping an out-of-tree host-plugin for crush.** This is welcome and
  supported, and is the intended route. A crush plugin that embeds GSD via the
  Host-Integration SDK and is listed in `docs/registries/eos.json` is exactly
  the path this decision points to.
- **A crush integration built as a Capability**, if what's actually needed is a
  toggleable feature rather than a new host identity — see
  [`docs/how-to/develop-a-capability.md`](../docs/how-to/develop-a-capability.md).
- **Fixing defects that surface through a non-registered runtime**, or improving
  the documented override/SDK contracts a host plugin depends on.
- **Migrations of already-supported runtimes** onto the EoS architecture. Those
  are lower-risk upgrades of hosts GSD already owns, not new-host onboardings.
- **Any existing runtime's support tier.**

## Re-open criteria

- GSD reopens first-class in-tree runtime registration — e.g. funded development
  changes the maintenance calculus, or third-party `role: "runtime"` descriptors
  become loadable from outside the repo (ADR-857 D8's deferred purely-additive
  external loader). Until one of these holds, the answer for any new host is the
  EoS Registry, not the in-tree registry.
- crush demonstrates an integration need the EoS Host-Integration Interface
  genuinely cannot express (none shown to date).

## Related

- [`omp-runtime-in-core.md`](./omp-runtime-in-core.md) — sibling decision, same
  ground
- [`eos-registry-not-in-tree-runtime.md`](./eos-registry-not-in-tree-runtime.md) —
  sibling decision (Reasonix), same ground, same redirect
- [ADR-1239](../docs/adr/1239-gsd-embeddable-orchestration-engine.md) — GSD as
  an Embeddable Orchestration Engine (EoS)
- [`docs/how-to/author-a-host-plugin.md`](../docs/how-to/author-a-host-plugin.md) —
  the supported out-of-tree authoring path
- [`docs/how-to/develop-a-capability.md`](../docs/how-to/develop-a-capability.md) —
  the Capability path, if the need turns out to be feature-shaped
- [`docs/registries/README.md`](../docs/registries/README.md) — EoS Registry
  entry schema + submission process
- [#2170](https://github.com/open-gsd/gsd-core/issues/2170) — Devin CLI runtime,
  the original on-point precedent cited by the Reasonix decision
