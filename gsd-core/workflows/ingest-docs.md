# Ingest Docs Workflow

Scan a repo for mixed planning documents (ADR, PRD, SPEC, DOC), synthesize them into a consolidated context, and bootstrap or merge into `.planning/`.

- `[path]` — optional target directory to scan (defaults to repo root)
- `--mode new|merge` — override auto-detect (defaults: `new` if `.planning/` absent, `merge` if present)
- `--manifest <file>` — YAML file listing `{path, type, precedence?}` per doc; overrides heuristic classification
- `--resolve auto|interactive` — conflict resolution (v1: only `auto` is supported; `interactive` is reserved)

---

<step name="banner">

Display the stage banner:

```
### GSD ► INGEST DOCS
```

</step>

<step name="parse_arguments">

Parse `$ARGUMENTS`:

- First positional token (if not a flag) → `SCAN_PATH` (default: `.`)
- `--mode new|merge` → `MODE` (default: auto-detect)
- `--manifest <file>` → `MANIFEST_PATH` (optional)
- `--resolve auto|interactive` → `RESOLVE_MODE` (default: `auto`; reject `interactive` in v1 with message "interactive resolution is planned for a future release")

**Validate paths:**

```bash
case "{SCAN_PATH}" in *..*) echo "SECURITY_ERROR: path contains traversal sequence"; exit 1 ;; esac
test -d "{SCAN_PATH}" || echo "PATH_NOT_FOUND"
if [ -n "{MANIFEST_PATH}" ]; then
  case "{MANIFEST_PATH}" in *..*) echo "SECURITY_ERROR: manifest path contains traversal"; exit 1 ;; esac
  test -f "{MANIFEST_PATH}" || echo "MANIFEST_NOT_FOUND"
fi
```

**Containment (required):** After resolving `SCAN_PATH` and `MANIFEST_PATH` relative to the repo root, canonicalize each with `realpath` (or platform equivalent) and assert the result is under `realpath("$REPO_ROOT")`. Reject absolute paths outside the repo (e.g. `/tmp`, `C:\Windows`) even when they do not contain `..`.

If `PATH_NOT_FOUND` or `MANIFEST_NOT_FOUND`: display error and exit.

</step>

<step name="init_and_mode_detect">

Run the init query:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
RESPONSE_LANGUAGE=$(gsd_run query config-get response_language --raw --default "" 2>/dev/null || echo "")
INIT=$(gsd_run init ingest-docs)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
CLASSIFIER_MODEL=$(gsd_run query resolve-model gsd-doc-classifier --raw)
SYNTHESIZER_MODEL=$(gsd_run query resolve-model gsd-doc-synthesizer --raw)
ROADMAPPER_MODEL=$(gsd_run query resolve-model gsd-roadmapper --raw)
```

**If `response_language` is set:** All user-facing output of this workflow — narration between tool calls, status updates, progress notes, findings, questions, prompts, and explanations — MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated.

Parse `project_exists`, `planning_exists`, `has_git`, `git_worktree_root`, `in_nested_subdir`, `project_path` from INIT.

**Absolute path fields (#2376):** INIT also carries `requirements_path`, `roadmap_path`, `state_path`, `intel_dir`, and `conflicts_path` — all anchored on `project_root`, not the orchestrator's own cwd. Use these (not bare `.planning/...` literals) whenever building `<required_reading>`/output paths for a spawned subagent, since that subagent's own cwd may differ from the orchestrator's.

**Auto-detect MODE** if not set:
- `planning_exists: true` → `MODE=merge`
- `planning_exists: false` → `MODE=new`

If user passed `--mode new` but `.planning/` already exists: display warning and require explicit confirm via `AskUserQuestion` (approve-revise-abort from `gsd-core/references/gate-prompts.md`) before overwriting.

Git initialisation (Bug #3491 — never create a nested `.git` inside an existing worktree):

- If `has_git: true` and `in_nested_subdir: true`: do NOT run `git init`. Surface a warning that planning files will be tracked by the outer repo at `git_worktree_root`.
- If `has_git: true` and `in_nested_subdir: false`: already at a worktree root, skip `git init`.
- If `has_git: false` and `MODE=new`: initialize git:

```bash
git init
```

**Detect runtime** using the same pattern as `new-project.md`:
- execution_context path `/.codex/` → `RUNTIME=codex`
- `/.gemini/` → `RUNTIME=gemini`
- `/.opencode/` or `/.config/opencode/` → `RUNTIME=opencode`
- `/.trae/` → `RUNTIME=trae`
- else → `RUNTIME=claude`

Fall back to env vars (`CODEX_HOME`, `GEMINI_CONFIG_DIR`, `OPENCODE_CONFIG_DIR`, `TRAE_CONFIG_DIR`) if execution_context is unavailable.

</step>

<step name="discover_docs">

Build the doc list from three sources, in order:

**1. Manifest (if provided)** — authoritative:

Read `MANIFEST_PATH`. Expected YAML shape:

```yaml
docs:
  - path: docs/adr/0001-db.md
    type: ADR
    precedence: 0   # optional, lower = higher precedence
  - path: docs/prd/auth.md
    type: PRD
