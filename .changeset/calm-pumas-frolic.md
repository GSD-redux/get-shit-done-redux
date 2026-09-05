---
type: Fixed
pr: 0
---
**`todo complete` honors `--dry-run` and stops corrupting frontmatter** — the flag was accepted and silently ignored (the todo was moved, exit 0, `completed: true` reported), and the `completed:` stamp was written above the opening `---` fence so no fence-locating reader could parse the archived file. `--dry-run` now prints a preview-shaped payload (`dry_run`/`would_*`) and touches nothing; a real completion upserts `completed:` and `status: completed` inside the frontmatter block, and unknown flags fail loudly instead of being dropped. (#4096)
