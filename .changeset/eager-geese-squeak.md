---
type: Fixed
pr: 4245
---
**Windows CI test runs no longer hang indefinitely.** The test runner's temp-sweep protection walk used a POSIX-only termination check that never fired on a Windows drive root, spinning forever and timing out every Windows CI shard. A second, previously-masked bug in the temp-root regression test's own child-process env override (only `TMPDIR`, not `TEMP`/`TMP`) is also fixed, since Windows never reads `TMPDIR`.
