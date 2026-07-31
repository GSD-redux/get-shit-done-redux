---
type: Changed
pr: 2882
---
**Reviewer lane flags and section titles are now gated across every documentation surface** — `/gsd:review` reviewer flags were hand-enumerated in five docs and three workflow files that had silently drifted apart: `--kimi-code` was missing from all four translated `COMMANDS.md` mirrors, `--coderabbit` from every workflow forwarding list, and `--antigravity` from `FEATURES.md` entirely. The lane roster is now the single declared source: workflows derive their flag lists from a new `review-lane flags` query, and a parity gate fails the build when any documented flag or reviewer section title diverges from it. The capability manifest reference also gains the previously undocumented `reviewer` body and `hostBehaviors` field. (#2800)
