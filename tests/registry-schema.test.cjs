'use strict';
process.env.GSD_TEST_MODE = '1';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fc = require('fast-check');

const {
  LOOP_POINTS,
  HOOK_KINDS,
  INTERFACE_POINTS,
  PROFILES,
  AXES,
  AXES_FREE_STRING,
  CAPABILITY_REQUIRED,
  EOS_REQUIRED,
  REVIEWER_REQUIRED,
  REVIEWER_LANE_TRANSPORTS,
  REVIEWER_EVIDENCE_CLASSES,
  REVIEWER_SECTION_MAX,
  INTERACTION_STRING_MAX,
  INTERACTION_ARRAY_MAX,
  isValidGsdRange,
  validateEntries,
  renderMarkdown,
} = require(path.join(__dirname, '..', 'scripts', 'registry-schema.cjs'));

// ─── Fixtures ─────────────────────────────────────────────────────────────

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
      configKeys: ['myCapability.enabled'],
      requires: [],
      runtimeCompat: ['all'],
      produces: [],
      consumes: [],
    },
    discussion: 'https://github.com/octocat/my-capability/discussions/1',
  };
}

function validEosEntry() {
  return {
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

// ─── Vocabulary constants ───────────────────────────────────────────────────

describe('registry-schema: closed vocabulary constants', () => {
  test('LOOP_POINTS is the 12 canonical loop points (ADR-857), in order', () => {
    assert.deepEqual(LOOP_POINTS, [
      'discuss:pre',
      'discuss:post',
      'plan:pre',
      'plan:post',
      'execute:pre',
      'execute:wave:pre',
      'execute:wave:post',
      'execute:post',
      'verify:pre',
      'verify:post',
      'ship:pre',
      'ship:post',
    ]);
  });

  test('HOOK_KINDS is step/contribution/gate (ADR-857 Decision 4)', () => {
    assert.deepEqual(HOOK_KINDS, ['step', 'contribution', 'gate']);
  });

  test('INTERFACE_POINTS is the six ADR-1239 interface points', () => {
    assert.deepEqual(INTERFACE_POINTS, ['command', 'dispatch', 'model', 'hooks', 'state', 'artifact']);
  });

  test('PROFILES is the three ADR-1239 negotiation profiles', () => {
    assert.deepEqual(PROFILES, ['programmatic-cli', 'declarative-cli', 'ide']);
  });

  test('AXES has exactly the eight ADR-1239 negotiated axis keys', () => {
    assert.deepEqual(
      Object.keys(AXES).sort(),
      ['commandSurface', 'dispatch', 'embeddingMode', 'hookBus', 'modelMode', 'runtime', 'stateIO', 'transport'].sort(),
    );
  });

  test('AXES.dispatch carries the free-string sentinel, not an enum array', () => {
    assert.equal(AXES.dispatch, AXES_FREE_STRING);
    assert.equal(Array.isArray(AXES.dispatch), false);
  });

  test('every non-dispatch AXES entry is a non-empty enum array', () => {
    for (const [key, value] of Object.entries(AXES)) {
      if (key === 'dispatch') continue;
      assert.ok(Array.isArray(value), `AXES.${key} should be an array`);
      assert.ok(value.length > 0, `AXES.${key} should be non-empty`);
    }
  });

  test('CAPABILITY_REQUIRED lists the 12 required capability entry fields', () => {
    assert.deepEqual(CAPABILITY_REQUIRED, [
      'id', 'name', 'type', 'repo', 'description', 'author', 'license',
      'enginesGsd', 'install', 'uninstall', 'interactions', 'discussion',
    ]);
  });

  test('EOS_REQUIRED lists the 13 required eos entry fields (adds protocolVersion)', () => {
    assert.deepEqual(EOS_REQUIRED, [
      'id', 'name', 'type', 'repo', 'description', 'author', 'license',
      'enginesGsd', 'install', 'uninstall', 'interactions', 'discussion', 'protocolVersion',
    ]);
  });
});

// ─── validateEntries: capability ───────────────────────────────────────────

describe('validateEntries: capability — happy path', () => {
  test('a fully-valid capability entry passes', () => {
    const verdict = validateEntries([validCapabilityEntry()], { type: 'capability' });
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.errors, []);
  });
});

describe('validateEntries: capability — required fields', () => {
  for (const field of CAPABILITY_REQUIRED) {
    test(`missing required field "${field}" fails`, () => {
      const entry = validCapabilityEntry();
      delete entry[field];
      const verdict = validateEntries([entry], { type: 'capability' });
      assert.equal(verdict.ok, false);
      assert.ok(verdict.errors.length > 0, 'expected at least one error');
      assert.ok(
        verdict.errors.some((e) => e.field === field),
        `expected an error referencing field "${field}", got: ${JSON.stringify(verdict.errors)}`,
      );
    });
  }
});

describe('validateEntries: capability — field shape violations', () => {
  test('bad id (not kebab-case) fails', () => {
    const entry = validCapabilityEntry();
    entry.id = 'Not_Kebab_Case';
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'id'));
  });

  test('bad repo (not owner/repo form) fails', () => {
    const entry = validCapabilityEntry();
    entry.repo = 'not-a-valid-repo';
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'repo'));
  });

  test('bad enginesGsd (malformed range) fails', () => {
    const entry = validCapabilityEntry();
    entry.enginesGsd = 'not-a-semver-range';
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'enginesGsd'));
  });

  test('bad discussion URL fails', () => {
    const entry = validCapabilityEntry();
    entry.discussion = 'https://example.com/not-a-discussion';
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'discussion'));
  });

  test('bad license fails', () => {
    const entry = validCapabilityEntry();
    entry.license = 'Not A Valid License!!';
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'license'));
  });

  test('unknown top-level key fails (strict schema)', () => {
    const entry = validCapabilityEntry();
    entry.extraUnknownField = 'nope';
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'extraUnknownField'));
  });

  test('duplicate id across two entries fails', () => {
    const a = validCapabilityEntry();
    const b = validCapabilityEntry();
    b.name = 'A Different Name';
    b.repo = 'octocat/another-capability';
    b.discussion = 'https://github.com/octocat/another-capability/discussions/2';
    // b.id intentionally left the same as a.id
    const verdict = validateEntries([a, b], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'id' && /duplicate/i.test(e.reason)));
  });

  test('empty loopExtensionPoints fails (AC3 — must be non-empty)', () => {
    const entry = validCapabilityEntry();
    entry.interactions.loopExtensionPoints = [];
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions.loopExtensionPoints'));
  });

  test('invalid loop point fails', () => {
    const entry = validCapabilityEntry();
    entry.interactions.loopExtensionPoints = ['not:a:real:point'];
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions.loopExtensionPoints'));
  });

  test('invalid hook kind fails', () => {
    const entry = validCapabilityEntry();
    entry.interactions.hookKinds = ['not-a-real-kind'];
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions.hookKinds'));
  });
});

// ─── validateEntries: eos ───────────────────────────────────────────────────

describe('validateEntries: eos — happy path', () => {
  test('a fully-valid eos entry passes', () => {
    const verdict = validateEntries([validEosEntry()], { type: 'eos' });
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.errors, []);
  });
});

