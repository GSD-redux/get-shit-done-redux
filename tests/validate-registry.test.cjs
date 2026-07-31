'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { cleanup } = require('./helpers.cjs');

const SCRIPT_PATH = path.join(__dirname, '..', 'scripts', 'validate-registry.cjs');

// validate-registry.cjs resolves docs/registries/ from process.cwd(), so
// tests drive it as a subprocess with `cwd` pointed at an isolated temp
// fixture directory — this covers main() end-to-end without touching the
// real repo's docs/registries/capabilities.json.

function validCapabilityEntry() {
  return {
    id: 'my-capability',
    name: 'My Capability',
    type: 'capability',
    repo: 'octocat/my-capability',
    description: 'Does a useful thing for GSD users.',
    author: 'Octocat',
    license: 'MIT',
    enginesGsd: '>=1.6.0 <3.0.0',
    install: 'gsd capability install https://github.com/octocat/my-capability.git#v1.0.0',
    uninstall: 'gsd capability remove my-capability',
    interactions: {
      loopExtensionPoints: ['execute:pre'],
      hookKinds: ['step'],
      configKeys: [],
      requires: [],
      runtimeCompat: ['all'],
      produces: [],
      consumes: [],
    },
    discussion: 'https://github.com/octocat/my-capability/discussions/1',
  };
}

function validReviewerEntry() {
  return {
    id: 'my-reviewer',
    name: 'My Reviewer',
    type: 'reviewer',
    repo: 'octocat/my-reviewer',
    description: 'Reviews GSD PRs for a specific concern.',
    author: 'Octocat',
    license: 'MIT',
    enginesGsd: '>=1.6.0 <3.0.0',
    install: 'gsd capability install https://github.com/octocat/my-reviewer.git#v1.0.0',
    uninstall: 'gsd capability remove my-reviewer',
    interactions: {
      slug: 'my-reviewer',
      flags: ['--my-reviewer'],
      transport: 'spawn',
      evidenceClass: 'source-grounded',
      reviewsSection: 'My Reviewer',
      requiresBinaries: [],
      configKeys: [],
      runtimeCompat: ['all'],
    },
    discussion: 'https://github.com/octocat/my-reviewer/discussions/1',
  };
}

function withFixture(entries, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-validate-registry-'));
  try {
    const registriesDir = path.join(tmp, 'docs', 'registries');
    fs.mkdirSync(registriesDir, { recursive: true });
    fs.writeFileSync(path.join(registriesDir, 'capabilities.json'), JSON.stringify(entries, null, 2) + '\n');
    fn(tmp);
  } finally {
    cleanup(tmp);
  }
}

// Writes capabilities.json AND reviewers.json into an isolated fixture dir —
// used by the reviewer-catalog cases below (#2904).
function withReviewerFixture(capabilityEntries, reviewerEntries, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-validate-registry-reviewer-'));
  try {
    const registriesDir = path.join(tmp, 'docs', 'registries');
    fs.mkdirSync(registriesDir, { recursive: true });
    fs.writeFileSync(path.join(registriesDir, 'capabilities.json'), JSON.stringify(capabilityEntries, null, 2) + '\n');
    fs.writeFileSync(path.join(registriesDir, 'reviewers.json'), JSON.stringify(reviewerEntries, null, 2) + '\n');
    fn(tmp);
  } finally {
    cleanup(tmp);
  }
}

function runValidate(cwd, args = []) {
  return spawnSync(process.execPath, [SCRIPT_PATH, ...args], { cwd, encoding: 'utf8' });
}

describe('validate-registry CLI (subprocess)', () => {
  test('a good capabilities.json fixture exits 0', () => {
    withFixture([validCapabilityEntry()], (tmp) => {
      const result = runValidate(tmp);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    });
  });

  test('a bad capabilities.json fixture (missing required field) exits non-zero', () => {
    const bad = validCapabilityEntry();
    delete bad.discussion;
    withFixture([bad], (tmp) => {
      const result = runValidate(tmp);
      assert.notEqual(result.status, 0);
    });
  });

  test('a bad capabilities.json fixture (bad id) exits non-zero', () => {
    const bad = validCapabilityEntry();
    bad.id = 'Not_Kebab_Case';
    withFixture([bad], (tmp) => {
      const result = runValidate(tmp);
      assert.notEqual(result.status, 0);
    });
  });

  test('--json prints a parseable verdict for a good fixture', () => {
    withFixture([validCapabilityEntry()], (tmp) => {
      const result = runValidate(tmp, ['--json']);
      const parsed = JSON.parse(result.stdout);
      assert.equal(typeof parsed.ok, 'boolean');
      assert.ok(Array.isArray(parsed.results));
      assert.ok(parsed.results.some((r) => r.file === 'capabilities.json'));
    });
  });

  test('--json prints a parseable verdict for a bad fixture', () => {
    const bad = validCapabilityEntry();
    delete bad.license;
    withFixture([bad], (tmp) => {
      const result = runValidate(tmp, ['--json']);
      const parsed = JSON.parse(result.stdout);
      assert.equal(typeof parsed.ok, 'boolean');
      assert.equal(parsed.ok, false);
    });
  });

  test('missing capabilities.json entirely exits non-zero', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-validate-registry-empty-'));
    try {
      fs.mkdirSync(path.join(tmp, 'docs', 'registries'), { recursive: true });
      const result = runValidate(tmp);
      assert.notEqual(result.status, 0);
    } finally {
      cleanup(tmp);
    }
  });
});