```

Each entry provides `path` (required, relative to repo root) + `type` (required, one of ADR|PRD|SPEC|DOC) + `precedence` (optional integer).

**2. Directory conventions** (skipped when manifest is provided):

```bash
# ADRs
find {SCAN_PATH} -type f \( -path '*/adr/*' -o -path '*/adrs/*' -o -name 'ADR-*.md' -o -regex '.*/[0-9]\{4\}-.*\.md' \) 2>/dev/null

# PRDs
find {SCAN_PATH} -type f \( -path '*/prd/*' -o -path '*/prds/*' -o -name 'PRD-*.md' \) 2>/dev/null

# SPECs / RFCs
find {SCAN_PATH} -type f \( -path '*/spec/*' -o -path '*/specs/*' -o -path '*/rfc/*' -o -path '*/rfcs/*' -o -name 'SPEC-*.md' -o -name 'RFC-*.md' \) 2>/dev/null

# Generic docs (fall-through candidates)
find {SCAN_PATH} -type f -path '*/docs/*' -name '*.md' 2>/dev/null
```

De-duplicate the union (a file matched by multiple patterns is one doc).

**3. Content heuristics** (run during classification, not here) — the classifier handles frontmatter `type:` and H1 inspection for docs that didn't match a convention.

**Cap:** hard limit of 50 docs per invocation (documented v1 constraint). If the discovered set exceeds 50:

```
GSD > Discovered {N} docs, which exceeds the v1 cap of 50.
      Use --manifest to narrow the set to ≤ 50 files, or run
      /gsd:ingest-docs again with a narrower <path>.
```

Exit without proceeding.

**Display discovered set** and request approval (see `gsd-core/references/gate-prompts.md` — `yes-no-pick` pattern works; or `approve-revise-abort`):

```
Discovered {N} documents:
  {N} ADR | {N} PRD | {N} SPEC | {N} DOC | {N} unclassified

  docs/adr/0001-architecture.md       [ADR]    (from manifest|directory|heuristic)
  docs/adr/0002-database.md           [ADR]    (directory)
  docs/prd/auth.md                    [PRD]    (manifest)
  ...
