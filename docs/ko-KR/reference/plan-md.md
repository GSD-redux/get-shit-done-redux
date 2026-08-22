# PLAN.md 스키마 참조

플랜별 `PLAN.md`는 GSD Core의 실행 가능한 작업 단위입니다 — 실행기 에이전트에게 무엇을 빌드해야 하고 올바르게 빌드되었는지 어떻게 검증할지를 정확히 알려주는 구조화된 문서입니다. 이 페이지는 해당 파일의 구조를 설명합니다. [문서 인덱스](../../README.md)를 참조하세요.

---

## 개요

플랜은 다음 위치의 페이즈 디렉터리 내에 있습니다:

```
.planning/phases/<NN>-<slug>/<NN>-<PP>-PLAN.md
```

예: `.planning/phases/03-post-feed/03-02-PLAN.md` (Phase 3, Plan 2).

플랜은 `gsd-planner` 에이전트(`/gsd-plan-phase`에 의해 생성됨)가 만들고 `execute-phase`가 소비합니다. 페이즈는 보통 1~4개의 플랜을 포함하며, 페이즈 내의 플랜은 독립적인 작업이 병렬로 실행되도록 실행 웨이브에 할당됩니다.

---

## YAML 프론트매터

모든 PLAN.md는 `---` 구분자 사이의 YAML 프론트매터 블록으로 시작합니다.

### 주석이 달린 예시

```yaml
---
phase: 03-post-feed
plan: 02
type: execute
wave: 2
depends_on: ["03-01"]
files_modified:
  - src/components/PostFeed.tsx
  - src/components/PostCard.tsx
  - src/app/feed/page.tsx
autonomous: true
requirements: ["FEED-01", "FEED-03"]
user_setup: []

must_haves:
  truths:
    - "User can scroll through posts from followed accounts"
    - "Each post shows author avatar, name, timestamp, and content"
    - "Empty state appears when no posts exist"
  artifacts:
    - path: "src/components/PostFeed.tsx"
      provides: "Scrollable post list"
      min_lines: 40
    - path: "src/components/PostCard.tsx"
      provides: "Individual post card"
      exports: ["PostCard"]
  key_links:
    - from: "src/components/PostFeed.tsx"
      to: "/api/feed"
      via: "fetch in useEffect"
      pattern: "fetch.*api/feed"
---
```

### 프론트매터 필드 참조

| 필드 | 필수 | 타입 | 목적 |
|---|---|---|---|
| `phase` | 예 | string | 페이즈 식별자, 예: `03-post-feed`. |
| `plan` | 예 | string | 페이즈 내 플랜 번호, 예: `02`. |
| `type` | 예 | `execute` 또는 `tdd` | 표준 플랜의 경우 `execute`; 구현 전에 테스트를 먼저 작성하는 테스트 주도 플랜의 경우 `tdd`. |
| `wave` | 예 | integer | 실행 웨이브. 웨이브 1의 플랜은 병렬로 실행됩니다(의존성 없음). 웨이브 2 이상의 플랜은 이전 웨이브의 모든 플랜이 완료될 때까지 기다립니다. `gsd-planner`가 플래닝 시점에 미리 계산합니다. |
| `depends_on` | 예 | 플랜 ID 배열 | 이 플랜이 기다려야 하는 플랜. 빈 배열 = 웨이브 1. 예: `["03-01"]`은 이 플랜이 Phase 3의 Plan 01 이후에 실행됨을 의미합니다. |
| `files_modified` | 예 | 경로 배열 | 이 플랜이 생성하거나 수정하는 모든 파일. 플랜 체커가 동일 웨이브 파일 충돌을 감지하고 execute-phase가 머지 추적에 사용합니다. |
| `autonomous` | 예 | boolean | 모든 태스크가 `auto` 타입일 때 `true`. 플랜에 인간 상호작용이 필요한 `checkpoint:*` 태스크가 포함된 경우 `false`. |
| `requirements` | 예 | ID 배열 | 이 플랜이 처리하는 ROADMAP.md의 요구사항 ID. 모든 페이즈 요구사항 ID는 적어도 하나의 플랜의 `requirements` 필드에 나타나야 합니다. 빈 배열은 BLOCKER입니다. |
| `user_setup` | 아니오 | 객체 배열 | Claude가 자동화할 수 없는 외부 서비스 설정 단계(계정 생성, 시크릿 검색, 대시보드 구성). 있는 경우, execute-phase가 개발자를 위한 `USER-SETUP.md` 체크리스트를 생성합니다. |
| `must_haves` | 예 | 객체 | 목표 역방향 검증 기준. 아래를 참조하세요. |

