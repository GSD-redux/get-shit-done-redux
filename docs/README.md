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
- [Install a minimal GSD and add skills later](how-to/install-minimal-and-add-skills.md) — install only the core skills, then grow the surface with profiles and `/gsd-surface`
- [Attach a plugin-provided skill to a GSD agent](how-to/attach-a-plugin-skill-to-a-gsd-agent.md) — use the `global:plugin:skill` entry form to load Claude Code plugin skills into agent prompts
- [Discuss a phase](how-to/discuss-a-phase.md) — capture implementation decisions before planning begins
- [Resolve edge-coverage findings](how-to/resolve-edge-coverage-findings.md) — turn the spec phase's surfaced domain-boundary edges into covered, dismissed, or backstopped spec decisions
- [Probe edges in a non-English project](how-to/probe-edges-in-a-non-english-project.md) — get real edge coverage on a spec written in another language, and tell "no edges here" apart from "the probe could not read it"
- [Resolve prohibition findings](how-to/resolve-prohibition-findings.md) — turn the spec phase's surfaced must-NOT constraints into resolved, dismissed, or deferred spec decisions
- [Resolve an unreachable-workflow finding](how-to/resolve-unreachable-workflow-findings.md) — wire or fully sweep a shipped workflow that no command, agent, or skill references
- [Acknowledge emitted-artifact drift](how-to/acknowledge-emitted-drift.md) — declare a deliberate emitted-byte ripple or workflow/agent growth in a commit trailer, and migrate an older ack fragment
- [Change the STATE.md schema](how-to/change-the-state-md-schema.md) — add, change or remove a STATE.md frontmatter key and keep the template and all five reference documents in step
- [Resolve verify-command path findings](how-to/resolve-verify-command-path-findings.md) — fix an `<automated>` verify command whose target directory does not resolve from the executor's cwd
- [State a failing direction](how-to/state-a-failing-direction.md) — say what output constitutes failure for an `<automated>` verify command, and migrate a phase planned before the rule
- [Resolve a contract-drift finding](how-to/resolve-contract-drift-findings.md) — bring an agent's completion contract, read-tag gate, or deleted-file test reference back into agreement with the registry
- [Resolve unreachable-guard findings](how-to/resolve-unreachable-guard-findings.md) — fix shell guards whose fallback arm cannot run, and tell "nothing to report" apart from "could not look"
- [Declare a hook's crash policy](how-to/declare-a-hook-crash-policy.md) — terminate a GSD hook with `allow`/`deny`/`crash`, declare its `ON_CRASH` policy, and tell a hook's own crash apart from a check that could not run at all
- [Resolve a skipped capability probe](how-to/resolve-a-skipped-capability-probe.md) — act on a coverage gate that held your phase for an unestablished scope, or a planning checkpoint that reported `skipped` instead of a verdict
- [Diagnose which gsd-tools is running](how-to/diagnose-a-foreign-gsd-tools.md) — tell this package's tool apart from the predecessor's colliding binary and from a gsd-core too old to identify itself
- [Resolve an ESLint glob-coverage finding](how-to/resolve-eslint-coverage-findings.md) — bring a source file that matches no lint rule under coverage, or record a reasoned exemption
- [Resolve a raw-terminator finding](how-to/resolve-a-raw-terminator-finding.md) — pick `runMain`/`ExitError`, `terminateNow`, or `process.exitCode` for a `local/require-registered-exit` finding, and know the two allowlist entries and the rule's documented evasions
- [Adopt the v2 exit contract](how-to/adopt-the-v2-exit-contract.md) — turn on `gsd-tools`'s versioned exit-code projection, read the code table including what `80` (`DEGRADED`) means, and migrate a CI gate that treats any non-zero exit as fatal
- [Read the statusline freshness marker](how-to/read-the-statusline-freshness-marker.md) — turn on `state ~N commits back`, and tell "STATE.md is fresh" apart from "freshness could not be established"
- [Consume the planning snapshot](how-to/consume-the-planning-snapshot.md) — read `planning inspect` from a dashboard or harness, and tell "nothing to report" apart from "could not look"
- [Read CI timeout budget signals](how-to/read-ci-timeout-signals.md) — find the near-cap warning on a run, read the accumulated `tests/ci-timeout-budget-history.jsonl` trend, and know which lever (cap, shard balance, shard-1 contents) a repeatedly-near-cap lane calls for
- [Consume the state contract](how-to/consume-the-state-contract.md) — read `.planning/state.json` from a workbench or editor extension, gate on the contract version, and tell "nothing to show" apart from "could not look"
- [Keep planning docs out of a shared repo](how-to/keep-planning-docs-private.md) — make `.planning/` local-only, including untracking files git already tracks (the step `.gitignore` alone cannot do)
- [Publish PRs without planning artifacts](how-to/publish-prs-without-planning-artifacts.md) — keep `.planning/` committed locally, so worktrees and `/gsd-undo` keep working, while `planning.pr_strict` keeps every planning path out of the branch you push
- [Plan a phase](how-to/plan-a-phase.md) — run research, decompose work, and verify plan quality
- [Verify a dependency-compatibility claim](how-to/verify-a-dependency-compatibility-claim.md) — act on a compatibility claim the researcher left `[ASSUMED]`, and tell "nothing declared" apart from "a constraint is declared" and "the lookup failed"
- [Execute a phase](how-to/execute-a-phase.md) — run plans in parallel waves with fresh-context subagents
- [Enable parallel reviewer lanes](how-to/enable-parallel-reviewer-lanes.md) — cut a multi-reviewer `/gsd-review` pass toward its slowest lane, and tell a rate-limited lane apart from one that was never selected
- [Enable concurrent per-plan planners in chunked mode](how-to/enable-concurrent-chunked-planning.md) — dispatch chunked `/gsd-plan-phase`'s per-plan Tasks together within one outline Wave instead of one at a time, and know when the setting has no effect
- [Verify and ship](how-to/verify-and-ship.md) — walk through completed work, diagnose failures, and create the PR
- [Catch complexity before it compounds](how-to/act-on-a-refactor-proposal.md) — enable the post-execute refactor hook, read a proposal's score vs. anchor delta, and accept or decline it
- [Run phases autonomously](how-to/run-phases-autonomously.md) — use autonomous mode for unattended phase execution
- [Handle quick and fast tasks](how-to/handle-quick-and-fast-tasks.md) — use `/gsd-quick` and `/gsd-fast` for ad-hoc work outside the phase loop
- [Batch quick tasks](how-to/batch-quick-tasks.md) — run several `/gsd-quick`-shaped tasks together with `/gsd-quick-batch`, understand capacity/isolation, and recover a failed or interrupted batch
- [Configure model profiles](how-to/configure-model-profiles.md) — switch between quality, balanced, and budget model tiers
- [Control which host runtime GSD reports](how-to/control-the-reported-host-runtime.md) — read the `agent_runtime` ladder, understand what host detection looks at, and pin the runtime when detection is not what you want
- [Set up cross-AI review](how-to/set-up-cross-ai-review.md) — configure a second AI to review code produced by the primary agent
- [Scope code review depth by path](how-to/scope-code-review-depth-by-path.md) — escalate `/gsd-code-review` to `deep` for sensitive directories while the rest of the repo stays at the default depth
- [Work in parallel with workstreams](how-to/work-in-parallel-with-workstreams.md) — run independent lines of work simultaneously using workstreams
- [Isolate work with workspaces](how-to/isolate-work-with-workspaces.md) — use workspaces to sandbox experimental or risky changes
- [Debug a failed execution](how-to/debug-a-failed-execution.md) — diagnose and recover from broken or incomplete phase execution
- [Interpret scope-conformance warnings](how-to/interpret-scope-conformance-warnings.md) — read the advisory the worktree-wave merge emits when a plan branch commits outside its declared scope
- [Interpret install-shadow warnings](how-to/interpret-install-shadow-warnings.md) — read the advisory GSD Core emits when a `/gsd-*` trigger is installed at both scopes and one silently wins, and tell "nothing to report" apart from "could not look"
- [Interpret `state validate` results](how-to/interpret-state-validate-results.md) — read the `scope` reason codes and tell "nothing to report" apart from "could not look"
- [Spike and sketch](how-to/spike-and-sketch.md) — use `/gsd-spike` and `/gsd-sketch` for exploratory work before committing to a plan
- [Design a UI phase](how-to/design-a-ui-phase.md) — use the UI phase loop for frontend and visual work
- [Enable live-DOM verification](how-to/enable-live-dom-verification.md) — opt a project into browser-backed UI acceptance checks during execution, handle the browser-profile lock, and tell "nothing to report" apart from "could not look"
- [Develop a Capability for GSD 1.5+](how-to/develop-a-capability.md) — add feature Capabilities, hook fragments, and registry entries
- [Develop a task-content resolver capability](how-to/develop-a-task-content-resolver-capability.md) — declare a `taskContentResolver` so `execute-plan.md` resolves per-task content from your external issue tracker instead of `PLAN.md`
- [Ship a reviewer lane in your capability](how-to/ship-a-reviewer-lane.md) — declare a `reviewer` body so `/gsd-review` discovers, invokes, and renders your external review CLI or model endpoint
- [List your reviewer lane in the registry](how-to/list-your-reviewer-lane.md) — publish a lane you have built to the Reviewer Lane Registry so other people can find and install it
- [Take over a capability or EoS integration](how-to/take-over-a-capability-or-eos.md) — assume maintainership of an existing third-party capability, reviewer lane, or EoS host integration through a handoff, an adoption fork, first-party absorption, or a de-listing
- [Add or update a host's integration](how-to/add-or-update-a-host-integration.md) — set a host's documentation-sourced `runtime.hostIntegration` axes (ADR-1239 Phase A), with the `undocumented` sentinel rule
- [Migrate an install test to the executed plan](how-to/migrate-an-install-test-to-the-executed-plan.md) — convert an `fs.existsSync`-probing install test group to a value assertion against `installRuntimeArtifacts`'s executed-plan return, and test against a fake fs adapter
- [Vendor a dependency](how-to/vendor-a-dependency.md) — add a third-party package `gsd-core/bin/**` needs at runtime as a verbatim vendored artifact, keep it out of `dependencies`, and pick the right upstream bundle
- [Turn a capability off (and keep it off)](how-to/turn-a-capability-off.md) — disable a capability via the surface, or gate individual hooks off without removing the capability
- [Drive GSD from a tracker issue](how-to/drive-gsd-from-a-tracker-issue.md) — start a phase from a GitHub, Linear, or Jira issue
- [Migrate from GSD 2](how-to/migrate-from-gsd-2.md) — upgrade an existing GSD 2 project to GSD Core
- [Update GSD](how-to/update-gsd.md) — re-run the installer to pick up the latest release
- [Clean up get-shit-done-cc](cleanup-get-shit-done-cc.md) — remove leftover old-package artifacts that cause a spurious `⬆ /gsd-update` indicator after migrating to `@opengsd/gsd-core`
- [Fix the worktree base-mismatch (exit 42) error](how-to/fix-worktree-base-mismatch.md) — resolve the branch-divergence condition that halts parallel phase execution
- [Recover and troubleshoot](how-to/recover-and-troubleshoot.md) — fix common problems, rebuild context, and uninstall

---

## Reference

- [Commands](COMMANDS.md) — every command with flags and examples
- [Configuration](CONFIGURATION.md) — full config schema, model profiles, git branching strategies
- [CLI tools](CLI-TOOLS.md) — `gsd-tools.cjs` programmatic API for workflows and agents
- [JSON error mode](json-errors.md) — `gsd-tools` failure channels: faults (stderr, exit 1) vs degraded results (stdout, exit 0), and the reason-code taxonomy
- [Features](FEATURES.md) — complete feature index
- [Inventory](INVENTORY.md) — installed skills and surface map
- [STATE.md schema](reference/state-md.md) — field-by-field reference for `.planning/STATE.md`
- [CONTEXT.md schema](reference/context-md.md) — field-by-field reference for `.planning/phases/<N>/CONTEXT.md`
- [PLAN.md schema](reference/plan-md.md) — field-by-field reference for `.planning/phases/<N>/PLAN.md`
- [Planning artifacts](reference/planning-artifacts.md) — all `.planning/` files and their roles
- [Review and verification capabilities](reference/review-verification-capabilities.md) — code review, security, and Nyquist capability ownership and hook contracts
- [Gate predicates](reference/gate-predicates.md) — canonical specification of the phase-gate predicate vocabulary
- [Capability matrix](reference/capability-matrix.md) — generated catalogue of every capability's role, tier, extension points, hook kinds, and `engines.gsd`
- [Exit code reference](reference/exit-codes.md) — generated catalogue of every registered process exit code, its name, meaning, and owning module, plus the reserved bands and the v1/v2 exit contract
- [Capability manifest](reference/capability-manifest.md) — the full `capability.json` schema and validation rules
- [`gsd capability` command](reference/gsd-capability-command.md) — install / update / remove / list reference for third-party capabilities
- [Workflow fragments](reference/workflow-fragments.md) — in-file `<!-- gsd:section -->` marker grammar for fragmentizing workflow markdown at emission time
- [Partition rules for compact-content splits](PARTITION-RULES.md) — the protected-content list, sentinel syntax, and the five CI checks a `workflow.compact_content` spine/detail split must obey
- [Reviewer Lane Registry](registries/reviewer-registry.md) — generated catalogue of third-party reviewer lanes, with their flags, transport, and install commands

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
