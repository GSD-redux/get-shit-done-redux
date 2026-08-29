// Prompt markdown, templates, references, and ADRs are deployed runtime
// products. Executable CLI/parser/manifest behavior is covered separately in
// init-debug.test.cjs, init-debug-workflow-contract.test.cjs,
// command-arg-projection.test.cjs, and section-manifest-init-facts.test.cjs.
'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FILES = Object.freeze({
  command: path.join(ROOT, 'commands/gsd/debug.md'),
  workflow: path.join(ROOT, 'gsd-core/workflows/debug.md'),
  runtimeStep: path.join(ROOT, 'gsd-core/workflows/debug/steps/runtime-evidence-protocol.md'),
  manager: path.join(ROOT, 'agents/gsd-debug-session-manager.md'),
  debugger: path.join(ROOT, 'agents/gsd-debugger.md'),
  reference: path.join(ROOT, 'gsd-core/references/debugger-runtime-evidence.md'),
  template: path.join(ROOT, 'gsd-core/templates/DEBUG.md'),
  debugPrompt: path.join(ROOT, 'gsd-core/templates/debug-subagent-prompt.md'),
  diagnoseIssues: path.join(ROOT, 'gsd-core/workflows/diagnose-issues.md'),
  fullHelp: path.join(ROOT, 'gsd-core/workflows/help/modes/full.md'),
  adr1671: path.join(ROOT, 'docs/adr/1671-dynamic-context-management-platform.md'),
  adr3128: path.join(ROOT, 'docs/adr/3128-adaptive-runtime-evidence.md'),
  packageJson: path.join(ROOT, 'package.json'),
});

function read(file) {
  assert.ok(
    fs.existsSync(file),
    `required #3128 runtime contract is missing: ${path.relative(ROOT, file)}`,
  );
  return fs.readFileSync(file, 'utf8');
}

function flat(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function sliceBetween(value, start, end, label) {
  const startIndex = value.indexOf(start);
  assert.notEqual(startIndex, -1, `${label}: missing start marker ${JSON.stringify(start)}`);
  const endIndex = value.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `${label}: missing end marker ${JSON.stringify(end)}`);
  return value.slice(startIndex, endIndex + end.length);
}

function assertIncludesAll(value, expected, label) {
  for (const item of expected) {
    assert.ok(value.includes(item), `${label}: missing ${JSON.stringify(item)}`);
  }
}

