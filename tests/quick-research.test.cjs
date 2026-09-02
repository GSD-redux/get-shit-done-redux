/**
 * GSD Quick Research Flag Tests
 *
 * Validates the --research flag for /gsd-quick:
 * - Command frontmatter advertises --research
 * - Workflow includes research step (Step 4.75)
 * - Research artifacts work within quick task directories
 * - Workflow spawns gsd-phase-researcher for research
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { runGsdTools, createTempProject, cleanup, absPlanningPath } = require('./helpers.cjs');

const COMMANDS_DIR = path.join(__dirname, '..', 'commands', 'gsd');
const WORKFLOWS_DIR = path.join(__dirname, '..', 'gsd-core', 'workflows');
const REPO_ROOT_FOR_SECTIONS = path.join(__dirname, '..');

/**
 * #2994 fragmentization moved Steps 4.5/4.75/5.5/5.6/6.5 out of quick.md into
 * gsd-core/workflows/quick/steps/*.md behind section markers. Position-based
 * slicing here (`indexOf('Step 4.75')` .. `indexOf('Step 5:')`, etc.) needs
 * those step headings back at their original logical position, not appended
 * at the end — so expand each `<!-- gsd:section id="X" ... -->...
 * <!-- /gsd:section -->` marker IN PLACE with its step file's content.
 */
