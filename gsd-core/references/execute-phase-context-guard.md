0. **Context exhaustion guard — `context_guard` (BEFORE spawning, #1452):**

   Before spawning any agents for this wave, self-assess context pressure using the
   degradation signals in `gsd-core/references/context-budget.md`. Signs of POOR tier (70%+):
   increasing vagueness, skipped steps, silent partial completion.

   Read `workflow.context_guard_mode` from `.planning/config.json` (default `warn`).

   | Tier | `warn` (default) | `auto` | `off` |
   |------|-----------------|--------|-------|
   | PEAK / GOOD | No output | No output | No output |
   | DEGRADING (50-70%) | Emit: "⚠ Context pressure DEGRADING — switching to frontmatter-only reads for remaining waves." Continue. | Same as warn | Skip |
   | POOR (70%+) | Emit: "🛑 Context pressure POOR — risk of context exhaustion. Run `/gsd:pause-work` to checkpoint before this wave, then resume in a fresh session." Continue (user decides). | Invoke `/gsd:pause-work` immediately and halt. Do NOT spawn wave agents. | Skip |

   The guard is heuristic — no programmatic context-percentage API exists. Use your
   assessment of degradation signals, not a fixed token count.
