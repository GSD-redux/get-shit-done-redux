# Review and Verification Capabilities

This reference describes the Capability Registry declarations used by GSD review and verification features in GSD 1.5 and later. It covers the first migrated review/verification capabilities from ADR-857 Phase 6: code review, security enforcement, and Nyquist validation.

For the system design, see [ADR-857: Capability system](../adr/857-capability-system.md).

## Terms

**Capability**: A feature bundle declared in `capabilities/<id>/capability.json`. A capability owns skills, agents, config keys, and loop hooks.

**Loop Extension Point**: A named point in the Discuss -> Plan -> Execute -> Verify -> Ship loop where capabilities can register hooks.

**Step hook**: A hook that runs a capability skill as an ordered step.

**Contribution hook**: A hook that injects guidance into a core workflow prompt.

**Gate hook**: A hook that evaluates a predicate and can block when `blocking` is true.

## Capability Ownership

| Capability | Skills | Agents | Config keys |
|---|---|---|---|
| `code-review` | `code-review` | `gsd-code-reviewer`, `gsd-code-fixer` | `workflow.code_review`, `workflow.code_review_depth` |
| `security` | `secure-phase` | `gsd-security-auditor` | `workflow.security_enforcement`, `workflow.security_asvs_level`, `workflow.security_block_on` |
| `nyquist` | `validate-phase` | `gsd-nyquist-auditor` | `workflow.nyquist_validation` |

These keys are Capability-owned config keys. They remain valid for `.planning/config.json`, but they are not central schema keys; validation and defaults come from the generated Capability Registry. Workflows must not branch directly on the boolean activation keys. Workflows resolve activation by calling `gsd-tools loop render-hooks <point>`.

## Hook Map

| Point | Capability | Kind | Behavior |
|---|---|---|---|
| `plan:pre` | `security` | `contribution` | Adds threat-model guidance to planner context when security enforcement is active. |
| `execute:post` | `code-review` | `step` | Runs post-execution code review when code review is active. |
| `verify:post` | `security` | `step` | Runs security verification and produces `SECURITY.md` when security enforcement is active. |
| `verify:post` | `nyquist` | `step` | Runs validation coverage audit and produces `VALIDATION.md` when Nyquist validation is active. |
| `ship:pre` | `security` | `gate` | Blocks shipping unless `SECURITY.md` reports `threats_open: 0`. |

## Activation Rules

Workflows use the active hook list from the registry:

```bash
EXECUTE_POST_HOOKS_JSON=$(gsd_run loop render-hooks execute:post --raw)
VERIFY_POST_HOOKS_JSON=$(gsd_run loop render-hooks verify:post --raw)
```

The resolver evaluates each hook's `when` key against the project config and the capability config default. If the key is absent and the capability declaration default is `true`, the hook is configured on.

A hook is active only when both conditions are true:

- The Capability is enabled by the resolved Capability State: installed by `.gsd-profile` and surfaced by `.gsd-surface.json`.
- The hook is configured on by its `when` key.

Use the diagnostic state view to inspect the same answer the workflows consume:

```bash
gsd-tools capability state --config-dir ~/.claude --raw
```

In that output, `configured` reflects config/default resolution, while `active` reflects final participation after install and surface state. Disabling a migrated Capability at the runtime surface removes its active hooks even when the project config default is `true`.

Direct command workflows self-gate the same way:

- `/gsd-code-review` resolves the active `execute:post` hook whose `ref.skill == "code-review"`.
- `/gsd-secure-phase` resolves the active `verify:post` hook whose `ref.skill == "secure-phase"`.
- `/gsd-validate-phase` resolves the active `verify:post` hook whose `ref.skill == "validate-phase"`.

## Authoring Notes

When adding a review or verification capability:

1. Declare owned skills, agents, config keys, and hooks in `capabilities/<id>/capability.json`.
2. Use unprefixed skill stems in `ref.skill`; workflows add the `gsd-` prefix when invoking skills.
3. Declare `produces` and `consumes` arrays for every step and contribution hook.
4. Use `onError: "halt"` for verification work that must stop advancement when it fails.
5. Use a blocking `gate` for ship-time predicates that must prevent release.
6. Regenerate `gsd-core/bin/lib/capability-registry.cjs` with `npm run gen:capability-registry`.
7. Add tests that prove disabled hooks are absent from `loop render-hooks` output and that workflows do not branch directly on the capability's activation config key.

Do not add third-party code loading through a capability declaration. ADR-857 reserves that trust boundary for a separate design.
