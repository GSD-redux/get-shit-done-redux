/**
 * UI-consideration probe — the THIRD adapter of the probe-core resolution model
 * (ADR-457 build model; ADR-550 Decision 7 seam; #1867).
 *
 * The generic resolution lifecycle, the status×verification re-cut, `validateResolution`,
 * `validateRequirement`, the `analyzeCoverage` merge/rollup/orphan-reject engine, and the
 * `runProbeCli` scaffold all live in `src/probe-core.cts`. This module keeps ONLY the
 * UI-specific cluster: the six element kinds, the closed 8-category shape-rooted UI state
 * taxonomy, element classification, consideration proposal, and the `{ explicit, backstop }`
 * verification validators — mirroring `edge-probe` on the UI element/state axis.
 *
 * MIXED-axis boundary (spike verdict, ADR-550 pattern): this compiled taxonomy covers ONLY the
 * finite, project-independent shape-rooted *content/robustness* states (empty/loading/error/…).
 * Open, domain-specific UX considerations (real-time/offline, deep a11y/WCAG breadth, i18n/RTL
 * depth, emerging interaction paradigms) are prose-owned in `references/domain-probes.md`, NOT
 * here — forcing them into a closed compiled taxonomy is the wrong model.
 *
 * Authored as strict TypeScript (`src/ui-consideration-probe.cts`) and compiled by
 * `tsc -p tsconfig.build.json` to the gitignored runtime artifact
 * `gsd-core/bin/lib/ui-consideration-probe.cjs`. Do NOT hand-write the `.cjs`; it is emitted.
 * Tests `require()` the built artifact; `pretest` runs `build:lib` first.
 */

import {
  type Item,
  type Resolution,
  type CoverageReport,
  type Validators,
  validateRequirement as coreValidateRequirement,
  validateResolution as coreValidateResolution,
  analyzeCoverage as coreAnalyzeCoverage,
  runProbeCli,
} from './probe-core.cjs';

/** The six UI element kinds a described component can be (the closed relevance axis, D-03). */
export type UIElementKind =
  | 'form'
  | 'list-collection'
  | 'nav'
  | 'media'
  | 'interactive-control'
  | 'static-content';

/** The UI probe's verification tiers (mirrors EdgeVerification — the `verification` axis values). */
export type UIVerification = 'explicit' | 'backstop';

/** A single UI-state taxonomy category. `elements` lists which kinds make it applicable. */
export interface TaxonomyEntry {
  id: string;
  name: string;
  elements: UIElementKind[];
  consideration: string;
}

/** A UI element to probe; `elements` is an optional authored override of classification. */
export interface Element {
  id: string;
  text?: string;
  elements?: UIElementKind[];
}

/** A UI consideration item — a probe-core `Item` specialized to the UI verification vocabulary. */
export type UIConsideration = Item<UIVerification>;

/**
 * Word-boundary cues mapping element prose -> UI element kind.
 * Heuristic and intentionally lossy; an authored `elements` array overrides it. Every pattern is a
 * flat linear `\b(a|b|c)\b` alternation with NO nested/overlapping quantifiers (no catastrophic
 * backtracking — mirrors SHAPE_CUES).
 */
export const UI_CUES: Record<UIElementKind, RegExp> = {
  'form': /\b(forms?|inputs?|fields?|submit|validation|validate|password|email|checkbox|radio|textarea)\b/i,
  'list-collection': /\b(lists?|listing|tables?|grids?|collections?|rows?|items?|cards?|feed|results?)\b/i,
  'nav': /\b(nav|navigation|menus?|tabs?|breadcrumbs?|pagination|sidebars?)\b/i,
  'media': /\b(images?|img|videos?|avatars?|thumbnails?|photos?|gallery|icons?)\b/i,
  'interactive-control': /\b(buttons?|toggles?|switch|switches|dropdowns?|sliders?|controls?|pickers?)\b/i,
  'static-content': /\b(labels?|headings?|titles?|paragraphs?|copy|descriptions?|text)\b/i,
};

/** The locked element vocabulary — exactly the keys of UI_CUES (single source of truth). */
export const VALID_ELEMENT_KINDS: ReadonlySet<string> = new Set(Object.keys(UI_CUES));

