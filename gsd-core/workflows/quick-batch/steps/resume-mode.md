**Step 2a: Resume mode (only when `$RESUME_BATCH_ID` is set)**

Skip this step entirely if `$RESUME_BATCH_ID` is empty.

Resume re-derives eligibility via the batch's own `resumeBatch` propagation —
it is the single source of truth for which items are still runnable. Never
re-parse a task list or re-run `quick-batch create` on resume (row 9/16 of
the design's behavior table).

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
CURRENT_BASE=$(git rev-parse HEAD)
QB_RESUME_JSON=$(gsd_run quick-batch resume --batch "$RESUME_BATCH_ID" --current-base-revision "$CURRENT_BASE" --raw)
QB_RESUME_RC=$?
if [[ "$QB_RESUME_JSON" == @file:* ]]; then QB_RESUME_JSON=$(cat "${QB_RESUME_JSON#@file:}"); fi
```

**If `$QB_RESUME_RC` is non-zero:** the resume was refused closed — an unknown
batch id (row 18) or a diverged base revision (row 17, ADR-1239 "Base
divergence"). Print the CLI's error message verbatim and STOP. Do not dispatch
anything, do not create a new batch on the user's behalf.

**Otherwise:** parse `$QB_RESUME_JSON` for `eligible` (array of quick ids),
`transitions` (status changes just applied — e.g. a `blocked` item reverting
to `pending`, or a crash-window STATE-row detection completing an item
without re-appending, row 45), and `manifest` (the full, current batch
document).

```bash
BATCH_ID="$RESUME_BATCH_ID"
BATCH_MANIFEST_JSON=$(printf '%s' "$QB_RESUME_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(JSON.stringify(j.manifest))}catch{process.stdout.write("")}})')
```

Report to user:
```
Resuming batch ${BATCH_ID}: ${eligible.length} item(s) eligible now.
```

If `transitions` is non-empty, display it as a diagnostic (which items moved
to `blocked`/`complete` since the batch was last touched) — this is expected,
successful crash-window recovery, not an error (per the design's negative-space
note: a `resumeBatch` call producing zero transitions is also success, not a
no-op failure).

Continue to Step 3 in `quick-batch.md` — the DAG-layer loop in `planner-wave.md`
reads `$BATCH_MANIFEST_JSON`/`$BATCH_ID` exactly the same way whether this
batch was just created or just resumed; it re-derives per-item progress from
which artifacts already exist on disk (PLAN.md/SUMMARY.md/VERIFICATION.md),
never from a separate "resume" code path.
