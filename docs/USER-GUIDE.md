# GSD User Guide

A narrative companion guide to GSD Core — orient yourself here, then follow the links into the dedicated docs.

> **GSD Core's documentation is organised by [Diataxis](https://diataxis.fr).**
> Browse by goal: [Tutorials](README.md#tutorials) · [How-to guides](README.md#how-to-guides) · [Reference](README.md#reference) · [Explanation](README.md#explanation) · [Docs index](README.md)

---

## Table of Contents

- [Slash-command forms](#slash-command-forms-hyphen-vs-colon)
- [Namespace routing primer](#namespace-routing-primer-gsd-ns--v140)
- [Project lifecycle overview](#project-lifecycle-overview)
- [Workflow Diagrams](#workflow-diagrams)
- [UI Design Contract](#ui-design-contract)
- [Spiking & Sketching](#spiking--sketching)
- [Backlog & Threads](#backlog--threads)
- [Workstreams & Workspaces](#workstreams--workspaces)
- [Security](#security)
- [Usage Examples](#usage-examples)
- [Troubleshooting](#troubleshooting)
- [Recovery Quick Reference](#recovery-quick-reference)
- [Project File Structure](#project-file-structure)
- [Related](#related)

For driving GSD directly from a GitHub / Linear / Jira issue, see the
[Issue-driven orchestration](issue-driven-orchestration.md) guide — a
recipe that maps tracker issues onto the workspace → discuss → plan →
execute → verify → review → ship loop using existing GSD primitives.

---

## Slash-command form

GSD ships **the same set of skills** to every supported runtime, using the hyphen slash-form spelling:

- **Hyphen form** — `/gsd-command-name` — used by Claude Code, Copilot, OpenCode, Kilo, Cursor, Windsurf, Augment, Antigravity, and Trae.

The installer writes this form into the command directory of each runtime you target.

## Namespace routing primer (`gsd-ns-*`, v1.40+)

### Architecture

GSD ships six **namespace router bundles** (`gsd-ns-workflow`, `gsd-ns-project`, `gsd-ns-review`, `gsd-ns-context`, `gsd-ns-ideate`, `gsd-ns-manage`). On runtimes with non-recursive skill loaders, the installer emits these 6 routers as the **only top-level skill entries**; the ~61 concrete skills are nested under each router at `<router>/skills/<name>/SKILL.md`. This reduces the eager skill-listing overhead to ≈6 entries instead of ≈67.

Each router's body contains a routing table. When the model receives a request, it reads the router, identifies the relevant sub-skill by name, then opens `skills/<name>/SKILL.md` via a file-path `Read`. The concrete skill is fully available — it is not invocable by bare name through the Skill tool's top-level listing, but is reachable through the router.

The nested layout applies only to runtimes with confirmed non-recursive skill loaders: **Cline, Qwen, Hermes, Augment, Trae**. Claude's loader is also non-recursive, but #924 reverted it flat because the Skill tool hard-errors on unknown names rather than re-routing via the router. Antigravity's loader is also non-recursive, but #1614 moved it flat because `agy` scans only `skills/<name>/SKILL.md` — nested sub-skills were unreachable. Other recursive or unconfirmed loaders (Cursor, Codex, Copilot, Windsurf, CodeBuddy, OpenCode, Kilo) retain the flat layout unchanged.

| Namespace | Router bundle | Routes to |
|-----------|--------------|-----------|
| Phase pipeline | `gsd-ns-workflow` | discuss / plan / execute / verify / phase / progress |
| Project lifecycle | `gsd-ns-project` | milestones, audits, summary |
| Quality gates | `gsd-ns-review` | code review, debug, audit, security, eval, ui |
| Codebase intelligence | `gsd-ns-context` | map, graphify, docs, learnings |
| Exploration & capture | `gsd-ns-ideate` | explore, sketch, spike, spec, capture |
| Management | `gsd-ns-manage` | config, workspace, workstreams, thread, update, ship, inbox |

### Slash commands are unaffected

On runtimes that install a commands surface (`commands/gsd`), slash commands such as `/gsd-plan-phase` continue to work directly — the nesting applies only to the Skill tool's top-level listing, not to the commands directory.

### Migration note (breaking change on nesting runtimes)

On the seven nesting runtimes listed above, upgrading to v1.40 changes skill invocation behaviour:

- **Before:** each of the ~67 concrete `gsd-<name>` skills appeared at the top level and was invocable by bare name through the Skill tool.
- **After:** only the 6 `gsd-ns-*` router bundles appear at the top level. Concrete skills are reachable via the router's routing table and a `Read skills/<name>/SKILL.md` call. Direct bare-name invocation of concrete skills through the Skill tool's listing no longer works.
- **Slash commands unchanged:** `/gsd-plan-phase`, `/gsd-discuss-phase`, etc. still work directly where a commands surface is installed.
- **Upgrade prune:** the installer's existing prune step removes the legacy top-level `gsd-<concrete>/` skill directories on upgrade — no manual cleanup is needed.

---

## Project lifecycle overview

The core GSD loop is: **discuss → plan → execute → verify → ship**, repeated per phase. The full step-by-step walkthrough — including example outputs, what files get created, and all the flags in play — is in the dedicated tutorial.

See [Your first project](tutorials/your-first-project.md).

For onboarding an existing codebase before starting a new milestone, run `/gsd-onboard` or see [Onboarding an existing codebase](tutorials/onboarding-an-existing-codebase.md).

**Relevant flags at a glance:**

| Flag | Command | When to use |
| ---- | ------- | ----------- |
| `--auto` | `/gsd-new-project` | Skip interactive questions, ingest from a PRD file |
| `--research` | `/gsd-quick` | Add a research agent to an ad-hoc task |
| `--validate` | `/gsd-quick` | Add plan-checking and post-execution verification |
| `--chain` | `/gsd-discuss-phase` | Auto-chain discuss → plan → execute without stopping |
| `--skip-research` | `/gsd-plan-phase` | Skip research agents when the domain is already familiar |
| `--draft` | `/gsd-ship` | Create a draft PR instead of a ready-for-review one |

For the full command reference with all flags, see [`docs/COMMANDS.md`](COMMANDS.md). For configuration options (model profiles, workflow agents, git branching), see [`docs/CONFIGURATION.md`](CONFIGURATION.md).

---

## Workflow Diagrams

### Full Project Lifecycle

```text
  ┌──────────────────────────────────────────────────┐
  │                   NEW PROJECT                    │
  │  /gsd-new-project                                │
  │  Questions -> Research -> Requirements -> Roadmap│
  └─────────────────────────┬────────────────────────┘
                            │
             ┌──────────────▼─────────────┐
             │      FOR EACH PHASE:       │
             │                            │
             │  ┌────────────────────┐    │
             │  │ /gsd-discuss-phase │    │  <- Lock in preferences
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-ui-phase      │    │  <- Design contract (frontend)
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-plan-phase    │    │  <- Research + Plan + Verify
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-execute-phase │    │  <- Parallel execution
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-verify-work   │    │  <- Manual UAT
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-ship          │    │  <- Create PR (optional)
             │  └──────────┬─────────┘    │
             │             │              │
             │     Next Phase?────────────┘
             │             │ No
             └─────────────┼──────────────┘
                            │
            ┌───────────────▼──────────────┐
            │  /gsd-audit-milestone        │
            │  /gsd-complete-milestone     │
            └───────────────┬──────────────┘
                            │
                   Another milestone?
                       │          │
                      Yes         No -> Done!
                       │
               ┌───────▼──────────────┐
               │  /gsd-new-milestone  │
               └──────────────────────┘
```

### Planning Agent Coordination

```text
  /gsd-plan-phase N
         │
         ├── Phase Researcher (x4 parallel)
         │     ├── Stack researcher
         │     ├── Features researcher
         │     ├── Architecture researcher
         │     └── Pitfalls researcher
         │           │
         │     ┌──────▼──────┐
         │     │ RESEARCH.md │
         │     └──────┬──────┘
         │            │
         │     ┌──────▼──────┐
         │     │   Planner   │  <- Reads PROJECT.md, REQUIREMENTS.md,
         │     │             │     CONTEXT.md, RESEARCH.md
         │     └──────┬──────┘
         │            │
         │     ┌──────▼───────────┐     ┌────────┐
         │     │   Plan Checker   │────>│ PASS?  │
         │     └──────────────────┘     └───┬────┘
         │                                  │
         │                             Yes  │  No
         │                              │   │   │
         │                              │   └───┘  (loop, up to 3x)
         │                              │
         │                        ┌─────▼──────┐
         │                        │ PLAN files │
         │                        └────────────┘
         └── Done
```

### Validation Architecture (Nyquist Layer)

During plan-phase research, GSD maps automated test coverage to each phase requirement before any code is written. The researcher detects your existing test infrastructure, maps each requirement to a specific test command, and identifies any test scaffolding that must be created before implementation begins (Wave 0 tasks). The plan-checker enforces this as an 8th verification dimension: plans where tasks lack automated verify commands will not be approved.

**Output:** `{phase}-VALIDATION.md` — the feedback contract for the phase.

**Disable:** Set `workflow.nyquist_validation: false` in `/gsd-settings` for rapid prototyping phases where test infrastructure isn't the focus.

### Retroactive Validation (`/gsd-validate-phase`)

For phases executed before Nyquist validation existed, or for existing codebases with only traditional test suites, retroactively audit and fill coverage gaps:

```text
  /gsd-validate-phase N
         |
         +-- Detect state (VALIDATION.md exists? SUMMARY.md exists?)
         |
         +-- Discover: scan implementation, map requirements to tests
         |
         +-- Analyze gaps: which requirements lack automated verification?
         |
         +-- Present gap plan for approval
         |
         +-- Spawn auditor: generate tests, run, debug (max 3 attempts)
         |
         +-- Update VALIDATION.md
               |
               +-- COMPLIANT -> all requirements have automated checks
               +-- PARTIAL -> some gaps escalated to manual-only
```

The auditor never modifies implementation code — only test files and VALIDATION.md. If a test reveals an implementation bug, it's flagged as an escalation for you to address.

### Assumptions Discussion Mode

By default, `/gsd-discuss-phase` asks open-ended questions about your implementation preferences. Assumptions mode inverts this: GSD reads your codebase first, surfaces structured assumptions about how it would build the phase, and asks only for corrections.

**Enable:** Set `workflow.discuss_mode` to `'assumptions'` via `/gsd-settings`.

See [docs/workflow-discuss-mode.md](workflow-discuss-mode.md) for the full discuss-mode reference.

### Decision Coverage Gates

The discuss-phase captures implementation decisions in CONTEXT.md under a `<decisions>` block as numbered bullets (`- **D-01:** …`). Two gates ensure those decisions survive into plans and shipped code.

**Plan-phase translation gate (blocking).** After planning, GSD refuses to mark the phase planned until every trackable decision appears in at least one plan's scanned surfaces: front-matter `must_haves`/`truths`/`objective`, a `## must_haves`/`truths`/`tasks`/`objective` heading, or an `<objective>`/`<tasks>`/`<task>`/`<action>`/`<read_first>`/`<behavior>`/`<verify>`/`<acceptance_criteria>`/`<done>` tag body.

**Verify-phase validation gate (non-blocking).** During verification, GSD searches plans, SUMMARY.md, modified files, and recent commit messages for each trackable decision. Misses are logged to VERIFICATION.md as a warning section; verification status is unchanged.

**Opting a decision out.** Move it under the `### Claude's Discretion` heading inside `<decisions>`, or tag it: `- **D-08 [informational]:** …`, `- **D-09 [folded]:** …`, `- **D-10 [deferred]:** …`.

**Disabling the gates.** Set `workflow.context_coverage_gate: false` in `.planning/config.json` (or via `/gsd-settings`). Default is `true`.

### Execution Wave Coordination

```text
  /gsd-execute-phase N
         │
         ├── Analyze plan dependencies
         │
         ├── Wave 1 (independent plans):
         │     ├── Executor A (fresh 200K context) -> commit
         │     └── Executor B (fresh 200K context) -> commit
         │
         ├── Wave 2 (depends on Wave 1):
         │     └── Executor C (fresh 200K context) -> commit
         │
         └── Verifier
               ├── Check codebase against phase goals
               ├── Test quality audit (disabled tests, circular patterns, assertion strength)
               │
               ├── PASS -> VERIFICATION.md (success)
               └── FAIL -> Issues logged for /gsd-verify-work
```

### Isolated-run Recovery (fail-safe)

When a worktree-isolated run is rejected — the user declines to merge it, or the run over-reached the requested scope, or the orchestrator surfaces recovery guidance for a blocked plan — GSD halts safely and offers two options: (a) re-attempt in a fresh, narrowly-scoped worktree, or (b) inspect or discard the rejected worktree without merging. GSD never defaults recovery to editing the primary checkout (`main`). Any path that edits the primary checkout requires explicit, clearly-labeled confirmation from the user first. This behavior is unconditional and applies to both `/gsd-execute-phase` (worktree executor waves) and `/gsd-quick` (quick-mode isolated runs).

---

## UI Design Contract

AI-generated frontends are visually inconsistent not because Claude Code is bad at UI but because no design contract existed before execution. `/gsd-ui-phase` locks the design contract before planning; `/gsd-ui-review` audits the result after execution.

For the full workflow, configuration, shadcn initialisation, and the registry safety gate, see [Design a UI phase](how-to/design-a-ui-phase.md).

**Quick reference:**

| Command              | Description                                              |
| -------------------- | -------------------------------------------------------- |
| `/gsd-ui-phase [N]`  | Generate UI-SPEC.md design contract for a frontend phase |
| `/gsd-ui-review [N]` | Retroactive 6-pillar visual audit of implemented UI      |

| Setting                   | Default | Description                                                 |
| ------------------------- | ------- | ----------------------------------------------------------- |
| `workflow.ui_phase`       | `true`  | Generate UI design contracts for frontend phases            |
| `workflow.ui_safety_gate` | `true`  | plan-phase prompts to run /gsd-ui-phase for frontend phases |

---

## Spiking & Sketching

Use `/gsd-spike` to validate technical feasibility before planning, and `/gsd-sketch` to explore visual direction before designing. Both store artifacts in `.planning/` and integrate with the project-skills system via their wrap-up companions.

For the full workflow and flow diagram, see [Spike and sketch](how-to/spike-and-sketch.md).

**Typical flow:**

```bash
/gsd-spike "SSE vs WebSocket"     # Validate the approach
/gsd-spike --wrap-up              # Package learnings

/gsd-sketch "real-time feed UI"   # Explore the design
/gsd-sketch --wrap-up             # Package decisions

/gsd-discuss-phase N              # Lock in preferences (now informed by spike + sketch)
/gsd-plan-phase N                 # Plan with confidence
```

---

## Backlog & Threads

### Backlog Parking Lot

Ideas that aren't ready for active planning go into the backlog using 999.x numbering, keeping them outside the active phase sequence.

```bash
/gsd-capture --backlog "GraphQL API layer"     # Creates 999.1-graphql-api-layer/
/gsd-capture --backlog "Mobile responsive"     # Creates 999.2-mobile-responsive/
```

Backlog items get full phase directories, so you can use `/gsd-discuss-phase 999.1` to explore an idea further or `/gsd-plan-phase 999.1` when it's ready.

**Review and promote** with `/gsd-review-backlog` — it shows all backlog items and lets you promote (move to active sequence), keep (leave in backlog), or remove (delete).

### Seeds

Seeds are forward-looking ideas with trigger conditions. Unlike backlog items, seeds surface automatically when the right milestone arrives.

```bash
/gsd-capture --seed "Add real-time collab when WebSocket infra is in place"
```

`/gsd-new-milestone` scans all seeds and presents matches. **Storage:** `.planning/seeds/SEED-NNN-slug.md`

Once you've parked a few, audit them on demand instead of waiting for the next milestone to surface them:

```bash
/gsd-capture --list-seeds            # Review every parked seed
/gsd-capture --list-seeds dormant    # Narrow to one status
```

This is read-only — it renders an audit table (ID, status, scope, trigger, title) and a per-status summary, and never modifies a seed. Filter by `dormant`, `active`, or `triggered` when you only want to see seeds in one state.

### Persistent Context Threads

Threads are lightweight cross-session knowledge stores for work that spans multiple sessions but doesn't belong to any specific phase.

```bash
/gsd-thread                              # List all threads
/gsd-thread fix-deploy-key-auth          # Resume existing thread
/gsd-thread "Investigate TCP timeout"    # Create new thread
```

Threads can be promoted to phases (`/gsd-phase`) or backlog items (`/gsd-capture --backlog`) when they mature. **Storage:** `.planning/threads/{slug}.md`

---

## Workstreams & Workspaces

Workstreams and workspaces both provide isolation, but at different levels.

**Workstreams** share the same codebase and git history but isolate planning artifacts — lighter weight, good for working on multiple milestone areas concurrently. See [Work in parallel with workstreams](how-to/work-in-parallel-with-workstreams.md).

**Workspaces** create separate repo worktrees with their own `.planning/` — heavier, for feature-branch or multi-repo isolation. See [Isolate work with workspaces](how-to/isolate-work-with-workspaces.md).

| Command                            | Purpose                                              |
| ---------------------------------- | ---------------------------------------------------- |
| `/gsd-workstreams create <name>`   | Create a new workstream with isolated planning state |
| `/gsd-workstreams switch <name>`   | Switch active context to a different workstream      |
| `/gsd-workstreams list`            | Show all workstreams and which is active             |
| `/gsd-workstreams complete <name>` | Mark a workstream as done and archive its state      |

```bash
# Workspace example — feature branch isolation
/gsd-workspace --new --name feature-b --repos .
cd ~/gsd-workspaces/feature-b
/gsd-new-project

/gsd-workspace --list
/gsd-workspace --remove feature-b
```

---

## Security

### Defense-in-Depth (v1.27)

GSD generates markdown files that become LLM system prompts. This means any user-controlled text flowing into planning artifacts is a potential indirect prompt injection vector. v1.27 introduced centralised security hardening:

**Path Traversal Prevention:** All user-supplied file paths (`--text-file`, `--prd`) are validated to resolve within the project directory. macOS `/var` → `/private/var` symlink resolution is handled.

**Prompt Injection Detection:** The `security.cjs` module scans for known injection patterns in user-supplied text before it enters planning artifacts.

**Runtime Hooks:**

- `gsd-prompt-guard.js` — Scans Write/Edit calls to `.planning/` for injection patterns (always active, advisory-only)
- `gsd-workflow-guard.js` — Warns on file edits outside GSD workflow context (opt-in via `hooks.workflow_guard`)

**CI Scanner:** `prompt-injection-scan.security.test.cjs` scans all agent, workflow, and command files for embedded injection vectors.

---

### Package Legitimacy Gate (v1.42.1)

AI coding tools hallucinate package names. Attackers pre-register those names on npm, PyPI, and crates.io with malicious post-install scripts — a technique called *slopsquatting*. v1.42.1 adds a three-layer gate that stops this before it reaches your shell.

**In RESEARCH.md** — every phase that recommends external packages includes a `## Package Legitimacy Audit` table:

```markdown
## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| express | npm | 13 yrs | 100M+/wk | github.com/expressjs/express | [OK] | Approved |
| some-new-util | npm | 3 days | 47 | none | [SLOP] | REMOVED |
| api-bridge | npm | 6 mo | 1.2k/wk | github.com/user/api-bridge | [SUS] | Flagged |
```

`[SLOP]` packages are removed from RESEARCH.md entirely and never reach the planner.

**In PLAN.md** — `[SUS]` or `[ASSUMED]` packages trigger a `checkpoint:human-verify` task before the install.

**During execution** — if an install fails, the executor surfaces a checkpoint and stops rather than silently trying an alternative.

**Slopcheck verdicts:**

| Verdict | Meaning | GSD action |
|---------|---------|------------|
| `[OK]` | Passes all legitimacy checks | Proceeds — no checkpoint added |
| `[SUS]` | Suspicious signals | Flagged; planner adds `checkpoint:human-verify` |
| `[SLOP]` | High-confidence hallucination | Removed from RESEARCH.md; never reaches planner |

To install slopcheck manually:

```bash
pip install slopcheck
# verify: slopcheck install express --json
```

---

## Code Review Workflow

After executing a phase, run a structured code review before UAT. See [Set up cross-AI review](how-to/set-up-cross-ai-review.md) for the full workflow.

```bash
/gsd-code-review 3               # Review all changed files in phase 3
/gsd-code-review 3 --depth=deep  # Deep cross-file review
/gsd-code-review 3 --fix         # Fix Critical + Warning findings atomically
/gsd-code-review 3 --fix --auto  # Fix and re-review until clean (max 3 iterations)
/gsd-audit-fix                   # Audit + classify + fix (medium+ severity, max 5)
```

The review step slots in after execution and before UAT:

```text
/gsd-execute-phase N  ->  /gsd-code-review N  ->  /gsd-code-review N --fix  ->  /gsd-verify-work N
```

---

## Coverage-Aware UAT Routing

Historically, `/gsd-verify-work` turned every `## Accomplishments` bullet in a SUMMARY into a manual checkpoint — even deliverables already covered one-to-one by a passing unit test. With a green test suite you were still asked to re-confirm things the tests had already proven, every phase.

GSD now lets the executor record, at authoring time, *how each deliverable was verified*. When a SUMMARY.md carries a `coverage:` frontmatter block (see [the `coverage:` block reference](COMMANDS.md#summary-coverage-block)), `/gsd-verify-work` routes deterministically:

- **Auto-passed** — a deliverable marked `human_judgment: false` whose `verification` list is non-empty and entirely `pass` is recorded as passed (`source: automated`) and never prompted.
- **Presented** — everything else is shown to you for sign-off: anything flagged `human_judgment: true` (visual adequacy, multi-device behaviour, subjective quality), anything with no verification, anything not fully passing, and any malformed entry.

The asymmetry is deliberate. The worst outcome is auto-passing something broken that UAT existed to catch, so auto-pass is the narrow, fully-proven case and *uncertainty always routes back to you*. Flipping the flag alone cannot skip a prompt — a passing test reference is also required. SUMMARYs without a `coverage:` block behave exactly as before (prose-based checkpoints), so nothing changes for existing or un-migrated phases.

---

## Command And Configuration Reference

- **Command Reference:** see [`docs/COMMANDS.md`](COMMANDS.md) for every stable command's flags, subcommands, and examples.
- **Configuration Reference:** see [`docs/CONFIGURATION.md`](CONFIGURATION.md) for the full `config.json` schema, model-profile table, git branching strategies, and security settings.
- **Discuss Mode:** see [`docs/workflow-discuss-mode.md`](workflow-discuss-mode.md) for interview vs assumptions mode.

### Graphify capability gate (tri-state, v1.43+)

Graphify commands (`graphify status`, `graphify build`, `graphify query`, `graphify diff`) now respect the **full tri-state capability gate**:

1. **Installed** — the `gsd-graphify-*` skills are present in the active install profile.
2. **Surfaced** — those skills appear on the current runtime surface (e.g., in `~/.claude/commands/gsd/`).
3. **Config-enabled** — `graphify.enabled: true` is set in `.planning/config.json`.

All three conditions must be true. Setting `graphify.enabled: true` alone is no longer sufficient if graphify has not been installed and surfaced. If graphify commands return `{ disabled: true }` after upgrading, verify that the install profile includes graphify skills (`gsd-tools capability state`) and re-run the installer to surface them.

### Intel capability gate (tri-state, v1.44+)

Intel commands (`intel status`, `intel query`, `intel diff`, `intel snapshot`, `intel validate`, `intel api-surface`) now respect the **full tri-state capability gate** (same resolver as graphify above):

1. **Installed** — the intel capability is present in the active install profile (intel has no skill files, so this is vacuously true for all profiles).
2. **Surfaced** — the intel capability is on the current runtime surface (vacuously true for all surfaces since intel registers no skill stems).
3. **Config-enabled** — `intel.enabled: true` is set in `.planning/config.json`.

For intel, conditions 1 and 2 are always satisfied (intel has no skill files). The effective gate is `intel.enabled` in config — the same behaviour as before, but now enforced through the shared `isCapabilityActive('intel', cwd)` resolver rather than a direct config read. This means intel honours the full capability-state pipeline, including any future install-profile or surface restrictions. If intel commands return `{ disabled: true }`, ensure `intel.enabled: true` is set in `.planning/config.json` and verify `gsd-tools capability state` shows intel as active.

---

## Usage Examples

### New Project (Full Cycle)

```bash
claude --dangerously-skip-permissions
/gsd-new-project            # Answer questions, configure, approve roadmap
/clear
/gsd-discuss-phase 1        # Lock in your preferences
/gsd-ui-phase 1             # Design contract (frontend phases)
/gsd-plan-phase 1           # Research + plan + verify
/gsd-execute-phase 1        # Parallel execution
/gsd-verify-work 1          # Manual UAT
/gsd-ship 1                 # Create PR from verified work
/gsd-ui-review 1            # Visual audit (frontend phases)
/clear
/gsd-progress --next                   # Auto-detect and run next step
...
/gsd-audit-milestone        # Check everything shipped
/gsd-complete-milestone     # Archive, tag, done
/gsd-pause-work --report         # Generate session summary
```

### New Project from Existing Document

```bash
/gsd-new-project --auto @prd.md   # Auto-runs research/requirements/roadmap from your doc
/clear
/gsd-discuss-phase 1               # Normal flow from here
```

### Existing Codebase

```bash
/gsd-onboard                # Safely map, ingest docs, and initialize planning
# Follow the printed top-level handoff commands, then rerun /gsd-onboard
# (normal phase workflow from here)
```

`/gsd-onboard` routes through `/gsd-map-codebase`, `/gsd-ingest-docs`, and `/gsd-new-project` without nesting interactive workflows or overwriting existing planning files silently.

**Post-execute drift detection (#2003).** After every `/gsd-execute-phase`, GSD checks whether the phase introduced enough structural change to make `.planning/codebase/STRUCTURE.md` stale. Flip the behavior with:

```bash
/gsd-settings workflow.drift_action auto-remap       # remap automatically
/gsd-settings workflow.drift_threshold 5             # tune sensitivity
```

### Plan Drift Guard

**Default-on.** The plan drift guard (`plan_review.source_grounding: true`) runs during plan review and verifies that every symbol your plans cite — decorators, classes, functions, CLI flags — actually exists in your source tree at review time. This catches hallucinated names before any execution agent runs.

**What it catches:**

- Functions referenced in a PLAN.md step that don't exist in source
- Class or decorator names that were renamed or removed since the plan was written
- CLI flags documented in a plan that are not defined in the argument parser
- Module paths cited in implementation steps that resolve to no files

**Needs-acknowledgement behavior.** When the guard finds a missing symbol, it emits a `needs-acknowledgement` notice in the plan review output rather than hard-blocking. You can acknowledge and proceed (the symbol may be intentionally new) or request a plan revision. The guard does not auto-reject plans — it surfaces signal for human decision.

**Works without intel.** By default the guard uses `grep`/`ripgrep` to search source files — no pre-indexing required. If you have run `/gsd:map-codebase` with `intel.enabled: true`, set `plan_review.source_grounding_authority: intel` to use the faster pre-built `api-map.json` index instead.

```bash
# Enable/disable (default: on)
/gsd-settings plan_review.source_grounding true
/gsd-settings plan_review.source_grounding false

# Switch resolver authority
/gsd-settings plan_review.source_grounding_authority grep   # live grep (default)
/gsd-settings plan_review.source_grounding_authority intel  # pre-indexed api-map.json
```

Toggle at project setup (`/gsd:new-project` asks during workflow preferences) or any time via `/gsd:settings` (Planning section → Drift Guard).

### Quick Bug Fix

```bash
/gsd-quick
> "Fix the login button not responding on mobile Safari"
```

### Resuming After a Break

```bash
/gsd-progress               # See where you left off and what's next
# or
/gsd-resume-work            # Full context restoration from last session
```

### Preparing for Release

```bash
/gsd-audit-milestone        # Check requirements coverage, detect stubs
/gsd-complete-milestone     # Archive, tag, done
```

### Speed vs Quality Presets

| Scenario    | Mode          | Granularity | Profile    | Research | Plan Check | Verifier |
| ----------- | ------------- | ----------- | ---------- | -------- | ---------- | -------- |
| Prototyping | `yolo`        | `coarse`    | `budget`   | off      | off        | off      |
| Normal dev  | `interactive` | `standard`  | `balanced` | on       | on         | on       |
| Production  | `interactive` | `fine`      | `quality`  | on       | on         | on       |

**Skipping discuss-phase in autonomous mode:** When running in `yolo` mode, set `workflow.skip_discuss: true` via `/gsd-settings`.

### Mid-Milestone Scope Changes

```bash
/gsd-phase                  # Append a new phase to the roadmap (default mode)
/gsd-phase --insert 3       # Insert urgent work between phases 3 and 4
/gsd-phase --remove 7       # Descope phase 7 and renumber
/gsd-phase --edit 4         # Edit any field of phase 4 in place
```

---

## Troubleshooting

For a comprehensive troubleshooting guide, see [Recover and troubleshoot](how-to/recover-and-troubleshoot.md). The most common issues are summarised below.

### Programmatic CLI (`gsd-tools query` vs `gsd-tools.cjs`)

For automation, prefer **`gsd-tools query`** with a registered subcommand (see [CLI-TOOLS.md — SDK and programmatic access](CLI-TOOLS.md#sdk-and-programmatic-access) and QUERY-HANDLERS.md). The legacy `node $HOME/.claude/gsd-core/bin/gsd-tools.cjs` CLI remains supported.

### STATE.md Out of Sync

```bash
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state validate          # Detect drift
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state sync --verify     # Preview changes
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state sync              # Reconstruct STATE.md
```

### A Command Looks Frozen After "Spawning..."

GSD subagents run in a separate context window — their work is invisible to the parent session while in progress. Do not interrupt the session. Wait for the result; research and planning agents routinely take 1–5 minutes.

### Context Degradation During Long Sessions

Clear your context window between major commands: `/clear` in Claude Code. GSD is designed around fresh contexts — every subagent gets a clean 200K window. Use `/gsd-resume-work` or `/gsd-progress` to restore state after clearing.

### Plans Seem Wrong or Misaligned

Run `/gsd-discuss-phase [N]` before planning. Most plan quality issues come from Claude making assumptions that `CONTEXT.md` would have prevented.

### Execution Fails or Produces Stubs

Check that the plan was not too ambitious. Plans should have 2–3 tasks maximum. Re-plan with smaller scope.

### Lost Track of Where You Are

Run `/gsd-progress`. It reads all state files and tells you exactly where you are and what to do next.

### Model Costs Too High

Switch to budget profile: `/gsd-config --profile budget`. Disable research and plan-check agents via `/gsd-settings` if the domain is familiar.

### Tuning model cost by phase (`models`) — added in v1.40

Add a `models` block to `.planning/config.json`:

```json
{
  "model_profile": "balanced",
  "models": {
    "planning": "opus",
    "discuss": "opus",
    "research": "sonnet",
    "execution": "opus",
    "verification": "sonnet",
    "completion": "sonnet"
  }
}
```

Need a per-agent exception? Add `model_overrides` alongside — it wins over `models`:

```json
{
  "models": { "research": "sonnet" },
  "model_overrides": {
    "gsd-codebase-mapper": "haiku"
  }
}
```

For the full mapping table and resolution-precedence rules, see [Per-Phase-Type Models](CONFIGURATION.md#per-phase-type-models-models--added-in-v140).

### Cheap-by-default with `dynamic_routing` — added in v1.40

```json
{
  "dynamic_routing": {
    "enabled": true,
    "tier_models": {
      "light":    "haiku",
      "standard": "sonnet",
      "heavy":    "opus"
    },
    "escalate_on_failure": true,
    "max_escalations": 1
  }
}
```

For the full agent → tier mapping, see [Dynamic Routing](CONFIGURATION.md#dynamic-routing-with-failure-tier-escalation-dynamic_routing--added-in-v140).

### Trim MCP servers to reduce per-turn cost

Before tuning `model_profile` or `models.<phase_type>`, audit which **MCP servers** your harness has enabled. Every enabled MCP server injects its tool schema into every turn — heavyweight servers can cost 20k+ tokens each.

This is a **harness setting**, not a GSD setting. The toggle lives in `.claude/settings.json`:

```json
{
  "enabledMcpjsonServers": ["context7"],
  "disabledMcpjsonServers": ["playwright", "mac-tools"]
}
```

Quick audit before a long phase:

- Are any browser / playwright tools enabled when this phase has no UI work?
- Are any platform-specific tools enabled when not needed?
- Are any project-specific MCPs from a different project still enabled here?

Each disabled server removes its schema from every subsequent turn. Trimming MCPs **compounds** with `model_profile` tuning — both levers are additive, and MCP savings show up immediately across every subagent the orchestrator spawns.

For the full audit, harness reference, and the composition note with `model_profile`, see [MCP Tool Schema Cost](../gsd-core/references/context-budget.md#mcp-tool-schema-cost-harness-concern) in the bundled `context-budget.md` reference.

### Using Non-Claude Runtimes (Codex, OpenCode, Antigravity CLI, Kilo)

> **Codex CLI minimum supported version: `0.130.0`** (issue [#3562](https://github.com/open-gsd/gsd-core/issues/3562)).

If you installed GSD for a non-Claude runtime, the installer already configured model resolution. No manual setup is needed — `resolve_model_ids: "omit"` is set automatically, which tells GSD to skip Anthropic model ID resolution and let the runtime choose its own default model.

To assign different models on a non-Claude runtime:

```json
{
  "resolve_model_ids": "omit",
  "model_overrides": {
    "gsd-planner": "o3",
    "gsd-executor": "o4-mini",
    "gsd-debugger": "o3"
  }
}
```

#### Codex skill picker and agent scheduling (#774)

GSD enriches each Codex install with an additional artifact:

- **Flex-tier scheduling** — light-tier agents (haiku-equivalent) emit `service_tier = "flex"` and `model_verbosity = "low"` in their agent TOML. The Codex scheduler routes these agents to the flex tier (lower cost, background processing) and suppresses verbose token output.

GSD skills appear in the Codex `/skills` picker via their `SKILL.md` file, which Codex discovers automatically. No `agents/openai.yaml` sidecar is emitted — doing so caused duplicate autocomplete entries (#1326).

This enrichment is written automatically at install time and requires no manual configuration. Requires Codex CLI ≥ 0.130.0.

#### Switching from Claude to Codex with one config change (#2517)

```json
{
  "runtime": "codex",
  "model_profile": "balanced"
}
```

See [Runtime-Aware Profiles](CONFIGURATION.md#runtime-aware-profiles-2517).

#### Per-runtime command enrichment

When generating artifacts, the installer adapts GSD commands to each runtime's native command schema:

- **Qwen Code** — main-loop skills carry Qwen's numeric `priority` field so the most-used workflows (e.g. `new-project`, `plan-phase`, `execute-phase`) sort first in the `/skills` list; utility skills are left unset. Higher values sort earlier; the field affects only the `/skills` list order.

See [How to install GSD Core on your runtime](how-to/install-on-your-runtime.md) for the full per-runtime details.

### Manual install / no-Node.js setup

If you cannot run the GSD installer, you cannot use the source files in `agents/` directly — they are in Claude Code's native frontmatter format. For OpenCode, two transformations are required:

| Field | GSD source format | OpenCode-valid format | Action |
|---|---|---|---|
| `tools:` | `Read, Bash, Grep` (comma-string) | Not a frontmatter field | Remove the `tools:` line entirely |
| `color:` | Plain CSS color name | Hex or OpenCode semantic name | Convert to hex or remove |

**Alternative:** run the installer on any machine with Node.js:

```bash
npx @opengsd/gsd-core@latest --opencode --global
```

### Installing for Cline

```bash
npx @opengsd/gsd-core --cline --global   # applies to all projects
npx @opengsd/gsd-core --cline --local    # this project only
```

### Installing for CodeBuddy

```bash
npx @opengsd/gsd-core --codebuddy --global
```

GSD installs four surfaces for CodeBuddy: `/gsd-*` slash commands in `~/.codebuddy/commands/`, subagents in `~/.codebuddy/agents/`, model-invocable skills in `~/.codebuddy/skills/`, and `settings.json` hooks. The skills are emitted with `user-invocable: false` so the slash commands are the single `/` menu surface (no duplicate entries).

### Installing for Qwen Code

```bash
npx @opengsd/gsd-core --qwen --global
```

### Installing for Prerelease Editions

Set the runtime's `*_CONFIG_DIR` env var to the prerelease directory before running the installer:

```bash
WINDSURF_CONFIG_DIR=~/.codeium/windsurf-next npx @opengsd/gsd-core@latest --windsurf --global
```

**Env-var reference for supported runtimes:**

| Runtime | Stable default | Override env var |
|---|---|---|
| Claude Code | `~/.claude` | `CLAUDE_CONFIG_DIR` |
| OpenCode | `XDG_CONFIG_HOME/opencode` | `OPENCODE_CONFIG_DIR` |
| Codex | (per Codex CLI) | `--config-dir` flag |
| Copilot | `~/.copilot` | `COPILOT_CONFIG_DIR` (or `COPILOT_HOME`) |
| Cursor | `~/.cursor` | `CURSOR_CONFIG_DIR` |
| Windsurf / Devin Desktop | `~/.codeium/windsurf` | `WINDSURF_CONFIG_DIR` |
| Antigravity | auto-detected | `ANTIGRAVITY_CONFIG_DIR` |
| Augment | `~/.augment` | `AUGMENT_CONFIG_DIR` |
| Trae | `~/.trae` | `TRAE_CONFIG_DIR` |
| Qwen Code | `~/.qwen` | `QWEN_CONFIG_DIR` |
| Kilo | `~/.config/kilo` | `KILO_CONFIG_DIR` |
| CodeBuddy | `~/.codebuddy` | `CODEBUDDY_CONFIG_DIR` |
| Cline | `~/.cline` | `CLINE_CONFIG_DIR` |

### Using Claude Code with Non-Anthropic Providers

Switch to the `inherit` profile: `/gsd-config --profile inherit`. This makes all agents use your current session model.

### Working on a Sensitive/Private Project

Set `commit_docs: false` during `/gsd-new-project` or via `/gsd-settings`. Add `.planning/` to your `.gitignore`.

### GSD Update Overwrote My Local Changes

Which recovery you need depends on whether you *modified a GSD file* or *added your own*:

- **You edited a file GSD ships** (an agent prompt, a workflow). Since v1.17 the installer backs it up to `gsd-local-patches/`. Run `/gsd-update --reapply` to merge your changes back.
- **You added your own file inside a GSD-managed directory** (a custom skill under `skills/`, an extra file in `commands/gsd/`). The installer saves it to `gsd-user-files-backup/`, and the update offers to restore it once the new version is installed. If you declined, or the backup is left over from an older update, restore it any time:

  ```bash
  node <config-dir>/gsd-core/bin/gsd-tools.cjs restore-custom-files --config-dir <config-dir> --apply
  ```

  Run it without `--apply` first to see what would be restored. The backup is never deleted, and the restore skips any file that would overwrite something the new release ships.

### Install or Refresh a Release Candidate

To install or refresh GSD from the `@next` RC dist-tag (the pre-release channel established by ADR #660), run:

```bash
/gsd-update --next
# or equivalently:
/gsd-update --rc
```

The same scope/runtime detection, changelog preview, custom-file backup, and cache clearing apply. Omitting `--next`/`--rc` keeps targeting `@latest` (stable channel, no change). Only the `@latest` and `@next` channels are supported — no arbitrary dist-tag can be passed.

### Cannot Update via npm

See [docs/manual-update.md](manual-update.md) for a step-by-step manual update procedure.

### Workflow Diagnostics (`/gsd-forensics`)

When a workflow fails in a non-obvious way, run `/gsd-forensics` to generate a diagnostic report covering git history anomalies, artifact integrity, and state inconsistencies. Output goes to `.planning/forensics/`.

### Pre-populated Permissions (Claude Code)

Since v1.3.1, the installer pre-populates `~/.claude/settings.json` (or
`settings.local.json` for local installs) with the core permissions GSD needs:

```json
{
  "permissions": {
    "allow": [
      "Bash(npx gsd-core *)",
      "Read(.planning/*)",
      "Edit(.planning/*)",
      "Read(STATE.md)",
      "Edit(STATE.md)"
    ],
    "deny": [
      "Read(.env)",
      "Read(.env.*)",
      "Read(.secrets)"
    ]
  }
}
```

These entries eliminate first-run approval prompts for GSD's own tool calls. The
merge is non-destructive — your existing permissions are preserved and GSD entries
are only appended. Uninstalling GSD removes exactly these entries and preserves
any others.

### Executor Subagent Gets "Permission denied" on Bash Commands

Add the required patterns to `~/.claude/settings.json`. Core patterns needed for all stacks:

```json
"Bash(git add:*)",
"Bash(git commit:*)",
"Bash(git merge:*)",
"Bash(git worktree:*)",
"Bash(git rebase:*)",
"Bash(git reset:*)",
"Bash(git checkout:*)",
"Bash(git switch:*)",
"Bash(git restore:*)",
"Bash(git stash:*)",
"Bash(git rm:*)",
"Bash(git mv:*)",
"Bash(git fetch:*)",
"Bash(git cherry-pick:*)",
"Bash(git apply:*)",
"Bash(gh:*)"
```

**Per-project permissions:** add the same `permissions.allow` block to `.claude/settings.local.json` in your project root instead of `~/.claude/settings.json`.

### Parallel Execution Causes Build Lock Errors

GSD handles this automatically since v1.26. If you're on an older version, add to your project's `CLAUDE.md`:

```markdown
## Git Commit Rules for Agents
All subagent/executor commits MUST use `--no-verify`.
```

To disable parallel execution entirely: `/gsd-settings` → set `parallelization.enabled` to `false`.

---

## Recovery Quick Reference

| Problem                              | Solution                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------ |
| Lost context / new session           | `/gsd-resume-work` or `/gsd-progress`                                    |
| Phase went wrong                     | `git revert` the phase commits, then re-plan                             |
| Need to change scope                 | `/gsd-phase` (default), `/gsd-phase --insert`, or `/gsd-phase --remove`  |
| Something broke                      | `/gsd-debug "description"` (add `--diagnose` for analysis without fixes) |
| STATE.md out of sync                 | `state validate` then `state sync`                                       |
| Workflow state seems corrupted       | `/gsd-forensics`                                                         |
| Quick targeted fix                   | `/gsd-quick`                                                             |
| Plan doesn't match your vision       | `/gsd-discuss-phase [N]` then re-plan                                    |
| Costs running high                   | `/gsd-config --profile budget` and `/gsd-settings` to toggle agents off  |
| Update broke local changes           | `/gsd-update --reapply`                                                  |
| Custom file gone after an update     | `gsd-tools restore-custom-files --config-dir <dir> --apply`              |
| Want session summary for stakeholder | `/gsd-pause-work --report`                                               |
| Don't know what step is next         | `/gsd-progress --next`                                                   |
| Parallel execution build errors      | Update GSD or set `parallelization.enabled: false`                       |

---

## Project File Structure

```text
.planning/
  PROJECT.md              # Project vision and context (always loaded)
  REQUIREMENTS.md         # Scoped v1/v2 requirements with IDs
  ROADMAP.md              # Phase breakdown with status tracking
  STATE.md                # Decisions, blockers, session memory
  config.json             # Workflow configuration
  MILESTONES.md           # Completed milestone archive
  HANDOFF.json            # Structured session handoff (from /gsd-pause-work)
  research/               # Domain research from /gsd-new-project
  reports/                # Session reports (from /gsd-pause-work --report)
  todos/
    pending/              # Captured ideas awaiting work
    completed/             # Completed todos
  debug/                  # Active debug sessions
    resolved/             # Archived debug sessions
  spikes/                 # Feasibility experiments (from /gsd-spike)
    NNN-name/             # Experiment code + README with verdict
    MANIFEST.md           # Index of all spikes
  sketches/               # HTML mockups (from /gsd-sketch)
    NNN-name/             # index.html (2-3 variants) + README
    themes/
      default.css         # Shared CSS variables for all sketches
    MANIFEST.md           # Index of all sketches with winners
  codebase/               # Brownfield codebase mapping (from /gsd-map-codebase or /gsd-onboard)
  onboarding/             # Brownfield onboarding summary (from /gsd-onboard)
  phases/
    XX-phase-name/
      XX-YY-PLAN.md       # Atomic execution plans
      XX-YY-SUMMARY.md    # Execution outcomes and decisions
      CONTEXT.md          # Your implementation preferences
      RESEARCH.md         # Ecosystem research findings
      VERIFICATION.md     # Post-execution verification results
      XX-UI-SPEC.md       # UI design contract (from /gsd-ui-phase)
      XX-UI-REVIEW.md     # Visual audit scores (from /gsd-ui-review)
  ui-reviews/             # Screenshots from /gsd-ui-review (gitignored)
```

---

## Related

- [Docs index](README.md)
- [Commands](COMMANDS.md)
- [Configuration](CONFIGURATION.md)
- [The phase loop](explanation/the-phase-loop.md)
- [Community Capability Registry & EoS Registry](registries/README.md) — discover third-party Capabilities and EoS host integrations
