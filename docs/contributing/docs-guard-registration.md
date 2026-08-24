# Docs guard registration

A test that reads shipped `docs/` content and asserts on it must be registered so it actually
runs on the PR that changes those docs — otherwise it can only fail *after* merge, on the shared
branch. This page is the practical reference + how-to; the mechanics live in
[`scripts/docs-guard-registry.cjs`](../../scripts/docs-guard-registry.cjs),
[`scripts/select-docs-guards.cjs`](../../scripts/select-docs-guards.cjs), and
[`scripts/lint-docs-guard-registration.cjs`](../../scripts/lint-docs-guard-registration.cjs).

## The problem

`classify()` in [`scripts/ci-test-scope.cjs`](../../scripts/ci-test-scope.cjs) deliberately
normalizes a docs-only diff to an empty test list (from #764) — a PR that only touches `docs/`
is not expected to pay for the full suite. That is correct for the common case, but it means a
test whose *input* is shipped prose (it reads a `docs/*.md` file and asserts on its content) never
runs on the PR that edits that file. The regression is caught only when it lands on `next` and
some *other* PR's CI happens to touch code that reruns the full matrix — or not at all. That is how
`next` broke on `dacae9273`: a docs edit shipped with zero test coverage of its own change.

## The rule

A test file that reads shipped `docs/` content must do one of two things:

- be registered as a key in `DOCS_GUARD_TESTS` in `scripts/docs-guard-registry.cjs`, mapped to the
  `docs/` path patterns it reads, or
- carry a `// docs-guard-exempt: <reason>` header comment (in the file's first 20 lines) **and**
  have its basename listed in `DOCS_GUARD_EXEMPT_BASELINE` in
  `scripts/lint-docs-guard-registration.exempt-baseline.cjs`.

This is enforced by `scripts/lint-docs-guard-registration.cjs`, run via `npm run lint:ci`. A
docs-reading test file that is neither registered nor exempted fails the lint.

## How selection works

The registered guards are not all run on every docs PR. `scripts/select-docs-guards.cjs` maps the
PR's actually-changed `docs/` paths to the subset of `DOCS_GUARD_TESTS` that reads any of them, so
a one-line typo fix in one doc does not pay for every other registered guard. Each registry entry
is an array of patterns, and a pattern is one of three kinds:

- **Exact path** — `'docs/AGENTS.md'` matches that file only.
- **Trailing-slash directory prefix** — `'docs/adr/'` matches any changed path beneath it
  (`docs/adr/README.md`, `docs/adr/1703-....md`, …). The trailing slash is load-bearing: a changed
  path is compared with `startsWith('docs/adr/')`, so `docs/adrenaline.md` does **not** match
  `docs/adr/` — only a real path *under* that directory does.
- **`'*'`** — matches any docs/ change at all.

## Which to choose: register or exempt

Register the test when it asserts on the **content** of shipped prose — the test would need to
change (or would break) if the doc's wording, structure, or specific values changed. For example,
`tests/config-field-docs.test.cjs` reads `docs/CONFIGURATION.md` and asserts every config field
documented there matches the real schema — that is a content assertion, so it is registered.

Exempt the test when it touches `docs/` only incidentally: overlay/fixture input, a path
predicate, an existence check with no content assertion, or a scan-exclusion list. For example, a
test that calls `fs.existsSync('docs/something.md')` to confirm a file was created, without ever
reading or asserting on its contents, is exempt — nothing about registering it would catch a real
regression, because it never inspects the prose.

## Use `'*'` when the path cannot be resolved statically

Some tests walk `docs/` recursively, or build the path they read from a runtime-computed
variable rather than a fixed literal — `tests/context7-tool-name-parity.test.cjs` and
`tests/docs-parity-live-registry.test.cjs` are examples already in the registry, both mapped to
`'*'`. When a test's read cannot be pinned to a specific file or directory prefix, register it with
`'*'` rather than guessing a narrower pattern. A guessed-narrow pattern that misses the actual path
is worse than no registration at all: the guard silently stops running on exactly the PR that
should have triggered it, and nothing in CI signals the gap — that silent-gap failure mode is the
whole defect class this registry exists to prevent.

## Why the exemption is ratcheted

`DOCS_GUARD_EXEMPT_BASELINE` pins the known-good set of exemptions by file basename, the same
identity-ratchet pattern the repo already uses for the `// allow-test-rule:` marker (ADR-456). A
brand-new `// docs-guard-exempt:` marker that is not already in the baseline fails the lint, so
adding one is always a visible, reviewable diff — not a silent opt-out a test author can add
without anyone noticing. A baseline entry whose file no longer exists, or no longer carries the
marker, is reported stale and must be pruned in the same PR that removes it.
