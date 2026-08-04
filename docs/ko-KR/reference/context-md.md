# CONTEXT.md 스키마 참조

페이즈별 `CONTEXT.md`는 `/gsd-discuss-phase` 중 캡처된 구현 결정을 담는 GSD Core의 파일입니다. 이 파일은 리서치 에이전트와 플래닝 에이전트 모두를 위한 주요 업스트림 입력입니다. 이 페이지는 해당 파일의 구조를 설명합니다. [문서 인덱스](../../README.md)를 참조하세요.

---

## 개요

논의 워크플로를 거친 모든 페이즈는 다음 위치에 하나의 `CONTEXT.md`를 생성합니다:

```
.planning/phases/<NN>-<slug>/<NN>-CONTEXT.md
```

예: `.planning/phases/03-post-feed/03-CONTEXT.md`.

이 파일은 `gsd-core/workflows/discuss-phase.md`의 `write_context`(또는 PRD / ADR 인제스트 익스프레스 경로)에 의해 생성됩니다. 일반적인 운영 중에는 절대로 수동으로 편집하지 않습니다 — discuss-phase 워크플로가 이 파일을 기록하고 다운스트림 에이전트는 이를 봉인된 진실의 원천으로 읽습니다.

---

## 프론트매터

`CONTEXT.md`에는 YAML 프론트매터가 없습니다. 메타데이터는 본문 상단에 인라인으로 위치합니다:

```markdown
# Phase [X]: [Name] - Context

**Gathered:** [ISO date]
**Status:** Ready for planning
```

`Status` 필드는 파일이 처음 기록될 때 항상 `Ready for planning`입니다. 생성 후에는 업데이트되지 않습니다.

---

## 블록 구조

본문은 이름이 붙여진 XML 스타일 블록으로 나뉩니다. 블록은 고정된 순서로 나타나며 다운스트림 에이전트는 줄 번호가 아닌 블록 이름으로 읽습니다.

| 블록 | 목적 | 작성자 | 소비자 |
|---|---|---|---|
| `<domain>` | 페이즈 경계를 명시합니다 — 이 페이즈가 무엇을 전달하고 명시적으로 범위 밖인 것이 무엇인지. 플래닝과 실행 전반에 걸쳐 범위 가드레일을 고정합니다. | `discuss-phase` (ROADMAP.md 페이즈 목표에서) | `gsd-planner`, `gsd-plan-checker` (범위 준수) |
| `<spec_lock>` | `check_spec` 단계에서 `*-SPEC.md`가 발견된 경우에만 존재합니다. 잠긴 요구사항 수와 범위 경계를 나열하며, 에이전트는 전체 요구사항을 위해 `SPEC.md`를 직접 읽도록 안내됩니다. | `discuss-phase` (조건부) | `gsd-planner` (요구사항을 여기서 재읽지 않고 SPEC.md를 읽음) |
| `<decisions>` | 논의에서 캡처된 구현 결정으로 `D-NN` 식별자로 키가 지정됩니다. 카테고리는 고정된 분류법이 아닌 실제로 논의된 내용에서 나옵니다. 사용자가 위임한 영역을 위한 `Claude's Discretion` 하위 섹션을 포함합니다. | `discuss-phase` (대화형 토론) | `gsd-planner` (잠긴 결정은 반드시 구현되어야 함), `gsd-plan-checker` (Dimension 7 준수) |
| `<canonical_refs>` | 이 페이즈와 관련된 모든 spec, ADR, 기능 문서, 또는 설계 문서의 전체 상대 경로. 필수 — 모든 CONTEXT.md에 이 섹션이 있어야 합니다. 에이전트는 플래닝 또는 구현 전에 나열된 파일을 읽어야 합니다. | `discuss-phase` (ROADMAP.md 참조 + 토론 중 사용자 참조 + 코드베이스 스카우트에서 축적) | `gsd-phase-researcher`, `gsd-planner` |
| `<code_context>` | `scout_codebase` 단계에서 발견된 재사용 가능한 자산, 확립된 패턴, 통합 지점. 에이전트가 재구현하는 대신 기존 코드를 활용하도록 안내합니다. | `discuss-phase` (코드베이스 스카우트) | `gsd-planner`, `gsd-phase-researcher` |
| `<specifics>` | 토론 중 캡처된 구체적인 "X처럼 하고 싶다" 참조, 제품 비교, 또는 특정 예시. | `discuss-phase` (자유형 사용자 입력) | `gsd-planner` |
| `<deferred>` | 토론에서 제기되었지만 다른 페이즈에 속하는 아이디어. 잃어버리지 않도록 보존됩니다. todo가 검토되었지만 범위에 포함되지 않은 경우 `Reviewed Todos` 하위 섹션을 포함합니다. | `discuss-phase` (범위 초과 리디렉션) | 자동화된 에이전트가 소비하지 않음; 인간 참조 전용 |

