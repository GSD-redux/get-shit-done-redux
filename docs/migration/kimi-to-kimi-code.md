# Migrating from `--kimi` to `--kimi-code`

> **When:** you installed GSD via `--kimi --global` but you're actually running **Kimi Code** (Moonshot's Node CLI, `~/.kimi-code/config.toml`), not **Kimi CLI** (Moonshot's Python CLI, `~/.kimi/config.toml`).

## Symptom

Before the Phase 1 descriptor split (epic #2505), GSD conflated both products under a single `kimi` runtime. If you ran `--kimi --global` on Kimi Code:

- `gsd-tools query agent-skills <name>` returned **empty** (the Python kimi-cli agent YAMLs are inert on Kimi Code).
- Every workflow that called a named GSD subagent (`gsd-planner`, `gsd-executor`, …) **failed at dispatch** (Kimi Code only recognizes `coder`, `explore`, `plan`).
- Every GSD guard hook (the `PreToolUse` guards `gsd-prompt-guard`, `gsd-read-guard`, `gsd-worktree-path-guard`, `gsd-workflow-guard`, and the `PostToolUse` scanner `gsd-read-injection-scanner`) was **silently dormant** (#2304) — the matcher was translated but the payload check wasn't, so the hooks exited 0 on every Kimi-vocabulary tool call.

  > **Scope after the fix (#2547):** normalization makes each hook's *checks* run. It does not make all of them *enforceable* on Kimi. Only **PreToolUse** results are consulted by kimi-cli, so the enforceable blocks are the worktree cross-root write block and the workflow force-add block. `gsd-read-injection-scanner` is **PostToolUse**, whose results kimi-cli discards, so its prompt-injection block does not apply on Kimi regardless of what it emits.

## Which product am I on?

| Check | Kimi CLI (Python) | Kimi Code (Node) |
|---|---|---|
| Config file | `~/.kimi/config.toml` | `~/.kimi-code/config.toml` (`KIMI_CODE_HOME`) |
| Built-in subagents | Custom via YAML (`extend:`, `system_prompt_path`) | Three only: `coder`, `explore`, `plan` |
| Skills discovery | `~/.config/agents/skills` or `~/.agents/skills` | `~/.kimi-code/skills/` (auto, `merge_all_available_skills = true`) |
| Language | Python (`kimi-cli`) | Node |

If `~/.kimi-code/config.toml` exists and `~/.kimi/config.toml` does not, you're on Kimi Code.

## Migration steps

### 1. Re-install with `--kimi-code`

```bash
npx @opengsd/gsd-core --kimi-code --global
```

This installs the correct Agent Skills surface at `~/.kimi-code/skills/gsd-*/SKILL.md` (Phase 2) and activates the Phase 0 guard normalization (the dormant-guard fix). The Phase 5 installer will warn you if you accidentally pick the wrong variant.

### 2. Remove inert Python-kimi-cli artifacts (if any)

If your prior `--kimi` install wrote agent YAMLs (the `kimi-agents` artifact layout) into your config dir, they're inert on Kimi Code — Kimi Code cannot read them. Safe to remove:

```bash
# Only if you previously installed via --kimi and are now on --kimi-code:
rm -rf ~/.config/agents/agents/gsd-*.yaml ~/.agents/agents/gsd-*.yaml 2>/dev/null || true
```

### 3. Verify skills are discovered

After re-install, launch Kimi Code and confirm the GSD skills appear in the `/skill:` menu (or whatever surface Kimi Code uses for auto-discovered Agent Skills). Each `gsd-*` skill should be present at `~/.kimi-code/skills/gsd-*/SKILL.md`.

### 4. Verify agent-skills query

```bash
gsd-tools query agent-skills gsd-planner
```

Should return the planner's prompt content (non-empty) — Phase 3's fallback reads the installed agent prompt on non-Claude runtimes.

## What about workflows that dispatch named subagents?

Phase 4 (epic #2505) added runtime-aware dispatch. Workflows now resolve the subagent type via `gsd_run query resolve-dispatch-type --requested <role> --raw` before dispatching. On Kimi Code, a role like `gsd-planner` resolves to the `plan` built-in; the persona rides `${AGENT_SKILLS_PLANNER}` (Phase 3's fallback) regardless of the resolved type. You do not need to edit any workflow files — the resolution is automatic.

## What about the dormant guards?

Phase 0 (#2304 / PR #2518) made all seven Kimi-surface hooks read Kimi's payload shape, so their checks now run instead of exiting 0 on every call. Re-installing via `--kimi-code --global` picks up the fix automatically — the normalized guard scripts are part of the standard install.

What that does and does not buy you (#2547):

- **Enforceable on Kimi** — the `PreToolUse` blocks: the worktree cross-root write block (`gsd-worktree-path-guard`) and the workflow force-add block (`gsd-workflow-guard`). Kimi awaits `PreToolUse` results and honours a `block`.
- **Not enforceable on Kimi** — `gsd-read-injection-scanner`'s prompt-injection block. It is a `PostToolUse` hook, and kimi-cli's dispatch never inspects `PostToolUse` results, so the block cannot take effect there no matter what the hook emits. On Kimi, treat the read-injection scanner as advisory-only and rely on the prompt-level untrusted-input boundary instead.

## Questions

- **Can I keep both `--kimi` and `--kimi-code` installs?** Yes — they install to separate config dirs (`~/.kimi/` vs `~/.kimi-code/`). Run both if you genuinely use both products.
- **Do I need to uninstall the old `--kimi` install first?** No — `--kimi-code --global` writes to `~/.kimi-code/`, which is separate. But if you no longer use Python kimi-cli, uninstalling the old install keeps things clean: `npx @opengsd/gsd-core --kimi --global --uninstall`.
