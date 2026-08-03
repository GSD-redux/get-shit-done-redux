'use strict';

// allow-test-rule: source-text-is-the-product see #2994 — G5 below asserts that an
// extracted step file's raw text does not contain the literal resolver call
// for the SAME fact that gates its own admission (a circular, self-disabling
// section). There is no typed/structural representation of "this step body
// re-derives its own gate" other than the text itself; G2 asserts a specific
// resolver variable's source line is retained verbatim because a STILL-LIVE
// consumer elsewhere in the same host file reads it literally.

/**
 * Resolver-hoist guard — #2994 (epic #1671 Phase 6.3) matrix §G
 * (`.gsd/phase/chore-2994-fragment-model-workflows/50-test-matrix.md`):
 * "did the hoist break the ungated path?" and "did the hoist actually
 * happen?" — a gated section whose own extracted body STILL resolves its own
 * gating fact is a circular, self-disabling section (the `plan-phase.md:125-158`
 * precedent named in `40-design.md`'s negative space).
 *
 * G5 generalizes G1-G4 into ONE data-driven assertion over the SHIPPED
 * `gsd-core/workflows/section-manifest.json`, so a FUTURE extraction cannot
 * reintroduce the class without this test catching it: for every gated
 * section whose `when=` atom has a documented, config-key-backed (or
 * detector-backed) resolution — per `src/section-manifest.cts`'s
 * `InvocationFacts` JSDoc and `src/init.cts`'s `detect*`/`buildSectionManifestField`
 * comments, both read directly rather than re-guessed — its own step file
 * must not contain the literal resolver call for that SAME fact. Where no
 * generic rule is derivable (e.g. `state:workstream-active`'s env/pointer
 * resolution, `state:is-monorepo`'s glob-detector, `state:next-channel`'s
 * flag-only resolution), the atom is simply absent from the map below and
 * skipped — per the matrix's own "where a generic rule is impossible, encode
 * the specific known pairs" instruction.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SHIPPED_MANIFEST_PATH = path.join(ROOT, 'gsd-core', 'workflows', 'section-manifest.json');

function readShippedManifest() {
  return JSON.parse(fs.readFileSync(SHIPPED_MANIFEST_PATH, 'utf8'));
}

/**
 * Concatenated content of every ```-fenced code block in `content` (fence
 * markers themselves excluded). A LIVE resolver call (an actual `gsd_run
 * query ...`/`gsd_run loop ...` invocation the runtime would execute) only
 * ever appears inside a fenced bash block; a PROSE mention of the same
 * config key or command name (e.g. documenting why a resolver was
 * deliberately removed, or naming a config key in a sentence) appears in
 * single-backtick inline code within ordinary prose, never inside a fence.
 * Restricting the forbidden-substring search below to fenced content is what
 * lets G5 tell "this step file still executes the resolver" apart from
 * "this step file's prose merely talks about the resolver" — both
 * `mvp-display.md` and `reviewer-instances-note-1.md` do the latter
 * (explaining, in prose, why they do NOT re-resolve), which a plain
 * whole-file substring search cannot distinguish from the former.
 */
function fencedCodeOnly(content) {
  const parts = content.split('```');
  // parts[0] is text before the first fence, parts[1] is inside the first
  // fence, parts[2] is between fence 1's close and fence 2's open, etc. —
  // odd indices are fence interiors (matches this repo's other fence-aware
  // helpers' `%2===1` convention).
  return parts.filter((_, i) => i % 2 === 1).join('\n');
}

// ─── G5: no gated section's own step file resolves its own gating fact ────

/**
 * Known {when atom -> forbidden literal substring(s)} pairs: the exact
 * resolver invocation each atom's fact is documented as being hoisted FROM
 * (`src/init.cts`'s `detectFallowConfig`/`detectGitCreateTag`/`readConfigJsonBoolean`
 * call sites, and `src/section-manifest.cts`'s matching `InvocationFacts`
 * JSDoc for each field). A step file gated on the atom must never contain
 * that substring — if it does, the section re-derives the same fact its own
 * marker already gates on, instead of consuming the init-resolved value.
 */
