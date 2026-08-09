# ADR-2363: A capability's skill body is an instruction surface — trusted, unscanned, and disclosed

- **Status:** Proposed — D1–D4 are decided; **D5's mechanism is unshipped** and is tracked by [#3248](https://github.com/open-gsd/gsd-core/issues/3248) (Phase 1). Per the corpus lifecycle rule, an ADR with an outstanding phase stays `Proposed`. Ratify when #3248 has merged and the consent summary renders the instruction surface.
- **Date:** 2026-08-09
- **Issue:** [#2363](https://github.com/open-gsd/gsd-core/issues/2363) (epic); Phase 0 tracked by [#3247](https://github.com/open-gsd/gsd-core/issues/3247), Phase 1 by [#3248](https://github.com/open-gsd/gsd-core/issues/3248)
- **Amends (prospective — this ADR is `Proposed`, so no back-link is owed yet):** [ADR-1244](1244-capability-ecosystem.md) — D5's disclosure gains a **fifth** class, and it is the first that is *not* an executable surface. [ADR-2782](2782-reviewer-lane-capability-surface.md) added the fourth (reviewer lanes); this adds the first non-executable one, which is why it needs its own classification rather than a fifth entry in the same list.
- **Related, and deliberately not amended:** [ADR-1577](1577-untrusted-input-boundary-and-injection-blocking.md) — the untrusted-input boundary and its injection scanner. D2 explains at length why that control does **not** transfer to this surface. The two share the word "trust" and solve opposite problems.

## Context

[#2322](https://github.com/open-gsd/gsd-core/issues/2322) / [PR #2340](https://github.com/open-gsd/gsd-core/pull/2340) made an installed third-party capability's `skills/<stem>/SKILL.md` materialize into the user's runtime skills directory, where it becomes an agent-invocable instruction file. That fix was correct and shipped the protections it set out to ship — all of them **path-level**:

- skill stems bound to their declaring capability via `registry.capabilityClusters`, closing a cross-capability hijack;
- stem sanitization plus `isPathConfined` on both read and write;
- first-party-wins on stem collision;
- prunable on uninstall, so removing a capability removes its instructions.

None of those say anything about what the file *contains*. `external-descriptor-trust.cts` — the module the staging path already imports — exports exactly `isPathConfined` and `assertDescriptorConfined`. There is no content scanner in it, and its own header says so: *"Do NOT conflate with ADR-1577's prompt-injection circuit-breaker — separate concern sharing the word 'trust'."*

**Nothing was bypassed. The control does not exist.** The independent security review of PR #2340 surfaced this and explicitly declined to invent policy, which is what produced #2363.

So the effective posture today is that capability skill bodies are fully trusted prose, injected verbatim into the agent's instruction surface — and that posture is nowhere written down. Worse, the one place it is *implied* states it wrongly. [`docs/explanation/capability-trust-model.md`](../explanation/capability-trust-model.md) says:

> For non-executable surfaces (skills, agents, workflow files), the disclosure note explains what they do but consent is lighter — they do not execute code.

That sentence is accurate about OS-level code execution and misleading about effect. **The agent is the interpreter.** A skill body does not execute code; it instructs the thing that does. The consent path was chosen on the basis of a property ("does not execute code") that is true and not the relevant one.

Three properties compounded to make this worth a decision rather than a footnote. The capability author controls the **content** (no scanning); before #2322 hardened it, could influence the **name** the content landed under; and, before the same fix, an uninstall did not remove the instructions from the agent's context. The latter two are closed. The first is untouched, undocumented, and is the one that determines whether "install a capability" means "grant arbitrary instructions to my agent."

This ADR answers that. It does not report a defect: nothing here violates a stated contract, because there was no stated contract.

## Decision

### D1 — A capability skill body is a *trusted, unscanned instruction surface*

Installing a third-party capability that ships skills grants that capability **instruction reach**: its `SKILL.md` bodies are copied verbatim into the user's agent instruction context and are not inspected. Their reach is bounded only by what the agent will do when told.

This is the same posture GSD already takes toward capability *code* — [ADR-1244](1244-capability-ecosystem.md) D5's "artifact parity is not trust parity," where the barrier is consent, integrity, and reversibility rather than a sandbox. D1 states that the same barrier, and only that barrier, applies to instructions. A capability is trusted code the user chose to install, in the sense an npm dependency is; the difference is that here the "code" is prose and the runtime is a language model.

This posture is now **recorded** rather than emergent. That is the substance of D1: not a change in behavior, but the end of an unstated one.

### D2 — Content scanning is rejected

GSD will **not** scan capability skill bodies for prompt-injection or suspicious content, at stage time or at any other time. This is a decision, not a deferral: there is no "until we build a scanner."

Three arguments, in order of weight.

**Kerckhoffs's principle — decisive.** A scanner's rule set ships inside the package the adversary installs. A hostile capability author reads the patterns, tests against them locally, and writes prose that passes on the first attempt. The scanner's entire security value would rest on the adversary not knowing the rules — the precise condition Kerckhoffs forbids relying on. The controls GSD *does* use survive the same test: an adversary with full knowledge of consent, integrity pinning, and reversibility gains nothing from that knowledge.

**The threat model does not transfer from [ADR-1577](1577-untrusted-input-boundary-and-injection-blocking.md).** That scanner works because it looks for instructions that are **anomalous inside data** — a directive embedded in a fetched web page has no business being there, and its presence is itself the signal. In a capability `SKILL.md`, instructions are the payload's *legitimate form*. There is no anomaly to detect. A hostile author does not need an injection signature, an evasion phrasing, or a forged `<instructions>` tag; plainly-worded malicious guidance is indistinguishable from plainly-worded legitimate guidance, because that is what the file is *for*. That ADR's scanner (`hooks/gsd-read-injection-scanner.js`) describes itself in its own header as *"a static pattern match — NOT a semantic guard, NOT PromptArmor"*, and ships a documented false-positive exclusion list. Promoting it to a security boundary here would misrepresent what it is.

**Goodhart's law — the scanner would make users less safe.** A "scanned ✓" line in a consent summary reads to a user as "reviewed and safe." The measure becomes the target: a green scan **displaces the judgment the consent prompt exists to provoke**. Honest disclosure that a capability ships agent instructions produces a better security decision than a passing scan that means almost nothing.

A fourth, supporting argument: a pattern corpus is a permanently-maintained artifact with a real innovation-budget cost, and it would be maintained against an adversary who can read it.

### D3 — Skills are reclassified as an instruction surface, not a "non-executable" one

The binary in [ADR-1244](1244-capability-ecosystem.md) D5 — executable surfaces get consent, everything else is "non-executable" and gets a lighter note — is replaced by three classes:

| Class | Members | Consent treatment |
|---|---|---|
| **Executable surface** | hooks, command modules, MCP servers, reviewer lanes | Full disclosure, consent-bound, signature-bound |
| **Instruction surface** *(new)* | skills, agents, and any other artifact whose body reaches the agent's instruction context | **Disclosed by name** at install; carries instruction reach, not code execution |
| **Inert artifact** | everything else the bundle carries | Note only |

The middle class is the decision. "Non-executable" was never wrong as a statement about code; it was wrong as a *risk classification*, because it grouped an agent-instruction file with an inert asset on the strength of a property neither of them has.

Instruction surfaces deliberately do **not** contribute to `hasExecutable`. An instruction surface is not an executable surface, and folding it in would silently change `executableSetChanged` semantics and the auto-update re-consent trigger — a behavior change to a CRITICAL-blast-radius symbol, in order to express a classification that a separate field expresses cleanly.

### D4 — Instruction surfaces are disclosed but are **not** folded into the v1 `disclosureSignature`

This is the decision with a consequence outside its own file, so it is decided here rather than in the implementation.

**First, what `disclosureSignature` is and is not**, because getting this wrong changes the argument. It is **not** the activation binding. `hasProjectConsent` compares one field and only one — `contentHash`, the recomputed full-bundle hash, which `capability-consent.cts` labels "THE security binding". The record's `disclosureSignature` is annotated "kept for re-consent-on-executable-change UX", and `integrity` "kept for the human disclosure UX, NOT the security binding". A **global**-scope install needs no consent record at all ([ADR-1244](1244-capability-ecosystem.md) D5 — global installs sit under the user's own home and are trusted as such).

So re-encoding the signature would **not** deactivate anything. What it *would* do is perturb the signature of **every capability that ships skills**, so `executableSetChanged` reports a change on each one's next upgrade and fires a re-consent prompt — for capabilities whose behavior did not change at all.

That is not a new concern to weigh; it is a **rule this corpus has already recorded**. [ADR-2782](2782-reviewer-lane-capability-surface.md) D4 rule 5:

> A capability with no `reviewer` body must not perturb its **disclosure signature** (D5). An absent body that changed the signature would force spurious re-consent across every installed capability.

D4 is that same rule applied to a new surface class rather than a fresh principle. Hyrum's law is what makes it binding: the signature's *value* is durable state on users' disks — stored on every consent record for exactly the re-consent-on-change UX — so changing its encoding changes an observable that shipped state already depends on.

Therefore:

1. Instruction surfaces are **disclosed** in the pre-install summary (D5).
2. They are **not** added to the v1 signature encoding. No stored consent record is perturbed and no spurious re-consent fires.
3. Should a future decision require instruction surfaces to be signature-bound, it arrives as a **versioned signature (v2) with an explicit migration** — never as an in-place re-encoding of v1.

Point 3 is the part that makes this a decision rather than a punt: the door stays open and the mechanism for opening it is named.

**The residual gap, stated plainly — and it is smaller than it first looks.** At **project** scope there is no gap at all: `bundleContentHash` walks every entry under the bundle with no exclusions and hashes every regular file (failing closed on symlinks and non-regular files), so a single changed byte in a skill body already deactivates a project-scoped capability until re-consent. At **global** scope there is no consent record in the first place — a global install is trusted because it sits under the user's own home ([ADR-1244](1244-capability-ecosystem.md) D5) — so a skill-body change on upgrade is not consent-gated there, and would not have been even if instruction surfaces were signature-bound. **The gap global scope has is the one it already had for code, and D4 neither widens nor narrows it.** What D4 declines to add is a re-consent *prompt* on skill-body change during an interactive upgrade; the v2 path above is where that would land if it is ever wanted.

### D5 — The mechanism *(Phase 1, [#3248](https://github.com/open-gsd/gsd-core/issues/3248) — not shipped by this ADR)*

`discloseExecutableSurfaces` gains an `instructionSurfaces` collector, enumerating each skill stem the manifest contributes, collected through the same `safeCollect` wrapper as the existing four classes so a hostile value degrades only that class and the function stays total for any manifest shape. The pre-install consent summary names those skills as an instruction surface. The signature behavior implements D4 exactly, pinned by a test that asserts what happens to a pre-existing consent record rather than leaving it incidental.

The design is deliberately **additive** — a new independent collector and a new field, with no change to the four existing collectors and none to `hasExecutable` — because `get_impact` rates `discloseExecutableSurfaces` **CRITICAL** at 196 affected symbols.

## Consequences

**What improves.** The boundary is written down on both sides: a capability author reading [`docs/how-to/develop-a-capability.md`](../how-to/develop-a-capability.md) learns their skill body ships verbatim and unscanned, and a user reading [`capability-trust-model.md`](../explanation/capability-trust-model.md) learns what installing a skill-bearing capability grants. After Phase 1, a skill-only capability — which today discloses nothing at all — names its instruction surface at the consent moment.

**What does not change.** No behavior changes in this ADR's phase. No stored consent record is perturbed and no spurious re-consent fires, now or under Phase 1 (D4). Skills remain the intended, low-friction contribution path; this is disclosure, not discouragement.

**What is deliberately not fixed.**

- **Disclosure is not a safety property.** Naming an instruction surface tells a user a capability ships agent instructions. It says nothing about whether they are benign — exactly as an integrity SHA says nothing about whether the pinned bundle is safe. GSD is honest about this for code and is now honest about it for instructions.
- **First-party skills are equally unscanned.** Their assurance is provenance — they are the shipped package, and the GSD Core release process is their control — not content inspection. No content control exists on the first-party side either, and no reader should infer one.
- **Global-scope skill-body change on upgrade is not consent-gated.** That is true of a global install's code too, and D4 does not change it either way. See D4.

**Ratification bar.** This ADR flips to `Accepted` when #3248 has merged, the consent summary renders instruction surfaces, and the D4 signature behavior is pinned by a passing test. Until then it is `Proposed` for a recorded reason, not through neglect.

## Alternatives considered

**Accept the posture with no mechanism** (#2363 option 1 alone) — record D1 and D2, correct the docs, and stop. Rejected by the maintainer: it leaves a skill-only capability disclosing nothing at the consent moment, which is the one moment a user can act.

**Scan on stage** (#2363 option 2) — rejected in D2, on Kerckhoffs, threat-model non-transfer, and Goodhart.

**Fold instruction surfaces into the v1 signature** — rejected in D4, under [ADR-2782](2782-reviewer-lane-capability-surface.md) D4 rule 5 (a change that perturbs the signature without changing behavior forces spurious re-consent across every installed capability), with Hyrum's law as the reason that rule binds. Superseded by the versioned-v2 path rather than closed off.

**Add skills to `hasExecutable`** — rejected in D3: a silent semantics change to `executableSetChanged` and the auto-update trigger, on a CRITICAL-radius symbol, to say something a separate field says cleanly.

**Full consent parity with hooks** — require the same ceremony for a skill contribution as for a hook. Rejected as consent fatigue. [`capability-trust-model.md`](../explanation/capability-trust-model.md) already rejects a per-run egress prompt on exactly these grounds: inflating every contribution to hook-level ceremony trains users to click through, degrading the prompt that matters.

**Docs correction with no ADR** — rejected: `CONTRIBUTING.md` requires an ADR for an architectural decision, and a docs edit with no recorded decision reproduces the unrecorded posture this ADR exists to end.
