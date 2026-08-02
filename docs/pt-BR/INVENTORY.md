# Inventário de Superfícies Entregues do GSD

> Registro autoritativo de toda superfície GSD entregue: comandos, agentes, workflows, referências, módulos de CLI e hooks. Quando a documentação ampla (AGENTS.md, COMMANDS.md, ARCHITECTURE.md, CLI-TOOLS.md) divergir do sistema de arquivos, este arquivo e a árvore do repositório são a fonte de verdade.

## Como Usar Este Arquivo

- As contagens aqui são derivadas do sistema de arquivos no pino v1.36.0 e podem divergir entre versões. Para contagens ao vivo, execute `ls commands/gsd/*.md | wc -l`, `ls agents/gsd-*.md | wc -l`, etc. na cópia local do repositório.
- Este arquivo enumera toda superfície entregue em todas as seis famílias (agentes, comandos, workflows, referências, módulos de CLI, hooks). Documentações amplas podem apresentar narrativas ou subconjuntos curados; quando discordarem do sistema de arquivos, este arquivo e as listagens de diretório são autoritativos.
- Novas superfícies adicionadas após v1.36.0 devem aparecer aqui primeiro, depois propagar para as documentações amplas. Os testes de controle de drift em `tests/inventory-counts.test.cjs`, `tests/commands-doc-parity.test.cjs`, `tests/agents-doc-parity.test.cjs`, `tests/cli-modules-doc-parity.test.cjs`, `tests/hooks-doc-parity.test.cjs`, `tests/architecture-counts.test.cjs` e `tests/command-count-sync.test.cjs` ancoram as contagens e o conteúdo do registro ao sistema de arquivos.

Este é o registro autoritativo de toda superfície do GSD Core entregue. Veja o [índice de documentação](README.md) para navegar por tópico.

---

## Agentes (33 entregues)

Registro completo em `agents/gsd-*.md`. A coluna "Documento primário" indica se [`docs/AGENTS.md`](AGENTS.md) apresenta um cartão de função completo (*primary*), um stub resumido na seção "Agentes Avançados e Especializados" (*advanced stub*), ou nenhuma cobertura (*inventory only*).

| Agente | Função (uma linha) | Invocado por | Documento primário |
|--------|--------------------|--------------|--------------------|
| gsd-project-researcher | Pesquisa o ecossistema do domínio antes da criação do roadmap (stack, funcionalidades, arquitetura, armadilhas). | `/gsd-new-project`, `/gsd-new-milestone` | primary |
| gsd-phase-researcher | Pesquisa a abordagem de implementação para uma fase específica antes do planejamento. | `/gsd-plan-phase` | primary |
| gsd-ui-researcher | Produz contratos de design de UI para fases de frontend. | `/gsd-ui-phase` | primary |
| gsd-assumptions-analyzer | Produz premissas embasadas em evidências para a discuss-phase (modo de premissas). | workflow `discuss-phase-assumptions` | primary |
| gsd-advisor-researcher | Pesquisa uma única decisão em zona cinzenta durante o modo advisordiscuss-phase. | workflow `discuss-phase` (modo advisor) | primary |
| gsd-research-synthesizer | Combina saídas de pesquisadores paralelos em um SUMMARY.md unificado. | `/gsd-new-project` | primary |
| gsd-planner | Cria planos de fase executáveis com detalhamento de tarefas e verificação retroativa a partir dos objetivos. | `/gsd-plan-phase`, `/gsd-quick` | primary |
| gsd-roadmapper | Cria roadmaps de projeto com detalhamento de fases e mapeamento de requisitos. | `/gsd-new-project` | primary |
| gsd-executor | Executa planos GSD com commits atômicos e tratamento de desvios. | `/gsd-execute-phase`, `/gsd-quick` | primary |
| gsd-plan-checker | Verifica se os planos vão atingir os objetivos da fase (8 dimensões de verificação). | `/gsd-plan-phase` (loop de verificação) | primary |
| gsd-integration-checker | Verifica a integração entre fases e fluxos de ponta a ponta. | `/gsd-audit-milestone` | primary |
| gsd-ui-checker | Valida contratos de design UI-SPEC.md contra dimensões de qualidade. | `/gsd-ui-phase` (loop de validação) | primary |
| gsd-verifier | Verifica o alcance dos objetivos da fase por meio de análise retroativa a partir dos objetivos. | `/gsd-execute-phase` | primary |
| gsd-nyquist-auditor | Preenche lacunas de validação Nyquist gerando testes. | `/gsd-validate-phase` | primary |
| gsd-ui-auditor | Auditoria visual retroativa de 6 pilares do código frontend implementado. | `/gsd-ui-review` | primary |
| gsd-codebase-mapper | Explora a base de código e escreve documentos de análise estruturados. | `/gsd-map-codebase` | primary |
| gsd-debugger | Investiga bugs usando o método científico com estado persistente. | `/gsd-debug`, `/gsd-verify-work` | primary |
| gsd-user-profiler | Avalia o comportamento do desenvolvedor em 8 dimensões. | `/gsd-profile-user` | primary |
| gsd-doc-writer | Escreve e atualiza a documentação do projeto. | `/gsd-docs-update` | primary |
| gsd-doc-verifier | Verifica afirmações factuais na documentação gerada. | `/gsd-docs-update` | primary |
| gsd-security-auditor | Verifica mitigações de ameaças do modelo de ameaças do PLAN.md. | `/gsd-secure-phase` | primary |
| gsd-pattern-mapper | Mapeia novos arquivos para os análogos existentes mais próximos; escreve PATTERNS.md para o planejador. | `/gsd-plan-phase` (entre pesquisa e planejamento) | advanced stub |
| gsd-debug-session-manager | Executa o loop completo de checkpoint e continuação do `/gsd-debug` em contexto isolado para manter o contexto principal enxuto. | `/gsd-debug` | advanced stub |
| gsd-code-reviewer | Revisa arquivos-fonte em busca de bugs, problemas de segurança e qualidade de código; produz REVIEW.md. | `/gsd-code-review` | advanced stub |
| gsd-code-fixer | Aplica correções às descobertas do REVIEW.md com commits atômicos por correção; produz REVIEW-FIX.md. | `/gsd-code-review --fix` | advanced stub |
| gsd-ai-researcher | Pesquisa a documentação oficial de um framework de IA escolhido em orientações prontas para implementação (AI-SPEC.md §3–§4b). | `/gsd-ai-integration-phase` | advanced stub |
| gsd-domain-researcher | Levanta critérios de avaliação de especialistas de domínio e modos de falha para um sistema de IA (AI-SPEC.md §1b). | `/gsd-ai-integration-phase` | advanced stub |
| gsd-eval-planner | Projeta uma estratégia de avaliação estruturada para uma fase de IA (AI-SPEC.md §5–§7). | `/gsd-ai-integration-phase` | advanced stub |
| gsd-eval-auditor | Auditoria retroativa da cobertura de avaliação de uma fase de IA; produz EVAL-REVIEW.md (COVERED/PARTIAL/MISSING). | `/gsd-eval-review` | advanced stub |
| gsd-framework-selector | Matriz de decisão interativa com ≤6 perguntas que pontua e recomenda um framework de IA/LLM. | `/gsd-ai-integration-phase` | advanced stub |
| gsd-intel-updater | Escreve arquivos de intel estruturados (`.planning/intel/*.json`) usados como base de conhecimento consultável da base de código. | `/gsd-map-codebase --query` | advanced stub |
| gsd-doc-classifier | Classifica um único documento de planejamento como ADR, PRD, SPEC, DOC ou UNKNOWN; invocado em paralelo para processar o corpus de documentos. | `/gsd-ingest-docs` | advanced stub |
| gsd-doc-synthesizer | Sintetiza documentos de planejamento classificados em um único contexto consolidado com regras de precedência, detecção de ciclos e relatório de conflitos em três categorias. | `/gsd-ingest-docs` | advanced stub |

