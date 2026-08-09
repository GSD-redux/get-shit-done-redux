'use strict';
process.env.GSD_TEST_MODE = '1';

/**
 * instruction-surface-disclosure.security.test.cjs — behavioral tests for a FIFTH disclosed
 * class inside the capability trust gate (ADR-2363 D5, #3248): `instructionSurfaces` — the
 * skill stems and agent names a capability manifest declares — added to `discloseExecutableSurfaces`.
 *
 * Implements every row carrying a Test name in
 * `.gsd/phase/feat-3248-disclose-instruction-surfaces/50-test-matrix.md`, derived from
 * `40-design.md`'s behavior table. Rows 18-20 and 23-25 are the load-bearing ones: they encode
 * ADR-2363 D4 — instruction surfaces must never perturb `disclosureSignature`/`hasExecutable`, and
 * no pre-existing consent record may be disturbed by a manifest gaining a `skills`/`agents` array.
 *
 * FAILING-FIRST: at the time this file was written, `Disclosure.instructionSurfaces` does not
 * exist. `discloseExecutableSurfaces` is called directly (the cheapest unit that proves the
 * behavior), matching `tests/reviewer-trust-disclosure.test.cjs`'s own established idiom.
 *
 * Suite: `security` (filename `.security.` infix) — this is a trust-gate surface.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanup } = require('./helpers.cjs');

const trust = require('../gsd-core/bin/lib/capability-trust.cjs');

// ─── Fixture builders ──────────────────────────────────────────────────────
// House convention (tests/reviewer-manifest-body.test.cjs, tests/reviewer-trust-disclosure.test.cjs):
// builder functions return a VALID fixture; an optional `mutator` callback is applied to the FRESH
// object before it is returned. Every call builds a brand-new object — no shared mutable state.

/** A minimal, valid capability manifest declaring both skills and agents. */
function skillsAndAgentsManifest(mutator) {
  const manifest = {
    id: 'test-cap',
    role: 'feature',
    title: 'Test Capability',
    description: 'A test capability for the instruction-surface disclosure test suite.',
    tier: 'standard',
    requires: [],
    version: '1.0.0',
    skills: ['ui-phase', 'ui-review'],
    agents: ['gsd-ui-checker'],
  };
  if (mutator) mutator(manifest);
  return manifest;
}

/** A manifest carrying one hook, one command module, and one mcpServer — no skills/agents/reviewer. */
function executableSurfaceManifest(mutator) {
  const manifest = {
    id: 'x',
    hooks: [{ event: 'PostToolUse', script: 'hooks/x.js' }],
    commands: [{ family: 'demo', module: 'demo.cjs', router: 'run' }],
    mcpServers: { srv: { command: 'node', args: ['s.js'], env: { A: '1' } } },
  };
  if (mutator) mutator(manifest);
  return manifest;
}

// ─── A. Happy path (rows 1-3) ───────────────────────────────────────────────

describe('A. Happy path', () => {
  test('discloses declared skill stems in order', () => {
    const d = trust.discloseExecutableSurfaces({ id: 'x', skills: ['a', 'b'] });
    assert.deepEqual(d.instructionSurfaces, [
      { kind: 'skill', name: 'a' },
      { kind: 'skill', name: 'b' },
    ]);
  });

  test('discloses declared agent names', () => {
    const d = trust.discloseExecutableSurfaces({ id: 'x', agents: ['gsd-ui-checker'] });
    assert.deepEqual(d.instructionSurfaces, [{ kind: 'agent', name: 'gsd-ui-checker' }]);
  });

  test('discloses skills and agents together, skills first', () => {
    const d = trust.discloseExecutableSurfaces(skillsAndAgentsManifest());
    assert.deepEqual(d.instructionSurfaces, [
      { kind: 'skill', name: 'ui-phase' },
      { kind: 'skill', name: 'ui-review' },
      { kind: 'agent', name: 'gsd-ui-checker' },
    ]);
  });
});