describe('validateEntries: eos — field shape violations', () => {
  test('bad interfacePoint fails', () => {
    const entry = validEosEntry();
    entry.interactions.interfacePoints = ['not-a-real-point'];
    const verdict = validateEntries([entry], { type: 'eos' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions.interfacePoints'));
  });

  test('bad profile fails', () => {
    const entry = validEosEntry();
    entry.interactions.profile = 'not-a-real-profile';
    const verdict = validateEntries([entry], { type: 'eos' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions.profile'));
  });

  test('bad axis value fails', () => {
    const entry = validEosEntry();
    entry.interactions.axes.embeddingMode = 'not-a-real-value';
    const verdict = validateEntries([entry], { type: 'eos' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions.axes.embeddingMode'));
  });

  test('protocolVersion < 1 fails', () => {
    const entry = validEosEntry();
    entry.protocolVersion = 0;
    const verdict = validateEntries([entry], { type: 'eos' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'protocolVersion'));
  });

  test('missing axis key fails', () => {
    const entry = validEosEntry();
    delete entry.interactions.axes.runtime;
    const verdict = validateEntries([entry], { type: 'eos' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions.axes'));
  });

  test('extra axis key fails', () => {
    const entry = validEosEntry();
    entry.interactions.axes.notARealAxis = 'x';
    const verdict = validateEntries([entry], { type: 'eos' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions.axes'));
  });
});

// ─── renderMarkdown ─────────────────────────────────────────────────────────

describe('renderMarkdown', () => {
  test('is deterministic across two calls regardless of input entry order', () => {
    const a = validCapabilityEntry();
    const b = { ...validCapabilityEntry(), id: 'zzz-capability', name: 'ZZZ Capability' };
    const first = renderMarkdown([a, b], { type: 'capability', sourceFile: 'capabilities.json' });
    const second = renderMarkdown([b, a], { type: 'capability', sourceFile: 'capabilities.json' });
    assert.equal(first, second);
  });

  test('contains the shields.io release badge for a populated registry', () => {
    const rendered = renderMarkdown([validCapabilityEntry()], { type: 'capability', sourceFile: 'capabilities.json' });
    assert.match(rendered, /img\.shields\.io\/github\/v\/release/);
  });

  test('contains the entry discussion URL for a populated registry', () => {
    const entry = validCapabilityEntry();
    const rendered = renderMarkdown([entry], { type: 'capability', sourceFile: 'capabilities.json' });
    assert.ok(rendered.includes(entry.discussion), 'expected rendered output to include the discussion URL');
  });

  test('renders the author for a populated registry', () => {
    const entry = validCapabilityEntry();
    const rendered = renderMarkdown([entry], { type: 'capability', sourceFile: 'capabilities.json' });
    assert.match(rendered, /- \*\*Author:\*\* Octocat/);
  });

  test('contains the empty-state text for zero entries', () => {
    const rendered = renderMarkdown([], { type: 'capability', sourceFile: 'capabilities.json' });
    assert.match(rendered, /No entries yet/);
  });

  test('an unknown registry type throws rather than silently rendering the capability page', () => {
    assert.throws(
      () => renderMarkdown([], { type: 'bogus-type', sourceFile: 'x.json' }),
      { message: /bogus-type/ },
    );
  });

  test('a recognized type still renders the capability page (guard is not unconditional)', () => {
    const rendered = renderMarkdown([], { type: 'capability', sourceFile: 'capabilities.json' });
    assert.equal(rendered.split('\n')[2], '# GSD Community Capability Registry');
  });
});

// ─── isValidGsdRange ────────────────────────────────────────────────────────

describe('isValidGsdRange', () => {
  test('fast-check property: well-formed operator+M.N.P ranges are valid', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('', '>=', '>', '<=', '<', '=', '^', '~'),
        fc.integer({ min: 0, max: 999 }),
        fc.integer({ min: 0, max: 999 }),
        fc.integer({ min: 0, max: 999 }),
        (op, major, minor, patch) => {
          const range = `${op}${major}.${minor}.${patch}`;
          assert.equal(isValidGsdRange(range), true, range);
        },
      ),
    );
  });

  test('fast-check property: a non-numeric major segment is always invalid', () => {
    // Replacing a numeric segment with letters can never be a well-formed range.
    // Letters-only (not arbitrary garbage) keeps the generator from accidentally
    // producing a valid semver-with-prerelease like `1.2.3-rc` — `>=1.2.3-rc.0.0`
    // IS a legitimate prerelease range the validator accepts, which would make an
    // "always invalid" assertion intermittently fail (a hidden flake).
    fc.assert(
      fc.property(
        fc.constantFrom('', '>=', '>', '<=', '<', '=', '^', '~'),
        fc
          .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz'.split('')), { minLength: 1, maxLength: 6 })
          .map((chars) => chars.join('')),
        (op, letters) => {
          assert.equal(isValidGsdRange(`${op}${letters}.0.0`), false, `${op}${letters}.0.0`);
        },
      ),
    );
  });

  test('boundary: valid range strings', () => {
    for (const good of ['1.0.0', '>=1.0.0', '^1.0.0 <2.0.0', '*']) {
      assert.equal(isValidGsdRange(good), true, good);
    }
  });

  test('boundary: invalid range strings', () => {
    for (const bad of ['1.0', '>=abc', '']) {
      assert.equal(isValidGsdRange(bad), false, bad);
    }
  });
});

// ─── renderMarkdown: Markdown-injection escaping (adversarial-review hardening) ──

describe('renderMarkdown: mdInline escaping neutralizes untrusted free text', () => {
  test('description containing a table-breakout + link-hijack payload is escaped', () => {
    const entry = validCapabilityEntry();
    entry.description = 'Good stuff | ![x](https://evil/track.png) | text';
    const rendered = renderMarkdown([entry], { type: 'capability', sourceFile: 'capabilities.json' });
    assert.ok(rendered.includes('\\|'), 'expected an escaped pipe (\\|) in the rendered output');
    assert.ok(
      !rendered.includes('![x](https://evil/track.png)'),
      'expected the raw unescaped link-hijack payload to NOT appear verbatim',
    );
    assert.ok(rendered.includes('\\['), 'expected an escaped [ (\\[), proving the hijack bracket was neutralized');
  });

  test('name containing a link-hijack payload is escaped (no raw ](url) survives)', () => {
    const entry = validCapabilityEntry();
    entry.name = 'Evil] (https://evil.example) [';
    const rendered = renderMarkdown([entry], { type: 'capability', sourceFile: 'capabilities.json' });
    assert.ok(
      !rendered.includes('](https://evil.example)'),
      'expected the ] to be escaped, breaking the hijacked link destination pairing',
    );
  });

  test('install containing an embedded ``` run gets a longer fence, keeping injected content inside the block', () => {
    const entry = validCapabilityEntry();
    entry.install = 'echo a\n```\n## FAKE\n```sh\nbad';
    const rendered = renderMarkdown([entry], { type: 'capability', sourceFile: 'capabilities.json' });

    const openIdx = rendered.indexOf('````sh');
    assert.ok(openIdx !== -1, 'expected a 4-backtick opening fence (longer than the embedded 3-backtick run)');

    const afterOpen = rendered.slice(openIdx + '````sh'.length);
    const closeIdx = afterOpen.indexOf('````');
    assert.ok(closeIdx !== -1, 'expected a matching 4-backtick closing fence');

    const blockBody = afterOpen.slice(0, closeIdx);
    assert.ok(
      blockBody.includes('## FAKE'),
      'expected the injected "## FAKE" heading to remain INSIDE the fenced block, not escape it',
    );
  });

  test('name/description with a raw newline: validateEntries rejects it, and if rendered anyway the newline collapses', () => {
    const nameEntry = validCapabilityEntry();
    nameEntry.name = 'Evil\nName';
    assert.equal(validateEntries([nameEntry], { type: 'capability' }).ok, false);

    const descEntry = validCapabilityEntry();
    descEntry.description = 'Evil\nDescription';
    assert.equal(validateEntries([descEntry], { type: 'capability' }).ok, false);

    // Defense in depth: renderMarkdown does not itself call validateEntries, so
    // confirm mdInline still collapses an embedded newline to a single space —
    // no raw newline lands inside a rendered table row.
    const rendered = renderMarkdown([nameEntry], { type: 'capability', sourceFile: 'capabilities.json' });
    const matchingRows = rendered.split('\n').filter((line) => line.startsWith('| [Evil'));
    assert.equal(matchingRows.length, 1, 'expected the newline-containing name to collapse into a single table row');
    assert.ok(matchingRows[0].includes('Evil Name'), `expected collapsed "Evil Name", got: ${matchingRows[0]}`);
  });
});

// ─── validateEntries: null/non-object element guard (F2) ──────────────────────

describe('validateEntries: null/non-object element guard (F2)', () => {
  test('a null entry fails without throwing', () => {
    let verdict;
    assert.doesNotThrow(() => {
      verdict = validateEntries([null], { type: 'capability' });
    });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === '(entry)'));
  });

  test('an undefined entry fails without throwing', () => {
    let verdict;
    assert.doesNotThrow(() => {
      verdict = validateEntries([undefined], { type: 'capability' });
    });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === '(entry)'));
  });

  test('primitive and array elements fail without throwing', () => {
    const verdict = validateEntries(['a string', [1, 2, 3], 42], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.errors.filter((e) => e.field === '(entry)').length, 3);
  });
});

// ─── renderMarkdown: eos registry (F4) ─────────────────────────────────────────

describe('renderMarkdown: eos registry (F4)', () => {
  test('renders the eos heading, the free-form dispatch text, protocol wording, and integration wording', () => {
    const rendered = renderMarkdown([validEosEntry()], { type: 'eos', sourceFile: 'eos.json' });
    assert.match(rendered, /# GSD EoS Registry/);
    assert.ok(rendered.includes('Supports nested background dispatch up to depth 3.'));
    assert.match(rendered, /protocol v1/);
    assert.match(rendered, /integration/);
  });
});

// ─── validateEntries: interactions guards (F4) ─────────────────────────────────

describe('validateEntries: interactions guards (F4)', () => {
  test('capability interactions.someUnknownKey fails at the qualified field', () => {
    const entry = validCapabilityEntry();
    entry.interactions.someUnknownKey = 'x';
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions.someUnknownKey'));
  });

  test('eos interactions.someUnknownKey fails at the qualified field', () => {
    const entry = validEosEntry();
    entry.interactions.someUnknownKey = 'x';
    const verdict = validateEntries([entry], { type: 'eos' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions.someUnknownKey'));
  });

  test('interactions.configKeys as a non-array string fails', () => {
    const entry = validCapabilityEntry();
    entry.interactions.configKeys = 'nope';
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions.configKeys'));
  });

  test('interactions.configKeys with non-string elements fails', () => {
    const entry = validCapabilityEntry();
    entry.interactions.configKeys = [123];
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions.configKeys'));
  });

  test('eos interactions.axes as a non-object string fails', () => {
    const entry = validEosEntry();
    entry.interactions.axes = 'nope';
    const verdict = validateEntries([entry], { type: 'eos' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions.axes'));
  });
});

// ─── validateEntries: new hardening checks (length caps, tightened regexes) ────

describe('validateEntries: description length cap (max 1000)', () => {
  test('999 chars (limit-1) passes the cap', () => {
    const entry = validCapabilityEntry();
    entry.description = 'x'.repeat(999);
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.ok(!verdict.errors.some((e) => e.field === 'description' && /exceeds max length/.test(e.reason)));
  });

  test('1000 chars (limit) passes the cap', () => {
    const entry = validCapabilityEntry();
    entry.description = 'x'.repeat(1000);
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.ok(!verdict.errors.some((e) => e.field === 'description' && /exceeds max length/.test(e.reason)));
  });

  test('1001 chars (limit+1) fails the cap', () => {
    const entry = validCapabilityEntry();
    entry.description = 'x'.repeat(1001);
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'description' && /exceeds max length 1000/.test(e.reason)));
  });
});

describe('validateEntries: entry-count cap (max 2000)', () => {
  function makeEntries(n) {
    return Array.from({ length: n }, (_, i) => ({
      ...validCapabilityEntry(),
      id: `cap-${i}`,
      repo: `octocat/cap-${i}`,
      discussion: `https://github.com/octocat/cap-${i}/discussions/1`,
    }));
  }

  test('1999 entries (limit-1) does not trip the cap', () => {
    const verdict = validateEntries(makeEntries(1999), { type: 'capability' });
    assert.ok(!verdict.errors.some((e) => e.field === '(root)'));
  });

  test('2000 entries (limit) does not trip the cap', () => {
    const verdict = validateEntries(makeEntries(2000), { type: 'capability' });
    assert.ok(!verdict.errors.some((e) => e.field === '(root)'));
  });

  test('2001 entries (limit+1) trips the cap with a single root error', () => {
    const verdict = validateEntries(makeEntries(2001), { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.errors.length, 1);
    assert.equal(verdict.errors[0].field, '(root)');
    assert.match(verdict.errors[0].reason, /max 2000/);
  });
});

describe('validateEntries: tightened discussion/license regexes', () => {
  test('discussion URL containing an injection char ([) fails the tightened regex', () => {
    const entry = validCapabilityEntry();
    entry.discussion = 'https://github.com/a[b/c/discussions/1';
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'discussion'));
  });

  test('license containing a newline fails the tightened regex', () => {
    const entry = validCapabilityEntry();
    entry.license = 'MIT\nEVIL';
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    assert.ok(verdict.errors.some((e) => e.field === 'license'));
  });

  test('a compound SPDX license ("MIT OR Apache-2.0") still passes', () => {
    const entry = validCapabilityEntry();
    entry.license = 'MIT OR Apache-2.0';
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.ok(!verdict.errors.some((e) => e.field === 'license'));
  });
});

// ─── reviewer entry type (#2904) ────────────────────────────────────────────
//
// The describe blocks below cover the `reviewer` entry type: the
// REVIEWER_REQUIRED / REVIEWER_LANE_TRANSPORTS / REVIEWER_EVIDENCE_CLASSES /
// REVIEWER_SECTION_MAX vocabulary constants, `interactions` validation, and
// renderMarkdown's `type: 'reviewer'` output. They were authored FAILING-FIRST
// against the unmodified module, ahead of the implementation. See
// .gsd/phase/feat-2904-enh-registries-add-a-reviewer-entry-type/50-test-matrix.md.

describe('registry-schema: reviewer vocabulary constants', () => {
  test('REVIEWER_REQUIRED lists the 12 required reviewer entry fields', () => {
    assert.deepEqual(REVIEWER_REQUIRED, [
      'id', 'name', 'type', 'repo', 'description', 'author', 'license',
      'enginesGsd', 'install', 'uninstall', 'interactions', 'discussion',
    ]);
  });

  test('reviewer vocab constants are non-empty frozen arrays', () => {
    assert.deepEqual(REVIEWER_LANE_TRANSPORTS, ['spawn', 'openai-http']);
    assert.deepEqual(REVIEWER_EVIDENCE_CLASSES, ['source-grounded', 'diff-only']);
    assert.ok(Object.isFrozen(REVIEWER_LANE_TRANSPORTS), 'expected REVIEWER_LANE_TRANSPORTS to be frozen');
    assert.ok(Object.isFrozen(REVIEWER_EVIDENCE_CLASSES), 'expected REVIEWER_EVIDENCE_CLASSES to be frozen');
    assert.equal(REVIEWER_SECTION_MAX, 200);
  });
});

describe('validateEntries: reviewer — happy path', () => {
  test('a fully-valid reviewer entry passes', () => {
    const verdict = validateEntries([validReviewerEntry()], { type: 'reviewer' });
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.errors, []);
  });

  test('an empty reviewer array passes', () => {
    const verdict = validateEntries([], { type: 'reviewer' });
    assert.equal(verdict.ok, true);
    assert.deepEqual(verdict.errors, []);
  });
});

describe('validateEntries: reviewer — type dispatch', () => {
  test('an unknown opts.type is a root error, not a silent capability validation', () => {
    const verdict = validateEntries([validReviewerEntry()], { type: 'typo' });
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.errors, [{ index: -1, field: '(root)', reason: 'unknown registry type "typo"' }]);
  });

  test('a capability-typed entry in the reviewer catalog fails', () => {
    const entry = validReviewerEntry();
    entry.type = 'capability';
    const verdict = validateEntries([entry], { type: 'reviewer' });
    assert.equal(verdict.ok, false);
    const err = verdict.errors.find((e) => e.field === 'type');
    assert.ok(err, `expected a type error, got: ${JSON.stringify(verdict.errors)}`);
    assert.equal(err.reason, 'type must be "reviewer"');
  });

  test('an eos-only top-level field is rejected on a reviewer entry', () => {
    const entry = validReviewerEntry();
    entry.protocolVersion = 1;
    const verdict = validateEntries([entry], { type: 'reviewer' });
    assert.equal(verdict.ok, false);
    const err = verdict.errors.find((e) => e.field === 'protocolVersion');
    assert.ok(err, `expected a protocolVersion error, got: ${JSON.stringify(verdict.errors)}`);
    assert.equal(err.reason, 'unknown field');
  });

  test('a non-array under a valid type still reports the array error', () => {
    const verdict = validateEntries(null, { type: 'reviewer' });
    assert.equal(verdict.ok, false);
    assert.deepEqual(verdict.errors, [{ index: -1, field: '(root)', reason: 'entries must be an array' }]);
  });
});

describe('validateEntries: reviewer — interactions required-key sweep', () => {
  const REVIEWER_INTERACTIONS_KEYS = [
    'slug', 'flags', 'transport', 'evidenceClass', 'reviewsSection',
    'requiresBinaries', 'configKeys', 'runtimeCompat',
  ];

  for (const key of REVIEWER_INTERACTIONS_KEYS) {
    test(`interactions.${key} is individually required`, () => {
      const entry = validReviewerEntry();
      delete entry.interactions[key];
      const verdict = validateEntries([entry], { type: 'reviewer' });
      assert.equal(verdict.ok, false);
      const err = verdict.errors.find((e) => e.field === `interactions.${key}`);
      assert.ok(err, `expected interactions.${key} error, got: ${JSON.stringify(verdict.errors)}`);
      assert.equal(err.reason, 'missing required field');
    });
  }

  test('multiple missing interactions keys each report once', () => {
    const entry = validReviewerEntry();
    delete entry.interactions.slug;
    delete entry.interactions.flags;
    delete entry.interactions.transport;
    const verdict = validateEntries([entry], { type: 'reviewer' });
    assert.equal(verdict.ok, false);
    const missingErrors = verdict.errors.filter((e) => e.reason === 'missing required field');
    assert.equal(missingErrors.length, 3, `expected exactly 3 missing-field errors, got: ${JSON.stringify(verdict.errors)}`);
    assert.deepEqual(
      missingErrors.map((e) => e.field).sort(),
      ['interactions.flags', 'interactions.slug', 'interactions.transport'],
    );
  });

  test('an absent interactions object reports once, not nine times', () => {
    const entry = validReviewerEntry();
    delete entry.interactions;
    const verdict = validateEntries([entry], { type: 'reviewer' });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.errors.filter((e) => e.field === 'interactions').length, 1);
    assert.ok(verdict.errors.some((e) => e.field === 'interactions' && e.reason === 'missing required field'));
    assert.equal(
      verdict.errors.filter((e) => e.field.startsWith('interactions.')).length,
      0,
      `expected no interactions.* sub-errors when interactions itself is absent, got: ${JSON.stringify(verdict.errors)}`,
    );
  });

  test('a non-object interactions is rejected before key checks', () => {
    for (const bad of [null, [], 'x']) {
      const entry = validReviewerEntry();
      entry.interactions = bad;
      const verdict = validateEntries([entry], { type: 'reviewer' });
      assert.equal(verdict.ok, false, `expected ${JSON.stringify(bad)} invalid`);
      const err = verdict.errors.find((e) => e.field === 'interactions');
      assert.ok(err, `expected interactions error for ${JSON.stringify(bad)}`);
      assert.equal(err.reason, 'interactions must be an object');
    }
  });

  test('capability-only interactions keys are rejected on a reviewer', () => {
    const entry = validReviewerEntry();
    entry.interactions.loopExtensionPoints = ['execute:pre'];
    const verdict = validateEntries([entry], { type: 'reviewer' });
    assert.equal(verdict.ok, false);
    const err = verdict.errors.find((e) => e.field === 'interactions.loopExtensionPoints');
    assert.ok(err, `expected an interactions.loopExtensionPoints error, got: ${JSON.stringify(verdict.errors)}`);
    assert.equal(err.reason, 'unknown field');
  });

  test('manifest-body keys outside the 8 registry fields are rejected', () => {
    for (const key of ['probe', 'invoke']) {
      const entry = validReviewerEntry();
      entry.interactions[key] = {};
      const verdict = validateEntries([entry], { type: 'reviewer' });
      assert.equal(verdict.ok, false, `expected interactions.${key} to be rejected`);
      const err = verdict.errors.find((e) => e.field === `interactions.${key}`);
      assert.ok(err, `expected interactions.${key} error, got: ${JSON.stringify(verdict.errors)}`);
      assert.equal(err.reason, 'unknown field');
    }
  });

  test('an unknown key does not suppress the missing-key sweep', () => {
    const entry = validReviewerEntry();
    entry.interactions.bogus = 'x';
    delete entry.interactions.slug;
    const verdict = validateEntries([entry], { type: 'reviewer' });
    assert.equal(verdict.ok, false);
    const bogusErr = verdict.errors.find((e) => e.field === 'interactions.bogus');
    assert.ok(bogusErr);
    assert.equal(bogusErr.reason, 'unknown field');
    const slugErr = verdict.errors.find((e) => e.field === 'interactions.slug');
    assert.ok(slugErr);
    assert.equal(slugErr.reason, 'missing required field');
  });
});

describe('validateEntries: reviewer — slug grammar', () => {
  test('a kebab slug is valid', () => {
    for (const slug of ['gemini', 'a']) {
      const entry = validReviewerEntry();
      entry.interactions.slug = slug;
      const verdict = validateEntries([entry], { type: 'reviewer' });
      assert.equal(verdict.ok, true, `expected "${slug}" valid, got: ${JSON.stringify(verdict.errors)}`);
    }
  });

  test('an underscored lane slug is valid', () => {
    for (const slug of ['lm_studio', 'llama_cpp']) {
      const entry = validReviewerEntry();
      entry.interactions.slug = slug;
      const verdict = validateEntries([entry], { type: 'reviewer' });
      assert.equal(verdict.ok, true, `expected "${slug}" valid, got: ${JSON.stringify(verdict.errors)}`);
    }
  });

  test('a leading-digit lane slug is valid', () => {
    const entry = validReviewerEntry();
    entry.interactions.slug = '4o-mini';
    const verdict = validateEntries([entry], { type: 'reviewer' });
    assert.equal(verdict.ok, true, `expected "4o-mini" valid, got: ${JSON.stringify(verdict.errors)}`);
  });

  test('a slug may not start with a separator', () => {
    for (const slug of ['-lead', '_lead']) {
      const entry = validReviewerEntry();
      entry.interactions.slug = slug;
      const verdict = validateEntries([entry], { type: 'reviewer' });
      assert.equal(verdict.ok, false, `expected "${slug}" invalid`);
      const err = verdict.errors.find((e) => e.field === 'interactions.slug');
      assert.ok(err, `expected interactions.slug error for "${slug}"`);
      assert.equal(err.reason, 'must match the reviewer lane slug grammar');
    }
  });

  test('a slug outside the lane grammar is rejected', () => {
    for (const slug of ['Upper', 'has space', 'dot.ted', '']) {
      const entry = validReviewerEntry();
      entry.interactions.slug = slug;
      const verdict = validateEntries([entry], { type: 'reviewer' });
      assert.equal(verdict.ok, false, `expected "${slug}" invalid`);
      const err = verdict.errors.find((e) => e.field === 'interactions.slug');
      assert.ok(err, `expected interactions.slug error for "${slug}"`);
      assert.equal(err.reason, 'must match the reviewer lane slug grammar');
    }
  });

  test('a non-string slug is rejected without throwing', () => {
    for (const slug of [123, null]) {
      const entry = validReviewerEntry();
      entry.interactions.slug = slug;
      let verdict;
      assert.doesNotThrow(() => {
        verdict = validateEntries([entry], { type: 'reviewer' });
      });
      assert.equal(verdict.ok, false, `expected ${JSON.stringify(slug)} invalid`);
      const err = verdict.errors.find((e) => e.field === 'interactions.slug');
      assert.ok(err);
      assert.equal(err.reason, 'must match the reviewer lane slug grammar');
    }
  });

  test('fast-check property: any lane-grammar slug is accepted', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
        fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_-'.split('')), { maxLength: 20 }),
        (first, rest) => {
          const slug = first + rest.join('');
          const entry = validReviewerEntry();
          entry.interactions.slug = slug;
          const verdict = validateEntries([entry], { type: 'reviewer' });
          assert.equal(verdict.ok, true, `expected "${slug}" valid, got: ${JSON.stringify(verdict.errors)}`);
        },
      ),
    );
  });

  test('fast-check property: an out-of-grammar character always rejects', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
        fc.array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_-'.split('')), { maxLength: 10 }),
        fc.constantFrom(...'ABCDEFGHIJKLMNOPQRSTUVWXYZ .!@#$%^&*'.split('')),
        fc.nat(10),
        (first, rest, badChar, insertAt) => {
          const base = first + rest.join('');
          const pos = Math.min(insertAt, base.length);
          const slug = base.slice(0, pos) + badChar + base.slice(pos);
          const entry = validReviewerEntry();
          entry.interactions.slug = slug;
          const verdict = validateEntries([entry], { type: 'reviewer' });
          assert.equal(verdict.ok, false, `expected "${slug}" invalid`);
        },
      ),
    );
  });
});

