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
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
RESPONSE_LANGUAGE=$(gsd_run query config-get response_language --default "" 2>/dev/null || echo "")
INIT=$(gsd_run query init.phase-op "${PHASE_ARG}")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

**If `response_language` is set:** All user-facing questions, prompts, and explanations in this workflow MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated.

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
   STATUS=$(gsd_run query verification.status "${PHASE_DIR}" --pick status 2>/dev/null || echo "")
   ```
   Only `passed` may ship. If `$STATUS` is `passed`, verification is complete — continue to the next preflight check; do not read any further verification field.

   Any other value (including `gaps_found`, `human_needed`, `missing`, and `unknown`) blocks with `PHASE_VERIFICATION_INCOMPLETE`. Only then, read the two message fields:
   ```bash
   NEXT_ACTION=$(gsd_run query verification.status "${PHASE_DIR}" --pick next_action 2>/dev/null || echo "")
   NEXT_COMMAND=$(gsd_run query verification.status "${PHASE_DIR}" --pick next_command 2>/dev/null || echo "")
   ```
   Present `$NEXT_ACTION` to the user and, when `$NEXT_COMMAND` is non-empty, show it as the command to run next. These two are message text only — the block/allow decision has already been made from `$STATUS`, so a concurrent write between the reads cannot change the gate's verdict. The query already handles missing files and unexpected values, so no per-status arm is needed.

2. **Clean working tree?**
   ```bash
   git status --short
   ```
   If uncommitted changes exist: ask user to commit or stash first.

3. **On correct branch?**
   ```bash
   CURRENT_BRANCH=$(git branch --show-current)
   ```
   If on `${BASE_BRANCH}`: warn — should be on a feature branch.
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

6. **Security ship gate (capability-driven).**

   Resolve active `ship:pre` gate hooks from the capability registry — the registry evaluates each hook's `when` condition, so do **not** read `workflow.security_enforcement` directly:

   ```bash
   SHIP_PRE_HOOKS_JSON=$(gsd_run loop render-hooks ship:pre --raw)
   SECURITY_FILE=$(ls "${PHASE_DIR}"/*-SECURITY.md 2>/dev/null | head -1)
   ```

   Read the `activeHooks` array from `SHIP_PRE_HOOKS_JSON` in-context (do NOT pipe it through a shell parser).

   If an active entry exists with `kind == "gate"`, `capId == "security"`, and `blocking == true`, enforce its predicate (`SECURITY.md` frontmatter `threats_open == 0`) before shipping:

   - **`SECURITY_FILE` is empty** → block with `SECURITY_SHIP_GATE_NO_REVIEW`:
     ```
     ⚠ Security enforcement is enabled but no SECURITY.md exists for this phase.
     Run /gsd:secure-phase {phase} and resolve findings before shipping.
     ```
   - **`SECURITY_FILE` exists** → read its frontmatter `threats_open`. The gate passes **only** when `threats_open` is exactly `0`. For any other value — `threats_open` > 0, or a missing / non-numeric / unparsable field — **fail closed and block** with `SECURITY_SHIP_GATE_OPEN_THREATS` (the predicate is strict equality to `0`; never ship on an ambiguous value):
     ```
     ⚠ Security ship gate: SECURITY.md does not assert threats_open == 0 (found: {threats_open|unset}).
     Resolve open threats (or re-run /gsd:secure-phase {phase}) before shipping.
     ```

   If no active security `ship:pre` gate hook is present (security enforcement off), skip this check silently.

7. **Broken-windows ship gate (capability-driven, issue #1950).**

   The `SHIP_PRE_HOOKS_JSON` resolved in step 6 already includes any `broken-windows` gate. Inspect `activeHooks` for an entry with `capId == "broken-windows"` and `kind == "gate"`:

   ```bash
   WINDOWS_GATE_ACTIVE=$(printf '%s' "$SHIP_PRE_HOOKS_JSON" | jq -r \
     '.activeHooks[]? | select(.capId == "broken-windows" and .kind == "gate" and .blocking == true) | .capId' \
     2>/dev/null | head -1)
   ```

   If `$WINDOWS_GATE_ACTIVE` is non-empty, enforce the gate by reading the ledger's typed status. The ledger lives at the **project root** (cross-phase, not phase-scoped):

   ```bash
   WINDOWS_STATUS_JSON=$(gsd_run windows status --raw 2>/dev/null || echo '')
   WINDOWS_OPEN_COUNT=$(printf '%s' "$WINDOWS_STATUS_JSON" | jq -r '.ledger.open_count // "?"' 2>/dev/null || echo '?')
   ```

   - **`WINDOWS_OPEN_COUNT == "0"`** → gate passes; continue to the next preflight check.
   - **`WINDOWS_OPEN_COUNT` is a positive integer** → block with `WINDOWS_SHIP_GATE_OPEN`:
     ```
     ⚠ Broken-windows ship gate: WINDOWS.md has {WINDOWS_OPEN_COUNT} open window(s).
     Resolve each entry before shipping, or explicitly waive with a recorded reason:
       gsd-tools windows fixed <id>      # defect resolved
       gsd-tools windows waive <id> "<reason>"   # justified deferral (reason required)
     Then re-run /gsd:ship.
     ```
   - **`WINDOWS_OPEN_COUNT` is `"?"`, empty, or non-numeric** → **fail closed and block** with `WINDOWS_SHIP_GATE_READ_FAILED` (the gate is strict equality to `0`; never ship on an unreadable ledger):
     ```
     ⚠ Broken-windows ship gate: could not read open_count from .planning/WINDOWS.md.
     Inspect the file or run `gsd-tools windows status --raw` to diagnose. The ledger
     may be malformed; fix it before shipping (an unparseable ledger is a broken window).
     ```

   The ledger is **optional and backward-compatible**: on a project where `gsd_run windows status` returns `open_count: 0` (no `.planning/WINDOWS.md` yet, or an empty ledger), the gate passes silently. The gate only blocks when at least one entry is `open`.

   If no active `broken-windows` `ship:pre` gate hook is present (gate disabled via `workflow.windows_enforce=false`, the default — tracking continues but the gate is opt-in), skip this check silently.
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

Reconstruct the per-commit TDD gate trail before squash-merge discards it. Walk the PR branch's own commits (merges excluded) and read each commit's `gate_status:` trailer with Git's native trailer machinery — never a raw `%B` grep, which would also match the string written in prose:

```bash
# Anchor on the merge-base so a stale local ${BASE_BRANCH} ref cannot over-count.
RANGE_BASE=$(git merge-base "${BASE_BRANCH}" HEAD)
git log "${RANGE_BASE}..HEAD" --no-merges --reverse \
  --format='%H%x1f%s%x1f%(trailers:key=gate_status,valueonly,separator=%x2c)%x1e'
```

Records are separated by `\x1e`; the fields inside each are `\x1f`-separated — `<sha>`, `<subject>`, `<gate_status value>`.

Pair commits by their conventional-commit type (the `type:` prefix of the subject):

- A `test:` commit is the RED row. Pair it with the next following **implementation** commit — a `feat:` or `fix:` — as its **Impl commit** (the GREEN step), skipping over any intervening `refactor:`, `docs:`, or `chore:` commits so they are never mistaken for the GREEN step.
- A `refactor:`, `docs:`, or `chore:` commit that is not consumed as an Impl pairing is a standalone row with Impl commit `—`.
- A `feat:`/`fix:` commit with no preceding unpaired `test:` is a standalone row.

Surface each commit's `gate_status:` value, normalized to exactly one of `skill`, `fallback`, `exempt`, or `missing` — never the raw trailer text. A commit whose trailer is absent, whose value is none of the first three, or which carries more than one `gate_status:` trailer (ambiguous) is counted as **missing** and still listed. This section is informational; it never blocks the ship.

**Self-suppress when every commit is missing (#2431):** the execute pipeline only writes `gate_status:` trailers when TDD mode is active. If every commit in the scan normalizes to `missing`, skip this section and the aggregate trailer (step 9) entirely — a 100%-missing table is pure noise. Only emit when at least one commit carries a real value (`skill`, `fallback`, or `exempt`).

Harden every table cell against injection, not just subjects: escape `|` as `\|` and strip `\r`/`\n` from both commit subjects and the rendered `gate_status` value. Prefer NUL (`-z` / `%x00`) record separation, and reject any record whose fields contain the `\x1f`/`\x1e` delimiters, so an adversarial commit message cannot corrupt record or field boundaries.

```markdown
## TDD Audit

| Test commit | Impl commit | gate_status |
|---|---|---|
| `a1b2c3d` test: failing parser test | `e4f5g6h` feat: implement parser | skill |
| `i7j8k9l` test: failing export test | `m0n1o2p` feat: implement export | fallback |
| `q3r4s5t` refactor: extract helper | — | exempt |

Aggregate: 2 skill, 1 fallback, 1 exempt — 0 missing.
```

This `## TDD Audit` section is the final body section — it renders after the configured `pr_body_sections`, immediately before the aggregate trailer — so the frozen core sections and the append-only configured sections both keep their existing order.

**9. Aggregate gate_status trailer (final line)** (only when step 8 was emitted — i.e., at least one real `gate_status` value exists):

After every other section — including any configured `pr_body_sections` — emit the audit aggregate as a single Git trailer on the **final line** of the PR body, preceded by a blank line so it parses as a valid trailer:

```
gate_status: skill=2, fallback=1, exempt=1, missing=0
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
git push origin ${CURRENT_BRANCH} 2>&1 || echo "⚠ track_shipping: ship-note push failed — it is local-only; rerun: git push origin ${CURRENT_BRANCH}"
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

  `Agent(subagent_type=ref.agent, prompt="Ship-time capability hook for phase ${PHASE_NUMBER}. Phase dir: ${PHASE_DIR}. Consume: ${consumed_files}. Follow your agent instructions.", model="{balanced_model}")`
- If `ref.skill` is set, dispatch with `Skill(skill="gsd-${ref.skill}", args="${PHASE_NUMBER} --auto ${GSD_WS}")` (prepend `gsd-` to `ref.skill`).

Each dispatch is best-effort: if it errors, record a warning and continue — never re-raise (`onError: skip`).
</step>

<step name="report">
```
───────────────────────────────────────────────────────────────

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

───────────────────────────────────────────────────────────────
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
