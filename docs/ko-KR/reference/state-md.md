# STATE.md 스키마 참조

`STATE.md`는 GSD Core의 살아있는 프로젝트 메모리 파일입니다 — 프로젝트의 현재 상태, 최근 작업 내역, 그리고 다음에 실행할 명령을 기록하는 단일 Markdown 문서입니다. 이 페이지는 해당 파일의 구조를 설명합니다. [문서 인덱스](../../README.md)를 참조하세요.

---

## 개요

GSD Core가 관리하는 모든 프로젝트는 `.planning/STATE.md`에 하나의 `STATE.md`를 유지합니다. 이 파일은 모든 워크플로 시작 시 읽히고 중요한 작업 이후에 기록됩니다. 파일은 다음 두 부분으로 구성됩니다:

- **YAML 프론트매터** — 상태 표시줄 훅(`parseStateMd`)과 `gsd-tools state` 명령이 사용하는 기계가 읽을 수 있는 필드.
- **Markdown 본문** — 현재 위치, 누적된 맥락, 세션 연속성, 성능 지표를 다루는 사람이 읽을 수 있는 섹션.

파일은 의도적으로 작게 유지됩니다(목표: 100줄 미만). 이 파일은 프로젝트 상태의 요약이며 아카이브가 아닙니다.

---

## YAML 프론트매터

프론트매터는 파일 맨 처음의 `---` 구분자 사이에 위치합니다. `gsd_state_version`과 `status`를 제외한 모든 필드는 선택 사항이며, 데이터를 아직 사용할 수 없는 경우 필드가 없을 수 있습니다.

### 주석이 달린 예시

```yaml
---
gsd_state_version: '1.0'
milestone: v2.0
milestone_name: Code Quality
status: executing

# 페이즈 생명주기 필드 — 모두 선택 사항 (v1.40.0에서 추가, issue #2833)
active_phase: "4.5"
next_action: execute-phase
next_phases: ["4.5"]

progress:
  total_phases: 17
  completed_phases: 10
  total_plans: 84
  completed_plans: 47
  percent: 59

# syncStateFrontmatter가 기록하는 추가 필드
current_phase: "4"
current_phase_name: Observability
current_plan: "3"
last_updated: "2026-06-01T12:34:56.789Z"
state_head: 4f3c2b1a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b
last_activity: "2026-06-01"
stopped_at: "Phase 4 P3 execution complete"
paused_at: null
---
```

### 필드 참조

