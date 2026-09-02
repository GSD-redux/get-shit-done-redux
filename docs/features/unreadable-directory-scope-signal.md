---
id: 4014
title: Unreadable-Directory Scope Signal
group: v1.7.0 Features
---

**Purpose:** ADR-3473 §8.4 ("failure is a value") applies to filesystem
listings, not only command argv. `#3885` (B5) gave `roadmap analyze`,
`gap-checker`, and `init`'s JSON bundles a `context_read_error` /
`phase_dir_read_error` string naming an unreadable phase directory — but the
underlying `has_context` / `hasContext` boolean stayed `false` either way,
so a consumer branching on that boolean alone still cannot tell "genuinely
no context file" from "could not read the directory at all." This closes
that gap with a typed signal, reusing ADR-3180's existing frozen `SCOPE`
enum rather than a new vocabulary.

**`findContextMdIn` (`src/planning-workspace.cts`) now reports its own
scope.** Called with a directory path, it returns `{ file, files, scope }`
instead of a bare filename-or-null, and never throws — an unreadable
directory reports `scope: 'unreadable'` (previously it threw, forcing every
caller to hand-roll its own `try`/`catch`); a genuinely absent directory
(`ENOENT`) reports `scope: 'complete'`, the same "real empty" answer as
today. The array-input call form (an already-read listing) is unchanged.

**Five downstream call sites gain an additive `scope` field, none renamed
or removed:** `roadmap analyze`'s `AnalyzePhase.context_scope`,
`gap-checker`'s `phase_dir_scope`, and `init`'s `context_scope` on all three
JSON bundles (`init plan-phase`, `init phase-op`, `init manager`) —
including `cmdInitManager`, whose own read failure previously vanished into
a bare empty `catch {}` with no signal of any kind. `getPhaseFileStats`
(`src/core-utils.cts`) — the shared listing owner behind `roadmap analyze`
and `init`'s `has_context` — no longer lets its own failed read get masked
by an unrelated, already-successful `scanPhasePlans` scope on the same
phase directory.

**Known limits:**
- `context_read_error` / `phase_dir_read_error`'s message text is now a
  fixed "Could not read phase directory `<path>`" rather than embedding the
  underlying OS errno text — `findContextMdIn`'s directory-string form
  reports only the `SCOPE` discriminator, not the raw caught error. The
  field's presence and type are unchanged; only its message detail is
  coarser than before #4014.
- `init.cts`'s three call sites call `findContextMdIn` for the scope signal
  and then still run their own, pre-existing `fs.readdirSync` on the same
  path for the rest of their output — an intentional, additive-only choice
  to avoid altering already-complex failure control-flow at those sites,
  not a performance optimization.
