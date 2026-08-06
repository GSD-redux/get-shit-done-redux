# 기존 코드베이스 온보딩

이 튜토리얼에서는 이미 코드가 있는 저장소에 GSD Core를 도입합니다. 코드베이스를 매핑하고, *추가하려는* 내용을 설명하는 프로젝트를 생성한 다음, 작은 변경 사항에 대한 첫 번째 논의-계획 사이클을 실행합니다. 튜토리얼이 끝나면 GSD Core의 계획 파이프라인이 여러분의 기술 스택, 컨벤션, 그리고 관심사를 파악하게 됩니다 — 이후 계획을 수립할 때마다 이 지식을 활용합니다.

---

## 만들 것

기존 Express 애플리케이션에 `GET /health` 엔드포인트 하나를 추가합니다. 변경 사항이 충분히 작아서 진짜 핵심 교훈, 즉 GSD Core가 계획을 수립하기 전에 코드베이스를 어떻게 학습하는지에 집중할 수 있습니다.

---

## 사전 준비

- **Node.js 18 이상** — `node --version`이 `v18.x.x` 이상을 출력해야 합니다.
- **기존 프로젝트** — 코드가 이미 있는 저장소라면 무엇이든 됩니다. Express일 필요는 없으며, 이 단계들은 어떤 기술 스택에도 적용됩니다.
- **Claude Code** — 저장소 루트에서 열어둡니다.

---

## Step 1 — GSD Core 설치

저장소 루트에서 실행합니다:

```bash
npx @opengsd/gsd-core@latest
```

프롬프트가 표시되면 **Claude Code**와 **local**을 선택합니다. 다음과 같이 표시됩니다:

```text
✓ Installed 86 skills to .claude/commands/
✓ Installed agents to .claude/agents/
✓ GSD Core ready — run /gsd-new-project to start
```

---

## Step 2 — 권한 플래그로 Claude Code 시작

```bash
claude --dangerously-skip-permissions
```

> [!CAUTION]
> **The permissions flag is optional.** It skips per-file confirmation while
> GSD's sub-agents read and write files. Use it only in low-stakes or
> throwaway contexts. To keep confirmations enabled, start with `claude` instead.
> For real work, read the [security model](../explanation/security-model.md) first.


---

## Step 3 — 브라운필드 온보딩 시작

프로젝트를 생성하기 전에 GSD Core가 저장소 상태를 검사하고 안전한 다음 top-level 명령을 알려주게 하세요. 이 단계는 코드베이스 컨텍스트를 건너뛰거나 기존 planning 파일을 덮어쓰는 일을 방지합니다.

```text
/gsd-onboard
```

온보딩이 코드베이스 맵 누락을 보고하면 권장 옵션을 선택하고 출력된 `/gsd-map-codebase` handoff를 실행한 뒤 `/gsd-onboard`를 다시 실행합니다. `/gsd-onboard --fast`는 가벼운 첫 패스에는 충분하지만, `/gsd-new-project` 전에는 완전한 맵이 필요합니다. `/gsd-map-codebase`가 4개의 병렬 매퍼 서브 에이전트를 생성합니다("Spawning 4 parallel codebase mapper agents…" 메시지가 표시되며, 1–5분 소요됩니다. 중단하지 마세요). 각 에이전트는 서로 다른 관심사에 집중합니다:

| 에이전트 | 집중 영역 |
|---------|---------|
| Tech mapper | 기술 스택, 프레임워크, 의존성 |
| Architecture mapper | 패턴, 레이어, 데이터 흐름 |
| Quality mapper | 컨벤션, 테스트 방식 |
| Concerns mapper | 기술 부채, 위험 영역 |

4개 에이전트가 모두 완료되면 다음과 같이 표시됩니다:

```text
Codebase mapping complete.

Created .planning/codebase/:
- STACK.md        (47 lines) - Technologies and dependencies
- ARCHITECTURE.md (62 lines) - System design and patterns
- STRUCTURE.md    (38 lines) - Directory layout and organisation
- CONVENTIONS.md  (55 lines) - Code style and patterns
- TESTING.md      (41 lines) - Test structure and practices
- INTEGRATIONS.md (29 lines) - External services and APIs
- CONCERNS.md     (33 lines) - Technical debt and issues
```

