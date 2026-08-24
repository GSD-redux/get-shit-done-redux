# How to verify a dependency-compatibility claim the researcher would not verify

**Goal:** Turn a compatibility claim that came back `[ASSUMED]` — "this library does not support that runtime version" — into either a `[VERIFIED]` claim backed by a real probe, a `[CITED]` claim backed by an affirmative sentence in the vendor's own docs, or a decision you deliberately take without locking. The point is that an *absence* of metadata never becomes a constraint by default, so the version bound you end up pinning is the one the world actually imposes rather than the one a missing field seemed to imply.

**Prerequisites:** A phase whose `/gsd-plan-phase` research pass has produced a RESEARCH.md. The absent-evidence provenance rule runs inside `gsd-phase-researcher` automatically — there is no flag and nothing to enable. You reach this guide because a claim you expected to be settled is tagged `[ASSUMED]` and `/gsd-discuss-phase` is asking you to confirm it before it can lock a decision.

For the rule itself and the other two provenance rules beside it, see [`/gsd-plan-phase` in COMMANDS.md](../COMMANDS.md#gsd-plan-phase). This guide covers only how to *act* on the claim.

---

## Read the claim

A governed claim looks like this in RESEARCH.md:

> `[ASSUMED]` ldap3 publishes no `python_requires` and no per-minor classifier for 3.14 — support for 3.14 is unconfirmed.

Two things are true of it at once, and holding both is the whole skill:

- The **lookup was real.** The registry was consulted, the field genuinely is not there. Nothing is being doubted about the observation.
- The **conclusion is not.** A project that declares no supported versions has said nothing about the version you are ruling out *and* nothing about the version you are standardizing on. The same evidence would "prove" both, so it settles neither.

The tag is `[ASSUMED]` because of the second point, not the first. It is not a complaint that the researcher was lazy.

## Tell the four cases apart before you do anything

Reaching for a probe when you did not need one is the common waste here, and treating a real declared constraint as an absence is the expensive mistake. Read which case you are in first:

| What RESEARCH.md shows | What it means | What to do |
|---|---|---|
| **No constraint declared** — no `python_requires`, no `engines`, no classifier for any version, no changelog entry | The project is silent. Silence binds nothing. | Probe it, or accept unlocked — below |
| **A constraint is declared and excludes you** — e.g. `requires-python = ">=3.9,<3.12"` and you want 3.14 | A real, positive, published constraint | Nothing to do. This is already `[VERIFIED]` and it is a genuine bound — honor it |
| **Docs state the incompatibility affirmatively** — "Python 3.14 is not supported" in the project's own documentation | A positive statement about the world | Nothing to do. This is `[CITED]` and it stands |
| **The lookup itself failed** — registry 5xx, package not found, tool errored | *No observation.* This is not the same as "no field declared" | Retry the lookup first. Do not treat a failed lookup as evidence of anything |

Row 2 is the one worth slowing down for. The rule targets metadata that is **missing**, never metadata that is merely **unfavorable** — so a declared upper bound is not weakened by any of this, and re-probing against it is wasted work.

## Probe it — the route to `[VERIFIED]`

For dependency-compatibility the probe is usually under ten lines: install it against the real target, exercise the capability the claim is about, print what happened.

```bash
# The real target — the interpreter/runtime the claim is about, not a proxy for it
uv run --python 3.14 --with ldap3 python -c "
import ldap3, importlib.metadata as md
print('ldap3', md.version('ldap3'))
conn = ldap3.Connection(ldap3.Server('ldaps://dir.example.internal', use_ssl=True), auto_bind=True)
print('bind', conn.bound)
print('search', conn.search('dc=example,dc=internal', '(objectClass=computer)', attributes=['cn']))
"
```

Then paste the **output** — not a summary of it, and not an assertion that you ran it — beside the claim in RESEARCH.md. The output is what makes the tag checkable; a claim that a probe was run is exactly as unfalsifiable as the absence it was meant to replace.

Three things decide whether the probe actually settled anything:

- **It must exercise the capability the claim is about.** `import ldap3` succeeding on 3.14 says nothing about whether `bind()` and `search()` work. A probe that only imports proves only that the import works.
- **A failure must be attributable to the incompatibility.** If the probe fails because a certificate is missing or the host is wrong, that is your environment failing, not the library. Fix the probe and rerun; do not bank the failure.
- **A probe that succeeds refutes the claim.** Do not soften it to "probably fine" — remove it. A disproved claim left in place as `[ASSUMED]` still steers the plan, and nobody looks again at something that already carries a hedge.

Record the result:

| Probe outcome | Tag | What the plan may do with it |
|---|---|---|
| Failed, attributably, output pasted | `[VERIFIED: probe]` | May lock a decision — the bound is real |
| Succeeded | *claim removed* | The premise is gone; do not bound on it |
| Failed for an unrelated reason | still `[ASSUMED]` | Fix the probe and rerun |

## Accept it unlocked — when you cannot probe

Sometimes the probe is genuinely unavailable: no interpreter for that version, no reachable target host, no network in this environment. That is a normal outcome and the rule is built for it.

Leave the claim `[ASSUMED]` and tell `/gsd-discuss-phase` to proceed without locking. The claim still reaches the planner and can still shape a plan — it simply cannot become a locked `CONTEXT.md` decision that downstream phases treat as settled. **A probe you cannot run costs you a confirmation checkpoint, not a blocked plan.**

What you should *not* do is confirm the claim at the checkpoint to make the prompt go away. Confirming is you asserting the premise on your own authority; it will be treated as settled by every phase after this one, and the checkpoint is the last place anybody will look at it.

## Cite it instead — the cheaper route

Before writing a probe, check whether the vendor states the incompatibility outright. An affirmative sentence in official documentation — a support matrix with your version marked unsupported, a release note saying support was dropped — is positive evidence and earns `[CITED: <url>]` with the sentence quoted. That is often a two-minute answer where the probe is a twenty-minute one.

An absence in the docs is not this. "The docs do not mention 3.14" is the same silence you started with.

## The mirror-image mistake

The rule cuts both ways, and the direction people forget is the optimistic one:

> ~~"No upper bound is declared, so any version works."~~

That is the same inference with the sign flipped, and it fails for the same reason. If you want to standardize *on* a version, the evidence for that is a declared constraint that covers it, a matching classifier, or a probe that succeeds — never the absence of a prohibition.

## What happens if you skip all of this

The failure this rule exists to prevent, from the report that prompted it ([#2951](https://github.com/open-gsd/gsd-core/issues/2951)): a missing `python_requires` was read as "no 3.14 support", locked as a decision, and turned into a `requires-python = ">=3.12,<3.14"` bound, a pinned `.python-version`, and a CI assertion. The claim was true and worthless — the same metadata was equally absent for 3.12 and 3.13, the versions being standardized on. Six pipeline stages and five review lanes passed it, because each one checked internal consistency and none re-derived the premise. A five-line probe against a live directory server disproved it after the downgrade had already been committed.

## Related

- [`/gsd-plan-phase`](../COMMANDS.md#gsd-plan-phase) — the two sibling provenance rules: package-name legitimacy, and in-repo value citation
- [Discuss a phase](discuss-a-phase.md) — where an `[ASSUMED]` claim reaches its confirmation checkpoint
- [gsd-phase-researcher](../AGENTS.md#gsd-phase-researcher) — the agent that applies the rule