const ATOM_FORBIDDEN_RESOLVER_SUBSTRINGS = Object.freeze({
  'state:fallow-enabled': ['code_quality.fallow.enabled'],
  'state:git-create-tag': ['git.create_tag'],
  'state:chunked-mode': ['workflow.plan_chunked'],
  'state:worktrees-enabled': ['workflow.use_worktrees'],
  'state:reviewer-instances-configured': ['review.reviewer_instances'],
  'state:phase-mvp-mode': ['phase.mvp-mode'],
  // #2994: detectUiPhaseActive (src/init.cts) resolves this fact via
  // `resolveLoopHooks({point:'plan:pre', ...})` — the CLI-facing equivalent
  // of that SAME resolution is `gsd_run loop render-hooks plan:pre`.
  'state:ui-phase-active': ['render-hooks plan:pre'],
});

describe('no gated section resolves its own gating fact (matrix row G5, data-driven over the shipped manifest)', () => {
  const manifest = readShippedManifest();

  for (const [workflow, sections] of Object.entries(manifest.workflows)) {
    for (const section of sections) {
      const forbidden = ATOM_FORBIDDEN_RESOLVER_SUBSTRINGS[section.when];
      if (!forbidden) continue; // no generic rule for this atom — see module doc comment.

      test(`${workflow}.md § "${section.id}" (when="${section.when}") does not re-resolve its own gate`, () => {
        const stepFilePath = path.join(ROOT, section.read);
        const stepContent = fencedCodeOnly(fs.readFileSync(stepFilePath, 'utf8'));
        for (const token of forbidden) {
          assert.ok(
            !stepContent.includes(token),
            `${section.read} (gated on "${section.when}") must not itself call the resolver for that fact ` +
              `(found forbidden substring "${token}") — this is a circular, self-disabling section: the init-resolved ` +
              `fact already gates this file's own inclusion, so re-deriving it inside the file is dead weight at best ` +
              `and a divergent second resolver at worst`,
          );
        }
      });
    }
  }

  test('the forbidden-substring map itself covers at least one atom actually present in the shipped manifest (anti-vacuity)', () => {
    const usedAtoms = new Set();
    for (const sections of Object.values(manifest.workflows)) {
      for (const section of sections) usedAtoms.add(section.when);
    }
    const coveredAndUsed = Object.keys(ATOM_FORBIDDEN_RESOLVER_SUBSTRINGS).filter((atom) => usedAtoms.has(atom));
    assert.ok(coveredAndUsed.length > 0, 'the forbidden-substring map must exercise at least one atom the shipped manifest actually gates a section on');
  });
});

// ─── G2: autonomous.md's $PLAN_STRATEGY resolver survives the converge hoist
// because ungated "local" bullets still consume it literally ─────────────

describe('autonomous.md retains its $PLAN_STRATEGY resolver — still consumed by ungated content (matrix row G2)', () => {
  const filePath = path.join(ROOT, 'gsd-core', 'workflows', 'autonomous.md');
  const content = fs.readFileSync(filePath, 'utf8');

  test('the PLAN_STRATEGY resolver (local/converge assignment) is present verbatim', () => {
    assert.ok(content.includes('PLAN_STRATEGY="local"'), 'the default-local assignment must survive the converge-hoist');
    assert.ok(content.includes('PLAN_STRATEGY="converge"'), 'the converge-branch assignment must survive the converge-hoist');
  });

  test('an ungated "PLAN_STRATEGY=local" consumer exists OUTSIDE any converge-* gated section', () => {
    const { parseWorkflowSections } = require('../gsd-core/bin/lib/workflow-fragments.cjs');
    const sections = parseWorkflowSections(content, 'gsd-core/workflows/autonomous.md');

    const CONSUMER_TEXT = 'If `PLAN_STRATEGY=local`, run the regular planner:';
    assert.ok(content.includes(CONSUMER_TEXT), 'the ungated local-strategy consumer text must exist in the host file');

    const gatedConvergeSections = sections.filter((s) => s.explicit && s.when === 'state:plan-strategy-converge');
    assert.ok(gatedConvergeSections.length > 0, 'sanity: autonomous.md must have at least one state:plan-strategy-converge gated section');
    for (const gated of gatedConvergeSections) {
      assert.ok(
        !gated.body.includes(CONSUMER_TEXT),
        `the ungated PLAN_STRATEGY=local consumer must not live inside gated section "${gated.id}" — deleting that section must never remove the local-planning path`,
      );
    }

    // Deleting the resolver would break this ungated consumer — assert the
    // resolver assignment and the consumer are BOTH present outside every
    // converge-gated section (i.e. in the always-composed remainder).
    const gapText = sections.filter((s) => !s.explicit).map((s) => s.body).join('');
    assert.ok(gapText.includes('PLAN_STRATEGY="local"'));
    assert.ok(gapText.includes(CONSUMER_TEXT));
  });
});
