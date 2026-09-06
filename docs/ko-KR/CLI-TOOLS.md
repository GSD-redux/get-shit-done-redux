# GSD CLI 도구 참조

> `gsd-tools` CLI(`gsd-core/bin/gsd-tools.cjs`)에 대한 참조입니다. 슬래시 명령 및 사용자 흐름은 [명령 참조](COMMANDS.md)를 확인하세요. [문서 인덱스](README.md)로 돌아가기.

---

## 개요

`gsd-tools.cjs`는 GSD 명령, 워크플로우, 에이전트 전반에 걸쳐 설정 파싱, 모델 해석, 단계 조회, git 커밋, 요약 검증, 상태 관리, 템플릿 작업을 중앙에서 처리합니다.


|                    |                                                                                                                                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **배포 경로**   | `gsd-core/bin/gsd-tools.cjs`                                                                                                                                                                      |
| **구현**        | `gsd-core/bin/lib/` 아래 20개의 도메인 모듈 (해당 디렉토리가 기준)                                                                                                                                 |
| **상태**         | 오케스트레이션, 워크플로우, 자동화를 위한 주요 런타임 명령 인터페이스. |


**사용법 (CJS):**

```bash
node gsd-tools.cjs <command> [args] [--raw] [--cwd <path>]
```

**전역 플래그 (CJS):**


| 플래그           | 설명                                                                  |
| -------------- | ---------------------------------------------------------------------------- |
| `--raw`        | 기계 판독 가능한 출력 (JSON 또는 일반 텍스트, 서식 없음)                  |
| `--cwd <path>` | 작업 디렉토리 재정의 (샌드박스된 서브에이전트용)                         |
| `--ws <name>`  | `.planning/workstreams/<name>` 경로에 대한 워크스트림 컨텍스트 |


---

## 상태 명령

`.planning/STATE.md` — 프로젝트의 살아있는 메모리를 관리합니다.

```bash
# 전체 프로젝트 설정 + 상태를 JSON으로 불러오기
node gsd-tools.cjs state load

# STATE.md 프론트매터를 JSON으로 출력
node gsd-tools.cjs state json

# 단일 필드 업데이트
node gsd-tools.cjs state update <field> <value>

# STATE.md 내용 또는 특정 섹션 가져오기
node gsd-tools.cjs state get [section]

# 여러 필드 일괄 업데이트
node gsd-tools.cjs state patch --field1 val1 --field2 val2

# 계획 카운터 증가
node gsd-tools.cjs state advance-plan

# 실행 메트릭 기록
node gsd-tools.cjs state record-metric --phase N --plan M --duration Xmin [--tasks N] [--files N]

# 진행률 바 재계산
node gsd-tools.cjs state update-progress

# 결정 사항 추가
node gsd-tools.cjs state add-decision --summary "..." [--phase N] [--rationale "..."]
# 또는 파일에서:
node gsd-tools.cjs state add-decision --summary-file path [--rationale-file path]

# 차단 항목 추가/해제
node gsd-tools.cjs state add-blocker --text "..."
node gsd-tools.cjs state resolve-blocker --text "..."

# 세션 연속성 기록
node gsd-tools.cjs state record-session --stopped-at "..." [--resume-file path]

# 단계 시작 — 새로운 단계의 STATE.md 상태/최근 활동 업데이트
node gsd-tools.cjs state begin-phase --phase N --name SLUG --plans COUNT

# 에이전트 발견 가능한 차단 신호 (discuss-phase / UI 흐름에서 사용)
node gsd-tools.cjs state signal-waiting --type TYPE --question "..." --options "A|B" --phase P
node gsd-tools.cjs state signal-resume
```

### 상태 스냅샷

전체 STATE.md의 구조화된 파싱:

```bash
node gsd-tools.cjs state-snapshot
```

반환 JSON 포함 항목: 현재 위치, 단계, 계획, 상태, 결정 사항, 차단 항목, 메트릭, 최근 활동.

---

## 단계 명령

단계 — 디렉토리, 번호 지정, 로드맵 동기화를 관리합니다.

