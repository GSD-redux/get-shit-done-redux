---
type: Fixed
pr: 0
---
parseDeferredItems now counts heading-delimited deferred items as ONE entry (a heading plus its descriptive sub-bullets) instead of one per bullet, across flat, container-heading, and mixed-depth files; headless one-bullet-per-item files are unchanged. A bolded `- **Status:** resolved` marker now resolves its item instead of surfacing as a bogus unresolved entry.
