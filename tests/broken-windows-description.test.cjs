const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('broken-windows capability description specifies enforcement is opt-in', () => {
  const capabilityPath = path.join(__dirname, '..', 'capabilities', 'broken-windows', 'capability.json');
  const capabilityJson = JSON.parse(fs.readFileSync(capabilityPath, 'utf8'));

  assert.ok(
    capabilityJson.description.includes('When enforcement is enabled') || capabilityJson.description.includes('workflow.windows_enforce'),
    `capability.json description should state enforcement is opt-in, got: ${capabilityJson.description}`
  );

  // Re-anchored: the unqualified sentence on next ("Blocks /gsd-ship while any window is open") must not be present
  assert.strictEqual(
    capabilityJson.description.includes('Blocks /gsd-ship while any window is open'),
    false,
    'description must not contain unqualified unconditional ship blocking sentence'
  );

  // Behavioral gate contract test: verify the ship:pre gate is gated on workflow.windows_enforce
  const shipGate = capabilityJson.gates.find(g => g.point === 'ship:pre');
  assert.ok(shipGate, 'broken-windows capability must declare ship:pre gate');
  assert.strictEqual(
    shipGate.when,
    'workflow.windows_enforce',
    'ship:pre gate must be gated on workflow.windows_enforce config key'
  );

  // Behavioral test for renderLedger
  const bw = require('../gsd-core/bin/lib/broken-windows.cjs');
  const rendered = bw.renderLedger(bw.emptyLedger());
  assert.strictEqual(
    rendered.includes('> Cross-phase defect register. `/gsd-ship` blocks while `open_count > 0`.'),
    false,
    'renderLedger must not contain unqualified blocking sentence'
  );
  assert.ok(
    rendered.includes('With `workflow.windows_enforce` enabled, `/gsd-ship` blocks'),
    'renderLedger must document opt-in enforcement'
  );
});
