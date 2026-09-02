---
type: Changed
pr: 4163
---
**`roadmap analyze`, `gap-checker`, and `init`'s JSON output now distinguish an unreadable phase directory from a genuinely empty one** — a new `context_scope`/`phase_dir_scope` field (`'complete'` or `'unreadable'`) sits alongside the existing `has_context`/`context_read_error` fields, so a permission or I/O failure reading a phase directory is no longer indistinguishable from a phase that simply has no context file yet. `init manager`'s previously-silent read failure (a bare empty catch) now surfaces the same signal. (#4014)
