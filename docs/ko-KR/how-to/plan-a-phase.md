# 페이즈를 기획하는 방법

**목표:** 페이즈 결정 사항과 리서치를 실행 준비가 된 원자적이고 검증 가능한 태스크 계획으로 변환합니다.

**전제 조건:** `.planning/ROADMAP.md`가 존재해야 합니다. `/gsd-discuss-phase`에서 생성된 `{phase}-CONTEXT.md`를 강력히 권장하지만 필수는 아닙니다.

---

## 표준 기획 흐름 실행

```bash
/gsd-plan-phase 2
```

다음 세 단계를 순서대로 실행합니다:

1. **리서치** — `gsd-phase-researcher` 서브에이전트가 도메인을 조사하고 `{phase}-RESEARCH.md`를 작성합니다.
2. **기획** — `gsd-planner` 서브에이전트가 컨텍스트, 리서치, 요구 사항을 읽고 하나 이상의 `{phase}-{N}-PLAN.md` 파일을 작성합니다.
3. **검증** — `gsd-plan-checker` 서브에이전트가 8개 차원에서 계획 품질을 검증하고 품질 게이트를 통과할 때까지 최대 3회의 수정 루프를 실행합니다.

페이즈 번호가 없으면 GSD Core는 로드맵에서 다음 미기획 페이즈를 대상으로 합니다.

---

## 리서치 건너뛰기 또는 강제 실행

**도메인이 익숙하고 새 리서치가 필요 없는 경우:**

```bash
/gsd-plan-phase 3 --skip-research
```

**RESEARCH.md가 이미 존재하지만 강제로 새로 고침하려는 경우:**

```bash
/gsd-plan-phase 3 --research
```

**리서치만 실행하려는 경우** — RESEARCH.md를 작성하고 기획 전 종료:

```bash
/gsd-plan-phase --research-phase 4
```

RESEARCH.md가 이미 존재하면 업데이트, 보기, 또는 건너뛰기 프롬프트가 표시됩니다. 프롬프트 없이 강제 새로 고침하려면:

```bash
/gsd-plan-phase --research-phase 4 --research
```

리서처를 실행하지 않고 기존 RESEARCH.md를 표준 출력으로 출력하려면:

```bash
/gsd-plan-phase --research-phase 4 --view
```

참고: `--research-phase <N>`은 `/gsd-plan-phase`의 플래그입니다. 독립형 리서치 페이즈 명령은 없습니다. 이전의 독립형 리서치 명령은 이 플래그로 대체되었습니다.

---

## 수평 계층 대신 수직 기능 슬라이스로 기획

**기술 계층별이 아닌 기능별 얇은 종단 슬라이스**(UI → API → DB)로 태스크를 구성하려면:

```bash
/gsd-plan-phase 1 --mvp
```

이전 페이즈 요약이 없는 새 프로젝트의 페이즈 1에서 `--mvp`는 프로젝트 스캐폴드, 라우팅, 실제 DB 읽기/쓰기 하나, 실제 UI 인터랙션 하나, 개발 배포를 다루는 `SKELETON.md`도 생성합니다.

플래그 없이 페이즈에 MVP 모드를 지속하려면 ROADMAP.md의 해당 페이즈 항목에 `**Mode:** mvp`를 추가하세요.

---

## 동작 추가 태스크마다 실패하는 테스트 요구

**TDD 적용을 원하는 경우** — 각 동작 추가 태스크는 구현 전 실패하는 테스트로 시작합니다:

```bash
/gsd-plan-phase 1 --tdd
```

`--mvp`와 조합 가능:

```bash
/gsd-plan-phase 1 --mvp --tdd
```

모든 동작 추가 태스크가 RED → GREEN → REFACTOR를 따르는 수직 슬라이스를 생성합니다. 플래너는 적합한 태스크(비즈니스 로직, API 엔드포인트, 데이터 변환)에 `type: tdd`를 적용하고 UI, 설정, 연결 코드에는 표준 `type: execute`를 사용합니다.

TDD 모드는 설정에서도 지속할 수 있습니다:

```bash
node gsd-tools.cjs config-set workflow.tdd_mode true
```

---

## 크로스 AI 리뷰 피드백으로 재기획

**`/gsd-review --phase N`을 실행하여 `REVIEWS.md`가 존재하는 경우:**

```bash
/gsd-plan-phase 3 --reviews
```

