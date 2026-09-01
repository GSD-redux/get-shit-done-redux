---
type: Added
pr: 0
---
**Workflow guard advisory output now carries a typed `code` field** — `gsd-workflow-guard.js`'s off-workflow-edit advisory now includes `code: 'WORKFLOW_ADVISORY'` alongside its existing `additionalContext` prose, distinguishing it from the hook's separate force-add block leg (`code: 'WORKTREE_AGENT_FORCE_ADD_FORBIDDEN'`) without substring-matching either message. (#3546)
