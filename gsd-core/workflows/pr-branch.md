<purpose>
Create a clean branch for pull requests by filtering out transient .planning/ commits.
The PR branch contains only code changes and structural planning state — reviewers
don't see GSD transient artifacts (PLAN.md, SUMMARY.md, CONTEXT.md, RESEARCH.md, etc.)
but milestone archives, STATE.md, ROADMAP.md, and PROJECT.md changes are preserved.

Uses git cherry-pick with path filtering to rebuild a clean history.
</purpose>

<process>

<step name="detect_state">
Parse `$ARGUMENTS` for target branch. If no argument is supplied, detect the
default branch via the single resolver (#1146).

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=0; if [ -f "$GSD_TOOLS" ]; then _GSD_FOUND=1; elif [ -f "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif command -v gsd-tools >/dev/null 2>&1; then GSD_TOOLS="$(command -v gsd-tools)"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif [ -f "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GEMINI_CONFIG_DIR:-$HOME/.gemini}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; elif [ -f "${QODER_CONFIG_DIR:-$HOME/.qoder}/gsd-core/bin/${_GSD_SHIM_NAME}" ]; then GSD_TOOLS="${QODER_CONFIG_DIR:-$HOME/.qoder}/gsd-core/bin/${_GSD_SHIM_NAME}"; _GSD_FOUND=1; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd-tools is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; [ "$_GSD_FOUND" = "1" ] && gsd_run() { node "$GSD_TOOLS" "$@"; }; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
CURRENT_BRANCH=$(git branch --show-current)
TARGET=${1:-$(gsd_run query git.base-branch)}
```

Check preconditions:
- Must be on a feature branch (not main/master)
- Must have commits ahead of target

```bash
AHEAD=$(git rev-list --count "$TARGET".."$CURRENT_BRANCH" 2>/dev/null)
if [ "$AHEAD" = "0" ]; then
  echo "No commits ahead of $TARGET — nothing to filter."
  exit 0
fi
```

Display:
```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 GSD ► PR BRANCH
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Branch: {CURRENT_BRANCH}
Target: {TARGET}
Commits: {AHEAD} ahead
```
</step>

<step name="handle_sub_repos">
Read the sub-repo list from config using the canonical key path — `planning.sub_repos`.
A non-zero exit code means the key is absent; treat that as "no sub-repos configured".

```bash
SUB_REPOS_JSON=$(gsd_run query config-get planning.sub_repos 2>/dev/null)
if [ $? -ne 0 ] || [ -z "$SUB_REPOS_JSON" ] || [ "$SUB_REPOS_JSON" = "null" ] || [ "$SUB_REPOS_JSON" = "[]" ]; then
  : # Not configured or empty — skip to analyze_commits
fi
```

Scan each sub-repo for uncommitted changes using node (always available — avoids undeclared
jq dependency). Write dirty repo names to a temp file so the list survives across
subsequent command executions:

```bash
ROOT=$(git rev-parse --show-toplevel)
DIRTY_FILE=$(mktemp)

node -e "
  const repos = JSON.parse(process.argv[1]);
  const { execFileSync } = require('child_process');
  const path = require('path');
  const fs = require('fs');
  const root = process.argv[2];
  // realpath parity with the pr-subrepo seam's validatePath: resolve $ROOT through
  // symlinks once so the containment check below compares real paths, not text.
  let realRoot;
  try { realRoot = fs.realpathSync(root); } catch (_) { realRoot = path.resolve(root); }
  const out = [];
  for (const r of repos) {
    // Reject before any git invocation: this scan runs on raw config values,
    // ahead of the pr-subrepo seam's own validatePath guard. A traversal,
    // embedded-newline, or symlink entry here would run git outside the
    // workspace, or inject a spurious record into the dirty-file output.
    if (typeof r !== 'string' || !/^[A-Za-z0-9._\/-]+$/.test(r)) continue;
    // realpathSync follows symlinks — path.resolve only normalizes '..' textually,
    // so an in-tree symlink pointing outside root would otherwise smuggle git out.
    let resolved;
    try { resolved = fs.realpathSync(path.resolve(realRoot, r)); } catch (_) { continue; }
    if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) continue;
    try {
      const res = execFileSync('git', ['-C', resolved, 'status', '--porcelain'],
                               { encoding: 'utf8', timeout: 10_000 });
      // Exclude untracked-only repos: seam filters ?? lines, so detection must match.
      const tracked = res.split('\n').filter(l => l.length > 0 && !l.startsWith('??'));
      if (tracked.length > 0) out.push(r);
    } catch (_) {}
  }
  fs.writeFileSync(process.argv[3], out.join('\n'));
