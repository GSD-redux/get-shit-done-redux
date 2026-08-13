---
type: Changed
pr: 3407
---
**`validate consistency`'s `warnings` are now coded diagnostics** — each entry is a `{code, message, fix, repairable}` object instead of a bare string. Findings that overlap with `validate health` (a phase in ROADMAP.md with no directory on disk, or vice versa) now carry the exact same `W006`/`W007` codes `validate health` already uses for them, so there's one vocabulary for that finding, not two. The four subjects unique to this command (phase/plan numbering gaps, orphan summaries, plans missing `wave` frontmatter) get a new `C001`-`C004` code range.
