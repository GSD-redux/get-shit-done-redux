# GSD Core security model

> **Explanation** — This document describes *why* GSD Core has the security
> posture it does and *how the layers fit together*. It is not a reference for
> every hook parameter. For the `/gsd-secure-phase` command and its options,
> see [Commands](../COMMANDS.md). For the implementation-level hook
> architecture, see [Architecture § Hook System](../ARCHITECTURE.md#hook-system).
> For the org-wide security baseline (scanner controls, incident checklists,
> ownership model), see [SECURITY.md](../../SECURITY.md).

---

## Why AI-driven development needs a dedicated security posture

A conventional code editor does not execute arbitrary packages on your behalf.
GSD Core does. The research → plan → execute pipeline automates the full path
from "name a package" to "run `npm install <package>`", from "write a
planning artifact" to "use that artifact as an LLM system prompt". Each
automation step removes a human from the loop — and each removal is a
potential attack surface.

GSD Core's security model is built around one organising principle:
**defence in depth**. No single control is assumed to be perfect. Several
overlapping layers each reduce a distinct class of risk, and together they
make the attack surface substantially harder to exploit without eliminating
it entirely. The honest summary at the end of this document explains what the
system cannot protect against.

---

## Layer 1 — Supply-chain protection: the Package Legitimacy Gate

### The threat

AI models hallucinate package names. This is not a fringe failure mode: 2025
research documents roughly 20 % of AI-generated package references as
hallucinated names that do not correspond to legitimate packages. A subset of
those hallucinated names — approximately 43 % in the same research — recur
consistently across prompts, meaning an attacker can observe which names AI
tools commonly produce and pre-register those names on npm, PyPI, or
crates.io with malicious post-install scripts. The technique is called
*slopsquatting*.

The insidious quality of slopsquatting is that a hallucinated name that passes
`npm view` *looks legitimate*. The registry entry proves only that someone
registered the name — not that the package does what the AI said it does, not
that it has any legitimate users, and not that its install scripts are safe.
Without a gate, a hallucinated name would flow undetected through GSD's
researcher → planner → executor pipeline and eventually run as
`npm install <attacker-package>` on your machine.

### How the gate works

The gate operates across three pipeline stages:

**Research stage.** When `gsd-phase-researcher` recommends external packages,
it runs `gsd-tools query package-legitimacy check --ecosystem <npm|pypi|crates>
<pkgs>` against each one. Verdicts (`OK|SUS|SLOP`) are computed from live
registry APIs against thresholds `{ minAgeDays: 30, minWeeklyDownloads: 1000,
requireRepo: true }`, plus terminal short-circuits for non-existence and
suspicious `postinstall` scripts. The results are written to a `## Package
Legitimacy Audit` table in `RESEARCH.md`. Packages tagged `[SLOP]`
(high-confidence hallucination or attacker-registered) are **stripped from
`RESEARCH.md` entirely** before the file is saved. They never reach the
planner.

**Planning stage.** `gsd-planner` reads the Audit table. For any package
tagged `[SUS]` (suspicious: newly registered, low download count, no source
repository, or naming pattern close to a popular package) or `[ASSUMED]`
(sourced from WebSearch rather than direct registry verification), the planner
**inserts a `checkpoint:human-verify` task** before the install step. The
checkpoint includes a direct link to the registry page and specific things to
look for: maintainer history, issue-tracker activity, absence of suspicious
install scripts.

**Execution stage.** If an install fails, `gsd-executor` **surfaces a
checkpoint and stops**. It does not silently try an alternative package name —
which could itself be malicious. This is an explicit rule in the executor's
behaviour (RULE 3 in the executor agent definition).

### Why WebSearch packages are always `[ASSUMED]`

Package names discovered through WebSearch are tagged `[ASSUMED]` regardless
of whether `npm view` succeeds. A package that exists on the registry is not
the same as a package that is safe to install. `npm view` proves registration,
not legitimacy. The `[ASSUMED]` tag triggers the same human-verify checkpoint
as `[SUS]`, ensuring that any unverified web-discovered recommendation always
gets a human review before installation.

### Ecosystem coverage

The gate resolves signals directly from each ecosystem's registry API rather
than a single generic check:

- Node.js: `registry.npmjs.org` (age, repository URL, `postinstall` script)
  plus `api.npmjs.org/downloads` (weekly downloads)
- Python: `pypi.org/pypi/<pkg>/json` (age, repository URL)
- Rust: the crates.io API (age, weekly downloads, repository URL)

This covers cross-ecosystem hallucination, which occurs at roughly 9 %
according to 2025 USENIX research — cases where an AI recommends a package
that exists in one ecosystem but not the one actually in use.

### Graceful degradation

Each registry adapter has a 5-second timeout and returns degraded (all-null)
signals on a failed lookup rather than throwing. Missing signals surface as
`unknown-age` / `unknown-downloads` reasons, which push a package to `[SUS]`
— and `[SUS]` is gated behind the same `checkpoint:human-verify` task as
`[ASSUMED]`. The gate fails toward human review, not silence, and research
and planning proceed normally: nothing here hard-fails on a network or tool
outage.

`slopcheck` is an optional adapter that can only escalate a verdict, never
lower it, and is not the install-or-degrade gate. No shipped configuration
wires it; its absence leaves registry-API verdicts intact rather than
downgrading everything to `[ASSUMED]`.

---

## Layer 2 — Prompt injection defences

### The threat

GSD Core generates Markdown files that become LLM system prompts. The
research pipeline reads external web content; the planning pipeline
incorporates user-supplied text (`--text-file`, `--prd`); the execution
pipeline writes planning artifacts that are later re-read as agent context.
Any user-controlled text flowing into these artifacts is a potential
**indirect prompt injection** vector — an attacker-controlled string that,
once inside a system prompt, attempts to override the agent's instructions or
exfiltrate information.

### How the defences work

GSD Core addresses prompt injection at three levels.

**Input validation (`security.cjs`).** The `gsd-core/bin/lib/security.cjs`
module is the central security utility. It provides:

- Path traversal prevention: user-supplied file paths (`--text-file`, `--prd`)
  are validated to resolve within the project directory, with macOS
  `/var` → `/private/var` symlink resolution handled explicitly
- Prompt injection detection: known injection patterns (role overrides,
  instruction bypasses, system tag injections) are scanned in user-supplied
  text before it enters any planning artifact
- Safe JSON parsing: a wrapper that prevents prototype-pollution attacks via
  crafted JSON payloads
- Shell argument validation: arguments passed to subshell commands are
  validated before use

**Runtime hook: `gsd-prompt-guard.js`.** This hook fires on every Write or
Edit call that targets `.planning/` files. It scans the content being written
for the same injection patterns as `security.cjs` (a subset inlined directly
into the hook for independence — the hook does not `require()` the module, so
it runs even if the module path changes). Detection is **advisory-only**: the
hook logs the finding but does not block the write. The rationale is that a
false-positive block on a legitimate planning write would be more disruptive
than a missed injection in a secondary scan layer.

**Runtime hook: `gsd-read-injection-scanner.js`.** This hook fires on the
output of every Read, WebFetch, and WebSearch tool call. It scans the *content
that was just read or fetched* for injected instructions in untrusted content —
catching cases where an attacker has embedded instructions in a file or remote
resource that GSD is about to incorporate into an agent's context. The 10
research and doc-ingest agents additionally carry a shared `<security_context>`
data/instruction boundary (defined in
`gsd-core/references/untrusted-input-boundary.md`): `gsd-project-researcher`,
`gsd-phase-researcher`, `gsd-ui-researcher`, `gsd-assumptions-analyzer`,
`gsd-advisor-researcher`, `gsd-doc-classifier`, `gsd-doc-synthesizer`,
`gsd-research-synthesizer`, `gsd-ai-researcher`, and `gsd-domain-researcher`.
Any content fetched or read by those agents is treated as data, never as
instructions, regardless of what the content claims to be.

**Opt-in blocking (`security.injection_blocking`).** By default all injection
detections are advisory-only (logged, not blocked). Setting
`security.injection_blocking = true` in `.planning/config.json` (a registered
config key — `gsd config-set security.injection_blocking true`) upgrades
HIGH-confidence detections to **blocking**. Be precise about what this does: the
scanner is a **PostToolUse** hook, so it runs *after* the Read/WebFetch/WebSearch
has already executed and the fetched content is already in the model's transcript.
Blocking does **not** retroactively redact that content — it emits
`decision: "block"`, which halts the agent's next step and feeds the detection back
as the reason, so the agent is stopped from acting further on the flagged result
instead of silently continuing. LOW detections remain advisory under this setting.
This flag is opt-in; the default (advisory-only) is preserved to avoid breaking
existing workflows. The prompt-level boundary above (treat fetched text as data,
never instructions) is the layer that keeps an injection from being *followed* even
while it sits in context; the hook is a coarse pattern pre-filter and circuit-breaker,
not a redactor.

**CI scanner.** `prompt-injection-scan.security.test.cjs` scans all agent, workflow,
and command files for embedded injection vectors as part of the test suite.
This catches injection attempts in the GSD source itself — for example, a
supply-chain attack that modified a workflow file to add a role-override
instruction.

### Read Injection Scanner vs Prompt Guard

The two hooks cover complementary surfaces. `gsd-prompt-guard.js` watches
*writes to planning artifacts* — it catches injection being planted.
`gsd-read-injection-scanner.js` watches *reads and remote fetches* — it catches
injection being ingested from external content (a dependency's README, a
third-party config file, a user-provided document, or any URL fetched via
WebFetch or WebSearch). The in-prompt `<security_context>` boundary in research
agents provides an additional containment layer: even if an injected string
reaches an agent, it is structurally separated from the instruction region.
Together these controls bracket the ingest → store → re-read lifecycle.

---

## Layer 3 — Repository and dependency integrity

Upstream of GSD's runtime behaviour, the `open-gsd` organisation enforces
controls at the repository and package level. These are documented in full in
[`docs/security/baseline.md`](../security/baseline.md) and are summarised
here for completeness.

**Dependency integrity.** All third-party dependencies are pinned via
`package-lock.json` and verified against published checksums before install.
A `scripts/check-npm-integrity.cjs` gate detects invalid versions, missing
packages, and extraneous packages at CI time. This mitigates dependency
confusion and typosquatting attacks against GSD's own dependencies.

**Secret scanning.** Every commit and PR is scanned for hardcoded secrets.
Intentional test fixtures must be annotated with the project-standard
exclusion grammar (see `SECURITY.md` for the annotation format). Un-annotated
suppressions fail CI.

**Locale-safe text scanning.** Output and user-facing strings are scanned for
Unicode homoglyphs, bidirectional override characters, and invisible Unicode —
the class of attacks documented in CVE-2021-42574 ("Trojan Source") that can
hide malicious content in diffs.

---

## Trade-offs and limits

The security model described here meaningfully reduces the attack surface for
AI-driven development. It does not eliminate supply-chain risk.

**What the Package Legitimacy Gate reduces:** The probability that a
hallucinated or attacker-registered package reaches `npm install` without
a human checkpoint. The `[SLOP]` gate removes high-confidence bad packages
entirely; the `[SUS]` / `[ASSUMED]` gates require human review before
execution. This substantially raises the cost of a successful slopsquatting
attack.

**What the Package Legitimacy Gate does not eliminate:** A legitimate package
that is later compromised (account takeover, dependency confusion in its own
tree) is not caught by the registry-API gate, which checks registration
signals at research time. Lock files and `npm audit` at the
dependency-integrity layer are the controls for that class of attack.

**What the prompt injection defences reduce:** The probability that
user-controlled text in planning artifacts successfully overrides agent
instructions. Pattern-matching on known injection forms catches the
common cases; novel jailbreaks or low-signal injections may pass undetected.
The advisory-only posture means detection is logged but not blocked — a
deliberate choice that preserves workflow continuity at the cost of
not hard-stopping on a detection.

**What the prompt injection defences do not eliminate:** A sufficiently
creative injection that does not match known patterns, or an injection that
arrives through a channel the hooks do not cover. The previously uncovered
channel of content injected into a dependency's published README and read by a
subagent browsing documentation is now scanned at ingress by
`gsd-read-injection-scanner.js` (which covers WebFetch and WebSearch output)
and structurally isolated in-prompt by the `<security_context>` boundary in
research agents — but novel jailbreaks and low-signal injections may still pass
undetected. Defence in depth means each layer makes the attack harder, not that
any single layer makes it impossible.

**Reporting vulnerabilities.** Report via private GitHub security advisory at
`https://github.com/open-gsd/gsd-core/security/advisories/new`. Do not open
public issues. See [SECURITY.md](../../SECURITY.md) for the response timeline
and disclosure policy.

---

## Related

- [Commands](../COMMANDS.md) — includes `/gsd-secure-phase` and
  `/gsd-code-review` with security-relevant flags
- [Architecture § Hook System](../ARCHITECTURE.md#hook-system) —
  implementation detail on every hook, its event trigger, and safety properties
- [SECURITY.md](../../SECURITY.md) — vulnerability reporting, org-wide
  security baseline, secret-scan exclusion governance, and dependency
  integrity verification
- [Docs index](../README.md)
