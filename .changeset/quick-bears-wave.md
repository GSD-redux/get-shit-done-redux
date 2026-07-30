---
type: Added
pr: 2837
---
**Reviewer lanes now ship as capability declarations** — the eleven cross-AI reviewer lanes are declared as manifest data instead of a half-derived, half-hardcoded roster. Five reviewers GSD never installs into (Gemini, CodeRabbit, Ollama, LM Studio, llama.cpp) become lane-only capabilities with no install surface, and the six hosts that are also reviewers gain a reviewer body alongside their runtime descriptor. `gsd capability list` shows the five new lanes. The roster itself is unchanged — the same eleven reviewers, derived rather than hardcoded — and `runtime.hostBehaviors.reviewerCli` keeps working for one release. (#2798)
