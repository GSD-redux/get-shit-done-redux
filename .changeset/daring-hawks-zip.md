---
type: Fixed
pr: 4358
---
**`milestone_name` no longer corrupts to ")" for a first-milestone ROADMAP whose H1 puts the version after the name** — a punctuation-only heading remainder (e.g. the closing paren of `# Roadmap: Project — Name (v1.13)`) is refused as a name, so `init.*` output reports `null` instead of garbage, and the roadmapper agent now templates the canonical version-free H1. (#4134)
