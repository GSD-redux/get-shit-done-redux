# Compact Content Gate

Shared by every workflow spine split under ADR-4139. States the config check and the resolution rule once — a spine references this file; it never restates the check inline.

## The check

```bash
COMPACT_CONTENT=$(gsd_run query config-get workflow.compact_content --raw 2>/dev/null || echo "false")
```

## The resolution rule

- **`COMPACT_CONTENT` is `"false"` (default):** Read every part under this workflow's own `detail/` directory (a sibling of this spine, e.g. `gsd-core/workflows/<name>/detail/*.md`) now, in full, before continuing past this point. Their content elaborates on the spine you are reading — treat everything they say as part of this document from here on.
- **`COMPACT_CONTENT` is `"true"`:** Do not read the detail file. Continue directly with the spine's own content — per ADR-4139 Decision 3, it is complete enough to run this workflow correctly on its own.

## The fail-safe this exists to hold (ADR-4139 Decision 4)

A `Read` that does not fire for any reason (tool error, a skipped step, a misread condition) leaves you running on the spine alone. That is the same, correct, terser state an opted-in project runs in on purpose — never a state with no instructions. The spine's own completeness is what makes this safe; this gate is only ever additive.
