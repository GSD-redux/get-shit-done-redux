@~/.claude/gsd-core/references/response-language-directive.md

<purpose>
Cross-AI peer review — invoke external AI CLIs to independently review phase plans.
Each CLI gets the same prompt (PROJECT.md context, phase plans, requirements) and
produces structured feedback. Results are combined into REVIEWS.md for the planner
to incorporate via --reviews flag.

This implements adversarial review: different AI models catch different blind spots.
A plan that survives review from 2-3 independent AI systems is more robust.
</purpose>

<process>

<step name="detect_clis">
Check which AI CLIs are available on the system:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
# Check each CLI
command -v gemini >/dev/null 2>&1 && echo "gemini:available" || echo "gemini:missing"
command -v claude >/dev/null 2>&1 && echo "claude:available" || echo "claude:missing"
command -v codex >/dev/null 2>&1 && echo "codex:available" || echo "codex:missing"
command -v coderabbit >/dev/null 2>&1 && echo "coderabbit:available" || echo "coderabbit:missing"
command -v opencode >/dev/null 2>&1 && echo "opencode:available" || echo "opencode:missing"
command -v qwen >/dev/null 2>&1 && echo "qwen:available" || echo "qwen:missing"
command -v cursor-agent >/dev/null 2>&1 && echo "cursor:available" || echo "cursor:missing"
command -v agy >/dev/null 2>&1 && echo "antigravity:available" || echo "antigravity:missing"
command -v kimi >/dev/null 2>&1 && echo "kimi-code:available" || echo "kimi-code:missing"

# Check local model servers (OpenAI-compatible HTTP API — no CLI binary required)
OLLAMA_HOST=$(gsd_run query config-get review.ollama_host --raw 2>/dev/null || echo "")
if [ -z "$OLLAMA_HOST" ] || [ "$OLLAMA_HOST" = "null" ]; then OLLAMA_HOST="http://localhost:11434"; fi
curl -s --max-time 2 "${OLLAMA_HOST}/v1/models" >/dev/null 2>&1 && echo "ollama:available" || echo "ollama:missing"

LM_STUDIO_HOST=$(gsd_run query config-get review.lm_studio_host --raw 2>/dev/null || echo "")
if [ -z "$LM_STUDIO_HOST" ] || [ "$LM_STUDIO_HOST" = "null" ]; then LM_STUDIO_HOST="http://localhost:1234"; fi
curl -s --max-time 2 "${LM_STUDIO_HOST}/v1/models" >/dev/null 2>&1 && echo "lm_studio:available" || echo "lm_studio:missing"

LLAMA_CPP_HOST=$(gsd_run query config-get review.llama_cpp_host --raw 2>/dev/null || echo "")
if [ -z "$LLAMA_CPP_HOST" ] || [ "$LLAMA_CPP_HOST" = "null" ]; then LLAMA_CPP_HOST="http://localhost:8080"; fi
curl -s --max-time 2 "${LLAMA_CPP_HOST}/v1/models" >/dev/null 2>&1 && echo "llama_cpp:available" || echo "llama_cpp:missing"

