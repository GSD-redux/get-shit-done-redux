# How to run phases autonomously

Run all remaining phases — or a bounded range of them — unattended, so GSD moves through discuss → plan → execute for each phase without you driving every step.

For background on what the phase loop is doing during an autonomous run, see [The phase loop](../explanation/the-phase-loop.md).

---

## Prerequisites

- An active project with `.planning/ROADMAP.md` and `.planning/STATE.md`
- All phases you want to run must be in a state that autonomous mode can drive (pending or in-progress; not already complete)
- Any design decisions you care about should already be in `PROJECT.md` or captured via a prior `/gsd-discuss-phase` — autonomous mode can surface grey areas interactively only when you use `--interactive`

---

## Run all remaining phases

```bash
/gsd-autonomous
```

GSD reads `ROADMAP.md`, discovers every incomplete phase in numeric order, and runs discuss → plan → execute on each one. After all phases complete it automatically runs the milestone lifecycle: audit → complete → cleanup.

---

## Run a specific range of phases

Use `--from` and `--to` to bound the run. Both flags accept decimal phase numbers (e.g. `3.1`).

```bash
/gsd-autonomous --from 3          # phases 3, 4, 5 … (skip already-done phases 1 and 2)
/gsd-autonomous --to 5            # phases up to and including 5
/gsd-autonomous --from 3 --to 5   # exactly phases 3, 4, and 5
```

When `--to` is reached the lifecycle step is skipped, because not all milestone phases are done. The completion banner tells you how to resume:

```text
Resume with: /gsd-autonomous --from 6
```

---

## Run a single phase

To run exactly one phase without triggering the milestone lifecycle, use `--only N`:

```bash
/gsd-autonomous --only 4
```

If the phase is already complete, autonomous mode exits immediately with a message rather than re-running it.

---

## Run with plan convergence

Use `--converge` when you want each phase to run the plan-review convergence loop before execution. Both `/gsd-autonomous` and `/gsd-progress --next --auto` support this flag.

```bash
gsd config-set workflow.plan_review_convergence true

# Via autonomous (multi-phase or single-phase):
/gsd-autonomous --only 4 --converge
/gsd-autonomous --from 3 --to 5 --converge --all --max-cycles 5

# Via progress --next --auto (step-chaining with convergence):
/gsd-progress --next --auto --converge
/gsd-progress --next --auto --converge --codex --max-cycles 4
```

`--cross-ai` is accepted as an alias for `--converge`. Reviewer flags supported by `/gsd-plan-review-convergence` pass through unchanged, including `--codex`, `--gemini`, `--agy` (`--antigravity`), `--claude`, `--opencode`, `--cursor`, `--qwen`, `--ollama`, `--lm-studio`, `--llama-cpp`, `--all`, and `--max-cycles N`.

If `workflow.plan_review_convergence` is not enabled, the command stops before planning and prints the enable command instead of silently falling back to regular planning.

---

## Run with interactive discuss

By default, autonomous mode answers discuss questions automatically using smart discuss (batch table proposals). If you want to answer design questions yourself while keeping plan and execute out of the main context:

```bash
/gsd-autonomous --interactive
```

In interactive mode:
- `/gsd-discuss-phase` runs inline and waits for your answers
- On runtimes that support nested background dispatch, planning and execution are dispatched as background agents so you can discuss the next phase while the current one builds; on Claude Code, planning and execution run inline (the next phase's discuss does not overlap)
- The main context stays lean — only discuss conversations accumulate (on runtimes with background dispatch; on Claude Code, inline plan/execute also accumulate)

---

## Run on a non-Claude runtime

To run autonomously on a runtime that does not support the `AskUserQuestion` tool (for example Codex CLI or Gemini CLI), add `--text`:

```bash
/gsd-autonomous --text
/gsd-autonomous --from 3 --text
```

All interactive prompts become plain numbered lists; type the choice number to respond. When combined with `--converge`, `--text` is also forwarded to the convergence loop via `CONVERGENCE_ARGS` so reviewer prompts inside plan-review convergence use the same plain-text mode.

---

## What safety gates still apply

Autonomous mode does not bypass GSD's quality pipeline. Each phase still:

- Runs the plan-checker before execution
- Reads `VERIFICATION.md` after execution and routes on the result
- Pauses and asks you what to do when verification status is `human_needed` or `gaps_found`
- Stops and presents options (fix and retry, skip phase, or stop) if any step fails

The only difference from manual execution is that `passed` verification advances automatically — you are not prompted between phases unless a decision is required.

The package legitimacy gate also remains active. If a plan includes a `checkpoint:human-verify` task for a suspicious package, the executor will stop and surface the checkpoint. Autonomous mode will not silently install flagged packages.

---

## When not to use autonomous mode

Do not use `/gsd-autonomous` when:

- **Phases have unsettled design decisions.** If you have not run `/gsd-discuss-phase` and your `PROJECT.md` does not capture your preferences, smart discuss will make autonomous choices you may not agree with. Run discuss interactively first, or use `--interactive`.

- **You need fine-grained control over a single phase.** For one phase, `/gsd-execute-phase N` gives you step-by-step output and lets you react before continuing. Use `--only N` if you want the autonomous quality pipeline on a single phase but do not need step-by-step interaction.

- **The phase has novel or high-risk work.** Autonomous mode skips pauses unless it hits a blocker. On a phase where you expect surprises, stay in the loop with manual execution.

- **You are mid-phase with partial execution.** Autonomous mode picks up incomplete phases but it does not resume a partially-executed wave. Use `/gsd-execute-phase N` to finish a phase that is already in progress.

If a run stops partway through, see [Debug a failed execution](debug-a-failed-execution.md) for how to diagnose what went wrong.

---

## Checking progress during a run

Autonomous mode prints a progress banner before each phase:

```text
 GSD ► AUTONOMOUS ▸ Phase 3/7: Auth Middleware [████░░░░] 28%
```

If you need to check where the run stands mid-session, open another terminal and run:

```bash
/gsd-progress
```

---

## Resuming after a stop

If autonomous mode stops — whether you chose "Stop autonomous mode" from the blocker prompt, or the session was interrupted — resume from where it left off:

```bash
/gsd-autonomous --from 4     # replace 4 with the first incomplete phase number
```

GSD skips already-complete phases automatically, so it is safe to re-run from an earlier phase number if you are not sure where the run stopped.

If a prior run recorded a `Deferred Verification` entry in `STATE.md`, later `/gsd-autonomous` reruns skip that phase instead of re-entering the same deferral prompt. Resume deferred work with the exact command shown in the table:

```bash
/gsd:verify-work 4          # for verification_deferred_human
/gsd:plan-phase 6 --gaps   # for verification_deferred_gaps
```

---

## Related

- [Execute a phase](execute-a-phase.md)
- [Debug a failed execution](debug-a-failed-execution.md)
- [Commands](../COMMANDS.md)
- [Docs index](../README.md)
