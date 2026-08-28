---
type: Changed
pr: 3980
---
**`milestone complete` blocks again when the roadmap still lists unstarted phases** — that guard had been silently swallowed, so milestones could be archived with work outstanding and nothing said so. Two more guards that inspected an error's message before deciding whether to re-raise were failing the same way and are fixed with it, and `extract-messages`/`profile-sample` no longer dump a raw Node stack trace on top of their error line. A new lint rule now rejects a raw `process.exit()` outside the sanctioned terminator, so a guard cannot quietly stop guarding this way again. (#3910)
