---
type: Fixed
pr: 3097
---
**`/gsd` commands in Pi now display their output** — the command handler returned output as a bare string, which Pi's ExtensionAPI silently dropped. It now returns Pi's structured `{ content: [{ type: 'text', text }] }` display shape (matching the `gsd_invoke` tool's proven contract), so success output and error messages are visible. (#2991)
