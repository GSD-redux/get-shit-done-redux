---
type: Changed
pr: 2861
---
**Cross-AI reviewer lanes are now declared data rather than hand-written per-CLI blocks** — every lane's binary, prompt and output channel, timeout, probe and empty-output policy comes from its capability manifest, so a reviewer can be shipped as a plugin instead of a core patch. Two user-visible consequences: a reviewer that returns only whitespace is now reported as a failed lane on every reviewer (previously only on LM Studio and llama.cpp, so elsewhere a blank reply was rendered as a clean review), and an OpenAI-compatible lane whose configured host has changed since you consented to it is blocked with an explanation rather than silently sending your plans to the new destination. `jq`, `curl` and GNU `timeout` are no longer required on PATH for any lane. (#2782)
