# Execute-Phase Response-Language Directive (#2402)

**If `response_language` is set:** User-facing orchestrator output (questions, narration, report-template prose) in `{response_language}`; technical terms, code, file paths, and subagent prompts stay in English. Pass `response_language: {value}` into every spawned subagent prompt so any user-facing output they produce stays in the configured language.

The literal report templates embedded in this workflow (`## Execution Plan`, `## Phase {X}: {Name} Execution Complete`, `## ⚠ Phase {X}: {Name} — Gaps Found`, etc.) are a structural source, not literal output to copy verbatim — render their prose translated into `{response_language}` while keeping headings' structural markers, table columns, IDs, commands, and file paths unchanged.

This directive was extracted from `workflows/execute-phase.md` to keep that file under the frozen pre-phase-6 byte ceiling (ADR-857 Phase 6 capstone, `tests/claude-orchestration.test.cjs`). The `@-reference` is eager, so the runtime still loads this content alongside the workflow — the extraction is purely a file-size discipline, not a lazy-load optimization.
