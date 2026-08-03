# How to work on multiple areas in parallel with workstreams

**Goal:** Run concurrent work on different milestone areas — backend API, frontend dashboard, infrastructure, or any other concern — without planning state from one area bleeding into another.

**Prerequisites:** An active GSD Core project (`.planning/ROADMAP.md` exists). If not, run `/gsd-new-project` first.

---

## What workstreams are

A workstream is an isolated planning context within a single codebase. Each workstream gets its own `.planning/workstreams/<name>/` subtree containing independent `STATE.md`, `ROADMAP.md`, `REQUIREMENTS.md`, and `phases/` directories. The codebase itself — source code, git history, and branches — is shared across all workstreams.

```
.planning/
├── PROJECT.md          ← shared
├── config.json         ← shared
├── codebase/           ← shared
└── workstreams/
    ├── backend-api/
    │   ├── STATE.md
    │   ├── ROADMAP.md
    │   ├── REQUIREMENTS.md
    │   └── phases/
    └── frontend-dash/
        ├── STATE.md
        ├── ROADMAP.md
        ├── REQUIREMENTS.md
        └── phases/
```

When a workstream is active, every GSD command — `/gsd-progress`, `/gsd-discuss-phase`, `/gsd-plan-phase`, `/gsd-execute-phase` — reads from and writes to that workstream's directory. Switching workstreams redirects all of those commands to a different subtree without touching the source tree.

---

## Create a workstream

```bash
/gsd-workstreams create backend-api
```

GSD creates the workstream directory under `.planning/workstreams/backend-api/` and seeds it with a skeleton `STATE.md` and `ROADMAP.md`. The workstream is not automatically activated — you switch to it explicitly.

---

## List workstreams

```bash
/gsd-workstreams list
```

Shows all workstreams and which one is currently active in your session.

---

## Switch to a workstream

```bash
/gsd-workstreams switch backend-api
```

From this point forward, all GSD workflow commands operate in the `backend-api` context. The switch is session-scoped: when multiple Claude Code terminals are open on the same repo, each session can hold a different active workstream without interfering with the others.

The statusline's GSD-state segment (milestone, phase, progress) reflects whichever workstream resolves as active — the same `GSD_WORKSTREAM` env var / stored pointer precedence every workstream-aware command uses. If no workstream can be resolved in a workstream-mode project, the segment shows `no active workstream` rather than disappearing silently.

Once switched, drive the normal phase workflow:

```bash
/gsd-discuss-phase 1
/gsd-plan-phase 1
/gsd-execute-phase 1
/gsd-verify-work 1
```

To work on another area, switch workstreams in a second terminal:

```bash
/gsd-workstreams switch frontend-dash
/gsd-discuss-phase 1
/gsd-plan-phase 1
```

---

## Check progress across all workstreams

```bash
/gsd-workstreams progress
```

Prints a cross-workstream summary — phase status, current position, and outstanding work for every workstream — without requiring you to switch between them.

For detailed status on a single workstream:

```bash
/gsd-workstreams status backend-api
```

---

## Resume work in a workstream

After a context reset or a new session, restore your position:

```bash
/gsd-workstreams resume backend-api
```

This activates the workstream and restores your last known position within it, equivalent to switching and then running `/gsd-resume-work`.

---

## Archive a completed workstream

When a workstream's milestone work is done:

```bash
/gsd-workstreams complete backend-api
```

GSD marks the workstream as archived and moves it out of the active listing. The planning artifacts are preserved under `.planning/workstreams/backend-api/` for audit purposes.

---

## Scope a single command to a workstream without switching

If you need to run one command against a specific workstream without changing your session's active context, use the `--ws` flag:

```bash
/gsd-progress --ws frontend-dash
/gsd-plan-phase 2 --ws backend-api
```

`--ws` takes highest priority in the resolution order and does not alter the session-scoped pointer.

---

## When to use workstreams instead of workspaces

Choose workstreams when:

- All the work lives in the **same repository** and shares the same git history
- You want to plan or discuss different concern areas (API, UI, infra) **concurrently** without one workstream's `STATE.md` overwriting another's
- You do not need a separate branch per workstream at creation time (though you can branch as normal within each workstream's execution)
- The overhead of creating full git worktrees is not justified by the isolation you need

Choose [workspaces](isolate-work-with-workspaces.md) instead when:

- You are working across **multiple repositories** (e.g., `hr-ui` and `ZeymoAPI`)
- You need the isolation of a **separate git worktree** or clone per feature — fully independent branches, lock files, and build artefacts
- You want to run `/gsd-new-project` independently in each workspace with a wholly separate `.planning/` root, not a subdirectory of the main repo's `.planning/`

---

## Related

- [Isolate work with workspaces](isolate-work-with-workspaces.md)
- [The phase loop](../explanation/the-phase-loop.md)
- [Commands](../COMMANDS.md)
- [docs index](../README.md)
