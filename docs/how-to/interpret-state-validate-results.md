# How to interpret `state validate` results

**Goal:** Read a `state validate` report correctly — distinguish *"nothing to report"* from *"could not look"*, so a passing `valid:true` is never mistaken for a guarantee the check actually ran.

**Prerequisites:** A `.planning/STATE.md` file. Run the check with:

```bash
node gsd-tools.cjs state validate
```

For the flag/output reference, see [`state validate`](../COMMANDS.md#state-validate). This guide covers only how to *read and act on* the result.

---

## Read the two fields separately

`state validate` returns two fields that answer two different questions, and conflating them recreates the exact defect (#3162) this command's `scope` field exists to prevent:

| Field | Question it answers |
|---|---|
| `valid` | "Did the drift scan find any problems?" — `true` means **no warnings were raised**. |
| `scope` | "Could the drift scan actually run?" — reports whether the check had what it needed to look. |

`valid` is **never** derived from `scope`. A document the scan could not check at all (`scope` other than `complete`) still reports `valid:true`, because zero warnings really were raised — there just wasn't anything to raise them from. Reading `valid:true` alone as "STATE.md is clean" is the trap: always check `scope` first.

---

## The `scope` reason-code table

| `scope` | What it means | What caused it | What to do |
|---|---|---|---|
| `complete` | The derivation ran over usable input — a resolvable `Current Phase` and, if a matching phase directory exists, a readable disk scan of it. `valid`/`warnings` are a real, trustworthy answer. | Normal operation: STATE.md's phase resolved (from frontmatter or body) and the filesystem was readable. | Trust the result as-is. If `valid:false`, act on the listed `warnings` entries (typically `state sync`). |
| `truncated` | Part of the input was cut short before the scan finished — the phase directory's plan/summary scan hit an internal cap partway through. The `valid` answer may be **incomplete**, not necessarily wrong. | An unusually large phase directory (many plan/summary files) exceeded the scan's bounded window. | Do not treat `valid:true` here as a clean bill of health. Inspect the phase directory directly (`ls .planning/phases/<phase>/`) to confirm counts by hand, or reduce/split the phase's plan set if this recurs. |
| `unscoped` | `Current Phase` could not be resolved from **either** the frontmatter scalar or the body field — there was no phase to scope the disk lookup to, so the drift derivation never ran at all. | Most commonly a freshly-initialized project with no phase set yet (a genuine, supported state). Less commonly, a STATE.md whose `Current Phase` field was dropped or malformed. | If the project has not started a phase yet, this is expected — no action needed. If the project is active and you expect a phase to be set, open STATE.md and check the `current_phase` frontmatter key and the body's `**Current Phase:**` row; run `state sync` to reconstruct it from disk if it is missing. |
| `unreadable` | An input the scan needed could not be consulted at all — either the frontmatter block failed to parse, or a filesystem read (the phases directory scan) failed mid-scan. | An unterminated/malformed YAML frontmatter fence, or a filesystem error (permissions, a race with a concurrent write) while reading `.planning/phases/`. | Treat `valid:true` here as **not trustworthy** — the scan degraded silently before this field existed, and now surfaces that instead of hiding it. Check that STATE.md's frontmatter fence (`---` / `---`) is well-formed, and that `.planning/phases/` is readable by the current user. Re-run `state validate` after fixing either. |

---

## The case this exists for: "`valid:true` — but is it trustworthy?"

If you only ever read `valid`, every one of the four `scope` values above looks identical: `true`. That collapse is the exact bug this field was added to close (#3162) — a STATE.md whose phase lived only in frontmatter used to silently skip the entire drift scan and report `{valid:true, warnings:[]}`, indistinguishable from a phase that was checked and found clean.

So before trusting a green `state validate`, always inspect `scope`:

- **`scope:'complete'`** — trustworthy. The scan ran; `valid:true` means clean.
- **Anything else** — not yet checked, or only partially checked. `valid:true` here means *"no problems were found in what could be looked at,"* which is a materially weaker claim. Use the table above to find out why, and whether that is expected (a fresh project, `unscoped`) or a problem worth fixing (`unreadable`, or a `truncated` scan on a large phase).

A freshly-initialized project is the clearest example of a **legitimate** non-`complete` scope: it reports `{valid:true, warnings:[], scope:'unscoped'}`, which reads as *"nothing was found wrong, and the phase could not be checked"* — not as a defect to fix.

---

## Gate on the result from a script

By default `state validate` exits `0` whatever it finds, so a shell gate needs the
JSON. Pass `--strict` and the exit status carries the verdict instead:

```bash
node gsd-tools.cjs state validate --strict
```

Exit `0` means `valid: true`; any other exit means the report was not clean (drift
warnings, an unreadable STATE.md, or no STATE.md at all).

`--strict` reads `valid`, **not** `scope` — so it stays silent about a scan that could
not run. A degraded scope still reports `valid: true` and still exits `0`. Read `scope`
yourself, exactly as the table above says, before treating a green `--strict` run as a
guarantee the check actually looked.

---

## Related

- [`state validate`](../COMMANDS.md#state-validate) — command reference, flags, and the full output shape
- [`state sync`](../COMMANDS.md#state-sync---verify) — reconstructs STATE.md from disk when drift or a missing `Current Phase` is found
- [Recover and troubleshoot](recover-and-troubleshoot.md) — broader STATE.md recovery guidance
- [docs index](../README.md)
