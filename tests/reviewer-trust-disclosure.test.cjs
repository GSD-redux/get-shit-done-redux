'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * reviewer-trust-disclosure.test.cjs — behavioral tests for the reviewer lane as a FOURTH
 * executable-surface class inside the capability trust gate (ADR-2782, chore #2796 Phase 3):
 * `discloseExecutableSurfaces`, `collectReviewerLaneSurfaces`, `disclosureSignature`,
 * `executableSetChanged`, `signatureForManifest`, and `evaluateInstallTrust`'s consent-gating rows.
 *
 * Implements every row in `.gsd/phase/chore-2796-reviewer-trust-disclosure/50-test-matrix.md` that
 * carries a Test name (sections A-E). Test names are copied verbatim from the matrix. See
 * `.gsd/phase/chore-2796-reviewer-trust-disclosure/40-design.md` for the behavior table the matrix
 * derives from.
 *
 * Level choice: rows describing WHAT a single lane discloses (B1-B8, C1-C6) call
 * `collectReviewerLaneSurfaces` or `discloseExecutableSurfaces` directly — the cheapest unit that
 * proves the behavior, per `tests/reviewer-manifest-body.test.cjs`'s own established idiom. Rows
 * about signature/re-consent behavior (A3-A10, A13) go through `discloseExecutableSurfaces` +
 * `executableSetChanged`. A11/A12/E3 construct a `Disclosure` object DIRECTLY and call
 * `disclosureSignature` on it: a real capability manifest carries AT MOST ONE `reviewer` body
 * (Phase 2's own validator rejects an array — matrix C2b), so "two lanes" can only be exercised at
 * the `disclosureSignature`-direct level, exactly as that exported function's own contract permits
 * (it operates on a `Disclosure`, not a manifest). D1-D4 exercise `evaluateInstallTrust` +
 * `executableSetChanged` — the real caller shape for the consent-gating rows.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const fc = require('fast-check');

const { cleanup } = require('./helpers.cjs');

const trust = require('../gsd-core/bin/lib/capability-trust.cjs');

// ─── Fixture builders ──────────────────────────────────────────────────────
// House convention (tests/reviewer-manifest-body.test.cjs): builder functions return a VALID
// fixture; an optional `mutator` callback is applied to the FRESH object before it is returned.
// Every call builds a brand-new object — no module-level mutable shared state.

/** A valid `role:'reviewer'` capability manifest carrying a well-formed `spawn`-transport lane. */
function spawnLaneManifest(mutator) {
  const manifest = {
    id: 'test-cap',
    role: 'reviewer',
    title: 'Test Capability',
    description: 'A test capability for the reviewer trust-disclosure test suite.',
    tier: 'standard',
    requires: [],
    version: '1.0.0',
    reviewer: {
      slug: 'my-lane',
      flags: ['--my-lane'],
      transport: 'spawn',
      probe: { kind: 'command-exists', binary: 'my-lane' },
      invoke: {
        binary: 'my-lane',
        args: ['--json'],
        promptChannel: 'stdin',
        outputChannel: 'stdout',
        modelArg: null,
        effortChannel: 'none',
      },
      timeoutFloorMs: 5000,
      emptyOutput: 'stub-with-stderr',
      reviewsSection: 'My Lane',
      evidenceClass: 'source-grounded',
      requiresBinaries: ['my-lane'],
      promptBudgetKey: null,
      handler: null,
    },
  };
  if (mutator) mutator(manifest);
  return manifest;
}

/** A valid `role:'reviewer'` capability manifest carrying a well-formed `openai-http`-transport lane. */
function httpLaneManifest(mutator) {
  const manifest = {
    id: 'test-cap-http',
    role: 'reviewer',
    title: 'Test Capability (HTTP)',
    description: 'A test capability (openai-http lane) for the reviewer trust-disclosure test suite.',
    tier: 'standard',
    requires: [],
    version: '1.0.0',
    reviewer: {
      slug: 'lm-studio-http',
      flags: ['--lm-studio'],
      transport: 'openai-http',
      probe: {
        kind: 'http-reachable',
        hostConfigKey: 'lmStudio.baseUrl',
        path: '/v1/models',
        timeoutMs: 2000,
      },
      invoke: {
        hostConfigKey: 'lmStudio.baseUrl',
        path: '/v1/chat/completions',
        modelDiscovery: 'none',
        effortChannel: 'none',
      },
      timeoutFloorMs: 5000,
      emptyOutput: 'stub-with-stderr',
      reviewsSection: 'LM Studio',
      evidenceClass: 'source-grounded',
      requiresBinaries: [],
      promptBudgetKey: null,
      handler: null,
    },
  };
  if (mutator) mutator(manifest);
  return manifest;
}

/** A lane-free manifest carrying one hook, one command module, and one mcpServer. */
function laneFreeManifestWithSurfaces() {
  return {
    id: 'x',
    hooks: [{ event: 'PostToolUse', script: 'hooks/x.js' }],
    commands: [{ family: 'demo', module: 'demo.cjs', router: 'run' }],
    mcpServers: { srv: { command: 'node', args: ['s.js'], env: { A: '1' } } },
  };
}

/** A hand-built `ReviewerLaneSurface`, mutated in place by `overrides` — used ONLY to exercise
 * `disclosureSignature` directly for a synthetic multi-lane `Disclosure` (see A11/A12/E3). */
function laneSurfaceFixture(overrides) {
  return Object.assign(
    {
      slug: 'a',
      transport: 'spawn',
      binary: 'x',
      args: [],
      rawArgs: [],
      hostConfigKey: '',
      resolvedHost: '',
      isLocalDestination: false,
      promptChannel: 'stdin',
      handler: '',
      egressPayloadClasses: [...trust.EGRESS_PAYLOAD_CLASSES],
    },
    overrides || {},
  );
}

/** A synthetic `Disclosure` carrying only the given `reviewerLanes` — the only way to exercise
 * `disclosureSignature`'s reordering/sort behavior with 2+ lanes, since a real manifest is capped
 * at one `reviewer` body. */
function disclosureWithLanes(lanes) {
  return { hooks: [], commandModules: [], mcpServers: [], reviewerLanes: lanes, hasExecutable: true, missingArtifacts: [] };
}

const LOCAL_SPEC = { kind: 'local', raw: '.', target: '.' };

// The measured PRE-#2796 goldens (task brief) — byte-for-byte, not recomputed.
const GOLDEN_BARE_SIGNATURE = '[[],[],[]]';
const GOLDEN_HOOKS_MODS_MCP_SIGNATURE =
  '[["[\\"hook\\",\\"PostToolUse\\",\\"hooks/x.js\\"]"],["[\\"mod\\",\\"demo\\",\\"demo.cjs\\",\\"run\\"]"],' +
  '["[\\"mcp\\",\\"srv\\",\\"\\",\\"node\\",[\\"s.js\\"],\\"\\",{},{\\"A\\":\\"1\\"},\\"\\",' +
  '{\\"args\\":[\\"s.js\\"],\\"command\\":\\"node\\",\\"env\\":{\\"A\\":\\"1\\"}}]"]]';

// ─── A. Signature stability — the absent-safe invariant (highest consequence) ──────────────

describe('A. Signature stability — the absent-safe invariant', () => {
  test('laneFreeManifestSignatureIsByteIdentical', () => {
    // Regression tripwire: if the lane element were appended unconditionally, both assertions fail.
    assert.equal(
      trust.signatureForManifest({ id: 'bare', role: 'feature', version: '1.0.0' }),
      GOLDEN_BARE_SIGNATURE,
    );
    assert.equal(trust.signatureForManifest(laneFreeManifestWithSurfaces()), GOLDEN_HOOKS_MODS_MCP_SIGNATURE);
  });

  test('laneFreeSignatureIsIndependentOfStagedDir', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-trust-lane-a1b-'));
    try {
      // stagedDir is EMPTY — every declared hook/module artifact is "missing" — yet the signature is
      // over the executable SET, not missingArtifacts (TV-09's own precedent), so it must be
      // identical to the no-stagedDir call.
      assert.equal(
        trust.signatureForManifest(laneFreeManifestWithSurfaces(), dir),
        GOLDEN_HOOKS_MODS_MCP_SIGNATURE,
      );
    } finally {
      cleanup(dir);
    }
  });

  test('laneFreeSignatureKeepsThreeElements', () => {
    const parsed = JSON.parse(trust.signatureForManifest(laneFreeManifestWithSurfaces()));
    assert.equal(parsed.length, 3, `expected exactly 3 elements (no lane element), got ${parsed.length}`);
  });

  test('laneBearingManifestSignatureGainsLaneElement', () => {
    const parsed = JSON.parse(trust.signatureForManifest(spawnLaneManifest()));
    assert.equal(parsed.length, 4, `expected 4 elements once a lane is declared, got ${parsed.length}`);
    assert.equal(parsed[3].length, 1);
  });

  test('addingALaneForcesReconsent', () => {
    const before = trust.discloseExecutableSurfaces({ id: 'x' });
    const after = trust.discloseExecutableSurfaces(spawnLaneManifest());
    assert.equal(trust.executableSetChanged(before, after), true);
  });

  test('removingALaneForcesReconsent', () => {
    const before = trust.discloseExecutableSurfaces(spawnLaneManifest());
    const after = trust.discloseExecutableSurfaces({ id: 'x' });
    assert.equal(trust.executableSetChanged(before, after), true);
  });

  test('changingLaneBinaryForcesReconsent', () => {
    const before = trust.discloseExecutableSurfaces(spawnLaneManifest());
    const after = trust.discloseExecutableSurfaces(
      spawnLaneManifest((m) => {
        m.reviewer.invoke.binary = 'other-binary';
      }),
    );
    assert.equal(trust.executableSetChanged(before, after), true);
  });

  test('changingLaneArgsForcesReconsentEvenWhenBinaryIsUnchanged', () => {
    // #1459's bug class: `python3` with innocuous args later becoming `['-c', '<program>']`.
    const beforeManifest = spawnLaneManifest((m) => {
      m.reviewer.invoke.binary = 'python3';
      m.reviewer.invoke.args = ['--version'];
    });
    const afterManifest = spawnLaneManifest((m) => {
      m.reviewer.invoke.binary = 'python3';
      m.reviewer.invoke.args = ['-c', '<program>'];
    });
    assert.equal(beforeManifest.reviewer.invoke.binary, afterManifest.reviewer.invoke.binary, 'binary must be identical — only args changed');
    const before = trust.discloseExecutableSurfaces(beforeManifest);
    const after = trust.discloseExecutableSurfaces(afterManifest);
    assert.equal(trust.executableSetChanged(before, after), true);
  });

  test('changingHostConfigKeyForcesReconsent', () => {
    const before = trust.discloseExecutableSurfaces(httpLaneManifest());
    const after = trust.discloseExecutableSurfaces(
      httpLaneManifest((m) => {
        m.reviewer.invoke.hostConfigKey = 'otherHost.baseUrl';
      }),
    );
    assert.equal(trust.executableSetChanged(before, after), true);
  });

  test('changingPromptChannelForcesReconsent', () => {
    const before = trust.discloseExecutableSurfaces(spawnLaneManifest());
    const after = trust.discloseExecutableSurfaces(
      spawnLaneManifest((m) => {
        m.reviewer.invoke.promptChannel = 'argv';
      }),
    );
    assert.equal(trust.executableSetChanged(before, after), true, 'promptChannel changes WHAT is sent to the lane');
  });

  test('changingHandlerForcesReconsent', () => {
    const before = trust.discloseExecutableSurfaces(spawnLaneManifest());
    const after = trust.discloseExecutableSurfaces(
      spawnLaneManifest((m) => {
        m.reviewer.handler = 'antigravity';
      }),
    );
    assert.equal(trust.executableSetChanged(before, after), true, 'handler changes what CODE post-processes the output');
  });

  test('changingReviewsSectionDoesNotForceReconsent', () => {
    const before = trust.discloseExecutableSurfaces(spawnLaneManifest());
    const after = trust.discloseExecutableSurfaces(
      spawnLaneManifest((m) => {
        m.reviewer.reviewsSection = 'Totally Different Section';
      }),
    );
    assert.equal(
      trust.executableSetChanged(before, after),
      false,
      'reviewsSection is cosmetic — folding it into the signature would train users to click through a false re-prompt',
    );
  });

  test('reorderingLanesDoesNotForceReconsent', () => {
    // A real manifest carries at most ONE reviewer body (Phase 2 rejects an array), so "two lanes
    // reordered" is exercised by calling disclosureSignature directly on a hand-built Disclosure —
    // exactly the exported function's own documented unit (it operates on a Disclosure, not a
    // manifest).
    const laneA = laneSurfaceFixture({ slug: 'a', binary: 'binary-a' });
    const laneB = laneSurfaceFixture({ slug: 'b', binary: 'binary-b' });
    const forward = trust.disclosureSignature(disclosureWithLanes([laneA, laneB]));
    const reversed = trust.disclosureSignature(disclosureWithLanes([laneB, laneA]));
    assert.equal(forward, reversed, 'reviewerLanes must be sorted before folding, matching the existing hook/mod/mcp treatment');
  });

  test('laneKeyReorderDoesNotForceReconsent', () => {
    const before = spawnLaneManifest((m) => {
      m.reviewer.invoke.args = [{ a: 1, b: 2 }];
    });
    const after = spawnLaneManifest((m) => {
      m.reviewer.invoke.args = [{ b: 2, a: 1 }];
    });
    assert.equal(
      trust.signatureForManifest(before),
      trust.signatureForManifest(after),
      'stableJson recursively sorts keys — a pure key reorder inside a declared arg object must not force re-consent',
    );
  });

  test('changingTimeoutFloorDoesNotForceReconsent', () => {
    const before = trust.discloseExecutableSurfaces(spawnLaneManifest());
    const after = trust.discloseExecutableSurfaces(
      spawnLaneManifest((m) => {
        m.reviewer.timeoutFloorMs = 999999;
      }),
    );
    assert.equal(trust.executableSetChanged(before, after), false, 'timeoutFloorMs is not an executable-surface property');
  });
});

// ─── B. What is disclosed ───────────────────────────────────────────────────

describe('B. What is disclosed', () => {
  test('spawnLaneDisclosesBinaryAndArgs', () => {
    const manifest = spawnLaneManifest((m) => {
      m.reviewer.invoke.args = ['--json', '--verbose'];
    });
    const [surface] = trust.collectReviewerLaneSurfaces(manifest);
    assert.equal(surface.binary, 'my-lane');
    assert.deepEqual(surface.args, ['--json', '--verbose']);
    assert.deepEqual(surface.rawArgs, ['--json', '--verbose']);
  });

  test('spawnLaneDisclosesRawArgsIncludingNonStrings', () => {
    const nested = { mode: 'fast' };
    const manifest = spawnLaneManifest((m) => {
      m.reviewer.invoke.args = ['-p', 7, nested, true];
    });
    const [surface] = trust.collectReviewerLaneSurfaces(manifest);
    assert.deepEqual(
      surface.rawArgs,
      ['-p', 7, nested, true],
      'the FULL declared array — the host receives every member, string or not',
    );
    assert.deepEqual(
      surface.args,
      ['-p'],
      'the rendered (human-summary) form is string-filtered, mirroring MCP argv/rawArgs',
    );
  });

  test('httpLaneDisclosesResolvedHostAndConfigKey', () => {
    const manifest = httpLaneManifest();
    const [surface] = trust.collectReviewerLaneSurfaces(manifest, (key) =>
      key === 'lmStudio.baseUrl' ? 'http://192.168.1.50:1234' : undefined,
    );
    assert.equal(surface.hostConfigKey, 'lmStudio.baseUrl');
    assert.equal(surface.resolvedHost, 'http://192.168.1.50:1234');
  });

  test('httpLaneWithoutResolverMarksHostUnresolved', () => {
    const manifest = httpLaneManifest();
    const [surface] = trust.collectReviewerLaneSurfaces(manifest);
    assert.equal(surface.hostConfigKey, 'lmStudio.baseUrl');
    assert.equal(surface.resolvedHost, trust.UNRESOLVED_HOST_MARKER);
    assert.notEqual(surface.resolvedHost, '', 'a blank reads as "no destination" — must be the explicit marker instead');
  });

  test('localhostDestinationIsStillDisclosed', () => {
    const manifest = httpLaneManifest();
    const [localSurface] = trust.collectReviewerLaneSurfaces(manifest, () => 'http://localhost:8080');
    assert.equal(localSurface.resolvedHost, 'http://localhost:8080', 'localhost is disclosed like any other destination, never omitted');
    assert.equal(localSurface.isLocalDestination, true);

    const [remoteSurface] = trust.collectReviewerLaneSurfaces(manifest, () => 'https://api.example.com');
    assert.equal(remoteSurface.resolvedHost, 'https://api.example.com');
    assert.equal(remoteSurface.isLocalDestination, false, 'a remote destination must be distinguished from a local one');

    // Regression: `new URL('localhost:1234')` does NOT throw — it mis-parses the scheme-less
    // "host:port" shape as an opaque URL whose "scheme" IS the hostname text (protocol:
    // "localhost:", hostname: ""), which would silently fail to flag a bare local config value
    // (no `http://` prefix) as local. `192.168.1.5:8080` exercises the ordinary (throws-then-falls-
    // back) path for a non-local scheme-less value, so it must stay false.
    const [schemelessLocal] = trust.collectReviewerLaneSurfaces(manifest, () => 'localhost:1234');
    assert.equal(schemelessLocal.isLocalDestination, true, 'a scheme-less "localhost:port" config value must still be recognized as local');

    const [schemelessRemote] = trust.collectReviewerLaneSurfaces(manifest, () => '192.168.1.5:8080');
    assert.equal(schemelessRemote.isLocalDestination, false, 'a scheme-less non-loopback host:port must not be misflagged as local');

    const [loopbackIp] = trust.collectReviewerLaneSurfaces(manifest, () => '127.0.0.1:1234');
    assert.equal(loopbackIp.isLocalDestination, true, 'a scheme-less 127.x.x.x:port must be recognized as local');
  });

  test('laneDisclosesEgressPayloadClasses', () => {
    const [surface] = trust.collectReviewerLaneSurfaces(spawnLaneManifest());
    assert.deepEqual(surface.egressPayloadClasses, trust.EGRESS_PAYLOAD_CLASSES);
    assert.notStrictEqual(
      surface.egressPayloadClasses,
      trust.EGRESS_PAYLOAD_CLASSES,
      'must be a fresh copy per surface, not the shared constant reference',
    );
    for (const term of ['plan text', 'requirements', 'research findings', 'CONTEXT.md decisions']) {
      assert.ok(surface.egressPayloadClasses.includes(term), `expected "${term}" among the disclosed egress classes`);
    }
  });

  test('laneDisclosesHandlerName', () => {
    const manifest = spawnLaneManifest((m) => {
      m.reviewer.handler = 'antigravity';
    });
    const [surface] = trust.collectReviewerLaneSurfaces(manifest);
    assert.equal(surface.handler, 'antigravity');
  });

  test('laneOnlyCapabilityRequiresConsent', () => {
    const manifest = spawnLaneManifest();
    const d = trust.discloseExecutableSurfaces(manifest);
    assert.equal(d.hasExecutable, true);
    const verdict = trust.evaluateInstallTrust({ parsed: LOCAL_SPEC, manifest, hostVersion: '1.0.0' });
    assert.equal(verdict.requiresConsent, true);
  });

  test('httpLaneRequiresConsentDespiteSpawningNothing', () => {
    const manifest = httpLaneManifest();
    assert.equal(manifest.reviewer.invoke.binary, undefined, 'an openai-http lane declares no binary at all');
    const d = trust.discloseExecutableSurfaces(manifest);
    assert.equal(d.reviewerLanes[0].binary, '', 'nothing spawns for this lane');
    assert.equal(d.hasExecutable, true, 'a standing egress channel still requires consent even though no process starts');
  });

  test('laneAndHookSurfacesCoexist', () => {
    const manifest = spawnLaneManifest((m) => {
      m.hooks = [{ event: 'PostToolUse', script: 'hooks/check.js' }];
    });
    const d = trust.discloseExecutableSurfaces(manifest);
    assert.equal(d.hooks.length, 1);
    assert.deepEqual(d.hooks[0], { event: 'PostToolUse', script: 'hooks/check.js' });
    assert.equal(d.reviewerLanes.length, 1);
    assert.equal(d.reviewerLanes[0].slug, 'my-lane');
    assert.equal(d.hasExecutable, true);
  });
});

// ─── C. Totality / malformed — disclosure runs BEFORE validation ───────────

describe('C. Totality / malformed', () => {
  test('absentReviewerBodyDisclosesNoLane', () => {
    assert.doesNotThrow(() => trust.discloseExecutableSurfaces({ id: 'x', role: 'feature' }));
    const d = trust.discloseExecutableSurfaces({ id: 'x', role: 'feature' });
    assert.deepEqual(d.reviewerLanes, []);
  });

  test('nullReviewerBodyDisclosesNothing', () => {
    assert.doesNotThrow(() => trust.discloseExecutableSurfaces({ id: 'x', reviewer: null }));
    const d = trust.discloseExecutableSurfaces({ id: 'x', reviewer: null });
    assert.deepEqual(d.reviewerLanes, []);
  });

  test('nonObjectReviewerBodyDisclosesNothing', () => {
    for (const badReviewer of [[], true, 0]) {
      assert.doesNotThrow(() => trust.discloseExecutableSurfaces({ id: 'x', reviewer: badReviewer }));
      const d = trust.discloseExecutableSurfaces({ id: 'x', reviewer: badReviewer });
      assert.deepEqual(d.reviewerLanes, [], `reviewer=${JSON.stringify(badReviewer)} must disclose no lane`);
    }
  });

  test('malformedInvokeStillDisclosesWithoutThrowing', () => {
    for (const badInvoke of [undefined, null, 'garbage', 42, []]) {
      const manifest = spawnLaneManifest((m) => {
        if (badInvoke === undefined) delete m.reviewer.invoke;
        else m.reviewer.invoke = badInvoke;
      });
      assert.doesNotThrow(() => trust.discloseExecutableSurfaces(manifest));
      const d = trust.discloseExecutableSurfaces(manifest);
      assert.equal(d.reviewerLanes.length, 1, `invoke=${JSON.stringify(badInvoke)} must still disclose the lane`);
      assert.equal(d.reviewerLanes[0].binary, '');
      assert.deepEqual(d.reviewerLanes[0].args, []);
      assert.deepEqual(d.reviewerLanes[0].rawArgs, []);
    }
  });

  test('nonArrayFlagsAreIgnoredByDisclosure', () => {
    const manifest = spawnLaneManifest((m) => {
      m.reviewer.flags = 'not-an-array';
    });
    assert.doesNotThrow(() => trust.discloseExecutableSurfaces(manifest));
    const d = trust.discloseExecutableSurfaces(manifest);
    assert.equal(d.reviewerLanes.length, 1);
    assert.equal(d.reviewerLanes[0].slug, 'my-lane', 'a malformed flags field must not disturb the rest of the disclosed lane');
  });

  test('proxyManifestDoesNotBreakDisclosure', () => {
    const proxyManifest = new Proxy(
      {},
      {
        get() {
          throw new Error('boom: get trap');
        },
        has() {
          throw new Error('boom: has trap');
        },
        ownKeys() {
          throw new Error('boom: ownKeys trap');
        },
      },
    );
    assert.doesNotThrow(() => trust.discloseExecutableSurfaces(proxyManifest));
    const d = trust.discloseExecutableSurfaces(proxyManifest);
    assert.equal(d.hasExecutable, false);
    assert.deepEqual(d.reviewerLanes, []);
  });

  test('throwingGetterDoesNotBreakDisclosure', () => {
    const manifest = { id: 'x' };
    Object.defineProperty(manifest, 'reviewer', {
      enumerable: true,
      get() {
        throw new Error('boom: throwing getter');
      },
    });
    assert.doesNotThrow(() => trust.discloseExecutableSurfaces(manifest));
    const d = trust.discloseExecutableSurfaces(manifest);
    assert.deepEqual(d.reviewerLanes, []);
  });

  test('circularArgValueDoesNotBreakSignature', () => {
    const circular = {};
    circular.self = circular;
    const manifest = spawnLaneManifest((m) => {
      m.reviewer.invoke.args = [circular];
    });
    assert.doesNotThrow(() => trust.signatureForManifest(manifest));
    const sig = trust.signatureForManifest(manifest);
    assert.equal(typeof sig, 'string');
    assert.ok(sig.length > 0);
  });

  test('laneBinaryIsNotTreatedAsAMissingBundleArtifact', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-trust-lane-c6-'));
    try {
      const manifest = spawnLaneManifest();
      const d = trust.discloseExecutableSurfaces(manifest, dir);
      assert.deepEqual(
        d.missingArtifacts,
        [],
        'a lane binary is a PATH tool, never a bundle artifact — existence-checking it would block every lane install',
      );
    } finally {
      cleanup(dir);
    }
  });
});

