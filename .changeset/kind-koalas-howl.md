---
type: Fixed
pr: 2950
---
**Malformed predicate declarations are now reported instead of silently dropped.** A doubled-dot id, a space in an id, a lowercase-leading class, and a value with an embedded CR/LF are each surfaced as a distinct `malformed` diagnostic reason instead of vanishing with no trace; the example parser (examples/dynamic-context-management/) was also brought back into parity with production and its own index is now drift-guarded by a new lint script. (#2944)
