---
type: Fixed
pr: 3527
---

**MemPalace sub-features whose defaults are enabled now run when their config keys are absent** — the earlier `capture_artifacts` absent-key fix (#2982) had been applied to only one of six hand-written config gates; the remaining gates for `mempalace.mirror_kg` (knowledge-graph mirroring in the capture and recall skills, their command mirrors, and the curator agent) and `mempalace.diary_journal` (per-agent diary entries at ship) still required the key to be explicitly present and `true`, so a project that enabled MemPalace without writing every sub-toggle silently never mirrored KG facts or wrote diary entries, with no warning. All six gates now treat an absent key as enabled (matching the capability registry's declared `default: true`) and disable the behavior only on an explicit `false`; default-off switches (`mempalace.enabled`, `cross_project_tunnels`) still require explicit opt-in, and a registry-parity regression test keeps future default-true keys from reintroducing the inversion. (#3479)