// ─── B. Boundary (rows 4-7) ─────────────────────────────────────────────────

describe('B. Boundary', () => {
  test('absent skills yields an empty instruction surface list', () => {
    const d = trust.discloseExecutableSurfaces({ id: 'x' });
    assert.deepEqual(d.instructionSurfaces, []);
  });

  test('empty skills array yields empty list', () => {
    const d = trust.discloseExecutableSurfaces({ id: 'x', skills: [] });
    assert.deepEqual(d.instructionSurfaces, []);
  });

  test('single skill', () => {
    const d = trust.discloseExecutableSurfaces({ id: 'x', skills: ['only'] });
    assert.deepEqual(d.instructionSurfaces, [{ kind: 'skill', name: 'only' }]);
  });

  test('many skills are not truncated', () => {
    const stems = Array.from({ length: 64 }, (_, i) => `skill-${i}`);
    const d = trust.discloseExecutableSurfaces({ id: 'x', skills: stems });
    assert.deepEqual(
      d.instructionSurfaces,
      stems.map((name) => ({ kind: 'skill', name })),
    );
  });
});

// ─── C. Negative / malformed (rows 8-11, 15) ────────────────────────────────

describe('C. Negative / malformed', () => {
  test('non-array skills yields empty list', () => {
    const d = trust.discloseExecutableSurfaces({ id: 'x', skills: 'a' });
    assert.deepEqual(d.instructionSurfaces, []);
  });

  test('object skills yields empty list', () => {
    const d = trust.discloseExecutableSurfaces({ id: 'x', skills: { 0: 'a' } });
    assert.deepEqual(d.instructionSurfaces, []);
  });

  test('non-string and empty stems are dropped individually', () => {
    const d = trust.discloseExecutableSurfaces({ id: 'x', skills: ['ok', 42, null, {}, '', true] });
    assert.deepEqual(d.instructionSurfaces, [{ kind: 'skill', name: 'ok' }]);
  });

  test('whitespace-only stem is dropped', () => {
    const d = trust.discloseExecutableSurfaces({ id: 'x', skills: [' '] });
    assert.deepEqual(d.instructionSurfaces, []);
  });

  test('non-object manifest is total', () => {
    for (const manifest of [null, 42, []]) {
      assert.doesNotThrow(() => trust.discloseExecutableSurfaces(manifest));
      const d = trust.discloseExecutableSurfaces(manifest);
      assert.deepEqual(d.instructionSurfaces, [], `manifest=${JSON.stringify(manifest)} must disclose no instruction surfaces`);
      assert.deepEqual(d.hooks, []);
      assert.deepEqual(d.commandModules, []);
      assert.deepEqual(d.mcpServers, []);
      assert.deepEqual(d.reviewerLanes, []);
      assert.equal(d.hasExecutable, false);
    }
  });
});

// ─── D. Hostile (rows 12-14, 16) ─────────────────────────────────────────────

