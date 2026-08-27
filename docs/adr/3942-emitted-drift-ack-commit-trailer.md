# ADR-3942: The emitted-drift acknowledgment is PR-lifetime data — it belongs in a commit trailer, not the working tree

| | |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-08-27 |
| **Issue** | [#3942](https://github.com/open-gsd/gsd-core/issues/3942) |
| **Supersedes** | [ADR-2719](2719-emitted-artifact-attribution.md) **§3 only** ("The escape hatch is a committed acknowledgment, not a flag"), including its #2789 Amendment. §1, §2, §4–§7 are retained and depended upon. |
| **Amends** | — |
| **Constrained by** | [ADR-2719](2719-emitted-artifact-attribution.md) §1 (the invariant is relative, stated as attribution), §4 (the size ratchet folds into the same machine), §6 (it is a test, not a CI job) |

> **Evidence note.** Line citations below were read from the worktree at `origin/next` `11cdc19e3`. CI verdicts are from the live GitHub API for [PR #3927](https://github.com/open-gsd/gsd-core/pull/3927), not from re-derivation. The full root-cause trace is `docs/research/3875-ack-sweep-automation-failure.md`.

## Context

ADR-2719 §3 established that the attribution law needs an escape hatch, and chose a committed document for it. That choice was right about the *shape* of the escape hatch — a prose declaration, not a flag — and wrong about its *storage*. This ADR changes only the storage.

### The acknowledgment's lifetime does not match its storage

An acknowledgment explains one PR's unattributable delta. The moment that PR merges, the delta it explained is in the base, and the acknowledgment can never clear anything again. The directory's own README says so at `tests/emitted-drift-acks/README.md:6`:

> This directory being empty is the healthy steady state. A fragment appearing in a diff *is* the alarm; a fragment sitting here on `next` is spent cruft.

So the data has PR lifetime and is stored in permanent, shared, merge-path state. **Every defect in this family descends from that one mismatch**, and each fix has generated the next:

| # | Fix | Defect it created |
|---|---|---|
| — | Single `tests/emitted-drift-ack.json` | One shared mutable file per PR. "5 of 6 conflicting PRs in one open queue collided on this file and nothing else" (`CONTRIBUTING.md:1086`) |
| #2914 | Split into per-PR fragments, modeled on `.changeset/` | Fragments do not share a *file*, but they do share a *path-key namespace* |
| #3078 | Guard reds `next` on spent fragments | 45 fragments owning 403 paths; each spent fragment walls off the next PR that grows one of its keys |
| #3842 | Sweep spent fragments | Handed three in-flight external PRs (#3330, #3774, #3648) a `modify/delete` conflict each; needed `--defer-to-open-prs` |
| #3823 | Hand-authored sweep | Computed at branch time, guard evaluates at merge time; lost the race to #3809 and left `next` red for **24 consecutive pushes** |
| #3875 | Timed sweeper (`ack-fragment-sweep.yml`) | Its own PR cannot merge itself (below) |

### Why `.changeset/` was the wrong analogy

#2914 reasoned that independently-named fragments cannot conflict, by analogy to `.changeset/`. Changeset fragments are genuinely independent: two of them never name the same entity. Ack fragments key into a shared namespace, and two sources declaring the same key is a hard duplicate-key error (`scripts/lint-emitted-drift-ack.cjs:872-885`). The analogy held at the filesystem layer and failed at the semantic layer. #3078 measured the cost.

### The automation could not close the loop

[PR #3927](https://github.com/open-gsd/gsd-core/pull/3927), the sweeper's first production run, was merged by hand at 12:16Z — 2h38m after opening — **with `validate-title` and `Required tests` still red**. Three independent, deterministic defects, none of them flaky:

1. `.github/workflows/ack-fragment-sweep.yml:266` hardcodes `chore: sweep spent ack fragments from next (${SHORT_SHA})`. `scripts/release-notes/conventional-title.cjs:28,92` requires `(#<issue>)` immediately after the type. The parenthetical is at the end (never parsed as scope) and a git sha contains no `#`. Fails on every run.
2. The sweep's diff is, by construction, deletions under `tests/emitted-drift-acks/`. No rule in `scripts/ci-test-scope.cjs` matches that path, so `classify()` falls through the #408 fallback to the `'unit'` suite sentinel on the **unsharded, 15-minute-capped** lane. Run log: `suite="all" files=827`, killed at chunk 13/14, 15m18s against `timeout-minutes: 15` (`.github/workflows/test.yml:155`).
3. No auto-merge path exists. The workflow ends at `gh pr create` plus labels.

These are fixable in isolation. They are listed here not as the problem but as evidence of its shape: **a garbage collector that needs its own CI lane, its own title convention, and its own merge story is a large amount of machinery to hold up an artifact whose correct steady state is "absent."**

### A latent defect in the current design

The two key spaces are convention-only. A hash ripple keys on the emitted path (`ackEntries.has(rel)`, `tests/helpers/emitted-diff.cjs:597`); growth keys on a bare filename (`ackEntries.has(name)`, `:632`). Both read the same `paths` map with no schema difference — `tests/emitted-drift-acks/README.md:20-23` documents the split, nothing enforces it. A key intended for one space silently satisfies a lookup in the other.

## Decision

### 1. The acknowledgment moves to a commit trailer on the PR's own commits

    Emitted-Drift-Ack-Hash: <emitted/path> — <reason>
    Emitted-Drift-Ack-Growth: <filename> — <reason>

Read from `git log $(git merge-base <base> HEAD)..HEAD` — the PR's own commits and no others.

> **Amendment (#3942 implementation, 2026-08-27).** This section originally said `git log
> <base>..<head>`, leaving the range semantics unstated. **Two-dot would be a defect.**
> `changedPaths` comes from `git diff base...HEAD` — *three*-dot, i.e. merge-base — so a two-dot
> ack range would let the acknowledgment set and the change set disagree about which commits
> belong to this PR, and a trailer could excuse a delta that is not in the diff. §2's claim that
> spentness becomes *structural* also rests entirely on merge-base: it is what puts an
> already-merged trailer out of range by construction. Stated, and pinned by a test that forks a
> topic branch, places a trailer on each side, and asserts only the topic-side trailer is read.

This preserves what ADR-2719 §3 actually cared about. Its stated design property is *"the acknowledgment file appears in the changed-files list **only when something rippled unexpectedly** … touching the acknowledgment *is* the alarm."* A trailer is still a conspicuous, reviewable, prose-carrying declaration that appears in the PR's diff — it is not the `UPDATE_GOLDEN=1` flag §3 rejected. What changes is that the declaration stops outliving the thing it declares.

### 2. "Spent" stops existing

The #2789 Amendment built spent-detection because the document persisted at the base, so `staleAcks` could not distinguish "never explained anything" from "its ripple was absorbed into the base." Scoping the trailer to `base..head` makes that distinction structural rather than computed: a trailer in the PR's commit range is by definition this PR's, and there is no base-side copy to compare against.

This is a strictly stronger form of what #2789 wanted. `readAckFileAtRef`, `listAckFragmentFilesAtRef`, `readAckSourcesAtRef`, the spent/re-arm prose normalization, and `assertNoAllSpentFragments` all become unreachable.

`staleAcks` itself is **retained** — a trailer declaring a key that no delta consumed is still an error (`tests/helpers/emitted-diff.cjs:648`). That check is per-PR and does not depend on persistence.

### 3. The two key spaces become structurally distinct

Two trailer keys instead of one map. A growth acknowledgment can no longer satisfy a hash lookup by coincidence of naming. This closes the latent defect above rather than carrying it forward.

### 4. The pure law does not change

`diffEmitted` already receives `ackEntries` as a plain `Map<key, {reason}>`. The storage medium lives entirely behind the IO shell in `tests/helpers/emitted-runtime.cjs`. Replacing `readAckSources` with a trailer reader is an adapter swap; `tests/helpers/emitted-diff.cjs` — the law — is untouched apart from the key-space split in §3.

There is in-repo precedent for the mechanism: `gsd-core/workflows/ship.md:312` already parses a `gate_status:` trailer with `git log --format='...%(trailers:key=gate_status,valueonly,separator=%x2c)...'`.

### 5. The PR test lane must fetch the commit range

The gate must be able to see the PR's commit range, and must fail closed when it cannot.

> **Amendment 1 — the premise was wrong (#3942 implementation, 2026-08-27).** This section
> originally asserted that "`.github/workflows/test.yml:107-110` — the `test` job — has no
> `fetch-depth` key and therefore checks out at depth 1," and made `fetch-depth: 0` a required
> change. **That is false, and no workflow change is needed.** Line 107 sits inside the
> `lint-tests` job; the matrix `test` job — the one that actually runs
> `tests/emitted-attribution.test.cjs` — begins at `test.yml:130` and already sets
> `fetch-depth: 0` on *both* its Windows (v5.0.1) and Linux/macOS (v6.0.2) checkout steps. The
> claim entered this ADR from a line citation that was not verified against the job boundaries
> before it was written down. The requirement stands as a **property to preserve**, not a change
> to make: if that `fetch-depth: 0` is ever removed, the reader must still fail closed.

> **Amendment 2 — the failure mode was mischaracterized (#3942 implementation, 2026-08-27).** This section originally called the depth-1
> failure mode a **vacuous pass**. That is true of the *fragment* guard and **false of the trailer
> reader**, and the phrase was carried over uncritically. With fragments, depth-1 makes every
> fragment read as brand-new — therefore live — so the guard passes: a false **green**. With
> trailers, an uncomputable range yields *zero* acknowledgments, so a PR that needs one fails: a
> false **red**. Provided the reader throws rather than returning an empty set, the depth-1 failure
> is loud in both directions, which is a real improvement this ADR undersold. `fetch-depth: 0` is
> still required; forgetting it is now merely obstructive instead of dangerous. The throw is pinned
> by a test that builds a genuine shallow clone rather than simulating one.

`fetch-depth: 0` is required on that job, and the gate must fail closed when the range is unavailable — never `return` on a missing base, per ADR-2719 §6 ("A baseline-unavailable path must never be a bare `return`. In `node:test` that is a **pass**").

### 6. What gets deleted

- `.github/workflows/ack-fragment-sweep.yml` (237 lines)
- `guard-no-ack-on-next` (`.github/workflows/test.yml:865-920`)
- `scripts/lint-emitted-drift-ack.cjs` (937 lines) and its `package.json:124` `lint:ci` invocation
- `tests/emitted-drift-acks/` and its README
- The at-ref/spent halves of `tests/helpers/emitted-runtime.cjs`

## Consequences

**The conflict surface goes to zero.** Not "smaller" — the acknowledgment stops being a tree object, so it cannot conflict on a file, a key namespace, or a modify/delete. `--defer-to-open-prs` becomes unnecessary rather than merely correct.

**`next` can no longer be reddened by paperwork.** The guard that reds it is deleted along with the state it guards.

**The acknowledgment does not survive to `next`, and that is the point.** The repo allows squash, merge, and rebase (`allow_squash_merge`, `allow_merge_commit`, `allow_rebase_merge` all true; `squash_merge_commit_message: COMMIT_MESSAGES`), and `gsd-core/workflows/ship.md:306` treats per-commit trailers as not reliably surviving squash-merge. Under `COMMIT_MESSAGES` the text does concatenate into the squash body, but that is a mutable repo setting and a merger can edit the body, so **this ADR claims no durable audit record on `next`**. The acknowledgment is read during the PR, which is the only window in which it is meaningful. An earlier framing of this design claimed trailers were "permanent and auditable, same as today"; that claim was wrong and is withdrawn here rather than shipped.

**Amending an acknowledgment means amending a commit.** Editing a file is cheaper than rewriting history. This is a real ergonomic cost. It is also a correctness property: the acknowledgment cannot drift out of sync with the diff it explains, because changing either changes the sha and re-runs the gate.

**Review ergonomics change.** A reviewer reads the acknowledgment in the commit message rather than in a file diff. GitHub renders commit messages in the Commits tab, not inline in the Files tab — less prominent than a changed file. Mitigation: the gate's failure output already names its own remedy (`CONTRIBUTING.md:1074-1076`), and the trailer text appears in the PR's own commit list.

**Local runs work with no network.** `git log base..head` needs no API call, unlike a PR-label or PR-body scheme. This is why label-based and body-based designs were rejected: both are mutable after CI has run, both need an authenticated API call from the test, and a label is coarser than per-key prose — a blanket "excuse this PR" lets a genuine regression ride along.

## Revisit if

- Squash-merge stops preserving commit bodies **and** a durable on-`next` audit trail of acknowledgments turns out to be needed for something concrete. Nothing consumes one today.
- The trailer key space needs more than two members, which would suggest the attribution table (ADR-2719 §2) has a gap the escape hatch is absorbing.
- `fetch-depth: 0` on the `test` job measurably slows the PR lane.

## References

- ADR-2719 §3 and its #2789 Amendment — the design this supersedes
- #2789, #2914, #3078, #3823, #3842, #3875 — the six prior rounds
- [PR #3927](https://github.com/open-gsd/gsd-core/pull/3927) — the sweeper's first production run
- `docs/research/3875-ack-sweep-automation-failure.md` — full root-cause trace with line citations
- `gsd-core/workflows/ship.md:306-348` — in-repo precedent for trailer parsing
