---
type: Fixed
pr: 3063
---
**Dispatch flattening now honors the declared nesting depth budget, so runtimes that cannot host a backgrounded orchestrator plus a delegated leaf run inline instead of producing an unsupported depth-2 tree** — `shouldFlattenDispatch` checked only the two background booleans, so a host advertising `maxDepth:1` was told it may background, which under Codex MultiAgent V2 produced a depth-2 orchestration tree the declared contract forbids. The decision now also requires `nested` + a full subagent toolkit + a depth budget greater than 1 or unbounded, reusing the convention already in `degradationFor` and `_normalizeDispatchCallSpan`. Runtimes lacking any of those — codex at `maxDepth:1`, kimi with `nested:false`, kimi-code with a built-in-only toolkit — now correctly run inline, the safer path that keeps worktree isolation and verification in force; only cursor remains background-eligible. (#2939)