// ─── D. Consent flow — evaluateInstallTrust ────────────────────────────────

describe('D. Consent flow — evaluateInstallTrust', () => {
  test('laneBearingInstallRequiresConsentBeforePromotion', () => {
    const manifest = spawnLaneManifest();
    const verdict = trust.evaluateInstallTrust({ parsed: LOCAL_SPEC, manifest, hostVersion: '1.0.0' });
    assert.equal(verdict.allowed, true);
    assert.equal(
      verdict.requiresConsent,
      true,
      'evaluateInstallTrust is the PURE verdict the (untouched) lifecycle gates promotion on — a ' +
        'true requiresConsent is what forces the consent prompt before any file is promoted',
    );
    assert.equal(verdict.disclosure.reviewerLanes.length, 1);
    const lines = trust.summarizeDisclosure(verdict.disclosure);
    const joined = lines.join('\n');
    assert.match(joined, /my-lane/, 'the human-facing prompt names the lane/binary');
    assert.match(joined, /plan text/, 'the human-facing prompt names the egress payload classes');
  });

  test('decliningLaneConsentWritesNothing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-trust-lane-d2-'));
    try {
      fs.writeFileSync(path.join(dir, 'pre-existing.txt'), 'unchanged');
      const before = fs.readdirSync(dir, { recursive: true }).sort();
      const manifest = spawnLaneManifest();
      const verdict = trust.evaluateInstallTrust({ parsed: LOCAL_SPEC, manifest, stagedDir: dir, hostVersion: '1.0.0' });
      assert.equal(verdict.requiresConsent, true);
      // evaluateInstallTrust never writes, regardless of the (not-yet-made) consent decision — this
      // purity is exactly what makes "decline -> nothing written" true upstream: nothing was ever
      // written by computing the verdict in the first place, so a decline has nothing to undo.
      const after = fs.readdirSync(dir, { recursive: true }).sort();
      assert.deepEqual(after, before, 'evaluateInstallTrust must perform no filesystem writes');
    } finally {
      cleanup(dir);
    }
  });

  test('upgradeWithChangedLaneRequiresReconsent', () => {
    const v1 = trust.evaluateInstallTrust({ parsed: LOCAL_SPEC, manifest: spawnLaneManifest(), hostVersion: '1.0.0' });
    const v2 = trust.evaluateInstallTrust({
      parsed: LOCAL_SPEC,
      manifest: spawnLaneManifest((m) => {
        m.reviewer.invoke.binary = 'my-lane-v2';
      }),
      hostVersion: '1.0.0',
    });
    assert.equal(trust.executableSetChanged(v1.disclosure, v2.disclosure), true);
  });

  test('upgradeWithUnchangedSurfacesDoesNotReprompt', () => {
    const v1 = trust.evaluateInstallTrust({ parsed: LOCAL_SPEC, manifest: spawnLaneManifest(), hostVersion: '1.0.0' });
    const v2 = trust.evaluateInstallTrust({ parsed: LOCAL_SPEC, manifest: spawnLaneManifest(), hostVersion: '1.0.0' });
    assert.equal(trust.executableSetChanged(v1.disclosure, v2.disclosure), false);
  });
});

