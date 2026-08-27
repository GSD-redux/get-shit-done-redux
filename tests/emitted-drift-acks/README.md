# tests/emitted-drift-acks/

Per-PR acknowledgment fragments for the differential attribution check
(`tests/emitted-attribution.test.cjs`, ADR-2719 / #2789 / #2914).

**This directory being empty is the healthy steady state.** A fragment appearing
in a diff *is* the alarm; a fragment sitting here on `next` is spent cruft.
`README.md` is not a fragment — every reader filters on `.json` — and exists so
the directory (which `CONTEXT.md` and `CONTRIBUTING.md` both reference by path)
survives the sweep that empties it.

## The lifecycle, in three steps

1. **The gate names its own remedy.** When an emitted-artifact hash moves, or a
   `gsd-core/workflows/*.md` / `agents/gsd-*.md` file grows, and your diff cannot
   explain it, the failure output tells you which key to use and prints a minimal
   valid document to paste. Create a NEW fragment named for your issue or PR
   (`<NNNN>-<slug>.json`) — never reuse someone else's, and never revive the
   legacy single `tests/emitted-drift-ack.json`.
2. **Note the two key spaces.** The message says which one applies. An
   unattributable **hash** ripple is keyed on the emitted path
   (`skills/gsd-add-tests/SKILL.md`); **growth** is keyed on the bare filename as
   it appears under `gsd-core/workflows/` or `agents/` (`explore.md`).
3. **The fragment is deleted once it has merged (#3078).** Every entry is scoped
   to the diff that introduced it, so the moment it lands on `next` its prose is
   already at the base — it is spent and can no longer clear anything, while
   still owning its path keys. The `guard-no-ack-on-next` job reds `next` and
   prints the exact `git rm` for every fully-spent fragment.

   You no longer have to run that `git rm` yourself (#3875). The
   `ack-fragment-sweep` workflow runs every six hours, asks the guard for its own
   sweep list (`--sweep-plan`), and opens a PR deleting exactly what the guard
   named. Deleting the fragment in a follow-up PR by hand still works and is
   still welcome — it is simply no longer the only thing standing between a
   merged fragment and a red `next`.

   The sweep is automated because the manual remedy could not keep up. The guard
   evaluates at MERGE time; a hand-authored `git rm` is fixed at BRANCH time, so
   any ack-carrying PR that merges in between invalidates it. #3823 lost exactly
   that race to #3809 on its own merge commit and left `next` red for 24
   consecutive pushes.

## Why the sweep exists

Fragments end the *file* conflict the single shared document caused. They do not
end the *key* conflict: two ack sources may never name the same path, and that is
a hard, loudly-reported error. So a fully-spent fragment left here walls off every
path it owns — the next PR to grow one of them can declare it neither in the
owning fragment (spent, gates nothing) nor in its own (duplicate). #2914 assumed a
persisting fragment was harmless; #3078 measured the cost at 45 fragments owning
403 paths and made the guard sweep them.

A **partially** spent fragment is deliberately left alone. That asymmetry is what
keeps the re-arm route working: appending prose to a live entry re-arms it, and
re-arming deliberately costs an actual new sentence — the comparison strips
zero-width characters and collapses whitespace precisely so a zero-information
edit cannot fake one.

## Never pin a fragment in a test

A fragment is deleted the moment it has merged (see step 3 above), so any test
that asserts one exists, or asserts its contents, will fail the instant
`guard-no-ack-on-next` sweeps it — and that failure has nothing to do with the
behavior the fragment once explained. This has already cost two suites:
`tests/emitted-attribution.test.cjs`'s three `#2914` migration pins, and
`tests/agent-tracked-source-rule.test.cjs`'s `#3645` growth-ack pin. What a test
may legitimately assert is the BEHAVIOR the ack explains, or the guard's own
verdict (`assertNoAllSpentFragments`, `assertAbsentOnNext`) — never the
paperwork.

## Do not regenerate anything

There is no baseline file to re-run a generator over; #2724 deleted it. If you
find yourself hunting for one, that is the predictable wrong guess.

See `CONTRIBUTING.md` → "Editing shipped content", `docs/TESTING-SUITES.md`, and
`CONTEXT.md`'s `RULESET.EMITTED_ATTRIBUTION` for the full model.
