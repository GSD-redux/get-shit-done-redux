---
type: Fixed
pr: 3095
---
**Local `lint:changeset` and `lint:docs-required` now diff against `next` instead of `main`** — the local fallback was the release branch (`main`), which lags far behind the integration branch (`next`), so the lint always passed by finding fragments from other already-merged PRs in the oversized diff range. The local invocation now matches the base CI uses. (#2988)
