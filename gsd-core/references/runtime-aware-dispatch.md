# Runtime-Aware Subagent Dispatch (epic #2505 Phase 4 / #2508)

GSD workflows dispatch specialized subagents by role (planner, executor,
verifier, …). On **named-dispatch runtimes** (Claude Code, OpenCode, Cursor,
Cline, … — every runtime whose descriptor declares `hostIntegration.dispatch.namedDispatch: true`), the role name dispatches the named subagent directly.

On **built-in-only runtimes** (kimi-code — three built-in subagents only:
`coder`, `explore`, `plan`; no custom registration per
`moonshotai.github.io/kimi-code/en/customization/agents`), a GSD role name is
unknown and the dispatch must use the closest built-in.

## Resolution

Before dispatching a subagent by role, resolve the type for the current runtime
via the `resolve-dispatch-type` query. Pass the requested role name; the query
returns the name unchanged on named-dispatch runtimes and maps to the closest
built-in (`coder`/`explore`/`plan`) on kimi-code. The `|| echo` fallback
preserves named-dispatch behavior on older GSD installs that lack the query.

The persona rides `${AGENT_SKILLS_<ROLE>}` (Phase 3 / #2510) regardless of the
resolved type — on non-Claude runtimes with no `agent_skills` config,
`gsd_run query agent-skills <role>` returns the installed agent prompt as
the block. So a coder dispatch with the planner persona injected gives kimi-code
the planner's behavior in the coder built-in's process.

## Suffix → built-in map

| Agent role suffix | Built-in | Rationale |
|---|---|---|
| `-planner`, `-roadmapper`, `-selector`, `-spec` | `plan` | Plans/designs; no file writes |
| `-researcher`, `-mapper`, `-checker`, `-verifier`, `-auditor`, `-analyzer`, `-synthesizer`, `-profiler`, `-curator`, `-classifier`, `-reviewer` | `explore` | Read-only investigation |
| everything else (`-executor`, `-fixer`, `-writer`, `-debugger`, …) | `coder` | General-purpose with full tool set |
| `general-purpose`, `general`, `default`, `sonnet`, `opus`, `haiku` | `coder` | Already-generic names |

## Why not a hook?

Kimi Code's documented PreToolUse hook API
(`moonshotai.github.io/kimi-code/en/customization/hooks`) supports only
`permissionDecision: allow|deny` on blockable events — it cannot rewrite the
dispatch payload's role field in flight. A PreToolUse-remap hook (the epic's
original "Option B") is therefore infeasible; this per-dispatch resolution
(Option A) is the documented-API-correct path.
