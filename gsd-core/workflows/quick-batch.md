@~/.claude/gsd-core/references/response-language-directive.md
<purpose>
Batch several `/gsd:quick`-shaped tasks together (#3676, epic #3344, ADR-1239
"Quick-batch binding"). ONE coordinator (this workflow) owns every shared
write — `BATCH.json`, STATE.md, worktree create/merge/cleanup — and never
delegates them to a leaf. Leaves (planner/researcher/checker/executor/
verifier) return structured results only; they never invoke `/gsd:quick`,
never touch `BATCH.json`, and never write STATE.md/ROADMAP.md themselves
(single-writer invariant).

Dispatch decisions (effective concurrency, deterministic merge order, spawn
backpressure, failure/verification routing) are computed by the pure
`quick-batch-dispatch.cts` module (via the `quick-batch` CLI verbs) — this
workflow never re-derives that logic inline.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<available_agent_types>
Valid GSD subagent types (use exact names — do not fall back to 'general-purpose'):
- gsd-phase-researcher — Researches technical approaches for an item
- gsd-planner — Creates a plan for one item (`quick-batch` mode)
- gsd-plan-checker — Reviews one item's plan before execution
- gsd-executor — Executes one item's plan, commits, creates SUMMARY.md
- gsd-verifier — Verifies one item's goal achievement
</available_agent_types>

<process>
**Step 1: Parse arguments, resolve mode**

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
RESPONSE_LANGUAGE=$(gsd_run query config-get response_language --raw --default "" 2>/dev/null || echo "")
```

**If `response_language` is set:** all user-facing questions/prompts/explanations MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English.

Validate `$ARGUMENTS` through the CLI's own grammar — never re-derive it inline (single source of truth: `parseQuickBatchArgs`, `src/quick-batch-dispatch.cts`). `$ARGUMENTS` is raw, attacker-influenced task text — pass it as ONE quoted argument via `--text` so the shell never word-splits or glob-expands it; `quick-batch parse-args` does the whitespace split itself, in Node, after the shell is done:

```bash
QB_PARSE_JSON=$(gsd_run quick-batch parse-args --raw --text "$ARGUMENTS")
QB_PARSE_RC=$?
if [ $QB_PARSE_RC -ne 0 ]; then
  echo "$QB_PARSE_JSON" >&2
  exit 1
fi
if [[ "$QB_PARSE_JSON" == @file:* ]]; then QB_PARSE_JSON=$(cat "${QB_PARSE_JSON#@file:}"); fi
```

Parse `$QB_PARSE_JSON` for `jobs` (`"auto"` or an integer), `validate` (bool), `research` (bool), `resume` (batch id or null). Store as `$JOBS`, `$VALIDATE_MODE`, `$RESEARCH_MODE`, `$RESUME_BATCH_ID`.

Extract the raw task-list text / `--file <path>` from `$ARGUMENTS` (everything that is not `--jobs <v>`, `--validate`, `--research`, `--resume <id>`, or `--file <path>`'s own flag pair).

```bash
VALIDATE_PARAM=""; if [ "$VALIDATE_MODE" = true ]; then VALIDATE_PARAM="--validate"; fi
RESEARCH_PARAM=""; if [ "$RESEARCH_MODE" = true ]; then RESEARCH_PARAM="--research"; fi
INIT=$(gsd_run query init.quick-batch $VALIDATE_PARAM $RESEARCH_PARAM)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
AGENT_SKILLS_PLANNER=$(gsd_run query agent-skills gsd-planner)
AGENT_SKILLS_EXECUTOR=$(gsd_run query agent-skills gsd-executor)
AGENT_SKILLS_CHECKER=$(gsd_run query agent-skills gsd-plan-checker)
AGENT_SKILLS_VERIFIER=$(gsd_run query agent-skills gsd-verifier)
AGENT_SKILLS_RESEARCHER=$(gsd_run query agent-skills gsd-phase-researcher)
```

Parse `$INIT` for: `planner_model`, `executor_model`, `checker_model`, `verifier_model`, `researcher_model`, `commit_docs`, `quick_dir`, `quick_batches_dir`, `roadmap_exists`, `planning_exists`.

<!-- #2517 model-omit-on-inherit -->

> **Model omission (#2517).** Every `Agent()` dispatch below (planner, researcher, plan-checker, executor, verifier) MUST omit the `model` parameter entirely when the value it would carry (`planner_model`, `checker_model`, `executor_model`, `verifier_model`, `researcher_model`) is `"inherit"` or empty. An empty value 404s on runtimes without native tier aliases — the default on non-Claude runtimes, where the installer writes `resolve_model_ids:"omit"`. Omitting it inherits the orchestrator's model. See @gsd-core/references/model-profile-resolution.md.

```bash
STATE_PATH="${quick_dir%/quick}/STATE.md"
PROJECT_PATH="${quick_dir%/quick}/PROJECT.md"
USE_WORKTREES=$(gsd_run query config-get workflow.use_worktrees --raw 2>/dev/null || echo "true")
RUNTIME=$(gsd_run query config-get runtime --default claude --raw 2>/dev/null || echo "claude")
```

**If `roadmap_exists` is false:** Error — quick-batch requires an active project with ROADMAP.md. Run `/gsd:new-project` first.

If the project uses git submodules, parse `SUBMODULE_PATHS` from `.gitmodules` exactly as `/gsd:quick` does (a fail-loud commit-time guard, applied per item at commit time — see `gsd-core/workflows/quick.md` Step 2 for the identical block, reused verbatim below):

```bash
if [ -f .gitmodules ]; then
  SUBMODULE_PATHS=$(git config --file .gitmodules --get-regexp '^submodule\..*\.path$' 2>/dev/null | awk '{print $2}')
