# ADR-3212: The Lexical Seam — Safe Pattern Construction, Line-Terminator Normalization, and Tokenizer-First Stateful Grammars

- **Status:** Accepted (Phase 0 — ADR only; locks the contract Phases 1–4 execute against. No production code lands in this PR.)
- **Date:** 2026-08-08
- **Issue:** [#3212](https://github.com/open-gsd/gsd-core/issues/3212) — epic (tech-debt / root-cause consolidation, `type: chore` + `approved-enhancement`)
- **Supersedes:** nothing
- **Relationship to prior work:** the layer *beneath* [#1372](https://github.com/open-gsd/gsd-core/issues/1372) (`markdown-sectionizer`, closed) and [#2143](https://github.com/open-gsd/gsd-core/issues/2143) (tables + bounded mutation, **open and in progress**). Sibling of [#2121](https://github.com/open-gsd/gsd-core/issues/2121) (`phase-id.cts`). The extend-never-mutate lock (§6) is inherited verbatim from ADR-2143 §2.

## Context

Epics #1372 and #2143 own **structure**: fenced code, headings, sections, bullets, tables, and bounded document mutation for `ROADMAP.md` / `STATE.md`. That work is sound and this ADR does not touch it.

Underneath sits a **lexical** layer — how a pattern is *built* from a runtime value, how content is *split into lines*, and how a *token* is scanned out of prose. No seam owns it, and the defect history concentrates there.

A character-scanner census of the tree (not a grep; the script honors comments, strings, character classes, and the division-vs-regex boundary) finds:

| Directory | Files | Files with a regex | Regex literals |
|---|---:|---:|---:|
| `src` | 186 | 112 | 1,597 |
| `scripts` | 87 | 82 | 365 |
| `hooks` | 26 | 24 | 136 |
| `eslint-rules` | 18 | 8 | 15 |
| **Total** | **317** | **226** | **2,113** |

**The count is not the problem.** A regex over a fixed, anchored, non-nested token is the correct tool and the large majority of those 2,113 are exactly that. They stay. The problem is four specific misuses that keep re-opening under new issue numbers.

### Class 1 — a pattern built from a runtime value, escaped by hand

Ten private, non-exported copies of the same helper:

| Symbol | Location |
|---|---|
| `escapeRegex` | `src/state-document.cts:13`, `src/phase-id.cts:15`, `src/api-coverage.cts:173`, `src/assumption-delta.cts:213` |
| `escapeRegExp` | `src/runtime-artifact-conversion.cts:290`, `scripts/gen-loop-host-contract.cjs:197`, `scripts/sync-runtime-launcher.cjs:376`, `tests/helpers/install-shared.cjs:225`, `tests/phase6-capstone-conformance.test.cjs:29` |
| `escapeRe` | `tests/code-review-agent-skills.test.cjs:32` |

All ten were read at authoring time and carry a byte-identical body — the same character class `/[.*+?^${}()|[\]\\]/g` and the same `'\\$&'` replacement — which is precisely why the duplication is dangerous rather than merely untidy: they agree *today*, nothing asserts they agree *tomorrow*, and a fix applied to one reaches none of the others. This is the `CLAUDE.md` **Generative Fix Divergence** rule ("when sharing constants/arrays/parsers between parallel surfaces, add a parity assertion test that fails if they diverge") going unapplied.

Confirmed damage: **#123** — an unescaped `/` inside a regex literal threw `SyntaxError: Invalid regular expression flags` at parse time and blocked CI for *every* open PR simultaneously; **#741** — `stateExtractField` interpolated an un-escaped field name; `fix(milestone): escape reqId in regex patterns to prevent injection`; **#2528** (open, `confirmed-bug`) — whose title records that "the matching logic exists in 3 independent copies."

### Class 2 — line-terminator assumptions

Eighteen commits fix a CRLF miss. Six of them — **#3116**, **#2754**, **#2694**, **#2450**, **#2449**, **#2206** — landed *after* the #1372 seam shipped, and #3116 landed on 2026-08-07, the day before this ADR was researched. Four of the six are in frontmatter handling, the surface ADR-1372 **explicitly scoped out**: "`frontmatter.cts` stays as-is — YAML frontmatter is a different grammar with its own well-used shared parser; it is out of scope."

The repo has the *prohibition* (`eslint-rules/no-crlf-fragile-split.cjs`, `DEFECT.WINDOWS-CRLF-TEST-PORTABILITY`) but not the *primitive*, and the rule's own header scopes it to test files. That is the inverse of the arrangement #1372 proved. ADR-1372 argued "without the lint guard the divergence regrows"; the converse holds equally — a prohibition with nothing to redirect to leaves every author to re-derive `\r?\n` correctness by hand. `normalizeLineEndings` is duplicated 4× in `scripts/` and appears **zero** times in `src/`.

### Class 3 — a pattern applied to a grammar that has state

A regex recognizes a regular language. A shell command line, a branch name, a bracketed phase token, and a decision bullet that may be either a *declaration* or a *cross-reference* are not regular — they carry prefixes, quoting, nesting, or a declaration/reference distinction that a pattern cannot see.

The repo has already run this experiment and the result is unambiguous. **#3129** replaced the bypassed bash guard `[[ "$CMD" =~ ^git[[:space:]]+commit ]]` with `hooks/lib/git-cmd.js` — a token-walk classifier handling env-prefix assignments, `-C path`, full-path executables, `--git-dir=`, and global boolean flags. It has not re-opened. Where the pattern was kept, the shape keeps returning:

| Issue | State | The state the pattern could not see |
|---|---|---|
| #3197 | `confirmed-bug` | a `vX.Y` token inside a *phase heading* binds as the *milestone* name → milestone + `stopped_at` corruption on state writes |
| #3169 | `confirmed-bug` | `/^\s*-\s+\*\*D-/` cannot distinguish a decision **declaration** from a **cross-reference**; one false miss zeroes a 15/15-covered analysis and blocks `/gsd-plan-phase` |
| #2570 | `confirmed-bug` | a template `" — description"` suffix on `last_activity` → `Date.parse` → `NaN` → the staleness check fails open |
| #2528 | `confirmed-bug` | a numeric slug word ("24/7 Autonomy") is swallowed as a phase number |
| #2539, #2232, #2135 | fixed, locally | commit phase-token anchoring; continuation-segment digit cap; milestone heading anchoring |

Each was fixed by tightening a pattern. None of the fixes generalized.

### Class 4 — unbounded quantifiers

Eight commits fix a ReDoS or catastrophic-backtracking vector (**#2128** alone took four consecutive commits to bound), and CodeQL has flagged the class (**#663**). The census screen — lazy any-scan (`[\s\S]*?`, `.*?`) or an unbounded `*`/`+` over a class, group, or shorthand — flags **798 literals across 139 files**, concentrated in `src/verify.cts` (48), `src/phase.cts` (40), `src/state.cts` (37), `src/runtime-artifact-conversion.cts` (36), `src/roadmap-parser.cts` (28).

That figure is a **screen, not a verdict** — the majority are bounded in practice by anchors or by input the attacker does not control, and this ADR does not assert 798 vulnerabilities. It asserts something narrower and sufficient: no lint rule bounds a quantifier over document content, so a ninth vector can land without a reviewer-visible failure.

### Why this is structural

The escape helpers, the line splitters, and the token scanners sit *beneath* the markdown seams, so #1372 and #2143 pass over them: their prohibitions are filename-scoped to `src/*.cts` and shaped around markdown structure. Neither flags an unescaped interpolation, a bare `\n`, or a stateful grammar matched with a pattern. A PR can add an eleventh escape helper today and nothing objects.

Per `CONTRIBUTING.md` ("one issue = one ADR-or-PRD = one PR"), this ADR is that one file: it decides and **locks** the seams below, and ships no production code.

## Decision

Apply the mechanism #1372 proved — **one seam, a prohibition with teeth, tier-by-tier burndown** — to the lexical layer. Seven decisions, locked. Phases 1–4 execute against them as separate PRs.

### 1. `src/pattern.cts` is the sole owner of building a regex from a runtime value

Locked API:

```ts
export function escapeRegex(value: string): string;
export function literalPattern(value: string, flags?: string): RegExp;
```

`escapeRegex` **delegates to the built-in `RegExp.escape`**. It is not an eleventh hand-rolled implementation. `literalPattern` is the convenience wrapper for the dominant call shape (build a pattern that matches a value literally).

No module outside the seam escapes a value for regex use. The ten existing copies are **deleted**, not consolidated — the whole point is that the runtime now owns the algorithm.

*Rationale:* [TC39's `RegExp.escape`](https://github.com/tc39/proposal-regex-escaping) reached **Stage 4** and is in **ES2026**. Its stated motivation is exactly this defect class: developers building their own escape functions ship "subpar implementations" that miss edge cases, which is why the committee standardized it after years of community demand and the `escape-string-regexp` package.

### 2. The Node floor is the Active LTS line

`package.json` declares `engines.node: ">=22.0.0"` and the remote-runner matrix (`~/.config/gsd-test/config.toml`) runs `["22","24"]`. As of this ADR, **Node 22 is Maintenance LTS** (EOL 2027-04-30) and **Node 24 is Active LTS** (EOL 2028-04-30); Node 26 enters Active LTS 2026-10-28. This project standardizes on the LTS line and is forward-compatible to Node 26.

`RegExp.escape` ships in **Node 24** (V8 13.6) and is **absent in Node 22**. Phase 1 therefore raises `engines.node` to `>=24.0.0` and drops the `22` lane from the matrix. Phase 1 additionally asserts `typeof RegExp.escape === 'function'` in a seam test, so the floor and the capability cannot silently diverge.

*Rejected:* a delegating shim (`const escapeRegex = RegExp.escape ?? ((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))`). It avoids the engines bump and keeps Node 22 working — but it retains a hand-rolled implementation on the very path this ADR exists to delete, and it forks behavior by runtime version, which is the divergence class §7 is meant to end. The maintainer's standing policy is the LTS line; the bump is the honest expression of it.

*Consequence, stated plainly:* this is an ecosystem-visible breaking change for any consumer still on Node 22 until 2027-04-30. It is the only breaking change in the epic, it lands in Phase 1, and it requires a `Changed` changeset and a `breaking-change` label.

### 3. `src/text-lines.cts` is the sole owner of line-terminator handling

Locked API:

```ts
export function splitLines(content: string): string[];              // splits on /\r?\n/, never bare \n
export function normalizeEol(content: string): string;              // → LF
export function detectEol(content: string): '\n' | '\r\n';          // dominant terminator
export function joinLines(lines: string[], eol?: '\n' | '\r\n'): string;  // round-trip preserving
```

`joinLines` + `detectEol` exist so a read-modify-write does not silently convert a Windows-authored `STATE.md` to LF — normalization for *matching* must not become rewriting for *storage*. **`frontmatter.cts` is in scope** for this seam, closing the surface ADR-1372 excluded.

### 4. Tokenizer-first for stateful grammars — with a decidable test

The rule must be checkable in review, not a matter of taste. **A scanner is required when *any* of these hold:**

1. The input has **nesting or balancing** (quotes, brackets, fences within fences).
2. The input has a **quoting or escaping context** — a delimiter's meaning depends on whether it is quoted.
3. Meaningful tokens can appear in **positions the pattern cannot distinguish** — env-assignment prefixes, flags, path-qualified executables (#3129); a version token inside a heading vs a milestone (#3197); a numeric slug word vs a phase number (#2528).
4. A match must distinguish a **declaration from a reference** to the same token (#3169).
5. Correctness requires an **unbounded quantifier over caller-supplied content** (§5).

Otherwise — an anchored match on a fixed token shape, no nesting, no quoting, bounded — a regex is the right tool and stays.

The shared scanner generalizes the proven `hooks/lib/git-cmd.js` token-walk; that module remains the reference implementation and is migrated onto the shared primitive without behavior change.

### 5. Bounded quantifiers over document content

A quantifier applied to caller-supplied document content carries an explicit upper bound (`{0,200}`-style, as #2128's fix established) or is replaced by a scanner. Unbounded `*`/`+` over `[\s\S]`, `.`, or a broad class is prohibited on that path.

*Note on the alternative:* linear-time engines (RE2, Rust `regex`) are the standard structural answer to CWE-1333, and .NET-style match timeouts are the standard operational one. **Neither is available**: JavaScript's `RegExp` is backtracking with no timeout parameter, and "no external dependencies in core" (ADR-1372) rules out an RE2 binding. Bounding and scanning are the mitigations actually reachable from here.

### 6. Extend, never mutate (Hyrum's Law) — inherited from ADR-2143 §2

Phases may only **add** exports. Each migration runs Memtrace `get_impact` on the symbol being rerouted **before** the change and states the blast radius in its PR. Migrations are behavior-preserving except where a phase names a specific fixed bug — then a fail-first regression test drives it.

### 7. Prohibition with teeth

The mechanism that ended the read-side game, applied to the four classes:

- **`local/no-adhoc-regex-escape`** — flags a local escape helper or an inline `.replace(/[.*+?^${}()|[\]\\]/g, …)` outside `src/pattern.cts`; flags `new RegExp()` built from a non-literal without routing through the seam.
- **`local/no-crlf-fragile-split` widened** — scope extended from test files to `src/`, with the fix hint pointing at `splitLines`. A prohibition now has a primitive to name.
- **`local/no-unbounded-quantifier`** — flags a lazy any-scan or unbounded quantifier in a regex applied to file content.
- **Parity assertion** — a test asserting the seam is the single definition, so an eleventh copy fails CI rather than review (`CLAUDE.md` Generative Fix Divergence).
- Grandfather allowlists are **burned down per phase and deleted, not renewed**. Phase 4 asserts zero `pending #3212` markers remain.

### Scope boundary (what this ADR does **not** touch)

| Surface | Owner |
|---|---|
| Fenced code, headings, sections, bullets | #1372 (`markdown-sectionizer`, closed) |
| Markdown tables, bounded mutation, fail-loud on `ROADMAP`/`STATE` | **#2143 (open, in progress)** |
| Phase-identifier resolution semantics | #2121 (`phase-id.cts`) |
| Wholesale regex→parser rewrite | **Non-goal.** Most of the 2,113 literals are correct and stay. |

## Phases

Each phase is one `chore(#3212): … — Phase N` sub-issue + PR, gated on the remote runner. Behavior-preserving except where a phase names a fixed bug (driven fail-first).

- **Phase 1 — pattern construction.** Add `src/pattern.cts` (§1). Raise `engines.node` to `>=24.0.0`, drop the `22` matrix lane, assert `RegExp.escape` availability (§2). Delete the ten copies and reroute their call sites. Ship `local/no-adhoc-regex-escape` + the parity assertion. Carries the epic's only breaking change and its `Changed` changeset.
- **Phase 2 — line terminators.** Add `src/text-lines.cts` (§3). Migrate `frontmatter.cts` and the `src/` line-splitting sites; widen `no-crlf-fragile-split` to `src/` with the new fix hint. Consolidates the 4 `scripts/` `normalizeLineEndings` copies. Drives **#3116**'s class fail-first.
- **Phase 3 — tokenizer-first for stateful grammars.** Promote the `git-cmd.js` token-walk into the shared scanner (§4); migrate the phase-token, branch-name, `last_activity`, and decision-bullet scanners. Drives **#3197**, **#3169**, **#2570**, **#2528** fail-first.
- **Phase 4 — prohibition with teeth.** Ship `local/no-unbounded-quantifier` (§5); bound or convert the flagged sites on caller-supplied paths; burn down and delete the grandfather allowlists; assert zero `pending #3212` markers.

## Backward compatibility

No user-facing command output, file format, or CLI contract changes in any phase. `joinLines`/`detectEol` (§3) exist specifically so CRLF normalization for matching never rewrites a user's file on disk. The one breaking change is the Node floor (§2), confined to Phase 1 and stated there.

## Consequences

- **Positive:** escaping becomes a language built-in that cannot be got wrong, and ten divergence sites become zero. CRLF correctness is written and tested once instead of re-derived per author, on the surface that has produced six misses since the last seam shipped. Stateful grammars get the scanner that has already proven durable in this repo (#3129). Each class gains a lint rule, so class N+1 fails in review rather than in a user's `ROADMAP.md`. Four open `confirmed-bug` issues converge on one structural fix instead of four more pattern tightenings.
- **Cost:** four sequential PRs plus lint infrastructure; `get_impact` due diligence per migrated consumer; an ecosystem-visible Node floor bump.
- **Risk:** the Node 24 floor strands consumers on Node 22 until 2027-04-30 — accepted under the standing LTS policy, and the rejected shim (§2) remains the fallback if that proves wrong. Behavior-preserving migrations can regress subtle formatting — mitigated by the extend-never-mutate lock (§6), fail-first tests per named bug, and the per-phase remote-runner gate. The §4 decision test is a judgment aid, not a lint rule; §7's rules cover the mechanically-checkable subset, and the rest is reviewer discipline.
- **Non-goals:** anything in the Scope-boundary table above; any new user-facing command; changing the on-disk `ROADMAP`/`STATE` formats.

## Alternatives considered

- **Point-fix each report (status quo).** Rejected — this is the game #1372 set out to end; on this layer it is still running, with four instances open.
- **An eleventh shared `escapeRegex` instead of the built-in.** Rejected — preserves a hand-rolled implementation the language now ships; TC39's own motivation is that userland versions miss edge cases.
- **Wholesale replacement of regex with a parser or tokenizer.** Rejected — 2,113 literals, most of them correct. Cost without benefit, and Gall's Law: a working complex system grows from a working simple seam, not from a big-bang rewrite.
- **An external parsing library (remark, nearley, chevrotain) or an RE2 binding.** Rejected — "no external dependencies in core" (ADR-1372); `gsd-tools` is a zero-dependency deterministic CLI.
- **Match timeouts instead of bounding.** Rejected — not available; JavaScript's `RegExp` exposes no timeout parameter.
- **Fold into #2143.** Rejected — #2143 is open and scoped to tables / bounded mutation / fail-loud on two documents; this layer is beneath it and cuts across every module. One issue = one ADR = one PR.

## References

- Epic: [#3212](https://github.com/open-gsd/gsd-core/issues/3212)
- Prior seams: [ADR-1372](1372-markdown-sectionizer-seam.md) · [ADR-2143](2143-markdown-table-and-mutation-consolidation.md) (open) · [ADR-2121](2121-phase-identifier-parsing-consolidation.md)
- Fail-loud precedent: [ADR-1411](1411-resolution-provenance.md) · Input-shape precedent: [ADR-227](227-input-validation-shape-not-just-type.md)
- In-repo tokenizer precedent: #3129 → `hooks/lib/git-cmd.js`
- Motivating issues — open: #3197, #3169, #2570, #2528 · fixed: #123, #741, #2128, #2135, #2206, #2232, #2449, #2450, #2539, #2694, #2754, #2944, #3116, #3129
- [TC39 `RegExp.escape`](https://github.com/tc39/proposal-regex-escaping) — Stage 4, ES2026
- [CWE-1333: Inefficient Regular Expression Complexity](https://cwe.mitre.org/data/definitions/1333.html)
- [Node.js Release Working Group](https://github.com/nodejs/Release) — LTS schedule
- [CommonMark Spec](https://spec.commonmark.org/) — nested structure is context-free, not regular
