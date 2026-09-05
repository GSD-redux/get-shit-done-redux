---
type: Fixed
pr: 0
---
**Test machines no longer accumulate immortal 100%-CPU orphan processes when a test runner is killed mid-hang** — the prohibition-enforcement hang fixture busy-looped `while (true) {}`, so a worker orphaned by a chunk timeout, CI cancellation, or Ctrl+C burned a core indefinitely (users found orphans days old); the fixture now parks on a settling 10s timer — still hung for any enforcement bound, ~0% CPU if leaked, and guaranteed to self-terminate. (#4104)
