---
type: Security
pr: 3032
---
**Production dependency tree is clear of known advisories** — three transitive packages reached by `@anthropic-ai/claude-agent-sdk` carried published advisories: `fast-uri` (host confusion via a backslash authority introducer), `ip-address` (three SSRF / trust-boundary bypasses via leading-zero octets, CIDR-suffix suppression, and IPv4-mapped address misclassification), and `hono`. All three are lockfile-only, semver-in-range updates. (#2755)
