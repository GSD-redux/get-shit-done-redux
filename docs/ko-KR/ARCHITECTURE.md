# GSD Core 아키텍처

> 기여자와 고급 사용자를 위한 시스템 아키텍처. 사용자 문서는 [기능 레퍼런스](FEATURES.md) 또는 [사용자 가이드](USER-GUIDE.md)를 참조하라.

---

## 목차

- [시스템 개요](#system-overview)
- [설계 원칙](#design-principles)
- [컴포넌트 아키텍처](#component-architecture)
- [에이전트 모델](#agent-model)
- [데이터 흐름](#data-flow)
- [파일 시스템 구조](#file-system-layout)
- [인스톨러 아키텍처](#installer-architecture)
- [훅 시스템](#hook-system)
- [CLI 도구 레이어](#cli-tools-layer)
- [런타임 추상화](#runtime-abstraction)

---

## 시스템 개요

GSD Core는 사용자와 AI 코딩 에이전트(Claude Code, Gemini CLI, OpenCode, Kilo, Codex, Copilot, Antigravity, Trae, Cline, Augment Code) 사이에 위치하는 **메타 프롬프팅 프레임워크**이다. 다음을 제공한다:

1. **컨텍스트 엔지니어링** — 작업별로 AI에게 필요한 모든 것을 제공하는 구조화된 결과물([컨텍스트 엔지니어링](explanation/context-engineering.md) 참조)
2. **다중 에이전트 오케스트레이션** — 신선한 컨텍스트 윈도우로 전문화된 에이전트를 생성하는 얇은 오케스트레이터([다중 에이전트 오케스트레이션](explanation/multi-agent-orchestration.md) 참조)
3. **명세 주도 개발** — 요구 사항 → 리서치 → 계획 → 실행 → 검증 파이프라인
4. **상태 관리** — 세션과 컨텍스트 리셋 전반에 걸친 영구적인 프로젝트 메모리

```
┌──────────────────────────────────────────────────────┐
│                      USER                            │
│            /gsd-command [args]                        │
└─────────────────────┬────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────┐
│              COMMAND LAYER                            │
│   commands/gsd/*.md — Prompt-based command files      │
│   (Claude Code custom commands / Codex skills)        │
└─────────────────────┬────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────┐
│              WORKFLOW LAYER                           │
│   gsd-core/workflows/*.md — Orchestration logic  │
│   (Reads references, spawns agents, manages state)    │
└──────┬──────────────┬─────────────────┬──────────────┘
       │              │                 │
┌──────▼──────┐ ┌─────▼─────┐ ┌────────▼───────┐
│  AGENT      │ │  AGENT    │ │  AGENT         │
│  (fresh     │ │  (fresh   │ │  (fresh        │
│   context)  │ │   context)│ │   context)     │
└──────┬──────┘ └─────┬─────┘ └────────┬───────┘
       │              │                 │
┌──────▼──────────────▼─────────────────▼──────────────┐
│              CLI TOOLS LAYER                          │
│   gsd-tools.cjs command families + domain modules      │
│   command-routing-hub + observability seams            │
└──────────────────────┬───────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────┐
│              FILE SYSTEM (.planning/)                 │
│   PROJECT.md | REQUIREMENTS.md | ROADMAP.md          │
│   STATE.md | config.json | phases/ | research/       │
└──────────────────────────────────────────────────────┘
```

---

## 설계 원칙

### 1. 에이전트별 신선한 컨텍스트

오케스트레이터가 생성하는 모든 에이전트는 깨끗한 컨텍스트 윈도우(최대 200K 토큰)를 받는다. 이는 컨텍스트 부패 — AI가 컨텍스트 윈도우를 누적된 대화로 채울 때 발생하는 품질 저하 — 를 제거한다.

### 2. 얇은 오케스트레이터

워크플로우 파일(`gsd-core/workflows/*.md`)은 무거운 작업을 직접 수행하지 않는다. 오케스트레이터가 하는 것:

- `gsd-tools.cjs init <workflow>`로 컨텍스트 로드
- 집중된 프롬프트로 전문화된 에이전트 생성
- 결과 수집 및 다음 단계로 라우팅
- 단계 사이에 상태 업데이트

### 3. 파일 기반 상태

모든 상태는 `.planning/`에 사람이 읽을 수 있는 마크다운과 JSON으로 저장된다. 데이터베이스도, 서버도, 외부 의존성도 없다. 이것이 의미하는 바:

- 컨텍스트 리셋(`/clear`) 이후에도 상태가 유지된다
- 사람과 에이전트 모두 상태를 확인할 수 있다
- 팀 가시성을 위해 git에 커밋할 수 있다

### 4. 부재 = 활성화

워크플로우 기능 플래그는 **부재 = 활성화** 패턴을 따른다. `config.json`에 키가 없으면 기본값은 `true`이다. 사용자는 기능을 명시적으로 비활성화하며; 기본값을 활성화할 필요가 없다.

### 5. 심층 방어

여러 계층이 일반적인 실패 모드를 방지한다:

- 계획은 실행 전에 검증된다 (plan-checker 에이전트)
- 실행은 작업당 원자적 커밋을 생성한다
- 실행 후 검증은 단계 목표에 대해 확인한다
- UAT는 최종 게이트로서 사람 검증을 제공한다

---

## 컴포넌트 아키텍처

### Commands (`commands/gsd/*.md`)

사용자 대면 진입점. 각 파일은 YAML 전문(name, description, allowed-tools)과 워크플로우를 부트스트랩하는 프롬프트 본문을 포함한다. 명령어는 다음과 같이 설치된다:

- **Claude Code:** 커스텀 슬래시 명령어 (하이픈 형식, `/gsd-command-name`)
- **OpenCode / Kilo:** 슬래시 명령어 (하이픈 형식, `/gsd-command-name`)
- **Codex:** Skills (`$gsd-command-name`)
- **Copilot:** 슬래시 명령어 (하이픈 형식, `/gsd-command-name`)
- **Gemini CLI:** `gsd:` 네임스페이스 하의 슬래시 명령어 (콜론 형식, `/gsd:command-name`) — Gemini는 플러그인 id 아래 모든 커스텀 명령어를 네임스페이스화하므로 설치 경로가 모든 본문 텍스트 참조를 콜론 형식으로 다시 쓴다
- **Antigravity:** Skills

**전체 명령어 수:** 권위 있는 개수와 전체 목록은 [`docs/INVENTORY.md`](INVENTORY.md#commands)를 참조하라.

#### 2단계 계층적 라우팅 (v1.40, [#2792](https://github.com/open-gsd/gsd-core/issues/2792))

열망적 스킬 목록 토큰 비용을 낮게 유지하기 위해 v1.40은 구체적인 하위 스킬 위에 계층화된 여섯 개의 네임스페이스 **메타 스킬** (`gsd-workflow`, `gsd-project`, `gsd-quality`, `gsd-context`, `gsd-manage`, `gsd-ideate` — `commands/gsd/ns-*.md`에서 소싱되지만 호출 가능한 `name:`은 여기 표시된 간단한 형식)을 도입한다. 모델은 평평한 86개 스킬 목록(~2,150 토큰) 대신 6개의 네임스페이스 라우터(~120 토큰)를 보고, 네임스페이스를 선택한 다음 네임스페이스 라우터 본문에 내장된 라우팅 테이블을 통해 구체적인 하위 스킬로 라우팅한다. 네임스페이스 스킬은 **가산적**이다 — 모든 구체적인 명령어는 여전히 직접 호출 가능하다.

라우터 설명은 ~40% 토큰 비용으로 프로세 대비 키워드 밀도 태그가 라우팅에서 더 뛰어나다는 Tool Attention 연구에 따라 도구당 파이프로 구분된 키워드 태그(≤ 60자)를 사용한다.

#### MCP 토큰 예산 상호작용

열망적 스킬 목록은 턴당 반복되는 두 가지 토큰 비용 중 하나이다. 다른 하나는 `.claude/settings.json`의 모든 활성화된 MCP 서버가 주입하는 MCP 도구 스키마이다. 무거운 MCP 서버(브라우저/playwright, Mac-tools, Windows-tools)는 각각 턴당 20k+ 토큰 비용이 들 수 있다 — 종종 `model_profile` 튜닝이 절약하는 것을 압도한다. 토글은 Claude Code 하니스(`.claude/settings.json`의 `enabledMcpjsonServers` / `disabledMcpjsonServers`)에 있으며 GSD 관심사가 아니다. 2단계 라우팅 계층(#2792)과 규율 있는 MCP 활성화를 함께 사용하는 것이 턴당 가장 큰 비용 레버이다. [`docs/USER-GUIDE.md`](USER-GUIDE.md)와 `references/context-budget.md`에서 감사 체크리스트를 참조하라.

### Workflows (`gsd-core/workflows/*.md`)

명령어가 참조하는 오케스트레이션 로직. 다음을 포함하는 단계별 프로세스를 담는다:

- `gsd-tools.cjs init` 핸들러를 통한 컨텍스트 로딩
- 모델 해결을 포함한 에이전트 생성 지시
- 게이트/체크포인트 정의
- 상태 업데이트 패턴
- 오류 처리 및 복구

**전체 워크플로우 수:** 권위 있는 개수와 전체 목록은 [`docs/INVENTORY.md`](INVENTORY.md#workflows)를 참조하라.

#### 워크플로우를 위한 점진적 공개

워크플로우 파일은 해당 `/gsd-*` 명령어가 호출될 때마다 Claude의 컨텍스트에 그대로 로드된다. 이 비용을 제한하기 위해 `tests/workflow-size-budget.test.cjs`가 시행하는 워크플로우 크기 예산은 에이전트 크기 예산 관례를 반영한다:

| 등급      | 파일당 줄 제한 |
|-----------|--------------------|
| `XL`      | 1700 — 최상위 오케스트레이터 (`execute-phase`, `plan-phase`, `new-project`) |
| `LARGE`   | 1500 — 다단계 플래너 및 대형 기능 워크플로우 |
| `DEFAULT` | 1000 — 집중된 단일 목적 워크플로우 (목표 등급) |

`workflows/discuss-phase.md`는 discuss-phase 바이트 예산(#717; discuss-phase/modes 분할로 ≈32000 바이트 유지)에 따라 더 엄격한 상한을 유지한다. 워크플로우가 등급을 초과하면 모드별 본문은 `workflows/<workflow>/modes/<mode>.md`로, 템플릿은 `workflows/<workflow>/templates/`로, 공유 지식은 `gsd-core/references/`로 추출한다. 부모 파일은 현재 호출에 필요한 모드 및 템플릿 파일만 읽는 얇은 디스패처가 된다.

`workflows/discuss-phase/`가 이 패턴의 정규 예시이다 — 부모는 디스패치하고, modes/는 플래그별 동작(`power.md`, `all.md`, `auto.md`, `chain.md`, `text.md`, `batch.md`, `analyze.md`, `default.md`, `advisor.md`)을 담으며, templates/는 해당 출력 파일이 작성될 때만 읽히는 CONTEXT.md, DISCUSSION-LOG.md, checkpoint.json 스키마를 담는다.

### Agents (`agents/*.md`)

다음을 지정하는 전문화된 에이전트 정의:

- `name` — 에이전트 식별자
- `description` — 역할과 목적
- `tools` — 허용된 도구 접근 (Read, Write, Edit, Bash, Grep, Glob, WebSearch 등)
- `color` — 시각적 구분을 위한 터미널 출력 색상

**전체 에이전트 수:** 33개

### References (`gsd-core/references/*.md`)

워크플로우와 에이전트가 `@-reference`하는 공유 지식 문서([`docs/INVENTORY.md`](INVENTORY.md#references-41-shipped)에서 권위 있는 개수와 전체 목록 참조):

**핵심 레퍼런스:**

- `checkpoints.md` — 체크포인트 유형 정의 및 상호작용 패턴
- `gates.md` — plan-checker와 verifier에 연결된 4가지 정규 게이트 유형 (확인, 품질, 안전, 전환)
- `model-profiles.md` — 에이전트별 모델 등급 할당
- `model-profile-resolution.md` — 모델 해결 알고리즘 문서
- `verification-patterns.md` — 다양한 결과물 유형 검증 방법
- `verification-overrides.md` — 결과물별 검증 재정의 규칙
- `planning-config.md` — 전체 config 스키마 및 동작
- `git-integration.md` — git 커밋, 브랜칭, 이력 패턴
- `git-planning-commit.md` — 계획 디렉터리 커밋 컨벤션
- `questioning.md` — 프로젝트 초기화를 위한 꿈 추출 철학
- `tdd.md` — 테스트 주도 개발 통합 패턴
- `ui-brand.md` — 시각적 출력 형식 패턴
- `common-bug-patterns.md` — 코드 리뷰 및 검증을 위한 일반적인 버그 패턴

**워크플로우 레퍼런스:**

- `agent-contracts.md` — 오케스트레이터와 에이전트 간의 공식 인터페이스
- `context-budget.md` — 컨텍스트 윈도우 예산 할당 규칙
- `continuation-format.md` — 세션 지속/재개 형식
- `domain-probes.md` — discuss-phase를 위한 도메인별 프로빙 질문
- `gate-prompts.md` — 게이트/체크포인트 프롬프트 템플릿
- `revision-loop.md` — 계획 수정 반복 패턴
- `universal-anti-patterns.md` — 탐지하고 피해야 할 일반적인 안티 패턴
- `artifact-types.md` — 계획 결과물 유형 정의
- `phase-argument-parsing.md` — 단계 인수 파싱 컨벤션
- `decimal-phase-calculation.md` — 소수 하위 단계 번호 매기기 규칙
- `workstream-flag.md` — 워크스트림 활성 포인터 컨벤션
- `user-profiling.md` — 사용자 행동 프로파일링 방법론
- `thinking-partner.md` — 의사 결정 포인트에서의 조건부 thinking partner 활성화

**Thinking 모델 레퍼런스:**

GSD 워크플로우에 thinking 클래스 모델(o3, o4-mini, Gemini 2.5 Pro)을 통합하기 위한 레퍼런스:

- `thinking-models-debug.md` — 디버깅 워크플로우를 위한 thinking 모델 패턴
- `thinking-models-execution.md` — 실행 에이전트를 위한 thinking 모델 패턴
- `thinking-models-planning.md` — 계획 에이전트를 위한 thinking 모델 패턴
- `thinking-models-research.md` — 리서치 에이전트를 위한 thinking 모델 패턴
- `thinking-models-verification.md` — 검증 에이전트를 위한 thinking 모델 패턴

**모듈식 플래너 분해:**

플래너 에이전트(`agents/gsd-planner.md`)는 일부 런타임에서 부과하는 50K 문자 제한 이하로 유지하기 위해 단일 모놀리식 파일에서 핵심 에이전트 + 레퍼런스 모듈로 분해되었다:

- `planner-gap-closure.md` — 갭 클로저 모드 동작 (VERIFICATION.md 읽기, 대상 재계획)
- `planner-reviews.md` — 교차 AI 리뷰 통합 (`/gsd-review`의 REVIEWS.md 읽기)
- `planner-revision.md` — 반복적 개선을 위한 계획 수정 패턴

### Templates (`gsd-core/templates/`)

모든 계획 결과물을 위한 마크다운 템플릿. `gsd-tools.cjs template fill` / `phase.scaffold`(와 최상위 `scaffold`)가 사전 구조화된 파일을 생성하는 데 사용:
- `project.md`, `requirements.md`, `roadmap.md`, `state.md` — 핵심 프로젝트 파일
- `phase-prompt.md` — 단계 실행 프롬프트 템플릿
- `summary.md` (+ `summary-minimal.md`, `summary-standard.md`, `summary-complex.md`) — 세분화 인식 요약 템플릿
- `DEBUG.md` — 디버그 세션 추적 템플릿
- `UI-SPEC.md`, `UAT.md`, `VALIDATION.md` — 전문화된 검증 템플릿
- `discussion-log.md` — 논의 감사 추적 템플릿
- `codebase/` — 브라운필드 매핑 템플릿 (stack, architecture, conventions, concerns, structure, testing, integrations)
- `research-project/` — 리서치 출력 템플릿 (SUMMARY, STACK, FEATURES, ARCHITECTURE, PITFALLS)

### Hooks (`hooks/`)

호스트 AI 에이전트와 통합되는 런타임 훅:

| 훅 | 이벤트 | 목적 |
|------|-------|---------|
| `gsd-statusline.js` | `statusLine` | 모델, 작업, 디렉터리, 컨텍스트 사용 바 표시 |
| `gsd-context-monitor.js` | `PostToolUse` / `AfterTool` | 잔여 35%/25% 시점에 에이전트 대면 컨텍스트 경고 주입 |
| `gsd-check-update.js` | `SessionStart` | 백그라운드 업데이트 확인을 위한 포어그라운드 트리거 |
| `gsd-check-update-worker.js` | (헬퍼) | `gsd-check-update.js`가 생성하는 백그라운드 워커; 직접 이벤트 등록 없음 |
| `gsd-prompt-guard.js` | `PreToolUse` | `.planning/` 쓰기에서 프롬프트 인젝션 패턴 스캔 (자문적) |
| `gsd-read-injection-scanner.js` | `PostToolUse` | 신뢰할 수 없는 콘텐츠에서 주입된 지시 사항을 위한 Read 도구 출력 스캔 |
| `gsd-workflow-guard.js` | `PreToolUse` | GSD 워크플로우 컨텍스트 외부의 파일 편집 감지 (자문적, `hooks.workflow_guard`를 통한 옵트인) |
| `gsd-read-guard.js` | `PreToolUse` | 세션에서 아직 읽지 않은 파일에 Edit/Write를 방지하는 자문적 가드 |
| `gsd-session-state.sh` | `PostToolUse` | 쉘 기반 런타임을 위한 세션 상태 추적 |
| `gsd-validate-commit.sh` | `PostToolUse` | 컨벤셔널 커밋 시행을 위한 커밋 검증 |
| `gsd-phase-boundary.sh` | `PostToolUse` | 워크플로우 전환을 위한 단계 경계 감지 |

권위 있는 11개 훅 목록은 [`docs/INVENTORY.md`](INVENTORY.md#hooks-11-shipped)를 참조하라.

### Command Routing Hub (`gsd-core/bin/lib/command-routing-hub.cjs`)

CJS 명령어 패밀리 라우터는 `CommandRoutingHub`를 통해 디스패치한다. 허브는 no-throw 순수 결과 계약(`hub.dispatch()`는 내부 예외를 잡아 `{ ok: false, kind, ...typedPayload }`를 반환)과 닫힌 런타임 오류 분류(`UnknownCommand`, `InvalidArgs`, `HandlerRefusal`, `HandlerFailure`)를 소유한다. 라우터 어댑터는 얇은 CLI 번역기로 유지된다 — 허브를 구축하고, `dispatch`를 호출하고, 결과를 `output()`/`error()` 호출에 매핑한다. 런타임은 단일 경로이다(이중 런타임 모드 선택 없음). `docs/adr/0174-retire-gsd-sdk-package-boundary.md` 참조.

### CLI Tools (`gsd-core/bin/`)

`gsd-core/bin/lib/`에 걸쳐 분할된 도메인 모듈을 가진 Node.js CLI 유틸리티(`gsd-tools.cjs`)(권위 있는 목록은 [`docs/INVENTORY.md`](INVENTORY.md#cli-modules-33-shipped) 참조):


| 모듈                 | 책임                                                                                      |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `core.cjs`             | 오류 처리, 출력 형식, 공유 유틸리티; 계획 헬퍼를 위한 호환성 재내보내기 |
| `planning-workspace.cjs` | 계획 심(`planningDir`, `planningPaths`, 활성 워크스트림 라우팅, `.planning/.lock`)      |
| `state.cjs`            | STATE.md 파싱, 업데이트, 진행, 메트릭                                                    |
| `phase.cjs`            | 단계 디렉터리 작업, 소수 번호 매기기, 계획 인덱싱                                        |
| `roadmap.cjs`          | ROADMAP.md 파싱, 단계 추출, 계획 진행 상황                                                 |
| `config.cjs`           | config.json 읽기/쓰기, 섹션 초기화                                                      |
| `verify.cjs`           | 계획 구조, 단계 완성도, 레퍼런스, 커밋 검증                                    |
| `template.cjs`         | 변수 치환을 통한 템플릿 선택 및 채우기                                           |
| `frontmatter.cjs`      | YAML 전문 CRUD 작업                                                                    |
| `init.cjs`             | 각 워크플로우 유형을 위한 복합 컨텍스트 로딩                                           |
| `milestone.cjs`        | 마일스톤 보관, 요구 사항 표시                                                            |
| `commands.cjs`         | 기타 명령어 (slug, timestamp, todos, scaffolding, stats)                                           |
| `model-profiles.cjs`   | 모델 프로필 해결 테이블                                                                      |
| `security.cjs`         | 경로 탐색 방지, 프롬프트 인젝션 탐지, 안전한 JSON 파싱, 쉘 인수 검증 |
| `uat.cjs`              | UAT 파일 파싱, 검증 부채 추적, audit-uat 지원                                                     |
| `docs.cjs`             | 문서 업데이트 워크플로우 초기화, 마크다운 스캔, 모노레포 감지                                    |
| `workstream.cjs`       | 워크스트림 CRUD, 마이그레이션, 세션 범위 활성 포인터                                           |
| `schema-detect.cjs`    | ORM 패턴에 대한 스키마 드리프트 감지 (Prisma, Drizzle 등)                                     |
| `profile-pipeline.cjs` | 사용자 행동 프로파일링 데이터 파이프라인, 세션 파일 스캔                                  |
| `profile-output.cjs`   | 프로필 렌더링, USER-PROFILE.md 및 dev-preferences.md 생성                                |


---

## 에이전트 모델

### 오케스트레이터 → 에이전트 패턴

```
오케스트레이터 (workflow .md)
    │
    ├── 컨텍스트 로드: gsd-tools.cjs init <workflow> <phase>
    │   반환 JSON: 프로젝트 정보, 설정, 상태, 단계 상세
    │
    ├── 모델 해결: gsd-tools.cjs resolve-model <agent-name>
    │   반환: opus | sonnet | haiku | inherit
    │
    ├── 에이전트 생성 (Task/SubAgent 호출)
    │   ├── 에이전트 프롬프트 (agents/*.md)
    │   ├── 컨텍스트 페이로드 (init JSON)
    │   ├── 모델 할당
    │   └── 도구 권한
    │
    ├── 결과 수집
    │
    └── 상태 업데이트: gsd-tools.cjs state update / state patch / state advance-plan
```

### 주요 에이전트 생성 범주

21개 주요 에이전트의 개념적 생성 패턴 분류. 권위 있는 31개 에이전트 목록(10개 고급/전문화 에이전트 포함: `gsd-pattern-mapper`, `gsd-code-reviewer`, `gsd-code-fixer`, `gsd-ai-researcher`, `gsd-domain-researcher`, `gsd-eval-planner`, `gsd-eval-auditor`, `gsd-framework-selector`, `gsd-debug-session-manager`, `gsd-intel-updater`)은 [`docs/INVENTORY.md`](INVENTORY.md#agents-31-shipped)를 참조하라.


| 범주         | 에이전트                                                                                  | 병렬성                                                                               |
| ---------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Researchers**  | gsd-project-researcher, gsd-phase-researcher, gsd-ui-researcher, gsd-advisor-researcher | 4개 병렬 (stack, features, architecture, pitfalls); advisor는 discuss-phase 중 생성됨 |
| **Synthesizers** | gsd-research-synthesizer                                                                | 순차적 (리서처 완료 후)                                                   |
| **Planners**     | gsd-planner, gsd-roadmapper                                                             | 순차적                                                                                |
| **Checkers**     | gsd-plan-checker, gsd-integration-checker, gsd-ui-checker, gsd-nyquist-auditor          | 순차적 (검증 루프, 최대 3회 반복)                                          |
| **Executors**    | gsd-executor                                                                            | 웨이브 내 병렬, 웨이브 간 순차적                                            |
| **Verifiers**    | gsd-verifier                                                                            | 순차적 (모든 실행기 완료 후)                                                 |
| **Mappers**      | gsd-codebase-mapper                                                                     | 4개 병렬 (tech, arch, quality, concerns)                                                |
| **Debuggers**    | gsd-debugger                                                                            | 순차적 (대화형)                                                                  |
| **Auditors**     | gsd-ui-auditor, gsd-security-auditor                                                    | 순차적                                                                                |
| **Doc Writers**  | gsd-doc-writer, gsd-doc-verifier                                                        | 순차적 (writer 다음 verifier)                                                     |
| **Profilers**    | gsd-user-profiler                                                                       | 순차적                                                                                |
| **Analyzers**    | gsd-assumptions-analyzer                                                                | 순차적 (discuss-phase 중)                                                         |


### 웨이브 실행 모델

`execute-phase` 중 계획은 의존성 웨이브로 그룹화된다:

```
웨이브 분석:
  계획 01 (의존성 없음)      ─┐
  계획 02 (의존성 없음)      ─┤── 웨이브 1 (병렬)
  계획 03 (의존: 01)         ─┤── 웨이브 2 (웨이브 1 대기)
  계획 04 (의존: 02)         ─┘
  계획 05 (의존: 03,04)      ── 웨이브 3 (웨이브 2 대기)
```

각 실행기는 다음을 받는다:

- 신선한 200K 컨텍스트 윈도우 (또는 지원 모델에서 최대 1M)
- 실행할 특정 PLAN.md
- 프로젝트 컨텍스트 (PROJECT.md, STATE.md)
- 단계 컨텍스트 (CONTEXT.md, 가용한 경우 RESEARCH.md)

### 적응형 컨텍스트 보강 (1M 모델)

컨텍스트 윈도우가 500K+ 토큰인 경우 (Opus 4.6, Sonnet 4.6 같은 1M 클래스 모델), 서브에이전트 프롬프트는 표준 200K 윈도우에 들어가지 않는 추가 컨텍스트로 자동 보강된다:

- **실행기 에이전트**는 이전 웨이브 SUMMARY.md 파일들과 단계 CONTEXT.md/RESEARCH.md를 받아 단계 내 교차 계획 인식 가능
- **검증기 에이전트**는 모든 PLAN.md, SUMMARY.md, CONTEXT.md 파일들과 REQUIREMENTS.md를 받아 이력 인식 검증 가능

오케스트레이터는 config에서 `context_window`를 읽고(`gsd-tools.cjs config-get context_window`) 값이 >= 500,000일 때 조건부로 더 풍부한 컨텍스트를 포함한다. 표준 200K 윈도우에서는 최대 컨텍스트 효율성을 위해 캐시 친화적 순서로 잘린 버전의 프롬프트를 사용한다.

#### 병렬 커밋 안전성

같은 웨이브 내에서 여러 실행기가 실행될 때 두 가지 메커니즘이 충돌을 방지한다:

1. `--no-verify` 커밋 — 병렬 에이전트는 사전 커밋 훅을 건너뛴다 (빌드 잠금 경합을 유발할 수 있음, 예: Rust 프로젝트의 cargo lock 충돌). 오케스트레이터는 각 웨이브 완료 후 `git hook run pre-commit`을 한 번 실행한다.
2. **STATE.md 파일 잠금** — 모든 `writeStateMd()` 호출은 lockfile 기반 상호 배제를 사용한다(`STATE.md.lock`, `O_EXCL` 원자적 생성). 이는 두 에이전트가 STATE.md를 읽고 서로 다른 필드를 수정하면 마지막 작성자가 다른 에이전트의 변경 사항을 덮어쓰는 읽기-수정-쓰기 경합 조건을 방지한다. 오래된 잠금 감지(10초 타임아웃)와 지터를 포함한 스핀 대기가 포함된다.

---

## 데이터 흐름

### 새 프로젝트 흐름

```
사용자 입력 (아이디어 설명)
    │
    ▼
질문 (questioning.md 철학)
    │
    ▼
4x 프로젝트 리서처 (병렬)
    ├── Stack → STACK.md
    ├── Features → FEATURES.md
    ├── Architecture → ARCHITECTURE.md
    └── Pitfalls → PITFALLS.md
    │
    ▼
리서치 합성기 → SUMMARY.md
    │
    ▼
요구 사항 추출 → REQUIREMENTS.md
    │
    ▼
로드맵퍼 → ROADMAP.md
    │
    ▼
사용자 승인 → STATE.md 초기화
```

### 단계 실행 흐름

```
discuss-phase → CONTEXT.md (사용자 선호도)
    │
    ▼
ui-phase → UI-SPEC.md (디자인 계약, 선택적)
    │
    ▼
plan-phase
    ├── 리서치 게이트 (RESEARCH.md에 미해결 공개 질문이 있으면 차단)
    ├── 단계 리서처 → RESEARCH.md
    │       └── 패키지 적법성 게이트: 모든 패키지에 slopcheck; [SLOP] 제거,
    │           [SUS]/[ASSUMED] 플래그; 감사 테이블을 RESEARCH.md에 작성
    ├── 플래너 (도달 가능성 검사 포함) → PLAN.md 파일
    │       └── [ASSUMED]/[SUS] 설치 전에 checkpoint:human-verify 삽입;
    │           설치 포함 계획에 T-{phase}-SC STRIDE 행 추가
    ├── 계획 검사기 → 검증 루프 (최대 3회)
    ├── 요구 사항 커버리지 게이트 (REQ-ID → 계획)
    └── 결정 커버리지 게이트 (CONTEXT.md `<decisions>` → 계획, 차단 — #2492)
    │
    ▼
state planned-phase → STATE.md (계획됨/실행 준비)
    │
    ▼
execute-phase (컨텍스트 축소: 잘린 프롬프트, 캐시 친화적 순서)
    ├── 웨이브 분석 (의존성 그룹화)
    ├── 계획당 실행기 → 코드 + 원자적 커밋
    ├── 계획당 SUMMARY.md
    └── 검증기 → VERIFICATION.md
        └── 결정 커버리지 게이트 (CONTEXT.md 결정 → 출시된 결과물, 비차단 — #2492)
    │
    ▼
verify-work → UAT.md (사용자 수락 테스트)
    │
    ▼
ui-review → UI-REVIEW.md (시각적 감사, 선택적)
```

### 컨텍스트 전파

각 워크플로우 단계는 이후 단계에 공급되는 결과물을 생성한다:

```
PROJECT.md ────────────────────────────────────────────► 모든 에이전트
REQUIREMENTS.md ───────────────────────────────────────► 플래너, 검증기, 감사기
ROADMAP.md ────────────────────────────────────────────► 오케스트레이터
STATE.md ──────────────────────────────────────────────► 모든 에이전트 (결정, 차단)
CONTEXT.md (단계별) ────────────────────────────────────► 리서처, 플래너, 실행기
RESEARCH.md (단계별) ───────────────────────────────────► 플래너, 계획 검사기
PLAN.md (계획별) ────────────────────────────────────────► 실행기, 계획 검사기
SUMMARY.md (계획별) ─────────────────────────────────────► 검증기, 상태 추적
UI-SPEC.md (단계별) ────────────────────────────────────► 실행기, UI 감사기
```

---

## 파일 시스템 구조

### 설치 파일

```
~/.claude/                          # Claude Code (전역 설치)
├── skills/gsd-*/SKILL.md           # 전역 스킬 (권위 있는 목록: docs/INVENTORY.md)
├── commands/gsd/*.md               # 로컬 Claude 설치는 전역 스킬 대신 슬래시 명령어 사용
├── gsd-core/
│   ├── bin/gsd-tools.cjs           # CLI 유틸리티
│   ├── bin/lib/*.cjs               # 도메인 모듈 (권위 있는 목록: docs/INVENTORY.md)
│   ├── workflows/*.md              # 워크플로우 정의 (권위 있는 목록: docs/INVENTORY.md)
│   ├── references/*.md             # 공유 레퍼런스 문서 (권위 있는 목록: docs/INVENTORY.md)
│   └── templates/                  # 계획 결과물 템플릿
├── agents/*.md                     # 에이전트 정의 (권위 있는 목록: docs/INVENTORY.md)
├── hooks/*.js                      # Node.js 훅 (statusline, guards, monitors, update check)
├── hooks/*.sh                      # 쉘 훅 (session state, commit validation, phase boundary)
├── settings.json                   # 훅 등록
└── VERSION                         # 설치된 버전 번호
```

다른 런타임의 동등한 경로:

- **OpenCode:** `~/.config/opencode/` 전역 또는 `./.opencode/` 로컬
- **Kilo:** `~/.config/kilo/` 전역 또는 `./.kilo/` 로컬
- **Gemini CLI:** `~/.gemini/` 전역 또는 `./.gemini/` 로컬
- **Codex:** `~/.codex/` 전역 또는 `./.codex/` 로컬
- **Copilot:** `~/.copilot/` 전역 또는 `./.github/` 로컬
- **Antigravity:** 자동 감지된 전역 루트 (`~/.gemini/antigravity/`, `~/.gemini/antigravity-ide/`, 또는 `~/.gemini/antigravity-cli/`) 또는 `./.agent/` 로컬
- **Cursor:** `~/.cursor/` 전역 또는 `./.cursor/` 로컬
- **Windsurf:** `~/.codeium/windsurf/` 전역 또는 `./.windsurf/` 로컬
- **Augment Code:** `~/.augment/` 전역 또는 `./.augment/` 로컬
- **Trae:** `~/.trae/` 전역 또는 `./.trae/` 로컬
- **Qwen Code:** `~/.qwen/` 전역 또는 `./.qwen/` 로컬
- **Hermes Agent:** `~/.hermes/` 전역 또는 `./.hermes/` 로컬
- **CodeBuddy:** `~/.codebuddy/` 전역 또는 `./.codebuddy/` 로컬
- **Cline:** `~/.cline/` 전역 또는 프로젝트 루트 `.clinerules` 로컬

### 프로젝트 파일 (`.planning/`)

```
.planning/
├── PROJECT.md              # 프로젝트 비전, 제약, 결정, 진화 규칙
├── REQUIREMENTS.md         # 범위 지정된 요구 사항 (v1/v2/범위 외)
├── ROADMAP.md              # 상태 추적을 포함한 단계 분류
├── STATE.md                # 살아있는 메모리: 위치, 결정, 차단, 메트릭
├── config.json             # 워크플로우 설정
├── MILESTONES.md           # 완료된 마일스톤 보관
├── research/               # /gsd-new-project의 도메인 리서치
│   ├── SUMMARY.md
│   ├── STACK.md
│   ├── FEATURES.md
│   ├── ARCHITECTURE.md
│   └── PITFALLS.md
├── codebase/               # 브라운필드 매핑 (/gsd-map-codebase 또는 /gsd-onboard에서)
├── onboarding/             # 브라운필드 온보딩 요약 (/gsd-onboard에서)
│   ├── STACK.md            # YAML 전문에 `last_mapped_commit` 포함
│   ├── ARCHITECTURE.md     # 실행 후 드리프트 게이트를 위한 (#2003)
│   ├── CONVENTIONS.md
│   ├── CONCERNS.md
│   ├── STRUCTURE.md
│   ├── TESTING.md
│   └── INTEGRATIONS.md
├── phases/
│   └── XX-phase-name/
│       ├── XX-CONTEXT.md       # 사용자 선호도 (discuss-phase에서)
│       ├── XX-RESEARCH.md      # 생태계 리서치 (plan-phase에서)
│       ├── XX-YY-PLAN.md       # 실행 계획
│       ├── XX-YY-SUMMARY.md    # 실행 결과
│       ├── XX-VERIFICATION.md  # 실행 후 검증
│       ├── XX-VALIDATION.md    # Nyquist 테스트 커버리지 매핑
│       ├── XX-UI-SPEC.md       # UI 디자인 계약 (ui-phase에서)
│       ├── XX-UI-REVIEW.md     # 시각적 감사 점수 (ui-review에서)
│       └── XX-UAT.md           # 사용자 수락 테스트 결과
├── quick/                  # 빠른 작업 추적
│   └── YYMMDD-xxx-slug/
│       ├── PLAN.md
│       └── SUMMARY.md
├── todos/
│   ├── pending/            # 캡처된 아이디어
│   └── completed/          # 완료된 할 일
├── threads/               # 영구 컨텍스트 스레드 (/gsd-thread에서)
├── seeds/                 # 미래 지향적 아이디어 (/gsd-capture --seed에서)
├── debug/                  # 활성 디버그 세션
│   ├── *.md                # 활성 세션
│   ├── resolved/           # 보관된 세션
│   └── knowledge-base.md   # 영구 디버그 학습 내용
├── ui-reviews/             # /gsd-ui-review의 스크린샷 (gitignored)
└── continue-here.md        # 컨텍스트 핸드오프 (pause-work에서)
```

### 실행 후 코드베이스 드리프트 게이트 (#2003)

`/gsd-execute-phase` 마지막 웨이브 커밋 후, 워크플로우는 비차단 `codebase_drift_gate` 단계를 실행한다(`schema_drift_gate`와 `verify_phase_goal` 사이). `last_mapped_commit..HEAD` diff를 `.planning/codebase/STRUCTURE.md`와 비교하고 네 종류의 구조적 요소를 집계한다:

1. 매핑된 경로 외부의 새 디렉터리
2. `(packages|apps)/<name>/src/index.*`의 새 배럴 내보내기
3. 새 마이그레이션 파일
4. `routes/` 또는 `api/` 하위의 새 라우트 모듈

집계가 `workflow.drift_threshold`(기본값 3)를 충족하면, 게이트는 제안된 `/gsd-map-codebase --paths …` 명령어와 함께 **경고**하거나(기본값), `gsd-codebase-mapper`를 영향받은 경로로 범위 지정하여 생성함으로써 **자동 재매핑**한다(`workflow.drift_action = auto-remap`). 감지 또는 재매핑의 오류는 로그되고 단계는 계속된다 — 드리프트 감지는 검증을 실패시킬 수 없다.

`last_mapped_commit`는 각 `.planning/codebase/*.md` 파일 상단의 YAML 전문에 있다; `bin/lib/drift.cjs`는 `readMappedCommit`와 `writeMappedCommit` 왕복 헬퍼를 제공한다.

---

## 인스톨러 아키텍처

인스톨러(`bin/install.js`, ~10,700줄)는 다음을 처리한다:

1. **런타임 감지** — 대화형 프롬프트 또는 CLI 플래그 (`--claude`, `--opencode`, `--gemini`, `--kilo`, `--codex`, `--copilot`, `--antigravity`, `--cursor`, `--windsurf`, `--augment`, `--trae`, `--qwen`, `--hermes`, `--codebuddy`, `--cline`, `--all`)
2. **위치 선택** — 전역(`--global`) 또는 로컬(`--local`)
3. **파일 배포** — commands, skills, workflows, references, templates, agents, hooks 복사
4. **런타임 적응** — 런타임별 파일 내용 변환:
  - Claude Code: 그대로 사용
  - OpenCode: 명령어/에이전트를 OpenCode 호환 플랫 명령어 + 서브에이전트 형식으로 변환
  - Kilo: Kilo 설정 경로로 OpenCode 변환 파이프라인 재사용
  - Codex: commands에서 TOML config + skills 생성
  - Copilot: 도구 이름 매핑 (Read→read, Bash→execute 등)
  - Gemini: 훅 이벤트 이름 조정 (`PostToolUse` 대신 `AfterTool`)
  - Antigravity: Google 모델 등가물을 사용한 skills-first
  - Cursor: Cursor 규칙 참조를 사용한 skills-first
  - Windsurf: Windsurf 규칙 참조를 사용한 skills-first
  - Trae: `settings.json` 또는 훅 통합 없이 `~/.trae` / `./.trae`에 skills-first 설치
  - Qwen Code: Qwen 브랜드 경로 및 프롬프트 재작성을 사용한 skills-first
  - Hermes Agent: `skills/gsd/` 하의 범주 기반 스킬
  - CodeBuddy: CodeBuddy 경로 및 프롬프트 재작성을 사용한 skills-first
  - Cline: 규칙 기반 통합을 위한 `.clinerules` 작성
  - Augment Code: 전체 스킬 변환 및 설정 관리를 사용한 skills-first
5. **경로 정규화** — `~/.claude/` 경로를 런타임별 경로로 교체
6. **설정 통합** — 런타임의 `settings.json`에 훅 등록
7. **패치 백업** — v1.17부터 로컬 수정 파일을 `gsd-local-patches/`에 백업하여 `/gsd-update --reapply`에 사용
8. **매니페스트 추적** — 깔끔한 제거를 위해 `gsd-file-manifest.json` 작성
9. **제거 모드** — `--uninstall`로 모든 GSD 파일, 훅, 설정 제거

설치 시 파일 이동, 오래된 결과물 정리, 설정 재작성, 사용자 데이터 보존은 인스톨러 마이그레이션 모듈이 관리한다. [인스톨러 마이그레이션](../installer-migrations.md)과 [ADR 0008](../adr/0008-installer-migration-module.md)을 참조하라.
마이그레이션 모듈은 레거시 설치에 대한 게이트된 최초 기준선 스캔도 소유하며, 이후 마이그레이션이 무언가를 제거하거나 재작성하기 전에 알려진 런타임 설치 표면을 분류한다.

계획 드리프트 가드(`plan_review.source_grounding`) — 실행 전에 생성된 계획에서 심볼 참조를 라이브 소스에 대해 검증하는 — 는 [ADR 22](../adr/22-plan-drift-guard.md)에 명시되어 있다.

### 플랫폼 처리

- **Windows:** 자식 프로세스에 `windowsHide`, 보호 디렉터리에 EPERM/EACCES 방지, 경로 구분자 정규화
- **WSL:** WSL에서 실행 중인 Windows Node.js 감지 및 경로 불일치 경고
- **Docker/CI:** 커스텀 설정 디렉터리 위치를 위한 `CLAUDE_CONFIG_DIR` 환경 변수 지원

---

## 훅 시스템

### 아키텍처

```
런타임 엔진 (Claude Code / Gemini CLI)
    │
    ├── statusLine 이벤트 ──► gsd-statusline.js
    │   읽기: stdin (세션 JSON)
    │   쓰기: stdout (형식화된 상태), /tmp/claude-ctx-{session}.json (브리지)
    │
    ├── PostToolUse/AfterTool 이벤트 ──► gsd-context-monitor.js
    │   읽기: stdin (도구 이벤트 JSON), /tmp/claude-ctx-{session}.json (브리지)
    │   쓰기: stdout (additionalContext 경고가 있는 hookSpecificOutput)
    │
    └── SessionStart 이벤트 ──► gsd-check-update.js
        읽기: VERSION 파일
        쓰기: ~/.claude/cache/gsd-update-check.json (백그라운드 프로세스 생성)
```

### 컨텍스트 모니터 임계값


| 잔여 컨텍스트 | 수준    | 에이전트 동작                          |
| ----------------- | -------- | --------------------------------------- |
| > 35%             | 정상   | 경고 주입 없음                     |
| ≤ 35%             | WARNING  | "복잡한 새 작업 시작 금지"       |
| ≤ 25%             | CRITICAL | "컨텍스트 거의 소진됨, 사용자에게 알릴 것" |


디바운스: 반복 경고 사이에 5번의 도구 사용. 심각도 에스컬레이션(WARNING→CRITICAL)은 디바운스를 우회한다.

### 안전 속성

- 모든 훅은 try/catch로 감싸이며 오류 시 자동 종료한다
- stdin 타임아웃 가드(3초)로 파이프 문제 시 중단 방지
- 오래된 메트릭(60초 이상)은 무시된다
- 누락된 브리지 파일은 정상적으로 처리된다 (서브에이전트, 새 세션)
- 컨텍스트 모니터는 자문적이다 — 사용자 선호도를 재정의하는 명령적 명령을 내리지 않는다

### 패키지 적법성 게이트 (v1.42.1)

리서처 → 플래너 → 실행기 파이프라인은 슬롭스쿼팅(악의적인 설치 후 스크립트와 함께 선점 등록된 AI 환각 패키지 이름)에 대한 공급망 게이트를 포함한다.

**위협 모델:** GSD는 "리서처가 패키지를 명명"에서 "실행기가 `npm install`을 실행"까지의 전체 경로를 자동화한다. `npm view`를 통과하는 환각된 이름(등록만 증명, 적법성은 아님)은 이전에는 감지되지 않고 흘러갔을 것이다. AI가 생성한 패키지 참조의 ~20%가 환각되며; 그 이름의 ~43%가 프롬프트 전반에 걸쳐 일관되게 반복되어 선점 등록이 공격자에게 경제적으로 실현 가능하다.

**게이트 계층:**

| 계층 | 컴포넌트 | 동작 |
|-------|-----------|--------|
| 리서치 | `gsd-phase-researcher` | `slopcheck install <pkgs> --json` 실행; `## Package Legitimacy Audit` 테이블을 RESEARCH.md에 작성; RESEARCH.md가 작성되기 전에 `[SLOP]` 패키지 제거 |
| 계획 | `gsd-planner` | 감사 테이블 읽기; `[ASSUMED]` 또는 `[SUS]` 설치 작업 전에 `checkpoint:human-verify` 삽입; `<threat_model>`에 `T-{phase}-SC` STRIDE 공급망 행 추가 |
| 실행 | `gsd-executor` | RULE 3은 패키지 설치를 자동 수정 범위에서 제외; 실패한 설치는 체크포인트로 표시되며 절대 자동 대체하지 않음 |

**클레임 출처 통합:** WebSearch를 통해 발견된 패키지 이름은 `npm view` 결과와 관계없이 `[ASSUMED]`(not `[VERIFIED]`)로 태그된다. 이는 설치 경계에서 출처 태그를 하드 게이트로 시행하여 기존 `[ASSUMED]` / `[VERIFIED]` / `[CITED]` 출처 시스템을 확장한다 — `[ASSUMED]`는 항상 PLAN.md에 `checkpoint:human-verify`를 생성한다.

**생태계 커버리지:** 리서처는 단일 일반 검사 대신 레지스트리별 검증 명령을 사용한다 — `npm view` (Node), `pip index versions` (Python), `cargo search` (Rust). 이는 2025년 USENIX 연구에 문서화된 ~9% 비율의 교차 생태계 환각을 잡는다.

**정상적인 성능 저하:** `slopcheck`를 사용할 수 없으면 모든 추천 패키지가 `[ASSUMED]`로 태그되고 체크포인트로 게이트가 걸린다. 리서치와 계획은 진행된다; 시스템은 누락된 도구 의존성으로 인해 절대 하드 실패하지 않는다.

**외부 의존성:** `slopcheck` (MIT, pip 설치 가능). 유지 관리가 중단되면 `[ASSUMED]`-게이트 폴백이 사람 체크포인트 커버리지를 유지한다.

---

### 보안 훅 (v1.27)

훅과 가드 계층이 더 광범위한 보안 접근 방식에 어떻게 맞는지에 대한 개념적 개요는 [보안 모델](explanation/security-model.md)을 참조하라.

**Prompt Guard** (`gsd-prompt-guard.js`):

- `.planning/` 파일에 Write/Edit 시 트리거
- 프롬프트 인젝션 패턴 스캔 (역할 재정의, 지시 우회, system 태그 인젝션)
- 자문적 전용 — 탐지를 로그하며 차단하지 않음
- 패턴은 훅 독립성을 위해 인라인으로 포함됨 (`security.cjs`의 하위 집합)

**Workflow Guard** (`gsd-workflow-guard.js`):

- `.planning/` 외부 파일에 Write/Edit 시 트리거
- GSD 워크플로우 컨텍스트 외부의 편집 감지 (활성 `/gsd-` 명령어 또는 Task 서브에이전트 없음)
- 상태 추적 변경을 위해 `/gsd-quick` 또는 `/gsd-fast` 사용 권고
- `hooks.workflow_guard: true`를 통한 옵트인 (기본값: false)

---

## 런타임 추상화

GSD는 통합된 명령어/워크플로우 아키텍처를 통해 여러 AI 코딩 런타임을 지원한다.

### 런타임 설치 계약 매트릭스

이 매트릭스는 인스톨러가 오늘 구체화하는 런타임 표면을 설명한다.
마이그레이션별 소유권과 소스 스냅샷은 [인스톨러 마이그레이션](../installer-migrations.md#runtime-configuration-contract-registry)에 있다.

| 런타임 | 전역 루트 | 로컬 루트 | 호출 표면 | 에이전트 표면 | 설정 및 훅 |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `~/.claude` | `./.claude` | 전역 `skills/gsd-*/SKILL.md`; 로컬 `commands/gsd/*.md` | `agents/gsd-*.md` | `settings.json` 훅 및 statusLine 항목 |
| OpenCode | `~/.config/opencode` | `./.opencode` | `command/gsd-*.md` | `agents/gsd-*.md` | `opencode.json` 또는 `opencode.jsonc`; GSD 훅 없음 |
| Kilo | `~/.config/kilo` | `./.kilo` | `command/gsd-*.md` | `agents/gsd-*.md` | `kilo.json` 또는 `kilo.jsonc`; GSD 훅 없음 |
| Gemini CLI | `~/.gemini` | `./.gemini` | `commands/gsd/*.toml` | `agents/gsd-*.md` | `settings.json` 기능 플래그, 훅, statusline |
| Codex | `~/.codex` | `./.codex` | `skills/gsd-*/SKILL.md` | `agents/` 소스 마크다운 + 에이전트별 TOML | `config.toml` `[agents.gsd-*]`, `[features].hooks` (정규; 레거시 별칭 `codex_hooks`는 인식되며 재설치 시 마이그레이션됨, #3566), 훅 테이블 |
| GitHub Copilot | `~/.copilot` | `./.github` | `skills/gsd-*/SKILL.md` 및 `copilot-instructions.md` | `.agent.md` 파일 | GSD 훅 또는 statusline 없음 |
| Antigravity | 자동 감지: `~/.gemini/antigravity`, `~/.gemini/antigravity-ide`, 또는 `~/.gemini/antigravity-cli` | `./.agent` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | GSD가 설치 시 Gemini 스타일 `settings.json` 훅 항목 |
| Cursor | `~/.cursor` | `./.cursor` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | `rules/` 하의 규칙 참조; GSD 훅 없음 |
| Windsurf | `~/.codeium/windsurf` | `./.windsurf` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | `rules/` 하의 규칙 참조; GSD 훅 없음 |
| Augment Code | `~/.augment` | `./.augment` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | GSD 훅 또는 statusline 없음 |
| Trae | `~/.trae` | `./.trae` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | `rules/` 하의 규칙 참조; GSD 훅 없음 |
| Qwen Code | `~/.qwen` | `./.qwen` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | 지원되는 경우 공통 GSD 설정 및 훅 항목 |
| Hermes Agent | `~/.hermes` | `./.hermes` | `skills/gsd/DESCRIPTION.md` 및 `skills/gsd/gsd-*/SKILL.md` | `agents/gsd-*.md` | 지원되는 경우 공통 GSD 설정 및 훅 항목 |
| CodeBuddy | `~/.codebuddy` | `./.codebuddy` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | 지원되는 경우 공통 GSD 설정 및 훅 항목 |
| Cline | `~/.cline` | 프로젝트 루트 | `.clinerules` | 규칙만 | GSD 훅 또는 statusline 없음 |

### 업스트림 계약 소스

런타임 설치 기대는 가용한 경우 기본 문서에 대해 확인된다. 현재 소스 스냅샷은 2026-05-11:

- Claude Code: Anthropic 슬래시 명령어, 설정, 훅, 서브에이전트 문서.
- OpenCode 및 Kilo: OpenCode 설정 문서 및 Kilo 커스텀 서브에이전트 문서.
- Gemini CLI 및 Qwen Code: 명령어/설정 문서; Qwen 명령어 문서는 2026-05-06에 마지막으로 업데이트됨.
- Codex: OpenAI Codex 문서 및 `config-schema.json`; 인스톨러는 에이전트 테이블 형태를 위한 Codex 0.124.0 호환성도 포함.
- Copilot, Cursor, Cline, Augment, Hermes, CodeBuddy: 커스텀 지시, 규칙, 스킬, 설정을 위한 벤더 문서.
- Antigravity, Windsurf, Trae: 소스가 제한된 행. 인스톨러는 현재 호환성 심을 문서화하며, 마이그레이션은 설정을 재작성하기 전에 해당 소스를 새로 고쳐야 한다.

### 추상화 포인트

1. **도구 이름 매핑** — 각 런타임은 고유한 도구 이름을 가진다 (예: Claude의 `Bash` → Copilot의 `execute`)
2. **훅 이벤트 이름** — Claude는 `PostToolUse`를 사용하고 Gemini는 `AfterTool`을 사용한다
3. **에이전트 전문** — 각 런타임은 고유한 에이전트 정의 형식을 가진다
4. **경로 컨벤션** — 각 런타임은 서로 다른 디렉터리에 설정을 저장한다
5. **모델 참조** — `inherit` 프로필은 GSD가 런타임의 모델 선택에 위임하도록 한다

인스톨러는 설치 시 모든 번역을 처리한다. 워크플로우와 에이전트는 Claude Code의 네이티브 형식으로 작성되어 배포 중에 변환된다.

---

## Related

- [다중 에이전트 오케스트레이션](explanation/multi-agent-orchestration.md)
- [보안 모델](explanation/security-model.md)
- [CLI 도구](CLI-TOOLS.md)
- [문서 인덱스](README.md)
