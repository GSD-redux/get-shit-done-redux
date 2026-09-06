# Executor Path Safety

Guards for executor agents. Supplied-root and protected-branch checks are independent
of worktree shape; cwd-drift and absolute-path checks protect isolated worktrees.
Run applicable checks before staging, Edit, or Write and before every commit.

---

## Supplied-root guard — step 0p (#4254, all modes)

The orchestrator embeds the **runnable block**, with its literal root already bound,
inside `<project_root_pin>`. Run that block unchanged before the first write and
again before each commit, in the same cwd as the write/commit. Never fill in a pin
from the executor's cwd. A sequential dispatch with a missing/unexpanded block must
HALT and request redispatch. For older dispatches with neither a sequential tag nor
a pin, and for isolated dispatches without a pin, warn and continue with the other
applicable guards; do not execute an empty-pin version of this template.

Keep the cwd in the pinned checkout. A plan explicitly touching a registered
submodule may enter that submodule to stage/commit: the guard verifies its immediate
superproject is the pinned checkout and its physical root is inside that checkout.
An unrelated nested repository, another checkout's submodule, or a symlink escaping
the pin must halt. For nested submodules, dispatch separately with their immediate
superproject as the validated pin. Re-run the guard after every cwd change; do not
use `git -C` to switch commit targets behind a guard run in a different cwd.

### Orchestrator build-time composition

Run this JavaScript with Node (`node -e <this block> "$ORCHESTRATOR_WT"
"$PATH_SAFETY_REFERENCE"`), where `PATH_SAFETY_REFERENCE` is the absolute path of
this loaded reference. It returns JSON: `assignment` replaces the entire
`PROJECT_ROOT=$(...)` assignment in `<required_reading>`; `guard` replaces the
contents of `<project_root_pin>`. Insert the returned strings as prompt text, not
as shell commands to evaluate during composition. Never hand-quote the path or
pass the composition instruction through to the executor.

```javascript
// gsd:compose=executor-project-root-pin
const fs = require('node:fs');
const path = require('node:path');
const [root, reference] = process.argv.slice(1);
if (!root || !path.isAbsolute(root)) throw new Error('Missing absolute ORCHESTRATOR_WT (#4254)');
const source = fs.readFileSync(reference, 'utf8');
const marker = '# gsd:guard=executor-project-root-pin';
const fence = String.fromCharCode(96).repeat(3);
const template = source.split(fence + 'bash\n').find(block => block.startsWith(marker))?.split(fence)[0];
if (!template || !template.includes('SUPPLIED_PROJECT_ROOT={PROJECT_ROOT_LITERAL}')) {
  throw new Error('Missing supplied-root guard template (#4254)');
}
const quoted = "'" + root.replace(/'/g, "'\"'\"'") + "'";
const guard = template.replace('SUPPLIED_PROJECT_ROOT={PROJECT_ROOT_LITERAL}', () => 'SUPPLIED_PROJECT_ROOT=' + quoted);
process.stdout.write(JSON.stringify({ assignment: 'PROJECT_ROOT=' + quoted, guard }));
```

```bash
# gsd:guard=executor-project-root-pin
SUPPLIED_PROJECT_ROOT={PROJECT_ROOT_LITERAL}
gsd_root_pin_fail() {
  echo "FATAL: executor root does not match a valid orchestrator pin (#4254); halt before writes/commits and request redispatch." >&2
  exit 1
}
case "$SUPPLIED_PROJECT_ROOT" in
  /*|[A-Za-z]:/*) ;;
  *) gsd_root_pin_fail ;;
esac
PINNED_ROOT=$(CDPATH= cd -- "$SUPPLIED_PROJECT_ROOT" 2>/dev/null && pwd -P) || gsd_root_pin_fail
ACTUAL_PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null) || gsd_root_pin_fail
[ -n "$ACTUAL_PROJECT_ROOT" ] || gsd_root_pin_fail
ACTUAL_PROJECT_ROOT=$(CDPATH= cd -- "$ACTUAL_PROJECT_ROOT" 2>/dev/null && pwd -P) || gsd_root_pin_fail
if [ "$ACTUAL_PROJECT_ROOT" != "$PINNED_ROOT" ]; then
  SUPERPROJECT_ROOT=$(git rev-parse --show-superproject-working-tree 2>/dev/null) || gsd_root_pin_fail
  [ -n "$SUPERPROJECT_ROOT" ] || gsd_root_pin_fail
  SUPERPROJECT_ROOT=$(CDPATH= cd -- "$SUPERPROJECT_ROOT" 2>/dev/null && pwd -P) || gsd_root_pin_fail
  [ "$SUPERPROJECT_ROOT" = "$PINNED_ROOT" ] || gsd_root_pin_fail
  case "$ACTUAL_PROJECT_ROOT" in
    "$PINNED_ROOT"/*) ;;
    *) gsd_root_pin_fail ;;
  esac
fi
```

---

## Worktree branch check (run once at spawn-time)

