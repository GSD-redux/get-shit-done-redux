'use strict';

/**
 * check:contract-drift tests (#3565).
 *
 * Behavioral contract for scripts/check-contract-drift.cjs and the
 * marker/registry primitives it shares with
 * scripts/command-contract-helpers.cjs. Three layers:
 *
 *   1. Pure-function tests over the typed IR (extractMarkers,
 *      parseAgentContracts, contractViolations, parseConsumedByCell,
 *      readTagViolations, unmatchedConsumerTokens) — one row per input
 *      class in .gsd/phase/feat-3565-contract-drift-registry/50-test-matrix.md.
 *   2. A seeded fast-check property: for any interleaving of fenced and
 *      unfenced blocks, every extracted marker's inFence matches the
 *      block's declared fenced-ness (fence tracking is the load-bearing
 *      half of extraction — the census that motivated #3565 produced 7
 *      false positives before it was fence-aware).
 *   3. End-to-end CLI tests against --root fixture trees, including the
 *      negative fixtures proving each rule can FAIL (a guard that cannot
 *      fail is worthless — recorded defect class in this repo).
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const fc = require('fast-check');

const ROOT = path.join(__dirname, '..');
const CHECK_SCRIPT = path.join(ROOT, 'scripts', 'check-contract-drift.cjs');
const {
  extractMarkers,
  parseAgentContracts,
  contractViolations,
  parseConsumedByCell,
  readTagViolations,
  unmatchedConsumerTokens,
  NON_AGENT_TOKENS,
  VIOLATION_KINDS,
  REMEDIES,
  sanitizeEcho,
} = require('../scripts/command-contract-helpers.cjs');
const { runNode, OUTCOME } = require('./helpers/process-seam.cjs');
const { PROBE_TIMEOUT_MS } = require('./helpers/timeouts.cjs');
const { createTempDir, cleanup } = require('./helpers.cjs');

// ─── Part A: extractMarkers (the strict half) ────────────────────────────────

describe('contract-drift: extractMarkers fence awareness', () => {
  const KNOWN = ['RESEARCH COMPLETE', 'PLANNING COMPLETE'];

  test('marker heading inside a fence is inFence', () => {
    const md = 'prose\n\n```\n## RESEARCH COMPLETE\n```\n';
    const { markers } = extractMarkers(md, KNOWN);
    assert.deepEqual(
      markers.map((m) => ({ marker: m.marker, inFence: m.inFence })),
      [{ marker: 'RESEARCH COMPLETE', inFence: true }],
    );
  });

  test('the same heading outside a fence is extracted with inFence false', () => {
    const md = '## RESEARCH COMPLETE\n';
    const { markers } = extractMarkers(md, KNOWN);
    assert.deepEqual(
      markers.map((m) => m.inFence),
      [false],
    );
  });

  test('prose "then mark each complete" is not extracted at all', () => {
    const md = 'Execute the plan, then mark each complete in STATE.md.\n';
    const { markers, candidates } = extractMarkers(md, KNOWN);
    assert.deepEqual(markers, []);
    assert.deepEqual(candidates, []);
  });

  test('a heading whose COMPLETE is not terminal is not a candidate', () => {
    const md = '```\n## Nearly Complete Refactor\n```\n';
    const { markers, candidates } = extractMarkers(md, KNOWN);
    assert.deepEqual(markers, []);
    assert.deepEqual(candidates, []);
  });

  test('heading levels 1 through 6 are all extracted', () => {
    const md = [
      '# PLANNING COMPLETE',
      '## PLANNING COMPLETE',
      '### PLANNING COMPLETE',
      '#### PLANNING COMPLETE',
      '##### PLANNING COMPLETE',
      '###### PLANNING COMPLETE',
    ].join('\n');
    const { markers } = extractMarkers(md, KNOWN);
    assert.equal(markers.length, 6);
  });

  test('an unclosed fence is reported, not silently treated as fenced-to-EOF', () => {
    const md = '```\n## RESEARCH COMPLETE\n';
    const { markers, unclosedFence } = extractMarkers(md, KNOWN);
    assert.equal(unclosedFence, true);
    // the heading IS inside the (unclosed) fence — extraction continues,
    // the caller decides whether to trust it
    assert.equal(markers[0].inFence, true);
  });

  test('a 3-backtick block inside a 4-backtick fence does not close the outer fence', () => {
    const md = ['````', '## PLANNING COMPLETE', '', '```', 'inner', '```', '', '## RESEARCH COMPLETE', '````'].join('\n');
    const { markers, unclosedFence } = extractMarkers(md, KNOWN);
    assert.equal(unclosedFence, false);
    assert.equal(markers.length, 2);
    assert.ok(markers.every((m) => m.inFence));
  });

  test('tilde fences behave like backtick fences', () => {
    const md = '~~~\n## RESEARCH COMPLETE\n~~~\n';
    const { markers, unclosedFence } = extractMarkers(md, KNOWN);
    assert.equal(unclosedFence, false);
    assert.deepEqual(
      markers.map((m) => m.inFence),
      [true],
    );
  });

  test('CRLF input yields identical results to LF', () => {
    const lf = '```\n## RESEARCH COMPLETE\n```\n\n## PLANNING COMPLETE\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    const a = extractMarkers(lf, KNOWN);
    const b = extractMarkers(crlf, KNOWN);
    assert.deepEqual(a.markers, b.markers);
    assert.equal(a.unclosedFence, b.unclosedFence);
  });

  test('empty string returns empty results without throwing', () => {
    assert.deepEqual(extractMarkers('', KNOWN), { markers: [], candidates: [], unclosedFence: false });
  });

  test('whitespace-only string returns empty results', () => {
    assert.deepEqual(extractMarkers('   \n\t\n', KNOWN), { markers: [], candidates: [], unclosedFence: false });
  });

  test('trailing spaces after a marker heading are trimmed', () => {
    const md = '## RESEARCH COMPLETE   \n';
    const { markers } = extractMarkers(md, KNOWN);
    assert.deepEqual(
      markers.map((m) => m.marker),
      ['RESEARCH COMPLETE'],
    );
  });

  test('the same marker twice is reported as two occurrences with distinct lines', () => {
    const md = '```\n## RESEARCH COMPLETE\n```\n\n```\n## RESEARCH COMPLETE\n```\n';
    const { markers } = extractMarkers(md, KNOWN);
    assert.deepEqual(
      markers.map((m) => m.line),
      [2, 6],
    );
  });

  test('a 5000-line file terminates and extracts correctly', () => {
    const lines = [];
    for (let i = 0; i < 5000; i++) {
      lines.push(i === 2500 ? '## RESEARCH COMPLETE' : `filler line ${i}`);
    }
    const { markers } = extractMarkers(lines.join('\n'), KNOWN);
    assert.deepEqual(
      markers.map((m) => m.marker),
      ['RESEARCH COMPLETE'],
    );
  });
});

// ─── Part B: parseAgentContracts ─────────────────────────────────────────────

describe('contract-drift: parseAgentContracts', () => {
  const REGISTRY_MD = [
    '# Agent Contracts',
    '',
    '## Agent Registry',
    '',
    '| Agent | Role | Completion Markers | Consumed by | Kind |',
    '|-------|------|--------------------|--------------|------|',
    '| gsd-a | First | `## ALPHA COMPLETE` | `gsd-core/workflows/w.md` | sentinel-match |',
    '| gsd-b | Second | `## BETA COMPLETE`, `## BETA BLOCKED` | prose only | sentinel-match |',
    '| gsd-c | Third | `## GAMMA DRAFT` (unconsumed: user draft, approved in chat) | `gsd-core/workflows/w.md` | sentinel-match |',
    '| gsd-d | Fourth | No marker (writes a file) | `gsd-core/workflows/w.md` | artifact+query |',
    '',
  ].join('\n');

  test('rows parse with parsed marker arrays and kind', () => {
    const { rows, errors } = parseAgentContracts(REGISTRY_MD);
    assert.deepEqual(errors, []);
    assert.equal(rows.length, 4);
    assert.deepEqual(rows[0].completion_markers, ['ALPHA COMPLETE']);
    assert.equal(rows[0].kind, 'sentinel-match');
    assert.equal(rows[0].agent, 'gsd-a');
    assert.deepEqual(rows[1].completion_markers, ['BETA COMPLETE', 'BETA BLOCKED']);
  });

  test('an (unconsumed: …) annotation lands in unconsumed_markers, not completion_markers', () => {
    const { rows } = parseAgentContracts(REGISTRY_MD);
    assert.deepEqual(rows[2].completion_markers, []);
    assert.deepEqual(rows[2].unconsumed_markers, ['GAMMA DRAFT']);
  });

  test('a comma inside the annotation does not split the entry', () => {
    const md = [
      '## Agent Registry',
      '',
      '| Agent | Completion Markers |',
      '|-------|--------------------|',
      '| gsd-x | `## X DRAFT` (unconsumed: draft display, approved interactively) |',
    ].join('\n');
    const { rows } = parseAgentContracts(md);
    assert.deepEqual(rows[0].unconsumed_markers, ['X DRAFT']);
    assert.deepEqual(rows[0].completion_markers, []);
  });

  test('a malformed row is reported in errors, not thrown', () => {
    const md = [
      '## Agent Registry',
      '',
      '| Agent | Completion Markers |',
      '|-------|--------------------|',
      '| gsd-good | `## OK COMPLETE` |',
      '| broken row missing cells |',
      '|  | `## NO AGENT` |',
    ].join('\n');
    const { rows, errors } = parseAgentContracts(md);
    assert.equal(rows.length, 1);
    assert.equal(errors.length, 2);
    assert.ok(errors.every((e) => typeof e.line === 'number' && e.reason.length > 0));
  });

  test('markdown without an Agent Registry section returns empty', () => {
    const { rows, errors } = parseAgentContracts('# Nothing here\n');
    assert.deepEqual(rows, []);
    assert.deepEqual(errors, []);
  });
});

// ─── Part B: contractViolations (the model) ─────────────────────────────────

describe('contract-drift: contractViolations', () => {
  function row(agent, markers, kind, extra = {}) {
    return { agent, completion_markers: markers, kind, ...extra };
  }
  function run({ registry, producers, candidates, consumers }) {
    return contractViolations({
      registry,
      producerMarkers: producers || new Map(),
      candidateMarkers: candidates || new Map(),
      consumerTexts: consumers || new Map(),
    });
  }
  const kindsOf = (vs) => [...new Set(vs.map((v) => v.kind))].sort();

  test('sentinel-match with a workflow consumer containing the token is satisfied', () => {
    const vs = run({
      registry: [row('gsd-a', ['ALPHA COMPLETE'], 'sentinel-match')],
      producers: new Map([['gsd-a', ['ALPHA COMPLETE']]]),
      consumers: new Map([['gsd-core/workflows/w.md', 'match `## ALPHA COMPLETE` here']]),
    });
    assert.deepEqual(vs, []);
  });

  test('sentinel-match with a command consumer is satisfied', () => {
    const vs = run({
      registry: [row('gsd-a', ['ALPHA COMPLETE'], 'sentinel-match')],
      producers: new Map([['gsd-a', ['ALPHA COMPLETE']]]),
      consumers: new Map([['commands/gsd/x.md', 'dispatch on `## ALPHA COMPLETE`']]),
    });
    assert.deepEqual(vs, []);
  });

  test('sentinel-match with another AGENT as consumer is satisfied (the gsd-debugger shape)', () => {
    const vs = run({
      registry: [row('gsd-a', ['ALPHA COMPLETE'], 'sentinel-match')],
      producers: new Map([['gsd-a', ['ALPHA COMPLETE']]]),
      consumers: new Map([['agents/gsd-b.md', 'when the agent returns `## ALPHA COMPLETE`']]),
    });
    assert.deepEqual(vs, []);
  });

  test('sentinel-match with no consumer is a no_consumer violation naming producer and token', () => {
    const vs = run({
      registry: [row('gsd-a', ['ALPHA COMPLETE'], 'sentinel-match')],
      producers: new Map([['gsd-a', ['ALPHA COMPLETE']]]),
      consumers: new Map([['gsd-core/workflows/w.md', 'unrelated text']]),
    });
    assert.equal(vs.length, 1);
    assert.equal(vs[0].kind, 'no_consumer');
    assert.equal(vs[0].agent, 'gsd-a');
    assert.equal(vs[0].marker, 'ALPHA COMPLETE');
  });

  test('an agent never satisfies its own marker', () => {
    const vs = run({
      registry: [row('gsd-a', ['ALPHA COMPLETE'], 'sentinel-match')],
      producers: new Map([['gsd-a', ['ALPHA COMPLETE']]]),
      consumers: new Map([['agents/gsd-a.md', 'I emit `## ALPHA COMPLETE` myself']]),
    });
    assert.equal(vs.length, 1);
    assert.equal(vs[0].kind, 'no_consumer');
  });

  test('artifact+query with no marker emitted is satisfied', () => {
    const vs = run({
      registry: [row('gsd-d', [], 'artifact+query')],
      producers: new Map([['gsd-d', []]]),
    });
    assert.deepEqual(vs, []);
  });

  test('artifact+query that still emits a marker is a vestigial_marker violation', () => {
    const vs = run({
      registry: [row('gsd-d', [], 'artifact+query')],
      producers: new Map([['gsd-d', ['VESTIGIAL COMPLETE']]]),
      candidates: new Map([['gsd-d', ['VESTIGIAL COMPLETE']]]),
    });
    assert.equal(vs.length, 1);
    assert.equal(vs[0].kind, 'vestigial_marker');
    assert.equal(vs[0].marker, 'VESTIGIAL COMPLETE');
  });

  test('an (unconsumed:) annotation on an artifact+query row exempts vestigial_marker (Marker Rule 2 recorded decision)', () => {
    const vs = run({
      registry: [row('gsd-v', [], 'artifact+query', { unconsumed_markers: ['Verification Complete'] })],
      producers: new Map([['gsd-v', ['Verification Complete']]]),
    });
    assert.deepEqual(vs, []);
  });

  test('a roster agent with no registry row is agent_without_contract', () => {
    const vs = run({
      registry: [row('gsd-a', ['ALPHA COMPLETE'], 'sentinel-match')],
      producers: new Map([
        ['gsd-a', ['ALPHA COMPLETE']],
        ['gsd-orphan', []],
      ]),
      consumers: new Map([['gsd-core/workflows/w.md', 'x `## ALPHA COMPLETE`']]),
    });
    assert.equal(vs.length, 1);
    assert.equal(vs[0].kind, 'agent_without_contract');
    assert.equal(vs[0].agent, 'gsd-orphan');
  });

  test('two rows for one agent are duplicate_registry_row', () => {
    const vs = run({
      registry: [
        row('gsd-a', ['ALPHA COMPLETE'], 'sentinel-match'),
        row('gsd-a', ['ALPHA RETRY'], 'sentinel-match'),
      ],
      producers: new Map([['gsd-a', ['ALPHA COMPLETE', 'ALPHA RETRY']]]),
      consumers: new Map([['gsd-core/workflows/w.md', '`## ALPHA COMPLETE` and `## ALPHA RETRY`']]),
    });
    assert.equal(vs.length, 1);
    assert.equal(vs[0].kind, 'duplicate_registry_row');
  });

  test('a row naming an agent with no file is unknown_producer, without per-marker noise', () => {
    const vs = run({
      registry: [
        row('gsd-ghost', ['GHOST COMPLETE'], 'sentinel-match'),
        row('gsd-real', [], 'artifact+query'),
      ],
      producers: new Map([['gsd-real', []]]),
    });
    assert.deepEqual(kindsOf(vs), ['unknown_producer']);
  });

  test('a file-shaped Consumed by entry that resolves to nothing is unknown_consumer', () => {
    const vs = run({
      registry: [row('gsd-a', ['ALPHA COMPLETE'], 'sentinel-match', { consumed_by: '`gsd-core/workflows/missing.md`' })],
      producers: new Map([['gsd-a', ['ALPHA COMPLETE']]]),
      consumers: new Map([['gsd-core/workflows/real.md', '`## ALPHA COMPLETE`']]),
    });
    assert.deepEqual(kindsOf(vs), ['unknown_consumer']);
  });

  test('an empty registry and empty producers yield no violations', () => {
    assert.deepEqual(run({ registry: [], producers: new Map() }), []);
  });

  test('an empty registry with producers flags every producer', () => {
    const vs = run({
      registry: [],
      producers: new Map([
        ['gsd-a', []],
        ['gsd-b', []],
      ]),
    });
    assert.deepEqual(kindsOf(vs), ['agent_without_contract']);
    assert.equal(vs.length, 2);
  });

  test('14 valid entries plus 1 broken yields exactly one violation and it is the broken one', () => {
    const registry = [];
    const producers = new Map();
    const consumers = new Map([['gsd-core/workflows/w.md', '']]);
    for (let i = 0; i < 14; i++) {
      const m = `M${i} COMPLETE`;
      registry.push(row(`gsd-${i}`, [m], 'sentinel-match'));
      producers.set(`gsd-${i}`, [m]);
      consumers.set('gsd-core/workflows/w.md', consumers.get('gsd-core/workflows/w.md') + ` \`${m}\``);
    }
    registry.push(row('gsd-broken', ['BROKEN COMPLETE'], 'sentinel-match'));
    producers.set('gsd-broken', []);
    const vs = run({ registry, producers, consumers });
    assert.equal(vs.length, 1);
    assert.equal(vs[0].kind, 'declared_marker_not_emitted');
    assert.equal(vs[0].agent, 'gsd-broken');
  });

  test('two producers with case-variant tokens produce case_collision, never auto-resolved', () => {
    const vs = run({
      registry: [
        row('gsd-a', ['SYNTHESIS COMPLETE'], 'sentinel-match'),
        row('gsd-b', ['Synthesis Complete'], 'sentinel-match'),
      ],
      producers: new Map([
        ['gsd-a', ['SYNTHESIS COMPLETE']],
        ['gsd-b', ['Synthesis Complete']],
      ]),
      consumers: new Map([['gsd-core/workflows/w.md', '`## SYNTHESIS COMPLETE` `## Synthesis Complete`']]),
    });
    assert.equal(vs.length, 2);
    assert.ok(vs.every((v) => v.kind === 'case_collision'));
  });

  test('a case-insensitive-only match is case_only_match, not satisfied', () => {
    const vs = run({
      registry: [row('gsd-a', ['ALPHA COMPLETE'], 'sentinel-match')],
      producers: new Map([['gsd-a', ['ALPHA COMPLETE']]]),
      consumers: new Map([['gsd-core/workflows/w.md', 'then the alpha complete step runs']]),
    });
    assert.deepEqual(kindsOf(vs), ['case_only_match']);
  });

  test('a token appearing only in ordinary prose must not satisfy the contract', () => {
    const vs = run({
      registry: [row('gsd-a', ['VERIFICATION COMPLETE'], 'sentinel-match')],
      producers: new Map([['gsd-a', ['VERIFICATION COMPLETE']]]),
      consumers: new Map([['gsd-core/workflows/w.md', 'Once verification complete, proceed.']]),
    });
    assert.deepEqual(kindsOf(vs), ['case_only_match']);
  });

  test('an unconsumed marker is exempt from the consumer check but still emitted-checked', () => {
    const ok = run({
      registry: [row('gsd-c', [], 'sentinel-match', { unconsumed_markers: ['GAMMA DRAFT'] })],
      producers: new Map([['gsd-c', ['GAMMA DRAFT']]]),
      consumers: new Map(),
    });
    assert.deepEqual(ok, []);

    const missingEmission = run({
      registry: [row('gsd-c', [], 'sentinel-match', { unconsumed_markers: ['GAMMA DRAFT'] })],
      producers: new Map([['gsd-c', []]]),
    });
    assert.deepEqual(kindsOf(missingEmission), ['declared_marker_not_emitted']);
    assert.equal(missingEmission[0].marker, 'GAMMA DRAFT');
  });

  test('an unconsumed marker still participates in case-collision detection', () => {
    const vs = run({
      registry: [
        row('gsd-a', ['GAMMA DRAFT'], 'sentinel-match'),
        row('gsd-c', [], 'sentinel-match', { unconsumed_markers: ['Gamma Draft'] }),
      ],
      producers: new Map([
        ['gsd-a', ['GAMMA DRAFT']],
        ['gsd-c', ['Gamma Draft']],
      ]),
      consumers: new Map([['gsd-core/workflows/w.md', '`## GAMMA DRAFT`']]),
    });
    assert.ok(vs.some((v) => v.kind === 'case_collision' && v.marker === 'Gamma Draft'));
  });

  test('an emitted-but-undeclared candidate is emitted_marker_not_declared, deduped per marker', () => {
    const vs = run({
      registry: [row('gsd-a', [], 'artifact+query')],
      producers: new Map([['gsd-a', []]]),
      candidates: new Map([['gsd-a', ['MYSTERY COMPLETE', 'MYSTERY COMPLETE']]]),
    });
    assert.equal(vs.length, 1);
    assert.equal(vs[0].kind, 'emitted_marker_not_declared');
  });

  test('an unknown Kind value is unknown_kind', () => {
    const vs = run({
      registry: [row('gsd-a', [], 'sometimes')],
      producers: new Map([['gsd-a', []]]),
    });
    assert.deepEqual(kindsOf(vs), ['unknown_kind']);
  });

  test("a marker consumed somewhere but by none of the row's declared consumers is declared_consumer_no_match", () => {
    const vs = run({
      registry: [row('gsd-a', ['ALPHA COMPLETE'], 'sentinel-match', { consumed_by: '`gsd-core/workflows/w.md`' })],
      producers: new Map([['gsd-a', ['ALPHA COMPLETE']]]),
      consumers: new Map([
        ['gsd-core/workflows/w.md', 'no match here'],
        ['gsd-core/workflows/other.md', 'dispatch `## ALPHA COMPLETE`'],
      ]),
    });
    assert.equal(vs.length, 1);
    assert.equal(vs[0].kind, 'declared_consumer_no_match');
    assert.equal(vs[0].marker, 'ALPHA COMPLETE');
  });
});

describe('contract-drift: typed surface', () => {
  test('VIOLATION_KINDS is frozen and exactly the emitted vocabulary', () => {
    assert.deepEqual(Object.values(VIOLATION_KINDS).sort(), [
      'agent_without_contract',
      'case_collision',
      'case_only_match',
      'declared_consumer_no_match',
      'declared_marker_not_emitted',
      'duplicate_registry_row',
      'emitted_marker_not_declared',
      'legacy_read_tag',
      'no_consumer',
      'parse_error',
      'read_tag_gate_missing',
      'unclosed_fence',
      'unknown_consumer',
      'unknown_kind',
      'unknown_producer',
      'unmatched_consumer_token',
      'vestigial_marker',
    ]);
    assert.ok(Object.isFrozen(VIOLATION_KINDS));
  });

  test('REMEDIES cover exactly the VIOLATION_KINDS vocabulary', () => {
    assert.deepEqual(
      Object.keys(REMEDIES).sort(),
      Object.values(VIOLATION_KINDS).slice().sort(),
      'every violation kind needs a remedy, and no remedy may exist for a kind nothing emits',
    );
    for (const [kind, remedy] of Object.entries(REMEDIES)) {
      assert.ok(remedy.length > 10, `remedy for ${kind} must be actionable prose`);
    }
  });

  test('sanitizeEcho strips control characters and caps length', () => {
    assert.equal(sanitizeEcho('clean text'), 'clean text');
    assert.equal(sanitizeEcho('a\x00b\x07c\x1fd'), 'abcd');
    assert.equal(sanitizeEcho('x'.repeat(500)).length, 200);
  });
});

// ─── parseConsumedByCell ─────────────────────────────────────────────────────

describe('contract-drift: parseConsumedByCell', () => {
  test('backticked paths are extracted', () => {
    assert.deepEqual(
      parseConsumedByCell('`gsd-core/workflows/a.md`, `commands/gsd/b.md`'),
      ['gsd-core/workflows/a.md', 'commands/gsd/b.md'],
    );
  });

  test('globs, commands, and prose are ignored', () => {
    assert.deepEqual(
      parseConsumedByCell('`*-VERIFICATION.md` artifact + `gsd_run query verification.status` in `gsd-core/workflows/v.md`'),
      ['gsd-core/workflows/v.md'],
    );
  });

  test('paths with spaces are ignored, not mangled', () => {
    assert.deepEqual(parseConsumedByCell('`docs/Some File.md` and `docs/ok-file.md`'), ['docs/ok-file.md']);
  });

  test('traversal segments are dropped — a Consumed by cell can never walk outside --root', () => {
    assert.deepEqual(
      parseConsumedByCell('`docs/../../etc/secret.md` plus `docs/real.md`'),
      ['docs/real.md'],
    );
    assert.deepEqual(parseConsumedByCell('`../outside.md`'), []);
  });

  test('empty and non-string input yield an empty array', () => {
    assert.deepEqual(parseConsumedByCell(''), []);
    assert.deepEqual(parseConsumedByCell(null), []);
  });
});

// ─── readTagViolations ───────────────────────────────────────────────────────

describe('contract-drift: readTagViolations (the F8 arm)', () => {
  const REG = [{ agent: 'gsd-a', consumed_by: '`gsd-core/workflows/w.md`' }];

  test('a consumer emitting <required_reading> with no gate in the agent is read_tag_gate_missing', () => {
    const vs = readTagViolations({
      registry: REG,
      agentTexts: new Map([['gsd-a', '# Agent\n\nNo gate mention.']]),
      consumerTexts: new Map([['gsd-core/workflows/w.md', '<required_reading>\n- UI-SPEC.md\n</required_reading>']]),
    });
    assert.equal(vs.length, 1);
    assert.equal(vs[0].kind, 'read_tag_gate_missing');
    assert.equal(vs[0].agent, 'gsd-a');
  });

  test('an agent referencing the gate is satisfied', () => {
    const vs = readTagViolations({
      registry: REG,
      agentTexts: new Map([['gsd-a', 'If the prompt contains a `<required_reading>` block, you MUST Read every file listed.']]),
      consumerTexts: new Map([['gsd-core/workflows/w.md', '<required_reading>\n- X.md\n</required_reading>']]),
    });
    assert.deepEqual(vs, []);
  });

  test('a consumer emitting no read tag imposes no gate requirement', () => {
    const vs = readTagViolations({
      registry: REG,
      agentTexts: new Map([['gsd-a', 'nothing']]),
      consumerTexts: new Map([['gsd-core/workflows/w.md', 'plain dispatch']]),
    });
    assert.deepEqual(vs, []);
  });

  test('a legacy <files_to_read> anywhere in the corpus is legacy_read_tag', () => {
    const vs = readTagViolations({
      registry: [],
      agentTexts: new Map(),
      consumerTexts: new Map([['agents/gsd-a.md', '<files_to_read>\n- x\n</files_to_read>']]),
    });
    assert.deepEqual(
      vs.map((v) => v.kind),
      ['legacy_read_tag'],
    );
  });

  test('a nonexistent agent row is skipped here (unknown_producer owns it)', () => {
    const vs = readTagViolations({
      registry: REG,
      agentTexts: new Map(),
      consumerTexts: new Map([['gsd-core/workflows/w.md', '<required_reading>x</required_reading>']]),
    });
    assert.deepEqual(vs, []);
  });
});

// ─── unmatchedConsumerTokens (the reverse direction) ─────────────────────────

describe('contract-drift: unmatchedConsumerTokens (the F9 arm)', () => {
  test('a workflow matching a token no producer emits is unmatched_consumer_token', () => {
    const vs = unmatchedConsumerTokens({
      consumerTexts: new Map([['gsd-core/workflows/w.md', 'dispatch on `## PHANTOM COMPLETE`']]),
      vocabulary: new Set(['REAL COMPLETE']),
    });
    assert.equal(vs.length, 1);
    assert.equal(vs[0].kind, 'unmatched_consumer_token');
    assert.equal(vs[0].marker, 'PHANTOM COMPLETE');
  });

  test('a declared token is not a violation', () => {
    const vs = unmatchedConsumerTokens({
      consumerTexts: new Map([['gsd-core/workflows/w.md', 'dispatch on `## REAL COMPLETE`']]),
      vocabulary: new Set(['REAL COMPLETE']),
    });
    assert.deepEqual(vs, []);
  });

  test('agents/ files are not scanned (self-description, not a dispatch)', () => {
    const vs = unmatchedConsumerTokens({
      consumerTexts: new Map([['agents/gsd-a.md', 'returns `## PHANTOM COMPLETE`']]),
      vocabulary: new Set(),
    });
    assert.deepEqual(vs, []);
  });

  test('NON_AGENT_TOKENS are exempt and the set is exactly the justified entries', () => {
    const vs = unmatchedConsumerTokens({
      consumerTexts: new Map([['commands/gsd/x.md', 'display `## GRAPHIFY BUILD COMPLETE`']]),
      vocabulary: new Set(),
    });
    assert.deepEqual(vs, []);
    // membership is locked: an entry without a live justification is drift
    assert.deepEqual([...NON_AGENT_TOKENS].sort(), ['GRAPHIFY BUILD COMPLETE', 'GRAPHIFY BUILD FAILED']);
  });

  test('mixed-case and long tokens are not flagged', () => {
    const vs = unmatchedConsumerTokens({
      consumerTexts: new Map([
        ['gsd-core/workflows/w.md', 'match `## Self-Check: FAILED` and `## ' + 'X'.repeat(61) + ' COMPLETE`'],
      ]),
      vocabulary: new Set(),
    });
    assert.deepEqual(vs, []);
  });

  test('double-quoted match instructions are scanned too', () => {
    const vs = unmatchedConsumerTokens({
      consumerTexts: new Map([['gsd-core/workflows/w.md', 'gsd_stall_watch "## PHANTOM COMPLETE"']]),
      vocabulary: new Set(),
    });
    assert.equal(vs.length, 1);
    assert.equal(vs[0].marker, 'PHANTOM COMPLETE');
  });
});

// ─── Property: fence tracking is invariant under any block interleaving ─────

describe('contract-drift: extractMarkers fence property (fast-check)', () => {
  const lineArb = fc.constantFrom(
    'plain prose line',
    '- list item',
    '## HEADING ONE',
    '## HEADING TWO',
    '## Mixed Case Heading',
    '```',
    'text after a bare three-backtick run',
  );

  // A block generator with a sound oracle: fenced blocks are wrapped in
  // 4-backtick delimiters, so a 3-backtick line inside cannot close the
  // outer fence (the exact nesting rule under test). Unfenced blocks never
  // contain a backtick run, so fence state is unambiguous.
  const contentArb = fc
    .array(fc.record({ fenced: fc.boolean(), lines: fc.array(lineArb, { maxLength: 6 }) }), {
      minLength: 1,
      maxLength: 20,
    })
    .map((blocks) => {
      const parts = [];
      const expected = [];
      for (const b of blocks) {
        const KNOWN = new Set(['HEADING ONE', 'HEADING TWO']);
        if (b.fenced) {
          parts.push('````');
          for (const line of b.lines) {
            parts.push(line);
            if (line.startsWith('## ') && KNOWN.has(line.slice(3))) {
              expected.push({ line: line.slice(3), inFence: true });
            }
          }
          parts.push('````');
        } else {
          const safe = b.lines.filter((l) => !l.startsWith('```'));
          for (const line of safe) {
            parts.push(line);
            if (line.startsWith('## ') && KNOWN.has(line.slice(3))) {
              expected.push({ line: line.slice(3), inFence: false });
            }
          }
        }
      }
      return { content: parts.join('\n'), expected };
    });

  test('every extracted marker inFence matches its block declared fenced-ness', () => {
    fc.assert(
      fc.property(contentArb, ({ content, expected }) => {
        const known = ['HEADING ONE', 'HEADING TWO'];
        const { markers, unclosedFence } = extractMarkers(content, known);
        assert.equal(unclosedFence, false, '4-backtick blocks always close');
        const got = markers.map((m) => ({ line: m.marker, inFence: m.inFence }));
        assert.deepEqual(got, expected);
      }),
      { seed: 3565, numRuns: 200 },
    );
  });
});

// ─── End-to-end through the real CLI ─────────────────────────────────────────

describe('contract-drift: end-to-end via check-contract-drift.cjs --root', () => {
  function writeFixture(dir, { registryBody, agents, extraFiles }) {
    fs.mkdirSync(path.join(dir, 'gsd-core', 'references'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'gsd-core', 'workflows'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'commands', 'gsd'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'gsd-core', 'references', 'agent-contracts.md'),
      ['## Agent Registry', '', registryBody, ''].join('\n'),
    );
    for (const [name, body] of Object.entries(agents || {})) {
      fs.writeFileSync(path.join(dir, 'agents', name), body);
    }
    for (const [rel, body] of Object.entries(extraFiles || {})) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
  }

  const CLEAN_REGISTRY = [
    '| Agent | Role | Completion Markers | Consumed by | Kind |',
    '|-------|------|--------------------|--------------|------|',
    '| gsd-alpha | Fixture | `## ALPHA COMPLETE` | `gsd-core/workflows/w.md` | sentinel-match |',
  ].join('\n');
  const CLEAN_AGENTS = {
    'gsd-alpha.md': [
      '# Alpha',
      '',
      'Return:',
      '',
      '```markdown',
      '## ALPHA COMPLETE',
      'done',
      '```',
      '',
      'Gate: `<required_reading>` MUST be Read.',
      '',
    ].join('\n'),
  };
  const CLEAN_EXTRA = {
    'gsd-core/workflows/w.md': 'Dispatch on `## ALPHA COMPLETE`.\n\n<required_reading>\n- x.md\n</required_reading>\n',
  };

  // --json: tests consume the typed surface (CONTRIBUTING raw-text-matching
  // rule) — the human formatter is for operators only.
  function runCheckJson(dir) {
    const r = runNode([CHECK_SCRIPT, '--root', dir, '--json'], { timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(r.outcome, OUTCOME.EXITED, `spawn failed: ${r.stderr}`);
    return { ...r, report: JSON.parse(r.stdout) };
  }

  function runCheck(dir) {
    return runNode([CHECK_SCRIPT, '--root', dir], { timeoutMs: PROBE_TIMEOUT_MS });
  }

  test('clean fixture exits 0', (t) => {
    const dir = createTempDir('gsd-3565-clean-');
    t.after(() => cleanup(dir));
    writeFixture(dir, { registryBody: CLEAN_REGISTRY, agents: CLEAN_AGENTS, extraFiles: CLEAN_EXTRA });
    const r = runCheckJson(dir);
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr}`);
    assert.equal(r.report.status, 'ok');
    assert.deepEqual(r.report.violations, []);
  });

  test('planted unmatched sentinel fails and names the producer', (t) => {
    const dir = createTempDir('gsd-3565-orphan-');
    t.after(() => cleanup(dir));
    writeFixture(dir, { registryBody: CLEAN_REGISTRY, agents: CLEAN_AGENTS, extraFiles: { 'gsd-core/workflows/w.md': 'No markers matched here.\n' } });
    const r = runCheckJson(dir);
    assert.equal(r.exitCode, 1);
    assert.equal(r.report.status, 'violations');
    const v = r.report.violations.find((x) => x.kind === 'no_consumer');
    assert.ok(v, `expected no_consumer, got: ${JSON.stringify(r.report.violations)}`);
    assert.equal(v.agent, 'gsd-alpha');
    assert.equal(v.marker, 'ALPHA COMPLETE');
  });

  test('planted reverse violation (consumer matches a phantom token) fails', (t) => {
    const dir = createTempDir('gsd-3565-phantom-');
    t.after(() => cleanup(dir));
    writeFixture(dir, {
      registryBody: CLEAN_REGISTRY,
      agents: CLEAN_AGENTS,
      extraFiles: { 'gsd-core/workflows/w.md': 'Dispatch on `## ALPHA COMPLETE` or `## PHANTOM COMPLETE`.\n' },
    });
    const r = runCheckJson(dir);
    assert.equal(r.exitCode, 1);
    const v = r.report.violations.find((x) => x.kind === 'unmatched_consumer_token');
    assert.ok(v, `expected unmatched_consumer_token, got: ${JSON.stringify(r.report.violations)}`);
    assert.equal(v.marker, 'PHANTOM COMPLETE');
  });

  test('planted case collision fails', (t) => {
    const dir = createTempDir('gsd-3565-collision-');
    t.after(() => cleanup(dir));
    const registry = [
      '| Agent | Role | Completion Markers | Consumed by | Kind |',
      '|-------|------|--------------------|--------------|------|',
      '| gsd-alpha | Fixture | `## ALPHA COMPLETE` | `gsd-core/workflows/w.md` | sentinel-match |',
      '| gsd-beta | Fixture | `## Alpha Complete` | `gsd-core/workflows/w.md` | sentinel-match |',
    ].join('\n');
    const agents = {
      ...CLEAN_AGENTS,
      'gsd-beta.md': '```\n## Alpha Complete\n```\n',
    };
    writeFixture(dir, {
      registryBody: registry,
      agents,
      extraFiles: { 'gsd-core/workflows/w.md': '`## ALPHA COMPLETE` `## Alpha Complete`\n' },
    });
    const r = runCheckJson(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.report.violations.some((x) => x.kind === 'case_collision'));
  });

  test('roster agent missing from the registry fails and names the agent', (t) => {
    const dir = createTempDir('gsd-3565-norow-');
    t.after(() => cleanup(dir));
    writeFixture(dir, {
      registryBody: CLEAN_REGISTRY,
      agents: { ...CLEAN_AGENTS, 'gsd-unregistered.md': '# Unregistered\n' },
      extraFiles: CLEAN_EXTRA,
    });
    const r = runCheckJson(dir);
    assert.equal(r.exitCode, 1);
    const v = r.report.violations.find((x) => x.kind === 'agent_without_contract');
    assert.ok(v, `expected agent_without_contract, got: ${JSON.stringify(r.report.violations)}`);
    assert.equal(v.agent, 'gsd-unregistered');
  });

  test('a planted legacy <files_to_read> in a workflow fails as legacy_read_tag', (t) => {
    const dir = createTempDir('gsd-3565-legacytag-');
    t.after(() => cleanup(dir));
    writeFixture(dir, {
      registryBody: CLEAN_REGISTRY,
      agents: CLEAN_AGENTS,
      extraFiles: { 'gsd-core/workflows/w.md': '<files_to_read>\n- x.md\n</files_to_read>\n' },
    });
    const r = runCheckJson(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.report.violations.some((x) => x.kind === 'legacy_read_tag'));
  });

  test('a consumer emitting <required_reading> to a gate-less agent fails', (t) => {
    const dir = createTempDir('gsd-3565-gate-');
    t.after(() => cleanup(dir));
    writeFixture(dir, {
      registryBody: CLEAN_REGISTRY,
      agents: { 'gsd-alpha.md': '# Alpha\n\nNo gate anywhere.\n\n```\n## ALPHA COMPLETE\n```\n' },
      extraFiles: CLEAN_EXTRA,
    });
    const r = runCheckJson(dir);
    assert.equal(r.exitCode, 1);
    const v = r.report.violations.find((x) => x.kind === 'read_tag_gate_missing');
    assert.ok(v, `expected read_tag_gate_missing, got: ${JSON.stringify(r.report.violations)}`);
    assert.equal(v.agent, 'gsd-alpha');
  });

  test('a missing contracts file exits 1 with a named path', (t) => {
    const dir = createTempDir('gsd-3565-nocontracts-');
    t.after(() => cleanup(dir));
    fs.mkdirSync(path.join(dir, 'agents'), { recursive: true });
    const r = runCheck(dir);
    assert.equal(r.exitCode, 1);
    assert.ok((r.stdout + r.stderr).includes('agent-contracts.md'));
  });

  test('a malformed registry row fails as parse_error', (t) => {
    const dir = createTempDir('gsd-3565-parseror-');
    t.after(() => cleanup(dir));
    writeFixture(dir, {
      registryBody: [
        '| Agent | Role | Completion Markers | Consumed by | Kind |',
        '|-------|------|--------------------|--------------|------|',
        '| gsd-alpha | Fixture | `## ALPHA COMPLETE` | `gsd-core/workflows/w.md` | sentinel-match |',
        '| broken row with too few cells |',
      ].join('\n'),
      agents: CLEAN_AGENTS,
      extraFiles: CLEAN_EXTRA,
    });
    const r = runCheckJson(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.report.violations.some((x) => x.kind === 'parse_error'));
  });

  test('an agent file with an unclosed fence fails as unclosed_fence', (t) => {
    const dir = createTempDir('gsd-3565-fence-');
    t.after(() => cleanup(dir));
    writeFixture(dir, {
      registryBody: CLEAN_REGISTRY,
      agents: {
        'gsd-alpha.md': '# Alpha\n\n```\n## ALPHA COMPLETE\nnever closed\n',
      },
      extraFiles: CLEAN_EXTRA,
    });
    const r = runCheckJson(dir);
    assert.equal(r.exitCode, 1);
    assert.ok(r.report.violations.some((x) => x.kind === 'unclosed_fence'));
  });
});

// ─── The real tree is clean (behavioral, via the CLI) ────────────────────────

describe('contract-drift: the real tree passes', () => {
  test('check-contract-drift on the repository root exits 0', () => {
    const r = runNode([CHECK_SCRIPT], { cwd: ROOT, timeoutMs: PROBE_TIMEOUT_MS });
    assert.equal(r.outcome, OUTCOME.EXITED);
    assert.equal(r.exitCode, 0, `stderr: ${r.stderr.slice(0, 400)}`);
    assert.match(r.stdout, /^ok check-contract-drift: /);
  });
});
