---
type: Fixed
pr: 2846
---
**Cursor, Windsurf, and Codex hooks no longer fail with `require is not defined` under an ESM config root** — GSD now writes the `{"type":"commonjs"}` marker into the hooks directory alongside the staged `.js` scripts for these three runtimes (it already did for every other runtime), so Node loads them as CommonJS regardless of the runtime config's `"type"`. (#2717)