# jq prerequisite (#2589). The config/model/budget lookups in this workflow no
# longer need jq — they use the native --raw/--pick flags. But the lanes listed
# under "jq-dependent reviewer lanes" below parse structured JSON that gsd-tools
# does not emit (OpenAI-compatible /v1/chat/completions responses, opencode's
# JSONL event stream, agy's conversation cache), so they cannot run without jq.
# Probe it here rather than letting each lane swallow exit 127 into empty output.
command -v jq >/dev/null 2>&1 && echo "jq:available" || echo "jq:missing"
```

**jq-dependent reviewer lanes.** `jq` is a production prerequisite for the
`ollama`, `lm_studio`, `llama_cpp`, `opencode`, and `antigravity` lanes only. If
`detect_clis` reports `jq:missing`, treat those five as **undetected** — they
follow the same "known-but-undetected" path as a missing CLI. Which path that is
depends on how the lane was selected (see the precedence rules below): reached
through `review.default_reviewers` or `--all` it is an info note and the lane is
ignored; named by an explicit flag it is an **error**, because the user asserted
that lane. Tell the user to install jq:

```
NOTE: jq is not on PATH — the ollama, lm_studio, llama_cpp, opencode, and
antigravity reviewer lanes are unavailable. Install jq (https://jqlang.org/download/)
or select a lane that does not require it (--gemini, --claude, --codex,
--coderabbit, --qwen, --cursor).
```

The remaining lanes (`gemini`, `claude`, `codex`, `coderabbit`, `qwen`, `cursor`)
do not require jq and must stay selectable on a jq-less host.

Parse flags from `$ARGUMENTS`:
- `--gemini` → include Gemini
- `--claude` → include Claude
- `--codex` → include Codex
- `--coderabbit` → include CodeRabbit
- `--opencode` → include OpenCode
- `--qwen` → include Qwen Code
- `--cursor` → include Cursor
- `--agy` or `--antigravity` → include Antigravity CLI
- `--kimi-code` → include Kimi CLI
- `--ollama` → include Ollama (local server, OpenAI-compatible)
- `--lm-studio` → include LM Studio (local server, OpenAI-compatible)
- `--llama-cpp` → include llama.cpp (local server, OpenAI-compatible)
- `--all` → include all available (CLIs + running local servers)
- No flags → if `review.default_reviewers` is set, include only configured reviewers that are detected; otherwise include all available

Reviewer-selection precedence:
1. Individual reviewer flags (`--gemini`, `--codex`, etc.)
2. `--all`
3. `review.default_reviewers`
4. No key + no flags → all detected reviewers

**Explicit reviewer flags are an assertion, not a preference (ADR-2782 D4).** A lane the user
named on the command line and that cannot run is an **error**, surfaced and non-silent — even
when other named lanes did run. Do not proceed with a thinner reviewer set and report success:
`--gemini --qwen` on a host without `qwen` fails, it does not quietly become a Gemini-only
review. This applies however the lane became unavailable — binary missing, prerequisite `jq`
absent, or a local server not reachable.

The asymmetry is deliberate: *not finding a lane nobody asked for is normal; failing to run a
lane somebody asked for is an error.* A user who wants "whatever is available" has `--all`; a
user who wants a preferred set has `review.default_reviewers`. Both stay lenient below.

`review.default_reviewers` behavior:
- Value must be a non-empty array of slug strings (configured via `gsd config-set review.default_reviewers '["gemini","codex"]'`)
- Unknown slugs warn and are ignored
- Known-but-undetected slugs emit an info note and are ignored — a configured default is a
  preference evaluated across many hosts, so a subset being present is expected, not an error
- If all configured reviewers are unavailable, fail with an actionable message

<!-- gsd:section id="reviewer-instances-note-1" when="state:reviewer-instances-configured" -->
If `section_manifest` is `null` or `"reviewer-instances-note-1"` is in its `included` list: read and execute `gsd-core/workflows/review/steps/reviewer-instances-note-1.md`. Otherwise skip — do not read the file.
<!-- /gsd:section -->

If no CLIs are available:
```
No external AI CLIs found. Install at least one:
- gemini: https://github.com/google-gemini/gemini-cli
- codex: https://github.com/openai/codex
- claude: https://github.com/anthropics/claude-code
- opencode: https://opencode.ai (leverages GitHub Copilot subscription models)
- qwen: https://github.com/nicepkg/qwen-code (Alibaba Qwen models)
- cursor: https://cursor.com (Cursor IDE agent mode)
- agy: curl -fsSL https://antigravity.google/cli/install.sh | bash (Antigravity CLI — free with Google credentials)

Then run /gsd:review again.
```
Exit.

Determine which CLI to skip based on the current runtime environment:

```bash
# Environment-based runtime detection (priority order)
if [ "$ANTIGRAVITY_AGENT" = "1" ]; then
  # Antigravity is a separate client — all CLIs are external, skip none
  SELF_CLI="none"
elif [ -n "$CURSOR_SESSION_ID" ]; then
  # Running inside Cursor agent — skip cursor for independence
  SELF_CLI="cursor"
elif [ -n "$CLAUDE_CODE_ENTRYPOINT" ]; then
  # Running inside Claude Code CLI — skip claude for independence
  SELF_CLI="claude"
else
  # Other environments (Gemini CLI, Codex CLI, etc.)
  # Fall back to AI self-identification to decide which CLI to skip
  SELF_CLI="auto"
fi
```

Rules:
- If `SELF_CLI="none"` → invoke ALL available CLIs (no skip)
- If `SELF_CLI="claude"` → skip claude, use gemini/codex
- If `SELF_CLI="auto"` → the executing AI identifies itself and skips its own CLI
- At least one DIFFERENT CLI must be available for the review to proceed.
</step>

<step name="gather_context">
Collect phase artifacts for the review prompt:

```bash
INIT=$(gsd_run query init.review "${PHASE_ARG}")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi

# #2358: ONE run-scoped temp dir (portable via ${TMPDIR:-/tmp}) so overlapping
# runs never collide or read each other's stale files.
RUN_DIR=$(mktemp -d "${TMPDIR:-/tmp}/gsd-review-XXXXXX")
echo "RUN_DIR=$RUN_DIR"
```

Read from init: `phase_dir`, `phase_number`, `padded_phase`.

Capture `RUN_DIR` above (created ONCE) and thread it into every `{run_dir}`
placeholder and `$RUN_DIR`/`${RUN_DIR}` reference within a bash block. Do NOT
re-run `mktemp -d` later — every block must resolve to this same directory, or
`build_prompt`'s writes and `invoke_reviewers`' reads split.

Then read:
1. `.planning/PROJECT.md` (first 80 lines — project context)
2. Phase section from `.planning/ROADMAP.md`
3. All `*-PLAN.md` files in the phase directory
4. `*-CONTEXT.md` if present (user decisions)
5. `*-RESEARCH.md` if present (domain research)
6. `.planning/REQUIREMENTS.md` (requirements this phase addresses)
</step>

<step name="build_prompt">
Build a structured review prompt:

```markdown
# Cross-AI Plan Review Request

You are reviewing implementation plans for a software project phase.
Provide structured feedback on plan quality, completeness, and risks.

## Project Context
{first 80 lines of PROJECT.md}

## Phase {N}: {phase name}
### Roadmap Section
{roadmap phase section}

### Requirements Addressed
{requirements for this phase}

### User Decisions (CONTEXT.md)
{context if present}

### Research Findings
{research if present}

### Plans to Review
For each `*-PLAN.md` in the phase directory, in glob order, include its full content preceded by a `####` header carrying the plan's **repo-relative path** (e.g. `#### .planning/phases/<phase>/<NN>-PLAN.md`). The path header is the citable anchor for findings about the plan itself — cite it as `<repo-relative plan path>:<line>` (name the heading in prose beside the citation if it helps the reader); reserve `path:line` for repo files the plan references.
{per-plan: `#### <repo-relative plan path>` + full plan contents}

## Review Instructions

**Verify against source — do not review the plan text in isolation.** The plans reference real files, migrations, routes, and tests in this repo.
1. Open the referenced files and check each claim against the actual code.
2. For every strength or concern, cite concrete `path/to/file:line` evidence plus the mechanism.
3. When a plan asserts a mechanism works (a guard, a query filter, a test that exercises a path), trace whether it actually does what is claimed — do not take the plan's word for it.
4. If you cannot read the repo (no file access), say so and downgrade that finding to an open question rather than asserting it.

Findings citing `file:line` evidence are weighted far more heavily than impressionistic ones; a review that only restates the plan's own claims has low value.

**Plan coverage is mandatory (#3301).** The exact list of plan ids and the total plan count for
this review are given in the "## Plan Coverage Manifest" section below. Give **every** listed id
its own `##`-level section headed with that id **verbatim** (e.g. `## 12.6-01`) before writing any
cross-plan comparison, an overall risk assessment, or a consensus-style summary. A review that
stops before every id has its own section is an incomplete review, not a summary — if you must
stop early, say so explicitly and name which ids you did not reach.

Analyze each plan and provide:

1. **Summary** — One-paragraph assessment
2. **Strengths** — What's well-designed (bullet points)
3. **Concerns** — Potential issues, gaps, risks (bullet points with severity: HIGH/MEDIUM/LOW)
4. **Suggestions** — Specific improvements (bullet points)
5. **Risk Assessment** — Overall risk level (LOW/MEDIUM/HIGH) with justification

Focus on:
- Missing edge cases or error handling
- Dependency ordering issues
- Scope creep or over-engineering
- Security considerations
- Performance implications
- Whether the plans actually achieve the phase goals

Output your review in markdown format.
```

Write to a temp file: `{run_dir}/gsd-review-prompt.md`

Also write individual section files so the budget tool can re-trim per reviewer:

```bash
# #2962: zsh aborts the block on an unmatched for-list glob (nomatch); bash passes it through. nullglob both.
shopt -s nullglob 2>/dev/null; setopt NULL_GLOB 2>/dev/null

RUN_DIR="{run_dir}"   # from gather_context

# Write individual section files for per-reviewer budget trimming
# These are always written so reviewers with a budget can invoke prompt-budget
cp "$INSTRUCTIONS_BLOCK_FILE" "${RUN_DIR}/gsd-review-instructions.md"
cp "$ROADMAP_SECTION_FILE" "${RUN_DIR}/gsd-review-roadmap.md"

# Plan files: copy each PLAN.md to a predictable path named after its source
# plan id (#3959: a bare padded index discards provenance — the budget tool's
# per-plan `### <file>` header then renders a run-dir artifact name no reviewer
# or consensus step can resolve. The plan id keeps the gsd-review-plan-*.md glob
# prepare_trimmed_prompt_for_reviewer consumes.)
for PLAN_FILE in "${PHASE_DIR}"/*-PLAN.md; do
  PLAN_BASENAME=$(basename "$PLAN_FILE")
  PLAN_ID="${PLAN_BASENAME%-PLAN.md}"
  cp "$PLAN_FILE" "${RUN_DIR}/gsd-review-plan-${PLAN_ID}.md"
done

# #3301: plan coverage manifest — tell reviewers exactly which plan ids exist and
# how many there are, so a review that silently covers 6 of 7 plans is no longer
# indistinguishable from one that covers all 7. The id is the plan file's own
# basename with the `-PLAN.md` suffix stripped (e.g. `12.6-01-PLAN.md` ->
# `12.6-01`) — NOT the `plan:` frontmatter key, which holds only the bare
# in-phase sequence number ("01") and can never reconstruct the phase-qualified
# id reviewers need to cite. The filename is guaranteed present for every copied
# plan, so no plan is ever dropped from the manifest for lacking a key.
# Count and bullets are both derived directly from the glob loop below, never
# from re-splitting an accumulated string: bash word-splits an unquoted `$VAR`
# on IFS by default, but zsh does not (no `setopt SH_WORD_SPLIT` here), so a
# prior `PLAN_IDS="$PLAN_IDS $id"` + `for x in $PLAN_IDS` round-trip silently
# collapsed every id onto one iteration under zsh whenever there were 2+ plans
# (gsd-core#4099). Direct glob iteration (`for f in "${PHASE_DIR}"/*-PLAN.md`,
# same pattern as the copy loop above) is identical under both shells, so this
# never needs word-splitting at all.
PLAN_COUNT=0
PLAN_ID_BULLETS=""
for PLAN_FILE in "${PHASE_DIR}"/*-PLAN.md; do
  PLAN_BASENAME=$(basename "$PLAN_FILE")
  PLAN_ID="${PLAN_BASENAME%-PLAN.md}"
  PLAN_COUNT=$((PLAN_COUNT + 1))
  PLAN_ID_BULLETS="${PLAN_ID_BULLETS}- ${PLAN_ID}
"
done

# Named to avoid BOTH existing RUN_DIR globs: `gsd-review-*.md` (reviewer
# reports, invoke_reviewers) and `gsd-review-plan-*.md` (the plan copies just
# above) — a manifest matching either would be picked up as a report or as a
# plan to review.
{
  echo ""
  echo "## Plan Coverage Manifest"
  echo ""
  echo "Total plans in this review: ${PLAN_COUNT}"
  echo ""
  echo "Plan ids (give each one its own \`##\`-level section, headed verbatim):"
  printf '%s' "$PLAN_ID_BULLETS"
} > "${RUN_DIR}/.plans-manifest.md"

# Optional section files (only if content was included in the combined prompt)
if [ -f ".planning/PROJECT.md" ]; then
  cp .planning/PROJECT.md "${RUN_DIR}/gsd-review-project.md"
fi
_CTX=( "${PHASE_DIR}"/*-CONTEXT.md )
if [ ${#_CTX[@]} -gt 0 ]; then
  cat "${_CTX[@]}" > "${RUN_DIR}/gsd-review-context.md"
fi
_RESEARCH=( "${PHASE_DIR}"/*-RESEARCH.md )
if [ ${#_RESEARCH[@]} -gt 0 ]; then
  cat "${_RESEARCH[@]}" > "${RUN_DIR}/gsd-review-research.md"
fi
if [ -f ".planning/REQUIREMENTS.md" ]; then
  cp .planning/REQUIREMENTS.md "${RUN_DIR}/gsd-review-requirements.md"
fi

# #3301: append the manifest to BOTH files reviewers actually read — the
# per-lane budget-trimmed instructions file (descriptor lanes get
# `--instructions-file`) and the full combined prompt (combined-prompt lanes
# read the whole file). The `instructions` fragment is in prompt-budget's
# `minimumFor` floor set and is never trimmed, so this survives per-lane
# budget trimming intact.
cat "${RUN_DIR}/.plans-manifest.md" >> "${RUN_DIR}/gsd-review-instructions.md"
cat "${RUN_DIR}/.plans-manifest.md" >> "${RUN_DIR}/gsd-review-prompt.md"
```

Note: `INSTRUCTIONS_BLOCK_FILE`, `ROADMAP_SECTION_FILE`, and `PHASE_DIR` come from prompt assembly; `RUN_DIR` is the run-scoped dir from `gather_context` (#2358) re-assigned from `{run_dir}` above. Copy the temp files written during prompt assembly to these section paths (or write each section here if the prompt was built inline).
</step>

<step name="invoke_reviewers">
Every reviewer lane is **declared data** (ADR-2782). This step iterates the lanes the selection
resolved; it does not enumerate them. Adding a reviewer is a capability manifest, not an edit here.

**Do not re-add a per-CLI block.** A `<!-- reviewer-lane: … -->` marker anywhere in this step now
FAILS the parity gate (`checkReviewerLaneParity` → `bespoke_leg_present`). Lane divergence is
declared in the manifest — timeout floor, probe, prompt/output channel, empty-output policy — and
behaviour that data genuinely cannot express is a named first-party `handler` (ADR-2782 D6), never
a bespoke block here.

**Effort and model resolution (#4255).** A lane's reasoning effort and model each resolve through
their own declared key, and the resolution order is inspectable rather than implicit:

| piece | order, highest first |
|---|---|
| model | pinned reviewer-instance `--model` → the lane's `modelConfigKey` (`review.models.<slug>`) → the CLI's own default |
| effort | the lane's `effortConfigKey` (`review.effort.<slug>`) → the lane's declared `defaultEffort` → **nothing emitted**, so the CLI's own configuration applies |

Both come from the LANE. Effort in particular is never read from an agent's execution settings:
until #4255 it was resolved by querying `gsd-plan-checker`, so every prompt-fed lane ran at that
verifier's `low` and, because the rendered argument is a CLI config override, it silently beat the
effort the operator had configured for the reviewer CLI itself. A lane that declares no effort
emits no argument at all — a value borrowed from an unrelated agent is worse than no value.

**Timeout guidance (#2194):** prompt-fed source-grounded reviews are slow — measured ~570 s for
Codex at `xhigh` effort and ~525 s for headless Claude on a large plan set. Each lane declares its
own `timeoutFloorMs` and the runner enforces it internally, but the **Bash tool call wrapping the
loop below must still be given a high `timeout:`** — at least `900000`, and `1200000` when Codex or
headless Claude are in the selection — or the host kills the whole loop mid-lane. On Claude Code,
raise the host cap via `BASH_MAX_TIMEOUT_MS` if a review can exceed it.

A silent empty output after a long run is a **timeout kill, not a crash** — the Codex `0xc0000142`
misdiagnosis persisted for exactly this reason, because an empty result cannot distinguish the two
on its own. Treat an empty result on a slow lane as a dropped lane and re-run with more time rather
than diagnosing a CLI or sandbox failure. A cross-AI review that silently drops a lane is blind in
one eye.

**No hook-trust bypass (#2479):** no lane passes a hook-trust bypass flag and none runs a capability
probe for one. That flag only bypasses *persisted* hook trust (a first-run condition) and flagless
invocations work in steady state, while host-harness safety classifiers deny commands carrying it.
An environment that genuinely hits an untrusted-hook prompt surfaces through the `.err` capture and
the empty-output stub as a dropped lane with diagnosable stderr, not silent attrition. Do not
reintroduce the flag (even spelled out in prose — a regression test bans the literal file-wide).

<!-- gsd:section id="reviewer-instances-note-2" when="state:reviewer-instances-configured" -->
If `section_manifest` is `null` or `"reviewer-instances-note-2"` is in its `included` list: read and execute `gsd-core/workflows/review/steps/reviewer-instances-note-2.md`. Otherwise skip — do not read the file.
<!-- /gsd:section -->

Lanes run **sequentially by default** — concurrent invocation trips provider rate limits, and a lane
lost to one is a cross-AI review that quietly went blind in one eye. A project whose providers can
accept the concurrency opts in with `review.parallel_lanes: true` (#3034): the selected lanes are
dispatched together and **all** joined before aggregation. The default is unchanged, and convergence
cycles stay sequential either way — only the lanes *within* one pass overlap.

```bash
# #2962: zsh aborts the block on an unmatched for-list glob (nomatch); bash passes it through. nullglob both.
shopt -s nullglob 2>/dev/null; setopt NULL_GLOB 2>/dev/null

RUN_DIR="{run_dir}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# SELECTED_REVIEWERS is the comma-separated result of reviewer selection (ADR-0011 precedence:
# explicit flags > --all > review.default_reviewers > all detected). Unchanged by this phase.

# #3034: opt-in concurrent lane dispatch. STRICT equality on "true" is deliberate — "1", "yes" and
# "TRUE" must NOT opt in, so a mistyped config gets the conservative behaviour rather than firing
# concurrent requests at a rate-limited provider. Note the `|| echo "false"` fallback is the
# OPPOSITE polarity from the commit_docs guard, which fails OPEN: there, failing open preserves the
# user's intent; here it would fire exactly the requests the default exists to prevent.
PARALLEL_LANES=$(gsd_run query config-get review.parallel_lanes --raw 2>/dev/null || echo "false")

# Shared budget-trim helper. Was defined inside the Ollama leg; it is lane-agnostic, so it is
# hoisted here now that any lane may declare a promptBudgetKey. Returns non-zero when the budget
# is too small for the minimum review set (prompt-budget exit 2 / 11).
prepare_trimmed_prompt_for_reviewer() {
  REVIEWER_KEY="$1"; REVIEWER_BUDGET="$2"; OUTPUT_PROMPT="$3"; OUTPUT_META="$4"

  PLAN_FILE_ARGS=""
  for p in "$RUN_DIR"/gsd-review-plan-*.md; do
    [ -f "$p" ] && PLAN_FILE_ARGS="$PLAN_FILE_ARGS --plan-file $p"
  done
  PROJECT_ARG=""
  [ -f "$RUN_DIR/gsd-review-project.md" ] && PROJECT_ARG="--project-file $RUN_DIR/gsd-review-project.md"
  CONTEXT_ARG=""
  [ -f "$RUN_DIR/gsd-review-context.md" ] && CONTEXT_ARG="--context-file $RUN_DIR/gsd-review-context.md"
  RESEARCH_ARG=""
  [ -f "$RUN_DIR/gsd-review-research.md" ] && RESEARCH_ARG="--research-file $RUN_DIR/gsd-review-research.md"
  REQUIREMENTS_ARG=""
  [ -f "$RUN_DIR/gsd-review-requirements.md" ] && REQUIREMENTS_ARG="--requirements-file $RUN_DIR/gsd-review-requirements.md"

  gsd_run query prompt-budget \
    --budget "$REVIEWER_BUDGET" \
    --instructions-file "$RUN_DIR/gsd-review-instructions.md" \
    --roadmap-file "$RUN_DIR/gsd-review-roadmap.md" \
    $PLAN_FILE_ARGS $PROJECT_ARG $CONTEXT_ARG $RESEARCH_ARG $REQUIREMENTS_ARG \
    --output-prompt "$OUTPUT_PROMPT" \
    --output-metadata "$OUTPUT_META"
  return $?
}

gsd_run query review-lane plan \
  --selected "$SELECTED_REVIEWERS" --run-dir "$RUN_DIR" --repo-root "$REPO_ROOT" --json \
  > "$RUN_DIR/gsd-review-lanes.json"

# One lane, start to finish. Hoisted into a function so the sequential and concurrent paths share
# ONE body: two dispatch bodies kept in sync by hand is the generative-fix divergence ADR-2782 spent
# a phase deleting, and it is what let #2494/#2605 be filed twice as the same defect.
#
# The result goes to a SLUG-SCOPED file, never a shared append. Concurrent O_APPEND is atomic only
# below PIPE_BUF (4096 on Linux, 512 on some platforms), so a lane result above that bound could
# interleave — and write_reviews parses this JSONL to render the models:/model_sources: frontmatter,
# so a torn line is a broken REVIEWS.md, not a cosmetic log defect.
run_review_lane() {
  # `local` is hygiene, not a live fix: each `&`-dispatched call already forks its own subshell, so
  # concurrent lanes cannot share these today. Scoped anyway so the isolation is a property of this
  # function rather than of the dispatch mechanism happening to fork.
  local SLUG LANE_BUDGET PROMPT_ARG TRIMMED
  SLUG="$1"
  # Per-lane prompt budget. The lane declares its own `promptBudgetKey`; `plan` resolved it,
  # applying #2797's sentinel rule (-1 = unset → fall back to the global budget; 0 legitimately
  # means "do not trim this lane"). Trimming itself stays in prompt-budget, which owns it.
  LANE_BUDGET=$(gsd_run query review-lane plan --selected "$SLUG" --run-dir "$RUN_DIR" \
                  --repo-root "$REPO_ROOT" --json 2>/dev/null \
                | sed -n 's/.*"promptBudget": *\([0-9-]*\).*/\1/p' | head -1)
  PROMPT_ARG=""
  if [ -n "$LANE_BUDGET" ] && [ "$LANE_BUDGET" != "null" ] && [ "$LANE_BUDGET" -gt 0 ] 2>/dev/null; then
    TRIMMED="$RUN_DIR/gsd-review-prompt-$SLUG.md"
    if prepare_trimmed_prompt_for_reviewer "$SLUG" "$LANE_BUDGET" "$TRIMMED" \
         "$RUN_DIR/gsd-review-prompt-$SLUG.metadata.json"; then
      PROMPT_ARG="--prompt-file $TRIMMED"
    else
      # A budget too small for the minimum review set drops the lane just as silently as an empty
      # response used to (#2605), so leave the skip visible in the review output, not only on stderr.
      echo "$SLUG review skipped: prompt budget (${LANE_BUDGET} tokens) too small for the minimum review set." \
        > "$RUN_DIR/gsd-review-$SLUG.md"
      # Was `continue` when this was a loop body. Inside a function that keyword is not the loop
      # control it looks like — `return 0` is what skips this lane and leaves it with no result line.
      return 0
    fi
  fi

  # One invocation, whatever the lane's transport, prompt channel, output channel or handler.
  # `--explicit` marks a lane the user NAMED: ADR-2782 D4 — not finding a lane nobody asked for is
  # normal, failing to run one somebody asked for is an error.
  gsd_run query review-lane invoke --slug "$SLUG" \
    --run-dir "$RUN_DIR" --repo-root "$REPO_ROOT" $PROMPT_ARG $EXPLICIT_FLAG --json \
    > "$RUN_DIR/gsd-review-lane-result-$SLUG.json"
}

# Split ONCE, de-duplicated, and reuse for both loops below. Two reasons, and the second is
# load-bearing: a slug repeated in SELECTED_REVIEWERS would put TWO concurrent background jobs on
# `> "$RUN_DIR/gsd-review-lane-result-$SLUG.json"` — the same file, both truncating. The shared-append
# form this replaced could not corrupt itself that way, so de-duping is what keeps the concurrent
# path no worse than the sequential one. Selection de-dupes today (the roster is a Set;
# review.default_reviewers normalizes lowercase-unique), but reachability analysis is not a contract
# and the next caller should not have to redo it.
#
# A plain string accumulator, not an array: zsh and bash disagree on array indexing and this block
# runs under both (see the nullglob/NULL_GLOB pairing above).
DISPATCH_SLUGS=""
for SLUG in $(echo "$SELECTED_REVIEWERS" | tr ',' ' '); do
  case " $DISPATCH_SLUGS " in
    *" $SLUG "*) continue ;;
  esac
  DISPATCH_SLUGS="$DISPATCH_SLUGS $SLUG"