---

## `must_haves` 필드

`must_haves`는 페이즈 목표 달성을 위해 관찰 가능하게 참이어야 하는 것을 캡처합니다. 플래닝 중에 도출되며 실행 후 `gsd-verifier` 에이전트가 검증합니다.

### 하위 필드

| 하위 필드 | 타입 | 목적 |
|---|---|---|
| `truths` | string 배열 | 사용자 관점에서의 관찰 가능한 동작. 각각은 검증 가능해야 합니다. 예: `"User can send a message"` (O), `"WebSocket library installed"` (X). |
| `artifacts` | 객체 배열 | 실질적인 구현이 있어야 하는 파일(스텁 불가). |
| `artifacts[].path` | string | 프로젝트 루트에 대한 상대 파일 경로. |
| `artifacts[].provides` | string | 이 파일이 제공하는 기능. |
| `artifacts[].min_lines` | integer (선택) | 스텁이 아닌 것으로 간주되기 위한 최소 행 수. |
| `artifacts[].exports` | string 배열 (선택) | 검증할 예상 이름 있는 export. |
| `artifacts[].contains` | string (선택) | 파일에 나타나야 하는 정규식 또는 리터럴 패턴. |
| `key_links` | 객체 배열 | 아티팩트 간의 중요한 연결 — 시스템이 엔드 투 엔드로 작동하게 하는 배선. |
| `key_links[].from` | string | 소스 파일 또는 컴포넌트. |
| `key_links[].to` | string | 대상 파일, 엔드포인트, 또는 모듈. |
| `key_links[].via` | string | 연결 방법 설명 (예: `fetch in useEffect`, `Prisma query`, `import`). |
| `key_links[].pattern` | string (선택) | 소스에 연결이 존재하는지 검증하기 위한 정규식. |

---

## 본문 구조

프론트매터 이후, 플랜 본문은 실행기 에이전트가 읽는 이름 붙여진 XML 스타일 블록을 사용합니다.

### `<objective>`

플랜이 무엇을 전달하고 프로젝트에서 왜 중요한지를 기술합니다:

```xml
<objective>
Implement the post feed as a scrollable card list.

Purpose: Core display feature for the social feed phase.
Output: PostFeed and PostCard components wired to /api/feed.
</objective>
```

### `<execution_context>`

실행기가 시작 전에 읽는 워크플로 파일을 나열합니다. 항상 execute-plan 워크플로를 포함하며, 플랜에 체크포인트 태스크가 포함된 경우 체크포인트 참조를 추가합니다:

```xml
<execution_context>
@~/.claude/gsd-core/workflows/execute-plan.md
@~/.claude/gsd-core/templates/summary.md
</execution_context>
```

### `<context>`

실행기가 읽어야 하는 소스 파일을 참조합니다. 프로젝트 수준 플래닝 문서와 플랜이 복제해야 하는 패턴이나 타입을 가진 소스 파일을 포함합니다. 이전 플랜의 `SUMMARY.md` 파일은 타입이나 공유 결정에 대한 실질적인 의존성이 있는 경우에만 포함됩니다 — 반사적으로 포함하지 않습니다:

```xml
<context>
@.planning/PROJECT.md
@.planning/ROADMAP.md
@.planning/STATE.md
@src/components/UserCard.tsx
</context>
```

### `<tasks>`

하나 이상의 `<task>` 요소를 포함합니다. 모든 태스크 요소는 `type="auto"` 태스크의 경우 `<name>`, `<files>`, `<read_first>`, `<action>`, `<verify>`, `<acceptance_criteria>`, `<done>`을 가져야 합니다.

---

