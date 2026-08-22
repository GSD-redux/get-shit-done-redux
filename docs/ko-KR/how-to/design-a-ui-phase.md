# UI 페이즈를 디자인하는 방법

**목표:** 플래너가 작업을 작성하기 전에 간격, 색상, 타이포그래피, 카피라이팅 결정을 확정하는 잠긴 UI 디자인 계약(`UI-SPEC.md`)을 생성하여 실행 중 임의적인 스타일링 선택으로 인한 시각적 불일관성을 방지합니다.

**사전 조건:** `.planning/ROADMAP.md`가 존재해야 합니다. 페이즈에 프론트엔드 또는 UI 작업이 있어야 합니다. 먼저 `/gsd-discuss-phase N`을 실행하는 것을 강력히 권장합니다 — UI 연구자는 `CONTEXT.md`를 읽어 이미 결정된 사항을 다시 묻지 않습니다.

---

## 이 페이즈에 UI 계약이 필요한지 결정

모든 페이즈가 `/gsd-ui-phase`를 필요로 하지는 않습니다. 다음 경우에 사용합니다:

- 페이즈가 새로운 UI 표면(페이지, 흐름, 레이아웃)을 도입할 때
- 여러 컴포넌트를 빌드하며 시각적 일관성이 중요할 때
- 새 프로젝트의 프론트엔드를 시작하며 디자인 시스템 기준선이 필요할 때
- 기존 프로젝트에 중요한 UI 작업을 추가하면서 실행 전에 토큰, 간격, 색상을 확정하고 싶을 때

다음 경우에 건너뜁니다:

- 페이즈가 순전히 백엔드, 인프라, 또는 사용자 대면 출력이 없는 데이터 작업일 때
- 이전 페이즈에서 이미 `UI-SPEC.md`가 존재하고 이 페이즈가 새로운 표면을 도입하지 않고 동일한 시각적 패턴 위에 빌드될 때

확신이 없으면 안전 게이트가 프롬프트를 표시합니다: `workflow.ui_safety_gate`가 활성화된 경우(기본값), `/gsd-plan-phase`는 프론트엔드 작업을 감지했지만 `UI-SPEC.md`가 없을 때 경고하고 먼저 `/gsd-ui-phase`를 실행할지 물어봅니다.

---

## UI 디자인 계약 실행

```bash
/gsd-ui-phase 2
```

페이즈 번호가 지정되지 않으면 GSD Core는 현재 페이즈를 대상으로 합니다.

명령은 두 단계로 실행됩니다:

1. **`gsd-ui-researcher`** — `CONTEXT.md`, `RESEARCH.md`, `REQUIREMENTS.md`에서 기존 결정을 읽고, 디자인 시스템 상태(shadcn `components.json`, Tailwind 설정, 기존 토큰)를 감지하며, 간격, 색상, 타이포그래피, 카피라이팅, 레지스트리 안전성 다섯 영역에 걸쳐 답하지 않은 디자인 질문만 묻습니다.
2. **`gsd-ui-checker`** — 결과로 생성된 `UI-SPEC.md`를 일곱 가지 차원에서 검증합니다. 문제가 발견되면 수정 루프가 플래그된 항목만을 대상으로 연구자를 다시 실행합니다(최대 두 번 반복).

**출력:** `.planning/phases/{phase-dir}/`의 `{padded_phase}-UI-SPEC.md`.

---

## UI-SPEC의 적용 범위

연구자는 다섯 영역에 걸쳐 결정을 확정합니다:

| 영역 | 예시 |
|---|---|
| **간격** | 기본 스케일(4px 또는 8px), 그리드 정렬, 컴포넌트 패딩 |
| **색상** | 기본, 강조, 중립 팔레트; 60/30/10 규칙; 다크 모드 고려 사항 |
| **타이포그래피** | 폰트 패밀리, 크기/굵기 스케일 제약, 제목 계층 구조 |
| **카피라이팅** | CTA 레이블, 빈 상태 메시지, 오류 상태 복사, 로딩 인디케이터 |
| **레지스트리 안전성** | shadcn 컴포넌트 검사 프로토콜(아래 참조) |

체커는 일곱 가지 차원(카피라이팅, 시각적, 색상, 타이포그래피, 간격, 레지스트리 안전, 인벤토리 출처)에 대해 스펙을 검증하며 각 차원마다 PASS, FLAG 또는 BLOCK을 반환합니다. (1~4점으로 채점하는 6가지 기둥 루브릭은 이 체커가 아니라 `/gsd-ui-review`의 소급 감사에 속합니다.)

---

## shadcn 초기화

React, Next.js, Vite 프로젝트에서 `components.json`이 없으면 연구자가 shadcn 초기화를 제안합니다. 흐름:

