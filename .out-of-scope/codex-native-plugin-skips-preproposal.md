# Codex-native GSD plugin, filed without a pre-proposal

**Source:** [#4027](https://github.com/open-gsd/gsd-core/issues/4027)
**Decision:** wontfix — No-go as filed; redirected to community-maintained distribution (EoS/Capability), not a first-party plugin
**Date:** 2026-08-29

## Policy (standing, not case-by-case)

**GSD is not accepting new add-ons as first-party, maintainer-owned work at this
time — full stop.** A "plugin" proposal that asks gsd-core to own, package, and
maintain a new distribution surface is declined regardless of how well-executed
the implementation is; the supported path is community-maintained distribution
through the EoS Registry or the Capability system, where the author owns the
release cadence and maintenance. This is the same ground as new-runtime
requests (see [`crush-runtime-in-core.md`](./crush-runtime-in-core.md)) applied
to add-ons generally, not just runtimes. A future triage pass should apply this
without re-litigating whether a particular plugin proposal is good — the
question is only "is this asking gsd-core to own a new add-on," not "is the
pre-proposal filed."

## Proposal summary

#4027 proposes an "official-format local Codex plugin" packaging GSD's existing
skills and MCP server: a read-only project control center (milestone/phase/plan/
verification/blocker status), a UAT workbench (review outstanding checks, record
pass/issue results), and structured MCP output for non-visual clients. It claims
to reuse the existing CLI, stdio MCP server, resource catalog, and npm package
with no new runtime dependency, hosted backend, duplicate command layer, or
persistent marketplace config. A working implementation allegedly exists on the
reporter's own fork branch (`yansigit/gsd-core:codex/gsd-codex-plugin`); the
reporter offered to open a PR against the feature template if approved.

## Why GSD does not own this — as filed

- **This repo has an established pre-proposal convention for first-party
  plugin/marketplace-surface work that this issue skipped entirely.** The
  precedent is `docs/proposals/mempalace-capability-prd-adr.md` — a status
  ladder (Pre-Proposal → Proposed → Accepted) for exactly this class of change:
  a new first-party distribution surface, not an ordinary feature. #4027 went
  straight to a `needs-triage` feature request backed by an already-built fork
  implementation, bypassing the step where the surface itself (not just the
  implementation) gets scoped and agreed.
- **It lands on a design axis [ADR-857](../docs/adr/857-capability-system.md)
  explicitly defers** — the "third-party trust gate" / Connected Capability
  question (`docs/adr/857-capability-system.md:114`). Shipping a first-party
  plugin/marketplace surface now would build ahead of an unsettled architecture
  decision, independent of whether the reporter's implementation is good.
- **The proposal is also under-specified for review as filed.** "Control
  center" and "UAT workbench" describe a shape, not an exact surface (which MCP
  tools, which resources, what the plugin manifest actually declares) — a
  pre-proposal doc is where that gets nailed down before a maintainer commits to
  an ongoing packaging/maintenance obligation.

## What this does NOT cover

This entry denies **gsd-core adopting this as first-party, maintainer-owned
work.** It does not deny, and must never be cited against:

- **Shipping this as a community-maintained EoS host-plugin or Capability.**
  Everything the proposal describes (control-center views, UAT workbench, MCP
  output) can be built and distributed by the reporter today via the same path
  as `gsd-cursor`/`gsd-omp`/`gsd-reasonix`, listed in the EoS Registry — with no
  gsd-core changes and no maintainer packaging commitment.
- **The underlying idea of packaging GSD for Codex.** No judgment is made on
  whether the idea is good — only that gsd-core will not be the one building,
  packaging, and maintaining it.
- **The reporter's fork implementation itself**, which was not reviewed as part
  of this decision (reviewing an external fork's code is out of scope for
  triage; see the repo's untrusted-content handling).
- **Existing Codex runtime support** (`capabilities/codex/capability.json`),
  which is unaffected.

## Re-open criteria

- GSD reopens accepting new first-party add-ons/plugins in general (a policy
  change, not a per-proposal argument) — until then, this and every similar
  "build/own X as a first-party plugin" request gets the same answer.
- Separately, and only if that policy changes: a pre-proposal doc filed under
  `docs/proposals/` scoping the plugin's exact surface, following the
  Pre-Proposal → Proposed → Accepted ladder, and ADR-857's deferred third-party
  trust gate resolved.

## Related

- [ADR-857](../docs/adr/857-capability-system.md) — capability system, deferred
  third-party trust gate
- `docs/proposals/mempalace-capability-prd-adr.md` — the precedent for this
  proposal class and its status ladder
- `capabilities/codex/capability.json` — existing Codex runtime support,
  unaffected by this decision