## 태스크 타입

| 타입 | 사용 시점 | 자율성 |
|---|---|---|
| `auto` | 실행기가 독립적으로 할 수 있는 모든 것. | 완전 자율. |
| `checkpoint:human-verify` | 실행 중인 UI 또는 서비스를 인간이 직접 봐야 하는 시각적 또는 기능적 검증. | 실행 일시 중지; 개발자에게 표시; 승인 시 재개. |
| `checkpoint:decision` | 실행 중에 발생하여 개발자 입력이 필요한 구현 선택. | 실행 일시 중지; 옵션 표시; 선택 시 재개. |
| `checkpoint:human-action` | 진정으로 불가피한 수동 단계(계정 생성, 하드웨어 상호작용). 드물게 사용. | 실행 일시 중지; 확인 시 재개. |

체크포인트 태스크가 포함된 플랜은 프론트매터에서 `autonomous: false`로 설정해야 합니다.

---

## `auto` 태스크 구조

```xml
<task type="auto">
  <name>Task 1: Create PostCard component</name>
  <files>src/components/PostCard.tsx</files>
  <read_first>src/components/UserCard.tsx, src/types/post.ts</read_first>
  <action>Create PostCard component accepting a Post prop (id, authorId, content, createdAt,
    reactionCount). Render author avatar using UserAvatar from UserCard pattern. Show timestamp
    using date-fns formatDistanceToNow. Export as named export PostCard.</action>
  <verify>npx tsc --noEmit</verify>
  <acceptance_criteria>
    - src/components/PostCard.tsx exports named export PostCard
    - PostCard.tsx contains "reactionCount" prop usage
    - npx tsc --noEmit exits 0
  </acceptance_criteria>
  <done>PostCard renders post content with author and timestamp</done>
</task>
```

### `auto` 태스크의 필수 필드

| 필드 | 규칙 |
|---|---|
| `<files>` | 태스크가 생성하거나 수정하는 모든 파일. 실행기는 이 파일들만 작성합니다. |
| `<read_first>` | 무언가를 건드리기 전에 실행기가 읽어야 하는 파일 — 수정할 파일, 진실의 원천 패턴 파일, 타입이나 규칙을 복제해야 하는 파일. |
| `<action>` | 정확한 식별자, 파일 경로, 함수 서명, 예상 값이 포함된 구체적인 지침. 목표 상태를 지정하지 않고 "X를 Y와 맞추세요"라고 말하지 않습니다. 펜스 코드 블록이나 전체 구현을 포함하지 않습니다. |
| `<verify>` | 태스크가 성공했음을 증명하는 실행 가능한 명령 또는 확인. 통과와 실패를 구분해야 합니다 — `echo "done"`은 유효하지 않습니다. |
| `<acceptance_criteria>` | 검증 가능한 조건: grep으로 검증 가능한 문자열, 명령 종료 코드, 관찰 가능한 동작. 주관적 표현 없음 ("올바르게 보임", "올바르게 구성됨"). |
| `<done>` | 완료된 결과에 대한 짧은 측정 가능한 설명. |

---

## 플랜 품질 차원

`gsd-plan-checker` 에이전트는 실행 시작 전에 12개 차원에 걸쳐 모든 PLAN.md를 검토합니다. BLOCKER 심각도 확인에 실패한 플랜은 수정을 위해 `gsd-planner`에 반환됩니다(최대 3회 반복):

