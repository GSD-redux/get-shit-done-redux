# TDD-applicability resolution (#4266/#4272)

Run for each plan, immediately after executor routing and before composing
that plan's `Agent()` prompt in step 3. Resolves whether this dispatch is TDD
— fail closed, do not guess.

## Resolution

```bash
TDD_APPLICABLE=$(gsd_run query phase.tdd-applicable "{phase_dir}/{plan_file}" --pick applicable 2>/dev/null)
if [ $? -ne 0 ]; then
  echo "FATAL: could not resolve TDD-applicability for plan {plan_number} — 'gsd_run query phase.tdd-applicable' failed. Refusing to guess whether this dispatch needs the TDD procedure. Halting." >&2
  exit 1
fi
```

## Pre-dispatch check (MANDATORY)

Before calling Agent(), confirm every `${...}` conditional in the prompt below
(`TDD_APPLICABLE`, `CONTEXT_WINDOW`, `AGENT_SKILLS`) was resolved to concrete
text for THIS plan. If any marker's value was not computed, HALT — do not
dispatch a prompt containing literal `${...}` template syntax (#4266).