describe('validateEntries: reviewer — flags grammar', () => {
  test('a single well-formed flag is valid', () => {
    for (const flags of [['--gemini'], ['--a', '--b', '--c']]) {
      const entry = validReviewerEntry();
      entry.interactions.flags = flags;
      const verdict = validateEntries([entry], { type: 'reviewer' });
      assert.equal(verdict.ok, true, `expected ${JSON.stringify(flags)} valid, got: ${JSON.stringify(verdict.errors)}`);
    }
  });

  test('an empty flags array is rejected', () => {
    const entry = validReviewerEntry();
    entry.interactions.flags = [];
    const verdict = validateEntries([entry], { type: 'reviewer' });
    assert.equal(verdict.ok, false);
    const err = verdict.errors.find((e) => e.field === 'interactions.flags');
    assert.ok(err);
    assert.equal(err.reason, 'must be a non-empty array of lane CLI flags');
  });

  test('duplicate flags are accepted — the registry is a directory, not the runtime validator', () => {
    const entry = validReviewerEntry();
    entry.interactions.flags = ['--gemini', '--gemini'];
    const verdict = validateEntries([entry], { type: 'reviewer' });
    assert.equal(verdict.ok, true, `expected duplicate flags valid, got: ${JSON.stringify(verdict.errors)}`);
  });

  test('a flag must carry the double-dash prefix', () => {
    for (const flags of [['gemini'], ['-g']]) {
      const entry = validReviewerEntry();
      entry.interactions.flags = flags;
      const verdict = validateEntries([entry], { type: 'reviewer' });
      assert.equal(verdict.ok, false, `expected ${JSON.stringify(flags)} invalid`);
      const err = verdict.errors.find((e) => e.field === 'interactions.flags');
      assert.ok(err);
      assert.equal(err.reason, 'must be a non-empty array of lane CLI flags');
    }
  });

  test('a flag outside the kebab flag grammar is rejected', () => {
    for (const flags of [['--Gemini'], ['--lm_studio']]) {
      const entry = validReviewerEntry();
      entry.interactions.flags = flags;
      const verdict = validateEntries([entry], { type: 'reviewer' });
      assert.equal(verdict.ok, false, `expected ${JSON.stringify(flags)} invalid`);
      const err = verdict.errors.find((e) => e.field === 'interactions.flags');
      assert.ok(err);
      assert.equal(err.reason, 'must be a non-empty array of lane CLI flags');
    }
  });

  test('a non-array / non-string-element flags is rejected', () => {
    for (const flags of [[1], '--gemini']) {
      const entry = validReviewerEntry();
      entry.interactions.flags = flags;
      let verdict;
      assert.doesNotThrow(() => {
        verdict = validateEntries([entry], { type: 'reviewer' });
      });
      assert.equal(verdict.ok, false, `expected ${JSON.stringify(flags)} invalid`);
      const err = verdict.errors.find((e) => e.field === 'interactions.flags');
      assert.ok(err);
      assert.equal(err.reason, 'must be a non-empty array of lane CLI flags');
    }
  });
});

