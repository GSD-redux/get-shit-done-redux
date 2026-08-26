---
id: 162
title: Statusline STATE.md Freshness Marker
group: v1.7.0 Features
---

**Config key:** `statusline.show_state_freshness` (default `false`)

**Purpose:** A solo developer returning to a project after time away reads "Phase 4, executing" in `STATE.md` and acts on it — without noticing the codebase has moved 40 commits since that line was written. `/gsd-health` reports this as `W024`, but only if the user thinks to run it. The statusline is the one surface seen continuously without asking (#2734).

**Behavior:** Renders `state ~N commits back` inside the GSD-state segment when `STATE.md` carries a `state_head` stamp (#2573) and `HEAD` is at least `STATE_HEAD_ADVISORY_COMMITS` (20) commits past it. Both statusline formats carry it — the default renderer and the compact `statusline.state_format` one.

**The threshold is 20, deliberately not 1.** With `commit_docs: true` (the default) the commit carrying a `STATE.md` sync advances `HEAD` by one, so a `> 0` threshold would render `state ~1 commits back` permanently on a project that is by construction fresh — alarm fatigue on the one always-visible surface.

**It degrades to silence rather than to a wrong answer.** The marker is absent — never "fresh" — when the stamp is malformed, when the project root does not own its `.git` (an enclosing unrelated repo would otherwise answer), in a `planning.sub_repos` workspace (the outer `HEAD` never advances when code lands in children), when history was rewound past the stamp, and when git is unavailable or slow. A freshness claim the project cannot substantiate degrades to *unknown*.

**Cost:** exactly one bounded `git rev-list` call per render, and only when enabled *and* a stamp is present — `rev-list --left-right --count` answers ancestry and distance together, and repo pinning is a filesystem check rather than a subprocess. Disabled (the default) it adds none.

**A proxy, never a drift measurement.** The count includes commits that touched nothing `STATE.md` describes, and the stamp restamps on every state write — so a low count means "something wrote STATE recently", not "STATE is accurate". Rendered with a `~`; never gate on it.

**Reference:** [Configuration](CONFIGURATION.md) · [Read the statusline freshness marker](how-to/read-the-statusline-freshness-marker.md) · [ADR-2164](adr/2164-statusline-scope-boundary.md)
