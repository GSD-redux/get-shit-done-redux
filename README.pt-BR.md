<div align="center">

# GSD Core

**Git. Ship. Done.**

[English](README.md) · **Português** · [简体中文](README.zh-CN.md) · [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md)

**Um sistema leve de meta-prompting, engenharia de contexto e desenvolvimento orientado a especificações para Claude Code, OpenCode, Gemini CLI, Kilo, Codex, Copilot, Cursor, Windsurf, Qoder e muito mais.**

[![npm version](https://img.shields.io/npm/v/%40opengsd%2Fgsd-core?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/@opengsd/gsd-core)
[![npm downloads](https://img.shields.io/npm/dm/%40opengsd%2Fgsd-core?style=for-the-badge&logo=npm&logoColor=white&color=CB3837)](https://www.npmjs.com/package/@opengsd/gsd-core)
[![Tests](https://img.shields.io/github/actions/workflow/status/open-gsd/gsd-core/test.yml?branch=main&style=for-the-badge&logo=github&label=Tests)](https://github.com/open-gsd/gsd-core/actions/workflows/test.yml)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/mYgfVNfA2r)
[![GitHub stars](https://img.shields.io/github/stars/open-gsd/gsd-core?style=for-the-badge&logo=github&color=181717)](https://github.com/open-gsd/gsd-core)
[![License](https://img.shields.io/badge/license-MIT-blue?style=for-the-badge)](LICENSE)

</div>

---

## O que é o GSD Core

GSD Core é um framework de engenharia de contexto e desenvolvimento orientado a especificações que conduz agentes de codificação com IA (Claude Code, Codex, Gemini CLI, Copilot, Cursor e mais) por meio de um ciclo de fases disciplinado. Ele resolve o [context rot](docs/pt-BR/explanation/context-engineering.md) — a degradação de qualidade que se acumula à medida que uma IA preenche sua janela de contexto — executando todo o trabalho pesado de pesquisa, planejamento e execução em subagentes com contexto limpo, mantendo sua sessão principal enxuta.

---

## Como funciona

Cada marco repete o mesmo ciclo de cinco etapas, uma fase por vez:

1. **Discuss** — capturar decisões de implementação antes de qualquer planejamento
2. **Plan** — pesquisar, decompor e verificar se o plano cabe em uma janela de contexto limpa
3. **Execute** — executar planos em ondas paralelas; cada executor começa com um contexto limpo de 200k tokens
4. **Verify** — percorrer o que foi construído; diagnosticar e corrigir antes de declarar conclusão
5. **Ship** — criar o PR, arquivar a fase e repetir para a próxima

---

## Início rápido

```bash
npx @opengsd/gsd-core@latest
```

O instalador solicita seu ambiente de execução (Claude Code, OpenCode, Gemini CLI, Kilo, Codex, Copilot, Cursor, Windsurf, Qoder e mais) e se deseja instalar globalmente ou localmente. O instalador é necessário para compatibilidade entre runtimes — não copie arquivos diretamente de `agents/` ou `commands/`.

Em outro runtime ou sem Node.js? Consulte [Instalar no seu runtime](docs/pt-BR/how-to/install-on-your-runtime.md).

Após a instalação, inicie um projeto novo ou integre um repositório existente:

```bash
/gsd-new-project   # projeto greenfield
/gsd-onboard       # base de código existente
```

É a primeira vez? Siga [Seu primeiro projeto](docs/pt-BR/tutorials/your-first-project.md) para um passo a passo guiado, desde a instalação até a primeira fase entregue. Para um repositório existente, consulte [Integrar uma base de código existente](docs/pt-BR/tutorials/onboarding-an-existing-codebase.md).

---

## Documentação

**Tutoriais** — aprendendo na prática:
- [Seu primeiro projeto](docs/pt-BR/tutorials/your-first-project.md)
- [Integrar uma base de código existente](docs/pt-BR/tutorials/onboarding-an-existing-codebase.md)

**Guias práticos** — receitas orientadas a tarefas:
- [Instalar no seu runtime](docs/pt-BR/how-to/install-on-your-runtime.md)
- [Planejar uma fase](docs/pt-BR/how-to/plan-a-phase.md)
- [Verificar e entregar](docs/pt-BR/how-to/verify-and-ship.md)
- … [ver todos os guias práticos](docs/pt-BR/README.md#how-to-guides)

**Referência** — informações autoritativas:
- [Comandos](docs/pt-BR/COMMANDS.md)
- [Configuração](docs/pt-BR/CONFIGURATION.md)
- [Ferramentas CLI](docs/pt-BR/CLI-TOOLS.md)

**Explicação** — conceitos e decisões de design:
- [Engenharia de contexto](docs/pt-BR/explanation/context-engineering.md)
- [O ciclo de fases](docs/pt-BR/explanation/the-phase-loop.md)
- [Arquitetura](docs/pt-BR/ARCHITECTURE.md)

Índice completo: [docs/pt-BR/README.md](docs/pt-BR/README.md). Outros idiomas: [日本語](README.ja-JP.md) · [한국어](README.ko-KR.md) · [Português](README.pt-BR.md) · [简体中文](README.zh-CN.md).

---

## Por que funciona

A maioria das configurações de codificação com IA falha em escala porque o inchaço de contexto degrada silenciosamente a qualidade da saída, não há memória compartilhada entre sessões e nada verifica se o código realmente funciona. O GSD Core resolve os três problemas: o trabalho pesado é executado em subagentes com contexto limpo, artefatos estruturados como `STATE.md` e `CONTEXT.md` sobrevivem às fronteiras de sessão, e a etapa de verificação percorre o que foi construído e gera planos de correção antes de uma fase ser declarada concluída. Consulte [docs/pt-BR/explanation/context-engineering.md](docs/pt-BR/explanation/context-engineering.md) para o raciocínio completo.

Problemas? Consulte [docs/pt-BR/how-to/recover-and-troubleshoot.md](docs/pt-BR/how-to/recover-and-troubleshoot.md).

---

## Comunidade

| Projeto | Plataforma |
|---------|----------|
| [gsd-opencode](https://github.com/rokicool/gsd-opencode) | Port original para OpenCode |
| [Discord](https://discord.gg/mYgfVNfA2r) | Suporte da comunidade |

---

## Histórico de estrelas

<a href="https://star-history.com/#open-gsd/gsd-core&Date">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=open-gsd/gsd-core&type=Date&theme=dark" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=open-gsd/gsd-core&type=Date" />
   <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=open-gsd/gsd-core&type=Date" />
 </picture>
</a>

---

## Licença

Licença MIT. Consulte [LICENSE](LICENSE) para detalhes.

---

<div align="center">

**Claude Code é poderoso. GSD Core o torna confiável.**

</div>
