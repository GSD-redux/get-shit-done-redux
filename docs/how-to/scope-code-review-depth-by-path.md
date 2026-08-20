# How to scope code review depth by path

**Goal:** Escalate `/gsd-code-review` to `deep` for sensitive directories (auth, billing, payments) while the rest of the repository keeps reviewing at the project's normal default — without having to remember `--depth=deep` on every review that happens to touch one of those paths.

**Prerequisites:** A project with `/gsd-code-review` enabled (`workflow.code_review: true`). This guide assumes you already have a working default depth via `workflow.code_review_depth`; see [Configuration Reference](../CONFIGURATION.md#workflow-toggles) if you don't.

---

## The shortest working sequence

1. **Set the global default**, if you haven't already:

   ```bash
   gsd config-set workflow.code_review_depth standard
   ```

2. **Add path-scoped rules** to `workflow.code_review_depth_overrides` in `.planning/config.json`. It's an ordered array of `{ "paths": [...], "depth": "quick" | "standard" | "deep" }` objects:

   ```json
   {
     "workflow": {
       "code_review_depth": "standard",
       "code_review_depth_overrides": [
         { "paths": ["src/auth"], "depth": "deep" },
         { "paths": ["src/billing"], "depth": "deep" }
       ]
     }
   }
   ```

3. **Run the review** as usual:

   ```bash
   /gsd-code-review 12
   ```

4. **Read the provenance line** in the output to confirm which rule (if any) fired — see [Read the resolved-depth line](#read-the-resolved-depth-line) below.

---

## Worked example: escalate `src/auth` and `src/billing`, leave everything else at `standard`

With the config above, a phase that only touches `src/lib/formatter.ts` reviews at `standard` (no rule matches, falls through to the global default). A phase that touches `src/auth/token.ts` and nothing else in an escalated path reviews at `deep`, because a rule matched.

**Escalation is whole-review, not per-file.** If a phase touches both `src/lib/formatter.ts` and `src/auth/token.ts`, the *entire* review — including `formatter.ts` — runs at `deep`. Depth is a single scalar handed to the reviewer agent; one matched sensitive file is enough to raise the whole review, so a sensitive file is never reviewed shallowly because it shared a phase with unrelated code.

Matching is by **whole path segment**, not substring:

| Changed file | Matches rule `src/auth`? |
|---|---|
| `src/auth/token.ts` | Yes |
| `src/auth` (the file itself) | Yes |
| `src/authfoo/x.ts` | No — `authfoo` is a different segment |
| `docs/src/auth/x.ts` | No — prefix is anchored at the path root, not a substring search |

Matching is case-sensitive, following git: a rule written `Src/Auth` will not match `src/auth/x.ts`.

**Rules win over the global default, even when weaker.** If `workflow.code_review_depth` is `deep` but a matched rule says `quick`, the review runs at `quick` — the rule always replaces the global for files it matches. This is deliberate: if the strongest tier always won, a `quick` or `standard` rule could never actually take effect whenever the project default was `deep`, making it silently inert.

**Only globs are rejected — not the paths themselves.** `workflow.code_review_depth_overrides` supports directory-prefix strings only (`src/auth`, not `src/auth/**`). There is no glob engine in this project; write the prefix and let segment-aware matching do the rest.

---

## Read the resolved-depth line

Every review prints one line naming the resolved depth and why:

```
Review depth: deep (matched rule 0: src/auth)
```

The parenthetical names the source:

| Provenance text | Meaning |
|---|---|
| `from --depth flag` | The `--depth=` CLI flag was passed; it always wins over both rules and config. |
| `matched rule N: <path>` | Rule at index `N` (0-based, in declaration order) matched on prefix `<path>` and set the depth. |
| `from workflow.code_review_depth` | No rule matched this review's file set; the global config value was used. |
| `default` | Neither a rule, config value, nor flag applied; the built-in `standard` default was used. |

If the review scope exceeds 50 files and the resolved depth is `deep`, the existing large-scope downgrade still fires — but now it names the rule it overrode:

```
Switching from deep to standard depth for large file count (overrides matched rule 0: src/auth).
```

A configured sensitive-path policy is not exempt from this downgrade — the same guard that downgrades `--depth=deep` on a large scope also downgrades a rule-sourced `deep`.

---

## Nothing to report vs. could not look

Two outcomes look similar but mean opposite things:

- **A rule matches nothing.** This is not an error and is not reported specially — it means this review simply didn't touch any path the rule covers. The provenance line falls through to `from workflow.code_review_depth` or `default`, exactly as if the rule didn't exist. This is "nothing to report": the policy exists, was checked, and had nothing to say about this particular review.
- **The configuration is rejected.** This is "could not look": the review halts before doing any file-level work and prints every collected validation error. Never conflate the two — a validly-configured rule set with no match for this review is a healthy, silent no-op; a malformed rule set is a hard stop.

---

## Configuration error reasons

If `workflow.code_review_depth_overrides` is malformed, `/gsd-code-review` prints one error per defect (all of them, not just the first) and stops — it never silently falls back to a default depth. Errors report the reason as one of the following typed values (from `src/code-review-depth.cts`):

| Reason | Meaning | Fix |
|---|---|---|
| `not_an_array` | `workflow.code_review_depth_overrides` itself is not an array (object, string, number, `null`, etc.) | Set it to an array of rule objects, or `[]` to disable overrides. |
| `rule_not_object` | An entry in the array is not a plain object (a string, an array, `null`, `0`, etc.) | Each entry must be a `{ "paths": [...], "depth": "..." }` object. |
| `paths_malformed` | A rule's `paths` is missing, not an array, empty, or contains a non-string entry | Give `paths` a non-empty array of strings, e.g. `["src/auth"]`. |
| `invalid_depth` | A rule's `depth` is missing or not one of `quick`, `standard`, `deep` | Set `depth` to exactly one of `quick`, `standard`, or `deep`. |
| `glob_unsupported` | A rule path contains `*` or `?` (e.g. `src/auth/**`) | Use a directory prefix instead: `src/auth`, not `src/auth/**` or `src/auth/*.ts`. |
| `path_traversal` | A rule path contains a `..` segment | Remove the `..` segment; write a plain repo-relative prefix. |
| `path_absolute` | A rule path is absolute (`/src/auth`, `C:\src\auth`) | Use a path relative to the repo root: `src/auth`, not `/src/auth`. |
| `path_empty` | A rule path is empty, whitespace-only, or normalizes to empty or `.` | Give the path real content, e.g. `src/auth` rather than `""` or `"."`. |

Each printed error names the rule index (and, where applicable, the offending path or depth value) so you can find the exact entry to fix without guessing which rule in the array is broken.

---

## Related

- [Configuration Reference](../CONFIGURATION.md#workflow-toggles) — full schema for `workflow.code_review_depth_overrides` and `workflow.code_review_depth`
- [Feature Reference — Code Review Pipeline](../FEATURES.md#93-code-review-pipeline) — why escalation is whole-review and why v1 is prefix-only, not glob
- [`/gsd-code-review`](../COMMANDS.md#gsd-code-review) — command reference and the `--depth=` flag
- [docs index](../README.md)
