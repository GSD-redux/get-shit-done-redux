---
id: 123
title: Namespace Meta-Skills (Two-Stage Routing)
group: v1.40.0 Features
---

**Purpose:** Replace the flat eager skill listing with a two-stage hierarchical routing layer. The model sees 6 namespace routers instead of 86 entries, selects a namespace, then routes to the sub-skill. Descriptions use pipe-separated keyword tags (≤ 60 chars) for routing density.

**Commands:**
- `/gsd-workflow` — phase pipeline router (discuss / plan / execute / verify / phase / progress / next)
- `/gsd-project` — project lifecycle (milestones, audits, summary)
- `/gsd-quality` — quality gates (code review, debug, audit, security, eval, ui)
- `/gsd-context` — codebase intelligence (map, graphify, docs, learnings)
- `/gsd-manage` — config / workspace / workstreams / thread / update / ship / inbox
- `/gsd-ideate` — exploration & capture (explore, sketch, spike, spec, capture)

**Token cost:**

| | Entries | Approx tokens |
|---|---|---|
| Pre-1.40 full install | 86 | ~2,150 |
| Namespace meta-skills | 6 | ~120 |

**Requirements:**
- REQ-NS-01: Six `commands/gsd/ns-*.md` namespace routers ship with pipe-separated keyword-tag descriptions (≤ 60 chars).
- REQ-NS-02: Existing sub-skills are unchanged and still invocable directly — namespace skills are additive, not a replacement for direct slash forms.
- REQ-NS-03: The body of each namespace router contains a routing table that maps user intent to the correct concrete sub-skill on the post-#2790 consolidated surface.
- REQ-NS-04: Tests validate namespace files exist, include matching command `requires`, and reference only existing sub-skill files.

**Reference issue:** [#2792](https://github.com/open-gsd/gsd-core/issues/2792)