" "$SUB_REPOS_JSON" "$ROOT" "$DIRTY_FILE"

DIRTY_REPOS=$(cat "$DIRTY_FILE")
```

If `$DIRTY_REPOS` is empty, remove the temp file and continue to `analyze_commits`.

Display dirty repos and prompt the user:

```
Sub-repos with uncommitted changes:
  backend
  frontend

How should sub-repo changes be handled?
  1. all    — branch, commit (explicit files only), push -u, open companion PR per repo
  2. select — choose which sub-repos to process
  3. skip   — ignore sub-repos, continue with root repo only
```

If the user chooses **skip**, remove the temp file and continue to `analyze_commits`.

For each selected sub-repo `$REPO_REL`, delegate all git work to the `pr-subrepo` query
seam — it stages explicit changed files (never `git add -A`), creates the branch,
commits, and pushes with `--set-upstream`. Branch names include the repo slug to avoid
colliding with the root `PR_BRANCH` that `create_pr_branch` creates later:

```bash
# Replace path separators to make the name safe as a branch component
REPO_SAFE="${REPO_REL//\//-}"
SUB_BRANCH="${CURRENT_BRANCH}-${REPO_SAFE}-pr"
COMMIT_MSG="fix(${REPO_REL}): sync uncommitted changes for PR"

RESULT=$(gsd_run query pr-subrepo "$COMMIT_MSG" \
  --repo "$REPO_REL" \
  --branch "$SUB_BRANCH")
SUBREPO_EXIT=$?
```

If the seam exited non-zero (stage/commit/push failure), report its error and move on to
the next selected sub-repo. **Do not run the companion-PR step below for this repo** —
the seam's stderr already explains the failure, and the "branch pushed" path would
otherwise contradict it:

```bash
if [ "$SUBREPO_EXIT" -ne 0 ]; then
  echo "pr-subrepo failed for $REPO_REL — see error above; skipping companion PR." >&2
