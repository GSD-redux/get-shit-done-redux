<purpose>
Execute a trivial task inline without subagent overhead. No PLAN.md, no Task spawning,
no research, no plan checking. Just: understand → do → commit → log.

For tasks like: fix a typo, update a config value, add a missing import, rename a
variable, commit uncommitted work, add a .gitignore entry, bump a version number.

Use /gsd:quick for anything that needs multi-step planning or research.
</purpose>

<process>

<step name="parse_task">
Parse `$ARGUMENTS` for the task description.

If empty, ask:
```
What's the quick fix? (one sentence)
```

Store as `$TASK`.
</step>

<step name="scope_check">
**Before doing anything, verify this is actually trivial.**

A task is trivial if it can be completed in:
- ≤ 3 file edits
- ≤ 1 minute of work
- No new dependencies or architecture changes
- No research needed

If the task seems non-trivial (multi-file refactor, new feature, needs research),
say:

```
This looks like it needs planning. Use /gsd:quick instead:
  /gsd:quick "{task description}"
```

And stop.
</step>

<step name="execute_inline">
Do the work directly:

1. Read the relevant file(s)
2. Make the change(s)
3. Verify the change works (run existing tests if applicable, or do a quick sanity check)

**No PLAN.md.** Just do it.
</step>

<step name="commit">
Commit the change atomically:

```bash
git add -A
git commit -m "fix: {concise description of what changed}"
```

Use conventional commit format: `fix:`, `feat:`, `docs:`, `chore:`, `refactor:` as appropriate.
</step>

<step name="log_to_state">
If `.planning/STATE.md` exists and has a "Quick Tasks Completed" table, append a row
that matches the existing table's schema via the schema-backed `gsd-tools
quick-tasks-append` helper (`markdown-table.cjs`'s `appendQuickTaskRow`; #2133,
ADR-2143 §3/§7). If no table exists, skip silently. If the table's schema is
unrecognized, the helper fails loud (non-zero exit) instead of silently guessing
a column count — this replaces the prior inline `awk NF-2` arithmetic that was
the root cause of #2133.

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=0; if [ -f "$GSD_TOOLS" ]; then _GSD_FOUND=1; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${QODER_CONFIG_DIR:-$HOME/.qoder}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QODER_CONFIG_DIR:-$HOME/.qoder}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; [ "$_GSD_FOUND" = "1" ] && gsd_run() { node "$GSD_TOOLS" "$@"; }; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
# Detect whether STATE.md has a Quick Tasks Completed table
if grep -q "Quick Tasks Completed" .planning/STATE.md 2>/dev/null; then
  gsd_run quick-tasks-append --task "$TASK" || echo "⚠ fast.md log_to_state: could not append Quick Tasks row (see message above); continuing."
fi
```
</step>

<step name="done">
Report completion:

```
✅ Done: {what was changed}
   Commit: {short hash}
   Files: {list of changed files}
```

No next-step suggestions. No workflow routing. Just done.
</step>

</process>

<guardrails>
- NEVER spawn a Task/subagent — this runs inline
- NEVER create PLAN.md or SUMMARY.md files
- NEVER run research or plan-checking
- If the task takes more than 3 file edits, STOP and redirect to /gsd:quick
- If you're unsure how to implement it, STOP and redirect to /gsd:quick
</guardrails>

<success_criteria>
- [ ] Task completed in current context (no subagents)
- [ ] Atomic git commit with conventional message
- [ ] STATE.md updated if it exists
- [ ] Total operation under 2 minutes wall time
</success_criteria>
