---
type: Added
pr: 4497
---
**`workflow.compact_content` splits now have a real CI guard.** Any workflow spine + `detail/*.md` split is enforced forever: completeness once at split time, disjointness and registration on every PR, and protected content (guardrails, output-format contracts, few-shot examples, security language, machine-parsed headings) that can never leave the spine, moved or not. Ordinary content moves between spine and detail need a `Boundary-Move-Declared` commit trailer naming the spine, mirroring ADR-3942's emitted-drift-ack trailers. The partition rule and the protected-content list live in one place, `docs/PARTITION-RULES.md`. (#4403)
