# OMP (Oh My Pi) as a first-class runtime in gsd-core

gsd-core does not add `omp` (Oh My Pi) as a first-class runtime: no
`capabilities/omp/capability.json`, no `omp` entry in the runtime registry, no
`omp` alias canonicalization, and no installer runtime selection for it.

This is a **scope** decision, not a judgement about OMP or about the quality of
the proposals that have asked for it.

## Why this is out of scope

- **GSD is not expanding its supported-runtime set.** The long-term direction is
  to *reduce* the number of supported runtimes, not grow it, absent funded
  development. Each first-class runtime is a permanent maintenance obligation
  across the registry, installer, artifact conversion, agent discovery, model
  routing, dispatch isolation, golden install-parity fixtures, and localized
  capability matrices — carried indefinitely by the project, for a host it does
  not control.
- **Host integration is the supported direction, and it is already available.**
  The Embeddable Orchestration System (ADR-1239) exists precisely so a host can
  embed GSD and declare its own capabilities, instead of GSD resolving the host
  from an in-tree registry. An out-of-tree host plugin needs no runtime
  descriptor. `GSD_AGENTS_DIR` is a documented Priority-1 override honored for
  *any* runtime name (`src/agent-install-check.cts`, `getAgentsDir`), so a plugin
  can own its filesystem layout without core knowing the runtime exists.
- **The ask as filed also carried a defect.** #3037 proposed canonicalizing
  `pi`, `oh-my-pi` and `pi-coding-agent` to `omp`. OMP is a *fork* of pi
  (pi.dev), and gsd-core already ships a distinct `pi` runtime
  ([`capabilities/pi/capability.json`](../capabilities/pi/capability.json), home
  `~/.pi/agent`, tier 2). That alias list would relocate an existing shipped
  runtime's config home rather than add a new one. This is recorded so a future
  revision does not repeat it — it is a correction, not an additional ground for
  the decision.

## What this does NOT cover

This entry denies **in-tree, first-class runtime registration for OMP**. It does
not deny, and should never be cited against:

- **Shipping an out-of-tree host plugin for OMP, or for any other host.** This
  is welcome and supported. `gsd-omp` is already listed in
  [`docs/registries/eos.json`](../docs/registries/eos.json) and remains listed;
  registry inclusion is explicitly non-endorsement and is unaffected by this
  decision.
- **Feature capabilities** (`role: "feature"`) published out-of-tree under
  ADR-1244. That is a different axis — *what loop behavior you add*, not *which
  runtime you are*.
- **Fixing defects that happen to surface through a non-registered runtime**, or
  improving the documented override contracts a host plugin depends on.
- **Any other runtime's support tier.** This entry is about OMP specifically and
  says nothing about existing runtimes, including `pi`.

**Revisit if** third-party `role: "runtime"` descriptors become loadable from
outside the repo — ADR-857 D8 defers this to a purely additive external loader
that has not been delivered — or if funded development changes the maintenance
calculus that makes an additional first-class runtime unaffordable.

## Prior requests

- #874 — "feat: Native OMP (Oh My Pi) Runtime Support" (closed not planned,
  2026-06-08)
- #1948 — "Add Oh My Pi / OMP as a supported runtime" (closed as duplicate of
  #874)
- #1947 — implementation PR for #874 (closed unmerged)
- #3037 — "feat: complete first-class OMP runtime descriptor and registry
  integration" (closed not planned; the decision this entry records)

*The first denial was never written down here, so the same request returned
twice more. That is the reason this file exists.*
