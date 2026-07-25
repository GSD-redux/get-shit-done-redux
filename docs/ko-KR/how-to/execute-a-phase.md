# 페이즈를 실행하는 방법

**목표:** 기획된 페이즈를 웨이브 기반 병렬 실행으로 처리하고 각 계획을 원자적 git 커밋으로 완료합니다.

**전제 조건:** 페이즈에 최소 하나의 `PLAN.md` 파일이 있어야 합니다. 기획이 아직 완료되지 않았다면 먼저 `/gsd-plan-phase N`을 실행하세요 — [페이즈 기획](plan-a-phase.md)을 참고하세요.

---

## 전체 페이즈 실행

```bash
/gsd-execute-phase 1
```

GSD는 페이즈의 계획 파일을 읽고 의존성 웨이브로 그룹화한 후 계획당 새 실행자 에이전트를 실행합니다. 각 실행자는 다음 웨이브가 시작되기 전에 작업을 원자적으로 커밋합니다.

에이전트가 실행되기 전에 GSD는 웨이브 테이블을 출력합니다:

```
## Execution Plan

Phase 1: Core middleware — 3 plans across 2 wave(s)

| Wave | Plans          | What it builds            |
|------|----------------|---------------------------|
| 1    | 01-01, 01-02   | Core validation function  |
| 2    | 01-03          | Express middleware wrapper |
```

웨이브 1 계획은 병렬로 실행됩니다(각각 독립된 git 워크트리에서). 웨이브 2는 모든 웨이브 1 커밋이 병합될 때까지 기다립니다.

기본 에이전트 조정 모델에 대해서는 [멀티 에이전트 오케스트레이션](../explanation/multi-agent-orchestration.md)을 참고하세요.

---

## 단일 웨이브 실행

예를 들어 웨이브 2로 넘어가기 전 웨이브 1 출력을 검사하고 싶은 경우 `--wave N`을 사용하세요:

```bash
/gsd-execute-phase 1 --wave 2
```

GSD는 웨이브 2 계획만 실행합니다. 먼저 이전 웨이브가 완료되었는지 확인하며, 웨이브 1 계획이 아직 미완료인 경우 이전 웨이브를 먼저 완료하도록 알립니다.

---

## 중단된 실행 재개

실행이 도중에 중단된 경우(할당량 오류, 네트워크 끊김, 세션 충돌 등) 웨이브 레벨 진행 상황은 보존됩니다. GSD는 각 계획의 `SUMMARY.md` 파일을 확인합니다. 이미 파일이 있는 계획은 재실행 시 자동으로 건너뜁니다:

```bash
/gsd-execute-phase 1
```

GSD는 `SUMMARY.md`가 이미 존재하는 계획을 건너뛰고 첫 번째 미완료 계획에서 재개합니다.

**커밋은 존재하지만 `SUMMARY.md`가 없는 경우**(실행자가 커밋했지만 세션이 종료되기 전 요약을 작성하지 못한 경우), GSD는 안전 재개 게이트를 표시하고 세 가지 옵션을 제공합니다:

- `수동으로 마무리` — 커밋을 검사하고 `SUMMARY.md`를 작성한 후 재실행
- `처음부터 재실행` — 부분 커밋을 되돌리거나 대체한 후 새 실행자 실행
- `표시하고 건너뛰기` — 명시적 확인 하에 이상을 기록하고 진행

체계적인 실패 진단에 대해서는 [실패한 실행 디버그](debug-a-failed-execution.md)를 참고하세요.

---

## 출력 위치

모든 웨이브가 완료되면 페이즈 디렉터리에 다음이 포함됩니다:

```
.planning/phases/01-<name>/
  01-01-SUMMARY.md    # 계획 01이 구축한 것, 핵심 파일, 편차
  01-02-SUMMARY.md
  01-03-SUMMARY.md
  VERIFICATION.md     # 요구 사항별 통과/실패 상태
```

`STATE.md`와 `ROADMAP.md`는 모든 웨이브가 완료되면 자동으로 업데이트됩니다. `VERIFICATION.md`는 페이즈가 완전히 완료된 경우에만 작성됩니다.

Git 히스토리에는 각 실행자의 태스크당 커밋 하나와 오케스트레이터의 추적 커밋이 표시됩니다.

---

## 크로스 AI 실행

`workflow.cross_ai_command`에 설정된 외부 AI CLI(Codex, Gemini 등)에 실행을 위임하려면:

```bash
/gsd-execute-phase 2 --cross-ai
```

설정에 크로스 AI가 활성화된 경우에도 로컬 실행을 강제하려면:

```bash
/gsd-execute-phase 2 --no-cross-ai
```

---

## 관련 문서

- [페이즈 기획](plan-a-phase.md)
- [검증 및 배포](verify-and-ship.md)
- [실패한 실행 디버그](debug-a-failed-execution.md)
- [명령어 참조](../COMMANDS.md)
