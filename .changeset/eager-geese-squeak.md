---
type: Fixed
pr: 0
---
**Windows CI test runs no longer hang indefinitely.** The test runner's temp-sweep protection walk used a POSIX-only termination check that never fired on a Windows drive root, spinning forever and timing out every Windows CI shard.
