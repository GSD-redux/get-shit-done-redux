---
type: Fixed
pr: 4376
---
**The reapply verifier now headlines its baseline coverage instead of reading as fully verified when most files were skipped** — after a multi-version update, /gsd-update --reapply reports 'Baseline coverage: N of M file(s)' in the verifier summary, the reapply output, and the installer's update log; on git-managed config dirs the verifier additionally recovers pristine baselines from history by recorded hash, so files upstream heavily changed are diff-verified instead of skipped; an opt-in --min-baseline-coverage <0..1> flag lets cautious operators fail the gate (exit 3) below a coverage threshold. (#4135)