플래너는 `REVIEWS.md`를 읽고 피드백을 반영하여 계획을 수정합니다. `--gaps`와 함께 사용할 수 없습니다.

**자동화된 루프를 원하는 경우** — HIGH 우려 사항이 남지 않을 때까지 재기획 및 재검토:

```bash
/gsd-plan-review-convergence 3
```

수렴 루프는 plan → review → replan → re-review 사이클을 기본 최대 3회 실행합니다. 상한선을 변경하려면 `--max-cycles N`을 사용하세요.

---

## 실패한 검증 후 갭 해소

**`VERIFICATION.md`에 미해결 갭이 있고 해당 갭만을 대상으로 재기획하려는 경우:**

```bash
/gsd-plan-phase 3 --gaps
```

리서치는 건너뛰고 플래너는 검증 갭을 직접 읽습니다.

---

## 기획 후 외부 바운스 검증 실행

**`workflow.plan_bounce_script`가 설정되어 있고 완성된 계획의 외부 검증을 원하는 경우:**

```bash
/gsd-plan-phase 1 --bounce
```

설정에 바운스가 활성화된 경우에도 건너뛰려면:

```bash
/gsd-plan-phase 1 --skip-bounce
```

---

## 대화형 확인 억제

```bash
/gsd-plan-phase --auto
```

모든 프롬프트를 건너뜁니다. 자동화 파이프라인에 유용합니다. 설정에서 `research_enabled`가 false인 경우 리서치는 건너뜁니다.

---

## 기획 결과물

성공적인 실행은 다음 파일을 생성합니다:

| 파일 | 목적 |
|---|---|
| `{phase}-RESEARCH.md` | 도메인 리서치, 패키지 적법성 감사, 검증 아키텍처 |
| `{phase}-VALIDATION.md` | Nyquist 테스트 매핑 — 계획이 충족해야 할 테스트 케이스 (차원 8) |
| `{phase}-{N}-PLAN.md` | frontmatter, 웨이브 할당, 인수 기준이 포함된 실행 가능한 태스크 계획 |
| `{phase}/SKELETON.md` | 워킹 스켈레톤 (MVP 모드, 새 프로젝트의 페이즈 1에만 해당) |

각 PLAN.md에는 필수 `<read_first>` 및 `<acceptance_criteria>` 필드가 있는 태스크가 포함됩니다. 모든 `<acceptance_criteria>` 항목은 소스 단언, 동작 단언, 테스트 명령, CLI 출력으로 검증 가능합니다. 주관적 표현은 허용되지 않습니다.

전체 필드 참조는 [PLAN.md 스키마](../reference/plan-md.md)를 참고하세요.

### 계획 품질 차원

`gsd-plan-checker`는 실행을 허용하기 전에 8개 차원에서 계획을 검증합니다:

1. 태스크 원자성 — 각 태스크는 단일 관심사
2. 의존성 정확성 — 웨이브 순서가 일관됨
3. 인수 기준 검증 가능성 — 주관적 기준 없음
4. `<read_first>` 완전성 — 수정 중인 파일이 항상 나열됨
5. 구체적인 `<action>` 값 — "~에 맞춰 정렬" 같은 모호한 지시 없음
6. 페이즈 목표에서 파생된 `must_haves`
7. 요구 사항 ID 커버리지 — 모든 페이즈 요구 사항 ID가 최소 하나의 계획에 나타남
8. Nyquist 테스트 매핑 — 계획이 VALIDATION.md의 검증 전략을 다룸

수정 루프는 최대 3회 실행됩니다. 3회 반복 후에도 품질 게이트를 통과하지 못하면 체커가 남은 문제를 수동 검토를 위해 표시합니다.

---

## 닫힌 페이즈 재기획

`status: passed`가 있는 `VERIFICATION.md`가 있는 페이즈는 닫힌 것으로 간주됩니다. 재기획을 시도하면 오류로 중단됩니다. 종료가 잘못된 경우 `--force`로 재정의하세요:

```bash
/gsd-plan-phase 2 --force
```

트랜스크립트와 커밋된 계획 문서에 경고가 기록됩니다.

---

## 관련 문서

- [페이즈 논의](discuss-a-phase.md)
- [페이즈 실행](execute-a-phase.md)
- [PLAN.md 스키마](../reference/plan-md.md)
- [명령어 참조](../COMMANDS.md)