```bash
# 번호로 단계 디렉토리 찾기
node gsd-tools.cjs find-phase <phase>

# 삽입을 위한 다음 소수점 단계 번호 계산
node gsd-tools.cjs phase next-decimal <phase>

# 로드맵에 새 단계 추가 + 디렉토리 생성
node gsd-tools.cjs phase add <description>

# 기존 단계 뒤에 소수점 단계 삽입
node gsd-tools.cjs phase insert <after> <description>

# 단계 제거, 이후 번호 재지정
node gsd-tools.cjs phase remove <phase> [--force]

# 단계 완료 표시, 상태 + 로드맵 업데이트
node gsd-tools.cjs phase complete <phase>

# 웨이브 및 상태와 함께 계획 인덱싱
node gsd-tools.cjs phase-plan-index <phase>

# 필터링으로 단계 목록 표시
node gsd-tools.cjs phases list [--type planned|executed|all] [--phase N] [--include-archived]
```

---

## 로드맵 명령

`ROADMAP.md` 파싱 및 업데이트.

```bash
# ROADMAP.md에서 단계 섹션 추출
node gsd-tools.cjs roadmap get-phase <phase>

# 디스크 상태를 포함한 전체 로드맵 파싱
node gsd-tools.cjs roadmap analyze

# 디스크에서 진행 테이블 행 업데이트
node gsd-tools.cjs roadmap update-plan-progress <N>
```

---

## 설정 명령

`.planning/config.json` 읽기 및 쓰기.

```bash
# 기본값으로 config.json 초기화
node gsd-tools.cjs config-ensure-section

# 설정 값 지정 (점 표기법)
node gsd-tools.cjs config-set <key> <value>

# 설정 값 가져오기
node gsd-tools.cjs config-get <key>

# 모델 프로파일 설정
node gsd-tools.cjs config-set-model-profile <profile>
```

---

## 모델 해석

```bash
# 현재 프로파일 기반으로 에이전트에 대한 모델 가져오기
node gsd-tools.cjs resolve-model <agent-name>
# 원시 출력은 선택된 모델 ID/티어를 반환합니다.
# JSON 출력은 프로파일도 포함하며, 활성 런타임이 지원하는 경우
# reasoning_effort도 포함합니다.
```

에이전트 이름: `gsd-planner`, `gsd-executor`, `gsd-phase-researcher`, `gsd-project-researcher`, `gsd-research-synthesizer`, `gsd-verifier`, `gsd-plan-checker`, `gsd-integration-checker`, `gsd-roadmapper`, `gsd-debugger`, `gsd-codebase-mapper`, `gsd-nyquist-auditor`

---

## 검증 명령

계획, 단계, 참조, 커밋을 검증합니다.

```bash
# SUMMARY.md 파일 검증
node gsd-tools.cjs verify-summary <path> [--check-count N]

# PLAN.md 구조 + 태스크 확인
node gsd-tools.cjs verify plan-structure <file>

# 모든 계획에 요약이 있는지 확인
node gsd-tools.cjs verify phase-completeness <phase>

# @-참조 + 경로 확인
node gsd-tools.cjs verify references <file>

# 커밋 해시 일괄 검증
node gsd-tools.cjs verify commits <hash1> [hash2] ...

# must_haves.artifacts 확인
node gsd-tools.cjs verify artifacts <plan-file>

# must_haves.key_links 확인
node gsd-tools.cjs verify key-links <plan-file>
```

---

## 유효성 검사 명령

프로젝트 무결성 확인.

```bash
# 단계 번호 지정, 디스크/로드맵 동기화 확인
node gsd-tools.cjs validate consistency

# .planning/ 무결성 확인, 선택적 복구
node gsd-tools.cjs validate health [--repair]

# 상태 표시줄 / 훅 호출자를 위한 컨텍스트 창 사용률 조회 (v1.40.0)
node gsd-tools.cjs validate context

# 타입이 지정된 JSON 인터페이스로서의 컨텍스트 사용률 (#455)
node gsd-tools.cjs validate context --json
```

`validate context`는 `utilization`, `status`(60% / 70% 임계값에서 `ok` / `warn` / `critical`), `suggestion` 문자열을 포함한 구조화된 봉투를 출력합니다. 동일한 데이터가 `/gsd-health --context`를 지원합니다.
스크립트 및 테스트 어서션에서 타입이 지정된 IR을 직접 수신하려면 `--json`을 전달하세요.

---

## 템플릿 명령

템플릿 선택 및 채우기.

```bash
# 세분성에 따라 요약 템플릿 선택
node gsd-tools.cjs template select <type>

# 변수로 템플릿 채우기
node gsd-tools.cjs template fill <type> --phase N [--plan M] [--name "..."] [--type execute|tdd] [--wave N] [--fields '{json}']
```

`fill`에 대한 템플릿 유형: `summary`, `plan`, `verification`

---

## 프론트매터 명령

