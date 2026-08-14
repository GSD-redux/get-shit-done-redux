---
type: Fixed
pr: 0
---
Cross-AI reviewer lanes now run on Windows: the declared bare CLI name is resolved through one shared PATH+PATHEXT lookup before spawning, so npm-installed .cmd/.bat shims start via cmd.exe mediation instead of failing with spawn ENOENT (#3275).
