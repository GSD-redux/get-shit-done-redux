---
type: Fixed
pr: 3846
---
**`state update` now explains why a field was not written, instead of reporting it as absent** — asking to update a frontmatter key such as `stopped_at` returned "not found in STATE.md", byte-identical to a genuinely missing field and pointing away from the body field that does work. The refusal now names the body source, or names what derives the key when it has no body source. A document whose frontmatter carries a key with no body source at all — previously unrepairable through this command — can now be fixed by writing the key directly, reported as `wrote: "frontmatter"`. (#3699)
