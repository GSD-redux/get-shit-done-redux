# GSD Core 명령어 참조

> GSD Core의 명령어 참조 — 모든 안정 명령어의 구문, 플래그, 옵션, 예시. 기능 세부 사항은 [기능 참조](FEATURES.md)를, 워크플로 안내는 [사용자 가이드](USER-GUIDE.md)를, 문서 목록은 [README](README.md)를 참조하세요.

---

## 명령어 구문

- **Claude Code / Copilot / OpenCode / Kilo:** `/gsd-command-name [args]` (하이픈 형식)
- **Gemini CLI:** `/gsd:command-name [args]` (콜론 형식 — Gemini는 `gsd:` 네임스페이스로 명령어를 분류합니다)
- **Codex:** `$gsd-command-name [args]`

하이픈 형식과 콜론 형식은 *동일한 명령어의 런타임별 표기법*입니다. 사용 중인 런타임에 따라 인스톨러가 해당 런타임의 명령어 디렉토리에 올바른 형식을 자동으로 작성합니다.

---

## 네임스페이스 메타 스킬

v1.40에서 여섯 개의 네임스페이스 라우터가 1단계 진입점으로 제공됩니다. 이를 통해 즉시 스킬 목록을 로드하는 토큰 비용을 낮추면서(라우터 6개에 ~120 토큰 대 86개 스킬 전체 목록에 ~2,150 토큰) 전체 기능을 직접 호출할 수 있습니다. 모델이 네임스페이스를 선택한 후 구체적인 하위 스킬로 라우팅합니다. [#2792](https://github.com/open-gsd/gsd-core/issues/2792)를 참조하세요.

| 명령어 | 라우팅 대상 |
|---------|-----------|
| `/gsd-workflow` | 단계 파이프라인 — discuss / plan / execute / verify / phase / progress |
| `/gsd-project` | 프로젝트 수명 주기 — 마일스톤, 감사, 요약 |
| `/gsd-quality` | 품질 게이트 — 코드 리뷰, 디버그, 감사, 보안, 평가, UI |
| `/gsd-context` | 코드베이스 인텔리전스 — 맵, 그래프화, 문서, 학습 내용 |
| `/gsd-manage` | 관리 — config, workspace, workstreams, thread, update, ship, inbox |
| `/gsd-ideate` | 탐색 및 캡처 — explore, sketch, spike, spec, capture |

네임스페이스 스킬은 **추가적** 방식으로 동작합니다 — 기존의 모든 구체적인 명령어(예: `/gsd-plan-phase`, `/gsd-code-review --fix`)는 여전히 직접 호출할 수 있습니다.

---

## 핵심 워크플로 명령어

### `/gsd-new-project`

심층적인 컨텍스트 수집을 통해 새 프로젝트를 초기화합니다.

| 플래그 | 설명 |
|------|-------------|
| `--auto @file.md` | 문서에서 자동 추출, 대화형 질문 생략 |

**전제 조건:** 기존 `.planning/PROJECT.md` 없음
**생성 결과:** `PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md`, `config.json`, `research/`, `CLAUDE.md`

```bash
/gsd-new-project                    # 대화형 모드
/gsd-new-project --auto @prd.md     # PRD에서 자동 추출
```

---

### `/gsd-onboard`

기존 코드베이스의 최초 GSD 온보딩을 안내합니다. 저장소 상태를 확인하고 코드베이스 매핑, 선택적 문서 수집, 프로젝트 초기화로 안전하게 넘긴 뒤 계획 파일이 준비되면 onboarding summary를 만듭니다.

| 플래그 | 설명 |
|------|-------------|
| `--fast` | 경량 `/gsd-map-codebase --fast` 매핑 handoff 우선 사용. 단, `/gsd-new-project` 전에는 완전한 맵이 필요 |
| `--text` | TUI 메뉴 대신 번호가 있는 plain-text gate 사용 |

**전제 조건:** 기존 저장소 또는 계획 문서. 빈 greenfield 프로젝트는 `/gsd-new-project`를 사용하세요.
**생성 결과:** map-codebase의 `.planning/codebase/`, new-project 또는 ingest-docs의 `.planning/`, 설정 후 `.planning/onboarding/SUMMARY.md`.

```bash
/gsd-onboard           # 안내형 brownfield 온보딩
/gsd-onboard --fast    # 먼저 경량 맵을 사용하고, 프로젝트 설정 전 완전한 맵 작성
```

---

### `/gsd-workspace`

GSD 워크스페이스 관리 — 리포지토리 복사본과 독립적인 `.planning/` 디렉토리를 갖는 격리된 워크스페이스 환경을 생성, 나열, 또는 삭제합니다.

| 플래그 | 설명 |
|------|-------------|
| `--new` | 새 워크스페이스 생성 (`--name`, `--repos` 등과 함께 사용) |
| `--list` | 활성 GSD 워크스페이스 및 상태 나열 |
| `--remove <name>` | 워크스페이스 삭제 및 git 워크트리 정리 |
| `--name <name>` | 워크스페이스 이름 (`--new`와 함께 사용) |
| `--repos repo1,repo2` | 쉼표로 구분된 리포지토리 경로 또는 이름 (`--new`와 함께 사용) |
| `--path /target` | 대상 디렉토리 (기본값: `~/gsd-workspaces/<name>`) |
| `--strategy worktree\|clone` | 복사 전략 (기본값: `worktree`) |
| `--branch <name>` | 체크아웃할 브랜치 (기본값: `workspace/<name>`) |
| `--auto` | 대화형 질문 생략 |

**사용 사례:**
- 멀티 리포지토리: 격리된 GSD 상태로 일부 리포지토리에서 작업
- 기능 격리: `--repos .`는 현재 리포지토리의 워크트리 생성

**생성 결과:** `WORKSPACE.md`, `.planning/`, 리포지토리 복사본 (워크트리 또는 클론)

```bash
/gsd-workspace --new --name feature-b --repos hr-ui,ZeymoAPI
/gsd-workspace --new --name feature-b --repos . --strategy worktree  # 동일 리포지토리 격리
/gsd-workspace --list
/gsd-workspace --remove feature-b
```

---

### `/gsd-discuss-phase`

계획 수립 전 적응형 질문을 통해 단계 컨텍스트를 수집합니다.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `N` | 아니요 | 단계 번호 (기본값: 현재 단계) |

| 플래그 | 설명 |
|------|-------------|
| `--all` | 영역 선택 생략 — 모든 불확실한 영역을 대화형으로 논의 (자동 진행 없음) |
| `--auto` | 모든 질문에 권장 기본값 자동 선택 |
| `--batch` | 하나씩이 아닌 일괄 입력을 위한 질문 그룹화 |
| `--analyze` | 논의 중 트레이드오프 분석 추가 |
| `--power` | 미리 준비된 답변 파일로 파일 기반 대량 질문 답변 |
| `--assumptions` | 대화형 세션 없이 단계에 대한 Claude의 구현 가정 표시 |

**전제 조건:** `.planning/ROADMAP.md` 존재
**생성 결과:** `{phase}-CONTEXT.md`, `{phase}-DISCUSSION-LOG.md` (감사 추적)

```bash
/gsd-discuss-phase 1                # 단계 1의 대화형 논의
/gsd-discuss-phase 1 --all          # 선택 단계 없이 모든 불확실한 영역 논의
/gsd-discuss-phase 3 --auto         # 단계 3의 기본값 자동 선택
/gsd-discuss-phase --batch          # 현재 단계의 배치 모드
/gsd-discuss-phase 2 --analyze      # 트레이드오프 분석과 함께 논의
/gsd-discuss-phase 1 --power        # 파일로부터 대량 답변
/gsd-discuss-phase 3 --assumptions  # 계획 전 Claude의 가정 표시
```

---

### `/gsd-ui-phase`

프론트엔드 단계를 위한 UI 디자인 계약을 생성합니다.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `N` | 아니요 | 단계 번호 (기본값: 현재 단계) |

**전제 조건:** `.planning/ROADMAP.md` 존재, 해당 단계에 프론트엔드/UI 작업 포함
**생성 결과:** `{phase}-UI-SPEC.md`

```bash
/gsd-ui-phase 2                     # 단계 2의 디자인 계약
```

---

### `/gsd-plan-phase`

단계를 리서치, 계획, 검증합니다.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `N` | 아니요 | 단계 번호 (기본값: 다음 미계획 단계) |

| 플래그 | 설명 |
|------|-------------|
| `--auto` | 대화형 확인 생략 |
| `--research` | RESEARCH.md가 있어도 강제 재리서치 |
| `--skip-research` | 도메인 리서치 단계 생략 |
| `--research-phase <N>` | 리서치 전용 모드: 단계 `<N>`에 대한 리서처 생성, RESEARCH.md 작성, 계획자 이전에 종료. 삭제된 독립형 리서치 명령어 대체 (#3042). |
| `--view` | 리서치 전용 수정자: `--research-phase`와 함께 사용하면 기존 RESEARCH.md를 stdout으로 출력하고 종료 (생성 없음). |
| `--gaps` | 갭 보완 모드 (VERIFICATION.md 읽기, 리서치 생략) |
| `--skip-verify` | 계획 검사기 검증 루프 생략 |
| `--prd <file>` | 컨텍스트로 discuss-phase 대신 PRD 파일 사용 |
| `--ingest <path-or-glob>` | 컨텍스트 합성을 위해 discuss-phase 대신 ADR 파일 사용 |
| `--ingest-format <auto\|nygard\|madr\|narrative>` | `--ingest`에 대한 선택적 ADR 파서 형식 재정의 |
| `--reviews` | REVIEWS.md의 크로스 AI 리뷰 피드백으로 재계획 |
| `--bounce` | 계획 후 외부 계획 바운스 검증 실행 (`workflow.plan_bounce_script` 사용) |
| `--skip-bounce` | 설정에서 활성화되어 있어도 계획 바운스 생략 |
| `--mvp` | 수직 MVP 모드 — 계획자가 수평 레이어 대신 기능 슬라이스(UI→API→DB)로 작업을 구성합니다. 이전 단계 요약이 없는 새 프로젝트의 단계 1에서는 `SKELETON.md`(Walking Skeleton)도 생성합니다. ROADMAP.md에 `**Mode:** mvp`를 추가하여 단계별로 지속시킬 수 있으며, 플래그 없이 자동으로 `--mvp`가 적용됩니다. |
| `--tdd` | TDD 모드 — 계획자가 동작 추가 작업에 `type: tdd`를 적용하여 각 작업이 실패하는 테스트로 시작하도록 합니다. `--mvp`와 조합 가능: `--mvp --tdd`는 모든 동작 추가 작업이 red-green으로 시작하는 수직 슬라이스를 생성합니다. |

**전제 조건:** `.planning/ROADMAP.md` 존재
**생성 결과:** `{phase}-RESEARCH.md`, `{phase}-{N}-PLAN.md`, `{phase}-VALIDATION.md`; Walking Skeleton 모드 실행 시 `{phase}/SKELETON.md`

**리서치 전용 모드 (`--research-phase <N>`):**
- 수정자 없음: RESEARCH.md가 이미 있으면 `update / view / skip` 프롬프트.
- `--research` 사용: 강제 새로 고침 — 프롬프트 없이 리서처를 무조건 재생성.
- `--view` 사용: 기존 RESEARCH.md를 stdout으로 출력, 생성 없음. RESEARCH.md가 없으면 오류 발생.

**패키지 적법성 게이트 (v1.42.1):**
리서처가 외부 패키지를 추천하면 각 패키지에 대해 `slopcheck install <pkg> --json`을 실행하고 레지스트리, 출시일, 다운로드 수, 소스 리포지토리, slopcheck 판정이 담긴 `## Package Legitimacy Audit` 테이블을 RESEARCH.md에 작성합니다. 판정:

- `[SLOP]` — 패키지가 RESEARCH.md에서 완전히 제거; 계획자에게 전달되지 않음
- `[SUS]` — 패키지 플래그 지정; 계획자가 설치 작업 전에 `checkpoint:human-verify` 삽입
- `[OK]` — 패키지 승인; 체크포인트 없음

WebSearch에서 가져온 패키지는 `[ASSUMED]`(`[VERIFIED]`가 아님)로 태그되며 `[SUS]`와 동일하게 처리됩니다 — 설치 전에 사람 체크포인트가 필요합니다. `slopcheck`를 설치할 수 없는 경우 추천된 모든 패키지는 `[ASSUMED]`로 태그되고 게이트 처리됩니다.

전체 체크포인트 형식, 판정 테이블, 문제 해결 방법은 [사용자 가이드의 패키지 적법성 게이트](USER-GUIDE.md#package-legitimacy-gate-v1421)를 참조하세요.

```bash
/gsd-plan-phase 1                              # 단계 1 리서치 + 계획 + 검증
/gsd-plan-phase 3 --skip-research              # 리서치 없이 계획 (친숙한 도메인)
/gsd-plan-phase --auto                         # 비대화형 계획 수립
/gsd-plan-phase 1 --bounce                     # 계획 + 외부 바운스 검증
/gsd-plan-phase 2 --ingest docs/adr/0010.md   # 컨텍스트 합성을 위한 ADR 익스프레스 경로
/gsd-plan-phase 2 --ingest 'docs/adr/00*.md' --ingest-format auto
/gsd-plan-phase --research-phase 4             # 단계 4만 리서치 (RESEARCH.md 있으면 프롬프트)
/gsd-plan-phase --research-phase 4 --view      # 기존 RESEARCH.md 출력, 생성 없음
/gsd-plan-phase --research-phase 4 --research  # 강제 리서치 새로 고침, 프롬프트 없음
/gsd-plan-phase 1 --mvp                        # 단계 1의 수직 슬라이스 계획
/gsd-plan-phase 1 --mvp --tdd                  # 수직 슬라이스 + 동작 추가 작업당 실패 테스트
```

---

### `/gsd-plan-review-convergence`

크로스 AI 계획 수렴 루프 — HIGH 우려사항이 없어질 때까지 리뷰 피드백으로 재계획. `plan-phase → review → replan → re-review` 사이클을 실행합니다(기본 최대 3 사이클). 계획 및 리뷰를 위한 격리된 에이전트를 생성하고, 오케스트레이터가 루프 제어, HIGH 우려사항 카운팅, 정체 감지, 에스컬레이션을 처리합니다.

| 인수 / 플래그 | 필수 | 설명 |
|-----------------|----------|-------------|
| `N` | **예** | 계획 및 리뷰할 단계 번호 |
| `--codex` / `--gemini` / `--claude` / `--opencode` | 아니요 | 단일 리뷰어 선택 |
| `--all` | 아니요 | 구성된 모든 리뷰어를 병렬로 실행 |
| `--max-cycles N` | 아니요 | 사이클 상한 재정의 (기본값 3) |

**종료 동작:** HIGH 카운트가 0이 되면 루프 종료. 사이클 간 HIGH 카운트가 감소하지 않을 때 정체 감지 경고. `--max-cycles`에 도달해도 HIGH 우려사항이 남아 있으면 에스컬레이션 게이트가 계속 진행하거나 수동 리뷰를 요청합니다.

```bash
/gsd-plan-review-convergence 3                    # 기본 리뷰어, 3 사이클
/gsd-plan-review-convergence 3 --codex            # Codex 전용 리뷰
/gsd-plan-review-convergence 3 --all --max-cycles 5
```

---

### `/gsd-ultraplan-phase`

**[BETA]** 계획 단계를 Claude Code의 ultraplan 클라우드로 오프로드; 브라우저에서 리뷰하고 가져오기. 계획이 원격으로 작성되는 동안 터미널은 자유롭게 유지됩니다; 브라우저에서 인라인 댓글을 리뷰한 후 `/gsd-import`를 통해 최종 계획을 `.planning/`으로 가져옵니다.

| 플래그 | 필수 | 설명 |
|------|----------|-------------|
| `N` | **예** | 원격으로 계획할 단계 번호 |

**격리:** 업스트림 ultraplan 변경이 핵심 계획 파이프라인에 영향을 미치지 않도록 `/gsd-plan-phase`와 의도적으로 분리됩니다.

```bash
/gsd-ultraplan-phase 4                  # 단계 4의 계획을 오프로드
```

---

### `/gsd-execute-phase`

웨이브 기반 병렬화로 단계의 모든 계획을 실행하거나 특정 웨이브만 실행합니다.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `N` | **예** | 실행할 단계 번호 |
| `--wave N` | 아니요 | 단계에서 웨이브 `N`만 실행 |
| `--cross-ai` | 아니요 | 외부 AI CLI에 실행 위임 (`workflow.cross_ai_command` 사용) |
| `--no-cross-ai` | 아니요 | 설정에서 크로스 AI가 활성화되어 있어도 로컬 실행 강제 |

**전제 조건:** 단계에 PLAN.md 파일 존재
**생성 결과:** 계획당 `{phase}-{N}-SUMMARY.md`, git 커밋, 단계가 완전히 완료되면 `{phase}-VERIFICATION.md`

**패키지 설치 실패 (v1.42.1):** 계획의 설치 단계가 실패하면 실행자는 `checkpoint:human-verify`를 표시하고 중지합니다. 비슷한 이름의 대안을 자동으로 설치하지 않습니다. 이는 의도적인 동작입니다 — 패키지 이름을 자동으로 대체하는 것은 슬로프스쿼팅이 확산되는 방식이기 때문입니다. 레지스트리 페이지에서 패키지를 확인한 후 체크포인트에 응답하세요.

```bash
/gsd-execute-phase 1                # 단계 1 실행
/gsd-execute-phase 1 --wave 2       # 웨이브 2만 실행
/gsd-execute-phase 2 --cross-ai     # 단계 2를 외부 AI CLI에 위임
```

---

### `/gsd-verify-work`

자동 진단이 포함된 사용자 인수 테스트.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `N` | 아니요 | 단계 번호 (기본값: 마지막 실행 단계) |

**전제 조건:** 단계가 실행됨
**생성 결과:** `{phase}-UAT.md`, 문제 발견 시 수정 계획

브라우저 기반 UAT의 경우 구성된 브라우저 MCP 서버를 사용하세요. 현재 Open GSD 컴패니언은 `gsd-browser`(`gsd-browser mcp`)이며, 결정론적 탐색, 버전 관리된 참조, 어설션, 스크린샷, 시각적 비교, 녹화, 사용자 인수 기능을 제공합니다. 이미 구성되어 있는 레거시 Playwright MCP 서버도 계속 사용할 수 있습니다.

```bash
/gsd-verify-work 1                  # 단계 1의 UAT
```

---

---

### `/gsd-ship`

완성된 단계 작업으로부터 자동 생성된 본문으로 PR을 생성합니다.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `N` | 아니요 | 단계 번호 또는 마일스톤 버전 (예: `4` 또는 `v1.0`) |
| `--draft` | 아니요 | 초안 PR로 생성 |

**전제 조건:** 단계 검증 완료 (`/gsd-verify-work` 통과), `gh` CLI 설치 및 인증됨
**생성 결과:** 계획 아티팩트로부터 풍부한 본문이 포함된 GitHub PR, STATE.md 업데이트

```bash
/gsd-ship 4                         # 단계 4 배포
/gsd-ship 4 --draft                 # 초안 PR로 배포
```

**PR 본문 포함 내용:**
- ROADMAP.md의 단계 목표
- SUMMARY.md 파일의 변경사항 요약
- 반영된 요구사항 (REQ-ID)
- 검증 상태
- 주요 결정 사항
- `ship.pr_body_sections`에서 선택적으로 구성된 PRD 스타일 섹션

커스텀 PR 본문 섹션에 대한 온보딩, 예시, 검증 규칙은 [Custom PR Body Sections](../ship-pr-body-sections.md)를 참조하세요.

---

### `/gsd-ui-review`

구현된 프론트엔드의 소급 6개 기둥 시각적 감사.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `N` | 아니요 | 단계 번호 (기본값: 마지막 실행 단계) |

**전제 조건:** 프로젝트에 프론트엔드 코드 포함 (독립형으로 작동, GSD 프로젝트 불필요)
**생성 결과:** `{phase}-UI-REVIEW.md`, `.planning/ui-reviews/`의 스크린샷

더 풍부한 시각적 증거를 위해 `gsd-browser` 또는 다른 브라우저 MCP 서버와 함께 사용하면 감사에서 스크린샷, 상태, 콘솔/네트워크 컨텍스트, 재현 가능한 상호작용 단계를 캡처할 수 있습니다.

```bash
/gsd-ui-review                      # 현재 단계 감사
/gsd-ui-review 3                    # 단계 3 감사
```

---

### `/gsd-audit-uat`

모든 미해결 UAT 및 검증 항목의 크로스 단계 감사.

**전제 조건:** 최소 한 단계가 UAT 또는 검증과 함께 실행됨
**생성 결과:** 사람 테스트 계획이 포함된 분류된 감사 보고서

```bash
/gsd-audit-uat
```

---

### `/gsd-audit-milestone`

마일스톤이 완료 정의를 충족했는지 검증합니다.

**전제 조건:** 모든 단계 실행됨
**생성 결과:** 갭 분석이 포함된 감사 보고서

```bash
/gsd-audit-milestone
```

---

### `/gsd-complete-milestone`

마일스톤 아카이브, 릴리스 태그 생성.

**전제 조건:** 마일스톤 감사 완료 (권장)
**생성 결과:** `MILESTONES.md` 항목, git 태그

```bash
/gsd-complete-milestone
```

---

### `/gsd-milestone-summary`

팀 온보딩 및 리뷰를 위한 마일스톤 아티팩트로부터 포괄적인 프로젝트 요약을 생성합니다.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `version` | 아니요 | 마일스톤 버전 (기본값: 현재/최신 마일스톤) |

**전제 조건:** 최소 하나의 완료 또는 진행 중인 마일스톤
**생성 결과:** `.planning/reports/MILESTONE_SUMMARY-v{version}.md`

**요약 포함 내용:**
- 개요, 아키텍처 결정, 단계별 분석
- 주요 결정 사항 및 트레이드오프
- 요구사항 커버리지
- 기술 부채 및 연기된 항목
- 새 팀원을 위한 시작 가이드
- 생성 후 대화형 Q&A 제공

```bash
/gsd-milestone-summary                # 현재 마일스톤 요약
/gsd-milestone-summary v1.0           # 특정 마일스톤 요약
```

---

### `/gsd-new-milestone`

다음 버전 사이클을 시작합니다.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `name` | 아니요 | 마일스톤 이름 |
| `--reset-phase-numbers` | 아니요 | 새 마일스톤을 단계 1부터 시작하고 로드맵 작성 전에 이전 단계 디렉토리 아카이브 |

**전제 조건:** 이전 마일스톤 완료
**생성 결과:** 업데이트된 `PROJECT.md`, 새 `REQUIREMENTS.md`, 새 `ROADMAP.md`

```bash
/gsd-new-milestone                  # 대화형
/gsd-new-milestone "v2.0 Mobile"    # 이름 있는 마일스톤
/gsd-new-milestone --reset-phase-numbers "v2.0 Mobile"  # 마일스톤 번호를 1부터 재시작
```

---

## 단계 관리 명령어

### `/gsd-phase`

ROADMAP.md의 단계에 대한 CRUD — 단일 통합 명령어로 단계 추가, 삽입, 삭제 또는 편집.

| 플래그 | 설명 |
|------|-------------|
| (없음) | 현재 마일스톤 끝에 새 정수 단계 추가 |
| `--insert <N>` | 단계 N 다음에 소수 단계(예: 3.1)로 긴급 작업 삽입 |
| `--remove <N>` | 향후 단계 삭제 및 이후 단계 번호 재정렬 |
| `--edit <N>` | 기존 단계의 모든 필드를 인플레이스로 편집 |
| `--force` | 진행 중이거나 완료된 단계 편집 허용 (`--edit`와 함께 사용) |

**전제 조건:** `.planning/ROADMAP.md` 존재
**생성 결과:** 업데이트된 ROADMAP.md

```bash
/gsd-phase "Add authentication system"          # 설명과 함께 새 단계 추가
/gsd-phase --insert 3 "Fix auth race condition" # 단계 3과 4 사이에 삽입 → 3.1 생성
/gsd-phase --remove 7               # 단계 7 삭제, 8→7, 9→8 등으로 번호 재정렬
/gsd-phase --edit 5                 # 단계 5의 모든 필드 편집
/gsd-phase --edit 5 --force         # 진행 중이거나 완료된 경우에도 단계 5 편집
```

---

### `/gsd-mvp-phase`

단계에 대한 안내형 MVP 계획 — 사용자 스토리를 입력받고, SPIDR 분할 확인을 실행하고, ROADMAP.md에 `**Mode:** mvp`를 작성한 후 `/gsd-plan-phase`에 위임합니다 (로드맵 필드를 통해 MVP 모드를 자동 감지).

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `N` | **예** | MVP 모드로 전환할 단계 번호 (정수 또는 `2.1`과 같은 소수) |

| 플래그 | 설명 |
|------|-------------|
| `--force` | `in_progress` 또는 `completed` 단계 전환 허용 |

**전제 조건:** 단계가 ROADMAP.md에 이미 존재해야 합니다 (`/gsd-new-project`, `/gsd-phase`, 또는 `/gsd-phase --insert`를 통해 생성). 이 명령어는 새 단계를 생성하지 않습니다 — 기존 단계를 전환합니다.

**동작:** 구조화된 사용자 스토리를 수집하고, 형식을 검증하고, SPIDR 분할 확인을 실행하고, 단계의 ROADMAP.md 섹션에 `**Goal:**`과 `**Mode:** mvp`를 작성한 후 `/gsd-plan-phase <N>`에 위임합니다. 안내는 [MVP 단계 계획 방법](USER-GUIDE.md#mvp-phase-planning)을 참조하세요.

**Walking Skeleton:** 이전 단계 요약이 없는 새 프로젝트의 단계 1에서 `--mvp`(또는 `mode: mvp`)가 사용될 때 자동으로 트리거됩니다. 계획자는 `PLAN.md`와 함께 `SKELETON.md`를 생성합니다.

**생성 결과:** 업데이트된 ROADMAP.md, 그 후 `/gsd-plan-phase`의 모든 아티팩트; Walking Skeleton 모드 실행 시 `SKELETON.md`.

```bash
/gsd-mvp-phase 1                    # 단계 1의 MVP 계획
/gsd-mvp-phase 2.1                  # 소수 단계의 MVP 계획
/gsd-mvp-phase 3 --force            # 진행 중이어도 단계 3 전환
```

---

### `/gsd-validate-phase`

Nyquist 검증 갭을 소급하여 감사하고 보완합니다.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `N` | 아니요 | 단계 번호 |

```bash
/gsd-validate-phase 2               # 단계 2의 테스트 커버리지 감사
```

---

## 탐색 명령어

### `/gsd-progress`

상태, 다음 단계를 표시하고 자동으로 다음 논리적 워크플로 단계로 진행합니다. 프로젝트 상태를 읽고 적절한 조치를 결정합니다.

| 플래그 | 설명 |
|------|-------------|
| `--next` | 수동 경로 선택 없이 다음 논리적 워크플로 단계로 자동 진행 |
| `--do "task description"` | 자유 형식 의도를 분석하고 가장 적합한 GSD 명령어로 디스패치 |
| `--forensic` | 표준 보고서 후 6개 검사 무결성 감사 추가 (STATE 일관성, 고아 핸드오프, 연기된 범위 드리프트, 메모리 플래그 보류 작업, 블로킹 할일, 커밋되지 않은 코드) |

**자동 라우팅 동작 (`--next`):**
- 프로젝트 없음 → `/gsd-new-project` 제안
- 단계 논의 필요 → `/gsd-discuss-phase` 실행
- 단계 계획 필요 → `/gsd-plan-phase` 실행
- 단계 실행 필요 → `/gsd-execute-phase` 실행
- 단계 검증 필요 → `/gsd-verify-work` 실행
- 모든 단계 완료 → `/gsd-complete-milestone` 제안

```bash
/gsd-progress                       # "현재 어디에 있나? 다음은?" 자동 라우팅 포함
/gsd-progress --next                # 자동으로 다음 단계로 진행
/gsd-progress --do "fix the auth bug"  # 자유 형식 의도를 최적의 GSD 명령어로 디스패치
/gsd-progress --forensic            # 표준 보고서 + 무결성 감사
```

### `/gsd-resume-work`

마지막 세션에서 전체 컨텍스트를 복원합니다.

```bash
/gsd-resume-work                    # 컨텍스트 재설정 또는 새 세션 후
```

### `/gsd-pause-work`

단계 도중 중단할 때 컨텍스트 핸드오프를 저장합니다.

| 플래그 | 설명 |
|------|-------------|
| `--report` | 커밋, 파일 변경, 단계 진행 상황을 캡처한 세션 후 요약을 `.planning/reports/`에 생성 |

```bash
/gsd-pause-work                     # continue-here.md 생성
/gsd-pause-work --report            # continue-here.md + 세션 보고서 생성
```

### `/gsd-manager`

하나의 터미널에서 여러 단계를 관리하기 위한 대화형 명령 센터.

**전제 조건:** `.planning/ROADMAP.md` 존재
**동작:**
- 시각적 상태 표시기와 함께 모든 단계의 대시보드
- 의존성과 진행 상황을 기반으로 최적의 다음 조치 추천
- 작업 디스패치: discuss는 인라인으로 실행, plan/execute는 백그라운드 에이전트로 실행
- 하나의 터미널에서 단계 간 작업을 병렬화하는 파워 유저를 위해 설계
- `manager.flags` 설정을 통한 단계별 패스스루 플래그 지원 ([설정](CONFIGURATION.md#manager-passthrough-flags) 참조)

```bash
/gsd-manager                        # 명령 센터 대시보드 열기
/gsd-manager --analyze-deps         # 병렬 실행 전 ROADMAP 단계의 의존성 관계 스캔
```

**체크포인트 하트비트 (#2410):**

백그라운드 `execute-phase` 실행은 모든 웨이브 및 계획
경계에서 `[checkpoint]` 마커를 내보내므로 Claude API SSE 스트림이
다중 계획 단계에서 `Stream idle timeout - partial response received`를 트리거할 만큼 오래 유휴 상태가 되지 않습니다. 형식은 다음과 같습니다:

```
[checkpoint] phase {N} wave {W}/{M} starting, {count} plan(s), {P}/{Q} plans done
[checkpoint] phase {N} wave {W}/{M} plan {plan_id} starting ({P}/{Q} plans done)
[checkpoint] phase {N} wave {W}/{M} plan {plan_id} complete ({P}/{Q} plans done)
[checkpoint] phase {N} wave {W}/{M} complete, {P}/{Q} plans done ({ok}/{count} ok)
```

백그라운드 단계가 도중에 실패하면 `[checkpoint]`에 대해 트랜스크립트를 grep하여
마지막으로 확인된 경계를 확인하세요. 관리자의 백그라운드 완료 핸들러는
에이전트가 오류로 종료될 때 이 마커를 사용하여 부분 진행 상황을 보고합니다.

**관리자 패스스루 플래그:**

`.planning/config.json`의 `manager.flags`에서 단계별 플래그를 구성합니다. 이 플래그는 각 디스패치된 명령어에 추가됩니다:

```json
{
  "manager": {
    "flags": {
      "discuss": "--auto",
      "plan": "--skip-research",
      "execute": "--cross-ai"
    }
  }
}
```

---

### `/gsd-help`

요청한 수준에서 GSD 명령어를 표시합니다. 기본값은 화면 하나에 맞습니다; `--full`은 전체 참조; `<topic>`은 특정 섹션으로 바로 이동합니다.

```bash
/gsd-help                           # 한 페이지 개요 (기본값)
/gsd-help --brief                   # 주요 명령어의 ~10줄 요약
/gsd-help --full                    # 전체 참조 (모든 명령어, 모든 플래그)
/gsd-help <topic>                   # 하나의 섹션만 (예: /gsd-help debug)
/gsd-help --brief <topic>           # 압축된 범위 지정 조회 — 시그니처 + 한 줄 요약
```

전체 별칭 테이블은 `gsd-core/workflows/help/modes/topic.md`를 참조하세요. 알 수 없는 주제는 인식된 목록을 출력합니다.

---

## 유틸리티 명령어

### `/gsd-explore`

소크라테스식 아이디어 발상 세션 — 탐색 질문을 통해 아이디어를 안내하고, 선택적으로 리서치를 생성한 후 적절한 GSD 아티팩트(노트, 할일, 시드, 리서치 질문, 요구사항 또는 새 단계)로 출력을 라우팅합니다.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `topic` | 아니요 | 탐색할 주제 (예: `/gsd-explore authentication strategy`) |

```bash
/gsd-explore                        # 개방형 아이디어 발상 세션
/gsd-explore authentication strategy  # 특정 주제 탐색
```

---

### `/gsd-undo`

안전한 git 되돌리기 — 의존성 확인 및 확인 게이트를 통해 단계 매니페스트를 사용하여 GSD 단계 또는 계획 커밋 롤백.

| 플래그 | 필수 | 설명 |
|------|----------|-------------|
| `--last N` | (세 가지 중 하나 필수) | 대화형 선택을 위한 최근 GSD 커밋 표시 |
| `--phase NN` | (세 가지 중 하나 필수) | 단계의 모든 커밋 되돌리기 |
| `--plan NN-MM` | (세 가지 중 하나 필수) | 특정 계획의 모든 커밋 되돌리기 |

**안전성:** 되돌리기 전 의존하는 단계/계획 확인; 항상 확인 게이트 표시.

```bash
/gsd-undo --last 5                  # 최근 GSD 커밋 5개에서 선택
/gsd-undo --phase 03                # 단계 3의 모든 커밋 되돌리기
/gsd-undo --plan 03-02              # 단계 3의 계획 02 커밋 되돌리기
```

---

### `/gsd-import`

외부 계획 파일을 GSD 계획 시스템에 수집하고, 작성 전에 `PROJECT.md` 결정과의 충돌을 감지합니다.

| 플래그 | 필수 | 설명 |
|------|----------|--------------|
| `--from <filepath>` | 예 (`--from-gsd2`와 중 하나) | 가져올 외부 계획 파일 경로 |
| `--from-gsd2` | 예 (`--from`과 중 하나) | GSD-2 (`.gsd/`) 프로젝트를 GSD v1 (`.planning/`) 형식으로 역 마이그레이션 |
| `--path <dir>` | 아니요 | `--from-gsd2` 사용 시: GSD-2 프로젝트 디렉토리 경로 (기본값: 현재 디렉토리) |

**처리:** 충돌 감지 → 해결 프롬프트 → GSD PLAN.md로 작성 → `gsd-plan-checker`를 통한 검증

```bash
/gsd-import --from /tmp/team-plan.md    # 외부 계획 가져오기 및 검증
/gsd-import --from-gsd2                # GSD-2에서 v1으로 마이그레이션 (현재 디렉토리)
/gsd-import --from-gsd2 --path ~/old-project  # 다른 경로에서 마이그레이션
```

---

### `/gsd-ingest-docs`

리포지토리의 기존 ADR, PRD, SPEC, 문서에서 .planning/ 설정을 부트스트랩하거나 병합합니다. 병렬 분류(`gsd-doc-classifier`)와 우선순위 규칙 및 순환 감지를 통한 합성(`gsd-doc-synthesizer`)을 실행합니다. 세 가지 버킷 충돌 보고서(`INGEST-CONFLICTS.md`: 자동 해결됨, 경쟁 변형, 미해결 차단자)를 생성하고 LOCKED 대 LOCKED ADR 모순에서 하드 블록합니다.

| 인수 / 플래그 | 필수 | 설명 |
|-----------------|----------|-------------|
| `path` | 아니요 | 스캔할 대상 디렉토리 (기본값: 리포지토리 루트) |
| `--mode new\|merge` | 아니요 | 자동 감지 재정의 (기본값: `.planning/` 없으면 `new`, 있으면 `merge`) |
| `--manifest <file>` | 아니요 | 문서당 `{path, type, precedence?}`를 나열하는 YAML 파일; 휴리스틱 분류 재정의 |
| `--resolve auto` | 아니요 | 충돌 해결 모드 (v1: `auto`만; `interactive`는 예약됨) |

**제한:** v1은 호출당 최대 50개 문서. 공유 충돌 감지 계약을 `references/doc-conflict-engine.md`로 추출하며, `/gsd-import`도 이를 사용합니다.

```bash
/gsd-ingest-docs                            # 리포지토리 루트 스캔, 모드 자동 감지
/gsd-ingest-docs docs/                      # docs/ 아래만 수집
/gsd-ingest-docs --manifest ingest.yaml     # 명시적 우선순위 매니페스트
```

---

### `/gsd-quick`

GSD 보장을 통해 애드혹 작업을 실행합니다.

| 플래그 | 설명 |
|------|-------------|
| `--full` | 완전한 품질 파이프라인 활성화 — 논의 + 리서치 + 계획 확인 + 검증 |
| `--validate` | 계획 확인(최대 2회 반복) + 실행 후 검증만; 논의 또는 리서치 없음 |
| `--discuss` | 가벼운 사전 계획 논의 |
| `--research` | 계획 전 집중 리서처 생성 |

세분화된 플래그는 조합 가능합니다: `--discuss --research --validate`는 `--full`과 동일합니다.

| 서브커맨드 | 설명 |
|------------|-------------|
| `list` | 상태와 함께 모든 빠른 작업 나열 |
| `status <slug>` | 특정 빠른 작업의 상태 표시 |
| `resume <slug>` | 슬러그로 특정 빠른 작업 재개 |

```bash
/gsd-quick                          # 기본 빠른 작업
/gsd-quick --discuss --research     # 논의 + 리서치 + 계획
/gsd-quick --validate               # 계획 확인 + 검증만
/gsd-quick --full                   # 완전한 품질 파이프라인
/gsd-quick list                     # 모든 빠른 작업 나열
/gsd-quick status my-task-slug      # 빠른 작업 상태 표시
/gsd-quick resume my-task-slug      # 빠른 작업 재개
```

### `/gsd-autonomous`

나머지 모든 단계를 자율적으로 실행합니다.

| 플래그 | 설명 |
|------|-------------|
| `--from N` | 특정 단계 번호부터 시작 |
| `--to N` | 특정 단계 번호 완료 후 중지 |
| `--interactive` | 사용자 입력과 함께 간소화된 컨텍스트 |

```bash
/gsd-autonomous                     # 나머지 모든 단계 실행
/gsd-autonomous --from 3            # 단계 3부터 시작
/gsd-autonomous --to 5              # 단계 5까지 실행
/gsd-autonomous --from 3 --to 5     # 단계 3부터 5까지 실행
```

### `/gsd-debug`

지속적인 상태로 체계적인 디버깅.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `description` | 아니요 | 버그 설명 |

| 플래그 | 설명 |
|------|-------------|
| `--diagnose` | 진단 전용 모드 — 수정 시도 없이 조사 |

**서브커맨드:**
- `/gsd-debug list` — 상태, 가설, 다음 조치와 함께 모든 활성 디버그 세션 나열
- `/gsd-debug status <slug>` — 에이전트를 생성하지 않고 세션의 전체 요약(증거 수, 제거 수, 해결책, TDD 체크포인트) 출력
- `/gsd-debug continue <slug>` — 슬러그로 특정 세션 재개 (현재 포커스 표시 후 계속 에이전트 생성)
- `/gsd-debug [--diagnose] <description>` — 새 디버그 세션 시작 (기존 동작; `--diagnose`는 수정 적용 없이 근본 원인에서 중지)

**TDD 모드:** `.planning/config.json`에서 `tdd_mode: true`일 때, 디버그 세션은 수정을 적용하기 전에 실패하는 테스트를 작성하고 검증해야 합니다 (red → green → done).

```bash
/gsd-debug "Login button not responding on mobile Safari"
/gsd-debug --diagnose "Intermittent 500 errors on /api/users"
/gsd-debug list
/gsd-debug status auth-token-null
/gsd-debug continue form-submit-500
```

### `/gsd-add-tests`

완료된 단계에 대한 테스트를 생성합니다.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `N` | 아니요 | 단계 번호 |

```bash
/gsd-add-tests 2                    # 단계 2의 테스트 생성
```

### `/gsd-stats`

프로젝트 통계를 표시합니다.

```bash
/gsd-stats                          # 프로젝트 메트릭 대시보드
```

### `/gsd-profile-user`

8개 차원(커뮤니케이션 스타일, 결정 패턴, 디버깅 접근법, UX 선호도, 벤더 선택, 불만 유발 요인, 학습 스타일, 설명 깊이)에 걸친 Claude Code 세션 분석으로 개발자 행동 프로필을 생성합니다. Claude의 응답을 개인화하는 아티팩트를 생성합니다.

| 플래그 | 설명 |
|------|-------------|
| `--questionnaire` | 세션 분석 대신 대화형 설문지 사용 |
| `--refresh` | 세션 재분석 및 프로필 재생성 |

**생성 아티팩트:**
- `USER-PROFILE.md` — 전체 행동 프로필
- `CLAUDE.md` 프로필 섹션 — Claude Code에 의해 자동 검색

```bash
/gsd-profile-user                   # 세션 분석 및 프로필 구축
/gsd-profile-user --questionnaire   # 대화형 설문지 대안
/gsd-profile-user --refresh         # 새 분석에서 재생성
```

### `/gsd-health`

`.planning/` 디렉토리 무결성을 검증합니다. `--context` 사용 시 컨텍스트 창
활용 가드를 60% / 70% 임계값에 대해 탐색합니다 (v1.40.0 추가,
[#2792](https://github.com/open-gsd/gsd-core/issues/2792)).

| 플래그 | 설명 |
|------|-------------|
| `--repair` | 복구 가능한 문제 자동 수정 |
| `--context` | 컨텍스트 창 활용 탐색; 60%에서 경고, 70%에서 심각 |

```bash
/gsd-health                         # 무결성 확인
/gsd-health --repair                # 확인 및 수정
/gsd-health --context               # 컨텍스트 활용 트리아지
```

### `/gsd-cleanup`

완료된 마일스톤에서 누적된 단계 디렉토리를 아카이브하고 업스트림이 삭제된 로컬 브랜치를 정리합니다.

**동작:** 아카이브할 단계 디렉토리의 드라이런 요약(`.planning/phases/`에서 `.planning/milestones/v{X.Y}-phases/`로 이동)과 업스트림이 없어진 로컬 브랜치(`git fetch --prune`으로 정리)를 표시합니다. 변경 사항 작성 전 확인이 필요합니다. 현재 체크아웃된 브랜치는 절대 정리되지 않습니다.

```bash
/gsd-cleanup
```

---

## 스파이킹 및 스케칭 명령어

### `/gsd-spike`

구현 방식을 확정하기 전에 2–5개의 집중된 실현 가능성 실험을 실행합니다. 각 실험은 Given/When/Then 프레임으로 실행 가능한 코드를 생성하고 VALIDATED / INVALIDATED / PARTIAL 판정을 반환합니다.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `idea` | 아니요 | 조사할 기술적 질문 또는 접근법 |
| `--quick` | 아니요 | 입력 대화 건너뜀; `idea` 텍스트를 직접 사용 |
| `--wrap-up` | 아니요 | 완료된 스파이크 결과를 재사용 가능한 프로젝트 로컬 스킬로 패키징 |

**생성 결과:** 코드, 결과, README가 포함된 `.planning/spikes/NNN-experiment-name/`; `.planning/spikes/MANIFEST.md`
**`--wrap-up` 생성 결과:** `.claude/skills/spike-findings-[project]/` 스킬 파일

```bash
/gsd-spike                              # 대화형 입력
/gsd-spike "can we stream LLM tokens through SSE"
/gsd-spike --quick websocket-vs-polling
/gsd-spike --wrap-up                    # 결과를 재사용 가능한 스킬로 패키징
```

---

### `/gsd-sketch`

구현을 확정하기 전에 일회용 HTML 목업을 통해 디자인 방향을 탐색합니다. 직접 브라우저 비교를 위해 디자인 질문당 2–3개의 변형을 생성합니다.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `idea` | 아니요 | 탐색할 UI 디자인 질문 또는 방향 |
| `--quick` | 아니요 | 분위기 입력 건너뜀; `idea` 텍스트를 직접 사용 |
| `--text` | 아니요 | 텍스트 모드 대안 — 대화형 프롬프트를 번호 목록으로 대체 (비 Claude 런타임용) |
| `--wrap-up` | 아니요 | 채택된 스케치 결정을 재사용 가능한 프로젝트 로컬 스킬로 패키징 |

**생성 결과:** `.planning/sketches/NNN-descriptive-name/index.html` (2–3개의 대화형 변형), `README.md`, 공유 `themes/default.css`; `.planning/sketches/MANIFEST.md`
**`--wrap-up` 생성 결과:** `.claude/skills/sketch-findings-[project]/` 스킬 파일

```bash
/gsd-sketch                             # 대화형 분위기 입력
/gsd-sketch "dashboard layout"
/gsd-sketch --quick "sidebar navigation"
/gsd-sketch --text "onboarding flow"    # 비 Claude 런타임
/gsd-sketch --wrap-up                   # 채택된 스케치를 스킬로 패키징
```

---

## 진단 명령어

### `/gsd-forensics`

실패한 GSD 워크플로에 대한 사후 조사 — 무엇이 잘못되었는지 진단합니다.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `description` | 아니요 | 문제 설명 (생략 시 프롬프트) |

**전제 조건:** `.planning/` 디렉토리 존재
**생성 결과:** `.planning/forensics/report-{timestamp}.md`

**조사 범위:**
- Git 기록 분석 (최근 커밋, 정체 패턴, 시간 공백)
- 아티팩트 무결성 (완료된 단계에 예상되는 파일)
- STATE.md 이상 및 세션 기록
- 커밋되지 않은 작업, 충돌, 포기된 변경사항
- 최소 4가지 이상 유형 확인 (정체 루프, 누락된 아티팩트, 포기된 작업, 충돌/중단)
- 실행 가능한 결과가 있는 경우 GitHub 이슈 생성 제안

```bash
/gsd-forensics                              # 대화형 — 문제에 대한 프롬프트
/gsd-forensics "Phase 3 execution stalled"  # 문제 설명과 함께
```

---

### `/gsd-extract-learnings`

완료된 단계 작업에서 재사용 가능한 패턴, 안티패턴, 아키텍처 결정을 추출합니다.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `N` | **예** | 학습 내용을 추출할 단계 번호 |

| 플래그 | 설명 |
|------|-------------|
| `--all` | 모든 완료된 단계에서 학습 내용 추출 |
| `--format` | 출력 형식: `markdown` (기본값), `json` |

**전제 조건:** 단계가 실행됨 (SUMMARY.md 파일 존재)
**생성 결과:** `.planning/learnings/{phase}-LEARNINGS.md`

**추출 내용:**
- 아키텍처 결정 및 근거
- 잘 작동한 패턴 (향후 단계에서 재사용 가능)
- 발생한 안티패턴과 해결 방법
- 기술별 인사이트
- 성능 및 테스트 관찰

```bash
/gsd-extract-learnings 3                    # 단계 3에서 학습 내용 추출
/gsd-extract-learnings --all                # 모든 완료된 단계에서 추출
```

---

## 워크스트림 관리

### `/gsd-workstreams`

다양한 마일스톤 영역에서 동시 작업을 위한 병렬 워크스트림을 관리합니다.

**서브커맨드:**

| 서브커맨드 | 설명 |
|------------|-------------|
| `list` | 상태와 함께 모든 워크스트림 나열 (서브커맨드 없을 때 기본값) |
| `create <name>` | 새 워크스트림 생성 |
| `status <name>` | 하나의 워크스트림에 대한 상세 상태 |
| `switch <name>` | 활성 워크스트림 설정 |
| `progress` | 모든 워크스트림에 걸친 진행 요약 |
| `complete <name>` | 완료된 워크스트림 아카이브 |
| `resume <name>` | 워크스트림에서 작업 재개 |

**전제 조건:** 활성 GSD 프로젝트
**생성 결과:** `.planning/` 아래의 워크스트림 디렉토리, 워크스트림별 상태 추적

```bash
/gsd-workstreams                    # 모든 워크스트림 나열
/gsd-workstreams create backend-api # 새 워크스트림 생성
/gsd-workstreams switch backend-api # 활성 워크스트림 설정
/gsd-workstreams status backend-api # 상세 상태
/gsd-workstreams progress           # 크로스 워크스트림 진행 개요
/gsd-workstreams complete backend-api  # 완료된 워크스트림 아카이브
/gsd-workstreams resume backend-api    # 워크스트림에서 작업 재개
```

---

## 설정 명령어

### `/gsd-settings`

워크플로 토글과 모델 프로필의 대화형 설정. 질문은 여섯 개의 시각적 섹션으로 그룹화됩니다:

- **계획** — 리서치, 계획 검사기, 패턴 매퍼, Nyquist, UI 단계, UI 게이트, AI 단계
- **실행** — 검증기, TDD 모드, 코드 리뷰, 코드 리뷰 깊이 _(조건부 — 코드 리뷰가 켜져 있을 때만)_, UI 리뷰
- **문서 및 출력** — 커밋 문서, 논의 건너뜀, 워크트리
- **기능** — Intel, Graphify
- **모델 및 파이프라인** — 모델 프로필, 자동 진행, 분기
- **기타** — 컨텍스트 경고, 리서치 Q

모든 응답은 `gsd-tools query config-set`을 통해 해결된 프로젝트 설정 경로(일반 설치의 경우 `.planning/config.json`, 워크스트림이 활성화된 경우 `.planning/workstreams/<active>/config.json`)에 병합되며 관련 없는 키는 보존됩니다. 확인 후 사용자는 전체 설정 객체를 `~/.gsd/defaults.json`에 저장할 수 있으므로 향후 `/gsd-new-project` 실행이 동일한 기준으로 시작됩니다.

```bash
/gsd-settings                       # 대화형 설정
```

### `/gsd-config`

GSD 설정을 대화형으로 구성합니다 — 워크플로 토글, 고급 노브, 통합, 모델 프로필 — 단일 통합 명령어로.

| 플래그 | 설명 |
|------|-------------|
| (없음) | 일반적인 토글: 모델, 리서치, plan_check, 검증기, 분기 |
| `--advanced` | 파워 유저 노브: 계획 조정, 타임아웃, 브랜치 템플릿, 크로스 AI 실행, 런타임/출력 |
| `--integrations` | 서드파티 API 키, 코드 리뷰 CLI 라우팅, 에이전트 스킬 주입 |
| `--profile <name>` | 빠른 프로필 전환: `quality`, `balanced`, `budget`, 또는 `inherit` |

**`--advanced` 섹션:**

| 섹션 | 키 |
|---------|------|
| 계획 조정 | `workflow.plan_bounce`, `workflow.plan_bounce_passes`, `workflow.plan_bounce_script`, `workflow.subagent_timeout`, `workflow.inline_plan_threshold` |
| 실행 조정 | `workflow.node_repair`, `workflow.node_repair_budget`, `workflow.auto_prune_state` |
| 논의 조정 | `workflow.max_discuss_passes` |
| 크로스 AI 실행 | `workflow.cross_ai_execution`, `workflow.cross_ai_command`, `workflow.cross_ai_timeout` |
| Git 커스터마이징 | `git.base_branch`, `git.phase_branch_template`, `git.milestone_branch_template` |
| 런타임 / 출력 | `response_language`, `context_window`, `search_gitignored`, `graphify.build_timeout` |

모든 응답은 `gsd-tools query config-set`을 통해 관련 없는 키를 보존하며 병합됩니다. API 키는 모든 출력에서 마스킹됩니다 (`****<last-4>`).

```bash
/gsd-config                         # 일반적인 대화형 설정
/gsd-config --advanced              # 파워 유저 노브 (6섹션 프롬프트)
/gsd-config --integrations          # API 키, 리뷰 CLI 라우팅, 에이전트 스킬
/gsd-config --profile budget        # 예산 프로필로 전환
/gsd-config --profile quality       # 품질 프로필로 전환
```

전체 스키마와 기본값은 [CONFIGURATION.md](CONFIGURATION.md)를 참조하세요.

### `/gsd-surface`

재설치 없이 표시되는 스킬 토글 — 프로필 적용, 나열, 또는 클러스터 비활성화.

| 서브커맨드 | 설명 |
|------------|-------------|
| `list` | 활성화 및 비활성화된 클러스터와 스킬 표시 |
| `status` | `list` + 토큰 비용 요약의 별칭 |
| `profile <name>` | `baseProfile` 작성 및 스킬 재스테이징 |
| `disable <cluster>` | 비활성화 목록에 클러스터 추가 및 재스테이징 |
| `enable <cluster>` | 비활성화 목록에서 클러스터 제거 및 재스테이징 |
| `reset` | 표면 델타 삭제; 설치 시 프로필로 복원 |

```bash
/gsd-surface list                   # 현재 표면 표시
/gsd-surface profile standard       # 표준 프로필로 전환
/gsd-surface disable utility        # 유틸리티 클러스터 비활성화
/gsd-surface reset                  # 설치 시 프로필 복원
```

---

## 브라운필드 명령어

### `/gsd-map-codebase`

병렬 매퍼 에이전트로 기존 코드베이스를 분석합니다. `--fast`로 빠른 단일 에이전트 스캔을 하거나, `--query`로 기존 인텔을 검색합니다.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `area` | 아니요 | 특정 영역으로 매핑 범위 제한 |
| `--fast` | 아니요 | 빠른 단일 포커스 평가 — 4개의 병렬 에이전트 대신 하나의 매퍼 에이전트를 생성 (경량 대안) |
| `--query <term>` | 아니요 | `.planning/intel/`의 쿼리 가능한 코드베이스 인텔 파일 검색 (`intel.enabled: true` 필요) |

| 플래그 | 설명 |
|------|-------------|
| `--focus tech\|arch\|quality\|concerns\|tech+arch` | `--fast` 모드의 포커스 영역 (기본값: `tech+arch`) |

**생성 결과:** `.planning/codebase/` 분석 문서 (전체 모드); `.planning/codebase/`의 대상 문서 (`--fast`); 인텔 쿼리 결과 (`--query`)

```bash
/gsd-map-codebase                   # 전체 코드베이스 분석 (4개 병렬 에이전트)
/gsd-map-codebase auth              # auth 영역에 집중
/gsd-map-codebase --fast            # 빠른 기술 + 아키텍처 개요 (1 에이전트)
/gsd-map-codebase --fast --focus quality  # 품질 및 코드 건강도만
/gsd-map-codebase --query authentication  # 인텔에서 용어 검색
```

### `/gsd-graphify`

`.planning/graphs/`에 저장된 프로젝트 지식 그래프를 구축, 쿼리, 검사합니다. `config.json`에서 `graphify.enabled: true`로 옵트인 ([설정 참조](CONFIGURATION.md#graphify-settings) 참조); 비활성화된 경우 명령어가 활성화 힌트를 출력하고 중지합니다.

| 서브커맨드 | 설명 |
|------------|-------------|
| `build` | 지식 그래프 구축 또는 재구축 (`graphify update .`를 인라인으로 실행하고 `.planning/graphs/` 새로 고침) |
| `query <term>` | 그래프에서 용어 검색 |
| `status` | 그래프 신선도 및 통계 표시 |
| `diff` | 마지막 빌드 이후의 변경사항 표시 |

**생성 결과:** `.planning/graphs/` 그래프 아티팩트 (노드, 에지, 스냅샷)

```bash
/gsd-graphify build                 # 지식 그래프 구축 또는 재구축
/gsd-graphify query authentication  # 그래프에서 용어 검색
/gsd-graphify status                # 신선도 및 통계 표시
/gsd-graphify diff                  # 마지막 빌드 이후의 변경사항 표시
```

**프로그래밍 방식 접근:** `node gsd-tools.cjs graphify <build|query|status|diff|snapshot>` — [CLI 도구 참조](CLI-TOOLS.md) 참조.

### `gsd-tools intel api-surface`

`/gsd-map-codebase`가 구축한 `.planning/intel/api-map.json` 인덱스를 `.planning/intel/`의 사람이 읽을 수 있는 `API-SURFACE.md`로 렌더링합니다. `config.json`에서 `intel.enabled: true`로 게이팅되며; Intel이 비활성화된 경우 명령어가 활성화 힌트를 출력하고 종료합니다. 출력 경로는 항상 `.planning/intel/API-SURFACE.md` — `--out` 또는 `--format` 플래그가 없습니다. `api-map.json`이 없거나 비어 있으면 명령어는 여전히 명시적인 "불완전" 배너와 함께 파일을 작성하므로 소비자가 침묵을 "아무것도 없음"으로 혼동하지 않습니다.

**생성 결과:** `.planning/intel/API-SURFACE.md`

```bash
node gsd-tools.cjs intel api-surface              # api-map.json → API-SURFACE.md 렌더링
```

`API-SURFACE.md` 출력은 소스 파일별로 그룹화된 내보낸 심볼(함수, 클래스, 데코레이터, 상수)을 서명과 감지된 가시성과 함께 나열합니다. `plan_review.source_grounding_authority`가 `intel`로 설정된 경우 계획 드리프트 가드는 `api-surface` 렌더러를 호출하는 대신 `api-map.json`을 직접 읽습니다.

---

## AI 통합 명령어

### `/gsd-ai-integration-phase`

AI 시스템 구축을 포함하는 단계에 대한 AI-SPEC.md 디자인 계약을 생성합니다. 대화형 결정 매트릭스를 제공하고, 도메인별 장애 모드와 평가 기준을 표시하며, 프레임워크 추천, 구현 지침, 평가 전략이 담긴 `AI-SPEC.md`를 생성합니다.

**생성 결과:** 단계 디렉토리의 `{phase}-AI-SPEC.md`

**생성 에이전트:** 3개의 병렬 전문 에이전트: domain-researcher, framework-selector, ai-researcher, eval-planner

```bash
/gsd-ai-integration-phase              # 현재 단계의 마법사
/gsd-ai-integration-phase 3           # 특정 단계의 마법사
```

---

### `/gsd-eval-review`

실행된 AI 단계의 평가 커버리지를 감사하고 EVAL-REVIEW.md 개선 계획을 생성합니다. `/gsd-ai-integration-phase`가 생성한 `AI-SPEC.md` 평가 계획에 대한 구현을 확인합니다. 각 평가 차원을 COVERED/PARTIAL/MISSING으로 점수를 매깁니다.

**전제 조건:** 단계가 실행되었고 `AI-SPEC.md`가 있음
**생성 결과:** 결과, 갭, 개선 지침이 담긴 `{phase}-EVAL-REVIEW.md`

```bash
/gsd-eval-review                       # 현재 단계 감사
/gsd-eval-review 3                     # 특정 단계 감사
```

---

## 업데이트 명령어

### `/gsd-update`

변경 로그 미리보기와 함께 GSD를 업데이트하고, 선택적으로 스킬을 동기화하거나 로컬 패치를 재적용합니다.

| 플래그 | 설명 |
|------|-------------|
| `--sync` | 업데이트 후 GSD 레지스트리에서 스킬 동기화 |
| `--reapply` | 업데이트 후 로컬 수정사항(패치) 복원 |

```bash
/gsd-update                         # 업데이트 확인 및 설치
/gsd-update --sync                  # 업데이트 및 스킬 동기화
/gsd-update --reapply               # 업데이트 및 로컬 패치 재적용
```

---

## 코드 품질 명령어

### `/gsd-code-review`

버그, 보안 취약점, 코드 품질 문제에 대해 단계 동안 변경된 소스 파일을 검토합니다. `--fix`를 사용하여 검토 후 결과를 자동 수정합니다.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `N` | **예** | 검토할 변경사항이 있는 단계 번호 (예: `2` 또는 `02`) |
| `--depth=quick\|standard\|deep` | 아니요 | 검토 깊이 수준 (`workflow.code_review_depth` 설정 재정의). `quick`: 패턴 매칭만 (~2분). `standard`: 언어별 검사를 통한 파일별 분석 (~5–15분, 기본값). `deep`: 임포트 그래프와 호출 체인을 포함한 크로스 파일 분석 (~15–30분) |
| `--files file1,file2,...` | 아니요 | 명시적 쉼표 구분 파일 목록; SUMMARY/git 범위 지정을 완전히 건너뜀 |
| `--fix` | 아니요 | 검토 후 자동 문제 수정 — REVIEW.md를 읽고, 수정자 에이전트를 생성하고, 각 수정을 원자적으로 커밋 |
| `--fix --all` | 아니요 | 수정 범위에 Info 결과 포함 (기본값: Critical + Warning만) |
| `--fix --auto` | 아니요 | 수정 + 재검토 반복 루프, 최대 3회 반복 |

**전제 조건:** 단계가 실행되었고 SUMMARY.md 또는 git 기록이 있음
**생성 결과:** 심각도별 분류된 결과가 포함된 `{phase}-REVIEW.md`; `--fix` 사용 시 `{phase}-REVIEW-FIX.md`
**생성 에이전트:** `gsd-code-reviewer` 에이전트; `--fix` 사용 시 `gsd-code-fixer` 에이전트

**선택적 구조적 사전 통과:** `code_quality.fallow.enabled`를 `true`로 설정하면 에이전트 검토 전에 fallow를 실행합니다. GSD는 `{phase}/FALLOW.json`을 작성하고 `REVIEW.md`에 `Structural Findings (fallow)` 섹션을 포함합니다. `code_quality.fallow.scope`와 `code_quality.fallow.profile`로 범위와 프로필을 설정합니다.

```bash
/gsd-code-review 3                          # 단계 3의 표준 검토
/gsd-code-review 2 --depth=deep             # 딥 크로스 파일 검토
/gsd-code-review 4 --files src/auth.ts,src/token.ts  # 명시적 파일 목록
/gsd-code-review 3 --fix                    # 검토 후 Critical + Warning 결과 수정
/gsd-code-review 3 --fix --all             # 검토 후 Info 포함 모든 결과 수정
/gsd-code-review 3 --fix --auto            # 검토, 수정, 깨끗해질 때까지 재검토 (최대 3회 반복)
```

---

### `/gsd-audit-fix`

자율 감사-수정 파이프라인 — 감사를 실행하고, 결과를 분류하고, 테스트 검증으로 자동 수정 가능한 문제를 수정하고, 각 수정을 원자적으로 커밋합니다.

| 플래그 | 설명 |
|------|-------------|
| `--source <audit>` | 실행할 감사 (기본값: `audit-uat`) |
| `--severity high\|medium\|all` | 처리할 최소 심각도 (기본값: `medium`) |
| `--max N` | 수정할 최대 결과 수 (기본값: 5) |
| `--dry-run` | 수정 없이 결과 분류 (분류 테이블 표시) |

**전제 조건:** 최소 한 단계가 UAT 또는 검증과 함께 실행됨
**생성 결과:** 테스트 검증이 포함된 수정 커밋; 분류 보고서

```bash
/gsd-audit-fix                              # audit-uat 실행, medium+ 문제 수정 (최대 5개)
/gsd-audit-fix --severity high             # 고심각도 문제만 수정
/gsd-audit-fix --dry-run                   # 수정 없이 분류 미리보기
/gsd-audit-fix --max 10 --severity all     # 모든 심각도의 최대 10개 문제 수정
```

---

## 빠른 & 인라인 명령어

### `/gsd-fast`

서브에이전트 없이 사소한 작업을 인라인으로 실행합니다 — 계획 오버헤드 없음. 오타 수정, 설정 변경, 소규모 리팩토링, 빠뜨린 커밋에 사용합니다.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `task description` | 아니요 | 할 일 (생략 시 프롬프트) |

**`/gsd-quick`의 대안이 아닙니다** — 리서치, 다단계 계획, 또는 검증이 필요한 작업에는 `/gsd-quick`을 사용하세요.

```bash
/gsd-fast "fix typo in README"
/gsd-fast "add .env to gitignore"
```

---

### `/gsd-review`

외부 AI CLI로부터 단계 계획의 크로스 AI 동료 검토.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `--phase N` | **예** | 검토할 단계 번호 |

| 플래그 | 설명 |
|------|-------------|
| `--gemini` | Gemini CLI 검토 포함 |
| `--claude` | Claude CLI 검토 포함 (별도 세션) |
| `--codex` | Codex CLI 검토 포함 |
| `--coderabbit` | CodeRabbit 검토 포함 |
| `--opencode` | OpenCode 검토 포함 (GitHub Copilot을 통해) |
| `--qwen` | Qwen Code 검토 포함 (Alibaba Qwen 모델) |
| `--cursor` | Cursor 에이전트 검토 포함 |
| `--agy` / `--antigravity` | Antigravity CLI 검토 포함 (Google 자격증명으로 무료) |
| `--ollama` | Ollama 서버 검토 포함 |
| `--lm-studio` | LM Studio 서버 검토 포함 |
| `--llama-cpp` | llama.cpp 서버 검토 포함 |
| `--all` | 사용 가능한 모든 리뷰어 포함 (CLI + 로컬 모델 서버) |

**기본 리뷰어 동작 (플래그 없음):**
- `review.default_reviewers`가 **설정되지 않은** 경우, `/gsd-review`는 감지된 모든 리뷰어를 실행합니다 (현재 기본 동작).
- `review.default_reviewers`가 **설정된** 경우, `/gsd-review`는 해당 하위 집합만 실행합니다 (예: `["gemini","codex"]`).
- `--all`은 항상 설정을 재정의하고 전체 감지된 집합을 실행합니다.
- 명시적 플래그 (예: `--cursor`)는 해당 실행에 대해 `--all`과 설정 기본값 모두를 재정의합니다.

**생성 결과:** `{phase}-REVIEWS.md` — `/gsd-plan-phase --reviews`에서 사용 가능

```bash
# 플래그 없는 /gsd-review 실행을 위한 프로젝트 기본 리뷰어 설정
gsd config-set review.default_reviewers '["gemini","codex"]'

/gsd-review --phase 2             # 설정에서 gemini+codex 실행
/gsd-review --phase 3 --all
/gsd-review --phase 2 --gemini
/gsd-review --phase 2 --cursor    # 일회성 재정의
```

---

### `/gsd-pr-branch`

`.planning/` 커밋을 필터링하여 깨끗한 PR 브랜치를 생성합니다.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `target branch` | 아니요 | 베이스 브랜치 (기본값: `main`) |

**목적:** 리뷰어는 GSD 계획 아티팩트가 아닌 코드 변경사항만 봅니다.

```bash
/gsd-pr-branch                     # main 기준으로 필터링
/gsd-pr-branch develop             # develop 기준으로 필터링
```

---

### `/gsd-secure-phase`

완료된 단계의 위협 완화를 소급하여 검증합니다.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `phase number` | 아니요 | 감사할 단계 (기본값: 마지막 완료 단계) |

**전제 조건:** 단계가 실행되어야 합니다. 기존 SECURITY.md 여부와 관계없이 작동합니다.
**생성 결과:** 위협 검증 결과가 포함된 `{phase}-SECURITY.md`
**생성 에이전트:** `gsd-security-auditor` 에이전트

세 가지 운영 모드:
1. SECURITY.md 존재 — 기존 완화 감사 및 검증
2. SECURITY.md 없지만 PLAN.md에 위협 모델 있음 — 아티팩트에서 생성
3. 단계 미실행 — 안내와 함께 종료

```bash
/gsd-secure-phase                   # 마지막 완료 단계 감사
/gsd-secure-phase 5                 # 특정 단계 감사
```

---

### `/gsd-docs-update`

코드베이스에 대한 검증을 통해 프로젝트 문서를 생성하거나 업데이트합니다.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| `--force` | 아니요 | 보존 프롬프트 건너뜀, 모든 문서 재생성 |
| `--verify-only` | 아니요 | 기존 문서의 정확성 확인, 생성 없음 |

**생성 결과:** 최대 9개의 문서 파일 (README, 아키텍처, API, 시작하기, 개발, 테스트, 설정, 배포, 기여)
**생성 에이전트:** `gsd-doc-writer` 에이전트 (문서 유형당 하나), 그 후 사실 검증을 위한 `gsd-doc-verifier` 에이전트

각 문서 작성자는 코드베이스를 직접 탐색합니다 — 환각된 경로나 오래된 서명 없음. 문서 검증자는 라이브 파일시스템에 대한 주장을 확인합니다.

```bash
/gsd-docs-update                    # 대화형으로 문서 생성/업데이트
/gsd-docs-update --force            # 모든 문서 재생성
/gsd-docs-update --verify-only      # 기존 문서만 검증
```

---

## 작업 캡처 및 백로그 명령어

### `/gsd-capture`

아이디어, 작업, 노트, 시드를 적절한 대상으로 캡처합니다. 기본 모드는 구조화된 할일을 추가하며; 플래그는 특수화된 캡처 워크플로로 라우팅합니다.

| 플래그 | 설명 |
|------|-------------|
| (없음) | 나중 작업을 위한 구조화된 할일로 캡처 |
| `--note [text]` | 마찰 없는 노트 — 추가, 나열 (`--note list`), 또는 승격 (`--note promote N`) |
| `--backlog <description>` | 999.x 번호 체계를 사용하여 백로그 주차장에 추가 |
| `--seed [idea summary]` | 트리거 조건이 있는 미래 지향적 아이디어 캡처 |
| `--list` | 보류 중인 할일 나열 및 작업할 항목 선택 |
| `--global` | 전역 범위 사용 (노트 작업용) |

**백로그:** 999.x 번호 체계는 활성 단계 시퀀스 외부에 항목을 유지합니다; 단계 디렉토리는 즉시 생성되므로 `/gsd-discuss-phase`와 `/gsd-plan-phase`가 작동합니다.
**시드:** 전체 WHY, 언제 표시할지, 이동 경로를 보존합니다 — `/gsd-new-milestone`이 사용합니다.

**생성 결과:** `.planning/todos/` (기본값), 노트 파일 (--note), ROADMAP.md 백로그 섹션 (--backlog), `.planning/seeds/SEED-NNN-slug.md` (--seed)

```bash
/gsd-capture "Consider adding dark mode support"   # 할일 추가
/gsd-capture --note "Caching strategy idea"        # 빠른 노트
/gsd-capture --note list                           # 모든 노트 나열
/gsd-capture --note promote 3                      # 노트 3을 할일로 승격
/gsd-capture --backlog "GraphQL API layer"         # 백로그에 추가
/gsd-capture --seed "Add real-time collaboration when WebSocket infra is in place"
/gsd-capture --list                                # 할일 탐색 및 실행
```

---

### `/gsd-review-backlog`

백로그 항목을 검토하고 활성 마일스톤으로 승격합니다.

**항목당 조치:** 승격 (활성 시퀀스로 이동), 유지 (백로그에 남김), 삭제.

```bash
/gsd-review-backlog
```

---

### `/gsd-thread`

크로스 세션 작업을 위한 지속적인 컨텍스트 스레드를 관리합니다.

| 인수 | 필수 | 설명 |
|----------|----------|-------------|
| (없음) / `list` | — | 모든 스레드 나열 |
| `list --open` | — | 상태가 `open` 또는 `in_progress`인 스레드만 나열 |
| `list --resolved` | — | 상태가 `resolved`인 스레드만 나열 |
| `status <slug>` | — | 특정 스레드의 상태 표시 |
| `close <slug>` | — | 스레드를 해결됨으로 표시 |
| `name` | — | 이름으로 기존 스레드 재개 |
| `description` | — | 새 스레드 생성 |

스레드는 여러 세션에 걸쳐 작업하지만 특정 단계에 속하지 않는 작업을 위한 경량 크로스 세션 지식 저장소입니다. `/gsd-pause-work`보다 더 가볍습니다.

```bash
/gsd-thread                         # 모든 스레드 나열
/gsd-thread list --open             # 열린/진행 중인 스레드만 나열
/gsd-thread list --resolved         # 해결된 스레드만 나열
/gsd-thread status fix-deploy-key   # 스레드 상태 표시
/gsd-thread close fix-deploy-key    # 스레드를 해결됨으로 표시
/gsd-thread fix-deploy-key-auth     # 스레드 재개
/gsd-thread "Investigate TCP timeout in pasta service"  # 새 스레드 생성
```

---

## 로드맵 관리 명령어

### `roadmap validate`

마일스톤 접두사 일관성을 포함한 구조적 무결성에 대해 ROADMAP.md를 검증합니다.

**전제 조건:** `.planning/ROADMAP.md` 존재
**생성 결과:** 검증 보고서; 오류 또는 경고 시 비제로로 종료

```bash
node gsd-tools.cjs roadmap validate
```

---

### `roadmap upgrade --convention milestone-prefixed`

레거시 `Phase N` ID를 마일스톤 접두사 `Phase M-NN` 규칙으로 마이그레이션합니다.

| 플래그 | 필수 | 설명 |
|------|----------|-------------|
| `--convention milestone-prefixed` | 예 | 마이그레이션할 대상 규칙 |
| `--apply` | 아니요 | 디스크에 변경사항 작성 (기본값: 드라이런만) |

**전제 조건:** `.planning/ROADMAP.md` 존재
**생성 결과:** 드라이런 diff (기본값) 또는 인플레이스 ROADMAP.md 재작성 (`--apply`)

```bash
node gsd-tools.cjs roadmap upgrade --convention milestone-prefixed         # 드라이런
node gsd-tools.cjs roadmap upgrade --convention milestone-prefixed --apply  # 적용
```

---

## 상태 관리 명령어

### `state validate`

STATE.md와 실제 파일시스템 간의 드리프트를 감지합니다.

**전제 조건:** `.planning/STATE.md` 존재
**생성 결과:** STATE.md 필드와 파일시스템 현실 간의 드리프트를 보여주는 검증 보고서

```bash
node gsd-tools.cjs state validate
```

---

### `state sync [--verify]`

디스크의 실제 프로젝트 상태에서 STATE.md를 재구성합니다.

| 플래그 | 설명 |
|------|-------------|
| `--verify` | 드라이런 모드 — 작성 없이 제안된 변경사항 표시 |

**전제 조건:** `.planning/` 디렉토리 존재
**생성 결과:** 파일시스템 현실을 반영한 업데이트된 `STATE.md`

```bash
node gsd-tools.cjs state sync             # 디스크에서 STATE.md 재구성
node gsd-tools.cjs state sync --verify    # 드라이런: 작성 없이 변경사항 표시
```

---

### `state planned-phase`

plan-phase 완료 후 상태 전환을 기록합니다 (계획됨/실행 준비).

| 플래그 | 설명 |
|------|-------------|
| `--phase N` | 계획된 단계 번호 |
| `--plans N` | 생성된 계획 수 |

**전제 조건:** 단계가 계획됨
**생성 결과:** 계획 후 상태가 포함된 업데이트된 `STATE.md`

```bash
node gsd-tools.cjs state planned-phase --phase 3 --plans 2
```

---

## 커뮤니티 명령어

### 커뮤니티 훅

`.planning/config.json`에서 `hooks.community: true`로 게이팅된 선택적 git 및 세션 훅. 명시적으로 활성화하지 않으면 모두 무작동(no-op)입니다.

| 훅 | 목적 |
|------|---------|
| `gsd-validate-commit.sh` | git 커밋 메시지에 Conventional Commits 형식 강제 |
| `gsd-session-state.sh` | 세션 상태 전환 추적 |
| `gsd-phase-boundary.sh` | 단계 경계 확인 강제 |

다음으로 활성화:
```json
{ "hooks": { "community": true } }
```

---

### 커뮤니티 초대

GSD Discord 커뮤니티에 참여하려면 GSD README의 링크를 방문하거나 `/gsd-help`를 실행하고 거기에 표시된 Discord 링크를 따르세요.

---

## 기여: 스킬 설명 표준

스킬 설명(`commands/gsd/*.md` 프론트매터의 `description:` 필드)은
모든 세션의 시스템 프롬프트에 삽입됩니다. 세션당 오버헤드를 낮게 유지하기 위해 설명은
≤ 100자이어야 하며 `argument-hint:`에 이미 있는 플래그 문서를 중복해서는 안 됩니다.

린트 게이트가 예산을 강제합니다:

```bash
npm run lint:descriptions
```

이 검사는 `tests/skill-frontmatter-contract.test.cjs`를 통해 `npm test`의 일부로도 실행됩니다.

---

## 관련 항목

- [설정 참조](CONFIGURATION.md)
- [CLI 도구 참조](CLI-TOOLS.md)
- [기능 참조](FEATURES.md)
- [문서 목록](README.md)
