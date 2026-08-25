# Protected-branch warning for `branching_strategy: none` (#3552)

Run this from the `handle_branching` step's `"none"` arm, after deciding to
continue on the current branch. It warns without refusing execution — the
`"none"` strategy still runs on whatever branch it started on.

```bash
CURRENT_BRANCH=$(git branch --show-current 2>/dev/null || true)
IS_PROTECTED=$(gsd_run query git.base-branch --is-protected "$CURRENT_BRANCH") || IS_PROTECTED=""
if [ "$IS_PROTECTED" = true ]; then
  echo "⚠ Current branch '$CURRENT_BRANCH' is a protected branch; branching_strategy=none will continue here." >&2
elif [ -z "$IS_PROTECTED" ]; then
  echo "⚠ Could not determine whether '$CURRENT_BRANCH' is protected — the query failed. Continuing." >&2
fi
```

The `IS_PROTECTED=""` fallback on the first line, and the second `elif`, exist
so a failed or missing `gsd_run` invocation degrades **visibly** (an explicit
"could not determine" warning) rather than silently reading as "not
protected" under `set -e` (#3648 review, round 5).
