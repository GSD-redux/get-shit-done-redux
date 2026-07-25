# How to debug a failed execution

**Goal:** Recover when a phase execution fails, stalls, or produces incomplete work — and resume cleanly without losing progress or repeating work that already succeeded.

**Prerequisites:** You have run `/gsd-execute-phase N` and the execution stopped before writing `VERIFICATION.md`, or you see unexpected output, missing files, or a stalled spinner.

---

## Detect whether the execution stalled or failed

Before taking any recovery action, determine what actually happened.

### If you see "Spawning…" with no output after 1–5 minutes

This is normal, not a freeze. GSD subagents run in an isolated context window. The liveness note on the spawn line confirms this. Do not interrupt the session.

If it has been more than 10 minutes with no result, check the Claude Code sidebar. If the agent task shows as completed but no output appeared, the result may have been lost in a context switch — re-run the same command:

```bash
/gsd-execute-phase 1
```

GSD checks for `SUMMARY.md` files before dispatching executors. Plans that already have one are skipped automatically.

### If execution stopped mid-wave with an error message

Check git history to see which plans committed successfully:

```bash
git log --oneline -20
```

Plans that committed their work will have an entry such as `feat(01-02): …`. Plans without a commit are incomplete and will be re-executed when you re-run.

### If the executor committed code but did not write SUMMARY.md

GSD detects this at the next run and surfaces a safe-resume gate with three options:

- **Close out manually** — inspect the commits yourself, write `SUMMARY.md`, then re-run.
- **Re-execute from scratch** — revert or supersede the partial commits before dispatching a new executor.
- **Mark-and-skip** — record the anomaly and continue, only with your explicit confirmation.

---

## Diagnose the root cause

### Run `/gsd-debug --diagnose`

If execution produced wrong output, stubbed code, or a verification failure, use the diagnosis-only mode to investigate without applying any fixes:

```bash
/gsd-debug --diagnose "Phase 2 executor produced stubs instead of real code"
```

`--diagnose` stops at root cause without touching your files. It creates a session file at `.planning/debug/<slug>.md` so you can pick up the investigation later if needed.

To start a full debug session that also applies a fix:

```bash
/gsd-debug "Login middleware not handling 401 correctly after phase 3"
```

GSD gathers symptoms, runs a structured investigation using the scientific method, and proposes a fix. If `tdd_mode: true` is set in your config, it requires a failing test before applying any fix.

### Check active debug sessions

```bash
/gsd-debug list
```

Shows all open sessions with their current hypothesis and next action. To resume a specific session:

```bash
/gsd-debug continue <slug>
```

---

## Run a post-mortem with `/gsd-forensics`

If the cause is not clear from the error output — for example, plans reference nonexistent files, execution produced unexpected results, or state seems corrupted — run a forensic investigation:

```bash
/gsd-forensics "Phase 3 execution stalled after wave 1"
```

GSD analyses git history, `.planning/` artifact completeness, STATE.md consistency, uncommitted work, and orphaned worktrees. It writes a structured report to `.planning/forensics/report-<timestamp>.md` and surfaces recommended remediation steps.

`/gsd-forensics` is read-only — it never modifies your project files.

**What it detects:**

- **Stuck loop** — the same file appears in three or more consecutive commits within a short time window (HIGH confidence if commit messages are similar)
- **Missing artefacts** — a phase has commits but no `SUMMARY.md` or `VERIFICATION.md`
- **Abandoned work** — uncommitted changes with STATE.md showing mid-execution and the last commit more than two hours old
- **Crash or interruption** — uncommitted changes combined with an active execution state and orphaned worktrees
- **Scope drift** — recent commits touch files outside the current phase's expected file set

---

## Resume execution after recovery

Once the underlying issue is resolved, re-run the execute command:

```bash
/gsd-execute-phase 1
```

GSD skips plans whose `SUMMARY.md` already exists and dispatches executors only for the remaining plans.

If you need to re-execute only a specific wave:

```bash
/gsd-execute-phase 1 --wave 2
```

---

## Roll back with `/gsd-undo`

If execution produced code you want to discard entirely, roll back using the plan manifest rather than manual `git revert`:

### Roll back a single plan

```bash
/gsd-undo --plan 03-02
```

Reverts all commits for plan `02` of phase `3`. GSD shows a confirmation gate before writing any change.

### Roll back an entire phase

```bash
/gsd-undo --phase 03
```

Reverts all commits for phase `3`. GSD checks whether any subsequent phases depend on this phase and warns you before proceeding.

### Pick interactively from recent commits

```bash
/gsd-undo --last 5
```

Shows the five most recent GSD commits and lets you select which to revert.

---

## Restore session context after a break

If you have returned to the project after a context reset or a new session:

```bash
/gsd-resume-work
```

Restores your full session context from the last handoff, including the current phase, blockers, and where execution stopped.

Alternatively, to see your current position and auto-advance to the correct next step:

```bash
/gsd-progress --next
```

---

## Related

- [Execute a phase](execute-a-phase.md)
- [Recover and troubleshoot](recover-and-troubleshoot.md)
- [Commands](../COMMANDS.md)
- [docs index](../README.md)
