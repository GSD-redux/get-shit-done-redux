**Step 9: Completion**

For every item that merged successfully in Step 7 AND (NOT `$VALIDATE_MODE`,
OR Step 8 routed it to `complete`): call `completeQuickItem` via its CLI verb
— this is the ONLY writer of a "Quick Tasks Completed" STATE.md row and the
item's `complete` status; both happen inside ONE lock transaction, exactly
once per item (idempotent — re-running this step for an already-complete
item is a no-op, same guarantee `/gsd:quick` relies on):

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
gsd_run quick-batch complete \
  --batch "$BATCH_ID" \
  --quick-id "$quick_id" \
  --description "$description" \
  --date "$date" \
  --commit "$commit_hash" \
  --directory "$ITEM_DIR" \
  --raw
```

Items NOT reaching this call — `human_needed`, `failed` (planner/checker/
merge/verification failure), or still `blocked`/`pending` (a dependency
failed, row 32) — are left exactly as their respective routing step set
them. No STATE row, no `complete` status, worktree preserved where
applicable.

**Final commit.** Stage every artifact produced this run (PLAN.md, SUMMARY.md,
`--research` RESEARCH.md, `--validate` VERIFICATION.md, per item, plus
`.planning/STATE.md`) and commit:
`$BATCH_ARTIFACT_FILES` is a bash ARRAY (not a plain string — a plain
space-joined string re-splits unpredictably under `set -f`/globbing and
diverges between bash and zsh, the #4109 word-splitting bug class):
```bash
COMMIT_DOCS=$(gsd_run query config-get commit_docs --raw 2>/dev/null || echo "true")
if [ "$COMMIT_DOCS" != "false" ]; then
  git add "${BATCH_ARTIFACT_FILES[@]}" 2>/dev/null
  gsd_run query commit "docs(quick-batch-${BATCH_ID}): ${ITEM_COUNT} item(s)" --files "${BATCH_ARTIFACT_FILES[@]}"
fi
```

**Final report.** Re-load the batch (`gsd_run quick-batch resume --batch
"$BATCH_ID" --raw` — read-only in effect when nothing changed) and summarize
by status:

```
---
GSD > QUICK BATCH COMPLETE

Batch ${BATCH_ID}: ${ITEM_COUNT} item(s)
  Complete: ${complete_count}
  Failed: ${failed_count}${failed_count > 0 ? ' (' + failed_reasons + ')' : ''}
  Needs review: ${human_needed_count}
  Blocked: ${blocked_count}

${failed_count + human_needed_count > 0 ? 'Resume after resolving: /gsd:quick-batch --resume ' + BATCH_ID : ''}
---
```

If EVERY item is `complete`, this is a clean finish — no further action
needed. If any item is `failed`/`human_needed`/`blocked`, the batch stays
resumable: fix the underlying issue (or accept the failure), then re-run
`/gsd:quick-batch --resume ${BATCH_ID}` — `resumeBatch`'s own propagation
(unmodified from Phase 3) re-evaluates eligibility from the current state, no
special quick-batch-side recovery logic needed.
