# How to resolve an ESLint glob-coverage finding

**Goal:** Turn a `lint-eslint-glob-coverage` failure into either real lint coverage or a recorded, reasoned exemption — so a source file can never again sit in the tree matching no rule at all, linted by nothing, while `eslint .` exits 0.

**Prerequisites:** A failing `tests/eslint-glob-coverage.test.cjs`, or a non-zero `node scripts/lint-eslint-glob-coverage.cjs`. You do not invoke the guard separately in CI — it runs as part of the test suite.

---

## Why this guard exists

ESLint assigns rules by `files:` glob. A file matching **no** glob is not "linted and clean" — it is **not linted at all**, and ESLint reports nothing about it. There is no warning, no summary line, no exit code. The failure is perfectly silent.

That is not hypothetical. Before this guard, 62 tracked source files resolved to zero rules, including all 26 files under `hooks/` — the enforcement machinery itself. One earlier escape hid a real Windows portability defect (a bare `npm` invocation without `{ shell: true }`) in a shared test helper: a rule the repo bans as an **error** in sibling files, surviving purely because the helper was unreachable by the glob.

The guard checks rule **reachability**, not rule **severity**. A file covered entirely by `warn` rules passes here; that is a different gate (`#1885` F17, `--max-warnings 0`).

---

## Read a finding

Each violation names one path and one `kind`:

| `kind` | What it means |
|---|---|
| `uncovered` | The file matches no `files:` glob. Nothing lints it. |
| `allowlist_missing_reason` | An allowlist entry has no `reason` key. |
| `allowlist_empty_reason` | An allowlist entry's `reason` is empty or whitespace. |
| `allowlist_stale` | An allowlisted file **now resolves to rules** — the exemption is obsolete. |
| `allowlist_missing_path` | An allowlist entry names a path that is no longer tracked. |
| `allowlist_duplicate` | The same path is listed twice (usually a merge artifact). |
| `tracked_count_below_floor` | Fewer than 500 tracked source files were found — the guard refuses to report "clean" from an obviously broken file list. |
| `git_failed` | `git ls-files` failed or timed out. The guard degrades to a failure rather than a vacuous pass. |

An `uncovered` finding has exactly two legitimate resolutions. Pick the first one unless you can write down a permanent reason for the second.

---

## Cover it — bring the file under a rule block

**Choose this whenever the file is first-party source that should be linted.** This is the correct resolution in almost every case, and it is what closed 56 of the original 62.

Open `eslint.config.mjs` and add the path to the `files:` array of the block whose ruleset fits:

- CommonJS Node code (`scripts/`, `eslint-rules/`, `bin/lib/`, `pi/`, `examples/`, `vscode/`) → the **CommonJS Node** block.
- Test code → the `tests/**/*.cjs` block.
- TypeScript sources → the `src/**/*.cts` block.

Then run `npx eslint .` and **fix whatever it surfaces**. Do not downgrade a rule's severity to make a new file pass — that converts a real finding into a silent one, which is the failure this guard exists to end.

If the file needs a genuinely different ruleset, add a new block with a comment saying why. `hooks/**` is the worked example: it is covered like other CommonJS Node code, but with `n/no-process-exit` deliberately `off`, because a hook's entire contract is its exit code and several of its exits are load-bearing (a `setTimeout` stdin guard where nothing else would terminate the process). That comment names the evidence, so the next reader does not have to re-derive it.

---

## Allowlist it — record a permanent reason

**Choose this only when the file must never be linted**, and say why. Add an entry to `scripts/lint-eslint-glob-coverage.allowlist.json`:

```json
{
  "path": "tests/fixtures/brand-typing/bad-calibrated-as-sample-basis.cts",
  "reason": "Deliberate MUST-NOT-COMPILE type-error fixture (#3059): type-aware linting would fail by design; it exists to prove the compiler rejects it."
}
```

The `reason` is **structurally required** — an entry with a missing, empty, or whitespace-only reason fails the guard. That is deliberate. The easy way to make a coverage metric look good is to add an exemption, so an exemption has to cost you a sentence you are willing to sign.

⚠️ **"Not linted yet" is not a reason.** An allowlist entry meaning *we will get to it* is a TODO wearing an exemption's badge, and it will outlive everyone who remembers it. If the file should eventually be linted, lint it now.

A file that is **explicitly ignored** — the `gsd-core/bin/lib/**` tsc artifacts under ADR-457 — needs no allowlist entry. Ignored is a recorded decision; unmatched is an accident. The guard already tells them apart.

Note that `bin/install.js` also needs no entry: it resolves to two rules under ADR-1703's deliberately minimal coverage, which is non-empty and therefore passes.

---

## Delete a stale entry

`allowlist_stale` means an allowlisted file now resolves to rules — someone widened a glob and the exemption became dead weight. **Delete the entry.** The allowlist only ratchets down; it can never quietly accumulate.

---

## Verify

```bash
node scripts/lint-eslint-glob-coverage.cjs
```

A pass prints the count it actually checked:

```
ok lint-eslint-glob-coverage: 1175 tracked source file(s), 0 escapes
```

Read that number. If it is implausibly small, the guard's floor should have caught it — but a count that merely *shrank* is worth a second look before you trust the "0 escapes".
