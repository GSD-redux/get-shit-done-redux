---
type: Fixed
pr: 2838
---
**test:/chore:/ci:/docs:/refactor:/perf:/revert: PRs no longer publish under the user-facing Enhancement heading in release notes** — the release-notes classifier now routes recognized non-user-facing conventional-commit types to an Internal bucket and omits them from the published GitHub release notes (and the Discord announcement's user-facing sections). Previously these internal-work PRs rendered as Enhancements alongside genuinely user-facing changes. feat:/fix: classification is unchanged, and untyped or anchor-defeated titles still fall back to Enhancement.
