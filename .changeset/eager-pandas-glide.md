---
type: Changed
pr: 3633
---
**Fallow binary resolution now shares the platform seam** — resolving the fallow binary uses the same PATH/PATHEXT logic as every other spawn, so on Windows a `fallow.cmd` shim resolves correctly and an extensionless npm shim is no longer picked up in its place. `node_modules/.bin` is still searched before `PATH`, and the POSIX executable-bit check is unchanged. (#3618)