```

**Text mode:** apply the same `--text`/`text_mode` rule as other workflows — replace `AskUserQuestion` with a numbered list.

Use `AskUserQuestion` (approve-revise-abort):
- question: "Proceed with classification of these {N} documents?"
- header: "Approve?"
- options: Approve | Revise | Abort

On Abort: exit cleanly with "Ingest cancelled."
On Revise: exit with guidance to re-run with `--manifest` or a narrower path.

</step>

<step name="classify_parallel">

Create staging directory:

```bash
mkdir -p .planning/intel/classifications/
```

For each discovered doc, spawn `gsd-doc-classifier` in parallel. In Claude Code, issue all Task calls in a single message with multiple tool uses so the harness runs them concurrently. For Copilot / sequential runtimes, fall back to sequential dispatch.

<!-- #2517 model-omit-on-inherit -->

> **Model omission (#2517).** Omit the `model` parameter entirely when the value it would carry (`CLASSIFIER_MODEL`, `SYNTHESIZER_MODEL`, `ROADMAPPER_MODEL`) is `"inherit"` or empty. An empty value 404s on runtimes without native tier aliases — the default on non-Claude runtimes. Omitting it inherits the orchestrator's model. See @gsd-core/references/model-profile-resolution.md.

Per-spawn prompt fields:
- `FILEPATH` — absolute path to the doc
- `OUTPUT_DIR` — `{intel_dir}/classifications` (absolute — from `init ingest-docs`; #2376: a spawned classifier's own cwd may differ from the orchestrator's)
- `MANIFEST_TYPE` — the type from the manifest if present, else omit
- `MANIFEST_PRECEDENCE` — the precedence integer from the manifest if present, else omit
- `<required_reading>` — `agents/gsd-doc-classifier.md` (the agent definition itself)

**Model on every classifier spawn (#3602):** `model="{CLASSIFIER_MODEL}"` is a parameter of each Task/Agent call — not a prompt field, never folded into the prompt text — so `dynamic_routing`/`model_profile` tiers apply instead of the caller's session model. Omit the parameter per the rule above when the value is `"inherit"` or empty.

Collect the one-line confirmations from each classifier. If any classifier errors out, surface the error and abort without touching `.planning/` further.

</step>

<step name="synthesize">

Spawn `gsd-doc-synthesizer` once (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze):

<!-- #2508 runtime-aware-dispatch -->

> **Runtime-aware dispatch (#2508 Phase 4).** GSD workflows dispatch specialized subagents by role. Before dispatching on a built-in-only runtime (kimi-code — three built-ins only), resolve the role to a built-in via `gsd_run query resolve-dispatch-type --requested <role> --raw`. On named-dispatch runtimes (Claude/OpenCode/…) the role is returned unchanged; on kimi-code it maps to `coder`/`explore`/`plan` by role-suffix. The persona rides `${AGENT_SKILLS_<ROLE>}` (Phase 3) regardless. See @gsd-core/references/runtime-aware-dispatch.md.

```
Agent({
  subagent_type: "gsd-doc-synthesizer",
  model: "{SYNTHESIZER_MODEL}",
  prompt: "
    CLASSIFICATIONS_DIR: {intel_dir}/classifications
    INTEL_DIR: {intel_dir}
    CONFLICTS_PATH: {conflicts_path}
    MODE: {MODE}
    EXISTING_CONTEXT: {paths to existing .planning files if MODE=merge, else empty}
    PRECEDENCE: {array from manifest defaults or default ['ADR','SPEC','PRD','DOC']}

    <required_reading>
    - agents/gsd-doc-synthesizer.md
    - gsd-core/references/doc-conflict-engine.md
    </required_reading>
  "
})
```

> **ORCHESTRATOR RULE — CODEX RUNTIME**: After calling Agent() above, stop working on this task immediately. Do not read or synthesize any classified documents independently while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

The synthesizer writes:
- `.planning/intel/decisions.md`, `.planning/intel/requirements.md`, `.planning/intel/constraints.md`, `.planning/intel/context.md`
- `.planning/intel/SYNTHESIS.md`
- `.planning/INGEST-CONFLICTS.md`

</step>

<step name="conflict_gate">

Read `.planning/INGEST-CONFLICTS.md`. Count entries in each bucket (the synthesizer always writes the three-bucket header; parse the `### BLOCKERS ({N})`, `### WARNINGS ({N})`, `### INFO ({N})` lines).

Apply the safety semantics from `gsd-core/references/doc-conflict-engine.md`. Operation noun: `ingest`.

**If BLOCKERS > 0:**

Render the report to the user, then display:

```
GSD > BLOCKED: {N} blockers must be resolved before ingest can proceed.
```

Exit WITHOUT writing PROJECT.md, REQUIREMENTS.md, ROADMAP.md, or STATE.md. The staging intel files remain for inspection. The safety gate holds — no destination files are written when blockers exist.

**If WARNINGS > 0 and BLOCKERS = 0:**

Render the report, then ask via AskUserQuestion (approve-revise-abort):
- question: "Review the competing variants above. Resolve manually and proceed, or abort?"
- header: "Approve?"
- options: Approve | Abort

On Abort: exit cleanly with "Ingest cancelled. Staged intel preserved at `.planning/intel/`."

**If BLOCKERS = 0 and WARNINGS = 0:**

Optionally display `GSD > No conflicts. Auto-resolved: {N}.` Absence of conflicts is not authorization to write: proceed to the routing gate for the active mode — new mode's routing gate (next step) or merge mode's merge-diff approve-revise-abort gate — which decides whether destination files are created.

</step>

<step name="route_new_mode">

**Applies only when MODE=new.**

Audit PROJECT.md field requirements that `gsd-roadmapper` expects. For fields derivable from `.planning/intel/SYNTHESIS.md` (project scope, goals/non-goals, constraints, locked decisions), synthesize from the intel. For fields NOT derivable (project name, developer-facing success metric, target runtime), prompt via `AskUserQuestion` one at a time — minimal question set, no interrogation.