done

# Rewrapped through unquoted command substitution, not consumed as a bare
# `$DISPATCH_SLUGS`: bash word-splits an unquoted scalar on IFS by default,
# but zsh does not, so a bare re-split collapsed every slug onto one
# iteration under zsh whenever 2+ reviewers were selected (gsd-core#4109).
# Unquoted `$(...)` re-splits identically under both shells regardless of
# `SH_WORD_SPLIT` — same reason the accumulator-building loop above already
# works under both.
for SLUG in $(printf '%s' "$DISPATCH_SLUGS"); do
  if [ "$PARALLEL_LANES" = "true" ]; then
    run_review_lane "$SLUG" &
  else
    run_review_lane "$SLUG"
  fi
done

# Join every dispatched lane. A bare `wait` with no background jobs returns 0, so the sequential
# path needs no guard around it. NOTHING below this line may run before every lane has finished —
# write_reviews renders REVIEWS.md and the consensus summary from the aggregate below, and a review
# assembled from a partial set looks complete while silently missing a reviewer.
wait

# Aggregate in SELECTED_REVIEWERS order, NOT completion order, so the JSONL a concurrent run
# produces is byte-identical to the one a sequential run produces. This is post-join and therefore
# single-threaded, so `>>` here is safe. A lane that was budget-skipped, or that never started,
# leaves no result file and correctly contributes no line.
# Rewrapped through unquoted command substitution (gsd-core#4109) — see the
# dispatch loop above for why a bare `$DISPATCH_SLUGS` collapses under zsh.
for SLUG in $(printf '%s' "$DISPATCH_SLUGS"); do
  LANE_RESULT="$RUN_DIR/gsd-review-lane-result-$SLUG.json"
  if [ -f "$LANE_RESULT" ]; then
    cat "$LANE_RESULT" >> "$RUN_DIR/gsd-review-lane-results.jsonl"
  fi
