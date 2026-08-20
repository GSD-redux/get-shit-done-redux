<objective>
Verify the live-DOM acceptance criteria for the execution wave that just completed.
Answer: "of this wave's stated UI acceptance criteria, which can I observe in a live DOM
right now, and which could I not look at?"

This step is ADDITIVE. It never halts the wave, never fails the phase, and never rewrites
SUMMARY.md. If you cannot look, say so and finish.
</objective>

<required_reading>
- {phase_dir}/{phase_num}-PLAN.md (the wave's tasks and their acceptance criteria)
- {phase_dir}/{phase_num}-UI-SPEC.md if it exists (the design contract, when the phase has one)
</required_reading>

<browser_surface>
You carry exactly two browser MCP families: `mcp__chrome-devtools__*` and
`mcp__claude-in-chrome__*`. Use whichever responds. Do not assume they expose the same
tool names — probe, then use what is there. Do not paper over differences between them.

You do NOT carry `mcp__playwright__*`. The Playwright path belongs to the orchestrator's
own verification step and is not yours.
</browser_surface>

<profile_lock>
`chrome-devtools-mcp` holds an exclusive lock on its browser profile
(`$HOME/.cache/chrome-devtools-mcp/chrome-profile`). A second concurrent instance fails with:

```
The browser is already running for <dir>. Use --isolated to run multiple browser instances.
```

If you see that, or any equivalent lock error:

1. Record `outcome: could_not_look` and `reason: profile_locked`.
2. Name `--isolated` in the notes, so the operator knows the remedy is a flag on THEIR MCP
   server registration.
3. **Stop.** Do not retry, do not loop, do not wait for the lock. GSD cannot pass
   `--isolated` — it is not GSD's flag — and a retry loop here just holds up the wave.

Parallel execution waves sharing one profile WILL hit this. It is an expected condition,
not a defect, and it is not a reason to fail anything.
</profile_lock>

<method>
For each UI acceptance criterion you can identify in the wave's plan:

1. Resolve its target URL. If no dev server or target is reachable, that criterion is
   `could_not_look` / `target_unreachable` — not a failure.
2. Open it with the browser family that responded.
3. Observe the DOM for the specific, stated condition. Assert on structure and content —
   an element's presence, its text, its attributes, its computed state.
4. Record `passed` when the stated condition is observably true, `needs_review` when it is
   ambiguous or requires human judgement (subjective aesthetics, content accuracy).

Scope limit for this version: DOM observation against stated criteria only. No screenshot
diffing, no accessibility audit, no performance tracing. If a criterion needs one of those,
mark it `needs_review` and say which.

Never invent a criterion. If the plan states no UI acceptance criteria, that is
`outcome: nothing_to_report` / `reason: no_criteria`, and it is a perfectly good result.
</method>

<output>
Write to: {phase_dir}/{phase_num}-DOM-VERIFY.md

Frontmatter carries scalars only, so a reader can get the verdict without parsing prose:

```
---
schema_version: 1
wave: {wave_number}
outcome: verified | nothing_to_report | could_not_look
reason: ok | no_criteria | no_browser_mcp | profile_locked | target_unreachable
checked: <integer>
passed: <integer>
needs_review: <integer>
---
```

Then a short body: one line per criterion with its verdict, and — when `outcome` is
`could_not_look` — exactly what stopped you and what the operator would change.

**`nothing_to_report` and `could_not_look` are different outcomes and must never be
conflated.** "There were no UI criteria in this wave" and "there were criteria but I had no
browser" look identical in a summary that collapses them, and that ambiguity is the reported
problem this capability exists to remove.
</output>
