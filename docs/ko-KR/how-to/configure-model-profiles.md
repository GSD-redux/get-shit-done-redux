# 모델 프로파일을 설정하는 방법

프로젝트에 적합한 모델 티어 전략을 선택한 다음, 대규모 재정의 블록을 작성하지 않고 개별 에이전트나 전체 페이즈 유형을 조정하세요. 이 가이드는 가장 간단한 방법부터 시작하여 동적 라우팅까지 다룹니다.

---

## 네 가지 프로파일 (`adaptive`와 `inherit` 포함)

`.planning/config.json`에서 `model_profile`을 설정하거나 `/gsd-config --profile <name>`을 사용하세요:

| 프로파일 | 플래너 | 실행자 | 리서처 | 검증자 | 사용 시기 |
|---------|---------|----------|-------------|----------|----------|
| `quality` | Opus | Opus | Opus | Sonnet | 비용보다 품질이 중요한 프로덕션 작업 |
| `balanced` | Opus | Sonnet | Sonnet | Sonnet | 일반 개발 — 기본값 |
| `budget` | Sonnet | Sonnet | Haiku | Haiku | 빠른 프로토타이핑, 비용 민감 환경 |
| `adaptive` | Opus | Sonnet | Sonnet | Sonnet | 런타임 간 자주 전환할 때 사용; 다른 티어와 동일하게 런타임 인식 프로파일로 해결됨 |
| `inherit` | (세션 모델) | (세션 모델) | (세션 모델) | (세션 모델) | 비 Anthropic 프로바이더(OpenRouter, 로컬 모델) — 모든 에이전트가 현재 세션 모델을 따름 |

