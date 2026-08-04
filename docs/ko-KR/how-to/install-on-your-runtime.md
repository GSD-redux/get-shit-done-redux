# GSD Core를 런타임에 설치하는 방법

GSD Core(`@opengsd/gsd-core`)를 매일 사용하는 AI 코딩 런타임에 설치합니다. 이 가이드는 지원되는 각 런타임의 표준 설치 경로를 안내하고, Node.js가 없는 환경에서의 수동 설치 방법도 다룹니다.

**필요 사항:** Node.js 18 이상 및 npm(또는 npx). Node.js가 없는 경우 [Node.js 없이 설치하기](#nodejs-없이-설치하기)로 이동하세요.

---

## 인스톨러가 필요한 이유

GSD Core는 Claude Code의 네이티브 frontmatter 형식으로 에이전트 및 명령 파일을 제공합니다. 각 지원 런타임은 서로 다른 스키마, 디렉터리 구조, 명령 호출 문법을 요구합니다. 인스톨러는 필요한 변환을 수행합니다. 예를 들어 OpenCode용 도구 목록 및 색상 값 변환, Codex용 TOML 에이전트 항목 작성, Gemini CLI용 모든 명령 본문을 하이픈 형식(`/gsd-update`)에서 콜론 형식(`/gsd-update`)으로 재작성합니다.

**`agents/` 또는 `commands/`에서 파일을 직접 복사하지 마세요.** 그렇게 하면 변환을 우회하게 되어 스키마 유효성 검사 오류나 누락된 명령이 발생합니다.

---

## 표준 설치

임의의 디렉터리에서 인스톨러를 실행합니다. 런타임과 전역 설치(모든 프로젝트) 또는 로컬 설치(이 프로젝트만) 여부를 묻습니다.

```bash
npx @opengsd/gsd-core@latest
```

신규 설치 또는 런타임 전환 후 인스톨러를 재실행할 때 필요한 명령은 이것뿐입니다.

---

## 런타임별 설치 방법

### Claude Code

```bash
npx @opengsd/gsd-core@latest --claude --global
```

스킬은 `~/.claude/`에 저장됩니다. 다음 Claude Code 세션에서 `/gsd-*` 슬래시 명령으로 명령이 나타납니다. Claude Code를 재시작하여 적용하세요.

**설치 디렉터리 재정의:**

```bash
CLAUDE_CONFIG_DIR=~/.claude-alt npx @opengsd/gsd-core@latest --claude --global
```

---

### Gemini CLI

```bash
npx @opengsd/gsd-core@latest --gemini --global
```

스킬은 `~/.gemini/`에 저장됩니다. 인스톨러는 모든 명령 본문을 Gemini의 콜론 네임스페이스(`/gsd-update`, `/gsd-config` 등)로 재작성합니다. 설치 후 Gemini CLI를 재시작하세요.

**설치 디렉터리 재정의:**

```bash
GEMINI_CONFIG_DIR=~/.gemini-alt npx @opengsd/gsd-core@latest --gemini --global
```

---

### OpenCode

```bash
npx @opengsd/gsd-core@latest --opencode --global
```

스킬은 `~/.config/opencode/`(XDG) 또는 `~/.opencode/`에 저장됩니다. 인스톨러는 에이전트 frontmatter를 OpenCode 스키마로 변환합니다(`tools:` 필드 제거, 색상 값을 hex로 변환). 변경 내용을 이해하려면 [Node.js 없이 설치하기 — OpenCode 변환](#opencode--필수-변환)을 참고하세요.

**설치 디렉터리 재정의:**

```bash
OPENCODE_CONFIG_DIR=~/.config/opencode-alt npx @opengsd/gsd-core@latest --opencode --global
```

---

### Kilo

```bash
npx @opengsd/gsd-core@latest --kilo --global
```

스킬은 `~/.config/kilo/`(XDG) 또는 `~/.kilo/`에 저장됩니다. OpenCode 스타일의 플랫 마크다운 명령 형식을 사용합니다.

**설치 디렉터리 재정의:**

```bash
KILO_CONFIG_DIR=~/.config/kilo-alt npx @opengsd/gsd-core@latest --kilo --global
```

---

### Codex

```bash
npx @opengsd/gsd-core@latest --codex --global
```

스킬은 `~/.codex/skills/gsd-*/SKILL.md`에 저장됩니다. 에이전트는 `config.toml`에 에이전트별 TOML 항목으로 작성됩니다. 설치 후 Codex를 재시작하거나 `codex --reload`를 실행하세요.

**최소 지원 버전:** Codex CLI 0.130.0. 이전 버전은 추가 스킬 루트 스캔으로 중복 목록이 발생할 수 있습니다.

---

### GitHub Copilot

```bash
npx @opengsd/gsd-core@latest --copilot --global
```

스킬은 `~/.copilot/`에 저장됩니다. GSD는 에이전트 `.md` 파일 및 저장소 지시 파일로 설치됩니다.

**설치 디렉터리 재정의:**

```bash
COPILOT_CONFIG_DIR=~/.copilot-alt npx @opengsd/gsd-core@latest --copilot --global
```

---

### Cursor

```bash
npx @opengsd/gsd-core@latest --cursor --global
```

스킬은 `~/.cursor/`에 저장됩니다. GSD는 스킬, 에이전트, 규칙 참조를 설치합니다.

**설치 디렉터리 재정의:**

```bash
CURSOR_CONFIG_DIR=~/.cursor-alt npx @opengsd/gsd-core@latest --cursor --global
```

---

### Windsurf

```bash
npx @opengsd/gsd-core@latest --windsurf --global
```

스킬은 `~/.codeium/windsurf/`에 저장됩니다. GSD는 스킬, 에이전트, 워크스페이스 규칙을 설치합니다.

**설치 디렉터리 재정의:**

```bash
WINDSURF_CONFIG_DIR=~/.codeium/windsurf-alt npx @opengsd/gsd-core@latest --windsurf --global
```

---

### Cline

Cline은 규칙 기반 통합을 사용합니다. GSD는 슬래시 명령이 아닌 `.clinerules`로 설치됩니다.

```bash
# 전역 설치 (모든 프로젝트)
npx @opengsd/gsd-core@latest --cline --global

# 로컬 설치 (이 프로젝트만)
npx @opengsd/gsd-core@latest --cline --local
```

전역 설치는 `~/.cline/`에 저장됩니다. 로컬 설치는 `./.cline/`에 저장됩니다. 규칙은 Cline에 의해 자동으로 로드되며 커스텀 슬래시 명령은 등록되지 않습니다.

---

### CodeBuddy

```bash
npx @opengsd/gsd-core@latest --codebuddy --global
```

스킬은 `~/.codebuddy/skills/gsd-*/SKILL.md`에 저장됩니다.

---

### Qwen Code

Qwen Code는 Claude Code 2.1.88+와 동일한 오픈 스킬 표준을 사용합니다.

```bash
npx @opengsd/gsd-core@latest --qwen --global
```

스킬은 `~/.qwen/skills/gsd-*/SKILL.md`에 저장됩니다.

**설치 디렉터리 재정의:**

```bash
QWEN_CONFIG_DIR=~/.qwen-alt npx @opengsd/gsd-core@latest --qwen --global
```

---

### Augment Code

```bash
npx @opengsd/gsd-core@latest --augment --global
```

스킬은 `~/.augment/`에 저장됩니다. GSD는 스킬과 에이전트를 설치합니다. 훅 또는 상태 표시줄 소유권은 없습니다.

---

### Antigravity

```bash
npx @opengsd/gsd-core@latest --antigravity --global
```

인스톨러는 Antigravity 설정 디렉터리(`~/.gemini/antigravity`, `~/.gemini/antigravity-ide`, 또는 `~/.gemini/antigravity-cli`)를 자동으로 감지합니다. Gemini 호환 설정 정책을 사용합니다.

**설치 디렉터리 재정의:**

```bash
ANTIGRAVITY_CONFIG_DIR=~/.gemini/antigravity-alt npx @opengsd/gsd-core@latest --antigravity --global
```

---

### Trae

```bash
npx @opengsd/gsd-core@latest --trae --global
```

스킬은 `~/.trae/`에 저장됩니다. GSD는 스킬, 에이전트, 규칙 참조를 설치합니다.

---

## 로컬 설치 vs 전역 설치

위의 모든 예시는 사용자 계정 전체에 GSD를 한 번 설치하는 `--global`을 사용합니다. 단일 프로젝트로 범위를 제한하려면 `--global`을 `--local`로 바꾸세요:

```bash
npx @opengsd/gsd-core@latest --claude --local
```

로컬 설치는 프로젝트 루트의 `.claude/` 디렉터리에 작성됩니다. 둘 다 존재하는 경우 로컬 설치 설정이 전역 설정보다 우선합니다.

---

## 프리릴리스 에디션 설치 (Next / Nightly / Insiders / Preview)

런타임의 프리릴리스 에디션(Windsurf Next, Cursor Nightly, VS Code Insiders, Codex 프리뷰 채널 등)은 인접한 설정 디렉터리에서 읽습니다. 인스톨러 실행 전에 해당하는 `*_CONFIG_DIR` 환경 변수를 설정하세요:

```bash
WINDSURF_CONFIG_DIR=~/.codeium/windsurf-next npx @opengsd/gsd-core@latest --windsurf --global
```

인스톨러 프롬프트에서 해당하는 안정적인 런타임을 선택하세요. GSD는 프리릴리스 에디션을 별도의 명명된 런타임으로 열거하지 않습니다. 이 환경 변수 메커니즘을 통한 지원은 최선의 방식이며 릴리스 CI에서 별도로 테스트되지 않습니다.

---

## Node.js 없이 설치하기

`npx`를 실행할 수 없는 경우(예: Node.js가 없는 Windows 환경), 두 가지 옵션이 있습니다.

**옵션 A — Node.js가 있는 다른 머신 사용.** WSL, Linux VM, CI 러너, Docker 컨테이너 등 Node.js가 있는 어떤 머신이든 사용 가능합니다. 그곳에서 인스톨러를 실행한 후 출력 디렉터리를 대상 머신으로 복사하세요. OpenCode의 경우:

```bash
npx @opengsd/gsd-core@latest --opencode --global
# 그 다음 ~/.config/opencode/agents/ 를 Windows 머신으로 복사
```

**옵션 B — 소스 파일 수동 변환.** 에이전트 소스 파일은 GSD Core 저장소의 `agents/`에 있으며 Claude Code의 네이티브 frontmatter 형식입니다. 각 런타임은 다른 구조를 요구합니다. 런타임별 정확한 필드 변환에 대해서는 사용자 가이드의 [수동 설치 / Node.js 없는 설정](../USER-GUIDE.md#manual-install--no-nodejs-setup)을 참고하세요. OpenCode 변환 전체를 다루며 다른 런타임용 인스톨러의 `convert*Frontmatter` 함수를 안내합니다.

---

## 설치 후

새 명령과 에이전트를 적용하려면 런타임을 재시작하세요. 그런 다음 새 프로젝트를 시작하거나 기존 저장소를 온보딩합니다:

```bash
/gsd-new-project   # 그린필드 프로젝트
/gsd-onboard       # 기존 코드베이스
```

재시작 후 명령을 찾을 수 없다면 설치 디렉터리가 런타임이 기대하는 설정 경로와 일치하는지 확인하세요. 위의 프리릴리스 에디션 섹션에서 가장 흔한 불일치 사례를 다룹니다.

---

## 관련 문서

- [첫 번째 프로젝트](../tutorials/your-first-project.md)
- [GSD Core 업데이트](update-gsd.md)
- [설정](../CONFIGURATION.md)
- [문서 목차](../README.md)