| 차원 | 확인 내용 |
|---|---|
| **1 — 요구사항 커버리지** | ROADMAP.md의 모든 페이즈 요구사항 ID가 적어도 하나의 플랜의 `requirements` 프론트매터 필드에 나타나고 해당 태스크가 있는지. |
| **2 — 태스크 완전성** | 모든 `auto` 태스크에 필수 필드(`<files>`, `<action>`, `<verify>`, `<acceptance_criteria>`, `<done>`)가 있는지. 모호하거나 빈 필드 없음. |
| **3 — 의존성 정확성** | `depends_on` 참조가 유효하고 비순환적이며 웨이브 번호와 일관성이 있는지. 웨이브 N 플랜은 웨이브 < N의 플랜에만 의존합니다. |
| **4 — 키 링크 계획됨** | `must_haves.key_links`의 아티팩트에 배선을 구현하는 해당 태스크가 있는지 — 아티팩트 생성만이 아닌. |
| **5 — 범위 건전성** | 플랜이 컨텍스트 예산 내에 있는지: 플랜당 2–3개 태스크(4개 = 경고, 5개 이상 = BLOCKER), 플랜당 파일 ≤ 8–10개(15개 이상 = BLOCKER). |
| **6 — 검증 도출** | `must_haves.truths`가 구현 세부 사항이 아닌 사용자 관찰 가능한 동작인지. 아티팩트가 truths에 매핑되는지. 키 링크가 중요한 배선을 커버하는지. |
| **7 — 컨텍스트 준수** | CONTEXT.md의 모든 `D-NN` 결정이 적어도 하나의 태스크에서 다루어지는지. 어떤 태스크도 `<deferred>`의 것을 구현하지 않는지. |
| **7b — 범위 축소 감지** | 태스크 액션이 전체 결정 범위를 전달하지 않고 잠긴 결정을 조용히 "v1", "스텁", 또는 "향후 개선"으로 축소하지 않는지. 발견 시 항상 BLOCKER. |
| **7c — 아키텍처 계층 준수** | 태스크가 RESEARCH.md 아키텍처 책임 맵에 따라 올바른 계층에 기능을 할당하는지 (있는 경우). 잘못된 계층의 보안 민감 기능은 BLOCKER. |
| **8 — Nyquist 준수** | `workflow.nyquist_validation`이 활성화되고 RESEARCH.md가 있는 경우, 모든 태스크에 `<automated>` 검증 명령이 있고, 3개 태스크의 연속 구간이 커버리지 없이 없으며, VALIDATION.md가 있는지. |
| **9 — 크로스 플랜 데이터 계약** | 플랜이 데이터 파이프라인을 공유하는 경우, 변환이 호환 가능한지 — 어떤 플랜도 다른 플랜이 원본 형식으로 필요한 데이터를 제거하지 않는지. |
| **10 — CLAUDE.md 준수** | 플랜이 `./CLAUDE.md`의 프로젝트별 규칙, 금지된 패턴, 필수 도구, 보안 요구사항을 존중하는지. |
| **11 — 리서치 해결** | RESEARCH.md가 있는 경우, 플래닝이 진행되기 전에 `## Open Questions` 섹션이 `(RESOLVED)`로 표시되어 있는지. |
| **12 — 패턴 준수** | PATTERNS.md가 있는 경우, 태스크가 각 새로운 또는 수정된 파일에 대해 올바른 유사 패턴을 참조하는지. |

---

## 웨이브 실행 모델

웨이브 번호는 플래닝 중에 미리 계산됩니다. Execute-phase는 플랜을 웨이브 번호별로 그룹화하고 각 웨이브의 플랜을 병렬로 실행합니다:

```
Wave 1: Plan 01, Plan 02, Plan 03  (모두 동시에 실행 — 의존성 없음)
Wave 2: Plan 04                    (Wave 1이 완료될 때까지 대기)
Wave 3: Plan 05                    (Wave 2가 완료될 때까지 대기)
```

동일한 웨이브 내에서 겹치는 파일을 수정하는 플랜은 동일한 웨이브에 있어서는 안 됩니다 — 플랜 체커의 Dimension 3이 이를 BLOCKER로 플래그합니다.

---

## 플랜 출력

플랜이 성공적으로 실행된 후, 실행기는 다음 위치에 SUMMARY.md를 작성합니다:

```
.planning/phases/<NN>-<slug>/<NN>-<PP>-SUMMARY.md
```

SUMMARY.md는 빌드된 내용의 표준 기록입니다. 동일 페이즈의 후속 플랜은 타입이나 결정에 대한 실질적인 의존성이 있는 경우 이를 참조할 수 있습니다.

---

## Related

- [CONTEXT.md 스키마](context-md.md)
- [Planning artifacts](planning-artifacts.md)
- [Features](../../FEATURES.md)
- [docs index](../../README.md)