1. `ui.shadcn.com/create`를 방문하여 프리셋(색상, 테두리 반경, 폰트) 구성
2. 프리셋 문자열 복사
3. 실행:

```bash
npx shadcn init --preset <paste>
```

프리셋 문자열은 페이즈와 마일스톤 간에 재현 가능한 GSD Core 계획 아티팩트가 됩니다.

---

## 레지스트리 안전 게이트

서드파티 shadcn 레지스트리는 임의 코드를 주입할 수 있습니다. `workflow.ui_safety_gate`가 활성화된 경우(기본값), 스펙은 비공식 컴포넌트를 설치하기 전에 다음 단계를 요구합니다:

```bash
npx shadcn view <component>   # 설치 전 소스 검사
npx shadcn diff <component>   # 공식 레지스트리와 비교
```

레지스트리 안전성이 처리되지 않으면 체커가 스펙을 BLOCKED로 표시합니다. 프로젝트에서 shadcn을 사용하지 않거나 대체 검토 프로세스가 있는 경우 `/gsd-settings`를 통해 게이트를 비활성화합니다.

---

## 스케치 결과를 초안으로 활용

이미 `/gsd-sketch --wrap-up`을 실행한 경우, UI 연구자는 `.claude/skills/sketch-findings-[project]/`를 자동으로 로드합니다. 사전 검증된 결정(레이아웃, 팔레트, 타이포그래피, 간격)은 확정된 것으로 처리됩니다 — 연구자가 다시 묻지 않습니다. 실행 시작 시 메모가 표시됩니다:

```text
⚡ Sketch findings detected: .claude/skills/sketch-findings-[project]/SKILL.md
   Pre-validated decisions (layout, palette, typography, spacing) should be treated
   as locked — not re-asked.
```

`/gsd-ui-phase` 전에 `/gsd-sketch --wrap-up`을 실행하는 주된 이유입니다: 대화식 디자인 탐색을 계약 입력으로 바인딩합니다.

---

## `/gsd-ui-review`로 소급 시각적 감사

`/gsd-ui-review`는 실행 전이 아닌 실행 후에 실행됩니다. UI-SPEC(또는 스펙이 없을 때는 추상적인 6가지 기둥 기준)에 대해 구현된 프론트엔드를 감사하는 데 사용합니다.

```bash
/gsd-ui-review        # 현재 페이즈 감사
/gsd-ui-review 3      # 특정 페이즈 3 감사
```

프론트엔드 코드가 있는 모든 프로젝트에서 작동합니다 — GSD 프로젝트 초기화가 필요하지 않습니다.

**검사 항목(6가지 기둥, 각 1~4점 채점):**

1. 카피라이팅 — CTA 레이블, 빈 상태, 오류 상태
2. 시각적 — 초점, 시각적 계층 구조, 아이콘 접근성
3. 색상 — 강조 사용 규율, 60/30/10 준수
4. 타이포그래피 — 폰트 크기와 굵기 제약 준수
5. 간격 — 그리드 정렬, 토큰 일관성
6. 경험 디자인 — 로딩, 오류, 빈 상태 커버리지

**출력:** 점수와 우선순위 상위 세 가지 수정 사항이 포함된 `{padded_phase}-UI-REVIEW.md`. `gsd-browser`와 같은 브라우저 MCP 서버가 구성된 경우 감사는 시각적 증거와 함께 스크린샷도 캡처합니다.

**스크린샷 저장:** 스크린샷은 `.planning/ui-reviews/`에 저장됩니다. 바이너리 파일이 git에 올라가지 않도록 `.gitignore`가 자동으로 생성됩니다. 스크린샷은 `/gsd-complete-milestone` 중에 정리됩니다.

---

## 페이즈 생명주기에서 권장 위치

```text
/gsd-discuss-phase N      ← 구현 선호도 확정
/gsd-ui-phase N           ← 디자인 계약 확정 (프론트엔드 페이즈)
/gsd-plan-phase N         ← 연구 + 계획 (UI-SPEC.md를 컨텍스트로 읽음)
/gsd-execute-phase N      ← 병렬 실행
/gsd-verify-work N        ← 수동 UAT
/gsd-ui-review N          ← 소급 시각적 감사 (선택 사항이지만 권장)
```

`/gsd-ui-phase`는 토론과 계획 사이에 위치합니다. 플래너가 `UI-SPEC.md`를 디자인 컨텍스트로 읽기 때문입니다 — `PLAN.md`의 작업은 스펙이 확정한 간격 토큰, 색상 변수, 카피라이팅 결정을 참조합니다.

---

## 관련 문서

- [스파이크와 스케치](spike-and-sketch.md)
- [페이즈 계획](plan-a-phase.md)
- [명령 참조](../COMMANDS.md)
- [문서 인덱스](../README.md)
