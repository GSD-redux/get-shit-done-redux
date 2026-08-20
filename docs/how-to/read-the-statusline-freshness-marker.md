# Read the statusline STATE.md freshness marker

The statusline can tell you, at a glance, that `STATE.md` is describing a codebase that has
moved on without it:

```
Claude │ v2.0 Auth Rework · executing · state ~34 commits back │ my-project
```

`state ~34 commits back` means `STATE.md` was last written against a commit that is now 34
commits behind `HEAD`. You come back to a project after two weeks, the state file still says
"Phase 4, executing", and this is the thing that tells you that sentence is stale before you
act on it.

The marker is **advisory and approximate**. It never blocks anything.

## Turn it on

```bash
gsd-tools config-set statusline.show_state_freshness true
```

It is off by default. That is the only step — the `state_head` stamp it reads is written
automatically every time GSD syncs `STATE.md`, so an active project already has one.

To turn it off again:

```bash
gsd-tools config-set statusline.show_state_freshness false
```

The marker also appears in the compact statusline format
(`statusline.state_format: "compact"`), rendered identically.

## When it appears

Only when **all** of these hold:

1. `statusline.show_state_freshness` is `true`.
2. `.planning/STATE.md` carries a `state_head:` stamp.
3. The project root owns its own `.git`.
4. The stamp is an ancestor of the current `HEAD`.
5. `HEAD` is at least **20 commits** past the stamp.

Twenty is the same advisory threshold `/gsd-health` uses for its `W024` warning, and it is
deliberately not `1`. With `commit_docs: true` (the default) the commit that carries a
`STATE.md` sync advances `HEAD` by one, so a threshold of `> 0` would show
`state ~1 commits back` permanently on a project that is, by construction, perfectly fresh.

## I turned it on and see nothing

That is usually correct behavior rather than a fault, but "nothing to report" and "could not
look" render identically — both are simply absent. Work down this table to tell them apart.

| Reason | How to confirm | Is it a problem? |
|---|---|---|
| **Fewer than 20 commits behind** | `git rev-list --count $(grep '^state_head:' .planning/STATE.md \| cut -d' ' -f2)..HEAD` | No — this is the healthy case |
| **No `state_head` stamp** | `grep '^state_head:' .planning/STATE.md` returns nothing | No — the stamp appears on the next state write |
| **Project root does not own its `.git`** | `ls -d .git` at the directory holding `.planning/` | No — deliberate. See below |
| **`planning.sub_repos` is set** | `gsd-tools config-get planning.sub_repos` | No — deliberate. See below |
| **History was rewound past the stamp** | `git merge-base --is-ancestor <stamp> HEAD; echo $?` prints `1` | No — reported as unknown on purpose |
| **The stamp is not a commit in this repo** | `git cat-file -e <stamp>` fails | Possibly — a hand-edited `STATE.md` |
| **`git` unavailable, or the repo is enormous** | `git --version`; the read is abandoned after 1.5s | Rarely — the marker yields rather than stall your prompt |
| **A todo task is showing instead** | The middle segment shows a task, not GSD state | No — the whole GSD-state segment is replaced |

Run `/gsd-health` for the same signal in a form that always explains itself — it reports `W024`
with the count, and it is not subject to the statusline's silence.

### Why it stays quiet instead of guessing

Two cases deserve spelling out, because in both the marker *could* print a number and that
number would be a confident lie:

- **A GSD project nested inside an unrelated checkout.** `git` resolves `HEAD` from the nearest
  enclosing `.git`, which might belong to a dotfiles or notes repo that has nothing to do with
  your project. Rather than report that repo's history as your project's freshness, GSD checks
  that the directory holding `.planning/` owns its own `.git` and otherwise says nothing.
- **A `planning.sub_repos` workspace.** The outer directory legitimately owns both `.planning/`
  and its own repo, while every code commit lands in a nested child. The outer `HEAD` never
  advances, so the marker would read "fresh" forever while the code moved arbitrarily far.
  Per-child freshness would require choosing one `HEAD` out of several unrelated histories, so
  GSD declines to answer instead.

The rule in both: a freshness claim the project cannot substantiate degrades to *unknown*,
never to *fresh*.

## What the number does and does not mean

`~34` counts **every** commit between the stamp and `HEAD`, including commits that touched
nothing `STATE.md` describes. And because `state_head` is restamped on every state write, a
*low* count means "something wrote `STATE.md` recently" — not "`STATE.md` is accurate."

So read it as a prompt to look, not as a measurement of drift:

- **A high count** is a reliable signal that the state file is worth re-reading.
- **A low count** is not evidence that the state file is correct.

Do not build automation on it. It is a proxy, deliberately rendered with a `~`.

## Cost

One `git rev-list` call per statusline render, and only when the marker is enabled *and* a
`state_head` stamp is present. With the feature off — the default — it adds no subprocess and
no measurable work. The call is abandoned after 1.5 seconds, so a slow or huge repository
costs you a missing marker rather than a stalled prompt.

## Related

- [Configuration reference](../CONFIGURATION.md) — `statusline.show_state_freshness` and the
  other `statusline.*` keys
- [`/gsd-health`](../COMMANDS.md) — the `W024` warning that thresholds on the same constant
