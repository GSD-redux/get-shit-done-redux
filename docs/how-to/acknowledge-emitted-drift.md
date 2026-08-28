# How to acknowledge emitted-artifact drift

**Goal:** Get a red differential-attribution check to green when the ripple it found is deliberate — by declaring it in a commit trailer on your own branch, so nothing is left behind in the tree once your PR merges.

**Prerequisites:** A branch whose CI failed with an unattributable emitted-artifact delta, or with growth in a `gsd-core/workflows/*.md` or `agents/gsd-*.md` file. The failure output names the key and the space; you do not need to work either out yourself.

For why the acknowledgment lives in a commit rather than a file, see [ADR-3942](../adr/3942-emitted-drift-ack-commit-trailer.md). For the conservation law it is an escape hatch from, see [ADR-2719](../adr/2719-emitted-artifact-attribution.md). This guide covers only how to *declare* one.

---

## Pick the right key space

There are two, and they are separate namespaces. A trailer in the wrong one will not excuse anything — it will fail as an unused declaration instead.

| Your failure says | Trailer | Key |
|---|---|---|
| an emitted path's hash moved and your diff cannot explain it | `Emitted-Drift-Ack-Hash:` | the emitted path exactly as printed — always contains a `/` |
| a workflow or agent file grew | `Emitted-Drift-Ack-Growth:` | the **bare filename** as it appears under `gsd-core/workflows/` or `agents/` |

The failure output tells you which applies. If you are guessing, you have the wrong one.

## Declare it

The grammar is `<key> — <reason>`, split on the **first** ` — ` (space, em dash, space), so your reason may contain further em dashes.

On your next commit:

```bash
git commit --trailer "Emitted-Drift-Ack-Growth: explore.md — new dispatch section; the reasoning ships with the block"
```

On a commit you already made:

```bash
git commit --amend --trailer "Emitted-Drift-Ack-Hash: skills/gsd-add-tests/SKILL.md — converter rewrote every skill header"
```

Amending is the intended route, not a workaround. The trailer cannot drift out of sync with the diff it explains, because changing either changes the sha and re-runs the gate.

Write a real reason. "fix" or "expected" is not one — the reason is the whole artifact a reviewer reads, and an empty one is rejected.

## What happens next

Nothing, and that is the point. The trailer is read from `git log $(git merge-base <base> HEAD)..HEAD` — your commits and no others. Once your PR merges it is out of range by construction. There is no file to delete, no "spent" state to clean up, no shared key namespace to collide with, and no sweeper to wait for.

---

## Migrating from an ack fragment

If your branch predates ADR-3942 it may carry a `tests/emitted-drift-acks/*.json` fragment. That directory no longer exists on `next`, so you will meet a `modify/delete` conflict. Resolve it by moving the reason you already wrote into a trailer:

```bash
git rm tests/emitted-drift-acks/<yours>.json
git commit --amend --trailer "Emitted-Drift-Ack-Growth: <filename> — <the reason from your fragment>"
```

Use `Emitted-Drift-Ack-Hash:` instead if the fragment's key contained a `/`. A fragment that declared several keys becomes several trailers — one per key, and they may sit on the same commit.

---

## When it still fails

| The failure says | What it means | What to do |
|---|---|---|
| an acknowledgment nothing consumed | you declared a key, but no delta matched it | remove the trailer, or correct the key to name the ripple you actually made — the message names which space it was declared in |
| a key was declared twice with different reasons | two commits in your range declare the same key and disagree | keep one. Identical repeats are deduplicated silently; conflicting ones are ambiguous and refused |
| an invalid key | your key contains whitespace, `<`, or `>` | you probably pasted a placeholder from documentation. Use the real path or filename |
| the range is structurally uncomputable | the checkout has no common ancestor — typically a shallow clone | this is a CI configuration problem, not something a trailer fixes. The gate fails loudly here rather than reading your branch as having no acknowledgments |
| a new file over the size cap | `NEW_FILE_CAP` is deliberately **not** acknowledgeable | extract content instead — lazily, via `gsd-core/references/`. An eager `@`-import shrinks the file without shrinking loaded context, which games the guard while making the real cost worse |
