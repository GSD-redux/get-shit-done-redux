Apply response_language to all user-facing prose — narration between tool calls, status updates, progress notes, and findings included; preserve code, paths, and identifiers.

<purpose>
One-page newcomer-oriented tour of GSD Core. Output ONLY the `<reference>` content below. No additions.
</purpose>

<reference>
# GSD Core — Git. Ship. Done.

Plan-driven development for solo agentic work with Claude Code. GSD Core turns a vague idea into a hierarchical plan, then executes it phase by phase with state tracking and atomic commits.

## Start here (3 commands)

```text
/gsd:new-project        # Greenfield: questioning → research → requirements → roadmap
/gsd:onboard            # Existing codebase: map → ingest docs → initialize planning
/gsd:plan-phase 1       # Create a detailed plan for phase 1
/gsd:execute-phase 1    # Execute all plans in the phase
```

Existing codebase? Run `/gsd:onboard` to map the repo, ingest existing docs, and initialize planning safely.

## Common commands

| Command | Purpose |
|---|---|
| `/gsd:progress` | Where am I, what's next — also routes freeform intent with `--do "..."` |
| `/gsd:quick` | Small ad-hoc task with GSD guarantees (planning dir + atomic commit) |
| `/gsd:fast "<task>"` | Trivial inline change — no subagents, ≤3 file edits |
| `/gsd:discuss-phase <N>` | Capture vision and decisions before planning |
| `/gsd:debug "<symptom>"` | Persistent debug session, survives `/clear` |
| `/gsd:capture` | Save an idea, todo, note, seed, or backlog item |
| `/gsd:verify-work <N>` | Conversational UAT for a completed phase |
| `/gsd:ship <N>` | Open a PR from a completed phase |
| `/gsd:help --full` | Complete reference (every command, every flag) |

## Want more?

```text
/gsd:help --brief         # 10-line refresher of top commands
/gsd:help --full          # complete reference
/gsd:help <topic>         # one section only — see topics below
/gsd:help --brief <topic> # compact scoped lookup — signature + one-line summary
```

Topics: `workflow` · `planning` · `execute` · `quick` · `debug` · `capture` · `ship` · `config` · `milestones` · `spike` · `sketch` · `review` · `audit` · `progress`

## Update GSD

```bash
npx @opengsd/gsd-core@latest
```
</reference>