fi
```

Only when `$SUBREPO_EXIT` is `0`, parse the structured result with node and open the
companion PR. If `remote_slug` is null (non-GitHub remote), skip `gh pr create` and show
the push URL instead:

```bash
REMOTE_SLUG=$(node -e "
  try { console.log(JSON.parse(process.argv[1]).remote_slug || ''); } catch(_) {}
" "$RESULT")

if [ -n "$REMOTE_SLUG" ]; then
  # Defense-in-depth: $REPO_REL was already validated by the dirty-scan filter and
  # the pr-subrepo seam's validatePath, but these are separate, independent git -C
  # invocations on the same value. Resolve it through symlinks with the SAME realpath
  # containment the seam uses (path.resolve alone would not catch a symlink escape),
  # and run git against the validated absolute path rather than re-concatenating.
  SUB_REPO_DIR=$(node -e "
    const fs = require('fs'), path = require('path');
    try {
      const realRoot = fs.realpathSync(process.argv[1]);
      const resolved = fs.realpathSync(path.resolve(realRoot, process.argv[2]));
      if (resolved !== realRoot && !resolved.startsWith(realRoot + path.sep)) process.exit(1);
      process.stdout.write(resolved);
    } catch (_) { process.exit(1); }
  " "$ROOT" "$REPO_REL" 2>/dev/null)

  if [ -z "$SUB_REPO_DIR" ]; then
    echo "Refusing unsafe sub-repo path: $REPO_REL" >&2
    SUB_TARGET="$TARGET"
  else
    # Resolve base branch: use $TARGET if it exists in sub-repo, else fall back to
    # the sub-repo's own default branch
    if git -C "$SUB_REPO_DIR" ls-remote --exit-code --heads origin "$TARGET" \
         > /dev/null 2>&1; then
      SUB_TARGET="$TARGET"
    else
      SUB_TARGET=$(git -C "$SUB_REPO_DIR" remote show origin 2>/dev/null \
        | awk '/HEAD branch/ {print $NF}')
      SUB_TARGET="${SUB_TARGET:-main}"
    fi
  fi

  gh pr create \
    --repo "$REMOTE_SLUG" \
    --base "$SUB_TARGET" \
    --head "$SUB_BRANCH" \
    --title "$COMMIT_MSG" \
    --body "Companion PR for root repo branch \`$CURRENT_BRANCH\`."
else
  echo "No GitHub remote detected for $REPO_REL — branch pushed, open PR manually."
fi
```

After processing all selected sub-repos, remove the temp file and continue to
`analyze_commits` for the root repo.
</step>

<step name="analyze_commits">
Classify commits:

```bash
# Get all commits ahead of target
git log --oneline "$TARGET".."$CURRENT_BRANCH" --no-merges
```

**Structural planning files** — always preserved (repository planning state):
- `.planning/STATE.md`
- `.planning/ROADMAP.md`
- `.planning/MILESTONES.md`
- `.planning/PROJECT.md`
- `.planning/REQUIREMENTS.md`
- `.planning/milestones/**`

**Transient planning files** — excluded from PR branch (reviewer noise):
- `.planning/phases/**` (PLAN.md, SUMMARY.md, CONTEXT.md, RESEARCH.md, etc.)
- `.planning/quick/**`
- `.planning/research/**`
- `.planning/threads/**`
- `.planning/todos/**`
- `.planning/debug/**`
- `.planning/seeds/**`
- `.planning/codebase/**`
- `.planning/ui-reviews/**`

For each commit, check what it touches:

```bash
# For each commit hash
FILES=$(git diff-tree --no-commit-id --name-only -r $HASH)
NON_PLANNING=$(echo "$FILES" | grep -v "^\.planning/" | wc -l)
STRUCTURAL=$(echo "$FILES" | grep -E "^\.planning/(STATE|ROADMAP|MILESTONES|PROJECT|REQUIREMENTS)\.md|^\.planning/milestones/" | wc -l)
TRANSIENT_ONLY=$(echo "$FILES" | grep "^\.planning/" | grep -vE "^\.planning/(STATE|ROADMAP|MILESTONES|PROJECT|REQUIREMENTS)\.md|^\.planning/milestones/" | wc -l)
```

Classify:
- **Code commits**: Touch at least one non-.planning/ file → INCLUDE
- **Structural planning commits**: Touch only structural .planning/ files (STATE.md, ROADMAP.md, MILESTONES.md, PROJECT.md, REQUIREMENTS.md, milestones/**) → INCLUDE
- **Transient planning commits**: Touch only transient .planning/ files (phases/, quick/, research/, etc.) → EXCLUDE
- **Mixed commits**: Touch code + any planning files → INCLUDE (transient planning changes come along; acceptable in mixed context)

Display analysis:
```
Commits to include: {N} (code changes + structural planning)
Commits to exclude: {N} (transient planning-only)
Mixed commits: {N} (code + planning — included)
Structural planning commits: {N} (STATE/ROADMAP/milestone updates — included)
```
</step>

<step name="create_pr_branch">
```bash
PR_BRANCH="${CURRENT_BRANCH}-pr"

# Create PR branch from target
git checkout -b "$PR_BRANCH" "$TARGET"
```

Cherry-pick code commits and structural planning commits (in order):

```bash
for HASH in $CODE_AND_STRUCTURAL_COMMITS; do
  git cherry-pick "$HASH" --no-commit
  # Remove only transient .planning/ subdirectories that came along in mixed commits.
  # DO NOT remove structural files (STATE.md, ROADMAP.md, MILESTONES.md, PROJECT.md,
  # REQUIREMENTS.md, milestones/) — these must survive into the PR branch.
  for dir in phases quick research threads todos debug seeds codebase ui-reviews; do
    git rm -r --cached ".planning/$dir/" 2>/dev/null || true
  done
  git commit -C "$HASH"
done
```

Return to original branch:
```bash
git checkout "$CURRENT_BRANCH"
```
</step>

<step name="verify">
```bash
# Verify no .planning/ files in PR branch
PLANNING_FILES=$(git diff --name-only "$TARGET".."$PR_BRANCH" | grep "^\.planning/" | wc -l)
TOTAL_FILES=$(git diff --name-only "$TARGET".."$PR_BRANCH" | wc -l)
PR_COMMITS=$(git rev-list --count "$TARGET".."$PR_BRANCH")
```

Display results:
```
✅ PR branch created: {PR_BRANCH}

Original: {AHEAD} commits, {ORIGINAL_FILES} files
PR branch: {PR_COMMITS} commits, {TOTAL_FILES} files
Planning files: {PLANNING_FILES} (should be 0)

Next steps:
  git push origin {PR_BRANCH}
  gh pr create --base {TARGET} --head {PR_BRANCH}

Or use /gsd:ship to create the PR automatically.
```
</step>

</process>

<success_criteria>
- [ ] PR branch created from target
- [ ] Planning-only commits excluded
- [ ] No .planning/ files in PR branch diff
- [ ] Commit messages preserved from original
- [ ] User shown next steps
</success_criteria>
