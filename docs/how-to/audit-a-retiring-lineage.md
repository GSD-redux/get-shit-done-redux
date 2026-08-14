# Audit a retiring lineage (behavior carry-forward)

**You need this if** your PR deletes a module, package, or runtime lineage — and any part
of the deleted side has a surviving counterpart in the tree. The merge gate
([CONTRIBUTING.md → "Deleting a module that has a surviving counterpart"](../../CONTRIBUTING.md))
requires the PR to carry a symbol-level disposition table. This page is the calibrated
method for producing that table. It was first run against the ADR-0174 SDK retirement
and found three confirmed losses after the fact (#3484); run it *before* the deletion
merges and those losses become review findings instead of production bugs.

## Why "the tests pass" proves nothing here

The surviving tests belong to the surviving side. They were written against the
surviving implementation and pass before, during, and after the deletion — including
when the deleted side carried an invariant the survivor never had. ADR-3524 existed
precisely because the two sides had already drifted in nine known places; deleting one
side without enumerating it is choosing the survivor's omissions by default.

## The audit, step by step

All commands run against `<parent>` — the last commit **before** the retirement (for the
SDK retirement this was `04b3be683`, the parent of the retiring commit).

### 1. List the deleted source files

```bash
git ls-tree -r --name-only <parent> -- sdk/src
```

172 files for the SDK run. Everything under the deleted root is a candidate; test files
are excluded from pairing (they are the deleted side's claims, not its behavior).

### 2. Pair each file with a surviving counterpart

Pair by **basename**: `sdk/src/query/phase.ts` ↔ `src/phase.cts`. For the SDK run this
yielded 22 paired modules. Files with **no** counterpart are whole surfaces deleted on
purpose — list them in the disposition as one `dropped because …` line each (or grouped
by surface), but they are out of scope for symbol diffing.

### 3. Diff *declared* names, not raw tokens

Strip comments from both sides, then diff the declared names (functions, constants,
types — exported or local). **Do not tokenize the raw text**: raw token diffing matches
prose in comments and produced ~500 false positives on the first SDK run.

### 4. Normalize rename conventions before reporting

The two lineages used different naming conventions. Normalize before diffing:

| Deleted-side name | Surviving-side convention |
|---|---|
| `verifyX` | `cmdVerifyX` |
| `preserveExistingProgress` | `shouldPreserveExistingProgress` |

Skipping this step is what makes the raw diff unreadable — every convention-renamed
symbol reads as a loss.

### 5. Rank what remains by shape

**SCREAMING_CASE constants are the high-signal class.** That is where policy lives
(bounds, limits, tiers, thresholds), and both real losses the SDK audit confirmed were
bounds (`regexForKeyLinkPattern`'s 512-char cap; `MAX_JSON_SEARCH_DEPTH = 48`). Local
variable renames are noise — summarize them.

### 6. Positive control — mandatory

Before trusting the audit, verify it **re-detects a known loss**. For the SDK lineage the
control is `shortFormToId` — a *local* `const` inside a surviving function at
`sdk/src/query/phase.ts:609`, not an export. An export-only scan misses it entirely and
reports a clean bill of health; a calibrated run finds both halves of #3427 (the tier
`shortFormToId` and the diagnostic `unresolvedDeps`). If your audit method cannot find
the control, it is not calibrated — fix the method, do not ship the table.

### 7. Write the disposition table into the PR

One row per name that survived steps 3–5: `migrated` (name the location), `renamed → X`,
or `dropped because Y`. Unpaired whole surfaces get their own grouped `dropped because`
rows. The table goes in the PR body where the reviewer of the deletion will see it.

## Reading the result honestly

- **No losses found** means the audit found none — with the method calibrated by the
  positive control. It is evidence, not proof; say which control you ran.
- **A "migrated" claim you cannot point at** is a loss wearing a disposition. Every
  `migrated` row names a file or symbol in the surviving tree.
- The audit is run **once per retirement**, against that retirement's parent commit —
  it is not a standing CI job. Its value is the moment before the deletion merges.

## Reason codes at a glance

| Code | Meaning |
|---|---|
| `migrated` | Behavior exists at a named location in the surviving tree |
| `renamed → X` | Same behavior under the surviving convention's name |
| `dropped because Y` | Deliberate deletion, reason stated |
| *(nothing — no issue)* | Not tracked. A gap that matters gets an issue; a comment or changeset note dies with the code it annotates (`clever-yaks-cheer.md` → #3427) |
