'use strict';

/**
 * #3024 review finding 2 — drift guard for LEGACY_NON_REGISTRY_RUNTIME_IDS.
 *
 * isRegisteredRuntimeId() accepts an id if it is either a capability-registry
 * key or a member of the hand-maintained LEGACY_NON_REGISTRY_RUNTIME_IDS set
 * (currently just `grok`). That set is a SECOND hand-maintained proxy for the
 * real predicate — "does this id have a genuine runtime-specific resolution
 * in getGlobalConfigDir, distinct from the generic claude fallback?" —
 * mirroring the exact mistake that caused the grok regression (the registry
 * was the first such proxy, and it silently misclassified grok). Nothing
 * currently stops a third hardcoded branch being added to getGlobalConfigDir
 * without anyone updating the Set.
 *
 * DESIGN (do not "fix" by making production logic derive the answer at
 * runtime): production code stays an explicit, greppable Set. Deriving the
 * predicate at runtime by diffing against a sentinel resolution would make
 * validation depend on a heuristic comparison against that sentinel, which is
 * harder to reason about and could misfire for an id that legitimately
 * shares claude's directory. Instead, THIS TEST derives the ground truth from
 * the compiled module's actual behavior and fails loudly the moment the
 * hand-maintained Set falls out of sync with it, in either direction.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const LIB_PATH = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'runtime-homes.cjs');
const CAPABILITY_REGISTRY_PATH = path.join(ROOT, 'gsd-core', 'bin', 'lib', 'capability-registry.cjs');

const { getGlobalConfigDir, LEGACY_NON_REGISTRY_RUNTIME_IDS } = require(LIB_PATH);
const { runtimes } = require(CAPABILITY_REGISTRY_PATH);

// A sentinel id that is definitely unregistered and has no dedicated branch:
// resolving it teaches us what the generic (claude) fallback path is.
const SENTINEL_ID = 'zzz-not-a-runtime-3024-drift-guard';

/**
 * Every env var a descriptor-driven runtime, or a hardcoded branch, reads to
 * override its resolved directory. Derived from the registry itself (not
 * hand-copied) plus the one variable consumed by getGlobalConfigDir's grok
 * branch, which lives outside the registry entirely. Cleared for the
 * duration of each test so ambient env vars in the test-runner's environment
 * cannot change a runtime's resolved path out from under the assertions.
 */
function collectDescriptorEnvVars() {
  const vars = new Set(['GROK_AGENTS_HOME']);
  for (const entry of Object.values(runtimes)) {
    const configHome = entry.runtime?.configHome;
    if (configHome?.env) configHome.env.forEach((v) => vars.add(v));
    if (configHome?.skillsHome?.env) configHome.skillsHome.env.forEach((v) => vars.add(v));
  }
  assert.ok(vars.size > 1, 'EMPTY CAPTURE: derived zero descriptor env vars from the capability registry');
  return vars;
}

function clearEnv(keys) {
  const saved = {};
  for (const k of keys) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  return saved;
}

function restoreEnv(saved) {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

/**
 * Parse getGlobalConfigDir's compiled source body for literal
 * `runtime === '<id>'` hardcoded branches (grok's, and any future one). This
 * is enumeration scaffolding only — every id it turns up is then verified
 * BEHAVIORALLY below by actually calling getGlobalConfigDir, never trusted
 * on its own.
 */
function parseHardcodedBranchIds(libSource) {
  const fnMarker = 'function getGlobalConfigDir(';
  const fnStart = libSource.indexOf(fnMarker);
  assert.notStrictEqual(
    fnStart,
    -1,
    'EMPTY CAPTURE: could not locate getGlobalConfigDir in the compiled lib source',
  );
  const nextFn = libSource.indexOf('\nfunction ', fnStart + fnMarker.length);
  const fnBody = nextFn === -1 ? libSource.slice(fnStart) : libSource.slice(fnStart, nextFn);
  assert.ok(fnBody.length > 50, 'EMPTY CAPTURE: getGlobalConfigDir body implausibly short');

  const ids = [];
  const branchIdRe = /runtime\s*===\s*'([^']+)'/g;
  let m;
  while ((m = branchIdRe.exec(fnBody))) ids.push(m[1]);
  assert.ok(
    ids.length > 0,
    'EMPTY CAPTURE: parsed zero hardcoded-branch ids out of getGlobalConfigDir — the regex or function-body bound is broken',
  );
  return ids;
}

