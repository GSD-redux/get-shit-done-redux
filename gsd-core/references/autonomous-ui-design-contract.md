# UI Design Contract (Frontend Phases) — Autonomous Mode

Step 3a.5 of `/gsd:autonomous`: resolve whether the current phase needs a UI-SPEC.md generated before planning, and generate one via active `plan:pre` step hooks if so. Always non-blocking — proceeds to step 3b (Plan) regardless of outcome.

**Inputs:** `PHASE_NUM`, `PHASE_DIR` from execute_phase.

Resolve active `plan:pre` hooks:

```bash
UI_SPEC_FILE=$(ls "${PHASE_DIR}"/*-UI-SPEC.md 2>/dev/null | head -1)
HOOKS_JSON=$(gsd_run loop render-hooks plan:pre --raw)
```

Read the `activeHooks` array directly from `HOOKS_JSON` (in-context — do NOT invoke a shell pipeline). **Compute the active UI step hooks** = entries from `activeHooks` where `kind == "step"` and `ref.skill` is set. **If there are NO active step hooks → skip silently to 3b.** (This covers `workflow.ui_phase=false` — including configurations where only a gate-only entry is present, e.g. `ui_phase=false` + `ui_safety_gate=true` produces `activeHooks=[{kind:"gate"}]`. Autonomous never runs the plan:pre gate — it is always pipeline mode — so a gate-only active set is equivalent to no active step and is silently skipped here. This matches OLD §3a.5 behaviour.)

(At least one active step hook ⇒ `workflow.ui_phase` is on.) Run the UI-SPEC gate:

```bash
GATE=$(gsd_run check ui-plan-gate "${PHASE_NUM}" --raw)
```

Read `frontend` and `hasUiSpec` from `GATE` (in-context).

**If `frontend` is false:** Skip silently to 3b.

**If `hasUiSpec` is true (UI-SPEC already exists):** Skip silently to 3b.

**Otherwise (frontend phase + no UI-SPEC):** For each active step hook (the `kind == "step"` set from above, in array order):

```
Skill(skill="gsd-${ref.skill}", args="${PHASE_NUM}")
```

(Prepend `gsd-` to `ref.skill` — so `ui-phase` → `gsd-ui-phase`. Bare `${PHASE_NUM}` args — autonomous style, same pattern as the verify:post dispatch.) Entries where `kind == "gate"` are silently ignored — autonomous is always pipeline mode, there is no blocking gate here.

After all step hooks return, re-read:

```bash
UI_SPEC_FILE=$(ls "${PHASE_DIR}"/*-UI-SPEC.md 2>/dev/null | head -1)
```

**If `UI_SPEC_FILE` is still empty:** Display warning `Phase ${PHASE_NUM}: UI-SPEC generation did not produce output — continuing without design contract.` and proceed to 3b. NON-BLOCKING.
