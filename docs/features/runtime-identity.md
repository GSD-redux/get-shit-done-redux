---
id: 168
title: Runtime Identity
group: v1.7.0 Features
---

**Purpose:** The predecessor package `get-shit-done-cc` publishes a binary named `gsd-tools`, and so does this one. They answer some of the same verb names with **different semantics**. [#3129](https://github.com/open-gsd/gsd-core/issues/3129) is the worked example: `phases.clear` **archives** here and **deletes** there. Both print success-shaped output, and `.planning/` is gitignored by default, so a user lost 43 phase directories with no error, no warning, and nothing recoverable from git. The failure was silent in both directions — the workflow could not tell it had reached the wrong handler, and the handler could not tell it had been called by a workflow written for a different contract (#3146).

**Behavior:** two independent defenses, one structural and one asserted.

**Structural — the `PATH` branch.** The launcher's `PATH` resolution branch looks for **`gsd_run`** instead of `gsd-tools`. Only this package publishes `gsd_run`; the predecessor publishes `gsd-tools` and `gsd-sdk`. Our `gsd_run` follows its own symlink chain and executes the `gsd-tools.cjs` sitting **beside it**, so resolving it cannot land on a foreign handler.

**Asserted — every other branch.** The path-based branches (a project-local install, a runtime config directory) have no such guarantee: they trust their configured location. So once resolution finishes, and before any verb runs, the preamble probes the tool it picked with `runtime-identity --raw` and matches the answer **anchored** against the compact payload. It exports the result as a two-valued `GSD_IDENTITY_STATUS` (`ok` / `unverified`) and, when it is `unverified`, prints one actionable line naming both plausible causes. The same `gsd-tools runtime-identity` verb remains available by hand, so a human or a support thread can settle "which tool am I actually running?" in one command.

**The match is anchored at both ends, not a substring.** A substring search for `@opengsd/gsd-core` accepts the decoy `{"packageName":"get-shit-done-cc","note":"@opengsd/gsd-core"}`, which any colliding package could publish. The preamble instead requires the payload to *begin* with `{"packageName":"@opengsd/gsd-core"` **and to end with a closing brace**, so a truncated answer fails as well. Closing on `}` costs nothing in future-proofing: a JSON object's own brace is always the last character, whatever type the last value has.

**The status is a value, not prose.** `GSD_IDENTITY_STATUS` exists so the gate can be tested — and read by a later step — without anyone parsing the warning text.

**The byte budget is why the assertion arrived second.** The preamble is inlined into 113 shipped files, several of which sat within **single-digit bytes** of frozen size ceilings — `agents/gsd-verifier.md` had 2 bytes of headroom — and those caps are red lines, not budgets. A first attempt to inline an assertion broke five of them. What made it fit was collapsing the resolver's twenty near-identical `elif [ -f … ]` arms into a single candidate-list helper, which is worth far more bytes than the assertion costs: the preamble is now **1,876 bytes smaller** than the version that carried no assertion at all, so every one of the 113 files moved *away* from its ceiling.

**It fails closed.** If no `gsd_run` is reachable, the resolver falls through its remaining path-based branches and finally errors with an install command. It does not fall back to executing whatever `gsd-tools` happens to be on `PATH` — that fallback *was* the vulnerability.

**A doubly-sourced preamble cannot build a recursive launcher.** `command -v gsd_run` finds the shell *function* on a second source and would return the bare string `gsd_run`, defining the function in terms of itself. `unset -f gsd_run` leads that branch, so the second source resolves exactly as the first did. (An executability guard was tried here instead and removed: it rejected the bare name, fell through every branch, and hit the resolver's `exit 1` — which, in a *sourced* script, kills the caller's shell.)

**Known limits:**
- **The assertion warns; it does not yet stop the run.** The rollout is warn-then-fail. It cannot hard-fail yet because an `@opengsd/gsd-core` older than the `runtime-identity` verb answers exactly as a foreign package does — neither answers — and at rollout the old-version case is the common one. The warning therefore names both causes. A later release turns `unverified` into a refusal.
- An installation old enough to predate `bin/gsd_run` ([#381](https://github.com/open-gsd/gsd-core/issues/381)) is not reachable through the `PATH` branch and must be upgraded or invoked through one of the path-based branches.
- The probe costs one extra process launch per preamble source. It is a pure local read of baked coordinates, deliberately kept off the SDK bridge for that reason.

**Reference:** [`runtime-identity`](COMMANDS.md#runtime-identity) · [Diagnose which gsd-tools is running](how-to/diagnose-a-foreign-gsd-tools.md)

---

_Generated by `scripts/gen-features.cjs` — add a fragment under `docs/features/` and run `--write`._