---

## 결정 식별자 형식

`<decisions>`의 모든 결정에는 순차적인 `D-NN` 식별자가 있습니다:

```markdown
### Layout style
- **D-01:** Card-based layout, not timeline or list
- **D-02:** Each card shows: author avatar, name, timestamp, full post content, reaction counts
```

식별자는 페이즈 범위입니다. Phase 3의 `D-01`은 Phase 7의 `D-01`과 관계없습니다. 플랜 체커(Dimension 7)는 모든 `D-NN`이 생성된 플랜의 적어도 하나의 태스크 액션에서 다루어지는지 검증합니다.

---

## 표준 참조

`<canonical_refs>` 블록은 **필수**입니다. 이 블록이 없는 CONTEXT.md를 발견한 에이전트는 CONTEXT.md를 불완전한 것으로 처리하고 경고를 표시합니다. 항목은 주제별로 그룹화되며 전체 상대 경로와 파일이 결정하거나 정의하는 내용에 대한 간략한 설명을 포함합니다:

```markdown
<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Feed display
- `docs/features/social-feed.md` — Feed requirements, post card fields, engagement display rules
- `docs/decisions/adr-012-infinite-scroll.md` — Scroll strategy decision, virtualisation requirements

### Empty states
- `docs/design/empty-states.md` — Empty state patterns, illustration guidelines

</canonical_refs>
```

프로젝트에 외부 spec이 없는 경우, 섹션은 이를 명시적으로 기술합니다:

```
No external specs — requirements fully captured in decisions above
```

`<decisions>` 안에 흩어진 "ADR-019 참조" 같은 인라인 언급은 불충분합니다. 에이전트는 전용 섹션에 전체 경로가 필요합니다.

---

## 결정 커버리지 게이트 관계

플랜 체커의 **Dimension 7: Context Compliance**는 플래닝 후 커버리지 게이트를 강제합니다:

1. `<decisions>`의 모든 `D-NN` 식별자는 적어도 하나의 플랜 태스크의 `<action>` 또는 근거에 나타나야 합니다.
2. 어떤 태스크도 `<deferred>`에 나열된 것을 구현해서는 안 됩니다(범위 초과).
3. `Claude's Discretion` 영역은 이 확인에서 제외됩니다 — 플래너는 자유롭게 선택할 수 있습니다.

결정이 플랜에 반영된 CONTEXT.md는 준수 상태로 간주됩니다. 결정이 조용히 삭제되거나 부분적으로만 전달된 CONTEXT.md는 **Dimension 7b: Scope Reduction Detection**을 트리거하며, 이는 항상 BLOCKER입니다.

---

## SPEC.md 통합

페이즈를 논의하기 전에 `/gsd-spec-phase`가 실행된 경우, `check_spec` 단계에서 `*-SPEC.md` 파일을 찾아 `<spec_lock>`을 활성화합니다:

```markdown
<spec_lock>
## Requirements (locked via SPEC.md)

**12 requirements are locked.** See `03-SPEC.md` for full requirements, boundaries, and acceptance criteria.

Downstream agents MUST read `03-SPEC.md` before planning or implementing. Requirements are not duplicated here.

**In scope (from SPEC.md):** [copied from SPEC.md Boundaries]
**Out of scope (from SPEC.md):** [copied from SPEC.md Boundaries]

</spec_lock>
```

`<spec_lock>`이 있는 경우, `<decisions>`는 토론에서 나온 구현 결정만 포함합니다 — "무엇을"이 아닌 "어떻게". 요구사항은 두 파일 간에 중복되지 않습니다.

---

## 푸터

모든 CONTEXT.md는 아이덴티티 푸터로 끝납니다:

```markdown
---

*Phase: XX-name*
*Context gathered: [date]*
```

---

## Related

- [PLAN.md 스키마](plan-md.md)
- [Planning artifacts](planning-artifacts.md)
- [Discuss 모드](../../workflow-discuss-mode.md)
- [docs index](../../README.md)