else
  SUBMODULE_PATHS=""
fi
```

**Resolve capacity now (#3676 design row 3-4).** `--jobs auto`/omitted uses this
value alone; `--jobs N` is capped by it (`min(taskCount, N, capacity)` — the
`quick-batch effective-concurrency` verb, called per-wave below, does the
arithmetic; this is only the raw resolve):
```bash
CAPACITY=$(gsd_run query dispatch-capacity --raw 2>/dev/null || echo 1)
```

**Resolve isolation now (row 6, 20-22).** Read
@gsd-core/references/dispatch-isolation-gate.md and run its `Resolve
ISOLATION`, `Single-agent dispatch sites`, and `Resolve the harness flag`
blocks in order; they set `ISOLATION`/`HARNESS_FLAG` via `query
dispatch-isolation`. `ISOLATION` gates every worktree decision below —
substitute `{harnessFlag}` in Step 6's `Agent()` with `$HARNESS_FLAG`+comma
when `ISOLATION = "harness-worktree"`, else empty.

If `USE_WORKTREES` is not `"false"`, sweep orphaned worktrees before dispatching anything (mirrors `/gsd:quick`'s own startup sweep):
```bash
if [ "$USE_WORKTREES" != "false" ]; then
  gsd_run query worktree.reap-orphans 2>/dev/null || true
fi
```

Display banner:
```
### GSD ► QUICK BATCH
◆ jobs=${JOBS} validate=${VALIDATE_MODE} research=${RESEARCH_MODE}${RESUME_BATCH_ID:+ resume=${RESUME_BATCH_ID}}
```

---

**Step 2: Resume or create**

If `$RESUME_BATCH_ID` is set: read and execute `gsd-core/workflows/quick-batch/steps/resume-mode.md`.
It loads the batch via `quick-batch
resume`, refuses closed on an unknown batch id or a diverged base revision,
and sets `$BATCH_ID`/`$BATCH_MANIFEST_JSON` for the steps below. Task-list
parsing and `quick-batch create` are skipped entirely.

Otherwise: read and execute `gsd-core/workflows/quick-batch/steps/batch-init.md`.
It parses the task list (inline or `--file`) and creates the
batch via `quick-batch create`, setting the same `$BATCH_ID`/
`$BATCH_MANIFEST_JSON` pair.

Either path converges on the same post-condition — continue to Step 3.

---

<!-- gsd:section id="research-phase" when="flag:--research" -->
If `section_manifest` is `null` or `"research-phase"` is in its `included` list: read and execute `gsd-core/workflows/quick-batch/steps/research-phase.md`. Otherwise skip — do not read the file.
<!-- /gsd:section -->

---

**Step 4: Per-DAG-layer planning**

Read and execute `gsd-core/workflows/quick-batch/steps/planner-wave.md`. It
dispatches a planner per eligible item (one `Agent()` per message, full task
catalog in every prompt), persists parsed `depends_on`/`files_modified` via
`quick-batch update` after each layer, and — when `$VALIDATE_MODE` — runs the
per-item plan-checker loop (`gsd-core/workflows/quick-batch/steps/plan-checker-loop.md`)
before advancing to the next layer.

---

**Step 6: Worktree create + executor dispatch**

Read and execute `gsd-core/workflows/quick-batch/steps/worktree-dispatch.md`.
Worktree create/executor dispatch is serialized per item (one `git worktree
add` in flight at a time); already-created worktrees run concurrently up to
the effective MUTATING-wave concurrency.

---

**Step 7: Deterministic merge**

Read and execute `gsd-core/workflows/quick-batch/steps/merge-wave.md`. Merges
apply strictly in the wave's original dispatch order (`quick-batch
merge-eligible`), never completion order.

---

<!-- gsd:section id="verification-wave" when="flag:--validate" -->
If `section_manifest` is `null` or `"verification-wave"` is in its `included` list: read and execute `gsd-core/workflows/quick-batch/steps/verification-wave.md`. Otherwise skip — do not read the file.
<!-- /gsd:section -->

---

**Step 9: Completion**

Read and execute `gsd-core/workflows/quick-batch/steps/completion.md`. Calls
`completeQuickItem` (via `quick-batch complete`) only for a genuinely
complete item, updates STATE.md, and prints the final batch report.

</process>

<success_criteria>
- [ ] `--discuss`/`--full` rejected with a usage error before any dispatch
- [ ] A malformed `--jobs` value rejected before any dispatch
- [ ] `--resume <batch-id>` skips task-list parsing, dispatches only eligible items
- [ ] Task list parsed (inline or `--file`, ≥2 items) and batch created otherwise
- [ ] Planner dispatched per eligible item per DAG layer, full task catalog in prompt, `depends_on`/`files_modified` requested ALWAYS
- [ ] (--research) Researcher dispatched per item before planning
- [ ] (--validate) Plan-checker loop runs per item after planning (≤2 iterations)
- [ ] Worktree create/merge/cleanup serialized; concurrent leaves inside already-created worktrees
- [ ] `isolation == none` forces a mutating wave's concurrency to 1; a research-only wave is unaffected
- [ ] Merges apply in deterministic wave order, never completion order
- [ ] (--validate) Verifier dispatched per item post-merge; `human_needed` never completes the item, `gaps_found` fails it without rollback or retry
- [ ] A merge_failed/scope_violation item is marked failed with the worktree PRESERVED
- [ ] `completeQuickItem` called only for genuinely complete items; STATE.md updated; artifacts committed
</success_criteria>
