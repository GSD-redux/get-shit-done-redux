# tests/qa/smell-acks/

Per-PR acknowledgment fragments for `scripts/qa-smell-ratchet.cjs` (#2966).

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
  "reason": "<required, non-empty, real justification — no placeholder text>",
  "pr": 2966
}
```

`pr` may instead be `issue` (also a positive integer) when the acknowledgment
is tied to a tracking issue rather than the PR itself. Exactly one of the two
is required.

A missing/empty `reason`, or a `reason` still carrying the
`TODO(qa-smell-ratchet):` placeholder text `--update` writes for a
brand-new entry, is rejected by a plain (non-`--update`) ratchet run.

## Naming

Name the file so nobody else can collide with it: include your issue/PR
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
  for exactly this shape — copy it, fill in `reason` and `pr`, done.
- A fragment is honored by `scripts/qa-smell-ratchet.cjs` for as long as it
  exists here, in addition to whatever is already in the committed
  `tests/qa/smell-baseline.json`.
- When a maintainer runs `node scripts/qa-smell-ratchet.cjs --update`, every
  currently-firing smell (including ones only acknowledged via a fragment
  here) is folded into the regenerated `tests/qa/smell-baseline.json`,
  carrying over each fragment's own `reason` text. **Delete the fragment once
  its entry is folded into the baseline** — a fragment left behind after that
  point is redundant (the ratchet will say so, non-fatally, pointing at the
  exact file) and should be removed in the same PR that runs `--update`.
- If the underlying behavior is fixed instead of accepted, delete the
  fragment (or, if it was already folded, let `--update` prune it from the
  baseline as a STALE entry) rather than leaving a dead acknowledgment
  behind.