**Routing gate (#3827): approval to classify documents is not approval to write the planning scaffold.** Before delegating, display the exact destinations and require an explicit choice:

```
Routing — create the planning setup now?

  .planning/PROJECT.md        (new)
  .planning/REQUIREMENTS.md   (new)
  .planning/ROADMAP.md        (new)
  .planning/STATE.md          (new)
```

Use `AskUserQuestion`:
- question: "Routing — create the planning setup now?"
- header: "Routing"
- options: Create planning setup | Keep synthesized intel only | Abort

**Text mode:** numbered list (1/2/3) with the same three choices.

On **Create planning setup**: continue to the `gsd-roadmapper` delegation below.

On **Keep synthesized intel only**: analysis-only ingest. Do NOT invoke `gsd-roadmapper`; write no destination files. The staged intel under `.planning/intel/` is preserved and committed by `finalize` (substitute its actual file set — no PROJECT.md/REQUIREMENTS.md/ROADMAP.md/STATE.md lines). Display the completion banner with mode `new (intel only)`.

On **Abort**: exit cleanly with "Ingest cancelled. Staged intel preserved at `.planning/intel/`."

Any other response (freeform/"Other"): re-ask once; if still ambiguous, treat as Abort. Never infer Create from an ambiguous answer.

Delegate to `gsd-roadmapper` (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze):

```
Agent({
  subagent_type: "gsd-roadmapper",
  model: "{ROADMAPPER_MODEL}",
  prompt: "
    Mode: new-project-from-ingest
    Intel: {intel_dir}/SYNTHESIS.md (entry point)
    Per-type intel: {intel_dir}/decisions.md, {intel_dir}/requirements.md, {intel_dir}/constraints.md, {intel_dir}/context.md
    User-supplied fields: {collected in previous step}

    Produce:
    - {project_path}
    - {requirements_path}
    - {roadmap_path}
    - {state_path}

    Treat ADR-locked decisions as locked in PROJECT.md <decisions> blocks.
  "
})
```

> **ORCHESTRATOR RULE — CODEX RUNTIME**: After calling Agent() above, stop working on this task immediately. Do not read more intel files, write planning artifacts, or create ROADMAP.md independently while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

</step>

<step name="route_merge_mode">

**Applies only when MODE=merge.**

Load existing `.planning/ROADMAP.md`, `.planning/PROJECT.md`, `.planning/REQUIREMENTS.md`, all `CONTEXT.md` files under `.planning/phases/`.

The synthesizer has already hard-blocked on any LOCKED-in-ingest vs LOCKED-in-existing contradiction; if we reach this step, no such blockers remain.

Plan the merge:
- **New requirements** from synthesized `.planning/intel/requirements.md` that do not overlap existing REQUIREMENTS.md entries → append to REQUIREMENTS.md
- **New decisions** from synthesized `.planning/intel/decisions.md` that do not overlap existing CONTEXT.md `<decisions>` blocks → write to a new phase's CONTEXT.md or append to the next milestone's requirements
- **New scope** → derive phase additions following the `new-milestone.md` pattern; append phases to `.planning/ROADMAP.md`

Preview the merge diff to the user and gate via approve-revise-abort before writing.

</step>

<step name="finalize">

Commit the ingest results:

```bash
gsd_run commit \
  "docs: ingest {N} docs from {SCAN_PATH} (#2387)" --files \
  .planning/PROJECT.md \
  .planning/REQUIREMENTS.md \
  .planning/ROADMAP.md \
  .planning/STATE.md \
  .planning/intel/ \
  .planning/INGEST-CONFLICTS.md
```

(For merge mode, substitute the actual set of modified files.)

Display completion:

```
### GSD ► INGEST DOCS COMPLETE
```

Show:
- Mode ran (new, new (intel only), or merge)
- Docs ingested (count + type breakdown)
- Decisions locked, requirements created, constraints captured
- Conflict report path (`.planning/INGEST-CONFLICTS.md`)
- Next step: `/gsd:plan-phase 1` (new) or `/gsd:plan-phase N` (merge, pointing at the first newly-added phase); for intel-only runs there is no roadmap yet — point at `/gsd:new-project` (or a later re-run with `--mode merge` once scaffold files exist), never `/gsd:plan-phase`

</step>

---

## Anti-Patterns

Do NOT:
- Violate the shared conflict-engine contract in `gsd-core/references/doc-conflict-engine.md` (no markdown tables, no new severity labels, no bypass of the BLOCKER gate)
- Write PROJECT.md, REQUIREMENTS.md, ROADMAP.md, or STATE.md when BLOCKERs exist in the conflict report
- Skip the 50-doc cap — larger sets must use `--manifest` to narrow the scope
- Auto-resolve LOCKED-vs-LOCKED ADR contradictions — those are BLOCKERs in both modes
- Merge competing PRD acceptance variants into a combined criterion — preserve all variants for user resolution
- Bypass the discovery approval gate — users must see the classified doc list before classifiers spawn
- Skip path validation on `SCAN_PATH` or `MANIFEST_PATH`
- Implement `--resolve interactive` in this v1 — the flag is reserved; reject with a future-release message
