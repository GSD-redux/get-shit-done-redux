---
id: 112
title: Extract Learnings
group: v1.36.0 Features
---

**Command:** `/gsd-extract-learnings N`

**Purpose:** Extract structured knowledge from completed phase artifacts. Reads PLAN.md and SUMMARY.md (required) plus VERIFICATION.md, UAT.md, and STATE.md (optional) to produce four categories of learnings: decisions, lessons, patterns, and surprises. Optionally captures each item to an external knowledge base via `capture_thought` tool.

**Requirements:**
- REQ-LEARN-01: Requires PLAN.md and SUMMARY.md; exits with clear error if missing
- REQ-LEARN-02: Each extracted item includes source attribution (artifact and section)
- REQ-LEARN-03: If `capture_thought` tool is available, captures items with `source`, `project`, and `phase` metadata
- REQ-LEARN-04: If `capture_thought` is unavailable, completes successfully and logs that external capture was skipped
- REQ-LEARN-05: Running twice overwrites the previous `LEARNINGS.md`

**Produces:** `{phase}-LEARNINGS.md` with YAML frontmatter (phase, project, counts per category, missing_artifacts)

**Optional integration — `capture_thought`:** `capture_thought` is a **convention, not a bundled tool**. GSD does not ship one and does not require one. The workflow checks whether any MCP server in the current session exposes a tool named `capture_thought` and, if so, calls it once per extracted learning with the signature below. If no such tool is present, the step is skipped silently and `LEARNINGS.md` remains the primary output.

Expected tool signature:
```javascript
capture_thought({
  category: "decision" | "lesson" | "pattern" | "surprise",
  phase: <phase_number>,
  content: <learning_text>,
  source: <artifact_name>
})
```

Users who run a memory / knowledge-base MCP server (for example, ExoCortex-style servers, `claude-mem`, or `mem0`-style servers) can implement this tool name to have learnings routed into their knowledge base automatically with `project`, `phase`, and `source` metadata. Everyone else can use `/gsd-extract-learnings` without any extra setup — the `LEARNINGS.md` artifact is the feature.

With `features.global_learnings: true`, phase completion runs the extraction for the just-completed phase automatically and copies the artifact to the global store at `~/.gsd/knowledge/` (#3683) — extraction and copy failures never block completion. With the gate off (the default), extraction stays fully manual.
