<purpose>

Archive accumulated phase directories from completed milestones into `.planning/milestones/v{X.Y}-phases/`. Identifies which phases belong to each completed milestone, shows a dry-run summary, and moves directories on confirmation.

</purpose>

<required_reading>

1. `.planning/MILESTONES.md`
2. `.planning/milestones/` directory listing
3. `.planning/phases/` directory listing

</required_reading>

<process>
```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=0; if [ -f "$GSD_TOOLS" ]; then _GSD_FOUND=1; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${QODER_CONFIG_DIR:-$HOME/.qoder}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QODER_CONFIG_DIR:-$HOME/.qoder}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; [ "$_GSD_FOUND" = "1" ] && gsd_run() { node "$GSD_TOOLS" "$@"; }; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
RESPONSE_LANGUAGE=$(gsd_run query config-get response_language --default "" 2>/dev/null || echo "")
```

**If `response_language` is set:** All user-facing questions, prompts, and explanations in this workflow MUST be presented in `{response_language}`. Technical terms, code, file paths, and subagent prompts stay in English — only user-facing output is translated.


<step name="identify_completed_milestones">

Read `.planning/MILESTONES.md` to identify completed milestones and their versions.

```bash
cat .planning/MILESTONES.md
```

Extract each milestone version (e.g., v1.0, v1.1, v2.0).

Check which milestone archive dirs already exist:

```bash
ls -d .planning/milestones/v*-phases 2>/dev/null || true
```

Filter to milestones that do NOT already have a `-phases` archive directory.

If all milestones already have phase archives:

```
All completed milestones already have phase directories archived. Nothing to clean up.
```

Stop here.

</step>

<step name="determine_phase_membership">

For each completed milestone without a `-phases` archive, read the archived ROADMAP snapshot to determine which phases belong to it:

```bash
cat .planning/milestones/v{X.Y}-ROADMAP.md
```

Extract phase numbers and names from the archived roadmap (e.g., Phase 1: Foundation, Phase 2: Auth).

Check which of those phase directories still exist in `.planning/phases/`:

```bash
ls -d .planning/phases/*/ 2>/dev/null || true
```

Match phase directories to milestone membership. Only include directories that still exist in `.planning/phases/`.

</step>

<step name="show_dry_run">

Present a dry-run summary for each milestone:

```
## Cleanup Summary

### v{X.Y} — {Milestone Name}
These phase directories will be archived:
- 01-foundation/
- 02-auth/
- 03-core-features/

Destination: .planning/milestones/v{X.Y}-phases/

### v{X.Z} — {Milestone Name}
These phase directories will be archived:
- 04-security/
- 05-hardening/

Destination: .planning/milestones/v{X.Z}-phases/
```

**Stale local branches (upstream gone):**

First, update remote-tracking refs so the candidate list matches the execution list exactly:

```bash
git fetch --prune 2>/dev/null || true
```

Then enumerate candidates (protected branch names are excluded even if their upstream is gone):

```bash
git branch -vv | awk '/: gone\]/ { if ($1 !~ /^\*$|^main$|^next$|^trunk$|^develop$/) print $1 }'
```

Show each branch name. If none, show:

```
No stale local branches detected.
```

If no phase directories remain to archive (all already moved or deleted) AND no stale branches exist:

```
No phase directories found to archive. Phases may have been removed or archived previously.
No stale local branches detected either.
```

Stop here.


**Text mode (`workflow.text_mode: true` in config or `--text` flag):** Set `TEXT_MODE=true` if `--text` is present in `$ARGUMENTS` OR `text_mode` from init JSON is `true`. When TEXT_MODE is active, replace every `AskUserQuestion` call with a plain-text numbered list and ask the user to type their choice number. This is required for non-Claude runtimes (OpenAI Codex, Gemini CLI, etc.) where `AskUserQuestion` is not available.
AskUserQuestion: "Proceed with archiving and pruning?" with options: "Yes — archive phases and prune stale branches" | "Cancel"

If "Cancel": Stop.

</step>

<step name="archive_phases">

For each milestone, move phase directories:

```bash
mkdir -p .planning/milestones/v{X.Y}-phases
```

For each phase directory belonging to this milestone:

```bash
mv .planning/phases/{dir} .planning/milestones/v{X.Y}-phases/
```

Repeat for all milestones in the cleanup set.

</step>

<step name="prune_local_branches">

After phase archival, prune local branches whose upstream has been deleted. Use the same filter as the dry-run so the execution list matches exactly what the user confirmed:

```bash
git branch -vv | awk '/: gone\]/ { if ($1 !~ /^\*$|^main$|^next$|^trunk$|^develop$/) print $1 }' | xargs -r git branch -D
```

Notes:
- `git fetch --prune` already ran in `show_dry_run` — the tracking refs are current and this step enumerates from the same state the user confirmed.
- `!~ /^\*$/` skips the currently checked-out branch (prefixed with `* ` in `git branch -vv` output, so `$1` yields `*`).
- `!~ /^main$|^next$|^trunk$|^develop$/` excludes protected branch names even if their upstream is gone — matches the dry-run exclusion exactly.
- `xargs -r` prevents `git branch -D` from running with no arguments when no stale branches exist.

</step>

<step name="commit">

Commit the changes:

```bash
gsd_run query commit "chore: archive phase directories from completed milestones" --files .planning/milestones/ .planning/phases/
```

</step>

<step name="report">

```
Archived:
{For each milestone}
- v{X.Y}: {N} phase directories → .planning/milestones/v{X.Y}-phases/

Pruned: {N} local branches whose upstream is gone.

.planning/phases/ cleaned up.
```

</step>

</process>

<success_criteria>

- [ ] All completed milestones without existing phase archives identified
- [ ] Phase membership determined from archived ROADMAP snapshots
- [ ] Dry-run summary shown and user confirmed (covers both archival and pruning)
- [ ] Phase directories moved to `.planning/milestones/v{X.Y}-phases/`
- [ ] Stale local branches pruned (branches whose upstream is gone)
- [ ] Changes committed

</success_criteria>
