---
type: Fixed
pr: 4500
---
**Verification examples no longer tell agents to grep .env files** — `verification-patterns.md` and `user-setup.md` documented reading `.env`/`.env.local` directly to verify environment variables, which every covered runtime's secret-read guard denies. The environment-variable checks now read the environment (`printenv`) instead of the file, and a broken placeholder-filter regex (`grep -v "a|b|c"`, where `|` is a literal BRE character) is replaced with a working case-insensitive check. (#4440)
