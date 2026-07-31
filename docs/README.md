# GSD Core documentation

Documentation is organised into four quadrants: **tutorials** help you learn by doing, **how-to guides** solve specific tasks, **reference** states authoritative facts, and **explanation** explores concepts and design decisions.

Language versions: [English](README.md) · [Português (pt-BR)](pt-BR/README.md) · [日本語](ja-JP/README.md) · [简体中文](zh-CN/README.md)

---

## Tutorials

- [Your first project](tutorials/your-first-project.md) — install to first shipped phase, one guaranteed path
- [Onboarding an existing codebase](tutorials/onboarding-an-existing-codebase.md) — bring GSD Core to a brownfield repo
- [Build your first capability](tutorials/build-your-first-capability.md) — author a tiny declarative capability and watch it act in the loop
- [Install your first capability](tutorials/install-your-first-capability.md) — install a third-party capability end-to-end: consent, verify, check for updates, remove

---

## How-to guides

- [Install on your runtime](how-to/install-on-your-runtime.md) — runtime-specific install steps for all 16 supported runtimes
- [Install a minimal GSD and add skills later](how-to/install-minimal-and-add-skills.md) — install only the core skills, then grow the surface with profiles and `/gsd:surface`
- [Attach a plugin-provided skill to a GSD agent](how-to/attach-a-plugin-skill-to-a-gsd-agent.md) — use the `global:plugin:skill` entry form to load Claude Code plugin skills into agent prompts
- [Discuss a phase](how-to/discuss-a-phase.md) — capture implementation decisions before planning begins
- [Resolve edge-coverage findings](how-to/resolve-edge-coverage-findings.md) — turn the spec phase's surfaced domain-boundary edges into covered, dismissed, or backstopped spec decisions
- [Resolve prohibition findings](how-to/resolve-prohibition-findings.md) — turn the spec phase's surfaced must-NOT constraints into resolved, dismissed, or deferred spec decisions
- [Plan a phase](how-to/plan-a-phase.md) — run research, decompose work, and verify plan quality
- [Execute a phase](how-to/execute-a-phase.md) — run plans in parallel waves with fresh-context subagents
- [Verify and ship](how-to/verify-and-ship.md) — walk through completed work, diagnose failures, and create the PR
- [Run phases autonomously](how-to/run-phases-autonomously.md) — use autonomous mode for unattended phase execution
- [Handle quick and fast tasks](how-to/handle-quick-and-fast-tasks.md) — use `/gsd-quick` and `/gsd-fast` for ad-hoc work outside the phase loop
- [Configure model profiles](how-to/configure-model-profiles.md) — switch between quality, balanced, and budget model tiers
- [Set up cross-AI review](how-to/set-up-cross-ai-review.md) — configure a second AI to review code produced by the primary agent
- [Work in parallel with workstreams](how-to/work-in-parallel-with-workstreams.md) — run independent lines of work simultaneously using workstreams
- [Isolate work with workspaces](how-to/isolate-work-with-workspaces.md) — use workspaces to sandbox experimental or risky changes
- [Debug a failed execution](how-to/debug-a-failed-execution.md) — diagnose and recover from broken or incomplete phase execution
- [Spike and sketch](how-to/spike-and-sketch.md) — use `/gsd-spike` and `/gsd-sketch` for exploratory work before committing to a plan
- [Design a UI phase](how-to/design-a-ui-phase.md) — use the UI phase loop for frontend and visual work
- [Develop a Capability for GSD 1.5+](how-to/develop-a-capability.md) — add feature Capabilities, hook fragments, and registry entries
- [Ship a reviewer lane in your capability](how-to/ship-a-reviewer-lane.md) — declare a `reviewer` body so `/gsd-review` discovers, invokes, and renders your external review CLI or model endpoint
- [Add or update a host's integration](how-to/add-or-update-a-host-integration.md) — set a host's documentation-sourced `runtime.hostIntegration` axes (ADR-1239 Phase A), with the `undocumented` sentinel rule
- [Turn a capability off (and keep it off)](how-to/turn-a-capability-off.md) — disable a capability via the surface, or gate individual hooks off without removing the capability
- [Drive GSD from a tracker issue](how-to/drive-gsd-from-a-tracker-issue.md) — start a phase from a GitHub, Linear, or Jira issue
- [Migrate from GSD 2](how-to/migrate-from-gsd-2.md) — upgrade an existing GSD 2 project to GSD Core
- [Update GSD](how-to/update-gsd.md) — re-run the installer to pick up the latest release
- [Clean up get-shit-done-cc](cleanup-get-shit-done-cc.md) — remove leftover old-package artifacts that cause a spurious `⬆ /gsd:update` indicator after migrating to `@opengsd/gsd-core`
- [Fix the worktree base-mismatch (exit 42) error](how-to/fix-worktree-base-mismatch.md) — resolve the branch-divergence condition that halts parallel phase execution
- [Recover and troubleshoot](how-to/recover-and-troubleshoot.md) — fix common problems, rebuild context, and uninstall

---

## Reference

- [Commands](COMMANDS.md) — every command with flags and examples
- [Configuration](CONFIGURATION.md) — full config schema, model profiles, git branching strategies
- [CLI tools](CLI-TOOLS.md) — `gsd-tools.cjs` programmatic API for workflows and agents
- [Features](FEATURES.md) — complete feature index
- [Inventory](INVENTORY.md) — installed skills and surface map
- [STATE.md schema](reference/state-md.md) — field-by-field reference for `.planning/STATE.md`
- [CONTEXT.md schema](reference/context-md.md) — field-by-field reference for `.planning/phases/<N>/CONTEXT.md`
- [PLAN.md schema](reference/plan-md.md) — field-by-field reference for `.planning/phases/<N>/PLAN.md`
- [Planning artifacts](reference/planning-artifacts.md) — all `.planning/` files and their roles
- [Review and verification capabilities](reference/review-verification-capabilities.md) — code review, security, and Nyquist capability ownership and hook contracts
- [Capability matrix](reference/capability-matrix.md) — generated catalogue of every capability's role, tier, extension points, hook kinds, and `engines.gsd`
- [Capability manifest](reference/capability-manifest.md) — the full `capability.json` schema and validation rules
- [`gsd capability` command](reference/gsd-capability-command.md) — install / update / remove / list reference for third-party capabilities

---

## Explanation

- [Context engineering](explanation/context-engineering.md) — how context rot forms and how GSD Core prevents it
- [The phase loop](explanation/the-phase-loop.md) — design rationale for the Discuss → Plan → Execute → Verify → Ship cycle
- [Multi-agent orchestration](explanation/multi-agent-orchestration.md) — how subagents are spawned, scoped, and coordinated
- [Security model](explanation/security-model.md) — trust boundaries, permissions, and safe automation
- [The capability trust model](explanation/capability-trust-model.md) — why third-party capabilities are gated by consent + integrity + reversibility, not a sandbox
- [How overlay capabilities compose](explanation/capability-overlay-model.md) — why first-party always wins and how the loader resolves precedence, conflicts, and fail-open load-failure warnings
- [Architecture](ARCHITECTURE.md) — system architecture, agent model, and data flow
- [The Embeddable Orchestration System](explanation/embeddable-orchestration-system.md) — one public, versioned contract for embedding GSD across many hosts
- [Discuss modes](workflow-discuss-mode.md) — assumptions mode vs interview mode for `/gsd-discuss-phase`
- [Context monitoring](context-monitor.md) — context window monitoring hook architecture
- [Issue-driven orchestration](issue-driven-orchestration.md) — recipe for driving GSD from a tracker issue using existing primitives

---

## Related

- [What's new in 1.7.0](whats-new-1.7.0.md) — curated highlights of the 1.7.0 release
- [Root README](../README.md) — landing page, quickstart, and documentation overview
- [Changelog](../CHANGELOG.md) — release history
