<ui_patterns>

Visual patterns for user-facing GSD output. Orchestrators @-reference this file.

## Separators and Banners

**Never emit a fixed-width run of box-drawing characters.** A run of `━`, `─` or
`═` is ordinary text to the host that renders your output. In a narrower pane it
wraps, leaving orphan glyphs on a second line and coming apart from the heading it
was meant to frame. Markdown adapts to the available width; a 53-character rule
does not.

Three forms, and nothing else:

| Need | Emit |
|---|---|
| A titled section — stage, phase, checkpoint, completion, error | `### {TITLE}` (ATX heading) |
| A break between two sections | `---` on its own line, **with a blank line above it** |
| A framed panel of rows | `### {TITLE}` followed by the rows as plain lines |

**The blank line above `---` is load-bearing, not cosmetic.** A `---` placed
directly under a line of text is parsed as a setext heading underline for that
line, not as a thematic break — the rule silently swallows the line above it. A
blank line is what makes it a thematic break. (A blank line *after* `---` is
optional: a thematic break is a leaf block, so whatever follows starts a new
block either way. Add one where it reads better.)

**A stage banner is a heading alone — do not put a `---` above it.** An ATX
heading already separates, and it cannot be misparsed the way a bare `---` can.

### Why this is unconditional, not per-runtime

The alternative considered was a `rendersMarkdown` capability key, keeping
line-art for terminal-oriented runtimes and Markdown for Markdown hosts. It was
rejected: it needs a new descriptor key across every runtime plus the resolver,
and it leaves two output conventions to keep in sync forever — the divergence
class this repo already has a defect entry for. A heading and a thematic break
carry the same structure in a plain terminal that a rule pair did, without
committing to a width, so the second convention buys nothing. If a runtime ever
turns up that genuinely needs line-art, add the key then, against that evidence.

---

## Stage Banners

Use for major workflow transitions.

```
### GSD ► {STAGE NAME}
```

**Stage names (uppercase):**
- `QUESTIONING`
- `RESEARCHING`
- `DEFINING REQUIREMENTS`
- `CREATING ROADMAP`
- `PLANNING PHASE {N}`
- `EXECUTING WAVE {N}`
- `VERIFYING`
- `PHASE {N} COMPLETE ✓`
- `MILESTONE COMPLETE 🎉`

---

## Checkpoint Panels

User action required.

```
### CHECKPOINT: {Type}

{Content}

---

**→ {ACTION PROMPT}**
```

**Types:**
- `CHECKPOINT: Verification Required` → `→ Type "approved" or describe issues`
- `CHECKPOINT: Decision Required` → `→ Select: option-a / option-b`
- `CHECKPOINT: Action Required` → `→ Type "done" when complete`

---

## Status Symbols

```
✓  Complete / Passed / Verified
✗  Failed / Missing / Blocked
◆  In Progress
○  Pending
⚡ Auto-approved
⚠  Warning
🎉 Milestone complete (only in banner)
```

Status symbols are single characters, not runs — they do not wrap and are
unaffected by the separator rule above.

---

## Progress Display

**Phase/milestone level:**
```
Progress: ████████░░ 80%
```

**Task level:**
```
Tasks: 2/4 complete
```

**Plan level:**
```
Plans: 3/5 complete
```

The bar itself is a fixed 10-cell gauge, not a separator; it is intentionally
fixed-width and stays as it is.

---

## Spawning Indicators

**Liveness convention:** Every spawn announcement must carry the canonical phrase `runs in a subagent` inline so users know that silence during a subagent run is expected. Without this, a healthy 1–5 minute agent looks identical to a frozen session. Single spawns use the singular form; parallel spawns use the plural form.

```
◆ Spawning researcher... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)

◆ Spawning 4 researchers in parallel... (each runs in a subagent — no output until they return, ~1–5 min; expected, not a freeze)
  → Stack research
  → Features research
  → Architecture research
  → Pitfalls research

✓ Researcher complete: STACK.md written
```

---

## Next Up Block

Always at end of major completions.

```
---

## ▶ Next Up

**{Identifier}: {Name}** — {one-line description}

`/clear` then:

`{copy-paste command}`

---

**Also available:**
- `/gsd-alternative-1` — description
- `/gsd-alternative-2` — description
```

---

## Error Panel

```
### ERROR

{Error description}

**To fix:** {Resolution steps}
```

---

## Tables

```
| Phase | Status | Plans | Progress |
|-------|--------|-------|----------|
| 1     | ✓      | 3/3   | 100%     |
| 2     | ◆      | 1/4   | 25%      |
| 3     | ○      | 0/2   | 0%       |
```

Table rules use ASCII `-`, never box-drawing characters.

---

## Anti-Patterns

- Fixed-width runs of `━`, `─` or `═` as separators — they wrap in a narrow pane
- Box panels drawn with double-line box characters (U+2554, U+2557, U+255A, U+255D, U+2551, U+2560, U+2563) — the borders wrap independently of their contents. They are named here by code point rather than shown, because the guard below rejects the characters themselves anywhere in shipped content.
- A `---` directly under a line of text with no blank line between — that is a setext heading underline, not a break, and it swallows the line above
- Boxing a heading between two rules — the heading is the separator
- Mixing banner styles (`===`, `***`)
- Skipping `GSD ►` prefix in banners
- Random emoji (`🚀`, `✨`, `💫`)
- Missing Next Up block after completions

Enforced by `tests/responsive-separators.test.cjs`.

</ui_patterns>
