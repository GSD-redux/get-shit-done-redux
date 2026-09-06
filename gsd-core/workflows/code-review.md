@~/.claude/gsd-core/references/response-language-directive.md

<purpose>
Review source files changed during a phase for bugs, security issues, and code quality problems. Computes file scope (--files override > SUMMARY.md > git diff fallback), checks config gate, spawns gsd-code-reviewer agent, commits REVIEW.md, and presents results to user. When --fix is passed, delegates to code-review-fix.md after review to auto-apply findings via gsd-code-fixer.
</purpose>

<required_reading>
Read all files referenced by the invoking prompt's execution_context before starting.
</required_reading>

<available_agent_types>
- gsd-code-reviewer: Reviews source files for bugs and quality issues
- gsd-code-fixer: Applies fixes to code review findings (used via dispatch_fix → code-review-fix.md when --fix is passed)
</available_agent_types>

<process>

<step name="initialize">
Parse arguments and load project state:

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
PHASE_ARG="${1}"

# Parse all code-review flags into a structured IR via code-review-flags.cjs.
# This is the canonical flag-parsing surface — do not replicate inline bash parsing
# for --fix/--all/--auto here; the module handles all flag extraction and implication
# logic (e.g., --all and --auto imply --fix). Resolved BEFORE the init call below so
# the section-manifest gate forwards the RESOLVED (post-implication) fix decision, not
# just a literal --fix token check.
FLAGS_JSON=$(node -e "
  const { parseCodeReviewFlags } = require('./gsd-core/bin/lib/code-review-flags.cjs');
  const flags = parseCodeReviewFlags(process.argv.slice(1));
  process.stdout.write(JSON.stringify(flags));
" -- "$@" 2>/dev/null)

# Extract individual flag values from the IR
FIX_FLAG=$(echo "$FLAGS_JSON" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).fix))")
FIX_ALL=$(echo "$FLAGS_JSON" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).all))")
FIX_AUTO=$(echo "$FLAGS_JSON" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).auto))")
DEPTH_OVERRIDE=$(echo "$FLAGS_JSON" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).depth)")
FILES_OVERRIDE=$(echo "$FLAGS_JSON" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).files)")

# Forward the resolved fix decision (--fix itself, or --all/--auto implying it) to
# init.code-review so section_manifest's flag:--fix gating (dispatch-fix section)
# matches code-review-flags.cjs's own implication logic rather than a raw token scan.
FIX_PARAM=""
if [ "$FIX_FLAG" = "true" ]; then FIX_PARAM="--fix"; fi