`.planning/codebase/STACK.md`를 열어봅니다. GSD Core가 실제 파일을 읽어서 감지한 언어, 런타임, 프레임워크 버전, 주요 의존성이 표시됩니다 — 추측이 아닌 실제 데이터를 기반으로 합니다.

`.planning/codebase/CONVENTIONS.md`를 열어봅니다. 소스 코드에서 관찰한 네이밍 컨벤션, 에러 처리 패턴, 코드 스타일 규칙이 표시됩니다. GSD Core가 이 저장소를 위해 생성하는 모든 계획은 이 컨벤션을 자동으로 따릅니다.

`.planning/codebase/CONCERNS.md`를 열어봅니다. 새로운 기능 작업 전에 가장 먼저 읽어야 할 파일입니다 — 계획에 영향을 줄 수 있는 기술 부채와 취약한 영역을 드러냅니다.

---

## Step 4 — 온보딩 재실행 및 프로젝트 초기화

세션 창을 초기화합니다:

```text
/clear
```

이제 `/gsd-onboard`를 다시 실행합니다. GSD Core가 ADR, PRD, spec, RFC 또는 루트 요구사항 문서를 감지하면 먼저 권장되는 `/gsd-ingest-docs` handoff를 실행하고 이후 `/gsd-onboard`를 다시 실행하세요. 컨텍스트가 준비되면 온보딩이 프로젝트 초기화 handoff를 출력합니다:

```text
/gsd-new-project
```

GSD Core가 무엇을 만들고 싶은지 묻습니다. 전체 코드베이스에 대한 설명이 아닌 추가하려는 기능으로 답변합니다:

```text
Add a GET /health endpoint to the Express app. It should return
{ "status": "ok", "uptime": <seconds> }. We'll use it for load-balancer
health checks.
```

GSD Core는 소수의 후속 질문을 한 다음 요구사항과 로드맵 생성을 진행합니다. 이미 `ARCHITECTURE.md`와 `STACK.md`를 읽었으므로, 기존 기능을 `PROJECT.md`의 **Validated** 섹션에 자동으로 매핑합니다 — 기존 API 표면을 직접 설명할 필요가 없습니다.

모든 워크플로 설정에서 권장 기본값을 선택합니다.

로드맵 작성 서브 에이전트가 완료되면 제안 로드맵이 표시됩니다. 단일 소규모 변경은 한 단계로 구성됩니다:

```text
Proposed Roadmap

1 phase | 2 requirements mapped | All v1 requirements covered ✓

| # | Phase          | Goal                                          | Requirements |
|---|----------------|-----------------------------------------------|--------------|
| 1 | Health endpoint| GET /health returning status and uptime JSON  | HLT-01, HLT-02 |
```

로드맵을 승인합니다.

프로젝트 설정이 끝난 뒤 `/gsd-onboard`를 한 번 더 실행합니다. 이제 `PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`가 모두 있으므로 온보딩은 `.planning/onboarding/SUMMARY.md`를 생성하거나 확인합니다.

**`.planning/`에 생성되는 파일:**

```text
.planning/
  PROJECT.md          ← 프로젝트 설명; "Validated"에 기존 기능
  REQUIREMENTS.md     ← HLT-01, HLT-02
  ROADMAP.md          ← Phase 1, 상태: pending
  STATE.md            ← 세션 메모리
  config.json         ← 워크플로 설정
  onboarding/SUMMARY.md ← 온보딩 상태와 다음 명령
  codebase/           ← Step 3에서 생성된 7개의 맵 파일
```

`.planning/codebase/`는 Step 3에서 이미 생성된 것입니다. `PROJECT.md` 작성 시 GSD Core가 해당 파일들을 읽었기 때문에, 여러분이 직접 설명하지 않아도 Validated 요구사항을 채울 수 있었습니다.

---

## Step 5 — 컨텍스트 초기화 후 Phase 1 논의

```text
/clear
```

```text
/gsd-discuss-phase 1
```