function assertExactLines(value, expected, label) {
  const lines = value.split(/\r?\n/).map(line => line.replace(/\s+#.*$/, ''));
  for (const line of expected) {
    assert.equal(
      lines.filter(candidate => candidate === line).length,
      1,
      `${label}: expected exactly one line ${JSON.stringify(line)}`,
    );
  }
}

function assertMatchesAll(value, expected, label) {
  for (const pattern of expected) {
    assert.match(value, pattern, `${label}: missing contract matching ${pattern}`);
  }
}

function count(value, needle) {
  return value.split(needle).length - 1;
}

function assertBoundedRelationship(value, left, right, label, distance = 900) {
  const normalized = flat(value);
  const forward = new RegExp(`(?:${left.source}).{0,${distance}}(?:${right.source})`, 'i');
  const reverse = new RegExp(`(?:${right.source}).{0,${distance}}(?:${left.source})`, 'i');
  assert.ok(
    forward.test(normalized) || reverse.test(normalized),
    `${label}: ${left} must be explicitly tied to ${right}`,
  );
}

function contextAround(value, anchor, radius, label) {
  const index = value.indexOf(anchor);
  assert.notEqual(index, -1, `${label}: missing anchor ${JSON.stringify(anchor)}`);
  return value.slice(Math.max(0, index - radius), Math.min(value.length, index + anchor.length + radius));
}

describe('adaptive runtime evidence command and applicability contract (#3128)', () => {
  test('the public surface exposes opt-in adaptive and explicit off, never a force policy', () => {
    const command = flat(read(FILES.command));

    assertIncludesAll(command, ['--runtime-probes', '--no-runtime-probes'], 'debug command flags');
    assertMatchesAll(command, [
      /--runtime-probes.{0,240}\badaptive\b|\badaptive\b.{0,240}--runtime-probes/i,
      /--no-runtime-probes.{0,240}\boff\b|\boff\b.{0,240}--no-runtime-probes/i,
      /(?:no (?:probe )?flag|without (?:a )?(?:probe )?flag|default).{0,240}\boff\b|\boff\b.{0,240}(?:default|no (?:probe )?flag)/i,
    ], 'public policy mapping');
    assert.doesNotMatch(
      command,
      /(?:policy|selects?|maps? to)[^\n]{0,120}\bforce\b|\bforce\b[^\n]{0,120}(?:policy|selects?|maps? to)/i,
      'force is not a reachable #3128 policy',
    );
  });

  test('full help documents both public flags and the off-by-default policy', () => {
    const fullHelp = flat(read(FILES.fullHelp));

    assertIncludesAll(fullHelp, ['--runtime-probes', '--no-runtime-probes'], 'full-mode debug help');
    assertMatchesAll(fullHelp, [
      /--runtime-probes.{0,220}\badaptive\b|\badaptive\b.{0,220}--runtime-probes/i,
      /--no-runtime-probes.{0,220}\boff\b|\boff\b.{0,220}--no-runtime-probes/i,
      /(?:default|no (?:probe )?flag|without (?:a )?(?:probe )?flag).{0,220}\boff\b|\boff\b.{0,220}(?:default|no (?:probe )?flag)/i,
    ], 'full-mode runtime evidence policy');
  });

  test('recognized flags are exact global tokens removed before interpreting user input', () => {
    const command = flat(read(FILES.command));

    assertMatchesAll(command, [
      /(?:exact|whole)[- ]token.{0,220}(?:--runtime-probes|probe flags?)/i,
      /(?:global|any position|order[- ]independent).{0,260}(?:probe flags?|--runtime-probes)|(?:probe flags?|--runtime-probes).{0,260}(?:global|any position|order[- ]independent)/i,
      /(?:strip|remove).{0,220}(?:recognized|probe) flags?.{0,260}(?:before|prior to).{0,240}(?:subcommand|slug|description|interpret)/i,
    ], 'global flag parser');
  });

  test('conflicts and subcommand combinations fail closed', () => {
    const command = flat(read(FILES.command));

    assertMatchesAll(command, [
      /(?:both|conflicting).{0,200}(?:probe|runtime) flags?.{0,180}(?:reject|error|fail closed|stop)/i,
      /(?:list|status).{0,220}(?:reject|accept no).{0,180}(?:recognized|probe|runtime) flags?|(?:probe|runtime) flags?.{0,220}(?:reject|invalid).{0,160}(?:list|status)/i,
      /continue.{0,180}--diagnose.{0,180}(?:reject|invalid|error|stop)|--diagnose.{0,180}continue.{0,180}(?:reject|invalid|error|stop)/i,
      /--diagnose.{0,220}--runtime-probes.{0,180}(?:reject|invalid|error|stop)|--runtime-probes.{0,220}--diagnose.{0,180}(?:reject|invalid|error|stop)/i,
      /--diagnose.{0,260}--no-runtime-probes.{0,160}(?:allow|valid|redundant|off)|--no-runtime-probes.{0,260}--diagnose.{0,160}(?:allow|valid|redundant|off)/i,
    ], 'invalid debug argument combinations');
  });

  test('ADR-1671 flips its existing atom reservation to the shipped 30-entry vocabulary', () => {
    const adr = flat(read(FILES.adr1671));

    assertBoundedRelationship(
      adr,
      /state:runtime-evidence-eligible/,
      /(?:shipped|implemented|active).{0,120}(?:30|thirty)|(?:30|thirty).{0,120}(?:shipped|implemented|active)/,
      'ADR-1671 shipped reservation',
      700,
    );
    assert.doesNotMatch(
      adr,
      /Reserved \(1\).{0,500}state:runtime-evidence-eligible/i,
      'the existing reservation must be flipped, not duplicated or left reserved',
    );
  });

  test('runtime protocol text is one sizeable conditional workflow fragment', () => {
    const workflow = read(FILES.workflow);
    const opening = '<!-- gsd:section id="runtime-evidence-protocol" when="state:runtime-evidence-eligible" -->';
    const closing = '<!-- /gsd:section -->';

    assert.equal(count(workflow, opening), 1, 'runtime evidence must have one conditional opening marker');
    const fragment = sliceBetween(workflow, opening, closing, 'runtime evidence workflow fragment');
    assert.ok(
      Buffer.byteLength(fragment, 'utf8') >= 400,
      'the consuming fragment must satisfy ADR-1671 admission gate (1)',
    );
    assert.match(
      fragment,
      /gsd-core\/workflows\/debug\/steps\/runtime-evidence-protocol\.md/,
      'the conditional fragment must route the runtime evidence protocol',
    );
    assert.equal(
      count(fragment, 'state:runtime-evidence-eligible'),
      1,
      'policy applicability belongs on the single opening marker, not interleaved checks',
    );
  });

  test('the gated step reaches the deep protocol on demand and agents never eager-include it', () => {
    const step = flat(read(FILES.runtimeStep));
    const debuggerAgent = read(FILES.debugger);
    const manager = read(FILES.manager);
    const referencePath = 'gsd-core/references/debugger-runtime-evidence.md';
    const eagerInclude = /@(?:~\/\.claude\/)?gsd-core\/references\/debugger-runtime-evidence\.md/;

    assert.ok(step.includes(referencePath), 'the gated workflow step must make the deep reference reachable');
    assert.match(
      step,
      /(?:read|load).{0,220}debugger-runtime-evidence\.md.{0,360}(?:activate|reconcil|non-clean|ledger)|(?:activate|reconcil|non-clean|ledger).{0,360}(?:read|load).{0,220}debugger-runtime-evidence\.md/i,
      'the deep reference is read only when probes activate or ownership needs reconciliation',
    );
    assert.doesNotMatch(debuggerAgent, eagerInclude, 'gsd-debugger must not eagerly @-include the deep reference');
    assert.doesNotMatch(manager, eagerInclude, 'session manager must not eagerly @-include the deep reference');
  });
});

describe('policy persistence and immutable session goal (#3128)', () => {
  test('new and direct sessions eagerly persist a terminal-safe not_used block', () => {
    const debuggerAgent = read(FILES.debugger);
    const manager = read(FILES.manager);
    const template = read(FILES.template);
    const workflow = read(FILES.workflow);
    const reference = flat(read(FILES.reference));
    const adr = flat(read(FILES.adr3128));
    const initialFields = [
      'schema_version: 1',
      'policy: off',
      'state: not_used',
      'mode: null',
      'reproduction_ref: null',
      'next_run_seq: 1',
      'active_run: null',
      'artifact_root: null',
      'probes: []',
      'artifacts: []',
      'cleanup:',
      '  markers_remaining: 0',
      '  artifacts_remaining: 0',
      '  verified_at: null',
      '  failure: null',
    ];
    const debuggerBlock = sliceBetween(
      debuggerAgent,
      '## Runtime Evidence',
      '## Resolution',
      'debugger initial Runtime Evidence block',
    );
    const templateBlock = sliceBetween(
      template,
      '## Runtime Evidence',
      '## Resolution',
      'DEBUG template initial Runtime Evidence block',
    );

    assertExactLines(debuggerBlock, initialFields, 'direct debugger initial block');
    assertExactLines(templateBlock, initialFields, 'workflow DEBUG template initial block');

    const directCreation = sliceBetween(
      debuggerAgent,
      '<step name="create_debug_file">',
      '</step>',
      'direct debugger creation step',
    );
    assertMatchesAll(directCreation, [
      /write the complete schema-v1 block.{0,260}immediately/i,
      /shown `policy: off`.{0,260}replace only that value with `adaptive`/i,
      /Never persist a union or placeholder/i,
    ], 'direct debugger eager creation');

    assertIncludesAll(manager, [
      'present pristine `not_used` block',
      'without loading the deep reference',
      'mere section presence or policy alone never triggers that read',
    ], 'manager lazy-load gate for eager not_used sessions');
    assertIncludesAll(debuggerAgent, [
      'complete pristine `not_used` shape are checked inline',
      'load it only when activation, history, non-clean ownership, or malformed state',
    ], 'direct debugger lazy-load gate for eager not_used sessions');

    const workflowCreation = sliceBetween(
      workflow,
      '## 3. Initial Session Setup',
      '## 4. Session Management',
      'managed debug creation step',
    );
    assertMatchesAll(workflowCreation, [
      /Runtime Evidence schema version 1.{0,420}state: not_used/i,
      /Persist the runtime policy even when it is the default `off`/i,
    ], 'managed eager creation');
    assert.match(
      reference,
      /Every newly created session.{0,260}complete section.{0,260}not_used/i,
      'the deep protocol must make optional absence legacy-only',
    );
    assert.match(
      adr,
      /Every newly created session.{0,260}complete terminal-safe `not_used` block/i,
      'ADR-3128 must govern eager creation rather than contradict runtime surfaces',
    );
  });

  test('the session schema persists an immutable goal with a legacy find-and-fix default', () => {
    const template = flat(read(FILES.template));

    assertIncludesAll(template, ['goal:', 'find_and_fix', 'find_root_cause_only'], 'session goal schema');
    assertMatchesAll(template, [
      /goal.{0,180}(?:immutable|never changes|set once)/i,
      /(?:absent|missing|legacy).{0,180}goal.{0,220}find_and_fix|goal.{0,180}(?:absent|missing|legacy).{0,220}find_and_fix/i,
    ], 'session goal compatibility');
  });

  test('continue, auto-resume, checkpoints, and direct invocation preserve the saved goal', () => {
    const workflow = flat(read(FILES.workflow));
    const manager = flat(read(FILES.manager));
    const debuggerAgent = flat(read(FILES.debugger));
    const debugPrompt = read(FILES.debugPrompt);

    assertMatchesAll(workflow, [
      /continue.{0,420}(?:read|restore|preserve).{0,200}(?:saved|immutable).{0,100}goal/i,
      /auto[- ]resume.{0,360}(?:same|saved|immutable).{0,160}goal|goal.{0,260}(?:same|saved|immutable).{0,220}auto[- ]resume/i,
    ], 'workflow goal forwarding');
    assertMatchesAll(manager, [
      /(?:every|all).{0,200}(?:continuation|spawn|checkpoint).{0,260}(?:saved|immutable|same).{0,120}goal/i,
      /(?:must not|never).{0,220}(?:change|upgrade|replace).{0,180}goal/i,
    ], 'manager goal forwarding');
    assert.match(
      debuggerAgent,
      /(?:read|trust|restore).{0,260}(?:goal).{0,220}(?:debug file|session file|persisted|saved)/i,
      'direct debugger resume must recover the durable goal',
    );
    assert.match(debugPrompt, /goal:\s*\{goal\}/, 'continuation template forwards the same goal');
  });

  test('root-cause-only is permanently tracked-source-read-only and never offers a fix', () => {
    const manager = flat(read(FILES.manager));
    const debuggerAgent = flat(read(FILES.debugger));
    const diagnoseIssues = flat(read(FILES.diagnoseIssues));

    assertMatchesAll(debuggerAgent, [
      /find_root_cause_only.{0,420}(?:never|must not|forbid).{0,260}(?:source probe|tracked source|edit)/i,
      /find_root_cause_only.{0,420}(?:never|must not|forbid).{0,260}(?:offer|apply|implement).{0,120}fix/i,
    ], 'diagnose-only debugger gate');
    assert.match(
      manager,
      /find_root_cause_only.{0,420}(?:never|must not|do not).{0,220}(?:Fix now|fix option|apply a fix)/i,
      'session manager cannot upgrade a diagnosis-only session',
    );
    assertMatchesAll(diagnoseIssues, [
      /goal:\s*find_root_cause_only/i,
      /runtime_checkpoints_supported:\s*false/i,
      /(?:read[- ]only|never|must not).{0,320}(?:tracked source|source probe|apply a fix)/i,
    ], 'direct diagnose-issues restrictions');
  });
});

describe('Runtime Evidence schema v1 and write-ahead runs (#3128)', () => {
  test('the eager section declares the complete initial schema and the reference owns exact enums', () => {
    const template = read(FILES.template);
    const reference = read(FILES.reference);
    const runtimeSection = sliceBetween(
      template,
      '## Runtime Evidence',
      '## Resolution',
      'DEBUG.md Runtime Evidence section',
    );

    assertIncludesAll(runtimeSection, [
      'schema_version: 1',
      'policy:',
      'state:',
      'mode:',
      'reproduction_ref:',
      'next_run_seq:',
      'active_run:',
      'artifact_root:',
      'probes:',
      'artifacts:',
      'cleanup:',
      'markers_remaining:',
      'artifacts_remaining:',
      'verified_at:',
      'failure:',
    ], 'Runtime Evidence schema v1');
    assert.match(runtimeSection, /^policy: off$/m);
    assert.match(runtimeSection, /^state: not_used$/m);
    assert.match(runtimeSection, /^mode: null$/m);
    assert.doesNotMatch(runtimeSection, /policy:[^\n]*\bforce\b/);
    assert.match(reference, /policy:[^\n]*(?:adaptive\s*\|\s*off|off\s*\|\s*adaptive)/);
    assert.match(reference, /state:[^\n]*not_used[^\n]*planned[^\n]*active[^\n]*cleanup_pending[^\n]*clean[^\n]*cleanup_failed/);
    assert.match(reference, /mode:[^\n]*(?:null[^\n]*passive[^\n]*source_probes|passive[^\n]*source_probes[^\n]*null)/);
  });

  test('passive and source-probe entries have distinct ownership shapes', () => {
    const reference = flat(read(FILES.reference));
    const probeFields = [
      'id:',
      'kind:',
      'hypothesis_ids:',
      'file:',
      'location:',
      'observes:',
      'max_events:',
      'max_event_bytes:',
      'marker_start:',
      'marker_end:',
      'expected_block_sha256:',
      'status:',
    ];
    const passiveSchema = contextAround(reference, 'kind: passive', 1400, 'passive probe schema');
    const sourceSchema = contextAround(reference, 'kind: source_probe', 1400, 'source-probe schema');

    assertIncludesAll(passiveSchema, probeFields, 'passive probe literal fields');
    assertIncludesAll(sourceSchema, probeFields, 'source-probe literal fields');
    assertMatchesAll(passiveSchema, [
      /kind:\s*passive.{0,900}file:\s*null/i,
      /kind:\s*passive.{0,900}marker_start:\s*null/i,
      /kind:\s*passive.{0,900}marker_end:\s*null/i,
      /kind:\s*passive.{0,900}expected_block_sha256:\s*null/i,
    ], 'passive probe nullable ownership');
    assertMatchesAll(sourceSchema, [
      /kind:\s*source_probe.{0,620}(?:repository-relative|file).{0,420}(?:marker_start|marker_end).{0,420}expected_block_sha256/i,
      /(?:each|every) probe.{0,260}(?:non-empty|at least one).{0,160}hypothesis_ids|hypothesis_ids.{0,260}(?:non-empty|at least one)/i,
    ], 'passive/source probe ownership');
  });

  test('capture artifacts have a complete session-owned lifecycle ledger', () => {
    const reference = flat(read(FILES.reference));
    const artifactSchema = contextAround(reference, 'kind: capture', 1000, 'capture artifact schema');

    assertIncludesAll(artifactSchema, [
      'id:',
      'kind:',
      'path:',
      'identity:',
      'probe_ids:',
      'owned:',
      'status:',
    ], 'capture artifact literal fields');
    assertMatchesAll(artifactSchema, [
      /kind:\s*capture.{0,720}(?:id|path|probe_ids|owned|status)/i,
      /(?:artifact )?status.{0,220}planned.{0,180}created.{0,180}removed/i,
      /(?:only|every).{0,220}(?:owned|ledgered).{0,160}(?:capture|artifact)/i,
      /identity.{0,360}(?:scheme|volume_id|file_id)/i,
    ], 'capture artifact lifecycle');
  });

  test('run IDs are allocated and advanced durably before execution', () => {
    const reference = flat(read(FILES.reference));
    const activeRunSchema = contextAround(reference, 'active_run:', 1000, 'active_run schema');

    assertIncludesAll(activeRunSchema, [
      'run_id:',
      'phase:',
      'reproduction_ref:',
      'sink_artifact_id:',
      'started_at:',
    ], 'active_run literal fields');

    assertMatchesAll(reference, [
      /read `?next_run_seq`?.{0,220}persist `?active_run`?.{0,260}run-N.{0,220}(?:advance|increment).{0,180}N\s*\+\s*1.{0,260}(?:before|prior to).{0,160}(?:execute|run)/i,
      /active_run.{0,360}(?:run_id|phase|reproduction_ref|sink_artifact_id|started_at)/i,
      /(?:append|persist).{0,220}(?:completed )?(?:digest|run).{0,260}(?:Evidence|evidence).{0,260}(?:before|prior to).{0,160}(?:clear|null).{0,120}active_run/i,
      /(?:never|must not).{0,160}(?:reuse|recycle).{0,100}(?:run ID|run_id)/i,
    ], 'write-ahead run allocation');
  });

  test('interrupted runs become inconclusive before another ID is allocated', () => {
    const reference = flat(read(FILES.reference));

    assert.match(
      reference,
      /(?:interrupted|orphaned) active_run.{0,420}(?:append|finalize|record).{0,220}inconclusive.{0,260}(?:clear|reconcile).{0,220}(?:before|prior to).{0,220}(?:allocate|another|next) run/i,
      'interrupted run reconciliation is write-ahead and monotonic',
    );
  });

  test('completed digests use exact phases, verdicts, and stable citations', () => {
    const reference = read(FILES.reference);
    const digestSchema = contextAround(flat(reference), 'event_refs:', 1400, 'completed run digest');

    assertIncludesAll(digestSchema, [
      'run_id:',
      'phase:',
      'reproduction_ref:',
      'event_refs:',
      'verdicts:',
    ], 'completed digest literal fields');
    assertIncludesAll(reference, [
      'baseline',
      'post_fix',
      'uninstrumented_verify',
      'confirmed',
      'rejected',
      'inconclusive',
      'event_refs',
    ], 'completed runtime digests');
    assert.match(
      digestSchema,
      /(?:per-hypothesis|each hypothesis|hypothesis[_ ]ids?).{0,260}verdicts?|verdicts?.{0,260}(?:per-hypothesis|each hypothesis|hypothesis[_ ]ids?)/i,
      'completed digests carry a verdict for each hypothesis',
    );
    assert.match(
      reference,
      /(?:<run-id>|run-1):(?:<probe-id>|p1):(?:<ordinal>|1)/,
      'event citations must use run-id:probe-id:ordinal',
    );
  });

  test('probe budgets are causal and missing events do not become negative evidence', () => {
    const reference = flat(read(FILES.reference));

    assertMatchesAll(reference, [
      /(?:normally|usual|default).{0,180}(?:1\s*[-–]\s*6|one to six).{0,160}probes?/i,
      /(?:hard maximum|never more than|must not exceed).{0,120}\b10\b.{0,120}probes?|\b10\b.{0,120}probes?.{0,120}(?:hard maximum|never more than|must not exceed)/i,
      /(?:each|every) probe.{0,220}(?:at least one|non-empty).{0,160}hypothes/i,
      /(?:missing|absent|no) events?.{0,220}inconclusive/i,
      /control event.{0,360}(?:path|execution).{0,260}(?:healthy|working).{0,180}(?:capture|sink|channel)/i,
    ], 'causal probe interpretation');
  });
});

describe('bounded reproduction and event transport (#3128)', () => {
  test('one exact reproduction follows the approved ladder and is reused unchanged', () => {
    const reference = flat(read(FILES.reference));

    assertMatchesAll(reference, [
      /(?:1\.|first).{0,180}(?:existing )?failing test.{0,340}(?:2\.|then).{0,220}(?:self-contained|bounded).{0,180}command.{0,340}(?:3\.|then).{0,220}(?:manual|runtime-reproduce)/i,
      /(?:self-contained|bounded) command.{0,300}(?:no|must not|does not).{0,180}temporary script/i,
      /(?:persist|select).{0,200}(?:one|exact).{0,160}reproduction_ref.{0,420}(?:unchanged|identical|same).{0,260}(?:baseline|post_fix|uninstrumented_verify)/i,
    ], 'exact reproduction ladder');
  });

  test('source-probe activation is conditional even when adaptive is requested', () => {
    const reference = flat(read(FILES.reference));

    assertMatchesAll(reference, [
      /(?:source probes?|tracked-source probes?).{0,320}(?:only|require).{0,260}(?:exact|persisted).{0,160}reproduction/i,
      /(?:existing|passive|current) evidence.{0,260}(?:cannot|insufficient|fails to).{0,200}(?:distinguish|separate).{0,160}hypothes/i,
      /(?:bounded|sanitize).{0,220}(?:output|event|capture)/i,
      /(?:low[- ]perturbation|observer effect|bug class).{0,260}(?:safe|eligible|permit)/i,
    ], 'adaptive activation gates');
  });

  test('GSDDBG1 JSON is written only to the ephemeral per-run sink', () => {
    const reference = flat(read(FILES.reference));

    assertIncludesAll(reference, ['GSDDBG1', 'GSD_DEBUG_PROBE_SINK'], 'runtime event transport');
    assertMatchesAll(reference, [
      /GSDDBG1.{0,180}(?:JSON|schema_version)/i,
      /GSD_DEBUG_PROBE_SINK.{0,260}(?:ephemeral|per-run|one run|reproduction process)/i,
      /(?:only|sole).{0,220}(?:per-run )?sink|sink.{0,220}(?:only|sole)/i,
      /(?:unset|remove|absent).{0,220}GSD_DEBUG_PROBE_SINK.{0,260}uninstrumented_verify|uninstrumented_verify.{0,260}GSD_DEBUG_PROBE_SINK.{0,220}(?:unset|remove|absent)/i,
    ], 'session-owned sink transport');
  });

  test('event envelope and hard caps are exact and failures are inconclusive', () => {
    const reference = flat(read(FILES.reference));
    const captureFailures = [
      ['overflow', /overflow/],
      ['malformed event', /malformed/],
      ['interleaved write', /interleaved writes?/],
      ['identity mismatch', /identity mismatch/],
      ['duplicate ordinal', /duplicate ordinals?/],
      ['non-monotonic ordinal', /non-monotonic ordinals?/],
      ['sink failure', /sink failure/],
    ];

    assertIncludesAll(reference, [
      'schema_version',
      'session_id',
      'run_id',
      'probe_id',
      'hypothesis_ids',
      'phase',
      'ordinal',
      'location',
      'message',
      'data',
      'timestamp',
    ], 'GSDDBG1 event identity');
    assertMatchesAll(reference, [
      /(?:1\s*KiB|1024 bytes).{0,160}(?:event|serialized)/i,
      /(?:100).{0,100}events?.{0,100}(?:per probe|\/probe)/i,
      /(?:256\s*KiB|262144 bytes).{0,160}(?:run|capture)/i,
    ], 'event capture limits');
    for (const [label, condition] of captureFailures) {
      assertBoundedRelationship(
        reference,
        condition,
        /inconclusive/,
        `${label} capture outcome`,
        700,
      );
    }
  });

  test('durable evidence is sanitized and captured events remain untrusted data', () => {
    const reference = flat(read(FILES.reference));

    assertMatchesAll(reference, [
      /(?:fixed|allowlisted).{0,200}message.{0,240}(?:bounded|allowlisted).{0,200}(?:scalar )?data/i,
      /(?:captured events?|GSDDBG1 events?).{0,260}(?:untrusted input|untrusted data).{0,220}(?:never|not).{0,160}instructions/i,
      /(?:persist|durable).{0,220}(?:only).{0,180}(?:counts|hashes|enums|verdicts|references|sanitized facts)/i,
      /(?:never|must not|do not).{0,320}(?:raw stdout|stdout\/stderr|application logs|request bodies|environment dumps|secrets|credentials|PII|arbitrary runtime values)/i,
    ], 'untrusted and sanitized evidence');
  });
});

describe('probe ownership, path confinement, and cleanup (#3128)', () => {
  test('the source ledger is durable before editing and marker identity is exact', () => {
    const reference = flat(read(FILES.reference));

    assertIncludesAll(reference, [
      'gsd-debug-probe:start <slug> <probe-id>',
      'gsd-debug-probe:end <slug> <probe-id>',
      'expected_block_sha256',
    ], 'source-probe ownership markers');
    assertMatchesAll(reference, [
      /(?:scan|search).{0,220}(?:target|file).{0,240}(?:marker collision|existing marker|collision).{0,200}(?:before|prior to).{0,120}(?:edit|insert)/i,
      /(?:persist|write).{0,180}(?:planned|ledger|manifest).{0,220}(?:before|prior to).{0,120}(?:edit|insert|source mutation)/i,
      /expected_block_sha256.{0,320}(?:complete|entire|exact).{0,140}(?:raw )?UTF-8 block.{0,220}(?:both|including).{0,120}marker/i,
      /(?:existing|target).{0,180}line[- ]ending/i,
    ], 'write-ahead source ownership');
  });

  test('source and capture paths are confined against traversal and symlinks', () => {
    const reference = flat(read(FILES.reference));
    const beforeAfterRevalidation = /(?:revalidat(?:e|ed|ion)).{0,180}before.{0,120}after.{0,120}capture|before.{0,120}after.{0,120}capture.{0,180}revalidat(?:e|ed|ion)/;

    assertMatchesAll(reference, [
      /(?:reject|forbid).{0,180}(?:source target|target).{0,180}symlink|symlink.{0,180}(?:source target|target).{0,180}(?:reject|forbid)/i,
      /(?:reject|forbid).{0,180}(?:\.\.|traversal|path escape)/i,
      /(?:fresh|empty).{0,180}(?:secure OS|operating-system|mkdtemp|temporary-directory primitive).{0,240}(?:artifact root|capture root|root)/i,
      /(?:canonical|real).{0,160}(?:root|identity).{0,220}persist.{0,180}(?:before|prior to).{0,160}(?:content|file|sink)/i,
      /(?:sink|capture file).{0,220}(?:exclusive|exclusively).{0,160}(?:non-symlink|not a symlink)/i,
      /(?:posix_dev_ino|st_dev).{0,260}(?:windows_volume_file_id|volume serial)/i,
      /(?:same-path replacement|same path replacement|identity drift).{0,260}(?:reject|fail|inconclusive|block)/i,
    ], 'path and sink confinement');
    assertBoundedRelationship(
      reference,
      /lexical(?: source| target)?(?: path)?/,
      /(?:inside|strict descendant of).{0,120}(?:repository|repo) root|(?:repository|repo) root.{0,120}(?:inside|strict descendant)/,
      'source lexical-path confinement',
      450,
    );
    assertBoundedRelationship(
      reference,
      /real(?: source| target)? paths?/,
      /(?:inside|strict descendant of).{0,120}(?:repository|repo) root|(?:repository|repo) root.{0,120}(?:inside|strict descendant)/,
      'source real-path confinement',
      450,
    );
    assertBoundedRelationship(
      reference,
      /lexical(?: and real)? paths?/,
      /strict (?:path-component )?descendant.{0,120}(?:artifact|capture|recorded) root/,
      'artifact lexical-path confinement',
      500,
    );
    assertBoundedRelationship(
      reference,
      /real paths?/,
      /strict (?:path-component )?descendant.{0,120}(?:artifact|capture|recorded) root/,
      'artifact real-path confinement',
      500,
    );
    assertBoundedRelationship(
      reference,
      /(?:artifact|capture) root(?: identity)?|artifact_root identity/,
      beforeAfterRevalidation,
      'artifact-root identity revalidation',
      550,
    );
    assertBoundedRelationship(
      reference,
      /sink(?: path)? identity/,
      beforeAfterRevalidation,
      'sink identity revalidation',
      550,
    );
  });

  test('cleanup removes only byte-identical session-owned blocks and artifacts', () => {
    const reference = flat(read(FILES.reference));
    const cleanupFailures = [
      ['nested marker', /nested markers?/],
      ['unbalanced marker', /unbalanced markers?/],
      ['ambiguous ownership', /ambiguous ownership|ownership ambiguity/],
      ['changed owned byte', /changed (?:owned )?bytes?|user edit.{0,80}(?:inside|within).{0,80}block/],
      ['block hash mismatch', /(?:block )?hash mismatch|bytes.{0,100}(?:do not|does not).{0,80}match.{0,80}expected_block_sha256/],
    ];

    assertMatchesAll(reference, [
      /(?:remove|delete).{0,160}(?:source )?block.{0,260}(?:balanced|complete).{0,220}(?:bytes|hash).{0,180}(?:match|equal).{0,180}expected_block_sha256/i,
      /(?:preserve|never delete|must not delete).{0,260}(?:outside|unrelated).{0,160}(?:user|dirty[- ]worktree|edit|change)/i,
      /(?:remove|delete).{0,180}(?:only).{0,180}(?:exact|ledgered|owned).{0,160}(?:artifact|path).{0,260}(?:never|no).{0,120}(?:glob|recursive)/i,
      /(?:remove|delete).{0,160}(?:artifact )?root.{0,220}(?:only|when).{0,120}empty/i,
      /(?:identity drift|unexpected contents).{0,260}(?:cleanup_failed|fail closed)/i,
    ], 'fail-closed owned cleanup');
    assertBoundedRelationship(
      reference,
      /marker collisions?/,
      /(?:reject|fail closed|do not edit|without editing)/,
      'pre-edit marker collision outcome',
      500,
    );
    for (const [label, condition] of cleanupFailures) {
      assertBoundedRelationship(
        reference,
        condition,
        /cleanup_failed/,
        `${label} cleanup outcome`,
        700,
      );
    }
    assertBoundedRelationship(
      reference,
      /unexpected (?:artifact-root|root) contents?/,
      /(?:preserve|leave in place|do not delete|must not delete)/,
      'unexpected artifact-root content preservation',
      500,
    );
    assertBoundedRelationship(
      reference,
      /unexpected (?:artifact-root|root) contents?/,
      /cleanup_failed/,
      'unexpected artifact-root content outcome',
      500,
    );
  });

  test('source probes cannot alter control flow or externally visible behavior', () => {
    const reference = flat(read(FILES.reference));
    const forbiddenSideEffects = [
      ['sleep', /\bsleeps?\b/],
      ['lock', /\blocks?\b/],
      ['retry', /\bretr(?:y|ies)\b/],
      ['await', /\bawaits?\b/],
      ['network call', /network (?:calls?|requests?)/],
      ['control-flow change', /control[- ]flow (?:changes?|behavior)/],
      ['application decision', /application decisions?/],
      ['return value', /return values?/],
      ['error handling', /error handling/],
      ['business state', /business state/],
      ['synchronization edge', /synchronization edges?/],
      ['network behavior', /network behavior/],
    ];

    for (const [label, sideEffect] of forbiddenSideEffects) {
      assertBoundedRelationship(
        reference,
        /(?:never|must not|forbid(?:den)?|prohibit(?:ed)?)/,
        sideEffect,
        `${label} probe prohibition`,
        700,
      );
    }
  });

  test('unstable and concurrent bug classes prefer passive/native evidence', () => {
    const reference = flat(read(FILES.reference));

    assertMatchesAll(reference, [
      /(?:Heisenbug|Mandelbug).{0,520}(?:existing logs|debugger|sampling|record\/replay|stress|wrapper|passive)/i,
      /concurrency.{0,520}(?:existing logs|debugger|sampling|record\/replay|stress|wrapper|passive|native)/i,
      /(?:observer effect|perturb).{0,260}(?:not eligible|ineligible|reject|forbid).{0,220}(?:source probe|tracked-source)/i,
    ], 'class-specific observation routing');
  });
});

describe('runtime lifecycle, checkpoints, and terminal gates (#3128)', () => {
  test('baseline, post-fix comparison, cleanup, and uninstrumented verification are ordered', () => {
    const reference = read(FILES.reference);
    const normalized = flat(reference);

    assert.match(
      normalized,
      /baseline.{0,900}post_fix.{0,900}(?:cleanup|remove).{0,900}uninstrumented_verify/i,
      'the same probes remain through comparison and are removed before final verification',
    );
    assert.match(
      normalized,
      /uninstrumented_verify.{0,420}(?:same|identical|unchanged|exact).{0,200}reproduction_ref|(?:same|identical|unchanged|exact).{0,200}reproduction_ref.{0,420}uninstrumented_verify/i,
      'final verification reuses the exact reproduction',
    );
  });

  test('resume reconciles active runs, probes, and artifacts before investigation', () => {
    const debuggerAgent = flat(read(FILES.debugger));

    assert.match(
      debuggerAgent,
      /(?:startup|resume|direct invocation).{0,420}(?:inspect|reconcile).{0,260}(?:active_run|probe\/artifact ledgers|probe ledger|artifact ledger|Runtime Evidence).{0,260}(?:first|before any|before other)/i,
      'interrupted ownership is reconciled before new work',
    );
  });

  test('dirty runtime state crosses only attributable runtime checkpoints or forced cutoff', () => {
    const reference = flat(read(FILES.reference));

    assertMatchesAll(reference, [
      /runtime-reproduce.{0,360}(?:only|sole).{0,220}(?:checkpoint|human checkpoint).{0,220}(?:active|source probe|dirty|instrument)/i,
      /(?:forced context cutoff|context exhaustion).{0,360}(?:active|source probe|dirty|instrument|resumable)/i,
      /(?:ordinary|decision|TDD|human-action).{0,280}checkpoint.{0,260}(?:clean|cleanup|remove)/i,
      /runtime-evidence-cleanup.{0,320}(?:cleanup_failed|resumable|failure)/i,
    ], 'bounded dirty-state checkpoints');
  });

  test('callers without runtime checkpoint capability cannot activate capture', () => {
    const reference = flat(read(FILES.reference));
    const debuggerAgent = flat(read(FILES.debugger));
    const diagnoseIssues = flat(read(FILES.diagnoseIssues));
    const debugPrompt = read(FILES.debugPrompt);

    assert.match(debugPrompt, /runtime_checkpoints_supported:\s*\{(?:true_or_false|runtime_checkpoints_supported)\}/);
    assert.match(diagnoseIssues, /runtime_checkpoints_supported:\s*false/i);
    assert.match(
      debuggerAgent,
      /runtime_checkpoints_supported.{0,180}(?:literal boolean|literal).{0,120}true/i,
      'debugger must fail closed unless caller capability is literal true',
    );
    assertMatchesAll(reference, [
      /runtime_checkpoints_supported.{0,180}(?:absent|invalid|missing).{0,160}false|(?:absent|invalid|missing).{0,160}runtime_checkpoints_supported.{0,180}false/i,
      /runtime_checkpoints_supported.{0,120}false.{0,480}(?:cannot|must not|never).{0,240}(?:structured capture|capture artifact|manual reproduction|runtime-reproduce)/i,
      /(?:agent-runnable|ordinary existing test|passive evidence).{0,360}(?:exhausted|insufficient).{0,260}inconclusive/i,
    ], 'caller capability fail-safe');
  });

  test('debugger and manager both gate every terminal or durable transition', () => {
    const debuggerAgent = flat(read(FILES.debugger));
    const manager = flat(read(FILES.manager));
    const reference = flat(read(FILES.reference));
    const nonCleanGate = /(?:non-clean runtime evidence|runtime evidence.{0,300}(?:must (?:be|remain).{0,100}(?:absent|not_used|clean)|absent.{0,120}not_used.{0,120}clean|cleanup_pending|cleanup_failed|planned|active))/;
    const transitions = [
      ['diagnosis completion', /diagnosis completion/],
      ['human verification', /human verification/],
      ['abandonment', /abandonment/],
      ['archive', /\barchive\b/],
      ['staging', /\bstaging\b/],
      ['commit', /\bcommit(?:ting)?\b/],
      ['knowledge-base write', /knowledge[- ]base writes?/],
      ['terminal return', /terminal returns?/],
    ];

    for (const [transition, pattern] of transitions) {
      assertBoundedRelationship(
        reference,
        nonCleanGate,
        pattern,
        `deep protocol non-clean gate for ${transition}`,
        1600,
      );
    }

    assertMatchesAll(reference, [
      /not_used.{0,320}(?:empty|no).{0,180}(?:probe|artifact).{0,240}clean.{0,360}(?:every|all).{0,160}(?:probe|artifact).{0,180}removed.{0,360}(?:zero|0).{0,120}(?:count|remaining).{0,220}(?:null|no).{0,100}failure/i,
      /(?:malformed|contradictory).{0,220}(?:non-terminal|cleanup|fail closed)/i,
      /active_run.{0,180}(?:null|absent|cleared).{0,420}(?:terminal|commit|archive)|(?:terminal|commit|archive).{0,420}active_run.{0,180}(?:null|absent|cleared)/i,
    ], 'deep terminal predicate');

    assertMatchesAll(debuggerAgent, [
      /debugger-runtime-evidence\.md.{0,320}(?:terminal|predicate)/i,
      /(?:debugger owns|direct invocation).{0,360}(?:reconcile|cleanup)/i,
    ], 'debugger delegates to the deep terminal gate');
    assertMatchesAll(manager, [
      /debugger-runtime-evidence\.md.{0,320}(?:terminal|predicate)/i,
      /(?:do not|never).{0,320}(?:verify|abandon|archive).{0,320}(?:stage|commit).{0,320}(?:knowledge|summarize)/i,
    ], 'manager defense-in-depth terminal gate');

    const workflow = flat(read(FILES.workflow));
    assert.ok(
      count(workflow, 'empty probe/artifact ledgers') >= 2,
      'both new-session and continue orchestration paths must reject contradictory not_used ledgers',
    );
    assert.ok(
      count(workflow, 'Malformed or contradictory') + count(workflow, 'malformed or contradictory') >= 2,
      'both orchestration terminal paths must fail closed on malformed runtime state',
    );
  });

  test('final uninstrumented reproduction precedes fix guardrail and human verification', () => {
    const reference = flat(read(FILES.reference));

    assert.match(
      reference,
      /uninstrumented_verify.{0,700}(?:five-signal|fix acceptance|fix-acceptance|guardrail).{0,520}human verification/i,
      'final acceptance ordering must be explicit',
    );
  });
});

describe('local-only operational boundary (#3128)', () => {
  test('runtime evidence introduces no package or SDK dependency', () => {
    const pkg = JSON.parse(read(FILES.packageJson));
    const dependencyNames = [
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.devDependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
    ];

    assert.ok(
      dependencyNames.every((name) => !/(?:millionco|debug-agent)/i.test(name)),
      `runtime evidence must not add debug-agent dependencies: ${dependencyNames.join(', ')}`,
    );
  });

  test('the shipped protocol forbids operated services, telemetry, and shared traces', () => {
    const reference = flat(read(FILES.reference));

    assertMatchesAll(reference, [
      /(?:no|never|must not|do not).{0,260}(?:daemon|collector|server|hosted service)/i,
      /(?:no|never|must not|do not).{0,260}(?:telemetry|network transport|upload|external service)/i,
      /(?:no|never|must not|do not).{0,260}(?:external dependency|package|SDK)/i,
      /(?:no|never|must not|do not).{0,260}(?:shared application-runtime trace|shared trace|global trace)/i,
    ], 'local transport-neutral boundary');
  });

  test('raw capture never enters dispatch, resolved sessions, commits, or the knowledge base', () => {
    const reference = flat(read(FILES.reference));

    assert.match(
      reference,
      /(?:raw logs|raw events|raw capture|stdout\/stderr).{0,620}(?:never|must not|do not).{0,520}(?:dispatch trace|debug session|resolved session|commit|knowledge base)/i,
      'only bounded sanitized digests may become durable project state',
    );
  });
});
