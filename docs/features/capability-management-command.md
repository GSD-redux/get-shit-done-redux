---
id: 147
title: Capability Management Command
group: v1.43.0 Features
---

**Command:** `gsd capability install | update | remove | list | outdated | disable | enable`

**Purpose:** The user-facing CLI for the ADR-1244 capability ecosystem — install, upgrade, remove, list, check for updates, and toggle GSD capabilities (first-party and third-party overlays) from a registry / git / npm / tarball / local source. Wires the Phase-3/4 lifecycle library (source resolver, install ledger, trust gate) to a command users actually run.

**Behavior:**
- `install <spec> [--integrity sha512-…] [--scope global|project] [--yes] [--shared-file <rel>]…` — resolve (copy-only) → verify integrity / SHA pin → `engines.gsd` gate → disclose executable surfaces → consent (`--yes` grants; without it an executable install aborts after printing the disclosure and writes nothing) → validate → extract → record the ledger.
- `update [<id> | --all] [--scope] [--yes]` — re-resolve the capability's recorded source and upgrade via atomic stage-then-swap; re-consent when the executable set changed; `--all` reports a per-capability outcome and exits non-zero on any partial failure.
- `remove <id> [--purge-data] [--scope]` — strip the ledger-recorded files + marker-isolated shared edits; first-party capabilities are rejected (use the product uninstaller).
- `list [--json]` — first-party + installed overlay capabilities (both scopes) as a JSON array.
- `outdated [--json] [--scope]` — light remote peek of each installed overlay's recorded source (ADR-1244 D6 per-source matrix: git `ls-remote --tags`, npm `view … version` resolving the highest version matching the recorded range, local re-read; tarball → `manual`, registry → `unknown`) reporting `outdated` / `current` / `pinned` / `manual` / `unknown` per capability. A source pinned to an immutable ref (git `#sha:` or `#tag:`, or an exact npm version) is reported `pinned`. A bare git `#<ref>` is classified at the remote: if it resolves exclusively under `refs/tags/` it is an immutable tag → `pinned`; if it resolves to a mutable branch (or is ambiguous) it is `unknown`. Bounded subprocesses (git ≤30s, npm ≤60s) and a failing peek degrades that row to `unknown` without crashing the command. `--json` for machine output, default for a table.
- `disable | enable <id>` — toggle activation state (equivalent to `gsd capability set <id> --off` / `--on`).

**Trust boundary:** install never executes capability code (copy-only staging); executable surfaces require explicit consent; sources are gated by the **project-scoped** `capabilities.strict_known_registries` policy (fail-closed on a malformed/unparseable value); every shared-config write/delete is realpath-confined to the scope root, and a name collision with a user's `mcpServers` entry is never clobbered.

**Reference:** [`gsd capability` command reference](reference/gsd-capability-command.md) · [ADR-1244](adr/1244-capability-ecosystem.md)
