# How to control which host runtime GSD reports

**Goal:** Make `agent_runtime` — the runtime GSD reports it is running under, and the one it checks for installed agents — say what you actually want, and know *why* it says what it says.

**Prerequisites:** A project with a `.planning/` directory. Read the current answer with:

```bash
node gsd-tools.cjs init plan-phase 1 --raw
```

The JSON carries `agent_runtime`, plus the `agents_dir` / `agents_installed` / `missing_agents` triple derived from it. For the config key itself, see [`runtime`](../CONFIGURATION.md#runtime-aware-profiles-2517).

---

## The ladder, in order

GSD answers "which runtime am I?" from the first of these that produces a value:

| # | Source | Set it by | Wins over |
|---|---|---|---|
| 1 | `GSD_RUNTIME` environment variable | `GSD_RUNTIME=opencode` in the environment | everything below |
| 2 | `runtime` in `.planning/config.json` | `"runtime": "codex"` | detection and the default |
| 3 | **Host detection** (added in v1.11) | nothing — it is automatic | the install marker and the default |
| 4 | **Per-install `.gsd-runtime` marker** (added in v1.12, #3364) | nothing — the installer writes it | the default only |
| 5 | Default | — | — (`claude`) |

Rungs 1 and 2 are *explicit* — you stated an intent, and GSD does not second-guess it. Rung 3 only ever runs when **both** are unset. This is what preserves the behavior of every existing config: if you have ever set `runtime`, nothing about your setup changes.

Rung 4 is what your install was created as: `bin/install.js` writes `<install>/gsd-core/.gsd-runtime`, so a Kimi install with a runtime-neutral `config.json` now reports `kimi` rather than falling to `claude`. It sits BELOW detection on purpose — an exported `CODEX_HOME` says what you are running *right now*, while the marker only says what this tree was installed for.

---

## What detection actually looks at

Detection answers a narrow question — *is this process running inside a Codex session?* — and only from signals Codex itself documents.

| Signal | Where it comes from | Why it is trusted |
|---|---|---|
| `CODEX_SANDBOX` is set and non-empty | Codex injects it into child processes it spawns via Seatbelt | Documented in Codex's own `AGENTS.md`; present in exactly the processes Codex runs, which is where GSD runs |
| `CODEX_SANDBOX_NETWORK_DISABLED` is set and non-empty | Codex injects it when running the shell tool with the network sandbox on | same source |
| `CODEX_HOME` is set **and** `$CODEX_HOME/config.toml` exists | you exported it | Exporting `CODEX_HOME` is you designating a Codex state root; the `config.toml` check confirms the directory is a real one |

Anything else — no signal — means no detection, and rung 4 (the per-install marker) applies, then rung 5.

---

## The two questions this page exists for

### "I'm in a Codex session and it still says `claude`"

Work down the ladder:

| Check | What to do |
|---|---|
| Is `GSD_RUNTIME` set to something else? | `echo $GSD_RUNTIME` — it outranks everything. Unset it, or set it to `codex`. |
| Does `.planning/config.json` have a `runtime`? | An explicit `"runtime": "claude"` wins over detection, by design. Change it or remove the key. |
| Is your Codex sandbox off? | With `sandbox_mode = "danger-full-access"`, Codex sets **neither** sandbox variable, so there is nothing for GSD to detect. This is the most common cause. |
| Still nothing? | Set it explicitly. Detection is a convenience, not a contract — `"runtime": "codex"` in `.planning/config.json` is the supported, permanent answer. |

Detection is deliberately conservative: when it cannot tell, it hands off to the per-install marker (rung 4) and only then to the default, rather than guessing. A wrong `agent_runtime` sends GSD looking for agents in the wrong directory, so silence is the safer failure.

### "It says `codex` and I am not using Codex"

One cause, and it is benign:

> `CODEX_HOME` is exported in your shell profile, and `$CODEX_HOME/config.toml` exists.

GSD treats an explicitly-exported `CODEX_HOME` as you designating a Codex root. If you keep it exported globally but work in another runtime, pin the runtime for that project:

```json
{ "runtime": "claude" }
```

in `.planning/config.json`. Rung 2 outranks detection, so this settles it permanently.

Note what is **not** a cause: simply having Codex installed. GSD never probes the default `~/.codex/config.toml`. That file exists on every machine that has ever run Codex, so treating it as a signal would misreport every other runtime's sessions — which is precisely why the check requires you to have exported `CODEX_HOME` yourself.

---

## What this does not change

Detection moves the **reported** runtime and the agent-installation check that hangs off it. It deliberately does not touch:

- **Model resolution.** Runtime-aware tier resolution still reads the explicit `runtime` config key only. A detected-Codex session does not gain or lose model pins — see [Runtime-aware profiles](../CONFIGURATION.md#runtime-aware-profiles-2517) and [ADR-2313](../adr/2313-codex-passive-model-posture.md).
- **Slash-command style.** GSD still emits `/gsd-<cmd>` unless the runtime was set explicitly; a detected-Codex session does not switch to the `$gsd-<cmd>` shell-var form. Set `runtime` explicitly if you want that.
- **Any file.** Detection reads environment variables and checks for one file's existence. It never writes `~/.gsd/defaults.json`, never edits `.planning/config.json`, and never shells out.
