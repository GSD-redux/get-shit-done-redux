---
type: Fixed
pr: 2963
---
**Research agents no longer call a context7 tool that doesn't exist** — four shipped docs instructed agents to call `mcp__context7__get-library-docs`, a tool the context7 MCP server does not register (it exposes only `resolve-library-id` and `query-docs`). Every research workflow that loaded the canonical doc-lookup reference either errored, fell back to the `ctx7` CLI, or fabricated a result. All sites now name `query-docs` with the registered `libraryId`/`query` params, the CLI-fallback rationale now describes the real project-scoped `.mcp.json` mechanism, and a parity guard fails the build if the banned name returns. (#2943)