// ─── validate-registry CLI (subprocess): reviewer catalog (#2904) ─────────
//
// scripts/validate-registry.cjs's SOURCES array does not yet include
// { file:'reviewers.json', type:'reviewer', optional:true } — every case
// below is FAILING-FIRST against the unmodified script. See
// .gsd/phase/feat-2904-enh-registries-add-a-reviewer-entry-type/50-test-matrix.md.

describe('validate-registry CLI (subprocess): reviewer catalog', () => {
  test('a valid reviewers.json passes', () => {
    withReviewerFixture([validCapabilityEntry()], [validReviewerEntry()], (tmp) => {
      const result = runValidate(tmp);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    });
  });

  test('an invalid reviewer entry fails with a located error', () => {
    const bad = validReviewerEntry();
    delete bad.interactions.slug;
    withReviewerFixture([validCapabilityEntry()], [bad], (tmp) => {
      const result = runValidate(tmp);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /reviewers\.json/);
      assert.match(result.stderr, /interactions\.slug/);
    });
  });

  test('an absent reviewers.json is skipped', () => {
    withFixture([validCapabilityEntry()], (tmp) => {
      const result = runValidate(tmp);
      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    });
  });

  test('--json reports all three sources', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-validate-registry-all3-'));
    try {
      const registriesDir = path.join(tmp, 'docs', 'registries');
      fs.mkdirSync(registriesDir, { recursive: true });
      fs.writeFileSync(path.join(registriesDir, 'capabilities.json'), JSON.stringify([validCapabilityEntry()], null, 2) + '\n');
      fs.writeFileSync(
        path.join(registriesDir, 'eos.json'),
        JSON.stringify(
          [
            {
              id: 'my-host-plugin',
              name: 'My Host Plugin',
              type: 'eos',
              repo: 'octocat/my-host-plugin',
              description: 'Embeds GSD as an orchestration engine in My Host.',
              author: 'Octocat',
              license: 'MIT',
              enginesGsd: '>=1.6.0 <3.0.0',
              install: 'See the My Host plugin marketplace listing.',
              uninstall: 'Uninstall via the My Host plugin manager.',
              protocolVersion: 1,
              interactions: {
                interfacePoints: ['command', 'state'],
                profile: 'programmatic-cli',
                axes: {
                  embeddingMode: 'imperative',
                  commandSurface: 'slash-file',
                  dispatch: 'Supports nested background dispatch up to depth 3.',
                  modelMode: 'active',
                  hookBus: 'host',
                  stateIO: 'filesystem',
                  transport: 'mcp',
                  runtime: 'node',
                },
              },
              discussion: 'https://github.com/octocat/my-host-plugin/discussions/2',
            },
          ],
          null,
          2,
        ) + '\n',
      );
      fs.writeFileSync(path.join(registriesDir, 'reviewers.json'), JSON.stringify([validReviewerEntry()], null, 2) + '\n');

      const result = runValidate(tmp, ['--json']);
      const parsed = JSON.parse(result.stdout);
      assert.equal(typeof parsed.ok, 'boolean');
      assert.equal(parsed.results.length, 3, `expected 3 result rows, got: ${JSON.stringify(parsed.results)}`);
      assert.ok(
        parsed.results.some((r) => r.file === 'reviewers.json' && r.type === 'reviewer'),
        `expected a reviewers.json/reviewer row, got: ${JSON.stringify(parsed.results)}`,
      );
    } finally {
      cleanup(tmp);
    }
  });

  test('--json with reviewers.json absent (capabilities.json + eos.json present) reports 2 rows and ok:true', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gsd-validate-registry-noreviewer-'));
    try {
      const registriesDir = path.join(tmp, 'docs', 'registries');
      fs.mkdirSync(registriesDir, { recursive: true });
      fs.writeFileSync(path.join(registriesDir, 'capabilities.json'), JSON.stringify([validCapabilityEntry()], null, 2) + '\n');
      fs.writeFileSync(
        path.join(registriesDir, 'eos.json'),
        JSON.stringify(
          [
            {
              id: 'my-host-plugin',
              name: 'My Host Plugin',
              type: 'eos',
              repo: 'octocat/my-host-plugin',
              description: 'Embeds GSD as an orchestration engine in My Host.',
              author: 'Octocat',
              license: 'MIT',
              enginesGsd: '>=1.6.0 <3.0.0',
              install: 'See the My Host plugin marketplace listing.',
              uninstall: 'Uninstall via the My Host plugin manager.',
              protocolVersion: 1,
              interactions: {
                interfacePoints: ['command', 'state'],
                profile: 'programmatic-cli',
                axes: {
                  embeddingMode: 'imperative',
                  commandSurface: 'slash-file',
                  dispatch: 'Supports nested background dispatch up to depth 3.',
                  modelMode: 'active',
                  hookBus: 'host',
                  stateIO: 'filesystem',
                  transport: 'mcp',
                  runtime: 'node',
                },
              },
              discussion: 'https://github.com/octocat/my-host-plugin/discussions/2',
            },
          ],
          null,
          2,
        ) + '\n',
      );
      // Deliberately no reviewers.json.

      const result = runValidate(tmp, ['--json']);
      const parsed = JSON.parse(result.stdout);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.results.length, 2, `expected 2 result rows, got: ${JSON.stringify(parsed.results)}`);
      assert.ok(!parsed.results.some((r) => r.file === 'reviewers.json'));
    } finally {
      cleanup(tmp);
    }
  });
});
