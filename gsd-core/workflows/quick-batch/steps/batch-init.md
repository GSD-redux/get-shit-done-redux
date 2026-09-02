**Step 2b: Create a new batch (only when `$RESUME_BATCH_ID` is empty)**

Skip this step entirely if `$RESUME_BATCH_ID` is set (resume-mode.md owns
that path instead).

**Get the task list.** If `--file <path>` was present in `$ARGUMENTS`, use its
value as `$TASK_FILE`. Otherwise the remaining, non-flag text of `$ARGUMENTS`
IS the inline task list (a bulleted/numbered list, ≥2 items — the same
grammar `parseTaskList` enforces).

If `$TASK_FILE` is set:
```bash
QB_CREATE_JSON=$(gsd_run quick-batch create --file "$TASK_FILE" --base-revision "$(git rev-parse HEAD)" --raw)
```

Otherwise, the inline list must land on disk first — `quick-batch create`
only accepts `--file` (path-confined, same as `/gsd:quick-batch`'s own
security posture): write it to a scratch file under `.planning/` before
calling the verb.
```bash
TASK_FILE="${quick_dir%/quick}/.quick-batch-task-list.tmp"
mkdir -p "$(dirname "$TASK_FILE")"
printf '%s\n' "$INLINE_TASK_LIST" > "$TASK_FILE"
QB_CREATE_JSON=$(gsd_run quick-batch create --file "$TASK_FILE" --base-revision "$(git rev-parse HEAD)" --raw)
rm -f "$TASK_FILE"
```

```bash
QB_CREATE_RC=$?
if [[ "$QB_CREATE_JSON" == @file:* ]]; then QB_CREATE_JSON=$(cat "${QB_CREATE_JSON#@file:}"); fi
```

**If `$QB_CREATE_RC` is non-zero:** the task list failed to parse (fewer than
2 items — row 2/12) or the dependency DAG was invalid. Print the CLI's error
message verbatim and STOP. Do not dispatch anything.

**Otherwise:** parse `$QB_CREATE_JSON` for `batchId` and `manifest` (every
item starts `pending`, wave `0` — no dependency/file-overlap signal exists
yet before planning; this is expected, not a bug, per the design's negative-
space note).

```bash
BATCH_ID="$batchId"
BATCH_MANIFEST_JSON=$(printf '%s' "$QB_CREATE_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(JSON.stringify(j.manifest))}catch{process.stdout.write("")}})')
ITEM_COUNT=$(printf '%s' "$BATCH_MANIFEST_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);process.stdout.write(String(j.items.length))}catch{process.stdout.write("0")}})')
```

Report to user:
```
Creating quick batch ${BATCH_ID}: ${ITEM_COUNT} item(s).
Manifest: .planning/quick-batches/${BATCH_ID}/BATCH.json
```

Continue to Step 3 in `quick-batch.md`.
