---
type: Fixed
pr: 2682
---
**OpenCode no longer declares background subagent dispatch it does not have** — `capabilities/opencode/capability.json` advertised `dispatch.background` and `dispatch.backgroundDispatch` as `true`, but OpenCode's native subagent dispatch is synchronous: the Task tool's `background` parameter is hidden from the model behind the opt-in `OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS` flag, which defaults to false, and the session loop still handles one subtask at a time. Since `negotiateHostCapabilities` and every `degradationFor` consumer trusts these per-field values, declaring an absent capability overstated it — the opposite of the fail-closed posture the negotiation exists to enforce. Both fields are now `false`, and the host-integration capability matrix carries the corrected values with current upstream citations. (#2598)
