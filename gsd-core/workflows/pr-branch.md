@~/.claude/gsd-core/references/response-language-directive.md

<purpose>
Create a clean branch for pull requests by filtering .planning/ paths out of the
cherry-picked history. Two modes, selected by the `planning.pr_strict` config key:

- **default** (`planning.pr_strict: false`) — the PR branch contains code changes and
  structural planning state. Reviewers don't see GSD transient artifacts (PLAN.md,
  SUMMARY.md, CONTEXT.md, RESEARCH.md, etc.), but milestone archives, STATE.md,
  ROADMAP.md, and PROJECT.md changes are preserved.
- **strict** (`planning.pr_strict: true`) — *every* .planning/ path is filtered out,
  structural files included. This is what makes `planning.commit_docs: true` safe for a
  project that versions its planning tree locally but publishes none of it: planning state
  keeps real git history (so `/gsd:undo` and revert paths have something to restore) and
  executor worktrees still find their PLAN.md, while the public PR carries nothing from
  `.planning/`.

Uses git cherry-pick with path filtering to rebuild a clean history.
</purpose>

<process>

<step name="detect_state">
Parse `$ARGUMENTS` for target branch. If no argument is supplied, detect the
default branch via the single resolver (#1146).

```bash
_GSD_SHIM_NAME="gsd-tools.cjs"; _GSD_RUNTIME_ROOT="${RUNTIME_DIR:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"; GSD_TOOLS="${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}"; _gsd_at() { for _p; do if [ -f "$_p" ]; then GSD_TOOLS="$_p"; return 0; fi; done; return 1; }; if _gsd_at "${_GSD_RUNTIME_ROOT}/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.claude/gsd-core/bin/${_GSD_SHIM_NAME}" "${_GSD_RUNTIME_ROOT}/.codex/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; elif unset -f gsd_run; _G="$(command -v gsd_run)"; then GSD_TOOLS="$_G"; gsd_run() { "$GSD_TOOLS" "$@"; }; elif _gsd_at "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core/bin/${_GSD_SHIM_NAME}" "${HERMES_HOME:-$HOME/.hermes}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CURSOR_CONFIG_DIR:-$HOME/.cursor}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEX_HOME:-$HOME/.codex}/gsd-core/bin/${_GSD_SHIM_NAME}" "${COPILOT_CONFIG_DIR:-$HOME/.copilot}/gsd-core/bin/${_GSD_SHIM_NAME}" "${WINDSURF_CONFIG_DIR:-$HOME/.codeium/windsurf}/gsd-core/bin/${_GSD_SHIM_NAME}" "${AUGMENT_CONFIG_DIR:-$HOME/.augment}/gsd-core/bin/${_GSD_SHIM_NAME}" "${TRAE_CONFIG_DIR:-$HOME/.trae}/gsd-core/bin/${_GSD_SHIM_NAME}" "${QWEN_CONFIG_DIR:-$HOME/.qwen}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CODEBUDDY_CONFIG_DIR:-$HOME/.codebuddy}/gsd-core/bin/${_GSD_SHIM_NAME}" "${CLINE_CONFIG_DIR:-$HOME/.cline}/gsd-core/bin/${_GSD_SHIM_NAME}" "${GROK_AGENTS_HOME:-$HOME/.agents}/gsd-core/bin/${_GSD_SHIM_NAME}" "${ANTIGRAVITY_CONFIG_DIR:-$HOME/.gemini/antigravity}/gsd-core/bin/${_GSD_SHIM_NAME}" "${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/gsd-core/bin/${_GSD_SHIM_NAME}" "${KILO_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/kilo}/gsd-core/bin/${_GSD_SHIM_NAME}"; then gsd_run() { node "$GSD_TOOLS" "$@"; }; else echo "ERROR: gsd-tools.cjs not found at $GSD_TOOLS and gsd_run is not on PATH. Run: npx -y @opengsd/gsd-core@latest --claude --local" >&2; exit 1; fi; GSD_IDENTITY_STATUS=unverified; case "$(gsd_run runtime-identity --raw 2>/dev/null || true)" in '{"packageName":"@opengsd/gsd-core"'*'}') GSD_IDENTITY_STATUS=ok;; esac; export GSD_IDENTITY_STATUS; [ "$GSD_IDENTITY_STATUS" = ok ] || echo "WARNING: \"$GSD_TOOLS\" did not prove it is @opengsd/gsd-core - it is either a different package or an @opengsd/gsd-core older than the runtime-identity verb. See docs/how-to/diagnose-a-foreign-gsd-tools.md" >&2; if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "${GSD_TOOLS:-}" ]; then printf "export PATH='%s':\"\$PATH\"\n" "${GSD_TOOLS%/*}" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true; fi
CURRENT_BRANCH=$(git branch --show-current)
TARGET=${1:-$(gsd_run query git.base-branch)}
```

Check preconditions:
- Must be on a feature branch (not main/master)
- Must have commits ahead of target
- Working tree must be clean

```bash
AHEAD=$(git rev-list --count "$TARGET".."$CURRENT_BRANCH" 2>/dev/null)
if [ "$AHEAD" = "0" ]; then
  echo "No commits ahead of $TARGET — nothing to filter."
  exit 0
fi

# The filter below removes files from the index AND the working tree before each
# commit lands, and this command switches branches underneath the user's own
# checkout. An uncommitted edit to a tracked file would be destroyed by that, and
# git cherry-pick refuses to run against a dirty tree anyway — so fail here, where
# the message is legible, rather than midway through the cherry-pick loop.
DIRTY=$(git status --porcelain --untracked-files=no)
if [ -n "$DIRTY" ]; then
  echo "Working tree has uncommitted changes — commit or stash them first:" >&2
  echo "$DIRTY" >&2
  exit 1
fi
```

Resolve the filter mode from config. A non-zero exit or an unset key means the default
mode; only the literal string `true` selects strict.

```bash
PR_STRICT=$(gsd_run query config-get planning.pr_strict --raw 2>/dev/null)
if [ "$PR_STRICT" = "true" ]; then PR_MODE="strict"; else PR_MODE="default"; PR_STRICT="false"; fi
```

Display:
```
### GSD ► PR BRANCH

Branch: {CURRENT_BRANCH}
Target: {TARGET}
Commits: {AHEAD} ahead
Mode:    {PR_MODE}  (planning.pr_strict={PR_STRICT})
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

**Canonical path declarations.** These two lines are the single source of truth for the
whole command. `create_pr_branch` derives *which paths it removes* from them, and `verify`
derives *which paths must not appear* from the same two lines — so the two steps cannot
disagree about what the filter promised. Declare them exactly once; do not restate either
list anywhere else in this file.

```bash
# Transient planning subdirectories — reviewer noise (PLAN.md, SUMMARY.md, CONTEXT.md,
# RESEARCH.md, and friends). Filtered out in BOTH modes.
TRANSIENT_DIRS="phases quick research threads todos debug seeds codebase ui-reviews"

# Structural planning files — repository planning state. Preserved in default mode,
# filtered out in strict mode. Anchored on both alternatives so `.planning/STATEX.md`
# and `.planning/STATE.md.bak` are NOT treated as structural.
STRUCTURAL_RE="^\.planning/(STATE|ROADMAP|MILESTONES|PROJECT|REQUIREMENTS)\.md$|^\.planning/milestones/"
```

Derive the mode's two projections — `FILTER_PATHS` (what `create_pr_branch` removes from
each cherry-picked commit) and `FORBIDDEN_RE` (what `verify` asserts is absent):

```bash
if [ "$PR_STRICT" = "true" ]; then
  FILTER_PATHS=".planning/"
  FORBIDDEN_RE="^\.planning/"
else
  # Rewrapped through unquoted command substitution (gsd-core#4109): a bare
  # `$VAR` word-splits under bash but not zsh, collapsing every element onto
  # one iteration there.
  FILTER_PATHS=$(for d in $(printf '%s' "$TRANSIENT_DIRS"); do printf '.planning/%s/ ' "$d"; done)
  FORBIDDEN_RE="^\.planning/($(echo "$TRANSIENT_DIRS" | tr ' ' '|'))/"
fi
```

For each commit, check what it touches:

```bash
# For each commit hash
FILES=$(git diff-tree --no-commit-id --name-only -r $HASH)
NON_PLANNING=$(echo "$FILES" | grep -c -v "^\.planning/" || true)
STRUCTURAL=$(echo "$FILES" | grep -Ec "$STRUCTURAL_RE" || true)
```

Classify:
- **Code commits**: touch at least one non-`.planning/` file → INCLUDE (both modes)
- **Mixed commits**: touch code + any planning files → INCLUDE (both modes; the planning
  paths are filtered out by `create_pr_branch`, not the commit)
- **Structural planning commits**: touch only structural `.planning/` files → INCLUDE in
  **default** mode; **EXCLUDE** in strict mode, which has no structural carve-out
- **Transient planning commits**: touch only `.planning/` paths that are not structural →
  EXCLUDE (both modes)

In strict mode this collapses to a single rule: `NON_PLANNING > 0` → INCLUDE, else EXCLUDE.

Display analysis:
```
Commits to include: {N} (code changes{, + structural planning — default mode only})
Commits to exclude: {N} (planning-only)
Mixed commits: {N} (code + planning — included, planning paths filtered)
Structural planning commits: {N} ({included|excluded — strict mode})
```
</step>

<step name="create_pr_branch">
```bash
PR_BRANCH="${CURRENT_BRANCH}-pr"

# Create PR branch from target
git checkout -b "$PR_BRANCH" "$TARGET"
```

Cherry-pick the included commits, in order, filtering `$FILTER_PATHS` out of each one.

The filter forces every filtered path back to **exactly what the PR branch's HEAD already
has**, in both the index and the working tree. That is stricter than simply un-staging, and
both halves matter:

- `git rm -r -f --ignore-unmatch` clears the index entry (including an unmerged one) and
  removes the file the pick just wrote. It only ever touches paths that are in the index, so
  a genuinely untracked planning file of the user's is never harmed.
- `git checkout HEAD --` then restores whatever the target branch legitimately tracks at
  those paths. **Without this, un-staging a path the target branch already tracks records a
  DELETION** — the generated PR would remove the base branch's planning files. In strict mode
  that would be the base's entire `.planning/` tree.

Leaving the filtered file behind in the working tree is not an option either: a later commit
touching the same planning path makes `git cherry-pick` abort with *"untracked working tree
files would be overwritten by merge"*, and every remaining commit is silently dropped.

```bash
# Rewrapped through unquoted command substitution (gsd-core#4109): a bare
# `$VAR` word-splits under bash but not zsh, collapsing every element onto
# one iteration there.
for HASH in $(printf '%s' "$INCLUDED_COMMITS"); do
  # A modify/delete conflict on a filtered path is EXPECTED and is resolved below — the
  # filtered path is absent from HEAD by construction. Do not treat it as a failure here.
  git cherry-pick --no-commit "$HASH" || true

  for P in $(printf '%s' "$FILTER_PATHS"); do
    git rm -r -f -q --ignore-unmatch -- "$P" 2>/dev/null || true
    git checkout HEAD -- "$P" 2>/dev/null || true
  done

  # Anything still unmerged is a REAL conflict, outside the filter. Halt — do not
  # improvise a resolution and do not continue, which would drop the rest of the queue.
  # Unwind first: this loop runs in the user's own checkout, so exiting mid-sequence
  # would strand them on a half-built branch with cherry-pick state still live.
  if [ -n "$(git diff --name-only --diff-filter=U)" ]; then
    echo "Conflict outside the .planning/ filter while picking $HASH:" >&2
    git diff --name-only --diff-filter=U >&2
    # Order matters. `--quit` drops the sequencer state but leaves the unmerged index
    # in place, and an unmerged index makes `git checkout` refuse — so reset first.
    # $PR_BRANCH is disposable and every commit on it was cherry-picked, and the
    # clean-tree precondition guarantees the user had nothing uncommitted, so a hard
    # reset here cannot destroy anything of theirs.
    git cherry-pick --quit 2>/dev/null || true
    git reset -q --hard HEAD
    if git checkout -q "$CURRENT_BRANCH"; then
      git branch -q -D "$PR_BRANCH" 2>/dev/null || true
      echo "Restored $CURRENT_BRANCH and removed the partial $PR_BRANCH." >&2
    else
      # Never claim a restore that did not happen — say exactly where they are.
      echo "Could not return to $CURRENT_BRANCH; you are still on $PR_BRANCH." >&2
      echo "Run: git checkout $CURRENT_BRANCH && git branch -D $PR_BRANCH" >&2
    fi
    echo "Resolve the conflict against $TARGET, then re-run /gsd:pr-branch." >&2
    exit 1
  fi

  # Nothing left after filtering (possible when a pick's only surviving content was
  # planning state): clear the sequencer rather than failing on an empty commit.
  if git diff --cached --quiet; then
    git cherry-pick --quit 2>/dev/null || true
    continue
  fi

  git commit -q -C "$HASH"
done
```

Return to original branch:
```bash
git checkout "$CURRENT_BRANCH"
```
</step>

<step name="verify">
Assert against the **active mode's** contract — `$FORBIDDEN_RE`, the same declaration
`create_pr_branch` filtered on. Counting every `.planning/` path unconditionally would
contradict default mode, which is specified to preserve structural files: a correct run
would report itself as failed on every phase that touched STATE.md, which is every phase.

```bash
DIFF_PATHS=$(git diff --name-only "$TARGET".."$PR_BRANCH")
FORBIDDEN=$(echo "$DIFF_PATHS" | grep -Ec "$FORBIDDEN_RE" || true)
PLANNING_TOTAL=$(echo "$DIFF_PATHS" | grep -c "^\.planning/" || true)
ALLOWED=$((PLANNING_TOTAL - FORBIDDEN))
TOTAL_FILES=$(echo "$DIFF_PATHS" | grep -c . || true)
PR_COMMITS=$(git rev-list --count "$TARGET".."$PR_BRANCH")

# #3679: a DELETED planning path is never legitimate — this workflow only ever
# excludes content a cherry-picked commit ADDED; pre-existing target-tracked
# planning files must survive byte-identical. Name-only counting cannot see
# status (a deleted structural/allowed path verifies clean there), so gate on
# deletions explicitly, across every planning category.
PLANNING_DELETIONS=$(git diff --name-status --no-renames "$TARGET".."$PR_BRANCH" | grep "^D" | grep -c "\.planning/" || true)

# Default mode preserves anything under .planning/ that is neither transient nor
# structural — config.json, intel/, workstreams/. That is deliberate and unchanged, but it
# must not be silent: report it so the user can choose strict mode knowingly.
OTHER=$(echo "$DIFF_PATHS" | grep "^\.planning/" | grep -Ev "$FORBIDDEN_RE" | grep -Ev "$STRUCTURAL_RE" || true)
```

`$FORBIDDEN` is the pass/fail number — it must be `0`. A non-zero value means the filter
did not do what this mode promised; report it and do not tell the user to push.

`$PLANNING_DELETIONS` is a second hard gate (#3679) — it must also be `0`. A non-zero
value means the PR branch would DELETE planning files the target branch tracks
(`git diff --name-status --no-renames "$TARGET".."$PR_BRANCH" | grep "^D" | grep "\.planning/"` lists
them). That is data loss, not filtering — report it, do not tell the user to push, and
rebuild the branch.

Display results:
```
✅ PR branch created: {PR_BRANCH}

Original: {AHEAD} commits, {ORIGINAL_FILES} files
PR branch: {PR_COMMITS} commits, {TOTAL_FILES} files
Mode: {PR_MODE}
Planning paths in diff: {PLANNING_TOTAL} (allowed {ALLOWED}, forbidden {FORBIDDEN} — must be 0)
Planning deletions: {PLANNING_DELETIONS} (must be 0 — #3679)

Next steps:
  git push origin {PR_BRANCH}
  gh pr create --base {TARGET} --head {PR_BRANCH}

Or use /gsd:ship to create the PR automatically.
```

When `$OTHER` is non-empty (default mode only — strict forbids all of it), append:
```
ℹ️  These .planning/ paths are neither transient nor structural, so default mode keeps them:
{OTHER}
    Set `planning.pr_strict: true` to keep every .planning/ path out of the PR branch.
```
</step>

</process>

<success_criteria>
- [ ] Working tree was clean before the PR branch was created
- [ ] PR branch created from target
- [ ] Planning-only commits excluded
- [ ] Zero paths matching the active mode's `$FORBIDDEN_RE` in the PR branch diff —
      strict: no `.planning/` path at all; default: none from `$TRANSIENT_DIRS`
- [ ] No `.planning/` path the target branch already tracked was deleted
- [ ] Every included commit landed — none dropped by a failed cherry-pick
- [ ] Commit messages preserved from original
- [ ] User shown next steps
</success_criteria>
