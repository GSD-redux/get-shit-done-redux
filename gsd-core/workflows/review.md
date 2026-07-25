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
OLLAMA_HOST=$(gsd_run query config-get review.ollama_host 2>/dev/null | jq -r '.' 2>/dev/null || echo "")
if [ -z "$OLLAMA_HOST" ] || [ "$OLLAMA_HOST" = "null" ]; then OLLAMA_HOST="http://localhost:11434"; fi
curl -s --max-time 2 "${OLLAMA_HOST}/v1/models" >/dev/null 2>&1 && echo "ollama:available" || echo "ollama:missing"

LM_STUDIO_HOST=$(gsd_run query config-get review.lm_studio_host 2>/dev/null | jq -r '.' 2>/dev/null || echo "")
if [ -z "$LM_STUDIO_HOST" ] || [ "$LM_STUDIO_HOST" = "null" ]; then LM_STUDIO_HOST="http://localhost:1234"; fi
curl -s --max-time 2 "${LM_STUDIO_HOST}/v1/models" >/dev/null 2>&1 && echo "lm_studio:available" || echo "lm_studio:missing"

LLAMA_CPP_HOST=$(gsd_run query config-get review.llama_cpp_host 2>/dev/null | jq -r '.' 2>/dev/null || echo "")
if [ -z "$LLAMA_CPP_HOST" ] || [ "$LLAMA_CPP_HOST" = "null" ]; then LLAMA_CPP_HOST="http://localhost:8080"; fi
curl -s --max-time 2 "${LLAMA_CPP_HOST}/v1/models" >/dev/null 2>&1 && echo "llama_cpp:available" || echo "llama_cpp:missing"
```

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

`review.default_reviewers` behavior:
- Value must be a non-empty array of slug strings (configured via `gsd config-set review.default_reviewers '["gemini","codex"]'`)
- Unknown slugs warn and are ignored
- Known-but-undetected slugs emit an info note and are ignored
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
Read model preferences from planning config. Null/missing values fall back to CLI defaults.

```bash
# JSON scalars from gsd-tools.cjs query; use jq -r to strip JSON string quotes (install jq if missing)
GEMINI_MODEL=$(gsd_run query config-get review.models.gemini 2>/dev/null | jq -r '.' 2>/dev/null || true)
CLAUDE_MODEL=$(gsd_run query config-get review.models.claude 2>/dev/null | jq -r '.' 2>/dev/null || true)
CODEX_MODEL=$(gsd_run query config-get review.models.codex 2>/dev/null | jq -r '.' 2>/dev/null || true)
OPENCODE_MODEL=$(gsd_run query config-get review.models.opencode 2>/dev/null | jq -r '.' 2>/dev/null || true)
# review.models.agy, when set, is passed to agy as --model (escape hatch for a
# pinned model that 404s server-side); otherwise agy uses its persisted default.
AGY_MODEL=$(gsd_run query config-get review.models.agy 2>/dev/null | jq -r '.' 2>/dev/null || true)

# Reasoning effort per reviewer (#2481). Empty unless the host's effortSurface
# axis is `argv`. Pass --attempt N to walk ADR-443's escalation ladder.
CLAUDE_EFFORT_ARGS=$(gsd_run query resolve-execution gsd-plan-checker --host claude 2>/dev/null | jq -r '.effort_argv_string // ""' 2>/dev/null || true)
CODEX_EFFORT_ARGS=$(gsd_run query resolve-execution gsd-plan-checker --host codex 2>/dev/null | jq -r '.effort_argv_string // ""' 2>/dev/null || true)
OPENCODE_EFFORT_ARGS=$(gsd_run query resolve-execution gsd-plan-checker --host opencode 2>/dev/null | jq -r '.effort_argv_string // ""' 2>/dev/null || true)

# #1115: `--dangerously-bypass-hook-trust` only exists on codex-cli >= 0.137.0.
# Capability-probe it so older installs don't fail with "unexpected argument"
# (which, with stderr suppressed, produced a silent empty review). The codex
# invocation works fine without the flag on older versions.
if codex exec --help 2>/dev/null | grep -q -- '--dangerously-bypass-hook-trust'; then
  CODEX_BYPASS_FLAG="--dangerously-bypass-hook-trust"
else
  CODEX_BYPASS_FLAG=""
fi
```

**Reviewer instances (#1517, optional):** when instances are configured, each selected
instance invokes its base `cli` with its own `model`/`agent` (opaque argv, never
shell-interpolated). Exact invocation in `gsd-core/references/reviewer-instances.md`.

For each selected CLI, invoke in sequence (not parallel — avoid rate limits):

**Timeout guidance (#2194):** prompt-fed source-grounded reviews are slow — measured ~570s for Codex at `xhigh` effort and ~525s for headless Claude on a large plan set. Each of the Gemini / Claude / Codex blocks below MUST be invoked with a high Bash `timeout:` — at least `900000` (15 min), and `1200000` (20 min) for Codex `xhigh` or headless Claude — so a lane is not killed mid-review. On Claude Code, raise the host cap via `BASH_MAX_TIMEOUT_MS` if a review can exceed it. A silent empty output after a long run is a **timeout kill, not a crash** — the Codex `0xc0000142` misdiagnosis persisted because the empty-output branches below cannot distinguish the two; treat an empty result on a slow lane as a dropped lane and re-run with more time rather than diagnosing a CLI/sandbox failure. A cross-AI review that silently drops a lane is blind in one eye.

**Gemini:**
```bash
# #2494: capture stderr to a .err sidecar (not /dev/null) and stub an empty
# result, mirroring the Codex and Cursor blocks. Without the guard a failed
# lane — CLI missing, unauthenticated, rate-limited, crashed, or any exit that
# writes no stdout — leaves a zero-byte file that write_reviews renders as a
# reviewer that ran cleanly with nothing to report, silently dropping a lane
# from the cross-AI consensus while present_results reports success.
# Scope limit: the guard only runs if this block completes. A host Bash-tool
# timeout that kills the whole block skips it, the same hard bound the
# OpenCode block documents below — per the timeout guidance above, treat an
# empty result on a slow lane as a dropped lane rather than a crash.
if [ -n "$GEMINI_MODEL" ] && [ "$GEMINI_MODEL" != "null" ]; then
  cat {run_dir}/gsd-review-prompt.md | gemini -m "$GEMINI_MODEL" -p - 2>{run_dir}/gsd-review-gemini.err > {run_dir}/gsd-review-gemini.md
