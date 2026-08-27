---
id: 3897
title: Runtime Marker Resolution, Derived Codex Sandbox, and In-Phase Short-Form Dependencies
group: v1.7.0 Features
---

**Purpose:** ADR-3473 §8.3 states the rule directly — one implementation per
invariant, not a hand-maintained copy that quietly drifts from the rule it
stands in for. This closes three instances across `gsd-tools`: a resolver
that never read the install-time signal it was documented to read, a
Codex sandbox map that was fully redundant with the tool contract it stood
in for, and a dependency-resolution tier lost when the SDK lineage was
retired.

**A non-Claude install now resolves its own runtime with no config
needed (#3897).** `resolveRuntime`'s ladder was `GSD_RUNTIME` env var →
project `config.runtime` → `'claude'` — the per-install `.gsd-runtime`
marker the installer has written beside `VERSION` since #2297 was read by
four separate hand-rolled copies (`model-resolver.cts`, and two more inside
`gsd-cursor-subagent-start.js`), but never by `resolveRuntime` itself. A
Codex, Cursor, or other non-Claude install with no `GSD_RUNTIME` set and no
`runtime` key in `.planning/config.json` therefore still resolved `claude`
everywhere `resolveRuntime` is consulted (slash-command style, `query
teams-status`, `validate agents`'s agent-directory selection, and 19 other
call sites). The marker is now the third rung — `GSD_RUNTIME` → `config.runtime`
→ install marker → `'claude'` — so those installs resolve their own runtime
by default. The marker's contents are never trusted verbatim: they are routed
through the same name-normalization the env rung already uses, so a marker
holding an unexpected or hostile value degrades exactly like an unexpected
`GSD_RUNTIME` value would.

**Codex sandbox permissions are derived from each agent's own tool contract,
not a hand-maintained map (#3897).** `generateCodexAgentToml` looked up
`sandbox_mode` in an 11-entry `CODEX_AGENT_SANDBOX` map, falling back to
`read-only` — silently — for every role the map didn't name. Measured against
all 35 shipped roles, the map's 11 entries agree with deriving `sandbox_mode`
from each role's declared `tools:` frontmatter (`workspace-write` when it
declares `Write` or `Edit`, `read-only` otherwise) with **zero disagreements**,
so the map is deleted rather than clamped. The fallback, however, was
under-granting: 16 of the 24 roles that hit it declare `Write`/`Edit` and
would derive `workspace-write`. Pending a decision on whether Codex actually
enforces `sandbox_mode` (a question the derivation can't answer on its own),
those 16 are held at `read-only` by an explicit, self-invalidating hold
list — a hold whose role no longer derives broader, or that names a role
that no longer exists, fails loudly instead of being silently honored.
**Every one of the 35 emitted `.toml` files is byte-identical to before this
change** — the fix is in provenance (an explicit, reviewable rule instead of
a silent default), not in any installed agent's actual permissions today.

**`validate agents` now reports Codex sandbox drift (#3897).** A new
`sandbox_posture` field — report-only, exit 0, same shape as the existing
`codex_posture` — flags any installed Codex `.toml` whose `sandbox_mode`
disagrees with what its role's tool contract derives. Populated only when
the active runtime is `codex`.

**`depends_on` accepts the bare plan number (#3897).** A plan's frontmatter
could already reference a dependency by its full id (`"03-01-auth-hardening"`)
or its canonical phase-plan prefix (`"03-01"`). A third form — the bare
plan number alone (`"01"`) — existed in the retired SDK lineage but was lost
when that lineage was consolidated; a plan written with it silently dropped
the edge entirely, collapsing into wave 1 regardless of its declared
dependency. That form is restored, scoped to the **same phase only**: `"01"`
resolves to the sibling plan whose canonical id ends `-01`. This is an
observable behavior change — a phase whose plans used the bare form and had
silently collapsed into a single wave will now execute in its actual declared
waves. Two plans in the same phase sharing a bare form resolve first-write-wins,
by sorted plan-file order — deterministic, but arbitrary where the collision
happens, matching the retired behavior exactly.

**Known limits:**
- The 16 held Codex roles are pinned at `read-only`, not widened. A faithful
  derivation from the tool contract would widen them, because they declare
  `Write` or `Edit`; the previous hand-maintained map never listed them and
  they fell through a silent `|| 'read-only'` default instead. Deriving *and*
  holding keeps emitted TOML byte-identical for all 35 roles today while the
  derivation becomes the single owner of the rule. Widening them is a follow-up
  once Codex's actual enforcement of `sandbox_mode` is confirmed — until then a
  hold is reversible and a widened sandbox is not. The hold list is
  self-invalidating: an entry naming a role that no longer derives broader, or
  that has no file in the shipped roster, fails rather than rotting into the
  subset map this change deletes.
- The bare plan-number form is ambiguous by construction across two plans in
  the same phase that share a short form; first-write-wins is deterministic
  but not a conflict warning. Prefer the full or canonical id when a phase's
  plan numbering risks a short-form collision.
- The install marker never feeds model-tier resolution (`model_profile_overrides`,
  `model_policy.runtime_tiers`) — that still reads `config.runtime` alone, and
  reporting-only host detection (`agent_runtime`) is a separate, pre-existing
  ladder this change does not touch.