done
```

Each lane leaves `{run_dir}/gsd-review-<slug>.md` — its review, or a diagnostic stub carrying the
captured stderr (and, for an OpenAI-compatible lane, the raw response body, where such a server puts
its error JSON on an HTTP 4xx/5xx while still exiting 0). A stub is never mistaken for a clean
review: it keeps its "failed or returned empty output" header (#2494/#2605/#2794).

A lane that will not run reports a typed reason rather than an empty file — `missing_binary`,
`probe_failed`, `probe_timeout`, `missing_required_binary`, `host_unreachable`,
`egress_host_changed`, `unknown_handler`, `budget_too_small`. **`egress_host_changed` means the lane
was consented to send plans to one destination and `.planning/config.json` now names another; it is
blocked, not silently redirected** (ADR-2782 D5).

Display progress:
```
### GSD ► CROSS-AI REVIEW — Phase {N}

◆ Reviewing with {CLI}... done ✓
◆ Reviewing with {CLI}... done ✓
```
</step>

<step name="write_reviews">
**#3352 (ADR-3473 §8.5): no artifact from failed inputs.** Before rendering anything, gate on
whether any lane actually produced a result — "every lane failed" is exactly "the aggregate
JSONL has zero lines" (§`invoke_reviewers`'s aggregation loop already builds this file as a
byproduct; a lane that never started or was budget-skipped contributes no line either way).

```bash
RUN_DIR="{run_dir}"
JSONL="$RUN_DIR/gsd-review-lane-results.jsonl"
LANE_LINES=0
[ -f "$JSONL" ] && LANE_LINES=$(wc -l < "$JSONL" | tr -d ' ')