else
  cat {run_dir}/gsd-review-prompt.md | gemini -p - 2>{run_dir}/gsd-review-gemini.err > {run_dir}/gsd-review-gemini.md
fi
if [ ! -s {run_dir}/gsd-review-gemini.md ]; then
  echo "Gemini review failed or returned empty output. stderr:" > {run_dir}/gsd-review-gemini.md
  cat {run_dir}/gsd-review-gemini.err >> {run_dir}/gsd-review-gemini.md
fi
```

**Claude (separate session):**
```bash
# #2494: same guard as the Gemini block above — stderr to a .err sidecar
# instead of /dev/null, and a diagnostic stub when the lane produces nothing.
if [ -n "$CLAUDE_MODEL" ] && [ "$CLAUDE_MODEL" != "null" ]; then
  cat {run_dir}/gsd-review-prompt.md | claude --model "$CLAUDE_MODEL" $CLAUDE_EFFORT_ARGS -p - 2>{run_dir}/gsd-review-claude.err > {run_dir}/gsd-review-claude.md
else
  cat {run_dir}/gsd-review-prompt.md | claude $CLAUDE_EFFORT_ARGS -p - 2>{run_dir}/gsd-review-claude.err > {run_dir}/gsd-review-claude.md
fi
if [ ! -s {run_dir}/gsd-review-claude.md ]; then
  echo "Claude review failed or returned empty output. stderr:" > {run_dir}/gsd-review-claude.md
  cat {run_dir}/gsd-review-claude.err >> {run_dir}/gsd-review-claude.md
fi
```

**Codex:**
```bash
# $CODEX_BYPASS_FLAG is capability-gated above (#1115). Capture stderr to a .err
# file (not /dev/null) so a non-zero exit — e.g. a flag the installed codex-cli
# does not support — is diagnosable instead of a silent empty review.
# Capture the review via codex's own `-o/--output-last-message <FILE>` (only the
# final agent message) and discard stdout (#1698): on some platforms (Windows)
# codex writes process-teardown output to stdout *after* the final message, and a
# stdout redirect would append that noise to a non-empty file — slipping past the
# `[ ! -s … ]` empty-output guard as a silently polluted review.
if [ -n "$CODEX_MODEL" ] && [ "$CODEX_MODEL" != "null" ]; then
  cat {run_dir}/gsd-review-prompt.md | codex exec --ephemeral $CODEX_BYPASS_FLAG --model "$CODEX_MODEL" $CODEX_EFFORT_ARGS --skip-git-repo-check -o {run_dir}/gsd-review-codex.md - 2>{run_dir}/gsd-review-codex.err >/dev/null
else
  cat {run_dir}/gsd-review-prompt.md | codex exec --ephemeral $CODEX_BYPASS_FLAG $CODEX_EFFORT_ARGS --skip-git-repo-check -o {run_dir}/gsd-review-codex.md - 2>{run_dir}/gsd-review-codex.err >/dev/null
fi
if [ ! -s {run_dir}/gsd-review-codex.md ]; then
  echo "Codex review failed or returned empty output. stderr:" > {run_dir}/gsd-review-codex.md
  cat {run_dir}/gsd-review-codex.err >> {run_dir}/gsd-review-codex.md
fi
```

**CodeRabbit:**

Note: CodeRabbit reviews the current git diff/working tree — it does not accept a prompt or model flag. It may take up to 5 minutes. Use `timeout: 360000` on the Bash tool call. The source-grounding requirement in the build_prompt Review Instructions applies only to the prompt-fed reviewers above; CodeRabbit is a diff-only reviewer and never receives it. Treat its output as a diff observation, not a grounded plan-level verdict.

```bash
coderabbit review --prompt-only 2>/dev/null > {run_dir}/gsd-review-coderabbit.md
```

**OpenCode (via GitHub Copilot):**

OpenCode's default `build` agent is an agentic coder, not a prompt→completion API.
On a large review prompt it may run a few `read` tool calls and then end its turn
with **zero output tokens** (`reason:"stop"`, `output:0`), so `--format default`
yields empty stdout and the second reviewer is silently lost (#1936). Invoke with
`--format json` and reconstruct the review from the assistant `text` parts; if the
agent emitted none, surface the stop `reason`, output-token count, and captured
stderr so the failure is diagnosable instead of a generic empty stub. Runs are also
nondeterministic in length, so bound this Bash tool call with a wall-clock timeout —
set `timeout: 660000` on the call (same mechanism the CodeRabbit block documents).
That bound is hard: if it fires mid-`opencode run` the tool kills the command and
the jq reconstruction below never runs, so the reviewing agent simply proceeds
without an OpenCode result. The completing zero-output case — the actual #1936 bug —
is fully handled below; the timeout only backstops the rarer nondeterministic hang. A
reviewer instance with `"agent": "review"` (see
`gsd-core/references/reviewer-instances.md`) sidesteps the default `build` agent and
is the durable fix when this recurs.

```bash
# stderr → sidecar (never /dev/null) so a real error is diagnosable — mirrors the
# Codex block. --format json is the primary invocation (not a fallback): the review
# text lives in assistant `text` parts, which the default formatter drops when the
# agent stops with no final message (#1936).
if [ -n "$OPENCODE_MODEL" ] && [ "$OPENCODE_MODEL" != "null" ]; then
  set -- --model "$OPENCODE_MODEL"
