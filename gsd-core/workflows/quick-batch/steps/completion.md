**Step 9: Completion**

For every item that merged successfully in Step 7 AND (NOT `$VALIDATE_MODE`,
OR Step 8 routed it to `complete`): call `completeQuickItem` via its CLI verb
— this is the ONLY writer of a "Quick Tasks Completed" STATE.md row and the
item's `complete` status; both happen inside ONE lock transaction, exactly
once per item (idempotent — re-running this step for an already-complete
item is a no-op, same guarantee `/gsd:quick` relies on):

```bash
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
