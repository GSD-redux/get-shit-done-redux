# Response-language coverage

Every workflow file must instruct the model to honour `response_language` in the prose a user
reads. `npm run lint:response-language` (chained into `npm run lint:ci`) enforces it across the
whole catalog. This page is the how-to and the rationale; the mechanics live in
[`scripts/lint-response-language-coverage.cjs`](../../scripts/lint-response-language-coverage.cjs)
and its suite,
[`tests/response-language-coverage.test.cjs`](../../tests/response-language-coverage.test.cjs).
The shipped requirements are REQ-LANG-01..04 in
[`docs/features/response-language-config.md`](../features/response-language-config.md).

## The problem this gate exists for

A directive worded around *questions, prompts, and explanations* covers the answer and leaves the
running commentary in English. The user then reads a translated answer wrapped in English status
updates, progress notes, and findings — which is the defect #2529 reports, not a stylistic
preference. Before this gate, 44 workflows carried exactly that wording and the older lint
certified it as coverage, so the gate was legitimising the bug it was meant to catch.

Hence the discriminator: a directive counts only if it **names the narration class**. Naming means
the word `narration` or the phrase `between tool calls`. Enumerating members of the class — status
updates, progress notes, findings — without naming the class does not satisfy it, because the
enumeration reads as a closed list and the class is open (REQ-LANG-04).

## The four coverage forms

| Form | What it looks like | When it applies |
|---|---|---|
| Shared reference | `@~/.claude/gsd-core/references/response-language-directive.md` on its own line | The file is loaded eagerly — a top-level workflow. Preferred: one place to maintain the wording for the 42 files that take it. |
| Own inline directive | One line carrying the directive in the file's own words | The file already has one, or its prose needs local phrasing. Must pass all four predicates (below). |
| Pinned inline directive | The canonical line, byte for byte | A lazily-loaded mode/step/template that **cannot prove inheritance**. |
| Inherited | nothing in the file itself | A fragment whose parent workflow dispatches it from a read/execute context and is itself covered. |

### Which form to use

Answer in this order:

1. **Is the file loaded eagerly?** Take the shared reference. An `@`-line is expanded when the file
   is loaded, so this is the cheapest correct answer for a top-level workflow.
2. **Is it a fragment under `<workflow>/{modes,steps,templates}/`?** Then check whether
   `<workflow>.md` dispatches this exact path from a read/execute context *and* is itself covered.
   The catalog writes that stub two ways — rooted at `gsd-core/workflows/`, or relative to the
   catalog — and either one counts; a path with no read/execute/run verb ahead of it on the same
   line is a mention, not a dispatch, and proves nothing.
   If both hold, the fragment **inherits** — add nothing. The parent's directive is already in the
   loaded context by the time the fragment is read, so a second copy buys no coverage and gives the
   wording somewhere to drift.
3. **Otherwise the fragment carries the pinned line**, and its path joins
   `EXACT_INLINE_DIRECTIVE_WORKFLOWS` in the lint. Do not reach for the `@`-reference here: an
   `@`-line inside a file that is itself read later is inert — it is text at that point, not an
   import.

Rule 2 decides the set in rule 3, and the suite enforces the boundary in both directions: a pinned
path that would have inherited fails
`a pinned workflow is one that could not have inherited instead`.

### The pinned line

```
Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.
```

Byte for byte, on its own line. A pinned file may also switch to the shared reference if it ever
becomes eagerly loaded — that is strictly better and the lint accepts it.

## What an inline directive must contain

A single line must satisfy four independent predicates:

1. the token `response_language`,
2. an action verb — apply, use, present, translate, …,
3. a user-output noun — prose, output, questions, findings, …,
4. the narration class — `narration` or `between tool calls`.

All four on **one** line. The check is textual, not semantic: it reads vocabulary, not polarity.

## When the lint reds

| Message | What to do |
|---|---|
| `N workflow(s) have no response-language coverage` | Pick a form from the table above for each listed path. |
| `N shared directive reference(s) no longer carry an actionable directive` | The reference itself was weakened. Fix the reference — one edit re-covers every file that imports it. |
| `cannot read the workflow directory` / `no workflow files found under` | Discovery failed. The lint fails closed on purpose: a run that inspected zero workflows cannot establish coverage. |

Run it locally before pushing:

```
npm run lint:response-language
```
