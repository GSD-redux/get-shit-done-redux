---
type: Fixed
pr: 2860
---
**The .planning/ write reminder can no longer be suppressed or fabricated by a model-supplied file_path** — the phase-boundary hook now treats `tool_input.path` (the field kimi-cli actually executes on) as authoritative and `file_path` as the fallback, reaching the same "path authoritative" outcome the JS guards establish via upstream normalization (#2595). Previously a model-controlled decoy `file_path` could silence the reminder for a genuine .planning/ write or raise one naming a file never touched. (#2752)
