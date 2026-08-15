---
type: Fixed
pr: 0
---
**Corrected `model-profiles.md`: `model` and `effort` do not resolve through one shared precedence ladder** — the reference previously claimed a `models[phase_type]` or `dynamic_routing` override flips both, and that an effort config change takes effect like a model change. In reality effort (claude runtime) is baked into agent frontmatter at install time and requires `node gsd-tools.cjs effort sync --apply` to change; Codex agents pin `model_reasoning_effort` in generated `.toml` files. (#3530)
