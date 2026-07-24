<div align="center">

# GSD Core

**Git. Ship. Done.**

[English](README.md) · [Português](README.pt-BR.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md) · **한국어**

**Claude Code, OpenCode, Gemini CLI, Kilo, Codex, Copilot, Cursor, Windsurf, Qoder 등을 위한 경량 메타 프롬프팅, 컨텍스트 엔지니어링, 스펙 기반 개발 시스템.**

[![npm version](https://img.shields.io/npm/v/%40opengsd%2Fgsd-core?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/@opengsd/gsd-core)
[![npm downloads](https://img.shields.io/npm/dm/%40opengsd%2Fgsd-core?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/@opengsd/gsd-core)
[![Tests](https://img.shields.io/github/actions/workflow/status/open-gsd/gsd-core/test.yml?branch=main&style=for-the-badge&logo=github&label=Tests)](https://github.com/open-gsd/gsd-core/actions/workflows/test.yml)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/mYgfVNfA2r)
[![GitHub stars](https://img.shields.io/github/stars/open-gsd/gsd-core?style=for-the-badge&logo=github&color=181717)](https://github.com/open-gsd/gsd-core)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

</div>

---

## GSD Core란

GSD Core는 컨텍스트 엔지니어링 및 스펙 기반 개발 프레임워크로, AI 코딩 에이전트(Claude Code, Codex, Gemini CLI, Copilot, Cursor 등)를 엄격한 단계 루프로 운용합니다. AI가 컨텍스트 창을 채워 나가면서 발생하는 품질 저하인 [컨텍스트 rot](docs/ko-KR/explanation/context-engineering.md) 문제를 해결합니다. 무거운 리서치, 기획, 실행 작업은 새로운 컨텍스트의 서브에이전트에서 처리하고, 메인 세션은 가볍게 유지됩니다.

---

## 작동 방식

각 마일스톤은 동일한 다섯 단계 루프를 반복합니다:

1. **논의(Discuss)** — 기획 전에 구현 결정 사항을 미리 정리
2. **기획(Plan)** — 리서치, 분해, 그리고 플랜이 새 컨텍스트 창에 맞는지 검증
3. **실행(Execute)** — 병렬 웨이브로 플랜 실행; 각 실행기는 20만 토큰의 깨끗한 컨텍스트로 시작
4. **검증(Verify)** — 구현 결과를 검토하고, 완료 선언 전 문제 진단 및 수정
5. **출시(Ship)** — PR 생성, 단계 아카이브, 다음 단계 반복

---

## 빠른 시작

```bash
npx @opengsd/gsd-core@latest
```

설치 프로그램이 런타임(Claude Code, OpenCode, Gemini CLI, Kilo, Codex, Copilot, Cursor, Windsurf, Qoder 등)과 전역/로컬 설치 여부를 묻습니다. 크로스 런타임 호환성을 위해 설치 프로그램을 사용해야 합니다 — `agents/` 또는 `commands/`에서 파일을 직접 복사하지 마세요.

다른 런타임이나 Node.js가 없는 환경은 [런타임에 설치하기](docs/ko-KR/how-to/install-on-your-runtime.md)를 참조하세요.

설치 후 새 프로젝트를 시작하거나 기존 저장소를 온보딩합니다:

```bash
/gsd-new-project   # 그린필드 프로젝트
/gsd-onboard       # 기존 코드베이스
```

처음 사용하시나요? [첫 번째 프로젝트](docs/ko-KR/tutorials/your-first-project.md)를 따라 설치부터 첫 단계 출시까지 안내받으세요. 기존 저장소라면 [기존 코드베이스 온보딩](docs/ko-KR/tutorials/onboarding-an-existing-codebase.md)을 참고하세요.

---

## 문서

**튜토리얼** — 직접 해보며 배우기:
- [첫 번째 프로젝트](docs/ko-KR/tutorials/your-first-project.md)
- [기존 코드베이스 온보딩](docs/ko-KR/tutorials/onboarding-an-existing-codebase.md)

**How-to 가이드** — 작업별 레시피:
- [런타임에 설치하기](docs/ko-KR/how-to/install-on-your-runtime.md)
- [단계 기획하기](docs/ko-KR/how-to/plan-a-phase.md)
- [검증 및 출시](docs/ko-KR/how-to/verify-and-ship.md)
- … [모든 how-to 가이드 보기](docs/ko-KR/README.md#how-to-guides)

**레퍼런스** — 권위 있는 사실:
- [명령어](docs/ko-KR/COMMANDS.md)
- [설정](docs/ko-KR/CONFIGURATION.md)
- [CLI 도구](docs/ko-KR/CLI-TOOLS.md)

**설명** — 개념 및 설계 결정:
- [컨텍스트 엔지니어링](docs/ko-KR/explanation/context-engineering.md)
- [단계 루프](docs/ko-KR/explanation/the-phase-loop.md)
- [아키텍처](docs/ko-KR/ARCHITECTURE.md)

전체 색인: [docs/ko-KR/README.md](docs/ko-KR/README.md). 다른 언어: [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md) · [Português](README.pt-BR.md) · [简体中文](README.zh-CN.md).

---

## 왜 효과적인가

대부분의 AI 코딩 환경은 규모가 커지면 실패합니다. 컨텍스트 비대화로 출력 품질이 조용히 저하되고, 세션 간 공유 메모리가 없으며, 코드가 실제로 동작하는지 검증하는 것이 없기 때문입니다. GSD Core는 이 세 가지를 모두 해결합니다. 무거운 작업은 새 서브에이전트에서 실행되고, `STATE.md`와 `CONTEXT.md` 같은 구조화된 아티팩트가 세션 경계를 넘어 유지되며, 검증 단계가 구현 결과를 검토하고 단계 완료 선언 전 수정 계획을 생성합니다. 자세한 내용은 [docs/ko-KR/explanation/context-engineering.md](docs/ko-KR/explanation/context-engineering.md)를 참조하세요.

문제가 발생했나요? [docs/ko-KR/how-to/recover-and-troubleshoot.md](docs/ko-KR/how-to/recover-and-troubleshoot.md)를 확인하세요.

---

## 커뮤니티

| 프로젝트 | 플랫폼 |
|---------|----------|
| [gsd-opencode](https://github.com/rokicool/gsd-opencode) | 최초 OpenCode 포트 |
| [Discord](https://discord.gg/mYgfVNfA2r) | 커뮤니티 지원 |

---

## 스타 히스토리

<a href="https://star-history.com/#open-gsd/gsd-core&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=open-gsd/gsd-core&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=open-gsd/gsd-core&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=open-gsd/gsd-core&type=Date" />
 </picture>
</a>

---

## 라이선스

MIT 라이선스. 자세한 내용은 [LICENSE](LICENSE)를 참조하세요.

---

<div align="center">

**Claude Code는 강력합니다. GSD Core가 그걸 신뢰할 수 있게 만듭니다.**

</div>