TOTAL_LANE_FAILURE="false"
ALL_LANES_SKIPPED="false"
if [ "${LANE_LINES:-0}" -eq 0 ]; then
  # Zero lines means every dispatched lane left no result JSON — either every one
  # was budget-skipped (N5: a skip is not a failure) or every one actually failed
  # to run. Re-derive the dispatched-slug set the same way invoke_reviewers did
  # (SELECTED_REVIEWERS is a shell block boundary — recompute, do not assume the
  # earlier step's local DISPATCH_SLUGS variable survived into this block).
  DISPATCH_SLUGS=""
  for SLUG in $(echo "$SELECTED_REVIEWERS" | tr ',' ' '); do
    case " $DISPATCH_SLUGS " in
      *" $SLUG "*) continue ;;
    esac
    DISPATCH_SLUGS="$DISPATCH_SLUGS $SLUG"
  done
  # Distinguish by whether every dispatched slug's stub markdown says "skipped":
  # a skip stub always does (see run_review_lane's budget branch, which writes
  # this exact text before returning without ever invoking the lane); a real
  # failure stub does not. If a slug has no stub at all, it is not a skip.
  DISPATCHED_COUNT=0
  SKIPPED_COUNT=0
  # Rewrapped through unquoted command substitution (gsd-core#4109): a bare
  # `$DISPATCH_SLUGS` word-splits under bash but not zsh, collapsing every
  # slug onto one iteration there whenever 2+ reviewers were selected.
  for SLUG in $(printf '%s' "$DISPATCH_SLUGS"); do
    DISPATCHED_COUNT=$((DISPATCHED_COUNT + 1))
    STUB="$RUN_DIR/gsd-review-$SLUG.md"
    if [ -f "$STUB" ] && grep -q "review skipped: prompt budget" "$STUB" 2>/dev/null; then
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    fi
  done
  if [ "$DISPATCHED_COUNT" -gt 0 ] && [ "$SKIPPED_COUNT" -eq "$DISPATCHED_COUNT" ]; then
    ALL_LANES_SKIPPED="true"
  else
    TOTAL_LANE_FAILURE="true"
  fi
