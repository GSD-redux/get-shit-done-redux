---
type: Security
pr: 3506
---
**`verify key-links` no longer reads files outside the project** — `from:` and `to:` were taken verbatim from plan frontmatter and resolved with `path.join(cwd, …)`, which normalizes `../` rather than rejecting it, so a plan carried in an untrusted repository could name any file the process could read and learn from the reported result whether a supplied pattern matched its contents. Both paths now resolve through the project's realpath-based confinement seam; a path that escapes is refused without being read, reported as `path_rejected`, and never counts as verified. (#3493)
