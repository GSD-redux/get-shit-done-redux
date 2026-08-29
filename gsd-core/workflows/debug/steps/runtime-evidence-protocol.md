# Runtime Evidence Routing

This conditional step is a routing gate, not authorization to instrument source. Inspect the persisted session goal and Runtime Evidence ledger before doing any new investigation. If an `active_run`, source-probe entry, capture artifact, or any non-clean state already exists, read `gsd-core/references/debugger-runtime-evidence.md` and reconcile that ownership before other work, even when the effective policy is now `off`.

Read `gsd-core/references/debugger-runtime-evidence.md` on demand only when source probes are about to activate or an existing ledger needs reconciliation. Activation requires `policy: adaptive`, `goal: find_and_fix`, an exact persisted reproduction, competing recorded hypotheses that passive evidence cannot distinguish, bounded sanitized observations, a sufficiently low-perturbation bug class, and caller runtime-checkpoint capability. Inclusion of this step alone satisfies none of those gates.

`policy: off` never creates a source probe or capture artifact, but it still cleans prior session-owned state. `goal: find_root_cause_only` never mutates tracked source or offers a fix. If any activation or ownership proof is missing, remain with ordinary tests and passive evidence, record an honest inconclusive result when those are exhausted, and leave Runtime Evidence terminal-safe under the deep reference's complete ledger predicate.
