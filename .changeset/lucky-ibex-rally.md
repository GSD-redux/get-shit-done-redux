---
type: Fixed
pr: 4046
---
a timed-out git commit is now reported as commit_timeout with the stale .git/index.lock path surfaced in the error, instead of commit_failed with the killed hook's partial stderr; the commit call also moves to the 30s band the push call uses (pre-commit hooks alone can exceed the old 10s cap) (#3886)
