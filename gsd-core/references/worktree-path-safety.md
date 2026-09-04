# Executor Path Safety

Guards for executor agents. The supplied-root check runs in every mode; the three
remaining checks apply inside Claude Code worktrees. Run the applicable checks
before any staging, Edit, or Write operation.

---

## Supplied-root guard — step 0p (#4254, all modes)

Sequential dispatches include a `<project_root_pin>` containing the orchestrator's
already-validated absolute root. Copy its exact literal content into
`SUPPLIED_PROJECT_ROOT` below before running the block. Do not derive the supplied
value from the executor's cwd. If the tag is absent, leave the assignment empty:
older orchestrators and isolated dispatches warn and proceed for compatibility.

This check must not use `[ -f .git ]` or any other worktree-shape gate. A sequential
executor that starts in the wrong primary checkout sees a `.git` directory and must
still halt before its first Edit, Write, staging operation, or commit.

```bash
# gsd:guard=executor-project-root-pin
SUPPLIED_PROJECT_ROOT='' # Replace RHS with the shell-quoted <project_root_pin> literal when supplied.
ACTUAL_PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
if [ -z "$SUPPLIED_PROJECT_ROOT" ]; then
  echo "WARNING: no orchestrator project-root pin was supplied; proceeding with the executor-resolved root for compatibility (#4254)." >&2
elif [ -z "$ACTUAL_PROJECT_ROOT" ] || [ "$ACTUAL_PROJECT_ROOT" != "$SUPPLIED_PROJECT_ROOT" ]; then
  echo "FATAL: executor root does not match the orchestrator-supplied project root (#4254)." >&2
  echo "  Supplied: $SUPPLIED_PROJECT_ROOT" >&2
  echo "  Current:  ${ACTUAL_PROJECT_ROOT:-<unresolved>}" >&2
  echo "Halting before Edit, Write, staging, or commit; re-dispatch from the orchestrator's checkout." >&2
  exit 1
fi
```

Run this guard before the first write and again immediately before the task commit
protocol. Continue with the worktree-only checks below when they apply.

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
if [ -f .git ]; then  # we are in a worktree
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
fi
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

## Pre-commit HEAD guard — step 0 (#2924)

In a Claude Code worktree, assert HEAD is on a per-agent branch before staging
or committing. Never self-recover by rewriting a protected ref.

```bash
if [ -f .git ]; then
  HEAD_REF=$(git symbolic-ref --quiet HEAD || echo "DETACHED")
  ACTUAL_BRANCH=$(git rev-parse --abbrev-ref HEAD)
  if [ "$HEAD_REF" = "DETACHED" ] || \
     echo "$ACTUAL_BRANCH" | grep -Eq '^(main|master|develop|trunk|release/.*)$'; then
    echo "FATAL: refusing to commit — worktree HEAD is on '$ACTUAL_BRANCH' (expected per-agent branch)." >&2
    echo "DO NOT use 'git update-ref' to rewind the protected branch — surface as blocker (#2924)." >&2
    exit 1
  fi
  if ! echo "$ACTUAL_BRANCH" | grep -Eq '^((worktree-)?agent-|worktree-wf_)[A-Za-z0-9._/-]+$'; then
    echo "FATAL: refusing to commit — worktree HEAD '$ACTUAL_BRANCH' is not in the agent-* / worktree-agent-* / worktree-wf_* namespace." >&2
    echo "Agent commits must live on per-agent branches; surface as blocker (#2924)." >&2
    exit 1
  fi
fi
```
