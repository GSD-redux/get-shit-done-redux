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
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; if [ -f "$GSD_TOOLS" ]; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
# Check each CLI
command -v gemini >/dev/null 2>&1 && echo "gemini:available" || echo "gemini:missing"
command -v claude >/dev/null 2>&1 && echo "claude:available" || echo "claude:missing"
command -v codex >/dev/null 2>&1 && echo "codex:available" || echo "codex:missing"
command -v coderabbit >/dev/null 2>&1 && echo "coderabbit:available" || echo "coderabbit:missing"
command -v opencode >/dev/null 2>&1 && echo "opencode:available" || echo "opencode:missing"
command -v qwen >/dev/null 2>&1 && echo "qwen:available" || echo "qwen:missing"
command -v cursor-agent >/dev/null 2>&1 && echo "cursor:available" || echo "cursor:missing"
command -v agy >/dev/null 2>&1 && echo "antigravity:available" || echo "antigravity:missing"

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

**Reviewer instances (#1517, optional):** if `review.reviewer_instances` is configured,
instance names in `review.default_reviewers` run as independent identities. Resolution rules
are in `gsd-core/references/reviewer-instances.md` — load it lazily only when instances are
configured. Unconfigured → default path unchanged.

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
INIT=$(gsd_run query init.phase-op "${PHASE_ARG}")
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
{all PLAN.md contents}

## Review Instructions

**Verify against source — do not review the plan text in isolation.** The plans reference real files, migrations, routes, and tests in this repo.
1. Open the referenced files and check each claim against the actual code.
2. For every strength or concern, cite concrete `path/to/file:line` evidence plus the mechanism.
3. When a plan asserts a mechanism works (a guard, a query filter, a test that exercises a path), trace whether it actually does what is claimed — do not take the plan's word for it.
4. If you cannot read the repo (no file access), say so and downgrade that finding to an open question rather than asserting it.

Findings citing `file:line` evidence are weighted far more heavily than impressionistic ones; a review that only restates the plan's own claims has low value.

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
RUN_DIR="{run_dir}"   # from gather_context

# Write individual section files for per-reviewer budget trimming
# These are always written so reviewers with a budget can invoke prompt-budget
cp "$INSTRUCTIONS_BLOCK_FILE" "${RUN_DIR}/gsd-review-instructions.md"
cp "$ROADMAP_SECTION_FILE" "${RUN_DIR}/gsd-review-roadmap.md"

# Plan files: copy each PLAN.md to a predictable numbered path
PLAN_INDEX=0
for PLAN_FILE in "${PHASE_DIR}"/*-PLAN.md; do
  PADDED_IDX=$(printf '%02d' "$PLAN_INDEX")
  cp "$PLAN_FILE" "${RUN_DIR}/gsd-review-plan-${PADDED_IDX}.md"
  PLAN_INDEX=$((PLAN_INDEX + 1))
done

# Optional section files (only if content was included in the combined prompt)
if [ -f ".planning/PROJECT.md" ]; then
  cp .planning/PROJECT.md "${RUN_DIR}/gsd-review-project.md"
fi
if ls "${PHASE_DIR}/"*"-CONTEXT.md" >/dev/null 2>&1; then
  cat "${PHASE_DIR}/"*"-CONTEXT.md" > "${RUN_DIR}/gsd-review-context.md"
fi
if ls "${PHASE_DIR}/"*"-RESEARCH.md" >/dev/null 2>&1; then
  cat "${PHASE_DIR}/"*"-RESEARCH.md" > "${RUN_DIR}/gsd-review-research.md"
fi
if [ -f ".planning/REQUIREMENTS.md" ]; then
  cp .planning/REQUIREMENTS.md "${RUN_DIR}/gsd-review-requirements.md"
fi
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

**Reviewer instances (#1517, optional):** instances resolve *through* a lane and are not lanes
themselves (ADR-2782 D8). Each selected instance invokes its base `cli` with its own `model`/`agent`
as opaque argv. Exact invocation in `gsd-core/references/reviewer-instances.md`.

Lanes run **sequentially, not in parallel** — concurrent invocation trips provider rate limits.

```bash
RUN_DIR="{run_dir}"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# SELECTED_REVIEWERS is the comma-separated result of reviewer selection (ADR-0011 precedence:
# explicit flags > --all > review.default_reviewers > all detected). Unchanged by this phase.

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

for SLUG in $(echo "$SELECTED_REVIEWERS" | tr ',' ' '); do
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
      continue
    fi
  fi

  # One invocation, whatever the lane's transport, prompt channel, output channel or handler.
  # `--explicit` marks a lane the user NAMED: ADR-2782 D4 — not finding a lane nobody asked for is
  # normal, failing to run one somebody asked for is an error.
  gsd_run query review-lane invoke --slug "$SLUG" \
    --run-dir "$RUN_DIR" --repo-root "$REPO_ROOT" $PROMPT_ARG $EXPLICIT_FLAG --json \
    >> "$RUN_DIR/gsd-review-lane-results.jsonl"
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
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► CROSS-AI REVIEW — Phase {N}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

◆ Reviewing with {CLI}... done ✓
◆ Reviewing with {CLI}... done ✓
```
</step>

<step name="write_reviews">
Combine all review responses into `{phase_dir}/{padded_phase}-REVIEWS.md`:

After all reviewers complete, collect trim metadata files written during the run. For each reviewer that was trimmed (i.e. a `.metadata.json` file exists and `hardFailed` or `omitted` is non-empty, or `projectMdShrunk` is true, or `planTruncationPct > 0`), include a `trimmed_reviewers` block in the frontmatter. Omit the key entirely if no reviewer was trimmed.

**Reviewer instances (#1517, optional):** when instances ran, frontmatter records their
names, each gets its own `## <Adapter> Review (<instance>)` section, and ≥2 same-cli
instances print a one-line shared-adapter caveat. Format in
`gsd-core/references/reviewer-instances.md`.

```markdown
---
phase: {N}
reviewers: [gemini, claude, codex, coderabbit, opencode, qwen, cursor, antigravity, ollama, lm_studio, llama_cpp]  # populate at runtime with only the reviewers actually invoked
reviewed_at: {ISO timestamp}
plans_reviewed: [{list of PLAN.md files}]
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
---

# Cross-AI Plan Review — Phase {N}

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

{synthesize common concerns across all reviewers. CodeRabbit is a diff-only reviewer (it never received the source-grounding prompt), so do not weight its verdict as a grounded plan review — fold in its diff findings, but base plan-level consensus on the prompt-fed reviewers. A reviewer output carrying the `[reviewed-without-repo-access]` marker (or beginning with `REVIEWED-WITHOUT-REPO-ACCESS`) ran without repo access (#2176) — treat it the same way: note its concerns, but do not count its verdict at full consensus weight.}

### Agreed Strengths
{strengths mentioned by 2+ reviewers}

### Agreed Concerns
{concerns raised by 2+ reviewers — highest priority}

### Divergent Views
{where reviewers disagreed — worth investigating}
```

Commit:
```bash
gsd_run query commit "docs: cross-AI review for phase {N}" --files {phase_dir}/{padded_phase}-REVIEWS.md
```
</step>

<step name="present_results">
Display summary:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► REVIEW COMPLETE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Phase {N} reviewed by {count} AI systems.

Consensus concerns:
{top 3 shared concerns}

Full review: {padded_phase}-REVIEWS.md

To incorporate feedback into planning:
  /gsd:plan-phase {N} --reviews
```

Clean up — remove the run's temp directory now that REVIEWS.md is committed:

```bash
rm -rf "{run_dir}"
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
