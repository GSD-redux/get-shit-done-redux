When you need library or framework documentation, check in this order:

1. If Context7 MCP tools (`mcp__context7__*`) are available in your environment, use them:
   - Resolve library ID: `mcp__context7__resolve-library-id` with `libraryName`
   - Fetch docs: `mcp__context7__query-docs` with `libraryId` (the ID from step 1) and `query`

2. If Context7 MCP is not available (custom subagents cannot see project-scoped
   `.mcp.json` servers — they only inherit user-scoped `~/.claude/mcp.json`, so a
   context7 server configured at the project scope is invisible to spawned
   agents), use the CLI fallback via Bash:

   Step 1 — Resolve library ID:
   ```bash
   if command -v ctx7 &>/dev/null; then
     ctx7 library <name> "<query>"
   else
     echo "ctx7 not found — install with: npm install -g ctx7 (verify at npmjs.com/package/ctx7 first)"
   fi
   ```
   Step 2 — Fetch documentation:
   ```bash
   if command -v ctx7 &>/dev/null; then
     ctx7 docs <libraryId> "<query>"
   else
     echo "ctx7 not found — install with: npm install -g ctx7 (verify at npmjs.com/package/ctx7 first)"
   fi
   ```

Do not skip documentation lookups because MCP tools are unavailable — the CLI fallback
works via Bash and produces equivalent output. Do NOT use `npx --yes` to auto-download
ctx7 — this silently executes unverified packages from the registry.
