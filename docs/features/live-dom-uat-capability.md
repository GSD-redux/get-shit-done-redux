---
id: 164
title: Live-DOM UAT Capability
group: v1.7.0 Features
---

**Config key:** `workflow.live_dom_uat` (default `false`)

**Purpose:** A phase with a live-UI acceptance criterion could not be finished by the agent that executed it. `gsd-executor` carries no browser tools, so it correctly returned a `checkpoint:human-action` — even though the work was not human-only, just tool-less. Every such phase quietly degraded from *executed by the executor* to *executed, then finished by hand in the orchestrator*, and the plan's `autonomous: false` marker could not distinguish "a human must judge this" from "the executor lacks the tool" (#2856).

**Behavior:** A default-off capability owns one boolean key, one agent, and one additive step. When the key is on, `gsd-dom-verifier` runs at `execute:wave:post` and writes `{phase}-DOM-VERIFY.md`; the orchestrator's `automated_ui_verification` step additionally considers `mcp__chrome-devtools__*` / `mcp__claude-in-chrome__*` when present.

**The executor's tool surface is unchanged in every configuration.** Widening it was the reported proposal and was refused: for a first-party agent the static `tools:` list is the only control that exists — no capability can grant tools to one ([ADR-1244](adr/1244-capability-ecosystem.md) D2), no hook kind grants tool permissions ([ADR-857](adr/857-capability-system.md) D4), and there is no per-dispatch override. Browser reach lives in one purpose-built agent that carries no `Bash`.

**Two independent gates, both fail-closed.** The capability's `activationKey` makes it resolve inactive when the key is off — `resolveLoopHooks` renders a hook only on `state.active === true` — and the step carries its own `when` guard. Tool presence alone never activates it: a browser MCP configured for unrelated work is not driven by default.

**The pre-existing Playwright path is untouched.** `mcp__playwright__*` keeps the gating it already had (presence plus an active UI phase). Pulling it behind a new default-off key would have silently removed working behavior from current users on upgrade; the key gates only the newly added families.

**It tolerates the browser-profile lock rather than coordinating it.** `chrome-devtools-mcp` holds an exclusive lock on its profile, so parallel waves collide. `--isolated` is a flag on the operator's own MCP server registration — GSD neither launches that server nor passes its arguments — so the verifier reports `could_not_look` / `profile_locked`, names the flag, and stops. No retry, no held-up wave.

**`nothing_to_report` is never conflated with `could_not_look`.** A report claiming no issues when it never opened a browser is worse than no report; the artifact carries a closed reason enum so the two are always distinguishable.

**Known limits:** no sandbox — once enabled, nothing constrains which origins are reached ([ADR-1244](adr/1244-capability-ecosystem.md) D5); DOM observation only, no screenshot diffing, accessibility audit, or performance tracing.

**Reference:** [Configuration](CONFIGURATION.md) · [Enable live-DOM verification](how-to/enable-live-dom-verification.md) · [Explanation](explanation/live-dom-uat-capability.md) · [Agents](AGENTS.md)
