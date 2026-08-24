---
type: Fixed
pr: 0
---
**Managed hooks now resolve the node binary at hook-fire time** — a config root shared across environments (WSL/Docker bind-mounts, mounted or synced `~/.claude`) no longer fails every managed hook with `node: not found` outside the machine that ran the installer, and updates from any environment converge stale runners instead of creating a mixed state where no environment works. `--portable-hooks` installs route through a staged `hooks/gsd-node-runner.sh` resolver (install-time path first, then `command -v node`, then well-known layouts); other installs carry an equivalent inline fallback chain. (#3662)
