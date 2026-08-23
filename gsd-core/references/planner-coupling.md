# Planner Coupling — Same-Wave Shared Mutable State

> Progressive-disclosure reference for `agents/gsd-planner.md`. The planner agent
> reads this file when assigning waves (issue #3724). The slim pointer in
> `agents/gsd-planner.md` → `assign_waves` routes here; the canonical schema row
> for `coupling_justified` lives in `docs/reference/plan-md.md`. The verifying
> side is `agents/gsd-plan-checker.md` Dimension 3b (#1954).

## The rule

`files_modified`/`files_deleted` overlap is not the only coupling between
same-wave plans. If two plans in the same wave touch the same **mutable
resource** through their task actions — a config key, DB table/row, migration,
env var, singleton, cache — with at least one writer, or one plan produces a
prerequisite the other consumes, the pair is coupled through shared state even
though no file overlaps: under parallel execution the outcome depends on which
executor gets there first.

Resolve it one of three ways, in order of preference:

1. **Declare the edge** — add the producing plan to the consumer's
   `depends_on`. Wave assignment then orders them automatically.
2. **Re-wave** — move one plan to a later wave when the dependency direction
   is unclear but an ordering is still wanted.
3. **Justify the pair** — when the coupling is deliberate and genuinely
   order-independent (both orders produce a correct result), record it in
   either plan's frontmatter, one `"plan-id: reason"` entry per coupled peer:

   ```yaml
   coupling_justified: ["03-02: both plans append independent keys to config; order irrelevant"]
   ```

   The plan-checker's Dimension 3b recognizes the declaration and does not
   flag the pair, so a deliberately coupled plan set passes verification
   without serializing waves it was designed to run in parallel.

## Why declare it up front

Dimension 3b flags same-wave plan pairs with an undeclared shared-mutable-state
dependency (advisory severity — it never blocks). Declaring the edge, re-waving,
or justifying the pair at plan time means the first checker pass comes back
clean instead of surfacing an advisory the planner then has to interpret.
