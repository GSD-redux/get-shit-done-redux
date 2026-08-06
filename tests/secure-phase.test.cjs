// allow-test-rule: source-text-is-the-product
// Workflow .md / agent .md / command .md / reference .md files — their text
// IS what the runtime loads. Testing text content tests the deployed contract.
// Per CONTRIBUTING.md exception matrix.

/**
 * GSD Secure-Phase Tests
 *
 * Validates the security-first enforcement layer:
 * - gsd-security-auditor agent frontmatter and structure
 * - secure-phase command file
 * - secure-phase workflow file
 * - SECURITY.md template
 * - config.json security defaults
 * - VALIDATION.md security columns
 * - Threat-model-anchored behaviour (structural)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');
const AGENTS_DIR = path.join(REPO_ROOT, 'agents');
const COMMANDS_DIR = path.join(REPO_ROOT, 'commands', 'gsd');
const WORKFLOWS_DIR = path.join(REPO_ROOT, 'gsd-core', 'workflows');
const TEMPLATES_DIR = path.join(REPO_ROOT, 'gsd-core', 'templates');

// ─── 1. Agent frontmatter — gsd-security-auditor.md ─────────────────────────

describe('SECURE: gsd-security-auditor agent', () => {
  const agentPath = path.join(AGENTS_DIR, 'gsd-security-auditor.md');

  test('agent file exists', () => {
    assert.ok(
      fs.existsSync(agentPath),
      'gsd-security-auditor.md must exist in agents/'
    );
  });

  test('has valid frontmatter with name, description, tools, color', () => {
    const content = fs.readFileSync(agentPath, 'utf-8');
    const frontmatter = content.split('---')[1] || '';
    assert.ok(frontmatter.includes('name:'), 'missing name:');
    assert.ok(frontmatter.includes('description:'), 'missing description:');
    assert.ok(frontmatter.includes('tools:'), 'missing tools:');
    assert.ok(frontmatter.includes('color:'), 'missing color:');
  });

  test('name is gsd-security-auditor', () => {
    const content = fs.readFileSync(agentPath, 'utf-8');
    const frontmatter = content.split('---')[1] || '';
    assert.ok(
      frontmatter.includes('name: gsd-security-auditor'),
      'name must be gsd-security-auditor'
    );
  });

  test('tools include Read, Bash, Glob, Grep but NOT Write or Edit (#2119)', () => {
    const content = fs.readFileSync(agentPath, 'utf-8');
    const requiredTools = ['Read', 'Bash', 'Glob', 'Grep'];
    for (const tool of requiredTools) {
      assert.ok(
        content.includes(`- ${tool}`),
        `tools must include ${tool}`
      );
    }
    // #2119: auditor is return-only — orchestrator is the sole SECURITY.md writer
    assert.ok(!content.includes('- Write'), 'tools must NOT include Write (#2119)');
    assert.ok(!content.includes('- Edit'), 'tools must NOT include Edit (#2119)');
  });

  test('has <role> section', () => {
    const content = fs.readFileSync(agentPath, 'utf-8');
    assert.ok(content.includes('<role>'), 'must have <role> section');
    assert.ok(content.includes('</role>'), 'must close <role> section');
  });

  test('has <execution_flow> section', () => {
    const content = fs.readFileSync(agentPath, 'utf-8');
    assert.ok(content.includes('<execution_flow>'), 'must have <execution_flow> section');
    assert.ok(content.includes('</execution_flow>'), 'must close <execution_flow> section');
  });

  test('has <structured_returns> with SECURED, OPEN_THREATS, ESCALATE', () => {
    const content = fs.readFileSync(agentPath, 'utf-8');
    assert.ok(content.includes('<structured_returns>'), 'must have <structured_returns> section');
    assert.ok(content.includes('## SECURED'), 'must have SECURED return type');
    assert.ok(content.includes('## OPEN_THREATS'), 'must have OPEN_THREATS return type');
    assert.ok(content.includes('## ESCALATE'), 'must have ESCALATE return type');
  });

  test('has <success_criteria> section', () => {
    const content = fs.readFileSync(agentPath, 'utf-8');
    assert.ok(content.includes('<success_criteria>'), 'must have <success_criteria> section');
    assert.ok(content.includes('</success_criteria>'), 'must close <success_criteria> section');
  });

  test('has READ-ONLY rule — does NOT modify implementation files', () => {
    const content = fs.readFileSync(agentPath, 'utf-8');
    assert.ok(
      content.includes('READ-ONLY'),
      'must contain READ-ONLY rule for implementation files'
    );
  });
});

// ─── 2. Command file — secure-phase.md ──────────────────────────────────────

describe('SECURE: secure-phase command file', () => {
  const cmdPath = path.join(COMMANDS_DIR, 'secure-phase.md');

  test('command file exists', () => {
    assert.ok(
      fs.existsSync(cmdPath),
      'secure-phase.md must exist in commands/gsd/'
    );
  });

  test('has valid frontmatter with name gsd:secure-phase', () => {
    const content = fs.readFileSync(cmdPath, 'utf-8');
    const frontmatter = content.split('---')[1] || '';
    assert.ok(
      frontmatter.includes('name: gsd:secure-phase'),
      'name must be gsd:secure-phase'
    );
  });

  test('has allowed-tools list', () => {
    const content = fs.readFileSync(cmdPath, 'utf-8');
    const frontmatter = content.split('---')[1] || '';
    assert.ok(
      frontmatter.includes('allowed-tools:'),
      'must have allowed-tools in frontmatter'
    );
  });

  test('contains reference to secure-phase.md workflow', () => {
    const content = fs.readFileSync(cmdPath, 'utf-8');
    assert.ok(
      content.includes('secure-phase.md'),
      'must reference secure-phase.md workflow'
    );
  });

  test('has <objective> section mentioning states A, B, C', () => {
    const content = fs.readFileSync(cmdPath, 'utf-8');
    assert.ok(content.includes('<objective>'), 'must have <objective> section');
    assert.ok(content.includes('(A)'), 'must mention state A');
    assert.ok(content.includes('(B)'), 'must mention state B');
    assert.ok(content.includes('(C)'), 'must mention state C');
  });
});

// ─── 3. Workflow file — secure-phase.md ─────────────────────────────────────

describe('SECURE: secure-phase workflow file', () => {
  const wfPath = path.join(WORKFLOWS_DIR, 'secure-phase.md');

  test('workflow file exists', () => {
    assert.ok(
      fs.existsSync(wfPath),
      'secure-phase.md must exist in gsd-core/workflows/'
    );
  });

  test('contains gsd-security-auditor reference', () => {
    const content = fs.readFileSync(wfPath, 'utf-8');
    assert.ok(
      content.includes('gsd-security-auditor'),
      'must reference gsd-security-auditor agent'
    );
  });

  test('contains threats_open enforcement logic', () => {
    const content = fs.readFileSync(wfPath, 'utf-8');
    assert.ok(
      content.includes('threats_open'),
      'must contain threats_open enforcement logic'
    );
  });

  test('contains security capability hook check', () => {
    const content = fs.readFileSync(wfPath, 'utf-8');
    assert.ok(
      content.includes('loop render-hooks verify:post'),
      'must resolve security activation through verify:post capability hooks'
    );
    assert.ok(
      content.includes('ref.skill == "secure-phase"'),
      'must identify the secure-phase capability hook'
    );
    assert.ok(
      !content.includes('config-get workflow.security_enforcement'),
      'must not read workflow.security_enforcement directly after capability cutover'
    );
  });

  test('contains SECURITY.md template reference', () => {
    const content = fs.readFileSync(wfPath, 'utf-8');
    assert.ok(
      content.includes('SECURITY.md'),
      'must reference SECURITY.md template'
    );
  });

  test('has success_criteria section', () => {
    const content = fs.readFileSync(wfPath, 'utf-8');
    assert.ok(
      content.includes('<success_criteria>'),
      'must have <success_criteria> section'
    );
    assert.ok(
      content.includes('</success_criteria>'),
      'must close <success_criteria> section'
    );
  });
});

// ─── 4. SECURITY.md template ────────────────────────────────────────────────

describe('SECURE: SECURITY.md template', () => {
  const tplPath = path.join(TEMPLATES_DIR, 'SECURITY.md');

  test('template exists', () => {
    assert.ok(
      fs.existsSync(tplPath),
      'SECURITY.md must exist in gsd-core/templates/'
    );
  });

  test('has YAML frontmatter with required fields', () => {
    const content = fs.readFileSync(tplPath, 'utf-8');
    const frontmatter = content.split('---')[1] || '';
    const requiredFields = ['phase', 'slug', 'status', 'threats_open', 'asvs_level', 'created'];
    for (const field of requiredFields) {
      assert.ok(
        frontmatter.includes(`${field}:`),
        `frontmatter must have ${field}: field`
      );
    }
  });

  test('has ## Trust Boundaries section', () => {
    const content = fs.readFileSync(tplPath, 'utf-8');
    assert.ok(
      content.includes('## Trust Boundaries'),
      'must have ## Trust Boundaries section'
    );
  });

  test('has ## Threat Register table with required columns', () => {
    const content = fs.readFileSync(tplPath, 'utf-8');
    assert.ok(content.includes('## Threat Register'), 'must have ## Threat Register section');
    const requiredColumns = ['Threat ID', 'Category', 'Component', 'Disposition', 'Mitigation', 'Status'];
    for (const col of requiredColumns) {
      assert.ok(
        content.includes(col),
        `Threat Register table must have ${col} column`
      );
    }
  });

  test('has ## Accepted Risks Log section', () => {
    const content = fs.readFileSync(tplPath, 'utf-8');
    assert.ok(
      content.includes('## Accepted Risks Log'),
      'must have ## Accepted Risks Log section'
    );
  });

  test('has ## Security Audit Trail section', () => {
    const content = fs.readFileSync(tplPath, 'utf-8');
    assert.ok(
      content.includes('## Security Audit Trail'),
      'must have ## Security Audit Trail section'
    );
  });

  test('has sign-off checklist', () => {
    const content = fs.readFileSync(tplPath, 'utf-8');
    assert.ok(
      content.includes('## Sign-Off'),
      'must have ## Sign-Off section'
    );
    assert.ok(
      content.includes('- [ ]'),
      'sign-off must have checklist items'
    );
  });

  test('threats_open field is present (terminal condition field)', () => {
    const content = fs.readFileSync(tplPath, 'utf-8');
    const frontmatter = content.split('---')[1] || '';
    assert.ok(
      frontmatter.includes('threats_open:'),
      'threats_open must be present in frontmatter as terminal condition field'
    );
  });
});

// ─── 5. Config defaults ─────────────────────────────────────────────────────

describe('SECURE: config.json security defaults', () => {
  const configPath = path.join(TEMPLATES_DIR, 'config.json');

  test('config template exists', () => {
    assert.ok(
      fs.existsSync(configPath),
      'config.json must exist in gsd-core/templates/'
    );
  });

  test('has workflow.security_enforcement set to true', () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.strictEqual(
      config.workflow.security_enforcement,
      true,
      'security_enforcement must default to true'
    );
  });

  test('has workflow.security_asvs_level set to 1', () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.strictEqual(
      config.workflow.security_asvs_level,
      1,
      'security_asvs_level must default to 1'
    );
  });

  test('has workflow.security_block_on set to "high"', () => {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    assert.strictEqual(
      config.workflow.security_block_on,
      'high',
      'security_block_on must default to "high"'
    );
  });

  test('security_enforcement appears after nyquist_validation (opt-out pattern parity)', () => {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const nyquistPos = raw.indexOf('nyquist_validation');
    const securityPos = raw.indexOf('security_enforcement');
    assert.ok(nyquistPos > -1, 'nyquist_validation must exist in config');
    assert.ok(securityPos > -1, 'security_enforcement must exist in config');
    assert.ok(
      securityPos > nyquistPos,
      'security_enforcement must appear after nyquist_validation for opt-out pattern parity'
    );
  });
});

// ─── 6. VALIDATION.md template security columns ────────────────────────────

describe('SECURE: VALIDATION.md security columns', () => {
  const valPath = path.join(TEMPLATES_DIR, 'VALIDATION.md');

  test('VALIDATION.md template exists', () => {
    assert.ok(
      fs.existsSync(valPath),
      'VALIDATION.md must exist in gsd-core/templates/'
    );
  });

  test('contains Threat Ref column header', () => {
    const content = fs.readFileSync(valPath, 'utf-8');
    assert.ok(
      content.includes('Threat Ref'),
      'must have Threat Ref column in Per-Task Verification Map'
    );
  });

  test('contains Secure Behavior column header', () => {
    const content = fs.readFileSync(valPath, 'utf-8');
    assert.ok(
      content.includes('Secure Behavior'),
      'must have Secure Behavior column in Per-Task Verification Map'
    );
  });

  test('both columns appear in the Per-Task Verification Map table', () => {
    const content = fs.readFileSync(valPath, 'utf-8');
    // Find the table header row containing both columns
    const lines = content.split(/\r?\n/);
    const headerLine = lines.find(
      line => line.includes('Threat Ref') && line.includes('Secure Behavior')
    );
    assert.ok(
      headerLine,
      'Threat Ref and Secure Behavior must appear in the same table header row'
    );
    // Verify this is in the Per-Task Verification Map section
    const mapIdx = content.indexOf('## Per-Task Verification Map');
    const threatRefIdx = content.indexOf('Threat Ref');
    assert.ok(mapIdx > -1, 'must have Per-Task Verification Map section');
    assert.ok(
      threatRefIdx > mapIdx,
      'Threat Ref column must appear after Per-Task Verification Map heading'
    );
  });
});

// ─── 7. Per-threat severity gate (#1626) ────────────────────────────────────

describe('SECURE: per-threat severity gate (#1626)', () => {
  const plannerPath = path.join(AGENTS_DIR, 'gsd-planner.md');
  const auditorPath = path.join(AGENTS_DIR, 'gsd-security-auditor.md');
  const tplPath = path.join(TEMPLATES_DIR, 'SECURITY.md');
  const configDocPath = path.join(REPO_ROOT, 'gsd-core', 'references', 'planning-config.md');

  // ── planner: Severity column in threat register header ──────────────────
  test('gsd-planner.md threat_model register header has Severity column', () => {
    const content = fs.readFileSync(plannerPath, 'utf-8');
    assert.ok(
      content.includes('| Threat ID | Category | Component | Severity | Disposition | Mitigation Plan |'),
      'planner STRIDE Threat Register header must include a Severity column'
    );
  });

  test('gsd-planner.md security instruction assigns severity to each threat', () => {
    const content = fs.readFileSync(plannerPath, 'utf-8');
    assert.ok(
      content.includes('severity') && content.includes('critical|high|medium|low'),
      'planner security instruction must tell agents to assign a severity (critical|high|medium|low) to each threat'
    );
  });

  test('gsd-planner.md checklist has Severity item', () => {
    const content = fs.readFileSync(plannerPath, 'utf-8');
    assert.ok(
      content.includes('Every threat has a Severity (critical|high|medium|low)'),
      'planner success_criteria checklist must include a Severity checklist item'
    );
  });

  // ── auditor: block_on uses severity vocabulary ───────────────────────────
  test('gsd-security-auditor.md block_on domain is severity vocabulary', () => {
    const content = fs.readFileSync(auditorPath, 'utf-8');
    assert.ok(
      content.includes('block_on') && content.includes('critical') && content.includes('none'),
      'auditor <config> block_on must use severity vocabulary (critical ... none), not the old open/unregistered/none'
    );
  });

  test('gsd-security-auditor.md defines severity ordering critical > high > medium > low', () => {
    const content = fs.readFileSync(auditorPath, 'utf-8');
    assert.ok(
      content.includes('critical > high > medium > low'),
      'auditor must define the severity ordering: critical > high > medium > low'
    );
  });

  test('gsd-security-auditor.md threats_open counts only open threats at or above block_on', () => {
    const content = fs.readFileSync(auditorPath, 'utf-8');
    assert.ok(
      content.includes('threats_open') && content.includes('severity rank') && content.includes('block_on'),
      'auditor must state that threats_open counts only open threats whose severity rank >= block_on rank'
    );
  });

  test('gsd-security-auditor.md documents non-blocking below-threshold opens', () => {
    const content = fs.readFileSync(auditorPath, 'utf-8');
    assert.ok(
      content.includes('non-blocking') && content.includes('below'),
      'auditor must state that open threats below the block_on threshold are non-blocking and must not count toward threats_open'
    );
  });

  // ── SECURITY.md template: Severity column ───────────────────────────────
  test('SECURITY.md template Threat Register has Severity column', () => {
    const content = fs.readFileSync(tplPath, 'utf-8');
    assert.ok(
      content.includes('Severity'),
      'SECURITY.md Threat Register table must include a Severity column'
    );
  });

  // ── planning-config.md: security_block_on reconciled enum ───────────────
  test('planning-config.md security_block_on row lists critical', () => {
    const content = fs.readFileSync(configDocPath, 'utf-8');
    const blockOnLineIdx = content.indexOf('security_block_on');
    assert.ok(blockOnLineIdx > -1, 'planning-config.md must have security_block_on row');
    const lineEnd = content.indexOf('\n', blockOnLineIdx);
    const row = content.slice(blockOnLineIdx, lineEnd);
    assert.ok(
      row.includes('critical'),
      'security_block_on allowed values must include "critical"'
    );
  });

  test('planning-config.md security_block_on row lists none', () => {
    const content = fs.readFileSync(configDocPath, 'utf-8');
    const blockOnLineIdx = content.indexOf('security_block_on');
    assert.ok(blockOnLineIdx > -1, 'planning-config.md must have security_block_on row');
    const lineEnd = content.indexOf('\n', blockOnLineIdx);
    const row = content.slice(blockOnLineIdx, lineEnd);
    assert.ok(
      row.includes('none'),
      'security_block_on allowed values must include "none"'
    );
  });

  // ── auditor: classification vocabulary is severity-conditioned (not all-open-blocks) ──
  test('gsd-security-auditor.md BLOCKER classification conditions blocking on severity threshold (no unconditional all-open-blocks language)', () => {
    const content = fs.readFileSync(auditorPath, 'utf-8');
    // The reworded classification must include both the blocking condition (severity >= block_on)
    // AND the non-blocking category for below-threshold threats.
    // These substrings only appear in the reworded classification block.
    assert.ok(
      content.includes('severity ≥ `block_on`'),
      'BLOCKER classification must condition blocking on "severity ≥ `block_on`" threshold'
    );
    assert.ok(
      content.includes('OPEN-non-blocking (severity below block_on)'),
      'classification must include OPEN-non-blocking category for below-threshold threats'
    );
    // The old unconditional language said "phase must not ship" without a severity qualifier.
    // After the fix, every "phase must not ship" must be paired with a severity condition.
    // Find all occurrences of "must not ship" and verify none appear without "severity" nearby.
    const lines = content.split(/\r?\n/);
    for (const line of lines) {
      if (line.includes('must not ship') && !line.includes('severity')) {
        assert.fail(
          `Found "must not ship" without a severity condition on line: ${line.trim()}`
        );
      }
    }
  });

  // ── auditor: fail-closed for missing/unranked severity (Finding 1) ─────────
  test('gsd-security-auditor.md states fail-closed rule for missing/unranked severity', () => {
    const content = fs.readFileSync(auditorPath, 'utf-8');
    assert.ok(
      content.includes('Fail-closed') && content.includes('missing') && content.includes('critical'),
      'auditor must state that open threats with missing or unparseable severity are treated as critical (fail-closed / blocking)'
    );
  });

  // ── secure-phase workflow: blocking-threshold semantics in prose (Finding 2)
  test('secure-phase.md prose reflects blocking-threshold semantics for threats_open', () => {
    const wfPath = path.join(WORKFLOWS_DIR, 'secure-phase.md');
    const content = fs.readFileSync(wfPath, 'utf-8');
    assert.ok(
      content.includes('blocking threats') || content.includes('block threshold'),
      'secure-phase.md must use "blocking threats" or "block threshold" language when describing the threats_open gate'
    );
  });

  // ── secure-phase workflow: severity field in register shapes (#1626) ────────
  test('secure-phase.md Step 2c per-threat shape includes severity', () => {
    const wfPath = path.join(WORKFLOWS_DIR, 'secure-phase.md');
    const content = fs.readFileSync(wfPath, 'utf-8');
    // Step 2c defines the per-threat object shape — must carry severity so the
    // auditor's fail-closed rule can rank it rather than defaulting to critical.
    assert.ok(
      content.includes('threat_id, category, component, severity, disposition, mitigation_pattern'),
      'secure-phase.md Step 2c per-threat shape must include severity field'
    );
  });

  // ── docs/CONFIGURATION.md: security_block_on full enum (Finding 3) ─────────
  test('docs/CONFIGURATION.md security_block_on mentions critical and none', () => {
    const docsConfigPath = path.join(REPO_ROOT, 'docs', 'CONFIGURATION.md');
    const content = fs.readFileSync(docsConfigPath, 'utf-8');
    // Find the markdown table row (starts with '| `workflow.security_block_on`')
    const tableRowIdx = content.indexOf('| `workflow.security_block_on`');
    assert.ok(tableRowIdx > -1, 'docs/CONFIGURATION.md must have a workflow.security_block_on table row');
    const lineEnd = content.indexOf('\n', tableRowIdx);
    const row = content.slice(tableRowIdx, lineEnd);
    assert.ok(
      row.includes('critical'),
      'docs/CONFIGURATION.md security_block_on row must include "critical"'
    );
    assert.ok(
      row.includes('none'),
      'docs/CONFIGURATION.md security_block_on row must include "none"'
    );
  });
});

// ─── 8. Threat-model-anchored behaviour (structural) ────────────────────────

describe('SECURE: threat-model-anchored behaviour', () => {
  const agentPath = path.join(AGENTS_DIR, 'gsd-security-auditor.md');
  const wfPath = path.join(WORKFLOWS_DIR, 'secure-phase.md');

  test('agent does NOT contain "scan for vulnerabilities" (verifies, not scans)', () => {
    const content = fs.readFileSync(agentPath, 'utf-8');
    assert.ok(
      !content.toLowerCase().includes('scan for vulnerabilities'),
      'agent must NOT scan for vulnerabilities — it verifies threat mitigations'
    );
  });

  test('agent does NOT contain "find vulnerabilities" (verifies, not scans)', () => {
    const content = fs.readFileSync(agentPath, 'utf-8');
    assert.ok(
      !content.toLowerCase().includes('find vulnerabilities'),
      'agent must NOT find vulnerabilities — it verifies threat mitigations'
    );
  });

  test('agent contains mitigate, accept, transfer disposition types', () => {
    const content = fs.readFileSync(agentPath, 'utf-8');
    assert.ok(content.includes('mitigate'), 'must contain mitigate disposition');
    assert.ok(content.includes('accept'), 'must contain accept disposition');
    assert.ok(content.includes('transfer'), 'must contain transfer disposition');
  });

  test('agent contains OPEN and CLOSED status values', () => {
    const content = fs.readFileSync(agentPath, 'utf-8');
    assert.ok(content.includes('OPEN'), 'must contain OPEN status');
    assert.ok(content.includes('CLOSED'), 'must contain CLOSED status');
  });

  test('workflow contains enforcing gate (threats_open + block pattern)', () => {
    const content = fs.readFileSync(wfPath, 'utf-8');
    assert.ok(
      content.includes('threats_open'),
      'workflow must reference threats_open for enforcement'
    );
    assert.ok(
      content.includes('BLOCKED') || content.includes('blocked'),
      'workflow must contain a blocking pattern when threats are open'
    );
    // Verify it does NOT emit next-phase routing when blocked
    assert.ok(
      content.includes('Do NOT emit next-phase routing'),
      'workflow must explicitly prevent next-phase routing when blocked'
    );
  });
});

// ─── 8. Regression: security config variables resolved before use (#1625) ────
// allow-test-rule: source-text-is-the-product — secure-phase.md prose is the executed contract (#1625)

describe('SECURE: security config variables resolved before use (#1625)', () => {
  const wfPath = path.join(WORKFLOWS_DIR, 'secure-phase.md');

  test('SECURITY_ASVS is assigned (not only used as placeholder)', () => {
    const content = fs.readFileSync(wfPath, 'utf-8');
    assert.ok(
      content.includes('SECURITY_ASVS='),
      'SECURITY_ASVS must be assigned via config-get in the workflow, not only appear as {SECURITY_ASVS} placeholder'
    );
  });

  test('SECURITY_BLOCK_ON is assigned (not only used as placeholder)', () => {
    const content = fs.readFileSync(wfPath, 'utf-8');
    assert.ok(
      content.includes('SECURITY_BLOCK_ON='),
      'SECURITY_BLOCK_ON must be assigned via config-get in the workflow, not only appear as {SECURITY_BLOCK_ON} placeholder'
    );
  });

  test('SECURITY_ASVS assignment appears before the auditor <config> injection line', () => {
    const content = fs.readFileSync(wfPath, 'utf-8');
    const assignIdx = content.indexOf('SECURITY_ASVS=');
    const configInjIdx = content.indexOf('block_on: {SECURITY_BLOCK_ON}');
    assert.ok(assignIdx > -1, 'SECURITY_ASVS= must exist in the file');
    assert.ok(configInjIdx > -1, 'block_on: {SECURITY_BLOCK_ON} injection line must exist');
    assert.ok(
      assignIdx < configInjIdx,
      'SECURITY_ASVS must be assigned before the auditor <config> injection line that references {SECURITY_BLOCK_ON}'
    );
  });

  test('SECURITY_BLOCK_ON assignment appears before the auditor <config> injection line', () => {
    const content = fs.readFileSync(wfPath, 'utf-8');
    const assignIdx = content.indexOf('SECURITY_BLOCK_ON=');
    const configInjIdx = content.indexOf('block_on: {SECURITY_BLOCK_ON}');
    assert.ok(assignIdx > -1, 'SECURITY_BLOCK_ON= must exist in the file');
    assert.ok(configInjIdx > -1, 'block_on: {SECURITY_BLOCK_ON} injection line must exist');
    assert.ok(
      assignIdx < configInjIdx,
      'SECURITY_BLOCK_ON must be assigned before the auditor <config> injection line that references it'
    );
  });

  test('security config resolved via config-get with correct keys and defaults', () => {
    const content = fs.readFileSync(wfPath, 'utf-8');
    assert.ok(
      content.includes('config-get workflow.security_asvs_level'),
      'must resolve SECURITY_ASVS via config-get workflow.security_asvs_level'
    );
    assert.ok(
      content.includes('config-get workflow.security_block_on'),
      'must resolve SECURITY_BLOCK_ON via config-get workflow.security_block_on'
    );
    assert.ok(
      content.includes('echo "1"') && content.includes('echo "high"'),
      'config-get resolution must include the registry default fallbacks (1, high) so an unset/failed lookup still yields a valid value'
    );
  });

  test('security config-get uses --raw so the injected string value is unquoted', () => {
    const content = fs.readFileSync(wfPath, 'utf-8');
    // Without --raw, config-get returns JSON ("high" with quotes), which would
    // corrupt the auditor <config> block to `block_on: "high"`. --raw yields bare `high`.
    assert.ok(
      /config-get workflow\.security_block_on --raw/.test(content),
      'SECURITY_BLOCK_ON must be resolved with --raw (config-get returns a quoted "high" without it)'
    );
    assert.ok(
      /config-get workflow\.security_asvs_level --raw/.test(content),
      'SECURITY_ASVS must be resolved with --raw for consistency'
    );
  });
});


// ────────────────────────────────────────────────────────────────────────
// Folded from tests/bug-3120-secure-phase-empty-register.test.cjs — consolidation epic #1969 (B4 #1973)
// ────────────────────────────────────────────────────────────────────────
{
  const { describe: __foldDescribe } = require('node:test');
  __foldDescribe("folded:bug-3120-secure-phase-empty-register (consolidation epic #1969 B4 #1973)", () => {
'use strict';
// allow-test-rule: source-text-is-the-product (see #3120)
// Reads product workflow markdown (secure-phase.md) to verify structural
// guard contract.

// Regression guard for bug #3120.
//
// secure-phase.md Step 3 short-circuited to Step 6 (write SECURITY.md)
// whenever threats_open: 0, without distinguishing between:
//   Case A: All plan-time threat_model threats are CLOSED (legitimate skip)
//   Case B: No threat_model blocks were written at plan time (legacy phases)
//          → rubber-stamps a clean SECURITY.md with zero audit performed
//
// Fix: Step 2c tracks `register_authored_at_plan_time` (true iff ≥1 PLAN
// file contained a parseable <threat_model> block). Step 3 now requires BOTH
// threats_open: 0 AND register_authored_at_plan_time to skip. If only
// threats_open: 0 and NOT register_authored_at_plan_time, Step 5 runs in
// retroactive-STRIDE mode.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(
  path.join(ROOT, 'gsd-core', 'workflows', 'secure-phase.md'),
  'utf8',
);

describe('bug #3120: secure-phase short-circuit guards', () => {
  test('Step 2c tracks register_authored_at_plan_time', () => {
    assert.ok(
      src.includes('register_authored_at_plan_time'),
      'secure-phase.md does not track register_authored_at_plan_time in Step 2c',
    );
  });

  test('Step 3 short-circuit requires both conditions', () => {
    assert.ok(
      src.includes('threats_open: 0 AND register_authored_at_plan_time'),
      'Step 3 short-circuit does not gate on both threats_open:0 AND register_authored_at_plan_time',
    );
  });

  test('retroactive-STRIDE mode is documented for legacy phases', () => {
    assert.ok(
      src.includes('retroactive') || src.includes('Retroactive'),
      'secure-phase.md does not document retroactive-STRIDE mode for legacy phases (no <threat_model> blocks)',
    );
  });

  test('Step 5 auditor constraint varies by mode', () => {
    assert.ok(
      (src.includes('Verify mitigations') || src.includes('verify mitigations')) &&
      (src.includes('Retroactive') || src.includes('retroactive')),
      'Step 5 does not distinguish planned vs retroactive-STRIDE auditor constraint',
    );
  });
});
  });
}
