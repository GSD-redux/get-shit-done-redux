// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('explore command', () => {
  test('command file exists', () => {
    const p = path.join(__dirname, '..', 'commands', 'gsd', 'explore.md');
    assert.ok(fs.existsSync(p), 'commands/gsd/explore.md should exist');
  });

  test('command file has required frontmatter', () => {
    const p = path.join(__dirname, '..', 'commands', 'gsd', 'explore.md');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(content.includes('name: gsd:explore'), 'Command must have name frontmatter');
    assert.ok(content.includes('description:'), 'Command must have description frontmatter');
    assert.ok(content.includes('allowed-tools:'), 'Command must have allowed-tools frontmatter');
  });

  test('workflow file exists', () => {
    const p = path.join(__dirname, '..', 'gsd-core', 'workflows', 'explore.md');
    assert.ok(fs.existsSync(p), 'workflows/explore.md should exist');
  });

  test('workflow references questioning.md and domain-probes.md', () => {
    const p = path.join(__dirname, '..', 'gsd-core', 'workflows', 'explore.md');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(content.includes('questioning.md'), 'Workflow must reference questioning.md');
    assert.ok(content.includes('domain-probes.md'), 'Workflow must reference domain-probes.md');
  });

  test('workflow documents all 6 output types', () => {
    const p = path.join(__dirname, '..', 'gsd-core', 'workflows', 'explore.md');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(content.includes('Note'), 'Workflow must document Note output type');
    assert.ok(content.includes('Todo'), 'Workflow must document Todo output type');
    assert.ok(content.includes('Seed'), 'Workflow must document Seed output type');
    assert.ok(content.includes('Research question'), 'Workflow must document Research question output type');
    assert.ok(content.includes('Requirement'), 'Workflow must document Requirement output type');
    assert.ok(content.includes('New phase') || content.includes('phase'), 'Workflow must document New phase output type');
  });

  test('workflow enforces one question at a time principle', () => {
    const p = path.join(__dirname, '..', 'gsd-core', 'workflows', 'explore.md');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(content.includes('one question at a time'), 'Workflow must mention "one question at a time" principle');
  });

  test('workflow requires user confirmation before writing artifacts', () => {
    const p = path.join(__dirname, '..', 'gsd-core', 'workflows', 'explore.md');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(
      content.includes('explicit user selection') || content.includes('Never write artifacts without'),
      'Workflow must require user confirmation before writing artifacts'
    );
  });

  test('workflow respects commit_docs config', () => {
    const p = path.join(__dirname, '..', 'gsd-core', 'workflows', 'explore.md');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(content.includes('commit_docs'), 'Workflow must respect commit_docs configuration');
  });

  test('command references the workflow via execution_context', () => {
    const p = path.join(__dirname, '..', 'commands', 'gsd', 'explore.md');
    const content = fs.readFileSync(p, 'utf-8');
    assert.ok(
      content.includes('workflows/explore.md'),
      'Command must reference workflows/explore.md in execution_context'
    );
  });
});

// Enhancement #2229 — three-way claim disposition (admit / refute / abstain) in the
// /gsd-explore Step 3 research pass. The research pass is pure prompt orchestration (it
// spawns gsd-phase-researcher and folds prose back), so the disposition contract lives in
// the workflow text itself — asserting the text asserts the deployed contract (the
// source-text-is-the-product exemption at the top of this file). This mirrors the #1154
// honest-verifier abstention PATTERN (never a silent pass; abstain-and-flag), not the
// verify-time probe-core code path (which sits on the verifier↔predicate rail, ADR-857).
describe('explore research-pass claim disposition (#2229)', () => {
  const workflowPath = path.join(__dirname, '..', 'gsd-core', 'workflows', 'explore.md');
  const readWorkflow = () => fs.readFileSync(workflowPath, 'utf-8');

  test('research pass documents the three-way admit/refute/abstain disposition', () => {
    const content = readWorkflow().toLowerCase();
    assert.ok(content.includes('admit'), 'research pass must document the "admit" disposition');
    assert.ok(content.includes('refute'), 'research pass must document the "refute" disposition');
    assert.ok(content.includes('abstain'), 'research pass must document the "abstain" disposition');
  });

  test('abstained claims route to an unresolved ledger, never smoothed into prose', () => {
    const content = readWorkflow();
    assert.ok(
      /unresolved/i.test(content) && /ledger/i.test(content),
      'research pass must route abstained claims to an "unresolved" ledger'
    );
    assert.ok(
      /never.*(smooth|prose|assert)|not.*smoothed/i.test(content),
      'ledger discipline must state abstained claims are never smoothed into the narrative'
    );
  });

  test('admit arm requires a prompted-to-refute pass AND grounding in a source', () => {
    const content = readWorkflow().toLowerCase();
    assert.ok(
      content.includes('refute') && (content.includes('ground') || content.includes('source')),
      'admit must survive a refute pass and be grounded in a source'
    );
  });

  test('conflict-abstention guard: a source-vs-prior conflict routes to the ledger', () => {
    const content = readWorkflow().toLowerCase();
    // Require the disposition-specific phrasing, not an incidental "conflicting edits" mention
    // elsewhere in the workflow — this must be load-bearing for the abstain arm.
    assert.ok(
      content.includes('source-vs-prior') || content.includes('conflict-abstention') ||
        /conflict[^.]*\bledger\b|\bledger\b[^.]*conflict/.test(content),
      'the abstain arm must cover a source-vs-prior conflict (conflict-abstention), routing to the ledger — not a silent pick-a-side'
    );
  });

  test('tier-floor guard: the grounded pass is constrained off the lowest model tier', () => {
    const content = readWorkflow().toLowerCase();
    assert.ok(
      content.includes('tier') && (content.includes('lowest') || content.includes('budget') || content.includes('haiku')),
      'a tier floor must keep the grounded disposition off the lowest model tier'
    );
  });

  test('cites the #1154 honest-verifier abstention precedent (pattern reuse)', () => {
    const content = readWorkflow();
    assert.ok(
      content.includes('#1154'),
      'the disposition must cite its #1154 honest-verifier precedent so the reuse is traceable'
    );
  });
});
