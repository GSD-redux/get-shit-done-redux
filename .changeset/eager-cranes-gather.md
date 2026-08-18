---
type: Fixed
pr: 0
---
**`state update-progress` no longer writes two different completion percentages in one call** — the verb printed plan throughput (summaries/plans) to stdout and into the body `Progress:` bar, while the same write independently derived the frontmatter `progress.percent` as the deliberate `min(plan, phase)` cap. Mid-phase, when plan throughput runs ahead of phase completion, STATE.md contradicted itself and `state json` disagreed with the command that had just written it — silently, at exit 0. All surfaces now derive from the single canonical computation, and its reported plan counts come from the same milestone window as the percent, so the verb's own output can no longer disagree with itself. When that computation withholds a percent, the verb withholds too rather than substituting a different metric. The min-cap definition is unchanged. (#3583)