INIT=$(gsd_run query init.code-review "${PHASE_ARG}" $FIX_PARAM)
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
AGENT_SKILLS_REVIEWER=$(gsd_run query agent-skills gsd-code-reviewer)
# #2072: resolve the routed model so model_overrides / models.verification are honored
# (the resolver maps gsd-code-reviewer → phaseType "verification"); thread it below.
REVIEWER_MODEL=$(gsd_run query resolve-model gsd-code-reviewer --raw)
```

Parse from init JSON: `phase_found`, `phase_dir`, `phase_number`, `phase_name`, `padded_phase`, `commit_docs`, `fallow_enabled`, `fallow_scope`, `fallow_profile`, `fallow_mcp`, `fallow_max_crap`.

**Input sanitization (defense-in-depth):**
```bash
# Validate PADDED_PHASE contains only digits and optional dot (e.g., "02", "03.1")
if ! [[ "$PADDED_PHASE" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
  echo "Error: Invalid phase number format: '${PADDED_PHASE}'. Expected digits (e.g., 02, 03.1)."
  # Exit workflow
fi
```

**Phase validation (before config gate):**
If `phase_found` is false, report error and exit:
```
Error: Phase ${PHASE_ARG} not found. Run /gsd:progress to see available phases.
```

This runs BEFORE config gate check so user errors are surfaced immediately regardless of config state.

If FILES_OVERRIDE is set, split by comma into array:
```bash
if [ -n "$FILES_OVERRIDE" ]; then
  IFS=',' read -ra FILES_ARRAY <<< "$FILES_OVERRIDE"
fi
```
</step>

<step name="check_config_gate">
Check if code review is active via `workflow.code_review` (the capability's on/off toggle — independent of `workflow.code_review_point`, the loop-point selector; a manual invocation must work regardless of which automatic point is currently configured):

```bash
CODE_REVIEW_ENABLED=$(gsd_run query config-get workflow.code_review --raw 2>/dev/null || echo "true")
```

If `CODE_REVIEW_ENABLED` is not `"true"`:
```
Code review skipped (code-review capability inactive)
```
Exit workflow.

Default is active (`workflow.code_review` schema default is `true`) — only skip when explicitly disabled. This check runs AFTER phase validation so invalid phase errors are shown first.
</step>

<step name="compute_file_scope">
Three-tier scoping with explicit precedence:

Compute the phase's last review commit, if any. This narrows Tiers 2 and 3 below to what
changed since that review (wave-scoped reviews under `workflow.code_review_point=execute:wave:post`):

```bash
# #3661: incremental scoping — when this phase has a prior review, later tiers
# narrow to what changed since it (wave-scoped reviews under
# workflow.code_review_point=execute:wave:post). Empty on a phase's first review
# (the entire execute:post-default path), in which case Tiers 2 and 3 below are
# unchanged from today.
LAST_REVIEW_COMMIT=$(git log --format=%H -1 -- "${PHASE_DIR}/${PADDED_PHASE}-REVIEW.md" 2>/dev/null)
```

**Tier 1 — --files override (highest precedence per D-08):**

If FILES_OVERRIDE is set (from --files flag):
```bash
if [ -n "$FILES_OVERRIDE" ]; then
  REVIEW_FILES=()
  REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
  
  for file_path in "${FILES_ARRAY[@]}"; do
    # Security: validate path is within repository (prevent path traversal)
    ABS_PATH=$(realpath -m "${file_path}" 2>/dev/null || echo "${file_path}")
    if [[ "$ABS_PATH" != "$REPO_ROOT"* ]]; then
      echo "Error: File path outside repository, skipping: ${file_path}"
      continue
    fi
    
    # Validate path exists (relative to repo root)
    if [ -f "${REPO_ROOT}/${file_path}" ] || [ -f "${file_path}" ]; then
      REVIEW_FILES+=("$file_path")
    else
      echo "Warning: File not found, skipping: ${file_path}"
    fi
  done
  
  echo "File scope: ${#REVIEW_FILES[@]} files from --files override"
fi
```

Skip SUMMARY/git scoping entirely when --files is provided.

**Tier 2 — SUMMARY.md extraction (primary per D-01):**

If --files NOT provided:
```bash
if [ -z "$FILES_OVERRIDE" ]; then
  SUMMARIES=$(ls "${PHASE_DIR}"/*-SUMMARY.md 2>/dev/null)
  REVIEW_FILES=()
  
  if [ -n "$SUMMARIES" ]; then
    # Rewrapped through unquoted command substitution (gsd-core#4109): a bare
    # `$VAR` word-splits under bash but not zsh, collapsing every element onto
    # one iteration there.
    for summary in $(printf '%s' "$SUMMARIES"); do
      # #3661: skip a SUMMARY.md unchanged since the phase's last review — this
      # summary's plan was already reviewed. No-op (every summary is "changed") when
      # LAST_REVIEW_COMMIT is empty. Fails OPEN on any git error (file stays in scope)
      # — never silently drop a file because a git command errored.
      if [ -n "$LAST_REVIEW_COMMIT" ] && git diff --quiet "${LAST_REVIEW_COMMIT}" HEAD -- "$summary" 2>/dev/null; then
        continue
      fi

      # Extract key_files.created and key_files.modified using node for reliable YAML parsing
      # This avoids fragile awk parsing that breaks on indentation differences
      EXTRACTED=$(node -e "
        const fs = require('fs');
        const content = fs.readFileSync('$summary', 'utf-8');
        const match = content.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
        if (!match) { process.exit(0); }
        const yaml = match[1];
        const files = [];
        let inSection = null;
        for (const line of yaml.split('\n')) {
          if (/^\s+created:/.test(line)) { inSection = 'created'; continue; }
          if (/^\s+modified:/.test(line)) { inSection = 'modified'; continue; }
          if (/^\s*[\w-]+:/.test(line) && !/^\s*-/.test(line)) { inSection = null; continue; }
          if (inSection && /^\s+-\s+(.+)/.test(line)) {
            let raw = line.match(/^\s+-\s+(.+)/)[1].trim();
            raw = raw.replace(/^['"]|['"]$/g, '');
            raw = raw.replace(/\s+\([^)]*\)\s*$/, '');
            raw = raw.split(/\s+—\s/)[0].trim();
            // #2666: accept root-level paths (no `/`) and known extensionless build
            // files, not only nested paths with a trailing extension. The pre-fix
            // guard required BOTH a directory separator AND a trailing dot-extension,
            // which silently dropped every repository-root file (Dockerfile,
            // renovate.json, AGENTS.md, package.json, .gitlab-ci.yml, …) and every
            // extensionless build file anywhere in the tree (**/Dockerfile, **/Makefile).
            // Prose bullets are rejected by the known-filename / has-extension
            // distinction, with the post-processing existence check (`[ -f ]`) as a
            // backstop — a prose string is never a real file on disk.
            const KNOWN_EXTENSIONLESS_BUILD_FILES = new Set([
              'dockerfile', 'containerfile', 'makefile', 'justfile', 'procfile',
            ]);
            const hasExtension = /\.[A-Za-z0-9]+$/.test(raw);
            const basename = raw.split('/').pop().toLowerCase();
            if (hasExtension || KNOWN_EXTENSIONLESS_BUILD_FILES.has(basename)) {
              files.push(raw);
            }
          }
        }
        if (files.length) console.log(files.join('\n'));
      " 2>/dev/null)
      
      # Add extracted files to REVIEW_FILES array
      if [ -n "$EXTRACTED" ]; then
        while IFS= read -r file; do
          if [ -n "$file" ]; then
            REVIEW_FILES+=("$file")
          fi
        done <<< "$EXTRACTED"
      fi
    done
    
    if [ ${#REVIEW_FILES[@]} -eq 0 ]; then
      echo "Warning: SUMMARY artifacts found but contained no file paths. Falling back to git diff."
    fi
  fi
fi
```

**Tier 3 — Git diff fallback (per D-02) and SUMMARY/diff cross-check (per #2666):**

If no SUMMARY.md files found OR no files extracted from them, fall back to the git diff.
Additionally, whenever a reliable diff base is available, cross-check the SUMMARY scope
against the diff and warn about (then add) any changed files the SUMMARY extractor did not
surface — so a partial SUMMARY result can no longer silently mask the rest of the phase.
```bash
# Compute diff base from phase commits — fail closed if no reliable base found.
# #3503: anchor the grep to GSD's own conventional-commit phase scopes — the
# subject-line formats this system itself emits (docs(phase-N): from
# execute-phase.md, plan scopes feat(N-MM):/test(N-MM): from references/tdd.md,
# bare phase scopes docs(N):). The #2989/#3191 prose anchor "[Pp]hase N"
# matched free prose in ANY commit body — planning commits forward-reference
# later phases ("deferred to Phase N per D-09"), doc commits use "### Phase N"
# as a format example — and tail -1 (oldest match) turned each false positive
# into a base unboundedly before the phase, while GSD's own scope commits
# never contain the literal "Phase N" at all. The ^ anchor makes this a
# subject-line match, so commit-body prose can never capture the base.
# Workflows emit the UNPADDED roadmap phase number (docs(phase-6):) while
# PADDED_PHASE is zero-padded ("06") — accept both spellings.
# #3191: stay POSIX-ERE portable — the boundary is the closing paren + colon,
# never \b (not a POSIX ERE token; under --extended-regexp it silently matches
# nothing on macOS regex(3), making this fallback dead on Apple platforms).
# #3995: a phase number is unique within a MILESTONE, not a repository. The
# former message grep had no milestone bound, and its tail -1 deliberately
# selected the OLDEST matching subject — dragging in previous milestones'
# same-numbered phases and taking a 7-file phase to a 3388-file scope (plus
# the >50 depth downgrade). The phase's own directory is the unique identity:
# base = the parent of the first commit that added anything under PHASE_DIR
# (the same anchor class git-base-branch's phaseStartCommit uses for
# complexity triggering). Message subjects demonstrably do not carry enough
# information to identify a phase — this was the grep's fifth failure.
# KNOWN RESIDUAL: git log -- <dir> does not follow renames, so a LATER
# milestone that reuses BOTH number and slug re-creates the same literal
# path and the oldest A-commit is the previous occupant's. Number+slug
# reuse is the narrow trigger; the reported archived-milestone case (dirs
# move under milestones/ on archive) is closed.
PHASE_START=$(git log --format="%H" --diff-filter=A -- "${PHASE_DIR}" 2>/dev/null | tail -1)
DIFF_BASE=""
if [ -n "$LAST_REVIEW_COMMIT" ]; then
  # #3661: a prior review exists — narrow the diff base to since that review
  # (wave-scoped) instead of the whole phase.
  DIFF_BASE="$LAST_REVIEW_COMMIT"
elif [ -n "$PHASE_START" ]; then
  if git rev-parse "${PHASE_START}^" >/dev/null 2>&1; then
    DIFF_BASE="${PHASE_START}^"
  else
    DIFF_BASE="${PHASE_START}"
  fi
fi

if [ ${#REVIEW_FILES[@]} -eq 0 ]; then
  # Full git-diff fallback (per D-02): SUMMARY scoping yielded nothing.
  if [ -n "$DIFF_BASE" ]; then
    # Run git diff with specific exclusions (per D-03)
    DIFF_FILES=$(git diff --name-only "${DIFF_BASE}..HEAD" -- . \
      ':!.planning/' ':!ROADMAP.md' ':!STATE.md' \
      ':!*-SUMMARY.md' ':!*-VERIFICATION.md' ':!*-PLAN.md' \
      ':!package-lock.json' ':!yarn.lock' ':!Gemfile.lock' ':!poetry.lock' 2>/dev/null)

    while IFS= read -r file; do
      [ -n "$file" ] && REVIEW_FILES+=("$file")
    done <<< "$DIFF_FILES"

    echo "File scope: ${#REVIEW_FILES[@]} files from git diff (base: ${DIFF_BASE})"
  else
    # Fail closed — no reliable diff base found. Do not use arbitrary HEAD~N.
    echo "Warning: No phase commits found for '${PADDED_PHASE}'. Cannot determine reliable diff scope."
    echo "Use --files flag to specify files explicitly: /gsd:code-review ${PHASE_ARG} --files=file1,file2,..."
  fi
elif [ -n "$DIFF_BASE" ]; then
  # #2666 cross-check: SUMMARY yielded a non-empty (possibly partial) scope.
  # Warn about — and add — any changed files the SUMMARY extractor did not surface,
  # so a partial result can no longer silently ship an incomplete review scope.
  DIFF_FILES=$(git diff --name-only "${DIFF_BASE}..HEAD" -- . \
    ':!.planning/' ':!ROADMAP.md' ':!STATE.md' \
    ':!*-SUMMARY.md' ':!*-VERIFICATION.md' ':!*-PLAN.md' \
    ':!package-lock.json' ':!yarn.lock' ':!Gemfile.lock' ':!poetry.lock' 2>/dev/null)

  # Build a newline-delimited list of already-scoped files for exact membership
  # testing (portable — bash 3.2 on macOS has no associative arrays). grep -Fxq
  # matches the WHOLE line exactly, so a short basename (e.g. root `Dockerfile`)
  # does NOT substring-match a longer scoped path (e.g. `docker/Dockerfile`).
  IN_SCOPE=$(printf '%s\n' "${REVIEW_FILES[@]}")

  MISSING_FROM_SUMMARY=()
  while IFS= read -r file; do
    [ -z "$file" ] && continue
    # Exact whole-line match; grep nonzero-exit => not in scope.
    if printf '%s\n' "${REVIEW_FILES[@]}" | grep -Fxq -- "$file" 2>/dev/null; then
      : # already scoped
    else
      MISSING_FROM_SUMMARY+=("$file"); REVIEW_FILES+=("$file")
    fi
  done <<< "$DIFF_FILES"

  if [ ${#MISSING_FROM_SUMMARY[@]} -gt 0 ]; then
    echo "Warning: SUMMARY scope was missing ${#MISSING_FROM_SUMMARY[@]} changed file(s) the git diff surfaced; adding them to the review scope:"
    printf '  - %s\n' "${MISSING_FROM_SUMMARY[@]}"
  fi
fi
```

**Post-processing (all tiers):**

1. **Expand tilde paths:** SUMMARY.md `key-files` entries may record a `~/...`-prefixed path (e.g. `~/.claude/gsd-core/workflows/verify-work.md`). Bash only tilde-expands a literal `~` written in source text, never one arriving as the value of an already-expanded variable, so every later `[ -f "$file" ]` check must see a real, expanded path or it misclassifies the file as deleted.
```bash
EXPANDED_FILES=()
for file in "${REVIEW_FILES[@]}"; do
  case "$file" in
    "~/"*) file="${HOME}${file#\~}" ;;
  esac
  EXPANDED_FILES+=("$file")
done
REVIEW_FILES=("${EXPANDED_FILES[@]}")
```

2. **Apply exclusions (per D-03):** Remove paths matching planning artifacts
```bash
FILTERED_FILES=()
for file in "${REVIEW_FILES[@]}"; do
  # Skip planning directory and specific artifacts
  if [[ "$file" == .planning/* ]] || \
     [[ "$file" == ROADMAP.md ]] || \
     [[ "$file" == STATE.md ]] || \
     [[ "$file" == *-SUMMARY.md ]] || \
     [[ "$file" == *-VERIFICATION.md ]] || \
     [[ "$file" == *-PLAN.md ]]; then
    continue
  fi
  FILTERED_FILES+=("$file")
done
REVIEW_FILES=("${FILTERED_FILES[@]}")
```

3. **Filter deleted files:** Remove paths that don't exist on disk
```bash
EXISTING_FILES=()
DELETED_COUNT=0
for file in "${REVIEW_FILES[@]}"; do
  if [ -f "$file" ]; then
    EXISTING_FILES+=("$file")
  else
    DELETED_COUNT=$((DELETED_COUNT + 1))
  fi
done
REVIEW_FILES=("${EXISTING_FILES[@]}")

if [ $DELETED_COUNT -gt 0 ]; then
  echo "Filtered $DELETED_COUNT deleted files from review scope"
fi
```

4. **Deduplicate:** Remove duplicate paths (portable — bash 3.2+ compatible, handles spaces in paths)
```bash
DEDUPED=()
while IFS= read -r line; do
  [ -n "$line" ] && DEDUPED+=("$line")
done < <(printf '%s\n' "${REVIEW_FILES[@]}" | sort -u)
REVIEW_FILES=("${DEDUPED[@]}")
```

5. **Sort:** Alphabetical sort for reproducible agent input (already sorted by sort -u above)

**Log final scope and warn if large:**
```bash
if [ -n "$FILES_OVERRIDE" ]; then
  TIER="--files override"
elif [ -n "$SUMMARIES" ] && [ ${#REVIEW_FILES[@]} -gt 0 ]; then
  TIER="SUMMARY.md"
else
  TIER="git diff"
fi
echo "File scope: ${#REVIEW_FILES[@]} files from ${TIER}"

# Warn if file count is very large — may exceed agent context or produce superficial review
if [ ${#REVIEW_FILES[@]} -gt 50 ]; then
  echo "Warning: ${#REVIEW_FILES[@]} files is a large review scope."
  echo "Consider using --files to narrow scope, or --depth=quick for a faster pass."
fi
```
</step>

<step name="resolve_depth">
Determine review depth via the path-scoped depth resolver (`code-review-depth.cjs`). This step runs after `compute_file_scope` because rule matching needs the final `REVIEW_FILES` set.

```bash
CONFIG_DEPTH=$(gsd_run query config-get workflow.code_review_depth --raw 2>/dev/null || echo "")
DEPTH_OVERRIDES=$(gsd_run query config-get workflow.code_review_depth_overrides --default '[]' 2>/dev/null || echo '[]')
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)

# Files travel on stdin, never argv — a 50+-file scope with long paths approaches the
# Windows execFileSync 32,767-char argv ceiling; stdin has no such bound.
DEPTH_PAYLOAD=$(printf '%s\n' "${REVIEW_FILES[@]}" | FLAG_DEPTH="$DEPTH_OVERRIDE" CONFIG_DEPTH="$CONFIG_DEPTH" DEPTH_OVERRIDES="$DEPTH_OVERRIDES" REPO_ROOT="$REPO_ROOT" node -e "
  const files = require('fs').readFileSync('/dev/stdin', 'utf-8').split('\n').filter(Boolean);
  process.stdout.write(JSON.stringify({
    flagDepth: process.env.FLAG_DEPTH || '',
    configDepth: process.env.CONFIG_DEPTH || '',
    overrides: JSON.parse(process.env.DEPTH_OVERRIDES || '[]'),
    files,
    repoRoot: process.env.REPO_ROOT || '',
  }));
")

DEPTH_JSON=$(echo "$DEPTH_PAYLOAD" | node -e "
  const { resolveCodeReviewDepth } = require('./gsd-core/bin/lib/code-review-depth.cjs');
  const input = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf-8'));
  process.stdout.write(JSON.stringify(resolveCodeReviewDepth(input)));
")

DEPTH_OK=$(echo "$DEPTH_JSON" | node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('/dev/stdin','utf-8')).ok))")
```

The guard and the extraction it protects must run as one shell control-flow decision — a prose sentence between two fenced blocks is not a guard, since fenced blocks do not share shell state. Anything other than the literal string `true` (including an empty `DEPTH_OK`, which is what a crashed or missing resolver produces) is treated as failure, and the failure branch exits before any extraction can run:

```bash
if [ "$DEPTH_OK" = "true" ]; then
  # Single spawn: emit all seven fields as Unit-Separator-delimited (U+001F) values,
  # fixed order. Field '\x1f' (not '\n') is deliberate: bash's `read` treats '\n' as
  # "IFS whitespace" and collapses runs of it, silently dropping an empty field (e.g.
  # DEPTH_MATCHED_RULE_PATH when matchedRule is null) — '\x1f' is not IFS-whitespace,
  # so each empty field survives as its own zero-length token. This is safe only
  # because validateRulePath (src/code-review-depth.cts) rejects any rule path
  # carrying an interior control character, including U+001F itself — so
  # DEPTH_MATCHED_RULE_PATH below can never collide with the delimiter. Do not
  # remove that validation without revisiting this split.
  DEPTH_FIELDS=$(echo "$DEPTH_JSON" | node -e "
    const d = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf-8'));
    const r = d.matchedRule;
    process.stdout.write([
      d.depth,
      d.source,
      r ? String(r.index) : '',
      r ? r.path : '',
      String(!!d.invalidFlagDepth),
      String(!!d.invalidConfigDepth),
      String(!!d.downgraded),
    ].join('\x1f'));
  ")
  IFS=$'\x1f' read -r -d '' REVIEW_DEPTH DEPTH_SOURCE DEPTH_MATCHED_RULE_INDEX DEPTH_MATCHED_RULE_PATH \
    DEPTH_INVALID_FLAG DEPTH_INVALID_CONFIG DEPTH_DOWNGRADED <<< "$DEPTH_FIELDS" || true
  # <<< always appends a trailing newline to its input; strip it from the last field.
  DEPTH_DOWNGRADED="${DEPTH_DOWNGRADED%$'\n'}"

  case "$DEPTH_SOURCE" in
    flag) DEPTH_PROVENANCE="from --depth flag" ;;
    rule) DEPTH_PROVENANCE="matched rule ${DEPTH_MATCHED_RULE_INDEX}: ${DEPTH_MATCHED_RULE_PATH}" ;;
    config) DEPTH_PROVENANCE="from workflow.code_review_depth" ;;
    *) DEPTH_PROVENANCE="default" ;;
  esac
  echo "Review depth: ${REVIEW_DEPTH} (${DEPTH_PROVENANCE})"

  if [ "$DEPTH_INVALID_FLAG" = "true" ]; then
    echo "Warning: Invalid depth '${DEPTH_OVERRIDE}'. Valid values: quick, standard, deep. Using 'standard'."
  fi
  if [ "$DEPTH_INVALID_CONFIG" = "true" ]; then
    echo "Warning: Invalid depth '${CONFIG_DEPTH}'. Valid values: quick, standard, deep. Using 'standard'."
  fi

  if [ "$DEPTH_DOWNGRADED" = "true" ]; then
    if [ -n "$DEPTH_MATCHED_RULE_INDEX" ]; then
      echo "Switching from deep to standard depth for large file count (overrides matched rule ${DEPTH_MATCHED_RULE_INDEX}: ${DEPTH_MATCHED_RULE_PATH})."
    else
      echo "Switching from deep to standard depth for large file count."
    fi
  fi
else
  # DEPTH_OK is anything but the literal string "true" — including empty, which is
  # what a crashed or missing resolver produces. workflow.code_review_depth_overrides
  # is misconfigured. Print every collected error — never fall back to a default
  # depth, since silently reviewing a misconfigured sensitive-path policy at
  # `standard` is the exact hole this feature closes — then hard-stop before
  # REVIEW_DEPTH can be read by any later step.
  echo "$DEPTH_JSON" | node -e "
    let parsed;
    try {
      parsed = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf-8'));
    } catch {
      parsed = {};
    }
    const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
    for (const err of errors) {
      const parts = [];
      if (err.ruleIndex !== undefined) parts.push('rule ' + err.ruleIndex);
      if (err.path !== undefined) parts.push('path \"' + err.path + '\"');
      if (err.value !== undefined) parts.push('depth \"' + err.value + '\"');
      console.error('Error: workflow.code_review_depth_overrides' + (parts.length ? ' (' + parts.join(', ') + ')' : '') + ': ' + err.reason);
    }
  "
  echo "Error: Fix workflow.code_review_depth_overrides and retry."
  echo "Error: Depth resolution failed (DEPTH_OK=\"${DEPTH_OK}\"). Halting before agent spawn."
  exit 1
fi
```
This `if`/`else`/`fi` is the entire guard: when `DEPTH_OK` is not the literal string `true`, execution never reaches the `DEPTH_FIELDS`/`REVIEW_DEPTH` extraction — the `else` branch prints the errors, prints the final `Error:` line above, and `exit 1`s out of the fenced block, so `REVIEW_DEPTH` is never set. Exit workflow. Do NOT spawn agent or create REVIEW.md.
</step>

<step name="check_empty_scope">
If REVIEW_FILES is empty:
```
No source files changed in phase ${PHASE_ARG}. Skipping review.
```
Exit workflow. Do NOT spawn agent or create REVIEW.md.
</step>

<step name="structural_pre_pass">
Optional structural cross-module pass powered by fallow.

Parse `fallow_enabled`, `fallow_scope`, `fallow_profile`, `fallow_mcp`, `fallow_max_crap` from the init JSON as `FALLOW_ENABLED`, `FALLOW_SCOPE`, `FALLOW_PROFILE`, `FALLOW_MCP`, `FALLOW_MAX_CRAP`. These are resolved once by `init.code-review` at init time — consuming the pre-resolved values here (instead of a `config-get` call inside this step) avoids gating this section's own inclusion on a fact its own body would otherwise compute (see `state:fallow-enabled` in docs/reference/workflow-fragments.md).

Defaults are fail-closed and opt-in:
- `enabled=false` (skip entirely)
- `scope=phase`
- `profile=standard` (maps to `--max-crap 30`; minimal=50, standard=30, strict=15 — fallow has no native profile concept)
- `mcp=false`

<!-- gsd:section id="structural-pre-pass" when="state:fallow-enabled" -->
If `section_manifest` is `null` or `"structural-pre-pass"` is in its `included` list: read and execute `gsd-core/workflows/code-review/steps/structural-pre-pass.md`. Otherwise skip — do not read the file.
<!-- /gsd:section -->

When disabled, set:
```bash
FALLOW_JSON_PATH=""
```
</step>

<step name="spawn_reviewer">
Compute the review output path:
```bash
REVIEW_PATH="${PHASE_DIR}/${PADDED_PHASE}-REVIEW.md"
```

Compute DIFF_BASE for agent context (in case agent needs it). #3191/#3995: this
must be the SAME phase-directory-anchor derivation the Tier-3 scope step uses —
the reviewer agent consumes `diff_base` exactly
when `files:` is empty, i.e. the same fail-closed scenario Tier 3 protects, so
a divergent recomputation here re-arms the mis-scoping one tier down:
```bash
# #3995: a phase number is unique within a MILESTONE, not a repository. The
# former message grep had no milestone bound, and its tail -1 deliberately
# selected the OLDEST matching subject — dragging in previous milestones'
# same-numbered phases and taking a 7-file phase to a 3388-file scope (plus
# the >50 depth downgrade). The phase's own directory is the unique identity:
# base = the parent of the first commit that added anything under PHASE_DIR
# (the same anchor class git-base-branch's phaseStartCommit uses for
# complexity triggering). Message subjects demonstrably do not carry enough
# information to identify a phase — this was the grep's fifth failure.
PHASE_START=$(git log --format="%H" --diff-filter=A -- "${PHASE_DIR}" 2>/dev/null | tail -1)
if [ -n "$PHASE_START" ]; then
  if git rev-parse "${PHASE_START}^" >/dev/null 2>&1; then
    DIFF_BASE="${PHASE_START}^"
  else
    DIFF_BASE="${PHASE_START}"
  fi
else
  DIFF_BASE=""
fi
```

Build required_reading block for agent:
```bash
FILES_TO_READ=""
for file in "${REVIEW_FILES[@]}"; do
  FILES_TO_READ+="- ${file}\n"
done
```

Build config block for agent:
```bash
CONFIG_FILES=""
for file in "${REVIEW_FILES[@]}"; do
  CONFIG_FILES+="  - ${file}\n"
done
```

Build structural findings block for agent:
```bash
STRUCTURAL_FINDINGS_BLOCK=""
MAX_FINDINGS_SIZE=50000
if [ -n "$FALLOW_JSON_PATH" ] && [ -f "$FALLOW_JSON_PATH" ]; then
  # Normalize fallow's raw report into the compact {summary, findings[]} contract
  # the reviewer consumes (real fallow schema -> normalized findings).
  FALLOW_NORMALIZED_PATH="${PHASE_DIR}/FALLOW-normalized.json"
  FALLOW_SRC="$FALLOW_JSON_PATH" FALLOW_OUT="$FALLOW_NORMALIZED_PATH" node -e "
    const fs = require('fs');
    const { normalizeFallowReportFile } = require('./gsd-core/bin/lib/fallow-runner.cjs');
    const n = normalizeFallowReportFile(process.env.FALLOW_SRC);
    fs.writeFileSync(process.env.FALLOW_OUT, JSON.stringify(n, null, 2));
  " 2>/dev/null && FALLOW_EMBED_PATH="$FALLOW_NORMALIZED_PATH" || FALLOW_EMBED_PATH="$FALLOW_JSON_PATH"
  FALLOW_JSON_SIZE=$(wc -c < "$FALLOW_EMBED_PATH" | tr -d '[:space:]')
  if [ "$FALLOW_JSON_SIZE" -le "$MAX_FINDINGS_SIZE" ]; then
    # Escape any literal closing tag before embedding; the closing tag literal is escaped to prevent prompt-structure breakage if a fallow finding's file path or message contains the sequence.
    SAFE_FALLOW_JSON=$(sed 's#</structural_findings>#<\/structural_findings>#g' "$FALLOW_EMBED_PATH")
    STRUCTURAL_FINDINGS_BLOCK=$(printf '<structural_findings>\n%s\n</structural_findings>\n' "$SAFE_FALLOW_JSON")
  else
    echo "Warning: skipping structural findings embed (${FALLOW_JSON_SIZE} bytes > ${MAX_FINDINGS_SIZE} bytes). Re-run with narrower scope/profile if needed."
  fi
fi
```

Spawn the gsd-code-reviewer agent:

Print: `◆ Spawning code reviewer... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)`

<!-- #2508 runtime-aware-dispatch -->

> **Runtime-aware dispatch (#2508 Phase 4).** GSD workflows dispatch specialized subagents by role. Before dispatching on a built-in-only runtime (kimi-code — three built-ins only), resolve the role to a built-in via `gsd_run query resolve-dispatch-type --requested <role> --raw`. On named-dispatch runtimes (Claude/OpenCode/…) the role is returned unchanged; on kimi-code it maps to `coder`/`explore`/`plan` by role-suffix. The persona rides `${AGENT_SKILLS_<ROLE>}` (Phase 3) regardless. See @gsd-core/references/runtime-aware-dispatch.md.

<!-- #2517 model-omit-on-inherit -->

> **Model omission (#2517).** Omit the `model` parameter entirely when the value it would carry (`REVIEWER_MODEL`) is `"inherit"` or empty. An empty value 404s on runtimes without native tier aliases — the default on non-Claude runtimes. Omitting it inherits the orchestrator's model. See @gsd-core/references/model-profile-resolution.md.

```
Agent(subagent_type="gsd-code-reviewer", model="{REVIEWER_MODEL}", prompt="
<required_reading>
${FILES_TO_READ}
</required_reading>

${STRUCTURAL_FINDINGS_BLOCK}

<config>
depth: ${REVIEW_DEPTH}
phase_dir: ${PHASE_DIR}
review_path: ${REVIEW_PATH}
${DIFF_BASE:+diff_base: ${DIFF_BASE}}
files:
${CONFIG_FILES}
</config>

Review the listed source files at ${REVIEW_DEPTH} depth. Write findings to ${REVIEW_PATH}.
Do NOT commit the output — the orchestrator handles that.
${AGENT_SKILLS_REVIEWER}")
```

> **ORCHESTRATOR RULE — CODEX RUNTIME**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests related to this task while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

**Agent failure handling:**

If the Agent() call fails (agent error, timeout, or exception):
```
Error: Code review agent failed: ${error_message}

No REVIEW.md created. You can retry with /gsd:code-review ${PHASE_ARG} or check agent logs.
```

Do NOT proceed to commit_review step. Do NOT create a partial or empty REVIEW.md. Exit workflow.
</step>

<step name="commit_review">
After agent completes successfully, verify REVIEW.md was created and has valid structure:

```bash
if [ -f "${REVIEW_PATH}" ]; then
  # Validate REVIEW.md has valid YAML frontmatter with status field
  HAS_STATUS=$(REVIEW_PATH="${REVIEW_PATH}" node -e "
    const fs = require('fs');
    const content = fs.readFileSync(process.env.REVIEW_PATH, 'utf-8');
    const match = content.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
    if (match && /status:/.test(match[1])) { console.log('valid'); } else { console.log('invalid'); }
  " 2>/dev/null)
  
  if [ "$HAS_STATUS" = "valid" ]; then
    echo "REVIEW.md created at ${REVIEW_PATH}"
    
    if [ "$COMMIT_DOCS" = "true" ]; then
      gsd_run query commit \
        "docs(${PADDED_PHASE}): add code review report" \
        --files "${REVIEW_PATH}"
    fi
  else
    echo "Warning: REVIEW.md exists but has invalid or missing frontmatter (no status field)."
    echo "Agent may have produced malformed output. Not committing. Review manually: ${REVIEW_PATH}"
  fi
else
  echo "Warning: Agent completed but REVIEW.md not found at ${REVIEW_PATH}. This may indicate an agent issue."
  echo "No REVIEW.md to commit. Please retry with /gsd:code-review ${PHASE_ARG}"
fi
```
</step>

<!-- gsd:section id="dispatch-fix" when="flag:--fix" -->
If `section_manifest` is `null` or `"dispatch-fix"` is in its `included` list: read and execute `gsd-core/workflows/code-review/steps/dispatch-fix.md`. Otherwise skip — do not read the file; proceed to `present_results`.
<!-- /gsd:section -->

<step name="present_results">
Read the REVIEW.md YAML frontmatter to extract finding counts.

Extract frontmatter between `---` delimiters first to avoid matching values in the review body:

```bash
# Extract only the YAML frontmatter block (between first two --- lines)
FRONTMATTER=$(REVIEW_PATH="${REVIEW_PATH}" node -e "
  const fs = require('fs');
  const content = fs.readFileSync(process.env.REVIEW_PATH, 'utf-8');
  const match = content.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
  if (match) process.stdout.write(match[1]);
" 2>/dev/null)

# Parse fields from frontmatter only (not full file)
STATUS=$(echo "$FRONTMATTER" | grep "^status:" | cut -d: -f2 | xargs)
FILES_REVIEWED=$(echo "$FRONTMATTER" | grep "^files_reviewed:" | cut -d: -f2 | xargs)
CRITICAL=$(echo "$FRONTMATTER" | grep -E "^[[:space:]]*(critical|blocker):" | head -1 | cut -d: -f2 | xargs)
WARNING=$(echo "$FRONTMATTER" | grep "warning:" | head -1 | cut -d: -f2 | xargs)
INFO=$(echo "$FRONTMATTER" | grep "info:" | head -1 | cut -d: -f2 | xargs)
TOTAL=$(echo "$FRONTMATTER" | grep "total:" | head -1 | cut -d: -f2 | xargs)
```

Display inline summary to user:

```
---

  Code Review Complete: Phase ${PHASE_NUMBER} (${PHASE_NAME})

---

  Depth:           ${REVIEW_DEPTH} (${DEPTH_PROVENANCE})
  Files Reviewed:  ${FILES_REVIEWED}
  
  Findings:
    Critical:  ${CRITICAL}
    Warning:   ${WARNING}
    Info:      ${INFO}

---
    Total:     ${TOTAL}

---
```

If status is "clean":
```
✓ No issues found. All ${FILES_REVIEWED} files pass review at ${REVIEW_DEPTH} depth.

Full report: ${REVIEW_PATH}
```

If total findings > 0:
```
⚠ Issues found. Review the report for details.

Full report: ${REVIEW_PATH}

Next steps:
  /gsd:code-review ${PHASE_NUMBER} --fix  — Auto-fix issues
  cat ${REVIEW_PATH}                     — View full report
```

If critical > 0 or warning > 0, list top 3 issues inline:
```bash
echo "Top issues:"
grep -A 3 "^### CR-\|^### BL-\|^### WR-" "${REVIEW_PATH}" | head -n 12
```

**Note on tests:** Automated tests for this command and workflow are planned for Phase 4 (Pipeline Integration & Testing, requirement INFR-03). Phase 2 focuses on correct implementation; Phase 4 adds regression coverage across platforms.

---
</step>

</process>

<platform_notes>
**Windows:** This workflow uses bash features (arrays, process substitution). On Windows, it requires
Git Bash or WSL. Native PowerShell is not supported. The CI matrix (Ubuntu/macOS/Windows)
runs under Git Bash on Windows runners, which provides bash compatibility.

**macOS:** macOS ships with bash 3.2 (GPL licensing). This workflow does NOT use `mapfile` (bash 4+
only) — all array construction uses portable `while IFS= read -r` loops compatible with bash 3.2.
The `--files` path validation uses `realpath -m` which requires GNU coreutils (install via
`brew install coreutils`). Without coreutils, the path guard falls back to fail-closed behavior
(rejects paths it cannot verify), so security is maintained but valid relative paths may be rejected.
If `--files` validation fails unexpectedly on macOS, install coreutils or use absolute paths.
</platform_notes>

<success_criteria>
- [ ] Phase validated before config gate check
- [ ] Capability gate checked (`workflow.code_review` config key)
- [ ] --fix/--all/--auto flags parsed via code-review-flags.cjs typed IR (not ad-hoc bash)
- [ ] Depth resolved with validation (quick|standard|deep)
- [ ] File scope computed with 3 tiers: --files > SUMMARY.md > git diff
- [ ] Malformed/missing SUMMARY.md handled gracefully with fallback
- [ ] Deleted files filtered from scope
- [ ] Files deduplicated and sorted
- [ ] Empty scope results in skip (no agent spawn)
- [ ] Agent spawned with explicit file list, depth, review_path, diff_base
- [ ] Agent failure handled without partial commits
- [ ] REVIEW.md committed if created
- [ ] When --fix: dispatch_fix step delegates to code-review-fix.md with --all/--auto forwarded
- [ ] Results presented inline with next step suggestion (review-only path)
</success_criteria>
