# GSD 출시된 표면 인벤토리

> 출시된 모든 GSD 표면의 공식 목록: 명령어, 에이전트, 워크플로우, 레퍼런스, CLI 모듈, 훅. 광범위 문서(AGENTS.md, COMMANDS.md, ARCHITECTURE.md, CLI-TOOLS.md)와 파일시스템이 다를 경우, 이 파일과 저장소 트리를 진실의 원천으로 취급합니다.

## 이 파일 사용 방법

- 여기의 수량은 v1.36.0 핀 기준 파일시스템에서 도출된 것으로, 릴리스 사이에 변동될 수 있습니다. 최신 수량을 확인하려면 체크아웃에서 `ls commands/gsd/*.md | wc -l`, `ls agents/gsd-*.md | wc -l` 등을 실행하세요.
- 이 파일은 6개 패밀리(에이전트, 명령어, 워크플로우, 레퍼런스, CLI 모듈, 훅) 전반에 걸쳐 출시된 모든 표면을 열거합니다. 광범위 문서는 내러티브 또는 엄선된 하위 집합을 렌더링할 수 있습니다. 파일시스템과 불일치할 경우 이 파일과 디렉터리 목록이 권위 있는 출처입니다.
- v1.36.0 이후 추가된 새 표면은 먼저 여기에 기록된 후 광범위 문서로 전파되어야 합니다. `tests/inventory-counts.test.cjs`, `tests/commands-doc-parity.test.cjs`, `tests/agents-doc-parity.test.cjs`, `tests/cli-modules-doc-parity.test.cjs`, `tests/hooks-doc-parity.test.cjs`, `tests/architecture-counts.test.cjs`, `tests/command-count-sync.test.cjs`의 드리프트 제어 테스트가 파일시스템 대비 수량 및 목록 내용을 고정합니다.

이것은 출시된 모든 GSD Core 표면의 공식 목록입니다. 주제별 탐색은 [문서 색인](README.md)을 참조하세요.

---

## 에이전트 (33개 출시)

전체 목록은 `agents/gsd-*.md`에 있습니다. "주요 문서" 열은 [`docs/AGENTS.md`](AGENTS.md)에서 전체 역할 카드(*primary*), "고급 및 특수 에이전트" 섹션의 짧은 스텁(*advanced stub*), 또는 다루지 않음(*inventory only*)을 표시합니다.

| 에이전트 | 역할 (한 줄) | 생성자 | 주요 문서 |
|-------|-----------------|------------|-------------|
| gsd-project-researcher | 로드맵 생성 전 도메인 에코시스템 조사 (스택, 기능, 아키텍처, 함정). | `/gsd-new-project`, `/gsd-new-milestone` | primary |
| gsd-phase-researcher | 계획 전 특정 단계의 구현 방식 조사. | `/gsd-plan-phase` | primary |
| gsd-ui-researcher | 프론트엔드 단계용 UI 설계 계약 생성. | `/gsd-ui-phase` | primary |
| gsd-assumptions-analyzer | discuss-phase (가정 모드)를 위한 근거 기반 가정 생성. | `discuss-phase-assumptions` 워크플로우 | primary |
| gsd-advisor-researcher | discuss-phase 어드바이저 모드에서 단일 회색 지대 결정을 조사. | `discuss-phase` 워크플로우 (어드바이저 모드) | primary |
| gsd-research-synthesizer | 병렬 조사 결과를 통합 SUMMARY.md로 결합. | `/gsd-new-project` | primary |
| gsd-planner | 태스크 분해 및 목표 역방향 검증이 포함된 실행 가능한 단계 계획 생성. | `/gsd-plan-phase`, `/gsd-quick` | primary |
| gsd-roadmapper | 단계 분해 및 요구사항 매핑이 포함된 프로젝트 로드맵 생성. | `/gsd-new-project` | primary |
| gsd-executor | 원자적 커밋과 편차 처리로 GSD 계획 실행. | `/gsd-execute-phase`, `/gsd-quick` | primary |
| gsd-plan-checker | 계획이 단계 목표를 달성할지 검증 (8개 검증 차원). | `/gsd-plan-phase` (검증 루프) | primary |
| gsd-integration-checker | 단계 간 통합 및 엔드투엔드 플로우 검증. | `/gsd-audit-milestone` | primary |
| gsd-ui-checker | 품질 차원에 대한 UI-SPEC.md 설계 계약 검증. | `/gsd-ui-phase` (검증 루프) | primary |
| gsd-verifier | 목표 역방향 분석을 통한 단계 목표 달성 검증. | `/gsd-execute-phase` | primary |
| gsd-nyquist-auditor | 테스트 생성으로 나이퀴스트 검증 공백 채움. | `/gsd-validate-phase` | primary |
| gsd-ui-auditor | 구현된 프론트엔드 코드의 소급 6-기둥 시각 감사. | `/gsd-ui-review` | primary |
| gsd-codebase-mapper | 코드베이스 탐색 및 구조화된 분석 문서 작성. | `/gsd-map-codebase` | primary |
| gsd-debugger | 영속 상태를 사용하는 과학적 방법론으로 버그 조사. | `/gsd-debug`, `/gsd-verify-work` | primary |
| gsd-user-profiler | 8개 차원에서 개발자 행동 점수 산정. | `/gsd-profile-user` | primary |
| gsd-doc-writer | 프로젝트 문서 작성 및 업데이트. | `/gsd-docs-update` | primary |
| gsd-doc-verifier | 생성된 문서의 사실적 주장 검증. | `/gsd-docs-update` | primary |
| gsd-security-auditor | PLAN.md 위협 모델의 위협 완화 검증. | `/gsd-secure-phase` | primary |
| gsd-pattern-mapper | 새 파일을 가장 가까운 기존 유사체에 매핑; 플래너를 위한 PATTERNS.md 작성. | `/gsd-plan-phase` (조사와 계획 사이) | advanced stub |
| gsd-debug-session-manager | 격리된 컨텍스트에서 전체 `/gsd-debug` 체크포인트-및-연속 루프를 실행하여 메인 컨텍스트를 가볍게 유지. | `/gsd-debug` | advanced stub |
| gsd-code-reviewer | 버그, 보안 문제, 코드 품질 문제에 대해 소스 파일 검토; REVIEW.md 생성. | `/gsd-code-review` | advanced stub |
| gsd-code-fixer | REVIEW.md 결과에 수정 사항을 원자적 수정별 커밋으로 적용; REVIEW-FIX.md 생성. | `/gsd-code-review --fix` | advanced stub |
| gsd-ai-researcher | 선택한 AI 프레임워크의 공식 문서를 구현 준비 가이드로 조사 (AI-SPEC.md §3–§4b). | `/gsd-ai-integration-phase` | advanced stub |
| gsd-domain-researcher | AI 시스템을 위한 도메인 전문가 평가 기준 및 실패 모드 표면화 (AI-SPEC.md §1b). | `/gsd-ai-integration-phase` | advanced stub |
| gsd-eval-planner | AI 단계를 위한 구조화된 평가 전략 설계 (AI-SPEC.md §5–§7). | `/gsd-ai-integration-phase` | advanced stub |
| gsd-eval-auditor | AI 단계 평가 범위의 소급 감사; EVAL-REVIEW.md 생성 (COVERED/PARTIAL/MISSING). | `/gsd-eval-review` | advanced stub |
| gsd-framework-selector | AI/LLM 프레임워크를 점수 산정하고 추천하는 ≤6개 질문의 인터랙티브 결정 매트릭스. | `/gsd-ai-integration-phase` | advanced stub |
| gsd-intel-updater | 쿼리 가능한 코드베이스 지식 베이스로 사용되는 구조화된 인텔 파일(`.planning/intel/*.json`) 작성. | `/gsd-map-codebase --query` | advanced stub |
| gsd-doc-classifier | 단일 계획 문서를 ADR, PRD, SPEC, DOC, UNKNOWN으로 분류; 병렬로 생성되어 문서 코퍼스 처리. | `/gsd-ingest-docs` | advanced stub |
| gsd-doc-synthesizer | 분류된 계획 문서를 우선순위 규칙, 순환 감지, 세 버킷 충돌 보고서로 단일 통합 컨텍스트로 합성. | `/gsd-ingest-docs` | advanced stub |

**커버리지 참고.** `docs/AGENTS.md`는 21개 주요 에이전트에 대한 전체 역할 카드와 12개 고급 에이전트에 대한 간결한 스텁을 제공합니다. 해당 파일의 에이전트 도구 권한 요약은 주요 21개 에이전트만 다루며; 고급 에이전트의 도구 목록은 `agents/gsd-*.md`의 에이전트별 프론트매터에 기록됩니다.

