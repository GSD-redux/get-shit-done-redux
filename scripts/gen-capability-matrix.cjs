#!/usr/bin/env node
'use strict';

/**
 * gen-capability-matrix.cjs — ADR-1244 Phase 6 (Decision D9).
 *
 * Generates docs/reference/capability-matrix.md FROM the committed capability
 * registry (gsd-core/bin/lib/capability-registry.cjs), so the matrix can never
 * drift from the actual capability set. Kept honest by a drift guard
 * (tests/capability-matrix-sync.test.cjs runs `--check`).
 *
 * The matrix is RELEASE-STABLE by design: it does NOT embed each capability's
 * exact `version` (which tracks the GSD package version in lockstep and would
 * churn the committed file — and trip the drift guard — on every release). It
 * shows `engines.gsd` (the stable host-compatibility RANGE) instead, and notes
 * the version-lockstep rule in prose. The committed matrix therefore changes
 * only on intentional capability edits (add/remove a capability, change its
 * tier/role/engines/extension-points/hook-kinds) — never on a version bump.
 *
 * Usage:
 *   node scripts/gen-capability-matrix.cjs            # print to stdout
 *   node scripts/gen-capability-matrix.cjs --write    # write the committed file
 *   node scripts/gen-capability-matrix.cjs --check    # exit 1 if the committed file is stale
 */

const fs = require('fs');
const path = require('path');
const { ExitError, runMain } = require('./lib/cli-exit.cjs');

const ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'capability-registry.cjs');
const MATRIX_PATH = path.join(ROOT, 'docs', 'reference', 'capability-matrix.md');

/** Canonical loop extension points, in order (mirrors the phase loop). */
const LOOP_POINTS = [
  'discuss:pre', 'discuss:post',
  'plan:pre', 'plan:post',
  'execute:pre', 'execute:wave:pre', 'execute:wave:post', 'execute:post',
  'verify:pre', 'verify:post',
  'ship:pre', 'ship:post',
];
const POINT_ORDER = new Map(LOOP_POINTS.map((p, i) => [p, i]));

/**
 * Build a capId → { points:Set, kinds:Set } map from the registry's byLoopPoint
 * index — the authoritative record of which loop points each capability registers
 * into and with which hook kind (step / contribution / gate).
 */
function extensionsByCapability(registry) {
  const out = new Map();
  const byPoint = registry.byLoopPoint || {};
  const KIND = { steps: 'step', contributions: 'contribution', gates: 'gate' };
  for (const point of Object.keys(byPoint)) {
    const reg = byPoint[point] || {};
    for (const arrKey of ['steps', 'contributions', 'gates']) {
      for (const hook of reg[arrKey] || []) {
        const capId = hook && hook.capId;
        if (typeof capId !== 'string') continue;
        let e = out.get(capId);
        if (!e) { e = { points: new Set(), kinds: new Set() }; out.set(capId, e); }
        e.points.add(point);
        e.kinds.add(KIND[arrKey]);
      }
    }
  }
  return out;
}

function fmtPoints(set) {
  if (!set || set.size === 0) return '—';
  for (const p of set) {
    // Surface a typo'd/unknown loop point at generation time rather than silently sorting it last.
    // The registry validates point names at load, so this should never fire — but if it does, the
    // generator (not a confused reader) is where it must be caught.
    if (!POINT_ORDER.has(p)) {
      process.stderr.write(`gen-capability-matrix: WARNING — unknown loop point "${p}" (not one of the ${LOOP_POINTS.length} canonical points)\n`);
    }
  }
  return [...set]
    .sort((a, b) => (POINT_ORDER.has(a) ? POINT_ORDER.get(a) : 99) - (POINT_ORDER.has(b) ? POINT_ORDER.get(b) : 99) || a.localeCompare(b))
    .map((p) => '`' + p + '`')
    .join(', ');
}

function fmtKinds(set) {
  if (!set || set.size === 0) return '—';
  const order = { step: 0, contribution: 1, gate: 2 };
  return [...set].sort((a, b) => (order[a] ?? 9) - (order[b] ?? 9)).join(', ');
}

function fmtEngines(cap) {
  const g = cap && cap.engines && cap.engines.gsd;
  return typeof g === 'string' && g ? '`' + g + '`' : '—';
}

/** Render one capability table (rows sorted by id) for the given role. */
function renderTable(caps, role, extByCap) {
  const rows = caps
    .filter((c) => c.role === role)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((c) => {
      const ext = extByCap.get(c.id) || { points: null, kinds: null };
      return `| \`${c.id}\` | ${c.role} | ${c.tier || '—'} | ${fmtEngines(c)} | ${fmtPoints(ext.points)} | ${fmtKinds(ext.kinds)} | first-party |`;
    });
  return [
    '| id | role | tier | engines.gsd | extension points | hook kinds | source |',
    '|---|---|---|---|---|---|---|',
    ...rows,
  ].join('\n');
}

