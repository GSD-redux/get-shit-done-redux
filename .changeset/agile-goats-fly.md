---
type: Added
pr: 3083
---
**MCP-capable hosts can now browse GSD's own workflows, references, and commands through the companion server** — the workflow and reference tree is served as MCP resources and the `/gsd-*` commands as MCP prompts, so a host lists and fetches just the content it needs instead of relying on the copied file tree alone. Workflow resources arrive composed exactly as the installer writes them; the file-copy install is unchanged and stays the default on every runtime. (#3072)