# Reviewer Instances (#1517)

Custom reviewer instances for `/gsd:review`: run one model-capable adapter (e.g. OpenCode)
as several independent reviewer identities in a single review pass. Loaded lazily by
`gsd-core/workflows/review.md` when `review.reviewer_instances` is configured. See
[ADR-1517](../docs/adr/1517-reviewer-instances-config-surface.md) for the contract.

---

## Config shape

A `review.reviewer_instances` object under the `review` namespace. Each entry maps an
instance name to `{ cli, model?, agent? }`:

```json
{
  "review": {
    "reviewer_instances": {
      "opencode-deepseek": { "cli": "opencode", "model": "deepseek/deepseek-v4-pro", "agent": "review" },
      "opencode-mimo":     { "cli": "opencode", "model": "xiaomi/mimo-v2.5-pro" }
    },
    "default_reviewers": ["opencode-deepseek", "opencode-mimo", "codex"]
  }
}
```

- Instance name: `^[a-z0-9][a-z0-9-]*$`, must not equal a built-in slug. Validated at
  `config-set` time.
- `cli`: MUST be a known adapter (`KNOWN_REVIEWER_SLUGS`) — never an arbitrary shell command.
- `model`: opaque `provider/model` string, passed through verbatim. GSD does not parse it.
- `agent`: opaque string; honoured only by adapters with a native agent concept (OpenCode
  `--agent` in v1). Ignored by other adapters.

---

## Resolution rules (single source)

The canonical logic lives in `resolveReviewerSelection` / `normalizeReviewerInstances` in
`review-reviewer-selection.cjs`. Apply the SAME rules in the workflow so the two surfaces
cannot diverge (`DEFECT.GENERATIVE-FIX`; parity-locked in
`tests/review-reviewer-instances.test.cjs`).

1. Instances participate ONLY via `review.default_reviewers`. They never appear under `--all`
   or explicit `--<cli>` flags, and there are no per-instance CLI flags.
2. Expand instance references BEFORE the built-in-slug check: an entry that is a key in
   `review.reviewer_instances` is an **instance**; an entry that is a built-in slug is a
   **builtin**.
3. An instance is **available** iff its base `cli` is detected (e.g. `opencode-deepseek` is
   available iff `opencode` is available).
4. An entry that is NEITHER a defined instance NOR a built-in slug is a **hard error** (likely
   a typo'd instance name) — stop and report it. Do NOT silently drop it. (When
   `review.reviewer_instances` is absent entirely, fall back to the legacy unknown-slug
   warn-and-drop behaviour for backward compatibility.)
5. `model`/`agent`/instance-name are opaque: pass them as separate argv elements. They are
   NEVER interpolated into shell strings.

---

## Invocation

An instance resolves **through** a lane; it is not a lane itself (ADR-2782 D8). It takes no part in
the roster, the flag set, or lane uniqueness — which is why an instance heading
(`## OpenCode Review (opencode-deepseek)`) must never be read as a lane section.

Since Phase 5b (#2799) `invoke_reviewers` iterates declared lanes rather than hand-authored per-CLI
blocks, so an instance is invoked through the same single seam as its base lane, with two
substitutions:

```bash
# $INSTANCE_NAME is the reviewer identity (e.g. opencode-deepseek); $INSTANCE_MODEL / $INSTANCE_AGENT
# come from the instance spec. --run-dir is the run-scoped mktemp directory created once in
# gather_context (#2358) — the same directory every lane uses.
#
# The instance's OWN model replaces the lane's configured model, and the output lands under the
# INSTANCE name so two instances of one adapter never overwrite each other.
gsd_run query review-lane invoke \
  --slug "$INSTANCE_CLI" \
  --run-dir "$RUN_DIR" --repo-root "$REPO_ROOT" \
  --model "$INSTANCE_MODEL" ${INSTANCE_AGENT:+--agent "$INSTANCE_AGENT"} \
  --as "$INSTANCE_NAME"
```

`--as` is what makes the run write `{run_dir}/gsd-review-${INSTANCE_NAME}.md` instead of the lane's
own `{run_dir}/gsd-review-<slug>.md`.

Everything the lane declares — probe, prompt channel, output channel, timeout floor, empty-output
policy, handler — applies unchanged to an instance. That is the point of routing instances through
the lane rather than duplicating its invocation: a cross-cutting fix reaches instances for free,
where the previous per-adapter block had to be copied and kept in sync by hand.

Only `opencode` honours an `agent` field in v1; it is ignored by other adapters. `model` and `agent`
are opaque pass-through strings and are NEVER interpolated into a shell string — the runner spawns
with an argv array and `shell: false`.

---

## REVIEWS.md contract

- **Frontmatter `reviewers:`** records the actual identities invoked. For a built-in slug use
  the slug (`opencode`); for an instance use the instance name (`opencode-deepseek`), so
  frontmatter distinguishes the independent voices. Example:
  `reviewers: [opencode-deepseek, opencode-mimo, codex]`.
- **Section headers:** each instance gets its OWN top-level section, headed with the base
  adapter's display name plus the instance name in parentheses:
  `## OpenCode Review (opencode-deepseek)`. Same-cli instances are never collapsed.
- **Shared-adapter caveat:** when ≥2 invoked instances share the same base `cli`, print a
  one-line caveat immediately after the frontmatter (before the first section), e.g.:
  `> Note: opencode-deepseek and opencode-mimo share the opencode adapter; their consensus is cross-model, not cross-tool.`