fi
```

- **If `ALL_LANES_SKIPPED=true`:** do NOT write `REVIEWS.md` and do NOT run the commit below —
  there is nothing to review. Report to the user that every selected lane was budget-skipped
  (not a failure) and stop; do not proceed to `present_results`' summary claiming a review ran.
- **If `TOTAL_LANE_FAILURE=true`:** do NOT write `REVIEWS.md` and do NOT run the commit below.
  Report the total lane failure to the user (name the lanes that were dispatched and point at
  their `.err`/stub files preserved under `.review-diagnostics/` by `present_results`) and stop.
- **Otherwise** (at least one lane produced a result — R1, unchanged): proceed exactly as below.

**#3301: plan coverage check.** For each dispatched lane that produced a *real* review (not a
stub, not budget-skipped, not empty), check whether its output mentions every plan id from
`.plans-manifest.md` — the same manifest `build_prompt` gave the reviewer, so the expected-id list
here can never diverge from what the reviewer was actually told. This is diagnostic only: it never
blocks the workflow, never fails a lane, and never changes the `TOTAL_LANE_FAILURE`/
`ALL_LANES_SKIPPED` gate above.

CodeRabbit is excluded — it is a diff-only lane that never receives the source-grounding prompt
(and therefore never receives the manifest or the per-id section instruction either), the same fact
that already excludes it from grounded-review weighting in the Consensus Summary below.

The match is intentionally lenient about *where* an id appears (a `##`-headed section is asked for,
but plain prose mentioning the id still counts as coverage — grading only the letter of the
formatting instruction would produce false INCOMPLETE verdicts against a reviewer that cited real
evidence correctly). It is strict about *what* counts as a match: the id is regex-escaped (a
decimal phase like `12.6` must not let `12X6-01` satisfy `12.6-01` through an unescaped `.`), and a
`-`/word character immediately before or after the candidate match does not count as a boundary (so
a threat id like `T-04-07` elsewhere in the review must not register as covering plan `04-07`).

```bash
RUN_DIR="{run_dir}"
MANIFEST="$RUN_DIR/.plans-manifest.md"

# Recompute — a shell variable does not survive across separate fenced blocks
# (each is its own process), so DISPATCH_SLUGS from the gate-check block above
# cannot be assumed to still be set here. Same recomputation as that block and
# as invoke_reviewers.
DISPATCH_SLUGS=""
for SLUG in $(echo "$SELECTED_REVIEWERS" | tr ',' ' '); do
  case " $DISPATCH_SLUGS " in
    *" $SLUG "*) continue ;;
  esac
  DISPATCH_SLUGS="$DISPATCH_SLUGS $SLUG"
done

# Rewrapped through unquoted command substitution (gsd-core#4109): a bare
# `$DISPATCH_SLUGS` word-splits under bash but not zsh, collapsing every
# slug onto one iteration there whenever 2+ reviewers were selected.
for SLUG in $(printf '%s' "$DISPATCH_SLUGS"); do
  [ "$SLUG" = "coderabbit" ] && continue
  REVIEW_FILE="$RUN_DIR/gsd-review-$SLUG.md"
  [ -f "$REVIEW_FILE" ] || continue
  [ -s "$REVIEW_FILE" ] || continue
  grep -q "review skipped: prompt budget" "$REVIEW_FILE" 2>/dev/null && continue
  grep -q "failed or returned empty output" "$REVIEW_FILE" 2>/dev/null && continue

  node -e '
    const fs = require("fs");
    const { escapeRegex } = require("./gsd-core/bin/lib/pattern.cjs");
    const manifest = fs.readFileSync(process.argv[1], "utf8");
    const review = fs.readFileSync(process.argv[2], "utf8");
    const ids = manifest.split("\n")
      .filter((l) => l.startsWith("- "))
      .map((l) => l.slice(2).trim())
      .filter(Boolean);
    const missing = ids.filter((id) => {
      const re = new RegExp("(?<![\\w-])" + escapeRegex(id) + "(?![\\w-])");
      return !re.test(review);
    });
    process.stdout.write(JSON.stringify({ complete: missing.length === 0, missing_ids: missing, total: ids.length }));
  ' "$MANIFEST" "$REVIEW_FILE" > "$RUN_DIR/.plan-coverage-$SLUG.json"
done
```

