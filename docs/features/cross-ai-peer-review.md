---
id: 42
title: Cross-AI Peer Review
group: v1.27 Features
---

**Command:** `/gsd-review --phase N [--gemini] [--claude] [--codex] [--coderabbit] [--opencode] [--qwen] [--cursor] [--agy] [--antigravity] [--ollama] [--lm-studio] [--llama-cpp] [--kimi-code] [--all]`

**Purpose:** Invoke external AI CLIs (Gemini, Claude, Codex, CodeRabbit, OpenCode, Qwen Code, Cursor, Antigravity, Kimi Code) and local OpenAI-compatible servers (Ollama, LM Studio, llama.cpp) to independently review phase plans. Produces structured REVIEWS.md with per-reviewer feedback.

Each reviewer is a **declared lane**: its binary, prompt and output channels, timeout, availability probe, and empty-output policy come from a capability manifest rather than hand-written per-CLI logic, so a reviewer can be shipped as an installable capability instead of a core change.

**Requirements:**
- REQ-REVIEW-01: System MUST detect available AI CLIs on the system
- REQ-REVIEW-02: System MUST build a structured review prompt from phase plans
- REQ-REVIEW-03: System MUST invoke each selected CLI independently
- REQ-REVIEW-04: System MUST collect responses and produce `REVIEWS.md`
- REQ-REVIEW-05: Reviews MUST be consumable by `/gsd-plan-phase --reviews`
- REQ-REVIEW-06: System MUST support project-level no-flag defaults via `review.default_reviewers`
- REQ-REVIEW-07: Reviewer precedence MUST be explicit flags > `--all` > `review.default_reviewers` > all detected reviewers

**Produces:** `{phase}-REVIEWS.md` — Per-reviewer structured feedback

**User configuration note:**
- Set `review.default_reviewers` in `.planning/config.json` (or via `gsd config-set`) to control no-flag `/gsd-review` fan-out.
- `review.default_reviewers` may include configured `review.reviewer_instances` names; each instance runs as an independent reviewer identity backed by its configured adapter/model. Instance names are not CLI flags.
- Use `--all` for a full pre-merge sweep without changing project defaults.
- For local model servers with small context windows, set `review.max_prompt_tokens_per_reviewer` to auto-trim prompts per reviewer — see [Prompt budgets for small-context reviewers](../docs/CONFIGURATION.md#prompt-budgets-for-small-context-reviewers) in CONFIGURATION.md.

**Why record which model produced a review (#2295):** `reviewers:` in the frontmatter recorded which CLIs ran, but not which model each one resolved to. Without a pin, the model is whatever the CLI's own config or internal default happens to pick, so a "Codex vs Antigravity" comparison could quietly be a frontier model against a cheap-tier default with nothing in the record to say so — and a CLI update, or an unrelated config edit, could silently make past and future reviews incomparable.

The fix records the model *and its provenance*. Provenance is what makes the value trustworthy: `pinned` (from `review.models.<slug>`) is certain, while `banner` and `transcript` are recovered from third-party CLI output this project does not own — a startup banner or an undocumented session log.

That third-party dependence is a real trade-off, held honestly rather than papered over: the `banner` and `transcript` arms read formats GSD does not control, so they are best-effort by design and degrade to `unknown` rather than guessing or failing the run. A recorded `unknown` is a real answer — a wrong model name attributed to a review would be worse than none.