describe('validateEntries: reviewer — transport / evidenceClass', () => {
  test('each allowed transport is accepted', () => {
    for (const transport of REVIEWER_LANE_TRANSPORTS) {
      const entry = validReviewerEntry();
      entry.interactions.transport = transport;
      const verdict = validateEntries([entry], { type: 'reviewer' });
      assert.equal(verdict.ok, true, `expected transport "${transport}" valid, got: ${JSON.stringify(verdict.errors)}`);
    }
  });

  test('an unknown transport is rejected', () => {
    for (const transport of ['SPAWN', 'http', '', 1, null, ['spawn']]) {
      const entry = validReviewerEntry();
      entry.interactions.transport = transport;
      const verdict = validateEntries([entry], { type: 'reviewer' });
      assert.equal(verdict.ok, false, `expected transport ${JSON.stringify(transport)} invalid`);
      const err = verdict.errors.find((e) => e.field === 'interactions.transport');
      assert.ok(err);
      assert.equal(err.reason, 'must be one of the allowed lane transports');
    }
  });

  test('each allowed evidence class is accepted', () => {
    for (const evidenceClass of REVIEWER_EVIDENCE_CLASSES) {
      const entry = validReviewerEntry();
      entry.interactions.evidenceClass = evidenceClass;
      const verdict = validateEntries([entry], { type: 'reviewer' });
      assert.equal(verdict.ok, true, `expected evidenceClass "${evidenceClass}" valid, got: ${JSON.stringify(verdict.errors)}`);
    }
  });

  test('an unknown evidence class is rejected', () => {
    for (const evidenceClass of ['diff', 'Source-Grounded', 1, null, ['diff-only']]) {
      const entry = validReviewerEntry();
      entry.interactions.evidenceClass = evidenceClass;
      const verdict = validateEntries([entry], { type: 'reviewer' });
      assert.equal(verdict.ok, false, `expected evidenceClass ${JSON.stringify(evidenceClass)} invalid`);
      const err = verdict.errors.find((e) => e.field === 'interactions.evidenceClass');
      assert.ok(err);
      assert.equal(err.reason, 'must be one of the allowed evidence classes');
    }
  });
});

