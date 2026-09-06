<!-- gsd:loop-host
step: ship
points: ship:pre, ship:post
agent-roles: orchestrator
produces:
consumes: UAT.md
-->
<purpose>
Create a pull request from completed phase/milestone work, generate a rich PR body from planning artifacts, optionally run code review, and prepare for merge. Closes the plan → execute → verify → ship loop.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<available_agent_types>
Valid GSD subagent types (use exact names — do not fall back to 'general-purpose'):
- gsd-mempalace-curator — Ship-time MemPalace curation (diary, KG mirror, cross-project tunnels, wing-scoped prune); dispatched at ship:post when the mempalace capability is enabled.
</available_agent_types>

<process>

<step name="initialize">
Parse arguments and load project state:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
RESPONSE_LANGUAGE=$(gsd_run query config-get response_language --raw --default "" 2>/dev/null || echo "")
INIT=$(gsd_run query init.phase-op "${PHASE_ARG}")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

**If `response_language` is set:** All user-facing output of this workflow — narration between tool calls, status updates, progress notes, findings, questions, prompts, and explanations — MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated.

Parse from init JSON: `phase_found`, `phase_dir`, `phase_number`, `phase_name`, `padded_phase`, `commit_docs`.

Also load config for branching strategy:
```bash
CONFIG=$(gsd_run query state.load)
```

Extract: `branching_strategy`, `branch_name`.

Detect base branch for PRs and merges:
```bash
BASE_BRANCH=$(gsd_run query git.base-branch)
```
</step>

<step name="preflight_checks">
Verify the work is ready to ship:

1. **Verification passed?**
   ```bash
   # The gate decides on ONE read. --pick takes a single field, so the two
   # human-facing fields are read only on the blocking path below — never on the
   # passing path — rather than issuing three queries up front (#2589).
   STATUS=$(gsd_run query verification.status "${PHASE_DIR}" --pick status 2>/dev/null)
   ```
   Only `passed` may ship. If `$STATUS` is `passed`, verification is complete — continue to the next preflight check; do not read any further verification field.

   Any other value (including `gaps_found`, `human_needed`, `missing`, and `unknown`) blocks with `PHASE_VERIFICATION_INCOMPLETE`. Only then, read the two message fields:
   ```bash
   NEXT_ACTION=$(gsd_run query verification.status "${PHASE_DIR}" --pick next_action 2>/dev/null)
   NEXT_COMMAND=$(gsd_run query verification.status "${PHASE_DIR}" --pick next_command 2>/dev/null)
   ```
   Present `$NEXT_ACTION` to the user and, when `$NEXT_COMMAND` is non-empty, show it as the command to run next. These two are message text only — the block/allow decision has already been made from `$STATUS`, so a concurrent write between the reads cannot change the gate's verdict. The query already handles missing files and unexpected values, so no per-status arm is needed.

2. **Clean working tree?**
   ```bash
   git status --short
   ```
   If uncommitted changes exist: ask user to commit or stash first.

3. **On correct branch?**
   ```bash
   CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || true)
   IS_PROTECTED=$(gsd_run query git.base-branch --is-protected "$CURRENT_BRANCH") || IS_PROTECTED=""
   if [ "$IS_PROTECTED" = true ]; then
     echo "⚠ Current branch '$CURRENT_BRANCH' is a protected branch; shipping should happen from a feature branch." >&2
   elif [ -z "$IS_PROTECTED" ]; then
     echo "⚠ Could not determine whether '$CURRENT_BRANCH' is protected — the query failed. Continuing." >&2
   fi
   ```
   If `IS_PROTECTED` is `true`: warn — should be on a feature branch.
   If branching_strategy is `none`: offer to create a branch now.

4. **Remote configured?**
   ```bash
   git remote -v | head -2
   ```
   Detect `origin` remote. If no remote: error — can't create PR.

5. **`gh` CLI available?**
   ```bash
   which gh && gh auth status 2>&1
   ```
   If `gh` not found or not authenticated: provide setup instructions and exit.