Each `${RUN_DIR}/.plan-coverage-<slug>.json` carries `{complete, missing_ids, total}` for one
graded lane. Collect these into a `plan_coverage` frontmatter block — **only** when at least one
graded lane has `complete: false` (mirrors the existing `trimmed_reviewers` precedent: present
only when there is something to report):

```yaml
plan_coverage:        # only present if at least one graded lane is incomplete
  <slug>:
    total: 7
    missing: ["12.6-07"]
```

Combine all review responses into `{phase_dir}/{padded_phase}-REVIEWS.md`:

Capture only the existing conflict entry bytes after the exact `## Plan-Revision Conflicts`
heading and before the end of the first exact `<!-- gsd:plan-revision-conflicts:begin -->` /
`<!-- gsd:plan-revision-conflicts:end -->` pair immediately after the artifact title, if present,
as `{preserved_plan_revision_conflict_entries}`. Ignore identical headings or delimiters in reviewer
output: reviewers do not own blocking state. Restore the captured bytes at the explicit slot below.

After all reviewers complete, collect trim metadata files written during the run. For each reviewer that was trimmed (i.e. a `.metadata.json` file exists and `hardFailed` or `omitted` is non-empty, or `projectMdShrunk` is true, or `planTruncationPct > 0`), include a `trimmed_reviewers` block in the frontmatter. Omit the key entirely if no reviewer was trimmed.