describe('validateEntries: reviewer — reviewsSection', () => {
  test('a plain reviewsSection is valid', () => {
    const entry = validReviewerEntry();
    entry.interactions.reviewsSection = 'Gemini';
    const verdict = validateEntries([entry], { type: 'reviewer' });
    assert.equal(verdict.ok, true, `expected valid, got: ${JSON.stringify(verdict.errors)}`);
  });

  test('reviewsSection at and just below the cap is valid', () => {
    for (const len of [REVIEWER_SECTION_MAX - 1, REVIEWER_SECTION_MAX]) {
      const entry = validReviewerEntry();
      entry.interactions.reviewsSection = 'x'.repeat(len);
      const verdict = validateEntries([entry], { type: 'reviewer' });
      assert.equal(verdict.ok, true, `expected len ${len} valid, got: ${JSON.stringify(verdict.errors)}`);
    }
  });

  test('reviewsSection above the cap is rejected', () => {
    const entry = validReviewerEntry();
    entry.interactions.reviewsSection = 'x'.repeat(REVIEWER_SECTION_MAX + 1);
    const verdict = validateEntries([entry], { type: 'reviewer' });
    assert.equal(verdict.ok, false);
    const err = verdict.errors.find(
      (e) => e.field === 'interactions.reviewsSection' && new RegExp(`exceeds max length ${REVIEWER_SECTION_MAX}`).test(e.reason),
    );
    assert.ok(err, `expected an exceeds-max-length error, got: ${JSON.stringify(verdict.errors)}`);
  });

  test('a blank reviewsSection is rejected', () => {
    for (const reviewsSection of ['', '   ', 123, null]) {
      const entry = validReviewerEntry();
      entry.interactions.reviewsSection = reviewsSection;
      const verdict = validateEntries([entry], { type: 'reviewer' });
      assert.equal(verdict.ok, false, `expected ${JSON.stringify(reviewsSection)} invalid`);
      const err = verdict.errors.find((e) => e.field === 'interactions.reviewsSection');
      assert.ok(err);
      assert.equal(err.reason, 'must be a non-empty string');
    }
  });
});