function expandWorkflowSections(workflowPath) {
  const raw = fs.readFileSync(workflowPath, 'utf8');
  const markerRe = /<!-- gsd:section id="[\w-]+" when="[^"]*" -->[\s\S]*?<!-- \/gsd:section -->/g;
  return raw.replace(markerRe, (block) => {
    const pathMatch = block.match(/`([^`]+\.md)`/);
    if (!pathMatch) return block;
    const stepPath = path.join(REPO_ROOT_FOR_SECTIONS, pathMatch[1]);
    if (!fs.existsSync(stepPath)) return block;
    return fs.readFileSync(stepPath, 'utf8');
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Command frontmatter: --research flag advertised
// ─────────────────────────────────────────────────────────────────────────────

describe('quick command: --research in frontmatter', () => {
  const commandPath = path.join(COMMANDS_DIR, 'quick.md');
  let content;

  test('quick.md exists', () => {
    assert.ok(fs.existsSync(commandPath), 'commands/gsd/quick.md should exist');
  });

  test('argument-hint includes --research', () => {
    content = fs.readFileSync(commandPath, 'utf-8');
    assert.ok(
      content.includes('--research'),
      'quick.md argument-hint should mention --research'
    );
  });

  test('argument-hint includes all three flags', () => {
    content = fs.readFileSync(commandPath, 'utf-8');
    const hintLine = content.split('\n').find(l => l.includes('argument-hint'));
    assert.ok(hintLine, 'should have argument-hint line');
    assert.ok(hintLine.includes('--full'), 'argument-hint should include --full');
    assert.ok(hintLine.includes('--discuss'), 'argument-hint should include --discuss');
    assert.ok(hintLine.includes('--research'), 'argument-hint should include --research');
  });

  test('objective section describes --research flag', () => {
    content = fs.readFileSync(commandPath, 'utf-8');
    const objectiveMatch = content.match(/<objective>([\s\S]*?)<\/objective>/);
    assert.ok(objectiveMatch, 'should have <objective> section');
    assert.ok(
      objectiveMatch[1].includes('--research'),
      'objective should describe --research flag'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Workflow: research step present and correct
// ─────────────────────────────────────────────────────────────────────────────

describe('quick workflow: research step', () => {
  const workflowPath = path.join(WORKFLOWS_DIR, 'quick.md');
  let content;

  test('workflow file exists', () => {
    assert.ok(fs.existsSync(workflowPath), 'workflows/quick.md should exist');
    content = expandWorkflowSections(workflowPath);
  });

  test('purpose mentions --research flag', () => {
    content = expandWorkflowSections(workflowPath);
    const purposeMatch = content.match(/<purpose>([\s\S]*?)<\/purpose>/);
    assert.ok(purposeMatch, 'should have <purpose> section');
    assert.ok(
      purposeMatch[1].includes('--research'),
      'purpose should mention --research flag'
    );
  });

  test('step 1 parses --research flag', () => {
    content = expandWorkflowSections(workflowPath);
    assert.ok(
      content.includes('$RESEARCH_MODE'),
      'workflow should reference $RESEARCH_MODE variable'
    );
  });

  test('step 4.75 research phase exists', () => {
    content = expandWorkflowSections(workflowPath);
    assert.ok(
      content.includes('Step 4.75'),
      'workflow should contain Step 4.75 (research phase)'
    );
  });

  test('research Agent uses researcher role bindings end to end', () => {
    content = expandWorkflowSections(workflowPath);
    const researchStart = content.indexOf('Step 4.75');
    const plannerStart = content.indexOf('Step 5:', researchStart);
    assert.ok(researchStart !== -1, 'Step 4.75 anchor should exist');
    assert.ok(plannerStart > researchStart, 'Step 5 should follow Step 4.75');

    const researchSection = content.slice(researchStart, plannerStart);
    const parseStart = content.indexOf('Parse JSON for:');
    const parseEnd = content.indexOf('\n\n', parseStart);
    assert.ok(parseStart !== -1, 'init parse-list anchor should exist');
    assert.ok(parseEnd > parseStart, 'init parse list should be non-empty');
    const parseList = content.slice(parseStart, parseEnd);

    const agentStart = researchSection.indexOf('Agent(');
    const agentEnd = researchSection.indexOf('\n)', agentStart);
    assert.ok(agentStart !== -1, 'research Agent call should exist');
    assert.ok(agentEnd > agentStart, 'research Agent payload should be non-empty');
    const researchAgent = researchSection.slice(agentStart, agentEnd);

    assert.deepStrictEqual(
      {
        hostSkillBinding: content.includes(
          'AGENT_SKILLS_RESEARCHER=$(gsd_run query agent-skills gsd-phase-researcher)'
        ),
        modelParsed: parseList.includes('researcher_model'),
        researcherPersona: researchAgent.includes('${AGENT_SKILLS_RESEARCHER}'),
        researcherSubagent: researchAgent.includes('subagent_type="gsd-phase-researcher"'),
        researcherModel: researchAgent.includes('model="{researcher_model}"'),
        plannerPersona: researchAgent.includes('${AGENT_SKILLS_PLANNER}'),
        plannerModel: researchAgent.includes('model="{planner_model}"'),
      },
      {
        hostSkillBinding: true,
        modelParsed: true,
        researcherPersona: true,
        researcherSubagent: true,
        researcherModel: true,
        plannerPersona: false,
        plannerModel: false,
      }
    );
  });

  test('executor dispatch keeps its own persona', () => {
    content = expandWorkflowSections(workflowPath);
    const executorStart = content.indexOf('Step 6: Spawn executor');
    const reviewStart = content.indexOf('Step 6.25', executorStart);
    assert.ok(executorStart !== -1, 'Step 6 executor anchor should exist');
    assert.ok(reviewStart > executorStart, 'Step 6.25 should follow the executor');

    const executorSection = content.slice(executorStart, reviewStart);
    const agentStart = executorSection.indexOf('Agent(');
    const agentEnd = executorSection.indexOf('\n)', agentStart);
    assert.ok(agentStart !== -1, 'executor Agent call should exist');
    assert.ok(agentEnd > agentStart, 'executor Agent payload should be non-empty');
    const executorAgent = executorSection.slice(agentStart, agentEnd);

    assert.deepStrictEqual(
      {
        executorPersona: executorAgent.includes('${AGENT_SKILLS_EXECUTOR}'),
        plannerPersona: executorAgent.includes('${AGENT_SKILLS_PLANNER}'),
        researcherPersona: executorAgent.includes('${AGENT_SKILLS_RESEARCHER}'),
      },
      {
        executorPersona: true,
        plannerPersona: false,
        researcherPersona: false,
      }
    );
  });

  test('research step writes RESEARCH.md', () => {
    content = expandWorkflowSections(workflowPath);
    const researchSection = content.substring(
      content.indexOf('Step 4.75'),
      content.indexOf('Step 5:')
    );
    assert.ok(
      researchSection.includes('RESEARCH.md'),
      'research step should reference RESEARCH.md output file'
    );
  });

  test('planner context includes RESEARCH.md when research mode', () => {
    content = expandWorkflowSections(workflowPath);
    const plannerSection = content.substring(
      content.indexOf('Step 5: Spawn planner'),
      content.indexOf('Step 5.5')
    );
    assert.ok(
      plannerSection.includes('RESEARCH_MODE') && plannerSection.includes('RESEARCH.md'),
      'planner should read RESEARCH.md when $RESEARCH_MODE is true'
    );
  });

  test('file commit list includes RESEARCH.md', () => {
    content = expandWorkflowSections(workflowPath);
    const commitSection = content.substring(
      content.indexOf('Step 8:'),
      content.indexOf('</process>')
    );
    assert.ok(
      commitSection.includes('RESEARCH_MODE') && commitSection.includes('RESEARCH.md'),
      'commit step should include RESEARCH.md when research mode is active'
    );
  });

  test('success criteria includes research items', () => {
    content = expandWorkflowSections(workflowPath);
    const criteriaMatch = content.match(/<success_criteria>([\s\S]*?)<\/success_criteria>/);
    assert.ok(criteriaMatch, 'should have <success_criteria> section');
    assert.ok(
      criteriaMatch[1].includes('--research'),
      'success criteria should mention --research flag'
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Quick task directory: RESEARCH.md file management
// ─────────────────────────────────────────────────────────────────────────────

describe('quick task: research file in task directory', () => {
  let tmpDir;

  beforeEach(() => {
    // #2376 macOS fix: realpath the fixture root so absolute path-field
    // assertions (absPlanningPath comparisons below) match the code's
    // process.cwd()-anchored output — macOS's tmpdir is a symlink
    // (/var/... -> /private/var/...) that a spawned child resolves via
    // realpath but createTempProject() does not. No-op on Linux (no symlink).
    tmpDir = fs.realpathSync(createTempProject());
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  test('init quick returns valid task_dir for research file placement', () => {
    const result = runGsdTools('init quick "Add caching layer"', tmpDir);
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.ok(output.task_dir, 'task_dir should be non-null');
    // #2376: task_dir is now absolute (anchored on tmpDir), not the historical
    // relative literal.
    const quickDirAbs = absPlanningPath(tmpDir, 'quick');
    assert.ok(
      output.task_dir.startsWith(`${quickDirAbs}/`),
      'task_dir should be under .planning/quick/'
    );

    const expectedResearchPath = path.join(
      output.task_dir,
      `${output.next_num}-RESEARCH.md`
    );
    assert.ok(
      expectedResearchPath.endsWith('-RESEARCH.md'),
      'research path should end with -RESEARCH.md'
    );
  });

  test('verify-path-exists detects RESEARCH.md in quick task directory', () => {
    const quickTaskDir = path.join(tmpDir, '.planning', 'quick', '1-test-task');
    fs.mkdirSync(quickTaskDir, { recursive: true });
    fs.writeFileSync(
      path.join(quickTaskDir, '1-RESEARCH.md'),
      '# Research\n\nFindings for test task.\n'
    );

    const result = runGsdTools(
      'verify-path-exists .planning/quick/1-test-task/1-RESEARCH.md',
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.exists, true, 'RESEARCH.md should be detected');
    assert.strictEqual(output.type, 'file', 'should be detected as file');
  });

  test('verify-path-exists returns false for missing RESEARCH.md', () => {
    const quickTaskDir = path.join(tmpDir, '.planning', 'quick', '1-test-task');
    fs.mkdirSync(quickTaskDir, { recursive: true });

    const result = runGsdTools(
      'verify-path-exists .planning/quick/1-test-task/1-RESEARCH.md',
      tmpDir
    );
    assert.ok(result.success, `Command failed: ${result.error}`);

    const output = JSON.parse(result.output);
    assert.strictEqual(output.exists, false, 'missing RESEARCH.md should return false');
  });

  test('quick task directory supports all research workflow artifacts', () => {
    const quickTaskDir = path.join(tmpDir, '.planning', 'quick', '1-add-caching');
    fs.mkdirSync(quickTaskDir, { recursive: true });

    const artifacts = [
      '1-CONTEXT.md',
      '1-RESEARCH.md',
      '1-PLAN.md',
      '1-SUMMARY.md',
      '1-VERIFICATION.md',
    ];

    for (const artifact of artifacts) {
      fs.writeFileSync(path.join(quickTaskDir, artifact), `# ${artifact}\n`);
    }

    for (const artifact of artifacts) {
      const result = runGsdTools(
        `verify-path-exists .planning/quick/1-add-caching/${artifact}`,
        tmpDir
      );
      assert.ok(result.success, `Command failed for ${artifact}: ${result.error}`);
      const output = JSON.parse(result.output);
      assert.strictEqual(
        output.exists,
        true,
        `${artifact} should exist in quick task directory`
      );
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Flag composability: banner variants in workflow
// ─────────────────────────────────────────────────────────────────────────────

describe('quick workflow: banner variants for flag combinations', () => {
  let content;

  test('has banner for research-only mode', () => {
    content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'quick.md'), 'utf-8');
    assert.ok(
      content.includes('QUICK TASK (RESEARCH)'),
      'should have banner for --research only'
    );
  });

  test('has banner for discuss + research mode', () => {
    content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'quick.md'), 'utf-8');
    assert.ok(
      content.includes('DISCUSS + RESEARCH)'),
      'should have banner for --discuss --research'
    );
  });

  test('has banner for research + validate mode', () => {
    content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'quick.md'), 'utf-8');
    assert.ok(
      content.includes('RESEARCH + VALIDATE)'),
      'should have banner for --research --validate'
    );
  });

  test('has banner for full mode (all phases)', () => {
    content = fs.readFileSync(path.join(WORKFLOWS_DIR, 'quick.md'), 'utf-8');
    assert.ok(
      content.includes('QUICK TASK (FULL)'),
      'should have banner for --full (all phases enabled)'
    );
  });
});

