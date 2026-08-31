---
id: 156
title: API-Coverage Gate
group: v1.7.0 Features
---

**Command:** `/gsd-verify-work`

**Purpose:** A phase that integrates an external API, SDK, or service can no longer seal verification without a decided coverage matrix (#1562).

**Behavior:** At seal time the gate reads the phase scope — the plan bodies, falling back to this phase's ROADMAP section — and runs the deterministic detector over it. An integration signal without a `COVERAGE.md` matrix blocks the seal; no signal passes.

**Unestablished scope is not a negative verdict (#3909).** A phase with no plan body *and* no roadmap section gives the detector nothing to examine. The gate used to run detection over zero bytes and pass, certifying "no external-API integration" from a probe that never looked. It now holds the seal instead, reporting `scope_unavailable: true`. A phase whose plans are real and simply contain no API vocabulary is unaffected — the discriminator is *bytes examined*, never *signals found*.

**Breaking change:** a phase that previously sealed because its detector could not establish a scope is now correctly held. Add the phase plan, or record a reasoned `No external API integration: <reason>` declaration in `COVERAGE.md`. See [Resolve a skipped capability probe](how-to/resolve-a-skipped-capability-probe.md).
