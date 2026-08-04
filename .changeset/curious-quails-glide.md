---
type: Fixed
pr: 0
---
**Codex (and kimi/kimi-code) no longer attempt a depth-2 background orchestration their declared contract forbids** — `shouldFlattenDispatch` checked only the two background booleans, so a host advertising `maxDepth:1` (no room for a backgrounded orchestrator at depth 1 plus a delegated leaf at depth 2) was told it may background, producing a depth-2 tree under Codex MultiAgent V2. The decision now also requires `nested` + a full subagent toolkit + a depth budget > 1 (or unbounded), reusing the convention already in `degradationFor`/`_normalizeDispatchCallSpan`. Only cursor (`maxDepth:2`) remains background-eligible; codex/kimi/kimi-code now correctly run inline (the safer path that keeps worktree isolation + verification in force). (#2939)
