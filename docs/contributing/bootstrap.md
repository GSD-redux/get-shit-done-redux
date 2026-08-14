# Bootstrap your environment

This guide gets a new contributor from a fresh checkout to a passing baseline in one session.

Sources:
- npm engines field: https://docs.npmjs.com/cli/v10/configuring-npm/package-json#engines
- Reproducible builds: https://reproducible-builds.org/docs/source-tree/
- npm ci: https://docs.npmjs.com/cli/v10/commands/npm-ci
- Docker-based Linux verification: https://github.com/open-gsd/gsd-test-runner

---

## Prerequisites

### Node version manager (pick one)

| Tool | Install | Docs |
|---|---|---|
| **nvm** (recommended) | `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/HEAD/install.sh \| bash` | https://github.com/nvm-sh/nvm |
| **fnm** (fast, Rust) | `curl -fsSL https://fnm.vercel.app/install \| bash` | https://github.com/Schniz/fnm |
| **asdf** | `brew install asdf` then `asdf plugin add nodejs` | https://asdf-vm.com |
| **mise** | `curl https://mise.run \| sh` | https://mise.jdx.dev |

A version manager ensures you can switch Node versions per project without polluting your
global install. This project ships a `.nvmrc` file at the root — any of the tools above
will read it.

### Other required tools

- **gh** (GitHub CLI) — https://cli.github.com — used by contribution workflows and CI
- **git** — any recent version

---

## One-time setup

```bash
# 1. Clone
git clone https://github.com/open-gsd/gsd-core.git
cd gsd-core

# 2. Activate the pinned Node version
nvm use          # nvm
# fnm use        # fnm
# asdf install   # asdf / mise

# 3. Verify the environment (see Validation below)
npm run check:env

# 4. Install dependencies (reproducible, lockfile-driven)
npm ci
```

`npm ci` is required over `npm install`. It installs exactly what `package-lock.json`
specifies and fails fast if the lockfile is out of sync — this is intentional.
See https://docs.npmjs.com/cli/v10/commands/npm-ci

---

## Daily commands

| Command | Purpose |
|---|---|
| `npm run check:env` | Validate your environment before running tests |
| `npm test` | Run the full test suite (unit + integration + security) |
| `npm run test:unit` | Unit tests only (fastest) |
| `npm run test:integration` | Integration tests |
| `npm run build:lib` | Type-check root TypeScript and emit CommonJS build output |

> `npm run check:integrity` — available once [#114](https://github.com/open-gsd/gsd-core/issues/114) merges.

---

## Validation

Run the environment validator before any test or audit run:

```bash
npm run check:env
```

This runs `scripts/check-env.cjs` and reports pass/fail for each check:

| Check | What it verifies |
|---|---|
| `node-version` | Active Node satisfies `engines.node` (`>=24.0.0`) |
| `npm-version` | Active npm satisfies `engines.npm` (`>=10.0.0`) |
| `lockfile-present` | `package-lock.json` exists at root |
| `lockfile-sync` | `npm ci --dry-run` exits 0 (lockfile matches installed state) |
| `version-manager-pin` | Active Node major matches `.nvmrc` / `.node-version` / `.tool-versions` |

**Exit codes:**
- `0` — all checks passed, safe to proceed
- `1` — one or more checks failed — see the report
- `2` — tool error (e.g., `node` not found, corrupt `package.json`)

For structured output (useful in scripts):

```bash
npm run check:env -- --json
```

---

## Troubleshooting

### `node-version` FAIL — Node X does NOT satisfy `>=24.0.0`

**Cause:** The system Node is too old, or the version manager hasn't activated the correct version.

**Fix:**
```bash
nvm use          # activates version from .nvmrc
node --version   # confirm
```

If `nvm` reports the version is not installed:
```bash
nvm install      # installs the version in .nvmrc
nvm use
```

---

### `npm-version` FAIL — npm X does NOT satisfy `>=10.0.0`

**Cause:** npm bundled with an old Node version.

**Fix:**
```bash
npm install -g npm@latest
npm --version
```

---

### `lockfile-present` FAIL — `package-lock.json` missing

**Cause:** The lockfile was deleted or was never generated.

**Fix:**
```bash
npm install      # generates package-lock.json
```

Do NOT commit a regenerated lockfile without verifying no unexpected packages changed.
Run `git diff package-lock.json` to inspect the diff.

---

### `lockfile-sync` FAIL — `package-lock.json` is out of sync

**Cause:** `package.json` was edited (dependency added/changed) without updating the lockfile,
or the lockfile was hand-edited.

**Fix:**
```bash
npm ci           # restores node_modules to match lockfile exactly
# or, if the sync failure is intentional (you updated package.json):
npm install      # updates lockfile to match package.json
```

---

### `version-manager-pin` FAIL — Active Node major does not match `.nvmrc`

**Cause:** The shell is using a globally-installed Node rather than the version manager's
activation. Common on fresh shell sessions.

**Fix:**
```bash
nvm use          # re-activate from .nvmrc
# or add to your shell profile:
# echo 'nvm use --silent' >> ~/.zshrc
```

---

### Tests fail with `Error: Cannot find module ...`

**Cause:** `node_modules` is missing or stale (common after a branch switch that changed `package.json`).

**Fix:**
```bash
npm ci           # clean install from lockfile
npm run build:lib
```

---

### Locale / encoding errors on non-UTF-8 systems

**Cause:** Some test fixtures contain non-ASCII characters. Node requires a UTF-8 locale.

**Fix:**
```bash
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
```

Add these to your shell profile to make them permanent.

---

## Alternative: Docker via gsd-test-runner

For canonical Linux verification from a macOS dev box, use
[gsd-test-runner](https://github.com/open-gsd/gsd-test-runner).

This is the same path CI uses for cross-platform coverage. It is the authoritative way
to confirm your change passes on Linux before opening a PR:

```bash
# One-time: install gsd-test-runner (see repo README)
# Then, from the project root:
gsd-test-summary
```

`gsd-test-summary` runs the full suite in a Docker container and emits a concise
`Mac: N failed / Docker: N failed` summary.

- **Default rule (code changes):** both lines must show `0 failed` before a PR is opened.
- **Exception (ADR/doc-only PRs):** if the diff is documentation-only (for example `docs/adr/*.md`, `docs/**/*.md`, `README*.md`) and contains no executable-code or test changes, `gsd-test-summary` is optional.

When using the doc-only exception, note it explicitly in the PR body (for example:
"Doc-only PR; gsd-test-summary not required by docs-only exception in `docs/contributing/bootstrap.md`").
