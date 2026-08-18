# How to interpret install-shadow warnings

**Goal:** Understand the advisory GSD Core prints when a `/gsd-*` trigger is installed at more than one scope and one scope silently wins, tell which scope actually wins, know what to do about it, and tell "nothing to report" apart from "could not look".

**Prerequisites:** GSD Core installed on a Claude Code (or other skills-capable) runtime at more than one scope on the same machine — most commonly `--claude --global` (writes personal skills to `~/.claude/`) followed or preceded by `--claude --local` in a project (writes project commands to `<repo>/.claude/`).

---

## What the warning means

Claude Code resolves a `/gsd-<name>` trigger through two rules, both documented by the host: **personal scope overrides project scope**, and **a skill overrides a command of the same name**. GSD's own Claude artifact layout installs global (personal) as **skills** and local (project) as **commands** — so when both scopes are installed, both rules point the same way, and the global skill wins every time. The project's own `.claude/gsd-core/` spec tree — the workflow and reference files the local command correctly points at — becomes unreachable through the trigger, with no error and no missing file. Nothing in the local install is broken; it is simply never invoked (issue #2218).

The warning is GSD Core's fix for the "with no error" half of that sentence — it does not change which scope wins (see [Known limits](#known-limits)). You will see it in two places, projecting the identical fact:

- **At install time**, printed once after the manifest write completes, whichever scope you install second (design: shadowing can only exist once both scopes exist, and the report is always downstream of a successful `writeManifest`, never upstream of a failed one).
- **From `/gsd-health`**, as diagnostic code **`W028`**, severity `WARNING` — see [Health diagnostic codes](../COMMANDS.md#gsd-health) for where this fits alongside the rest of the `Wnnn`/`Ennn`/`Innn` space. `--json` health output carries the same structured fact.

A realistic install-time warning:

```
2 triggers shadowed: the local commands surface is unreachable through those triggers — global skills wins instead.
  - gsd-execute-phase: local/commands shadowed by global/skills
  - gsd-plan-phase: local/commands shadowed by global/skills
```

For a runtime whose global scope also installs **skills** (12 of the 19 supported runtimes install `skills` at both scopes), the wording is deliberately different, because nothing disappears — the loser is merely overridden, not orphaned:

```
1 trigger shadowed: the local skills entry is overridden by global skills.
```

A report with more than 5 shadowed triggers shows the first 5 and a `...and N more` line rather than every one — the same bounded-sample shape as the installer's existing leaked-path warning.

---

## How to tell which scope is winning

Read the first line of the report. It always names the losing side first (`the <scope> <kind> surface/entry`) and the winning side last (`<scope> <kind> wins instead` / `overridden by <scope> <kind>`). Each subsequent bullet repeats the same fact per trigger: `<trigger>: <shadowed scope>/<shadowed kind> shadowed by <winner scope>/<winner kind>`.

On Claude Code specifically, the winner is always `global/skills` when both scopes are installed — that is the mechanism described above, not a per-machine coin flip. If you need to confirm this for yourself independent of the warning: run `/gsd-<name>` and check which "Base directory for this skill" (or equivalent skill-injection marker) the host reports.

An optional `Note:` line after the trigger list means one scope's own manifest disagrees with the directory it was actually found in (for example, a manifest copied between machines, or an `--config-dir` install). This is surfaced, never silently absorbed — see the trailing `declared runtime "…" does not match this runtime` / `declared scope "…" does not match the probed <scope> scope` text.

---

## What to do about it

The warning never changes the install's exit code — a shadowed install is a warning, not a failure, and the install itself is not broken. Your options, in order of how much they cost:

1. **Do nothing, if the global spec tree is what you want everywhere.** This is a legitimate configuration.
2. **On Claude Code, rely on the built-in resolution described in [Known limits](#known-limits)** — at global scope, the workflow spec `@`-include the winning skill carries is resolved by an explicit, imperative two-step lookup that prefers your project's own `.claude/gsd-core/workflows/<name>.md` over the global one, so the project you are standing in gets its own specs even though the global skill is what's invoked. This is automatic; there is nothing to configure. It applies only to the workflow-spec include — see the limits below for what it does *not* cover.
3. **Uninstall one scope.** If you never intend to use per-project GSD customizations, uninstalling the local scope removes the ambiguity entirely. If you always want project-local behavior, uninstalling the global scope does the same from the other direction.
4. **On a non-Claude, both-scopes-`skills` runtime**, the loser is overridden rather than orphaned, so reordering which install ran last (reinstalling the scope you want to win) resolves it directly — there is no separate spec-tree-reachability problem to reason about on those runtimes.

---

## When nothing is reported: "nothing to report" vs "could not look"

Absence of a shadow warning is not always proof that nothing is shadowed. GSD Core distinguishes two silent outcomes:

**Nothing to report (verified clean)** — the check ran and found no genuine cross-scope collision:

- Only one scope is installed for that runtime.
- Both scopes resolve to the *same* config directory (for example, `--config-dir` pointed both installs at the same place) — this is one physical install, not two.
- The runtime's global scope installs no trigger-bearing artifact kind at all (windsurf's global install is `agents`, which is never invoked by a `/gsd-<name>` trigger) — there is nothing for the local scope to collide with.
- The other scope's manifest exists but declares zero files (an empty or partial install at that scope).

**Could not look (degraded, not verified)** — the check itself could not run, and its silence carries no claim either way:

- The runtime has no installable config directory to probe (`configHome.kind === 'none'`, currently only VS Code) — the resolver this check is built on cannot even ask the question, so it degrades to no report rather than crashing your install or your `/gsd-health` run.
- The other scope's manifest exists on disk but could not be read (a permissions error) — that scope is treated as not-installed for this check, exactly as if it were absent.
- The other scope's manifest is reached through a symlinked config directory or is itself a symlink — the check refuses to follow it and treats that scope as not-installed, the same degraded outcome as an unreadable manifest.

If you are not sure which case applies, re-run `/gsd-health` and read the diagnostic list directly rather than inferring from silence — `/gsd-health --json`'s absence of a `W028` entry combined with a runtime you know is VS Code, or a manifest you know you cannot read, tells you it is the second case, not the first.

---

## Known limits

- **Detection is manifest-based.** If you deleted `gsd-file-manifest.json` at a scope but kept the installed artifacts, that scope is reported as not-installed and cannot shadow (or be shadowed by) anything.
- **The workflow-spec resolution (item 2 above) is instruction-following, not guaranteed inclusion.** A static `@`-include is pre-expanded by the host before the agent ever runs; this resolved reference instead costs the agent one file read, following an explicit instruction. That is a weaker guarantee than a real `@`-include — it is deliberately confined to one reference, in the Claude runtime, at global scope only, which is what keeps that weaker guarantee acceptable rather than something the whole install quietly depends on.
- **It covers only the workflow-spec include.** The winning global skill's `references/` and `templates/` includes still point at the global tree. If you customize only a *reference* file locally (not a workflow), the global copy of that reference is still what loads — you reach your local references only by way of entering the local workflow spec, whose own internal includes are already baked to local-absolute paths.
- **Non-Claude runtimes get detection only, never the spec-root resolution above.** The 12 both-scopes-`skills` runtimes have the same shadowing mechanic but identical artifact kinds on both sides, so no spec tree becomes unreachable the way it does for Claude Code.

---

## Related

- [Install on your runtime](install-on-your-runtime.md) — per-runtime install commands, including the Claude Code coexistence note
- [Host Integration Capability Matrix](../reference/host-integration-capability-matrix.md) — trigger precedence and per-runtime axis reference
- [Interpret scope-conformance warnings](interpret-scope-conformance-warnings.md) — the sibling advisory-warning guide for worktree-wave merges
- [`/gsd-health`](../COMMANDS.md#gsd-health) — command reference, including the diagnostic-code table this warning's `W028` belongs to
- [docs index](../README.md)