/** Resolve `id`, classifying it runtime-specific if it differs from `fallbackPath`. */
function resolveCandidate(id, fallbackPath) {
  try {
    const resolved = getGlobalConfigDir(id);
    return { id, resolved, runtimeSpecific: resolved !== fallbackPath };
  } catch (err) {
    // configHome.kind === 'none' (e.g. vscode) throws instead of resolving —
    // a distinct, deliberate, definitely-not-the-fallback outcome.
    return { id, resolved: `<throws: ${err.message}>`, runtimeSpecific: true };
  }
}

describe('#3024 review finding 2: LEGACY_NON_REGISTRY_RUNTIME_IDS drift guard', () => {
  test('every runtime-specific id is registered or legacy-listed, and every legacy entry still earns its exemption', (t) => {
    const registryIds = Object.keys(runtimes);
    assert.ok(registryIds.length > 0, 'EMPTY CAPTURE: capability registry produced zero runtime ids');

    const legacyIds = Array.from(LEGACY_NON_REGISTRY_RUNTIME_IDS);
    assert.ok(legacyIds.length > 0, 'EMPTY CAPTURE: LEGACY_NON_REGISTRY_RUNTIME_IDS is empty');

    const libSource = fs.readFileSync(LIB_PATH, 'utf-8');
    const sourceParsedIds = parseHardcodedBranchIds(libSource);

    assert.ok(
      !registryIds.includes(SENTINEL_ID) &&
        !legacyIds.includes(SENTINEL_ID) &&
        !sourceParsedIds.includes(SENTINEL_ID),
      `sentinel id ${SENTINEL_ID} unexpectedly collides with a real candidate id — pick a different sentinel`,
    );

    const saved = clearEnv(collectDescriptorEnvVars());
    t.after(() => restoreEnv(saved));

    const fallbackPath = getGlobalConfigDir(SENTINEL_ID);
    assert.ok(
      typeof fallbackPath === 'string' && fallbackPath.length > 0,
      'sentinel resolution produced no usable fallback path',
    );

    const candidates = Array.from(new Set([...registryIds, ...legacyIds, ...sourceParsedIds]));
    const allowed = new Set([...registryIds, ...legacyIds]);
    const resolutions = candidates.map((id) => resolveCandidate(id, fallbackPath));

    const undeclaredSpecific = resolutions
      .filter((r) => r.runtimeSpecific && !allowed.has(r.id))
      .map((r) => r.id);
    assert.deepStrictEqual(
      undeclaredSpecific,
      [],
      `id(s) resolve runtime-specifically but are in neither the capability registry nor ` +
        `LEGACY_NON_REGISTRY_RUNTIME_IDS: ${JSON.stringify(undeclaredSpecific)}. Remedy: add the id(s) to ` +
        `LEGACY_NON_REGISTRY_RUNTIME_IDS in src/runtime-homes.cts (only after confirming the branch is real ` +
        `and intended).`,
    );

    const staleLegacy = legacyIds.filter(
      (id) => !resolutions.find((r) => r.id === id)?.runtimeSpecific,
    );
    assert.deepStrictEqual(
      staleLegacy,
      [],
      `LEGACY_NON_REGISTRY_RUNTIME_IDS entry(ies) no longer resolve runtime-specifically: ` +
        `${JSON.stringify(staleLegacy)}. Remedy: remove the stale entry(ies) from ` +
        `LEGACY_NON_REGISTRY_RUNTIME_IDS in src/runtime-homes.cts.`,
    );

    const grok = resolutions.find((r) => r.id === 'grok');
    assert.ok(grok, 'grok must appear among the resolved candidates');
    assert.strictEqual(
      grok.runtimeSpecific,
      true,
      'grok must resolve runtime-specifically (its hardcoded branch is the reason LEGACY_NON_REGISTRY_RUNTIME_IDS exists)',
    );
  });

  test('gemini (an unregistered id with no dedicated branch) resolves to the generic fallback, not runtime-specifically', (t) => {
    const saved = clearEnv(collectDescriptorEnvVars());
    t.after(() => restoreEnv(saved));

    const fallbackPath = getGlobalConfigDir(SENTINEL_ID);
    assert.strictEqual(
      getGlobalConfigDir('gemini'),
      fallbackPath,
      'gemini must resolve to the same generic fallback as an unregistered id — it has no registry descriptor ' +
        'and no dedicated branch',
    );
  });
});
