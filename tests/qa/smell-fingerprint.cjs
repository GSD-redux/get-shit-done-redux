'use strict';

/**
 * smell-fingerprint.cjs — a STABLE identity for one QA-walk "smell" finding
 * (see `oracles.cjs`'s `SEVERITY.SMELL`), across runs, temp dirs, and hosts.
 *
 * WHY THIS FILE EXISTS
 * ────────────────────
 * `scripts/qa-smell-ratchet.cjs` needs to answer "is this the SAME smell we
 * already decided about, or a NEW one?" across two runs that never share a
 * filesystem state — every run gets its own `mkdtemp`'d project directory
 * (see `loop-walk.cjs`), so anything that leaks a temp path, a byte count, a
 * timestamp, or free-form prose into the identity would make every run look
 * "new" even when nothing about the underlying behavior changed. That would
 * make the ratchet permanently red (or, worse, silently trained to be
 * ignored) — exactly the failure mode `assertWithinAllowlist`
 * (`scripts/lib/allowlist-ratchet.cjs`) exists to prevent for other guards.
 *
 * STABLE INPUTS ONLY
 * ───────────────────
 * `fingerprint(scenarioName, smell)` composes from exactly four stable
 * fields:
 *   1. `smell.id`      — the oracle id (e.g. `"value-hygiene"`), a closed,
 *                         versioned enum (`ORACLES` in `oracles.cjs`).
 *   2. `scenarioName`  — the scenario's own `name` field, author-chosen and
 *                         fixed at scenario-authoring time.
 *   3. `smell.argv`    — the exact CLI invocation (`step.argv`, an array of
 *                         literal argument strings) joined with a single
 *                         space. This is deterministic: two runs of the same
 *                         scenario always issue the same argv for the same
 *                         step.
 *   4. `smell.subject` — a STRUCTURAL discriminator extracted from the
 *                         oracle's own `subject` payload (see `oracles.cjs`'s
 *                         `OracleOutcome` typedef), via `subjectDiscriminator`
 *                         below. Only whitelisted, provably-stable fields are
 *                         read from `subject` — see that function's header.
 *
 * `smell.detail` (free-form prose, may embed a temp path or a byte count) is
 * NEVER read here. Neither is anything derived from `Date.now()` /
 * `Math.random()` / the process's own PID or hostname — this module performs
 * NO I/O and reads NO ambient state, so `fingerprint()` is a pure function of
 * its two arguments.
 *
 * WHY A HASH *AND* A READABLE COMPOSITE (not one or the other)
 * ──────────────────────────────────────────────────────────────
 * A pure hash (e.g. sha256 of the four fields) is technically sufficient as
 * an identity, but it makes `tests/qa/smell-baseline.json` an opaque blob: a
 * reviewer diffing a PR that touches the baseline sees `"a1b2c3d4e5f6"` roll
 * to `"9f8e7d6c5b4a"` and cannot tell what changed without re-running the
 * ratchet themselves. A pure readable composite (no hash) is diffable but
 * fragile to injection: nothing stops a scenario named `"a|b"` combined with
 * an argv token containing `|` from colliding with an unrelated
 * oracle/scenario/argv/subject tuple that happens to serialize to the same
 * joined string, and JSON.stringify-based hashing of an array does not have
 * that ambiguity (array elements are individually length-prefixed by the
 * serializer's own quoting/escaping rules).
 *
 * The chosen key is therefore BOTH, concatenated as `"<hash>::<readable>"`:
 *   - `<hash>` (first 12 hex chars of sha256 over an unambiguous JSON-array
 *     encoding of the four fields) is the collision-safe, canonical identity
 *     — this is the part any two runs of the same finding are GUARANTEED to
 *     agree on bit-for-bit, regardless of what punctuation an author put in
 *     a scenario name or an argv token.
 *   - `<readable>` (the four fields pipe-joined, human-legible) is what makes
 *     `smell-baseline.json` diffable in a PR review — a reviewer can read
 *     `value-hygiene|greenfield-happy-path|--json-errors init new-project|key=$.agents_dir`
 *     and immediately know what fired, without decoding a hash.
 * Per the brief's "prefer the readable composite as the key if it is
 * deterministic" guidance: the readable half is deterministic here (all four
 * inputs are literal, author-controlled strings/arrays with no free
 * variation run-to-run), so it is safe to keep in the identity rather than
 * discarding it in favor of the hash alone.
 *
 * @module tests/qa/smell-fingerprint
 */

const crypto = require('node:crypto');

/**
 * Deterministically stringify a plain JSON-ish value with object keys sorted
 * recursively, so two structurally-equal objects with keys inserted in a
 * different order always serialize identically. Arrays keep their order
 * (order is semantically meaningful for an array; it is not for object keys).
 *
 * Used only on the small, already-whitelisted `subject.fromScope` /
 * `subject.toScope` scope objects (see `progressScopeOf` in `oracles.cjs`) —
 * never on an arbitrary/attacker-shaped value — so cycle-safety is
 * deliberately NOT handled here (those objects are always flat
 * `{milestoneVersion, milestoneName, workstream}` records).
 *
 * @param {unknown} value
 * @returns {string}
 */
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

