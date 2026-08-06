# How to connect a host to the GSD companion MCP server

This guide shows you how to make a MCP-capable host (Claude Code, Codex,
OpenCode, VS Code, Antigravity CLI, Cursor, Cline, Hermes, Augment Code) drive
GSD — run GSD
commands and read/write `.planning/` state — through the companion MCP server,
with no bespoke plugin.

Once connected, three tools appear in the host alongside its others:
`gsd_invoke_command`, `gsd_read_state`, `gsd_write_state`. The server also
serves a read-only **catalog** of GSD's own content — workflows and
references as MCP resources, and the `/gsd-*` commands as MCP prompts — so a
host can browse and pull that content directly instead of shelling out to the
CLI. (For the tool contracts, see the reference section below; for *why* this
server exists and its trust model, see
[ADR-1239](../adr/1239-gsd-embeddable-orchestration-engine.md) and the
[capability trust model](../explanation/capability-trust-model.md).)

## 1. Add the server to your host's MCP config

The entry shape is the same everywhere; only the config file and key differ by
host.

```jsonc
{
  "gsd": {
    "command": "npx",
    "args": ["-y", "@opengsd/gsd-core", "gsd-mcp-server"],
    "cwd": "/abs/path/to/your/project"
  }
}
```

- **Claude Code / Codex / Cursor / Cline / Hermes** — under the host's
  `mcpServers` object (project or user config).
- **Augment Code** — under the `mcpServers` block of its own
  `settings.json` (not a standalone MCP config file, unlike Antigravity)
  — global at `~/.augment/settings.json`, project-local at
  `.augment/settings.json`. GSD's installer configures this entry
  automatically (`--augment` installs).
- **VS Code** — in the workspace MCP servers list.
- **Antigravity** — under the `mcpServers` block of its standalone
  `mcp_config.json` profile (not embedded in `settings.json`) — global at
  `~/.gemini/antigravity/mcp_config.json` (or the sibling
  `antigravity-ide`/`antigravity-cli` dir GSD resolved into), project-local at
  `.agents/mcp_config.json`. GSD's installer configures this entry
  automatically (`--antigravity` installs).
- **OpenCode** — under the `mcp` key (**not** `mcpServers`), in
  `~/.config/opencode/opencode.jsonc` (global) or `./opencode.json`
  (project). The entry shape also differs — see below.
- **Kilo Code** — an OpenCode fork; also under the `mcp` key (**not**
  `mcpServers`), in `~/.config/kilo/opencode.jsonc` (global) or
  `./opencode.json` (project). Same entry shape as OpenCode.

Set `cwd` to the project whose `.planning/` you want GSD to manage — the server
resolves state paths against it.

### OpenCode / Kilo entry shape