---

## 명령어 (67개 출시)

전체 목록은 `commands/gsd/*.md`에 있습니다. 아래 그룹화는 `docs/COMMANDS.md` 섹션 순서를 반영합니다. 각 행은 명령어 이름, 명령어의 프론트매터 `description:`에서 도출된 한 줄 역할, 소스 파일 링크를 포함합니다. `tests/command-count-sync.test.cjs`가 파일시스템 대비 수량을 고정합니다.

### 네임스페이스 메타 스킬

이 6개의 라우터는 모델이 먼저 선택하는 설명자 전용 항목입니다. 각각의 본문에는 올바른 구체적 하위 스킬을 가리키는 라우팅 테이블이 포함되어 있습니다. 이는 전체 표면에 접근 가능하게 유지하면서 즉시 스킬 목록 토큰 비용을 낮게 유지하기 위한 것입니다. 근거는 [#2792](https://github.com/open-gsd/gsd-core/issues/2792) 참조; 라우팅 테이블은 [#2790](https://github.com/open-gsd/gsd-core/issues/2790) 이후 통합된 표면을 대상으로 합니다.

| 명령어 | 역할 | 소스 |
|---------|------|--------|
| `/gsd-workflow` | 단계 파이프라인 라우터 — discuss / plan / execute / verify / phase / progress. | [commands/gsd/ns-workflow.md](../../commands/gsd/ns-workflow.md) |
| `/gsd-project` | 프로젝트 라이프사이클 라우터 — 마일스톤, 감사, 요약. | [commands/gsd/ns-project.md](../../commands/gsd/ns-project.md) |
| `/gsd-quality` | 품질 게이트 라우터 — 코드 리뷰, 디버그, 감사, 보안, 평가, UI. | [commands/gsd/ns-review.md](../../commands/gsd/ns-review.md) |
| `/gsd-context` | 코드베이스 인텔리전스 라우터 — 맵, 그래프화, 문서, 학습. | [commands/gsd/ns-context.md](../../commands/gsd/ns-context.md) |
| `/gsd-manage` | 관리 라우터 — 설정, 워크스페이스, 워크스트림, 스레드, 업데이트, 출시, 인박스. | [commands/gsd/ns-manage.md](../../commands/gsd/ns-manage.md) |
| `/gsd-ideate` | 탐색 및 캡처 라우터 — 탐색, 스케치, 스파이크, 스펙, 캡처. | [commands/gsd/ns-ideate.md](../../commands/gsd/ns-ideate.md) |

### 핵심 워크플로우

| 명령어 | 역할 | 소스 |
|---------|------|--------|
| `/gsd-new-project` | 심층 컨텍스트 수집 및 PROJECT.md로 새 프로젝트 초기화. | [commands/gsd/new-project.md](../../commands/gsd/new-project.md) |
| `/gsd-onboard` | 기존 코드베이스를 매핑, 문서 수집, 프로젝트 설정, onboarding summary로 안내합니다. | [commands/gsd/onboard.md](../../commands/gsd/onboard.md) |
| `/gsd-workspace` | GSD 워크스페이스 관리 — 격리된 워크스페이스 환경을 생성(`--new`), 목록(`--list`), 또는 제거(`--remove`). | [commands/gsd/workspace.md](../../commands/gsd/workspace.md) |
| `/gsd-discuss-phase` | 계획 전 적응형 질문을 통한 단계 컨텍스트 수집. | [commands/gsd/discuss-phase.md](../../commands/gsd/discuss-phase.md) |
| `/gsd-mvp-phase` | 수직 MVP 슬라이스로 단계 계획 — 사용자 스토리, SPIDR 분할, 이후 plan-phase. | [commands/gsd/mvp-phase.md](../../commands/gsd/mvp-phase.md) |
| `/gsd-spec-phase` | 반증 가능한 요구사항을 담은 SPEC.md를 생성하는 소크라테스식 스펙 정제. | [commands/gsd/spec-phase.md](../../commands/gsd/spec-phase.md) |
| `/gsd-ui-phase` | 프론트엔드 단계용 UI 설계 계약(UI-SPEC.md) 생성. | [commands/gsd/ui-phase.md](../../commands/gsd/ui-phase.md) |
| `/gsd-ai-integration-phase` | 프레임워크 선택, 조사, 평가 계획을 통한 AI 설계 계약(AI-SPEC.md) 생성. | [commands/gsd/ai-integration-phase.md](../../commands/gsd/ai-integration-phase.md) |
| `/gsd-plan-phase` | 검증 루프가 포함된 상세 단계 계획(PLAN.md) 생성. | [commands/gsd/plan-phase.md](../../commands/gsd/plan-phase.md) |
| `/gsd-plan-review-convergence` | 교차 AI 계획 수렴 루프 — HIGH 우려사항이 없을 때까지 리뷰 피드백으로 재계획 (최대 3사이클). | [commands/gsd/plan-review-convergence.md](../../commands/gsd/plan-review-convergence.md) |
| `/gsd-ultraplan-phase` | [BETA] 계획 단계를 Claude Code의 ultraplan 클라우드에 오프로드 — 원격으로 초안 작성, 브라우저에서 검토, `/gsd-import`로 가져오기. Claude Code 전용. | [commands/gsd/ultraplan-phase.md](../../commands/gsd/ultraplan-phase.md) |
| `/gsd-spike` | 일회성 실험으로 아이디어를 빠르게 스파이크; `--wrap-up`으로 결과를 영구 스킬로 패키징. | [commands/gsd/spike.md](../../commands/gsd/spike.md) |
| `/gsd-sketch` | 일회성 HTML 목업을 사용한 UI/설계 아이디어 빠른 스케치; `--wrap-up`으로 결과 패키징. | [commands/gsd/sketch.md](../../commands/gsd/sketch.md) |
| `/gsd-execute-phase` | 웨이브 기반 병렬화로 단계의 모든 계획 실행. | [commands/gsd/execute-phase.md](../../commands/gsd/execute-phase.md) |
| `/gsd-verify-work` | 자동 진단을 포함한 대화형 UAT로 구축된 기능 검증. | [commands/gsd/verify-work.md](../../commands/gsd/verify-work.md) |
| `/gsd-ship` | 검증 후 PR 생성, 리뷰 실행, 병합 준비. | [commands/gsd/ship.md](../../commands/gsd/ship.md) |
| `/gsd-fast` | 하위 에이전트 없이, 계획 오버헤드 없이 인라인으로 사소한 태스크 실행. | [commands/gsd/fast.md](../../commands/gsd/fast.md) |
| `/gsd-quick` | GSD 보장(원자적 커밋, 상태 추적)으로 빠른 태스크 실행, 선택적 에이전트는 생략. | [commands/gsd/quick.md](../../commands/gsd/quick.md) |
| `/gsd-ui-review` | 구현된 프론트엔드 코드의 소급 6-기둥 시각 감사. | [commands/gsd/ui-review.md](../../commands/gsd/ui-review.md) |
| `/gsd-code-review` | 단계에서 변경된 소스 파일을 버그, 보안, 코드 품질 문제에 대해 검토; `--fix`로 결과 자동 적용. | [commands/gsd/code-review.md](../../commands/gsd/code-review.md) |
| `/gsd-eval-review` | 실행된 AI 단계의 평가 범위를 소급 감사; EVAL-REVIEW.md 생성. | [commands/gsd/eval-review.md](../../commands/gsd/eval-review.md) |

### 단계 및 마일스톤 관리

| 명령어 | 역할 | 소스 |
|---------|------|--------|
| `/gsd-phase` | 단계 CRUD — ROADMAP.md에서 단계 추가(기본값), 삽입(`--insert`), 제거(`--remove`), 편집(`--edit`). | [commands/gsd/phase.md](../../commands/gsd/phase.md) |
| `/gsd-add-tests` | UAT 기준 및 구현에 기반한 완료된 단계의 테스트 생성. | [commands/gsd/add-tests.md](../../commands/gsd/add-tests.md) |
| `/gsd-validate-phase` | 완료된 단계의 나이퀴스트 검증 공백을 소급 감사 및 채움. | [commands/gsd/validate-phase.md](../../commands/gsd/validate-phase.md) |
| `/gsd-secure-phase` | 완료된 단계의 위협 완화를 소급 검증. | [commands/gsd/secure-phase.md](../../commands/gsd/secure-phase.md) |
| `/gsd-audit-milestone` | 아카이브 전 원래 의도 대비 마일스톤 완료 감사. | [commands/gsd/audit-milestone.md](../../commands/gsd/audit-milestone.md) |
| `/gsd-audit-uat` | 미완료된 모든 UAT 및 검증 항목의 단계 간 감사. | [commands/gsd/audit-uat.md](../../commands/gsd/audit-uat.md) |
| `/gsd-audit-fix` | 자율 감사-수정 파이프라인 — 문제 찾기, 분류, 수정, 테스트, 커밋. | [commands/gsd/audit-fix.md](../../commands/gsd/audit-fix.md) |
| `/gsd-complete-milestone` | 완료된 마일스톤 아카이브 및 다음 버전 준비. | [commands/gsd/complete-milestone.md](../../commands/gsd/complete-milestone.md) |
| `/gsd-new-milestone` | 새 마일스톤 사이클 시작 — PROJECT.md 업데이트 및 요구사항으로 라우팅. | [commands/gsd/new-milestone.md](../../commands/gsd/new-milestone.md) |
| `/gsd-milestone-summary` | 마일스톤 아티팩트로부터 포괄적인 프로젝트 요약 생성. | [commands/gsd/milestone-summary.md](../../commands/gsd/milestone-summary.md) |
| `/gsd-cleanup` | 완료된 마일스톤에서 누적된 단계 디렉터리 아카이브. | [commands/gsd/cleanup.md](../../commands/gsd/cleanup.md) |
| `/gsd-manager` | 하나의 터미널에서 여러 단계를 관리하는 인터랙티브 커맨드 센터. | [commands/gsd/manager.md](../../commands/gsd/manager.md) |
| `/gsd-workstreams` | 병렬 워크스트림 관리 — 목록, 생성, 전환, 상태, 진행도, 완료, 재개. | [commands/gsd/workstreams.md](../../commands/gsd/workstreams.md) |
| `/gsd-autonomous` | 나머지 모든 단계를 자율적으로 실행 — 단계별 discuss → plan → execute. | [commands/gsd/autonomous.md](../../commands/gsd/autonomous.md) |
| `/gsd-undo` | 안전한 git 되돌리기 — 단계 매니페스트를 사용하여 단계 또는 계획 커밋 롤백. | [commands/gsd/undo.md](../../commands/gsd/undo.md) |

### 세션 및 탐색

| 명령어 | 역할 | 소스 |
|---------|------|--------|
| `/gsd-progress` | 프로젝트 진행도 확인, 컨텍스트 표시, 다음 액션으로 라우팅; `--next`로 자동 진행 또는 `--do`로 자유 형식 태스크 실행. | [commands/gsd/progress.md](../../commands/gsd/progress.md) |
| `/gsd-capture` | 아이디어, 태스크, 메모, 씨앗 캡처 — todo(기본값), `--note`, `--backlog`, `--seed`, 또는 `--list` 미완료 todo. | [commands/gsd/capture.md](../../commands/gsd/capture.md) |
| `/gsd-stats` | 프로젝트 통계 표시 — 단계, 계획, 요구사항, git 메트릭, 타임라인. | [commands/gsd/stats.md](../../commands/gsd/stats.md) |
| `/gsd-pause-work` | 단계 중간에 작업을 일시 중지할 때 컨텍스트 핸드오프 생성. | [commands/gsd/pause-work.md](../../commands/gsd/pause-work.md) |
| `/gsd-resume-work` | 이전 세션에서 전체 컨텍스트 복원으로 작업 재개. | [commands/gsd/resume-work.md](../../commands/gsd/resume-work.md) |
| `/gsd-explore` | 소크라테스식 아이디어 발상 및 라우팅 — 커밋 전 아이디어 심화 검토. | [commands/gsd/explore.md](../../commands/gsd/explore.md) |
| `/gsd-review-backlog` | 백로그 항목 검토 및 활성 마일스톤으로 승격. | [commands/gsd/review-backlog.md](../../commands/gsd/review-backlog.md) |
| `/gsd-thread` | 세션 간 작업을 위한 영속 컨텍스트 스레드 관리. | [commands/gsd/thread.md](../../commands/gsd/thread.md) |

### 코드베이스 인텔리전스

| 명령어 | 역할 | 소스 |
|---------|------|--------|
| `/gsd-map-codebase` | 병렬 매퍼 에이전트로 코드베이스 분석; 경량 스캔은 `--fast`, 인텔 쿼리는 `--query`. | [commands/gsd/map-codebase.md](../../commands/gsd/map-codebase.md) |
| `/gsd-graphify` | `.planning/graphs/`의 프로젝트 지식 그래프 구축, 쿼리, 검사. | [commands/gsd/graphify.md](../../commands/gsd/graphify.md) |
| `/gsd-extract-learnings` | 완료된 단계 아티팩트에서 결정, 교훈, 패턴, 놀라운 점 추출. | [commands/gsd/extract-learnings.md](../../commands/gsd/extract-learnings.md) |

### 리뷰, 디버그 및 복구

| 명령어 | 역할 | 소스 |
|---------|------|--------|
| `/gsd-review` | 외부 AI CLI에서 단계 계획의 교차 AI 피어 리뷰 요청. | [commands/gsd/review.md](../../commands/gsd/review.md) |
| `/gsd-debug` | 컨텍스트 재설정 전반에 걸쳐 영속 상태를 사용하는 체계적 디버깅. | [commands/gsd/debug.md](../../commands/gsd/debug.md) |
| `/gsd-forensics` | 실패한 GSD 워크플로우의 사후 조사 — git, 아티팩트, 상태 분석. | [commands/gsd/forensics.md](../../commands/gsd/forensics.md) |
| `/gsd-health` | 계획 디렉터리 상태를 진단하고 선택적으로 문제 수정. | [commands/gsd/health.md](../../commands/gsd/health.md) |
| `/gsd-import` | 프로젝트 결정에 대한 충돌 감지로 외부 계획 수집. | [commands/gsd/import.md](../../commands/gsd/import.md) |
| `/gsd-inbox` | 프로젝트 템플릿에 대한 모든 열린 GitHub 이슈 및 PR 분류 및 검토. | [commands/gsd/inbox.md](../../commands/gsd/inbox.md) |

### 문서, 프로필 및 유틸리티

| 명령어 | 역할 | 소스 |
|---------|------|--------|
| `/gsd-docs-update` | 코드베이스에 대해 검증된 프로젝트 문서 생성 또는 업데이트. | [commands/gsd/docs-update.md](../../commands/gsd/docs-update.md) |
| `/gsd-ingest-docs` | 혼합 ADR/PRD/SPEC/DOC가 있는 저장소를 스캔하고 분류, 합성, 충돌 보고서로 전체 `.planning/` 설정을 부트스트랩 또는 병합. | [commands/gsd/ingest-docs.md](../../commands/gsd/ingest-docs.md) |
| `/gsd-profile-user` | 개발자 행동 프로필 및 Claude 검색 가능한 아티팩트 생성. | [commands/gsd/profile-user.md](../../commands/gsd/profile-user.md) |
| `/gsd-settings` | GSD 워크플로우 토글 및 모델 프로필 구성. | [commands/gsd/settings.md](../../commands/gsd/settings.md) |
| `/gsd-config` | GSD 설정 구성 — 워크플로우 토글(기본값), 고급 설정(`--advanced`), 통합(`--integrations`), 또는 모델 프로필(`--profile`). | [commands/gsd/config.md](../../commands/gsd/config.md) |
| `/gsd-pr-branch` | `.planning/` 커밋을 필터링하여 깔끔한 PR 브랜치 생성. | [commands/gsd/pr-branch.md](../../commands/gsd/pr-branch.md) |
| `/gsd-surface` | 표면화할 스킬 토글 — 재설치 없이 프로필 적용, 목록 보기, 클러스터 비활성화. | [commands/gsd/surface.md](../../commands/gsd/surface.md) |
| `/gsd-update` | GSD를 최신 버전으로 업데이트; `--sync`로 런타임 간 스킬 동기화 또는 `--reapply`로 로컬 패치 재적용. | [commands/gsd/update.md](../../commands/gsd/update.md) |
| `/gsd-help` | 사용 가능한 GSD 명령어 및 사용 가이드 표시. | [commands/gsd/help.md](../../commands/gsd/help.md) |

---

## 워크플로우 (88개 출시)

전체 목록은 `gsd-core/workflows/*.md`에 있습니다. 워크플로우는 명령어가 내부적으로 참조하는 얇은 오케스트레이터입니다; 대부분은 최종 사용자가 직접 읽지 않습니다. 아래 행은 각 워크플로우 파일을 역할(`<purpose>` 블록에서 도출)과, 해당하는 경우 호출 명령어에 매핑합니다.

| 워크플로우 | 역할 | 호출자 |
|----------|------|------------|
| `add-backlog.md` | 999.x 번호 체계를 사용하여 ROADMAP.md에 백로그 항목 추가. | `/gsd-capture --backlog` |
| `add-phase.md` | 로드맵의 현재 마일스톤 끝에 새 정수 단계 추가. | `/gsd-phase` (기본값) |
| `add-tests.md` | 완료된 단계의 아티팩트를 기반으로 단위 및 E2E 테스트 생성. | `/gsd-add-tests` |
| `add-todo.md` | 세션 중 발생하는 아이디어나 태스크를 구조화된 todo로 캡처. | `/gsd-capture` (기본값) |
| `ai-integration-phase.md` | 프레임워크 선택 → AI 조사 → 도메인 조사 → 평가 계획을 AI-SPEC.md로 오케스트레이션. | `/gsd-ai-integration-phase` |
| `analyze-dependencies.md` | 파일 겹침 및 의미론적 의존성에 대한 ROADMAP.md 단계 분석; `Depends on` 엣지 제안. | `/gsd-manager --analyze-deps` |
| `audit-fix.md` | 자율 감사-수정 파이프라인 — 감사 실행, 파싱, 분류, 수정, 테스트, 커밋. | `/gsd-audit-fix` |
| `audit-milestone.md` | 단계 검증을 집계하여 마일스톤이 완료 정의를 충족했는지 확인. | `/gsd-audit-milestone` |
| `audit-uat.md` | UAT 및 검증 파일의 단계 간 감사; 우선순위화된 미완료 항목 목록 생성. | `/gsd-audit-uat` |
| `autonomous.md` | 마일스톤 단계를 자율적으로 구동 — 나머지 모두, 범위, 또는 단일 단계. | `/gsd-autonomous` |
| `check-todos.md` | 미완료 todo 목록, 선택 허용, 컨텍스트 로드, 적절한 액션으로 라우팅. | `/gsd-capture --list` |
| `cleanup.md` | 완료된 마일스톤에서 누적된 단계 디렉터리 아카이브. | `/gsd-cleanup` |
| `code-review-fix.md` | gsd-code-fixer를 통해 수정별 원자적 커밋으로 REVIEW.md의 문제 자동 수정. | `/gsd-code-review --fix` |
| `code-review.md` | gsd-code-reviewer를 통한 단계 소스 변경 검토; REVIEW.md 생성. | `/gsd-code-review` |
| `complete-milestone.md` | 출시된 버전을 완료로 표시 — MILESTONES.md 항목, PROJECT.md 발전, 태그. | `/gsd-complete-milestone` |
| `diagnose-issues.md` | UAT 공백 조사 및 근본 원인 찾기를 위한 병렬 디버그 에이전트 오케스트레이션. | `/gsd-verify-work` (자동 진단) |
| `discovery-phase.md` | 적절한 깊이 수준에서 탐색 실행. | `/gsd-new-project` (탐색 경로) |
| `discuss-phase-assumptions.md` | 가정 모드 discuss — 코드베이스 우선 분석을 통한 구현 결정 추출. | `/gsd-discuss-phase` (`discuss_mode=assumptions`일 때) |
| `discuss-phase-power.md` | 파워 유저 discuss — 모든 질문을 JSON 상태 파일 + HTML UI로 사전 생성. | `/gsd-discuss-phase --power` |
| `discuss-phase.md` | 반복적인 회색 지대 토론을 통한 구현 결정 추출. | `/gsd-discuss-phase` |
| `mvp-phase.md` | 수직 MVP 슬라이스로 단계 계획 — 사용자 스토리, SPIDR 분할, 이후 plan-phase. | `/gsd-mvp-phase` |
| `do.md` | 사용자의 자유 형식 텍스트를 가장 적합한 GSD 명령어로 라우팅. | `/gsd-progress --do` |
| `docs-update.md` | 표준 및 수작업 프로젝트 문서 생성, 업데이트, 검증. | `/gsd-docs-update` |
| `edit-phase.md` | ROADMAP.md에서 기존 단계의 임의 필드를 번호와 위치를 유지한 채 인플레이스 편집. | `/gsd-phase --edit` |
| `eval-review.md` | 구현된 AI 단계의 평가 범위에 대한 소급 감사. | `/gsd-eval-review` |
| `execute-phase.md` | 웨이브 기반 병렬 실행으로 단계의 모든 계획 실행. | `/gsd-execute-phase` |
| `execute-plan.md` | 단계 프롬프트(PLAN.md)를 실행하고 결과 요약(SUMMARY.md) 생성. | `execute-phase.md` (계획별 하위 에이전트) |
| `explore.md` | 소크라테스식 아이디어 발상 — 탐색적 질문으로 개발자 안내. | `/gsd-explore` |
| `debug.md` | 체계적 디버깅 — 하위 명령어 라우팅, 세션 생성, gsd-debug-session-manager 위임. | `/gsd-debug` |
| `extract-learnings.md` | 완료된 단계 아티팩트에서 결정, 교훈, 패턴, 놀라운 점 추출. | `/gsd-extract-learnings` |
| `fast.md` | 하위 에이전트 오버헤드 없이 사소한 태스크 인라인 실행. | `/gsd-fast` |
| `forensics.md` | 실패한 워크플로우의 포렌식 조사 — git, 아티팩트, 상태 분석. | `/gsd-forensics` |
| `graduation.md` | 단계 간 반복되는 LEARNINGS.md 항목을 클러스터링하고 HITL 승격 후보 표면화. | `transition.md` (graduation_scan 단계) |
| `health.md` | `.planning/` 디렉터리 무결성 검증 및 실행 가능한 문제 보고. | `/gsd-health` |
| `help.md` | 전체 GSD Core 명령어 참조 표시. | `/gsd-help` |
| `import.md` | 기존 프로젝트 결정에 대한 충돌 감지로 외부 계획 수집. | `/gsd-import` |
| `inbox.md` | 프로젝트 기여 템플릿에 대한 열린 GitHub 이슈 및 PR 분류. | `/gsd-inbox` |
| `ingest-docs.md` | 혼합 계획 문서에 대한 저장소 스캔; 분류, 합성, 충돌 보고서로 `.planning/`에 부트스트랩 또는 병합. | `/gsd-ingest-docs` |
| `insert-phase.md` | 마일스톤 중간에 발견된 긴급 작업을 위한 소수점 단계 삽입. | `/gsd-phase --insert` |
| `list-phase-assumptions.md` | 계획 전 Claude의 단계에 대한 가정 표면화. | `/gsd-discuss-phase --assumptions` |
| `list-workspaces.md` | `~/gsd-workspaces/`에서 찾은 모든 GSD 워크스페이스를 상태와 함께 목록. | `/gsd-workspace --list` |
| `manager.md` | 인터랙티브 마일스톤 커맨드 센터 — 대시보드, 인라인 discuss, 백그라운드 plan/execute. | `/gsd-manager` |
| `map-codebase.md` | 병렬 코드베이스 매퍼 에이전트를 오케스트레이션하여 `.planning/codebase/` 문서 생성. | `/gsd-map-codebase` |
| `milestone-summary.md` | 마일스톤 아티팩트에서 온보딩 및 검토용 마일스톤 요약 합성. | `/gsd-milestone-summary` |
| `new-milestone.md` | 새 마일스톤 사이클 시작 — 프로젝트 컨텍스트 로드, 목표 수집, PROJECT.md/STATE.md 업데이트. | `/gsd-new-milestone` |
| `new-project.md` | 통합 새 프로젝트 플로우 — 질문, 조사(선택), 요구사항, 로드맵. | `/gsd-new-project` |
| `onboard.md` | Brownfield 온보딩 오케스트레이션 — 코드베이스 매핑, 문서 수집, planning 초기화, 다음 단계 요약. | `/gsd-onboard` |
| `new-workspace.md` | 저장소 워크트리/클론과 독립적인 `.planning/`이 포함된 격리된 워크스페이스 생성. | `/gsd-workspace --new` |
| `next.md` | 현재 프로젝트 상태를 감지하고 다음 논리적 단계로 자동 진행. | `/gsd-progress --next` |
| `node-repair.md` | 실패한 태스크 검증을 위한 자율 수리 오퍼레이터; `execute-plan`에 의해 호출. | `execute-plan.md` (복구) |
| `note.md` | 마찰 없는 아이디어 캡처 — 단일 Write 호출, 단일 확인 줄. | `/gsd-capture --note` |
| `pause-work.md` | 구조화된 `.planning/HANDOFF.json` 및 `.continue-here.md` 핸드오프 파일 생성. | `/gsd-pause-work` |
| `plan-phase.md` | 통합 조사 및 검증 루프로 실행 가능한 PLAN.md 파일 생성. | `/gsd-plan-phase`, `/gsd-quick` |
| `plan-review-convergence.md` | 교차 AI 계획 수렴 루프 — HIGH 우려사항이 없을 때까지 리뷰 피드백으로 재계획. | `/gsd-plan-review-convergence` |
| `plant-seed.md` | 트리거 조건이 포함된 구조화된 씨앗 파일로 미래 지향적인 아이디어 캡처. | `/gsd-capture --seed` |
| `pr-branch.md` | `.planning/` 커밋을 필터링하여 풀 리퀘스트를 위한 깔끔한 브랜치 생성. | `/gsd-pr-branch` |
| `profile-user.md` | 전체 개발자 프로파일링 플로우 오케스트레이션 — 동의, 세션 스캔, 프로필 생성. | `/gsd-profile-user` |
| `progress.md` | 진행도 렌더링 — 프로젝트 컨텍스트, 위치, 다음 액션 라우팅. | `/gsd-progress` |
| `quick.md` | GSD 보장(원자적 커밋, 상태 추적)으로 빠른 태스크 실행. | `/gsd-quick` |
| `reapply-patches.md` | GSD 업데이트 후 로컬 수정 사항 재적용. | `/gsd-update --reapply` |
| `remove-phase.md` | 로드맵에서 미래 단계를 제거하고 후속 단계 번호 재지정. | `/gsd-phase --remove` |
| `remove-workspace.md` | GSD 워크스페이스 제거 및 워크트리 정리. | `/gsd-workspace --remove` |
| `resume-project.md` | 작업 재개 — STATE.md, HANDOFF.json, 아티팩트에서 전체 컨텍스트 복원. | `/gsd-resume-work` |
| `review.md` | 외부 CLI를 통한 교차 AI 계획 리뷰; REVIEWS.md 생성. | `/gsd-review` |
| `scan.md` | 신속한 단일 포커스 코드베이스 스캔 — map-codebase의 경량 대안. | `/gsd-map-codebase --fast` |
| `secure-phase.md` | 완료된 단계에 대한 소급 위협 완화 감사. | `/gsd-secure-phase` |
| `session-report.md` | 세션 보고서 — 토큰 사용량, 작업 요약, 결과. | `/gsd-pause-work --report` |
| `settings.md` | GSD 워크플로우 토글 및 모델 프로필 구성. | `/gsd-settings`, `/gsd-config --profile` |
| `settings-advanced.md` | GSD 파워 유저 설정 구성 — 계획 바운스, 타임아웃, 브랜치 템플릿, 교차 AI 실행, 런타임 설정. | `/gsd-config --advanced` |
| `settings-integrations.md` | 타사 API 키(Brave/Firecrawl/Exa), `review.models.<cli>` CLI 라우팅, 마스킹된(`****<last-4>`) 표시로 `agent_skills.<agent-type>` 주입 구성. | `/gsd-config --integrations` |
| `ship.md` | 검증 후 PR 생성, 리뷰 실행, 병합 준비. | `/gsd-ship` |
| `sketch.md` | 스케치당 2-3개 변형으로 일회성 HTML 목업을 통한 설계 방향 탐색. | `/gsd-sketch` |
| `sketch-wrap-up.md` | 스케치 결과를 큐레이션하고 영구 `sketch-findings-[project]` 스킬로 패키징. | `/gsd-sketch --wrap-up` |
| `spec-phase.md` | 모호성 점수가 포함된 소크라테스식 스펙 정제; SPEC.md 생성. | `/gsd-spec-phase` |
| `spike.md` | 포커스된 일회성 실험을 통한 빠른 실현 가능성 검증. | `/gsd-spike` |
| `spike-wrap-up.md` | 스파이크 결과를 큐레이션하고 영구 `spike-findings-[project]` 스킬로 패키징. | `/gsd-spike --wrap-up` |
| `stats.md` | 프로젝트 통계 렌더링 — 단계, 계획, 요구사항, git 메트릭. | `/gsd-stats` |
| `sync-skills.md` | 교차 런타임 GSD 스킬 동기화 — 런타임 루트 간 `gsd-*` 스킬 디렉터리 비교 및 적용. | `/gsd-update --sync` |
| `transition.md` | 단계 경계 전환 워크플로우 — 워크스트림 확인, 상태 진행. | `execute-phase.md`, `/gsd-progress --next` |
| `ui-phase.md` | gsd-ui-researcher를 통한 UI-SPEC.md 설계 계약 생성. | `/gsd-ui-phase` |
| `ui-review.md` | gsd-ui-auditor를 통한 소급 6-기둥 시각 감사. | `/gsd-ui-review` |
| `ultraplan-phase.md` | [BETA] 계획을 Claude Code의 ultraplan 클라우드에 오프로드; 원격으로 초안 작성 후 `/gsd-import`로 가져오기. | `/gsd-ultraplan-phase` |
| `undo.md` | 안전한 git 되돌리기 — 단계 매니페스트를 사용한 단계 또는 계획 커밋. | `/gsd-undo` |
| `thread.md` | 세션 간 작업을 위한 영속 컨텍스트 스레드 생성, 목록, 닫기, 재개. | `/gsd-thread` |
| `update.md` | 체인지로그 표시와 함께 GSD를 최신 버전으로 업데이트. | `/gsd-update` |
| `validate-phase.md` | 완료된 단계의 나이퀴스트 검증 공백을 소급 감사 및 채움. | `/gsd-validate-phase` |
| `verify-phase.md` | 목표 역방향 분석을 통한 단계 목표 달성 검증. | `execute-phase.md` (실행 후) |
| `verify-work.md` | 자동 진단이 포함된 대화형 UAT — UAT.md 및 수정 계획 생성. | `/gsd-verify-work` |

> **참고:** 일부 워크플로우는 직접적인 사용자 대면 명령어가 없습니다(예: `execute-plan.md`, `verify-phase.md`, `transition.md`, `node-repair.md`, `diagnose-issues.md`) — 이들은 오케스트레이터 워크플로우에 의해 내부적으로 호출됩니다. `discovery-phase.md`는 `/gsd-new-project`의 대체 진입점입니다.

---

## 레퍼런스 (62개 출시)

전체 목록은 `gsd-core/references/*.md`에 있습니다. 레퍼런스는 워크플로우와 에이전트가 `@-참조`하는 공유 지식 문서입니다. 아래 그룹화는 [`docs/ARCHITECTURE.md`](ARCHITECTURE.md#references-gsd-corereferencesmd) — 코어, 워크플로우, 씽킹 모델 클러스터, 모듈식 플래너 분해에 일치합니다.

### 코어 레퍼런스

| 레퍼런스 | 역할 |
|-----------|------|
| `checkpoints.md` | 체크포인트 유형 정의 및 상호작용 패턴. |
| `gates.md` | plan-checker 및 verifier에 연결된 4개 표준 게이트 유형(Confirm, Quality, Safety, Transition). |
| `model-profiles.md` | 에이전트별 모델 티어 할당. |
| `model-profile-resolution.md` | 모델 해석 알고리즘 문서. |
| `verification-patterns.md` | 다양한 아티팩트 유형 검증 방법. |
| `verification-overrides.md` | 아티팩트별 검증 재정의 규칙. |
| `planning-config.md` | 전체 설정 스키마 및 동작. |
| `git-integration.md` | Git 커밋, 브랜칭, 히스토리 패턴. |
| `git-planning-commit.md` | 계획 디렉터리 커밋 관례. |
| `questioning.md` | 프로젝트 초기화를 위한 꿈 추출 철학. |
| `tdd.md` | 테스트 주도 개발 통합 패턴. |
| `ui-brand.md` | 시각적 출력 포매팅 패턴. |
| `common-bug-patterns.md` | 코드 리뷰 및 검증을 위한 일반적인 버그 패턴. |
| `debugger-philosophy.md` | `gsd-debugger`가 로드하는 상시 디버깅 원칙. |
| `mandatory-initial-read.md` | 에이전트 프롬프트에 주입되는 공유 필수 읽기 상용구. |
| `project-skills-discovery.md` | 에이전트 프롬프트에 주입되는 공유 프로젝트 스킬 발견 상용구. |

### 워크플로우 레퍼런스

| 레퍼런스 | 역할 |
|-----------|------|
| `agent-contracts.md` | 오케스트레이터와 에이전트 간의 공식 인터페이스. |
| `context-budget.md` | 컨텍스트 윈도우 예산 할당 규칙. |
| `continuation-format.md` | 세션 연속/재개 포맷. |
| `domain-probes.md` | discuss-phase를 위한 도메인별 탐색 질문. |
| `gate-prompts.md` | 게이트/체크포인트 프롬프트 템플릿. |
| `scout-codebase.md` | discuss-phase 스카우트 단계를 위한 단계 유형→코드베이스 맵 선택 테이블(discuss-phase/modes 프로그레시브 디스클로저 분할을 통해 추출, #717). |
| `revision-loop.md` | 계획 수정 반복 패턴. |
| `universal-anti-patterns.md` | 감지하고 피해야 할 보편적인 안티패턴. |
| `worktree-path-safety.md` | 워크트리 가드 스위트: HEAD 어설션, cwd-드리프트 센티널(0a단계, #3097), 절대 경로 가드(0b단계, #3099) — `<execution_context>`를 통해 executor 스폰 프롬프트에 로드됨. |
| `artifact-types.md` | 계획 아티팩트 유형 정의. |
| `phase-argument-parsing.md` | 단계 인수 파싱 관례. |
| `decimal-phase-calculation.md` | 소수점 하위 단계 번호 규칙. |
| `workstream-flag.md` | 워크스트림 활성 포인터 관례(`--ws`). |
| `user-profiling.md` | 사용자 행동 프로파일링 감지 휴리스틱. |
| `thinking-partner.md` | 결정 시점에서의 조건부 씽킹 파트너 활성화. |
| `autonomous-smart-discuss.md` | 자율 모드를 위한 스마트 discuss 로직. |
| `ios-scaffold.md` | iOS 애플리케이션 스캐폴딩 패턴. |
| `ai-evals.md` | `/gsd-ai-integration-phase`를 위한 AI 평가 설계 레퍼런스. |
| `ai-frameworks.md` | `gsd-framework-selector`를 위한 AI 프레임워크 결정 매트릭스 레퍼런스. |
| `executor-examples.md` | gsd-executor 에이전트를 위한 작업 예시. |
| `doc-conflict-engine.md` | ingest/import 워크플로우를 위한 공유 충돌 감지 계약. |
| `execute-mvp-tdd.md` | MVP+TDD 하의 execute-phase 런타임 게이트 시맨틱 — 태스크 전 실패 테스트 검증, 단계 말 차단 리뷰. |
| `mvp-concepts.md` | 6개 MVP 관련 레퍼런스 파일에 대한 교차 참조 색인; 각 파일의 목적과 어떤 워크플로우가 로드하는지 매핑. |
| `verify-mvp-mode.md` | MVP 모드 단계를 위한 UAT 프레이밍 규칙 — 사용자 플로우 우선 순서, 지연된 기술적 확인, 사용자 스토리 형식 가드. |

### 스케치 레퍼런스

`/gsd-sketch` 워크플로우 및 그 wrap-up 동반자에 의해 사용되는 레퍼런스.

| 레퍼런스 | 역할 |
|-----------|------|
| `sketch-interactivity.md` | HTML 스케치를 인터랙티브하고 생생하게 만드는 규칙. |
| `sketch-theme-system.md` | 스케치 간 일관성을 위한 공유 CSS 테마 변수 시스템. |
| `sketch-tooling.md` | 모든 스케치에 포함된 플로팅 툴바 유틸리티. |
| `sketch-variant-patterns.md` | 다중 변형 HTML 패턴(탭, 나란히, 오버레이). |

### 씽킹 모델 레퍼런스

씽킹 클래스 모델(o3, o4-mini, Gemini 2.5 Pro)을 GSD 워크플로우에 통합하기 위한 레퍼런스.

| 레퍼런스 | 역할 |
|-----------|------|
| `thinking-models-debug.md` | 디버그 워크플로우를 위한 씽킹 모델 패턴. |
| `thinking-models-execution.md` | 실행 에이전트를 위한 씽킹 모델 패턴. |
| `thinking-models-planning.md` | 계획 에이전트를 위한 씽킹 모델 패턴. |
| `thinking-models-research.md` | 조사 에이전트를 위한 씽킹 모델 패턴. |
| `thinking-models-verification.md` | 검증 에이전트를 위한 씽킹 모델 패턴. |

### 모듈식 플래너 분해

`gsd-planner` 에이전트는 런타임 문자 제한에 맞추기 위해 코어 에이전트와 레퍼런스 모듈로 분해됩니다.

| 레퍼런스 | 역할 |
|-----------|------|
| `planner-antipatterns.md` | 플래너 안티패턴 및 구체성 예시. |
| `planner-chunked.md` | Windows stdio 멈춤 완화를 위한 청크 모드 반환 형식(`## OUTLINE COMPLETE`, `## PLAN COMPLETE`). |
| `planner-gap-closure.md` | 공백 채움 모드 동작(VERIFICATION.md 읽기, 타겟 재계획). |
| `planner-reviews.md` | 교차 AI 리뷰 통합(`/gsd-review`에서 REVIEWS.md 읽기). |
| `planner-revision.md` | 반복적 정제를 위한 계획 수정 패턴. |
| `planner-source-audit.md` | 플래너 소스 감사 및 권한 제한 규칙. |
| `planner-mvp-mode.md` | MVP 모드를 위한 수직 슬라이스 계획 규칙. |
| `planner-human-verify-mode.md` | `workflow.human_verify_mode = end-of-phase`에 대한 규칙: `checkpoint:human-verify` 태스크 방출 억제 및 `<verify><human-check>`를 통한 지연 항목 라우팅. |
| `planner-graphify-auto-update.md` | `load_graph_context`가 기존 부실 주석과 함께 `.last-build-status.json` 자동 업데이트 상태(실행 중 / 실패 / 부실 HEAD)를 표면화하는 방법. `graphify.auto_update`를 통해 옵트인 (#3347). |
| `planner-interface-context.md` | executor를 위한 인터페이스 컨텍스트 규칙 — 기존 코드에서 핵심 인터페이스/타입/익스포트 추출 방법과 다운스트림 계획이 사용할 새 인터페이스 문서화. |
| `skeleton-template.md` | 새 프로젝트 Walking Skeleton(Phase 1 + `--mvp`)을 위해 방출되는 SKELETON.md 템플릿. |
| `user-story-template.md` | MVP 계획을 위한 사용자 스토리 형식 — "As a / I want to / So that" 구조화된 필드. |
| `spidr-splitting.md` | MVP 모드에서 큰 사용자 스토리 처리를 위한 SPIDR 분할 분해 규칙. |

> **하위 디렉터리:** `gsd-core/references/few-shot-examples/`에는 특정 에이전트에서 참조되는 추가 퓨샷 예시(`plan-checker.md`, `verifier.md`)가 포함되어 있습니다. 이들은 62개 최상위 레퍼런스 수에 포함되지 않습니다.

---

## CLI 모듈 (81개 출시)

전체 목록: `gsd-core/bin/lib/*.cjs`.

| 모듈 | 책임 |
|--------|----------------|
| `active-workstream-store.cjs` | 워크스트림 소스 우선순위 및 선택(CLI `--ws` > `GSD_WORKSTREAM` 환경 변수 > 저장된 포인터); 이름 검증 및 환경 전파 |
| `adr-parser.cjs` | plan-phase 수집 익스프레스 경로를 위한 ADR 결정 파서; 섹션 동의어 정규화, 상태/결정/범위 펜스 파싱, 상태 거부 게이트 적용 |
| `agent-command-router.cjs` | `gsd-tools agent`를 위한 얇은 CJS 하위 명령어 라우터 어댑터 |
| `artifacts.cjs` | 표준 아티팩트 레지스트리 — 알려진 `.planning/` 루트 파일 이름; `gsd-health` W019 린트에 사용 |
| `audit.cjs` | 감사 디스패치, 열린 감사 세션, 감사 스토리지 헬퍼 |
| `check-command-router.cjs` | `gsd-tools check`를 위한 얇은 CJS 하위 명령어 라우터 어댑터 |
| `cjs-command-router-adapter.cjs` | 매니페스트 기반 CJS 명령어 패밀리 라우터를 위한 공유 호환성 어댑터 |
| `clock.cjs` | 결정론적 잠금 테스트를 위한 주입 가능한 클록 심(now/sleep) |
| `clusters.cjs` | 런타임 표면 모듈을 위한 스킬 클러스터 정의(ADR-0011 Phase 2) |
| `code-review-flags.cjs` | `/gsd:code-review`를 위한 타입 플래그 파서; `parseCodeReviewFlags(argv)` (→ `{ fix, all, auto, depth, files }`) 및 `resolveCodeReviewWorkflow(flags)` (→ `'code-review.md' \| 'code-review-fix.md'`) 내보내기; `--fix`/`--all`/`--auto` 라우팅을 위한 표준 디스패치 심 |
| `command-aliases.cjs` | 매니페스트 기반 패밀리 라우터를 위한 별칭/하위 명령어 메타데이터 |
| `command-arg-projection.cjs` | 명령어 패밀리 라우터 전반에 공유되는 타입 플래그 및 위치 인수 프로젝션 헬퍼 |
| `command-routing-hub.cjs` | 모든 명령어 패밀리 라우터를 위한 모드 결정(SDK vs CJS), 오류 분류, 예외 없음 계약을 집중화하는 순수 결과 디스패치 허브(#3788) |
| `commands.cjs` | 기타 CLI 명령어(슬러그, 타임스탬프, todo, 스캐폴딩, 통계) |
| `config-schema.cjs` | `VALID_CONFIG_KEYS` 및 동적 키 패턴의 단일 진실 소스; 유효성 검사기와 config-schema-docs 패리티 테스트 모두에서 가져옴 |
| `config.cjs` | `config.json` 읽기/쓰기, 섹션 초기화; `config-schema.cjs`에서 유효성 검사기 가져옴 |
| `config-types.cjs` | `model_policy` 설정 블록을 위한 TypeScript 타입 정의 — `ModelPolicyConfig`, `TierEntry`, `RuntimeTiers`; 게시 시 `src/config-types.cts`에서 컴파일됨(ADR-457) |
| `configuration.cjs` | 설정 모듈 — 표준 설정 로딩, 레거시 키 정규화, 기본값 병합, 명시적 온디스크 마이그레이션; SDK 및 CJS 소비자 모두를 위한 진실 소스 |
| `context-utilization.cjs` | `gsd-health --context`를 위한 순수 분류기 — (tokensUsed, contextWindow)를 60%/70% 파단점 임계값에 대한 `{ percent, state }` 트리아지 결과로 변환(#2792) |
| `core.cjs` | 오류 처리, 출력 포매팅, 공유 유틸리티, 런타임 폴백; 계획 워크스페이스 헬퍼를 위한 호환성 재내보내기 |
| `decisions.cjs` | CONTEXT.md `<decisions>` 블록 파싱; 숫자형(D-42) 및 영숫자형(D-INFRA-01) ID 허용; `{id, text, category, tags, trackable}` 반환 |
| `docs.cjs` | 문서 업데이트 워크플로우 초기화, 마크다운 스캔, 모노레포 감지 |
| `drift.cjs` | 실행 후 코드베이스 구조 드리프트 감지기(#2003): 파일 변경을 new-dir/barrel/migration/route 카테고리로 분류하고 `last_mapped_commit` 프론트매터를 왕복 처리 |
| `fallow-runner.cjs` | `/gsd-code-review`를 위한 Fallow 감사 어댑터: 바이너리 해석(`PATH` 이후 `node_modules/.bin`), 실행 가능한 누락 바이너리 오류, 구조적 결과 정규화 |
| `frontmatter.cjs` | YAML 프론트매터 CRUD 작업 |
| `gap-checker.cjs` | 계획 후 공백 분석(#2493): REQUIREMENTS.md + CONTEXT.md 결정 대 PLAN.md 커버리지 보고서(`gsd-tools gap-analysis`) |
| `graphify.cjs` | `/gsd-graphify`를 위한 지식 그래프 빌드/쿼리/상태/비교 |
| `gsd2-import.cjs` | `/gsd-import --from-gsd2`를 위한 외부 계획 수집 |
| `init-command-router.cjs` | `gsd-tools init`을 위한 얇은 CJS 하위 명령어 라우터 어댑터 |
| `init.cjs` | 각 워크플로우 유형을 위한 복합 컨텍스트 로딩 |
| `install-profiles.cjs` | `--minimal` 설치를 위한 설치 프로필 허용 목록 + 스킬 스테이징(#2762); 런타임 설정 디렉터리에 어떤 `gsd-*` 스킬/에이전트가 배치되는지에 대한 단일 진실 소스 |
| `installer-migration-authoring.cjs` | 레코드 메타데이터, 명시적 범위, 소유권 증거, 런타임 계약 인용을 위한 설치 마이그레이션 저작 가드레일 |
| `installer-migration-report.cjs` | 설치/업데이트 통합을 위한 설치 마이그레이션 보고서 프로젝션 및 차단 액션 가드 |
| `installer-migrations.cjs` | 설치 마이그레이션 계획, 아티팩트 분류, 설치 상태 지속성, 저널 적용, 롤백 헬퍼 |
| `intel.cjs` | `/gsd-map-codebase --query` 및 `gsd-intel-updater`를 지원하는 코드베이스 인텔 스토어 |
| `learnings.cjs` | `/gsd-extract-learnings`를 위한 단계 간 학습 추출 |
| `milestone.cjs` | 마일스톤 아카이브, 요구사항 마킹 |
| `model-catalog.cjs` | 공유 모델 카탈로그 JSON에 대한 CJS 어댑터; 모든 CLI 소비자를 위한 표준 런타임 티어 기본값, 에이전트 프로필 맵, 별칭 맵, 라우팅 메타데이터 내보내기 |
| `model-profiles.cjs` | `model-catalog.cjs`에서 파생된 하위 호환 프로필 헬퍼; 더 이상 자체 모델 테이블을 소유하지 않음 |
| `package-identity.cjs` | GSD의 게시된 패키지 좌표(npm 이름, bin 이름, 저장소 슬러그, 체인지로그 URL, 수동 설치 명령어)를 위한 생성된 단일 소스, package.json에서 파생; 업데이트 워커, `check-latest-version`, 설치 프로그램에서 읽음(#498) |
| `phase-command-router.cjs` | `gsd-tools phase`를 위한 얇은 CJS 하위 명령어 라우터 어댑터 |
| `phase-lifecycle.cjs` | 단계 라이프사이클 SDK 핸들러에서 추출된 순수 계산 단계 라이프사이클 헬퍼 |
| `phase.cjs` | 단계 디렉터리 작업, 소수점 번호 체계, 계획 인덱싱 |
| `phases-command-router.cjs` | `gsd-tools phases`를 위한 얇은 CJS 하위 명령어 라우터 어댑터 |
| `plan-scan.cjs` | 플랫 및 중첩 레이아웃에서 계획 및 요약 파일을 감지하는 표준 단계 계획 스캐너(k014) |
| `planning-workspace.cjs` | 계획 경로/워크스트림 심(`planningDir`, `planningPaths`, 활성 워크스트림 라우팅, `.planning/.lock` 오케스트레이션) |
| `project-root.cjs` | 4가지 휴리스틱(자체 `.planning/` 가드, `sub_repos` 설정, `multiRepo` 플래그, `.git` 휴리스틱)을 사용하여 시작 디렉터리에서 프로젝트 루트 해석 |
| `profile-output.cjs` | 프로필 렌더링, USER-PROFILE.md 및 dev-preferences.md 생성 |
| `profile-pipeline.cjs` | 사용자 행동 프로파일링 데이터 파이프라인, 세션 파일 스캔 |
| `prompt-budget.cjs` | 리뷰 프롬프트를 위한 순수 토큰 예산 계산 — 토큰 추정, 결정론적 트림 우선순위 적용(헤드 수축 PROJECT.md, 비례 계획 잘라내기, 컨텍스트/조사/요구사항 삭제, 하드 실패 가드), `review.max_prompt_tokens`를 위한 구조화된 메타데이터 반환(#3081) |
| `review-reviewer-selection.cjs` | `/gsd-review` 기본 리뷰어 정책 및 우선순위를 위한 리뷰어 선택/정규화 헬퍼 |
| `roadmap-command-router.cjs` | `gsd-tools roadmap`을 위한 얇은 CJS 하위 명령어 라우터 어댑터 |
| `roadmap-upgrade.cjs` | 레거시 `Phase N` 항목을 마일스톤 접두사 `Phase M-NN` 관례로 변환하는 마이그레이션 도구; 드라이런 기본값 및 원자적 롤백이 있는 `computeMigrationPlan` + `applyMigration` |
| `roadmap.cjs` | ROADMAP.md 파싱, 단계 추출, 계획 진행도 |
| `runtime-artifact-layout.cjs` | 런타임 아티팩트 레이아웃 모듈 — 지원되는 각 런타임의 아티팩트 디렉터리 형태(명령어, 에이전트, 스킬) 해석; 런타임별 아티팩트 배치를 위한 단일 진실 소스(#3663) |
| `runtime-name-policy.cjs` | 런타임 이름 정규화 정책 — 경로 구성 및 표시에 사용되는 런타임 식별자를 위한 표준 토큰 위생 처리 |
| `runtime-homes.cjs` | 표준 런타임 → 전역 설정/스킬 디렉터리 매핑; Hermes 중첩 레이아웃 및 Cline 규칙 기반 제외를 포함한 15개 런타임에 대한 일급 지원(#3126) |
| `runtime-slash.cjs` | 런타임 인식 슬래시 명령어 포매터 — 사용자 대면 출력 및 영속 아티팩트에서 `/gsd-<cmd>`(스킬 기반 런타임) 및 `$gsd-<cmd>`(codex) 내보내기를 위한 단일 진실 소스(#3584) |
| `schema-detect.cjs` | ORM 패턴 스키마 드리프트 감지(Prisma, Drizzle, Supabase, TypeORM, Payload); `detectSchemaFiles`, `detectSchemaOrm`, `checkSchemaDrift`, `SCHEMA_PATTERNS`, `ORM_INFO` 내보내기 |
| `secrets.cjs` | 통합 키를 위한 시크릿 설정 마스킹 관례(`****<last-4>`); `SECRET_CONFIG_KEYS`, `isSecretKey`, `maskSecret`, `maskIfSecret` 내보내기 |
| `semver-compare.cjs` | 업데이트 확인 훅, 상태라인 개발 설치 감지, 체인지셋 추출 범위 로직에서 사용되는 공유 semver 비교 정책 헬퍼(`compareSemverCore`, 안정적인 트리플릿 검증, 정규화된 튜플 파싱)(#10) |
| `security.cjs` | 경로 순회 방지, 프롬프트 주입 감지, 안전한 JSON/셸 헬퍼 |
| `shell-command-projection.cjs` | 관리형 훅 직렬화를 위한 런타임 인식 셸 명령어 프로젝션: 런타임/플랫폼별 PowerShell 호출 연산자 사용 결정 및 Windows 스크립트 경로 토큰 정규화 |
| `state-command-router.cjs` | `gsd-tools state`를 위한 얇은 CJS 하위 명령어 라우터 어댑터 |
| `state.cjs` | STATE.md 파싱, 업데이트, 진행, 메트릭 |
| `state-document.cjs` | 순수 STATE.md 필드 추출, 교체, 상태 정규화, 진행도 계산 변환 |
| `surface.cjs` | 런타임 표면 모듈 — 설치 시 프로필 마커와 독립적으로 런타임 활성화/비활성화 표면 상태 관리(ADR-0011 Phase 2) |
| `task-command-router.cjs` | `gsd-tools task`를 위한 얇은 CJS 하위 명령어 라우터 어댑터 |
| `template.cjs` | 변수 치환을 통한 템플릿 선택 및 채우기 |
| `uat.cjs` | UAT 파일 파싱, 검증 부채 추적, audit-uat 지원 |
| `ui-safety-gate.cjs` | 셸 없는 단어 경계 UI 토큰 감지기(#3706, #3718); stdin에서 단계 섹션 텍스트를 읽어 0(UI 발견) 또는 1(UI 없음) 종료; GSD 설치 프로그램이 `$RUNTIME_DIR`에 배포하도록 `gsd-core/bin/lib/`에도 배포 |
| `update-context.cjs` | `/gsd:update`를 위한 순수 설치 컨텍스트 해석기 — update.md bash에서 포팅된 런타임/범위/설정 디렉터리/버전 감지(LOCAL/GLOBAL/UNKNOWN); `gsd-tools update-context` 지원(#498) |
| `validate-command-router.cjs` | `gsd-tools validate`를 위한 얇은 CJS 하위 명령어 라우터 어댑터 |
| `validate.cjs` | 순수 단계 변형 정규화 헬퍼(`phaseVariants`, `buildRoadmapPhaseVariants`, `buildNotStartedPhaseVariants`), W006/W007 확인을 위해 `verify.cjs`에서 사용; I/O 없음, 비동기 없음 |
| `verify-command-router.cjs` | `gsd-tools verify`를 위한 얇은 CJS 하위 명령어 라우터 어댑터 |
| `verify.cjs` | 계획 구조, 단계 완전성, 레퍼런스, 커밋 검증 |
| `workstream-inventory-builder.cjs` | 순수 워크스트림 인벤토리 프로젝션 빌더 |
| `workstream-inventory.cjs` | 공유 워크스트림 인벤토리 프로젝션: 상태 필드, 단계/계획/요약 수, 로드맵 단계 수, 활성 마커 — `workstream-inventory-builder.cjs`에 순수 프로젝션을 위임하는 얇은 오케스트레이터 |
| `workstream-name-policy.cjs` | 표준 워크스트림 이름 검증(`isValidActiveWorkstreamName`, `hasInvalidPathSegment`, `validateWorkstreamName`) 및 슬러그 정규화(`toWorkstreamSlug`) |
| `workstream.cjs` | 워크스트림 CRUD, 마이그레이션, 세션 범위 활성 포인터 |
| `worktree-safety.cjs` | 워크트리 루트 해석 및 비파괴적 가지치기 정책 결정; W017 상태 확인 로직 소유 |

[`docs/CLI-TOOLS.md`](CLI-TOOLS.md)는 이러한 모듈의 하위 집합을 설명할 수 있습니다. 파일시스템과 불일치할 경우 이 테이블과 디렉터리 목록이 권위 있는 출처입니다.

---

## 훅 (14개 출시)

전체 목록: `hooks/`.

| 훅 | 이벤트 | 목적 |
|------|-------|---------|
| `gsd-statusline.js` | `statusLine` | 모델, 태스크, 디렉터리, 컨텍스트 사용량 표시 |
| `gsd-context-monitor.js` | `PostToolUse` / `AfterTool` | 35%/25% 남은 시점에 에이전트 대면 컨텍스트 경고 주입 |
| `gsd-check-update.js` | `SessionStart` | 새 GSD 버전 백그라운드 확인 |
| `gsd-check-update-worker.js` | (worker) | check-update를 위한 백그라운드 워커 헬퍼 |
| `gsd-update-banner.js` | `SessionStart` | GSD 상태라인을 사용하지 않을 때 업데이트 가용성을 표면화하는 옵트인 배너(PR #2795) |
| `gsd-prompt-guard.js` | `PreToolUse` | `.planning/` 쓰기에서 프롬프트 주입 패턴 스캔 (어드바이저리) |
| `gsd-workflow-guard.js` | `PreToolUse` | GSD 워크플로우 컨텍스트 외부의 파일 편집 감지 (어드바이저리, 옵트인) |
| `gsd-read-guard.js` | `PreToolUse` | 읽지 않은 파일에 대한 Edit/Write를 방지하는 어드바이저리 가드 |
| `gsd-read-injection-scanner.js` | `PostToolUse` | 도구 Read 결과에서 프롬프트 주입 패턴 스캔 (v1.36+, PR #2201) |
| `gsd-worktree-path-guard.js` | `PreToolUse` | 워크트리 루트 외부의 절대 경로로 Edit/Write/MultiEdit를 하드 차단 (PR #579, #260) |
| `gsd-write-guard.js` | `PreToolUse` | 큐레이션된 `.planning/` 아티팩트(ROADMAP.md, 마일스톤 로드맵, STATE.md)를 치명적으로 축소하는 전체 파일 `Write`를 하드 차단. 일회용 센티널 `.planning/.gsd-allow-shrink`(워크플로 단계) 또는 `GSD_ALLOW_PLANNING_SHRINK=1`(대화형)로 우회 가능 (#2255, #973의 수정 3) |
| `gsd-session-state.sh` | `PostToolUse` | 셸 기반 런타임을 위한 세션 상태 추적 |
| `gsd-validate-commit.sh` | `PostToolUse` | 컨벤셔널 커밋 적용을 위한 커밋 검증 |
| `gsd-phase-boundary.sh` | `PostToolUse` | 워크플로우 전환을 위한 단계 경계 감지 |
| `gsd-graphify-update.sh` | `PostToolUse` | 메인 HEAD 진행 후 지식 그래프 자동 재빌드 (옵트인, 기본 비활성화 — #3347) |

---

## 유지 관리

- 새 명령어, 에이전트, 워크플로우, 레퍼런스, CLI 모듈, 또는 훅이 출시될 때, 릴리스가 잘리기 전에 해당 섹션을 여기에 업데이트하세요.
- `tests/` 아래의 드리프트 가드 테스트(위의 "이 파일 사용 방법" 참조)는 출시된 모든 파일이 이 인벤토리에 열거되어 있음을 어설트합니다. 일치하는 행이 없는 새 파일은 CI를 실패시킵니다.
- 파일시스템이 `docs/ARCHITECTURE.md` 수량 또는 엄선된 하위 집합 문서(예: `docs/AGENTS.md`의 주요 목록)와 다를 경우, 이 파일이 진실의 원천입니다.

## 관련 문서

- [명령어](COMMANDS.md) — 사용자 대면 명령어 참조
- [아키텍처](ARCHITECTURE.md) — 표면이 어떻게 맞물리는지
- [문서 색인](README.md)
