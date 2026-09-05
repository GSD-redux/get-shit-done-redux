---
type: Fixed
pr: 0
---
**The #3889 chunk-timeout tests now keep testing the timeout diagnostic regardless of the Node line's test-runner shutdown behavior** — the hang fixture returned a never-settling promise that holds no event-loop handle, so whether the chunk actually hung (and got killed by the per-chunk timeout, exercising the diagnostic) was decided by the runtime: on Node 24/26 the runner happens to hold the loop open, but on other lines the child exits on its own in ~60ms and the two timeout assertions silently assert nothing, failing later as a confusing 72ms chunk failure. The fixture now parks on a settling 10s timer (the #4104 idiom): the hang is a property of the fixture on every runtime, it stays ~0% CPU while parked, and it self-terminates if orphaned; a new regression guard pins that property (still hanging past the chunk bound, natural exit). Behavior on Node 24 (the CI/bench matrix line) is unchanged. (#4105)
