---
type: Changed
pr: 2958
---
**Budget-aware content composition is now a shared `context-composer` seam** — the priority-ordered trimming that kept cross-AI review prompts inside a model's context window was locked inside that one pipeline. It is now a reusable seam with an injectable budget unit, so later work can right-size what ships to each runtime. Review-prompt output is unchanged, proven byte-for-byte against a 50-case corpus captured from the previous implementation. (#2929)