위 테이블은 대표적인 하위 집합을 보여줍니다. 출시된 33개 에이전트 모두 `gsd-core/bin/shared/model-catalog.json`에 명시적인 프로파일별 티어 할당이 있습니다. 전체 테이블은 설정 참조의 [모델 프로파일](../CONFIGURATION.md#model-profiles)을 참고하세요.

**명령으로 빠르게 전환:**

```bash
/gsd-config --profile balanced   # 일반 개발
/gsd-config --profile budget     # 프로토타이핑 또는 고비용 페이즈
/gsd-config --profile quality    # 프로덕션 릴리스
/gsd-config --profile inherit    # OpenRouter, 로컬 모델
```

**또는 `.planning/config.json` 직접 편집:**

```json
{
  "model_profile": "balanced"
}
```

---

## 에이전트별 재정의 (`model_overrides`)

전체 프로파일을 변경하지 않고 단일 에이전트에 다른 티어가 필요한 경우 `model_overrides`를 사용하세요:

```json
{
  "model_profile": "balanced",
  "model_overrides": {
    "gsd-executor": "opus",
    "gsd-codebase-mapper": "haiku"
  }
}
```

유효한 값: `opus`, `sonnet`, `haiku`, `inherit`, 또는 완전히 정규화된 모델 ID (예: `"openai/o3"`, `"google/gemini-2.5-pro"`).

`model_overrides`는 `.planning/config.json`에서 프로젝트별로 설정하거나 `~/.gsd/defaults.json`에서 전역으로 설정할 수 있습니다. 충돌 시 프로젝트별 항목이 우선하며, 충돌하지 않는 전역 항목은 보존됩니다.

**Codex와 OpenCode의 중요 사항:** 이러한 런타임은 설치 시 해결된 모델을 각 에이전트의 정적 설정에 임베드합니다. `model_overrides` 편집 후 변경 사항이 적용되도록 인스톨러를 다시 실행하세요:

```bash
npx @opengsd/gsd-core@latest --codex --global   # 또는 --opencode, --kilo 등
```

---

## 페이즈 유형별 모델 (`models`)

33개 에이전트 이름을 모두 알지 않고도 "기획에는 Opus, 나머지는 Sonnet"을 설정하려면 `models` 블록을 사용하세요. 여섯 가지 페이즈 유형을 티어 별칭으로 매핑합니다:

```json
{
  "model_profile": "balanced",
  "models": {
    "planning":      "opus",
    "discuss":       "opus",
    "research":      "sonnet",
    "execution":     "opus",
    "verification":  "sonnet",
    "completion":    "sonnet"
  }
}
```

페이즈 유형과 해당 에이전트:

| 페이즈 유형 | 포함된 에이전트 |
|---|---|
| `planning` | `gsd-planner`, `gsd-roadmapper`, `gsd-pattern-mapper` |
| `research` | `gsd-phase-researcher`, `gsd-project-researcher`, `gsd-research-synthesizer`, `gsd-codebase-mapper`, `gsd-ui-researcher` |
| `execution` | `gsd-executor`, `gsd-debugger`, `gsd-doc-writer` |
| `verification` | `gsd-verifier`, `gsd-plan-checker`, `gsd-integration-checker`, `gsd-nyquist-auditor`, `gsd-ui-checker`, `gsd-ui-auditor`, `gsd-doc-verifier`, `gsd-code-reviewer` |
| `discuss` | `gsd-assumptions-analyzer` |
| `completion` | 예약됨 — 현재 서브에이전트 없음; 향후 호환성을 위해 스키마에서 허용 |

`models` 블록은 티어 별칭만 허용합니다(`opus`, `sonnet`, `haiku`, `inherit`). 완전히 정규화된 모델 ID는 에이전트별 `model_overrides`를 사용하세요.

**`models`와 에이전트별 예외 조합:**

```json
{
  "model_profile": "balanced",
  "models": {
    "research": "sonnet"
  },
  "model_overrides": {
    "gsd-codebase-mapper": "haiku"
  }
}
```

5개의 리서치 에이전트 모두 `sonnet`으로 해결되지만, `gsd-codebase-mapper`는 `haiku`로 고정됩니다.

---

## 동적 라우팅 — 기본 저렴하게, 실패 시 에스컬레이션

기본적으로 저렴한 티어를 사용하고 에이전트가 품질 게이트에 실패할 때만 에스컬레이션하려면 `dynamic_routing`을 활성화하세요:

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

각 에이전트에는 기본 티어(`light`, `standard`, `heavy`)가 있습니다. 첫 번째 시도에서 GSD는 `tier_models[default_tier]`를 선택합니다. 오케스트레이터가 소프트 실패(검증 불확실, 플랜 체크 플래그 등)를 감지하면 한 티어 위로 에이전트를 재실행합니다. `max_escalations`는 총 재시도 횟수를 제한합니다.

이미 `heavy`에 있는 에이전트는 더 이상 에스컬레이션할 수 없습니다.

**동적 해결을 유지하면서 에스컬레이션 끄기:**

```json
{
  "dynamic_routing": {
    "enabled": true,
    "escalate_on_failure": false
  }
}
```

결과에 관계없이 모든 시도는 `tier_models[default_tier]`를 사용합니다. 에스컬레이션 동작 없이 명시적 티어-모델 매핑을 원할 때 유용합니다.

`dynamic_routing`은 **기본적으로 비활성화**됩니다. 블록을 생략하거나 `enabled: false`로 설정하면 정적 해결이 유지됩니다.

---

## 비 Anthropic 런타임에서 GSD 사용

Codex, OpenCode, Gemini CLI, 또는 Kilo용으로 GSD를 설치한 경우 인스톨러가 이미 설정에 `resolve_model_ids: "omit"`을 설정했습니다. 이는 GSD가 Anthropic 모델 ID 해결을 건너뛰고 런타임이 자체 기본 모델을 선택하도록 합니다. 기본 사용 시 수동 설정이 필요 없습니다.

**Codex에서 티어별 모델을 원하는 경우:**

```json
{
  "runtime": "codex",
  "model_profile": "balanced"
}
```

GSD는 각 티어 별칭을 런타임 티어 맵에 정의된 Codex 네이티브 모델 및 추론 노력으로 해결합니다.

**비 Claude 런타임에서 에이전트별 모델 ID를 원하는 경우:**

```json
{
  "resolve_model_ids": "omit",
  "model_overrides": {
    "gsd-planner":   "o3",
    "gsd-executor":  "o4-mini",
    "gsd-debugger":  "o3"
  }
}
```

전체 런타임 인식 프로파일 참조 및 `model_policy` 표면(v1.42에 추가된 프로바이더 중립 프리셋)에 대해서는 [설정 참조 — 모델 프로파일](../CONFIGURATION.md#model-profiles)을 참고하세요.

---

## 해결 우선순위 (높은 것에서 낮은 것 순)

여러 레이어가 적용될 때 해결자는 가장 높은 우선순위 항목을 선택합니다:

```text
1. model_overrides[<agent>]           — 에이전트별; 전체 ID; 타겟 예외
2. dynamic_routing.tier_models[<tier>] — 활성화 시; 소프트 실패 시 에스컬레이션
3. models[<phase_type>]               — 거친 페이즈 레벨 티어
4. model_profile (에이전트별 열)      — 전역 티어 전략
5. 런타임 기본값                      — 다른 것이 적용되지 않을 때
```

---

## 올바른 방법 선택

| 원하는 것 | 사용할 것 |
|---|---|
| 모든 에이전트에 단일 티어 전략 | `model_profile` |
| 거친 페이즈 레벨 조정 ("기획에 Opus") | `models.<phase_type>` |
| 에이전트별 정밀도 ("코드베이스 매퍼에 Haiku 강제") | `model_overrides[<agent>]` |
| 특정 에이전트에 완전히 정규화된 모델 ID | `model_overrides[<agent>]: "openai/gpt-5"` |
| 기본적으로 저렴하게, 실패 시만 에스컬레이션 | `dynamic_routing` |
| 모든 에이전트가 세션 모델을 따름 (비 Anthropic 프로바이더) | `model_profile: "inherit"` |

---

## 관련 문서

- [설정 참조](../CONFIGURATION.md)
- [멀티 에이전트 오케스트레이션](../explanation/multi-agent-orchestration.md)
- [명령어 참조](../COMMANDS.md)
- [문서 목차](../README.md)
