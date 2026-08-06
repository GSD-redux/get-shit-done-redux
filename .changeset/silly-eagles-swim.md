---
type: Security
pr: 3124
---
**A directory name containing `$(…)` or a backtick no longer becomes a live command in your shell startup file** — the PATH-persistence suggestion escaped its `export PATH="…"` line for the `echo` that carries it, not for the rc file it lands in, so a substitution in the target directory survived into `~/.bashrc` and ran on every new shell. (#3118)