function buildMatrix(registry) {
  const caps = Object.values(registry.capabilities || {});
  const extByCap = extensionsByCapability(registry);
  const featureTable = renderTable(caps, 'feature', extByCap);
  const runtimeTable = renderTable(caps, 'runtime', extByCap);
  // ADR-2782 D3 added a third role. Rendering only feature+runtime silently
  // DROPPED every role:"reviewer" capability from the catalogue — and because
  // `--check` compares generated output against the committed file, both omitted
  // them identically, so the drift guard reported "up to date" while five shipped
  // capabilities were invisible. A guard blind to a whole role is not guarding.
  const reviewerTable = renderTable(caps, 'reviewer', extByCap);
  const featureCount = caps.filter((c) => c.role === 'feature').length;
  const runtimeCount = caps.filter((c) => c.role === 'runtime').length;
  const reviewerCount = caps.filter((c) => c.role === 'reviewer').length;

  return `# Capability matrix reference

> **Generated file — do not edit by hand.**
> This matrix is generated from the capability registry by
> \`scripts/gen-capability-matrix.cjs\` and kept honest by a drift guard
> (\`tests/capability-matrix-sync.test.cjs\` runs \`--check\`). Any manual edit is
> overwritten on the next generation run. To change a capability's declared
> metadata, edit the corresponding \`capabilities/<id>/capability.json\` and run
> \`node scripts/gen-capability-matrix.cjs --write\`.

See also: [ADR-1244](../adr/1244-capability-ecosystem.md) —
[Capability manifest fields](#manifest-field-reference) —
[The capability trust model](../explanation/capability-trust-model.md)

---

## Column definitions

| Column | Description |
|---|---|
| **id** | Canonical capability identifier; unique across first- and third-party capabilities. Reserved prefixes: \`gsd-\`, \`gsd-core-\`, \`anthropic-\`. |
| **role** | \`feature\` — extends what the loop does; \`runtime\` — adapts GSD to a specific AI runtime/IDE. |
| **tier** | \`core\` — always active; \`standard\` — active when the runtime supports it; \`full\` — opt-in or runtime-specific. |
| **engines.gsd** | Semver RANGE expressing host-version compatibility. A hard gate at install and at load. \`—\` means the capability declares no range. |
| **extension points** | The loop points this capability registers hooks into (from the registry's \`byLoopPoint\` index). \`—\` means it registers none (typical for runtime capabilities, whose job is surface emission). |
| **hook kinds** | Which of \`step\`, \`contribution\`, \`gate\` the capability's hooks use. \`—\` means none. |
| **source** | \`first-party\` — ships with GSD Core; \`third-party\` — installed from an external source via \`gsd capability install\`. |

> **On versions.** This matrix intentionally omits a per-capability \`version\`
> column. First-party capabilities are versioned **in lockstep** with the GSD
> Core package (their \`capability.json\` \`version\` always equals the GSD release
> version), so a per-row version would simply repeat the package version and
> churn the committed file on every release. The stable host-compatibility
> signal — \`engines.gsd\` — is shown instead. A third-party capability's exact
> version is recorded in the per-runtime ledger (\`.gsd-capabilities.json\`) at
> install time.

---

## Native (first-party) capabilities

First-party capabilities are implicitly trusted: they ship as part of the GSD
Core package and are stamped with the package version at release (per
ADR-1244 D6). They are not subject to the consent or integrity-pin flow applied
to third-party capabilities.

### Feature capabilities (role: feature) — ${featureCount}

Feature capabilities extend what the loop does — contributing research,
planning, execution, verification, or ship artefacts at the loop extension
points.

${featureTable}

### Runtime capabilities (role: runtime) — ${runtimeCount}

Runtime capabilities adapt GSD to a specific AI runtime or IDE — emitting
skills, agents, hooks configuration, and surface files for that host. They
typically register no loop hooks (their primary responsibility is surface
emission), so their extension-point and hook-kind cells are \`—\`.

${runtimeTable}

### Reviewer capabilities (role: reviewer) — ${reviewerCount}

Reviewer capabilities declare a cross-AI **reviewer lane** — one external CLI or
model endpoint \`/gsd:review\` hands a plan to (ADR-2782 D3). They are not install
targets: they emit no skills, agents, hooks or surface files, so their
extension-point and hook-kind cells are \`—\`. A host that is *also* a reviewer
(Claude, Codex, Cursor, OpenCode, Qwen, Antigravity) keeps one manifest and
appears under **runtime** above, carrying its lane alongside its runtime body;
only lanes that GSD never installs into appear here.

Because a lane receives the plan text, requirements, research findings and
\`CONTEXT.md\` decisions, it is a disclosed executable surface and is consent-gated
at install like any other — see
[the trust model](../explanation/capability-trust-model.md).

${reviewerTable}

---

## Third-party capabilities

This matrix is the **first-party catalogue**: it is generated from the committed
registry and therefore lists only the capabilities that ship with GSD Core.
Installed third-party capabilities are NOT written into this committed file. Once a
user installs one via \`gsd capability install <spec>\` it enters the **runtime
registry overlay** (ADR-1244 D2); the overlay-aware view of what is installed on a
given machine is \`gsd capability list\` (see the
[\`gsd capability\` command reference](gsd-capability-command.md)), which reports
first-party and installed third-party capabilities together using the same column
fields described below, with \`source\` = \`third-party\`.

### Column values for third-party rows

| Column | Value |
|---|---|
| **id** | As declared in \`capability.json\`. Must not use reserved prefixes (\`gsd-\`, \`gsd-core-\`, \`anthropic-\`). |
| **role** | \`feature\` or \`runtime\`, as declared. |
| **tier** | \`core\`, \`standard\`, or \`full\`, as declared. |
| **engines.gsd** | Range from \`capability.json\`; verified at install and at each load. |
| **extension points** | The loop points the capability registers into, validated against the known 12 identifiers. |
| **hook kinds** | \`step\`, \`contribution\`, and/or \`gate\` as declared. Disclosed in the consent summary at install. |
| **source** | \`third-party\` |

### Community registry

Whether GSD operates or advertises a central community registry of third-party
capabilities is **TBD/TBA** (PRD). The matrix mechanic and all manifest fields
ship regardless of that decision; URL/git/npm/tarball import does not depend on
a central registry.

---

## Manifest field reference

The fields below are defined in \`capability.json\` and govern how a capability
appears in this matrix. For the full schema, see
[ADR-1244 D1](../adr/1244-capability-ecosystem.md#d1--versioned-capability-manifest)
and the [capability manifest reference](capability-manifest.md).

| Field | Required | Type | Purpose |
|---|---|---|---|
| \`version\` | **Yes** | semver string | Capability version. The registry rejects manifests without it. |
| \`engines.gsd\` | Recommended | semver range | Host-version compatibility gate. Enforced at install and load. |
| \`compatVersions\` | No | object: cap-version → gsd-range | Graceful-downgrade table for sources that enumerate versions (git tags, registry, npm). |
| \`integrity\` | No | \`sha512-<base64>\` | SHA-512 digest of the fetched bundle. Verified before extraction when present; mismatch aborts. |
| \`provenance\` | No | \`{ sourceRepo, commit }\` | Source provenance; populated in CI for first-party/curated capabilities. |

---

## Related documents

- [ADR-1244 — Capability Ecosystem](../adr/1244-capability-ecosystem.md)
- [The capability trust model](../explanation/capability-trust-model.md) — why the trust rules are structured as they are
- [The phase loop](../explanation/the-phase-loop.md) — the 12 loop extension points in context
- [Capability manifest reference](capability-manifest.md) — the full \`capability.json\` schema
- [ADR-857](../adr/857-capability-system.md) — the original capability architecture (D7/D8 extended by ADR-1244)
`;
}

