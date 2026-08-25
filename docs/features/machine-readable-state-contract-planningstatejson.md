---
id: 166
title: Machine-Readable State Contract (`.planning/state.json`)
group: v1.7.0 Features
---

**Purpose:** External tools that display GSD project state — a workbench, a dashboard, an editor extension — had to parse `STATE.md` and `ROADMAP.md` heuristically. Those are human surfaces: their shape drifts as the templates evolve, and every consumer ends up carrying a brittle second parser that silently reports wrong numbers after an upgrade. GSD now publishes a small, versioned JSON snapshot instead, so the reader binds to a contract rather than to markdown (#3227).

**Behavior:** At every step boundary, GSD writes `.planning/state.json` — `contract`, `flavor`, `milestone`, `phases[]`, `next`, `updated_at`. The boundaries are `state begin-phase` / `planned-phase` / `advance-plan` / `complete-phase` / `milestone-switch`, `phase add` / `add-batch` / `insert` / `remove` / `complete`, and `milestone complete`. The write is best-effort and completely invisible to the command that triggered it: it cannot change an exit code, cannot change stdout, and cannot fail a workflow. Readers prefer the file when it is present and fall back to markdown when it is not.

**Requirements:**
- REQ-SC-01: `contract` is semver, `1.0.0` at introduction. Consumers gate on the MAJOR version; `1.x` changes are additive only. Every key is ALWAYS present — an unknown value is `null`, never an omitted key, because an omitted key is itself an observable a consumer would bind to.
- REQ-SC-02: `phases[]` carries `{number, name, status}` per phase, `status` drawn from exactly `complete | in_progress | pending`. `number` is a string (`"01"` and `"2.1"` are both real ids and neither survives a number cast); `name` is `null` when the roadmap gives a phase no name, never a fabricated placeholder.
- REQ-SC-03: `next` is the same recommended action the `/gsd` front door routes, derived from the smart-entry classifier itself rather than from a second copy of its routing table.
- REQ-SC-04: A missing `ROADMAP.md`, a missing or unreadable `.planning/`, an unwritable target, or any other failure NEVER errors the parent command. A directory that is not a GSD project stays untouched — the publisher will not create `.planning/` in order to publish into it.
- REQ-SC-05: The skills own the file; readers never write it. It is a derived cache — safe to delete, regenerated at the next boundary.

**Composed, never re-derived.** Milestone identity comes from `getMilestoneInfo`; phase rows from `locateProgressTable`, the same `## Progress` locator the progress counters use, so `state.json` can never disagree with the rest of GSD about which phases are complete; the recommended action from `classifyProject`. This module introduces no second answer to any question GSD already answers.

**Why it does not reuse `planning inspect`'s schema.** The two surfaces answer different questions and have opposite shapes. `planning inspect` is a rich, diagnostic-carrying **pull** query a consumer runs; this is a small **push** artifact a consumer watches. Publishing `planning inspect`'s payload at every `phase add` would mean opening every plan, summary and requirements document on a hot path, and freezing a much larger surface as a contract.

**It costs up to three bounded git calls per boundary.** Deriving `next` from the smart-entry classifier means inheriting its git signals — `git status --porcelain`, and `git log @{u}..HEAD`. Each is timeout-bounded and swallows every error, so nothing can hang or fail because of it, but a command like `phase add` did not previously touch git at all. "Invisible to the parent command" is exact about exit code and output; it is not a claim about latency.

**Known limits:** an empty `phases: []` cannot be told apart from "no `ROADMAP.md`" or "roadmap unreadable" — the `1.0` schema carries no diagnostic channel, and `planning inspect` is the surface that does. A roadmap phase marked `Deferred` is reported as `pending`, because the roadmap vocabulary has four values and this contract has three; inventing a fourth wire value would break every existing reader. `phases[]` is not milestone-scoped, so a long-running project lists every phase it has ever had.

**Reference:** [Consume the state contract](how-to/consume-the-state-contract.md) · [Consume the planning snapshot](how-to/consume-the-planning-snapshot.md)
