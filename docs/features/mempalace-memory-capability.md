---
id: 145
title: MemPalace Memory Capability
group: v1.43.0 Features
---

**Purpose:** Opt-in cross-session and cross-project memory via the [MemPalace](https://github.com/MemPalace/mempalace) external service (local-first, MCP + CLI). Wires deliberate recall before discuss/plan and verbatim capture + temporal-KG sync at phase boundaries through the ADR-857 capability mechanism. Default-resilient: disabled by default, every hook is `onError: skip`, and an absent MemPalace installation leaves the loop unchanged.

**Commands:** `/gsd-mempalace-recall`, `/gsd-mempalace-capture`

**Requirements:**
- REQ-MP-01: Opt-in via `mempalace.enabled: true`. Default `false` — the loop is unchanged when unset.
- REQ-MP-02: At `plan:pre`, skill `mempalace-recall` produces `MEMORY-RECALL.md` from prior decisions, patterns, and surprises retrieved via wake-up + semantic search + KG timeline. When MemPalace is unreachable, writes an "unavailable" stub and continues.
- REQ-MP-03: At `discuss:post`, `plan:post`, and `verify:post`, skill `mempalace-capture` files the phase artifact verbatim into the appropriate MemPalace room (`decisions`, `planning`, `milestones`). Capture is idempotent via `mempalace_check_duplicate`.
- REQ-MP-04: At `ship:post`, agent `gsd-mempalace-curator` writes a diary entry, proposes cross-project tunnels (when `mempalace.cross_project_tunnels: true`), and runs wing-scoped sync pruning.
- REQ-MP-05: `mempalace.memory_mode` has three wired values: `augment` (default — palace is an additive recall layer alongside GSD native memory, which stays authoritative), `kg_backend` (knowledge-graph queries resolve against the palace's temporal KG as the primary source, `.planning/graphs/` as fallback; non-KG drawer recall stays additive), `replace` (recall resolves through the palace as the source of truth, native memory as fallback). Every mode is `onError:skip` and default-resilient — an unreachable palace degrades to native memory and GSD keeps writing `.planning/graphs/`, so no mode loses memory. Cross-mode migration of existing `.planning/graphs/` into the palace is out of scope (not yet implemented).
- REQ-MP-06: Every hook is `onError: skip`. No hook carries `blocking: true`. Memory never halts or fails a phase.
- REQ-MP-07: Interactive runs prefer MCP tools; headless/cron runs prefer the MemPalace CLI (`mempalace wake-up`, `mempalace search`, `mempalace mine`, `mempalace sync`).
- REQ-MP-08: `mempalace.auto_capture_hooks` is **forward-declared and not yet functional**. No native Claude Code hooks (`stop`, `precompact`, `session-start`) are installed by this key; the capability's hooks array is empty. This key is reserved for the future "Connected Capability" phase. Default `false`.

**Configuration:** `mempalace.enabled`, `mempalace.memory_mode`, `mempalace.wing`, `mempalace.recall_on_discuss`, `mempalace.recall_on_plan`, `mempalace.capture_artifacts`, `mempalace.mirror_kg`, `mempalace.cross_project_tunnels`, `mempalace.diary_journal`, `mempalace.auto_capture_hooks`

See [Configuration Reference](CONFIGURATION.md#mempalace-settings) for full schema and [How to enable cross-session memory with MemPalace](how-to/enable-cross-session-memory-with-mempalace.md) for a setup walkthrough.