Markdown 파일에 대한 YAML 프론트매터 CRUD 작업.

```bash
# 프론트매터를 JSON으로 추출
node gsd-tools.cjs frontmatter get <file> [--field key]

# 단일 필드 업데이트
node gsd-tools.cjs frontmatter set <file> --field key --value jsonVal

# JSON을 프론트매터에 병합
node gsd-tools.cjs frontmatter merge <file> --data '{json}'

# 필수 필드 검증
node gsd-tools.cjs frontmatter validate <file> --schema plan|summary|verification
```

---

## 스캐폴드 명령

미리 구조화된 파일 및 디렉토리 생성.

```bash
# CONTEXT.md 템플릿 생성
node gsd-tools.cjs scaffold context --phase N

# UAT.md 템플릿 생성
node gsd-tools.cjs scaffold uat --phase N

# VERIFICATION.md 템플릿 생성
node gsd-tools.cjs scaffold verification --phase N

# 단계 디렉토리 생성
node gsd-tools.cjs scaffold phase-dir --phase N --name "phase name"
```

---

## Init 명령 (복합 컨텍스트 로딩)

하나의 호출로 특정 워크플로우에 필요한 모든 컨텍스트를 로드합니다. 프로젝트 정보, 설정, 상태, 워크플로우별 데이터가 포함된 JSON을 반환합니다. `init onboard [--fast] [--text]`는 `/gsd-onboard`를 위해 brownfield 신호, 계획 문서 후보, 코드베이스 맵 완성도, fast 맵 준비 상태, 텍스트 모드 라우팅, 부분 planning 상태, 온보딩 요약 상태를 반환합니다.

```bash
node gsd-tools.cjs init execute-phase <phase>
node gsd-tools.cjs init plan-phase <phase>
node gsd-tools.cjs init new-project
node gsd-tools.cjs init new-milestone
node gsd-tools.cjs init onboard [--fast] [--text]
node gsd-tools.cjs init quick <description>
node gsd-tools.cjs init resume
node gsd-tools.cjs init verify-work <phase>
node gsd-tools.cjs init phase-op <phase>
node gsd-tools.cjs init todos [area]
node gsd-tools.cjs init milestone-op
node gsd-tools.cjs init map-codebase
node gsd-tools.cjs init progress

# 워크스트림 범위 init (`--ws` 플래그)
node gsd-tools.cjs init execute-phase <phase> --ws <name>
node gsd-tools.cjs init plan-phase <phase> --ws <name>
```

**대용량 페이로드 처리:** 출력이 ~50KB를 초과하면 CLI가 임시 파일에 쓰고 `@file:/tmp/gsd-init-XXXXX.json`을 반환합니다. 워크플로우는 `@file:` 접두사를 확인하고 디스크에서 읽습니다:

```bash
INIT=$(node gsd-tools.cjs init execute-phase "1")
if [[ "$INIT" == @file:* ]]; then INIT=$(cat "${INIT#@file:}"); fi
```

---

## 마일스톤 명령

```bash
# 마일스톤 아카이브
node gsd-tools.cjs milestone complete <version> (--confirm | --dry-run) [--name <name>] [--no-archive-phases] [--force] [--archive-quick]

# 요구사항을 완료로 표시
node gsd-tools.cjs requirements mark-complete <ids>
# 허용 형식: REQ-01,REQ-02 또는 REQ-01 REQ-02 또는 [REQ-01, REQ-02]
```

---

## 에이전트 스킬

지정된 에이전트 유형에 대한 스킬 블록을 출력합니다.

```bash
# 원시 XML 스킬 블록 출력 (기본값 — 셸 확장에 안전)
node gsd-tools.cjs agent-skills <agent-type>

# 타입이 지정된 JSON 인터페이스 출력 (#455) — { agent_type, block, skills_count }
node gsd-tools.cjs agent-skills <agent-type> --json
```

`--json` 플래그는 구조화된 소비 및 테스트 어서션에 적합한 타입이 지정된 IR 객체를 반환하며, 기본값(플래그 없음)은 워크플로우 셸 확장이 의존하는 원시 XML 출력을 보존합니다.

---

## 스킬 매니페스트

더 빠른 명령 로딩을 위한 스킬 검색 사전 계산 및 캐싱.

```bash
# 스킬 매니페스트 생성 (.claude/skill-manifest.json에 기록)
node gsd-tools.cjs skill-manifest

# 사용자 정의 출력 경로로 생성
node gsd-tools.cjs skill-manifest --output <path>
```

