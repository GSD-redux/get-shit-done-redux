---
id: 121
title: Knowledge Graph Integration
group: v1.37.0 Features
---

**Purpose:** Build, query, and inspect a lightweight knowledge graph of the project in `.planning/graphs/`. Opt-in per project. Exposed as the `/gsd-graphify` user-facing command and the `gsd-tools.cjs graphify …` programmatic verb family. Complements `/gsd-map-codebase --query` (snapshot-oriented) with a graph-oriented view of nodes and edges across commands, agents, workflows, and phases.

**Requirements:**
- REQ-GRAPH-01: Opt-in via `graphify.enabled: true` in `.planning/config.json`. When disabled, `/gsd-graphify` prints an activation hint and stops without writing.
- REQ-GRAPH-02: Slash-command `/gsd-graphify` exposes subcommands `build`, `query <term>`, `status`, `diff`. The programmatic CLI `node gsd-tools.cjs graphify …` additionally exposes `snapshot`, which is also invoked automatically as the final step of `graphify build`.
- REQ-GRAPH-03: Build runs within the configurable `graphify.build_timeout` (seconds); exceeding the timeout aborts cleanly without leaving a partial graph.
- REQ-GRAPH-04: `graphify.cjs` falls back to `graph.links` when `graph.edges` is absent so older graph artifacts keep rendering.
- REQ-GRAPH-05: Graphify is invoked through `gsd-tools.cjs graphify ...` command handlers.
- REQ-GRAPH-06: The knowledge-graph location is configurable via `graphify.graph_path` (issue #1825) so one umbrella-level cross-repo graph can serve multiple sibling projects; `query`/`status`/`diff` read the configured graph (relative to project root), with a byte-identical `.planning/graphs/` default when unset.

**Configuration:** `graphify.enabled`, `graphify.build_timeout`, `graphify.graph_path`
**Reference files:** `commands/gsd/graphify.md`, `bin/lib/graphify.cjs`
