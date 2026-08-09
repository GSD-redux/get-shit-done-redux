---
type: Added
pr: 3253
---
**Capability skills are now named at the install consent prompt** — installing a third-party capability whose only contribution was skills printed "ships no executable surfaces (declarative only)" and listed nothing, even though each `SKILL.md` body lands verbatim in your agent's instruction context. The pre-install disclosure now names every contributed skill in its own section and states plainly that the bodies are not content-scanned. Values interpolated into the prompt are escaped across every disclosed surface, so a crafted name can no longer forge additional lines of disclosure text. No stored consent is disturbed and no re-consent prompt fires. (#3248)
