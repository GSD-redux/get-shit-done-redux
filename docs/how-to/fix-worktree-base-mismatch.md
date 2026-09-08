# How to fix the worktree base-mismatch (exit 42) error

**Goal:** Understand why `/gsd-execute-phase` or `/gsd-quick` halts with `FATAL: worktree base mismatch` / exit 42 when your branch is ahead of the default branch, and choose the right fix to restore normal — or parallel — execution.

**Prerequisites:** GSD Core is installed and you have an active project. You have run `/gsd-execute-phase` or `/gsd-quick` and either seen the exit-42 error or the one-line `⚠ Worktree base mismatch` warning.

---

## What you will see

When you run `/gsd-execute-phase` or `/gsd-quick` on a branch that is ahead of the repository's default branch (for example, an unmerged milestone branch, a long-lived feature branch, or a branch with commits not yet in `origin/HEAD`), you may see one of two messages:

**Automatic-degrade warning (phase or quick task still completes):**

```
⚠ Worktree base mismatch: HEAD (abc12345) differs from origin/HEAD (def67890).
Running this phase sequentially on the main working tree. Parallel worktrees
return once HEAD is merged/pushed so origin/HEAD matches it.
(worktree.baseRef:"head" applies where GSD itself creates the worktree, or when
set in the user/global settings layer — the runtime harness does not read it
from project settings; #48, #3659, #4090.)
```

The phase or quick task runs to completion sequentially; nothing is blocked. This is the runtime mitigation (`/gsd-execute-phase`: #683/#1369; `/gsd-quick`: #1941).

**Exit-42 halt (older installs or misconfigured environments):**

```
FATAL: worktree base mismatch
```

All worktree-isolated executors halt immediately. Zero progress is made.

---

## Why this happens

Claude Code's `isolation="worktree"` forks executor worktrees from the repository's default branch (`origin/HEAD`), not from your current `HEAD`. When your branch contains commits that `origin/HEAD` does not have — plan files, new source files, anything added since the branch diverged — those files are absent inside each worktree. GSD's `worktree-branch-check` safety guard correctly refuses to act on a worktree that does not match the orchestrator's state, and exits with code 42.

This is the guard working as designed: it prevents silent data loss or phantom edits in the wrong tree. The error is a branch-state condition, not an OS-specific or hardware issue.

---

## Option 1 — Do nothing (you are already unblocked)

If you saw the `⚠ Worktree base mismatch` warning rather than an exit-42 halt, GSD has already automatically degraded to sequential execution on the main working tree for this run. The phase will complete. No action is required.

Use this option when:

- You are on a diverged branch temporarily
- You do not care about parallel execution for this phase
- You want to merge back to the default branch soon

---

## Option 2 — Where `worktree.baseRef: "head"` actually applies (runtimes where GSD creates the worktrees)

**What this setting can and cannot do (#48, #3659):** on runtimes whose own harness creates isolated
worktrees (Claude Code's `Agent(isolation="worktree")`), the harness forks from the repository
default branch and **does not read project-settings `baseRef`** — verified 5/5 in #48; tracked
upstream at claude-code#44965/#43535. On those runtimes, a **project-settings** `baseRef:"head"` does
**not** restore parallel worktrees on a diverged branch, and since #3659 it no longer silences the
pre-dispatch check: GSD compares `HEAD` against the real fork base and auto-degrades to sequential
execution before dispatch instead of letting every executor die at the exit-42 guard. The
**user/global** layer (`/config`) is different: it is the layer the harness's own worktree creation
reads (#1013), so a `"head"` set there is honored on harness-isolated runtimes too, and since #4090
the pre-dispatch check keeps the layer and treats a user/global `"head"` as honored (reason
`baseref-head`) rather than misreporting it as ignored.

The setting **is** honored where GSD itself runs `git worktree add <path> <start-point>` — the
orchestrator-managed isolation used on runtimes with a headless exec surface (Codex, OpenCode,
Kimi, Kimi Code). There `baseRef:"head"` really does fork from your current `HEAD`, the check
suppresses on it (`reason: "baseref-head"`), and parallel execution works on any branch.

Run the convenience command from your project root:

```bash
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" worktree set-baseref
```

This writes `worktree.baseRef: "head"` into `.claude/settings.local.json` in your project root. It is no-clobber: if you already have an explicit `baseRef` set to something else, it leaves your value in place and tells you.

To verify the result on a harness-isolated runtime (Claude Code, Cursor), pass the dispatch mode so
the check evaluates the base the harness will actually use:

```bash
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" worktree base-check --mode harness-worktree
```

The output is JSON. On a diverged branch expect `shouldDegrade: true` with
`reason: "baseref-head-ignored-by-harness"` — GSD will run the phase sequentially; parallel
worktrees return once `HEAD` is merged/pushed so `origin/HEAD` matches it. On a GSD-managed runtime,
`--mode orchestrator-worktree` returns `shouldDegrade: false` with `reason: "baseref-head"` and
parallel worktrees work on any branch.

Alternatively, set the value by hand in `.claude/settings.local.json`:

```json
{
  "worktree": {
    "baseRef": "head"
  }
}
```

**Note:** Fresh installs and upgrades of GSD Core both set `worktree.baseRef:"head"` automatically in `.claude/settings.local.json` (no-clobber) when `workflow.use_worktrees` is enabled (the default). This remains useful for GSD-managed runtimes and harmless elsewhere — post-#3659 it never silences the check on harness-managed ones.

Use this option when:

- Your runtime uses GSD-managed worktrees (Codex, OpenCode, Kimi, Kimi Code) and you regularly work on long-lived or milestone branches
- You want parallel phase execution there (faster, lower context-window pressure)

---

## Option 3 — Fallback: disable worktrees entirely

If worktrees are causing persistent problems beyond the base-mismatch (for example, your environment does not support them), disable them permanently for this project:

Add or edit `.planning/config.json`:

```json
{
  "workflow": {
    "use_worktrees": false
  }
}
```

All executor agents will then run sequentially on the main working tree for every phase. This is equivalent to what the automatic degrade does, but permanent.

Use this option when:

- Worktrees are consistently problematic in your environment
- You prefer sequential execution for auditability or tooling reasons
- You are on a platform or CI setup that does not support git worktrees

See also: [`workflow.use_worktrees`](../CONFIGURATION.md#workflow-toggles) in the configuration reference.

---

## The exit-42 backstop

The `worktree-branch-check` guard (exit 42) remains active in all execution modes as a safety backstop. It fires only when an executor worktree's branch does not match the expected orchestrator state — a condition that should not arise once you have applied one of the options above. If you continue to see exit 42 after setting `worktree.baseRef: "head"`, run `/gsd-forensics` to investigate.

---

## Summary

| Situation | Recommended action |
|-----------|-------------------|
| Saw the warning, phase completed | Nothing — degrade handled it automatically |
| Regularly on diverged branches, want parallel execution | `worktree set-baseref` (Option 2) |
| Worktrees consistently problematic | Set `workflow.use_worktrees: false` (Option 3) |
| Still seeing exit 42 after fixes | Run `/gsd-forensics "exit 42 after fix"` |

---

## Related

- [Recover and troubleshoot](recover-and-troubleshoot.md)
- [Debug a failed execution](debug-a-failed-execution.md)
- [Configuration reference — workflow toggles](../CONFIGURATION.md#workflow-toggles)
- [CLI Tools reference — worktree commands](../CLI-TOOLS.md#worktree-commands)
- [docs index](../README.md)
