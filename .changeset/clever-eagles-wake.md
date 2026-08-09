---
type: Added
pr: 0
---
**Capability skills and agents are now named at the install consent prompt** — installing a third-party capability whose only contribution was skills printed "ships no executable surfaces (declarative only)" and listed nothing, even though each `SKILL.md` body lands verbatim in your agent's instruction context. The pre-install disclosure now names every contributed skill and agent in its own section and states plainly that the bodies are not content-scanned. No stored consent is disturbed and no re-consent prompt fires. (#3248)
