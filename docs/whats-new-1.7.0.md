# What's new in GSD Core 1.7.0

1.7.0 is the largest surface-expansion release to date since 1.6.1: 32 new features, 44 changes, 100 fixes, and 4 security hardenings. The per-command and per-agent reference (`COMMANDS.md`, `AGENTS.md`, `INVENTORY.md`) is kept current continuously; this page is the thematic tour of what changed and why. For the full per-fragment record, see [`CHANGELOG.md`](../CHANGELOG.md).

---

## Embeddable Orchestration System (EoS): one contract, many hosts

1.7.0 promotes GSD's host integration onto a single **public, versioned Host-Integration Interface** (ADR-1239 Phase A, #1690): six interface points (command, dispatch, model, hooks, state, artifact), eight negotiated axes, and a `PROTOCOL_VERSION` handshake. Descriptors gained an `extensionEvents` vocabulary (#1946).

**14 runtimes now driven through that public interface** instead of bespoke wiring — via *imperative* adapters (OpenCode #2087, Cursor #2089, Cline #2090, Hermes #2091, Qwen #2092, Kilo #2093, Trae #2094, Kimi #2095, Antigravity #2096, Augment #2097) and a *declarative* adapter (Codex #2088), plus full lifecycle-hook wiring for CodeBuddy (#2098), GitHub Copilot (#2099), and Windsurf (#2100). Per-host upgrades landed alongside: Qwen projects GSD's specialist agents as native subagents; Kilo gains native hooks, active-model routing, and named subagent dispatch; Trae carries SOLO stage metadata; Antigravity and Augment register native MCP companions.

**New installable runtimes:** ZCode (Z.ai — a desktop Agentic Development Environment for GLM-5.2, #1925), pi (`npx @opengsd/gsd-core --pi`, #2102), and a repo-local VS Code extension (#1966), now driven through the EoS adapter (#2103).

**Gemini CLI removed** (#1928): Google discontinued Gemini CLI on 2026-06-18, so `--gemini` now prints a deprecation notice pointing to Antigravity CLI, the official successor and already a first-class GSD runtime.

`/gsd-surface` and `--materialize` now produce byte-identical agent output to a fresh install for descriptor-driven runtimes (#1575).

Read more: [Embeddable Orchestration System](explanation/embeddable-orchestration-system.md) · [Host-Integration Interface reference](reference/host-integration-interface.md) · [Interface versioning policy](explanation/interface-versioning-policy.md) · [Install on your runtime](how-to/install-on-your-runtime.md).

---

## Discoverability registries

Two new **non-endorsing** discoverability catalogs (#2182): the **Community Capability Registry** (#2188) for third-party Feature Capabilities installed with `gsd capability install`, and the **EoS Registry** (#2193) for third-party host integrations built on the ADR-1239 interface. Each entry embeds a live release badge and links to a GitHub Discussion. Submitting an entry is a documentation PR (`npm run gen:registry`).

See [GSD Registries](registries/README.md).

---

## Companion MCP server

New **`gsd-mcp-server`** companion MCP server — a stdio JSON-RPC 2.0 server covering interface points 1 and 5 (#1681). OpenCode installs now auto-register it as `mcp.gsd` (#1682). OpenCode also gained the `opencode-subset` hook dialect and `session.idle` handling (#1682), and now runs GSD's lifecycle safety hooks — prompt-injection guard, read-before-edit guard, and injection scanner (#1923).

---

## Model catalog advances

- Codex / OpenAI defaults advance to the **GPT-5.6 family** (Sol / Terra / Luna) (#2122).
- The verbose `(1M context)` model suffix is collapsed to a compact `(1M)` badge (#2160).
- GSD now warns when model config changed without re-running the installer on static-frontmatter runtimes such as Codex and OpenCode (#1688).

See [Configuration — model profiles](CONFIGURATION.md) and [Configure model profiles](how-to/configure-model-profiles.md).

---

## Statusline & compact state

- Opt-in **absolute token count** on the statusline context meter via new `statusline.*` config (#2161).
- Opt-in **git branch + working-state segment** in the statusline (#2163).
- Opt-in **compact GSD-state format** for the statusline (#2162).

---

## Capabilities framework

- A default-off, BETA, Claude-only **Claude orchestration capability** that adopts Claude Code's Workflow tool (#1143) — see the [explanation](explanation/claude-orchestration-capability.md).
- A default-off **external-job capability** to externalize long-running compute as async jobs (SLURM submission) (#1165), configured via `external_job.submit_timeout_ms` / `poll_timeout_ms` / `artifact_dir` (#1164).
- Third-party capability gates now fire through a generic **`command-exit-zero`** predicate (#2008); a capability that fails to load now fails **open** with a loud warning instead of blocking the whole project (#2009).

---

## Planning, verification & workflow

- The **API-coverage gate** (#1562): a phase that integrates an external API/SDK/service cannot seal `/gsd-verify-work` without a decided coverage matrix.
- `plan-phase` now authors edge and prohibition predicates into `PLAN.md` `must_have` (#1154), and the **honest verifier** abstains (`human_needed`) on non-inferable `backstop` truths instead of confidently false-passing them (#1154).
- A plural/optional/chosen **assumption-delta checkpoint** during planning re-asks identity-model questions when cardinality changes (#1561).
- `/gsd-ui-phase` gains a **UI state-coverage probe** (#1979); `/gsd-review` supports **custom reviewer instances** (#1517).
- New `gsd-tools state rebuild` re-derives STATE from source (#1830); `graphify.graph_path` makes the knowledge-graph location configurable so one umbrella graph can serve several projects (#1825).
- GSD subagents now self-load configured `agent_skills` regardless of orchestrator bash (#1866); GSD warns when a stale global CLI shadows your project-local install (#1754).

---

## Security hardening

| Area | Change |
|---|---|
| Human-gated checkpoints | `gate="blocking-human"` checkpoints are no longer auto-approved by the execute-phase orchestrator; the package-legitimacy gate escalates them for human vetting (#2107). |
| Parser DoS | Phase/roadmap/plan markdown parsing hardened against quadratic-time (ReDoS) CPU exhaustion (#2128). |
| Install confinement | Installer writes are confined to the declared config home — crafted/absolute paths, path-separator agent names, and pre-existing escaping symlinks are refused before any write (#1725). |
| Descriptor confinement | The installer rejects any runtime-descriptor `destSubpath` that would write or delete outside the user's config home — path traversal, the config root itself, NUL bytes, escaping symlinks (ADR-1239 Phase B, #1706). |

---

## Fixes at a glance

100 fixes landed in this release, clustered around a handful of recurring themes rather than listed individually:

- **Markdown table & phase/roadmap/state integrity** — edits confined to their own section, milestone-grouped ROADMAP progress tables read by column name, foreign-prefixed IDs no longer collapse to numeric phases (#2056, #2104, #2137, #2253).
- **Windows & cross-platform** — PowerShell hooks (#2236), Linuxbrew node path (#2185), CRLF-safe STATE parsing (#2253), Windows path-quoting and a `find.exe` storm (#2020, #1746).
- **Cross-AI reviewers** — Antigravity (#2073, #2176), OpenCode (#1936), and Codex (#1709) reviewers no longer silently return empty or blind reviews.
- **Capabilities & install** — third-party capability skills now surface after install (#2054), `capability state` / `loop render-hooks` accept `--runtime` (#2003), the installer host-version gate accepts real `engines.gsd` (#1938).
- **Config & state** — `config-set <key> null` now clears the key (#2058), custom STATE.md frontmatter keys are preserved across mutations (#2202).
- **Ship, verify & milestone lifecycle** — `/gsd-ship` now pushes its STATE note (#2138), verify-work preserves state across gap-closure (#1921), `milestone complete` no longer closes out of order (#2111) and honors `--dry-run` (#2118).

See [`CHANGELOG.md`](../CHANGELOG.md) for the complete, itemized list.

---

## See also

- [Feature reference](FEATURES.md) · [Embeddable Orchestration System](explanation/embeddable-orchestration-system.md) · [GSD Registries](registries/README.md) · [Full changelog](../CHANGELOG.md) · [docs index](README.md)