/** Detect which element kinds a description's prose matches (heuristic). */
export function classifyElement(text: string): UIElementKind[] {
  const kinds: UIElementKind[] = [];
  const subject = String(text == null ? '' : text);
  for (const kind of Object.keys(UI_CUES) as UIElementKind[]) {
    if (UI_CUES[kind].test(subject)) kinds.push(kind);
  }
  return kinds;
}

/**
 * Closed taxonomy of 8 shape-rooted UI *content/robustness* state categories. `elements` lists
 * which element kinds make the category relevant. These ids are the CLOSED/compiled subset — the
 * open UX subset (real-time/offline, deep a11y, i18n/RTL depth) is prose-owned in
 * `references/domain-probes.md` and deliberately absent here (D-02).
 */
export const UI_TAXONOMY: TaxonomyEntry[] = [
  { id: 'empty', name: 'Empty / no data', elements: ['form', 'list-collection', 'media'], consideration: 'What is shown when there is no data — zero items, an unfilled form, or absent media?' },
  { id: 'loading', name: 'Loading / in-flight', elements: ['form', 'list-collection', 'media', 'nav', 'interactive-control'], consideration: 'What is shown while data or content is still loading (skeleton, spinner, progressive reveal)?' },
  { id: 'error', name: 'Error / failure', elements: ['form', 'list-collection', 'media', 'nav', 'interactive-control'], consideration: 'What is shown when the load or submit fails (message, retry affordance, partial fallback)?' },
  { id: 'populated', name: 'Populated / happy path', elements: ['list-collection', 'media'], consideration: 'What does the normal populated (happy-path) state look like at a typical volume of content?' },
  { id: 'partial', name: 'Partial / incomplete', elements: ['form', 'list-collection'], consideration: 'What is shown for partial or incomplete data — some fields or rows present, others missing?' },
  { id: 'overflow', name: 'Overflow / truncation', elements: ['list-collection', 'nav', 'static-content'], consideration: 'What happens when content exceeds its container — scroll, clip, wrap, or truncate?' },
  { id: 'zero-one-many', name: 'Zero / one / many', elements: ['list-collection'], consideration: 'How does the layout read at zero, one, and many items (singular vs plural copy, spacing)?' },
  { id: 'long-text', name: 'Long text', elements: ['form', 'static-content', 'interactive-control', 'nav'], consideration: 'What happens with unusually long text — truncation, wrapping, ellipsis, or reflow?' },
];

/** Return taxonomy category ids whose applicable element kinds intersect the input set. */
export function applicableCategories(kinds: UIElementKind[]): string[] {
  const set = new Set<UIElementKind>(kinds);
  return UI_TAXONOMY.filter((c) => c.elements.some((k) => set.has(k))).map((c) => c.id);
}

/**
 * Pseudo-category for an element whose prose matched NO element cue (#1110). It is a soft
 * "review manually" signal, NOT a 9th taxonomy category: it stays out of `UI_TAXONOMY` (the closed
 * eight) and only joins `UI_VALIDATORS.categories` so `analyzeCoverage` accepts the item.
 */
export const UNCLASSIFIED_CATEGORY = 'unclassified';
const UNCLASSIFIED_PROBE = 'unclassified — review manually';

/**
 * The UI adapter's injected runtime validators (ADR-550 #5). `categories` is the closed taxonomy
 * plus the unclassified soft-signal; both verification tiers require a non-empty `resolution` so
 * plan-phase has a criterion to lift. NOTE the probe-core Validators field is `verification`
 * (SINGULAR); CONTEXT.md D-05's `verifications` is a paraphrase typo, not the real field name.
 */
export const UI_VALIDATORS: Validators = {
  categories: [...UI_TAXONOMY.map((c) => c.id), UNCLASSIFIED_CATEGORY],
  verification: ['explicit', 'backstop'],
  requiredFieldsByVerification: { explicit: ['resolution'], backstop: ['resolution'] },
};