// ─── #3894: quick.md honors workflow.research_before_questions ───────────────

describe('#3894 quick.md research-before-questions ordering', () => {
  const QUICK = fs.readFileSync(path.join(WORKFLOWS_DIR, 'quick.md'), 'utf-8');

  test('quick.md reads workflow.research_before_questions', () => {
    assert.ok(
      QUICK.includes('research_before_questions'),
      '#3894: the quick path must read the documented key — before this fix neither quick.md nor its steps referenced it'
    );
  });

  test('when enabled, research-phase is ordered BEFORE discussion-phase', () => {
    const orderingIdx = QUICK.indexOf('research_before_questions');
    assert.ok(orderingIdx !== -1, 'key referenced');
    const ruleWindow = QUICK.slice(orderingIdx, orderingIdx + 900);
    assert.ok(
      /research[- ]phase[^]{0,200}(before|prior to|first)[^]{0,120}discussion/i.test(ruleWindow)
        || /when[^]{0,60}(true|enabled)[^]{0,300}research/i.test(ruleWindow),
      'the ordering rule must state research runs before discussion when the key is true'
    );
    assert.ok(
      ruleWindow.includes('false') || ruleWindow.includes('unset') || ruleWindow.toLowerCase().includes('unchanged'),
      'and must keep the written order when false/unset'
    );
  });

  test('both step sections remain section-manifest gated (no structural regression)', () => {
    assert.ok(/gsd:section id="discussion-phase"/.test(QUICK), 'discussion-phase section marker intact');
    assert.ok(/gsd:section id="research-phase"/.test(QUICK), 'research-phase section marker intact');
  });
});
