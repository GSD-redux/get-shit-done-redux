---
type: Changed
pr: 3600
---
**Agent files now install identically whether you run a full install or apply a surface.** Every runtime materializes its agents from its capability descriptor, so `/gsd-surface --materialize` no longer skips agent files for Cline, Codex, Hermes, Kilo, OpenCode and Kimi Code — previously it wrote none for those runtimes, leaving an install missing the agents a fresh install would have created. Installed output is byte-identical to before for every runtime. (#2866)