describe('D. Hostile', () => {
  test('a throwing skills getter degrades only its own class', () => {
    const manifest = executableSurfaceManifest();
    Object.defineProperty(manifest, 'skills', {
      enumerable: true,
      get() {
        throw new Error('boom: throwing skills getter');
      },
    });
    assert.doesNotThrow(() => trust.discloseExecutableSurfaces(manifest));
    const d = trust.discloseExecutableSurfaces(manifest);
    assert.deepEqual(d.instructionSurfaces, [], 'a throwing skills getter must degrade to no instruction surfaces');
    assert.deepEqual(d.hooks, [{ event: 'PostToolUse', script: 'hooks/x.js' }], 'hooks must still populate');
    assert.deepEqual(
      d.commandModules,
      [{ family: 'demo', module: 'demo.cjs', router: 'run' }],
      'command modules must still populate',
    );
    assert.equal(d.mcpServers.length, 1, 'mcp servers must still populate');
    assert.deepEqual(d.reviewerLanes, [], 'lane-free manifest still discloses no lane (unaffected either way)');
    assert.equal(d.hasExecutable, true, 'the other three classes still set hasExecutable');
  });

  test('a hostile Proxy manifest never throws', () => {
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
    assert.deepEqual(d.instructionSurfaces, []);
    assert.deepEqual(d.hooks, []);
    assert.deepEqual(d.commandModules, []);
    assert.deepEqual(d.mcpServers, []);
    assert.deepEqual(d.reviewerLanes, []);
  });

  test('prototype-polluting stem names do not mutate Object.prototype', () => {
    const beforeProps = Object.getOwnPropertyNames(Object.prototype).sort();
    const d = trust.discloseExecutableSurfaces({
      id: 'x',
      skills: ['__proto__', 'constructor', 'prototype'],
    });
    assert.deepEqual(d.instructionSurfaces, [
      { kind: 'skill', name: '__proto__' },
      { kind: 'skill', name: 'constructor' },
      { kind: 'skill', name: 'prototype' },
    ], 'the literal names are disclosed, not interpreted as prototype keys');
    const afterProps = Object.getOwnPropertyNames(Object.prototype).sort();
    assert.deepEqual(afterProps, beforeProps, 'Object.prototype must be unchanged');
    assert.equal(({}).polluted, undefined, 'a fresh plain object must carry no polluted property');
  });

  test('adversarial stem contents survive disclosure intact', () => {
    const huge = 'x'.repeat(10000);
    const stems = ['a\nb', 'x\0y', '日本語スキル', huge];
    const d = trust.discloseExecutableSurfaces({ id: 'x', skills: stems });
    assert.deepEqual(
      d.instructionSurfaces,
      stems.map((name) => ({ kind: 'skill', name })),
      'every adversarial stem must be disclosed verbatim, with no crash and no truncation',
    );
    const last = d.instructionSurfaces[d.instructionSurfaces.length - 1];
    assert.equal(last.name.length, 10000, 'the 10k-char stem must not be truncated');
  });
});

// ─── E. Duplicate (row 17) ───────────────────────────────────────────────────

describe('E. Duplicate', () => {
  test('duplicate stems are not collapsed', () => {
    const d = trust.discloseExecutableSurfaces({ id: 'x', skills: ['a', 'a'] });
    assert.deepEqual(d.instructionSurfaces, [
      { kind: 'skill', name: 'a' },
      { kind: 'skill', name: 'a' },
    ]);
  });
});

// ─── F. Independence — signature stability (rows 18-20, ADR-2363 D4) ────────

describe('F. Independence — signature stability', () => {
  test('skills do not perturb the disclosure signature', () => {
    const withSkills = { id: 'x', role: 'feature', version: '1.0.0', skills: ['a', 'b'] };
    const withoutSkills = { id: 'x', role: 'feature', version: '1.0.0' };
    assert.equal(trust.signatureForManifest(withSkills), trust.signatureForManifest(withoutSkills));
  });

  test('skills do not perturb the disclosure signature of an executable-surface-bearing manifest', () => {
    const withSkills = executableSurfaceManifest((m) => {
      m.skills = ['a', 'b'];
    });
    const withoutSkills = executableSurfaceManifest();
    assert.equal(trust.signatureForManifest(withSkills), trust.signatureForManifest(withoutSkills));
  });

  test('agents do not perturb the disclosure signature', () => {
    const withAgents = { id: 'x', role: 'feature', version: '1.0.0', agents: ['gsd-ui-checker'] };
    const withoutAgents = { id: 'x', role: 'feature', version: '1.0.0' };
    assert.equal(trust.signatureForManifest(withAgents), trust.signatureForManifest(withoutAgents));
  });

  test('agents do not perturb the disclosure signature of an executable-surface-bearing manifest', () => {
    const withAgents = executableSurfaceManifest((m) => {
      m.agents = ['gsd-ui-checker'];
    });
    const withoutAgents = executableSurfaceManifest();
    assert.equal(trust.signatureForManifest(withAgents), trust.signatureForManifest(withoutAgents));
  });

  // A JS re-implementation of the PRE-#3248 (and pre-#2796-lane) discloseExecutableSurfaces
  // (hooks/commands/mcpServers ONLY) + disclosureSignature + stableJson — copied verbatim from
  // `tests/reviewer-trust-disclosure.test.cjs`'s own `refDiscloseExecutableSurfaces` /
  // `refStableJson` oracle (itself copied from src/capability-trust.cts as it stood before ADR-2782
  // Phase 3), which satisfies the fixture-provenance rule (#2371): it was written by a source that
  // does not know the `skills`/`agents`/`instructionSurfaces` class exists at all.
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

  test('signature matches the pre-change oracle for a skill-bearing manifest', () => {
    const manifestWithSkills = executableSurfaceManifest((m) => {
      m.skills = ['ui-phase', 'ui-review'];
      m.agents = ['gsd-ui-checker'];
    });
    // The oracle does not know `skills`/`agents`/`reviewer` exist at all — it only ever reads
    // hooks/commands/mcpServers — so its output for the skill-bearing manifest IS the reference
    // "sans skills" signature the matrix asks for.
    assert.equal(trust.signatureForManifest(manifestWithSkills), referenceLaneFreeSignature(manifestWithSkills));
  });
});