describe('validateEntries: reviewer — may-be-empty arrays', () => {
  test('the may-be-empty arrays accept []', () => {
    const entry = validReviewerEntry();
    entry.interactions.requiresBinaries = [];
    entry.interactions.configKeys = [];
    const verdict = validateEntries([entry], { type: 'reviewer' });
    assert.equal(verdict.ok, true, `expected valid, got: ${JSON.stringify(verdict.errors)}`);
  });

  test('runtimeCompat accepts the all wildcard', () => {
    for (const runtimeCompat of [['all'], []]) {
      const entry = validReviewerEntry();
      entry.interactions.runtimeCompat = runtimeCompat;
      const verdict = validateEntries([entry], { type: 'reviewer' });
      assert.equal(verdict.ok, true, `expected ${JSON.stringify(runtimeCompat)} valid, got: ${JSON.stringify(verdict.errors)}`);
    }
  });

  test('a non-string-array is rejected for each array field', () => {
    for (const field of ['requiresBinaries', 'configKeys', 'runtimeCompat']) {
      for (const bad of [[1], 'a', {}]) {
        const entry = validReviewerEntry();
        entry.interactions[field] = bad;
        const verdict = validateEntries([entry], { type: 'reviewer' });
        assert.equal(verdict.ok, false, `expected interactions.${field} = ${JSON.stringify(bad)} invalid`);
        const err = verdict.errors.find((e) => e.field === `interactions.${field}`);
        assert.ok(err, `expected interactions.${field} error, got: ${JSON.stringify(verdict.errors)}`);
        assert.equal(err.reason, 'must be an array of strings');
      }
    }
  });
});

// ─── renderMarkdown: reviewer registry ─────────────────────────────────────

