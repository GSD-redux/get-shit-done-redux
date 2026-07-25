# Arquitetura do GSD Core

> Arquitetura do sistema para contribuidores e usuários avançados. Para a documentação voltada ao usuário, consulte a [Referência de Funcionalidades](FEATURES.md) ou o [Guia do Usuário](USER-GUIDE.md).

---

## Índice

- [Visão Geral do Sistema](#visão-geral-do-sistema)
- [Princípios de Design](#princípios-de-design)
- [Arquitetura de Componentes](#arquitetura-de-componentes)
- [Modelo de Agentes](#modelo-de-agentes)
- [Fluxo de Dados](#fluxo-de-dados)
- [Estrutura do Sistema de Arquivos](#estrutura-do-sistema-de-arquivos)
- [Arquitetura do Instalador](#arquitetura-do-instalador)
- [Sistema de Hooks](#sistema-de-hooks)
- [Camada de Ferramentas CLI](#camada-de-ferramentas-cli)
- [Abstração de Runtime](#abstração-de-runtime)

---

## Visão Geral do Sistema

O GSD Core é um **framework de meta-prompting** que fica entre o usuário e os agentes de codificação com IA (Claude Code, Gemini CLI, OpenCode, Kilo, Codex, Copilot, Antigravity, Trae, Cline, Augment Code). Ele fornece:

1. **Engenharia de contexto** — Artefatos estruturados que fornecem à IA tudo o que ela precisa por tarefa (consulte [Engenharia de contexto](explanation/context-engineering.md))
2. **Orquestração multi-agente** — Orquestradores leves que criam agentes especializados com janelas de contexto novas (consulte [Orquestração multi-agente](explanation/multi-agent-orchestration.md))
3. **Desenvolvimento orientado por especificações** — Pipeline de Requisitos → pesquisa → planos → execução → verificação
4. **Gerenciamento de estado** — Memória persistente do projeto entre sessões e reinicializações de contexto

```
┌──────────────────────────────────────────────────────┐
│                      USUÁRIO                         │
│            /gsd-command [args]                        │
└─────────────────────┬────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────┐
│              CAMADA DE COMANDOS                       │
│   commands/gsd/*.md — Arquivos de comandos baseados   │
│   em prompts (comandos customizados Claude Code /     │
│   skills do Codex)                                    │
└─────────────────────┬────────────────────────────────┘
                      │
┌─────────────────────▼────────────────────────────────┐
│              CAMADA DE WORKFLOWS                      │
│   gsd-core/workflows/*.md — Lógica de            │
│   orquestração                                        │
│   (Lê referências, cria agentes, gerencia estado)     │
└──────┬──────────────┬─────────────────┬──────────────┘
       │              │                 │
┌──────▼──────┐ ┌─────▼─────┐ ┌────────▼───────┐
│  AGENTE     │ │  AGENTE   │ │  AGENTE        │
│  (contexto  │ │  (contexto│ │  (contexto     │
│   novo)     │ │   novo)   │ │   novo)        │
└──────┬──────┘ └─────┬─────┘ └────────┬───────┘
       │              │                 │
┌──────▼──────────────▼─────────────────▼──────────────┐
│              CAMADA DE FERRAMENTAS CLI                │
│   gsd-tools.cjs command families + domain modules     │
│   command-routing-hub + observability seams           │
└──────────────────────┬───────────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────────┐
│              SISTEMA DE ARQUIVOS (.planning/)         │
│   PROJECT.md | REQUIREMENTS.md | ROADMAP.md          │
│   STATE.md | config.json | phases/ | research/       │
└──────────────────────────────────────────────────────┘
```

---

## Princípios de Design

### 1. Contexto Novo por Agente

Cada agente criado por um orquestrador recebe uma janela de contexto limpa (até 200 mil tokens). Isso elimina o desgaste do contexto — a degradação de qualidade que ocorre à medida que uma IA preenche sua janela de contexto com a conversa acumulada.

### 2. Orquestradores Leves

Os arquivos de workflow (`gsd-core/workflows/*.md`) nunca fazem trabalho pesado. Eles:

- Carregam contexto via `gsd-tools.cjs init <workflow>`
- Criam agentes especializados com prompts focados
- Coletam resultados e encaminham para a próxima etapa
- Atualizam o estado entre as etapas

### 3. Estado Baseado em Arquivos

Todo o estado fica em `.planning/` como Markdown e JSON legíveis por humanos. Sem banco de dados, sem servidor, sem dependências externas. Isso significa:

- O estado sobrevive a reinicializações de contexto (`/clear`)
- O estado é inspecionável tanto por humanos quanto por agentes
- O estado pode ser commitado no git para visibilidade da equipe

### 4. Ausente = Habilitado

Os feature flags de workflow seguem o padrão **ausente = habilitado**. Se uma chave estiver ausente do `config.json`, o padrão é `true`. Os usuários desabilitam funcionalidades explicitamente; não precisam habilitar os padrões.

### 5. Defesa em Profundidade

Múltiplas camadas previnem modos comuns de falha:

- Os planos são verificados antes da execução (agente plan-checker)
- A execução produz commits atômicos por tarefa
- A verificação pós-execução confronta os objetivos da fase
- O UAT fornece verificação humana como portão final

---

## Arquitetura de Componentes

### Comandos (`commands/gsd/*.md`)

Pontos de entrada voltados ao usuário. Cada arquivo contém frontmatter YAML (name, description, allowed-tools) e um corpo de prompt que inicializa o workflow. Os comandos são instalados como:

- **Claude Code:** Comandos slash customizados (forma com hífen, `/gsd-command-name`)
- **OpenCode / Kilo:** Comandos slash (forma com hífen, `/gsd-command-name`)
- **Codex:** Skills (`$gsd-command-name`)
- **Copilot:** Comandos slash (forma com hífen, `/gsd-command-name`)
- **Gemini CLI:** Comandos slash sob o namespace `gsd:` (forma com dois-pontos, `/gsd:command-name`) — o Gemini agrupa todos os comandos customizados sob o id do plugin, portanto a instalação reescreve cada referência no corpo do texto para a forma com dois-pontos
- **Antigravity:** Skills

**Total de comandos:** consulte [`docs/INVENTORY.md`](INVENTORY.md#commands) para a contagem oficial e o roster completo.

#### Roteamento hierárquico em dois estágios (v1.40, [#2792](https://github.com/open-gsd/gsd-core/issues/2792))

Para manter baixo o custo em tokens da listagem de skills antecipada, a v1.40 introduz seis **meta-skills** de namespace (`gsd-workflow`, `gsd-project`, `gsd-quality`, `gsd-context`, `gsd-manage`, `gsd-ideate` — originados de `commands/gsd/ns-*.md`, mas o `name:` invocável é a forma básica mostrada aqui) dispostos acima das sub-skills concretas. O modelo vê 6 roteadores de namespace (~120 tokens) em vez de uma listagem plana de 86 skills (~2.150 tokens), seleciona um namespace e depois roteia para a sub-skill concreta via tabela de roteamento embutida no corpo do roteador de namespace. As skills de namespace são **aditivas** — cada comando concreto ainda é diretamente invocável.

As descrições dos roteadores usam tags de palavras-chave separadas por pipe (≤ 60 caracteres) conforme a pesquisa Tool Attention, que mostra que tags ricas em palavras-chave superam a prosa no roteamento com ~40% do custo em tokens.

#### Interação com o orçamento de tokens do MCP

A listagem de skills antecipada é um dos dois custos recorrentes de tokens por turno. O outro é o schema de ferramenta MCP injetado por cada servidor MCP habilitado em `.claude/settings.json`. Servidores MCP pesados (browser/playwright, Mac-tools, Windows-tools) podem custar mais de 20 mil tokens por turno cada — muitas vezes eclipsando o que o ajuste do `model_profile` economiza. O controle fica no harness do Claude Code (`enabledMcpjsonServers` / `disabledMcpjsonServers` em `.claude/settings.json`) e **não** é uma preocupação do GSD. Juntos, a camada de roteamento em dois estágios (#2792) e o controle criterioso do MCP são as maiores alavancas de custo por turno. Consulte [`docs/USER-GUIDE.md`](USER-GUIDE.md) e `references/context-budget.md` para o checklist de auditoria.

### Workflows (`gsd-core/workflows/*.md`)

Lógica de orquestração que os comandos referenciam. Contém o processo passo a passo, incluindo:

- Carregamento de contexto via handlers `gsd-tools.cjs init`
- Instruções de criação de agente com resolução de modelo
- Definições de portões/checkpoints
- Padrões de atualização de estado
- Tratamento de erros e recuperação

**Total de workflows:** consulte [`docs/INVENTORY.md`](INVENTORY.md#workflows) para a contagem oficial e o roster completo.

#### Divulgação progressiva para workflows

Os arquivos de workflow são carregados verbatim no contexto do Claude cada vez que o
comando `/gsd-*` correspondente é invocado. Para manter esse custo limitado, o
orçamento de tamanho de workflow aplicado por `tests/workflow-size-budget.test.cjs`
espelha a convenção de orçamento de tamanho de agentes:

| Tier      | Limite de linhas por arquivo |
|-----------|------------------------------|
| `XL`      | 1700 — orquestradores de nível superior (`execute-phase`, `plan-phase`, `new-project`) |
| `LARGE`   | 1500 — planejadores com múltiplas etapas e workflows de funcionalidades grandes |
| `DEFAULT` | 1000 — workflows simples e de propósito único (o tier alvo) |

`workflows/discuss-phase.md` é mantido em um teto mais restrito conforme
o orçamento de bytes do discuss-phase (#717; a divisão discuss-phase/modes mantém ≈32000 bytes). Quando um workflow cresce além de seu tier, extraia os corpos por modo
em `workflows/<workflow>/modes/<mode>.md`, templates em
`workflows/<workflow>/templates/`, e conhecimento compartilhado em
`gsd-core/references/`. O arquivo pai se torna um despachante leve que
lê apenas os arquivos de modo e template necessários para a invocação atual.

`workflows/discuss-phase/` é o exemplo canônico deste padrão —
o pai despacha, modes/ contém o comportamento por flag (`power.md`, `all.md`,
`auto.md`, `chain.md`, `text.md`, `batch.md`, `analyze.md`, `default.md`,
`advisor.md`), e templates/ contém os schemas CONTEXT.md, DISCUSSION-LOG.md e
checkpoint.json que são lidos apenas quando o arquivo de saída correspondente
está sendo escrito.

### Agentes (`agents/*.md`)

Definições de agentes especializados com frontmatter especificando:

- `name` — Identificador do agente
- `description` — Papel e propósito
- `tools` — Acesso às ferramentas permitidas (Read, Write, Edit, Bash, Grep, Glob, WebSearch, etc.)
- `color` — Cor de saída no terminal para distinção visual

**Total de agentes:** 33

### Referências (`gsd-core/references/*.md`)

Documentos de conhecimento compartilhado que workflows e agentes `@-referenciam` (consulte [`docs/INVENTORY.md`](INVENTORY.md#references-41-shipped) para a contagem oficial e o roster completo):

**Referências principais:**

- `checkpoints.md` — Definições de tipos de checkpoint e padrões de interação
- `gates.md` — 4 tipos canônicos de portões (Confirm, Quality, Safety, Transition) conectados ao plan-checker e ao verifier
- `model-profiles.md` — Atribuições de tier de modelo por agente
- `model-profile-resolution.md` — Documentação do algoritmo de resolução de modelo
- `verification-patterns.md` — Como verificar diferentes tipos de artefatos
- `verification-overrides.md` — Regras de substituição de verificação por artefato
- `planning-config.md` — Schema completo de configuração e comportamento
- `git-integration.md` — Padrões de commit no git, branching e histórico
- `git-planning-commit.md` — Convenções de commit do diretório de planejamento
- `questioning.md` — Filosofia de extração de visão para inicialização de projetos
- `tdd.md` — Padrões de integração de desenvolvimento orientado por testes
- `ui-brand.md` — Padrões de formatação de saída visual
- `common-bug-patterns.md` — Padrões comuns de bugs para revisão de código e verificação

**Referências de workflow:**

- `agent-contracts.md` — Interface formal entre orquestradores e agentes
- `context-budget.md` — Regras de alocação do orçamento da janela de contexto
- `continuation-format.md` — Formato de continuação/retomada de sessão
- `domain-probes.md` — Perguntas de sondagem específicas de domínio para a discuss-phase
- `gate-prompts.md` — Templates de prompt para portões/checkpoints
- `revision-loop.md` — Padrões de iteração de revisão de plano
- `universal-anti-patterns.md` — Anti-padrões comuns a detectar e evitar
- `artifact-types.md` — Definições de tipos de artefatos de planejamento
- `phase-argument-parsing.md` — Convenções de análise de argumentos de fase
- `decimal-phase-calculation.md` — Regras de numeração decimal de sub-fases
- `workstream-flag.md` — Convenções do ponteiro ativo de workstream
- `user-profiling.md` — Metodologia de perfilamento comportamental do usuário
- `thinking-partner.md` — Ativação condicional de parceiro de raciocínio em pontos de decisão

**Referências para modelos de raciocínio:**

Referências para integrar modelos de classe thinking (o3, o4-mini, Gemini 2.5 Pro) aos workflows do GSD:

- `thinking-models-debug.md` — Padrões de modelos de raciocínio para workflows de depuração
- `thinking-models-execution.md` — Padrões de modelos de raciocínio para agentes de execução
- `thinking-models-planning.md` — Padrões de modelos de raciocínio para agentes de planejamento
- `thinking-models-research.md` — Padrões de modelos de raciocínio para agentes de pesquisa
- `thinking-models-verification.md` — Padrões de modelos de raciocínio para agentes de verificação

**Decomposição modular do planner:**

O agente planner (`agents/gsd-planner.md`) foi decomposto de um único arquivo monolítico em um agente central mais módulos de referência para permanecer abaixo do limite de 50 mil caracteres imposto por alguns runtimes:

- `planner-gap-closure.md` — Comportamento do modo de fechamento de lacunas (lê VERIFICATION.md, replanejamento direcionado)
- `planner-reviews.md` — Integração de revisão entre IAs (lê REVIEWS.md do `/gsd-review`)
- `planner-revision.md` — Padrões de revisão de plano para refinamento iterativo

### Templates (`gsd-core/templates/`)

Templates Markdown para todos os artefatos de planejamento. Usados por `gsd-tools.cjs template fill` / `phase.scaffold` (e `scaffold` de nível superior) para criar arquivos pré-estruturados:
- `project.md`, `requirements.md`, `roadmap.md`, `state.md` — Arquivos principais do projeto
- `phase-prompt.md` — Template de prompt de execução de fase
- `summary.md` (+ `summary-minimal.md`, `summary-standard.md`, `summary-complex.md`) — Templates de resumo com granularidade ajustável
- `DEBUG.md` — Template de acompanhamento de sessão de depuração
- `UI-SPEC.md`, `UAT.md`, `VALIDATION.md` — Templates de verificação especializados
- `discussion-log.md` — Template de trilha de auditoria de discussão
- `codebase/` — Templates de mapeamento de brownfield (stack, architecture, conventions, concerns, structure, testing, integrations)
- `research-project/` — Templates de saída de pesquisa (SUMMARY, STACK, FEATURES, ARCHITECTURE, PITFALLS)

### Hooks (`hooks/`)

Hooks de runtime que se integram ao agente de IA anfitrião:

| Hook | Evento | Propósito |
|------|--------|-----------|
| `gsd-statusline.js` | `statusLine` | Exibe modelo, tarefa, diretório e barra de uso do contexto |
| `gsd-context-monitor.js` | `PostToolUse` / `AfterTool` | Injeta avisos de contexto voltados ao agente em 35%/25% restante |
| `gsd-check-update.js` | `SessionStart` | Gatilho em primeiro plano para a verificação de atualização em segundo plano |
| `gsd-check-update-worker.js` | (auxiliar) | Worker em segundo plano criado por `gsd-check-update.js`; sem registro de evento direto |
| `gsd-prompt-guard.js` | `PreToolUse` | Escaneia escritas em `.planning/` em busca de padrões de injeção de prompt (consultivo) |
| `gsd-read-injection-scanner.js` | `PostToolUse` | Escaneia saídas da ferramenta Read em busca de instruções injetadas em conteúdo não confiável |
| `gsd-workflow-guard.js` | `PreToolUse` | Detecta edições de arquivos fora do contexto de workflow do GSD (consultivo, ativado via `hooks.workflow_guard`) |
| `gsd-read-guard.js` | `PreToolUse` | Guarda consultivo que impede Edit/Write em arquivos ainda não lidos na sessão |
| `gsd-session-state.sh` | `PostToolUse` | Rastreamento de estado de sessão para runtimes baseados em shell |
| `gsd-validate-commit.sh` | `PostToolUse` | Validação de commit para aplicação de commits convencionais |
| `gsd-phase-boundary.sh` | `PostToolUse` | Detecção de limite de fase para transições de workflow |

Consulte [`docs/INVENTORY.md`](INVENTORY.md#hooks-11-shipped) para o roster oficial de 11 hooks.

### Hub de Roteamento de Comandos (`gsd-core/bin/lib/command-routing-hub.cjs`)

Os roteadores de família de comandos CJS despacham através do `CommandRoutingHub`. O hub possui o contrato de resultado puro sem lançamento de exceções (`hub.dispatch()` captura exceções internas e retorna `{ ok: false, kind, ...typedPayload }`) e a taxonomia fechada de erros de runtime (`UnknownCommand`, `InvalidArgs`, `HandlerRefusal`, `HandlerFailure`). Os adaptadores de roteador permanecem como tradutores CLI leves — eles constroem o hub, chamam `dispatch` e depois mapeiam o Result para chamadas `output()`/`error()`. O runtime é de caminho único (sem seleção de modo de runtime duplo). Consulte `docs/adr/0174-retire-gsd-sdk-package-boundary.md`.

### Ferramentas CLI (`gsd-core/bin/`)

Utilitário CLI Node.js (`gsd-tools.cjs`) com módulos de domínio distribuídos em `gsd-core/bin/lib/` (consulte [`docs/INVENTORY.md`](INVENTORY.md#cli-modules-33-shipped) para o roster oficial):


| Módulo                 | Responsabilidade                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------- |
| `core.cjs`             | Tratamento de erros, formatação de saída, utilitários compartilhados; re-exportações de compatibilidade para helpers de planejamento |
| `planning-workspace.cjs` | Camada de planejamento (`planningDir`, `planningPaths`, roteamento de workstream ativo, `.planning/.lock`) |
| `state.cjs`            | Análise, atualização, progressão e métricas do STATE.md                                               |
| `phase.cjs`            | Operações de diretório de fase, numeração decimal, indexação de planos                                |
| `roadmap.cjs`          | Análise do ROADMAP.md, extração de fases, progresso do plano                                          |
| `config.cjs`           | Leitura/escrita do config.json, inicialização de seções                                               |
| `verify.cjs`           | Estrutura do plano, integridade de fase, referência, validação de commit                              |
| `template.cjs`         | Seleção e preenchimento de template com substituição de variáveis                                     |
| `frontmatter.cjs`      | Operações CRUD de frontmatter YAML                                                                    |
| `init.cjs`             | Carregamento composto de contexto para cada tipo de workflow                                          |
| `milestone.cjs`        | Arquivamento de milestones, marcação de requisitos                                                    |
| `commands.cjs`         | Comandos diversos (slug, timestamp, todos, scaffolding, stats)                                        |
| `model-profiles.cjs`   | Tabela de resolução de perfis de modelo                                                               |
| `security.cjs`         | Prevenção de path traversal, detecção de injeção de prompt, análise segura de JSON, validação de argumentos de shell |
| `uat.cjs`              | Análise de arquivo UAT, rastreamento de débito de verificação, suporte a audit-uat                    |
| `docs.cjs`             | Inicialização do workflow de atualização de docs, escaneamento de Markdown, detecção de monorepo      |
| `workstream.cjs`       | CRUD de workstream, migração, ponteiro ativo com escopo de sessão                                     |
| `schema-detect.cjs`    | Detecção de desvio de schema para padrões ORM (Prisma, Drizzle, etc.)                                 |
| `profile-pipeline.cjs` | Pipeline de dados de perfilamento comportamental do usuário, escaneamento de arquivos de sessão       |
| `profile-output.cjs`   | Renderização de perfil, geração de USER-PROFILE.md e dev-preferences.md                              |


---

## Modelo de Agentes

### Padrão Orquestrador → Agente

```
Orquestrador (workflow .md)
    │
    ├── Carregar contexto: gsd-tools.cjs init <workflow> <phase>
    │   Retorna JSON com: informações do projeto, config, estado, detalhes da fase
    │
    ├── Resolver modelo: gsd-tools.cjs resolve-model <agent-name>
    │   Retorna: opus | sonnet | haiku | inherit
    │
    ├── Criar Agente (chamada Task/SubAgent)
    │   ├── Prompt do agente (agents/*.md)
    │   ├── Payload de contexto (JSON do init)
    │   ├── Atribuição de modelo
    │   └── Permissões de ferramentas
    │
    ├── Coletar resultado
    │
    └── Atualizar estado: gsd-tools.cjs state update / state patch / state advance-plan
```

### Categorias Principais de Criação de Agentes

Taxonomia conceitual de padrões de criação para os 21 agentes primários. Para o roster oficial de 31 agentes (incluindo os 10 agentes avançados/especializados como `gsd-pattern-mapper`, `gsd-code-reviewer`, `gsd-code-fixer`, `gsd-ai-researcher`, `gsd-domain-researcher`, `gsd-eval-planner`, `gsd-eval-auditor`, `gsd-framework-selector`, `gsd-debug-session-manager`, `gsd-intel-updater`), consulte [`docs/INVENTORY.md`](INVENTORY.md#agents-31-shipped).


| Categoria        | Agentes                                                                                 | Paralelismo                                                                               |
| ---------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **Pesquisadores** | gsd-project-researcher, gsd-phase-researcher, gsd-ui-researcher, gsd-advisor-researcher | 4 paralelos (stack, features, architecture, pitfalls); advisor criado durante a discuss-phase |
| **Sintetizadores** | gsd-research-synthesizer                                                               | Sequencial (após a conclusão dos pesquisadores)                                           |
| **Planejadores** | gsd-planner, gsd-roadmapper                                                             | Sequencial                                                                                |
| **Verificadores de plano** | gsd-plan-checker, gsd-integration-checker, gsd-ui-checker, gsd-nyquist-auditor | Sequencial (loop de verificação, máximo 3 iterações)                                      |
| **Executores**   | gsd-executor                                                                            | Paralelo dentro de ondas, sequencial entre ondas                                          |
| **Verificadores** | gsd-verifier                                                                           | Sequencial (após a conclusão de todos os executores)                                      |
| **Mapeadores**   | gsd-codebase-mapper                                                                     | 4 paralelos (tech, arch, quality, concerns)                                               |
| **Depuradores**  | gsd-debugger                                                                            | Sequencial (interativo)                                                                   |
| **Auditores**    | gsd-ui-auditor, gsd-security-auditor                                                    | Sequencial                                                                                |
| **Escritores de doc** | gsd-doc-writer, gsd-doc-verifier                                                   | Sequencial (escritor depois verificador)                                                  |
| **Perfiladores** | gsd-user-profiler                                                                       | Sequencial                                                                                |
| **Analisadores** | gsd-assumptions-analyzer                                                                | Sequencial (durante a discuss-phase)                                                      |


### Modelo de Execução em Ondas

Durante a `execute-phase`, os planos são agrupados em ondas de dependência:

```
Análise de Ondas:
  Plano 01 (sem deps)      ─┐
  Plano 02 (sem deps)      ─┤── Onda 1 (paralelo)
  Plano 03 (depende: 01)   ─┤── Onda 2 (aguarda a Onda 1)
  Plano 04 (depende: 02)   ─┘
  Plano 05 (depende: 03,04) ── Onda 3 (aguarda a Onda 2)
```

Cada executor recebe:

- Janela de contexto nova de 200 mil tokens (ou até 1 M para modelos que suportam)
- O PLAN.md específico a executar
- Contexto do projeto (PROJECT.md, STATE.md)
- Contexto da fase (CONTEXT.md, RESEARCH.md se disponível)

### Enriquecimento Adaptativo de Contexto (Modelos de 1 M)

Quando a janela de contexto tem 500 mil tokens ou mais (modelos classe 1 M como Opus 4.6, Sonnet 4.6), os prompts de subagentes são automaticamente enriquecidos com contexto adicional que não caberia em janelas de 200 mil tokens padrão:

- **Agentes executores** recebem os arquivos SUMMARY.md de ondas anteriores e o CONTEXT.md/RESEARCH.md da fase, possibilitando consciência entre planos dentro de uma fase
- **Agentes verificadores** recebem todos os arquivos PLAN.md, SUMMARY.md, CONTEXT.md mais REQUIREMENTS.md, possibilitando verificação com consciência do histórico

O orquestrador lê `context_window` da configuração (`gsd-tools.cjs config-get context_window`) e inclui condicionalmente um contexto mais rico quando o valor é >= 500.000. Para janelas de 200 mil tokens padrão, os prompts usam versões truncadas com ordenação favorável ao cache para maximizar a eficiência do contexto.

#### Segurança de Commits Paralelos

Quando múltiplos executores rodam dentro da mesma onda, dois mecanismos previnem conflitos:

1. Commits `--no-verify` — Agentes paralelos pulam hooks de pré-commit (que podem causar contenção de lock de build, por exemplo, disputas de cargo lock em projetos Rust). O orquestrador executa `git hook run pre-commit` uma vez após a conclusão de cada onda.
2. **Bloqueio de arquivo STATE.md** — Todas as chamadas `writeStateMd()` usam exclusão mútua baseada em lockfile (`STATE.md.lock` com criação atômica `O_EXCL`). Isso previne a condição de corrida leitura-modificação-escrita onde dois agentes leem o STATE.md, modificam campos diferentes, e o último a escrever sobrescreve as alterações do outro. Inclui detecção de lock obsoleto (timeout de 10 s) e espera em spin com jitter.

---

## Fluxo de Dados

### Fluxo de Novo Projeto

```
Entrada do usuário (descrição da ideia)
    │
    ▼
Perguntas (filosofia questioning.md)
    │
    ▼
4x Pesquisadores de Projeto (paralelo)
    ├── Stack → STACK.md
    ├── Features → FEATURES.md
    ├── Architecture → ARCHITECTURE.md
    └── Pitfalls → PITFALLS.md
    │
    ▼
Sintetizador de Pesquisa → SUMMARY.md
    │
    ▼
Extração de requisitos → REQUIREMENTS.md
    │
    ▼
Roadmapper → ROADMAP.md
    │
    ▼
Aprovação do usuário → STATE.md inicializado
```

### Fluxo de Execução de Fase

```
discuss-phase → CONTEXT.md (preferências do usuário)
    │
    ▼
ui-phase → UI-SPEC.md (contrato de design, opcional)
    │
    ▼
plan-phase
    ├── Portão de pesquisa (bloqueia se RESEARCH.md tiver perguntas abertas não resolvidas)
    ├── Pesquisador de Fase → RESEARCH.md
    │       └── Portão de Legitimidade de Pacotes: slopcheck em cada pacote; [SLOP] removido,
    │           [SUS]/[ASSUMED] sinalizados; tabela de Auditoria escrita no RESEARCH.md
    ├── Planner (com verificação de alcançabilidade) → arquivos PLAN.md
    │       └── checkpoint:human-verify injetado antes de instalações [ASSUMED]/[SUS];
    │           linha STRIDE T-{phase}-SC adicionada para planos com instalação
    ├── Plan Checker → Loop de verificação (máximo 3x)
    ├── Portão de cobertura de requisitos (REQ-IDs → planos)
    └── Portão de cobertura de decisões (CONTEXT.md `<decisions>` → planos, BLOQUEANTE — #2492)
    │
    ▼
state planned-phase → STATE.md (Planned/Ready to execute)
    │
    ▼
execute-phase (redução de contexto: prompts truncados, ordenação favorável ao cache)
    ├── Análise de ondas (agrupamento por dependência)
    ├── Executor por plano → código + commits atômicos
    ├── SUMMARY.md por plano
    └── Verifier → VERIFICATION.md
        └── Portão de cobertura de decisões (decisões do CONTEXT.md → artefatos entregues, NÃO BLOQUEANTE — #2492)
    │
    ▼
verify-work → UAT.md (testes de aceitação do usuário)
    │
    ▼
ui-review → UI-REVIEW.md (auditoria visual, opcional)
```

### Propagação de Contexto

Cada estágio de workflow produz artefatos que alimentam as etapas subsequentes:

```
PROJECT.md ────────────────────────────────────────────► Todos os agentes
REQUIREMENTS.md ───────────────────────────────────────► Planner, Verifier, Auditor
ROADMAP.md ────────────────────────────────────────────► Orquestradores
STATE.md ──────────────────────────────────────────────► Todos os agentes (decisões, bloqueadores)
CONTEXT.md (por fase) ─────────────────────────────────► Researcher, Planner, Executor
RESEARCH.md (por fase) ────────────────────────────────► Planner, Plan Checker
PLAN.md (por plano) ───────────────────────────────────► Executor, Plan Checker
SUMMARY.md (por plano) ────────────────────────────────► Verifier, rastreamento de estado
UI-SPEC.md (por fase) ─────────────────────────────────► Executor, UI Auditor
```

---

## Estrutura do Sistema de Arquivos

### Arquivos de Instalação

```
~/.claude/                          # Claude Code (instalação global)
├── skills/gsd-*/SKILL.md           # Skills globais (roster oficial: docs/INVENTORY.md)
├── commands/gsd/*.md               # Instalações locais do Claude usam slash commands em vez de skills globais
├── gsd-core/
│   ├── bin/gsd-tools.cjs           # Utilitário CLI
│   ├── bin/lib/*.cjs               # Módulos de domínio (roster oficial: docs/INVENTORY.md)
│   ├── workflows/*.md              # Definições de workflow (roster oficial: docs/INVENTORY.md)
│   ├── references/*.md             # Docs de referência compartilhados (roster oficial: docs/INVENTORY.md)
│   └── templates/                  # Templates de artefatos de planejamento
├── agents/*.md                     # Definições de agentes (roster oficial: docs/INVENTORY.md)
├── hooks/*.js                      # Hooks Node.js (statusline, guards, monitors, verificação de atualização)
├── hooks/*.sh                      # Hooks shell (estado de sessão, validação de commit, limite de fase)
├── settings.json                   # Registros de hooks
└── VERSION                         # Número da versão instalada
```

Caminhos equivalentes para outros runtimes:

- **OpenCode:** `~/.config/opencode/` global ou `./.opencode/` local
- **Kilo:** `~/.config/kilo/` global ou `./.kilo/` local
- **Gemini CLI:** `~/.gemini/` global ou `./.gemini/` local
- **Codex:** `~/.codex/` global ou `./.codex/` local
- **Copilot:** `~/.copilot/` global ou `./.github/` local
- **Antigravity:** raiz global detectada automaticamente (`~/.gemini/antigravity/`, `~/.gemini/antigravity-ide/`, ou `~/.gemini/antigravity-cli/`) ou `./.agent/` local
- **Cursor:** `~/.cursor/` global ou `./.cursor/` local
- **Windsurf:** `~/.codeium/windsurf/` global ou `./.windsurf/` local
- **Augment Code:** `~/.augment/` global ou `./.augment/` local
- **Trae:** `~/.trae/` global ou `./.trae/` local
- **Qwen Code:** `~/.qwen/` global ou `./.qwen/` local
- **Hermes Agent:** `~/.hermes/` global ou `./.hermes/` local
- **CodeBuddy:** `~/.codebuddy/` global ou `./.codebuddy/` local
- **Cline:** `~/.cline/` global ou `.clinerules` local na raiz do projeto

### Arquivos do Projeto (`.planning/`)

```
.planning/
├── PROJECT.md              # Visão do projeto, restrições, decisões, regras de evolução
├── REQUIREMENTS.md         # Requisitos com escopo (v1/v2/fora do escopo)
├── ROADMAP.md              # Detalhamento de fases com rastreamento de status
├── STATE.md                # Memória viva: posição, decisões, bloqueadores, métricas
├── config.json             # Configuração de workflow
├── MILESTONES.md           # Arquivo de milestones concluídos
├── research/               # Pesquisa de domínio do /gsd-new-project
│   ├── SUMMARY.md
│   ├── STACK.md
│   ├── FEATURES.md
│   ├── ARCHITECTURE.md
│   └── PITFALLS.md
├── codebase/               # Mapeamento de brownfield (do /gsd-map-codebase ou /gsd-onboard)
├── onboarding/             # Resumo de onboarding brownfield (do /gsd-onboard)
│   ├── STACK.md            # Frontmatter YAML carrega `last_mapped_commit`
│   ├── ARCHITECTURE.md     # para o portão de desvio pós-execução (#2003)
│   ├── CONVENTIONS.md
│   ├── CONCERNS.md
│   ├── STRUCTURE.md
│   ├── TESTING.md
│   └── INTEGRATIONS.md
├── phases/
│   └── XX-phase-name/
│       ├── XX-CONTEXT.md       # Preferências do usuário (da discuss-phase)
│       ├── XX-RESEARCH.md      # Pesquisa de ecossistema (da plan-phase)
│       ├── XX-YY-PLAN.md       # Planos de execução
│       ├── XX-YY-SUMMARY.md    # Resultados de execução
│       ├── XX-VERIFICATION.md  # Verificação pós-execução
│       ├── XX-VALIDATION.md    # Mapeamento de cobertura de testes Nyquist
│       ├── XX-UI-SPEC.md       # Contrato de design de UI (da ui-phase)
│       ├── XX-UI-REVIEW.md     # Pontuações de auditoria visual (da ui-review)
│       └── XX-UAT.md           # Resultados de testes de aceitação do usuário
├── quick/                  # Rastreamento de tarefas rápidas
│   └── YYMMDD-xxx-slug/
│       ├── PLAN.md
│       └── SUMMARY.md
├── todos/
│   ├── pending/            # Ideias capturadas
│   └── completed/          # Todos concluídos
├── threads/               # Threads de contexto persistentes (do /gsd-thread)
├── seeds/                 # Ideias prospectivas (do /gsd-capture --seed)
├── debug/                  # Sessões de depuração ativas
│   ├── *.md                # Sessões ativas
│   ├── resolved/           # Sessões arquivadas
│   └── knowledge-base.md   # Aprendizados persistentes de depuração
├── ui-reviews/             # Screenshots do /gsd-ui-review (ignoradas pelo git)
└── continue-here.md        # Handoff de contexto (do pause-work)
```

### Portão de Desvio de Código Base Pós-Execução (#2003)

Após a última onda de commits do `/gsd-execute-phase`, o workflow executa uma
etapa `codebase_drift_gate` não bloqueante (entre `schema_drift_gate` e
`verify_phase_goal`). Ele compara o diff `last_mapped_commit..HEAD`
contra `.planning/codebase/STRUCTURE.md` e conta quatro tipos de
elementos estruturais:

1. Novos diretórios fora dos caminhos mapeados
2. Novas exportações barrel em `(packages|apps)/<name>/src/index.*`
3. Novos arquivos de migração
4. Novos módulos de rota em `routes/` ou `api/`

Se a contagem atingir `workflow.drift_threshold` (padrão 3), o portão
**avisa** (padrão) com o comando `/gsd-map-codebase --paths …` sugerido,
ou **remapeia automaticamente** (`workflow.drift_action = auto-remap`) criando
`gsd-codebase-mapper` com escopo para os caminhos afetados. Qualquer erro na detecção
ou remapeamento é registrado e a fase continua — a detecção de desvio não pode falhar
a verificação.

`last_mapped_commit` fica no frontmatter YAML no topo de cada
arquivo `.planning/codebase/*.md`; `bin/lib/drift.cjs` fornece
os helpers de ida e volta `readMappedCommit` e `writeMappedCommit`.

---

## Arquitetura do Instalador

O instalador (`bin/install.js`, ~10.700 linhas) trata de:

1. **Detecção de runtime** — Prompt interativo ou flags CLI (`--claude`, `--opencode`, `--gemini`, `--kilo`, `--codex`, `--copilot`, `--antigravity`, `--cursor`, `--windsurf`, `--augment`, `--trae`, `--qwen`, `--hermes`, `--codebuddy`, `--cline`, `--all`)
2. **Seleção de local** — Global (`--global`) ou local (`--local`)
3. **Implantação de arquivos** — Copia comandos, skills, workflows, referências, templates, agentes e hooks
4. **Adaptação de runtime** — Transforma o conteúdo de arquivos por runtime:
  - Claude Code: Usa como está
  - OpenCode: Converte comandos/agentes para o formato de comando plano + subagente compatível com OpenCode
  - Kilo: Reutiliza o pipeline de conversão do OpenCode com os caminhos de configuração do Kilo
  - Codex: Gera config TOML + skills a partir de comandos
  - Copilot: Mapeia nomes de ferramentas (Read→read, Bash→execute, etc.)
  - Gemini: Ajusta nomes de eventos de hook (`AfterTool` em vez de `PostToolUse`)
  - Antigravity: Skills em primeiro lugar com equivalentes de modelo do Google
  - Cursor: Skills em primeiro lugar com referências de regras do Cursor
  - Windsurf: Skills em primeiro lugar com referências de regras do Windsurf
  - Trae: Instalação skills-first em `~/.trae` / `./.trae` sem `settings.json` ou integração de hooks
  - Qwen Code: Skills em primeiro lugar com reescritas de caminho e prompt com marca Qwen
  - Hermes Agent: Skills por categoria em `skills/gsd/`
  - CodeBuddy: Skills em primeiro lugar com reescritas de caminho e prompt do CodeBuddy
  - Cline: Escreve `.clinerules` para integração baseada em regras
  - Augment Code: Skills em primeiro lugar com conversão completa de skills e gerenciamento de configuração
5. **Normalização de caminhos** — Substitui caminhos `~/.claude/` por caminhos específicos do runtime
6. **Integração de configurações** — Registra hooks no `settings.json` do runtime
7. **Backup de patches** — Desde a v1.17, faz backup de arquivos modificados localmente em `gsd-local-patches/` para `/gsd-update --reapply`
8. **Rastreamento de manifesto** — Escreve `gsd-file-manifest.json` para desinstalação limpa
9. **Modo de desinstalação** — `--uninstall` remove todos os arquivos, hooks e configurações do GSD

Movimentações de arquivos no momento da instalação, limpeza de artefatos obsoletos, reescritas de configuração e
preservação de dados do usuário são governadas pelo Módulo de Migração do Instalador. Consulte
[Migrações do Instalador](../installer-migrations.md) e
[ADR 0008](../adr/0008-installer-migration-module.md).
O módulo de migração também controla o escaneamento de linha de base inicial condicionado para
instalações legadas, classificando as superfícies de instalação de runtime conhecidas antes que migrações posteriores
removam ou reescrevam qualquer coisa.

O guarda de desvio de plano (`plan_review.source_grounding`) — que verifica referências de símbolos em planos gerados contra o código-fonte ativo antes da execução — é especificado no [ADR 22](../adr/22-plan-drift-guard.md).

### Tratamento de Plataforma

- **Windows:** `windowsHide` em processos filho, proteção EPERM/EACCES em diretórios protegidos, normalização de separador de caminho
- **WSL:** Detecta o Node.js do Windows rodando no WSL e avisa sobre incompatibilidades de caminho
- **Docker/CI:** Suporta a variável de ambiente `CLAUDE_CONFIG_DIR` para locais de diretório de configuração personalizados

---

## Sistema de Hooks

### Arquitetura

```
Motor de Runtime (Claude Code / Gemini CLI)
    │
    ├── evento statusLine ──► gsd-statusline.js
    │   Lê: stdin (JSON de sessão)
    │   Escreve: stdout (status formatado), /tmp/claude-ctx-{session}.json (bridge)
    │
    ├── evento PostToolUse/AfterTool ──► gsd-context-monitor.js
    │   Lê: stdin (JSON de evento de ferramenta), /tmp/claude-ctx-{session}.json (bridge)
    │   Escreve: stdout (hookSpecificOutput com aviso additionalContext)
    │
    └── evento SessionStart ──► gsd-check-update.js
        Lê: arquivo VERSION
        Escreve: ~/.claude/cache/gsd-update-check.json (cria processo em segundo plano)
```

### Limites do Monitor de Contexto


| Contexto Restante | Nível    | Comportamento do Agente                          |
| ----------------- | -------- | ------------------------------------------------ |
| > 35%             | Normal   | Nenhum aviso injetado                            |
| ≤ 35%             | AVISO    | "Evite iniciar trabalho complexo novo"           |
| ≤ 25%             | CRÍTICO  | "Contexto quase esgotado, informe o usuário"     |


Debounce: 5 usos de ferramenta entre avisos repetidos. A escalada de severidade (AVISO→CRÍTICO) contorna o debounce.

### Propriedades de Segurança

- Todos os hooks encapsulam em try/catch, saem silenciosamente em caso de erro
- Guarda de timeout de stdin (3 s) evita travamento em problemas de pipe
- Métricas obsoletas (> 60 s) são ignoradas
- Arquivos bridge ausentes são tratados graciosamente (subagentes, sessões novas)
- O monitor de contexto é consultivo — nunca emite comandos imperativos que substituam as preferências do usuário

### Portão de Legitimidade de Pacotes (v1.42.1)

O pipeline pesquisador → planner → executor inclui um portão de cadeia de suprimentos contra slopsquatting (nomes de pacotes alucinados por IA pré-registrados com scripts pós-instalação maliciosos).

**Modelo de ameaça:** O GSD automatiza o caminho completo de "pesquisador nomeia um pacote" a "executor executa `npm install`". Um nome alucinado que passa pelo `npm view` (provando apenas o registro, não a legitimidade) anteriormente fluía sem ser detectado. ~20% das referências de pacotes geradas por IA são alucinadas; ~43% desses nomes recorrem consistentemente entre prompts, tornando o pré-registro economicamente viável para atacantes.

**Camadas do portão:**

| Camada | Componente | Ação |
|--------|------------|------|
| Pesquisa | `gsd-phase-researcher` | Executa `slopcheck install <pkgs> --json`; escreve tabela `## Package Legitimacy Audit` no RESEARCH.md; remove pacotes `[SLOP]` antes de o RESEARCH.md ser escrito |
| Planejamento | `gsd-planner` | Lê a tabela de Auditoria; insere `checkpoint:human-verify` antes de qualquer tarefa de instalação `[ASSUMED]` ou `[SUS]`; adiciona linha STRIDE `T-{phase}-SC` supply-chain ao `<threat_model>` |
| Execução | `gsd-executor` | REGRA 3 exclui a instalação de pacotes do escopo de correção automática; instalações com falha surgem como checkpoints, nunca substituições silenciosas |

**Integração de proveniência de afirmações:** Nomes de pacotes descobertos via WebSearch são marcados como `[ASSUMED]` (não `[VERIFIED]`) independentemente do resultado do `npm view`. Isso estende o sistema de proveniência `[ASSUMED]` / `[VERIFIED]` / `[CITED]` existente, aplicando a tag de proveniência como um portão rígido no limite de instalação — `[ASSUMED]` sempre gera um `checkpoint:human-verify` no PLAN.md.

**Cobertura de ecossistemas:** O pesquisador usa comandos de verificação específicos de registro — `npm view` (Node), `pip index versions` (Python), `cargo search` (Rust) — em vez de uma única verificação genérica. Isso captura alucinações entre ecossistemas (taxa de ~9% documentada em pesquisa USENIX de 2025).

**Degradação graceful:** Se o `slopcheck` não estiver disponível, cada pacote recomendado é marcado como `[ASSUMED]` e condicionado com um checkpoint. Pesquisa e planejamento prosseguem; o sistema nunca falha definitivamente por dependência de ferramenta ausente.

**Dependência externa:** `slopcheck` (MIT, instalável via pip). Se abandonado, o fallback do portão `[ASSUMED]` mantém a cobertura de checkpoint humano.

---

### Hooks de Segurança (v1.27)

Para uma visão geral conceitual de como as camadas de hook e guarda se encaixam na abordagem de segurança mais ampla, consulte [Modelo de segurança](explanation/security-model.md).

**Prompt Guard** (`gsd-prompt-guard.js`):

- Acionado em Write/Edit para arquivos `.planning/`
- Escaneia o conteúdo em busca de padrões de injeção de prompt (substituição de papel, bypass de instrução, injeção de tag de sistema)
- Apenas consultivo — registra a detecção, não bloqueia
- Padrões são embutidos (subconjunto de `security.cjs`) para independência do hook

**Workflow Guard** (`gsd-workflow-guard.js`):

- Acionado em Write/Edit para arquivos fora de `.planning/`
- Detecta edições fora do contexto de workflow do GSD (sem comando `/gsd-` ativo ou subagente Task)
- Aconselha o uso de `/gsd-quick` ou `/gsd-fast` para alterações rastreadas por estado
- Ativado via `hooks.workflow_guard: true` (padrão: false)

---

## Abstração de Runtime

O GSD suporta múltiplos runtimes de codificação com IA por meio de uma arquitetura unificada de comandos/workflows:

### Matriz de Contrato de Instalação por Runtime

Esta matriz descreve as superfícies de runtime que o instalador materializa hoje.
A propriedade específica de migração e os snapshots de fonte vivem em
[Migrações do Instalador](../installer-migrations.md#runtime-configuration-contract-registry).

| Runtime | Raiz global | Raiz local | Superfície de invocação | Superfície de agente | Configuração e hooks |
| --- | --- | --- | --- | --- | --- |
| Claude Code | `~/.claude` | `./.claude` | `skills/gsd-*/SKILL.md` global; `commands/gsd/*.md` local | `agents/gsd-*.md` | Entradas de hook e statusLine em `settings.json` |
| OpenCode | `~/.config/opencode` | `./.opencode` | `command/gsd-*.md` | `agents/gsd-*.md` | `opencode.json` ou `opencode.jsonc`; sem hooks do GSD |
| Kilo | `~/.config/kilo` | `./.kilo` | `command/gsd-*.md` | `agents/gsd-*.md` | `kilo.json` ou `kilo.jsonc`; sem hooks do GSD |
| Gemini CLI | `~/.gemini` | `./.gemini` | `commands/gsd/*.toml` | `agents/gsd-*.md` | flag de funcionalidade, hooks e statusline em `settings.json` |
| Codex | `~/.codex` | `./.codex` | `skills/gsd-*/SKILL.md` | markdown de origem de agentes mais TOML por agente | `config.toml` `[agents.gsd-*]`, `[features].hooks` (canônico; alias legado `codex_hooks` é reconhecido e migrado no reinstall, #3566) e tabelas de hooks |
| GitHub Copilot | `~/.copilot` | `./.github` | `skills/gsd-*/SKILL.md` e `copilot-instructions.md` | arquivos `.agent.md` | Sem hooks ou statusline do GSD |
| Antigravity | detectado automaticamente: `~/.gemini/antigravity`, `~/.gemini/antigravity-ide`, ou `~/.gemini/antigravity-cli` | `./.agent` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | Entradas de hook `settings.json` no estilo Gemini quando instalado pelo GSD |
| Cursor | `~/.cursor` | `./.cursor` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | Referências de regras em `rules/`; sem hooks do GSD |
| Windsurf | `~/.codeium/windsurf` | `./.windsurf` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | Referências de regras em `rules/`; sem hooks do GSD |
| Augment Code | `~/.augment` | `./.augment` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | Sem hooks ou statusline do GSD |
| Trae | `~/.trae` | `./.trae` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | Referências de regras em `rules/`; sem hooks do GSD |
| Qwen Code | `~/.qwen` | `./.qwen` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | Configurações comuns do GSD e entradas de hook onde suportado |
| Hermes Agent | `~/.hermes` | `./.hermes` | `skills/gsd/DESCRIPTION.md` mais `skills/gsd/gsd-*/SKILL.md` | `agents/gsd-*.md` | Configurações comuns do GSD e entradas de hook onde suportado |
| CodeBuddy | `~/.codebuddy` | `./.codebuddy` | `skills/gsd-*/SKILL.md` | `agents/gsd-*.md` | Configurações comuns do GSD e entradas de hook onde suportado |
| Cline | `~/.cline` | raiz do projeto | `.clinerules` | Somente regras | Sem hooks ou statusline do GSD |

### Fontes do Contrato Upstream

As expectativas de instalação por runtime são verificadas contra documentação primária quando
disponível. O snapshot de fonte atual é 2026-05-11:

- Claude Code: Documentação de comandos slash, configurações, hooks e subagentes da Anthropic.
- OpenCode e Kilo: Documentação de configuração do OpenCode e documentação de subagente customizado do Kilo.
- Gemini CLI e Qwen Code: Documentação de comandos/configuração; a documentação de comandos do Qwen foi atualizada pela última vez em 2026-05-06.
- Codex: Documentação do OpenAI Codex e `config-schema.json`; o instalador também carrega compatibilidade com o Codex 0.124.0 para o formato de tabela de agentes.
- Copilot, Cursor, Cline, Augment, Hermes e CodeBuddy: Documentação do fornecedor para instruções customizadas, regras, skills ou configuração.
- Antigravity, Windsurf e Trae: Linhas com fontes limitadas. O instalador documenta os shims de compatibilidade atuais, e as migrações devem atualizar essas fontes antes de reescrever sua configuração.

### Pontos de Abstração

1. **Mapeamento de nomes de ferramentas** — Cada runtime tem seus próprios nomes de ferramentas (ex.: `Bash` do Claude → `execute` do Copilot)
2. **Nomes de eventos de hook** — Claude usa `PostToolUse`, Gemini usa `AfterTool`
3. **Frontmatter de agente** — Cada runtime tem seu próprio formato de definição de agente
4. **Convenções de caminho** — Cada runtime armazena a configuração em diretórios diferentes
5. **Referências de modelo** — O perfil `inherit` permite que o GSD adie para a seleção de modelo do runtime

O instalador trata de toda a tradução no momento da instalação. Workflows e agentes são escritos no formato nativo do Claude Code e transformados durante a implantação.

---

## Relacionados

- [Orquestração multi-agente](explanation/multi-agent-orchestration.md)
- [Modelo de segurança](explanation/security-model.md)
- [Ferramentas CLI](CLI-TOOLS.md)
- [Índice de documentação](README.md)