6. **Capability ship gates (generic dispatch).**

   Resolve active `ship:pre` gate hooks from the capability registry — the registry evaluates each hook's `when` condition, so do **not** read `workflow.security_enforcement` or `workflow.windows_enforce` directly:

   ```bash
   SHIP_PRE_HOOKS_JSON=$(gsd_run loop render-hooks ship:pre --raw)
   SECURITY_FILE=$(ls "${PHASE_DIR}"/*-SECURITY.md 2>/dev/null | head -1)
   ```

   Read the `activeHooks` array from `SHIP_PRE_HOOKS_JSON` in-context (do NOT pipe it through a shell parser).

   **If `activeHooks` is empty or absent:** skip this check silently and continue to the next preflight step. A capability whose `when` is off contributes no entry, and one that failed to load fails OPEN with its own warning from the resolver — neither is a block.

   **For each active entry where `kind == "gate"`** (process in array order), following `gsd-core/references/loop-hook-dispatch.md`. Entries of any other `kind` are not gates and are not enforced here. Every gate is visited exactly once by this loop — the named branches below are specializations *within* it, never a separate pass, so no gate is evaluated twice.

   **Step 1 — evaluate the gate's `check`.** Dispatch by check shape; read the hook's `check` object in-context to pick the branch (the registry validates exactly one of `query`/`predicate`/`agentVerdict`). Two capability IDs carry a bespoke evaluation whose fail-closed semantics the declared predicate alone does not reproduce — take their branch, then rejoin at step 2:

   - **`capId == "security"`** — enforce against `SECURITY_FILE`:
     - **`SECURITY_FILE` is empty** → `block: true`, `SECURITY_SHIP_GATE_NO_REVIEW`:
       ```
       ⚠ Security enforcement is enabled but no SECURITY.md exists for this phase.
       Run /gsd:secure-phase {phase} and resolve findings before shipping.
       ```
     - **`SECURITY_FILE` exists** → read its frontmatter `threats_open`. The gate passes **only** when `threats_open` is exactly `0`. For any other value — `threats_open` > 0, or a missing / non-numeric / unparsable field — **fail closed** with `block: true` and `SECURITY_SHIP_GATE_OPEN_THREATS` (the predicate is strict equality to `0`; never ship on an ambiguous value):
       ```
       ⚠ Security ship gate: SECURITY.md does not assert threats_open == 0 (found: {threats_open|unset}).
       Resolve open threats (or re-run /gsd:secure-phase {phase}) before shipping.
       ```

   - **`capId == "broken-windows"`** (issue #1950) — enforce against the ledger's typed status. The ledger lives at the **project root** (cross-phase, not phase-scoped):

     ```bash
     WINDOWS_STATUS_JSON=$(gsd_run windows status --raw 2>/dev/null || echo '')
     WINDOWS_OPEN_COUNT=$(printf '%s' "$WINDOWS_STATUS_JSON" | jq -r '.ledger.open_count // "?"' 2>/dev/null || echo '?')
     ```

     - **`WINDOWS_OPEN_COUNT == "0"`** → `block: false`; the gate passes.
     - **`WINDOWS_OPEN_COUNT` is a positive integer** → `block: true`, `WINDOWS_SHIP_GATE_OPEN`:
       ```
       ⚠ Broken-windows ship gate: WINDOWS.md has {WINDOWS_OPEN_COUNT} open window(s).
       Resolve each entry before shipping, or explicitly waive with a recorded reason:
         gsd_run windows fixed <id>      # defect resolved
         gsd_run windows waive <id> "<reason>"   # justified deferral (reason required)
       Then re-run /gsd:ship.
       ```
     - **`WINDOWS_OPEN_COUNT` is `"?"`, empty, or non-numeric** → **fail closed** with `block: true` and `WINDOWS_SHIP_GATE_READ_FAILED` (the gate is strict equality to `0`; never ship on an unreadable ledger):
       ```
       ⚠ Broken-windows ship gate: could not read open_count from .planning/WINDOWS.md.
       Inspect the file or run `gsd_run windows status --raw` to diagnose. The ledger
       may be malformed; fix it before shipping (an unparseable ledger is a broken window).
       ```

     The ledger is **optional and backward-compatible**: on a project where `gsd_run windows status` returns `open_count: 0` (no `.planning/WINDOWS.md` yet, or an empty ledger), the gate passes silently. It only blocks when at least one entry is `open`.

   - **Every other `capId`** — run the gate's own declared check through the generic evaluator. This arm is what makes a third-party capability's declared gate enforceable at all (#3559); before it existed, a gate whose `capId` was not named above was resolved and then silently dropped.

     ⚠ **Validate `check` before shell use** (third-party manifest input) — `loop-hook-dispatch.md` § `gate`.

     For a named-query gate (only a value that has passed validation is run):
     ```bash
     GATE_RESULT=$(gsd_run check ${hook.check.query} "${PHASE_DIR}" --raw)
     CHECK_EXIT=$?
     ```

     (The named-query argument convention — a single `"${PHASE_DIR}"` positional — mirrors `verify-work.md`'s `verify:pre` arm verbatim. No capability declares a `check.query` gate at `ship:pre` today; the arm exists so the documented check contract is complete rather than half-implemented.)

     For a `predicate` gate (ADR-2008 / #2008), serialize `hook.check.predicate` to compact JSON and pass it as a **single argv element**:
     ```bash
     GATE_RESULT=$(gsd_run check predicate --predicate '<hook.check.predicate as JSON>' --phase-dir "${PHASE_DIR}" --phase-number "${PHASE_NUMBER}" --raw)
     CHECK_EXIT=$?
     ```
     A gate carrying neither — including an `agentVerdict` check, which has no runner at `ship:pre` — cannot be evaluated here. Record a warning naming the `capId` and treat it as a check-command failure routed per step 1a, **never** as a silent pass.

   **Step 1a — did the CHECK COMMAND itself fail?** (non-zero `CHECK_EXIT`, empty output, or unparseable JSON). The two named branches above cannot reach this state — their failure modes are already folded into a fail-closed `block: true`.
   - **`onError == "halt"`** → stop the ship. Do NOT push, do NOT create a PR. Surface: `⚠ Gate check command failed ({hook.capId}): command error. Resolve before shipping.`
   - **`onError == "skip"`** → record a warning naming the `capId`, then continue to the next gate. Do NOT read `GATE_RESULT.block`.

   **Step 2 — read the gate's `block` decision.** Only reached when the check produced a verdict.

   - **`blocking == true` and `block == true`** → HALT the ship — do NOT push, do NOT create a PR — surfacing that gate's own message:
     ```
     ⚠ Ship blocked by capability gate ({hook.capId}): {message}
     ```
     This halt is **not** bypassed by `onError` — `onError` covers check-command failure (step 1a), never the gate's block decision.
   - **`blocking == false`** (advisory) → never halts. If `block == true` or the result carries a non-empty message, print `⚠ {hook.capId} advisory: {message}`, then continue.
   - **`blocking == true` and `block == false`** → continue silently.

   **When every active gate has been processed without a halt:** continue to the next preflight check.
</step>

<step name="push_branch">
Push the current branch to remote:

```bash
git push origin ${CURRENT_BRANCH} 2>&1
```

If push fails (e.g., no upstream): set upstream:
```bash
git push --set-upstream origin ${CURRENT_BRANCH} 2>&1
```

Report: "Pushed `{branch}` to origin ({commit_count} commits ahead of ${BASE_BRANCH})"
</step>

<step name="generate_pr_body">
Auto-generate a rich PR body from planning artifacts:

**1. Title:**
```
Phase {phase_number}: {phase_name}
```
Or for milestone: `Milestone {version}: {name}`

**2. Summary section:**
Read ROADMAP.md for phase goal. Read VERIFICATION.md for verification status.

```markdown
## Summary

**Phase {N}: {Name}**
**Goal:** {goal from ROADMAP.md}
**Status:** Verified ✓

{One paragraph synthesized from SUMMARY.md files — what was built}
```

**3. Changes section:**
For each SUMMARY.md in the phase directory:
```markdown
## Changes

### Plan {plan_id}: {plan_name}
{one_liner from SUMMARY.md frontmatter}

**Key files:**
{key-files.created and key-files.modified from SUMMARY.md frontmatter}
```

**4. Requirements section:**
```markdown
## Requirements Addressed

{REQ-IDs from plan frontmatter, linked to REQUIREMENTS.md descriptions}
```

**5. Testing section:**
```markdown
## Verification

- [x] Automated verification: {pass/fail from VERIFICATION.md}
- {human verification items from VERIFICATION.md, if any}
```

**6. Decisions section:**
```markdown
## Key Decisions

{Decisions from STATE.md accumulated context relevant to this phase}
```

**7. Configured project sections:**
Read append-only project-specific PRD/PR body sections from config:

```bash
CUSTOM_PR_SECTIONS=$(gsd_run query config-get ship.pr_body_sections --default '[]' 2>/dev/null || echo '[]')
```

`ship.pr_body_sections` is an onboarding-time extension point for teams that need extra PRD-style sections such as `User Stories & Acceptance Criteria`, `Risks & Dependencies`, `Success Metrics`, `Release Criteria`, or `Stakeholder Review & Approval`.

Use these sections for lean/agile PRD material that should travel with the PR without making the core `/gsd:ship` body configurable:

- User stories and acceptance criteria that explain the functional increment from the user's point of view.
- Definition of Done or release criteria that make the completion standard explicit.
- Risks, dependencies, stakeholder review, and traceability notes needed by regulated or approval-heavy projects.

Rules:

- Treat configured sections as append-only. They are rendered after `Key Decisions` and cannot replace, remove, or reorder the required core sections: `Summary`, `Changes`, `Requirements Addressed`, `Verification`, and `Key Decisions`.
- Each entry must have `heading` plus at least one of `source`, `template`, or `fallback`.
- `enabled` defaults to `true`; when `enabled` is `false`, skip the section without warning. This lets onboarding seed optional sections that a project can enable later.
- `source` is a fallback chain of planning artifact headings: `PLAN.md ## Risks || VERIFICATION.md ## Manual Checks`. Allowed artifacts are `ROADMAP.md`, `PLAN.md`, `SUMMARY.md`, `VERIFICATION.md`, `STATE.md`, `REQUIREMENTS.md`, and `CONTEXT.md`.
- `template` is literal Markdown with a closed token namespace only: `{phase_number}`, `{phase_name}`, `{phase_dir}`, `{base_branch}`, `{padded_phase}`.
- `fallback` is literal Markdown used when `source` finds no content and no `template` is present.
- Omit sections whose final rendered body is empty after trimming.

Example configured sections:

```json
[
  {
    "heading": "User Stories & Acceptance Criteria",
    "enabled": true,
    "source": "REQUIREMENTS.md ## User Stories || REQUIREMENTS.md ## Acceptance Criteria",
    "fallback": "- Acceptance criteria are covered by the linked requirements and verification evidence."
  },
  {
    "heading": "Risks & Dependencies",
    "enabled": true,
    "source": "PLAN.md ## Risks || PLAN.md ## Dependencies",
    "fallback": "- No known high-risk rollout dependencies."
  },
  {
    "heading": "Stakeholder Review & Approval",
    "enabled": false,
    "template": "- Product owner approval pending for {phase_name}."
  }
]
```

**8. TDD Audit section:**

Reconstruct the per-commit TDD gate trail before squash-merge discards it. Walk the PR branch's own commits (merges excluded) and read each commit's `gate-status:` trailer with Git's native trailer machinery — never a raw `%B` grep, which would also match the string written in prose:

```bash
# Anchor on the merge-base so a stale local ${BASE_BRANCH} ref cannot over-count.
RANGE_BASE=$(git merge-base "${BASE_BRANCH}" HEAD)
git log "${RANGE_BASE}..HEAD" --no-merges --reverse \
  --format='%H%x1f%s%x1f%(trailers:key=gate-status,valueonly,separator=%x2c)%x1e'
```

Records are separated by `\x1e`; the fields inside each are `\x1f`-separated — `<sha>`, `<subject>`, `<gate-status value>`.

Pair commits by their conventional-commit type (the `type:` prefix of the subject):

- A `test:` commit is the RED row. Pair it with the next following **implementation** commit — a `feat:` or `fix:` — as its **Impl commit** (the GREEN step), skipping over any intervening `refactor:`, `docs:`, or `chore:` commits so they are never mistaken for the GREEN step.
- A `refactor:`, `docs:`, or `chore:` commit that is not consumed as an Impl pairing is a standalone row with Impl commit `—`.
- A `feat:`/`fix:` commit with no preceding unpaired `test:` is a standalone row.

Surface each commit's `gate-status:` value, normalized to exactly one of `skill`, `fallback`, `exempt`, or `missing` — never the raw trailer text. A commit whose trailer is absent, whose value is none of the first three, or which carries more than one `gate-status:` trailer (ambiguous) is counted as **missing** and still listed. This section is informational; it never blocks the ship.

**Self-suppress when every commit is missing (#2431):** the execute pipeline only writes `gate-status:` trailers when TDD mode is active. If every commit in the scan normalizes to `missing`, skip this section and the aggregate trailer (step 9) entirely — a 100%-missing table is pure noise. Only emit when at least one commit carries a real value (`skill`, `fallback`, or `exempt`).

Harden every table cell against injection, not just subjects: escape `|` as `\|` and strip `\r`/`\n` from both commit subjects and the rendered `gate-status` value. Prefer NUL (`-z` / `%x00`) record separation, and reject any record whose fields contain the `\x1f`/`\x1e` delimiters, so an adversarial commit message cannot corrupt record or field boundaries.

```markdown
## TDD Audit

| Test commit | Impl commit | gate-status |
|---|---|---|
| `a1b2c3d` test: failing parser test | `e4f5g6h` feat: implement parser | skill |
| `i7j8k9l` test: failing export test | `m0n1o2p` feat: implement export | fallback |
| `q3r4s5t` refactor: extract helper | — | exempt |

Aggregate: 2 skill, 1 fallback, 1 exempt — 0 missing.
```

This `## TDD Audit` section is the final body section — it renders after the configured `pr_body_sections`, immediately before the aggregate trailer — so the frozen core sections and the append-only configured sections both keep their existing order.

**9. Aggregate gate-status trailer (final line)** (only when step 8 was emitted — i.e., at least one real `gate-status` value exists):

After every other section — including any configured `pr_body_sections` — emit the audit aggregate as a single Git trailer on the **final line** of the PR body, preceded by a blank line so it parses as a valid trailer:

```
gate-status: skill=2, fallback=1, exempt=1, missing=0
```

Use the exact key order `skill=`, `fallback=`, `exempt=`, `missing=` so downstream tooling parses it stably. Keeping it last means a GitHub squash-merge that defaults its commit message to the PR description carries the aggregate into `${BASE_BRANCH}`, preserving the audit footprint in `git log` after the PR branch is deleted. (Best-effort: it depends on the repo's squash-message default; the in-body `## TDD Audit` section is the source of truth regardless.)
</step>

<step name="create_pr">
Create the PR using the generated body. Write the body to a temp file first so large generated PRD sections do not hit shell argument limits:

```bash
# BSD/macOS mktemp only randomizes XXXXXX when it is the final path component, so make a
# suffixless temp then append the extension — portable across BSD + GNU (#1520).
PR_BODY_FILE=$(mktemp "${TMPDIR:-/tmp}/gsd-pr-body-XXXXXX") && mv "$PR_BODY_FILE" "${PR_BODY_FILE}.md" && PR_BODY_FILE="${PR_BODY_FILE}.md" || exit 1
trap 'rm -f "${PR_BODY_FILE:-}"' EXIT
printf '%s\n' "${PR_BODY}" > "${PR_BODY_FILE}"

gh pr create \
  --title "Phase ${PHASE_NUMBER}: ${PHASE_NAME}" \
  --body-file "${PR_BODY_FILE}" \
  --base "${BASE_BRANCH}"
```

If `--draft` flag was passed: add `--draft`.

Report: "PR #{number} created: {url}"
</step>

<step name="optional_review">

**External code review command (automated sub-step):**

Before prompting the user, check if an external review command is configured:

```bash
REVIEW_CMD=$(gsd_run query config-get workflow.code_review_command --raw 2>/dev/null || echo "")
```

If `REVIEW_CMD` is non-empty and not `"null"`, run the external review:

1. **Generate diff and stats:**
   ```bash
   DIFF=$(git diff ${BASE_BRANCH}...HEAD)
   DIFF_STATS=$(git diff --stat ${BASE_BRANCH}...HEAD)
   ```

2. **Load phase context from STATE.md:**
   ```bash
   STATE_STATUS=$(gsd_run query state.load 2>/dev/null | head -20)
   ```

3. **Build review prompt and pipe to command via stdin:**
   Construct a review prompt containing the diff, diff stats, and phase context, then pipe it to the configured command:
   ```bash
   REVIEW_PROMPT="You are reviewing a pull request.\n\nDiff stats:\n${DIFF_STATS}\n\nPhase context:\n${STATE_STATUS}\n\nFull diff:\n${DIFF}\n\nRespond with JSON: { \"verdict\": \"APPROVED\" or \"REVISE\", \"confidence\": 0-100, \"summary\": \"...\", \"issues\": [{\"severity\": \"...\", \"file\": \"...\", \"line_range\": \"...\", \"description\": \"...\", \"suggestion\": \"...\"}] }"
   # #2358: a per-run temp file (not a shared, unqualified path) so concurrent
   # ship runs — same or different phase, same or different project — never
   # clobber or read each other's stderr. Portable via ${TMPDIR:-/tmp}.
   REVIEW_STDERR_FILE=$(mktemp "${TMPDIR:-/tmp}/gsd-review-stderr-XXXXXX")
   REVIEW_OUTPUT=$(echo "${REVIEW_PROMPT}" | gsd_run run-with-timeout 120 -- ${REVIEW_CMD} 2>"${REVIEW_STDERR_FILE}")
   REVIEW_EXIT=$?
   ```

4. **Handle timeout (120s) and failure:**
   If `REVIEW_EXIT` is non-zero or the command times out:
   ```bash
   if [ $REVIEW_EXIT -ne 0 ]; then
     REVIEW_STDERR=$(cat "${REVIEW_STDERR_FILE}" 2>/dev/null)
     echo "WARNING: External review command failed (exit ${REVIEW_EXIT}). stderr: ${REVIEW_STDERR}"
     echo "Continuing with manual review flow..."
   fi
   rm -f "${REVIEW_STDERR_FILE}"
   ```
   On failure, warn with stderr output and fall through to the manual review flow below.

5. **Parse JSON result:**
   If the command succeeded, parse the JSON output and report the verdict:
   ```bash
   # Parse verdict and summary from REVIEW_OUTPUT JSON
   VERDICT=$(echo "${REVIEW_OUTPUT}" | node -e "
     let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
       try { const r=JSON.parse(d); console.log(r.verdict); }
       catch(e) { console.log('INVALID_JSON'); }
     });
   ")
   ```
   - If `verdict` is `"APPROVED"`: report approval with confidence and summary.
   - If `verdict` is `"REVISE"`: report issues found, list each issue with severity, file, line_range, description, and suggestion.
   - If JSON is invalid (`INVALID_JSON`): warn "External review returned invalid JSON" with stderr and continue.

   Regardless of the external review result, fall through to the manual review options below.

---

**Manual review options:**

Ask if user wants to trigger a code review:

**Text mode (`workflow.text_mode: true` in config or `--text` flag):** Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Gemini CLI, etc.) where `AskUserQuestion` is not available.

```
AskUserQuestion:
  question: "PR created. Run a code review before merge?"
  options:
    - label: "Skip review"
      description: "PR is ready — merge when CI passes"
    - label: "Self-review"
      description: "I'll review the diff in the PR myself"
    - label: "Request review"
      description: "Request review from a teammate"
```

**If "Request review":**
```bash
gh pr edit ${PR_NUMBER} --add-reviewer "${REVIEWER}"
```

**If "Self-review":**
Report the PR URL and suggest: "Review the diff at {url}/files"
</step>

<step name="track_shipping">
Update STATE.md to reflect the shipping action:

```bash
gsd_run query state.update "Last Activity" "$(date +%Y-%m-%d)"
gsd_run query state.update "Status" "Phase ${PHASE_NUMBER} shipped — PR #${PR_NUMBER}"
```

If `commit_docs` is true, commit the ship-note AND push it onto the PR branch so
it reaches the default branch when the PR merges. Without this push the ship-note
commit stays local-only and is silently discarded when the branch is deleted on
merge (#2138). The `[ci skip]` trailer suppresses the redundant pipeline the push
would otherwise trigger (GitHub honors `[ci skip]` / `[skip ci]`):

```bash
gsd_run query commit "docs(${padded_phase}): ship phase ${PHASE_NUMBER} — PR #${PR_NUMBER} [ci skip]" --files .planning/STATE.md
SHIP_NOTE_SHA=$(git rev-parse HEAD)
git push origin ${CURRENT_BRANCH} 2>&1 || echo "⚠ track_shipping: ship-note push failed — it is local-only; rerun: git push origin ${CURRENT_BRANCH}"

# Preserve the skip-token optimization for repositories without a required-check
# wedge; only synthesize a second CI-triggering commit when GitHub reports one (#2783).
# Poll mergeStateStatus with backoff to avoid racing GitHub's async state computation.
# Note: Skip tokens recognized by GitHub Actions are [skip ci], [ci skip], [no ci], [skip actions], [actions skip], and skip-checks:true.
# The recovery commit message MUST NOT contain any of these tokens.

STATUS="UNKNOWN"
CHECKS=0
REVIEW_DECISION=""
for i in {1..5}; do
  PR_STATE=$(gh pr view ${PR_NUMBER} --json headRefOid,mergeStateStatus,statusCheckRollup,reviewDecision -q '{head: .headRefOid, status: .mergeStateStatus, checks: ((.statusCheckRollup // []) | length), review: (.reviewDecision // "")}' 2>/dev/null || echo '{"head":"","status":"UNKNOWN","checks":0,"review":""}')
  HEAD_OID=$(echo "$PR_STATE" | jq -r .head)
  if [ "$HEAD_OID" = "$SHIP_NOTE_SHA" ]; then
    STATUS=$(echo "$PR_STATE" | jq -r .status)
    CHECKS=$(echo "$PR_STATE" | jq -r .checks)
    REVIEW_DECISION=$(echo "$PR_STATE" | jq -r .review)
  fi
  if [ "$HEAD_OID" = "$SHIP_NOTE_SHA" ] && [ "$STATUS" != "UNKNOWN" ]; then
    break
  fi
  sleep 3
done

if [ "$STATUS" = "BLOCKED" ] && [ "$CHECKS" = "0" ] && [ "$REVIEW_DECISION" != "REVIEW_REQUIRED" ] && [ "$REVIEW_DECISION" != "CHANGES_REQUESTED" ] && git log -1 --format=%B "$SHIP_NOTE_SHA" | grep -q '\[ci skip\]'; then
  echo "⚠ PR is BLOCKED with zero checks. The [ci skip] trailer wedged the PR due to required checks."
  echo "Pushing an empty commit to trigger the required pipelines..."
  # gsd_run query commit requires a file list; use git directly for this intentionally empty commit.
  git commit --allow-empty -m "chore: trigger CI (recover from ship-note skip-token)"
  git push origin ${CURRENT_BRANCH} 2>&1 || echo "⚠ track_shipping: recovery push failed — rerun: git push origin ${CURRENT_BRANCH}"
elif [ "$STATUS" = "UNKNOWN" ]; then
  echo "⚠ track_shipping: PR mergeStateStatus is UNKNOWN after polling; PR may require manual check re-trigger."
fi
```
</step>

<step name="ship_post_capability_dispatch">

> Capability-driven dispatch. Resolves active `ship:post` hooks via the capability registry; each hook's `when` is evaluated by the registry — no inline `config-get`. All `ship:post` hooks are post-ship and additive (`onError: skip`); a failure here never affects the already-created PR.

```bash
SHIP_POST_HOOKS_JSON=$(gsd_run loop render-hooks ship:post --raw)
```

Read the `activeHooks` array directly from `SHIP_POST_HOOKS_JSON` in-context (do NOT pipe it through a shell parser).

**Branch 1 — no active `ship:post` step hooks (`activeHooks` has no entry with `kind == "step"`):** Skip silently to the report.

**Generic step hook dispatch contract:** For each active entry where `kind == "step"`:
- Honor `consumes`: if it lists `UAT.md`, resolve `ls "${PHASE_DIR}"/*-UAT.md 2>/dev/null | head -1` and pass it to the dispatch; if a consumed artifact is absent, skip that hook.
- If `ref.agent` is set, first show the spawn banner, then dispatch the agent named by `ref.agent` (use the exact `ref.agent` value as the subagent type — e.g. `gsd-mempalace-curator` — never `general-purpose`):

  ```
  ◆ Spawning ship:post capability agent... (runs in a subagent — no output until it returns, ~1–2 min; expected, not a freeze)
  ```

<!-- #2508 runtime-aware-dispatch -->

> **Runtime-aware dispatch (#2508 Phase 4).** GSD workflows dispatch specialized subagents by role. Before dispatching on a built-in-only runtime (kimi-code — three built-ins only), resolve the role to a built-in via `gsd_run query resolve-dispatch-type --requested <role> --raw`. On named-dispatch runtimes (Claude/OpenCode/…) the role is returned unchanged; on kimi-code it maps to `coder`/`explore`/`plan` by role-suffix. The persona rides `${AGENT_SKILLS_<ROLE>}` (Phase 3) regardless. See @gsd-core/references/runtime-aware-dispatch.md.

  **#2684 model resolution.** `init.phase-op` emits no model field, and `ref.agent` is only known at runtime, so resolve it per hook before dispatching.

  **Input validation (defense-in-depth) — do this IN-CONTEXT, before any shell use.** `ref.agent` originates in a capability manifest, which may be third-party. Check the value you read from `activeHooks` against `^[A-Za-z0-9][A-Za-z0-9._-]*$` yourself, the same way you read `activeHooks` itself — **never** by pasting it into a shell command to be tested there. A value carrying a quote, `;`, `` ` ``, `$(`, or a newline would terminate the assignment and run as its own statement *before* any shell-side check could execute, so a shell-side check is no protection at all.

  A value that fails the check is a malformed manifest: record a warning, **skip that hook entirely**, and move to the next `activeHooks` entry. Do not dispatch it and do not place it in a command line.

  Only once the value has passed, resolve its model — substituting the validated value for `<agent>`:

  ```bash
  HOOK_AGENT_MODEL=$(gsd_run query resolve-model "<agent>" --raw 2>/dev/null || true)
  ```

  **#2517: omit the `model=` parameter entirely when `HOOK_AGENT_MODEL` is `inherit` or empty** — a capability may name an agent absent from the model-profile table, which resolves to the empty string, and passing an empty model 404s on non-Claude runtimes. Omitting inherits the orchestrator's model.

  With a resolved model (`{HOOK_AGENT_MODEL}` is the value the command above printed; `${…}` are bound shell variables):

  `Agent(subagent_type=ref.agent, prompt="Ship-time capability hook for phase ${PHASE_NUMBER}. Phase dir: ${PHASE_DIR}. Consume: ${consumed_files}. Follow your agent instructions.", model="{HOOK_AGENT_MODEL}")`

  When it resolved to `inherit` or empty, drop the parameter:

  `Agent(subagent_type=ref.agent, prompt="Ship-time capability hook for phase ${PHASE_NUMBER}. Phase dir: ${PHASE_DIR}. Consume: ${consumed_files}. Follow your agent instructions.")`
- If `ref.skill` is set, dispatch with `Skill(skill="gsd-${ref.skill}", args="${PHASE_NUMBER} --auto ${GSD_WS}")` (prepend `gsd-` to `ref.skill`).

Each dispatch is best-effort: if it errors, record a warning and continue — never re-raise (`onError: skip`).
</step>

<step name="report">
```
---

## ✓ Phase {X}: {Name} — Shipped

PR: #{number} ({url})
Branch: {branch} → ${BASE_BRANCH}
Commits: {count}
Verification: ✓ Passed
Requirements: {N} REQ-IDs addressed

Next steps:
- Review/approve PR
- Merge when CI passes
- /gsd:complete-milestone (if last phase in milestone)
- /gsd:progress (to see what's next)

---
```
</step>

</process>

<offer_next>
After shipping:

- /gsd:complete-milestone — if all phases in milestone are done
- /gsd:progress — see overall project state
- /gsd:execute-phase {next} — continue to next phase
</offer_next>

<success_criteria>
- [ ] Preflight checks passed (verification, clean tree, branch, remote, gh)
- [ ] Branch pushed to remote
- [ ] PR created with rich auto-generated body
- [ ] STATE.md updated with shipping status
- [ ] User knows PR number and next steps
</success_criteria>