function loadRegistry() {
  delete require.cache[require.resolve(REGISTRY_PATH)];
  return require(REGISTRY_PATH);
}

/** Normalize CRLF→LF + ensure a single trailing newline, for cross-platform compare. */
function normalize(s) {
  return s.replace(/\r\n/g, '\n').replace(/\n+$/, '\n');
}

function main() {
  const flag = process.argv[2];
  const registry = loadRegistry();
  const content = buildMatrix(registry);

  if (flag === '--check') {
    let committed;
    try {
      committed = fs.readFileSync(MATRIX_PATH, 'utf8');
    } catch {
      throw new ExitError(1, `${path.relative(ROOT, MATRIX_PATH)} is missing. Run:\n  node scripts/gen-capability-matrix.cjs --write`);
    }
    if (normalize(committed) !== normalize(content)) {
      throw new ExitError(1, `${path.relative(ROOT, MATRIX_PATH)} is stale. Run:\n  node scripts/gen-capability-matrix.cjs --write`);
    }
    console.log(`${path.relative(ROOT, MATRIX_PATH)} is up to date.`);
    return;
  }
  if (flag === '--write') {
    fs.mkdirSync(path.dirname(MATRIX_PATH), { recursive: true });
    fs.writeFileSync(MATRIX_PATH, content, 'utf8');
    console.log(`Wrote ${path.relative(ROOT, MATRIX_PATH)}`);
    return;
  }
  process.stdout.write(content);
}

if (require.main === module) runMain(main);

module.exports = { buildMatrix, extensionsByCapability };