The spawn-time HEAD/base guard now lives in the canonical fragment
`gsd-core/references/worktree-branch-check.md`, which the orchestrator embeds directly
into your prompt at dispatch. Run that block FIRST, before any reset/checkout or staging.
If your prompt contains a `<worktree_branch_check>` embed instruction rather than the block itself, complete that read-and-embed step before any reset/checkout or staging.

---

## cwd-drift sentinel — step 0a (#3097)

A prior Bash call may have `cd`'d out of the worktree into the main repo. When
that happens `[ -f .git ]` is false (main repo's `.git` is a directory), silently
skipping all worktree guards. The sentinel captures the spawn-time toplevel and
detects drift before every commit.

```bash
  WT_GIT_DIR=$(git rev-parse --git-dir 2>/dev/null)
  case "$WT_GIT_DIR" in
    *.git/worktrees/*)
      SENTINEL="$WT_GIT_DIR/gsd-spawn-toplevel"
      [ ! -f "$SENTINEL" ] && git rev-parse --show-toplevel > "$SENTINEL" 2>/dev/null
      EXPECTED_TL=$(cat "$SENTINEL" 2>/dev/null)
      ACTUAL_TL=$(git rev-parse --show-toplevel 2>/dev/null)
      if [ -n "$EXPECTED_TL" ] && [ "$ACTUAL_TL" != "$EXPECTED_TL" ]; then
        echo "FATAL: cwd drifted from spawn-time worktree root (#3097)" >&2
        echo "  Spawn-time: $EXPECTED_TL" >&2
        echo "  Current:    $ACTUAL_TL" >&2
        echo "RECOVERY: cd \"$EXPECTED_TL\" before staging, then re-run this commit." >&2
        exit 1
      fi
      ;;
  esac
```

---

## Absolute-path guard — step 0b (#3099)

Edit/Write calls using absolute paths constructed from the **orchestrator's** `pwd`
(main repo root) will resolve to the main repo, not the worktree. Writes land in
the wrong directory; `git commit` from the worktree sees a clean tree and the work
is silently lost.

Before any Edit or Write using an absolute path:

```bash
WT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
[ -z "$WT_ROOT" ] && { echo "FATAL: could not determine worktree root" >&2; exit 1; }
# Boundary-safe containment prevents a sibling such as "$WT_ROOT-other" from passing.
if [[ "$ABS_PATH" != "$WT_ROOT" && "$ABS_PATH" != "$WT_ROOT/"* ]]; then
  echo "FATAL: $ABS_PATH is outside the worktree ($WT_ROOT) — use a relative path or recompute from WT_ROOT" >&2
  exit 1
fi
```

**Prefer relative paths** for all Edit/Write operations. When an absolute path is
unavoidable, always derive it from `git rev-parse --show-toplevel` run inside the
worktree — never from `pwd` captured in the orchestrator context.

---

## Pre-commit HEAD safety assertion — step 0 (#2924, #3819, all modes)

Assert HEAD is not protected before staging or committing. Never self-recover by
rewriting a protected ref. The per-agent namespace check remains worktree-only.

```bash
HEAD_REF=$(git symbolic-ref --quiet HEAD || echo "DETACHED")
ACTUAL_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [ "$HEAD_REF" = "DETACHED" ]; then
  echo "FATAL: refusing to commit — HEAD is detached." >&2
  exit 1
fi
# #3819: real default branch; override git.allow_default_branch_commits; else five-name fallback.
IS_PROTECTED=$(gsd_run query git.base-branch --is-protected "$ACTUAL_BRANCH" 2>/dev/null) || IS_PROTECTED="__GSD_RUN_UNAVAILABLE__"
if [ "$IS_PROTECTED" = "__GSD_RUN_UNAVAILABLE__" ] || [ -z "$IS_PROTECTED" ]; then
  if echo "$ACTUAL_BRANCH" | grep -Eq '^(main|master|develop|trunk|release/.*)$'; then
    IS_PROTECTED="true"
  else
    IS_PROTECTED="false"
  fi
fi
if [ "$IS_PROTECTED" != "false" ]; then
  echo "FATAL: refusing to commit — HEAD is on '$ACTUAL_BRANCH' (protected/default branch)." >&2
  echo "Re-home onto a phase/agent branch (#2924, #3819); override: git.allow_default_branch_commits:true in .planning/config.json." >&2
  exit 1
fi
if [ -f .git ]; then  # worktree
  # Positive allow-list: HEAD must be on a per-agent branch (`agent-<id>` or
  # legacy `worktree-agent-<id>`). This catches feature/* and any other
  # arbitrary branch that the deny-list would silently allow (#2924, #1995).
  if ! echo "$ACTUAL_BRANCH" | grep -Eq '^((worktree-)?agent-|worktree-wf_)[A-Za-z0-9._/-]+$'; then
    echo "FATAL: refusing to commit — worktree HEAD '$ACTUAL_BRANCH' is not in the agent-* / worktree-agent-* / worktree-wf_* namespace." >&2
    echo "Agent commits must live on per-agent branches; surface as blocker (#2924)." >&2
    exit 1
  fi
fi
```