// ─── G. Independence — hasExecutable (rows 21-22) ───────────────────────────

describe('G. Independence — hasExecutable', () => {
  test('an instruction surface alone does not set hasExecutable', () => {
    const d = trust.discloseExecutableSurfaces(skillsAndAgentsManifest());
    assert.equal(d.hasExecutable, false);
  });

  test('hasExecutable still reflects executable surfaces only', () => {
    const manifest = skillsAndAgentsManifest((m) => {
      m.hooks = [{ event: 'PostToolUse', script: 'hooks/x.js' }];
    });
    const d = trust.discloseExecutableSurfaces(manifest);
    assert.equal(d.hasExecutable, true, 'the hook, not the instruction surfaces, sets hasExecutable');
    assert.equal(d.hooks.length, 1);
    assert.equal(d.instructionSurfaces.length, 3, 'instruction surfaces still disclosed alongside the hook');
  });
});

// ─── H. Independence — executableSetChanged (row 23) ────────────────────────

describe('H. Independence — executableSetChanged', () => {
  test('adding a skill is not an executable-set change', () => {
    const before = trust.discloseExecutableSurfaces({ id: 'x' });
    const after = trust.discloseExecutableSurfaces({ id: 'x', skills: ['a'] });
    assert.equal(trust.executableSetChanged(before, after), false);
  });
});

// ─── I. Regression — pre-existing consent record (row 24) ───────────────────

describe('I. Regression — pre-existing consent record', () => {
  const LOCAL_SPEC = { kind: 'local', raw: '.', target: '.' };

  test('a pre-existing consent record survives instruction-surface disclosure', () => {
    // Simulates a consent record written BEFORE this phase (a manifest with no skills/agents),
    // then the capability being upgraded to a version that adds a skill — the stored signature
    // must still match, so no re-consent prompt fires.
    const preChangeManifest = { id: 'x', role: 'feature', version: '1.0.0' };
    const v1 = trust.evaluateInstallTrust({ parsed: LOCAL_SPEC, manifest: preChangeManifest, hostVersion: '1.0.0' });
    const storedSignature = trust.disclosureSignature(v1.disclosure);

    const upgradedManifest = { id: 'x', role: 'feature', version: '1.1.0', skills: ['ui-phase'] };
    const v2 = trust.evaluateInstallTrust({ parsed: LOCAL_SPEC, manifest: upgradedManifest, hostVersion: '1.0.0' });
    const upgradedSignature = trust.disclosureSignature(v2.disclosure);

    assert.equal(upgradedSignature, storedSignature, 'the stored consent signature must still match after the upgrade');
    assert.equal(
      trust.executableSetChanged(v1.disclosure, v2.disclosure),
      false,
      'gaining a skill must not force a re-consent prompt',
    );
    assert.equal(v2.requiresConsent, false, 'a skill-only capability requires no consent at all');
  });
});

