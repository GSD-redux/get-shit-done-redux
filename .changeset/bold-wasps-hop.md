---
type: Fixed
pr: 3478
---
Executor dispatch prompts now state checkpoint gate semantics: gate="blocking" (the default) is auto-approvable in auto-mode, only gate="blocking-human" always surfaces to a human. The phase-level and single-plan-level orchestrators no longer leave room to compose dispatch text that refuses auto-approval, which stalled autonomous runs at ordinary blocking checkpoints.
