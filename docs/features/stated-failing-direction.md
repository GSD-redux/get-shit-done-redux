---
id: 167
title: Stated Failing Direction
group: v1.7.0 Features
---

**Command:** `/gsd-plan-phase` (automatic), `gsd-tools check verify-failure-directions <N>` (#3172)

**Behavior:** A plan's `<automated>` block is the thing that decides whether work is done, and nothing checked that the command inside it could fail. In the motivating case six plans shipped 21 commands that could not run at all — `cargo test -p <pkg> --lib` against a package with no library target. They read as rigour and were not falsifiable, so three separate executors each rediscovered the defect and improvised a substitute at execution time. Every runnable `<automated>` command now needs a `<fails_when>` sibling naming what output constitutes failure:

```xml
<verify>
  <automated>npm --prefix apps/api test -- auth.spec.ts</automated>
  <fails_when>non-zero exit, or "0 passed" in the summary line</fails_when>
</verify>
```

`gsd-planner` emits it; `gsd-tools check verify-failure-directions <N>` verifies it deterministically; `/gsd-plan-phase` runs the probe before the plan-check pass and hands the JSON to `gsd-plan-checker`, whose check 8f blocks on `severity`.

**Why this shape and not the two obvious alternatives.** *Validating command shape* — teaching the checker Cargo's `--lib`/`--bin` target resolution, then pytest's node-ids, then the next one — always trails the newest toolchain. *Executing each command at plan time* is the strongest signal but means running planner-invented commands, with whatever side effects they carry, during planning. Requiring a stated failing direction needs no toolchain knowledge at all, and it is the only one of the three that catches the dangerous case: the motivating command exited non-zero, so it failed loudly, but the same class of error with a command that exits 0 on a no-op passes green and silently. Naming the failure signal is what makes that visible.

**Presence, not quality — deliberately split.** The probe is deterministic and owns the blockers: a statement is missing, blank, or a whole-value placeholder (`TBD`, `TODO`, `N/A`, `NA`, `none`, `unknown`, `TBA`, `?`, `-`). Whether the statement names the *right* signal is prose judgment, so `gsd-plan-checker` raises a vacuous statement (*"the command fails"*) as a WARNING only. Every BLOCKER stays reproducible; judgment stays advisory.

**It reports, it never prescribes.** The payload names the command with no stated failure mode and stops there. A prescribed statement would be copied verbatim and carry zero information — reproducing the original defect one level up.

**Not findings:** the Nyquist `MISSING — Wave 0 …` sentinel (not runnable, so it has no failure mode to state), an empty `<automated>` body (check 8a owns command presence), and a `<verify>` with no `<automated>` at all.

**Known limits:**
- Presence only. A statement that is present and specific can still name the wrong signal; that is caught, if at all, by judgment rather than by the probe.
- **Breaking for plans authored before this shipped.** A phase planned earlier has no `<fails_when>` anywhere and blocks on re-check until statements are added or the phase is re-planned.
- The adjacent **vacuous pass** — a command that runs successfully and asserts nothing, such as a test-name filter matching zero tests and exiting 0 — is a distinct problem and is explicitly out of scope.

See [State a failing direction](how-to/state-a-failing-direction.md) and [`gsd-tools check verify-failure-directions`](COMMANDS.md#gsd-tools-check-verify-failure-directions).