GSD Core가 `CONVENTIONS.md`와 `ARCHITECTURE.md`를 읽었으므로, 질문들이 실제 코드베이스에 근거합니다 — 일반적인 조언이 아닙니다. 다음과 같은 질문을 받을 수 있습니다:

```text
> Your routes are registered in src/routes/index.js. Should the health
  endpoint live there, or in a dedicated src/routes/health.js?
  A dedicated health.js — keep routes separated.

> Your existing error middleware returns { error: "message" }. Should
  /health use the same shape for error responses?
  Yes, stay consistent.

> Should uptime be calculated from process.uptime() or a stored start time?
  process.uptime() is fine.
```

논의가 끝나면 GSD Core가 다음 파일을 생성합니다:

```text
.planning/phases/01-health-endpoint/CONTEXT.md
```

해당 파일을 열어봅니다. `## Implementation Decisions` 섹션에 여러분의 답변이 기록되어 있습니다. 플래너가 태스크를 하나도 작성하기 전에 이 파일을 읽습니다 — 따라서 파일 배치와 응답 형식에 대한 선호도가 논의뿐 아니라 계획에도 반영됩니다.

---

## Step 6 — Phase 1 계획

```text
/gsd-plan-phase 1
```

4개의 리서치 서브 에이전트가 병렬로 실행됩니다(1–5분). 완료되면 플래너가 `CONTEXT.md`, 리서치 결과, 코드베이스 맵을 읽어 컨벤션에 맞는 태스크 계획을 생성합니다.

**생성되는 파일:**

```text
.planning/phases/01-health-endpoint/
  RESEARCH.md         ← health 엔드포인트 패턴에 대한 리서치 결과
  01-01-PLAN.md       ← 태스크: src/routes/health.js 생성
  01-02-PLAN.md       ← 태스크: src/routes/index.js에 health 라우트 등록
```

`01-01-PLAN.md`를 열어봅니다. `<files>` 태그에 `src/routes/health.js`가 참조되어 있습니다 — 논의에서 지정한 정확한 경로이며, GSD Core가 코드베이스 맵에서 관찰한 라우팅 패턴과 일치합니다. 코드베이스 맵이 실제로 작동하는 모습입니다.

---

## 다음 단계

이제 코드베이스 맵, 논의 결정 기록, 검증된 태스크 계획을 갖춘 프로젝트가 완성되었습니다 — 모두 실제 코드에 근거합니다. 이후 워크플로는 그린필드 프로젝트와 동일합니다:

```text
/gsd-execute-phase 1
/gsd-verify-work 1
/gsd-ship 1
```

앞으로 새로운 기능을 추가할 때마다 구조가 크게 바뀌면 `/gsd-map-codebase`를 다시 실행하여 코드베이스 맵을 최신 상태로 유지합니다.

---

## 배운 내용

- `/gsd-onboard`가 인터랙티브 명령을 중첩하거나 기존 planning 파일을 덮어쓰지 않고 브라운필드 설정을 안전하게 순서화하는 방법.
- `/gsd-map-codebase`가 4개의 병렬 에이전트를 실행하여 `.planning/codebase/`에 `STACK.md`, `ARCHITECTURE.md`, `CONVENTIONS.md`, `CONCERNS.md`, `STRUCTURE.md`, `TESTING.md`, `INTEGRATIONS.md`를 생성하는 방법.
- 브라운필드 저장소에서 `/gsd-new-project`가 *추가하는* 것에 집중한 질문을 하고 기존 코드에서 Validated 요구사항을 채우는 방법.
- 코드베이스 맵이 `/gsd-discuss-phase`의 모든 질문을 형성하는 방법 — 파일 경로, 패턴, 컨벤션이 실제 코드에서 옵니다.
- 플래너가 `CONTEXT.md`와 `CONVENTIONS.md`를 함께 읽어 저장소 스타일에 맞는 계획을 생성하는 방법.

---

## Related

- [Your first project](your-first-project.md) — 설치부터 PR까지 전체 그린필드 루프
- [Map codebase via Commands](../COMMANDS.md) — `/gsd-map-codebase`의 모든 플래그와 서브커맨드
- [Documentation index](../README.md)
