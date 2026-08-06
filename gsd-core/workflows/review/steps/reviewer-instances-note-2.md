**Reviewer instances (#1517, optional):** instances resolve *through* a lane and are not lanes
themselves (ADR-2782 D8). Each selected instance invokes its base `cli` with its own `model`/`agent`
as opaque argv. Exact invocation in `gsd-core/references/reviewer-instances.md`.
