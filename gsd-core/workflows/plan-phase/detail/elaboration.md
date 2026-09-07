Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.

# plan-phase — Detail

Elaboration deferred from the `plan-phase.md` spine under ADR-4139 (Compact Content mode). Read via `gsd-core/references/compact-content-gate.md` when `workflow.compact_content` is `false`. This file supplements the spine — it does not stand alone.

## § 9a — Filesystem Fallback (Planner)

This elaborates the spine's §9a trigger condition (above) — the recovery banner and its three options.

```bash
# #3218: this asks "did the planner write files to disk at all" — a
# planner-produced-nothing check, not outstanding-work counting — so it
# takes the PHYSICAL set (`plan_count_all`, status:superseded INCLUDED): a
# superseded plan is still a file the planner wrote, and this check must not
# read "nothing written" just because every plan happens to be superseded.
```

The spine already computed `DISK_PLANS` (above) before reaching this elaboration.

**If `DISK_PLANS` > 0:** The planner wrote plans to disk but the Agent() return was empty or
truncated (the Windows stdio hang pattern — the subagent finished but the return never
arrived). Display:

```text
◆ Planner wrote {DISK_PLANS} plan(s) to disk but did not emit a PLANNING COMPLETE marker.
  This is a known Windows stdio hang pattern — work is likely recoverable.

  Plans found on disk:
  {ls output of *-PLAN.md}
```

Offer 3 options:
1. **Accept plans** — treat as `## PLANNING COMPLETE` and continue through step 9 `## PLANNING COMPLETE` handling (so `--skip-verify` / `plan_checker_enabled=false` are honored — may skip to step 13 rather than step 10)
2. **Retry planner** — re-spawn the planner with the same prompt (return to step 8)
3. **Stop** — exit; user can re-run `/gsd:plan-phase {N}` to resume

**If `DISK_PLANS` is 0 and no marker:** The planner produced no output. Treat as
`## PLANNING INCONCLUSIVE` and handle accordingly.

## § 9b — Handle Phase Split Recommendation

When the planner returns `## PHASE SPLIT RECOMMENDED`, it means the phase's source items exceed the context budget for full-fidelity implementation. The planner proposes groupings.

**Extract from planner return:**
- Proposed sub-phases (e.g., "17a: processing core (D-01 to D-19)", "17b: billing + config UX (D-20 to D-27)")
- Which source items (REQ-IDs, D-XX decisions, RESEARCH items) go in each sub-phase
- Why the split is necessary (context cost estimate, file count)

**Present to user:**
```
## Phase {X} exceeds context budget for full-fidelity implementation

The planner found {N} source items that exceed the context budget when
planned at full fidelity. Instead of reducing scope, we recommend splitting:

**Option 1: Split into sub-phases**
- Phase {X}a: {name} — {items} ({N} source items, ~{P}% context)
- Phase {X}b: {name} — {items} ({M} source items, ~{Q}% context)

**Option 2: Proceed anyway** (planner will attempt all, quality may degrade past 50% context)

**Option 3: Prioritize** — you choose which items to implement now,
rest become a follow-up phase
```

Use AskUserQuestion with these 3 options.

**If "Split":** Use `/gsd:phase --insert` to create the sub-phases, then replan each.
**If "Proceed":** Return to planner with instruction to attempt all items at full fidelity, accepting more plans/tasks.
**If "Prioritize":** Use AskUserQuestion (multiSelect) to let user pick which items are "now" vs "later". Create CONTEXT.md for each sub-phase with the selected items.

## § 9c — Handle Source Audit Gaps

When the planner returns `## ⚠ Source Audit: Unplanned Items Found`, it means items from REQUIREMENTS.md, RESEARCH.md, ROADMAP goal, or CONTEXT.md decisions have no corresponding plan.

**Extract from planner return:**
- Each unplanned item with its source artifact and section
- The planner's suggested options (A: add plan, B: split phase, C: defer with confirmation)

**Present each gap to user.** For each unplanned item:

```
## ⚠ Unplanned: {item description}

Source: {RESEARCH.md / REQUIREMENTS.md / ROADMAP goal / CONTEXT.md}
Details: {why the planner flagged this}

Options:
1. Add a plan to cover this item (recommended)
2. Split phase — move to a sub-phase with related items
3. Defer — add to backlog (developer confirms this is intentional)
```

Use AskUserQuestion for each gap (or batch if multiple gaps).

**If "Add plan":** Return to planner (step 8) with instruction to add plans covering the missing items, preserving existing plans.
**If "Split":** Use `/gsd:phase --insert` for overflow items, then replan.
**If "Defer":** Record in CONTEXT.md `## Deferred Ideas` with developer's confirmation. Proceed to step 10.

## § 11a — Filesystem Fallback (Checker)

