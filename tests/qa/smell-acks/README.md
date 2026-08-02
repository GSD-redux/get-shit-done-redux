# tests/qa/smell-acks/

Per-PR acknowledgment fragments for `scripts/qa-smell-ratchet.cjs` (#2966).

## The two terminal states (read this before adding a fragment)

Every smell the ratchet reports must end in exactly ONE of two states — there
is no third "accepted with a good explanation" state:

1. **REAL** — an assigned defect. File it, then add a fragment here citing
   that issue's number.
2. **FALSE POSITIVE** — the oracle (`tests/qa/oracles.cjs`) is wrong. Fix the
   oracle so it stops firing. Do NOT add a fragment for it.

A free-text `reason` can NEVER substitute for a real `issue` — it is at most
an optional human note alongside a real `issue`, never a replacement for one.

## Why fragments, not one shared file

Same reason `.changeset/` and `tests/emitted-drift-acks/` use fragments
instead of one shared mutable document: a single `tests/qa/smell-baseline.json`
that every acknowledging PR has to rewrite guarantees a merge conflict
between any two such PRs in flight at once. A fragment per PR — uniquely
named so concurrent PRs never touch the same file — means two PRs can never
conflict on this seam.

## Shape

One fragment = one acknowledged smell finding:

```json
{
  "version": 1,
  "key": "<fingerprint from the ratchet's failure output>",
  "id": "<oracle id, e.g. value-hygiene>",
  "scenario": "<scenario name, e.g. greenfield-happy-path>",
  "issue": 2966,
  "reason": "<optional human note — never a substitute for issue>"
}
```

`issue` is REQUIRED and must be a positive integer naming the tracking issue
for the underlying defect (a REAL smell) — it is not a PR number and it is
not satisfied by prose. `reason` is OPTIONAL; when present it must be a
non-empty string that is not the literal `TODO(qa-smell-ratchet):`-prefixed
placeholder `--update` writes for a brand-new (untriaged) entry.

A missing, zero, non-integer, or non-numeric `issue` — or a `reason` still
carrying that placeholder text — is rejected by a plain (non-`--update`)
ratchet run, with a message naming exactly which field is wrong.

## Naming

Name the file so nobody else can collide with it: include the tracking issue
number and something identifying the smell, e.g.:

```
tests/qa/smell-acks/2979-untyped-success-smart-entry.json
```

If one PR needs to acknowledge more than one NEW smell, add one fragment
file per smell — do not bundle several findings into one fragment (that
would defeat the "uniquely named, never conflicting" property for a PR that
adds a second smell to an existing fragment someone else is also touching).

## Lifecycle

- The ratchet's failure output for a NEW smell prints a paste-ready skeleton
  for exactly this shape — copy it, fill in the real `issue` number, done.
  There is no "write a reason instead" option: the two legitimate responses to
  a NEW smell are fixing the detector (false positive) or filing a defect and
  citing its issue number (real) here.
- A fragment is honored by `scripts/qa-smell-ratchet.cjs` for as long as it
  exists here, in addition to whatever is already in the committed
  `tests/qa/smell-baseline.json`.
- When a maintainer runs `node scripts/qa-smell-ratchet.cjs --update`, every
  currently-firing smell (including ones only acknowledged via a fragment
  here) is folded into the regenerated `tests/qa/smell-baseline.json`,
  carrying over each fragment's own `issue` (and `reason`, if any). `--update`
  never invents an issue number: a genuinely new, never-acknowledged smell is
  written with `issue: null` and a TODO `reason`, and the very next plain
  (non-`--update`) run REJECTS that entry — forcing a human to triage it
  before it can ship. **Delete the fragment once its entry is folded into the
  baseline** — a fragment left behind after that point is redundant (the
  ratchet will say so, non-fatally, pointing at the exact file) and should be
  removed in the same PR that runs `--update`.
- If the underlying behavior is fixed instead of accepted, delete the
  fragment (or, if it was already folded, let `--update` prune it from the
  baseline as a STALE entry) rather than leaving a dead acknowledgment
  behind.
