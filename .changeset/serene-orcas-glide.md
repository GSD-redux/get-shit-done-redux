---
type: Changed
pr: 3954
---
**Emitted-drift acknowledgments move from a committed file to a commit trailer.** A PR that legitimately ripples emitted-artifact bytes now declares it with an `Emitted-Drift-Ack-Hash:` or `Emitted-Drift-Ack-Growth:` trailer on one of its own commits instead of adding a JSON fragment under `tests/emitted-drift-acks/`. The acknowledgment was only ever valid for the life of the PR, so keeping it in the working tree meant every merged one became cruft that had to be detected and garbage-collected; the trailer leaves nothing behind and cannot conflict. Removes the shipped `scripts/lint-emitted-drift-ack.cjs`, the scheduled sweep workflow, and the `guard-no-ack-on-next` job. (#3942)
