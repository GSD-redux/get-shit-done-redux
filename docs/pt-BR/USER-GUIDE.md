# Guia do Usuário GSD

Um guia narrativo complementar ao GSD Core — comece aqui para se orientar e siga os links para a documentação dedicada.

> **A documentação do GSD Core é organizada seguindo o modelo [Diataxis](https://diataxis.fr).**
> Navegue por objetivo: [Tutoriais](README.md#tutorials) · [Guias práticos](README.md#how-to-guides) · [Referência](README.md#reference) · [Explicação](README.md#explanation) · [Índice da documentação](README.md)

---

## Sumário

- [Formas do slash-command](#formas-do-slash-command-hífen-vs-dois-pontos)
- [Introdução ao roteamento de namespace](#introdução-ao-roteamento-de-namespace-gsdnamespace-v140)
- [Visão geral do ciclo de vida do projeto](#visão-geral-do-ciclo-de-vida-do-projeto)
- [Diagramas de fluxo](#diagramas-de-fluxo)
- [Contrato de design de UI](#contrato-de-design-de-ui)
- [Spikes e Esboços](#spikes-e-esboços)
- [Backlog e Threads](#backlog-e-threads)
- [Workstreams e Workspaces](#workstreams-e-workspaces)
- [Segurança](#segurança)
- [Exemplos de uso](#exemplos-de-uso)
- [Solução de problemas](#solução-de-problemas)
- [Referência rápida de recuperação](#referência-rápida-de-recuperação)
- [Estrutura de arquivos do projeto](#estrutura-de-arquivos-do-projeto)
- [Relacionados](#relacionados)

Para conduzir o GSD diretamente a partir de uma issue do GitHub / Linear / Jira, consulte o guia
[Orquestração orientada por issues](issue-driven-orchestration.md) — uma
receita que mapeia issues do rastreador ao ciclo workspace → discuss → plan →
execute → verify → review → ship usando as primitivas GSD existentes.

---

## Formas do slash-command (hífen vs dois-pontos)

O GSD fornece **o mesmo conjunto de habilidades** para todos os runtimes suportados, mas dois estilos de barra são utilizados:

- **Forma com hífen** — `/gsd-command-name` — usada por Claude Code, Copilot, OpenCode, Kilo, Cursor, Windsurf, Augment, Antigravity e Trae.
- **Forma com dois-pontos** — `/gsd:command-name` — usada **exclusivamente pelo Gemini CLI**. O Gemini coloca todos os comandos de cada plugin sob o ID do plugin, portanto o instalador reescreve todas as referências no corpo do texto e nos arquivos de comando para a forma com dois-pontos durante a instalação com `--gemini`.

Você não precisa escolher — o instalador grava a forma correta no diretório de comandos de cada runtime que você especificar. Ao seguir um guia passo a passo num terminal Gemini, substitua o hífen após `gsd` por dois-pontos ao ler cada slash-command.

## Introdução ao roteamento de namespace (`gsd:<namespace>`, v1.40)

A v1.40 traz seis **meta-habilidades de namespace** como pontos de entrada de primeiro estágio para roteamento hierárquico — elas mantêm baixo o custo de tokens da listagem antecipada de habilidades (~120 tokens para 6 roteadores versus ~2.150 para uma listagem plana de 86 habilidades), enquanto cada sub-habilidade concreta permanece diretamente invocável. O corpo de cada roteador de namespace contém uma tabela de roteamento que mapeia sua intenção à sub-habilidade concreta correta.

| Namespace | Roteador | Encaminha para |
|-----------|--------|-----------|
| Pipeline de fases | `/gsd-workflow` | discuss / plan / execute / verify / phase / progress |
| Ciclo de vida do projeto | `/gsd-project` | milestones, audits, summary |
| Gates de qualidade | `/gsd-quality` | code review, debug, audit, security, eval, ui |
| Inteligência de codebase | `/gsd-context` | map, graphify, docs, learnings |
| Gerenciamento | `/gsd-manage` | config, workspace, workstreams, thread, update, ship, inbox |
| Exploração e captura | `/gsd-ideate` | explore, sketch, spike, spec, capture |

Você quase nunca precisa digitar um roteador de namespace diretamente. Seu valor está na camada de roteamento que o modelo usa para descobrir a sub-habilidade correta — eles existem para que o prompt do sistema possa listar 6 entradas em vez de 86. Se você já conhece o comando concreto (ex.: `/gsd-plan-phase`), invoque-o diretamente.

---

## Visão geral do ciclo de vida do projeto

O ciclo central do GSD é: **discuss → plan → execute → verify → ship**, repetido por fase. O guia passo a passo completo — incluindo exemplos de saída, quais arquivos são criados e todas as flags em uso — está no tutorial dedicado.

Consulte [Seu primeiro projeto](tutorials/your-first-project.md).

Para integrar uma base de código existente antes de iniciar um novo milestone, consulte [Integrando uma base de código existente](tutorials/onboarding-an-existing-codebase.md).

**Flags relevantes em resumo:**

| Flag | Comando | Quando usar |
| ---- | ------- | ----------- |
| `--auto` | `/gsd-new-project` | Pular perguntas interativas, ingerir de um arquivo PRD |
| `--research` | `/gsd-quick` | Adicionar um agente de pesquisa a uma tarefa avulsa |
| `--validate` | `/gsd-quick` | Adicionar verificação de plano e verificação pós-execução |
| `--chain` | `/gsd-discuss-phase` | Encadear automaticamente discuss → plan → execute sem pausas |
| `--skip-research` | `/gsd-plan-phase` | Pular agentes de pesquisa quando o domínio já é familiar |
| `--draft` | `/gsd-ship` | Criar um PR como rascunho em vez de pronto para revisão |

Para a referência completa de comandos com todas as flags, consulte [`docs/COMMANDS.md`](COMMANDS.md). Para opções de configuração (perfis de modelo, agentes de workflow, branching git), consulte [`docs/CONFIGURATION.md`](CONFIGURATION.md).

---

## Diagramas de fluxo

### Ciclo de vida completo do projeto

```text
  ┌──────────────────────────────────────────────────┐
  │                   NEW PROJECT                    │
  │  /gsd-new-project                                │
  │  Questions -> Research -> Requirements -> Roadmap│
  └─────────────────────────┬────────────────────────┘
                            │
             ┌──────────────▼─────────────┐
             │      FOR EACH PHASE:       │
             │                            │
             │  ┌────────────────────┐    │
             │  │ /gsd-discuss-phase │    │  <- Lock in preferences
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-ui-phase      │    │  <- Design contract (frontend)
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-plan-phase    │    │  <- Research + Plan + Verify
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-execute-phase │    │  <- Parallel execution
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-verify-work   │    │  <- Manual UAT
             │  └──────────┬─────────┘    │
             │             │              │
             │  ┌──────────▼─────────┐    │
             │  │ /gsd-ship          │    │  <- Create PR (optional)
             │  └──────────┬─────────┘    │
             │             │              │
             │     Next Phase?────────────┘
             │             │ No
             └─────────────┼──────────────┘
                            │
            ┌───────────────▼──────────────┐
            │  /gsd-audit-milestone        │
            │  /gsd-complete-milestone     │
            └───────────────┬──────────────┘
                            │
                   Another milestone?
                       │          │
                      Yes         No -> Done!
                       │
               ┌───────▼──────────────┐
               │  /gsd-new-milestone  │
               └──────────────────────┘
```

### Coordenação de agentes de planejamento

```text
  /gsd-plan-phase N
         │
         ├── Phase Researcher (x4 parallel)
         │     ├── Stack researcher
         │     ├── Features researcher
         │     ├── Architecture researcher
         │     └── Pitfalls researcher
         │           │
         │     ┌──────▼──────┐
         │     │ RESEARCH.md │
         │     └──────┬──────┘
         │            │
         │     ┌──────▼──────┐
         │     │   Planner   │  <- Reads PROJECT.md, REQUIREMENTS.md,
         │     │             │     CONTEXT.md, RESEARCH.md
         │     └──────┬──────┘
         │            │
         │     ┌──────▼───────────┐     ┌────────┐
         │     │   Plan Checker   │────>│ PASS?  │
         │     └──────────────────┘     └───┬────┘
         │                                  │
         │                             Yes  │  No
         │                              │   │   │
         │                              │   └───┘  (loop, up to 3x)
         │                              │
         │                        ┌─────▼──────┐
         │                        │ PLAN files │
         │                        └────────────┘
         └── Done
```

### Arquitetura de validação (Camada Nyquist)

Durante a pesquisa da fase de planejamento, o GSD mapeia a cobertura de testes automatizados para cada requisito da fase antes que qualquer código seja escrito. O pesquisador detecta sua infraestrutura de testes existente, mapeia cada requisito para um comando de teste específico e identifica qualquer scaffolding de testes que deve ser criado antes do início da implementação (tarefas da Wave 0). O verificador de planos impõe isso como uma 8ª dimensão de verificação: planos em que as tarefas carecem de comandos de verificação automatizados não serão aprovados.

**Saída:** `{phase}-VALIDATION.md` — o contrato de feedback para a fase.

**Desativar:** Defina `workflow.nyquist_validation: false` em `/gsd-settings` para fases de prototipagem rápida onde a infraestrutura de testes não é o foco.

### Validação retroativa (`/gsd-validate-phase`)

Para fases executadas antes de a validação Nyquist existir, ou para bases de código existentes com apenas suítes de teste tradicionais, audite retroativamente e preencha as lacunas de cobertura:

```text
  /gsd-validate-phase N
         |
         +-- Detect state (VALIDATION.md exists? SUMMARY.md exists?)
         |
         +-- Discover: scan implementation, map requirements to tests
         |
         +-- Analyze gaps: which requirements lack automated verification?
         |
         +-- Present gap plan for approval
         |
         +-- Spawn auditor: generate tests, run, debug (max 3 attempts)
         |
         +-- Update VALIDATION.md
               |
               +-- COMPLIANT -> all requirements have automated checks
               +-- PARTIAL -> some gaps escalated to manual-only
```

O auditor nunca modifica o código de implementação — apenas arquivos de teste e VALIDATION.md. Se um teste revelar um bug de implementação, ele é sinalizado como escalonamento para que você o resolva.

### Modo de discussão por suposições

Por padrão, `/gsd-discuss-phase` faz perguntas abertas sobre suas preferências de implementação. O modo de suposições inverte isso: o GSD lê sua base de código primeiro, levanta suposições estruturadas sobre como construiria a fase e solicita apenas correções.

**Ativar:** Defina `workflow.discuss_mode` como `'assumptions'` via `/gsd-settings`.

Consulte [docs/workflow-discuss-mode.md](workflow-discuss-mode.md) para a referência completa do modo discuss.

### Gates de cobertura de decisões

A fase de discussão captura decisões de implementação no CONTEXT.md sob um bloco `<decisions>` como marcadores numerados (`- **D-01:** …`). Dois gates garantem que essas decisões sobrevivam até os planos e o código entregue.

**Gate de tradução na fase de planejamento (bloqueante).** Após o planejamento, o GSD se recusa a marcar a fase como planejada até que cada decisão rastreável apareça em pelo menos um `must_haves`, `truths` ou corpo de um plano.

**Gate de validação na fase de verificação (não bloqueante).** Durante a verificação, o GSD pesquisa planos, SUMMARY.md, arquivos modificados e mensagens de commit recentes para cada decisão rastreável. Ausências são registradas no VERIFICATION.md como uma seção de aviso; o status de verificação permanece inalterado.

**Excluir uma decisão dos gates.** Mova-a para o cabeçalho `### Claude's Discretion` dentro de `<decisions>`, ou marque-a: `- **D-08 [informational]:** …`, `- **D-09 [folded]:** …`, `- **D-10 [deferred]:** …`.

**Desativar os gates.** Defina `workflow.context_coverage_gate: false` em `.planning/config.json` (ou via `/gsd-settings`). O padrão é `true`.

### Coordenação de waves de execução

```text
  /gsd-execute-phase N
         │
         ├── Analyze plan dependencies
         │
         ├── Wave 1 (independent plans):
         │     ├── Executor A (fresh 200K context) -> commit
         │     └── Executor B (fresh 200K context) -> commit
         │
         ├── Wave 2 (depends on Wave 1):
         │     └── Executor C (fresh 200K context) -> commit
         │
         └── Verifier
               ├── Check codebase against phase goals
               ├── Test quality audit (disabled tests, circular patterns, assertion strength)
               │
               ├── PASS -> VERIFICATION.md (success)
               └── FAIL -> Issues logged for /gsd-verify-work
```

---

## Contrato de design de UI

Frontends gerados por IA são visualmente inconsistentes não porque o Claude Code seja ruim em UI, mas porque não existia um contrato de design antes da execução. `/gsd-ui-phase` bloqueia o contrato de design antes do planejamento; `/gsd-ui-review` audita o resultado após a execução.

Para o fluxo completo, configuração, inicialização do shadcn e o gate de segurança do registry, consulte [Projetar uma fase de UI](how-to/design-a-ui-phase.md).

**Referência rápida:**

| Comando              | Descrição                                                     |
| -------------------- | ------------------------------------------------------------- |
| `/gsd-ui-phase [N]`  | Gerar contrato de design UI-SPEC.md para uma fase de frontend |
| `/gsd-ui-review [N]` | Auditoria visual retroativa em 6 pilares da UI implementada   |

| Configuração              | Padrão | Descrição                                                                     |
| ------------------------- | ------- | ----------------------------------------------------------------------------- |
| `workflow.ui_phase`       | `true`  | Gerar contratos de design de UI para fases de frontend                        |
| `workflow.ui_safety_gate` | `true`  | A fase de planejamento solicita executar /gsd-ui-phase para fases de frontend |

---

## Spikes e Esboços

Use `/gsd-spike` para validar a viabilidade técnica antes do planejamento e `/gsd-sketch` para explorar a direção visual antes de projetar. Ambos armazenam artefatos em `.planning/` e se integram ao sistema de habilidades do projeto por meio de seus companions de encerramento.

Para o fluxo completo e o diagrama de fluxo, consulte [Spike e esboço](how-to/spike-and-sketch.md).

**Fluxo típico:**

```bash
/gsd-spike "SSE vs WebSocket"     # Validate the approach
/gsd-spike --wrap-up              # Package learnings

/gsd-sketch "real-time feed UI"   # Explore the design
/gsd-sketch --wrap-up             # Package decisions

/gsd-discuss-phase N              # Lock in preferences (now informed by spike + sketch)
/gsd-plan-phase N                 # Plan with confidence
```

---

## Backlog e Threads

### Estacionamento de backlog

Ideias que ainda não estão prontas para planejamento ativo vão para o backlog usando a numeração 999.x, mantendo-as fora da sequência de fases ativas.

```bash
/gsd-capture --backlog "GraphQL API layer"     # Creates 999.1-graphql-api-layer/
/gsd-capture --backlog "Mobile responsive"     # Creates 999.2-mobile-responsive/
```

Os itens de backlog recebem diretórios de fase completos, portanto você pode usar `/gsd-discuss-phase 999.1` para explorar uma ideia mais a fundo ou `/gsd-plan-phase 999.1` quando ela estiver pronta.

**Revisar e promover** com `/gsd-review-backlog` — ele exibe todos os itens do backlog e permite promovê-los (mover para a sequência ativa), mantê-los (deixar no backlog) ou removê-los (excluir).

### Seeds

Seeds são ideias voltadas para o futuro com condições de acionamento. Ao contrário dos itens de backlog, as seeds aparecem automaticamente quando o milestone certo chega.

```bash
/gsd-capture --seed "Add real-time collab when WebSocket infra is in place"
```

`/gsd-new-milestone` verifica todas as seeds e apresenta correspondências. **Armazenamento:** `.planning/seeds/SEED-NNN-slug.md`

### Threads de contexto persistentes

Threads são armazenamentos de conhecimento leves entre sessões para trabalhos que abrangem múltiplas sessões mas não pertencem a nenhuma fase específica.

```bash
/gsd-thread                              # List all threads
/gsd-thread fix-deploy-key-auth          # Resume existing thread
/gsd-thread "Investigate TCP timeout"    # Create new thread
```

As threads podem ser promovidas a fases (`/gsd-phase`) ou itens de backlog (`/gsd-capture --backlog`) quando amadurecerem. **Armazenamento:** `.planning/threads/{slug}.md`

---

## Workstreams e Workspaces

Workstreams e workspaces fornecem isolamento, mas em níveis diferentes.

**Workstreams** compartilham a mesma base de código e histórico git, mas isolam artefatos de planejamento — mais leves, bons para trabalhar em múltiplas áreas de milestone simultaneamente. Consulte [Trabalhar em paralelo com workstreams](how-to/work-in-parallel-with-workstreams.md).

**Workspaces** criam worktrees de repositório separados com seus próprios `.planning/` — mais pesados, para isolamento de feature branch ou multi-repositório. Consulte [Isolar trabalho com workspaces](how-to/isolate-work-with-workspaces.md).

| Comando                            | Propósito                                                     |
| ---------------------------------- | ------------------------------------------------------------- |
| `/gsd-workstreams create <name>`   | Criar um novo workstream com estado de planejamento isolado   |
| `/gsd-workstreams switch <name>`   | Alternar contexto ativo para um workstream diferente          |
| `/gsd-workstreams list`            | Exibir todos os workstreams e qual está ativo                 |
| `/gsd-workstreams complete <name>` | Marcar um workstream como concluído e arquivar seu estado     |

```bash
# Workspace example — feature branch isolation
/gsd-workspace --new --name feature-b --repos .
cd ~/gsd-workspaces/feature-b
/gsd-new-project

/gsd-workspace --list
/gsd-workspace --remove feature-b
```

---

## Segurança

### Defesa em profundidade (v1.27)

O GSD gera arquivos markdown que se tornam prompts de sistema de LLM. Isso significa que qualquer texto controlado pelo usuário que flua para artefatos de planejamento é um vetor potencial de injeção indireta de prompt. A v1.27 introduziu endurecimento centralizado de segurança:

**Prevenção de Path Traversal:** Todos os caminhos de arquivo fornecidos pelo usuário (`--text-file`, `--prd`) são validados para resolver dentro do diretório do projeto. A resolução de symlinks macOS `/var` → `/private/var` é tratada.

**Detecção de Injeção de Prompt:** O módulo `security.cjs` verifica padrões de injeção conhecidos no texto fornecido pelo usuário antes de entrar nos artefatos de planejamento.

**Hooks de runtime:**

- `gsd-prompt-guard.js` — Verifica chamadas Write/Edit para `.planning/` em busca de padrões de injeção (sempre ativo, somente consultivo)
- `gsd-workflow-guard.js` — Avisa sobre edições de arquivos fora do contexto do workflow GSD (opt-in via `hooks.workflow_guard`)

**Scanner de CI:** `prompt-injection-scan.security.test.cjs` verifica todos os arquivos de agentes, workflows e comandos em busca de vetores de injeção incorporados.

---

### Gate de legitimidade de pacotes (v1.42.1)

Ferramentas de codificação com IA alucinam nomes de pacotes. Atacantes pré-registram esses nomes no npm, PyPI e crates.io com scripts maliciosos de pós-instalação — uma técnica chamada *slopsquatting*. A v1.42.1 adiciona um gate de três camadas que interrompe isso antes de chegar ao seu shell.

**No RESEARCH.md** — cada fase que recomenda pacotes externos inclui uma tabela `## Package Legitimacy Audit`:

```markdown
## Package Legitimacy Audit

| Package | Registry | Age | Downloads | Source Repo | slopcheck | Disposition |
|---------|----------|-----|-----------|-------------|-----------|-------------|
| express | npm | 13 yrs | 100M+/wk | github.com/expressjs/express | [OK] | Approved |
| some-new-util | npm | 3 days | 47 | none | [SLOP] | REMOVED |
| api-bridge | npm | 6 mo | 1.2k/wk | github.com/user/api-bridge | [SUS] | Flagged |
```

Pacotes com `[SLOP]` são removidos do RESEARCH.md inteiramente e nunca chegam ao planejador.

**No PLAN.md** — pacotes com `[SUS]` ou `[ASSUMED]` acionam uma tarefa `checkpoint:human-verify` antes da instalação.

**Durante a execução** — se uma instalação falhar, o executor apresenta um checkpoint e para em vez de tentar silenciosamente uma alternativa.

**Veredictos do slopcheck:**

| Veredicto | Significado | Ação do GSD |
|---------|---------|------------|
| `[OK]` | Passa em todas as verificações de legitimidade | Prossegue — nenhum checkpoint adicionado |
| `[SUS]` | Sinais suspeitos | Sinalizado; o planejador adiciona `checkpoint:human-verify` |
| `[SLOP]` | Alucinação de alta confiança | Removido do RESEARCH.md; nunca chega ao planejador |

Para instalar o slopcheck manualmente:

```bash
pip install slopcheck
# verify: slopcheck install express --json
```

---

## Workflow de revisão de código

Após executar uma fase, execute uma revisão de código estruturada antes do UAT. Consulte [Configurar revisão cross-AI](how-to/set-up-cross-ai-review.md) para o fluxo completo.

```bash
/gsd-code-review 3               # Review all changed files in phase 3
/gsd-code-review 3 --depth=deep  # Deep cross-file review
/gsd-code-review 3 --fix         # Fix Critical + Warning findings atomically
/gsd-code-review 3 --fix --auto  # Fix and re-review until clean (max 3 iterations)
/gsd-audit-fix                   # Audit + classify + fix (medium+ severity, max 5)
```

A etapa de revisão se encaixa após a execução e antes do UAT:

```text
/gsd-execute-phase N  ->  /gsd-code-review N  ->  /gsd-code-review N --fix  ->  /gsd-verify-work N
```

---

## Referência de comandos e configuração

- **Referência de comandos:** consulte [`docs/COMMANDS.md`](COMMANDS.md) para flags, subcomandos e exemplos de cada comando estável.
- **Referência de configuração:** consulte [`docs/CONFIGURATION.md`](CONFIGURATION.md) para o esquema completo do `config.json`, tabela de perfis de modelo, estratégias de branching git e configurações de segurança.
- **Modo Discuss:** consulte [`docs/workflow-discuss-mode.md`](workflow-discuss-mode.md) para o modo entrevista vs suposições.

---

## Exemplos de uso

### Novo projeto (ciclo completo)

```bash
claude --dangerously-skip-permissions
/gsd-new-project            # Answer questions, configure, approve roadmap
/clear
/gsd-discuss-phase 1        # Lock in your preferences
/gsd-ui-phase 1             # Design contract (frontend phases)
/gsd-plan-phase 1           # Research + plan + verify
/gsd-execute-phase 1        # Parallel execution
/gsd-verify-work 1          # Manual UAT
/gsd-ship 1                 # Create PR from verified work
/gsd-ui-review 1            # Visual audit (frontend phases)
/clear
/gsd-progress --next                   # Auto-detect and run next step
...
/gsd-audit-milestone        # Check everything shipped
/gsd-complete-milestone     # Archive, tag, done
/gsd-pause-work --report         # Generate session summary
```

### Novo projeto a partir de um documento existente

```bash
/gsd-new-project --auto @prd.md   # Auto-runs research/requirements/roadmap from your doc
/clear
/gsd-discuss-phase 1               # Normal flow from here
```

### Base de código existente

```bash
/gsd-onboard                # Safely map, ingest docs, and initialize planning
# Follow printed handoff commands, then rerun /gsd-onboard
# (normal phase workflow from here)
```

**Detecção de drift pós-execução (#2003).** Após cada `/gsd-execute-phase`, o GSD verifica se a fase introduziu mudanças estruturais suficientes para tornar `.planning/codebase/STRUCTURE.md` desatualizado. Altere o comportamento com:

```bash
/gsd-settings workflow.drift_action auto-remap       # remap automatically
/gsd-settings workflow.drift_threshold 5             # tune sensitivity
```

### Proteção contra drift de plano

**Ativada por padrão.** O protetor de drift de plano (`plan_review.source_grounding: true`) é executado durante a revisão do plano e verifica se cada símbolo citado nos seus planos — decorators, classes, funções, flags CLI — realmente existe na sua árvore de código-fonte no momento da revisão. Isso detecta nomes alucinados antes que qualquer agente de execução seja executado.

**O que detecta:**

- Funções referenciadas em uma etapa de PLAN.md que não existem no código-fonte
- Nomes de classes ou decorators que foram renomeados ou removidos desde que o plano foi escrito
- Flags CLI documentadas em um plano que não estão definidas no analisador de argumentos
- Caminhos de módulo citados em etapas de implementação que não resolvem para nenhum arquivo

**Comportamento de needs-acknowledgement.** Quando o protetor encontra um símbolo ausente, ele emite um aviso de needs-acknowledgement na saída da revisão do plano em vez de bloquear permanentemente. Você pode reconhecer e prosseguir (o símbolo pode ser intencionalmente novo) ou solicitar uma revisão do plano. O protetor não rejeita planos automaticamente — ele apresenta sinais para decisão humana.

**Funciona sem intel.** Por padrão, o protetor usa `grep`/`ripgrep` para pesquisar arquivos de código-fonte — não requer pré-indexação. Se você executou `/gsd:map-codebase` com `intel.enabled: true`, defina `plan_review.source_grounding_authority: intel` para usar o índice pré-construído `api-map.json` mais rápido.

```bash
# Enable/disable (default: on)
/gsd-settings plan_review.source_grounding true
/gsd-settings plan_review.source_grounding false

# Switch resolver authority
/gsd-settings plan_review.source_grounding_authority grep   # live grep (default)
/gsd-settings plan_review.source_grounding_authority intel  # pre-indexed api-map.json
```

Alterne na configuração do projeto (`/gsd:new-project` pergunta durante as preferências de workflow) ou a qualquer momento via `/gsd:settings` (seção Planning → Drift Guard).

### Correção rápida de bug

```bash
/gsd-quick
> "Fix the login button not responding on mobile Safari"
```

### Retomando após uma pausa

```bash
/gsd-progress               # See where you left off and what's next
# or
/gsd-resume-work            # Full context restoration from last session
```

### Preparando para um release

```bash
/gsd-audit-milestone        # Check requirements coverage, detect stubs
/gsd-complete-milestone     # Archive, tag, done
```

### Predefinições de velocidade vs qualidade

| Cenário               | Modo          | Granularidade | Perfil     | Pesquisa | Verificação de plano | Verificador |
| --------------------- | ------------- | ------------- | ---------- | -------- | -------------------- | ----------- |
| Prototipagem          | `yolo`        | `coarse`      | `budget`   | off      | off                  | off         |
| Desenvolvimento normal | `interactive` | `standard`    | `balanced` | on       | on                   | on          |
| Produção              | `interactive` | `fine`        | `quality`  | on       | on                   | on          |

**Pulando a fase discuss no modo autônomo:** Ao executar no modo `yolo`, defina `workflow.skip_discuss: true` via `/gsd-settings`.

### Mudanças de escopo no meio do milestone

```bash
/gsd-phase                  # Append a new phase to the roadmap (default mode)
/gsd-phase --insert 3       # Insert urgent work between phases 3 and 4
/gsd-phase --remove 7       # Descope phase 7 and renumber
/gsd-phase --edit 4         # Edit any field of phase 4 in place
```

---

## Solução de problemas

Para um guia abrangente de solução de problemas, consulte [Recuperar e solucionar problemas](how-to/recover-and-troubleshoot.md). Os problemas mais comuns estão resumidos abaixo.

### CLI programática (`gsd-tools query` vs `gsd-tools.cjs`)

Para automação, prefira **`gsd-tools query`** com um subcomando registrado (consulte [CLI-TOOLS.md — SDK e acesso programático](CLI-TOOLS.md#sdk-and-programmatic-access) e QUERY-HANDLERS.md). O CLI legado `node $HOME/.claude/gsd-core/bin/gsd-tools.cjs` continua sendo suportado.

### STATE.md fora de sincronia

```bash
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state validate          # Detect drift
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state sync --verify     # Preview changes
node "$HOME/.claude/gsd-core/bin/gsd-tools.cjs" state sync              # Reconstruct STATE.md
```

### Um comando parece congelado após "Spawning..."

Os subagentes do GSD rodam em uma janela de contexto separada — seu trabalho fica invisível para a sessão pai enquanto está em andamento. Não interrompa a sessão. Aguarde o resultado; agentes de pesquisa e planejamento rotineiramente levam de 1 a 5 minutos.

### Degradação de contexto durante sessões longas

Limpe sua janela de contexto entre os principais comandos: `/clear` no Claude Code. O GSD foi projetado em torno de contextos frescos — cada subagente recebe uma janela limpa de 200K. Use `/gsd-resume-work` ou `/gsd-progress` para restaurar o estado após limpar.

### Planos parecem errados ou desalinhados

Execute `/gsd-discuss-phase [N]` antes do planejamento. A maioria dos problemas de qualidade de plano ocorre porque o Claude faz suposições que o `CONTEXT.md` teria prevenido.

### A execução falha ou produz stubs

Verifique se o plano não era ambicioso demais. Os planos devem ter no máximo 2 a 3 tarefas. Replaneje com um escopo menor.

### Perdeu o controle de onde está

Execute `/gsd-progress`. Ele lê todos os arquivos de estado e informa exatamente onde você está e o que fazer a seguir.

### Custos de modelo muito altos

Mude para o perfil budget: `/gsd-config --profile budget`. Desative os agentes de pesquisa e verificação de plano via `/gsd-settings` se o domínio for familiar.

### Ajuste de custo de modelo por fase (`models`) — adicionado na v1.40

Adicione um bloco `models` ao `.planning/config.json`:

```json
{
  "model_profile": "balanced",
  "models": {
    "planning": "opus",
    "discuss": "opus",
    "research": "sonnet",
    "execution": "opus",
    "verification": "sonnet",
    "completion": "sonnet"
  }
}
```

Precisa de uma exceção por agente? Adicione `model_overrides` junto — ele prevalece sobre `models`:

```json
{
  "models": { "research": "sonnet" },
  "model_overrides": {
    "gsd-codebase-mapper": "haiku"
  }
}
```

Para a tabela de mapeamento completa e as regras de precedência de resolução, consulte [Modelos por tipo de fase](CONFIGURATION.md#per-phase-type-models-models--added-in-v140).

### Barato por padrão com `dynamic_routing` — adicionado na v1.40

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

Para o mapeamento completo de agente → tier, consulte [Roteamento dinâmico](CONFIGURATION.md#dynamic-routing-with-failure-tier-escalation-dynamic_routing--added-in-v140).

### Reduza servidores MCP para diminuir o custo por turno

Antes de ajustar `model_profile` ou `models.<phase_type>`, audite quais **servidores MCP** seu harness tem habilitados. Cada servidor MCP habilitado injeta seu esquema de ferramentas em cada turno — servidores pesados podem custar mais de 20k tokens cada.

Esta é uma **configuração do harness**, não do GSD. O toggle fica em `.claude/settings.json`:

```json
{
  "enabledMcpjsonServers": ["context7"],
  "disabledMcpjsonServers": ["playwright", "mac-tools"]
}
```

Auditoria rápida antes de uma fase longa:

- Alguma ferramenta de browser/playwright está habilitada quando esta fase não tem trabalho de UI?
- Alguma ferramenta específica de plataforma está habilitada quando não é necessária?
- Algum MCP específico de projeto de outro projeto ainda está habilitado aqui?

Cada servidor desabilitado remove seu esquema de cada turno subsequente. Reduzir MCPs **compõe** com o ajuste de `model_profile` — ambas as alavancas são aditivas, e as economias de MCP aparecem imediatamente em cada subagente que o orquestrador gera.

Para a auditoria completa, referência do harness e a nota de composição com `model_profile`, consulte [Custo de esquema de ferramentas MCP](../../gsd-core/references/context-budget.md#mcp-tool-schema-cost-harness-concern) na referência `context-budget.md` incluída.

### Usando runtimes não-Claude (Codex, OpenCode, Gemini CLI, Kilo)

> **Versão mínima suportada do Codex CLI: `0.130.0`** (issue [#3562](https://github.com/open-gsd/gsd-core/issues/3562)).

Se você instalou o GSD para um runtime não-Claude, o instalador já configurou a resolução de modelo. Nenhuma configuração manual é necessária — `resolve_model_ids: "omit"` é definido automaticamente, o que informa ao GSD para pular a resolução de ID de modelo Anthropic e deixar o runtime escolher seu próprio modelo padrão.

Para atribuir diferentes modelos em um runtime não-Claude:

```json
{
  "resolve_model_ids": "omit",
  "model_overrides": {
    "gsd-planner": "o3",
    "gsd-executor": "o4-mini",
    "gsd-debugger": "o3"
  }
}
```

#### Mudando de Claude para Codex com uma alteração de configuração (#2517)

```json
{
  "runtime": "codex",
  "model_profile": "balanced"
}
```

Consulte [Perfis cientes de runtime](CONFIGURATION.md#runtime-aware-profiles-2517).

### Instalação manual / configuração sem Node.js

Se você não puder executar o instalador do GSD, não poderá usar os arquivos de origem em `agents/` diretamente — eles estão no formato nativo de frontmatter do Claude Code. Para o OpenCode, são necessárias duas transformações:

| Campo | Formato fonte GSD | Formato válido para OpenCode | Ação |
|---|---|---|---|
| `tools:` | `Read, Bash, Grep` (string com vírgula) | Não é um campo frontmatter | Remover a linha `tools:` inteiramente |
| `color:` | Nome de cor CSS simples | Nome hex ou semântico OpenCode | Converter para hex ou remover |

**Alternativa:** execute o instalador em qualquer máquina com Node.js:

```bash
npx @opengsd/gsd-core@latest --opencode --global
```

### Instalando para o Cline

```bash
npx @opengsd/gsd-core --cline --global   # applies to all projects
npx @opengsd/gsd-core --cline --local    # this project only
```

### Instalando para o CodeBuddy

```bash
npx @opengsd/gsd-core --codebuddy --global
```

### Instalando para o Qwen Code

```bash
npx @opengsd/gsd-core --qwen --global
```

### Instalando para edições de pré-lançamento

Defina a variável de ambiente `*_CONFIG_DIR` do runtime para o diretório de pré-lançamento antes de executar o instalador:

```bash
WINDSURF_CONFIG_DIR=~/.codeium/windsurf-next npx @opengsd/gsd-core@latest --windsurf --global
```

**Referência de variáveis de ambiente para runtimes suportados:**

| Runtime | Padrão estável | Variável de ambiente para substituição |
|---|---|---|
| Claude Code | `~/.claude` | `CLAUDE_CONFIG_DIR` |
| Gemini CLI | `~/.gemini` | `GEMINI_CONFIG_DIR` |
| OpenCode | `XDG_CONFIG_HOME/opencode` | `OPENCODE_CONFIG_DIR` |
| Codex | (per Codex CLI) | `--config-dir` flag |
| Copilot | `~/.copilot` | `COPILOT_CONFIG_DIR` |
| Cursor | `~/.cursor` | `CURSOR_CONFIG_DIR` |
| Windsurf | `~/.codeium/windsurf` | `WINDSURF_CONFIG_DIR` |
| Antigravity | auto-detected | `ANTIGRAVITY_CONFIG_DIR` |
| Augment | `~/.augment` | `AUGMENT_CONFIG_DIR` |
| Trae | `~/.trae` | `TRAE_CONFIG_DIR` |
| Qwen Code | `~/.qwen` | `QWEN_CONFIG_DIR` |
| Kilo | `~/.config/kilo` | `KILO_CONFIG_DIR` |
| CodeBuddy | `~/.codebuddy` | `CODEBUDDY_CONFIG_DIR` |
| Cline | `~/.cline` | `CLINE_CONFIG_DIR` |

### Usando o Claude Code com provedores não-Anthropic

Mude para o perfil `inherit`: `/gsd-config --profile inherit`. Isso faz com que todos os agentes usem o modelo da sua sessão atual.

### Trabalhando em um projeto sensível/privado

Defina `commit_docs: false` durante `/gsd-new-project` ou via `/gsd-settings`. Adicione `.planning/` ao seu `.gitignore`.

### Uma atualização do GSD sobrescreveu minhas alterações locais

Desde a v1.17, o instalador faz backup de arquivos modificados localmente em `gsd-local-patches/`. Execute `/gsd-update --reapply` para mesclar suas alterações de volta.

### Não consigo atualizar via npm

Consulte [docs/manual-update.md](../manual-update.md) para um procedimento de atualização manual passo a passo.

### Diagnósticos de workflow (`/gsd-forensics`)

Quando um workflow falha de forma não óbvia, execute `/gsd-forensics` para gerar um relatório de diagnóstico cobrindo anomalias de histórico git, integridade de artefatos e inconsistências de estado. A saída vai para `.planning/forensics/`.

### Subagente executor recebe "Permission denied" em comandos Bash

Adicione os padrões necessários ao `~/.claude/settings.json`. Padrões principais necessários para todas as stacks:

```json
"Bash(git add:*)",
"Bash(git commit:*)",
"Bash(git merge:*)",
"Bash(git worktree:*)",
"Bash(git rebase:*)",
"Bash(git reset:*)",
"Bash(git checkout:*)",
"Bash(git switch:*)",
"Bash(git restore:*)",
"Bash(git stash:*)",
"Bash(git rm:*)",
"Bash(git mv:*)",
"Bash(git fetch:*)",
"Bash(git cherry-pick:*)",
"Bash(git apply:*)",
"Bash(gh:*)"
```

**Permissões por projeto:** adicione o mesmo bloco `permissions.allow` ao `.claude/settings.local.json` na raiz do seu projeto em vez de `~/.claude/settings.json`.

### Execução paralela causa erros de bloqueio de build

O GSD trata isso automaticamente desde a v1.26. Se você estiver em uma versão mais antiga, adicione ao `CLAUDE.md` do seu projeto:

```markdown
## Git Commit Rules for Agents
All subagent/executor commits MUST use `--no-verify`.
```

Para desativar a execução paralela completamente: `/gsd-settings` → defina `parallelization.enabled` como `false`.

---

## Referência rápida de recuperação

| Problema                                    | Solução                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| Contexto perdido / nova sessão              | `/gsd-resume-work` ou `/gsd-progress`                                         |
| Fase deu errado                             | `git revert` dos commits da fase, depois replanejar                           |
| Precisa mudar o escopo                      | `/gsd-phase` (padrão), `/gsd-phase --insert` ou `/gsd-phase --remove`         |
| Algo quebrou                                | `/gsd-debug "description"` (adicione `--diagnose` para análise sem correções) |
| STATE.md fora de sincronia                  | `state validate` e depois `state sync`                                        |
| Estado do workflow parece corrompido        | `/gsd-forensics`                                                              |
| Correção rápida e pontual                   | `/gsd-quick`                                                                  |
| Plano não corresponde à sua visão           | `/gsd-discuss-phase [N]` e depois replanejar                                  |
| Custos altos                                | `/gsd-config --profile budget` e `/gsd-settings` para desativar agentes       |
| Atualização quebrou alterações locais       | `/gsd-update --reapply`                                                       |
| Quer resumo de sessão para stakeholders     | `/gsd-pause-work --report`                                                    |
| Não sabe qual é o próximo passo             | `/gsd-progress --next`                                                        |
| Erros de build em execução paralela         | Atualize o GSD ou defina `parallelization.enabled: false`                     |

---

## Estrutura de arquivos do projeto

```text
.planning/
  PROJECT.md              # Project vision and context (always loaded)
  REQUIREMENTS.md         # Scoped v1/v2 requirements with IDs
  ROADMAP.md              # Phase breakdown with status tracking
  STATE.md                # Decisions, blockers, session memory
  config.json             # Workflow configuration
  MILESTONES.md           # Completed milestone archive
  HANDOFF.json            # Structured session handoff (from /gsd-pause-work)
  research/               # Domain research from /gsd-new-project
  reports/                # Session reports (from /gsd-pause-work --report)
  todos/
    pending/              # Captured ideas awaiting work
    completed/             # Completed todos
  debug/                  # Active debug sessions
    resolved/             # Archived debug sessions
  spikes/                 # Feasibility experiments (from /gsd-spike)
    NNN-name/             # Experiment code + README with verdict
    MANIFEST.md           # Index of all spikes
  sketches/               # HTML mockups (from /gsd-sketch)
    NNN-name/             # index.html (2-3 variants) + README
    themes/
      default.css         # Shared CSS variables for all sketches
    MANIFEST.md           # Index of all sketches with winners
  codebase/               # Brownfield codebase mapping (from /gsd-map-codebase or /gsd-onboard)
  onboarding/             # Brownfield onboarding summary (from /gsd-onboard)
  phases/
    XX-phase-name/
      XX-YY-PLAN.md       # Atomic execution plans
      XX-YY-SUMMARY.md    # Execution outcomes and decisions
      CONTEXT.md          # Your implementation preferences
      RESEARCH.md         # Ecosystem research findings
      VERIFICATION.md     # Post-execution verification results
      XX-UI-SPEC.md       # UI design contract (from /gsd-ui-phase)
      XX-UI-REVIEW.md     # Visual audit scores (from /gsd-ui-review)
  ui-reviews/             # Screenshots from /gsd-ui-review (gitignored)
```

---

## Relacionados

- [Índice da documentação](README.md)
- [Comandos](COMMANDS.md)
- [Configuração](CONFIGURATION.md)
- [O ciclo de fase](explanation/the-phase-loop.md)