else
  set --
fi
cat {run_dir}/gsd-review-prompt.md | opencode run "$@" $OPENCODE_EFFORT_ARGS --format json - 2>{run_dir}/gsd-review-opencode.err > {run_dir}/gsd-review-opencode.json
# Reconstruct the review from the assistant text parts into a variable and test
# its CONTENT, not the file size: an empty extraction still prints a trailing
# newline that would fool a `[ -s file ]` check into skipping the stub.
OPENCODE_REVIEW=$(jq -rs '[.[] | select(.type=="text") | .part.text // empty] | join("\n")' {run_dir}/gsd-review-opencode.json 2>/dev/null)
if [ -n "$OPENCODE_REVIEW" ]; then
  printf '%s\n' "$OPENCODE_REVIEW" > {run_dir}/gsd-review-opencode.md
else
  # No assistant text (no final message, or stdout was not valid JSON):
  {
    echo "OpenCode review returned no assistant text (#1936: agent ended its turn with no final message)."
    OPENCODE_DIAG=$(jq -rs '[.[] | select(.type=="step_finish")] | last | "stop reason=\(.part.reason // "?"), output tokens=\(.part.tokens.output // "?")"' {run_dir}/gsd-review-opencode.json 2>/dev/null)
    [ -n "$OPENCODE_DIAG" ] && echo "Diagnostic: $OPENCODE_DIAG"
    echo "stderr:"
    cat {run_dir}/gsd-review-opencode.err
  } > {run_dir}/gsd-review-opencode.md
fi
```

**Qwen Code:**
```bash
cat {run_dir}/gsd-review-prompt.md | qwen - 2>/dev/null > {run_dir}/gsd-review-qwen.md
if [ ! -s {run_dir}/gsd-review-qwen.md ]; then
  echo "Qwen review failed or returned empty output." > {run_dir}/gsd-review-qwen.md
fi
```

**Cursor:**
```bash
# cursor-agent is a SEPARATE binary from the `cursor` IDE launcher; print mode (-p) takes the
# prompt as an ARGUMENT, not stdin. A full review prompt can exceed the OS argument limit, so
# reference the prompt file by path rather than inlining it. Capture stderr so a failure is
# diagnosable instead of a silent empty result.
# #2176: same absolute-root anchor as the Antigravity block — cursor-agent runs
# in the repo cwd, but repo-relative references in the assembled prompt still
# need an explicit root to resolve against. rev-parse (not bare pwd) so the
# anchor is correct even when /gsd:review is invoked from a repo subdirectory.
_CURSOR_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
CURSOR_PROMPT_ARG="Read the file at {run_dir}/gsd-review-prompt.md in full and carry out the review request it contains. The repository under review is at $_CURSOR_ROOT — resolve every relative file path in the review request against that absolute root. Output only the resulting markdown review. Do not edit any files."
cursor-agent -p --mode ask --trust --output-format text "$CURSOR_PROMPT_ARG" 2>{run_dir}/gsd-review-cursor.err > {run_dir}/gsd-review-cursor.md
if [ ! -s {run_dir}/gsd-review-cursor.md ]; then
  echo "Cursor review failed or returned empty output. stderr:" > {run_dir}/gsd-review-cursor.md
  cat {run_dir}/gsd-review-cursor.err >> {run_dir}/gsd-review-cursor.md
