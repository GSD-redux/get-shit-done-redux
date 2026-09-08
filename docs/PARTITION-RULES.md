# Partition rules for compact-content splits

(ADR-4139 Decision 5, epic [#4139](https://github.com/open-gsd/gsd-core/issues/4139),
Phase 3 [#4403](https://github.com/open-gsd/gsd-core/issues/4403).) These are the rules a
`workflow.compact_content` split — a workflow file broken into a spine plus one or more
`detail/*.md` parts — must obey, and the CI guard (`tests/compact-content-partition-guard.test.cjs`)
that enforces them. See `docs/adr/4139-compact-content-seam.md` for the full design rationale;
this document is the operational reference for anyone performing a split.

## The rule

**A split moves text. It does not restate it.** The spine and its detail parts are pieces of
one document, not two. There is exactly one copy of each sentence, so there is no stale twin
that can exist — which is what replaces the drift-parity check an earlier design of this
feature would have needed forever.

Rewriting for terseness is permitted **within** one half and is never a way to move a
sentence into both. Where a split cannot be made by moving text alone without breaking the
spine's ability to run the workflow correctly on its own, the correct answer is a different
split point, not a duplicated paragraph.

## The protected-content list

Content in this list may never leave a workflow spine during a split — it stays directly in
the eagerly-loaded spine file, never moved to a `detail/*.md` part, regardless of how much it
would shrink the spine:

1. **Negative instructions and guardrails** — any "do not X" / "never X" instruction that
   changes what the orchestrator must refuse to do (e.g. "Never call `ScheduleWakeup`... to
   literalize this wait").
2. **Output-format contracts** — any block defining the literal shape of output another
   system consumes: a prompt template handed to a subagent, a JSON/XML schema, a
   `<quality_gate>` or `<success_criteria>` checklist.
3. **Few-shot examples the workflow's own steps depend on** — a worked example whose absence
   would leave a later instruction ambiguous (e.g. a `<verify>`/`<fails_when>` XML pair a
   planner prompt's own rule depends on).
4. **Security and prompt-injection language** — any text establishing a security boundary or
   defending against injected instructions.
5. **Machine-parsed structural headings** — a heading or marker another tool locates by exact
   text (a `## PLANNING COMPLETE`-style return marker, a `<!-- gsd:section -->` directive, a
   `<process>`/`</process>` boundary).

### Marking

A sentinel comment declares protection at authoring time. The guard checks for the
sentinel-wrapped content's continued presence in the spine, never for category membership —
a guard cannot judge prose category on its own, so protection is declared, not inferred:

```markdown
<!-- gsd:protected -->
… one protected block …

<!-- gsd:protected:start -->
… a protected region spanning several blocks …
<!-- gsd:protected:end -->
```

The categories above are authoring guidance for *where* to place a sentinel when splitting a
file — they are never what the automated guard evaluates; only the sentinel-wrapped content's
continued presence in the spine is.

## The five checks

The guard discovers registered splits by scanning `gsd-core/workflows/**` for any
`<name>/detail/*.md` path and pairing it with `gsd-core/workflows/<name>.md`. There is no
separate registry to maintain — a pair is registered by existing on disk.

1. **Completeness — once, at split time.** Fires only on the PR that introduces a new
   `<name>/detail/*.md` path (i.e. the PR performing the split). The union of the new spine
   and its new detail parts, whitespace-normalized, must contain every non-trivial line the
   old spine carried at the merge-base. This is what makes a split reviewable; it never fires
   again for that pair afterward.
2. **Disjointness — ongoing.** No non-trivial line may appear in both a spine and any of its
   detail parts, checked on every PR against every registered pair regardless of what the PR
   touched. This is the invariant that keeps duplication from creeping back in.
3. **Registration — ongoing.** A `<name>/detail/*.md` with no `<name>.md` spine, or a spine
   whose prose names a detail path that does not exist on disk, fails and names the orphan.
4. **Protected content — ongoing, and cannot be excused.** For every registered spine a PR's
   diff touches, every line that sat inside a `<!-- gsd:protected -->` sentinel at the
   merge-base must still be physically present in the spine. Deleting it or moving it into a
   detail part both fail — naming the sentinel's first line and, for a move, the destination
   path. **No `Boundary-Move-Declared` trailer excuses this one**: protected content is
   categorically barred from leaving the spine, not merely required to be declared when it
   does.
5. **Boundary moves are declared — ongoing.** For ordinary (non-protected) content: if a
   non-trivial line is removed from a registered spine and the identical line appears newly
   added in that spine's own detail parts in the same diff, one of the PR's own commits
   (`merge-base..HEAD`) must carry:

   ```
   Boundary-Move-Declared: gsd-core/workflows/<name>.md — <why this moved>
   ```

   A missing trailer fails and names the spine and the moved line. This mirrors
   [ADR-3942](adr/3942-emitted-drift-ack-commit-trailer.md)'s `Emitted-Drift-Ack-Hash`/`-Growth`
   trailers exactly — same `git log $(git merge-base <base> HEAD)..HEAD` range, same
   fail-closed behavior when that range is uncomputable (a shallow clone throws, it never
   silently reports "no violation"), same de-duplication of identical trailers across a
   rebase, same hard error when two commits declare the same spine with different reasons.
   See `CONTRIBUTING.md`'s "Editing shipped content" section for the trailer mechanism's
   general shape.

Checks 1 and 4–5 read `merge-base..HEAD`, never `base..HEAD` (two-dot) — the same correction
ADR-3942 made for its own trailer range, for the same reason: a two-dot range would let the
set of commits being checked and the set of files being diffed disagree about what "this PR"
means.
