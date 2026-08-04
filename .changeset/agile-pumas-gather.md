---
type: Changed
pr: 3058
---
**Agent definitions now share the workflow fragment pipeline** — a `<!-- gsd:section -->` marker in an `agents/*.md` file is stripped at install time on every emission path instead of shipping verbatim into the runtime, and the largest agents move their reference material into `gsd-core/references/` so they regain headroom under their size caps. (#2995)
