---
type: Added
pr: 0
---
**A plan that declares a file removal can now be merged by cleanup-wave** — add a `files_deleted:` list to a plan's frontmatter and the post-wave deletions guard authorizes exactly those paths, so a refactor that folds one file into another stops needing a manual merge outside the tool. Anything the plan did not declare still blocks that entry, and only that entry. Plans and manifests without the field behave exactly as before. (#3003)
