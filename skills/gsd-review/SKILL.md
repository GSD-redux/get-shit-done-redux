---
name: gsd-review
description: "Request cross-AI peer review of phase plans from external AI CLIs"
argument-hint: "--phase N [--gemini] [--claude] [--codex] [--opencode] [--qwen] [--cursor] [--kimi-code] [--agy] [--all]"
allowed-tools:
  - Read
  - Write
  - Bash
  - Glob
  - Grep
---


<objective>
Invoke external AI CLIs (Gemini, Claude, Codex, OpenCode, Qwen Code, Cursor, Kimi Code) to independently review phase plans.
Produces a structured REVIEWS.md with per-reviewer feedback that can be fed back into
planning via /gsd-plan-phase --reviews.

**Flow:** Detect CLIs → Build review prompt → Invoke each CLI → Collect responses → Write REVIEWS.md
</objective>

<execution_context>
@~/.claude/gsd-core/workflows/review.md
</execution_context>

<context>
Phase number: extracted from $ARGUMENTS (required)

**Flags:**
- `--gemini` — Include Gemini CLI review
- `--claude` — Include Claude CLI review (uses separate session)
- `--codex` — Include Codex CLI review
- `--opencode` — Include OpenCode review (uses model from user's OpenCode config)
- `--qwen` — Include Qwen Code review (Alibaba Qwen models)
- `--cursor` — Include Cursor agent review
- `--kimi-code` — Include Kimi Code CLI review
- `--agy` / `--antigravity` — Include Antigravity CLI review
- `--all` — Include all available CLIs

**No flags** — if `review.default_reviewers` is set, review with only those configured
reviewers that are detected; otherwise review with all available CLIs. Configured
`review.reviewer_instances` names may appear in `review.default_reviewers`; each runs as an
independent reviewer identity backed by its configured adapter+model (see
`docs/CONFIGURATION.md`). Instance names are not valid as flags.
</context>

<process>
Execute end-to-end.
</process>