| 필드 | 타입 | 채워지는 시점 | 목적 |
|---|---|---|---|
| `gsd_state_version` | string (`'1.0'`) | 항상 | 스키마 버전. `syncStateFrontmatter`에 의한 첫 번째 `state.*` 호출 시 기록됩니다. |
| `milestone` | string (예: `v2.0`) | 마일스톤이 구성된 경우 | 프로젝트 설정에서 읽어온 현재 마일스톤 버전. |
| `milestone_name` | string | 마일스톤이 구성된 경우 | 사람이 읽을 수 있는 마일스톤 레이블 (예: `Code Quality`). |
| `status` | string | 항상 | 현재 생명주기 단계. `normalizeStateStatus()`에 의해 정규화됩니다 — [상태 값](#상태-값)을 참조하세요. |
| `active_phase` | string (예: `"4.5"`) | 오케스트레이터 명령이 해당 페이즈에서 실행 중인 경우 | 현재 처리 중인 페이즈 번호. 페이즈 사이에 있을 때는 `null`로 설정됩니다. |
| `next_action` | string | 권장 명령이 있는 유휴 상태일 때 | 다음에 실행할 슬래시 명령: `discuss-phase`, `plan-phase`, `execute-phase`, 또는 `verify-phase`. 오케스트레이터가 실행 중이거나 권장 사항이 없을 때는 `null`로 설정됩니다. |
| `next_phases` | YAML 플로우 배열 (예: `["4.5"]`) | `next_action`과 함께 | `next_action`이 적용되는 페이즈 ID (보통 1–2개 항목). `next_action`과 동일한 조건에서 `null`로 설정됩니다. |
| `progress.total_phases` | integer | 페이즈 데이터를 사용할 수 있는 경우 | ROADMAP.md와 phases 디렉터리에서 파생된 현재 마일스톤의 총 페이즈 수. |
| `progress.completed_phases` | integer | 페이즈 데이터를 사용할 수 있는 경우 | 모든 플랜 요약이 디스크에 존재하는(즉, 모든 플랜이 완료된) 페이즈의 수. |
| `progress.total_plans` | integer | 플랜 파일이 존재하는 경우 | 현재 마일스톤 내 모든 페이즈의 플랜 파일 합계. |
| `progress.completed_plans` | integer | 요약 파일이 존재하는 경우 | 완료된 플랜 요약의 합계 (실행된 플랜당 하나의 SUMMARY.md). |
| `progress.percent` | integer 0–100 | 진행 데이터를 사용할 수 있는 경우 | **페이즈 차원**의 마일스톤 진행도 (`min(completed_plans/total_plans, completed_phases/total_phases)`). 상태 표시줄 진행 막대는 이 필드가 있을 때만 렌더링됩니다 — 필드가 없으면 막대가 표시되지 않습니다. |
| `current_phase` | string | 페이즈가 실행 중인 경우 | 본문 `Current Phase:` 필드에서 추출된 페이즈 번호. |
| `current_phase_name` | string | 페이즈에 이름이 있는 경우 | 본문 `Current Phase Name:` 필드에서 추출된 페이즈 이름. |
| `current_plan` | string | 플랜이 진행 중인 경우 | 본문 `Current Plan:` 필드에서 추출된 플랜 번호. |
| `last_updated` | ISO-8601 타임스탬프 | 항상 (쓰기 시) | 마지막 `syncStateFrontmatter` 호출의 타임스탬프. `realClock.nowIso()`에 의해 기록됩니다. |
| `state_head` | string (40-char sha) | On write, when the project's own git repo resolves | Full commit sha STATE.md was written against (#2573). Omitted entirely outside a git repo, or when the resolved repo is not the project's own — an unverifiable stamp degrades to absent rather than asserting provenance the file does not have. Recomputed on every write and never carried forward. |
| `last_activity` | string | 본문에 설정된 경우 | 본문 `Last Activity:` 필드에서 추출된 마지막 활동 날짜. |
| `stopped_at` | string | 중단점이 기록된 경우 | 마지막으로 완료된 작업의 설명. 아카이브 산문과의 매칭을 피하기 위해 `## Session` 본문 섹션으로 범위가 제한됩니다. |
| `paused_at` | string | 프로젝트가 일시 정지된 경우 | 일시 정지 지점에 대한 자유형 설명. 일시 정지 상태가 아닐 때는 없거나 `null`. |

### 상태 값

`gsd-core/bin/lib/state-document.cjs`의 `normalizeStateStatus()`는 본문의 원시 텍스트를 다음 표준 값으로 매핑합니다:

| 표준 값 | 매칭되는 텍스트 (대소문자 무관) |
|---|---|
| `discussing` | `discussing`을 포함 |
| `planning` | `planning` 또는 `ready to plan`을 포함 |
| `executing` | `executing`, `in progress`, 또는 `ready to execute`를 포함 |
| `verifying` | `verif`를 포함 |
| `completed` | `complete` 또는 `done`을 포함 |
| `paused` | `paused` 또는 `stopped`를 포함하거나, `paused_at`이 있는 경우 |
| `unknown` | 위 중 해당 없음 |

오케스트레이터 명령이 실행 중일 때의 규칙 (issue #2833)은 생명주기 단계를 `status`에 직접 기록하는 것입니다:

| 명령 | 실행 중 `status` |
|---|---|
| `/gsd-discuss-phase` | `discussing` |
| `/gsd-plan-phase` | `planning` |
| `/gsd-execute-phase` | `executing` |
| `/gsd-verify-work` | `verifying` |

---

## 상태 표시줄 렌더링 장면

`hooks/gsd-statusline.js`의 `formatGsdState()`는 파싱된 프론트매터를 읽고 **첫 번째로 일치하는 장면**을 출력합니다. 새로운 생명주기 필드가 적용되지 않으면 렌더링은 v1.38.x와 바이트 단위로 동일한 원래 형식으로 폴백됩니다.

| 장면 | 트리거 | 표시 예시 |
|---|---|---|
| **1. 페이즈 활성화** | `active_phase`가 채워진 경우 | `v2.0 [██░░░░░░░░] 20% · Phase 4.5 executing` |
| **2. 유휴 상태, 다음 권장** | `active_phase`가 null이고 `next_action`과 `next_phases`가 모두 채워진 경우 | `v2.0 [██░░░░░░░░] 20% · next execute-phase 4.5` |
| **3. 마일스톤 완료** | `percent`가 `100`이거나 `completed_phases == total_phases`인 경우 | `v2.0 [██████████] 100% · milestone complete` |
| **4. 기본 폴백** | 위 중 해당 없음 | `v1.9 Code Quality · executing · ph 1/5` (기존 형식) |

**장면 우선순위:** `active_phase`와 `next_action`이 모두 채워진 경우 장면 1이 우선합니다 — 오케스트레이터가 실행 중이므로 "다음 권장 사항"은 오해의 소지가 있습니다. 이 우선순위는 `formatGsdState()`의 확인 순서로 강제되며 `tests/gsd-statusline.test.cjs`의 `"scene priority"` 스위트에서 테스트됩니다.

진행 막대(`[██░░░░░░░░] 20%`)는 프론트매터에 `progress.percent`가 있을 때만 마일스톤 세그먼트에 추가됩니다. 없으면 막대가 표시되지 않습니다.

---

## 프론트매터 파싱 제약 사항

상태 표시줄 훅은 정규식 기반 파싱을 사용합니다(YAML 라이브러리 없음). 따라서 다음 제약 사항이 적용됩니다. 이는 `tests/gsd-statusline.test.cjs`에서 테스트됩니다.

1. **프론트매터는 파일의 맨 첫 번째 문자에서 시작해야 합니다.** 주석을 포함한 어떤 것이든 여는 `---` 위에 있으면 매칭이 무효화됩니다. 여는 `---` 줄은 정확히 그것이어야 하며, 후행 공백이 없어야 합니다.

2. **중첩 블록 내의 주석은 지원되지 않습니다.** `progress:` 블록 파서는 다음 줄이 `[ \t]+\w+:`여야 합니다. `progress:`와 첫 번째 키 사이에 `# comment`를 삽입하면 매칭이 깨지고 막대가 사라집니다. 모든 문서는 프론트매터 블록이 아닌 `STATE.md` 본문에 있어야 합니다.

3. **`next_phases`의 기본 형식은 단일 행 플로우입니다.** 파서는 먼저 `next_phases: ["4.5", "4.6"]`을 시도합니다. 블록 시퀀스(`- 4.5\n- 4.6`)도 파싱되지만 상태 표시줄 렌더링에서는 덜 안정적입니다. 정규식 기반 파서를 예측 가능하게 유지하기 위해 `next_phases`에는 단일 행 플로우를 선호하세요. 문서화 목적으로 많은 후보 페이즈를 기록해야 하는 경우, `STATE.md` 본문에 저장하세요.

향후 변경으로 정규식 파서를 완전한 YAML 라이브러리로 교체하면 이 제약 사항을 완화하고 테스트를 업데이트할 수 있습니다.

---

## Markdown 본문 섹션

본문(닫는 `---` 이후의 모든 것)은 `gsd-core/templates/state.md`의 템플릿을 따릅니다. 표준 섹션은 다음과 같습니다:

### Project Reference

`.planning/PROJECT.md`를 가리킵니다. 다음을 포함합니다:
- **핵심 가치** — `PROJECT.md`의 Core Value 섹션에서 가져온 한 줄짜리 설명.
- **현재 포커스** — 어떤 페이즈가 활성화되어 있는지.

### Current Position

프로젝트의 현재 위치:

| 필드 | 형식 |
|---|---|
| `Phase:` | `X of Y (Phase name)` |
| `Plan:` | `A of B in current phase` |
| `Status:` | 자유 텍스트, 예: `Ready to execute`, `Executing Phase 4`, `Phase complete — ready for verification` |
| `Last activity:` | 핸들러가 기록할 때 ISO 날짜(`YYYY-MM-DD`); 실행기가 작성할 때 서술형 산문 |
| `Progress:` | 시각적 막대, 예: `[████░░░░░░] 40%` |

이 섹션의 `Status:` 및 `Last activity:` 필드는 기존 값이 알려진 템플릿 기본값인 경우 GSD 핸들러에 의해 업데이트됩니다(크누스 불변량: 실행기가 작성한 값은 보존됩니다). 알려진 핸들러 기본값의 전체 목록은 `gsd-core/bin/lib/state-document.cjs`의 `KNOWN_TEMPLATE_DEFAULTS`에 있습니다.

### Performance Metrics

실행 속도 추적:
- 완료된 총 플랜 수, 플랜당 평균 소요 시간.
- 페이즈별 분석 표(`Phase | Plans | Total | Avg/Plan`).
- 최근 추세: Improving / Stable / Degrading.

각 플랜 완료 후 업데이트됩니다.

### Accumulated Context

**Decisions** — 현재 작업에 영향을 미치는 최근 결정 사항 요약(전체 로그는 `PROJECT.md`에 있음). `gsd-tools state add-decision`을 통해 추가됩니다.

**Pending Todos** — 개수 및 `.planning/todos/pending/`에 대한 참조. `/gsd-capture`를 통해 캡처됩니다.

**Blockers/Concerns** — 미래 작업에 영향을 미치는 문제, 발생한 페이즈 접두사 포함. `gsd-tools state add-blocker`를 통해 추가되고, `gsd-tools state resolve-blocker`를 통해 해결됩니다.

### Session Continuity

즉각적인 세션 재개를 가능하게 합니다:
- `Last session:` — 마지막 세션의 ISO-8601 타임스탬프.
- `Stopped at:` — 마지막으로 완료된 작업의 설명.
- `Resume file:` — `.continue-here*.md` 파일이 있으면 해당 경로, 없으면 `None`.

---

## 하위 호환성

페이즈 생명주기 필드(`active_phase`, `next_action`, `next_phases`, 막대를 위한 `progress.percent`)는 **추가적이며 프로젝트별로 선택 사항**입니다:

- 생명주기 필드가 하나도 채워지지 않은 `STATE.md`는 v1.38.x 및 이전 버전과 **바이트 단위로 동일하게** 렌더링됩니다.
- 생명주기 필드 추가는 선택 사항입니다 — 렌더러는 필드가 없을 때 우아하게 저하됩니다.
- 진행 막대는 `progress` 블록이 있어도 선택 사항입니다: `progress.percent`만 막대를 트리거하고, `total_phases`와 `completed_phases`만으로는 트리거되지 않습니다.

`tests/gsd-statusline.test.cjs`의 `formatGsdState #2833 backward compatibility` 테스트 스위트는 이 보장을 고정합니다. 레거시 `STATE.md` 렌더링을 깨는 변경 사항은 스위트에서 실패합니다.

---

## Related

- [Planning artifacts](planning-artifacts.md)
- [Configuration](../../CONFIGURATION.md)
- [The phase loop](../../explanation/the-phase-loop.md)
- [docs index](../../README.md)