describe('renderMarkdown: reviewer registry', () => {
  test('an empty reviewer catalog renders the reviewer heading, not the capability one', () => {
    const rendered = renderMarkdown([], { type: 'reviewer', sourceFile: 'reviewers.json' });
    assert.match(rendered, /# GSD Reviewer Lane Registry/);
    assert.ok(rendered.includes('_To add your reviewer lane, see the [registry README](./README.md)._'));
    assert.match(rendered, /No entries yet/);
  });

  test('a reviewer entry renders its lane summary', () => {
    const entry = validReviewerEntry();
    const rendered = renderMarkdown([entry], { type: 'reviewer', sourceFile: 'reviewers.json' });
    const { slug, flags, transport, evidenceClass, reviewsSection } = entry.interactions;
    const expected =
      `Lane: ${slug}; flags: ${flags.join(', ')}; transport: ${transport}; evidence: ${evidenceClass}; ` +
      `REVIEWS.md section: ${reviewsSection}`;
    const line = rendered.split('\n').find((l) => l.startsWith('- **Every interaction with GSD:** '));
    assert.ok(line, `expected the summary bullet line, got: ${rendered}`);
    assert.ok(line.includes(expected), `expected summary to include "${expected}", got: ${line}`);
  });

  test('empty optional arrays are omitted from the rendered summary', () => {
    const entry = validReviewerEntry();
    entry.interactions.requiresBinaries = [];
    entry.interactions.configKeys = [];
    const renderedEmpty = renderMarkdown([entry], { type: 'reviewer', sourceFile: 'reviewers.json' });
    assert.ok(!renderedEmpty.includes('requiresBinaries:'));
    assert.ok(!renderedEmpty.includes('configKeys:'));

    entry.interactions.requiresBinaries = ['ffmpeg'];
    entry.interactions.configKeys = ['review.foo'];
    const renderedPopulated = renderMarkdown([entry], { type: 'reviewer', sourceFile: 'reviewers.json' });
    assert.ok(renderedPopulated.includes('requiresBinaries: ffmpeg'));
    assert.ok(renderedPopulated.includes('configKeys: review.foo'));
  });

  test('reviewer rendering is deterministic regardless of input order', () => {
    const a = validReviewerEntry();
    const b = { ...validReviewerEntry(), id: 'zzz-reviewer', name: 'ZZZ Reviewer' };
    const first = renderMarkdown([a, b], { type: 'reviewer', sourceFile: 'reviewers.json' });
    const second = renderMarkdown([b, a], { type: 'reviewer', sourceFile: 'reviewers.json' });
    assert.equal(first, second);
  });

  test('untrusted reviewer free text cannot break out of the table', () => {
    const entry = validReviewerEntry();
    entry.description = 'Good stuff | ![x](https://evil/track.png) | text';
    entry.interactions.reviewsSection = 'Gemini | ```evil``` <script> [x](y)';
    const rendered = renderMarkdown([entry], { type: 'reviewer', sourceFile: 'reviewers.json' });

    assert.ok(rendered.includes('\\|'), 'expected an escaped pipe (\\|) in the rendered output');
    assert.ok(
      !rendered.includes('![x](https://evil/track.png)'),
      'expected the raw unescaped link-hijack payload to NOT appear verbatim',
    );
    assert.ok(rendered.includes('\\['), 'expected an escaped [ (\\[)');

    const line = rendered.split('\n').find((l) => l.startsWith('- **Every interaction with GSD:** '));
    assert.ok(line, 'expected the summary bullet line');
    assert.ok(!line.includes('```evil```'), 'expected the raw backtick run in reviewsSection to be escaped');
    assert.ok(!line.includes('<script>'), 'expected angle brackets in reviewsSection to be escaped');
    assert.ok(!line.includes('](y)'), 'expected the reviewsSection link-hijack payload to be neutralized');
  });
});

// ─── renderMarkdown: capability/eos rendering unchanged by the third type ──

describe('renderMarkdown: capability and eos rendering are unchanged by the third type', () => {
  // Golden snapshots captured from the module BEFORE the reviewer type was
  // implemented (git rev 9f567a162, unmodified scripts/registry-schema.cjs).
  // The reviewer feature must not perturb a single byte of capability/eos
  // output — this is the regression pin for matrix row 55.
  const GOLDEN_CAPABILITY_MD = "<!-- GENERATED by scripts/gen-registry.cjs from docs/registries/capabilities.json — do not edit by hand; run `npm run gen:registry` -->\n\n# GSD Community Capability Registry\n\n> **Not an endorsement.** Inclusion means only that a maintainer merged a PR linking the author's repository — GSD has not reviewed, tested, or verified any listing. See the [registry README](./README.md).\n\n_To add your capability, see the [registry README](./README.md)._\n\n| Name | What it is | Latest release | GSD compat | Discussion |\n|---|---|---|---|---|\n| [My Capability](https://github.com/octocat/my-capability) | Does a useful thing for GSD users. | ![release](https://img.shields.io/github/v/release/octocat/my-capability?sort=semver&include_prereleases) | `>=1.6.0 <3.0.0` | [discuss](https://github.com/octocat/my-capability/discussions/1) |\n\n## My Capability\n- **Repository:** https://github.com/octocat/my-capability — [latest release](https://github.com/octocat/my-capability/releases/latest)\n- **What it is:** Does a useful thing for GSD users.\n- **Author:** Octocat\n- **Every interaction with GSD:** Loop Extension Points: execute:pre; hook kinds: step; configKeys: myCapability.enabled; runtimeCompat: all\n- **Install:**\n```sh\ngsd capability install https://github.com/octocat/my-capability.git#v1.0.0\n```\n- **Uninstall:**\n```sh\ngsd capability remove my-capability\n```\n- **GSD compatibility:** `>=1.6.0 <3.0.0`\n- **License:** MIT\n- **Discussion / ranking:** https://github.com/octocat/my-capability/discussions/1\n";
  const GOLDEN_EOS_MD = "<!-- GENERATED by scripts/gen-registry.cjs from docs/registries/eos.json — do not edit by hand; run `npm run gen:registry` -->\n\n# GSD EoS Registry\n\n> **Not an endorsement.** Inclusion means only that a maintainer merged a PR linking the author's repository — GSD has not reviewed, tested, or verified any listing. See the [registry README](./README.md).\n\n_To add your integration, see the [registry README](./README.md)._\n\n| Name | What it is | Latest release | GSD compat | Discussion |\n|---|---|---|---|---|\n| [My Host Plugin](https://github.com/octocat/my-host-plugin) | Embeds GSD as an orchestration engine in My Host. | ![release](https://img.shields.io/github/v/release/octocat/my-host-plugin?sort=semver&include_prereleases) | `>=1.6.0 <3.0.0` | [discuss](https://github.com/octocat/my-host-plugin/discussions/2) |\n\n## My Host Plugin\n- **Repository:** https://github.com/octocat/my-host-plugin — [latest release](https://github.com/octocat/my-host-plugin/releases/latest)\n- **What it is:** Embeds GSD as an orchestration engine in My Host.\n- **Author:** Octocat\n- **Every interaction with GSD:** Interface points: command, state; profile: programmatic-cli; protocol v1; axes: embeddingMode=imperative, commandSurface=slash-file, dispatch=Supports nested background dispatch up to depth 3., modelMode=active, hookBus=host, stateIO=filesystem, transport=mcp, runtime=node\n- **Install:**\n```sh\nSee the My Host plugin marketplace listing.\n```\n- **Uninstall:**\n```sh\nUninstall via the My Host plugin manager.\n```\n- **GSD compatibility:** `>=1.6.0 <3.0.0`, protocol v1\n- **License:** MIT\n- **Discussion / ranking:** https://github.com/octocat/my-host-plugin/discussions/2\n";

  test('capability rendering is byte-identical to the pre-reviewer-type golden output', () => {
    const rendered = renderMarkdown([validCapabilityEntry()], { type: 'capability', sourceFile: 'capabilities.json' });
    assert.equal(rendered, GOLDEN_CAPABILITY_MD);
  });

  test('eos rendering is byte-identical to the pre-reviewer-type golden output', () => {
    const rendered = renderMarkdown([validEosEntry()], { type: 'eos', sourceFile: 'eos.json' });
    assert.equal(rendered, GOLDEN_EOS_MD);
  });
});

// ─── validateEntries: interactions array-of-strings hardening (control chars,
// per-element length cap, array count cap) — capability and reviewer types ──

describe('validateEntries: interactions string-array fields — control characters', () => {
  test('capability interactions.configKeys element with a control char is rejected', () => {
    const entry = validCapabilityEntry();
    entry.interactions.configKeys = ['a\x00b'];
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    const err = verdict.errors.find((e) => e.field === 'interactions.configKeys');
    assert.ok(err, `expected interactions.configKeys error, got: ${JSON.stringify(verdict.errors)}`);
    assert.equal(err.reason, 'must not contain control characters');
  });

  test('reviewer interactions.requiresBinaries element with a control char is rejected', () => {
    const entry = validReviewerEntry();
    entry.interactions.requiresBinaries = ['a\x00b'];
    const verdict = validateEntries([entry], { type: 'reviewer' });
    assert.equal(verdict.ok, false);
    const err = verdict.errors.find((e) => e.field === 'interactions.requiresBinaries');
    assert.ok(err, `expected interactions.requiresBinaries error, got: ${JSON.stringify(verdict.errors)}`);
    assert.equal(err.reason, 'must not contain control characters');
  });
});

describe('validateEntries: interactions string-array fields — per-element length cap', () => {
  test('capability interactions.configKeys element at 199/200 chars (limit-1/limit) is valid', () => {
    for (const len of [INTERACTION_STRING_MAX - 1, INTERACTION_STRING_MAX]) {
      const entry = validCapabilityEntry();
      entry.interactions.configKeys = ['x'.repeat(len)];
      const verdict = validateEntries([entry], { type: 'capability' });
      assert.equal(
        verdict.errors.some((e) => e.field === 'interactions.configKeys'),
        false,
        `expected len ${len} valid, got: ${JSON.stringify(verdict.errors)}`,
      );
    }
  });

  test('capability interactions.configKeys element at 201 chars (limit+1) is rejected', () => {
    const entry = validCapabilityEntry();
    entry.interactions.configKeys = ['x'.repeat(INTERACTION_STRING_MAX + 1)];
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    const err = verdict.errors.find((e) => e.field === 'interactions.configKeys');
    assert.ok(err, `expected interactions.configKeys error, got: ${JSON.stringify(verdict.errors)}`);
    assert.equal(err.reason, `exceeds max length ${INTERACTION_STRING_MAX}`);
  });

  test('reviewer interactions.requiresBinaries element at 199/200 chars (limit-1/limit) is valid', () => {
    for (const len of [INTERACTION_STRING_MAX - 1, INTERACTION_STRING_MAX]) {
      const entry = validReviewerEntry();
      entry.interactions.requiresBinaries = ['x'.repeat(len)];
      const verdict = validateEntries([entry], { type: 'reviewer' });
      assert.equal(
        verdict.errors.some((e) => e.field === 'interactions.requiresBinaries'),
        false,
        `expected len ${len} valid, got: ${JSON.stringify(verdict.errors)}`,
      );
    }
  });

  test('reviewer interactions.requiresBinaries element at 201 chars (limit+1) is rejected', () => {
    const entry = validReviewerEntry();
    entry.interactions.requiresBinaries = ['x'.repeat(INTERACTION_STRING_MAX + 1)];
    const verdict = validateEntries([entry], { type: 'reviewer' });
    assert.equal(verdict.ok, false);
    const err = verdict.errors.find((e) => e.field === 'interactions.requiresBinaries');
    assert.ok(err, `expected interactions.requiresBinaries error, got: ${JSON.stringify(verdict.errors)}`);
    assert.equal(err.reason, `exceeds max length ${INTERACTION_STRING_MAX}`);
  });
});

describe('validateEntries: interactions string-array fields — array count cap', () => {
  test('capability interactions.configKeys at 49/50 elements (limit-1/limit) is valid', () => {
    for (const n of [INTERACTION_ARRAY_MAX - 1, INTERACTION_ARRAY_MAX]) {
      const entry = validCapabilityEntry();
      entry.interactions.configKeys = Array.from({ length: n }, (_, i) => `k${i}`);
      const verdict = validateEntries([entry], { type: 'capability' });
      assert.equal(
        verdict.errors.some((e) => e.field === 'interactions.configKeys'),
        false,
        `expected ${n} elements valid, got: ${JSON.stringify(verdict.errors)}`,
      );
    }
  });

  test('capability interactions.configKeys at 51 elements (limit+1) is rejected', () => {
    const entry = validCapabilityEntry();
    entry.interactions.configKeys = Array.from({ length: INTERACTION_ARRAY_MAX + 1 }, (_, i) => `k${i}`);
    const verdict = validateEntries([entry], { type: 'capability' });
    assert.equal(verdict.ok, false);
    const err = verdict.errors.find((e) => e.field === 'interactions.configKeys');
    assert.ok(err, `expected interactions.configKeys error, got: ${JSON.stringify(verdict.errors)}`);
    assert.equal(err.reason, `exceeds max entries ${INTERACTION_ARRAY_MAX}`);
  });

  test('reviewer interactions.requiresBinaries at 49/50 elements (limit-1/limit) is valid', () => {
    for (const n of [INTERACTION_ARRAY_MAX - 1, INTERACTION_ARRAY_MAX]) {
      const entry = validReviewerEntry();
      entry.interactions.requiresBinaries = Array.from({ length: n }, (_, i) => `b${i}`);
      const verdict = validateEntries([entry], { type: 'reviewer' });
      assert.equal(
        verdict.errors.some((e) => e.field === 'interactions.requiresBinaries'),
        false,
        `expected ${n} elements valid, got: ${JSON.stringify(verdict.errors)}`,
      );
    }
  });

  test('reviewer interactions.requiresBinaries at 51 elements (limit+1) is rejected', () => {
    const entry = validReviewerEntry();
    entry.interactions.requiresBinaries = Array.from({ length: INTERACTION_ARRAY_MAX + 1 }, (_, i) => `b${i}`);
    const verdict = validateEntries([entry], { type: 'reviewer' });
    assert.equal(verdict.ok, false);
    const err = verdict.errors.find((e) => e.field === 'interactions.requiresBinaries');
    assert.ok(err, `expected interactions.requiresBinaries error, got: ${JSON.stringify(verdict.errors)}`);
    assert.equal(err.reason, `exceeds max entries ${INTERACTION_ARRAY_MAX}`);
  });
});

describe('validateEntries: reviewer interactions.reviewsSection — control characters', () => {
  test('reviewsSection containing ESC (\\x1b) is rejected', () => {
    const entry = validReviewerEntry();
    entry.interactions.reviewsSection = 'Sec\x1bRED';
    const verdict = validateEntries([entry], { type: 'reviewer' });
    assert.equal(verdict.ok, false);
    const err = verdict.errors.find((e) => e.field === 'interactions.reviewsSection');
    assert.ok(err, `expected interactions.reviewsSection error, got: ${JSON.stringify(verdict.errors)}`);
    assert.equal(err.reason, 'must not contain control characters');
  });
});

describe('validateEntries: regression — hostile interactions entry can no longer validate', () => {
  test('the control-char/oversized-array reviewer entry from the security-review repro is rejected', () => {
    const entry = {
      id: 'x',
      name: 'X',
      type: 'reviewer',
      repo: 'o/r',
      description: 'd',
      author: 'a',
      license: 'MIT',
      enginesGsd: '>=1.6.0',
      install: 'i',
      uninstall: 'u',
      discussion: 'https://github.com/o/r/discussions/1',
      interactions: {
        slug: 'x',
        flags: ['--x'],
        transport: 'spawn',
        evidenceClass: 'diff-only',
        reviewsSection: 'Sec\x1b[31mRED\x1b[0m',
        requiresBinaries: ['bin\x00null', 'y'.repeat(5000)],
        configKeys: [],
        runtimeCompat: ['all'],
      },
    };
    const verdict = validateEntries([entry], { type: 'reviewer' });
    assert.equal(verdict.ok, false);
    assert.ok(
      verdict.errors.some(
        (e) => e.field === 'interactions.reviewsSection' && e.reason === 'must not contain control characters',
      ),
      `expected reviewsSection control-char rejection, got: ${JSON.stringify(verdict.errors)}`,
    );
    assert.ok(
      verdict.errors.some(
        (e) => e.field === 'interactions.requiresBinaries' && e.reason === 'must not contain control characters',
      ),
      `expected requiresBinaries control-char rejection, got: ${JSON.stringify(verdict.errors)}`,
    );
    assert.ok(
      verdict.errors.some(
        (e) => e.field === 'interactions.requiresBinaries' && e.reason === `exceeds max length ${INTERACTION_STRING_MAX}`,
      ),
      `expected requiresBinaries length rejection, got: ${JSON.stringify(verdict.errors)}`,
    );
  });
});
