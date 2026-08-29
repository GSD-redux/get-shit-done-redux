---
type: Fixed
pr: 4018
---
**`local/require-registered-exit` now catches computed and optional-chained `process.exit()` calls.** The rule previously missed `process['exit']()` and `process?.[k]?.()` forms where the property name is a statically resolvable string, letting a raw terminator slip past the ADR-3889 registered-exit contract. It now resolves a computed property to a string literal (directly, or through a single never-reassigned string-literal-initialized binding) and flags those forms too. `n/no-process-exit` remains registered everywhere it already was — the two rules are complementary, not predecessor/successor, so neither is retired. (#3914)
