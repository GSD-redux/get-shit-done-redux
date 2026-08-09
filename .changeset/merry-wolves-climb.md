---
type: Fixed
pr: 3249
---
**Capability skill bodies are now documented as an instruction surface** — the capability trust model previously grouped skills with inert assets as "non-executable" surfaces whose consent is lighter *because they do not execute code*. A skill body does not execute code; it instructs the agent that does. The docs now state that a capability's SKILL.md bodies reach your agent's instruction context verbatim and are not content-scanned, and capability authors are told the same on the authoring side. No behavior changed and no existing consent was invalidated. (#3247)