/**
 * Validate a single element — the generic id/text checks (probe-core) plus the UI adapter's
 * `elements`-must-be-an-array check. The `text` prose is REQUIRED (it is the classification
 * signal), so reject a missing/empty `text` when no authored `elements` override is present.
 * Without this, a `{ id }` element classifies to zero kinds → zero considerations → it is silently
 * DROPPED from coverage. An explicit `elements` array (including `[]` for "no applicable
 * categories") is the legitimate way to opt out of prose classification.
 */
export function validateRequirement(element: Element): void {
  coreValidateRequirement(element);
  const r = element as unknown as { elements?: unknown; text?: unknown };
  if (r.elements != null && !Array.isArray(r.elements)) {
    throw new Error(`element ${element.id} elements must be an array when present`);
  }
  if (r.elements == null && !(typeof r.text === 'string' && r.text.trim())) {
    throw new Error(
      `element ${element.id} text must be a non-empty string when no elements override is provided`,
    );
  }
}

/** Validate a UI-consideration resolution against the UI verification vocabulary (delegated, D-06). */
export function validateResolution(resolution: Resolution<UIVerification>): true {
  return coreValidateResolution(resolution, UI_VALIDATORS);
}

/**
 * Propose candidate considerations for an element. Uses authored `elements` when present, else
 * classifies from prose. Every proposed consideration starts unresolved (verification null); the
 * taxonomy entry's `consideration` question is carried in the item's `probe` field.
 */
export function proposeConsiderations(element: Element): UIConsideration[] {
  validateRequirement(element);
  let kinds: UIElementKind[];
  if (Array.isArray(element.elements)) {
    // Fail closed: an authored array must contain only locked element kinds. A non-empty but
    // invalid array would otherwise intersect no category and silently suppress every probe — the
    // gate reads green while nothing was checked. An empty array stays a valid "no applicable
    // categories" override (silent opt-out).
    for (const k of element.elements) {
      if (typeof k !== 'string' || !VALID_ELEMENT_KINDS.has(k)) {
        throw new Error(
          `invalid element kind ${JSON.stringify(k)} for element ${element.id} — must be one of: ${[...VALID_ELEMENT_KINDS].join(', ')}`,
        );
      }
    }
    kinds = element.elements;
  } else {
    kinds = classifyElement(element.text as string);
    if (kinds.length === 0) {
      // Prose present but no element cue matched. Do NOT silently drop it (#1110): a UI element
      // whose phrasing missed every cue would otherwise vanish from coverage with no signal — the
      // exact blind spot this probe exists to catch. Surface ONE soft, dismissible "unclassified —
      // review manually" candidate. The explicit `elements: []` opt-out (above) stays silent.
      return [{
        requirement_id: element.id,
        category: UNCLASSIFIED_CATEGORY,
        status: 'unresolved',
        verification: null,
        resolution: null,
        reason: null,
        probe: UNCLASSIFIED_PROBE,
      }];
    }
  }
  return applicableCategories(kinds).map((catId): UIConsideration => {
    const cat = UI_TAXONOMY.find((c) => c.id === catId);
    return {
      requirement_id: element.id,
      category: catId,
      status: 'unresolved',
      verification: null,
      resolution: null,
      reason: null,
      probe: cat ? cat.consideration : '',
    };
  });
}

/**
 * Propose considerations for every element (deterministic propose), then delegate the
 * merge/rollup/orphan-reject to probe-core. UI-specific pre-checks: elements must be an array,
 * element ids must be unique. Throws on any invalid resolution.
 */
export function analyzeCoverage(
  elements: Element[],
  resolutions: Resolution<UIVerification>[] = [],
): CoverageReport<UIVerification> {
  if (!Array.isArray(elements)) {
    throw new Error('elements must be an array');
  }
  const items: UIConsideration[] = [];
  const seenIds = new Set<string>();
  for (const el of elements) {
    validateRequirement(el);
    if (seenIds.has(el.id)) {
      throw new Error(`duplicate element id ${JSON.stringify(el.id)}`);
    }
    seenIds.add(el.id);
    for (const consideration of proposeConsiderations(el)) items.push(consideration);
  }
  return coreAnalyzeCoverage(items, resolutions, UI_VALIDATORS);
}