// ─── J. Independence — missingArtifacts (row 25) ────────────────────────────

describe('J. Independence — missingArtifacts', () => {
  test('skill stems are never existence-checked against stagedDir', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instr-surface-j1-'));
    t.after(() => cleanup(dir));

    const manifest = { id: 'x', skills: ['nonexistent-skill-stem', 'another-missing-one'] };
    const d = trust.discloseExecutableSurfaces(manifest, dir);
    assert.deepEqual(
      d.missingArtifacts,
      [],
      'skill stems are registry names, not bundle-relative artifact paths — they must never contribute to missingArtifacts',
    );
    assert.equal(d.instructionSurfaces.length, 2, 'the skills must still be disclosed');
  });
});

// ─── K. Consent prompt (rows 26-27) ──────────────────────────────────────────
//
// CONTRIBUTING's "Prohibited: Raw Text Matching on Test Outputs" forbids asserting on
// `summarizeDisclosure`'s rendered prose. `summarizeDisclosure` today returns only a flat
// `string[]` with no typed intermediate representation for instruction surfaces distinct from the
// executable-surface sections it already renders (hooks/command modules/MCP servers/reviewer
// lanes) — so these two rows are written against the `Disclosure` object itself, per the matrix's
// own note 41 ("assert on the disclosure object plus a minimal presence check the renderer already
// supports; if no typed surface exists, add one rather than grepping").
//
// TODO(row 26/27): the implementation step must add a typed surface for the consent-prompt
// renderer to expose instruction surfaces as a section distinct from executable surfaces — e.g. a
// `{ executable: string[], instructionSurfaces: string[] }` shape from `summarizeDisclosure`, or a
// separate `summarizeInstructionSurfaces(disclosure)` export — so a future test can assert on that
// IR instead of continuing to test only the `Disclosure` object it would be derived from.
describe('K. Consent prompt (structured surface — see TODO above)', () => {
  test('consent prompt names instruction surfaces separately', () => {
    const manifest = { id: 'x', skills: ['ui-phase', 'ui-review'] };
    const d = trust.discloseExecutableSurfaces(manifest);
    // The data a consent-prompt renderer would need to name each instruction surface, held in a
    // field STRUCTURALLY SEPARATE from the four executable-surface classes (hooks/commandModules/
    // mcpServers/reviewerLanes) — the distinction D3 draws must survive into whatever renders this.
    assert.deepEqual(d.instructionSurfaces, [
      { kind: 'skill', name: 'ui-phase' },
      { kind: 'skill', name: 'ui-review' },
    ]);
    assert.deepEqual(d.hooks, [], 'instruction surfaces must not be folded into an executable-surface class');
    assert.equal(d.hasExecutable, false, 'a skill-only manifest never requires consent from this data');
  });

  test('consent prompt omits the section when there is nothing to disclose', () => {
    const manifest = { id: 'x' };
    const d = trust.discloseExecutableSurfaces(manifest);
    assert.deepEqual(
      d.instructionSurfaces,
      [],
      'no instruction surfaces declared => nothing for a renderer to name, so no section would render',
    );
  });
});

// ─── L. Cross-platform (row 28) ──────────────────────────────────────────────

describe('L. Cross-platform', () => {
  test('CRLF in a stem does not split the entry', () => {
    const stem = 'ui-phase\r\nwith-crlf';
    const d = trust.discloseExecutableSurfaces({ id: 'x', skills: [stem] });
    assert.deepEqual(
      d.instructionSurfaces,
      [{ kind: 'skill', name: stem }],
      'a CRLF inside a stem must be disclosed verbatim as ONE entry, never split into two',
    );
  });
});