**Reviewer instances (#1517, optional):** when instances ran, frontmatter records their
names, each gets its own `## <Adapter> Review (<instance>)` section, and ≥2 same-cli
instances print a one-line shared-adapter caveat. Format in
`gsd-core/references/reviewer-instances.md`.

**Resolved model (#2295):** each lane's `review-lane invoke --json` line in
`{run_dir}/gsd-review-lane-results.jsonl` carries a `model` object; render `models:` from
its `value` and `model_sources:` from its `source`. Both maps carry exactly one entry per
reviewer that appears in `reviewers:` — the two key sets always match. Write the literal
`unknown` rather than omitting a key: an omitted key is indistinguishable from the feature
not having run, and a reader must be able to tell *no model recorded* from *nothing to
look at*. Emit every `models:`/`model_sources:` value as a DOUBLE-QUOTED YAML scalar — a
legitimate model id can contain `:` (`llama3:70b`, `qwen2.5:7b`), which is unquotable as a
bare scalar; a control character is already refused at the recording seam, so quoting is
what closes the remaining `:`/`#`/leading-`-` cases. When GSD applied a reasoning effort to
a lane, its `value` already carries a `(reasoning=<level>)` suffix (e.g.
`gpt-5.6-sol (reasoning=high)`) — render it as-is, without re-deriving or re-formatting it.

```markdown
---
phase: {N}
reviewers: [gemini, claude, codex, coderabbit, opencode, qwen, cursor, antigravity, ollama, lm_studio, llama_cpp]  # populate at runtime with only the reviewers actually invoked
reviewed_at: {ISO timestamp}
plans_reviewed: [{list of PLAN.md files}]
models:                   # resolved model per reviewer; `unknown` when not recoverable
  codex: "gpt-5.6-sol (reasoning=low)"
  antigravity: "unknown"
model_sources:            # how each value above was determined
  codex: "banner"
  antigravity: "unknown"
trimmed_reviewers:        # only present if at least one reviewer was trimmed
  ollama:
    budget: 6000
    effective_budget: 5400
    estimated_tokens: 5380
    omitted: [context, research]
    project_md_shrunk: true
    plan_truncation_pct: 22
    hard_failed: false
    note_injected: true
plan_coverage:            # only present if at least one graded lane is incomplete (#3301)
  ollama:
    total: 7
    missing: ["12.6-07"]
---

# Cross-AI Plan Review — Phase {N}

<!-- gsd:plan-revision-conflicts:begin -->
## Plan-Revision Conflicts
{preserved_plan_revision_conflict_entries}
<!-- gsd:plan-revision-conflicts:end -->

<!-- Sections are RENDERED from each lane's declared `reviewsSection`, in descriptor order.
     There is deliberately no hardcoded per-reviewer heading list here any more: a hand-maintained
     list is exactly the drift #2781 was filed about, and it silently disagreed with the roster.
     `gsd_run query review-lane sections --selected "$SELECTED_REVIEWERS"` emits
     `<slug><TAB><reviewsSection>` in order; for each row, emit:

         ## <reviewsSection> Review

         {contents of {run_dir}/gsd-review-<slug>.md}

         ---

     Two headings must NOT be generated from this list, because they are not lanes:
       * `## <Adapter> Review (<instance>)` — an ADR-1517 reviewer INSTANCE resolves THROUGH a lane
         and is rendered from the instance list, not the lane list (ADR-2782 D8).
       * `## Consensus Summary` — not a review section at all.

     A lane whose `evidenceClass` is `diff-only` (CodeRabbit) carries its caveat from data: it never
     received the source-grounding prompt, so its verdict is folded in as a diff observation and is
     not weighted as a grounded plan review. -->

## Consensus Summary

{synthesize common concerns across all reviewers. CodeRabbit is a diff-only reviewer (it never received the source-grounding prompt), so do not weight its verdict as a grounded plan review — fold in its diff findings, but base plan-level consensus on the prompt-fed reviewers. A reviewer output carrying the `[reviewed-without-repo-access]` marker (or beginning with `REVIEWED-WITHOUT-REPO-ACCESS`) ran without repo access (#2176) — treat it the same way: note its concerns, but do not count its verdict at full consensus weight. A reviewer output carrying the `[reviewed-without-source-citations]` marker (#3194) declared source-grounded evidence but cited no `file:line` evidence, so it reviewed the plan text only — treat it the same way: note its concerns, but do not count its verdict at full consensus weight.}

### Agreed Strengths
{strengths mentioned by 2+ reviewers}

### Agreed Concerns
{concerns raised by 2+ reviewers — highest priority}

### Divergent Views
{where reviewers disagreed — worth investigating}
```

Commit (only reached when `TOTAL_LANE_FAILURE` and `ALL_LANES_SKIPPED` are both `false` — the
gate above):
```bash
gsd_run query commit "docs: cross-AI review for phase {N}" --files {phase_dir}/{padded_phase}-REVIEWS.md
```
</step>

<step name="present_results">
**If `write_reviews` set `TOTAL_LANE_FAILURE=true` or `ALL_LANES_SKIPPED=true`, skip the success
summary below entirely** — no `REVIEWS.md` was written or committed, so there is nothing to
present as complete. Report instead:

```
### GSD ► REVIEW FAILED

Phase {N}: every selected reviewer lane {failed to produce a result|was budget-skipped} — no
REVIEWS.md was written.

{If the preserve+cleanup block below reports success: "Diagnostics preserved:
{phase_dir}/.review-diagnostics/". If it reports failure: relay its own warning verbatim —
it names the intact run directory holding the un-preserved evidence instead.}
```

Otherwise (at least one lane succeeded), display summary:

```
### GSD ► REVIEW COMPLETE

Phase {N} reviewed by {count} AI systems.

Consensus concerns:
{top 3 shared concerns}

Full review: {padded_phase}-REVIEWS.md

To incorporate feedback into planning:
  /gsd:plan-phase {N} --reviews
```

**#3352 (ADR-3473 §8.5, R3): preserve per-lane evidence before destroying it.** Regardless of
which branch above ran, the run's temp directory is the only record that a lane failed at all —
copy it beside the phase's artifacts BEFORE cleanup. A lane that produced no output at all (L4)
leaves nothing to preserve; that is a smaller diagnostics folder, not a fabricated one, and is
NOT a preservation failure. This copy is deliberately NOT part of the commit above (N6) — that
step names only `{padded_phase}-REVIEWS.md` explicitly, never a directory glob, so
`.review-diagnostics/` is never swept into it.

**#4097: preserve lane OUTPUT, never the run's own input copies.** `RUN_DIR` holds not only
lane outputs — prompt assembly (the `gather_context`/section-copy step above) also writes the
run's assembled INPUTS there under the same `gsd-review-` prefix: the combined prompt, the
instructions/roadmap sections, a copy of every plan under review, the project/context/research/
requirements sections, and the per-lane trimmed prompts. Those are byte-identical duplicates of
files already committed under `.planning/`; sweeping them into `.review-diagnostics/` buries
the actual evidence under plan duplicates and grows the phase directory on every run. The
exclusion list below is CLOSED and owned here: this workflow itself writes every input
basename at prompt-assembly time, so a future input file CANNOT silently join the evidence
set — adding one means adding its stem to this list consciously. Lane slugs never begin with
any excluded stem (`prompt`, `instructions`, `plan-`, `project`, `roadmap`, `context`,
`research`, `requirements`), so a lane report can never be excluded by accident.

Preservation and cleanup MUST run in the same fenced block below (a shell variable cannot
survive across separate fences — each is its own process). `mkdir -p` and every `cp` are
exit-status checked; `rm -rf "$RUN_DIR"` runs ONLY if nothing was preserved (nothing to
preserve is not a failure) or everything that needed preserving was copied successfully. If
preservation fails partway, `$RUN_DIR` is left intact and a message names it as the location of
the un-preserved evidence — a leftover temp directory is far cheaper than destroyed evidence:

```bash
shopt -s nullglob 2>/dev/null; setopt NULL_GLOB 2>/dev/null

RUN_DIR="{run_dir}"
DIAG_DIR="{phase_dir}/.review-diagnostics"

# #4097: `gsd-review-*.md` matches BOTH lane outputs (reports, diagnostic stubs) and the
# run's own assembled input copies (see the #4097 note above). Filter by basename against
# the closed input set this workflow itself writes — direct glob iteration with a `case`
# filter, no string accumulator, identical under bash and zsh (#4099/#4109), and the
# `nullglob` set at the top of this fence keeps an empty RUN_DIR an empty array (#2962).
# `gsd-review-prompt*` deliberately covers BOTH the combined prompt (`gsd-review-prompt.md`)
# and the per-lane trimmed prompts (`gsd-review-prompt-<slug>.md`).
_DIAG_MD=()
for f in "$RUN_DIR"/gsd-review-*.md; do
  case "$(basename "$f")" in
    gsd-review-prompt*|gsd-review-instructions*|gsd-review-plan-*|gsd-review-project*|gsd-review-roadmap*|gsd-review-context*|gsd-review-research*|gsd-review-requirements*) ;;
    *) _DIAG_MD+=("$f") ;;
  esac
done
_DIAG_ERR=()
for f in "$RUN_DIR"/gsd-review-*.err; do
  [ -s "$f" ] && _DIAG_ERR+=("$f")
done

_PRESERVE_OK=true
if [ ${#_DIAG_MD[@]} -gt 0 ] || [ ${#_DIAG_ERR[@]} -gt 0 ]; then
  if mkdir -p "$DIAG_DIR"; then
    if [ ${#_DIAG_MD[@]} -gt 0 ] && ! cp "${_DIAG_MD[@]}" "$DIAG_DIR/"; then
      _PRESERVE_OK=false
    fi
    if [ ${#_DIAG_ERR[@]} -gt 0 ] && ! cp "${_DIAG_ERR[@]}" "$DIAG_DIR/"; then
      _PRESERVE_OK=false
    fi
  else
    _PRESERVE_OK=false
  fi
fi

if [ "$_PRESERVE_OK" = "true" ]; then
  rm -rf "$RUN_DIR"
else
  echo "WARNING: evidence preservation to $DIAG_DIR failed — leaving the un-preserved run directory intact at: $RUN_DIR" >&2
fi
```
</step>

</process>

<success_criteria>
- [ ] At least one external CLI invoked successfully
- [ ] REVIEWS.md written with structured feedback
- [ ] Consensus summary synthesized from multiple reviewers
- [ ] Temp files cleaned up
- [ ] User knows how to use feedback (/gsd:plan-phase --reviews)
</success_criteria>