// ─── E. Property-based (fast-check) ────────────────────────────────────────

describe('E. Property-based (fast-check)', () => {
  // A JS re-implementation of the PRE-#2796 discloseExecutableSurfaces (hooks/commands/mcpServers
  // ONLY, no reviewer lanes) + disclosureSignature + stableJson, copied from src/capability-trust.cts
  // as it stood before this phase. This is the "oracle" E1 checks the new signatureForManifest
  // against for any lane-free manifest — the property-based generalization of the A1a golden-literal
  // regression check.
  function refAsString(v) {
    return typeof v === 'string' ? v : '';
  }

  function refStableJson(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value)) return `[${value.map(refStableJson).join(',')}]`;
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${refStableJson(value[k])}`).join(',')}}`;
  }

  function refDiscloseExecutableSurfaces(manifest) {
    const hooks = [];
    const commandModules = [];
    const mcpServers = [];

    if (Array.isArray(manifest.hooks)) {
      for (const h of manifest.hooks) {
        if (typeof h !== 'object' || h === null) continue;
        const script = refAsString(h['script']);
        const event = refAsString(h['event']);
        if (script) hooks.push({ event, script });
      }
    }

    if (Array.isArray(manifest.commands)) {
      for (const c of manifest.commands) {
        if (typeof c !== 'object' || c === null) continue;
        const moduleName = refAsString(c['module']);
        const family = refAsString(c['family']);
        const router = refAsString(c['router']);
        if (moduleName) commandModules.push({ family, module: moduleName, router });
      }
    }

    if (manifest.mcpServers && typeof manifest.mcpServers === 'object') {
      const pushServer = (name, config) => {
        if (!name) return;
        const cfg = typeof config === 'object' && config !== null ? config : {};
        const command = refAsString(cfg['command']);
        const rawArgs = Array.isArray(cfg['args']) ? cfg['args'] : [];
        const argv = rawArgs.filter((a) => typeof a === 'string');
        const transport = refAsString(cfg['type']) || refAsString(cfg['transport']);
        const url = refAsString(cfg['url']);
        const headers = {};
        const rawHeaders = cfg['headers'];
        if (rawHeaders && typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
          for (const [k, v] of Object.entries(rawHeaders)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            if (typeof v === 'string') headers[k] = v;
          }
        }
        const env = {};
        const rawEnv = cfg['env'];
        if (rawEnv && typeof rawEnv === 'object' && !Array.isArray(rawEnv)) {
          for (const [k, v] of Object.entries(rawEnv)) {
            if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
            if (typeof v === 'string') env[k] = v;
          }
        }
        const cwd = refAsString(cfg['cwd']);
        const rawConfig = {};
        for (const [k, v] of Object.entries(cfg)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
          rawConfig[k] = v;
        }
        const surface = { name, transport, command, argv, rawArgs, url, headers, env, rawConfig };
        if (cwd) surface.cwd = cwd;
        mcpServers.push(surface);
      };
      if (Array.isArray(manifest.mcpServers)) {
        for (const s of manifest.mcpServers) {
          if (typeof s === 'object' && s !== null) pushServer(refAsString(s['name']), s['config'] ?? s);
        }
      } else {
        for (const [name, config] of Object.entries(manifest.mcpServers)) pushServer(name, config);
      }
    }

    return { hooks, commandModules, mcpServers };
  }

  function refDisclosureSignature(d) {
    const hooks = d.hooks.map((h) => refStableJson(['hook', h.event, h.script])).sort();
    const mods = d.commandModules.map((m) => refStableJson(['mod', m.family, m.module, m.router || ''])).sort();
    const mcp = d.mcpServers
      .map((s) =>
        refStableJson([
          'mcp',
          s.name,
          s.transport || '',
          s.command,
          s.rawArgs || [],
          s.url || '',
          s.headers || {},
          s.env || {},
          s.cwd || '',
          s.rawConfig || {},
        ]),
      )
      .sort();
    return JSON.stringify([hooks, mods, mcp]);
  }

  function referenceLaneFreeSignature(manifest) {
    return refDisclosureSignature(refDiscloseExecutableSurfaces(manifest));
  }

  test('laneFreeSignatureIsUnchangedForArbitraryManifests', () => {
    const stringArb = fc.string();
    const hookArb = fc.record({ event: stringArb, script: stringArb }, { requiredKeys: [] });
    const commandArb = fc.record({ family: stringArb, module: stringArb, router: stringArb }, { requiredKeys: [] });
    const mcpConfigArb = fc.record(
      {
        command: stringArb,
        args: fc.array(fc.oneof(stringArb, fc.integer(), fc.boolean())),
        transport: fc.constantFrom('', 'stdio', 'http', 'sse'),
        url: stringArb,
        headers: fc.dictionary(stringArb, stringArb),
        env: fc.dictionary(stringArb, stringArb),
        cwd: stringArb,
      },
      { requiredKeys: [] },
    );
    const mcpArrayArb = fc.array(fc.record({ name: stringArb, config: mcpConfigArb }, { requiredKeys: [] }));
    const mcpMapArb = fc.dictionary(stringArb, mcpConfigArb);

    // Field-targeted, not fc.anything() — no `reviewer` key is ever present, generalizing A1 across
    // diverse hooks/commands/mcpServers shapes rather than testing a property no caller exercises.
    const laneFreeManifestArb = fc.record(
      {
        id: stringArb,
        hooks: fc.array(hookArb),
        commands: fc.array(commandArb),
        mcpServers: fc.oneof(mcpArrayArb, mcpMapArb),
      },
      { requiredKeys: [] },
    );

    fc.assert(
      fc.property(laneFreeManifestArb, (manifest) => {
        assert.equal(trust.signatureForManifest(manifest), referenceLaneFreeSignature(manifest));
      }),
    );
  });

  test('discloseExecutableSurfacesIsTotal', () => {
    function makeCircularArgManifest() {
      const circular = {};
      circular.self = circular;
      return { id: 'x', reviewer: { slug: 'x', transport: 'spawn', invoke: { binary: 'x', args: [circular] } } };
    }
    function makeThrowingGetterManifest() {
      const m = { id: 'x' };
      Object.defineProperty(m, 'reviewer', {
        enumerable: true,
        get() {
          throw new Error('boom: throwing getter');
        },
      });
      return m;
    }
    function makeThrowingProxyManifest() {
      // Symbol-keyed access passes through to the real (empty) target: fast-check's OWN internal
      // Value wrapper unconditionally probes every generated value via `fc.cloneMethod in value`
      // (a Symbol-keyed `has` check) BEFORE this property's predicate ever runs — a `has` trap that
      // throws for ANY key (including that internal probe) crashes fast-check's generation step
      // itself, not the code under test. Only STRING-keyed access throws here, which is exactly
      // what `discloseExecutableSurfaces` exercises (`manifest.hooks`, `manifest.reviewer`, ...) and
      // matches the matrix's own wording for this row ("a Proxy with a throwing get"). The fuller
      // get+has+ownKeys-all-throw Proxy is exercised directly (bypassing fast-check) in section C's
      // `proxyManifestDoesNotBreakDisclosure`.
      return new Proxy(
        {},
        {
          get(target, prop, receiver) {
            if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
            throw new Error('boom: get trap');
          },
        },
      );
    }
    function makeBigIntManifest() {
      return {
        id: 'x',
        reviewer: { slug: 'x', transport: 'spawn', invoke: { binary: 'x', args: [10n, 'ok'] } },
        mcpServers: { srv: { command: 'node', args: [20n] } },
      };
    }
    function makeNonObjectManifest(v) {
      return v;
    }

    // fast-check's default fc.anything() generator emits no BigInt, circular ref, getter, or Proxy —
    // each hostile shape is enumerated explicitly and mixed with fc.anything() for baseline
    // structural diversity (matrix's own stated limitation of the default generator).
    const manifestArb = fc.oneof(
      fc.anything(),
      fc.constant(0).map(makeCircularArgManifest),
      fc.constant(0).map(makeThrowingGetterManifest),
      fc.constant(0).map(makeThrowingProxyManifest),
      fc.constant(0).map(makeBigIntManifest),
      fc.constantFrom(null, undefined, 42, 'not-an-object', true).map(makeNonObjectManifest),
    );

    fc.assert(
      fc.property(manifestArb, (manifest) => {
        assert.doesNotThrow(() => trust.discloseExecutableSurfaces(manifest));
      }),
    );
  });

  test('signatureIsInvariantUnderLaneAndKeyOrder', () => {
    const stringArb = fc.string();
    const argObjectArb = fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), fc.oneof(stringArb, fc.integer()), {
      maxKeys: 4,
    });
    const laneArb = fc.record({
      slug: stringArb,
      transport: fc.constantFrom('spawn', 'openai-http', ''),
      binary: stringArb,
      args: fc.array(stringArb),
      rawArgs: fc.array(fc.oneof(stringArb, fc.integer(), argObjectArb)),
      hostConfigKey: stringArb,
      resolvedHost: stringArb,
      isLocalDestination: fc.boolean(),
      promptChannel: stringArb,
      handler: stringArb,
      egressPayloadClasses: fc.constant([]),
    });
    const lanesArb = fc.array(laneArb, { maxLength: 5 });

    fc.assert(
      fc.property(lanesArb, (lanes) => {
        const sigOriginal = trust.disclosureSignature(disclosureWithLanes(lanes));

        const reordered = [...lanes].reverse();
        const sigReordered = trust.disclosureSignature(disclosureWithLanes(reordered));
        assert.equal(sigOriginal, sigReordered, 'lane order must not affect the signature');

        const keyReordered = lanes.map((l) => ({
          ...l,
          rawArgs: l.rawArgs.map((a) =>
            a && typeof a === 'object' && !Array.isArray(a) ? Object.fromEntries([...Object.entries(a)].reverse()) : a,
          ),
        }));
        const sigKeyReordered = trust.disclosureSignature(disclosureWithLanes(keyReordered));
        assert.equal(sigOriginal, sigKeyReordered, 'key order within a rawArgs object must not affect the signature');
      }),
    );
  });
});
