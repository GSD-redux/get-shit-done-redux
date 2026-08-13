---
type: Fixed
pr: 3391
---
**`spec-phase` Step 5.5 now surfaces the edge-probe's proposed edges to the resolution loop instead of discarding them** — the deterministic coverage report was computed, validated, then reduced to a single applicable-count, so the resolution loop re-derived edge categories from requirement prose and the engine's proposals never reached it. The report is now rendered into context and its rows are consumed as a *floor* the model unions with its own classification (still adding any category the classifier missed), so the written `## Edge Coverage` reflects the engine's deterministic taxonomy rather than model-invented categories; `--auto` gets the same floor. (#3102)
