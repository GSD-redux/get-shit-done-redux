---
type: Changed
pr: 3496
---
**`must_haves.key_links[].pattern` now uses RE2 syntax** — backreferences and look-around are no longer supported in a key-links pattern, because they are the constructs that require a backtracking engine and cannot be evaluated in guaranteed linear time. A pattern using them is reported as `pattern_neutralized: "unsupported"` with the link marked unverified, rather than being silently matched as literal text. Ordinary patterns, including every example shipped in the docs, are unaffected. (#3477)