**Nota de cobertura.** `docs/AGENTS.md` fornece cartões de função completos para 21 agentes primários, além de stubs concisos para os 12 agentes avançados. O Resumo de Permissões de Ferramenta de Agente nesse arquivo cobre apenas os 21 agentes primários; as listas de ferramentas dos agentes avançados estão capturadas no frontmatter de cada agente em `agents/gsd-*.md`.

---

## Comandos (67 entregues)

Registro completo em `commands/gsd/*.md`. Os agrupamentos abaixo espelham a ordem das seções de `docs/COMMANDS.md`; cada linha traz o nome do comando, uma função em uma linha derivada do `description:` do frontmatter do comando e um link para o arquivo-fonte. `tests/command-count-sync.test.cjs` trava a contagem contra o sistema de arquivos.

### Meta-Skills de Namespace

Esses seis roteadores são entradas apenas descritivas que o modelo seleciona primeiro; o corpo de cada um contém uma tabela de roteamento que aponta para a sub-habilidade concreta correta. Eles existem para manter baixo o custo de tokens da listagem ansiosa de habilidades enquanto toda a superfície permanece acessível. Veja [#2792](https://github.com/open-gsd/gsd-core/issues/2792) para a justificativa; as tabelas de roteamento apontam para a superfície consolidada pós-[#2790](https://github.com/open-gsd/gsd-core/issues/2790).

| Comando | Função | Fonte |
|---------|--------|-------|
| `/gsd-workflow` | Roteador de pipeline de fase — discuss / plan / execute / verify / phase / progress. | [commands/gsd/ns-workflow.md](../../commands/gsd/ns-workflow.md) |
| `/gsd-project` | Roteador de ciclo de vida do projeto — milestones, auditorias, resumo. | [commands/gsd/ns-project.md](../../commands/gsd/ns-project.md) |
| `/gsd-quality` | Roteador de portão de qualidade — revisão de código, debug, auditoria, segurança, avaliação, ui. | [commands/gsd/ns-review.md](../../commands/gsd/ns-review.md) |
| `/gsd-context` | Roteador de inteligência da base de código — map, graphify, docs, learnings. | [commands/gsd/ns-context.md](../../commands/gsd/ns-context.md) |
| `/gsd-manage` | Roteador de gerenciamento — config, workspace, workstreams, thread, update, ship, inbox. | [commands/gsd/ns-manage.md](../../commands/gsd/ns-manage.md) |
| `/gsd-ideate` | Roteador de exploração e captura — explore, sketch, spike, spec, capture. | [commands/gsd/ns-ideate.md](../../commands/gsd/ns-ideate.md) |

### Workflow Principal

| Comando | Função | Fonte |
|---------|--------|-------|
| `/gsd-new-project` | Inicializa um novo projeto com coleta profunda de contexto e PROJECT.md. | [commands/gsd/new-project.md](../../commands/gsd/new-project.md) |
| `/gsd-onboard` | Guia código existente por mapeamento, ingestão de docs, configuração de projeto e onboarding summary. | [commands/gsd/onboard.md](../../commands/gsd/onboard.md) |
| `/gsd-workspace` | Gerencia workspaces GSD — criar (`--new`), listar (`--list`) ou remover (`--remove`) ambientes de workspace isolados. | [commands/gsd/workspace.md](../../commands/gsd/workspace.md) |
| `/gsd-discuss-phase` | Coleta contexto da fase por meio de perguntas adaptativas antes do planejamento. | [commands/gsd/discuss-phase.md](../../commands/gsd/discuss-phase.md) |
| `/gsd-mvp-phase` | Planeja uma fase como uma fatia vertical de MVP — história de usuário, divisão SPIDR, depois plan-phase. | [commands/gsd/mvp-phase.md](../../commands/gsd/mvp-phase.md) |
| `/gsd-spec-phase` | Refinamento socrático de especificação produzindo um SPEC.md com requisitos falsificáveis. | [commands/gsd/spec-phase.md](../../commands/gsd/spec-phase.md) |
| `/gsd-ui-phase` | Gera contrato de design de UI (UI-SPEC.md) para fases de frontend. | [commands/gsd/ui-phase.md](../../commands/gsd/ui-phase.md) |
| `/gsd-ai-integration-phase` | Gera contrato de design de IA (AI-SPEC.md) via seleção de framework, pesquisa e planejamento de avaliação. | [commands/gsd/ai-integration-phase.md](../../commands/gsd/ai-integration-phase.md) |
| `/gsd-plan-phase` | Cria plano de fase detalhado (PLAN.md) com loop de verificação. | [commands/gsd/plan-phase.md](../../commands/gsd/plan-phase.md) |
| `/gsd-plan-review-convergence` | Loop de convergência de plano entre IAs — replanejar com feedback de revisão até que não restem preocupações HIGH (máx. 3 ciclos). | [commands/gsd/plan-review-convergence.md](../../commands/gsd/plan-review-convergence.md) |
| `/gsd-ultraplan-phase` | [BETA] Delega a fase de planejamento ao ultraplan cloud do Claude Code — rascunhos remotamente, revisar no navegador, importar de volta via `/gsd-import`. Apenas Claude Code. | [commands/gsd/ultraplan-phase.md](../../commands/gsd/ultraplan-phase.md) |
| `/gsd-spike` | Realiza um spike rápido de uma ideia com experimentos descartáveis; use `--wrap-up` para empacotar as descobertas como uma habilidade persistente. | [commands/gsd/spike.md](../../commands/gsd/spike.md) |
| `/gsd-sketch` | Esboça rapidamente ideias de UI/design usando mockups HTML descartáveis; use `--wrap-up` para empacotar as descobertas. | [commands/gsd/sketch.md](../../commands/gsd/sketch.md) |
| `/gsd-execute-phase` | Executa todos os planos de uma fase com paralelização baseada em ondas. | [commands/gsd/execute-phase.md](../../commands/gsd/execute-phase.md) |
| `/gsd-verify-work` | Valida funcionalidades construídas por meio de UAT conversacional com autodiagnóstico. | [commands/gsd/verify-work.md](../../commands/gsd/verify-work.md) |
| `/gsd-ship` | Cria PR, executa revisão e prepara para merge após verificação. | [commands/gsd/ship.md](../../commands/gsd/ship.md) |
| `/gsd-fast` | Executa uma tarefa trivial inline — sem subagentes, sem overhead de planejamento. | [commands/gsd/fast.md](../../commands/gsd/fast.md) |
| `/gsd-quick` | Executa uma tarefa rápida com garantias GSD (commits atômicos, rastreamento de estado) mas pula agentes opcionais. | [commands/gsd/quick.md](../../commands/gsd/quick.md) |
| `/gsd-ui-review` | Auditoria visual retroativa de 6 pilares do código frontend implementado. | [commands/gsd/ui-review.md](../../commands/gsd/ui-review.md) |
| `/gsd-code-review` | Revisa arquivos-fonte alterados durante uma fase em busca de bugs, segurança e problemas de qualidade de código; use `--fix` para aplicar as descobertas automaticamente. | [commands/gsd/code-review.md](../../commands/gsd/code-review.md) |
| `/gsd-eval-review` | Audita retroativamente a cobertura de avaliação de uma fase de IA executada; produz EVAL-REVIEW.md. | [commands/gsd/eval-review.md](../../commands/gsd/eval-review.md) |

### Gerenciamento de Fases e Milestones

| Comando | Função | Fonte |
|---------|--------|-------|
| `/gsd-phase` | CRUD de fases — adicionar (padrão), inserir (`--insert`), remover (`--remove`) ou editar (`--edit`) fases no ROADMAP.md. | [commands/gsd/phase.md](../../commands/gsd/phase.md) |
| `/gsd-add-tests` | Gera testes para uma fase concluída com base nos critérios de UAT e na implementação. | [commands/gsd/add-tests.md](../../commands/gsd/add-tests.md) |
| `/gsd-validate-phase` | Audita retroativamente e preenche lacunas de validação Nyquist para uma fase concluída. | [commands/gsd/validate-phase.md](../../commands/gsd/validate-phase.md) |
| `/gsd-secure-phase` | Verifica retroativamente as mitigações de ameaças para uma fase concluída. | [commands/gsd/secure-phase.md](../../commands/gsd/secure-phase.md) |
| `/gsd-audit-milestone` | Audita a conclusão do milestone contra a intenção original antes do arquivamento. | [commands/gsd/audit-milestone.md](../../commands/gsd/audit-milestone.md) |
| `/gsd-audit-uat` | Auditoria entre fases de todos os itens de UAT e verificação pendentes. | [commands/gsd/audit-uat.md](../../commands/gsd/audit-uat.md) |
| `/gsd-audit-fix` | Pipeline autônomo de auditoria para correção — encontrar problemas, classificar, corrigir, testar, commitar. | [commands/gsd/audit-fix.md](../../commands/gsd/audit-fix.md) |
| `/gsd-complete-milestone` | Arquiva o milestone concluído e prepara para a próxima versão. | [commands/gsd/complete-milestone.md](../../commands/gsd/complete-milestone.md) |
| `/gsd-new-milestone` | Inicia um novo ciclo de milestone — atualizar PROJECT.md e rotear para os requisitos. | [commands/gsd/new-milestone.md](../../commands/gsd/new-milestone.md) |
| `/gsd-milestone-summary` | Gera um resumo abrangente do projeto a partir dos artefatos do milestone. | [commands/gsd/milestone-summary.md](../../commands/gsd/milestone-summary.md) |
| `/gsd-cleanup` | Arquiva diretórios de fases acumulados de milestones concluídos. | [commands/gsd/cleanup.md](../../commands/gsd/cleanup.md) |
| `/gsd-manager` | Central de comando interativa para gerenciar múltiplas fases de um terminal. | [commands/gsd/manager.md](../../commands/gsd/manager.md) |
| `/gsd-workstreams` | Gerencia workstreams paralelos — listar, criar, alternar, status, progresso, concluir, retomar. | [commands/gsd/workstreams.md](../../commands/gsd/workstreams.md) |
| `/gsd-autonomous` | Executa todas as fases restantes de forma autônoma — discuss → plan → execute por fase. | [commands/gsd/autonomous.md](../../commands/gsd/autonomous.md) |
| `/gsd-undo` | Reversão git segura — reverter commits de fase ou plano usando o manifesto da fase. | [commands/gsd/undo.md](../../commands/gsd/undo.md) |

### Sessão e Navegação

| Comando | Função | Fonte |
|---------|--------|-------|
| `/gsd-progress` | Verifica o progresso do projeto, exibe contexto e roteia para a próxima ação; use `--next` para avançar automaticamente ou `--do` para executar uma tarefa de forma livre. | [commands/gsd/progress.md](../../commands/gsd/progress.md) |
| `/gsd-capture` | Captura ideias, tarefas, notas e seeds — todo (padrão), `--note`, `--backlog`, `--seed` ou `--list` de todos pendentes. | [commands/gsd/capture.md](../../commands/gsd/capture.md) |
| `/gsd-stats` | Exibe estatísticas do projeto — fases, planos, requisitos, métricas git, linha do tempo. | [commands/gsd/stats.md](../../commands/gsd/stats.md) |
| `/gsd-pause-work` | Cria handoff de contexto ao pausar o trabalho no meio de uma fase. | [commands/gsd/pause-work.md](../../commands/gsd/pause-work.md) |
| `/gsd-resume-work` | Retoma o trabalho da sessão anterior com restauração completa do contexto. | [commands/gsd/resume-work.md](../../commands/gsd/resume-work.md) |
| `/gsd-explore` | Ideação socrática e roteamento de ideias — pensar nas ideias antes de se comprometer. | [commands/gsd/explore.md](../../commands/gsd/explore.md) |
| `/gsd-review-backlog` | Revisa e promove itens do backlog para o milestone ativo. | [commands/gsd/review-backlog.md](../../commands/gsd/review-backlog.md) |
| `/gsd-thread` | Gerencia threads de contexto persistentes para trabalho entre sessões. | [commands/gsd/thread.md](../../commands/gsd/thread.md) |

### Inteligência da Base de Código

| Comando | Função | Fonte |
|---------|--------|-------|
| `/gsd-map-codebase` | Analisa a base de código com agentes mapeadores paralelos; use `--fast` para varredura leve ou `--query` para consultas de intel. | [commands/gsd/map-codebase.md](../../commands/gsd/map-codebase.md) |
| `/gsd-graphify` | Constrói, consulta e inspeciona o grafo de conhecimento do projeto em `.planning/graphs/`. | [commands/gsd/graphify.md](../../commands/gsd/graphify.md) |
| `/gsd-extract-learnings` | Extrai decisões, lições, padrões e surpresas de artefatos de fases concluídas. | [commands/gsd/extract-learnings.md](../../commands/gsd/extract-learnings.md) |

### Revisão, Debug e Recuperação

| Comando | Função | Fonte |
|---------|--------|-------|
| `/gsd-review` | Solicita revisão de pares entre IAs de planos de fase a partir de CLIs de IA externos. | [commands/gsd/review.md](../../commands/gsd/review.md) |
| `/gsd-debug` | Depuração sistemática com estado persistente entre resets de contexto. | [commands/gsd/debug.md](../../commands/gsd/debug.md) |
| `/gsd-forensics` | Investigação post-mortem de workflows GSD com falha — analisa git, artefatos, estado. | [commands/gsd/forensics.md](../../commands/gsd/forensics.md) |
| `/gsd-health` | Diagnostica a integridade do diretório de planejamento e opcionalmente repara problemas. | [commands/gsd/health.md](../../commands/gsd/health.md) |
| `/gsd-import` | Ingere planos externos com detecção de conflitos contra decisões do projeto. | [commands/gsd/import.md](../../commands/gsd/import.md) |
| `/gsd-inbox` | Faz triagem e revisão de todas as issues e PRs abertas do GitHub contra os templates do projeto. | [commands/gsd/inbox.md](../../commands/gsd/inbox.md) |

### Documentação, Perfil e Utilitários

| Comando | Função | Fonte |
|---------|--------|-------|
| `/gsd-docs-update` | Gera ou atualiza a documentação do projeto verificada contra a base de código. | [commands/gsd/docs-update.md](../../commands/gsd/docs-update.md) |
| `/gsd-ingest-docs` | Varre um repositório em busca de ADRs/PRDs/SPECs/DOCs mistos e inicializa ou mescla a configuração completa de `.planning/` com classificação, síntese e relatório de conflitos. | [commands/gsd/ingest-docs.md](../../commands/gsd/ingest-docs.md) |
| `/gsd-profile-user` | Gera perfil comportamental do desenvolvedor e artefatos descobríveis pelo Claude. | [commands/gsd/profile-user.md](../../commands/gsd/profile-user.md) |
| `/gsd-settings` | Configura alternâncias de workflow GSD e perfil de modelo. | [commands/gsd/settings.md](../../commands/gsd/settings.md) |
| `/gsd-config` | Configura as definições GSD — alternâncias de workflow (padrão), parâmetros avançados (`--advanced`), integrações (`--integrations`) ou perfil de modelo (`--profile`). | [commands/gsd/config.md](../../commands/gsd/config.md) |
| `/gsd-pr-branch` | Cria um branch limpo de PR filtrando commits de `.planning/`. | [commands/gsd/pr-branch.md](../../commands/gsd/pr-branch.md) |
| `/gsd-surface` | Alterna quais habilidades são expostas — aplica um perfil, lista ou desativa um cluster sem reinstalar. | [commands/gsd/surface.md](../../commands/gsd/surface.md) |
| `/gsd-update` | Atualiza o GSD para a versão mais recente; use `--sync` para sincronizar habilidades entre runtimes ou `--reapply` para reaplicar patches locais. | [commands/gsd/update.md](../../commands/gsd/update.md) |
| `/gsd-help` | Exibe os comandos GSD disponíveis e o guia de uso. | [commands/gsd/help.md](../../commands/gsd/help.md) |

---

## Workflows (88 entregues)

Registro completo em `gsd-core/workflows/*.md`. Workflows são orquestradores enxutos que os comandos referenciam internamente; a maioria não é lida diretamente pelos usuários finais. As linhas abaixo mapeiam cada arquivo de workflow para sua função (derivada do bloco `<purpose>`) e, quando aplicável, para o comando que o invoca.

| Workflow | Função | Invocado por |
|----------|--------|--------------|
| `add-backlog.md` | Adiciona um item de backlog ao ROADMAP.md usando numeração 999.x. | `/gsd-capture --backlog` |
| `add-phase.md` | Adiciona uma nova fase inteira ao final do milestone atual no roadmap. | `/gsd-phase` (padrão) |
| `add-tests.md` | Gera testes unitários e E2E para uma fase concluída com base em seus artefatos. | `/gsd-add-tests` |
| `add-todo.md` | Captura uma ideia ou tarefa que surge durante uma sessão como um todo estruturado. | `/gsd-capture` (padrão) |
| `ai-integration-phase.md` | Orquestra seleção de framework → pesquisa de IA → pesquisa de domínio → planejamento de avaliação no AI-SPEC.md. | `/gsd-ai-integration-phase` |
| `analyze-dependencies.md` | Analisa as fases do ROADMAP.md para sobreposição de arquivos e dependências semânticas; sugere arestas `Depends on`. | `/gsd-manager --analyze-deps` |
| `audit-fix.md` | Pipeline autônomo de auditoria para correção — executar auditoria, analisar, classificar, corrigir, testar, commitar. | `/gsd-audit-fix` |
| `audit-milestone.md` | Verifica se o milestone atendeu sua definição de pronto ao agregar verificações de fase. | `/gsd-audit-milestone` |
| `audit-uat.md` | Auditoria entre fases de arquivos de UAT e verificação; produz lista priorizada de itens pendentes. | `/gsd-audit-uat` |
| `autonomous.md` | Conduz as fases do milestone de forma autônoma — todas restantes, um intervalo ou uma única fase. | `/gsd-autonomous` |
| `check-todos.md` | Lista todos pendentes, permite seleção, carrega contexto e roteia para a ação apropriada. | `/gsd-capture --list` |
| `cleanup.md` | Arquiva diretórios de fases acumulados de milestones concluídos. | `/gsd-cleanup` |
| `code-review-fix.md` | Autocorrige problemas do REVIEW.md via gsd-code-fixer com commits atômicos por correção. | `/gsd-code-review --fix` |
| `code-review.md` | Revisa alterações de código-fonte da fase via gsd-code-reviewer; produz REVIEW.md. | `/gsd-code-review` |
| `complete-milestone.md` | Marca uma versão entregue como concluída — entrada no MILESTONES.md, evolução do PROJECT.md, tag. | `/gsd-complete-milestone` |
| `diagnose-issues.md` | Orquestra agentes de debug paralelos para investigar lacunas de UAT e encontrar causas raiz. | `/gsd-verify-work` (autodiagnóstico) |
| `discovery-phase.md` | Executa a descoberta no nível de profundidade apropriado. | `/gsd-new-project` (caminho de descoberta) |
| `discuss-phase-assumptions.md` | Discuss no modo de premissas — extrai decisões de implementação via análise com base no código primeiro. | `/gsd-discuss-phase` (quando `discuss_mode=assumptions`) |
| `discuss-phase-power.md` | Discuss para usuário avançado — pré-gera todas as perguntas em um arquivo de estado JSON + UI HTML. | `/gsd-discuss-phase --power` |
| `discuss-phase.md` | Extrai decisões de implementação por meio de discussão iterativa de zonas cinzentas. | `/gsd-discuss-phase` |
| `mvp-phase.md` | Planeja uma fase como uma fatia vertical de MVP — história de usuário, divisão SPIDR, depois plan-phase. | `/gsd-mvp-phase` |
| `do.md` | Roteia texto livre do usuário para o comando GSD mais adequado. | `/gsd-progress --do` |
| `docs-update.md` | Gera, atualiza e verifica documentação canônica e escrita à mão do projeto. | `/gsd-docs-update` |
| `edit-phase.md` | Edita qualquer campo de uma fase existente no ROADMAP.md no lugar, preservando número e posição. | `/gsd-phase --edit` |
| `eval-review.md` | Auditoria retroativa da cobertura de avaliação de uma fase de IA implementada. | `/gsd-eval-review` |
| `execute-phase.md` | Executa todos os planos de uma fase usando execução paralela baseada em ondas. | `/gsd-execute-phase` |
| `execute-plan.md` | Executa um prompt de fase (PLAN.md) e cria o resumo do resultado (SUMMARY.md). | `execute-phase.md` (subagente por plano) |
| `explore.md` | Ideação socrática — guia o desenvolvedor por perguntas investigativas. | `/gsd-explore` |
| `debug.md` | Depuração sistemática — roteamento de subcomandos, criação de sessão, delegação para gsd-debug-session-manager. | `/gsd-debug` |
| `extract-learnings.md` | Extrai decisões, lições, padrões e surpresas de artefatos de fases concluídas. | `/gsd-extract-learnings` |
| `fast.md` | Executa uma tarefa trivial inline sem overhead de subagente. | `/gsd-fast` |
| `forensics.md` | Investigação forense de workflows com falha — análise de git, artefatos e estado. | `/gsd-forensics` |
| `graduation.md` | Agrupa itens recorrentes do LEARNINGS.md entre fases e levanta candidatos de promoção HITL. | `transition.md` (etapa graduation_scan) |
| `health.md` | Valida a integridade do diretório `.planning/` e reporta problemas acionáveis. | `/gsd-health` |
| `help.md` | Exibe a referência completa de comandos do GSD Core. | `/gsd-help` |
| `import.md` | Ingere planos externos com detecção de conflitos contra decisões existentes do projeto. | `/gsd-import` |
| `inbox.md` | Faz triagem de issues e PRs abertas do GitHub contra templates de contribuição do projeto. | `/gsd-inbox` |
| `ingest-docs.md` | Varre um repositório em busca de documentos de planejamento mistos; classifica, sintetiza e inicializa ou mescla no `.planning/` com um relatório de conflitos. | `/gsd-ingest-docs` |
| `insert-phase.md` | Insere uma fase decimal para trabalho urgente descoberto no meio de um milestone. | `/gsd-phase --insert` |
| `list-phase-assumptions.md` | Levanta as premissas do Claude sobre uma fase antes do planejamento. | `/gsd-discuss-phase --assumptions` |
| `list-workspaces.md` | Lista todos os workspaces GSD encontrados em `~/gsd-workspaces/` com seu status. | `/gsd-workspace --list` |
| `manager.md` | Central de comando interativa de milestone — dashboard, discuss inline, plan/execute em segundo plano. | `/gsd-manager` |
| `map-codebase.md` | Orquestra agentes mapeadores paralelos da base de código para produzir documentos em `.planning/codebase/`. | `/gsd-map-codebase` |
| `milestone-summary.md` | Síntese do resumo do milestone — artefato de onboarding e revisão a partir dos artefatos do milestone. | `/gsd-milestone-summary` |
| `new-milestone.md` | Inicia um novo ciclo de milestone — carregar contexto do projeto, coletar objetivos, atualizar PROJECT.md/STATE.md. | `/gsd-new-milestone` |
| `new-project.md` | Fluxo unificado de novo projeto — questionamento, pesquisa (opcional), requisitos, roadmap. | `/gsd-new-project` |
| `onboard.md` | Orquestração de onboarding brownfield — mapear código, ingerir docs, inicializar planning e resumir próximo passo. | `/gsd-onboard` |
| `new-workspace.md` | Cria um workspace isolado com worktrees/clones do repositório e um `.planning/` independente. | `/gsd-workspace --new` |
| `next.md` | Detecta o estado atual do projeto e avança automaticamente para o próximo passo lógico. | `/gsd-progress --next` |
| `node-repair.md` | Operador de reparo autônomo para verificação de tarefa com falha; invocado por `execute-plan`. | `execute-plan.md` (recuperação) |
| `note.md` | Captura de ideia sem atrito — uma chamada Write, uma linha de confirmação. | `/gsd-capture --note` |
| `pause-work.md` | Cria os arquivos de handoff estruturados `.planning/HANDOFF.json` e `.continue-here.md`. | `/gsd-pause-work` |
| `plan-phase.md` | Cria arquivos PLAN.md executáveis com pesquisa integrada e loop de verificação. | `/gsd-plan-phase`, `/gsd-quick` |
| `plan-review-convergence.md` | Loop de convergência de plano entre IAs — replanejar com feedback de revisão até que não restem preocupações HIGH. | `/gsd-plan-review-convergence` |
| `plant-seed.md` | Captura uma ideia prospectiva como um arquivo de seed estruturado com condições de acionamento. | `/gsd-capture --seed` |
| `pr-branch.md` | Cria um branch limpo para pull requests filtrando commits de `.planning/`. | `/gsd-pr-branch` |
| `profile-user.md` | Orquestra o fluxo completo de perfil do desenvolvedor — consentimento, varredura de sessão, geração de perfil. | `/gsd-profile-user` |
| `progress.md` | Renderização de progresso — contexto do projeto, posição e roteamento para próxima ação. | `/gsd-progress` |
| `quick.md` | Execução de tarefa rápida com garantias GSD (commits atômicos, rastreamento de estado). | `/gsd-quick` |
| `reapply-patches.md` | Reaaplica modificações locais após uma atualização do GSD. | `/gsd-update --reapply` |
| `remove-phase.md` | Remove uma fase futura do roadmap e renumera as fases subsequentes. | `/gsd-phase --remove` |
| `remove-workspace.md` | Remove um workspace GSD e limpa worktrees. | `/gsd-workspace --remove` |
| `resume-project.md` | Retoma o trabalho — restaura o contexto completo do STATE.md, HANDOFF.json e artefatos. | `/gsd-resume-work` |
| `review.md` | Revisão de plano entre IAs via CLIs externos; produz REVIEWS.md. | `/gsd-review` |
| `scan.md` | Varredura rápida e focada da base de código — alternativa leve ao map-codebase. | `/gsd-map-codebase --fast` |
| `secure-phase.md` | Auditoria retroativa de mitigação de ameaças para uma fase concluída. | `/gsd-secure-phase` |
| `session-report.md` | Relatório de sessão — uso de tokens, resumo do trabalho, resultados. | `/gsd-pause-work --report` |
| `settings.md` | Configura alternâncias de workflow GSD e perfil de modelo. | `/gsd-settings`, `/gsd-config --profile` |
| `settings-advanced.md` | Configura parâmetros avançados do GSD — bouncing de plano, timeouts, templates de branch, execução entre IAs, parâmetros de runtime. | `/gsd-config --advanced` |
| `settings-integrations.md` | Configura chaves de API de terceiros (Brave/Firecrawl/Exa), roteamento de CLI `review.models.<cli>` e injeção de `agent_skills.<agent-type>` com exibição mascarada (`****<last-4>`). | `/gsd-config --integrations` |
| `ship.md` | Cria PR, executa revisão e prepara para merge após verificação. | `/gsd-ship` |
| `sketch.md` | Explora direções de design por meio de mockups HTML descartáveis com 2–3 variantes por sketch. | `/gsd-sketch` |
| `sketch-wrap-up.md` | Curadoria das descobertas do sketch e empacotamento como uma habilidade persistente `sketch-findings-[project]`. | `/gsd-sketch --wrap-up` |
| `spec-phase.md` | Refinamento socrático de especificação com pontuação de ambiguidade; produz SPEC.md. | `/gsd-spec-phase` |
| `spike.md` | Validação rápida de viabilidade por meio de experimentos focados e descartáveis. | `/gsd-spike` |
| `spike-wrap-up.md` | Curadoria das descobertas do spike e empacotamento como uma habilidade persistente `spike-findings-[project]`. | `/gsd-spike --wrap-up` |
| `stats.md` | Renderização de estatísticas do projeto — fases, planos, requisitos, métricas git. | `/gsd-stats` |
| `sync-skills.md` | Sincronização de habilidades GSD entre runtimes — diff e aplicação de diretórios de habilidades `gsd-*` entre raízes de runtime. | `/gsd-update --sync` |
| `transition.md` | Workflow de transição de limite de fase — verificações de workstream, avanço de estado. | `execute-phase.md`, `/gsd-progress --next` |
| `ui-phase.md` | Gera contrato de design UI-SPEC.md via gsd-ui-researcher. | `/gsd-ui-phase` |
| `ui-review.md` | Auditoria visual retroativa de 6 pilares via gsd-ui-auditor. | `/gsd-ui-review` |
| `ultraplan-phase.md` | [BETA] Delega o planejamento ao ultraplan cloud do Claude Code; rascunhos remotamente e importa de volta via `/gsd-import`. | `/gsd-ultraplan-phase` |
| `undo.md` | Reversão git segura — commits de fase ou plano usando o manifesto da fase. | `/gsd-undo` |
| `thread.md` | Cria, lista, fecha ou retoma threads de contexto persistentes para trabalho entre sessões. | `/gsd-thread` |
| `update.md` | Atualiza o GSD para a versão mais recente com exibição do changelog. | `/gsd-update` |
| `validate-phase.md` | Audita retroativamente e preenche lacunas de validação Nyquist para uma fase concluída. | `/gsd-validate-phase` |
| `verify-phase.md` | Verifica o alcance dos objetivos da fase por meio de análise retroativa a partir dos objetivos. | `execute-phase.md` (pós-execução) |
| `verify-work.md` | UAT conversacional com autodiagnóstico — produz UAT.md e planos de correção. | `/gsd-verify-work` |

> **Nota:** Alguns workflows não têm comando direto voltado ao usuário (p. ex. `execute-plan.md`, `verify-phase.md`, `transition.md`, `node-repair.md`, `diagnose-issues.md`) — eles são invocados internamente por workflows orquestradores. `discovery-phase.md` é uma entrada alternativa para `/gsd-new-project`.

---

## Referências (62 entregues)

Registro completo em `gsd-core/references/*.md`. Referências são documentos de conhecimento compartilhado que workflows e agentes `@-reference`. Os agrupamentos abaixo correspondem a [`docs/ARCHITECTURE.md`](ARCHITECTURE.md#references-gsd-corereferencesmd) — clusters principais, de workflow, de modelo de raciocínio e a decomposição modular do planejador.

### Referências Principais

| Referência | Função |
|------------|--------|
| `checkpoints.md` | Definições de tipos de checkpoint e padrões de interação. |
| `gates.md` | 4 tipos canônicos de portão (Confirm, Quality, Safety, Transition) conectados ao plan-checker e verifier. |
| `model-profiles.md` | Atribuições de nível de modelo por agente. |
| `model-profile-resolution.md` | Documentação do algoritmo de resolução de modelo. |
| `verification-patterns.md` | Como verificar diferentes tipos de artefato. |
| `verification-overrides.md` | Regras de substituição de verificação por artefato. |
| `planning-config.md` | Esquema completo de configuração e comportamento. |
| `git-integration.md` | Padrões de commit git, ramificação e histórico. |
| `git-planning-commit.md` | Convenções de commit do diretório de planejamento. |
| `questioning.md` | Filosofia de extração de sonhos para a inicialização do projeto. |
| `tdd.md` | Padrões de integração de desenvolvimento orientado a testes. |
| `ui-brand.md` | Padrões de formatação de saída visual. |
| `common-bug-patterns.md` | Padrões comuns de bugs para revisão de código e verificação. |
| `debugger-philosophy.md` | Disciplinas de depuração perenes carregadas pelo `gsd-debugger`. |
| `mandatory-initial-read.md` | Boilerplate de leitura obrigatória compartilhado injetado nos prompts de agentes. |
| `project-skills-discovery.md` | Boilerplate de descoberta de habilidades do projeto injetado nos prompts de agentes. |

### Referências de Workflow

| Referência | Função |
|------------|--------|
| `agent-contracts.md` | Interface formal entre orquestradores e agentes. |
| `context-budget.md` | Regras de alocação do orçamento da janela de contexto. |
| `continuation-format.md` | Formato de continuação/retomada de sessão. |
| `domain-probes.md` | Perguntas de sondagem específicas de domínio para a discuss-phase. |
| `gate-prompts.md` | Templates de prompt de portão/checkpoint. |
| `scout-codebase.md` | Tabela de seleção de tipo de fase → mapa de base de código para a etapa de scout da discuss-phase (extraída via a divisão progressiva discuss-phase/modes, #717). |
| `revision-loop.md` | Padrões de iteração de revisão de plano. |
| `universal-anti-patterns.md` | Antipadrões universais a detectar e evitar. |
| `worktree-path-safety.md` | Suite de guarda do worktree: asserção de HEAD, sentinela de drift de cwd (etapa 0a, #3097) e guarda de caminho absoluto (etapa 0b, #3099) — carregados nos prompts de spawn do executor via `<execution_context>`. |
| `artifact-types.md` | Definições de tipos de artefato de planejamento. |
| `phase-argument-parsing.md` | Convenções de análise de argumentos de fase. |
| `decimal-phase-calculation.md` | Regras de numeração de subfases decimais. |
| `workstream-flag.md` | Convenções de ponteiro ativo de workstream (`--ws`). |
| `user-profiling.md` | Heurísticas de detecção de perfil comportamental do usuário. |
| `thinking-partner.md` | Ativação condicional do parceiro de raciocínio em pontos de decisão. |
| `autonomous-smart-discuss.md` | Lógica de smart-discuss para o modo autônomo. |
| `ios-scaffold.md` | Padrões de scaffolding de aplicativo iOS. |
| `ai-evals.md` | Referência de design de avaliação de IA para `/gsd-ai-integration-phase`. |
| `ai-frameworks.md` | Referência da matriz de decisão de frameworks de IA para `gsd-framework-selector`. |
| `executor-examples.md` | Exemplos resolvidos para o agente gsd-executor. |
| `doc-conflict-engine.md` | Contrato compartilhado de detecção de conflitos para workflows de ingest/import. |
| `execute-mvp-tdd.md` | Semântica de portão de runtime para execute-phase em MVP+TDD — verificação de teste com falha pré-tarefa, revisão bloqueante no final da fase. |
| `mvp-concepts.md` | Índice de referência cruzada dos seis arquivos de referência relacionados a MVP; mapeia cada arquivo para sua finalidade e qual workflow o carrega. |
| `verify-mvp-mode.md` | Regras de enquadramento de UAT para fases em modo MVP — ordenação com fluxo de usuário primeiro, verificações técnicas adiadas, guarda de formato de história de usuário. |

### Referências de Sketch

Referências consumidas pelo workflow `/gsd-sketch` e seu companion de wrap-up.

| Referência | Função |
|------------|--------|
| `sketch-interactivity.md` | Regras para tornar os sketches HTML interativos e vivos. |
| `sketch-theme-system.md` | Sistema de variáveis de tema CSS compartilhado para consistência entre sketches. |
| `sketch-tooling.md` | Utilitários de barra de ferramentas flutuante incluídos em todo sketch. |
| `sketch-variant-patterns.md` | Padrões HTML de múltiplas variantes (abas, lado a lado, sobreposições). |

### Referências de Modelo de Raciocínio

Referências para integrar modelos de classe de raciocínio (o3, o4-mini, Gemini 2.5 Pro) em workflows GSD.

| Referência | Função |
|------------|--------|
| `thinking-models-debug.md` | Padrões de modelo de raciocínio para workflows de debug. |
| `thinking-models-execution.md` | Padrões de modelo de raciocínio para agentes de execução. |
| `thinking-models-planning.md` | Padrões de modelo de raciocínio para agentes de planejamento. |
| `thinking-models-research.md` | Padrões de modelo de raciocínio para agentes de pesquisa. |
| `thinking-models-verification.md` | Padrões de modelo de raciocínio para agentes de verificação. |

### Decomposição Modular do Planejador

O agente `gsd-planner` é decomposto em um agente principal mais módulos de referência para caber nos limites de caracteres do runtime.

| Referência | Função |
|------------|--------|
| `planner-antipatterns.md` | Antipadrões do planejador e exemplos de especificidade. |
| `planner-chunked.md` | Formatos de retorno do modo chunked (`## OUTLINE COMPLETE`, `## PLAN COMPLETE`) para mitigação do travamento de stdio no Windows. |
| `planner-gap-closure.md` | Comportamento do modo de fechamento de lacuna (lê VERIFICATION.md, replanejamento direcionado). |
| `planner-reviews.md` | Integração de revisão entre IAs (lê REVIEWS.md do `/gsd-review`). |
| `planner-revision.md` | Padrões de revisão de plano para refinamento iterativo. |
| `planner-source-audit.md` | Regras de auditoria de fonte e limite de autoridade do planejador. |
| `planner-mvp-mode.md` | Regras de planejamento em fatia vertical para o modo MVP. |
| `planner-human-verify-mode.md` | Regras para `workflow.human_verify_mode = end-of-phase`: suprime a emissão de tarefas `checkpoint:human-verify` e roteia itens adiados via `<verify><human-check>`. |
| `planner-graphify-auto-update.md` | Como `load_graph_context` levanta o estado de atualização automática de `.last-build-status.json` (running / failed / stale head) junto com a anotação de desatualização existente. Opt-in via `graphify.auto_update` (#3347). |
| `planner-interface-context.md` | Regras de contexto de interface para executores — como extrair interfaces/tipos/exportações chave do código existente e documentar novas interfaces que planos subsequentes consumirão. |
| `skeleton-template.md` | Template do SKELETON.md emitido para o Walking Skeleton de novo projeto (Fase 1 + `--mvp`). |
| `user-story-template.md` | Formato de história de usuário para planejamento MVP — campos estruturados "Como / Quero / Para que". |
| `spidr-splitting.md` | Regras de decomposição de divisão SPIDR para lidar com histórias de usuário grandes no modo MVP. |

> **Subdiretório:** `gsd-core/references/few-shot-examples/` contém exemplos adicionais de few-shot (`plan-checker.md`, `verifier.md`) que são referenciados por agentes específicos. Estes não são contados nas 62 referências de nível superior.

---

## Módulos de CLI (81 entregues)

Listagem completa: `gsd-core/bin/lib/*.cjs`.

| Módulo | Responsabilidade |
|--------|-----------------|
| `active-workstream-store.cjs` | Precedência de fonte e seleção de workstream (CLI `--ws` > env `GSD_WORKSTREAM` > ponteiro armazenado); validação de nome e propagação de ambiente |
| `adr-parser.cjs` | Analisador de decisão ADR para o caminho expresso de ingestão da plan-phase; normaliza sinônimos de seção, analisa cercas de status/decisão/escopo e aplica portões de rejeição de status |
| `agent-command-router.cjs` | Adaptador de roteador de subcomando CJS fino para `gsd-tools agent` |
| `artifacts.cjs` | Registro canônico de artefatos — nomes de arquivos raiz conhecidos de `.planning/`; usado pelo lint W019 do `gsd-health` |
| `audit.cjs` | Despacho de auditoria, sessões abertas de auditoria, auxiliares de armazenamento de auditoria |
| `check-command-router.cjs` | Adaptador de roteador de subcomando CJS fino para `gsd-tools check` |
| `cjs-command-router-adapter.cjs` | Adaptador de compatibilidade compartilhado para roteadores de família de comandos CJS com suporte de manifesto |
| `clock.cjs` | Costura de relógio injetável (now/sleep) para teste determinístico de bloqueio |
| `clusters.cjs` | Definições de cluster de habilidades para o módulo de superfície de runtime (ADR-0011 Fase 2) |
| `code-review-flags.cjs` | Analisador de flags tipado para `/gsd:code-review`; exporta `parseCodeReviewFlags(argv)` (→ `{ fix, all, auto, depth, files }`) e `resolveCodeReviewWorkflow(flags)` (→ `'code-review.md' \| 'code-review-fix.md'`); costura de despacho canônica para roteamento de `--fix`/`--all`/`--auto` |
| `command-aliases.cjs` | Metadados de alias/subcomando para roteadores de família com suporte de manifesto |
| `command-arg-projection.cjs` | Auxiliares de projeção de flag tipada e argumento posicional compartilhados entre roteadores de família de comandos |
| `command-routing-hub.cjs` | Hub de despacho de resultado puro que centraliza a decisão de modo (SDK vs CJS), taxonomia de erros e contrato sem lançamento para todos os roteadores de família de comandos (#3788) |
| `commands.cjs` | Comandos CLI diversos (slug, timestamp, todos, scaffolding, stats) |
| `config-schema.cjs` | Fonte única de verdade para `VALID_CONFIG_KEYS` e padrões de chave dinâmica; importado tanto pelo validador quanto pelo teste de paridade config-schema-docs |
| `config.cjs` | Leitura/escrita de `config.json`, inicialização de seção; importa validador de `config-schema.cjs` |
| `config-types.cjs` | Definições de tipo TypeScript para o bloco de configuração `model_policy` — `ModelPolicyConfig`, `TierEntry`, `RuntimeTiers`; compilado de `src/config-types.cts` no momento da publicação (ADR-457) |
| `configuration.cjs` | Módulo de Configuração — carregamento canônico de configuração, normalização de chave legada, merge de padrões e migração explícita em disco; fonte de verdade para consumidores SDK e CJS |
| `context-utilization.cjs` | Classificador puro para `gsd-health --context` — converte (tokensUsed, contextWindow) em um resultado de triagem `{ percent, state }` contra os limiares de ponto de fratura de 60%/70% (#2792) |
| `core.cjs` | Tratamento de erros, formatação de saída, utilitários compartilhados, fallbacks de runtime; re-exportações de compatibilidade para auxiliares de planning-workspace |
| `decisions.cjs` | Analisa blocos `<decisions>` do CONTEXT.md; aceita IDs numéricos (D-42) e alfanuméricos (D-INFRA-01); retorna `{id, text, category, tags, trackable}` |
| `docs.cjs` | Inicialização do workflow docs-update, varredura de Markdown, detecção de monorepo |
| `drift.cjs` | Detector de drift estrutural pós-execução da base de código (#2003): classifica alterações de arquivo em categorias new-dir/barrel/migration/route e faz round-trip do frontmatter `last_mapped_commit` |
| `fallow-runner.cjs` | Adaptador de auditoria fallow para `/gsd-code-review`: resolução binária (`PATH` depois `node_modules/.bin`), erros acionáveis de binário ausente e normalização de descobertas estruturais |
| `frontmatter.cjs` | Operações CRUD de frontmatter YAML |
| `gap-checker.cjs` | Análise de lacunas pós-planejamento (#2493): relatório unificado de cobertura de decisões do REQUIREMENTS.md + CONTEXT.md vs PLAN.md (`gsd-tools gap-analysis`) |
| `graphify.cjs` | Build/consulta/status/diff do grafo de conhecimento para `/gsd-graphify` |
| `gsd2-import.cjs` | Ingestão de plano externo para `/gsd-import --from-gsd2` |
| `init-command-router.cjs` | Adaptador de roteador de subcomando CJS fino para `gsd-tools init` |
| `init.cjs` | Carregamento de contexto composto para cada tipo de workflow |
| `install-profiles.cjs` | Lista de permissões de perfil de instalação + staging de habilidades para instalação `--minimal` (#2762); fonte única de verdade para quais habilidades/agentes `gsd-*` ficam nos diretórios de configuração de runtime |
| `installer-migration-authoring.cjs` | Barreiras de autoria de migração do instalador para metadados de registro, escopos explícitos, evidência de propriedade e citações de contrato de runtime |
| `installer-migration-report.cjs` | Projeção de relatório de migração do instalador e guarda de ação bloqueada para integração de instalação/atualização |
| `installer-migrations.cjs` | Planejamento de migração do instalador, classificação de artefatos, persistência do estado de instalação, aplicação com journal e auxiliares de rollback |
| `intel.cjs` | Armazenamento de intel da base de código suportando `/gsd-map-codebase --query` e `gsd-intel-updater` |
| `learnings.cjs` | Extração de aprendizados entre fases para `/gsd-extract-learnings` |
| `milestone.cjs` | Arquivamento de milestone, marcação de requisitos |
| `model-catalog.cjs` | Adaptador CJS sobre o JSON do catálogo de modelos compartilhado; exporta padrões canônicos de nível de runtime, mapas de perfil de agente, mapas de alias e metadados de roteamento para todos os consumidores de CLI |
| `model-profiles.cjs` | Auxiliares de perfil compatíveis com versões anteriores derivados de `model-catalog.cjs`; não possui mais sua própria tabela de modelos |
| `package-identity.cjs` | Fonte única gerada para as coordenadas do pacote publicado do GSD (nome npm, nome bin, slug do repositório, URL do changelog, comando de instalação manual), derivado do package.json; lido pelo worker de atualização, `check-latest-version` e instalador (#498) |
| `phase-command-router.cjs` | Adaptador de roteador de subcomando CJS fino para `gsd-tools phase` |
| `phase-lifecycle.cjs` | Auxiliares de ciclo de vida de fase de computação pura extraídos do handler SDK de ciclo de vida de fase |
| `phase.cjs` | Operações de diretório de fase, numeração decimal, indexação de planos |
| `phases-command-router.cjs` | Adaptador de roteador de subcomando CJS fino para `gsd-tools phases` |
| `plan-scan.cjs` | Scanner canônico de plano de fase para detectar arquivos de plano e resumo em layouts planos e aninhados (k014) |
| `planning-workspace.cjs` | Costura de caminho/workstream de planejamento (`planningDir`, `planningPaths`, roteamento de workstream ativo, orquestração de `.planning/.lock`) |
| `project-root.cjs` | Resolve uma raiz de projeto a partir de um diretório inicial usando quatro heurísticas (guarda de `.planning/` próprio, config `sub_repos`, flag `multiRepo`, heurística `.git`) |
| `profile-output.cjs` | Renderização de perfil, geração de USER-PROFILE.md e dev-preferences.md |
| `profile-pipeline.cjs` | Pipeline de dados de perfil comportamental do usuário, varredura de arquivos de sessão |
| `prompt-budget.cjs` | Contabilidade pura de orçamento de tokens para prompts de revisão — estima tokens, aplica prioridade de corte determinística (redução de cabeça PROJECT.md, truncamento proporcional de plano, descarte de contexto/pesquisa/requisitos, guarda de falha rígida), retorna metadados estruturados para `review.max_prompt_tokens` (#3081) |
| `review-reviewer-selection.cjs` | Auxiliares de seleção/normalização de revisor para política de revisor padrão e precedência do `/gsd-review` |
| `roadmap-command-router.cjs` | Adaptador de roteador de subcomando CJS fino para `gsd-tools roadmap` |
| `roadmap-upgrade.cjs` | Ferramenta de migração para converter entradas legadas `Phase N` para a convenção prefixada de milestone `Phase M-NN`; `computeMigrationPlan` + `applyMigration` com padrão dry-run e rollback atômico |
| `roadmap.cjs` | Análise de ROADMAP.md, extração de fases, progresso de plano |
| `runtime-artifact-layout.cjs` | Módulo de layout de artefatos de runtime — resolve as formas do diretório de artefatos (comandos, agentes, habilidades) para cada runtime suportado; fonte única de verdade para posicionamento de artefatos por runtime (#3663) |
| `runtime-name-policy.cjs` | Política de normalização de nome de runtime — sanitização canônica de token para identificadores de runtime usados na construção de caminhos e exibição |
| `runtime-homes.cjs` | Mapeamento canônico de runtime → diretório de configuração/habilidades global; suporte de primeira classe para todos os 15 runtimes incluindo layout aninhado Hermes e exclusão baseada em regras Cline (#3126) |
| `runtime-slash.cjs` | Formatador de comando slash com reconhecimento de runtime — fonte única de verdade para emitir `/gsd-<cmd>` (runtimes baseados em habilidades) e `$gsd-<cmd>` (codex) em saída voltada ao usuário e artefatos persistidos (#3584) |
| `schema-detect.cjs` | Detecção de drift de esquema para padrões ORM (Prisma, Drizzle, Supabase, TypeORM, Payload); exporta `detectSchemaFiles`, `detectSchemaOrm`, `checkSchemaDrift`, `SCHEMA_PATTERNS`, `ORM_INFO` |
| `secrets.cjs` | Convenção de mascaramento de configuração de segredo (`****<last-4>`) para chaves de integração; exporta `SECRET_CONFIG_KEYS`, `isSecretKey`, `maskSecret`, `maskIfSecret` |
| `semver-compare.cjs` | Auxiliares de política de comparação semver compartilhados (`compareSemverCore`, validação de tripla estável, análise de tupla normalizada) consumidos por hooks de verificação de atualização, detecção de instalação dev da linha de status e lógica de intervalo de extração de changeset (#10) |
| `security.cjs` | Prevenção de path traversal, detecção de injeção de prompt, auxiliares JSON/shell seguros |
| `shell-command-projection.cjs` | Projeção de comando shell com reconhecimento de runtime para serialização de hook gerenciado: decide o uso do operador de chamada PowerShell por runtime/plataforma e normaliza tokens de caminho de script Windows |
| `state-command-router.cjs` | Adaptador de roteador de subcomando CJS fino para `gsd-tools state` |
| `state.cjs` | Análise, atualização, progressão e métricas do STATE.md |
| `state-document.cjs` | Extração de campo, substituição, normalização de status e transformações de cálculo de progresso puras do STATE.md |
| `surface.cjs` | Módulo de superfície de runtime — gerencia o estado de superfície de habilitação/desabilitação do runtime independentemente do marcador de perfil no momento da instalação (ADR-0011 Fase 2) |
| `task-command-router.cjs` | Adaptador de roteador de subcomando CJS fino para `gsd-tools task` |
| `template.cjs` | Seleção e preenchimento de template com substituição de variáveis |
| `uat.cjs` | Análise de arquivo UAT, rastreamento de dívida de verificação, suporte audit-uat |
| `ui-safety-gate.cjs` | Detector de token de UI de limite de palavra sem shell (#3706, #3718); lê texto de seção de fase do stdin, sai com 0 (UI encontrada) ou 1 (sem UI); também implantado em `gsd-core/bin/lib/` para que o instalador GSD o entregue em `$RUNTIME_DIR` (#448) |
| `update-context.cjs` | Resolvedor de contexto de instalação puro para `/gsd:update` — detecção de runtime/escopo/config-dir/versão (LOCAL/GLOBAL/UNKNOWN) portada do bash de update.md; sustenta `gsd-tools update-context` (#498) |
| `validate-command-router.cjs` | Adaptador de roteador de subcomando CJS fino para `gsd-tools validate` |
| `validate.cjs` | Auxiliares de normalização de variante de fase puros (`phaseVariants`, `buildRoadmapPhaseVariants`, `buildNotStartedPhaseVariants`) usados por `verify.cjs` para verificações W006/W007; sem I/O, sem async |
| `verify-command-router.cjs` | Adaptador de roteador de subcomando CJS fino para `gsd-tools verify` |
| `verify.cjs` | Estrutura de plano, completude de fase, referência, validação de commit |
| `workstream-inventory-builder.cjs` | Construtor de projeção de inventário de workstream puro |
| `workstream-inventory.cjs` | Projeção de inventário de workstream compartilhada: campos de estado, contagens de fase/plano/resumo, contagem de fase do roadmap e marcador ativo — orquestrador fino que delega projeção pura para `workstream-inventory-builder.cjs` |
| `workstream-name-policy.cjs` | Validação canônica de nome de workstream (`isValidActiveWorkstreamName`, `hasInvalidPathSegment`, `validateWorkstreamName`) e normalização de slug (`toWorkstreamSlug`) |
| `workstream.cjs` | CRUD de workstream, migração, ponteiro ativo com escopo de sessão |
| `worktree-safety.cjs` | Resolução de raiz de worktree e decisões de política de poda não destrutiva; possui a lógica de verificação de integridade W017 |

[`docs/CLI-TOOLS.md`](CLI-TOOLS.md) pode descrever um subconjunto desses módulos; quando discordar do sistema de arquivos, esta tabela e a listagem de diretório são autoritativas.

---

## Hooks (14 entregues)

Listagem completa: `hooks/`.

| Hook | Evento | Finalidade |
|------|--------|-----------|
| `gsd-statusline.js` | `statusLine` | Exibe modelo, tarefa, diretório, uso de contexto |
| `gsd-context-monitor.js` | `PostToolUse` / `AfterTool` | Injeta avisos de contexto voltados ao agente a 35%/25% de contexto restante |
| `gsd-check-update.js` | `SessionStart` | Verificação em segundo plano de novas versões do GSD |
| `gsd-check-update-worker.js` | (worker) | Auxiliar de worker em segundo plano para check-update |
| `gsd-update-banner.js` | `SessionStart` | Banner opt-in que levanta a disponibilidade de atualização quando a statusline GSD não é usada (PR #2795) |
| `gsd-prompt-guard.js` | `PreToolUse` | Varre escritas em `.planning/` em busca de padrões de injeção de prompt (consultivo) |
| `gsd-workflow-guard.js` | `PreToolUse` | Detecta edições de arquivo fora do contexto de workflow GSD (consultivo, opt-in) |
| `gsd-read-guard.js` | `PreToolUse` | Guarda consultiva que impede Edit/Write em arquivos não lidos |
| `gsd-read-injection-scanner.js` | `PostToolUse` | Varre resultados de Read de ferramenta em busca de padrões de injeção de prompt (v1.36+, PR #2201) |
| `gsd-worktree-path-guard.js` | `PreToolUse` | Bloqueia rigorosamente Edit/Write/MultiEdit com caminhos absolutos fora da raiz do worktree (PR #579, #260) |
| `gsd-write-guard.js` | `PreToolUse` | Bloqueia rigorosamente um `Write` de arquivo inteiro que encolhe catastroficamente um artefato curado de `.planning/` (ROADMAP.md, roadmaps de milestone, STATE.md); override via o sentinela de uso único `.planning/.gsd-allow-shrink` (passos de workflow) ou `GSD_ALLOW_PLANNING_SHRINK=1` (interativo) (#2255, correção 3 de #973) |
| `gsd-session-state.sh` | `PostToolUse` | Rastreamento de estado de sessão para runtimes baseados em shell |
| `gsd-validate-commit.sh` | `PostToolUse` | Validação de commit para aplicação de conventional-commit |
| `gsd-phase-boundary.sh` | `PostToolUse` | Detecção de limite de fase para transições de workflow |
| `gsd-graphify-update.sh` | `PostToolUse` | Reconstrução automática do grafo de conhecimento após o avanço do HEAD principal (opt-in, padrão desativado — #3347) |

---

## Manutenção

- Quando um novo comando, agente, workflow, referência, módulo de CLI ou hook for entregue, atualize a seção correspondente aqui antes que a versão seja liberada.
- Os testes de guarda de drift em `tests/` (veja "Como Usar Este Arquivo" acima) asseguram que todo arquivo entregue está enumerado neste inventário. Um novo arquivo sem uma linha correspondente aqui falhará no CI.
- Quando o sistema de arquivos divergir das contagens de `docs/ARCHITECTURE.md` ou de documentações de subconjunto curado (p. ex. o registro primário do `docs/AGENTS.md`), este arquivo é a fonte de verdade.

## Relacionados

- [Comandos](COMMANDS.md) — referência de comandos voltados ao usuário
- [Arquitetura](ARCHITECTURE.md) — como as superfícies se encaixam
- [índice de documentação](README.md)