사용 가능한 모든 GSD 스킬과 해당 메타데이터(이름, 설명, 파일 경로, 인수 힌트)의 JSON 매핑을 반환합니다. 반복적인 파일시스템 스캔을 방지하기 위해 설치 프로그램과 세션 시작 훅에서 사용됩니다.

---

## 유틸리티 명령

```bash
# 텍스트를 URL 안전 슬러그로 변환
node gsd-tools.cjs generate-slug "Some Text Here"
# → some-text-here

# 타임스탬프 가져오기
node gsd-tools.cjs current-timestamp [full|date|filename]

# 보류 중인 할 일 카운트 및 목록
node gsd-tools.cjs list-todos [area]

# 파일/디렉토리 존재 여부 확인
node gsd-tools.cjs verify-path-exists <path>

# 모든 SUMMARY.md 데이터 집계
node gsd-tools.cjs history-digest

# SUMMARY.md에서 구조화된 데이터 추출
node gsd-tools.cjs summary-extract <path> [--fields field1,field2]

# 프로젝트 통계
node gsd-tools.cjs stats [json|table]

# 진행률 렌더링 (사람이 읽을 수 있는 형태)
node gsd-tools.cjs progress [json|table|bar]

# 타입이 지정된 JSON 인터페이스로서의 진행률 (#455)
node gsd-tools.cjs progress --json

# 할 일 완료
node gsd-tools.cjs todo complete <filename> [--dry-run]

# UAT 감사 — 모든 단계에서 미해결 항목 스캔
node gsd-tools.cjs audit-uat

# 교차 아티팩트 감사 큐 — `.planning/`에서 미해결 감사 항목 스캔
node gsd-tools.cjs audit-open [--json]

# GSD-2 프로젝트를 현재 구조로 역 마이그레이션 (`/gsd-import --from-gsd2` 지원)
node gsd-tools.cjs from-gsd2 [--path <dir>] [--force] [--dry-run]

# 설정 확인과 함께 git 커밋
node gsd-tools.cjs commit <message> [--files f1 f2] [--amend] [--no-verify] [--respect-staged]
```

