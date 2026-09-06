# Response-Language Directive (#2529)

**If `response_language` is set** (in the init JSON this workflow parses, or in `.planning/config.json`): ALL user-facing output of this workflow MUST be in that language — narration between tool calls, status updates, progress notes, findings, banners, report prose, questions (AskUserQuestion or plain text), and summaries. Technical terms, code, file paths, commands, and identifiers stay in English.

Literal English report/banner templates embedded in a workflow are a structural SOURCE, not literal output to copy verbatim — render their prose translated into `{response_language}` while keeping headings' structural markers, table columns, IDs, commands, and file paths unchanged. Exception: blocks a workflow explicitly requires to be emitted byte-for-byte (e.g. pre-rendered checkpoints) are output exactly as rendered.

Pass `response_language: {value}` into every spawned subagent prompt so any user-facing output they produce stays in the configured language.

Workflows take this contract in one of three forms (REQ-LANG-03): an `@`-reference to this file; their own inline directive naming the same narration class; or, for a fragment loaded by a covered parent, inheritance from that parent. Coverage is enforced by `scripts/lint-response-language-coverage.cjs` — a new workflow cannot ship without one of the three, and the lint checks this file's own wording too, so a weakened directive here uncovers every workflow that imports it rather than passing silently. Workflow-specific directives (e.g. `execute-phase-response-language.md`) take precedence where present.
