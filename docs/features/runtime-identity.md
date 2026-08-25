---
id: 168
title: Runtime Identity
group: v1.7.0 Features
---

**Purpose:** The predecessor package `get-shit-done-cc` publishes a binary named `gsd-tools`, and so does this one. They answer some of the same verb names with **different semantics**. [#3129](https://github.com/open-gsd/gsd-core/issues/3129) is the worked example: `phases.clear` **archives** here and **deletes** there. Both print success-shaped output, and `.planning/` is gitignored by default, so a user lost 43 phase directories with no error, no warning, and nothing recoverable from git. The failure was silent in both directions — the workflow could not tell it had reached the wrong handler, and the handler could not tell it had been called by a workflow written for a different contract (#3146).

**Behavior:** the launcher's `PATH` resolution branch now looks for **`gsd_run`** instead of `gsd-tools`. Only this package publishes `gsd_run`; the predecessor publishes `gsd-tools` and `gsd-sdk`. Our `gsd_run` follows its own symlink chain and executes the `gsd-tools.cjs` sitting **beside it**, so resolving it cannot land on a foreign handler. Separately, `gsd-tools runtime-identity` reports this runtime's package coordinates, so a human or a support thread can settle "which tool am I actually running?" in one command.

**This eliminates the failure rather than reporting it.** An earlier iteration of this work asserted identity inside the shared launcher preamble and warned when it could not be confirmed. That approach was abandoned for two reasons. First, a warning only helps a reader who acts on it. Second, and decisively, the preamble is inlined into 113 shipped files, several of which sit within **single-digit bytes** of frozen size ceilings — `agents/gsd-verifier.md` had 2 bytes of headroom — and those caps are red lines, not budgets. The resolver change is **smaller than what it replaces**, so every one of those files got slightly *further* from its ceiling.

**It fails closed.** If no `gsd_run` is reachable, the resolver falls through its remaining path-based branches and finally errors with an install command. It does not fall back to executing whatever `gsd-tools` happens to be on `PATH` — that fallback *was* the vulnerability.

**A doubly-sourced preamble cannot build a recursive launcher.** `command -v gsd_run` finds the shell *function* on a second source and would return the bare string `gsd_run`; an executability guard rejects a non-path result, so the function can never be defined in terms of itself.

**Known limits:** an installation of this package old enough to predate `bin/gsd_run` ([#381](https://github.com/open-gsd/gsd-core/issues/381)) is no longer reachable through the `PATH` branch and must be upgraded or invoked through one of the path-based branches. The `runtime-identity` verb is a manual diagnostic, not an automatic gate — nothing currently asserts identity on every invocation, which remains open for a future release now that the byte budget is understood. Path-based resolution branches are unchanged and still trust their configured location.

**Reference:** [`runtime-identity`](COMMANDS.md#runtime-identity) · [Diagnose which gsd-tools is running](how-to/diagnose-a-foreign-gsd-tools.md)
