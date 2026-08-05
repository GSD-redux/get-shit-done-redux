---
type: Fixed
pr: 3087
---
**Workflow shell blocks no longer abort under zsh when a glob matches nothing** — an unmatched glob inside a `for` word list aborted the entire shell block under zsh (macOS default shell), silently bypassing every statement after it, including the verify-phase decision-coverage gate. Each affected bash block now enables nullglob portably (`shopt -s nullglob 2>/dev/null; setopt NULL_GLOB 2>/dev/null`) so an unmatched glob expands to nothing and the loop is skipped cleanly under both shells. (#2962)