fi
```

**Antigravity CLI:**

**Maintainer note — why this block has three layers (last updated against agy 1.0.16):**

`agy -p` (the `--print` non-interactive flag) works correctly on macOS and Linux: it sends the
prompt, receives the model response, and writes it to stdout. On **native Windows** it silently
produces no stdout output despite the API call succeeding — a bug in `text_drip.go`'s non-TTY
flush path, tracked at https://github.com/google-antigravity/antigravity-cli/issues/27466 and
still open as of agy 1.0.2.

Regardless of platform, `agy` always persists the full exchange to a transcript file on disk.
The transcript fallback (Step 2 below) reads that file directly, giving Windows users full review
coverage without any extra tooling. This pattern was first documented by the community MCP bridge
at https://github.com/SinanTufekci/Claude-Code-Antigravity-CLI-MCP-Server — we inline the same
logic here in pure bash/jq so no additional dependency is required.

**Stale-response guard (why the pre-flight watermark matters):**
Without a watermark, the fallback would read the last `PLANNER_RESPONSE` entry in the transcript
regardless of when it was written — including entries from a previous invocation in the same
workspace. To prevent that, we record the transcript's line count *before* calling `agy -p`. In
the fallback, we only read lines appended after that count. If no new lines were written (agy
failed before producing a response), `_AGY_RESULT` is empty and Step 3 fires — never stale. If
the conv-id changed (agy started a fresh session), all lines in the new file are new and we use
skip=0.

**If the upstream stdout bug is fixed** (check the issue above): Step 2 silently becomes
unreachable; stdout is non-empty and Step 1 handles it. No code change needed.

**If the transcript paths change** in a future `agy` release: Step 2 silently becomes a no-op
and Step 3 fires with a clear error message in REVIEWS.md. No silent corruption. To debug:
- `~/.gemini/antigravity-cli/cache/last_conversations.json` — workspace → conv-id map
- `~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`
  Filter: `source=="MODEL"`, `status=="DONE"`, `type=="PLANNER_RESPONSE"`, take the last match's `content` field.

Invocation specifics (verified agy 1.0.0, macOS arm64 and Linux amd64):
- `-p` takes the prompt as a **flag value** — `echo X | agy -p` errors with "flag needs an argument: -p"
- `--print-timeout` defaults to 5m, aligning with this workflow's global timeout
- `--model "<name>"` selects the model (available since agy ~1.0.3; `agy models` lists
  them). When `review.models.agy` is set it is passed as `--model`; otherwise agy uses
  its persisted default (`agy models`).

```bash
# Pre-flight: snapshot the transcript watermark before invoking agy.
# Must run BEFORE agy -p — this is what prevents the fallback from reading a stale prior response.
_AGY_WS=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
_AGY_CACHE="$HOME/.gemini/antigravity-cli/cache/last_conversations.json"
_AGY_MARK_CONV=""
_AGY_MARK_LINES=0
if [ -f "$_AGY_CACHE" ]; then
  _AGY_MARK_CONV=$(jq -r --arg ws "$_AGY_WS" '
    .[$ws] //
    (to_entries
     | map(select(.key | ascii_downcase == ($ws | ascii_downcase)))
     | first | .value) //
    empty
  ' "$_AGY_CACHE" 2>/dev/null)
  if [ -n "$_AGY_MARK_CONV" ] && [ "$_AGY_MARK_CONV" != "null" ]; then
    _AGY_MARK_TX="$HOME/.gemini/antigravity-cli/brain/${_AGY_MARK_CONV}/.system_generated/logs/transcript.jsonl"
    [ -f "$_AGY_MARK_TX" ] && _AGY_MARK_LINES=$(wc -l < "$_AGY_MARK_TX" | tr -d ' ')
  fi
fi

# Step 1 — primary invocation: stdout works on macOS, Linux, and WSL.
# Three hardening invariants (#2073), all mirroring the Cursor block's discipline:
#   * FILE-REFERENCE prompt (not inline `$(cat …)`) — a large review prompt (≈197 KB
#     for 6 plans + CONTEXT + RESEARCH + REQUIREMENTS) overflows the exec arg list
#     (`bash: agy: Argument list too long`, rc 126), indistinguishable from a model
#     failure when stderr is suppressed.
#   * EXTERNAL `timeout` wrapper when available (GNU `timeout` / `gtimeout`) —
#     `--print-timeout` is agy's native cap but it CANNOT fire before agy creates a
#     session; under concurrent heavy runs one process can stall pre-session (no
#     `brain/<conv-id>/` dir, alive at 583 s despite `--print-timeout 300s`). The
#     external cap bounds wall-clock regardless. Stock macOS lacks `timeout`, so
#     the block probes for it and falls back to --print-timeout alone there.
#   * `--model` from `review.models.agy` when set — escape hatch for a pinned model
#     that 404s server-side (exits 0 with empty stdout AND empty transcript).
#   * stdin tied to /dev/null so agy never blocks on a tty.
# A non-zero exit (external timeout = 124, crash, etc.) discards any partial output
# so the Step 2 transcript fallback / Step 3 diagnostic take over.
if [ -n "$AGY_MODEL" ] && [ "$AGY_MODEL" != "null" ]; then
  set -- --model "$AGY_MODEL"
else
  set --
fi
# #2176: grant the reviewer the repo under review. Without --add-dir, agy's
# permission context never receives the cwd repo — the agent anchors on its own
# ~/.gemini/antigravity-cli/scratch dir and reviews the plan text in isolation
# (the exact failure the Review Instructions forbid). Capability-probed like the
# Codex bypass flag so an older agy without --add-dir still runs; the prompt
# anchor below keeps absolute-path reads possible on that fallback.
if agy --help 2>/dev/null | grep -q -- '--add-dir'; then
  set -- "$@" --add-dir "$_AGY_WS"
fi
# #2176: anchor the prompt to the absolute repo root so repo-relative references
# in the assembled review prompt resolve even on the no---add-dir fallback, and
# require an explicit self-report if the reviewer still cannot read the repo.
_AGY_PROMPT="Read the file at {run_dir}/gsd-review-prompt.md in full and carry out the review request it contains. The repository under review is at $_AGY_WS — resolve every relative file path in the review request against that absolute root and verify claims against those files. If you cannot read files under $_AGY_WS, begin your output with the exact line REVIEWED-WITHOUT-REPO-ACCESS before the review. Output only the resulting markdown review. Do not edit any files."
# Capability-probe an external wall-clock killer (GNU coreutils `timeout` or the
# macOS Homebrew `gtimeout`). Stock macOS ships NEITHER — a bare `timeout …` would
# fail with rc 127 ("command not found") and silently lose the reviewer, so fall
# back to agy's native --print-timeout alone in that case. The external cap, when
# available, is set HIGHER than --print-timeout so it only backstops a pre-session
# stall (which --print-timeout cannot bound — #2073 mode 3) and never pre-empts a
# healthy run. Mirrors the probe in scripts/base64-scan.sh.
_AGY_KILLER="$(command -v timeout 2>/dev/null || command -v gtimeout 2>/dev/null || true)"
if [ -n "$_AGY_KILLER" ]; then
  "$_AGY_KILLER" 600 agy --print-timeout 540s "$@" -p "$_AGY_PROMPT" </dev/null 2>/dev/null > {run_dir}/gsd-review-antigravity.md
else
  agy --print-timeout 540s "$@" -p "$_AGY_PROMPT" </dev/null 2>/dev/null > {run_dir}/gsd-review-antigravity.md
fi
_AGY_RC=$?
if [ "$_AGY_RC" -ne 0 ]; then
  : > {run_dir}/gsd-review-antigravity.md
fi

# Step 2 — transcript fallback: catches Windows agy -p stdout bug (and any future stdout-silent edge cases).
# Reads only lines appended AFTER the pre-flight watermark. If agy failed before writing a new response,
# _AGY_RESULT is empty and Step 3 fires — no stale content can leak through.
# Undocumented paths, verified agy 1.0.0–1.0.2. See maintainer note above if these break.
if [ ! -s {run_dir}/gsd-review-antigravity.md ]; then
  if [ -f "$_AGY_CACHE" ]; then
    _AGY_CONV=$(jq -r --arg ws "$_AGY_WS" '
      .[$ws] //
      (to_entries
       | map(select(.key | ascii_downcase == ($ws | ascii_downcase)))
       | first | .value) //
      empty
    ' "$_AGY_CACHE" 2>/dev/null)
    if [ -n "$_AGY_CONV" ] && [ "$_AGY_CONV" != "null" ]; then
      _AGY_TX="$HOME/.gemini/antigravity-cli/brain/${_AGY_CONV}/.system_generated/logs/transcript.jsonl"
      if [ -f "$_AGY_TX" ]; then
        # If conv-id changed, agy started a new session — all lines are new, skip 0.
        # If same conv-id, only read lines beyond the watermark.
        [ "$_AGY_CONV" = "$_AGY_MARK_CONV" ] && _AGY_SKIP=$_AGY_MARK_LINES || _AGY_SKIP=0
        _AGY_RESULT=$(tail -n +"$((_AGY_SKIP + 1))" "$_AGY_TX" 2>/dev/null | \
          jq -r 'select(.source=="MODEL" and .status=="DONE" and .type=="PLANNER_RESPONSE") | .content' \
          2>/dev/null | tail -1)
        [ -n "$_AGY_RESULT" ] && echo "$_AGY_RESULT" > {run_dir}/gsd-review-antigravity.md
      fi
    fi
  fi
fi

# Step 3 — final guard: both approaches yielded nothing (auth error, first-run setup,
# path schema changed, 404'd pinned model, pre-session stall, etc.)
if [ ! -s {run_dir}/gsd-review-antigravity.md ]; then
  {
    echo "Antigravity review failed or returned empty output."
    # #2073 mode 2: a pinned model that 404s exits 0 with empty stdout AND an empty
    # transcript — the only evidence is in agy's own log. Surface it instead of a
    # bare generic stub so the failure is diagnosable.
    _AGY_LOG="$HOME/.gemini/antigravity-cli/cli.log"
    if [ -f "$_AGY_LOG" ]; then
      _AGY_ERR=$(grep -iE 'agent executor error|NOT_FOUND|Publisher model' "$_AGY_LOG" | tail -3)
      if [ -n "$_AGY_ERR" ]; then
        echo "agy log hint (pinned model may be unavailable — run 'agy models' and set review.models.agy):"
        echo "$_AGY_ERR"
      fi
    fi
    # #2073 mode 3: pre-session stall tell — no new conversation dir appeared.
    echo "If no agy run started, that is the pre-session-stall case: check whether a new ~/.gemini/antigravity-cli/brain/<conv-id>/ dir appeared within ~30s of launch."
  } > {run_dir}/gsd-review-antigravity.md
fi

# #2176: blind-review marker. Two tells that the reviewer ran without repo
# access: the prompt's mandated REVIEWED-WITHOUT-REPO-ACCESS self-report in the
# first lines of output, or the agent DECLARING the scratch dir as its
# workspace. Both patterns are anchored — the self-report to the head of the
# file, the scratch tell to a workspace-declaration phrasing — so a grounded
# review that merely QUOTES these strings (e.g. reviewing this very file) is
# never mis-stamped. Stamp a machine-readable marker so the Consensus Summary
# down-weights the review instead of counting an ungrounded verdict at full
# weight. (Temp file + mv, no in-place sed — BSD/GNU safe.)
if [ -s {run_dir}/gsd-review-antigravity.md ] && \
   { head -5 {run_dir}/gsd-review-antigravity.md | grep -q 'REVIEWED-WITHOUT-REPO-ACCESS' || \
     grep -qiE '(workspace|working) (directory|dir).{0,40}antigravity-cli/scratch' {run_dir}/gsd-review-antigravity.md; }; then
  {
    echo "> [reviewed-without-repo-access] This reviewer ran without visibility into the repo under review — down-weight its verdict in the Consensus Summary."
    echo ""
    cat {run_dir}/gsd-review-antigravity.md
  } > {run_dir}/gsd-review-antigravity.md.tmp && \
  mv {run_dir}/gsd-review-antigravity.md.tmp {run_dir}/gsd-review-antigravity.md
fi
```

**Ollama (local, OpenAI-compatible):**

Read host and model from config. All three local backends share the same `/v1/chat/completions` endpoint — only host and model differ. Use `jq --rawfile` to safely encode the multi-line prompt as JSON without shell-escaping issues.

```bash
# Shared helper: apply prompt-budget trimming for local reviewers
prepare_trimmed_prompt_for_reviewer() {
  REVIEWER_KEY="$1"
  REVIEWER_BUDGET="$2"
  OUTPUT_PROMPT="$3"
  OUTPUT_META="$4"

  [ -z "$REVIEWER_BUDGET" ] && return 0
  [ "$REVIEWER_BUDGET" = "null" ] && return 0
  [ "$REVIEWER_BUDGET" = "0" ] && return 0

  PLAN_FILE_ARGS=""
  for p in {run_dir}/gsd-review-plan-*.md; do
    [ -f "$p" ] && PLAN_FILE_ARGS="$PLAN_FILE_ARGS --plan-file $p"
  done
  PROJECT_ARG=""
  [ -f "{run_dir}/gsd-review-project.md" ] && PROJECT_ARG="--project-file {run_dir}/gsd-review-project.md"
  CONTEXT_ARG=""
  [ -f "{run_dir}/gsd-review-context.md" ] && CONTEXT_ARG="--context-file {run_dir}/gsd-review-context.md"
  RESEARCH_ARG=""
  [ -f "{run_dir}/gsd-review-research.md" ] && RESEARCH_ARG="--research-file {run_dir}/gsd-review-research.md"
  REQUIREMENTS_ARG=""
  [ -f "{run_dir}/gsd-review-requirements.md" ] && REQUIREMENTS_ARG="--requirements-file {run_dir}/gsd-review-requirements.md"

  gsd_run query prompt-budget \
    --budget "$REVIEWER_BUDGET" \
    --instructions-file "{run_dir}/gsd-review-instructions.md" \
    --roadmap-file "{run_dir}/gsd-review-roadmap.md" \
    $PLAN_FILE_ARGS $PROJECT_ARG $CONTEXT_ARG $RESEARCH_ARG $REQUIREMENTS_ARG \
    --output-prompt "$OUTPUT_PROMPT" \
    --output-metadata "$OUTPUT_META"
  return $?
}

# Resolve prompt budget for Ollama: per-reviewer override > global default > null
OLLAMA_REVIEWER_BUDGET=$(gsd_run query config-get review.max_prompt_tokens_per_reviewer.ollama 2>/dev/null | jq -r '.' 2>/dev/null || echo "null")
if [ -z "$OLLAMA_REVIEWER_BUDGET" ] || [ "$OLLAMA_REVIEWER_BUDGET" = "null" ]; then
  OLLAMA_REVIEWER_BUDGET=$(gsd_run query config-get review.max_prompt_tokens 2>/dev/null | jq -r '.' 2>/dev/null || echo "null")
fi

# Apply budget trim for Ollama if a budget is configured
OLLAMA_PROMPT_FILE="{run_dir}/gsd-review-prompt.md"
OLLAMA_SKIP=0
if [ -n "$OLLAMA_REVIEWER_BUDGET" ] && [ "$OLLAMA_REVIEWER_BUDGET" != "null" ] && [ "$OLLAMA_REVIEWER_BUDGET" != "0" ]; then
  OLLAMA_TRIMMED_PROMPT="{run_dir}/gsd-review-prompt-ollama.md"
  OLLAMA_TRIM_META="{run_dir}/gsd-review-prompt-ollama.metadata.json"
  prepare_trimmed_prompt_for_reviewer "ollama" "$OLLAMA_REVIEWER_BUDGET" "$OLLAMA_TRIMMED_PROMPT" "$OLLAMA_TRIM_META"
  OLLAMA_EXIT=$?
  if [ $OLLAMA_EXIT -ne 0 ]; then
    if [ $OLLAMA_EXIT -eq 2 ] || [ $OLLAMA_EXIT -eq 11 ]; then
      echo "WARNING: prompt budget for ollama (${OLLAMA_REVIEWER_BUDGET} tokens) is too small for the minimum review set. Skipping Ollama reviewer." >&2
    else
      echo "WARNING: prompt-budget returned unexpected exit code ${OLLAMA_EXIT} for ollama. Skipping Ollama reviewer." >&2
    fi
    OLLAMA_SKIP=1
  else
    OLLAMA_PROMPT_FILE="$OLLAMA_TRIMMED_PROMPT"
  fi
fi

if [ "$OLLAMA_SKIP" != "1" ]; then
OLLAMA_HOST=$(gsd_run query config-get review.ollama_host 2>/dev/null | jq -r '.' 2>/dev/null || echo "")
if [ -z "$OLLAMA_HOST" ] || [ "$OLLAMA_HOST" = "null" ]; then OLLAMA_HOST="http://localhost:11434"; fi
OLLAMA_MODEL=$(gsd_run query config-get review.models.ollama 2>/dev/null | jq -r '.' 2>/dev/null || echo "")
if [ -z "$OLLAMA_MODEL" ] || [ "$OLLAMA_MODEL" = "null" ]; then
  OLLAMA_MODEL=$(curl -s --max-time 2 "${OLLAMA_HOST}/v1/models" 2>/dev/null | jq -r '.data[0].id // "llama3"' 2>/dev/null || echo "llama3")
fi
jq -n --rawfile content "$OLLAMA_PROMPT_FILE" \
  --arg model "$OLLAMA_MODEL" \
  '{model: $model, messages: [{role: "user", content: $content}]}' | \
  curl -s --max-time 120 -X POST "${OLLAMA_HOST}/v1/chat/completions" \
    -H "Content-Type: application/json" -d @- 2>/dev/null | \
  jq -r '.choices[0].message.content // "Ollama review failed or returned empty output."' \
  > {run_dir}/gsd-review-ollama.md
if [ ! -s {run_dir}/gsd-review-ollama.md ]; then
  echo "Ollama review failed or returned empty output." > {run_dir}/gsd-review-ollama.md
fi
fi
```

**LM Studio (local, OpenAI-compatible):**
```bash
# Resolve prompt budget for LM Studio: per-reviewer override > global default > null
LM_STUDIO_REVIEWER_BUDGET=$(gsd_run query config-get review.max_prompt_tokens_per_reviewer.lm_studio 2>/dev/null | jq -r '.' 2>/dev/null || echo "null")
if [ -z "$LM_STUDIO_REVIEWER_BUDGET" ] || [ "$LM_STUDIO_REVIEWER_BUDGET" = "null" ]; then
  LM_STUDIO_REVIEWER_BUDGET=$(gsd_run query config-get review.max_prompt_tokens 2>/dev/null | jq -r '.' 2>/dev/null || echo "null")
fi

# Apply budget trim for LM Studio if a budget is configured
LM_STUDIO_PROMPT_FILE="{run_dir}/gsd-review-prompt.md"
LM_STUDIO_SKIP=0
if [ -n "$LM_STUDIO_REVIEWER_BUDGET" ] && [ "$LM_STUDIO_REVIEWER_BUDGET" != "null" ] && [ "$LM_STUDIO_REVIEWER_BUDGET" != "0" ]; then
  LM_STUDIO_TRIMMED_PROMPT="{run_dir}/gsd-review-prompt-lm_studio.md"
  LM_STUDIO_TRIM_META="{run_dir}/gsd-review-prompt-lm_studio.metadata.json"
  prepare_trimmed_prompt_for_reviewer "lm_studio" "$LM_STUDIO_REVIEWER_BUDGET" "$LM_STUDIO_TRIMMED_PROMPT" "$LM_STUDIO_TRIM_META"
  LM_STUDIO_EXIT=$?
  if [ $LM_STUDIO_EXIT -ne 0 ]; then
    if [ $LM_STUDIO_EXIT -eq 2 ] || [ $LM_STUDIO_EXIT -eq 11 ]; then
      echo "WARNING: prompt budget for lm_studio (${LM_STUDIO_REVIEWER_BUDGET} tokens) is too small for the minimum review set. Skipping LM Studio reviewer." >&2
    else
      echo "WARNING: prompt-budget returned unexpected exit code ${LM_STUDIO_EXIT} for lm_studio. Skipping LM Studio reviewer." >&2
    fi
    LM_STUDIO_SKIP=1
  else
    LM_STUDIO_PROMPT_FILE="$LM_STUDIO_TRIMMED_PROMPT"
  fi
fi

if [ "$LM_STUDIO_SKIP" != "1" ]; then
LM_STUDIO_HOST=$(gsd_run query config-get review.lm_studio_host 2>/dev/null | jq -r '.' 2>/dev/null || echo "")
if [ -z "$LM_STUDIO_HOST" ] || [ "$LM_STUDIO_HOST" = "null" ]; then LM_STUDIO_HOST="http://localhost:1234"; fi
LM_STUDIO_MODEL=$(gsd_run query config-get review.models.lm_studio 2>/dev/null | jq -r '.' 2>/dev/null || echo "")
if [ -z "$LM_STUDIO_MODEL" ] || [ "$LM_STUDIO_MODEL" = "null" ]; then
  LM_STUDIO_MODEL=$(curl -s --max-time 2 "${LM_STUDIO_HOST}/v1/models" 2>/dev/null | jq -r '.data[0].id // "local-model"' 2>/dev/null || echo "local-model")
fi
LM_STUDIO_RESPONSE=$(jq -n --rawfile content "$LM_STUDIO_PROMPT_FILE" \
  --arg model "$LM_STUDIO_MODEL" \
  '{model: $model, messages: [{role: "user", content: $content}]}' | \
  curl -s --max-time 120 -X POST "${LM_STUDIO_HOST}/v1/chat/completions" \
    -H "Content-Type: application/json" -d @- 2>/dev/null)
LM_STUDIO_ACTUAL_MODEL=$(echo "$LM_STUDIO_RESPONSE" | jq -r '.model // ""' 2>/dev/null || echo "")
if [ -n "$LM_STUDIO_ACTUAL_MODEL" ] && [ "$LM_STUDIO_ACTUAL_MODEL" != "null" ] && [ "$LM_STUDIO_ACTUAL_MODEL" != "$LM_STUDIO_MODEL" ]; then
  echo "Warning: LM Studio served model '$LM_STUDIO_ACTUAL_MODEL' but '$LM_STUDIO_MODEL' was requested. Review may be from a different model." >&2
fi
LM_STUDIO_CONTENT=$(echo "$LM_STUDIO_RESPONSE" | jq -r '.choices[0].message.content // ""' 2>/dev/null || echo "")
if [ -n "$LM_STUDIO_CONTENT" ]; then
  echo "$LM_STUDIO_CONTENT" > {run_dir}/gsd-review-lm_studio.md
else
  echo "Warning: LM Studio returned empty content — skipping review." >&2
fi
fi
```

**llama.cpp (local, OpenAI-compatible):**
```bash
# Resolve prompt budget for llama.cpp: per-reviewer override > global default > null
LLAMA_CPP_REVIEWER_BUDGET=$(gsd_run query config-get review.max_prompt_tokens_per_reviewer.llama_cpp 2>/dev/null | jq -r '.' 2>/dev/null || echo "null")
if [ -z "$LLAMA_CPP_REVIEWER_BUDGET" ] || [ "$LLAMA_CPP_REVIEWER_BUDGET" = "null" ]; then
  LLAMA_CPP_REVIEWER_BUDGET=$(gsd_run query config-get review.max_prompt_tokens 2>/dev/null | jq -r '.' 2>/dev/null || echo "null")
fi

# Apply budget trim for llama.cpp if a budget is configured
LLAMA_CPP_PROMPT_FILE="{run_dir}/gsd-review-prompt.md"
LLAMA_CPP_SKIP=0
if [ -n "$LLAMA_CPP_REVIEWER_BUDGET" ] && [ "$LLAMA_CPP_REVIEWER_BUDGET" != "null" ] && [ "$LLAMA_CPP_REVIEWER_BUDGET" != "0" ]; then
  LLAMA_CPP_TRIMMED_PROMPT="{run_dir}/gsd-review-prompt-llama_cpp.md"
  LLAMA_CPP_TRIM_META="{run_dir}/gsd-review-prompt-llama_cpp.metadata.json"
  prepare_trimmed_prompt_for_reviewer "llama_cpp" "$LLAMA_CPP_REVIEWER_BUDGET" "$LLAMA_CPP_TRIMMED_PROMPT" "$LLAMA_CPP_TRIM_META"
  LLAMA_CPP_EXIT=$?
  if [ $LLAMA_CPP_EXIT -ne 0 ]; then
    if [ $LLAMA_CPP_EXIT -eq 2 ] || [ $LLAMA_CPP_EXIT -eq 11 ]; then
      echo "WARNING: prompt budget for llama_cpp (${LLAMA_CPP_REVIEWER_BUDGET} tokens) is too small for the minimum review set. Skipping llama.cpp reviewer." >&2
    else
      echo "WARNING: prompt-budget returned unexpected exit code ${LLAMA_CPP_EXIT} for llama_cpp. Skipping llama.cpp reviewer." >&2
    fi
    LLAMA_CPP_SKIP=1
  else
    LLAMA_CPP_PROMPT_FILE="$LLAMA_CPP_TRIMMED_PROMPT"
  fi
fi

if [ "$LLAMA_CPP_SKIP" != "1" ]; then
LLAMA_CPP_HOST=$(gsd_run query config-get review.llama_cpp_host 2>/dev/null | jq -r '.' 2>/dev/null || echo "")
if [ -z "$LLAMA_CPP_HOST" ] || [ "$LLAMA_CPP_HOST" = "null" ]; then LLAMA_CPP_HOST="http://localhost:8080"; fi
LLAMA_CPP_MODEL=$(gsd_run query config-get review.models.llama_cpp 2>/dev/null | jq -r '.' 2>/dev/null || echo "")
if [ -z "$LLAMA_CPP_MODEL" ] || [ "$LLAMA_CPP_MODEL" = "null" ]; then
  LLAMA_CPP_MODEL=$(curl -s --max-time 2 "${LLAMA_CPP_HOST}/v1/models" 2>/dev/null | jq -r '.data[0].id // "local-model"' 2>/dev/null || echo "local-model")
fi
LLAMA_CPP_CONTENT=$(jq -n --rawfile content "$LLAMA_CPP_PROMPT_FILE" \
  --arg model "$LLAMA_CPP_MODEL" \
  '{model: $model, messages: [{role: "user", content: $content}]}' | \
  curl -s --max-time 120 -X POST "${LLAMA_CPP_HOST}/v1/chat/completions" \
    -H "Content-Type: application/json" -d @- 2>/dev/null | \
  jq -r '.choices[0].message.content // ""' 2>/dev/null || echo "")
if [ -n "$LLAMA_CPP_CONTENT" ]; then
  echo "$LLAMA_CPP_CONTENT" > {run_dir}/gsd-review-llama_cpp.md
else
  echo "Warning: llama.cpp returned empty content — skipping review." >&2
fi
fi
```

If a CLI or local server fails, log the error and continue with remaining reviewers.

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

## Gemini Review

{gemini review content}

---

## Claude Review

{claude review content}

---

## Codex Review

{codex review content}

---

## CodeRabbit Review

{coderabbit review content}

---

## OpenCode Review

{opencode review content}

---

## OpenCode Review (opencode-deepseek)

{opencode-deepseek instance review content — only present when this instance was selected}

---

## OpenCode Review (opencode-mimo)

{opencode-mimo instance review content — only present when this instance was selected}

---

## Qwen Review

{qwen review content}

---

## Cursor Review

{cursor review content}

---

## Antigravity Review

{antigravity review content}

---

## Ollama Review

{ollama review content}

---

## LM Studio Review

{lm_studio review content}

---

## llama.cpp Review

{llama_cpp review content}

---

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
