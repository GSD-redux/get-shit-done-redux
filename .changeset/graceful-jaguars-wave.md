---
type: Added
pr: 3924
---
**A second terminator for code that cannot wait for the event loop, and a versioned exit-code projection** — hooks and other write-then-exit callers can now terminate through the same registry lookup that `runMain` uses, so both agree on what every outcome means. Exit integers are versioned: today's behavior is `v1`, and `--exit-contract=v2` (or `GSD_EXIT_CONTRACT=v2`) opts into the registry's codes ahead of the next major. (#3906)
