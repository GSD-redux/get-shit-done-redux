---
type: Fixed
pr: 2820
---
**`/gsd:review` no longer silently drops a reviewer you asked for** — naming a reviewer with an explicit flag (`--gemini --qwen`) on a host where that lane could not run reported an info note and reviewed with a thinner set, while the run reported success; a cross-AI review that quietly loses a lane is blind in one eye. An explicitly-named lane that cannot run — CLI absent, `jq` missing, or local server unreachable — is now an error. `--all` and `review.default_reviewers` are unchanged and still skip undetected lanes with an info note. The Qwen lane also now captures stderr to a sidecar and includes it in its failure stub, matching every other lane, so a missing binary and an auth prompt are no longer indistinguishable from an empty review. (#2794)