> `--no-verify`: 사전 커밋 훅을 건너뜁니다. 병렬 실행기 에이전트가 웨이브 기반 실행 중에 빌드 잠금 충돌(예: Rust 프로젝트의 cargo lock 경쟁)을 방지하기 위해 사용합니다. 오케스트레이터는 각 웨이브 완료 후 훅을 한 번 실행합니다. 순차 실행 중에는 `--no-verify`를 사용하지 마세요 — 훅이 정상적으로 실행되도록 하세요.
> `--files <paths>` **스테이징 동작**: 기본적으로 `--files`는 커밋 전에 각 명명된 파일에 대해 `git add -- <path>`를 실행합니다. 이렇게 하면 `git add -p`를 통해 설정된 헝크별 스테이징이 덮어쓰여집니다. `--respect-staged`를 전달하면 `git add` 단계를 건너뛰고 요청된 경로 사양 내에서 이미 인덱스에 있는 것만 커밋합니다. 해당 범위 내에서 스테이징된 것이 없으면 명령은 오류 없이 `{ committed: false, reason: 'nothing staged' }`를 반환합니다. 커밋의 후행 `-- <paths>` 경로 사양은 두 모드 모두에서 적용되므로 `--files` 범위 외부에서 스테이징된 파일은 절대 포함되지 않습니다(#3061 불변식).

# 웹 검색 (Brave API 키 필요)
node gsd-tools.cjs websearch <query> [--limit N] [--freshness day|week|month]
```

---

## Graphify

`.planning/graphs/`에서 프로젝트 지식 그래프를 빌드, 쿼리, 검사합니다. `config.json`에서 `graphify.enabled: true`가 필요합니다([설정 참조](CONFIGURATION.md#graphify-settings) 참조).

```bash
# 지식 그래프 빌드 또는 재빌드
node gsd-tools.cjs graphify build

# 그래프에서 용어 검색
node gsd-tools.cjs graphify query <term>

# 그래프 신선도 및 통계 표시
node gsd-tools.cjs graphify status

# 마지막 빌드 이후 변경 사항 표시
node gsd-tools.cjs graphify diff

# 현재 그래프의 명명된 스냅샷 기록
node gsd-tools.cjs graphify snapshot [name]
```

사용자 대면 진입점: `/gsd-graphify` ([명령 참조](COMMANDS.md#gsd-graphify) 참조).

---

## 모듈 아키텍처

| 모듈 | 파일 | 내보내기 |
|--------|------|---------|
| Core | `lib/core.cjs` | `error()`, `output()`, `parseArgs()`, 공유 유틸리티, 호환성 재내보내기 |
| State | `lib/state.cjs` | 모든 `state` 서브명령, `state-snapshot` |
| Phase | `lib/phase.cjs` | 단계 CRUD, `find-phase`, `phase-plan-index`, `phases list` |
| Planning Workspace | `lib/planning-workspace.cjs` | 계획 시임: `planningDir`, `planningPaths`, 활성 워크스트림 라우팅, `.planning/.lock` |
| Roadmap | `lib/roadmap.cjs` | 로드맵 파싱, 단계 추출, 진행률 업데이트 |
| Config | `lib/config.cjs` | 설정 읽기/쓰기, 섹션 초기화 |
| Verify | `lib/verify.cjs` | 모든 검증 및 유효성 검사 명령 |
| Template | `lib/template.cjs` | 템플릿 선택 및 변수 채우기 |
| Frontmatter | `lib/frontmatter.cjs` | YAML 프론트매터 CRUD |
| Init | `lib/init.cjs` | 모든 워크플로우를 위한 복합 컨텍스트 로딩 |
| Milestone | `lib/milestone.cjs` | 마일스톤 아카이브, 요구사항 표시 |
| Commands | `lib/commands.cjs` | 기타: slug, timestamp, todos, scaffold, stats, websearch |
| Model Profiles | `lib/model-profiles.cjs` | 프로파일 해석 테이블 |
| UAT | `lib/uat.cjs` | 교차 단계 UAT/검증 감사 |
| Profile Output | `lib/profile-output.cjs` | 개발자 프로파일 서식 지정 |
| Profile Pipeline | `lib/profile-pipeline.cjs` | 세션 분석 파이프라인 |
| Graphify | `lib/graphify.cjs` | 지식 그래프 빌드/쿼리/상태/diff/스냅샷 (`/gsd-graphify` 지원) |
| Learnings | `lib/learnings.cjs` | 단계/SUMMARY 아티팩트에서 학습 내용 추출 (`/gsd-extract-learnings` 지원) |
| Audit | `lib/audit.cjs` | 단계/마일스톤 감사 큐 핸들러; `audit-open` 헬퍼 |
| GSD2 Import | `lib/gsd2-import.cjs` | GSD-2 프로젝트에서 역 마이그레이션 임포터 (`/gsd-import --from-gsd2` 지원) |
| Intel | `lib/intel.cjs` | 쿼리 가능한 코드베이스 인텔리전스 인덱스 (`/gsd-map-codebase --query` 지원) |

---

## 리뷰어 CLI 라우팅

`review.models.<cli>`는 리뷰어 유형을 코드 리뷰 워크플로우가 호출하는 셸 명령에 매핑합니다. [`/gsd-config --integrations`](COMMANDS.md#gsd-config)를 통해 또는 직접 설정:

```bash
node gsd-tools.cjs config-set review.models.codex    "codex exec --model gpt-5"
node gsd-tools.cjs config-set review.models.gemini   "gemini -m gemini-2.5-pro"
node gsd-tools.cjs config-set review.models.opencode "opencode run --model claude-sonnet-4"
node gsd-tools.cjs config-set review.models.claude   ""   # clear — fall back to session model
```

슬러그는 `[a-zA-Z0-9_-]+`에 대해 검증됩니다; 비어 있거나 경로를 포함하는 슬러그는 거부됩니다. 전체 필드 참조는 [`docs/CONFIGURATION.md`](CONFIGURATION.md#code-review-cli-routing)를 참조하세요.

## 시크릿 처리

`/gsd-settings`(`brave_search`, `firecrawl`, `exa_search`)를 통해 설정된 API 키는 `.planning/config.json`에 일반 텍스트로 기록되지만 모든 `config-set` / `config-get` 출력, 확인 테이블, 대화형 프롬프트에서 마스킹(`****<last-4>`)됩니다. 마스킹 구현은 `gsd-core/bin/lib/secrets.cjs`를 참조하세요. `config.json` 파일 자체가 보안 경계입니다 — 파일시스템 권한으로 보호하고 git에서 제외하세요(`.planning/`는 기본적으로 gitignore됩니다).

---

## 관련 문서

- [명령](COMMANDS.md)
- [설정](CONFIGURATION.md)
- [아키텍처](ARCHITECTURE.md)
- [문서 인덱스](README.md)