OpenCode (and Kilo, which shares OpenCode's config schema) use a
`type`/`command`/`timeout` entry under the `mcp` key instead of the generic
`command`/`args`/`cwd` form above:

```jsonc
{
  "mcp": {
    "gsd": {
      "type": "local",
      "command": ["npx", "-y", "@opengsd/gsd-core", "gsd-mcp-server"],
      "timeout": 10000
    }
  }
}
```

## 2. Restart the host

On startup the host performs the MCP `initialize` handshake. The response
advertises `tools`, `resources`, and `prompts` capabilities, so the three GSD
tools become callable and the host can also list the served catalog
(resources and prompts) described below. The server never advertises
`resources.subscribe` or `listChanged` — the catalog is fixed for the life of
the server process, so there is nothing to subscribe to.

## 3. Verify

Ask the host to read an existing planning file:

```jsonc
{ "name": "gsd_read_state", "arguments": { "path": "/abs/path/to/your/project/.planning/STATE.md" } }
```

It returns the file's contents. `gsd_invoke_command` takes
`{family, subcommand, args}` and returns the command-routing hub's structured
result (the same shape `gsd-tools` produces).

## 4. Browse the catalog (resources and prompts)

The server also exposes GSD's own content tree as MCP resources and the
`commands/gsd/*.md` command set as MCP prompts. This is additive: the
file-copy install (the default for every runtime) is unchanged, and the
catalog only adds a way for an MCP-capable host to read the same content
directly over the protocol.

### List and read a resource

List available resources (paginated — ask the host to follow `nextCursor`
until it is absent):

```jsonc
{ "name": "resources/list", "arguments": { "cursor": null } }
```

Each entry has a `gsd://<segment>/<relpath>` URI, where `<segment>` is
`workflows`, `references`, or `commands`, and `<relpath>` is the file's path
within that segment (for example, `gsd://workflows/plan-phase.md`,
`gsd://references/untrusted-input-boundary.md`, or
`gsd://commands/plan-phase.md`). Commands appear in both surfaces: read one as
a resource to get its raw markdown, or get it as a prompt to have the host
treat it as an invocable message. Read one by URI:

```jsonc
{ "name": "resources/read", "arguments": { "uri": "gsd://workflows/plan-phase.md" } }
```

An unknown or unrecognized URI (including any path-traversal or absolute-path
attempt) returns a JSON-RPC error rather than an empty or partial result.

### List and get a prompt

```jsonc
{ "name": "prompts/list", "arguments": {} }
```

Each entry is keyed by its bare command name — `plan-phase`, not a path. Get
one:

```jsonc
{ "name": "prompts/get", "arguments": { "name": "plan-phase" } }
```

An unknown prompt name returns a JSON-RPC error. `prompts/get` accepts an
`arguments` object but ignores it — no shipped command template takes
injected arguments today.

### Composed vs. verbatim content

Workflow resources (`gsd://workflows/…`) are served **composed** — with
`<!-- gsd:section -->` markers stripped — exactly as the installed file tree
gets them, while reference and command content is served **verbatim**, because
some reference and command docs use that marker syntax as a documented example
rather than a real marker.

## If something does not work

- **`command not found: gsd-mcp-server`** — invoke via `npx` as shown above, or
  install the package globally first (`npm i -g @opengsd/gsd-core`).
- **`gsd_read_state` fails with ENOENT** — the path is resolved literally; pass
  an absolute path under the project's `.planning/`.
- **The host lists no GSD tools** — confirm the server starts in isolation:
  `npx @opengsd/gsd-core gsd-mcp-server` then send an `initialize` request on
  stdin; it writes a `protocolVersion` response and exits on EOF.
- **You manage multiple projects** — register one `gsd` entry per project with a
  distinct name and `cwd`; the server is stateless across projects.

## Reference — the three tools

| Tool | Arguments | Returns |
|------|-----------|---------|
| `gsd_invoke_command` | `{family: string, subcommand: string, args?: unknown[]}` | the command-routing hub result (`{ok, …}`) as JSON text |
| `gsd_read_state` | `{path: string}` | the file contents as text |
| `gsd_write_state` | `{path: string, content: string}` | `{ok: true, path}` as JSON text |

Errors from a tool are returned as MCP tool errors (`isError: true`), not as
JSON-RPC protocol errors — the host surfaces them in its normal tool-failure UX.

## Reference — the served catalog

| Method | Arguments | Returns |
|--------|-----------|---------|
| `resources/list` | `{cursor?: string}` | `{resources: [{uri, name, title, description, mimeType}], nextCursor?: string}` |
| `resources/read` | `{uri: string}` | `{contents: [{uri, mimeType, text}]}` |
| `prompts/list` | `{}` | `{prompts: [{name, title, description}]}` |
| `prompts/get` | `{name: string, arguments?: object}` | `{description, messages: [{role: "user", content: {type: "text", text}}]}` |

Errors from the catalog (unknown URI, unknown prompt name, malformed cursor,
a refused path-traversal attempt) are returned as JSON-RPC protocol errors,
not MCP tool errors — unlike the three tools above.