/**
 * Extract a stable, human-readable discriminator from an oracle's `subject`
 * payload (see `oracles.cjs`'s `OracleOutcome` typedef for the per-oracle
 * shapes). Reads ONLY fields that are, by construction, free of run-to-run
 * variation:
 *
 *   - `subject.key`               (`value-hygiene`'s JSON-path leaf, e.g.
 *                                  `"$.agents_dir"` — a structural path, never
 *                                  the leaked VALUE at that path, which may be
 *                                  a temp-dir-dependent absolute path)
 *   - `subject.missing`           (`read-only-idempotence`'s absent-input
 *                                  case — a fixed, closed set of field names)
 *   - `subject.fromScope`/`toScope` (`monotonic-progress`'s scope-boundary
 *                                  case — `{milestoneVersion, milestoneName,
 *                                  workstream}`, all literal/author-controlled
 *                                  strings; the sibling `from`/`to`/
 *                                  `fromIndex`/`toIndex` counters on that same
 *                                  subject are deliberately NEVER read here,
 *                                  since counters are exactly the kind of
 *                                  per-run-variable field the brief bans)
 *
 * `subject.argv` (present on `soft-error-exit-zero` / `untyped-success` /
 * `contract-conflict`) is deliberately NOT read here — it duplicates
 * `smell.argv`, which `fingerprint()` already folds in separately, so reading
 * it again here would add nothing but risk drifting out of sync with that
 * field. A `subject.mismatches` array (`read-only-idempotence`'s
 * data-present-but-differs case) is also deliberately NOT read here — its
 * entries embed live stat facts (`size`, `mtimeMs`) that vary by definition
 * between runs, so no discriminator can be derived from it without violating
 * the "no counts" rule; that oracle is a VIOLATION-only check today (never a
 * SMELL — see `oracles.cjs`), so this gap is currently unreachable in
 * practice, but is documented here rather than silently mishandled if that
 * ever changes.
 *
 * @param {unknown} subject
 * @returns {string}
 */
function subjectDiscriminator(subject) {
  if (!subject || typeof subject !== 'object' || Array.isArray(subject)) return '(no-subject)';
  const parts = [];
  if (typeof subject.key === 'string') parts.push(`key=${subject.key}`);
  if (typeof subject.missing === 'string') parts.push(`missing=${subject.missing}`);
  if (subject.fromScope !== undefined) parts.push(`fromScope=${stableStringify(subject.fromScope)}`);
  if (subject.toScope !== undefined) parts.push(`toScope=${stableStringify(subject.toScope)}`);
  return parts.length ? parts.join(';') : '(subject-with-no-stable-discriminator)';
}

/**
 * Compute the stable fingerprint for one smell finding within one scenario.
 *
 * PURITY GUARANTEE: this function performs no I/O, reads no ambient state
 * (`Date.now()`, `Math.random()`, env vars, the filesystem), and its return
 * value is a pure function of `scenarioName` and the four stable fields read
 * off `smell` (see this file's header). Two calls with structurally-equal
 * arguments — even across two separate process invocations, two different
 * temp directories, two different hosts — MUST return byte-identical
 * strings. This is proven empirically in `scripts/qa-smell-ratchet.cjs`'s
 * `--update` flow (fingerprinting the same scenario corpus twice, in two
 * separate `mkdtemp` runs, and diffing the resulting key sets) and in the
 * VERIFY section of the PR that introduced this module.
 *
 * @param {string} scenarioName the owning scenario's `name` field.
 * @param {{id: string, subject?: object, argv?: string[]}} smell one finding
 *   from a step's `smells` array, AUGMENTED with that step's own `argv` (the
 *   raw `runOracles` finding shape from `oracles.cjs` carries `id`/`detail`/
 *   `subject` only — `detail` is intentionally never read by this function;
 *   the caller is responsible for attaching the owning step's `argv`).
 * @returns {string} `"<12-hex-char sha256>::<id>|<scenarioName>|<argv joined
 *   with a space>|<subject discriminator>"`.
 * @throws {TypeError} when `scenarioName` is not a non-empty string or
 *   `smell.id` is not a non-empty string — a fingerprint computed from a
 *   malformed input would silently corrupt the whole ratchet's identity
 *   space, so this fails loudly instead.
 */
function fingerprint(scenarioName, smell) {
  if (typeof scenarioName !== 'string' || scenarioName === '') {
    throw new TypeError(`fingerprint: scenarioName must be a non-empty string, got ${JSON.stringify(scenarioName)}`);
  }
  if (!smell || typeof smell !== 'object' || typeof smell.id !== 'string' || smell.id === '') {
    throw new TypeError(`fingerprint: smell.id must be a non-empty string, got ${JSON.stringify(smell && smell.id)}`);
  }

  const argvJoined = Array.isArray(smell.argv) ? smell.argv.join(' ') : '';
  const subjectPart = subjectDiscriminator(smell.subject);

  const readable = `${smell.id}|${scenarioName}|${argvJoined}|${subjectPart}`;
  const hash = crypto
    .createHash('sha256')
    .update(JSON.stringify([smell.id, scenarioName, argvJoined, subjectPart]))
    .digest('hex')
    .slice(0, 12);

  return `${hash}::${readable}`;
}

module.exports = { fingerprint, subjectDiscriminator, stableStringify };
