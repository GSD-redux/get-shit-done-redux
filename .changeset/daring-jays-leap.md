---
type: Changed
pr: 3941
---
**Non-Claude installs now resolve their own runtime by default, and `depends_on` accepts the bare plan number.** A Codex, Cursor, or other non-Claude install with no `GSD_RUNTIME` set and no `config.runtime` key previously still reported `claude` everywhere, because the per-install runtime marker the installer writes was read by four hand-rolled copies but never by `resolveRuntime` itself; it is now the third precedence rung. Separately, `depends_on: ["01"]` now resolves to the in-phase sibling plan instead of silently dropping the dependency and collapsing the plan into wave 1 — a phase that previously ran all its plans in a single wave now executes in its declared waves. Codex sandbox permissions are also now derived from each agent's own tool contract instead of a hand-maintained map, and `validate agents` reports any drift via a new `sandbox_posture` field; both are byte-identical to today's behavior. (#3897)
