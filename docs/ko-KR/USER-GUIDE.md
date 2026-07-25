# GSD 사용자 가이드

GSD Core의 설명형 동반 가이드 — 여기서 방향을 잡은 후 전용 문서로 이동하세요.

> **GSD Core의 문서는 [Diataxis](https://diataxis.fr) 방식으로 구성되어 있습니다.**
> 목적별 탐색: [튜토리얼](README.md#tutorials) · [사용 방법 가이드](README.md#how-to-guides) · [레퍼런스](README.md#reference) · [설명](README.md#explanation) · [문서 인덱스](README.md)

---

## 목차

- [슬래시 명령어 형식](#슬래시-명령어-형식-하이픈-vs-콜론)
- [네임스페이스 라우팅 입문](#네임스페이스-라우팅-입문-gsdnamespace-v140)
- [프로젝트 생명주기 개요](#프로젝트-생명주기-개요)
- [워크플로우 다이어그램](#워크플로우-다이어그램)
- [UI 설계 계약](#ui-설계-계약)
- [스파이킹 및 스케칭](#스파이킹--스케칭)
- [백로그 및 스레드](#백로그--스레드)
- [워크스트림 및 워크스페이스](#워크스트림--워크스페이스)
- [보안](#보안)
- [사용 예시](#사용-예시)
- [문제 해결](#문제-해결)
- [복구 빠른 참조](#복구-빠른-참조)
- [프로젝트 파일 구조](#프로젝트-파일-구조)
- [관련 문서](#관련-문서)

GitHub / Linear / Jira 이슈에서 GSD를 직접 구동하는 방법은
[이슈 기반 오케스트레이션](issue-driven-orchestration.md) 가이드를 참조하세요 —
트래커 이슈를 workspace → discuss → plan → execute → verify → review → ship
루프에 매핑하는 레시피이며, 기존 GSD 프리미티브를 활용합니다.

---

## 슬래시 명령어 형식 (하이픈 vs 콜론)

GSD는 지원되는 모든 런타임에 **동일한 스킬 세트**를 제공하지만, 두 가지 슬래시 형식이 존재합니다:

- **하이픈 형식** — `/gsd-command-name` — Claude Code, Copilot, OpenCode, Kilo, Cursor, Windsurf, Augment, Antigravity, Trae에서 사용됩니다.
- **콜론 형식** — `/gsd:command-name` — **Gemini CLI 전용**입니다. Gemini는 모든 플러그인 명령어를 플러그인 ID 아래에 네임스페이스로 묶으므로, `--gemini` 설치 시 설치 경로가 본문 텍스트 참조와 명령어 파일을 모두 콜론 형식으로 재작성합니다.

직접 선택할 필요는 없습니다 — 설치 프로그램이 각 런타임의 명령어 디렉터리에 올바른 형식을 작성합니다. Gemini 터미널에서 안내를 따를 때는 각 슬래시 명령어를 읽을 때 `gsd` 뒤의 하이픈을 콜론으로 대체하세요.

## 네임스페이스 라우팅 입문 (`gsd:<namespace>`, v1.40)

v1.40은 계층적 라우팅의 1단계 진입점으로 여섯 개의 **네임스페이스 메타스킬**을 제공합니다 — 이 스킬들은 열심히 스킬 목록을 나열하는 토큰 비용을 낮게 유지합니다(6개 라우터에 ~120 토큰 vs 86개 스킬 평면 목록에 ~2,150 토큰). 모든 구체적인 서브스킬은 여전히 직접 호출할 수 있습니다. 각 네임스페이스 라우터의 본문에는 사용자의 의도를 올바른 구체적 서브스킬로 매핑하는 라우팅 테이블이 포함되어 있습니다.

| 네임스페이스 | 라우터 | 라우팅 대상 |
|-----------|--------|-----------|
| 단계 파이프라인 | `/gsd-workflow` | discuss / plan / execute / verify / phase / progress |
| 프로젝트 생명주기 | `/gsd-project` | milestones, audits, summary |
| 품질 게이트 | `/gsd-quality` | code review, debug, audit, security, eval, ui |
| 코드베이스 인텔리전스 | `/gsd-context` | map, graphify, docs, learnings |
| 관리 | `/gsd-manage` | config, workspace, workstreams, thread, update, ship, inbox |
| 탐색 및 캡처 | `/gsd-ideate` | explore, sketch, spike, spec, capture |

네임스페이스 라우터를 직접 입력할 필요는 거의 없습니다. 이들의 가치는 모델이 올바른 서브스킬을 찾는 데 사용하는 라우팅 레이어에 있습니다 — 시스템 프롬프트가 86개 대신 6개 항목을 나열할 수 있도록 존재합니다. 구체적인 명령어를 이미 알고 있다면(예: `/gsd-plan-phase`) 직접 호출하세요.

---

## 프로젝트 생명주기 개요

GSD 핵심 루프는 **discuss → plan → execute → verify → ship**이며, 단계별로 반복됩니다. 전체 단계별 안내 — 출력 예시, 생성되는 파일, 사용 가능한 모든 플래그 포함 — 는 전용 튜토리얼에 있습니다.

[첫 번째 프로젝트](tutorials/your-first-project.md)를 참조하세요.

새 마일스톤 시작 전 기존 코드베이스를 온보딩하는 방법은 [기존 코드베이스 온보딩](tutorials/onboarding-an-existing-codebase.md)을 참조하세요.

**한눈에 보는 관련 플래그:**

| 플래그 | 명령어 | 사용 시점 |
| ---- | ------- | ----------- |
| `--auto` | `/gsd-new-project` | 대화형 질문을 건너뛰고 PRD 파일에서 가져오기 |
| `--research` | `/gsd-quick` | 임시 작업에 리서치 에이전트 추가 |
| `--validate` | `/gsd-quick` | 계획 검사 및 실행 후 검증 추가 |
| `--chain` | `/gsd-discuss-phase` | 중단 없이 discuss → plan → execute 자동 연결 |
| `--skip-research` | `/gsd-plan-phase` | 도메인이 이미 익숙할 때 리서치 에이전트 건너뛰기 |
| `--draft` | `/gsd-ship` | 검토 준비 대신 초안 PR 생성 |

모든 플래그가 포함된 전체 명령어 레퍼런스는 [`docs/COMMANDS.md`](COMMANDS.md)를 참조하세요. 구성 옵션(모델 프로필, 워크플로우 에이전트, git 브랜치)은 [`docs/CONFIGURATION.md`](CONFIGURATION.md)를 참조하세요.

---

## 워크플로우 다이어그램

### 전체 프로젝트 생명주기

```text
  ┌──────────────────────────────────────────────────┐
  │                   NEW PROJECT                    │
  │  /gsd-new-project                                │
  │  Questions -> Research -> Requirements -> Roadmap│
  └─────────────────────────┬────────────────────────┘
                            │
             ┌──────────────▼─────────────┐
             │      FOR EACH PHASE:       │
             │                            │
             │  ┌────────────────────┐    │
             │  │ /gsd-discuss-phase │    │  <- Lock in preferences
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-ui-phase      │    │  <- Design contract (frontend)
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-plan-phase    │    │  <- Research + Plan + Verify
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-execute-phase │    │  <- Parallel execution
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-verify-work   │    │  <- Manual UAT
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-ship          │    │  <- Create PR (optional)
             │  └──────────┬─────────┘    │
             │             │              │
             │     Next Phase?────────────┘
             │             │ No
             └─────────────┼──────────────┘
                            │
            ┌───────────────▼──────────────┐
            │  /gsd-audit-milestone        │
            │  /gsd-complete-milestone     │
            └───────────────┬──────────────┘
                            │
                   Another milestone?
                       │          │
                      Yes         No -> Done!
                       │
               ┌───────▼──────────────┐
               │  /gsd-new-milestone  │
               └──────────────────────┘
```

### 계획 에이전트 조정

```text
  /gsd-plan-phase N
         │
         ├── Phase Researcher (x4 parallel)
         │     ├── Stack researcher
         │     ├── Features researcher
         │     ├── Architecture researcher
         │     └── Pitfalls researcher
         │           │
         │     ┌──────▼──────┐
         │     │ RESEARCH.md │
         │     └──────┬──────┘
         │            │
         │     ┌──────▼──────┐
         │     │   Planner   │  <- Reads PROJECT.md, REQUIREMENTS.md,
         │     │             │     CONTEXT.md, RESEARCH.md
         │     └──────┬──────┘
         │            │
         │     ┌──────▼───────────┐     ┌────────┐
         │     │   Plan Checker   │────>│ PASS?  │
         │     └──────────────────┘     └───┬────┘
         │                                  │
         │                             Yes  │  No
         │                              │   │   │
         │                              │   └───┘  (loop, up to 3x)
         │                              │
         │                        ┌─────▼──────┐
         │                        │ PLAN files │
         │                        └────────────┘
         └── Done
```

### 검증 아키텍처 (나이퀴스트 레이어)

계획 단계 리서치 시, GSD는 코드 작성 전에 자동화된 테스트 커버리지를 각 단계 요구사항에 매핑합니다. 리서처는 기존 테스트 인프라를 감지하고, 각 요구사항을 특정 테스트 명령어에 매핑하며, 구현 시작 전에 생성해야 할 테스트 스캐폴딩(Wave 0 작업)을 식별합니다. 계획 검사기는 이를 8번째 검증 차원으로 적용합니다: 작업에 자동화된 검증 명령어가 없는 계획은 승인되지 않습니다.

**출력:** `{phase}-VALIDATION.md` — 단계의 피드백 계약.

**비활성화:** 테스트 인프라가 초점이 아닌 빠른 프로토타이핑 단계에서는 `/gsd-settings`에서 `workflow.nyquist_validation: false`로 설정하세요.

### 소급 검증 (`/gsd-validate-phase`)

나이퀴스트 검증이 생기기 전에 실행된 단계, 또는 전통적인 테스트 슈트만 있는 기존 코드베이스에 대해 소급 감사 및 커버리지 간격을 채우세요:

```text
  /gsd-validate-phase N
         |
         +-- Detect state (VALIDATION.md exists? SUMMARY.md exists?)
         |
         +-- Discover: scan implementation, map requirements to tests
         |
         +-- Analyze gaps: which requirements lack automated verification?
         |
         +-- Present gap plan for approval
         |
         +-- Spawn auditor: generate tests, run, debug (max 3 attempts)
         |
         +-- Update VALIDATION.md
               |
               +-- COMPLIANT -> all requirements have automated checks
               +-- PARTIAL -> some gaps escalated to manual-only
```

감사자는 구현 코드를 수정하지 않으며, 테스트 파일과 VALIDATION.md만 수정합니다. 테스트에서 구현 버그가 발견되면, 처리할 에스컬레이션으로 표시됩니다.

### 가정 논의 모드

기본적으로 `/gsd-discuss-phase`는 구현 선호도에 대한 개방형 질문을 합니다. 가정 모드는 이를 반전합니다: GSD가 먼저 코드베이스를 읽고, 단계 구축 방법에 대한 구조화된 가정을 표시하며, 수정 사항만 요청합니다.

**활성화:** `/gsd-settings`를 통해 `workflow.discuss_mode`를 `'assumptions'`으로 설정하세요.

전체 discuss 모드 레퍼런스는 [docs/workflow-discuss-mode.md](workflow-discuss-mode.md)를 참조하세요.

### 결정 커버리지 게이트

discuss 단계는 `<decisions>` 블록 아래 CONTEXT.md에 구현 결정을 번호 매긴 글머리로 캡처합니다(`- **D-01:** …`). 두 개의 게이트는 해당 결정이 계획과 배포된 코드에 반영되도록 보장합니다.

**계획 단계 번역 게이트 (차단).** 계획 후, GSD는 추적 가능한 모든 결정이 최소한 하나의 계획의 `must_haves`, `truths`, 또는 본문에 나타날 때까지 단계를 계획된 것으로 표시하기를 거부합니다.

**검증 단계 유효성 검사 게이트 (비차단).** 검증 중에 GSD는 추적 가능한 각 결정에 대해 계획, SUMMARY.md, 수정된 파일, 최근 커밋 메시지를 검색합니다. 누락된 항목은 경고 섹션으로 VERIFICATION.md에 기록되며, 검증 상태는 변경되지 않습니다.

**결정 제외.** `<decisions>` 내부의 `### Claude's Discretion` 제목 아래로 이동하거나 태그를 지정하세요: `- **D-08 [informational]:** …`, `- **D-09 [folded]:** …`, `- **D-10 [deferred]:** …`.

**게이트 비활성화.** `.planning/config.json`에서 `workflow.context_coverage_gate: false`로 설정하세요(또는 `/gsd-settings`를 통해). 기본값은 `true`입니다.

### 실행 웨이브 조정

```text
  /gsd-execute-phase N
         │
         ├── Analyze plan dependencies
         │
         ├── Wave 1 (independent plans):
         │     ├── Executor A (fresh 200K context) -> commit
         │     └── Executor B (fresh 200K context) -> commit
         │
         ├── Wave 2 (depends on Wave 1):
         │     └── Executor C (fresh 200K context) -> commit
         │
         └── Verifier
               ├── Check codebase against phase goals
               ├── Test quality audit (disabled tests, circular patterns, assertion strength)
               │
               ├── PASS -> VERIFICATION.md (success)
               └── FAIL -> Issues logged for /gsd-verify-work
```

---

## UI 설계 계약

AI가 생성한 프런트엔드가 시각적으로 일관되지 않은 이유는 Claude Code가 UI에 능숙하지 않아서가 아니라, 실행 전에 설계 계약이 존재하지 않았기 때문입니다. `/gsd-ui-phase`는 계획 전에 설계 계약을 고정하고, `/gsd-ui-review`는 실행 후 결과를 감사합니다.

전체 워크플로우, 구성, shadcn 초기화, 레지스트리 안전 게이트는 [UI 단계 설계](how-to/design-a-ui-phase.md)를 참조하세요.

**빠른 참조:**

| 명령어               | 설명                                                     |
| -------------------- | -------------------------------------------------------- |
| `/gsd-ui-phase [N]`  | 프런트엔드 단계를 위한 UI-SPEC.md 설계 계약 생성         |
| `/gsd-ui-review [N]` | 구현된 UI의 소급 6-기둥 시각 감사                        |

| 설정                      | 기본값  | 설명                                                        |
| ------------------------- | ------- | ----------------------------------------------------------- |
| `workflow.ui_phase`       | `true`  | 프런트엔드 단계를 위한 UI 설계 계약 생성                    |
| `workflow.ui_safety_gate` | `true`  | 계획 단계에서 프런트엔드 단계에 대해 /gsd-ui-phase 실행 유도 |

---

## 스파이킹 및 스케칭

계획 전에 기술적 타당성을 검증하려면 `/gsd-spike`를, 설계 전에 시각적 방향을 탐색하려면 `/gsd-sketch`를 사용하세요. 두 명령어 모두 `.planning/`에 아티팩트를 저장하고 마무리 동반 명령어를 통해 프로젝트 스킬 시스템과 통합됩니다.

전체 워크플로우와 흐름 다이어그램은 [스파이크 및 스케치](how-to/spike-and-sketch.md)를 참조하세요.

**일반적인 흐름:**

```bash
/gsd-spike "SSE vs WebSocket"     # Validate the approach
/gsd-spike --wrap-up              # Package learnings

/gsd-sketch "real-time feed UI"   # Explore the design
/gsd-sketch --wrap-up             # Package decisions

/gsd-discuss-phase N              # Lock in preferences (now informed by spike + sketch)
/gsd-plan-phase N                 # Plan with confidence
```

---

## 백로그 및 스레드

### 백로그 파킹 랏

활성 계획에 준비되지 않은 아이디어는 999.x 번호를 사용하여 백로그에 넣어 활성 단계 순서 외부에 보관합니다.

```bash
/gsd-capture --backlog "GraphQL API layer"     # Creates 999.1-graphql-api-layer/
/gsd-capture --backlog "Mobile responsive"     # Creates 999.2-mobile-responsive/
```

백로그 항목은 전체 단계 디렉터리를 갖추므로, `/gsd-discuss-phase 999.1`로 아이디어를 더 탐색하거나 준비가 되면 `/gsd-plan-phase 999.1`을 사용할 수 있습니다.

**검토 및 승격**은 `/gsd-review-backlog`으로 합니다 — 모든 백로그 항목을 표시하고 승격(활성 순서로 이동), 유지(백로그에 남기기), 제거(삭제) 중 선택할 수 있습니다.

### 씨드

씨드는 트리거 조건이 있는 미래 지향적 아이디어입니다. 백로그 항목과 달리, 씨드는 적절한 마일스톤이 도래하면 자동으로 표시됩니다.

```bash
/gsd-capture --seed "Add real-time collab when WebSocket infra is in place"
```

`/gsd-new-milestone`은 모든 씨드를 스캔하고 매칭 항목을 표시합니다. **저장소:** `.planning/seeds/SEED-NNN-slug.md`

### 지속적 컨텍스트 스레드

스레드는 여러 세션에 걸쳐 있지만 특정 단계에 속하지 않는 작업을 위한 경량 세션 간 지식 저장소입니다.

```bash
/gsd-thread                              # List all threads
/gsd-thread fix-deploy-key-auth          # Resume existing thread
/gsd-thread "Investigate TCP timeout"    # Create new thread
```

스레드가 성숙해지면 단계(`/gsd-phase`) 또는 백로그 항목(`/gsd-capture --backlog`)으로 승격할 수 있습니다. **저장소:** `.planning/threads/{slug}.md`

---

## 워크스트림 및 워크스페이스

워크스트림과 워크스페이스 모두 격리를 제공하지만, 수준이 다릅니다.

**워크스트림**은 동일한 코드베이스와 git 히스토리를 공유하지만 계획 아티팩트를 격리합니다 — 더 가볍고, 여러 마일스톤 영역을 동시에 작업할 때 적합합니다. [워크스트림으로 병렬 작업](how-to/work-in-parallel-with-workstreams.md)을 참조하세요.

**워크스페이스**는 자체 `.planning/`을 가진 별도의 리포지토리 워크트리를 생성합니다 — 더 무겁고, 피처 브랜치 또는 멀티 리포지토리 격리에 적합합니다. [워크스페이스로 작업 격리](how-to/isolate-work-with-workspaces.md)를 참조하세요.

| 명령어                             | 목적                                               |
| ---------------------------------- | ---------------------------------------------------- |
| `/gsd-workstreams create <name>`   | 격리된 계획 상태로 새 워크스트림 생성              |
| `/gsd-workstreams switch <name>`   | 활성 컨텍스트를 다른 워크스트림으로 전환           |
| `/gsd-workstreams list`            | 모든 워크스트림과 활성 상태 표시                   |
| `/gsd-workstreams complete <name>` | 워크스트림을 완료로 표시하고 상태 아카이브         |

```bash
# Workspace example — feature branch isolation
/gsd-workspace --new --name feature-b --repos .
cd ~/gsd-workspaces/feature-b
/gsd-new-project

/gsd-workspace --list
/gsd-workspace --remove feature-b
```

---

## 보안

### 심층 방어 (v1.27)

GSD는 LLM 시스템 프롬프트가 되는 마크다운 파일을 생성합니다. 즉, 계획 아티팩트로 유입되는 사용자 제어 텍스트는 잠재적인 간접 프롬프트 인젝션 벡터입니다. v1.27은 중앙화된 보안 강화를 도입했습니다:

**경로 순회 방지:** 모든 사용자가 제공한 파일 경로(`--text-file`, `--prd`)는 프로젝트 디렉터리 내에서 확인됩니다. macOS `/var` → `/private/var` 심볼릭 링크 확인이 처리됩니다.

**프롬프트 인젝션 감지:** `security.cjs` 모듈은 사용자가 제공한 텍스트가 계획 아티팩트에 들어가기 전에 알려진 인젝션 패턴을 스캔합니다.

**런타임 훅:**

- `gsd-prompt-guard.js` — `.planning/`에 대한 Write/Edit 호출에서 인젝션 패턴 스캔 (항상 활성, 자문 전용)
- `gsd-workflow-guard.js` — GSD 워크플로우 컨텍스트 외부에서 파일 편집 시 경고 (`hooks.workflow_guard`를 통한 옵트인)

**CI 스캐너:** `prompt-injection-scan.security.test.cjs`는 모든 에이전트, 워크플로우, 명령어 파일에서 삽입된 인젝션 벡터를 스캔합니다.

---

### 패키지 적법성 게이트 (v1.42.1)

AI 코딩 도구는 패키지 이름을 환각합니다. 공격자는 npm, PyPI, crates.io에 악성 포스트 인스톨 스크립트가 포함된 그 이름을 미리 등록합니다 — 이를 *슬롭스쿼팅*이라 합니다. v1.42.1은 이것이 셸에 도달하기 전에 차단하는 3계층 게이트를 추가합니다.

**RESEARCH.md에서** — 외부 패키지를 권장하는 모든 단계에는 `## Package Legitimacy Audit` 테이블이 포함됩니다:

```markdown
## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| express | npm | 13 yrs | 100M+/wk | github.com/expressjs/express | [OK] | Approved |
| some-new-util | npm | 3 days | 47 | none | [SLOP] | REMOVED |
| api-bridge | npm | 6 mo | 1.2k/wk | github.com/user/api-bridge | [SUS] | Flagged |
```

`[SLOP]` 패키지는 RESEARCH.md에서 완전히 제거되며 계획자에게 도달하지 않습니다.

**PLAN.md에서** — `[SUS]` 또는 `[ASSUMED]` 패키지는 설치 전에 `checkpoint:human-verify` 작업을 트리거합니다.

**실행 중** — 설치가 실패하면 실행자는 체크포인트를 표시하고 자동으로 대안을 시도하지 않고 중단합니다.

**슬롭체크 판정:**

| 판정 | 의미 | GSD 조치 |
|---------|---------|------------|
| `[OK]` | 모든 적법성 검사 통과 | 진행 — 체크포인트 없음 |
| `[SUS]` | 의심스러운 신호 | 표시됨; 계획자가 `checkpoint:human-verify` 추가 |
| `[SLOP]` | 고신뢰 환각 | RESEARCH.md에서 제거; 계획자에게 도달하지 않음 |

슬롭체크를 수동으로 설치하려면:

```bash
pip install slopcheck
# verify: slopcheck install express --json
```

---

## 코드 리뷰 워크플로우

단계 실행 후 UAT 전에 구조화된 코드 리뷰를 실행하세요. 전체 워크플로우는 [크로스 AI 리뷰 설정](how-to/set-up-cross-ai-review.md)을 참조하세요.

```bash
/gsd-code-review 3               # Review all changed files in phase 3
/gsd-code-review 3 --depth=deep  # Deep cross-file review
/gsd-code-review 3 --fix         # Fix Critical + Warning findings atomically
/gsd-code-review 3 --fix --auto  # Fix and re-review until clean (max 3 iterations)
/gsd-audit-fix                   # Audit + classify + fix (medium+ severity, max 5)
```

리뷰 단계는 실행 후, UAT 전에 삽입됩니다:

```text
/gsd-execute-phase N  ->  /gsd-code-review N  ->  /gsd-code-review N --fix  ->  /gsd-verify-work N
```

---

## 명령어 및 구성 레퍼런스

- **명령어 레퍼런스:** 모든 안정적 명령어의 플래그, 서브명령어, 예시는 [`docs/COMMANDS.md`](COMMANDS.md)를 참조하세요.
- **구성 레퍼런스:** 전체 `config.json` 스키마, 모델 프로필 테이블, git 브랜치 전략, 보안 설정은 [`docs/CONFIGURATION.md`](CONFIGURATION.md)를 참조하세요.
- **Discuss 모드:** 인터뷰 vs 가정 모드는 [`docs/workflow-discuss-mode.md`](workflow-discuss-mode.md)를 참조하세요.

---

## 사용 예시

### 새 프로젝트 (전체 사이클)

```bash
claude --dangerously-skip-permissions
/gsd-new-project            # Answer questions, configure, approve roadmap
/clear
/gsd-discuss-phase 1        # Lock in your preferences
/gsd-ui-phase 1             # Design contract (frontend phases)
/gsd-plan-phase 1           # Research + plan + verify
/gsd-execute-phase 1        # Parallel execution
/gsd-verify-work 1          # Manual UAT
/gsd-ship 1                 # Create PR from verified work
/gsd-ui-review 1            # Visual audit (frontend phases)
/clear
/gsd-progress --next                   # Auto-detect and run next step
...
/gsd-audit-milestone        # Check everything shipped
/gsd-complete-milestone     # Archive, tag, done
/gsd-pause-work --report         # Generate session summary
```

### 기존 문서로 새 프로젝트

```bash
/gsd-new-project --auto @prd.md   # Auto-runs research/requirements/roadmap from your doc
/clear
/gsd-discuss-phase 1               # Normal flow from here
```

### 기존 코드베이스

```bash
/gsd-onboard                # Safely map, ingest docs, and initialize planning
# Follow printed handoff commands, then rerun /gsd-onboard
# (normal phase workflow from here)
```

**실행 후 드리프트 감지 (#2003).** 매 `/gsd-execute-phase` 후, GSD는 단계가 `.planning/codebase/STRUCTURE.md`를 오래되게 만들 만큼 충분한 구조적 변경을 도입했는지 확인합니다. 다음으로 동작을 변경할 수 있습니다:

```bash
/gsd-settings workflow.drift_action auto-remap       # remap automatically
/gsd-settings workflow.drift_threshold 5             # tune sensitivity
```

### 계획 드리프트 가드

**기본 활성화.** 계획 드리프트 가드(`plan_review.source_grounding: true`)는 계획 검토 중에 실행되며, 계획에 인용된 모든 심볼 — 데코레이터, 클래스, 함수, CLI 플래그 — 이 검토 시점에 실제로 소스 트리에 존재하는지 확인합니다. 이는 실행 에이전트가 실행되기 전에 환각된 이름을 잡아냅니다.

**감지 대상:**

- 소스에 존재하지 않는 PLAN.md 단계에서 참조된 함수
- 계획 작성 이후 이름이 변경되거나 제거된 클래스 또는 데코레이터 이름
- 인수 파서에 정의되지 않은 계획의 CLI 플래그
- 아무 파일로도 확인되지 않는 구현 단계에서 인용된 모듈 경로

**needs-acknowledgement 동작.** 가드가 누락된 심볼을 발견하면, 하드 차단 대신 계획 검토 출력에 `needs-acknowledgement` 알림을 표시합니다. 승인 후 진행하거나(심볼이 의도적으로 새로운 것일 수 있음) 계획 수정을 요청할 수 있습니다. 가드는 계획을 자동으로 거부하지 않으며 — 사람의 결정을 위한 신호를 표시합니다.

**인텔 없이 작동.** 기본적으로 가드는 `grep`/`ripgrep`을 사용하여 소스 파일을 검색합니다 — 사전 인덱싱이 필요하지 않습니다. `intel.enabled: true`로 `/gsd:map-codebase`를 실행했다면 `plan_review.source_grounding_authority: intel`로 설정하여 더 빠른 사전 빌드 `api-map.json` 인덱스를 사용하세요.

```bash
# Enable/disable (default: on)
/gsd-settings plan_review.source_grounding true
/gsd-settings plan_review.source_grounding false

# Switch resolver authority
/gsd-settings plan_review.source_grounding_authority grep   # live grep (default)
/gsd-settings plan_review.source_grounding_authority intel  # pre-indexed api-map.json
```

프로젝트 설정 시(`/gsd:new-project`가 워크플로우 선호도 중 질문) 또는 `/gsd:settings`를 통해 언제든지 전환 가능합니다(계획 섹션 → 드리프트 가드).

### 빠른 버그 수정

```bash
/gsd-quick
> "Fix the login button not responding on mobile Safari"
```

### 휴식 후 재개

```bash
/gsd-progress               # See where you left off and what's next
# or
/gsd-resume-work            # Full context restoration from last session
```

### 릴리스 준비

```bash
/gsd-audit-milestone        # Check requirements coverage, detect stubs
/gsd-complete-milestone     # Archive, tag, done
```

### 속도 vs 품질 프리셋

| 시나리오    | 모드          | 세분화     | 프로필     | 리서치   | 계획 검사  | 검증기   |
| ----------- | ------------- | ----------- | ---------- | -------- | ---------- | -------- |
| 프로토타이핑 | `yolo`        | `coarse`    | `budget`   | off      | off        | off      |
| 일반 개발   | `interactive` | `standard`  | `balanced` | on       | on         | on       |
| 프로덕션    | `interactive` | `fine`      | `quality`  | on       | on         | on       |

**자율 모드에서 discuss 단계 건너뛰기:** `yolo` 모드로 실행할 때는 `/gsd-settings`를 통해 `workflow.skip_discuss: true`로 설정하세요.

### 마일스톤 중간 범위 변경

```bash
/gsd-phase                  # Append a new phase to the roadmap (default mode)
/gsd-phase --insert 3       # Insert urgent work between phases 3 and 4
/gsd-phase --remove 7       # Descope phase 7 and renumber
/gsd-phase --edit 4         # Edit any field of phase 4 in place
```

---

## 문제 해결

포괄적인 문제 해결 가이드는 [복구 및 문제 해결](how-to/recover-and-troubleshoot.md)을 참조하세요. 가장 일반적인 문제들이 아래에 요약되어 있습니다.

### 프로그래밍 방식 CLI (`gsd-tools query` vs `gsd-tools.cjs`)

자동화를 위해서는 등록된 서브명령어와 함께 **`gsd-tools query`**를 사용하세요([CLI-TOOLS.md — SDK 및 프로그래밍 방식 액세스](CLI-TOOLS.md#sdk-and-programmatic-access)와 QUERY-HANDLERS.md 참조). 레거시 `node $HOME/.claude/gsd-core/bin/gsd-tools.cjs` CLI도 계속 지원됩니다.

### STATE.md 동기화 오류

```bash
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state validate          # Detect drift
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state sync --verify     # Preview changes
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state sync              # Reconstruct STATE.md
```

### "Spawning..." 이후 명령어가 멈춘 것처럼 보일 때

GSD 서브에이전트는 별도의 컨텍스트 창에서 실행됩니다 — 진행 중에는 부모 세션에서 보이지 않습니다. 세션을 중단하지 마세요. 결과를 기다리세요; 리서치 및 계획 에이전트는 일반적으로 1~5분이 소요됩니다.

### 긴 세션 중 컨텍스트 저하

주요 명령어 사이에 컨텍스트 창을 지우세요: Claude Code에서 `/clear`. GSD는 새로운 컨텍스트를 중심으로 설계되었습니다 — 모든 서브에이전트는 새로운 200K 창을 받습니다. 지운 후 상태를 복원하려면 `/gsd-resume-work` 또는 `/gsd-progress`를 사용하세요.

### 계획이 잘못되거나 정렬되지 않은 것 같을 때

계획 전에 `/gsd-discuss-phase [N]`을 실행하세요. 대부분의 계획 품질 문제는 `CONTEXT.md`가 방지했을 가정을 Claude가 만들어서 발생합니다.

### 실행 실패 또는 스텁 생성

계획이 너무 야심 찼는지 확인하세요. 계획에는 최대 2~3개의 작업이 있어야 합니다. 더 작은 범위로 재계획하세요.

### 현재 위치를 놓쳤을 때

`/gsd-progress`를 실행하세요. 모든 상태 파일을 읽고 정확히 어디에 있는지, 다음에 무엇을 해야 하는지 알려줍니다.

### 모델 비용이 너무 높을 때

예산 프로필로 전환하세요: `/gsd-config --profile budget`. 도메인이 익숙하다면 `/gsd-settings`를 통해 리서치 및 계획 검사 에이전트를 비활성화하세요.

### 단계별 모델 비용 조정 (`models`) — v1.40에서 추가됨

`.planning/config.json`에 `models` 블록을 추가하세요:

```json
{
  "model_profile": "balanced",
  "models": {
    "planning": "opus",
    "discuss": "opus",
    "research": "sonnet",
    "execution": "opus",
    "verification": "sonnet",
    "completion": "sonnet"
  }
}
```

에이전트별 예외가 필요한가요? 옆에 `model_overrides`를 추가하세요 — `models`보다 우선합니다:

```json
{
  "models": { "research": "sonnet" },
  "model_overrides": {
    "gsd-codebase-mapper": "haiku"
  }
}
```

전체 매핑 테이블과 해결 우선순위 규칙은 [단계 유형별 모델](CONFIGURATION.md#per-phase-type-models-models--added-in-v140)을 참조하세요.

### `dynamic_routing`으로 기본 저렴한 비용 — v1.40에서 추가됨

```json
{
  "dynamic_routing": {
    "enabled": true,
    "tier_models": {
      "light":    "haiku",
      "standard": "sonnet",
      "heavy":    "opus"
    },
    "escalate_on_failure": true,
    "max_escalations": 1
  }
}
```

전체 에이전트 → 티어 매핑은 [동적 라우팅](CONFIGURATION.md#dynamic-routing-with-failure-tier-escalation-dynamic_routing--added-in-v140)을 참조하세요.

### 턴당 비용을 줄이기 위해 MCP 서버 정리

`model_profile` 또는 `models.<phase_type>`을 조정하기 전에, 하네스에서 어떤 **MCP 서버**가 활성화되어 있는지 감사하세요. 활성화된 모든 MCP 서버는 모든 턴에 도구 스키마를 주입합니다 — 대형 서버는 각각 20k+ 토큰을 소비할 수 있습니다.

이것은 **하네스 설정**이며, GSD 설정이 아닙니다. 토글은 `.claude/settings.json`에 있습니다:

```json
{
  "enabledMcpjsonServers": ["context7"],
  "disabledMcpjsonServers": ["playwright", "mac-tools"]
}
```

긴 단계 전 빠른 감사:

- 이 단계에 UI 작업이 없는데 브라우저/playwright 도구가 활성화되어 있나요?
- 필요하지 않은 플랫폼별 도구가 활성화되어 있나요?
- 다른 프로젝트에서 사용하던 프로젝트별 MCP가 여기서도 활성화되어 있나요?

비활성화된 서버는 이후 모든 턴에서 스키마를 제거합니다. MCP 정리는 `model_profile` 조정과 **복합**됩니다 — 두 레버는 가산적이며, MCP 절약은 오케스트레이터가 생성하는 모든 서브에이전트에서 즉시 나타납니다.

전체 감사, 하네스 레퍼런스, `model_profile`과의 구성 노트는 번들된 `context-budget.md` 레퍼런스의 [MCP 도구 스키마 비용](../../gsd-core/references/context-budget.md#mcp-tool-schema-cost-harness-concern)을 참조하세요.

### 비 Claude 런타임 사용 (Codex, OpenCode, Gemini CLI, Kilo)

> **Codex CLI 최소 지원 버전: `0.130.0`** (이슈 [#3562](https://github.com/open-gsd/gsd-core/issues/3562)).

비 Claude 런타임용으로 GSD를 설치했다면, 설치 프로그램이 이미 모델 해석을 구성했습니다. 수동 설정이 필요하지 않습니다 — `resolve_model_ids: "omit"`이 자동으로 설정되어 GSD가 Anthropic 모델 ID 해석을 건너뛰고 런타임이 자체 기본 모델을 선택하도록 합니다.

비 Claude 런타임에서 다른 모델을 할당하려면:

```json
{
  "resolve_model_ids": "omit",
  "model_overrides": {
    "gsd-planner": "o3",
    "gsd-executor": "o4-mini",
    "gsd-debugger": "o3"
  }
}
```

#### 하나의 구성 변경으로 Claude에서 Codex로 전환 (#2517)

```json
{
  "runtime": "codex",
  "model_profile": "balanced"
}
```

[런타임 인식 프로필](CONFIGURATION.md#runtime-aware-profiles-2517)을 참조하세요.

### 수동 설치 / Node.js 없는 설정

GSD 설치 프로그램을 실행할 수 없다면, `agents/`의 소스 파일을 직접 사용할 수 없습니다 — 이는 Claude Code의 네이티브 frontmatter 형식입니다. OpenCode의 경우 두 가지 변환이 필요합니다:

| 필드 | GSD 소스 형식 | OpenCode 유효 형식 | 조치 |
|---|---|---|---|
| `tools:` | `Read, Bash, Grep` (콤마 문자열) | frontmatter 필드가 아님 | `tools:` 줄 전체 제거 |
| `color:` | 일반 CSS 색상 이름 | 16진수 또는 OpenCode 의미 이름 | 16진수로 변환하거나 제거 |

**대안:** Node.js가 있는 모든 머신에서 설치 프로그램 실행:

```bash
npx @opengsd/gsd-core@latest --opencode --global
```

### Cline용 설치

```bash
npx @opengsd/gsd-core --cline --global   # applies to all projects
npx @opengsd/gsd-core --cline --local    # this project only
```

### CodeBuddy용 설치

```bash
npx @opengsd/gsd-core --codebuddy --global
```

### Qwen Code용 설치

```bash
npx @opengsd/gsd-core --qwen --global
```

### 프리릴리스 에디션 설치

설치 프로그램 실행 전에 런타임의 `*_CONFIG_DIR` 환경 변수를 프리릴리스 디렉터리로 설정하세요:

```bash
WINDSURF_CONFIG_DIR=~/.codeium/windsurf-next npx @opengsd/gsd-core@latest --windsurf --global
```

**지원 런타임의 환경 변수 레퍼런스:**

| 런타임 | 안정 기본값 | 재정의 환경 변수 |
|---|---|---|
| Claude Code | `~/.claude` | `CLAUDE_CONFIG_DIR` |
| Gemini CLI | `~/.gemini` | `GEMINI_CONFIG_DIR` |
| OpenCode | `XDG_CONFIG_HOME/opencode` | `OPENCODE_CONFIG_DIR` |
| Codex | (Codex CLI에 따름) | `--config-dir` 플래그 |
| Copilot | `~/.copilot` | `COPILOT_CONFIG_DIR` |
| Cursor | `~/.cursor` | `CURSOR_CONFIG_DIR` |
| Windsurf | `~/.codeium/windsurf` | `WINDSURF_CONFIG_DIR` |
| Antigravity | 자동 감지 | `ANTIGRAVITY_CONFIG_DIR` |
| Augment | `~/.augment` | `AUGMENT_CONFIG_DIR` |
| Trae | `~/.trae` | `TRAE_CONFIG_DIR` |
| Qwen Code | `~/.qwen` | `QWEN_CONFIG_DIR` |
| Kilo | `~/.config/kilo` | `KILO_CONFIG_DIR` |
| CodeBuddy | `~/.codebuddy` | `CODEBUDDY_CONFIG_DIR` |
| Cline | `~/.cline` | `CLINE_CONFIG_DIR` |

### 비 Anthropic 프로바이더와 Claude Code 사용

`inherit` 프로필로 전환하세요: `/gsd-config --profile inherit`. 이렇게 하면 모든 에이전트가 현재 세션 모델을 사용합니다.

### 민감/비공개 프로젝트 작업

`/gsd-new-project` 중 또는 `/gsd-settings`를 통해 `commit_docs: false`로 설정하세요. `.planning/`을 `.gitignore`에 추가하세요.

### GSD 업데이트가 로컬 변경사항을 덮어씀

v1.17부터 설치 프로그램은 로컬에서 수정된 파일을 `gsd-local-patches/`에 백업합니다. 변경사항을 다시 병합하려면 `/gsd-update --reapply`를 실행하세요.

### npm을 통해 업데이트할 수 없음

단계별 수동 업데이트 절차는 [docs/manual-update.md](../manual-update.md)를 참조하세요.

### 워크플로우 진단 (`/gsd-forensics`)

워크플로우가 명확하지 않은 방식으로 실패하면 `/gsd-forensics`를 실행하여 git 히스토리 이상, 아티팩트 무결성, 상태 불일치를 포함한 진단 보고서를 생성하세요. 출력은 `.planning/forensics/`로 이동합니다.

### 실행기 서브에이전트가 Bash 명령어에서 "Permission denied" 발생

`~/.claude/settings.json`에 필요한 패턴을 추가하세요. 모든 스택에 필요한 핵심 패턴:

```json
"Bash(git add:*)",
"Bash(git commit:*)",
"Bash(git merge:*)",
"Bash(git worktree:*)",
"Bash(git rebase:*)",
"Bash(git reset:*)",
"Bash(git checkout:*)",
"Bash(git switch:*)",
"Bash(git restore:*)",
"Bash(git stash:*)",
"Bash(git rm:*)",
"Bash(git mv:*)",
"Bash(git fetch:*)",
"Bash(git cherry-pick:*)",
"Bash(git apply:*)",
"Bash(gh:*)"
```

**프로젝트별 권한:** `~/.claude/settings.json` 대신 프로젝트 루트의 `.claude/settings.local.json`에 동일한 `permissions.allow` 블록을 추가하세요.

### 병렬 실행으로 빌드 잠금 오류 발생

GSD는 v1.26부터 이를 자동으로 처리합니다. 이전 버전을 사용 중이라면 프로젝트의 `CLAUDE.md`에 다음을 추가하세요:

```markdown
## Git Commit Rules for Agents
All subagent/executor commits MUST use `--no-verify`.
```

병렬 실행을 완전히 비활성화하려면: `/gsd-settings` → `parallelization.enabled`를 `false`로 설정하세요.

---

## 복구 빠른 참조

| 문제                                 | 해결책                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------ |
| 컨텍스트 손실 / 새 세션              | `/gsd-resume-work` 또는 `/gsd-progress`                                  |
| 단계가 잘못됨                        | 단계 커밋을 `git revert`한 후 재계획                                     |
| 범위 변경 필요                       | `/gsd-phase` (기본), `/gsd-phase --insert`, 또는 `/gsd-phase --remove`   |
| 무언가 고장남                        | `/gsd-debug "description"` (수정 없이 분석만 하려면 `--diagnose` 추가)   |
| STATE.md 동기화 오류                 | `state validate` 후 `state sync`                                         |
| 워크플로우 상태가 손상된 것 같음     | `/gsd-forensics`                                                         |
| 빠른 목표 수정                       | `/gsd-quick`                                                             |
| 계획이 비전과 맞지 않음              | `/gsd-discuss-phase [N]` 후 재계획                                       |
| 비용이 높아짐                        | `/gsd-config --profile budget` 및 `/gsd-settings`로 에이전트 끄기       |
| 업데이트가 로컬 변경사항을 손상시킴  | `/gsd-update --reapply`                                                  |
| 이해관계자를 위한 세션 요약 필요     | `/gsd-pause-work --report`                                               |
| 다음 단계를 모름                     | `/gsd-progress --next`                                                   |
| 병렬 실행 빌드 오류                  | GSD 업데이트 또는 `parallelization.enabled: false` 설정                  |

---

## 프로젝트 파일 구조

```text
.planning/
  PROJECT.md              # Project vision and context (always loaded)
  REQUIREMENTS.md         # Scoped v1/v2 requirements with IDs
  ROADMAP.md              # Phase breakdown with status tracking
  STATE.md                # Decisions, blockers, session memory
  config.json             # Workflow configuration
  MILESTONES.md           # Completed milestone archive
  HANDOFF.json            # Structured session handoff (from /gsd-pause-work)
  research/               # Domain research from /gsd-new-project
  reports/                # Session reports (from /gsd-pause-work --report)
  todos/
    pending/              # Captured ideas awaiting work
    completed/             # Completed todos
  debug/                  # Active debug sessions
    resolved/             # Archived debug sessions
  spikes/                 # Feasibility experiments (from /gsd-spike)
    NNN-name/             # Experiment code + README with verdict
    MANIFEST.md           # Index of all spikes
  sketches/               # HTML mockups (from /gsd-sketch)
    NNN-name/             # index.html (2-3 variants) + README
    themes/
      default.css         # Shared CSS variables for all sketches
    MANIFEST.md           # Index of all sketches with winners
  codebase/               # Brownfield codebase mapping (from /gsd-map-codebase or /gsd-onboard)
  onboarding/             # Brownfield onboarding summary (from /gsd-onboard)
  phases/
    XX-phase-name/
      XX-YY-PLAN.md       # Atomic execution plans
      XX-YY-SUMMARY.md    # Execution outcomes and decisions
      CONTEXT.md          # Your implementation preferences
      RESEARCH.md         # Ecosystem research findings
      VERIFICATION.md     # Post-execution verification results
      XX-UI-SPEC.md       # UI design contract (from /gsd-ui-phase)
      XX-UI-REVIEW.md     # Visual audit scores (from /gsd-ui-review)
  ui-reviews/             # Screenshots from /gsd-ui-review (gitignored)
```

---

## 관련 문서

- [문서 인덱스](README.md)
- [명령어](COMMANDS.md)
- [구성](CONFIGURATION.md)
- [단계 루프](explanation/the-phase-loop.md)