/**
 * A per-element propose-then-confirm view (WIRE-01, #1867): the detected element `kinds`, the
 * `categories` they raise, the proposed `considerations`, and an `unclassified` flag. The ui-phase
 * probe step surfaces `kinds` to the user so a human can ADD a kind the heuristic missed — the
 * classifier is a SIGNAL, not ground truth (Goodhart). A single tripped cue on a multi-kind surface
 * under-covers; the confirm step, not the heuristic, is what makes coverage sound.
 */
export interface ElementProposal {
  id: string;
  kinds: UIElementKind[];
  categories: string[];
  considerations: UIConsideration[];
  unclassified: boolean;
}

/**
 * Build the propose-then-confirm view for every element (WIRE-01). Deterministic: a pure function
 * of the input array (no Date/random/iteration-order surprise), so re-running the probe on an
 * unchanged UI-SPEC yields byte-identical rows (the idempotency substrate WIRE-02 relies on). An
 * aggregating VIEW over the existing Phase-1 functions — it adds no new classification logic.
 *
 * `unclassified` is true ONLY when prose classified to zero cues (#1110); an explicit `elements: []`
 * opt-out stays silent (`unclassified: false`, empty considerations), matching proposeConsiderations.
 */
export function proposeElements(elements: Element[]): ElementProposal[] {
  return elements.map((el): ElementProposal => {
    validateRequirement(el);
    const considerations = proposeConsiderations(el);
    const kinds: UIElementKind[] = Array.isArray(el.elements)
      ? el.elements // already validated inside proposeConsiderations
      : classifyElement(el.text as string);
    const unclassified = !Array.isArray(el.elements) && kinds.length === 0;
    const categories = unclassified ? [] : applicableCategories(kinds);
    return { id: el.id, kinds, categories, considerations, unclassified };
  });
}

/**
 * The deterministic `--auto` resolution FLOOR (WIRE-01, SC2). For each proposed consideration:
 *   - an `unclassified` item stays `unresolved` — NEVER auto-backstopped (a missing cue is not
 *     evidence a consideration applies, #1110);
 *   - every applicable item auto-resolves to a conservative `backstop` (carrying the taxonomy
 *     question as its `resolution` so probe-core's "backstop requires a resolution" check passes).
 *   - it NEVER emits `dismissed` under any branch — a wrong auto-dismissal is the exact silent
 *     failure this probe eliminates (the never-dismiss invariant, asserted on the typed return).
 *
 * This is the CODE floor only. It mirrors spec-phase.md Step 5.5's prose `--auto` rule
 * (auto-`covered` where a defensible acceptance criterion can be written, else auto-`backstop`,
 * never auto-`dismiss`) but deliberately keeps the covered-vs-backstop JUDGMENT in the ui-phase
 * workflow (an LLM MAY upgrade an item to `explicit`/covered when it can write a real acceptance
 * criterion). Encoding the never-dismiss FLOOR in code is what makes the invariant unit-testable;
 * the covered-upgrade stays prose because "a defensible criterion exists" is not a code predicate.
 * Keep the two in sync: if spec-phase's `--auto` policy changes, revisit this floor.
 */
export function autoResolve(items: UIConsideration[]): Resolution<UIVerification>[] {
  return items.map((item): Resolution<UIVerification> => {
    if (item.category === UNCLASSIFIED_CATEGORY) {
      return { requirement_id: item.requirement_id, category: item.category, status: 'unresolved', verification: null, resolution: null, reason: null };
    }
    return { requirement_id: item.requirement_id, category: item.category, status: 'resolved', verification: 'backstop', resolution: item.probe, reason: null };
  });
}

/*
 * CLI entry (invokable surface): `ui-consideration-probe.cjs <elements.json> [resolutions.json]`.
 * The generic I/O plumbing (parse, fail-closed exit 2, pretty-JSON out) lives in probe-core's
 * `runProbeCli`; this adapter supplies its `analyzeCoverage`. Guarded by `require.main === module`
 * so it runs only when the compiled `.cjs` is executed directly.
 */
if (require.main === module) {
  runProbeCli(
    (elements, resolutions) =>
      analyzeCoverage(elements as Element[], resolutions as Resolution<UIVerification>[]),
    { usage: 'ui-consideration-probe.cjs <elements.json> [resolutions.json]' },
  );
}
