<step name="mvp_display">
**MVP-mode display (when phase has `**Mode:** mvp` in ROADMAP.md).**

`init.progress` already resolved `phase_mvp_mode` for the current phase (progress has no `--mvp` CLI flag — mode is inherited from the planned phase), and this step is only read at all when that same fact is `true` (`section_manifest`'s `mvp-display` inclusion gates on it) — so there is no need to re-resolve `MVP_MODE` here via a fresh `gsd_run query phase.mvp-mode` call; that would gate this section on a fact its own body recomputes, which is circular and self-disabling. Simply consume `$phase_mvp_mode` (already extracted from init JSON in `init_context`) as `true` for the remainder of this step.

The per-phase progress block adds a **user-flow status** sub-block sourced from the phase's PLAN.md task names. Each task whose name reads like a user-visible capability (e.g., "Register flow", "Login flow", "Password reset") is rendered as a status line:

```
Phase 1 — User Auth MVP
  ✅ Walking Skeleton complete           ← from SKELETON.md existence
  ✅ Register flow working               ← from PLAN.md task with summary
  ✅ Login flow working                  ← from PLAN.md task with summary
  🔄 Password reset (in progress)        ← from PLAN.md task without summary
  ⬜ Email verification                  ← from PLAN.md task not yet started
```

**User-flow filter:** Tasks whose names are technical-sounding ("Wire DB schema", "Create migration", "Bump deps") are NOT rendered as user-flow status lines. Heuristic: a task name is user-flow-shaped if it ends in "flow", "page", "screen", or starts with a verb the user would recognize ("Register", "Login", "Upload", "View"). Tasks that fail the heuristic still count toward the standard task progress total but don't appear in the user-flow sub-block.
</step>
