# Compact Content — Protected Content List

(ADR-4139 Decision 5.) Content in this list may never leave a workflow spine during a compact-content split — it stays directly in the eagerly-loaded spine file, never moved to a `detail/*.md` part, regardless of how much it would shrink the spine.

## The categories

1. **Negative instructions and guardrails** — any "do not X" / "never X" instruction that changes what the orchestrator must refuse to do (e.g. "Never call `ScheduleWakeup`... to literalize this wait").
2. **Output-format contracts** — any block defining the literal shape of output another system consumes: a prompt template handed to a subagent, a JSON/XML schema, a `<quality_gate>` or `<success_criteria>` checklist.
3. **Few-shot examples the workflow's own steps depend on** — a worked example whose absence would leave a later instruction ambiguous (e.g. a `<verify>`/`<fails_when>` XML pair a planner prompt's own rule depends on).
4. **Security and prompt-injection language** — any text establishing a security boundary or defending against injected instructions.
5. **Machine-parsed structural headings** — a heading or marker another tool locates by exact text (a `## PLANNING COMPLETE`-style return marker, a `<!-- gsd:section -->` directive, a `<process>`/`</process>` boundary).

## Marking

A sentinel comment declares protection at authoring time — the guard (Phase 3, #4403) checks for the sentinel's continued presence, never for category membership, because a guard cannot judge prose category on its own:

```markdown
<!-- gsd:protected -->
… one protected block …

<!-- gsd:protected:start -->
… a protected region spanning several blocks …
<!-- gsd:protected:end -->
```

The rule is mechanical: a sentinel present in the canonical file at the parent commit must be present in the spine afterward, and every line it covers must be in the spine. The categories above are authoring guidance for *where* to place a sentinel when splitting a file — they are never what an automated guard evaluates; only the sentinel's presence is.