Fires when the checker's Agent() call comes back without either completion marker (`## VERIFICATION PASSED` / `## ISSUES FOUND`). The spine already computed `DISK_PLANS` before reaching this elaboration.

**If `DISK_PLANS` > 0:** Plans exist on disk; the checker return was empty or truncated (the
Windows stdio hang pattern — the subagent finished but the return never arrived). Display:

```text
◆ Checker return was empty or truncated. {DISK_PLANS} plan(s) exist on disk.
  This is a known Windows stdio hang pattern — checker may have completed without returning.
```

Offer 3 options:
1. **Accept verification** — treat as `## VERIFICATION PASSED` and continue to step 13
2. **Retry checker** — re-spawn the checker with the same prompt (return to step 10)
3. **Stop** — exit; user can re-run `/gsd:plan-phase {N}` to resume

**If `DISK_PLANS` is 0:** No plans on disk — something is seriously wrong. Display error and stop.

## § 11 thinking-partner — Thinking Partner For Architectural Tradeoffs

**Thinking partner for architectural tradeoffs (conditional):**
If `features.thinking_partner` is enabled, scan the checker's issues for architectural tradeoff keywords
("architecture", "approach", "strategy", "pattern", "vs", "alternative"). If found:

```
The plan-checker flagged an architectural decision point:
{issue description}

Brief analysis:
- Option A: {approach_from_plan} — {pros/cons}
- Option B: {alternative_approach} — {pros/cons}
- Recommendation: {choice} aligned with {phase_goal}

Apply this to the revision? [Yes] / [No, I'll decide]
```

If yes: include the recommendation in the revision prompt. If no: proceed to revision loop as normal.
If thinking_partner disabled: skip this block entirely.

## § 12.5 — Plan Bounce (Optional External Refinement)

**Skip if:** `--skip-bounce` flag, `--gaps` flag, or bounce is not activated.

**Activation:** Bounce runs when `--bounce` flag is present OR `workflow.plan_bounce` config is `true`. The `--skip-bounce` flag always wins (disables bounce even if config enables it). The `--gaps` flag also disables bounce (gap-closure mode should not modify plans externally).

**Prerequisites:** `workflow.plan_bounce_script` must be set to a valid script path. If bounce is activated but no script is configured, display warning and skip:
```
⚠ Plan bounce activated but no script configured.
Set workflow.plan_bounce_script to the path of your refinement script.
Skipping bounce step.
```

**Read pass count:**
```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
BOUNCE_PASSES=$(gsd_run query config-get workflow.plan_bounce_passes --raw 2>/dev/null || echo "2")
BOUNCE_SCRIPT=$(gsd_run query config-get workflow.plan_bounce_script --raw 2>/dev/null || true)
```

Display banner:
```
### GSD ► BOUNCING PLANS (External Refinement)

Script: ${BOUNCE_SCRIPT}
Max passes: ${BOUNCE_PASSES}
```

**For each PLAN.md file in the phase directory:**

1. **Backup:** Copy `*-PLAN.md` to `*-PLAN.pre-bounce.md`
```bash
cp "${PLAN_FILE}" "${PLAN_FILE%.md}.pre-bounce.md"
```

2. **Invoke bounce script:**
```bash
"${BOUNCE_SCRIPT}" "${PLAN_FILE}" "${BOUNCE_PASSES}"
```

3. **Validate bounced plan — YAML frontmatter integrity:**
After the script returns, check that the bounced file still has valid YAML frontmatter (opening and closing `---` delimiters with parseable content between them). If the bounced plan breaks YAML frontmatter validation, restore the original from the pre-bounce.md backup and continue to the next plan:
```
⚠ Bounced plan ${PLAN_FILE} has broken YAML frontmatter — restoring original from pre-bounce backup.
```

4. **Handle script failure:** If the bounce script exits non-zero, restore the original plan from the pre-bounce.md backup and continue to the next plan:
```
⚠ Bounce script failed for ${PLAN_FILE} (exit code ${EXIT_CODE}) — restoring original from pre-bounce backup.
```

**After all plans are bounced:**

5. **Re-run plan checker on bounced plans:** Spawn gsd-plan-checker (same as step 10) on all modified plans. If a bounced plan fails the checker, restore original from its pre-bounce.md backup:
```
⚠ Bounced plan ${PLAN_FILE} failed checker validation — restoring original from pre-bounce backup.
```

6. **Commit surviving bounced plans:** If at least one plan survived both the frontmatter validation and the checker re-run, commit the changes:
```bash
gsd_run query commit "refactor(${padded_phase}): bounce plans through external refinement" --files "${PHASE_DIR}/*-PLAN.md"
```

Display summary:
```
Plan bounce complete: {survived}/{total} plans refined
```

**Clean up:** Remove all `*-PLAN.pre-bounce.md` backup files after the bounce step completes (whether plans survived or were restored).
